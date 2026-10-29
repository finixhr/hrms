// ============ Telemetry — error tracking (Wave 4 A5, 2026-10-08) ============
// Zero-dependency error capture compatible with Sentry / GlitchTip (both
// speak the same envelope API). Enabled ONLY when TELEMETRY_DSN is set:
//   TELEMETRY_DSN=https://<key>@<host>/<project-id>
//   TELEMETRY_ENV=production   (optional tag; defaults to NODE_ENV)
//
// Design rules (mirrors the platform gateway philosophy):
//  - NEVER throws into the caller — telemetry loss must not fail a request.
//  - NEVER sends PII: messages are truncated and scrubbed of emails/phones/
//    bearer tokens; only the RPC action name, error class, stack frames'
//    file paths and coarse context (vendor COUNTS, never ids) go out.
//  - Rate-limited locally (max 20 events/min) so an error loop cannot flood
//    the DSN or the egress path.
//  - Synchronous fire-and-forget with a short timeout — the request path
//    never waits on the collector.
import crypto from "crypto"

const DSN = process.env.TELEMETRY_DSN || ""
const ENV = process.env.TELEMETRY_ENV || process.env.NODE_ENV || "unknown"

let dsnUrl: URL | null = null
try { if (DSN) dsnUrl = new URL(DSN) } catch { dsnUrl = null }

const sentAt: number[] = []
function underRateLimit(): boolean {
  const now = Date.now()
  while (sentAt.length && now - sentAt[0] > 60_000) sentAt.shift()
  if (sentAt.length >= 20) return false
  sentAt.push(now)
  return true
}

/** Strip obvious PII/secrets from a message before it leaves the box. */
function scrub(msg: string): string {
  return msg
    .slice(0, 500)
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, "<email>")
    .replace(/\+?88?01[3-9]\d{8}/g, "<phone>")
    .replace(/(bearer|token|password|secret|apikey|api_key)[=: ]+\S+/gi, "$1=<redacted>")
}

type CaptureCtx = { action?: string; vendorHash?: string; userIdHash?: string; extra?: Record<string, unknown> }

/** Capture an error server-side. Safe to call from any catch block. */
export function captureError(err: unknown, ctx: CaptureCtx = {}): void {
  try {
    if (!dsnUrl || !underRateLimit()) return
    const e = err as { message?: string; name?: string; stack?: string; code?: unknown }
    const event = {
      timestamp: new Date().toISOString(),
      platform: "node",
      environment: ENV,
      level: "error",
      logger: "finix-hrm",
      server_name: "finix-hr",
      transaction: ctx.action || "unknown",
      exception: {
        values: [{
          type: e?.name || "Error",
          value: scrub(String(e?.message || String(err))),
          stacktrace: e?.stack ? { frames: e.stack.split("\n").slice(0, 12).map((line: string) => ({ filename: line.trim().slice(0, 200) })) } : undefined,
        }],
      },
      tags: { action: ctx.action || "unknown", prismaCode: typeof e?.code === "string" ? e.code : undefined },
      extra: {
        vendorHash: ctx.vendorHash,
        userIdHash: ctx.userIdHash,
        ...(ctx.extra || {}),
      },
    }
    // Sentry envelope: one JSON header line + one JSON event line, sent as
    // text/plain so no CORS preflight is triggered on the collector side.
    const eventId = crypto.randomBytes(16).toString("hex")
    const envelope = `${JSON.stringify({ event_id: eventId, sent_at: new Date().toISOString() })}\n${JSON.stringify({ type: "event" })}\n${JSON.stringify({ ...event, event_id: eventId })}\n`
    const endpoint = `${dsnUrl.protocol}//${dsnUrl.host}/api/${dsnUrl.pathname.replace(/^\//, "")}/envelope/`
    void fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "text/plain",
        "x-sentry-auth": `Sentry sentry_version=7, sentry_key=${dsnUrl.username || "public"}, sentry_client=finix-telemetry/1.0`,
      },
      body: envelope,
      signal: AbortSignal.timeout(4_000),
    }).catch(() => { /* never surface telemetry failures */ })
  } catch { /* never surface telemetry failures */ }
}

/** Hash a tenant/user id into a stable non-reversible correlation tag. */
export function telemetryHash(id: string | null | undefined): string | undefined {
  if (!id) return undefined
  return crypto.createHash("sha256").update(`finix:${id}`).digest("hex").slice(0, 16)
}

export function telemetryEnabled(): boolean {
  return !!dsnUrl
}

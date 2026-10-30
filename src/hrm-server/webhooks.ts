// ============ Outbound tenant webhooks (Wave 4 WP-C / SG-E, 2026-10-08) ============
// webhookEmit(vendorId, event, payload) records a pending delivery for every
// ACTIVE endpoint of the vendor subscribed to the event; flushWebhookDeliveries
// () (called from the jobs tick every 60s) POSTs them with an HMAC-SHA256
// signature header and exponential backoff. Emit NEVER throws into the caller
// — failures are delivery-log rows, not user-facing errors.
//
// Secrets discipline: the per-endpoint signing secret is encrypted at rest
// via crypto-field (context "webhooks::v1"); the RAW secret is shown exactly
// once, at endpoint creation (integrations.webhooks.save).
//
// URL safety: the SSRF guard re-runs with DNS RESOLUTION before EVERY send
// (SEC-6, Phase 3 WS-E) — https-only, no private hosts (by literal OR by
// resolved address), no embedded credentials, no redirect-following — because
// a saved URL may have been validated under older rules, and DNS can repoint
// a public host at an internal address after the save-time check passed.
import crypto from "crypto"
import { db } from "@/lib/db"
import { rateLimit, resolveOutboundUrl } from "./security"
import { decryptField } from "./crypto-field"

const SECRET_CONTEXT = "webhooks::v1"

/** Backoff ladder after each failed attempt (attempts 1..4 schedule the next
 *  try; attempt 5 gives up and marks the delivery FAILED). */
const BACKOFF_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 3_600_000, 6 * 3_600_000]
const MAX_ATTEMPTS = 5
/** Per flush pass cap — the jobs tick calls every 60s, so this is a steady
 *  drain, never a thundering herd. OPS-5 (Phase 3 WS-E): the pass now drains
 *  up to FLUSH_BATCH_CAP deliveries through a CONCURRENT worker pool (was 20
 *  strictly sequential sends per minute ≈ 28.8K/day — an unbounded backlog at
 *  100K tenants). Per-endpoint politeness is unchanged. */
const FLUSH_BATCH_CAP = 60
/** Concurrent send workers in the pool (per flush pass). */
const SEND_CONCURRENCY = 8
const SEND_TIMEOUT_MS = 10_000
/** Politeness cap on send attempts per endpoint per minute (rate-limit the
 *  webhook send path). An over-limit endpoint's due deliveries are deferred
 *  to the next flush pass — never failed, never attempt-counted. */
const SENDS_PER_ENDPOINT_PER_MIN = 30
const RESPONSE_BODY_CAP = 300
/** OPS-5 (Phase 3 WS-E) — backlog age limit: a PENDING delivery older than
 *  this many days is dead-lettered (FAILED with an explanatory note) by the
 *  daily sweep, so the queue cannot grow without bound when an endpoint is
 *  permanently unreachable. Attempts already cap at 5; this covers the
 *  deferred-by-politeness tail. */
const BACKLOG_MAX_AGE_DAYS = Math.max(1, Math.floor(Number(process.env.HRM_WEBHOOK_BACKLOG_DAYS) || 7))

function parseEvents(eventsJson: string): string[] {
  try {
    const v = JSON.parse(eventsJson || "[]")
    return Array.isArray(v) ? v.map(String) : []
  } catch {
    return []
  }
}

/** Record pending deliveries for every subscribed endpoint. Fire-and-forget
 *  safe: wrap in try/catch at the call site is unnecessary but harmless. */
export async function webhookEmit(vendorId: string, event: string, payload: Record<string, unknown>): Promise<void> {
  try {
    const endpoints = await db.webhookEndpoint.findMany({
      where: { vendorId, active: true },
      select: { id: true, eventsJson: true },
    })
    const targets = endpoints.filter((e) => parseEvents(e.eventsJson).includes(event))
    if (!targets.length) return
    const payloadJson = JSON.stringify({ event, createdAt: new Date().toISOString(), data: payload })
    for (const t of targets) {
      // per-endpoint isolation: one bad insert never blocks the other endpoints
      try {
        await db.webhookDelivery.create({ data: { vendorId, endpointId: t.id, event, payloadJson } })
      } catch (e) {
        console.error(`[webhooks] delivery row create failed (endpoint ${t.id})`, e)
      }
    }
  } catch (e) {
    console.error("[webhooks] emit failed", e)
  }
}

// ---------- single-delivery execution (shared by flush + test ping) ----------

export type DeliveryAttempt = {
  /** false when the send was deferred (endpoint send-rate limit) — the
   *  delivery row stays PENDING and untouched for the next pass. */
  attempted: boolean
  ok: boolean
  status: number | null
  detail: string
}

/** Minimal delivery-row shape (Prisma rows satisfy it structurally). */
type DeliveryRow = {
  id: string
  endpointId: string
  event: string
  payloadJson: string
  attempts: number
}

/** POST one signed webhook body.
 *
 *  SEC-6 (Phase 3 WS-E) — the SSRF guard now (1) RESOLVES the hostname at send
 *  time and rejects when any resolved address is private (DNS rebinding to
 *  169.254.169.254 / 10.x / ::1 is blocked), and (2) sends with
 *  redirect: "manual" — a 3xx is treated as a failure, never followed, so an
 *  attacker-controlled endpoint cannot bounce the POST onto an internal URL. */
export async function postSigned(
  url: string,
  secret: string | null,
  event: string,
  deliveryId: string,
  body: string,
): Promise<{ ok: boolean; status: number | null; body: string; error: string | null }> {
  const check = await resolveOutboundUrl(url)
  if (!check.ok) return { ok: false, status: null, body: "", error: `Blocked by SSRF guard: ${check.reason}` }
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-finx-event": event,
    "x-finx-delivery": deliveryId,
  }
  if (secret) {
    headers["x-finx-signature"] = "sha256=" + crypto.createHmac("sha256", secret).update(body, "utf8").digest("hex")
  }
  try {
    const res = await fetch(check.url, {
      method: "POST",
      headers,
      body,
      redirect: "manual", // SEC-6 — never follow redirects to (internal) targets
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    })
    const text = (await res.text().catch(() => "")).slice(0, RESPONSE_BODY_CAP)
    if (res.status >= 300 && res.status < 400) {
      return { ok: false, status: res.status, body: "", error: `Redirect to ${res.headers.get("location") || "?"} refused — webhook endpoints must not redirect` }
    }
    return { ok: res.ok, status: res.status, body: text, error: null }
  } catch (e: any) {
    return { ok: false, status: null, body: "", error: String(e?.message || e).slice(0, 200) }
  }
}

/** Attempt one delivery row NOW and record the outcome (attempts, backoff,
 *  endpoint lastStatus). Shared by the flusher and the interactive test ping
 *  (integrations.webhooks.test) so a manual test exercises the exact same
 *  signing/retry bookkeeping as a real event delivery. */
export async function attemptDelivery(delivery: DeliveryRow): Promise<DeliveryAttempt> {
  const endpoint = await db.webhookEndpoint.findUnique({ where: { id: delivery.endpointId } })
  if (!endpoint) {
    // endpoint deleted after the delivery was queued — fail the row cleanly
    await db.webhookDelivery.update({
      where: { id: delivery.id },
      data: {
        status: "FAILED",
        attempts: delivery.attempts + 1,
        responseBody: "Endpoint deleted — no receiver for this delivery",
      },
    }).catch(() => {})
    return { attempted: true, ok: false, status: null, detail: "Endpoint deleted" }
  }

  // politeness cap — defer (row untouched) when the endpoint is over budget
  if (await rateLimit(`webhook:send:${endpoint.id}`, SENDS_PER_ENDPOINT_PER_MIN, 60_000)) {
    return { attempted: false, ok: false, status: null, detail: "Send rate limit — deferred to the next flush pass" }
  }

  let secret: string | null = null
  if (endpoint.secret) {
    try {
      secret = decryptField(endpoint.secret, SECRET_CONTEXT)
    } catch (e) {
      // undecryptable secret (key rotated / corrupt row) → send unsigned rather
      // than dropping the delivery; the receiver will reject an unsigned body
      // if it enforces signatures, which is the safe failure direction
      console.error(`[webhooks] secret decrypt failed (endpoint ${endpoint.id}) — sending unsigned`, e)
      secret = null
    }
  }

  const result = await postSigned(endpoint.url, secret, delivery.event, delivery.id, delivery.payloadJson)
  const attempts = delivery.attempts + 1
  const failed = !result.ok && attempts >= MAX_ATTEMPTS
  const responseBody = [result.error, result.body].filter(Boolean).join(" — ").slice(0, RESPONSE_BODY_CAP) || null

  if (result.ok) {
    await db.webhookDelivery.update({
      where: { id: delivery.id },
      data: {
        status: "DELIVERED",
        responseStatus: result.status,
        responseBody,
        attempts,
        nextAttemptAt: null,
        deliveredAt: new Date(),
      },
    })
  } else {
    await db.webhookDelivery.update({
      where: { id: delivery.id },
      data: {
        status: failed ? "FAILED" : "PENDING",
        responseStatus: result.status,
        responseBody,
        attempts,
        ...(failed ? {} : { nextAttemptAt: new Date(Date.now() + (BACKOFF_MS[attempts - 1] ?? BACKOFF_MS[BACKOFF_MS.length - 1])) }),
      },
    })
  }
  // lastStatus reflects the endpoint regardless of which delivery it was
  await db.webhookEndpoint.update({
    where: { id: endpoint.id },
    data: { lastStatus: result.ok ? "DELIVERED" : failed ? "FAILED" : "PENDING" },
  }).catch(() => {})
  const detail = result.ok
    ? `HTTP ${result.status}`
    : result.error || `HTTP ${result.status ?? "no response"}`
  return { attempted: true, ok: result.ok, status: result.status, detail }
}

// ---------- flusher (jobs tick) ----------

/** Drain due deliveries: status PENDING with nextAttemptAt null or <= now,
 *  capped at FLUSH_BATCH_CAP per pass, executed through a small CONCURRENT
 *  worker pool (OPS-5 Phase 3 WS-E). Cheap when none are pending. Returns the
 *  number of deliveries that got an actual send attempt this pass. */
export async function flushWebhookDeliveries(): Promise<number> {
  const due = await db.webhookDelivery.findMany({
    where: { status: "PENDING", OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: new Date() } }] },
    orderBy: { createdAt: "asc" },
    take: FLUSH_BATCH_CAP,
  })
  let attempted = 0
  let cursor = 0
  const worker = async () => {
    for (;;) {
      const i = cursor++
      if (i >= due.length) return
      const d = due[i]
      try {
        const r = await attemptDelivery(d)
        if (r.attempted) attempted++
      } catch (e) {
        // the row itself is the record — never let one bad delivery break the tick
        console.error(`[webhooks] delivery attempt failed (delivery ${d.id})`, e)
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(SEND_CONCURRENCY, Math.max(1, due.length)) }, worker))
  return attempted
}

/** OPS-5 (Phase 3 WS-E) — daily dead-letter sweep: PENDING deliveries older
 *  than BACKLOG_MAX_AGE_DAYS are marked FAILED with an explanatory note so
 *  the queue has a hard age ceiling (an endpoint that is permanently politeness-
 *  deferred would otherwise pin its deliveries forever). Called from the
 *  platform daily jobs. Returns the number of dead-lettered rows. */
export async function deadLetterStaleDeliveries(): Promise<number> {
  const cutoff = new Date(Date.now() - BACKLOG_MAX_AGE_DAYS * 86_400_000)
  const res = await db.webhookDelivery.updateMany({
    where: {
      status: "PENDING",
      createdAt: { lt: cutoff },
    },
    data: {
      status: "FAILED",
      responseBody: `Dead-lettered: delivery stayed pending longer than ${BACKLOG_MAX_AGE_DAYS} day(s) (endpoint unreachable or permanently deferred)`,
    },
  })
  return res.count
}

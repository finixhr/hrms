// ============ ADMS endpoint: /iclock/cdata (handshake + event push) ============
// This is the PRIMARY device-facing endpoint. ZKTeco Push SDK firmware
// hard-codes the path /iclock/cdata — the device CANNOT be configured to use
// any other path. So this route MUST live at the server root, NOT under
// /api/integrations/.../ .
//
//   GET  — device handshake ("options" request): registers liveness, returns
//          server-side options the device reads to configure its push cycle.
//   POST — ATTLOG / OPERLOG / USERINFO / BIODATA push: durable raw store →
//          dedup → process → ACK (`OK: <count>`).
//
// This is a PUBLIC device endpoint (device-authenticated, rate-limited) — it is
// deliberately separate from the session-authenticated HRM admin API.
import { NextRequest } from "next/server"
import {
  resolveDevice, snRateLimited, rateLimited, logComm, handshake, ingestLines,
  handshakeOptionsFor, GATEWAY_ENV, bodyCapExceeded, BODY_CAP_CDATA, deviceClientIp } from "@/hrm-server/zkteco/gateway"
import { ackEvents, admsError, parseHandshakeParams } from "@/hrm-server/zkteco/adapter"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

const BASE = "/iclock/cdata"

// SEC-4 (Phase 1) — trust-gated client IP from the shared device-plane helper:
// X-Forwarded-For is only honored behind a configured trusted proxy
// (HRM_TRUST_PROXY=1); the old unconditional read let any direct caller mint
// fresh per-IP rate buckets and fake audit IPs.
function clientIp(req: NextRequest): string {
  return deviceClientIp(req)
}

function text(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8" } })
}

// ────────────── Handshake (GET /iclock/cdata) ──────────────
// Device sends: GET /iclock/cdata?SN=<serial>&options=all
//                       &pushver=<ver>&language=<lang>&FW=<fw>&NewOV=<...>
// Server replies with the device's "options" — see adapter.handshakeResponse().
export async function GET(req: NextRequest) {
  const t0 = Date.now()
  const ip = clientIp(req)
  if (!GATEWAY_ENV.enabled()) return text(admsError("ADMS gateway disabled"), 503)
  if (rateLimited(ip)) return text(admsError("rate limit exceeded"), 429)

  const sn = req.nextUrl.searchParams.get("SN")
  if (sn && snRateLimited(sn)) return text(admsError("device rate limit exceeded"), 429)
  // C-03 — authentication = pre-registered SN + comm key (ZKTeco firmware
  // sends it as the `pushcommkey` query param). Keyless devices only pass
  // when the vendor admin setting Allow Keyless Devices is enabled
  // (Settings → Devices); otherwise they are rejected with 401.
  const auth = await resolveDevice(sn, req.nextUrl.searchParams.get("pushcommkey"), { endpointProtocol: "ADMS" })
  if (!auth.ok) {
    await logComm({
      vendorId: auth.vendorId || "UNKNOWN", serial: sn || "—", endpoint: BASE, requestType: "REJECTED",
      httpStatus: auth.code, ok: false, error: auth.reason, ip,
    })
    return text(admsError(auth.reason), auth.code)
  }

  const params = parseHandshakeParams(req.nextUrl.searchParams)
  await handshake(auth.device, params, ip)
  if (process.env.ZKTECO_ADMS_DEBUG_CAPTURE === "true") {
    console.log(`[zkteco:capture] HANDSHAKE SN=${sn} params=${JSON.stringify(params)}`)
  }
  await logComm({
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- audited TODO(H-20 paydown): convert to an explicit null check
    vendorId: auth.device.vendorId, deviceId: auth.device.id, serial: sn!, endpoint: BASE,
    requestType: "HANDSHAKE", httpStatus: 200, durationMs: Date.now() - t0, ip,
    // SCL-4 — the handshake poll is pure liveness (state rides on the device
    // row via handshake()); sample to 1 row per device per window.
    sample: { key: `handshake:${auth.device.id}` },
  })
  // the device row carries the upload watermark + history-sync window
  // (resolveDevice only succeeds with a valid SN, so the device's own
  // identifier is used instead of a non-null assertion on `sn`)
  return text(await handshakeOptionsFor(sn || String(auth.device.deviceIdentifier || ""), auth.device))
}

// ────────────── Attendance log push (POST /iclock/cdata) ──────────────
// Device sends: POST /iclock/cdata?SN=<serial>  body: ATTLOG/OPERLOG/USERINFO lines
// Server replies: `OK: <count>` where count = newly-stored + known duplicates.
export async function POST(req: NextRequest) {
  const t0 = Date.now()
  const ip = clientIp(req)
  if (!GATEWAY_ENV.enabled()) return text(admsError("ADMS gateway disabled"), 503)
  if (rateLimited(ip)) return text(admsError("rate limit exceeded"), 429)

  const sn = req.nextUrl.searchParams.get("SN")
  if (sn && snRateLimited(sn)) return text(admsError("device rate limit exceeded"), 429)
  // C-03 — authentication = pre-registered SN + comm key (ZKTeco firmware
  // sends it as the `pushcommkey` query param). Keyless devices only pass
  // when the vendor admin setting Allow Keyless Devices is enabled
  // (Settings → Devices); otherwise they are rejected with 401.
  const auth = await resolveDevice(sn, req.nextUrl.searchParams.get("pushcommkey"), { endpointProtocol: "ADMS" })
  if (!auth.ok) {
    await logComm({
      vendorId: auth.vendorId || "UNKNOWN", serial: sn || "—", endpoint: BASE, requestType: "REJECTED",
      httpStatus: auth.code, ok: false, error: auth.reason, ip,
    })
    return text(admsError(auth.reason), auth.code)
  }

  // H-12 — body size cap enforced BEFORE the body is read: an oversized or
  // length-less POST gets 413 without buffering anything.
  if (bodyCapExceeded(req, BODY_CAP_CDATA)) {
    await logComm({
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- audited TODO(H-20 paydown): convert to an explicit null check
      vendorId: auth.device.vendorId, deviceId: auth.device.id, serial: sn!, endpoint: BASE,
      requestType: "REJECTED", httpStatus: 413, ok: false,
      error: `BODY_TOO_LARGE: content-length > ${BODY_CAP_CDATA} bytes (or missing)`, ip,
    })
    return text(admsError("request body too large"), 413)
  }

  let body = ""
  try {
    body = await req.text()
  } catch {
    return text(admsError("unreadable body"), 400)
  }
  if (!body.trim()) return text(admsError("empty body"), 400)

  if (process.env.ZKTECO_ADMS_DEBUG_CAPTURE === "true") {
    console.log(`[zkteco:capture] ATTLOG SN=${sn} body=${body.slice(0, 2000).replace(/\t/g, "<TAB>")}`)
  }

  // `table` says which record kind this POST carries (ATTLOG / OPERLOG /
  // ATTPHOTO / options); `Stamp` is the device's upload watermark.
  const table = req.nextUrl.searchParams.get("table")
  const stamp = req.nextUrl.searchParams.get("Stamp") || req.nextUrl.searchParams.get("OpStamp")
  let res
  try {
    res = await ingestLines(auth.device, body, ip, { table, stamp })
  } catch (e: any) {
    // an over-limit batch: answer a protocol error (not an unhandled 500)
    const code = Number(e?.code) === 413 ? 413 : 500
    if (code === 500) console.error("[zkteco] cdata ingest failed", e)
    return text(admsError(String(e?.message || "ingest failed")), code)
  }
  const requestType =
    (table || "").toUpperCase() === "OPTIONS" ? "OPTIONS" :
    res.operlog > 0 && res.accepted === 0 ? "OPERLOG" :
    res.userinfo > 0 && res.accepted === 0 ? "USERINFO" : "ATTLOG"
  await logComm({
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- audited TODO(H-20 paydown): convert to an explicit null check
    vendorId: auth.device.vendorId, deviceId: auth.device.id, serial: sn!, endpoint: BASE,
    requestType,
    httpStatus: 200, eventCount: res.accepted, duplicateCount: res.duplicates,
    durationMs: Date.now() - t0,
    // N-4 — make silent drops visible: unparseable/out-of-window line counts
    // ride along on the request row so Sync Monitor shows ATTLOG pushes that
    // ACKed 200 but stored nothing.
    error: [
      res.invalid > 0 ? `INVALID_LINES: ${res.invalid}` : "",
      res.outOfWindow > 0 ? `OUT_OF_WINDOW_LINES: ${res.outOfWindow}` : "",
      res.userinfo > 0 ? `USER_LINES: ${res.userinfo}` : "",
      res.operlog > 0 ? `OPERLOG_LINES: ${res.operlog}` : "",
      table ? `table=${table}` : "",
    ].filter(Boolean).join(" · ") || undefined,
    ip,
  })
  // ACK strictly what is durably stored (new + already-known duplicates).
  // M-7 — OPERLOG / USERINFO / BIO lines are persisted (comm-log side channel)
  // and MUST be counted too: firmware that sees them unacknowledged re-sends
  // the same lines on every handshake, inflating traffic forever.
  // L-10 — unparseable/out-of-window lines are ACKed as well: they are either
  // preserved in the comm-log row (INVALID_LINES) or, since the 2026-10
  // historical-sync fix, durably stored as OUT_OF_WINDOW raw events. Leaving
  // them unacknowledged makes firmware re-push them forever while the server
  // keeps re-storing the same payload hash — acking is the safe default:
  // nothing is lost, the evidence stays.
  // 2026-10-07 — ACK the number of record LINES consumed. The old sum added
  // outOfWindow on top of `accepted` (a quarantined line is counted in both),
  // over-reporting the count.
  const acked = res.lines ?? (res.accepted + res.duplicates + res.operlog + res.userinfo + res.biodata + res.invalid)
  return text(ackEvents(acked))
}

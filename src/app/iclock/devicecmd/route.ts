// ============ ADMS endpoint: /iclock/devicecmd (command result callback) ============
// After the device executes a command received from /iclock/getrequest, it
// posts the outcome here. Body is typically `OK` or `Command=CHECK\nResult=OK`.
// Server ACKs with `OK\n`.
//
// Path is HARD-CODED in ZKTeco firmware — cannot be reconfigured.
import { NextRequest } from "next/server"
import { resolveDevice, snRateLimited, rateLimited, logComm, recordCommandResult, GATEWAY_ENV, bodyCapExceeded, BODY_CAP_ATTLOG, deviceClientIp } from "@/hrm-server/zkteco/gateway"
import { ackOk, admsError } from "@/hrm-server/zkteco/adapter"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

const BASE = "/iclock/devicecmd"

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

  // H-12 — 256 KB body cap enforced BEFORE the body is read.
  if (bodyCapExceeded(req, BODY_CAP_ATTLOG)) {
    await logComm({
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- audited TODO(H-20 paydown): convert to an explicit null check
      vendorId: auth.device.vendorId, deviceId: auth.device.id, serial: sn!, endpoint: BASE,
      requestType: "REJECTED", httpStatus: 413, ok: false,
      error: `BODY_TOO_LARGE: content-length > ${BODY_CAP_ATTLOG} bytes (or missing)`, ip,
    })
    return text(admsError("request body too large"), 413)
  }

  let body = ""
  try { body = await req.text() } catch { body = "" }
  const cmd = await recordCommandResult(auth.device, body)
  await logComm({
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- audited TODO(H-20 paydown): convert to an explicit null check
    vendorId: auth.device.vendorId, deviceId: auth.device.id, serial: sn!, endpoint: BASE,
    requestType: "DEVICECMD", httpStatus: 200, eventCount: cmd ? 1 : 0,
    durationMs: Date.now() - t0, error: body.slice(0, 200) || undefined, ip,
  })
  return text(ackOk())
}

// ============ ADMS endpoint: /iclock/getrequest (device command poll) ============
// The device polls this endpoint on the LOGDELAY interval (60s by default).
// The gateway returns the next queued command (CHECK / REBOOT / CLEAR LOG / …)
// followed by `OK\n`, or plain `OK\n` when the queue is empty.
//
// Path is HARD-CODED in ZKTeco firmware — cannot be reconfigured.
import { NextRequest } from "next/server"
import { db } from "@/lib/db"
import { resolveDevice, snRateLimited, rateLimited, logComm, takeCommandEntry, userInfoRows, GATEWAY_ENV, deviceClientIp } from "@/hrm-server/zkteco/gateway"
import { buildCommandResponse, admsError } from "@/hrm-server/zkteco/adapter"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

const BASE = "/iclock/getrequest"

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

  const cmd = await takeCommandEntry(auth.device)
  // A getrequest poll proves the device is alive and talking to this server —
  // stamp it so derived status stays ONLINE and the auto-CHECK loop keeps the
  // device in its "actively connected" window.
  await db.attendanceDevice.update({
    where: { id: auth.device.id },
    data: { lastSeenAt: new Date(), status: "ONLINE" },
  }).catch(() => {})
  await logComm({
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- audited TODO(H-20 paydown): convert to an explicit null check
    vendorId: auth.device.vendorId, deviceId: auth.device.id, serial: sn!, endpoint: BASE,
    requestType: "GETREQUEST", httpStatus: 200, eventCount: cmd ? 1 : 0,
    error: cmd?.command || undefined, durationMs: Date.now() - t0, ip,
    // SCL-4 — a bare poll (no command delivered) is pure liveness; the
    // device row already carries lastSeenAt/status. Sample to 1 row per
    // device per window. A poll WITH a command is meaningful traffic — keep.
    ...(cmd ? {} : { sample: { key: `getrequest:${auth.device.id}` } }),
  })
  // DATA UPDATE USERINFO carries the server's user roster (ADMS
  // server→device provisioning): one `C:<id>:DATA UPDATE USERINFO PIN=…`
  // wire line per registered user (2026-10-07 — was a single bare command
  // followed by raw rows, which firmware ignored).
  if (cmd && cmd.command.trim().toUpperCase() === "DATA UPDATE USERINFO") {
    const rows = await userInfoRows(auth.device.vendorId, auth.device.id)
    if (!rows.length) {
      await db.deviceCommand.update({ where: { id: cmd.id }, data: { status: "DONE", doneAt: new Date(), result: "no active mappings to push" } }).catch(() => {})
      return text(buildCommandResponse(null))
    }
    return text(buildCommandResponse({ id: cmd.id, command: cmd.command, lines: rows.map((r) => `DATA UPDATE USERINFO ${r}`) }))
  }
  return text(buildCommandResponse(cmd))
}

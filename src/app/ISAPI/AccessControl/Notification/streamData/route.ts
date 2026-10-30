// ============ Hikvision ISAPI attendance event receiver (CRIT-2 hardened) ============
// Hikvision attendance & access-control terminals (DS-K1T series common in BD)
// push attendance events via ISAPI — Hikvision's HTTP/XML protocol. The device
// POSTs an XML event-notification payload here when configured with this URL:
//
//   POST /ISAPI/AccessControl/Notification/streamData  (real-time event stream)
//
// The XML payload (xmlns: http://www.hikvision.com/ver20/XMLSchema) looks like:
//
//   <NotificationEvent notificationType="attendance">
//     <Code>attendance</Code>
//     <DateTime>2024-09-15T09:30:15+06:00</DateTime>
//     <EmployeeNo>1234</EmployeeNo>
//     <DeviceName>Front-Gate-DS-K1T804</DeviceSerial>
//     <DeviceSerial>DS-K1T80420240115AX...</DeviceSerial>
//     <AttendanceType>checkIn</AttendanceType>
//     <VerifyMode>face</VerifyMode>
//   </NotificationEvent>
//
// CRIT-2 fix (this audit) — the previous implementation authenticated by SN
// pre-registration ONLY (no comm-key, no HMAC, no body cap, no freshness
// window). The GET capabilities probe falsely advertised <AuthMode>digest</AuthMode>
// but POST enforced nothing. An attacker who learned a registered device's
// serial number could forge attendance events for any employee.
//
// The fix reuses the ZKTeco comm-key model: a per-device shared secret enrolled
// via devices.setCommKey. The device sends an HMAC-SHA256 over the XML body +
// a timestamp header. We verify with timingSafeEqual. We also enforce a body
// cap, per-SN rate limit, and a freshness window (events outside [now-7d,
// now+5min] are rejected, mirroring the ZKTeco gateway).
//
// Registration: Settings → Attendance → Devices — create a device with
// protocol HIKVISION_ISAPI and deviceIdentifier = the device serial number.
// Then enroll a comm key (devices.setCommKey) — the same comm key is used by
// ZKTeco and Hikvision devices interchangeably.

import { NextRequest } from "next/server"
import { db } from "@/lib/db"
import { logComm, rateLimited, snRateLimited, GATEWAY_ENV, storeRawEventBatch, processFreshInline } from "@/hrm-server/zkteco/gateway"
import { fingerprint, eventDate, eventClock, clockDriftSec, eventWithinWindow, deviceFrameNow } from "@/hrm-server/zkteco/adapter"
import { readCommKey } from "@/hrm-server/zkteco/comm-key"
import { getSettings } from "@/hrm-server/settings"
import crypto from "node:crypto"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

const BASE = "/ISAPI/AccessControl/Notification/streamData"

/** CRIT-2 — body cap mirrors the ZKTeco /iclock/cdata cap (256 KB). Hikvision
 *  event-notification XML is typically <10 KB per batch; 256 KB is generous. */
const BODY_CAP_BYTES = 256 * 1024

function clientIp(req: NextRequest): string {
  // CRIT-2 / ZKT-3 — honor X-Forwarded-For only behind a trusted proxy.
  // The HRM_TRUST_PROXY env flag is checked here (was previously ignored).
  // SEC-4 note: kept local here because the ISAPI receiver adopted the
  // trust-gated rule ahead of the /iclock plane; the semantics are identical
  // to the shared gateway.deviceClientIp helper.
  if (process.env.HRM_TRUST_PROXY === "1") {
    const xff = (req.headers.get("x-forwarded-for") || "").split(",")[0].trim()
    if (xff) return xff
  }
  // Fall back to the connection peer if no trusted XFF header
  return req.headers.get("x-real-ip") || "unknown"
}

function xml(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "content-type": "text/xml; charset=utf-8", "cache-control": "no-store" } })
}

const tag = (body: string, name: string): string | null => {
  const m = body.match(new RegExp(`<${name}[^>]*>([^<]*)</${name}>`, "i"))
  return m ? m[1].trim() : null
}

/** Hikvision verify-mode label → ZKTeco-style numeric code (informational). */
const HIK_VERIFY: Record<string, number> = {
  face: 1, fingerprint: 1, fingerPrint: 1, card: 15, qrCode: 15, password: 0, other: 255,
}

/** Hikvision check direction → engine event class. */
function directionOf(at: string | null): "IN" | "OUT" | "AUTO" {
  const v = (at || "").toLowerCase()
  if (/checkin|check_in|in\b/.test(v) && !/checkout/.test(v)) return "IN"
  if (/checkout|check_out/.test(v)) return "OUT"
  return "AUTO" // terminal decides by punch order (same as ZKTeco 254/255)
}

/** "2024-09-15T09:30:15+06:00" → "2024-09-15 09:30:15" (device wall clock). */
function toWallClock(iso: string): string | null {
  const m = iso.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})/)
  return m ? `${m[1]} ${m[2]}` : null
}

/** CRIT-2 — verify the device-supplied HMAC-SHA256 signature over body+timestamp.
 *  The signature header format: X-Hik-Sig: hex(hmac_sha256(commKey, timestamp + "\n" + body))
 *  The timestamp header format: X-Hik-Ts: ISO8601 string
 *  Returns null if the signature is valid, or a human-readable error otherwise. */
async function verifyHikvisionSignature(
  device: any,
  req: NextRequest,
  body: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const presentedSig = req.headers.get("x-hik-sig") || req.headers.get("x-hikvision-signature") || ""
  const presentedTs = req.headers.get("x-hik-ts") || req.headers.get("x-hikvision-timestamp") || ""
  if (!presentedSig || !presentedTs) {
    return { ok: false, reason: "Missing X-Hik-Sig or X-Hik-Ts header — device must be configured with HMAC authentication" }
  }
  // Freshness window: timestamp must be within ±5 min of server time.
  const ts = Date.parse(presentedTs)
  if (Number.isNaN(ts)) {
    return { ok: false, reason: "X-Hik-Ts is not a parseable ISO8601 timestamp" }
  }
  const skew = Math.abs(Date.now() - ts)
  if (skew > 5 * 60_000) {
    return { ok: false, reason: `Timestamp skew ${Math.round(skew / 1000)}s exceeds 300s freshness window` }
  }
  // Verify HMAC: if device has a commKey enrolled, require it.
  if (!device.commKeyHash && !device.commKey) {
    return { ok: false, reason: `Device ${device.deviceIdentifier} has no comm key enrolled — enroll via Settings → Devices → Set Comm Key` }
  }
  // M-20 — recover the plaintext key (encrypted at rest; legacy plaintext
  // rows still readable). Hash-only rows (pre-C-03 enrollment, no stored key)
  // can NEVER verify an HMAC — previously the code silently verified against
  // an EMPTY key, which always failed with a misleading "Invalid signature".
  // Surface the actionable instruction instead.
  const commKey = readCommKey(device.commKey)
  if (!commKey) {
    return { ok: false, reason: `Device ${device.deviceIdentifier} has only a legacy key hash on file — re-enroll the comm key (Settings → Devices → Set Comm Key) to enable ISAPI HMAC` }
  }
  const expected = crypto.createHmac("sha256", commKey).update(`${presentedTs}\n${body}`).digest("hex")
  // Constant-time compare on equal-length hex strings.
  const a = Buffer.from(presentedSig, "hex")
  const b = Buffer.from(expected, "hex")
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, reason: "Invalid X-Hik-Sig HMAC signature" }
  }
  return { ok: true }
}

export async function POST(req: NextRequest) {
  const t0 = Date.now()
  const ip = clientIp(req)
  // M-7 — master kill-switch + per-IP rate limit.
  if (!GATEWAY_ENV.enabled()) {
    return xml("<error>gateway disabled</error>", 503)
  }
  if (rateLimited(ip)) {
    await logComm({
      vendorId: "UNKNOWN", serial: "UNKNOWN", endpoint: BASE, requestType: "REJECTED",
      httpStatus: 429, ok: false, error: "rate limit exceeded (per-IP)", ip,
    }).catch(() => {})
    return xml("<error>rate limit exceeded</error>", 429)
  }
  // CRIT-2 — body cap BEFORE req.text() to prevent memory-exhaustion DoS.
  const contentLength = Number(req.headers.get("content-length") || 0)
  if (contentLength && contentLength > BODY_CAP_BYTES) {
    await logComm({
      vendorId: "UNKNOWN", serial: "UNKNOWN", endpoint: BASE, requestType: "REJECTED",
      httpStatus: 413, ok: false, error: `body too large (${contentLength} > ${BODY_CAP_BYTES})`, ip,
    }).catch(() => {})
    return xml("<error>body too large</error>", 413)
  }
  let body = ""
  try { body = await req.text() } catch { return xml("<error>unreadable body</error>", 400) }
  if (body.length > BODY_CAP_BYTES) {
    return xml("<error>body too large</error>", 413)
  }

  // ---- device resolution: pre-registered Hikvision devices only (never auto-register) ----
  const sn = tag(body, "DeviceSerial") || tag(body, "serialNumber") || "UNKNOWN"
  if (!sn || sn === "UNKNOWN" || !/^[A-Za-z0-9_-]{4,64}$/.test(sn)) {
    await logComm({
      vendorId: "UNKNOWN", serial: sn, endpoint: BASE, requestType: "REJECTED",
      httpStatus: 400, ok: false, error: "Missing/invalid DeviceSerial", ip,
    }).catch(() => {})
    return xml("<error>Missing or invalid DeviceSerial</error>", 400)
  }
  // CRIT-2 — per-SN rate limit (same model as /iclock/cdata).
  if (snRateLimited(sn)) {
    await logComm({
      vendorId: "UNKNOWN", serial: sn, endpoint: BASE, requestType: "REJECTED",
      httpStatus: 429, ok: false, error: "rate limit exceeded (per-SN)", ip,
    }).catch(() => {})
    return xml("<error>rate limit exceeded for this device</error>", 429)
  }
  const device = await db.attendanceDevice.findFirst({
    where: { deviceIdentifier: sn, protocol: "HIKVISION_ISAPI" },
  }).catch(() => null)
  let resolvedDevice: any = device
  if (!device || !device.enabled) {
    // back-compat: older registrations used manufacturer "Hikvision".
    // H-10 — the legacy lookup is now filtered to devices that have NEVER
    // handshaked on the ADMS plane (pushVersion IS NULL is set by the /iclock
    // handshake): a ZKTeco ADMS terminal mis-registered with manufacturer
    // "Hikvision" can no longer be replayed against this ISAPI endpoint once
    // it has pushed on /iclock. Legacy Hikvision rows (never on /iclock)
    // keep working.
    const legacy = device ? null : await db.attendanceDevice.findFirst({
      where: { deviceIdentifier: sn, manufacturer: { contains: "Hikvision" }, pushVersion: null },
    }).catch(() => null)
    if (!legacy || !legacy.enabled) {
      await logComm({
        vendorId: "UNKNOWN", serial: sn, endpoint: BASE, requestType: "REJECTED",
        httpStatus: 404, ok: false, error: `Unknown Hikvision device ${sn}`, ip,
      })
      return xml(`<error>Unknown device ${sn}</error>`, 404)
    }
    resolvedDevice = legacy
  }

  // CRIT-2 — verify HMAC signature. If the vendor setting "Allow Keyless Devices"
  // is true AND no comm-key is enrolled, we fall back to SN-only auth with a
  // loud warning. Otherwise, HMAC is required.
  const settings = await getSettings(resolvedDevice.vendorId).catch(() => null)
  const allowKeyless = settings?.devices?.allowKeyless === true
  const hasCommKey = !!(resolvedDevice.commKeyHash || resolvedDevice.commKey)
  if (hasCommKey) {
    const sig = await verifyHikvisionSignature(resolvedDevice, req, body)
    if (!sig.ok) {
      await logComm({
        vendorId: resolvedDevice.vendorId, serial: sn, endpoint: BASE, requestType: "REJECTED",
        httpStatus: 401, ok: false, error: sig.reason, ip,
      }).catch(() => {})
      return xml(`<error>Auth failed: ${sig.reason}</error>`, 401)
    }
  } else if (!allowKeyless) {
    await logComm({
      vendorId: resolvedDevice.vendorId, serial: sn, endpoint: BASE, requestType: "REJECTED",
      httpStatus: 401, ok: false, error: `Device ${sn} has no comm key enrolled and vendor does not allow keyless`, ip,
    }).catch(() => {})
    return xml(`<error>Device ${sn} has no comm key enrolled</error>`, 401)
  } else {
    // Keyless allowed — log a warning so the operator knows this device is auth-light.
    console.warn(`[isapi] keyless auth accepted for device ${sn} (vendor allows keyless)`)
  }

  return acceptEvents(resolvedDevice, body, sn, ip, t0)
}

async function acceptEvents(device: any, body: string, sn: string, ip: string, t0: number) {
  // ---- parse every NotificationEvent block in the payload ----
  const blocks = body.match(/<NotificationEvent[\s\S]*?<\/NotificationEvent>/gi) || [body]
  let accepted = 0, duplicates = 0, invalid = 0, unknown = 0, failed = 0, outOfWindow = 0
  let lastEventTime: string | null = null
  // SCL-8 (Phase 2 WS2) — buffered batch storage, mirroring the /iclock
  // ingest loop: events accumulate and flush via storeRawEventBatch (one
  // createMany per 500 events) instead of one INSERT round-trip per event.
  const pendingFresh: { ev: Parameters<typeof storeRawEventBatch>[0][number]; eventTime: string; hash: string }[] = []
  const pendingOow: Parameters<typeof storeRawEventBatch>[0][number][] = []
  // H-3 — the freshness reference MUST be in the device's timezone frame (the
  // shared deviceFrameNow() helper from adapter.ts, exactly like /iclock). The
  // old raw `new Date()` was a UTC/server-local frame: with the default +6
  // offset every fresh Dhaka-stamped event parsed ~6h in the future and was
  // silently dropped as OUT_OF_WINDOW while still being ACKed.
  const tzHours = GATEWAY_ENV.timeZone()
  const frameNow = deviceFrameNow(tzHours)

  for (const block of blocks) {
    const code = (tag(block, "Code") || tag(block, "eventType") || "attendance").toLowerCase()
    if (code !== "attendance" && code !== "AccessControllerEvent" && !/attend/i.test(code)) {
      invalid++ // heartbeats / alarm events — ack without processing
      continue
    }
    const employeeNo = tag(block, "EmployeeNo") || tag(block, "employeeNoString")
    const dateTime = tag(block, "DateTime") || tag(block, "dateTime")
    const wallClock = dateTime ? toWallClock(dateTime) : null
    if (!employeeNo || !wallClock) { invalid++; continue }

    // MOD-1 (Phase 1) — the event object + fingerprint are built BEFORE the
    // freshness check so the quarantine branch and the live branch share one
    // construction path (same shape as the ZKTeco loop, where `parsed` exists
    // before the window test).
    const attendanceType = tag(block, "AttendanceType") || tag(block, "attendanceType")
    const verifyLabel = (tag(block, "VerifyMode") || tag(block, "verifyMode") || "other").toLowerCase()
    const ev = {
      deviceSerial: sn,
      deviceUserId: employeeNo,
      eventTime: wallClock,
      verifyMode: HIK_VERIFY[verifyLabel] ?? 255,
      attendanceStatus: null,
      workCode: tag(block, "WorkCode"),
      eventType: directionOf(attendanceType),
      rawLine: block.slice(0, 1000),
    }
    const fp = fingerprint(sn, ev)

    // CRIT-2/H-3 — freshness window in the DEVICE frame: events outside
    // [now-7d, now+5min] are QUARANTINED, not dropped (MOD-1, Phase 1).
    // The old code counted them and still ACKed 200 — Hikvision firmware then
    // purged them as DELIVERED and the punch was permanently lost on both
    // sides (the exact data-loss class the 2026-10 ZKTeco historical-sync fix
    // closed for /iclock). Mirroring the ZKTeco quarantine: the punch is
    // stored durably with processingStatus OUT_OF_WINDOW (bounded by the
    // 10-year backfill range; far-future garbage clocks are still rejected
    // outright) and becomes eligible the moment a widened history-sync window
    // covers it.
    if (!eventWithinWindow(wallClock, frameNow, GATEWAY_ENV.ingestWindowDays(), 5)) {
      outOfWindow++
      const evMs = new Date(wallClock.replace(" ", "T") + "Z").getTime()
      const withinMaxBackfill = Number.isFinite(evMs)
        && evMs >= frameNow.getTime() - 3650 * 86_400_000 // max supported sync range (10y)
        && evMs <= frameNow.getTime() + 5 * 60_000 // garbage far-future clocks are NOT stored
      if (!withinMaxBackfill) continue
      pendingOow.push({
        vendorId: device.vendorId,
        deviceId: device.id,
        deviceSerial: sn,
        deviceUserId: ev.deviceUserId,
        eventTime: ev.eventTime,
        verifyMode: ev.verifyMode,
        attendanceStatus: ev.attendanceStatus,
        workCode: ev.workCode,
        eventType: ev.eventType,
        rawLine: `ISAPI ${ev.rawLine}`,
        payloadHash: fp,
        processingStatus: "OUT_OF_WINDOW",
        processingError: `OUT_OF_WINDOW: outside the ${GATEWAY_ENV.ingestWindowDays()}d ingest window — awaiting historical-sync reprocessing`,
      })
      if (!lastEventTime || ev.eventTime > lastEventTime) lastEventTime = ev.eventTime
      continue
    }

    pendingFresh.push({
      ev: {
        vendorId: device.vendorId,
        deviceId: device.id,
        deviceSerial: sn,
        deviceUserId: ev.deviceUserId,
        eventTime: ev.eventTime,
        verifyMode: ev.verifyMode,
        attendanceStatus: ev.attendanceStatus,
        workCode: ev.workCode,
        eventType: ev.eventType,
        rawLine: `ISAPI ${ev.rawLine}`,
        payloadHash: fp,
        processingStatus: "RECEIVED",
      },
      eventTime: ev.eventTime,
      hash: fp,
    })
  }

  // SCL-8 — flush buffers with exact accepted/duplicate classification.
  if (pendingFresh.length) {
    const flush = await storeRawEventBatch(pendingFresh.map((p) => p.ev))
    for (const p of pendingFresh) {
      if (flush.acceptedHashes.has(p.hash)) {
        accepted++
        if (!lastEventTime || p.eventTime > lastEventTime) lastEventTime = p.eventTime
      } else if (flush.duplicateHashes.has(p.hash)) {
        duplicates++ // device retry — already durably stored
      } else {
        invalid++
      }
    }
  }
  if (pendingOow.length) {
    const flushOow = await storeRawEventBatch(pendingOow)
    accepted += flushOow.acceptedHashes.size
    duplicates += flushOow.duplicateHashes.size
    invalid += flushOow.failed
  }

  // ---- durable → process through the shared engine (same as ZKTeco) ----
  // MOD-2 (Phase 1) — the OLD code did a plain findMany(RECEIVED) + loop
  // WITHOUT the atomic RECEIVED→PROCESSING claim: two overlapping ISAPI POSTs
  // (or a POST racing the 15s sweeper) could double-process the same rows.
  // The shared processFreshInline() applies the same conditional claim the
  // ZKTeco fast path uses; large batches (accepted > 200) are left to the
  // sweeper so the HTTP ACK reaches the device within its timeout.
  if (accepted <= 200) {
    const inline = await processFreshInline(device.id, { maxInline: 200, batchSize: 500 })
    unknown += inline.unknown
    failed += inline.failed
  }

  // ---- device bookkeeping ----
  const now = new Date()
  const driftSample = lastEventTime && Math.abs(clockDriftSec(lastEventTime, now, tzHours)) < 300 ? clockDriftSec(lastEventTime, now, tzHours) : null
  await db.attendanceDevice.update({
    where: { id: device.id },
    data: {
      lastSeenAt: now,
      lastAttendanceAt: lastEventTime ? new Date(lastEventTime.replace(" ", "T") + "Z") : undefined,
      status: "ONLINE",
      eventCount: { increment: accepted },
      ...(driftSample != null ? { clockDriftSec: Math.round(driftSample) } : {}),
    },
  }).catch(() => {})

  await logComm({
    vendorId: device.vendorId, deviceId: device.id, serial: sn, endpoint: BASE,
    requestType: "ISAPI_ATTENDANCE", httpStatus: 200, eventCount: accepted,
    error: `accepted=${accepted} dup=${duplicates} invalid=${invalid} outOfWindow=${outOfWindow} unknownEmp=${unknown} failed=${failed}`,
    durationMs: Date.now() - t0, ip,
  })

  return xml(`<?xml version="1.0" encoding="UTF-8"?>\n<ResponseStatus>OK</ResponseStatus>`, 200)
}

void eventDate
void eventClock

// Capabilities probe — Hikvision calls this on first connect.
// CRIT-2 — the previously-false <AuthMode>digest</AuthMode> claim is now
// accurate: HMAC-SHA256 over (timestamp + body) via X-Hik-Sig + X-Hik-Ts
// headers, with the per-device comm key as the shared secret.
export async function GET() {
  return xml(`<?xml version="1.0" encoding="UTF-8"?>
<Capabilities>
  <Notification capabilities="attendance,alarm,access"/>
  <SupportedVersions>ISAPI/1.0,ISAPI/2.0</SupportedVersions>
  <AuthMode>hmac-sha256</AuthMode>
  <AuthHeaders>X-Hik-Ts (ISO8601 timestamp), X-Hik-Sig (hex hmac-sha256(commKey, ts + "\\n" + body))</AuthHeaders>
  <FreshnessWindow>±300 seconds</FreshnessWindow>
  <MaxBodyBytes>262144</MaxBodyBytes>
</Capabilities>`, 200)
}

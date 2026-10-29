// ============ ZKTeco ADMS Gateway (official Push SDK / ADMS protocol) ============
// The biometric device talks ONLY to this gateway — never to the DB or other
// internal services. ACK discipline: the device is acknowledged strictly
// AFTER the raw event is durably stored; processing failures never reject an
// already-durable event (they go to the retry queue instead).
//
// Device authentication model (C-03): PRE-REGISTRATION by serial number PLUS
// comm-key verification. A device is trusted because (a) its SN was registered
// to a tenant inside HRM before its first push, AND (b) it presents the shared
// comm key that was enrolled for it (ZKTeco firmware sends it as the
// `pushcommkey` query parameter). Keyless pre-registered devices are governed
// by the vendor admin setting "Allow Keyless Devices" (Settings → Devices):
// enabled → they communicate normally (flagged keyless for the Sync Monitor);
// disabled → rejected with 401. Keyed devices authenticate with their comm key
// regardless of that setting. Per-IP and per-SN rate limiting + enable/disable
// still apply. (The former 7-day grace window and the lab-only
// ATTENDANCE_GATEWAY_ALLOW_OPEN override were removed on 2026-09-22 — the
// admin setting is the single control.)
//
// Endpoints that consume this gateway (mounted in src/app/iclock/*/route.ts):
//   GET  /iclock/cdata?SN=…&pushver=…                             → handshake (options)
//   POST /iclock/cdata?SN=…                                       → ATTLOG/OPERLOG/USERINFO lines
//   GET  /iclock/getrequest?SN=…                                  → next command | "OK"
//   POST /iclock/devicecmd?SN=…                                   → command result
//   POST /iclock/deviceparams?SN=…                                → device params push
//   POST /iclock/cdatapic?SN=…&pin=…&stime=…&index=…            → punch photo upload

import { db } from "@/lib/db"
import {
  parseAttLogLine, parseOperlogLine, parseUserInfoLine, classifyLine,
  fingerprint, clockDriftSec, eventWithinWindow, deviceFrameNow,
  handshakeResponse as buildHandshakeResponse, admsCommandId, parseCommandResults,
} from "./adapter"
import { mapAndProcessEvent, autoMapDeviceUser } from "./processor"
import { verifyCommKeyAsync } from "./commkey"
import { getSettings } from "../settings"

type Device = {
  id: string
  vendorId: string
  deviceId: string
  name: string
  deviceIdentifier: string | null
  enabled: boolean
  commKey: string | null
  commKeyHash: string | null // scrypt-salted hash (v2); legacy sha256 hex supported read-only
  commKeySalt: string | null
  commKeySetAt: Date | null
  createdAt: Date
  eventCount: number
  timezone?: string | null
}

export const GATEWAY_ENV = {
  enabled: () => (process.env.ZKTECO_ADMS_ENABLED ?? "true") !== "false",
  rateLimitPerMin: () => Number(process.env.ADMS_RATE_LIMIT_PER_MIN || 300),
  offlineThresholdSec: () => Number(process.env.ATTENDANCE_DEVICE_OFFLINE_THRESHOLD_SECONDS || 300),
  warningThresholdSec: () => Number(process.env.ATTENDANCE_DEVICE_WARNING_THRESHOLD_SECONDS || 120),
  retryLimit: () => Number(process.env.ATTENDANCE_EVENT_RETRY_LIMIT || 10),
  logDelaySec: () => Number(process.env.ADMS_LOGDELAY_SECONDS || 60),
  realtime: () => (process.env.ADMS_REALTIME ?? "true") !== "false",
  photoFun: () => (process.env.ADMS_PHOTO_FUN ?? "false") === "true",
  transInterval: () => Number(process.env.ADMS_TRANS_INTERVAL_MIN || 1),
  timeZone: () => Number(process.env.ADMS_TIMEZONE_OFFSET_HOURS || 6), // Asia/Dhaka = +6
  timeout: () => Number(process.env.ADMS_TIMEOUT_MIN || 30),
  // Automatic attendance pull: how often (seconds) the server asks each ONLINE
  // device to upload its unsent records (ADMS "CHECK" command via getrequest).
  // Complements Realtime pushes — guarantees data lands even when the device's
  // own Real-Time Events option is off or its firmware does not push reliably.
  // 0 disables the automatic pull loop.
  autoCheckSec: () => Number(process.env.ADMS_AUTO_CHECK_SECONDS ?? 120),
  // C-4 — device timestamp freshness window (days of lookback; ahead
  // tolerance is fixed at +5 minutes). Events stamped outside the window are
  // rejected + logged with reason OUT_OF_WINDOW.
  ingestWindowDays: () => Number(process.env.HRM_DEVICE_INGEST_WINDOW_DAYS || 7),
  // C-03 update (2026-09-22) — keyless-device acceptance is no longer
  // env-driven: the old gracePeriodDays / allowOpen knobs
  // (HRM_DEVICE_GRACE_PERIOD_DAYS / ATTENDANCE_GATEWAY_ALLOW_OPEN) were
  // REMOVED together with the 7-day expiration logic. The per-vendor admin
  // setting "Allow Keyless Devices" (Settings → Devices, HrSetting group
  // "devices") is now the single control — see resolveDevice below.
  // C-03 — per-SN rate limit (max requests/min per serial, independent of IP)
  snRateLimitPerMin: () => Number(process.env.HRM_DEVICE_SN_RATE_LIMIT_PER_MIN || 60),
  // L-14 — debug capture switch (same flag as the /iclock console capture in
  // cdata/route.ts). DEFAULT OFF: comm-log diagnostics carry REDACTED raw
  // lines (no employee names). ZKTECO_ADMS_DEBUG_CAPTURE=true opts into
  // unredacted lines + console capture for firmware debugging — never production.
  debugCapture: () => process.env.ZKTECO_ADMS_DEBUG_CAPTURE === "true",
}

// ---------- L-14 — PII redaction for comm-log diagnostics ----------
// DeviceCommLog error fields are readable by every devices.view operator, so
// employee names (pushed in USERINFO roster lines and embedded in raw lines)
// must never ride along in diagnostics. Redaction is the DEFAULT.
export const deviceDebugCapture = GATEWAY_ENV.debugCapture

if (deviceDebugCapture()) {
  // L-14 — loud, unmissable boot warning when debug capture is enabled (the
  // same flag also turns on raw-body console capture in /iclock/cdata).
  console.warn(
    "[zkteco][L-14] *** ZKTECO_ADMS_DEBUG_CAPTURE is enabled *** — device comm logs and the server console " +
      "will carry UNREDACTED raw device lines (including employee names). This is a firmware-debugging aid " +
      "only: NEVER leave it enabled in production."
  )
}

/** Mask the name column of a tab-separated device line. USERINFO puts the
 *  employee name in field 3 (`USERINFO \t PIN \t Name \t Card …`); other line
 *  kinds (ATTLOG / OPERLOG) carry no names and pass through unchanged. */
export function redactCommLine(line: string): string {
  const parts = line.split("\t")
  if (/^USERINFO/i.test(parts[0] || "") && parts.length >= 3) {
    parts[2] = "[REDACTED]"
    return parts.join("\t")
  }
  return line
}

/** Comm-log diagnostic slice: redacted by default, raw only under explicit
 *  ZKTECO_ADMS_DEBUG_CAPTURE opt-in. */
const diagLine = (line: string, cap: number): string =>
  (deviceDebugCapture() ? line : redactCommLine(line)).slice(0, cap)

// ---------- device authentication (pre-registration + comm key — no auto-register) ----------
export type DeviceAuthResult =
  | { ok: true; device: Device & Record<string, unknown>; keyless?: boolean }
  | { ok: false; code: number; reason: string; vendorId?: string }

/** Resolve a pushing device by its serial number and verify its comm key.
 *  Authentication = pre-registration (SN must already be registered to a
 *  tenant and enabled) + C-03 comm-key check with timing-safe comparison.
 *  `presentedKey` is the `pushcommkey` query param the ZKTeco firmware sends.
 *  Keyed devices always authenticate with their comm key. Keyless
 *  pre-registered devices pass ONLY when the vendor admin setting
 *  "Allow Keyless Devices" is enabled (Settings → Devices; flagged
 *  `keyless: true` for Sync Monitor warnings) — otherwise 401. */
export async function resolveDevice(sn: string | null, presentedKey?: string | null, opts?: { endpointProtocol?: "ADMS" | "ISAPI" }): Promise<DeviceAuthResult> {
  if (!sn || !/^[A-Za-z0-9_-]{4,64}$/.test(sn)) {
    return { ok: false, code: 400, reason: "Missing/invalid SN" }
  }
  // 2026-10-07 — tolerant SN match. Operators type the serial from the
  // device's label/menu; a case difference ("vgu…" vs "VGU…") or registering
  // it only as the informational Serial Number made every push 404 with
  // "Unknown device". Exact match first, then case-insensitive on the ADMS
  // identifier, then the informational serial (a unique, enabled hit only).
  let device = await db.attendanceDevice.findFirst({ where: { deviceIdentifier: sn } })
  if (!device) {
    const ci = await db.attendanceDevice.findMany({ where: { deviceIdentifier: { equals: sn, mode: "insensitive" } }, take: 2 })
    if (ci.length === 1) device = ci[0]
  }
  if (!device) {
    const bySerial = await db.attendanceDevice.findMany({ where: { serialNumber: { equals: sn, mode: "insensitive" } }, take: 2 })
    if (bySerial.length === 1) device = bySerial[0]
  }
  if (!device) {
    // NO auto-registration of arbitrary internet devices — must pre-register in HRM.
    return { ok: false, code: 404, reason: `Unknown device ${sn} — register it in HRM first`, vendorId: undefined }
  }
  // M-07 — endpoint-protocol isolation: an ADMS (ZKTeco /iclock) endpoint never
  // authenticates an ISAPI device and vice versa. A terminal registered for one
  // plane cannot be replayed against the other to dodge its comm-key rules.
  if (opts?.endpointProtocol) {
    const isIsapiDevice = device.protocol === "HIKVISION_ISAPI"
    const isIsapiEndpoint = opts.endpointProtocol === "ISAPI"
    if (isIsapiDevice !== isIsapiEndpoint) {
      return {
        ok: false, code: 403,
        reason: `Device ${sn} speaks the ${isIsapiDevice ? "ISAPI" : "ADMS"} protocol — it is not accepted on an ${isIsapiEndpoint ? "ISAPI" : "ADMS"} endpoint`,
        vendorId: device.vendorId,
      }
    }
  }
  if (!device.enabled) {
    return { ok: false, code: 403, reason: `Device ${sn} is disabled`, vendorId: device.vendorId }
  }
  // ---- C-03: comm-key verification (SCL-2: async scrypt + 5-min cache) ----
  const hasStoredKey = !!(device.commKeyHash || device.commKey)
  if (hasStoredKey) {
    if (!presentedKey || !(await verifyCommKeyAsync(presentedKey, device.commKeyHash, device.commKeySalt))) {
      return { ok: false, code: 401, reason: "Invalid or missing comm key for device " + sn, vendorId: device.vendorId }
    }
    return { ok: true, device: device as Device & Record<string, unknown> }
  }
  // Keyless device (no comm key enrolled): governed by the vendor admin
  // setting "Allow Keyless Devices" (Settings → Devices). Enabled → accepted
  // with a Sync-Monitor flag; Disabled → 401. The former 7-day grace window
  // and the lab-only ATTENDANCE_GATEWAY_ALLOW_OPEN override were removed —
  // this setting is the single control, and keyed devices above are
  // unaffected by it.
  const settings = await getSettings(device.vendorId)
  if (settings.devices.allowKeyless) {
    return { ok: true, device: device as Device & Record<string, unknown>, keyless: true }
  }
  return {
    ok: false, code: 401,
    reason: `Device ${sn} has no comm key enrolled and keyless devices are not allowed — enable "Allow Keyless Devices" in Settings → Devices or enroll a key via Devices → Set Comm Key`,
    vendorId: device.vendorId,
  }
}

// ---------- rate limiting — in-memory sliding window per IP + per SN (C-03) ----------
const rateBuckets = new Map<string, number[]>()

// C-03 — per-SN limiter: a single hijacked serial must not be able to hammer
// the ingest endpoints 300×/min (the per-IP cap). Independent bucket space so
// one abusive device never poisons an IP-shared fleet.
const snBuckets = new Map<string, number[]>()

function slidingLimited(buckets: Map<string, number[]>, key: string, limitPerMin: number): boolean {
  const now = Date.now()
  const arr = (buckets.get(key) || []).filter((t) => now - t < 60_000)
  if (arr.length >= limitPerMin) {
    buckets.set(key, arr)
    return true
  }
  arr.push(now)
  buckets.set(key, arr)
  // memory guard: evict the oldest half of the map (never a wholesale clear)
  if (buckets.size > 5000) {
    const it = buckets.keys()
    const toDrop = Math.floor(buckets.size / 2)
    let dropped = 0
    for (const k of it) {
      if (dropped++ >= toDrop) break
      buckets.delete(k)
    }
  }
  return false
}

/** C-03 — per-SN rate limit (default 60 req/min per serial). */
export function snRateLimited(sn: string): boolean {
  return slidingLimited(snBuckets, "sn:" + sn, GATEWAY_ENV.snRateLimitPerMin())
}

export function rateLimited(ip: string): boolean {
  return slidingLimited(rateBuckets, ip, GATEWAY_ENV.rateLimitPerMin())
}

// ---------- communication logging (metadata only, never secrets) ----------
// H-12 — sample DeviceCommLog rows for UNKNOWN devices: at most one row per
// (serial, endpoint) per minute, instead of one row per rejected request.
// An internet scanner hammering /iclock/* with random serials must not be able
// to fill the comm-log table (and its vendorId index) one row per request.
const unknownDeviceSample = new Map<string, number>()
// SCL-4 (Phase 2 WS2) — routine-success sampling for KNOWN devices: a fleet
// of terminals polls /iclock/getrequest + /iclock/cdata every 10–60 s, which
// used to write one comm-log row PER POLL (write amplification: 1,000 devices
// ≈ 1–2 rows/second forever, before the trim job even runs). Liveness is
// ALREADY tracked on AttendanceDevice.lastSeenAt; the comm-log row is pure
// diagnostics, so routine successes are sampled to one row per device per
// window (default 10 min; ADMS_COMMLOG_SAMPLE_MS=0 restores per-poll rows).
// Errors, rejections, command deliveries and data pushes are NEVER sampled —
// callers pass `sample` only on the routine-success path.
const routineSample = new Map<string, number>()
function routineSampleWindowMs(): number {
  const v = Number(process.env.ADMS_COMMLOG_SAMPLE_MS)
  return Number.isFinite(v) ? Math.max(0, v) : 600_000
}
function routineSampled(key: string): boolean {
  const w = routineSampleWindowMs()
  if (w <= 0) return false
  const last = routineSample.get(key) || 0
  if (Date.now() - last < w) return true
  routineSample.set(key, Date.now())
  // memory guard (bounded by fleet device count; sweep stale entries first)
  if (routineSample.size > 100_000) {
    const cutoff = Date.now() - w
    for (const [k, t] of routineSample) {
      if (t < cutoff) routineSample.delete(k)
      if (routineSample.size <= 50_000) break
    }
  }
  return false
}
export async function logComm(p: {
  vendorId: string
  deviceId?: string | null
  serial: string
  endpoint: string
  requestType: string
  httpStatus: number
  eventCount?: number
  duplicateCount?: number
  ok?: boolean
  durationMs?: number
  error?: string
  correlationId?: string
  ip?: string
  /** SCL-4 — sample this routine-success row to 1 per key per window
   *  (window from ADMS_COMMLOG_SAMPLE_MS, default 10 min). */
  sample?: { key: string }
}) {
  if (p.vendorId === "UNKNOWN") {
    const key = `${p.serial}|${p.endpoint}`
    const last = unknownDeviceSample.get(key) || 0
    if (Date.now() - last < 60_000) return // sampled — skip this row
    unknownDeviceSample.set(key, Date.now())
    // memory guard
    if (unknownDeviceSample.size > 5000) unknownDeviceSample.clear()
  } else if (p.sample && routineSampled(p.sample.key)) {
    return // sampled — liveness rides on AttendanceDevice.lastSeenAt
  }
  try {
    await db.deviceCommLog.create({
      data: {
        vendorId: p.vendorId,
        deviceId: p.deviceId || null,
        serial: p.serial,
        endpoint: p.endpoint,
        requestType: p.requestType,
        httpStatus: p.httpStatus,
        eventCount: p.eventCount || 0,
        duplicateCount: p.duplicateCount || 0,
        ok: p.ok ?? (p.httpStatus < 400),
        durationMs: p.durationMs || 0,
        error: p.error ? String(p.error).slice(0, 500) : null,
        correlationId: p.correlationId || null,
        ip: p.ip || null,
      },
    })
  } catch (e) {
    console.error("[zkteco] comm log failed", e)
  }
}

// ---------- handshake (GET /iclock/cdata) ----------
export async function handshake(device: any, params: Record<string, string>, ip?: string | null) {
  await db.attendanceDevice.update({
    where: { id: device.id },
    data: {
      lastSeenAt: new Date(),
      ipAddress: ip || params.ip || device.ipAddress || null,
      // PushVer can come in either case — normalise.
      pushVersion: params.pushver || params.PUSHVERSION || device.pushVersion || null,
      // firmware version is sometimes carried in the FW param
      firmwareVersion: params.FW || device.firmwareVersion || null,
      status: "ONLINE",
      lastError: null,
    },
  })
}

// ---------- per-device ADMS state (upload stamps + device roster) ----------
// Kept in AttendanceDevice.configuration (JSON, never returned to the UI) so
// no schema migration is needed.
export type AdmsDeviceState = {
  stamps?: { ATTLOG?: string; OPERLOG?: string; ATTPHOTO?: string }
  /** device-side user roster learned from USER/USERINFO pushes: PIN → info */
  roster?: Record<string, { name?: string | null; card?: string | null; seenAt: string }>
}

export function readAdmsState(device: { configuration?: unknown }): AdmsDeviceState & Record<string, unknown> {
  try {
    const v = typeof device.configuration === "string" ? JSON.parse(device.configuration || "{}") : device.configuration
    return v && typeof v === "object" ? (v as AdmsDeviceState & Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

async function writeAdmsState(deviceId: string, mutate: (st: AdmsDeviceState & Record<string, unknown>) => void) {
  const fresh = await db.attendanceDevice.findUnique({ where: { id: deviceId }, select: { configuration: true } })
  if (!fresh) return
  const st = readAdmsState(fresh)
  mutate(st)
  await db.attendanceDevice.update({ where: { id: deviceId }, data: { configuration: JSON.stringify(st) } }).catch(() => {})
}

/** Build the handshake options text the device reads. Per-spec layout — see
 *  adapter.handshakeResponse() for field semantics.
 *
 *  Upload watermark: while a historical sync window is ACTIVE the device is
 *  told ATTLOGStamp=0 → it re-uploads its ENTIRE stored attendance log
 *  (deduplicated server-side by payload hash). Otherwise the last stamp the
 *  device reported is echoed back so it only sends new records. */
export function buildHandshakeOptions(sn: string, device?: { configuration?: unknown; historySyncUntil?: Date | null } | null, opts?: { fullUpload?: boolean }): string {
  const st = device ? readAdmsState(device) : {}
  const historyActive = opts?.fullUpload ?? !!(device?.historySyncUntil && new Date(device.historySyncUntil).getTime() > Date.now())
  return buildHandshakeResponse(sn, {
    logDelaySec: GATEWAY_ENV.logDelaySec(),
    realtime: GATEWAY_ENV.realtime(),
    photoFun: GATEWAY_ENV.photoFun(),
    transInterval: GATEWAY_ENV.transInterval(),
    timeZone: GATEWAY_ENV.timeZone(),
    timeout: GATEWAY_ENV.timeout(),
    attlogStamp: historyActive ? "0" : st.stamps?.ATTLOG,
    operlogStamp: historyActive ? "0" : st.stamps?.OPERLOG,
    attphotoStamp: st.stamps?.ATTPHOTO,
  })
}

/** Handshake options for a live device. The full re-upload watermark
 *  (ATTLOGStamp=0) is handed out ONCE per historical-sync run — later
 *  handshakes inside the same window (every auto-CHECK re-handshakes) use
 *  the normal watermark, so the device does not re-send its whole log every
 *  two minutes for the rest of the window. */
export async function handshakeOptionsFor(sn: string, device: any): Promise<string> {
  const until = device?.historySyncUntil ? new Date(device.historySyncUntil) : null
  const active = !!(until && until.getTime() > Date.now())
  let fullUpload = false
  if (active) {
    const st = readAdmsState(device) as AdmsDeviceState & { historyFullUploadFor?: string }
    const runKey = until.toISOString()
    if (st.historyFullUploadFor !== runKey) {
      fullUpload = true
      await writeAdmsState(device.id, (s2) => { (s2 as Record<string, unknown>).historyFullUploadFor = runKey })
    }
  }
  return buildHandshakeOptions(sn, device, { fullUpload })
}

// ---------- event ingestion (POST /iclock/cdata) ----------
export type IngestResult = {
  accepted: number
  duplicates: number
  invalid: number
  operlog: number
  userinfo: number
  biodata: number
  /** C-4 — events rejected for timestamps outside the ingest freshness window */
  outOfWindow: number
  /** total record lines in the request (the ACK count — every line is either
   *  stored, a known duplicate, or deliberately dropped with evidence) */
  lines?: number
}

/** Durable, idempotent raw-event insert: `ON CONFLICT (payloadHash) DO
 *  NOTHING`. Returns true when the row is new, false for a known duplicate.
 *  (2026-10-07 — the old create() + catch(P2002) made Prisma log an error for
 *  every duplicate line, flooding the server log during historical
 *  re-uploads where most lines are already stored.)
 *  MOD-1 (Phase 1, this audit) — exported: the ISAPI receiver quarantines
 *  out-of-window Hikvision punches through the same helper so the two
 *  protocols share one durable-store contract. */
export async function storeRawEvent(data: Parameters<typeof db.attendanceRawEvent.create>[0]["data"]): Promise<boolean> {
  const res = await db.attendanceRawEvent.createMany({ data: [data as any], skipDuplicates: true })
  return res.count > 0
}

/** SCL-8 (Phase 2 WS2) — batched raw-event storage. The ingest path used to
 *  INSERT one row per ATTLOG line (a 20K-line historical re-upload = 20K
 *  sequential round-trips). Buffering lines and flushing them in chunks of
 *  ATTLOG_STORE_CHUNK cuts that to ⌈N/500⌉ round-trips with EXACTLY the same
 *  semantics: skipDuplicates swallows the unique(payloadHash) device-retry
 *  race (the old per-row .catch(P2002)), same-hash lines within one request
 *  dedupe to first-store + duplicates, and every chunk is classified
 *  per-hash via a pre-insert payloadHash probe so accepted/duplicate
 *  counters stay exact. */
export const ATTLOG_STORE_CHUNK = 500
export type RawEventInsert = Parameters<typeof db.attendanceRawEvent.create>[0]["data"]
export async function storeRawEventBatch(
  events: RawEventInsert[],
): Promise<{ acceptedHashes: Set<string>; duplicateHashes: Set<string>; failed: number }> {
  const acceptedHashes = new Set<string>()
  const duplicateHashes = new Set<string>()
  let failed = 0
  // dedup within the batch: two identical lines in one request produce the
  // same fingerprint — the first stores, the rest are duplicates (the old
  // per-row loop classified them via P2002 on the second insert)
  const seenInBatch = new Set<string>()
  const deduped: RawEventInsert[] = []
  for (const ev of events) {
    const h = String(ev.payloadHash)
    if (seenInBatch.has(h)) { duplicateHashes.add(h); continue }
    seenInBatch.add(h)
    deduped.push(ev)
  }
  for (let i = 0; i < deduped.length; i += ATTLOG_STORE_CHUNK) {
    const chunk = deduped.slice(i, i + ATTLOG_STORE_CHUNK)
    const chunkHashes = chunk.map((ev) => String(ev.payloadHash))
    // pre-check: which hashes already exist? (one indexed query per chunk —
    // a post-hoc probe cannot tell "already stored" from "just stored by
    // this createMany", so classification happens BEFORE the insert)
    const existing = await db.attendanceRawEvent.findMany({
      where: { payloadHash: { in: chunkHashes } },
      select: { payloadHash: true },
    }).catch(() => null)
    if (existing == null) {
      // pre-check itself failed — still attempt the insert; classification
      // falls back to the createMany count (bulk-accurate, not per-hash)
      try {
        const res = await db.attendanceRawEvent.createMany({ data: chunk as any[], skipDuplicates: true })
        for (let k = 0; k < res.count; k++) acceptedHashes.add(chunkHashes[k] || `partial-${i}-${k}`)
        failed += chunk.length - res.count
      } catch (e: any) {
        console.error("[zkteco] raw store batch failed", e)
        failed += chunk.length
      }
      continue
    }
    const existingSet = new Set(existing.map((r) => r.payloadHash))
    for (const h of existingSet) duplicateHashes.add(h)
    const candidates = chunk.filter((ev) => !existingSet.has(String(ev.payloadHash)))
    if (!candidates.length) continue
    try {
      const res = await db.attendanceRawEvent.createMany({ data: candidates as any[], skipDuplicates: true })
      if (res.count === candidates.length) {
        for (const ev of candidates) acceptedHashes.add(String(ev.payloadHash))
      } else {
        // rare: a concurrent writer claimed some candidates between the
        // pre-check and the insert — post-check to classify exactly
        const post = await db.attendanceRawEvent.findMany({
          where: { payloadHash: { in: candidates.map((ev) => String(ev.payloadHash)) } },
          select: { payloadHash: true },
        }).catch(() => [] as { payloadHash: string }[])
        const postSet = new Set(post.map((r) => r.payloadHash))
        for (const ev of candidates) {
          const h = String(ev.payloadHash)
          if (postSet.has(h)) acceptedHashes.add(h) // stored — by us or raced, same durable outcome
          else { duplicateHashes.add(h); failed++ }
        }
      }
    } catch (e: any) {
      console.error("[zkteco] raw store batch failed", e)
      failed += candidates.length
    }
  }
  return { acceptedHashes, duplicateHashes, failed }
}

/** H-12 — hard cap on parsed lines per request. 2026-10-07: raised from 500
 *  — ZKTeco firmware uploads its stored log in batches of up to several
 *  thousand lines during a historical re-upload; a 500-line cap threw, the
 *  route answered 500, and the device re-sent the SAME batch forever (the
 *  history never got past the first batch). The byte cap (BODY_CAP_CDATA)
 *  still bounds memory before the body is read. */
export const MAX_CDATA_LINES = 20_000

export async function ingestLines(
  device: any, body: string, ip?: string | null,
  opts?: { table?: string | null; stamp?: string | null },
): Promise<IngestResult> {
  const serial = device.deviceIdentifier as string
  const lines = body.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  const result: IngestResult = { accepted: 0, duplicates: 0, invalid: 0, operlog: 0, userinfo: 0, biodata: 0, outOfWindow: 0 }
  const table = (opts?.table || "").trim().toUpperCase() || null
  if (lines.length > MAX_CDATA_LINES) {
    await logComm({
      vendorId: device.vendorId, deviceId: device.id, serial,
      endpoint: "/iclock/cdata", requestType: "ATTLOG", httpStatus: 413, ok: false,
      error: `LINE_LIMIT_EXCEEDED: ${lines.length} lines in one request (max ${MAX_CDATA_LINES})`, ip: ip || undefined,
    })
    throw Object.assign(new Error(`Too many lines in one request (${lines.length}, max ${MAX_CDATA_LINES})`), { code: 413 })
  }
  result.lines = lines.length
  const rosterSeen: { pin: string; name: string | null; card: string | null }[] = []
  // C-4/H-3 — the freshness window is evaluated in the DEVICE's timezone frame
  // (its stamps are local wall-clock; Asia/Dhaka = UTC+6 by default) via the
  // shared deviceFrameNow() helper in adapter.ts — the same helper the ISAPI
  // receiver uses, so the two frames cannot diverge again.
  const frameNow = deviceFrameNow(GATEWAY_ENV.timeZone())
  // R8 — historical backfill: while a devices.syncHistory window is ACTIVE for
  // this device (historySyncUntil in the future), the freshness lookback is
  // widened to the configured historySyncWindowDays so punches re-uploaded
  // from the device's local storage (which can be weeks or months old) are
  // accepted instead of rejected as OUT_OF_WINDOW. Normal push traffic between
  // backfills keeps the default narrow window.
  const historyActive = !!(device.historySyncUntil && new Date(device.historySyncUntil).getTime() > Date.now())
  const ingestWindowDays = historyActive
    ? Math.max(GATEWAY_ENV.ingestWindowDays(), Number(device.historySyncWindowDays) || GATEWAY_ENV.ingestWindowDays())
    : GATEWAY_ENV.ingestWindowDays()

  let lastEventTime: string | null = null
  let invalidLogged = false
  // SCL-8 — buffered storage: in-window and quarantined events accumulate
  // here and flush in batched createMany chunks AFTER the line loop (one
  // round-trip per 500 lines instead of one per line).
  const pendingFresh: { ev: RawEventInsert; eventTime: string; hash: string }[] = []
  const pendingOow: RawEventInsert[] = []
  const pendingDiagRows: Parameters<typeof db.deviceCommLog.create>[0]["data"][] = []
  for (const line of lines) {
    const kind = classifyLine(line, table)
    if (kind === "OPERLOG") {
      // Operational logs are counted (and could be persisted in a dedicated
      // audit table); they are NOT attendance events.
      const parsed = parseOperlogLine(line)
      // 2026-10-07 — at most 20 diagnostic rows per request: an OPERLOG
      // backfill carries the device's whole operation history (one push from
      // the test terminal held 1,055 lines → 1,055 comm-log rows); the
      // per-request summary row still carries the total.
      if (parsed && result.operlog < 20) {
        // Persist the OPERLOG as a device_comm_log side-channel entry so admins
        // can see the device's operational activity even when no punches fire.
        // (SCL-8 — buffered, flushed as one createMany after the loop.)
        pendingDiagRows.push({
          vendorId: device.vendorId,
          deviceId: device.id,
          serial,
          endpoint: "/iclock/cdata",
          requestType: "OPERLOG",
          httpStatus: 200,
          ok: true,
          // L-14 — redacted diagnostic slice (no employee names)
          error: parsed.label + " | " + diagLine(parsed.rawLine, 400),
          ip: ip || null,
        })
      }
      result.operlog++
      continue
    }
    if (kind === "USERINFO") {
      // Device-side user roster push — store the latest snapshot for each PIN
      // so admins can map device users → employees. We persist the raw line in
      // the comm log so it survives reboots without a dedicated table.
      const parsed = parseUserInfoLine(line)
      if (parsed) rosterSeen.push({ pin: parsed.pin, name: parsed.name, card: parsed.card })
      // the roster itself is stored in the device state (below); diagnostic
      // rows are capped per request so a 3,000-user terminal cannot flood
      // the comm log
      if (parsed && result.userinfo < 50) {
        // (SCL-8 — buffered, flushed as one createMany after the loop.)
        pendingDiagRows.push({
          vendorId: device.vendorId,
          deviceId: device.id,
          serial,
          endpoint: "/iclock/cdata",
          requestType: "USERINFO",
          httpStatus: 200,
          ok: true,
          // L-14 — the employee NAME is redacted (devices.view operators can
          // read comm logs; names are PII). PIN stays — it is the operator's
          // key for mapping device users to employees.
          error: `PIN=${parsed.pin} Name=${parsed.name ? (deviceDebugCapture() ? parsed.name : "REDACTED") : "—"} | ${diagLine(parsed.rawLine, 300)}`,
          ip: ip || null,
        })
      }
      result.userinfo++
      continue
    }
    if (kind === "BIODATA" || kind === "OPTIONS") {
      result.biodata++
      continue
    }
    if (kind !== "ATTLOG") {
      result.invalid++
      continue
    }

    const parsed = parseAttLogLine(line)
    if (!parsed) {
      result.invalid++
      // N-4 — a parse failure must never be silent again: an unknown firmware
      // field order silently dropped 100% of a device's punches while the
      // server kept ACKing 200 OK. Persist a redacted diagnostic row (first
      // unparseable line only, to cap comm-log growth) so the Sync Monitor can
      // surface the format mismatch immediately.
      if (!invalidLogged) {
        invalidLogged = true
        await logComm({
          vendorId: device.vendorId, deviceId: device.id, serial,
          endpoint: "/iclock/cdata", requestType: "ATTLOG", httpStatus: 200, ok: false,
          error: `PARSE_FAILED: unrecognized ATTLOG line format | ${diagLine(line, 200)}`,
          ip: ip || undefined,
        })
      }
      continue
    }
    // C-4 — freshness window: device timestamps are untrusted input. Events
    // outside [now - windowDays, now + 5min] are quarantined, NOT dropped:
    //
    // 2026-10 historical-sync root cause — the old code rejected
    // out-of-window ATTLOG lines but still ACKed them, so the device marked
    // those records DELIVERED and purged them from its local storage. When an
    // admin later ran a historical sync, CHECK could not re-upload
    // already-ACKed records and older firmware ignores DATA QUERY — the
    // history was permanently lost on BOTH sides. Out-of-window punches are
    // therefore STORED DURABLY with processingStatus OUT_OF_WINDOW (bounded
    // by the maximum supported sync lookback of 10 years; far-future stamps —
    // broken clocks — are rejected outright), and re-processed the moment a
    // widened history-sync window covers them (devices.syncHistory requeues
    // them; the sweeper picks up any that arrive during an active window).
    if (!eventWithinWindow(parsed.eventTime, frameNow, ingestWindowDays, 5)) {
      const evMs = new Date(parsed.eventTime.replace(" ", "T") + "Z").getTime()
      const withinMaxBackfill = Number.isFinite(evMs)
        && evMs >= frameNow.getTime() - 3650 * 86_400_000 // max supported sync range (10y)
        && evMs <= frameNow.getTime() + 5 * 60_000 // garbage far-future clocks are NOT stored
      result.outOfWindow++
      // one diagnostic row per request (a historical batch can carry
      // thousands of old punches — one row each flooded the comm log and
      // evicted every other diagnostic); the total rides on the summary row
      if (result.outOfWindow === 1) await logComm({
        vendorId: device.vendorId, deviceId: device.id, serial,
        endpoint: "/iclock/cdata", requestType: "ATTLOG", httpStatus: 200, ok: !withinMaxBackfill,
        // L-14 — redacted raw slice (ATTLOG carries no names, but the same
        // redaction path guards every diagnostic field by default)
        error: `OUT_OF_WINDOW: eventTime=${parsed.eventTime} (window: ${ingestWindowDays}d back, +5min ahead${historyActive ? " — HISTORY SYNC ACTIVE" : ""})${withinMaxBackfill ? " — STORED for later processing (historical sync can recover it)" : " — NOT stored (outside the 10-year backfill bound)"} | ${diagLine(parsed.rawLine, 200)}`,
        ip: ip || undefined,
      })
      if (!withinMaxBackfill) continue
      const fpOow = fingerprint(serial, parsed)
      pendingOow.push({
        vendorId: device.vendorId,
        deviceId: device.id,
        deviceSerial: serial,
        deviceUserId: parsed.deviceUserId,
        eventTime: parsed.eventTime,
        verifyMode: parsed.verifyMode,
        attendanceStatus: parsed.attendanceStatus,
        workCode: parsed.workCode,
        eventType: parsed.eventType,
        rawLine: parsed.rawLine.slice(0, 1000),
        payloadHash: fpOow,
        processingStatus: "OUT_OF_WINDOW",
        processingError: `OUT_OF_WINDOW: outside the ${ingestWindowDays}d ingest window — awaiting historical-sync reprocessing`,
      })
      continue
    }
    const fp = fingerprint(serial, parsed)
    pendingFresh.push({
      ev: {
        vendorId: device.vendorId,
        deviceId: device.id,
        deviceSerial: serial,
        deviceUserId: parsed.deviceUserId,
        eventTime: parsed.eventTime,
        verifyMode: parsed.verifyMode,
        attendanceStatus: parsed.attendanceStatus,
        workCode: parsed.workCode,
        eventType: parsed.eventType,
        rawLine: parsed.rawLine.slice(0, 1000),
        payloadHash: fp,
        processingStatus: "RECEIVED",
      },
      eventTime: parsed.eventTime,
      hash: fp,
    })
  }

  // SCL-8 — flush the buffered events in batched chunks. Accepted/duplicate
  // classification is exact (storeRawEventBatch probes payloadHash on partial
  // inserts), and lastEventTime only advances over NEWLY-stored events — the
  // same semantics the per-line loop had.
  if (pendingFresh.length) {
    const flush = await storeRawEventBatch(pendingFresh.map((p) => p.ev))
    for (const p of pendingFresh) {
      if (flush.acceptedHashes.has(p.hash)) {
        result.accepted++
        if (!lastEventTime || p.eventTime > lastEventTime) lastEventTime = p.eventTime
      } else if (flush.duplicateHashes.has(p.hash)) {
        // device retry / historical re-upload of an event we already durably
        // stored: acknowledge it, never double-insert
        result.duplicates++
      } else {
        result.invalid++
      }
    }
  }
  if (pendingOow.length) {
    const flushOow = await storeRawEventBatch(pendingOow)
    result.accepted += flushOow.acceptedHashes.size
    result.duplicates += flushOow.duplicateHashes.size
    result.invalid += flushOow.failed
  }
  // SCL-8 — diagnostic comm-log rows (OPERLOG/USERINFO samples) flush as one
  // createMany instead of ≤70 individual inserts per request.
  if (pendingDiagRows.length) {
    for (let i = 0; i < pendingDiagRows.length; i += 500) {
      await db.deviceCommLog.createMany({ data: pendingDiagRows.slice(i, i + 500) as any[] }).catch(() => {})
    }
  }

  // Device roster (USER lines) — remember PIN → name for the mapping UI and
  // auto-map every PIN whose Employee ID matches an HRM employee code.
  if (rosterSeen.length) {
    const now = new Date().toISOString()
    await writeAdmsState(device.id, (st) => {
      st.roster = st.roster || {}
      for (const u of rosterSeen) st.roster[u.pin] = { name: u.name, card: u.card, seenAt: now }
      // bound the JSON blob (largest ZKTeco terminals hold ~10k users)
      const keys = Object.keys(st.roster)
      if (keys.length > 20_000) for (const k of keys.slice(0, keys.length - 20_000)) delete st.roster[k]
    })
    for (const u of rosterSeen) {
      try { await autoMapDeviceUser(device.vendorId, device.id, u.pin) } catch { /* mapping is best-effort */ }
    }
  }

  // Upload watermark — the device sends `Stamp=` with each table push; echo
  // it back on the next handshake so it only uploads newer records.
  const stamp = (opts?.stamp || "").trim()
  if (table && stamp && /^[0-9A-Za-z]{1,20}$/.test(stamp) && ["ATTLOG", "OPERLOG", "ATTPHOTO"].includes(table)) {
    await writeAdmsState(device.id, (st) => {
      st.stamps = st.stamps || {}
      ;(st.stamps as Record<string, string>)[table] = stamp
    })
  }

  // DURABLE → now process (fast path). Failures go to the retry queue and are
  // NEVER allowed to fail the device ACK (raw data is already safe).
  // 2026-10-07 — large (historical) batches skip the inline fast path: the
  // ACK must reach the device before its HTTP timeout, and rebuilding
  // thousands of attendance days inline made the request outlive it (the
  // device then re-sent the batch). The sweeper (15 s cadence, 1000 events
  // per pass) processes them; small live pushes keep the instant path.
  // MOD-2 (Phase 1, this audit) — the claim loop lives in the shared
  // processFreshInline() helper so the ISAPI receiver claims identically.
  await processFreshInline(device.id, { maxInline: 200, batchSize: 500 })

  // device status bookkeeping
  const now = new Date()
  // C-4 — drift measured in the device's configured timezone frame, not UTC
  const tzHours = GATEWAY_ENV.timeZone()
  const driftSample = lastEventTime && Math.abs(clockDriftSec(lastEventTime, now, tzHours)) < 300 ? clockDriftSec(lastEventTime, now, tzHours) : null
  await db.attendanceDevice.update({
    where: { id: device.id },
    data: {
      lastSeenAt: now,
      lastAttendanceAt: lastEventTime ? new Date(lastEventTime.replace(" ", "T") + "Z") : device.lastAttendanceAt,
      // M-07 — atomic increment: a read-modify-write loses updates when a
      // device pushes overlapping batches
      eventCount: { increment: result.accepted },
      status: "ONLINE",
      ...(driftSample != null ? { clockDriftSec: driftSample } : {}),
      ...(ip ? { ipAddress: ip } : {}),
    },
  }).catch(() => {})

  return result
}

// ---------- MOD-2 (Phase 1): the SHARED atomic claim loop ----------
// Both device protocols (ZKTeco /iclock and Hikvision ISAPI) process durable
// raw events through exactly this sequence:
//   findMany(RECEIVED, oldest first, take N) → conditional
//   updateMany(id, RECEIVED→PROCESSING) → mapAndProcessEvent
// The conditional updateMany is the atomic claim: a concurrent sweeper pass
// (or a second concurrent HTTP push for the same device) loses the race and
// skips the row — the same row can never be processed twice. The ISAPI
// receiver previously processed its fresh rows WITHOUT the claim (a plain
// findMany + loop), which let two overlapping ISAPI POSTs double-process the
// same events; it now calls this helper like the ZKTeco path.
export type InlineProcessResult = {
  claimed: number
  unknown: number
  failed: number
}

export async function processFreshInline(
  deviceId: string,
  opts: { maxInline?: number; batchSize?: number } = {},
): Promise<InlineProcessResult> {
  const maxInline = opts.maxInline ?? 200
  const batchSize = opts.batchSize ?? 500
  const out: InlineProcessResult = { claimed: 0, unknown: 0, failed: 0 }
  const fresh = await db.attendanceRawEvent.findMany({
    where: { deviceId, processingStatus: "RECEIVED" },
    orderBy: { eventTime: "asc" },
    take: Math.max(batchSize, maxInline + 1),
  })
  let processedInline = 0
  for (const ev of fresh) {
    if (processedInline >= maxInline) break // large batches: leave the rest to the sweeper
    const claim = await db.attendanceRawEvent.updateMany({
      where: { id: ev.id, processingStatus: "RECEIVED" },
      data: { processingStatus: "PROCESSING", claimedAt: new Date(), lastAttemptAt: new Date() },
    })
    if (claim.count === 0) continue // swept concurrently — the sweeper owns it
    processedInline++
    out.claimed++
    const res = await mapAndProcessEvent(ev as any)
    if (res === "UNKNOWN_EMPLOYEE") out.unknown++
    else if (res === "FAILED") out.failed++
  }
  return out
}

// ---------- SEC-4 (Phase 1): trust-gated client IP for the device plane ----------
// X-Forwarded-For is CLIENT-SPOOFABLE. Every /iclock/* route used to read it
// unconditionally for rate-limit keys and comm-log rows, so a direct-connection
// attacker could mint a fresh rate bucket per request (defeating the per-IP
// limiter — the per-SN limiter was the only real protection) and could pollute
// audit rows with arbitrary fake IPs. This helper mirrors the H-7 resolver in
// security.ts and the already-hardened ISAPI route: XFF is honored ONLY when
// the deployment declares a trusted proxy (HRM_TRUST_PROXY=1). Without the
// flag the caller falls back to x-real-ip (set by the local proxy) or
// "unknown" — honest values that cannot be rotated by the client.
export function deviceClientIp(req: { headers?: { get?: (name: string) => string | null } }): string {
  if (process.env.HRM_TRUST_PROXY === "1") {
    const xff = (req.headers?.get?.("x-forwarded-for") || "").split(",")[0].trim()
    if (xff) return xff
  }
  return req.headers?.get?.("x-real-ip") || "unknown"
}

// ---------- command channel (getrequest / devicecmd) ----------
export async function takeCommand(device: any): Promise<string | null> {
  const entry = await takeCommandEntry(device)
  return entry ? entry.command : null
}

/** Same atomic claim as takeCommand, returning the row id too — the
 *  getrequest route needs it to build the `C:<id>:<cmd>` wire line. */
export async function takeCommandEntry(device: any): Promise<{ id: string; command: string } | null> {
  // M-07 — atomic claim: findFirst → conditional updateMany (id AND QUEUED →
  // SENT). Two overlapping device polls can never both deliver the same
  // command; a lost race retries the next command on the device's next poll.
  for (let attempt = 0; attempt < 5; attempt++) {
    const cmd = await db.deviceCommand.findFirst({
      where: { deviceId: device.id, status: "QUEUED" },
      orderBy: { createdAt: "asc" },
    })
    if (!cmd) return null
    const claim = await db.deviceCommand.updateMany({
      where: { id: cmd.id, status: "QUEUED" },
      data: { status: "SENT", sentAt: new Date() },
    })
    if (claim.count > 0) return { id: cmd.id, command: cmd.command }
  }
  return null
}

/** Server → device user roster (DATA UPDATE USERINFO payload).
 *  ADMS USERINFO rows for every ACTIVE mapping on this device: PIN (stable
 *  per employee), Name, default group/timezone flags. Names are trimmed to
 *  the firmware-safe ASCII subset; biometrics are NEVER synced. Each row is
 *  sent as its own `C:<id>:DATA UPDATE USERINFO PIN=…` command line. */
export async function userInfoRows(vendorId: string, deviceId: string): Promise<string[]> {
  const mappings = await db.attendanceDeviceUser.findMany({
    where: { vendorId, deviceId, enrollmentStatus: "ACTIVE" },
    orderBy: { deviceUserId: "asc" },
  })
  if (!mappings.length) return []
  const employees = await db.employee.findMany({
    where: { vendorId, id: { in: mappings.map((m) => m.employeeId) } },
    select: { id: true, fullName: true },
  })
  const nameOf = new Map(employees.map((e) => [e.id, e.fullName]))
  return mappings.map((m) => {
    const name = (nameOf.get(m.employeeId) || "Employee")
      .replace(/[^\x20-\x7E]/g, "") // firmware-safe ASCII
      .replace(/[\t\r\n]/g, " ")
      .trim()
      .slice(0, 24) || "Employee"
    return `PIN=${m.deviceUserId}\tName=${name}\tPri=0\tPasswd=\tCard=\tGrp=1\tTZ=0000000000000000\tVerify=0`
  })
}

export async function recordCommandResult(device: any, body: string) {
  // 2026-10-07 — results carry the wire id (`ID=<id>&Return=<code>&CMD=…`).
  // Match each to its SENT command so a failed command shows FAILED with the
  // firmware's return code instead of blindly closing the newest SENT row.
  const results = parseCommandResults(body)
  const sentRows = await db.deviceCommand.findMany({
    where: { deviceId: device.id, status: "SENT" },
    orderBy: { sentAt: "desc" },
    take: 50,
  })
  let matched: (typeof sentRows)[number] | null = null
  const closed = new Set<string>()
  for (const r of results) {
    const row = sentRows.find((c) => !closed.has(c.id) && r.id.startsWith(admsCommandId(c.id)))
    if (!row) continue
    closed.add(row.id)
    // multi-line commands (roster push) report once per line — the row is
    // DONE unless any line reported a negative return code
    const lineResults = results.filter((x) => x.id.startsWith(admsCommandId(row.id)))
    const failed = lineResults.some((x) => x.ret != null && x.ret < 0)
    await db.deviceCommand.update({
      where: { id: row.id },
      data: { status: failed ? "FAILED" : "DONE", doneAt: new Date(), result: body.slice(0, 2000) },
    })
    matched = matched || row
  }
  if (!matched && !results.length) {
    // legacy firmware posting a bare "OK" — close the most recent SENT row
    const sent = sentRows[0]
    if (sent) {
      await db.deviceCommand.update({
        where: { id: sent.id },
        data: { status: "DONE", doneAt: new Date(), result: body.slice(0, 2000) },
      })
      matched = sent
    }
  }
  await db.attendanceDevice.update({ where: { id: device.id }, data: { lastSeenAt: new Date(), status: "ONLINE" } }).catch(() => {})
  return matched
}

// ---------- device params push (POST /iclock/deviceparams) ----------
export async function recordDeviceParams(device: any, body: string) {
  // Store the params snapshot in the comm log so admins can inspect what the
  // device is currently configured with. (We don't trust it server-side —
  // server settings live in AttendanceDevice.configuration.)
  await db.deviceCommLog.create({
    data: {
      vendorId: device.vendorId,
      deviceId: device.id,
      serial: device.deviceIdentifier,
      endpoint: "/iclock/deviceparams",
      requestType: "DEVICEPARAMS",
      httpStatus: 200,
      ok: true,
      error: body.slice(0, 500) || null,
    },
  }).catch(() => {})
  await db.attendanceDevice.update({
    where: { id: device.id },
    data: { lastSeenAt: new Date(), status: "ONLINE" },
  }).catch(() => {})
}

// ---------- punch photo upload (POST /iclock/cdatapic) ----------
export async function recordPunchPhoto(device: any, pin: string, stime: string, body: Buffer) {
  // Store a metadata record; the photo bytes themselves are persisted to disk
  // (under <repo>/storage/punch-photos/) so the DB stays small.
  // For now we just log the upload event — full photo persistence is opt-in
  // via ADMS_PHOTO_FUN=true.
  await db.deviceCommLog.create({
    data: {
      vendorId: device.vendorId,
      deviceId: device.id,
      serial: device.deviceIdentifier,
      endpoint: "/iclock/cdatapic",
      requestType: "ATTPHOTO",
      httpStatus: 200,
      ok: true,
      eventCount: 1,
      error: `PIN=${pin} STIME=${stime} bytes=${body.length}`,
    },
  }).catch(() => {})
}

// ---------- derived device status (configurable thresholds, not hardcoded) ----------
export function derivedStatus(d: { enabled: boolean; lastSeenAt?: Date | null }): "ONLINE" | "WARNING" | "OFFLINE" | "DISABLED" {
  if (!d.enabled) return "DISABLED"
  if (!d.lastSeenAt) return "OFFLINE"
  const ageSec = (Date.now() - new Date(d.lastSeenAt).getTime()) / 1000
  if (ageSec < GATEWAY_ENV.warningThresholdSec()) return "ONLINE"
  if (ageSec < GATEWAY_ENV.offlineThresholdSec()) return "WARNING"
  return "OFFLINE"
}

// ---------- automatic attendance pull (auto-CHECK loop) ----------
// Devices that support Realtime pushes send each punch the moment it happens,
// but many units (or firmwares) only upload when the SERVER asks. This loop
// queues an ADMS "CHECK" (= "upload all unsent records") command for every
// enabled device that is actively connected (fresh lastSeenAt). The device
// consumes the command on its next /iclock/getrequest poll (LOGDELAY, 60s by
// default) and POSTs its log — so a punch reaches the attendance table within
// roughly autoCheckSec + LOGDELAY seconds, without anyone clicking anything.
let autoChecking = false
export async function autoCheckOnce(): Promise<{ queued: number; considered: number; disabled: number }> {
  const intervalSec = GATEWAY_ENV.autoCheckSec()
  if (intervalSec <= 0) return { queued: 0, considered: 0, disabled: 1 }
  if (autoChecking) return { queued: 0, considered: 0, disabled: 0 }
  autoChecking = true
  try {
    // A device counts as "actively connected" when it was seen within the last
    // 5 minutes (handshake, ATTLOG push or getrequest poll all stamp lastSeenAt).
    const freshSeen = new Date(Date.now() - 5 * 60_000)
    const devices = await db.attendanceDevice.findMany({
      where: { enabled: true, lastSeenAt: { gte: freshSeen } },
      select: { id: true, vendorId: true, name: true },
    })
    let queued = 0
    for (const d of devices) {
      // never stack commands: skip when a CHECK is already waiting
      const pending = await db.deviceCommand.findFirst({
        where: { deviceId: d.id, status: "QUEUED", command: { startsWith: "CHECK" } },
      })
      if (pending) continue
      // rate-limit per device: only re-ask after the configured interval
      const lastCheck = await db.deviceCommand.findFirst({
        where: { deviceId: d.id, command: { startsWith: "CHECK" }, createdBy: "auto-sync" },
        orderBy: { createdAt: "desc" },
      })
      if (lastCheck && Date.now() - lastCheck.createdAt.getTime() < intervalSec * 1000) continue
      await db.deviceCommand.create({
        data: { vendorId: d.vendorId, deviceId: d.id, command: "CHECK", createdBy: "auto-sync" },
      })
      queued++
    }
    return { queued, considered: devices.length, disabled: 0 }
  } finally {
    autoChecking = false
  }
}

// ---------- sweep: retry queue + recovery ----------
let sweeping = false

/** M-07 — crash recovery: a PROCESSING claim older than the TTL means the
 *  claimer died mid-event. Loop it back to RECEIVED so the next sweep picks
 *  it up (processing itself is idempotent — days are rebuilt from the full
 *  event set). */
async function recoverStaleClaims(): Promise<number> {
  const staleBefore = new Date(Date.now() - 5 * 60_000)
  const res = await db.attendanceRawEvent.updateMany({
    where: { processingStatus: "PROCESSING", OR: [{ claimedAt: { lt: staleBefore } }, { claimedAt: null }] },
    data: { processingStatus: "RECEIVED" },
  }).catch(() => ({ count: 0 }) as { count: number })
  return res.count
}

// ---------- SCL-3 full (Phase 2 WS2): fair per-vendor sweeper paging ----------
// The old page was a FLAT take:1000 ordered by eventTime — one tenant's
// 20K-line historical backfill (old events sort FIRST) occupied the entire
// page every 15 s pass and every other tenant's punches starved behind it.
// Fairness now comes from two pieces:
//   1. pendingVendorPage() — recursive skip-scan (the classic PG loose-index-
//      scan emulation) over DISTINCT vendorId having pending rows, behind a
//      round-robin cursor on globalThis: O(pageSize) index seeks, and each
//      pass serves a DIFFERENT slice of the vendor id space.
//   2. per-vendor slices — the 1000-event-per-pass budget is split evenly
//      across the discovered vendors (min 20), so every vendor with pending
//      work advances on every pass.
const FAIR_VENDORS_PER_PASS = 50
const SWEEP_EVENTS_PER_PASS = 1000
const SWEEP_CURSOR_KEY = Symbol.for("finix.zkteco.sweepVendorCursor")

async function pendingVendorPage(limit: number, vendorFilter?: string): Promise<string[]> {
  if (vendorFilter) return [vendorFilter]
  const g = globalThis as unknown as Record<symbol, string | undefined>
  const cursor = g[SWEEP_CURSOR_KEY] || ""
  const rows = await db.$queryRaw<Array<{ vendorId: string | null }>>`
    WITH RECURSIVE t AS (
      (SELECT "vendorId" FROM "AttendanceRawEvent"
       WHERE "processingStatus" IN ('RECEIVED','FAILED') AND "vendorId" > ${cursor}
       ORDER BY "vendorId" LIMIT 1)
      UNION ALL
      SELECT (
        SELECT e."vendorId" FROM "AttendanceRawEvent" e
        WHERE e."processingStatus" IN ('RECEIVED','FAILED') AND e."vendorId" > t."vendorId"
        ORDER BY e."vendorId" LIMIT 1
      ) FROM t WHERE t."vendorId" IS NOT NULL
    )
    SELECT "vendorId" FROM t WHERE "vendorId" IS NOT NULL LIMIT ${limit}`
  const vendors = rows.map((r) => r.vendorId).filter((v): v is string => v != null)
  // wrap the cursor when the tail is exhausted so the next pass re-scans
  // from the head (new backfills become visible)
  g[SWEEP_CURSOR_KEY] = vendors.length >= limit ? vendors[vendors.length - 1] : ""
  return vendors
}

/** Test hook — reset the fair-sweep round-robin cursor. */
export function _resetSweepCursorForTests(): void {
  const g = globalThis as unknown as Record<symbol, string | undefined>
  g[SWEEP_CURSOR_KEY] = ""
}

export async function sweepOnce(vendorId?: string): Promise<{ processed: number; failed: number }> {
  if (sweeping) return { processed: 0, failed: 0 }
  sweeping = true
  try {
    await recoverStaleClaims()
    // 2026-10 historical-sync root cause fix — OUT_OF_WINDOW quarantined
    // events become eligible the moment their device has an ACTIVE widened
    // history-sync window (devices.syncHistory). They are flipped back to
    // RECEIVED so the normal claim/process path below handles them exactly
    // like fresh pushes (dedup by payload hash already protected the store).
    try {
      const activeSyncDevices = await db.attendanceDevice.findMany({
        where: { historySyncUntil: { gt: new Date() } },
        select: { id: true },
      })
      if (activeSyncDevices.length) {
        await db.attendanceRawEvent.updateMany({
          where: {
            processingStatus: "OUT_OF_WINDOW",
            deviceId: { in: activeSyncDevices.map((d) => d.id) },
            ...(vendorId ? { vendorId } : {}),
          },
          data: { processingStatus: "RECEIVED", processingError: null },
        })
      }
    } catch { /* non-fatal — the sync-start requeue path also covers this */ }
    // SCL-3 full — fair per-vendor paging (see pendingVendorPage). The
    // per-pass event budget is unchanged (1000) but now split across
    // vendors; the explicit vendorId path (manual per-vendor sweep) keeps
    // the whole budget.
    const fairVendors = await pendingVendorPage(FAIR_VENDORS_PER_PASS, vendorId).catch(() => vendorId ? [vendorId] : [] as string[])
    let processed = 0, failed = 0
    if (fairVendors.length) {
      const perVendor = vendorId
        ? SWEEP_EVENTS_PER_PASS
        : Math.max(20, Math.ceil(SWEEP_EVENTS_PER_PASS / fairVendors.length))
      for (const v of fairVendors) {
        // M-07 — DEAD_LETTER is terminal: dead events are never re-swept.
        const pending = await db.attendanceRawEvent.findMany({
          where: { vendorId: v, processingStatus: { in: ["RECEIVED", "FAILED"] } },
          orderBy: { eventTime: "asc" },
          take: perVendor,
        }).catch(() => [])
        for (const ev of pending) {
          // exponential backoff for FAILED retries: 15s · 2^n, capped at 15 min,
          // measured from lastAttemptAt (M-7) — NOT createdAt: an event that has
          // been failing for an hour must not wait a full extra hour between tries
          if (ev.processingStatus === "FAILED" && ev.retryCount > 0) {
            const backoffMs = Math.min(15_000 * 2 ** (ev.retryCount - 1), 900_000)
            const lastTouch = (ev.lastAttemptAt || ev.createdAt).getTime()
            if (Date.now() - lastTouch < backoffMs) continue
          }
          // M-07 — atomic claim: only this sweeper instance may process the row;
          // the ingest fast path (which claims the same way) loses the race and
          // moves on. Claims are conditional on the CURRENT status.
          const claim = await db.attendanceRawEvent.updateMany({
            where: { id: ev.id, processingStatus: ev.processingStatus },
            data: { processingStatus: "PROCESSING", claimedAt: new Date(), lastAttemptAt: new Date() },
          })
          if (claim.count === 0) continue // claimed/processed concurrently
          const r = await mapAndProcessEvent(ev as any)
          if (r === "FAILED") {
            failed++
            await db.attendanceRawEvent.update({
              where: { id: ev.id },
              data: { retryCount: { increment: 1 }, lastAttemptAt: new Date() },
            }).catch(() => {})
          } else processed++
        }
      }
    }
    // dead-letter (M-7): terminal status for events exceeding the retry limit —
    // surfaced in Sync Monitor, excluded from every future sweep
    await db.attendanceRawEvent.updateMany({
      where: { processingStatus: "FAILED", retryCount: { gte: GATEWAY_ENV.retryLimit() } },
      data: { processingStatus: "DEAD_LETTER", processingError: "DEAD-LETTER: retry limit exceeded — manual reprocess required" },
    }).catch(() => {})
    return { processed, failed }
  } finally {
    sweeping = false
  }
}

// ---------- simulator support (dev/test only) ----------
export function simulatorEnabled(): boolean {
  return process.env.NODE_ENV !== "production" && (process.env.ZKTECO_SIMULATOR_ENABLED ?? "true") !== "false"
}

// ---------- H-12: request body size caps ----------
/** Per-endpoint body caps enforced BEFORE the body is read: ATTLOG/OPTION
 *  endpoints 256 KB, photo endpoints 2 MB. A missing/invalid Content-Length
 *  is rejected outright — the device plane requires a declared length, and a
 *  chunked streaming body must never be buffered unbounded into memory. */
export function bodyCapExceeded(req: { headers: { get(name: string): string | null } }, capBytes: number): boolean {
  const cl = Number(req.headers.get("content-length") || "")
  if (!Number.isFinite(cl) || cl <= 0) return true // missing/invalid → reject without reading
  return cl > capBytes
}

export const BODY_CAP_ATTLOG = 256 * 1024
/** /iclock/cdata POST cap — historical re-uploads arrive as large ATTLOG
 *  batches (≈40 bytes/line); 4 MB ≈ 100k lines, still bounded before read. */
export const BODY_CAP_CDATA = 4 * 1024 * 1024
export const BODY_CAP_PHOTO = 2 * 1024 * 1024

// ============ ZKTeco Push SDK / ADMS protocol adapter (official spec) ============
// ISOLATION LAYER: everything that knows about the ADMS wire format lives here.
// Business logic (mapping, attendance, payroll) never touches raw protocol —
// it only consumes NormalizedAttendanceEvent objects.
//
// ─────────────────────────────────────────────────────────────────────────────
// OFFICIAL ZKTeco "Push" / ADMS protocol (a.k.a. StandAlonePushSDK)
// Documentation reference: ZKTeco Standalone SDK Development Manual
// (ZKTeco Push SDK Protocol Specification, v3.x — current as of 2024).
//
// The device ALWAYS initiates the connection (HTTP client). Endpoints the
// device's firmware hard-codes — these MUST be served at the server root,
// NOT under /api/integrations/.../:
//
//   GET  /iclock/cdata?SN=…&options=all&pushver=…&language=…&FW=…&NewOV=…
//        → initial handshake. Server returns the device's "options" (config).
//   POST /iclock/cdata?SN=…
//        → ATTLOG / OPERLOG / USERINFO / BIODATA records (text body, tab-separated)
//        → server ACKs with `OK: <count>` (count = lines accepted + duplicates)
//   GET  /iclock/getrequest?SN=…
//        → device polls for commands. Server returns command + `\nOK\n`, or `OK\n`.
//   POST /iclock/devicecmd?SN=…
//        → device posts the result of the last command it received
//   POST /iclock/deviceparams?SN=…
//        → device pushes its current configuration (rare; some firmwares only)
//   POST /iclock/cdatapic?SN=…&pin=…&stime=…&index=…
//        → punch photo upload (multipart/binary; optional)
//
// ─────────────────────────────────────────────────────────────────────────────
// ATTLOG line (firmware v3+):
//   <PIN>\t<VerifyMode>\t<YYYY-MM-DD HH:MM:SS>\t<Status>\t<WorkCode>\t<R1>\t<R2>
//   Field 5 (WorkCode) — integer work-code; 0 = no work code
//   Field 6 (R1) — reserved, usually 0
//   Field 7 (R2) — reserved, usually 0
//
// Status codes (field 4):
//   0  = Check-In          1  = Check-Out
//   2  = Break-Out         3  = Break-In
//   4  = OT-In             5  = OT-Out
//   254 = Auto (firmware v3.x — terminal decides by punch order)
//   255 = Auto (firmware v4.x — terminal decides by punch order)
//   (absent) = Auto
//
// VerifyMode codes (field 2):
//   0  = Password           1  = Fingerprint
//   2  = Fingerprint+Pwd    3  = Face
//   4  = Card               5  = Fingerprint+Card
//   6  = Face+Card          7  = Password+Card
//   8  = Face+Password      9  = Palm
//   10 = Finger Vein        11 = Face+Finger Vein
//   12 = Palm+Face          13 = Palm+Password
//   14 = Palm+Card          15 = Face v2
//   16 = Face+Face          17 = Card+Password
//   18 = Face+Finger+Card   19 = Finger+Palm
//   20 = Face+Palm
//
// OPERLOG line — operational log; format depends on the event:
//   "OPERLOG\t<seq>\t<datetime>\t<event_id>\t<param1>\t<param2>..."
// Common event_ids:
//   1  = Power-on           2  = Power-off
//   3  = Settings changed   4  = User added/edited
//   5  = User deleted       6  = Fingerprint enrolled
//   7  = Face enrolled      8  = Palm enrolled
//   9  = Card enrolled      10 = Verification succeeded (no punch)
//   11 = Verification failed 12 = Door opened (door-lock terminals)
//   13 = Door closed        14 = Alarm triggered
//   15 = Duress alarm       16 = Tamper alarm
//
// USERINFO line — device-side user roster push:
//   "USERINFO\t<PIN>\t<Name>\t<Card>\t<Role>\t<FpCount>\t<FaceCount>\t<PwdSet>\t<Schedule>"
// ─────────────────────────────────────────────────────────────────────────────

import crypto from "crypto"
import path from "path"

// ---------- Normalized internal contract ----------
export type NormalizedAttendanceEvent = {
  deviceSerial: string
  deviceUserId: string
  eventTime: string // "YYYY-MM-DD HH:MM:SS" device wall clock (Asia/Dhaka)
  verifyMode: number | null
  attendanceStatus: number | null // raw code as sent by the device
  workCode: string | null
  eventType: "IN" | "OUT" | "BREAK_OUT" | "BREAK_IN" | "OT_IN" | "OT_OUT" | "AUTO"
  rawLine: string
  fingerprint: string
}

export const ADMS_STATUS_MAP: Record<number, NormalizedAttendanceEvent["eventType"]> = {
  0: "IN", 1: "OUT", 2: "BREAK_OUT", 3: "BREAK_IN", 4: "OT_IN", 5: "OT_OUT",
  // 254 and 255 = AUTO — terminal decides punch direction by punch order
}

export const VERIFY_MODE_LABELS: Record<number, string> = {
  0: "Password", 1: "Fingerprint", 2: "Fingerprint+Password", 3: "Face",
  4: "Card", 5: "Fingerprint+Card", 6: "Face+Card", 7: "Password+Card",
  8: "Face+Password", 9: "Palm", 10: "Finger Vein", 11: "Face+Finger Vein",
  12: "Palm+Face", 13: "Palm+Password", 14: "Palm+Card", 15: "Face v2",
  16: "Face+Face", 17: "Card+Password", 18: "Face+Finger+Card",
  19: "Finger+Palm", 20: "Face+Palm",
}

// OPERLOG event_id → human-readable label
export const OPERLOG_EVENT_LABELS: Record<number, string> = {
  1: "Power-On", 2: "Power-Off", 3: "Settings Changed",
  4: "User Modified", 5: "User Deleted", 6: "Fingerprint Enrolled",
  7: "Face Enrolled", 8: "Palm Enrolled", 9: "Card Enrolled",
  10: "Verify OK (no punch)", 11: "Verify Failed",
  12: "Door Opened", 13: "Door Closed", 14: "Alarm",
  15: "Duress Alarm", 16: "Tamper Alarm",
}

export function verifyModeLabel(m?: number | null): string {
  if (m == null) return "—"
  return VERIFY_MODE_LABELS[m] || `Mode ${m}`
}

export function operlogLabel(id?: number | null): string {
  if (id == null) return "—"
  return OPERLOG_EVENT_LABELS[id] || `Event ${id}`
}

// IN-class punches update first-in; OUT-class punches update last-out.
export function isInClass(t: NormalizedAttendanceEvent["eventType"]): boolean {
  return t === "IN" || t === "BREAK_IN" || t === "OT_IN"
}

// ---------- ATTLOG parsing ----------
// Permits both `\t` (official v3+) and `,` (legacy / misconfigured) field
// separators; some Chinese-market firmwares use a single space.
const DATETIME_RE = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/
const TIME_ONLY_RE = /^\d{2}:\d{2}(:\d{2})?$/
// Device user IDs are NOT always numeric — SenseFace 3A / SpeedFace firmwares
// push alphanumeric PINs (e.g. "TCSBL-005") when users are enrolled with the
// employee code as the device User ID. Accept letters, digits, hyphen,
// underscore and dot; reject whitespace/empty/traversal.
const PIN_RE = /^[A-Za-z0-9._-]{1,32}$/

export function parseAttLogLine(line: string): Omit<NormalizedAttendanceEvent, "fingerprint"> | null {
  const raw = line.trim()
  if (!raw) return null
  // Split on tab primarily; fall back to comma + multi-space.
  let parts = raw.split("\t")
  if (parts.length === 1) parts = raw.split(",")
  if (parts.length === 1) parts = raw.split(/\s+/)
  if (parts.length < 3) return null

  const pin = (parts[0] || "").trim()
  if (!pin || !PIN_RE.test(pin)) return null

  // Single-space firmwares split "YYYY-MM-DD HH:MM:SS" into adjacent fields —
  // stitch date + time back together before order detection.
  if (DATE_ONLY_RE.test((parts[1] || "").trim()) && TIME_ONLY_RE.test((parts[2] || "").trim())) {
    const t = (parts[2] || "").trim()
    parts = [parts[0], `${(parts[1] || "").trim()} ${t.length === 5 ? `${t}:00` : t}`, ...parts.slice(3)]
  }

  const numeric = (s?: string): number | null => {
    const t = (s ?? "").trim()
    return /^\d+$/.test(t) ? Number(t) : null
  }

  // Field-order autodetection — the timestamp is the anchor:
  //  * ZKTeco push SDK (ADMS) standard: PIN \t timestamp \t status \t verify \t workcode [\t reserved]
  //    (SenseFace 3A / SpeedFace / etc. all push this layout)
  //  * legacy CSV exports:              PIN \t verify \t timestamp \t status \t workcode
  let eventTime = ""
  let verifyMode: number | null = null
  let statusRaw: number | null = null
  let workCode: string | null = null
  if (DATETIME_RE.test((parts[1] || "").trim())) {
    // push-SDK standard order
    eventTime = (parts[1] || "").trim()
    statusRaw = numeric(parts[2])
    verifyMode = numeric(parts[3])
    workCode = (parts[4] ?? "").trim() || null
  } else if (DATETIME_RE.test((parts[2] || "").trim())) {
    // legacy order
    verifyMode = numeric(parts[1])
    eventTime = (parts[2] || "").trim()
    statusRaw = numeric(parts[3])
    workCode = (parts[4] ?? "").trim() || null
  } else {
    // no timestamp at a plausible position — not an ATTLOG line we understand
    return null
  }

  const eventType: NormalizedAttendanceEvent["eventType"] =
    statusRaw == null || statusRaw === 254 || statusRaw === 255
      ? "AUTO"
      : ADMS_STATUS_MAP[statusRaw] || "AUTO"

  return {
    deviceSerial: "", // filled by the gateway (it knows the SN)
    deviceUserId: pin,
    eventTime,
    verifyMode,
    attendanceStatus: statusRaw === 254 || statusRaw === 255 ? null : statusRaw,
    workCode,
    eventType,
    rawLine: raw,
  }
}

// ---------- OPERLOG parsing ----------
export type ParsedOperlog = {
  rawLine: string
  eventId: number | null
  label: string
  fields: string[]
}

export function parseOperlogLine(line: string): ParsedOperlog | null {
  const raw = line.trim()
  if (!raw) return null
  const parts = raw.split("\t")
  // Format: OPERLOG <seq> <datetime> <event_id> [params...]
  // Some firmwares drop the seq and just have: OPERLOG <datetime> <event_id> ...
  if (parts.length < 2) return null
  let eventId: number | null = null
  for (let i = 1; i < Math.min(parts.length, 5); i++) {
    const v = parts[i]?.trim()
    if (v && /^\d+$/.test(v) && Number(v) >= 1 && Number(v) <= 50) {
      eventId = Number(v)
      break
    }
  }
  return {
    rawLine: raw,
    eventId,
    label: operlogLabel(eventId),
    fields: parts,
  }
}

// ---------- USERINFO parsing ----------
export type ParsedUserInfo = {
  rawLine: string
  pin: string
  name: string | null
  card: string | null
  role: number | null
  fields: string[]
}

export function parseUserInfoLine(line: string): ParsedUserInfo | null {
  const raw = line.trim()
  if (!raw) return null
  // 2026-10-07 — ADMS v2/v3 firmware pushes the roster in KEY=VALUE form on
  // the OPERLOG table:  "USER PIN=12\tName=Rahim\tPri=0\tPasswd=\tCard=\tGrp=1…"
  // (the positional USERINFO layout below is the legacy variant). Both are
  // accepted; the KEY=VALUE form is what SenseFace / SpeedFace / K-series send.
  const kv = /^(USER|USERINFO)\s+PIN=/i.test(raw) ? parseKeyValueFields(raw.replace(/^(USER|USERINFO)\s+/i, "")) : null
  if (kv) {
    const pin = (kv.PIN || "").trim()
    if (!pin) return null
    return {
      rawLine: raw,
      pin,
      name: (kv.Name || "").trim() || null,
      card: (kv.Card || "").trim() || null,
      role: kv.Pri && /^\d+$/.test(kv.Pri.trim()) ? Number(kv.Pri.trim()) : null,
      fields: raw.split("\t"),
    }
  }
  const parts = raw.split("\t")
  // USERINFO \t PIN \t Name \t Card \t Role \t FpCount \t FaceCount \t Pwd \t Schedule
  if (parts.length < 3) return null
  const pin = parts[1]?.trim() || ""
  if (!pin) return null
  return {
    rawLine: raw,
    pin,
    name: parts[2]?.trim() || null,
    card: parts[3]?.trim() || null,
    role: parts[4] && /^\d+$/.test(parts[4].trim()) ? Number(parts[4].trim()) : null,
    fields: parts,
  }
}

/** Parse tab-separated KEY=VALUE fields ("PIN=1\tName=A\tCard=") — the
 *  ADMS record layout for USER / FP / FACE / OPLOG-style lines. */
export function parseKeyValueFields(raw: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const part of raw.split("\t")) {
    const i = part.indexOf("=")
    if (i <= 0) continue
    out[part.slice(0, i).trim()] = part.slice(i + 1)
  }
  return out
}

// ---------- Line classifier ----------
export type LineKind = "ATTLOG" | "OPERLOG" | "USERINFO" | "BIODATA" | "OPTIONS" | "UNKNOWN"

/** Classify one pushed record line.
 *
 *  2026-10-07 — the device tells us WHICH table a POST carries via the
 *  `table` query parameter (`?SN=…&table=ATTLOG|OPERLOG|ATTPHOTO|options`).
 *  The old classifier ignored it and treated every unrecognised line as an
 *  attendance punch, so the roster lines ADMS firmware actually sends on the
 *  OPERLOG table ("USER PIN=…", "FP PIN=…", "BIOPHOTO PIN=…") were parsed as
 *  broken ATTLOG lines and counted INVALID — the device roster never reached
 *  the server, which is why device users could not be matched to employees. */
export function classifyLine(line: string, table?: string | null): LineKind {
  const raw = line.trim()
  if (!raw) return "UNKNOWN"
  const t = (table || "").trim().toUpperCase()
  // Records that begin with a known keyword are non-attendance records.
  if (/^OPERLOG\b|^OPLOG\b|^OPLOG-/i.test(raw)) return "OPERLOG"
  if (/^USERINFO\b|^USER\s+PIN=/i.test(raw)) return "USERINFO"
  if (/^BIODATA\b|^FP\b|^FACE\b|^PALM\b|^BIOPHOTO\b|^USERPIC\b|^FVEIN\b|^WORKCODE\b|^SMS\b|^USER_SMS\b|^IDCARD\b/i.test(raw)) return "BIODATA"
  if (/^OPTIONS\b|^GET OPTION\b|^~/i.test(raw)) return "OPTIONS"
  // Non-ATTLOG tables never carry attendance punches — never mis-parse their
  // records as punches (and never let them count as INVALID attendance).
  if (t === "OPTIONS" || t === "INFO") return "OPTIONS"
  if (t === "OPERLOG") return "OPERLOG"
  if (t === "ATTPHOTO" || t === "BIODATA" || t === "USERPIC" || t === "BIOPHOTO") return "BIODATA"
  // Otherwise: assume ATTLOG (PIN \t ...). parseAttLogLine filters out junk.
  return "ATTLOG"
}

/** Deterministic event fingerprint (spec §10) — distinguishes legitimate
 *  distinct events while making device retries idempotent. */
export function fingerprint(serial: string, ev: Omit<NormalizedAttendanceEvent, "fingerprint">): string {
  return crypto
    .createHash("sha256")
    .update([
      serial, ev.deviceUserId, ev.eventTime,
      ev.verifyMode ?? "", ev.attendanceStatus ?? "", ev.workCode ?? "",
    ].join("|"))
    .digest("hex")
}

// ---------- Response builders (exact ACK behaviour) ----------
/**
 * ZKTeco Push SDK handshake response — `GET OPTION FROM: <SN>\n` followed by
 * key/value pairs. The device reads these to configure its push behaviour.
 *
 * Required options the firmware expects (omit at your peril — the device may
 * refuse to push or default to polling every 30 seconds):
 *   ATTLOGFILE      — empty = no log file push; filename = push file format
 *   OPERLOGFILE     — same for OPERLOG
 *   USERINFOFILE    — same for USERINFO
 *   ATTLOG          — 1 = push ATTLOG, 0 = suppress (we always want 1)
 *   OPTIONS         — 1 = push OPTIONS responses, 0 = suppress
 *   LOGDELAY        — seconds between /iclock/getrequest polls (default 60)
 *   TRANSACTIONAL   — 0 = no transactional mode (recommended)
 *   OnError         — 1 = retry on push error (recommended)
 *   Realtime        — 1 = push punches immediately (recommended)
 *   TransTimes      — scheduled push times HH:MM;HH:MM;... (for non-realtime)
 *   TransInterval   — minutes between scheduled pushes (ignored if Realtime=1)
 *   TransFlag       — comma-sep of what to push: AttLog,OperLog,UserInfo,...
 *   TimeZone        — server timezone offset vs GMT, in hours (Asia/Dhaka = +6)
 *   TimeOut         — connection timeout in minutes (default 30)
 *   Encrypt         — 0 = no encryption (use HTTPS instead), 1 = X.509
 *   ServerVer       — server-side push protocol version (informational)
 *   PhotoFun       — 0 = no photo upload, 1 = upload punch photos
 */
export function handshakeResponse(sn: string, opts: {
  logDelaySec?: number
  transInterval?: number
  timeZone?: number
  timeout?: number
  realtime?: boolean
  photoFun?: boolean
  /** ADMS upload watermark: the device uploads every ATTLOG record whose
   *  internal stamp is GREATER than this value. "0" re-uploads the device's
   *  entire stored log (historical sync); omitted when unknown. */
  attlogStamp?: string
  operlogStamp?: string
  attphotoStamp?: string
} = {}): string {
  const logDelay = opts.logDelaySec ?? 60
  const transInterval = opts.transInterval ?? 1
  const timeZone = opts.timeZone ?? 6 // Asia/Dhaka = GMT+6
  const timeout = opts.timeout ?? 30
  const realtime = opts.realtime ? 1 : 0
  const photoFun = opts.photoFun ? 1 : 0
  // Stamps are only sent when known: without one the firmware keeps its own
  // "already uploaded" bookkeeping (sending "None" would make some firmwares
  // re-upload their whole log on every CHECK).
  const stampLine = (key: string, v: string | undefined) => (v && /^[0-9A-Za-z]{1,20}$/.test(v) ? [`${key}=${v}`] : [])
  return [
    `GET OPTION FROM: ${sn}`,
    // 2026-10-07 — the STANDARD ADMS option keys. The previous response only
    // carried non-standard keys (ATTLOGFILE / ATTLOG=1 / LOGDELAY …) that
    // ZKTeco firmware does not read, so the device ran on its defaults: it
    // never learned an upload watermark (ATTLOGStamp) and therefore could
    // never be told to re-upload its stored history — the root cause of the
    // historical sync never pulling old records.
    ...stampLine("ATTLOGStamp", opts.attlogStamp),
    ...stampLine("OPERLOGStamp", opts.operlogStamp),
    ...stampLine("ATTPHOTOStamp", opts.attphotoStamp),
    "ErrorDelay=30",
    `Delay=${Math.max(5, Math.min(logDelay, 300))}`,
    "TransTimes=00:00;06:00;12:00;18:00",
    `TransInterval=${transInterval}`,
    // which record kinds the device uploads: attendance, operation log
    // (carries the USER roster lines used for employee matching), user
    // enrolment/changes. Biometric templates are never requested.
    "TransFlag=TransData AttLog\tOpLog\tEnrollUser\tChgUser",
    `TimeZone=${timeZone}`,
    `Realtime=${realtime}`,
    "Encrypt=None",
    "ServerVer=2.4.1",
    "PushProtVer=2.4.1",
    // legacy keys kept for firmwares that read them (harmless elsewhere)
    `LOGDELAY=${logDelay}`,
    "TRANSACTIONAL=0",
    "OnError=1",
    `TimeOut=${timeout}`,
    `PhotoFun=${photoFun}`,
    "", // trailing newline
  ].join("\n")
}

/** `OK: <count>` acknowledges both newly-stored and already-known duplicate
 *  records. The device removes acknowledged records from its queue. */
export function ackEvents(count: number): string {
  return `OK: ${count}\n`
}

export function ackOk(): string {
  return "OK\n"
}

/** Some firmwares expect `OK:` (with trailing colon) for the initial handshake
 *  ack — variant used when we want the device to confirm receipt of options. */
export function ackHandshake(): string {
  return "OK:\n"
}

export function admsError(msg: string): string {
  // The protocol does not standardise an error format. ZKTeco SDK uses
  // `ERROR: <text>` and the device will retry on the next push cycle.
  return `ERROR: ${msg}\n`
}

// ---------- Command whitelist (getrequest channel) ----------
// Reference: ZKTeco Push SDK — "Device Command Reference"
export const COMMAND_WHITELIST = [
  "CHECK",            // request device to upload ALL unsent records
  "CHECK TIME",       // sync the device's clock to server time
  "CHECK INFO",       // request device info (firmware, model, user counts)
  "CHECK BIO DATA",   // request biometric templates (FP/Face/Palm)
  "CHECK USERINFO",   // request USERINFO roster (device-side user list)
  "CHECK ATTLOG",     // request ATTLOG only
  "CLEAR LOG",        // wipe the device's stored attendance log
  "CLEAR DATA",       // wipe all user data on the device (DESTRUCTIVE)
  "REBOOT",           // reboot the device
  "INFO",             // alias of CHECK INFO on some firmwares
  "DATA UPDATE",      // sync user roster from server → device
  "DATA UPDATE USERINFO", // USERINFO-only sync
  // R8 — historical backfill: ask the device to re-upload ATTLOG records from
  // its local storage for a time range (newer firmwares; older ones fall back
  // to CHECK which re-uploads every unsent record).
  "DATA QUERY",
] as const

export function isAllowedCommand(cmd: string): boolean {
  const c = (cmd || "").trim().toUpperCase()
  return (COMMAND_WHITELIST as readonly string[]).some((w) => c === w || c.startsWith(w + " "))
}

/** Short numeric command id for the ADMS wire format. The firmware echoes it
 *  back in /iclock/devicecmd (`ID=<id>&Return=<code>&CMD=<cmd>`), so it must
 *  be derivable from the DeviceCommand row: a stable 9-digit hash of the
 *  row id (no schema change needed). */
export function admsCommandId(rowId: string): string {
  const h = crypto.createHash("sha1").update(rowId).digest()
  return String(100_000_000 + (h.readUInt32BE(0) % 900_000_000))
}

/** Build the body of a /iclock/getrequest response.
 *
 *  2026-10-07 root-cause fix — ZKTeco ADMS firmware only executes command
 *  lines in the form  `C:<CmdID>:<command>`. The previous builder sent the
 *  bare command ("CHECK\nOK\n"), which the device silently ignored: no CHECK,
 *  no DATA QUERY and no roster push was ever executed, so historical sync
 *  could not pull anything. No command → plain `OK`.
 *
 *  `cmd` may be a plain string (legacy callers/tests) or `{ id, command }`;
 *  `lines` lets one command expand into several wire lines (roster push). */
export function buildCommandResponse(cmd: string | { id: string; command: string; lines?: string[] } | null): string {
  if (!cmd) return ackOk()
  if (typeof cmd === "string") return `${cmd.trim()}\nOK\n`
  const wireId = admsCommandId(cmd.id)
  const lines = cmd.lines && cmd.lines.length ? cmd.lines : [cmd.command.trim()]
  return lines.map((l, i) => `C:${lines.length > 1 ? `${wireId}${String(i).padStart(4, "0")}` : wireId}:${l}`).join("\n") + "\n"
}

/** Parse the device's command-result post (/iclock/devicecmd). One result per
 *  line: `ID=123456789&Return=0&CMD=CHECK` (Return 0 = success, negative =
 *  error code). Tolerates tab or newline separated bodies. */
export function parseCommandResults(body: string): { id: string; ret: number | null; cmd: string }[] {
  const out: { id: string; ret: number | null; cmd: string }[] = []
  for (const line of (body || "").split(/\r?\n/)) {
    const l = line.trim()
    if (!l || !/ID=/i.test(l)) continue
    const params = new URLSearchParams(l.replace(/\t/g, "&"))
    const id = (params.get("ID") || params.get("id") || "").trim()
    if (!id) continue
    const r = (params.get("Return") || params.get("return") || "").trim()
    out.push({ id, ret: /^-?\d+$/.test(r) ? Number(r) : null, cmd: (params.get("CMD") || params.get("cmd") || "").trim() })
  }
  return out
}

// ---------- Handshake param extraction ----------
// The device's handshake request URL carries these query-string params.
// Pull only what's safe (no secrets beyond the comm key, which we use for auth).
export function parseHandshakeParams(query: URLSearchParams): Record<string, string> {
  const out: Record<string, string> = {}
  // Official ZKTeco Push SDK params:
  for (const k of [
    "SN",              // serial number (required)
    "options",         // what the device wants from server: "all" / "attlog" / "userinfo"
    "pushcommkey",     // shared secret for device auth
    "pushver",         // device push protocol version (e.g. "3.1.3")
    "PUSHVERSION",     // some firmwares use UPPERCASE
    "language",        // device language code (e.g. "en", "zh")
    "FW",              // firmware version
    "NewOV",           // new-operator verification (firmware v4+)
    "ip",              // device self-reported IP
    "DEVINFO",         // combined device info blob (firmware v4+)
    "PIN",             // optional operator PIN (rare)
  ]) {
    const v = query.get(k)
    if (v != null && v !== "") out[k] = v
  }
  return out
}

// ---------- Time helpers (device wall-clock strings, Asia/Dhaka by convention) ----------
export function eventDate(eventTime: string): string {
  return eventTime.slice(0, 10) // YYYY-MM-DD
}

export function eventClock(eventTime: string): string {
  return eventTime.slice(11, 16) // HH:MM
}

export function eventClockSec(eventTime: string): string {
  return eventTime.slice(11, 19) // HH:MM:SS
}

/** seconds between device event time and server now — only meaningful for
 *  near-live punches (offline replays are excluded by the caller).
 *  C-4 — device stamps are LOCAL wall-clock in the device's configured
 *  timezone (Asia/Dhaka = UTC+6 by default, from ADMS_TIMEZONE_OFFSET_HOURS).
 *  The drift is computed against the SAME zone's current wall clock; the old
 *  UTC comparison made every reading appear off by the zone offset (6h) and
 *  masked real drift. */
export function clockDriftSec(eventTime: string, now = new Date(), tzOffsetHours = 6): number {
  const t = new Date(eventTime.replace(" ", "T") + "Z").getTime()
  const deviceWall = now.getTime() + tzOffsetHours * 3600_000
  return Math.round((t - deviceWall) / 1000)
}

/** C-4 — device timestamp freshness window. Device event times are UNTRUSTED
 *  input: an attacker (or a misconfigured/faulty clock) can stamp 1970, +1h or
 *  -30d. An event is accepted only when its wall-clock time is inside
 *  [now - lookbackDays days, now + aheadMinutes minutes] in the DEVICE's
 *  timezone frame (the caller passes `now` already in that frame — gateway
 *  uses Date.now() + ADMS_TIMEZONE_OFFSET_HOURS). Default lookback 7 days
 *  (HRM_DEVICE_INGEST_WINDOW_DAYS), ahead tolerance 5 minutes. */
export function eventWithinWindow(
  eventTime: string,
  now: Date = new Date(),
  lookbackDays = 7,
  aheadMinutes = 5,
): boolean {
  const t = new Date(eventTime.replace(" ", "T") + "Z").getTime()
  if (!Number.isFinite(t)) return false
  const lo = now.getTime() - lookbackDays * 86_400_000
  const hi = now.getTime() + aheadMinutes * 60_000
  return t >= lo && t <= hi
}

/** H-3 — "now" expressed in the DEVICE's timezone frame. Device stamps are
 *  local wall-clock strings, so eventWithinWindow()/clockDriftSec() must be
 *  handed a reference already shifted into that frame. Centralized here (next
 *  to the window helpers) so the /iclock gateway and the ISAPI receiver share
 *  one implementation and cannot diverge again — the audit found the ISAPI
 *  route passing raw new Date(), which dropped EVERY fresh event as
 *  OUT_OF_WINDOW on UTC servers (+6 default offset) while ACKing them. */
export function deviceFrameNow(tzOffsetHours: number): Date {
  return new Date(Date.now() + tzOffsetHours * 3600_000)
}

export function fmtDrift(sec: number | null | undefined): string {
  if (sec == null) return "—"
  const sign = sec >= 0 ? "+" : "−"
  const a = Math.abs(sec)
  const h = Math.floor(a / 3600), m = Math.floor((a % 3600) / 60), s = a % 60
  return `${sign}${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
}

// ---------- H-13: punch-photo upload hardening (path traversal) ----------

/** Allowed punch-photo PIN characters: digits, letters, underscore, hyphen —
 *  1–32 chars. Everything else (../, URL-encoded traversal, absolute paths,
 *  separators, unicode) is rejected by the ROUTE with 400 BEFORE any use. */
export const PHOTO_PIN_RE = /^[0-9A-Za-z_-]{1,32}$/

export function isValidPhotoPin(pin: unknown): boolean {
  return typeof pin === "string" && PHOTO_PIN_RE.test(pin)
}

/** Resolve the punch-photo storage directory for a serial number and assert
 *  (defense-in-depth) that it stays INSIDE the configured photo root — a
 *  hostile SN must never escape the root via traversal segments. */
export function punchPhotoDir(photoRoot: string, sn: string): string | null {
  if (!/^[0-9A-Za-z_-]{4,64}$/.test(sn)) return null
  const root = path.resolve(photoRoot)
  const dir = path.resolve(path.join(photoRoot, sn))
  if (dir !== root && !dir.startsWith(root + path.sep)) return null
  return dir
}

/** H-13 — punch photos must be real JPEG or PNG images (magic-byte sniff)
 *  before they are persisted to disk. */
export function isImageMagic(buf: Uint8Array): boolean {
  if (buf.length < 4) return false
  const isJpeg = buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff
  const isPng = buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47
  return isJpeg || isPng
}

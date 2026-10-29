// ============ WP-R — Backup & Disaster Recovery engine (owner plane) ============
// Replaces the WP-A placeholder stub. Registers owner.backup.* actions
// (self-registers via ownerAction(), side-effect-imported by /api/owner after
// owner-routes — same pattern as cms-routes.ts / health.ts) and implements the
// BACKUP_PG_DUMP + RESTORE_DRILL BgJob runners pre-wired in jobs.ts.
//
// ------------------------------- DESIGN ---------------------------------------
// Backup pipeline (runBackup):  detect DB flavor from DATABASE_URL
//   → postgresql:// : pg_dump --format=plain --no-owner --no-privileges
//                     (credentials via PGPASSWORD/PGHOST/… env, NEVER argv)
//   → sqlite file:   sqlite3 <live-db> "VACUUM INTO '<tmp>'" (consistent
//                     snapshot; the historical prisma/-relative anchoring is
//                     honored for relative file: URLs)
//   → gzip the dump with fflate (streaming, chunked — no gzip binary needed,
//                     works under both the Node and Bun runtimes)
//   → sha256 checksum of the .gz artifact
//   → retention pruning: keep the newest N artifacts (N = settings.retention),
//                     deleting files recorded by older DONE backup runs
//   → record the SaasBackupRun row (sizeBytes, checksum, locationType LOCAL,
//                     locationPath, retentionKept)
// Progress = real phases (total 5: dump → gzip → checksum → record → prune).
// NO fake progress bars.
//
// Restore drill (runRestoreDrill):  restores the LATEST dump to a TEMP
// database/file — NEVER the live one — re-verifies the checksum, compares
// core-table row counts source vs restored (exact match required), writes
// reportJson {restoredTables, counts:[{table,source,restored,match}],
// checksumVerified, pass}, drops the temp database / deletes the temp file,
// records the DRILL SaasBackupRun row. Volatile tables (sessions, throttle
// buckets, the BgJob queue itself) are deliberately excluded from the count
// comparison — the live database keeps mutating between dump and count, so a
// mismatch there carries no signal; a note in reportJson says exactly that.
//
// HARD GUARD — no code path may restore over the live database:
//   assertDrillTargetNotLive() compares the computed drill target against the
//   LIVE DATABASE_URL coordinates and refuses on equality (loud error that
//   lands in the FAILED run row). It runs BEFORE the drill target is created
//   and again before the restore command is executed. Mental test:
//     live : postgresql://hrm_user@127.0.0.1:5432/hrm
//     drill: postgresql://hrm_user@127.0.0.1:5432/hrm_drill_20261008t0130_a1b2
//     → database names differ → guard passes.
//     If any code path computed the drill target as "hrm" (or a URL equal to
//     DATABASE_URL) → guard refuses. SQLite path mirrors this on resolved file
//     paths. The drill database name is generated as hrm_drill_<utc-stamp>_<rand>
//     so it can never collide with the live name by construction; the guard is
//     defense-in-depth on top of that.
//
// Credentials discipline: the PostgreSQL password travels ONLY through the
// PGPASSWORD env var of the child process (pg_dump/psql read it there); tool
// argv carries flags only, and stderr embedded into error messages is scrubbed
// of the password and of DATABASE_URL itself. Child processes are spawned with
// argument ARRAYS (never a shell string) — no user input reaches argv anyway
// (paths are generated timestamps; table names come from the CORE_TABLES
// whitelist constant).
//
// ------------------------------ PERMISSIONS -----------------------------------
// There is no backup.* permission in OWNER_PERMISSIONS (saas/constants.ts is
// FROZEN for this work package), so the actions gate on the closest existing
// owner vocabulary: settings.manage for run/save/schedule actions, settings.view
// for reads. The nav item is gated on settings.view. Documented choice.
//
// ------------------------- BgJob vendorId anchoring ---------------------------
// BgJob.vendorId is NOT NULL, but backup runs are platform-plane work with no
// owning tenant. No platform/system vendor constant exists in the codebase
// (grep-verified), so the engine anchors the job to the FIRST vendor by
// creation order (a real tenant — keeps the row visible in that tenant's Job
// Center filters) and falls back to the literal "platform" sentinel on a fresh
// install with zero vendors. Resolved id is cached 60 s on globalThis (survives
// `next dev` module reloads).
//
// ------------------------------ SCHEDULING -------------------------------------
// jobs.ts (platformDailyJobs) is FROZEN to this package, so the nightly backup
// uses a CRON-FREE PIGGYBACK design, honestly documented: a module-level
// guarded scheduler (maybeRunScheduledBackup) checks "is it past scheduleTime
// (default 01:05 Asia/Dhaka) and did no SCHEDULED backup start today?" lazily
// on owner-console traffic — every owner.backup.list call and every System
// Health snapshot (the health.ts backup check invokes it too). If the console
// sees no traffic after 01:05, the backup simply runs on the FIRST console hit
// of the next morning; a zero-traffic day skips the in-app backup (and the
// stale-backup health check degrades to say so). Rate-guarded to one evaluation
// per 60 s + in-flight dedup on globalThis so parallel calls cannot double-
// submit. owner.backup.schedule.check exposes a manual "check now" trigger.
//
// PRODUCTION-GRADE PATH (surfaced in the UI): deploy/backup.timer →
// backup.service → scripts/backup.sh already provides the hardened nightly
// path outside the app — 02:30 server-local, pg_dump custom format, AES-256
// encryption (HRM_BACKUP_KEY), sha256 manifest, optional offsite sync, 14-day
// retention, failure alerting via scripts/backup-alert.ts, plus the quarterly
// restore-drill.sh + deploy/restore-drill.timer. This in-app engine adds the
// QUERYABLE run history (SaasBackupRun rows) + console control; deployments
// should run BOTH (the timer for the encrypted offsite copy, the console for
// monitoring/drills) or rely on the timer alone and read its outcome here via
// the manual runs. See docs/postgresql-backup-restore.md.
//
// Settings live in the SaaSSetting group "backup" {enabled, retention,
// scheduleTime, alertEmail, dir} — stored via direct upserts from THIS module
// (saas/settings.ts is frozen; its whitelist would drop an unknown group).
// Storage conventions mirror settings.ts exactly (booleans as "true"/"false",
// numbers as decimal strings, strings raw). Failure alerts go to alertEmail
// when set, else to the first ACTIVE SUPER_ADMIN owner user's email.
import { spawn } from "node:child_process"
import { createCipheriv, createDecipheriv, createHash, pbkdf2 as pbkdf2Cb, randomBytes } from "node:crypto"
import { mkdir, open, rename, stat, unlink } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { z } from "zod"
import { Gzip, Gunzip } from "fflate"
import { db } from "@/lib/db"
import { ownerAction } from "./owner-routes"
import { saasAudit } from "./audit"
import { sendPlatformEmail, logPlatformNotification } from "./notify"
import { submitJob, JobCancelledError } from "../jobs"
// SCL-21 (Phase 3 WS-B) — cluster-wide once-per-day claim for the scheduled
// backup (two instances behind one LB used to be able to double-submit it)
import { claimPeriodAction } from "../coordination"

// ============================== shared types ==============================

/** Structural subset of the BgJob row the runners receive from jobs.ts. */
type BgJobLike = { id: string; payloadJson?: string | null }
type ProgressCb = (n: number) => Promise<void>

export type BackupSettings = {
  enabled: boolean // nightly scheduled backup on/off (piggyback scheduler)
  retention: number // number of newest backup artifacts kept on disk
  scheduleTime: string // "HH:MM" in the schedule timezone below
  alertEmail: string // "" → first ACTIVE SUPER_ADMIN owner user email
  dir: string // backup directory (relative → resolved against process.cwd())
}

export const DEFAULT_BACKUP_SETTINGS: BackupSettings = {
  enabled: true,
  retention: 14,
  scheduleTime: "01:05",
  alertEmail: "",
  dir: "backups",
}

/** Core tables the drill compares row counts for (whitelist — Prisma model
 *  names double as physical table names for both PostgreSQL and SQLite). */
const CORE_TABLES = ["Vendor", "Employee", "PayrollRun", "Attendance", "AccountJournal"] as const

const SCHEDULE_TZ = "Asia/Dhaka"
/** Bangladesh is UTC+06:00 with no DST since 2009 — a fixed offset is exact
 *  for computing Dhaka day boundaries. */
const DHAKA_UTC_OFFSET_MIN = 360

const TOOL_TIMEOUT_DUMP_MS = 30 * 60_000
const TOOL_TIMEOUT_SHORT_MS = 60_000

// ============================== OPS-1/OPS-2 (Phase 3 WS-C) — artifact hardening

/** Dump connection: an explicit HRM_BACKUP_SOURCE_URL (point at a READ
 *  REPLICA so the dump never loads the primary) wins over DATABASE_URL.
 *  Only the DUMP reads the source; restore drills always target the primary
 *  server's scratch database (never the source). */
function backupSourceUrl(): string | undefined {
  return process.env.HRM_BACKUP_SOURCE_URL?.trim() || process.env.DATABASE_URL
}

/** Encrypt artifacts at rest when HRM_BACKUP_KEY is configured (the same key
 *  scripts/backup.sh uses). Without a key the artifact is stored plaintext and
 *  the run row + health card say so explicitly (visibility, never silence).
 *  Format (self-contained, streaming-friendly):
 *      "HRMBK1\n" magic · 16B salt · 16B IV · AES-256-CBC(PKCS#7) payload
 *  Key = PBKDF2-SHA256(HRM_BACKUP_KEY, salt, 150_000, 32B). */
const ENC_MAGIC = Buffer.from("HRMBK1\n", "utf8")
const ENC_KDF_ITERATIONS = 150_000

function pbkdf2Async(password: string, salt: Buffer, iterations: number, keylen: number): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    pbkdf2Cb(password, salt, iterations, keylen, "sha256", (err, derived) => (err ? reject(err) : resolve(derived))))
}

export async function encryptFile(src: string, dest: string, password: string): Promise<void> {
  const salt = randomBytes(16)
  const iv = randomBytes(16)
  const key = await pbkdf2Async(password, salt, ENC_KDF_ITERATIONS, 32)
  const cipher = createCipheriv("aes-256-cbc", key, iv)
  const input = await open(src, "r")
  const output = await open(dest, "w")
  try {
    await output.write(ENC_MAGIC)
    await output.write(salt)
    await output.write(iv)
    const buf = Buffer.allocUnsafe(IO_CHUNK)
    let pos = 0
    for (;;) {
      const { bytesRead } = await input.read(buf, 0, IO_CHUNK, pos)
      if (bytesRead === 0) break
      const enc = cipher.update(buf.subarray(0, bytesRead))
      if (enc.length) await output.write(enc)
      pos += bytesRead
    }
    const fin = cipher.final()
    if (fin.length) await output.write(fin)
  } finally {
    await input.close().catch(() => {})
    await output.close().catch(() => {})
  }
}

export async function decryptFile(src: string, dest: string, password: string): Promise<void> {
  const input = await open(src, "r")
  const output = await open(dest, "w")
  try {
    const header = Buffer.alloc(ENC_MAGIC.length + 16 + 16)
    const { bytesRead } = await input.read(header, 0, header.length, 0)
    if (bytesRead !== header.length || !header.subarray(0, ENC_MAGIC.length).equals(ENC_MAGIC)) {
      throw new Error(`Not a Finix HR encrypted backup artifact (bad header): ${src}`)
    }
    const salt = header.subarray(ENC_MAGIC.length, ENC_MAGIC.length + 16)
    const iv = header.subarray(ENC_MAGIC.length + 16)
    const key = await pbkdf2Async(password, salt, ENC_KDF_ITERATIONS, 32)
    const decipher = createDecipheriv("aes-256-cbc", key, iv)
    const buf = Buffer.allocUnsafe(IO_CHUNK)
    let pos = header.length
    for (;;) {
      const { bytesRead } = await input.read(buf, 0, IO_CHUNK, pos)
      if (bytesRead === 0) break
      const dec = decipher.update(buf.subarray(0, bytesRead))
      if (dec.length) await output.write(dec)
      pos += bytesRead
    }
    const fin = decipher.final()
    if (fin.length) await output.write(fin)
  } finally {
    await input.close().catch(() => {})
    await output.close().catch(() => {})
  }
}

/** True when at-rest encryption is active for new artifacts. */
export function backupEncryptionEnabled(): boolean {
  return !!(process.env.HRM_BACKUP_KEY || "").trim()
}

/** Test hook — artifact flavor helpers, exported for the unit suite. */
export function backupArtifactFlavor(locationPath: string): "pg-custom" | "pg-plain-gz" | "sqlite-gz" | "unknown" {
  const base = locationPath.replace(/\.enc$/, "")
  if (base.endsWith(".dump")) return "pg-custom"
  if (base.endsWith(".sql.gz")) return "pg-plain-gz"
  if (base.endsWith(".db.gz")) return "sqlite-gz"
  return "unknown"
}

// ============================== small helpers ==============================

function safeJson<T = Record<string, unknown>>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback
  try { return JSON.parse(raw) as T } catch { return fallback }
}

function utcStamp(d = new Date()): string {
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z") // 20261008T013000Z
}

/** SQL identifier quoting — only ever applied to whitelist values. */
function sqlIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`
}

function clampInt4(n: number): number | null {
  // SaasBackupRun.sizeBytes is an Int (int4, max ~2.1 GB) — clamp instead of
  // letting an oversized artifact blow up the row write.
  return Number.isFinite(n) ? Math.min(Math.max(Math.round(n), 0), 2_147_483_647) : null
}

// ============================== DB flavor detection ==============================

type PgConn = {
  host: string
  port: number
  user: string
  password: string
  database: string
  sslmode?: string
}

type DbFlavor =
  | { kind: "postgresql"; conn: PgConn }
  | { kind: "sqlite"; file: string }
  | { kind: "unknown" }

function parsePgUrl(raw: string | undefined): PgConn | null {
  if (!raw || !/^postgres(ql)?:\/\//i.test(raw.trim())) return null
  try {
    const u = new URL(raw.trim())
    const database = decodeURIComponent(u.pathname.replace(/^\//, ""))
    if (!database) return null
    return {
      host: u.hostname || "localhost",
      port: u.port ? Number(u.port) : 5432,
      user: decodeURIComponent(u.username || ""),
      password: decodeURIComponent(u.password || ""),
      database,
      sslmode: u.searchParams.get("sslmode") || undefined,
    }
  } catch {
    return null
  }
}

function sqliteFileFromUrl(raw: string | undefined): string | null {
  if (!raw || !/^file:/i.test(raw.trim())) return null
  let p = raw.trim().replace(/^file:/i, "")
  p = p.split("?")[0]
  if (!p || p === ":memory:") return null
  // Historical convention (removed with the PostgreSQL migration, kept for
  // dev flexibility): relative file: URLs anchor against <cwd>/prisma/.
  return path.isAbsolute(p) ? p : path.join(process.cwd(), "prisma", p)
}

function detectDbFlavor(raw: string | undefined): DbFlavor {
  const pg = parsePgUrl(raw)
  if (pg) return { kind: "postgresql", conn: pg }
  const file = sqliteFileFromUrl(raw)
  if (file) return { kind: "sqlite", file }
  return { kind: "unknown" }
}

/** Public flavor word for responses/UI — never the URL itself. */
export function dbFlavorWord(): "postgresql" | "sqlite" | "unknown" {
  return detectDbFlavor(process.env.DATABASE_URL).kind
}

// ============================== child process plumbing ==============================

type ChildResult = { code: number; stdout: string; stderr: string; timedOut: boolean }

const CHILD_CAPTURE_CAP = 64 * 1024

/** Spawn a tool with an argv ARRAY (no shell). Rejects on spawn failure
 *  (ENOENT = binary missing); resolves with the exit code otherwise. */
function runChild(cmd: string, args: string[], opts: { env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}): Promise<ChildResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { env: opts.env, stdio: ["ignore", "pipe", "pipe"] })
    const outChunks: Buffer[] = []
    const errChunks: Buffer[] = []
    let outLen = 0
    let errLen = 0
    let timedOut = false
    child.stdout?.on("data", (d: Buffer) => {
      if (outLen < CHILD_CAPTURE_CAP) { outChunks.push(d); outLen += d.length }
    })
    child.stderr?.on("data", (d: Buffer) => {
      if (errLen < CHILD_CAPTURE_CAP) { errChunks.push(d); errLen += d.length }
    })
    const timer = opts.timeoutMs
      ? setTimeout(() => { timedOut = true; child.kill("SIGKILL") }, opts.timeoutMs)
      : null
    child.on("error", (e: NodeJS.ErrnoException) => {
      if (timer) clearTimeout(timer)
      if (e.code === "ENOENT") {
        reject(new Error(
          `${cmd} binary not found on PATH — install the client tools (Debian/Ubuntu: postgresql-client / sqlite3) ` +
          `or rely on the deploy/backup.timer + scripts/backup.sh path (see docs/postgresql-backup-restore.md).`
        ))
      } else {
        reject(new Error(`${cmd} could not be started: ${e.message}`))
      }
    })
    child.on("close", (code) => {
      if (timer) clearTimeout(timer)
      resolve({
        code: code ?? -1,
        stdout: Buffer.concat(outChunks).subarray(0, CHILD_CAPTURE_CAP).toString("utf8"),
        stderr: Buffer.concat(errChunks).subarray(0, CHILD_CAPTURE_CAP).toString("utf8"),
        timedOut,
      })
    })
  })
}

/** Env for PostgreSQL client tools — the password rides in PGPASSWORD only,
 *  never in argv. The URL itself is deliberately NOT passed down. */
function pgToolEnv(conn: PgConn, database: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PGPASSWORD: conn.password,
    PGHOST: conn.host,
    PGPORT: String(conn.port),
    PGUSER: conn.user,
    PGDATABASE: database,
  }
  if (conn.sslmode) env.PGSSLMODE = conn.sslmode
  return env
}

/** Error text for a failed tool run — scrubbed of credentials. */
function toolError(tool: string, res: ChildResult, secrets: string[], timeoutMs: number): Error {
  const detail = sanitize(res.stderr.trim() || res.stdout.trim(), secrets).slice(0, 600)
  if (res.timedOut) return new Error(`${tool} timed out after ${Math.round(timeoutMs / 60000)} min: ${detail}`)
  return new Error(`${tool} exited with code ${res.code}: ${detail}`)
}

function sanitize(text: string, secrets: string[]): string {
  let t = text
  for (const s of secrets) {
    if (s && s.length >= 4) t = t.split(s).join("***")
  }
  return t
}

function pgSecrets(conn: PgConn): string[] {
  return [conn.password, process.env.DATABASE_URL || ""].filter(Boolean)
}

// ============================== file helpers (fflate, sha256) ==============================

const IO_CHUNK = 4 * 1024 * 1024
/** Streaming gzip via fflate's synchronous transform — ondata fires (and
 *  completes) inside push(), so draining the queue after each push is exact. */
async function gzipFile(src: string, dest: string): Promise<void> {
  const input = await open(src, "r")
  const output = await open(dest, "w")
  const queue: Uint8Array[] = []
  const gz = new Gzip((chunk) => { queue.push(chunk) })
  try {
    const buf = Buffer.allocUnsafe(IO_CHUNK)
    let pos = 0
    for (;;) {
      const { bytesRead } = await input.read(buf, 0, IO_CHUNK, pos)
      if (bytesRead === 0) break
      // fresh copy → a proper Uint8Array<ArrayBuffer> for fflate AND immune
      // to the buffer being reused on the next read
      const chunk = new Uint8Array(bytesRead)
      chunk.set(buf.subarray(0, bytesRead))
      gz.push(chunk)
      for (;;) {
        const out = queue.shift()
        if (!out) break
        await output.write(Buffer.from(out))
      }
      pos += bytesRead
    }
    gz.push(new Uint8Array(0), true)
    for (;;) {
      const out = queue.shift()
      if (!out) break
      await output.write(Buffer.from(out))
    }
  } finally {
    await input.close().catch(() => {})
    await output.close().catch(() => {})
  }
}

async function gunzipFile(src: string, dest: string): Promise<void> {
  const input = await open(src, "r")
  const output = await open(dest, "w")
  const queue: Uint8Array[] = []
  const gz = new Gunzip((chunk) => { queue.push(chunk) })
  try {
    const buf = Buffer.allocUnsafe(IO_CHUNK)
    let pos = 0
    for (;;) {
      const { bytesRead } = await input.read(buf, 0, IO_CHUNK, pos)
      if (bytesRead === 0) break
      const chunk = new Uint8Array(bytesRead)
      chunk.set(buf.subarray(0, bytesRead))
      gz.push(chunk)
      for (;;) {
        const out = queue.shift()
        if (!out) break
        await output.write(Buffer.from(out))
      }
      pos += bytesRead
    }
    gz.push(new Uint8Array(0), true)
    for (;;) {
      const out = queue.shift()
      if (!out) break
      await output.write(Buffer.from(out))
    }
  } finally {
    await input.close().catch(() => {})
    await output.close().catch(() => {})
  }
}

async function sha256File(file: string): Promise<string> {
  const h = createHash("sha256")
  const fh = await open(file, "r")
  try {
    const buf = Buffer.allocUnsafe(IO_CHUNK)
    let pos = 0
    for (;;) {
      const { bytesRead } = await fh.read(buf, 0, IO_CHUNK, pos)
      if (bytesRead === 0) break
      h.update(buf.subarray(0, bytesRead))
      pos += bytesRead
    }
  } finally {
    await fh.close().catch(() => {})
  }
  return h.digest("hex")
}

async function fileSize(file: string): Promise<number> {
  const st = await stat(file)
  return st.size
}

function resolveBackupDir(dirSetting: string): string {
  return path.isAbsolute(dirSetting) ? dirSetting : path.join(process.cwd(), dirSetting)
}

/** Stored paths are kept RELATIVE to the server cwd when possible (portable
 *  across hosts); absolute settings stay absolute. */
function storedPath(abs: string): string {
  const cwd = process.cwd() + path.sep
  return abs.startsWith(cwd) ? abs.slice(cwd.length) : abs
}

function resolveStoredPath(stored: string): string {
  return path.isAbsolute(stored) ? stored : path.join(process.cwd(), stored)
}

// ============================== HARD GUARD (never restore over live) ==============================

/** Refuse when a drill target would land on the LIVE database. Compares
 *  database NAME and full host:port/db coordinates; either equality → loud
 *  refusal. Mentally tested (see module header): drill names carry the
 *  hrm_drill_ prefix + UTC stamp + random suffix so they differ from the live
 *  name by construction — this guard is the defense-in-depth that fires if any
 *  future refactor breaks that construction. */
function assertDrillTargetNotLivePg(drillDatabase: string, live: PgConn): void {
  if (drillDatabase.toLowerCase() === live.database.toLowerCase()) {
    throw new Error(
      `REFUSED: the drill target database "${drillDatabase}" equals the LIVE database "${live.database}" — ` +
      `the restore drill never restores over DATABASE_URL. No changes were made.`
    )
  }
}

function assertDrillTargetNotLiveSqlite(drillFile: string, liveFile: string): void {
  if (path.resolve(drillFile) === path.resolve(liveFile)) {
    throw new Error(
      `REFUSED: the drill target file "${drillFile}" equals the LIVE database file "${liveFile}" — ` +
      `the restore drill never restores over the live SQLite database. No changes were made.`
    )
  }
}

// ============================== backup settings (SaaSSetting group "backup") ==============================

const SETTINGS_GROUP = "backup"
const settingsCache = new Map<string, { value: BackupSettings; at: number }>()
const SETTINGS_TTL_MS = 10_000

function invalidateBackupSettings() {
  settingsCache.clear()
}

export async function getBackupSettings(): Promise<BackupSettings> {
  const hit = settingsCache.get("root")
  if (hit && Date.now() - hit.at < SETTINGS_TTL_MS) return hit.value
  const rows = await db.saasSetting.findMany({ where: { group: SETTINGS_GROUP } })
  const merged = { ...DEFAULT_BACKUP_SETTINGS }
  for (const r of rows) {
    let v: unknown
    try { v = JSON.parse(r.value) } catch { v = r.value }
    switch (r.key) {
      case "enabled":
        merged.enabled = v === true || v === "true"
        break
      case "retention": {
        const n = Number(v)
        if (Number.isFinite(n) && n >= 1 && n <= 365) merged.retention = Math.floor(n)
        break
      }
      case "scheduleTime":
        if (typeof v === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(v)) merged.scheduleTime = v
        break
      case "alertEmail":
        if (typeof v === "string") merged.alertEmail = v.trim().slice(0, 160)
        break
      case "dir":
        if (typeof v === "string" && v.trim()) merged.dir = v.trim().slice(0, 200)
        break
    }
  }
  settingsCache.set("root", { value: merged, at: Date.now() })
  return merged
}

/** Direct upserts (settings.ts is frozen — its whitelist would drop this
 *  group). Storage conventions mirror settings.ts: String(bool)/String(number)/raw string. */
export async function saveBackupSettings(patch: Partial<BackupSettings>): Promise<BackupSettings> {
  for (const [key, raw] of Object.entries(patch)) {
    if (raw === undefined) continue
    let stored: string
    switch (key) {
      case "enabled":
        stored = String(raw === true)
        break
      case "retention":
        stored = String(raw)
        break
      case "scheduleTime":
      case "alertEmail":
      case "dir":
        stored = String(raw).slice(0, 200)
        break
      default:
        continue // whitelist behavior — unknown keys silently dropped
    }
    await db.saasSetting.upsert({
      where: { group_key: { group: SETTINGS_GROUP, key } },
      create: { group: SETTINGS_GROUP, key, value: stored },
      update: { value: stored },
    })
  }
  invalidateBackupSettings()
  return getBackupSettings()
}

// ============================== BgJob vendorId anchoring ==============================

const VENDOR_CACHE_KEY = Symbol.for("finix.hrm.backupPlatformVendorId")

async function platformJobVendorId(): Promise<string> {
  const g = globalThis as unknown as { [k: symbol]: { value: string; at: number } | undefined }
  const hit = g[VENDOR_CACHE_KEY]
  if (hit && Date.now() - hit.at < 60_000) return hit.value
  const v = await db.vendor.findFirst({ orderBy: { createdAt: "asc" }, select: { id: true } })
  const id = v?.id || "platform"
  g[VENDOR_CACHE_KEY] = { value: id, at: Date.now() }
  return id
}

// ============================== run submission ==============================

async function submitBackupRun(trigger: "MANUAL" | "SCHEDULED", actor: { userId: string | null; userName: string }): Promise<{ runId: string; jobId: string }> {
  const run = await db.saasBackupRun.create({ data: { type: "BACKUP", trigger, status: "PENDING" } })
  const vendorId = await platformJobVendorId()
  const jobId = await submitJob(
    { userId: actor.userId, userName: actor.userName, vendorId },
    "BACKUP_PG_DUMP",
    { runId: run.id, trigger },
    // total = real phases; maxAttempts 1 — a FAILED backup alerts the owner
    // immediately and is re-run by a human (console button / Job Center retry)
    { total: 5, priority: trigger === "SCHEDULED" ? 6 : 4, maxAttempts: 1 },
  )
  return { runId: run.id, jobId }
}

async function submitDrillRun(actor: { userId: string | null; userName: string }): Promise<{ runId: string; jobId: string }> {
  const run = await db.saasBackupRun.create({ data: { type: "DRILL", trigger: "MANUAL", status: "PENDING" } })
  const vendorId = await platformJobVendorId()
  const jobId = await submitJob(
    { userId: actor.userId, userName: actor.userName, vendorId },
    "RESTORE_DRILL",
    { runId: run.id, trigger: "MANUAL" },
    // maxAttempts 1 — a failed drill is a human-visible incident (24 h guard
    // would otherwise be bypassed by engine-level auto-retries)
    { total: 6, priority: 4, maxAttempts: 1 },
  )
  return { runId: run.id, jobId }
}

/** Find (or create, for jobs submitted outside this module's actions) the
 *  SaasBackupRun row a BgJob payload points at. */
async function ensureRunRow(type: "BACKUP" | "DRILL", payload: Record<string, unknown>): Promise<string> {
  const runId = typeof payload.runId === "string" ? payload.runId : null
  if (runId) {
    const existing = await db.saasBackupRun.findUnique({ where: { id: runId }, select: { id: true, type: true } })
    if (existing && existing.type === type) return existing.id
  }
  const trigger = payload.trigger === "SCHEDULED" ? "SCHEDULED" : "MANUAL"
  const created = await db.saasBackupRun.create({ data: { type, trigger, status: "PENDING" } })
  return created.id
}

// ============================== failure alerting ==============================

async function resolveAlertEmail(): Promise<string | null> {
  const s = await getBackupSettings()
  if (s.alertEmail.trim()) return s.alertEmail.trim()
  const owner = await db.saasOwnerUser.findFirst({
    where: { roleKey: "SUPER_ADMIN", status: "ACTIVE" },
    orderBy: { createdAt: "asc" },
    select: { email: true },
  })
  return owner?.email || null
}

async function alertBackupFailure(kind: "BACKUP" | "DRILL", message: string): Promise<void> {
  try {
    const to = await resolveAlertEmail()
    const subject = kind === "BACKUP" ? "Finix HR — database backup FAILED" : "Finix HR — restore drill FAILED"
    if (!to) {
      await logPlatformNotification("EMAIL", subject, [], {
        status: "SKIPPED",
        detail: "no alert email configured and no ACTIVE SUPER_ADMIN owner user found",
      })
      return
    }
    const body =
      `A ${kind === "BACKUP" ? "database backup" : "restore drill"} run failed on the Finix HR platform.\n\n` +
      `Error: ${message.slice(0, 800)}\n\n` +
      `Open the owner console → Backup & Recovery for the full run history and report.\n` +
      `If failures persist, check the database client tools (pg_dump / psql / sqlite3 on PATH) and ` +
      `docs/postgresql-backup-restore.md for the deploy/backup.timer path.\n\n— Finix HR Platform (backup engine)`
    const res = await sendPlatformEmail(to, subject, body)
    await logPlatformNotification("EMAIL", subject, [to], res)
  } catch (e) {
    console.error("[backup] failure alert could not be sent:", e instanceof Error ? e.message : e)
  }
  // Phase 5 P0 (Scope 5) — alert-routing webhook (Settings → Alert Routing).
  // Best-effort like the email leg: a webhook failure never masks the
  // original backup error, and SKIPPED (no URL configured) is silent.
  try {
    const { getSaasSettings } = await import("./settings")
    const { sendPlatformAlertWebhook } = await import("./notify")
    const settings = await getSaasSettings()
    if (settings.alerts?.webhookOnBackupFailure !== false) {
      await sendPlatformAlertWebhook(
        kind === "BACKUP" ? "BACKUP_FAILED" : "RESTORE_DRILL_FAILED",
        kind === "BACKUP" ? "Finix HR — database backup FAILED" : "Finix HR — restore drill FAILED",
        message.slice(0, 800),
      )
    }
  } catch { /* alert routing is best-effort — never mask the run error */ }
}

// ============================== retention pruning ==============================

/** Keep the newest `keep` DONE-backup artifacts on disk; delete files recorded
 *  by older runs. Only files THIS engine recorded are ever unlinked (paths come
 *  from SaasBackupRun rows, never a directory scan — scripts/backup.sh's
 *  hrm-*.dump* artifacts are never touched). Returns the kept count. */
async function pruneRetention(keep: number): Promise<number> {
  const where = { type: "BACKUP", status: "DONE" } as const
  const total = await db.saasBackupRun.count({ where })
  const victims = await db.saasBackupRun.findMany({
    where: { ...where, locationPath: { not: null } },
    orderBy: { startedAt: "desc" },
    skip: keep,
    take: 200,
    select: { locationPath: true },
  })
  for (const v of victims) {
    if (!v.locationPath) continue
    await unlink(resolveStoredPath(v.locationPath)).catch(() => {}) // already gone offsite/moved — fine
  }
  return Math.min(keep, total)
}

// ============================== runBackup (BACKUP_PG_DUMP runner) ==============================

/** Phase progress: 0 start · 1 dump · 2 compress/encrypt · 3 checksum · 4 recorded · 5 pruned (total 5). */
export async function runBackup(job: BgJobLike, progress: ProgressCb): Promise<unknown> {
  const payload = safeJson<Record<string, unknown>>(job.payloadJson, {})
  const runId = await ensureRunRow("BACKUP", payload)
  await db.saasBackupRun.update({ where: { id: runId }, data: { status: "RUNNING", startedAt: new Date(), error: null } })
  const t0 = Date.now()
  const temps: string[] = [] // temp dump files — always deleted
  let artifact: string | null = null // deleted on failure only
  try {
    await progress(0)
    const settings = await getBackupSettings()
    const dir = resolveBackupDir(settings.dir)
    await mkdir(dir, { recursive: true })
    const stamp = utcStamp()
    // OPS-1 (Phase 3 WS-C) — the dump reads the BACKUP SOURCE (a read replica
    // via HRM_BACKUP_SOURCE_URL when configured) so pg_dump's full scan never
    // lands on the serving primary. All other operations (drill targets, run
    // rows) keep using the app's own DATABASE_URL.
    const flavor = detectDbFlavor(backupSourceUrl())
    if (flavor.kind === "unknown") {
      throw new Error("Neither HRM_BACKUP_SOURCE_URL nor DATABASE_URL is a postgresql:// or sqlite file: URL — refusing to guess a backup target (mirrors scripts/backup.sh's no-guess rule).")
    }
    const encrypt = backupEncryptionEnabled()
    const encKey = encrypt ? String(process.env.HRM_BACKUP_KEY) : null

    // ---- phase 1: logical dump → temp file inside the backup directory ----
    // OPS-2 (Phase 3 WS-C) — PostgreSQL dumps now use pg_dump --format=custom:
    // the archive is compressed by pg_dump itself (no in-process gzip over the
    // event loop — the old fflate pass blocked ALL http traffic per 4MB chunk)
    // and restores via pg_restore (parallelizable, selective). The SQLite path
    // keeps VACUUM INTO + fflate gzip (dev flavor, small files).
    let dumpFormat: string
    if (flavor.kind === "postgresql") {
      dumpFormat = "pg_dump --format=custom --no-owner --no-privileges (PostgreSQL, self-compressed)"
      const dumpPath = path.join(dir, `hrm-${stamp}.dump.tmp`)
      temps.push(dumpPath)
      const res = await runChild(
        "pg_dump",
        ["--file", dumpPath, "--format=custom", "--no-owner", "--no-privileges"],
        { env: pgToolEnv(flavor.conn, flavor.conn.database), timeoutMs: TOOL_TIMEOUT_DUMP_MS },
      )
      if (res.code !== 0) throw toolError("pg_dump", res, pgSecrets(flavor.conn), TOOL_TIMEOUT_DUMP_MS)
    } else {
      dumpFormat = "sqlite3 VACUUM INTO (consistent snapshot)"
      const dumpPath = path.join(dir, `hrm-${stamp}.db.tmp`)
      temps.push(dumpPath)
      const res = await runChild("sqlite3", [flavor.file, `VACUUM INTO ${sqlStr(dumpPath)}`], { timeoutMs: TOOL_TIMEOUT_DUMP_MS })
      if (res.code !== 0) throw toolError("sqlite3", res, [], TOOL_TIMEOUT_DUMP_MS)
    }
    await progress(1)

    // ---- phase 2: compress (sqlite only) + encrypt at rest (OPS-1) ----
    const dumpTmp = temps[0]
    const dumpBytes = await fileSize(dumpTmp)
    let plainArtifact: string
    if (flavor.kind === "postgresql") {
      // Hotfix #3 (2026-10-22, post-delivery) — the .tmp → final rename was
      // MISSING after the Phase-3 WS-C custom-format rework: pg_dump wrote
      // hrm-<stamp>.dump.tmp, then encryptFile/sha256File opened the
      // never-created hrm-<stamp>.dump → ENOENT on EVERY PostgreSQL backup
      // (both encrypted and plain — the plain leg just failed later, at the
      // checksum). The test container ships no pg_dump, so no test had ever
      // run this leg end-to-end; a stub-pg_dump regression suite now does.
      // rename() is same-directory (same volume) — atomic on POSIX and safe
      // on Windows (pg_dump has exited; nothing else holds the file open).
      plainArtifact = path.join(dir, `hrm-${stamp}.dump`)
      await rename(dumpTmp, plainArtifact)
    } else {
      plainArtifact = path.join(dir, `hrm-${stamp}.db.gz`)
      await gzipFile(dumpTmp, plainArtifact)
    }
    // The PLAIN artifact is a temp ONLY while encryption is about to replace
    // it with the final .enc — otherwise it IS the deliverable and must
    // survive the finally-cleanup. (Hotfix #3: the sqlite leg used to push
    // unconditionally, so a no-encrypt run deleted its own artifact in the
    // finally — the DONE row then pointed at a file that no longer existed.)
    if (encrypt && encKey) {
      temps.push(plainArtifact)
      artifact = plainArtifact + ".enc"
      await encryptFile(plainArtifact, artifact, encKey)
      await unlink(plainArtifact).catch(() => {})
    } else {
      artifact = plainArtifact
    }
    await progress(2)

    // ---- phase 3: sha256 of the artifact (the bytes actually on disk) ----
    const checksum = await sha256File(artifact)
    const artifactBytes = await fileSize(artifact)
    await progress(3)

    // ---- phase 4: record the DONE run row ----
    await db.saasBackupRun.update({
      where: { id: runId },
      data: {
        status: "DONE",
        finishedAt: new Date(),
        sizeBytes: clampInt4(artifactBytes),
        checksum,
        locationType: "LOCAL",
        locationPath: storedPath(artifact),
        error: null,
        reportJson: JSON.stringify({
          flavor: flavor.kind,
          format: dumpFormat,
          encrypted: encrypt,
          source: process.env.HRM_BACKUP_SOURCE_URL?.trim() ? "HRM_BACKUP_SOURCE_URL (replica)" : "DATABASE_URL",
          compression: flavor.kind === "postgresql" ? "pg_dump custom (internal)" : "fflate gzip",
          dumpBytes,
          artifactBytes,
          durationMs: Date.now() - t0,
        }),
      },
    })
    await progress(4)

    // ---- phase 5: retention pruning ----
    const kept = await pruneRetention(settings.retention)
    await db.saasBackupRun.update({ where: { id: runId }, data: { retentionKept: kept } })
    await progress(5)

    return {
      runId,
      type: "BACKUP",
      artifact: storedPath(artifact),
      sizeBytes: artifactBytes,
      checksum,
      encrypted: encrypt,
      retentionKept: kept,
      durationMs: Date.now() - t0,
    }
  } catch (e) {
    const cancelled = e instanceof JobCancelledError
    const msg = cancelled ? "Cancelled by operator mid-run" : String((e as Error)?.message || e)
    await db.saasBackupRun.update({
      where: { id: runId },
      data: { status: "FAILED", finishedAt: new Date(), error: msg.slice(0, 1000) },
    }).catch(() => {})
    if (!cancelled) await alertBackupFailure("BACKUP", msg)
    throw e // the BgJob engine records FAILED/CANCELLED + run log + dead-letters
  } finally {
    for (const t of temps) await unlink(t).catch(() => {})
    // a failed run never leaves a half-written artifact behind
    if (artifact) {
      const done = await db.saasBackupRun.findUnique({ where: { id: runId }, select: { status: true } }).catch(() => null)
      if (done && done.status !== "DONE") await unlink(artifact).catch(() => {})
    }
  }
}

/** SQLite string literal (for VACUUM INTO paths). */
function sqlStr(s: string): string {
  return `'${s.replace(/'/g, "''")}'`
}

// ============================== runRestoreDrill (RESTORE_DRILL runner) ==============================

type DrillCount = { table: string; source: number; restored: number; match: boolean }

type DrillReport = {
  artifact: string | null
  artifactBytes: number | null
  checksumVerified: boolean
  restoredTables: number | null
  counts: DrillCount[]
  pass: boolean
  notes: string[]
  durationMs: number
  drilledAt: string
}

/** Phase progress: 0 start · 1 located+verified · 2 target prepared · 3 restored ·
 *  4 counted+compared · 5 temp target dropped · 6 recorded (total 6). */
export async function runRestoreDrill(job: BgJobLike, progress: ProgressCb): Promise<unknown> {
  const payload = safeJson<Record<string, unknown>>(job.payloadJson, {})
  const runId = await ensureRunRow("DRILL", payload)
  await db.saasBackupRun.update({ where: { id: runId }, data: { status: "RUNNING", startedAt: new Date(), error: null } })
  const t0 = Date.now()
  const temps: string[] = [] // temp decompressed dump files — always deleted
  let pgDrillDb: string | null = null // created drill database — always dropped
  const notes: string[] = [
    "core-table counts must match exactly (vendor, employee, payroll run, attendance, account journal)",
    "volatile tables (sessions, throttle buckets, the BgJob queue) are excluded on purpose: the live database keeps mutating between dump and count, so their deltas carry no signal",
  ]
  try {
    await progress(0)

    // ---- phase 1: locate the latest completed artifact + verify checksum ----
    const latest = await db.saasBackupRun.findFirst({
      where: { type: "BACKUP", status: "DONE", locationPath: { not: null }, checksum: { not: null } },
      orderBy: { startedAt: "desc" },
      select: { id: true, locationPath: true, checksum: true, sizeBytes: true },
    })
    if (!latest || !latest.locationPath || !latest.checksum) {
      throw new Error("No completed backup artifact exists to drill against — run a backup first (Backup & Recovery → Run Backup Now).")
    }
    const artifactAbs = resolveStoredPath(latest.locationPath)
    const artifactBytes = await fileSize(artifactAbs).catch(() => null)
    if (artifactBytes == null) {
      throw new Error(`Backup artifact is missing on disk: ${latest.locationPath} (pruned or moved?) — run a new backup before drilling.`)
    }
    const actualChecksum = await sha256File(artifactAbs)
    const checksumVerified = actualChecksum === latest.checksum
    if (!checksumVerified) {
      // a corrupt/truncated artifact must still produce an honest report row
      const report: DrillReport = {
        artifact: latest.locationPath,
        artifactBytes,
        checksumVerified: false,
        restoredTables: null,
        counts: [],
        pass: false,
        notes: ["artifact checksum does not match the recorded value — the backup is corrupt or truncated; the drill aborted before touching any database"],
        durationMs: Date.now() - t0,
        drilledAt: new Date().toISOString(),
      }
      const err = new Error(`Drill failed: checksum mismatch for ${latest.locationPath} (expected ${latest.checksum.slice(0, 12)}…, got ${actualChecksum.slice(0, 12)}…) — the backup is corrupt or truncated.`)
      ;(err as Error & { drillReport?: DrillReport }).drillReport = report
      throw err
    }
    await progress(1)

    // ---- phases 2–4: restore into a TEMP target + compare counts ----
    // OPS-1/OPS-2 (Phase 3 WS-C) — the drill understands EVERY artifact flavor
    // this engine has ever written (and stays compatible with pre-Phase-3
    // artifacts): .dump[.enc] (pg_dump custom, restored via pg_restore),
    // .sql.gz[.enc] (legacy plain SQL, gunzip + psql), .db.gz[.enc] (SQLite).
    const flavor = detectDbFlavor(process.env.DATABASE_URL)
    const artifactFlavor = backupArtifactFlavor(latest.locationPath)
    const artifactIsEncrypted = latest.locationPath.endsWith(".enc")
    const counts: DrillCount[] = []
    let restoredTables: number | null = null
    if (flavor.kind === "postgresql") {
      if (artifactFlavor !== "pg-custom" && artifactFlavor !== "pg-plain-gz") {
        throw new Error(`Backup artifact ${latest.locationPath} is a ${artifactFlavor} flavor but DATABASE_URL is PostgreSQL — flavor mismatch (was the artifact created by a different deployment mode?).`)
      }
      // drill database name: lowercase, stamped, random suffix — a valid PG
      // identifier that can never equal the live database name by construction
      const drillDb = `hrm_drill_${utcStamp().toLowerCase()}_${randomBytes(3).toString("hex")}`
      // HARD GUARD #1 — before the target is even created
      assertDrillTargetNotLivePg(drillDb, flavor.conn)
      const conn = flavor.conn
      const create = await runChild(
        "psql",
        ["-X", "-v", "ON_ERROR_STOP=1", "-c", `CREATE DATABASE ${sqlIdent(drillDb)}`],
        { env: pgToolEnv(conn, "postgres"), timeoutMs: TOOL_TIMEOUT_SHORT_MS },
      )
      if (create.code !== 0) throw toolError("psql (create drill database)", create, pgSecrets(conn), TOOL_TIMEOUT_SHORT_MS)
      pgDrillDb = drillDb
      // decrypt (when encrypted) and/or decompress to a temp RESTORE input
      const tmpBase = path.join(os.tmpdir(), `hrm-drill-${utcStamp()}`)
      if (artifactIsEncrypted) {
        const encKey = String(process.env.HRM_BACKUP_KEY || "")
        if (!encKey.trim()) throw new Error(`Backup artifact ${latest.locationPath} is encrypted but HRM_BACKUP_KEY is not configured — set it to run restore drills.`)
        const tmpPlain = tmpBase + (artifactFlavor === "pg-custom" ? ".dump" : ".sql.gz")
        temps.push(tmpPlain)
        await decryptFile(artifactAbs, tmpPlain, encKey)
        if (artifactFlavor === "pg-custom") {
          const tmpDump = tmpPlain
          await progress(2)
          // HARD GUARD #2 — belt-and-suspenders immediately before the restore
          assertDrillTargetNotLivePg(drillDb, conn)
          const restore = await runChild(
            "pg_restore",
            ["--dbname", drillDb, "--no-owner", "--no-privileges", "--exit-on-error", tmpDump],
            { env: pgToolEnv(conn, drillDb), timeoutMs: TOOL_TIMEOUT_DUMP_MS },
          )
          if (restore.code !== 0) throw toolError("pg_restore (restore into drill database)", restore, pgSecrets(conn), TOOL_TIMEOUT_DUMP_MS)
        } else {
          const tmpSql = tmpBase + ".sql"
          temps.push(tmpSql)
          await gunzipFile(tmpPlain, tmpSql)
          await progress(2)
          assertDrillTargetNotLivePg(drillDb, conn)
          const restore = await runChild(
            "psql",
            ["-X", "-v", "ON_ERROR_STOP=1", "--file", tmpSql],
            { env: pgToolEnv(conn, drillDb), timeoutMs: TOOL_TIMEOUT_DUMP_MS },
          )
          if (restore.code !== 0) throw toolError("psql (restore into drill database)", restore, pgSecrets(conn), TOOL_TIMEOUT_DUMP_MS)
        }
      } else if (artifactFlavor === "pg-custom") {
        // unencrypted custom-format archive: pg_restore reads the file directly
        // (no temp copy — the artifact is read-only input)
        await progress(2)
        assertDrillTargetNotLivePg(drillDb, conn)
        const restore = await runChild(
          "pg_restore",
          ["--dbname", drillDb, "--no-owner", "--no-privileges", "--exit-on-error", artifactAbs],
          { env: pgToolEnv(conn, drillDb), timeoutMs: TOOL_TIMEOUT_DUMP_MS },
        )
        if (restore.code !== 0) throw toolError("pg_restore (restore into drill database)", restore, pgSecrets(conn), TOOL_TIMEOUT_DUMP_MS)
      } else {
        // legacy unencrypted plain-SQL artifact (pre-Phase-3)
        const tmpSql = tmpBase + ".sql"
        temps.push(tmpSql)
        await gunzipFile(artifactAbs, tmpSql)
        await progress(2)
        assertDrillTargetNotLivePg(drillDb, conn)
        const restore = await runChild(
          "psql",
          ["-X", "-v", "ON_ERROR_STOP=1", "--file", tmpSql],
          { env: pgToolEnv(conn, drillDb), timeoutMs: TOOL_TIMEOUT_DUMP_MS },
        )
        if (restore.code !== 0) throw toolError("psql (restore into drill database)", restore, pgSecrets(conn), TOOL_TIMEOUT_DUMP_MS)
      }
      await progress(3)
      restoredTables = await pgScalar(conn, drillDb, "SELECT count(*) FROM pg_tables WHERE schemaname = 'public'")
      for (const table of CORE_TABLES) {
        const source = await sourceCount(table)
        const restored = await pgScalar(conn, drillDb, `SELECT count(*) FROM ${sqlIdent(table)}`)
        counts.push({ table, source, restored, match: source === restored })
      }
    } else if (flavor.kind === "sqlite") {
      const tmpDb = path.join(os.tmpdir(), `hrm-drill-${utcStamp()}.db`)
      // HARD GUARD #1 — before the temp file is written
      assertDrillTargetNotLiveSqlite(tmpDb, flavor.file)
      temps.push(tmpDb)
      if (artifactIsEncrypted) {
        const encKey = String(process.env.HRM_BACKUP_KEY || "")
        if (!encKey.trim()) throw new Error(`Backup artifact ${latest.locationPath} is encrypted but HRM_BACKUP_KEY is not configured — set it to run restore drills.`)
        const tmpGz = tmpDb + ".gz"
        temps.push(tmpGz)
        await decryptFile(artifactAbs, tmpGz, encKey)
        await gunzipFile(tmpGz, tmpDb)
      } else {
        await gunzipFile(artifactAbs, tmpDb)
      }
      await progress(2)
      // HARD GUARD #2 — immediately before counts are read (the restore IS the
      // gunzip for SQLite; the target is the temp file, never the live one)
      assertDrillTargetNotLiveSqlite(tmpDb, flavor.file)
      await progress(3)
      restoredTables = await sqliteScalar(tmpDb, "SELECT count(*) FROM sqlite_master WHERE type = 'table'")
      for (const table of CORE_TABLES) {
        const source = await sourceCount(table)
        const restored = await sqliteScalar(tmpDb, `SELECT count(*) FROM ${sqlIdent(table)}`)
        counts.push({ table, source, restored, match: source === restored })
      }
    } else {
      throw new Error("DATABASE_URL is neither a postgresql:// nor a sqlite file: URL — the drill cannot determine a safe temp target.")
    }
    await progress(4)

    // ---- phase 5: drop the temp database (temp files cleaned in finally) ----
    if (pgDrillDb) {
      await dropDrillDatabase(pgDrillDb)
      pgDrillDb = null
    }
    await progress(5)

    // ---- verdict + phase 6: record the drill row with the full report ----
    // A count mismatch is a FAILED drill (P1 — "the backups are the incident",
    // docs/postgresql-backup-restore.md §5): the full report is attached to the
    // FAILED row via the carried drillReport, exactly like the checksum path.
    const pass = checksumVerified && counts.every((c) => c.match)
    const report: DrillReport = {
      artifact: latest.locationPath,
      artifactBytes,
      checksumVerified,
      restoredTables,
      counts,
      pass,
      notes,
      durationMs: Date.now() - t0,
      drilledAt: new Date().toISOString(),
    }
    if (!pass) {
      const mismatched = counts.filter((c) => !c.match).map((c) => c.table)
      const err = new Error(
        `Drill FAILED: core-table count mismatch (${mismatched.join(", ") || "unknown table"}) — ` +
        `the backup does not reproduce the live row counts. Treat as P1 (docs/postgresql-backup-restore.md §5).`
      )
      ;(err as Error & { drillReport?: DrillReport }).drillReport = report
      throw err
    }
    await db.saasBackupRun.update({
      where: { id: runId },
      data: {
        status: "DONE",
        finishedAt: new Date(),
        sizeBytes: clampInt4(artifactBytes ?? 0),
        checksum: latest.checksum,
        locationType: "LOCAL",
        locationPath: latest.locationPath,
        reportJson: JSON.stringify(report),
        error: null,
      },
    })
    await progress(6)
    return report
  } catch (e) {
    const cancelled = e instanceof JobCancelledError
    const msg = cancelled ? "Cancelled by operator mid-run" : String((e as Error)?.message || e)
    const partial = (e as Error & { drillReport?: DrillReport })?.drillReport ?? null
    await db.saasBackupRun.update({
      where: { id: runId },
      data: {
        status: "FAILED",
        finishedAt: new Date(),
        error: msg.slice(0, 1000),
        reportJson: partial ? JSON.stringify(partial) : undefined,
      },
    }).catch(() => {})
    if (!cancelled) await alertBackupFailure("DRILL", msg)
    throw e
  } finally {
    // NEVER skipped: the drill database is dropped and temp files removed even
    // when the drill itself failed midway.
    if (pgDrillDb) await dropDrillDatabase(pgDrillDb)
    for (const t of temps) await unlink(t).catch(() => {})
  }
}

/** Best-effort DROP of the scratch drill database — issued from the standard
 *  `postgres` maintenance database (never from the live one) and only ever
 *  naming the hrm_drill_* scratch target. A failed DROP leaves a stray scratch
 *  database (visible in pg_tables listings), never data loss. */
async function dropDrillDatabase(name: string): Promise<void> {
  const flavor = detectDbFlavor(process.env.DATABASE_URL)
  if (flavor.kind !== "postgresql") return
  await runChild(
    "psql",
    ["-X", "-v", "ON_ERROR_STOP=0", "-c", `DROP DATABASE IF EXISTS ${sqlIdent(name)} WITH (FORCE)`],
    { env: pgToolEnv(flavor.conn, "postgres"), timeoutMs: TOOL_TIMEOUT_SHORT_MS },
  ).catch(() => null)
}

// ============================== count helpers ==============================

/** Live-side count via the app's own Prisma client. The table name comes from
 *  the CORE_TABLES whitelist constant (never user input), so identifier
 *  interpolation through $queryRawUnsafe is safe by construction. */
async function sourceCount(table: string): Promise<number> {
  const rows = await db.$queryRawUnsafe<Array<{ count: bigint | number }>>(`SELECT count(*) AS count FROM ${sqlIdent(table)}`)
  return Number(rows[0]?.count ?? 0)
}

async function pgScalar(conn: PgConn, database: string, sql: string): Promise<number> {
  const res = await runChild("psql", ["-X", "-t", "-A", "-c", sql], { env: pgToolEnv(conn, database), timeoutMs: TOOL_TIMEOUT_SHORT_MS })
  if (res.code !== 0) throw toolError("psql", res, pgSecrets(conn), TOOL_TIMEOUT_SHORT_MS)
  const n = Number(res.stdout.trim())
  if (!Number.isFinite(n)) throw new Error(`psql returned a non-numeric value for: ${sql.slice(0, 80)}`)
  return n
}

async function sqliteScalar(dbFile: string, sql: string): Promise<number> {
  const res = await runChild("sqlite3", [dbFile, `${sql};`], { timeoutMs: TOOL_TIMEOUT_SHORT_MS })
  if (res.code !== 0) throw toolError("sqlite3", res, [], TOOL_TIMEOUT_SHORT_MS)
  const n = Number(res.stdout.trim())
  if (!Number.isFinite(n)) throw new Error(`sqlite3 returned a non-numeric value for: ${sql.slice(0, 80)}`)
  return n
}

// ============================== nightly schedule (cron-free piggyback) ==============================

/** "Now" in the schedule timezone: ISO date + minutes since midnight. */
function tzParts(d = new Date()): { date: string; minutes: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: SCHEDULE_TZ, hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  }).formatToParts(d)
  const get = (t: string) => parts.find((p) => p.type === t)?.value || ""
  return { date: `${get("year")}-${get("month")}-${get("day")}`, minutes: Number(get("hour")) * 60 + Number(get("minute")) }
}

/** UTC instant of "today 00:00 Asia/Dhaka". */
function tzDayStartUtc(): Date {
  const [y, m, d] = tzParts().date.split("-").map(Number)
  return new Date(Date.UTC(y, m - 1, d, 0, 0, 0) - DHAKA_UTC_OFFSET_MIN * 60_000)
}

const SCHEDULE_GUARD_KEY = Symbol.for("finix.hrm.backupScheduleGuard")

/**
 * The cron-free nightly scheduler (see module header). Called lazily from
 * owner.backup.list + the System Health snapshot; force=true (the
 * owner.backup.schedule.check action) bypasses the 60 s throttle.
 */
export async function maybeRunScheduledBackup(force = false): Promise<{ submitted: boolean; reason: string; runId?: string; jobId?: string }> {
  const g = globalThis as unknown as { [k: symbol]: { at: number; inflight: Promise<{ submitted: boolean; reason: string; runId?: string; jobId?: string }> | null } | undefined }
  const guard = (g[SCHEDULE_GUARD_KEY] ||= { at: 0, inflight: null })
  if (guard.inflight) return guard.inflight
  if (!force && Date.now() - guard.at < 60_000) {
    return { submitted: false, reason: "schedule checked within the last 60 s" }
  }
  const p = (async () => {
    try {
      const s = await getBackupSettings()
      if (!s.enabled) return { submitted: false, reason: "nightly backup disabled in backup settings" }
      const now = tzParts()
      const [hh, mm] = s.scheduleTime.split(":").map(Number)
      if (now.minutes < hh * 60 + mm) {
        return { submitted: false, reason: `not yet due — scheduled for ${s.scheduleTime} ${SCHEDULE_TZ}` }
      }
      const ranToday = await db.saasBackupRun.count({
        where: { type: "BACKUP", trigger: "SCHEDULED", startedAt: { gte: tzDayStartUtc() } },
      })
      if (ranToday > 0) return { submitted: false, reason: "scheduled backup already ran today" }
      const inFlight = await db.saasBackupRun.count({
        where: { type: "BACKUP", status: { in: ["PENDING", "RUNNING"] } },
      })
      if (inFlight > 0) return { submitted: false, reason: "another backup is already in flight — the schedule defers to it" }
      // SCL-21 (Phase 3 WS-B) — cluster-wide once-per-day claim. The globalThis
      // guard above only dedups THIS process; behind a load balancer two
      // instances could both pass the ranToday=0 check and double-submit. The
      // claim is a distributed lock held until the next Dhaka midnight (TTL =
      // the claim; never released early). Losers see "already claimed today".
      const claimed = await claimPeriodAction(`backup-scheduled:${now.date}`, tzDayStartUtc().getTime() + 24 * 3600_000)
      if (!claimed) return { submitted: false, reason: "scheduled backup already claimed by another instance today" }
      const out = await submitBackupRun("SCHEDULED", { userId: null, userName: "Nightly schedule (tick + console traffic piggyback)" })
      await saasAudit(
        { name: "Platform (nightly backup schedule)" },
        "BACKUP_RUN_SUBMITTED",
        "SaasBackupRun",
        out.runId,
        `Scheduled backup submitted by the piggyback scheduler (past ${s.scheduleTime} ${SCHEDULE_TZ}, none ran today; BgJob ${out.jobId})`,
        { metadata: { trigger: "SCHEDULED", jobId: out.jobId, scheduleTime: s.scheduleTime, timezone: SCHEDULE_TZ } },
      )
      return { submitted: true, reason: `scheduled backup submitted (past ${s.scheduleTime} ${SCHEDULE_TZ}, none had run today)`, runId: out.runId, jobId: out.jobId }
    } finally {
      guard.at = Date.now()
    }
  })()
  guard.inflight = p
  try {
    return await p
  } finally {
    guard.inflight = null
  }
}

// ============================== serialization ==============================

type BackupRunRow = {
  id: string
  type: string
  trigger: string
  status: string
  startedAt: Date
  finishedAt: Date | null
  sizeBytes: number | null
  checksum: string | null
  locationType: string
  locationPath: string | null
  retentionKept: number | null
  error: string | null
  reportJson: string | null
  createdAt: Date
}

function serializeRun(r: BackupRunRow) {
  return {
    id: r.id,
    type: r.type,
    trigger: r.trigger,
    status: r.status,
    startedAt: r.startedAt.toISOString(),
    finishedAt: r.finishedAt ? r.finishedAt.toISOString() : null,
    sizeBytes: r.sizeBytes,
    checksum: r.checksum,
    locationType: r.locationType,
    locationPath: r.locationPath,
    retentionKept: r.retentionKept,
    error: r.error,
    hasReport: !!r.reportJson,
    createdAt: r.createdAt.toISOString(),
  }
}

const RUN_SELECT = {
  id: true, type: true, trigger: true, status: true, startedAt: true, finishedAt: true,
  sizeBytes: true, checksum: true, locationType: true, locationPath: true,
  retentionKept: true, error: true, reportJson: true, createdAt: true,
} as const

// ============================== owner actions ==============================

// owner.backup.run — perm settings.manage (no backup.* permission exists in the
// frozen OWNER_PERMISSIONS vocabulary; settings.manage is the documented gate
// for privileged platform operations, settings.view for reads).
ownerAction("owner.backup.run", {
  perm: "settings.manage",
  schema: z.object({ type: z.enum(["BACKUP", "DRILL"]) }),
  handler: async (ctx, p) => {
    // one concurrent run of this type (queued OR executing) → 429
    const inFlight = await db.saasBackupRun.count({
      where: { type: p.type, status: { in: ["PENDING", "RUNNING"] } },
    })
    if (inFlight > 0) {
      throw Object.assign(
        new Error(`A ${p.type === "BACKUP" ? "backup" : "restore drill"} is already queued or running — wait for it to finish.`),
        { code: 429 },
      )
    }
    if (p.type === "DRILL") {
      // drills run at most once per 24 h (latest finished DONE/FAILED)
      const last = await db.saasBackupRun.findFirst({
        where: { type: "DRILL", status: { in: ["DONE", "FAILED"] } },
        orderBy: { startedAt: "desc" },
        select: { startedAt: true, finishedAt: true },
      })
      const lastAt = last?.finishedAt ?? last?.startedAt ?? null
      if (lastAt && Date.now() - lastAt.getTime() < 24 * 3_600_000) {
        const waitH = Math.ceil((24 * 3_600_000 - (Date.now() - lastAt.getTime())) / 3_600_000)
        throw Object.assign(
          new Error(`A restore drill already ran within the last 24 h (last: ${lastAt.toISOString()}). Drills are limited to one per day — try again in ~${waitH} h.`),
          { code: 429 },
        )
      }
    }
    const out = p.type === "BACKUP"
      ? await submitBackupRun("MANUAL", { userId: ctx.ownerId, userName: ctx.name })
      : await submitDrillRun({ userId: ctx.ownerId, userName: ctx.name })
    await saasAudit(
      ctx,
      "BACKUP_RUN_SUBMITTED",
      "SaasBackupRun",
      out.runId,
      `${p.type} run submitted from the owner console (BgJob ${out.jobId})`,
      { metadata: { type: p.type, trigger: "MANUAL", jobId: out.jobId } },
    )
    // the type-to-confirm gate lives in the UI; the server enforces the real
    // invariants above (concurrency + drill cadence)
    return { jobId: out.jobId, runId: out.runId, type: p.type }
  },
})

// owner.backup.list — perm settings.view. Also the primary piggyback point for
// the cron-free nightly schedule.
ownerAction("owner.backup.list", {
  perm: "settings.view",
  schema: z.object({ limit: z.number().int().min(1).max(100).default(25) }),
  handler: async (_ctx, p) => {
    const scheduleCheck = await maybeRunScheduledBackup().catch((e) => ({
      submitted: false,
      reason: `schedule check failed: ${String((e as Error)?.message || e).slice(0, 160)}`,
    }))
    const [total, rows, lastBackup, lastDrill, backupInFlight, drillInFlight, ranToday, settings] = await Promise.all([
      db.saasBackupRun.count(),
      db.saasBackupRun.findMany({ orderBy: { startedAt: "desc" }, take: p.limit, select: RUN_SELECT }),
      db.saasBackupRun.findFirst({ where: { type: "BACKUP" }, orderBy: { startedAt: "desc" }, select: RUN_SELECT }),
      db.saasBackupRun.findFirst({ where: { type: "DRILL" }, orderBy: { startedAt: "desc" }, select: RUN_SELECT }),
      db.saasBackupRun.count({ where: { type: "BACKUP", status: { in: ["PENDING", "RUNNING"] } } }),
      db.saasBackupRun.count({ where: { type: "DRILL", status: { in: ["PENDING", "RUNNING"] } } }),
      db.saasBackupRun.count({ where: { type: "BACKUP", trigger: "SCHEDULED", startedAt: { gte: tzDayStartUtc() } } }),
      getBackupSettings(),
    ])
    return {
      total,
      rows: rows.map(serializeRun),
      lastBackup: lastBackup ? serializeRun(lastBackup) : null,
      lastDrill: lastDrill ? serializeRun(lastDrill) : null,
      lastDrillPass: lastDrill
        ? safeJson<{ pass?: boolean }>(lastDrill.reportJson, {}).pass ?? (lastDrill.status === "DONE")
        : null,
      inFlight: { backup: backupInFlight > 0, drill: drillInFlight > 0 },
      settings,
      schedule: {
        timezone: SCHEDULE_TZ,
        ranToday: ranToday > 0,
        check: scheduleCheck.reason,
        submittedByThisCall: scheduleCheck.submitted,
      },
      dbFlavor: dbFlavorWord(),
      engineNote:
        "in-app engine: dump → gzip (fflate) → sha256 → retention → SaasBackupRun record; drills restore ONLY into a temp database/file, never the live one",
      timerNote:
        "production-grade path: deploy/backup.timer → backup.service → scripts/backup.sh (02:30 server-local, pg_dump custom format, AES-256 encryption via HRM_BACKUP_KEY, sha256 manifest, offsite sync, failure alerts) + quarterly restore-drill.timer — runs OUTSIDE the app and is unaffected by app downtime",
    }
  },
})

// owner.backup.report — perm settings.view. Full row + parsed reportJson.
ownerAction("owner.backup.report", {
  perm: "settings.view",
  schema: z.object({ id: z.string().min(1) }),
  handler: async (_ctx, p) => {
    const r = await db.saasBackupRun.findUnique({ where: { id: p.id }, select: RUN_SELECT })
    if (!r) throw Object.assign(new Error("Backup run not found."), { code: 404 })
    return {
      run: serializeRun(r),
      report: r.reportJson ? safeJson<unknown>(r.reportJson, null) : null,
    }
  },
})

// owner.backup.settings — perm settings.view (read).
ownerAction("owner.backup.settings", {
  perm: "settings.view",
  handler: async () => ({
    settings: await getBackupSettings(),
    defaults: DEFAULT_BACKUP_SETTINGS,
  }),
})

// owner.backup.settings.save — perm settings.manage (write).
ownerAction("owner.backup.settings.save", {
  perm: "settings.manage",
  schema: z.object({
    enabled: z.boolean().optional(),
    retention: z.number().int().min(1).max(365).optional(),
    scheduleTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "scheduleTime must be HH:MM (24-hour)").optional(),
    alertEmail: z.string().trim().max(160)
      .refine((v) => v === "" || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v), "alertEmail must be a valid address or empty (empty = first SUPER_ADMIN owner user)")
      .optional(),
    dir: z.string().trim().min(1).max(200).optional(),
  }),
  handler: async (ctx, p) => {
    const patch: Partial<BackupSettings> = {}
    if (p.enabled !== undefined) patch.enabled = p.enabled
    if (p.retention !== undefined) patch.retention = p.retention
    if (p.scheduleTime !== undefined) patch.scheduleTime = p.scheduleTime
    if (p.alertEmail !== undefined) patch.alertEmail = p.alertEmail
    if (p.dir !== undefined) patch.dir = p.dir
    const settings = await saveBackupSettings(patch)
    await saasAudit(
      ctx,
      "BACKUP_SETTINGS_SAVED",
      "PlatformBackup",
      null,
      `Backup settings updated — nightly ${settings.enabled ? `${settings.scheduleTime} ${SCHEDULE_TZ}` : "off"}, retention ${settings.retention}, alert ${settings.alertEmail || "first SUPER_ADMIN owner user"}, dir ${settings.dir}`,
      { metadata: { ...settings } },
    )
    return { settings }
  },
})

// owner.backup.schedule.check — perm settings.manage. Manual "trigger the
// piggyback scheduler now" (useful after downtime missed the 01:05 window).
ownerAction("owner.backup.schedule.check", {
  perm: "settings.manage",
  handler: async (ctx) => {
    const out = await maybeRunScheduledBackup(true)
    await saasAudit(
      ctx,
      "BACKUP_SCHEDULE_CHECK",
      "PlatformBackup",
      out.runId ?? null,
      `Nightly backup schedule check: ${out.submitted ? "SUBMITTED a scheduled backup" : out.reason}`,
      { metadata: { submitted: out.submitted, reason: out.reason, runId: out.runId ?? null, jobId: out.jobId ?? null } },
    )
    return out
  },
})

// ============ SEC-1 (Phase 1) — one-shot secret rotation ============
// Rotates the env-plane secrets whose live values rode in a shared artifact
// (HRM_MFA_KEY, HRM_INTERNAL_TOKEN, HRM_BACKUP_KEY):
//
//   1. generates fresh 64-char hex values with crypto.randomBytes;
//   2. rewrites .env IN PLACE for the RUNTIME keys only (HRM_MFA_KEY,
//      HRM_INTERNAL_TOKEN) — every other line — DB URLs, seed config,
//      tuning — is preserved byte-for-byte;
//   3. FORENSIC AUDIT 2026-11-10, FIN-038 (Phase 0): HRM_BACKUP_KEY is a
//      BACKUP-CHANNEL key. It is never written to .env. If a (compromised)
//      HRM_BACKUP_KEY line exists in .env it is REMOVED there, and the fresh
//      value is written to the backup channel only, in this order:
//        a. --backup-env <path>          explicit operator-supplied channel
//                                        file (e.g. /etc/systemd/system/
//                                        hrm-backup.env — mode 600);
//        b. /etc/systemd/system/hrm-backup.env when that file exists and is
//           writable;
//        c. .env.keys.local (gitignored, excluded from packaging, chmod 600)
//           as a LAST-RESORT handoff — the operator must move the value into
//           the systemd env file and delete the line (the runbook says so).
//   4. the rotation record keeps the sha256 of each OLD value only (enough
//      to audit the rotation, zero key material retained) in
//      .env.rotation-log (gitignored).
//
// FIN-038 (Phase 0) — `--purge-sessions` additionally deletes every Session
// row on the DATABASE_URL the (already rewritten) .env points at: sessions
// minted while the old HRM_INTERNAL_TOKEN / MFA key were in circulation are
// dependent on compromised material and must not survive the rotation. All
// users re-login; nothing else is touched. The full procedure — seed
// password, backup re-key, git history treatment — lives in
// docs/runbooks/secret-rotation.md.
//
// After rotation you MUST:
//   - restart the app (the boot guard refuses the old values — deliberately:
//     running this script and NOT restarting leaves the server down, which is
//     the safe direction);
//   - re-encrypt the at-rest fields that were keyed under the OLD MFA key:
//       bun run scripts/re-encrypt-fields.ts
//     (MFA secrets self-heal lazily on next verify; the script covers cameras,
//     device comm keys, webhook/AI/comms/payment credentials eagerly);
//   - re-key existing encrypted backups under the NEW backup key:
//       bash scripts/rekey-backups.sh   (see docs/runbooks/secret-rotation.md).
//
// Usage: bun run scripts/rotate-secrets.ts [--dry-run] [--purge-sessions] [--backup-env <path>]
// Idempotent: re-running replaces the runtime lines again with new values and
// rotates the backup-channel key again.
import crypto from "crypto"
import fs from "fs"
import path from "path"

const ENV_PATH = path.join(process.cwd(), ".env")
const ROTATION_LOG = path.join(process.cwd(), ".env.rotation-log")
const KEYS_LOCAL = path.join(process.cwd(), ".env.keys.local")
const SYSTEMD_BACKUP_ENV = "/etc/systemd/system/hrm-backup.env"

const RUNTIME_TARGETS = ["HRM_MFA_KEY", "HRM_INTERNAL_TOKEN"] as const
const CHANNEL_TARGET = "HRM_BACKUP_KEY" as const

function sha256(v: string): string {
  return crypto.createHash("sha256").update(v).digest("hex")
}

function readEnvRaw(): string {
  if (!fs.existsSync(ENV_PATH)) {
    console.error(`[rotate-secrets] .env not found at ${ENV_PATH}.`)
    console.error("  Create one from .env.example first (the app reads runtime configuration from .env; it is gitignored).")
    process.exit(1)
  }
  return fs.readFileSync(ENV_PATH, "utf8")
}

const argv = process.argv.slice(2)
const dryRun = argv.includes("--dry-run")
const purgeSessions = argv.includes("--purge-sessions")
const backupEnvIdx = argv.indexOf("--backup-env")
const backupEnvArg = backupEnvIdx !== -1 ? argv[backupEnvIdx + 1] : undefined

const raw = readEnvRaw()
const lines = raw.split(/\r?\n/)

const before: Record<string, string> = {}
for (const l of lines) {
  const m = l.match(/^\s*(HRM_MFA_KEY|HRM_INTERNAL_TOKEN|HRM_BACKUP_KEY)\s*=\s*(.*)$/)
  if (m && !l.trim().startsWith("#")) before[m[1]] = m[2].trim().replace(/^["']|["']$/g, "")
}

const fresh: Record<string, string> = {}
for (const k of [...RUNTIME_TARGETS, CHANNEL_TARGET]) fresh[k] = crypto.randomBytes(32).toString("hex")

// ---------- 1. rewrite .env: runtime keys in, backup key OUT (FIN-038) ----------
const CHANNEL_POINTER = [
  "# HRM_BACKUP_KEY was moved to the BACKUP channel by scripts/rotate-secrets.ts",
  "# (FORENSIC AUDIT 2026-11-10, FIN-038 Phase 0): set it ONLY in",
  "# /etc/systemd/system/hrm-backup.env (deploy/backup.service) or the restore",
  "# drill's own /etc/systemd/system/hrm-restore-drill.env — never in this file.",
].join("\n")

let replaced = 0
let added = 0
let removedChannelKey = false
let pointerAdded = false

let out = lines.map((l) => {
  const m = l.match(/^\s*(HRM_MFA_KEY|HRM_INTERNAL_TOKEN|HRM_BACKUP_KEY)\s*=/)
  if (!m || l.trim().startsWith("#")) return l
  if (m[1] === CHANNEL_TARGET) {
    // remove the line — the backup key must not live in the runtime .env
    removedChannelKey = true
    pointerAdded = true
    return CHANNEL_POINTER
  }
  replaced++
  return `${m[1]}=${fresh[m[1]]}`
}).join("\n")

// runtime keys missing from .env entirely → append (they are required)
for (const k of RUNTIME_TARGETS) {
  if (!new RegExp(`^\\s*${k}\\s*=`, "m").test(out)) {
    out += `\n${k}=${fresh[k]}`
    added++
  }
}
// a stale commented placeholder for the backup key → point it at the channel
if (!pointerAdded && new RegExp(`^\\s*#?\\s*HRM_BACKUP_KEY\\s*=`, "m").test(out) && !removedChannelKey) {
  out = out.replace(/^\s*#?\s*HRM_BACKUP_KEY\s*=.*$/m, CHANNEL_POINTER)
  pointerAdded = true
}

// ---------- 2. resolve the backup channel file (FIN-038) ----------
function resolveChannel(): { path: string; existed: boolean } | null {
  if (backupEnvArg) return { path: path.resolve(backupEnvArg), existed: fs.existsSync(backupEnvArg) }
  try {
    if (fs.existsSync(SYSTEMD_BACKUP_ENV)) return { path: SYSTEMD_BACKUP_ENV, existed: true }
    // probe writability of the systemd directory (root operator)
    fs.accessSync(path.dirname(SYSTEMD_BACKUP_ENV), fs.constants.W_OK)
    return { path: SYSTEMD_BACKUP_ENV, existed: false }
  } catch {
    return null
  }
}
const channel = resolveChannel()

function writeChannelFile(p: string, existed: boolean): void {
  let content = existed ? fs.readFileSync(p, "utf8") : "# Finix HR backup channel — sourced by deploy/backup.service (EnvironmentFile). mode 600.\n"
  if (/^\s*HRM_BACKUP_KEY\s*=/m.test(content)) {
    content = content.replace(/^\s*HRM_BACKUP_KEY\s*=.*$/m, `HRM_BACKUP_KEY=${fresh[CHANNEL_TARGET]}`)
  } else {
    content += `HRM_BACKUP_KEY=${fresh[CHANNEL_TARGET]}\n`
  }
  fs.writeFileSync(p, content, { mode: 0o600 })
  try { fs.chmodSync(p, 0o600) } catch { /* best-effort on odd filesystems */ }
}

// ---------- dry-run report ----------
if (dryRun) {
  console.log("[rotate-secrets] DRY RUN — no files written.")
  console.log(`  .env: ${replaced} runtime value(s) replaced${added ? `, ${added} appended` : ""}${removedChannelKey ? `, 1 HRM_BACKUP_KEY line REMOVED (channel-separated, FIN-038)` : ""}`)
  for (const k of [...RUNTIME_TARGETS, CHANNEL_TARGET]) {
    const old = before[k]
    console.log(`  ${k}: ${old ? `present (sha256 ${sha256(old).slice(0, 16)}…) → fresh 64-hex value` : "absent"}`)
  }
  console.log(`  backup channel: ${channel ? channel.path : "none resolvable — fresh key would go to .env.keys.local (LAST RESORT, move it to the systemd env file)"}`)
  process.exit(0)
}

fs.writeFileSync(ENV_PATH, out, { mode: 0o600 })
try { fs.chmodSync(ENV_PATH, 0o600) } catch { /* best-effort on odd filesystems */ }

// ---------- 3. write the fresh backup key to the channel ----------
let channelPathWritten: string
if (channel) {
  writeChannelFile(channel.path, channel.existed)
  channelPathWritten = channel.path
} else {
  // LAST RESORT: .env.keys.local is gitignored AND excluded from packaging
  // (scripts/package-zip.sh) — safe to hold the value until the operator
  // moves it into the systemd env file.
  let content = fs.existsSync(KEYS_LOCAL) ? fs.readFileSync(KEYS_LOCAL, "utf8") : "# operator-local key overrides — gitignored, never packaged\n"
  if (/^\s*HRM_BACKUP_KEY\s*=/m.test(content)) {
    content = content.replace(/^\s*HRM_BACKUP_KEY\s*=.*$/m, `HRM_BACKUP_KEY=${fresh[CHANNEL_TARGET]}`)
  } else {
    content += `HRM_BACKUP_KEY=${fresh[CHANNEL_TARGET]}\n`
  }
  fs.writeFileSync(KEYS_LOCAL, content, { mode: 0o600 })
  try { fs.chmodSync(KEYS_LOCAL, 0o600) } catch { /* best-effort */ }
  channelPathWritten = KEYS_LOCAL
}

// ---------- 4. append-only audit record: hashes only, never key material ----------
const record = [
  `# ${new Date().toISOString()} — rotate-secrets.ts`,
  ...[...RUNTIME_TARGETS, CHANNEL_TARGET].filter((k) => before[k]).map((k) =>
    `  ${k}: old sha256=${sha256(before[k])} → rotated`),
  ...(removedChannelKey ? [`  HRM_BACKUP_KEY: removed from .env → backup channel (${channelPathWritten}) — FIN-038 channel separation`] : []),
  "",
].join("\n")
fs.appendFileSync(ROTATION_LOG, record, { mode: 0o600 })

// FIN-038 (Phase 0) — invalidate dependent sessions (explicit opt-in flag).
// Runs AFTER the .env rewrite so a fresh module graph picks up the new keys;
// the delete is unconditional by design (that is the point of the flag) and
// best-effort (a DB hiccup must not undo the key rotation itself).
if (purgeSessions) {
  try {
    // bun does not reliably auto-load .env for ad-hoc script invocations —
    // read the (already rewritten) .env directly for the datasource URL.
    const dbUrl = process.env.DATABASE_URL
      ?? fs.readFileSync(ENV_PATH, "utf8").split(/\r?\n/)
        .find((l) => /^\s*DATABASE_URL\s*=/.test(l) && !l.trim().startsWith("#"))
        ?.replace(/^\s*DATABASE_URL\s*=\s*/, "")
        .trim()
        .replace(/^["']|["']$/g, "")
    if (!dbUrl) throw new Error("DATABASE_URL not found in environment or .env")
    const { PrismaClient } = await import("@prisma/client")
    const db = new PrismaClient({ datasources: { db: { url: dbUrl } } })
    const before = await db.session.count()
    await db.session.deleteMany({})
    await db.$disconnect()
    console.log(`[rotate-secrets] sessions purged: ${before} row(s) deleted — every user must re-login.`)
  } catch (err: any) {
    console.error(`[rotate-secrets] session purge FAILED (${err?.message || err}) — run it separately:`)
    console.error(`  psql "$DATABASE_URL" -c 'DELETE FROM "Session"'  (or bun run scripts/purge-verification-sessions.ts on non-production)`)
  }
}

console.log("[rotate-secrets] done.")
console.log(`  .env rewritten: ${replaced} runtime value(s) replaced${added ? `, ${added} appended` : ""}${removedChannelKey ? `, HRM_BACKUP_KEY line REMOVED (FIN-038)` : ""} (other lines untouched).`)
console.log(`  backup channel written: ${channelPathWritten} (mode 600)`)
console.log(`  rotation record (hashes only) appended to .env.rotation-log`)
console.log("")
if (channelPathWritten === KEYS_LOCAL) {
  console.log("⚠️  The fresh HRM_BACKUP_KEY is in .env.keys.local (LAST RESORT). Move it now:")
  console.log("     sudo install -m 600 -o root -g root .env.keys.local /etc/systemd/system/hrm-backup.env")
  console.log("     then delete the HRM_BACKUP_KEY line from .env.keys.local.")
}
console.log("")
console.log("NEXT STEPS — the app will REFUSE to start until both are done (by design):")
console.log("  1. bun run scripts/re-encrypt-fields.ts   # re-wrap at-rest secrets under the new HRM_MFA_KEY")
console.log("     (MFA secrets re-encrypt lazily on next verify either way.)")
console.log("  2. bash scripts/rekey-backups.sh           # re-key existing encrypted backups under the new HRM_BACKUP_KEY")
console.log("  3. restart the server (and the backup timer).")
console.log("")
console.log("If the OLD values were also used outside this tree (gateway headers, backup cron), rotate them there too.")
console.log("Full Phase 0 rotation procedure (seed password, backup re-key, git history): docs/runbooks/secret-rotation.md")

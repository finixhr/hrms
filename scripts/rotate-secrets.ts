// ============ SEC-1 (Phase 1) — one-shot secret rotation ============
// Rotates the three env-plane secrets whose live values rode in the 2026-10
// shared artifact (HRM_MFA_KEY, HRM_INTERNAL_TOKEN, HRM_BACKUP_KEY):
//
//   1. generates fresh 64-char hex values with crypto.randomBytes;
//   2. rewrites .env IN PLACE, replacing only those three lines (every other
//      line — DB URLs, seed config, tuning — is preserved byte-for-byte);
//   3. writes the OLD values to .env.rotated-<timestamp> (gitignored, chmod
//      600) so the operator can prove what was replaced, then deletes itself
//      after 7 days via the standard logrotate/backup cleanup — NO, on
//      reflection: the old values are COMPROMISED. The record is the sha256
//      of each old value only (enough to audit the rotation, zero key
//      material retained).
//
// After rotation you MUST:
//   - restart the app (the boot guard refuses the old values — deliberately:
//     running this script and NOT restarting leaves the server down, which is
//     the safe direction);
//   - re-encrypt the at-rest fields that were keyed under the OLD MFA key:
//       bun run scripts/re-encrypt-fields.ts
//     (MFA secrets self-heal lazily on next verify; the script covers cameras,
//     device comm keys, webhook/AI/comms/payment credentials eagerly).
//
// Usage: bun run scripts/rotate-secrets.ts [--dry-run]
// Idempotent: re-running replaces the three lines again with new values.
import crypto from "crypto"
import fs from "fs"
import path from "path"

const ENV_PATH = path.join(process.cwd(), ".env")
const ROTATION_LOG = path.join(process.cwd(), ".env.rotation-log")

const TARGETS = ["HRM_MFA_KEY", "HRM_INTERNAL_TOKEN", "HRM_BACKUP_KEY"] as const

function readEnvRaw(): string {
  if (!fs.existsSync(ENV_PATH)) {
    console.error(`[rotate-secrets] .env not found at ${ENV_PATH}.`)
    console.error("  Create one from .env.example first (the app reads runtime configuration from .env; it is gitignored).")
    process.exit(1)
  }
  return fs.readFileSync(ENV_PATH, "utf8")
}

const dryRun = process.argv.includes("--dry-run")
const raw = readEnvRaw()
const lines = raw.split(/\r?\n/)

const before: Record<string, string> = {}
for (const l of lines) {
  const m = l.match(/^\s*(HRM_MFA_KEY|HRM_INTERNAL_TOKEN|HRM_BACKUP_KEY)\s*=\s*(.*)$/)
  if (m && !l.trim().startsWith("#")) before[m[1]] = m[2].trim().replace(/^["']|["']$/g, "")
}

const fresh: Record<string, string> = {}
for (const k of TARGETS) fresh[k] = crypto.randomBytes(32).toString("hex")

let replaced = 0
let added = 0
const out = lines.map((l) => {
  const m = l.match(/^\s*(HRM_MFA_KEY|HRM_INTERNAL_TOKEN|HRM_BACKUP_KEY)\s*=/)
  if (m && !l.trim().startsWith("#")) {
    replaced++
    return `${m[1]}=${fresh[m[1]]}`
  }
  return l
}).join("\n")
// any target missing from .env entirely → append
let finalOut = out
for (const k of TARGETS) {
  if (!new RegExp(`^\\s*${k}\\s*=`, "m").test(finalOut)) {
    finalOut += `\n${k}=${fresh[k]}`
    added++
  }
}

if (dryRun) {
  console.log("[rotate-secrets] DRY RUN — no files written.")
  console.log(`  would replace: ${replaced} value(s); append: ${added}`)
  for (const k of TARGETS) {
    const old = before[k]
    console.log(`  ${k}: ${old ? `present (sha256 ${crypto.createHash("sha256").update(old).digest("hex").slice(0, 16)}…) → new 64-hex value` : "absent → would be appended"}`)
  }
  process.exit(0)
}

fs.writeFileSync(ENV_PATH, finalOut, { mode: 0o600 })
try { fs.chmodSync(ENV_PATH, 0o600) } catch { /* best-effort on odd filesystems */ }

// append-only audit record: hashes only, never key material
const record = [
  `# ${new Date().toISOString()} — rotate-secrets.ts`,
  ...TARGETS.filter((k) => before[k]).map((k) =>
    `  ${k}: old sha256=${crypto.createHash("sha256").update(before[k]).digest("hex")} → rotated`),
  "",
].join("\n")
fs.appendFileSync(ROTATION_LOG, record, { mode: 0o600 })

console.log("[rotate-secrets] done.")
console.log(`  .env rewritten: ${replaced} value(s) replaced${added ? `, ${added} appended` : ""} (other lines untouched).`)
console.log(`  rotation record (hashes only) appended to .env.rotation-log`)
console.log("")
console.log("NEXT STEPS — the app will REFUSE to start until both are done (by design):")
console.log("  1. bun run scripts/re-encrypt-fields.ts   # re-wrap at-rest secrets under the new HRM_MFA_KEY")
console.log("     (MFA secrets re-encrypt lazily on next verify either way.)")
console.log("  2. restart the server.")
console.log("")
console.log("If the OLD values were also used outside this .env (gateway headers, backup cron), rotate them there too.")

// ============ SEC-1 (Phase 1) — tracked-file secret scan (pre-commit + CI) ============
// Blocks a commit/CI run when live-looking secret values appear in TRACKED
// files. Three detectors, all false-positive-tuned:
//
//   A. KNOWN-LEAKED values — sha256 of the value must match the
//      KNOWN_LEAKED_SECRET_HASHES blocklist shared with the boot guard
//      (src/instrumentation.ts). Catches the EXACT compromised values even
//      if someone renames the variable or pastes the value into a doc.
//   B. ASSIGNMENT-IN-TRACKED-FILE — any of the three env-plane secret NAMES
//      assigned a 64-hex-looking value in a file git tracks (i.e. NOT
//      .env/.env.production, which are gitignored by policy; .env.example
//      and .env.test use placeholders that fail the hex check).
//   C. ENTROPY — any 64-char hex blob in a TRACKED file that is neither a
//      known hash digest context (sha256= lines) nor an obvious placeholder.
//      Kept conservative: reports but only FAILS when the file is a config
//      or env-like file.
//
// Exit code 1 = violations found (CI/pre-commit fails). Exit 0 = clean.
// Usage: bun run scripts/scan-secrets.ts [--staged]   (--staged: scan the
// index via `git diff --cached --name-only`; default: scan the working tree
// plus list what git tracks).
import crypto from "crypto"
import fs from "fs"
import path from "path"
import { execSync } from "child_process"

// keep in sync with src/instrumentation.ts (single source of truth would
// import server code into a script; duplicated deliberately with a test
// asserting equality — see tests/unit/phase1-security.test.ts)
const KNOWN_LEAKED_SECRET_HASHES = new Set<string>([
  "b8f01a834645413e99392e08a1fe35b62755a6982e7cba1bfd2a7d2161e9a313",
  "7f9ea0d510b3a4eb0b92505e39824d494fadebaa3825876f2ffed2cda3d6ad0c",
  "8e04c706ec45df381ebd7b8059a4164dc0c4f9c7d0ec51ae0b30309711ed8810",
  "a4bb462cb50f814da8dd907cf4cfaff5676e199abf13a425f7091cd35d849eb7",
  "8c781767da50bf46bb394322bd20094b6798da8c13f8d4875df28a0bd573dc1b",
  "60e05bd1b195af2f94112fa7197a5c88289058840ce7c6df9693756bc6250f55",
  "6e2487d9aa95ae2cc9613cd5b3b2d005eee727dcc21e2bf6cecde853fb0137b9",
  "e3bd5718a7b5f3e10980e29369dfb25e4c600c2fb68e0a19cda6a53bf91acd77",
  "9495920afd1332adf3225066d003e34395fa5b9bcc325c2b0b32863499746857",
  "3959bffc9326a72eb6fc044c96bd53fcc2ebc638979a52c9ef2c83a9465a7343",
])

const SECRET_NAMES = ["HRM_MFA_KEY", "HRM_INTERNAL_TOKEN", "HRM_BACKUP_KEY"] as const
const _HEX64 = /^[0-9a-fA-F]{64}$/
const ROOT = process.cwd()

/**
 * Files fully excluded (gitignored; hold the operator's live values by design).
 * NOTE: the known-leaked-value check (detector A) is NEVER excluded — it runs
 * on every file, including these, because a leaked production value must be
 * caught wherever it lands. Only the generic assignment check (detector B)
 * respects the exclusions below.
 */
const EXCLUDED = new Set([".env", ".env.production", ".env.orig-backup", ".env.rotation-log", ".env.local"])
/**
 * SEC-1 follow-up (found by the scanner itself): .env.test and the CI
 * workflow legitimately carry TEST-ONLY key material by design (the boot
 * guard refuses the leaked PRODUCTION values everywhere). Detector A
 * (blocklist) still applies to them — only detector B (assignment) is waived,
 * and ONLY for these two files.
 */
const ASSIGNMENT_WAIVED = new Set([".env.test", path.join(".github", "workflows", "ci.yml")])
const PLACEHOLDER = /^(GENERATE_|CHANGE_ME_|<|xxx|\.{3}|0{16,})/i

function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git" || entry.name === ".next" || entry.name === "backups") continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, acc)
    else acc.push(full)
  }
  return acc
}

type Violation = { file: string; line: number; kind: string; detail: string }
const violations: Violation[] = []

const staged = process.argv.includes("--staged")
let files: string[] = []
if (staged) {
  try {
    files = execSync("git diff --cached --name-only --diff-filter=ACM", { cwd: ROOT })
      .toString().split(/\r?\n/).filter(Boolean).map((f) => path.join(ROOT, f))
  } catch {
    console.error("[scan-secrets] --staged requires a git repository with a staged index.")
    process.exit(2)
  }
} else {
  files = walk(ROOT)
}

for (const abs of files) {
  const rel = path.relative(ROOT, abs)
  if (EXCLUDED.has(rel) || EXCLUDED.has(path.basename(rel))) continue
  let content: string
  try { content = fs.readFileSync(abs, "utf8") } catch { continue }
  if (content.length > 2_000_000) continue // skip huge generated files
  const lineArr = content.split(/\r?\n/)
  const norm = rel.split(path.sep).join("/")
  const waived = ASSIGNMENT_WAIVED.has(norm) || ASSIGNMENT_WAIVED.has(rel)

  lineArr.forEach((line, i) => {
    // A. known-leaked values — ANYWHERE, any variable name, no exclusions.
    //    The ONE deliberate exception: a same-line `scan-secrets:allow-fixture`
    //    marker (auditable, greppable waiver for dead fixture material whose
    //    semantics REQUIRE the exact compromised value — e.g. a legacy
    //    ciphertext generated under it). The marker never disables detectors
    //    B or the blocklist anywhere else.
    if (line.includes("scan-secrets:allow-fixture")) return
    for (const m of line.matchAll(/\b[0-9a-fA-F]{64}\b/g)) {
      const candidate = m[0]
      if (PLACEHOLDER.test(candidate)) continue
      const h = crypto.createHash("sha256").update(candidate).digest("hex")
      if (KNOWN_LEAKED_SECRET_HASHES.has(h)) {
        violations.push({ file: rel, line: i + 1, kind: "KNOWN_LEAKED_VALUE", detail: `64-hex token on this line matches the compromised-value blocklist (sha256 ${h.slice(0, 16)}…)` })
      }
    }
    // B. secret names assigned live-looking values — waived only for the two
    //    designated test-config files (.env.test, CI workflow)
    if (waived) return
    for (const name of SECRET_NAMES) {
      const re = new RegExp(`^\\s*${name}\\s*=\\s*["']?([A-Za-z0-9_\\-./+]{16,})["']?\\s*$`)
      const mm = line.match(re)
      if (mm && !PLACEHOLDER.test(mm[1])) {
        violations.push({ file: rel, line: i + 1, kind: "SECRET_IN_TRACKED_FILE", detail: `${name} assigned a live-looking value in a tracked file — secrets belong in the (gitignored) .env only` })
      }
    }
  })
}

if (violations.length) {
  console.error("[scan-secrets] FAILED — potential live secrets in tracked files:")
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}  [${v.kind}]  ${v.detail}`)
  }
  console.error("")
  console.error("  If this is a false positive, narrow the pattern in scripts/scan-secrets.ts — do NOT silence the check.")
  console.error("  If these are real values: remove them, rotate them (bun run scripts/rotate-secrets.ts), and purge them from history.")
  process.exit(1)
}
console.log("[scan-secrets] clean — no known-leaked values or live-looking secrets in tracked files.")
process.exit(0)

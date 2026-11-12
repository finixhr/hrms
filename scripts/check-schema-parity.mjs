#!/usr/bin/env node
// ============ B-7 (Stage B, Option 1(b)) — schema parity gate ============
// Normalize-then-exempt parity verification: `prisma migrate diff` between the
// DATABASE and the Prisma datamodel must be EMPTY except for the single
// approved exemption class — the six Employee GIN/trigram indexes.
//
// WHY the exemption exists (technical reason, required by the approved
// disposition): pg_trgm GIN indexes (`USING gin (col gin_trgm_ops)`) have NO
// representation in the Prisma datamodel — no @@index/@@fullTextSearch syntax
// can express an operator-class GIN index. They are created by raw DDL in
// 9_wave9zf_employee_search_trigram_20261022 and
// 9_wave9zn_trigram_refresh_retention_20261023, so `migrate diff` reports them
// as "Removed index on columns (…)" on every replay. Everything else the
// historical chain used to diverge on (PayrollRun company index name,
// WorkforceSnapshot.updatedAt default, ApprovalRequest companyId index) is
// NORMALIZED by 9_wave9zzab_payroll_parity_normalization_20261103 and is NOT
// exempted here.
//
// Fail-closed contract (this gate can only pass for the exact intended state):
//   1. Any drift line other than the six exact signatures is FATAL — an
//      unexpected index (7th GIN, btree twin, any other table) fails the gate.
//   2. A duplicate/extra removed-index line on Employee fails the gate.
//   3. Each of the six indexes must EXIST in the database with the exact
//      name, table, type (gin) and definition (gin_trgm_ops) — a missing or
//      changed expected index fails the gate.
//   4. Any GIN index on Employee beyond the six fails the gate (the exemption
//      can never silently widen).
//   5. A migrate-diff infrastructure error (exit 1) fails the gate.
//
// Usage: node scripts/check-schema-parity.mjs <database-url> [--schema <prisma/schema.prisma>] [--quiet]
// Exit:  0 = parity holds; 1 = parity violation (printed); 2 = usage error.
import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { join, dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")

// ---------- the ONE approved exemption class (exact signatures) ----------
const TRGM_EXPECTED = [
  { name: "Employee_fullName_trgm_idx", column: "fullName", source: "9_wave9zf_employee_search_trigram_20261022" },
  { name: "Employee_code_trgm_idx", column: "code", source: "9_wave9zf_employee_search_trigram_20261022" },
  { name: "Employee_mobile_trgm_idx", column: "mobile", source: "9_wave9zn_trigram_refresh_retention_20261023" },
  { name: "Employee_altMobile_trgm_idx", column: "altMobile", source: "9_wave9zn_trigram_refresh_retention_20261023" },
  { name: "Employee_officialEmail_trgm_idx", column: "officialEmail", source: "9_wave9zn_trigram_refresh_retention_20261023" },
  { name: "Employee_personalEmail_trgm_idx", column: "personalEmail", source: "9_wave9zn_trigram_refresh_retention_20261023" },
]
const EXEMPT_COLUMNS = new Set(TRGM_EXPECTED.map((x) => x.column))
const EXEMPT_NAMES = new Set(TRGM_EXPECTED.map((x) => x.name))
// indexdef on the replayed database is exactly:
//   CREATE INDEX "Employee_fullName_trgm_idx" ON public."Employee" USING gin ("fullName" gin_trgm_ops)
// (PostgreSQL quotes identifiers only when required — "code"/"mobile" stay
// unquoted — so the quote-group `("?)(col)\1` accepts both spellings.)
const indexdefRe = (x) =>
  new RegExp(`^CREATE INDEX "${x.name}" ON public\\."Employee" USING gin \\(("?)${x.column}\\1 gin_trgm_ops\\)$`)

// ---------- args ----------
const args = process.argv.slice(2)
const quiet = args.includes("--quiet")
const schemaIdx = args.indexOf("--schema")
const schemaPath = schemaIdx !== -1 ? resolve(args[schemaIdx + 1] ?? "") : join(ROOT, "prisma", "schema.prisma")
// positional arguments = everything that is not a flag or a flag's value
const positional = []
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--schema") { i++; continue }
  if (args[i] === "--quiet") continue
  if (args[i].startsWith("--")) continue
  positional.push(args[i])
}
const url = positional[0]
if (!url || !/^(postgres(ql)?:\/\/|file:)/.test(url)) {
  console.error("usage: node scripts/check-schema-parity.mjs <database-url> [--schema <path>] [--quiet]")
  process.exit(2)
}
if (!existsSync(schemaPath)) {
  console.error(`schema-parity: schema not found: ${schemaPath}`)
  process.exit(2)
}

// ---------- 1. migrate diff (the real Prisma differ) ----------
// prisma migrate diff --exit-code: 0 = identical, 2 = differences found,
// 1 (or a crash/signal) = infrastructure error.
const prismaCli = join(ROOT, "node_modules", "prisma", "build", "index.js")
const diffRun = spawnSync(process.execPath, [prismaCli, "migrate", "diff", "--from-url", url, "--to-schema-datamodel", schemaPath, "--exit-code"], {
  encoding: "utf8",
  env: { ...process.env, DATABASE_URL: url },
})
if (diffRun.status === null || diffRun.status === 1 || diffRun.status > 2) {
  console.error("schema-parity: FAIL — migrate diff did not run (infrastructure error):")
  console.error(diffRun.stderr || diffRun.stdout || "(no output)")
  process.exit(1)
}
// the diff body may arrive on stdout or stderr depending on CLI plumbing —
// take whichever carries the diff markers (never both, to avoid duplicates)
const out = diffRun.stdout || ""
const err = diffRun.stderr || ""
const diffText = (/\[\*\]|\[-\]|\[\+\]/.test(out) ? out : err).trim()

// ---------- 2. parse the diff into blocks; exempt ONLY the exact six ----------
const problems = []
if (diffRun.status === 0 && diffText === "") {
  // no drift at all — fall through to the DB integrity check, which is still
  // mandatory (a database MISSING the six GIN indexes produces an empty diff
  // too, because the datamodel does not declare them either).
} else {
  const lines = diffText.split("\n").map((l) => l.replace(/\r$/, ""))
  const blocks = [] // { header, lines: [] }
  for (const line of lines) {
    if (/^\[\*\] Changed the `.*` (table|enum)/.test(line) || /^\[\-\] Removed.*(table|enum)/.test(line) || /^\[\+\] Added.*(table|enum)/.test(line)) {
      blocks.push({ header: line, lines: [] })
    } else if (blocks.length > 0) {
      blocks[blocks.length - 1].lines.push(line)
    } else if (line.trim() !== "") {
      // content before any block header — impossible for a well-formed diff
      problems.push(`unstructured diff content: ${line}`)
    }
  }
  const exemptSeen = []
  for (const b of blocks) {
    const isEmployeeBlock = b.header === "[*] Changed the `Employee` table"
    for (const line of b.lines) {
      const m = line.match(/^\s*\[-\] Removed index on columns \(([^)]+)\)$/)
      if (m && isEmployeeBlock && EXEMPT_COLUMNS.has(m[1])) {
        exemptSeen.push({ column: m[1], line })
        continue
      }
      if (line.trim() !== "") problems.push(`${b.header}\n  ${line.trim()}`)
    }
  }
  // exactly-once semantics: every expected column exempted exactly once
  const seenCols = exemptSeen.map((x) => x.column)
  for (const col of EXEMPT_COLUMNS) {
    const n = seenCols.filter((c) => c === col).length
    if (n === 0) problems.push(`expected the exempted GIN/trigram signature for Employee.${col} in the diff (it was not reported) — if the index is genuinely absent from the database the DB check below will fail as well`)
    if (n > 1) problems.push(`Employee.${col} produced ${n} removed-index lines — duplicate index signatures are never exempted`)
  }
}

// ---------- 3. DB integrity of the exemption (fail if missing/changed/extra) ----------
const { PrismaClient } = await import(join(ROOT, "node_modules", "@prisma", "client", "index.js"))
const p = new PrismaClient({ datasources: { db: { url } } })
let ginIndexes = []
try {
  ginIndexes = await p.$queryRawUnsafe(
    `SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'Employee' AND indexdef LIKE '%USING gin%' ORDER BY indexname`,
  )
} catch (e) {
  problems.push(`could not read pg_indexes for the exemption integrity check: ${e instanceof Error ? e.message : String(e)}`)
} finally {
  await p.$disconnect().catch(() => {})
}
const ginNames = ginIndexes.map((r) => r.indexname)
for (const x of TRGM_EXPECTED) {
  const row = ginIndexes.find((r) => r.indexname === x.name)
  if (!row) {
    problems.push(`expected GIN/trigram index ${x.name} (from ${x.source}) is MISSING from the database — the exemption never covers absence`)
    continue
  }
  if (!indexdefRe(x).test(row.indexdef)) {
    problems.push(`expected GIN/trigram index ${x.name} has an unexpected definition:\n    ${row.indexdef}\n  (expected: CREATE INDEX "${x.name}" ON public."Employee" USING gin (${x.column} gin_trgm_ops))`)
  }
}
for (const name of ginNames) {
  if (!EXEMPT_NAMES.has(name)) {
    problems.push(`unexpected GIN index on Employee: ${name} — the exemption covers exactly the six documented trigram indexes, nothing else`)
  }
}

// ---------- verdict ----------
if (problems.length) {
  console.error("schema-parity: FAIL — the database does not match the datamodel under the approved exemption:")
  for (const p of problems) console.error(`  ✗ ${p}`)
  process.exit(1)
}
if (!quiet) {
  console.log(`schema-parity: PASS — migrate diff is empty except the ${TRGM_EXPECTED.length} exact GIN/trigram signatures; all ${TRGM_EXPECTED.length} present with exact definitions; no extra GIN indexes on Employee`)
  console.log("  exempted (pg_trgm GIN is not representable in the Prisma datamodel):")
  for (const x of TRGM_EXPECTED) console.log(`    ${x.name}  (${x.source})`)
}
process.exit(0)

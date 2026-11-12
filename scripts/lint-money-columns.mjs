#!/usr/bin/env node
// ============ DBD-1 (P2 wave, 2026-11-09) — money-column schema lint ============
// Blocks NEW Float money columns in prisma/schema.prisma.
//
// The paisa migration (H-09 + the 9_wave9zzaj backfill) makes the BigInt
// *Paisa columns the authoritative money representation; the remaining 199
// Float columns are the legacy inventory this lint grandfathers. Any Float
// field that is NOT on the allowlist fails CI with instructions — new money
// must be modeled as BigInt paisa (toPaisa at the ingestion boundary), and
// new non-money Floats must carry an explicit `// float-ok: <reason>` inline
// comment so the opt-out is reviewed, not accidental.
//
// Usage:  node scripts/lint-money-columns.mjs [--update]
//   --update  rewrite the allowlist after a DELIBERATE, reviewed addition
//             (the diff must be justified in the commit that uses it).
import { readFileSync, writeFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const SCHEMA = join(ROOT, "prisma", "schema.prisma")
const ALLOWLIST = join(ROOT, "scripts", "lint-money-float-allowlist.txt")

// ---------- parse the schema: model → Float fields ----------
function scanFloatFields(schemaText) {
  const out = []
  let model = null
  for (const line of schemaText.split("\n")) {
    const m = /^model\s+(\w+)\s*\{/.exec(line)
    if (m) { model = m[1]; continue }
    if (/^\}/.test(line)) { model = null; continue }
    const fm = /^\s{2}(\w+)\s+Float\b(.*)$/.exec(line)
    if (fm && model) out.push({ field: `${model}.${fm[1]}`, reason: fm[2].trim() })
  }
  return out
}

const schemaText = readFileSync(SCHEMA, "utf8")
const current = scanFloatFields(schemaText)
const allow = new Set(
  readFileSync(ALLOWLIST, "utf8").split("\n").map((l) => l.trim()).filter(Boolean)
)

if (process.argv.includes("--update")) {
  writeFileSync(ALLOWLIST, current.map((c) => c.field).sort().join("\n") + "\n")
  console.log(`allowlist updated: ${current.length} Float fields`)
  process.exit(0)
}

// ---------- classify ----------
const offenders = []
for (const { field, reason } of current) {
  if (allow.has(field)) continue
  if (/\/\/\s*float-ok:/i.test(reason)) continue // explicit reviewed opt-out
  offenders.push(field)
}

if (offenders.length > 0) {
  console.error("✗ DBD-1 money-column lint: NEW Float column(s) without an opt-out:")
  for (const f of offenders) console.error(`    ${f}`)
  console.error(`
New money values must be modeled as BigInt paisa columns (see
src/hrm-server/money.ts toPaisa / structurePaisa — the H-09 dual-write
invariant and the nightly reconcileFloatPaisa enforcer keep pairs in sync).
If the column is genuinely NOT money (a ratio, a coordinate, a score…),
annotate the field inline with:  // float-ok: <one-line reason>
Deliberate legacy additions require updating the allowlist with:
    node scripts/lint-money-columns.mjs --update
and justifying the diff in the commit.`)
  process.exit(1)
}

// ---------- report ----------
const optedOut = current.filter((c) => !allow.has(c.field)).map((c) => c.field)
console.log(`✓ DBD-1 money-column lint: ${current.length} Float fields (${allow.size} grandfathered${optedOut.length ? `, ${optedOut.length} float-ok opt-outs` : ""}) — no new Float money columns.`)

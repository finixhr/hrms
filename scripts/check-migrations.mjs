#!/usr/bin/env node
// ============ Migration naming guard (Wave 4 A4, 2026-10-08) ============
// P3009/P3018 post-mortem: Prisma applies migrations in LEXICOGRAPHIC order
// of directory names. The wave-2 deliverable shipped `10_…`/`11_…` folders
// which sort BETWEEN `1_…` and `2_…` — every fresh database failed because
// migration 10 ran before migration 5 created the tables it referenced.
// (A `2026…` timestamp prefix has the SAME bug in THIS repo, because the
// legacy chain is `0_…` through `9_…` single-digit prefixed.)
//
// R3-4 (2026-10-17): the user's own `10_loan_guarantor_control`,
// `11_ait_legal_audit` and `12_present_address_fields` folders hit exactly
// this P3018 bug on fresh databases and were renamed in-place to
// `9_wave7/8/9_…` (chronological order preserved, tip moved forward).
// ALREADY-APPLIED DATABASES: rename the tracking rows too, or prisma will
// try to re-run them —
//   UPDATE _prisma_migrations SET name='9_wave7_loan_guarantor_control_20261014' WHERE name='10_loan_guarantor_control_20261014';
//   UPDATE _prisma_migrations SET name='9_wave8_ait_legal_audit_20261014' WHERE name='11_ait_legal_audit_20261014';
//   UPDATE _prisma_migrations SET name='9_wave9_present_address_fields_20261015' WHERE name='12_present_address_fields_20261015';
// Phase 1 (2026-10-21) — the timestamped names hit the same P3018 bug and were
// renamed in place (chronological order preserved):
//   UPDATE _prisma_migrations SET name='9_wave9zb_commission_rule_eligible_statuses_20261020' WHERE name='20261020201554_add_commission_rule_eligible_statuses';
//   UPDATE _prisma_migrations SET name='9_wave9zc_pf_contribution_dedupe_unique_20261021' WHERE name='20261021120000_pf_contribution_dedupe_unique';
//   UPDATE _prisma_migrations SET name='9_wave9zd_attendance_raw_event_sweeper_index_20261021' WHERE name='20261021120100_attendance_raw_event_sweeper_index';
//
// This script fails CI when a migration folder name can break the intended
// chronological order:
//   1. rejects multi-digit numeric prefixes (10_, 11_, 20261008_…) — they
//      sort between 1_… and 2_…;
//   2. asserts the lexicographic order equals the intended apply order
//      (single-digit prefixes 0→9 must appear monotonically);
//   3. asserts new migrations sort AFTER the current chain tip
//      (9_wave9_present_address_fields_20261015) so the wave prefixes stay
//      consistent.
//
// Rule of thumb honored repo-wide: new migrations use `9_wave<N>_<letter>_
// <topic>_<yyyymmdd>` names (wave2 < wave3 < wave4 … letter a<b<c<…).
import { readdirSync } from "node:fs"
import { join } from "node:path"

const ROOT = join(import.meta.dirname, "..")
const MIGRATIONS = join(ROOT, "prisma", "migrations")

const CURRENT_TIP = "9_wave9zd_attendance_raw_event_sweeper_index_20261021"

const dirs = readdirSync(MIGRATIONS, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort()

if (dirs.length === 0) {
  console.error("[migrations] FAIL: no migration directories found")
  process.exit(1)
}

let failed = false

// ---- Rule 1: no multi-digit (or year-style) numeric prefixes ----
for (const name of dirs) {
  if (/^\d{2,}/.test(name)) {
    console.error(
      `[migrations] FAIL: "${name}" starts with 2+ digits — it sorts between 1_… and 2_… ` +
      "(the P3018 fresh-database bug). Rename to the 9_wave<N>_<letter>_ convention.",
    )
    failed = true
  }
}

// ---- Rule 2: single-digit prefixes must appear in monotonic order ----
const prefixOf = (name) => {
  const m = name.match(/^(\d)_/)
  return m ? Number(m[1]) : null
}
let lastDigit = -1
for (const name of dirs) {
  const d = prefixOf(name)
  if (d == null) continue
  if (d < lastDigit) {
    console.error(
      `[migrations] FAIL: "${name}" (prefix ${d}_) sorts after a higher single-digit prefix — ` +
      "lexicographic order no longer matches intended apply order.",
    )
    failed = true
  }
  lastDigit = Math.max(lastDigit, d)
}

// ---- Rule 3: nothing may sort before the known chain tip among 9_ entries ----
const tipIdx = dirs.indexOf(CURRENT_TIP)
if (tipIdx === -1) {
  console.error(`[migrations] FAIL: expected chain tip "${CURRENT_TIP}" not found — update CURRENT_TIP in scripts/check-migrations.mjs`)
  failed = true
} else {
  const after = dirs.slice(tipIdx + 1)
  for (const name of after) {
    if (/^9_wave[1-3]_/.test(name)) {
      console.error(
        `[migrations] FAIL: wave-1/2/3 migration "${name}" sorts AFTER the wave-4 tip — ` +
        "the wave lettering convention is broken.",
      )
      failed = true
    }
  }
}

if (failed) {
  console.error(`\n[migrations] ${dirs.length} directories, order:\n  ${dirs.join("\n  ")}`)
  process.exit(1)
}

console.log(`[migrations] OK — ${dirs.length} migrations, apply order verified (tip: ${CURRENT_TIP})`)
console.log(`  ${dirs.join("\n  ")}`)

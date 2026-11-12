#!/usr/bin/env node
// ============ OPS-7 (P2 wave, 2026-11-09) — coverage threshold gate ============
// The audit: "no coverage threshold, so the strong suite can silently decay."
// This gate parses bun's text coverage summary (the "All files" line) from
// the CI log produced by stage 3 (bun test --coverage --coverage-reporter=text)
// and FAILS the gate when total line coverage drops below the floor.
//
// The floor is deliberately a ratchet: the measured suite total was 65.73%
// lines (2026-11-09, P2 wave tree, 2502 tests). The floor sits 5+ points
// below it so normal churn does not trip the gate, while real decay (a
// dropped suite, a gutted module) does. Raise the floor as coverage grows —
// never lower it without a written justification.
import { readFileSync } from "node:fs"

const FLOOR = 60.0 // percent of lines — see header

const log = readFileSync(process.argv[2] || "/tmp/ci-coverage.log", "utf8")

// bun's text reporter line:
//   All files | 65.73 | 67.78 |
const m = log.match(/^All files\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)/m)
if (!m) {
  console.error("✗ OPS-7 coverage gate: could not find the 'All files' summary line in the coverage log.")
  console.error("  Ensure stage 3 runs: bun test tests/unit --coverage --coverage-reporter=text | tee $COV_LOG")
  process.exit(1)
}
const lines = Number(m[1])
const funcs = Number(m[2])

if (!Number.isFinite(lines) || lines <= 0) {
  console.error("✗ OPS-7 coverage gate: unparsable coverage numbers.")
  process.exit(1)
}

if (lines < FLOOR) {
  console.error(`✗ OPS-7 coverage gate: total line coverage ${lines.toFixed(2)}% is BELOW the ${FLOOR}% floor.`)
  console.error("  The suite decayed — restore the lost coverage (or justify + re-pin the floor in scripts/coverage-gate.mjs).")
  process.exit(1)
}

console.log(`✓ OPS-7 coverage gate: ${lines.toFixed(2)}% lines / ${funcs.toFixed(2)}% functions — above the ${FLOOR}% floor.`)

// ============ Shared money helpers (H-8 / H-09 paisa dual-write) ============
// The Float→integer money migration is staged: every money column keeps its
// Float representation and is shadowed by a lossless integer paisa column
// (<field>Paisa = Math.round(<field> * 100) — the convention pinned by
// tests/unit/h09-paisa-golden.test.ts).
//
// H-8 (audit): the paisa dual-write existed only at the employee-creation call
// site; salaryStructures.save and applySalaryRevision wrote Float-only rows,
// leaving NULL paisa columns that break the lossless representation and block
// the documented migration cutover. This module is the ONE shared helper every
// salary-structure write path must use — adding a new write path without it
// fails the h8-paisa-dualwrite route-layer test.

/** Salary-structure money fields that carry paisa shadow columns. */
export const SALARY_MONEY_FIELDS = [
  "basic", "houseRent", "medical", "conveyance", "food",
  "mobileAllow", "internetAllow", "attendanceAllow", "otherAllowance",
] as const

/** Taka → integer paisa (the one true convention).
 *  2026-10-13 — returns BIGINT: paisa values live in BIGINT columns since a
 *  payroll total crossed the INT4 ceiling (5003650000 > 2,147,483,647).
 *  Readers that need a JS number must wrap with Number() — every app paisa
 *  value is far below 2^53, so that conversion is lossless. */
export function paisaOf(taka: number): bigint {
  return BigInt(Math.round(taka * 100))
}

// ============================================================================
// MON-9 (Phase 4 WS-A) — the integer-paisa computation core.
// The payroll engine computes EVERY money amount as integer paisa (bigint);
// the legacy Float columns are DERIVED at the end. Each quantity has exactly
// ONE rounding boundary, chosen explicitly below — the float engine's
// per-component/per-loop Math.round boundaries are gone, along with the
// penny-drift they recorded into the paisa shadows.
// ============================================================================

/** THE Float→paisa ingestion boundary. Every float taka that enters a
 *  computation (salary structures, settings rates, AIT output, legacy rows
 *  without paisa columns) passes through here exactly once. Same rounding as
 *  the historical paisaOf so the H-09 invariant holds by construction. */
export const toPaisa = paisaOf

/** The paisa→Float derivation boundary for the legacy Float columns.
 *  fromPaisa(p) is exact for every |p| < 2^53 (Number(p)/100), and
 *  toPaisa(fromPaisa(p)) === p — the dual-write invariant (H-09) is a
 *  no-op check on engine output. */
export function fromPaisa(paisa: bigint): number {
  return Number(paisa) / 100
}

/** Display/derive alias — reads better at format sites: takaOf(netPaisa). */
export const takaOf = fromPaisa

/** bigint floor division (JS bigint % takes the dividend's sign, so plain
 *  truncation is wrong for negative numerators — deltas go negative). */
function floorDiv(n: bigint, d: bigint): bigint {
  return (n - (((n % d) + d) % d)) / d
}

/** Half-up division of paisa numerators (mirrors Math.round semantics,
 *  including half-toward-+∞ on negatives). The ONE rounding boundary for
 *  every proration / rate split the engine performs. */
export function divHalfUp(n: bigint, d: bigint): bigint {
  if (d === 0n) throw new Error("divHalfUp: zero denominator")
  return floorDiv(2n * n + d, 2n * d)
}

/** Mathematical-floor division — the boundary for budget caps that must
 *  never round UP (guarantor recovery caps, take-home floors). */
export function divFloor(n: bigint, d: bigint): bigint {
  if (d === 0n) throw new Error("divFloor: zero denominator")
  return floorDiv(n, d)
}

/** Exact proration: mulRatio(b, num, den) === Math.round(b_taka ×
 *  min(1, num/den)) with the weeklyFraction zero-guards — but in paisa, with
 *  the single divHalfUp boundary. den ≤ 0 or num ≤ 0 → 0n (nothing payable
 *  in an empty window); num ≥ den → b (never prorate ABOVE the basis). */
export function mulRatio(b: bigint, num: number, den: number): bigint {
  if (!(den > 0) || !(num > 0)) return 0n
  if (num >= den) return b
  return divHalfUp(b * BigInt(num), BigInt(den))
}

/** Exact percentage: mulPct(basis, pct) with pct a float (10, 12.5, 0.5…).
 *  The percent is ingested once (to hundredths of a percent) and the single
 *  divHalfUp lands on paisa — PF contributions and percentage policies.
 *  pctHundredths/10,000 is the exact fraction (10% = 1000/10000). */
export function mulPct(basis: bigint, pct: number): bigint {
  const pctHundredths = BigInt(Math.round(Number(pct) * 100))
  if (pctHundredths === 0n || basis === 0n) return 0n
  const negative = basis < 0n
  const abs = negative ? -basis : basis
  const out = divHalfUp(abs * pctHundredths, 10_000n)
  return negative ? -out : out
}

/** Build the *Paisa companion keys for a salary-structure row.
 *  Only fields present on the input are shadowed; `gross` is included when
 *  provided. Spread the result into the Prisma create/update data object:
 *    { ...comps, gross, ...structurePaisa({ ...comps, gross }) }
 */
export function structurePaisa(comps: Partial<Record<typeof SALARY_MONEY_FIELDS[number] | "gross", number>>): Record<string, bigint> {
  const out: Record<string, bigint> = {}
  for (const f of SALARY_MONEY_FIELDS) {
    if (comps[f] != null) out[`${f}Paisa`] = paisaOf(comps[f] as number)
  }
  if (comps.gross != null) out.grossPaisa = paisaOf(comps.gross)
  return out
}

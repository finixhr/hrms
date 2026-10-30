// ============ EXIT-001 (R3-1) — Bangladesh Labour Act gratuity engine ============
// Single source of truth for the statutory gratuity computation, consumed by
// BOTH the exit settlement (money that moves) and the advisory Gratuity
// Provision report (exposure projection) — audit finding EXIT-001 confirmed
// the rule previously existed ONLY in the report while the settlement, the
// journal, the payslip and the UI promise all omitted it.
//
// Rule (BLA 2006 §96 as amended 2018, matching the app's own report copy):
//   gratuity = (last drawn wage ÷ divisor) × daysPerYear × completed years
//   - eligibility: 5 completed years of continuous service; continuous
//     service of 4 years 6 months or more counts as 5 years (2018 amendment)
//   - divisor: 30 = BLA daily-rate convention, 26 = factory/undertaking
//     convention (tenant-configurable, report selectable)
//   - wage basis: BASIC (statutory default) or GROSS (tenant choice)
//   - optional tenant cap (0 = uncapped)
//
// This module is PURE (no db import) so unit tests can exercise it without a
// database.

export type GratuityConfig = {
  /** master switch (Settings → Payroll → Gratuity). Default ON — statutory. */
  enabled: boolean
  /** completed years required (BLA: 5; 4y6m+ rounds up). */
  eligibilityYears: number
  /** days of wages per completed year (BLA: 30). */
  daysPerYear: number
  /** wage base for the daily rate. */
  wageBasis: "BASIC" | "GROSS"
  /** daily-rate divisor: 30 (BLA) or 26 (factory convention). */
  divisor: number
  /** flat cap on the total amount (0 = uncapped). */
  capAmount: number
}

export const DEFAULT_GRATUITY_CONFIG: GratuityConfig = {
  enabled: true,
  eligibilityYears: 5,
  daysPerYear: 30,
  wageBasis: "BASIC",
  divisor: 30,
  capAmount: 0,
}

/** Completed calendar months between two ISO dates (anniversary rule: the
 *  day-of-month anniversary must be reached for the month to count). Pure. */
export function completedMonthsBetween(fromIso: string, toIso: string): number {
  const a = new Date(`${fromIso}T00:00:00Z`)
  const b = new Date(`${toIso}T00:00:00Z`)
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return 0
  if (b <= a) return 0
  let months = (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + (b.getUTCMonth() - a.getUTCMonth())
  if (b.getUTCDate() < a.getUTCDate()) months -= 1
  return Math.max(0, months)
}

export type GratuityResult = {
  /** threshold met (incl. the 4y6m→5y rounding rule) — amount can still be 0 for 0 years */
  eligible: boolean
  /** completed months of continuous service at the LWD */
  months: number
  /** completed years (floor) — the multiplier */
  years: number
  /** gratuity amount in taka, rounded to the taka (0 when ineligible/disabled) */
  amount: number
  /** true when the tenant cap clipped the amount */
  capped: boolean
  /** daily wage used (wage basis ÷ divisor), rounded for display */
  dailyWage: number
  wageBasis: "BASIC" | "GROSS"
}

/** Compute the statutory gratuity. Pure; safe with partial config objects
 *  (missing keys fall back to the BLA defaults). */
export function computeGratuity(
  cfg: Partial<GratuityConfig> | null | undefined,
  wage: { basic: number; gross: number },
  joiningDate: string | null | undefined,
  lwd: string,
): GratuityResult {
  const c: GratuityConfig = { ...DEFAULT_GRATUITY_CONFIG, ...(cfg || {}) }
  const empty: GratuityResult = {
    eligible: false, months: 0, years: 0, amount: 0, capped: false, dailyWage: 0, wageBasis: c.wageBasis,
  }
  if (c.enabled === false || !joiningDate) return empty
  const months = completedMonthsBetween(joiningDate, lwd)
  const years = Math.floor(months / 12)
  const eligibilityYears = Math.max(0, Math.round(c.eligibilityYears || 5))
  // BLA 2018 amendment: continuous service of ≥4y6m counts as 5 years for
  // gratuity eligibility — generalised as "within 6 months of the threshold
  // rounds up" so a custom threshold keeps the same half-year grace.
  const eligible = years >= eligibilityYears || months + 6 >= eligibilityYears * 12
  const base = c.wageBasis === "GROSS" ? wage.gross : wage.basic
  if (!eligible || !(base > 0) || years <= 0 || !(c.daysPerYear > 0) || !(c.divisor > 0)) {
    return { ...empty, months, years }
  }
  const dailyWage = base / c.divisor
  let amount = dailyWage * c.daysPerYear * years
  let capped = false
  if (c.capAmount > 0 && amount > c.capAmount) {
    amount = c.capAmount
    capped = true
  }
  return {
    eligible: true,
    months,
    years,
    amount: Math.round(amount),
    capped,
    dailyWage: Math.round(dailyWage * 100) / 100,
    wageBasis: c.wageBasis,
  }
}

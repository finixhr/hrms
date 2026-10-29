// ============ Leave balance math — THE canonical formula (LVE-002, R3-4) ============
// Round-3 audit: four disagreeing "available balance" formulas coexisted —
// the enforcement paths (leaveRequests.apply, ESS cards, leaveBalances.list)
// computed spendable from ENTITLED ALONE (carried-forward days were
// unspendable), while the admin AI-assist context, the quick-actions sheet
// and the self-check invariant all added carriedForward on top. After a
// manual recompute (which folded the carry INTO entitled), the display paths
// DOUBLE-counted it.
//
// One formula now drives every consumer:
//
//     spendable = entitled + carriedForward − used − pending
//
// Storage convention (unchanged by this wave): the rollover job and the
// lazy row creation keep entitled = defaultDays and carry in its own column;
// recompute NO LONGER folds the carry into entitled. Every reader — apply,
// ESS, encashment, exit settlement, the v1 public API, admin context,
// quick-actions, the self-check — goes through spendableDays() so the
// number an employee sees is the number the engine enforces.
//
// Pure by design: no db, no settings — unit-testable without PostgreSQL.

export type LeaveBalanceLike = {
  entitled?: number | null
  carriedForward?: number | null
  used?: number | null
  pending?: number | null
  year?: number | null
}

/** LVE-104 — the ONE leave-year keying. A leave year starts on the tenant's
 *  fiscal-year start month (July default) and is keyed by its START year:
 *  dates before the fiscal-start month belong to the leave year that started
 *  the previous calendar year. The rollover, the apply path, the balances
 *  views and the encashment/settlement paths all derive the year through this
 *  helper so a January request and the July rollover can never disagree about
 *  which ledger a day belongs to (the old calendar-year keying on apply made
 *  the July rollover carry from an 18-month-old ledger). */
export function leaveYearOf(isoDate: string, fyStartMonth = 6): number {
  const s = String(isoDate || "")
  const y = Number(s.slice(0, 4))
  const m = Number(s.slice(5, 7)) - 1
  if (!Number.isFinite(y) || y <= 0) return 0
  const fy = Math.min(11, Math.max(0, Number.isFinite(m) && m >= 0 ? m : fyStartMonth))
  return fy >= fyStartMonth ? y : y - 1
}

/** ISO date + N months (clamped to the month's length). Pure string math. */
function addMonthsIso(isoDate: string, months: number): string {
  const y = Number(isoDate.slice(0, 4))
  const m = Number(isoDate.slice(5, 7)) - 1 + Math.trunc(months)
  const d = Number(isoDate.slice(8, 10))
  const target = new Date(Date.UTC(y, m + 1, 0)) // last day of the target month
  const day = Math.min(d, target.getUTCDate())
  return `${target.getUTCFullYear()}-${String(target.getUTCMonth() + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`
}

/** LVE-105 — carried days are spendable only for carryForwardExpiryMonths
 *  after the leave-year start (0 = they never expire). The carry lands on the
 *  first day of the balance row's leave year; past the window it stops
 *  counting toward spendable (the stored value is untouched — the ledger
 *  keeps the provenance). */
export function carriedForwardSpendable(carriedForward: number, leaveYear: number, fyStartMonth: number, expiryMonths: number, asOf: string): number {
  const carried = Math.max(0, Number(carriedForward) || 0)
  const exp = Math.trunc(Number(expiryMonths) || 0)
  if (carried <= 0 || exp <= 0) return carried
  const fy = Math.min(11, Math.max(0, Number(fyStartMonth) || 0))
  const landedOn = `${Number(leaveYear) || 0}-${String(fy + 1).padStart(2, "0")}-01`
  const expiresOn = addMonthsIso(landedOn, exp)
  return String(asOf || "") > expiresOn ? 0 : carried
}

/** LVE-106 — PRO_RATA entitlement: the annual quota accrues by calendar
 *  months of service inside the leave year. A November joiner (July FY) has
 *  earned 2/12 of the quota by December — never the full quota on day one. */
export function proRatedEntitlement(defaultDays: number, joiningDate: string | null | undefined, leaveYear: number, fyStartMonth: number, asOf: string): number {
  const total = Math.max(0, Number(defaultDays) || 0)
  if (total <= 0) return 0
  const y = Number(leaveYear) || 0
  if (y <= 0) return total
  const fy = Math.min(11, Math.max(0, Number(fyStartMonth) || 0))
  const yearStart = `${y}-${String(fy + 1).padStart(2, "0")}-01`
  const yearEnd = `${y + 1}-${String(fy + 1).padStart(2, "0")}-01`
  const from = joiningDate && String(joiningDate) > yearStart ? String(joiningDate) : yearStart
  const to = String(asOf || "") < yearEnd ? String(asOf || "") : yearEnd
  if (from >= to) return 0
  // whole calendar months of service inside the window, capped at 12
  const fromY = Number(from.slice(0, 4)), fromM = Number(from.slice(5, 7))
  const toY = Number(to.slice(0, 4)), toM = Number(to.slice(5, 7))
  const months = Math.min(12, Math.max(0, (toY - fromY) * 12 + (toM - fromM)))
  return Math.round(total * months / 12 * 100) / 100
}

/** The one canonical available-balance formula (days, half-day granularity).
 *  LVE-105 — opts carries the carry-expiry context; without it the historical
 *  behavior (carried days spendable forever) applies. */
export function spendableDays(
  b: LeaveBalanceLike | null | undefined,
  opts: { asOf?: string; fyStartMonth?: number; carryForwardExpiryMonths?: number } = {},
): number {
  if (!b) return 0
  const entitled = Number(b.entitled) || 0
  const used = Number(b.used) || 0
  const pending = Number(b.pending) || 0
  const carried = carriedForwardSpendable(
    Number(b.carriedForward) || 0,
    Number(b.year) || 0,
    Number(opts.fyStartMonth ?? 6),
    Number(opts.carryForwardExpiryMonths ?? 0),
    String(opts.asOf ?? ""),
  )
  return Math.round((entitled + carried - used - pending) * 100) / 100
}

/** LVE-008 companion — the floor for `entitled` during a recompute so the
 *  ledger is never left over-committed: spendable must stay ≥ 0, i.e.
 *  entitled ≥ used + pending − carriedForward. Never below the type's
 *  defaultDays target; the recompute reports when the floor binds. */
export function entitledFloor(defaultDays: number, committed: number, carriedForward: number): number {
  const target = Math.max(0, Number(defaultDays) || 0)
  const floor = Math.ceil((Number(committed) || 0) - (Number(carriedForward) || 0))
  return Math.max(target, Math.max(0, floor))
}

/** LVE-006 — the encashable day count for a spendable balance under a
 *  DAYS-valued per-request cap (0/negative = uncapped). Both encashment
 *  paths (ESS request + exit settlement) derive their days through this
 *  helper so the two can never disagree about units again. */
export function encashableDaysFor(spendable: number, capDays: number): number {
  const s = Math.max(0, Number(spendable) || 0)
  const cap = Number(capDays) || 0
  return cap > 0 ? Math.min(s, cap) : s
}

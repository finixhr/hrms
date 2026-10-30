// ============ Payroll Engine (spec §9) — the central integration engine ============
// Consumes: Attendance + Leave + Overtime + Salary Structure + Bonus/Commission +
// Loan installments + Advances + Deductions + AIT.
// Produces: PayrollRun/PayrollEntry → Approval → Payment → Payslips → Accounting.
// Approved/PAID payroll is immutable; corrections go through ADJUSTMENT runs.
//
// REMEDIATION (audit C-1 / H-3 / M-5 / M-13):
//  - C-1: WEEKLY runs prorate every monthly amount by (week working days /
//    month working days) — gross, components, bonuses, recurring deductions and
//    AIT (computed on the monthly equivalent, then prorated). The absence daily
//    rate stays on the monthly basis, which is arithmetically consistent with
//    prorated gross. A payment sanity guard additionally refuses to disburse a
//    weekly run that exceeds the vendor's monthly payroll baseline.
//  - H-3: payRun runs inside db.$transaction with a conditional status claim
//    (APPROVED → PROCESSING) as the FIRST statement, so concurrent payments and
//    mid-loop crashes can never double-post or half-pay. The accounting journal
//    carries an idempotency key (PAYROLL:<runId>) as a database-level backstop.
//    Notifications and payslip emails fire AFTER commit.
//  - M-13: calculateRun batch-fetches structures, shifts, attendance, holidays,
//    bonuses, loans, advances and deductions per vendor instead of issuing
//    10–15 queries per employee.
//  - M-5: net pay is clamped at zero with an explicit breakdown warning entry.

import { db } from "@/lib/db"
import { Prisma } from "@prisma/client"
import { computeAit } from "./ait"
import { loadAitConfig } from "./ait-engine"
import { getSettings } from "./settings"
import { audit } from "./audit"
import { Deny } from "./rbac"
import { j, isoDate, monthName, weekdaysInMonth, addDays as addDaysIso, resolveWeeklyOffDays, resolveShiftAssignmentForDate } from "./utils"
import { dueInstallmentsFor, applyRecoveryFloorPaisa } from "./loan-math"
// MON-9 (Phase 4) — the engine computes in integer paisa; the legacy Float
// columns are derived. Every quantity has exactly ONE rounding boundary
// (money.ts divHalfUp/mulRatio/mulPct), and toPaisa is the single
// Float→paisa ingestion point for settings rates and legacy rows.
import { toPaisa, mulRatio, mulPct, divHalfUp, divFloor, takaOf } from "./money"
import { spendableDays } from "./leave-math"
import { pfNoteHash } from "./pf-import"

/** ISO week range (Monday–Sunday) for a (year, week) pair — Jan 4 rule. */
function isoWeekRange(year: number, week: number): { start: string; end: string } {
  const jan4 = new Date(Date.UTC(year, 0, 4))
  const dayNr = (jan4.getUTCDay() + 6) % 7
  const week1Monday = new Date(jan4)
  week1Monday.setUTCDate(jan4.getUTCDate() - dayNr)
  const monday = new Date(week1Monday.getTime() + (week - 1) * 7 * 24 * 3600 * 1000)
  const sunday = new Date(monday.getTime() + 6 * 24 * 3600 * 1000)
  const iso = (d: Date) => d.toISOString().slice(0, 10)
  return { start: iso(monday), end: iso(sunday) }
}
import type { Ctx } from "./types"
import { notifyChannels } from "./delivery"
import { submitForApproval } from "./approval"

type CalcBreakdown = {
  earnings: { label: string; amount: number }[]
  deductions: { label: string; amount: number }[]
  attendance: {
    presentDays: number; absentDays: number; leaveDays: number; unpaidLeaveDays?: number
    lateMinutes: number; lateDays?: number; lateLeaveAdjustedDays?: number; otMinutes: number; workingDays: number
  }
  gross: number; otAmount: number; bonus: number; commission: number
  absenceDeduction: number; lateDeduction: number
  earlyLeaveDeduction?: number; repeatOffenderPenalty?: number // HRM-008/009
  loanDeduction: number; advanceDeduction: number; otherDeduction: number
  otTiers?: Record<string, number> // HRM-010 — payable OT minutes per day-type tier
  lateLeaveAdjustment?: {
    leaveTypeId: string
    leaveTypeName: string
    adjustedDays: number
    unadjustedDays: number
    totalDays: number
    balanceId: string
  }
  ait: { netMonthlyAit: number; ruleSetName: string; mode: string }
  net: number
  proration?: { frequency: string; fraction: number; weekWorkingDays: number; monthWorkingDays: number } // C-1
  warnings?: string[] // M-5 — non-fatal payroll anomalies surfaced on the payslip
  bonusLines?: { id: string; amount: number }[]
  pf?: any
  guarantorRecoveries?: any[]
  recoveryDeferred?: number
}

const WD = ["SUNDAY", "MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY"]
const dowOf = (ds: string) => WD[new Date(`${ds}T00:00:00Z`).getUTCDay()]

function workingDaysFor(month: number, year: number, weeklyOff: string[]) {
  return weekdaysInMonth(year, month, weeklyOff)
}

/** C-1 — working days inside an arbitrary ISO date window for a weekly-off set. */
export function workingDaysInWindow(start: string, end: string, weeklyOff: string[]): number {
  let n = 0
  let cur = start
  let guard = 0
  while (cur <= end && guard < 400) {
    if (!weeklyOff.includes(dowOf(cur))) n++
    cur = addDaysIso(cur, 1)
    guard++
  }
  return n
}

/** C-1 — the weekly proration fraction (pure, unit-tested): weekWD / monthWD. */
export function weeklyFraction(weekWorkingDays: number, monthWorkingDays: number): number {
  if (!(monthWorkingDays > 0) || !(weekWorkingDays > 0)) return 0
  return Math.min(1, weekWorkingDays / monthWorkingDays)
}

/** PAY-003/PAY-008 (R3-2) — per-bonus amounts already disbursed by PAID runs
 *  of the SAME period, read from the bonusLines snapshots those runs recorded
 *  on their entries. Shared by calculateRun (pay only the remainder) and
 *  payRun (PAID only when the cumulative disbursement covers the bonus).
 *  MON-1 (Phase 1) — `client` lets payRun re-run this INSIDE its transaction
 *  (against the tx client), after taking the Bonus row locks, so the pay-time
 *  re-validation observes every concurrent run that has already committed. */
async function bonusPaidSoFarForPeriod(vendorId: string, periodMonth: number, periodYear: number, client: any = db): Promise<Map<string, number>> {
  const paidRuns: Array<{ id: string }> = await client.payrollRun.findMany({
    where: { vendorId, periodMonth, periodYear, status: "PAID" },
    select: { id: true },
  })
  const map = new Map<string, number>()
  if (!paidRuns.length) return map
  const entries = await client.payrollEntry.findMany({
    where: { runId: { in: paidRuns.map((r) => r.id) } },
    select: { breakdownJson: true },
  })
  for (const e of entries) {
    try {
      const bd = JSON.parse(e.breakdownJson || "{}")
      for (const bl of (Array.isArray(bd.bonusLines) ? bd.bonusLines : [])) {
        const id = String(bl.id)
        map.set(id, (map.get(id) || 0) + (Number(bl.amount) || 0))
      }
    } catch { /* legacy snapshot without lines */ }
  }
  return map
}

export async function calculateRun(
  ctx: Ctx,
  runId: string,
  onProgress?: (done: number, total: number) => Promise<void>,
  opts?: { excludeEmployeeIds?: string[] },
) {
  const run = await db.payrollRun.findFirst({ where: { id: runId, vendorId: ctx.vendorId } })
  if (!run) throw new Deny("Payroll run not found", 404)
  if (run.status !== "DRAFT" && run.status !== "CALCULATED") {
    throw new Deny(`Run is ${run.status}. Approved payroll is immutable — create an adjustment run instead.`)
  }
  // ---- MON-7 (Phase 4) — conditional claim: exactly one computation at a
  // time owns the run. The epoch is bumped conditionally on the status STILL
  // being claimable AND the epoch we read; a concurrent recalculation loses
  // the race here (count=0 → friendly 409) instead of racing the
  // (runId, employeeId) unique at rewrite time with a raw P2002 500, and a
  // racing submit-for-approval (status flip) makes the FINAL conditional
  // rewrite below a no-op that aborts with nothing written. A crash after
  // the claim leaves only a bumped epoch — no stuck intermediate status.
  const claim = await db.payrollRun.updateMany({
    where: { id: runId, vendorId: ctx.vendorId, status: { in: ["DRAFT", "CALCULATED"] }, calcEpoch: run.calcEpoch },
    data: { calcEpoch: { increment: 1 } },
  })
  if (claim.count === 0) {
    throw new Deny("This run was recalculated or submitted elsewhere while you were viewing it — refresh and retry.", 409)
  }
  const calcEpoch = run.calcEpoch + 1
  const settings = await getSettings(ctx.vendorId)
  const periodEnd = isoDate(new Date(run.periodYear, run.periodMonth, 0))
  const asOf = run.cutoffDate && run.cutoffDate <= periodEnd ? run.cutoffDate : periodEnd
  const isWeekly = run.periodWeek > 0
  const week = isWeekly ? isoWeekRange(run.periodYear, run.periodWeek) : null
  const rangeStart = week ? week.start : `${run.periodYear}-${String(run.periodMonth).padStart(2, "0")}-01`
  const rangeEnd = week ? week.end : periodEnd

  // Employees active in period (scope-filtered upstream)
  const employees = await db.employee.findMany({
    where: { vendorId: ctx.vendorId, status: { in: ["ACTIVE", "PROBATION", "ON_LEAVE", "SUSPENDED"] } },
  })
  const empIds = employees.map((e) => e.id)

  // ---- PF auto-enroll: if enabled, enroll eligible employees before loading run data ----
  // This runs at the start of every calculate so employees who became eligible since the
  // last run are picked up automatically without requiring manual per-head enrollment.
  if (settings.pf.enabled && settings.pf.autoEnroll && empIds.length) {
    const eligibleStatuses = settings.pf.eligibleStatuses?.length
      ? settings.pf.eligibleStatuses
      : ["ACTIVE", "PROBATION"]
    const alreadyEnrolled = await db.pfEnrollment.findMany({
      where: { vendorId: ctx.vendorId },
      select: { employeeId: true },
    })
    const enrolledSet = new Set(alreadyEnrolled.map((e) => e.employeeId))
    const today = new Date()
    const enrollDate = isoDate(today)
    // SCL-5 family (Phase 2 WS3) — one createMany instead of a create per
    // newly-eligible employee (a first run after enabling auto-enroll on a
    // 5K-employee tenant issued 5K sequential INSERTs before this).
    const toEnroll: { vendorId: string; employeeId: string; enrollDate: string; status: string; employeePct: any; employerPct: any; basis: any; note: string; createdBy: string | null }[] = []
    for (const emp of employees) {
      if (enrolledSet.has(emp.id)) continue
      if (!eligibleStatuses.includes(emp.status)) continue
      if (settings.pf.minServiceMonths > 0 && emp.joiningDate) {
        const months = (today.getTime() - new Date(emp.joiningDate + "T00:00:00").getTime()) / (30.44 * 86400000)
        if (months < settings.pf.minServiceMonths) continue
      }
      toEnroll.push({
        vendorId: ctx.vendorId, employeeId: emp.id, enrollDate,
        status: "ACTIVE", employeePct: settings.pf.employeePct,
        employerPct: settings.pf.employerPct, basis: settings.pf.basis,
        note: "Auto-enrolled by payroll engine (Settings → Payroll → Provident Fund → Auto Enroll)",
        createdBy: ctx.userId,
      })
    }
    if (toEnroll.length) {
      await db.pfEnrollment.createMany({ data: toEnroll }).catch(() => {})
      for (const e of toEnroll) enrolledSet.add(e.employeeId)
    }
  }

  // ---- M-13: batched context fetches (one query per data class, not per employee) ----
  const [allStructures, allAssignments, allShifts, allAttendance, allHolidays, allBonuses, allLoans, allAdvances, allDeductions, allPf, allLeaveBalances, allLeaveTypes] = await Promise.all([
    empIds.length ? db.salaryStructure.findMany({
      where: { employeeId: { in: empIds }, effectiveFrom: { lte: asOf }, status: { in: ["ACTIVE", "SUPERSEDED"] } },
      orderBy: { effectiveFrom: "desc" },
    }) : Promise.resolve([]),
    empIds.length ? db.shiftAssignment.findMany({
      where: { vendorId: ctx.vendorId, employeeId: { in: empIds }, fromDate: { lte: periodEnd }, OR: [{ toDate: null }, { toDate: { gte: rangeStart } }] },
      orderBy: { fromDate: "desc" },
    }) : Promise.resolve([]),
    db.shift.findMany({ where: { vendorId: ctx.vendorId } }),
    db.attendance.findMany({ where: { vendorId: ctx.vendorId, employeeId: { in: empIds }, date: { gte: rangeStart, lte: rangeEnd } } }),
    db.holiday.findMany({ where: { vendorId: ctx.vendorId, date: { gte: rangeStart, lte: rangeEnd } } }),
    db.bonus.findMany({ where: { vendorId: ctx.vendorId, employeeId: { in: empIds }, status: { in: ["APPROVED", "IN_PAYROLL"] }, periodMonth: run.periodMonth, periodYear: run.periodYear } }),
    db.loan.findMany({ where: { vendorId: ctx.vendorId, employeeId: { in: empIds }, status: "ACTIVE" } }),
    db.advance.findMany({ where: { vendorId: ctx.vendorId, employeeId: { in: empIds }, status: "RECOVERING", outstanding: { gt: 0 } } }),
    db.deduction.findMany({ where: { vendorId: ctx.vendorId, employeeId: { in: empIds }, month: run.periodMonth, year: run.periodYear, status: "ACTIVE" } }),
    // PF — ACTIVE enrollments only (PAUSED/CLOSED contribute nothing this cycle)
    empIds.length ? db.pfEnrollment.findMany({ where: { vendorId: ctx.vendorId, employeeId: { in: empIds }, status: "ACTIVE" } }) : Promise.resolve([]),
    // Leave balances and types for late policy leave adjustment
    empIds.length ? db.leaveBalance.findMany({ where: { vendorId: ctx.vendorId, employeeId: { in: empIds }, year: run.periodYear } }) : Promise.resolve([]),
    db.leaveType.findMany({ where: { vendorId: ctx.vendorId } }),
  ])
  const loanIds = allLoans.map((l) => l.id)
  const allInstallments = loanIds.length
    ? await db.loanInstallment.findMany({ where: { loanId: { in: loanIds }, status: { in: ["PENDING", "OVERDUE", "PARTIAL"] } }, orderBy: { no: "asc" } })
    : []
  // PAY-003/PAY-008 (R3-2) — per-bonus amounts already disbursed by PAID runs
  // of THIS period, from the bonusLines snapshots on their entries. A bonus
  // included by a later run pays only the remainder, so no fraction is ever
  // stranded and no amount is ever double-paid.
  const bonusPaidSoFar = await bonusPaidSoFarForPeriod(ctx.vendorId, run.periodMonth, run.periodYear)

  const structureByEmp = new Map<string, NonNullable<typeof allStructures[number]>[]>()
  for (const s of allStructures) {
    const list = structureByEmp.get(s.employeeId)
    if (list) list.push(s); else structureByEmp.set(s.employeeId, [s])
  }
  const assignmentByEmp = new Map<string, NonNullable<typeof allAssignments[number]>[]>()
  for (const a of allAssignments) {
    const list = assignmentByEmp.get(a.employeeId)
    if (list) list.push(a); else assignmentByEmp.set(a.employeeId, [a])
  }
  const groupByEmp = <T, K extends keyof T & string>(rows: T[], key: K) => {
    const m = new Map<string, T[]>()
    for (const r of rows) {
      const k = String(r[key])
      const list = m.get(k)
      if (list) list.push(r); else m.set(k, [r])
    }
    return m
  }
  const attByEmp = groupByEmp(allAttendance, "employeeId")
  const bonusesByEmp = groupByEmp(allBonuses, "employeeId")
  const loansByEmp = groupByEmp(allLoans, "employeeId")
  const installmentsByLoan = groupByEmp(allInstallments, "loanId")
  const advancesByEmp = groupByEmp(allAdvances, "employeeId")
  const deductionsByEmp = groupByEmp(allDeductions, "employeeId")
  const pfByEmp = new Map(allPf.map((p) => [p.employeeId, p]))
  const structureOf = (employeeId: string) => structureByEmp.get(employeeId)?.[0] // latest first (ordered desc)
  const shiftOf = (employeeId: string, defaultShiftId: string | null, date?: string) => {
    // ATT-008 — per-date resolution for rotating employees: when a date is
    // given, the assignment covering THAT date wins (the period-end
    // assignment stays the default for period-level concepts)
    const shiftId = date
      ? resolveShiftAssignmentForDate(assignmentByEmp.get(employeeId), defaultShiftId, date)
      : assignmentByEmp.get(employeeId)?.[0]?.shiftId || defaultShiftId
    return shiftId ? allShifts.find((s) => s.id === shiftId) : null
  }
  const attOf = (employeeId: string) => attByEmp.get(employeeId) || []
  const holidaysOf = (branchId: string | null) => allHolidays.filter((h) => !h.branchId || h.branchId === branchId) // small list — linear scan is fine
  const bonusesOf = (employeeId: string) => bonusesByEmp.get(employeeId) || []
  const loansOf = (employeeId: string) => loansByEmp.get(employeeId) || []
  const installmentsOf = (loanId: string) => installmentsByLoan.get(loanId) || []
  const advancesOf = (employeeId: string) => advancesByEmp.get(employeeId) || []
  const deductionsOf = (employeeId: string) => deductionsByEmp.get(employeeId) || []
  const pfOf = (employeeId: string) => pfByEmp.get(employeeId)

  const monthPrefix = `${run.periodYear}-${String(run.periodMonth).padStart(2, "0")}`
  // MON-9 — run totals accumulate in paisa; the Float totals are derived at
  // the end (they used to be float sums of already-rounded floats).
  // R5-008 — AIT calculation log entries are collected here and batch-inserted
  // after the loop with a single createMany call instead of one awaited INSERT
  // per employee (N+1 pattern that adds ~500 round-trips for a 500-employee run).
  const aitLogBatch: any[] = []
  let totalGrossP = 0n, totalOtP = 0n, totalBonusP = 0n, totalDeductionP = 0n, totalAitP = 0n, totalNetP = 0n
  let count = 0
  const newEntries: any[] = []

  // HIGH-7 (this audit) — pre-fetch the AIT config ONCE outside the per-employee
  // loop. Previously computeAit() re-fetched the entire AitFiscalYear + categories
  // + slabs for every employee, producing 1500-2000 extra DB round-trips for a
  // 500-employee calc. The config is vendor-scoped and identical for all employees.
  // P1-fix (re-audit 2026-10-18) — bootstrap ON FIRST USE, HERE. computeAit
  // self-bootstraps too, but that happens AFTER this function has already
  // derived monthsRemainingInFy and the annualEstimate from the null config
  // (12-month default). A vendor's FIRST-EVER run therefore withheld AIT on a
  // 12-month projection while every later recalculation of the same period
  // used the true remaining months — with unchanged data the recomputed AIT
  // no longer equalled the source AIT and PAY-001 adjustment deltas were
  // non-zero out of thin air (e.g. 6 employees × ৳333). Pre-bootstrapping
  // keeps the first run on the SAME §86 projection every later run uses.
  let aitConfig = await loadAitConfig(ctx.vendorId).catch(() => null)
  if (!aitConfig) {
    const { ensureAitConfig } = await import("./ait-engine")
    await ensureAitConfig(ctx.vendorId).catch(() => {})
    aitConfig = await loadAitConfig(ctx.vendorId).catch(() => null)
  }

  // ---- r8 legal audit (2026-10-14) — §86 estimated-annual-income actuals ----
  // The Income Tax Act 2023 s.86(1) withholds at the average rate on the
  // ESTIMATED total income, and s.86(4) requires each month's deduction to be
  // adjusted with any previous surplus or deficit. Both need the ACTUAL
  // year-to-date figures from PAID runs inside the active income-year window
  // (1 July – 30 June), before the period this run is calculating:
  //   ytdEarnings[emp] = gross + OT + bonus + commission already PAID this FY
  //   ytdAit[emp]      = TDS already deducted this FY (own runs)
  //   ytdBonus[emp]    = festival/other bonuses already paid (projection guard)
  // The previous behaviour — annualising whichever month happened to contain a
  // bonus (i.e. (gross+bonus+OT)×12) — produced TDS spikes in bonus months and
  // disagrees with the AIT module; it is replaced by the estimate built below.
  let monthsRemainingInFy = 12
  if (aitConfig) {
    const fyStartYear = Number(String(aitConfig.incomeYear).slice(0, 4))
    if (Number.isFinite(fyStartYear)) {
      // calendar months of the income year remaining INCLUDING this run's
      // period (Jul=1 … Jun=12): months from this period to the FY end.
      const fyStartMonthIdx = (run.periodMonth - 7 + 12) % 12 // 0-based offset from July
      monthsRemainingInFy = Math.min(12, Math.max(1, 12 - fyStartMonthIdx))
    }
  }
  const paidRuns = aitConfig
    ? await db.payrollRun.findMany({
        where: { vendorId: ctx.vendorId, status: "PAID" },
        select: { id: true, periodMonth: true, periodYear: true, periodWeek: true, paymentDate: true },
      })
    : []
  // runs inside the FY window (1 Jul → 30 Jun) strictly BEFORE this run's
  // period — weekly runs of earlier ISO weeks and monthly runs of earlier
  // months alike; both frequencies accumulate the year-to-date actuals.
  const fyStartYearNum = Number(String(aitConfig?.incomeYear || "").slice(0, 4))
  const fyEndYearNum = Number("20" + String(aitConfig?.incomeYear || "").slice(-2))
  const isBeforeCurrentPeriod = (r: { periodYear: number; periodMonth: number; periodWeek: number }) => {
    if (isWeekly) {
      if (r.periodYear !== run.periodYear) return r.periodYear < run.periodYear
      if (r.periodWeek > 0) return r.periodWeek < run.periodWeek
      return r.periodMonth < run.periodMonth
    }
    return r.periodYear < run.periodYear || (r.periodYear === run.periodYear && r.periodMonth < run.periodMonth)
  }
  const fyPaidRuns = paidRuns.filter((r) =>
    Number.isFinite(fyStartYearNum) &&
    ((r.periodYear === fyStartYearNum && r.periodMonth >= 7) || (r.periodYear === fyEndYearNum && r.periodMonth <= 6)) &&
    isBeforeCurrentPeriod(r))
  const fyEntries = fyPaidRuns.length
    ? await db.payrollEntry.findMany({
        where: { runId: { in: fyPaidRuns.map((r) => r.id) }, employeeId: { in: empIds } },
        select: { employeeId: true, gross: true, otAmount: true, bonus: true, commission: true, ait: true },
      })
    : []
  const ytdEarnings = new Map<string, number>()
  const ytdBonus = new Map<string, number>()
  const ytdAit = new Map<string, number>()
  for (const e of fyEntries) {
    ytdEarnings.set(e.employeeId, (ytdEarnings.get(e.employeeId) || 0) + (e.gross || 0) + (e.otAmount || 0) + (e.bonus || 0) + (e.commission || 0))
    ytdBonus.set(e.employeeId, (ytdBonus.get(e.employeeId) || 0) + (e.bonus || 0))
    ytdAit.set(e.employeeId, (ytdAit.get(e.employeeId) || 0) + (e.ait || 0))
  }
  const monthsRemainingOf = () => monthsRemainingInFy

  // WP-A — async execution + cooperative cancellation checkpoint inside the
  // per-employee loop (an admin cancel or a progress poll lands here).
  let progressTick = 0
  const reportProgress = () => {
    progressTick++
    if (onProgress && progressTick % 25 === 0) return onProgress(Math.min(progressTick, employees.length), employees.length)
    return Promise.resolve()
  }

  // WP-G — preflight auto-exclusion: BLOCKED employees (no structure / not in
  // payroll scope / failed payout validation) are skipped at the caller's
  // request and recorded in the run summary (excludedJson).
  const excludeSet = new Set(opts?.excludeEmployeeIds || [])
  // 2026-10-14 — run-level proration fallback for the guarantor post-pass
  // below: borrower-side fractions are unavailable there (the borrower may
  // have no payroll entry at all), so weekly runs prorate the moved
  // installment with the GLOBAL weekly-off policy. Monthly runs never prorate.
  // MON-9 — the post-pass prorates with the same integer paisa machinery:
  // the GLOBAL weekly-off policy day counts (borrower-side fractions are
  // unavailable here — the borrower may have no entry at all).
  const runWeekWorkingDays = isWeekly
    ? workingDaysInWindow(rangeStart, rangeEnd, settings.general.weeklyHoliday) : 0
  const runMonthWorkingDays = isWeekly
    ? workingDaysFor(run.periodMonth, run.periodYear, settings.general.weeklyHoliday) : 0

  const excluded: { id: string; code: string; name: string; reason: string }[] = []
  for (const emp of employees) {
    if (excludeSet.has(emp.id)) {
      excluded.push({ id: emp.id, code: emp.code, name: emp.fullName, reason: "excluded by preflight (blocked)" })
      continue
    }
    if (!emp.joiningDate || emp.joiningDate > (isWeekly ? rangeEnd : periodEnd)) continue
    const structure = structureOf(emp.id)
    if (!structure) continue // no salary structure → excluded

    const shift = shiftOf(emp.id, emp.shiftId)
    // 2026-10-13 — canonical weekly-off precedence (employee > shift > global
    // policy) via resolveWeeklyOffDays — payroll previously resolved
    // shift > employee > settings, disagreeing with every other engine
    const weeklyOff = resolveWeeklyOffDays(emp.weeklyOff, shift?.weeklyOff, settings.general.weeklyHoliday)
    const monthWorkingDays = workingDaysFor(run.periodMonth, run.periodYear, weeklyOff)

    // ---- C-1: weekly proration fraction ----
    const weekWorkingDays = isWeekly ? workingDaysInWindow(rangeStart, rangeEnd, weeklyOff) : monthWorkingDays
    const fraction = isWeekly ? weeklyFraction(weekWorkingDays, monthWorkingDays) : 1
    if (isWeekly && fraction <= 0) continue // no payable working days in this window

    // ---- attendance aggregation ----
    const att = attOf(emp.id)
    const holidayDates = new Set(holidaysOf(emp.branchId).map((h) => h.date))
    let presentDays = 0, absentDays = 0, leaveDays = 0, lateMinutes = 0, otMinutes = 0
    let approvedOtMinutes = 0
    let unpaidLeaveDays = 0
    for (const a of att) {
      switch (a.status) {
        case "PRESENT": presentDays += 1; break
        case "LATE": presentDays += 1; break
        case "EARLY_LEAVE": presentDays += 1; break
        case "WFH": case "BUSINESS_TRIP": presentDays += 1; break
        case "HALF_DAY": presentDays += 0.5; absentDays += 0.5; break
        case "LEAVE": leaveDays += 1; break
        // LVE-001 (R3-4) — unpaid (LWP) leave is now UNPAID, not silently
        // paid. The leave approval writes LEAVE_UNPAID attendance rows for
        // types with paid=false; the day counts as leave for reporting AND
        // as an absence for pay, so absence proration deducts it exactly
        // like the audit trail says it should. (Cancelling an unpaid leave
        // used to be the financially BETTER move — cancelling flipped the
        // rows to ABSENT and payroll deducted; keeping it paid them.)
        case "LEAVE_UNPAID": leaveDays += 1; absentDays += 1; unpaidLeaveDays += 1; break
        case "ABSENT": absentDays += 1; break
        default: break // WEEKLY_OFF / HOLIDAY
      }
      lateMinutes += a.lateMinutes || 0
      otMinutes += a.overtimeMinutes || 0
      // OT approval policy (spec §7.6): when approval is required, only approved OT counts
      if (!(settings.shift.otApprovalRequired && a.otApproved === false)) approvedOtMinutes += a.overtimeMinutes || 0
    }
    // days with no record at all count as absent unless holiday/weekly-off
    // (weekly runs scan only the ISO week window; monthly runs scan the month)
    const loopStart = isWeekly ? rangeStart : `${monthPrefix}-01`
    const loopEnd = isWeekly ? rangeEnd : periodEnd
    for (let ds = loopStart; ds <= loopEnd && ds <= asOf; ds = addDaysIso(ds, 1)) {
      if (ds < (emp.joiningDate || "0000")) continue
      const exists = att.some((a) => a.date === ds)
      if (exists) continue
      const dow = dowOf(ds)
      if (weeklyOff.includes(dow)) continue
      if (holidayDates.has(ds)) continue
      absentDays += 1
    }

    // ---- overtime with day-type rates (spec §7.6 weekday / holiday / weekly-off) ----
    const otRates = settings.otRates || { weekdayRate: 1.5, holidayRate: 2, weeklyOffRate: 2, calcBasis: "FIXED", roundToMinutes: 0 }
    const roundOt = (mins: number) => {
      const step = Math.max(0, otRates.roundToMinutes || 0)
      if (!step || otRates.calcBasis === "FIXED") return mins
      return otRates.calcBasis === "ROUNDED_UP" ? Math.ceil(mins / step) * step : Math.round(mins / step) * step
    }
    // C-1 — OT is earned in the window itself and is NOT prorated.
    // MON-9 — integer paisa, per-tier integer numerators, ONE division per
    // tier by 60×208×100:  otP = Σ_tier divHalfUp(basicP × minutes × mult%, 60·208·100)
    // (mult as hundredths: 1.5× = 150). Whole-taka basics with integer
    // minutes reproduce the legacy Math.round exactly; fractional basics
    // keep their paisa instead of losing it to a float sum.
    const basicP = toPaisa(structure.basic)
    const OT_DEN = 60n * 208n * 100n
    let otAmountP = 0n
    const otTierTotals: Record<string, number> = {}
    if (emp.otEligible !== false) {
      const otCapMinutes = settings.shift.maxOtHoursPerMonth > 0 ? settings.shift.maxOtHoursPerMonth * 60 : Infinity
      let cappedOtMinutes = Math.min(approvedOtMinutes, otCapMinutes)
      // per-tier integer numerators: tier minutes × multiplier-hundredths,
      // accumulated exactly and divided ONCE per tier at the end
      const tierNum: Record<string, { mins: number; multH: number }> = {}
      const tierOrder: string[] = []
      for (const a of att) {
        if (cappedOtMinutes <= 0) break
        if (!(a.overtimeMinutes > 0)) continue
        if (settings.shift.otApprovalRequired && a.otApproved === false) continue
        const take = Math.min(a.overtimeMinutes, cappedOtMinutes)
        cappedOtMinutes -= take
        const dow = dowOf(a.date)
        // ATT-008 — the tier (and its multiplier) resolve on the shift THE
        // EMPLOYEE WORKED THAT DATE, not the period-end assignment: a
        // rotating employee's Friday shift and weekday shift can carry
        // different weekly-offs and multipliers, and the OT register /
        // attendance engines resolve per-date.
        const dayShift = shiftOf(emp.id, emp.shiftId, a.date)
        const dayOffs = resolveWeeklyOffDays(emp.weeklyOff, dayShift?.weeklyOff, settings.general.weeklyHoliday)
        const isHoliday = holidayDates.has(a.date)
        const tier = isHoliday ? "holiday" : dayOffs.includes(dow) ? "weekly-off" : "weekday"
        const multiplier = isHoliday ? (dayShift?.otHolidayMultiplier ?? otRates.holidayRate)
          : dayOffs.includes(dow) ? (dayShift?.otWeeklyOffMultiplier ?? otRates.weeklyOffRate)
          : (dayShift?.otMultiplier ?? otRates.weekdayRate)
        const payable = Math.max(0, roundOt(take))
        const multH = Math.round(Number(multiplier) * 100)
        const acc = tierNum[tier]
        if (acc) { acc.mins += payable; /* R5-003 — keep first-seen multiplier per tier; last-writer-wins overwrites would silently change the rate */ } else { tierNum[tier] = { mins: payable, multH }; tierOrder.push(tier) }
        otTierTotals[tier] = (otTierTotals[tier] || 0) + payable
      }
      for (const tier of tierOrder) {
        const { mins, multH } = tierNum[tier]
        if (mins > 0 && multH > 0) {
          otAmountP += divHalfUp(basicP * BigInt(mins) * BigInt(multH), OT_DEN)
        }
      }
    }

    // ---- gross from structure (C-1: prorated for weekly runs) ----
    // MON-9 — grossP = the full-month gross ingested once, prorated with the
    // single mulRatio boundary (weekly); monthly runs take it verbatim.
    const grossMonthlyP = toPaisa(structure.gross)
    const grossP = isWeekly ? mulRatio(grossMonthlyP, weekWorkingDays, monthWorkingDays) : grossMonthlyP
    // Absence daily rate stays on the MONTHLY basis: with prorated weekly gross,
    // gross_week / weekWD == gross_month / monthWD — the deduction is consistent
    // in both frequencies by construction. MON-9: the daily rate is never
    // materialized as a float; absence is divHalfUp(grossP × 2×absentDays, 2×monthWD)
    // — the ×2 numerator keeps HALF_DAYS exact (absentDays comes in 0.5 steps).
    const monthWd = BigInt(Math.max(1, monthWorkingDays))
    const basicMonthlyP = basicP

    // ---- deductions ----
    // MON-9 — every deduction is integer paisa with ONE boundary each. The
    // ×2 numerator trick keeps half-days (HALF_DAY attendance = 0.5 absent)
    // and fractional deductDays (0.5/1.5/2.5) exact without float rates.
    const absenceDeductionP = settings.payroll.absenceProration
      ? divHalfUp(grossMonthlyP * BigInt(Math.round(absentDays * 2)), monthWd * 2n)
      : 0n
    // PAY-04 — the "Attendance bonus requires full month" policy was rendered
    // as a switch but never read by the engine: when ON, ANY absence in the
    // period forfeits the attendance allowance entirely (the classic BD
    // full-month rule). The absence proration above already removed the
    // absent-day share of the allowance, so the forfeiture line takes only
    // the REMAINDER — the two never double-deduct. Weekly runs prorate the
    // forfeiture like every other monthly amount.
    let attendanceBonusForfeitP = 0n
    if (settings.payroll.attendanceBonusFullMonth !== false && absentDays > 0 && toPaisa(structure.attendanceAllow) > 0n) {
      const allowP = toPaisa(structure.attendanceAllow)
      const proratedShareP = divHalfUp(allowP * BigInt(Math.round(absentDays * 2)), monthWd * 2n)
      const forfeitMonthlyP = allowP > proratedShareP ? allowP - proratedShareP : 0n
      attendanceBonusForfeitP = isWeekly ? mulRatio(forfeitMonthlyP, weekWorkingDays, monthWorkingDays) : forfeitMonthlyP
    }
    // HRM-008 — late-coming policy: flexible rules (tiered, day salary deduction, leave adjustment, fixed amount, per-minute, max cap).
    const lateDays = att.filter((a) => a.status === "LATE" && (a.lateMinutes || 0) > 0)
    const latePolicy = settings.latePolicy || {
      graceMinutes: 0,
      deductionMode: "TIERED",
      fixedDeductionPerDay: 50,
      perMinuteDeduction: 0,
      lateDaysThreshold: 3,
      deductDays: 1,
      salaryBasis: "BASIC",
      leaveAdjustmentEnabled: false,
      leaveTypeId: "FIRST_AVAILABLE_PAID",
      leaveInsufficientFallback: "DEDUCT_SALARY",
      tier1Minutes: 0,
      tier1Penalty: 0,
      tier2Minutes: 0,
      tier2Penalty: 0,
      repeatOffenderDays: 0,
      repeatOffenderPenalty: 0,
      maxDeductionCap: 0,
    }
    let lateDeductionP = 0n
    let repeatOffenderPenaltyP = 0n
    let lateLeaveAdjustment: {
      leaveTypeId: string
      leaveTypeName: string
      adjustedDays: number
      unadjustedDays: number
      totalDays: number
      balanceId: string
    } | null = null

    // Determine deduction mode with backward-compatible fallbacks:
    const lateMode = latePolicy.deductionMode || (
      settings.attendance.lateDeductionPerMinute > 0
        ? "PER_MINUTE"
        : (latePolicy.tier1Penalty > 0 || latePolicy.tier2Penalty > 0)
        ? "TIERED"
        : settings.attendance.lateDeductionPerInstance > 0
        ? "FIXED_AMOUNT"
        : "TIERED"
    )

    if (lateMode === "NONE") {
      lateDeductionP = 0n
    } else if (lateMode === "PER_MINUTE") {
      const perMin = Number(latePolicy.perMinuteDeduction) || Number(settings.attendance.lateDeductionPerMinute) || 0
      lateDeductionP = toPaisa(lateMinutes * perMin)
    } else if (lateMode === "FIXED_AMOUNT") {
      const perDay = Number(latePolicy.fixedDeductionPerDay) || Number(settings.attendance.lateDeductionPerInstance) || 0
      lateDeductionP = toPaisa(lateDays.length * perDay)
    } else if (lateMode === "DAY_SALARY" || lateMode === "LEAVE_ADJUSTMENT" || latePolicy.leaveAdjustmentEnabled) {
      const threshold = Math.max(1, Number(latePolicy.lateDaysThreshold) || 3)
      const deductDaysCount = Math.max(0.5, Number(latePolicy.deductDays) || 1)
      const intervals = Math.floor(lateDays.length / threshold)
      const totalDaysToDeduct = intervals * deductDaysCount
      // ×2 keeps fractional deductDays (0.5 steps) integer in the numerator
      const basisMonthlyP = latePolicy.salaryBasis === "GROSS" ? grossMonthlyP : basicMonthlyP

      const shouldAdjustLeave = lateMode === "LEAVE_ADJUSTMENT" || !!latePolicy.leaveAdjustmentEnabled
      if (shouldAdjustLeave && totalDaysToDeduct > 0) {
        const empBalances = allLeaveBalances.filter((b) => b.employeeId === emp.id)
        let targetType: any = null
        let targetBal: any = null

        if (latePolicy.leaveTypeId && latePolicy.leaveTypeId !== "FIRST_AVAILABLE_PAID") {
          targetType = allLeaveTypes.find((t) => t.id === latePolicy.leaveTypeId)
          targetBal = empBalances.find((b) => b.leaveTypeId === latePolicy.leaveTypeId)
        } else {
          const paidTypes = allLeaveTypes.filter((t) => t.paid !== false)
          const sorted = [...paidTypes].sort((a, b) => {
            const aCasual = /casual|cl/i.test(a.code) || /casual/i.test(a.name)
            const bCasual = /casual|cl/i.test(b.code) || /casual/i.test(b.name)
            if (aCasual && !bCasual) return -1
            if (!aCasual && bCasual) return 1
            const aEarned = /earned|annual|el|al/i.test(a.code) || /earned|annual/i.test(a.name)
            const bEarned = /earned|annual|el|al/i.test(b.code) || /earned|annual/i.test(b.name)
            if (aEarned && !bEarned) return -1
            if (!aEarned && bEarned) return 1
            return 0
          })

          for (const st of sorted) {
            const b = empBalances.find((x) => x.leaveTypeId === st.id)
            if (b && spendableDays(b) > 0) {
              targetType = st
              targetBal = b
              break
            }
          }
          if (!targetBal && sorted.length > 0) {
            targetType = sorted[0]
            targetBal = empBalances.find((x) => x.leaveTypeId === targetType.id)
          }
        }

        if (!targetBal && targetType) {
          try {
            targetBal = await db.leaveBalance.create({
              data: {
                vendorId: ctx.vendorId,
                employeeId: emp.id,
                leaveTypeId: targetType.id,
                year: run.periodYear,
                entitled: targetType.defaultDays || 0,
                used: 0,
                pending: 0,
                carriedForward: 0,
              },
            })
            ;(allLeaveBalances as any[]).push(targetBal)
          } catch {
            targetBal = await db.leaveBalance.findFirst({
              where: { employeeId: emp.id, leaveTypeId: targetType.id, year: run.periodYear },
            })
          }
        }

        const availableDays = targetBal ? Math.max(0, spendableDays(targetBal)) : 0
        const adjustedDays = Math.min(totalDaysToDeduct, availableDays)
        const unadjustedDays = totalDaysToDeduct - adjustedDays

        if (adjustedDays > 0 && targetBal) {
          lateLeaveAdjustment = {
            leaveTypeId: targetBal.leaveTypeId,
            leaveTypeName: targetType?.name || "Leave",
            adjustedDays,
            unadjustedDays,
            totalDays: totalDaysToDeduct,
            balanceId: targetBal.id,
          }
        }

        if (unadjustedDays > 0) {
          const fallback = latePolicy.leaveInsufficientFallback || "DEDUCT_SALARY"
          if (fallback === "DEDUCT_SALARY" || fallback === "UNPAID_ABSENCE") {
            lateDeductionP += divHalfUp(basisMonthlyP * BigInt(Math.round(unadjustedDays * 2)), monthWd * 2n)
          }
        }
      } else {
        lateDeductionP = divHalfUp(basisMonthlyP * BigInt(Math.round(totalDaysToDeduct * 2)), monthWd * 2n)
      }
    } else {
      // TIERED penalties (default / legacy) — each tier amount is ingested
      // once through toPaisa; the sum is exact (the legacy Math.round of a
      // float sum could drift a paisa on fractional penalties)
      for (const d of lateDays) {
        if (latePolicy.tier2Penalty > 0 && latePolicy.tier2Minutes > 0 && d.lateMinutes > latePolicy.tier2Minutes) {
          lateDeductionP += toPaisa(latePolicy.tier2Penalty)
        } else if (latePolicy.tier1Penalty > 0 && latePolicy.tier1Minutes > 0 && d.lateMinutes > latePolicy.tier1Minutes) {
          lateDeductionP += toPaisa(latePolicy.tier1Penalty)
        } else {
          lateDeductionP += toPaisa(Number(latePolicy.fixedDeductionPerDay) || Number(settings.attendance.lateDeductionPerInstance) || 0)
        }
      }
    }

    if (latePolicy.repeatOffenderDays > 0 && latePolicy.repeatOffenderPenalty > 0 && lateDays.length >= latePolicy.repeatOffenderDays) {
      repeatOffenderPenaltyP = toPaisa(latePolicy.repeatOffenderPenalty)
    }

    // Maximum late deduction cap (৳) — MON-9: the cap itself is ingested once
    // and the redistribution is exact integer arithmetic
    const maxLateCap = Number(latePolicy.maxDeductionCap) || 0
    if (maxLateCap > 0) {
      const capP = toPaisa(maxLateCap)
      const totalLatePenaltyP = lateDeductionP + repeatOffenderPenaltyP
      if (totalLatePenaltyP > capP) {
        if (repeatOffenderPenaltyP >= capP) {
          repeatOffenderPenaltyP = capP
          lateDeductionP = 0n
        } else {
          lateDeductionP = capP - repeatOffenderPenaltyP
        }
      }
    }
    // HRM-009 — early-leave policy. Audit Low note: a LATE day is already penalized
    // by the late tiers, so the early-leave counter excludes LATE rows to avoid
    // double-penalizing the same arrival.
    const earlyLeavePolicy = settings.earlyLeavePolicy || { thresholdMinutes: 15, deductionPerInstance: 0 }
    const earlyLeaveCount = att.filter((a) =>
      (a.earlyLeaveMinutes || 0) > 0 && ["EARLY_LEAVE", "PRESENT", "WFH", "BUSINESS_TRIP"].includes(a.status)
    ).length
    const earlyLeaveDeductionP = toPaisa(earlyLeaveCount * (earlyLeavePolicy.deductionPerInstance || 0))

    // ---- bonuses & commissions approved for this period ----
    // PAY-003 (R3-2) — the exact included rows (ids + line amounts) are
    // recorded on the entry (breakdownJson.bonusLines) so payRun marks ONLY
    // those PAID; the old blanket period-matched marking paid bonuses that
    // were never inside any entry.
    // PAY-008 (R3-2) — bonuses are NOT prorated per week any more: weekly
    // proration stranded 60–80% of every bonus (the first paid week flipped
    // the whole bonus to PAID while later weeks never saw it). A bonus rides
    // the FIRST run that includes the employee at its FULL REMAINING amount
    // (amount − what PAID entries of the same period already disbursed);
    // IN_PAYROLL marks a partially-disbursed bonus and a later run of the
    // period picks up the remainder.
    const bonuses = bonusesOf(emp.id)
    let bonusAmtP = 0n, commissionAmtP = 0n
    const bonusLines: { id: string; type: string; amount: number }[] = []
    for (const b of bonuses) {
      // MON-9 — the bonus and the already-disbursed float snapshot are each
      // ingested once; the remainder is exact paisa (the legacy Math.round
      // could strand/duplicate a paisa of a partially-paid bonus)
      const paidSoFarP = toPaisa(Math.max(0, bonusPaidSoFar.get(b.id) || 0))
      const amountP = toPaisa(b.amount) - paidSoFarP
      if (!(amountP > 0n)) continue
      const amount = takaOf(amountP)
      bonusLines.push({ id: b.id, type: b.type, amount })
      if (b.type === "SALES_COMMISSION" || b.type === "TARGET") commissionAmtP += amountP
      else bonusAmtP += amountP
    }

    // ---- loan installments due this month (C-1: prorated weekly) ----
    // LOA-001 (R3-4) — arrears budgeting: a run now picks up unpaid
    // installments DUE ON OR BEFORE the period month (oldest first), not
    // just the current month's. A missed EMI (no run, borrower excluded,
    // deduction disabled that month, weekly proration shortfall) used to
    // defer to NEVER — later runs only looked at their own month. The daily
    // job separately marks past-due unpaid installments OVERDUE.
    let loanDeductionP = 0n
    if (settings.payroll.loanDeductionEnabled) {
      const arrearsMax = Math.max(0, Number((settings.payroll as any).loanArrearsMax) || 0)
      for (const loan of loansOf(emp.id)) {
        const due = dueInstallmentsFor(installmentsOf(loan.id), monthPrefix, arrearsMax)
        // MON-9 — each installment's remaining balance ingested once, summed
        // exactly, prorated with the single mulRatio boundary (weekly)
        const dueP = due.reduce((s, i) => s + toPaisa(i.amount) - toPaisa(i.paidAmount), 0n)
        loanDeductionP += isWeekly ? mulRatio(dueP, weekWorkingDays, monthWorkingDays) : dueP
      }
    }

    // ---- advance recovery this month (C-1: prorated weekly) ----
    // MON-9 — the per-installment split amount/installments is a RATIONAL
    // sum over a common denominator: each advance contributes numerator
    // amountP×(K/inst) (or outstandingP×K when the cap bites), the total is
    // divided ONCE by K (lcm of the installment counts) — no intermediate
    // rounding, so a 3-installment ৳1,000 advance recovers ৳333.34/333.33/333.33
    // across three runs instead of three × ৳333.33 and a stranded paisa.
    let advanceDeductionP = 0n
    if (settings.payroll.advanceDeductionEnabled) {
      const terms: { num: bigint; den: bigint }[] = []
      for (const adv of advancesOf(emp.id)) {
        const recoveryMonth = (adv.recoveryDate || adv.requestDate).slice(0, 7)
        if (recoveryMonth > monthPrefix) continue
        const amountP = toPaisa(adv.amount)
        const outstandingP = toPaisa(adv.outstanding)
        const inst = Math.max(1, Math.floor(Number(adv.installments) || 0)) || 1
        // cap at outstanding: min(amount/inst, outstanding) as a rational
        if (amountP <= outstandingP * BigInt(inst)) terms.push({ num: amountP, den: BigInt(inst) })
        else terms.push({ num: outstandingP * BigInt(inst), den: BigInt(inst) })
      }
      if (terms.length) {
        const lcm = (a: bigint, b: bigint): bigint => {
          const gcd = (x: bigint, y: bigint): bigint => (y === 0n ? x : gcd(y, x % y))
          return a === 0n || b === 0n ? a + b : (a * b) / gcd(a, b)
        }
        let K = 1n
        for (const t of terms) K = lcm(K, t.den)
        let sumP = 0n
        for (const t of terms) sumP += t.num * (K / t.den)
        advanceDeductionP = isWeekly ? mulRatio(divHalfUp(sumP, K), weekWorkingDays, monthWorkingDays) : divHalfUp(sumP, K)
      }
    }

    // ---- other deductions (manual + recurring) for this month (C-1: prorated weekly) ----
    // MON-9 — the parity defect fix: the sum is EXACT paisa (the legacy float
    // sum was written UNROUNDED into otherDeduction while the payslip lines
    // were whole-taka rounded — a 1 paisa line-sum mismatch)
    const others = deductionsOf(emp.id)
    const othersSumP = others.reduce((s, d) => s + toPaisa(d.amount), 0n)
    const otherDeductionP = isWeekly ? mulRatio(othersSumP, weekWorkingDays, monthWorkingDays) : othersSumP

    // ---- Provident Fund (employee contribution withheld + employer cost) ----
    // Rules: Settings → Payroll → Provident Fund (vendor defaults) with
    // per-employee overrides on the enrollment. PAUSED/CLOSED enrollments were
    // filtered out at fetch. Weekly runs prorate exactly like loans (C-1).
    // Status check: only employees whose employment status is in settings.pf.eligibleStatuses qualify.
    const pfEligibleStatuses = settings.pf?.eligibleStatuses?.length
      ? settings.pf.eligibleStatuses
      : ["ACTIVE", "PROBATION"]
    const isEmpStatusPfEligible = pfEligibleStatuses.includes(emp.status)
    const pf = (settings.pf?.enabled && isEmpStatusPfEligible) ? pfOf(emp.id) : undefined
    let pfEmployeeP = 0n, pfEmployerP = 0n
    let pfMeta: { employeeAmount: number; employerAmount: number; employeePct: number; employerPct: number; basis: string } | undefined
    if (pf) {
      // MON-9 — mulPct: the percentage ingested once, the split lands on
      // paisa with the single half-up boundary; weekly proration composes
      // through mulRatio (both boundaries explicit)
      const basisP = pf.basis === "GROSS" ? grossMonthlyP : basicMonthlyP
      pfEmployeeP = mulPct(basisP, pf.employeePct)
      pfEmployerP = mulPct(basisP, pf.employerPct)
      if (isWeekly) {
        pfEmployeeP = mulRatio(pfEmployeeP, weekWorkingDays, monthWorkingDays)
        pfEmployerP = mulRatio(pfEmployerP, weekWorkingDays, monthWorkingDays)
      }
      pfMeta = { employeeAmount: takaOf(pfEmployeeP), employerAmount: takaOf(pfEmployerP), employeePct: pf.employeePct, employerPct: pf.employerPct, basis: pf.basis }
    }

    // ---- AIT — §86 Income Tax Act 2023 (r8 legal audit) ----
    // §86(1): withhold at the average rate on the ESTIMATED total income.
    // §86(4): adjust each month's deduction with any previous surplus or
    // deficit. The estimate is built from ACTUALS (earnings already PAID this
    // income year) + this period's payment + a projection of the remaining
    // months at the regular monthly gross + the remaining festival-bonus
    // projection + previous-employer income — so a bonus lands ONCE in the
    // estimate (in the month paid), never ×12 as before.
    // MON-9 — the engine's own quantities are exact paisa; the AIT engine
    // stays float (its slab arithmetic is a separate, journaled concern), so
    // its INPUTS are derived floats (fromPaisa) and its OUTPUT is ingested
    // back through toPaisa exactly once — the single AIT boundary.
    const weeklyTaxableP = grossP + otAmountP + bonusAmtP + commissionAmtP
    const weeklyTaxable = takaOf(weeklyTaxableP)
    const monthlyEquivalent = isWeekly && fraction > 0 ? weeklyTaxable / fraction : weeklyTaxable
    // HIGH-7 — pass the pre-fetched aitConfig into computeAit to avoid N+1.
    // R2 (2026-10-12) — also forward the employee's tax profile so category
    // thresholds, senior auto-detection and the Sec 78 investment rebate apply
    // on payslips exactly like the AIT module calculator (they previously
    // disagreed: payroll always taxed at the general threshold, no rebate).
    const ytdEarn = ytdEarnings.get(emp.id) || 0
    const ytdBon = ytdBonus.get(emp.id) || 0
    const ytdAitOwn = ytdAit.get(emp.id) || 0
    const regularGross = structure?.gross ?? 0
    const bonusCountForYear = emp.festivalBonusOverride != null && Number.isFinite(emp.festivalBonusOverride) && emp.festivalBonusOverride >= 0
      ? emp.festivalBonusOverride
      : (aitConfig?.festivalBonusCount ?? 2)
    const remainingBonusProjection = Math.max(0,
      Math.round((structure?.basic ?? 0) * bonusCountForYear) - ytdBon - takaOf(bonusAmtP))
    const monthsAfterThis = Math.max(0, monthsRemainingOf() - 1)
    const annualEstimate = emp.annualGrossOverride != null && Number.isFinite(emp.annualGrossOverride) && emp.annualGrossOverride > 0
      ? Math.round(emp.annualGrossOverride)
      : Math.round(ytdEarn + weeklyTaxable + monthsAfterThis * regularGross + remainingBonusProjection + Math.max(0, emp.previousEmployerIncome || 0))
    // §86(4) adjustment base: own PAID-run TDS this income year + genuinely
    // prior withholding (previous-employer TDS stored on the master record).
    const tdsWithheldYtd = ytdAitOwn + Math.max(0, emp.taxAlreadyDeducted || 0)
    const ait = await computeAit({
      vendorId: ctx.vendorId, monthlyTaxableIncome: monthlyEquivalent,
      previousEmployerIncome: emp.previousEmployerIncome || 0,
      previousTaxDeducted: emp.taxAlreadyDeducted || 0,
      config: aitConfig,
      employeeProfile: {
        taxpayerCategory: emp.taxCategory || null,
        dateOfBirth: emp.dob || null,
        declaredInvestment: emp.declaredInvestment ?? null,
        monthlyBasicSalary: structure?.basic ?? null,
        netWealth: (emp as any).taxNetWealth ?? null,
        motorVehicles: (emp as any).taxMotorVehicles ?? null,
        gender: emp.gender || null,
      },
      annualEstimate,
      tdsWithheldYtd,
      monthsRemainingInFy: monthsRemainingOf(),
    })
    // MON-9 — the AIT output is ingested once (toPaisa); weekly runs prorate
    // it with the same single mulRatio boundary as every other amount
    const aitP = isWeekly
      ? mulRatio(toPaisa(ait.netMonthlyAit), weekWorkingDays, monthWorkingDays)
      : toPaisa(ait.netMonthlyAit)
    const aitAmount = takaOf(aitP)
    // r8 audit — collect AIT calculation log entry for batch insert after loop.
    // R5-008: the old path awaited one INSERT per employee (N+1). We now push
    // to aitLogBatch and createMany once after the loop — best-effort, same as before.
    if (aitConfig) {
      const { configSnapshot } = await import("./ait-engine")
      aitLogBatch.push({
        vendorId: ctx.vendorId,
        fiscalYearId: aitConfig.fiscalYearId,
        employeeId: emp.id,
        employeeCode: emp.code,
        employeeName: emp.fullName,
        kind: "PAYROLL",
        inputsJson: JSON.stringify({
          monthlyGrossSalary: monthlyEquivalent, annualEstimate, tdsWithheldYtd,
          monthsRemainingInFy: monthsRemainingOf(),
          taxpayerCategory: emp.taxCategory || null, gender: emp.gender || null,
          dateOfBirth: emp.dob || null,
          declaredInvestment: emp.declaredInvestment ?? null,
          ytdEarnings: ytdEarn, currentPeriodPayment: weeklyTaxable,
          monthsProjectedAfterThis: monthsAfterThis, regularMonthlyGross: regularGross,
          remainingBonusProjection, previousEmployerIncome: Math.max(0, emp.previousEmployerIncome || 0),
        }),
        configJson: JSON.stringify(configSnapshot(aitConfig)),
        outputJson: JSON.stringify({ annualIncome: ait.annualIncome, taxableIncome: ait.taxableIncome, annualTax: ait.annualTax, netMonthlyAit: ait.netMonthlyAit, averageRatePercent: ait.averageRatePercent, tdsCatchUp: ait.tdsCatchUp, minimumTaxWarning: ait.minimumTaxWarning, surchargeAmount: ait.surchargeAmount, warnings: ait.warnings }),
        warningsJson: JSON.stringify(ait.warnings),
        runId,
        operatorId: ctx.userId,
        operatorName: ctx.userName,
      })
    }

    // ADV-001/PAY-009 (R3-4) — minimum take-home floor: the borrower's OWN
    // loan + advance recovery can never exceed recoveryMaxPctOfNet% of the
    // pre-recovery net for the period (0 = disabled — the historical
    // clamp-to-zero behaviour, NOT recommended). The deferred portion is
    // picked up automatically: loan arrears budgeting (LOA-001) re-budgets
    // it next run; an advance simply runs longer. Guarantor-side recovery
    // keeps its own cap (loanGuarantorMaxPct of the guarantor's net).
    const warnings: string[] = []
    let recoveryDeferredP = 0n
    {
      const floorPct = Math.min(100, Math.max(0, Number((settings.payroll as any).recoveryMaxPctOfNet) || 0))
      if (floorPct > 0 && (loanDeductionP > 0n || advanceDeductionP > 0n)) {
        const preRecoveryNetP = weeklyTaxableP
          - absenceDeductionP - lateDeductionP - repeatOffenderPenaltyP - earlyLeaveDeductionP
          - otherDeductionP - pfEmployeeP - aitP
        const floored = applyRecoveryFloorPaisa(loanDeductionP, advanceDeductionP, preRecoveryNetP, floorPct)
        loanDeductionP = floored.loanDeductionP
        advanceDeductionP = floored.advanceDeductionP
        recoveryDeferredP = floored.deferredP
        if (floored.capped) {
          warnings.push(`Loan/advance recovery capped at ${floorPct}% of net (minimum take-home floor) — ৳${Math.round(takaOf(floored.deferredP))} deferred to later periods.`)
        }
      }
    }

    // ---- THE PAYSLIP IDENTITY (MON-9): netPaisa is the exact integer
    // sum/difference of the component paisa values — line-sum parity to the
    // paisa is guaranteed by construction, not tested for afterwards.
    const rawNetP =
      weeklyTaxableP
      - absenceDeductionP - lateDeductionP - repeatOffenderPenaltyP - earlyLeaveDeductionP
      - attendanceBonusForfeitP
      - loanDeductionP - advanceDeductionP - otherDeductionP - pfEmployeeP
      - aitP
    // M-5 — net pay can never be negative; the clamp is surfaced, never silent
    let netP = rawNetP
    if (netP < 0n) {
      warnings.push(`Computed net was ৳${Math.round(takaOf(rawNetP))} (deductions exceeded earnings) and was clamped to ৳0 — review this employee's deductions before approval.`)
      netP = 0n
    }
    const net = takaOf(netP)

    if (lateLeaveAdjustment && lateLeaveAdjustment.adjustedDays > 0) {
      warnings.push(`Late policy: ${lateLeaveAdjustment.adjustedDays} day(s) adjusted against ${lateLeaveAdjustment.leaveTypeName} balance for ${lateDays.length} late day(s)${lateLeaveAdjustment.unadjustedDays > 0 ? ` (${lateLeaveAdjustment.unadjustedDays} unadjusted day(s) deducted from salary)` : ""}.`)
    }

    // MON-9 — breakdown display lines are DERIVED from the paisa amounts
    // (each line shows the exact paisa value it contributes to the identity)
    const pr = (label: string, amountP: bigint) => ({
      label: isWeekly ? `${label} (prorated)` : label,
      amount: takaOf(isWeekly ? mulRatio(amountP, weekWorkingDays, monthWorkingDays) : amountP),
    })
    const absenceDeduction = takaOf(absenceDeductionP)
    const lateDeduction = takaOf(lateDeductionP)
    const repeatOffenderPenalty = takaOf(repeatOffenderPenaltyP)
    const earlyLeaveDeduction = takaOf(earlyLeaveDeductionP)
    const loanDeduction = takaOf(loanDeductionP)
    const advanceDeduction = takaOf(advanceDeductionP)
    const otherDeduction = takaOf(otherDeductionP)
    const pfEmployee = takaOf(pfEmployeeP)
    const gross = takaOf(grossP)
    const otAmount = takaOf(otAmountP)
    const bonusAmt = takaOf(bonusAmtP)
    const commissionAmt = takaOf(commissionAmtP)
    const recoveryDeferred = recoveryDeferredP > 0n ? takaOf(recoveryDeferredP) : 0
    const breakdown: CalcBreakdown = {
      earnings: [
        pr("Basic", toPaisa(structure.basic)),
        pr("House Rent", toPaisa(structure.houseRent)),
        pr("Medical", toPaisa(structure.medical)),
        pr("Conveyance", toPaisa(structure.conveyance)),
        pr("Food", toPaisa(structure.food)),
        pr("Mobile", toPaisa(structure.mobileAllow)),
        pr("Internet", toPaisa(structure.internetAllow)),
        pr("Attendance Allowance", toPaisa(structure.attendanceAllow)),
        pr("Other Allowance", toPaisa(structure.otherAllowance)),
        ...j(structure.componentsJson, [] as { label: string; amount: number }[])
          .map((c) => pr(c.label, toPaisa(c.amount))),
      ].filter((e) => e.amount > 0),
      deductions: [
        { label: `Absence (${absentDays}d${unpaidLeaveDays > 0 ? `, incl. ${unpaidLeaveDays}d unpaid leave` : ""})`, amount: absenceDeduction },
        ...(lateDeductionP > 0n ? [{
          label: lateLeaveAdjustment && lateLeaveAdjustment.adjustedDays > 0
            ? `Late (${lateDays.length}d late: ${lateLeaveAdjustment.adjustedDays}d adjusted from ${lateLeaveAdjustment.leaveTypeName}, ${lateLeaveAdjustment.unadjustedDays}d salary deducted)`
            : lateMode === "DAY_SALARY"
            ? `Late (${lateDays.length}d late: ${Math.floor(lateDays.length / Math.max(1, Number(latePolicy.lateDaysThreshold) || 3)) * Math.max(0.5, Number(latePolicy.deductDays) || 1)}d ${latePolicy.salaryBasis === "GROSS" ? "gross" : "basic"} salary deducted)`
            : `Late (${lateDays.length}d, ${lateMinutes}m)`,
          amount: lateDeduction,
        }] : []),
        ...(repeatOffenderPenaltyP > 0n ? [{ label: `Late escalation (${lateDays.length} late days ≥ policy threshold)`, amount: repeatOffenderPenalty }] : []),
        ...(earlyLeaveDeductionP > 0n ? [{ label: `Early leave (${earlyLeaveCount}×)`, amount: earlyLeaveDeduction }] : []),
        ...(attendanceBonusForfeitP > 0n ? [{ label: `Attendance bonus forfeited (${absentDays}d absent — full-month policy)`, amount: takaOf(attendanceBonusForfeitP) }] : []),
        { label: "Loan Installment", amount: loanDeduction },
        { label: "Advance Recovery", amount: advanceDeduction },
        ...others.map((d) => ({ label: d.label, amount: takaOf(isWeekly ? mulRatio(toPaisa(d.amount), weekWorkingDays, monthWorkingDays) : toPaisa(d.amount)) })),
        ...(pfEmployeeP > 0n ? [{ label: `Provident Fund — Employee (${pfMeta?.employeePct}% of ${pfMeta?.basis === "GROSS" ? "gross" : "basic"})`, amount: pfEmployee }] : []),
        { label: `AIT (${ait.ruleSetName})`, amount: aitAmount },
      ].filter((d) => d.amount > 0),
      attendance: {
        presentDays,
        absentDays,
        leaveDays,
        ...(unpaidLeaveDays ? { unpaidLeaveDays } : {}),
        lateMinutes,
        lateDays: lateDays.length,
        ...(lateLeaveAdjustment ? { lateLeaveAdjustedDays: lateLeaveAdjustment.adjustedDays } : {}),
        otMinutes,
        workingDays: isWeekly ? weekWorkingDays : monthWorkingDays,
      },
      gross, otAmount, bonus: bonusAmt, commission: commissionAmt,
      ...(bonusLines.length ? { bonusLines } : {}), // PAY-003 — precise PAID marking at pay time
      // MON-2 (Phase 1) — the ids of the deduction rows snapshotted into THIS
      // entry (the bonusLines pattern). At pay time ONLY these ids are marked
      // PAID; a deduction created or edited after this calculation is not in
      // the set, is never blanket-marked, and is surfaced in the pay report.
      ...(others.length ? { deductionLines: others.map((d) => ({ id: d.id, amount: takaOf(isWeekly ? mulRatio(toPaisa(d.amount), weekWorkingDays, monthWorkingDays) : toPaisa(d.amount)) })) } : {}),
      absenceDeduction, lateDeduction, earlyLeaveDeduction, repeatOffenderPenalty, loanDeduction, advanceDeduction, otherDeduction,
      ...(attendanceBonusForfeitP > 0n ? { attendanceBonusForfeit: takaOf(attendanceBonusForfeitP) } : {}), // PAY-04
      ...(lateLeaveAdjustment ? { lateLeaveAdjustment } : {}),
      ...(pfMeta ? { pf: pfMeta } : {}),
      otTiers: otTierTotals,
      ait: { netMonthlyAit: aitAmount, ruleSetName: ait.ruleSetName, mode: ait.mode },
      net,
      ...(isWeekly ? { proration: { frequency: "WEEKLY", fraction: Math.round(fraction * 10000) / 10000, weekWorkingDays, monthWorkingDays } } : {}),
      ...(recoveryDeferredP > 0n ? { recoveryDeferred } : {}), // ADV-001 — the deferral is visible on the payslip JSON
      ...(warnings.length ? { warnings } : {}),
    }

    newEntries.push({
      vendorId: ctx.vendorId, runId, employeeId: emp.id, structureId: structure.id,
      presentDays, absentDays, leaveDays, lateMinutes, otMinutes,
      gross, otAmount, bonus: bonusAmt, commission: commissionAmt,
      absenceDeduction, lateDeduction, loanDeduction, advanceDeduction, otherDeduction,
      guarantorDeduction: 0,
      ait: aitAmount, net,
      // MON-9 — the paisa columns ARE the computation; the Float columns above
      // are derived (takaOf). The H-09 dual-write invariant holds by
      // construction: toPaisa(takaOf(p)) === p.
      grossPaisa: grossP, otAmountPaisa: otAmountP, bonusPaisa: bonusAmtP,
      commissionPaisa: commissionAmtP, absenceDeductionPaisa: absenceDeductionP,
      lateDeductionPaisa: lateDeductionP, loanDeductionPaisa: loanDeductionP,
      advanceDeductionPaisa: advanceDeductionP, otherDeductionPaisa: otherDeductionP,
      guarantorDeductionPaisa: 0n,
      aitPaisa: aitP, netPaisa: netP,
      breakdownJson: JSON.stringify(breakdown),
      taxRuleSetId: ait.ruleSetId,
    })
    totalGrossP += grossP; totalOtP += otAmountP; totalBonusP += bonusAmtP + commissionAmtP
    totalDeductionP += absenceDeductionP + lateDeductionP + repeatOffenderPenaltyP + earlyLeaveDeductionP + attendanceBonusForfeitP + loanDeductionP + advanceDeductionP + otherDeductionP + pfEmployeeP
    totalAitP += aitP
    totalNetP += netP
    count++
    await reportProgress()
  }

  // R5-008 — batch-insert all AIT calculation log rows in one createMany call
  // instead of N individual awaited INSERTs. Best-effort: never blocks the run.
  if (aitLogBatch.length > 0) {
    db.aitCalculationLog.createMany({ data: aitLogBatch }).catch(() => {})
  }

  // ---- 2026-10-14 — guarantor fallback post-pass (Loan & Advance Control) ----
  // Business rule: the monthly repayment deducts from the borrower's salary;
  // when the borrower has NO payable salary this period (no payroll entry at
  // all — off the payroll / no structure — or zero present+leave days with
  // absence proration wiping their pay), the due installment moves to the
  // AGREEED guarantor's salary, capped at settings.payroll.loanGuarantorMaxPct%
  // of the guarantor's net pay (cumulative across everything they guarantee).
  // Borrowers without an agreed guarantor keep the historical behavior
  // (deduction recorded on their own entry; ledger applies at final approval).
  const guarantorMovedTotal = { loan: 0, advance: 0 }
  if (settings.payroll.loanGuarantorFallback && (settings.payroll.loanDeductionEnabled || settings.payroll.advanceDeductionEnabled)) {
    const entryByEmp = new Map(newEntries.map((e) => [e.employeeId, e]))
    const empById = new Map(employees.map((e) => [e.id, e]))
    const capPct = Math.min(100, Math.max(1, Number(settings.payroll.loanGuarantorMaxPct) || 25))
    const capPctBig = BigInt(capPct)
    // guarantorId -> net-pay budget already committed this run (paisa)
    const capUsedP = new Map<string, bigint>()
    const guarantorCapP = (guarantorId: string, entry: any): bigint => {
      const netP: bigint = entry.netPaisa > 0n ? entry.netPaisa : 0n
      // MON-9 — divFloor: the cap never rounds a recovery budget UP
      const capTotalP = divFloor(netP * capPctBig, 100n)
      const used = capUsedP.get(guarantorId) || 0n
      return capTotalP > used ? capTotalP - used : 0n
    }
    // can the borrower's own salary carry the deduction this period?
    const borrowerCannotPay = (entry: any | undefined): boolean =>
      !entry || (settings.payroll.absenceProration && ((entry.presentDays || 0) + (entry.leaveDays || 0)) <= 0)

    const moved = { loan: 0n, advance: 0n }
    // PAY-01 — symmetric net adjustment. Moving a recovery off the borrower's
    // deduction line must give back what that line actually took out of their
    // take-home. The borrower's unclamped net is reconstructed EXACTLY from
    // the entry's paisa columns (earnings) minus the breakdown's full
    // deduction line list (the repeat-offender / early-leave / PF lines live
    // only in the breakdown). newNet = max(0, rawNet + moved): a borrower the
    // M-5 clamp held at ৳0 (deductions already exceeded earnings) gets at
    // most the phantom part back — never a payout on zero earnings — while a
    // borrower with positive net gets the full moved amount restored.
    const restoreBorrowerNet = (entry: any, moveP: bigint): bigint => {
      if (!entry) return 0n
      let allDedP = 0n
      try {
        const bd = JSON.parse(entry.breakdownJson || "{}")
        for (const l of bd.deductions || []) allDedP += toPaisa(Number(l.amount) || 0)
      } catch { /* malformed snapshot — fall back to the column sums below */ }
      if (allDedP === 0n) {
        allDedP = (entry.absenceDeductionPaisa || 0n) + (entry.lateDeductionPaisa || 0n)
          + (entry.loanDeductionPaisa || 0n) + (entry.advanceDeductionPaisa || 0n)
          + (entry.otherDeductionPaisa || 0n) + (entry.aitPaisa || 0n)
      }
      const earnP = (entry.grossPaisa || 0n) + (entry.otAmountPaisa || 0n)
        + (entry.bonusPaisa || 0n) + (entry.commissionPaisa || 0n)
      const rawNetP = earnP - allDedP
      const newNetP = rawNetP + moveP > 0n ? rawNetP + moveP : 0n
      const restoreP = newNetP - (entry.netPaisa || 0n)
      if (restoreP > 0n) {
        entry.netPaisa = newNetP
        entry.net = takaOf(newNetP)
      }
      return restoreP > 0n ? restoreP : 0n
    }
    // ---- loans ----
    if (settings.payroll.loanDeductionEnabled) {
      const arrearsMax = Math.max(0, Number((settings.payroll as any).loanArrearsMax) || 0)
      for (const loan of allLoans) {
        // LOA-001 — the guarantor fallback moves the SAME arrears-aware due
        // the borrower's own deduction budgeted (current + missed EMIs)
        const dueInst = dueInstallmentsFor(installmentsOf(loan.id), monthPrefix, arrearsMax)
        if (!dueInst.length) continue
        const dueInstP = dueInst.reduce((s, i) => s + toPaisa(i.amount) - toPaisa(i.paidAmount), 0n)
        const dueP = isWeekly ? mulRatio(dueInstP, runWeekWorkingDays, runMonthWorkingDays) : dueInstP
        const cappedDueP = loan.outstanding > 0 ? dueP : 0n
        if (!(cappedDueP > 0n)) continue
        const inst = dueInst[0]
        const borrowerEntry = entryByEmp.get(loan.employeeId)
        if (!borrowerCannotPay(borrowerEntry)) continue
        if (!loan.guarantorId || loan.guarantorStatus !== "AGREED") continue
        if (loan.guarantorId === loan.employeeId) continue
        const gEntry = entryByEmp.get(loan.guarantorId)
        if (!gEntry || borrowerCannotPay(gEntry)) continue // guarantor must have salary this period
        const capP = guarantorCapP(loan.guarantorId, gEntry)
        const moveP = cappedDueP < capP ? cappedDueP : capP
        if (!(moveP > 0n)) continue
        const move = takaOf(moveP)
        const borrower = empById.get(loan.employeeId)
        // 1) remove the recovery from the borrower's own entry and give back
        //    what that line actually took out of their take-home (PAY-01 —
        //    the old code reduced the line but never restored netPaisa, so a
        //    borrower with positive net was underpaid by exactly the moved
        //    amount and the payslip lines stopped summing). NOTE: the line
        //    reduction is min(line, move) — the recovery floor may have
        //    capped the borrower's line BELOW the moved amount.
        if (borrowerEntry) {
          const cur: bigint = borrowerEntry.loanDeductionPaisa || 0n
          const lineCutP = cur > moveP ? moveP : cur
          borrowerEntry.loanDeductionPaisa = cur > moveP ? cur - moveP : 0n
          borrowerEntry.loanDeduction = takaOf(borrowerEntry.loanDeductionPaisa)
          const restoredP = restoreBorrowerNet(borrowerEntry, lineCutP)
          // the transfer nets out only when the borrower was unclamped;
          // a clamped borrower's restore is smaller than the guarantor's
          // move — the run total must shed the difference
          totalNetP = totalNetP + restoredP > moveP ? totalNetP + restoredP - moveP : 0n
          // PAY-06 — the guarantor's withholding is a real deduction: the run
          // total must grow by whatever the move exceeded the (possibly
          // floor-capped) borrower line it replaced
          totalDeductionP += moveP - lineCutP
        }
        // 2) add it to the guarantor's entry
        gEntry.guarantorDeductionPaisa = (gEntry.guarantorDeductionPaisa || 0n) + moveP
        gEntry.netPaisa = gEntry.netPaisa > moveP ? gEntry.netPaisa - moveP : 0n
        gEntry.guarantorDeduction = takaOf(gEntry.guarantorDeductionPaisa)
        gEntry.net = takaOf(gEntry.netPaisa)
        capUsedP.set(loan.guarantorId, (capUsedP.get(loan.guarantorId) || 0n) + moveP)
        // 3) breakdowns — the guarantor's payslip shows an itemised line, the
        //    plan record drives payRun's ledger recovery for THIS loan
        try {
          const gBd = JSON.parse(gEntry.breakdownJson || "{}")
          gBd.deductions = [...(gBd.deductions || []), { label: `Guarantor recovery — ${borrower?.fullName || "borrower"} (loan)`, amount: move }]
          gBd.guarantorRecoveries = [...(gBd.guarantorRecoveries || []), { kind: "LOAN", loanId: loan.id, installmentId: inst.id, borrowerId: loan.employeeId, borrowerName: borrower?.fullName, borrowerCode: borrower?.code, amount: move }]
          if (moveP < cappedDueP) {
            gBd.warnings = [...(gBd.warnings || []), `Guarantor recovery capped at ৳${move.toLocaleString("en-IN")} (${capPct}% of net) — ৳${takaOf(cappedDueP - moveP).toLocaleString("en-IN")} of ${borrower?.fullName || "the borrower"}'s installment is deferred.`]
          }
          gBd.net = gEntry.net
          gEntry.breakdownJson = JSON.stringify(gBd)
        } catch { /* malformed snapshot — deduction still applies via columns */ }
        if (borrowerEntry) {
          try {
            const bBd = JSON.parse(borrowerEntry.breakdownJson || "{}")
            const line = (bBd.deductions || []).find((d: any) => d.label === "Loan Installment")
            if (line) line.amount = borrowerEntry.loanDeduction
            bBd.net = borrowerEntry.net
            borrowerEntry.breakdownJson = JSON.stringify(bBd)
          } catch { /* same fallback */ }
        }
        moved.loan += moveP
        // 4) run totals — a transfer between two IN-RUN entries nets out; a
        //    borrower with NO entry adds a brand-new deduction to the run
        if (!borrowerEntry) { totalDeductionP += moveP; totalNetP = totalNetP > moveP ? totalNetP - moveP : 0n }
      }
    }
    // ---- advances ----
    if (settings.payroll.advanceDeductionEnabled) {
      for (const adv of allAdvances) {
        const recoveryMonth = (adv.recoveryDate || adv.requestDate).slice(0, 7)
        if (recoveryMonth > monthPrefix) continue
        // MON-9 — the same rational split as the borrower-side budget: a
        // single divHalfUp of amount/outstanding-capped numerator over the
        // installment count, prorated for weekly runs
        const amountP = toPaisa(adv.amount)
        const outstandingP = toPaisa(adv.outstanding)
        const inst = Math.max(1, Math.floor(Number(adv.installments) || 0)) || 1
        const instBig = BigInt(inst)
        const perRawP = amountP <= outstandingP * instBig ? amountP : outstandingP * instBig
        const dueP = isWeekly ? mulRatio(divHalfUp(perRawP, instBig), runWeekWorkingDays, runMonthWorkingDays) : divHalfUp(perRawP, instBig)
        if (!(dueP > 0n)) continue
        const borrowerEntry = entryByEmp.get(adv.employeeId)
        if (!borrowerCannotPay(borrowerEntry)) continue
        if (!adv.guarantorId || adv.guarantorStatus !== "AGREED") continue
        if (adv.guarantorId === adv.employeeId) continue
        const gEntry = entryByEmp.get(adv.guarantorId)
        if (!gEntry || borrowerCannotPay(gEntry)) continue
        const capP = guarantorCapP(adv.guarantorId, gEntry)
        const moveP = dueP < capP ? dueP : capP
        if (!(moveP > 0n)) continue
        const move = takaOf(moveP)
        const borrower = empById.get(adv.employeeId)
        // PAY-01 — same symmetric net adjustment as the loan loop (see the
        // restoreBorrowerNet block): the line reduction must give the
        // borrower back what the advance line actually took from take-home.
        if (borrowerEntry) {
          const cur: bigint = borrowerEntry.advanceDeductionPaisa || 0n
          const lineCutP = cur > moveP ? moveP : cur
          borrowerEntry.advanceDeductionPaisa = cur > moveP ? cur - moveP : 0n
          borrowerEntry.advanceDeduction = takaOf(borrowerEntry.advanceDeductionPaisa)
          const restoredP = restoreBorrowerNet(borrowerEntry, lineCutP)
          totalNetP = totalNetP + restoredP > moveP ? totalNetP + restoredP - moveP : 0n
          // PAY-06 — same run-total growth as the loan loop
          totalDeductionP += moveP - lineCutP
        }
        gEntry.guarantorDeductionPaisa = (gEntry.guarantorDeductionPaisa || 0n) + moveP
        gEntry.netPaisa = gEntry.netPaisa > moveP ? gEntry.netPaisa - moveP : 0n
        gEntry.guarantorDeduction = takaOf(gEntry.guarantorDeductionPaisa)
        gEntry.net = takaOf(gEntry.netPaisa)
        capUsedP.set(adv.guarantorId, (capUsedP.get(adv.guarantorId) || 0n) + moveP)
        try {
          const gBd = JSON.parse(gEntry.breakdownJson || "{}")
          gBd.deductions = [...(gBd.deductions || []), { label: `Guarantor recovery — ${borrower?.fullName || "borrower"} (advance)`, amount: move }]
          gBd.guarantorRecoveries = [...(gBd.guarantorRecoveries || []), { kind: "ADVANCE", advanceId: adv.id, borrowerId: adv.employeeId, borrowerName: borrower?.fullName, borrowerCode: borrower?.code, amount: move }]
          if (moveP < dueP) {
            gBd.warnings = [...(gBd.warnings || []), `Guarantor recovery capped at ৳${move.toLocaleString("en-IN")} (${capPct}% of net) — ৳${takaOf(dueP - moveP).toLocaleString("en-IN")} of ${borrower?.fullName || "the borrower"}'s advance recovery is deferred.`]
          }
          gBd.net = gEntry.net
          gEntry.breakdownJson = JSON.stringify(gBd)
        } catch { /* deduction still applies via columns */ }
        if (borrowerEntry) {
          try {
            const bBd = JSON.parse(borrowerEntry.breakdownJson || "{}")
            const line = (bBd.deductions || []).find((d: any) => d.label === "Advance Recovery")
            if (line) line.amount = borrowerEntry.advanceDeduction
            bBd.net = borrowerEntry.net
            borrowerEntry.breakdownJson = JSON.stringify(bBd)
          } catch { /* same fallback */ }
        }
        moved.advance += moveP
        if (!borrowerEntry) { totalDeductionP += moveP; totalNetP = totalNetP > moveP ? totalNetP - moveP : 0n }
      }
    }
    guarantorMovedTotal.loan = takaOf(moved.loan)
    guarantorMovedTotal.advance = takaOf(moved.advance)
  }

  // ---- PAY-001 (R3-1): adjustment runs store DELTAS, never a second month ----
  // The ordinary recompute above produced each employee's CORRECTED values
  // for the period; for an ADJUSTMENT run every entry is now transformed
  // into the correction against the PAID source run (run.adjustRunId), so
  // the run totals, the approval amount, the payslips, the journal and the
  // bank advice carry ONLY the difference. Regression-tested: an
  // adjustment's totalNet equals the correction, not the month.
  if (run.runType === "ADJUSTMENT") {
    if (!run.adjustRunId) throw new Deny("Adjustment run has no source run — create adjustments via 'Create Adjustment Run' on a paid run")
    const srcRun = await db.payrollRun.findFirst({ where: { id: run.adjustRunId, vendorId: ctx.vendorId } })
    if (!srcRun) throw new Deny("Source run not found", 404)
    if (srcRun.status !== "PAID") throw new Deny(`Adjustments apply to PAID runs only — the source run is ${srcRun.status}`)
    const srcEntries = await db.payrollEntry.findMany({ where: { runId: srcRun.id } })
    applyAdjustmentDeltas(newEntries, srcEntries)
    // totals are now the DELTAS (negative net = recovery), in paisa
    totalGrossP = newEntries.reduce((s: bigint, e: any) => s + (e.grossPaisa || 0n), 0n)
    totalOtP = newEntries.reduce((s: bigint, e: any) => s + (e.otAmountPaisa || 0n), 0n)
    totalBonusP = newEntries.reduce((s: bigint, e: any) => s + (e.bonusPaisa || 0n) + (e.commissionPaisa || 0n), 0n)
    // PAY-06 — the repeat-offender / early-leave / PF deltas live only in the
    // correction breakdown (no paisa columns exist for them), so the column
    // sum alone understated totalDeduction while totalNet carried them —
    // the run card's totals now sum every deduction line of the correction.
    totalDeductionP = newEntries.reduce((s: bigint, e: any) => {
      let dedP = (e.absenceDeductionPaisa || 0n) + (e.lateDeductionPaisa || 0n) + (e.loanDeductionPaisa || 0n) + (e.advanceDeductionPaisa || 0n) + (e.otherDeductionPaisa || 0n)
      try {
        const bd = JSON.parse(e.breakdownJson || "{}")
        for (const l of bd.deductions || []) {
          if (l.label === "Late escalation correction" || l.label === "Early-leave correction" || l.label === "Provident Fund correction" || l.label === "Attendance bonus correction") {
            dedP += toPaisa(Number(l.amount) || 0)
          }
        }
      } catch { /* column sum only */ }
      return s + dedP
    }, 0n)
    totalAitP = newEntries.reduce((s: bigint, e: any) => s + (e.aitPaisa || 0n), 0n)
    totalNetP = newEntries.reduce((s: bigint, e: any) => s + (e.netPaisa || 0n), 0n)
  }

  // ---- recalculation is atomic AND conditional (MON-7): wipe + rewrite +
  // status-flip in one transaction, and the flip only lands when THIS
  // computation still owns the run (epoch unchanged, status still claimable).
  // A racing submit-for-approval (or another recalc) makes the update a
  // no-op → the whole transaction aborts with NOTHING written.
  const totalGross = takaOf(totalGrossP), totalOt = takaOf(totalOtP), totalBonus = takaOf(totalBonusP)
  const totalDeduction = takaOf(totalDeductionP), totalAit = takaOf(totalAitP), totalNet = takaOf(totalNetP)
  await db.$transaction(async (tx) => {
    await tx.payrollEntry.deleteMany({ where: { runId } })
    if (newEntries.length) await tx.payrollEntry.createMany({ data: newEntries })
    const fin = await tx.payrollRun.updateMany({
      where: { id: runId, calcEpoch, status: { in: ["DRAFT", "CALCULATED"] } },
      data: {
        status: "CALCULATED", employeeCount: count, totalGross, totalOt, totalBonus,
        totalDeduction, totalAit, totalNet, processedDate: new Date().toISOString(),
        // MON-9 — paisa totals are the computation; Float totals derived above
        totalGrossPaisa: totalGrossP, totalOtPaisa: totalOtP, totalBonusPaisa: totalBonusP,
        totalDeductionPaisa: totalDeductionP, totalAitPaisa: totalAitP, totalNetPaisa: totalNetP,
      },
    })
    if (fin.count === 0) {
      throw new Deny("The run moved while it was being calculated (submitted or recalculated elsewhere) — nothing was written. Refresh and retry.", 409)
    }
  }, { timeout: 60_000, maxWait: 10_000 })
  await audit(ctx, "payroll.calculate", "PayrollRun", runId,
    `Calculated ${isWeekly ? `week ${run.periodWeek} of ` : ""}${monthName(run.periodMonth)} ${run.periodYear}: ${count} employees, net ${totalNet.toFixed(0)}${excluded.length ? `, ${excluded.length} excluded by preflight` : ""}${guarantorMovedTotal.loan + guarantorMovedTotal.advance > 0 ? `, ৳${(guarantorMovedTotal.loan + guarantorMovedTotal.advance).toLocaleString("en-IN")} guarantor recovery` : ""}`)
  return { runId, count, totalGross, totalNet, excluded: excluded.length, guarantorRecovery: guarantorMovedTotal }
}

/** Submit a calculated run into the approval workflow (HR → Manager → Finance). */
export async function submitRunForApproval(ctx: Ctx, runId: string) {
  const run = await db.payrollRun.findFirst({ where: { id: runId, vendorId: ctx.vendorId } })
  if (!run) throw new Deny("Run not found", 404)
  if (run.status !== "CALCULATED") throw new Deny("Run must be CALCULATED before submitting")
  // PAY-001 — approvers see that this is a DELTA correction and its amount
  const adj = run.runType === "ADJUSTMENT"
  // PAY-005 (R3-2) — the approval request carries the bonus/commission
  // composition riding the run, so the approving manager sees the exposure at
  // the second gate too, not only in preflight.
  const runEntries = await db.payrollEntry.findMany({ where: { runId }, select: { bonus: true, commission: true } })
  const bonusTotal = Math.round(runEntries.reduce((s, e) => s + (e.bonus || 0) + (e.commission || 0), 0))
  const commissionTotal = Math.round(runEntries.reduce((s, e) => s + (e.commission || 0), 0))
  const employeesWithBonus = runEntries.filter((e) => (e.bonus || 0) + (e.commission || 0) > 0).length
  const reqId = await submitForApproval(ctx, "PAYROLL", "PayrollRun", runId,
    `Payroll ${monthName(run.periodMonth)} ${run.periodYear}` +
    (adj ? ` — Adjustment #${run.adjustSeq ?? 1} (delta ৳${Math.round(run.totalNet).toLocaleString("en-IN")})` : "") +
    (bonusTotal > 0 ? ` (incl. bonuses/commissions ৳${bonusTotal.toLocaleString("en-IN")})` : ""),
    {
      amount: run.totalNet, runId, month: run.periodMonth, year: run.periodYear,
      ...(adj ? { adjustment: true, deltaNet: run.totalNet } : {}),
      ...(bonusTotal > 0 ? { bonusTotal, commissionTotal, employeesWithBonus } : {}),
    })
  await db.payrollRun.update({ where: { id: runId }, data: { status: "HR_REVIEW", approvalRequestId: reqId } })
  return { requestId: reqId }
}

/** Mark a fully-approved run as PROCESSING → PAID: posts accounting journal,
 *  generates payslips, recovers loans/advances, notifies employees.
 *
 *  H-3: the whole money path is one transaction. The first statement claims the
 *  run with a conditional update (APPROVED → PROCESSING); a concurrent caller
 *  finds zero rows and aborts. The journal idempotency key makes a double post
 *  impossible even under direct DB replay. Notifications and payslip emails run
 *  AFTER the commit so a delivery failure can never roll back money movement. */
export async function payRun(ctx: Ctx, runId: string, onProgress?: (done: number, total: number) => Promise<void>) {
  const run = await db.payrollRun.findFirst({ where: { id: runId, vendorId: ctx.vendorId } })
  if (!run) throw new Deny("Payroll run not found", 404)
  if (run.status !== "APPROVED") throw new Deny("Run must be APPROVED before payment")

  // 2026-10 round §78 — payout-compliance pre-flight: every INCLUDED entry's
  // payout method must satisfy the payout settings (threshold + account
  // details + enabled methods) BEFORE any money moves. The first violation
  // blocks the whole payment with the specific employee + reason (the admin
  // corrects the payout configuration and retries).
  //
  // MON-4 (Phase 1) — the old loop resolved payouts employee-by-employee (2
  // sequential queries each) and silently validated only the FIRST 500
  // entries: beyond #500, an employee with no bank account above the
  // cash-threshold passed completely unvalidated. The preflight now resolves
  // the WHOLE run with 3 queries (entries + employees + bank accounts) and
  // validates every entry — the cap is gone.
  {
    const { payoutSettings, resolveSalaryPayouts, validatePayout } = await import("./payout")
    const pSettings = payoutSettings(await getSettings(ctx.vendorId))
    const included = await db.payrollEntry.findMany({ where: { runId, status: { in: ["INCLUDED", "ADJUSTED"] } }, select: { employeeId: true, gross: true, net: true } })
    if (included.length) {
      const payoutById = await resolveSalaryPayouts(included.map((e) => e.employeeId))
      let vDone = 0
      for (const e of included) { // ALL entries — the 500 cap is gone
        const payout = payoutById.get(e.employeeId) ?? { method: null, account: null, note: "Employee not found" }
        const basis = pSettings.thresholdBasis === "NET" ? e.net : e.gross
        const v = validatePayout(payout, basis, pSettings)
        if (!v.ok) {
          const emp = await db.employee.findUnique({ where: { id: e.employeeId }, select: { code: true, fullName: true } })
          throw new Deny(
            `Payout validation failed for ${emp?.fullName ?? e.employeeId} (${emp?.code ?? "?"}): ${v.reasons.join("; ")}. Payment is blocked until the payout configuration is corrected.`,
            400
          )
        }
        vDone++
        if (onProgress && vDone % 25 === 0) await onProgress(vDone, included.length)
      }
    }
  }

  // C-1 sanity guard: a weekly run may never disburse more than the vendor's
  // monthly payroll baseline (sum of active monthly structures) + 50% headroom.
  const isWeekly = run.frequency === "WEEKLY" || run.periodWeek > 0
  if (isWeekly) {
    const employees = await db.employee.findMany({
      where: { vendorId: ctx.vendorId, status: { in: ["ACTIVE", "PROBATION", "ON_LEAVE", "SUSPENDED"] } },
      select: { id: true },
    })
    const structures = employees.length ? await db.salaryStructure.findMany({
      where: { employeeId: { in: employees.map((e) => e.id) }, status: "ACTIVE" },
      select: { gross: true },
    }) : []
    const monthlyBaseline = structures.reduce((s, x) => s + x.gross, 0)
    if (monthlyBaseline > 0 && run.totalNet > monthlyBaseline * 1.5) {
      throw new Deny(`Safety guard: this weekly run proposes ৳${Math.round(run.totalNet).toLocaleString("en-IN")} against a monthly payroll baseline of ৳${Math.round(monthlyBaseline).toLocaleString("en-IN")}. Recalculate the run (proration) before paying.`)
    }
  }

  const entries = await db.payrollEntry.findMany({ where: { runId, status: { in: ["INCLUDED", "ADJUSTED"] } } })
  const settings = await getSettings(ctx.vendorId)
  const employees = await db.employee.findMany({ where: { vendorId: ctx.vendorId }, select: { id: true } })
  const empIdSet = new Set(employees.map((e) => e.id))
  // ---- PAY-003/PAY-008 (R3-2) — bonus disbursement ledger for this run ----
  // The exact rows each entry included (breakdownJson.bonusLines, recorded at
  // calculation time) drive the PAID marking; the cumulative amount already
  // disbursed by earlier PAID runs of the period decides PAID vs IN_PAYROLL.
  const inRunBonusIds = new Set<string>()
  const entryBonusLines = new Map<string, { id: string; amount: number }[]>()
  // MON-2 (Phase 1) — the deduction twin of entryBonusLines: the ids each
  // entry snapshotted at calculation time. Pay time marks ONLY these; rows
  // created after the calculation stay ACTIVE and are surfaced below.
  const inRunDeductionIds = new Set<string>()
  const entryDeductionLines = new Map<string, { id: string; amount: number }[]>()
  for (const e of entries) {
    let lines: { id: string; amount: number }[] | null = null
    let dLines: { id: string; amount: number }[] | null = null
    try {
      const bd = JSON.parse(e.breakdownJson || "{}")
      if (Array.isArray(bd.bonusLines)) lines = bd.bonusLines
      if (Array.isArray(bd.deductionLines)) dLines = bd.deductionLines
    } catch { /* legacy snapshot */ }
    if (lines && lines.length) {
      entryBonusLines.set(e.id, lines)
      for (const l of lines) inRunBonusIds.add(String(l.id))
    }
    if (dLines && dLines.length) {
      entryDeductionLines.set(e.id, dLines)
      for (const l of dLines) inRunDeductionIds.add(String(l.id))
    }
  }
  const bonusRows = inRunBonusIds.size
    ? await db.bonus.findMany({ where: { vendorId: ctx.vendorId, id: { in: [...inRunBonusIds] } } })
    : []
  const bonusRowsById = new Map(bonusRows.map((b) => [b.id, b]))
  const bonusPaidMap = await bonusPaidSoFarForPeriod(ctx.vendorId, run.periodMonth, run.periodYear)
  // ---- P1 (re-audit 2026-10-18) — payslip numbers: pool allocation + week tag ----
  // The number now carries the ISO week for weekly runs (-W45) ahead of the
  // adjustment tag, and the 4-digit sequence is a block reserved from the
  // month-scoped SequenceCounter pool — two runs of the same month can never
  // mint the same number again. Monthly REGULAR runs keep the exact legacy
  // format PFX-YYYYMM-0001.
  const weekTag = run.periodWeek > 0 ? `-W${run.periodWeek}` : ""
  const runTag = `${weekTag}${run.runType === "ADJUSTMENT" ? `-A${run.adjustSeq ?? 1}` : ""}`
  const payslipHead = `${settings.payroll.payslipPrefix}-${run.periodYear}${String(run.periodMonth).padStart(2, "0")}${runTag}`
  const stampable = entries.filter((e) => empIdSet.has(e.employeeId)).length
  const psSeqKey = `payslip:${ctx.vendorId}:${run.periodYear}-${String(run.periodMonth).padStart(2, "0")}`
  // Transition seed: payslips already stamped in this vendor-month BEFORE the
  // counter existed are counted once, so the first post-fix payment CONTINUES
  // the sequence instead of re-minting old numbers (pre-fix history minted at
  // most one successfully paid REGULAR run per month, numbered 1..n, so the
  // stamped count IS the high-water mark; payroll.runs.cancel clears numbers
  // and frees the vendor-unique space, so a lower seed is equally safe — and
  // post-fix weekly numbers carry the -W tag, which never collides textually
  // with pre-fix numbers anyway).
  const preStamped = stampable > 0
    ? await db.payrollEntry.count({
        where: {
          vendorId: ctx.vendorId,
          payslipNumber: { not: null },
          run: { periodYear: run.periodYear, periodMonth: run.periodMonth },
        },
      })
    : 0
  let psNext = 1
  const notified: { employeeId: string; psNo: string; net: number }[] = []
  // SCL-5 — PF ledger rows are collected per entry and flushed as ONE
  // deleteMany + ONE createMany after the loop (was: two queries per entry)
  const pfRows: { vendorId: string; employeeId: string; periodYear: number; periodMonth: number; employeeAmount: number; employerAmount: number; source: string; runId: string; note: string; noteHash: string; createdBy: string | null }[] = []
  // PAY-003 — filled inside the payment transaction, surfaced after it
  let excludedApprovedBonusCount = 0
  // MON-2 — ACTIVE deductions of the period left out of every snapshot
  let excludedActiveDeductionCount = 0

  const journalId = await db.$transaction(async (tx) => {
    // ---- H-3: conditional claim — exactly one concurrent payment can proceed ----
    const claimed = await tx.payrollRun.updateMany({
      where: { id: runId, vendorId: ctx.vendorId, status: "APPROVED" },
      data: { status: "PROCESSING" },
    })
    if (claimed.count === 0) {
      throw new Deny("This run is already being paid or was paid — refresh the payroll list.")
    }
    // ---- MON-1 (Phase 1): pay-time re-validation of every bonus line ----
    // The calculate-time remainder guard only sees runs already PAID at
    // calculation; two runs of the same period (a monthly REGULAR plus weekly
    // runs is a SUPPORTED configuration) calculated before either pays each
    // snapshot the SAME bonus at full value, and the pre-transaction read of
    // bonusPaidSoFar cannot observe a concurrent run committing in between.
    // Inside this transaction we now:
    //   1. LOCK every involved Bonus row (SELECT … FOR UPDATE) — a concurrent
    //      payment of another run of the same period blocks here until we
    //      commit, so the checks below are serialized per bonus row;
    //   2. re-read paidSoFar FRESH through the tx client (after the lock — it
    //      observes the concurrent run's committed PAID marking);
    //   3. REJECT the payment when any snapshotted line would over-disburse
    //      its bonus beyond the +৳1 rounding tolerance. The blocked run stays
    //      APPROVED (this whole transaction rolls back with the claim); the
    //      operator cancels/recalculates it, and the recalculation now sees
    //      the concurrent run's PAID state and budgets only the remainder.
    // The PAID/IN_PAYROLL marking inside the entries loop below reads the
    // SAME fresh map, so a partial concurrent disbursement parks the bonus at
    // IN_PAYROLL instead of a stale, over-optimistic PAID.
    let bonusPaidMarking = bonusPaidMap
    if (inRunBonusIds.size) {
      const locked = await tx.$queryRaw<Array<{ id: string; status: string; amount: number }>>(
        Prisma.sql`SELECT id, status, amount FROM "Bonus" WHERE id IN (${Prisma.join([...inRunBonusIds])}) FOR UPDATE`
      ).catch(() => [] as Array<{ id: string; status: string; amount: number }>)
      const lockedById = new Map(locked.map((b) => [String(b.id), b]))
      if (locked.length) {
        const freshPaidMap = await bonusPaidSoFarForPeriod(ctx.vendorId, run.periodMonth, run.periodYear, tx)
        for (const e of entries) {
          const lines = entryBonusLines.get(e.id)
          if (!lines) continue
          for (const bl of lines) {
            const row = lockedById.get(String(bl.id))
            if (!row) continue
            const freshCumulative = (freshPaidMap.get(String(bl.id)) || 0) + (Number(bl.amount) || 0)
            if (freshCumulative > Number(row.amount) + 1) { // the same ৳1 tolerance as the marking
              throw new Deny(
                `Over-disbursement blocked: bonus ${String(bl.id)} (${Math.round(Number(row.amount))}৳) already has ${freshPaidMap.get(String(bl.id)) || 0}৳ disbursed by a concurrent run of ${monthName(run.periodMonth)} ${run.periodYear}, and this run's snapshot would pay it again. Cancel and recalculate this run, then re-approve.`,
                409
              )
            }
          }
        }
        bonusPaidMarking = freshPaidMap
      }
    }
    // ---- SCL-5 (Phase 2 WS3): set-based ledger prefetch ----
    // The per-employee loop used to issue loan.findMany + loanInstallment
    // .findMany + advance.findMany + leaveBalance.findUnique per employee
    // (~12 queries/employee inside this transaction). The READS are now four
    // set queries up front; the WRITES stay per-row (atomic increments and
    // status transitions on money rows — deliberately untouched, per the
    // audit constraint that the claim/idempotency scaffolding stays as-is).
    // Guarantor recovery keeps its per-row findUnique reads: a guarantor's
    // target rows may have been mutated earlier in THIS transaction by the
    // borrower's own recovery, so it must read fresh state.
    const runEmpIds = entries.filter((e) => empIdSet.has(e.employeeId)).map((e) => e.employeeId)
    const [runLoans, runAdvances, runLeaveBalances] = await Promise.all([
      runEmpIds.length
        ? tx.loan.findMany({ where: { vendorId: ctx.vendorId, employeeId: { in: runEmpIds }, status: "ACTIVE" } })
        : Promise.resolve([]),
      runEmpIds.length
        ? tx.advance.findMany({ where: { vendorId: ctx.vendorId, employeeId: { in: runEmpIds }, status: "RECOVERING", outstanding: { gt: 0 } } })
        : Promise.resolve([]),
      // late-leave adjustment balances referenced by any entry snapshot
      runEmpIds.length
        ? tx.leaveBalance.findMany({
            where: { vendorId: ctx.vendorId, id: { in: entries.flatMap((e) => {
              try {
                const adj = JSON.parse(e.breakdownJson || "{}")?.lateLeaveAdjustment
                return adj?.balanceId ? [String(adj.balanceId)] : []
              } catch { return [] }
            }) } },
          })
        : Promise.resolve([]),
    ])
    const runLoanIds = runLoans.map((l) => l.id)
    const runInstallments = runLoanIds.length
      ? await tx.loanInstallment.findMany({ where: { loanId: { in: runLoanIds }, status: { in: ["PENDING", "OVERDUE", "PARTIAL"] } }, orderBy: { no: "asc" } })
      : []
    const runLoansByEmp = new Map<string, NonNullable<typeof runLoans[number]>[]>()
    for (const l of runLoans) {
      const list = runLoansByEmp.get(l.employeeId)
      if (list) list.push(l); else runLoansByEmp.set(l.employeeId, [l])
    }
    const runInstallmentsByLoan = new Map<string, NonNullable<typeof runInstallments[number]>[]>()
    for (const i of runInstallments) {
      const list = runInstallmentsByLoan.get(i.loanId)
      if (list) list.push(i); else runInstallmentsByLoan.set(i.loanId, [i])
    }
    const runAdvancesByEmp = new Map<string, NonNullable<typeof runAdvances[number]>[]>()
    for (const a of runAdvances) {
      const list = runAdvancesByEmp.get(a.employeeId)
      if (list) list.push(a); else runAdvancesByEmp.set(a.employeeId, [a])
    }
    const runLeaveBalanceById = new Map(runLeaveBalances.map((b) => [b.id, b]))
    // ---- P1 — allocate this run's payslip-number block from the shared
    // per-(vendor, month) counter. A single-statement upsert: the update
    // branch increments the block, the create branch seeds at the pre-counter
    // high-water mark + block. Both branches are atomic, so even concurrent
    // FIRST payments of the same vendor-month cannot double-allocate, and the
    // allocation commits/rolls back together with the stamped numbers (a
    // failed payment burns no numbers). The previous update-then-create
    // fallback logged a caught-and-retried P2025 as a scary `prisma:error`
    // on every vendor-month's first-ever payment — the upsert cannot fail
    // that way at all.
    if (stampable > 0) {
      const counter = await tx.sequenceCounter.upsert({
        where: { key: psSeqKey },
        update: { value: { increment: stampable } },
        create: { key: psSeqKey, value: preStamped + stampable },
        select: { value: true },
      })
      psNext = counter.value - stampable + 1
    }
    for (const e of entries) {
      if (!empIdSet.has(e.employeeId)) continue
      // M-13 + P1 (re-audit 2026-10-18) — the number carries the run
      // discriminator (week + adjustment tags) and its sequence comes from
      // the pool block reserved INSIDE this transaction: unique across every
      // coexisting run of the month, and rolled back with the payment if
      // anything fails. The DB enforces (vendorId, payslipNumber) uniqueness
      // (migration 3) as the final backstop.
      const psNo = `${payslipHead}-${String(psNext++).padStart(4, "0")}`

      // R1 (2026-10-12) — exact ledger-recovery record for THIS entry, consumed
      // by payroll.runs.cancel to revert loan/advance recoveries precisely (so
      // a re-created run for the same month cannot double-recover). Legacy rows
      // (paid before this column) fall back to entry-level reversal.
      const recovery: { loan: { installmentId: string; amount: number }[]; advance: { advanceId: string; amount: number }[]; leave: { balanceId: string; days: number; leaveTypeId: string }[] } = { loan: [], advance: [], leave: [] }

      // loan installment recovery (SCL-5 — reads come from the tx-scoped
      // prefetch maps; the writes below are unchanged per-row atomic ops)
      if (e.loanDeduction > 0) {
        const loans = runLoansByEmp.get(e.employeeId) || []
        // H-5 — one deduction budget across ALL of the employee's active loans
        // (the advance loop below always had this pattern). The old per-loan
        // Math.min(installment.remaining, e.loanDeduction) let EVERY loan
        // recover up to the full deduction: 2+ active loans → ledger credits
        // exceeding the payslip deduction (guaranteed on WEEKLY proration),
        // loans closing early and outstanding being understated.
        let remainingLoanDed = e.loanDeduction
        const monthPrefix = `${run.periodYear}-${String(run.periodMonth).padStart(2, "0")}`
        for (const loan of loans) {
          if (remainingLoanDed <= 0) break
          const inst = runInstallmentsByLoan.get(loan.id) || []
          // LOA-001 (R3-4) — arrears-aware recovery: the ledger consumes the
          // SAME due set the calculation budgeted (unpaid installments due on
          // or before the period month, oldest first), so a budgeted arrears
          // EMI is actually recovered instead of silently re-deferring.
          const due = dueInstallmentsFor(inst, monthPrefix, Math.max(0, Number((settings.payroll as any).loanArrearsMax) || 0))
          for (const i of due) {
            if (remainingLoanDed <= 0) break
            // LOA-002 — ATOMIC increments (the old absolute `paidAmount: i.paidAmount + pay`
            // write raced a concurrent manual repayment on the same row and
            // lost an update); the status follows from the RETURNED row, not a
            // stale read.
            const pay = Math.min(i.amount - i.paidAmount, remainingLoanDed)
            remainingLoanDed -= pay
            const upd = await tx.loanInstallment.update({
              where: { id: i.id },
              data: { paidAmount: { increment: pay }, paidAt: new Date(), payrollEntryId: e.id },
            })
            const newPaid = upd.paidAmount
            if (upd.status !== "PAID") {
              await tx.loanInstallment.update({
                where: { id: i.id },
                data: { status: newPaid >= upd.amount ? "PAID" : "PARTIAL" },
              })
            }
            recovery.loan.push({ installmentId: i.id, amount: pay })
            const loanUpd = await tx.loan.update({
              where: { id: loan.id },
              data: { paidAmount: { increment: pay }, outstanding: { decrement: Math.min(pay, loan.outstanding) } },
            })
            if (loanUpd.status === "ACTIVE" && loanUpd.outstanding <= 0) {
              await tx.loan.update({ where: { id: loan.id }, data: { status: "CLOSED" } })
              await tx.employeeHistory.create({
                data: { vendorId: ctx.vendorId, employeeId: e.employeeId, eventType: "LOAN_CLOSED",
                  title: `Loan fully recovered`, description: `Loan of ৳${loan.principal} closed via payroll deductions`, dataJson: JSON.stringify({ loanId: loan.id }) },
              })
            }
          }
        }
      }
      // advance recovery (SCL-5 — prefetched map)
      if (e.advanceDeduction > 0) {
        const advances = runAdvancesByEmp.get(e.employeeId) || []
        let remainingDed = e.advanceDeduction
        for (const adv of advances) {
          if (remainingDed <= 0) break
          const pay = Math.min(adv.outstanding, remainingDed)
          remainingDed -= pay
          recovery.advance.push({ advanceId: adv.id, amount: pay })
          const newOut = adv.outstanding - pay
          await tx.advance.update({
            where: { id: adv.id },
            data: { deducted: adv.deducted + pay, outstanding: newOut, status: newOut <= 0 ? "RECOVERED" : "RECOVERING" },
          })
        }
      }
      // ---- 2026-10-14 — guarantor recovery: installments of OTHER employees'
      // loans/advances deducted from THIS employee's salary as guarantor
      // (calculateRun's fallback pass). The ledger targets the BORROWER's
      // loan/advance rows; payrollEntryId points at the guarantor's entry so
      // the payslip and the ledger agree on who actually paid. Reversal rides
      // the same recovery.loan/recovery.advance records as own-loan recovery
      // (payroll.runs.cancel reverts both paths identically).
      if (e.guarantorDeduction > 0) {
        let remainingG = e.guarantorDeduction
        let gRecs: any[] = []
        try {
          const bd = JSON.parse(e.breakdownJson || "{}")
          gRecs = Array.isArray(bd.guarantorRecoveries) ? bd.guarantorRecoveries : []
        } catch { /* legacy snapshot — no guarantor records */ }
        for (const r of gRecs) {
          if (remainingG <= 0) break
          if (r.kind === "LOAN" && r.installmentId) {
            const inst = await tx.loanInstallment.findUnique({ where: { id: r.installmentId } })
            if (!inst || inst.paidAmount >= inst.amount) continue
            const pay = Math.min(inst.amount - inst.paidAmount, Number(r.amount) || 0, remainingG)
            if (pay <= 0) continue
            remainingG -= pay
            const newPaid = inst.paidAmount + pay
            await tx.loanInstallment.update({
              where: { id: inst.id },
              data: { paidAmount: newPaid, status: newPaid >= inst.amount ? "PAID" : "PARTIAL", paidAt: new Date(), payrollEntryId: e.id },
            })
            recovery.loan.push({ installmentId: inst.id, amount: pay })
            const loan = await tx.loan.findUnique({ where: { id: inst.loanId } })
            if (loan) {
              const newLoanPaid = loan.paidAmount + pay
              const remaining = Math.max(0, loan.principal - newLoanPaid)
              await tx.loan.update({
                where: { id: loan.id },
                data: { paidAmount: newLoanPaid, outstanding: remaining, status: remaining <= 0 ? "CLOSED" : "ACTIVE" },
              })
              if (remaining <= 0) {
                await tx.employeeHistory.create({
                  data: { vendorId: ctx.vendorId, employeeId: loan.employeeId, eventType: "LOAN_CLOSED",
                    title: `Loan fully recovered (guarantor)`, description: `Loan of ৳${loan.principal} closed — final recovery from the guarantor's salary`, dataJson: JSON.stringify({ loanId: loan.id, guarantorEntryId: e.id }) },
                })
              }
            }
          } else if (r.kind === "ADVANCE" && r.advanceId) {
            const adv = await tx.advance.findUnique({ where: { id: r.advanceId } })
            if (!adv || adv.outstanding <= 0) continue
            const pay = Math.min(adv.outstanding, Number(r.amount) || 0, remainingG)
            if (pay <= 0) continue
            remainingG -= pay
            recovery.advance.push({ advanceId: adv.id, amount: pay })
            const newOut = adv.outstanding - pay
            await tx.advance.update({
              where: { id: adv.id },
              data: { deducted: adv.deducted + pay, outstanding: newOut, status: newOut <= 0 ? "RECOVERED" : "RECOVERING" },
            })
          }
        }
      }
      // PAY-003 (R3-2) — mark ONLY the bonuses THIS entry actually included.
      // The old blanket period-matched updateMany flipped every APPROVED bonus
      // of the period to PAID — including rows approved between calculate and
      // pay whose money was never inside any entry (silently lost). Entries
      // without recorded lines (legacy) keep the period-wide fallback.
      // PAY-008 — a bonus only becomes PAID when the CUMULATIVE disbursement
      // across the period's runs covers it; otherwise it parks at IN_PAYROLL
      // and a later run pays the remainder.
      const lines = entryBonusLines.get(e.id)
      if (lines && lines.length) {
        for (const bl of lines) {
          const row = bonusRowsById.get(String(bl.id))
          if (!row) continue
          // MON-1 — marking reads the FRESH in-transaction map (post-lock),
          // not the stale pre-transaction snapshot
          const cumulative = (bonusPaidMarking.get(String(bl.id)) || 0) + (Number(bl.amount) || 0)
          const fullyPaid = cumulative >= row.amount - 1 // ৳1 rounding tolerance
          const claimed = await tx.bonus.updateMany({
            where: { id: row.id, vendorId: ctx.vendorId, status: { in: ["APPROVED", "IN_PAYROLL"] } },
            data: { status: fullyPaid ? "PAID" : "IN_PAYROLL", runId },
          })
          if (claimed.count === 0 && row.status === "IN_PAYROLL") {
            // already partially disbursed by a concurrent pay of another run —
            // nothing to do, the remainder logic recomputes on the next run
          }
        }
      } else {
        await tx.bonus.updateMany({
          where: { vendorId: ctx.vendorId, employeeId: e.employeeId, status: "APPROVED", periodMonth: run.periodMonth, periodYear: run.periodYear },
          data: { status: "PAID", runId },
        })
      }
      // ---- MON-2 (Phase 1): mark ONLY the deductions snapshotted into this
      // entry at calculation time (breakdownJson.deductionLines). The old
      // blanket updateMany flipped EVERY ACTIVE deduction of the employee-month
      // to PAID — a deduction created or edited between calculate and pay was
      // marked settled although its money never flowed. Entries without
      // recorded lines (legacy snapshots) keep the historical fallback.
      const dLines = entryDeductionLines.get(e.id)
      if (dLines && dLines.length) {
        if (dLines.length) {
          await tx.deduction.updateMany({
            where: { id: { in: dLines.map((l) => String(l.id)) }, vendorId: ctx.vendorId, status: "ACTIVE" },
            data: { status: "PAID" },
          })
        }
      } else {
        await tx.deduction.updateMany({
          where: { vendorId: ctx.vendorId, employeeId: e.employeeId, month: run.periodMonth, year: run.periodYear, status: "ACTIVE" },
          data: { status: "PAID" },
        })
      }

      // Late leave adjustment: increment used days in leave balance at pay time
      let bdParsed: any = null
      try { bdParsed = JSON.parse(e.breakdownJson || "{}") } catch {}
      if (bdParsed?.lateLeaveAdjustment?.adjustedDays > 0 && bdParsed?.lateLeaveAdjustment?.balanceId) {
        const adj = bdParsed.lateLeaveAdjustment
        const bal = runLeaveBalanceById.get(adj.balanceId)
        if (bal) {
          await tx.leaveBalance.update({
            where: { id: bal.id },
            data: { used: { increment: adj.adjustedDays } },
          })
          recovery.leave.push({
            balanceId: bal.id,
            days: adj.adjustedDays,
            leaveTypeId: bal.leaveTypeId,
          })
          await tx.employeeHistory.create({
            data: {
              vendorId: ctx.vendorId,
              employeeId: e.employeeId,
              eventType: "LEAVE_ADJUSTMENT",
              title: "Late leave adjustment",
              description: `Adjusted ${adj.adjustedDays} day(s) from ${adj.leaveTypeName || "leave"} for late arrival policy`,
              dataJson: JSON.stringify({
                runId,
                entryId: e.id,
                leaveTypeId: bal.leaveTypeId,
                days: adj.adjustedDays,
              }),
            },
          })
        }
      }

      await tx.payrollEntry.update({ where: { id: e.id }, data: { payslipNumber: psNo, status: "INCLUDED", recoveryJson: JSON.stringify(recovery) } })
      notified.push({ employeeId: e.employeeId, psNo, net: e.net })

      // PAY-001 — the SOURCE run's entry this adjustment corrects finally
      // carries its ADJUSTED status (schema vocabulary + adjustEntryId link)
      if (run.runType === "ADJUSTMENT" && e.adjustEntryId) {
        await tx.payrollEntry.update({ where: { id: e.adjustEntryId }, data: { status: "ADJUSTED" } }).catch(() => null)
      }

      // ---- PF ledger rows (Provident Fund module) — written once per paid run.
      // Amounts come from the calculation snapshot (breakdownJson.pf), so a
      // recalculation before payment is automatically honored. Idempotency:
      // PAYROLL-sourced rows for this run are replaced, MANUAL/OPENING/WITHDRAWAL
      // rows are never touched.
      try {
        const bd = JSON.parse(e.breakdownJson || "{}")
        if (bd.pf && (bd.pf.employeeAmount > 0 || bd.pf.employerAmount > 0)) {
          // SCL-5 — collected; flushed as one deleteMany + createMany after
          // the entries loop (identical idempotency: PAYROLL-sourced rows of
          // this run are replaced, MANUAL/OPENING/WITHDRAWAL never touched)
          pfRows.push({
            vendorId: ctx.vendorId, employeeId: e.employeeId,
            periodYear: run.periodYear, periodMonth: run.periodMonth,
            employeeAmount: bd.pf.employeeAmount || 0, employerAmount: bd.pf.employerAmount || 0,
            source: "PAYROLL", runId,
            note: `Payroll ${run.periodYear}-${String(run.periodMonth).padStart(2, "0")} — ${bd.pf.employeePct}%/employee + ${bd.pf.employerPct}%/employer on ${bd.pf.basis}`,
            // MON-3 — the runId is folded into the hash so the multiple
            // weekly runs of one month never collide on the identical note
            noteHash: pfNoteHash(`Payroll ${run.periodYear}-${String(run.periodMonth).padStart(2, "0")} — ${bd.pf.employeePct}%/employee + ${bd.pf.employerPct}%/employer on ${bd.pf.basis}`, "PAYROLL", runId),
            createdBy: ctx.userId,
          })
        }
      } catch { /* malformed snapshot on a legacy entry — no PF row */ }
    }

    // SCL-5 — flush the collected PF ledger rows in two set operations
    if (pfRows.length) {
      await tx.pfContribution.deleteMany({
        where: { vendorId: ctx.vendorId, runId, employeeId: { in: pfRows.map((r) => r.employeeId) }, source: "PAYROLL" },
      })
      await tx.pfContribution.createMany({ data: pfRows })
    }

    // ---- PAY-003 — APPROVED period bonuses that are NOT in any entry are NOT
    // paid by this run (typically approved after the calculation snapshot).
    // They are counted and surfaced so the operator moves them to a later
    // period instead of assuming they were paid.
    if (entries.length) {
      const empIdsInRun = entries.map((e) => e.employeeId)
      const approvedPeriod = await tx.bonus.findMany({
        where: { vendorId: ctx.vendorId, employeeId: { in: empIdsInRun }, status: "APPROVED", periodMonth: run.periodMonth, periodYear: run.periodYear },
        select: { id: true },
      })
      excludedApprovedBonusCount = approvedPeriod.filter((b) => !inRunBonusIds.has(b.id)).length
      // ---- MON-2 (Phase 1) — the deduction twin of the same report: ACTIVE
      // deductions of the period that are NOT in any entry's snapshot. These
      // are rows created/edited after the calculation (their money never
      // flowed through this run) — surfaced so the operator re-runs them in a
      // later period instead of the ledger silently claiming they were paid.
      const activePeriodDeductions = await tx.deduction.findMany({
        where: { vendorId: ctx.vendorId, employeeId: { in: empIdsInRun }, month: run.periodMonth, year: run.periodYear, status: "ACTIVE" },
        select: { id: true },
      })
      excludedActiveDeductionCount = activePeriodDeductions.filter((d) => !inRunDeductionIds.has(d.id)).length
    }

    // ---- accounting journal (spec §10.4) — idempotent per run (H-3) ----
    // WP-F (2026-10-08) — lines now resolve through the tenant-editable account
    // mapping (HR Settings → Payroll → Accounting); defaults reproduce the
    // historical hard-wired chart exactly. autoPost=false skips the journal.
    const { postJournal, resolveAccountMapping, autoPostPayrollJournal, roleLine, normalizeJournalSides } = await import("./accounting")
    // PF totals for the journal: employee portion (withheld) + employer cost
    let pfEmployeeTotal = 0, pfEmployerTotal = 0
    for (const e of entries) {
      try {
        const bd = JSON.parse(e.breakdownJson || "{}")
        if (bd.pf) { pfEmployeeTotal += bd.pf.employeeAmount || 0; pfEmployerTotal += bd.pf.employerAmount || 0 }
      } catch { /* legacy entry without PF */ }
    }
    const loanTotal = entries.reduce((s, e) => s + e.loanDeduction, 0)
    const advanceTotal = entries.reduce((s, e) => s + e.advanceDeduction, 0)
    // 2026-10-14 — guarantor recoveries are loan/advance credits too: the
    // salary expense line already carries them (gross is unchanged); the
    // receivable/advance credit lines must include the guarantor-paid portion
    // or the journal under-credits the loan ledger by exactly that amount.
    let guarantorLoanTotal = 0, guarantorAdvanceTotal = 0
    for (const e of entries) {
      if (!(e.guarantorDeduction > 0)) continue
      try {
        const bd = JSON.parse(e.breakdownJson || "{}")
        for (const r of (Array.isArray(bd.guarantorRecoveries) ? bd.guarantorRecoveries : [])) {
          if (r.kind === "LOAN") guarantorLoanTotal += Number(r.amount) || 0
          else if (r.kind === "ADVANCE") guarantorAdvanceTotal += Number(r.amount) || 0
        }
      } catch { /* legacy snapshot */ }
    }
    let jid: string | null = run.journalId || null
    if (autoPostPayrollJournal(settings)) {
      const am = resolveAccountMapping(settings)
      const journalLoanTotal = loanTotal + guarantorLoanTotal
      const journalAdvanceTotal = advanceTotal + guarantorAdvanceTotal
      const isAdj = run.runType === "ADJUSTMENT"
      // PAY-001 — adjustment journals carry DELTAS: the plug line must NOT
      // be zero-clamped (a negative correction is legitimate), and every
      // negative line flips onto its proper side (a correction that reduces
      // an expense is a credit; a recovered net is a debit).
      const plug = run.totalGross + run.totalOt + run.totalBonus - run.totalAit - run.totalNet - journalLoanTotal - journalAdvanceTotal - pfEmployeeTotal
      const rawLines = [
        roleLine(am, "salaryExpense", run.totalGross + run.totalOt + run.totalBonus, "debit"),
        ...(pfEmployerTotal > 0 ? [roleLine(am, "pfEmployerExpense", pfEmployerTotal, "debit")] : []),
        roleLine(am, "aitPayable", run.totalAit, "credit"),
        ...(pfEmployeeTotal + pfEmployerTotal > 0 ? [roleLine(am, "pfPayable", pfEmployeeTotal + pfEmployerTotal, "credit")] : []),
        roleLine(am, "salariesPayable", run.totalNet, "credit"),
        roleLine(am, "loanReceivable", journalLoanTotal, "credit"),
        roleLine(am, "advances", journalAdvanceTotal, "credit"),
        roleLine(am, "deductionsRecovered", isAdj ? plug : Math.max(0, plug), "credit"),
      ]
      const lines = isAdj ? normalizeJournalSides(rawLines) : rawLines
      // an all-zero correction posts nothing (validateAndBalanceLines would
      // reject a sideless entry)
      if (lines.length) {
        jid = await postJournal(ctx, "PAYROLL", runId, new Date().toISOString().slice(0, 10),
          isAdj
            ? `Payroll adjustment #${run.adjustSeq ?? 1} — ${monthName(run.periodMonth)} ${run.periodYear} (delta ৳${Math.round(run.totalNet).toLocaleString("en-IN")}) — ${entries.length} employees`
            : `Payroll ${monthName(run.periodMonth)} ${run.periodYear} — ${entries.length} employees${guarantorLoanTotal + guarantorAdvanceTotal > 0 ? ` (incl. ৳${(guarantorLoanTotal + guarantorAdvanceTotal).toLocaleString("en-IN")} guarantor recovery)` : ""}`,
          lines, Math.abs(run.totalNet), { tx, idempotencyKey: `PAYROLL:${runId}` })
      }
    }

    await tx.payrollRun.update({
      where: { id: runId },
      data: { status: "PAID", paymentDate: new Date().toISOString().slice(0, 10), journalId: jid },
    })
    return jid
  }, { timeout: 60_000, maxWait: 10_000 }).catch((e: any) => {
    // P1 (re-audit 2026-10-18) — the pool makes a payslip collision a
    // near-impossibility; if the DB unique ever fires anyway (legacy manual
    // numbers, a restored backup), surface it as a clear, safe-to-retry 409
    // instead of a raw P2002 500. The run stays APPROVED (the claim rolls
    // back with the transaction), so the operator can re-try after support
    // re-synced the pool.
    if (String(e?.code) === "P2002" && Array.isArray(e?.meta?.target) && (e.meta.target as string[]).includes("payslipNumber")) {
      throw new Deny("Payslip number collision — this month's number pool is out of sync with existing payslips. Contact support before re-trying the payment.", 409)
    }
    throw e
  }) // full-vendor runs exceed Prisma's 5s default

  // ---- post-commit side effects: notifications + payslip email delivery ----
  for (const n of notified) {
    // PAY-001 — adjustments are corrections, not a second salary credit
    if (run.runType === "ADJUSTMENT") {
      await notifyChannels(ctx.vendorId, { employeeId: n.employeeId }, "Payroll Adjustment Processed",
        `A payroll adjustment for ${monthName(run.periodMonth)} ${run.periodYear} was processed. Correction: ৳${n.net.toFixed(0)}${n.net < 0 ? " (recovered)" : ""}. The adjustment statement ${n.psNo} is available in your portal.`,
        "PAYROLL", "ess", { sms: true }, "payslip_generated",
        { period: `${monthName(run.periodMonth)} ${run.periodYear}`, netPay: n.net.toFixed(0), payslipNumber: n.psNo }).catch(() => {})
      continue
    }
    await notifyChannels(ctx.vendorId, { employeeId: n.employeeId }, "Salary Processed",
      `Your salary for ${monthName(run.periodMonth)} ${run.periodYear} has been processed. Net pay: ৳${n.net.toFixed(0)}. Payslip ${n.psNo} is available in your portal.`,
      "PAYROLL", "ess", { sms: true }, "salary_credited",
      { period: `${monthName(run.periodMonth)} ${run.periodYear}`, netPay: n.net.toFixed(0), payslipNumber: n.psNo }).catch(() => {})
  }
  if (settings.notification.payslipEmail) {
    const { emailPayslip } = await import("./delivery")
    // M-13 — bounded concurrency instead of a sequential request-long loop
    const CONCURRENCY = 5
    const queue = notified.map((n) => n)
    const worker = async () => {
      while (queue.length) {
        const item = queue.shift()
        if (!item) break
        const entry = await db.payrollEntry.findFirst({ where: { runId, employeeId: item.employeeId } })
        if (!entry) continue
        try { await emailPayslip(ctx.vendorId, entry.id) } catch (err) { console.error("payslip email failed", entry.id, err) }
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, notified.length) }, worker))
  }
  await audit(ctx, "payroll.pay", "PayrollRun", runId,
    `Paid payroll ${monthName(run.periodMonth)} ${run.periodYear}; journal ${journalId}`
    + (excludedApprovedBonusCount > 0
      ? `; WARNING: ${excludedApprovedBonusCount} APPROVED period bonus(es) were NOT in any entry (approved after the calculation snapshot) — they are NOT paid by this run and remain APPROVED for a later period`
      : "")
    + (excludedActiveDeductionCount > 0
      ? `; WARNING: ${excludedActiveDeductionCount} ACTIVE period deduction(s) were NOT in any entry snapshot (created/edited after the calculation) — they are NOT marked PAID by this run and remain ACTIVE for a later period`
      : ""))
  return {
    journalId,
    payslips: entries.length,
    ...(excludedApprovedBonusCount > 0 ? { excludedApprovedBonuses: excludedApprovedBonusCount } : {}),
    ...(excludedActiveDeductionCount > 0 ? { excludedActiveDeductions: excludedActiveDeductionCount } : {}),
  }
}

// ---- PAY-001 (R3-1): adjustment runs carry TRUE DELTAS ----------------------
// An ADJUSTMENT run never re-disburses the month: calculateRun first does the
// ordinary full recompute (corrected values), then this pure transform turns
// every entry into the CORRECTION against the PAID source run's entry, so the
// run totals, the approval amount, the payslips, the journal and the bank
// advice carry ONLY the difference. Unit-tested in r3-1-wave-criticals.test.ts.
export type AdjustmentSourceEntry = {
  id?: string
  employeeId: string
  gross: number
  otAmount: number
  bonus: number
  commission: number
  absenceDeduction: number
  lateDeduction: number
  loanDeduction: number
  advanceDeduction: number
  otherDeduction: number
  guarantorDeduction: number
  ait: number
  net: number
  breakdownJson?: string | null
  // MON-9 — source rows written by the integer engine carry their paisa
  // columns; pre-migration rows do not and are ingested through toPaisa once.
  grossPaisa?: bigint | null
  otAmountPaisa?: bigint | null
  bonusPaisa?: bigint | null
  commissionPaisa?: bigint | null
  absenceDeductionPaisa?: bigint | null
  lateDeductionPaisa?: bigint | null
  loanDeductionPaisa?: bigint | null
  advanceDeductionPaisa?: bigint | null
  otherDeductionPaisa?: bigint | null
  guarantorDeductionPaisa?: bigint | null
  aitPaisa?: bigint | null
  netPaisa?: bigint | null
}

export function applyAdjustmentDeltas(entries: any[], sourceEntries: AdjustmentSourceEntry[]): void {
  const srcByEmp = new Map(sourceEntries.map((e) => [e.employeeId, e]))
  for (const ne of entries) {
    const se = srcByEmp.get(ne.employeeId)
    const rec = j(ne.breakdownJson, {} as any)
    const sb = j(se?.breakdownJson, {} as any)
    // MON-9 — the correction is computed in paisa: the recomputed value
    // (paisa when the engine produced it — always, now) minus the source
    // value (paisa when present, else the Float ingested once through
    // toPaisa for pre-migration rows). The Float fields are derived.
    const srcP = (k: keyof AdjustmentSourceEntry, paisaKey: string): bigint => {
      const sp = se as any
      return sp && sp[paisaKey] != null ? BigInt(sp[paisaKey]) : toPaisa(Number((se as any)?.[k]) || 0)
    }
    const newP = (k: string, paisaKey: string): bigint =>
      ne[paisaKey] != null ? BigInt(ne[paisaKey]) : toPaisa(Number(ne[k]) || 0)
    const recalcPfEmployeeP = toPaisa(Number(rec.pf?.employeeAmount) || 0)
    const srcPfEmployeeP = toPaisa(Number(sb.pf?.employeeAmount) || 0)
    const recalcPfEmployerP = toPaisa(Number(rec.pf?.employerAmount) || 0)
    const srcPfEmployerP = toPaisa(Number(sb.pf?.employerAmount) || 0)
    // EARNINGS + statutory tax are the correction (recomputed − source). The
    // AIT delta composes cleanly because the §86(4) year-to-date actuals EXCLUDE
    // the same-period source run (isBeforeCurrentPeriod), so with unchanged
    // data the recomputed AIT equals the source AIT and this delta is zero.
    const dGrossP = newP("gross", "grossPaisa") - srcP("gross", "grossPaisa")
    const dOtP = newP("otAmount", "otAmountPaisa") - srcP("otAmount", "otAmountPaisa")
    const dAitP = newP("ait", "aitPaisa") - srcP("ait", "aitPaisa")
    const dAbsenceP = newP("absenceDeduction", "absenceDeductionPaisa") - srcP("absenceDeduction", "absenceDeductionPaisa")
    const dLateP = newP("lateDeduction", "lateDeductionPaisa") - srcP("lateDeduction", "lateDeductionPaisa")
    const dRepeatP = toPaisa(Number(rec.repeatOffenderPenalty) || 0) - toPaisa(Number(sb.repeatOffenderPenalty) || 0)
    const dEarlyP = toPaisa(Number(rec.earlyLeaveDeduction) || 0) - toPaisa(Number(sb.earlyLeaveDeduction) || 0)
    // PAY-04 — the attendance-bonus forfeiture is a breakdown-carried policy
    // deduction exactly like the escalation lines; adjustments must carry its
    // delta too or the correction's net would not reconcile with its lines.
    const dForfeitP = toPaisa(Number(rec.attendanceBonusForfeit) || 0) - toPaisa(Number(sb.attendanceBonusForfeit) || 0)
    const dPfEmployeeP = recalcPfEmployeeP - srcPfEmployeeP
    const dPfEmployerP = recalcPfEmployerP - srcPfEmployerP
    // LEDGER-DRIVEN components are NOT subtracted — they self-manage through
    // status transitions: bonuses/manual deductions consumed by the source run
    // are PAID (excluded from the recompute, so the recomputed value IS the new
    // money), and loan/advance installments recovered by the source run are
    // already marked paid (the recompute only sees what is still due).
    const dBonusP = newP("bonus", "bonusPaisa")
    const dCommissionP = newP("commission", "commissionPaisa")
    const dLoanP = newP("loanDeduction", "loanDeductionPaisa")
    const dAdvanceP = newP("advanceDeduction", "advanceDeductionPaisa")
    const dOtherP = newP("otherDeduction", "otherDeductionPaisa")
    const dNetP = dGrossP + dOtP + dBonusP + dCommissionP
      - dAbsenceP - dLateP - dRepeatP - dEarlyP - dForfeitP
      - dLoanP - dAdvanceP - dOtherP - dPfEmployeeP - dAitP
    const dGross = takaOf(dGrossP), dOt = takaOf(dOtP)
    const dBonus = takaOf(dBonusP), dCommission = takaOf(dCommissionP)
    const dAbsence = takaOf(dAbsenceP), dLate = takaOf(dLateP), dRepeat = takaOf(dRepeatP), dEarly = takaOf(dEarlyP)
    const dLoan = takaOf(dLoanP), dAdvance = takaOf(dAdvanceP), dOther = takaOf(dOtherP)
    const dPfEmployee = takaOf(dPfEmployeeP), dPfEmployer = takaOf(dPfEmployerP)
    const dAit = takaOf(dAitP)
    const dNet = takaOf(dNetP)
    ne.gross = dGross
    ne.otAmount = dOt
    ne.bonus = dBonus
    ne.commission = dCommission
    ne.absenceDeduction = dAbsence
    ne.lateDeduction = dLate
    ne.loanDeduction = dLoan
    ne.advanceDeduction = dAdvance
    ne.otherDeduction = dOther
    ne.ait = dAit
    // MON-9 — the paisa columns carry the same deltas (the run's totals
    // reducer reads them directly)
    ne.grossPaisa = dGrossP
    ne.otAmountPaisa = dOtP
    ne.bonusPaisa = dBonusP
    ne.commissionPaisa = dCommissionP
    ne.absenceDeductionPaisa = dAbsenceP
    ne.lateDeductionPaisa = dLateP
    ne.loanDeductionPaisa = dLoanP
    ne.advanceDeductionPaisa = dAdvanceP
    ne.otherDeductionPaisa = dOtherP
    ne.aitPaisa = dAitP
    // A NEGATIVE net is a recovery and is legitimate on an adjustment —
    // the M-5 zero-clamp applies to regular salaries, not corrections.
    ne.net = dNet
    ne.netPaisa = dNetP
    // link the correction to the source entry it corrects (schema column
    // finally used; payRun marks that source entry status="ADJUSTED")
    ne.adjustEntryId = se?.id || null
    // payslip-compatible breakdown of the CORRECTION (only non-zero lines)
    const earnings: { label: string; amount: number }[] = []
    const deductions: { label: string; amount: number }[] = []
    if (dGrossP) earnings.push({ label: "Gross correction", amount: dGross })
    if (dOtP) earnings.push({ label: "Overtime correction", amount: dOt })
    if (dBonusP) earnings.push({ label: "Bonus (added)", amount: dBonus })
    if (dCommissionP) earnings.push({ label: "Commission (added)", amount: dCommission })
    if (dAbsenceP) deductions.push({ label: "Absence correction", amount: dAbsence })
    if (dLateP) deductions.push({ label: "Late correction", amount: dLate })
    if (dRepeatP) deductions.push({ label: "Late escalation correction", amount: dRepeat })
    if (dEarlyP) deductions.push({ label: "Early-leave correction", amount: dEarly })
    if (dForfeitP) deductions.push({ label: "Attendance bonus correction", amount: takaOf(dForfeitP) })
    if (dLoanP) deductions.push({ label: "Loan recovery (additional)", amount: dLoan })
    if (dAdvanceP) deductions.push({ label: "Advance recovery (additional)", amount: dAdvance })
    if (dOtherP) deductions.push({ label: "Other deduction (added)", amount: dOther })
    if (dPfEmployeeP) deductions.push({ label: "Provident Fund correction", amount: dPfEmployee })
    if (dAitP) deductions.push({ label: "AIT correction", amount: dAit })
    ne.breakdownJson = JSON.stringify({
      adjustment: {
        sourceEntryId: se?.id || null,
        note: "Adjustment statement — amounts are the correction vs the paid source run, not a second month",
        corrections: { gross: dGross, ot: dOt, bonus: dBonus, commission: dCommission, absence: dAbsence, late: dLate, ait: dAit, pf: dPfEmployee, net: dNet },
        recomputed: { gross: rec.gross, otAmount: rec.otAmount, ait: rec.ait, net: rec.net },
        source: se ? { gross: se.gross, otAmount: se.otAmount, ait: se.ait, net: se.net } : null,
      },
      earnings,
      deductions,
      ...(rec.pf ? { pf: { ...rec.pf, employeeAmount: dPfEmployee, employerAmount: dPfEmployer } } : {}),
      attendance: rec.attendance,
      net: dNet,
      ...(dNet < 0 ? { warnings: ["Negative adjustment — this amount is recovered from the employee, not paid out."] } : {}),
    })
  }
}

/** Adjustment mechanism — never edit approved payroll directly (spec §9.4).
 *  H-16 — the old (vendor, period, runType) unique key capped corrections at
 *  ONE adjustment per period; the key now includes adjustSeq so successive
 *  adjustment runs coexist, each adjusting its own PAID source run. */
export async function createAdjustmentRun(ctx: Ctx, sourceRunId: string) {
  const src = await db.payrollRun.findFirst({ where: { id: sourceRunId, vendorId: ctx.vendorId } })
  if (!src) throw new Deny("Source run not found", 404)
  if (src.runType === "ADJUSTMENT") throw new Deny("Cannot adjust an adjustment run")
  // H-16 — an adjustment corrects money that was actually disbursed: reject
  // anything that has not reached PAID (a draft/calculated run can just be
  // recalculated — no adjustment needed).
  if (src.status !== "PAID") throw new Deny(`Adjustments apply to PAID runs only — this run is ${src.status}`)
  const seqKey = `adjust:${ctx.vendorId}:${src.periodYear}-${src.periodMonth}-${src.periodWeek ?? 0}`
  // M-7 — the sequence is allocated ATOMICALLY via the shared SequenceCounter
  // (the old read-max-then-create raced: two concurrent adjustments both read
  // adjustSeq=2 and one surfaced a raw P2002 500). The counter key is scoped
  // per (vendor, period, week) so it tracks exactly the unique bucket. A
  // single-statement upsert: the create branch seeds at the existing max + 1
  // (0 when none, so it never reuses a number already in the table), the
  // update branch increments — both atomic, and unlike the previous
  // update-then-create fallback neither can log a caught P2025 as a scary
  // `prisma:error` on the vendor's first-ever adjustment.
  const maxAdj = await db.payrollRun.findFirst({
    where: { vendorId: ctx.vendorId, periodYear: src.periodYear, periodMonth: src.periodMonth, periodWeek: src.periodWeek, runType: "ADJUSTMENT" },
    orderBy: { adjustSeq: "desc" },
    select: { adjustSeq: true },
  })
  const adjCounter = await db.sequenceCounter.upsert({
    where: { key: seqKey },
    update: { value: { increment: 1 } },
    create: { key: seqKey, value: (maxAdj?.adjustSeq ?? 0) + 1 },
    select: { value: true },
  })
  const nextSeq = adjCounter.value
  const adj = await db.payrollRun.create({
    data: {
      vendorId: ctx.vendorId, periodMonth: src.periodMonth, periodYear: src.periodYear,
      periodWeek: src.periodWeek, runType: "ADJUSTMENT", adjustSeq: nextSeq,
      adjustRunId: sourceRunId, status: "DRAFT", createdBy: ctx.userId,
    },
  })
  await audit(ctx, "payroll.createAdjustment", "PayrollRun", adj.id, `Adjustment run #${nextSeq} for run ${sourceRunId}`)
  return adj.id
}

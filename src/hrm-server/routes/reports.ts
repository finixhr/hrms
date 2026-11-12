// ============ Dashboard / Reports / Analytics / Audit / Accounting views ============
// Dashboard consumes events from underlying engines (spec §16). Reports support
// filters + CSV export (spec §17.1–17.5). Analytics aggregates workforce/attendance/
// payroll/performance (spec §17.6).
import { db } from "@/lib/db"
import { z } from "zod"
import { route } from "./registry"
import { Deny, employeeScopeFilter, assertEmployeeVisible } from "../rbac"
import { audit } from "../audit"
import { getSettings } from "../settings"
import { addDays, csv, daysBetween, j, monthName, pct, titleCase, today, resolveWeeklyOffDays, parseNumber } from "../utils"
import { resolveSalaryPayouts } from "../payout"
import { withAuthoritativeMoney, ENTRY_MONEY_FIELDS, RUN_MONEY_FIELDS } from "../money"
import {
  registerReport, listReportDefinitions, reportDefinition, renderAnalyticsReport, reportToCsv,
  kpi, deltaPct, type AnalyticsReport, type ReportParams, type ReportDefinition,
} from "../analytics-report"
import { reportMetaOf, type ReportMeta } from "../report-meta"
import { requireFeature, resolveEntitlements, featureBlocked } from "../saas/entitlements"

// ============ RPT-11 — THE canonical attendance-rate definition ============
// One employee-day basis everywhere: present-ish records ÷ expected
// employee-days. LEAVE (incl. unpaid), HOLIDAY and WEEKLY_OFF never count as
// attended; HALF_DAY does (the employee worked part of the day). The
// dashboard, the analytics trend and the attendance overview all use THESE
// two functions — the old analytics trend counted LEAVE/HOLIDAY/WEEKLY_OFF
// as attended over records, disagreeing with the other two surfaces.
const RATE_NOT_COUNTED = ["ABSENT", "LEAVE", "LEAVE_UNPAID", "HOLIDAY", "WEEKLY_OFF"]
export const rateCountedStatus = (st: string) => !RATE_NOT_COUNTED.includes(st)
export function attendanceRatePct(presentish: number, expectedDays: number): number {
  if (!expectedDays) return 0
  return Math.min(100, Math.round((presentish / expectedDays) * 1000) / 10)
}

const WD = ["SUNDAY", "MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY"]
const dowOf = (ds: string) => WD[new Date(`${ds}T00:00:00Z`).getUTCDay()]

/** L-28 — attendance reports accept caller-supplied date ranges; an
 *  unbounded span (from=2000&to=2030) pulled the WHOLE attendance + event
 *  tables into memory. Capped at 366 days (a full leap year) — wider
 *  analysis needs two exports, which the CSV route serves equally well. */
const REPORT_RANGE_MAX_DAYS = 366
function capReportRange(from: string, to: string): { from: string; to: string } {
  if (from > to) throw new Deny(`Invalid date range — "from" (${from}) is after "to" (${to})`, 400)
  if (daysBetween(from, to) + 1 > REPORT_RANGE_MAX_DAYS) {
    throw new Deny(`Date range too wide — reports cover at most ${REPORT_RANGE_MAX_DAYS} days per request (asked ${daysBetween(from, to) + 1}). Split the period or use the CSV export per year.`, 400)
  }
  return { from, to }
}

/** L-28 — dashboard.stats re-aggregated the whole vendor (employees,
 *  attendance, loans, docs, reviews…) on EVERY call, including the 30s
 * client poll. A 60s in-process memo per visibility scope keeps the
 *  dashboard responsive; single-instance by design (same constraint as the
 *  rate limiter — documented in .env.example / DEPLOYMENT-GUIDE). */
const DASHBOARD_MEMO_TTL_MS = 60_000
const dashboardMemo = new Map<string, { at: number; value: unknown }>()

route("dashboard.stats", {
  perm: ["dashboard", "view"],
  handler: async (ctx) => {
    const scope = employeeScopeFilter(ctx)
    // FIN-022 (Phase 2) — financial blocks are permission-gated SERVER-SIDE,
    // so the memo must be keyed by the caller's FINANCIAL permission set as
    // well as the visibility scope: previously one payload per scope served
    // every dashboard.view caller, so a custom role without payroll.view /
    // loans.view / expenses.view received the full payroll gross/net, loan
    // outstanding and expense figures (client-side widget hiding only — the
    // codebase's own FLD-101 "not on the wire if never shown" discipline was
    // violated on the wire, and the 60s memo amplified it cross-caller).
    const finPerms = ["payroll.view", "loans.view", "expenses.view"]
    const finFlags = finPerms.map((p) => ctx.permissions.has("*") || ctx.permissions.has(p))
    const showPayroll = finFlags[0]
    const showLoans = finFlags[1]
    const showExpenses = finFlags[2]
    const memoKey = JSON.stringify({ scope, finFlags })
    const hit = dashboardMemo.get(memoKey)
    if (hit && Date.now() - hit.at < DASHBOARD_MEMO_TTL_MS) return hit.value
    // PERF-01 — slim projection: the old full-row fetch loaded EVERY column
    // including the base64 photo data-URLs (photoUrl + photoThumb) of the
    // whole roster on every (memoized) dashboard call. The projection below
    // is exactly the field set this handler reads; the handful of avatar
    // photos the widgets display are hydrated afterwards for THOSE ids only.
    const employees = await db.employee.findMany({
      where: scope,
      select: {
        id: true, code: true, fullName: true, status: true, joiningDate: true,
        dob: true, contractEnd: true, probationMonths: true, gender: true,
        employmentType: true,
        weeklyOff: true, shiftId: true, branchId: true, departmentId: true,
        designationId: true,
        updatedAt: true,
      },
    })
    const photoOf = (id: string): string | null => dashPhotos.get(id) || null
    // MULTI-COMPANY — org axes are the ACTIVE company's (the All Companies
    // reporting context keeps the tenant scope for consolidated reads).
    const branches = await db.branch.findMany({ where: { vendorId: ctx.vendorId, ...(ctx.activeCompanyId && !ctx.allCompaniesMode ? { companyId: ctx.activeCompanyId } : {}) } })
    const depts = await db.department.findMany({ where: { vendorId: ctx.vendorId, ...(ctx.activeCompanyId && !ctx.allCompaniesMode ? { companyId: ctx.activeCompanyId } : {}) } })
    const desigs = await db.designation.findMany({ where: { vendorId: ctx.vendorId, ...(ctx.activeCompanyId && !ctx.allCompaniesMode ? { companyId: ctx.activeCompanyId } : {}) } })
    const t = today()
    const mm = t.slice(0, 7)

    // workforce KPIs
    const workforce = {
      total: employees.length,
      active: employees.filter((e) => e.status === "ACTIVE").length,
      probation: employees.filter((e) => e.status === "PROBATION").length,
      inactive: employees.filter((e) => ["INACTIVE", "SUSPENDED"].includes(e.status)).length,
      onLeave: employees.filter((e) => e.status === "ON_LEAVE").length,
      resigned: employees.filter((e) => e.status === "RESIGNED").length,
      terminated: employees.filter((e) => e.status === "TERMINATED").length,
      newJoiners30: employees.filter((e) => e.joiningDate && daysBetween(e.joiningDate, t) <= 30 && daysBetween(e.joiningDate, t) >= 0).length,
    }
    const byBranch = branches.map((b) => ({ name: b.name, value: employees.filter((e) => e.branchId === b.id).length })).filter((x) => x.value > 0)
    const byDepartment = depts.map((d) => ({ name: d.name, value: employees.filter((e) => e.departmentId === d.id).length })).filter((x) => x.value > 0)
    const byDesignation = desigs.map((d) => ({ name: d.name, value: employees.filter((e) => e.designationId === d.id).length })).filter((x) => x.value > 0).sort((a, b) => b.value - a.value).slice(0, 8)
    const byGender = ["Male", "Female", "Other"].map((g) => ({ name: g, value: employees.filter((e) => (e.gender || "").toUpperCase() === g.toUpperCase()).length })).filter((x) => x.value > 0)
    const byEmploymentType = [...new Set(employees.map((e) => e.employmentType))].map((ty) => ({ name: titleCase(ty), value: employees.filter((e) => e.employmentType === ty).length }))

    // attendance today
    // FORENSIC AUDIT 2026-11-10, FIN-007 (Phase 1): this was the ONE query of
    // dashboard.stats' five blocks left vendor-wide during the multi-company
    // pass — the "attendance today" widget counted every company's punches
    // while workforce/org axes were already scoped. Attendance rows carry no
    // companyId column and no Employee relation, so the records are filtered
    // against the SAME scoped employee population the workforce KPIs use
    // (All Companies mode keeps the consolidated tenant-wide view).
    const scopedEmpIds = new Set(employees.map((e) => e.id))
    const todayRecordsAll = await db.attendance.findMany({ where: { vendorId: ctx.vendorId, date: t } })
    const todayRecords = todayRecordsAll.filter((r) => scopedEmpIds.has(r.employeeId))
    const activeEmps = employees.filter((e) => ["ACTIVE", "PROBATION", "ON_LEAVE"].includes(e.status))
    // LVE-001 (R3-4) — LEAVE_UNPAID joins the leave bucket everywhere it is
    // reported (a day of unpaid leave is still a leave day, just unpaid), and
    // it is excluded from the present/per-day counts like LEAVE is.
    const notCounted = (s: string) => !["ABSENT", "LEAVE", "LEAVE_UNPAID", "HOLIDAY", "WEEKLY_OFF"].includes(s)
    const attendanceToday = {
      present: todayRecords.filter((r) => ["PRESENT", "LATE", "EARLY_LEAVE", "WFH", "BUSINESS_TRIP"].includes(r.status)).length,
      absent: Math.max(0, activeEmps.length - todayRecords.filter((r) => notCounted(r.status)).length),
      late: todayRecords.filter((r) => r.status === "LATE").length,
      earlyLeave: todayRecords.filter((r) => r.status === "EARLY_LEAVE").length,
      halfDay: todayRecords.filter((r) => r.status === "HALF_DAY").length,
      leave: todayRecords.filter((r) => ["LEAVE", "LEAVE_UNPAID"].includes(r.status)).length,
      wfh: todayRecords.filter((r) => r.status === "WFH").length,
      businessTrip: todayRecords.filter((r) => r.status === "BUSINESS_TRIP").length,
      overtime: todayRecords.filter((r) => (r.overtimeMinutes || 0) > 0).length,
      rate: attendanceRatePct(todayRecords.filter((r) => notCounted(r.status)).length, activeEmps.length),
      marked: todayRecords.length,
    }

    // payroll & financial HR (current month runs)
    // R1-009 — scope financial queries to the caller's visible employees
    // so branch/department managers see only their scope's financials.
    // FIN-022 (Phase 2) — financial blocks are computed ONLY for callers
    // holding the matching module permission; everyone else gets an explicit
    // null block ("not on the wire if never shown"). The queries are skipped
    // entirely, so a restricted role's dashboard is also cheaper to serve.
    const scopedEmployeeIds = employees.map((e) => e.id)
    // MULTI-COMPANY — payroll figures are the ACTIVE company's runs (parity
    // with payroll.runs.list; All Companies keeps the tenant scope)
    const rawRuns = showPayroll
      ? await db.payrollRun.findMany({ where: { vendorId: ctx.vendorId, ...(ctx.activeCompanyId && !ctx.allCompaniesMode ? { companyId: ctx.activeCompanyId } : {}) }, orderBy: [{ periodYear: "desc" }, { periodMonth: "desc" }] })
      : []
    // FIN-082 (Phase 4) — the authoritative READ boundary: dashboard payroll
    // figures are re-derived from the integer-paisa shadows (no-op for
    // engine-written rows; a desynchronized Float cache can no longer reach
    // the HR dashboard).
    const runs = rawRuns.map((r) => withAuthoritativeMoney(r as unknown as Record<string, unknown>, RUN_MONEY_FIELDS) as typeof r)
    const lastPaid = runs.find((r) => r.status === "PAID")
    const payroll = showPayroll
      ? {
          gross: lastPaid?.totalGross || 0,
          net: lastPaid?.totalNet || 0,
          deductions: (lastPaid?.totalDeduction || 0) + (lastPaid?.totalAit || 0),
          overtime: lastPaid?.totalOt || 0,
          bonus: lastPaid?.totalBonus || 0,
          period: lastPaid ? `${monthName(lastPaid.periodMonth)} ${lastPaid.periodYear}` : "—",
          pendingApproval: runs.filter((r) => ["CALCULATED", "HR_REVIEW", "MANAGER_APPROVAL", "ACCOUNTING_APPROVAL", "APPROVED"].includes(r.status)).length,
          pendingPayment: runs.filter((r) => r.status === "APPROVED").length,
        }
      : null
    const loansIssued = showLoans
      ? await db.loan.aggregate({ where: { vendorId: ctx.vendorId, employeeId: { in: scopedEmployeeIds }, status: { in: ["ACTIVE"] } }, _sum: { principal: true } })
      : null
    const loansOutstanding = showLoans
      ? await db.loan.aggregate({ where: { vendorId: ctx.vendorId, employeeId: { in: scopedEmployeeIds }, status: "ACTIVE" }, _sum: { outstanding: true } })
      : null
    const loan = showLoans
      ? { issued: loansIssued?._sum.principal || 0, outstanding: loansOutstanding?._sum.outstanding || 0 }
      : null

    // pending requests & alerts (spec §16.5)
    const pending = {
      leave: await db.leaveRequest.count({ where: { vendorId: ctx.vendorId, employeeId: { in: scopedEmployeeIds }, status: "PENDING" } }),
      loans: await db.loan.count({ where: { vendorId: ctx.vendorId, employeeId: { in: scopedEmployeeIds }, status: "PENDING" } }),
      advances: await db.advance.count({ where: { vendorId: ctx.vendorId, employeeId: { in: scopedEmployeeIds }, status: "PENDING" } }),
      expenses: await db.expenseClaim.count({ where: { vendorId: ctx.vendorId, employeeId: { in: scopedEmployeeIds }, status: "PENDING" } }),
      attendanceCorrections: await db.attendanceCorrection.count({ where: { vendorId: ctx.vendorId, employeeId: { in: scopedEmployeeIds }, status: "PENDING" } }),
      resignations: await db.resignation.count({ where: { vendorId: ctx.vendorId, employeeId: { in: scopedEmployeeIds }, status: { in: ["SUBMITTED", "UNDER_REVIEW", "MANAGER_APPROVED", "HR_REVIEW", "MANAGEMENT_REVIEW"] } } }),
    }

    // alerts: repeated lateness / long absence / document expiry / contract expiry / probation completion
    // MULTI-COMPANY — settings resolve for the ACTIVE company (attendance
    // alert thresholds are company-overridable)
    const settings = await getSettings(ctx.vendorId, { companyId: ctx.activeCompanyId || undefined })
    const monthAtt = await db.attendance.findMany({ where: { vendorId: ctx.vendorId, date: { startsWith: mm } } })
    const lateByEmp = new Map<string, number>()
    const absentByEmp = new Map<string, number>()
    for (const a of monthAtt) {
      if (a.status === "LATE") lateByEmp.set(a.employeeId, (lateByEmp.get(a.employeeId) || 0) + 1)
      if (a.status === "ABSENT") absentByEmp.set(a.employeeId, (absentByEmp.get(a.employeeId) || 0) + 1)
    }
    const repeatedLate = [...lateByEmp.entries()].filter(([, n]) => n >= settings.attendance.repeatedLateAlertDays)
      .map(([id, n]) => ({ employeeId: id, name: employees.find((e) => e.id === id)?.fullName || "—", count: n }))
    const longAbsence = [...absentByEmp.entries()].filter(([, n]) => n >= settings.attendance.longAbsenceAlertDays)
      .map(([id, n]) => ({ employeeId: id, name: employees.find((e) => e.id === id)?.fullName || "—", count: n }))
    // missing attendance today (active employees, working day, no record)
    // MULTI-COMPANY — the holiday check is the ACTIVE company's calendar
    // (tenant-wide rows with null companyId still apply)
    const holidaysToday = await db.holiday.findMany({ where: { vendorId: ctx.vendorId, date: t, ...(ctx.activeCompanyId && !ctx.allCompaniesMode ? { OR: [{ companyId: ctx.activeCompanyId }, { companyId: null }] } : {}) } })
    const dow = dowOf(t)
    // 2026-10-13 — canonical weekly-off precedence (employee > shift > global
    // policy): one batched shift lookup, then per-employee resolution
    // MULTI-COMPANY — weekly-off resolution reads the ACTIVE company's shifts
    const shiftRowsToday = await db.shift.findMany({ where: { vendorId: ctx.vendorId, ...(ctx.activeCompanyId && !ctx.allCompaniesMode ? { companyId: ctx.activeCompanyId } : {}) }, select: { id: true, weeklyOff: true } })
    const shiftOffByIdToday = new Map(shiftRowsToday.map((s) => [s.id, s.weeklyOff]))
    const missingAttendance = !holidaysToday.length
      ? activeEmps.filter((e) => {
          const offs = resolveWeeklyOffDays(e.weeklyOff, e.shiftId ? shiftOffByIdToday.get(e.shiftId) : null, settings.general.weeklyHoliday)
          return !offs.includes(dow) && !todayRecords.some((r) => r.employeeId === e.id)
        }).map((e) => ({ id: e.id, name: e.fullName }))
      : []

    const horizon = addDays(t, settings.notification.documentExpiryDays)
    const expiringDocs = await db.employeeDocument.findMany({ where: { vendorId: ctx.vendorId, expiryDate: { not: null, gte: t, lte: horizon } } })
    const contractExpiry = employees.filter((e) => e.contractEnd && e.contractEnd >= t && e.contractEnd <= horizon)
    const probationCompletion = employees.filter((e) => e.status === "PROBATION" && e.joiningDate && daysBetween(e.joiningDate, addDays(t, 30)) <= e.probationMonths * 30 && daysBetween(e.joiningDate, t) <= e.probationMonths * 30 + 30)

    // loan installments due within 7 days (spec §16.5)
    // H-11 — vendor-scoped: installments are reached through THIS vendor's
    // loans (LoanInstallment has no vendorId column of its own).
    // FIN-022 (Phase 2) — installment amounts are loan money: hidden unless
    // the caller holds loans.view.
    const weekAhead = addDays(t, 7)
    const vendorLoans = showLoans ? await db.loan.findMany({ where: { vendorId: ctx.vendorId }, select: { id: true } }) : []
    const vendorLoanIds = vendorLoans.map((l) => l.id)
    const dueInstallments = vendorLoanIds.length ? (await db.loanInstallment.findMany({
      where: { loanId: { in: vendorLoanIds }, dueDate: { gte: t, lte: weekAhead }, status: { in: ["PENDING", "OVERDUE", "PARTIAL"] } },
      orderBy: { dueDate: "asc" }, take: 60,
    })).filter((i) => i.paidAmount < i.amount).slice(0, 10) : []
    const loanIds = [...new Set(dueInstallments.map((i) => i.loanId))]
    const dueLoans = loanIds.length ? await db.loan.findMany({ where: { id: { in: loanIds }, vendorId: ctx.vendorId } }) : []
    const loanInstallmentsDue = showLoans
      ? dueInstallments.map((i) => ({
          loanId: i.loanId, employeeName: employees.find((e) => e.id === dueLoans.find((l) => l.id === i.loanId)?.employeeId)?.fullName || "—",
          no: i.no, amount: i.amount, dueDate: i.dueDate,
        }))
      : null

    // performance review due (cycles ending within 14 days — spec §16.5)
    // MULTI-COMPANY — review cycles are the ACTIVE company's
    const reviewCycles = await db.reviewCycle.findMany({ where: { vendorId: ctx.vendorId, status: "ACTIVE", ...(ctx.activeCompanyId && !ctx.allCompaniesMode ? { companyId: ctx.activeCompanyId } : {}) } })
    const performanceReviewDue = reviewCycles
      .filter((c) => c.endDate && c.endDate >= t && c.endDate <= addDays(t, 14))
      .map((c) => ({ id: c.id, name: c.name, endDate: c.endDate }))

    // birthdays & anniversaries
    const mmdd = t.slice(5)
    // RPT-01 — REAL next-occurrence date arithmetic (the old month-day tuple
    // filter required dob-md >= today AND dob-md <= today simultaneously —
    // provably always empty — and its +=1231 "wrap" broke year boundaries):
    // build the next birthday after today on the actual calendar (Feb 29
    // celebrates Feb 28 in non-leap years) and keep it within 7 days.
    const todayBirthdays = employees.filter((e) => e.dob && e.dob.slice(5) === mmdd)
    const upcomingBirthdays = employees
      .filter((e): e is typeof e & { dob: string } => !!e.dob)
      .map((e) => {
        const md = e.dob.slice(5)
        let y = Number(t.slice(0, 4))
        let next = `${y}-${md}`
        if (next < t) next = `${++y}-${md}`
        // Feb 29 in a non-leap year → celebrate Feb 28
        if (md === "02-29" && !((y % 4 === 0 && y % 100 !== 0) || y % 400 === 0)) next = `${y}-02-28`
        const days = Math.round((Date.parse(next) - Date.parse(t)) / 86400000)
        return { e, next, days }
      })
      .filter((x) => x.days >= 0 && x.days <= 7)
      .sort((a, b) => a.days - b.days)
      .slice(0, 8)
    const anniversaries = employees.filter((e) => e.joiningDate && e.joiningDate.slice(5) === mmdd)

    // payroll trends (last 6 months) — FIN-022: payroll money, gated
    const trendRuns = showPayroll ? runs.filter((r) => r.status === "PAID").slice(0, 6).reverse() : []
    const payrollTrend = showPayroll ? trendRuns.map((r) => ({ period: `${monthName(r.periodMonth).slice(0, 3)} ${String(r.periodYear).slice(2)}`, gross: r.totalGross, net: r.totalNet })) : null

    // headcount trend by joining minus exits by month (resignation LWDs)
    // RPT-03 — exits are counted IN THE MONTH THEY OCCURRED (the old code
    // added the ALL-TIME terminated count to every historical month,
    // understating every past month whenever any termination existed). Exit
    // month: the resignation LWD when recorded, else the status-update month
    // (the same rule the headcountMovement report uses).
    const exits = await db.resignation.findMany({ where: { vendorId: ctx.vendorId, status: { in: ["ACCEPTED", "COMPLETED"] } } })
    const lwdByEmp = new Map<string, string>()
    for (const r of exits) lwdByEmp.set(r.employeeId, r.actualLwd || r.proposedLwd || "")
    const exitMonths = employees
      .filter((e) => ["RESIGNED", "TERMINATED", "RETIRED"].includes(e.status))
      .map((e) => lwdByEmp.get(e.id) || e.updatedAt?.toISOString().slice(0, 7) || "")
      .filter(Boolean)
    const headcountTrend = Array.from({ length: 6 }, (_, i) => {
      const d = new Date()
      d.setMonth(d.getMonth() - (5 - i))
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`
      const joined = employees.filter((e) => e.joiningDate && e.joiningDate.slice(0, 7) <= key).length
      const exited = exitMonths.filter((m) => m <= key).length
      return { period: `${monthName(d.getMonth() + 1).slice(0, 3)}`, value: Math.max(0, joined - exited) }
    })

    // ---- 2026-10 dashboard expansion data ----
    // upcoming APPROVED leaves (next 7 days) — "Upcoming Leaves" widget
    const upcomingLeaveRows = await db.leaveRequest.findMany({
      where: { vendorId: ctx.vendorId, status: "APPROVED", fromDate: { gte: t, lte: weekAhead } },
      orderBy: { fromDate: "asc" }, take: 12,
    })
    const leaveTypeMap = new Map<string, string>()
    if (upcomingLeaveRows.length) {
      const ids = [...new Set(upcomingLeaveRows.map((l) => l.leaveTypeId).filter(Boolean))] as string[]
      // MULTI-COMPANY — leave-type names resolve inside the ACTIVE company
      const lts = ids.length ? await db.leaveType.findMany({ where: { id: { in: ids }, ...(ctx.activeCompanyId && !ctx.allCompaniesMode ? { companyId: ctx.activeCompanyId } : {}) }, select: { id: true, name: true } }) : []
      for (const lt of lts) leaveTypeMap.set(lt.id, lt.name)
    }
    const upcomingLeaves = upcomingLeaveRows.map((l) => ({
      id: l.id, employeeId: l.employeeId,
      name: employees.find((e) => e.id === l.employeeId)?.fullName || "—",
      type: leaveTypeMap.get(l.leaveTypeId) || "Leave",
      fromDate: l.fromDate, toDate: l.toDate, days: l.days,
    }))
    // overtime this month — "Overtime This Month" widget
    const overtimeMonth = {
      minutes: monthAtt.reduce((s, a) => s + (a.overtimeMinutes || 0), 0),
      employees: new Set(monthAtt.filter((a) => (a.overtimeMinutes || 0) > 0).map((a) => a.employeeId)).size,
    }
    // low stock — "Low Stock Alerts" widget (items at/below reorder level)
    // MULTI-COMPANY — low stock watches the ACTIVE company's items
    const stockItems = await db.item.findMany({ where: { vendorId: ctx.vendorId, active: true, ...(ctx.activeCompanyId && !ctx.allCompaniesMode ? { companyId: ctx.activeCompanyId } : {}) }, select: { id: true, name: true, code: true, reorderLevel: true } })
    const stockLevels = await db.stockLevel.findMany({ where: { vendorId: ctx.vendorId }, select: { itemId: true, quantity: true, reserved: true } })
    const qtyByItem = new Map<string, number>()
    for (const s of stockLevels) qtyByItem.set(s.itemId, (qtyByItem.get(s.itemId) || 0) + (s.quantity || 0))
    const lowStock = stockItems
      .filter((it) => (it.reorderLevel || 0) > 0 && (qtyByItem.get(it.id) || 0) <= it.reorderLevel)
      .slice(0, 10)
      .map((it) => ({ id: it.id, name: it.name, code: it.code, quantity: Math.round(qtyByItem.get(it.id) || 0), reorderLevel: it.reorderLevel }))
    // pending procurement — "Pending Procurement" widget
    // MULTI-COMPANY — procurement counts are the ACTIVE company's requests
    const pendingProcurement = await db.purchaseRequest.count({
      where: { vendorId: ctx.vendorId, status: { in: ["PENDING", "APPROVED", "PENDING_STOCK_ENTRY"] }, ...(ctx.activeCompanyId && !ctx.allCompaniesMode ? { companyId: ctx.activeCompanyId } : {}) },
    })
    // pending expense value — "Expense Summary" widget
    // FIN-022 (Phase 2) — expense money is gated by expenses.view
    const pendingExpenseAgg = showExpenses
      ? await db.expenseClaim.aggregate({ where: { vendorId: ctx.vendorId, status: "PENDING" }, _sum: { amount: true } })
      : null
    const expensesMonth = showExpenses ? { pendingCount: pending.expenses, pendingAmount: pendingExpenseAgg?._sum.amount || 0 } : null
    // attendance device fleet health — "Device Health" widget
    // MULTI-COMPANY — device health covers the ACTIVE company's fleet
    const devices = await db.attendanceDevice.findMany({
      where: { vendorId: ctx.vendorId, enabled: true, ...(ctx.activeCompanyId && !ctx.allCompaniesMode ? { companyId: ctx.activeCompanyId } : {}) },
      select: { status: true, lastAttendanceAt: true },
    })
    const deviceHealth = {
      online: devices.filter((d) => d.status === "ONLINE").length,
      offline: devices.filter((d) => d.status !== "ONLINE").length,
      total: devices.length,
      lastEventAt: devices.reduce<string | null>((acc, d) => {
        if (!d.lastAttendanceAt) return acc
        const s = d.lastAttendanceAt.toISOString()
        return !acc || s > acc ? s : acc
      }, null),
    }
    // recent joiners (30d) — "New Joiners" widget
    const newJoinersRaw = employees
      .filter((e) => e.joiningDate && daysBetween(e.joiningDate, t) <= 30 && daysBetween(e.joiningDate, t) >= 0)
      .sort((a, b) => ((a.joiningDate || "") < (b.joiningDate || "") ? 1 : -1))
      .slice(0, 8)
    // PERF-01 — avatar hydration for ONLY the displayed widget rows (the
    // birthday board and the new-joiners strip), never the whole roster
    const avatarIds = [...new Set([
      ...todayBirthdays.map((e) => e.id),
      ...newJoinersRaw.map((e) => e.id),
    ])]
    const dashPhotos = new Map<string, string>()
    if (avatarIds.length) {
      const photoRows = await db.employee.findMany({
        where: { id: { in: avatarIds } },
        select: { id: true, photoThumb: true, photoUrl: true },
      })
      for (const p of photoRows) dashPhotos.set(p.id, (p.photoThumb || p.photoUrl) || "")
    }
    const newJoiners = newJoinersRaw.map((e) => ({ id: e.id, name: e.fullName, joiningDate: e.joiningDate, photoUrl: photoOf(e.id) }))

    const result = {
      workforce, byBranch, byDepartment, byDesignation, byGender, byEmploymentType,
      attendanceToday, payroll, loan,
      pending, repeatedLate, longAbsence, missingAttendance, loanInstallmentsDue, performanceReviewDue,
      expiringDocs: expiringDocs.map((d) => ({ id: d.id, employeeId: d.employeeId, name: employees.find((e) => e.id === d.employeeId)?.fullName || "—", docType: d.docType, title: d.title, expiryDate: d.expiryDate })),
      contractExpiry: contractExpiry.map((e) => ({ id: e.id, name: e.fullName, contractEnd: e.contractEnd })),
      probationCompletion: probationCompletion.map((e) => ({ id: e.id, name: e.fullName, joiningDate: e.joiningDate, probationMonths: e.probationMonths })),
      todayBirthdays: todayBirthdays.map((e) => ({ id: e.id, name: e.fullName, photoUrl: photoOf(e.id) })),
      upcomingBirthdays: upcomingBirthdays.map(({ e, next, days }) => ({ id: e.id, name: e.fullName, date: next, days })),
      anniversaries: anniversaries.map((e) => ({ id: e.id, name: e.fullName, years: t.slice(0, 4) !== e.joiningDate?.slice(0, 4) ? Number(t.slice(0, 4)) - Number(e.joiningDate?.slice(0, 4)) : 0 })),
      payrollTrend, headcountTrend,
      // 2026-10 dashboard expansion fields
      upcomingLeaves, overtimeMonth, lowStock, pendingProcurement, expensesMonth, deviceHealth, newJoiners,
      // active resignations in notice
      noticePeriod: (await db.resignation.findMany({ where: { vendorId: ctx.vendorId, status: "NOTICE_PERIOD" } })).map((r) => {
        const emp = employees.find((e) => e.id === r.employeeId)
        return { id: r.id, name: emp?.fullName || "—", lwd: r.actualLwd || r.proposedLwd, mode: r.noticeMode }
      }),
    }
    // L-28 — remember for the TTL window (single-instance in-process cache)
    if (dashboardMemo.size > 200) dashboardMemo.clear()
    dashboardMemo.set(memoKey, { at: Date.now(), value: result })
    return result
  },
})

// ================= REPORTS (spec §17.1–17.5) =================
/** Wave 4 WP-A — REPORT KEYS registry. Every reportRoute() lands its handler
 *  here so (a) reports.templates.save can reject unknown report keys and
 *  (b) the scheduled-delivery engine (scheduled-reports.ts) can render ANY
 *  registered report for a vendor through the exact same code path the RPC
 *  dispatcher uses — one render implementation, zero forks. */
const reportHandlers = new Map<string, (ctx: any, p: any) => Promise<{ columns: string[]; rows: any[][]; meta?: any }>>()

/** RPT-001 (Wave R3-3) — report keys whose content is bulk PII. The pii flag
 *  used to live only inside reportRoute's closure (driving the CSV twin's
 *  perm/confirm gate); the template scheduler and the client XLSX path had
 *  NO way to know a report was PII-class. Now the registry exposes it. */
const reportPiiKeys = new Set<string>()

/** True when the registered report key is PII-class (bulk personal data). */
export function isPiiReportKey(key: string): boolean {
  return reportPiiKeys.has(key)
}

/** R-02 (W1) — the consolidated REPORTS lane admission check.
 * A `reports.<key>` / `reports.<key>Csv` action is admitted in All Companies
 * mode ONLY when the FULL action name parses STRICTLY as
 * `^reports\.([a-zA-Z0-9_]+?)(Csv)?$` AND the parsed key is a REGISTERED
 * report key. No prefix tests, no substring tricks (`reports.employeesX`),
 * no dotted sub-keys (`reports.a.b`), no unregistered names. PII-class keys
 * (isPiiReportKey — e.g. employeesBiodata) parse and register, so the
 * dispatcher admits them to the lane and the reportRoute wrapper denies
 * them IN-HANDLER with a mode-specific message — the denial is a deliberate,
 * testable contract, not a parse accident. */
export function isConsolidatedReportAction(action: string): boolean {
  const m = /^reports\.([a-zA-Z0-9_]+?)(Csv)?$/.exec(action)
  if (!m) return false
  return reportHandlers.has(m[1])
}

/** RPT-10 — every registered reportRoute key (drives the AI-catalogue
 *  coverage check so a new report can never silently miss its NL entry). */
export function registeredReportKeys(): string[] {
  return [...reportHandlers.keys()]
}

const reportRoute = (key: string, fn: (ctx: any, p: any) => Promise<{ columns: string[]; rows: any[][]; meta?: any }>, opts: { pii?: boolean } = {}) => {
  // Reports overhaul (tier gate) — BOTH the on-screen twin and the CSV twin
  // enforce the report's subscription tier before the handler runs. The
  // wrapper also covers the scheduler + AI render paths (they call the
  // registered handler directly): it only needs ctx.vendorId, and LEGACY
  // vendors (no subscription row) pass untouched.
  const gated = async (ctx: any, p: any) => {
    // R-02 (W1) — in All Companies mode, PII-class report content is denied
    // IN-HANDLER (both twins route through this wrapper): the consolidated
    // context is for aggregates and governance, never bulk personal data.
    // Matrix §3.18 / W1-AC-04.
    if (ctx?.allCompaniesMode === true && opts.pii) {
      throw new Deny(`The "${key}" report contains bulk personal data and is not available in All Companies mode. Switch to a specific company to run it.`, 403)
    }
    await assertReportEntitlement(ctx, key)
    return fn(ctx, p)
  }
  reportHandlers.set(key, gated)
  if (opts.pii) reportPiiKeys.add(key)
  // FIN-081 (Phase 1) — PII-class reports require reports.pii.view to
  // render ON SCREEN, enforced in this factory (server-side) rather than by
  // hiding buttons: previously any reports.view holder could open biodata
  // on screen and only the EXPORT twin was gated. The six-permission split:
  // view · pii.view · export · pii.export · schedule · pii.schedule; the
  // legacy flat reports.pii expands to the three split verbs in
  // getCtxFromToken, so pre-split grants keep working unchanged.
  // Reports overhaul (bug found by phase4 tests) — the ON-SCREEN twin now
  // runs the GATED wrapper too: it was registered with the raw handler, so
  // the tier gate silently applied only to the CSV twin (and the scheduler/
  // AI paths) while reports.<key> kept serving advanced reports to tenants
  // without ADVANCED_REPORTS — the opposite of what the wrapper's own
  // contract comment promises ("BOTH twins enforce the tier").
  route(`reports.${key}`, { perm: opts.pii ? ["reports", "pii.view"] : ["reports", "view"], handler: gated })
  route(`reports.${key}Csv`, {
    // HIGH-11 (this audit) — PII exports require typed confirmation + an
    // additional `reports.pii.export` permission gate. The previous single-permission
    // gate allowed any user with `reports.export` to download bulk PII
    // (father/mother name, blood group, marital status, NID-adjacent fields).
    // Mirrors the typed-confirmation pattern used by `employees.hardDelete`.
    perm: opts.pii ? ["reports", "pii.export"] : ["reports", "export"],
    handler: async (ctx, p) => {
      if (opts.pii && p?.confirm !== "EXPORT") {
        throw new Deny(
          "Bulk PII export requires typed confirmation — re-submit with payload.confirm === \"EXPORT\". " +
          "This audit row is recorded with the operator identity and reason.",
          400,
        )
      }
      // M-9 — PII report exports are audited exactly like their on-screen twins
      await audit(ctx, `reports.${key}.csvExport`, "Report", null,
        `Exported ${key} report as CSV${opts.pii ? " (PII)" : ""}`)
      const { columns, rows } = await gated(ctx, p)
      return { csv: csv([columns, ...rows]) }
    },
  })
}

/** Reports overhaul — the shared subscription-tier gate: advanced-tier
 *  reports require the ADVANCED_REPORTS plan feature. resolveEntitlements →
 *  requireFeature throws EntitlementError (numeric code 403) which the RPC
 *  dispatcher already maps to an HTTP 403 with the upgrade message — the
 *  exact pattern leave.ts / fieldforce.ts use for ESS / FIELD_FORCE. LEGACY
 *  vendors (no SaasSubscription row) resolve every feature on, so existing
 *  deployments and the unit-test worlds keep full access.
 *  Exported for the scheduled-delivery engine (scheduled-reports.ts) so the
 *  scheduler's NATIVE structured lane is tier-gated exactly like the
 *  interactive surfaces (legacy keys are gated by the reportRoute factory
 *  wrapper; natives had no gate until this export). */
export async function assertReportEntitlement(ctx: { vendorId: string }, reportId: string): Promise<void> {
  const meta = reportMetaOf(reportId)
  if (meta.tier === "advanced") await requireFeature(ctx.vendorId, "ADVANCED_REPORTS")
}

/** Shared server-side scoping: employee filters (branch/department) + RBAC scope. */
async function scopedEmployees(ctx: any, p: any) {
  const where: any = employeeScopeFilter(ctx)
  if (p?.branchId) where.branchId = p.branchId
  if (p?.departmentId) where.departmentId = p.departmentId
  if (p?.employmentType) where.employmentType = p.employmentType
  if (p?.status) where.status = p.status
  // RPT-04 — the Employee filter the report bar OFFERS is now APPLIED (the
  // old signature accepted employeeId and silently ignored it for every
  // report fed by this helper — ~80% of the catalog).
  if (p?.employeeId) where.id = p.employeeId
  return db.employee.findMany({ where, orderBy: { code: "asc" } })
}
function monthPrefixOf(p: any) {
  const month = Number(p?.month || new Date().getUTCMonth() + 1)
  const year = Number(p?.year || new Date().getUTCFullYear())
  return { month, year, prefix: `${year}-${String(month).padStart(2, "0")}` }
}

// ---- Reports overhaul (3d) — the advertised filter vocabulary → the ----
// ---- validated `filters` spec carried on every report definition.      ----
// Enums ONLY where the domain is genuinely closed (the option lists below
// are the values the handlers + Prisma models actually store); id lookups
// are "ref"; from/to are "date". Numeric/boolean fields without a closed
// domain (year, withinDays, percent, eligibleOnly) are advertised through
// `filterFields` only — never enum-validated. month is a 1-12 number in the
// handlers (monthPrefixOf → Number(p.month)), so its enum values are the
// numeric spellings, which the route zod schemas already constrain to int
// 1-12 — validateFilters compares String(raw) against the option values.
const filterOptions = (values: string[]): { value: string; label: string }[] =>
  values.map((v) => ({ value: v, label: titleCase(v.replace(/_/g, " ")) }))

const MONTH_FILTER_OPTIONS = Array.from({ length: 12 }, (_, i) => ({ value: String(i + 1), label: monthName(i + 1) }))
const ATTENDANCE_STATUSES = ["PRESENT", "ABSENT", "LATE", "EARLY_LEAVE", "HALF_DAY", "LEAVE", "LEAVE_UNPAID", "HOLIDAY", "WEEKLY_OFF", "WFH", "BUSINESS_TRIP"]
const OT_APPROVAL_STATUSES = ["APPROVED", "PENDING"]
const EMPLOYEE_STATUSES = ["ACTIVE", "PROBATION", "ON_LEAVE", "SUSPENDED", "RESIGNED", "TERMINATED", "RETIRED", "INACTIVE"]
const EMPLOYMENT_TYPES = ["PERMANENT", "PROBATIONARY", "CONTRACTUAL", "TEMPORARY", "PART_TIME", "INTERN", "COMMISSION", "FREELANCE"]
const LEAVE_STATUSES = ["PENDING", "APPROVED", "REJECTED", "CANCELLED", "WITHDRAWN"]
const LOAN_STATUSES = ["PENDING", "APPROVED", "REJECTED", "ACTIVE", "CLOSED"]
const ADVANCE_STATUSES = ["PENDING", "APPROVED", "REJECTED", "RECOVERING", "RECOVERED"]
const EXPENSE_STATUSES = ["PENDING", "APPROVED", "REJECTED", "REIMBURSED"]
const ASSET_STATUSES = ["Issued", "Returned", "Overdue"]
const RUN_TYPES = ["REGULAR", "ADJUSTMENT"]
const LIFECYCLE_EVENT_TYPES = ["JOINED", "PROMOTION", "TRANSFER", "SALARY_REVISION", "STATUS_CHANGE", "LEAVE", "RESIGNATION", "LETTER", "WARNING", "EXIT", "TASK", "REVIEW"]

/** Which status vocabulary THIS report's `status` filter actually hits
 *  (attendance rows, employee rows, claims, loans… — read off each handler). */
function statusOptionsFor(key: string): { value: string; label: string }[] {
  if (key === "attendance") return filterOptions(ATTENDANCE_STATUSES)
  if (key === "attendanceOvertime") return filterOptions(OT_APPROVAL_STATUSES)
  if (key.startsWith("attendance")) return filterOptions(EMPLOYEE_STATUSES) // scopedEmployees → employee status
  if (key === "leave") return filterOptions(LEAVE_STATUSES)
  if (key === "loans") return filterOptions(LOAN_STATUSES)
  if (key === "advances") return filterOptions(ADVANCE_STATUSES)
  if (key === "expenses") return filterOptions(EXPENSE_STATUSES)
  if (key === "assetAssignments") return ASSET_STATUSES.map((v) => ({ value: v, label: v }))
  return filterOptions(EMPLOYEE_STATUSES)
}

/** The closed dimension list per dimensioned report (headcount vs demographics). */
function dimensionOptionsFor(key: string): { value: string; label: string }[] {
  if (key === "demographics") {
    return ["gender", "bloodGroup", "maritalStatus", "religion"].map((v) => ({ value: v, label: titleCase(v === "bloodGroup" ? "blood group" : v === "maritalStatus" ? "marital status" : v) }))
  }
  if (key === "workforce.dashboard") {
    return [{ value: "department", label: "By department" }, { value: "branch", label: "By branch" }]
  }
  return [
    { value: "branch", label: "By branch" },
    { value: "department", label: "By department" },
    { value: "status", label: "By status" },
    { value: "employmentType", label: "By employment type" },
  ]
}

/** Convert a report's advertised ReportFilterField vocabulary into the
 *  definition's validated `filters` spec (see the block comment above). */
function filterSpecOf(key: string, meta: ReportMeta): ReportDefinition["filters"] {
  const out: NonNullable<ReportDefinition["filters"]> = {}
  for (const f of meta.filters) {
    switch (f) {
      case "month": out.month = { type: "enum", options: MONTH_FILTER_OPTIONS }; break
      case "status": out.status = { type: "enum", options: statusOptionsFor(key) }; break
      case "employmentType": out.employmentType = { type: "enum", options: filterOptions(EMPLOYMENT_TYPES) }; break
      case "dimension": {
        const options = dimensionOptionsFor(key)
        out.dimension = key === "workforce.dashboard"
          ? { type: "enum", default: "department", options }
          : key === "workforce.headcount"
            ? { type: "enum", default: "branch", options }
            : { type: "enum", options }
        break
      }
      case "eventType": out.eventType = { type: "enum", options: filterOptions(LIFECYCLE_EVENT_TYPES) }; break
      case "runType": out.runType = { type: "enum", options: filterOptions(RUN_TYPES) }; break
      case "basis": out.basis = { type: "enum", options: [{ value: "basic", label: "Basic" }, { value: "gross", label: "Gross" }] }; break
      case "divisor": out.divisor = { type: "enum", options: [{ value: "26", label: "26 (factory convention)" }, { value: "30", label: "30 (BLA daily-rate convention)" }] }; break
      case "from": case "to": out[f] = { type: "date" }; break
      case "branchId": case "departmentId": case "employeeId": case "cycleId": out[f] = { type: "ref" }; break
      // year / withinDays / percent / eligibleOnly — open numeric/boolean
      // domains: advertised via filterFields only, never enum-validated.
      default: break
    }
  }
  return out
}

// ---------- §17.1 Employee reports ----------
reportRoute("employees", async (ctx, p) => {
  const emps = await scopedEmployees(ctx, p)
  // MULTI-COMPANY — org-name decoration resolves inside the ACTIVE company
  const branches = await db.branch.findMany({ where: { vendorId: ctx.vendorId, ...(ctx.activeCompanyId && !ctx.allCompaniesMode ? { companyId: ctx.activeCompanyId } : {}) } })
  const depts = await db.department.findMany({ where: { vendorId: ctx.vendorId, ...(ctx.activeCompanyId && !ctx.allCompaniesMode ? { companyId: ctx.activeCompanyId } : {}) } })
  const desigs = await db.designation.findMany({ where: { vendorId: ctx.vendorId, ...(ctx.activeCompanyId && !ctx.allCompaniesMode ? { companyId: ctx.activeCompanyId } : {}) } })
  return {
    columns: ["Code", "Name", "Branch", "Department", "Designation", "Type", "Status", "Joining", "Mobile"],
    rows: emps.map((e) => [
      e.code, e.fullName,
      branches.find((b) => b.id === e.branchId)?.name || "—",
      depts.find((d) => d.id === e.departmentId)?.name || "—",
      desigs.find((d) => d.id === e.designationId)?.name || "—",
      titleCase(e.employmentType), titleCase(e.status), e.joiningDate || "—", e.mobile || "—",
    ]),
    meta: { count: emps.length },
  }
})

// HIGH-11 — mark this PII-sensitive report so the CSV export requires typed
// confirmation (p.confirm === "EXPORT") and the additional reports.pii perm.
reportRoute("employeesBiodata", async (ctx, p) => {
  const emps = await scopedEmployees(ctx, p)
  // MULTI-COMPANY — org-name decoration resolves inside the ACTIVE company
  const depts = await db.department.findMany({ where: { vendorId: ctx.vendorId, ...(ctx.activeCompanyId && !ctx.allCompaniesMode ? { companyId: ctx.activeCompanyId } : {}) } })
  const desigs = await db.designation.findMany({ where: { vendorId: ctx.vendorId, ...(ctx.activeCompanyId && !ctx.allCompaniesMode ? { companyId: ctx.activeCompanyId } : {}) } })
  return {
    columns: ["Code", "Name", "Name (Bangla)", "Father", "Mother", "DOB", "Gender", "Blood", "Marital", "Mobile", "Email", "Nationality", "Division", "District", "Designation", "Department", "Joining", "Type", "Status"],
    rows: emps.map((e) => [
      e.code, e.fullName, e.nameBn || "—", e.fatherName || "—", e.motherName || "—", e.dob || "—",
      e.gender || "—", e.bloodGroup || "—", e.maritalStatus || "—", e.mobile || "—",
      e.officialEmail || e.personalEmail || "—", e.nationality, e.division || "—", e.district || "—",
      desigs.find((d) => d.id === e.designationId)?.name || "—",
      depts.find((d) => d.id === e.departmentId)?.name || "—",
      e.joiningDate || "—", titleCase(e.employmentType), titleCase(e.status),
    ]),
    meta: { count: emps.length },
  }
}, { pii: true })

reportRoute("employeesDirectory", async (ctx, p) => {
  const emps = await scopedEmployees(ctx, p)
  // MULTI-COMPANY — org-name decoration resolves inside the ACTIVE company
  const branches = await db.branch.findMany({ where: { vendorId: ctx.vendorId, ...(ctx.activeCompanyId && !ctx.allCompaniesMode ? { companyId: ctx.activeCompanyId } : {}) } })
  const depts = await db.department.findMany({ where: { vendorId: ctx.vendorId, ...(ctx.activeCompanyId && !ctx.allCompaniesMode ? { companyId: ctx.activeCompanyId } : {}) } })
  const desigs = await db.designation.findMany({ where: { vendorId: ctx.vendorId, ...(ctx.activeCompanyId && !ctx.allCompaniesMode ? { companyId: ctx.activeCompanyId } : {}) } })
  return {
    columns: ["Code", "Name", "Designation", "Department", "Branch", "Mobile", "Email"],
    rows: emps.map((e) => [
      e.code, e.fullName,
      desigs.find((d) => d.id === e.designationId)?.name || "—",
      depts.find((d) => d.id === e.departmentId)?.name || "—",
      branches.find((b) => b.id === e.branchId)?.name || "—",
      e.mobile || "—", e.officialEmail || e.personalEmail || "—",
    ]),
    meta: { count: emps.length },
  }
})

reportRoute("employeesNewJoiners", async (ctx, p) => {
  const from = p?.from || addDays(today(), -30)
  const to = p?.to || today()
  const where: any = employeeScopeFilter(ctx)
  where.joiningDate = { gte: from, lte: to }
  if (p?.branchId) where.branchId = p.branchId
  if (p?.departmentId) where.departmentId = p.departmentId
  // Reports overhaul (3j) — the employmentType/status filters the report bar
  // offers are now applied (same semantics as scopedEmployees; absent ⇒ the
  // previous behavior, byte-for-byte).
  if (p?.employmentType) where.employmentType = p.employmentType
  if (p?.status) where.status = p.status
  const emps = await db.employee.findMany({ where, orderBy: { joiningDate: "desc" } })
  // MULTI-COMPANY — org-name decoration resolves inside the ACTIVE company
  const depts = await db.department.findMany({ where: { vendorId: ctx.vendorId, ...(ctx.activeCompanyId && !ctx.allCompaniesMode ? { companyId: ctx.activeCompanyId } : {}) } })
  const desigs = await db.designation.findMany({ where: { vendorId: ctx.vendorId, ...(ctx.activeCompanyId && !ctx.allCompaniesMode ? { companyId: ctx.activeCompanyId } : {}) } })
  return {
    columns: ["Code", "Name", "Designation", "Department", "Joining", "Type"],
    rows: emps.map((e) => [
      e.code, e.fullName,
      desigs.find((d) => d.id === e.designationId)?.name || "—",
      depts.find((d) => d.id === e.departmentId)?.name || "—",
      e.joiningDate || "—", titleCase(e.employmentType),
    ]),
    meta: { count: emps.length, from, to },
  }
})

reportRoute("employeesExits", async (ctx, p) => {
  const where: any = employeeScopeFilter(ctx)
  where.status = { in: ["RESIGNED", "TERMINATED", "RETIRED"] }
  if (p?.branchId) where.branchId = p.branchId
  // Reports overhaul (3j) — departmentId applies via the employee relation.
  if (p?.departmentId) where.departmentId = p.departmentId
  const emps = await db.employee.findMany({ where, orderBy: { updatedAt: "desc" } })
  const resignations = await db.resignation.findMany({ where: { vendorId: ctx.vendorId, status: { in: ["ACCEPTED", "COMPLETED"] } } })
  // MULTI-COMPANY — org-name decoration resolves inside the ACTIVE company
  const depts = await db.department.findMany({ where: { vendorId: ctx.vendorId, ...(ctx.activeCompanyId && !ctx.allCompaniesMode ? { companyId: ctx.activeCompanyId } : {}) } })
  // Reports overhaul (3j) — from/to apply on the exit date the report itself
  // displays (resignation actualLwd || proposedLwd). Exits without a recorded
  // LWD cannot be placed in a range and are excluded when a bound is given;
  // absent bounds keep the previous behavior (all exits).
  const exitDateOf = (empId: string): string | null => {
    const r = resignations.find((x) => x.employeeId === empId)
    return r?.actualLwd || r?.proposedLwd || null
  }
  const inRange = (empId: string): boolean => {
    if (!p?.from && !p?.to) return true
    const d = exitDateOf(empId)
    if (!d) return false
    if (p?.from && d < String(p.from)) return false
    if (p?.to && d > String(p.to)) return false
    return true
  }
  const scoped = emps.filter((e) => inRange(e.id))
  return {
    columns: ["Code", "Name", "Department", "Status", "Exit Type", "Last Working Day", "Reason"],
    rows: scoped.map((e) => {
      const r = resignations.find((x) => x.employeeId === e.id)
      return [
        e.code, e.fullName,
        depts.find((d) => d.id === e.departmentId)?.name || "—",
        titleCase(e.status),
        e.status === "RESIGNED" ? (r?.noticeMode ? `Resignation (${r.noticeMode.toLowerCase()} notice)` : "Resignation") : titleCase(e.status),
        r?.actualLwd || r?.proposedLwd || "—",
        r?.reason || "—",
      ]
    }),
    meta: { count: scoped.length, ...(p?.from ? { from: String(p.from) } : {}), ...(p?.to ? { to: String(p.to) } : {}) },
  }
})

reportRoute("employeesLifecycle", async (ctx, p) => {
  const where: any = employeeScopeFilter(ctx)
  if (p?.branchId) where.branchId = p.branchId
  // Reports overhaul (3j) — departmentId applies via the employee relation.
  if (p?.departmentId) where.departmentId = p.departmentId
  const emps = await db.employee.findMany({ where, select: { id: true, code: true, fullName: true } })
  const events = await db.employeeHistory.findMany({
    where: { vendorId: ctx.vendorId, employeeId: { in: emps.map((e) => e.id) }, ...(p?.eventType ? { eventType: p.eventType } : {}) },
    orderBy: { createdAt: "desc" }, take: 500,
  })
  // Reports overhaul (3j) — month/year apply on the event date the report
  // displays (effectiveDate, falling back to the record's createdAt); absent
  // ⇒ every event, the previous behavior.
  const eventDateOf = (h: { effectiveDate: string | null; createdAt: Date }): string =>
    h.effectiveDate || h.createdAt.toISOString().slice(0, 10)
  const monthOf = (d: string): string => d.slice(5, 7)
  const scoped = events.filter((h) => {
    const d = eventDateOf(h)
    if (p?.year != null && !d.startsWith(String(p.year))) return false
    if (p?.month != null && monthOf(d) !== String(Number(p.month)).padStart(2, "0")) return false
    return true
  })
  return {
    columns: ["Date", "Employee", "Event", "Title", "Detail"],
    rows: scoped.map((h) => [
      eventDateOf(h),
      emps.find((e) => e.id === h.employeeId)?.fullName || "—",
      h.eventType, h.title, h.description || "—",
    ]),
    meta: { count: scoped.length },
  }
})

// ---------- §17.2 Attendance reports ----------
async function scopedAttendance(ctx: any, p: any, extra: any = {}) {
  const { prefix } = monthPrefixOf(p)
  const where: any = { vendorId: ctx.vendorId, date: { startsWith: prefix }, ...extra }
  const emps = await scopedEmployees(ctx, p)
  // R-03 — a client-supplied employeeId must be inside the caller's effective
  // scope (role branch/dept + the active company's UserCompanyAccess
  // branchScope/departmentScope); the raw id used to bypass it and expose any
  // employee's attendance through every §17.2 attendance report.
  if (p?.employeeId) { await assertEmployeeVisible(ctx, p.employeeId); where.employeeId = p.employeeId }
  else where.employeeId = { in: emps.map((e) => e.id) }
  const records = await db.attendance.findMany({ where, orderBy: { date: "asc" } })
  return { records, emps, prefix }
}

reportRoute("attendance", async (ctx, p) => {
  const { records, emps } = await scopedAttendance(ctx, p, p?.status ? { status: p.status } : {})
  return {
    columns: ["Date", "Employee", "Status", "Check In", "Check Out", "Working (m)", "Late (m)", "OT (m)", "Source"],
    rows: records.map((r) => [
      r.date, emps.find((e) => e.id === r.employeeId)?.fullName || "—", titleCase(r.status),
      r.checkIn || "—", r.checkOut || "—", r.workingMinutes, r.lateMinutes, r.overtimeMinutes, r.source,
    ]),
    meta: { count: records.length },
  }
})

reportRoute("attendanceLate", async (ctx, p) => {
  const { records, emps } = await scopedAttendance(ctx, p, { lateMinutes: { gt: 0 } })
  return {
    columns: ["Date", "Employee", "Check In", "Late (m)", "Status"],
    rows: records.map((r) => [
      r.date, emps.find((e) => e.id === r.employeeId)?.fullName || "—", r.checkIn || "—", r.lateMinutes, titleCase(r.status),
    ]),
    meta: { count: records.length, totalLateMinutes: records.reduce((s, r) => s + r.lateMinutes, 0) },
  }
})

reportRoute("attendanceAbsence", async (ctx, p) => {
  const { records, emps } = await scopedAttendance(ctx, p, { status: "ABSENT" })
  return {
    columns: ["Date", "Employee"],
    rows: records.map((r) => [r.date, emps.find((e) => e.id === r.employeeId)?.fullName || "—"]),
    meta: { count: records.length },
  }
})

reportRoute("attendanceOvertime", async (ctx, p) => {
  // Reports overhaul (3j) — the status filter selects the OT approval state
  // the attendance rows actually store (otApproved: true = APPROVED,
  // false = PENDING). It must NOT leak into the employee query (that would
  // filter employees BY an attendance status), so it is stripped before
  // scopedAttendance and applied to the records instead.
  const { records, emps } = await scopedAttendance(ctx, { ...p, status: undefined }, { overtimeMinutes: { gt: 0 } })
  const scoped = p?.status === "APPROVED" ? records.filter((r) => r.otApproved === true)
    : p?.status === "PENDING" ? records.filter((r) => r.otApproved === false)
    : records
  const byEmp = new Map<string, number>()
  for (const r of scoped) byEmp.set(r.employeeId, (byEmp.get(r.employeeId) || 0) + r.overtimeMinutes)
  return {
    columns: ["Employee", "OT Days", "Total OT (h)", "OT (m)"],
    rows: [...byEmp.entries()].map(([id, mins]) => [
      emps.find((e) => e.id === id)?.fullName || "—",
      scoped.filter((r) => r.employeeId === id).length,
      Math.round((mins / 60) * 10) / 10, mins,
    ]),
    meta: { count: byEmp.size, totalOvertimeMinutes: scoped.reduce((s, r) => s + r.overtimeMinutes, 0) },
  }
})

reportRoute("attendanceWorkingHours", async (ctx, p) => {
  const { records, emps } = await scopedAttendance(ctx, p)
  const byEmp = new Map<string, { days: number; minutes: number }>()
  for (const r of records) {
    const cur = byEmp.get(r.employeeId) || { days: 0, minutes: 0 }
    cur.days += 1
    cur.minutes += r.workingMinutes || 0
    byEmp.set(r.employeeId, cur)
  }
  return {
    columns: ["Employee", "Days", "Total Hours", "Avg Hours/Day"],
    rows: [...byEmp.entries()].map(([id, v]) => [
      emps.find((e) => e.id === id)?.fullName || "—", v.days,
      Math.round((v.minutes / 60) * 10) / 10,
      v.days ? Math.round(((v.minutes / v.days) / 60) * 10) / 10 : 0,
    ]),
    meta: { count: byEmp.size },
  }
})

const attendanceGroupReport = (key: string, group: "branchId" | "departmentId") =>
  reportRoute(key, async (ctx, p) => {
    const { records, emps } = await scopedAttendance(ctx, p)
    // MULTI-COMPANY — the grouping axes are the ACTIVE company's org rows
    const groups = group === "branchId"
      ? await db.branch.findMany({ where: { vendorId: ctx.vendorId, ...(ctx.activeCompanyId && !ctx.allCompaniesMode ? { companyId: ctx.activeCompanyId } : {}) } })
      : await db.department.findMany({ where: { vendorId: ctx.vendorId, ...(ctx.activeCompanyId && !ctx.allCompaniesMode ? { companyId: ctx.activeCompanyId } : {}) } })
    const rows = groups.map((g) => {
      const members = emps.filter((e) => (e as any)[group] === g.id)
      const ids = new Set(members.map((m) => m.id))
      const recs = records.filter((r) => ids.has(r.employeeId))
      const present = recs.filter((r) => ["PRESENT", "LATE", "EARLY_LEAVE", "WFH", "BUSINESS_TRIP"].includes(r.status)).length
      return [
        g.name, members.length, recs.length, present,
        recs.filter((r) => r.status === "LATE").length,
        recs.filter((r) => r.status === "ABSENT").length,
        `${pct(present, recs.length || 1)}%`,
      ]
    })
    return {
      columns: [group === "branchId" ? "Branch" : "Department", "Employees", "Records", "Present", "Late", "Absent", "Attendance Rate"],
      rows,
      meta: { count: groups.length },
    }
  })
attendanceGroupReport("attendanceBranch", "branchId")
attendanceGroupReport("attendanceDepartment", "departmentId")

// ---------- §17.3 Leave reports ----------
reportRoute("leave", async (ctx, p) => {
  const emps = await scopedEmployees(ctx, p)
  const where: any = { vendorId: ctx.vendorId, employeeId: { in: emps.map((e) => e.id) } }
  if (p?.status) where.status = p.status
  if (p?.year) where.fromDate = { startsWith: String(p.year) }
  const reqs = await db.leaveRequest.findMany({ where, orderBy: { fromDate: "desc" } })
  // MULTI-COMPANY — leave-type names resolve inside the ACTIVE company
  const types = await db.leaveType.findMany({ where: { vendorId: ctx.vendorId, ...(ctx.activeCompanyId && !ctx.allCompaniesMode ? { companyId: ctx.activeCompanyId } : {}) } })
  return {
    columns: ["Employee", "Leave Type", "From", "To", "Days", "Status", "Substitute"],
    rows: reqs.map((r) => [
      emps.find((e) => e.id === r.employeeId)?.fullName || "—",
      types.find((t) => t.id === r.leaveTypeId)?.name || "—",
      r.fromDate, r.toDate, r.days, titleCase(r.status),
      emps.find((e) => e.id === r.substituteEmployeeId)?.fullName || "—",
    ]),
    meta: { count: reqs.length },
  }
})

reportRoute("leaveBalances", async (ctx, p) => {
  const year = Number(p?.year || new Date().getUTCFullYear())
  const emps = await scopedEmployees(ctx, p)
  // MULTI-COMPANY — the balance grid's type columns are the ACTIVE company's
  const types = await db.leaveType.findMany({ where: { vendorId: ctx.vendorId, active: true, ...(ctx.activeCompanyId && !ctx.allCompaniesMode ? { companyId: ctx.activeCompanyId } : {}) }, orderBy: { code: "asc" } })
  const balances = await db.leaveBalance.findMany({ where: { vendorId: ctx.vendorId, year, employeeId: { in: emps.map((e) => e.id) } } })
  const rows: any[][] = []
  for (const e of emps) {
    const cells = types.map((t) => {
      const b = balances.find((x) => x.employeeId === e.id && x.leaveTypeId === t.id)
      return b ? `${b.entitled - b.used - b.pending}/${b.entitled}` : `0/${t.defaultDays}`
    })
    rows.push([e.code, e.fullName, ...cells])
  }
  return {
    columns: ["Code", "Employee", ...types.map((t) => `${t.name} (rem/ent)`)],
    rows,
    meta: { count: emps.length, year },
  }
})

reportRoute("leaveUtilization", async (ctx, p) => {
  const year = Number(p?.year || new Date().getUTCFullYear())
  const emps = await scopedEmployees(ctx, p)
  // MULTI-COMPANY — utilization rows are the ACTIVE company's leave types
  const types = await db.leaveType.findMany({ where: { vendorId: ctx.vendorId, ...(ctx.activeCompanyId && !ctx.allCompaniesMode ? { companyId: ctx.activeCompanyId } : {}) } })
  const balances = await db.leaveBalance.findMany({ where: { vendorId: ctx.vendorId, year, employeeId: { in: emps.map((e) => e.id) } } })
  const byType = types.map((t) => {
    const bs = balances.filter((b) => b.leaveTypeId === t.id)
    const entitled = bs.reduce((s, b) => s + b.entitled, 0)
    const used = bs.reduce((s, b) => s + b.used, 0)
    return [t.name, bs.length, entitled, used, entitled - used, `${pct(used, entitled || 1)}%`]
  })
  return {
    columns: ["Leave Type", "Employees", "Entitled (d)", "Used (d)", "Remaining (d)", "Utilization"],
    rows: byType,
    meta: { year },
  }
})

reportRoute("leaveDepartment", async (ctx, p) => {
  const year = Number(p?.year || new Date().getUTCFullYear())
  const emps = await scopedEmployees(ctx, p)
  // MULTI-COMPANY — department axes + leave types are the ACTIVE company's
  const depts = await db.department.findMany({ where: { vendorId: ctx.vendorId, ...(ctx.activeCompanyId && !ctx.allCompaniesMode ? { companyId: ctx.activeCompanyId } : {}) } })
  const types = await db.leaveType.findMany({ where: { vendorId: ctx.vendorId, ...(ctx.activeCompanyId && !ctx.allCompaniesMode ? { companyId: ctx.activeCompanyId } : {}) } })
  const balances = await db.leaveBalance.findMany({ where: { vendorId: ctx.vendorId, year, employeeId: { in: emps.map((e) => e.id) } } })
  const rows = depts.map((d) => {
    const members = emps.filter((e) => e.departmentId === d.id)
    const bs = balances.filter((b) => members.some((m) => m.id === b.employeeId))
    const entitled = bs.reduce((s, b) => s + b.entitled, 0)
    const used = bs.reduce((s, b) => s + b.used, 0)
    return [d.name, members.length, entitled, used, `${pct(used, entitled || 1)}%`]
  })
  void types
  return {
    columns: ["Department", "Employees", "Entitled (d)", "Used (d)", "Utilization"],
    rows,
    meta: { year },
  }
})

// ---------- §17.4 Payroll & financial HR reports ----------
reportRoute("payroll", async (ctx, p) => {
  // RPT-07 — only payable runs, newest first: the old unfiltered findFirst
  // could render a CANCELLED or ADJUSTMENT run for the month (whichever row
  // happened to sort first), and p.periodWeek ? Number(p.periodWeek) : 0 also
  // forced the REGULAR run even when a specific week was requested via string.
  // Reports overhaul (3j) — an explicit runType selects that run type;
  // absent ⇒ REGULAR, the previous behavior.
  const periodWeek = p?.periodWeek != null && p.periodWeek !== "" ? Number(p.periodWeek) : 0
  // MULTI-COMPANY — the register renders the ACTIVE company's run for the period
  const run = await db.payrollRun.findFirst({
    where: { vendorId: ctx.vendorId, ...(ctx.activeCompanyId && !ctx.allCompaniesMode ? { companyId: ctx.activeCompanyId } : {}), periodMonth: Number(p?.month || 1), periodYear: Number(p?.year || new Date().getUTCFullYear()), periodWeek, status: { in: ["APPROVED", "PROCESSING", "PAID"] }, runType: p?.runType ? String(p.runType) : "REGULAR" },
    orderBy: [{ calcEpoch: "desc" }, { createdAt: "desc" }],
  })
  if (!run) return { columns: ["No data"], rows: [], meta: { run: null } }
  const emps = await scopedEmployees(ctx, p)
  const entries = await db.payrollEntry.findMany({ where: { runId: run.id, employeeId: { in: emps.map((e) => e.id) } }, orderBy: { net: "desc" } })
  return {
    columns: ["Employee", "Present", "Absent", "Gross", "OT", "Bonus", "Commission", "Deductions", "AIT", "Net"],
    rows: entries.map((e) => [
      emps.find((x) => x.id === e.employeeId)?.fullName || "—",
      e.presentDays, e.absentDays, e.gross, e.otAmount, e.bonus, e.commission,
      e.absenceDeduction + e.lateDeduction + e.loanDeduction + e.advanceDeduction + e.otherDeduction,
      e.ait, e.net,
    ]),
    meta: { count: entries.length, run: { id: run.id, status: run.status, totalNet: run.totalNet } },
  }
})

const payrollGroupReport = (key: string, group: "branchId" | "departmentId") =>
  reportRoute(key, async (ctx, p) => {
    // Reports overhaul (3j) — runType now selects the run(s): an explicit
    // runType (REGULAR | ADJUSTMENT) aggregates EVERY matching run of that
    // type (adjustment sequences 1..n) instead of whichever row happened to
    // sort first; absent ⇒ the legacy first-matching-run behavior unchanged.
    // MULTI-COMPANY — grouped payroll aggregates the ACTIVE company's runs
    const baseWhere: any = {
      vendorId: ctx.vendorId, ...(ctx.activeCompanyId && !ctx.allCompaniesMode ? { companyId: ctx.activeCompanyId } : {}), periodMonth: Number(p?.month || 1), periodYear: Number(p?.year || new Date().getUTCFullYear()),
      periodWeek: p?.periodWeek ? Number(p.periodWeek) : 0, status: { in: ["APPROVED", "PROCESSING", "PAID"] },
    }
    const orderBy = [{ calcEpoch: "desc" as const }, { createdAt: "desc" as const }]
    let runs: { id: string; status: string }[]
    if (p?.runType) {
      runs = await db.payrollRun.findMany({ where: { ...baseWhere, runType: String(p.runType) }, orderBy })
    } else {
      const first = await db.payrollRun.findFirst({ where: baseWhere, orderBy })
      runs = first ? [first] : []
    }
    if (!runs.length) return { columns: ["No paid/approved run for this period"], rows: [], meta: { run: null } }
    const emps = await scopedEmployees(ctx, p)
    const entries = await db.payrollEntry.findMany({ where: { runId: { in: runs.map((r) => r.id) }, employeeId: { in: emps.map((e) => e.id) } } })
    // MULTI-COMPANY — the grouping axes are the ACTIVE company's org rows
    const groups = group === "branchId"
      ? await db.branch.findMany({ where: { vendorId: ctx.vendorId, ...(ctx.activeCompanyId && !ctx.allCompaniesMode ? { companyId: ctx.activeCompanyId } : {}) } })
      : await db.department.findMany({ where: { vendorId: ctx.vendorId, ...(ctx.activeCompanyId && !ctx.allCompaniesMode ? { companyId: ctx.activeCompanyId } : {}) } })
    const rows = groups.map((g) => {
      const ids = new Set(emps.filter((e) => (e as any)[group] === g.id).map((e) => e.id))
      const es = entries.filter((e) => ids.has(e.employeeId))
      const sum = (f: (e: any) => number) => Math.round(es.reduce((s, e) => s + f(e), 0))
      return [g.name, es.length, sum((e) => e.gross), sum((e) => e.otAmount), sum((e) => e.bonus + e.commission), sum((e) => e.ait), sum((e) => e.net)]
    })
    const firstRun = runs[0]
    return {
      columns: [group === "branchId" ? "Branch" : "Department", "Employees", "Gross", "OT", "Bonus + Commission", "AIT", "Net"],
      rows,
      meta: { run: firstRun ? { id: firstRun.id, status: firstRun.status } : null, runsAggregated: runs.length, ...(p?.runType ? { runType: String(p.runType) } : {}) },
    }
  })
payrollGroupReport("payrollBranch", "branchId")
payrollGroupReport("payrollDepartment", "departmentId")

reportRoute("payrollDeductions", async (ctx, p) => {
  const { prefix } = monthPrefixOf(p)
  const emps = await scopedEmployees(ctx, p)
  const entries = await db.payrollEntry.findMany({
    where: { vendorId: ctx.vendorId, employeeId: { in: emps.map((e) => e.id) } },
  })
  // MULTI-COMPANY — run-period matching stays inside the ACTIVE company
  const runs = await db.payrollRun.findMany({ where: { vendorId: ctx.vendorId, ...(ctx.activeCompanyId && !ctx.allCompaniesMode ? { companyId: ctx.activeCompanyId } : {}) } })
  const inPeriod = entries.filter((e) => {
    const r = runs.find((x) => x.id === e.runId)
    return r && r.periodYear === Number(p?.year || new Date().getUTCFullYear()) && r.periodMonth === Number(p?.month || new Date().getUTCMonth() + 1)
  })
  return {
    columns: ["Employee", "Absence", "Late", "Loan", "Advance", "Other", "AIT", "Total"],
    rows: inPeriod.map((e) => [
      emps.find((x) => x.id === e.employeeId)?.fullName || "—",
      e.absenceDeduction, e.lateDeduction, e.loanDeduction, e.advanceDeduction, e.otherDeduction, e.ait,
      e.absenceDeduction + e.lateDeduction + e.loanDeduction + e.advanceDeduction + e.otherDeduction + e.ait,
    ]),
    meta: { count: inPeriod.length, prefix },
  }
})

reportRoute("loans", async (ctx, p) => {
  // Reports overhaul (3j) — branchId/departmentId/employeeId now scope the
  // employee set (scopedEmployees' id set), the same as the rest of the
  // catalog. p.status is the LOAN status, so it is stripped from the employee
  // query and applied to the loans below.
  const emps = await scopedEmployees(ctx, { ...p, status: undefined })
  const empIds = new Set(emps.map((e) => e.id))
  const loans = await db.loan.findMany({ where: { vendorId: ctx.vendorId }, orderBy: { createdAt: "desc" } })
  const inScope = loans.filter((l) => empIds.has(l.employeeId))
  // RPT-04 — the status filter the UI offers is applied (was never read)
  const filtered = p?.status ? inScope.filter((l) => l.status === p.status) : inScope
  return {
    columns: ["Employee", "Type", "Principal", "Installments", "Paid", "Outstanding", "Status"],
    rows: filtered.map((l) => [
      emps.find((e) => e.id === l.employeeId)?.fullName || "—", titleCase(l.type),
      l.principal, l.installments, l.paidAmount, l.outstanding, titleCase(l.status),
    ]),
    meta: { count: filtered.length },
  }
})

reportRoute("advances", async (ctx, p) => {
  // Reports overhaul (3j) — branchId/departmentId/employeeId now scope the
  // employee set; p.status is the ADVANCE status (stripped from the employee
  // query, applied to the advances below).
  const emps = await scopedEmployees(ctx, { ...p, status: undefined })
  const empIds = new Set(emps.map((e) => e.id))
  const advances = await db.advance.findMany({ where: { vendorId: ctx.vendorId }, orderBy: { requestDate: "desc" } })
  const inScope = advances.filter((a) => empIds.has(a.employeeId))
  // RPT-04 — the status filter the UI offers is applied (was never read)
  const filtered = p?.status ? inScope.filter((a) => a.status === p.status) : inScope
  return {
    columns: ["Employee", "Amount", "Request Date", "Recovery Date", "Installments", "Recovered", "Outstanding", "Status"],
    rows: filtered.map((a) => [
      emps.find((e) => e.id === a.employeeId)?.fullName || "—", a.amount, a.requestDate,
      a.recoveryDate || "—", a.installments, a.deducted, a.outstanding, titleCase(a.status),
    ]),
    meta: { count: filtered.length },
  }
})

reportRoute("expenses", async (ctx, p) => {
  const emps = await scopedEmployees(ctx, p)
  const where: any = { vendorId: ctx.vendorId, employeeId: { in: emps.map((e) => e.id) } }
  if (p?.status) where.status = p.status
  const claims = await db.expenseClaim.findMany({ where, orderBy: { date: "desc" } })
  return {
    columns: ["Employee", "Title", "Category", "Amount", "Date", "Status", "Reimbursed On"],
    rows: claims.map((c) => [
      emps.find((e) => e.id === c.employeeId)?.fullName || "—", c.title, titleCase(c.category),
      c.amount, c.date, titleCase(c.status), c.reimbursementDate || "—",
    ]),
    meta: { count: claims.length },
  }
})

reportRoute("reimbursements", async (ctx, p) => {
  const emps = await scopedEmployees(ctx, p)
  const claims = await db.expenseClaim.findMany({
    where: { vendorId: ctx.vendorId, employeeId: { in: emps.map((e) => e.id) }, status: "REIMBURSED" },
    orderBy: { reimbursementDate: "desc" },
  })
  const total = claims.reduce((s, c) => s + c.amount, 0)
  return {
    columns: ["Employee", "Title", "Category", "Amount", "Expense Date", "Reimbursed On"],
    rows: claims.map((c) => [
      emps.find((e) => e.id === c.employeeId)?.fullName || "—", c.title, titleCase(c.category),
      c.amount, c.date, c.reimbursementDate || "—",
    ]),
    meta: { count: claims.length, totalReimbursed: total },
  }
})

// ---------- §17.5 Performance reports ----------
reportRoute("performance", async (ctx, p) => {
  const emps = await scopedEmployees(ctx, p)
  const reviews = await db.performanceReview.findMany({ where: { vendorId: ctx.vendorId, employeeId: { in: emps.map((e) => e.id) }, ...(p?.cycleId ? { cycleId: p.cycleId } : {}) } })
  // MULTI-COMPANY — cycle names resolve inside the ACTIVE company
  const cycles = await db.reviewCycle.findMany({ where: { vendorId: ctx.vendorId, ...(ctx.activeCompanyId && !ctx.allCompaniesMode ? { companyId: ctx.activeCompanyId } : {}) } })
  return {
    columns: ["Employee", "Cycle", "Overall", "Status", "Reviewer"],
    rows: reviews.map((r) => [
      emps.find((e) => e.id === r.employeeId)?.fullName || "—",
      cycles.find((c) => c.id === r.cycleId)?.name || "—",
      r.overallRating, titleCase(r.status),
      emps.find((e) => e.id === r.reviewerId)?.fullName || "—",
    ]),
  }
})

reportRoute("performanceKpi", async (ctx, p) => {
  const emps = await scopedEmployees(ctx, p)
  const kpis = await db.kpiAssignment.findMany({
    where: { vendorId: ctx.vendorId, employeeId: { in: emps.map((e) => e.id) }, status: { in: ["SUBMITTED", "REVIEWED"] } },
  })
  const rows = kpis.map((k) => {
    const results = j(k.resultsJson, [] as any[])
    const avg = results.length ? results.reduce((s, r) => s + (r.achievementPct || 0), 0) / results.length : 0
    return [
      emps.find((e) => e.id === k.employeeId)?.fullName || "—",
      k.periodLabel || "—", k.status, results.length, Math.round(avg) + "%",
    ]
  })
  return {
    columns: ["Employee", "Period", "Status", "KPIs", "Avg Achievement"],
    rows,
    meta: { count: kpis.length },
  }
})

reportRoute("performanceTrend", async (ctx, p) => {
  const emps = await scopedEmployees(ctx, p)
  // MULTI-COMPANY — the trend's cycle rows are the ACTIVE company's
  const cycles = await db.reviewCycle.findMany({ where: { vendorId: ctx.vendorId, ...(ctx.activeCompanyId && !ctx.allCompaniesMode ? { companyId: ctx.activeCompanyId } : {}) }, orderBy: { startDate: "asc" } })
  const reviews = await db.performanceReview.findMany({ where: { vendorId: ctx.vendorId, employeeId: { in: emps.map((e) => e.id) } } })
  return {
    columns: ["Cycle", "Reviews", "Avg Rating", "Top Rating", "Low Rating"],
    rows: cycles.map((c) => {
      const rs = reviews.filter((r) => r.cycleId === c.id)
      const avg = rs.length ? Math.round((rs.reduce((s, r) => s + r.overallRating, 0) / rs.length) * 10) / 10 : 0
      return [c.name, rs.length, avg || "—", rs.length ? Math.max(...rs.map((r) => r.overallRating)) : "—", rs.length ? Math.min(...rs.map((r) => r.overallRating)) : "—"]
    }),
    meta: { count: cycles.length },
  }
})

// ================= WAVE 3 WP-E 5.6 — NEW HR REPORTS =================
// All additive: same { columns, rows, meta } envelope, same scopedEmployees /
// monthPrefixOf helpers, CSV twins registered by reportRoute(). H-10 scoping
// via employeeScopeFilter(ctx) everywhere; L-28 caps on caller date ranges.

// ---------- Headcount (by branch / department / status / employment type) ----------
reportRoute("headcount", async (ctx, p) => {
  const dimension = p?.dimension || "branch"
  const emps = await scopedEmployees(ctx, p)
  // MULTI-COMPANY — the grouping axes are the ACTIVE company's org rows
  const branches = await db.branch.findMany({ where: { vendorId: ctx.vendorId, ...(ctx.activeCompanyId && !ctx.allCompaniesMode ? { companyId: ctx.activeCompanyId } : {}) } })
  const depts = await db.department.findMany({ where: { vendorId: ctx.vendorId, ...(ctx.activeCompanyId && !ctx.allCompaniesMode ? { companyId: ctx.activeCompanyId } : {}) } })
  const label = (e: any): string => {
    switch (dimension) {
      case "department": return depts.find((d) => d.id === e.departmentId)?.name || "Unassigned"
      case "status": return titleCase(e.status)
      case "employmentType": return titleCase(e.employmentType)
      default: return branches.find((b) => b.id === e.branchId)?.name || "Unassigned"
    }
  }
  const agg = new Map<string, number>()
  for (const e of emps) agg.set(label(e), (agg.get(label(e)) || 0) + 1)
  const total = emps.length || 1
  return {
    columns: [titleCase(dimension), "Headcount", "% of Workforce"],
    rows: [...agg.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, v, `${pct(v, total)}%`]),
    meta: { count: agg.size, dimension, totalEmployees: emps.length },
  }
})

// ---------- Demographics (gender / blood group / marital status / religion) ----------
reportRoute("demographics", async (ctx, p) => {
  const dimension = p?.dimension || "gender"
  const field = dimension === "bloodGroup" ? "bloodGroup" : dimension === "maritalStatus" ? "maritalStatus" : dimension === "religion" ? "religion" : "gender"
  const emps = await scopedEmployees(ctx, p)
  const agg = new Map<string, number>()
  for (const e of emps) {
    const v = (e as any)[field]?.trim() || "Not specified"
    agg.set(v, (agg.get(v) || 0) + 1)
  }
  const total = emps.length || 1
  return {
    columns: [titleCase(dimension === "bloodGroup" ? "blood group" : dimension), "Employees", "% of Workforce"],
    rows: [...agg.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, v, `${pct(v, total)}%`]),
    meta: { count: agg.size, dimension, totalEmployees: emps.length },
  }
})

// ---------- Salary band distribution (current structures) ----------
reportRoute("salaryBands", async (ctx, p) => {
  const scope: any = employeeScopeFilter(ctx)
  if (p?.branchId) scope.branchId = p.branchId
  if (p?.departmentId) scope.departmentId = p.departmentId
  const emps = await db.employee.findMany({ where: { ...scope, status: { in: ["ACTIVE", "PROBATION", "ON_LEAVE", "SUSPENDED"] } }, select: { id: true } })
  // current structure = latest row whose effectiveFrom <= today and (effectiveTo null or >= today)
  const t = today()
  const structures = await db.salaryStructure.findMany({
    where: { vendorId: ctx.vendorId, employeeId: { in: emps.map((e) => e.id) }, effectiveFrom: { lte: t }, OR: [{ effectiveTo: null }, { effectiveTo: { gte: t } }] },
    orderBy: { effectiveFrom: "desc" },
  })
  const latestByEmp = new Map<string, number>()
  for (const s of structures) {
    if (!latestByEmp.has(s.employeeId)) latestByEmp.set(s.employeeId, Number(s.basic) || 0)
  }
  const BANDS: [string, number, number][] = [
    ["Under ৳20,000", 0, 20_000],
    ["৳20,000 – ৳50,000", 20_000, 50_000],
    ["৳50,000 – ৳100,000", 50_000, 100_000],
    ["৳100,000 – ৳200,000", 100_000, 200_000],
    ["৳200,000 and above", 200_000, Number.POSITIVE_INFINITY],
  ]
  const total = latestByEmp.size || 1
  const rows = BANDS.map(([label, lo, hi]) => {
    const n = [...latestByEmp.values()].filter((v) => v >= lo && v < hi).length
    return [label, n, `${pct(n, total)}%`]
  }).filter((r) => Number(r[1]) > 0)
  return {
    columns: ["Basic Salary Band (monthly)", "Employees", "% of Paid Headcount"],
    rows,
    meta: { count: rows.length, totalStructured: latestByEmp.size, note: "current basic salary only (allowances excluded); employees without a current structure are not counted" },
  }
})

// ---------- Probation & contract expiry tracker ----------
reportRoute("probationExpiry", async (ctx, p) => {
  const withinDays = Math.min(Math.max(Number(p?.withinDays) || 60, 1), 366)
  const t = today()
  const horizon = addDays(t, withinDays)
  const scope: any = employeeScopeFilter(ctx)
  if (p?.branchId) scope.branchId = p.branchId
  if (p?.departmentId) scope.departmentId = p.departmentId
  const emps = await db.employee.findMany({
    where: { ...scope, status: { in: ["ACTIVE", "PROBATION", "ON_LEAVE"] } },
    orderBy: { joiningDate: "asc" },
  })
  // MULTI-COMPANY — org-name decoration resolves inside the ACTIVE company
  const depts = await db.department.findMany({ where: { vendorId: ctx.vendorId, ...(ctx.activeCompanyId && !ctx.allCompaniesMode ? { companyId: ctx.activeCompanyId } : {}) } })
  const rows: (string | number)[][] = []
  for (const e of emps) {
    // probation confirmation = joiningDate + probationMonths (months arithmetic on the ISO string)
    if (e.joiningDate && (e.status === "PROBATION" || e.employmentType === "PROBATIONARY")) {
      const j = new Date(`${e.joiningDate}T00:00:00Z`)
      j.setUTCMonth(j.getUTCMonth() + (e.probationMonths || 3))
      const due = j.toISOString().slice(0, 10)
      if (due <= horizon) {
        rows.push([
          e.code, e.fullName, "Probation ends", due,
          daysBetween(t, due) >= 0 ? daysBetween(t, due) : `overdue ${Math.abs(daysBetween(t, due))}d`,
          depts.find((d) => d.id === e.departmentId)?.name || "—",
        ])
      }
    }
    if (e.contractEnd && e.employmentType === "CONTRACTUAL") {
      if (e.contractEnd <= horizon) {
        rows.push([
          e.code, e.fullName, "Contract ends", e.contractEnd,
          daysBetween(t, e.contractEnd) >= 0 ? daysBetween(t, e.contractEnd) : `overdue ${Math.abs(daysBetween(t, e.contractEnd))}d`,
          depts.find((d) => d.id === e.departmentId)?.name || "—",
        ])
      }
    }
  }
  rows.sort((a, b) => String(a[3]).localeCompare(String(b[3])))
  return {
    columns: ["Code", "Name", "Event", "Key Date", "Days Left", "Department"],
    rows,
    meta: { count: rows.length, withinDays, from: t, to: horizon },
  }
})

// ---------- Birthdays & work anniversaries (selected month) ----------
reportRoute("birthdays", async (ctx, p) => {
  const { month, year } = monthPrefixOf(p)
  const scope: any = employeeScopeFilter(ctx)
  if (p?.branchId) scope.branchId = p.branchId
  if (p?.departmentId) scope.departmentId = p.departmentId
  const emps = await db.employee.findMany({
    where: { ...scope, status: { in: ["ACTIVE", "PROBATION", "ON_LEAVE", "SUSPENDED"] } },
    orderBy: { fullName: "asc" },
  })
  // MULTI-COMPANY — org-name decoration resolves inside the ACTIVE company
  const depts = await db.department.findMany({ where: { vendorId: ctx.vendorId, ...(ctx.activeCompanyId && !ctx.allCompaniesMode ? { companyId: ctx.activeCompanyId } : {}) } })
  const mm = String(month).padStart(2, "0")
  const rows: (string | number)[][] = []
  for (const e of emps) {
    if (e.dob?.slice(5, 7) === mm) {
      const turns = year - Number(e.dob.slice(0, 4))
      rows.push([e.code, e.fullName, "Birthday", e.dob, turns > 0 && turns < 120 ? `turns ${turns}` : "—", depts.find((d) => d.id === e.departmentId)?.name || "—"])
    }
    if (e.joiningDate?.slice(5, 7) === mm && e.joiningDate.slice(0, 4) !== String(year)) {
      const years = year - Number(e.joiningDate.slice(0, 4))
      rows.push([e.code, e.fullName, "Work anniversary", e.joiningDate, years > 0 ? `${years} year${years === 1 ? "" : "s"}` : "—", depts.find((d) => d.id === e.departmentId)?.name || "—"])
    }
  }
  rows.sort((a, b) => String(a[3]).slice(5).localeCompare(String(b[3]).slice(5)))
  return {
    columns: ["Code", "Name", "Event", "Date (YYYY-MM-DD)", "Milestone", "Department"],
    rows,
    meta: { count: rows.length, month, year },
  }
})

// ---------- Headcount movement (joiners vs exits per month) ----------
reportRoute("headcountMovement", async (ctx, p) => {
  const { year } = monthPrefixOf(p)
  const scope: any = employeeScopeFilter(ctx)
  if (p?.branchId) scope.branchId = p.branchId
  if (p?.departmentId) scope.departmentId = p.departmentId
  const emps = await db.employee.findMany({ where: scope })
  const resignations = await db.resignation.findMany({ where: { vendorId: ctx.vendorId, status: { in: ["ACCEPTED", "COMPLETED"] } } })
  const lwdByEmp = new Map<string, string>()
  for (const r of resignations) lwdByEmp.set(r.employeeId, r.actualLwd || r.proposedLwd || "")
  const months = Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, "0")}`)
  const rows = months.map((m) => {
    const joiners = emps.filter((e) => e.joiningDate?.startsWith(m)).length
    // exits: resignation last-working-day in month, else exit-status recorded (updatedAt) in month
    let exits = 0
    for (const e of emps) {
      if (["RESIGNED", "TERMINATED", "RETIRED"].includes(e.status)) {
        const lwd = lwdByEmp.get(e.id)
        const when = lwd || e.updatedAt?.toISOString().slice(0, 7)
        if (when === m) exits++
      }
    }
    return [`${monthName(Number(m.slice(5, 7)))} ${year}`, joiners, exits, joiners - exits]
  })
  return {
    columns: ["Month", "Joiners", "Exits", "Net Change"],
    rows,
    meta: {
      count: rows.length, year,
      note: "exits use the resignation last working day when recorded, otherwise the exit status update month",
    },
  }
})

// ---------- Recruitment funnel ----------
reportRoute("recruitmentFunnel", async (ctx, _p) => {
  // MULTI-COMPANY — the funnel covers the ACTIVE company's openings
  const openings = await db.jobOpening.findMany({ where: { vendorId: ctx.vendorId, ...(ctx.activeCompanyId && !ctx.allCompaniesMode ? { companyId: ctx.activeCompanyId } : {}) } })
  const apps = await db.jobApplication.findMany({ where: { vendorId: ctx.vendorId } })
  const STAGES = ["NEW", "SHORTLISTED", "INTERVIEW", "OFFERED", "HIRED", "REJECTED"] as const
  const total = apps.length || 1
  const rows: (string | number)[][] = [
    ["Openings (total)", openings.length, "—"],
    ["Openings published (isPublic)", openings.filter((o) => o.isPublic).length, "—"],
    ["Openings open (not DRAFT/CLOSED)", openings.filter((o) => !["DRAFT", "CLOSED"].includes(o.status)).length, "—"],
    ...STAGES.map((s) => {
      const n = apps.filter((a) => a.status === s).length
      return [`Applications — ${titleCase(s)}`, n, `${pct(n, total)}%`]
    }),
    ["Applications (total)", apps.length, "100%"],
  ]
  return {
    columns: ["Funnel Stage", "Count", "% of Applications"],
    rows,
    meta: { count: rows.length },
  }
})

// ---------- Asset assignment register (Wave 2 WP-K data, now reported) ----------
reportRoute("assetAssignments", async (ctx, p) => {
  const assignments = await db.assetAssignment.findMany({
    where: { vendorId: ctx.vendorId },
    orderBy: { assignedAt: "desc" },
  })
  // MULTI-COMPANY — asset + branch names resolve inside the ACTIVE company
  const assets = await db.asset.findMany({ where: { vendorId: ctx.vendorId, ...(ctx.activeCompanyId && !ctx.allCompaniesMode ? { companyId: ctx.activeCompanyId } : {}) } })
  const emps = await db.employee.findMany({ where: employeeScopeFilter(ctx), select: { id: true, fullName: true, branchId: true } })
  const branches = await db.branch.findMany({ where: { vendorId: ctx.vendorId, ...(ctx.activeCompanyId && !ctx.allCompaniesMode ? { companyId: ctx.activeCompanyId } : {}) } })
  const t = today()
  const rows = assignments.map((a) => {
    const asset = assets.find((x) => x.id === a.assetId)
    const emp = emps.find((x) => x.id === a.employeeId)
    const dueAt = a.dueAt ? a.dueAt.toISOString().slice(0, 10) : null // Date → ISO date string
    const status = a.returnedAt ? "Returned" : dueAt && dueAt < t ? "Overdue" : "Issued"
    return [
      asset?.code || "—", asset?.name || "—", emp?.fullName || "—",
      branches.find((b) => b.id === emp?.branchId)?.name || "—",
      a.assignedAt.toISOString().slice(0, 10), dueAt || "—",
      a.returnedAt ? a.returnedAt.toISOString().slice(0, 10) : "—",
      status, a.conditionOut || "—", a.conditionIn || "—",
    ]
  })
  const filtered = p?.status === "Issued" ? rows.filter((r) => r[7] === "Issued")
    : p?.status === "Returned" ? rows.filter((r) => r[7] === "Returned")
    : p?.status === "Overdue" ? rows.filter((r) => r[7] === "Overdue")
    : rows
  return {
    columns: ["Asset Code", "Asset", "Employee", "Branch", "Assigned", "Due", "Returned", "Status", "Condition Out", "Condition In"],
    rows: filtered,
    meta: { count: filtered.length },
  }
})

// ---------- Field-force visit summary (Wave 2 WP-M data, now reported) ----------
reportRoute("fieldforceVisits", async (ctx, p) => {
  const { prefix, month, year } = monthPrefixOf(p)
  // RPT-06 — real calendar month bounds: `new Date("YYYY-MM-31T…")` rolls
  // over to the NEXT month for every month shorter than 31 days (JS date
  // rollover), counting up to 3 days of the next month for 7 months of the
  // year. Compute the next month's first day instead.
  const nextPrefix = month === 12 ? `${year + 1}-01` : `${year}-${String(month + 1).padStart(2, "0")}`
  // Reports overhaul (3j) — branchId/departmentId/employeeId scope the
  // employee set, and the visits themselves are restricted to that set
  // (previously out-of-scope employees' visits rendered with a "—" name).
  const empWhere: any = {
    ...employeeScopeFilter(ctx),
    ...(p?.branchId ? { branchId: p.branchId } : {}),
    ...(p?.departmentId ? { departmentId: p.departmentId } : {}),
    ...(p?.employeeId ? { id: p.employeeId } : {}),
  }
  const emps = await db.employee.findMany({ where: empWhere, select: { id: true, fullName: true, branchId: true } })
  const visits = await db.visit.findMany({
    where: { vendorId: ctx.vendorId, employeeId: { in: emps.map((e) => e.id) }, checkInAt: { gte: new Date(`${prefix}-01T00:00:00`), lt: new Date(`${nextPrefix}-01T00:00:00`) } },
    orderBy: { checkInAt: "asc" },
  })
  // MULTI-COMPANY — branch names + visit locations are the ACTIVE company's
  const branches = await db.branch.findMany({ where: { vendorId: ctx.vendorId, ...(ctx.activeCompanyId && !ctx.allCompaniesMode ? { companyId: ctx.activeCompanyId } : {}) } })
  const locations = await db.visitLocation.findMany({ where: { vendorId: ctx.vendorId, ...(ctx.activeCompanyId && !ctx.allCompaniesMode ? { companyId: ctx.activeCompanyId } : {}) } })
  const byEmp = new Map<string, { total: number; completed: number; minutes: number; last: Date | null }>()
  for (const v of visits) {
    const cur = byEmp.get(v.employeeId) || { total: 0, completed: 0, minutes: 0, last: null }
    cur.total++
    if (v.checkOutAt) { cur.completed++; cur.minutes += v.durationMin || 0 }
    if (!cur.last || v.checkInAt > cur.last) cur.last = v.checkInAt
    byEmp.set(v.employeeId, cur)
  }
  const rows = [...byEmp.entries()].map(([id, v]) => [
    emps.find((e) => e.id === id)?.fullName || "—",
    branches.find((b) => b.id === emps.find((e) => e.id === id)?.branchId)?.name || "—",
    v.total, v.completed, v.total - v.completed,
    v.completed ? Math.round((v.minutes / v.completed) * 10) / 10 : 0,
    locations.length || "—",
    v.last ? v.last.toISOString().slice(0, 10) : "—",
  ]).sort((a, b) => Number(b[2]) - Number(a[2]))
  return {
    columns: ["Employee", "Branch", "Visits", "Completed", "Open", "Avg Duration (min)", "Locations (active)", "Last Visit"],
    rows,
    meta: { count: rows.length, month, year, totalVisits: visits.length },
  }
})

// ================= WAVE 4 BD COMPLIANCE — GRATUITY & FESTIVAL BONUS =================
// Bangladesh Labour Act (2006) gratuity projection and festival-bonus preview.
// Both are ADVISORY computations over current structures — they never post
// journals or mutate payroll. Gratuity: 30 days' basic wages per completed
// year of continuous service (eligible after 5 years; divisor selectable:
// 30 = BLA daily-rate convention, 26 = factory/undertaking convention).

reportRoute("gratuity", async (ctx, p) => {
  const scope: any = employeeScopeFilter(ctx)
  if (p?.branchId) scope.branchId = p.branchId
  if (p?.departmentId) scope.departmentId = p.departmentId
  // MULTI-COMPANY — settings resolve for the ACTIVE company
  const settings = await getSettings(ctx.vendorId, { companyId: ctx.activeCompanyId || undefined })
  const cfg = settings.gratuity || { enabled: true, eligibilityYears: 5, daysPerYear: 30, wageBasis: "BASIC", divisor: 30, capAmount: 0 }
  const divisor = p?.divisor === 26 ? 26 : (p?.divisor === 30 ? 30 : (cfg.divisor === 26 ? 26 : 30))
  const eligibleOnly = p?.eligibleOnly !== false
  const t = today()
  const emps = await db.employee.findMany({
    where: { ...scope, status: { in: ["ACTIVE", "PROBATION", "ON_LEAVE", "SUSPENDED"] }, joiningDate: { not: null } },
    select: { id: true, fullName: true, joiningDate: true, departmentId: true, designationId: true },
  })
  const structures = await db.salaryStructure.findMany({
    where: { vendorId: ctx.vendorId, employeeId: { in: emps.map((e) => e.id) }, effectiveFrom: { lte: t }, OR: [{ effectiveTo: null }, { effectiveTo: { gte: t } }] },
    orderBy: { effectiveFrom: "desc" },
  })
  const wageByEmp = new Map<string, { basic: number; gross: number }>()
  for (const s of structures) {
    if (!wageByEmp.has(s.employeeId)) {
      wageByEmp.set(s.employeeId, { basic: Number(s.basic) || 0, gross: Number(s.gross) || Number(s.basic) || 0 })
    }
  }
  // MULTI-COMPANY — org-name decoration resolves inside the ACTIVE company
  const depts = await db.department.findMany({ where: { vendorId: ctx.vendorId, ...(ctx.activeCompanyId && !ctx.allCompaniesMode ? { companyId: ctx.activeCompanyId } : {}) }, select: { id: true, name: true } })
  const desigs = await db.designation.findMany({ where: { vendorId: ctx.vendorId, ...(ctx.activeCompanyId && !ctx.allCompaniesMode ? { companyId: ctx.activeCompanyId } : {}) }, select: { id: true, name: true } })
  const deptName = (id: string | null) => depts.find((d) => d.id === id)?.name || "—"
  const desigName = (id: string | null) => desigs.find((x) => x.id === id)?.name || "—"

  const rows: (string | number)[][] = []
  let totalExposure = 0
  // EXIT-001 (R3-1) — the report now uses the SAME shared gratuity engine as
  // the exit settlement (src/hrm-server/gratuity.ts), so the projected
  // "Eligible (5y)" flag and amount can never disagree with the money that
  // the settlement actually pays. Divisor stays report-selectable (30/26);
  // eligibility follows the BLA 4y6m-rounds-up rule.
  const { computeGratuity } = await import("../gratuity")
  for (const e of emps) {
    const wage = wageByEmp.get(e.id)
    if (!wage || (!wage.basic && !wage.gross)) continue
    const g = computeGratuity(
      { ...cfg, divisor },
      wage,
      e.joiningDate,
      t,
    )
    const months = g.months
    const eligible = g.eligible
    if (eligibleOnly && !eligible) continue
    const gratuity = g.amount
    totalExposure += gratuity
    rows.push([
      e.fullName,
      deptName(e.departmentId ?? null),
      desigName(e.designationId ?? null),
      e.joiningDate as string,
      Math.round(months / 12 * 10) / 10,
      eligible ? "Yes" : "No (projected)",
      g.dailyWage,
      Math.round(gratuity * 100) / 100,
    ])
  }
  rows.sort((a, b) => Number(b[7]) - Number(a[7]))
  if (rows.length) rows.push(["TOTAL", "", "", "", "", "", "", Math.round(totalExposure * 100) / 100])
  const basisLabel = (cfg.wageBasis || "BASIC").toLowerCase()
  return {
    columns: ["Employee", "Department", "Designation", "Joining Date", "Years of Service", `Eligible (${cfg.eligibilityYears || 5}y)`, `Daily ${cfg.wageBasis === "GROSS" ? "Gross" : "Basic"} (৳)`, "Gratuity Provision (৳)"],
    rows,
    meta: {
      count: rows.length - (rows.length ? 1 : 0),
      divisor,
      formula: `gratuity = (${basisLabel} ÷ ${divisor}) × ${(cfg.daysPerYear || 30)} × completed years — Bangladesh Labour Act 2006; advisory projection, not an accrued liability`,
      totalExposure: Math.round(totalExposure * 100) / 100,
    },
  }
})

reportRoute("festivalBonus", async (ctx, p) => {
  const scope: any = employeeScopeFilter(ctx)
  if (p?.branchId) scope.branchId = p.branchId
  if (p?.departmentId) scope.departmentId = p.departmentId
  const percent = Math.min(200, Math.max(0, Number(p?.percent ?? 100)))
  const basis = p?.basis === "gross" ? "gross" : "basic"
  const t = today()
  const emps = await db.employee.findMany({
    where: { ...scope, status: { in: ["ACTIVE", "PROBATION", "ON_LEAVE"] }, joiningDate: { not: null } },
    select: { id: true, fullName: true, joiningDate: true, departmentId: true, employmentType: true, religion: true },
  })
  const structures = await db.salaryStructure.findMany({
    where: { vendorId: ctx.vendorId, employeeId: { in: emps.map((e) => e.id) }, effectiveFrom: { lte: t }, OR: [{ effectiveTo: null }, { effectiveTo: { gte: t } }] },
    orderBy: { effectiveFrom: "desc" },
  })
  const compByEmp = new Map<string, { basic: number; gross: number }>()
  for (const s of structures) {
    if (!compByEmp.has(s.employeeId)) {
      // RPT-05 — "gross" is the FULL monthly gross (every component the
      // payslip counts): the old 4-component sum omitted conveyance, food,
      // mobile, internet and the attendance allowance, disagreeing with the
      // gratuity report for the same employee (the stored gross column IS
      // the full sum by construction — salaryStructures.save).
      compByEmp.set(s.employeeId, {
        basic: Number(s.basic) || 0,
        gross: Number(s.gross) || 0,
      })
    }
  }
  // MULTI-COMPANY — org-name decoration resolves inside the ACTIVE company
  const depts = await db.department.findMany({ where: { vendorId: ctx.vendorId, ...(ctx.activeCompanyId && !ctx.allCompaniesMode ? { companyId: ctx.activeCompanyId } : {}) }, select: { id: true, name: true } })
  const deptName = (id: string | null) => depts.find((d) => d.id === id)?.name || "—"

  const rows: (string | number)[][] = []
  let total = 0
  for (const e of emps) {
    const comp = compByEmp.get(e.id)
    if (!comp) continue
    const months = Math.max(0, (Date.now() - new Date(`${e.joiningDate}T00:00:00Z`).getTime()) / (1000 * 60 * 60 * 24 * 30.436875))
    const base = basis === "gross" ? comp.gross : comp.basic
    const bonus = base * percent / 100
    total += bonus
    rows.push([
      e.fullName,
      deptName(e.departmentId ?? null),
      e.employmentType || "—",
      e.religion || "—",
      Math.round(months / 12 * 10) / 10,
      Math.round(base * 100) / 100,
      Math.round(bonus * 100) / 100,
    ])
  }
  rows.sort((a, b) => Number(b[6]) - Number(a[6]))
  if (rows.length) rows.push(["TOTAL", "", "", "", "", "", Math.round(total * 100) / 100])
  return {
    columns: ["Employee", "Department", "Employment Type", "Religion", "Years of Service", `${basis === "gross" ? "Gross" : "Basic"} (৳)`, "Festival Bonus (৳)"],
    rows,
    meta: {
      count: rows.length - (rows.length ? 1 : 0),
      basis,
      percent,
      formula: `festival bonus = ${basis} × ${percent}% — preview only; actual payment runs through the payroll bonus engine (Bonus & Commission)`,
      total,
    },
  }
})

// ================= WAVE 4 WP-A — REPORT TEMPLATES + SCHEDULED DELIVERY =================
// Saved filter+format+recipient presets per vendor. The scheduler
// (scheduled-reports.ts) renders them through renderReportForVendor() — the
// SAME handlers registered above — and emails the file via the tenant
// gateway. Every delivery lands in ReportDeliveryLog (SENT/FAILED/SKIPPED).

/** Loose filter shape shared by the RPC handlers and the template store:
 *  a flat object of scalar leaves (branchId, month, year, status…). */
const templateFilterValue = z.union([z.string().max(120), z.number(), z.boolean(), z.null()])
const templateFiltersSchema = z.record(z.string().max(40), templateFilterValue)

const templateRecipientSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(160),
  name: z.string().trim().max(80).optional(),
}).strict()

const templateSaveSchema = z.object({
  /** present ⇒ edit that template; absent ⇒ create (or update the same-named one) */
  id: z.string().trim().min(1).max(64).optional(),
  name: z.string().trim().min(2).max(80),
  reportKey: z.string().trim().min(2).max(60),
  filters: templateFiltersSchema.optional(),
  // Phase 3 — PDF joins the enterprise delivery formats (charts + KPI
  // commentary); structured XLSX is multi-sheet (KPIs / charts / table)
  format: z.enum(["XLSX", "CSV", "PDF"]),
  schedule: z.enum(["OFF", "DAILY", "WEEKLY", "MONTHLY"]),
  recipients: z.array(templateRecipientSchema).max(10).default([]),
  active: z.boolean().default(true),
}).strict()

/** Derive a readable title from a report key ("employeesNewJoiners" →
 *  "Employees New Joiners") — used by the scheduler's email subject/body. */
function reportTitleOf(key: string): string {
  return key.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, (c) => c.toUpperCase())
}

/** All report keys usable in a template (the reportRoute registry). */
export function knownReportKeys(): string[] {
  return [...reportHandlers.keys()]
}

/** RPT-001 (Wave R3-3) — recipient emails that are NOT tenant members.
 *  A scheduled report is an unattended bulk-data egress channel: its
 *  recipients must belong to the tenant (a user login or an employee
 *  e-mail). External addresses are how PII silently leaves the org every
 *  night; returning them lets both save-time and run-time guards refuse with
 *  the offending address named. */
export async function nonMemberRecipients(vendorId: string, recipients: { email?: string | null; name?: string | null }[]): Promise<string[]> {
  const wanted = recipients
    .map((r) => String(r?.email || "").trim().toLowerCase())
    .filter(Boolean)
  if (!wanted.length) return []
  const want = new Set(wanted)
  const [userEmails, empEmails] = await Promise.all([
    db.user.findMany({ where: { vendorId }, select: { email: true } }),
    db.employee.findMany({
      where: { vendorId, OR: [{ officialEmail: { not: null } }, { personalEmail: { not: null } }] },
      select: { officialEmail: true, personalEmail: true },
    }),
  ])
  const members = new Set<string>([
    ...userEmails.map((u) => u.email.toLowerCase()),
    ...empEmails.flatMap((e) => [e.officialEmail, e.personalEmail]).filter(Boolean).map((x) => String(x).toLowerCase()),
  ])
  return [...want].filter((e) => !members.has(e))
}

/** Wave 4 WP-A — render any registered report for a vendor as the SYSTEM
 *  scheduler. The synthetic ctx is vendor-scoped + reports-permissioned with
 *  an HR_ADMIN role (employeeScopeFilter then resolves to the whole tenant,
 *  which is what an emailed company report must cover). Filters are
 *  validated against the same loose scalar-leaf shape the RPC handlers
 *  accept; invalid stored filters throw instead of silently un-filtering.
 *  Returns null when the report key is not in the registry. */
export async function renderReportForVendor(
  vendorId: string,
  reportKey: string,
  filters: unknown,
  companyId?: string | null,
): Promise<{ columns: string[]; rows: any[][]; title: string } | null> {
  const fn = reportHandlers.get(reportKey)
  if (!fn) return null
  const parsed = templateFiltersSchema.safeParse(filters ?? {})
  if (!parsed.success) {
    throw new Deny("Stored report filters failed validation — re-save the template with fresh filters", 400)
  }
  const ctx = {
    userId: "scheduler",
    userName: "Report Scheduler",
    vendorId,
    // MULTI-COMPANY — the scheduled template's company scopes the render
    // (null/undefined = a tenant-wide template: the previous vendor-wide behavior)
    activeCompanyId: companyId || null,
    role: "HR_ADMIN" as const,
    permissions: new Set(["reports.view", "reports.schedule"]),
  }
  const out = await fn(ctx, parsed.data)
  return { columns: out.columns, rows: out.rows, title: reportTitleOf(reportKey) }
}

/** AI-001 (Wave R3-3) — render a registered report AS THE CALLING USER.
 *  Same registry, same handlers, same filter validation — but the REAL ctx
 *  flows through, so employeeScopeFilter() applies the caller's branch /
 *  department scope exactly like the Reports view does. The synthetic
 *  HR_ADMIN ctx is reserved for the SYSTEM scheduler (renderReportForVendor);
 *  ai.reportAsk used it for live users, which leaked tenant-wide rows to
 *  branch/department managers and bypassed the reports.view permission. */
export async function renderReportAsCaller(
  ctx: { userId: string; userName: string; vendorId: string; role: string; permissions: Set<string>; branchId?: string | null; departmentId?: string | null },
  reportKey: string,
  filters: unknown,
): Promise<{ columns: string[]; rows: any[][]; title: string } | null> {
  const fn = reportHandlers.get(reportKey)
  if (!fn) return null
  const parsed = templateFiltersSchema.safeParse(filters ?? {})
  if (!parsed.success) {
    throw new Deny("Report filters failed validation", 400)
  }
  const out = await fn(ctx, parsed.data)
  return { columns: out.columns, rows: out.rows, title: reportTitleOf(reportKey) }
}

const templateWithJsonParsed = (t: {
  id: string; vendorId: string; reportKey: string; name: string; filtersJson: string;
  format: string; schedule: string; recipientsJson: string; lastRunAt: Date | null;
  lastStatus: string | null; active: boolean; createdById: string | null; createdByName: string | null; createdAt: Date
}) => ({
  ...t,
  filters: j(t.filtersJson, {} as Record<string, unknown>),
  recipients: j(t.recipientsJson, [] as { email: string; name?: string }[]),
})

route("reports.templates.list", {
  perm: ["reports", "view"],
  schema: z.object({}).strict(),
  handler: async (ctx) => {
    const [templates, deliveries] = await Promise.all([
      db.reportTemplate.findMany({ where: { vendorId: ctx.vendorId, ...(ctx.activeCompanyId && !ctx.allCompaniesMode ? { companyId: ctx.activeCompanyId } : {}) }, orderBy: { createdAt: "desc" } }),
      db.reportDeliveryLog.findMany({ where: { vendorId: ctx.vendorId }, orderBy: { startedAt: "desc" }, take: 20 }),
    ])
    return { templates: templates.map(templateWithJsonParsed), deliveries }
  },
})

route("reports.templates.save", {
  perm: ["reports", "schedule"],
  schema: templateSaveSchema,
  handler: async (ctx, p) => {
    // Phase 3 — a template may name a LEGACY report key OR a structured
    // report id from the analytics registry ("workforce.dashboard",
    // "legacy.headcount", …): the scheduler renders the structured ones
    // through the AnalyticsReport contract (KPIs + charts + PDF/XLSX/CSV).
    const known = reportHandlers.has(p.reportKey) || !!reportDefinition(p.reportKey)
    if (!known) {
      throw new Deny(`Unknown report "${p.reportKey}" — pick a report from the Reports registry or the structured-report catalogue.`, 400)
    }
    // Reports overhaul (3i) — a template is an unattended delivery channel:
    // the report's subscription tier is enforced at SAVE time as well (and
    // re-checked on every run through the gated handlers).
    await assertReportEntitlement(ctx, p.reportKey)
    // RPT-001 (Wave R3-3) — PII-class reports need THREE extra gates before
    // they can become an unattended nightly e-mail channel:
    //   1. the caller must hold reports.pii.schedule (FIN-081 — the split
    //      form of the HIGH-11 bulk-PII permission; a held legacy flat
    //      reports.pii is expanded to it in getCtxFromToken, so pre-split
    //      grants keep scheduling);
    //   2. every recipient must be a tenant member (user or employee e-mail) —
    //      external addresses turn the scheduler into a silent exfiltration
    //      pipe for biodata;
    //   3. recipients are re-checked at RUN time (scheduled-reports.ts) so a
    //      member who later leaves stops receiving PII reports.
    if (isPiiReportKey(p.reportKey)) {
      if (!ctx.permissions.has("reports.pii.schedule") && !ctx.permissions.has("reports.pii") && !ctx.permissions.has("*")) {
        throw new Deny(`"${p.reportKey}" contains bulk personal data (PII) — scheduling it requires the reports.pii.schedule permission. Contact your administrator.`, 403)
      }
    }
    // Phase 3 — recipient membership is validated at SAVE for EVERY template
    // (the old gate covered PII keys only): an unattended e-mail channel is
    // an exfiltration pipe for aggregate numbers too, and the run-time
    // re-verification in scheduled-reports.ts mirrors this for members who
    // leave later.
    const outsiders = await nonMemberRecipients(ctx.vendorId, p.recipients ?? [])
    if (outsiders.length) {
      throw new Deny(`${isPiiReportKey(p.reportKey) ? "PII report" : "Report"} recipients must be members of this organization — these addresses have no user or employee account here: ${outsiders.join(", ")}`, 400)
    }
    // Phase 3 — a structured report's filters are validated against ITS
    // definition at save time (unknown enum values rejected now, not at 2am
    // in the scheduler).
    const def = reportDefinition(p.reportKey)
    if (def) {
      const { validateFilters } = await import("../analytics-report")
      validateFilters(def, (p.filters ?? {}) as any)
    }
    const filters = p.filters ?? {}
    const recipients = p.recipients ?? []
    const base = {
      reportKey: p.reportKey,
      name: p.name,
      filtersJson: JSON.stringify(filters),
      format: p.format,
      schedule: p.schedule,
      recipientsJson: JSON.stringify(recipients),
      active: p.active,
    }
    // MULTI-COMPANY — templates belong to the ACTIVE company (the scheduler
    // renders them in that company's context); the name probe is company-scoped.
    const tplCompanyId = ctx.activeCompanyId ?? null
    const existing = p.id
      ? await db.reportTemplate.findFirst({ where: { id: p.id, vendorId: ctx.vendorId, ...(ctx.activeCompanyId && !ctx.allCompaniesMode ? { companyId: ctx.activeCompanyId } : {}) } })
      : await db.reportTemplate.findFirst({ where: { vendorId: ctx.vendorId, companyId: tplCompanyId, name: p.name } })
    if (p.id && !existing) throw new Deny("Template not found", 404)
    let saved: NonNullable<Awaited<ReturnType<typeof db.reportTemplate.findFirst>>>
    if (existing) {
      saved = await db.reportTemplate.update({ where: { id: existing.id }, data: base })
    } else {
      try {
        saved = await db.reportTemplate.create({
          data: { ...base, vendorId: ctx.vendorId, companyId: tplCompanyId, createdById: ctx.userId, createdByName: ctx.userName },
        })
      } catch (e: any) {
        // P2002 = the name-unique raced between our findFirst and create
        if (String(e?.code) === "P2002") throw new Deny(`A template named "${p.name}" already exists`, 409)
        throw e
      }
    }
    await audit(ctx, "REPORT_TEMPLATE_SAVE", "ReportTemplate", saved.id,
      `Saved report template "${saved.name}" (${saved.reportKey}, ${saved.format}, ${saved.schedule}, ${recipients.length} recipient(s), ${saved.active ? "active" : "inactive"})`)
    return { template: templateWithJsonParsed(saved) }
  },
})

route("reports.templates.delete", {
  perm: ["reports", "schedule"],
  schema: z.object({ id: z.string().trim().min(1).max(64) }).strict(),
  handler: async (ctx, p) => {
    const t = await db.reportTemplate.findFirst({ where: { id: p.id, vendorId: ctx.vendorId, ...(ctx.activeCompanyId && !ctx.allCompaniesMode ? { companyId: ctx.activeCompanyId } : {}) } })
    if (!t) throw new Deny("Template not found", 404)
    // Soft delete: the row goes, but ReportDeliveryLog keeps the denormalized
    // templateName/reportKey so the delivery history stays readable forever.
    await db.reportTemplate.delete({ where: { id: t.id } })
    await audit(ctx, "REPORT_TEMPLATE_DELETE", "ReportTemplate", t.id,
      `Deleted report template "${t.name}" (${t.reportKey}, ${t.schedule}) — delivery history retained`)
    return { ok: true }
  },
})

route("reports.templates.runNow", {
  perm: ["reports", "schedule"],
  schema: z.object({ id: z.string().trim().min(1).max(64) }).strict(),
  handler: async (ctx, p) => {
    // Reports overhaul (3i) — the tier gate applies to on-demand runs too:
    // resolve the template's reportKey first (bare legacy key or structured
    // id — reportMetaOf handles both spellings).
    const t = await db.reportTemplate.findFirst({ where: { id: p.id, vendorId: ctx.vendorId, ...(ctx.activeCompanyId && !ctx.allCompaniesMode ? { companyId: ctx.activeCompanyId } : {}) } })
    if (!t) throw new Deny("Template not found", 404)
    await assertReportEntitlement(ctx, t.reportKey)
    // Lazy import: scheduled-reports.ts statically imports THIS module (for
    // renderReportForVendor), so importing it statically here would close a
    // module cycle. Resolved at call time, cached by the runtime.
    const { runReportTemplate } = await import("../scheduled-reports")
    const out = await runReportTemplate(ctx.vendorId, p.id)
    await audit(ctx, "REPORT_TEMPLATE_RUN", "ReportTemplate", p.id,
      `Ran report template "${out.templateName}" on demand — ${out.status}${out.detail ? ` (${out.detail})` : ""}${out.rows != null ? `, ${out.rows} rows` : ""}`)
    return { status: out.status, detail: out.detail ?? null, rows: out.rows ?? null }
  },
})

// ================= ANALYTICS (spec §17.6) =================
route("analytics.all", {
  perm: ["analytics", "view"],
  handler: async (ctx) => {
    // FIN-024 (Phase 2) — the workforce query (and every employee-joined
    // aggregate below) now runs through employeeScopeFilter(ctx).
    // BRANCH_MANAGER / DEPT_MANAGER templates grant analytics.view, and
    // dashboard.stats + report handlers deliberately scope for them —
    // analytics.all alone used to query vendor-wide, so the same manager got
    // a scoped dashboard plus unscoped turnover, NET PAYROLL per
    // branch/department, named top/low performers and KPI achievement.
    // For unscoped callers (HR_ADMIN / VENDOR_OWNER) the filter is just
    // { vendorId } — byte-identical semantics to the previous query, so the
    // analytics characterization golden is unaffected.
    const scope = employeeScopeFilter(ctx)
    const scoped = !!(scope.branchId || scope.departmentId)
    const emps = await db.employee.findMany({ where: scope })
    const scopedIds = emps.map((e) => e.id)
    // employee-joined where fragments: vendor-wide for unscoped callers
    // (identical rows), the caller's visible employee set when scoped.
    const empWhere = scoped ? { vendorId: ctx.vendorId, employeeId: { in: scopedIds } } : { vendorId: ctx.vendorId }
    // MULTI-COMPANY — org axes are the ACTIVE company's
    const branches = await db.branch.findMany({ where: { vendorId: ctx.vendorId, ...(ctx.activeCompanyId && !ctx.allCompaniesMode ? { companyId: ctx.activeCompanyId } : {}) } })
    const depts = await db.department.findMany({ where: { vendorId: ctx.vendorId, ...(ctx.activeCompanyId && !ctx.allCompaniesMode ? { companyId: ctx.activeCompanyId } : {}) } })
    const t = today()

    // workforce: headcount trend (net of exits), turnover, avg tenure, growth
     
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- audited TODO(H-20 paydown): convert to an explicit null check
    const joined = emps.filter((e) => e.joiningDate).sort((a, b) => a.joiningDate!.localeCompare(b.joiningDate!))
    const exits = await db.resignation.findMany({ where: { ...empWhere, status: { in: ["ACCEPTED", "COMPLETED"] } } as any })
    // RPT-03 — exit month per employee: resignation LWD when recorded, else
    // the status-update month (headcountMovement parity); the old code added
    // the all-time terminated count to EVERY historical month.
    const lwdByEmpA = new Map<string, string>()
    for (const r of exits) lwdByEmpA.set(r.employeeId, r.actualLwd || r.proposedLwd || "")
    const exitMonths = emps
      .filter((e) => ["RESIGNED", "TERMINATED", "RETIRED"].includes(e.status))
      .map((e) => lwdByEmpA.get(e.id) || e.updatedAt?.toISOString().slice(0, 7) || "")
      .filter(Boolean)
    const headcount = Array.from({ length: 12 }, (_, i) => {
      const d = new Date()
      d.setMonth(d.getMonth() - (11 - i))
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`
      const joinedBy = emps.filter((e) => e.joiningDate && e.joiningDate.slice(0, 7) <= key).length
      const exitedBy = exitMonths.filter((m) => m <= key).length
      return { period: `${monthName(d.getMonth() + 1).slice(0, 3)} ${String(d.getFullYear()).slice(2)}`, value: Math.max(0, joinedBy - exitedBy) }
    })
    // RPT-08 — turnover is the TRAILING-12-MONTH annualized rate: exits in the
    // last 12 months ÷ average headcount over the window (the old all-time
    // exits ÷ current-directory size had no period and no average denominator).
    const t12 = addDays(t, -365)
    const exits12 = exitMonths.filter((m) => m >= t12.slice(0, 7)).length
    const activeNow = emps.filter((e) => !["RESIGNED", "TERMINATED", "RETIRED", "TRANSFERRED"].includes(e.status)).length
    const hcFirst = headcount[0]?.value || activeNow
    const avgHeadcount = Math.max(1, Math.round((hcFirst + activeNow) / 2))
    const turnover = Math.round((exits12 / avgHeadcount) * 1000) / 10
    const turnoverDetail = { exits: exits12, windowMonths: 12, avgHeadcount, definition: "trailing-12-month exits ÷ average headcount", windowFrom: t12 }
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- audited TODO(H-20 paydown): convert to an explicit null check
    const avgTenure = joined.length ? Math.round(joined.reduce((s, e) => s + daysBetween(e.joiningDate!, t), 0) / joined.length / 30) : 0
    const last12 = headcount.slice(-1)[0]?.value || emps.length
    const prev12 = headcount.slice(-2, -1)[0]?.value || last12
    const growthRate = prev12 ? Math.round(((last12 - prev12) / prev12) * 1000) / 10 : 0

    // attendance analytics: rate, absenteeism, late frequency, OT trend (6 months)
    // RPT-11 — the rate denominator: the active roster (employee-day basis)
    const activeRosterCount = Math.max(1, emps.filter((e) => !["RESIGNED", "TERMINATED", "RETIRED", "TRANSFERRED"].includes(e.status)).length)
    const attTrend: any[] = []
    for (let i = 5; i >= 0; i--) {
      const d = new Date()
      d.setMonth(d.getMonth() - i)
      const prefix = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`
      const recs = await db.attendance.findMany({ where: { ...(empWhere as any), date: { startsWith: prefix } } })
      attTrend.push({
        period: `${monthName(d.getMonth() + 1).slice(0, 3)}`,
        // RPT-11 — the canonical employee-day rate (present-ish ÷ active
        // roster); was present-over-records counting leave/holidays as attended
        rate: attendanceRatePct(recs.filter((r) => rateCountedStatus(r.status)).length, activeRosterCount),
        absent: recs.filter((r) => r.status === "ABSENT").length,
        late: recs.filter((r) => r.status === "LATE").length,
        otHours: Math.round(recs.reduce((s, r) => s + (r.overtimeMinutes || 0), 0) / 60),
        workingHours: Math.round(recs.reduce((s, r) => s + (r.workingMinutes || 0), 0) / 60),
      })
    }

    // payroll analytics — real per-branch / per-department sums from paid entries
    // FIN-024 — every sum below runs over the caller's visible employees only
    // (empById holds the scoped roster, so out-of-scope entries match no
    // branch/department); trend + per-employee are recomputed from the scoped
    // entries for scoped callers instead of vendor-wide run totals.
    // MULTI-COMPANY — payroll analytics aggregate the ACTIVE company's runs
    const rawRuns = await db.payrollRun.findMany({ where: { vendorId: ctx.vendorId, ...(ctx.activeCompanyId && !ctx.allCompaniesMode ? { companyId: ctx.activeCompanyId } : {}), status: "PAID" }, orderBy: [{ periodYear: "asc" }, { periodMonth: "asc" }] })
    // FIN-082 (Phase 4) — paisa-authoritative read boundary (see money.ts).
    const runs = rawRuns.map((r) => withAuthoritativeMoney(r as unknown as Record<string, unknown>, RUN_MONEY_FIELDS) as typeof r)
    const lastRun = runs[runs.length - 1]
    const payrollByBranch: { name: string; value: number }[] = []
    const payrollByDepartment: { name: string; value: number }[] = []
    let lastRunEntries: any[] = []
    if (lastRun) {
      // FIN-082 (Phase 4) — paisa-authoritative entries (see money.ts).
      const entries = (await db.payrollEntry.findMany({ where: { runId: lastRun.id } }))
        .map((e) => withAuthoritativeMoney(e as unknown as Record<string, unknown>, ENTRY_MONEY_FIELDS) as typeof e)
      lastRunEntries = entries
      const empById = new Map(emps.map((e) => [e.id, e]))
      for (const b of branches) {
        const value = Math.round(entries.filter((e) => empById.get(e.employeeId)?.branchId === b.id).reduce((s, e) => s + e.net, 0))
        if (value > 0) payrollByBranch.push({ name: b.name, value })
      }
      for (const d of depts) {
        const value = Math.round(entries.filter((e) => empById.get(e.employeeId)?.departmentId === d.id).reduce((s, e) => s + e.net, 0))
        if (value > 0) payrollByDepartment.push({ name: d.name, value })
      }
    }
    let perEmployee: number
    let payrollTrend: { period: string; gross: number; net: number; ait: number }[]
    if (!scoped) {
      perEmployee = runs.length ? Math.round(runs[runs.length - 1].totalNet / Math.max(1, runs[runs.length - 1].employeeCount)) : 0
      payrollTrend = runs.slice(-6).map((r) => ({ period: `${monthName(r.periodMonth).slice(0, 3)} ${String(r.periodYear).slice(2)}`, gross: r.totalGross, net: r.totalNet, ait: r.totalAit }))
    } else {
      // scoped caller: aggregate THE VISIBLE EMPLOYEES' entries of the last 6
      // paid runs (vendor-wide run totals would expose other branches' money)
      const trendRuns = runs.slice(-6)
      const trendEntries = trendRuns.length
        ? (await db.payrollEntry.findMany({ where: { runId: { in: trendRuns.map((r) => r.id) }, employeeId: { in: scopedIds } } }))
            .map((e) => withAuthoritativeMoney(e as unknown as Record<string, unknown>, ENTRY_MONEY_FIELDS) as typeof e) // FIN-082 (Phase 4) — paisa-authoritative
        : []
      const runKey = new Map(runs.map((r) => [r.id, `${r.periodYear}-${String(r.periodMonth).padStart(2, "0")}`]))
      const byPeriod = new Map<string, { gross: number; net: number; ait: number }>()
      for (const e of trendEntries) {
        const key = runKey.get(e.runId)
        if (!key) continue
        const acc = byPeriod.get(key) || { gross: 0, net: 0, ait: 0 }
        acc.gross += e.gross || 0
        acc.net += e.net || 0
        acc.ait += e.ait || 0
        byPeriod.set(key, acc)
      }
      payrollTrend = [...byPeriod.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([key, acc]) => {
          const [y, m] = key.split("-")
          return { period: `${monthName(Number(m)).slice(0, 3)} ${y.slice(2)}`, gross: Math.round(acc.gross), net: Math.round(acc.net), ait: Math.round(acc.ait) }
        })
      const lastScoped = lastRunEntries.filter((e) => scopedIds.includes(e.employeeId))
      perEmployee = lastScoped.length ? Math.round(lastScoped.reduce((s, e) => s + e.net, 0) / lastScoped.length) : 0
    }

    // performance analytics — top, LOW performers, department performance, trend
    // FIN-024 — reviews/KPIs are read through the same employee scope; the old
    // vendor-wide query leaked out-of-scope employees' ratings and KPI
    // achievement rows (as "—" named entries) to branch/department managers.
    const reviews = await db.performanceReview.findMany({ where: { ...(empWhere as any) } })
    // MULTI-COMPANY — the trend's cycle rows are the ACTIVE company's
    const cycles = await db.reviewCycle.findMany({ where: { vendorId: ctx.vendorId, ...(ctx.activeCompanyId && !ctx.allCompaniesMode ? { companyId: ctx.activeCompanyId } : {}) }, orderBy: { startDate: "asc" } })
    const rated = reviews.filter((r) => r.overallRating > 0)
    const topPerformers = rated.filter((r) => r.overallRating >= 4)
      .sort((a, b) => b.overallRating - a.overallRating)
      .map((r) => ({ name: emps.find((e) => e.id === r.employeeId)?.fullName || "—", rating: r.overallRating })).slice(0, 8)
    const lowPerformers = rated.filter((r) => r.overallRating <= 2)
      .sort((a, b) => a.overallRating - b.overallRating)
      .map((r) => ({ name: emps.find((e) => e.id === r.employeeId)?.fullName || "—", rating: r.overallRating })).slice(0, 8)
    const departmentPerformance = depts.map((d) => {
      const rs = rated.filter((r) => emps.find((e) => e.id === r.employeeId)?.departmentId === d.id)
      return { name: d.name, value: rs.length ? Math.round((rs.reduce((s, r) => s + r.overallRating, 0) / rs.length) * 10) / 10 : 0 }
    }).filter((x) => x.value > 0)
    const performanceTrend = cycles.map((c) => {
      const rs = rated.filter((r) => r.cycleId === c.id)
      return { period: c.name, value: rs.length ? Math.round((rs.reduce((s, r) => s + r.overallRating, 0) / rs.length) * 10) / 10 : 0 }
    }).filter((x) => x.value > 0)
    const kpis = await db.kpiAssignment.findMany({ where: { ...(empWhere as any), status: { in: ["SUBMITTED", "REVIEWED"] } } })
    const kpiAchievement = kpis.map((k) => {
      const results = j(k.resultsJson, [] as any[])
      const avg = results.length ? results.reduce((s, r) => s + (r.achievementPct || 0), 0) / results.length : 0
      return { name: emps.find((e) => e.id === k.employeeId)?.fullName || "—", achievementPct: Math.round(avg) }
    })

    // total employee cost = salary + OT + bonus + benefits + expense reimbursement + employer costs
    // FIN-024 — bonus/expense sums and the gross base are scoped; unscoped
    // callers keep the exact run-total arithmetic (golden parity).
    // MULTI-COMPANY — settings resolve for the ACTIVE company (payroll is
    // company-overridable)
    const employerPct = (await getSettings(ctx.vendorId, { companyId: ctx.activeCompanyId || undefined })).payroll.employerContributionPct
    const expenseTotal = await db.expenseClaim.aggregate({ where: { ...(empWhere as any), status: "REIMBURSED" }, _sum: { amount: true } })
    const bonusTotal = await db.bonus.aggregate({ where: { ...(empWhere as any), status: "PAID" }, _sum: { amount: true } })
    const costGrossBase = scoped
      ? lastRunEntries.filter((e) => scopedIds.includes(e.employeeId)).reduce((s, e) => s + (e.gross || 0), 0)
      : lastRun ? lastRun.totalGross : 0
    const costOtBase = scoped
      ? lastRunEntries.filter((e) => scopedIds.includes(e.employeeId)).reduce((s, e) => s + (e.otAmount || 0), 0)
      : lastRun ? lastRun.totalOt : 0
    // the employer contribution applies to the GROSS base only (parity with
    // the unscoped run-total arithmetic this replaces for scoped callers)
    const totalEmployeeCost = lastRun
      ? costGrossBase + costOtBase + (bonusTotal._sum.amount || 0) + (expenseTotal._sum.amount || 0) + costGrossBase * (employerPct / 100)
      : 0

    // HRM-020 — missing KPI cards: absenteeism rate, late frequency per employee
    // per month, and a working-hour trend series (avg hours/day over 6 months).
    const activeEmps = emps.filter((e) => ["ACTIVE", "PROBATION", "ON_LEAVE"].includes(e.status))
    const totalAbsent6m = attTrend.reduce((s, x) => s + x.absent, 0)
    const recCounts = await Promise.all(Array.from({ length: 6 }, (_, i) => {
      const d = new Date(); d.setMonth(d.getMonth() - (5 - i))
      const prefix = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`
      return db.attendance.count({ where: { ...(empWhere as any), date: { startsWith: prefix } } })
    }))
    const totalDays6m = recCounts.reduce((s, n) => s + n, 0)
    const totalLate6m = attTrend.reduce((s, x) => s + x.late, 0)
    const absenteeismRate = totalDays6m > 0 ? Math.round((totalAbsent6m / totalDays6m) * 1000) / 10 : 0
    const lateFrequency = activeEmps.length > 0 ? Math.round((totalLate6m / activeEmps.length / 6) * 10) / 10 : 0
    const workingHourTrend = attTrend.map((x: any) => ({
      period: x.period,
      avgHoursPerDay: recCounts[attTrend.indexOf(x)] > 0
        ? Math.round((x.workingHours / recCounts[attTrend.indexOf(x)]) * 10) / 10
        : 0,
    }))
    return {
      workforce: { headcount, turnover, turnoverDetail, avgTenureMonths: avgTenure, growthRate, byBranch: branches.map((b) => ({ name: b.name, value: emps.filter((e) => e.branchId === b.id).length })), byDepartment: depts.map((d) => ({ name: d.name, value: emps.filter((e) => e.departmentId === d.id).length })) },
      attendance: { attTrend, absenteeismRate, lateFrequency, workingHourTrend },
      payroll: { trend: payrollTrend, perEmployee, byBranch: payrollByBranch, byDepartment: payrollByDepartment },
      performance: { topPerformers, lowPerformers, departmentPerformance, performanceTrend, kpiAchievement, avgRating: rated.length ? Math.round((rated.reduce((s, r) => s + r.overallRating, 0) / rated.length) * 10) / 10 : 0 },
      cost: { totalEmployeeCost, employerPct, expenseReimbursed: expenseTotal._sum.amount || 0, bonusPaid: bonusTotal._sum.amount || 0 },
    }
  },
})

// ================= AUDIT TRAIL =================
route("audit.list", {
  perm: ["audit", "view"],
  // M-13 — cursor-based pagination: the old hardcoded limit-200 page silently
  // truncated long trails. Callers pass the last row's cursor (id) to fetch
  // the next page; the response carries nextCursor (null = end of trail).
  handler: async (ctx, p) => {
    const where: any = { vendorId: ctx.vendorId }
    if (p?.entity) where.entity = p.entity
    if (p?.userId) where.userId = p.userId
    if (p?.q) where.summary = { contains: p.q, mode: "insensitive" } // ILIKE — preserves SQLite search behavior on PG
    if (p?.from) where.createdAt = { gte: new Date(p.from) }
    if (p?.cursor) where.id = { lt: p.cursor }
    const pageSize = Math.min(Math.max(1, Number(p?.limit) || 50), 200)
    const list = await db.auditLog.findMany({ where, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: pageSize + 1 })
    const hasMore = list.length > pageSize
    const items = hasMore ? list.slice(0, pageSize) : list
    // R-02 (W1) — All Companies mode ships audit rows METADATA-ONLY: the
    // record-level diff payloads (oldValue/newValue/reason) carry content
    // from every company (permission diffs, salary changes…) and are
    // stripped in consolidated mode. Concrete-company mode is unchanged.
    // (Matrix §3.1 — the shape restriction ships WITH the gate.)
    if (ctx.allCompaniesMode === true) {
      return {
        items: items.map((r: any) => ({ ...r, oldValue: undefined, newValue: undefined, reason: undefined })),
        nextCursor: hasMore ? items[items.length - 1].id : null,
        pageSize,
      }
    }
    return { items, nextCursor: hasMore ? items[items.length - 1].id : null, pageSize }
  },
})

// ================= RBAC-105 / BTN-103 (Wave R3-5) — server-side audit export =================
// The audit.export permission was decorative: the Audit view's CSV button was
// generated CLIENT-side from the loaded (audit.view-gated) page, so revoking
// audit.export hid a button but gated nothing. This route makes the verb real:
// a full filtered export (capped) that requires audit.export, honors the same
// filters as audit.list, is formula-injection-safe (utils csv) and writes its
// OWN audit row — exporting the trail is itself a trail event.
route("audit.export", {
  perm: ["audit", "export"],
  schema: z.object({
    entity: z.string().optional(),
    userId: z.string().optional(),
    q: z.string().optional(),
    from: z.string().optional(),
  }).strict(),
  handler: async (ctx, p) => {
    const where: any = { vendorId: ctx.vendorId }
    if (p?.entity) where.entity = p.entity
    if (p?.userId) where.userId = p.userId
    if (p?.q) where.summary = { contains: p.q, mode: "insensitive" }
    if (p?.from) where.createdAt = { gte: new Date(p.from) }
    // bounded export — the trail stays paginated for reading; a bulk export
    // is capped at 50k rows so the payload and query cost stay predictable.
    const MAX_ROWS = 50_000
    const rows = await db.auditLog.findMany({ where, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: MAX_ROWS + 1 })
    const truncated = rows.length > MAX_ROWS
    const items = truncated ? rows.slice(0, MAX_ROWS) : rows
    const out = csv([
      // R-02 (W1) + FIN-019 (Phase 2) — the CompanyId column ships with the
      // M1 AuditLog.companyId attribution (matrix §3.2). Since Phase 2 every
      // writer stamps the active company and the historical rows were
      // backfilled (scripts/fin19-auditlog-backfill.mjs, honesty rule: a
      // default company only for single-company vendors, employee-anchored
      // attribution otherwise, never a guess). Rows that are STILL unattributed
      // are labeled "tenant-level" explicitly — the export carries no silent
      // NULL company attribution, and never a fabricated value.
      ["Timestamp", "User", "Action", "Entity", "Entity Id", "CompanyId", "Summary", "IP"],
      ...items.map((r: any) => [
        r.createdAt?.toISOString?.() || String(r.createdAt || ""),
        r.userName || r.userId || "",
        r.action || "",
        r.entity || "",
        r.entityId || "",
        (r as any).companyId || "tenant-level",
        r.summary || "",
        r.ip || "",
      ]),
    ])
    await audit(ctx, "audit.export", "AuditLog", null,
      `Exported ${items.length} audit entr${items.length === 1 ? "y" : "ies"}${truncated ? ` (capped at ${MAX_ROWS})` : ""} to CSV${p?.entity ? ` · entity ${p.entity}` : ""}${p?.from ? ` · since ${p.from}` : ""}`)
    return { fileName: `audit-trail-${today()}.csv`, csv: out, count: items.length, truncated }
  },
})

// ================= R16 — LOGIN AUDIT REPORT =================
route("audit.logins.list", {
  // permission: audit.view — the same gate as the action-trail tab. The
  // payload allows NO cross-tenant ids: rows are always scoped to the
  // caller's vendorId (the owner plane is visible only in the SaaS owner
  // console's own audit surface).
  perm: ["audit", "view"],
  handler: async (ctx, p) => {
    const where: any = { plane: "TENANT", vendorId: ctx.vendorId }
    if (p?.success === true || p?.success === false) where.success = p.success
    if (p?.email) where.email = { contains: String(p.email).toLowerCase().trim(), mode: "insensitive" }
    if (p?.failureReason) where.failureReason = p.failureReason
    if (p?.userId) where.userId = p.userId
    if (p?.from || p?.to) {
      where.createdAt = {}
      if (p?.from) where.createdAt.gte = new Date(p.from)
      if (p?.to) where.createdAt.lte = new Date(`${p.to}T23:59:59.999Z`)
    }
    if (p?.ip) where.ip = { contains: p.ip }
    const pageSize = Math.min(Math.max(1, Number(p?.limit) || 50), 200)
    const [items, total, failedCount] = await Promise.all([
      db.loginAuditLog.findMany({ where, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: pageSize, skip: Number(p?.offset) || 0 }),
      db.loginAuditLog.count({ where }),
      db.loginAuditLog.count({ where: { ...where, success: false } }),
    ])
    // aggregated top-IPs for the brute-force lens (bounded)
    const topIps = await db.loginAuditLog.groupBy({
      by: ["ip"], where: { ...where, ip: { not: null } }, _count: { _all: true },
      orderBy: { _count: { ip: "desc" } }, take: 5,
    }).catch(() => [] as any[])
    return {
      items, total, failedCount,
      summary: {
        total,
        failed: failedCount,
        success: total - failedCount,
        retentionDays: null, // surfaced via settings.get (security tab) — kept here for the UI badge
      },
      topIps: (topIps as any[]).map((r) => ({ ip: r.ip, count: r._count?._all ?? r._count })),
      pageSize,
    }
  },
})

// ================= ACCOUNTING JOURNALS =================
route("journals.list", {
  perm: ["accounting", "view"],
  handler: async (ctx, p) => {
    // WP-F — refType + date filters + pagination (was: fixed 100 newest rows).
    // Wave 3 WP-B — POSTED journals only: this list feeds the Payroll →
    // Journals financial view, and DRAFT/PENDING_APPROVAL/REJECTED vouchers
    // are not money yet. The Accounting → Vouchers tab (accounting.vouchers.list)
    // shows every status with chips instead.
    // MULTI-COMPANY — the journal register is the ACTIVE company's book
    const where: any = { vendorId: ctx.vendorId, status: "POSTED", ...(ctx.activeCompanyId && !ctx.allCompaniesMode ? { companyId: ctx.activeCompanyId } : {}) }
    if (p?.refType) where.refType = p.refType
    if (p?.from || p?.to) {
      where.date = {}
      if (p?.from) where.date.gte = p.from
      if (p?.to) where.date.lte = p.to
    }
    const take = Math.min(Number(p?.limit) || 100, 300)
    const [list, total, refTypes] = await Promise.all([
      db.accountJournal.findMany({ where, orderBy: [{ date: "desc" }, { createdAt: "desc" }], take, skip: Number(p?.offset) || 0 }),
      db.accountJournal.count({ where }),
      // MULTI-COMPANY — filter chips list the ACTIVE company's refTypes
      db.accountJournal.findMany({ where: { vendorId: ctx.vendorId, ...(ctx.activeCompanyId && !ctx.allCompaniesMode ? { companyId: ctx.activeCompanyId } : {}) }, select: { refType: true }, distinct: ["refType"] }),
    ])
    return {
      journals: list.map((jr) => ({ ...jr, lines: j(jr.linesJson, []) })),
      total,
      refTypes: refTypes.map((r) => r.refType).sort(),
    }
  },
})

// ============ 2026-10 round §39–§41: Attendance Overview (security + methods) ============
// Server-authoritative aggregation for the upgraded attendance report:
// KPI cards, attendance trend, branch/department rates, method distribution,
// GPS + geo-fence compliance, suspicious trend and multiple check-in
// compliance. Totals come from the FULL filtered set (§79) — never the
// browser-visible page.
//
// Phase 2 reporting foundation — the aggregation below is extracted into
// attendanceOverviewData() so BOTH surfaces render THE SAME numbers: the
// legacy reports.attendanceOverview route (unchanged envelope for the
// existing UI + CSV twin) and the structured attendance.overview definition
// (AnalyticsReport contract: KPI definitions, previous-period comparison,
// methodology). Parity is by construction, not by re-implementation.
async function attendanceOverviewData(ctx: any, p: any) {
    // L-28 — caller-supplied ranges are capped (was: from=2000&to=2030 pulled
    // the whole attendance table into memory)
    const capped = capReportRange(p?.from || today(), p?.to || today())
    const from = capped.from
    const to = capped.to
    const scope = employeeScopeFilter(ctx)
    const employees = await db.employee.findMany({ where: { ...scope, status: { in: ["ACTIVE", "PROBATION", "ON_LEAVE", "SUSPENDED"] } }, select: { id: true, code: true, fullName: true, branchId: true, departmentId: true } })
    const empIds = employees.map((e) => e.id)

    // ---- SCL-11 (Phase 2 WS3): SQL aggregates ----
    // The handler used to load EVERY attendance row and EVERY attendance
    // event of the (capped) range into JS — up to 1.8M attendance rows for a
    // 366-day range — then ran dozens of full-array .filter() passes (every
    // KPI, every trend cell, every branch/dept cell was its own scan). The
    // same numbers now come from grouped/aggregate queries whose result size
    // is bounded by (dates × statuses) / (employees × statuses) / (methods ×
    // event types), never by row count. Semantics are preserved cell-for-
    // cell, including the subtle differences the old code had (KPI "present"
    // includes LATE/EARLY_LEAVE; trend "present" does not).
    const attWhere = { vendorId: ctx.vendorId, employeeId: { in: empIds }, date: { gte: from, lte: to } }
    const evWhere = {
      vendorId: ctx.vendorId, employeeId: { in: empIds },
      occurredAt: { gte: new Date(`${from}T00:00:00`), lte: new Date(`${to}T23:59:59.999`) },
    }
    const [
      attByDateStatus, attByEmpStatus, evByMethodType, evByGps, evByIntegrity,
      evByTypeFenced, evNoFenceCount, suspiciousEvRows, suspiciousCount,
    ] = await Promise.all([
      db.attendance.groupBy({ by: ["date", "status"], _count: { _all: true }, where: attWhere }),
      db.attendance.groupBy({ by: ["employeeId", "status"], _count: { _all: true }, where: attWhere }),
      db.attendanceEvent.groupBy({ by: ["attendanceMethod", "eventType"], _count: { _all: true }, where: evWhere }),
      db.attendanceEvent.groupBy({ by: ["gpsStatus"], _count: { _all: true }, where: evWhere }),
      db.attendanceEvent.groupBy({ by: ["locationIntegrityStatus"], _count: { _all: true }, where: evWhere }),
      // FIN-080 — located events WITH a geo-fence reference, per type
      db.attendanceEvent.groupBy({ by: ["eventType"], _count: { _all: true }, where: { ...evWhere, geoFenceId: { not: null } } }),
      // FIN-080 — located events with NO fence configured (gps located but
      // no fence was attached to the event)
      db.attendanceEvent.count({
        where: { ...evWhere, geoFenceId: null, OR: [{ gpsStatus: { not: null } }, { attendanceMethod: { in: ["GEOFENCE", "GEOFENCE_SELFIE"] } }] },
      }),
      // suspicious events are a tiny subset — the ONLY raw rows fetched
      // (occurredAt is needed per-day for the suspicious trend)
      db.attendanceEvent.findMany({
        where: { ...evWhere, status: { in: ["SUSPICIOUS", "REVIEW_REQUIRED"] } },
        select: { occurredAt: true },
      }),
      db.attendanceEvent.count({
        where: {
          ...evWhere,
          OR: [
            { status: { in: ["SUSPICIOUS", "REVIEW_REQUIRED"] } },
            { AND: [{ locationIntegrityStatus: { not: null } }, { locationIntegrityStatus: { not: "VERIFIED" } }] },
          ],
        },
      }),
    ])
    // MULTI-COMPANY — the branch/department rate rows are the ACTIVE company's
    const branches = await db.branch.findMany({ where: { vendorId: ctx.vendorId, ...(ctx.activeCompanyId && !ctx.allCompaniesMode ? { companyId: ctx.activeCompanyId } : {}) }, select: { id: true, name: true } })
    const depts = await db.department.findMany({ where: { vendorId: ctx.vendorId, ...(ctx.activeCompanyId && !ctx.allCompaniesMode ? { companyId: ctx.activeCompanyId } : {}) }, select: { id: true, name: true } })

    const NOT_COUNTED = ["ABSENT", "LEAVE", "LEAVE_UNPAID", "HOLIDAY", "WEEKLY_OFF"]
    const notCounted = (st: string) => !NOT_COUNTED.includes(st)

    // attendance lookups from the grouped rows
    const attCount = (status: string) => attByEmpStatus.filter((r) => r.status === status).reduce((s, r) => s + (r._count._all || 0), 0)
    const attCountDate = (date: string, status: string) => attByDateStatus.find((r) => r.date === date && r.status === status)?._count._all || 0
    const workDays = new Set(attByDateStatus.map((r) => r.date))
    const expected = Math.max(1, employees.length * Math.max(1, workDays.size))
    const notCountedTotal = attByEmpStatus.filter((r) => notCounted(String(r.status))).reduce((s, r) => s + (r._count._all || 0), 0)

    // event lookups from the grouped rows
    const evCount = (method: string | null, type?: string) =>
      evByMethodType.filter((r) => r.attendanceMethod === method && (type == null || r.eventType === type)).reduce((s, r) => s + (r._count._all || 0), 0)
    const evCountType = (type: string) => evByMethodType.filter((r) => r.eventType === type).reduce((s, r) => s + (r._count._all || 0), 0)
    const evGpsCount = (st: string) => evByGps.find((r) => r.gpsStatus === st)?._count._all || 0
    const suspiciousByDate = new Map<string, number>()
    for (const e of suspiciousEvRows) {
      const d = new Date(e.occurredAt).toISOString().slice(0, 10)
      suspiciousByDate.set(d, (suspiciousByDate.get(d) || 0) + 1)
    }

    // ---- KPI cards (§39) ----
    const kpis = {
      totalEmployees: employees.length,
      present: attCount("PRESENT") + attCount("LATE") + attCount("EARLY_LEAVE") + attCount("WFH") + attCount("BUSINESS_TRIP"),
      absent: attCount("ABSENT"),
      late: attCount("LATE"),
      earlyLeave: attCount("EARLY_LEAVE"),
      onLeave: attCount("LEAVE") + attCount("LEAVE_UNPAID"),
      geofenceAttendance: evCount("GEOFENCE", "CHECK_IN"),
      selfieAttendance: evCount("SELFIE", "CHECK_IN") + evCount("GEOFENCE_SELFIE", "CHECK_IN"),
      deviceAttendance: evCount("DEVICE_PUNCH"),
      multipleChecks: evCountType("PERIODIC_CHECK_IN") + evCountType("PERIODIC_VERIFICATION"),
      gpsViolations: evCountType("GPS_DISABLED") + evCountType("MANDATORY_GPS_VIOLATION"),
      suspiciousEvents: suspiciousCount,
      attendanceRate: attendanceRatePct(notCountedTotal, expected),
    }

    // ---- trend by date (§40 attendance trend + suspicious trend) ----
    const dates = [...workDays].sort()
    const trend = dates.map((d) => ({
      date: d,
      present: attCountDate(d, "PRESENT") + attCountDate(d, "WFH") + attCountDate(d, "BUSINESS_TRIP"),
      absent: attCountDate(d, "ABSENT"),
      late: attCountDate(d, "LATE"),
      suspicious: suspiciousByDate.get(d) || 0,
    }))

    // ---- branch / department rates (§41) ----
    // per-employee status counts (from the grouped rows) + the employee →
    // branch/dept map reproduce the old per-row filters exactly
    const statusCountsOfEmp = (employeeId: string) => {
      const out = new Map<string, number>()
      for (const r of attByEmpStatus) {
        if (r.employeeId !== employeeId) continue
        out.set(String(r.status), (out.get(String(r.status)) || 0) + (r._count._all || 0))
      }
      return out
    }
    const empStatusCounts = new Map(employees.map((e) => [e.id, statusCountsOfEmp(e.id)]))
    const orgStats = (orgKey: "branchId" | "departmentId", orgs: { id: string; name: string }[]) => orgs.map((o) => {
      const emps = employees.filter((e) => e[orgKey] === o.id)
      let presentC = 0, lateC = 0, absentC = 0
      for (const emp of emps) {
        for (const [st, n] of empStatusCounts.get(emp.id) || []) {
          if (notCounted(st)) presentC += n
          if (st === "LATE") lateC += n
          if (st === "ABSENT") absentC += n
        }
      }
      return {
        name: o.name,
        employees: emps.length,
        present: presentC,
        late: lateC,
        absent: absentC,
        rate: pct(presentC, Math.max(1, emps.length * Math.max(1, workDays.size))),
      }
    }).filter((x) => x.employees > 0).sort((a, b) => b.rate - a.rate)
    const branchStats = orgStats("branchId", branches)
    const departmentStats = orgStats("departmentId", depts).slice(0, 10)

    // ---- method distribution (§40 donut) ----
    const methodDistribution = ["GEOFENCE", "GEOFENCE_SELFIE", "SELFIE", "DEVICE_PUNCH", "MOBILE", "MANUAL", "ADMIN"].map((m) => ({
      name: m.replace(/_/g, " "),
      value: evCount(m),
    })).filter((x) => x.value > 0)

    // ---- compliance (§40 GPS compliance + geo-fence compliance) ----
    // FIN-080 — ONE classification pass over the located-event population,
    // three MUTUALLY EXCLUSIVE classes, so the donut slices always sum to
    // the population they are drawn from:
    //   no fence configured  — located event with geoFenceId = null (was
    //                          silently counted as "inside the fence")
    //   outside the fence    — geoFenceId set AND eventType is a fence
    //                          violation (GEOFENCE_VIOLATION; the legacy
    //                          OUTSIDE_GEOFENCE spelling is defended against)
    //   inside the fence     — geoFenceId set AND no violation type
    const FENCE_VIOLATION_TYPES = ["GEOFENCE_VIOLATION", "OUTSIDE_GEOFENCE"]
    const fencedCount = (types: string[]) => evByTypeFenced
      .filter((r) => types.includes(String(r.eventType)))
      .reduce((s, r) => s + (r._count._all || 0), 0)
    const outsideFence = fencedCount(FENCE_VIOLATION_TYPES)
    const insideFence = evByTypeFenced.reduce((s, r) => s + (r._count._all || 0), 0) - outsideFence
    const compliance = {
      gpsOk: evGpsCount("OK"),
      gpsDisabled: evGpsCount("DISABLED"),
      insideFence,
      outsideFence,
      noFenceConfigured: evNoFenceCount,
      locatedEvents: insideFence + outsideFence + evNoFenceCount,
    }
    const integrityDistribution = ["VERIFIED", "SUSPICIOUS", "MOCK_LOCATION", "IMPOSSIBLE_MOVEMENT", "STALE_LOCATION", "LOW_ACCURACY", "TIMESTAMP_ANOMALY", "DEVICE_MISMATCH"].map((st) => ({
      name: st.replace(/_/g, " "),
      value: evByIntegrity.find((r) => r.locationIntegrityStatus === st)?._count._all || 0,
    })).filter((x) => x.value > 0)

    return { kpis, trend, branchStats, departmentStats, methodDistribution, compliance, integrityDistribution, period: { from, to } }
}

// the legacy route (unchanged envelope — the existing UI, its CSV twin and
// every scheduled template keep working byte-for-byte)
route("reports.attendanceOverview", {
  perm: ["attendance", "view"],
  handler: async (ctx, p) => attendanceOverviewData(ctx, p),
})

/** CSV companion of reports.attendanceOverview (2026-10 round §39–§41):
 *  KPI summary + branch + department stats. Audited like every other export.
 *  Reports overhaul (3h) — the export permission is attendance.export (a
 *  dedicated export verb), not attendance.view: view must never be enough
 *  to take bulk data off the wire. */
route("reports.attendanceOverviewCsv", {
  perm: ["attendance", "export"],
  handler: async (ctx, p) => {
    // L-28 — caller-supplied ranges are capped (was: from=2000&to=2030 pulled
    // the whole attendance table into memory)
    const capped = capReportRange(p?.from || today(), p?.to || today())
    const from = capped.from
    const to = capped.to
    const scope = employeeScopeFilter(ctx)
    const employees = await db.employee.findMany({ where: { ...scope, status: { in: ["ACTIVE", "PROBATION", "ON_LEAVE", "SUSPENDED"] } }, select: { id: true } })
    const empIds = employees.map((e) => e.id)
    // SCL-11 (Phase 2 WS3) — the CSV twin had the same whole-range load; the
    // six status counters now come from one groupBy (identical semantics).
    const attWhere = { vendorId: ctx.vendorId, employeeId: { in: empIds }, date: { gte: from, lte: to } }
    const evWhere = { vendorId: ctx.vendorId, employeeId: { in: empIds }, occurredAt: { gte: new Date(`${from}T00:00:00`), lte: new Date(`${to}T23:59:59.999`) } }
    const [byStatus, events, suspicious] = await Promise.all([
      db.attendance.groupBy({ by: ["status"], _count: { _all: true }, where: attWhere }),
      db.attendanceEvent.count({ where: evWhere }),
      db.attendanceEvent.count({ where: { ...evWhere, status: { in: ["SUSPICIOUS", "REVIEW_REQUIRED"] } } }),
    ])
    const stCount = (st: string) => byStatus.find((r) => r.status === st)?._count._all || 0
    const totalRecords = byStatus.reduce((s, r) => s + (r._count._all || 0), 0)
    const rows: (string | number)[][] = [
      ["Metric", "Value"],
      ["Period", `${from} to ${to}`],
      ["Total employees", employees.length],
      ["Attendance records", totalRecords],
      ["Present", stCount("PRESENT") + stCount("LATE") + stCount("EARLY_LEAVE") + stCount("WFH") + stCount("BUSINESS_TRIP")],
      ["Absent", stCount("ABSENT")],
      ["Late", stCount("LATE")],
      ["Early leave", stCount("EARLY_LEAVE")],
      ["On leave", stCount("LEAVE") + stCount("LEAVE_UNPAID")],
      ["Attendance events (all methods)", events],
      ["Suspicious events", suspicious],
    ]
    await audit(ctx, "reports.attendanceOverview.csvExport", "Report", null, `Exported attendance overview CSV (${from} → ${to})`)
    return { csv: csv(rows) }
  },
})

// ============================================================================
// RPT-23 — the eight missing enterprise-standard reports (audit Phase R4).
// All registered through the SAME reportRoute factory: PII gating, CSV
// twins, scheduling and AI rendering are inherited, not re-implemented.
// ============================================================================

// ---- FIN-077 (Phase 1) — the corrected attrition engine ----
// Three defects fixed against the Phase 0 characterization baseline
// (tests/golden/analytics/phase0-baseline.json — its git diff IS the review
// artifact for which reported numbers moved, month by month):
//   1. exitMonthOf returned the resignation LWD as a FULL DATE ("2026-04-10")
//      and compared it for equality against a month slice ("2026-04") — never
//      equal, so resignation exits NEVER appeared in the Exits column of any
//      month (Phase 0 report §6.1; only the updatedAt fallback ever fired).
//   2. the updatedAt fallback invented exit months from row-touch timestamps
//      — a TERMINATED employee's exit month was "whenever someone last
//      edited the profile". Exit months now come from resignation/lifecycle
//      records ONLY (actualLwd || proposedLwd).
//   3. the rate divided by month-END headcount (joined-to-date − exited-to-
//      date); the RPT-08 definition is exits ÷ AVERAGE headcount. Average =
//      (start + end) ÷ 2 (the "minimum" form from the audit; a monthly
//      average needs daily snapshots that arrive with the Phase 3 workforce
//      snapshot tables).
// Terminal-status employees with NO lifecycle record cannot be attributed to
// any month: they are excluded from the population (not silently inflating
// the denominator forever) and SURFACED in meta.unattributedTerminal so the
// gap is visible and fixable instead of distorting every rate.
/** Employment window resolution shared by attrition + absenteeism (FIN-077/078):
 *  exit date comes from lifecycle records only — never a row timestamp. */
async function employmentWindows(ctx: any, scope: any) {
  const emps = await db.employee.findMany({ where: scope, select: { id: true, fullName: true, code: true, joiningDate: true, status: true, transferredOutDate: true } })
  const resignations = await db.resignation.findMany({
    where: { vendorId: ctx.vendorId, status: { in: ["ACCEPTED", "NOTICE_PERIOD", "COMPLETED"] } },
    select: { employeeId: true, actualLwd: true, proposedLwd: true },
  })
  const exitByEmp = new Map<string, string>()
  for (const r of resignations) {
    const lwd = r.actualLwd || r.proposedLwd || ""
    if (lwd) exitByEmp.set(r.employeeId, lwd)
  }
  const TERMINAL = ["RESIGNED", "TERMINATED", "RETIRED"]
  const population: { id: string; joiningDate: string; exitDate: string | null; transferredOut: boolean }[] = []
  const unattributedTerminal: { name: string; status: string }[] = []
  for (const e of emps) {
    if (!e.joiningDate) continue // no joining date → no employable window
    // a company transfer ends this window the day before it takes effect, but isn't an exit
    const transferredOut = !!e.transferredOutDate
    const exitDate = e.transferredOutDate ? addDays(e.transferredOutDate, -1) : exitByEmp.get(e.id) || null
    if (TERMINAL.includes(e.status) && !exitDate) {
      unattributedTerminal.push({ name: e.fullName || e.code || e.id, status: e.status })
      continue
    }
    population.push({ id: e.id, joiningDate: e.joiningDate, exitDate, transferredOut })
  }
  return { population, unattributedTerminal }
}

/** 1) Annualized attrition rate — trailing-12-month exits and rate per month
 *  (the headcountMovement report shows joiners/exits; this one shows the
 *  RATE with the RPT-08 definition: exits ÷ average headcount). */
reportRoute("attritionRate", async (ctx, p) => {
  const { year } = monthPrefixOf(p)
  // Reports overhaul (3j) — branchId/departmentId scope the employee set
  // behind the monthly headcount math (scoped like every other report).
  const scope: any = employeeScopeFilter(ctx)
  if (p?.branchId) scope.branchId = p.branchId
  if (p?.departmentId) scope.departmentId = p.departmentId
  const { population, unattributedTerminal } = await employmentWindows(ctx, scope)
  const months = Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, "0")}`)
  const rows = months.map((m) => {
    const monthStart = `${m}-01`
    const monthEnd = `${m}-${String(new Date(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 0).getDate()).padStart(2, "0")}`
    // employed AT a date: joined on/before it AND (no lifecycle exit OR exit
    // is on/after it — the LWD itself is a served day)
    const employedAt = (d: string) => population.filter((e) => e.joiningDate <= d && (e.exitDate == null || e.exitDate >= d)).length
    const startCount = employedAt(addDays(monthStart, -1))
    const endCount = employedAt(monthEnd)
    const avgHeadcount = (startCount + endCount) / 2
    const exitsInMonth = population.filter((e) => !e.transferredOut && e.exitDate && e.exitDate >= monthStart && e.exitDate <= monthEnd).length
    // annualized: exits this month × 12 ÷ AVERAGE headcount (RPT-08)
    const annualized = avgHeadcount > 0 ? Math.round((exitsInMonth * 12 / avgHeadcount) * 1000) / 10 : 0
    return [`${monthName(Number(m.slice(5, 7)))} ${year}`, startCount, endCount, avgHeadcount, exitsInMonth, `${annualized}%`]
  })
  const meta: any = {
    count: rows.length,
    year,
    note: "annualized rate = month exits × 12 ÷ average headcount, average = (start + end) ÷ 2; exit months from resignation/lifecycle LWD records only (RPT-08 definition, FIN-077)",
    kpiDefinition: "Annualized Attrition Rate = (exits in month × 12) ÷ ((headcount at month start + headcount at month end) ÷ 2)",
  }
  if (unattributedTerminal.length) {
    meta.unattributedTerminal = unattributedTerminal
    meta.warnings = [`${unattributedTerminal.length} former employee(s) carry a terminal status with no lifecycle record — they are excluded from this report. Record their exit in Resignation & Exit to attribute them.`]
  }
  return {
    columns: ["Month", "Headcount (start)", "Headcount (end)", "Avg Headcount", "Exits", "Annualized Attrition Rate"],
    rows,
    meta,
  }
})

/** 2) Age bands — workforce age distribution (enterprise standard). */
reportRoute("ageBands", async (ctx, p) => {
  const t = today()
  // Reports overhaul (3j) — branchId/departmentId scope the employee query.
  const emps = await db.employee.findMany({
    where: {
      ...employeeScopeFilter(ctx),
      ...(p?.branchId ? { branchId: p.branchId } : {}),
      ...(p?.departmentId ? { departmentId: p.departmentId } : {}),
      dob: { not: null },
    },
    select: { dob: true, status: true },
  })
  const BANDS = [["Under 25", 0, 25], ["25–34", 25, 35], ["35–44", 35, 45], ["45–54", 45, 55], ["55–59", 55, 60], ["60+", 60, 200]]
  const active = emps.filter((e) => !["RESIGNED", "TERMINATED", "RETIRED", "TRANSFERRED"].includes(e.status))
  const ageOf = (dob: string) => Math.floor((Date.parse(t) - Date.parse(dob)) / (365.25 * 86400000))
  const rows = BANDS.map(([label, lo, hi]) => {
    const n = active.filter((e) => { const a = ageOf(e.dob || ""); return a >= (lo as number) && a < (hi as number) }).length
    return [label, n, active.length ? `${Math.round((n / active.length) * 1000) / 10}%` : "—"]
  })
  return { columns: ["Age Band", "Employees", "Share"], rows, meta: { count: rows.length, basis: `ages as of ${t}` } }
})

/** 3) Tenure bands — service-length distribution. */
reportRoute("tenureBands", async (ctx, p) => {
  const t = today()
  // Reports overhaul (3j) — branchId/departmentId scope the employee query.
  const emps = await db.employee.findMany({
    where: {
      ...employeeScopeFilter(ctx),
      ...(p?.branchId ? { branchId: p.branchId } : {}),
      ...(p?.departmentId ? { departmentId: p.departmentId } : {}),
      joiningDate: { not: null },
    },
    select: { joiningDate: true, status: true },
  })
  const BANDS = [["Under 1 year", 0, 1], ["1–2 years", 1, 2], ["2–5 years", 2, 5], ["5–10 years", 5, 10], ["10+ years", 10, 100]]
  const active = emps.filter((e) => !["RESIGNED", "TERMINATED", "RETIRED", "TRANSFERRED"].includes(e.status))
  const yearsOf = (j: string) => (Date.parse(t) - Date.parse(j)) / (365.25 * 86400000)
  const rows = BANDS.map(([label, lo, hi]) => {
    const n = active.filter((e) => { const y = yearsOf(e.joiningDate || ""); return y >= (lo as number) && y < (hi as number) }).length
    return [label, n, active.length ? `${Math.round((n / active.length) * 1000) / 10}%` : "—"]
  })
  return { columns: ["Tenure Band", "Employees", "Share"], rows, meta: { count: rows.length, basis: `tenure as of ${t}` } }
})

/** 4) Absenteeism trend — absent days and rate per month, 12 months.
 *  FIN-078 (Phase 1) — two denominator corrections, pinned by the Phase 0
 *  characterization baseline first:
 *    - the employee set was fetched ONCE with TODAY's active-status filter
 *      and applied to all 12 months — a tenant that grew from 200 to 300
 *      had every early month understated by a third. The per-month
 *      population now follows joins and exits within each month.
 *    - the denominator was active-headcount × CALENDAR days (weekends
 *      included); it is now scheduled working employee-days — the
 *      employee's resolved weekly-off (employee > shift > vendor, the same
 *      canonical precedence payroll uses) and branch-aware holidays are
 *      excluded, and the employment window clips mid-month joiners/exiters.
 *    - the numerator only counts ABSENT rows on SCHEDULED working days —
 *      a six-day-week tenant no longer shows weekend absenteeism. */
reportRoute("absenteeismTrend", async (ctx, p) => {
  const { year } = monthPrefixOf(p)
  // Reports overhaul (3j) — branchId/departmentId scope the employee set
  // behind the monthly population math.
  const scope: any = employeeScopeFilter(ctx)
  if (p?.branchId) scope.branchId = p.branchId
  if (p?.departmentId) scope.departmentId = p.departmentId
  const { population, unattributedTerminal } = await employmentWindows(ctx, scope)
  // MULTI-COMPANY — settings + shifts resolve for the ACTIVE company
  const settings = await getSettings(ctx.vendorId, { companyId: ctx.activeCompanyId || undefined })
  const shifts = await db.shift.findMany({ where: { vendorId: ctx.vendorId, ...(ctx.activeCompanyId && !ctx.allCompaniesMode ? { companyId: ctx.activeCompanyId } : {}) }, select: { id: true, weeklyOff: true } })
  const shiftById = new Map(shifts.map((s) => [s.id, s]))
  // employee-level weekly-off + branch (for the holiday scope), resolved once
  const empMeta = await db.employee.findMany({
    where: { id: { in: population.map((e) => e.id) } },
    select: { id: true, weeklyOff: true, shiftId: true, branchId: true },
  })
  const offsById = new Map<string, string[]>()
  const branchById = new Map<string, string | null>()
  for (const e of empMeta) {
    offsById.set(e.id, resolveWeeklyOffDays(e.weeklyOff, shiftById.get(e.shiftId || "")?.weeklyOff || null, settings.general.weeklyHoliday))
    branchById.set(e.id, e.branchId)
  }
  // MULTI-COMPANY — the holiday denominator is the ACTIVE company's calendar
  // (tenant-wide null-companyId rows still apply)
  const holidays = await db.holiday.findMany({ where: { vendorId: ctx.vendorId, date: { startsWith: String(year) }, ...(ctx.activeCompanyId && !ctx.allCompaniesMode ? { OR: [{ companyId: ctx.activeCompanyId }, { companyId: null }] } : {}) }, select: { date: true, branchId: true } })
  // FIN-078 numerator: ABSENT rows per employee-day (grouped, never raw rows)
  const byEmpDate = await db.attendance.groupBy({
    by: ["employeeId", "date"], _count: { _all: true },
    where: { vendorId: ctx.vendorId, employeeId: { in: population.map((e) => e.id) }, status: "ABSENT", date: { startsWith: String(year) } },
  })
  const absentEmpDays = new Set<string>()
  for (const r of byEmpDate) absentEmpDays.add(`${r.employeeId}|${r.date}`)
  const rows = Array.from({ length: 12 }, (_, i) => {
    const m = String(i + 1).padStart(2, "0")
    const monthStart = `${year}-${m}-01`
    const daysInMonth = new Date(Number(year), i + 1, 0).getDate()
    const monthEnd = `${year}-${m}-${String(daysInMonth).padStart(2, "0")}`
    let absentDays = 0
    let scheduledDays = 0
    for (const e of population) {
      // per-month population from joins and exits: employed at any point of
      // the month (join ≤ month end AND (no exit OR exit ≥ month start))
      if (e.joiningDate > monthEnd) continue
      if (e.exitDate && e.exitDate < monthStart) continue
      const offs = offsById.get(e.id) || []
      const from = e.joiningDate > monthStart ? e.joiningDate : monthStart
      const to = e.exitDate && e.exitDate < monthEnd ? e.exitDate : monthEnd
      const branch = branchById.get(e.id) || null
      for (let ds = from; ds <= to; ds = addDays(ds, 1)) {
        if (offs.includes(WD[new Date(`${ds}T00:00:00Z`).getUTCDay()])) continue // weekly off
        if (holidays.some((h) => h.date === ds && (!h.branchId || h.branchId === branch))) continue // holiday
        scheduledDays += 1
        if (absentEmpDays.has(`${e.id}|${ds}`)) absentDays += 1
      }
    }
    // absenteeism rate: absent employee-days ÷ SCHEDULED working employee-days
    const rate = scheduledDays > 0 ? Math.round((absentDays / scheduledDays) * 1000) / 10 : 0
    return [`${monthName(i + 1)} ${year}`, absentDays, scheduledDays, `${rate}%`]
  })
  return {
    columns: ["Month", "Absent Employee-Days", "Scheduled Working Employee-Days", "Absenteeism Rate"],
    rows,
    meta: {
      count: rows.length, year,
      note: "rate = absent employee-days ÷ scheduled working employee-days (weekly-offs and holidays excluded); population follows joins and exits per month (FIN-078)",
      kpiDefinition: "Absenteeism Rate = ABSENT employee-days on scheduled working days ÷ scheduled working employee-days",
      unattributedTerminal: unattributedTerminal.length,
    },
  }
})

/** 5) OT cost (taka) — estimated overtime cost per employee for a month,
 *  tier-aware (weekday/weekly-off/holiday multipliers) on the payroll
 *  hourly basis (basic ÷ 208 hours).
 *  FIN-079 (Phase 1) — two trust fixes:
 *    - the estimate priced EVERY minute at the CURRENT ACTIVE structure's
 *      basic, so a mid-month revision repriced the whole month (and a
 *      not-yet-revised new hire priced at 0). The basic is now resolved
 *      EFFECTIVE-DATED per attendance date: the latest structure whose
 *      effectiveFrom ≤ date (same semantics as the payroll engine's
 *      effectiveFrom lte asOf lookup, applied per day).
 *    - nothing ever compared the estimate against what payroll actually
 *      paid. The report now carries a reconciliation column — payable OT
 *      from the period's non-draft, non-cancelled payroll runs (regular +
 *      adjustments) — plus a variance column and a meta warning beyond the
 *      5% threshold, so the estimate earns its trust instead of asserting
 *      it. The "estimated" labelling stays honest. */
reportRoute("otCost", async (ctx, p) => {
  const { prefix, month, year } = monthPrefixOf(p)
  const emps = await scopedEmployees(ctx, { ...p, status: undefined })
  // MULTI-COMPANY — settings resolve for the ACTIVE company
  const settings = await getSettings(ctx.vendorId, { companyId: ctx.activeCompanyId || undefined })
  const otRates = settings.otRates || { weekdayRate: 1.5, holidayRate: 2, weeklyOffRate: 2 } as any
  const recs = await db.attendance.findMany({
    where: { vendorId: ctx.vendorId, employeeId: { in: emps.map((e) => e.id) }, date: { startsWith: prefix }, overtimeMinutes: { gt: 0 } },
  })
  // FIN-079 — effective-dated structures: ACTIVE + SUPERSEDED (a superseded
  // row still prices the days it covered), resolved per attendance date
  const structures = await db.salaryStructure.findMany({
    where: { vendorId: ctx.vendorId, employeeId: { in: emps.map((e) => e.id) }, status: { in: ["ACTIVE", "SUPERSEDED"] } },
    orderBy: { effectiveFrom: "desc" },
  })
  /** Latest structure whose effectiveFrom ≤ date (null → no basic that day). */
  const basicOn = (employeeId: string, date: string): number => {
    for (const s of structures) {
      if (s.employeeId !== employeeId) continue
      if (s.effectiveFrom <= date) return Number(s.basic) || 0
    }
    return 0
  }
  // FIN-079 — reconciliation source: the period's payable OT per employee
  // MULTI-COMPANY — the reconciliation source is the ACTIVE company's runs
  const runs = await db.payrollRun.findMany({
    where: { vendorId: ctx.vendorId, ...(ctx.activeCompanyId && !ctx.allCompaniesMode ? { companyId: ctx.activeCompanyId } : {}), periodYear: year, periodMonth: month, frequency: "MONTHLY", status: { notIn: ["DRAFT", "CANCELLED"] } },
    select: { id: true, runType: true, adjustSeq: true, status: true },
  })
  const entries = runs.length ? await db.payrollEntry.findMany({
    where: { vendorId: ctx.vendorId, runId: { in: runs.map((r) => r.id) } },
    select: { employeeId: true, otAmount: true, otMinutes: true },
  }) : []
  const payrollOtByEmp = new Map<string, number>()
  for (const en of entries) payrollOtByEmp.set(en.employeeId, (payrollOtByEmp.get(en.employeeId) || 0) + Number(en.otAmount || 0))
  // MULTI-COMPANY — the holiday multiplier calendar is the ACTIVE company's
  // (tenant-wide null-companyId rows still apply)
  const holidays = await db.holiday.findMany({ where: { vendorId: ctx.vendorId, date: { startsWith: prefix }, ...(ctx.activeCompanyId && !ctx.allCompaniesMode ? { OR: [{ companyId: ctx.activeCompanyId }, { companyId: null }] } : {}) }, select: { date: true, branchId: true } })
  const wd = ["SUNDAY", "MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY"]
  // canonical weekly-off resolution (employee > shift > vendor), same as payroll
  const offsByEmp = new Map<string, string[]>()
  for (const e of emps as any[]) {
    offsByEmp.set(e.id, resolveWeeklyOffDays(e.weeklyOff, null, settings.general.weeklyHoliday))
  }
  const VARIANCE_THRESHOLD_PCT = 5
  const varianceWarnings: string[] = []
  const rows = emps.map((e: any) => {
    const mine = recs.filter((r) => r.employeeId === e.id)
    if (!mine.length) return null
    const offs = offsByEmp.get(e.id) || []
    let cost = 0, minutes = 0
    for (const r of mine) {
      const dow = wd[new Date(`${r.date}T00:00:00Z`).getUTCDay()]
      const isHoliday = holidays.some((h) => h.date === r.date && (!h.branchId || h.branchId === e.branchId))
      const mult = isHoliday ? otRates.holidayRate : offs.includes(dow) ? otRates.weeklyOffRate : otRates.weekdayRate
      // FIN-079 — the basic in force on the day the OT was worked
      const hourRate = basicOn(e.id, r.date) / 208
      cost += (r.overtimeMinutes / 60) * hourRate * mult
      minutes += r.overtimeMinutes
    }
    const payrollOt = Math.round(payrollOtByEmp.get(e.id) || 0)
    const variance = Math.round(cost) - payrollOt
    if (payrollOt > 0 && Math.abs(variance) > Math.round(payrollOt * VARIANCE_THRESHOLD_PCT / 100)) {
      varianceWarnings.push(`${e.fullName}: estimated ৳${Math.round(cost)} vs payroll ৳${payrollOt} (variance ৳${variance}, ${Math.round(Math.abs(variance) / payrollOt * 1000) / 10}% beyond ${VARIANCE_THRESHOLD_PCT}%)`)
    }
    return [e.fullName, Math.round(minutes / 60 * 10) / 10, Math.round(cost), payrollOt, variance, Math.round(cost * 100) / 100 === Math.round(cost) ? `৳${Math.round(cost).toLocaleString("en-IN")}` : `৳${Math.round(cost * 100) / 100}`]
  }).filter(Boolean) as (string | number)[][]

  const total = rows.reduce((s, r) => s + Number(r[2] || 0), 0)
  const payrollTotal = rows.reduce((s, r) => s + Number(r[3] || 0), 0)
  const meta: any = {
    count: rows.length, month: prefix, totalCost: Math.round(total), payrollOtTotal: payrollTotal,
    note: "hourly basis = effective-dated basic ÷ 208h; tier multipliers follow the vendor OT rates; Payroll OT = the period's non-draft, non-cancelled runs (regular + adjustments)",
    kpiDefinition: "Estimated OT Cost = Σ over OT minutes of (minutes ÷ 60) × (basic in force that day ÷ 208) × day-type multiplier",
    reconciliation: {
      runs: runs.length,
      varianceThresholdPct: VARIANCE_THRESHOLD_PCT,
      warnings: varianceWarnings,
    },
  }
  if (!runs.length) meta.reconciliation.noRun = `no calculated payroll run for ${prefix} — the Payroll OT column is ৳0 by absence, not by confirmation`
  return {
    columns: ["Employee", "OT Hours", "Estimated Cost (৳)", "Payroll OT (৳)", "Variance (৳)", "Formatted"],
    rows: rows.sort((a, b) => Number(b[2]) - Number(a[2])),
    meta,
  }
})

/** 6) Holiday calendar — the year's holidays with type and branch scope,
 *  plus an ICS export twin (enterprise standard). */
reportRoute("holidayCalendar", async (ctx, p) => {
  const { year } = monthPrefixOf(p)  // month unused by design (whole-year view)
  // MULTI-COMPANY — the calendar is the ACTIVE company's (tenant-wide rows
  // with null companyId still appear); branch scopes resolve in-company
  const holidays = await db.holiday.findMany({ where: { vendorId: ctx.vendorId, date: { startsWith: String(year) }, ...(ctx.activeCompanyId && !ctx.allCompaniesMode ? { OR: [{ companyId: ctx.activeCompanyId }, { companyId: null }] } : {}) }, orderBy: { date: "asc" } })
  const branches = await db.branch.findMany({ where: { vendorId: ctx.vendorId, ...(ctx.activeCompanyId && !ctx.allCompaniesMode ? { companyId: ctx.activeCompanyId } : {}) }, select: { id: true, name: true } })
  const rows = holidays.map((h) => [
    h.date, h.name, titleCase(h.type), h.branchId ? branches.find((b) => b.id === h.branchId)?.name || "—" : "All branches",
  ])
  return {
    columns: ["Date", "Holiday", "Type", "Scope"],
    rows,
    meta: { count: rows.length, year },
  }
})

/** 6b) Holiday calendar ICS twin — subscribable in Outlook/Google Calendar. */
route("reports.holidayCalendarIcs", {
  perm: ["reports", "export"],
  handler: async (ctx, p) => {
    const year = Number(p?.year || new Date().getUTCFullYear())
    // MULTI-COMPANY — the ICS export is the ACTIVE company's calendar (null
    // companyId rows are tenant-wide and stay)
    const holidays = await db.holiday.findMany({ where: { vendorId: ctx.vendorId, date: { startsWith: String(year) }, ...(ctx.activeCompanyId && !ctx.allCompaniesMode ? { OR: [{ companyId: ctx.activeCompanyId }, { companyId: null }] } : {}) }, orderBy: { date: "asc" } })
    const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n")
    const lines = [
      "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Finix HR//Holiday Calendar//EN", "CALSCALE:GREGORIAN",
      ...holidays.flatMap((h) => [
        "BEGIN:VEVENT",
        `UID:hol-${h.id}@finix-hr`,
        `DTSTAMP:${new Date().toISOString().replace(/[-:]/g, "").slice(0, 15)}Z`,
        `DTSTART;VALUE=DATE:${h.date.replace(/-/g, "")}`,
        `DTEND;VALUE=DATE:${h.date.replace(/-/g, "")}`,
        `SUMMARY:${esc(h.name)} (${titleCase(h.type)})`,
        "TRANSP:TRANSPARENT",
        "END:VEVENT",
      ]),
      "END:VCALENDAR",
    ]
    await audit(ctx, "reports.holidayCalendar.icsExport", "Report", null, `Exported holiday calendar ICS for ${year} (${holidays.length} holiday(s))`)
    return { ics: lines.join("\r\n"), filename: `holidays-${year}.ics` }
  },
})

/** 7) Payslip distribution audit — consolidated disbursement audit for a
 *  run: totals, payout-method splits and payslip-number integrity. */
reportRoute("payslipDistribution", async (ctx, p) => {
  const periodWeek = p?.periodWeek != null && p.periodWeek !== "" ? Number(p.periodWeek) : 0
  // MULTI-COMPANY — the audit renders the ACTIVE company's run for the period
  const run = await db.payrollRun.findFirst({
    where: { vendorId: ctx.vendorId, ...(ctx.activeCompanyId && !ctx.allCompaniesMode ? { companyId: ctx.activeCompanyId } : {}), periodMonth: Number(p?.month || 1), periodYear: Number(p?.year || new Date().getUTCFullYear()), periodWeek, status: { in: ["APPROVED", "PROCESSING", "PAID"] }, runType: "REGULAR" },
    orderBy: [{ calcEpoch: "desc" }, { createdAt: "desc" }],
  })
  if (!run) return { columns: ["No payable run for this period"], rows: [], meta: { run: null } }
  // Reports overhaul (3j) — branchId/departmentId/employmentType/status/
  // employeeId now scope the employee set (scopedEmployees), the same as the
  // payroll register; previously only the RBAC scope applied.
  const emps = await scopedEmployees(ctx, p)
  // FIN-082 (Phase 4) — paisa-authoritative read boundary (see money.ts):
  // the payslip-issue summary's money rows derive from the paisa shadows.
  const entries = (await db.payrollEntry.findMany({ where: { runId: run.id, employeeId: { in: emps.map((e) => e.id) } } }))
    .map((e) => withAuthoritativeMoney(e as unknown as Record<string, unknown>, ENTRY_MONEY_FIELDS) as typeof e)
  const authoritativeRun = withAuthoritativeMoney(run as unknown as Record<string, unknown>, RUN_MONEY_FIELDS) as typeof run
  const payouts = await resolveSalaryPayouts(entries.map((e) => e.employeeId))
  const byMethod: Record<string, { n: number; net: number }> = { BANK: { n: 0, net: 0 }, MFS: { n: 0, net: 0 }, CASH: { n: 0, net: 0 } }
  for (const e of entries) {
    const m = payouts.get(e.employeeId)?.method
    const k = m === "BANK" || m === "MFS" ? m : "CASH"
    byMethod[k].n++
    byMethod[k].net += e.net
  }
  const noSlip = entries.filter((e) => !e.payslipNumber).length
  const dupSlips = entries.length - new Set(entries.map((e) => e.payslipNumber).filter(Boolean)).size
  const rows: (string | number)[][] = [
    ["Run", `${run.periodYear}-${String(run.periodMonth).padStart(2, "0")}${run.periodWeek ? ` W${run.periodWeek}` : ""} (${run.status})`],
    ["Payslips issued", entries.length],
    ["Total gross (৳)", Math.round(authoritativeRun.totalGross)],
    ["Total net (৳)", Math.round(authoritativeRun.totalNet)],
    ["Bank transfers", `${byMethod.BANK.n} · ৳${Math.round(byMethod.BANK.net).toLocaleString("en-IN")}`],
    ["MFS payouts", `${byMethod.MFS.n} · ৳${Math.round(byMethod.MFS.net).toLocaleString("en-IN")}`],
    ["Cash payouts", `${byMethod.CASH.n} · ৳${Math.round(byMethod.CASH.net).toLocaleString("en-IN")}`],
    ["Payslips missing a number", noSlip],
    ["Duplicate payslip numbers", dupSlips],
  ]
  return { columns: ["Metric", "Value"], rows, meta: { count: rows.length, run: { id: run.id, status: run.status } } }
})

/** 8) Diversity over time — gender mix by joining cohort year. */
reportRoute("diversityOverTime", async (ctx, p) => {
  // Reports overhaul (3j) — branchId/departmentId scope the employee query;
  // year selects the joining cohort year the trend is computed over.
  const emps = await db.employee.findMany({
    where: {
      ...employeeScopeFilter(ctx),
      ...(p?.branchId ? { branchId: p.branchId } : {}),
      ...(p?.departmentId ? { departmentId: p.departmentId } : {}),
      joiningDate: { not: null },
      ...(p?.year != null ? { joiningDate: { startsWith: String(p.year) } } : {}),
    },
    select: { joiningDate: true, gender: true },
  })
  const byCohort = new Map<string, { male: number; female: number; other: number }>()
  for (const e of emps) {
    if (!e.joiningDate) continue
    const y = e.joiningDate.slice(0, 4)
    const cur = byCohort.get(y) || { male: 0, female: 0, other: 0 }
    const g = (e.gender || "").toUpperCase()
    if (g === "FEMALE") cur.female++
    else if (g === "MALE") cur.male++
    else cur.other++
    byCohort.set(y, cur)
  }
  const rows = [...byCohort.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([y, c]) => {
    const total = c.male + c.female + c.other
    return [y, total, c.male, c.female, c.other, total ? `${Math.round((c.female / total) * 1000) / 10}%` : "—"]
  })
  return {
    columns: ["Joining Year", "Joiners", "Male", "Female", "Other/Unspecified", "Female Share"],
    rows,
    meta: { count: rows.length, note: "gender mix by joining cohort — a hiring-diversity view, not a current-roster snapshot" },
  }
})

// ================= FIN-036 (Phase 3) — paid-period attendance rewrite register =================
// The reconciliation report for audited rewrites inside PAID payroll periods:
// every attendance.paidPeriodOverride audit row (manual overrides from the
// marking/cancel/leave paths AND the ZKTeco device rebuild path) with the
// before/after device rows carry. The payroll entry itself is immutable —
// this register is what tells payroll which paid days deserve an adjustment
// run review.
reportRoute("paidPeriodRewrites", async (ctx, p) => {
  const from = String(p?.from || addDays(today(), -90))
  const to = String(p?.to || today())
  if (from > to) throw new Deny("Invalid date range", 400)
  const rowsRaw = await db.auditLog.findMany({
    where: {
      vendorId: ctx.vendorId, action: "attendance.paidPeriodOverride",
      createdAt: { gte: new Date(`${from}T00:00:00Z`), lte: new Date(`${to}T23:59:59Z`) },
    },
    orderBy: { createdAt: "desc" },
    take: 1000,
  })
  const empIds = [...new Set(rowsRaw.map((r) => {
    const nv = j(r.newValue, {} as Record<string, unknown>)
    return typeof nv.employeeId === "string" ? nv.employeeId : String(r.entityId || "").split(":")[0]
  }))]
  // MULTI-COMPANY — employee names resolve inside the ACTIVE company (rows of
  // other companies fall back to the raw id prefix, never a name)
  const employees = empIds.length
    ? await db.employee.findMany({ where: { vendorId: ctx.vendorId, ...(ctx.activeCompanyId && !ctx.allCompaniesMode ? { companyId: ctx.activeCompanyId } : {}), id: { in: empIds } }, select: { id: true, fullName: true, code: true } })
    : []
  const rows = rowsRaw.map((r) => {
    const nv = j(r.newValue, {} as Record<string, unknown>)
    const employeeId = typeof nv.employeeId === "string" ? nv.employeeId : String(r.entityId || "").split(":")[0]
    const emp = employees.find((e) => e.id === employeeId)
    const date = typeof nv.date === "string" ? nv.date : (String(r.entityId || "").split(":")[1] || String(r.entityId || ""))
    const runId = typeof nv.runId === "string" ? nv.runId : "—"
    const week = nv.periodWeek ? `W${nv.periodWeek}` : ""
    const source = nv.source === "DEVICE" ? "Device rebuild" : "Manual override"
    const before = nv.before ? `${(nv.before as any).status ?? "—"}${(nv.before as any).checkIn ? ` ${(nv.before as any).checkIn}–${(nv.before as any).checkOut || ""}` : ""}` : "—"
    const after = nv.after ? `${(nv.after as any).status ?? "—"}${(nv.after as any).checkIn ? ` ${(nv.after as any).checkIn}–${(nv.after as any).checkOut || ""}` : ""}` : "—"
    return [
      new Date(r.createdAt).toISOString().slice(0, 16).replace("T", " "),
      emp ? `${emp.fullName}${emp.code ? ` (${emp.code})` : ""}` : employeeId.slice(0, 12),
      date,
      source,
      `${runId}${week ? ` ${week}` : ""}`,
      r.userName || "—",
      before,
      after,
    ] as (string | number)[]
  })
  return {
    columns: ["Recorded", "Employee", "Date", "Source", "Paid Run", "Actor", "Before", "After"],
    rows,
    meta: {
      count: rows.length,
      note: "audited rewrites of attendance inside PAID payroll periods (manual paid-period overrides and device rebuilds) — the payslip snapshot itself never changes; review these days and raise adjustment runs where the pay should change",
      from, to,
    },
  }
})

// ================= PHASE 2 REPORTING FOUNDATION — structured reports =================
// (new, Phase 2) — the AnalyticsReport contract surface. Three parts:
//
//   1. LEGACY ADAPTER — every reportRoute() handler registered above is also
//      exposed as a table-only structured definition (reportId
//      "legacy.<key>"). Rendering goes through the EXACT same handler the
//      RPC dispatcher uses, so PII gating (reports.pii.view), the CSV twin's
//      typed confirmation, scoping and every future fix are inherited for
//      free — migration is report-by-report with no cutover dead period.
//
//   2. TWO NATIVE DEFINITIONS — workforce.headcount and attendance.overview
//      render end-to-end through the new stack (KPIs from the shared metric
//      catalogue with definitions + previous-period comparison, purpose-
//      specified charts, tables, warnings, methodology), proving the
//      pipeline including exports.
//
//   3. ROUTES — analytics.report.catalog / .render / .renderCsv. The CSV is
//      produced from the SAME contract payload the UI renders (unified
//      export pipeline); the client-side XLSX builds from the same payload.

/** Render a legacy reportRoute handler (the adapter's data source). */
export function renderLegacyReport(key: string, ctx: any, p: any) {
  const fn = reportHandlers.get(key)
  if (!fn) throw new Deny(`Unknown report key: "${key}"`, 404)
  return fn(ctx, p)
}

/** The legacy adapter: wrap ONE reportRoute handler as a table-only
 *  AnalyticsReport definition. The legacy route's own permission gates stay
 *  authoritative (the adapter mirrors them so renderAnalyticsReport enforces
 *  the same pair). Reports overhaul (3b) — the definition's title /
 *  description / category / tier come from the HR Reports business metadata
 *  (report-meta.ts): business-friendly names, no "Legacy report —" prefixes,
 *  and the subscription tier that gates the catalog + renders. */
function legacyStructuredDefinition(key: string): ReportDefinition {
  const pii = reportPiiKeys.has(key)
  const meta = reportMetaOf(key)
  const scopeDescription = (ctx: any) => {
    const s = employeeScopeFilter(ctx)
    if (s.branchId) return "branch-scoped (branch manager visibility)"
    if (s.departmentId) return "department-scoped (department manager visibility)"
    return "whole organization (unscoped role)"
  }
  return {
    reportId: `legacy.${key}`,
    title: meta.title,
    description: meta.description,
    category: meta.category,
    tier: meta.tier,
    ...(meta.internal ? { internal: true } : {}),
    permission: pii ? ["reports", "pii.view"] : ["reports", "view"],
    exportPermission: pii ? ["reports", "pii.export"] : ["reports", "export"],
    pii,
    period: "range",
    comparisonSupported: false,
    filters: filterSpecOf(key, meta),
    filterFields: [...meta.filters],
    render: async (ctx, p) => {
      const { columns, rows, meta: handlerMeta } = await renderLegacyReport(key, ctx, p)
      const t = today()
      // FIN-083 convention — parseNumber, never Number(x) || <nonzero>
      const legacyMonth = String(Math.min(12, Math.max(1, parseNumber(p?.month, 1)))).padStart(2, "0")
      const legacyFrom = p?.from
        ? String(p.from)
        : p?.year
          ? `${p.year || t.slice(0, 4)}-${legacyMonth}-01`
          : t
      const report: AnalyticsReport = {
        contractVersion: 1,
        reportId: `legacy.${key}`,
        title: meta.title,
        generatedAt: new Date().toISOString(),
        period: {
          from: legacyFrom,
          to: String(p?.to || t),
          label: handlerMeta?.from ? `${handlerMeta.from} → ${handlerMeta.to}` : "as of today (legacy parameters)",
          comparison: null,
        },
        // Reports overhaul — mirror ONLY the caller-supplied FILTERS back
        // (reportId / format / confirm are job control, not filters — the
        // generate route strips the same keys before forwarding). A legacy
        // render with no filters mirrors {} so every export preamble
        // ("# Filters:" / "Applied filters:" / the XLSX info block) is
        // honestly OMITTED instead of echoing "reportId: legacy.employees".
        filters: Object.fromEntries(Object.entries(p || {}).filter(([k]) => k !== "confirm" && k !== "reportId" && k !== "format")),
        scope: { applied: !!(employeeScopeFilter(ctx).branchId || employeeScopeFilter(ctx).departmentId), description: scopeDescription(ctx) },
        kpis: [
          {
            key: "legacy.rows", label: "Rows", value: rows.length, unit: "count", local: true,
            definition: "Row count of the legacy table payload (meta.count when the handler supplies one).",
          },
        ],
        charts: [],
        table: {
          columns: columns.map((c: string) => ({ key: c, label: c })),
          rows: rows.map((r: any[]) => r.map((v) => (v == null ? null : typeof v === "object" ? String(v) : v))),
        },
        warnings: [
          "Data-table report. KPI cards and charts are available on analytics reports.",
          ...(handlerMeta?.note ? [`Handler note: ${handlerMeta.note}`] : []),
        ],
        methodology: {
          source: `Finix HR ${meta.category} reporting engine`,
          definitions: {},
          generatedBy: "HR Reports engine (contract v1)",
        },
      }
      return report
    },
  }
}
for (const key of [...reportHandlers.keys()]) {
  registerReport(legacyStructuredDefinition(key))
}

// ---------------- native definition: workforce.headcount ----------------
// Parity rule: the table rows are IDENTICAL to the legacy "headcount"
// reportRoute (same scopedEmployees query, same aggregation, same ordering);
// the contract adds the KPI layer (catalogue definitions + honest snapshot
// warning) and the distribution chart.
registerReport({
  reportId: "workforce.headcount",
  title: reportMetaOf("workforce.headcount").title,
  description: reportMetaOf("workforce.headcount").description,
  category: reportMetaOf("workforce.headcount").category,
  tier: reportMetaOf("workforce.headcount").tier,
  permission: ["reports", "view"],
  exportPermission: ["reports", "export"],
  pii: false,
  period: "snapshot",
  comparisonSupported: false,
  filters: filterSpecOf("workforce.headcount", reportMetaOf("workforce.headcount")),
  filterFields: [...reportMetaOf("workforce.headcount").filters],
  render: async (ctx, p) => {
    const dimension = String(p.dimension || "branch")
    const emps = await scopedEmployees(ctx, p)
    // MULTI-COMPANY — the grouping axes are the ACTIVE company's org rows
    const branches = await db.branch.findMany({ where: { vendorId: ctx.vendorId, ...(ctx.activeCompanyId && !ctx.allCompaniesMode ? { companyId: ctx.activeCompanyId } : {}) } })
    const depts = await db.department.findMany({ where: { vendorId: ctx.vendorId, ...(ctx.activeCompanyId && !ctx.allCompaniesMode ? { companyId: ctx.activeCompanyId } : {}) } })
    const label = (e: any): string => {
      switch (dimension) {
        case "department": return depts.find((d) => d.id === e.departmentId)?.name || "Unassigned"
        case "status": return titleCase(e.status)
        case "employmentType": return titleCase(e.employmentType)
        default: return branches.find((b) => b.id === e.branchId)?.name || "Unassigned"
      }
    }
    const agg = new Map<string, number>()
    for (const e of emps) agg.set(label(e), (agg.get(label(e)) || 0) + 1)
    const total = emps.length || 1
    const t = today()
    const active = emps.filter((e: any) => ["ACTIVE", "PROBATION", "ON_LEAVE"].includes(e.status)).length
    const scopeFilter = employeeScopeFilter(ctx)
    const scoped = !!(scopeFilter.branchId || scopeFilter.departmentId)
    return {
      contractVersion: 1,
      reportId: "workforce.headcount",
      title: reportMetaOf("workforce.headcount").title,
      generatedAt: new Date().toISOString(),
      period: { from: t, to: t, label: `as of ${t} (snapshot)`, comparison: null },
      filters: { dimension },
      scope: {
        applied: scoped,
        description: scoped
          ? (scopeFilter.branchId ? "branch-scoped (branch manager visibility)" : "department-scoped (department manager visibility)")
          : "whole organization (unscoped role)",
      },
      kpis: [
        kpi("headcount.total", emps.length),
        kpi("headcount.active", active),
      ],
      charts: [{
        key: "headcount.distribution",
        kind: "bar",
        title: `Headcount by ${titleCase(dimension === "employmentType" ? "employment type" : dimension)}`,
        purpose: "Shows where the people are — the concentration (or fragmentation) of the workforce across the selected dimension.",
        series: [{ name: "Headcount", points: [...agg.entries()].sort((a, b) => b[1] - a[1]).map(([k2, v]) => ({ label: k2, value: v })) }],
        note: "Unassigned = employees without the dimension set on their record.",
      }],
      table: {
        columns: [
          { key: "dim", label: titleCase(dimension === "employmentType" ? "employment type" : dimension), align: "left" },
          { key: "count", label: "Headcount", align: "right" },
          { key: "share", label: "% of Workforce", align: "right" },
        ],
        rows: [...agg.entries()].sort((a, b) => b[1] - a[1]).map(([k2, v]) => [k2, v, `${pct(v, total)}%`]),
      },
      warnings: [
        "Snapshot report: no prior-period comparison until monthly workforce snapshot tables land (roadmap Phase 3) — trend claims would be reconstructed history.",
        "Exited employees remain in the directory (and therefore this count) until archived; use the Status dimension for the working-roster view.",
      ],
      methodology: {
        source: "Employee records (scopedEmployees — the caller's visibility scope, same query as the legacy Headcount report)",
        definitions: { "headcount.total": "directory rows in scope", "headcount.active": "status ∈ ACTIVE / PROBATION / ON_LEAVE" },
        generatedBy: "structured report definition workforce.headcount (contract v1)",
      },
    }
  },
})

// ---------------- native definition: attendance.overview ----------------
// Parity rule: the underlying numbers come from attendanceOverviewData() —
// the SAME aggregation the legacy reports.attendanceOverview route serves —
// so the structured surface cannot disagree with the legacy one. The
// contract layer adds metric-catalogue definitions, the previous-period
// comparison (computed by re-running the aggregation over the comparison
// window), purpose-specified charts and the methodology block.
registerReport({
  reportId: "attendance.overview",
  title: reportMetaOf("attendance.overview").title,
  description: reportMetaOf("attendance.overview").description,
  category: reportMetaOf("attendance.overview").category,
  tier: reportMetaOf("attendance.overview").tier,
  permission: ["attendance", "view"],
  exportPermission: ["reports", "export"],
  pii: false,
  period: "range",
  comparisonSupported: true,
  filters: filterSpecOf("attendance.overview", reportMetaOf("attendance.overview")),
  filterFields: [...reportMetaOf("attendance.overview").filters],
  render: async (ctx, p) => {
    const from = String(p.from || today())
    const to = String(p.to || today())
    const data = await attendanceOverviewData(ctx, { from, to })
    // comparison window: explicit, else the immediately preceding period of
    // the same length
    const spanDays = Math.max(1, daysBetween(from, to) + 1)
    const cmpFrom = String(p.compareFrom || addDays(from, -spanDays))
    const cmpTo = String(p.compareTo || addDays(from, -1))
    let prev: Awaited<ReturnType<typeof attendanceOverviewData>> | null = null
    if (cmpFrom <= cmpTo) {
      prev = await attendanceOverviewData(ctx, { from: cmpFrom, to: cmpTo }).catch(() => null)
    }
    const prevVal = (k: keyof typeof data.kpis) => (prev ? (prev.kpis as any)[k] : null)
    const cmp = (k: keyof typeof data.kpis) => ({
      value: prevVal(k),
      deltaPct: deltaPct(Number(data.kpis[k]) || 0, Number(prevVal(k)) || 0),
    })
    const scopeFilter = employeeScopeFilter(ctx)
    const scoped = !!(scopeFilter.branchId || scopeFilter.departmentId)
    const warnings: string[] = []
    if (data.kpis.totalEmployees === 0) {
      warnings.push("No employees in scope for the selected period — every rate below is 0 by empty denominator, not by perfect attendance.")
    }
    if (data.compliance.locatedEvents > 0 && data.compliance.noFenceConfigured > 0) {
      warnings.push(`${data.compliance.noFenceConfigured} located punch(es) had no geo-fence attached — they are classified separately instead of silently counting as "inside the fence".`)
    }
    if (data.kpis.suspiciousEvents > 0) {
      warnings.push(`${data.kpis.suspiciousEvents} attendance event(s) are flagged suspicious/review-required — inspect them in Attendance → Security before treating the period as clean.`)
    }
    return {
      contractVersion: 1,
      reportId: "attendance.overview",
      title: reportMetaOf("attendance.overview").title,
      generatedAt: new Date().toISOString(),
      period: {
        from, to,
        label: `${from} → ${to}`,
        comparison: prev ? { from: cmpFrom, to: cmpTo, label: `${cmpFrom} → ${cmpTo}` } : null,
      },
      filters: { from, to },
      scope: {
        applied: scoped,
        description: scoped
          ? (scopeFilter.branchId ? "branch-scoped (branch manager visibility)" : "department-scoped (department manager visibility)")
          : "whole organization (unscoped role)",
      },
      kpis: [
        kpi("headcount.active", data.kpis.totalEmployees, { previous: cmp("totalEmployees") }),
        kpi("attendance.rate", data.kpis.attendanceRate, { previous: cmp("attendanceRate"), intent: "good-high" }),
        kpi("attendance.absent_days", data.kpis.absent, { previous: cmp("absent"), intent: "good-low" }),
        kpi("attendance.late", data.kpis.late, { previous: cmp("late"), intent: "good-low" }),
        kpi("attendance.on_leave_days", data.kpis.onLeave, { previous: cmp("onLeave") }),
        {
          key: "attendance.present_days", label: "Present employee-days", value: data.kpis.present, unit: "count", local: true,
          definition: "Attendance records with a present-ish status (PRESENT, LATE, EARLY_LEAVE, WFH, BUSINESS_TRIP) in the period — the KPI-card definition; the trend chart below uses the stricter PRESENT+WFH+BUSINESS_TRIP set, matching the legacy overview.",
          previous: cmp("present"),
        },
        {
          key: "attendance.suspicious", label: "Suspicious events", value: data.kpis.suspiciousEvents, unit: "count", local: true,
          definition: "Attendance events with status SUSPICIOUS/REVIEW_REQUIRED or a non-VERIFIED location-integrity verdict in the period.",
          previous: cmp("suspiciousEvents"), intent: "good-low",
        },
      ],
      charts: [
        {
          key: "attendance.trend",
          kind: "line",
          title: "Daily attendance trend",
          purpose: "Day-by-day present/absent/late movement — the shape that single-number KPIs hide (e.g. a mid-period spike).",
          series: [
            { name: "Present", points: data.trend.map((d: any) => ({ label: d.date, value: d.present })) },
            { name: "Absent", points: data.trend.map((d: any) => ({ label: d.date, value: d.absent })) },
            { name: "Late", points: data.trend.map((d: any) => ({ label: d.date, value: d.late })) },
          ],
          note: "Trend 'present' counts PRESENT + WFH + BUSINESS_TRIP (the legacy overview's stricter set).",
        },
        {
          key: "attendance.methods",
          kind: "donut",
          title: "Check-in method mix",
          purpose: "Which attendance channels the workforce actually uses — drives policy decisions (e.g. whether geo-fence coverage matters).",
          series: [{ name: "Events", points: data.methodDistribution.map((m: any) => ({ label: m.name, value: m.value })) }],
        },
        {
          key: "attendance.branch_rates",
          kind: "bar",
          title: "Attendance rate by branch",
          purpose: "Outlier branches at a glance — where to investigate before drawing organization-wide conclusions.",
          series: [{ name: "Rate %", points: data.branchStats.slice(0, 12).map((b: any) => ({ label: b.name, value: b.rate })) }],
          note: data.branchStats.length > 12 ? `Top 12 of ${data.branchStats.length} branches shown.` : undefined,
        },
      ],
      table: {
        columns: [
          { key: "branch", label: "Branch", align: "left" },
          { key: "employees", label: "Employees", align: "right" },
          { key: "present", label: "Present days", align: "right" },
          { key: "late", label: "Late days", align: "right" },
          { key: "absent", label: "Absent days", align: "right" },
          { key: "rate", label: "Attendance rate", align: "right" },
        ],
        rows: data.branchStats.map((b: any) => [b.name, b.employees, b.present, b.late, b.absent, `${b.rate}%`]),
      },
      warnings,
      methodology: {
        source: "Attendance records + attendance events over the period, employees restricted to ACTIVE/PROBATION/ON_LEAVE/SUSPENDED in the caller's visibility scope (attendanceOverviewData — shared with the legacy overview route)",
        definitions: {
          "attendance.rate": "not-counted records ÷ (employees × marked days), LEAVE/HOLIDAY/WEEKLY_OFF excluded from both sides, capped at 100%",
          "comparison window": prev ? `${cmpFrom} → ${cmpTo} (same length as the selected period)` : "not computed (invalid comparison window)",
        },
        generatedBy: "structured report definition attendance.overview (contract v1)",
      },
    }
  },
})

// ---------------- native definition: workforce.dashboard (Phase 3) ----------------
// The analytics workspace's flagship view — the roadmap's workforce dashboard:
// headcount and movement, joiners/exits/attrition, department and branch
// distribution, age and tenure bands, attendance and absenteeism, leave
// utilisation, and (permission-gated) payroll + overtime cost — every KPI
// carrying its formula and a prior-period comparison.
//
// Data sources, each the ONE authoritative implementation of its quantity:
//   · monthly WorkforceSnapshot series (movement, attrition, turnover, trend —
//     the FIN-077 structural fix: no more reconstructed history);
//   · scopedEmployees (distributions, age/tenure bands — the caller's scope);
//   · attendanceOverviewData (attendance rate/absenteeism — shared with the
//     attendance overview, RPT-11 canonical rate);
//   · PAID PayrollRun totals (cost trend — vendor-wide, gated on payroll.view
//     per the FIN-022 "not on the wire if never shown" discipline).
registerReport({
  reportId: "workforce.dashboard",
  title: reportMetaOf("workforce.dashboard").title,
  description: reportMetaOf("workforce.dashboard").description,
  category: reportMetaOf("workforce.dashboard").category,
  tier: reportMetaOf("workforce.dashboard").tier,
  permission: ["reports", "view"],
  exportPermission: ["reports", "export"],
  pii: false,
  period: "range",
  comparisonSupported: true,
  filters: filterSpecOf("workforce.dashboard", reportMetaOf("workforce.dashboard")),
  filterFields: [...reportMetaOf("workforce.dashboard").filters],
  render: async (ctx, p) => {
    const t = today()
    // default window: the first day of the month 11 months back → today
    // (a rolling 12-month view, aligned to snapshot months)
    const defaultFrom = (() => {
      const d = new Date(`${t}T00:00:00Z`)
      d.setUTCMonth(d.getUTCMonth() - 11)
      return `${d.toISOString().slice(0, 7)}-01`
    })()
    const from = String(p.from || defaultFrom)
    const to = String(p.to || t)
    const spanDays = Math.max(1, daysBetween(from, to) + 1)
    const cmpFrom = String(p.compareFrom || addDays(from, -spanDays))
    const cmpTo = String(p.compareTo || addDays(from, -1))

    const scopeFilter = employeeScopeFilter(ctx)
    const scoped = !!(scopeFilter.branchId || scopeFilter.departmentId)
    const scopeDescription = scoped
      ? (scopeFilter.branchId ? "branch-scoped (branch manager visibility)" : "department-scoped (department manager visibility)")
      : "whole organization (unscoped role)"
    const warnings: string[] = []

    // ---- snapshot series (movement, attrition, turnover, trend) ----
    const { workforceSnapshotSeries } = await import("../workforce-snapshots")
    const series = await workforceSnapshotSeries(ctx.vendorId, 24)
    const monthKey = (y: number, m: number) => `${y}-${String(m).padStart(2, "0")}`
    const inWindow = (fromIso: string, toIso: string) => series.filter((s) => {
      const k = monthKey(s.periodYear, s.periodMonth)
      return k >= fromIso.slice(0, 7) && k <= toIso.slice(0, 7)
    })
    const win = inWindow(from, to)
    const cmpWin = inWindow(cmpFrom, cmpTo)
    if (series.length === 0) {
      warnings.push("No monthly workforce snapshots yet — movement, attrition and turnover are 0 by absence of data, not by absence of movement. Run the twelve-month backfill (analytics.snapshots.backfill) once; live captures then freeze each month as it closes.")
    } else if (win.length === 0) {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- audited TODO(H-20 paydown): Phase 3 analytics/PDF/commission surface, index/lookup guarded by construction
      warnings.push(`The selected period (${from} → ${to}) has no snapshot months — the series covers ${series[0]!.label} → ${series[series.length - 1]!.label}. Adjust the period or extend the backfill.`)
    }
    if (scoped) {
      warnings.push("Snapshot-based movement KPIs (joiners, exits, attrition, turnover, trend) are VENDOR-WIDE — the snapshot series is not per-branch/department. Distribution, age, tenure and attendance KPIs honour the caller's scope.")
    }

    const sumOf = (rows: typeof series, f: (s: (typeof series)[number]) => number) => rows.reduce((s, r) => s + f(r), 0)
    const joiners = sumOf(win, (s) => s.newJoiners)
    const exits = sumOf(win, (s) => s.exits)
    const cmpJoiners = cmpWin.length ? sumOf(cmpWin, (s) => s.newJoiners) : null
    const cmpExits = cmpWin.length ? sumOf(cmpWin, (s) => s.exits) : null
    // attrition: exits ÷ average headcount over the window ((first + last) ÷ 2)
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- audited TODO(H-20 paydown): Phase 3 analytics/PDF/commission surface, index/lookup guarded by construction
    const avgHeadcount = win.length >= 2 ? (win[0]!.headcountTotal + win[win.length - 1]!.headcountTotal) / 2 : null
    const attrition = avgHeadcount && avgHeadcount > 0 ? Math.round((exits / avgHeadcount) * 1000) / 10 : null
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- audited TODO(H-20 paydown): Phase 3 analytics/PDF/commission surface, index/lookup guarded by construction
    const cmpAvgHeadcount = cmpWin.length >= 2 ? (cmpWin[0]!.headcountTotal + cmpWin[cmpWin.length - 1]!.headcountTotal) / 2 : null
    const cmpAttrition = cmpAvgHeadcount && cmpAvgHeadcount > 0 && cmpExits != null ? Math.round((cmpExits / cmpAvgHeadcount) * 1000) / 10 : null
    // trailing-12m turnover from the series tail
    const trailing = series.slice(-12)
    const t12Exits = sumOf(trailing, (s) => s.exits)
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- audited TODO(H-20 paydown): Phase 3 analytics/PDF/commission surface, index/lookup guarded by construction
    const t12Avg = trailing.length >= 2 ? (trailing[0]!.headcountTotal + trailing[trailing.length - 1]!.headcountTotal) / 2 : null
    const turnover = t12Avg && t12Avg > 0 ? Math.round((t12Exits / t12Avg) * 1000) / 10 : null
    // previous trailing-12m (shift one month earlier) for the comparison
    const trailingPrev = series.slice(-13, -1)
    const t12pExits = sumOf(trailingPrev, (s) => s.exits)
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- audited TODO(H-20 paydown): Phase 3 analytics/PDF/commission surface, index/lookup guarded by construction
    const t12pAvg = trailingPrev.length >= 2 ? (trailingPrev[0]!.headcountTotal + trailingPrev[trailingPrev.length - 1]!.headcountTotal) / 2 : null
    const turnoverPrev = t12pAvg && t12pAvg > 0 ? Math.round((t12pExits / t12pAvg) * 1000) / 10 : null

    // ---- live scoped roster (distributions, age/tenure, headcount now) ----
    const emps = await scopedEmployees(ctx, p)
    // MULTI-COMPANY — the distribution axes are the ACTIVE company's org rows
    const branches = await db.branch.findMany({ where: { vendorId: ctx.vendorId, ...(ctx.activeCompanyId && !ctx.allCompaniesMode ? { companyId: ctx.activeCompanyId } : {}) } })
    const depts = await db.department.findMany({ where: { vendorId: ctx.vendorId, ...(ctx.activeCompanyId && !ctx.allCompaniesMode ? { companyId: ctx.activeCompanyId } : {}) } })
    const dimension = String(p.dimension || "department")
    const dimLabel = (e: any): string => dimension === "branch"
      ? (branches.find((b) => b.id === e.branchId)?.name || "Unassigned")
      : (depts.find((d) => d.id === e.departmentId)?.name || "Unassigned")
    const dimAgg = new Map<string, number>()
    for (const e of emps) dimAgg.set(dimLabel(e), (dimAgg.get(dimLabel(e)) || 0) + 1)
    const activeNow = emps.filter((e: any) => ["ACTIVE", "PROBATION", "ON_LEAVE"].includes(e.status)).length

    // age bands (from dob; unknown bucket reported honestly)
    const ageOf = (e: any): number | null => e.dob ? Math.floor(daysBetween(e.dob, t) / 365.25) : null
    const ageBuckets: [string, number][] = [["< 25", 0], ["25–34", 0], ["35–44", 0], ["45–54", 0], ["55+", 0], ["Unknown", 0]]
    for (const e of emps) {
      const a = ageOf(e)
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- audited TODO(H-20 paydown): Phase 3 analytics/PDF/commission surface, index/lookup guarded by construction
      if (a == null) ageBuckets[5]![1]++
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- audited TODO(H-20 paydown): Phase 3 analytics/PDF/commission surface, index/lookup guarded by construction
      else if (a < 25) ageBuckets[0]![1]++
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- audited TODO(H-20 paydown): Phase 3 analytics/PDF/commission surface, index/lookup guarded by construction
      else if (a < 35) ageBuckets[1]![1]++
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- audited TODO(H-20 paydown): Phase 3 analytics/PDF/commission surface, index/lookup guarded by construction
      else if (a < 45) ageBuckets[2]![1]++
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- audited TODO(H-20 paydown): Phase 3 analytics/PDF/commission surface, index/lookup guarded by construction
      else if (a < 55) ageBuckets[3]![1]++
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- audited TODO(H-20 paydown): Phase 3 analytics/PDF/commission surface, index/lookup guarded by construction
      else ageBuckets[4]![1]++
    }
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- audited TODO(H-20 paydown): Phase 3 analytics/PDF/commission surface, index/lookup guarded by construction
    const unknownAges = ageBuckets[5]![1]
    // tenure bands (from joiningDate)
    const tenureYears = (e: any): number | null => e.joiningDate ? daysBetween(e.joiningDate, t) / 365.25 : null
    const tenureBuckets: [string, number][] = [["< 1y", 0], ["1–3y", 0], ["3–5y", 0], ["5–10y", 0], ["10y+", 0], ["Unknown", 0]]
    for (const e of emps) {
      const y = tenureYears(e)
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- audited TODO(H-20 paydown): Phase 3 analytics/PDF/commission surface, index/lookup guarded by construction
      if (y == null) tenureBuckets[5]![1]++
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- audited TODO(H-20 paydown): Phase 3 analytics/PDF/commission surface, index/lookup guarded by construction
      else if (y < 1) tenureBuckets[0]![1]++
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- audited TODO(H-20 paydown): Phase 3 analytics/PDF/commission surface, index/lookup guarded by construction
      else if (y < 3) tenureBuckets[1]![1]++
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- audited TODO(H-20 paydown): Phase 3 analytics/PDF/commission surface, index/lookup guarded by construction
      else if (y < 5) tenureBuckets[2]![1]++
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- audited TODO(H-20 paydown): Phase 3 analytics/PDF/commission surface, index/lookup guarded by construction
      else if (y < 10) tenureBuckets[3]![1]++
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- audited TODO(H-20 paydown): Phase 3 analytics/PDF/commission surface, index/lookup guarded by construction
      else tenureBuckets[4]![1]++
    }
    const avgTenureMonths = emps.length
      ? Math.round((emps.reduce((s: number, e: any) => s + (e.joiningDate ? daysBetween(e.joiningDate, t) / 30 : 0), 0) / emps.length) * 10) / 10
      : 0
    const avgAge = emps.some((e: any) => e.dob)
      ? Math.round((emps.reduce((s: number, e: any) => s + (e.dob ? daysBetween(e.dob, t) / 365.25 : 0), 0) / emps.filter((e: any) => e.dob).length) * 10) / 10
      : null

    // ---- attendance + absenteeism (the shared canonical aggregation) ----
    const att = await attendanceOverviewData(ctx, { from, to }).catch(() => null)
    const attPrev = cmpFrom <= cmpTo ? await attendanceOverviewData(ctx, { from: cmpFrom, to: cmpTo }).catch(() => null) : null
    const cmpAtt = (k: keyof NonNullable<typeof att>["kpis"]) => ({
      value: attPrev ? (attPrev.kpis as any)[k] : null,
      deltaPct: deltaPct(Number(att?.kpis[k] ?? 0), Number(attPrev ? (attPrev.kpis as any)[k] : 0)),
    })

    // ---- leave utilisation (fiscal leave year of the period end) ----
    // MULTI-COMPANY — settings resolve for the ACTIVE company
    const settings = await getSettings(ctx.vendorId, { companyId: ctx.activeCompanyId || undefined })
    const monthsArr = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"]
    const fyStartMonth = Math.max(0, monthsArr.indexOf(settings.general.fiscalYearStart || "July"))
    const { leaveYearOf } = await import("../leave-math")
    const leaveYear = leaveYearOf(to, fyStartMonth)
    const empIds = emps.map((e: any) => e.id)
    const balances = empIds.length
      ? await db.leaveBalance.findMany({ where: { employeeId: { in: empIds }, year: leaveYear } })
      : []
    const entitled = balances.reduce((s, b) => s + (b.entitled || 0) + (b.carriedForward || 0), 0)
    const used = balances.reduce((s, b) => s + (b.used || 0), 0)
    const leaveUtilisation = entitled > 0 ? Math.round((used / entitled) * 1000) / 10 : null

    // ---- payroll + OT cost (vendor-wide; FIN-022 permission gate on the wire) ----
    const canPayroll = ctx.permissions.has("*") || ctx.permissions.has("payroll.view")
    let payrollCost: number | null = null
    let otCost: number | null = null
    let cmpPayrollCost: number | null = null
    let cmpOtCost: number | null = null
    let payrollTrend: { label: string; value: number }[] = []
    if (canPayroll) {
      // MULTI-COMPANY — the cost blocks aggregate the ACTIVE company's runs
      const runs = await db.payrollRun.findMany({
        where: {
          vendorId: ctx.vendorId, ...(ctx.activeCompanyId && !ctx.allCompaniesMode ? { companyId: ctx.activeCompanyId } : {}), status: "PAID", runType: { in: ["REGULAR", "ADJUSTMENT"] },
          OR: [
            { periodYear: Number(from.slice(0, 4)), periodMonth: { gte: Number(from.slice(5, 7)) } },
            { periodYear: { gt: Number(from.slice(0, 4)), lt: Number(to.slice(0, 4)) } },
            { periodYear: Number(to.slice(0, 4)), periodMonth: { lte: Number(to.slice(5, 7)) } },
          ],
        },
        orderBy: [{ periodYear: "asc" }, { periodMonth: "asc" }, { periodWeek: "asc" }],
        // FIN-082 (Phase 4) — the sums run over the INTEGER-PAISA shadows
        // (exact bigint addition), never over summed doubles; the Float
        // display value is derived from the paisa total. A NULL shadow (a
        // legacy row pre-backfill) falls back to its Float value.
        select: { periodYear: true, periodMonth: true, totalGross: true, totalOt: true, totalGrossPaisa: true, totalOtPaisa: true },
      }).catch(() => [])
      const byMonth = new Map<string, { gross: number; ot: number }>()
      for (const r of runs) {
        const k = monthKey(r.periodYear, r.periodMonth)
        const cur = byMonth.get(k) || { gross: 0, ot: 0 }
        cur.gross += r.totalGrossPaisa != null ? Number(r.totalGrossPaisa) / 100 : (r.totalGross || 0)
        cur.ot += r.totalOtPaisa != null ? Number(r.totalOtPaisa) / 100 : (r.totalOt || 0)
        byMonth.set(k, cur)
      }
      payrollCost = Math.round([...byMonth.values()].reduce((s, v) => s + v.gross, 0))
      otCost = Math.round([...byMonth.values()].reduce((s, v) => s + v.ot, 0))
      payrollTrend = [...byMonth.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([k, v]) => ({ label: k, value: Math.round(v.gross) }))
      const cmpRuns = await db.payrollRun.findMany({
        where: {
          vendorId: ctx.vendorId, ...(ctx.activeCompanyId && !ctx.allCompaniesMode ? { companyId: ctx.activeCompanyId } : {}), status: "PAID", runType: { in: ["REGULAR", "ADJUSTMENT"] },
          OR: [
            { periodYear: Number(cmpFrom.slice(0, 4)), periodMonth: { gte: Number(cmpFrom.slice(5, 7)) } },
            { periodYear: { gt: Number(cmpFrom.slice(0, 4)), lt: Number(cmpTo.slice(0, 4)) } },
            { periodYear: Number(cmpTo.slice(0, 4)), periodMonth: { lte: Number(cmpTo.slice(5, 7)) } },
          ],
        },
        select: { totalGross: true, totalOt: true, totalGrossPaisa: true, totalOtPaisa: true },
      }).catch(() => [])
      cmpPayrollCost = Math.round(cmpRuns.reduce((s, r) => s + (r.totalGrossPaisa != null ? Number(r.totalGrossPaisa) / 100 : (r.totalGross || 0)), 0))
      cmpOtCost = Math.round(cmpRuns.reduce((s, r) => s + (r.totalOtPaisa != null ? Number(r.totalOtPaisa) / 100 : (r.totalOt || 0)), 0))
    } else {
      warnings.push("Payroll and overtime cost blocks are hidden — they require the payroll.view permission (the FIN-022 wire discipline: financial figures are never computed for callers who cannot see them).")
    }
    if (unknownAges > 0) {
      warnings.push(`${unknownAges} employee(s) have no date of birth recorded — they sit in the age band "Unknown" instead of being silently dropped.`)
    }

    const report: AnalyticsReport = {
      contractVersion: 1,
      reportId: "workforce.dashboard",
      title: reportMetaOf("workforce.dashboard").title,
      generatedAt: new Date().toISOString(),
      period: {
        from, to,
        label: `${from} → ${to}`,
        comparison: { from: cmpFrom, to: cmpTo, label: `${cmpFrom} → ${cmpTo}` },
      },
      filters: { dimension },
      scope: { applied: scoped, description: scopeDescription },
      kpis: [
        kpi("headcount.total", emps.length),
        kpi("headcount.active", activeNow),
        kpi("workforce.joiners", joiners, { previous: { value: cmpJoiners, deltaPct: deltaPct(joiners, cmpJoiners) } }),
        kpi("workforce.exits", exits, { previous: { value: cmpExits, deltaPct: deltaPct(exits, cmpExits) }, intent: "good-low" }),
        kpi("workforce.attrition", attrition, { previous: { value: cmpAttrition, deltaPct: deltaPct(attrition, cmpAttrition) }, intent: "good-low" }),
        kpi("workforce.turnover", turnover, { previous: { value: turnoverPrev, deltaPct: deltaPct(turnover, turnoverPrev) }, intent: "good-low" }),
        kpi("workforce.avg_tenure_months", avgTenureMonths || null),
        {
          key: "workforce.avg_age", label: "Average age", value: avgAge, unit: "count", local: true,
          definition: "Mean age in YEARS across in-scope employees with a recorded date of birth (employees without one are excluded from the mean and reported in the Unknown age band).",
        },
        ...(att ? [
          kpi("attendance.rate", att.kpis.attendanceRate, { previous: cmpAtt("attendanceRate"), intent: "good-high" }),
          kpi("attendance.absent_days", att.kpis.absent, { previous: cmpAtt("absent"), intent: "good-low" }),
          kpi("attendance.late", att.kpis.late, { previous: cmpAtt("late"), intent: "good-low" }),
          kpi("attendance.on_leave_days", att.kpis.onLeave, { previous: cmpAtt("onLeave") }),
        ] : []),
        {
          key: "leave.utilisation", label: "Leave utilisation", value: leaveUtilisation == null ? null : `${leaveUtilisation}%`, unit: "percent", local: true,
          definition: `Used ÷ (entitled + carried forward) across in-scope employees for the fiscal leave year containing the period end (leave year ${leaveYear}), every leave type summed.`,
        },
        ...(canPayroll ? [
          kpi("payroll.cost", payrollCost, { previous: { value: cmpPayrollCost, deltaPct: deltaPct(payrollCost, cmpPayrollCost) } }),
          kpi("payroll.ot_cost", otCost, { previous: { value: cmpOtCost, deltaPct: deltaPct(otCost, cmpOtCost) } }),
        ] : []),
      ],
      charts: [
        {
          key: "workforce.headcount_trend",
          kind: "line",
          title: "Headcount trend (monthly snapshots)",
          purpose: "Whether the workforce is growing, flat or shrinking — the shape the live count alone hides.",
          series: [
            { name: "Total", points: series.map((s) => ({ label: s.label, value: s.headcountTotal })) },
            { name: "Active", points: series.map((s) => ({ label: s.label, value: s.headcountActive })) },
          ],
          // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- audited TODO(H-20 paydown): Phase 3 analytics/PDF/commission surface, index/lookup guarded by construction
          note: series.length ? `Snapshot series ${series[0]!.label} → ${series[series.length - 1]!.label} (vendor-wide; reconstructed months before the backfill carry its caveats).` : "No snapshots yet — run the twelve-month backfill.",
        },
        {
          key: "workforce.movement",
          kind: "bar",
          title: "Joiners and exits by month",
          purpose: "Where the headcount movement actually happened — a growth month vs a replacement month look identical in the trend.",
          series: [
            { name: "Joiners", points: series.map((s) => ({ label: s.label, value: s.newJoiners })) },
            { name: "Exits", points: series.map((s) => ({ label: s.label, value: s.exits })) },
          ],
        },
        {
          key: "workforce.distribution",
          kind: "bar",
          title: `Headcount by ${dimension}`,
          purpose: "Where the people are — concentration (or fragmentation) of the in-scope workforce across the selected dimension.",
          series: [{ name: "Headcount", points: [...dimAgg.entries()].sort((a, b) => b[1] - a[1]).map(([k2, v]) => ({ label: k2, value: v })) }],
          note: "Unassigned = employees without the dimension set on their record.",
        },
        {
          key: "workforce.age_bands",
          kind: "bar",
          title: "Age bands",
          purpose: "Workforce age structure — succession planning and benefits design both key off it.",
          series: [{ name: "Employees", points: ageBuckets.map(([k2, v]) => ({ label: k2, value: v })) }],
        },
        {
          key: "workforce.tenure_bands",
          kind: "bar",
          title: "Tenure bands",
          purpose: "How long the workforce has been with the organization — the experience mix behind the attrition number.",
          series: [{ name: "Employees", points: tenureBuckets.map(([k2, v]) => ({ label: k2, value: v })) }],
        },
        ...(canPayroll && payrollTrend.length ? [{
          key: "workforce.payroll_cost_trend",
          kind: "line" as const,
          title: "Payroll cost by month (PAID runs)",
          purpose: "The cost trajectory behind the headcount line — cost per head moves even when headcount does not.",
          series: [{ name: "Gross payroll", points: payrollTrend.map((pt) => ({ label: pt.label, value: pt.value })) }],
          note: "Vendor-wide PAID runs (REGULAR + ADJUSTMENT), gross totals.",
        }] : []),
      ],
      table: {
        columns: [
          { key: "month", label: "Month", align: "left" },
          { key: "total", label: "Headcount", align: "right" },
          { key: "active", label: "Active", align: "right" },
          { key: "joiners", label: "Joiners", align: "right" },
          { key: "exits", label: "Exits", align: "right" },
          { key: "tenure", label: "Avg tenure (mo)", align: "right" },
        ],
        rows: series.map((s) => [s.label, s.headcountTotal, s.headcountActive, s.newJoiners, s.exits, s.avgTenureMonths]),
      },
      warnings,
      methodology: {
        source: "Monthly WorkforceSnapshot series (movement/attrition/turnover), scoped Employee records (distributions, age, tenure), attendance records via attendanceOverviewData (attendance/absenteeism), PAID PayrollRun totals (cost, permission-gated)",
        definitions: {
          "workforce.attrition": "period exits ÷ ((first-month headcount + last-month headcount) ÷ 2), from the snapshot series",
          "workforce.turnover": "trailing-12m exits ÷ ((first + last month headcount) ÷ 2) from the series tail",
          "attendance.rate": "not-counted records ÷ (employees × marked days), LEAVE/HOLIDAY/WEEKLY_OFF excluded from both sides, capped at 100% (RPT-11 canonical)",
          "leave.utilisation": "used ÷ (entitled + carried) across in-scope leave balances of the fiscal leave year containing the period end",
          "payroll.cost": "Σ totalGross of PAID REGULAR+ADJUSTMENT runs whose period month falls inside the selected window (vendor-wide)",
        },
        generatedBy: "structured report definition workforce.dashboard (contract v1, Phase 3)",
      },
    }
    return report
  },
})

// ---------------- the routes ----------------

/** Phase 3 (FIN-077 structural fix) — the monthly workforce snapshot series:
 *  what the analytics workspace reads for trend KPIs (headcount/joiner/exit/
 *  tenure movement) instead of reconstructing history from live rows. */
route("analytics.snapshots.series", {
  perm: ["reports", "view"],
  schema: z.object({ months: z.number().int().min(1).max(60).optional() }).passthrough(),
  handler: async (ctx, p) => {
    const { workforceSnapshotSeries } = await import("../workforce-snapshots")
    return { snapshots: await workforceSnapshotSeries(ctx.vendorId, parseNumber(p?.months, 13)) }
  },
})

/** Phase 3 — one-time twelve-month backfill of the snapshot series for this
 *  tenant (reconstruction from joining dates + recorded exit dates; the
 *  honest caveat rides the response: employees deleted before the backfill
 *  are invisible to it, so the earliest months carry the same caveats until
 *  live snapshots accumulate). Idempotent — re-running rewrites identical
 *  values for closed months. */
route("analytics.snapshots.backfill", {
  perm: ["reports", "schedule"],
  schema: z.object({ months: z.number().int().min(1).max(24).optional() }).passthrough(),
  handler: async (ctx, p) => {
    const { backfillWorkforceSnapshots } = await import("../workforce-snapshots")
    const out = await backfillWorkforceSnapshots(ctx.vendorId, parseNumber(p?.months, 12))
    await audit(ctx, "analytics.snapshots.backfill", "WorkforceSnapshot", null,
      `Reconstructed ${out.wrote} monthly workforce snapshot(s) (${out.from} → ${out.to}) from joining dates and recorded exit dates — deleted pre-backfill employees are invisible to the reconstruction`)
    return { ...out, caveat: "Reconstructed from joining dates and recorded exit dates: employees deleted before this backfill are invisible to it. Live captures accumulate from today and freeze each month as it closes." }
  },
})

/** Phase 3 — background generation for large tenants: submit the render to the
 *  BgJob lane (progress, retry, cancellation) and poll/download through
 *  analytics.report.generation. The definition's own permission pair is
 *  verified at submit AND re-resolved from the user row at run time. */
// INTENTIONALLY_SELF_SCOPED (M-02): per-definition permission enforced in-handler (require(ctx, def.…)) — the gate depends on which report is requested.
route("analytics.report.generate", {
  schema: z.object({
    reportId: z.string().min(1),
    format: z.enum(["PDF", "XLSX", "CSV"]).default("PDF"),
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    compareFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    compareTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    dimension: z.string().max(40).optional(),
    branchId: z.string().max(40).nullish(),
    departmentId: z.string().max(40).nullish(),
    month: z.number().int().min(1).max(12).optional(),
    year: z.number().int().min(2000).max(2100).optional(),
    // Reports overhaul (3g) — the report-bar filter vocabulary is accepted in
    // full (passthrough keeps any future field too); the WHOLE payload is
    // forwarded to the BgJob so REPORT_GENERATE renders with every filter.
    status: z.string().max(30).optional(),
    employmentType: z.string().max(30).optional(),
    employeeId: z.string().max(40).optional(),
    runType: z.string().max(30).optional(),
    cycleId: z.string().max(40).optional(),
    divisor: z.union([z.number(), z.string().max(5)]).optional(),
    eligibleOnly: z.boolean().optional(),
    percent: z.number().min(0).max(200).optional(),
    basis: z.string().max(10).optional(),
    withinDays: z.number().int().min(1).max(366).optional(),
    eventType: z.string().max(30).optional(),
  }).passthrough(),
  handler: async (ctx, p) => {
    const def = reportDefinition(String(p?.reportId || ""))
    if (!def) throw new Deny(`Unknown structured report: "${p?.reportId}" (see analytics.report.catalog)`, 404)
    // Reports overhaul (3g) — generation is an EXPORT lane: the definition's
    // dedicated export permission decides (reports.view alone must NOT be
    // enough to take a file off the wire), and the tier gate applies.
    const { require } = await import("../rbac")
    require(ctx, def.exportPermission[0], def.exportPermission[1])
    await assertReportEntitlement(ctx, def.reportId)
    // forward EVERY filter param (reportId/format are job control, not
    // filters); null/undefined/empty values are dropped so the mirrored
    // filters stay honest.
    const params: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(p as Record<string, unknown>)) {
      if (k === "reportId" || k === "format") continue
      if (v === null || v === undefined || v === "") continue
      params[k] = v
    }
    const { submitJob } = await import("../jobs")
    // MULTI-COMPANY — the submitting session's ACTIVE COMPANY rides the job
    // payload: the background render re-resolves permissions from the user
    // row but inherits the company context the report was requested in.
    const jobId = await submitJob(ctx as any, "REPORT_GENERATE", {
      reportId: def.reportId,
      format: p.format,
      params,
      companyId: ctx.activeCompanyId ?? null,
    }, { total: 4, priority: 4 })
    await audit(ctx, `analytics.report.${def.reportId}.generateSubmitted`, "Report", null,
      `Background generation submitted (${p.format}) for structured report ${def.reportId} — job ${jobId}`)
    return { jobId }
  },
})

/** Phase 3 — poll/download a background generation: status + progress while
 *  running, the base64 artifact + filename once DONE. Only the submitting
 *  tenant sees the job. */
route("analytics.report.generation", {
  perm: ["reports", "view"],
  schema: z.object({ jobId: z.string().min(1) }).strict(),
  handler: async (ctx, p) => {
    const job = await db.bgJob.findFirst({ where: { id: p.jobId, vendorId: ctx.vendorId, type: "REPORT_GENERATE" } })
    if (!job) throw new Deny("Generation job not found", 404)
    return {
      jobId: job.id,
      status: job.status,
      progress: job.progress,
      total: job.total,
      error: job.error || null,
      attempts: job.attempts,
      cancelled: !!job.cancelledAt,
      ...(job.status === "DONE" && job.resultJson ? (() => {
        const r = j(job.resultJson, {} as Record<string, unknown>)
        return { artifact: { format: r.format, filename: r.filename, contentType: r.contentType, base64: r.base64, rows: r.rows } }
      })() : {}),
    }
  },
})

/** Structured-report catalogue (what the workspace lists; also proves the
 *  legacy adapter coverage: every legacy key appears as legacy.<key>).
 *  Reports overhaul (3e) — the catalogue is now entitlement-aware: the
 *  caller's vendor subscription gates the ADVANCED_REPORTS tier (LEGACY
 *  vendors see everything). Advanced-tier reports on a plan without the
 *  feature come back in `lockedDefinitions` (title + category only — no
 *  descriptions on the wire for products the caller cannot use), and
 *  `internal` reports never appear. The `definitions` array shape stays
 *  backward compatible. */
route("analytics.report.catalog", {
  perm: ["reports", "view"],
  handler: async (ctx) => {
    const ent = await resolveEntitlements(ctx.vendorId)
    const advancedOn = !featureBlocked(ent, "analytics")
    const all = listReportDefinitions()
    const visible = all.filter((d) => !d.internal && (d.tier === "core" || advancedOn))
    const locked = all.filter((d) => !d.internal && d.tier === "advanced" && !advancedOn)
    return {
      definitions: visible.map((d) => ({
        reportId: d.reportId,
        title: d.title,
        description: d.description,
        category: d.category,
        tier: d.tier,
        permission: d.permission,
        pii: d.pii,
        period: d.period,
        comparisonSupported: d.comparisonSupported,
        filters: d.filters ?? {},
        filterFields: d.filterFields ?? [],
      })),
      lockedDefinitions: locked.map((d) => ({ reportId: d.reportId, title: d.title, category: d.category })),
    }
  },
})

/** Render a structured report through the contract. Permission is
 *  definition-specific (the legacy adapter inherits the legacy route's gate,
 *  including reports.pii.view for PII-class reports), so the route itself is
 *  registered without a static perm and enforces in-handler. */
// INTENTIONALLY_SELF_SCOPED (M-02): per-definition permission enforced in-handler (require(ctx, def.…)) — the gate depends on which report is requested.
route("analytics.report.render", {
  schema: z.object({
    reportId: z.string().min(1),
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    compareFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    compareTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    dimension: z.string().max(40).optional(),
    branchId: z.string().max(40).nullish(),
    departmentId: z.string().max(40).nullish(),
    status: z.string().max(30).optional(),
    employmentType: z.string().max(30).optional(),
    month: z.number().int().min(1).max(12).optional(),
    year: z.number().int().min(2000).max(2100).optional(),
  }).passthrough(),
  handler: async (ctx, p) => {
    const def = reportDefinition(String(p?.reportId || ""))
    if (!def) throw new Deny(`Unknown structured report: "${p?.reportId}" (see analytics.report.catalog)`, 404)
    const { require } = await import("../rbac")
    require(ctx, def.permission[0], def.permission[1])
    // Reports overhaul (3f) — the subscription-tier gate rides every render.
    await assertReportEntitlement(ctx, def.reportId)
    return renderAnalyticsReport(ctx, def.reportId, p as ReportParams)
  },
})

/** The export twin — CSV built from the SAME contract payload the UI
 *  renders (unified export pipeline). Export-permission-gated and audited
 *  exactly like every other report export. */
// INTENTIONALLY_SELF_SCOPED (M-02): per-definition permission enforced in-handler (require(ctx, def.…)) — the gate depends on which report is requested.
route("analytics.report.renderCsv", {
  schema: z.object({
    reportId: z.string().min(1),
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    compareFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    compareTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    dimension: z.string().max(40).optional(),
    branchId: z.string().max(40).nullish(),
    departmentId: z.string().max(40).nullish(),
    status: z.string().max(30).optional(),
    employmentType: z.string().max(30).optional(),
    month: z.number().int().min(1).max(12).optional(),
    year: z.number().int().min(2000).max(2100).optional(),
  }).passthrough(),
  handler: async (ctx, p) => {
    const def = reportDefinition(String(p?.reportId || ""))
    if (!def) throw new Deny(`Unknown structured report: "${p?.reportId}" (see analytics.report.catalog)`, 404)
    const { require } = await import("../rbac")
    require(ctx, def.exportPermission[0], def.exportPermission[1])
    // Reports overhaul (3f) — the subscription-tier gate rides every export.
    await assertReportEntitlement(ctx, def.reportId)
    await audit(ctx, `analytics.report.${def.reportId}.csvExport`, "Report", null,
      `Exported structured report ${def.reportId} as CSV${def.pii ? " (PII)" : ""}`)
    const report = await renderAnalyticsReport(ctx, def.reportId, p as ReportParams)
    return { csv: reportToCsv(report), reportId: def.reportId }
  },
})

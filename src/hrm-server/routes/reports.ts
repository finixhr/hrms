// ============ Dashboard / Reports / Analytics / Audit / Accounting views ============
// Dashboard consumes events from underlying engines (spec §16). Reports support
// filters + CSV export (spec §17.1–17.5). Analytics aggregates workforce/attendance/
// payroll/performance (spec §17.6).
import { db } from "@/lib/db"
import { z } from "zod"
import { route } from "./registry"
import { Deny, employeeScopeFilter } from "../rbac"
import { audit } from "../audit"
import { getSettings } from "../settings"
import { addDays, csv, daysBetween, j, monthName, pct, titleCase, today, resolveWeeklyOffDays } from "../utils"
import { resolveSalaryPayouts } from "../payout"

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
    // L-28 — serve from the 60s memo when fresh (keyed by the caller's
    // visibility scope, so a branch manager never sees vendor-wide numbers)
    const memoKey = JSON.stringify(scope)
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
    const branches = await db.branch.findMany({ where: { vendorId: ctx.vendorId } })
    const depts = await db.department.findMany({ where: { vendorId: ctx.vendorId } })
    const desigs = await db.designation.findMany({ where: { vendorId: ctx.vendorId } })
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
    const todayRecords = await db.attendance.findMany({ where: { vendorId: ctx.vendorId, date: t } })
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
    const scopedEmployeeIds = employees.map((e) => e.id)
    const runs = await db.payrollRun.findMany({ where: { vendorId: ctx.vendorId }, orderBy: [{ periodYear: "desc" }, { periodMonth: "desc" }] })
    const lastPaid = runs.find((r) => r.status === "PAID")
    const payroll = {
      gross: lastPaid?.totalGross || 0,
      net: lastPaid?.totalNet || 0,
      deductions: (lastPaid?.totalDeduction || 0) + (lastPaid?.totalAit || 0),
      overtime: lastPaid?.totalOt || 0,
      bonus: lastPaid?.totalBonus || 0,
      period: lastPaid ? `${monthName(lastPaid.periodMonth)} ${lastPaid.periodYear}` : "—",
      pendingApproval: runs.filter((r) => ["CALCULATED", "HR_REVIEW", "MANAGER_APPROVAL", "ACCOUNTING_APPROVAL", "APPROVED"].includes(r.status)).length,
      pendingPayment: runs.filter((r) => r.status === "APPROVED").length,
    }
    const loansIssued = await db.loan.aggregate({ where: { vendorId: ctx.vendorId, employeeId: { in: scopedEmployeeIds }, status: { in: ["ACTIVE"] } }, _sum: { principal: true } })
    const loansOutstanding = await db.loan.aggregate({ where: { vendorId: ctx.vendorId, employeeId: { in: scopedEmployeeIds }, status: "ACTIVE" }, _sum: { outstanding: true } })

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
    const settings = await getSettings(ctx.vendorId)
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
    const holidaysToday = await db.holiday.findMany({ where: { vendorId: ctx.vendorId, date: t } })
    const dow = dowOf(t)
    // 2026-10-13 — canonical weekly-off precedence (employee > shift > global
    // policy): one batched shift lookup, then per-employee resolution
    const shiftRowsToday = await db.shift.findMany({ where: { vendorId: ctx.vendorId }, select: { id: true, weeklyOff: true } })
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
    const weekAhead = addDays(t, 7)
    const vendorLoans = await db.loan.findMany({ where: { vendorId: ctx.vendorId }, select: { id: true } })
    const vendorLoanIds = vendorLoans.map((l) => l.id)
    const dueInstallments = vendorLoanIds.length ? (await db.loanInstallment.findMany({
      where: { loanId: { in: vendorLoanIds }, dueDate: { gte: t, lte: weekAhead }, status: { in: ["PENDING", "OVERDUE", "PARTIAL"] } },
      orderBy: { dueDate: "asc" }, take: 60,
    })).filter((i) => i.paidAmount < i.amount).slice(0, 10) : []
    const loanIds = [...new Set(dueInstallments.map((i) => i.loanId))]
    const dueLoans = loanIds.length ? await db.loan.findMany({ where: { id: { in: loanIds }, vendorId: ctx.vendorId } }) : []
    const loanInstallmentsDue = dueInstallments.map((i) => ({
      loanId: i.loanId, employeeName: employees.find((e) => e.id === dueLoans.find((l) => l.id === i.loanId)?.employeeId)?.fullName || "—",
      no: i.no, amount: i.amount, dueDate: i.dueDate,
    }))

    // performance review due (cycles ending within 14 days — spec §16.5)
    const reviewCycles = await db.reviewCycle.findMany({ where: { vendorId: ctx.vendorId, status: "ACTIVE" } })
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

    // payroll trends (last 6 months)
    const trendRuns = runs.filter((r) => r.status === "PAID").slice(0, 6).reverse()
    const payrollTrend = trendRuns.map((r) => ({ period: `${monthName(r.periodMonth).slice(0, 3)} ${String(r.periodYear).slice(2)}`, gross: r.totalGross, net: r.totalNet }))

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
      const lts = ids.length ? await db.leaveType.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }) : []
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
    const stockItems = await db.item.findMany({ where: { vendorId: ctx.vendorId, active: true }, select: { id: true, name: true, code: true, reorderLevel: true } })
    const stockLevels = await db.stockLevel.findMany({ where: { vendorId: ctx.vendorId }, select: { itemId: true, quantity: true, reserved: true } })
    const qtyByItem = new Map<string, number>()
    for (const s of stockLevels) qtyByItem.set(s.itemId, (qtyByItem.get(s.itemId) || 0) + (s.quantity || 0))
    const lowStock = stockItems
      .filter((it) => (it.reorderLevel || 0) > 0 && (qtyByItem.get(it.id) || 0) <= it.reorderLevel)
      .slice(0, 10)
      .map((it) => ({ id: it.id, name: it.name, code: it.code, quantity: Math.round(qtyByItem.get(it.id) || 0), reorderLevel: it.reorderLevel }))
    // pending procurement — "Pending Procurement" widget
    const pendingProcurement = await db.purchaseRequest.count({
      where: { vendorId: ctx.vendorId, status: { in: ["PENDING", "APPROVED", "PENDING_STOCK_ENTRY"] } },
    })
    // pending expense value — "Expense Summary" widget
    const pendingExpenseAgg = await db.expenseClaim.aggregate({
      where: { vendorId: ctx.vendorId, status: "PENDING" }, _sum: { amount: true },
    })
    const expensesMonth = { pendingCount: pending.expenses, pendingAmount: pendingExpenseAgg._sum.amount || 0 }
    // attendance device fleet health — "Device Health" widget
    const devices = await db.attendanceDevice.findMany({
      where: { vendorId: ctx.vendorId, enabled: true },
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
      attendanceToday, payroll, loan: { issued: loansIssued._sum.principal || 0, outstanding: loansOutstanding._sum.outstanding || 0 },
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

/** RPT-10 — every registered reportRoute key (drives the AI-catalogue
 *  coverage check so a new report can never silently miss its NL entry). */
export function registeredReportKeys(): string[] {
  return [...reportHandlers.keys()]
}

const reportRoute = (key: string, fn: (ctx: any, p: any) => Promise<{ columns: string[]; rows: any[][]; meta?: any }>, opts: { pii?: boolean } = {}) => {
  reportHandlers.set(key, fn)
  if (opts.pii) reportPiiKeys.add(key)
  route(`reports.${key}`, { perm: ["reports", "view"], handler: fn })
  route(`reports.${key}Csv`, {
    // HIGH-11 (this audit) — PII exports require typed confirmation + an
    // additional `reports.pii` permission gate. The previous single-permission
    // gate allowed any user with `reports.export` to download bulk PII
    // (father/mother name, blood group, marital status, NID-adjacent fields).
    // Mirrors the typed-confirmation pattern used by `employees.hardDelete`.
    perm: opts.pii ? ["reports", "pii"] : ["reports", "export"],
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
      const { columns, rows } = await fn(ctx, p)
      return { csv: csv([columns, ...rows]) }
    },
  })
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

// ---------- §17.1 Employee reports ----------
reportRoute("employees", async (ctx, p) => {
  const emps = await scopedEmployees(ctx, p)
  const branches = await db.branch.findMany({ where: { vendorId: ctx.vendorId } })
  const depts = await db.department.findMany({ where: { vendorId: ctx.vendorId } })
  const desigs = await db.designation.findMany({ where: { vendorId: ctx.vendorId } })
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
  const depts = await db.department.findMany({ where: { vendorId: ctx.vendorId } })
  const desigs = await db.designation.findMany({ where: { vendorId: ctx.vendorId } })
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
  const branches = await db.branch.findMany({ where: { vendorId: ctx.vendorId } })
  const depts = await db.department.findMany({ where: { vendorId: ctx.vendorId } })
  const desigs = await db.designation.findMany({ where: { vendorId: ctx.vendorId } })
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
  const emps = await db.employee.findMany({ where, orderBy: { joiningDate: "desc" } })
  const depts = await db.department.findMany({ where: { vendorId: ctx.vendorId } })
  const desigs = await db.designation.findMany({ where: { vendorId: ctx.vendorId } })
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
  const emps = await db.employee.findMany({ where, orderBy: { updatedAt: "desc" } })
  const resignations = await db.resignation.findMany({ where: { vendorId: ctx.vendorId, status: { in: ["ACCEPTED", "COMPLETED"] } } })
  const depts = await db.department.findMany({ where: { vendorId: ctx.vendorId } })
  return {
    columns: ["Code", "Name", "Department", "Status", "Exit Type", "Last Working Day", "Reason"],
    rows: emps.map((e) => {
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
    meta: { count: emps.length },
  }
})

reportRoute("employeesLifecycle", async (ctx, p) => {
  const where: any = employeeScopeFilter(ctx)
  if (p?.branchId) where.branchId = p.branchId
  const emps = await db.employee.findMany({ where, select: { id: true, code: true, fullName: true } })
  const events = await db.employeeHistory.findMany({
    where: { vendorId: ctx.vendorId, employeeId: { in: emps.map((e) => e.id) }, ...(p?.eventType ? { eventType: p.eventType } : {}) },
    orderBy: { createdAt: "desc" }, take: 500,
  })
  return {
    columns: ["Date", "Employee", "Event", "Title", "Detail"],
    rows: events.map((h) => [
      h.effectiveDate || h.createdAt.toISOString().slice(0, 10),
      emps.find((e) => e.id === h.employeeId)?.fullName || "—",
      h.eventType, h.title, h.description || "—",
    ]),
    meta: { count: events.length },
  }
})

// ---------- §17.2 Attendance reports ----------
async function scopedAttendance(ctx: any, p: any, extra: any = {}) {
  const { prefix } = monthPrefixOf(p)
  const where: any = { vendorId: ctx.vendorId, date: { startsWith: prefix }, ...extra }
  const emps = await scopedEmployees(ctx, p)
  if (p?.employeeId) where.employeeId = p.employeeId
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
  const { records, emps } = await scopedAttendance(ctx, p, { overtimeMinutes: { gt: 0 } })
  const byEmp = new Map<string, number>()
  for (const r of records) byEmp.set(r.employeeId, (byEmp.get(r.employeeId) || 0) + r.overtimeMinutes)
  return {
    columns: ["Employee", "OT Days", "Total OT (h)", "OT (m)"],
    rows: [...byEmp.entries()].map(([id, mins]) => [
      emps.find((e) => e.id === id)?.fullName || "—",
      records.filter((r) => r.employeeId === id).length,
      Math.round((mins / 60) * 10) / 10, mins,
    ]),
    meta: { count: byEmp.size, totalOvertimeMinutes: records.reduce((s, r) => s + r.overtimeMinutes, 0) },
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
    const groups = group === "branchId"
      ? await db.branch.findMany({ where: { vendorId: ctx.vendorId } })
      : await db.department.findMany({ where: { vendorId: ctx.vendorId } })
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
  const types = await db.leaveType.findMany({ where: { vendorId: ctx.vendorId } })
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
  const types = await db.leaveType.findMany({ where: { vendorId: ctx.vendorId, active: true }, orderBy: { code: "asc" } })
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
  const types = await db.leaveType.findMany({ where: { vendorId: ctx.vendorId } })
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
  const depts = await db.department.findMany({ where: { vendorId: ctx.vendorId } })
  const types = await db.leaveType.findMany({ where: { vendorId: ctx.vendorId } })
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
  const periodWeek = p?.periodWeek != null && p.periodWeek !== "" ? Number(p.periodWeek) : 0
  const run = await db.payrollRun.findFirst({
    where: { vendorId: ctx.vendorId, periodMonth: Number(p?.month || 1), periodYear: Number(p?.year || new Date().getUTCFullYear()), periodWeek, status: { in: ["APPROVED", "PROCESSING", "PAID"] }, runType: "REGULAR" },
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
    const run = await db.payrollRun.findFirst({
      where: { vendorId: ctx.vendorId, periodMonth: Number(p?.month || 1), periodYear: Number(p?.year || new Date().getUTCFullYear()), periodWeek: p?.periodWeek ? Number(p.periodWeek) : 0, status: { in: ["APPROVED", "PROCESSING", "PAID"] } },
    })
    if (!run) return { columns: ["No paid/approved run for this period"], rows: [], meta: { run: null } }
    const emps = await scopedEmployees(ctx, p)
    const entries = await db.payrollEntry.findMany({ where: { runId: run.id, employeeId: { in: emps.map((e) => e.id) } } })
    const groups = group === "branchId"
      ? await db.branch.findMany({ where: { vendorId: ctx.vendorId } })
      : await db.department.findMany({ where: { vendorId: ctx.vendorId } })
    const rows = groups.map((g) => {
      const ids = new Set(emps.filter((e) => (e as any)[group] === g.id).map((e) => e.id))
      const es = entries.filter((e) => ids.has(e.employeeId))
      const sum = (f: (e: any) => number) => Math.round(es.reduce((s, e) => s + f(e), 0))
      return [g.name, es.length, sum((e) => e.gross), sum((e) => e.otAmount), sum((e) => e.bonus + e.commission), sum((e) => e.ait), sum((e) => e.net)]
    })
    return {
      columns: [group === "branchId" ? "Branch" : "Department", "Employees", "Gross", "OT", "Bonus + Commission", "AIT", "Net"],
      rows,
      meta: { run: { id: run.id, status: run.status } },
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
  const runs = await db.payrollRun.findMany({ where: { vendorId: ctx.vendorId } })
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
  const loans = await db.loan.findMany({ where: { vendorId: ctx.vendorId }, orderBy: { createdAt: "desc" } })
  const emps = await db.employee.findMany({ where: employeeScopeFilter(ctx) })
  // RPT-04 — the status filter the UI offers is applied (was never read)
  const filtered = p?.status ? loans.filter((l) => l.status === p.status) : loans
  return {
    columns: ["Employee", "Type", "Principal", "Installments", "Paid", "Outstanding", "Status"],
    rows: filtered.filter((l) => emps.some((e) => e.id === l.employeeId)).map((l) => [
      emps.find((e) => e.id === l.employeeId)?.fullName || "—", titleCase(l.type),
      l.principal, l.installments, l.paidAmount, l.outstanding, titleCase(l.status),
    ]),
    meta: { count: filtered.length },
  }
})

reportRoute("advances", async (ctx, p) => {
  const emps = await db.employee.findMany({ where: employeeScopeFilter(ctx) })
  const advances = await db.advance.findMany({ where: { vendorId: ctx.vendorId }, orderBy: { requestDate: "desc" } })
  // RPT-04 — the status filter the UI offers is applied (was never read)
  const filtered = p?.status ? advances.filter((a) => a.status === p.status) : advances
  return {
    columns: ["Employee", "Amount", "Request Date", "Recovery Date", "Installments", "Recovered", "Outstanding", "Status"],
    rows: filtered.filter((a) => emps.some((e) => e.id === a.employeeId)).map((a) => [
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
  const cycles = await db.reviewCycle.findMany({ where: { vendorId: ctx.vendorId } })
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
  const cycles = await db.reviewCycle.findMany({ where: { vendorId: ctx.vendorId }, orderBy: { startDate: "asc" } })
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
  const branches = await db.branch.findMany({ where: { vendorId: ctx.vendorId } })
  const depts = await db.department.findMany({ where: { vendorId: ctx.vendorId } })
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
  const depts = await db.department.findMany({ where: { vendorId: ctx.vendorId } })
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
  const depts = await db.department.findMany({ where: { vendorId: ctx.vendorId } })
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
  const openings = await db.jobOpening.findMany({ where: { vendorId: ctx.vendorId } })
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
  const assets = await db.asset.findMany({ where: { vendorId: ctx.vendorId } })
  const emps = await db.employee.findMany({ where: employeeScopeFilter(ctx), select: { id: true, fullName: true, branchId: true } })
  const branches = await db.branch.findMany({ where: { vendorId: ctx.vendorId } })
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
  const visits = await db.visit.findMany({
    where: { vendorId: ctx.vendorId, checkInAt: { gte: new Date(`${prefix}-01T00:00:00`), lt: new Date(`${nextPrefix}-01T00:00:00`) } },
    orderBy: { checkInAt: "asc" },
  })
  const emps = await db.employee.findMany({ where: employeeScopeFilter(ctx), select: { id: true, fullName: true, branchId: true } })
  const branches = await db.branch.findMany({ where: { vendorId: ctx.vendorId } })
  const locations = await db.visitLocation.findMany({ where: { vendorId: ctx.vendorId } })
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
  const settings = await getSettings(ctx.vendorId)
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
  const depts = await db.department.findMany({ where: { vendorId: ctx.vendorId }, select: { id: true, name: true } })
  const desigs = await db.designation.findMany({ where: { vendorId: ctx.vendorId }, select: { id: true, name: true } })
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
  const depts = await db.department.findMany({ where: { vendorId: ctx.vendorId }, select: { id: true, name: true } })
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
  format: z.enum(["XLSX", "CSV"]),
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
      db.reportTemplate.findMany({ where: { vendorId: ctx.vendorId }, orderBy: { createdAt: "desc" } }),
      db.reportDeliveryLog.findMany({ where: { vendorId: ctx.vendorId }, orderBy: { startedAt: "desc" }, take: 20 }),
    ])
    return { templates: templates.map(templateWithJsonParsed), deliveries }
  },
})

route("reports.templates.save", {
  perm: ["reports", "schedule"],
  schema: templateSaveSchema,
  handler: async (ctx, p) => {
    if (!reportHandlers.has(p.reportKey)) {
      throw new Deny(`Unknown report "${p.reportKey}" — pick a report from the Reports registry.`, 400)
    }
    // RPT-001 (Wave R3-3) — PII-class reports need THREE extra gates before
    // they can become an unattended nightly e-mail channel:
    //   1. the caller must hold reports.pii (the HIGH-11 bulk-PII permission —
    //      previously dead: the verb was not even in the ACTIONS catalog);
    //   2. every recipient must be a tenant member (user or employee e-mail) —
    //      external addresses turn the scheduler into a silent exfiltration
    //      pipe for biodata;
    //   3. recipients are re-checked at RUN time (scheduled-reports.ts) so a
    //      member who later leaves stops receiving PII reports.
    if (isPiiReportKey(p.reportKey)) {
      if (!ctx.permissions.has("reports.pii") && !ctx.permissions.has("*")) {
        throw new Deny(`"${p.reportKey}" contains bulk personal data (PII) — scheduling it requires the reports.pii permission. Contact your administrator.`, 403)
      }
      const outsiders = await nonMemberRecipients(ctx.vendorId, p.recipients ?? [])
      if (outsiders.length) {
        throw new Deny(`PII report recipients must be members of this organization — these addresses have no user or employee account here: ${outsiders.join(", ")}`, 400)
      }
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
    // upsert semantics: by id when editing, else by the (vendorId, name) unique
    const existing = p.id
      ? await db.reportTemplate.findFirst({ where: { id: p.id, vendorId: ctx.vendorId } })
      : await db.reportTemplate.findFirst({ where: { vendorId: ctx.vendorId, name: p.name } })
    if (p.id && !existing) throw new Deny("Template not found", 404)
    let saved: NonNullable<Awaited<ReturnType<typeof db.reportTemplate.findFirst>>>
    if (existing) {
      saved = await db.reportTemplate.update({ where: { id: existing.id }, data: base })
    } else {
      try {
        saved = await db.reportTemplate.create({
          data: { ...base, vendorId: ctx.vendorId, createdById: ctx.userId, createdByName: ctx.userName },
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
    const t = await db.reportTemplate.findFirst({ where: { id: p.id, vendorId: ctx.vendorId } })
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
    const emps = await db.employee.findMany({ where: { vendorId: ctx.vendorId } })
    const branches = await db.branch.findMany({ where: { vendorId: ctx.vendorId } })
    const depts = await db.department.findMany({ where: { vendorId: ctx.vendorId } })
    const t = today()

    // workforce: headcount trend (net of exits), turnover, avg tenure, growth
     
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- audited TODO(H-20 paydown): convert to an explicit null check
    const joined = emps.filter((e) => e.joiningDate).sort((a, b) => a.joiningDate!.localeCompare(b.joiningDate!))
    const exits = await db.resignation.findMany({ where: { vendorId: ctx.vendorId, status: { in: ["ACCEPTED", "COMPLETED"] } } })
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
    const activeNow = emps.filter((e) => !["RESIGNED", "TERMINATED", "RETIRED"].includes(e.status)).length
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
    const activeRosterCount = Math.max(1, emps.filter((e) => !["RESIGNED", "TERMINATED", "RETIRED"].includes(e.status)).length)
    const attTrend: any[] = []
    for (let i = 5; i >= 0; i--) {
      const d = new Date()
      d.setMonth(d.getMonth() - i)
      const prefix = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`
      const recs = await db.attendance.findMany({ where: { vendorId: ctx.vendorId, date: { startsWith: prefix } } })
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
    const runs = await db.payrollRun.findMany({ where: { vendorId: ctx.vendorId, status: "PAID" }, orderBy: [{ periodYear: "asc" }, { periodMonth: "asc" }] })
    const lastRun = runs[runs.length - 1]
    const payrollByBranch: { name: string; value: number }[] = []
    const payrollByDepartment: { name: string; value: number }[] = []
    if (lastRun) {
      const entries = await db.payrollEntry.findMany({ where: { runId: lastRun.id } })
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
    const perEmployee = runs.length ? Math.round(runs[runs.length - 1].totalNet / Math.max(1, runs[runs.length - 1].employeeCount)) : 0

    // performance analytics — top, LOW performers, department performance, trend
    const reviews = await db.performanceReview.findMany({ where: { vendorId: ctx.vendorId } })
    const cycles = await db.reviewCycle.findMany({ where: { vendorId: ctx.vendorId }, orderBy: { startDate: "asc" } })
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
    const kpis = await db.kpiAssignment.findMany({ where: { vendorId: ctx.vendorId, status: { in: ["SUBMITTED", "REVIEWED"] } } })
    const kpiAchievement = kpis.map((k) => {
      const results = j(k.resultsJson, [] as any[])
      const avg = results.length ? results.reduce((s, r) => s + (r.achievementPct || 0), 0) / results.length : 0
      return { name: emps.find((e) => e.id === k.employeeId)?.fullName || "—", achievementPct: Math.round(avg) }
    })

    // total employee cost = salary + OT + bonus + benefits + expense reimbursement + employer costs
    const employerPct = (await getSettings(ctx.vendorId)).payroll.employerContributionPct
    const expenseTotal = await db.expenseClaim.aggregate({ where: { vendorId: ctx.vendorId, status: "REIMBURSED" }, _sum: { amount: true } })
    const bonusTotal = await db.bonus.aggregate({ where: { vendorId: ctx.vendorId, status: "PAID" }, _sum: { amount: true } })
    const totalEmployeeCost = lastRun
      ? lastRun.totalGross + lastRun.totalOt + (bonusTotal._sum.amount || 0) + (expenseTotal._sum.amount || 0) + lastRun.totalGross * (employerPct / 100)
      : 0

    // HRM-020 — missing KPI cards: absenteeism rate, late frequency per employee
    // per month, and a working-hour trend series (avg hours/day over 6 months).
    const activeEmps = emps.filter((e) => ["ACTIVE", "PROBATION", "ON_LEAVE"].includes(e.status))
    const totalAbsent6m = attTrend.reduce((s, x) => s + x.absent, 0)
    const recCounts = await Promise.all(Array.from({ length: 6 }, (_, i) => {
      const d = new Date(); d.setMonth(d.getMonth() - (5 - i))
      const prefix = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`
      return db.attendance.count({ where: { vendorId: ctx.vendorId, date: { startsWith: prefix } } })
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
      payroll: { trend: runs.slice(-6).map((r) => ({ period: `${monthName(r.periodMonth).slice(0, 3)} ${String(r.periodYear).slice(2)}`, gross: r.totalGross, net: r.totalNet, ait: r.totalAit })), perEmployee, byBranch: payrollByBranch, byDepartment: payrollByDepartment },
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
      ["Timestamp", "User", "Action", "Entity", "Entity Id", "Summary", "IP"],
      ...items.map((r: any) => [
        r.createdAt?.toISOString?.() || String(r.createdAt || ""),
        r.userName || r.userId || "",
        r.action || "",
        r.entity || "",
        r.entityId || "",
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
    const where: any = { vendorId: ctx.vendorId, status: "POSTED" }
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
      db.accountJournal.findMany({ where: { vendorId: ctx.vendorId }, select: { refType: true }, distinct: ["refType"] }),
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
route("reports.attendanceOverview", {
  perm: ["attendance", "view"],
  handler: async (ctx, p) => {
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
      evByTypeLocated, suspiciousEvRows, locatedCount, suspiciousCount,
    ] = await Promise.all([
      db.attendance.groupBy({ by: ["date", "status"], _count: { _all: true }, where: attWhere }),
      db.attendance.groupBy({ by: ["employeeId", "status"], _count: { _all: true }, where: attWhere }),
      db.attendanceEvent.groupBy({ by: ["attendanceMethod", "eventType"], _count: { _all: true }, where: evWhere }),
      db.attendanceEvent.groupBy({ by: ["gpsStatus"], _count: { _all: true }, where: evWhere }),
      db.attendanceEvent.groupBy({ by: ["locationIntegrityStatus"], _count: { _all: true }, where: evWhere }),
      // events WITH a geo-fence reference, per type — inside/outside split
      db.attendanceEvent.groupBy({ by: ["eventType"], _count: { _all: true }, where: { ...evWhere, geoFenceId: { not: null } } }),
      // suspicious events are a tiny subset — the ONLY raw rows fetched
      // (occurredAt is needed per-day for the suspicious trend)
      db.attendanceEvent.findMany({
        where: { ...evWhere, status: { in: ["SUSPICIOUS", "REVIEW_REQUIRED"] } },
        select: { occurredAt: true },
      }),
      db.attendanceEvent.count({
        where: { ...evWhere, OR: [{ gpsStatus: { not: null } }, { geoFenceId: { not: null } }, { attendanceMethod: { in: ["GEOFENCE", "GEOFENCE_SELFIE"] } }] },
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
    const branches = await db.branch.findMany({ where: { vendorId: ctx.vendorId }, select: { id: true, name: true } })
    const depts = await db.department.findMany({ where: { vendorId: ctx.vendorId }, select: { id: true, name: true } })

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
    const compliance = {
      gpsOk: evGpsCount("OK"),
      gpsDisabled: evGpsCount("DISABLED"),
      insideFence: evByTypeLocated
        .filter((r) => !["OUTSIDE_GEOFENCE", "GEOFENCE_VIOLATION"].includes(String(r.eventType)))
        .reduce((s, r) => s + (r._count._all || 0), 0),
      outsideFence: evCountType("GEOFENCE_VIOLATION"),
      locatedEvents: locatedCount,
    }
    const integrityDistribution = ["VERIFIED", "SUSPICIOUS", "MOCK_LOCATION", "IMPOSSIBLE_MOVEMENT", "STALE_LOCATION", "LOW_ACCURACY", "TIMESTAMP_ANOMALY", "DEVICE_MISMATCH"].map((st) => ({
      name: st.replace(/_/g, " "),
      value: evByIntegrity.find((r) => r.locationIntegrityStatus === st)?._count._all || 0,
    })).filter((x) => x.value > 0)

    return { kpis, trend, branchStats, departmentStats, methodDistribution, compliance, integrityDistribution, period: { from, to } }
  },
})

/** CSV companion of reports.attendanceOverview (2026-10 round §39–§41):
 *  KPI summary + branch + department stats. Audited like every other export. */
route("reports.attendanceOverviewCsv", {
  perm: ["attendance", "view"],
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

/** 1) Annualized attrition rate — trailing-12-month exits and rate per month
 *  (the headcountMovement report shows joiners/exits; this one shows the
 *  RATE with the RPT-08 definition: exits ÷ average headcount). */
reportRoute("attritionRate", async (ctx, p) => {
  const { year } = monthPrefixOf(p)
  const scope = employeeScopeFilter(ctx)
  const emps = await db.employee.findMany({ where: scope, select: { id: true, joiningDate: true, status: true, updatedAt: true } })
  const resignations = await db.resignation.findMany({ where: { vendorId: ctx.vendorId, status: { in: ["ACCEPTED", "COMPLETED"] } }, select: { employeeId: true, actualLwd: true, proposedLwd: true } })
  const lwdByEmp = new Map<string, string>()
  for (const r of resignations) lwdByEmp.set(r.employeeId, r.actualLwd || r.proposedLwd || "")
  const exitMonthOf = (e: any) => lwdByEmp.get(e.id) || e.updatedAt?.toISOString().slice(0, 7) || ""
  const months = Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, "0")}`)
  const rows = months.map((m) => {
    const joinedBy = emps.filter((e) => (e.joiningDate || "") <= `${m}-31`).length
    const exitsInMonth = emps.filter((e) => ["RESIGNED", "TERMINATED", "RETIRED"].includes(e.status) && exitMonthOf(e) === m).length
    const exitsBy = emps.filter((e) => ["RESIGNED", "TERMINATED", "RETIRED"].includes(e.status) && exitMonthOf(e) && exitMonthOf(e) <= m).length
    const headcount = Math.max(0, joinedBy - exitsBy)
    // annualized: exits this month × 12 ÷ headcount (stable single-month form)
    const annualized = headcount > 0 ? Math.round((exitsInMonth * 12 / headcount) * 1000) / 10 : 0
    return [`${monthName(Number(m.slice(5, 7)))} ${year}`, headcount, exitsInMonth, `${annualized}%`]
  })
  return {
    columns: ["Month", "Headcount (end)", "Exits", "Annualized Attrition Rate"],
    rows,
    meta: { count: rows.length, year, note: "annualized rate = month exits × 12 ÷ month-end headcount (RPT-08 definition)" },
  }
})

/** 2) Age bands — workforce age distribution (enterprise standard). */
reportRoute("ageBands", async (ctx, _p) => {
  const t = today()
  const emps = await db.employee.findMany({ where: { ...employeeScopeFilter(ctx), dob: { not: null } }, select: { dob: true, status: true } })
  const BANDS = [["Under 25", 0, 25], ["25–34", 25, 35], ["35–44", 35, 45], ["45–54", 45, 55], ["55–59", 55, 60], ["60+", 60, 200]]
  const active = emps.filter((e) => !["RESIGNED", "TERMINATED", "RETIRED"].includes(e.status))
  const ageOf = (dob: string) => Math.floor((Date.parse(t) - Date.parse(dob)) / (365.25 * 86400000))
  const rows = BANDS.map(([label, lo, hi]) => {
    const n = active.filter((e) => { const a = ageOf(e.dob || ""); return a >= (lo as number) && a < (hi as number) }).length
    return [label, n, active.length ? `${Math.round((n / active.length) * 1000) / 10}%` : "—"]
  })
  return { columns: ["Age Band", "Employees", "Share"], rows, meta: { count: rows.length, basis: `ages as of ${t}` } }
})

/** 3) Tenure bands — service-length distribution. */
reportRoute("tenureBands", async (ctx, _p) => {
  const t = today()
  const emps = await db.employee.findMany({ where: { ...employeeScopeFilter(ctx), joiningDate: { not: null } }, select: { joiningDate: true, status: true } })
  const BANDS = [["Under 1 year", 0, 1], ["1–2 years", 1, 2], ["2–5 years", 2, 5], ["5–10 years", 5, 10], ["10+ years", 10, 100]]
  const active = emps.filter((e) => !["RESIGNED", "TERMINATED", "RETIRED"].includes(e.status))
  const yearsOf = (j: string) => (Date.parse(t) - Date.parse(j)) / (365.25 * 86400000)
  const rows = BANDS.map(([label, lo, hi]) => {
    const n = active.filter((e) => { const y = yearsOf(e.joiningDate || ""); return y >= (lo as number) && y < (hi as number) }).length
    return [label, n, active.length ? `${Math.round((n / active.length) * 1000) / 10}%` : "—"]
  })
  return { columns: ["Tenure Band", "Employees", "Share"], rows, meta: { count: rows.length, basis: `tenure as of ${t}` } }
})

/** 4) Absenteeism trend — absent days and rate per month, 12 months. */
reportRoute("absenteeismTrend", async (ctx, p) => {
  const { year } = monthPrefixOf(p)
  const emps = await db.employee.findMany({ where: { ...employeeScopeFilter(ctx), status: { in: ["ACTIVE", "PROBATION", "ON_LEAVE", "SUSPENDED"] } }, select: { id: true } })
  const ids = emps.map((e) => e.id)
  const byMonth = await db.attendance.groupBy({
    by: ["date"], _count: { _all: true },
    where: { vendorId: ctx.vendorId, employeeId: { in: ids }, status: "ABSENT", date: { startsWith: String(year) } },
  })
  const activeCount = Math.max(1, ids.length)
  const rows = Array.from({ length: 12 }, (_, i) => {
    const m = String(i + 1).padStart(2, "0")
    const absentDays = byMonth.filter((r) => r.date.slice(5, 7) === m).reduce((s, r) => s + (r._count._all || 0), 0)
    const daysInMonth = new Date(Number(year), i + 1, 0).getDate()
    // absenteeism rate: absent employee-days ÷ possible employee-days
    const rate = Math.round((absentDays / (activeCount * daysInMonth)) * 1000) / 10
    return [`${monthName(i + 1)} ${year}`, absentDays, `${rate}%`]
  })
  return {
    columns: ["Month", "Absent Employee-Days", "Absenteeism Rate"],
    rows,
    meta: { count: rows.length, year, note: "rate = absent employee-days ÷ (active headcount × calendar days)" },
  }
})

/** 5) OT cost (taka) — estimated overtime cost per employee for a month,
 *  tier-aware (weekday/weekly-off/holiday multipliers) on the payroll
 *  hourly basis (basic ÷ 208 hours). */
reportRoute("otCost", async (ctx, p) => {
  const { prefix } = monthPrefixOf(p)
  const emps = await scopedEmployees(ctx, { ...p, status: undefined })
  const settings = await getSettings(ctx.vendorId)
  const otRates = settings.otRates || { weekdayRate: 1.5, holidayRate: 2, weeklyOffRate: 2 } as any
  const recs = await db.attendance.findMany({
    where: { vendorId: ctx.vendorId, employeeId: { in: emps.map((e) => e.id) }, date: { startsWith: prefix }, overtimeMinutes: { gt: 0 } },
  })
  const structures = await db.salaryStructure.findMany({ where: { vendorId: ctx.vendorId, employeeId: { in: emps.map((e) => e.id) }, status: "ACTIVE" } })
  const basicByEmp = new Map<string, number>()
  for (const s of structures) if (!basicByEmp.has(s.employeeId)) basicByEmp.set(s.employeeId, Number(s.basic) || 0)
  const holidays = await db.holiday.findMany({ where: { vendorId: ctx.vendorId, date: { startsWith: prefix } }, select: { date: true, branchId: true } })
  const wd = ["SUNDAY", "MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY"]
  // canonical weekly-off resolution (employee > shift > vendor), same as payroll
  const offsByEmp = new Map<string, string[]>()
  for (const e of emps as any[]) {
    offsByEmp.set(e.id, resolveWeeklyOffDays(e.weeklyOff, null, settings.general.weeklyHoliday))
  }
  const rows = emps.map((e: any) => {
    const mine = recs.filter((r) => r.employeeId === e.id)
    if (!mine.length) return null
    const basic = basicByEmp.get(e.id) || 0
    const hourRate = basic / 208
    const offs = offsByEmp.get(e.id) || []
    let cost = 0, minutes = 0
    for (const r of mine) {
      const dow = wd[new Date(`${r.date}T00:00:00Z`).getUTCDay()]
      const isHoliday = holidays.some((h) => h.date === r.date && (!h.branchId || h.branchId === e.branchId))
      const mult = isHoliday ? otRates.holidayRate : offs.includes(dow) ? otRates.weeklyOffRate : otRates.weekdayRate
      cost += (r.overtimeMinutes / 60) * hourRate * mult
      minutes += r.overtimeMinutes
    }
    return [e.fullName, Math.round(minutes / 60 * 10) / 10, Math.round(cost), Math.round(cost * 100) / 100 === Math.round(cost) ? `৳${Math.round(cost).toLocaleString("en-IN")}` : `৳${Math.round(cost * 100) / 100}`]
  }).filter(Boolean) as (string | number)[][]
  const total = rows.reduce((s, r) => s + Number(r[2] || 0), 0)
  return {
    columns: ["Employee", "OT Hours", "Estimated Cost (৳)", "Formatted"],
    rows: rows.sort((a, b) => Number(b[2]) - Number(a[2])),
    meta: { count: rows.length, month: prefix, totalCost: Math.round(total), note: "hourly basis = basic ÷ 208h; tier multipliers follow the vendor OT rates" },
  }
})

/** 6) Holiday calendar — the year's holidays with type and branch scope,
 *  plus an ICS export twin (enterprise standard). */
reportRoute("holidayCalendar", async (ctx, p) => {
  const { year } = monthPrefixOf(p)  // month unused by design (whole-year view)
  const holidays = await db.holiday.findMany({ where: { vendorId: ctx.vendorId, date: { startsWith: String(year) } }, orderBy: { date: "asc" } })
  const branches = await db.branch.findMany({ where: { vendorId: ctx.vendorId }, select: { id: true, name: true } })
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
    const holidays = await db.holiday.findMany({ where: { vendorId: ctx.vendorId, date: { startsWith: String(year) } }, orderBy: { date: "asc" } })
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
  const run = await db.payrollRun.findFirst({
    where: { vendorId: ctx.vendorId, periodMonth: Number(p?.month || 1), periodYear: Number(p?.year || new Date().getUTCFullYear()), periodWeek, status: { in: ["APPROVED", "PROCESSING", "PAID"] }, runType: "REGULAR" },
    orderBy: [{ calcEpoch: "desc" }, { createdAt: "desc" }],
  })
  if (!run) return { columns: ["No payable run for this period"], rows: [], meta: { run: null } }
  const emps = await db.employee.findMany({ where: employeeScopeFilter(ctx), select: { id: true, fullName: true } })
  const entries = await db.payrollEntry.findMany({ where: { runId: run.id, employeeId: { in: emps.map((e) => e.id) } } })
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
    ["Total gross (৳)", Math.round(run.totalGross)],
    ["Total net (৳)", Math.round(run.totalNet)],
    ["Bank transfers", `${byMethod.BANK.n} · ৳${Math.round(byMethod.BANK.net).toLocaleString("en-IN")}`],
    ["MFS payouts", `${byMethod.MFS.n} · ৳${Math.round(byMethod.MFS.net).toLocaleString("en-IN")}`],
    ["Cash payouts", `${byMethod.CASH.n} · ৳${Math.round(byMethod.CASH.net).toLocaleString("en-IN")}`],
    ["Payslips missing a number", noSlip],
    ["Duplicate payslip numbers", dupSlips],
  ]
  return { columns: ["Metric", "Value"], rows, meta: { count: rows.length, run: { id: run.id, status: run.status } } }
})

/** 8) Diversity over time — gender mix by joining cohort year. */
reportRoute("diversityOverTime", async (ctx, _p) => {
  const emps = await db.employee.findMany({ where: { ...employeeScopeFilter(ctx), joiningDate: { not: null } }, select: { joiningDate: true, gender: true } })
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

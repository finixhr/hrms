// ============ Resignation, Notice, Clearance & Final Settlement routes (spec §14) ============
// WP-L (Wave 2): exit clearance ⇄ company assets — the clearance checklist
// cannot be COMPLETED while the exiting employee still holds unreturned
// assets; each outstanding handover can be marked returned or cleared with a
// deduction that lands as a FinalSettlement line.
import { db } from "@/lib/db"
import { z } from "zod"
import { route } from "./registry"
import { Deny, assertEmployeeVisible, scopedEmployeeWhere , applyEmployeeSearch } from "../rbac"
import { audit, notify } from "../audit"
import { notifyChannels } from "../delivery"
import { postJournal } from "../accounting"
import { daysBetween, dailyRate, j, today, resolveWeeklyOffDays, titleCase, addDays as addDaysIso } from "../utils"
import { getSettings } from "../settings"
import { computeGratuity, completedMonthsBetween } from "../gratuity"
import { workingDaysInWindow } from "../payroll"
import { pfNoteHash } from "../pf-import"
import { deactivateMappingsForEmployee } from "../zkteco/processor"
import { returnAssetAssignment } from "./assets"
import { id, moneyPositive, textOpt, S } from "../validation"
import { spendableDays, encashableDaysFor, leaveYearOf } from "../leave-math"

export const CLEARANCE_DEPARTMENTS = ["HR", "Finance", "Accounts", "IT", "Admin", "Warehouse", "Management"]
export const CLEARANCE_ITEMS = [
  "Company assets returned", "ID card returned", "Laptop returned", "System access revoked",
  "Loan settled", "Advance recovered", "Expenses settled", "Documents returned", "Final payroll processed",
]

/** Resolves exit type ("TERMINATION" | "RETIREMENT" | "RESIGNATION") from resignation metadata / employee status */
export function resolveExitType(
  res?: { reason?: string | null; remarks?: string | null; letterName?: string | null } | null,
  empStatus?: string | null,
): "TERMINATION" | "RETIREMENT" | "RESIGNATION" {
  if (empStatus === "TERMINATED") return "TERMINATION"
  if (empStatus === "RETIRED") return "RETIREMENT"
  if (res?.letterName === "EXIT_TYPE:TERMINATION") return "TERMINATION"
  if (res?.letterName === "EXIT_TYPE:RETIREMENT") return "RETIREMENT"
  const combined = `${res?.remarks || ""} ${res?.reason || ""}`
  if (/\[EXIT_TYPE:TERMINATION\]|\[Termination\]|^Termination:/i.test(combined)) return "TERMINATION"
  if (/\[EXIT_TYPE:RETIREMENT\]|\[Retirement\]|^Retirement:/i.test(combined)) return "RETIREMENT"
  return "RESIGNATION"
}

export function cleanExitRemarks(remarks?: string | null): string {
  if (!remarks) return ""
  return remarks.replace(/\[EXIT_TYPE:(?:TERMINATION|RETIREMENT|RESIGNATION)\]\s*/gi, "").trim()
}

/** EXIT-004 (fix brought into the pay/closure paths this wave) — map the
 *  internal exit type onto the Employee.status vocabulary the whole app
 *  recognizes (schema.prisma, reports, filters, badges, terminate guard):
 *  RESIGNATION → RESIGNED, TERMINATION → TERMINATED, RETIREMENT → RETIRED.
 *  Writing the internal nouns onto employee.status left exited employees
 *  invisible to every downstream consumer. */
export function exitStatusForEmployee(
  exitType: "TERMINATION" | "RETIREMENT" | "RESIGNATION",
): "TERMINATED" | "RETIRED" | "RESIGNED" {
  return exitType === "TERMINATION" ? "TERMINATED" : exitType === "RETIREMENT" ? "RETIRED" : "RESIGNED"
}

/** EXIT-003 (R3-1) — notice-pay DIRECTION matrix, pure + unit-tested.
 *
 *  Who owes whom for unserved notice days:
 *   - RESIGNATION with SHORT/BUYOUT notice → the EMPLOYEE owes the shortfall
 *     (recovered from the settlement — the historical behaviour).
 *   - TERMINATION / RETIREMENT, or a formally WAIVED / EARLY_RELEASE notice →
 *     the EMPLOYER released the employee early, so the COMPANY owes notice
 *     pay (a payable component added to gross, NOT a deduction).
 *  The old engine deducted the shortfall unconditionally: an immediate
 *  termination (served 0, mode "Waived") had a full 30 days' pay deducted
 *  from the employee's final settlement. */
export function resolveNoticeComponent(args: {
  exitType: "TERMINATION" | "RETIREMENT" | "RESIGNATION"
  noticeMode?: string | null
  requiredNoticeDays: number
  servedDays: number
  dailyWage: number
}): { shortNoticeDays: number; noticeBuyout: number; noticePay: number } {
  const required = Math.max(0, Math.round(args.requiredNoticeDays || 0))
  const served = Math.max(0, Math.round(args.servedDays || 0))
  const shortNoticeDays = Math.max(0, required - served)
  if (shortNoticeDays <= 0 || !(args.dailyWage > 0)) {
    return { shortNoticeDays: 0, noticeBuyout: 0, noticePay: 0 }
  }
  const employerOwes =
    args.exitType === "TERMINATION" ||
    args.exitType === "RETIREMENT" ||
    args.noticeMode === "WAIVED" ||
    args.noticeMode === "EARLY_RELEASE"
  const amount = Math.round(shortNoticeDays * args.dailyWage)
  return employerOwes
    ? { shortNoticeDays, noticeBuyout: 0, noticePay: amount }
    : { shortNoticeDays, noticeBuyout: amount, noticePay: 0 }
}

/** EXIT-008 (R3-2) — BD statutory notice matrix, pure + unit-tested.
 *
 *  Required notice days by employment type and service length:
 *   - PROBATIONARY → 7 days (spec §14.2, unchanged)
 *   - worker matrix ON (monthly-rated workers, BLA §80/81 as amended 2018):
 *       ≥ 5 years' continuous service → 120 days
 *       < 5 years → 60 days
 *   - staff / contract convention (matrix OFF) → the tenant's
 *     Settings → Employee → defaultNoticePeriodDays (default 30)
 *  The DECIDED value is persisted on the resignation (noticeDays) and the
 *  settlement reads that — the old engine recomputed a hardcoded 7/30 and
 *  silently discarded the configurable default. */
export function resolveRequiredNoticeDays(args: {
  employmentType?: string | null
  serviceYears?: number
  defaultNoticeDays?: number
  workerMatrix?: boolean
}): number {
  if (args.employmentType === "PROBATIONARY") return 7
  if (args.workerMatrix) {
    const years = Math.max(0, Math.round(args.serviceYears || 0))
    return years >= 5 ? 120 : 60
  }
  return Math.max(1, Math.round(args.defaultNoticeDays || 30))
}

/** EXIT-010 (R3-2) — notice is served from the LATER of the employee-stated
 *  resignation date and the actual submission date. A backdated letter can no
 *  longer manufacture "served" notice days the employee did not work: the
 *  employee-stated date is kept as metadata, but the buyout math and the
 *  persisted servedDays both use this effective start. */
export function effectiveNoticeStart(resignationDate: string, submissionDate?: string | null): string {
  return submissionDate && submissionDate > resignationDate ? submissionDate : resignationDate
}

const WD_NAMES = ["SUNDAY", "MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY"]
const dowOf = (ds: string) => WD_NAMES[new Date(`${ds}T00:00:00Z`).getUTCDay()]

/** EXIT-005 (R3-2) — final-month salary on the PAYROLL convention, pure +
 *  unit-tested. Replaces `dailyRate(gross) × calendar-day-of-month`, which
 *  mixed a 26-day divisor with a calendar numerator (Jan 31 → 119% of the
 *  monthly gross) and never deducted absences. Now:
 *    finalSalary = gross × (working days 1→LWD / month working days)
 *                − absent days × (gross / month working days)
 *                − gross already paid for the LWD month (payroll netting)
 *  Weekly-off days are unpaid by both engines; holidays count as payable
 *  days (payroll parity: a missing record is only absent when it is neither
 *  weekly-off nor holiday); LEAVE days are paid, HALF_DAY counts 0.5 absent —
 *  the same aggregation calculateRun applies. */
export function computeFinalSalary(args: {
  gross: number
  lwd: string
  weeklyOff: string[]
  holidays: string[]
  attendance: { date: string; status: string }[]
  joiningDate?: string | null
  monthlyGrossAlreadyPaid?: number
}): {
  monthWorkingDays: number; daysUptoLwd: number; absentDays: number; dailyRate: number
  grossProrated: number; absenceDeduction: number; alreadyPaid: number; finalSalary: number; netted: boolean
} {
  const monthPrefix = args.lwd.slice(0, 7)
  const yearNum = Number(monthPrefix.slice(0, 4))
  const monthNum = Number(monthPrefix.slice(5, 7))
  const periodEnd = new Date(Date.UTC(yearNum, monthNum, 0)).toISOString().slice(0, 10) // last day of LWD month
  const monthStart = `${monthPrefix}-01`
  // payable window starts at the later of the month start and the joining date
  const windowStart = args.joiningDate && args.joiningDate > monthStart ? args.joiningDate : monthStart
  const monthWorkingDays = Math.max(1, workingDaysInWindow(monthStart, periodEnd, args.weeklyOff))
  const daysUptoLwd = workingDaysInWindow(windowStart, args.lwd, args.weeklyOff)
  const holidays = new Set(args.holidays)
  const attByDate = new Map(args.attendance.map((a) => [a.date, a]))

  let absentDays = 0
  let cur = windowStart
  let guard = 0
  while (cur <= args.lwd && guard < 400) {
    guard++
    const a = attByDate.get(cur)
    if (a) {
      if (a.status === "ABSENT") absentDays += 1
      else if (a.status === "HALF_DAY") absentDays += 0.5
    } else if (!args.weeklyOff.includes(dowOf(cur)) && !holidays.has(cur)) {
      absentDays += 1 // no record at all → absent (payroll parity)
    }
    cur = addDaysIso(cur, 1)
  }

  const daily = args.gross / monthWorkingDays
  const grossProrated = Math.round((args.gross * daysUptoLwd) / monthWorkingDays)
  const absenceDeduction = Math.round(absentDays * daily)
  const alreadyPaid = Math.max(0, Math.round(args.monthlyGrossAlreadyPaid || 0))
  const finalSalary = Math.max(0, grossProrated - absenceDeduction - alreadyPaid)
  return {
    monthWorkingDays, daysUptoLwd, absentDays,
    dailyRate: Math.round(daily * 100) / 100,
    grossProrated, absenceDeduction, alreadyPaid,
    finalSalary, netted: alreadyPaid > 0,
  }
}

/** EXIT-013 (R3-2) — settlement overtime on the payroll engine's convention,
 *  pure + unit-tested. The old settlement OT ignored Settings → Payroll →
 *  OT rates (hardcoded 1.5/2/2), had no monthly cap and no rounding step, so
 *  the final month could pay OT the regular engine would have capped. This
 *  mirrors calculateRun exactly: settings.otRates (shift multipliers still
 *  win), the maxOtHoursPerMonth cap applied across the month, and the
 *  roundToMinutes step. */
export function computeSettlementOt(args: {
  basic: number
  attendance: { date: string; overtimeMinutes?: number | null; otApproved?: boolean | null }[]
  weeklyOff: string[]
  holidays: string[]
  shift?: { otMultiplier?: number | null; otHolidayMultiplier?: number | null; otWeeklyOffMultiplier?: number | null } | null
  otRates?: { weekdayRate?: number; holidayRate?: number; weeklyOffRate?: number; calcBasis?: string; roundToMinutes?: number } | null
  otApprovalRequired?: boolean
  maxOtHoursPerMonth?: number
}): { otAmount: number; otMinutes: number; capped: boolean } {
  const rates = args.otRates || { weekdayRate: 1.5, holidayRate: 2, weeklyOffRate: 2, calcBasis: "FIXED", roundToMinutes: 0 }
  const roundOt = (mins: number) => {
    const step = Math.max(0, rates.roundToMinutes || 0)
    if (!step || rates.calcBasis === "FIXED") return mins
    return rates.calcBasis === "ROUNDED_UP" ? Math.ceil(mins / step) * step : Math.round(mins / step) * step
  }
  const hourRate = args.basic / 208
  const capMinutes = args.maxOtHoursPerMonth && args.maxOtHoursPerMonth > 0 ? args.maxOtHoursPerMonth * 60 : Infinity
  const holidays = new Set(args.holidays)
  let remainingCap = capMinutes
  let otAmount = 0
  let paidMinutes = 0
  let rawMinutes = 0
  for (const a of args.attendance) {
    const otMinutes = a.overtimeMinutes || 0
    if (!(otMinutes > 0)) continue
    rawMinutes += otMinutes
    if (args.otApprovalRequired && a.otApproved === false) continue
    if (remainingCap <= 0) continue
    const take = Math.min(otMinutes, remainingCap)
    remainingCap -= take
    const tier = holidays.has(a.date) ? "holiday" : args.weeklyOff.includes(dowOf(a.date)) ? "weekly-off" : "weekday"
    const multiplier = tier === "holiday" ? (args.shift?.otHolidayMultiplier ?? rates.holidayRate ?? 2)
      : tier === "weekly-off" ? (args.shift?.otWeeklyOffMultiplier ?? rates.weeklyOffRate ?? 2)
        : (args.shift?.otMultiplier ?? rates.weekdayRate ?? 1.5)
    const payable = Math.max(0, roundOt(take))
    otAmount += (payable / 60) * hourRate * multiplier
    paidMinutes += take
  }
  return { otAmount: Math.round(otAmount), otMinutes: rawMinutes, capped: rawMinutes > paidMinutes }
}

route("resignations.list", {
  perm: ["exit", "view"],
  handler: async (ctx, p) => {
    // P6 WS-B — scope-only where feeds the paged `summary` block (the KPI
    // strip shows the caller's cohort truth, independent of table filters)
    const scopeWhere: any = { vendorId: ctx.vendorId, ...await scopedEmployeeWhere(ctx, p) }
    const where: any = { ...scopeWhere }
    if (p?.status) where.status = p.status
    // P6 WS-B — server-side search (q matches employee name/code, intersected
    // with the caller's scope — the SCL-10 discipline)
    await applyEmployeeSearch(ctx.vendorId, where, p?.q)
    // M-11 follow-up (P6 WS-B) — optional MOD-16 pagination (page/pageSize →
    // { items, total, page, pageSize, summary }, bounded at 500; legacy
    // callers keep the full-array contract). The old handler loaded EVERY
    // resignation, the FULL employee directory, ALL clearances, ALL
    // settlements and ALL outstanding asset assignments on every request.
    const paged = p?.page != null || p?.pageSize != null
    const pageSize = Math.min(500, Math.max(1, Number(p?.pageSize) || 200))
    const page = Math.max(1, Number(p?.page) || 1)
    const [list, total, byStatus] = paged
      ? await Promise.all([
          db.resignation.findMany({ where, orderBy: [{ createdAt: "desc" }, { id: "asc" }], skip: (page - 1) * pageSize, take: pageSize }),
          db.resignation.count({ where }),
          db.resignation.groupBy({ by: ["status"], where: scopeWhere, _count: { _all: true } }),
        ])
      : [await db.resignation.findMany({ where, orderBy: { createdAt: "desc" } }), null, null]
    // page-scoped decoration: only the PAGE's employees / resignations
    const empIds = [...new Set(list.map((r) => r.employeeId))]
    const employees = empIds.length
      ? await db.employee.findMany({ where: { vendorId: ctx.vendorId, id: { in: empIds } }, select: { id: true, fullName: true, code: true, status: true } })
      : []
    const resIds = list.map((r) => r.id)
    const [clearances, settlements] = resIds.length
      ? await Promise.all([
          db.exitClearance.findMany({ where: { vendorId: ctx.vendorId, resignationId: { in: resIds } } }),
          db.finalSettlement.findMany({ where: { vendorId: ctx.vendorId, resignationId: { in: resIds } } }),
        ])
      : [[], []]
    // WP-L — outstanding company assets per exiting employee (returnedAt = null)
    const outstandingAssignments = empIds.length
      ? await db.assetAssignment.findMany({
          where: { vendorId: ctx.vendorId, employeeId: { in: empIds }, returnedAt: null },
        })
      : []
    const assetMap = new Map((await db.asset.findMany({
      where: { vendorId: ctx.vendorId, id: { in: outstandingAssignments.map((a) => a.assetId) } },
      select: {
        id: true, code: true, name: true, category: true, status: true, condition: true, purchaseCost: true,
        brandModel: true, serialImei: true, purchaseDate: true, warrantyExpiry: true,
      },
    })).map((a) => [a.id, a]))
    const mapped = list.map((r) => {
      const emp = employees.find((e) => e.id === r.employeeId)
      const exitType = resolveExitType(r, emp?.status)
      return {
        ...r,
        exitType,
        remarks: cleanExitRemarks(r.remarks),
        rawRemarks: r.remarks,
        employeeName: emp?.fullName || "—",
        employeeCode: emp?.code,
        employeeStatus: emp?.status || null,
        clearance: clearances.find((c) => c.resignationId === r.id) || null,
        settlement: settlements.find((s) => s.resignationId === r.id) || null,
        outstandingAssets: outstandingAssignments
          .filter((a) => a.employeeId === r.employeeId)
          .map((a) => {
            const asset = assetMap.get(a.assetId)
            return {
              assignmentId: a.id,
              assetId: a.assetId,
              assetCode: asset?.code || "—",
              assetName: asset?.name || "—",
              category: asset?.category || "OTHER",
              brandModel: asset?.brandModel || null,
              serialImei: asset?.serialImei || null,
              purchaseDate: asset?.purchaseDate || null,
              warrantyExpiry: asset?.warrantyExpiry || null,
              assetStatus: asset?.status || null,
              conditionOut: a.conditionOut,
              assignedAt: a.assignedAt,
              dueAt: a.dueAt,
              purchaseCost: asset?.purchaseCost ?? null,
              note: a.note,
            }
          }),
      }
    })
    if (p?.exitType && p.exitType !== "ALL") {
      const filtered = mapped.filter((r) => r.exitType === p.exitType)
      // exitType is a DERIVED field (post-query filter) — in paged mode the
      // total reports the unfiltered page's count; the UI shows the honest
      // on-page counter for this filter (the same discipline as the P5
      // subscriptions cycle filter).
      if (!paged) return filtered
      return { items: filtered, total, page, pageSize, summary: await exitSummary(scopeWhere, byStatus) }
    }
    if (!paged) return mapped
    return { items: mapped, total, page, pageSize, summary: await exitSummary(scopeWhere, byStatus) }
  },
})

/** P6 WS-B — the resignations KPI strip's cohort truth, set-based: the status
 *  mix (notice-period / completed) + pending settlements (settlement rows in
 *  DRAFT/CALCULATED/APPROVED attached to a resignation in scope). */
async function exitSummary(scopeWhere: any, byStatus: { status: string; _count: { _all: number } }[] | null) {
  const scopeIds = await db.resignation.findMany({ where: scopeWhere, select: { id: true } })
  const pendingSettlements = scopeIds.length
    ? await db.finalSettlement.count({
        where: { resignationId: { in: scopeIds.map((r) => r.id) }, status: { in: ["DRAFT", "CALCULATED", "APPROVED"] } },
      })
    : 0
  const statusCount = new Map((byStatus || []).map((g) => [g.status, g._count._all]))
  return {
    total: [...statusCount.values()].reduce((s, n) => s + n, 0),
    inNotice: statusCount.get("NOTICE_PERIOD") || 0,
    completed: statusCount.get("COMPLETED") || 0,
    pendingSettlements,
  }
}

  // INTENTIONALLY_SELF_SCOPED (M-02): self-service exit initiation: handler enforces ctx.employeeId == payload employeeId
route("resignations.submit", {
  handler: async (ctx, p) => {
    const employeeId = ctx.role === "EMPLOYEE" ? ctx.employeeId : p.employeeId
    if (!employeeId) throw new Deny("No employee profile linked", 400)
    if (ctx.role === "EMPLOYEE" && p.employeeId && p.employeeId !== ctx.employeeId) {
      throw new Deny("You can only submit your own resignation")
    }
    // H-04/H-05 — HR filing on behalf must target an employee inside their scope
    if (ctx.role !== "EMPLOYEE" && p.employeeId && p.employeeId !== ctx.employeeId) {
      await assertEmployeeVisible(ctx, p.employeeId)
    }
    const emp = await db.employee.findFirst({ where: { id: employeeId, vendorId: ctx.vendorId } })
    if (!emp) throw new Deny("Employee not found", 404)
    if (!["ACTIVE", "PROBATION", "ON_LEAVE"].includes(emp.status)) throw new Deny(`Cannot submit resignation while status is ${emp.status}`)
    const existing = await db.resignation.findFirst({ where: { vendorId: ctx.vendorId, employeeId, status: { in: ["SUBMITTED", "UNDER_REVIEW", "MANAGER_APPROVED", "HR_REVIEW", "MANAGEMENT_REVIEW", "NOTICE_PERIOD", "ACCEPTED"] } } })
    if (existing) throw new Deny("An active resignation already exists for this employee")

    if (!p.resignationDate || !p.proposedLwd || !p.reason) throw new Deny("Resignation date, proposed last working day and reason are required")
    if (p.proposedLwd < p.resignationDate) throw new Deny("Last working day cannot be before resignation date")

    // Default notice period from Settings → Employee (fallback 30 — the
    // previous hardcoded value — so behavior is unchanged until configured)
    const settings = await getSettings(ctx.vendorId)
    const noticeDays = Math.max(1, Math.round(Number(settings.employeeSettings?.defaultNoticePeriodDays) || 30))

    const rec = await db.resignation.create({
      data: {
        vendorId: ctx.vendorId, employeeId,
        submissionDate: today(), resignationDate: p.resignationDate, proposedLwd: p.proposedLwd,
        reason: p.reason, remarks: p.remarks || null,
        letterName: p.letterName || null, letterData: p.letterData || null,
        status: "SUBMITTED", noticeDays,
      },
    })
    const { submitForApproval } = await import("../approval")
    const approvalId = await submitForApproval(ctx, "RESIGNATION", "Resignation", rec.id,
      `Resignation — ${emp.fullName}`, { employeeId, amount: 0, resignationId: rec.id })
    await db.resignation.update({ where: { id: rec.id }, data: { approvalRequestId: approvalId } })
    await audit(ctx, "resignations.submit", "Resignation", rec.id, `${emp.fullName} resigned — proposed LWD ${p.proposedLwd}`)
    if (emp.reportingManagerId) {
      await notifyChannels(ctx.vendorId, { employeeId: emp.reportingManagerId }, "Resignation Submitted",
        `${emp.fullName} submitted a resignation. Proposed last working day: ${p.proposedLwd}.`, "EXIT", "approvals",
        { email: true }, "resignation_submitted",
        { employee: emp.fullName, proposedLwd: p.proposedLwd, reason: p.reason || "" })
    }
    return rec
  },
})

  // INTENTIONALLY_SELF_SCOPED (M-02): self-service: only the caller's own resignation can be withdrawn
route("resignations.withdraw", {
  handler: async (ctx, p) => {
    const rec = await db.resignation.findFirst({ where: { id: p.id, vendorId: ctx.vendorId } })
    if (!rec) throw new Deny("Not found", 404)
    const _settings = await getSettings(ctx.vendorId)
    const own = ctx.employeeId === rec.employeeId
    if (!own && !ctx.permissions.has("exit.approve")) throw new Deny("Not authorized")
    // Employee can withdraw until a configurable stage (default: until MANAGEMENT_REVIEW)
    if (["ACCEPTED", "COMPLETED", "WITHDRAWN", "REJECTED"].includes(rec.status)) {
      throw new Deny(`Cannot withdraw a ${rec.status.toLowerCase()} resignation`)
    }
    await db.resignation.update({ where: { id: rec.id }, data: { status: "WITHDRAWN", withdrawnAt: new Date(), withdrawStage: rec.status } })
    if (rec.approvalRequestId) {
      await db.approvalRequest.updateMany({ where: { id: rec.approvalRequestId, status: "PENDING" }, data: { status: "WITHDRAWN" } })
    }
    await audit(ctx, "resignations.withdraw", "Resignation", rec.id, "Resignation withdrawn")
    return { withdrawn: true }
  },
})

/** RESIGNATION finalize hook — accepted → notice period + status change. */
export async function applyResignationDecision(ctx: { userId: string; userName: string; vendorId: string }, resignationId: string, decision: string) {
  const rec = await db.resignation.findFirst({ where: { id: resignationId, vendorId: ctx.vendorId } })
  if (!rec || !["SUBMITTED", "UNDER_REVIEW", "MANAGER_APPROVED", "HR_REVIEW", "MANAGEMENT_REVIEW"].includes(rec.status)) return
  const emp = await db.employee.findUnique({ where: { id: rec.employeeId } })
  if (decision === "APPROVED") {
    // Notice period computation (spec §14.2)
    // EXIT-008 (R3-2) — the required notice comes from the BD statutory
    // matrix (PROBATIONARY 7d; BLA worker 120d ≥5y / 60d <5y when the tenant
    // enables the worker matrix; otherwise the configurable staff default),
    // and the DECIDED value is what gets persisted — the old code recomputed
    // a hardcoded 7/30 here, silently discarding the Settings → Employee
    // default that was stored at submission.
    const noticeSettings = await getSettings(ctx.vendorId)
    const serviceMonths = completedMonthsBetween(emp?.joiningDate || "", rec.proposedLwd)
    const requiredNotice = resolveRequiredNoticeDays({
      employmentType: emp?.employmentType,
      serviceYears: Math.floor(Math.max(0, serviceMonths) / 12),
      defaultNoticeDays: Number(noticeSettings.employeeSettings?.defaultNoticePeriodDays) || 30,
      workerMatrix: !!noticeSettings.employeeSettings?.workerNoticeMatrix,
    })
    // EXIT-010 (R3-2) — notice is served from max(resignation date,
    // submission date): a backdated letter cannot manufacture served days.
    const noticeStart = effectiveNoticeStart(rec.resignationDate, rec.submissionDate)
    const served = daysBetween(noticeStart, rec.proposedLwd)
    let noticeMode = "FULL"
    if (served >= requiredNotice) noticeMode = "FULL"
    else if (served >= requiredNotice / 2) noticeMode = "SHORT"
    else if (served > 0) noticeMode = "BUYOUT"
    else noticeMode = "WAIVED"
    const actualLwd = rec.proposedLwd

    await db.resignation.update({
      where: { id: rec.id },
      data: { status: "NOTICE_PERIOD", acceptedAt: new Date(), actualLwd, noticeMode, noticeDays: requiredNotice, servedDays: Math.max(0, served), closureStatus: "SCHEDULED" },
    })
    // Employee stays ACTIVE while serving notice — the resignation record tracks
    // notice; ON_LEAVE here was semantically wrong (they are working the notice).
    // create exit clearance checklist
    const checklist = CLEARANCE_DEPARTMENTS.map((dept) => ({
      department: dept, items: CLEARANCE_ITEMS.map((item) => ({ item, cleared: false })),
    }))
    await db.exitClearance.create({
      data: { vendorId: ctx.vendorId, resignationId: rec.id, checklistJson: JSON.stringify(checklist), status: "PENDING" },
    })
    await db.employeeHistory.create({
      data: { vendorId: ctx.vendorId, employeeId: rec.employeeId, eventType: "RESIGNATION",
        title: "Resignation accepted — notice period started",
        description: `${noticeMode} notice · LWD ${actualLwd} (served ${Math.max(0, served)}/${requiredNotice} days, counted from ${noticeStart})`,
        effectiveDate: noticeStart, dataJson: JSON.stringify({ resignationId: rec.id }) },
    })
    await notify(ctx.vendorId, { employeeId: rec.employeeId }, "Resignation Accepted",
      `Your resignation is accepted. Notice period: ${noticeMode.toLowerCase()} — last working day ${actualLwd}. Exit clearance checklist is now available.`, "EXIT", "ess")
    // HRM-018 — closure workflow armed: user account + device enrollment are
    // revoked on the last working day (daily job), HR + owner are told now.
    await notify(ctx.vendorId, { role: "HR_ADMIN" }, "Exit Closure Scheduled",
      `${emp?.fullName || "Employee"}'s access closure is scheduled for their last working day (${actualLwd}): user account will be disabled and biometric enrollment revoked automatically.`, "EXIT", "exit")
    await notify(ctx.vendorId, { role: "VENDOR_OWNER" }, "Exit Closure Scheduled",
      `${emp?.fullName || "Employee"}'s exit is scheduled for ${actualLwd}. The access-closure workflow will run automatically on that date.`, "EXIT", "exit")
    await audit(ctx, "exit.closureScheduled", "Resignation", rec.id,
      `Access/status closure scheduled for LWD ${actualLwd} (user disable + device enrollment revocation + clearance)`,
      { newValue: { resignationId: rec.id, lwd: actualLwd } })
  } else {
    await db.resignation.update({ where: { id: rec.id }, data: { status: "REJECTED", actedBy: ctx.userId, actedAt: new Date() } })
    await notify(ctx.vendorId, { employeeId: rec.employeeId }, "Resignation Rejected",
      "Your resignation was not accepted. Please discuss with HR.", "EXIT", "ess")
  }
}

route("clearance.save", {
  perm: ["exit", "process"],
  handler: async (ctx, p) => {
    const clearance = await db.exitClearance.findFirst({ where: { id: p.id, vendorId: ctx.vendorId } })
    if (!clearance) throw new Deny("Clearance record not found", 404)
    const checklist = p.checklist // [{department, items:[{item, cleared}]}]
    const allCleared = checklist.every((d: any) => d.items.every((i: any) => i.cleared))
    // WP-L — HARD BLOCK: the clearance cannot be COMPLETED while the exiting
    // employee still holds unreturned company assets. The checklist may be
    // saved as IN_PROGRESS, but CLEARED requires every outstanding handover to
    // be closed first (Mark Returned, or Clear-with-deduction below).
    if (allCleared) {
      const res = await db.resignation.findFirst({ where: { id: clearance.resignationId, vendorId: ctx.vendorId } })
      if (res) {
        const outstanding = await db.assetAssignment.findMany({
          where: { vendorId: ctx.vendorId, employeeId: res.employeeId, returnedAt: null },
          select: { assetId: true },
        })
        if (outstanding.length > 0) {
          const assets = await db.asset.findMany({
            where: { vendorId: ctx.vendorId, id: { in: outstanding.map((o) => o.assetId) } },
            select: { code: true }, orderBy: { code: "asc" },
          })
          throw new Deny(
            `Clearance cannot be completed — ${outstanding.length} company asset${outstanding.length !== 1 ? "s" : ""} still unreturned: ${assets.map((a) => a.code).join(", ")}. Mark each handover returned (or clear it with a deduction) first.`,
            400,
          )
        }
      }
    }
    await db.exitClearance.update({
      where: { id: clearance.id },
      data: { checklistJson: JSON.stringify(checklist), status: allCleared ? "CLEARED" : "IN_PROGRESS", clearedAt: allCleared ? new Date() : null },
    })
    await audit(ctx, "clearance.save", "ExitClearance", clearance.id, `Clearance updated (${allCleared ? "all cleared" : "in progress"})`)
    return { status: allCleared ? "CLEARED" : "IN_PROGRESS" }
  },
})

// ---------- WP-L — exit clearance ⇄ company assets ----------

/** Close an outstanding handover straight from the exit case — the SAME
 *  logic/race-guards/AssetEvent as assets.return (shared implementation). */
const exitAssetReturnSchema = z.object({
  assignmentId: id,
  conditionIn: z.enum(["NEW", "GOOD", "FAIR", "DAMAGED"]).nullish(),
  note: textOpt(1000),
}).strict()

route("exit.assets.return", {
  perm: ["exit", "process"],
  schema: exitAssetReturnSchema,
  handler: async (ctx, p) => {
    const v = p as z.infer<typeof exitAssetReturnSchema>
    return returnAssetAssignment(ctx, v, "exit.assets.return")
  },
})

/** Clear an outstanding handover WITH a recovery deduction: the amount is
 *  recorded as a FinalSettlement deduction line (mirroring how
 *  settlements.calculate writes computationJson/netPayable) and the asset is
 *  retired — financially recovered, out of the active pool.
 *
 *  PERMISSION CHOICE: "exit.pay" — the exit module's money-moving permission
 *  (the same authority settlements.pay requires), the closest existing
 *  equivalent of expenses.approve / payroll.pay for the exit domain: a
 *  recovery deduction changes the final-settlement amount, i.e. real money. */
const exitAssetClearSchema = z.object({
  assignmentId: id,
  recoveryAmount: moneyPositive,
  note: textOpt(1000),
}).strict()

route("exit.assets.clearWithDeduction", {
  perm: ["exit", "pay"],
  schema: exitAssetClearSchema,
  handler: async (ctx, p) => {
    const v = p as z.infer<typeof exitAssetClearSchema>
    const assignment = await db.assetAssignment.findFirst({
      where: { id: v.assignmentId, vendorId: ctx.vendorId, returnedAt: null },
    })
    if (!assignment) throw new Deny("Outstanding asset assignment not found", 404)
    const asset = await db.asset.findFirst({ where: { id: assignment.assetId, vendorId: ctx.vendorId } })
    if (!asset) throw new Deny("Asset not found", 404)
    const res = await db.resignation.findFirst({
      where: { vendorId: ctx.vendorId, employeeId: assignment.employeeId, status: { in: ["NOTICE_PERIOD", "ACCEPTED", "COMPLETED"] } },
      orderBy: { createdAt: "desc" },
    })
    if (!res) throw new Deny("No active exit case (notice period, accepted resignation, or completed exit pending settlement) for this employee — use the Asset module's return or retire actions instead", 400)
    const emp = await db.employee.findFirst({
      where: { id: assignment.employeeId, vendorId: ctx.vendorId }, select: { fullName: true },
    })
    const note = (v.note || "").trim() || null
    const deductionTag = `cleared with deduction ৳${v.recoveryAmount}${note ? ` — ${note}` : ""}`
    const mergedNote = [assignment.note, deductionTag].filter(Boolean).join(" | ")

    // MON-6 (Phase 4) — the asset clear AND the settlement merge ride ONE
    // transaction, serialized per resignation by a FOR UPDATE row lock on the
    // Resignation (the one row every settlement writer passes). The old
    // sequence merged into the settlement AFTER the clear transaction
    // committed, on a snapshot read before it: two concurrent clears (or a
    // clear racing a settlements.calculate) each merged into the state they
    // had read and the second commit silently dropped the first deduction
    // line. The APPROVED/PAID guard is re-evaluated on the FRESH in-
    // transaction read, so an approval that landed mid-flight is respected.
    const netPayable = await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Resignation" WHERE id = ${res.id} FOR UPDATE`
      // check-and-set: a double-clear race loses cleanly
      const claimed = await tx.assetAssignment.updateMany({
        where: { id: assignment.id, vendorId: ctx.vendorId, returnedAt: null },
        data: { returnedAt: new Date(), note: mergedNote },
      })
      if (claimed.count === 0) throw new Deny("This handover was just cleared by someone else — refresh and try again", 409)
      // financially recovered → the asset leaves the active pool
      await tx.asset.updateMany({ where: { id: asset.id, vendorId: ctx.vendorId }, data: { status: "RETIRED" } })
      await tx.assetEvent.create({
        data: {
          vendorId: ctx.vendorId, assetId: asset.id, type: "CLEARED_WITH_DEDUCTION",
          actorId: ctx.userId, actorName: ctx.userName,
          snapshotJson: JSON.stringify({
            recoveryAmount: v.recoveryAmount, note,
            assignmentId: assignment.id, resignationId: res.id, employeeId: assignment.employeeId,
          }).slice(0, 4000),
          note: deductionTag,
        },
      })

      // FinalSettlement line — the exact findFirst→update/create pattern of
      // settlements.calculate, MERGED so an existing computation keeps every
      // field and only the deduction lines grow. FRESH read, INSIDE the
      // transaction, under the resignation lock.
      const existing = await tx.finalSettlement.findFirst({ where: { resignationId: res.id } })
      if (existing && ["APPROVED", "PAID"].includes(existing.status)) {
        throw new Deny("The settlement is already " + existing.status.toLowerCase() + " — recover this amount outside the final settlement", 400)
      }
      const comp = j(existing?.computationJson, {} as Record<string, unknown>)
      const assetDeductions = (Array.isArray(comp.assetDeductions) ? comp.assetDeductions : []) as {
        assignmentId: string; assetCode: string; assetName: string; recoveryAmount: number; note: string | null
      }[]
      const newLine = { assignmentId: assignment.id, assetCode: asset.code, assetName: asset.name, recoveryAmount: v.recoveryAmount, note }
      const otherDeductions = Math.round(((Number(comp.otherDeductions) || 0) + v.recoveryAmount) * 100) / 100
      // EXIT-001/EXIT-003/EXIT-007 — gross includes gratuity, employer-owed
      // notice pay and the PF settlement when the settlement was calculated.
      // The rebuilt computation spreads the PRIOR computation first so every
      // recorded basis field (finalSalaryBasis, noticeBasis, pfEnrollmentId,
      // loanIds, advanceIds, …) survives the merge.
      const gross = (Number(comp.finalSalary) || 0) + (Number(comp.otAmount) || 0) + (Number(comp.leaveEncashment) || 0) + (Number(comp.bonusDue) || 0)
        + (Number(comp.gratuity) || 0) + (Number(comp.noticePay) || 0) + (Number(comp.pfSettlement) || 0)
      const totalDeductions = (Number(comp.loanDue) || 0) + (Number(comp.advanceDue) || 0) + (Number(comp.noticeBuyout) || 0) + otherDeductions
      const computation = {
        ...comp,
        otherDeductions,
        assetDeductions: [...assetDeductions, newLine],
        gross,
        totalDeductions,
        netPayable: gross - totalDeductions,
      }
      const settled = Math.round(computation.netPayable * 100) / 100
      if (existing) {
        await tx.finalSettlement.update({
          where: { id: existing.id },
          data: { computationJson: JSON.stringify(computation), netPayable: settled, status: "CALCULATED" },
        })
      } else {
        await tx.finalSettlement.create({
          data: { vendorId: ctx.vendorId, resignationId: res.id, computationJson: JSON.stringify(computation), netPayable: settled, status: "CALCULATED" },
        })
      }
      return settled
    })

    await audit(ctx, "exit.assets.clearWithDeduction", "AssetAssignment", assignment.id,
      `Cleared ${asset.code} (${asset.name}) from ${emp?.fullName || "employee"} with a ৳${v.recoveryAmount} deduction${note ? ` — ${note}` : ""}`,
      { newValue: { assetCode: asset.code, recoveryAmount: v.recoveryAmount, resignationId: res.id } })
    return { ok: true, assetCode: asset.code, recoveryAmount: v.recoveryAmount, netPayable }
  },
})

// ---------- Final settlement (spec §14.4) ----------
route("settlements.calculate", {
  perm: ["exit", "calculate"],
  // EXIT-011 (R3-4) — input schema: `otherDeductions` used to reach the
  // handler unvalidated, and a NEGATIVE value inflated netPayable (more
  // “deductions” = more pay). The schema pins it to a non-negative amount;
  // the asset-recovery re-merge below still adds its own persisted rows.
  schema: S.settlementCalculate,
  handler: async (ctx, p) => {
    const res = await db.resignation.findFirst({ where: { id: p.resignationId, vendorId: ctx.vendorId } })
    if (!res) throw new Deny("Resignation not found", 404)
    // EXIT-002 (R3-1) - post-LWD deadlock: the daily closure sweep flips the
    // resignation to COMPLETED on the last working day, but the final
    // month's attendance/OT only becomes complete AT/AFTER the LWD. A
    // COMPLETED resignation whose settlement has not been PAID stays
    // calculable (and re-calculable) - the normal HR sequence "let the
    // employee finish, then settle" now executes inside the system.
    if (!["NOTICE_PERIOD", "ACCEPTED", "COMPLETED"].includes(res.status)) {
      throw new Deny("Resignation must be accepted (notice period) first")
    }
    if (res.status === "COMPLETED") {
      const paid = await db.finalSettlement.findFirst({ where: { resignationId: res.id, status: "PAID" } })
      if (paid) throw new Deny("This exit is already settled and paid - the computation is closed")
    }
    const emp = await db.employee.findUnique({ where: { id: res.employeeId } })
    const settings = await getSettings(ctx.vendorId)
    const lwd = res.actualLwd || res.proposedLwd
    const exitType = resolveExitType(res, emp?.status)

    const structure = await db.salaryStructure.findFirst({ where: { employeeId: res.employeeId, status: "ACTIVE" } })
    if (!structure) throw new Deny("No active salary structure for settlement")
    // Notice/encashment daily wage basis (gross ÷ 26, HIGH-5 unified helper)
    const daily = dailyRate(structure.gross)

    // ---- shared final-month context (attendance, shift, calendar) ----
    const monthPrefix = lwd.slice(0, 7)
    const monthNum = Number(lwd.slice(5, 7))
    const yearNum = Number(lwd.slice(0, 4))
    const att = await db.attendance.findMany({ where: { vendorId: ctx.vendorId, employeeId: res.employeeId, date: { startsWith: monthPrefix } } })
    const shift = await db.shift.findFirst({ where: { id: emp?.shiftId || "" } })
    // 2026-10-13 — canonical weekly-off precedence (employee > shift > global policy)
    const subWeeklyOff = resolveWeeklyOffDays(emp?.weeklyOff, shift?.weeklyOff, settings.general.weeklyHoliday)
    const holidaysThisMonth = new Set((await db.holiday.findMany({ where: { vendorId: ctx.vendorId, date: { startsWith: monthPrefix } } })).map((h) => h.date))

    // ---- EXIT-005 (R3-2) — final salary on the payroll convention ----
    // Payable working days 1→LWD per the shift's weekly-off/holiday calendar,
    // minus absences (missing records count only when neither weekly-off nor
    // holiday), on the SAME gross/month-working-days basis calculateRun uses —
    // then NETTED against any payroll gross already PAID for the LWD month so
    // the same month is never paid twice (weekly runs of the month net too).
    const paidRunsLwdMonth = await db.payrollRun.findMany({
      where: { vendorId: ctx.vendorId, periodMonth: monthNum, periodYear: yearNum, status: "PAID" },
      select: { id: true },
    })
    const paidEntriesLwdMonth = paidRunsLwdMonth.length
      ? await db.payrollEntry.findMany({ where: { runId: { in: paidRunsLwdMonth.map((r) => r.id) }, employeeId: res.employeeId }, select: { gross: true } })
      : []
    const alreadyPaidGross = paidEntriesLwdMonth.reduce((s, e) => s + (e.gross || 0), 0)
    const fs = computeFinalSalary({
      gross: structure.gross, lwd, weeklyOff: subWeeklyOff, holidays: [...holidaysThisMonth],
      attendance: att.map((a) => ({ date: a.date, status: a.status })),
      joiningDate: emp?.joiningDate, monthlyGrossAlreadyPaid: alreadyPaidGross,
    })
    const finalSalary = fs.finalSalary

    // ---- EXIT-013 (R3-2) — settlement OT on the payroll convention ----
    // Same settings.otRates rates (shift multipliers win), same monthly OT
    // cap, same rounding step as calculateRun — the final month can no longer
    // pay OT the regular engine would have rejected or capped.
    const ot = computeSettlementOt({
      basic: structure.basic,
      attendance: att.map((a) => ({ date: a.date, overtimeMinutes: a.overtimeMinutes, otApproved: a.otApproved })),
      weeklyOff: subWeeklyOff, holidays: [...holidaysThisMonth], shift,
      otRates: settings.otRates, otApprovalRequired: settings.shift.otApprovalRequired,
      maxOtHoursPerMonth: settings.shift.maxOtHoursPerMonth,
    })
    const otAmount = ot.otAmount
    const otMinutes = ot.otMinutes

    // leave encashment (LVE-104 — the same fiscal leave-year keying every
    // other balance consumer uses, so the settlement encashes the ledger the
    // employee actually accrued in)
    const exitMonths = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"]
    const exitFy = Math.max(0, exitMonths.indexOf(settings.general.fiscalYearStart || "July"))
    const year = leaveYearOf(lwd, exitFy)
    const balances = await db.leaveBalance.findMany({ where: { employeeId: res.employeeId, year } })
    const types = await db.leaveType.findMany({ where: { vendorId: ctx.vendorId } })
    // HRM-012 — per-type encashment: rate (multiple of daily pay, default 1) applied
    // to the unused balance, capped at the type's encashmentCap (0 = uncapped).
    // EXIT-012 (R3-2) — "unused" now subtracts PENDING reservations (in-flight
    // leave/encashment requests), matching the leave module's own availability
    // formula (entitled − used − pending) so the same days cannot be both
    // encashed in the settlement and consumed/approved as leave afterwards.
    let encashableDays = 0
    let leaveEncashment = 0
    const encashmentDetail: { type: string; days: number; rate: number; amount: number; capped: boolean }[] = []
    for (const b of balances) {
      const t = types.find((x) => x.id === b.leaveTypeId)
      if (t?.paid && t?.encashmentAllowed && settings.leave.encashmentOnExit) {
        // LVE-002 (R3-4) — canonical spendable formula (carried-forward days
        // count; the ESS path, the apply gate and this settlement now agree);
        // LVE-105 — honoring the type's carry-expiry window
        const spendable = spendableDays(b, {
          asOf: lwd,
          fyStartMonth: exitFy,
          carryForwardExpiryMonths: t.carryForwardExpiryMonths,
        })
        // LVE-006 (R3-4) — encashmentCap is DAYS on this path too (through
        // the shared leave-math helper): the old `amount > cap → amount = cap`
        // read the same column as TAKA and truncated a days-configured cap
        // to ৳cap (cap 15 → ৳15 payout).
        const days = encashableDaysFor(spendable, t.encashmentCap)
        const capped = !!(t.encashmentCap && t.encashmentCap > 0 && spendable > t.encashmentCap)
        encashableDays += days
        const rate = t.encashmentRate && t.encashmentRate > 0 ? t.encashmentRate : 1
        const amount = Math.round(days * daily * rate)
        leaveEncashment += amount
        encashmentDetail.push({ type: t.name, days, rate, amount, capped })
      }
    }

    // dues — ALL active loans and recovering advances (policy allows 2 active loans).
    // EXIT-006 (R3-2) — the included row ids are persisted so settlements.pay
    // closes EXACTLY the ledgers the computation recovered (a loan taken
    // after calculation is never silently written off).
    const loans = await db.loan.findMany({ where: { vendorId: ctx.vendorId, employeeId: res.employeeId, status: "ACTIVE" } })
    const loanDue = loans.reduce((s, l) => s + l.outstanding, 0)
    const advances = await db.advance.findMany({ where: { vendorId: ctx.vendorId, employeeId: res.employeeId, status: "RECOVERING", outstanding: { gt: 0 } } })
    const advanceDue = advances.reduce((s, a) => s + a.outstanding, 0)

    // approved-but-unpaid bonuses for the exit settlement.
    // PAY-010 (R3-2) — ids persisted for the pay step to mark them PAID.
    const pendingBonuses = await db.bonus.findMany({ where: { vendorId: ctx.vendorId, employeeId: res.employeeId, status: "APPROVED" } })
    const bonusDue = pendingBonuses.reduce((s, b) => s + b.amount, 0)

    // notice: WHO owes whom (EXIT-003 direction matrix, pure helper above).
    // EXIT-008 — requiredNotice is the DECIDED value persisted at acceptance
    // (BD statutory matrix); the matrix only recomputes as a fallback for
    // legacy records accepted before the decision was stored.
    // EXIT-010 — the fallback served-days count uses
    // max(resignation date, submission date) as the notice start.
    const requiredNotice = Math.max(1, Math.round(res.noticeDays || resolveRequiredNoticeDays({
      employmentType: emp?.employmentType,
      serviceYears: Math.floor(Math.max(0, completedMonthsBetween(emp?.joiningDate || "", lwd)) / 12),
      defaultNoticeDays: Number(settings.employeeSettings?.defaultNoticePeriodDays) || 30,
      workerMatrix: !!settings.employeeSettings?.workerNoticeMatrix,
    })))
    const noticeStart = effectiveNoticeStart(res.resignationDate, res.submissionDate)
    const served = res.servedDays ?? Math.max(0, daysBetween(noticeStart, res.proposedLwd))
    const { shortNoticeDays, noticeBuyout, noticePay } = resolveNoticeComponent({
      exitType, noticeMode: res.noticeMode, requiredNoticeDays: requiredNotice, servedDays: served, dailyWage: daily,
    })

    // EXIT-001 (R3-1) - statutory gratuity (BD Labour Act §96): 30 days'
    // wages per completed year after the eligibility threshold (5 years;
    // 4y6m+ continuous service rounds up per the 2018 amendment). Same rule
    // as the advisory Gratuity Provision report (shared engine - gratuity.ts).
    const g = computeGratuity(settings.gratuity, { basic: structure.basic, gross: structure.gross }, emp?.joiningDate, lwd)
    const gratuity = g.amount

    // ---- EXIT-007 (R3-2) — Provident Fund settled through the exit flow ----
    // The accumulated PF balance (employee share, plus the employer share per
    // tenant policy) becomes a pfSettlement payable component; the enrollment
    // is closed and the withdrawal ledger row is written when the settlement
    // is PAID. Withdrawals already sit as negative ledger rows, so the sum is
    // the live balance — an enrollment marked CLOSED with a zero balance
    // contributes nothing.
    let pfSettlement = 0
    let pfEmployeeShare = 0
    let pfEmployerShare = 0
    let pfEnrollmentId: string | null = null
    if (settings.pf?.settleAtExit !== false) {
      const pfEnrollment = await db.pfEnrollment.findFirst({ where: { vendorId: ctx.vendorId, employeeId: res.employeeId } })
      if (pfEnrollment && pfEnrollment.status !== "CLOSED") {
        const contribs = await db.pfContribution.findMany({ where: { vendorId: ctx.vendorId, employeeId: res.employeeId } })
        pfEmployeeShare = Math.round(contribs.reduce((s, c) => s + c.employeeAmount, 0))
        pfEmployerShare = Math.round(contribs.reduce((s, c) => s + c.employerAmount, 0))
        const includeEmployer = settings.pf?.includeEmployerAtExit !== false
        const balance = pfEmployeeShare + (includeEmployer ? pfEmployerShare : 0)
        if (balance > 0) {
          pfSettlement = balance
          pfEnrollmentId = pfEnrollment.id
        }
      }
    }

    // WP-L — re-merge any PERSISTED asset-recovery deductions (recorded via
    // exit.assets.clearWithDeduction) so a recalculation never silently wipes
    // them: they fold into otherDeductions (which the pay journal posts to
    // 5290 "Salary Deductions Recovered") and stay itemized for the UI.
    const priorSettlement = await db.finalSettlement.findFirst({ where: { resignationId: res.id } })
    const priorAssetDeductions = (j(priorSettlement?.computationJson, {} as Record<string, unknown>).assetDeductions || []) as {
      assignmentId: string; assetCode: string; assetName: string; recoveryAmount: number; note: string | null
    }[]
    const assetRecovery = priorAssetDeductions.reduce((s, d) => s + (Number(d.recoveryAmount) || 0), 0)
    const otherDeductions = Math.round(((Number(p.otherDeductions) || 0) + assetRecovery) * 100) / 100

    // ---- PAY-010b (R3-4) — AIT withheld on the salary-like components ----
    // The same money paid inside a payroll run is taxed at the §86 average
    // rate; until now the settlement disbursed it with ZERO withholding, so
    // the payslip/module tax views and the settlement disagreed. Taxable
    // here: final salary, OT, leave encashment, bonus, notice pay. Gratuity
    // (BLA §96 statutory exemption) and the PF refund (return of the
    // employee's own money) are never withheld. The estimate follows the
    // payroll engine's shape: ytd ACTUALS from PAID runs of the income year
    // before the LWD month + this payment + previous-employer income, with
    // the §86(4) TDS already withheld credited back.
    let settlementAit = 0
    let aitDetail: { salaryLike: number; ruleSetName: string; averageRatePercent: number; ytdEarnings: number; ytdAitWithheld: number } | null = null
    if ((settings as any).ait?.settlementWithholding !== false) {
      const salaryLike = Math.round(finalSalary + otAmount + leaveEncashment + bonusDue + noticePay)
      if (salaryLike > 0) {
        try {
          const { loadAitConfig, computeAit } = await import("../ait")
          const aitConfig = await loadAitConfig(ctx.vendorId).catch(() => null)
          if (aitConfig) {
            const fyStartYear = Number(String(aitConfig.incomeYear).slice(0, 4))
            const fyEndYear = fyStartYear + 1
            const fyStartPrefix = `${fyStartYear}-07`
            const fyEndPrefix = `${fyEndYear}-06`
            const paidRuns = await db.payrollRun.findMany({
              where: { vendorId: ctx.vendorId, status: "PAID" },
              select: { id: true, periodMonth: true, periodYear: true },
            })
            const inFy = paidRuns.filter((r) => {
              const pm = `${r.periodYear}-${String(r.periodMonth).padStart(2, "0")}`
              return pm >= fyStartPrefix && pm <= fyEndPrefix && pm < monthPrefix
            })
            const paidEntries = inFy.length
              ? await db.payrollEntry.findMany({
                  where: { runId: { in: inFy.map((r) => r.id) }, employeeId: res.employeeId },
                  select: { gross: true, otAmount: true, bonus: true, commission: true, ait: true },
                })
              : []
            const ytdEarnings = Math.round(paidEntries.reduce((s, x) => s + (x.gross || 0) + (x.otAmount || 0) + (x.bonus || 0) + (x.commission || 0), 0))
            const ytdAitWithheld = Math.round(paidEntries.reduce((s, x) => s + (x.ait || 0), 0))
            const monthsFromLwdToFyEnd = Math.max(1,
              (fyEndYear - Number(monthPrefix.slice(0, 4))) * 12 + (6 - Number(monthPrefix.slice(5, 7))) + 1)
            const ait = await computeAit({
              vendorId: ctx.vendorId, monthlyTaxableIncome: salaryLike,
              previousEmployerIncome: emp?.previousEmployerIncome || 0,
              previousTaxDeducted: emp?.taxAlreadyDeducted || 0,
              config: aitConfig,
              employeeProfile: {
                taxpayerCategory: emp?.taxCategory || null,
                dateOfBirth: emp?.dob || null,
                declaredInvestment: emp?.declaredInvestment ?? null,
                monthlyBasicSalary: structure.basic,
                netWealth: (emp as any)?.taxNetWealth ?? null,
                motorVehicles: (emp as any)?.taxMotorVehicles ?? null,
                gender: emp?.gender || null,
              },
              annualEstimate: Math.round(ytdEarnings + salaryLike + Math.max(0, emp?.previousEmployerIncome || 0)),
              tdsWithheldYtd: ytdAitWithheld + Math.max(0, emp?.taxAlreadyDeducted || 0),
              // EXT-01 — the settlement is usually the employee's FINAL
              // payment of the income year: nobody will be withholding the
              // other (monthsRemaining−1) slices after they leave. The full
              // remaining §86 liability (annualTax − TDS already withheld)
              // withholds NOW, capped at the salary-like payment — the old
              // netMonthlyAit read carried only the 1/monthsRemaining
              // catch-up slice and systematically under-withheld on exits.
              monthsRemainingInFy: monthsFromLwdToFyEnd,
            })
            settlementAit = Math.max(0, Math.min(Math.round(ait.remainingEstimate), salaryLike))
            aitDetail = { salaryLike, ruleSetName: ait.ruleSetName, averageRatePercent: ait.averageRatePercent, ytdEarnings, ytdAitWithheld }
          }
        } catch (e) {
          // withholding is best-effort: an AIT-config problem must not block
          // the settlement computation — the absence is visible in the JSON
          console.error("[settlements.calculate] settlement AIT withholding skipped", e)
        }
      }
    }

    const computation = {
      finalSalary, otAmount, otMinutes,
      // EXIT-005 — the calculation basis is stored for audit and the UI
      finalSalaryBasis: {
        daysUptoLwd: fs.daysUptoLwd, monthWorkingDays: fs.monthWorkingDays, absentDays: fs.absentDays,
        dailyRate: fs.dailyRate, grossProrated: fs.grossProrated, absenceDeduction: fs.absenceDeduction,
        alreadyPaidGross: fs.alreadyPaid, ...(fs.netted ? { nettedAgainstPayroll: true } : {}),
      },
      leaveEncashment, encashableDays, encashmentDetail,
      bonusDue, bonusIds: pendingBonuses.map((b) => b.id),
      gratuity, gratuityYears: g.years, gratuityEligible: g.eligible, ...(g.capped ? { gratuityCapped: true } : {}),
      noticePay, // EXIT-003 - employer-owed notice pay (terminations / waived notice)
      noticeBasis: { requiredNoticeDays: requiredNotice, servedDays: served, noticeStart }, // EXIT-008/010
      pfSettlement, pfEmployeeShare, pfEmployerShare, ...(pfEnrollmentId ? { pfEnrollmentId } : {}), // EXIT-007
      loanDue, advanceDue, loanIds: loans.map((l) => l.id), advanceIds: advances.map((a) => a.id), // EXIT-006
      noticeBuyout, shortNoticeDays,
      otherDeductions,
      // PAY-010b (R3-4) — settlement AIT withholding on the salary-like
      // components (see the computation block above for the basis)
      settlementAit, ...(aitDetail ? { aitDetail } : {}),
      ...(priorAssetDeductions.length ? { assetDeductions: priorAssetDeductions } : {}),
      gross: finalSalary + otAmount + leaveEncashment + bonusDue + gratuity + noticePay + pfSettlement,
      totalDeductions: loanDue + advanceDue + noticeBuyout + otherDeductions + settlementAit,
      netPayable: finalSalary + otAmount + leaveEncashment + bonusDue + gratuity + noticePay + pfSettlement - loanDue - advanceDue - noticeBuyout - otherDeductions - settlementAit,
    }

    // ---- MON-6 (Phase 4) — the settlement write is serialized per
    // resignation by the same FOR UPDATE row lock clearWithDeduction takes
    // (a recalculation racing an asset-clear merge can no longer interleave),
    // and an APPROVED settlement is NEVER silently wiped back to CALCULATED —
    // the recalculation is rejected with instructions instead (the old
    // behavior discarded a completed approval gate without telling anyone).
    const existing = await db.finalSettlement.findFirst({ where: { resignationId: res.id } })
    let settlementId: string
    if (existing) {
      settlementId = await db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM "Resignation" WHERE id = ${res.id} FOR UPDATE`
        const fresh = await tx.finalSettlement.findFirst({ where: { resignationId: res.id } })
        if (fresh && ["APPROVED", "PAID"].includes(fresh.status)) {
          throw new Deny(`The settlement is already ${fresh.status.toLowerCase()} — recalculating would discard the approval${fresh.status === "PAID" ? " of a paid settlement" : ""}. Pay it (or let it be) and recover any new dues through an adjustment instead.`, 400)
        }
        if (!fresh) {
          const created = await tx.finalSettlement.create({
            data: { vendorId: ctx.vendorId, resignationId: res.id, computationJson: JSON.stringify(computation), netPayable: computation.netPayable, status: "CALCULATED" },
          })
          return created.id
        }
        await tx.finalSettlement.update({ where: { id: fresh.id }, data: { computationJson: JSON.stringify(computation), netPayable: computation.netPayable, status: "CALCULATED" } })
        return fresh.id
      })
      return { id: settlementId, computation }
    }
    settlementId = await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Resignation" WHERE id = ${res.id} FOR UPDATE`
      const fresh = await tx.finalSettlement.findFirst({ where: { resignationId: res.id } })
      if (fresh) {
        // created concurrently while we computed — treat as the update path
        if (["APPROVED", "PAID"].includes(fresh.status)) {
          throw new Deny(`The settlement is already ${fresh.status.toLowerCase()} — recalculating would discard the approval.`, 400)
        }
        await tx.finalSettlement.update({ where: { id: fresh.id }, data: { computationJson: JSON.stringify(computation), netPayable: computation.netPayable, status: "CALCULATED" } })
        return fresh.id
      }
      const rec = await tx.finalSettlement.create({
        data: { vendorId: ctx.vendorId, resignationId: res.id, computationJson: JSON.stringify(computation), netPayable: computation.netPayable, status: "CALCULATED" },
      })
      return rec.id
    })
    await audit(ctx, "settlements.calculate", "FinalSettlement", settlementId,
      `Settlement computed for ${emp?.fullName}: net ৳${computation.netPayable}`)
    return { id: settlementId, computation }
  },
})

/** EXIT-009 (R3-2) — itemized exit-clearance gate, shared by approve + pay.
 *  The settlement's money must not move before the clearance checklist is
 *  CLEARED: paying first removes the settlement's own recovery leverage
 *  (deductions are far harder to collect after payment). Exits whose data
 *  predates the checklist (no ExitClearance row) are not blocked. */
async function assertClearanceCleared(vendorId: string, resignationId: string, comp?: Record<string, unknown>): Promise<void> {
  const clearance = await db.exitClearance.findFirst({ where: { vendorId, resignationId } })
  if (!clearance || clearance.status === "CLEARED") return
  const checklist = j(clearance.checklistJson, [] as { department: string; items: { item: string; cleared: boolean }[] }[])
  const pending: string[] = []
  for (const d of checklist) for (const it of d.items || []) if (!it.cleared) pending.push(`${d.department}: ${it.item}`)
  const shown = pending.slice(0, 6)
  const duesHint = (Number(comp?.loanDue) || 0) > 0 || (Number(comp?.advanceDue) || 0) > 0
    ? " Dues that this settlement itself recovers (loan/advance) count as settled — tick them on the Clearance tab."
    : ""
  throw new Deny(
    `Exit clearance is ${clearance.status === "IN_PROGRESS" ? "in progress" : "not started"} — complete the clearance checklist before approving or paying the settlement. ` +
    `${pending.length} item(s) outstanding${shown.length ? `: ${shown.join("; ")}${pending.length > shown.length ? ` (+${pending.length - shown.length} more)` : ""}` : ""}.${duesHint}`,
    400,
  )
}

route("settlements.approve", {
  perm: ["exit", "approve"],
  handler: async (ctx, p) => {
    const rec = await db.finalSettlement.findFirst({ where: { id: p.id, vendorId: ctx.vendorId } })
    if (!rec || rec.status !== "CALCULATED") throw new Deny("Calculated settlement not found", 404)
    // EXIT-009 — the clearance checklist must be CLEARED before approval
    await assertClearanceCleared(ctx.vendorId, rec.resignationId, j(rec.computationJson, {} as Record<string, unknown>))
    await db.finalSettlement.update({ where: { id: rec.id }, data: { status: "APPROVED", approvedBy: ctx.userId } })
    await audit(ctx, "settlements.approve", "FinalSettlement", rec.id, `Approved settlement ৳${rec.netPayable}`)
    return { approved: true }
  },
})

route("settlements.pay", {
  perm: ["exit", "pay"],
  handler: async (ctx, p) => {
    const rec = await db.finalSettlement.findFirst({ where: { id: p.id, vendorId: ctx.vendorId, status: "APPROVED" } })
    if (!rec) throw new Deny("Approved settlement not found", 404)
    const res = await db.resignation.findUnique({ where: { id: rec.resignationId } })
    if (!res) throw new Deny("Resignation not found", 404)
    const emp = await db.employee.findUnique({ where: { id: res.employeeId } })
    const comp = j(rec.computationJson, {} as any)
    // EXIT-009 — re-verify clearance at pay time: the checklist can be edited
    // (un-ticked) after approval, and payment is the irreversible step.
    await assertClearanceCleared(ctx.vendorId, res.id, comp)
    // EXIT-005 — defensive netting re-check: if payroll for the LWD month was
    // PAID after this settlement was calculated, the recorded final salary no
    // longer matches reality — force a recalculation instead of double-paying.
    {
      const lwd = res.actualLwd || res.proposedLwd
      const paidRuns = await db.payrollRun.findMany({
        where: { vendorId: ctx.vendorId, periodMonth: Number(lwd.slice(5, 7)), periodYear: Number(lwd.slice(0, 4)), status: "PAID" },
        select: { id: true, paymentDate: true },
      })
      if (paidRuns.length) {
        const entries = await db.payrollEntry.findMany({ where: { runId: { in: paidRuns.map((r) => r.id) }, employeeId: res.employeeId }, select: { gross: true } })
        const nowPaid = entries.reduce((s, e) => s + (e.gross || 0), 0)
        const thenPaid = Number(comp.finalSalaryBasis?.alreadyPaidGross) || 0
        if (nowPaid > thenPaid + 0.01) {
          throw new Deny(`Payroll for the last working month was paid after this settlement was calculated (৳${Math.round(nowPaid - thenPaid)} additional gross) — recalculate the settlement before paying.`, 400)
        }
      }
    }
    // H-6 — exactly-once payment, mirroring payRun's discipline. The old
    // sequence had a double-payment window: findFirst(APPROVED) → unconditional
    // journal (no idempotency key) → unconditional PAID update, all outside a
    // transaction, so two concurrent calls both passed the read and both paid.
    // Now: one $transaction, a conditional claim (APPROVED → PAID, count must
    // be exactly 1), the journal keyed SETTLEMENT:${id} as a replay backstop,
    // and every state write (resignation/employee/history) inside the same
    // transaction — a mid-sequence failure rolls back cleanly.
    const journalId = await db.$transaction(async (tx) => {
      const claimed = await tx.finalSettlement.updateMany({
        where: { id: rec.id, vendorId: ctx.vendorId, status: "APPROVED" },
        data: { status: "PAID", paidAt: new Date() },
      })
      if (claimed.count !== 1) {
        throw new Deny("This settlement was already paid or is no longer approved — refresh and try again")
      }

      // ---- MON-5 (Phase 4) — pay-time LEDGER re-validation. EXIT-005
      // re-checked only the final-salary gross leg; the loan / advance /
      // bonus ledgers could drift between calculation and payment:
      //   · a loan taken after calculation       → under-recovery (never repaid)
      //   · a payroll run recovering an EMI      → the settlement credits the
      //     recorded dues — the employee pays the same installment twice
      //   · a bonus approved after calculation   → missed (never paid)
      //   · a bonus paid by payroll in between   → double-paid via bonusDue
      // Inside the payment transaction, after the exactly-once claim, every
      // ledger must still match the computation snapshot — drift blocks
      // payment with the specific reason and forces a recalculation.
      {
        const TOL = 0.01
        // ---- loans: the union of recorded + live ACTIVE loans must total
        // the recorded dues (both directions) ----
        const liveLoans = await tx.loan.findMany({
          where: { vendorId: ctx.vendorId, employeeId: res.employeeId, status: "ACTIVE" },
          select: { id: true, outstanding: true },
        })
        const recordedLoanIds = (Array.isArray(comp.loanIds) ? comp.loanIds : []) as string[]
        const unionLoanIds = [...new Set([...recordedLoanIds, ...liveLoans.map((l) => l.id)])]
        const unionLoans = unionLoanIds.length
          ? await tx.loan.findMany({ where: { id: { in: unionLoanIds }, vendorId: ctx.vendorId }, select: { id: true, outstanding: true } })
          : []
        const liveLoanDue = unionLoans.reduce((s, l) => s + Math.max(0, l.outstanding || 0), 0)
        const recordedLoanDue = Number(comp.loanDue) || 0
        if (Math.abs(liveLoanDue - recordedLoanDue) > TOL) {
          const diff = liveLoanDue - recordedLoanDue
          const why = diff > 0
            ? `৳${Math.round(diff)} of loan principal was taken (or re-opened) AFTER the settlement was calculated — paying now would never recover it`
            : `৳${Math.round(-diff)} of loan dues was recovered elsewhere (e.g. by a payroll run) between calculation and payment — paying now would charge the employee twice`
          throw new Deny(`Loan dues changed since the settlement was calculated (calculated ৳${Math.round(recordedLoanDue)}, currently ৳${Math.round(liveLoanDue)}). ${why}. Recalculate the settlement before paying.`, 400)
        }
        // ---- advances: the union of recorded + live RECOVERING advances ----
        const liveAdvances = await tx.advance.findMany({
          where: { vendorId: ctx.vendorId, employeeId: res.employeeId, status: "RECOVERING", outstanding: { gt: 0 } },
          select: { id: true, outstanding: true },
        })
        const recordedAdvanceIds = (Array.isArray(comp.advanceIds) ? comp.advanceIds : []) as string[]
        const unionAdvIds = [...new Set([...recordedAdvanceIds, ...liveAdvances.map((a) => a.id)])]
        const unionAdvances = unionAdvIds.length
          ? await tx.advance.findMany({ where: { id: { in: unionAdvIds }, vendorId: ctx.vendorId }, select: { id: true, outstanding: true } })
          : []
        const liveAdvanceDue = unionAdvances.reduce((s, a) => s + Math.max(0, a.outstanding || 0), 0)
        const recordedAdvanceDue = Number(comp.advanceDue) || 0
        if (Math.abs(liveAdvanceDue - recordedAdvanceDue) > TOL) {
          const diff = liveAdvanceDue - recordedAdvanceDue
          const why = diff > 0
            ? `৳${Math.round(diff)} of advance principal was issued AFTER the settlement was calculated — paying now would never recover it`
            : `৳${Math.round(-diff)} of advance dues was recovered elsewhere between calculation and payment — paying now would charge the employee twice`
          throw new Deny(`Advance dues changed since the settlement was calculated (calculated ৳${Math.round(recordedAdvanceDue)}, currently ৳${Math.round(liveAdvanceDue)}). ${why}. Recalculate the settlement before paying.`, 400)
        }
        // ---- bonuses: the APPROVED-unpaid set must still match the snapshot ----
        const liveBonuses = await tx.bonus.findMany({
          where: { vendorId: ctx.vendorId, employeeId: res.employeeId, status: "APPROVED" },
          select: { id: true, amount: true },
        })
        const recordedBonusIds = (Array.isArray(comp.bonusIds) ? comp.bonusIds : null) as string[] | null
        if (recordedBonusIds) {
          // an EXPLICIT recorded set (even empty) pins the snapshot: every
          // recorded id must still be APPROVED, and nothing new may appear
          const liveIds = new Set(liveBonuses.map((b) => b.id))
          const paidElsewhere = recordedBonusIds.filter((id) => !liveIds.has(id))
          const approvedAfter = [...liveIds].filter((id) => !recordedBonusIds.includes(id))
          if (paidElsewhere.length || approvedAfter.length) {
            const parts: string[] = []
            if (paidElsewhere.length) parts.push(`${paidElsewhere.length} bonus/bonuses from the calculation were paid or removed elsewhere — paying now would double-pay them`)
            if (approvedAfter.length) parts.push(`${approvedAfter.length} bonus/bonuses were approved AFTER the settlement was calculated — they are not in the computation and would never be paid`)
            throw new Deny(`The bonus ledger changed since the settlement was calculated. ${parts.join("; ")}. Recalculate the settlement before paying.`, 400)
          }
          const liveSum = liveBonuses.filter((b) => recordedBonusIds.includes(b.id)).reduce((s, b) => s + b.amount, 0)
          if (Math.abs(liveSum - (Number(comp.bonusDue) || 0)) > TOL) {
            throw new Deny(`A bonus amount in the settlement was edited after the calculation (calculated ৳${Math.round(Number(comp.bonusDue) || 0)}, currently ৳${Math.round(liveSum)}). Recalculate the settlement before paying.`, 400)
          }
        } else if (liveBonuses.length && (Number(comp.bonusDue) || 0) <= 0) {
          // legacy computation without ids: any live APPROVED bonus means
          // money the computation never counted
          throw new Deny(`${liveBonuses.length} bonus/bonuses are APPROVED but were not part of this settlement's calculation (calculated before they were approved). Recalculate the settlement before paying.`, 400)
        }
      }

      // ---- EXIT-006 (R3-2) — close the loan/advance ledgers the settlement
      // recovers. The accounting credit has always been posted; now the
      // operational rows follow: loans → CLOSED with outstanding 0 (and their
      // open installments settled), advances → RECOVERED. Exactly the rows the
      // calculation included (loanIds/advanceIds) — legacy computations without
      // ids fall back to the live ACTIVE/RECOVERING set, capped at the
      // recorded dues so a loan taken after calculation is never written off.
      const closedLoans: { id: string; recovered: number }[] = []
      const loanIds = (Array.isArray(comp.loanIds) ? comp.loanIds : null) as string[] | null
      const loansToClose = loanIds && loanIds.length
        ? await tx.loan.findMany({ where: { id: { in: loanIds }, vendorId: ctx.vendorId } })
        : await (async () => {
            // legacy computation (no ids recorded): the live ACTIVE set, capped
            // at the recorded dues — largest outstanding first, so a loan taken
            // after calculation is never silently written off
            const active = await tx.loan.findMany({ where: { vendorId: ctx.vendorId, employeeId: res.employeeId, status: "ACTIVE" } })
            let budget = Math.max(0, Number(comp.loanDue) || 0)
            const picked: typeof active = []
            for (const l of active.sort((a, b) => b.outstanding - a.outstanding)) {
              if (budget <= 0) break
              picked.push(l)
              budget -= l.outstanding
            }
            return picked
          })()
      for (const loan of loansToClose) {
        const outstanding = loan.outstanding > 0 ? loan.outstanding : 0
        await tx.loan.update({
          where: { id: loan.id },
          data: { paidAmount: Math.min(loan.principal, loan.paidAmount + outstanding), outstanding: 0, status: "CLOSED" },
        })
        const openInst = await tx.loanInstallment.findMany({ where: { loanId: loan.id, status: { in: ["PENDING", "OVERDUE", "PARTIAL"] } } })
        for (const i of openInst) {
          await tx.loanInstallment.update({ where: { id: i.id }, data: { paidAmount: i.amount, status: "PAID", paidAt: new Date() } })
        }
        await tx.employeeHistory.create({
          data: { vendorId: ctx.vendorId, employeeId: res.employeeId, eventType: "LOAN_CLOSED",
            title: "Loan settled via final settlement",
            description: `Outstanding ৳${outstanding} recovered from the final settlement — loan closed, installments settled.`,
            amount: outstanding, effectiveDate: today(),
            dataJson: JSON.stringify({ loanId: loan.id, settlementId: rec.id, via: "SETTLEMENT" }) },
        })
        closedLoans.push({ id: loan.id, recovered: outstanding })
      }
      const closedAdvances: { id: string; recovered: number }[] = []
      const advanceIds = (Array.isArray(comp.advanceIds) ? comp.advanceIds : null) as string[] | null
      const advancesToClose = advanceIds && advanceIds.length
        ? await tx.advance.findMany({ where: { id: { in: advanceIds }, vendorId: ctx.vendorId } })
        : await tx.advance.findMany({ where: { vendorId: ctx.vendorId, employeeId: res.employeeId, status: "RECOVERING", outstanding: { gt: 0 } } })
      for (const adv of advancesToClose) {
        const outstanding = adv.outstanding > 0 ? adv.outstanding : 0
        await tx.advance.update({
          where: { id: adv.id },
          data: { deducted: adv.deducted + outstanding, outstanding: 0, status: "RECOVERED" },
        })
        await tx.employeeHistory.create({
          data: { vendorId: ctx.vendorId, employeeId: res.employeeId, eventType: "ADVANCE_RECOVERED",
            title: "Advance recovered via final settlement",
            description: `Outstanding ৳${outstanding} recovered from the final settlement — advance closed.`,
            amount: outstanding, effectiveDate: today(),
            dataJson: JSON.stringify({ advanceId: adv.id, settlementId: rec.id, via: "SETTLEMENT" }) },
        })
        closedAdvances.push({ id: adv.id, recovered: outstanding })
      }

      // ---- PAY-010 (R3-2) — the bonuses the settlement paid are marked PAID ----
      // Without this, an APPROVED bonus consumed by the settlement stayed
      // APPROVED and the next payroll run for a matching period re-paid it.
      const bonusIds = (Array.isArray(comp.bonusIds) ? comp.bonusIds : null) as string[] | null
      if (bonusIds && bonusIds.length) {
        await tx.bonus.updateMany({
          where: { id: { in: bonusIds }, vendorId: ctx.vendorId, status: "APPROVED" },
          data: { status: "PAID", runId: rec.id },
        })
      } else {
        // legacy computation (no ids recorded): the periodless APPROVED set
        // the old calculation summed
        await tx.bonus.updateMany({
          where: { vendorId: ctx.vendorId, employeeId: res.employeeId, status: "APPROVED" },
          data: { status: "PAID", runId: rec.id },
        })
      }

      // ---- EXIT-007 (R3-2) — PF paid out through the settlement ----
      // Close the enrollment and write the withdrawal ledger row (negative
      // movement, source WITHDRAWAL — the PfContribution vocabulary the PF
      // module already renders) with the settlement linkage in the note.
      if ((Number(comp.pfSettlement) || 0) > 0) {
        const pfEnrollment = (comp.pfEnrollmentId
          ? await tx.pfEnrollment.findFirst({ where: { id: String(comp.pfEnrollmentId), vendorId: ctx.vendorId } })
          : await tx.pfEnrollment.findFirst({ where: { vendorId: ctx.vendorId, employeeId: res.employeeId } }))
        if (pfEnrollment && pfEnrollment.status !== "CLOSED") {
          await tx.pfEnrollment.update({ where: { id: pfEnrollment.id }, data: { status: "CLOSED", closedAt: new Date() } })
        }
        const t = today()
        await tx.pfContribution.create({
          data: {
            vendorId: ctx.vendorId, employeeId: res.employeeId,
            periodYear: Number(t.slice(0, 4)), periodMonth: Number(t.slice(5, 7)),
            // withdrawals are stored as negative movements on the ledger
            employeeAmount: -Math.max(0, Math.round(Number(comp.pfEmployeeShare) || 0)),
            employerAmount: -Math.max(0, Math.round((Number(comp.pfSettlement) || 0) - (Number(comp.pfEmployeeShare) || 0))),
            source: "WITHDRAWAL", note: `Exit settlement ${rec.id} — PF balance paid out with the final settlement`,
            noteHash: pfNoteHash(`Exit settlement ${rec.id} — PF balance paid out with the final settlement`, "WITHDRAWAL"),
            createdBy: ctx.userId,
          },
        })
      }

      // CRIT-4 fix (this audit) — the journal was structurally unbalanced by
      // (noticeBuyout + otherDeductions). Fix: explicit credit lines for
      // noticeBuyout (contra-settlement expense) and otherDeductions (salary
      // deductions recovered), so debit = credits.
      // EXIT-007 — the PF portion is a LIABILITY DISCHARGE, not an expense:
      // debit 2150 (PF Payable) for the PF balance instead of 6100, so the
      // settlement does not inflate salary expense with money that was
      // already accrued as a liability.
      // PAY-010b (R3-4) — the withheld AIT is credited to 2105 (AIT Payable)
      // exactly like the payroll engine's own AIT line; netPayable (the
      // 2100 credit) already carries it out of the employee's net.
      const pfAmount = Math.max(0, Math.round(Number(comp.pfSettlement) || 0))
      const settlementAitAmount = Math.max(0, Math.round(Number(comp.settlementAit) || 0))
      const expenseDebit = Math.max(0, Math.round((Number(comp.gross) || rec.netPayable) - pfAmount))
      // EXT-02 — negative settlements (the employee OWES the company at exit)
      // used to post a NEGATIVE credit on 2100; when the settlement had no
      // positive payable side the entry carried no debit at all and
      // validateAndBalanceLines threw, stranding the case APPROVED forever.
      // Normalization: the owed amount becomes a Cash-on-Hand DEBIT (collected
      // at clearance) and the Salaries-Payable credit only rides positive
      // nets — the entry balances by construction for every sign of net.
      const netAmount = Math.round(Number(rec.netPayable) || 0)
      const owedByEmployee = netAmount < 0 ? -netAmount : 0
      const jid = await postJournal(ctx, "SETTLEMENT", rec.id, today(),
        `Final settlement — ${emp?.fullName}${owedByEmployee > 0 ? ` (net due FROM employee ৳${owedByEmployee})` : ""}`,
        [
          ...(expenseDebit > 0 ? [{ account: "6100", accountName: "Final Settlement Expense", debit: expenseDebit } as const] : []),
          ...(pfAmount > 0 ? [{ account: "2150", accountName: "PF Payable", debit: pfAmount } as const] : []),
          ...(owedByEmployee > 0 ? [{ account: "1010", accountName: "Cash on Hand", debit: owedByEmployee } as const] : []),
          { account: "1150", accountName: "Employee Loan Receivable", credit: comp.loanDue || 0 },
          { account: "1155", accountName: "Employee Advances", credit: comp.advanceDue || 0 },
          { account: "5290", accountName: "Notice Buyout Recovery", credit: comp.noticeBuyout || 0 },
          { account: "5290", accountName: "Salary Deductions Recovered", credit: comp.otherDeductions || 0 },
          ...(settlementAitAmount > 0 ? [{ account: "2105", accountName: "AIT Payable", credit: settlementAitAmount } as const] : []),
          ...(netAmount > 0 ? [{ account: "2100", accountName: "Salaries Payable", credit: netAmount } as const] : []),
        ], Math.abs(netAmount), { tx, idempotencyKey: `SETTLEMENT:${rec.id}` })
      await tx.finalSettlement.update({ where: { id: rec.id }, data: { journalId: jid } })
      await tx.resignation.update({ where: { id: res.id }, data: { status: "COMPLETED" } })
      // EXIT-004 - write the Employee.status vocabulary, not the internal exit-type nouns
      const targetStatus = exitStatusForEmployee(resolveExitType(res, emp?.status))
      await tx.employee.update({ where: { id: res.employeeId }, data: { status: targetStatus } })
      await tx.employeeHistory.create({
        data: { vendorId: ctx.vendorId, employeeId: res.employeeId, eventType: "EXIT",
          title: `Final settlement paid (${titleCase(targetStatus)})`, description: `Net ৳${rec.netPayable} · journal ${jid}`,
          amount: rec.netPayable, effectiveDate: today(), dataJson: JSON.stringify({ settlementId: rec.id, exitType: targetStatus }) },
      })
      return jid
    })
    await deactivateMappingsForEmployee(ctx.vendorId, res.employeeId) // device enrollments offboarded (§25)
    const finalStatus = resolveExitType(res, emp?.status)
    // EXT-02 — the owed direction is surfaced honestly in the audit + notice
    const netOut = Math.round(Number(rec.netPayable) || 0)
    const owedOut = netOut < 0 ? -netOut : 0
    await audit(ctx, "settlements.pay", "FinalSettlement", rec.id,
      netOut >= 0
        ? `Paid settlement ৳${netOut}; employee marked ${finalStatus}`
        : `Settled with ৳${owedOut} due FROM the employee (collected at clearance); employee marked ${finalStatus}`
      + `${(Number(comp.loanDue) || 0) > 0 ? `; loan ledger closed` : ``}${(Number(comp.advanceDue) || 0) > 0 ? `; advance ledger closed` : ``}`
      + `${(Number(comp.pfSettlement) || 0) > 0 ? `; PF settled ৳${Math.round(Number(comp.pfSettlement))}` : ``}`)
    await notify(ctx.vendorId, { employeeId: res.employeeId }, "Final Settlement Processed",
      netOut >= 0
        ? `Your final settlement of ৳${netOut} has been processed.`
        : `Your final settlement has been processed — ৳${owedOut} is due from you at clearance.`,
      "EXIT", "ess")
    return { paid: true, journalId }
  },
})

// ---------- EXT-04 (R7) — printable Full & Final statement ----------
// The settlement existed only as in-app cards; there was no printable F&F
// document an employee could take to a bank or keep for records. This route
// renders the computation as a formal statement (letterhead + employee
// block + earning/deduction lines + net payable + signatures), reusing the
// letter CSP/sanitization discipline. HR (exit.view) prints any settlement;
// an employee prints their OWN (APPROVED or PAID only — drafts and
// in-flight recalcs never leak).
// INTENTIONALLY_SELF_SCOPED (M-02 / EXT-04 R7): printable F&F statement —
// exit.view holders print any; everyone else is scoped to their OWN
// APPROVED/PAID settlement.
route("settlements.html", {
  handler: async (ctx, p) => {
    const rec = await db.finalSettlement.findFirst({ where: { id: p.id, vendorId: ctx.vendorId } })
    if (!rec) throw new Deny("Settlement not found", 404)
    const res = await db.resignation.findUnique({ where: { id: rec.resignationId } })
    if (!res) throw new Deny("Resignation not found", 404)
    const privileged = ctx.permissions.has("exit.view")
    if (!privileged) {
      if (res.employeeId !== ctx.employeeId) throw new Deny("Settlement not found", 404)
      if (!["APPROVED", "PAID"].includes(rec.status)) {
        throw new Deny("Your settlement statement is available once it is approved", 403)
      }
    }
    const emp = await db.employee.findUnique({ where: { id: res.employeeId } })
    if (!emp) throw new Deny("Employee not found", 404)
    const comp = j(rec.computationJson, {} as any)
    const vendor = await db.vendor.findUnique({ where: { id: ctx.vendorId } })
    const desig = emp.designationId ? await db.designation.findFirst({ where: { id: emp.designationId } }) : null
    const dept = emp.departmentId ? await db.department.findFirst({ where: { id: emp.departmentId } }) : null

    // money lines: [label, amount, isDeduction]
    const lines: Array<[string, number, boolean]> = [
      ["Final salary (prorated to last working day)", Number(comp.finalSalary) || 0, false],
    ]
    if (comp.otAmount > 0) lines.push(["Overtime", Number(comp.otAmount) || 0, false])
    if (comp.leaveEncashment > 0) lines.push([`Leave encashment (${comp.encashableDays ?? 0} day(s))`, Number(comp.leaveEncashment) || 0, false])
    if (comp.bonusDue > 0) lines.push(["Bonus due", Number(comp.bonusDue) || 0, false])
    if (comp.gratuity > 0) lines.push([`Gratuity (${comp.gratuityYears ?? 0} year(s) of service)`, Number(comp.gratuity) || 0, false])
    if (comp.noticePay > 0) lines.push(["Notice pay", Number(comp.noticePay) || 0, false])
    if (comp.pfSettlement > 0) lines.push(["Provident Fund settlement", Number(comp.pfSettlement) || 0, false])
    if (comp.loanDue > 0) lines.push(["Loan recovery", Number(comp.loanDue) || 0, true])
    if (comp.advanceDue > 0) lines.push(["Advance recovery", Number(comp.advanceDue) || 0, true])
    if (comp.noticeBuyout > 0) lines.push(["Notice buyout (short notice)", Number(comp.noticeBuyout) || 0, true])
    if (Number(comp.assetDeductions) > 0) lines.push(["Asset recovery (unreturned equipment)", Number(comp.assetDeductions) || 0, true])
    if (comp.otherDeductions > 0) lines.push(["Other deductions", Number(comp.otherDeductions) || 0, true])
    if (comp.settlementAit > 0) lines.push(["AIT withheld", Number(comp.settlementAit) || 0, true])

    const e = (s: unknown) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
    const fmt = (n: number) => `৳ ${Math.round(n).toLocaleString("en-IN")}`
    const fmtD = (iso?: string | null) => (iso ? String(iso).slice(0, 10).split("-").reverse().join("-") : "—")
    const gross = lines.filter((l) => !l[2]).reduce((s, l) => s + l[1], 0)
    const ded = lines.filter((l) => l[2]).reduce((s, l) => s + l[1], 0)
    const net = Number(rec.netPayable) || 0
    const lwd = res.actualLwd || res.proposedLwd

    const html = `<!doctype html><html><head><meta charset="utf-8"><title>Full &amp; Final Settlement — ${e(emp.fullName)}</title>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: https:; style-src 'unsafe-inline'">
<style>body{font-family:Georgia,'Times New Roman',serif;color:#111;margin:0;padding:44px;max-width:760px;margin:0 auto;line-height:1.6;font-size:13px}
.head{text-align:center;border-bottom:3px double #059669;padding-bottom:14px;margin-bottom:20px}
.co{font-size:22px;font-weight:700;color:#065f46;letter-spacing:.04em}
.co small{display:block;font-weight:400;color:#555;font-size:11px;font-family:Arial;margin-top:2px}
h1{font-size:16px;text-align:center;margin:8px 0 18px;letter-spacing:.08em;text-transform:uppercase;color:#065f46}
table{width:100%;border-collapse:collapse;margin:8px 0}
th,td{padding:7px 10px;border:1px solid #d1d5db;text-align:left;font-size:12px}
th{background:#ecfdf5;color:#065f46;font-family:Arial;font-size:11px;text-transform:uppercase;letter-spacing:.04em}
.kv td{border:none;padding:4px 10px}
.kv td:first-child{color:#555;width:200px}
.r{text-align:right}.b{font-weight:700}
.net{margin-top:14px;border:2px solid #059669;border-radius:8px;padding:12px 16px;display:flex;justify-content:space-between;align-items:center;background:#ecfdf5}
.net .amt{font-size:20px;font-weight:800;color:#065f46}
.neg{color:#b91c1c}
.foot{margin-top:36px;display:flex;justify-content:space-between;font-size:12px}
.foot .sig{text-align:center}.foot .line{margin-top:42px;border-top:1px solid #555;padding-top:4px;width:220px}
.note{margin-top:22px;font-size:10px;color:#777;font-family:Arial}
@media print{body{padding:0}}</style></head><body>
<div class="head"><div class="co">${e(vendor?.name || "Company")}<small>${e(vendor?.address || "")}${vendor?.phone ? " · " + e(vendor.phone) : ""}</small></div></div>
<h1>Full &amp; Final Settlement Statement</h1>
<table class="kv">
<tr><td>Employee</td><td class="b">${e(emp.fullName)}</td></tr>
<tr><td>Employee Code</td><td>${e(emp.code || "—")}</td></tr>
<tr><td>Designation / Department</td><td>${e(desig?.name || "—")}${dept?.name ? " · " + e(dept.name) : ""}</td></tr>
<tr><td>Joining Date</td><td>${fmtD(emp.joiningDate)}</td></tr>
<tr><td>Last Working Day</td><td>${fmtD(lwd)}</td></tr>
<tr><td>Separation Type</td><td>${e(titleCase(resolveExitType(res, emp.status)))}</td></tr>
<tr><td>Statement Status</td><td class="b">${e(rec.status)}${rec.paidAt ? ` — paid ${fmtD(rec.paidAt.toISOString().slice(0, 10))}` : ""}</td></tr>
</table>
<table>
<tr><th>Description</th><th class="r">Amount (BDT)</th></tr>
${lines.map(([label, amount, isDed]) => `<tr><td>${e(label)}${isDed ? " (−)" : ""}</td><td class="r">${fmt(amount)}</td></tr>`).join("\n")}
<tr><td class="b">Total earnings</td><td class="r b">${fmt(gross)}</td></tr>
<tr><td class="b">Total deductions</td><td class="r b">${fmt(ded)}</td></tr>
</table>
<div class="net"><span class="b" style="font-family:Arial;font-size:13px;letter-spacing:.06em">NET PAYABLE</span><span class="amt ${net < 0 ? "neg" : ""}">${fmt(net)}${net < 0 ? " <span style='font-size:11px;font-weight:600'>(due from employee)</span>" : ""}</span></div>
<div class="foot">
<div class="sig"><div class="line">Employee Signature</div></div>
<div class="sig"><div class="line">${e(vendor?.signatoryName || "Authorized Signatory")}<br>${e(vendor?.signatoryDesignation || "Authorized Signatory")}</div></div>
</div>
<p class="note">This statement is system-generated from the Full &amp; Final settlement computation and is final once approved. Amounts are in Bangladeshi Taka. Journal reference: ${e(rec.journalId ? String(rec.journalId).slice(0, 12) : "posted on payment")}.</p>
</body></html>`
    await audit(ctx, "settlements.html", "FinalSettlement", rec.id,
      `Printed F&F statement for ${emp.fullName}${privileged ? "" : " (self-service, own record)"}`)
    return { html, letterNumber: null, employeeName: emp.fullName }
  },
})

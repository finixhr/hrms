// ============ Attendance Engine routes (spec §7) ============
// Shift-aware attendance: late / early leave / working hours / overtime are
// computed against the employee's assigned shift (auto-detect via roster).
// Sources: MANUAL, BIOMETRIC, GEOFENCE, WEB, IMPORT. (QR attendance was
// removed from the product — rotating-token check-in/out retired.)
import { db } from "@/lib/db"
import { bumpStorageRollup } from "../saas/entitlements"
import { route } from "./registry"
import { Deny, employeeScopeFilter, assertEmployeeVisible, scopedEmployeeWhere } from "../rbac"
import { audit, notify } from "../audit"
import { getSettings } from "../settings"
import { hhmm, timeToMinutes, today, titleCase, resolveWeeklyOffDays, addDays } from "../utils"
import { isOvernight, calcOvernight, type OvernightShift } from "../overnight"
import { sweepOnce } from "../zkteco/gateway"
import { effectiveFencesFor, evaluateFences, type FenceLike } from "../geo"
import { resolveEffectivePolicy, trackingConfig, attendanceMethodConfig, dayRulesBundle } from "../attendance-policy"
import { analyzeLocationIntegrity, integrityToEventStatus } from "../location-integrity"
import { recordTrackingEvent, upsertTrackingState } from "../tracking"
import { rateLimitDistributed, RATE_LIMITS } from "../rate-limit"
import { S } from "../validation"
import { validateSelfieDataUrl } from "../uploads"

import { hashCode } from "../totp"
import { requireSelfieStorage, requireFeature } from "../saas/entitlements"
import crypto from "node:crypto"

/** P6 WS-C — punch confirmation to the puncher themselves (in-app
 *  notification + the push rail rides free through notify()). Mobile users
 *  get an immediate on-device record of every self-punch: time, day status
 *  and where relevant the fence they punched at. Best-effort — never blocks
 *  the punch response. */
async function notifyPunchConfirmed(
  ctx: { vendorId: string },
  emp: { id: string; fullName: string },
  rec: { status?: string | null; checkIn?: string | null; checkOut?: string | null },
  what: string,
  where?: string | null,
) {
  try {
    const stamp = rec.checkOut || rec.checkIn || hhmm()
    await notify(
      ctx.vendorId,
      { employeeId: emp.id },
      "Punch recorded",
      `${what} at ${stamp}${where ? ` — ${where}` : ""}. Day status: ${titleCase(String(rec.status || "—"))}.`,
      "ATTENDANCE",
      "ess",
    )
  } catch { /* best-effort — the punch itself already succeeded */ }
}

async function resolveShift(vendorId: string, employeeId: string, defaultShiftId: string | null, date: string) {
  const assignment = await db.shiftAssignment.findFirst({
    where: { vendorId, employeeId, fromDate: { lte: date }, OR: [{ toDate: null }, { toDate: { gte: date } }] },
    orderBy: { fromDate: "desc" },
  })
  const shiftId = assignment?.shiftId || defaultShiftId
  if (!shiftId) return null
  // ATT-011 — the shift fetch is vendor-scoped: a foreign-tenant shift id
  // (assignment row or employee default injected cross-tenant) must never
  // drive THIS tenant's attendance math
  return db.shift.findFirst({ where: { id: shiftId, vendorId } })
}

/** HRM-008/009 — vendor attendance policy overrides (shift-level values win, vendor policy is the default). */
export type AttendancePolicy = {
  graceMinutes?: number
  earlyLeaveThresholdMinutes?: number
  /** ATT-306 (R3-4) — statutory daily OT ceiling in MINUTES (0/undefined = unlimited). */
  maxOtMinutesPerDay?: number
  /** ATT-017 (R7) — true when this bundle carries an effective ATTENDANCE_RULES
   *  policy: the policy's explicit fields then override the SHIFT's defaults
   *  too (the policy is the per-group rules engine; the shift is a fallback). */
  rulesPolicy?: boolean
  /** ATT-017 (R7) — the policy's explicit half-day threshold (hours). */
  halfDayHoursPolicy?: number
}

/** ATT-305/PAY-017 (R3-4) — attendance period-lock guard. Shared by manual
 *  marking, bulk marking, correction requests and correction approval.
 *  Rejects:
 *    1. future dates (always — no exceptions);
 *    2. dates older than settings.attendance.lockAfterDays (0 = no lock);
 *    3. dates inside a month/week whose payroll run is already PAID — unless
 *       the caller holds attendance.process AND explicitly passes
 *       overridePaidLock (each override is audited so a PAID snapshot is never
 *       silently rewritten; the payroll entry itself is immutable anyway and
 *       corrections flow through an ADJUSTMENT run).
 *  Device ingestion and the SYSTEM absent sweep bypass this guard (raw device
 *  truth is always recorded; the sweep only materializes missing days). */
export async function assertAttendanceDateEditable(
  ctx: { vendorId: string; userId: string | null; userName: string | null; ip?: string; permissions: Set<string> },
  vendorId: string,
  date: string,
  opts?: { overridePaidLock?: boolean },
): Promise<void> {
  const t = today()
  if (date > t) throw new Deny("Attendance cannot be marked for a future date")
  const settings = await getSettings(vendorId)
  const lock = Math.max(0, Number(settings.attendance?.lockAfterDays) || 0)
  if (lock > 0 && date < addDaysStr(t, -lock)) {
    throw new Deny(`Attendance is locked ${lock} day(s) back (locked by Settings → Attendance → lock-after-days) — only ${addDaysStr(t, -lock)} onwards can be edited`)
  }
  // PAY-017 — month-level PAID-run guard (weekly runs check the ISO week too)
  const paid = await db.payrollRun.findFirst({
    where: { vendorId, status: "PAID", periodYear: Number(date.slice(0, 4)), periodMonth: Number(date.slice(5, 7)) },
    select: { id: true, periodWeek: true, paymentDate: true },
  })
  if (paid) {
    if (opts?.overridePaidLock && ctx.permissions.has("attendance.process")) {
      await audit(ctx as any, "attendance.paidPeriodOverride", "Attendance", date,
        `Overriding the PAID payroll-period lock for ${date} (run ${paid.id}) — the payroll snapshot itself stays immutable; recalculate via an adjustment run to propagate`)
      return
    }
    throw new Deny(`This period's payroll is already PAID (run ${paid.id}) — attendance edits are locked so the payslip snapshot and the ledger cannot drift. Holders of the attendance.process permission can override explicitly with overridePaidLock, and pay corrections flow through an adjustment run.`, 409)
  }
}

function addDaysStr(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

/** Core engine: compute late/early/OT against shift rules. */
export function computeAttendance(shift: any, checkIn: string | null, checkOut: string | null, halfDayHoursFallback = 4, policy: AttendancePolicy = {}) {
  // ATT-005 (re-ported R3-2) — overnight (cross-midnight) shifts: this engine
  // computed workingMinutes as max(0, out − in − break), which clamps to ZERO
  // for a night shift (22:00 in → 06:00 out); only the ZKTeco device path
  // applied the overnight-aware calcOvernight. Branch here (shared
  // ../overnight helper, verbatim device-path math) so EVERY punch path —
  // manual mark, portal self check-out, geo-fence, selfie — scores the same
  // minutes. Both punches must exist; a lone check-in keeps the day-shift math.
  if (shift && isOvernight(shift) && checkIn && checkOut) {
    // ATT-003 — the overnight branch receives the SAME vendor policy knobs
    // (grace, early-leave threshold, daily OT cap) the day branch below uses
    return calcOvernight(shift as OvernightShift, checkIn, checkOut, {
      graceMinutes: policy.graceMinutes,
      earlyLeaveThresholdMinutes: policy.earlyLeaveThresholdMinutes,
      maxOtMinutesPerDay: policy.maxOtMinutesPerDay,
    })
  }
  const start = timeToMinutes(shift?.startTime || "09:00")
  const end = timeToMinutes(shift?.endTime || "17:00")
  // HRM-008 — grace before marking LATE: shift grace overrides the vendor
  // late-coming policy default. ATT-017 (R7) — an explicit ATTENDANCE_RULES
  // policy field overrides the shift too (per-group rules engine).
  const grace = policy.rulesPolicy && policy.graceMinutes != null
    ? policy.graceMinutes
    : shift?.graceMinutes ?? policy.graceMinutes ?? 10
  const inMin = timeToMinutes(checkIn || "00:00")
  const outMin = checkOut ? timeToMinutes(checkOut) : null

  let lateMinutes = 0
  // ATT-308 (R3-4) — grace is DEDUCTED on every punch path, matching the
  // device engine (zkteco/processor.ts) and the re-ported overnight helper:
  // an arrival inside the grace window is not late. The old plain
  // `inMin - start` inflated lateMinutes by the grace period on every
  // manual/geo/selfie punch and drove systematic late-deduction over-charges.
  if (inMin > start + grace) lateMinutes = inMin - start - grace
  let earlyLeaveMinutes = 0
  let workingMinutes = 0
  if (outMin != null) {
    workingMinutes = Math.max(0, outMin - inMin - (shift?.breakMinutes || 0))
    const expectedEnd = end
    // HRM-009 — early-leave threshold from vendor policy (shift-independent)
    if (outMin < expectedEnd - (policy.earlyLeaveThresholdMinutes ?? 15)) earlyLeaveMinutes = expectedEnd - outMin
  }
  let overtimeMinutes = 0
  const otThreshold = shift?.otThresholdMinutes ?? 30
  if (outMin != null && outMin >= end + otThreshold) overtimeMinutes = outMin - end - 0
  // ATT-306 (R3-4) — statutory daily OT ceiling (BD Labour Act practice:
  // 8h ordinary + 2h OT max per day; 48h ordinary week). Cap applied on every
  // non-device punch path; the monthly cap in the payroll engine still applies.
  const dailyCap = Math.max(0, Number(policy.maxOtMinutesPerDay) || 0)
  if (dailyCap > 0 && overtimeMinutes > dailyCap) overtimeMinutes = dailyCap

  let status = "PRESENT"
  const halfDayHours = policy.halfDayHoursPolicy != null
    ? policy.halfDayHoursPolicy
    : shift?.minWorkingHours ? shift.minWorkingHours / 2 : halfDayHoursFallback
  if (lateMinutes > 0) status = "LATE" // late dominates; early-leave minutes remain recorded
  else if (earlyLeaveMinutes > 0) status = "EARLY_LEAVE"
  if (checkOut && workingMinutes < halfDayHours * 60) status = "HALF_DAY"
  return { lateMinutes, earlyLeaveMinutes, workingMinutes, overtimeMinutes, status }
}

async function upsertAttendance(ctx: any, p: any, source: string) {
  // H-7 — the shared marking path enforces the caller's employee scope
  // (branch managers: their branch; department managers: their department),
  // not just the tenant. Reads already applied employeeScopeFilter; this
  // closes the write path (attendance + OT fabrication vector).
  const emp = await db.employee.findFirst({ where: { id: p.employeeId, vendorId: ctx.vendorId, ...employeeScopeFilter(ctx) } })
  if (!emp) throw new Deny("Employee not found (or outside your branch/department scope)", 404)
  // ATT-305/PAY-017 (R3-4) — future-date / lock / PAID-period guard. Applies
  // to every human-driven write through this shared path (mark, bulkMark,
  // correction approval). The device pipeline and the SYSTEM absent sweep do
  // not come through here.
  if (source !== "BIOMETRIC" && p.date) {
    await assertAttendanceDateEditable(ctx, ctx.vendorId, String(p.date), { overridePaidLock: !!p.overridePaidLock })
  }
  const settings = await getSettings(ctx.vendorId)
  const shift = await resolveShift(ctx.vendorId, emp.id, emp.shiftId, p.date)

  const existing = await db.attendance.findFirst({ where: { vendorId: ctx.vendorId, employeeId: emp.id, date: p.date } })
  // manual status override (LEAVE / HOLIDAY / WEEKLY_OFF / WFH / BUSINESS_TRIP)
  if (p.status && ["LEAVE", "HOLIDAY", "WEEKLY_OFF", "WFH", "BUSINESS_TRIP", "ABSENT"].includes(p.status)) {
    const data: any = {
      vendorId: ctx.vendorId, employeeId: emp.id, date: p.date, shiftId: shift?.id || null,
      status: p.status, source, remarks: p.remarks || null, ip: ctx.ip,
    }
    // HIGH-8 (this audit) — atomic upsert against the compound unique key
    // [vendorId, employeeId, date] (schema.prisma:627). The previous
    // findFirst+update||create pattern raced on concurrent marking calls
    // for the same (employeeId, date).
    return db.attendance.upsert({
      where: { vendorId_employeeId_date: { vendorId: ctx.vendorId, employeeId: emp.id, date: p.date } },
      create: data,
      update: data,
    })
  }

  if (!p.checkIn) throw new Deny("checkIn time required")
  // When check-out is not required (vendor setting), an open check-in closes at shift end.
  const effectiveCheckOut = p.checkOut || (!settings.attendance.requireCheckOut ? (shift?.endTime || null) : null)
  // ATT-017 (R7) — day-level rules merge the employee's effective
  // ATTENDANCE_RULES policy over the tenant-wide settings.
  const rules = await dayRulesBundle(ctx.vendorId, emp, settings)
  const calc = computeAttendance(shift, p.checkIn, effectiveCheckOut, rules.halfDayHours,
    { graceMinutes: rules.graceMinutes, earlyLeaveThresholdMinutes: rules.earlyLeaveThresholdMinutes,
      // ATT-306 — statutory daily OT ceiling from the shift settings group
      maxOtMinutesPerDay: rules.maxOtMinutesPerDay,
      // ATT-017 — per-group rules policy markers (policy beats shift defaults)
      ...(rules.rulesPolicy ? { rulesPolicy: true } : {}),
      ...(rules.halfDayHoursPolicy != null ? { halfDayHoursPolicy: rules.halfDayHoursPolicy } : {}) })

  // OT approval policy (spec §7.6): new/changed OT needs approval when enabled.
  let otApproved: boolean | null = null
  if (calc.overtimeMinutes > 0) {
    if (settings.shift.otApprovalRequired) {
      const unchanged = existing?.otApproved === true && existing.overtimeMinutes === calc.overtimeMinutes
      otApproved = unchanged ? true : false
    } else {
      otApproved = existing?.otApproved ?? null // policy off → auto-accepted
    }
  }

  const data: any = {
    vendorId: ctx.vendorId, employeeId: emp.id, date: p.date, shiftId: shift?.id || null,
    checkIn: p.checkIn, checkOut: p.checkOut || null,
    workingMinutes: calc.workingMinutes, lateMinutes: calc.lateMinutes,
    earlyLeaveMinutes: calc.earlyLeaveMinutes, overtimeMinutes: calc.overtimeMinutes,
    status: p.forceStatus || calc.status, source,
    deviceInfo: p.deviceInfo || null, latitude: p.latitude ?? null, longitude: p.longitude ?? null,
    accuracyM: p.accuracyM ?? null, ip: ctx.ip, remarks: p.remarks || null,
  }
  if (otApproved !== null) data.otApproved = otApproved
  // Provenance: a manual re-mark never silently rewrites a biometric-sourced day.
  if (existing && existing.source === "BIOMETRIC" && source === "MANUAL") {
    data.source = "BIOMETRIC"
    data.remarks = `${p.remarks || "Manually corrected"} (biometric record preserved)`
  }
  // HIGH-8 — atomic upsert against the compound unique key. The previous
  // findFirst+update||create pattern raced on concurrent marking.
  return db.attendance.upsert({
    where: { vendorId_employeeId_date: { vendorId: ctx.vendorId, employeeId: emp.id, date: p.date } },
    create: data,
    update: data,
  })
}

// ---------- Daily attendance grid (mark / today view) ----------
route("attendance.today", {
  perm: ["attendance", "view"],
  handler: async (ctx, p) => {
    const date = p?.date || today()
    const where: any = employeeScopeFilter(ctx)
    where.status = { in: ["ACTIVE", "PROBATION", "ON_LEAVE", "SUSPENDED"] }
    const employees = await db.employee.findMany({ where, orderBy: { fullName: "asc" } })
    const records = await db.attendance.findMany({ where: { vendorId: ctx.vendorId, date } })
    const shifts = await db.shift.findMany({ where: { vendorId: ctx.vendorId } })
    const branches = await db.branch.findMany({ where: { vendorId: ctx.vendorId }, select: { id: true, name: true } })
    const depts = await db.department.findMany({ where: { vendorId: ctx.vendorId }, select: { id: true, name: true } })
    const leaves = await db.leaveRequest.findMany({ where: { vendorId: ctx.vendorId, status: "APPROVED", fromDate: { lte: date }, toDate: { gte: date } } })
    const holidays = await db.holiday.findMany({ where: { vendorId: ctx.vendorId, date } })
    return employees.map((e) => {
      const rec = records.find((r) => r.employeeId === e.id)
      const onLeave = leaves.find((l) => l.employeeId === e.id)
      // ATT-007 — holiday is resolved PER EMPLOYEE BRANCH: a branch-specific
      // holiday must not paint the whole tenant's grid HOLIDAY (branchId null
      // = tenant-wide, otherwise the employee's own branch only)
      const onHoliday = holidays.some((h) => !h.branchId || h.branchId === e.branchId)
      return {
        employeeId: e.id, code: e.code, fullName: e.fullName,
        branchName: branches.find((b) => b.id === e.branchId)?.name,
        departmentName: depts.find((d) => d.id === e.departmentId)?.name,
        shiftName: shifts.find((s) => s.id === (rec?.shiftId || e.shiftId))?.name,
        record: rec || null,
        impliedStatus: rec ? rec.status : onLeave ? "LEAVE" : onHoliday ? "HOLIDAY" : null,
      }
    })
  },
})

route("attendance.mark", {
  perm: ["attendance", "create"],
  // ATT-305 — schema gives the date a shape; the semantic guards (future /
  // lock / PAID period) run inside upsertAttendance.
  schema: S.attendanceMark,
  handler: async (ctx, p) => {
    const settings = await getSettings(ctx.vendorId)
    if (!settings.attendance.allowManualMarking && ctx.role !== "HR_ADMIN") {
      throw new Deny("Manual marking is disabled by vendor settings — use the attendance correction workflow")
    }
    const rec = await upsertAttendance(ctx, p, "MANUAL")
    if (!rec) throw new Deny("Could not mark attendance", 500)
    await audit(ctx, "attendance.mark", "Attendance", rec.id, `Marked ${p.date} for employee ${p.employeeId} (${rec.status})`)
    return rec
  },
})

route("attendance.bulkMark", {
  perm: ["attendance", "process"],
  // ATT-311 (R3-4) — bounded + schema-validated bulk marking: at most 500
  // employee ids, well-formed date, HH:MM punch times. The old loop took any
  // payload and iterated unbounded sequential awaits inside one RPC.
  schema: S.attendanceBulkMark,
  handler: async (ctx, p) => {
    const settings = await getSettings(ctx.vendorId)
    if (!settings.attendance.allowManualMarking && ctx.role !== "HR_ADMIN") {
      throw new Deny("Manual marking is disabled by vendor settings")
    }
    const { date, employeeIds, checkIn, checkOut } = p
    // one lock-guard for the whole batch (same date for every row) — fails
    // fast before any per-employee DB work instead of mid-loop
    await assertAttendanceDateEditable(ctx, ctx.vendorId, date, { overridePaidLock: !!p.overridePaidLock })
    let n = 0
    for (const id of employeeIds) {
      await upsertAttendance(ctx, { employeeId: id, date, checkIn, checkOut }, "MANUAL")
      n++
    }
    await audit(ctx, "attendance.bulkMark", "Attendance", date, `Bulk marked ${n} employees on ${date}`)
    return { count: n }
  },
})

// ---------- Monthly register ----------
route("attendance.register", {
  perm: ["attendance", "view"],
  handler: async (ctx, p) => {
    const month = p?.month || new Date().getMonth() + 1
    const year = p?.year || new Date().getFullYear()
    const prefix = `${year}-${String(month).padStart(2, "0")}`
    const where: any = { vendorId: ctx.vendorId, date: { startsWith: prefix }, ...await scopedEmployeeWhere(ctx, p) }
    // SCL-10 (Phase 2 WS3) — the branch/department + search filters now
    // intersect instead of overwriting each other, and search (q) matches
    // name/code server-side so the paginated mode can find rows beyond the
    // loaded page.
    const employeeIdSets: string[][] = []
    if (p?.branchId || p?.departmentId) {
      const empFilter: any = { vendorId: ctx.vendorId }
      if (p?.branchId) empFilter.branchId = p.branchId
      if (p?.departmentId) empFilter.departmentId = p.departmentId
      const emps = await db.employee.findMany({ where: empFilter, select: { id: true } })
      employeeIdSets.push(p?.employeeId ? [p.employeeId].filter((x) => emps.some((e) => e.id === x)) : emps.map((e) => e.id))
    } else if (p?.employeeId) {
      employeeIdSets.push([p.employeeId])
    }
    if (p?.q && String(p.q).trim()) {
      const q = String(p.q).trim()
      const matches = await db.employee.findMany({
        where: { vendorId: ctx.vendorId, OR: [{ fullName: { contains: q, mode: "insensitive" } }, { code: { contains: q, mode: "insensitive" } }] },
        select: { id: true },
      })
      employeeIdSets.push(matches.map((m) => m.id))
    }
    if (employeeIdSets.length === 1) where.employeeId = { in: employeeIdSets[0] }
    else if (employeeIdSets.length > 1) {
      const [a, b] = employeeIdSets
      const setB = new Set(b)
      where.employeeId = { in: a.filter((x) => setB.has(x)) }
    }
    // SCL-10 — optional server-side pagination. Paged mode (page and/or
    // pageSize present) returns {items, total, page, pageSize} bounded at 500
    // rows/query; legacy callers without pagination params keep the exact
    // full-month array contract. The old handler materialized the WHOLE month
    // (150K rows at 5K employees) plus FULL employee rows for decoration on
    // every request.
    const paged = p?.page != null || p?.pageSize != null
    const pageSize = Math.min(500, Math.max(1, Number(p?.pageSize) || 200))
    const page = Math.max(1, Number(p?.page) || 1)
    const orderBy: any[] = [{ date: "asc" }, { employeeId: "asc" }]
    const records = paged
      ? await db.attendance.findMany({ where, orderBy, skip: (page - 1) * pageSize, take: pageSize })
      : await db.attendance.findMany({ where, orderBy })
    const total = paged ? await db.attendance.count({ where }) : null
    // SCL-10 — slim decoration: 3 columns via one whereIn + Map (was: full
    // employee rows per month id-set with a .find() per record)
    const empIds = [...new Set(records.map((r) => r.employeeId))]
    const employees = empIds.length
      ? await db.employee.findMany({ where: { vendorId: ctx.vendorId, id: { in: empIds } }, select: { id: true, fullName: true, code: true } })
      : []
    const empById = new Map(employees.map((e) => [e.id, e]))
    const items = records.map((r) => ({
      ...r,
      employeeName: empById.get(r.employeeId)?.fullName || "—",
      employeeCode: empById.get(r.employeeId)?.code,
    }))
    return paged ? { items, total, page, pageSize } : items
  },
})

route("attendance.summary", {
  perm: ["attendance", "view"],
  handler: async (ctx, p) => {
    // aggregates for overtime / late / absence analysis
    const month = p?.month || new Date().getMonth() + 1
    const year = p?.year || new Date().getFullYear()
    const prefix = `${year}-${String(month).padStart(2, "0")}`
    const where: any = { vendorId: ctx.vendorId, date: { startsWith: prefix }, ...await scopedEmployeeWhere(ctx, p) }
    const settings = await getSettings(ctx.vendorId)
    // SCL-10 (Phase 2 WS3) — SQL aggregates. The handler used to load the
    // whole month's rows into JS (150K rows at 5K employees) just to reduce
    // them to nine scalars; the same numbers now come from grouped/aggregate
    // queries with identical semantics (unapproved OT is excluded from the
    // OT sum when the vendor requires approval — explicit otApproved=false
    // only; NULL keeps counting, exactly like the old reduce).
    const [byStatus, sums, plainOtSum, approvedOtSum, pendingOt] = await Promise.all([
      db.attendance.groupBy({ by: ["status"], _count: { _all: true }, where }),
      db.attendance.aggregate({ _sum: { lateMinutes: true, workingMinutes: true }, where }),
      db.attendance.aggregate({ _sum: { overtimeMinutes: true }, where }),
      db.attendance.aggregate({
        _sum: { overtimeMinutes: true },
        where: { ...where, OR: [{ otApproved: true }, { otApproved: null }] },
      }),
      db.attendance.count({ where: { ...where, otApproved: false, overtimeMinutes: { gt: 0 } } }),
    ])
    const statusCount = (st: string) => byStatus.find((r) => r.status === st)?._count._all || 0
    const totalRows = byStatus.reduce((s, r) => s + (r._count._all || 0), 0)
    const otMinutes = settings.shift.otApprovalRequired
      ? (approvedOtSum._sum.overtimeMinutes || 0)
      : (plainOtSum._sum.overtimeMinutes || 0)
    return {
      count: totalRows,
      present: statusCount("PRESENT") + statusCount("LATE") + statusCount("EARLY_LEAVE") + statusCount("WFH") + statusCount("BUSINESS_TRIP"),
      absent: statusCount("ABSENT"),
      late: statusCount("LATE"),
      halfDay: statusCount("HALF_DAY"),
      leave: statusCount("LEAVE"),
      totalOvertimeMinutes: otMinutes,
      pendingOtApprovals: pendingOt,
      totalLateMinutes: sums._sum.lateMinutes || 0,
      totalWorkingMinutes: sums._sum.workingMinutes || 0,
    }
  },
})

// ---------- Overtime approval (spec §7.6 — approval requirement) ----------
route("attendance.otApprove", {
  perm: ["attendance", "process"],
  handler: async (ctx, p) => {
    const rec = await db.attendance.findFirst({ where: { id: p.id, vendorId: ctx.vendorId } })
    if (!rec) throw new Deny("Attendance record not found", 404)
    // ATT-002 (re-ported R3-2) — employee-scope enforcement: the record fetch
    // used to be tenant-only, so a branch/department manager could approve OT
    // for a foreign-branch employee. Same assertEmployeeVisible guard the
    // neighboring write paths (upsertAttendance) apply.
    await assertEmployeeVisible(ctx, rec.employeeId)
    if (!(rec.overtimeMinutes > 0)) throw new Deny("This record has no overtime to approve")
    const decision = p.decision === "REJECT" ? "REJECTED" : "APPROVED"
    // Rejecting OT zeroes the minutes (audited, reversible by re-approve recalculation path only via re-mark)
    const data: any = { otApproved: decision === "APPROVED" }
    if (decision === "REJECTED") data.overtimeMinutes = 0
    await db.attendance.update({ where: { id: rec.id }, data })
    // ATT-306 (R3-4) — compensatory-leave accrual: approving OT worked on a
    // weekly-off / holiday credits the employee's COMP_OFF balance (half-day
    // granularity at settings.attendance.compOffHoursPerDay). No accrual below
    // half a day; the leave type is ensured lazily so tenants that never enable
    // the toggle see no new rows.
    if (decision === "APPROVED" && rec.overtimeMinutes > 0) {
      try {
        const settings = await getSettings(ctx.vendorId)
        if (settings.attendance?.compOffEnabled) {
          const dow = ["SUNDAY", "MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY"][new Date(`${rec.date}T00:00:00Z`).getUTCDay()]
          const emp = await db.employee.findFirst({ where: { id: rec.employeeId, vendorId: ctx.vendorId } })
          const empShift = emp?.shiftId ? await db.shift.findFirst({ where: { id: emp.shiftId, vendorId: ctx.vendorId }, select: { weeklyOff: true } }) : null
          const weeklyOff = resolveWeeklyOffDays(emp?.weeklyOff, empShift?.weeklyOff, settings.general.weeklyHoliday)
          const isHoliday = !!(await db.holiday.findFirst({ where: { vendorId: ctx.vendorId, date: rec.date, OR: [{ branchId: null }, ...(emp?.branchId ? [{ branchId: emp.branchId }] : [])] } }))
          if (weeklyOff.includes(dow) || isHoliday) {
            const hoursPerDay = Math.max(1, Number(settings.attendance.compOffHoursPerDay) || 8)
            const days = Math.floor((rec.overtimeMinutes / 60 / hoursPerDay) * 2) / 2
            if (days >= 0.5) {
              const type = await db.leaveType.upsert({
                where: { vendorId_code: { vendorId: ctx.vendorId, code: "COMP_OFF" } },
                create: { vendorId: ctx.vendorId, code: "COMP_OFF", name: "Compensatory Leave", paid: true, defaultDays: 0, carryForward: false, active: true },
                update: { active: true },
              })
              const year = Number(rec.date.slice(0, 4))
              const bal = await db.leaveBalance.upsert({
                where: { employeeId_leaveTypeId_year: { employeeId: rec.employeeId, leaveTypeId: type.id, year } },
                create: { vendorId: ctx.vendorId, employeeId: rec.employeeId, leaveTypeId: type.id, year, entitled: days, used: 0, pending: 0 },
                update: { entitled: { increment: days } },
              })
              await audit(ctx, "attendance.compOffAccrual", "LeaveBalance", bal.id,
                `Accrued ${days} comp-off day(s) for ${rec.overtimeMinutes} minutes of approved ${isHoliday ? "holiday" : "weekly-off"} overtime on ${rec.date}`)
              await notify(ctx.vendorId, { employeeId: rec.employeeId }, "Compensatory Leave Credited",
                `${days} comp-off day(s) were credited for your approved overtime on ${rec.date}.`, "ATTENDANCE", "ess")
            }
          }
        }
      } catch (e) {
        // accrual is best-effort — the OT approval itself already stands
        console.error("[attendance.otApprove] comp-off accrual failed", e)
      }
    }
    await audit(ctx, "attendance.otApprove", "Attendance", rec.id,
      `${decision} overtime (${rec.overtimeMinutes}m) for ${rec.date}`, { reason: p.reason })
    await notify(ctx.vendorId, { employeeId: rec.employeeId }, "Overtime " + titleCase(decision),
      `Your overtime of ${Math.round(rec.overtimeMinutes / 60 * 10) / 10}h on ${rec.date} was ${decision.toLowerCase()}.`, "ATTENDANCE", "ess")
    return { status: decision }
  },
})

route("attendance.otPending", {
  perm: ["attendance", "view"],
  handler: async (ctx, p) => {
    const month = p?.month || new Date().getMonth() + 1
    const year = p?.year || new Date().getFullYear()
    const prefix = `${year}-${String(month).padStart(2, "0")}`
    const records = await db.attendance.findMany({
      where: { vendorId: ctx.vendorId, date: { startsWith: prefix }, otApproved: false, overtimeMinutes: { gt: 0 } },
      orderBy: { date: "desc" },
    })
    const employees = await db.employee.findMany({ where: { vendorId: ctx.vendorId }, select: { id: true, fullName: true, code: true } })
    return records.map((r) => ({ ...r, employeeName: employees.find((e) => e.id === r.employeeId)?.fullName || "—", employeeCode: employees.find((e) => e.id === r.employeeId)?.code }))
  },
})

// ---------- Attendance correction workflow (spec Phase 5) ----------
route("attendance.corrections.list", {
  perm: ["attendance", "view"],
  handler: async (ctx, p) => {
    const where: any = { vendorId: ctx.vendorId }
    if (p?.status) where.status = p.status
    const list = await db.attendanceCorrection.findMany({ where, orderBy: { createdAt: "desc" } })
    const employees = await db.employee.findMany({ where: { vendorId: ctx.vendorId } })
    return list.map((c) => ({ ...c, employeeName: employees.find((e) => e.id === c.employeeId)?.fullName || "—" }))
  },
})
// INTENTIONALLY_SELF_SCOPED (M-02 / ESS-01): ESS employees request corrections for THEMSELVES
// (ess.create); HR applies for anyone (attendance.create, scope-checked in-handler). The old
// route-level perm [attendance, create] 403'd the EMPLOYEE persona — the primary user of this
// flow — before the handler's self-scope branch could ever run, leaving the ESS action dead.
route("attendance.corrections.request", {
  schema: S.attendanceCorrectionRequest,
  handler: async (ctx, p) => {
    if (!ctx.permissions.has("ess.create") && !ctx.permissions.has("attendance.create")) {
      throw new Deny("Permission denied: attendance correction requests are not granted to your role")
    }
    // SUB-107 class — the ESS self-service path rides the ESS plan feature;
    // HR (attendance.create) keeps working on plans without ESS.
    if (ctx.role === "EMPLOYEE") {
      await requireFeature(ctx.vendorId, "ESS")
    }
    const emp = ctx.employeeId ? await db.employee.findFirst({ where: { id: ctx.employeeId, vendorId: ctx.vendorId } }) : null
    const employeeId = ctx.role === "EMPLOYEE" ? ctx.employeeId : p.employeeId
    if (!employeeId) throw new Deny("No employee profile linked", 400)
    // M-register — non-EMPLOYEE callers must reference an employee inside their scope
    if (ctx.role !== "EMPLOYEE") {
      const target = await db.employee.findFirst({ where: { id: employeeId, vendorId: ctx.vendorId, ...employeeScopeFilter(ctx) } })
      if (!target) throw new Deny("Employee not found (or outside your scope)", 404)
    }
    if (!p.date) throw new Deny("A correction date is required", 400)
    // ATT-305/PAY-017 — same future/lock/PAID-period guard as marking; a
    // requester cannot even queue a correction for a locked day (HR holders
    // of attendance.process may override the PAID lock explicitly).
    await assertAttendanceDateEditable(ctx, ctx.vendorId, String(p.date), { overridePaidLock: !!p.overridePaidLock })
    const rec = await db.attendanceCorrection.create({
      data: { vendorId: ctx.vendorId, employeeId, date: p.date, requestedIn: p.requestedIn || null, requestedOut: p.requestedOut || null, reason: p.reason },
    })
    await audit(ctx, "attendance.correction.request", "AttendanceCorrection", rec.id, `Correction requested for ${p.date}`)
    await notify(ctx.vendorId, { role: "HR_ADMIN" }, "Attendance Correction Request",
      `${emp?.fullName || "Employee"} requested attendance correction for ${p.date}.`, "ATTENDANCE", "attendance")
    return rec
  },
})
  // L-19 — standard RBAC gate (attendance.verify); no self-scope exemption:
  // deciding corrections is an HR capability, not a self-service action.
route("attendance.corrections.act", {
  // L-19 — the decision gate is now the RBAC permission system (attendance
  // .verify) instead of a hardcoded role list; HR_ADMIN/VENDOR_OWNER carry it
  // via their templates and HR_MANAGER was granted it explicitly, preserving
  // the previous role behavior through the standard permission mechanism.
  perm: ["attendance", "verify"],
  handler: async (ctx, p) => {
    const rec = await db.attendanceCorrection.findFirst({ where: { id: p.id, vendorId: ctx.vendorId, status: "PENDING" } })
    if (!rec) throw new Deny("Correction request not found", 404)
    if (p.decision === "APPROVED") {
      // ATT-304 (R3-4) — out-only corrections are the most common case (punched
      // in fine, forgot to check out). The ESS dialog says "Leave blank to keep
      // as-is" for the check-in field, but the old approval path fed
      // requestedIn (null) straight into upsertAttendance, which hard-requires
      // a check-in — the approval ALWAYS failed with 400 and the request sat
      // PENDING forever. Pass the EXISTING row's check-in through when the
      // correction only specifies a check-out (and vice versa); reject only
      // when BOTH times are absent AND no attendance row exists.
      const existingRow = await db.attendance.findFirst({ where: { vendorId: ctx.vendorId, employeeId: rec.employeeId, date: rec.date } })
      const checkIn = rec.requestedIn || existingRow?.checkIn || null
      const checkOut = rec.requestedOut || (rec.requestedIn ? existingRow?.checkOut || null : null)
      if (!checkIn) {
        throw new Deny("Cannot approve this correction: no check-in time was requested and no existing attendance row has one — ask the employee to re-request with a check-in time (or mark the day manually)", 400)
      }
      await upsertAttendance(ctx, {
        employeeId: rec.employeeId, date: rec.date, checkIn, checkOut,
        remarks: `Approved correction: ${rec.reason || "—"}`, overridePaidLock: !!p.overridePaidLock,
      }, "MANUAL")
    }
    await db.attendanceCorrection.update({ where: { id: rec.id }, data: { status: p.decision, actedBy: ctx.userId, actedAt: new Date() } })
    await audit(ctx, "attendance.correction.act", "AttendanceCorrection", rec.id, `${p.decision} correction for ${rec.date}`)
    await notify(ctx.vendorId, { employeeId: rec.employeeId }, "Attendance Correction " + titleCase(p.decision),
      `Your correction request for ${rec.date} was ${p.decision.toLowerCase()}.`, "ATTENDANCE", "ess")
    return { status: p.decision }
  },
})

// ---------- Biometric devices (generic integration layer — spec §7.3) ----------
// H-06 — the legacy actions attendance.devices.list / attendance.devices.create
// / attendance.devices.save were DELETED: they returned raw AttendanceDevice
// rows (including the write-only commKeyHash) and pre-dated the dedicated
// devices.* routes (routes/devices.ts) which use publicDevice() to strip
// credentials. Re-registering these action names fails the CI permission
// lint (scripts/audit-perms.py LEGACY_BLOCKLIST).
route("attendance.devices.sync", {
  perm: ["attendance", "process"],
  handler: async (ctx, p) => {
    // REAL sync (legacy action kept for API compatibility): processes every
    // pending raw ADMS event for the device and stamps lastSyncAt.
    const device = await db.attendanceDevice.findFirst({ where: { id: p.deviceId, vendorId: ctx.vendorId } })
    if (!device) throw new Deny("Device not found", 404)
    const before = await db.attendanceRawEvent.count({ where: { deviceId: device.id, processingStatus: "RECEIVED" } })
    // L-12 — sweepOnce is VENDOR-wide by design (the queue is shared); the
    // response now says so instead of reporting the vendor totals as if they
    // were this device's import result.
    const { processed, failed } = await sweepOnce(ctx.vendorId)
    // ATT-019 (R5) — status reflects the sweep outcome: a device whose sweep
    // FAILED is not marked ONLINE (the old code stamped ONLINE unconditionally).
    await db.attendanceDevice.update({ where: { id: device.id }, data: { lastSyncAt: new Date(), syncStatus: failed > 0 ? "ERROR" : "IDLE", status: failed > 0 ? "OFFLINE" : "ONLINE" } })
    await audit(ctx, "attendance.devices.sync", "AttendanceDevice", device.id, `Vendor-wide event sweep triggered from ${device.name} (device pending before: ${before}, vendor processed: ${processed}, vendor failed: ${failed})`)
    return { imported: processed, duplicates: 0, failed, vendorWide: true, devicePendingBefore: before, date: today() }
  },
})



// ---------- Self-service check helpers ----------
// QR attendance (rotating-token check-in/out) was REMOVED from the product.
// The self-service geo-fence punch flow and the plain self check-out below
// replace it; resolveCheckActor stays — the geo-fence routes share it.
/** H-04/H-05 — resolve the employee for QR/geofence self-service actions.
 * EMPLOYEE callers act strictly for themselves. Non-EMPLOYEE (HR/staff) callers
 * acting on behalf of a DIFFERENT employee need attendance.edit permission AND
 * the target must be inside their scope (assertEmployeeVisible). */
async function resolveCheckActor(ctx: any, p: any, action: string): Promise<string> {
  if (ctx.role === "EMPLOYEE") {
    if (p.employeeId && p.employeeId !== ctx.employeeId) throw new Deny("You can only check in/out yourself")
    if (!ctx.employeeId) throw new Deny("No employee profile linked to your account")
    return ctx.employeeId
  }
  const employeeId = p.employeeId || ctx.employeeId
  if (!employeeId) throw new Deny("No employee profile linked to your account")
  if (employeeId !== ctx.employeeId) {
    // staff acting for someone else — privileged path
    if (!ctx.permissions.has("attendance.edit")) {
      throw new Deny("Marking attendance for another employee requires the attendance.edit permission")
    }
    const target = await assertEmployeeVisible(ctx, employeeId)
    await audit(ctx, action, "Attendance", null,
      `${action} performed on behalf of ${target.fullName} (${target.code}) by ${ctx.userName} [${ctx.role}] — reason: ${p.reason || "not provided"}`)
  }
  return employeeId
}

/** ATT-002 — resolve the open check-in a check-out should close. Today's row
 *  first; when today has none, the most recent UNCHECKED-OUT row within a
 *  24-hour lookback (a day-shift employee who works past midnight checks out
 *  after 00:00 — the old `date: today()` query then found the new, empty day
 *  and denied with "No check-in found for today" on every portal path; only
 *  the biometric pipeline attributed early-morning OUTs to the previous day).
 *  Returns the row (or null) plus the attendance date the caller should
 *  compute the shift for. */
async function findOpenCheckIn(vendorId: string, employeeId: string): Promise<{ row: any | null; date: string }> {
  const t = today()
  const todays = await db.attendance.findFirst({ where: { vendorId, employeeId, date: t } })
  if (todays) return { row: todays, date: t }
  const open = await db.attendance.findFirst({
    where: { vendorId, employeeId, date: { gte: addDays(t, -1), lt: t }, checkOut: null },
    orderBy: { date: "desc" },
  })
  return open ? { row: open, date: open.date } : { row: null, date: t }
}


  // INTENTIONALLY_SELF_SCOPED (M-02): plain self check-out WITHOUT a QR token —
  // the employee-portal fallback when geolocation is unavailable or the branch
  // has no geo-fence configured. Replaces the retired attendance.qr.checkout
  // fallback path (which required a rotating token that no longer exists).
route("attendance.selfCheckout", {
  schema: S.selfCheckout,
  handler: async (ctx, p) => {
    const employeeId = await resolveCheckActor(ctx, p, "attendance.selfCheckout")
    if (!employeeId) throw new Deny("No employee profile linked to your account")
    // L-13 — the plain (non-GPS) self check-out must respect the
    // ATTENDANCE_METHOD policy: the ESS client used to silently fall back to
    // this route when GPS failed, letting employees bypass a geofence-required
    // checkout. The method vocabulary is GEOFENCE | SELFIE | GEOFENCE_SELFIE |
    // DEVICE_PUNCH — a plain portal checkout (no GPS, no selfie — see
    // S.selfCheckout) satisfies NONE of them directly, so it is allowed only
    // when the policy does not exist (legacy vendors keep the old behavior)
    // or explicitly permits no-GPS check-outs (SELFIE listed and
    // requireGeofence off).
    const empRow = await db.employee.findFirst({ where: { id: employeeId, vendorId: ctx.vendorId } })
    if (empRow) {
      const methodPolicy = await resolveEffectivePolicy(ctx.vendorId, empRow, "ATTENDANCE_METHOD")
      if (methodPolicy) {
        const cfg = attendanceMethodConfig(methodPolicy.config)
        const permitsNoGps = !cfg.requireGeofence && cfg.methods.includes("SELFIE")
        if (!permitsNoGps) {
          throw new Deny("Your attendance method policy requires a GPS check-out — enable location and use the geo check-out button, or punch the biometric device", 403)
        }
      }
    }
    // ATT-002 — cross-midnight checkout: resolve the open check-in within a
    // 24h lookback, not just today's row
    const { row: existing, date: attDate } = await findOpenCheckIn(ctx.vendorId, employeeId)
    if (!existing) throw new Deny("No check-in found for today")
    if (existing.checkOut) throw new Deny("Already checked out today")
    const shift = await resolveShift(ctx.vendorId, employeeId, existing.shiftId, attDate)
    const settings = await getSettings(ctx.vendorId)
    // ATT-017 (R7) — policy-merged day rules (per-employee/group overrides)
    const selfEmp = await db.employee.findFirst({ where: { id: employeeId, vendorId: ctx.vendorId }, select: { id: true, branchId: true, departmentId: true } })
    const rules = selfEmp ? await dayRulesBundle(ctx.vendorId, selfEmp, settings) : { halfDayHours: settings.attendance.halfDayHours, graceMinutes: settings.latePolicy?.graceMinutes, earlyLeaveThresholdMinutes: settings.earlyLeavePolicy?.thresholdMinutes, maxOtMinutesPerDay: (Number((settings as any).shift?.maxOtHoursPerDay) || 0) * 60 }
    const calc = computeAttendance(shift, existing.checkIn, hhmm(), rules.halfDayHours,
      { graceMinutes: rules.graceMinutes, earlyLeaveThresholdMinutes: rules.earlyLeaveThresholdMinutes,
      maxOtMinutesPerDay: rules.maxOtMinutesPerDay })
    const data: any = {
      checkOut: hhmm(), workingMinutes: calc.workingMinutes, lateMinutes: calc.lateMinutes,
      earlyLeaveMinutes: calc.earlyLeaveMinutes, overtimeMinutes: calc.overtimeMinutes, status: calc.status,
      // ATT-002 — flag the cross-midnight day in the remarks so the register
      // can explain an after-midnight OUT time against a previous-day date
      ...(attDate !== today() ? { remarks: "Cross-midnight check-out (punched after 00:00 for the previous day's shift)" } : {}),
      source: existing.source,
      latitude: p.latitude ?? existing.latitude, longitude: p.longitude ?? existing.longitude, accuracyM: p.accuracyM ?? existing.accuracyM,
    }
    if (calc.overtimeMinutes > 0) data.otApproved = settings.shift.otApprovalRequired ? false : (existing.otApproved ?? null)
    const rec = await db.attendance.update({ where: { id: existing.id }, data })

    await audit(ctx, "attendance.selfCheckout", "Attendance", rec.id, `Self check-out (portal) ${rec.status} (${rec.overtimeMinutes}m OT)`)
    if (empRow) await notifyPunchConfirmed(ctx, empRow, rec, "Self check-out (portal)")
    return rec
  },
})

// ---------- Geo-fence attendance (spec §7.5; 2026-10 round §22–§28) ----------
/** Shared fence validation. 2026-10 round: fences now resolve through the
 *  POLICY ENGINE (effective fences for the employee — policy-linked fences
 *  first, legacy branch fence as backward-compatible fallback §69), distance
 *  is computed SERVER-SIDE (never trusted from the client §22), accuracy
 *  rules apply (§23) and location integrity is analyzed (§24).
 *  Returns the evaluation + the fences considered + the tracking policy. */
async function validateGeofence(vendorId: string, employeeId: string, latitude: number, longitude: number, accuracyM?: number | null) {
  const emp = await db.employee.findFirst({ where: { id: employeeId, vendorId } })
  if (!emp) throw new Deny("Employee not found", 404)
  const fences = await effectiveFencesFor(vendorId, emp)
  if (!fences.length) {
    throw new Deny("No geo-fence is configured for your branch or policies — contact HR", 400)
  }
  // accuracy threshold from the employee's effective tracking policy (or global default)
  const trackingPolicy = await resolveEffectivePolicy(vendorId, emp, "TRACKING")
  const tCfg = trackingConfig(trackingPolicy?.config)
  const settings = await getSettings(vendorId)
  const evalResult = evaluateFences(fences, latitude, longitude, accuracyM ?? null, {
    maxAccuracyM: Number(trackingPolicy?.config?.maxAccuracyM ?? (settings as any).tracking?.maxAccuracyM ?? tCfg.maxAccuracyM),
  })
  if (!evalResult.ok) {
    // REVIEW verdicts (inside the circle but unverifiable accuracy) surface
    // a distinct error so the route can record a REVIEW_REQUIRED event (§23/§25)
    if (evalResult.reason?.startsWith("REVIEW:")) {
      throw Object.assign(new Deny(evalResult.reason.slice(7), 400), { review: true, fence: evalResult.fence, distance: evalResult.distanceM })
    }
    throw new Deny(evalResult.reason || "You are outside the assigned Geo-Fence", 400)
  }
  return { fence: (evalResult.fence as FenceLike), distance: evalResult.distanceM ?? 0, fences, trackingPolicy }
}

/** Enforce the ATTENDANCE_METHOD policy for a check-in/out (§28): which
 *  methods are allowed and whether a selfie proof is required. Returns the
 *  resolved method (GEOFENCE / GEOFENCE_SELFIE / SELFIE). */
async function enforceMethodPolicy(vendorId: string, emp: any, p: any, hasSelfie: boolean): Promise<string> {
  const policy = await resolveEffectivePolicy(vendorId, emp, "ATTENDANCE_METHOD")
  if (!policy) {
    // no method policy → legacy behavior: plain geo-fence attendance
    return hasSelfie ? "GEOFENCE_SELFIE" : "GEOFENCE"
  }
  const cfg = attendanceMethodConfig(policy.config)
  const method = hasSelfie ? (p.latitude != null ? "GEOFENCE_SELFIE" : "SELFIE") : "GEOFENCE"
  if (!cfg.methods.includes(method)) {
    throw new Deny(`Your policy does not allow ${method.replace(/_/g, " ").toLowerCase()} attendance (allowed: ${cfg.methods.join(", ")})`, 403)
  }
  if (cfg.selfieRequired && !hasSelfie) {
    throw new Deny("This attendance requires a selfie", 400)
  }
  if (cfg.requireGeofence && p.latitude == null) {
    throw new Deny("GPS coordinates are required for this attendance", 400)
  }
  return method
}

/** Location-integrity analysis for a check-in/out (§24). Warn/review outcomes
 *  still let the attendance through (flagged for review); REJECT outcomes
 *  throw with a clear message (§87). */
async function analyzeCheckIntegrity(vendorId: string, employeeId: string, p: any, tCfg: ReturnType<typeof trackingConfig>) {
  if (p.latitude == null) return null
  const prev = await db.trackingPoint.findFirst({ where: { vendorId, employeeId }, orderBy: { timestamp: "desc" } })
  const verdict = analyzeLocationIntegrity(
    {
      latitude: Number(p.latitude), longitude: Number(p.longitude), accuracyM: p.accuracyM ?? null,
      clientTimestamp: p.clientTimestamp ?? null, isMockLocation: p.isMockLocation ?? null, deviceId: p.deviceId ?? null,
    },
    prev ? { latitude: prev.latitude, longitude: prev.longitude, at: prev.timestamp } : null,
    new Date(), { maxAccuracyM: tCfg.maxAccuracyM, suspiciousAction: tCfg.suspiciousAction }
  )
  if (verdict.decision === "REJECT") {
    throw new Deny("Location integrity could not be verified — this check-in was rejected", 400)
  }
  return verdict
}

/** M-14 — the selfie rate-limit preset (12/10min, sized for one selfie per
 *  attendance action + retries) existed in RATE_LIMITS but was never wired:
 *  nothing consumed it. Wired here for both geo check-in and check-out. */
async function guardSelfieRate(employeeId: string) {
  const preset = RATE_LIMITS.selfie
  // SCL-21 (Phase 3 WS-B) — Redis bucket first when configured (cluster-wide),
  // in-process sliding window otherwise.
  const r = await rateLimitDistributed(`selfie:${employeeId}`, preset.limit, preset.windowMs)
  if (!r.ok) throw new Deny(`Too many selfie uploads — retry in ${r.retryAfterSec}s`, 429)
}

/** M-15 — a fence REVIEW verdict (inside the circle but unverifiable accuracy)
 *  must leave an audit trail BEFORE the denial surfaces. The old code let the
 *  review-flagged Deny propagate uncaught, so poor-GPS employees were
 *  hard-rejected with no REVIEW_REQUIRED event, no audit row and no
 *  review-queue entry — contradicting the §23/§25 design intent that the
 *  validateGeofence() review marker promised. */
async function recordFenceReview(
  vendorId: string,
  employeeId: string,
  kind: "CHECK_IN" | "CHECK_OUT",
  p: any,
  e: any,
) {
  await recordTrackingEvent(vendorId, employeeId, kind, "MOBILE", new Date(), {
    attendanceMethod: "GEOFENCE",
    latitude: p.latitude ?? null, longitude: p.longitude ?? null, accuracyM: p.accuracyM ?? null,
    geoFenceId: e.fence?.id ?? null,
    distanceFromGeoFenceM: e.distance ?? null,
    locationIntegrityStatus: "REVIEW",
    status: "REVIEW_REQUIRED",
    reason: `Geo-fence ${kind === "CHECK_IN" ? "check-in" : "check-out"} needs review: ${e.message}`,
    flags: { signals: ["FENCE_REVIEW"], decision: "REVIEW" },
  }).catch(() => {})
}

  // INTENTIONALLY_SELF_SCOPED (M-02): self check-in: handler validates coordinates + employee identity
  // 2026-10 round §22–§28: policy-aware fence validation + accuracy rules +
  // location integrity + optional/required selfie proof + AttendanceEvent.
route("attendance.geofence.checkin", {
  schema: S.geoCheckin,
  handler: async (ctx, p) => {
    const employeeId = await resolveCheckActor(ctx, p, "attendance.geofence.checkin")
    if (!employeeId) throw new Deny("No employee profile linked to your account")
    if (!Number.isFinite(Number(p.latitude)) || !Number.isFinite(Number(p.longitude))) throw new Deny("GPS coordinates required for geo-fence attendance", 400)
    const emp = await db.employee.findFirst({ where: { id: employeeId, vendorId: ctx.vendorId } })
    if (!emp) throw new Deny("Employee not found", 404)
    // SUB-107 (R3-5) — geo-fence punches ride the GEOFENCE plan feature. These
    // self-scoped routes carry no def.perm, so the dispatcher's module gate
    // never applies to them (the "attendance" prefix maps to no feature —
    // attendance itself is core). Mirrors requireFieldForceFeature (fieldforce.ts).
    await requireFeature(ctx.vendorId, "GEOFENCE")
    const hasSelfie = !!p.selfieDataUrl
    if (hasSelfie) await guardSelfieRate(employeeId) // M-14 — wired selfie throttle
    // SUB-106 (R3-5) — storage-metered selfie write: checked BEFORE any DB
    // write so a quota rejection leaves no orphan punch/event rows behind.
    if (hasSelfie) await requireSelfieStorage(ctx.vendorId, p.selfieDataUrl)
    const method = await enforceMethodPolicy(ctx.vendorId, emp, p, hasSelfie)
    let fence: FenceLike, distance: number, trackingPolicy: any
    try {
      ;({ fence, distance, trackingPolicy } = await validateGeofence(ctx.vendorId, employeeId, Number(p.latitude), Number(p.longitude), p.accuracyM ?? null))
    } catch (e: any) {
      // M-15 — a REVIEW verdict leaves a REVIEW_REQUIRED event + audit row
      // before the denial surfaces (previously hard-rejected with no trail)
      if (e?.review) {
        await recordFenceReview(ctx.vendorId, employeeId, "CHECK_IN", p, e)
        await audit(ctx, "attendance.geofence.checkin", "Attendance", null,
          `Geo-fence check-in by ${emp.fullName} flagged for review (${e.message}) — no attendance record written`) .catch(() => {})
      }
      throw e
    }
    const tCfg = trackingConfig(trackingPolicy?.config)
    const integrity = await analyzeCheckIntegrity(ctx.vendorId, employeeId, p, tCfg)
    // G2 — device binding: STRICT may 403 the punch outright; ADVISORY lets it
    // through but flags the event DEVICE_MISMATCH for HR review.
    const binding = await evaluateDeviceBinding(ctx.vendorId, employeeId, p)
    if (binding.deny) throw binding.deny
    const deviceMismatch = binding.mode === "ADVISORY" && !!p.deviceId && (!binding.device || binding.device.status !== "ACTIVE")
    // H-4 — first-in / last-out re-entry guard (biometric-engine parity). The
    // old path called upsertAttendance blind: its update branch is a full-row
    // overwrite, so 09:00 in → 17:00 out → an accidental 22:00 re-check-in
    // produced checkIn=22:00, checkOut=null, workingMinutes=0, status=LATE.
    // Rules: NEVER overwrite an existing checkIn with a later time, NEVER null
    // an existing checkOut; an at-or-later re-check-in adds nothing → deny.
    const existing = await db.attendance.findFirst({ where: { vendorId: ctx.vendorId, employeeId, date: today() } })
    const punchAt = hhmm()
    let rec
    if (existing?.checkIn) {
      if (punchAt >= existing.checkIn) {
        throw new Deny("Already checked in today", 400)
      }
      // an EARLIER punch wins (first-in): move checkIn back, keep checkOut,
      // recompute derived minutes from (earlier checkIn, existing checkOut)
      const settings = await getSettings(ctx.vendorId)
      const shift = await resolveShift(ctx.vendorId, employeeId, existing.shiftId, today())
      // ATT-017 (R7) — policy-merged day rules (per-employee/group overrides)
      const selfEmp = await db.employee.findFirst({ where: { id: employeeId, vendorId: ctx.vendorId }, select: { id: true, branchId: true, departmentId: true } })
      const rules = selfEmp ? await dayRulesBundle(ctx.vendorId, selfEmp, settings) : { halfDayHours: settings.attendance.halfDayHours, graceMinutes: settings.latePolicy?.graceMinutes, earlyLeaveThresholdMinutes: settings.earlyLeavePolicy?.thresholdMinutes, maxOtMinutesPerDay: (Number((settings as any).shift?.maxOtHoursPerDay) || 0) * 60 }
      const calc = computeAttendance(shift, punchAt, existing.checkOut, rules.halfDayHours,
        { graceMinutes: rules.graceMinutes, earlyLeaveThresholdMinutes: rules.earlyLeaveThresholdMinutes,
      maxOtMinutesPerDay: rules.maxOtMinutesPerDay })
      const data: any = {
        checkIn: punchAt,
        workingMinutes: calc.workingMinutes, lateMinutes: calc.lateMinutes,
        earlyLeaveMinutes: calc.earlyLeaveMinutes, overtimeMinutes: calc.overtimeMinutes,
        status: calc.status,
        latitude: p.latitude ?? existing.latitude, longitude: p.longitude ?? existing.longitude, accuracyM: p.accuracyM ?? existing.accuracyM,
      }
      if (calc.overtimeMinutes > 0 && settings.shift.otApprovalRequired) data.otApproved = false
      rec = await db.attendance.update({ where: { id: existing.id }, data })
    } else {
      rec = await upsertAttendance(ctx, {
        employeeId, date: today(), checkIn: punchAt, checkOut: null,
        deviceInfo: p.deviceInfo || "GEOFENCE", latitude: p.latitude, longitude: p.longitude, accuracyM: p.accuracyM,
      }, method.includes("SELFIE") ? "SELFIE" : "GEOFENCE")
    }
    // selfie proof (private storage, §26) + normalized event (§4)
    let proofId: string | null = null
    if (hasSelfie) {
      const settings = await getSettings(ctx.vendorId)
      const stored = await storeSelfieProofLocal(ctx.vendorId, employeeId, p, Number((settings as any).tracking?.retentionDays ?? 90))
      proofId = stored
    }
    const eventStatus = deviceMismatch ? "REVIEW_REQUIRED" : (integrity ? integrityToEventStatus(integrity) : "ACCEPTED")
    const event = await recordTrackingEvent(ctx.vendorId, employeeId, "CHECK_IN", "MOBILE", new Date(), {
      attendanceMethod: method,
      latitude: p.latitude ?? null, longitude: p.longitude ?? null, accuracyM: p.accuracyM ?? null,
      batteryPercentage: p.batteryPercentage ?? null, isCharging: p.isCharging ?? null,
      gpsStatus: p.gpsStatus ?? "OK", networkStatus: p.networkStatus ?? "ONLINE",
      deviceId: p.deviceId ?? null, mobileSessionId: p.mobileSessionId ?? null,
      geoFenceId: fence.id, distanceFromGeoFenceM: distance,
      locationIntegrityStatus: deviceMismatch ? "DEVICE_MISMATCH" : (integrity?.status ?? null),
      policyId: trackingPolicy?.policy.id ?? null,
      clientEventId: p.clientEventId ? `ci:${p.clientEventId}` : null,
      clientTimestamp: p.clientTimestamp ?? null,
      selfieProofId: proofId,
      attendanceId: rec.id,
      status: eventStatus,
      reason: deviceMismatch
        ? `Geo-fence check-in from an unregistered device — flagged for review`
        : `Geo-fence check-in at ${fence.name} (${distance}m from center)`,
      flags: { signals: [...(integrity?.signals ?? []), ...(deviceMismatch ? ["DEVICE_MISMATCH"] : [])], decision: deviceMismatch ? "REVIEW" : (integrity?.decision ?? "ALLOW") },
    })
    if (proofId && event) await db.attendanceProof.update({ where: { id: proofId }, data: { attendanceEventId: event.id } })
    await touchDeviceLastSeen(ctx.vendorId, employeeId, String(p.deviceId || ""), ctx.ip)
    // refresh tracking state with this fix (§9)
    await upsertTrackingState(ctx.vendorId, employeeId, {
      trackingStatus: "TRACKING", lastSeenAt: new Date(), latitude: p.latitude, longitude: p.longitude,
      accuracyM: p.accuracyM ?? null, batteryPercentage: p.batteryPercentage ?? null, isCharging: p.isCharging ?? null,
      gpsStatus: p.gpsStatus ?? "OK", networkStatus: p.networkStatus ?? "ONLINE",
      geoFenceId: fence.id, insideGeoFence: true, lastEventId: event?.id ?? null, lastPolicyId: trackingPolicy?.policy.id ?? null,
    })
    if (eventStatus === "REVIEW_REQUIRED" || eventStatus === "SUSPICIOUS") {
      await notify(ctx.vendorId, { role: "HR_ADMIN" }, "Attendance Needs Review",
        `Geo-fence check-in by ${emp.fullName} was flagged (${integrity?.status ?? "suspicious location"}) and requires review.`, "ATTENDANCE_SECURITY", "attendance")
    }
    await audit(ctx, "attendance.geofence.checkin", "Attendance", rec.id,
      `Geo-fence check-in at ${fence.name} (${distance}m from center, ${rec.status}${integrity && integrity.status !== "VERIFIED" ? `, integrity: ${integrity.status}` : ""})`)
    await notifyPunchConfirmed(ctx, emp, rec, "Geo-fence check-in", fence.name)
    return { ...rec, distance, fence: fence.name, integrity: integrity ? { status: integrity.status, decision: integrity.decision } : null }
  },
})

  // INTENTIONALLY_SELF_SCOPED (M-02): self check-out: handler validates coordinates + employee identity
route("attendance.geofence.checkout", {
  schema: S.geoCheckout,
  handler: async (ctx, p) => {
    const employeeId = await resolveCheckActor(ctx, p, "attendance.geofence.checkout")
    if (!employeeId) throw new Deny("No employee profile linked to your account")
    if (!Number.isFinite(Number(p.latitude)) || !Number.isFinite(Number(p.longitude))) throw new Deny("GPS coordinates required for geo-fence check-out", 400)
    const emp = await db.employee.findFirst({ where: { id: employeeId, vendorId: ctx.vendorId } })
    if (!emp) throw new Deny("Employee not found", 404)
    // SUB-107 — same GEOFENCE feature gate as check-in
    await requireFeature(ctx.vendorId, "GEOFENCE")
    const hasSelfie = !!p.selfieDataUrl
    if (hasSelfie) await guardSelfieRate(employeeId) // M-14 — wired selfie throttle
    // SUB-106 — storage-metered selfie write (before any DB write)
    if (hasSelfie) await requireSelfieStorage(ctx.vendorId, p.selfieDataUrl)
    const method = await enforceMethodPolicy(ctx.vendorId, emp, p, hasSelfie)
    let fence: FenceLike, distance: number, trackingPolicy: any
    try {
      ;({ fence, distance, trackingPolicy } = await validateGeofence(ctx.vendorId, employeeId, Number(p.latitude), Number(p.longitude), p.accuracyM ?? null))
    } catch (e: any) {
      // M-15 — same review trail on check-out
      if (e?.review) {
        await recordFenceReview(ctx.vendorId, employeeId, "CHECK_OUT", p, e)
        await audit(ctx, "attendance.geofence.checkout", "Attendance", null,
          `Geo-fence check-out by ${emp.fullName} flagged for review (${e.message}) — no attendance record changed`).catch(() => {})
      }
      throw e
    }
    const tCfg = trackingConfig(trackingPolicy?.config)
    const integrity = await analyzeCheckIntegrity(ctx.vendorId, employeeId, p, tCfg)
    // G2 — device binding (same semantics as check-in)
    const binding = await evaluateDeviceBinding(ctx.vendorId, employeeId, p)
    if (binding.deny) throw binding.deny
    const deviceMismatch = binding.mode === "ADVISORY" && !!p.deviceId && (!binding.device || binding.device.status !== "ACTIVE")
    // ATT-002 — cross-midnight checkout: resolve the open check-in within a
    // 24h lookback, not just today's row
    const { row: existing, date: attDate } = await findOpenCheckIn(ctx.vendorId, employeeId)
    if (!existing) throw new Deny("No check-in found for today")
    if (existing.checkOut) throw new Deny("Already checked out today")
    const shift = await resolveShift(ctx.vendorId, employeeId, existing.shiftId, attDate)
    const settings = await getSettings(ctx.vendorId)
    // ATT-017 (R7) — policy-merged day rules (per-employee/group overrides)
    const selfEmp = await db.employee.findFirst({ where: { id: employeeId, vendorId: ctx.vendorId }, select: { id: true, branchId: true, departmentId: true } })
    const rules = selfEmp ? await dayRulesBundle(ctx.vendorId, selfEmp, settings) : { halfDayHours: settings.attendance.halfDayHours, graceMinutes: settings.latePolicy?.graceMinutes, earlyLeaveThresholdMinutes: settings.earlyLeavePolicy?.thresholdMinutes, maxOtMinutesPerDay: (Number((settings as any).shift?.maxOtHoursPerDay) || 0) * 60 }
    const calc = computeAttendance(shift, existing.checkIn, hhmm(), rules.halfDayHours,
      { graceMinutes: rules.graceMinutes, earlyLeaveThresholdMinutes: rules.earlyLeaveThresholdMinutes,
      maxOtMinutesPerDay: rules.maxOtMinutesPerDay })
    const data: any = {
      checkOut: hhmm(), workingMinutes: calc.workingMinutes, lateMinutes: calc.lateMinutes,
      earlyLeaveMinutes: calc.earlyLeaveMinutes, overtimeMinutes: calc.overtimeMinutes, status: calc.status,
      // ATT-002 — flag the cross-midnight day in the remarks so the register
      // can explain an after-midnight OUT time against a previous-day date
      ...(attDate !== today() ? { remarks: "Cross-midnight check-out (punched after 00:00 for the previous day's shift)" } : {}),
      latitude: p.latitude, longitude: p.longitude, accuracyM: p.accuracyM,
    }
    if (calc.overtimeMinutes > 0) data.otApproved = settings.shift.otApprovalRequired ? false : (existing.otApproved ?? null)
    const rec = await db.attendance.update({ where: { id: existing.id }, data })
    // selfie proof + normalized event (§26, §4)
    let proofId: string | null = null
    if (hasSelfie) {
      const stored = await storeSelfieProofLocal(ctx.vendorId, employeeId, p, Number((settings as any).tracking?.retentionDays ?? 90))
      proofId = stored
    }
    const eventStatus = deviceMismatch ? "REVIEW_REQUIRED" : (integrity ? integrityToEventStatus(integrity) : "ACCEPTED")
    const event = await recordTrackingEvent(ctx.vendorId, employeeId, "CHECK_OUT", "MOBILE", new Date(), {
      attendanceMethod: method,
      latitude: p.latitude ?? null, longitude: p.longitude ?? null, accuracyM: p.accuracyM ?? null,
      batteryPercentage: p.batteryPercentage ?? null, isCharging: p.isCharging ?? null,
      gpsStatus: p.gpsStatus ?? "OK", networkStatus: p.networkStatus ?? "ONLINE",
      deviceId: p.deviceId ?? null, mobileSessionId: p.mobileSessionId ?? null,
      geoFenceId: fence.id, distanceFromGeoFenceM: distance,
      locationIntegrityStatus: deviceMismatch ? "DEVICE_MISMATCH" : (integrity?.status ?? null),
      policyId: trackingPolicy?.policy.id ?? null,
      clientEventId: p.clientEventId ? `co:${p.clientEventId}` : null,
      clientTimestamp: p.clientTimestamp ?? null,
      selfieProofId: proofId,
      attendanceId: rec.id,
      status: eventStatus,
      reason: deviceMismatch
        ? `Geo-fence check-out from an unregistered device — flagged for review`
        : `Geo-fence check-out at ${fence.name} (${distance}m, ${calc.status}, ${calc.overtimeMinutes}m OT)`,
      flags: { signals: [...(integrity?.signals ?? []), ...(deviceMismatch ? ["DEVICE_MISMATCH"] : [])], decision: deviceMismatch ? "REVIEW" : (integrity?.decision ?? "ALLOW") },
    })
    if (proofId && event) await db.attendanceProof.update({ where: { id: proofId }, data: { attendanceEventId: event.id } })
    await touchDeviceLastSeen(ctx.vendorId, employeeId, String(p.deviceId || ""), ctx.ip)
    await audit(ctx, "attendance.geofence.checkout", "Attendance", rec.id,
      `Geo-fence check-out at ${fence.name} (${distance}m, ${rec.status}, ${rec.overtimeMinutes}m OT${integrity && integrity.status !== "VERIFIED" ? `, integrity: ${integrity.status}` : ""})`)
    await notifyPunchConfirmed(ctx, emp, rec, "Geo-fence check-out", fence.name)
    return { ...rec, distance, fence: fence.name, integrity: integrity ? { status: integrity.status, decision: integrity.decision } : null }
  },
})

  // INTENTIONALLY_SELF_SCOPED (M-02): selfie check-in — the captured selfie IS
  // the second factor / proof of presence; GPS is best-effort, never blocking.
  // Gated on the ATTENDANCE_METHOD policy: the vendor admin must explicitly
  // allow SELFIE (selfie-only) or GEOFENCE_SELFIE (selfie + GPS) — a selfie
  // punch is otherwise rejected with a clear 403 so a single policy toggle
  // controls the whole feature (mirrors the L-13 checkout policy gate).
// INTENTIONALLY_SELF_SCOPED (M-02): selfie punch — own record only (resolveCheckActor) + ATTENDANCE_METHOD policy gate; see the policy note above.
route("attendance.selfie.checkin", {
  schema: S.selfieCheckin,
  handler: async (ctx, p) => {
    const employeeId = await resolveCheckActor(ctx, p, "attendance.selfie.checkin")
    if (!employeeId) throw new Deny("No employee profile linked to your account")
    const emp = await db.employee.findFirst({ where: { id: employeeId, vendorId: ctx.vendorId } })
    if (!emp) throw new Deny("Employee not found", 404)
    // M-14 — selfie throttle BEFORE any policy/db work (same preset as the geo routes)
    await guardSelfieRate(employeeId)

    // L-29 + selfie-checkin test pin — byte-sniff the selfie BEFORE any
    // attendance row is written: a garbage payload must leave NOTHING behind
    // (the old order wrote the attendance row first, so a rejected selfie
    // left an orphan punch). storeSelfieProofLocal re-validates defensively;
    // this early check is the ordering guarantee.
    if (p.selfieDataUrl != null) {
      const precheck = validateSelfieDataUrl(String(p.selfieDataUrl))
      if (!precheck.ok) throw new Deny(precheck.reason, 400)
    }

    // SUB-106 (R3-5) — the selfie IS the storage payload of this punch: meter
    // it against the plan STORAGE quota before anything is written (same
    // no-orphan ordering guarantee as the L-29 byte-sniff above). The capacity
    // registry has advertised "selfie.checkin" as a STORAGE action since the
    // SaaS layer shipped; this is the enforcement that was missing.
    await requireSelfieStorage(ctx.vendorId, p.selfieDataUrl)

    // ---- ATTENDANCE_METHOD policy gate (§28) ----
    // Selfie Attendance G1 — parity with enforceMethodPolicy (the geo routes):
    // NO method policy configured → permissive legacy default. Selfie punches
    // are allowed (GEOFENCE_SELFIE with GPS, SELFIE without) so the portal's
    // selfie buttons work out of the box; vendors who want to restrict punch
    // methods create an ATTENDANCE_METHOD policy, which then gates strictly.
    const methodPolicy = await resolveEffectivePolicy(ctx.vendorId, emp, "ATTENDANCE_METHOD")
    const cfg = methodPolicy ? attendanceMethodConfig(methodPolicy.config) : null
    const hasGps = p.latitude != null && p.longitude != null && Number.isFinite(Number(p.latitude)) && Number.isFinite(Number(p.longitude))
    const method = hasGps ? "GEOFENCE_SELFIE" : "SELFIE"
    if (cfg) {
      if (!cfg.methods.includes(method)) {
        throw new Deny(`Selfie check-in is not allowed by your attendance policy (allowed: ${cfg.methods.join(", ")})`, 403)
      }
      if (cfg.requireGeofence && !hasGps) {
        throw new Deny("Your attendance policy requires GPS with every selfie check-in — enable location and try again", 403)
      }
    }

    // ---- best-effort fence context (never blocking unless requireGeofence) ----
    let fence: FenceLike | null = null
    let distance: number | null = null
    let trackingPolicy: any = null
    if (hasGps) {
      try {
        const v = await validateGeofence(ctx.vendorId, employeeId, Number(p.latitude), Number(p.longitude), p.accuracyM ?? null)
        fence = v.fence; distance = v.distance; trackingPolicy = v.trackingPolicy
      } catch (e: any) {
        if (cfg?.requireGeofence) {
          if (e?.review) {
            await recordFenceReview(ctx.vendorId, employeeId, "CHECK_IN", p, e)
            await audit(ctx, "attendance.selfie.checkin", "Attendance", null,
              `Selfie check-in by ${emp.fullName} flagged for review (${e.message}) — no attendance record written`).catch(() => {})
          }
          throw e
        }
        // policy permits no-GPS SELFIE — record the attempt context and continue
        fence = null; distance = null
      }
    }
    const tCfg = trackingConfig(trackingPolicy?.config)
    const integrity = await analyzeCheckIntegrity(ctx.vendorId, employeeId, p, tCfg)
    // G2 — device binding (same semantics as the geo routes)
    const binding = await evaluateDeviceBinding(ctx.vendorId, employeeId, p)
    if (binding.deny) throw binding.deny
    const deviceMismatch = binding.mode === "ADVISORY" && !!p.deviceId && (!binding.device || binding.device.status !== "ACTIVE")

    // H-4 — same first-in guard as the geo route: never overwrite a later
    // check-in, never touch an existing check-out.
    const existing = await db.attendance.findFirst({ where: { vendorId: ctx.vendorId, employeeId, date: today() } })
    const punchAt = hhmm()
    let rec
    if (existing?.checkIn) {
      if (punchAt >= existing.checkIn) {
        throw new Deny("Already checked in today", 400)
      }
      const settings = await getSettings(ctx.vendorId)
      const shift = await resolveShift(ctx.vendorId, employeeId, existing.shiftId, today())
      // ATT-017 (R7) — policy-merged day rules (per-employee/group overrides)
      const selfEmp = await db.employee.findFirst({ where: { id: employeeId, vendorId: ctx.vendorId }, select: { id: true, branchId: true, departmentId: true } })
      const rules = selfEmp ? await dayRulesBundle(ctx.vendorId, selfEmp, settings) : { halfDayHours: settings.attendance.halfDayHours, graceMinutes: settings.latePolicy?.graceMinutes, earlyLeaveThresholdMinutes: settings.earlyLeavePolicy?.thresholdMinutes, maxOtMinutesPerDay: (Number((settings as any).shift?.maxOtHoursPerDay) || 0) * 60 }
      const calc = computeAttendance(shift, punchAt, existing.checkOut, rules.halfDayHours,
        { graceMinutes: rules.graceMinutes, earlyLeaveThresholdMinutes: rules.earlyLeaveThresholdMinutes,
      maxOtMinutesPerDay: rules.maxOtMinutesPerDay })
      const data: any = {
        checkIn: punchAt,
        workingMinutes: calc.workingMinutes, lateMinutes: calc.lateMinutes,
        earlyLeaveMinutes: calc.earlyLeaveMinutes, overtimeMinutes: calc.overtimeMinutes,
        status: calc.status,
        latitude: p.latitude ?? existing.latitude, longitude: p.longitude ?? existing.longitude, accuracyM: p.accuracyM ?? existing.accuracyM,
      }
      if (calc.overtimeMinutes > 0 && settings.shift.otApprovalRequired) data.otApproved = false
      rec = await db.attendance.update({ where: { id: existing.id }, data })
    } else {
      const settings = await getSettings(ctx.vendorId)
      const shift = await resolveShift(ctx.vendorId, employeeId, emp.shiftId, today())
      const calc = computeAttendance(shift, punchAt, null, settings.attendance.halfDayHours,
        { graceMinutes: settings.latePolicy?.graceMinutes, earlyLeaveThresholdMinutes: settings.earlyLeavePolicy?.thresholdMinutes,
      maxOtMinutesPerDay: (Number((settings as any).shift?.maxOtHoursPerDay) || 0) * 60 })
      rec = await db.attendance.upsert({
        where: { vendorId_employeeId_date: { vendorId: ctx.vendorId, employeeId, date: today() } },
        create: {
          vendorId: ctx.vendorId, employeeId, date: today(), shiftId: shift?.id || null,
          checkIn: punchAt, checkOut: null,
          workingMinutes: calc.workingMinutes, lateMinutes: calc.lateMinutes,
          earlyLeaveMinutes: calc.earlyLeaveMinutes, overtimeMinutes: calc.overtimeMinutes,
          status: calc.status, source: "SELFIE",
          deviceInfo: p.deviceInfo || "SELFIE",
          latitude: p.latitude ?? null, longitude: p.longitude ?? null, accuracyM: p.accuracyM ?? null,
          ip: ctx.ip,
        },
        update: {},
      })
    }

    // selfie proof (private storage, §26) — byte-sniffed, hashed, retention-stamped
    const settings = await getSettings(ctx.vendorId)
    const proofId = await storeSelfieProofLocal(ctx.vendorId, employeeId, p, Number((settings as any).tracking?.retentionDays ?? 90))

    const eventStatus = deviceMismatch ? "REVIEW_REQUIRED" : (integrity ? integrityToEventStatus(integrity) : "ACCEPTED")
    const event = await recordTrackingEvent(ctx.vendorId, employeeId, "CHECK_IN", "MOBILE", new Date(), {
      attendanceMethod: method,
      latitude: p.latitude ?? null, longitude: p.longitude ?? null, accuracyM: p.accuracyM ?? null,
      batteryPercentage: p.batteryPercentage ?? null, isCharging: p.isCharging ?? null,
      gpsStatus: hasGps ? (p.gpsStatus ?? "OK") : (p.gpsStatus ?? "UNAVAILABLE"),
      networkStatus: p.networkStatus ?? "ONLINE",
      deviceId: p.deviceId ?? null, mobileSessionId: p.mobileSessionId ?? null,
      geoFenceId: fence?.id ?? null, distanceFromGeoFenceM: distance,
      locationIntegrityStatus: deviceMismatch ? "DEVICE_MISMATCH" : (integrity?.status ?? null),
      policyId: methodPolicy?.policy?.id ?? null,
      clientEventId: p.clientEventId ? `si:${p.clientEventId}` : null,
      clientTimestamp: p.clientTimestamp ?? null,
      selfieProofId: proofId,
      attendanceId: rec.id,
      status: eventStatus,
      reason: deviceMismatch
        ? `Selfie check-in from an unregistered device — flagged for review`
        : (fence
          ? `Selfie check-in at ${fence.name} (${distance}m from center)`
          : `Selfie check-in${hasGps ? " (outside fence hours/radius — recorded without fence match)" : " (no GPS fix)"}`),
      flags: { signals: [...(integrity?.signals ?? []), ...(deviceMismatch ? ["DEVICE_MISMATCH"] : [])], decision: deviceMismatch ? "REVIEW" : (integrity?.decision ?? "ALLOW") },
    })
    if (proofId && event) await db.attendanceProof.update({ where: { id: proofId }, data: { attendanceEventId: event.id } })
    await touchDeviceLastSeen(ctx.vendorId, employeeId, String(p.deviceId || ""), ctx.ip)

    await upsertTrackingState(ctx.vendorId, employeeId, {
      trackingStatus: "TRACKING", lastSeenAt: new Date(),
      latitude: p.latitude ?? null, longitude: p.longitude ?? null, accuracyM: p.accuracyM ?? null,
      batteryPercentage: p.batteryPercentage ?? null, isCharging: p.isCharging ?? null,
      gpsStatus: hasGps ? (p.gpsStatus ?? "OK") : (p.gpsStatus ?? "UNAVAILABLE"), networkStatus: p.networkStatus ?? "ONLINE",
      geoFenceId: fence?.id ?? null, insideGeoFence: fence ? true : null,
      lastEventId: event?.id ?? null, lastPolicyId: methodPolicy?.policy?.id ?? null,
    })

    if (eventStatus === "REVIEW_REQUIRED" || eventStatus === "SUSPICIOUS") {
      await notify(ctx.vendorId, { role: "HR_ADMIN" }, "Attendance Needs Review",
        `Selfie check-in by ${emp.fullName} was flagged (${integrity?.status ?? "suspicious location"}) and requires review.`, "ATTENDANCE_SECURITY", "attendance")
    }
    await audit(ctx, "attendance.selfie.checkin", "Attendance", rec.id,
      `Selfie check-in by ${emp.fullName}${fence ? ` at ${fence.name} (${distance}m from center)` : " (no GPS fix)"} — ${rec.status}${integrity && integrity.status !== "VERIFIED" ? `, integrity: ${integrity.status}` : ""}`)
    await notifyPunchConfirmed(ctx, emp, rec, "Selfie check-in", fence?.name ?? null)
    return { ...rec, distance, fence: fence?.name ?? null, integrity: integrity ? { status: integrity.status, decision: integrity.decision } : null }
  },
})

/** Local selfie-proof writer for the check-in/out routes (§26): same rules
 *  as the tracking module's storeSelfieProof (base64 data URL, ≤2MB, hash,
 *  retention) — duplicated here to avoid a circular import (tracking.ts
 *  imports from settings/audit; attendance route only needs the writer). */
async function storeSelfieProofLocal(
  vendorId: string, employeeId: string, p: any, retentionDays: number
): Promise<string | null> {
  if (!p.selfieDataUrl) return null
  // L-29 — byte-level selfie validation: the data-URL PREFIX alone proved
  // nothing (a renamed executable declared itself "image/jpeg"). The sniff
  // checks the DECODED bytes and the SNIFFED mime is what gets stored.
  const check = validateSelfieDataUrl(String(p.selfieDataUrl))
  if (!check.ok) throw new Deny(check.reason, 400)
  const m = /^data:([^;]+);base64,([\s\S]+)$/.exec(String(p.selfieDataUrl))
  if (!m) throw new Deny("Selfie must be a base64 data URL", 400)
  const bytes = Buffer.from(m[2], "base64")
  const { createHash } = await import("node:crypto")
  // G1 — capture provenance (score/method/light/focus). EVIDENCE METADATA
  // ONLY: reviewers see it as context; it never flips verificationStatus.
  let qualityJson = "{}"
  if (p.selfieQuality && typeof p.selfieQuality === "object") {
    try { qualityJson = JSON.stringify(p.selfieQuality).slice(0, 2000) } catch { /* keep {} */ }
  }
  const proof = await db.attendanceProof.create({
    data: {
      vendorId, employeeId, attendanceEventId: null,
      proofType: "SELFIE",
      storageKey: `proof/${vendorId}/${employeeId}/${Date.now()}`,
      mimeType: check.mime,
      fileHash: createHash("sha256").update(bytes).digest("hex"),
      byteSize: bytes.byteLength,
      data: m[2],
      capturedAt: new Date(),
      latitude: p.latitude ?? null, longitude: p.longitude ?? null, accuracyM: p.accuracyM ?? null,
      deviceId: p.deviceId ?? null,
      verificationStatus: "EVIDENCE",
      qualityJson,
      retentionUntil: retentionDays > 0 ? new Date(Date.now() + retentionDays * 86_400_000) : null,
    },
  })
  // MOD-5 (Phase 2 WS6) — inline proof bytes bump (best-effort)
  await bumpStorageRollup(vendorId, m[2].length).catch(() => {})
  return proof.id
}

// ================================================================ G2 — DEVICE BINDING
// Employee↔device enrollment + punch-time enforcement. The registry lives in
// EmployeeDevice (schema.prisma); the enforcement MODE comes from the
// employee's effective ATTENDANCE_METHOD policy (`deviceBinding`):
//   OFF      deviceId recorded only (default — historical behaviour)
//   ADVISORY punch proceeds; unenrolled/foreign device flags DEVICE_MISMATCH
//   STRICT   only an ACTIVE enrolled device may punch (403 otherwise)

/** Resolve the binding mode for this employee + evaluate the presented device.
 *  Returns the mode, the matching registry row (or null) and, when the punch
 *  must be blocked, a ready-to-throw Deny. NEVER called for punches without a
 *  deviceId (nothing to bind — recorded as before). */
async function evaluateDeviceBinding(
  vendorId: string, employeeId: string, p: any,
): Promise<{ mode: "OFF" | "ADVISORY" | "STRICT"; device: { id: string; status: string } | null; deny: Deny | null }> {
  const emp = await db.employee.findFirst({ where: { id: employeeId, vendorId } })
  if (!emp) return { mode: "OFF", device: null, deny: null }
  const policy = await resolveEffectivePolicy(vendorId, emp, "ATTENDANCE_METHOD")
  const mode = policy ? (attendanceMethodConfig(policy.config).deviceBinding || "OFF") : "OFF"
  if (mode === "OFF" || !p.deviceId) return { mode, device: null, deny: null }

  const row = await db.employeeDevice.findUnique({
    where: { vendorId_employeeId_deviceId: { vendorId, employeeId, deviceId: String(p.deviceId) } },
  })
  if (!row || row.status === "REVOKED") {
    if (mode === "STRICT") {
      return { mode, device: null, deny: new Deny("This device is not registered for your account — open My Self Service → My Devices to register it", 403) }
    }
    return { mode, device: null, deny: null }
  }
  if (row.status === "PENDING") {
    if (mode === "STRICT") {
      return { mode, device: row, deny: new Deny("This device is registered but awaiting administrator approval — contact HR", 403) }
    }
    return { mode, device: row, deny: null }
  }
  // ACTIVE — possession proof when the device holds an enrolment key
  if (row.keyHash) {
    if (!p.deviceKey || hashCode(String(p.deviceKey)) !== row.keyHash) {
      if (mode === "STRICT") {
        return { mode, device: row, deny: new Deny("Device verification failed — re-register this device from My Self Service → My Devices", 403) }
      }
      return { mode, device: row, deny: null }
    }
  }
  return { mode, device: row, deny: null }
}

/** Touch the registry row's last-seen stamp (best-effort). */
async function touchDeviceLastSeen(vendorId: string, employeeId: string, deviceId: string, ip?: string) {
  if (!deviceId) return
  await db.employeeDevice.updateMany({
    where: { vendorId, employeeId, deviceId },
    data: { lastSeenAt: new Date(), lastSeenIp: ip ?? null },
  }).catch(() => {})
}

  // INTENTIONALLY_SELF_SCOPED (M-02): the employee registers THE device they are
  // using; identity comes from the session, never the payload. Enrolment key is
  // shown ONCE (write-only hash in the DB).
route("attendance.myDevices.enroll", {
  schema: S.myDeviceEnroll,
  handler: async (ctx, p) => {
    if (!ctx.employeeId) throw new Deny("No employee profile linked to your account")
    const existing = await db.employeeDevice.findUnique({
      where: { vendorId_employeeId_deviceId: { vendorId: ctx.vendorId, employeeId: ctx.employeeId, deviceId: p.deviceId } },
    })
    if (existing && existing.status === "ACTIVE") {
      return { id: existing.id, status: existing.status, enrollKey: null, message: "This device is already registered and approved." }
    }
    const enrollKey = crypto.randomBytes(24).toString("base64url")
    const row = existing
      ? await db.employeeDevice.update({ where: { id: existing.id }, data: { keyHash: hashCode(enrollKey), status: "PENDING", revokedAt: null, revokedBy: null, revokeReason: null, userAgent: p.userAgent ?? null, platform: p.platform ?? null } })
      : await db.employeeDevice.create({ data: {
          vendorId: ctx.vendorId, employeeId: ctx.employeeId, deviceId: p.deviceId,
          label: p.label ?? null, platform: p.platform ?? null, userAgent: p.userAgent ?? null,
          keyHash: hashCode(enrollKey), status: "PENDING", enrolledIp: ctx.ip ?? null,
        } })
    await audit(ctx, "attendance.device.enroll", "EmployeeDevice", row.id,
      `Device ${p.deviceId} enrolled for ${ctx.userName} — awaiting administrator approval`)
    // cap: keep the registry tidy — a 4th enrolment revokes the oldest ACTIVE/PENDING row
    const rows = await db.employeeDevice.findMany({
      where: { vendorId: ctx.vendorId, employeeId: ctx.employeeId, status: { in: ["ACTIVE", "PENDING"] } },
      orderBy: { enrolledAt: "asc" },
    })
    if (rows.length > 3) {
      const excess = rows.slice(0, rows.length - 3)
      await db.employeeDevice.updateMany({ where: { id: { in: excess.map((r) => r.id) } }, data: { status: "REVOKED", revokedAt: new Date(), revokeReason: "Device cap (3) exceeded" } })
    }
    return { id: row.id, status: row.status, enrollKey, message: "Device registered — awaiting administrator approval. Save the key shown now; it is not shown again." }
  },
})

// INTENTIONALLY_SELF_SCOPED (M-02): ESS device list — returns only the caller's own employeeDevice rows.
route("attendance.myDevices.list", {
  handler: async (ctx) => {
    if (!ctx.employeeId) return { devices: [] }
    const devices = await db.employeeDevice.findMany({
      where: { vendorId: ctx.vendorId, employeeId: ctx.employeeId },
      orderBy: { enrolledAt: "desc" },
      select: { id: true, deviceId: true, label: true, platform: true, status: true, enrolledAt: true, approvedAt: true, lastSeenAt: true, revokedAt: true, revokeReason: true },
    })
    return { devices }
  },
})

// INTENTIONALLY_SELF_SCOPED (M-02): ESS device removal — the handler matches the row to ctx.employeeId before deleting.
route("attendance.myDevices.remove", {
  schema: S.byId,
  handler: async (ctx, p) => {
    if (!ctx.employeeId) throw new Deny("No employee profile linked to your account")
    const row = await db.employeeDevice.findFirst({ where: { id: p.id, vendorId: ctx.vendorId, employeeId: ctx.employeeId } })
    if (!row) throw new Deny("Device not found", 404)
    await db.employeeDevice.update({ where: { id: row.id }, data: { status: "REVOKED", revokedAt: new Date(), revokedBy: ctx.userId, revokeReason: "Removed by employee" } })
    await audit(ctx, "attendance.device.remove", "EmployeeDevice", row.id, `Employee removed their enrolled device ${row.deviceId}`)
    return { removed: true }
  },
})

// ---- admin side (attendance.edit; audited) ----
route("attendance.employeeDevices.list", {
  perm: ["attendance", "edit"],
  schema: S.employeeId,
  handler: async (ctx, p) => {
    await assertEmployeeVisible(ctx, p.employeeId)
    const devices = await db.employeeDevice.findMany({
      where: { vendorId: ctx.vendorId, employeeId: p.employeeId },
      orderBy: { enrolledAt: "desc" },
    })
    return { devices }
  },
})

route("attendance.employeeDevices.decide", {
  perm: ["attendance", "edit"],
  schema: S.deviceDecision,
  handler: async (ctx, p) => {
    const row = await db.employeeDevice.findFirst({ where: { id: p.id, vendorId: ctx.vendorId } })
    if (!row) throw new Deny("Device not found", 404)
    if (p.decision === "APPROVE") {
      if (row.status !== "PENDING") throw new Deny("Only PENDING devices can be approved", 400)
      await db.employeeDevice.update({ where: { id: row.id }, data: { status: "ACTIVE", approvedBy: ctx.userId, approvedAt: new Date() } })
    } else {
      await db.employeeDevice.update({ where: { id: row.id }, data: { status: "REVOKED", revokedAt: new Date(), revokedBy: ctx.userId, revokeReason: p.reason ?? "Revoked by administrator" } })
    }
    await audit(ctx, p.decision === "APPROVE" ? "attendance.device.approve" : "attendance.device.revoke", "EmployeeDevice", row.id,
      `${p.decision === "APPROVE" ? "Approved" : "Revoked"} device ${row.deviceId} (${row.status} → ${p.decision === "APPROVE" ? "ACTIVE" : "REVOKED"})${p.reason ? ` — ${p.reason}` : ""}`)
    return { id: row.id, status: p.decision === "APPROVE" ? "ACTIVE" : "REVOKED" }
  },
})

// ================================================================ G3 — SELFIE CONSENT
// Explicit, versioned employee acknowledgment of the selfie-capture policy.
// A missing consent NEVER blocks a punch (see EmployeeConsent notes in
// schema.prisma) — it is surfaced to the employee (banner) and included in the
// punch response so HR follow-up has a hook.
// INTENTIONALLY_SELF_SCOPED (M-02): selfie-consent status — reads only the caller's own EmployeeConsent row.
route("attendance.consent.status", {
  handler: async (ctx) => {
    if (!ctx.employeeId) return { enabled: false, accepted: false }
    const settings = await getSettings(ctx.vendorId)
    const cfg = (settings as any).selfieConsent || { enabled: false, text: "", version: "" }
    if (!cfg.enabled) return { enabled: false, accepted: false }
    const row = await db.employeeConsent.findUnique({
      where: { vendorId_employeeId_purpose_version: { vendorId: ctx.vendorId, employeeId: ctx.employeeId, purpose: "SELFIE_ATTENDANCE", version: String(cfg.version || "1") } },
    })
    return {
      enabled: true,
      accepted: !!(row && !row.revokedAt),
      version: String(cfg.version || "1"),
      text: String(cfg.text || ""),
      acceptedAt: row?.acceptedAt ?? null,
    }
  },
})

// INTENTIONALLY_SELF_SCOPED (M-02): selfie-consent acceptance — writes only the caller's own EmployeeConsent row.
route("attendance.consent.accept", {
  schema: S.consentAccept,
  handler: async (ctx, p) => {
    if (!ctx.employeeId) throw new Deny("No employee profile linked to your account")
    const settings = await getSettings(ctx.vendorId)
    const cfg = (settings as any).selfieConsent || {}
    const version = p.version || String(cfg.version || "1")
    const text = String(cfg.text || "")
    const textHash = crypto.createHash("sha256").update(text).digest("hex")
    const row = await db.employeeConsent.upsert({
      where: { vendorId_employeeId_purpose_version: { vendorId: ctx.vendorId, employeeId: ctx.employeeId, purpose: "SELFIE_ATTENDANCE", version } },
      create: { vendorId: ctx.vendorId, employeeId: ctx.employeeId, purpose: "SELFIE_ATTENDANCE", version, textHash, source: "ESS_PORTAL", ip: ctx.ip ?? null, userAgent: p.userAgent?.slice(0, 200) ?? null },
      update: { textHash, acceptedAt: new Date(), revokedAt: null, revokedBy: null, ip: ctx.ip ?? null },
    })
    await audit(ctx, "attendance.consent.accept", "EmployeeConsent", row.id,
      `${ctx.userName} accepted the selfie attendance policy (version ${version})`)
    return { accepted: true, version, acceptedAt: row.acceptedAt }
  },
})

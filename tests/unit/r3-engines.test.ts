/// <reference types="bun-types" />
// ============ Phase R3 — attendance & leave engine regressions ============
// ATT-002  cross-midnight checkout resolves the previous day's open check-in
// ATT-003  overnight branch applies vendor policy (grace/early-leave/OT cap)
// ATT-004  device rebuild sets otApproved=false when approval is required
// ATT-005  geo-fence wrap-around windows (21:00–07:00) admit night punches
// ATT-006  a branch-specific holiday only suppresses that branch's sweep
// ATT-007  attendance.today resolves holiday per employee branch
// ATT-008  payroll OT tier resolves the per-date shift (rotating employees)
// ATT-009  OT register holiday tier is branch-aware
// ATT-010  mixed-employee overtime submissions are refused
// ATT-011  rosters.assign rejects foreign-tenant shift ids; resolveShift scopes by vendor
// LVE-101  weekend-only "half-day" requests are refused (zero working days)
// LVE-102  cancelling approved UNPAID leave removes LEAVE_UNPAID rows
// LVE-104  fiscal leave-year keying (a January request charges the prior-July row)
// LVE-105  carried days past carryForwardExpiryMonths stop counting
// LVE-106  PRO_RATA opening entitlement is joining-date prorated
// LVE-107  gender-restricted leave types gate at apply
import "./_testdb"
import { describe, test, expect, beforeAll } from "bun:test"
import { db } from "@/lib/db"
import { mkVendor, mkUser, mkEmployee, mkSession, makeCtx, uniq } from "./_fixtures"
import { postHrm } from "./_hrm-endpoint"
import { calcOvernight, isOvernight } from "@/hrm-server/overnight"
import { evaluateFence } from "@/hrm-server/geo"
import { leaveYearOf, spendableDays, proRatedEntitlement, carriedForwardSpendable } from "@/hrm-server/leave-math"
import { saveSettingsGroup } from "@/hrm-server/settings"


/** A minimal LEAVE approval workflow (single VENDOR_OWNER step) so
 *  leaveRequests.apply can enter the approval engine. */
async function mkLeaveWorkflow(vendorId: string) {
  const wf = await db.approvalWorkflow.create({ data: { vendorId, name: `R3 LEAVE ${uniq()}`, processType: "LEAVE", active: true } })
  await db.approvalStep.create({ data: { vendorId, workflowId: wf.id, sequence: 1, name: "Owner Approval", approverRole: "VENDOR_OWNER", required: true, rejectBehavior: "REJECT_ALL", departmentScope: false, branchScope: false, amountThreshold: null, allowDelegation: false } })
  return wf.id
}

// ---------------------------------------------------------------- ATT-002 --
describe("ATT-002 — cross-midnight checkout", () => {
  let vendor: { id: string }
  let owner: { id: string }
  let token: string

  beforeAll(async () => {
    vendor = await mkVendor("ATT002 Vendor")
    owner = await mkUser(vendor.id, { role: "VENDOR_OWNER", name: "ATT002 Owner" })
    token = await mkSession(owner.id, "FULL")
  })

  test("an employee who checked in yesterday and works past midnight can check out after 00:00", async () => {
    const emp = await mkEmployee(vendor.id, { fullName: "ATT002 Nightowl" })
    // a method policy that permits no-GPS self check-out (the L-13 pattern)
    const pol = await db.attendancePolicy.create({
      data: { vendorId: vendor.id, name: `ATT002 Method ${uniq()}`,
        policyType: "ATTENDANCE_METHOD", active: true,
        daysOfWeek: "SUNDAY,MONDAY,TUESDAY,WEDNESDAY,THURSDAY,FRIDAY,SATURDAY",
        configJson: JSON.stringify({ methods: ["SELFIE"], selfieRequired: false, requireGeofence: false }) } as any,
    })
    await db.attendancePolicyAssignment.create({
      data: { vendorId: vendor.id, policyId: pol.id, scopeType: "ALL_EMPLOYEES", scopeId: null },
    })
    // yesterday (Dhaka-aware, the same clock the app uses): checked in at
    // 22:00, never checked out
    const { today: appToday, addDays: appAddDays } = await import("@/hrm-server/utils")
    const yester = appAddDays(appToday(), -1)
    await db.attendance.create({
      data: { vendorId: vendor.id, employeeId: emp.id, date: yester, checkIn: "22:00", checkOut: null, status: "PRESENT", source: "MANUAL" },
    })
    const r = await postHrm("attendance.selfCheckout", {}, { bearer: await mkSession((await mkUser(vendor.id, { role: "EMPLOYEE", name: "ATT002 Self", employeeId: emp.id })).id, "FULL") })
    expect(r.status).toBe(200)
    const rows = await db.attendance.findMany({ where: { vendorId: vendor.id, employeeId: emp.id } })
    const closed = rows.find((x) => x.date === yester)
    expect(closed?.checkOut).toBeTruthy() // the PREVIOUS day's row is closed
    expect(String(closed?.remarks || "")).toContain("Cross-midnight")
    // no phantom row was created for the app's (Dhaka) today
    expect(rows.find((x) => x.date === appToday())).toBeFalsy()
  })
})

// ---------------------------------------------------------------- ATT-003 --
describe("ATT-003 — overnight branch applies vendor policy", () => {
  // graceMinutes deliberately ABSENT on the shift: the day-branch precedence
  // is shift ?? policy ?? default, and a real shift row always carries its own
  // value — the vendor policy fills in when the shift does not define one.
  const nightShift = { startTime: "22:00", endTime: "06:00", breakMinutes: 0, minWorkingHours: 8, otThresholdMinutes: 30 } as any

  test("vendor grace applies on the overnight branch (was a hardcoded 10)", () => {
    // in at 22:20 with a 30-minute vendor grace → NOT late (old: LATE by 10m)
    const r = calcOvernight(nightShift, "22:20", "06:00", { graceMinutes: 30 })
    expect(r.lateMinutes).toBe(0)
    expect(r.status).not.toBe("LATE")
    // in at 22:50 → 20 minutes late past the grace
    const late = calcOvernight(nightShift, "22:50", "06:00", { graceMinutes: 30 })
    expect(late.lateMinutes).toBe(20)
  })

  test("an explicit shift grace still wins (day-branch precedence parity)", () => {
    const shiftGrace5 = { ...nightShift, graceMinutes: 5 }
    expect(calcOvernight(shiftGrace5, "22:20", "06:00", { graceMinutes: 30 }).lateMinutes).toBe(15)
  })

  test("the statutory daily OT cap applies on the overnight branch too", () => {
    // out at 08:30 → 150 raw OT minutes; capped at 120 (2h) like the day branch
    const r = calcOvernight(nightShift, "22:00", "08:30", { maxOtMinutesPerDay: 120 })
    expect(r.overtimeMinutes).toBe(120)
  })

  test("without policy the historical defaults hold (10m grace)", () => {
    const r = calcOvernight(nightShift, "22:05", "06:00")
    expect(r.lateMinutes).toBe(0)
    expect(isOvernight(nightShift)).toBe(true)
  })
})

// ---------------------------------------------------------------- ATT-004 --
describe("ATT-004 — device rebuild sets otApproved under the approval policy", () => {
  test("rebuildDaily marks OT unapproved when approval is required (was null → paid as approved)", async () => {
    const vendor = await mkVendor("ATT004 Vendor")
    const emp = await mkEmployee(vendor.id, { fullName: "ATT004 Worker" })
    const shift = await db.shift.create({
      data: { vendorId: vendor.id, name: `ATT004 Day ${uniq()}`, type: "FIXED", startTime: "09:00", endTime: "18:00",
        graceMinutes: 0, breakMinutes: 0, minWorkingHours: 8, otThresholdMinutes: 30, weeklyOff: "FRIDAY" } as any,
    })
    await db.employee.update({ where: { id: emp.id }, data: { shiftId: shift.id } })
    // approval REQUIRED
    await saveSettingsGroup(vendor.id, "shift", { otApprovalRequired: true } as any)
    const device = await db.attendanceDevice.create({
      data: { vendorId: vendor.id, name: "ATT004 Device", manufacturer: "ZKTeco", protocol: "ADMS", deviceIdentifier: uniq("SN"), serialNumber: uniq("SN"), deviceId: uniq("zk"), timezone: "Asia/Dhaka", enabled: true, status: "ACTIVE" } as any,
    })
    const { rebuildDaily } = await import("@/hrm-server/zkteco/processor")
    const date = new Date().toISOString().slice(0, 10)
    // in 09:00 out 21:00 → 2h OT (raw events pre-attributed to the employee)
    for (const [t, ty] of [[`${date} 09:00:00`, "IN"], [`${date} 21:00:00`, "OUT"]] as const) {
      await db.attendanceRawEvent.create({
        data: { vendorId: vendor.id, deviceId: device.id, deviceSerial: device.deviceIdentifier || "SN",
          deviceUserId: "1", employeeId: emp.id, eventTime: t, eventType: ty,
          rawLine: `1\t${t}\t1\t0\t${ty === "IN" ? 0 : 1}\t0`,
          payloadHash: uniq("fp"), processingStatus: "RECEIVED" } as any,
      })
    }
    await rebuildDaily(vendor.id, emp.id, date)
    const row = await db.attendance.findFirst({ where: { vendorId: vendor.id, employeeId: emp.id, date } })
    expect(row).toBeTruthy()
    expect(row!.overtimeMinutes).toBeGreaterThan(0)
    expect(row!.otApproved).toBe(false) // ← the ATT-004 regression (was null)
  })
})

// ---------------------------------------------------------------- ATT-005 --
describe("ATT-005 — geo-fence wrap-around windows", () => {
  const fence = (over: any) => ({ id: "f", name: "Night fence", latitude: 23.8, longitude: 90.4, radiusM: 200, active: true, ...over }) as any
  const inside = { latitude: 23.8, longitude: 90.4, accuracyM: 10 }

  // fence windows evaluate in Asia/Dhaka (+6): pass UTC instants that map to
  // the intended LOCAL wall-clock hour
  const atLocal = (h: number) => new Date(Date.UTC(2026, 9, 21, (h + 18) % 24, 0, 0))

  test("a 21:00–07:00 fence admits a 23:00 punch AND a 03:00 punch (was: rejected every minute)", () => {
    const f = fence({ startTime: "21:00", endTime: "07:00" })
    const night = evaluateFence(f, inside.latitude, inside.longitude, inside.accuracyM, { now: atLocal(23) })
    expect(night.ok).toBe(true)
    const small = evaluateFence(f, inside.latitude, inside.longitude, inside.accuracyM, { now: atLocal(3) })
    expect(small.ok).toBe(true)
    // outside the wrap: a 12:00-local punch is still rejected
    const noon = evaluateFence(f, inside.latitude, inside.longitude, inside.accuracyM, { now: atLocal(12) })
    expect(noon.ok).toBe(false)
  })

  test("same-day windows keep their exact semantics (09:00–17:00)", () => {
    const f = fence({ startTime: "09:00", endTime: "17:00" })
    expect(evaluateFence(f, inside.latitude, inside.longitude, inside.accuracyM, { now: atLocal(10) }).ok).toBe(true)
    expect(evaluateFence(f, inside.latitude, inside.longitude, inside.accuracyM, { now: atLocal(20) }).ok).toBe(false)
  })
})

// ---------------------------------------------------------------- ATT-006 --
describe("ATT-006 — branch-specific holiday only suppresses that branch's absent sweep", () => {
  test("the sweep's holiday check is per-employee branch (unit: shared predicate)", async () => {
    // drive the real sweep: vendor with two branches, a branch-A-only holiday
    // yesterday, and employees in both branches with no attendance
    const vendor = await mkVendor("ATT006 Vendor")
    // notify({ role: "HR_ADMIN" }) delivers per matching user — one must exist
    await mkUser(vendor.id, { role: "HR_ADMIN", name: "ATT006 HR" })
    const branchA = await db.branch.create({ data: { vendorId: vendor.id, code: uniq("A"), name: "ATT006 A", type: "OFFICE", active: true } })
    const branchB = await db.branch.create({ data: { vendorId: vendor.id, code: uniq("B"), name: "ATT006 B", type: "OFFICE", active: true } })
    const { today: appToday6, addDays: appAddDays6 } = await import("@/hrm-server/utils")
    const yesterday = appAddDays6(appToday6(), -1)
    await db.holiday.create({ data: { vendorId: vendor.id, name: "ATT006 Branch A Day", date: yesterday, type: "PUBLIC", branchId: branchA.id } })
    const empA = await mkEmployee(vendor.id, { fullName: "ATT006 A Emp" })
    const empB = await mkEmployee(vendor.id, { fullName: "ATT006 B Emp" })
    await db.employee.update({ where: { id: empA.id }, data: { branchId: branchA.id } })
    await db.employee.update({ where: { id: empB.id }, data: { branchId: branchB.id } })

    // the sweep's notification is the observable: run the exported job
    const { sweepAttendanceAlerts } = await import("@/hrm-server/jobs")
    const { getSettings } = await import("@/hrm-server/settings")
    // De-flake (M5, 2026-10-31): DEFAULT_SETTINGS.general.weeklyHoliday is
    // ["FRIDAY"] (BD convention) — when "yesterday" lands on the weekly off
    // the sweep skips EVERYONE and this test fails for calendar reasons only
    // (reproduced on Sat 2026-10-31; identical failure at the pre-M5 baseline
    // 86ef368, and hosted CI passed on Fri only because Thursday preceded it).
    // Neutralize the weekly-off so the BRANCH-HOLIDAY logic is what's tested.
    const st = await getSettings(vendor.id)
    const hermetic = { ...st, general: { ...st.general, weeklyHoliday: [] as string[] } }
    await (sweepAttendanceAlerts as any)(vendor.id, appToday6(), hermetic)
    const notes = await db.notification.findMany({
      where: { vendorId: vendor.id, title: "Attendance Alert", createdAt: { gte: new Date(Date.now() - 60000) } },
      orderBy: { createdAt: "desc" },
    })
    expect(notes.length).toBeGreaterThanOrEqual(1)
    const body = (notes[0] as any)?.message || (notes[0] as any)?.body || ""
    // branch B's employee IS alerted (the old code suppressed the whole tenant)
    expect(body).toContain("ATT006 B Emp")
    // branch A's employee is NOT (their branch had the holiday)
    expect(body).not.toContain("ATT006 A Emp")
  })
})

// ---------------------------------------------------------------- ATT-007 --
describe("ATT-007 — attendance.today resolves holiday per employee branch", () => {
  test("a branch-specific holiday paints only that branch's rows HOLIDAY", async () => {
    const vendor = await mkVendor("ATT007 Vendor")
    const owner = await mkUser(vendor.id, { role: "VENDOR_OWNER", name: "ATT007 Owner" })
    const token = await mkSession(owner.id, "FULL")
    const branchA = await db.branch.create({ data: { vendorId: vendor.id, code: uniq("A"), name: "ATT007 A", type: "OFFICE", active: true } })
    const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10)
    await db.holiday.create({ data: { vendorId: vendor.id, name: "ATT007 Branch Day", date: tomorrow, type: "PUBLIC", branchId: branchA.id } })
    const empA = await mkEmployee(vendor.id, { fullName: "ATT007 A Emp" })
    const empB = await mkEmployee(vendor.id, { fullName: "ATT007 B Emp" })
    await db.employee.update({ where: { id: empA.id }, data: { branchId: branchA.id } })
    const r = await postHrm("attendance.today", { date: tomorrow }, { bearer: token })
    expect(r.status).toBe(200)
    const rows = r.body.data as any[]
    const a = rows.find((x) => x.employeeId === empA.id)
    const b = rows.find((x) => x.employeeId === empB.id)
    expect(a?.impliedStatus).toBe("HOLIDAY")   // covered branch
    expect(b?.impliedStatus).toBeNull()        // other branch: a normal day
  })
})

// ---------------------------------------------------------------- ATT-008 --
describe("ATT-008 — payroll OT tier resolves the per-date shift", () => {
  test("a rotating employee's Friday-off shift does not leak into their weekday shift days", async () => {
    const vendor = await mkVendor("ATT008 Vendor")
    const owner = await mkUser(vendor.id, { role: "VENDOR_OWNER", name: "ATT008 Owner" })
    const ctx = makeCtx(owner, ["*"])
    const emp = await mkEmployee(vendor.id, { fullName: "ATT008 Rotator" })
    // day shift (general, no weekly off) + weekend shift (Friday off) —
    // the employee rotates ONTO the Friday-off shift only for July 2026
    const dayShift = await db.shift.create({ data: { vendorId: vendor.id, name: `ATT008 Day ${uniq()}`, type: "FIXED", startTime: "09:00", endTime: "18:00", graceMinutes: 0, breakMinutes: 0, minWorkingHours: 8, otThresholdMinutes: 30, weeklyOff: "", otMultiplier: 1.5 } as any })
    const friShift = await db.shift.create({ data: { vendorId: vendor.id, name: `ATT008 Fri ${uniq()}`, type: "FIXED", startTime: "09:00", endTime: "18:00", graceMinutes: 0, breakMinutes: 0, minWorkingHours: 8, otThresholdMinutes: 30, weeklyOff: "FRIDAY", otMultiplier: 1.5 } as any })
    // July 2026: on the Friday-off shift the WHOLE month (covers all test days)
    await db.shiftAssignment.create({ data: { vendorId: vendor.id, employeeId: emp.id, shiftId: friShift.id, fromDate: "2026-07-01", toDate: null } })
    await db.salaryStructure.create({ data: { vendorId: vendor.id, employeeId: emp.id, effectiveFrom: "2026-01-01", status: "ACTIVE", basic: 20800, gross: 20800 } })
    // OT on a WEDNESDAY (2026-07-08): under the Friday-off shift assignment
    await db.attendance.create({ data: { vendorId: vendor.id, employeeId: emp.id, date: "2026-07-08", status: "PRESENT", checkIn: "09:00", checkOut: "20:00", overtimeMinutes: 120, otApproved: true } })
    const run = await db.payrollRun.create({ data: { vendorId: vendor.id, periodMonth: 7, periodYear: 2026, periodWeek: 0, frequency: "MONTHLY", runType: "REGULAR", status: "DRAFT", createdBy: owner.id } })
    const { calculateRun } = await import("@/hrm-server/payroll")
    await calculateRun(ctx, run.id)
    const entry = await db.payrollEntry.findFirst({ where: { runId: run.id, employeeId: emp.id } })
    expect(entry).toBeTruthy()
    const bd = JSON.parse(entry!.breakdownJson || "{}")
    // 120 weekday minutes × 1.5 × (20800/208/60 per min) = 300
    expect(bd.otTiers?.weekday).toBe(120)
    expect(Number(entry!.otAmountPaisa)).toBe(30000)
  })
})

// ---------------------------------------------------------------- ATT-009 --
describe("ATT-009 — OT register holiday tier is branch-aware", () => {
  test("a branch holiday tiers only that branch's employees", async () => {
    const vendor = await mkVendor("ATT009 Vendor")
    const owner = await mkUser(vendor.id, { role: "VENDOR_OWNER", name: "ATT009 Owner" })
    const token = await mkSession(owner.id, "FULL")
    const branchA = await db.branch.create({ data: { vendorId: vendor.id, code: uniq("A"), name: "ATT009 A", type: "OFFICE", active: true } })
    await db.holiday.create({ data: { vendorId: vendor.id, name: "ATT009 Branch Day", date: "2026-07-05", type: "PUBLIC", branchId: branchA.id } })
    const empA = await mkEmployee(vendor.id, { fullName: "ATT009 A Emp" })
    const empB = await mkEmployee(vendor.id, { fullName: "ATT009 B Emp" })
    await db.employee.update({ where: { id: empA.id }, data: { branchId: branchA.id } })
    // 2026-07-05 is a SUNDAY (weekday tier without the holiday)
    for (const e of [empA, empB]) {
      await db.attendance.create({ data: { vendorId: vendor.id, employeeId: e.id, date: "2026-07-05", status: "PRESENT", checkIn: "09:00", checkOut: "20:00", overtimeMinutes: 60, otApproved: true } })
    }
    const r = await postHrm("overtime.list", { month: "2026-07" }, { bearer: token })
    expect(r.status).toBe(200)
    const rows = (r.body.data as any).rows as any[]
    const a = rows.find((x) => x.employeeId === empA.id)
    const b = rows.find((x) => x.employeeId === empB.id)
    expect(a?.tier).toBe("holiday")   // their branch's holiday
    expect(b?.tier).toBe("weekday")   // other branch: a normal Sunday
  })
})

// ---------------------------------------------------------------- ATT-010 --
describe("ATT-010 — mixed-employee overtime submissions are refused", () => {
  test("one approval can never flip two employees' OT flags", async () => {
    const vendor = await mkVendor("ATT010 Vendor")
    const owner = await mkUser(vendor.id, { role: "VENDOR_OWNER", name: "ATT010 Owner" })
    const token = await mkSession(owner.id, "FULL")
    const e1 = await mkEmployee(vendor.id, { fullName: "ATT010 One" })
    const e2 = await mkEmployee(vendor.id, { fullName: "ATT010 Two" })
    const r1 = await db.attendance.create({ data: { vendorId: vendor.id, employeeId: e1.id, date: "2026-07-01", status: "PRESENT", overtimeMinutes: 60 } })
    const r2 = await db.attendance.create({ data: { vendorId: vendor.id, employeeId: e2.id, date: "2026-07-01", status: "PRESENT", overtimeMinutes: 90 } })
    const r = await postHrm("overtime.submit", { ids: [r1.id, r2.id] }, { bearer: token })
    expect(r.status).toBe(403)
    expect(String(r.body?.error || "")).toContain("separately")
    // neither row was touched
    const after1 = await db.attendance.findUnique({ where: { id: r1.id } })
    expect(after1!.otApproved).toBeNull()
  })
})

// ---------------------------------------------------------------- ATT-011 --
describe("ATT-011 — shift references are vendor-scoped", () => {
  test("rosters.assign rejects a foreign-tenant shift id", async () => {
    const vendorA = await mkVendor("ATT011 A")
    const vendorB = await mkVendor("ATT011 B")
    const ownerA = await mkUser(vendorA.id, { role: "VENDOR_OWNER", name: "ATT011 Owner A" })
    const tokenA = await mkSession(ownerA.id, "FULL")
    const empA = await mkEmployee(vendorA.id, { fullName: "ATT011 Emp" })
    const foreignShift = await db.shift.create({
      data: { vendorId: vendorB.id, name: `ATT011 Foreign ${uniq()}`, type: "FIXED", startTime: "09:00", endTime: "17:00", graceMinutes: 0, breakMinutes: 0, minWorkingHours: 8, otThresholdMinutes: 30, weeklyOff: "FRIDAY" } as any,
    })
    const r = await postHrm("rosters.assign", { employeeId: empA.id, shiftId: foreignShift.id, fromDate: "2026-07-01" }, { bearer: tokenA })
    expect(r.status).toBe(404)
    expect(String(r.body?.error || "")).toContain("this organization")
  })
})

// ---------------------------------------------------------------- LVE-101 --
describe("LVE-101 — weekend-only half-day requests are refused", () => {
  test("a Friday-only half-day (zero working days) is denied, not floored to 0.5", async () => {
    const vendor = await mkVendor("LVE101 Vendor")
    const owner = await mkUser(vendor.id, { role: "VENDOR_OWNER", name: "LVE101 Owner" })
    const token = await mkSession(owner.id, "FULL")
    const emp = await mkEmployee(vendor.id, { fullName: "LVE101 Emp" })
    await db.employee.update({ where: { id: emp.id }, data: { weeklyOff: "FRIDAY,SATURDAY,SUNDAY" } })
    const type = await db.leaveType.create({ data: { vendorId: vendor.id, code: uniq("LVE101"), name: "Casual LVE101", paid: true, defaultDays: 10, probationEligible: true } })
    // Nov 7–8 2026 is a Sat–Sun span — zero working days under the employee's
    // own weekly-off; the old half-day floor used to pass it as 0.5 days
    const r = await postHrm("leaveRequests.apply", { employeeId: emp.id, leaveTypeId: type.id, fromDate: "2026-11-07", toDate: "2026-11-08", halfDay: true }, { bearer: token })
    expect(r.status).toBe(403)
    expect(String(r.body?.error || "")).toContain("zero working days")
  })
})

// ---------------------------------------------------------------- LVE-102 --
describe("LVE-102 — cancelling approved UNPAID leave removes LEAVE_UNPAID rows", () => {
  test("cancel restores the day to a normal unworked day (no phantom unpaid absence)", async () => {
    const vendor = await mkVendor("LVE102 Vendor")
    const owner = await mkUser(vendor.id, { role: "VENDOR_OWNER", name: "LVE102 Owner" })
    const token = await mkSession(owner.id, "FULL")
    const emp = await mkEmployee(vendor.id, { fullName: "LVE102 Emp" })
    await mkLeaveWorkflow(vendor.id)
    const unpaidType = await db.leaveType.create({ data: { vendorId: vendor.id, code: uniq("LVE102"), name: "Unpaid LVE102", paid: false, defaultDays: 15, probationEligible: true } })
    // a Wednesday in late 2026 (Dec 2)
    const r = await postHrm("leaveRequests.apply", { employeeId: emp.id, leaveTypeId: unpaidType.id, fromDate: "2026-12-02", toDate: "2026-12-02" }, { bearer: token })
    expect(r.status).toBe(200)
    const reqId = r.body.data.id
    // approve via the direct finalize hook (no workflow needed)
    const { applyLeaveDecision } = await import("@/hrm-server/routes/leave")
    await applyLeaveDecision({ userId: owner.id, userName: "LVE102 Owner", vendorId: vendor.id }, reqId, "APPROVED")
    const row = await db.attendance.findFirst({ where: { vendorId: vendor.id, employeeId: emp.id, date: "2026-12-02" } })
    expect(row?.status).toBe("LEAVE_UNPAID")
    // cancel the approved request
    const c = await postHrm("leaveRequests.cancel", { id: reqId }, { bearer: token })
    expect(c.status).toBe(200)
    const after = await db.attendance.findFirst({ where: { vendorId: vendor.id, employeeId: emp.id, date: "2026-12-02" } })
    // the LEAVE_UNPAID row is gone (synthetic, no punches) — payroll no longer
    // treats the day as unpaid absence (was: row stayed forever)
    expect(after?.status).not.toBe("LEAVE_UNPAID")
  })
})

// ---------------------------------------------------------------- LVE-104 --
describe("LVE-104 — one fiscal leave-year keying (pure helpers)", () => {
  test("a January request belongs to the leave year that started the previous July", () => {
    expect(leaveYearOf("2027-01-15", 6)).toBe(2026) // FY starts July
    expect(leaveYearOf("2026-12-31", 6)).toBe(2026)
    expect(leaveYearOf("2026-07-01", 6)).toBe(2026)
    expect(leaveYearOf("2026-06-30", 6)).toBe(2025)
    // a January fiscal start keys cleanly too
    expect(leaveYearOf("2026-06-30", 0)).toBe(2026)
    expect(leaveYearOf("2026-01-01", 0)).toBe(2026)
  })

  test("spendableDays on a January row counts the July carry (same leave year)", () => {
    // leave year 2026 (Jul 2026–Jun 2027): 10 entitled + 5 carried − 2 used
    const bal = { year: 2026, entitled: 10, carriedForward: 5, used: 2, pending: 0 }
    // any date inside the leave year sees the carry (expiry 0 = never)
    expect(spendableDays(bal, { asOf: "2027-01-10", fyStartMonth: 6, carryForwardExpiryMonths: 0 })).toBe(13)
  })
})

// ---------------------------------------------------------------- LVE-105 --
describe("LVE-105 — carried days past carryForwardExpiryMonths stop counting", () => {
  test("expiry window math on the fiscal-year axis", () => {
    // carry landed 2026-07-01, expires after 3 months → 2026-10-01
    expect(carriedForwardSpendable(5, 2026, 6, 3, "2026-09-30")).toBe(5)
    expect(carriedForwardSpendable(5, 2026, 6, 3, "2026-10-02")).toBe(0)
    // 0 = never expires
    expect(carriedForwardSpendable(5, 2026, 6, 0, "2030-01-01")).toBe(5)
    // a January fiscal start shifts the landing date
    expect(carriedForwardSpendable(5, 2027, 0, 2, "2027-02-28")).toBe(5)
    expect(carriedForwardSpendable(5, 2027, 0, 2, "2027-03-02")).toBe(0)
  })
})

// ---------------------------------------------------------------- LVE-106 --
describe("LVE-106 — PRO_RATA entitlement accrues by months of service", () => {
  test("a November joiner (July FY) earns by whole calendar months of service, never the full quota", () => {
    // leave year 2026 = Jul 2026–Jun 2027; joined 2026-11-10.
    // The helper counts whole calendar months from the join month to asOf:
    // a mid-November joiner has 0 complete months inside November itself and
    // earns 1/12 once December starts (the joining month counts from the NEXT
    // month boundary — no free quota on day one).
    expect(proRatedEntitlement(20, "2026-11-10", 2026, 6, "2026-11-15")).toBe(0)  // joining month itself
    expect(proRatedEntitlement(20, "2026-11-10", 2026, 6, "2026-12-15")).toBe(1.67) // Dec: 1 whole month (20/12, 2-dp)
    expect(proRatedEntitlement(20, "2026-11-10", 2026, 6, "2027-01-20")).toBe(3.33) // Dec+Jan (40/12, 2-dp)
    // the joining month itself never earns (even joining on the 1st): the
    // first whole month of service completes only when the NEXT month starts
    expect(proRatedEntitlement(20, "2026-12-01", 2026, 6, "2026-12-15")).toBe(0)
    // the full quota is reached only once 12 month-starts of the leave year
    // elapsed (July 2026 → July 2027); May 2027 = 10, June = 11, July = 12
    expect(proRatedEntitlement(20, "2020-01-01", 2026, 6, "2027-05-30")).toBe(16.67)
    expect(proRatedEntitlement(20, "2020-01-01", 2026, 6, "2027-06-30")).toBe(18.33)
    expect(proRatedEntitlement(20, "2020-01-01", 2026, 6, "2027-07-02")).toBe(20)
    // before joining: zero
    expect(proRatedEntitlement(20, "2026-11-10", 2026, 6, "2026-08-01")).toBe(0)
  })
})

// ---------------------------------------------------------------- LVE-107 --
describe("LVE-107 — gender-restricted leave types gate at apply", () => {
  test("maternity (FEMALE-only) is refused for a male employee, allowed for female", async () => {
    const vendor = await mkVendor("LVE107 Vendor")
    const owner = await mkUser(vendor.id, { role: "VENDOR_OWNER", name: "LVE107 Owner" })
    const token = await mkSession(owner.id, "FULL")
    const male = await db.employee.create({ data: { vendorId: vendor.id, fullName: "LVE107 Male", code: uniq("M"), joiningDate: "2020-01-01", employmentType: "PERMANENT", status: "ACTIVE", gender: "MALE" } })
    const female = await db.employee.create({ data: { vendorId: vendor.id, fullName: "LVE107 Female", code: uniq("F"), joiningDate: "2020-01-01", employmentType: "PERMANENT", status: "ACTIVE", gender: "FEMALE" } })
    await mkLeaveWorkflow(vendor.id)
    const maternity = await db.leaveType.create({ data: { vendorId: vendor.id, code: uniq("MAT"), name: "Maternity LVE107", paid: true, defaultDays: 112, probationEligible: true, genderRestriction: "FEMALE" } })
    const denied = await postHrm("leaveRequests.apply", { employeeId: male.id, leaveTypeId: maternity.id, fromDate: "2026-12-02", toDate: "2026-12-03" }, { bearer: token })
    expect(denied.status).toBe(403)
    expect(String(denied.body?.error || "")).toContain("female")
    const ok = await postHrm("leaveRequests.apply", { employeeId: female.id, leaveTypeId: maternity.id, fromDate: "2026-12-02", toDate: "2026-12-03" }, { bearer: token })
    expect(ok.status).toBe(200)
  })
})

/// <reference types="bun-types" />
// ============ Phase 3 attendance regressions (FIN-035 / FIN-036 / FIN-050 / FIN-052) ============
// FIN-035 — comp-off accrual keyed the balance by CALENDAR year while apply/
//   cancel charge the FISCAL leave year: with the default July FY start, comp-off
//   earned from June holiday OT landed on year=2026 while taking a June day
//   charged year=2025 → "Insufficient balance" with the credited days stranded.
//   Fix: leaveYearOf() on BOTH the accrual and the spend side.
// FIN-036 — a late ZKTeco device backfill rewrote attendance inside PAID payroll
//   periods with no audit trace (unlike the manual override path). Fix: the same
//   attendance.paidPeriodOverride audit row (source DEVICE, run id, before/after)
//   + the paidPeriodRewrites reconciliation report.
// FIN-050 — policyWindowOpen mixed a UTC date + UTC weekday with an Asia/Dhaka
//   wall clock: fences/policies closed on the wrong day near midnight (six hours
//   of every day, UTC+6). Fix: one clock — localDateParts + localMinutes.
// FIN-052 — attendance.mark accepted unvalidated punch strings ('25:99' → 1599
//   minutes). Fix: HH:MM schema on the single mark path (same as bulk) +
//   timeToMinutes bounded to 0..1439.
import "./_testdb"
import { describe, test, expect } from "bun:test"
import { db } from "@/lib/db"
import { mkVendor, mkUser, mkEmployee, mkSession, uniq, defaultCompanyId } from "./_fixtures"
import { postHrm } from "./_hrm-endpoint"
import { leaveYearOf } from "@/hrm-server/leave-math"
import { policyWindowOpen } from "@/hrm-server/geo"
import { timeToMinutes } from "@/hrm-server/utils"
import { rebuildDaily } from "@/hrm-server/zkteco/processor"

// ---------- FIN-050 (pure) ----------
describe("FIN-050 — policyWindowOpen runs on ONE clock (Asia/Dhaka)", () => {
  const P = (over: Partial<Parameters<typeof policyWindowOpen>[0]> = {}) => ({
    startDate: null, endDate: null, daysOfWeek: null, policyStartTime: null, policyEndTime: null, ...over,
  })

  test("2026-07-06T17:30Z is Monday 23:30 in Dhaka — a Monday-only 22:00–23:59 policy is OPEN", () => {
    // OLD behavior: UTC date 2026-07-06 is a Monday too… so pick the boundary
    // where they DISAGREE: 2026-07-07T00:30Z is Tuesday 06:30 Dhaka but still
    // Monday July 6 in UTC. A MONDAY-ONLY policy must be CLOSED at that instant.
    const mondayLateDhaka = new Date("2026-07-06T17:30:00Z") // Dhaka Mon 23:30
    expect(policyWindowOpen(P({ daysOfWeek: "MONDAY", policyStartTime: "22:00", policyEndTime: "23:59" }), mondayLateDhaka)).toBe(true)
  })

  test("2026-07-07T00:30Z is TUESDAY 06:30 Dhaka — a MONDAY-only policy is CLOSED (UTC said Monday)", () => {
    const utcMondayDhakaTuesday = new Date("2026-07-07T00:30:00Z")
    // Dhaka date = 2026-07-07 (Tuesday); UTC date = 2026-07-06 (Monday).
    // The old UTC weekday check kept this OPEN for a Monday-only policy.
    expect(policyWindowOpen(P({ daysOfWeek: "MONDAY" }), utcMondayDhakaTuesday)).toBe(false)
    // and the same instant IS open for a Tuesday policy (the honest answer)
    expect(policyWindowOpen(P({ daysOfWeek: "TUESDAY" }), utcMondayDhakaTuesday)).toBe(true)
  })

  test("date-range boundaries evaluate on the Dhaka calendar date", () => {
    // 2026-07-05T20:00Z is 2026-07-06 02:00 in Dhaka: a policy starting
    // 2026-07-06 is already active (the old UTC date said 07-05 → closed).
    const justPastMidnightDhaka = new Date("2026-07-05T20:00:00Z")
    expect(policyWindowOpen(P({ startDate: "2026-07-06" }), justPastMidnightDhaka)).toBe(true)
    expect(policyWindowOpen(P({ endDate: "2026-07-05" }), justPastMidnightDhaka)).toBe(false)
  })

  test("wrap-around windows and blank fields keep their semantics", () => {
    const night = new Date("2026-07-06T19:00:00Z") // Dhaka Tue 01:00
    expect(policyWindowOpen(P({ policyStartTime: "21:00", policyEndTime: "06:00" }), night)).toBe(true)
    expect(policyWindowOpen(P({ policyStartTime: "09:00", policyEndTime: "17:00" }), night)).toBe(false)
    expect(policyWindowOpen(P(), night)).toBe(true) // blank = unconstrained
  })
})

// ---------- FIN-052 (pure) ----------
describe("FIN-052 — timeToMinutes is strict and bounded", () => {
  test("impossible strings no longer mint phantom minutes", () => {
    expect(timeToMinutes("25:99")).toBe(0)        // was 1599
    expect(timeToMinutes("99:00")).toBe(0)        // clamped shape fails → 0
    expect(timeToMinutes("9:5")).toBe(0)           // two-digit minutes required
    expect(timeToMinutes("garbage")).toBe(0)
    expect(timeToMinutes("")).toBe(0)
    expect(timeToMinutes(null)).toBe(0)
  })
  test("valid times parse; the day is bounded to 0..1439", () => {
    expect(timeToMinutes("09:00")).toBe(540)
    expect(timeToMinutes("23:59")).toBe(1439)
    expect(timeToMinutes("23:59:30")).toBe(1439)   // seconds tolerated, ignored
    expect(timeToMinutes("0:00")).toBe(0)
  })
})

// ---------- FIN-035 / FIN-036 / FIN-052 route layer ----------
describe("FIN-035 — comp-off accrual uses the fiscal leave-year key", () => {
  test("June holiday OT accrues onto the leave year the June spend charges (July FY start)", async () => {
    const v = await mkVendor(uniq("fin035"))
    const u = await mkUser(v.id, { role: "VENDOR_OWNER", name: "FIN-035 Owner" })
    const emp = await mkEmployee(v.id, { fullName: "FIN-035 CompOff Earner" })
    const token = await mkSession(u.id, "FULL")
    // comp-off accrual enabled; fiscal year start stays the default July
    await db.hrSetting.create({ data: { vendorId: v.id, group: "attendance", key: "compOffEnabled", value: "true" } })
    await db.hrSetting.create({ data: { vendorId: v.id, group: "attendance", key: "compOffHoursPerDay", value: "8" } })
    // 2026-06-14 is a SUNDAY (weekly off under the default Sat–Sun weekend? the
    // default weeklyHoliday in settings is FRIDAY… make the day a holiday
    // instead so the accrual trigger is unambiguous)
    await db.holiday.create({ data: { companyId: await defaultCompanyId(v.id), vendorId: v.id, date: "2026-06-14", type: "PUBLIC", name: "FIN-035 fixture holiday" } })
    // an attendance record with 8h of OT on the holiday
    await db.attendance.create({
      data: { vendorId: v.id, employeeId: emp.id, date: "2026-06-14", status: "PRESENT", source: "MANUAL", overtimeMinutes: 480, otApproved: false },
    })
    const r = await postHrm("attendance.otApprove", { id: (await db.attendance.findFirst({ where: { vendorId: v.id, employeeId: emp.id, date: "2026-06-14" } }))!.id, decision: "APPROVE" }, { bearer: token })
    expect(r.status).toBe(200)

    // the accrual must land on leaveYearOf('2026-06-14', July start) = 2025 —
    // the same ledger row a June 2026 comp-off day CHARGES. The old calendar
    // keying created year=2026 and stranded the credit.
    const compType = await db.leaveType.findFirst({ where: { vendorId: v.id, code: "COMP_OFF" } })
    expect(compType).not.toBeNull()
    const bal2025 = await db.leaveBalance.findFirst({ where: { vendorId: v.id, employeeId: emp.id, leaveTypeId: compType!.id, year: 2025 } })
    const bal2026 = await db.leaveBalance.findFirst({ where: { vendorId: v.id, employeeId: emp.id, leaveTypeId: compType!.id, year: 2026 } })
    expect(bal2025?.entitled).toBe(1)   // 480m / 8h = 1 day, on the FISCAL year row
    expect(bal2026).toBeNull()          // ← the old code put it here
    // the spend side agrees by construction (shared leaveYearOf)
    expect(leaveYearOf("2026-06-14", 6)).toBe(2025)
    expect(leaveYearOf("2026-07-14", 6)).toBe(2026)
  })
})

describe("FIN-036 — device rebuilds inside PAID periods are audited, never silent", () => {
  async function deviceWorld(paid: boolean) {
    const v = await mkVendor(uniq("fin036"))
    const u = await mkUser(v.id, { role: "VENDOR_OWNER", name: "FIN-036 Owner" })
    const emp = await mkEmployee(v.id, { fullName: "FIN-036 Device Staff" })
    const device = await db.attendanceDevice.create({
      data: { companyId: await defaultCompanyId(v.id), vendorId: v.id, deviceId: uniq("DV"), name: "FIN-036 Terminal", deviceIdentifier: uniq("SN"), status: "ACTIVE", lastSeenAt: new Date() },
    })
    // raw events: IN 09:00, OUT 18:30 (wall clock "YYYY-MM-DD HH:MM:SS")
    for (const [t, evType] of [["2026-07-06 09:00:00", "IN"], ["2026-07-06 18:30:00", "OUT"]] as const) {
      await db.attendanceRawEvent.create({
        data: { vendorId: v.id, deviceId: device.id, deviceSerial: device.deviceIdentifier || device.deviceId, deviceUserId: "1", employeeId: emp.id, eventTime: t, eventType: evType, rawLine: `fixture ${t}`, payloadHash: uniq("ph") },
      })
    }
    // a PRE-EXISTING device row the rebuild will CHANGE (earlier rebuild with
    // different punches — BIOMETRIC source so the manual-row protection does
    // not skip the day; that protection has its own tests)
    await db.attendance.create({
      data: { vendorId: v.id, employeeId: emp.id, date: "2026-07-06", status: "PRESENT", source: "BIOMETRIC", checkIn: "10:00", checkOut: "17:00", workingMinutes: 420, remarks: "earlier rebuild (fixture)" },
    })
    if (paid) {
      const run = await db.payrollRun.create({
        data: { companyId: await defaultCompanyId(v.id), vendorId: v.id, periodMonth: 7, periodYear: 2026, periodWeek: 0, frequency: "MONTHLY", runType: "REGULAR", status: "DRAFT", createdBy: u.id },
      })
      await db.payrollRun.update({ where: { id: run.id }, data: { status: "PAID", paymentDate: new Date().toISOString() } })
    }
    return { v, emp }
  }

  test("a CHANGING rebuild under a PAID run writes the audited override row (source DEVICE, run id, before/after)", async () => {
    const { v, emp } = await deviceWorld(true)
    const out = await rebuildDaily(v.id, emp.id, "2026-07-06")
    expect(out.touched).toBe(true)
    const auditRow = await db.auditLog.findFirst({
      where: { vendorId: v.id, action: "attendance.paidPeriodOverride", userName: "ZKTeco Device Rebuild" },
    })
    expect(auditRow).not.toBeNull()
    expect(auditRow!.summary).toContain("Device rebuild rewrote attendance inside a PAID payroll period")
    expect(auditRow!.summary).toContain("adjustment run")
    const nv = JSON.parse(auditRow!.newValue || "{}")
    expect(nv.source).toBe("DEVICE")
    expect(nv.runId).toBeTruthy()
    expect(nv.before?.checkIn).toBe("10:00")
    expect(nv.after?.checkIn).toBe("09:00")
    expect(nv.after?.workingMinutes).not.toBe(nv.before?.workingMinutes) // the day genuinely changed
    // the row itself WAS rebuilt (device truth still lands — that is the
    // documented design; the audit is what was missing)
    const row = await db.attendance.findFirst({ where: { vendorId: v.id, employeeId: emp.id, date: "2026-07-06" } })
    expect(row!.source).toBe("BIOMETRIC")
  })

  test("an UNPAID period rebuild writes no override row (the gate only guards paid snapshots)", async () => {
    const { v, emp } = await deviceWorld(false)
    await rebuildDaily(v.id, emp.id, "2026-07-06")
    const auditRow = await db.auditLog.findFirst({
      where: { vendorId: v.id, action: "attendance.paidPeriodOverride", userName: "ZKTeco Device Rebuild" },
    })
    expect(auditRow).toBeNull()
  })

  test("an IDEMPOTENT re-run of the same day under a PAID run does not spam the audit trail", async () => {
    const { v, emp } = await deviceWorld(true)
    await rebuildDaily(v.id, emp.id, "2026-07-06")
    await rebuildDaily(v.id, emp.id, "2026-07-06")
    await rebuildDaily(v.id, emp.id, "2026-07-06")
    const count = await db.auditLog.count({
      where: { vendorId: v.id, action: "attendance.paidPeriodOverride", userName: "ZKTeco Device Rebuild" },
    })
    expect(count).toBe(1) // one CHANGING rewrite, zero noise for the identical re-runs
  })
})

describe("FIN-052 — attendance.mark validates punch times (route layer)", () => {
  test("'25:99' is rejected by the schema, not stored as 1599 minutes", async () => {
    const v = await mkVendor(uniq("fin052"))
    const u = await mkUser(v.id, { role: "VENDOR_OWNER", name: "FIN-052 Owner" })
    const emp = await mkEmployee(v.id, { fullName: "FIN-052 Marker" })
    const token = await mkSession(u.id, "FULL")
    const r = await postHrm("attendance.mark", {
      employeeId: emp.id, date: "2026-10-20", checkIn: "25:99", checkOut: "18:00",
    }, { bearer: token })
    expect(r.status).toBe(400)
    expect(String(r.body.error)).toMatch(/HH:MM/)
    const row = await db.attendance.findFirst({ where: { vendorId: v.id, employeeId: emp.id, date: "2026-10-20" } })
    expect(row).toBeNull()
  })

  test("a well-formed mark still works", async () => {
    const v = await mkVendor(uniq("fin052b"))
    const u = await mkUser(v.id, { role: "VENDOR_OWNER", name: "FIN-052 Owner B" })
    const emp = await mkEmployee(v.id, { fullName: "FIN-052 Marker B" })
    const token = await mkSession(u.id, "FULL")
    const r = await postHrm("attendance.mark", {
      employeeId: emp.id, date: "2026-10-20", checkIn: "09:00", checkOut: "17:30",
    }, { bearer: token })
    expect(r.status).toBe(200)
    const row = await db.attendance.findFirst({ where: { vendorId: v.id, employeeId: emp.id, date: "2026-10-20" } })
    expect(row!.workingMinutes).toBeGreaterThan(0)
    expect(row!.workingMinutes!).toBeLessThanOrEqual(1439)
  })
})

// Phase 2 WS3 — payroll & report scale fixes.
// SCL-5 payRun set-based prefetch + PF batch flush · SCL-10 register
// pagination + summary SQL aggregates · SCL-11 overview SQL aggregates.
import "./_testdb"
import { describe, expect, test } from "bun:test"
import { db } from "@/lib/db"
import { mkVendor, mkUser, mkEmployee, makeCtx, uniq } from "./_fixtures"
import { getRoute } from "@/hrm-server/routes/router"

function pad(n: number): string { return String(n).padStart(2, "0") }

async function seedMonth(vendorId: string, month: number, year: number) {
  // 3 employees × 4 days with mixed statuses + minutes
  const emps: string[] = []
  for (let i = 0; i < 3; i++) {
    const e = await db.employee.create({ data: { vendorId, code: uniq("WS3E"), fullName: `Ws3 Emp ${i}`, joiningDate: "2020-01-01" } })
    emps.push(e.id)
  }
  const statuses = ["PRESENT", "LATE", "ABSENT", "LEAVE"]
  const recs: { vendorId: string; employeeId: string; date: string; status: string; lateMinutes: number; workingMinutes: number; overtimeMinutes: number; otApproved: boolean | null }[] = []
  let day = 0
  for (const st of statuses) {
    for (const empId of emps) {
      day = day % 28
      recs.push({
        vendorId, employeeId: empId,
        date: `${year}-${pad(month)}-${pad(++day)}`,
        status: st,
        lateMinutes: st === "LATE" ? 20 : 0,
        workingMinutes: st === "PRESENT" ? 480 : st === "LATE" ? 460 : 0,
        overtimeMinutes: st === "PRESENT" ? 60 : 0,
        otApproved: st === "PRESENT" ? (day % 2 === 0 ? true : false) : null,
      })
    }
  }
  await db.attendance.createMany({ data: recs })
  return { emps, recs }
}

describe("SCL-10 attendance.summary — SQL aggregates preserve semantics", () => {
  test("status counts, OT approval rule, minute sums match the row-level truth", async () => {
    const v = await mkVendor()
    const now = new Date()
    const { recs } = await seedMonth(v.id, now.getMonth() + 1, now.getFullYear())
    const owner = await mkUser(v.id, { role: "VENDOR_OWNER" })
    const summary: any = await getRoute("attendance.summary")!.handler(makeCtx(owner), {
      month: now.getMonth() + 1, year: now.getFullYear(),
    })
    // ground truth computed from the seeded rows directly
    const truth = {
      count: recs.length,
      present: recs.filter((r) => ["PRESENT", "LATE", "EARLY_LEAVE", "WFH", "BUSINESS_TRIP"].includes(r.status)).length,
      absent: recs.filter((r) => r.status === "ABSENT").length,
      late: recs.filter((r) => r.status === "LATE").length,
      halfDay: recs.filter((r) => r.status === "HALF_DAY").length,
      leave: recs.filter((r) => r.status === "LEAVE").length,
      totalLateMinutes: recs.reduce((s, r) => s + r.lateMinutes, 0),
      totalWorkingMinutes: recs.reduce((s, r) => s + r.workingMinutes, 0),
    }
    expect(summary.count).toBe(truth.count)
    expect(summary.present).toBe(truth.present)
    expect(summary.absent).toBe(truth.absent)
    expect(summary.late).toBe(truth.late)
    expect(summary.halfDay).toBe(truth.halfDay)
    expect(summary.leave).toBe(truth.leave)
    expect(summary.totalLateMinutes).toBe(truth.totalLateMinutes)
    expect(summary.totalWorkingMinutes).toBe(truth.totalWorkingMinutes)
    // OT approval rule depends on the vendor's shift settings — assert BOTH
    // branches against the same ground truth the old reduce used
    const { getSettings } = await import("@/hrm-server/settings")
    const st = await getSettings(v.id)
    const expectOt = st.shift.otApprovalRequired
      ? recs.filter((r) => r.otApproved !== false).reduce((s, r) => s + r.overtimeMinutes, 0)
      : recs.reduce((s, r) => s + r.overtimeMinutes, 0)
    expect(summary.totalOvertimeMinutes).toBe(expectOt)
    const pending = recs.filter((r) => r.otApproved === false && r.overtimeMinutes > 0).length
    expect(summary.pendingOtApprovals).toBe(pending)
  })
})

describe("SCL-10 attendance.register — pagination + search + legacy mode", () => {
  test("paged mode returns bounded items + exact total; legacy mode returns the full array", async () => {
    const v = await mkVendor()
    const now = new Date()
    await seedMonth(v.id, now.getMonth() + 1, now.getFullYear())
    const owner = await mkUser(v.id, { role: "VENDOR_OWNER" })
    const ctx = makeCtx(owner)
    const base = { month: now.getMonth() + 1, year: now.getFullYear() }

    const legacy: any = await getRoute("attendance.register")!.handler(ctx, base)
    expect(Array.isArray(legacy)).toBe(true)
    expect(legacy.length).toBe(12)
    expect(legacy[0].employeeName).toBeTruthy()
    expect(legacy[0].employeeCode).toBeTruthy()

    const p1: any = await getRoute("attendance.register")!.handler(ctx, { ...base, page: 1, pageSize: 5 })
    expect(p1.items.length).toBe(5)
    expect(p1.total).toBe(12)
    expect(p1.page).toBe(1)
    expect(p1.pageSize).toBe(5)

    const p3: any = await getRoute("attendance.register")!.handler(ctx, { ...base, page: 3, pageSize: 5 })
    expect(p3.items.length).toBe(2)

    // ordering is stable (date asc, employeeId asc)
    expect(p1.items[0].date <= p1.items[4].date).toBe(true)
  })

  test("server-side search (q) filters by name and code", async () => {
    const v = await mkVendor()
    const now = new Date()
    await seedMonth(v.id, now.getMonth() + 1, now.getFullYear())
    const owner = await mkUser(v.id, { role: "VENDOR_OWNER" })
    const res: any = await getRoute("attendance.register")!.handler(makeCtx(owner), {
      month: now.getMonth() + 1, year: now.getFullYear(), q: "Ws3 Emp 1", pageSize: 50,
    })
    expect(res.total).toBe(4) // 4 days × 1 employee
    expect(res.items.every((r: any) => r.employeeName === "Ws3 Emp 1")).toBe(true)
  })
})

describe("SCL-11 reports.attendanceOverview — aggregate equivalence", () => {
  test("KPIs and trend from grouped queries match row-level truth", async () => {
    const v = await mkVendor()
    const now = new Date()
    const { emps } = await seedMonth(v.id, now.getMonth() + 1, now.getFullYear())
    const d = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-01`
    // a geofence check-in + a suspicious event on day 1
    await db.attendanceEvent.createMany({
      data: [
        { vendorId: v.id, employeeId: emps[0], eventType: "CHECK_IN", attendanceMethod: "GEOFENCE", occurredAt: new Date(`${d}T09:00:00Z`), status: "ACCEPTED", gpsStatus: "OK" },
        { vendorId: v.id, employeeId: emps[1], eventType: "CHECK_IN", attendanceMethod: "SELFIE", occurredAt: new Date(`${d}T10:00:00Z`), status: "SUSPICIOUS", locationIntegrityStatus: "MOCK_LOCATION" },
      ],
    })
    const owner = await mkUser(v.id, { role: "VENDOR_OWNER" })
    const from = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-01`
    const to = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-28`
    const res: any = await getRoute("reports.attendanceOverview")!.handler(makeCtx(owner), { from, to })

    // KPI truth: 12 attendance rows — 3 PRESENT, 3 LATE, 3 ABSENT, 3 LEAVE
    expect(res.kpis.totalEmployees).toBe(3)
    expect(res.kpis.present).toBe(6) // PRESENT + LATE
    expect(res.kpis.absent).toBe(3)
    expect(res.kpis.late).toBe(3)
    expect(res.kpis.onLeave).toBe(3)
    expect(res.kpis.geofenceAttendance).toBe(1)
    expect(res.kpis.selfieAttendance).toBe(1)
    expect(res.kpis.suspiciousEvents).toBe(1) // union of suspicious status + non-verified integrity — SAME row counted once
    expect(res.compliance.gpsOk).toBe(1)
    expect(res.methodDistribution.find((m: any) => m.name === "GEOFENCE")?.value).toBe(1)
    expect(res.integrityDistribution.find((m: any) => m.name === "MOCK LOCATION")?.value).toBe(1)
    // trend has an entry per distinct date with per-date counts
    const day1 = res.trend.find((t: any) => t.date === d)
    expect(day1).toBeTruthy()
    // trend "suspicious" is STATUS-based only (SUSPICIOUS/REVIEW_REQUIRED) —
    // exactly one of the two events; the integrity-flagged one shows up in
    // suspiciousEvents (the union KPI) and integrityDistribution instead
    expect(day1.suspicious).toBe(1)
    expect(Array.isArray(res.branchStats)).toBe(true)
    expect(Array.isArray(res.departmentStats)).toBe(true)
    expect(res.period).toEqual({ from, to })
  })
})

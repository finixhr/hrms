/// <reference types="bun-types" />
// ============ T-19 (2026-10-31) — Tenant-isolation negative tests, ESS plane ============
// The master plan (P1, T-19): "existing isolation tests cover HR routes; the
// ESS self-scope family (and new mobile traffic) deserves explicit negative
// coverage. Solution: cross-tenant/cross-employee denial tests for ess.* +
// tracking.status + geofence check-in actor resolution. Acceptance: tests
// prove vendor/employee scoping under adversarial payloads."
//
// Why this matters NOW: the mobile app drives the ESS plane directly
// (auth.login → ess.dashboard/attendance/leave/payroll + tracking.status +
// geofence/selfie punches). Every handler in routes/ess.ts derives the
// employee from the SESSION (requireSelf → ctx.employeeId) and scopes every
// query by ctx.vendorId — the payload can never name a target. These tests
// PROVE that at the real dispatcher boundary (POST /api/hrm) under
// adversarial payloads that try to name another employee / another tenant.
//
// Coverage map:
//   1. CROSS-TENANT reads  — vendor-A employee calls every ess.* read; rows
//      seeded in vendor B NEVER appear, even when the payload forges
//      employeeId/vendorId fields.
//   2. CROSS-EMPLOYEE reads — same-tenant coworker's rows never appear, with
//      a forged employeeId payload.
//   3. ess.payroll.html IDOR — another employee's entryId (same or other
//      tenant) is a 404, never a payslip.
//   4. tracking.status actor resolution — EMPLOYEE may only ask for SELF;
//      staff need attendance.edit to ask for someone else; cross-tenant
//      "someone else" is a 404 even with the permission.
//   5. Punch actor resolution — attendance.geofence.checkin /
//      attendance.selfie.checkin / attendance.selfCheckout refuse a forged
//      employeeId from an EMPLOYEE; the staff act-for-other path requires
//      attendance.edit AND tenant scope (cross-tenant target → 404).
//   6. No-profile session — an authenticated user with no linked employee
//      profile gets a clean 400, not another employee's data.
import "./_testdb"
import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { db } from "@/lib/db"
import { mkVendor, mkUser, mkEmployee, mkBranch, mkSession, uniq } from "./_fixtures"
import { postHrm } from "./_hrm-endpoint"

const FENCE = { lat: 23.8103, lng: 90.4125, radius: 500 }
// tiny valid JPEG (SOI + APP0 JFIF header satisfies the byte-sniffer)
const SELFIE = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEAYABgAAD//9k="

let vendorA: { id: string }
let vendorB: { id: string }
let branchA: { id: string }
let empA1: { id: string }        // the ATTACKER's own employee (vendor A)
let empA2: { id: string }        // same-tenant coworker (vendor A)
let empB1: { id: string }        // other-tenant employee (vendor B)
let tokenA1: string              // EMPLOYEE session, vendor A, employee 1
let tokenA2: string              // EMPLOYEE session, vendor A, employee 2 (for one positive control)
let tokenB1: string              // EMPLOYEE session, vendor B
// PAYROLL_OFFICER — a staff role whose template does NOT include
// attendance.edit (RBAC-103: per-user grants only ever WIDEN, so an
// HR_ADMIN can never be stripped below their template — the honest way to
// probe the missing-permission denial is a role that genuinely lacks it).
let tokenStaffNoPerm: string     // PAYROLL_OFFICER session, vendor A, no attendance.edit
let tokenHrWithPerm: string      // HR_ADMIN session, vendor A, WITH attendance.edit (template)
let tokenEmpNoProfile: string    // EMPLOYEE session, vendor A, no linked employee profile

let a1LeaveIds: string[] = []

beforeAll(async () => {
  vendorA = await mkVendor("T19 Isolation Vendor A")
  vendorB = await mkVendor("T19 Isolation Vendor B")
  branchA = await db.branch.create({
    data: {
      vendorId: vendorA.id, name: "T19 HQ", code: uniq("B"),
      latitude: FENCE.lat, longitude: FENCE.lng,
      geofenceRadius: FENCE.radius, geofenceActive: true,
    },
  })

  empA1 = await mkEmployee(vendorA.id, { branchId: branchA.id, fullName: "T19 A1 Attacker" })
  empA2 = await mkEmployee(vendorA.id, { branchId: branchA.id, fullName: "T19 A2 Coworker" })
  empB1 = await mkEmployee(vendorB.id, { fullName: "T19 B1 Other Tenant" })

  tokenA1 = await mkSession((await mkUser(vendorA.id, { role: "EMPLOYEE", name: "T19 A1", employeeId: empA1.id })).id, "FULL")
  tokenA2 = await mkSession((await mkUser(vendorA.id, { role: "EMPLOYEE", name: "T19 A2", employeeId: empA2.id })).id, "FULL")
  tokenB1 = await mkSession((await mkUser(vendorB.id, { role: "EMPLOYEE", name: "T19 B1", employeeId: empB1.id })).id, "FULL")
  tokenStaffNoPerm = await mkSession((await mkUser(vendorA.id, { role: "PAYROLL_OFFICER", name: "T19 Staff NoPerm" })).id, "FULL")
  tokenHrWithPerm = await mkSession((await mkUser(vendorA.id, { role: "HR_ADMIN", name: "T19 HR WithPerm" })).id, "FULL")
  tokenEmpNoProfile = await mkSession((await mkUser(vendorA.id, { role: "EMPLOYEE", name: "T19 EmpNoProfile" })).id, "FULL")

  // ---- seed distinctive cross-boundary rows ----
  // A1's OWN leave request (the only one they should ever see)
  a1LeaveIds = [(await db.leaveRequest.create({
    data: { vendorId: vendorA.id, employeeId: empA1.id, leaveTypeId: "none", fromDate: "2026-10-01", toDate: "2026-10-02", days: 1, reason: "T19-A1-OWN", status: "PENDING" } as any,
  })).id]
  // A2's same-tenant request (must NEVER appear for A1)
  await db.leaveRequest.create({
    data: { vendorId: vendorA.id, employeeId: empA2.id, leaveTypeId: "none", fromDate: "2026-10-03", toDate: "2026-10-04", days: 1, reason: "T19-A2-SAME-TENANT", status: "PENDING" } as any,
  })
  // B1's other-tenant request (must NEVER appear for A1)
  await db.leaveRequest.create({
    data: { vendorId: vendorB.id, employeeId: empB1.id, leaveTypeId: "none", fromDate: "2026-10-05", toDate: "2026-10-06", days: 1, reason: "T19-B1-OTHER-TENANT", status: "PENDING" } as any,
  })
  // B1's task / expense / document / asset assignment / performance review
  await db.task.create({ data: { vendorId: vendorB.id, assigneeId: empB1.id, title: "T19-B-TASK", status: "TODO" } as any })
  await db.expenseClaim.create({ data: { vendorId: vendorB.id, employeeId: empB1.id, category: "OTHER", title: "T19-B-CLAIM", amount: 100, date: "2026-10-01", status: "PENDING" } as any })
  await db.employeeDocument.create({ data: { vendorId: vendorB.id, employeeId: empB1.id, docType: "OTHER_ID", title: "T19-B-DOC", status: "VALID" } as any })
  await db.performanceReview.create({ data: { vendorId: vendorB.id, employeeId: empB1.id, cycleId: "none", status: "SUBMITTED", overallRating: 3 } as any })
  // A2's same-tenant task + review
  await db.task.create({ data: { vendorId: vendorA.id, assigneeId: empA2.id, title: "T19-A2-TASK", status: "TODO" } as any })
  await db.performanceReview.create({ data: { vendorId: vendorA.id, employeeId: empA2.id, cycleId: "none", status: "SUBMITTED", overallRating: 4 } as any })
  // payslip entries for the IDOR probes (real runs — PayrollEntry.runId has an
  // FK; the scoped findFirst 404s before any payslip rendering)
  const runB = await db.payrollRun.create({ data: { vendorId: vendorB.id, periodMonth: 9, periodYear: 2026 } as any })
  const runA = await db.payrollRun.create({ data: { vendorId: vendorA.id, periodMonth: 9, periodYear: 2026 } as any })
  await db.payrollEntry.create({ data: { vendorId: vendorB.id, runId: runB.id, employeeId: empB1.id, gross: 1, net: 1, ait: 0, payslipNumber: "T19-B-1", breakdownJson: "{}" } as any })
  await db.payrollEntry.create({ data: { vendorId: vendorA.id, runId: runA.id, employeeId: empA2.id, gross: 1, net: 1, ait: 0, payslipNumber: "T19-A2-1", breakdownJson: "{}" } as any })
})

afterAll(async () => {
  await db.payrollEntry.deleteMany({ where: { vendorId: { in: [vendorA.id, vendorB.id] } } })
  await db.payrollRun.deleteMany({ where: { vendorId: { in: [vendorA.id, vendorB.id] } } })
  await db.performanceReview.deleteMany({ where: { vendorId: { in: [vendorA.id, vendorB.id] } } })
  await db.employeeDocument.deleteMany({ where: { vendorId: { in: [vendorA.id, vendorB.id] } } })
  await db.expenseClaim.deleteMany({ where: { vendorId: { in: [vendorA.id, vendorB.id] } } })
  await db.task.deleteMany({ where: { vendorId: { in: [vendorA.id, vendorB.id] } } })
  await db.leaveRequest.deleteMany({ where: { vendorId: { in: [vendorA.id, vendorB.id] } } })
  await db.attendance.deleteMany({ where: { vendorId: vendorA.id } })
  await db.attendanceEvent.deleteMany({ where: { vendorId: vendorA.id } })
  await db.employee.deleteMany({ where: { vendorId: { in: [vendorA.id, vendorB.id] } } })
  await db.user.deleteMany({ where: { vendorId: { in: [vendorA.id, vendorB.id] } } })
  await db.branch.deleteMany({ where: { vendorId: vendorA.id } })
  await db.vendor.deleteMany({ where: { id: { in: [vendorA.id, vendorB.id] } } }).catch(() => {})
  await db.$disconnect()
})

/** The adversarial payload shape: try to name every boundary-crossing target. */
const forged = () => ({
  employeeId: empA2.id,                       // same-tenant coworker
  vendorId: vendorB.id,                       // another tenant
  id: "any", month: 10, year: 2026,
})

describe("T-19 · cross-tenant ess.* reads never leak vendor B rows", () => {
  test("ess.leave: only the caller's OWN requests — even with a forged employeeId/vendorId payload", async () => {
    const res = await postHrm("ess.leave", forged(), { bearer: tokenA1 })
    expect(res.status).toBe(200)
    const reqs = res.body.data.requests as any[]
    expect(reqs.map((r) => r.id)).toEqual(a1LeaveIds) // own row ONLY
    expect(reqs.some((r) => r.reason === "T19-A2-SAME-TENANT")).toBe(false)
    expect(reqs.some((r) => r.reason === "T19-B1-OTHER-TENANT")).toBe(false)
  })

  test("ess.attendance / ess.tasks / ess.expenses / ess.documents / ess.performance exclude other-tenant rows", async () => {
    for (const [action, listKey] of [
      ["ess.attendance", "records"],
      ["ess.tasks", null],
      ["ess.expenses", null],
      ["ess.documents", "docs"],
      ["ess.performance", "reviews"],
    ] as const) {
      const res = await postHrm(action, forged(), { bearer: tokenA1 })
      expect(res.status, `${action} must succeed for the own-scope caller`).toBe(200)
      const body = JSON.stringify(res.body.data)
      expect(body, `${action} must not carry vendor-B markers`).not.toContain("T19-B-")
      expect(body, `${action} must not carry same-tenant coworker markers`).not.toContain("T19-A2-")
    }
  })

  test("vendor B's OWN session sees its rows (the isolation is symmetric, not a blanket denial)", async () => {
    const res = await postHrm("ess.leave", {}, { bearer: tokenB1 })
    expect(res.status).toBe(200)
    const reqs = res.body.data.requests as any[]
    expect(reqs.length).toBe(1)
    expect(reqs[0].reason).toBe("T19-B1-OTHER-TENANT")
  })
})

describe("T-19 · ess.payroll.html IDOR — another employee's payslip is a 404", () => {
  test("same-tenant coworker's entryId → 404", async () => {
    const a2Entry = await db.payrollEntry.findFirst({ where: { vendorId: vendorA.id, employeeId: empA2.id } })
    const res = await postHrm("ess.payroll.html", { entryId: a2Entry!.id }, { bearer: tokenA1 })
    expect(res.status).toBe(404)
    expect(res.body.ok).toBe(false)
  })

  test("other-tenant entryId → 404 (no cross-tenant enumeration)", async () => {
    const bEntry = await db.payrollEntry.findFirst({ where: { vendorId: vendorB.id } })
    const res = await postHrm("ess.payroll.html", { entryId: bEntry!.id }, { bearer: tokenA1 })
    expect(res.status).toBe(404)
  })

  test("A2 asking for B1's entryId → 404 (every same-plane combination denies)", async () => {
    const bEntry = await db.payrollEntry.findFirst({ where: { vendorId: vendorB.id } })
    const res = await postHrm("ess.payroll.html", { entryId: bEntry!.id }, { bearer: tokenA2 })
    expect(res.status).toBe(404)
  })
})

describe("T-19 · tracking.status actor resolution", () => {
  test("self → 200 (positive control)", async () => {
    const res = await postHrm("tracking.status", {}, { bearer: tokenA1 })
    expect(res.status).toBe(200)
    expect(res.body.data.trackingEnabled).toBeDefined()
  })

  test("EMPLOYEE naming a coworker's employeeId → 403, self-scoped message", async () => {
    const res = await postHrm("tracking.status", { employeeId: empA2.id }, { bearer: tokenA1 })
    expect(res.status).toBe(403)
    expect(res.body.error).toContain("only perform this action for yourself")
  })

  test("EMPLOYEE naming another TENANT's employeeId → 403 (identity check fires before any lookup)", async () => {
    const res = await postHrm("tracking.status", { employeeId: empB1.id }, { bearer: tokenA1 })
    expect(res.status).toBe(403)
  })

  test("staff WITHOUT attendance.edit naming another employee → 403", async () => {
    const res = await postHrm("tracking.status", { employeeId: empA2.id }, { bearer: tokenStaffNoPerm })
    expect(res.status).toBe(403)
    expect(res.body.error).toContain("attendance.edit")
  })
})

describe("T-19 · punch actor resolution (geofence / selfie / self-checkout)", () => {
  const geo = (employeeId?: string) => ({
    latitude: FENCE.lat, longitude: FENCE.lng, accuracyM: 10,
    deviceInfo: "t19-isolation",
    ...(employeeId ? { employeeId } : {}),
  })

  test("EMPLOYEE punching with a forged coworker employeeId → 403 (geofence check-in)", async () => {
    const res = await postHrm("attendance.geofence.checkin", geo(empA2.id), { bearer: tokenA1 })
    expect(res.status).toBe(403)
    expect(res.body.error).toContain("only check in/out yourself")
  })

  test("EMPLOYEE selfie punch with a forged employeeId → 403", async () => {
    const res = await postHrm("attendance.selfie.checkin", { selfieDataUrl: SELFIE, deviceInfo: "t19", employeeId: empA2.id }, { bearer: tokenA1 })
    expect(res.status).toBe(403)
    expect(res.body.error).toContain("only check in/out yourself")
  })

  test("EMPLOYEE self-checkout with a forged employeeId → 403", async () => {
    const res = await postHrm("attendance.selfCheckout", { employeeId: empA2.id, reason: "t19" }, { bearer: tokenA1 })
    expect(res.status).toBe(403)
    expect(res.body.error).toContain("only check in/out yourself")
  })

  test("staff act-for-other WITHOUT attendance.edit → 403 (and nothing is written)", async () => {
    const res = await postHrm("attendance.geofence.checkin", geo(empA2.id), { bearer: tokenStaffNoPerm })
    expect(res.status).toBe(403)
    expect(res.body.error).toContain("attendance.edit")
    expect(await db.attendance.count({ where: { vendorId: vendorA.id, employeeId: empA2.id } })).toBe(0)
  })

  test("staff act-for-other ACROSS TENANTS → 404 even with attendance.edit", async () => {
    const res = await postHrm("attendance.geofence.checkin", geo(empB1.id), { bearer: tokenHrWithPerm })
    expect(res.status).toBe(404)
    expect(res.body.error).toContain("not found in your scope")
    // and nothing was written for the other tenant's employee
    expect(await db.attendance.count({ where: { vendorId: vendorB.id, employeeId: empB1.id } })).toBe(0)
  })

  test("staff act-for-other SAME TENANT with attendance.edit → allowed (audited privileged path)", async () => {
    const res = await postHrm("attendance.geofence.checkin", { ...geo(empA2.id), clientEventId: uniq("t19hr") }, { bearer: tokenHrWithPerm })
    expect(res.status).toBe(200)
    // the punch landed on A2's record within vendor A only
    expect(await db.attendance.count({ where: { vendorId: vendorA.id, employeeId: empA2.id } })).toBeGreaterThanOrEqual(1)
  })

  test("EMPLOYEE self punch still works (positive control — the denial is targeted, not blanket)", async () => {
    const res = await postHrm("attendance.geofence.checkin", { ...geo(), clientEventId: uniq("t19self") }, { bearer: tokenA1 })
    expect(res.status).toBe(200)
  })
})

describe("T-19 · no-profile session gets a clean denial, never another employee's data", () => {
  test("ess.leave without a linked employee profile → 400", async () => {
    const res = await postHrm("ess.leave", forged(), { bearer: tokenEmpNoProfile })
    expect(res.status).toBe(400)
    expect(res.body.error).toContain("no linked employee profile")
  })

  test("tracking.status without a linked employee profile → 403 (Deny; ess.* uses 400)", async () => {
    const res = await postHrm("tracking.status", {}, { bearer: tokenEmpNoProfile })
    expect(res.status).toBe(403)
    expect(res.body.error).toContain("No employee profile linked")
  })

  test("no-profile EMPLOYEE forging an employeeId → 403 (the identity check fires first)", async () => {
    const res = await postHrm("tracking.status", { employeeId: empA2.id }, { bearer: tokenEmpNoProfile })
    expect(res.status).toBe(403)
    expect(res.body.error).toContain("only perform this action for yourself")
  })
})

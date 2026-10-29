/// <reference types="bun-types" />
// ============ H-04/H-05 regression: branch/department scope bypass ============
// A BRANCH_MANAGER must never read or write another branch's employee records
// via a client-supplied employeeId, and manager-facing list endpoints default
// to the caller's own scope. Matrix across attendance, leave, exit, pf,
// payroll, finance and letters.
import "./_testdb" // first — sets DATABASE_URL before db.ts is constructed
import { describe, test, expect, beforeAll } from "bun:test"
import { db } from "@/lib/db"
import { getRoute } from "@/hrm-server/routes/router"
import { mkVendor, mkUser, mkBranch, mkEmployee, makeCtx, uniq } from "./_fixtures"

let vendor: { id: string }
let ownBranch: { id: string }
let otherBranch: { id: string }
let ownEmp: { id: string }       // branch manager's own branch
let otherEmp: { id: string }     // a different branch
let branchManager: any
let bmCtx: any

beforeAll(async () => {
  vendor = await mkVendor("H04 Vendor")
  ownBranch = await mkBranch(vendor.id, "Own Branch")
  otherBranch = await mkBranch(vendor.id, "Other Branch")
  ownEmp = await mkEmployee(vendor.id, { branchId: ownBranch.id, fullName: "Own Branch Emp" })
  otherEmp = await mkEmployee(vendor.id, { branchId: otherBranch.id, fullName: "Cross Branch Emp" })
  branchManager = await mkUser(vendor.id, { role: "BRANCH_MANAGER", branchId: ownBranch.id })
  bmCtx = makeCtx(branchManager)
})

const throwsOutOfScope = async (action: string, payload: any, re = /not found in your scope|outside your scope|scope/i) => {
  const def = getRoute(action)!
  expect(def).toBeTruthy()
  await expect(def.handler(bmCtx, payload)).rejects.toThrow(re)
}

describe("H-04/H-05 attendance.ts", () => {
  beforeAll(async () => {
    await db.attendance.create({ data: { vendorId: vendor.id, employeeId: otherEmp.id, date: "2026-09-01", status: "PRESENT", checkIn: "09:00" } })
  })

  test("attendance.register with cross-branch employeeId is denied", () =>
    throwsOutOfScope("attendance.register", { employeeId: otherEmp.id, month: 9, year: 2026 }))
  test("attendance.summary with cross-branch employeeId is denied", () =>
    throwsOutOfScope("attendance.summary", { employeeId: otherEmp.id, month: 9, year: 2026 }))
  test("attendance.register WITHOUT employeeId returns only in-scope rows (own branch)", async () => {
    const def = getRoute("attendance.register")!
    const rows = (await def.handler(bmCtx, { month: 9, year: 2026 })) as any[]
    expect(rows.every((r) => r.employeeId !== otherEmp.id)).toBe(true)
  })
  test("attendance.selfCheckout staff path: cross-branch employeeId denied", () =>
    throwsOutOfScope("attendance.selfCheckout", { employeeId: otherEmp.id }))
  test("attendance.geofence.checkout staff path: cross-branch employeeId denied", () =>
    throwsOutOfScope("attendance.geofence.checkout", { employeeId: otherEmp.id, latitude: 1, longitude: 1 }))
})

describe("H-04/H-05 leave.ts", () => {
  test("leaveBalances.list with cross-branch employeeId is denied", () =>
    throwsOutOfScope("leaveBalances.list", { employeeId: otherEmp.id, year: 2026 }))
  test("leaveRequests.list with cross-branch employeeId is denied", () =>
    throwsOutOfScope("leaveRequests.list", { employeeId: otherEmp.id }))
  test("leaveRequests.apply on behalf of cross-branch employee is denied", () => {
    // grant leave.create so we test the SCOPE check, not the permission gate
    const ctxWithLeave = { ...bmCtx, permissions: new Set([...bmCtx.permissions, "leave.create"]) }
    const def = getRoute("leaveRequests.apply")!
    expect(def.handler(ctxWithLeave, { employeeId: otherEmp.id, leaveTypeId: "x", fromDate: "2026-10-01", toDate: "2026-10-02" }))
      .rejects.toThrow(/scope/i)
  })
  test("leaveRequests.list without employeeId is scope-limited", async () => {
    // seed a cross-branch leave request
    await db.leaveRequest.create({
      data: { vendorId: vendor.id, employeeId: otherEmp.id, leaveTypeId: "lt", fromDate: "2026-09-01", toDate: "2026-09-02", days: 2, status: "PENDING" },
    })
    const def = getRoute("leaveRequests.list")!
    const rows = (await def.handler(bmCtx, {})) as any[]
    expect(rows.every((r) => r.employeeId !== otherEmp.id)).toBe(true)
  })
})

describe("H-04/H-05 exit.ts", () => {
  test("resignations.submit on behalf of cross-branch employee is denied", () =>
    throwsOutOfScope("resignations.submit", {
      employeeId: otherEmp.id, resignationDate: "2026-09-01", proposedLwd: "2026-10-01", reason: "test",
    }))
  test("resignations.list with cross-branch employeeId is denied", () =>
    throwsOutOfScope("resignations.list", { employeeId: otherEmp.id }))
})

describe("H-04/H-05 finance.ts", () => {
  beforeAll(async () => {
    await db.loan.create({ data: { vendorId: vendor.id, employeeId: otherEmp.id, type: "PERSONAL", principal: 5000, installmentAmount: 1000, installments: 5, startDate: "2026-09-01", outstanding: 5000, status: "ACTIVE" } })
    await db.advance.create({ data: { vendorId: vendor.id, employeeId: otherEmp.id, amount: 2000, outstanding: 2000, installments: 1, requestDate: "2026-09-01", status: "PENDING" } })
    await db.expenseClaim.create({ data: { vendorId: vendor.id, employeeId: otherEmp.id, category: "OTHER", title: "x", amount: 100, date: "2026-09-01", status: "PENDING" } })
  })

  test("loans.list with cross-branch employeeId is denied", () => throwsOutOfScope("loans.list", { employeeId: otherEmp.id }))
  test("loans.list without employeeId is scope-limited", async () => {
    const def = getRoute("loans.list")!
    const rows = (await def.handler(bmCtx, {})) as any[]
    expect(rows.every((r) => r.employeeId !== otherEmp.id)).toBe(true)
  })
  test("advances.list with cross-branch employeeId is denied", () => throwsOutOfScope("advances.list", { employeeId: otherEmp.id }))
  test("advances.list without employeeId is scope-limited", async () => {
    const def = getRoute("advances.list")!
    const rows = (await def.handler(bmCtx, {})) as any[]
    expect(rows.every((r) => r.employeeId !== otherEmp.id)).toBe(true)
  })
  test("expenses.list with cross-branch employeeId is denied", () => throwsOutOfScope("expenses.list", { employeeId: otherEmp.id }))
})

describe("H-04/H-05 payroll.ts", () => {
  beforeAll(async () => {
    await db.bonus.create({ data: { vendorId: vendor.id, employeeId: otherEmp.id, type: "FESTIVAL", calcType: "FIXED", amount: 500, status: "APPROVED", createdBy: "someone" } })
    await db.deduction.create({ data: { vendorId: vendor.id, employeeId: otherEmp.id, type: "OTHER", label: "x", amount: 50, month: 9, year: 2026, status: "ACTIVE" } })
  })

  test("bonuses.list with cross-branch employeeId is denied", () => throwsOutOfScope("bonuses.list", { employeeId: otherEmp.id }))
  test("deductions.list with cross-branch employeeId is denied", () => throwsOutOfScope("deductions.list", { employeeId: otherEmp.id }))
  test("payslips.list with cross-branch employeeId is denied", () => throwsOutOfScope("payslips.list", { employeeId: otherEmp.id }))
  test("bonuses.list without employeeId is scope-limited", async () => {
    const def = getRoute("bonuses.list")!
    const rows = (await def.handler(bmCtx, {})) as any[]
    expect(rows.every((r) => r.employeeId !== otherEmp.id)).toBe(true)
  })
})

describe("H-04/H-05 letters.ts", () => {
  beforeAll(async () => {
    await db.hrLetter.create({ data: { vendorId: vendor.id, employeeId: otherEmp.id, type: "GENERAL", letterNumber: uniq("L"), subject: "x", content: "y", status: "DRAFT" } })
  })

  test("letters.list with cross-branch employeeId is denied", () => throwsOutOfScope("letters.list", { employeeId: otherEmp.id }))
  test("letters.list without employeeId is scope-limited", async () => {
    const def = getRoute("letters.list")!
    const rows = (await def.handler(bmCtx, {})) as any[]
    expect(rows.every((r) => r.employeeId !== otherEmp.id)).toBe(true)
  })
})

describe("H-04/H-05 pf.ts", () => {
  beforeAll(async () => {
    await db.pfEnrollment.create({ data: { vendorId: vendor.id, employeeId: otherEmp.id, employeePct: 10, employerPct: 10, basis: "BASIC", status: "ACTIVE", enrollDate: "2026-01-01" } })
  })

  test("pf.list without employeeId is scope-limited", async () => {
    const def = getRoute("pf.list")!
    const rows = (await def.handler(bmCtx, {})) as any[]
    expect(rows.every((r: any) => r.employeeId !== otherEmp.id)).toBe(true)
  })
  test("pf.enroll with cross-branch employeeId is denied", () => throwsOutOfScope("pf.enroll", { employeeId: otherEmp.id }))
})

describe("H-04/H-05 — HR_ADMIN (unscoped) still sees the whole tenant", () => {
  test("loans.list returns cross-branch rows for HR_ADMIN", async () => {
    const hrAdmin = await mkUser(vendor.id, { role: "HR_ADMIN" })
    const def = getRoute("loans.list")!
    const rows = (await def.handler(makeCtx(hrAdmin), {})) as any[]
    expect(rows.some((r) => r.employeeId === otherEmp.id)).toBe(true)
  })
})

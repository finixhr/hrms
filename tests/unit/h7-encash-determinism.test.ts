/// <reference types="bun-types" -*-
// ============ H-7 regression: leave.encash resolves the REQUESTED leave type ============
// Audit H-7 (High): leave.encash selected the balance row with
// findFirst({ where: { employeeId, vendorId, year } }) — no leaveTypeId, no
// orderBy. With multiple leave types (the normal case) Postgres returns an
// arbitrary row: the encashment could reserve days from Annual Leave while
// validating eligibility (and paying the rate) against Sick Leave, and the
// same request could pick different rows across calls — non-deterministic
// money computation.
//
// Fix under test: leaveTypeId is REQUIRED (zod-validated), the query is scoped
// by it, and a deterministic orderBy is kept as defense-in-depth. The
// LeaveBalance unique key (employeeId, leaveTypeId, year) makes the scoped
// lookup unique.
//
// Route-layer: drives leave.encash through POST /api/hrm.
import "./_testdb"
import { describe, test, expect, beforeAll } from "bun:test"
import { db } from "@/lib/db"
import { mkVendor, mkUser, mkEmployee, mkSession, uniq } from "./_fixtures"
import { postHrm } from "./_hrm-endpoint"

const YEAR = new Date().getFullYear()

let vendor: { id: string }
let employee: { id: string }
let token: string
// BOTH types are encashment-eligible with DIFFERENT rates — the wrong-row pick
// would pay the wrong rate. Inserted casual-FIRST so the old unscoped findFirst
// (heap order) deterministically picked the wrong row.
let casualTypeId: string, annualTypeId: string, sickTypeId: string
let casualBalId: string, annualBalId: string

beforeAll(async () => {
  vendor = await mkVendor("H7 Encash Vendor")
  employee = await mkEmployee(vendor.id, { fullName: "H7 Encasher" })
  const user = await mkUser(vendor.id, { role: "EMPLOYEE", name: "H7 Self", employeeId: employee.id })
  token = await mkSession(user.id, "FULL")

  // inserted FIRST (old findFirst returned heap order → this one)
  casualTypeId = (await db.leaveType.create({
    data: { vendorId: vendor.id, code: uniq("CAS"), name: "Casual H7", encashmentAllowed: true, encashmentRate: 2, encashmentCap: 0 },
  })).id
  annualTypeId = (await db.leaveType.create({
    data: { vendorId: vendor.id, code: uniq("ANN"), name: "Annual H7", encashmentAllowed: true, encashmentRate: 1, encashmentCap: 0 },
  })).id
  // also a non-encashment type for the eligibility check
  sickTypeId = (await db.leaveType.create({
    data: { vendorId: vendor.id, code: uniq("SIK"), name: "Sick H7", encashmentAllowed: false, encashmentRate: 0, encashmentCap: 0 },
  })).id

  casualBalId = (await db.leaveBalance.create({
    data: { vendorId: vendor.id, employeeId: employee.id, leaveTypeId: casualTypeId, year: YEAR, entitled: 10, used: 0, pending: 0 },
  })).id
  annualBalId = (await db.leaveBalance.create({
    data: { vendorId: vendor.id, employeeId: employee.id, leaveTypeId: annualTypeId, year: YEAR, entitled: 20, used: 0, pending: 0 },
  })).id
  await db.leaveBalance.create({
    data: { vendorId: vendor.id, employeeId: employee.id, leaveTypeId: sickTypeId, year: YEAR, entitled: 15, used: 0, pending: 0 },
  })

  // ENCASHMENT approval workflow (submitForApproval requires one)
  const wf = await db.approvalWorkflow.create({
    data: { vendorId: vendor.id, processType: "ENCASHMENT", name: `Encash ${uniq()}`, active: true },
  })
  await db.approvalStep.create({
    data: { vendorId: wf.vendorId, workflowId: wf.id, sequence: 1, name: "Owner Approval", approverRole: "VENDOR_OWNER", required: true, rejectBehavior: "REJECT_ALL", departmentScope: false, branchScope: false, amountThreshold: null, allowDelegation: false },
  })
})

describe("H-7 leave.encash is deterministic and type-scoped", () => {
  test("leaveTypeId is required (payload validation)", async () => {
    const res = await postHrm("leave.encash", { days: 5 }, { bearer: token })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/leaveTypeId/i)
  })

  test("encashment always reserves against the REQUESTED type's balance row", async () => {
    const res = await postHrm("leave.encash", { leaveTypeId: annualTypeId, days: 5 }, { bearer: token })
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    const approvalId = res.body.data.approvalId
    // the approval entity is the ANNUAL balance row — not the first-inserted casual row
    const req = await db.approvalRequest.findUnique({ where: { id: approvalId } })
    expect(req?.entityId).toBe(annualBalId)
    expect(req?.processType).toBe("ENCASHMENT")
    // the reservation landed on the ANNUAL row only
    const annual = await db.leaveBalance.findUnique({ where: { id: annualBalId } })
    const casual = await db.leaveBalance.findUnique({ where: { id: casualBalId } })
    expect(annual?.pending).toBe(5)  // ← old code incremented whichever row it found
    expect(casual?.pending).toBe(0)
  })

  test("a non-encashment-eligible type is rejected even with balance available", async () => {
    const res = await postHrm("leave.encash", { leaveTypeId: sickTypeId, days: 3 }, { bearer: token })
    expect(res.status).toBe(403)
    expect(res.body.error).toMatch(/not encashment-eligible/i)
  })

  test("the balance check uses the REQUESTED type's remaining days", async () => {
    // annual: entitled 20, pending 5 (reserved above) → remaining 15
    const res = await postHrm("leave.encash", { leaveTypeId: annualTypeId, days: 16 }, { bearer: token })
    expect(res.status).toBe(403)
    expect(res.body.error).toMatch(/insufficient balance: 15/i)
  })
})

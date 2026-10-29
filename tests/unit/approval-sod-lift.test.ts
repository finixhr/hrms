// ============ Approval workflow SoD fix regression test (SOP-1) ============
// Reproduces the user-reported bug:
//   1. HR_ADMIN submits payroll for approval (requestedBy = HR_ADMIN user)
//   2. Workflow: step 1 = VENDOR_OWNER, step 2 = HR_ADMIN
//   3. Owner approves step 1 → request moves to step 2 (HR_ADMIN)
//   4. HR_ADMIN visits approval queue → canAct MUST be true (was false before fix)
//   5. HR_ADMIN calls actOnRequest → MUST succeed (was throwing SoD Deny before fix)
//
// Before the SOP-1 fix, the SoD check (`ctx.userId === req.requestedBy`)
// blocked the submitter from acting on ANY step of their own request, even
// after another human had approved a prior step. This broke multi-step
// workflows where the submitter is also a downstream approver.

/// <reference types="bun-types" />
import "./_testdb"
import { test, expect, beforeAll } from "bun:test"
import { db } from "@/lib/db"
import { uniq, mkVendor, mkUser, makeCtx } from "./_fixtures"
import {
  submitForApproval, actOnRequest, queue,
} from "@/hrm-server/approval"

let vendorId: string
let hrAdminUserId: string
let ownerUserId: string
let wfId: string

beforeAll(async () => {
  const v = await mkVendor(`SOP1 Test Vendor ${uniq()}`)
  vendorId = v.id
  const hrAdmin = await mkUser(vendorId, { role: "HR_ADMIN", name: "HR Admin", email: `hradmin-${uniq()}@test.local` })
  hrAdminUserId = hrAdmin.id
  const owner = await mkUser(vendorId, { role: "VENDOR_OWNER", name: "Owner", email: `owner-${uniq()}@test.local` })
  ownerUserId = owner.id

  // Custom PAYROLL workflow: step 1 = VENDOR_OWNER, step 2 = HR_ADMIN
  const wf = await db.approvalWorkflow.create({
    data: { vendorId, processType: "PAYROLL", name: `Payroll Approval ${uniq()}`, active: true },
  })
  wfId = wf.id
  await db.approvalStep.create({
    data: { vendorId, workflowId: wfId, sequence: 1, name: "Owner Approval", approverRole: "VENDOR_OWNER", required: true, rejectBehavior: "REJECT_ALL", departmentScope: false, branchScope: false, amountThreshold: null, allowDelegation: false },
  })
  await db.approvalStep.create({
    data: { vendorId, workflowId: wfId, sequence: 2, name: "HR Admin Approval", approverRole: "HR_ADMIN", required: true, rejectBehavior: "REJECT_ALL", departmentScope: false, branchScope: false, amountThreshold: null, allowDelegation: false },
  })
})

test("SOP-1: HR_ADMIN submits payroll → SoD blocks at step 1 (no prior human approval)", async () => {
  const id = await submitForApproval(
    makeCtx({ id: hrAdminUserId, vendorId, role: "HR_ADMIN" }),
    "PAYROLL", "PayrollRun", `payroll-${uniq()}`, `Payroll run #1`, { amount: 100000 },
  )
  expect(id).toBeTruthy()

  // HR_ADMIN visits the approval queue — canAct must be false (SoD blocks submitter on step 1)
  const q = await queue(makeCtx({ id: hrAdminUserId, vendorId, role: "HR_ADMIN" }))
  const row = q.find((r: any) => r.id === id)
  expect(row).toBeDefined()
  expect(row!.canAct).toBe(false)
  expect(row!.pendingAt).toBe("Vendor Owner")
  expect(row!.approverRole).toBe("VENDOR_OWNER")
})

test("SOP-1: Owner approves step 1 → request moves to step 2 (HR_ADMIN) → HR_ADMIN canAct becomes true", async () => {
  const hrAdminCtx = makeCtx({ id: hrAdminUserId, vendorId, role: "HR_ADMIN" })
  const ownerCtx = makeCtx({ id: ownerUserId, vendorId, role: "VENDOR_OWNER" })

  const id = await submitForApproval(
    hrAdminCtx, "PAYROLL", "PayrollRun", `payroll-${uniq()}`, `Payroll run #1`, { amount: 100000 },
  )

  // Owner (different user) approves step 1
  const result = await actOnRequest(ownerCtx, id, "APPROVE", "Approved by Owner")
  expect(result.status).toBe("PENDING")
  expect(result.advancedTo).toBe("HR Admin Approval")

  // HR_ADMIN (the requester) visits the queue — canAct MUST be true (was false before SOP-1 fix)
  // because a different human (Owner) has approved a prior step, lifting the SoD block.
  const q = await queue(hrAdminCtx)
  const row = q.find((r: any) => r.id === id)
  expect(row).toBeDefined()
  expect(row!.currentStep).toBe(2)
  expect(row!.approverRole).toBe("HR_ADMIN")
  expect(row!.pendingAt).toBe("HR Admin")
  expect(row!.canAct).toBe(true) // ← THE FIX: was false before SOP-1
})

test("SOP-1: HR_ADMIN can now actOnRequest on step 2 after Owner approved step 1", async () => {
  const hrAdminCtx = makeCtx({ id: hrAdminUserId, vendorId, role: "HR_ADMIN" })
  const ownerCtx = makeCtx({ id: ownerUserId, vendorId, role: "VENDOR_OWNER" })

  const id = await submitForApproval(
    hrAdminCtx, "PAYROLL", "PayrollRun", `payroll-${uniq()}`, `Payroll run #1`, { amount: 100000 },
  )

  // Owner approves step 1
  await actOnRequest(ownerCtx, id, "APPROVE", "Approved by Owner")

  // HR_ADMIN (the requester) approves step 2 — was throwing Deny before fix
  const result = await actOnRequest(hrAdminCtx, id, "APPROVE", "Approved by HR Admin (own request, post-Owner-approval)")
  expect(result.status).toBe("APPROVED") // step 2 was the last step
})

test("SOP-1: SoD STILL blocks submitter on step 1 if no prior human approval exists", async () => {
  // This ensures the fix does NOT weaken SoD for the first step.
  const hrAdminCtx = makeCtx({ id: hrAdminUserId, vendorId, role: "HR_ADMIN" })
  const id = await submitForApproval(
    hrAdminCtx, "PAYROLL", "PayrollRun", `payroll-${uniq()}`, `Payroll run #1`, { amount: 100000 },
  )

  // HR_ADMIN (requester) tries to act on step 1 — must throw SoD Deny
  // (no prior human approval by a different user exists yet)
  let threw = false
  try {
    await actOnRequest(hrAdminCtx, id, "APPROVE", "trying to self-approve step 1")
  } catch (e: any) {
    threw = true
    expect(e.message).toMatch(/separation of duties/i)
  }
  expect(threw).toBe(true)
})

test("SOP-1: queue response includes approverRole + approverRoleLabel + pendingAt fields", async () => {
  const id = await submitForApproval(
    makeCtx({ id: hrAdminUserId, vendorId, role: "HR_ADMIN" }),
    "PAYROLL", "PayrollRun", `payroll-${uniq()}`, `Payroll run #1`, { amount: 100000 },
  )
  const q = await queue(makeCtx({ id: hrAdminUserId, vendorId, role: "HR_ADMIN" }))
  const row = q.find((r: any) => r.id === id)
  expect(row).toBeDefined()
  expect(row).toHaveProperty("approverRole")
  expect(row).toHaveProperty("approverRoleLabel")
  expect(row).toHaveProperty("pendingAt")
  expect(row!.approverRole).toBe("VENDOR_OWNER")
  expect(row!.approverRoleLabel).toBe("Vendor Owner")
  expect(row!.pendingAt).toBe("Vendor Owner")
})

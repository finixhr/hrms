/// <reference types="bun-types" />
// ============ L-8 regression: chain-of-custody SoD for super-approvers ============
// Audit L-8 (Low): HR_ADMIN / VENDOR_OWNER are super-approvers on EVERY step.
// Combined with the SOP-1 lift (a submitter may act after a DIFFERENT human
// approved a prior step), this left a one-person completion path for
// multi-step flows: the same admin could take step 1, step 2, step 3…
//
// Fix under test (canActOnStep): a super-approver who already APPROVED an
// earlier step of the same request may not take a later step while another
// active approver exists in the vendor. Sole-admin vendors keep the lift.
// Engine-layer (canActOnStep/actOnRequest), same harness as approval-sod-lift.
import "./_testdb"
import { describe, test, expect, beforeAll } from "bun:test"
import { db } from "@/lib/db"
import { mkVendor, mkUser, makeCtx, uniq } from "./_fixtures"
import { submitForApproval, actOnRequest, queue } from "@/hrm-server/approval"

async function mkTwoStepWorkflow(vendorId: string, name: string) {
  const wf = await db.approvalWorkflow.create({ data: { vendorId, processType: "LEAVE", name: `${name} ${uniq()}`, active: true } })
  await db.approvalStep.create({ data: { vendorId: wf.vendorId, workflowId: wf.id, sequence: 1, name: "Owner", approverRole: "VENDOR_OWNER", required: true, rejectBehavior: "REJECT_ALL", departmentScope: false, branchScope: false, amountThreshold: null, allowDelegation: false } })
  await db.approvalStep.create({ data: { vendorId: wf.vendorId, workflowId: wf.id, sequence: 2, name: "HR", approverRole: "HR_ADMIN", required: true, rejectBehavior: "REJECT_ALL", departmentScope: false, branchScope: false, amountThreshold: null, allowDelegation: false } })
  return wf
}

describe("L-8 — super-approver chain-of-custody", () => {
  test("owner approves step 1, then CANNOT take step 2 while another approver exists (was: one-person completion)", async () => {
    const vendor = await mkVendor(`L8 Vendor ${uniq()}`)
    await mkTwoStepWorkflow(vendor.id, "L8 Flow")
    const owner = await mkUser(vendor.id, { role: "VENDOR_OWNER", email: `owner-${uniq()}@t.local` })
    const hr = await mkUser(vendor.id, { role: "HR_ADMIN", email: `hr-${uniq()}@t.local` })
    const requester = await mkUser(vendor.id, { role: "EMPLOYEE", email: `req-${uniq()}@t.local` })

    const requestId = await submitForApproval(
      makeCtx({ id: requester.id, vendorId: vendor.id, role: "EMPLOYEE" }),
      "LEAVE", "LeaveRequest", `l8-${uniq()}`, "L-8 leave", { amount: 3 },
    )

    const ownerCtx = makeCtx({ id: owner.id, vendorId: vendor.id, role: "VENDOR_OWNER" })
    // step 1 — the owner (not the requester) approves
    await actOnRequest(ownerCtx, requestId, "APPROVE")

    // step 2 is HR_ADMIN-role, but the owner is a super-approver — L-8 must
    // block the chain completion because the hr admin (an alternative active
    // approver) exists
    let blocked = false
    try {
      await actOnRequest(ownerCtx, requestId, "APPROVE")
    } catch (e: any) {
      blocked = /not authorized to act|separation of duties|another approver|SoD/i.test(String(e?.message || e))
    }
    expect(blocked).toBe(true)
    expect((await db.approvalRequest.findUnique({ where: { id: requestId } }))?.currentStep).toBe(2) // still at step 2

    // the OTHER human takes step 2 → completes
    await actOnRequest(makeCtx({ id: hr.id, vendorId: vendor.id, role: "HR_ADMIN" }), requestId, "APPROVE")
    expect((await db.approvalRequest.findUnique({ where: { id: requestId } }))?.status).toBe("APPROVED")
  })

  test("sole-admin vendor keeps the SOP-1 lift (owner completes every step alone)", async () => {
    const vendor = await mkVendor(`L8 Sole ${uniq()}`)
    await mkTwoStepWorkflow(vendor.id, "L8 Sole Flow")
    const owner = await mkUser(vendor.id, { role: "VENDOR_OWNER", email: `sole-${uniq()}@t.local` })
    const requester = await mkUser(vendor.id, { role: "EMPLOYEE", email: `sreq-${uniq()}@t.local` })
    // no other HR_ADMIN / approvals.approve holder exists in this vendor

    const requestId = await submitForApproval(
      makeCtx({ id: requester.id, vendorId: vendor.id, role: "EMPLOYEE" }),
      "LEAVE", "LeaveRequest", `l8s-${uniq()}`, "L-8 sole-admin leave", { amount: 1 },
    )
    const ownerCtx = makeCtx({ id: owner.id, vendorId: vendor.id, role: "VENDOR_OWNER" })
    await actOnRequest(ownerCtx, requestId, "APPROVE") // step 1
    await actOnRequest(ownerCtx, requestId, "APPROVE") // step 2 — allowed: sole admin
    expect((await db.approvalRequest.findUnique({ where: { id: requestId } }))?.status).toBe("APPROVED")
  })

  test("queue view agrees: canAct false for the chain-blocked super-approver", async () => {
    const vendor = await mkVendor(`L8 Q ${uniq()}`)
    await mkTwoStepWorkflow(vendor.id, "L8 Q Flow")
    const owner = await mkUser(vendor.id, { role: "VENDOR_OWNER", email: `qowner-${uniq()}@t.local` })
    const hr = await mkUser(vendor.id, { role: "HR_ADMIN", email: `qhr-${uniq()}@t.local` })
    const requester = await mkUser(vendor.id, { role: "EMPLOYEE", email: `qreq-${uniq()}@t.local` })

    const requestId = await submitForApproval(
      makeCtx({ id: requester.id, vendorId: vendor.id, role: "EMPLOYEE" }),
      "LEAVE", "LeaveRequest", `l8q-${uniq()}`, "L-8 queue leave", { amount: 2 },
    )
    const ownerCtx = makeCtx({ id: owner.id, vendorId: vendor.id, role: "VENDOR_OWNER" })
    await actOnRequest(ownerCtx, requestId, "APPROVE")

    const q = await queue(ownerCtx)
    const row = q.find((r: any) => r.id === requestId)
    expect(row).toBeDefined()
    expect((row as any).canAct).toBe(false)
  })
})

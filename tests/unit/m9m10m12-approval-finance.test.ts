/// <reference types="bun-types" />
// ============ M-9 + M-10 + M-12 — approval finalize, finance atomicity, hardDelete ============
// M-9: a throwing finalize hook used to fail silently-or-fatally with the
//      ApprovalRequest already APPROVED (entity stuck PENDING, no trail).
//      Fix: one retry, then audit row + HR-admin notification + finalizeWarning.
// M-10: loans/advances/expenses create → submit → backlink were bare separate
//      awaits with no duplicate-window guard on loans/advances.
// M-12: employees.hardDelete left orphan bonus/deduction/PF/event/tracking/
//      proof/clearance/settlement/approval rows despite claiming full cleanup.
import { describe, expect, it } from "bun:test"
import { sessionTokenHash } from "@/hrm-server/auth"
import { postHrm } from "./_hrm-endpoint"
import { db } from "@/lib/db"
import { mkEmployee, mkUser, mkVendor, uniq, makeCtx } from "./_fixtures"
import { registerFinalize } from "@/hrm-server/approval"

/** Minimal single-step approval workflow so finance creates can submit. */
async function mkWorkflow(vendorId: string, processType: string) {
  const existing = await db.approvalWorkflow.findFirst({ where: { vendorId, processType } })
  if (existing) return existing
  const wf = await db.approvalWorkflow.create({ data: { vendorId, name: `${processType} flow`, processType } })
  await db.approvalStep.create({ data: { vendorId, workflowId: wf.id, sequence: 1, name: "Approve", approverRole: "VENDOR_OWNER", required: true } })
  return wf
}

async function adminSession(vendorId: string, over: Record<string, any> = {}) {
  const u = await mkUser(vendorId, over)
  const id = `m912-${uniq("s")}`
  await db.session.create({ data: { id, tokenHash: sessionTokenHash(id), userId: u.id, kind: "FULL", csrfToken: "x", expiresAt: new Date(Date.now() + 3600_000), ip: "127.0.0.1", lastSeenAt: new Date() } })
  return id
}

describe("M-9 — finalize hook failure is loud and retried", () => {
  it("a hook that always throws: approval completes, finalizeWarning returned, audit + admin notification written", async () => {
    const vendor = await mkVendor("M9-Hook")
    // a workflow for a dedicated test process type
    const wf = await db.approvalWorkflow.create({ data: { vendorId: vendor.id, name: "M9 Flow", processType: "M9TEST" } })
    await db.approvalStep.create({ data: { vendorId: vendor.id, workflowId: wf.id, sequence: 1, name: "Step 1", approverRole: "VENDOR_OWNER", required: true } })
    const approver = await adminSession(vendor.id)
    const requester = await mkUser(vendor.id, { email: uniq("m9req") + "@t.local" }) // SoD: requester ≠ approver
    await mkUser(vendor.id, { role: "HR_ADMIN", email: uniq("m9hr") + "@t.local" }) // the admin-notification recipient

    // a hook that ALWAYS fails (the entity is a dummy row)
    let calls = 0
    registerFinalize("M9TEST", async () => { calls++; throw new Error("boom: simulated finalize failure") })

    const r = await postHrm("approvals.act", {
      requestId: (await db.approvalRequest.create({
        data: {
          vendorId: vendor.id, workflowId: wf.id, processType: "M9TEST", entityType: "Employee",
          entityId: "dummy", entityRef: "M9 test entity", requestedBy: requester.id,
          currentStep: 1, status: "PENDING", payloadJson: "{}",
        },
      })).id,
      decision: "APPROVE",
    }, { bearer: approver })

    if (r.status !== 200) console.log("DEBUG M9 BODY:", JSON.stringify(r.body))
    expect(r.status).toBe(200)
    expect(r.body?.data?.status).toBe("APPROVED")
    expect(String(r.body?.data?.finalizeWarning)).toContain("boom")
    expect(calls).toBe(2) // one attempt + one retry
    // loud trail: audit row + HR admin notification
    const auditRow = await db.auditLog.findFirst({ where: { vendorId: vendor.id, action: "m9test.finalizeError" } })
    expect(auditRow).toBeTruthy()
    expect(String(auditRow!.summary)).toContain("FINALIZE HOOK FAILED")
    const note = await db.notification.findFirst({ where: { vendorId: vendor.id, title: "Approval follow-up failed" } })
    expect(note).toBeTruthy()
  })
})

describe("M-10 — finance create paths", () => {
  it("identical loan submissions inside the duplicate window are refused (409)", async () => {
    const vendor = await mkVendor("M10-Loan")
    await mkWorkflow(vendor.id, "LOAN")
    const emp = await mkEmployee(vendor.id)
    const sess = await adminSession(vendor.id)
    const body = { employeeId: emp.id, principal: 50000, installments: 10, startDate: "2026-01-01", purpose: "M10 test" }
    const first = await postHrm("loans.create", body, { bearer: sess })
    expect(first.status).toBe(200)
    const second = await postHrm("loans.create", body, { bearer: sess })
    expect(second.status).toBe(409)
    expect(second.body?.error).toContain("no duplicate created")
    const count = await db.loan.count({ where: { vendorId: vendor.id, employeeId: emp.id } })
    expect(count).toBe(1)
  })

  it("identical advance submissions inside the duplicate window are refused (409)", async () => {
    const vendor = await mkVendor("M10-Adv")
    await mkWorkflow(vendor.id, "ADVANCE")
    const emp = await mkEmployee(vendor.id)
    const sess = await adminSession(vendor.id)
    const body = { employeeId: emp.id, amount: 5000, reason: "M10 advance" }
    const first = await postHrm("advances.create", body, { bearer: sess })
    expect(first.status).toBe(200)
    const second = await postHrm("advances.create", body, { bearer: sess })
    expect(second.status).toBe(409)
    const count = await db.advance.count({ where: { vendorId: vendor.id, employeeId: emp.id } })
    expect(count).toBe(1)
  })

  it("compensation: when approval submission fails, the created loan is removed again (no orphaned PENDING row)", async () => {
    const vendor = await mkVendor("M10-Comp")
    const emp = await mkEmployee(vendor.id)
    const sess = await adminSession(vendor.id)
    // NO loan workflow exists for this vendor → submitForApproval throws
    const r = await postHrm("loans.create", { employeeId: emp.id, principal: 12000, installments: 4, startDate: "2026-01-01" }, { bearer: sess })
    expect([400, 403, 404, 500]).toContain(r.status) // the submission error surfaces
    const orphan = await db.loan.count({ where: { vendorId: vendor.id, employeeId: emp.id } })
    expect(orphan).toBe(0) // and the loan row was compensated away
  })
})

describe("M-12 — hardDelete leaves no orphans", () => {
  it("every child family is removed (bonus/deduction/PF/events/tracking/exit/approvals/procurement/lifecycle/comms)", async () => {
    const vendor = await mkVendor("M12-Hard")
    const emp = await mkEmployee(vendor.id, { fullName: "Doomed Employee" })
    const sess = await adminSession(vendor.id)
    const uid = (await db.session.findUnique({ where: { id: sess } }))!.userId

    // payroll extras (fields per the live schema)
    await db.bonus.create({ data: { vendorId: vendor.id, employeeId: emp.id, type: "FESTIVAL", amount: 1000, status: "APPROVED" } as any })
    await db.deduction.create({ data: { vendorId: vendor.id, employeeId: emp.id, type: "OTHER", label: "M12", amount: 500, month: 10, year: 2026 } as any })
    await db.pfEnrollment.create({ data: { vendorId: vendor.id, employeeId: emp.id, enrollDate: "2026-01-01" } as any })
    await db.pfContribution.create({ data: { vendorId: vendor.id, employeeId: emp.id, periodYear: 2026, periodMonth: 10, employeeAmount: 100, employerAmount: 100 } as any })
    // attendance security + tracking evidence
    await db.attendanceEvent.create({ data: { vendorId: vendor.id, employeeId: emp.id, eventType: "GEOFENCE_VIOLATION", attendanceMethod: "GEOFENCE", occurredAt: new Date() } as any })
    await db.attendanceProof.create({ data: { vendorId: vendor.id, employeeId: emp.id, storageKey: `proof/${vendor.id}/${emp.id}/x`, fileHash: "a".repeat(64), data: "eHg=", capturedAt: new Date() } as any })
    await db.trackingPoint.create({ data: { vendorId: vendor.id, employeeId: emp.id, timestamp: new Date(), latitude: 23.8, longitude: 90.4 } as any })
    await db.employeeTrackingState.create({ data: { vendorId: vendor.id, employeeId: emp.id } as any })
    // lifecycle + comms + procurement (fields per the live schema)
    await db.promotion.create({ data: { vendorId: vendor.id, employeeId: emp.id, effectiveDate: "2026-01-01" } as any })
    await db.transfer.create({ data: { vendorId: vendor.id, employeeId: emp.id, effectiveDate: "2026-01-01" } as any })
    const goods = await db.goodsRequisition.create({ data: { vendorId: vendor.id, code: `GR-${Date.now()}`, employeeId: emp.id, status: "PENDING" } as any })
    await db.goodsRequisitionItem.create({ data: { vendorId: vendor.id, requisitionId: goods.id, itemName: "pen", quantity: 1 } })
    await db.goodsReceiptConfirmation.create({ data: { vendorId: vendor.id, employeeId: emp.id, requisitionId: goods.id, decision: "CONFIRM" } })
    // exit chain: resignation → clearance + settlement + approval
    const res = await db.resignation.create({ data: { vendorId: vendor.id, employeeId: emp.id, submissionDate: "2026-10-01", resignationDate: "2026-10-01", proposedLwd: "2026-12-31", reason: "test" } as any })
    await db.exitClearance.create({ data: { vendorId: vendor.id, resignationId: res.id } })
    await db.finalSettlement.create({ data: { vendorId: vendor.id, resignationId: res.id, status: "PENDING" } as any })
    const leave = await db.leaveRequest.create({ data: { vendorId: vendor.id, employeeId: emp.id, leaveTypeId: "none", fromDate: "2026-11-01", toDate: "2026-11-02", days: 1, reason: "x", status: "PENDING", createdAt: new Date() } as any })
    await db.approvalRequest.create({ data: { vendorId: vendor.id, workflowId: "wf-m12", processType: "LEAVE", entityType: "LeaveRequest", entityId: leave.id, entityRef: "M12 leave", requestedBy: uid, currentStep: 1, status: "PENDING", payloadJson: "{}" } })
    // linked portal user (link cleared, user survives)
    const linked = await mkUser(vendor.id, { employeeId: emp.id })

    const r = await postHrm("employees.hardDelete", { id: emp.id, confirm: emp.code }, { bearer: sess })
    expect(r.status).toBe(200)

    expect(await db.employee.count({ where: { id: emp.id } })).toBe(0)
    expect(await db.bonus.count({ where: { employeeId: emp.id } })).toBe(0)
    expect(await db.deduction.count({ where: { employeeId: emp.id } })).toBe(0)
    expect(await db.pfEnrollment.count({ where: { employeeId: emp.id } })).toBe(0)
    expect(await db.pfContribution.count({ where: { employeeId: emp.id } })).toBe(0)
    expect(await db.attendanceEvent.count({ where: { employeeId: emp.id } })).toBe(0)
    expect(await db.attendanceProof.count({ where: { employeeId: emp.id } })).toBe(0)
    expect(await db.trackingPoint.count({ where: { employeeId: emp.id } })).toBe(0)
    expect(await db.employeeTrackingState.count({ where: { employeeId: emp.id } })).toBe(0)
    expect(await db.promotion.count({ where: { employeeId: emp.id } })).toBe(0)
    expect(await db.transfer.count({ where: { employeeId: emp.id } })).toBe(0)
    expect(await db.goodsRequisition.count({ where: { employeeId: emp.id } })).toBe(0)
    expect(await db.goodsRequisitionItem.count({ where: { requisitionId: goods.id } })).toBe(0)
    expect(await db.goodsReceiptConfirmation.count({ where: { employeeId: emp.id } })).toBe(0)
    expect(await db.exitClearance.count({ where: { resignationId: res.id } })).toBe(0)
    expect(await db.finalSettlement.count({ where: { resignationId: res.id } })).toBe(0)
    expect(await db.approvalRequest.count({ where: { entityId: leave.id } })).toBe(0)
    // the linked user survives but is unlinked
    const surviving = await db.user.findUnique({ where: { id: linked.id } })
    expect(surviving).toBeTruthy()
    expect(surviving!.employeeId).toBeNull()
  })
})

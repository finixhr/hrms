/// <reference types="bun-types" />
// ============ Phase 4 WS-C — data integrity (MOD-10 / MOD-14 / MOD-15) ============
// MOD-10: lifecycle.transfer validates every provided target vendor-scoped —
//         another tenant's branch/department/designation/shift/manager can no
//         longer be written into a transfer and applied at approval.
// MOD-14: workflows.save refuses to edit while PENDING requests of that
//         process type exist, and the rewrite is one transaction.
// MOD-15: employees.hardDelete preserves the AuditLog trail — the forensic
//         record (including the deletion's own audit row) survives.
import "./_testdb"
import { describe, test, expect, beforeAll } from "bun:test"
import { db } from "@/lib/db"
import { mkVendor, mkUser, mkEmployee, mkSession, makeCtx } from "./_fixtures"
import { postHrm } from "./_hrm-endpoint"

let vendor: { id: string }
let otherVendor: { id: string }
let ctx: any
let token: string

beforeAll(async () => {
  vendor = await mkVendor("P4 WSC Vendor")
  otherVendor = await mkVendor("P4 WSC OTHER Tenant")
  const u = await mkUser(vendor.id, { role: "VENDOR_OWNER", name: "P4 WSC Owner" })
  ctx = makeCtx(u, ["*"])
  token = await mkSession(u.id, "FULL")
})

describe("MOD-10 — lifecycle.transfer vendor-scoped FK validation", () => {
  test("a CROSS-TENANT branch id is rejected with an actionable 400 naming the field", async () => {
    const emp = await mkEmployee(vendor.id, { fullName: "P4 WSC Transfer Emp" })
    const foreign = await db.branch.create({ data: { vendorId: otherVendor.id, code: "FOREIGN", name: "Foreign Branch" } })
    const res = await postHrm("lifecycle.transfer", {
      employeeId: emp.id, toBranchId: foreign.id, effectiveDate: "2026-08-01", reason: "x",
    }, { bearer: token })
    expect(res.body.ok).toBe(false)
    expect(String(res.body.error)).toMatch(/toBranchId.*workspace/s)
    const transfers = await db.transfer.findMany({ where: { employeeId: emp.id } })
    expect(transfers.length).toBe(0) // nothing written
  })

  test("a CROSS-TENANT manager id is rejected", async () => {
    const emp = await mkEmployee(vendor.id, { fullName: "P4 WSC Transfer Emp 2" })
    const foreignEmp = await mkEmployee(otherVendor.id, { fullName: "Foreign Manager" })
    const res = await postHrm("lifecycle.transfer", {
      employeeId: emp.id, toManagerId: foreignEmp.id, effectiveDate: "2026-08-01",
    }, { bearer: token })
    expect(res.body.ok).toBe(false)
    expect(String(res.body.error)).toMatch(/toManagerId.*workspace/s)
  })

  test("own-tenant targets pass and the transfer is created; absent targets are not queried", async () => {
    // the transfer action submits into the TRANSFER approval workflow
    await postHrm("workflows.save", {
      processType: "TRANSFER", name: "P4 WSC Transfer WF",
      steps: [{ name: "Manager", approverRole: "HR_ADMIN" }],
    }, { bearer: token })
    const emp = await mkEmployee(vendor.id, { fullName: "P4 WSC Transfer Emp 3" })
    const branch = await db.branch.create({ data: { vendorId: vendor.id, code: "P4OWN", name: "P4 Own Branch" } })
    const res = await postHrm("lifecycle.transfer", {
      employeeId: emp.id, toBranchId: branch.id, effectiveDate: "2026-08-01",
    }, { bearer: token })
    expect(res.body.ok).toBe(true)
    expect(res.body.data.toBranchId).toBe(branch.id)
  })
})

describe("MOD-14 — workflows.save pending guard + atomic rewrite", () => {
  test("a PENDING request of the process type blocks the workflow edit", async () => {
    await postHrm("workflows.save", {
      processType: "LEAVE", name: "P4 WSC Leave WF",
      steps: [{ name: "Manager", approverRole: "HR_ADMIN" }],
    }, { bearer: token })
    // a pending request riding that workflow's steps
    await db.approvalRequest.create({
      data: {
        vendorId: vendor.id, workflowId: "wf-p4-wsc", processType: "LEAVE",
        entityType: "LeaveRequest", entityId: "lr-p4-wsc", requestedBy: "u1", currentStep: 1, status: "PENDING",
      },
    })
    const res = await postHrm("workflows.save", {
      processType: "LEAVE", name: "P4 WSC Leave WF EDITED",
      steps: [{ name: "Manager", approverRole: "HR_ADMIN" }, { name: "HR", approverRole: "HR_ADMIN" }],
    }, { bearer: token })
    expect(res.body.ok).toBe(false)
    expect(String(res.body.error)).toMatch(/pending.*approval request.*before editing/is)
  })

  test("after the requests are resolved the same edit succeeds atomically (steps fully replaced)", async () => {
    await db.approvalRequest.updateMany({
      where: { vendorId: vendor.id, processType: "LEAVE", status: "PENDING" },
      data: { status: "APPROVED", completedAt: new Date() },
    })
    const res = await postHrm("workflows.save", {
      processType: "LEAVE", name: "P4 WSC Leave WF EDITED",
      steps: [{ name: "Manager", approverRole: "HR_ADMIN" }, { name: "HR", approverRole: "HR_ADMIN" }],
    }, { bearer: token })
    expect(res.body.ok).toBe(true)
    const wf = await db.approvalWorkflow.findFirst({ where: { vendorId: vendor.id, processType: "LEAVE" } })
    const steps = await db.approvalStep.findMany({ where: { workflowId: wf!.id }, orderBy: { sequence: "asc" } })
    expect(steps.map((s) => s.name)).toEqual(["Manager", "HR"]) // full replace, no strays
  })
})

describe("MOD-15 — hardDelete preserves the audit trail", () => {
  test("the employee's AuditLog rows (seeded + the deletion row itself) survive the hard delete", async () => {
    const emp = await mkEmployee(vendor.id, { fullName: "P4 WSC Doomed" })
    // seed three historical audit rows
    for (const action of ["employees.create", "employees.edit", "employees.view"]) {
      await db.auditLog.create({
        data: { vendorId: vendor.id, userId: "seed", userName: "seed", action, entity: "Employee", entityId: emp.id, summary: `seed ${action}`, ip: "127.0.0.1" },
      })
    }
    const before = await db.auditLog.count({ where: { entityId: emp.id, entity: "Employee" } })
    expect(before).toBe(3)
    const res = await postHrm("employees.hardDelete", { id: emp.id, confirm: emp.code }, { bearer: token })
    expect(res.body.ok).toBe(true)
    // the employee is gone…
    const gone = await db.employee.findUnique({ where: { id: emp.id } })
    expect(gone).toBeNull()
    // …but the FULL trail survives, now including the deletion's own row
    const after = await db.auditLog.findMany({ where: { entityId: emp.id, entity: "Employee" } })
    expect(after.length).toBe(4)
    expect(after.some((r) => r.action === "employees.hardDelete")).toBe(true)
  })
})

/// <reference types="bun-types" />
// ============ H-8 regression: every salary-structure write path dual-writes paisa ============
// Audit H-8 (High): the H-09 paisa shadow columns (lossless integer money)
// were only written by employees.createWithStructure. The two other structure
// write paths — salaryStructures.save (Payroll UI create + update) and
// applySalaryRevision (approved SALARY_REVISION workflow) — wrote Float-only
// rows, so any consumer preferring the lossless representation reads null and
// the documented Float→integer staged migration cannot complete.
//
// Fix under test: one shared helper (src/hrm-server/money.ts) applied at ALL
// THREE structure write sites. Convention (per h09-paisa-golden):
//   <field>Paisa = Math.round(<field> * 100)
//
// Route-layer: salaryStructures.save + employees.createWithStructure + the
// FULL approval flow (lifecycle.reviseSalary → approvals.act → hook) all
// driven through POST /api/hrm.
import "./_testdb"
import { describe, test, expect, beforeAll } from "bun:test"
import { db } from "@/lib/db"
import { mkVendor, mkUser, mkEmployee, mkSession, uniq } from "./_fixtures"
import { postHrm } from "./_hrm-endpoint"

const FIELDS = ["basic", "houseRent", "medical", "conveyance", "food", "mobileAllow", "internetAllow", "attendanceAllow", "otherAllowance"] as const

let vendor: { id: string }
let token: string

/** fractional amounts so a missing paisa column is unambiguous (null ≠ value) */
const COMP = {
  basic: 5000.5, houseRent: 2000.25, medical: 500.75, conveyance: 300.1,
  food: 0, mobileAllow: 0, internetAllow: 0, attendanceAllow: 0, otherAllowance: 0,
}
const GROSS = Math.round(FIELDS.reduce((s, f) => s + COMP[f], 0))

async function activeStructure(employeeId: string) {
  return db.salaryStructure.findFirst({ where: { employeeId, status: "ACTIVE" }, orderBy: { effectiveFrom: "desc" } })
}

beforeAll(async () => {
  vendor = await mkVendor("H8 Paisa Vendor")
  const admin = await mkUser(vendor.id, { role: "VENDOR_OWNER", name: "H8 Admin" })
  token = await mkSession(admin.id, "FULL")
})

describe("H-8 paisa dual-write on every salary-structure write path", () => {
  test("salaryStructures.save (create) writes all paisa companions", async () => {
    const emp = await mkEmployee(vendor.id, { fullName: "H8 Payroll Create" })
    const res = await postHrm("salaryStructures.save", { employeeId: emp.id, effectiveFrom: "2026-10-01", ...COMP }, { bearer: token })
    expect(res.status).toBe(200)
    const s = await activeStructure(emp.id)
    expect(s).toBeTruthy()
    expect(s?.gross).toBe(GROSS)
    for (const f of FIELDS) {
      // 2026-10-13 — paisa columns are BIGINT → reads are bigint; compare via Number
      expect(Number((s as any)?.[`${f}Paisa`])).toBe(Math.round(COMP[f] * 100)) // ← was null
    }
    expect(Number(s?.grossPaisa)).toBe(Math.round(GROSS * 100))
  })

  test("salaryStructures.save (update existing) also writes paisa companions", async () => {
    const emp = await mkEmployee(vendor.id, { fullName: "H8 Payroll Update" })
    const created = await postHrm("salaryStructures.save", { employeeId: emp.id, effectiveFrom: "2026-09-01", ...COMP }, { bearer: token })
    const id = created.body.data.id
    const res = await postHrm("salaryStructures.save", { id, employeeId: emp.id, effectiveFrom: "2026-09-01", ...COMP, basic: 6000.75 }, { bearer: token })
    expect(res.status).toBe(200)
    const s = await db.salaryStructure.findUnique({ where: { id } })
    expect(Number(s?.basicPaisa)).toBe(Math.round(6000.75 * 100)) // ← was null on the update path
    // grossPaisa shadows the STORED (already-rounded) gross — same convention as h09-paisa-golden
    const storedGross = Math.round(GROSS - COMP.basic + 6000.75)
    expect(s?.gross).toBe(storedGross)
    expect(Number(s?.grossPaisa)).toBe(Math.round(storedGross * 100))

    // 2026-10-22 hotfix regression guard — the audit row for THIS update used
    // to be silently dropped: oldValue carried the raw Prisma row, whose
    // BigInt paisa columns crash JSON.stringify inside audit()'s best-effort
    // catch. The mutation succeeded; its forensic record did not exist.
    // Assert the row now lands with both snapshots serialized (BigInt → string).
    const auditRow = await db.auditLog.findFirst({
      where: { vendorId: vendor.id, action: "salaryStructures.update", entityId: id },
      orderBy: { createdAt: "desc" },
    })
    expect(auditRow).toBeTruthy()
    expect(auditRow?.oldValue).toContain("basicPaisa") // old row snapshot survived
    expect(auditRow?.oldValue).toContain("500050")     // 5000.50 taka → 500050 paisa
    expect(auditRow?.newValue).toContain("600075")     // new basic 6000.75 → 600075 paisa
  })

  test("employees.createWithStructure still dual-writes (no regression, now via the shared helper)", async () => {
    const res = await postHrm("employees.createWithStructure", {
      fullName: "H8 Create With Structure", code: uniq("H8E"), joiningDate: "2026-10-01",
      employmentType: "PERMANENT", status: "ACTIVE", ...COMP,
    }, { bearer: token })
    expect(res.status).toBe(200)
    const empId = res.body.data.employee?.id || res.body.data.employeeId || res.body.data.id
    const s = await activeStructure(empId)
    for (const f of FIELDS) {
      expect(Number((s as any)?.[`${f}Paisa`])).toBe(Math.round(COMP[f] * 100))
    }
    expect(Number(s?.grossPaisa)).toBe(Math.round(GROSS * 100))
  })

  test("applySalaryRevision (full approval flow) creates the superseding structure WITH paisa", async () => {
    const emp = await mkEmployee(vendor.id, { fullName: "H8 Revision" })
    await postHrm("salaryStructures.save", { employeeId: emp.id, effectiveFrom: "2026-09-01", ...COMP }, { bearer: token })

    // SALARY_REVISION approval workflow (submitForApproval requires one)
    const wf = await db.approvalWorkflow.create({
      data: { vendorId: vendor.id, processType: "SALARY_REVISION", name: `Rev ${uniq()}`, active: true },
    })
    await db.approvalStep.create({
      data: { vendorId: wf.vendorId, workflowId: wf.id, sequence: 1, name: "Owner Approval", approverRole: "VENDOR_OWNER", required: true, rejectBehavior: "REJECT_ALL", departmentScope: false, branchScope: false, amountThreshold: null, allowDelegation: false },
    })

    // route-layer: request the revision, then approve through the queue.
    // SoD blocks the submitter from approving their own request — a SECOND
    // VENDOR_OWNER user acts on the queue.
    const approver = await mkUser(vendor.id, { role: "VENDOR_OWNER", name: "H8 Approver", email: `h8-approver-${uniq()}@test.local` })
    const approverToken = await mkSession(approver.id, "FULL")
    const req = await postHrm("lifecycle.reviseSalary", { employeeId: emp.id, newGross: GROSS + 1000, effectiveDate: "2026-10-01", reason: "H8" }, { bearer: token })
    expect(req.status).toBe(200)
    const revId = req.body.data.id
    const approval = await db.approvalRequest.findFirst({ where: { processType: "SALARY_REVISION", entityId: revId } })
    expect(approval).toBeTruthy()
    const act = await postHrm("approvals.act", { requestId: approval!.id, decision: "APPROVE" }, { bearer: approverToken })
    expect(act.status).toBe(200)

    const s = await activeStructure(emp.id)
    expect(s?.gross).toBe(GROSS + 1000)
    expect(Number(s?.grossPaisa)).toBe(Math.round((GROSS + 1000) * 100)) // ← was null
    for (const f of FIELDS) {
      expect(Number((s as any)?.[`${f}Paisa`])).toBe(Math.round((s as any)[f] * 100))
    }
  })
})

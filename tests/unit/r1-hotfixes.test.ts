/// <reference types="bun-types" />
// ============ Phase R1 hotfix-wave regressions (audit 2026-10-22, roadmap R1) ============
// DB-01  — backup export rebuild: DMMF inventory, parent-scoped child tables,
//          loud classification failure, tenant isolation of children.
// FIN-01 — ESS loan/advance requests: schemas no longer demand employeeId.
// ESS-01 — ESS attendance correction request: EMPLOYEE persona no longer 403s.
// ESS-03 — ess.performance hides DRAFT reviews (finalize-then-notify design).
import "./_testdb"
import { describe, test, expect, beforeAll } from "bun:test"
import { db } from "@/lib/db"
import { mkVendor, mkUser, mkEmployee, mkSession, uniq } from "./_fixtures"
import { postHrm } from "./_hrm-endpoint"
import {
  classifyBackupModels,
  buildTenantBackupExport,
  BACKUP_CHILD_SCOPE,
  BACKUP_EXCLUDED_MODELS,
} from "@/hrm-server/backup-export"

// ---------------------------------------------------------------- DB-01 ----
describe("DB-01 — backup export classification (DMMF walk)", () => {
  test("every schema model resolves to exactly one strategy (no silent skips possible)", () => {
    const { vendorScoped, childScoped, excluded } = classifyBackupModels()
    const all = new Set([...vendorScoped, ...childScoped, ...excluded.map((e) => e.model)])
    // overlap would double-export or mask an exclusion
    expect(vendorScoped.length + childScoped.length + excluded.length).toBe(all.size)
    // the walk is exhaustive over the DMMF (any new model fails classify()
    // itself — that loud failure is the regression under test)
    expect(() => classifyBackupModels()).not.toThrow()
    // spot-check the previously-silent child tables
    for (const m of ["FamilyMember", "Education", "Referee", "PreviousEmployment", "BankAccount",
      "TaxSlab", "LoanInstallment", "CommunicationRecipient", "ApprovalStep", "ApprovalAction",
      "GoodsRequisitionItem", "GoodsRequisitionHistory", "PurchaseRequestItem",
      "PurchaseQuotationItem", "StockEntryItem"]) {
      expect(childScoped).toContain(m)
    }
    // secrets/sessions/platform models are excluded WITH reasons
    for (const m of ["Vendor", "User", "Session", "UserMfaSecret", "ApiRefreshToken", "ApiKey",
      "LoginAuditLog", "AuditLog", "SaasInvoice", "SaasPayment"]) {
      expect(BACKUP_EXCLUDED_MODELS[m]).toBeTruthy()
      expect(excluded.map((e) => e.model)).toContain(m)
    }
  })

  test("every child scopes through a vendor-scoped parent (bare-FK map integrity)", () => {
    const { vendorScoped } = classifyBackupModels()
    const vendorSet = new Set(vendorScoped)
    for (const [child, scope] of Object.entries(BACKUP_CHILD_SCOPE)) {
      expect(vendorSet.has(scope.parent)).toBe(true)
      expect(typeof scope.fk).toBe("string")
      expect(child.length).toBeGreaterThan(0)
    }
  })
})

describe("DB-01 — backup export payload (integration)", () => {
  let vendorA: { id: string }
  let vendorB: { id: string }

  beforeAll(async () => {
    vendorA = await mkVendor("DB01 Vendor A")
    vendorB = await mkVendor("DB01 Vendor B")
    const mkChildren = async (vendorId: string, tag: string) => {
      const emp = await mkEmployee(vendorId, { fullName: `DB01 ${tag} Employee` })
      await db.familyMember.create({ data: { vendorId, employeeId: emp.id, name: `Spouse ${tag}`, relationship: "SPOUSE" } })
      await db.bankAccount.create({ data: { vendorId, employeeId: emp.id, bank: "DBBL", accountNumber: `101${tag.length}` } })
      const loan = await db.loan.create({ data: { vendorId, employeeId: emp.id, principal: 5000, installments: 5, installmentAmount: 1000, startDate: "2026-01-01", outstanding: 5000, status: "ACTIVE" } })
      await db.loanInstallment.create({ data: { vendorId, loanId: loan.id, no: 1, dueDate: "2026-02-01", amount: 1000 } })
      const ruleSet = await db.taxRuleSet.create({ data: { vendorId, name: `DB01 Rules ${tag}`, financialYear: "2026-27" } })
      await db.taxSlab.create({ data: { vendorId, ruleSetId: ruleSet.id, minIncome: 0, maxIncome: 100000, rate: 5 } })
      const wf = await db.approvalWorkflow.create({ data: { vendorId, name: `DB01 Flow ${tag}`, processType: "LEAVE", active: true } })
      await db.approvalStep.create({ data: { vendorId, workflowId: wf.id, sequence: 1, name: "HR", approverRole: "HR_ADMIN", required: true, rejectBehavior: "REJECT_ALL", departmentScope: false, branchScope: false, amountThreshold: null, allowDelegation: false } })
      const log = await db.communicationLog.create({ data: { vendorId, channel: "EMAIL", message: `DB01 blast ${tag}` } })
      await db.communicationRecipient.create({ data: { vendorId, logId: log.id, employeeId: emp.id, employeeName: `DB01 ${tag} Employee` } })
      return { emp, loan }
    }
    await mkChildren(vendorA.id, "Alpha")
    await mkChildren(vendorB.id, "Beta")
  })

  test("child tables ARE exported (the DB-01 regression: always empty before) and never leak across tenants", async () => {
    const { data } = await buildTenantBackupExport(vendorA.id)
    // every child model the old code silently dropped now carries rows
    expect((data.familyMember as any[]).length).toBeGreaterThanOrEqual(1)
    expect((data.bankAccount as any[]).length).toBeGreaterThanOrEqual(1)
    expect((data.loanInstallment as any[]).length).toBeGreaterThanOrEqual(1)
    expect((data.taxSlab as any[]).length).toBeGreaterThanOrEqual(1)
    expect((data.approvalStep as any[]).length).toBeGreaterThanOrEqual(1)
    expect((data.communicationRecipient as any[]).length).toBeGreaterThanOrEqual(1)
    // vendor-scoped parents scoped correctly
    expect((data.employee as any[]).every((e: any) => e.vendorId === vendorA.id)).toBe(true)
    // tenant isolation on the CHILD pass: vendor B's family members must not ride A's export
    const bEmps = await db.employee.findMany({ where: { vendorId: vendorB.id }, select: { id: true } })
    const bIds = new Set(bEmps.map((e) => e.id))
    expect((data.familyMember as any[]).some((f: any) => bIds.has(f.employeeId))).toBe(false)
  })

  test("export is complete (tableCount parity) and secret/session models never ride the payload", async () => {
    const { data, excluded, expectedTableCount } = await buildTenantBackupExport(vendorA.id)
    expect(Object.keys(data).length).toBe(expectedTableCount - 1) // -1: user safe-fields added by the job layer
    for (const forbidden of ["session", "userMfaSecret", "apiRefreshToken", "apiKey", "pushSubscription", "loginAuditLog", "bgJob"]) {
      expect(data[forbidden]).toBeUndefined()
    }
    expect(excluded.some((e) => e.model === "Session" && e.reason.length > 0)).toBe(true)
    expect(excluded.some((e) => e.model === "Vendor")).toBe(true)
  })
})

// ---------------------------------------------------------------- FIN-01 ---
describe("FIN-01 — ESS loan & advance requests work without employeeId", () => {
  let vendor: { id: string }
  let employee: { id: string }
  let token: string

  beforeAll(async () => {
    vendor = await mkVendor("FIN01 ESS Vendor")
    employee = await mkEmployee(vendor.id, { fullName: "FIN01 ESS Borrower" })
    const user = await mkUser(vendor.id, { role: "EMPLOYEE", name: "FIN01 ESS User", employeeId: employee.id })
    token = await mkSession(user.id, "FULL")
    // approval workflows (same shape the seed uses) — loans/advances submit
    // through the approval engine
    for (const pt of ["LOAN", "ADVANCE"]) {
      const wf = await db.approvalWorkflow.create({ data: { vendorId: vendor.id, name: `FIN01 ${pt} Flow`, processType: pt, active: true } })
      await db.approvalStep.create({ data: { vendorId: vendor.id, workflowId: wf.id, sequence: 1, name: "Owner Approval", approverRole: "VENDOR_OWNER", required: true, rejectBehavior: "REJECT_ALL", departmentScope: false, branchScope: false, amountThreshold: null, allowDelegation: false } })
    }
  })

  test("EMPLOYEE-bearer loans.create with NO employeeId passes validation and self-scopes", async () => {
    const r = await postHrm("loans.create", { principal: 1000, installments: 4, startDate: "2026-10-01", purpose: "FIN-01 regression" }, { bearer: token })
    expect(r.status).toBe(200)
    const loan = await db.loan.findFirst({ where: { vendorId: vendor.id, employeeId: employee.id }, orderBy: { createdAt: "desc" } })
    expect(loan).toBeTruthy()
    expect(Number(loan!.principal)).toBe(1000)
  })

  test("EMPLOYEE-bearer advances.create with NO employeeId passes validation and self-scopes", async () => {
    const r = await postHrm("advances.create", { amount: 800, reason: "FIN-01 regression" }, { bearer: token })
    expect(r.status).toBe(200)
    const adv = await db.advance.findFirst({ where: { vendorId: vendor.id, employeeId: employee.id }, orderBy: { createdAt: "desc" } })
    expect(adv).toBeTruthy()
    expect(Number(adv!.amount)).toBe(800)
  })
})

// ---------------------------------------------------------------- ESS-01 ---
describe("ESS-01 — ESS attendance correction request no longer 403s for EMPLOYEE", () => {
  let vendor: { id: string }
  let employee: { id: string }
  let token: string

  beforeAll(async () => {
    vendor = await mkVendor("ESS01 Vendor")
    employee = await mkEmployee(vendor.id, { fullName: "ESS01 Employee" })
    const user = await mkUser(vendor.id, { role: "EMPLOYEE", name: "ESS01 User", employeeId: employee.id })
    token = await mkSession(user.id, "FULL")
  })

  test("EMPLOYEE bearer (ess.create, no attendance.create) can request a correction", async () => {
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10)
    const r = await postHrm("attendance.corrections.request", { date: yesterday, requestedIn: "09:00", requestedOut: "18:00", reason: "ESS-01 regression" }, { bearer: token })
    expect(r.status).toBe(200)
    const rec = await db.attendanceCorrection.findFirst({ where: { vendorId: vendor.id, employeeId: employee.id }, orderBy: { createdAt: "desc" } })
    expect(rec).toBeTruthy()
    expect(rec!.date).toBe(yesterday)
  })
})

// ---------------------------------------------------------------- ESS-03 ---
describe("ESS-03 — ess.performance hides DRAFT reviews", () => {
  let vendor: { id: string }
  let employee: { id: string }
  let token: string

  beforeAll(async () => {
    vendor = await mkVendor("ESS03 Vendor")
    employee = await mkEmployee(vendor.id, { fullName: "ESS03 Employee" })
    const user = await mkUser(vendor.id, { role: "EMPLOYEE", name: "ESS03 User", employeeId: employee.id })
    token = await mkSession(user.id, "FULL")
    const cycle = await db.reviewCycle.create({ data: { vendorId: vendor.id, name: `ESS03 Cycle A ${uniq()}`, year: 2026, startDate: "2026-01-01", endDate: "2026-12-31" } })
    const cycle2 = await db.reviewCycle.create({ data: { vendorId: vendor.id, name: `ESS03 Cycle B ${uniq()}`, year: 2025, startDate: "2025-01-01", endDate: "2025-12-31" } })
    // @@unique([cycleId, employeeId]) — the DRAFT and FINAL reviews must sit on
    // different cycles for the same employee
    await db.performanceReview.create({ data: { vendorId: vendor.id, cycleId: cycle.id, employeeId: employee.id, status: "DRAFT", overallRating: 2, managerComments: "SECRET draft comments", strengths: "SECRET draft strengths", goals: "SECRET draft goals" } })
    await db.performanceReview.create({ data: { vendorId: vendor.id, cycleId: cycle2.id, employeeId: employee.id, status: "FINAL", overallRating: 4, managerComments: "Final comments", strengths: "Final strengths", goals: "Final goals" } })
  })

  test("only FINAL reviews are visible to the employee", async () => {
    const r = await postHrm("ess.performance", {}, { bearer: token })
    expect(r.status).toBe(200)
    const reviews = r.body?.data?.reviews as any[]
    expect(reviews.length).toBe(1)
    expect(reviews[0].status).toBe("FINAL")
    expect(JSON.stringify(reviews)).not.toContain("SECRET draft")
  })
})

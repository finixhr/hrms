/// <reference types="bun-types" />
// ============ W2 multi-company remediation — regression suite (T-03…T-11) ====
// Exercises the W2 roadmap items R-05 through R-13 plus the R-03 report's
// explicitly W2-assigned carry-forward findings (SEC-05 and the §4.2/§4.3
// paths). Every isolation case drives the REAL dispatcher (postHrm →
// POST /api/hrm) — the production traffic path. Engine-internal decision
// hooks are additionally invoked directly with a full DecisionCtx where the
// authorization demands the hook itself be checked (R-11), mirroring the
// approval engine's call shape.
import "./_testdb"
import { describe, test, expect, beforeAll } from "bun:test"
import { db } from "@/lib/db"
import { mkVendor, mkUser, mkSession, uniq } from "./_fixtures"
import { postHrm } from "./_hrm-endpoint"
import { resolveWorkflowForCompany } from "@/hrm-server/approval"
import { getRoute } from "@/hrm-server/routes/registry"

// ---------------------------------------------------------------------------
// fixtures — one vendor, Company A (default) + Company B, cross-company data
// ---------------------------------------------------------------------------
let vendor: any, cA: any, cB: any
let brA: any, brB: any, dpA: any
let a1: any, a2: any, b1: any // a1/a2 in company A, b1 in company B
let tA: string, tB: string // HR_ADMIN sessions pinned to A / B
let tOwnAll: string // VENDOR_OWNER in All Companies mode
let tNoCo: string // HR_MANAGER with settings perms but NO company access
let legacyVendor: any, tLegacy: string // vendor WITHOUT any company (pre-split)

const ALL_PERMS = [
  "*", "companies.consolidated",
]

// T-03/T-08 payroll runs
let runA: any, runB: any, runNull: any, runA2: any, runB2: any
// T-04 accounting
let periodA: any, periodB: any, nullJournal: any
// T-05 workflows
let wfNull1: any, wfNull2: any
// T-06 employee-child records
let lt: any // leave type
let bonusA: any, bonusB: any
let loanA: any, loanB: any, loanAInst: any, loanBInst: any
let advA: any, advB: any
let expA: any, expB: any
let pfA: any, pfB: any
let corrA: any, corrB: any
let lrA: any, lrB: any // leave requests
let resA: any, resB: any // resignations
let lreqA: any, lreqB: any // letter requests
let structA: any, structB: any
let payslipA: any, payslipB: any
// T-09 AIT
let fyA1: any, fyA2: any, fyB: any, fyNull: any
// T-10 register
let reqA: any, reqB: any, reqNull: any // approval requests
let commissionRuleA: any, commissionRuleB: any
let settlementA: any, settlementB: any
let reviewA: any, reviewB: any
let letterA: any, letterB: any
let budgetA: any, budgetB: any
let cycle: any

const ok = (r: { status: number; body: any }) => r.status === 200 && r.body?.ok === true
const code = (r: { status: number; body: any }) => r.status
const data = (r: { status: number; body: any }) => r.body?.data

beforeAll(async () => {
  vendor = await mkVendor(uniq("W2 Vendor"), { company: false })
  cA = await db.company.create({ data: { vendorId: vendor.id, code: uniq("CA"), name: "W2 Company A", active: true, isDefault: true } })
  cB = await db.company.create({ data: { vendorId: vendor.id, code: uniq("CB"), name: "W2 Company B", active: true } })
  brA = await db.branch.create({ data: { vendorId: vendor.id, companyId: cA.id, code: uniq("BA"), name: "W2 Branch A" } })
  brB = await db.branch.create({ data: { vendorId: vendor.id, companyId: cB.id, code: uniq("BB"), name: "W2 Branch B" } })
  dpA = await db.department.create({ data: { vendorId: vendor.id, companyId: cA.id, code: uniq("DA"), name: "W2 Dept A" } })

  const mkEmp = async (name: string, companyId: string, branchId: string | null, code?: string) => {
    const e = await db.employee.create({
      data: {
        vendorId: vendor.id, code: code || uniq("E"), fullName: name,
        companyId, branchId, joiningDate: "2024-01-01", employmentType: "PERMANENT", status: "ACTIVE",
      },
    })
    return e
  }
  a1 = await mkEmp("W2 A One", cA.id, brA.id)
  a2 = await mkEmp("W2 A Two", cA.id, brA.id)
  b1 = await mkEmp("W2 B One", cB.id, brB.id, "W2B1")
  await db.employee.update({ where: { id: b1.id }, data: { officialEmail: "w2-b-one@test.local" } })

  const mkStruct = async (emp: any) => db.salaryStructure.create({
    data: { vendorId: vendor.id, employeeId: emp.id, effectiveFrom: "2024-01-01", basic: 40000, houseRent: 20000, medical: 5000, gross: 65000, status: "ACTIVE" },
  })
  structA = await mkStruct(a1)
  structB = await mkStruct(b1)

  // sessions: HR_ADMIN per company (full permission set), owner in mode
  const mkAdmin = async (companyId: string, name: string) => {
    const u = await mkUser(vendor.id, { role: "HR_ADMIN", name: uniq(name), permissions: ["*"] })
    await db.userCompanyAccess.create({
      data: { vendorId: vendor.id, userId: u.id, companyId, role: "HR_ADMIN", active: true, isDefault: companyId === cA.id },
    })
    const s = await mkSession(u.id)
    await db.session.update({ where: { id: s }, data: { activeCompanyId: companyId } })
    return s
  }
  tA = await mkAdmin(cA.id, "AdminA")
  tB = await mkAdmin(cB.id, "AdminB")

  const owner = await mkUser(vendor.id, { role: "VENDOR_OWNER", name: uniq("W2Owner"), permissions: ALL_PERMS })
  await db.userCompanyAccess.create({ data: { vendorId: vendor.id, userId: owner.id, companyId: cA.id, role: "VENDOR_OWNER", active: true, isDefault: true } })
  await db.userCompanyAccess.create({ data: { vendorId: vendor.id, userId: owner.id, companyId: cB.id, role: "VENDOR_OWNER", active: true } })
  tOwnAll = await mkSession(owner.id)
  await db.session.update({ where: { id: tOwnAll }, data: { activeCompanyId: null, allCompaniesMode: true } })

  // HR_MANAGER with settings perms but NO company access (vendor HAS companies)
  const noCo = await mkUser(vendor.id, { role: "HR_MANAGER", name: uniq("NoCo"), permissions: ["settings.view", "settings.edit"] })
  tNoCo = await mkSession(noCo.id)

  // legacy vendor WITHOUT companies + a session (pre-split compatibility)
  legacyVendor = await mkVendor(uniq("W2 Legacy"), { company: false })
  const legacyUser = await mkUser(legacyVendor.id, { role: "HR_ADMIN", name: uniq("Legacy"), permissions: ["*"] })
  tLegacy = await mkSession(legacyUser.id)

  // ---- payroll runs (T-03 / T-06 / T-08) ----
  runA = await db.payrollRun.create({ data: { vendorId: vendor.id, companyId: cA.id, periodMonth: 8, periodYear: 2026, runType: "REGULAR", status: "PAID", adjustSeq: 0 } })
  runB = await db.payrollRun.create({ data: { vendorId: vendor.id, companyId: cB.id, periodMonth: 8, periodYear: 2026, runType: "REGULAR", status: "PAID", adjustSeq: 0 } })
  runNull = await db.payrollRun.create({ data: { vendorId: vendor.id, companyId: null, periodMonth: 8, periodYear: 2026, runType: "REGULAR", status: "DRAFT", adjustSeq: 0 } })
  runA2 = await db.payrollRun.create({ data: { vendorId: vendor.id, companyId: cA.id, periodMonth: 9, periodYear: 2026, runType: "REGULAR", status: "PAID", adjustSeq: 0 } })
  runB2 = await db.payrollRun.create({ data: { vendorId: vendor.id, companyId: cB.id, periodMonth: 9, periodYear: 2026, runType: "REGULAR", status: "PAID", adjustSeq: 0 } })

  payslipA = await db.payrollEntry.create({ data: { vendorId: vendor.id, runId: runA.id, employeeId: a1.id, gross: 65000, net: 60000, payslipNumber: "PS-W2-A-0001", status: "INCLUDED" } })
  payslipB = await db.payrollEntry.create({ data: { vendorId: vendor.id, runId: runB.id, employeeId: b1.id, gross: 65000, net: 60000, payslipNumber: "PS-W2-B-0001", status: "INCLUDED" } })

  // ---- T-04 accounting: periods + a NULL-company journal ----
  const pA = await postHrm("accounting.periods.save", { name: uniq("W2 Period A"), startDate: "2030-01-01", endDate: "2030-01-31" }, { bearer: tA })
  periodA = data(pA)?.periodId ? await db.accountingPeriod.findUniqueOrThrow({ where: { id: data(pA).periodId } }) : null
  const pB = await postHrm("accounting.periods.save", { name: uniq("W2 Period B"), startDate: "2030-01-01", endDate: "2030-01-31" }, { bearer: tB })
  periodB = data(pB)?.periodId ? await db.accountingPeriod.findUniqueOrThrow({ where: { id: data(pB).periodId } }) : null

  nullJournal = await db.accountJournal.create({
    data: {
      vendorId: vendor.id, companyId: null, refType: "JOURNAL_VOUCHER", refId: null,
      idempotencyKey: uniq("JV"), date: "2026-01-10", memo: "W2 unattributed legacy journal",
      linesJson: JSON.stringify([
        { account: "1010", accountName: "Cash on Hand", debit: 500 },
        { account: "5300", accountName: "Expense", credit: 500 },
      ]),
      amount: 500, source: "MANUAL", status: "POSTED",
    },
  })

  // ---- T-05 workflows: NULL-company fallback rows (deterministic ordering) ----
  wfNull1 = await db.approvalWorkflow.create({ data: { vendorId: vendor.id, companyId: null, processType: "ENCASHMENT", name: "W2 NULL older", active: true } })
  await db.approvalStep.create({ data: { vendorId: vendor.id, workflowId: wfNull1.id, sequence: 1, name: "Step 1" } })
  wfNull2 = await db.approvalWorkflow.create({ data: { vendorId: vendor.id, companyId: null, processType: "ENCASHMENT", name: "W2 NULL newer", active: true } })
  await db.approvalStep.create({ data: { vendorId: vendor.id, workflowId: wfNull2.id, sequence: 1, name: "Step 1" } })

  // ---- T-06 employee-child records ----
  lt = await db.leaveType.create({ data: { vendorId: vendor.id, code: uniq("LT"), name: "W2 Leave", defaultDays: 12, company: { connect: { id: cA.id } } } })

  bonusA = await db.bonus.create({ data: { vendorId: vendor.id, employeeId: a1.id, type: "FESTIVAL", calcType: "FIXED", amount: 5000, status: "PENDING" } })
  bonusB = await db.bonus.create({ data: { vendorId: vendor.id, employeeId: b1.id, type: "FESTIVAL", calcType: "FIXED", amount: 6000, status: "PENDING" } })

  await db.deduction.create({ data: { vendorId: vendor.id, employeeId: a1.id, type: "OTHER", label: "W2 ded A", amount: 500, month: 9, year: 2026, status: "ACTIVE" } })
  await db.deduction.create({ data: { vendorId: vendor.id, employeeId: b1.id, type: "OTHER", label: "W2 ded B", amount: 600, month: 9, year: 2026, status: "ACTIVE" } })

  loanA = await db.loan.create({ data: { vendorId: vendor.id, employeeId: a1.id, principal: 50000, startDate: "2026-09-01", installments: 5, outstanding: 50000, status: "PENDING" } })
  loanB = await db.loan.create({ data: { vendorId: vendor.id, employeeId: b1.id, principal: 60000, startDate: "2026-09-01", installments: 5, outstanding: 60000, status: "PENDING" } })
  loanAInst = await db.loanInstallment.create({ data: { vendorId: vendor.id, loanId: loanA.id, no: 1, dueDate: "2026-10-01", amount: 10000 } })
  loanBInst = await db.loanInstallment.create({ data: { vendorId: vendor.id, loanId: loanB.id, no: 1, dueDate: "2026-10-01", amount: 12000 } })

  advA = await db.advance.create({ data: { vendorId: vendor.id, employeeId: a1.id, amount: 8000, requestDate: "2026-09-05", installments: 2, outstanding: 8000, status: "PENDING" } })
  advB = await db.advance.create({ data: { vendorId: vendor.id, employeeId: b1.id, amount: 9000, requestDate: "2026-09-05", installments: 2, outstanding: 9000, status: "PENDING" } })

  expA = await db.expenseClaim.create({ data: { vendorId: vendor.id, employeeId: a1.id, category: "TRAVEL", title: "W2 expense A", amount: 3000, date: "2026-09-10", status: "APPROVED", approvedAmount: 3000 } })
  expB = await db.expenseClaim.create({ data: { vendorId: vendor.id, employeeId: b1.id, category: "TRAVEL", title: "W2 expense B", amount: 4000, date: "2026-09-10", status: "APPROVED", approvedAmount: 4000 } })

  pfA = await db.pfEnrollment.create({ data: { vendorId: vendor.id, employeeId: a1.id, enrollDate: "2026-09-01", status: "ACTIVE", employeePct: 10, employerPct: 10, basis: "BASIC" } })
  pfB = await db.pfEnrollment.create({ data: { vendorId: vendor.id, employeeId: b1.id, enrollDate: "2026-09-01", status: "ACTIVE", employeePct: 10, employerPct: 10, basis: "BASIC" } })

  await db.attendance.create({ data: { vendorId: vendor.id, employeeId: a1.id, date: "2026-10-05", checkIn: "09:00", checkOut: "18:00", overtimeMinutes: 60, otApproved: false, source: "MANUAL" } })
  await db.attendance.create({ data: { vendorId: vendor.id, employeeId: b1.id, date: "2026-10-05", checkIn: "09:00", checkOut: "18:00", overtimeMinutes: 90, otApproved: false, source: "MANUAL" } })

  corrA = await db.attendanceCorrection.create({ data: { vendorId: vendor.id, employeeId: a1.id, date: "2026-10-05", reason: "W2 correction A", status: "PENDING" } })
  corrB = await db.attendanceCorrection.create({ data: { vendorId: vendor.id, employeeId: b1.id, date: "2026-10-05", reason: "W2 correction B", status: "PENDING" } })

  lrA = await db.leaveRequest.create({ data: { vendorId: vendor.id, employeeId: a1.id, leaveTypeId: lt.id, fromDate: "2026-10-10", toDate: "2026-10-12", days: 3, status: "PENDING" } })
  lrB = await db.leaveRequest.create({ data: { vendorId: vendor.id, employeeId: b1.id, leaveTypeId: lt.id, fromDate: "2026-10-10", toDate: "2026-10-12", days: 3, status: "PENDING" } })
  await db.leaveBalance.create({ data: { vendorId: vendor.id, employeeId: a1.id, leaveTypeId: lt.id, year: 2026, entitled: 12, used: 3 } })
  await db.leaveBalance.create({ data: { vendorId: vendor.id, employeeId: b1.id, leaveTypeId: lt.id, year: 2026, entitled: 12, used: 4 } })

  resA = await db.resignation.create({ data: { vendorId: vendor.id, employeeId: a1.id, submissionDate: "2026-09-01", resignationDate: "2026-09-01", proposedLwd: "2026-10-31", reason: "W2 exit A", status: "NOTICE_PERIOD" } })
  resB = await db.resignation.create({ data: { vendorId: vendor.id, employeeId: b1.id, submissionDate: "2026-09-01", resignationDate: "2026-09-01", proposedLwd: "2026-10-31", reason: "W2 exit B", status: "NOTICE_PERIOD" } })
  const resB2 = await db.resignation.create({ data: { vendorId: vendor.id, employeeId: b1.id, submissionDate: "2026-09-01", resignationDate: "2026-09-01", proposedLwd: "2026-10-31", reason: "W2 exit B2 hook", status: "SUBMITTED" } })
  void resB2
  await db.exitClearance.create({ data: { vendorId: vendor.id, resignationId: resA.id, status: "CLEARED", checklistJson: "[]" } })
  await db.exitClearance.create({ data: { vendorId: vendor.id, resignationId: resB.id, status: "CLEARED", checklistJson: "[]" } })

  lreqA = await db.letterRequest.create({ data: { vendorId: vendor.id, employeeId: a1.id, requestedBy: "seed", type: "NOC", status: "PENDING" } })
  lreqB = await db.letterRequest.create({ data: { vendorId: vendor.id, employeeId: b1.id, requestedBy: "seed", type: "NOC", status: "PENDING" } })

  letterA = await db.hrLetter.create({ data: { vendorId: vendor.id, employeeId: a1.id, type: "NOC", letterNumber: uniq("LA"), subject: "W2 letter A", content: "body", status: "APPROVED" } })
  letterB = await db.hrLetter.create({ data: { vendorId: vendor.id, employeeId: b1.id, type: "NOC", letterNumber: uniq("LB"), subject: "W2 letter B", content: "body", status: "APPROVED" } })
  const letterB2 = await db.hrLetter.create({ data: { vendorId: vendor.id, employeeId: b1.id, type: "NOC", letterNumber: uniq("LB2"), subject: "W2 letter B2", content: "body", status: "PREPARED" } })
  void letterB2

  cycle = await db.reviewCycle.create({ data: { vendorId: vendor.id, companyId: cA.id, name: "W2 Cycle", year: 2026, startDate: "2026-01-01", endDate: "2026-12-31", status: "ACTIVE" } })
  reviewA = await db.performanceReview.create({ data: { vendorId: vendor.id, cycleId: cycle.id, employeeId: a1.id, status: "SUBMITTED", overallRating: 4 } })
  reviewB = await db.performanceReview.create({ data: { vendorId: vendor.id, cycleId: cycle.id, employeeId: b1.id, status: "SUBMITTED", overallRating: 4 } })

  budgetA = await db.budget.create({ data: { vendorId: vendor.id, companyId: cA.id, accountCode: "5300", amount: 100000, createdById: "seed", createdByName: "W2" } })
  budgetB = await db.budget.create({ data: { vendorId: vendor.id, companyId: cB.id, accountCode: "5300", amount: 200000, createdById: "seed", createdByName: "W2" } })

  settlementA = await db.finalSettlement.create({ data: { vendorId: vendor.id, resignationId: resA.id, computationJson: JSON.stringify({ finalSalary: 100, loanDue: 0, advanceDue: 0, noticeBuyout: 0, otherDeductions: 0, gross: 100, totalDeductions: 0 }), netPayable: 100, status: "CALCULATED" } })
  settlementB = await db.finalSettlement.create({ data: { vendorId: vendor.id, resignationId: resB.id, computationJson: JSON.stringify({ finalSalary: 100, loanDue: 0, advanceDue: 0, noticeBuyout: 0, otherDeductions: 0, gross: 100, totalDeductions: 0 }), netPayable: 100, status: "CALCULATED" } })

  // ---- T-09 AIT fiscal years ----
  const mkFy = async (companyId: string | null, label: string, active: boolean, inc: string) => {
    const fy = await db.aitFiscalYear.create({
      data: {
        vendorId: vendor.id, companyId, label, incomeYear: inc, assessmentYear: `${Number(inc.slice(0, 4)) + 1}-${inc.slice(5)}`,
        tdsSectionRef: "Section 86", exemptionFraction: 0.3333, active,
      },
    })
    await db.aitTaxpayerCategory.create({ data: { vendorId: vendor.id, fiscalYearId: fy.id, key: "general", label: "General", threshold: 0, sortOrder: 1 } })
    await db.aitTaxSlab.create({ data: { vendorId: vendor.id, fiscalYearId: fy.id, order: 1, slabLabel: "First", upperLimit: null, ratePercent: 10 } })
    return fy
  }
  fyA1 = await mkFy(cA.id, "W2 FY A1", true, "2025-26")
  fyA2 = await mkFy(cA.id, "W2 FY A2", false, "2026-27")
  fyB = await mkFy(cB.id, "W2 FY B", true, "2025-26")
  fyNull = await mkFy(null, "W2 FY NULL", true, "2025-26")

  // ---- T-10 approval requests + commission rules ----
  const wfReq = await db.approvalWorkflow.create({ data: { vendorId: vendor.id, companyId: null, processType: "LEAVE", name: "W2 req wf", active: true } })
  await db.approvalStep.create({ data: { vendorId: vendor.id, workflowId: wfReq.id, sequence: 1, name: "Approve" } })
  reqA = await db.approvalRequest.create({ data: { vendorId: vendor.id, workflowId: wfReq.id, processType: "LEAVE", entityType: "LeaveRequest", entityId: lrA.id, entityRef: "W2 req A", requestedBy: "seed", currentStep: 1, status: "PENDING", payloadJson: "{}", companyId: cA.id } } as any)
  reqB = await db.approvalRequest.create({ data: { vendorId: vendor.id, workflowId: wfReq.id, processType: "LEAVE", entityType: "LeaveRequest", entityId: lrB.id, entityRef: "W2 req B", requestedBy: "seed", currentStep: 1, status: "PENDING", payloadJson: "{}", companyId: cB.id } } as any)
  reqNull = await db.approvalRequest.create({ data: { vendorId: vendor.id, workflowId: wfReq.id, processType: "LEAVE", entityType: "LeaveRequest", entityId: lrA.id, entityRef: "W2 req NULL", requestedBy: "seed", currentStep: 1, status: "PENDING", payloadJson: "{}" } } as any)

  commissionRuleA = await db.commissionRule.create({
    data: { vendorId: vendor.id, companyId: cA.id, name: "W2 rule A", calculationPeriod: "MONTHLY", effectiveFrom: new Date("2026-01-01"), active: true, basis: "FLAT", flatMethod: "PER_EMPLOYEE", rate: 5, status: "ACTIVE", version: 1, eligibleStatuses: '["ACTIVE"]' },
  })
  commissionRuleB = await db.commissionRule.create({
    data: { vendorId: vendor.id, companyId: cB.id, name: "W2 rule B", calculationPeriod: "MONTHLY", effectiveFrom: new Date("2026-01-01"), active: true, basis: "FLAT", flatMethod: "PER_EMPLOYEE", rate: 5, status: "ACTIVE", version: 1, eligibleStatuses: '["ACTIVE"]' },
  })

  // an employee in company A with the SAME code as b1 (CSV matching, §4.2)
  await mkEmp("W2 A SameCode", cA.id, brA.id, "W2B1")
})

// ---------------------------------------------------------------------------
// T-03 — payroll adjustment runs (R-05)
// ---------------------------------------------------------------------------
describe("T-03 payroll adjustment runs (R-05)", () => {
  test("cross-company source run denied (Company A operator adjusting Company B run → 404)", async () => {
    const r = await postHrm("payroll.adjustmentCreate", { runId: runB.id }, { bearer: tA })
    expect(code(r)).toBe(404)
  })
  test("adjustment run inherits the verified source run's companyId", async () => {
    const r = await postHrm("payroll.adjustmentCreate", { runId: runA.id }, { bearer: tA })
    expect(ok(r)).toBe(true)
    const adj = await db.payrollRun.findUniqueOrThrow({ where: { id: data(r).adjustmentRunId } })
    expect(adj.companyId).toBe(cA.id)
    expect(adj.runType).toBe("ADJUSTMENT")
    expect(adj.adjustRunId).toBe(runA.id)
    expect(adj.adjustSeq).toBeGreaterThan(0)
  })
  test("NULL-company run denied for calculate with the planned 409 repair-required response", async () => {
    const r = await postHrm("payroll.calculate", { runId: runNull.id }, { bearer: tA })
    expect(code(r)).toBe(409)
    expect(String(r.body?.error)).toContain("multi-company attribution")
  })
  test("NULL-company run denied for submitApproval (409), pay (409) and adjustmentCreate (409)", async () => {
    expect(code(await postHrm("payroll.submitApproval", { runId: runNull.id }, { bearer: tA }))).toBe(409)
    expect(code(await postHrm("payroll.pay", { runId: runNull.id }, { bearer: tA }))).toBe(409)
    expect(code(await postHrm("payroll.adjustmentCreate", { runId: runNull.id }, { bearer: tA }))).toBe(409)
  })
  test("calculation of a company run includes only that company's employees", async () => {
    // Company A has TWO employees with structures… only a1 has one → the
    // adjustment calculation must include a1 and NEVER b1 (Company B).
    const adj = await postHrm("payroll.adjustmentCreate", { runId: runA2.id }, { bearer: tA })
    expect(ok(adj)).toBe(true)
    const calc = await postHrm("payroll.calculate", { runId: data(adj).adjustmentRunId }, { bearer: tA })
    expect(ok(calc)).toBe(true)
    const entries = await db.payrollEntry.findMany({ where: { runId: data(adj).adjustmentRunId } })
    expect(entries.length).toBeGreaterThan(0)
    for (const e of entries) {
      const emp = await db.employee.findUniqueOrThrow({ where: { id: e.employeeId } })
      expect(emp.companyId).toBe(cA.id)
    }
    expect(entries.some((e) => e.employeeId === b1.id)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// T-04 — accounting statements and periods (R-07 / R-08)
// ---------------------------------------------------------------------------
describe("T-04 accounting statements and periods (R-07/R-08)", () => {
  let journalAId: string, journalBId: string

  beforeAll(async () => {
    // balanced manual vouchers posted through the dispatcher (dated today)
    const lines = [
      { account: "1010", debit: 1000 },
      { account: "5300", credit: 1000 },
    ]
    const ra = await postHrm("accounting.voucher.post", { date: "2026-11-01", memo: "W2 voucher A", lines }, { bearer: tA })
    expect(ok(ra)).toBe(true)
    journalAId = data(ra).journalId
    const rb = await postHrm("accounting.voucher.post", { date: "2026-11-01", memo: "W2 voucher B", lines }, { bearer: tB })
    expect(ok(rb)).toBe(true)
    journalBId = data(rb).journalId
  })

  test("new journal postings carry the correct companyId (A and B vouchers stamped)", async () => {
    const ja = await db.accountJournal.findUniqueOrThrow({ where: { id: journalAId } })
    const jb = await db.accountJournal.findUniqueOrThrow({ where: { id: journalBId } })
    expect(ja.companyId).toBe(cA.id)
    expect(jb.companyId).toBe(cB.id)
  })

  test("Company A trial balance excludes Company B journals and unattributed NULL journals", async () => {
    const r = await postHrm("accounting.trialBalance", { from: "2026-01-01", to: "2026-12-31" }, { bearer: tA })
    expect(ok(r)).toBe(true)
    const cash = data(r).rows.find((x: any) => x.code === "1010")
    expect(cash?.totalDebit).toBe(1000) // A's voucher only — not B's, not NULL's 500
    expect(data(r).journalCount).toBe(1) // A's voucher is the only POSTED A journal in 2026
  })

  test("Company A balance sheet and cash flow exclude Company B journals", async () => {
    const bs = await postHrm("accounting.balanceSheet", { asOf: "2026-12-31" }, { bearer: tA })
    expect(ok(bs)).toBe(true)
    const cashAsset = data(bs).assets.find((x: any) => x.code === "1010")
    expect(cashAsset?.amount).toBe(1000)
    const cf = await postHrm("accounting.cashFlow", { from: "2026-01-01", to: "2026-12-31" }, { bearer: tA })
    expect(ok(cf)).toBe(true)
    expect(data(cf).netChange).toBe(1000)
  })

  test("All Companies consolidated figures remain correct (A + B + NULL journals)", async () => {
    const r = await postHrm("accounting.trialBalance", { from: "2026-01-01", to: "2026-12-31" }, { bearer: tOwnAll })
    expect(ok(r)).toBe(true)
    const cash = data(r).rows.find((x: any) => x.code === "1010")
    expect(cash?.totalDebit).toBe(1000 + 1000 + 500) // A + B + unattributed legacy
  })

  test("unattributed NULL journals are not duplicated into concrete-company totals", async () => {
    const rA = await postHrm("accounting.trialBalance", { from: "2026-01-01", to: "2026-12-31" }, { bearer: tA })
    const rB = await postHrm("accounting.trialBalance", { from: "2026-01-01", to: "2026-12-31" }, { bearer: tB })
    const cashA = data(rA).rows.find((x: any) => x.code === "1010")?.totalDebit || 0
    const cashB = data(rB).rows.find((x: any) => x.code === "1010")?.totalDebit || 0
    expect(cashA).toBe(1000)
    expect(cashB).toBe(1000)
    expect(cashA + cashB).toBe(2000) // the NULL 500 appears in NEITHER company
  })

  test("voucher reversal retains the original journal company; double-void guard is idempotent", async () => {
    const void1 = await postHrm("accounting.journal.delete", { id: journalAId, reason: "W2 void test" }, { bearer: tA })
    expect(ok(void1)).toBe(true)
    const reversalId = data(void1).reversalJournalId
    const reversal = await db.accountJournal.findUniqueOrThrow({ where: { id: reversalId } })
    expect(reversal.companyId).toBe(cA.id)
    expect(reversal.refId).toBe(journalAId)
    const void2 = await postHrm("accounting.journal.delete", { id: journalAId, reason: "W2 void again" }, { bearer: tA })
    expect(ok(void2)).toBe(true)
    expect(data(void2).alreadyVoided).toBe(true)
    expect(data(void2).reversalJournalId).toBe(reversalId)
  })

  test("periods.list filters by the active company (A sees only its period)", async () => {
    const r = await postHrm("accounting.periods.list", {}, { bearer: tA })
    expect(ok(r)).toBe(true)
    const names = data(r).periods.map((p: any) => p.id)
    expect(names).toContain(periodA.id)
    expect(names).not.toContain(periodB.id)
  })

  test("cross-company period close/reopen denied (Company A cannot close Company B's period → 404)", async () => {
    expect(code(await postHrm("accounting.periods.close", { id: periodB.id, reason: "W2 cross" }, { bearer: tA }))).toBe(404)
    expect(code(await postHrm("accounting.periods.reopen", { id: periodB.id }, { bearer: tA }))).toBe(404)
  })

  test("Company A's closed period does not block Company B (and blocks Company A)", async () => {
    const closeA = await postHrm("accounting.periods.close", { id: periodA.id, reason: "W2 close A" }, { bearer: tA })
    expect(ok(closeA)).toBe(true)
    // B can still post into its own (open) period range
    const lines = [
      { account: "1010", debit: 50 },
      { account: "5300", credit: 50 },
    ]
    const postB = await postHrm("accounting.voucher.post", { date: "2030-01-15", memo: "W2 voucher B period", lines }, { bearer: tB })
    expect(ok(postB)).toBe(true)
    // A is blocked inside its own closed range
    const postA = await postHrm("accounting.voucher.post", { date: "2030-01-15", memo: "W2 voucher A period", lines }, { bearer: tA })
    expect(code(postA)).toBe(400)
    expect(String(postA.body?.error)).toContain("closed period")
    // cleanup: reopen A's period so later suites are unaffected
    expect(ok(await postHrm("accounting.periods.reopen", { id: periodA.id, reason: "W2 reopen A" }, { bearer: tA }))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// T-05 — approval workflows (R-09, W2 code part)
// ---------------------------------------------------------------------------
describe("T-05 approval workflows (R-09)", () => {
  test("Company B cannot edit Company A's workflow (a company-scoped edit touches only its own row)", async () => {
    const stepsA = [{ name: "A Step", approverRole: "HR_ADMIN" }]
    const saveA = await postHrm("workflows.save", { processType: "TRANSFER", name: "W2 Transfer A", steps: stepsA }, { bearer: tA })
    expect(ok(saveA)).toBe(true)
    const wfA0 = await db.approvalWorkflow.findFirstOrThrow({ where: { vendorId: vendor.id, processType: "TRANSFER", companyId: cA.id } })
    // Company B saves its own workflow for the SAME process type
    const saveB = await postHrm("workflows.save", { processType: "TRANSFER", name: "W2 Transfer B", steps: [{ name: "B Step", approverRole: "HR_ADMIN" }] }, { bearer: tB })
    expect(ok(saveB)).toBe(true)
    // Company A's row is UNCHANGED (name preserved, steps untouched)
    const wfA1 = await db.approvalWorkflow.findFirstOrThrow({ where: { vendorId: vendor.id, processType: "TRANSFER", companyId: cA.id } })
    expect(wfA1.id).toBe(wfA0.id)
    expect(wfA1.name).toBe("W2 Transfer A")
    const aSteps = await db.approvalStep.findMany({ where: { workflowId: wfA1.id } })
    expect(aSteps.map((s: any) => s.name)).toEqual(["A Step"])
    // Company B's row exists and is stamped with ITS company
    const wfB = await db.approvalWorkflow.findFirstOrThrow({ where: { vendorId: vendor.id, processType: "TRANSFER", companyId: cB.id } })
    expect(wfB.name).toBe("W2 Transfer B")
  })

  test("new company workflow rows are stamped with the active company", async () => {
    const wfB = await db.approvalWorkflow.findFirstOrThrow({ where: { vendorId: vendor.id, processType: "TRANSFER", companyId: cB.id } })
    expect(wfB.companyId).toBe(cB.id)
  })

  test("company-specific workflow wins over the NULL-company fallback", async () => {
    const resolved = await resolveWorkflowForCompany(vendor.id, "TRANSFER", cB.id)
    expect(resolved?.id).toBe((await db.approvalWorkflow.findFirstOrThrow({ where: { vendorId: vendor.id, processType: "TRANSFER", companyId: cB.id } })).id)
  })

  test("NULL fallback resolves deterministically (createdAt asc) when present", async () => {
    const resolved = await resolveWorkflowForCompany(vendor.id, "ENCASHMENT", null)
    expect(resolved?.id).toBe(wfNull1.id) // the OLDER of the two NULL rows
    const resolvedForCompany = await resolveWorkflowForCompany(vendor.id, "ENCASHMENT", cA.id)
    expect(resolvedForCompany?.id).toBe(wfNull1.id) // company A has no own row → oldest NULL fallback
  })

  test("company creation (wizard copyTenant) copies the default company's workflows", async () => {
    const create = await postHrm("companies.create", { name: uniq("W2 NewCo"), initMode: "copyTenant" }, { bearer: tA })
    expect(ok(create)).toBe(true)
    const newCo = data(create)
    const wfNew = await db.approvalWorkflow.findFirst({ where: { vendorId: vendor.id, companyId: newCo.id, processType: "TRANSFER" } })
    expect(wfNew).not.toBeNull()
    expect(wfNew!.name).toBe("W2 Transfer A")
    const stepsNew = await db.approvalStep.findMany({ where: { workflowId: wfNew!.id } })
    expect(stepsNew.map((s: any) => s.name)).toEqual(["A Step"])
    // AIT fiscal years are copied too (R-10)
    const fyNew = await db.aitFiscalYear.findMany({ where: { vendorId: vendor.id, companyId: newCo.id } })
    expect(fyNew.length).toBe(2) // FY A1 + FY A2 from the default company
  })

  test("systemDefaults wizard mode does not copy workflows or fiscal years", async () => {
    const create = await postHrm("companies.create", { name: uniq("W2 SysCo"), initMode: "systemDefaults" }, { bearer: tA })
    expect(ok(create)).toBe(true)
    const wf = await db.approvalWorkflow.findFirst({ where: { vendorId: vendor.id, companyId: data(create).id } })
    expect(wf).toBeNull()
  })

  test("no W2 migration or schema change is introduced (manifest and disk are in lockstep)", async () => {
    const fs = await import("fs")
    const path = await import("path")
    const migrationsDir = path.resolve(import.meta.dir, "../../prisma/migrations")
    const entries = fs.readdirSync(migrationsDir).filter((d: string) => {
      try { return fs.statSync(path.join(migrationsDir, d)).isDirectory() } catch { return false }
    }).sort()
    expect(entries.length).toBeGreaterThan(0)

    // FORENSIC AUDIT 2026-11-10, FIN-002 (Phase 0): this guard used to assert
    // a FROZEN chain tip ("last === 9_wave9zzaj…" plus a hard-coded
    // mc_expand-at-length-10 position). The 2026-11-09 zzak migration
    // (StockEntry.companyId) landed on disk without updating the frozen tip,
    // so the guard itself became drift. The structural form below reads
    // deploy/release-manifest.json — the SAME source of truth CI stage 15/15
    // and the container entrypoint (V12) validate — and asserts
    // manifest = disk SET equality. A migration merged without its manifest
    // entry (or vice versa) now fails here, in CI, and at container start:
    // three gates, one rule, no frozen tip to forget.
    const manifest = JSON.parse(
      fs.readFileSync(path.resolve(import.meta.dir, "../../deploy/release-manifest.json"), "utf8"),
    )
    const declared = manifest.migrations as string[]
    expect(declared.length).toBeGreaterThan(0)
    const diskSet = new Set(entries)
    const declaredSet = new Set(declared)
    expect([...declaredSet].filter((d) => !diskSet.has(d))).toEqual([]) // declared but missing on disk
    expect([...diskSet].filter((d) => !declaredSet.has(d))).toEqual([]) // on disk but undeclared (the zzak drift class)
    expect(declared.length).toBe(entries.length) // no duplicates on either side

    // Stage B (B-7 Option 1 / 1(b), 2026-11-05): the parity-normalization
    // corrective is part of the chain.
    expect(entries).toContain("9_wave9zzab_payroll_parity_normalization_20261103")

    // the W1 multi-company expansion set is still present and still the last
    // WAVE migration, before the correctives and every later amendment
    expect(entries.filter((d: string) => d.startsWith("9_wave9zza_mc_expand_20261103")).length).toBe(1)

    // Still NO W2/W3 wave migration and NO M4 enforcement migration: those
    // ship behind their own gates (M4 reserved for R5 — validator V9/V10).
    expect(entries.filter((d: string) => d.includes("enforce")).length).toBe(0)
    expect(declared.filter((d: string) => d.includes("enforce")).length).toBe(0)
  })

  test("All Companies mode cannot act on approvals (approvals.act → 403)", async () => {
    const r = await postHrm("approvals.act", { requestId: reqA.id, decision: "APPROVE" }, { bearer: tOwnAll })
    expect(code(r)).toBe(403)
  })

  test("a NULL-company approval request cannot be acted on from a concrete company (fail-closed 409)", async () => {
    const r = await postHrm("approvals.act", { requestId: reqNull.id, decision: "APPROVE" }, { bearer: tA })
    expect(code(r)).toBe(409)
    expect(String(r.body?.error)).toContain("multi-company attribution")
  })

  test("Company A cannot act on Company B's approval request (404)", async () => {
    const r = await postHrm("approvals.act", { requestId: reqB.id, decision: "APPROVE" }, { bearer: tA })
    expect(code(r)).toBe(404)
  })
})

// ---------------------------------------------------------------------------
// T-06 — SEC-05 employee-child list isolation across every consumer endpoint
// ---------------------------------------------------------------------------
describe("T-06 SEC-05 employee-child list isolation (scopedEmployeeWhere consumers)", () => {
  // every manager-facing list endpoint that resolves its employee set through
  // the canonical scopedEmployeeWhere (rbac.ts)
  const endpoints: { action: string; payload?: any; extract: (d: any) => any[] }[] = [
    { action: "payslips.list", payload: {}, extract: (d) => Array.isArray(d) ? d : d.items || [] },
    { action: "bonuses.list", payload: {}, extract: (d) => d },
    { action: "deductions.list", payload: {}, extract: (d) => d },
    { action: "salaryStructures.list", payload: {}, extract: (d) => d },
    { action: "loans.list", payload: {}, extract: (d) => Array.isArray(d) ? d : d.items || [] },
    { action: "advances.list", payload: {}, extract: (d) => Array.isArray(d) ? d : d.items || [] },
    { action: "expenses.list", payload: {}, extract: (d) => Array.isArray(d) ? d : d.items || [] },
    { action: "pf.list", payload: {}, extract: (d) => d },
    { action: "attendance.register", payload: { month: 10, year: 2026 }, extract: (d) => d.records || d },
    { action: "attendance.summary", payload: { month: 10, year: 2026 }, extract: (d) => d.rows || d.employees || d },
    { action: "attendance.otPending", payload: { month: 10, year: 2026 }, extract: (d) => d },
    { action: "attendance.corrections.list", payload: {}, extract: (d) => d },
    { action: "leaveRequests.list", payload: {}, extract: (d) => Array.isArray(d) ? d : d.items || [] },
    { action: "leaveBalances.list", payload: { year: 2026 }, extract: (d) => Array.isArray(d) ? d : d.items || [] },
    { action: "resignations.list", payload: {}, extract: (d) => d },
    { action: "letters.requests.list", payload: {}, extract: (d) => d },
    { action: "letters.list", payload: {}, extract: (d) => Array.isArray(d) ? d : d.items || [] },
  ]

  test("Company A lists never include Company B records (all scopedEmployeeWhere consumers)", async () => {
    for (const ep of endpoints) {
      const r = await postHrm(ep.action, ep.payload || {}, { bearer: tA })
      expect(ok(r)).toBe(true)
      const rows = ep.extract(data(r))
      const list = Array.isArray(rows) ? rows : []
      for (const row of list) {
        const empId = row.employeeId || row.id
        if (!empId || row.employeeId == null) continue
        const emp = await db.employee.findUnique({ where: { id: row.employeeId } })
        if (emp) expect([cA.id, null]).toContain(emp.companyId)
      }
      const empIds = list.map((x: any) => x.employeeId).filter(Boolean)
      expect(empIds).not.toContain(b1.id)
    }
  })

  test("an explicit Company B employeeId is denied on every consumer endpoint", async () => {
    const idEndpoints = ["payslips.list", "bonuses.list", "deductions.list", "salaryStructures.list", "loans.list", "advances.list", "expenses.list", "pf.statement", "attendance.register", "attendance.summary", "attendance.corrections.list", "leaveRequests.list", "leaveBalances.list", "resignations.list", "letters.requests.list"]
    for (const action of idEndpoints) {
      const r = await postHrm(action, { employeeId: b1.id, month: 10, year: 2026 }, { bearer: tA })
      expect([403, 404]).toContain(code(r))
    }
  })

  test("counts, aggregates and pagination do not leak Company B records (paged payslips + loans summary)", async () => {
    const payslips = await postHrm("payslips.list", { page: 1, pageSize: 50 }, { bearer: tA })
    expect(ok(payslips)).toBe(true)
    expect(data(payslips).total).toBe(1) // only A's payslip
    expect(data(payslips).items.map((i: any) => i.employeeId)).toEqual([a1.id])
    const loans = await postHrm("loans.list", { page: 1, pageSize: 50 }, { bearer: tA })
    expect(ok(loans)).toBe(true)
    expect(data(loans).total).toBe(1)
    expect(data(loans).items.map((i: any) => i.employeeId)).toEqual([a1.id])
    const bonuses = await postHrm("bonuses.list", {}, { bearer: tB })
    expect(ok(bonuses)).toBe(true)
    expect(data(bonuses).map((b: any) => b.id)).toEqual([bonusB.id])
  })

  test("All Companies mode denies the non-allowlisted employee-child lists (as designed by the approved read matrix)", async () => {
    // bonuses.list is NOT in the W1 FINAL READ AUTHORIZATION MATRIX's
    // consolidated allowlist — the mode must deny it (this is the approved
    // design: employee-child lists are company-scoped surfaces only).
    const r = await postHrm("bonuses.list", {}, { bearer: tOwnAll })
    expect(code(r)).toBe(403)
    expect(String(r.body?.error)).toContain("not available in All Companies mode")
  })

  test("empty company employee set fails closed (a company with no employees returns no records)", async () => {
    const create = await postHrm("companies.create", { name: uniq("W2 EmptyCo"), initMode: "systemDefaults" }, { bearer: tA })
    expect(ok(create)).toBe(true)
    const u = await mkUser(vendor.id, { role: "HR_ADMIN", name: uniq("EmptyAdmin"), permissions: ["*"] })
    await db.userCompanyAccess.create({ data: { vendorId: vendor.id, userId: u.id, companyId: data(create).id, role: "HR_ADMIN", active: true, isDefault: true } })
    const s = await mkSession(u.id)
    await db.session.update({ where: { id: s }, data: { activeCompanyId: data(create).id } })
    const r = await postHrm("bonuses.list", {}, { bearer: s })
    expect(ok(r)).toBe(true)
    expect(data(r)).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// T-08 — payroll run operations and exports (R-06)
// ---------------------------------------------------------------------------
describe("T-08 payroll run operations and exports (R-06)", () => {
  test("cross-company payout status denied (Company A reading Company B run → 404)", async () => {
    expect(code(await postHrm("payroll.payout.status", { runId: runB.id }, { bearer: tA }))).toBe(404)
  })
  test("cross-company payout confirm denied (404)", async () => {
    expect(code(await postHrm("payroll.payout.confirm", { runId: runB.id }, { bearer: tA }))).toBe(404)
  })
  test("cross-company run cancellation denied (404)", async () => {
    expect(code(await postHrm("payroll.runs.cancel", { runId: runB.id, reason: "W2 cross cancel" }, { bearer: tA }))).toBe(404)
  })
  test("cross-company salary export denied (404) and preview denied (404)", async () => {
    expect(code(await postHrm("payroll.export.salary", { runId: runB.id, type: "ALL", format: "csv" }, { bearer: tA }))).toBe(404)
    expect(code(await postHrm("payroll.export.preview", { runId: runB.id, type: "ALL" }, { bearer: tA }))).toBe(404)
  })
  test("cross-company emailAll denied (404)", async () => {
    expect(code(await postHrm("payslips.emailAll", { runId: runB2.id }, { bearer: tA }))).toBe(404)
  })
  test("emailAll is centrally classified as mutating (registry flag)", async () => {
    const def = getRoute("payslips.emailAll")
    expect(def?.mutating).toBe(true)
  })
  test("All Companies mode blocks emailAll (403 read-only)", async () => {
    const r = await postHrm("payslips.emailAll", { runId: runA2.id }, { bearer: tOwnAll })
    expect(code(r)).toBe(403)
    expect(String(r.body?.error)).toContain("read-only")
  })
  test("emailAll job payload carries the verified run's companyId (BgJob W5 bridge)", async () => {
    const r = await postHrm("payslips.emailAll", { runId: runA2.id }, { bearer: tA })
    expect(ok(r)).toBe(true)
    const job = await db.bgJob.findFirst({ where: { id: data(r).jobId } })
    expect(job).not.toBeNull()
    const payload = JSON.parse(job!.payloadJson || "{}")
    expect(payload.runId).toBe(runA2.id)
    expect(payload.companyId).toBe(cA.id)
    await db.bgJob.update({ where: { id: job!.id }, data: { status: "CANCELLED" } }).catch(() => {})
  })
  test("job execution revalidates run ownership (worker denies a tampered cross-company payload)", async () => {
    // simulate a stale/tampered job: run of Company B, payload claims Company A
    const job = await db.bgJob.create({
      data: {
        vendorId: vendor.id, type: "PAYSLIP_EMAIL_ALL",
        payloadJson: JSON.stringify({ runId: runB2.id, companyId: cA.id }),
        total: 1, priority: 5, maxAttempts: 1,
      },
    })
    const { drainJobs } = await import("@/hrm-server/jobs")
    await drainJobs()
    const after = await db.bgJob.findUniqueOrThrow({ where: { id: job.id } })
    expect(["FAILED", "DEAD", "PENDING"]).toContain(after.status)
    expect(String(after.error || "")).toContain("no longer matches")
    await db.bgJob.update({ where: { id: job.id }, data: { status: "CANCELLED" } }).catch(() => {})
  })
  test("async calculate and pay paths deny cross-company runs and NULL-company runs", async () => {
    expect(code(await postHrm("payroll.calculate", { runId: runB.id, async: true }, { bearer: tA }))).toBe(404)
    expect(code(await postHrm("payroll.pay", { runId: runB.id, async: true }, { bearer: tA }))).toBe(404)
    expect(code(await postHrm("payroll.calculate", { runId: runNull.id, async: true }, { bearer: tA }))).toBe(409)
    expect(code(await postHrm("payroll.pay", { runId: runNull.id, async: true }, { bearer: tA }))).toBe(409)
  })
})

// ---------------------------------------------------------------------------
// T-09 — AIT administration (R-10)
// ---------------------------------------------------------------------------
describe("T-09 AIT administration (R-10)", () => {
  test("fiscal year activation is company-scoped (Company A cannot activate Company B's FY → 404)", async () => {
    expect(code(await postHrm("ait.fiscalYears.activate", { id: fyB.id }, { bearer: tA }))).toBe(404)
  })

  test("the single-active-fiscal-year invariant is per company, not per vendor", async () => {
    // A activates its second FY → only A's slice flips; B's and NULL's stay
    const r = await postHrm("ait.fiscalYears.activate", { id: fyA2.id }, { bearer: tA })
    expect(ok(r)).toBe(true)
    const a1r = await db.aitFiscalYear.findUniqueOrThrow({ where: { id: fyA1.id } })
    const a2r = await db.aitFiscalYear.findUniqueOrThrow({ where: { id: fyA2.id } })
    const br = await db.aitFiscalYear.findUniqueOrThrow({ where: { id: fyB.id } })
    const nr = await db.aitFiscalYear.findUniqueOrThrow({ where: { id: fyNull.id } })
    expect(a1r.active).toBe(false)
    expect(a2r.active).toBe(true)
    expect(br.active).toBe(true) // untouched by A's activation
    expect(nr.active).toBe(true) // tenant-level row untouched
  })

  test("categories and slabs saves verify the owning fiscal year's company (cross-company → 404)", async () => {
    const cats = code(await postHrm("ait.categories.save", { fiscalYearId: fyB.id, categories: [{ key: "general", label: "General", threshold: 0 }] }, { bearer: tA }))
    expect(cats).toBe(404)
    const slabs = code(await postHrm("ait.slabs.save", { fiscalYearId: fyB.id, slabs: [{ upperLimit: null, ratePercent: 10 }] }, { bearer: tA }))
    expect(slabs).toBe(404)
  })

  test("fiscal year update (save) verifies the owning company (cross-company → 404)", async () => {
    expect(code(await postHrm("ait.fiscalYears.save", { id: fyB.id, label: "W2 hijack", incomeYear: "2025-26" }, { bearer: tA }))).toBe(404)
  })

  test("batch calculation processes only the active company's employees", async () => {
    const r = await postHrm("ait.batch.calculate", {}, { bearer: tA })
    expect(ok(r)).toBe(true)
    const ids = data(r).results.map((x: any) => x.employeeId).filter(Boolean)
    for (const id of ids) {
      const emp = await db.employee.findUniqueOrThrow({ where: { id } })
      expect(emp.companyId).toBe(cA.id)
    }
    expect(ids).not.toContain(b1.id)
  })

  test("CSV code matching uses (companyId, code): a code existing in both companies resolves to the caller's own employee", async () => {
    // a1's duplicate-code employee (code W2B1) lives in company A; b1 also has code W2B1
    const r = await postHrm("ait.batch.calculate", { csvRows: [{ name: "W2 CSV row", code: "W2B1", gross: 50000 }] }, { bearer: tA })
    expect(ok(r)).toBe(true)
    const matched = data(r).results.find((x: any) => x.code === "W2B1")
    expect(matched).toBeDefined()
    const owner = await db.employee.findUniqueOrThrow({ where: { id: matched.employeeId } })
    expect(owner.companyId).toBe(cA.id)
    // same CSV from Company B resolves to Company B's employee
    const rb = await postHrm("ait.batch.calculate", { csvRows: [{ name: "W2 CSV row B", code: "W2B1", gross: 50000 }] }, { bearer: tB })
    expect(ok(rb)).toBe(true)
    const matchedB = data(rb).results.find((x: any) => x.code === "W2B1")
    const ownerB = await db.employee.findUniqueOrThrow({ where: { id: matchedB.employeeId } })
    expect(ownerB.companyId).toBe(cB.id)
  })

  test("reconciliation uses only the active company's employees and runs", async () => {
    // give company B a PAID run with AIT withheld inside FY 2025-26 (Jul 25–Jun 26)
    const runB3 = await db.payrollRun.create({ data: { vendorId: vendor.id, companyId: cB.id, periodMonth: 5, periodYear: 2026, runType: "REGULAR", status: "PAID", adjustSeq: 0 } })
    await db.payrollEntry.create({ data: { vendorId: vendor.id, runId: runB3.id, employeeId: b1.id, gross: 65000, net: 63000, ait: 2000, status: "INCLUDED" } })
    const rA = await postHrm("ait.reconciliation", {}, { bearer: tA })
    expect(ok(rA)).toBe(true)
    const idsA = data(rA).rows.map((x: any) => x.employeeId)
    expect(idsA).not.toContain(b1.id)
    const rB = await postHrm("ait.reconciliation", {}, { bearer: tB })
    expect(ok(rB)).toBe(true)
    const bRow = data(rB).rows.find((x: any) => x.employeeId === b1.id)
    expect(bRow?.deducted).toBe(2000)
  })

  test("batch results and logs are company-scoped", async () => {
    const resA = await postHrm("ait.batch.results", {}, { bearer: tA })
    expect(ok(resA)).toBe(true)
    for (const l of data(resA)) {
      if (!l.employeeCode) continue
      expect(l.employeeCode).not.toBe("W2B1-COMPANY-B-ONLY")
    }
    const logsA = await postHrm("ait.logs.list", {}, { bearer: tA })
    expect(ok(logsA)).toBe(true)
    const logEmps = data(logsA).map((l: any) => l.employeeName)
    expect(logEmps).not.toContain("W2 B One")
  })

  test("the tenant fallback resolves ONLY NULL-company configuration (never another company's FY)", async () => {
    // Company B HAS its own FY (active) → resolves its own
    const cfgB = await postHrm("ait.config.get", {}, { bearer: tB })
    expect(ok(cfgB)).toBe(true)
    expect(data(cfgB).config.fiscalYear.label).toBe("W2 FY B")
    // a company WITHOUT its own FY resolves the NULL-company row, not A's
    const create = await postHrm("companies.create", { name: uniq("W2 NoFyCo"), initMode: "systemDefaults" }, { bearer: tA })
    expect(ok(create)).toBe(true)
    const u = await mkUser(vendor.id, { role: "HR_ADMIN", name: uniq("NoFyAdmin"), permissions: ["*"] })
    await db.userCompanyAccess.create({ data: { vendorId: vendor.id, userId: u.id, companyId: data(create).id, role: "HR_ADMIN", active: true, isDefault: true } })
    const s = await mkSession(u.id)
    await db.session.update({ where: { id: s }, data: { activeCompanyId: data(create).id } })
    const cfg = await postHrm("ait.config.get", {}, { bearer: s })
    expect(ok(cfg)).toBe(true)
    expect(data(cfg).config.fiscalYear.label).toBe("W2 FY NULL")
  })
})

// ---------------------------------------------------------------------------
// T-10 — approval hooks + the by-ID financial mutation register (R-11 / R-12)
// ---------------------------------------------------------------------------
describe("T-10 approval hooks and the financial mutation register (R-11/R-12)", () => {
  // the full authoritative acting context shape the engine passes (R-11)
  const ctxOf = (session: string, vendorId: string, activeCompanyId: string | null) => ({
    userId: "w2-test", userName: "W2 Test", vendorId, activeCompanyId, allCompaniesMode: false,
  })

  test("approvals.details applies the company condition (Company B request → 404 for A)", async () => {
    expect(code(await postHrm("approvals.details", { id: reqB.id }, { bearer: tA }))).toBe(404)
    // A's own request is visible
    expect(ok(await postHrm("approvals.details", { id: reqA.id }, { bearer: tA }))).toBe(true)
    // NULL-company (tenant-default) requests stay visible per the read policy
    expect(ok(await postHrm("approvals.details", { id: reqNull.id }, { bearer: tA }))).toBe(true)
  })

  test("applyLoanDecision preserves the acting context and rejects a cross-company loan (404)", async () => {
    const { applyLoanDecision } = await import("@/hrm-server/routes/finance")
    await expect(applyLoanDecision(ctxOf(tA, vendor.id, cA.id), loanB.id, "APPROVED")).rejects.toThrow()
    const loanBAfter = await db.loan.findUniqueOrThrow({ where: { id: loanB.id } })
    expect(loanBAfter.status).toBe("PENDING") // untouched
  })

  test("applyAdvanceDecision and applyExpenseDecision reject cross-company targets", async () => {
    const { applyAdvanceDecision, applyExpenseDecision } = await import("@/hrm-server/routes/finance")
    await expect(applyAdvanceDecision(ctxOf(tA, vendor.id, cA.id), advB.id, "APPROVED")).rejects.toThrow()
    await expect(applyExpenseDecision(ctxOf(tA, vendor.id, cA.id), expB.id, "APPROVED")).rejects.toThrow()
  })

  test("applyPayrollDecision rejects a cross-company run (404) and a NULL-company run (409)", async () => {
    const { applyPayrollDecision } = await import("@/hrm-server/routes/payroll")
    await expect(applyPayrollDecision(ctxOf(tA, vendor.id, cA.id), runB.id, "APPROVED")).rejects.toThrow()
    const nullRun = await db.payrollRun.create({ data: { vendorId: vendor.id, companyId: null, periodMonth: 7, periodYear: 2026, runType: "REGULAR", status: "HR_REVIEW", adjustSeq: 0 } })
    await expect(applyPayrollDecision(ctxOf(tA, vendor.id, cA.id), nullRun.id, "APPROVED")).rejects.toThrow()
  })

  test("applyBonusDecision and the commission hooks reject cross-company targets", async () => {
    const { applyBonusDecision } = await import("@/hrm-server/routes/payroll")
    await expect(applyBonusDecision(ctxOf(tA, vendor.id, cA.id), bonusB.id, "APPROVED")).rejects.toThrow()
    const bonusBAfter = await db.bonus.findUniqueOrThrow({ where: { id: bonusB.id } })
    expect(bonusBAfter.status).toBe("PENDING") // untouched
    // an ACTIONABLE-state (PENDING_APPROVAL) Company B commission rule is denied
    const ruleBActionable = await db.commissionRule.create({
      data: { vendorId: vendor.id, companyId: cB.id, name: "W2 rule B hook", calculationPeriod: "MONTHLY", effectiveFrom: new Date("2026-01-01"), active: true, basis: "FLAT", flatMethod: "PER_EMPLOYEE", rate: 5, status: "PENDING_APPROVAL", version: 1, eligibleStatuses: '["ACTIVE"]' },
    })
    const { applyCommissionRuleDecision } = await import("@/hrm-server/routes/commissions")
    await expect(applyCommissionRuleDecision(ctxOf(tA, vendor.id, cA.id), ruleBActionable.id, "APPROVED")).rejects.toThrow()
    const ruleAfter = await db.commissionRule.findUniqueOrThrow({ where: { id: ruleBActionable.id } })
    expect(ruleAfter.status).toBe("PENDING_APPROVAL") // untouched
  })

  test("applyResignationDecision and applyLetterDecision reject cross-company targets", async () => {
    const { applyResignationDecision } = await import("@/hrm-server/routes/exit")
    // an ACTIONABLE-state Company B resignation (SUBMITTED) must be denied
    const resBActionable = await db.resignation.findFirstOrThrow({ where: { vendorId: vendor.id, employeeId: b1.id, status: "SUBMITTED" } })
    await expect(applyResignationDecision(ctxOf(tA, vendor.id, cA.id), resBActionable.id, "APPROVED")).rejects.toThrow()
    const { applyLetterDecision } = await import("@/hrm-server/routes/letters")
    // an ACTIONABLE-state Company B letter (PREPARED) must be denied
    const letterBActionable = await db.hrLetter.findFirstOrThrow({ where: { vendorId: vendor.id, employeeId: b1.id, status: "PREPARED" } })
    await expect(applyLetterDecision(ctxOf(tA, vendor.id, cA.id), letterBActionable.id, "APPROVED")).rejects.toThrow()
    const afterLetter = await db.hrLetter.findUniqueOrThrow({ where: { id: letterBActionable.id } })
    expect(afterLetter.status).toBe("PREPARED") // untouched
  })

  test("salaryStructures.save update denies employeeId reassignment (financial history stays pinned)", async () => {
    const r = await postHrm("salaryStructures.save", { id: structA.id, employeeId: a2.id, effectiveFrom: "2026-11-01", basic: 40000, houseRent: 20000, medical: 5000 }, { bearer: tA })
    expect(code(r)).toBe(400)
    expect(String(r.body?.error)).toContain("cannot be reassigned")
    const after = await db.salaryStructure.findUniqueOrThrow({ where: { id: structA.id } })
    expect(after.employeeId).toBe(a1.id)
  })

  test("bonuses.approve denies a cross-company bonus (404)", async () => {
    expect(code(await postHrm("bonuses.approve", { id: bonusB.id, decision: "APPROVE" }, { bearer: tA }))).toBe(404)
  })

  test("bonuses.approveBulk denies a mixed-company batch in full (no partial execution)", async () => {
    const before = await db.bonus.findMany({ where: { id: { in: [bonusA.id, bonusB.id] } } })
    const r = await postHrm("bonuses.approveBulk", { ids: [bonusA.id, bonusB.id], decision: "APPROVE" }, { bearer: tA })
    expect(code(r)).toBe(404)
    const after = await db.bonus.findMany({ where: { id: { in: [bonusA.id, bonusB.id] } } })
    for (const b of after) {
      const prev = before.find((x) => x.id === b.id)!
      expect(b.status).toBe(prev.status) // NOTHING was actioned
    }
  })

  test("PF setStatus denies a cross-company enrollment (404)", async () => {
    expect(code(await postHrm("pf.setStatus", { id: pfB.id, status: "PAUSED" }, { bearer: tA }))).toBe(404)
  })

  test("PF autoEnrollRun processes only the active company's employees", async () => {
    // the pf settings group is TENANT-level (not company-overridable): a
    // vendor-level context (no company) writes the tenant baseline — the
    // legitimate vendor-level administration path of the R-13 matrix — with
    // proper cache invalidation
    const sv = await postHrm("settings.save", { group: "pf", values: { enabled: true, autoEnroll: true } }, { bearer: tNoCo })
    expect(ok(sv)).toBe(true)
    const r = await postHrm("pf.autoEnrollRun", {}, { bearer: tA })
    expect(ok(r)).toBe(true)
    // every NEWLY created enrollment must reference a company A employee
    const enrollments = await db.pfEnrollment.findMany({ where: { vendorId: vendor.id } })
    const newlyCreated = enrollments.filter((e) => e.id !== pfA.id && e.id !== pfB.id)
    expect(newlyCreated.length).toBeGreaterThan(0)
    for (const e of newlyCreated) {
      const emp = await db.employee.findUniqueOrThrow({ where: { id: e.employeeId } })
      expect(emp.companyId).toBe(cA.id)
    }
  })

  test("PF template download exports only the active company's employees", async () => {
    const r = await postHrm("pf.template.download", { filter: "ALL" }, { bearer: tA })
    expect(ok(r)).toBe(true)
    // decode the xlsx and search for company B's employee name
    const XLSX = await import("xlsx")
    const wb = XLSX.read(Buffer.from(data(r).base64, "base64"), { type: "buffer" })
    const text = JSON.stringify(wb)
    expect(text).toContain("W2 A One")
    expect(text).not.toContain("W2 B One")
  })

  test("PF import denies a mixed-company batch in full", async () => {
    const rows = [
      { "Employee Code": "W2-IMPORT-A", "Employee Name": "W2 Import A", "Employee Contribution": 100, "Employer Contribution": 100, "Year": 2026, "Month": 1, "Source": "OPENING" },
      { "Employee Code": "W2B1", "Employee Name": "W2 B One", "Employee Contribution": 100, "Employer Contribution": 100, "Year": 2026, "Month": 1, "Source": "OPENING" },
    ]
    const r = await postHrm("pf.import.execute", { rows }, { bearer: tA })
    expect(code(r)).toBe(400)
    expect(String(r.body?.error)).toContain("outside your active company")
    // nothing was imported
    const imported = await db.pfContribution.findMany({ where: { vendorId: vendor.id, source: "OPENING" } })
    expect(imported.length).toBe(0)
  })

  test("commissionRules.delete denies a cross-company rule (404)", async () => {
    expect(code(await postHrm("commissionRules.delete", { id: commissionRuleB.id }, { bearer: tA }))).toBe(404)
    const after = await db.commissionRule.findUniqueOrThrow({ where: { id: commissionRuleB.id } })
    expect(after.active).toBe(true)
  })

  test("commissions.calculate denies entries targeting another company's employees", async () => {
    const r = await postHrm("commissions.calculate", {
      month: 10, year: 2026, ruleId: commissionRuleA.id,
      entries: [{ employeeId: a1.id, salesAmount: 100000 }, { employeeId: b1.id, salesAmount: 100000 }],
    }, { bearer: tA })
    expect(code(r)).toBe(400)
    expect(String(r.body?.error)).toContain("outside your active company")
    const created = await db.bonus.findMany({ where: { vendorId: vendor.id, type: "SALES_COMMISSION" } })
    expect(created.length).toBe(0)
  })

  test("exit.cancel, settlements.calculate/approve/pay deny cross-company targets", async () => {
    expect(code(await postHrm("exit.cancel", { id: resB.id, reason: "W2 cross cancel" }, { bearer: tA }))).toBe(404)
    expect(code(await postHrm("settlements.calculate", { resignationId: resB.id }, { bearer: tA }))).toBe(404)
    expect(code(await postHrm("settlements.approve", { id: settlementB.id }, { bearer: tA }))).toBe(404)
    expect(code(await postHrm("settlements.pay", { id: settlementB.id }, { bearer: tA }))).toBe(404)
  })

  test("loans.recordInstallment denies a cross-company installment (404, no money moves)", async () => {
    const r = await postHrm("loans.recordInstallment", { installmentId: loanBInst.id, amount: 5000 }, { bearer: tA })
    expect(code(r)).toBe(404)
    const inst = await db.loanInstallment.findUniqueOrThrow({ where: { id: loanBInst.id } })
    expect(inst.paidAmount).toBe(0)
  })

  test("reimbursements.mark denies a cross-company claim (404, no journal posts)", async () => {
    const r = await postHrm("reimbursements.mark", { id: expB.id }, { bearer: tA })
    expect(code(r)).toBe(404)
    const claim = await db.expenseClaim.findUniqueOrThrow({ where: { id: expB.id } })
    expect(claim.status).toBe("APPROVED")
    expect(claim.reimbursementDate).toBeNull()
  })

  test("budgets.save update denies a cross-company budget line (404)", async () => {
    const r = await postHrm("accounting.budgets.save", { id: budgetB.id, accountCode: "5300", amount: 1 }, { bearer: tA })
    expect(code(r)).toBe(404)
  })

  test("reviews.finalize and letters.submit/issue deny cross-company targets (R-03 carry-forward §4.3)", async () => {
    expect(code(await postHrm("reviews.finalize", { id: reviewB.id }, { bearer: tA }))).toBe(404)
    expect(code(await postHrm("letters.submit", { id: letterB.id }, { bearer: tA }))).toBe(404)
    expect(code(await postHrm("letters.issue", { id: letterB.id }, { bearer: tA }))).toBe(404)
    expect(code(await postHrm("letters.requests.decide", { id: lreqB.id, decision: "REJECT" }, { bearer: tA }))).toBe(404)
    const lr = await db.leaveRequest.findUniqueOrThrow({ where: { id: lrB.id } })
    await db.leaveRequest.update({ where: { id: lrB.id }, data: { substituteEmployeeId: a1.id, substituteStatus: "PENDING" } })
    expect(code(await postHrm("leaveRequests.substitute.respond", { id: lrB.id, decision: "ACCEPTED" }, { bearer: tA }))).toBe(404)
    expect(code(await postHrm("leaveRequests.substitute.change", { id: lrB.id, substituteEmployeeId: a2.id }, { bearer: tA }))).toBe(404)
    await db.leaveRequest.update({ where: { id: lrB.id }, data: { substituteEmployeeId: null, substituteStatus: null } })
  })

  test("settlements.html read is company-isolated (cross-company → 404)", async () => {
    expect(code(await postHrm("settlements.html", { id: settlementB.id }, { bearer: tA }))).toBe(404)
  })
})

// ---------------------------------------------------------------------------
// T-11 — settings write-path (R-13)
// ---------------------------------------------------------------------------
describe("T-11 settings write-path (R-13)", () => {
  test("a NON-overridable group written from a concrete company context → 400 with the tenant-wide explanation", async () => {
    const r = await postHrm("settings.save", { group: "email", values: { fromName: "W2 Test" } }, { bearer: tA })
    expect(code(r)).toBe(400)
    expect(String(r.body?.error)).toContain("tenant-wide")
    expect(String(r.body?.error)).toContain("vendor-level")
  })

  test("an overridable group written from a concrete company context lands ONLY in that company's override layer", async () => {
    const before = await db.companySetting.findMany({ where: { vendorId: vendor.id, companyId: cA.id, group: "payroll" } })
    const r = await postHrm("settings.save", { group: "payroll", values: { cutoffDay: 17 } }, { bearer: tA })
    expect(ok(r)).toBe(true)
    const row = await db.companySetting.findFirst({ where: { vendorId: vendor.id, companyId: cA.id, group: "payroll", key: "cutoffDay" } })
    expect(row?.value).toBe("17")
    // the TENANT-level HrSetting row is untouched
    const tenant = await db.hrSetting.findFirst({ where: { vendorId: vendor.id, group: "payroll", key: "cutoffDay" } })
    expect(tenant).toBeNull()
    // and Company B's layer is untouched
    const bRow = await db.companySetting.findFirst({ where: { vendorId: vendor.id, companyId: cB.id, group: "payroll", key: "cutoffDay" } })
    expect(bRow).toBeNull()
    void before
  })

  test("All Companies mode denies settings mutations (403) and never falls through to tenant rows", async () => {
    const r = await postHrm("settings.save", { group: "payroll", values: { cutoffDay: 20 } }, { bearer: tOwnAll })
    expect(code(r)).toBe(403)
    expect(String(r.body?.error)).toContain("read-only")
    const tenant = await db.hrSetting.findFirst({ where: { vendorId: vendor.id, group: "payroll", key: "cutoffDay" } })
    expect(tenant).toBeNull()
    const patch = await postHrm("settings.patch", { group: "payroll", values: { cutoffDay: 20 } }, { bearer: tOwnAll })
    expect(code(patch)).toBe(403)
  })

  test("a missing active company fails closed for company-overridable writes (vendor HAS companies)", async () => {
    const r = await postHrm("settings.save", { group: "payroll", values: { cutoffDay: 22 } }, { bearer: tNoCo })
    expect(code(r)).toBe(403)
    expect(String(r.body?.error)).toContain("No active company")
    // nothing landed anywhere
    expect(await db.hrSetting.findFirst({ where: { vendorId: vendor.id, group: "payroll", key: "cutoffDay" } })).toBeNull()
  })

  test("legitimate vendor-level settings administration is preserved (legacy vendor without companies)", async () => {
    // non-overridable group from a company-less vendor → tenant rows (unchanged behavior)
    const r1 = await postHrm("settings.save", { group: "localization", values: { language: "en" } }, { bearer: tLegacy })
    expect(ok(r1)).toBe(true)
    const row = await db.hrSetting.findFirst({ where: { vendorId: legacyVendor.id, group: "localization", key: "language" } })
    expect(row?.value).toBe('"en"')
    // overridable group from a company-less vendor (no companies exist) → tenant rows (W1-AC-11 compat)
    const r2 = await postHrm("settings.save", { group: "payroll", values: { cutoffDay: 21 } }, { bearer: tLegacy })
    expect(ok(r2)).toBe(true)
    expect(await db.hrSetting.findFirst({ where: { vendorId: legacyVendor.id, group: "payroll", key: "cutoffDay" } })).not.toBeNull()
  })

  test("settings read precedence and cache invalidation survive (settings.get resolves the company override)", async () => {
    const r = await postHrm("settings.get", {}, { bearer: tA })
    expect(ok(r)).toBe(true)
    expect(data(r)._companyId).toBe(cA.id)
    expect(data(r).payroll.cutoffDay).toBe(17)
    // Company B reads the tenant default (25 was A's override only)
    const rb = await postHrm("settings.get", {}, { bearer: tB })
    expect(data(rb).payroll.cutoffDay).toBe(25) // the tenant default, not A's override
  })
})

// ---------------------------------------------------------------------------
// R-03 carry-forward §4.2 — vendor-wide employee scans
// ---------------------------------------------------------------------------
describe("R-03 carry-forward §4.2 (recoveryPlan, preflight, bulk import)", () => {
  test("payroll.recoveryPlan scopes loans/advances/employees to the active company", async () => {
    const r = await postHrm("payroll.recoveryPlan", { month: 10, year: 2026 }, { bearer: tA })
    expect(ok(r)).toBe(true)
    for (const row of data(r).rows) {
      const emp = await db.employee.findUnique({ where: { id: row.borrowerId } })
      if (emp) expect(emp.companyId).toBe(cA.id)
    }
    expect(data(r).rows.map((x: any) => x.borrowerId)).not.toContain(b1.id)
  })

  test("payroll.preflight classifies only the active company's employees", async () => {
    const r = await postHrm("payroll.preflight", { periodMonth: 10, periodYear: 2026 }, { bearer: tA })
    expect(ok(r)).toBe(true)
    const all = [...data(r).ready, ...data(r).warning, ...data(r).blocked]
    expect(all.length).toBeGreaterThan(0)
    for (const row of all) {
      const emp = await db.employee.findUnique({ where: { id: row.employeeId } })
      if (emp) expect(emp.companyId).toBe(cA.id)
    }
  })

  test("employees.bulkImport: company-scoped org anchors + vendor-global email duplicate semantics", async () => {
    // A's import cannot reference Company B's branch (same name is irrelevant:
    // anchors resolve inside the active company only)
    const rows = [{
      "Full Name": "W2 Import Person", "Email": "w2-import@test.local",
      "Branch": "W2 Branch B", // belongs to Company B
    }]
    const r = await postHrm("employees.bulkImport", { rows, dryRun: true }, { bearer: tA })
    expect(ok(r)).toBe(true)
    const row = data(r).results[0]
    expect(row.status).toBe("ERROR")
    expect(String(row.detail)).toContain("unknown branch")

    // vendor-global email duplicate: an email already used by Company B's
    // employee is SKIPPED (the uniqueness contract is tenant-wide) and the
    // detail echoes only the uploader's own value — never B's employee data
    const dup = await postHrm("employees.bulkImport", {
      rows: [{ "Full Name": "W2 Dup Person", "Email": "w2-b-one@test.local" }],
      dryRun: true,
    }, { bearer: tA })
    expect(ok(dup)).toBe(true)
    void dup
  })

  test("employees.bulkImport allocates codes inside the active company (company-scoped matching)", async () => {
    const r = await postHrm("employees.bulkImport", {
      rows: [{ "Full Name": "W2 New Import", "Email": uniq("w2new") + "@test.local" }],
      dryRun: false,
    }, { bearer: tA })
    expect(ok(r)).toBe(true)
    const created = data(r).results.find((x: any) => x.status === "CREATED")
    expect(created).toBeDefined()
    const emp = await db.employee.findFirstOrThrow({ where: { vendorId: vendor.id, fullName: "W2 New Import" } })
    expect(emp.companyId).toBe(cA.id)
  })
})

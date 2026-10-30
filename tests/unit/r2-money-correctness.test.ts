/// <reference types="bun-types" />
// ============ Phase R2 — payroll & money correctness regressions ============
// PAY-01  guarantor fallback: the borrower's net is restored symmetrically
//         (positive-net borrower via non-attendance earnings was underpaid by
//         the moved amount; a clamped ৳0 borrower never gets a phantom payout)
// PAY-03  salaryTemplates.apply: paisa dual-write + custom components in gross
// PAY-04  attendanceBonusFullMonth: any absence forfeits the allowance
// FIN-02  one reimbursement model: approval → APPROVED (no journal), the
//         register's mark → REIMBURSED + the single balanced cash journal
// FIN-03  concurrent-credit limits come from the policy, not hardcoded 2s
// EXT-02  negative settlements post a balanced journal and complete
// PAY-13  the recovery plan budgets the arrears-aware due (LOA-001 parity)
import "./_testdb"
import { describe, test, expect, beforeAll } from "bun:test"
import { db } from "@/lib/db"
import { mkVendor, mkUser, mkEmployee, mkSession, makeCtx, uniq } from "./_fixtures"
import { postHrm } from "./_hrm-endpoint"
import { calculateRun } from "@/hrm-server/payroll"
import { saveSettingsGroup } from "@/hrm-server/settings"

/** July 2026 workdays (Friday weekly off). */
const JULY_WORKDAYS = (() => {
  const days: string[] = []
  for (let d = 1; d <= 31; d++) days.push(`2026-07-${String(d).padStart(2, "0")}`)
  return days.filter((d) => new Date(d + "T00:00:00Z").getUTCDay() !== 5)
})()

async function mkStructure(vendorId: string, employeeId: string, comps: Record<string, number>, from = "2026-01-01") {
  const gross = Object.values(comps).reduce((s, x) => s + x, 0)
  return db.salaryStructure.create({ data: { vendorId, employeeId, effectiveFrom: from, status: "ACTIVE", ...comps, gross } as any })
}

async function seedAttendance(vendorId: string, employeeId: string, rows: { date: string; status: string }[]) {
  await db.attendance.createMany({ data: rows.map((r) => ({ vendorId, employeeId, date: r.date, status: r.status, lateMinutes: 0, earlyLeaveMinutes: 0, overtimeMinutes: 0 })) })
}

async function mkJulyRun(vendorId: string, createdBy: string) {
  return db.payrollRun.create({
    data: { vendorId, periodMonth: 7, periodYear: 2026, periodWeek: 0, frequency: "MONTHLY", runType: "REGULAR", status: "DRAFT", createdBy },
  })
}

// ---------------------------------------------------------------- PAY-01 ---
describe("PAY-01 — guarantor fallback restores the borrower's net symmetrically", () => {
  let vendor: { id: string }
  let owner: { id: string }
  let ctx: any

  beforeAll(async () => {
    vendor = await mkVendor("PAY01 Vendor")
    const u = await mkUser(vendor.id, { role: "VENDOR_OWNER", name: "PAY01 Owner" })
    owner = u
    ctx = makeCtx(u, ["*"])
  })

  test("positive-net borrower (bonus rides a zero-attendance month) gets the moved amount back", async () => {
    const borrower = await mkEmployee(vendor.id, { fullName: "PAY01 Borrower A" })
    const guarantor = await mkEmployee(vendor.id, { fullName: "PAY01 Guarantor A" })
    await mkStructure(vendor.id, borrower.id, { basic: 20000 })
    await mkStructure(vendor.id, guarantor.id, { basic: 40000 })
    // borrower absent ALL month (present+leave = 0 → cannot pay) but carries a
    // festival bonus: net stays positive — the audit's underpayment scenario
    await seedAttendance(vendor.id, borrower.id, JULY_WORKDAYS.map((d) => ({ date: d, status: "ABSENT" })))
    await seedAttendance(vendor.id, guarantor.id, JULY_WORKDAYS.map((d) => ({ date: d, status: "PRESENT" })))
    await db.bonus.create({ data: { vendorId: vendor.id, employeeId: borrower.id, type: "FESTIVAL", amount: 10000, status: "APPROVED", periodMonth: 7, periodYear: 2026 } })
    const loan = await db.loan.create({ data: { vendorId: vendor.id, employeeId: borrower.id, principal: 5000, installments: 1, installmentAmount: 5000, startDate: "2026-07-01", outstanding: 5000, status: "ACTIVE", guarantorId: guarantor.id, guarantorStatus: "AGREED" } })
    await db.loanInstallment.create({ data: { vendorId: loan.vendorId, loanId: loan.id, no: 1, dueDate: "2026-07-10", amount: 5000 } })

    const run = await mkJulyRun(vendor.id, owner.id)
    await calculateRun(ctx, run.id)

    const entries = await db.payrollEntry.findMany({ where: { runId: run.id } })
    const b = entries.find((e) => e.employeeId === borrower.id)!
    const g = entries.find((e) => e.employeeId === guarantor.id)!
    // the loan line fully moved off the borrower
    expect(b.loanDeductionPaisa).toBe(0n)
    // THE PAY-01 REGRESSION: the borrower's net is gross(20000) + bonus(10000)
    // − absence(20000) = 10000 — the moved 5000 comes back (was 5000 before)
    expect(b.netPaisa).toBe(1000000n)
    // the guarantor carries the recovery and loses exactly the moved amount
    expect(g.guarantorDeductionPaisa).toBe(500000n)
    expect(g.netPaisa).toBe(4000000n - 500000n)
    // payslip lines still sum: borrower earnings − deductions === net
    const bBd = JSON.parse(b.breakdownJson)
    const dedSum = Math.round(bBd.deductions.reduce((s: number, l: any) => s + l.amount, 0) * 100)
    const earnSum = 2000000 + 1000000 // gross + bonus (bonus is top-level)
    expect(earnSum - dedSum).toBe(Number(b.netPaisa))
    // run totals: the transfer nets out (borrower +5000, guarantor −5000)
    const runRow = await db.payrollRun.findUnique({ where: { id: run.id } })
    expect(runRow!.totalNetPaisa).toBe(1000000n + 3500000n)
  })

  test("clamped ৳0 borrower (no other earnings) never receives a phantom payout", async () => {
    // separate vendor: one REGULAR July run per (vendor, period) is enforced
    const vendor2 = await mkVendor("PAY01 Vendor B")
    const u2 = await mkUser(vendor2.id, { role: "VENDOR_OWNER", name: "PAY01 Owner B" })
    const ctx2 = makeCtx(u2, ["*"])
    const borrower = await mkEmployee(vendor2.id, { fullName: "PAY01 Borrower B" })
    const guarantor = await mkEmployee(vendor2.id, { fullName: "PAY01 Guarantor B" })
    await mkStructure(vendor2.id, borrower.id, { basic: 20000 })
    await mkStructure(vendor2.id, guarantor.id, { basic: 40000 })
    await seedAttendance(vendor2.id, borrower.id, JULY_WORKDAYS.map((d) => ({ date: d, status: "ABSENT" })))
    await seedAttendance(vendor2.id, guarantor.id, JULY_WORKDAYS.map((d) => ({ date: d, status: "PRESENT" })))
    const loan = await db.loan.create({ data: { vendorId: vendor2.id, employeeId: borrower.id, principal: 5000, installments: 1, installmentAmount: 5000, startDate: "2026-07-01", outstanding: 5000, status: "ACTIVE", guarantorId: guarantor.id, guarantorStatus: "AGREED" } })
    await db.loanInstallment.create({ data: { vendorId: loan.vendorId, loanId: loan.id, no: 1, dueDate: "2026-07-10", amount: 5000 } })

    const run = await mkJulyRun(vendor2.id, u2.id)
    await calculateRun(ctx2, run.id)

    const entries = await db.payrollEntry.findMany({ where: { runId: run.id } })
    const b = entries.find((e) => e.employeeId === borrower.id)!
    const g = entries.find((e) => e.employeeId === guarantor.id)!
    expect(b.loanDeductionPaisa).toBe(0n)
    expect(b.netPaisa).toBe(0n) // zero earnings → zero net, no phantom restore
    expect(g.guarantorDeductionPaisa).toBe(500000n)
    const runRow = await db.payrollRun.findUnique({ where: { id: run.id } })
    expect(runRow!.totalNetPaisa).toBe(4000000n - 500000n)
  })
})

// ---------------------------------------------------------------- PAY-04 ---
describe("PAY-04 — attendanceBonusFullMonth policy is enforced", () => {
  let vendor: { id: string }
  let owner: { id: string }
  let ctx: any

  beforeAll(async () => {
    vendor = await mkVendor("PAY04 Vendor")
    const u = await mkUser(vendor.id, { role: "VENDOR_OWNER", name: "PAY04 Owner" })
    owner = u
    ctx = makeCtx(u, ["*"])
  })

  const calc = async (policyOn: boolean) => {
    const v = await mkVendor(policyOn ? "PAY04 On Vendor" : "PAY04 Off Vendor")
    const u = await mkUser(v.id, { role: "VENDOR_OWNER", name: "PAY04 Owner " + policyOn })
    const c = makeCtx(u, ["*"])
    await saveSettingsGroup(v.id, "payroll", { attendanceBonusFullMonth: policyOn })
    const emp = await mkEmployee(v.id, { fullName: policyOn ? "PAY04 On Emp" : "PAY04 Off Emp" })
    await mkStructure(v.id, emp.id, { basic: 20000, attendanceAllow: 2000 })
    // one absent day in the month
    await seedAttendance(v.id, emp.id, JULY_WORKDAYS.map((d, i) => ({ date: d, status: i === 5 ? "ABSENT" : "PRESENT" })))
    const run = await mkJulyRun(v.id, u.id)
    await calculateRun(c, run.id)
    const e = await db.payrollEntry.findFirst({ where: { runId: run.id, employeeId: emp.id } })
    return e!
  }

  test("policy ON (default): one absence forfeits the whole attendance allowance", async () => {
    const e = await calc(true)
    const bd = JSON.parse(e.breakdownJson)
    const forfeit = bd.deductions.find((l: any) => l.label.includes("Attendance bonus forfeited"))
    expect(forfeit).toBeTruthy()
    expect(forfeit.amount).toBeGreaterThan(0)
    // absence proration removed 1/26 of the allowance; the forfeit takes the rest
    expect(Math.round(Number(e.absenceDeductionPaisa) + forfeit.amount * 100)).toBeGreaterThanOrEqual(200000 - 100) // ≈ the full ৳2000 allowance leaves the net
  })

  test("policy OFF: the allowance only prorates with everything else", async () => {
    const e = await calc(false)
    const bd = JSON.parse(e.breakdownJson)
    expect(bd.deductions.some((l: any) => l.label.includes("Attendance bonus forfeited"))).toBe(false)
  })
})

// ---------------------------------------------------------------- PAY-03 ---
describe("PAY-03 — salaryTemplates.apply writes the full structure (paisa + customs)", () => {
  let vendor: { id: string }
  let token: string

  beforeAll(async () => {
    vendor = await mkVendor("PAY03 Vendor")
    const u = await mkUser(vendor.id, { role: "VENDOR_OWNER", name: "PAY03 Owner" })
    token = await mkSession(u.id, "FULL")
  })

  test("gross includes custom components, paisa columns are dual-written, a revision row lands", async () => {
    const emp = await mkEmployee(vendor.id, { fullName: "PAY03 Employee" })
    // an existing ACTIVE structure so the supersede/revision path runs
    await mkStructure(vendor.id, emp.id, { basic: 15000 })
    const tpl = await db.salaryTemplate.create({
      data: {
        vendorId: vendor.id, name: `PAY03 Template ${uniq()}`,
        basic: 20000, houseRent: 8000, medical: 1000,
        componentsJson: JSON.stringify([{ label: "Transport Support", amount: 2500.5 }]),
      } as any,
    })
    const r = await postHrm("salaryTemplates.apply", { templateId: tpl.id, employeeId: emp.id }, { bearer: token })
    expect(r.status).toBe(200)
    const rec = r.body.data
    // gross = round(20000 + 8000 + 1000 + 2500.5) = 31501 — customs INCLUDED
    // (the canonical salaryStructures.save rounds the same way)
    expect(rec.gross).toBe(31501)
    expect(rec.basicPaisa != null ? Number(rec.basicPaisa) : null).toBe(2000000)
    expect(rec.grossPaisa != null ? Number(rec.grossPaisa) : null).toBe(3150100)
    const structure = await db.salaryStructure.findUnique({ where: { id: rec.id } })
    expect(structure!.grossPaisa).toBe(3150100n)
    // the template path now records salary-revision history like every other path
    const rev = await db.salaryRevision.findFirst({ where: { employeeId: emp.id }, orderBy: { createdAt: "desc" } })
    expect(rev).toBeTruthy()
    expect(rev!.previousSalary).toBe(15000)
    expect(rev!.newSalary).toBe(31501)
    expect(JSON.parse(structure!.componentsJson || "[]").length).toBe(1)
  })
})

// ---------------------------------------------------------------- FIN-02 ---
describe("FIN-02 — one reimbursement model (approve → APPROVED, mark → REIMBURSED)", () => {
  let vendor: { id: string }
  let owner: { id: string }
  let token: string

  beforeAll(async () => {
    vendor = await mkVendor("FIN02 Vendor")
    const u = await mkUser(vendor.id, { role: "VENDOR_OWNER", name: "FIN02 Owner" })
    owner = u
    token = await mkSession(u.id, "FULL")
  })

  test("approval sets APPROVED with NO journal; the register pays and posts the single balanced journal", async () => {
    const emp = await mkEmployee(vendor.id, { fullName: "FIN02 Employee" })
    const claim = await db.expenseClaim.create({
      data: { vendorId: vendor.id, employeeId: emp.id, title: "FIN02 travel", category: "TRAVEL", amount: 1234.5, date: "2026-07-10", status: "PENDING" } as any,
    })
    // ---- approval side ----
    const { applyExpenseDecision } = await import("@/hrm-server/routes/finance")
    await applyExpenseDecision({ userId: owner.id, userName: "FIN02 Owner", vendorId: vendor.id }, claim.id, "APPROVED")
    const approved = await db.expenseClaim.findUnique({ where: { id: claim.id } })
    expect(approved!.status).toBe("APPROVED") // was REIMBURSED before the fix
    expect(approved!.reimbursementDate).toBeNull() // the payout has NOT happened
    expect(approved!.journalId).toBeNull() // approval posts NO journal
    // the register's pending bucket now sees it
    const pending = await postHrm("reimbursements.list", { status: "PENDING" }, { bearer: token })
    expect(pending.status).toBe(200)
    expect((pending.body.data as any[]).some((c) => c.id === claim.id)).toBe(true)

    // ---- payout side (the register performs) ----
    const mark = await postHrm("reimbursements.mark", { id: claim.id, reimbursementDate: "2026-07-20" }, { bearer: token })
    expect(mark.status).toBe(200)
    const paid = await db.expenseClaim.findUnique({ where: { id: claim.id } })
    expect(paid!.status).toBe("REIMBURSED")
    expect(paid!.reimbursementDate).toBe("2026-07-20")
    expect(paid!.journalId).toBeTruthy()
    const journal = await db.accountJournal.findUnique({ where: { id: paid!.journalId! } })
    expect(journal).toBeTruthy()
    const lines = JSON.parse(journal!.linesJson || "[]")
    const debit = lines.reduce((s: number, l: any) => s + (Number(l.debit) || 0), 0)
    const credit = lines.reduce((s: number, l: any) => s + (Number(l.credit) || 0), 0)
    expect(Math.round(debit * 100)).toBe(Math.round(credit * 100)) // balanced to the paisa
    expect(Math.round(credit * 100)).toBe(123450) // the approved amount
    // chart-real accounts only (the old 6300/1100 codes existed in no chart)
    const accounts = new Set(lines.map((l: any) => l.account))
    expect(accounts.has("5300")).toBe(true)
    expect(accounts.has("1010")).toBe(true)
    // the 2100 payable is never grown by the reimbursement model
    expect(accounts.has("2100")).toBe(false)
  })
})

// ---------------------------------------------------------------- FIN-03 ---
describe("FIN-03 — concurrent-credit limits come from the policy", () => {
  let vendor: { id: string }
  let token: string

  beforeAll(async () => {
    vendor = await mkVendor("FIN03 Vendor")
    const u = await mkUser(vendor.id, { role: "VENDOR_OWNER", name: "FIN03 Owner" })
    token = await mkSession(u.id, "FULL")
    // policy allows up to 3 concurrent credits (loans + advances JOINTLY)
    await saveSettingsGroup(vendor.id, "loanPolicy", { allowConcurrentLoans: true, maxConcurrentLoans: 3, minServiceMonths: 0, minPreviousRepaymentPct: 0, minCurrentRepaidPctForNewLoan: 0 } as any)
    const wf = await db.approvalWorkflow.create({ data: { vendorId: vendor.id, name: "FIN03 Loan Flow", processType: "LOAN", active: true } })
    await db.approvalStep.create({ data: { vendorId: wf.vendorId, workflowId: wf.id, sequence: 1, name: "Owner Approval", approverRole: "VENDOR_OWNER", required: true, rejectBehavior: "REJECT_ALL", departmentScope: false, branchScope: false, amountThreshold: null, allowDelegation: false } })
  })

  test("a third concurrent loan passes when the policy allows three (the hardcoded 2 no longer overrides)", async () => {
    const emp = await mkEmployee(vendor.id, { fullName: "FIN03 Employee" })
    await mkEmployee(vendor.id, { fullName: "FIN03 Manager" })
    // two ACTIVE loans already — the old hardcoded check denied the third
    for (let i = 0; i < 2; i++) {
      await db.loan.create({ data: { vendorId: vendor.id, employeeId: emp.id, principal: 1000, installments: 2, installmentAmount: 500, startDate: "2026-07-01", outstanding: 1000, status: "ACTIVE" } })
    }
    const r = await postHrm("loans.create", { employeeId: emp.id, principal: 500, installments: 2, startDate: "2026-07-01" }, { bearer: token })
    expect(r.status).toBe(200)
    const loans = await db.loan.count({ where: { vendorId: vendor.id, employeeId: emp.id } })
    expect(loans).toBe(3)
  })
})

// ---------------------------------------------------------------- EXT-02 ---
describe("EXT-02 — negative settlements post a balanced journal and complete", () => {
  let vendor: { id: string }
  let owner: { id: string }
  let token: string

  beforeAll(async () => {
    vendor = await mkVendor("EXT02 Vendor")
    const u = await mkUser(vendor.id, { role: "VENDOR_OWNER", name: "EXT02 Owner" })
    owner = u
    token = await mkSession(u.id, "FULL")
  })

  test("employee owes more than the payout: the owed amount debits cash and the case COMPLETES", async () => {
    const emp = await db.employee.create({
      data: { vendorId: vendor.id, fullName: uniq("EXT02 Emp"), code: uniq("EXT"), joiningDate: "2025-09-01", employmentType: "PERMANENT", status: "ACTIVE" },
    })
    await db.salaryStructure.create({ data: { vendorId: vendor.id, employeeId: emp.id, effectiveFrom: "2025-09-01", status: "ACTIVE", basic: 26000, gross: 26000 } })
    const res = await db.resignation.create({
      data: {
        vendorId: vendor.id, employeeId: emp.id, submissionDate: "2026-09-15", resignationDate: "2026-09-15",
        proposedLwd: "2026-10-15", actualLwd: "2026-10-15", reason: "EXT02 test", status: "NOTICE_PERIOD",
        noticeMode: "FULL", noticeDays: 30, servedDays: 30,
      },
    })
    await db.exitClearance.create({
      data: { vendorId: vendor.id, resignationId: res.id, status: "CLEARED", checklistJson: JSON.stringify([{ department: "HR", items: [{ item: "Loan settled", cleared: true }] }]) },
    })
    // the debt: an ACTIVE loan due far beyond the final salary → negative net
    const loan = await db.loan.create({ data: { vendorId: vendor.id, employeeId: emp.id, principal: 60000, installments: 10, installmentAmount: 6000, startDate: "2026-01-01", outstanding: 60000, status: "ACTIVE" } })
    await db.loanInstallment.create({ data: { vendorId: loan.vendorId, loanId: loan.id, no: 1, dueDate: "2026-10-05", amount: 6000 } })

    const calc = await postHrm("settlements.calculate", { resignationId: res.id }, { bearer: token })
    expect(calc.status).toBe(200)
    const s = await db.finalSettlement.findFirst({ where: { resignationId: res.id } })
    expect(s).toBeTruthy()
    expect(Number(s!.netPayable)).toBeLessThan(0) // the employee owes the company

    const approve = await postHrm("settlements.approve", { id: s!.id }, { bearer: token })
    expect(approve.status).toBe(200)
    // THE EXT-02 REGRESSION: this used to throw (unbalanced/one-sided journal)
    // and strand the settlement APPROVED forever
    const pay = await postHrm("settlements.pay", { id: s!.id }, { bearer: token })
    expect(pay.status).toBe(200)
    const paid = await db.finalSettlement.findUnique({ where: { id: s!.id } })
    expect(paid!.status).toBe("PAID")
    const resRow = await db.resignation.findUnique({ where: { id: res.id } })
    expect(resRow!.status).toBe("COMPLETED")
    const journal = await db.accountJournal.findUnique({ where: { id: paid!.journalId! } })
    expect(journal).toBeTruthy()
    const lines = JSON.parse(journal!.linesJson || "[]")
    const debit = lines.reduce((s2: number, l: any) => s2 + (Number(l.debit) || 0), 0)
    const credit = lines.reduce((s2: number, l: any) => s2 + (Number(l.credit) || 0), 0)
    expect(Math.round(debit * 100)).toBe(Math.round(credit * 100))
    // the owed amount rides as a Cash-on-Hand debit — never a negative credit
    const cashLine = lines.find((l: any) => l.account === "1010")
    expect(cashLine).toBeTruthy()
    expect(Number(cashLine.debit)).toBe(-Number(paid!.netPayable))
    expect(lines.every((l: any) => Number(l.credit || 0) >= 0 && Number(l.debit || 0) >= 0)).toBe(true)
  })
})

// ---------------------------------------------------------------- PAY-13 ---
describe("PAY-13 — the recovery plan budgets the arrears-aware due", () => {
  let vendor: { id: string }
  let owner: { id: string }
  let ctx: any

  beforeAll(async () => {
    vendor = await mkVendor("PAY13 Vendor")
    const u = await mkUser(vendor.id, { role: "VENDOR_OWNER", name: "PAY13 Owner" })
    owner = u
    ctx = makeCtx(u, ["*"])
  })

  test("missed EMIs + the current EMI all ride the plan (LOA-001 parity with the engine)", async () => {
    const emp = await mkEmployee(vendor.id, { fullName: "PAY13 Employee" })
    await mkStructure(vendor.id, emp.id, { basic: 30000 })
    await seedAttendance(vendor.id, emp.id, JULY_WORKDAYS.map((d) => ({ date: d, status: "PRESENT" })))
    const loan = await db.loan.create({ data: { vendorId: vendor.id, employeeId: emp.id, principal: 6000, installments: 3, installmentAmount: 2000, startDate: "2026-05-01", outstanding: 6000, status: "ACTIVE" } })
    // May + June EMIs missed, July current
    await db.loanInstallment.create({ data: { vendorId: loan.vendorId, loanId: loan.id, no: 1, dueDate: "2026-05-10", amount: 2000 } })
    await db.loanInstallment.create({ data: { vendorId: loan.vendorId, loanId: loan.id, no: 2, dueDate: "2026-06-10", amount: 2000 } })
    await db.loanInstallment.create({ data: { vendorId: loan.vendorId, loanId: loan.id, no: 3, dueDate: "2026-07-10", amount: 2000 } })

    const run = await mkJulyRun(vendor.id, owner.id)
    await calculateRun(ctx, run.id)
    const entry = await db.payrollEntry.findFirst({ where: { runId: run.id, employeeId: emp.id } })
    // the ENGINE budgets all three EMIs (arrears) — 6000
    expect(entry!.loanDeductionPaisa).toBe(600000n)

    // the PLAN must budget the same 6000, not just July's 2000
    const plan = await postHrm("payroll.recoveryPlan", { month: 7, year: 2026 }, { bearer: await mkSession(owner.id, "FULL") })
    expect(plan.status).toBe(200)
    const rows = ((plan.body.data as any).rows as any[]).filter((r) => r.kind === "LOAN")
    expect(rows.length).toBe(1)
    expect(rows[0].dueAmount).toBe(6000)
    expect(rows[0].source).toBe("EMPLOYEE")
    expect(rows[0].plannedAmount).toBe(6000)
  })
})

/// <reference types="bun-types" />
// ============ R1 regression: payroll cancel → recreate → re-pay ============
// Audit (2026-10-12): after a month's pay was cancelled, payroll could NEVER
// be re-created for that month:
//   (a) routes/payroll.ts runs.create exists-check had no status filter — the
//       soft-CANCELLED row still matched "a run already exists";
//   (b) the DB unique (vendorId, periodYear, periodMonth, periodWeek, runType,
//       adjustSeq) kept the cancelled row parked in the REGULAR slot
//       (adjustSeq=0) → P2002 even if (a) was bypassed;
//   (c) payslip numbers stayed on the cancelled entries → the re-pay would
//       P2002 on @@unique([vendorId, payslipNumber]);
//   (d) loan/advance/bonus/deduction side effects stayed applied → the re-pay
//       would double-recover.
//
// Fix under test:
//   - cancel reverts ledgers (recoveryJson-exact loan/advance reversal,
//     bonuses → APPROVED, deductions → ACTIVE), clears payslips, and
//     tombstones the cancelled run out of the unique slot;
//   - runs.create ignores CANCELLED runs and re-creates the month;
//   - the re-created run pays again (new payslip numbers, no double recovery);
//   - cancelling twice is a clean 400.
//
// All assertions drive POST /api/hrm (the real dispatcher boundary).
import "./_testdb"
import { describe, test, expect, beforeAll } from "bun:test"
import { db } from "@/lib/db"
import { mkVendor, mkUser, mkEmployee, mkSession, uniq } from "./_fixtures"
import { postHrm } from "./_hrm-endpoint"

let vendor: { id: string }
let owner: { id: string; token: string }
const MONTH = 11, YEAR = 2026

async function mkLoanWithInstallment(employeeId: string) {
  const loan = await db.loan.create({
    data: {
      vendorId: vendor.id, employeeId,
      principal: 12000, installmentAmount: 1000, installments: 12,
      outstanding: 12000, paidAmount: 0, status: "ACTIVE",
      startDate: "2026-11-01", endDate: "2027-10-01",
    },
  })
  const inst = await db.loanInstallment.create({
    data: {
      vendorId: loan.vendorId,
      loanId: loan.id, no: 1, amount: 1000,
      dueDate: "2026-11-05", status: "PENDING", paidAmount: 0,
    },
  })
  return { loan, inst }
}

beforeAll(async () => {
  vendor = await mkVendor("R1 Cancel Recreate Vendor")
  const u = await mkUser(vendor.id, { role: "VENDOR_OWNER", name: "R1 Owner" })
  owner = { id: u.id, token: await mkSession(u.id, "FULL") }
})

describe("R1 — payroll cancel → recreate → re-pay", () => {
  test("paid month cancels fully and can be re-created and re-paid", async () => {
    // ---- fixture: employee + salary + loan + approved bonus + active deduction
    const emp = await mkEmployee(vendor.id, { fullName: "R1 Emp", code: uniq("R1") })
    await db.salaryStructure.create({
      data: {
        vendorId: vendor.id, employeeId: emp.id, status: "ACTIVE", effectiveFrom: "2026-01-01",
        basic: 30000, houseRent: 10000, medical: 2000, conveyance: 1000, gross: 43000,
      },
    })
    // payout compliance: salary 43,000 > 10,000 → BANK payout account required
    await db.employee.update({ where: { id: emp.id }, data: { salaryPayoutMethod: "BANK" } as any })
    await db.bankAccount.create({
      data: {
        vendorId: emp.vendorId,
        employeeId: emp.id, bank: "DBBL", branch: "Gulshan", accountNumber: "1234567890123",
        routingNumber: "090010109", accountType: "SALARY", paymentMethod: "BANK",
        isPrimary: true, isSalaryPayoutAccount: true, verified: true, holderName: "R1 Emp",
      },
    })
    const { loan, inst } = await mkLoanWithInstallment(emp.id)
    await db.bonus.create({
      data: { vendorId: vendor.id, employeeId: emp.id, periodMonth: MONTH, periodYear: YEAR, amount: 5000, type: "FESTIVAL", label: "Eid bonus", status: "APPROVED" },
    })
    await db.deduction.create({
      data: { vendorId: vendor.id, employeeId: emp.id, month: MONTH, year: YEAR, type: "OTHER", label: "Fine", amount: 500, status: "ACTIVE" },
    })

    // ---- 1. create + calculate + approve + pay the month -------------------
    const created = await postHrm("payroll.runs.create", { periodMonth: MONTH, periodYear: YEAR }, { bearer: owner.token })
    expect(created.body.ok).toBe(true)
    const runId = created.body.data.id

    await postHrm("payroll.calculate", { runId }, { bearer: owner.token })
    // calculate with attendance-free fixture: force the loan deduction via a
    // direct entry-level path is intrusive; instead submit+approve through the
    // approval engine shortcut (applyPayrollDecision pattern) — simplest: use
    // the engine's own approval submit then approve via owner (role has all)
    // finalize hook path: mark run APPROVED directly when the workflow engine
    // is bypassed in this fixture (the approval-engine path is covered by the
    // payroll approval tests); then pay through the real route
    await db.payrollRun.update({ where: { id: runId }, data: { status: "APPROVED", approvalRequestId: null } })
    const paid = await postHrm("payroll.pay", { runId }, { bearer: owner.token })
    expect(paid.body.ok).toBe(true)
    const run1 = await db.payrollRun.findUnique({ where: { id: runId } })
    expect(run1?.status).toBe("PAID")

    // loan installment recovered + bonus PAID + deduction PAID
    const inst1 = await db.loanInstallment.findUnique({ where: { id: inst.id } })
    expect(inst1?.status).toBe("PAID")
    const bonus1 = await db.bonus.findFirst({ where: { vendorId: vendor.id, employeeId: emp.id, periodMonth: MONTH, periodYear: YEAR } })
    expect(bonus1?.status).toBe("PAID")
    const ded1 = await db.deduction.findFirst({ where: { vendorId: vendor.id, employeeId: emp.id, month: MONTH, year: YEAR } })
    expect(ded1?.status).toBe("PAID")

    // ---- 2. cancel the PAID run --------------------------------------------
    const cancelled = await postHrm("payroll.runs.cancel", { runId, reason: "R1 test cancel" }, { bearer: owner.token })
    expect(cancelled.body.ok).toBe(true)
    expect(cancelled.body.data.monthCanBeRecreated).toBe(true)
    expect(typeof cancelled.body.data.reversalJournalId).toBe("string") // journal reversal posted

    // ledgers reverted
    const inst2 = await db.loanInstallment.findUnique({ where: { id: inst.id } })
    expect(inst2?.status).toBe("PENDING")
    expect(inst2?.paidAmount).toBe(0)
    const loan2 = await db.loan.findUnique({ where: { id: loan.id } })
    expect(loan2?.outstanding).toBe(12000)
    expect(loan2?.status).toBe("ACTIVE")
    const bonus2 = await db.bonus.findFirst({ where: { vendorId: vendor.id, employeeId: emp.id, periodMonth: MONTH, periodYear: YEAR } })
    expect(bonus2?.status).toBe("APPROVED")
    const ded2 = await db.deduction.findFirst({ where: { vendorId: vendor.id, employeeId: emp.id, month: MONTH, year: YEAR } })
    expect(ded2?.status).toBe("ACTIVE")

    // payslip numbers voided + recovery record cleared
    const entries2 = await db.payrollEntry.findMany({ where: { runId } })
    expect(entries2.length).toBeGreaterThan(0)
    for (const e of entries2) expect(e.payslipNumber).toBeNull()

    // cancelled run tombstoned out of the REGULAR slot
    const cancelledRun = await db.payrollRun.findUnique({ where: { id: runId } })
    expect(cancelledRun?.status).toBe("CANCELLED")
    expect((cancelledRun?.adjustSeq ?? 0) < 0).toBe(true)

    // ---- 3. THE BUG: re-create the same month ------------------------------
    const recreated = await postHrm("payroll.runs.create", { periodMonth: MONTH, periodYear: YEAR }, { bearer: owner.token })
    expect(recreated.body.ok).toBe(true) // previously: 400 "already exists"
    const runId2 = recreated.body.data.id

    // ---- 4. re-pay the re-created run (no double recovery, no P2002) -------
    await postHrm("payroll.calculate", { runId: runId2 }, { bearer: owner.token })
    await db.payrollRun.update({ where: { id: runId2 }, data: { status: "APPROVED" } })
    const repaid = await postHrm("payroll.pay", { runId: runId2 }, { bearer: owner.token })
    expect(repaid.body.ok).toBe(true)
    const run2 = await db.payrollRun.findUnique({ where: { id: runId2 } })
    expect(run2?.status).toBe("PAID")

    // loan recovered EXACTLY once for the second run (paidAmount back to 1000)
    const inst3 = await db.loanInstallment.findUnique({ where: { id: inst.id } })
    expect(inst3?.status).toBe("PAID")
    expect(inst3?.paidAmount).toBe(1000)
    const loan3 = await db.loan.findUnique({ where: { id: loan.id } })
    expect(loan3?.paidAmount).toBe(1000)
    expect(loan3?.outstanding).toBe(11000)

    // new payslip numbers minted
    const entries3 = await db.payrollEntry.findMany({ where: { runId: runId2 } })
    expect(entries3.length).toBeGreaterThan(0)
    expect(entries3.every((e) => e.payslipNumber != null)).toBe(true)

    // payslips.list only shows the live run's slips
    const slips = await postHrm("payslips.list", {}, { bearer: owner.token })
    expect(slips.body.ok).toBe(true)
    expect(slips.body.data.every((s: any) => s.runId !== runId)).toBe(true)

    // ---- 5. double-cancel is a clean 400 -----------------------------------
    const again = await postHrm("payroll.runs.cancel", { runId, reason: "second cancel attempt" }, { bearer: owner.token })
    expect(again.body.ok).toBe(false)
    expect(again.status).toBe(400)
  })

  test("duplicate create is still blocked while a non-cancelled run exists", async () => {
    const created = await postHrm("payroll.runs.create", { periodMonth: 10, periodYear: YEAR }, { bearer: owner.token })
    expect(created.body.ok).toBe(true)
    const dupe = await postHrm("payroll.runs.create", { periodMonth: 10, periodYear: YEAR }, { bearer: owner.token })
    expect(dupe.body.ok).toBe(false)
    expect(String(dupe.body.error)).toContain("already exists")
    // pre-pay cancel frees the slot again
    await postHrm("payroll.runs.cancel", { runId: created.body.data.id, reason: "free the slot" }, { bearer: owner.token })
    const after = await postHrm("payroll.runs.create", { periodMonth: 10, periodYear: YEAR }, { bearer: owner.token })
    expect(after.body.ok).toBe(true)
  })
})

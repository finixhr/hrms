/// <reference types="bun-types" />
// ============ H-5 regression: payroll multi-loan recovery is capped at the deduction ============
// Audit H-5 (High): the loan-recovery loop in payRun computed
//   pay = Math.min(installment.remaining, e.loanDeduction)
// per loan with NO cross-loan remaining-deduction cap (the adjacent advance
// loop has the correct remainingDed pattern). With 2+ active loans the total
// credited to Loan.paidAmount / LoanInstallment.paidAmount could exceed the
// amount actually deducted from the employee's payslip — WEEKLY runs guarantee
// the mismatch (prorated deduction vs full monthly installments per loan).
// Loans close early, outstanding is understated, the employee effectively
// repays money that was never deducted.
//
// Fix under test: mirror the advance loop — a single remainingLoanDed budget
// across all of the employee's active loans. Ledger credits must sum EXACTLY
// to the payslip's loanDeduction.
//
// Route-layer: drives payroll.pay through POST /api/hrm (real dispatcher, real
// payRun transaction, real journal posting).
import "./_testdb"
import { describe, test, expect, beforeAll } from "bun:test"
import { db } from "@/lib/db"
import { mkVendor, mkUser, mkEmployee, mkSession, uniq } from "./_fixtures"
import { postHrm } from "./_hrm-endpoint"

const NOW = new Date()
const MONTH = NOW.getMonth() + 1
const YEAR = NOW.getFullYear()
const monthPrefix = `${YEAR}-${String(MONTH).padStart(2, "0")}`

let vendor: { id: string }
let employee: { id: string }
let token: string
let runId: string
let entryId: string
let loanA: string, loanB: string
let instA: string, instB: string

const LOAN_DEDUCTION = 1000 // what the payslip actually deducted

beforeAll(async () => {
  vendor = await mkVendor("H5 Payroll Vendor")
  employee = await mkEmployee(vendor.id, { fullName: "H5 Borrower" })
  const admin = await mkUser(vendor.id, { role: "VENDOR_OWNER", name: "H5 Admin" })
  token = await mkSession(admin.id, "FULL")

  // APPROVED monthly run for the current period
  const run = await db.payrollRun.create({
    data: {
      vendorId: vendor.id, periodMonth: MONTH, periodYear: YEAR, periodWeek: 0,
      frequency: "MONTHLY", runType: "REGULAR", status: "APPROVED",
      totalGross: 9000, totalNet: 7000, employeeCount: 1,
    },
  })
  runId = run.id
  // INCLUDED entry: 9000 gross / 7000 net / 1000 loan deduction
  const entry = await db.payrollEntry.create({
    data: {
      vendorId: vendor.id, runId, employeeId: employee.id, status: "INCLUDED",
      gross: 9000, net: 7000, loanDeduction: LOAN_DEDUCTION, breakdownJson: "{}",
    },
  })
  entryId = entry.id

  // two ACTIVE loans, each with a current-month installment whose remaining
  // balance ALONE exceeds the whole deduction (combined 3000 + 2000 >> 1000)
  const mkLoan = async (principal: number, installment: number) => {
    const loan = await db.loan.create({
      data: {
        vendorId: vendor.id, employeeId: employee.id, principal,
        outstanding: principal, status: "ACTIVE", startDate: `${monthPrefix}-01`,
      },
    })
    const inst = await db.loanInstallment.create({
      data: { vendorId: loan.vendorId, loanId: loan.id, no: 1, dueDate: `${monthPrefix}-15`, amount: installment, status: "PENDING" },
    })
    return { loan: loan.id, inst: inst.id }
  }
  const a = await mkLoan(5000, 3000)
  const b = await mkLoan(4000, 2000)
  loanA = a.loan; instA = a.inst
  loanB = b.loan; instB = b.inst
})

describe("H-5 payroll multi-loan recovery is capped at the payslip deduction", () => {
  test("payroll.pay credits the ledgers with EXACTLY the deducted amount", async () => {
    const res = await postHrm("payroll.pay", { runId }, { bearer: token })
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)

    const instARow = await db.loanInstallment.findUnique({ where: { id: instA } })
    const instBRow = await db.loanInstallment.findUnique({ where: { id: instB } })
    const loanARow = await db.loan.findUnique({ where: { id: loanA } })
    const loanBRow = await db.loan.findUnique({ where: { id: loanB } })

    // THE invariant: ledger credits sum exactly equals the payslip deduction
    const credited = (instARow?.paidAmount || 0) + (instBRow?.paidAmount || 0)
    expect(credited).toBe(LOAN_DEDUCTION) // ← was 2000 (both loans got the full cap)

    // loan-level ledgers agree with the installment-level credits
    expect((loanARow?.paidAmount || 0) + (loanBRow?.paidAmount || 0)).toBe(LOAN_DEDUCTION)

    // earliest installment first (orderBy no asc → loan A's installment wins the budget)
    expect(instARow?.paidAmount).toBe(LOAN_DEDUCTION)
    expect(instARow?.status).toBe("PARTIAL")
    expect(instBRow?.paidAmount).toBe(0) // budget exhausted — loan B untouched
    expect(instBRow?.status).toBe("PENDING")

    // loans do NOT close early (5000-1000 = 4000 still outstanding on A)
    expect(loanARow?.status).toBe("ACTIVE")
    expect(loanARow?.outstanding).toBe(4000)
    expect(loanBRow?.outstanding).toBe(4000)

    // the run paid exactly once and the entry is linked to the recovery
    expect((await db.payrollRun.findUnique({ where: { id: runId } }))?.status).toBe("PAID")
    expect(instARow?.payrollEntryId).toBe(entryId)
  })
})

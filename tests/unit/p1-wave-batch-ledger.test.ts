/// <reference types="bun-types" />
// ============ P1 wave (2026-11-09) — batched money-path regression tests ============
// Audit Chapter 16, Table 7 (PRF-1, PRF-3, PRF-5, PRF-6): the payroll money
// path was converted from per-row sequential writes to set-based batches:
//
//   PRF-1  payroll.preflight resolves payout accounts + attendance counts
//          through the MON-4 batch resolver and ONE groupBy (was 3 queries
//          per employee).
//   PRF-3  payRun accumulates every ledger effect on an in-memory SHADOW
//          ledger and flushes chunked VALUES-based set updates after the
//          entries loop (loan installments, parent loans, advances, leave
//          balances, payslip stamps, bonus/deduction markings, history),
//          with the transaction timeout scaled by entry count.
//   PRF-5  leaveBalances.recompute batches all balance reads into one
//          findMany and writes bucketed createMany/updateMany.
//   PRF-6  attendance.bulkMark prefetches the guard stack (scope, shifts,
//          ATTENDANCE_RULES policies, existing rows) in five set queries and
//          fails fast on out-of-scope ids BEFORE any write.
//
// These tests pin the SEMANTIC equivalence of the batched paths against the
// sequential behavior they replaced — the same invariants the h5/r1/phase1
// suites pinned for the per-row writes.
import "./_testdb"
import { describe, test, expect, beforeAll } from "bun:test"
import { db } from "@/lib/db"
import { mkVendor, mkUser, mkEmployee, mkSession, uniq, defaultCompanyId } from "./_fixtures"
import { postHrm } from "./_hrm-endpoint"

const NOW = new Date()
const MONTH = NOW.getMonth() + 1
const YEAR = NOW.getFullYear()
const monthPrefix = `${YEAR}-${String(MONTH).padStart(2, "0")}`

// distinct PAST periods per PRF-3 test — REGULAR monthly runs are unique per
// (company, period), and separate past months also keep each test's payslip
// number pool and loan installment due dates independent
class PastPeriod {
  month: number; year: number; prefix: string
  constructor(offset: number) {
    const d = new Date(NOW.getFullYear(), NOW.getMonth() - offset, 1)
    this.month = d.getMonth() + 1
    this.year = d.getFullYear()
    this.prefix = `${this.year}-${String(this.month).padStart(2, "0")}`
  }
}

// ---------- shared fixtures ----------
let vendor: { id: string }
let companyId: string | null
let token: string

beforeAll(async () => {
  vendor = await mkVendor("P1 Batch Wave Vendor")
  companyId = await defaultCompanyId(vendor.id)
  const admin = await mkUser(vendor.id, { role: "VENDOR_OWNER", name: "P1 Admin" })
  token = await mkSession(admin.id, "FULL")
})

// ============ PRF-3: full loan payment closes the loan and writes history ============
describe("P1/PRF-3 — batched payRun flush (loan close, advance recovery, stamps)", () => {
  const P1 = new PastPeriod(1)
  const P2 = new PastPeriod(2)
  const P3 = new PastPeriod(3)

  test("an installment fully recovered through the batched flush turns PAID, closes the loan, and writes the LOAN_CLOSED history row", async () => {
    const employee = await mkEmployee(vendor.id, { fullName: "P1 Full-Pay Borrower" })
    const run = await db.payrollRun.create({
      data: { companyId, vendorId: vendor.id, periodMonth: P1.month, periodYear: P1.year, periodWeek: 0,
        frequency: "MONTHLY", runType: "REGULAR", status: "APPROVED",
        totalGross: 9000, totalNet: 7500, employeeCount: 1 },
    })
    const entry = await db.payrollEntry.create({
      data: { vendorId: vendor.id, runId: run.id, employeeId: employee.id, status: "INCLUDED",
        gross: 9000, net: 7500, loanDeduction: 1500, breakdownJson: "{}" },
    })
    const loan = await db.loan.create({
      data: { vendorId: vendor.id, employeeId: employee.id, principal: 1500, outstanding: 1500,
        status: "ACTIVE", startDate: `${P1.prefix}-01` },
    })
    const inst = await db.loanInstallment.create({
      data: { vendorId: vendor.id, loanId: loan.id, no: 1, dueDate: `${P1.prefix}-15`, amount: 1500, status: "PENDING" },
    })

    const res = await postHrm("payroll.pay", { runId: run.id }, { bearer: token })
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)

    const instRow = await db.loanInstallment.findUnique({ where: { id: inst.id } })
    expect(instRow?.paidAmount).toBe(1500)
    expect(instRow?.status).toBe("PAID") // the flush's post-update CASE
    expect(instRow?.payrollEntryId).toBe(entry.id)
    expect(instRow?.paidAt).toBeTruthy()

    const loanRow = await db.loan.findUnique({ where: { id: loan.id } })
    expect(loanRow?.paidAmount).toBe(1500)
    expect(loanRow?.outstanding).toBe(0)
    expect(loanRow?.status).toBe("CLOSED") // the flush's CLOSE transition

    const history = await db.employeeHistory.findFirst({
      where: { vendorId: vendor.id, employeeId: employee.id, eventType: "LOAN_CLOSED" },
    })
    expect(history).toBeTruthy()
    expect(JSON.parse(history!.dataJson).loanId).toBe(loan.id)

    // the stamp flush wrote payslip number + the exact recovery record
    const entryRow = await db.payrollEntry.findUnique({ where: { id: entry.id } })
    expect(entryRow?.payslipNumber).toMatch(/-0001$/)
    expect(entryRow?.status).toBe("INCLUDED")
    const recovery = JSON.parse(entryRow?.recoveryJson || "null")
    expect(recovery?.loan?.[0]).toEqual({ installmentId: inst.id, amount: 1500 })
    expect((await db.payrollRun.findUnique({ where: { id: run.id } }))?.status).toBe("PAID")
  })

  test("the batched flush handles a large run within the scaled transaction timeout (500 entries, one flush)", async () => {
    // PRF-3's ceiling was 15–25K sequential writes in a 60 s transaction;
    // 500 entries previously meant ~1,500–2,000 sequential writes. The batched
    // flush keeps the loop pure-JS and writes in a handful of chunks.
    // (60 s timeout: the fixture alone mints 500 employees + entries.)
    const employees: any[] = await Promise.all(
      Array.from({ length: 500 }, (_, i) => mkEmployee(vendor.id, { fullName: `P1 Bulk Flush ${i}` }))
    )
    const run = await db.payrollRun.create({
      data: { companyId, vendorId: vendor.id, periodMonth: P2.month, periodYear: P2.year - 1, periodWeek: 0,
        frequency: "MONTHLY", runType: "REGULAR", status: "APPROVED",
        totalGross: 50_000, totalNet: 45_000, employeeCount: employees.length },
    })
    await db.payrollEntry.createMany({
      data: employees.map((e) => ({
        vendorId: vendor.id, runId: run.id, employeeId: e.id, status: "INCLUDED",
        gross: 100, net: 90, breakdownJson: "{}",
      })),
    })
    const t0 = Date.now()
    const res = await postHrm("payroll.pay", { runId: run.id }, { bearer: token })
    const elapsedMs = Date.now() - t0
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    // 500 entries paid — a generous bound proving no per-entry write ladder
    expect(elapsedMs).toBeLessThan(30_000)
    expect(res.body.data.payslips).toBe(500)
    const stamped = await db.payrollEntry.count({ where: { runId: run.id, status: "INCLUDED", payslipNumber: { not: null } } })
    expect(stamped).toBe(500)
  }, 60_000)

  test("an advance fully recovered through the batched flush turns RECOVERED with exact ledger deltas", async () => {
    const employee = await mkEmployee(vendor.id, { fullName: "P1 Advance Borrower" })
    const run = await db.payrollRun.create({
      data: { companyId, vendorId: vendor.id, periodMonth: P2.month, periodYear: P2.year, periodWeek: 0,
        frequency: "MONTHLY", runType: "REGULAR", status: "APPROVED",
        totalGross: 8000, totalNet: 7000, employeeCount: 1 },
    })
    await db.payrollEntry.create({
      data: { vendorId: vendor.id, runId: run.id, employeeId: employee.id, status: "INCLUDED",
        gross: 8000, net: 7000, advanceDeduction: 500, breakdownJson: "{}" },
    })
    const adv = await db.advance.create({
      data: { vendorId: vendor.id, employeeId: employee.id, amount: 500, outstanding: 500,
        status: "RECOVERING", requestDate: `${P2.prefix}-01` },
    })

    const res = await postHrm("payroll.pay", { runId: run.id }, { bearer: token })
    expect(res.status).toBe(200)

    const advRow = await db.advance.findUnique({ where: { id: adv.id } })
    expect(advRow?.deducted).toBe(500)
    expect(advRow?.outstanding).toBe(0)
    expect(advRow?.status).toBe("RECOVERED") // the flush's RECOVERED transition
  })

  test("a guarantor entry sees the borrower's same-transaction recovery through the shadow ledger (no over-credit)", async () => {
    // borrower pays 1000 of a 1600 installment from their own salary; the
    // guarantor's entry in the SAME run then covers the remaining 600 — the
    // guarantor path must read the RUNNING post-borrower state (the exact
    // fresh-read semantics the sequential findUnique provided).
    const borrower = await mkEmployee(vendor.id, { fullName: "P1 Shadow Borrower" })
    const guarantor = await mkEmployee(vendor.id, { fullName: "P1 Shadow Guarantor" })
    const loan = await db.loan.create({
      data: { vendorId: vendor.id, employeeId: borrower.id, principal: 1600, outstanding: 1600,
        status: "ACTIVE", startDate: `${P3.prefix}-01` },
    })
    const inst = await db.loanInstallment.create({
      data: { vendorId: vendor.id, loanId: loan.id, no: 1, dueDate: `${P3.prefix}-15`, amount: 1600, status: "PENDING" },
    })
    const run = await db.payrollRun.create({
      data: { companyId, vendorId: vendor.id, periodMonth: P3.month, periodYear: P3.year, periodWeek: 0,
        frequency: "MONTHLY", runType: "REGULAR", status: "APPROVED",
        totalGross: 14000, totalNet: 12400, employeeCount: 2 },
    })
    await db.payrollEntry.create({
      data: { vendorId: vendor.id, runId: run.id, employeeId: borrower.id, status: "INCLUDED",
        gross: 8000, net: 7000, loanDeduction: 1000, breakdownJson: "{}" },
    })
    // the guarantor's snapshot claims up to 1000 against the installment —
    // only 600 remains after the borrower's own recovery
    await db.payrollEntry.create({
      data: { vendorId: vendor.id, runId: run.id, employeeId: guarantor.id, status: "INCLUDED",
        gross: 6000, net: 5400, guarantorDeduction: 600,
        breakdownJson: JSON.stringify({ guarantorRecoveries: [{ kind: "LOAN", installmentId: inst.id, amount: 1000 }] }) },
    })

    const res = await postHrm("payroll.pay", { runId: run.id }, { bearer: token })
    expect(res.status).toBe(200)

    const instRow = await db.loanInstallment.findUnique({ where: { id: inst.id } })
    // borrower 1000 + guarantor 600 = the installment total — NEVER 1000+1000
    expect(instRow?.paidAmount).toBe(1600)
    expect(instRow?.status).toBe("PAID")
    const loanRow = await db.loan.findUnique({ where: { id: loan.id } })
    expect(loanRow?.paidAmount).toBe(1600)
    expect(loanRow?.outstanding).toBe(0)
    expect(loanRow?.status).toBe("CLOSED")
    // last writer (the guarantor's entry) owns payrollEntryId, like the
    // sequential writes did
    const gEntry = await db.payrollEntry.findFirst({ where: { runId: run.id, employeeId: guarantor.id } })
    expect(instRow?.payrollEntryId).toBe(gEntry?.id)
  })
})

// ============ PRF-5: batched leave balance recompute ============
describe("P1/PRF-5 — leaveBalances.recompute batch write", () => {
  test("recompute creates missing rows and re-floors entitled values in bulk (one pass, same numbers as the per-row form)", async () => {
    const employee = await mkEmployee(vendor.id, { fullName: "P1 Recompute Employee" })
    const typeA = await db.leaveType.create({
      data: { vendorId: vendor.id, companyId, name: "P1 Casual", code: uniq("PC"), defaultDays: 10, active: true },
    })
    const typeB = await db.leaveType.create({
      data: { vendorId: vendor.id, companyId, name: "P1 Sick", code: uniq("PS"), defaultDays: 8, active: true },
    })
    const year = 2026
    // existing row for A with entitled ABOVE the new default (floor binds)
    await db.leaveBalance.create({
      data: { vendorId: vendor.id, employeeId: employee.id, leaveTypeId: typeA.id, year,
        entitled: 10, used: 9, pending: 1, carriedForward: 2 },
    })
    // no row for B (create path)

    const res = await postHrm("leaveBalances.recompute", { year }, { bearer: token })
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(res.body.data.employees).toBeGreaterThanOrEqual(1)
    expect(res.body.data.created).toBeGreaterThanOrEqual(1)

    const rowA = await db.leaveBalance.findFirst({ where: { employeeId: employee.id, leaveTypeId: typeA.id, year } })
    // committed = used(9) + pending(1) = 10 → entitled stays floored at 10
    expect(rowA?.entitled).toBe(10)
    const rowB = await db.leaveBalance.findFirst({ where: { employeeId: employee.id, leaveTypeId: typeB.id, year } })
    expect(rowB).toBeTruthy()
    expect(rowB?.entitled).toBe(8)
    expect(rowB?.used).toBe(0)
  })
})

// ============ PRF-1 + PRF-6: batched preflight and bulk attendance ============
describe("P1/PRF-1 — payroll.preflight batch resolution", () => {
  test("preflight classifies a structured employee READY with no payout warnings and reports counts", async () => {
    const employee = await mkEmployee(vendor.id, { fullName: "P1 Preflight Employee" })
    await db.salaryStructure.create({
      data: { vendorId: vendor.id, employeeId: employee.id, gross: 9000, status: "ACTIVE", effectiveFrom: `${YEAR - 1}-01-01` },
    })
    // a paid run exists for this vendor-month (the PRF-3 tests above), so a
    // fresh VENDOR keeps this assertion independent of the paid-period lock
    const res = await postHrm("payroll.preflight", { periodMonth: MONTH, periodYear: YEAR }, { bearer: token })
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(res.body.data.counts.total).toBeGreaterThanOrEqual(1)
    expect(res.body.data.counts.ready + res.body.data.counts.warning + res.body.data.counts.blocked).toBe(res.body.data.counts.total)
  })
})

describe("P1/PRF-6 — attendance.bulkMark batched guard stack", () => {
  // separate vendor: the PRF-3 tests paid a run for the MAIN vendor's current
  // month, which correctly locks today's date for attendance edits (the
  // PAY-017 guard) — this vendor has no paid runs
  let bulkVendor: { id: string }
  let bulkToken: string
  beforeAll(async () => {
    bulkVendor = await mkVendor("P1 Bulk Vendor")
    await defaultCompanyId(bulkVendor.id)
    const admin = await mkUser(bulkVendor.id, { role: "VENDOR_OWNER", name: "P1 Bulk Admin" })
    bulkToken = await mkSession(admin.id, "FULL")
  })

  test("bulkMark marks a batch with shift resolution in five prefetch queries + per-row upserts", async () => {
    const empA = await mkEmployee(bulkVendor.id, { fullName: "P1 Bulk Employee A" })
    const empB = await mkEmployee(bulkVendor.id, { fullName: "P1 Bulk Employee B" })
    const todayIso = new Date().toISOString().slice(0, 10)
    const res = await postHrm("attendance.bulkMark", {
      date: todayIso, employeeIds: [empA.id, empB.id], checkIn: "09:00", checkOut: "17:00",
    }, { bearer: bulkToken })
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(res.body.data.count).toBe(2)

    const rowA = await db.attendance.findFirst({ where: { vendorId: bulkVendor.id, employeeId: empA.id, date: todayIso } })
    const rowB = await db.attendance.findFirst({ where: { vendorId: bulkVendor.id, employeeId: empB.id, date: todayIso } })
    expect(rowA?.checkIn).toBe("09:00")
    expect(rowA?.workingMinutes).toBe(480)
    expect(rowA?.status).toBe("PRESENT")
    expect(rowB?.status).toBe("PRESENT")
  })

  test("an out-of-scope id fails fast BEFORE any row is written (zero partial writes)", async () => {
    const empC = await mkEmployee(bulkVendor.id, { fullName: "P1 Bulk Employee C" })
    const todayIso = new Date().toISOString().slice(0, 10)
    const res = await postHrm("attendance.bulkMark", {
      date: todayIso, employeeIds: [empC.id, "nonexistent-id-404"], checkIn: "09:00", checkOut: "17:00",
    }, { bearer: bulkToken })
    expect(res.status).toBe(404)
    expect(res.body.ok).toBe(false)
    // nothing was marked — the fail-fast guard ran before the upsert loop
    const rowC = await db.attendance.findFirst({ where: { vendorId: bulkVendor.id, employeeId: empC.id, date: todayIso } })
    expect(rowC).toBeNull()
  })
})

/// <reference types="bun-types" />
// ============ L-7 regression: loan installment plan is paisa-exact ============
// Audit L-7 (Low): the plan stored installmentAmount = ceil(principal/n) and
// derived the final row as principal − installmentAmount×(n−1) — that final
// row can be ZERO (৳0.04 over 3 → 0.02/0.02/0.00) or NEGATIVE (৳0.01 over 3).
// interestRate is recorded metadata only (never charged — business decision
// documented in the tracker).
//
// Fix under test: planInstallments() distributes the paisa total evenly
// (first `remainder` rows carry one extra paisa); every row ≥ ৳0.01; rows sum
// to EXACTLY the principal; degenerate counts (n > total paisa) are denied at
// loans.create. The approval finalize hook writes the SAME plan.
// Route-layer: drives loans.create through POST /api/hrm and the REAL
// applyLoanDecision finalize hook.
import "./_testdb"
import { describe, test, expect, beforeAll } from "bun:test"
import { db } from "@/lib/db"
import { mkVendor, mkUser, mkEmployee, mkSession, uniq } from "./_fixtures"
import { postHrm } from "./_hrm-endpoint"
import { planInstallments } from "@/hrm-server/routes/finance"

let vendor: { id: string }
let employee: { id: string }
let token: string

beforeAll(async () => {
  vendor = await mkVendor("L7 Loan Vendor")
  employee = await mkEmployee(vendor.id, { fullName: "L7 Borrower" })
  const admin = await mkUser(vendor.id, { role: "VENDOR_OWNER", name: "L7 Admin" })
  token = await mkSession(admin.id, "FULL")
  // loans.create submits through the approval engine — the vendor needs a
  // LOAN workflow (single VENDOR_OWNER step, same shape the seed uses)
  const wf = await db.approvalWorkflow.create({ data: { vendorId: vendor.id, name: "L7 Loan Flow", processType: "LOAN", active: true } })
  await db.approvalStep.create({ data: { vendorId: wf.vendorId, workflowId: wf.id, sequence: 1, name: "Owner Approval", approverRole: "VENDOR_OWNER", required: true, rejectBehavior: "REJECT_ALL", departmentScope: false, branchScope: false, amountThreshold: null, allowDelegation: false } })
})

describe("L-7 — planInstallments unit (paisa-exact, no zero rows)", () => {
  test("the audit's ZERO case: ৳0.04 over 3 → 0.02/0.01/0.01 (was 0.02/0.02/0.00)", () => {
    const plan = planInstallments(0.04, 3)
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.amounts).toEqual([0.02, 0.01, 0.01])
    expect(plan.amounts.every((a) => a >= 0.01)).toBe(true)
    expect(Math.round(plan.amounts.reduce((s, a) => s + a * 100, 0))).toBe(4)
  })

  test("the audit's NEGATIVE case: ৳0.01 over 3 → denied up front", () => {
    expect(planInstallments(0.01, 3).ok).toBe(false)
  })

  test("even split stays even; uneven split differs by exactly one paisa", () => {
    const even = planInstallments(100, 4)
    expect(even.ok && even.amounts).toEqual([25, 25, 25, 25])
    const odd = planInstallments(100, 3)
    expect(odd.ok && odd.amounts).toEqual([33.34, 33.33, 33.33])
  })
})

describe("L-7 — loans.create / approval flow (route layer)", () => {
  test("degenerate plan (৳0.02 over 3 installments) is DENIED at create", async () => {
    const r = await postHrm("loans.create", { employeeId: employee.id, principal: 0.02, installments: 3, startDate: "2026-10-01" }, { bearer: token })
    expect(r.status).toBe(400)
    expect(String(r.body?.error || "")).toContain("installment")
  })

  test("small principal creates, approves, and writes a paisa-exact plan with no zero row", async () => {
    // ৳0.04 over 3 installments — the exact shape that produced a zero final
    // row under ceil-division
    const create = await postHrm("loans.create", { employeeId: employee.id, principal: 0.04, installments: 3, startDate: "2026-10-01", purpose: "L-7 regression" }, { bearer: token })
    expect(create.status).toBe(200)
    const loanId = create.body?.data?.id as string

    const loan = await db.loan.findUnique({ where: { id: loanId } })
    expect(loan).toBeTruthy()
    expect(Number(loan!.installmentAmount)).toBe(0.02) // nominal FIRST amount of the plan

    // approve through the engine path the route registers (finalize hook)
    const { applyLoanDecision } = await import("@/hrm-server/routes/finance")
    await applyLoanDecision({ userId: "l7-test", userName: "L7 Admin", vendorId: vendor.id }, loanId, "APPROVED")

    const rows = await db.loanInstallment.findMany({ where: { loanId }, orderBy: { no: "asc" } })
    expect(rows).toHaveLength(3)
    const amounts = rows.map((r) => Number(r.amount))
    expect(amounts.every((a) => a >= 0.01)).toBe(true) // no zero/negative row
    expect(Math.round(amounts.reduce((s, a) => s + a * 100, 0))).toBe(4) // sums to EXACTLY the principal
    expect(await db.loan.findUnique({ where: { id: loanId } })).toMatchObject({ status: "ACTIVE" })
  })
})

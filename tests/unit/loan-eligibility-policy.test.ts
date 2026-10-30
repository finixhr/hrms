/// <reference types="bun-types" />
import "./_testdb"
import { describe, test, expect, beforeAll } from "bun:test"
import { db } from "@/lib/db"
import { mkVendor, mkUser, mkEmployee, mkSession } from "./_fixtures"
import { postHrm } from "./_hrm-endpoint"

let vendor: { id: string }
let adminToken: string
let eligibleEmp: { id: string }
let freshEmp: { id: string }
let suspendedEmp: { id: string }
let guarantorEmp: { id: string }

beforeAll(async () => {
  vendor = await mkVendor("Loan Policy Vendor")
  const admin = await mkUser(vendor.id, { role: "VENDOR_OWNER", name: "Policy Admin" })
  adminToken = await mkSession(admin.id, "FULL")

  // Eligible employee: joined 2 years ago, ACTIVE status
  eligibleEmp = await mkEmployee(vendor.id, { fullName: "Senior Active Borrower", code: "BORR-001" })
  await db.employee.update({
    where: { id: eligibleEmp.id },
    data: { joiningDate: "2023-01-01", status: "ACTIVE" },
  })

  // Fresh employee: joined yesterday (0 service months)
  freshEmp = await mkEmployee(vendor.id, { fullName: "Fresh Trainee", code: "FRESH-001" })
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10)
  await db.employee.update({
    where: { id: freshEmp.id },
    data: { joiningDate: yesterday, status: "ACTIVE" },
  })

  // Suspended employee
  suspendedEmp = await mkEmployee(vendor.id, { fullName: "Suspended Worker", code: "SUSP-001" })
  await db.employee.update({
    where: { id: suspendedEmp.id },
    data: { joiningDate: "2023-01-01", status: "SUSPENDED" },
  })

  // Guarantor employee: joined 2 years ago, ACTIVE
  guarantorEmp = await mkEmployee(vendor.id, { fullName: "Reliable Guarantor", code: "GUAR-001" })
  await db.employee.update({
    where: { id: guarantorEmp.id },
    data: { joiningDate: "2023-01-01", status: "ACTIVE" },
  })

  // Setup LOAN approval workflow
  const wf = await db.approvalWorkflow.create({
    data: { vendorId: vendor.id, name: "Loan WF", processType: "LOAN", active: true },
  })
  await db.approvalStep.create({
    data: {
      vendorId: wf.vendorId,
      workflowId: wf.id,
      sequence: 1,
      name: "Owner Step",
      approverRole: "VENDOR_OWNER",
      required: true,
      rejectBehavior: "REJECT_ALL",
      departmentScope: false,
      branchScope: false,
      amountThreshold: null,
      allowDelegation: false,
    },
  })
})

describe("Loan & Advance Eligibility Policy Controls", () => {
  test("loans.checkEligibility reports full diagnostic breakdown", async () => {
    const res = await postHrm(
      "loans.checkEligibility",
      { employeeId: eligibleEmp.id, principal: 50000, installments: 12, guarantorId: guarantorEmp.id },
      { bearer: adminToken }
    )
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    const data = res.body.data
    expect(data.eligible).toBe(true)
    expect(data.borrower.statusEligible).toBe(true)
    expect(data.borrower.serviceEligible).toBe(true)
    expect(data.borrower.serviceMonths).toBeGreaterThanOrEqual(12)
    expect(data.guarantor).toBeTruthy()
    expect(data.guarantor.eligible).toBe(true)
  })

  test("blocked when borrower status is not in eligibleStatuses (e.g. SUSPENDED)", async () => {
    // Check preflight
    const check = await postHrm(
      "loans.checkEligibility",
      { employeeId: suspendedEmp.id, principal: 20000, installments: 6 },
      { bearer: adminToken }
    )
    expect(check.status).toBe(200)
    expect(check.body.data.eligible).toBe(false)
    expect(check.body.data.reasons.some((r: string) => r.includes("SUSPENDED"))).toBe(true)

    // Attempt creation
    const create = await postHrm(
      "loans.create",
      { employeeId: suspendedEmp.id, principal: 20000, installments: 6, startDate: "2026-10-01" },
      { bearer: adminToken }
    )
    expect(create.status).toBe(400)
    expect(create.body.error).toContain("eligibility requirement not met")
  })

  test("blocked when employee does not meet minimum service period", async () => {
    // Configure minimum 6 months service
    await postHrm(
      "settings.save",
      { group: "loanPolicy", values: { minServiceMonths: 6, eligibleStatuses: ["ACTIVE", "PROBATION"] } },
      { bearer: adminToken }
    )

    const check = await postHrm(
      "loans.checkEligibility",
      { employeeId: freshEmp.id, principal: 10000, installments: 6 },
      { bearer: adminToken }
    )
    expect(check.status).toBe(200)
    expect(check.body.data.eligible).toBe(false)
    expect(check.body.data.reasons.some((r: string) => r.includes("service period"))).toBe(true)

    const create = await postHrm(
      "loans.create",
      { employeeId: freshEmp.id, principal: 10000, installments: 6, startDate: "2026-10-01" },
      { bearer: adminToken }
    )
    expect(create.status).toBe(400)
    expect(create.body.error).toContain("service period")
  })

  test("rejects guarantor who has an ongoing active loan when guarantorAllowActiveLoan is false", async () => {
    // Save policy: guarantor debt-free required
    await postHrm(
      "settings.save",
      { group: "loanPolicy", values: { guarantorAllowActiveLoan: false, minServiceMonths: 0 } },
      { bearer: adminToken }
    )

    // Give guarantor an ACTIVE loan
    await db.loan.create({
      data: {
        vendorId: vendor.id,
        employeeId: guarantorEmp.id,
        principal: 30000,
        installments: 10,
        installmentAmount: 3000,
        startDate: "2026-01-01",
        outstanding: 20000,
        status: "ACTIVE",
      },
    })

    const check = await postHrm(
      "loans.checkEligibility",
      { employeeId: eligibleEmp.id, guarantorId: guarantorEmp.id, principal: 15000, installments: 5 },
      { bearer: adminToken }
    )
    expect(check.status).toBe(200)
    expect(check.body.data.eligible).toBe(false)
    expect(check.body.data.guarantor.hasActiveDebt).toBe(true)
    expect(check.body.data.guarantor.debtEligible).toBe(false)

    const create = await postHrm(
      "loans.create",
      { employeeId: eligibleEmp.id, guarantorId: guarantorEmp.id, principal: 15000, installments: 5, startDate: "2026-10-01" },
      { bearer: adminToken }
    )
    expect(create.status).toBe(400)
    expect(create.body.error).toContain("debt-free")
  })

  test("unified guarantorRequired enforces guarantor on both loans and advances", async () => {
    await postHrm(
      "settings.save",
      { group: "loanPolicy", values: { guarantorRequired: true, minServiceMonths: 0, allowConcurrentLoans: true } },
      { bearer: adminToken }
    )

    // Advance check without guarantor should be rejected
    const checkAdv = await postHrm(
      "loans.checkEligibility",
      { employeeId: eligibleEmp.id, principal: 10000, installments: 2, type: "ADVANCE" },
      { bearer: adminToken }
    )
    expect(checkAdv.status).toBe(200)
    expect(checkAdv.body.data.eligible).toBe(false)
    expect(checkAdv.body.data.reasons.some((r: string) => r.includes("guarantor is mandatory"))).toBe(true)

    // Attempt advance creation without guarantor
    const createAdv = await postHrm(
      "advances.create",
      { employeeId: eligibleEmp.id, amount: 10000, installments: 2 },
      { bearer: adminToken }
    )
    expect(createAdv.status).toBe(400)
    expect(createAdv.body.error).toContain("guarantor is mandatory")
  })

  test("unified cross-credit concurrent check: recovering advance counts toward concurrent credit limit", async () => {
    // Disallow concurrent credit
    await postHrm(
      "settings.save",
      { group: "loanPolicy", values: { allowConcurrentLoans: false, guarantorRequired: false, minServiceMonths: 0 } },
      { bearer: adminToken }
    )

    // Create a recovering advance for borrower
    await db.advance.create({
      data: {
        vendorId: vendor.id,
        employeeId: eligibleEmp.id,
        amount: 20000,
        deducted: 5000,
        outstanding: 15000,
        installments: 4,
        requestDate: "2026-01-01",
        status: "RECOVERING",
      },
    })

    // Now employee tries to apply for a loan
    const checkLoan = await postHrm(
      "loans.checkEligibility",
      { employeeId: eligibleEmp.id, principal: 30000, installments: 6, type: "LOAN" },
      { bearer: adminToken }
    )
    expect(checkLoan.status).toBe(200)
    expect(checkLoan.body.data.eligible).toBe(false)
    expect(checkLoan.body.data.reasons.some((r: string) => r.includes("Concurrent loans & advances are disallowed"))).toBe(true)

    const createLoan = await postHrm(
      "loans.create",
      { employeeId: eligibleEmp.id, principal: 30000, installments: 6, startDate: "2026-10-01" },
      { bearer: adminToken }
    )
    expect(createLoan.status).toBe(400)
    expect(createLoan.body.error).toContain("Concurrent loans & advances are disallowed")
  })
})

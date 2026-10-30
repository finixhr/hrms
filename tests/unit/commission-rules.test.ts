/// <reference types="bun-types" />
// ============ Commission Rule Setup & Calculation Engine Automated Tests ============
import "./_testdb"
import { describe, test, expect, beforeAll } from "bun:test"
import { db } from "@/lib/db"
import { mkVendor, mkUser, mkEmployee, mkSession, makeCtx, uniq } from "./_fixtures"
import { postHrm } from "./_hrm-endpoint"
import {
  validateRuleDates,
  orderCommissionRules,
  isEmployeeServicePeriodEligible,
  resolveApplicableTarget,
  sanitizeSalesRevenue,
  calculateAndDistributeCommission,
} from "@/hrm-server/commission-engine"
import {
  generateCommissionThresholdTemplate,
  parseAndValidateThresholdRows,
} from "@/hrm-server/commission-import"
import { calculateRun } from "@/hrm-server/payroll"
import * as XLSX from "xlsx"

// ============================================================================
// PART A: Pure Function Unit Tests
// ============================================================================

describe("Commission Rule Engine — Date Validation", () => {
  test("valid date range passes", () => {
    expect(() => validateRuleDates(new Date("2026-01-01"), new Date("2026-12-31"))).not.toThrow()
  })

  test("open-ended effectiveTo passes", () => {
    expect(() => validateRuleDates(new Date("2026-01-01"), null)).not.toThrow()
  })

  test("effectiveTo before effectiveFrom throws error", () => {
    expect(() => validateRuleDates(new Date("2026-06-01"), new Date("2026-05-31"))).toThrow(
      "Effective To date cannot precede Effective From date"
    )
  })
})

describe("Commission Rule Engine — Specificity Ordering", () => {
  test("orders rules by specificity: Branch+Dept+Desig > Branch > Global", () => {
    const rules = [
      { id: "global", branchId: null, departmentId: null, designationId: null },
      { id: "branch-only", branchId: "b1", departmentId: null, designationId: null },
      { id: "all-three", branchId: "b1", departmentId: "d1", designationId: "ds1" },
      { id: "branch-dept", branchId: "b1", departmentId: "d1", designationId: null },
    ]
    const sorted = orderCommissionRules(rules)
    expect(sorted.map((r) => r.id)).toEqual(["all-three", "branch-dept", "branch-only", "global"])
  })
})

describe("Commission Rule Engine — Service Period Eligibility", () => {
  const calcDate = new Date("2026-10-31")

  test("minimum service period in DAYS", () => {
    // 30 days required
    expect(isEmployeeServicePeriodEligible("2026-10-01", calcDate, 30, "DAYS")).toBe(true) // 30 days
    expect(isEmployeeServicePeriodEligible("2026-10-15", calcDate, 30, "DAYS")).toBe(false) // 16 days
  })

  test("minimum service period in MONTHS", () => {
    // 6 months required
    expect(isEmployeeServicePeriodEligible("2026-04-01", calcDate, 6, "MONTHS")).toBe(true) // ~6.9 months
    expect(isEmployeeServicePeriodEligible("2026-07-01", calcDate, 6, "MONTHS")).toBe(false) // ~3.9 months
  })

  test("minimum service period in YEARS", () => {
    // 1 year required
    expect(isEmployeeServicePeriodEligible("2025-10-01", calcDate, 1, "YEARS")).toBe(true) // > 1 year
    expect(isEmployeeServicePeriodEligible("2026-01-01", calcDate, 1, "YEARS")).toBe(false) // < 1 year
  })

  test("future joining date is ineligible", () => {
    expect(isEmployeeServicePeriodEligible("2026-11-15", calcDate, 0, "DAYS")).toBe(false)
  })
})

describe("Commission Rule Engine — Target Hierarchy & Resolution", () => {
  const employee = {
    id: "emp-1",
    branchId: "branch-1",
    departmentId: "dept-1",
  }

  const thresholds = [
    { targetType: "TOTAL", targetId: null, thresholdAmount: 500000 },
    { targetType: "BRANCH", targetId: "branch-1", thresholdAmount: 200000 },
    { targetType: "DEPARTMENT", targetId: "dept-1", thresholdAmount: 100000 },
    { targetType: "EMPLOYEE", targetId: "emp-1", thresholdAmount: 50000 },
  ]

  test("Employee target takes precedence over Department, Branch, and Total", () => {
    const res = resolveApplicableTarget(employee, thresholds, {
      requireTotalTarget: true,
      requireBranchTarget: true,
      requireDeptTarget: true,
      requireEmpTarget: true,
    })
    expect(res.targetType).toBe("EMPLOYEE")
    expect(res.targetAmount).toBe(50000)
    expect(res.missingThreshold).toBe(false)
  })

  test("Department target takes precedence when Employee target is not required or missing", () => {
    const res = resolveApplicableTarget(employee, thresholds, {
      requireTotalTarget: true,
      requireBranchTarget: true,
      requireDeptTarget: true,
      requireEmpTarget: false,
    })
    expect(res.targetType).toBe("DEPARTMENT")
    expect(res.targetAmount).toBe(100000)
  })

  test("Branch target takes precedence when Department & Employee not required", () => {
    const res = resolveApplicableTarget(employee, thresholds, {
      requireTotalTarget: true,
      requireBranchTarget: true,
      requireDeptTarget: false,
      requireEmpTarget: false,
    })
    expect(res.targetType).toBe("BRANCH")
    expect(res.targetAmount).toBe(200000)
  })

  test("Total target applies when only Total is required", () => {
    const res = resolveApplicableTarget(employee, thresholds, {
      requireTotalTarget: true,
      requireBranchTarget: false,
      requireDeptTarget: false,
      requireEmpTarget: false,
    })
    expect(res.targetType).toBe("TOTAL")
    expect(res.targetAmount).toBe(500000)
  })

  test("Missing required threshold is detected and reported", () => {
    const emptyThresholds: any[] = []
    const res = resolveApplicableTarget(employee, emptyThresholds, {
      requireTotalTarget: true,
      requireBranchTarget: false,
      requireDeptTarget: false,
      requireEmpTarget: false,
    })
    expect(res.missingThreshold).toBe(true)
    expect(res.targetType).toBe("TOTAL")
  })
})

describe("Commission Rule Engine — Sales Transaction Sanitization", () => {
  test("excludes CANCELLED and REVERSED transactions and deducts RETURN adjustments", () => {
    const transactions = [
      { id: "tx1", amount: 10000, status: "COMPLETED" },
      { id: "tx2", amount: 5000, status: "CANCELLED" }, // should be ignored
      { id: "tx3", amount: 3000, status: "REVERSED" }, // should be ignored
      { id: "tx4", amount: 2000, status: "RETURN" }, // should subtract 2000
      { id: "tx5", amount: 4000 }, // defaults to completed
    ]
    const cleanRevenue = sanitizeSalesRevenue({
      employeeId: "emp-1",
      salesAmount: 20000,
      transactions,
    })
    // 10000 - 2000 + 4000 = 12000
    expect(cleanRevenue).toBe(12000)
  })

  test("falls back to salesAmount when transactions array is omitted", () => {
    const cleanRevenue = sanitizeSalesRevenue({
      employeeId: "emp-1",
      salesAmount: 50000,
    })
    expect(cleanRevenue).toBe(50000)
  })

  test("revenue cannot be negative", () => {
    const transactions = [
      { id: "tx1", amount: 1000, status: "COMPLETED" },
      { id: "tx2", amount: 5000, status: "RETURN" },
    ]
    const cleanRevenue = sanitizeSalesRevenue({
      employeeId: "emp-1",
      salesAmount: 1000,
      transactions,
    })
    expect(cleanRevenue).toBe(0)
  })
})

describe("Commission Rule Engine — Calculation & Distribution", () => {
  const employees = [
    { id: "e1", fullName: "Alice", eligibleRevenue: 200000, targetRevenue: 100000, applicableSalary: 40000 },
    { id: "e2", fullName: "Bob", eligibleRevenue: 300000, targetRevenue: 100000, applicableSalary: 60000 },
  ]

  test("Percentage — TOTAL_REVENUE calculation method", () => {
    const rule: any = {
      basis: "PERCENT_OF_SALES",
      percentMethod: "TOTAL_REVENUE",
      rate: 10, // 10%
      distributionMethod: "EQUAL",
      cap: 0,
    }
    // Total revenue = 200,000 + 300,000 = 500,000. 10% = 50,000.
    // Equal distribution = 25,000 each.
    const res = calculateAndDistributeCommission(rule, employees)
    expect(res.rawPoolAmount).toBe(50000)
    expect(res.distributablePool).toBe(50000)
    expect(res.allocations).toHaveLength(2)
    expect(res.allocations[0].finalCommissionAmount).toBe(25000)
    expect(res.allocations[1].finalCommissionAmount).toBe(25000)
    expect(res.allocations.reduce((s, a) => s + a.finalCommissionAmount, 0)).toBe(50000)
  })

  test("Percentage — REVENUE_EXCEEDING_TARGET calculation method", () => {
    const rule: any = {
      basis: "PERCENT_OF_SALES",
      percentMethod: "REVENUE_EXCEEDING_TARGET",
      rate: 10,
      distributionMethod: "EQUAL",
      cap: 0,
    }
    // Excess = (200k - 100k) + (300k - 100k) = 100k + 200k = 300k. 10% = 30,000.
    const res = calculateAndDistributeCommission(rule, employees)
    expect(res.rawPoolAmount).toBe(30000)
    expect(res.distributablePool).toBe(30000)
    expect(res.allocations[0].finalCommissionAmount).toBe(15000)
    expect(res.allocations[1].finalCommissionAmount).toBe(15000)
  })

  test("Revenue at or below target produces 0 commission", () => {
    const belowEmployees = [
      { id: "e1", fullName: "Alice", eligibleRevenue: 80000, targetRevenue: 100000, applicableSalary: 40000 },
      { id: "e2", fullName: "Bob", eligibleRevenue: 100000, targetRevenue: 100000, applicableSalary: 60000 },
    ]
    const rule: any = {
      basis: "PERCENT_OF_SALES",
      percentMethod: "REVENUE_EXCEEDING_TARGET",
      rate: 10,
      distributionMethod: "EQUAL",
      cap: 0,
    }
    const res = calculateAndDistributeCommission(rule, belowEmployees)
    expect(res.rawPoolAmount).toBe(0)
    expect(res.distributablePool).toBe(0)
    expect(res.allocations[0].finalCommissionAmount).toBe(0)
    expect(res.allocations[1].finalCommissionAmount).toBe(0)
  })

  test("Salary-wise Pro-rata Distribution reconciles rounding remainder", () => {
    const threeEmployees = [
      { id: "e1", fullName: "A", eligibleRevenue: 100000, targetRevenue: 0, applicableSalary: 30000 },
      { id: "e2", fullName: "B", eligibleRevenue: 100000, targetRevenue: 0, applicableSalary: 30000 },
      { id: "e3", fullName: "C", eligibleRevenue: 100000, targetRevenue: 0, applicableSalary: 40000 },
    ]
    // Total pool = 10,000. Salaries: 30k (30%), 30k (30%), 40k (40%).
    const rule: any = {
      basis: "PERCENT_OF_SALES",
      percentMethod: "TOTAL_REVENUE",
      rate: 3.3333333333, // pool approx 10,000
      distributionMethod: "SALARY_PRO_RATA",
      cap: 10000,
    }
    const res = calculateAndDistributeCommission(rule, threeEmployees)
    const totalAllocated = res.allocations.reduce((s, a) => s + a.finalCommissionAmount, 0)
    expect(totalAllocated).toBe(res.distributablePool)
  })

  test("Salary-wise Pro-rata handles zero salary fallback gracefully", () => {
    const noSalaryEmployees = [
      { id: "e1", fullName: "A", eligibleRevenue: 100000, targetRevenue: 0, applicableSalary: 0 },
      { id: "e2", fullName: "B", eligibleRevenue: 100000, targetRevenue: 0, applicableSalary: 0 },
    ]
    const rule: any = {
      basis: "PERCENT_OF_SALES",
      percentMethod: "TOTAL_REVENUE",
      rate: 10,
      distributionMethod: "SALARY_PRO_RATA",
      cap: 0,
    }
    const res = calculateAndDistributeCommission(rule, noSalaryEmployees)
    // Total pool 20,000. Falls back to equal split: 10,000 each.
    expect(res.allocations[0].finalCommissionAmount).toBe(10000)
    expect(res.allocations[1].finalCommissionAmount).toBe(10000)
  })

  test("Total Commission Cap enforces maximum payable commission across pool", () => {
    const rule: any = {
      basis: "PERCENT_OF_SALES",
      percentMethod: "TOTAL_REVENUE",
      rate: 10, // 10% of 500,000 = 50,000
      distributionMethod: "EQUAL",
      cap: 20000, // Capped at 20,000
    }
    const res = calculateAndDistributeCommission(rule, employees)
    expect(res.rawPoolAmount).toBe(50000)
    expect(res.distributablePool).toBe(20000)
    expect(res.allocations[0].finalCommissionAmount).toBe(10000)
    expect(res.allocations[1].finalCommissionAmount).toBe(10000)
    expect(res.allocations.reduce((s, a) => s + a.finalCommissionAmount, 0)).toBe(20000)
  })

  test("Flat Amount — PER_EMPLOYEE pays configured fixed amount to each employee", () => {
    const rule: any = {
      basis: "FLAT",
      flatMethod: "PER_EMPLOYEE",
      rate: 5000,
      cap: 0,
    }
    const res = calculateAndDistributeCommission(rule, employees)
    expect(res.rawPoolAmount).toBe(10000)
    expect(res.allocations[0].finalCommissionAmount).toBe(5000)
    expect(res.allocations[1].finalCommissionAmount).toBe(5000)
  })

  test("Flat Amount — PER_EMPLOYEE scales down when total exceeds rule cap", () => {
    const rule: any = {
      basis: "FLAT",
      flatMethod: "PER_EMPLOYEE",
      rate: 5000, // 2 employees * 5000 = 10,000
      cap: 6000, // Capped at 6000
    }
    const res = calculateAndDistributeCommission(rule, employees)
    expect(res.rawPoolAmount).toBe(10000)
    expect(res.distributablePool).toBe(6000)
    expect(res.allocations[0].finalCommissionAmount).toBe(3000)
    expect(res.allocations[1].finalCommissionAmount).toBe(3000)
    expect(res.allocations.reduce((s, a) => s + a.finalCommissionAmount, 0)).toBe(6000)
  })

  test("Flat Amount — TOTAL_POOL divides total pool among eligible employees", () => {
    const rule: any = {
      basis: "FLAT",
      flatMethod: "TOTAL_POOL",
      rate: 12000, // Total pool = 12000
      distributionMethod: "EQUAL",
      cap: 0,
    }
    const res = calculateAndDistributeCommission(rule, employees)
    expect(res.distributablePool).toBe(12000)
    expect(res.allocations[0].finalCommissionAmount).toBe(6000)
    expect(res.allocations[1].finalCommissionAmount).toBe(6000)
  })
})

describe("Bulk Threshold Import — Template & Row Validation", () => {
  const branches = [{ id: "b1", name: "Dhaka HQ", code: "DHK" }]
  const departments = [{ id: "d1", name: "Sales", code: "SLS" }]
  const employees = [{ id: "e1", fullName: "Rayhan Rabby", code: "EMP-001" }]

  test("generates multi-worksheet Excel template", () => {
    const buffer = generateCommissionThresholdTemplate({
      ruleName: "Q4 Sales Commission",
      branches,
      departments,
      employees,
    })
    expect(buffer).toBeDefined()
    expect(buffer.length).toBeGreaterThan(1000)

    const wb = XLSX.read(buffer, { type: "buffer" })
    expect(wb.SheetNames).toContain("Thresholds")
    expect(wb.SheetNames).toContain("Branches")
    expect(wb.SheetNames).toContain("Departments")
    expect(wb.SheetNames).toContain("Employees")
  })

  test("validates valid and invalid threshold rows with actionable error messages", () => {
    const rows = [
      { "Target Type": "TOTAL", "Target Identifier": "COMPANY", "Threshold Amount (BDT)": 500000 },
      { "Target Type": "BRANCH", "Target Identifier": "DHK", "Threshold Amount (BDT)": 200000 },
      { "Target Type": "DEPARTMENT", "Target Identifier": "SLS", "Threshold Amount (BDT)": 150000 },
      { "Target Type": "EMPLOYEE", "Target Identifier": "EMP-001", "Threshold Amount (BDT)": 50000 },
      // Invalid rows:
      { "Target Type": "BRANCH", "Target Identifier": "NON_EXISTENT", "Threshold Amount (BDT)": 100000 },
      { "Target Type": "EMPLOYEE", "Target Identifier": "EMP-001", "Threshold Amount (BDT)": -500 },
      { "Target Type": "UNKNOWN_TYPE", "Target Identifier": "XYZ", "Threshold Amount (BDT)": 10000 },
      // Duplicate row:
      { "Target Type": "BRANCH", "Target Identifier": "DHK", "Threshold Amount (BDT)": 250000 },
    ]

    const result = parseAndValidateThresholdRows(rows, { branches, departments, employees })
    expect(result.validRows).toBe(4)
    expect(result.invalidRows).toBe(4)
    expect(result.totalRows).toBe(8)
    expect(result.errors.length).toBe(4)

    // Check specific error messages
    expect(result.errors.some((e) => e.includes("NON_EXISTENT"))).toBe(true)
    expect(result.errors.some((e) => e.toLowerCase().includes("non-negative"))).toBe(true)
    expect(result.errors.some((e) => e.includes("Invalid Target Type"))).toBe(true)
    expect(result.errors.some((e) => e.includes("Duplicate threshold entry"))).toBe(true)
  })
})

// ============================================================================
// PART B: HTTP Dispatcher & End-to-End Integration Tests
// ============================================================================

describe("Commission Rule Setup & Payroll End-to-End Integration", () => {
  let vendor: any
  let adminUser: any
  let payrollUser: any
  let regularUser: any
  let adminSession: string
  let payrollSession: string
  let regularSession: string
  let testEmployee1: any
  let testEmployee2: any

  beforeAll(async () => {
    vendor = await mkVendor("Commission Test Vendor")
    adminUser = await mkUser(vendor.id, { role: "VENDOR_OWNER", permissions: ["*"] })
    adminSession = await mkSession(adminUser.id, "FULL")

    payrollUser = await mkUser(vendor.id, { role: "PAYROLL_OFFICER" })
    payrollSession = await mkSession(payrollUser.id, "FULL")

    regularUser = await mkUser(vendor.id, { role: "EMPLOYEE" })
    regularSession = await mkSession(regularUser.id, "FULL")

    testEmployee1 = await mkEmployee(vendor.id, { fullName: "Test Sales Rep 1" })
    testEmployee2 = await mkEmployee(vendor.id, { fullName: "Test Sales Rep 2" })

    // Setup active salary structures for employees
    await db.salaryStructure.create({
      data: {
        vendorId: vendor.id,
        employeeId: testEmployee1.id,
        basic: 30000,
        gross: 50000,
        effectiveFrom: "2026-01-01",
        status: "ACTIVE",
      },
    })
    await db.salaryStructure.create({
      data: {
        vendorId: vendor.id,
        employeeId: testEmployee2.id,
        basic: 45000,
        gross: 75000,
        effectiveFrom: "2026-01-01",
        status: "ACTIVE",
      },
    })
  })

  test("RBAC: unauthorized user cannot create commission rules", async () => {
    const res = await postHrm(
      "commissionRules.save",
      {
        name: "Unauthorized Rule",
        calculationPeriod: "MONTHLY",
        effectiveFrom: "2026-10-01",
        active: true,
        basis: "PERCENT_OF_SALES",
        percentMethod: "TOTAL_REVENUE",
        rate: 5,
        distributionMethod: "EQUAL",
      },
      { bearer: regularSession }
    )
    expect(res.status).toBe(403)
  })

  test("Validation: rejects rate > 100 for percent basis and missing distribution method", async () => {
    const res = await postHrm(
      "commissionRules.save",
      {
        name: "Invalid Rate Rule",
        calculationPeriod: "MONTHLY",
        effectiveFrom: "2026-10-01",
        active: true,
        basis: "PERCENT_OF_SALES",
        percentMethod: "TOTAL_REVENUE",
        rate: 150, // Invalid: > 100%
        distributionMethod: "EQUAL",
      },
      { bearer: adminSession }
    )
    expect(res.status).toBe(400)
    expect(res.body.error).toContain("Commission rate cannot exceed 100%")
  })

  test("Create commission rule and prevent overlapping active rules", async () => {
    const res1 = await postHrm(
      "commissionRules.save",
      {
        name: "Q4 Monthly Sales Commission",
        calculationPeriod: "MONTHLY",
        effectiveFrom: "2026-10-01",
        effectiveTo: "2026-12-31",
        active: true,
        basis: "PERCENT_OF_SALES",
        percentMethod: "TOTAL_REVENUE",
        rate: 5,
        distributionMethod: "SALARY_PRO_RATA",
        minServicePeriodValue: 1,
        minServicePeriodUnit: "MONTHS",
        cap: 100000,
      },
      { bearer: adminSession }
    )
    expect(res1.status).toBe(200)
    expect(res1.body.data.name).toBe("Q4 Monthly Sales Commission")
    expect(res1.body.data.active).toBe(true)

    // Attempt to create overlapping active rule for same period & scope
    const res2 = await postHrm(
      "commissionRules.save",
      {
        name: "Conflicting Monthly Commission",
        calculationPeriod: "MONTHLY",
        effectiveFrom: "2026-11-01",
        effectiveTo: "2026-11-30",
        active: true,
        basis: "PERCENT_OF_SALES",
        percentMethod: "TOTAL_REVENUE",
        rate: 10,
        distributionMethod: "EQUAL",
      },
      { bearer: adminSession }
    )
    expect(res2.status).toBe(400)
    expect(res2.body.error).toContain("already covers period MONTHLY with overlapping dates")
  })

  test("Download Excel Template via thresholdTemplate route", async () => {
    const rules = await db.commissionRule.findMany({ where: { vendorId: vendor.id } })
    const rule = rules[0]

    const res = await postHrm(
      "commissionRules.thresholdTemplate",
      { ruleId: rule.id },
      { bearer: adminSession }
    )
    expect(res.status).toBe(200)
    expect(res.body.data.fileName).toContain(".xlsx")
    expect(res.body.data.base64).toBeDefined()
  })

  test("Download calculation template with eligible employees and targets via commissions.calculationTemplate", async () => {
    const rules = await db.commissionRule.findMany({ where: { vendorId: vendor.id } })
    const rule = rules[0]

    const res = await postHrm(
      "commissions.calculationTemplate",
      { ruleId: rule.id, month: 10, year: 2026 },
      { bearer: adminSession }
    )
    expect(res.status).toBe(200)
    expect(res.body.data.fileName).toContain("Sales_Commission_Template_")
    expect(res.body.data.base64).toBeDefined()
    expect(res.body.data.eligibleCount).toBeGreaterThan(0)
  })

  test("Bulk threshold import: preview, submit for authorization, and approval activation", async () => {
    const rules = await db.commissionRule.findMany({ where: { vendorId: vendor.id } })
    const rule = rules[0]

    // 1. Preview
    const previewRes = await postHrm(
      "commissionRules.importPreview",
      {
        ruleId: rule.id,
        rows: [
          { "Target Type": "TOTAL", "Target Identifier": "COMPANY", "Threshold Amount (BDT)": 300000 },
          { "Target Type": "EMPLOYEE", "Target Identifier": testEmployee1.code, "Threshold Amount (BDT)": 80000 },
        ],
      },
      { bearer: adminSession }
    )
    expect(previewRes.status).toBe(200)
    expect(previewRes.body.data.validRows).toBe(2)
    expect(previewRes.body.data.invalidRows).toBe(0)

    // 2. Submit for Approval
    const submitRes = await postHrm(
      "commissionRules.importSubmit",
      {
        ruleId: rule.id,
        fileName: "Q4_Thresholds.xlsx",
        rows: [
          { "Target Type": "TOTAL", "Target Identifier": "COMPANY", "Threshold Amount (BDT)": 300000 },
          { "Target Type": "EMPLOYEE", "Target Identifier": testEmployee1.code, "Threshold Amount (BDT)": 80000 },
        ],
      },
      { bearer: adminSession }
    )
    expect(submitRes.status).toBe(200)
    expect(submitRes.body.data.status).toBe("PENDING")

    // Verify unapproved thresholds are NOT yet in CommissionThreshold
    const activeThresholdsBefore = await db.commissionThreshold.count({ where: { ruleId: rule.id } })
    expect(activeThresholdsBefore).toBe(0)

    // 3. Approve and Activate Import
    const decideRes = await postHrm(
      "commissionRules.importDecide",
      {
        importId: submitRes.body.data.id,
        decision: "APPROVE",
      },
      { bearer: adminSession }
    )
    expect(decideRes.status).toBe(200)
    expect(decideRes.body.data.status).toBe("APPROVED")
    expect(decideRes.body.data.activatedCount).toBe(2)

    // Verify thresholds are now active in CommissionThreshold
    const activeThresholdsAfter = await db.commissionThreshold.findMany({ where: { ruleId: rule.id } })
    expect(activeThresholdsAfter.length).toBe(2)
    expect(activeThresholdsAfter.some((t) => t.targetType === "TOTAL" && t.thresholdAmount === 300000)).toBe(true)

    // 4. Verify that approving a subsequent batch replaces all previous thresholds
    const submitSecondRes = await postHrm(
      "commissionRules.importSubmit",
      {
        ruleId: rule.id,
        fileName: "second_thresholds.xlsx",
        rows: [
          { "Target Type": "TOTAL", "Target Identifier": "", "Threshold Amount (BDT)": 450000 },
        ],
      },
      { bearer: adminSession }
    )
    expect(submitSecondRes.status).toBe(200)

    const decideSecondRes = await postHrm(
      "commissionRules.importDecide",
      {
        importId: submitSecondRes.body.data.id,
        decision: "APPROVE",
      },
      { bearer: adminSession }
    )
    expect(decideSecondRes.status).toBe(200)

    const activeThresholdsFinal = await db.commissionThreshold.findMany({ where: { ruleId: rule.id } })
    // Replaced! Should now be exactly 1 threshold (the new 450000 one), previous 2 are gone!
    expect(activeThresholdsFinal.length).toBe(1)
    expect(activeThresholdsFinal[0].thresholdAmount).toBe(450000)

    // Put back the original thresholds so downstream calculation tests work with expected numbers
    const restoreRes = await postHrm(
      "commissionRules.importSubmit",
      {
        ruleId: rule.id,
        fileName: "restore_thresholds.xlsx",
        rows: [
          { "Target Type": "TOTAL", "Target Identifier": "COMPANY", "Threshold Amount (BDT)": 300000 },
          { "Target Type": "EMPLOYEE", "Target Identifier": testEmployee1.code, "Threshold Amount (BDT)": 80000 },
        ],
      },
      { bearer: adminSession }
    )
    await postHrm(
      "commissionRules.importDecide",
      {
        importId: restoreRes.body.data.id,
        decision: "APPROVE",
      },
      { bearer: adminSession }
    )
  })

  test("Calculate commission: generates Bonus rows, audit logs, and prevents duplicate payout", async () => {
    const rules = await db.commissionRule.findMany({ where: { vendorId: vendor.id } })
    const rule = rules[0]

    // Calculate commission for October 2026
    const calcRes = await postHrm(
      "commissions.calculate",
      {
        ruleId: rule.id,
        month: 10,
        year: 2026,
        entries: [
          { employeeId: testEmployee1.id, salesAmount: 200000 },
          { employeeId: testEmployee2.id, salesAmount: 300000 },
        ],
      },
      { bearer: adminSession }
    )
    expect(calcRes.status).toBe(200)
    expect(calcRes.body.data.created).toBe(2)

    // Verify Bonus records created with type SALES_COMMISSION
    const createdBonuses = await db.bonus.findMany({
      where: {
        vendorId: vendor.id,
        periodMonth: 10,
        periodYear: 2026,
        type: "SALES_COMMISSION",
      },
    })
    expect(createdBonuses.length).toBe(2)
    expect(createdBonuses.every((b) => b.status === "PENDING")).toBe(true)

    // Verify audit log entry was created
    const logs = await db.commissionCalculationLog.findMany({
      where: { vendorId: vendor.id, ruleId: rule.id },
    })
    expect(logs.length).toBe(2)
    expect(logs[0].baseCalculatedAmount).toBeGreaterThan(0)
    expect(logs[0].finalCommissionAmount).toBeGreaterThan(0)

    // Calculate again: verify duplicate protection skips duplicate payouts
    const reCalcRes = await postHrm(
      "commissions.calculate",
      {
        ruleId: rule.id,
        month: 10,
        year: 2026,
        entries: [
          { employeeId: testEmployee1.id, salesAmount: 200000 },
        ],
      },
      { bearer: adminSession }
    )
    expect(reCalcRes.status).toBe(200)
    expect(reCalcRes.body.data.created).toBe(0)
    expect(reCalcRes.body.data.skipped.length).toBe(1)
    expect(reCalcRes.body.data.skipped[0].reason).toContain("duplicate prevented")
  })

  test("Payroll Integration: approved SALES_COMMISSION bonuses roll into payroll run commission", async () => {
    // Approve the pending commission bonuses
    await db.bonus.updateMany({
      where: {
        vendorId: vendor.id,
        periodMonth: 10,
        periodYear: 2026,
        type: "SALES_COMMISSION",
      },
      data: { status: "APPROVED" },
    })

    // Create DRAFT payroll run for October 2026
    const payRun = await db.payrollRun.create({
      data: {
        vendorId: vendor.id,
        periodMonth: 10,
        periodYear: 2026,
        periodWeek: 0,
        frequency: "MONTHLY",
        runType: "REGULAR",
        status: "DRAFT",
        createdBy: adminUser.id,
      },
    })

    // Run payroll calculation engine
    const adminCtx = makeCtx(adminUser, ["*"])
    await calculateRun(adminCtx, payRun.id)
    const updatedRun = await db.payrollRun.findUnique({ where: { id: payRun.id } })
    expect(updatedRun?.status).toBe("CALCULATED")

    // Verify payroll entries aggregated the approved sales commission into entry.commission
    const entries = await db.payrollEntry.findMany({
      where: { runId: payRun.id },
    })
    expect(entries.length).toBeGreaterThanOrEqual(2)

    const emp1Entry = entries.find((e) => e.employeeId === testEmployee1.id)
    expect(emp1Entry).toBeDefined()
    expect(emp1Entry?.commission).toBeGreaterThan(0)

    const emp2Entry = entries.find((e) => e.employeeId === testEmployee2.id)
    expect(emp2Entry).toBeDefined()
    expect(emp2Entry?.commission).toBeGreaterThan(0)
  })
})

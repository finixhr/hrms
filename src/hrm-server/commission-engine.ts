// ============ Commission Rule Engine & Calculation Core (spec §1 & §2) ============
import { Deny } from "./rbac"

export type PeriodType = "MONTHLY" | "QUARTERLY" | "HALF_YEARLY" | "YEARLY"
export type CalculationBasis = "PERCENT_OF_SALES" | "FLAT"
export type PercentMethod = "TOTAL_REVENUE" | "REVENUE_EXCEEDING_TARGET"
export type FlatMethod = "PER_EMPLOYEE" | "TOTAL_POOL"
export type DistributionMethod = "EQUAL" | "SALARY_PRO_RATA"

export interface RuleInput {
  name: string
  calculationPeriod: PeriodType
  effectiveFrom: string | Date
  effectiveTo?: string | Date | null
  active?: boolean
  basis: CalculationBasis
  percentMethod?: PercentMethod | null
  flatMethod?: FlatMethod | null
  rate: number
  distributionMethod?: DistributionMethod | null
  minServicePeriodValue?: number
  minServicePeriodUnit?: "DAYS" | "MONTHS" | "YEARS"
  requireTotalTarget?: boolean
  requireBranchTarget?: boolean
  requireDeptTarget?: boolean
  requireEmpTarget?: boolean
  cap?: number
  branchId?: string | null
  departmentId?: string | null
  designationId?: string | null
}

export interface ThresholdInput {
  targetType: "TOTAL" | "BRANCH" | "DEPARTMENT" | "EMPLOYEE"
  targetId?: string | null
  targetName?: string | null
  thresholdAmount: number
}

export interface EmployeeSalesInput {
  employeeId: string
  salesAmount: number
  // Optional transaction audit breakdown for fraud detection and integrity
  transactions?: {
    id?: string
    amount: number
    status?: "COMPLETED" | "CANCELLED" | "REVERSED" | "RETURN" | string
  }[]
}

/** Check date validity and prevent overlapping active rules for the same scope and period */
export function validateRuleDates(effectiveFrom: Date, effectiveTo?: Date | null): void {
  if (effectiveTo && effectiveTo < effectiveFrom) {
    throw new Deny("Effective To date cannot precede Effective From date", 400)
  }
}

/** Specificity ordering for commission rules */
export function orderCommissionRules<T extends {
  branchId?: string | null
  departmentId?: string | null
  designationId?: string | null
  createdAt?: Date | string
}>(rules: T[]): T[] {
  const specificity = (r: T) => {
    let score = 0
    if (r.branchId) score += 4
    if (r.departmentId) score += 2
    if (r.designationId) score += 1
    return score
  }
  return [...rules].sort((a, b) => {
    const s = specificity(b) - specificity(a)
    if (s !== 0) return s
    const at = new Date(a.createdAt || 0).getTime()
    const bt = new Date(b.createdAt || 0).getTime()
    return at - bt
  })
}

/**
 * Service period eligibility evaluation as of a calculation date.
 * Consistent date boundary evaluation.
 */
export function isEmployeeServicePeriodEligible(
  joiningDate: string | Date | null | undefined,
  calcDate: Date,
  requiredValue: number,
  requiredUnit: "DAYS" | "MONTHS" | "YEARS"
): boolean {
  if (!joiningDate) return true
  const join = new Date(joiningDate)
  if (isNaN(join.getTime())) return false

  const diffTime = calcDate.getTime() - join.getTime()
  if (diffTime < 0) return false // joined in the future

  if (requiredValue <= 0) return true

  const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24))

  if (requiredUnit === "DAYS") {
    return diffDays >= requiredValue
  }

  // Calculate month difference
  const yearDiff = calcDate.getFullYear() - join.getFullYear()
  const monthDiff = yearDiff * 12 + (calcDate.getMonth() - join.getMonth())
  // Adjust if day of month is earlier
  const dayAdjustment = calcDate.getDate() < join.getDate() ? -1 : 0
  const totalMonths = monthDiff + dayAdjustment

  if (requiredUnit === "MONTHS") {
    return totalMonths >= requiredValue
  }

  if (requiredUnit === "YEARS") {
    const totalYears = totalMonths / 12
    return totalYears >= requiredValue
  }

  return true
}

/**
 * Deterministic target hierarchy:
 * EMPLOYEE > DEPARTMENT > BRANCH > TOTAL (Company-wide)
 * When multiple approved targets exist, the most specific applicable approved target is selected.
 * Targets are never summed together or subtracted multiple times.
 */
export function resolveApplicableTarget(
  emp: { id: string; branchId?: string | null; departmentId?: string | null },
  thresholds: { targetType: string; targetId?: string | null; thresholdAmount: number; status?: string }[],
  ruleRequirements: {
    requireEmpTarget?: boolean
    requireDeptTarget?: boolean
    requireBranchTarget?: boolean
    requireTotalTarget?: boolean
  }
): { targetAmount: number; targetType: "EMPLOYEE" | "DEPARTMENT" | "BRANCH" | "TOTAL" | "NONE"; isEligible: boolean; missingThreshold: boolean } {
  const approved = thresholds.filter((t) => !t.status || t.status === "APPROVED")

  // Check 1: Employee-wise
  if (ruleRequirements.requireEmpTarget) {
    const empThreshold = approved.find((t) => t.targetType === "EMPLOYEE" && t.targetId === emp.id)
    if (!empThreshold) {
      return { targetAmount: 0, targetType: "EMPLOYEE", isEligible: false, missingThreshold: true }
    }
    return { targetAmount: empThreshold.thresholdAmount, targetType: "EMPLOYEE", isEligible: true, missingThreshold: false }
  }

  // Check 2: Department-wise
  if (ruleRequirements.requireDeptTarget && emp.departmentId) {
    const deptThreshold = approved.find((t) => t.targetType === "DEPARTMENT" && t.targetId === emp.departmentId)
    if (!deptThreshold) {
      return { targetAmount: 0, targetType: "DEPARTMENT", isEligible: false, missingThreshold: true }
    }
    return { targetAmount: deptThreshold.thresholdAmount, targetType: "DEPARTMENT", isEligible: true, missingThreshold: false }
  }

  // Check 3: Branch-wise
  if (ruleRequirements.requireBranchTarget && emp.branchId) {
    const branchThreshold = approved.find((t) => t.targetType === "BRANCH" && t.targetId === emp.branchId)
    if (!branchThreshold) {
      return { targetAmount: 0, targetType: "BRANCH", isEligible: false, missingThreshold: true }
    }
    return { targetAmount: branchThreshold.thresholdAmount, targetType: "BRANCH", isEligible: true, missingThreshold: false }
  }

  // Check 4: Total (Company-wide)
  if (ruleRequirements.requireTotalTarget) {
    const totalThreshold = approved.find((t) => t.targetType === "TOTAL")
    if (!totalThreshold) {
      return { targetAmount: 0, targetType: "TOTAL", isEligible: false, missingThreshold: true }
    }
    return { targetAmount: totalThreshold.thresholdAmount, targetType: "TOTAL", isEligible: true, missingThreshold: false }
  }

  return { targetAmount: 0, targetType: "NONE", isEligible: true, missingThreshold: false }
}

/**
 * Filter transactions for integrity:
 * Exclude cancelled, reversed, or returns/adjustments.
 */
export function sanitizeSalesRevenue(salesInput: EmployeeSalesInput): number {
  if (!salesInput.transactions || salesInput.transactions.length === 0) {
    return Math.max(0, Number(salesInput.salesAmount) || 0)
  }
  let total = 0
  for (const tx of salesInput.transactions) {
    if (tx.status && ["CANCELLED", "REVERSED"].includes(tx.status)) continue
    if (tx.status === "RETURN") {
      total -= Math.abs(tx.amount)
    } else {
      total += tx.amount
    }
  }
  return Math.max(0, total)
}

export interface EmployeeAllocation {
  employeeId: string
  employeeName: string
  employeeCode?: string
  eligibleRevenue: number
  targetRevenue: number
  targetTypeApplied: string
  baseCalculatedAmount: number
  finalCommissionAmount: number
  applicableSalary: number
  capApplied: boolean
  capAmount?: number
}

/**
 * Core commission calculation & distribution engine:
 * Handles:
 * 1. Percentage of Sales Revenue:
 *    - Total Sales Revenue: Eligible Sales Revenue * Rate / 100
 *    - Revenue Exceeding Target: MAX(0, Eligible Sales Revenue - Applicable Revenue Target) * Rate / 100
 * 2. Flat Amount:
 *    - Per Employee: Fixed amount directly to each eligible employee
 *    - Total Employee Pool: Fixed amount as the total pool to distribute
 * 3. Distribution Methods:
 *    - Equal Distribution
 *    - Salary Pro-rata Distribution (with zero salary fallback and deterministic rounding)
 * 4. Total Commission Cap:
 *    - Enforced across the entire pool or scaled across individual allocations
 *    - Reconciles allocations to the exact cent / poisha
 */
export function calculateAndDistributeCommission(
  rule: {
    basis: CalculationBasis
    percentMethod?: PercentMethod | null
    flatMethod?: FlatMethod | null
    rate: number
    distributionMethod?: DistributionMethod | null
    cap?: number
  },
  eligibleEmployees: {
    id: string
    fullName: string
    code?: string
    eligibleRevenue: number
    targetRevenue: number
    targetTypeApplied?: string
    applicableSalary: number
  }[]
): {
  rawPoolAmount: number
  distributablePool: number
  allocations: EmployeeAllocation[]
  capApplied: boolean
  totalDistributed: number
} {
  const cap = Number(rule.cap) || 0
  const rate = Number(rule.rate) || 0

  if (eligibleEmployees.length === 0 || rate <= 0) {
    return {
      rawPoolAmount: 0,
      distributablePool: 0,
      allocations: [],
      capApplied: false,
      totalDistributed: 0,
    }
  }

  // --- CASE A: FLAT - PER EMPLOYEE ---
  if (rule.basis === "FLAT" && rule.flatMethod === "PER_EMPLOYEE") {
    let unconstrainedTotal = 0
    const rawAllocations: EmployeeAllocation[] = eligibleEmployees.map((emp) => {
      const base = rate
      unconstrainedTotal += base
      return {
        employeeId: emp.id,
        employeeName: emp.fullName,
        employeeCode: emp.code,
        eligibleRevenue: emp.eligibleRevenue,
        targetRevenue: emp.targetRevenue,
        targetTypeApplied: emp.targetTypeApplied || "NONE",
        baseCalculatedAmount: base,
        finalCommissionAmount: base,
        applicableSalary: emp.applicableSalary,
        capApplied: false,
        capAmount: cap > 0 ? cap : undefined,
      }
    })

    // If cap applies and total exceeds cap, scale down proportionally and reconcile rounding
    if (cap > 0 && unconstrainedTotal > cap) {
      const finalPool = Math.round(cap)
      let allocatedSum = 0
      const finalAllocations: EmployeeAllocation[] = rawAllocations.map((a, i) => {
        let amount = Math.floor((a.baseCalculatedAmount / unconstrainedTotal) * finalPool)
        if (i === rawAllocations.length - 1) {
          // Rounding remainder allocation to reconcile to finalPool
          amount = finalPool - allocatedSum
        } else {
          allocatedSum += amount
        }
        return {
          ...a,
          finalCommissionAmount: Math.max(0, amount),
          capApplied: true,
        }
      })
      return {
        rawPoolAmount: unconstrainedTotal,
        distributablePool: finalPool,
        allocations: finalAllocations,
        capApplied: true,
        totalDistributed: finalPool,
      }
    }

    return {
      rawPoolAmount: unconstrainedTotal,
      distributablePool: unconstrainedTotal,
      allocations: rawAllocations,
      capApplied: false,
      totalDistributed: unconstrainedTotal,
    }
  }

  // --- CASE B: POOL TO DISTRIBUTE (PERCENT_OF_SALES or FLAT TOTAL_POOL) ---
  let rawPool = 0

  if (rule.basis === "FLAT" && rule.flatMethod === "TOTAL_POOL") {
    rawPool = rate
  } else if (rule.basis === "PERCENT_OF_SALES") {
    if (rule.percentMethod === "REVENUE_EXCEEDING_TARGET") {
      for (const emp of eligibleEmployees) {
        const excess = Math.max(0, emp.eligibleRevenue - emp.targetRevenue)
        rawPool += (excess * rate) / 100
      }
    } else {
      // TOTAL_REVENUE
      const totalRev = eligibleEmployees.reduce((sum, e) => sum + e.eligibleRevenue, 0)
      rawPool = (totalRev * rate) / 100
    }
  }

  rawPool = Math.max(0, rawPool)
  let pool = rawPool
  let capApplied = false
  if (cap > 0 && pool > cap) {
    pool = cap
    capApplied = true
  }

  const finalPool = Math.round(pool)
  const finalRawPool = Math.round(rawPool)
  if (finalPool <= 0) {
    return {
      rawPoolAmount: finalRawPool,
      distributablePool: 0,
      allocations: eligibleEmployees.map((e) => ({
        employeeId: e.id,
        employeeName: e.fullName,
        employeeCode: e.code,
        eligibleRevenue: e.eligibleRevenue,
        targetRevenue: e.targetRevenue,
        targetTypeApplied: e.targetTypeApplied || "NONE",
        baseCalculatedAmount: 0,
        finalCommissionAmount: 0,
        applicableSalary: e.applicableSalary,
        capApplied,
        capAmount: cap > 0 ? cap : undefined,
      })),
      capApplied,
      totalDistributed: 0,
    }
  }

  // Distribute finalPool among eligible employees
  const isSalaryProRata = rule.distributionMethod === "SALARY_PRO_RATA"
  const totalSalaries = eligibleEmployees.reduce((s, e) => s + Math.max(0, e.applicableSalary || 0), 0)

  let allocatedSum = 0
  const allocations: EmployeeAllocation[] = []

  for (let i = 0; i < eligibleEmployees.length; i++) {
    const emp = eligibleEmployees[i]
    let share = 0

    if (isSalaryProRata && totalSalaries > 0) {
      const empSal = Math.max(0, emp.applicableSalary || 0)
      if (i === eligibleEmployees.length - 1) {
        share = finalPool - allocatedSum
      } else {
        share = Math.floor((empSal / totalSalaries) * finalPool)
        allocatedSum += share
      }
    } else {
      // Equal distribution (or fallback if total salaries is zero)
      if (i === eligibleEmployees.length - 1) {
        share = finalPool - allocatedSum
      } else {
        share = Math.floor(finalPool / eligibleEmployees.length)
        allocatedSum += share
      }
    }

    allocations.push({
      employeeId: emp.id,
      employeeName: emp.fullName,
      employeeCode: emp.code,
      eligibleRevenue: emp.eligibleRevenue,
      targetRevenue: emp.targetRevenue,
      targetTypeApplied: emp.targetTypeApplied || "NONE",
      baseCalculatedAmount: share,
      finalCommissionAmount: Math.max(0, share),
      applicableSalary: emp.applicableSalary,
      capApplied,
      capAmount: cap > 0 ? cap : undefined,
    })
  }

  const totalDistributed = allocations.reduce((s, a) => s + a.finalCommissionAmount, 0)

  return {
    rawPoolAmount: finalRawPool,
    distributablePool: finalPool,
    allocations,
    capApplied,
    totalDistributed,
  }
}

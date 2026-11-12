// ============ Commission Rule Engine & Calculation Core (spec §1 & §2) ============
import { Deny } from "./rbac"
import { toPaisa, fromPaisa, divHalfUp, divFloor } from "./money"

/** FIN-047 — exact percentage for commission rates: the rate is ingested ONCE
 *  as parts-per-million-of-the-whole (percent × 10,000 — exact for any rate
 *  configured with ≤4 decimal places) and the single divHalfUp boundary
 *  lands on paisa. (The shared mulPct quantizes to hundredths of a percent,
 *  which would lose the third/fourth decimal of rates like 0.0455%.) */
function mulRatePct(basisP: bigint, ratePct: number): bigint {
  const ratePpm = BigInt(Math.round(Number(ratePct) * 10_000))
  if (ratePpm === 0n || basisP === 0n) return 0n
  const negative = basisP < 0n
  const abs = negative ? -basisP : basisP
  const out = divHalfUp(abs * ratePpm, 1_000_000n)
  return negative ? -out : out
}

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
 *      — computed PER EMPLOYEE (FIN-047): each employee's commission is their
 *      OWN excess × rate; distributionMethod does not apply to this basis.
 * 2. Flat Amount:
 *    - Per Employee: Fixed amount directly to each eligible employee
 *    - Total Employee Pool: Fixed amount as the total pool to distribute
 * 3. Distribution Methods (POOL bases only — FLAT·TOTAL_POOL and
 *    PERCENT·TOTAL_REVENUE):
 *    - Equal Distribution
 *    - Salary Pro-rata Distribution (with zero salary fallback and deterministic rounding)
 * 4. Total Commission Cap:
 *    - Enforced across the entire pool or scaled across individual allocations
 *    - Reconciles allocations to the exact cent / poisha
 *
 * FIN-047 (Phase 3) — the engine now computes in INTEGER PAISA (the money
 * core's toPaisa/mulPct/divFloor helpers; each amount has exactly ONE
 * divHalfUp/divFloor boundary) and derives Float taka at the edge with
 * fromPaisa. The old float engine round-tripped whole-taka Math.floor/
 * Math.round boundaries, so sub-taka rates (0.05%) lost their paisa entirely
 * and equal splits truncated to whole taka.
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
  const capP = toPaisa(Math.max(0, cap))
  const zeroResult = (): ReturnType<typeof calculateAndDistributeCommission> => ({
    rawPoolAmount: 0,
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
      capApplied: false,
      capAmount: cap > 0 ? cap : undefined,
    })),
    capApplied: false,
    totalDistributed: 0,
  })

  if (eligibleEmployees.length === 0 || rate <= 0) {
    return zeroResult()
  }

  const baseOf = (emp: (typeof eligibleEmployees)[number]) => ({
    employeeId: emp.id,
    employeeName: emp.fullName,
    employeeCode: emp.code,
    eligibleRevenue: emp.eligibleRevenue,
    targetRevenue: emp.targetRevenue,
    targetTypeApplied: emp.targetTypeApplied || "NONE",
    applicableSalary: emp.applicableSalary,
    capAmount: cap > 0 ? cap : undefined,
  })

  // --- CASE A: FLAT · PER_EMPLOYEE — a per-employee amount, never a pool ---
  if (rule.basis === "FLAT" && rule.flatMethod === "PER_EMPLOYEE") {
    const rateP = toPaisa(rate)
    const totalRawP = rateP * BigInt(eligibleEmployees.length)
    if (capP > 0n && totalRawP > capP) {
      // proportional scale-down, floor per head, last head reconciles
      let allocatedP = 0n
      const allocations: EmployeeAllocation[] = eligibleEmployees.map((emp, i) => {
        let amountP: bigint
        if (i === eligibleEmployees.length - 1) {
          amountP = capP - allocatedP
        } else {
          amountP = divFloor(rateP * capP, totalRawP)
          allocatedP += amountP
        }
        return {
          ...baseOf(emp),
          baseCalculatedAmount: fromPaisa(rateP),
          finalCommissionAmount: fromPaisa(amountP > 0n ? amountP : 0n),
          capApplied: true,
        }
      })
      return {
        rawPoolAmount: fromPaisa(totalRawP),
        distributablePool: fromPaisa(capP),
        allocations,
        capApplied: true,
        totalDistributed: fromPaisa(capP),
      }
    }
    return {
      rawPoolAmount: fromPaisa(totalRawP),
      distributablePool: fromPaisa(totalRawP),
      allocations: eligibleEmployees.map((emp) => ({
        ...baseOf(emp),
        baseCalculatedAmount: fromPaisa(rateP),
        finalCommissionAmount: fromPaisa(rateP),
        capApplied: false,
      })),
      capApplied: false,
      totalDistributed: fromPaisa(totalRawP),
    }
  }

  // --- CASE B: PERCENT · REVENUE_EXCEEDING_TARGET — FIN-047 per-employee ---
  // Each employee's commission is THEIR OWN excess × rate. The old engine
  // pooled the per-employee commissions and then split the pool EQUALLY (or
  // salary-pro-rata): an employee who exceeded target by ৳100k and one with
  // zero excess each received half the pool — a mathematically per-employee
  // quantity silently re-attributed. distributionMethod is deliberately
  // ignored for this basis; a total cap scales every employee's commission
  // proportionally (the FLAT·PER_EMPLOYEE cap semantics).
  if (rule.basis === "PERCENT_OF_SALES" && rule.percentMethod === "REVENUE_EXCEEDING_TARGET") {
    const rawP = eligibleEmployees.map((emp) => {
      const excessP = toPaisa(emp.eligibleRevenue) - toPaisa(emp.targetRevenue)
      return mulRatePct(excessP > 0n ? excessP : 0n, rate)
    })
    const totalRawP = rawP.reduce((s, p) => s + p, 0n)
    const capHit = capP > 0n && totalRawP > capP
    const poolP = capHit ? capP : totalRawP
    if (poolP <= 0n) {
      return {
        rawPoolAmount: fromPaisa(totalRawP),
        distributablePool: 0,
        allocations: eligibleEmployees.map((emp, i) => ({
          ...baseOf(emp),
          // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- audited TODO(H-20 paydown): Phase 3 analytics/PDF/commission surface, index/lookup guarded by construction
          baseCalculatedAmount: fromPaisa(rawP[i]!),
          finalCommissionAmount: 0,
          capApplied: capHit,
        })),
        capApplied: capHit,
        totalDistributed: 0,
      }
    }
    let allocatedP = 0n
    const allocations: EmployeeAllocation[] = eligibleEmployees.map((emp, i) => {
      let amountP: bigint
      if (i === eligibleEmployees.length - 1) {
        amountP = poolP - allocatedP
      } else if (capHit) {
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- audited TODO(H-20 paydown): Phase 3 analytics/PDF/commission surface, index/lookup guarded by construction
        amountP = divFloor(rawP[i]! * poolP, totalRawP)
        allocatedP += amountP
      } else {
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- audited TODO(H-20 paydown): Phase 3 analytics/PDF/commission surface, index/lookup guarded by construction
        amountP = rawP[i]!
        allocatedP += amountP
      }
      return {
        ...baseOf(emp),
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- audited TODO(H-20 paydown): Phase 3 analytics/PDF/commission surface, index/lookup guarded by construction
        baseCalculatedAmount: fromPaisa(rawP[i]!),
        finalCommissionAmount: fromPaisa(amountP > 0n ? amountP : 0n),
        capApplied: capHit,
      }
    })
    return {
      rawPoolAmount: fromPaisa(totalRawP),
      distributablePool: fromPaisa(poolP),
      allocations,
      capApplied: capHit,
      totalDistributed: fromPaisa(poolP),
    }
  }

  // --- CASE C: genuine POOLS — FLAT · TOTAL_POOL and PERCENT · TOTAL_REVENUE ---
  // (plus the defensive fallback for malformed rule combinations: a pool of 0)
  let rawPoolP: bigint
  if (rule.basis === "FLAT" && rule.flatMethod === "TOTAL_POOL") {
    rawPoolP = toPaisa(rate)
  } else {
    const totalRevP = eligibleEmployees.reduce((s, e) => s + toPaisa(Math.max(0, e.eligibleRevenue)), 0n)
    rawPoolP = mulRatePct(totalRevP, rate)
  }
  rawPoolP = rawPoolP < 0n ? 0n : rawPoolP
  let poolP = rawPoolP
  let capApplied = false
  if (capP > 0n && poolP > capP) {
    poolP = capP
    capApplied = true
  }

  if (poolP <= 0n) {
    return {
      rawPoolAmount: fromPaisa(rawPoolP),
      distributablePool: 0,
      allocations: eligibleEmployees.map((emp) => ({
        ...baseOf(emp),
        baseCalculatedAmount: 0,
        finalCommissionAmount: 0,
        capApplied,
      })),
      capApplied,
      totalDistributed: 0,
    }
  }

  // Distribute the pool among eligible employees
  const isSalaryProRata = rule.distributionMethod === "SALARY_PRO_RATA"
  const totalSalariesP = eligibleEmployees.reduce((s, e) => {
    const salP = toPaisa(Math.max(0, e.applicableSalary || 0))
    return s + (salP > 0n ? salP : 0n)
  }, 0n)

  let allocatedP = 0n
  const allocations: EmployeeAllocation[] = eligibleEmployees.map((emp, i) => {
    let shareP: bigint
    if (isSalaryProRata && totalSalariesP > 0n) {
      const empSalP = toPaisa(Math.max(0, emp.applicableSalary || 0))
      if (i === eligibleEmployees.length - 1) {
        shareP = poolP - allocatedP
      } else {
        shareP = divFloor(empSalP * poolP, totalSalariesP)
        allocatedP += shareP
      }
    } else {
      // Equal distribution (or fallback if total salaries is zero)
      if (i === eligibleEmployees.length - 1) {
        shareP = poolP - allocatedP
      } else {
        shareP = divFloor(poolP, BigInt(eligibleEmployees.length))
        allocatedP += shareP
      }
    }
    return {
      ...baseOf(emp),
      baseCalculatedAmount: fromPaisa(shareP),
      finalCommissionAmount: fromPaisa(shareP > 0n ? shareP : 0n),
      capApplied,
    }
  })

  const totalDistributed = allocations.reduce((s, a) => s + a.finalCommissionAmount, 0)

  return {
    rawPoolAmount: fromPaisa(rawPoolP),
    distributablePool: fromPaisa(poolP),
    allocations,
    capApplied,
    totalDistributed,
  }
}

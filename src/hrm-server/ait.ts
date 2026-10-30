// ============ AIT compatibility layer ============
// The tax engine lives in ait-engine.ts (Income Tax Act 2023, configuration-
// driven per fiscal year). This module keeps the LEGACY exports used by the
// payroll engine and the unit tests:
//   - computeSlabTax / BD_DEFAULT_SLABS — legacy progressive-band helper
//   - computeAit — payroll-facing wrapper that runs the config-driven engine
//     and applies the §86(1)+(4) monthly withholding method:
//       §86(1)  monthlyTds      = this period's payment × average rate on the
//                                estimated annual income
//       §86(4)  netMonthlyAit   = catch-up = (annual tax − TDS already
//                                deducted) ÷ months remaining in the income
//                                year — reduces to annualTax ÷ 12 in steady
//                                state and self-corrects after salary
//                                revisions, arrears, corrections and joins.
//     The payroll engine passes the ACTUAL year-to-date figures from PAID
//     runs, so the old behaviour (static Employee.taxAlreadyDeducted ÷ 12) is
//     gone — that field now only credits genuinely prior withholding.
//   Falls back to the legacy TaxRuleSet only when the vendor has no
//   AitFiscalYear configuration at all.
import { db } from "@/lib/db"
import { calculateAit, ensureAitConfig, loadAitConfig } from "./ait-engine"

export type AitResult = {
  mode: string
  ruleSetId: string | null
  ruleSetName: string
  annualIncome: number
  taxableIncome: number
  annualTax: number
  monthlyTax: number // annualTax ÷ 12 (the flat ideal)
  previousTaxDeducted: number
  manualAdjustment: number
  netMonthlyAit: number // §86(4) catch-up actually posted by payroll
  remainingEstimate: number // EXT-01 — full remaining §86 liability (annualTax − TDS to date): what a FINAL payment (exit settlement) must withhold
  averageRatePercent: number
  tdsCatchUp: number | null
  minimumTaxWarning: boolean
  surchargeAmount: number
  warnings: { code: string; message: string; bn?: string }[]
  slabLines?: { from: number; to: number | null; rate: number; tax: number }[]
  exemptions?: { name: string; type: string; amount: number }[]
}

type Slab = { minIncome: number; maxIncome: number | null; rate: number }

export function computeSlabTax(annualIncome: number, taxFree: number, slabs: Slab[]): {
  tax: number
  lines: { from: number; to: number | null; rate: number; tax: number }[]
} {
  const taxable = Math.max(0, annualIncome - taxFree)
  let tax = 0
  const lines: { from: number; to: number | null; rate: number; tax: number }[] = []
  for (const s of slabs) {
    const slabStart = s.minIncome
    const slabEnd = s.maxIncome ?? Infinity
    const overlap = Math.max(0, Math.min(taxable, slabEnd) - Math.max(0, Math.min(taxable, slabStart)))
    const lineTax = (overlap / 100) * s.rate
    if (overlap > 0) {
      lines.push({ from: slabStart, to: s.maxIncome, rate: s.rate, tax: Math.round(lineTax) })
      tax += lineTax
    }
  }
  return { tax: Math.round(tax), lines }
}

/** Legacy BD slab bands kept for the unit tests (tests/unit/ait-slab-engine.test.ts). */
export const BD_DEFAULT_SLABS: { minIncome: number; maxIncome: number | null; rate: number }[] = [
  { minIncome: 0, maxIncome: 100000, rate: 5 },
  { minIncome: 100000, maxIncome: 300000, rate: 10 },
  { minIncome: 300000, maxIncome: 500000, rate: 15 },
  { minIncome: 500000, maxIncome: 800000, rate: 20 },
  { minIncome: 800000, maxIncome: 1200000, rate: 25 },
  { minIncome: 1200000, maxIncome: null, rate: 30 },
]

export async function computeAit(opts: {
  vendorId: string
  ruleSetId?: string | null
  monthlyTaxableIncome: number
  previousEmployerIncome?: number
  previousTaxDeducted?: number
  manualAdjustment?: number
  /** HIGH-7 — pre-fetched config for tight per-employee loops. */
  config?: any
  /** R2 — the employee's tax profile (category, DOB, declared investment,
   *  monthly basic) so thresholds, senior auto-detection and the §78 rebate
   *  apply on payslips exactly like the AIT module's own calculator.
   *  r8 — netWealth/motorVehicles ride along so the journal + annual views
   *  carry the surcharge assessment (annual-only; never affects TDS). */
  employeeProfile?: {
    taxpayerCategory?: string | null
    dateOfBirth?: string | null
    declaredInvestment?: number | null
    monthlyBasicSalary?: number | null
    netWealth?: number | null
    motorVehicles?: number | null
    gender?: string | null
  }
  /** r8 legal audit — §86 estimated-annual-income inputs from the payroll
   *  engine (all figures are ACTUALS from PAID runs inside the income-year
   *  window, before the run being calculated):
   *    annualEstimate    the §86 "estimated total income" (YTD paid earnings +
   *                      this period's payment + projected remaining months ×
   *                      regular gross + remaining festival-bonus projection +
   *                      previous-employer income); null → fall back to
   *                      12 × monthlyTaxableIncome (legacy projection)
   *    tdsWithheldYtd    actual TDS already deducted this FY (own PAID runs +
   *                      prior-employer withholding) — drives the §86(4)
   *                      catch-up; null → falls back to previousTaxDeducted
   *    monthsRemainingInFy months left in the income year INCLUDING the
   *                      period being calculated (1–12) */
  annualEstimate?: number | null
  tdsWithheldYtd?: number | null
  monthsRemainingInFy?: number | null
}): Promise<AitResult> {
  const { vendorId, monthlyTaxableIncome } = opts
  const manual = opts.manualAdjustment || 0

  // ---- primary path: the new configuration-driven engine ----
  let config = opts.config || (await loadAitConfig(vendorId).catch(() => null))
  if (!config) {
    // bootstrap on first use so a fresh install works out of the box
    await ensureAitConfig(vendorId).catch(() => {})
    config = await loadAitConfig(vendorId).catch(() => null)
  }
  if (config) {
    const empProfile = opts.employeeProfile as
      | { taxpayerCategory?: string | null; dateOfBirth?: string | null; declaredInvestment?: number | null; monthlyBasicSalary?: number | null; netWealth?: number | null; motorVehicles?: number | null; gender?: string | null }
      | undefined
    // §86 estimated annual income: the payroll-supplied estimate when present
    // (YTD actuals + projection), otherwise the legacy 12× monthly equivalent.
    const estimateProvided = opts.annualEstimate != null && Number.isFinite(opts.annualEstimate) && (opts.annualEstimate as number) > 0
    const annualIncome = Math.round(
      estimateProvided
        ? Math.max(0, opts.annualEstimate as number)
        : monthlyTaxableIncome * 12 + (opts.previousEmployerIncome || 0),
    )
    // §86(4): the adjustment base is the ACTUAL TDS deducted to date (own PAID
    // runs + genuinely prior withholding). The legacy static field is only
    // used as a fallback when the caller cannot supply actuals.
    const tdsYtd = opts.tdsWithheldYtd != null && Number.isFinite(opts.tdsWithheldYtd)
      ? Math.max(0, opts.tdsWithheldYtd as number)
      : Math.max(0, opts.previousTaxDeducted || 0)
    const res = calculateAit(config, {
      monthlyGrossSalary: monthlyTaxableIncome,
      ...(empProfile?.monthlyBasicSalary != null ? { monthlyBasicSalary: empProfile.monthlyBasicSalary } : {}),
      // estimateProvided → the fully-formed §86 estimate bypasses projection
      annualGrossOverride: estimateProvided ? annualIncome : undefined,
      ...(empProfile?.taxpayerCategory != null ? { taxpayerCategory: empProfile.taxpayerCategory } : {}),
      ...(empProfile?.dateOfBirth != null ? { dateOfBirth: empProfile.dateOfBirth } : {}),
      ...(empProfile?.declaredInvestment != null ? { declaredInvestment: empProfile.declaredInvestment } : {}),
      ...(empProfile?.netWealth != null ? { netWealth: empProfile.netWealth } : {}),
      ...(empProfile?.motorVehicles != null ? { motorVehicles: empProfile.motorVehicles } : {}),
      ...(empProfile?.gender != null ? { gender: empProfile.gender } : {}),
      currentMonthGross: monthlyTaxableIncome,
      tdsYtd,
      ...(opts.monthsRemainingInFy != null ? { monthsRemainingInFy: opts.monthsRemainingInFy } : {}),
    })
    // netMonthlyAit = the §86(4) catch-up (annualTax − TDS to date) ÷ months
    // remaining — minus any manual adjustment, floored at zero.
    const tdsCatchUp = res.monthlyTdsCatchUp != null
      ? res.monthlyTdsCatchUp
      : Math.max(0, res.monthlyTds - Math.round(tdsYtd / 12))
    const netMonthlyAit = Math.max(0, Math.round(tdsCatchUp - manual))
    return {
      mode: "SLAB",
      ruleSetId: config.fiscalYearId,
      ruleSetName: `${config.label} (Income Tax Act 2023)`,
      annualIncome: res.annualGross,
      taxableIncome: res.taxableIncome,
      annualTax: res.annualTax,
      monthlyTax: Math.round(res.annualTax / 12),
      previousTaxDeducted: tdsYtd,
      manualAdjustment: manual,
      netMonthlyAit,
      remainingEstimate: Math.max(0, Math.round(res.remainingEstimate ?? (res.annualTax - tdsYtd))),
      averageRatePercent: res.averageRatePercent,
      tdsCatchUp: res.monthlyTdsCatchUp,
      minimumTaxWarning: res.minimumTaxWarning,
      surchargeAmount: res.surcharge?.amount ?? 0,
      warnings: res.warnings,
      slabLines: res.slabLines.map((l) => ({ from: 0, to: null, rate: l.rate, tax: l.tax })),
    }
  }

  // ---- fallback: legacy TaxRuleSet (pre-rebuild vendors) ----
  const ruleSetId = opts.ruleSetId || (await getActiveRuleSetId(vendorId))
  if (!ruleSetId) {
    return {
      mode: "NONE", ruleSetId: null, ruleSetName: "No active tax configuration",
      annualIncome: 0, taxableIncome: 0, annualTax: 0, monthlyTax: 0,
      previousTaxDeducted: Math.max(0, opts.previousTaxDeducted || 0), manualAdjustment: manual, netMonthlyAit: 0, remainingEstimate: 0,
      averageRatePercent: 0, tdsCatchUp: null, minimumTaxWarning: false, surchargeAmount: 0, warnings: [],
    }
  }
  const rs = await db.taxRuleSet.findFirst({ where: { id: ruleSetId, vendorId } })
  if (!rs) throw new Error("Tax rule set not found")

  const { getSettings } = await import("./settings")
  const settings = await getSettings(vendorId)
  const annualizeMonths = settings.ait.annualizeMonths > 0 ? settings.ait.annualizeMonths : 12
  const prevEmployer = Math.max(0, opts.previousEmployerIncome || 0)
  const annualIncome = Math.round(monthlyTaxableIncome * annualizeMonths + prevEmployer)

  if (rs.mode === "DIRECT") {
    const monthly = rs.directAmount
    return {
      mode: rs.mode, ruleSetId: rs.id, ruleSetName: rs.name, annualIncome, taxableIncome: 0,
      annualTax: monthly * 12, monthlyTax: monthly, previousTaxDeducted: opts.previousTaxDeducted || 0,
      manualAdjustment: manual, netMonthlyAit: Math.max(0, monthly - Math.round((opts.previousTaxDeducted || 0) / annualizeMonths) - manual), remainingEstimate: Math.max(0, monthly * 12 - (opts.previousTaxDeducted || 0)),
      averageRatePercent: monthly > 0 ? (monthly * 12 / Math.max(1, annualIncome)) * 100 : 0,
      tdsCatchUp: null, minimumTaxWarning: false, surchargeAmount: 0, warnings: [],
    }
  }
  if (rs.mode === "PERCENT") {
    const monthly = Math.round((monthlyTaxableIncome * rs.percent) / 100)
    return {
      mode: rs.mode, ruleSetId: rs.id, ruleSetName: rs.name, annualIncome, taxableIncome: monthlyTaxableIncome,
      annualTax: monthly * 12, monthlyTax: monthly, previousTaxDeducted: opts.previousTaxDeducted || 0,
      manualAdjustment: manual, netMonthlyAit: Math.max(0, monthly - Math.round((opts.previousTaxDeducted || 0) / annualizeMonths) - manual), remainingEstimate: Math.max(0, monthly * 12 - (opts.previousTaxDeducted || 0)),
      averageRatePercent: rs.percent, tdsCatchUp: null, minimumTaxWarning: false, surchargeAmount: 0, warnings: [],
    }
  }

  const exemptions = await db.taxExemption.findMany({ where: { vendorId, active: true } })
  const applied: { name: string; type: string; amount: number }[] = []
  let exemptionDeduction = 0
  for (const ex of exemptions) {
    if (ex.type === "DEDUCTION") {
      const amt = ex.maxAmount > 0 ? ex.maxAmount : 0
      if (amt > 0) { exemptionDeduction += amt; applied.push({ name: ex.name, type: ex.type, amount: amt }) }
    }
  }
  const slabs = await db.taxSlab.findMany({ where: { ruleSetId: rs.id }, orderBy: { minIncome: "asc" } })
  const { tax, lines } = computeSlabTax(Math.max(0, annualIncome - exemptionDeduction), rs.taxFreeThreshold, slabs)
  let annualTax = tax
  if (rs.rebatePercent > 0) annualTax = Math.round(annualTax * (1 - rs.rebatePercent / 100))
  for (const ex of exemptions) {
    if (ex.type === "REBATE" && ex.percent > 0) {
      const amt = Math.round(annualTax * (ex.percent / 100))
      const capped = ex.maxAmount > 0 ? Math.min(amt, ex.maxAmount) : amt
      if (capped > 0) { annualTax -= capped; applied.push({ name: ex.name, type: ex.type, amount: capped }) }
    } else if (ex.type === "FIXED" && ex.maxAmount > 0) {
      annualTax -= ex.maxAmount
      applied.push({ name: ex.name, type: ex.type, amount: ex.maxAmount })
    }
  }
  annualTax = Math.max(0, annualTax)
  const monthlyTax = Math.round(annualTax / annualizeMonths)
  // HIGH-6 — annualize prior TDS by /12 to match the engine-path semantics.
  return {
    mode: rs.mode, ruleSetId: rs.id, ruleSetName: rs.name,
    annualIncome, taxableIncome: Math.max(0, annualIncome - exemptionDeduction - rs.taxFreeThreshold),
    annualTax, monthlyTax, slabLines: lines,
    exemptions: applied,
    previousTaxDeducted: opts.previousTaxDeducted || 0, manualAdjustment: manual,
    netMonthlyAit: Math.max(0, monthlyTax - Math.round((opts.previousTaxDeducted || 0) / annualizeMonths) - manual),
    remainingEstimate: Math.max(0, annualTax - (opts.previousTaxDeducted || 0)),
    averageRatePercent: annualIncome > 0 ? (annualTax / annualIncome) * 100 : 0,
    tdsCatchUp: null, minimumTaxWarning: false, surchargeAmount: 0, warnings: [],
  }
}

export async function getActiveRuleSetId(vendorId: string): Promise<string | null> {
  const rs = await db.taxRuleSet.findFirst({ where: { vendorId, active: true }, orderBy: { createdAt: "desc" } })
  return rs?.id || null
}

// re-export the new engine for direct callers
export { calculateAit, loadAitConfig, ensureAitConfig, fyStartDate, ageAt, currentIncomeYear } from "./ait-engine"
export type { AitConfig, AitInput, AitCalculation } from "./ait-engine"

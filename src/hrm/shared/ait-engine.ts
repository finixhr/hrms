// ============ AIT / TDS Calculation Engine — Income Tax Act 2023 ============
// Pure, dependency-free engine implementing monthly salary tax withholding
// (Section 86, ITA 2023) with a FULLY dynamic configuration layer: tax slabs,
// thresholds, rates, exemption limits, minimum tax and rebate percentages are
// supplied per fiscal year — nothing fiscal-year-specific is hardcoded.
//
// Shared by:
//   - the legacy certificate builder (types + disclaimer strings)
//   - any client-side re-computation
// NOTE (r8 legal audit, 2026-10-14): the AUTHORITATIVE engine is the server
// side — src/hrm-server/ait-engine.ts — which additionally implements the
// §78 three-limb rebate, the post-rebate minimum-tax test, the net-wealth
// surcharge, the non-resident flat rate and the §86(4) cumulative catch-up.
// This shared copy mirrors the core math and is kept API-compatible.
//
// Legal basis:
//   TDS on salary ............ Section 86, Income Tax Act 2023
//   Salary definition/exempt .. Section 32 & Third Schedule, ITA 2023
//   Slabs & rates ............. annual Finance Act / Finance Ordinance (§18(2))
//   Minimum tax .............. annual Finance Act individual floor (§163 framework)
//   Investment rebate ........ Section 78, ITA 2023
//   Reconciliation ........... Section 166 & related rules

// ---------- configuration types (per fiscal year, admin-managed) ----------
export type AitSlabConfig = { order: number; label: string; upperLimit: number | null; ratePercent: number }
export type AitCategoryConfig = { key: string; label: string; labelBn?: string; threshold: number }

export type AitEngineConfig = {
  fiscalYearId: string
  label: string                  // "FY 2025-26"
  incomeYear: string             // "2025-26"
  assessmentYear: string         // "2026-27" (income year + 1 — ITA 2023 §2(15)/(24))
  tdsSectionRef: string          // "Section 86, ITA 2023"
  exemptionFraction: number      // 1/3 (Third Schedule item 27)
  exemptionCap: number           // ৳ 5,00,000 for IY 2025-26 onward
  minimumTaxAmount: number       // ৳ 5,000 individual floor (annual Finance Act)
  newTaxpayerMinimumTax?: number | null // ৳ 1,000 first-time filers (AY 2026-27+)
  rebateRate: number             // §78(b): % of eligible investment (15% IY 25-26; 10% IY 26-27)
  rebateIncomeCapPercent: number // §78(a): % of taxable income (3%)
  investmentCapAmount: number    // §78(c): absolute rebate cap (৳10,00,000 IY 25-26; ৳7,50,000 IY 26-27)
  investmentCapFraction: number  // LEGACY pre-r8 — unused by the engine
  festivalBonusCount: number     // default 2 × basic
  slabs: AitSlabConfig[]         // ordered cumulative bands
  categories: AitCategoryConfig[] // taxpayer categories with thresholds
}

// ---------- employee-side inputs (spec §5) ----------
export type AitEngineInput = {
  monthlyBasic: number
  monthlyGross: number                    // must be ≥ basic (validated)
  currentMonthGross?: number | null       // actual gross this month (defaults to monthlyGross)
  taxpayerCategory?: string | null        // explicit category key on the employee record
  dateOfBirth?: string | null             // ISO — auto-suggests "senior citizen" at ≥ 65
  gender?: string | null                  // auto-suggests "female" category
  festivalBonusOverride?: number | null   // null → use festivalBonusCount × basic
  annualGrossOverride?: number | null     // provided → bypass projection entirely
  declaredInvestment?: number | null      // Sec 78 rebate (only if submitted)
  previousEmployerIncome?: number         // same-FY income already earned elsewhere
  tdsYtd?: number                         // year-to-date TDS already deducted (informational)
  aitMonthlyOverride?: number | null      // manual monthly TDS (year-end adjustment)
}

// ---------- output ----------
export type AitBreakdownLine = {
  n: number
  label: string
  labelBn: string
  ref?: string
  amount?: number
  text?: string
  kind: "info" | "calc" | "total" | "grand"
}

export type AitWarning = { code: string; en: string; bn: string }

export type AitEngineResult = {
  blocked?: string                    // set when calculation is impossible (e.g. no active FY)
  errors: string[]                     // validation failures — caller must block the save
  config: AitEngineConfig | null
  category: { key: string; label: string; threshold: number; assumed: boolean }
  annualGross: number
  exemption: number
  taxableIncome: number
  incomeAboveThreshold: number
  annualTaxBeforeRebate: number
  rebateApplied: boolean
  rebateAmount: number
  annualTax: number                    // net of rebate
  averageRatePercent: number
  monthlyTds: number                   // rounded to whole taka
  minimumTaxWarning: boolean
  tdsYtd: number
  remainingEstimatedTax: number
  slabLines: { order: number; label: string; ratePercent: number; amount: number; tax: number }[]
  lines: AitBreakdownLine[]
  warnings: AitWarning[]
  projection: { monthlyGross: number; bonusProjected: number; bonusCount: number; overridden: boolean }
}

export const EMPTY_AIT_RESULT: AitEngineResult = {
  errors: [], config: null, category: { key: "general", label: "General", threshold: 0, assumed: true },
  annualGross: 0, exemption: 0, taxableIncome: 0, incomeAboveThreshold: 0,
  annualTaxBeforeRebate: 0, rebateApplied: false, rebateAmount: 0, annualTax: 0,
  averageRatePercent: 0, monthlyTds: 0, minimumTaxWarning: false, tdsYtd: 0, remainingEstimatedTax: 0,
  slabLines: [], lines: [], warnings: [],
  projection: { monthlyGross: 0, bonusProjected: 0, bonusCount: 0, overridden: false },
}

// ---------- FY 2025-26 defaults (Finance Ordinance 2025 — ENACTED numbers) ----------
// Bootstrap values only — every figure stays admin-editable per fiscal year.
// Verified 2026-10-14 against the NBR consolidated ITA 2023 (June 2025), KPMG
// "Salient Features of Finance Ordinance 2025" and PwC's individual rates.
export const BD_FY2025_26_SLABS: AitSlabConfig[] = [
  { order: 1, label: "Next ৳ 3,00,000", upperLimit: 300000, ratePercent: 10 },
  { order: 2, label: "Next ৳ 4,00,000", upperLimit: 400000, ratePercent: 15 },
  { order: 3, label: "Next ৳ 5,00,000", upperLimit: 500000, ratePercent: 20 },
  { order: 4, label: "Next ৳ 20,00,000", upperLimit: 2000000, ratePercent: 25 },
  { order: 5, label: "Balance (unlimited)", upperLimit: null, ratePercent: 30 },
]

export const BD_FY2025_26_CATEGORIES: AitCategoryConfig[] = [
  { key: "general", label: "General", labelBn: "সাধারণ", threshold: 375000 },
  { key: "female", label: "Female", labelBn: "মহিলা", threshold: 425000 },
  { key: "senior", label: "Senior Citizen (≥ 65)", labelBn: "সিনিয়র নাগরিক (৬৫+)", threshold: 425000 },
  { key: "third_gender", label: "Third Gender", labelBn: "তৃতীয় লিঙ্গ", threshold: 500000 },
  { key: "disabled", label: "Person with Disability", labelBn: "প্রতিবন্ধী ব্যক্তি", threshold: 500000 },
  { key: "freedom_fighter", label: "Gazetted Freedom Fighter", labelBn: "সরকারি মুক্তিযোদ্ধা", threshold: 525000 },
  { key: "july_warrior", label: "Gazetted July Warrior", labelBn: "সরকারি জুলাই যোদ্ধা", threshold: 525000 },
  { key: "non_resident", label: "Non-resident (flat 30%)", labelBn: "অনিবাসী (৩০%)", threshold: 0 },
]

export function defaultFiscalYearConfig(over: Partial<AitEngineConfig> = {}): AitEngineConfig {
  return {
    fiscalYearId: "", label: "FY 2025-26", incomeYear: "2025-26", assessmentYear: "2026-27",
    tdsSectionRef: "Section 86, ITA 2023",
    exemptionFraction: 1 / 3, exemptionCap: 500000, minimumTaxAmount: 5000, newTaxpayerMinimumTax: 1000,
    rebateRate: 15, rebateIncomeCapPercent: 3, investmentCapAmount: 1000000, investmentCapFraction: 0.25,
    festivalBonusCount: 2,
    slabs: BD_FY2025_26_SLABS.map((s) => ({ ...s })),
    categories: BD_FY2025_26_CATEGORIES.map((c) => ({ ...c })),
    ...over,
  }
}

// ---------- helpers ----------
export function ageFromDob(dob?: string | null, today = new Date()): number | null {
  if (!dob) return null
  const d = new Date(dob)
  if (Number.isNaN(d.getTime())) return null
  let age = today.getFullYear() - d.getFullYear()
  const m = today.getMonth() - d.getMonth()
  if (m < 0 || (m === 0 && today.getDate() < d.getDate())) age--
  return age < 0 ? 0 : age
}

/** Category auto-suggestion from profile data (never overrides an explicit choice). */
export function suggestCategory(cfg: AitEngineConfig, input: AitEngineInput): { key: string; assumed: boolean } {
  if (input.taxpayerCategory) {
    const hit = cfg.categories.find((c) => c.key === input.taxpayerCategory)
    if (hit) return { key: hit.key, assumed: false }
  }
  const age = ageFromDob(input.dateOfBirth)
  if (age != null && age >= 65 && cfg.categories.some((c) => c.key === "senior")) return { key: "senior", assumed: true }
  if (input.gender && /female|^f$/i.test(input.gender) && cfg.categories.some((c) => c.key === "female")) return { key: "female", assumed: true }
  return { key: cfg.categories[0]?.key || "general", assumed: true }
}

const money = (n: number) => Math.round(n)

// ---------- the engine (spec §4, steps 1–7 in strict order) ----------
export function calculateAit(cfg: AitEngineConfig | null, input: AitEngineInput): AitEngineResult {
  if (!cfg) return { ...EMPTY_AIT_RESULT, blocked: "NO_ACTIVE_FISCAL_YEAR", errors: ["No active fiscal year configuration — an HR admin must configure one under HR Settings → AIT / Tax before any tax calculation."] }

  const errors: string[] = []
  const monthlyBasic = Number(input.monthlyBasic || 0)
  const monthlyGross = Number(input.monthlyGross || 0)
  if (monthlyGross < 0 || monthlyBasic < 0) errors.push("Salary amounts cannot be negative")
  if (monthlyBasic > monthlyGross) errors.push("Monthly basic salary cannot exceed monthly gross salary")
  if (errors.length) return { ...EMPTY_AIT_RESULT, config: cfg, errors }

  const warnings: AitWarning[] = []

  // ---- Step 1 — project annual gross (12 × monthly + festival bonuses, overridable)
  const bonusCount = cfg.festivalBonusCount > 0 ? cfg.festivalBonusCount : 0
  const bonusProjected = input.festivalBonusOverride != null ? Math.max(0, input.festivalBonusOverride) : money(monthlyBasic * bonusCount)
  const overridden = input.annualGrossOverride != null && Number.isFinite(input.annualGrossOverride)
  const annualGross = money(
    (overridden ? Math.max(0, Number(input.annualGrossOverride)) : monthlyGross * 12 + bonusProjected)
    + Math.max(0, input.previousEmployerIncome || 0),
  )
  if (overridden) {
    const projection = monthlyGross * 12 + bonusProjected + Math.max(0, input.previousEmployerIncome || 0)
    if (annualGross < projection) warnings.push({ code: "OVERRIDE_LOW", en: `Annual gross override (৳ ${annualGross.toLocaleString("en-IN")}) is lower than the projection (৳ ${money(projection).toLocaleString("en-IN")}) — confirm before finalizing.`, bn: "বার্ষিক আয় ওভাররাইড প্রক্ষেপণের চেয়ে কম — চূড়ান্ত করার আগে নিশ্চিত করুন।" })
  }

  // ---- Step 2 — salary exemption (Third Schedule, ITA 2023)
  const exemption = money(Math.min(annualGross * cfg.exemptionFraction, cfg.exemptionCap))
  const taxableIncome = Math.max(0, annualGross - exemption)

  // ---- category + Step 3 — tax-free threshold (First Schedule)
  const sugg = suggestCategory(cfg, input)
  const cat = cfg.categories.find((c) => c.key === sugg.key) || cfg.categories[0] || { key: "general", label: "General", threshold: 0 }
  if (sugg.assumed) {
    if (cat.key === "senior") {
      warnings.push({ code: "CATEGORY_SENIOR_ASSUMED", en: `Category assumed as ${cat.label} from age — please verify before finalizing.`, bn: "বয়স থেকে সিনিয়র শ্রেণি ধরা হয়েছে — চূড়ান্ত করার আগে যাচাই করুন।" })
    } else {
      warnings.push({ code: "CATEGORY_ASSUMED", en: `Category assumed as ${cat.label} from profile — please verify before finalizing.`, bn: `প্রোফাইল থেকে ${cat.labelBn || cat.label} শ্রেণি ধরা হয়েছে — চূড়ান্ত করার আগে যাচাই করুন।` })
    }
    if (!input.dateOfBirth) warnings.push({ code: "DOB_MISSING", en: "Date of birth is missing — the senior-citizen (≥ 65) threshold could not be checked. Verify the taxpayer category.", bn: "জন্মতারিখ নেই — সিনিয়র নাগরিক (৬৫+) সীমা যাচাই করা যায়নি। করদাতার শ্রেণি নিশ্চিত করুন।" })
  }
  const incomeAboveThreshold = Math.max(0, taxableIncome - cat.threshold)

  // ---- Step 4 — dynamic slab loop (never assumes a fixed slab count)
  const slabs = [...(cfg.slabs || [])].filter((s) => Number.isFinite(s.ratePercent) && s.ratePercent >= 0).sort((a, b) => (a.order || 0) - (b.order || 0))
  let remaining = incomeAboveThreshold
  let annualTaxBeforeRebate = 0
  const slabLines: AitEngineResult["slabLines"] = []
  for (const s of slabs) {
    if (remaining <= 0) break
    const width = s.upperLimit == null || !Number.isFinite(s.upperLimit) ? remaining : Math.max(0, s.upperLimit)
    const applicable = Math.min(remaining, width)
    if (applicable > 0) {
      const tax = (applicable * s.ratePercent) / 100
      annualTaxBeforeRebate += tax
      slabLines.push({ order: s.order, label: s.label, ratePercent: s.ratePercent, amount: applicable, tax })
      remaining -= applicable
    }
  }
  annualTaxBeforeRebate = money(annualTaxBeforeRebate)

  // ---- Step 5 — investment rebate (§78, lower of three limbs) ----
  // §78 (as consolidated June 2025): rebate = LOWER OF (a) 3% of taxable
  // income, (b) rebateRate% of eligible investment, (c) absolute cap.
  let rebateApplied = false
  let rebateAmount = 0
  let annualTax = annualTaxBeforeRebate
  const declared = input.declaredInvestment
  if (declared != null && Number.isFinite(declared) && declared > 0) {
    const limbIncome = money((taxableIncome * (cfg.rebateIncomeCapPercent ?? 3)) / 100)
    const limbInvestment = money((Math.max(0, declared) * (cfg.rebateRate ?? 15)) / 100)
    const limbAbsolute = money(cfg.investmentCapAmount || 0)
    rebateAmount = Math.max(0, Math.min(limbIncome, limbInvestment, limbAbsolute))
    if (rebateAmount > 0) {
      annualTax = Math.max(0, annualTaxBeforeRebate - rebateAmount)
      rebateApplied = true
    }
  } else {
    warnings.push({ code: "REBATE_NOT_APPLIED", en: "Investment rebate not applied — employee may claim at return filing [Sec 78].", bn: "বিনিয়োগ রেয়াত প্রয়োগ হয়নি — কর্মী বার্ষিক রিটার্ন দাখিলের সময় দাবি করতে পারবেন।" })
  }

  // ---- Step 6 — minimum tax (annual Finance Act floor): AFTER rebate, flag only ----
  const minimumTaxWarning = incomeAboveThreshold > 0 && annualTax > 0 && annualTax < cfg.minimumTaxAmount
  if (minimumTaxWarning) {
    warnings.push({ code: "MIN_TAX", en: `Annual tax after rebate (৳ ${annualTax.toLocaleString("en-IN")}) is below the individual minimum-tax floor of ৳ ${money(cfg.minimumTaxAmount).toLocaleString("en-IN")} (annual Finance Act; §163 framework) — the floor binds at return filing, never in monthly withholding.`, bn: `রেয়াত-পরবর্তী বার্ষিক কর ন্যূনতম ৳ ${money(cfg.minimumTaxAmount).toLocaleString("en-IN")}-এর নিচে (বার্ষিক অর্থ আইন; ধারা ১৬৩) — এটি রিটার্ন-পর্যায়ে প্রযোজ্য, মাসিক কর্তনে নয়।` })
  }

  // ---- Step 7 — average rate & monthly TDS (Section 86)
  const averageRatePercent = annualGross > 0 ? (annualTax / annualGross) * 100 : 0
  const currentMonthGross = input.currentMonthGross != null && Number.isFinite(input.currentMonthGross) && input.currentMonthGross >= 0 ? input.currentMonthGross : monthlyGross
  let monthlyTds = money((currentMonthGross * averageRatePercent) / 100)
  if (input.aitMonthlyOverride != null && Number.isFinite(input.aitMonthlyOverride)) {
    monthlyTds = money(Math.max(0, input.aitMonthlyOverride))
    warnings.push({ code: "MANUAL_OVERRIDE", en: `Monthly TDS manually overridden to ৳ ${monthlyTds.toLocaleString("en-IN")} (year-end reconciliation adjustment).`, bn: "মাসিক কর কর্তন ম্যানুয়ালি ওভাররাইড করা হয়েছে (বছর-শেষ সমন্বয়)।" })
  }

  const tdsYtd = Math.max(0, Number(input.tdsYtd || 0))
  const remainingEstimatedTax = Math.max(0, annualTax - tdsYtd)

  // ---- structured, line-by-line breakdown (spec §6) with legal references
  const L = (n: number, label: string, labelBn: string, amount?: number, ref?: string, kind: AitBreakdownLine["kind"] = "info", text?: string): AitBreakdownLine => ({ n, label, labelBn, ref, amount, kind, text })
  const lines: AitBreakdownLine[] = [
    L(1, "Monthly Gross Salary", "মাসিক মোট বেতন", monthlyGross),
    overridden
      ? L(2, "Annual Gross (Actual Override)", "বার্ষিক মোট আয় (প্রকৃত ওভাররাইড)", annualGross, "spec §5 annual_gross_override")
      : L(2, `Projected Annual Gross (12 × gross + ${bonusCount} × basic bonus)`, `প্রক্ষেপিত বার্ষিক মোট আয় (১২ × মোট + ${bonusCount} × মূল বোনাস)`, annualGross),
    ...(input.previousEmployerIncome && input.previousEmployerIncome > 0 ? [L(2.5, "Income from previous employer (same FY)", "পূর্ব নিয়োগকর্তার আয় (একই অর্থবছর)", money(input.previousEmployerIncome))] : []),
    L(3, `Salary Exemption = MIN(annual gross ÷ ${cfg.exemptionFraction === 1 / 3 ? "3" : String(Math.round(cfg.exemptionFraction * 1000) / 1000)}, ৳ ${money(cfg.exemptionCap).toLocaleString("en-IN")})`, "বেতন ছাড়", exemption, "Third Schedule, ITA 2023"),
    L(4, "Taxable Income (gross − exemption)", "করযোগ্য আয়", taxableIncome),
    L(5, `Tax-Free Threshold [${cat.label}]`, `করমুক্ত সীমা [${cat.labelBn || cat.label}]`, cat.threshold, "Annual Finance Act rates (§18(2), ITA 2023)"),
    L(6, "Income Subject to Slab Tax", "স্তরভিত্তিক করযোগ্য আয়", incomeAboveThreshold),
    L(7, "Slab-wise Tax Breakdown", "স্তরভিত্তিক কর বিশ্লেষণ", undefined, "Annual Finance Act slabs (dynamic per fiscal year)", "calc", `${slabLines.length} slab(s)`),
    L(8, "Total Annual Tax", "মোট বার্ষিক কর", annualTaxBeforeRebate, undefined, "total"),
    ...(rebateApplied ? [L(9, `Investment Rebate — lower of 3% of taxable income / ${cfg.rebateRate}% of eligible investment / ৳ ${money(cfg.investmentCapAmount || 0).toLocaleString("en-IN")}`, "বিনিয়োগ রেয়াত", -rebateAmount, "Section 78, ITA 2023")] : []),
    L(10, "Net Annual Tax", "নিট বার্ষিক কর", annualTax, undefined, "total"),
    L(11, "Average Tax Rate", "গড় করহার", undefined, cfg.tdsSectionRef, "info", `${averageRatePercent.toFixed(2)}%`),
    L(12, `This Month's TDS (current gross ৳ ${money(currentMonthGross).toLocaleString("en-IN")} × avg rate)`, "এ মাসের অগ্রিম কর কর্তন", monthlyTds, cfg.tdsSectionRef, "grand"),
    L(13, "Year-to-Date TDS Deducted", "চলতি বছরে কর্তিত কর", tdsYtd),
    L(14, "Remaining Estimated Tax (annual − YTD)", "বাকি আনুমানিক কর", remainingEstimatedTax),
  ]

  return {
    config: cfg, errors, category: { key: cat.key, label: cat.label, threshold: cat.threshold, assumed: sugg.assumed },
    annualGross, exemption, taxableIncome, incomeAboveThreshold,
    annualTaxBeforeRebate, rebateApplied, rebateAmount, annualTax,
    averageRatePercent, monthlyTds, minimumTaxWarning, tdsYtd, remainingEstimatedTax,
    slabLines, lines, warnings,
    projection: { monthlyGross, bonusProjected, bonusCount, overridden },
  }
}

// ---------- mandatory disclaimer (spec §11 — display in UI & all printed reports) ----------
export const AIT_DISCLAIMER_BN =
  "এই হিসাবটি আয়কর আইন ২০২৩-এর ধারা ৮৬ অনুযায়ী মাসিক উৎসে কর কর্তনের (AIT/TDS) একটি প্রাক্কলন। চূড়ান্ত কর দায় ধারা ১৬৬-এর অধীনে বার্ষিক রিটার্নে নির্ধারিত হবে। ঘোষিত বিনিয়োগ থাকলে ধারা ৭৮ রেয়াত বার্ষিক কর থেকে বাদ দেওয়া হয়; ন্যূনতম কর (৳ ৫,০০০ / নতুন করদাতার জন্য ৳ ১,০০০) ও নিট-সম্পদ সারচার্জ বার্ষিক হিসাবরূপে পৃথকভাবে দেখানো হয় এবং মাসিক কর্তনে যোগ করা হয় না। কর্মীর শ্রেণি ও ঘোষিত তথ্য HR কর্তৃক যাচাইকৃত হতে হবে।"
export const AIT_DISCLAIMER_EN =
  "This is an estimate for monthly salary tax withholding under Section 86, Income Tax Act 2023 (average-rate method with the sub-section (4) cumulative adjustment). Final tax liability is determined by the annual return under Section 166. The Section 78 investment rebate is deducted from the annual tax when an investment is declared; the minimum-tax floor (৳5,000 / ৳1,000 for first-time filers) and the net-wealth surcharge are shown as separate annual items and are not added to monthly withholding. The employee category and declared figures must be verified by HR."

// ---------- Bangladesh fiscal-year window (July–June) ----------
/** Returns [startISO, endISO] of the income year, e.g. "2025-26" → 2025-07-01 … 2026-06-30. */
export function fyWindow(incomeYear: string): { start: string; end: string } {
  const startYear = Number(String(incomeYear).split("-")[0])
  if (!Number.isFinite(startYear)) return { start: "", end: "" }
  const y = startYear + 1
  return { start: `${startYear}-07-01`, end: `${y}-06-30` }
}

/** Months remaining in the fiscal year after the given date (1–12), used by reconciliation. */
export function fyMonthsRemaining(incomeYear: string, today = new Date()): number {
  const { start, end } = fyWindow(incomeYear)
  if (!start || !end) return 12
  const e = new Date(end + "T23:59:59")
  if (today >= e) return 0
  const s = new Date(start + "T00:00:00")
  const from = today < s ? s : today
  const months = (e.getFullYear() - from.getFullYear()) * 12 + (e.getMonth() - from.getMonth())
  return Math.min(12, Math.max(0, months))
}

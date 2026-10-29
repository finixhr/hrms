// ============ AIT / Income Tax engine — Income Tax Act 2023 (Bangladesh) ============
// r8 legal audit (2026-10-14). Every rule below was verified against primary
// sources during the audit:
//   * NBR consolidated Income Tax Act 2023 PDF (nbr.gov.bd, amendments
//     incorporated to 16 June 2025) — §2(15)/(24), §18(2), §32, §78, §86,
//     §163, §164, Third Schedule item (27), Sixth Schedule Part 3
//   * KPMG "Salient Features of Finance Ordinance 2025" (June 2025) —
//     individual slab/threshold/minimum-tax/surcharge tables for AY 2025-26
//     (effective) and AY 2026-27 / 2027-28 (enacted by the Ordinance)
//   * PwC Tax Summaries — Bangladesh, individual rates (FY 2026/27 table,
//     reflecting Finance Act 2026)
//
// Calculation sequence (statutory order — slab tax → rebate → minimum-tax
// test → surcharge → TDS/advance credits):
//   1. Annual income from employment = regular gross × remaining-month
//      projection + festival bonus projection + arrears/previous-employer
//      income (§32: salary, benefits, share schemes, untaxed arrears, past or
//      future employer amounts are ALL employment income)
//   2. Salary exemption (Third Schedule item 27): MIN(employment income ×
//      fraction [1/3], cap [৳5,00,000 for IY 2025-26 onward]) → taxable income
//   3. Category tax-free threshold (annual Finance Act First Schedule-style
//      table; §18(2): rates are prescribed per assessment year by Parliament)
//   4. Progressive slab loop over ANY number of ordered slabs
//   5. Investment rebate (§78, as consolidated June 2025): rebate = LOWER OF
//        (a) 3% of taxable income [A — excludes exempt/reduced/final income],
//        (b) rebateRatePercent% of eligible investment [B — Sixth Schedule
//            Part 3 items], or
//        (c) rebateCapAmount (৳10,00,000 for IY 2025-26; ৳7,50,000 + 10% rate
//            for IY 2026-27 under Finance Act 2026)
//   6. Minimum tax test (annual Finance Act individual floor — ৳5,000 where
//      taxable income exceeds the threshold, ৳1,000 for first-time filers;
//      §163 framework). WARNING ONLY for monthly TDS — the floor is a
//      return-filing liability, never silently added to withholding.
//   7. Surcharge (FO 2025 / FA 2026 net-wealth bands + motor-vehicle trigger)
//      on the tax amount — annual computation only, with a warning when the
//      employee's net wealth is not on record.
//   8. Monthly TDS (§86): §86(1) average rate on the month's payment, and
//      §86(4) surplus/deficit adjustment against TDS already deducted —
//      exposed as the catch-up figure payroll posts.
//
// Age / senior-citizen handling: age is measured at the START of the fiscal
// year (1 July). Age ≥ 65 auto-suggests the "senior" category — if HR picked
// a different category the engine APPLIES the senior threshold and emits a
// verification warning, so an elderly person is never taxed at the general
// threshold by accident.
import { db } from "@/lib/db"

// ---------- types ----------

export type SlabRow = { order: number; slabLabel: string; upperLimit: number | null; ratePercent: number }
export type CategoryRow = { key: string; label: string; threshold: number }

export type SurchargeBand = { netWorthOver: number; netWorthUpTo: number | null; percent: number }

export type AitConfig = {
  fiscalYearId: string
  label: string
  incomeYear: string
  assessmentYear: string
  tdsSectionRef: string
  exemptionFraction: number
  exemptionCap: number
  minimumTax: number
  newTaxpayerMinimumTax: number | null
  rebateRatePercent: number      // §78(b) — % of eligible investment
  rebateIncomeCapPercent: number // §78(a) — % of taxable income
  rebateCapAmount: number        // §78(c) — absolute cap
  rebateCapFraction: number      // LEGACY pre-r8 field — ignored by the engine
  festivalBonusCount: number
  categories: CategoryRow[]
  slabs: SlabRow[]
  surcharge: { bands: SurchargeBand[]; motorVehicleTrigger: number; houseSftTrigger: number } | null
}

export type AitInput = {
  taxpayerCategory?: string | null // general | female | senior | disabled | third_gender | freedom_fighter | july_warrior | non_resident | …
  gender?: string | null // auto-suggests the "female" category when no explicit choice is on record
  dateOfBirth?: string | null // ISO — drives senior (≥65) auto-detection
  monthlyBasicSalary?: number
  monthlyGrossSalary: number
  festivalBonusOverride?: number | null // explicit bonus COUNT (× monthly basic) or legacy amount
  festivalBonusBasis?: "BASIC" | "GROSS" | "FIXED" | string | null
  festivalBonusMultiplier?: number | null
  festivalBonusAmount?: number | null
  annualGrossOverride?: number | null // explicit annual gross — bypasses projection
  currentMonthGross?: number // defaults to monthlyGrossSalary
  declaredInvestment?: number | null
  tdsYtd?: number // actual tax already deducted this FY (§86(4) adjustment)
  monthsRemainingInFy?: number | null // incl. the month being computed — drives the catch-up TDS
  netWealth?: number | null // declared net worth (surcharge test)
  motorVehicles?: number | null // motor cars owned (>1 triggers the 10% surcharge band)
}

export type AitSlabLine = { slab: string; rate: number; amount: number; tax: number }

export type AitCalculation = {
  fiscalYearId: string
  fiscalYearLabel: string
  incomeYear: string
  assessmentYear: string
  // step 1
  monthlyGross: number
  festivalBonusMonths: number
  festivalBonusAmount: number
  festivalBonusBasis?: string
  annualGross: number
  annualGrossIsOverride: boolean
  // step 2
  exemption: number
  taxableIncome: number
  // step 3
  categoryKey: string
  categoryLabel: string
  categoryAssumed: boolean
  threshold: number
  incomeAboveThreshold: number
  // step 4
  slabLines: AitSlabLine[]
  slabTax: number
  nonResidentFlatRateApplied: boolean
  // step 5
  rebateEligibleBase: number   // §78(b) base: declared investment
  rebateLimbs: { income: number; investment: number; absolute: number }
  rebateAmount: number
  rebateApplied: boolean
  annualTax: number // net of rebate — the §86 withholding basis
  // step 6
  minimumTax: number
  minimumTaxEffective: number // max(annualTax, floor) when the floor binds
  minimumTaxWarning: boolean
  // step 7
  surcharge: {
    applicable: boolean
    percent: number
    amount: number
    netWorth: number | null
    band: string
    triggers: string[]
  } | null
  annualLiability: number // annualTax + surcharge — the return-filing view
  // step 8
  averageRatePercent: number
  monthlyTds: number // §86(1): current-month gross × average rate
  monthlyTdsCatchUp: number | null // §86(1)+(4): (annualTax − tdsYtd) ÷ months remaining
  currentMonthGross: number
  tdsYtd: number
  remainingEstimate: number
  // meta
  warnings: { code: string; message: string; bn?: string }[]
  ageAtFyStart?: number | null
  seniorAutoApplied?: boolean
}

// ---------- helpers ----------

export const MESSAGES = {
  noConfig: {
    en: "No active fiscal-year tax configuration — ask an administrator to activate one in AIT → Fiscal Year Config.",
    bn: "সক্রিয় অর্থবছরের কর কনফিগারেশন নেই — অনুগ্রহ করে প্রশাসকের সাথে যোগাযোগ করুন।",
  },
  disclaimer: {
    en: "Estimate under Section 86, Income Tax Act 2023 (average-rate method with the sub-section (4) cumulative adjustment). Final liability is determined by the NBR return under Section 166 — the minimum-tax floor and surcharge are shown as separate annual items, not added to monthly withholding.",
    bn: "এই হিসাবটি আয়কর আইন ২০২৩-এর ধারা ৮৬ অনুযায়ী মাসিক উৎসে কর কর্তনের (AIT/TDS) একটি প্রাক্কলন। চূড়ান্ত দায় ধারা ১৬৬-এর অধীনে NBR রিটার্নে নির্ধারিত হবে — ন্যূনতম কর ও সারচার্জ বার্ষিক হিসাব হিসেবে আলাদাভাবে দেখানো হয়, মাসিক কর্তনে যোগ করা হয় না।",
  },
}

/** Age (whole years) at a reference date; null when DOB missing/invalid. */
export function ageAt(dob: string | null | undefined, ref: Date): number | null {
  if (!dob) return null
  const d = new Date(dob + "T00:00:00")
  if (isNaN(d.getTime())) return null
  let age = ref.getFullYear() - d.getFullYear()
  const beforeBirthday =
    ref.getMonth() < d.getMonth() || (ref.getMonth() === d.getMonth() && ref.getDate() < d.getDate())
  if (beforeBirthday) age--
  return age < 0 ? 0 : age
}

/** The fiscal-year start date (1 July of the income year "2025-26" → 2025-07-01). */
export function fyStartDate(incomeYear: string): Date {
  const start = Number(String(incomeYear).slice(0, 4))
  return Number.isFinite(start) ? new Date(start, 6, 1) : new Date()
}

const r0 = (n: number) => Math.round(Number.isFinite(n) ? n : 0)

// ---------- default surcharge table (identical for IY 2025-26 and 2026-27) ----------
// FO 2025 §4 / FA 2026: on the tax amount —
//   over ৳4 crore…10 crore → 10% | 10–20 crore → 20% | 20–50 crore → 30% |
//   over ৳50 crore → 35%
// Triggers for the 10% band regardless of wealth: owner of MORE THAN ONE
// motor car, or a city-corporation house property over 8,000 sft.
export const DEFAULT_SURCHARGE = {
  bands: [
    { netWorthOver: 40_000_000, netWorthUpTo: 100_000_000, percent: 10 },
    { netWorthOver: 100_000_000, netWorthUpTo: 200_000_000, percent: 20 },
    { netWorthOver: 200_000_000, netWorthUpTo: 500_000_000, percent: 30 },
    { netWorthOver: 500_000_000, netWorthUpTo: null, percent: 35 },
  ] as SurchargeBand[],
  motorVehicleTrigger: 2, // more than 1 car
  houseSftTrigger: 8000,
}

// ---------- core (pure — unit-testable, no DB) ----------

export function calculateAit(config: AitConfig, input: AitInput): AitCalculation {
  const warnings: AitCalculation["warnings"] = []

  // ---- category resolution (senior auto-detection from DOB) ----
  const age = ageAt(input.dateOfBirth, fyStartDate(config.incomeYear))
  let categoryKey = (input.taxpayerCategory || "").toLowerCase().trim()
  let categoryAssumed = false
  let seniorAutoApplied = false

  const cat = (k: string) => config.categories.find((c) => c.key === k)
  const general = cat("general") || { key: "general", label: "General", threshold: 0 }
  let resolved = cat(categoryKey) || null

  if (!categoryKey) {
    // no explicit choice — seniors are auto-detected from DOB, women from
    // the gender field (both with a verify warning, never silently)
    const seniorCat = age != null && age >= 65 ? cat("senior") : undefined
    const femaleCat = /female|^f$/i.test(String(input.gender || "")) ? cat("female") : undefined
    if (seniorCat) {
      resolved = seniorCat
      categoryKey = "senior"
      seniorAutoApplied = true
      warnings.push({
        code: "SENIOR_AUTO",
        message: `Employee is ${age} (born ${input.dateOfBirth}) — the senior-citizen (≥65) threshold was applied automatically. Verify the date of birth and confirm the category.`,
        bn: `কর্মীর বয়স ${age} — সিনিয়র নাগরিক (৬৫+) প্রাপ্ত থ্রেশহোল্ড স্বয়ংক্রিয়ভাবে প্রয়োগ হয়েছে। জন্মতারিখ যাচাই করুন।`,
      })
    } else if (femaleCat) {
      resolved = femaleCat
      categoryKey = "female"
      categoryAssumed = true
      warnings.push({
        code: "FEMALE_AUTO",
        message: `Employee record says "${input.gender}" — the female-taxpayer threshold was applied automatically. Verify and confirm the category.`,
        bn: `কর্মীর লিঙ্গ "${input.gender}" — মহিলা করদাতার থ্রেশহোল্ড স্বয়ংক্রিয়ভাবে প্রয়োগ হয়েছে। শ্রেণি নিশ্চিত করুন।`,
      })
    } else {
      resolved = general
      categoryKey = general.key
      categoryAssumed = true
      warnings.push({
        code: "CATEGORY_ASSUMED",
        message: "No taxpayer category on record — the general threshold was assumed. Verify the employee's category.",
        bn: "করদাতার ধরন নির্ধারিত নেই — সাধারণ থ্রেশহোল্ড ধরা হয়েছে। যাচাই করুন।",
      })
    }
  } else if (categoryKey !== "senior" && age != null && age >= 65) {
    // explicit non-senior category, but the DOB says ≥65 — protect the elderly
    // person: apply the senior threshold AND flag for verification.
    const seniorCat = cat("senior")
    if (seniorCat) {
      resolved = seniorCat
      seniorAutoApplied = true
      warnings.push({
        code: "SENIOR_AUTO",
        message: `Employee is ${age} (born ${input.dateOfBirth}) but is categorised as "${categoryKey}" — the senior-citizen (≥65) threshold was applied for this calculation. Update or confirm the employee's category.`,
        bn: `কর্মীর বয়স ${age}, কিন্তু ধরন "${categoryKey}" নির্ধারিত — সিনিয়র নাগরিক (৬৫+) থ্রেশহোল্ড প্রয়োগ করা হয়েছে। ধরন হালনাগাদ করুন।`,
      })
      categoryKey = "senior"
    }
  } else if (!resolved) {
    resolved = general
    categoryAssumed = true
    categoryKey = general.key
    warnings.push({
      code: "CATEGORY_UNKNOWN",
      message: `Category "${input.taxpayerCategory}" is not configured for this fiscal year — the general threshold was used. Add it in Fiscal Year Config → Categories.`,
      bn: `ধরন "${input.taxpayerCategory}" এই অর্থবছরে কনফিগার করা নেই — সাধারণ থ্রেশহোল্ড ব্যবহার হয়েছে।`,
    })
  }
  // final guard — the senior-key fast path above can leave a configured key
  // unresolved in the type system's view; general is always defined
  if (!resolved) resolved = general
  if (age == null && !input.dateOfBirth) {
    warnings.push({
      code: "DOB_MISSING",
      message: "Date of birth is missing — senior-citizen (≥65) entitlement cannot be verified.",
      bn: "জন্মতারিখ নেই — সিনিয়র নাগরিক (৬৫+) সুবিধা যাচাই করা যাচ্ছে না।",
    })
  }

  const isNonResident = resolved.key === "non_resident"

  // ---- step 1: annual gross (projection or override) ----
  const monthlyGross = Math.max(0, Number(input.monthlyGrossSalary) || 0)
  const monthlyBasic = Math.max(0, Number(input.monthlyBasicSalary) || 0)

  const bonusBasis = String(input.festivalBonusBasis || "BASIC").toUpperCase()
  let bonusCount = 0
  let bonusAmount = 0

  if (bonusBasis === "FIXED" || (input.festivalBonusAmount != null && Number.isFinite(input.festivalBonusAmount))) {
    bonusAmount = r0(Math.max(0, Number(input.festivalBonusAmount ?? input.festivalBonusOverride) || 0))
    bonusCount = monthlyBasic > 0 ? Number((bonusAmount / monthlyBasic).toFixed(2)) : 1
  } else if (bonusBasis === "GROSS") {
    bonusCount = input.festivalBonusMultiplier != null && Number.isFinite(input.festivalBonusMultiplier) && input.festivalBonusMultiplier >= 0
      ? input.festivalBonusMultiplier
      : (input.festivalBonusOverride != null && Number.isFinite(input.festivalBonusOverride) && input.festivalBonusOverride >= 0
          ? input.festivalBonusOverride
          : config.festivalBonusCount)
    bonusAmount = r0(monthlyGross * bonusCount)
  } else {
    // BASIC (default)
    bonusCount = input.festivalBonusMultiplier != null && Number.isFinite(input.festivalBonusMultiplier) && input.festivalBonusMultiplier >= 0
      ? input.festivalBonusMultiplier
      : (input.festivalBonusOverride != null && Number.isFinite(input.festivalBonusOverride) && input.festivalBonusOverride >= 0
          ? input.festivalBonusOverride
          : config.festivalBonusCount)
    bonusAmount = r0(monthlyBasic * bonusCount)
  }

  let annualGross = r0(monthlyGross * 12 + bonusAmount)
  const annualGrossIsOverride = input.annualGrossOverride != null && Number.isFinite(input.annualGrossOverride) && input.annualGrossOverride > 0
  if (annualGrossIsOverride) {
    annualGross = r0(input.annualGrossOverride as number)
    if (annualGross < monthlyGross * 12) {
      warnings.push({
        code: "OVERRIDE_LOWER",
        message: `The override (৳${annualGross.toLocaleString("en-IN")}) is LOWER than the projection from salary (৳${(monthlyGross * 12).toLocaleString("en-IN")}) — confirm this is intentional.`,
        bn: "ওভাররাইড প্রক্ষেপণের চেয়ে কম — ইচ্ছাকৃত কিনা নিশ্চিত করুন।",
      })
    }
  }

  // ---- step 2: Third-Schedule salary exemption (item 27) ----
  // "One-third of the income computed as income from employment or [cap],
  //  whichever is less" — NOT applicable to non-residents (flat 30% regime).
  const exemption = isNonResident ? 0 : r0(Math.min(annualGross * config.exemptionFraction, config.exemptionCap))
  const taxableIncome = r0(Math.max(0, annualGross - exemption))

  // ---- step 3: threshold ----
  const threshold = isNonResident ? 0 : resolved.threshold
  const incomeAboveThreshold = r0(Math.max(0, taxableIncome - threshold))

  // ---- step 4: slab loop (any number of ordered slabs) ----
  const slabLines: AitSlabLine[] = []
  let slabTax = 0
  let nonResidentFlatRateApplied = false
  if (isNonResident) {
    // Non-resident (non-Bangladeshi) individuals: flat 30% on total income —
    // no threshold, no Third-Schedule exemption, no §78 rebate (ITA 2023
    // resident-only rebate; FO 2025 §2 "Non-residents other than Bangladeshi
    // non-residents shall pay tax on the total income at flat rate of 30%").
    nonResidentFlatRateApplied = true
    slabTax = r0(annualGross * 0.3)
    slabLines.push({ slab: "Non-resident flat rate", rate: 30, amount: annualGross, tax: slabTax })
    warnings.push({
      code: "NON_RESIDENT_FLAT",
      message: "Non-resident (non-Bangladeshi) taxpayer — tax computed at the flat 30% maximum rate on total income (no threshold, no salary exemption, no investment rebate).",
      bn: "অনিবাসী (অ-বাংলাদেশি) করদাতা — মোট আয়ের উপর ৩০% সর্বোচ্চ হারে কর ধার্য (কোনো থ্রেশহোল্ড, বেতন ছাড় বা বিনিয়োগ রেয়াত প্রযোজ্য নয়)।",
    })
  } else {
    let remaining = incomeAboveThreshold
    if (incomeAboveThreshold > 0) {
      for (const s of [...config.slabs].sort((a, b) => a.order - b.order)) {
        if (remaining <= 0) break
        const applicable = Math.min(remaining, s.upperLimit ?? remaining)
        const tax = r0((applicable * s.ratePercent) / 100)
        slabLines.push({ slab: s.slabLabel || `Slab ${s.order}`, rate: s.ratePercent, amount: r0(applicable), tax })
        slabTax += tax
        remaining = r0(remaining - applicable)
      }
      // R5-007 — income above the last slab must be taxed at the last slab's rate,
      // not silently dropped. This fires only when every slab has a finite upperLimit
      // and the sum of limits is less than incomeAboveThreshold.
      if (remaining > 0 && config.slabs.length > 0) {
        const lastSlab = [...config.slabs].sort((a, b) => a.order - b.order).at(-1)!
        const tax = r0((remaining * lastSlab.ratePercent) / 100)
        slabLines.push({ slab: `${lastSlab.slabLabel || "Last slab"} (overflow)`, rate: lastSlab.ratePercent, amount: r0(remaining), tax })
        slabTax += tax
        remaining = 0
        warnings.push({ code: "SLAB_OVERFLOW", message: `Income ৳${r0(remaining)} exceeds all configured slab ceilings — taxed at the last slab rate (${lastSlab.ratePercent}%).` })
      }
    }
  }

  // ---- step 5: investment rebate (§78 — lower of the three limbs) ----
  const declared = Math.max(0, Number(input.declaredInvestment) || 0)
  const rebateApplied = !isNonResident && declared > 0
  // limb (a): rebateIncomeCapPercent% of taxable income [the §78 "A" base —
  // for a salary-only assessee this is the post-exemption taxable income]
  const limbIncome = r0((taxableIncome * (config.rebateIncomeCapPercent || 3)) / 100)
  // limb (b): rebateRatePercent% of the declared eligible investment
  const limbInvestment = r0((declared * (config.rebateRatePercent ?? 15)) / 100)
  // limb (c): absolute cap
  const limbAbsolute = r0(config.rebateCapAmount || 0)
  const rebateAmount = rebateApplied ? Math.max(0, Math.min(limbIncome, limbInvestment, limbAbsolute)) : 0
  const annualTax = rebateApplied ? r0(Math.max(0, slabTax - rebateAmount)) : slabTax
  if (!rebateApplied && !isNonResident) {
    warnings.push({
      code: "REBATE_NOT_APPLIED",
      message: "No declared investment on record — the Section 78 rebate was NOT applied. Submit a declaration (with evidence) to claim it.",
      bn: "ঘোষিত বিনিয়োগ নেই — ধারা ৭৮ রেবেট প্রয়োগ হয়নি। দাবি করতে ঘোষণা জমা দিন।",
    })
  }

  // ---- step 6: minimum tax — annual floor, WARNING ONLY for TDS ----
  // The individual floor (৳5,000 / ৳1,000 first-time filers) comes from the
  // annual Finance Act under the §163 framework. It binds where taxable
  // income exceeds the threshold and even the post-rebate tax falls below it.
  const minimumTax = r0(config.minimumTax || 0)
  const minimumTaxEffective = Math.max(annualTax, minimumTax)
  // the floor binds where taxable income exceeds the threshold — even when
  // the computed tax rounds to zero (e.g. ৳1 into the first slab)
  const minimumTaxWarning = !isNonResident && taxableIncome > threshold && annualTax < minimumTax
  if (minimumTaxWarning) {
    warnings.push({
      code: "MIN_TAX",
      message: `Annual tax after rebate (৳${annualTax.toLocaleString("en-IN")}) is below the individual minimum-tax floor of ৳${minimumTax.toLocaleString("en-IN")} (annual Finance Act; §163 framework). The floor is a return-filing liability — it is NOT added to monthly TDS here; reconcile it at year end.`,
      bn: `রেয়াত-পরবর্তী বার্ষিক কর (৳${annualTax.toLocaleString("en-IN")}) ব্যক্তিগত ন্যূনতম কর ৳${minimumTax.toLocaleString("en-IN")}-এর নিচে (বার্ষিক অর্থ আইন; ধারা ১৬৩ কাঠামো)। এটি রিটার্ন-পর্যায়ের দায় — মাসিক TDS-এ যোগ করা হয়নি; বছর শেষে সমন্বয় করুন।`,
    })
  }
  if (config.newTaxpayerMinimumTax != null && config.newTaxpayerMinimumTax > 0) {
    warnings.push({
      code: "MIN_TAX_NEW_FILER",
      message: `First-time return filers are subject to a reduced ৳${r0(config.newTaxpayerMinimumTax).toLocaleString("en-IN")} minimum-tax floor for this income year — confirm the employee's filer history before year-end reconciliation.`,
      bn: `প্রথমবার রিটার্নদাতাদের জন্য এই আয়বছরে ন্যূনতম কর ৳${r0(config.newTaxpayerMinimumTax).toLocaleString("en-IN")} — বছর-শেষ সমন্বয়ের আগে কর্মীর রিটার্ন ইতিহাস নিশ্চিত করুন।`,
    })
  }

  // ---- step 7: surcharge (annual computation only) ----
  const sc = config.surcharge || DEFAULT_SURCHARGE
  const surcharge: AitCalculation["surcharge"] = { applicable: false, percent: 0, amount: 0, netWorth: null, band: "", triggers: [] }
  const netWealth = input.netWealth != null && Number.isFinite(input.netWealth) && input.netWealth >= 0 ? input.netWealth : null
  const motorVehicles = input.motorVehicles != null && Number.isFinite(input.motorVehicles) ? Math.max(0, Math.trunc(input.motorVehicles)) : null
  if (netWealth == null) {
    warnings.push({
      code: "SURCHARGE_NOT_ASSESSED",
      message: "Declared net wealth is not on record — the net-wealth surcharge (10%–35% bands, motor-vehicle and house-property triggers) could not be assessed. The final liability may be incomplete.",
      bn: "ঘোষিত নিট সম্পদ নেই — সারচার্জ (১০%–৩৫% স্তর, মোটরযান ও বাড়ির শর্ত) যাচাই করা যায়নি। চূড়ান্ত দায় অসম্পূর্ণ হতে পারে।",
    })
  } else {
    surcharge.netWorth = netWealth
    const band = sc.bands.find((b) => netWealth > b.netWorthOver && (b.netWorthUpTo == null || netWealth <= b.netWorthUpTo))
    if (band) {
      surcharge.applicable = true
      surcharge.percent = band.percent
      surcharge.band = `Net worth ৳${netWealth.toLocaleString("en-IN")} — ${band.percent}% band`
    }
    if (motorVehicles != null && motorVehicles >= (sc.motorVehicleTrigger || 2)) {
      // the multiple-motor-car trigger pulls the taxpayer into the 10% band
      // even below ৳4 crore net worth (FO 2025 / FA 2026)
      if (!surcharge.applicable || surcharge.percent < 10) {
        surcharge.applicable = true
        surcharge.percent = Math.max(surcharge.percent, 10)
      }
      surcharge.triggers.push(`Owns ${motorVehicles} motor cars (more than one) — 10% surcharge band trigger`)
    }
    if (surcharge.applicable) {
      surcharge.amount = r0((Math.max(annualTax, minimumTaxEffective) * surcharge.percent) / 100)
      warnings.push({
        code: "SURCHARGE_APPLICABLE",
        message: `Surcharge of ${surcharge.percent}% applies to the tax amount (৳${surcharge.amount.toLocaleString("en-IN")}) — ${[surcharge.band, ...surcharge.triggers].join("; ")}. This is an annual/return liability and is NOT added to monthly TDS.`,
        bn: `করের উপর ${surcharge.percent}% সারচার্জ প্রযোজ্য (৳${surcharge.amount.toLocaleString("en-IN")})। এটি বার্ষিক দায় — মাসিক TDS-এ যোগ করা হয় না।`,
      })
    }
  }
  const annualLiability = r0(annualTax + surcharge.amount)

  // ---- step 8: §86 average rate, monthly TDS and the (4) catch-up ----
  const averageRatePercent = annualGross > 0 ? (annualTax / annualGross) * 100 : 0
  const currentMonthGross = Math.max(0, Number(input.currentMonthGross ?? monthlyGross) || 0)
  const monthlyTds = r0((currentMonthGross * averageRatePercent) / 100)
  const tdsYtd = Math.max(0, Number(input.tdsYtd) || 0)
  const monthsRemaining = input.monthsRemainingInFy != null && Number.isFinite(input.monthsRemainingInFy) && input.monthsRemainingInFy >= 1
    ? Math.trunc(input.monthsRemainingInFy) : null
  // §86(1) + §86(4): deduct at the average rate and adjust with any previous
  // surplus or deficit — the catch-up form: remaining liability spread over
  // the months left in the income year (reduces to annualTax ÷ 12 in steady
  // state, self-corrects after revisions, arrears, corrections and joins).
  const monthlyTdsCatchUp = monthsRemaining != null
    ? Math.max(0, r0((annualTax - tdsYtd) / monthsRemaining))
    : null
  if (monthsRemaining != null && monthlyTdsCatchUp != null && tdsYtd > 0) {
    const idealCumulative = r0((annualTax * (12 - monthsRemaining)) / 12)
    if (Math.abs(tdsYtd - idealCumulative) > Math.max(50, annualTax * 0.005)) {
      warnings.push({
        code: "TDS_CUMULATIVE_ADJUSTMENT",
        message: `TDS deducted to date (৳${tdsYtd.toLocaleString("en-IN")}) differs from the pro-rata cumulative liability (৳${idealCumulative.toLocaleString("en-IN")}) — the §86(4) surplus/deficit adjustment is reflected in this month's catch-up deduction (৳${monthlyTdsCatchUp.toLocaleString("en-IN")}).`,
        bn: `আজ পর্যন্ত কর্তিত TDS (৳${tdsYtd.toLocaleString("en-IN")}) আনুপাতিক দায়ের (৳${idealCumulative.toLocaleString("en-IN")}) থেকে ভিন্ন — ধারা ৮৬(৪) সমন্বয় এ মাসের কর্তনে (৳${monthlyTdsCatchUp.toLocaleString("en-IN")}) প্রতিফলিত।`,
      })
    }
  }
  const remainingEstimate = r0(Math.max(0, annualTax - tdsYtd))

  return {
    fiscalYearId: config.fiscalYearId,
    fiscalYearLabel: config.label,
    incomeYear: config.incomeYear,
    assessmentYear: config.assessmentYear,
    monthlyGross, festivalBonusMonths: bonusCount, festivalBonusAmount: bonusAmount, festivalBonusBasis: bonusBasis,
    annualGross, annualGrossIsOverride,
    exemption, taxableIncome,
    categoryKey, categoryLabel: resolved.label, categoryAssumed, threshold, incomeAboveThreshold,
    slabLines, slabTax, nonResidentFlatRateApplied,
    rebateEligibleBase: declared, rebateLimbs: { income: limbIncome, investment: limbInvestment, absolute: limbAbsolute },
    rebateAmount, rebateApplied, annualTax,
    minimumTax, minimumTaxEffective, minimumTaxWarning,
    surcharge, annualLiability,
    averageRatePercent, monthlyTds, monthlyTdsCatchUp, currentMonthGross, tdsYtd, remainingEstimate,
    warnings, ageAtFyStart: age, seniorAutoApplied,
  }
}

// ---------- versioned bootstrap presets (all admin-editable afterwards) ----------
// The engine never re-reads these after creation; they are the legally
// verified starting numbers for each income year.

/** Income year 2025-26 (assessment year 2026-27) — Finance Ordinance 2025. */
export function defaultFy2026Config(vendorId: string) {
  return {
    vendorId,
    label: "FY 2025-26",
    incomeYear: "2025-26",
    assessmentYear: "2026-27",
    tdsSectionRef: "Section 86, Income Tax Act 2023",
    exemptionFraction: 1 / 3,
    exemptionCap: 500000,
    minimumTax: 5000,
    newTaxpayerMinimumTax: 1000,
    rebateRatePercent: 15,
    rebateIncomeCapPercent: 3,
    rebateCapAmount: 1000000,
    rebateCapFraction: 0.25, // legacy — unused
    festivalBonusCount: 2,
    active: false,
    notes: "Finance Ordinance 2025 (enacted) — verified against the NBR consolidated ITA 2023 (June 2025), KPMG FO 2025 salient features and PwC. Thresholds: general 3,75,000 · women/senior 4,25,000 · third-gender/disabled 5,00,000 · FF & July Warriors 5,25,000. Rebate §78: lower of 3% of taxable income, 15% of eligible investment or ৳10,00,000.",
    categories: [
      { key: "general", label: "General (৳3,75,000)", threshold: 375000, sortOrder: 1 },
      { key: "female", label: "Female taxpayer (৳4,25,000)", threshold: 425000, sortOrder: 2 },
      { key: "senior", label: "Senior citizen ≥65 (৳4,25,000)", threshold: 425000, sortOrder: 3 },
      { key: "third_gender", label: "Third gender (৳5,00,000)", threshold: 500000, sortOrder: 4 },
      { key: "disabled", label: "Physically challenged (৳5,00,000)", threshold: 500000, sortOrder: 5 },
      { key: "freedom_fighter", label: "Gazetted war-wounded freedom fighter (৳5,25,000)", threshold: 525000, sortOrder: 6 },
      { key: "july_warrior", label: "Gazetted July Warrior (৳5,25,000)", threshold: 525000, sortOrder: 7 },
      { key: "non_resident", label: "Non-resident (flat 30%)", threshold: 0, sortOrder: 8 },
    ],
    slabs: [
      { order: 1, slabLabel: "Next ৳3,00,000", upperLimit: 300000, ratePercent: 10 },
      { order: 2, slabLabel: "Next ৳4,00,000", upperLimit: 400000, ratePercent: 15 },
      { order: 3, slabLabel: "Next ৳5,00,000", upperLimit: 500000, ratePercent: 20 },
      { order: 4, slabLabel: "Next ৳20,00,000", upperLimit: 2000000, ratePercent: 25 },
      { order: 5, slabLabel: "Balance (unlimited)", upperLimit: null, ratePercent: 30 },
    ],
  }
}

/** Income year 2026-27 (assessment year 2027-28) — Finance Act 2026. */
export function defaultFy2027Config(vendorId: string) {
  return {
    vendorId,
    label: "FY 2026-27",
    incomeYear: "2026-27",
    assessmentYear: "2027-28",
    tdsSectionRef: "Section 86, Income Tax Act 2023",
    exemptionFraction: 1 / 3,
    exemptionCap: 500000,
    minimumTax: 5000,
    newTaxpayerMinimumTax: 1000,
    rebateRatePercent: 10,
    rebateIncomeCapPercent: 3,
    rebateCapAmount: 750000,
    rebateCapFraction: 0.25, // legacy — unused
    festivalBonusCount: 2,
    active: false,
    notes: "Finance Act 2026 — verified against the PwC FY 2026/27 individual rates table and current practitioner guidance. Thresholds: general 4,00,000 · women/senior 4,50,000 · third-gender/disabled 5,25,000 · FF & July Warriors 5,50,000. Rebate §78 (as amended): lower of 3% of taxable income, 10% of eligible investment or ৳7,50,000.",
    categories: [
      { key: "general", label: "General (৳4,00,000)", threshold: 400000, sortOrder: 1 },
      { key: "female", label: "Female taxpayer (৳4,50,000)", threshold: 450000, sortOrder: 2 },
      { key: "senior", label: "Senior citizen ≥65 (৳4,50,000)", threshold: 450000, sortOrder: 3 },
      { key: "third_gender", label: "Third gender (৳5,25,000)", threshold: 525000, sortOrder: 4 },
      { key: "disabled", label: "Physically challenged (৳5,25,000)", threshold: 525000, sortOrder: 5 },
      { key: "freedom_fighter", label: "Gazetted war-wounded freedom fighter (৳5,50,000)", threshold: 550000, sortOrder: 6 },
      { key: "july_warrior", label: "Gazetted July Warrior (৳5,50,000)", threshold: 550000, sortOrder: 7 },
      { key: "non_resident", label: "Non-resident (flat 30%)", threshold: 0, sortOrder: 8 },
    ],
    slabs: [
      { order: 1, slabLabel: "Next ৳3,00,000", upperLimit: 300000, ratePercent: 10 },
      { order: 2, slabLabel: "Next ৳4,00,000", upperLimit: 400000, ratePercent: 15 },
      { order: 3, slabLabel: "Next ৳5,00,000", upperLimit: 500000, ratePercent: 20 },
      { order: 4, slabLabel: "Next ৳20,00,000", upperLimit: 2000000, ratePercent: 25 },
      { order: 5, slabLabel: "Balance (unlimited)", upperLimit: null, ratePercent: 30 },
    ],
  }
}

/** The income year whose July–June window contains `today` ("2026-27" for Oct 2026). */
export function currentIncomeYear(today = new Date()): string {
  const y = today.getFullYear()
  const fyStartYear = today.getMonth() + 1 >= 7 ? y : y - 1
  return `${fyStartYear}-${String((fyStartYear + 1) % 100).padStart(2, "0")}`
}

/** Insert the bootstrap configs when the vendor has NONE at all (idempotent).
 *  Creates both verified year presets and activates the one containing today. */
export async function ensureAitConfig(vendorId: string): Promise<string> {
  const any = await db.aitFiscalYear.findFirst({ where: { vendorId } })
  if (any) return any.id
  const today = new Date()
  const activeYear = currentIncomeYear(today)
  const presets = [defaultFy2026Config(vendorId), defaultFy2027Config(vendorId)]
  let activeId = ""
  for (const def of presets) {
    const fy = await db.aitFiscalYear.create({
      data: {
        vendorId, label: def.label, incomeYear: def.incomeYear, assessmentYear: def.assessmentYear,
        tdsSectionRef: def.tdsSectionRef, exemptionFraction: def.exemptionFraction, exemptionCap: def.exemptionCap,
        minimumTax: def.minimumTax, newTaxpayerMinimumTax: def.newTaxpayerMinimumTax,
        rebateRatePercent: def.rebateRatePercent, rebateIncomeCapPercent: def.rebateIncomeCapPercent,
        rebateCapFraction: def.rebateCapFraction, rebateCapAmount: def.rebateCapAmount,
        festivalBonusCount: def.festivalBonusCount,
        active: def.incomeYear === activeYear, notes: def.notes,
      },
    })
    if (def.incomeYear === activeYear) activeId = fy.id
    await db.aitTaxpayerCategory.createMany({ data: def.categories.map((c) => ({ ...c, vendorId, fiscalYearId: fy.id })) })
    await db.aitTaxSlab.createMany({ data: def.slabs.map((s) => ({ ...s, vendorId, fiscalYearId: fy.id })) })
  }
  // fall back to the newest year when today predates both presets
  if (!activeId) {
    const fy = await db.aitFiscalYear.findFirst({ where: { vendorId }, orderBy: { incomeYear: "desc" } })
    if (fy) {
      await db.aitFiscalYear.update({ where: { id: fy.id }, data: { active: true } })
      activeId = fy.id
    }
  }
  return activeId
}

function parseSurcharge(json: string | null | undefined): AitConfig["surcharge"] {
  if (!json) return DEFAULT_SURCHARGE
  try {
    const p = JSON.parse(json)
    if (Array.isArray(p?.bands) && p.bands.length) {
      return {
        bands: p.bands.map((b: any) => ({ netWorthOver: Number(b.netWorthOver) || 0, netWorthUpTo: b.netWorthUpTo == null ? null : Number(b.netWorthUpTo), percent: Number(b.percent) || 0 })),
        motorVehicleTrigger: Number(p.motorVehicleTrigger) || 2,
        houseSftTrigger: Number(p.houseSftTrigger) || 8000,
      }
    }
  } catch { /* fall back to defaults */ }
  return DEFAULT_SURCHARGE
}

/** Load one fiscal-year config (categories + slabs + surcharge). Returns null when none. */
export async function loadAitConfig(vendorId: string, fiscalYearId?: string | null): Promise<AitConfig | null> {
  const fy = fiscalYearId
    ? await db.aitFiscalYear.findFirst({ where: { id: fiscalYearId, vendorId } })
    : await db.aitFiscalYear.findFirst({ where: { vendorId, active: true }, orderBy: { createdAt: "desc" } })
  if (!fy) return null
  const [cats, slabs] = await Promise.all([
    db.aitTaxpayerCategory.findMany({ where: { fiscalYearId: fy.id }, orderBy: { sortOrder: "asc" } }),
    db.aitTaxSlab.findMany({ where: { fiscalYearId: fy.id }, orderBy: { order: "asc" } }),
  ])
  return {
    fiscalYearId: fy.id, label: fy.label, incomeYear: fy.incomeYear, assessmentYear: fy.assessmentYear,
    tdsSectionRef: fy.tdsSectionRef, exemptionFraction: fy.exemptionFraction, exemptionCap: fy.exemptionCap,
    minimumTax: fy.minimumTax, newTaxpayerMinimumTax: fy.newTaxpayerMinimumTax ?? null,
    rebateRatePercent: fy.rebateRatePercent, rebateIncomeCapPercent: fy.rebateIncomeCapPercent ?? 3,
    rebateCapFraction: fy.rebateCapFraction ?? 0.25, rebateCapAmount: fy.rebateCapAmount,
    festivalBonusCount: fy.festivalBonusCount,
    categories: cats.map((c) => ({ key: c.key, label: c.label, threshold: c.threshold })),
    slabs: slabs.map((s) => ({ order: s.order, slabLabel: s.slabLabel, upperLimit: s.upperLimit, ratePercent: s.ratePercent })),
    surcharge: parseSurcharge(fy.surchargeJson),
  }
}

/** Snapshot the config for the audit journal (what numbers were used at calc time). */
export function configSnapshot(cfg: AitConfig) {
  return {
    fiscalYearId: cfg.fiscalYearId, label: cfg.label, incomeYear: cfg.incomeYear, assessmentYear: cfg.assessmentYear,
    tdsSectionRef: cfg.tdsSectionRef, exemptionFraction: cfg.exemptionFraction, exemptionCap: cfg.exemptionCap,
    minimumTax: cfg.minimumTax, newTaxpayerMinimumTax: cfg.newTaxpayerMinimumTax,
    rebateRatePercent: cfg.rebateRatePercent, rebateIncomeCapPercent: cfg.rebateIncomeCapPercent,
    rebateCapFraction: cfg.rebateCapFraction, rebateCapAmount: cfg.rebateCapAmount,
    festivalBonusCount: cfg.festivalBonusCount,
    categories: cfg.categories, slabs: cfg.slabs, surcharge: cfg.surcharge,
  }
}

/** Persist an audit-log row (best-effort — never blocks the calculation). */
export async function journalAitCalculation(opts: {
  vendorId: string
  config: AitConfig
  input: unknown
  result: { warnings?: unknown } & Record<string, unknown>
  kind: "PREVIEW" | "SAVE" | "BATCH" | "PAYROLL" | "RECONCILIATION"
  employee?: { id: string; code?: string; name?: string } | null
  operator?: { id?: string; name?: string } | null
  runId?: string | null
}) {
  try {
    await db.aitCalculationLog.create({
      data: {
        vendorId: opts.vendorId,
        fiscalYearId: opts.config.fiscalYearId,
        employeeId: opts.employee?.id || null,
        employeeCode: opts.employee?.code || null,
        employeeName: opts.employee?.name || null,
        kind: opts.kind,
        inputsJson: JSON.stringify(opts.input),
        configJson: JSON.stringify(configSnapshot(opts.config)),
        outputJson: JSON.stringify(opts.result),
        warningsJson: JSON.stringify(opts.result.warnings),
        runId: opts.runId || null,
        operatorId: opts.operator?.id || null,
        operatorName: opts.operator?.name || null,
      },
    })
  } catch { /* journaling must never break a calculation */ }
}

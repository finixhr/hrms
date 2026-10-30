/// <reference types="bun-types" />
// ============ AIT FY 2025-26 fixture tests (H-9 step 5 / M-11; r8 corrected) ============
// The audit required AIT unit tests to be parameterized by fiscal year with
// a fixture that loads the ACTUAL AitTaxSlab / AitTaxpayerCategory rows of
// the seeded FY 2025-26 configuration. r8 legal audit (2026-10-14): the
// numbers are the ENACTED Finance Ordinance 2025 figures for income year
// 2025-26 (assessment year 2026-27), verified against the NBR consolidated
// ITA 2023 (June 2025), KPMG "Salient Features of Finance Ordinance 2025"
// and PwC:
//   thresholds — general ৳3,75,000 · women/senior ৳4,25,000 ·
//   third-gender/disabled ৳5,00,000 · FF & July Warriors ৳5,25,000 ·
//   bands 10–30% (widths 300k/400k/500k/2,000k/unlimited above threshold)
//   §78 rebate — lower of 3% of taxable income / 15% of eligible
//   investment / ৳10,00,000. Minimum tax ৳5,000 (৳1,000 new filers).
//
// Engine semantics (Income Tax Act 2023, Sec 86 TDS):
//   annualGross → − Third-Schedule exemption (⅓ of gross, cap ৳5,00,000)
//   → taxableIncome → − category threshold → progressive 10/15/20/25/30%
//   → §78 rebate → minimum-tax floor test (warning only) → surcharge.
//   annualGrossOverride bypasses the 12-month projection; festival bonus
//   contributes only when monthlyBasicSalary is provided.
import "./_testdb" // first — sets DATABASE_URL before db.ts is constructed
import { describe, test, expect, beforeAll } from "bun:test"
import { db } from "@/lib/db"
import { mkVendor, uniq } from "./_fixtures"
import { defaultFy2026Config, loadAitConfig, calculateAit } from "@/hrm-server/ait-engine"

let vendorId: string
let cfg: Awaited<ReturnType<typeof loadAitConfig>>

beforeAll(async () => {
  const v = await mkVendor(`AIT FY26 ${uniq("v")}`)
  vendorId = v.id
  // seed the FY 2025-26 configuration exactly the way seed.ts does
  const def = defaultFy2026Config(vendorId)
  const fy = await db.aitFiscalYear.create({
    data: {
      vendorId, label: def.label, incomeYear: def.incomeYear, assessmentYear: def.assessmentYear,
      tdsSectionRef: def.tdsSectionRef, exemptionFraction: def.exemptionFraction, exemptionCap: def.exemptionCap,
      minimumTax: def.minimumTax, newTaxpayerMinimumTax: def.newTaxpayerMinimumTax,
      rebateRatePercent: def.rebateRatePercent, rebateIncomeCapPercent: def.rebateIncomeCapPercent,
      rebateCapFraction: def.rebateCapFraction, rebateCapAmount: def.rebateCapAmount,
      festivalBonusCount: def.festivalBonusCount, active: true, notes: def.notes,
    },
  })
  await db.aitTaxpayerCategory.createMany({ data: def.categories.map((c) => ({ ...c, vendorId, fiscalYearId: fy.id })) })
  await db.aitTaxSlab.createMany({ data: def.slabs.map((s) => ({ ...s, vendorId, fiscalYearId: fy.id })) })
  // load through the production loader — reads the actual DB rows
  cfg = await loadAitConfig(vendorId)
})

describe("FY 2025-26 seeded configuration (fixture loads actual rows)", () => {
  test("config loads with the Finance Ordinance 2025 (enacted) categories", () => {
    expect(cfg).not.toBeNull()
    const thresholds = Object.fromEntries((cfg!.categories || []).map((c) => [c.key, c.threshold]))
    expect(thresholds["general"]).toBe(375000)
    expect(thresholds["female"]).toBe(425000)
    expect(thresholds["senior"]).toBe(425000)
    expect(thresholds["third_gender"]).toBe(500000)
    expect(thresholds["disabled"]).toBe(500000)
    expect(thresholds["freedom_fighter"]).toBe(525000)
    expect(thresholds["july_warrior"]).toBe(525000)
  })

  test("income year 2025-26 maps to assessment year 2026-27 (§2(15)/(24))", () => {
    expect(cfg!.assessmentYear).toBe("2026-27")
  })

  test("slab bands are 10–30% progressive (300k/400k/500k/2M/unlimited)", () => {
    const rates = (cfg!.slabs || []).map((s) => s.ratePercent)
    expect(rates).toEqual([10, 15, 20, 25, 30])
    const tops = (cfg!.slabs || []).map((s) => s.upperLimit)
    expect(tops).toEqual([300000, 400000, 500000, 2000000, null])
  })

  test("§78 rebate limbs: 3% of taxable / 15% of investment / ৳10,00,000", () => {
    expect(cfg!.rebateIncomeCapPercent).toBe(3)
    expect(cfg!.rebateRatePercent).toBe(15)
    expect(cfg!.rebateCapAmount).toBe(1000000)
    expect(cfg!.newTaxpayerMinimumTax).toBe(1000)
  })
})

describe("calculateAit against the FY 2025-26 fixture", () => {
  test("annual gross at the general threshold pays zero tax (exemption keeps taxable income below it)", () => {
    const r = calculateAit(cfg!, { monthlyGrossSalary: 0, annualGrossOverride: 562500 })
    // exemption 187500 → taxable 375000 = threshold → zero tax
    expect(r.threshold).toBe(375000)
    expect(r.annualGross).toBe(562500)
    expect(r.exemption).toBe(Math.round(562500 / 3))
    expect(r.taxableIncome).toBe(375000)
    expect(r.slabTax).toBe(0)
    expect(r.slabLines).toHaveLength(0)
    expect(r.annualTax).toBe(0)
  })

  test("taxable income ৳1,00,000 above the general threshold is taxed entirely at 10%", () => {
    // taxable = 475000 → annualGross×⅔ = 475000 → annualGross = 712500
    const r = calculateAit(cfg!, { monthlyGrossSalary: 0, annualGrossOverride: 712500 })
    expect(r.taxableIncome).toBe(475000)
    expect(r.incomeAboveThreshold).toBe(100000)
    expect(r.slabLines).toHaveLength(1)
    expect(r.slabLines[0].rate).toBe(10)
    expect(r.slabLines[0].amount).toBe(100000)
    expect(r.slabTax).toBe(10000)
    expect(r.annualTax).toBe(10000)
  })

  test("taxable income ৳4,00,000 above the threshold spans the 10% and 15% bands", () => {
    // taxable = 775000 → annualGross = 1162500 (exemption 387500)
    const r = calculateAit(cfg!, { monthlyGrossSalary: 0, annualGrossOverride: 1162500 })
    expect(r.incomeAboveThreshold).toBe(400000)
    expect(r.slabLines).toHaveLength(2)
    expect(r.slabTax).toBe(45000) // 300k@10% + 100k@15%
    expect(r.annualTax).toBe(45000)
  })

  test("female category: ৳4,25,000 threshold honored from the seeded rows", () => {
    // exemption ⅓ of gross; taxable = threshold at annualGross = 637500
    const atThreshold = calculateAit(cfg!, { monthlyGrossSalary: 0, annualGrossOverride: 637500, taxpayerCategory: "female" })
    expect(atThreshold.threshold).toBe(425000)
    expect(atThreshold.slabTax).toBe(0)
    const above = calculateAit(cfg!, { monthlyGrossSalary: 0, annualGrossOverride: 787500, taxpayerCategory: "female" })
    expect(above.incomeAboveThreshold).toBe(100000)
    expect(above.slabTax).toBe(10000) // first 100k of the excess at 10%
  })

  test("exactly ৳32,00,000 above the threshold stops at the 25% band", () => {
    // taxable = 3.575M (annualGross 4.075M, exemption capped at 500k) → above = 3.2M
    const r = calculateAit(cfg!, { monthlyGrossSalary: 0, annualGrossOverride: 4075000 })
    expect(r.exemption).toBe(500000)
    expect(r.incomeAboveThreshold).toBe(3200000)
    expect(r.slabLines).toHaveLength(4)
    expect(r.slabTax).toBe(300000 * 0.10 + 400000 * 0.15 + 500000 * 0.20 + 2000000 * 0.25)
  })

  test("income beyond that spills into the 30% top band", () => {
    const r = calculateAit(cfg!, { monthlyGrossSalary: 0, annualGrossOverride: 4175000 })
    expect(r.incomeAboveThreshold).toBe(3300000)
    expect(r.slabLines).toHaveLength(5)
    expect(r.slabLines[4].rate).toBe(30)
    expect(r.slabTax).toBe(300000 * 0.10 + 400000 * 0.15 + 500000 * 0.20 + 2000000 * 0.25 + 100000 * 0.30)
  })

  test("sub-minimum tax is flagged AFTER rebate, never silently added (annual Finance Act floor)", () => {
    // taxable = 376000 → annualGross×⅔ = 376000 → annualGross = 564000
    const r = calculateAit(cfg!, { monthlyGrossSalary: 0, annualGrossOverride: 564000 })
    expect(r.incomeAboveThreshold).toBe(1000)
    expect(r.slabTax).toBe(100)
    expect(r.minimumTaxWarning).toBe(true)
    expect(r.annualTax).toBe(100) // NOT bumped to the minimum — warning only
    expect(r.minimumTaxEffective).toBe(5000)
    expect(r.warnings.some((w) => w.code === "MIN_TAX")).toBe(true)
  })

  test("§78 rebate: the 3%-of-taxable-income limb binds for a large investment", () => {
    // taxable = 775000 (annualGross 1162500). Limbs: 3% = 23250, 15% of 5L = 75000, cap 10L → rebate 23250
    const r = calculateAit(cfg!, { monthlyGrossSalary: 0, annualGrossOverride: 1162500, declaredInvestment: 500000 })
    expect(r.rebateApplied).toBe(true)
    expect(r.rebateLimbs.income).toBe(23250)
    expect(r.rebateLimbs.investment).toBe(75000)
    expect(r.rebateLimbs.absolute).toBe(1000000)
    expect(r.rebateAmount).toBe(23250)
    expect(r.annualTax).toBe(45000 - 23250)
  })

  test("§78 rebate: the investment limb binds for a small investment", () => {
    // taxable = 775000; limbs: 3% = 23250, 15% of 60000 = 9000 → rebate 9000
    const r = calculateAit(cfg!, { monthlyGrossSalary: 0, annualGrossOverride: 1162500, declaredInvestment: 60000 })
    expect(r.rebateAmount).toBe(9000)
    expect(r.annualTax).toBe(45000 - 9000)
  })

  test("surcharge: net worth in the ৳4–10 crore band adds 10% of the tax, never monthly TDS", () => {
    const r = calculateAit(cfg!, { monthlyGrossSalary: 0, annualGrossOverride: 1162500, currentMonthGross: 96875, netWealth: 45000000, motorVehicles: 1 })
    expect(r.surcharge).not.toBeNull()
    expect(r.surcharge!.applicable).toBe(true)
    expect(r.surcharge!.percent).toBe(10)
    expect(r.surcharge!.amount).toBe(4500) // 10% of the 45000 slab tax
    expect(r.annualLiability).toBe(49500)
    // monthly TDS = 96,875 × avg rate (45,000 ÷ 1,162,500 = 3.8710%) = 3,750 — unchanged by surcharge
    expect(r.monthlyTds).toBe(3750)
    expect(r.warnings.some((w) => w.code === "SURCHARGE_APPLICABLE")).toBe(true)
  })

  test("surcharge: more than one motor car triggers the 10% band even below ৳4 crore", () => {
    const r = calculateAit(cfg!, { monthlyGrossSalary: 0, annualGrossOverride: 1162500, netWealth: 15000000, motorVehicles: 2 })
    expect(r.surcharge!.applicable).toBe(true)
    expect(r.surcharge!.percent).toBe(10)
    expect(r.surcharge!.triggers.join(" ")).toContain("motor cars")
  })

  test("surcharge: missing net wealth emits the incomplete-result warning", () => {
    const r = calculateAit(cfg!, { monthlyGrossSalary: 0, annualGrossOverride: 1162500 })
    expect(r.surcharge!.applicable).toBe(false)
    expect(r.warnings.some((w) => w.code === "SURCHARGE_NOT_ASSESSED")).toBe(true)
  })
})

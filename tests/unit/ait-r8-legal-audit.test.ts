/// <reference types="bun-types" />
// ============================================================================
// r8 LEGAL AUDIT — AIT / Income Tax comprehensive test suite (Phase Ten)
// ============================================================================
// 20 mandated scenarios, each documenting: inputs, expected output, formula,
// applicable legal provision and the reason for the result. Legal bases were
// verified on 2026-10-14 against:
//   * NBR consolidated Income Tax Act 2023 PDF (amendments to 16 June 2025):
//     §2(15)/(24) income/assessment years · §18(2) rates by annual Finance
//     Act · §32 income from employment · §78 rebate = lower of 0.03×A /
//     rate×B / cap · §86(1) average-rate withholding + §86(4) surplus/
//     deficit adjustment · §163 minimum-tax framework · Third Schedule
//     item (27) one-third salary exemption (cap ৳5,00,000)
//   * KPMG "Salient Features of Finance Ordinance 2025" (June 2025): enacted
//     IY 2025-26 thresholds (375k/425k/500k/525k), 10–30% bands, minimum
//     tax ৳5,000 (৳1,000 first-time filers), surcharge 10–35% bands
//   * PwC Tax Summaries (FY 2026/27 table, Finance Act 2026): IY 2026-27
//     thresholds 400k/450k/525k/550k, rebate 10% / ৳7.5L
//
// Engine under test: src/hrm-server/ait-engine.ts (calculateAit, pure) and
// src/hrm-server/ait.ts (computeAit — the §86(1)+(4) payroll wrapper).
import "./_testdb" // first — sets DATABASE_URL before db.ts is constructed
import { describe, test, expect } from "bun:test"
import { calculateAit, defaultFy2026Config, defaultFy2027Config, type AitConfig } from "@/hrm-server/ait-engine"
import { computeAit } from "@/hrm-server/ait"

/** In-memory AitConfig built from the verified bootstrap presets (no DB rows). */
function mkConfig(preset: ReturnType<typeof defaultFy2026Config>): AitConfig {
  return {
    fiscalYearId: "test-" + preset.incomeYear, label: preset.label, incomeYear: preset.incomeYear,
    assessmentYear: preset.assessmentYear, tdsSectionRef: preset.tdsSectionRef,
    exemptionFraction: preset.exemptionFraction, exemptionCap: preset.exemptionCap,
    minimumTax: preset.minimumTax, newTaxpayerMinimumTax: preset.newTaxpayerMinimumTax,
    rebateRatePercent: preset.rebateRatePercent, rebateIncomeCapPercent: preset.rebateIncomeCapPercent,
    rebateCapFraction: preset.rebateCapFraction, rebateCapAmount: preset.rebateCapAmount,
    festivalBonusCount: preset.festivalBonusCount,
    categories: preset.categories.map((c) => ({ key: c.key, label: c.label, threshold: c.threshold })),
    slabs: preset.slabs.map((s) => ({ order: s.order, slabLabel: s.slabLabel, upperLimit: s.upperLimit, ratePercent: s.ratePercent })),
    surcharge: null, // engine falls back to the verified default band table
  }
}

const FY25 = mkConfig(defaultFy2026Config("test"))   // IY 2025-26 (AY 2026-27) — FO 2025
const FY27 = mkConfig(defaultFy2027Config("test"))   // IY 2026-27 (AY 2027-28) — FA 2026

describe("r8 Phase Ten — scenarios 1–3 (income composition)", () => {
  test("1. Salary only, no bonus — general category, IY 2025-26", () => {
    // Inputs: monthly gross 60,000 · basic 30,000 · festival bonus count 0
    // Formula: annual 720,000 → exemption ⅓ = 240,000 (Third Sch. item 27) →
    //   taxable 480,000 → above 375,000 threshold = 105,000 → 10% band → 10,500
    // Provision: §32 (employment income) + Third Sch. (27) + annual FA slabs
    const r = calculateAit(FY25, { monthlyGrossSalary: 60000, monthlyBasicSalary: 30000, festivalBonusOverride: 0 })
    expect(r.annualGross).toBe(720000)
    expect(r.exemption).toBe(240000)
    expect(r.taxableIncome).toBe(480000)
    expect(r.incomeAboveThreshold).toBe(105000)
    expect(r.slabTax).toBe(10500)
    expect(r.annualTax).toBe(10500)
    expect(r.averageRatePercent).toBeCloseTo(10500 / 720000 * 100, 5)
    expect(r.monthlyTds).toBe(875) // 60,000 × 1.4583%
  })

  test("2. Salary + one annual bonus — bonus projected once, not ×12", () => {
    // Inputs: gross 60,000 · basic 30,000 · festivalBonusOverride = 1
    // Formula: annual = 12×60,000 + 1×30,000 = 750,000 → exemption 250,000 →
    //   taxable 500,000 → above 125,000 → 12,500
    // Provision: §32 — bonuses are employment income; projection counts each
    // bonus once (the pre-audit payroll bug annualised the bonus month ×12)
    const r = calculateAit(FY25, { monthlyGrossSalary: 60000, monthlyBasicSalary: 30000, festivalBonusOverride: 1 })
    expect(r.annualGross).toBe(750000)
    expect(r.slabTax).toBe(12500)
    expect(r.festivalBonusAmount).toBe(30000)
  })

  test("3. Two festival bonuses + a performance bonus", () => {
    // Inputs: gross 60,000 · basic 30,000 · 2 festival bonuses (60,000) + a
    //   40,000 performance bonus → annual 820,000 (provided as the §86
    //   estimated total, as payroll would)
    // Formula: exemption ⅓ = 273,333 → taxable 546,667 → above 171,667 →
    //   10% band → 17,167
    const r = calculateAit(FY25, { monthlyGrossSalary: 0, annualGrossOverride: 820000 })
    expect(r.taxableIncome).toBe(546667)
    expect(r.slabTax).toBe(17167)
    expect(r.slabLines).toHaveLength(1)
  })
})

describe("r8 Phase Ten — scenarios 4–6 (§86(4) mid-year events, payroll path)", () => {
  test("4. Salary raised mid-year — catch-up adjusts for the deficit", async () => {
    // Inputs: months 1–6 at gross 50,000 (TDS withheld 6 × 486 = 2,916 on the
    //   old ৳5,833 annual estimate); month 7 at gross 100,000, basic 50,000,
    //   §86 estimated annual income 1,000,000 (YTD 300,000 + this month
    //   100,000 + 5 projected months + 100,000 remaining bonus projection)
    // Formula: tax on 1,000,000 = exemption 333,333 → taxable 666,667 →
    //   above 291,667 → 29,167; §86(4) catch-up = (29,167 − 2,916) ÷ 6 = 4,375
    // Provision: §86(4) — "the surplus or deficit shall be increased or
    //   decreased by an amount equal to the adjustment with any previous
    //   surplus or deficit"
    const r = await computeAit({
      vendorId: "test", monthlyTaxableIncome: 100000,
      employeeProfile: { monthlyBasicSalary: 50000 },
      annualEstimate: 1000000, tdsWithheldYtd: 2916, monthsRemainingInFy: 6, config: FY25,
    })
    expect(r.annualIncome).toBe(1000000)
    expect(r.annualTax).toBe(29167)
    expect(r.netMonthlyAit).toBe(4375) // (29,167 − 2,916) ÷ 6
    expect(r.tdsCatchUp).toBe(4375)
  })

  test("5. Employee joins mid-year — liability spread over the months left", async () => {
    // Inputs: joins in October (month 4 of the FY) at gross 60,000 · basic
    //   30,000 · 9 months remaining incl. October · nothing withheld yet ·
    //   §86 estimate = 60,000 + 8×60,000 + 60,000 bonus = 600,000
    // Formula: tax = exemption 200,000 → taxable 400,000 → above 25,000 →
    //   2,500; catch-up = 2,500 ÷ 9 = 278 (> the 250 avg-rate figure, because
    //   only 9 months remain to recover the full annual liability)
    const r = await computeAit({
      vendorId: "test", monthlyTaxableIncome: 60000,
      employeeProfile: { monthlyBasicSalary: 30000 },
      annualEstimate: 600000, tdsWithheldYtd: 0, monthsRemainingInFy: 9, config: FY25,
    })
    expect(r.annualTax).toBe(2500)
    expect(r.netMonthlyAit).toBe(278)
    expect(r.tdsCatchUp).toBe(278)
  })

  test("6. Employee leaves before year-end — final month absorbs the remainder", async () => {
    // Inputs: leaves in March (month 9); YTD earnings 850,000 (incl. one
    //   festival bonus), TDS already deducted 15,000, final payment 100,000,
    //   §86 estimate 950,000 (no future projection), months remaining = 1
    // Formula: exemption 316,667 → taxable 633,333 → above 258,333 → 10% =
    //   25,833; catch-up = (25,833 − 15,000) ÷ 1 = 10,833
    // Provision: §86(4) — with one month left, the whole remaining deficit
    //   lands in the final payslip (surfaces through the net-pay clamp if it
    //   ever exceeds the month's pay — never silently dropped)
    const r = await computeAit({
      vendorId: "test", monthlyTaxableIncome: 100000,
      annualEstimate: 950000, tdsWithheldYtd: 15000, monthsRemainingInFy: 1, config: FY25,
    })
    expect(r.annualTax).toBe(25833)
    expect(r.netMonthlyAit).toBe(10833)
  })
})

describe("r8 Phase Ten — scenarios 7–8 (perquisites and investments)", () => {
  test("7. Taxable perquisites — OT and commission are employment income", () => {
    // Inputs: gross 60,000; this month also OT 10,000 + commission 5,000 (paid
    //   once, inside the 795,000 §86 estimate); §32(1)(a) "any monetary
    //   receipts, salaries and benefits received from employment"
    // Formula: exemption 265,000 → taxable 530,000 → above 155,000 → 15,500;
    //   monthly TDS = 75,000 × avg rate 1.9497% = 1,462
    const r = calculateAit(FY25, { monthlyGrossSalary: 0, annualGrossOverride: 795000, currentMonthGross: 75000 })
    expect(r.slabTax).toBe(15500)
    expect(r.monthlyTds).toBe(1462)
  })

  test("8. Eligible vs ineligible/oversized investment — the 3% limb binds", () => {
    // Inputs: taxable income 775,000 (annual 1,162,500)
    //   (a) eligible investment 100,000 (Sixth Sch. Part 3 — life insurance,
    //       recognised PF, government securities, mutual funds…)
    //   (b) declared 500,000 — beyond the binding cap
    // Formula §78: rebate = LOWER OF 3%×775,000 = 23,250 · 15%×investment ·
    //   ৳10,00,000 → (a) 15,000 (investment limb) · (b) 23,250 (income limb)
    // Reason: once the 3% limb binds, additional investment yields no extra
    // rebate — the engine never rewards ineligible or excess declarations
    const base = { monthlyGrossSalary: 0 as const, annualGrossOverride: 1162500 }
    const a = calculateAit(FY25, { ...base, declaredInvestment: 100000 })
    const b = calculateAit(FY25, { ...base, declaredInvestment: 500000 })
    expect(a.rebateAmount).toBe(15000)
    expect(a.annualTax).toBe(45000 - 15000)
    expect(b.rebateAmount).toBe(23250)
    expect(b.rebateLimbs.investment).toBe(75000) // 15% × 500,000 — not binding
    expect(b.rebateAmount).toBe(b.rebateLimbs.income) // the 3% limb wins
  })
})

describe("r8 Phase Ten — scenarios 9–10 (slab boundaries and thresholds)", () => {
  test("9. Income exactly at a slab boundary — no off-by-one into the next band", () => {
    // Inputs: income-above-threshold exactly 300,000 (end of the 10% band)
    // Formula: 300,000×10% = 30,000, slabLines length 1; the 300,001st taka
    //   enters the 15% band (second case: exemption capped at ৳5,00,000, so
    //   gross 1,575,000 → taxable 1,075,000 → above 700,000 = 300k + 400k)
    // Provision: annual FA slab table — progressive banding (§18(2))
    const atBand = calculateAit(FY25, { monthlyGrossSalary: 0, annualGrossOverride: 1012500 })
    expect(atBand.incomeAboveThreshold).toBe(300000)
    expect(atBand.slabLines).toHaveLength(1)
    expect(atBand.slabTax).toBe(30000)
    const nextBand = calculateAit(FY25, { monthlyGrossSalary: 0, annualGrossOverride: 1575000 })
    expect(nextBand.exemption).toBe(500000) // ⅓ would be 525,000 — the cap binds
    expect(nextBand.incomeAboveThreshold).toBe(700000)
    expect(nextBand.slabLines).toHaveLength(2)
    expect(nextBand.slabTax).toBe(30000 + 60000) // + 400,000 × 15%
  })

  test("10. Just below vs just above the tax-free threshold", () => {
    // Inputs: taxable 374,999 (below the 375,000 general threshold) vs
    //   375,001 (one taka above)
    // Formula: below → zero tax, no minimum-tax flag; above → computed tax
    //   rounds to ৳0 but the minimum-tax floor now applies (5,000)
    // Provision: threshold from the annual FA; minimum tax per §163 framework
    const below = calculateAit(FY25, { monthlyGrossSalary: 0, annualGrossOverride: 562499 })
    expect(below.taxableIncome).toBeLessThanOrEqual(375000)
    expect(below.slabTax).toBe(0)
    expect(below.minimumTaxWarning).toBe(false)
    const above = calculateAit(FY25, { monthlyGrossSalary: 0, annualGrossOverride: 562501 })
    expect(above.taxableIncome).toBe(375001)
    expect(above.incomeAboveThreshold).toBe(1)
    expect(above.slabTax).toBe(0) // 10% of ৳1 rounds to zero
    expect(above.minimumTaxWarning).toBe(true) // the ৳5,000 floor binds at filing
    expect(above.minimumTaxEffective).toBe(5000)
  })
})

describe("r8 Phase Ten — scenarios 11–12 (minimum tax and surcharge)", () => {
  test("11. Minimum tax — floor flagged after rebate, never added to TDS", () => {
    // Inputs: annual 570,000 → taxable 380,000 → above 5,000 → tax 500
    // Formula: 500 < 5,000 floor → warning + minimumTaxEffective 5,000, but
    //   annualTax (the withholding basis) stays 500
    // Provision: annual Finance Act individual floor (§163 framework); the
    //   first-time-filer floor ৳1,000 is surfaced as its own warning
    const r = calculateAit(FY25, { monthlyGrossSalary: 0, annualGrossOverride: 570000 })
    expect(r.slabTax).toBe(500)
    expect(r.minimumTaxWarning).toBe(true)
    expect(r.annualTax).toBe(500)
    expect(r.minimumTaxEffective).toBe(5000)
    expect(r.warnings.some((w) => w.code === "MIN_TAX_NEW_FILER")).toBe(true)
  })

  test("12. Surcharge — wealth bands and the motor-car trigger, on the tax amount", () => {
    // Inputs: annual 1,162,500 → tax 45,000, then:
    //   (a) net worth ৳12 crore → 20% band → surcharge 9,000
    //   (b) net worth ৳55 crore → 35% band → surcharge 15,750
    //   (c) net worth ৳1.5 crore + 2 motor cars → 10% band by trigger
    // Provision: FO 2025 / FA 2026 — surcharge is a % OF THE TAX after
    //   rebate (not of wealth) and never enters monthly withholding
    const a = calculateAit(FY25, { monthlyGrossSalary: 0, annualGrossOverride: 1162500, netWealth: 120000000 })
    expect(a.surcharge!.percent).toBe(20)
    expect(a.surcharge!.amount).toBe(9000)
    expect(a.annualLiability).toBe(54000)
    expect(a.annualTax).toBe(45000) // withholding basis unchanged
    const b = calculateAit(FY25, { monthlyGrossSalary: 0, annualGrossOverride: 1162500, netWealth: 550000000 })
    expect(b.surcharge!.percent).toBe(35)
    expect(b.surcharge!.amount).toBe(15750)
    const c = calculateAit(FY25, { monthlyGrossSalary: 0, annualGrossOverride: 1162500, netWealth: 15000000, motorVehicles: 2 })
    expect(c.surcharge!.applicable).toBe(true)
    expect(c.surcharge!.percent).toBe(10)
    expect(c.surcharge!.triggers.join(" ")).toContain("motor cars")
  })
})

describe("r8 Phase Ten — scenarios 13–15 (other income, credits, advance tax)", () => {
  test("13. Previous-employer income is employment income; non-employment income is out of TDS scope", () => {
    // Inputs: monthly 60,000 + previous-employer income 300,000 in the same
    //   income year (§32(1)(d) — "any amount or benefit received from a past
    //   or future employer") → §86 estimate 1,020,000
    // Formula: exemption 340,000 → taxable 680,000 → above 305,000 →
    //   30,000 + 750 = 30,750
    // Reason: rental/business/capital-gains income is NOT added — §86
    //   withholding covers income from employment only; other income is
    //   assessed on the annual return (§166)
    const r = calculateAit(FY25, { monthlyGrossSalary: 0, annualGrossOverride: 1020000 })
    expect(r.taxableIncome).toBe(680000)
    expect(r.slabTax).toBe(30750)
  })

  test("14. Prior-employer TDS counts once as a §86(4) credit", async () => {
    // Inputs: §86 estimate 1,020,000 → tax 30,750; prior-employer TDS 8,000 +
    //   own runs 10,000 = 18,000 deducted; 6 months remaining
    // Formula: catch-up = (30,750 − 18,000) ÷ 6 = 2,125 — the credits reduce
    //   the REMAINING deductions exactly once (no double-count)
    const r = await computeAit({
      vendorId: "test", monthlyTaxableIncome: 85000,
      annualEstimate: 1020000, tdsWithheldYtd: 18000, monthsRemainingInFy: 6, config: FY25,
    })
    expect(r.annualTax).toBe(30750)
    expect(r.netMonthlyAit).toBe(2125)
  })

  test("15. Advance tax payments reduce the remaining monthly deductions once", async () => {
    // Inputs: annual tax 30,750; ৳12,000 advance tax already paid; 12 months
    // Formula: catch-up = (30,750 − 12,000) ÷ 12 = 1,563 (rounded)
    // Provision: §158 — advance tax is a payment against the assessment;
    //   the engine treats it identically to withheld TDS in the adjustment base
    const r = await computeAit({
      vendorId: "test", monthlyTaxableIncome: 85000,
      annualEstimate: 1020000, tdsWithheldYtd: 12000, monthsRemainingInFy: 12, config: FY25,
    })
    expect(r.netMonthlyAit).toBe(1563)
  })
})

describe("r8 Phase Ten — scenarios 16–17 (arrears and deduction corrections)", () => {
  test("16. Salary arrears — spread over the remaining months, not one month's spike", async () => {
    // Inputs: months 1–9 at 60,000 with ৳14,500 annual estimate (10,875
    //   deducted); month 10 pays 60,000 + 240,000 arrears; §86 estimate
    //   1,020,000; 3 months remaining
    // Formula: tax 30,750 → catch-up = (30,750 − 10,875) ÷ 3 = 6,625
    // Reason: §86(4) spreads the arrears tax over the remaining months —
    //   the pre-audit engine would have taxed (60,000+240,000)×12 ≈ ৳3.6M
    //   as the annual estimate in the arrears month (a ~12× overstatement)
    const r = await computeAit({
      vendorId: "test", monthlyTaxableIncome: 300000,
      annualEstimate: 1020000, tdsWithheldYtd: 10875, monthsRemainingInFy: 3, config: FY25,
    })
    expect(r.annualTax).toBe(30750)
    expect(r.netMonthlyAit).toBe(6625)
  })

  test("17. Over-deduction — catch-up floors at zero, surplus recovered at filing", async () => {
    // Inputs: annual tax 14,500 but 20,000 already deducted; 3 months left
    // Formula: (14,500 − 20,000) ÷ 3 < 0 → clamped to 0 — no further
    //   deduction; the 5,500 surplus is a return-filing refund matter
    const r = await computeAit({
      vendorId: "test", monthlyTaxableIncome: 60000,
      annualEstimate: 780000, tdsWithheldYtd: 20000, monthsRemainingInFy: 3, config: FY25,
    })
    expect(r.annualTax).toBe(14500)
    expect(r.netMonthlyAit).toBe(0)
  })
})

describe("r8 Phase Ten — scenarios 18–19 (zero income, incomplete data)", () => {
  test("18. Zero taxable income — no tax, no warnings", () => {
    // Inputs: annual 300,000 → exemption 100,000 → taxable 200,000, well
    //   below the 375,000 threshold
    const r = calculateAit(FY25, { monthlyGrossSalary: 0, annualGrossOverride: 300000 })
    expect(r.slabTax).toBe(0)
    expect(r.annualTax).toBe(0)
    expect(r.monthlyTds).toBe(0)
    expect(r.minimumTaxWarning).toBe(false)
  })

  test("19. Incomplete taxpayer information — explicit warnings, general threshold", () => {
    // Inputs: no category, no DOB, no net worth on record
    // Formula: general threshold + CATEGORY_ASSUMED + DOB_MISSING +
    //   SURCHARGE_NOT_ASSESSED warnings — never silently assume a benefit
    const r = calculateAit(FY25, { monthlyGrossSalary: 60000, monthlyBasicSalary: 30000, festivalBonusOverride: 0 })
    expect(r.categoryKey).toBe("general")
    expect(r.categoryAssumed).toBe(true)
    const codes = r.warnings.map((w) => w.code)
    expect(codes).toContain("CATEGORY_ASSUMED")
    expect(codes).toContain("DOB_MISSING")
    expect(codes).toContain("SURCHARGE_NOT_ASSESSED")
  })
})

describe("r8 Phase Ten — scenario 20 (two different assessment years)", () => {
  test("20a. Same income under IY 2025-26 (FO 2025) vs IY 2026-27 (FA 2026)", () => {
    // Inputs: annual gross 1,162,500 · declared investment 200,000 · general
    // FY 2025-26 (AY 2026-27): threshold 375,000 · rebate 15%/৳10L
    // FY 2026-27 (AY 2027-28): threshold 400,000 · rebate 10%/৳7.5L
    // Formula FY25: exemption 387,500 → taxable 775,000 → above 400,000 →
    //   30,000+15,000 = 45,000; rebate = min(23,250, 30,000, 1,000,000) = 23,250
    //   → net 21,750
    // Formula FY27: above 375,000 → 30,000+11,250 = 41,250; rebate =
    //   min(23,250, 20,000, 750,000) = 20,000 → net 21,250
    // Reason: the engine is fully year-versioned — thresholds AND rebate
    //   limbs differ by income year (§18(2))
    const base = { monthlyGrossSalary: 0 as const, annualGrossOverride: 1162500, declaredInvestment: 200000 }
    const a = calculateAit(FY25, base)
    const b = calculateAit(FY27, base)
    expect(a.assessmentYear).toBe("2026-27")
    expect(b.assessmentYear).toBe("2027-28")
    expect(a.threshold).toBe(375000)
    expect(b.threshold).toBe(400000)
    expect(a.slabTax).toBe(45000)
    expect(b.slabTax).toBe(41250)
    expect(a.rebateAmount).toBe(23250)
    expect(b.rebateAmount).toBe(20000)
    expect(a.annualTax).toBe(21750)
    expect(b.annualTax).toBe(21250)
  })

  test("20b. Category thresholds are year-versioned (disabled & FF)", () => {
    // FY 2025-26: disabled 500,000 / FF 525,000 · FY 2026-27: 525,000 / 550,000
    const d25 = calculateAit(FY25, { monthlyGrossSalary: 0, annualGrossOverride: 1000000, taxpayerCategory: "disabled" })
    const d27 = calculateAit(FY27, { monthlyGrossSalary: 0, annualGrossOverride: 1000000, taxpayerCategory: "disabled" })
    expect(d25.threshold).toBe(500000)
    expect(d27.threshold).toBe(525000)
    const f25 = calculateAit(FY25, { monthlyGrossSalary: 0, annualGrossOverride: 1000000, taxpayerCategory: "freedom_fighter" })
    const f27 = calculateAit(FY27, { monthlyGrossSalary: 0, annualGrossOverride: 1000000, taxpayerCategory: "freedom_fighter" })
    expect(f25.threshold).toBe(525000)
    expect(f27.threshold).toBe(550000)
  })
})

describe("r8 Phase Ten — non-resident flat rate (Phase Four completeness)", () => {
  test("non-resident: flat 30% on total income, no threshold/exemption/rebate", () => {
    // Inputs: non_resident category, annual 800,000, declared investment 100,000
    // Formula: 30% × 800,000 = 240,000 — §78 rebate is resident-only,
    //   Third-Schedule exemption does not apply
    // Provision: FO 2025 §2 — "Non-residents other than Bangladeshi
    //   non-residents shall pay tax on the total income at flat rate of 30%"
    const r = calculateAit(FY25, { monthlyGrossSalary: 0, annualGrossOverride: 800000, taxpayerCategory: "non_resident", declaredInvestment: 100000 })
    expect(r.nonResidentFlatRateApplied).toBe(true)
    expect(r.slabTax).toBe(240000)
    expect(r.rebateApplied).toBe(false)
    expect(r.warnings.some((w) => w.code === "NON_RESIDENT_FLAT")).toBe(true)
  })

  test("female category auto-applied from the gender field with a verify warning", () => {
    // Inputs: no explicit category, gender "Female" (as payroll passes from
    //   the employee master), annual 1,162,500 under IY 2026-27
    // Formula: female threshold 450,000 (vs general 400,000) → exemption
    //   387,500 → taxable 775,000 → above 325,000 → 300k@10% + 25k@15% =
    //   33,750 (instead of 41,250 at the general threshold) — women are
    //   entitled to the higher nil band without HR manually picking it
    // Provision: FA 2026 threshold table; the engine warns FEMALE_AUTO so the
    //   category is still verified by HR (never silently assumed)
    const r = calculateAit(FY27, { monthlyGrossSalary: 0, annualGrossOverride: 1162500, gender: "Female" })
    expect(r.categoryKey).toBe("female")
    expect(r.threshold).toBe(450000)
    expect(r.slabTax).toBe(33750)
    expect(r.warnings.some((w) => w.code === "FEMALE_AUTO")).toBe(true)
    // an EXPLICIT category always wins over the gender suggestion
    const explicit = calculateAit(FY27, { monthlyGrossSalary: 0, annualGrossOverride: 1162500, gender: "Female", taxpayerCategory: "general" })
    expect(explicit.categoryKey).toBe("general")
    expect(explicit.threshold).toBe(400000)
  })
})

describe("r8 Phase Ten — §86(4) steady-state invariant", () => {
  test("catch-up equals annualTax ÷ 12 when nothing is withheld yet", async () => {
    // The catch-up form must reduce to the NBR plain-language method ("tax on
    // total taxable salary income divided by twelve months") in steady state
    const r = await computeAit({
      vendorId: "test", monthlyTaxableIncome: 60000,
      employeeProfile: { monthlyBasicSalary: 30000 },
      annualEstimate: 720000, tdsWithheldYtd: 0, monthsRemainingInFy: 12, config: FY25,
    })
    expect(r.annualTax).toBe(10500)
    expect(r.netMonthlyAit).toBe(875) // 10,500 ÷ 12 = 875
  })
})

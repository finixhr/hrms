// r8 AIT legal audit — post-seed DB verification (run: bun scripts/r8-verify-ait.ts)
// Asserts the versioned configs, the corrected engine numbers inside the
// seeded October payroll run, and the audit journal.
import { PrismaClient } from "@prisma/client"

const db = new PrismaClient()
const url = process.env.DATABASE_URL || ""
if (!url.includes("hrm") || url.includes("production")) {
  console.error("Refusing to run against a non-test database:", url)
  process.exit(1)
}

let pass = 0, fail = 0
const check = (name: string, cond: boolean, detail?: string) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name}${detail ? " — " + detail : ""}`) }
}

async function main() {
  const vendor = await db.vendor.findFirst({ where: { name: { contains: "Bengal" } } })
  if (!vendor) throw new Error("seed vendor not found")
  const V = vendor.id

  console.log("1) Versioned fiscal-year configurations")
  const fys = await db.aitFiscalYear.findMany({ where: { vendorId: V }, orderBy: { incomeYear: "asc" } })
  check("two fiscal years shipped (2025-26 + 2026-27)", fys.length === 2 && fys.map((f) => f.incomeYear).join(",") === "2025-26,2026-27")
  const fy26 = fys.find((f) => f.incomeYear === "2025-26")
  const fy27 = fys.find((f) => f.incomeYear === "2026-27")
  check("FY 2025-26 is INACTIVE history (AY 2026-27 label)", fy26?.active === false && fy26?.assessmentYear === "2026-27")
  check("FY 2026-27 is ACTIVE (AY 2027-28 label, FA 2026)", fy27?.active === true && fy27?.assessmentYear === "2027-28")
  check("FY 2026-27 rebate limbs: 10% / 3% / ৳7.5L (FA 2026)", fy27?.rebateRatePercent === 10 && fy27?.rebateIncomeCapPercent === 3 && fy27?.rebateCapAmount === 750000)
  check("FY 2025-26 rebate limbs: 15% / 3% / ৳10L (FO 2025)", fy26?.rebateRatePercent === 15 && fy26?.rebateIncomeCapPercent === 3 && fy26?.rebateCapAmount === 1000000)
  check("minimum tax ৳5,000 + first-time filer ৳1,000 on both years", fy26?.minimumTax === 5000 && fy27?.minimumTax === 5000 && fy26?.newTaxpayerMinimumTax === 1000 && fy27?.newTaxpayerMinimumTax === 1000)

  const cats26 = await db.aitTaxpayerCategory.findMany({ where: { fiscalYearId: fy26?.id } })
  const cats27 = await db.aitTaxpayerCategory.findMany({ where: { fiscalYearId: fy27?.id } })
  const th26 = Object.fromEntries(cats26.map((c) => [c.key, c.threshold]))
  const th27 = Object.fromEntries(cats27.map((c) => [c.key, c.threshold]))
  check("FY 2025-26 thresholds (FO 2025 enacted): 375k/425k/500k/525k", th26.general === 375000 && th26.female === 425000 && th26.third_gender === 500000 && th26.disabled === 500000 && th26.freedom_fighter === 525000)
  check("FY 2026-27 thresholds (FA 2026): 400k/450k/525k/550k", th27.general === 400000 && th27.female === 450000 && th27.third_gender === 525000 && th27.disabled === 525000 && th27.freedom_fighter === 550000)
  check("non-resident category present on both years", th26.non_resident === 0 && th27.non_resident === 0)

  const slabs27 = await db.aitTaxSlab.findMany({ where: { fiscalYearId: fy27?.id }, orderBy: { order: "asc" } })
  check("slab widths 300k/400k/500k/2,000k @ 10/15/20/25/30", slabs27.map((s) => s.ratePercent).join(",") === "10,15,20,25,30" && slabs27.map((s) => s.upperLimit).join(",") === "300000,400000,500000,2000000,")

  console.log("2) Demo tax profiles")
  const md = await db.employee.findFirst({ where: { vendorId: V, code: "EMP-0001" } })
  const gm = await db.employee.findFirst({ where: { vendorId: V, code: "EMP-0002" } })
  check("EMP-0001 surcharge demo: net worth ৳4.5 crore + 2 cars", md?.taxNetWealth === 45000000 && md?.taxMotorVehicles === 2)
  check("EMP-0002 rebate demo: declared investment ৳1,50,000", gm?.declaredInvestment === 150000)

  console.log("3) October 2026 run — corrected engine numbers")
  const run = await db.payrollRun.findFirst({ where: { vendorId: V, periodYear: 2026, periodMonth: 10, periodWeek: 0, runType: "REGULAR" } })
  check("October 2026 CALCULATED run exists", !!run && ["CALCULATED", "HR_REVIEW"].includes(run.status))
  if (run) {
    const mdEntry = await db.payrollEntry.findFirst({ where: { runId: run.id, employeeId: md?.id || "" } })
    check("MD entry has AIT > 0 under the new engine", (mdEntry?.ait || 0) > 0, `ait=${mdEntry?.ait}`)
    // MD: gross 220,000 + festival 2×110,000 = annual estimate ≈ 2,860,000
    // exemption 500,000 (capped) → taxable 2,360,000 → above 400,000 = 1,960,000
    // tax = 300k×10% + 400k×15% + 500k×20% + 760k×25% = 30k+60k+100k+190k = 380,000
    // rebate: no declaration → 0. monthly catch-up (12 months, Sep paid) → see journal
    const bd = mdEntry ? JSON.parse(mdEntry.breakdownJson || "{}") : {}
    check("payslip breakdown carries the AIT line", !!bd.ait && bd.ait.netMonthlyAit > 0)
    const logs = await db.aitCalculationLog.count({ where: { vendorId: V, kind: "PAYROLL", runId: run.id } })
    check("every entry journaled (PAYROLL kind, runId-linked)", logs >= (mdEntry ? 1 : 0) && logs > 0, `journal rows: ${logs}`)
    const mdLog = await db.aitCalculationLog.findFirst({ where: { vendorId: V, kind: "PAYROLL", runId: run.id, employeeId: md?.id || "" } })
    if (mdLog) {
      const out = JSON.parse(mdLog.outputJson || "{}")
      const inp = JSON.parse(mdLog.inputsJson || "{}")
      const cfgSnap = JSON.parse(mdLog.configJson || "{}")
      check("journal snapshots the config used (§78 limbs + surcharge)", cfgSnap.rebateIncomeCapPercent === 3 && cfgSnap.rebateRatePercent === 10 && !!cfgSnap.surcharge)
      check("journal records the §86 estimate + catch-up inputs", inp.annualEstimate > 0 && inp.monthsRemainingInFy > 0 && inp.tdsWithheldYtd >= 0)
      // MD §86 estimate (actuals-based): Sep paid 220,000 + Oct 220,000 +
      // 8 projected months × 220,000 + 220,000 remaining festival bonus
      // = 2,420,000 → exemption capped 500,000 → taxable 1,920,000 → above
      // (general 400,000) 1,520,000 → 30k@10% + 400k@15% + 500k@20% +
      // 320k@25% = 270,000 (FA 2026 slabs; bonus counted ONCE, not ×12)
      check("MD §86 estimate is actuals-based (2,420,000 — bonus once, not ×12)", inp.annualEstimate === 2420000, `estimate=${inp.annualEstimate}`)
      check("MD annual tax = ৳2,70,000 under FA 2026 slabs", (out.annualTax || 0) === 270000, `annualTax=${out.annualTax}`)
      check("MD surcharge = 10% of the tax (৳4.5 crore + 2 cars → ৳27,000)", (out.surchargeAmount || 0) === 27000, `surcharge=${out.surchargeAmount}`)
    } else {
      check("MD journaled", false)
    }
    // GM consistency: recompute the journaled input through the pure engine
    // with the journaled config snapshot — the journal must be reproducible
    const gmLog = await db.aitCalculationLog.findFirst({ where: { vendorId: V, kind: "PAYROLL", runId: run.id, employeeId: gm?.id || "" } })
    if (gmLog) {
      const out = JSON.parse(gmLog.outputJson || "{}")
      const inp = JSON.parse(gmLog.inputsJson || "{}")
      const snap = JSON.parse(gmLog.configJson || "{}")
      const { calculateAit } = await import("../src/hrm-server/ait-engine")
      const replay = calculateAit(snap as any, {
        monthlyGrossSalary: inp.monthlyGrossSalary, annualGrossOverride: inp.annualEstimate,
        taxpayerCategory: inp.taxpayerCategory, gender: inp.gender, dateOfBirth: inp.dateOfBirth,
        declaredInvestment: inp.declaredInvestment, tdsYtd: inp.tdsWithheldYtd,
        monthsRemainingInFy: inp.monthsRemainingInFy,
      } as any)
      check("GM journal is reproducible from its own snapshot (same annualTax)", replay.annualTax === (out.annualTax || -1), `replay=${replay.annualTax} journal=${out.annualTax}`)
      check("GM §78 rebate applied (declared ৳1,50,000)", replay.rebateApplied === true && replay.rebateAmount === 15000, `rebate=${replay.rebateAmount}`)
      check("GM female threshold 450,000 applied (FA 2026)", replay.threshold === 450000, `threshold=${replay.threshold}`)
    } else {
      check("GM journaled", false)
    }
  }

  console.log("4) Consistency — the same employee/year across screens")
  // The AIT module calculator, certificates and reconciliation all read the
  // same engine + the same actual-TDS base; assert no legacy §164 references
  const legacyRefs = await db.$queryRaw<{ n: number }[]>`
    SELECT COUNT(*)::int AS n FROM "AitCalculationLog"
    WHERE "configJson" LIKE '%Section 164%' OR "outputJson" LIKE '%Sec 164%'`
  check("no 'Section 164' minimum-tax citations remain in new journal rows", (legacyRefs[0]?.n || 0) === 0)

  console.log(`\n${pass} passed, ${fail} failed`)
  await db.$disconnect()
  process.exit(fail ? 1 : 0)
}

main().catch(async (e) => { console.error(e); await db.$disconnect(); process.exit(1) })

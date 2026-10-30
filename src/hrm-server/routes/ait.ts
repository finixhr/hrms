// ============ AIT routes — Income Tax Act 2023 module ============
// All configuration per fiscal year (zero hardcoded rates). Covers:
//   config.get / fiscalYears.* / categories.save / slabs.save   (7E admin)
//   employee.profile                                            (per-employee tax data)
//   calc.preview / calc.save                                    (7A calculator)
//   batch.calculate / batch.results                             (7B batch, CSV or HRM pull)
//   reconciliation                                              (7C year-end)
//   certificate / certificates.list / myCertificates            (7D TDS certificates)
//   logs.list                                                   (7F audit journal)
import { db } from "@/lib/db"
import { route } from "./registry"
import { Deny, assertEmployeeVisible } from "../rbac"
import { audit } from "../audit"
import {
  calculateAit, loadAitConfig, ensureAitConfig, defaultFy2026Config, defaultFy2027Config,
  configSnapshot, journalAitCalculation, ageAt,
  type AitConfig, type AitInput,
} from "../ait-engine"

const AIT_ADMIN = ["ait", "view"] as [string, string]
const AIT_EDIT = ["ait", "edit"] as [string, string]

function parseNum(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/** FY window (1 Jul → 30 Jun) of an income year "2025-26". */
function fyWindow(incomeYear: string): { from: string; to: string } {
  const start = Number(String(incomeYear).slice(0, 4))
  return { from: `${start}-07-01`, to: `${start + 1}-06-30` }
}

/** Step-by-step display lines for the glassmorphism breakdown card (§6/§8).
 *  Mirrors the verified UI contract: key/label/labelBn/value/display/formula/ref. */
function displayLines(r: any, cfg: AitConfig) {
  const money = (n: number) => `৳ ${Math.round(n).toLocaleString("en-IN")}`
  const lines: any[] = [
    { key: "monthlyGross", label: "Monthly gross salary", labelBn: "মাসিক মোট বেতন", value: r.monthlyGross, display: money(r.monthlyGross) },
    {
      key: "festivalBonus",
      label: r.festivalBonusBasis === "FIXED"
        ? "Festival bonus (fixed amount)"
        : r.festivalBonusBasis === "GROSS"
          ? `Festival bonus (${r.festivalBonusMonths} × monthly gross)`
          : `Festival bonus (${r.festivalBonusMonths} × monthly basic)`,
      labelBn: "উৎসব ভাতা",
      value: r.festivalBonusAmount,
      display: money(r.festivalBonusAmount),
      ref: "Sec 2(20) ITA 2023",
    },
    { key: "annualGross", label: "Annual gross income", labelBn: "বার্ষিক মোট আয়", value: r.annualGross, display: money(r.annualGross), formula: "12 × monthly gross + festival bonus" },
    { key: "exemption", label: "Salary exemption", labelBn: "বেতন ছাড়", value: r.exemption, display: money(r.exemption), formula: `MIN(gross × ${cfg.exemptionFraction.toFixed(4)}, ${money(cfg.exemptionCap)}) — Third Schedule`, ref: "Third Schedule" },
    { key: "taxableIncome", label: "Taxable income", labelBn: "করযোগ্য আয়", value: r.taxableIncome, display: money(r.taxableIncome), formula: "annual gross − exemption" },
    { key: "threshold", label: `Tax threshold — ${r.categoryLabel}`, labelBn: "কর প্রযোজ্য সীমা", value: r.threshold, display: money(r.threshold) },
    { key: "incomeAboveThreshold", label: "Income above threshold", labelBn: "সীমার উর্ধ্বে আয়", value: r.incomeAboveThreshold, display: money(r.incomeAboveThreshold) },
    { key: "slabTax", label: "Slab tax", labelBn: "স্তরভিত্তিক কর", value: r.slabTax, display: money(r.slabTax), ref: "Annual Finance Act slabs (§18(2), ITA 2023)" },
  ]
  if (r.rebateApplied) {
    lines.push({ key: "rebate", label: "Investment rebate", labelBn: "বিনিয়োগ রেয়াত", value: -r.rebateAmount, display: `− ${money(r.rebateAmount)}`, formula: `LOWER OF 3% of taxable income (৳${money(r.rebateLimbs?.income ?? 0)}) · ${cfg.rebateRatePercent}% of eligible investment (৳${money(r.rebateLimbs?.investment ?? 0)}) · ৳${money(r.rebateLimbs?.absolute ?? cfg.rebateCapAmount)}`, ref: "Sec 78, ITA 2023" })
  }
  lines.push({ key: "annualTax", label: "Estimated annual tax (withholding basis)", labelBn: "প্রাক্কলিত বার্ষিক কর (কর্তনের ভিত্তি)", value: r.annualTax, display: money(r.annualTax) })
  if (r.minimumTaxEffective != null && r.minimumTaxEffective > r.annualTax) {
    lines.push({ key: "minimumTax", label: "Minimum-tax floor (return filing)", labelBn: "ন্যূনতম কর (রিটার্ন)", value: r.minimumTaxEffective, display: money(r.minimumTaxEffective), formula: `৳${money(cfg.minimumTax)} individual floor (${cfg.newTaxpayerMinimumTax ? `৳${money(cfg.newTaxpayerMinimumTax)} first-time filers` : "n/a"}) — applies AFTER rebate`, ref: "annual Finance Act; §163 framework" })
  }
  if (r.surcharge && r.surcharge.applicable) {
    lines.push({ key: "surcharge", label: `Surcharge (${r.surcharge.percent}%)`, labelBn: "সারচার্জ", value: r.surcharge.amount, display: money(r.surcharge.amount), formula: `${r.surcharge.percent}% of the tax amount — ${[r.surcharge.band, ...r.surcharge.triggers].join("; ")}`, ref: "FO 2025 / FA 2026 net-wealth bands" })
  }
  if (r.annualLiability != null) {
    lines.push({ key: "annualLiability", label: "Annual liability incl. surcharge", labelBn: "বার্ষিক দায় (সারচার্জ সহ)", value: r.annualLiability, display: money(r.annualLiability) })
  }
  lines.push({ key: "averageRate", label: "Average rate", labelBn: "গড় হার", value: r.averageRatePercent, display: `${r.averageRatePercent.toFixed(4)}%`, formula: "annual tax ÷ annual gross × 100" })
  lines.push({ key: "monthlyTds", label: "Monthly TDS to withhold", labelBn: "মাসিক উৎসে কর", value: r.monthlyTds, display: money(r.monthlyTds), formula: "current-month gross × average rate", ref: "Sec 86(1)" })
  if (r.monthlyTdsCatchUp != null) {
    lines.push({ key: "monthlyTdsCatchUp", label: "Adjusted monthly TDS (§86(4) catch-up)", labelBn: "সমন্বিত মাসিক কর (ধারা ৮৬(৪))", value: r.monthlyTdsCatchUp, display: money(r.monthlyTdsCatchUp), formula: "(annual tax − TDS already deducted) ÷ months remaining in the income year", ref: "Sec 86(4) — surplus/deficit adjustment" })
  }
  return lines
}

// ---------- configuration ----------

route("ait.config.get", {
  perm: AIT_ADMIN,
  handler: async (ctx, p) => {
    await ensureAitConfig(ctx.vendorId)
    const fiscalYearId = p?.fiscalYearId || null
    const cfg = await loadAitConfig(ctx.vendorId, fiscalYearId)
    if (!cfg) throw new Deny("No fiscal-year configuration found", 404)
    // Response carries BOTH the server-engine field names and the aliases the
    // AIT view expects (fiscalYear sub-object for the summary strip, category
    // `code` for the selects, client-engine slab `label`) — verified UI contract.
    return {
      config: {
        ...cfg,
        minimumTaxAmount: cfg.minimumTax,
        rebateRate: cfg.rebateRatePercent,
        investmentCapFraction: cfg.rebateCapFraction,
        investmentCapAmount: cfg.rebateCapAmount,
        rebateIncomeCapPercent: cfg.rebateIncomeCapPercent,
        newTaxpayerMinimumTax: cfg.newTaxpayerMinimumTax,
        fiscalYear: {
          label: cfg.label, incomeYear: cfg.incomeYear, assessmentYear: cfg.assessmentYear,
          tdsSectionRef: cfg.tdsSectionRef, exemptionFraction: cfg.exemptionFraction,
          exemptionCap: cfg.exemptionCap, minimumTax: cfg.minimumTax,
          newTaxpayerMinimumTax: cfg.newTaxpayerMinimumTax,
        },
        categories: cfg.categories.map((c) => ({ ...c, code: c.key })),
        slabs: cfg.slabs.map((s) => ({ ...s, label: s.slabLabel })),
      },
    }
  },
})

route("ait.fiscalYears.list", {
  perm: AIT_ADMIN,
  handler: async (ctx) => {
    await ensureAitConfig(ctx.vendorId)
    const list = await db.aitFiscalYear.findMany({ where: { vendorId: ctx.vendorId }, orderBy: { createdAt: "asc" } })
    const cats = await db.aitTaxpayerCategory.findMany({ where: { vendorId: ctx.vendorId } })
    const slabs = await db.aitTaxSlab.findMany({ where: { vendorId: ctx.vendorId } })
    return list.map((fy) => ({
      ...fy,
      categories: cats.filter((c) => c.fiscalYearId === fy.id).sort((a, b) => a.sortOrder - b.sortOrder),
      slabs: slabs.filter((s) => s.fiscalYearId === fy.id).sort((a, b) => a.order - b.order),
    }))
  },
})

route("ait.fiscalYears.save", {
  perm: AIT_EDIT,
  handler: async (ctx, p) => {
    // R2 (2026-10-12) — validate the year shapes: "YYYY-YY" where YY is the
    // next year's last two digits. Arbitrary strings previously flowed into
    // fyWindow/slice(-2) math used by reconciliation and certificates.
    const incomeYear = String(p?.incomeYear || "").trim()
    const assessmentYear = String(p?.assessmentYear || "").trim()
    const YEAR_RE = /^\d{4}-\d{2}$/
    if (incomeYear && !YEAR_RE.test(incomeYear)) throw new Deny('Income year must look like "2025-26" (July 2025 – June 2026)', 400)
    if (assessmentYear && !YEAR_RE.test(assessmentYear)) throw new Deny('Assessment year must look like "2026-27"', 400)
    if (incomeYear) {
      const start = Number(incomeYear.slice(0, 4))
      const next2 = Number(incomeYear.slice(5, 7))
      if (next2 !== (start + 1) % 100) throw new Deny("Income year must span consecutive years (e.g. 2025-26)", 400)
    }
    if (assessmentYear && incomeYear) {
      const ayStart = Number(assessmentYear.slice(0, 4))
      if (ayStart !== Number(incomeYear.slice(0, 4)) + 1) throw new Deny("Assessment year must be the year after the income year (e.g. income 2025-26 → assessment 2026-27)", 400)
    }
    const d: any = {
      label: String(p?.label || "").trim(),
      incomeYear: incomeYear,
      assessmentYear: assessmentYear,
      tdsSectionRef: String(p?.tdsSectionRef || "Section 86, Income Tax Act 2023").trim(),
      exemptionFraction: parseNum(p?.exemptionFraction) ?? 1 / 3,
      exemptionCap: parseNum(p?.exemptionCap) ?? 0,
      minimumTax: parseNum(p?.minimumTax) ?? 0,
      newTaxpayerMinimumTax: parseNum(p?.newTaxpayerMinimumTax),
      rebateRatePercent: parseNum(p?.rebateRatePercent) ?? 0,
      rebateIncomeCapPercent: parseNum(p?.rebateIncomeCapPercent) ?? 3,
      rebateCapFraction: parseNum(p?.rebateCapFraction) ?? 0.25,
      rebateCapAmount: parseNum(p?.rebateCapAmount) ?? 0,
      festivalBonusCount: parseNum(p?.festivalBonusCount) ?? 2,
      surchargeJson: p?.surchargeJson != null ? (typeof p.surchargeJson === "string" ? p.surchargeJson : JSON.stringify(p.surchargeJson)) : undefined,
      notes: p?.notes || null,
    }
    if (!d.label || !d.incomeYear) throw new Deny("Label and income year are required", 400)
    if (d.exemptionFraction <= 0 || d.exemptionFraction > 1) throw new Deny("Exemption fraction must be between 0 and 1 (e.g. 0.3333 for one-third)", 400)

    if (p?.id) {
      const existing = await db.aitFiscalYear.findFirst({ where: { id: p.id, vendorId: ctx.vendorId } })
      if (!existing) throw new Deny("Fiscal year not found", 404)
      const rec = await db.aitFiscalYear.update({ where: { id: p.id }, data: d })
      await audit(ctx, "ait.fiscalYears.save", "AitFiscalYear", rec.id, `Updated ${rec.label}`)
      return rec
    }
    const rec = await db.aitFiscalYear.create({ data: { ...d, vendorId: ctx.vendorId, active: false } })
    await audit(ctx, "ait.fiscalYears.save", "AitFiscalYear", rec.id, `Created ${rec.label}`)
    return rec
  },
})

route("ait.fiscalYears.activate", {
  perm: AIT_EDIT,
  handler: async (ctx, p) => {
    const fy = await db.aitFiscalYear.findFirst({ where: { id: p?.id, vendorId: ctx.vendorId } })
    if (!fy) throw new Deny("Fiscal year not found", 404)
    // single-active invariant — deactivate all others in one transaction
    await db.$transaction([
      db.aitFiscalYear.updateMany({ where: { vendorId: ctx.vendorId }, data: { active: false } }),
      db.aitFiscalYear.update({ where: { id: fy.id }, data: { active: true } }),
    ])
    await audit(ctx, "ait.fiscalYears.activate", "AitFiscalYear", fy.id, `Activated ${fy.label} — all calculations now use this year`)
    return { activated: true }
  },
})

route("ait.fiscalYears.seedDefaults", {
  perm: AIT_EDIT,
  handler: async (ctx, p) => {
    // Re-apply the legally verified bootstrap numbers to an existing (or new)
    // year. r8 audit: two presets — FY 2025-26 (Finance Ordinance 2025) and
    // FY 2026-27 (Finance Act 2026); pass { incomeYear: "2026-27" } to pick.
    const which = String(p?.incomeYear || "2026-27") === "2025-26" ? "2025-26" : "2026-27"
    const def = which === "2025-26" ? defaultFy2026Config(ctx.vendorId) : defaultFy2027Config(ctx.vendorId)
    let fyId = p?.id as string | undefined
    if (fyId) {
      const fy = await db.aitFiscalYear.findFirst({ where: { id: fyId, vendorId: ctx.vendorId } })
      if (!fy) throw new Deny("Fiscal year not found", 404)
      await db.aitTaxpayerCategory.deleteMany({ where: { fiscalYearId: fyId } })
      await db.aitTaxSlab.deleteMany({ where: { fiscalYearId: fyId } })
    } else {
      const fy = await db.aitFiscalYear.create({
        data: {
          vendorId: ctx.vendorId, label: def.label, incomeYear: def.incomeYear, assessmentYear: def.assessmentYear,
          tdsSectionRef: def.tdsSectionRef, exemptionFraction: def.exemptionFraction, exemptionCap: def.exemptionCap,
          minimumTax: def.minimumTax, newTaxpayerMinimumTax: def.newTaxpayerMinimumTax,
          rebateRatePercent: def.rebateRatePercent, rebateIncomeCapPercent: def.rebateIncomeCapPercent,
          rebateCapFraction: def.rebateCapFraction, rebateCapAmount: def.rebateCapAmount,
          festivalBonusCount: def.festivalBonusCount, active: false, notes: def.notes,
        },
      })
      fyId = fy.id
    }
    await db.aitTaxpayerCategory.createMany({ data: def.categories.map((c) => ({ ...c, vendorId: ctx.vendorId, fiscalYearId: fyId })) })
    await db.aitTaxSlab.createMany({ data: def.slabs.map((s) => ({ ...s, vendorId: ctx.vendorId, fiscalYearId: fyId })) })
    await audit(ctx, "ait.fiscalYears.seedDefaults", "AitFiscalYear", fyId, `Seeded ${which === "2025-26" ? "Finance Ordinance 2025" : "Finance Act 2026"} defaults`)
    return { id: fyId }
  },
})

route("ait.categories.save", {
  perm: AIT_EDIT,
  handler: async (ctx, p) => {
    const fyId = String(p?.fiscalYearId || "")
    const fy = await db.aitFiscalYear.findFirst({ where: { id: fyId, vendorId: ctx.vendorId } })
    if (!fy) throw new Deny("Fiscal year not found", 404)
    const rows: any[] = Array.isArray(p?.categories) ? p.categories : []
    if (!rows.length) throw new Deny("No categories provided", 400)
    const seen = new Set<string>()
    for (const r of rows) {
      // R2 (2026-10-12) — accept `key` OR the UI's historical `code` name
      // (the dialog sends code; the old read ignored it and every save 400'd).
      const key = String(r?.key || r?.code || "").toLowerCase().trim()
      if (!key) throw new Deny("Every category needs a key (or code)", 400)
      if (seen.has(key)) throw new Deny(`Duplicate category key "${key}"`, 400)
      seen.add(key)
    }
    await db.$transaction([
      db.aitTaxpayerCategory.deleteMany({ where: { fiscalYearId: fyId } }),
      db.aitTaxpayerCategory.createMany({
        data: rows.map((r, i) => ({
          vendorId: ctx.vendorId, fiscalYearId: fyId,
          key: String(r.key || r.code).toLowerCase().trim(),
          label: String(r.label || r.key || r.code).trim(),
          threshold: Math.max(0, parseNum(r.threshold) ?? 0),
          sortOrder: parseNum(r.sortOrder) ?? i + 1,
        })),
      }),
    ])
    await audit(ctx, "ait.categories.save", "AitFiscalYear", fyId, `Saved ${rows.length} taxpayer categories for ${fy.label}`)
    return { saved: rows.length }
  },
})

route("ait.slabs.save", {
  perm: AIT_EDIT,
  handler: async (ctx, p) => {
    const fyId = String(p?.fiscalYearId || "")
    const fy = await db.aitFiscalYear.findFirst({ where: { id: fyId, vendorId: ctx.vendorId } })
    if (!fy) throw new Deny("Fiscal year not found", 404)
    const rows: any[] = Array.isArray(p?.slabs) ? p.slabs : []
    if (!rows.length) throw new Deny("At least one slab is required", 400)
    // ---- MON-12 (Phase 4) — the engine interprets upperLimit as the BAND
    // WIDTH of each MARGINAL slab. That semantics is invisible on the admin
    // screen, and pasting a published CUMULATIVE table (1,00,000 /
    // 4,00,000 / 9,00,000 …) silently over-taxed every employee. The save
    // now (a) rejects structurally impossible tables and (b) ECHOES the exact
    // bracket table the engine will apply, with a worked example, so the
    // admin can see the interpretation before it costs anyone money.
    let unlimited = 0
    const widths: number[] = []
    const rates: number[] = []
    for (const [i, r] of rows.entries()) {
      const isUnlimited = r?.upperLimit == null || r?.upperLimit === ""
      if (isUnlimited) {
        unlimited++
        // a blank width is only meaningful as the FINAL row — an unlimited
        // band mid-table makes every later band unreachable
        if (i !== rows.length - 1) {
          throw new Deny(`Slab ${i + 1}: only the FINAL slab may be unlimited (blank width) — an unlimited band mid-table makes the slabs below it unreachable.`, 400)
        }
        widths.push(Infinity)
      } else {
        if (!(Number(r.upperLimit) > 0)) throw new Deny(`Slab ${i + 1}: the band width must be a positive number`, 400)
        widths.push(Number(r.upperLimit))
      }
      if (!(Number(r.ratePercent) >= 0)) throw new Deny(`Slab ${i + 1}: the rate must be 0 or more`, 400)
      rates.push(Number(r.ratePercent))
    }
    if (unlimited > 1) throw new Deny("Only the final slab may be unlimited (blank width)", 400)
    // marginal schedules never DECREASE — a decreasing rate is the signature
    // of a garbled paste (or a mis-typed row) and is structurally impossible
    for (let i = 1; i < rates.length; i++) {
      if (rates[i] < rates[i - 1]) {
        throw new Deny(`Slab ${i + 1}: the rate (${rates[i]}%) is LOWER than slab ${i}'s (${rates[i - 1]}%) — marginal schedules never decrease. Check the table you pasted.`, 400)
      }
    }
    // an all-zero table withholds nothing — almost certainly a mistake
    if (rates.every((r) => !(r > 0))) {
      throw new Deny("Every rate is 0% — this table would withhold nothing. Enter the real published rates (or delete the fiscal year if it is unused).", 400)
    }
    // ---- the bracket table the ENGINE will apply (widths → cumulative
    // from/to bands) + a worked example on ৳10,00,000 annual income ----
    let running = 0
    const brackets: { from: number; to: number | null; rate: number; label: string }[] = []
    for (let i = 0; i < widths.length; i++) {
      const from = running
      const to = widths[i] === Infinity ? null : running + widths[i]
      brackets.push({ from, to, rate: rates[i], label: String(rows[i]?.slabLabel || `Slab ${i + 1}`) })
      running = to ?? running
    }
    const EXAMPLE_INCOME = 10_00_000
    let exampleTax = 0
    let exampleIncomeLeft = EXAMPLE_INCOME
    for (const b of brackets) {
      if (exampleIncomeLeft <= 0) break
      const span = b.to == null ? exampleIncomeLeft : Math.min(exampleIncomeLeft, b.to - b.from)
      if (span > 0) exampleTax += span * b.rate / 100
      exampleIncomeLeft -= span
    }
    // cumulative-paste warning: in a pasted CUMULATIVE table (1,00,000 /
    // 4,00,000 / 9,00,000 …) the "widths" are actually the published
    // BOUNDARIES, so each is far larger than everything above it combined.
    // Heuristic (advisory, never a rejection): at least TWO non-final widths
    // each ≥ 1.5 × the sum of all the widths above them. The standard
    // published WIDTH table (1L / 3L / 5L / 10L …) trips at most one.
    let hits = 0
    {
      let acc = 0
      for (let i = 0; i < widths.length; i++) {
        if (widths[i] === Infinity) break
        if (i > 0 && widths[i] >= 1.5 * acc) hits++
        acc += widths[i]
      }
    }
    const looksCumulative = widths.length >= 3 && hits >= 2
    await db.$transaction([
      db.aitTaxSlab.deleteMany({ where: { fiscalYearId: fyId } }),
      db.aitTaxSlab.createMany({
        data: rows.map((r, i) => ({
          vendorId: ctx.vendorId, fiscalYearId: fyId,
          order: i + 1,
          slabLabel: String(r?.slabLabel || (i === 0 ? "First slab" : `Slab ${i + 1}`)).trim(),
          upperLimit: r?.upperLimit == null || r?.upperLimit === "" ? null : Number(r.upperLimit),
          ratePercent: Number(r?.ratePercent) || 0,
        })),
      }),
    ])
    await audit(ctx, "ait.slabs.save", "AitFiscalYear", fyId, `Saved ${rows.length} slabs for ${fy.label}`)
    return {
      saved: rows.length,
      semantics: "WIDTHS",
      brackets,
      example: { annualIncome: EXAMPLE_INCOME, tax: Math.round(exampleTax) },
      ...(looksCumulative ? { warning: "These widths look like a pasted CUMULATIVE table (each width is at least the sum of all the widths above it). The engine treats every upper limit as the BAND WIDTH of that marginal slab — check the bracket table below to confirm this is what you intend, or re-paste the table as marginal band widths (e.g. 1,00,000 then 3,00,000 then 5,00,000 …)." } : {}),
    }
  },
})

// ---------- per-employee tax profile ----------

route("ait.employee.profile", {
  perm: AIT_ADMIN,
  handler: async (ctx, p) => {
    const emp = await assertEmployeeVisible(ctx, p?.employeeId)
    const structure = await db.salaryStructure.findFirst({
      where: { employeeId: emp.id, status: "ACTIVE" },
      orderBy: { effectiveFrom: "desc" },
    })
    const age = emp.dob ? ageAt(emp.dob, new Date()) : null
    const desig = emp.designationId ? await db.designation.findUnique({ where: { id: emp.designationId } }) : null
    return {
      employeeId: emp.id, code: emp.code, fullName: emp.fullName,
      designationName: desig?.name || "",
      dateOfBirth: emp.dob || null, age,
      seniorSuggested: age != null && age >= 65,
      taxTin: emp.taxTin || null,
      taxpayerCategory: emp.taxCategory || null,
      declaredInvestment: emp.declaredInvestment ?? null,
      festivalBonusOverride: emp.festivalBonusOverride ?? null,
      annualGrossOverride: emp.annualGrossOverride ?? null,
      previousEmployerIncome: (emp as any).previousEmployerIncome ?? 0,
      tdsYtd: (emp as any).taxAlreadyDeducted ?? 0,
      netWealth: (emp as any).taxNetWealth ?? null,
      motorVehicles: (emp as any).taxMotorVehicles ?? 0,
      monthlyBasicSalary: structure?.basic ?? 0,
      monthlyGrossSalary: structure?.gross ?? 0,
    }
  },
})

route("ait.employee.save", {
  perm: AIT_EDIT,
  handler: async (ctx, p) => {
    const emp = await assertEmployeeVisible(ctx, p?.employeeId)
    const data: any = {
      taxTin: p?.taxTin ? String(p.taxTin).trim() : null,
      taxCategory: p?.taxpayerCategory ? String(p.taxpayerCategory).toLowerCase().trim() : null,
      declaredInvestment: parseNum(p?.declaredInvestment),
      festivalBonusOverride: parseNum(p?.festivalBonusOverride),
      annualGrossOverride: parseNum(p?.annualGrossOverride),
    }
    // §32(d) — income from a past employer is employment income; keep the
    // declaration on the master record (paired with taxAlreadyDeducted, the
    // prior-employer TDS credit for the §86(4) adjustment base)
    const prevEmployerIncome = parseNum(p?.previousEmployerIncome)
    if (prevEmployerIncome != null) {
      if (prevEmployerIncome < 0) throw new Deny("Previous employer income cannot be negative", 400)
      data.previousEmployerIncome = prevEmployerIncome
    }
    // r8 audit — surcharge inputs (nullable / validated)
    const netWealth = parseNum(p?.netWealth)
    if (netWealth != null) {
      if (netWealth < 0) throw new Deny("Declared net wealth cannot be negative", 400)
      data.taxNetWealth = netWealth
    } else if (p && "netWealth" in p) {
      data.taxNetWealth = null
    }
    const vehicles = parseNum(p?.motorVehicles)
    if (vehicles != null) {
      if (!Number.isInteger(vehicles) || vehicles < 0 || vehicles > 50) throw new Deny("Motor vehicles owned must be a whole number between 0 and 50", 400)
      data.taxMotorVehicles = vehicles
    }
    if (data.taxTin && !/^\d{6,17}$/.test(data.taxTin)) throw new Deny("TIN must be 6–17 digits", 400)
    const rec = await db.employee.update({ where: { id: emp.id }, data })
    await audit(ctx, "ait.employee.save", "Employee", emp.id, `Updated AIT profile of ${emp.fullName}`, { newValue: data })
    return { saved: true, taxTin: rec.taxTin, taxCategory: rec.taxCategory }
  },
})

// ---------- calculator ----------

/** Actual TDS withheld from PAID payroll runs inside the income-year window
 *  (§86(4) adjustment base) + the calendar months of the income year remaining
 *  INCLUDING the current month. Shared by the calculator, reconciliation and
 *  certificates so every screen reconciles with the payroll ledger. */
async function fyActuals(vendorId: string, cfg: AitConfig, employeeId?: string | null) {
  const fyStartYear = Number(cfg.incomeYear.slice(0, 4))
  const fyEndYear = Number("20" + cfg.incomeYear.slice(-2))
  if (!Number.isFinite(fyStartYear)) return { tdsActual: 0, monthsRemaining: 12 }
  const runs = await db.payrollRun.findMany({
    where: { vendorId, status: "PAID" },
    select: { id: true, periodMonth: true, periodYear: true },
  })
  const fyRuns = runs.filter((r) =>
    (r.periodYear === fyStartYear && r.periodMonth >= 7) || (r.periodYear === fyEndYear && r.periodMonth <= 6))
  let tdsActual = 0
  if (fyRuns.length && employeeId) {
    const entries = await db.payrollEntry.findMany({
      where: { runId: { in: fyRuns.map((r) => r.id) }, employeeId },
      select: { ait: true },
    })
    tdsActual = entries.reduce((s, e) => s + (e.ait || 0), 0)
  }
  // months remaining in the FY window including the current calendar month
  const now = new Date()
  const monthsIntoFy = (now.getFullYear() - fyStartYear) * 12 + (now.getMonth() + 1 - 7)
  const monthsRemaining = Math.min(12, Math.max(1, 12 - monthsIntoFy))
  return { tdsActual, monthsRemaining }
}

/** Batch variant of fyActuals — one query for the whole employee list. */
async function fyActualsBatch(vendorId: string, cfg: AitConfig, employeeIds: string[]) {
  const fyStartYear = Number(cfg.incomeYear.slice(0, 4))
  const fyEndYear = Number("20" + cfg.incomeYear.slice(-2))
  const tdsActualByEmp = new Map<string, number>()
  if (!Number.isFinite(fyStartYear) || !employeeIds.length) {
    return { tdsActualByEmp, monthsRemaining: 12 }
  }
  const runs = await db.payrollRun.findMany({
    where: { vendorId, status: "PAID" },
    select: { id: true, periodMonth: true, periodYear: true },
  })
  const fyRuns = runs.filter((r) =>
    (r.periodYear === fyStartYear && r.periodMonth >= 7) || (r.periodYear === fyEndYear && r.periodMonth <= 6))
  if (fyRuns.length) {
    const entries = await db.payrollEntry.findMany({
      where: { runId: { in: fyRuns.map((r) => r.id) }, employeeId: { in: employeeIds } },
      select: { employeeId: true, ait: true },
    })
    for (const e of entries) tdsActualByEmp.set(e.employeeId, (tdsActualByEmp.get(e.employeeId) || 0) + (e.ait || 0))
  }
  const now = new Date()
  const monthsIntoFy = (now.getFullYear() - fyStartYear) * 12 + (now.getMonth() + 1 - 7)
  const monthsRemaining = Math.min(12, Math.max(1, 12 - monthsIntoFy))
  return { tdsActualByEmp, monthsRemaining }
}

async function inputForEmployee(cfg: AitConfig, p: any, emp: any): Promise<AitInput> {
  const structure = await db.salaryStructure.findFirst({
    where: { employeeId: emp.id, status: "ACTIVE" },
    orderBy: { effectiveFrom: "desc" },
  })
  // r8 audit — the §86(4) base combines the ACTUAL TDS from this vendor's PAID
  // runs with the employee-master field for genuinely prior withholding
  // (previous-employer TDS paired with previousEmployerIncome, spec §9.5).
  const { tdsActual, monthsRemaining } = await fyActuals(emp.vendorId || (p as any)?.vendorId, cfg, emp.id).catch(() => ({ tdsActual: 0, monthsRemaining: 12 }))
  return {
    taxpayerCategory: p?.taxpayerCategory != null ? String(p.taxpayerCategory) : emp.taxCategory,
    gender: p?.gender != null ? String(p.gender) : emp.gender,
    dateOfBirth: p?.dateOfBirth != null && p?.dateOfBirth !== "" ? String(p.dateOfBirth)
      : p?.dob != null && p?.dob !== "" ? String(p.dob)
      : emp.dob,
    monthlyBasicSalary: parseNum(p?.monthlyBasicSalary) ?? structure?.basic ?? 0,
    monthlyGrossSalary: parseNum(p?.monthlyGrossSalary) ?? structure?.gross ?? 0,
    festivalBonusBasis: p?.festivalBonusBasis || null,
    festivalBonusMultiplier: parseNum(p?.festivalBonusMultiplier),
    festivalBonusAmount: parseNum(p?.festivalBonusAmount),
    festivalBonusOverride: parseNum(p?.festivalBonusOverride) ?? emp.festivalBonusOverride ?? null,
    annualGrossOverride: parseNum(p?.annualGrossOverride) ?? emp.annualGrossOverride ?? null,
    currentMonthGross: parseNum(p?.currentMonthGross) ?? undefined,
    declaredInvestment: parseNum(p?.declaredInvestment) ?? emp.declaredInvestment ?? 0,
    tdsYtd: parseNum(p?.tdsYtd) ?? (tdsActual + Math.max(0, emp.taxAlreadyDeducted || 0)),
    monthsRemainingInFy: parseNum(p?.monthsRemainingInFy) ?? monthsRemaining,
    netWealth: parseNum(p?.netWealth) ?? emp.taxNetWealth ?? null,
    motorVehicles: parseNum(p?.motorVehicles) ?? emp.taxMotorVehicles ?? null,
  }
}

route("ait.calc.preview", {
  perm: AIT_ADMIN,
  handler: async (ctx, p) => {
    let cfg = await loadAitConfig(ctx.vendorId, p?.fiscalYearId || null)
    if (!cfg) {
      if (p?.fiscalYearId) throw new Deny(MESSAGES_NO_CONFIG, 400)
      await ensureAitConfig(ctx.vendorId)
      cfg = await loadAitConfig(ctx.vendorId)
      if (!cfg) throw new Deny(MESSAGES_NO_CONFIG, 500)
    }
    let input: AitInput
    let employee: { id: string; code?: string; name?: string } | null = null
    if (p?.employeeId) {
      const emp = await assertEmployeeVisible(ctx, p.employeeId)
      employee = { id: emp.id, code: emp.code, name: emp.fullName }
      input = await inputForEmployee(cfg, p, emp)
    } else {
      const { monthsRemaining } = await fyActuals(ctx.vendorId, cfg, null).catch(() => ({ monthsRemaining: 12 }))
      input = {
        taxpayerCategory: p?.taxpayerCategory || null,
        gender: p?.gender || null,
        dateOfBirth: p?.dateOfBirth || p?.dob || null,
        monthlyBasicSalary: parseNum(p?.monthlyBasicSalary) ?? 0,
        monthlyGrossSalary: parseNum(p?.monthlyGrossSalary) ?? 0,
        festivalBonusBasis: p?.festivalBonusBasis || null,
        festivalBonusMultiplier: parseNum(p?.festivalBonusMultiplier),
        festivalBonusAmount: parseNum(p?.festivalBonusAmount),
        festivalBonusOverride: parseNum(p?.festivalBonusOverride),
        annualGrossOverride: parseNum(p?.annualGrossOverride),
        currentMonthGross: parseNum(p?.currentMonthGross) ?? undefined,
        declaredInvestment: parseNum(p?.declaredInvestment) ?? 0,
        tdsYtd: parseNum(p?.tdsYtd) ?? 0,
        monthsRemainingInFy: parseNum(p?.monthsRemainingInFy) ?? monthsRemaining,
        netWealth: parseNum(p?.netWealth) ?? null,
        motorVehicles: parseNum(p?.motorVehicles) ?? null,
      }
      if (input.monthlyGrossSalary <= 0) throw new Deny("Monthly gross salary must be greater than zero", 400)
    }
    if (Number(input.monthlyBasicSalary ?? 0) > 0 && input.monthlyGrossSalary > 0 && Number(input.monthlyBasicSalary ?? 0) > input.monthlyGrossSalary) {
      throw new Deny("Monthly basic cannot exceed monthly gross", 400)
    }
    if (input.monthlyGrossSalary < 0) throw new Deny("Salary cannot be negative", 400)
    const result = calculateAit(cfg, input)
    await journalAitCalculation({ vendorId: ctx.vendorId, config: cfg, input, result, kind: "PREVIEW", employee, operator: ctx as any })
    const display = { ...result, lines: displayLines(result, cfg), config: configSnapshot(cfg) }
    return { config: configSnapshot(cfg), input, result: display, disclaimer: DISCLAIMER }
  },
})

route("ait.calc.save", {
  perm: AIT_EDIT,
  handler: async (ctx, p) => {
    if (!p?.employeeId) throw new Deny("employeeId is required to save a calculation", 400)
    const cfg = await loadAitConfig(ctx.vendorId, p?.fiscalYearId || null)
    if (!cfg) throw new Deny(MESSAGES_NO_CONFIG, 400)
    const emp = await assertEmployeeVisible(ctx, p.employeeId)
    // R2 (2026-10-12) — the calculator sends { employeeId, input, result }:
    // honor the echoed input (what the operator actually SAW) with employee
    // defaults for anything missing. Recompute server-side from that input so
    // the journal can never diverge from the engine's own math.
    const echo = (p.input && typeof p.input === "object") ? p.input : p
    const input = await inputForEmployee(cfg, echo, emp)
    const result = calculateAit(cfg, input)
    await journalAitCalculation({
      vendorId: ctx.vendorId, config: cfg, input, result, kind: "SAVE",
      employee: { id: emp.id, code: emp.code, name: emp.fullName }, operator: ctx as any,
    })
    const display = { ...result, lines: displayLines(result, cfg), config: configSnapshot(cfg) }
    // persist the declared investment + category on the employee master
    await db.employee.update({
      where: { id: emp.id },
      data: {
        declaredInvestment: input.declaredInvestment ?? null,
        ...(input.taxpayerCategory ? { taxCategory: String(input.taxpayerCategory).toLowerCase() } : {}),
      },
    })
    await audit(ctx, "ait.calc.save", "Employee", emp.id, `Saved AIT calculation for ${emp.fullName} — annual tax ৳${result.annualTax.toLocaleString("en-IN")}`)
    return { saved: true, result: display }
  },
})

// legacy alias (old payroll view called ait.preview)
route("ait.preview", {
  perm: AIT_ADMIN,
  handler: async (ctx, p) => {
    const d = await (await getRouteHandler("ait.calc.preview"))(ctx, p)
    return d
  },
})

// ---------- batch (7B) — pull from HRM or uploaded CSV rows ----------

route("ait.batch.calculate", {
  perm: AIT_EDIT,
  handler: async (ctx, p) => {
    const cfg = await loadAitConfig(ctx.vendorId, null)
    if (!cfg) throw new Deny(MESSAGES_NO_CONFIG, 400)
    const branchId = p?.branchId || null
    const rows: any[] = []

    if (Array.isArray(p?.csvRows) && p.csvRows.length > 0) {
      // CSV upload path: [{ name, code, basic, gross, category, dob, investment }]
      // HIGH-10 fix (this audit) — match by employee code (unique) primarily;
      // fall back to case-insensitive full-name match ONLY when no code is provided.
      // Emit a warning on multiple name matches so the operator can correct the CSV.
      const emps = await db.employee.findMany({ where: { vendorId: ctx.vendorId }, select: { id: true, code: true, fullName: true, taxTin: true, taxCategory: true } })
      const byCode = new Map<string, any>(emps.map((e) => [(e.code || "").toLowerCase(), e]).filter(([k]) => k) as any[])
      const byNameBuckets = new Map<string, any[]>()
      for (const e of emps) {
        const k = (e.fullName || "").toLowerCase()
        if (!k) continue
        const bucket = byNameBuckets.get(k) || []
        bucket.push(e)
        byNameBuckets.set(k, bucket)
      }
      const csvWarnings: string[] = []
      for (const r of p.csvRows.slice(0, 500)) {
        const gross = parseNum(r?.gross) ?? parseNum(r?.monthlyGross) ?? 0
        if (gross <= 0) continue
        let empRef: any = null
        const code = String(r?.code || "").trim().toLowerCase()
        if (code) {
          empRef = byCode.get(code) || null
          if (!empRef) csvWarnings.push(`CSV row "${r?.name || ""}" — code "${r?.code}" not found in vendor employees`)
        } else {
          // Fall back to name only if no code is supplied
          const nameKey = String(r?.name || "").toLowerCase()
          const bucket = nameKey ? byNameBuckets.get(nameKey) : undefined
          if (bucket && bucket.length === 1) {
            empRef = bucket[0]
          } else if (bucket && bucket.length > 1) {
            csvWarnings.push(`CSV row "${r?.name}" — ${bucket.length} employees share this name; add a "code" column to disambiguate`)
          }
        }
        rows.push({ employeeId: null, code: r?.code || "", name: String(r?.name || "—"), gross, basic: parseNum(r?.basic) ?? 0, category: r?.category || null, dob: r?.dob || null, investment: parseNum(r?.investment) ?? 0, empRef })
      }
      // Surface CSV warnings in the result so the operator can correct + re-run.
      ;(p as any).__csvWarnings = csvWarnings
    } else {
      // HRM pull path: every employee in scope with an active structure
      const emps = await db.employee.findMany({
        where: { vendorId: ctx.vendorId, ...(branchId ? { branchId } : {}), status: { in: ["ACTIVE", "PROBATION", "ON_LEAVE"] } },
        select: { id: true, code: true, fullName: true, dob: true, taxCategory: true, taxTin: true, declaredInvestment: true, taxAlreadyDeducted: true, taxNetWealth: true, taxMotorVehicles: true },
      })
      const structures = await db.salaryStructure.findMany({
        where: { employeeId: { in: emps.map((e) => e.id) }, status: "ACTIVE" },
        orderBy: { effectiveFrom: "desc" },
      })
      // r8 audit — actual TDS already deducted this income year (own PAID runs),
      // fetched in ONE query so the batch stays O(1) queries per data class
      const { tdsActualByEmp, monthsRemaining } = await fyActualsBatch(ctx.vendorId, cfg, emps.map((e) => e.id))
      const structOf = (id: string) => structures.find((s) => s.employeeId === id)
      for (const e of emps) {
        const st = structOf(e.id)
        if (!st) continue
        rows.push({
          employeeId: e.id, code: e.code, name: e.fullName, gross: st.gross, basic: st.basic,
          category: e.taxCategory, dob: e.dob, investment: e.declaredInvestment ?? 0,
          tdsYtd: (tdsActualByEmp.get(e.id) || 0) + Math.max(0, e.taxAlreadyDeducted ?? 0),
          monthsRemainingInFy: monthsRemaining,
          netWealth: e.taxNetWealth ?? null, motorVehicles: e.taxMotorVehicles ?? null,
          taxTin: e.taxTin,
        })
      }
    }

    const results: any[] = []
    for (const r of rows) {
      const input: AitInput = {
        taxpayerCategory: r.category,
        dateOfBirth: r.dob,
        monthlyBasicSalary: r.basic,
        monthlyGrossSalary: r.gross,
        declaredInvestment: r.investment,
        tdsYtd: r.tdsYtd ?? 0,
        ...(r.monthsRemainingInFy != null ? { monthsRemainingInFy: r.monthsRemainingInFy } : {}),
        ...(r.netWealth != null ? { netWealth: r.netWealth } : {}),
        ...(r.motorVehicles != null ? { motorVehicles: r.motorVehicles } : {}),
      }
      const result = calculateAit(cfg, input)
      results.push({
        employeeId: r.employeeId, code: r.code, name: r.name,
        category: result.categoryKey, categoryAssumed: result.categoryAssumed,
        dob: r.dob || null, seniorSuggested: result.ageAtFyStart != null && result.ageAtFyStart >= 65,
        annualGross: result.annualGross, annualTax: result.annualTax, averageRatePercent: result.averageRatePercent, monthlyTds: result.monthlyTds,
        monthlyTdsCatchUp: result.monthlyTdsCatchUp,
        warnings: result.warnings.map((w) => w.code),
      })
      await journalAitCalculation({
        vendorId: ctx.vendorId, config: cfg, input, result, kind: "BATCH",
        employee: r.employeeId ? { id: r.employeeId, code: r.code, name: r.name } : null,
        operator: ctx as any,
      })
    }
    const summary = {
      employees: results.length,
      totalAnnualTax: results.reduce((s, r) => s + r.annualTax, 0),
      totalMonthlyTds: results.reduce((s, r) => s + r.monthlyTds, 0),
      withWarnings: results.filter((r) => r.warnings.length > 0).length,
      minTaxFlags: results.filter((r) => r.warnings.includes("MIN_TAX")).length,
      unverifiedCategories: results.filter((r) => r.warnings.includes("CATEGORY_ASSUMED") || r.warnings.includes("CATEGORY_UNKNOWN")).length,
      missingDob: results.filter((r) => r.warnings.includes("DOB_MISSING")).length,
    }
    await audit(ctx, "ait.batch.calculate", "AitCalculationLog", null, `Batch AIT: ${summary.employees} employees, monthly TDS ৳${summary.totalMonthlyTds.toLocaleString("en-IN")}`)
    return { fiscalYear: cfg.label, results, summary, disclaimer: DISCLAIMER }
  },
})

route("ait.batch.results", {
  perm: AIT_ADMIN,
  handler: async (ctx, p) => {
    const take = Math.min(200, Number(p?.take) || 50)
    const list = await db.aitCalculationLog.findMany({
      where: { vendorId: ctx.vendorId, kind: "BATCH" },
      orderBy: { createdAt: "desc" }, take,
    })
    return list.map((l) => ({
      id: l.id, createdAt: l.createdAt, employeeName: l.employeeName || "—", employeeCode: l.employeeCode,
      output: JSON.parse(l.outputJson || "{}"), warnings: JSON.parse(l.warningsJson || "[]"),
    }))
  },
})

// ---------- reconciliation (7C) ----------

route("ait.reconciliation", {
  perm: AIT_ADMIN,
  handler: async (ctx, p) => {
    const cfg = await loadAitConfig(ctx.vendorId, p?.fiscalYearId || null)
    if (!cfg) throw new Deny(MESSAGES_NO_CONFIG, 400)
    const win = fyWindow(cfg.incomeYear)

    // actual TDS withheld from PAID payroll runs inside the FY window
    const runs = await db.payrollRun.findMany({
      where: { vendorId: ctx.vendorId, status: "PAID" },
      select: { id: true, periodMonth: true, periodYear: true },
    })
    // CRIT-3 fix (this audit) — slice(3) was producing NaN for the Jan-Jun branch of every
    // fiscal year ("2025-26".slice(3) = "5-26" → "20" + "5-26" = "205-26" → NaN).
    // Now uses slice(-2) which gives the correct last-2-digit year ("2025-26".slice(-2) = "26").
    const fyStartYear = Number(cfg.incomeYear.slice(0, 4))
    const fyEndYear = Number("20" + cfg.incomeYear.slice(-2))
    const fyRuns = runs.filter((r) => {
      const y = r.periodYear, m = r.periodMonth
      return (y === fyStartYear && m >= 7) || (y === fyEndYear && m <= 6)
    })
    const entries = fyRuns.length
      ? await db.payrollEntry.findMany({ where: { runId: { in: fyRuns.map((r) => r.id) } }, select: { employeeId: true, ait: true, net: true } })
      : []

    const perEmployee = new Map<string, { deducted: number; months: number }>()
    for (const e of entries) {
      const cur = perEmployee.get(e.employeeId) || { deducted: 0, months: 0 }
      cur.deducted += e.ait || 0
      cur.months += 1
      perEmployee.set(e.employeeId, cur)
    }

    // estimated liability from the latest saved/batch calc per employee
    const emps = await db.employee.findMany({
      where: { vendorId: ctx.vendorId },
      select: { id: true, code: true, fullName: true, dob: true, taxCategory: true, taxTin: true, declaredInvestment: true },
    })
    const structures = await db.salaryStructure.findMany({ where: { employeeId: { in: emps.map((e) => e.id) }, status: "ACTIVE" }, orderBy: { effectiveFrom: "desc" } })

    const rows: any[] = []
    for (const emp of emps) {
      const st = structures.find((s) => s.employeeId === emp.id)
      if (!st) continue
      const actual = perEmployee.get(emp.id)?.deducted || 0
      const est = calculateAit(cfg, {
        taxpayerCategory: emp.taxCategory, dateOfBirth: emp.dob,
        monthlyBasicSalary: st.basic, monthlyGrossSalary: st.gross,
        declaredInvestment: emp.declaredInvestment ?? 0, tdsYtd: actual,
        netWealth: (emp as any).taxNetWealth ?? null,
        motorVehicles: (emp as any).taxMotorVehicles ?? null,
      })
      const gap = est.annualTax - actual
      rows.push({
        employeeId: emp.id, code: emp.code, name: emp.fullName, taxTin: emp.taxTin,
        category: est.categoryKey, annualTax: est.annualTax, deducted: Math.round(actual),
        gap: Math.round(gap), status: gap > 0 ? "SHORTFALL" : gap < 0 ? "SURPLUS" : "BALANCED",
        catchUpMonthsLeft: gap > 0 ? Math.max(1, 12 - (perEmployee.get(emp.id)?.months || 0)) : 0,
        monthlyTds: est.monthlyTds,
        minimumTaxEffective: est.minimumTaxEffective,
        surcharge: est.surcharge && est.surcharge.applicable ? { percent: est.surcharge.percent, amount: est.surcharge.amount } : null,
        annualLiability: est.annualLiability,
      })
    }
    // months elapsed inside the FY window (1 Jul → 30 Jun), capped at 12
    const fyStart = fyWindow(cfg.incomeYear).from
    const monthsElapsed = Math.max(0, Math.min(12,
      (new Date().getFullYear() - Number(fyStart.slice(0, 4))) * 12 + (new Date().getMonth() + 1 - Number(fyStart.slice(5, 7)))))
    const summary = {
      employees: rows.length,
      monthsElapsed,
      totalEstimated: rows.reduce((s, r) => s + r.annualTax, 0),
      totalDeducted: rows.reduce((s, r) => s + r.deducted, 0),
      totalGap: rows.reduce((s, r) => s + r.gap, 0),
      shortfall: rows.filter((r) => r.status === "SHORTFALL").length,
      surplus: rows.filter((r) => r.status === "SURPLUS").length,
    }
    await audit(ctx, "ait.reconciliation", "AitCalculationLog", null, `FY ${cfg.label} reconciliation — gap ৳${Math.round(summary.totalGap).toLocaleString("en-IN")}`)
    return { fiscalYear: cfg.label, window: win, summary, rows, disclaimer: DISCLAIMER }
  },
})

// ---------- certificates (7D) ----------

/** Month-scoped TDS certificate payload (Section 86, ITA 2023). Shared by the
 *  admin certificate dialog and the ESS self-service print. */
async function certificateData(ctx: any, employeeId: string, opts: { fiscalYearId?: string | null; month?: number; year?: number; forSelf?: boolean } = {}) {
  const forSelf = opts.forSelf === true
  const emp = forSelf
    ? await db.employee.findFirst({ where: { id: employeeId, vendorId: ctx.vendorId } })
    : await assertEmployeeVisible(ctx, employeeId)
  if (!emp) throw new Deny("Employee not found", 404)

  let cfg = await loadAitConfig(ctx.vendorId, opts.fiscalYearId || null)
  if (!cfg) {
    await ensureAitConfig(ctx.vendorId)
    cfg = await loadAitConfig(ctx.vendorId)
  }
  if (!cfg) throw new Deny(MESSAGES_NO_CONFIG, 400)
  const win = fyWindow(cfg.incomeYear)
  const month = Number(opts.month) >= 1 && Number(opts.month) <= 12 ? Number(opts.month) : new Date().getMonth() + 1
  const year = Number(opts.year) || new Date().getFullYear()

  // actual TDS from PAID payroll runs within the FY window
  const runs = await db.payrollRun.findMany({
    where: { vendorId: ctx.vendorId, status: "PAID" },
    select: { id: true, periodMonth: true, periodYear: true, paymentDate: true },
  })
  // CRIT-3 fix (this audit) — same slice(-2) fix as in ait.reconciliation above.
  const fyStartYear = Number(cfg.incomeYear.slice(0, 4))
  const fyEndYear = Number("20" + cfg.incomeYear.slice(-2))
  const fyRuns = runs.filter((r) => {
    const y = r.periodYear, m = r.periodMonth
    return (y === fyStartYear && m >= 7) || (y === fyEndYear && m <= 6)
  })
  const entries = fyRuns.length
    ? await db.payrollEntry.findMany({ where: { runId: { in: fyRuns.map((r) => r.id) }, employeeId: emp.id } })
    : []
  const tdsYtd = entries.reduce((s, e) => s + (e.ait || 0), 0)
  const thisMonthRun = runs.find((r) => r.periodMonth === month && r.periodYear === year)
  const thisMonthEntry = thisMonthRun
    ? await db.payrollEntry.findFirst({ where: { runId: thisMonthRun.id, employeeId: emp.id } })
    : null
  const tdsThisMonth = thisMonthEntry?.ait ?? null // null = no payroll yet → estimate shown

  // estimated liability (uses the employee master + active structure)
  const st = await db.salaryStructure.findFirst({ where: { employeeId: emp.id, status: "ACTIVE" }, orderBy: { effectiveFrom: "desc" } })
  const { monthsRemaining } = await fyActuals(ctx.vendorId, cfg, emp.id).catch(() => ({ monthsRemaining: 12 }))
  const est = calculateAit(cfg, {
    taxpayerCategory: emp.taxCategory, dateOfBirth: emp.dob,
    monthlyBasicSalary: st?.basic ?? 0, monthlyGrossSalary: st?.gross ?? 0,
    declaredInvestment: emp.declaredInvestment ?? 0, tdsYtd,
    monthsRemainingInFy: monthsRemaining,
    netWealth: (emp as any).taxNetWealth ?? null,
    motorVehicles: (emp as any).taxMotorVehicles ?? null,
  })

  const { getSettings } = await import("../settings")
  const settings = await getSettings(ctx.vendorId)
  const g: any = settings.general || {}
  const desig = emp.designationId ? await db.designation.findUnique({ where: { id: emp.designationId } }) : null
  const money = (n: number) => `৳ ${Math.round(n).toLocaleString("en-IN")}`

  const bonusLabel = est.festivalBonusBasis === "FIXED"
    ? "Festival bonus (fixed amount)"
    : est.festivalBonusBasis === "GROSS"
      ? `Festival bonus (${est.festivalBonusMonths} × monthly gross)`
      : `Festival bonus (${est.festivalBonusMonths} × monthly basic)`

  // step-by-step lines — every figure carries its legal reference
  const lines: { label: string; ref?: string; value: number; display?: string }[] = [
    { label: "Monthly gross salary", ref: "Sec 86 — monthly average basis", value: est.monthlyGross, display: money(est.monthlyGross) },
    { label: bonusLabel, ref: "Sec 86", value: est.festivalBonusAmount, display: money(est.festivalBonusAmount) },
    { label: "Annual gross income", value: est.annualGross, display: money(est.annualGross) },
    { label: "Salary exemption (one-third, capped)", ref: "Third Schedule", value: est.exemption, display: money(est.exemption) },
    { label: "Taxable income", value: est.taxableIncome, display: money(est.taxableIncome) },
    { label: `Tax threshold — ${est.categoryLabel}`, ref: est.categoryAssumed ? "category assumed — verify" : undefined, value: est.threshold, display: money(est.threshold) },
    { label: "Income above threshold", value: est.incomeAboveThreshold, display: money(est.incomeAboveThreshold) },
    { label: "Slab tax (annual Finance Act slabs)", value: est.slabTax, display: money(est.slabTax) },
  ]
  if (est.rebateApplied) {
    lines.push({ label: `Investment rebate — lower of 3% of taxable income / ${cfg.rebateRatePercent}% of eligible investment / ৳${money(cfg.rebateCapAmount)}`, ref: "Sec 78, ITA 2023", value: -est.rebateAmount, display: `− ${money(est.rebateAmount)}` })
  }
  lines.push({ label: "Estimated annual tax (withholding basis)", value: est.annualTax, display: money(est.annualTax) })
  if (est.minimumTaxEffective > est.annualTax) {
    lines.push({ label: `Minimum-tax floor (${cfg.newTaxpayerMinimumTax ? `৳${money(cfg.minimumTax)} / first-time filers ৳${money(cfg.newTaxpayerMinimumTax)}` : `৳${money(cfg.minimumTax)}`})`, ref: "annual Finance Act; §163 framework", value: est.minimumTaxEffective, display: money(est.minimumTaxEffective) })
  }
  if (est.surcharge && est.surcharge.applicable) {
    lines.push({ label: `Surcharge (${est.surcharge.percent}% of the tax amount)`, ref: "FO 2025 / FA 2026 net-wealth bands", value: est.surcharge.amount, display: money(est.surcharge.amount) })
    lines.push({ label: "Annual liability incl. surcharge", value: est.annualLiability, display: money(est.annualLiability) })
  }
  lines.push({ label: "Average rate", value: est.averageRatePercent, display: `${est.averageRatePercent.toFixed(4)}%` })
  lines.push({ label: "Monthly TDS (this month's gross × average rate)", ref: "Sec 86(1)", value: est.monthlyTds, display: money(est.monthlyTds) })
  if (est.monthlyTdsCatchUp != null) {
    lines.push({ label: "Adjusted monthly TDS (§86(4) surplus/deficit catch-up)", ref: "Sec 86(4)", value: est.monthlyTdsCatchUp, display: money(est.monthlyTdsCatchUp) })
  }

  return {
    company: {
      name: g.companyName || "—", address: g.address || "", phone: g.phone || "", email: g.email || "",
      binVatReg: g.binVatReg || "", tin: g.binVatReg || "",
      signatoryName: g.signatoryName || "Authorized Signatory", signatoryDesignation: g.signatoryDesignation || "",
    },
    employee: { id: emp.id, code: emp.code, name: emp.fullName, designation: desig?.name || "", tin: emp.taxTin || "", mobile: emp.mobile || "", dob: emp.dob },
    fiscalYear: { label: cfg.label, incomeYear: cfg.incomeYear, assessmentYear: cfg.assessmentYear, tdsSectionRef: cfg.tdsSectionRef },
    period: { month, year },
    window: win,
    result: { lines, slabLines: est.slabLines, annualTax: est.annualTax, monthlyTds: est.monthlyTds, monthlyTdsCatchUp: est.monthlyTdsCatchUp, averageRatePercent: est.averageRatePercent, minimumTaxEffective: est.minimumTaxEffective, surcharge: est.surcharge, annualLiability: est.annualLiability, warnings: est.warnings },
    tdsThisMonth: tdsThisMonth == null ? est.monthlyTds : Math.round(tdsThisMonth),
    tdsThisMonthIsEstimate: tdsThisMonth == null,
    tdsYtd: Math.round(tdsYtd),
    monthsCovered: entries.length,
    income: { annualGross: est.annualGross, exemption: est.exemption, taxable: est.taxableIncome },
    tax: { estimatedAnnual: est.annualTax, deducted: Math.round(tdsYtd), months: entries.length, averageRatePercent: est.averageRatePercent, slabLines: est.slabLines },
    signatory: { name: g.signatoryName || "", designation: g.signatoryDesignation || "" },
    disclaimer: DISCLAIMER,
    generatedAt: new Date().toISOString(),
  }
}

route("ait.certificate", {
  perm: AIT_ADMIN,
  handler: async (ctx, p) => certificateData(ctx, p?.employeeId, { fiscalYearId: p?.fiscalYearId || null, month: p?.month, year: p?.year }),
})

/** Employee self-service: the caller's OWN certificate (ESS portal). */
  // INTENTIONALLY_SELF_SCOPED (M-02): returns only the caller's own AIT certificates (handler filters by ctx.employeeId)
route("ait.myCertificates", {
  handler: async (ctx) => {
    if (!ctx.employeeId) throw new Deny("No employee record is linked to this account", 403)
    const emp = await db.employee.findFirst({ where: { id: ctx.employeeId, vendorId: ctx.vendorId } })
    if (!emp) throw new Deny("Employee not found", 404)

    const years = await db.aitFiscalYear.findMany({ where: { vendorId: ctx.vendorId }, orderBy: { createdAt: "asc" } })
    // ensure at least one is active so certificates can be computed
    if (years.length === 0) {
      await ensureAitConfig(ctx.vendorId)
      years.push(...(await db.aitFiscalYear.findMany({ where: { vendorId: ctx.vendorId } })))
    }

    // TDS months per income-year window from PAID payroll runs
    const runs = await db.payrollRun.findMany({ where: { vendorId: ctx.vendorId, status: "PAID" }, select: { id: true, periodMonth: true, periodYear: true } })
    const entryAgg = ctx.employeeId
      ? await db.payrollEntry.findMany({ where: { employeeId: ctx.employeeId, runId: { in: runs.map((r) => r.id) } }, select: { runId: true, ait: true } })
      : []
    const runById = new Map(runs.map((r) => [r.id, r]))
    const tdsByYear = new Map<string, { total: number; months: number }>()
    for (const e of entryAgg) {
      const r = runById.get(e.runId)
      if (!r) continue
      const iy = r.periodMonth >= 7 ? `${r.periodYear}-${String((r.periodYear + 1) % 100).padStart(2, "0")}` : `${r.periodYear - 1}-${String(r.periodYear % 100).padStart(2, "0")}`
      const cur = tdsByYear.get(iy) || { total: 0, months: 0 }
      cur.total += e.ait || 0
      cur.months += 1
      tdsByYear.set(iy, cur)
    }

    const st = await db.salaryStructure.findFirst({ where: { employeeId: emp.id, status: "ACTIVE" }, orderBy: { effectiveFrom: "desc" } })
    const out: any[] = []
    for (const fy of years) {
      const cfg = await loadAitConfig(ctx.vendorId, fy.id)
      if (!cfg) continue
      const est = calculateAit(cfg, {
        taxpayerCategory: emp.taxCategory, dateOfBirth: emp.dob,
        monthlyBasicSalary: st?.basic ?? 0, monthlyGrossSalary: st?.gross ?? 0,
        declaredInvestment: emp.declaredInvestment ?? 0, tdsYtd: tdsByYear.get(cfg.incomeYear)?.total ?? 0,
        netWealth: (emp as any).taxNetWealth ?? null,
        motorVehicles: (emp as any).taxMotorVehicles ?? null,
      })
      const tds = tdsByYear.get(cfg.incomeYear) || { total: 0, months: 0 }
      out.push({
        fiscalYearId: fy.id, label: cfg.label, incomeYear: cfg.incomeYear, assessmentYear: cfg.assessmentYear,
        active: fy.active, tdsDeducted: Math.round(tds.total), monthsCovered: tds.months,
        estimatedAnnualTax: est.annualTax, averageRatePercent: est.averageRatePercent,
        monthlyTds: est.monthlyTds, taxableIncome: est.taxableIncome, annualGross: est.annualGross,
        warnings: est.warnings, categoryLabel: est.categoryLabel, available: true,
      })
    }
    return { certificates: out, disclaimer: DISCLAIMER }
  },
})

/** Employee self-service: full certificate payload for one fiscal year (own record only). */
route("ait.myCertificate.print", {
  handler: async (ctx, p) => {
    if (!ctx.employeeId) throw new Deny("No employee record is linked to this account", 403)
    return certificateData(ctx, ctx.employeeId, { fiscalYearId: p?.fiscalYearId || null, month: p?.month, year: p?.year, forSelf: true })
  },
})

// ---------- audit log (7F) ----------

route("ait.logs.list", {
  perm: AIT_ADMIN,
  handler: async (ctx, p) => {
    const where: any = { vendorId: ctx.vendorId }
    if (p?.kind) where.kind = p.kind
    if (p?.employeeId) where.employeeId = p.employeeId
    const take = Math.min(200, Number(p?.take) || 50)
    const list = await db.aitCalculationLog.findMany({ where, orderBy: { createdAt: "desc" }, take })
    return list.map((l) => ({
      id: l.id, createdAt: l.createdAt, kind: l.kind,
      employeeName: l.employeeName || "—", employeeCode: l.employeeCode,
      operatorName: l.operatorName, runId: l.runId,
      summary: (() => {
        try {
          const o = JSON.parse(l.outputJson || "{}")
          return { annualTax: o.annualTax, monthlyTds: o.monthlyTds, taxableIncome: o.taxableIncome, annualGross: o.annualGross }
        } catch { return {} }
      })(),
      warnings: (() => { try { return JSON.parse(l.warningsJson || "[]") } catch { return [] } })(),
    }))
  },
})

// ---------- shared constants ----------
const MESSAGES_NO_CONFIG = "No active fiscal-year configuration — activate one under AIT → Fiscal Year Config first."
const DISCLAIMER = {
  en: "This calculation is an estimate of monthly tax deducted at source (AIT/TDS) under Section 86 of the Income Tax Act 2023 (average-rate method with the sub-section (4) cumulative adjustment). It is not a tax return — final liability is determined by the NBR return u/s 166. The Section 78 investment rebate is deducted from the annual tax when declared; the minimum-tax floor and the net-wealth surcharge are shown as separate annual items and are not added to monthly withholding.",
  bn: "এই হিসাবটি আয়কর আইন ২০২৩-এর ধারা ৮৬ অনুযায়ী মাসিক উৎসে কর কর্তনের (AIT/TDS) একটি প্রাক্কলন। এটি কর রিটার্ন নয় — চূড়ান্ত দায় ধারা ১৬৬-এর অধীনে NBR রিটার্নে নির্ধারিত হয়। ঘোষিত বিনিয়োগের ক্ষেত্রে ধারা ৭৮ রেয়াত বার্ষিক কর থেকে বাদ দেওয়া হয়; ন্যূনতম কর ও সারচার্জ বার্ষিক হিসাবরূপে পৃথক দেখানো হয় এবং মাসিক কর্তনে যোগ করা হয় না।",
}

// helper for the legacy alias
async function getRouteHandler(action: string) {
  const { getRoute } = await import("./registry")
  const def = getRoute(action)
  if (!def) throw new Deny("Unknown action", 404)
  return def.handler as (ctx: any, p: any, req?: any) => Promise<unknown>
}

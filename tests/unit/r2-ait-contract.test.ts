/// <reference types="bun-types" />
// ============ R2 regression: AIT module contract fixes ============
// Audit (2026-10-12): the AIT backend engine was correct, but the UI/server
// contracts were broken end-to-end:
//   (a) CategoriesDialog sent {code} but ait.categories.save read {key} →
//       EVERY category save 400'd ("Every category needs a key");
//   (b) FiscalYearDialog sent rebateRate/investmentCapFraction/investmentCapAmount
//       but the route read rebateRatePercent/rebateCapFraction/rebateCapAmount →
//       every FY edit silently ZEROED the Sec 78 rebate config;
//   (c) ait.calc.save ignored the calculator's echoed input (recomputed from
//       employee defaults) and the view never sent employeeId → 400;
//   (d) ait.employee.profile returned a flat payload the view read nested →
//       prefill was always empty;
//   (e) duplicate `ait.preview` registration (routes/payroll.ts) overwrote the
//       real route (later-import wins in the plain registry object).
//
// Fixes under test, all through POST /api/hrm:
//   - categories.save accepts key OR code;
//   - fiscalYears.save round-trips the Sec 78 fields correctly;
//   - calc.save accepts {employeeId, input, result} and recomputes;
//   - employee.profile returns previousEmployerIncome + tdsYtd;
//   - payroll computeAit honors the employee tax profile (category threshold).
import "./_testdb"
import { describe, test, expect, beforeAll } from "bun:test"
import { db } from "@/lib/db"
import { mkVendor, mkUser, mkEmployee, mkSession, uniq } from "./_fixtures"
import { postHrm } from "./_hrm-endpoint"

let vendor: { id: string }
let admin: { id: string; token: string }
let fyId: string

beforeAll(async () => {
  vendor = await mkVendor("R2 AIT Vendor")
  const u = await mkUser(vendor.id, { role: "HR_ADMIN", name: "R2 Admin" })
  admin = { id: u.id, token: await mkSession(u.id, "FULL") }
})

describe("R2 — AIT module contract fixes", () => {
  test("fiscal year create/save round-trips Sec 78 rebate fields", async () => {
    const created = await postHrm("ait.fiscalYears.save", {
      label: "FY 2026-27", incomeYear: "2026-27", assessmentYear: "2027-28",
      rebateRatePercent: 15, rebateCapFraction: 0.25, rebateCapAmount: 10_000_000,
      exemptionFraction: 0.3333, exemptionCap: 500_000, minimumTax: 5_000, festivalBonusCount: 2,
    }, { bearer: admin.token })
    expect(created.body.ok).toBe(true)
    fyId = created.body.data.id
    const act = await postHrm("ait.fiscalYears.activate", { id: fyId }, { bearer: admin.token })
    expect(act.body.ok).toBe(true)
    const row = await db.aitFiscalYear.findUnique({ where: { id: fyId } })
    expect(Number(row?.rebateRatePercent)).toBe(15) // previously 0 (wrong field name)
    expect(Number(row?.rebateCapAmount)).toBe(10_000_000) // previously 0
    expect(Number(row?.rebateCapFraction)).toBe(0.25)
  })

  test("categories.save accepts the UI's `code` field (and `key`)", async () => {
    const res = await postHrm("ait.categories.save", {
      fiscalYearId: fyId,
      categories: [
        { code: "general", label: "General", threshold: 400_000, sortOrder: 1 },
        { key: "female", label: "Female", threshold: 425_000, sortOrder: 2 },
      ],
    }, { bearer: admin.token })
    expect(res.body.ok).toBe(true) // previously: 400 "Every category needs a key"
    const rows = await db.aitTaxpayerCategory.findMany({ where: { fiscalYearId: fyId } })
    expect(rows.map((r) => r.key).sort()).toEqual(["female", "general"])
  })

  test("employee profile returns flat fields incl. previousEmployerIncome and tdsYtd", async () => {
    const emp = await mkEmployee(vendor.id, { fullName: "R2 Emp", code: uniq("R2") })
    await db.employee.update({
      where: { id: emp.id },
      data: { taxCategory: "female", taxAlreadyDeducted: 12_000, previousEmployerIncome: 50_000, declaredInvestment: 100_000, dob: "1990-05-10" } as any,
    })
    const res = await postHrm("ait.employee.profile", { employeeId: emp.id }, { bearer: admin.token })
    expect(res.body.ok).toBe(true)
    const p = res.body.data
    expect(p.taxpayerCategory).toBe("female")
    expect(Number(p.tdsYtd)).toBe(12_000)
    expect(Number(p.previousEmployerIncome)).toBe(50_000)
    expect(Number(p.declaredInvestment)).toBe(100_000)
    expect(p.dateOfBirth).toBe("1990-05-10")
  })

  test("calc.save honors the calculator's echoed input and records the journal", async () => {
    const emp = await mkEmployee(vendor.id, { fullName: "R2 Calc Emp", code: uniq("R2C") })
    const input = {
      taxpayerCategory: "general", monthlyBasicSalary: 30_000, monthlyGrossSalary: 43_000,
      currentMonthGross: 43_000, declaredInvestment: 100_000, tdsYtd: 0, annualGrossOverride: null,
      festivalBonusOverride: null, previousEmployerIncome: 0, dateOfBirth: null,
    }
    const res = await postHrm("ait.calc.save", { employeeId: emp.id, input }, { bearer: admin.token })
    expect(res.body.ok).toBe(true) // previously: 400 "employeeId is required"
    // the journal row carries the echoed input's gross
    const log = await db.aitCalculationLog.findFirst({ where: { vendorId: vendor.id, employeeId: emp.id, kind: "SAVE" } })
    expect(log).toBeTruthy()
    const inputs = JSON.parse(log?.inputsJson || "{}")
    expect(Number(inputs.monthlyGrossSalary)).toBe(43_000)
  })

  test("payroll computeAit honors the employee taxpayer category (senior threshold)", async () => {
    const { computeAit, ensureAitConfig, loadAitConfig } = await import("@/hrm-server/ait")
    await ensureAitConfig(vendor.id)
    const cfg = await loadAitConfig(vendor.id)
    expect(cfg).toBeTruthy()
    // complete the FY config: slabs + a senior category (test 1 created the
    // year, test 2 seeded general/female categories)
    await postHrm("ait.slabs.save", {
      fiscalYearId: fyId,
      slabs: [
        { slabLabel: "First 3,00,000", upperLimit: 300_000, ratePercent: 10 },
        { slabLabel: "Next 4,00,000", upperLimit: 400_000, ratePercent: 15 },
        { slabLabel: "Next 5,00,000", upperLimit: 500_000, ratePercent: 20 },
        { slabLabel: "Next 20,00,000", upperLimit: 2_000_000, ratePercent: 25 },
        { slabLabel: "Balance", upperLimit: null, ratePercent: 30 },
      ],
    }, { bearer: admin.token })
    await postHrm("ait.categories.save", {
      fiscalYearId: fyId,
      categories: [
        { code: "general", label: "General", threshold: 400_000 },
        { code: "female", label: "Female", threshold: 425_000 },
        { code: "senior", label: "Senior (65+)", threshold: 425_000 },
      ],
    }, { bearer: admin.token })

    // reload the config AFTER completing slabs/categories
    const cfg2 = await loadAitConfig(vendor.id)
    expect(cfg2?.slabs?.length ?? 0).toBeGreaterThan(0)

    // senior threshold (≥65 or category senior) is HIGHER than general → lower tax
    const general = await computeAit({
      vendorId: vendor.id, monthlyTaxableIncome: 60_000, previousEmployerIncome: 0, previousTaxDeducted: 0,
      config: cfg2, employeeProfile: { taxpayerCategory: "general", dateOfBirth: null, declaredInvestment: 0, monthlyBasicSalary: 30_000 },
    })
    const senior = await computeAit({
      vendorId: vendor.id, monthlyTaxableIncome: 60_000, previousEmployerIncome: 0, previousTaxDeducted: 0,
      config: cfg2, employeeProfile: { taxpayerCategory: "senior", dateOfBirth: "1950-01-01", declaredInvestment: 0, monthlyBasicSalary: 30_000 },
    })
    expect(senior.annualTax).toBeLessThan(general.annualTax) // threshold relief applied
    // declared investment reduces tax via the Sec 78 rebate
    const withRebate = await computeAit({
      vendorId: vendor.id, monthlyTaxableIncome: 60_000, previousEmployerIncome: 0, previousTaxDeducted: 0,
      config: cfg2, employeeProfile: { taxpayerCategory: "general", dateOfBirth: null, declaredInvestment: 300_000, monthlyBasicSalary: 30_000 },
    })
    expect(withRebate.annualTax).toBeLessThan(general.annualTax)
  })
})

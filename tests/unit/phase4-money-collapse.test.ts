/// <reference types="bun-types" />
// ============ Phase 4 — the FIN-082 money storage collapse ============
// Paisa becomes the single AUTHORITATIVE money representation; the Float
// columns demote to a derived display cache. Pinned here:
//   1. withAuthoritativeMoney — the shared READ boundary (pure logic);
//   2. reconcileFloatPaisa v2 — drift is DETECTED (owner alert) and the
//      Float cache REPAIRED from paisa; NULL shadows are BACKFILLED;
//   3. the payslip document derives its money from paisa (a drifted Float
//      net can never reach an employee-facing document);
//   4. payroll.entries serves paisa-authoritative rows and paisa-exact
//      KPI-strip sums;
//   5. the workforce dashboard's payroll.cost sums the paisa columns (with
//      the pre-backfill Float fallback for legacy rows).
import "./_testdb"
import { describe, test, expect } from "bun:test"
import { db } from "@/lib/db"
import { mkVendor, mkUser, mkEmployee, mkSession, uniq, defaultCompanyId } from "./_fixtures"
import { postHrm } from "./_hrm-endpoint"
import {
  withAuthoritativeMoney, ENTRY_MONEY_FIELDS, RUN_MONEY_FIELDS, structurePaisa,
} from "@/hrm-server/money"
import { reconcileFloatPaisa } from "@/hrm-server/jobs"
import { buildPayslipHtml } from "@/hrm-server/payslip"

describe("Phase 4 — withAuthoritativeMoney (the read boundary)", () => {
  test("a drifted pair is re-derived from paisa; clean rows keep identity; NULL shadows keep the Float value", () => {
    const clean = { gross: 20000, grossPaisa: 2000000n, net: 18000, netPaisa: 1800000n, status: "INCLUDED" }
    expect(withAuthoritativeMoney(clean as any, ENTRY_MONEY_FIELDS)).toBe(clean) // no copy for clean rows

    const drifted = { gross: 20000, grossPaisa: 2000000n, net: 18000, netPaisa: 1900000n, status: "INCLUDED" }
    const fixed: any = withAuthoritativeMoney(drifted as any, ENTRY_MONEY_FIELDS)
    expect(fixed).not.toBe(drifted) // shallow copy — the DB row object is never mutated
    expect(fixed.net).toBe(19000) // paisa wins
    expect(fixed.gross).toBe(20000) // consistent field untouched
    expect(fixed.status).toBe("INCLUDED") // non-money field untouched

    const legacy = { gross: 15000 } // NULL paisa (pre-backfill shape) — Float survives
    expect((withAuthoritativeMoney(legacy as any, ENTRY_MONEY_FIELDS) as any).gross).toBe(15000)

    // number-typed paisa (hand-built rows) works like bigint
    const numeric = { net: 1, netPaisa: 1900000 }
    expect((withAuthoritativeMoney(numeric as any, ["net"]) as any).net).toBe(19000)
  })

  test("structurePaisa + withAuthoritativeMoney round-trip is a no-op on engine-shaped rows", () => {
    const comps = { basic: 12345.67, houseRent: 5000, gross: 17345.67 }
    const row = { ...comps, ...structurePaisa(comps) }
    const out: any = withAuthoritativeMoney(row as any, [...ENTRY_MONEY_FIELDS, "basic", "houseRent"])
    expect(out.basic).toBe(12345.67)
    expect(out.gross).toBe(17345.67)
  })
})

describe("Phase 4 — reconcileFloatPaisa v2 (the invariant enforcer)", () => {
  test("a drifted pair is repaired FROM paisa (Float := takaOf(paisa)) and the owner is alerted", async () => {
    const v = await mkVendor(uniq("p4rep"))
    const owner = await mkUser(v.id, { role: "VENDOR_OWNER" })
    const emp = await mkEmployee(v.id, { fullName: "P4 Repair Subject" })
    // one-sided Float edit: float 20000 vs paisa 25000
    await db.salaryStructure.create({
      data: { vendorId: v.id, employeeId: emp.id, effectiveFrom: "2026-01-01", status: "ACTIVE", basic: 20000, gross: 20000, basicPaisa: 2500000n, grossPaisa: 2000000n },
    })
    const run = await db.payrollRun.create({
      data: { companyId: await defaultCompanyId(v.id), vendorId: v.id, periodMonth: 8, periodYear: 2026, periodWeek: 0, frequency: "MONTHLY", runType: "REGULAR", status: "CALCULATED", createdBy: owner.id, totalGross: 20000, totalGrossPaisa: 2000000n, totalNet: 18000, totalNetPaisa: 1900000n },
    })
    await db.payrollEntry.create({
      data: { vendorId: v.id, runId: run.id, employeeId: emp.id, gross: 20000, grossPaisa: 2000000n, net: 18000, netPaisa: 1900000n, breakdownJson: "{}" },
    })

    const out = await reconcileFloatPaisa(v.id)
    // detection happened (the full incident record)…
    const fields = out.drifts.map((d) => `${d.table}.${d.field}`)
    expect(fields).toContain("SalaryStructure.basic")
    expect(fields).toContain("PayrollEntry.net")
    expect(fields).toContain("PayrollRun.totalNet")
    // …and the repair was executed: Float now equals paisa/100 on every row
    expect(out.repaired).toBe(3)
    // the same pass also COMPLETES the zero-default Float fields' missing
    // shadows (Float @default(0), paisa NULL): 8 structure + 10 entry + 4 run
    // totals = 22 fields backfilled with their 0-paisa shadow.
    expect(out.backfilled).toBe(22)
    const s = await db.salaryStructure.findFirst({ where: { vendorId: v.id } })
    expect(s?.basic).toBe(25000) // PAISA WINS — the rogue Float edit was reverted
    const e = await db.payrollEntry.findFirst({ where: { vendorId: v.id } })
    expect(e?.net).toBe(19000)
    const r = await db.payrollRun.findFirst({ where: { vendorId: v.id } })
    expect(r?.totalNet).toBe(19000)
    // the owner alert says the repair happened
    const note = await db.notification.findFirst({ where: { vendorId: v.id, title: { contains: "drift" } } })
    expect(note).not.toBeNull()
    expect(String(note!.message)).toContain("SalaryStructure.basic")
    expect(String(note!.message)).toContain("integer-paisa")
    expect(String(note!.message)).toContain("REPAIRED")

    // a second pass finds nothing left to do (idempotent convergence)
    const out2 = await reconcileFloatPaisa(v.id)
    expect(out2.drifts).toEqual([])
    expect(out2.repaired).toBe(0)
    expect(out2.backfilled).toBe(0)
  })

  test("a NULL paisa shadow is backfilled from the Float value (self-heal)", async () => {
    const v = await mkVendor(uniq("p4bf"))
    const emp = await mkEmployee(v.id, { fullName: "P4 Backfill Subject" })
    await db.salaryStructure.create({
      data: { vendorId: v.id, employeeId: emp.id, effectiveFrom: "2026-01-01", status: "ACTIVE", basic: 15000, gross: 15000 },
    })
    const out = await reconcileFloatPaisa(v.id)
    expect(out.drifts).toEqual([])
    expect(out.nullPaisa).toBe(10) // counted at scan time (legacy-shape row)
    // 2 live Floats (basic+gross) + 8 zero-default Float fields — every
    // missing shadow of the row is completed in one pass.
    expect(out.backfilled).toBe(10)
    const s = await db.salaryStructure.findFirst({ where: { vendorId: v.id } })
    expect(s?.basicPaisa).toBe(1500000n)
    expect(s?.grossPaisa).toBe(1500000n)
  })

  test("a clean vendor reports zero drifts and zero repairs (and completes the zero-default shadows once)", async () => {
    const v = await mkVendor(uniq("p4clean"))
    const emp = await mkEmployee(v.id, { fullName: "P4 Clean Subject" })
    await db.salaryStructure.create({
      data: { vendorId: v.id, employeeId: emp.id, effectiveFrom: "2026-01-01", status: "ACTIVE", basic: 20000, gross: 20000, basicPaisa: 2000000n, grossPaisa: 2000000n },
    })
    const out = await reconcileFloatPaisa(v.id)
    expect(out.drifts).toEqual([])
    expect(out.repaired).toBe(0)
    // the 8 zero-default Float fields (houseRent…otherAllowance) get their
    // 0-paisa shadows completed — the pass CONVERGES, so the second run
    // finds nothing left to write.
    expect(out.backfilled).toBe(8)
    const out2 = await reconcileFloatPaisa(v.id)
    expect(out2.drifts).toEqual([])
    expect(out2.repaired).toBe(0)
    expect(out2.backfilled).toBe(0)
  })
})

describe("Phase 4 — paisa-authoritative reads at the surfaces", () => {
  test("the payslip HTML derives NET from paisa (a drifted Float net never prints)", async () => {
    const v = await mkVendor(uniq("p4slip"))
    const emp = await mkEmployee(v.id, { fullName: "P4 Payslip Subject" })
    const run = await db.payrollRun.create({
      data: { companyId: await defaultCompanyId(v.id), vendorId: v.id, periodMonth: 9, periodYear: 2026, periodWeek: 0, frequency: "MONTHLY", runType: "REGULAR", status: "PAID", createdBy: null, paymentDate: "2026-10-01" },
    })
    // drifted Float net (18000) vs paisa net (19000) — what the engine wrote is paisa
    const entry = await db.payrollEntry.create({
      data: {
        vendorId: v.id, runId: run.id, employeeId: emp.id,
        gross: 20000, grossPaisa: 2000000n, net: 18000, netPaisa: 1900000n,
        breakdownJson: JSON.stringify({ earnings: [{ label: "Basic", amount: 20000 }], deductions: [] }),
        payslipNumber: `PS-P4-${uniq("x").slice(-6)}`, status: "INCLUDED",
      },
    })
    const html = await buildPayslipHtml(v.id, entry.id)
    expect(html).toBeTruthy()
    expect(html!).toContain("19,000") // paisa-authoritative NET SALARY PAYABLE
    expect(html!).not.toContain("18,000") // the drifted Float cache never prints
  })

  test("payroll.entries serves paisa-authoritative rows and paisa-exact KPI sums", async () => {
    const v = await mkVendor(uniq("p4grid"))
    const u = await mkUser(v.id, { role: "VENDOR_OWNER", name: "P4 Grid Owner" })
    const token = await mkSession(u.id, "FULL")
    const emp = await mkEmployee(v.id, { fullName: "P4 Grid Subject" })
    const run = await db.payrollRun.create({
      data: { companyId: await defaultCompanyId(v.id), vendorId: v.id, periodMonth: 7, periodYear: 2026, periodWeek: 0, frequency: "MONTHLY", runType: "REGULAR", status: "CALCULATED", createdBy: u.id, totalNet: 18000, totalNetPaisa: 1900000n },
    })
    await db.payrollEntry.create({
      data: {
        vendorId: v.id, runId: run.id, employeeId: emp.id,
        gross: 20000, grossPaisa: 2000000n, net: 18000, netPaisa: 1900000n,
        loanDeduction: 3000.505, loanDeductionPaisa: 300050n, // the paisa-exact sum target
        breakdownJson: "{}",
      },
    })
    const r = await postHrm("payroll.entries", { runId: run.id, page: 1, pageSize: 50 }, { bearer: token })
    expect(r.status).toBe(200)
    expect(r.body.data.items.length).toBe(1)
    expect(r.body.data.items[0].net).toBe(19000) // paisa-authoritative row
    expect(r.body.data.run.totalNet).toBe(19000) // paisa-authoritative envelope
    // KPI strip sums the PAISA columns exactly (300050n → 3000.5), never doubles
    expect(r.body.data.summary.loanRecovery).toBe(3000.5)
  })

  test("workforce.dashboard payroll.cost sums the paisa columns (Float fallback only for NULL shadows)", async () => {
    const v = await mkVendor(uniq("p4cost"))
    const u = await mkUser(v.id, { role: "VENDOR_OWNER", name: "P4 Cost Owner" })
    const token = await mkSession(u.id, "FULL")
    // one drifted run (paisa 2500000 = ৳25000) + one legacy NULL-paisa run (৳10000)
    await db.payrollRun.create({
      data: { companyId: await defaultCompanyId(v.id), vendorId: v.id, periodMonth: 9, periodYear: 2026, periodWeek: 0, frequency: "MONTHLY", runType: "REGULAR", status: "PAID", createdBy: u.id, paymentDate: "2026-10-05", totalGross: 20000, totalGrossPaisa: 2500000n, totalOt: 0, totalOtPaisa: 0n },
    })
    await db.payrollRun.create({
      data: { companyId: await defaultCompanyId(v.id), vendorId: v.id, periodMonth: 8, periodYear: 2026, periodWeek: 0, frequency: "MONTHLY", runType: "REGULAR", status: "PAID", createdBy: u.id, paymentDate: "2026-09-05", totalGross: 10000, totalOt: 0 },
    })
    const r = await postHrm("analytics.report.render", { reportId: "workforce.dashboard", from: "2026-07-01", to: "2026-11-01" }, { bearer: token })
    expect(r.status).toBe(200)
    const kpiByKey = Object.fromEntries(r.body.data.kpis.map((k: any) => [k.key, k]))
    expect(kpiByKey["payroll.cost"].value).toBe(35000) // 25000 (paisa) + 10000 (legacy Float fallback)
  })
})

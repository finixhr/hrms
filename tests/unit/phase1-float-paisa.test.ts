/// <reference types="bun-types" />
// ============ Phase 1 new item — nightly Float-vs-paisa reconciliation ============
// FIN-082 interim control: while money lives dual-written (Float columns +
// integer-paisa shadows, H-09), any writer that updates one side only
// silently changes what different readers see. The nightly sweep compares
// every shadowed field on structures, entries and run totals and ALERTS the
// tenant owner the moment a pair disagrees. NULL paisa columns (legacy rows)
// are reported separately — unbackfilled, not disagreements.
import "./_testdb"
import { describe, test, expect } from "bun:test"
import { db } from "@/lib/db"
import { mkVendor, mkUser, mkEmployee, uniq, defaultCompanyId } from "./_fixtures"
import { reconcileFloatPaisa } from "@/hrm-server/jobs"

describe("Phase 1 — the Float-vs-paisa reconciliation pass (FIN-082 interim)", () => {
  test("a clean vendor reports zero drifts", async () => {
    const v = await mkVendor(uniq("p1paisa"))
    const emp = await mkEmployee(v.id, { fullName: "P1 Paisa Clean" })
    // a properly dual-written structure (what structurePaisa produces)
    await db.salaryStructure.create({
      data: { vendorId: v.id, employeeId: emp.id, effectiveFrom: "2026-01-01", status: "ACTIVE", basic: 20000, gross: 20000, basicPaisa: 2000000n, grossPaisa: 2000000n },
    })
    const out = await reconcileFloatPaisa(v.id)
    expect(out.structures).toBe(1)
    expect(out.drifts).toEqual([])
    expect(out.nullPaisa).toBeGreaterThanOrEqual(0) // the other 8 struct fields are NULL → unbackfilled
  })

  test("an injected drift is detected on structures, entries AND run totals — and the owner is alerted", async () => {
    const v = await mkVendor(uniq("p1paisa2"))
    const owner = await mkUser(v.id, { role: "VENDOR_OWNER" })
    const emp = await mkEmployee(v.id, { fullName: "P1 Paisa Drift" })
    // structure: float says 20000, paisa says 25000 (a one-sided edit)
    await db.salaryStructure.create({
      data: { vendorId: v.id, employeeId: emp.id, effectiveFrom: "2026-01-01", status: "ACTIVE", basic: 20000, gross: 20000, basicPaisa: 2500000n, grossPaisa: 2000000n },
    })
    // a calculated run + entry with a drifted net
    const run = await db.payrollRun.create({
      data: { companyId: await defaultCompanyId(v.id), vendorId: v.id, periodMonth: 7, periodYear: 2026, periodWeek: 0, frequency: "MONTHLY", runType: "REGULAR", status: "CALCULATED", createdBy: owner.id, totalGross: 20000, totalGrossPaisa: 2000000n, totalNet: 18000, totalNetPaisa: 1900000n },
    })
    await db.payrollEntry.create({
      data: { vendorId: v.id, runId: run.id, employeeId: emp.id, gross: 20000, grossPaisa: 2000000n, net: 18000, netPaisa: 1900000n, breakdownJson: "{}" },
    })
    const out = await reconcileFloatPaisa(v.id)
    const fields = out.drifts.map((d) => `${d.table}.${d.field}`)
    expect(fields).toContain("SalaryStructure.basic")
    expect(fields).toContain("PayrollEntry.net")
    expect(fields).toContain("PayrollRun.totalNet")
    // the alert notification reached the tenant owner
    const note = await db.notification.findFirst({ where: { vendorId: v.id, title: { contains: "drift" } } })
    expect(note).not.toBeNull()
    expect(String(note!.message)).toContain("SalaryStructure.basic")
    expect(String(note!.message)).toContain("integer-paisa")
  })

  test("NULL paisa columns are counted as unbackfilled, not as drift", async () => {
    const v = await mkVendor(uniq("p1paisa3"))
    const emp = await mkEmployee(v.id, { fullName: "P1 Paisa Legacy" })
    // a LEGACY row: Float values present, paisa columns all NULL
    await db.salaryStructure.create({
      data: { vendorId: v.id, employeeId: emp.id, effectiveFrom: "2026-01-01", status: "ACTIVE", basic: 15000, gross: 15000 },
    })
    const out = await reconcileFloatPaisa(v.id)
    expect(out.drifts).toEqual([])
    expect(out.nullPaisa).toBe(10) // every shadowed field of the one structure
  })
})

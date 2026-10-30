/// <reference types="bun-types" />
// ============ R4 — R-F01 payslip-sequence regression (audit 2026-10-18) =======
// PROMOTED PERMANENT REGRESSION TEST (audit §4.1 recommendation).
//
// Pre-fix reality (reproduced live by the audit): payRun minted payslip
// numbers from a per-run counter that restarted at 1, so paying the SECOND
// run of a calendar month re-minted the month's numbers and violated the
// (vendorId, payslipNumber) unique index (migration 3). The whole payment
// transaction rolled back, the run stayed APPROVED and every retry failed
// identically — a permanent payment outage for weekly-payroll tenants.
//
// Post-fix contract (R4): numbers are allocated as one consecutive block from
// a SequenceCounter keyed payslip:{vendorId}:{YYYYMM}, atomically inside the
// payment transaction, via a single-statement upsert (no caught-P2025
// `prisma:error` noise on a vendor-month's first-ever payment). Weekly runs
// carry the ISO week in the number (-W45), adjustment runs keep their -A<seq>
// tag, monthly REGULAR runs keep the exact legacy format. This suite pins:
//   R4-A  two WEEKLY runs of one month pay; the sequence CONTINUES
//         (W40-0001/0002 then W41-0003/0004) and every run reaches PAID;
//   R4-B  an ADJUSTMENT run of the same month pays with its -W40-A1 tag and
//         a continued sequence — no collision with the REGULAR numbers;
//   R4-C  a MONTHLY run of the same month pays too (frequency mix is safe);
//   R4-D  the counter is VENDOR-SCOPED: a second vendor's same-month run
//         starts fresh at 0001 without touching the first vendor's numbers;
//   R4-E  transition seed: a vendor with PRE-counter stamped payslips (the
//         pre-fix state) continues after the legacy high-water mark instead
//         of re-minting old numbers.
import "./_testdb"
import { describe, test, expect, beforeAll } from "bun:test"
import { db } from "@/lib/db"
import { mkVendor, mkUser, mkEmployee, makeCtx, uniq } from "./_fixtures"
import { calculateRun, payRun, createAdjustmentRun } from "@/hrm-server/payroll"

let owner: { id: string; vendorId: string; role: string }
let ctx: any

beforeAll(async () => {
  const vendor = await mkVendor("R4 Seq Harness Vendor")
  owner = await mkUser(vendor.id, { role: "VENDOR_OWNER", name: "R4 Owner" })
  ctx = makeCtx(owner, ["*"])
})

/** Fresh vendor + owner + ctx with test-friendly payroll settings. */
async function freshVendor(payslipFriendly = true) {
  const v = await mkVendor(uniq("R4 Vendor"))
  const o = await mkUser(v.id, { role: "VENDOR_OWNER", name: uniq("R4 Owner") })
  const c = makeCtx(o, ["*"])
  if (payslipFriendly) {
    const { saveSettingsGroup } = await import("@/hrm-server/settings")
    await saveSettingsGroup(v.id, "payroll", { absenceProration: false })
    await saveSettingsGroup(v.id, "payout", { maxCashMfsSalary: 999999 })
    await saveSettingsGroup(v.id, "notification", { payslipEmail: false })
  }
  return { v, o, c }
}

async function salaried(vendorId: string, gross: number) {
  const emp = await mkEmployee(vendorId)
  await db.salaryStructure.create({
    data: { vendorId, employeeId: emp.id, effectiveFrom: "2026-01-01", status: "ACTIVE", basic: Math.round(gross * 0.6), gross },
  })
  return emp
}

async function mkRun(vendorId: string, createdBy: string, over: { periodWeek: number; frequency: string; runType?: string }) {
  return db.payrollRun.create({
    data: {
      vendorId, periodMonth: 10, periodYear: 2026, periodWeek: over.periodWeek,
      frequency: over.frequency, runType: over.runType || "REGULAR", status: "DRAFT", createdBy,
    },
  })
}

/** Calculate → approve → pay, and return the PAID run. */
async function payToCompletion(c: any, runId: string) {
  await calculateRun(c, runId)
  await db.payrollRun.update({ where: { id: runId }, data: { status: "APPROVED" } })
  await payRun(c, runId)
  return db.payrollRun.findUnique({ where: { id: runId } })
}

async function numbersOf(runId: string) {
  const rows = await db.payrollEntry.findMany({ where: { runId, payslipNumber: { not: null } }, select: { payslipNumber: true } })
  return rows.map((r) => r.payslipNumber!).sort()
}

describe("R-F01 payslip sequence — weekly runs, adjustments, monthly mix (engine-driven)", () => {
  test("R4-A/B/C: two weekly runs + an adjustment + a monthly run of ONE month all pay, numbers continue and stay vendor-unique", async () => {
    const { v, c } = await freshVendor()
    await salaried(v.id, 30000)
    await salaried(v.id, 30000)

    // --- week 1 (ISO week 40: Mon Oct 5 – Sun Oct 11 2026) — weekly numbers
    //     carry the ISO week tag ---
    const w1 = await mkRun(v.id, owner.id, { periodWeek: 40, frequency: "WEEKLY" })
    const w1After = await payToCompletion(c, w1.id)
    expect(w1After?.status).toBe("PAID")
    expect(await numbersOf(w1.id)).toEqual(["PS-202610-W40-0001", "PS-202610-W40-0002"])

    // --- week 2 (ISO week 41) — pre-fix this payment DIED on the unique index;
    //     post-fix the sequence CONTINUES across the month's runs ---
    const w2 = await mkRun(v.id, owner.id, { periodWeek: 41, frequency: "WEEKLY" })
    const w2After = await payToCompletion(c, w2.id)
    expect(w2After?.status).toBe("PAID")
    expect(await numbersOf(w2.id)).toEqual(["PS-202610-W41-0003", "PS-202610-W41-0004"])

    // --- adjustment of week 1 (structure correction) — keeps its -W40-A1 tag ---
    await db.salaryStructure.updateMany({ where: { vendorId: v.id, status: "ACTIVE" }, data: { gross: 33000 } })
    const adjId = await createAdjustmentRun(c, w1.id)
    const adjAfter = await payToCompletion(c, adjId)
    expect(adjAfter?.runType).toBe("ADJUSTMENT")
    expect(adjAfter?.status).toBe("PAID")
    expect(await numbersOf(adjId)).toEqual(["PS-202610-W40-A1-0005", "PS-202610-W40-A1-0006"])

    // --- a monthly run of the SAME month also pays (frequency mix is safe);
    //     monthly REGULAR numbers keep the exact legacy format ---
    const mo = await mkRun(v.id, owner.id, { periodWeek: 0, frequency: "MONTHLY" })
    const moAfter = await payToCompletion(c, mo.id)
    expect(moAfter?.status).toBe("PAID")
    expect(await numbersOf(mo.id)).toEqual(["PS-202610-0007", "PS-202610-0008"])

    // --- every number this vendor holds for the period is unique, and the
    //     shared per-(vendor, month) counter holds the high-water mark ---
    const stamped = await db.payrollEntry.findMany({
      where: { vendorId: v.id, payslipNumber: { not: null }, run: { periodYear: 2026, periodMonth: 10 } },
      select: { payslipNumber: true },
    })
    expect(new Set(stamped.map((s) => s.payslipNumber)).size).toBe(8)
    const counter = await db.sequenceCounter.findUnique({ where: { key: `payslip:${v.id}:2026-10` } })
    expect(counter?.value).toBe(8)
  })

  test("R4-D: the counter is VENDOR-SCOPED — a second vendor's same-month run starts fresh at 0001", async () => {
    const { v, c } = await freshVendor()
    await salaried(v.id, 25000)

    const mo = await mkRun(v.id, owner.id, { periodWeek: 0, frequency: "MONTHLY" })
    const after = await payToCompletion(c, mo.id)
    expect(after?.status).toBe("PAID")
    expect(await numbersOf(mo.id)).toEqual(["PS-202610-0001"])

    // no cross-vendor counter interference: this vendor owns exactly one
    // counter row and one stamped number
    const counters = await db.sequenceCounter.findMany({ where: { key: { startsWith: `payslip:${v.id}:` } } })
    expect(counters.length).toBe(1)
    expect(counters[0]?.value).toBe(1)
  })

  test("R4-E transition: a PRE-counter stamped payslip is never re-minted — the sequence continues after it", async () => {
    const { v, c } = await freshVendor()
    const legacyEmp = await salaried(v.id, 30000)

    // simulate the pre-fix state: week 1 was paid and stamped PS-202610-0001
    const legacyRun = await mkRun(v.id, owner.id, { periodWeek: 40, frequency: "WEEKLY" })
    await db.payrollEntry.create({
      data: { runId: legacyRun.id, vendorId: v.id, employeeId: legacyEmp.id, gross: 30000, net: 30000, payslipNumber: "PS-202610-0001", status: "INCLUDED" } as any,
    })
    await db.payrollRun.update({ where: { id: legacyRun.id }, data: { status: "PAID" } })

    // week 2 pays AFTER the fix — it must continue at 0002, not re-mint 0001
    await salaried(v.id, 30000)
    const w2 = await mkRun(v.id, owner.id, { periodWeek: 41, frequency: "WEEKLY" })
    const after = await payToCompletion(c, w2.id)
    expect(after?.status).toBe("PAID")
    expect(await numbersOf(w2.id)).toEqual(["PS-202610-W41-0002", "PS-202610-W41-0003"])

    const all = await db.payrollEntry.findMany({
      where: { vendorId: v.id, payslipNumber: { not: null }, run: { periodYear: 2026, periodMonth: 10 } },
      select: { payslipNumber: true },
    })
    expect(new Set(all.map((s) => s.payslipNumber)).size).toBe(3)
  })
})

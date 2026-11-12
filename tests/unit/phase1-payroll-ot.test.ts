/// <reference types="bun-types" />
// ============ FIN-020 / FIN-021 (Phase 1) — overtime approval & pricing ============
// FIN-020 — strict OT approval: with shift.otApprovalRequired ON, UN-REVIEWED
// overtime (otApproved = null) is unapproved exactly like an explicit
// rejection; the held-back minutes are surfaced as a payslip warning. The old
// lenient rule paid every minute nobody had looked at.
// FIN-021 — the OT accumulator is keyed by TIER × MULTIPLIER: a month mixing
// a 1.5× weekday shift and a 2× weekday shift prices each multiplier's own
// minutes (the old first-seen-multiplier rule priced all weekday minutes at
// whichever multiplier appeared first — an order-dependent money bug).
import "./_testdb"
import { describe, test, expect } from "bun:test"
import { db } from "@/lib/db"
import { mkVendor, mkUser, mkEmployee, makeCtx, uniq, defaultCompanyId } from "./_fixtures"
import { calculateRun } from "@/hrm-server/payroll"
import { saveSettingsGroup } from "@/hrm-server/settings"

/** One isolated world per test (PayrollRun has a vendor+period uniqueness —
 *  separate vendors keep the July 2026 fixtures independent). */
async function mkWorld() {
  const v = await mkVendor(uniq("p1ot"))
  const u = await mkUser(v.id, { role: "VENDOR_OWNER", name: "P1 OT Owner" })
  return { v, u, c: makeCtx(u, ["*"]) }
}

async function mkEmpWithStructure(vendorId: string, name: string) {
  const emp = await mkEmployee(vendorId, { fullName: name })
  await db.salaryStructure.create({
    data: { vendorId, employeeId: emp.id, effectiveFrom: "2026-01-01", status: "ACTIVE", basic: 20800, gross: 20800 },
  })
  return emp
}

async function mkJulyRun(vendorId: string, createdBy: string) {
  return db.payrollRun.create({
    data: { companyId: await defaultCompanyId(vendorId), vendorId, periodMonth: 7, periodYear: 2026, periodWeek: 0, frequency: "MONTHLY", runType: "REGULAR", status: "DRAFT", createdBy },
  })
}

describe("FIN-021 — mixed-multiplier OT prices each multiplier's own minutes", () => {
  test("a month mixing a 1.5× weekday shift and a 2× weekday shift splits the tiers", async () => {
    const { v, u, c } = await mkWorld()
    // basic ৳20,800 → hour rate exactly ৳100, so the arithmetic is readable:
    // 60m × 1.5 + 60m × 2 must pay ৳150 + ৳200 = ৳350. The OLD accumulator
    // keyed by tier alone (first-seen multiplier) paid 120m × 1.5 = ৳300 —
    // or 120m × 2 = ৳400, depending on row order.
    const emp = await mkEmpWithStructure(v.id, "P1 Mixed Multiplier")
    // two weekday shifts with different OT multipliers, assigned by date
    const shiftA = await db.shift.create({ data: { companyId: await defaultCompanyId(v.id), vendorId: v.id, name: "P1 Shift A 1.5x", startTime: "09:00", endTime: "18:00", otMultiplier: 1.5 } })
    const shiftB = await db.shift.create({ data: { companyId: await defaultCompanyId(v.id), vendorId: v.id, name: "P1 Shift B 2x", startTime: "09:00", endTime: "18:00", otMultiplier: 2 } })
    await db.shiftAssignment.create({ data: { vendorId: v.id, employeeId: emp.id, shiftId: shiftA.id, fromDate: "2026-07-01", toDate: "2026-07-15" } })
    await db.shiftAssignment.create({ data: { vendorId: v.id, employeeId: emp.id, shiftId: shiftB.id, fromDate: "2026-07-16", toDate: "2026-07-31" } })
    // weekday OT in each window: Thu 9 July (ShiftA → 1.5×), Wed 22 July (ShiftB → 2×)
    await db.attendance.createMany({
      data: [
        { vendorId: v.id, employeeId: emp.id, date: "2026-07-09", status: "PRESENT", overtimeMinutes: 60 },
        { vendorId: v.id, employeeId: emp.id, date: "2026-07-22", status: "PRESENT", overtimeMinutes: 60 },
      ],
    })
    const run = await mkJulyRun(v.id, u.id)
    await calculateRun(c, run.id)
    const entry = await db.payrollEntry.findFirst({ where: { runId: run.id, employeeId: emp.id } })
    expect(entry).not.toBeNull()
    expect(entry!.otMinutes).toBe(120)
    expect(entry!.otAmount).toBe(350)
    // the per-tier minute register still shows one weekday bucket
    const bd = JSON.parse(entry!.breakdownJson || "{}")
    expect(bd.otTiers["weekday"]).toBe(120)
  })
})

describe("FIN-020 — strict OT approval (un-reviewed ≠ approved)", () => {
  test("otApproved null is withheld under strict policy and surfaced as a payslip warning", async () => {
    const { v, u, c } = await mkWorld()
    await saveSettingsGroup(v.id, "shift", { otApprovalRequired: true, strictOtApproval: true })
    const emp = await mkEmpWithStructure(v.id, "P1 Strict OT")
    // three OT days: approved (paid), rejected (not paid), un-reviewed (not
    // paid under strict policy — the OLD rule paid it)
    await db.attendance.createMany({
      data: [
        { vendorId: v.id, employeeId: emp.id, date: "2026-07-07", status: "PRESENT", overtimeMinutes: 60, otApproved: true },
        { vendorId: v.id, employeeId: emp.id, date: "2026-07-08", status: "PRESENT", overtimeMinutes: 60, otApproved: false },
        { vendorId: v.id, employeeId: emp.id, date: "2026-07-09", status: "PRESENT", overtimeMinutes: 90 }, // never reviewed
      ] as any,
    })
    const run = await mkJulyRun(v.id, u.id)
    await calculateRun(c, run.id)
    const entry = await db.payrollEntry.findFirst({ where: { runId: run.id, employeeId: emp.id } })
    expect(entry).not.toBeNull()
    // the entry's otMinutes field is the RAW register (all 210 recorded
    // minutes — the HR-facing number); what was PAID is otAmount: only the
    // approved 60 minutes, at the vendor default weekday rate 2×
    expect(entry!.otMinutes).toBe(210)
    expect(entry!.otAmount).toBe(200) // 60m × ৳100/h × 2
    // the held-back minutes are VISIBLE, not silent
    const bd = JSON.parse(entry!.breakdownJson || "{}")
    expect(bd.warnings).toBeTruthy()
    expect(bd.warnings.some((w: string) => w.includes("150 overtime minute(s) were NOT paid"))).toBe(true)
    // the register (for HR) still sees the paid tier minutes
    expect(bd.otTiers["weekday"]).toBe(60)
  })

  test("the lenient legacy mode can be restored per tenant (strictOtApproval: false)", async () => {
    const { v, u, c } = await mkWorld()
    await saveSettingsGroup(v.id, "shift", { otApprovalRequired: true, strictOtApproval: false })
    const emp = await mkEmpWithStructure(v.id, "P1 Lenient OT")
    await db.attendance.createMany({
      data: [
        { vendorId: v.id, employeeId: emp.id, date: "2026-07-07", status: "PRESENT", overtimeMinutes: 60, otApproved: true },
        { vendorId: v.id, employeeId: emp.id, date: "2026-07-09", status: "PRESENT", overtimeMinutes: 60 }, // un-reviewed
      ] as any,
    })
    const run = await mkJulyRun(v.id, u.id)
    await calculateRun(c, run.id)
    const entry = await db.payrollEntry.findFirst({ where: { runId: run.id, employeeId: emp.id } })
    // lenient: null counts as approved (explicit false still does not);
    // both 60-minute rows are paid at the vendor default weekday rate 2×
    expect(entry!.otMinutes).toBe(120)
    expect(entry!.otAmount).toBe(400)
  })
})

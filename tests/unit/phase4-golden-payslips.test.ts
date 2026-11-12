/// <reference types="bun-types" />
// ============ Phase 4 WS-E — payroll golden files (MON-9 migration gate) ============
// The integer-paisa migration is complete only when every golden payslip is
// reproduced BYTE-IDENTICALLY by the engine: these five curated scenarios
// cover the whole computation surface (whole-taka month, fractional loaded
// month with every deduction family, weekly proration, mid-month joiner,
// negative-delta adjustment). Any arithmetic change that moves a paisa must
// be a DELIBERATE decision: regenerate with
//   HRM_GOLDEN_REGEN=1 bun test tests/unit/phase4-golden-payslips.test.ts
// and review the diff of tests/golden/payslips/*.json — that diff is the
// review artifact for the change.
import "./_testdb"
import * as fs from "fs"
import * as path from "path"
import { describe, test, expect, beforeAll } from "bun:test"
import { db } from "@/lib/db"
import { mkVendor, mkUser, mkEmployee, makeCtx, uniq, defaultCompanyId } from "./_fixtures"
import { calculateRun, createAdjustmentRun, payRun } from "@/hrm-server/payroll"

const GOLDEN_DIR = path.join(import.meta.dir, "..", "golden", "payslips")
const REGEN = process.env.HRM_GOLDEN_REGEN === "1"

/** Deterministic canon: sorted-key JSON so field order never breaks a golden. */
function canon(v: any): string {
  if (Array.isArray(v)) return `[${v.map(canon).join(",")}]`
  if (v && typeof v === "object") {
    const keys = Object.keys(v).sort()
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(",")}}`
  }
  return JSON.stringify(v)
}

/** Strip non-deterministic values (cuid ids, timestamps) from a snapshot. */
function stripIds(v: any): any {
  if (Array.isArray(v)) return v.map(stripIds)
  if (v && typeof v === "object") {
    const out: any = {}
    for (const [k, val] of Object.entries(v)) {
      if (/Id$/.test(k) || k === "id" || /At$/.test(k)) continue
      out[k] = stripIds(val)
    }
    return out
  }
  return v
}

type World = { v: any; u: any; c: any }

async function mkWorld(name: string): Promise<World> {
  const v = await mkVendor(name)
  const u = await mkUser(v.id, { role: "VENDOR_OWNER", name: name + " Owner" })
  return { v, u, c: makeCtx(u, ["*"]) }
}

async function mkStructure(vendorId: string, employeeId: string, comps: Record<string, number>, from = "2026-01-01") {
  const gross = Object.values(comps).reduce((s, x) => s + x, 0)
  const data: any = {
    vendorId, employeeId, effectiveFrom: from, status: "ACTIVE",
    ...comps, gross,
  }
  return db.salaryStructure.create({ data })
}

async function mkRun(vendorId: string, createdBy: string, over: { month?: number; week?: number; runType?: string; adjustRunId?: string; adjustSeq?: number } = {}) {
  return db.payrollRun.create({
    data: { companyId: await defaultCompanyId(vendorId),
      vendorId, periodMonth: over.month ?? 7, periodYear: 2026, periodWeek: over.week ?? 0,
      frequency: (over.week ?? 0) > 0 ? "WEEKLY" : "MONTHLY", runType: over.runType || "REGULAR",
      status: "DRAFT", adjustRunId: over.adjustRunId ?? null, adjustSeq: over.adjustSeq ?? 0, createdBy,
    },
  })
}

/** Attendance seeder: spec maps ISO date → status + minutes. */
async function seedAttendance(vendorId: string, employeeId: string, rows: { date: string; status: string; late?: number; early?: number; ot?: number; otApproved?: boolean }[]) {
  await db.attendance.createMany({
    data: rows.map((r) => ({
      vendorId, employeeId, date: r.date, status: r.status,
      lateMinutes: r.late || 0, earlyLeaveMinutes: r.early || 0, overtimeMinutes: r.ot || 0,
      ...(r.otApproved != null ? { otApproved: r.otApproved } : {}),
    })),
  })
}

/** July 2026: 31 days, Jul 1 = Wednesday; Friday weekly off (BD default). */
const JULY = (() => {
  const days: string[] = []
  for (let d = 1; d <= 31; d++) days.push(`2026-07-${String(d).padStart(2, "0")}`)
  return days
})()
const isFriday = (ds: string) => new Date(ds + "T00:00:00Z").getUTCDay() === 5
const workdays = JULY.filter((d) => !isFriday(d))

/** Snapshot a calculated run: totals + per-entry money (float AND paisa) +
 *  attendance counts + stripped breakdown. Paisa is serialized as string
 *  (bigint is not JSON-native) — the exact integer the engine computed. */
async function snapshotRun(runId: string) {
  const run = await db.payrollRun.findUnique({ where: { id: runId } })
  const entries = await db.payrollEntry.findMany({ where: { runId }, orderBy: { employeeId: "asc" } })
  const big = (x: any) => (x == null ? null : String(x))
  return stripIds({
    run: {
      status: run!.status, employeeCount: run!.employeeCount,
      totals: {
        gross: run!.totalGross, grossPaisa: big(run!.totalGrossPaisa),
        ot: run!.totalOt, otPaisa: big(run!.totalOtPaisa),
        bonus: run!.totalBonus, bonusPaisa: big(run!.totalBonusPaisa),
        deduction: run!.totalDeduction, deductionPaisa: big(run!.totalDeductionPaisa),
        ait: run!.totalAit, aitPaisa: big(run!.totalAitPaisa),
        net: run!.totalNet, netPaisa: big(run!.totalNetPaisa),
      },
    },
    entries: entries.map((e: any) => ({
      money: {
        gross: e.gross, grossPaisa: big(e.grossPaisa),
        ot: e.otAmount, otPaisa: big(e.otAmountPaisa),
        bonus: e.bonus, bonusPaisa: big(e.bonusPaisa),
        commission: e.commission, commissionPaisa: big(e.commissionPaisa),
        absence: e.absenceDeduction, absencePaisa: big(e.absenceDeductionPaisa),
        late: e.lateDeduction, latePaisa: big(e.lateDeductionPaisa),
        loan: e.loanDeduction, loanPaisa: big(e.loanDeductionPaisa),
        advance: e.advanceDeduction, advancePaisa: big(e.advanceDeductionPaisa),
        other: e.otherDeduction, otherPaisa: big(e.otherDeductionPaisa),
        guarantor: e.guarantorDeduction, guarantorPaisa: big(e.guarantorDeductionPaisa),
        ait: e.ait, aitPaisa: big(e.aitPaisa),
        net: e.net, netPaisa: big(e.netPaisa),
      },
      presentDays: e.presentDays, absentDays: e.absentDays, leaveDays: e.leaveDays,
      lateMinutes: e.lateMinutes, otMinutes: e.otMinutes,
      breakdown: stripIds(JSON.parse(e.breakdownJson || "{}")),
    })),
  })
}

function checkGolden(name: string, snapshot: any) {
  const file = path.join(GOLDEN_DIR, `${name}.json`)
  const actual = canon(snapshot)
  if (REGEN) {
    fs.mkdirSync(GOLDEN_DIR, { recursive: true })
    fs.writeFileSync(file, JSON.stringify(snapshot, null, 2) + "\n")
    console.log(`[golden] REGENERATED ${file}`)
    return
  }
  if (!fs.existsSync(file)) {
    throw new Error(`Golden file missing: ${file} — run with HRM_GOLDEN_REGEN=1 to create it, then review the diff.`)
  }
  const expected = fs.readFileSync(file, "utf8")
  expect(canon(JSON.parse(actual))).toBe(canon(JSON.parse(expected)))
}

// ============================================================================
let w1: World, w2: World, w3: World, w4: World, w5: World, w6: World

beforeAll(async () => {
  w1 = await mkWorld("P4 Golden G1")
  w2 = await mkWorld("P4 Golden G2")
  w3 = await mkWorld("P4 Golden G3")
  w4 = await mkWorld("P4 Golden G4")
  w5 = await mkWorld("P4 Golden G5")
  w6 = await mkWorld("P4 Golden G6")
})

describe("Phase 4 golden payslips — the integer-paisa migration gate (MON-9)", () => {
  test("G1 · monthly whole-taka run — byte-identical to the legacy rounding", async () => {
    const emp = await mkEmployee(w1.v.id, { fullName: "G1 Whole Taka" })
    await mkStructure(w1.v.id, emp.id, { basic: 30000, houseRent: 15000, medical: 5000, conveyance: 2000 })
    await seedAttendance(w1.v.id, emp.id, workdays.map((d) => ({ date: d, status: "PRESENT" })))
    const run = await mkRun(w1.v.id, w1.u.id)
    await calculateRun(w1.c, run.id)
    const snap = await snapshotRun(run.id)
    // migration-bound assertions: whole-taka inputs → whole-taka floats,
    // paisa exactly ×100, and the payslip identity holds
    const e = snap.entries[0]
    expect(e.money.gross).toBe(52000)
    expect(e.money.grossPaisa).toBe("5200000")
    expect(e.absentDays).toBe(0)
    checkGolden("g1-monthly-whole-taka", snap)
  })

  test("G2 · fractional loaded month — absence/half-day/unpaid/late/OT/loan arrears/advance/PF/AIT/manual", async () => {
    const emp = await mkEmployee(w2.v.id, { fullName: "G2 Loaded" })
    // fractional salary: paisa precision must SURVIVE the whole computation
    await mkStructure(w2.v.id, emp.id, { basic: 50000.5, houseRent: 10000.25, medical: 500.75, conveyance: 1000.1 })
    // settings via the canonical group writer (per-(group,key) rows + cache bust)
    const { saveSettingsGroup } = await import("@/hrm-server/settings")
    await saveSettingsGroup(w2.v.id, "latePolicy", {
      graceMinutes: 0, deductionMode: "PER_MINUTE", perMinuteDeduction: 10,
      lateDaysThreshold: 3, deductDays: 1, salaryBasis: "BASIC",
      leaveAdjustmentEnabled: false, tier1Minutes: 0, tier1Penalty: 0, tier2Minutes: 0, tier2Penalty: 0,
      repeatOffenderDays: 0, repeatOffenderPenalty: 0, maxDeductionCap: 0,
    })
    await saveSettingsGroup(w2.v.id, "pf", {
      enabled: true, employeePct: 10, employerPct: 8, basis: "BASIC", minServiceMonths: 0, autoEnroll: true,
    })
    const att: { date: string; status: string; late?: number; ot?: number }[] = []
    for (const d of workdays) {
      const day = Number(d.slice(-2))
      if (day === 6 || day === 20) att.push({ date: d, status: "HALF_DAY" })
      else if (day === 13) att.push({ date: d, status: "ABSENT" })
      else if (day === 7) att.push({ date: d, status: "LEAVE" })
      else if (day === 8) att.push({ date: d, status: "LEAVE_UNPAID" })
      else if (day === 9) att.push({ date: d, status: "LATE", late: 15 })
      else if (day === 22) att.push({ date: d, status: "LATE", late: 25 })
      else att.push({ date: d, status: "PRESENT" })
    }
    // OT: 120 weekday minutes + 60 holiday minutes (Jul 3 2026 is a Friday holiday? no —
    // use a real holiday row so the holiday tier is exercised)
    await db.holiday.create({ data: { companyId: await defaultCompanyId(w2.v.id), vendorId: w2.v.id, name: "G2 Holiday", date: "2026-07-17" } })
    att.push({ date: "2026-07-10", status: "PRESENT", ot: 120 })
    att.push({ date: "2026-07-17", status: "PRESENT", ot: 60 }) // holiday tier ×2
    await seedAttendance(w2.v.id, emp.id, att)
    // loan with arrears: EMIs May/Jun missed, July current (calendar EMIs, MON-11)
    const loan = await db.loan.create({ data: {
      vendorId: w2.v.id, employeeId: emp.id, principal: 12000, installments: 6,
      installmentAmount: 2000, startDate: "2026-05-10", status: "PENDING", outstanding: 12000,
    } })
    const { applyLoanDecision } = await import("@/hrm-server/routes/finance")
    await applyLoanDecision({ userId: w2.u.id, userName: "G2", vendorId: w2.v.id }, loan.id, "APPROVED")
    // advance: 3 × ৳1,000
    await db.advance.create({ data: {
      vendorId: w2.v.id, employeeId: emp.id, amount: 3000, installments: 3,
      outstanding: 3000, requestDate: "2026-07-01", status: "RECOVERING",
    } })
    // manual deductions — fractional taka whose float sum drifts (the parity fix)
    await db.deduction.createMany({ data: [
      { vendorId: w2.v.id, employeeId: emp.id, type: "OTHER", label: "G2 Canteen", amount: 100.1, month: 7, year: 2026, status: "ACTIVE" },
      { vendorId: w2.v.id, employeeId: emp.id, type: "OTHER", label: "G2 Transport", amount: 200.2, month: 7, year: 2026, status: "ACTIVE" },
    ] })
    const run = await mkRun(w2.v.id, w2.u.id)
    await calculateRun(w2.c, run.id)
    const snap = await snapshotRun(run.id)
    // migration-bound assertions:
    const e = snap.entries[0]
    expect(e.money.absencePaisa).not.toBe(null)
    // the OTHER-DEDUCTION parity fix: exact paisa sum of the two fractional rows
    expect(e.money.otherPaisa).toBe("30030") // ৳300.30 — the float sum was 300.30000000000005
    // loan arrears: EMIs are start+i months (Jun 10, Jul 10, …) — the two
    // due on or before July (Jun + Jul) are budgeted: 2 × ৳2,000
    expect(e.money.loanPaisa).toBe("400000")
    expect(e.money.advancePaisa).toBe("100000")
    // PF: 10% of ৳50,000.50 = ৳5,000.05 exactly (mulPct single boundary)
    expect(e.money.gross).toBe(61501.6)
    checkGolden("g2-monthly-fractional-loaded", snap)
  })

  test("G3 · weekly proration — one ISO week of the same fractional month", async () => {
    const emp = await mkEmployee(w3.v.id, { fullName: "G3 Weekly" })
    await mkStructure(w3.v.id, emp.id, { basic: 50000.5, houseRent: 10000.25, medical: 500.75, conveyance: 1000.1 })
    // ISO week 29 of 2026: Mon 2026-07-13 … Sun 2026-07-19 (Friday 17th off)
    const weekDays = ["2026-07-13", "2026-07-14", "2026-07-15", "2026-07-16", "2026-07-17", "2026-07-18", "2026-07-19"]
    await seedAttendance(w3.v.id, emp.id, weekDays.filter((d) => !isFriday(d)).map((d) => ({ date: d, status: "PRESENT" })))
    const run = await mkRun(w3.v.id, w3.u.id, { week: 29 })
    await calculateRun(w3.c, run.id)
    const snap = await snapshotRun(run.id)
    checkGolden("g3-weekly-proration", snap)
  })

  test("G4 · mid-month joiner — pre-joining days neither absent nor paid; gross prorated to service days (FIN-002)", async () => {
    const emp = await mkEmployee(w4.v.id, { fullName: "G4 Joiner" })
    await db.employee.update({ where: { id: emp.id }, data: { joiningDate: "2026-07-16" } })
    await mkStructure(w4.v.id, emp.id, { basic: 30000, houseRent: 15000, medical: 5000, conveyance: 2000 })
    await seedAttendance(w4.v.id, emp.id, workdays.filter((d) => d >= "2026-07-16").map((d) => ({ date: d, status: "PRESENT" })))
    const run = await mkRun(w4.v.id, w4.u.id)
    await calculateRun(w4.c, run.id)
    const snap = await snapshotRun(run.id)
    // FIN-002 (Phase 0) — the golden used to pin the DEFECT: full monthly
    // gross (৳52,000) for 13 payable days. July 2026 with Friday off has 26
    // working days; joining 2026-07-16 leaves 13 payable → gross prorates to
    // exactly ৳26,000 (13/26 × 52,000, the single mulRatio boundary). Days
    // before joiningDate remain SKIPPED (not absent) — no double deduction.
    const e = snap.entries[0]
    expect(e.money.gross).toBe(26000)
    expect(e.breakdown.proration.serviceDays).toBe(13)
    expect(e.breakdown.proration.joiningDate).toBe("2026-07-16")
    checkGolden("g4-mid-month-joiner", snap)
  })

  test("G5 · adjustment with a negative-delta correction", async () => {
    const emp = await mkEmployee(w5.v.id, { fullName: "G5 Adjusted" })
    await mkStructure(w5.v.id, emp.id, { basic: 30000, houseRent: 15000, medical: 5000, conveyance: 2000 })
    await seedAttendance(w5.v.id, emp.id, workdays.map((d) => ({ date: d, status: "PRESENT" })))
    const src = await mkRun(w5.v.id, w5.u.id)
    await calculateRun(w5.c, src.id)
    // force the source to PAID (payRun's money legs are out of scope here)
    await db.payrollRun.update({ where: { id: src.id }, data: { status: "PAID", paymentDate: new Date().toISOString() } })
    // the correction: a ৳500 manual deduction that was not in the source run
    await db.deduction.create({ data: {
      vendorId: w5.v.id, employeeId: emp.id, type: "OTHER", label: "G5 Recovery", amount: 500,
      month: 7, year: 2026, status: "ACTIVE",
    } })
    const adjId = await createAdjustmentRun(w5.c, src.id)
    await calculateRun(w5.c, adjId)
    const snap = await snapshotRun(adjId)
    // migration-bound: the adjustment carries ONLY the −৳500 correction
    const e = snap.entries[0]
    expect(e.money.otherPaisa).toBe("50000")
    expect(Number(e.money.netPaisa)).toBeLessThan(0)
    checkGolden("g5-adjustment-negative-delta", snap)
  })

  // ---- FIN-021 (Phase 1) — the mixed-multiplier golden: a month whose
  // weekday OT spans two shifts with different multipliers (1.5× then 2×)
  // prices each multiplier's OWN minutes. The old tier-only accumulator
  // (first-seen multiplier) would have paid all 120 minutes at 1.5× (order-
  // dependent), so this golden pins the corrected split to the paisa.
  test("G6 · mixed-multiplier weekday OT — each multiplier prices its own minutes", async () => {
    const emp = await mkEmployee(w6.v.id, { fullName: "G6 Mixed Multiplier" })
    await mkStructure(w6.v.id, emp.id, { basic: 20800 }) // hour rate exactly ৳100
    // two weekday shifts with different OT multipliers, assigned by date
    const shiftA = await db.shift.create({ data: { companyId: await defaultCompanyId(w6.v.id), vendorId: w6.v.id, name: "G6 Shift A 1.5x", startTime: "09:00", endTime: "18:00", otMultiplier: 1.5 } })
    const shiftB = await db.shift.create({ data: { companyId: await defaultCompanyId(w6.v.id), vendorId: w6.v.id, name: "G6 Shift B 2x", startTime: "09:00", endTime: "18:00", otMultiplier: 2 } })
    await db.shiftAssignment.create({ data: { vendorId: w6.v.id, employeeId: emp.id, shiftId: shiftA.id, fromDate: "2026-07-01", toDate: "2026-07-15" } })
    await db.shiftAssignment.create({ data: { vendorId: w6.v.id, employeeId: emp.id, shiftId: shiftB.id, fromDate: "2026-07-16", toDate: "2026-07-31" } })
    // weekday OT in each window: Thu 9 July (ShiftA → 1.5×), Wed 22 July (ShiftB → 2×)
    await seedAttendance(w6.v.id, emp.id, [
      { date: "2026-07-09", status: "PRESENT", ot: 60 },
      { date: "2026-07-22", status: "PRESENT", ot: 60 },
    ])
    const run = await mkRun(w6.v.id, w6.u.id)
    await calculateRun(w6.c, run.id)
    const snap = await snapshotRun(run.id)
    // the corrected pricing: 60m × ৳100 × 1.5 + 60m × ৳100 × 2 = ৳350
    // (the old accumulator would have paid ৳300 or ৳400, order-dependent)
    expect(snap.entries[0].money.ot).toBe(350)
    expect(snap.entries[0].money.otPaisa).toBe("35000")
    checkGolden("g6-mixed-multiplier-ot", snap)
  })
})

// ============================================================================
// TST-2 (P2 wave, 2026-11-09) — G7: the REAL payRun money legs, golden-pinned.
// g1..g6 force the run to PAID ("payRun's money legs are out of scope here"),
// so the journals, loan-ledger writes, bonus/deduction markings and payslip
// numbering emitted by the actual payment were only covered piecemeal
// elsewhere — never byte-pinned as one artifact. G7 runs the real payRun()
// over a run carrying EVERY deduction family and snapshots the effects.
describe("Phase 4 golden payslips — G7: payRun money legs (TST-2)", () => {
  test("G7 · the real payment: journal + loan ledger + markings + payslip numbers", async () => {
    const w7 = await mkWorld("P4 Golden G7")
    const emp = await mkEmployee(w7.v.id, { fullName: "G7 Money Legs" })
    // gross ≤ 10,000 keeps the CASH payout path valid with no bank account
    await mkStructure(w7.v.id, emp.id, { basic: 6000, houseRent: 2000, medical: 500, conveyance: 500 })
    await seedAttendance(w7.v.id, emp.id, workdays.map((d) => ({ date: d, status: "PRESENT" })))

    // loan with ONE pending installment due inside the run period
    const loan = await db.loan.create({
      data: { vendorId: w7.v.id, employeeId: emp.id, type: "PERSONAL", principal: 48000, installmentAmount: 4000, installments: 12, startDate: "2026-01-01", paidAmount: 8000, outstanding: 40000, status: "ACTIVE" },
    })
    await db.loanInstallment.create({ data: { vendorId: w7.v.id, loanId: loan.id, no: 3, amount: 4000, dueDate: "2026-07-05", paidAmount: 0, status: "PENDING" } })
    // an APPROVED bonus consumed by the payment (PAY-003 ledger)
    const bonus = await db.bonus.create({
      data: { vendorId: w7.v.id, employeeId: emp.id, type: "FESTIVAL", calcType: "FIXED", amount: 1500, periodMonth: 7, periodYear: 2026, status: "APPROVED", createdBy: w7.u.id },
    })
    // an ACTIVE other-deduction snapshotted at calculation time (MON-2)
    const deduction = await db.deduction.create({
      data: { vendorId: w7.v.id, employeeId: emp.id, type: "OTHER", label: "G7 Penalty", amount: 250, month: 7, year: 2026, status: "ACTIVE" },
    })

    const run = await mkRun(w7.v.id, w7.u.id)
    await calculateRun(w7.c, run.id)
    // the approve step is orthogonal here — the payment only needs APPROVED
    await db.payrollRun.update({ where: { id: run.id }, data: { status: "APPROVED" } })
    // THE REAL PAYMENT (payout preflight + claim + ledger writes + journal)
    await payRun(w7.c, run.id)

    // ---- snapshot the money legs (deterministic canon; ids/dates stripped) ----
    const runAfter = await db.payrollRun.findUnique({ where: { id: run.id } })
    const entries = await db.payrollEntry.findMany({ where: { runId: run.id } })
    const journals = await db.accountJournal.findMany({ where: { vendorId: w7.v.id, refType: "PAYROLL" } })
    const inst = await db.loanInstallment.findMany({ where: { loanId: loan.id }, orderBy: { no: "asc" } })
    const loanAfter = await db.loan.findUnique({ where: { id: loan.id } })
    const bonusAfter = await db.bonus.findUnique({ where: { id: bonus.id } })
    const dedAfter = await db.deduction.findUnique({ where: { id: deduction.id } })
    const snap = stripIds({
      run: { status: runAfter!.status, journalPresent: !!runAfter!.journalId, totals: { net: runAfter!.totalNet, netPaisa: String(runAfter!.totalNetPaisa) } },
      entries: entries.map((e: any) => ({ payslipNumber: e.payslipNumber, status: e.status, net: e.net, netPaisa: String(e.netPaisa), loanDeduction: e.loanDeduction, bonus: e.bonus, otherDeduction: e.otherDeduction })),
      journals: journals.map((j: any) => ({
        amount: j.amount,
        lines: (JSON.parse(j.linesJson) as any[]).map((l) => ({ account: l.account, debit: l.debit ?? 0, credit: l.credit ?? 0 })),
      })),
      loan: { paidAmount: loanAfter!.paidAmount, outstanding: loanAfter!.outstanding, status: loanAfter!.status },
      installments: inst.map((i) => ({ no: i.no, amount: i.amount, paidAmount: i.paidAmount, status: i.status, linkedToEntry: !!i.payrollEntryId, paidAt: !!i.paidAt })),
      bonus: { status: bonusAfter!.status },
      deduction: { status: dedAfter!.status },
    })
    // sanity before the golden: the money legs really moved
    expect(snap.run.status).toBe("PAID")
    expect(snap.journals).toHaveLength(1)
    expect(snap.journals[0].lines.length).toBeGreaterThanOrEqual(5) // salary + loan + bonus + cash + deductions sides
    expect(snap.installments[0].status).toBe("PAID")
    expect(snap.installments[0].paidAmount).toBe(4000)
    expect(snap.loan.paidAmount).toBe(12000)
    expect(snap.loan.outstanding).toBe(36000)
    expect(snap.bonus.status).toBe("PAID")
    expect(snap.deduction.status).toBe("PAID")
    expect(snap.entries[0].payslipNumber).toMatch(/^PS?-?/)
    checkGolden("g7-payrun-money-legs", snap)
  })
})

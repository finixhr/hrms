/// <reference types="bun-types" />
// ============ R3-1 Wave — the five CRITICAL money-path fixes ============
// EXIT-001  gratuity absent from the final settlement        → shared engine
// EXIT-002  post-LWD settlement deadlock                     → COMPLETED stays calculable
// EXIT-003  notice-pay direction inverted                    → direction matrix
// PAY-001   adjustment runs re-pay the FULL month            → true DELTA semantics
// PAY-002   BONUS / FINAL_SETTLEMENT runTypes pay a 2nd month → creation blocked
// (+ EXIT-004 employee-status vocabulary on the two rewritten write sites)
//
// Structure: PART A = pure functions (no DB queries); PART B = dispatcher /
// engine integration (needs the isolated unit-test PostgreSQL).
import "./_testdb"
import { describe, test, expect, beforeAll } from "bun:test"
import { db } from "@/lib/db"
import { mkVendor, mkUser, mkSession, makeCtx, uniq } from "./_fixtures"
import { postHrm } from "./_hrm-endpoint"
import { computeGratuity, completedMonthsBetween } from "@/hrm-server/gratuity"
import { resolveNoticeComponent, exitStatusForEmployee } from "@/hrm-server/routes/exit"
import { applyAdjustmentDeltas, createAdjustmentRun, calculateRun } from "@/hrm-server/payroll"
import { normalizeJournalSides, validateAndBalanceLines } from "@/hrm-server/accounting"
import { S } from "@/hrm-server/validation"

// ============================================================================
// PART A — pure functions
// ============================================================================

describe("EXIT-001 gratuity engine (gratuity.ts)", () => {
  test("completedMonthsBetween: anniversary rule", () => {
    expect(completedMonthsBetween("2020-01-15", "2026-01-14")).toBe(71) // one day short
    expect(completedMonthsBetween("2020-01-15", "2026-01-15")).toBe(72) // exactly 6y
    expect(completedMonthsBetween("2020-01-31", "2020-02-28")).toBe(0) // Feb never reaches day 31
    expect(completedMonthsBetween("2026-05-10", "2026-05-09")).toBe(0) // reversed
    expect(completedMonthsBetween("2026-05-10", "2026-05-10")).toBe(0) // same day
  })

  test("BLA formula: (basic / 30) x 30 days x completed years", () => {
    // 6y3m service, basic 30000 → 30000/30 × 30 × 6 = 180000
    const g = computeGratuity(undefined, { basic: 30000, gross: 50000 }, "2020-01-10", "2026-04-10")
    expect(g.eligible).toBe(true)
    expect(g.years).toBe(6)
    expect(g.amount).toBe(180000)
    expect(g.dailyWage).toBe(1000)
  })

  test("eligibility: 5 completed years required, 4y6m rounds UP (2018 amendment)", () => {
    expect(computeGratuity(undefined, { basic: 30000, gross: 50000 }, "2021-10-01", "2026-03-31").eligible).toBe(false) // 4y5m30d
    expect(computeGratuity(undefined, { basic: 30000, gross: 50000 }, "2021-10-01", "2026-04-01").eligible).toBe(true) // 4y6m
    expect(computeGratuity(undefined, { basic: 30000, gross: 50000 }, "2021-10-01", "2026-04-01").years).toBe(4)
    expect(computeGratuity(undefined, { basic: 30000, gross: 50000 }, "2021-10-01", "2026-04-01").amount).toBe(120000) // 4y × 30000
  })

  test("factory divisor 26 convention, GROSS basis, cap and disable", () => {
    // divisor 26: 26000/26 × 30 × 5
    expect(computeGratuity({ divisor: 26 }, { basic: 26000, gross: 40000 }, "2020-01-01", "2025-07-01").amount).toBe(150000)
    // GROSS basis
    expect(computeGratuity({ wageBasis: "GROSS" }, { basic: 26000, gross: 52000 }, "2020-01-01", "2025-07-01").amount).toBe(260000)
    // cap clips
    const capped = computeGratuity({ capAmount: 100000 }, { basic: 30000, gross: 50000 }, "2020-01-10", "2026-04-10")
    expect(capped.capped).toBe(true)
    expect(capped.amount).toBe(100000)
    // disabled → zero even when eligible
    expect(computeGratuity({ enabled: false }, { basic: 30000, gross: 50000 }, "2020-01-10", "2026-04-10").amount).toBe(0)
    // no joining date → zero
    expect(computeGratuity(undefined, { basic: 30000, gross: 50000 }, null, "2026-04-10").amount).toBe(0)
  })
})

describe("EXIT-003 notice-pay direction matrix (resolveNoticeComponent)", () => {
  const args = (over: Partial<Parameters<typeof resolveNoticeComponent>[0]>) => ({
    exitType: "RESIGNATION" as const, noticeMode: "FULL" as const, requiredNoticeDays: 30, servedDays: 0, dailyWage: 2000, ...over,
  })
  test("immediate TERMINATION with WAIVED notice → the COMPANY owes notice pay, not a deduction", () => {
    const r = resolveNoticeComponent(args({ exitType: "TERMINATION", noticeMode: "WAIVED", servedDays: 0 }))
    expect(r.shortNoticeDays).toBe(30)
    expect(r.noticePay).toBe(60000)
    expect(r.noticeBuyout).toBe(0) // ← the Critical: was deducted from the employee before
  })
  test("RETIREMENT released early → notice pay owed", () => {
    const r = resolveNoticeComponent(args({ exitType: "RETIREMENT", noticeMode: "EARLY_RELEASE", servedDays: 10 }))
    expect(r.noticePay).toBe(40000)
    expect(r.noticeBuyout).toBe(0)
  })
  test("RESIGNATION with short notice → employee owes the shortfall (historical behaviour kept)", () => {
    const r = resolveNoticeComponent(args({ exitType: "RESIGNATION", noticeMode: "SHORT", servedDays: 20 }))
    expect(r.noticeBuyout).toBe(20000)
    expect(r.noticePay).toBe(0)
  })
  test("resignation with formally WAIVED notice → company-side obligation", () => {
    const r = resolveNoticeComponent(args({ exitType: "RESIGNATION", noticeMode: "WAIVED", servedDays: 0 }))
    expect(r.noticePay).toBe(60000)
    expect(r.noticeBuyout).toBe(0)
  })
  test("full notice served → nothing owed either way", () => {
    const r = resolveNoticeComponent(args({ exitType: "TERMINATION", noticeMode: "FULL", servedDays: 30 }))
    expect(r).toEqual({ shortNoticeDays: 0, noticeBuyout: 0, noticePay: 0 })
  })
})

describe("EXIT-004 employee-status vocabulary (exitStatusForEmployee)", () => {
  test("maps the internal exit-type nouns onto Employee.status values", () => {
    expect(exitStatusForEmployee("RESIGNATION")).toBe("RESIGNED")
    expect(exitStatusForEmployee("TERMINATION")).toBe("TERMINATED")
    expect(exitStatusForEmployee("RETIREMENT")).toBe("RETIRED")
  })
})

describe("PAY-001 true delta semantics (applyAdjustmentDeltas)", () => {
  const mkEntry = (over: Record<string, any> = {}): any => ({
    vendorId: "v", runId: "adj", employeeId: "e1", structureId: "s",
    presentDays: 26, absentDays: 0, leaveDays: 0, lateMinutes: 0, otMinutes: 0,
    gross: 50000, otAmount: 2000, bonus: 0, commission: 0,
    absenceDeduction: 0, lateDeduction: 0, loanDeduction: 5000, advanceDeduction: 0, otherDeduction: 1000,
    guarantorDeduction: 0, ait: 1500, net: 44500, adjustEntryId: null as string | null,
    breakdownJson: JSON.stringify({ net: 44500, pf: { employeeAmount: 2000, employerAmount: 2000, employeePct: 10, employerPct: 10, basis: "BASIC" } }),
    ...over,
  })
  const mkSrc = (over: Partial<Parameters<typeof applyAdjustmentDeltas>[1][number]> = {}) => ({
    id: "src-entry-1", employeeId: "e1",
    gross: 50000, otAmount: 2000, bonus: 5000, commission: 0,
    absenceDeduction: 0, lateDeduction: 0, loanDeduction: 5000, advanceDeduction: 0, otherDeduction: 1000,
    guarantorDeduction: 0, ait: 1500, net: 46500,
    breakdownJson: JSON.stringify({ net: 46500, pf: { employeeAmount: 2000, employerAmount: 2000, employeePct: 10, employerPct: 10, basis: "BASIC" } }),
    ...over,
  })

  test("unchanged data → every delta is ZERO (no second month)", () => {
    // a REAL recompute of unchanged data: the source's bonus/deductions were
    // consumed (status PAID) and its loan installment is already recovered —
    // the recompute naturally yields 0 for all of them
    const entries = [mkEntry({ bonus: 0, loanDeduction: 0, otherDeduction: 0 })]
    applyAdjustmentDeltas(entries, [mkSrc()])
    expect(entries[0].gross).toBe(0)
    expect(entries[0].otAmount).toBe(0)
    expect(entries[0].ait).toBe(0)
    expect(entries[0].net).toBe(0)
  })

  test("gross correction 50000 → 55000 → the run pays the 5000 correction, not 55000 again", () => {
    const entries = [mkEntry({ gross: 55000, bonus: 0, loanDeduction: 0, otherDeduction: 0 })]
    applyAdjustmentDeltas(entries, [mkSrc()])
    expect(entries[0].gross).toBe(5000)
    expect(entries[0].net).toBe(5000) // no other deltas
    expect(entries[0].adjustEntryId).toBe("src-entry-1")
    const bd = JSON.parse(entries[0].breakdownJson)
    expect(bd.adjustment.corrections.gross).toBe(5000)
  })

  test("loan recovery is NOT reversed (ledger-driven) and newly-approved bonuses ride the adjustment", () => {
    // recompute: loan installments already paid → recompute sees none; a NEW
    // bonus was approved after the source run was paid
    const entries = [mkEntry({ gross: 50000, loanDeduction: 0, bonus: 8000, otherDeduction: 0 })]
    applyAdjustmentDeltas(entries, [mkSrc()])
    expect(entries[0].loanDeduction).toBe(0)      // fresh recovery only — never −5000
    expect(entries[0].bonus).toBe(8000)           // the newly approved bonus is paid…
    expect(entries[0].net).toBe(8000)
    const bd = JSON.parse(entries[0].breakdownJson)
    expect(bd.adjustment.source.gross).toBe(50000)
  })

  test("absence corrections flow through; negative nets (recoveries) are not clamped", () => {
    const entries = [mkEntry({ gross: 50000, absenceDeduction: 6000, loanDeduction: 0, otherDeduction: 0, ait: 0 })]
    applyAdjustmentDeltas(entries, [mkSrc({ ait: 0, net: 51000 })])
    expect(entries[0].absenceDeduction).toBe(6000)
    expect(entries[0].net).toBe(-6000)
    const bd = JSON.parse(entries[0].breakdownJson)
    expect(bd.warnings[0]).toMatch(/recovered from the employee/i)
  })

  test("employee with NO source entry (newly in scope) keeps the full recomputed values", () => {
    const entries = [mkEntry({ employeeId: "e2" })]
    applyAdjustmentDeltas(entries, [mkSrc()])
    expect(entries[0].gross).toBe(50000)
    expect(entries[0].adjustEntryId).toBeNull()
  })

  test("PF delta is carried in the breakdown", () => {
    const entries = [mkEntry({ gross: 55000 })]
    applyAdjustmentDeltas(entries, [mkSrc()])
    const bd = JSON.parse(entries[0].breakdownJson)
    expect(bd.pf.employeeAmount).toBe(0) // same structure % → no PF delta
    expect(bd.pf.employerAmount).toBe(0)
  })
})

describe("PAY-001 journal side normalization (normalizeJournalSides)", () => {
  test("negative debit flips to credit; negative credit flips to debit; zeros dropped", () => {
    const out = normalizeJournalSides([
      { account: "5100", accountName: "Salaries", debit: -5000 },
      { account: "2100", accountName: "Payable", credit: -3000 },
      { account: "5290", accountName: "Recovered", credit: 0 },
      { account: "2100", accountName: "Payable", credit: 8000 },
    ])
    expect(out).toEqual([
      { account: "5100", accountName: "Salaries", credit: 5000 },
      { account: "2100", accountName: "Payable", debit: 3000 },
      { account: "2100", accountName: "Payable", credit: 8000 },
    ])
  })
  test("a balanced delta journal stays balanced after flipping (validateAndBalanceLines accepts it)", () => {
    const flipped = normalizeJournalSides([
      { account: "5100", accountName: "Salaries", debit: -4000 },
      { account: "2105", accountName: "AIT", credit: -1000 },
      { account: "2100", accountName: "Payable", credit: -3000 },
    ])
    // −4000 d = −4000 c before flips; after flips both sides are positive
    expect(() => validateAndBalanceLines(flipped)).not.toThrow()
    const balanced = validateAndBalanceLines(flipped)
    const d = balanced.reduce((s, l) => s + (l.debit || 0), 0)
    const c = balanced.reduce((s, l) => s + (l.credit || 0), 0)
    expect(d).toBe(c)
    expect(d).toBeGreaterThan(0)
  })
  test("all-zero lines are dropped entirely", () => {
    expect(normalizeJournalSides([{ account: "1", accountName: "x", debit: 0 }, { account: "2", accountName: "y", credit: 0 }])).toEqual([])
  })
})

describe("PAY-002 payrollCreate schema gates rogue runTypes", () => {
  const base = { periodYear: 2026, periodMonth: 10 }
  test("REGULAR and absent runType still accepted", () => {
    expect(S.payrollCreate.safeParse(base).success).toBe(true)
    expect(S.payrollCreate.safeParse({ ...base, runType: "REGULAR" }).success).toBe(true)
  })
  test("BONUS / FINAL_SETTLEMENT / ADJUSTMENT are rejected at the schema layer", () => {
    expect(S.payrollCreate.safeParse({ ...base, runType: "BONUS" }).success).toBe(false)
    expect(S.payrollCreate.safeParse({ ...base, runType: "FINAL_SETTLEMENT" }).success).toBe(false)
    expect(S.payrollCreate.safeParse({ ...base, runType: "ADJUSTMENT" }).success).toBe(false)
  })
})

// ============================================================================
// PART B — engine + dispatcher integration (isolated test database)
// ============================================================================

let vendor: { id: string }
let owner: { id: string; vendorId: string; role: string }
let ctx: any
let token: string

beforeAll(async () => {
  vendor = await mkVendor("R31 Criticals Vendor")
  owner = await mkUser(vendor.id, { role: "VENDOR_OWNER", name: "R31 Owner" })
  ctx = makeCtx(owner, ["*"])
  token = await mkSession(owner.id, "FULL")
})

async function mkExitFixture(over: {
  joiningDate?: string
  resignationStatus?: string
  noticeMode?: string
  servedDays?: number
  basic?: number
  gross?: number
  proposedLwd?: string
} = {}) {
  const emp = await db.employee.create({
    data: {
      vendorId: vendor.id, fullName: uniq("R31 Emp"), code: uniq("R31"),
      joiningDate: over.joiningDate || "2020-01-15", employmentType: "PERMANENT", status: "ACTIVE",
    },
  })
  const struct = await db.salaryStructure.create({
    data: {
      vendorId: vendor.id, employeeId: emp.id, effectiveFrom: "2020-01-15", status: "ACTIVE",
      basic: over.basic ?? 30000, gross: over.gross ?? 50000,
    },
  })
  const res = await db.resignation.create({
    data: {
      vendorId: vendor.id, employeeId: emp.id,
      submissionDate: "2026-09-01", resignationDate: "2026-09-15",
      proposedLwd: over.proposedLwd || "2026-10-15", actualLwd: over.proposedLwd || "2026-10-15",
      reason: "R3-1 test exit", status: over.resignationStatus || "NOTICE_PERIOD",
      noticeMode: over.noticeMode || "FULL", noticeDays: 30, servedDays: over.servedDays ?? 0,
    },
  })
  return { emp, struct, res }
}

describe("EXIT-002 settlements.calculate works AFTER the LWD (COMPLETED resignation, unpaid)", () => {
  test("COMPLETED + no settlement → calculation succeeds with final-month data", async () => {
    const f = await mkExitFixture({ resignationStatus: "COMPLETED", proposedLwd: "2026-10-15", servedDays: 30 })
    // R3-2 (EXIT-005) — final salary is computed on the payroll convention:
    // working days 1→LWD minus ABSENT/missing records. Seed PRESENT attendance
    // for the final month so the payable amount is non-zero.
    for (let d = 1; d <= 15; d++) {
      await db.attendance.create({
        data: {
          vendorId: vendor.id, employeeId: f.emp.id,
          date: `2026-10-${String(d).padStart(2, "0")}`, status: "PRESENT",
        },
      })
    }
    const r = await postHrm("settlements.calculate", { resignationId: f.res.id }, { bearer: token })
    expect(r.status).toBe(200)
    expect(r.body.data.computation.finalSalary).toBeGreaterThan(0)
    expect(r.body.data.computation.finalSalaryBasis.daysUptoLwd).toBe(13) // Oct 1–15 minus 2 Fridays
  })
  test("COMPLETED + already PAID settlement → recalculation is closed", async () => {
    const f = await mkExitFixture({ resignationStatus: "COMPLETED" })
    await db.finalSettlement.create({
      data: { vendorId: vendor.id, resignationId: f.res.id, computationJson: "{}", netPayable: 0, status: "PAID" },
    })
    const r = await postHrm("settlements.calculate", { resignationId: f.res.id }, { bearer: token })
    expect(r.status).not.toBe(200)
    expect(r.body.error).toMatch(/already settled and paid/i)
  })
  test("SUBMITTED (not yet accepted) → still denied", async () => {
    const f = await mkExitFixture({ resignationStatus: "SUBMITTED" })
    const r = await postHrm("settlements.calculate", { resignationId: f.res.id }, { bearer: token })
    expect(r.status).not.toBe(200)
  })
})

describe("EXIT-001 gratuity is in the settlement money (dispatcher-driven)", () => {
  test("6-year employee: gratuity = 30 days' basic x 6y, inside gross and netPayable", async () => {
    const f = await mkExitFixture({ joiningDate: "2020-01-15", proposedLwd: "2026-10-15" }) // 6y9m
    const r = await postHrm("settlements.calculate", { resignationId: f.res.id }, { bearer: token })
    expect(r.status).toBe(200)
    const c = r.body.data.computation
    expect(c.gratuity).toBe(180000) // (30000 / 30) x 30 x 6
    expect(c.gratuityYears).toBe(6)
    expect(c.gratuityEligible).toBe(true)
    expect(c.gross).toBe(c.finalSalary + c.otAmount + c.leaveEncashment + c.bonusDue + c.gratuity)
    expect(c.netPayable).toBe(c.gross - c.totalDeductions)
  })
  test("2-year employee: ineligible → zero gratuity, key present", async () => {
    const f = await mkExitFixture({ joiningDate: "2024-06-01", proposedLwd: "2026-10-15" }) // 2y4m
    const r = await postHrm("settlements.calculate", { resignationId: f.res.id }, { bearer: token })
    expect(r.status).toBe(200)
    const c = r.body.data.computation
    expect(c.gratuity).toBe(0)
    expect(c.gratuityEligible).toBe(false)
  })
})

describe("EXIT-003 notice direction in the settlement (dispatcher-driven)", () => {
  test("resignation, 10 of 30 days served → SHORT notice buyout DEDUCTED from the employee", async () => {
    const f = await mkExitFixture({ noticeMode: "SHORT", servedDays: 10, proposedLwd: "2026-09-25" })
    const r = await postHrm("settlements.calculate", { resignationId: f.res.id }, { bearer: token })
    expect(r.status).toBe(200)
    const c = r.body.data.computation
    expect(c.shortNoticeDays).toBe(20)
    expect(c.noticeBuyout).toBe(Math.round(20 * (50000 / 26)))
    expect(c.noticePay ?? 0).toBe(0)
    expect(c.totalDeductions).toBeGreaterThanOrEqual(c.noticeBuyout)
  })
  test("termination with WAIVED notice → notice PAY added to gross, nothing deducted", async () => {
    // exit type TERMINATION is resolved from employee.status TERMINATED
    const f = await mkExitFixture({ noticeMode: "WAIVED", servedDays: 0 })
    await db.employee.update({ where: { id: f.emp.id }, data: { status: "TERMINATED" } })
    const r = await postHrm("settlements.calculate", { resignationId: f.res.id }, { bearer: token })
    expect(r.status).toBe(200)
    const c = r.body.data.computation
    expect(c.shortNoticeDays).toBe(30)
    expect(c.noticePay).toBe(Math.round(30 * (50000 / 26))) // company owes
    expect(c.noticeBuyout).toBe(0)
    expect(c.gross).toBe(c.finalSalary + c.otAmount + c.leaveEncashment + c.bonusDue + c.gratuity + c.noticePay)
  })
})

describe("PAY-001 adjustment run pays the DELTA, not the month (engine-driven)", () => {
  test("structure correction 50000 → 55000 → adjustment totalNet is the correction", async () => {
    // Fixture repair (re-audit 2026-10-18): the delta math is asserted against
    // a DEDICATED vendor — the shared file-level vendor accumulated ACTIVE
    // employees with ACTIVE structures from the EXIT fixtures above, and
    // calculateRun sweeps every ACTIVE employee of the vendor, so the source
    // run totalled 7 × 50000 instead of this test's single 50000 structure.
    const deltaVendor = await mkVendor("R31 Pay001 Vendor")
    const deltaOwner = await mkUser(deltaVendor.id, { role: "VENDOR_OWNER", name: "R31 Pay001 Owner" })
    const deltaCtx = makeCtx(deltaOwner, ["*"])
    const vendorId = deltaVendor.id
    const emp = await db.employee.create({
      data: { vendorId, fullName: uniq("R31 Pay"), code: uniq("P"), joiningDate: "2026-01-01", employmentType: "PERMANENT", status: "ACTIVE" },
    })
    const struct = await db.salaryStructure.create({
      data: { vendorId, employeeId: emp.id, effectiveFrom: "2026-01-01", status: "ACTIVE", basic: 30000, gross: 50000 },
    })
    // no attendance + absence proration would wipe pay — disable for the fixture
    const { saveSettingsGroup } = await import("@/hrm-server/settings")
    await saveSettingsGroup(vendorId, "payroll", { absenceProration: false })

    const src = await db.payrollRun.create({
      data: { vendorId, periodMonth: 9, periodYear: 2026, periodWeek: 0, frequency: "MONTHLY", runType: "REGULAR", status: "DRAFT", createdBy: deltaOwner.id },
    })
    await calculateRun(deltaCtx, src.id)
    const srcRun = await db.payrollRun.findUnique({ where: { id: src.id } })
    expect(srcRun?.totalGross).toBe(50000)

    // the source run is disbursed (payRun's journal/notify path is not needed
    // to prove delta semantics — status PAID is what the delta engine checks)
    await db.payrollRun.update({ where: { id: src.id }, data: { status: "PAID" } })

    // HR corrects the structure retroactively
    await db.salaryStructure.update({ where: { id: struct.id }, data: { gross: 55000 } })

    const adjId = await createAdjustmentRun(deltaCtx, src.id)
    await calculateRun(deltaCtx, adjId)
    const adj = await db.payrollRun.findUnique({ where: { id: adjId } })

    // THE acceptance test: the adjustment carries the CORRECTION…
    expect(adj?.totalGross).toBe(5000)
    // …including the AIT correction that legitimately rides the delta: the
    // corrected structure (৳55,000 × the §86 projection) crosses the ৳4,00,000
    // taxable threshold, so the recomputation withholds the §86(4) catch-up on
    // the correction (৳67) — net 4933, never a second 55,000 month. (Fixture
    // repair, re-audit 2026-10-18: the original flat 5000 assumed a zero AIT
    // delta; the AIT-bootstrap timing fix made both calculations consistent
    // so the delta now deterministically carries the corrected withholding.)
    expect(adj?.totalNet).toBe(4933)
    // …not a second 55000 month
    expect(adj?.totalNet).not.toBe(srcRun?.totalNet)
    expect(adj?.runType).toBe("ADJUSTMENT")

    const entry = await db.payrollEntry.findFirst({ where: { runId: adjId } })
    expect(entry?.gross).toBe(5000)
    expect(entry?.ait).toBe(67) // the §86(4) catch-up on the corrected estimate
    expect(entry?.net).toBe(4933)
    expect(entry?.adjustEntryId).toBeTruthy()
    const bd = JSON.parse(entry?.breakdownJson || "{}")
    expect(bd.adjustment.note).toMatch(/not a second month/i)

    // recalculating the adjustment again is stable (same source, same correction)
    await calculateRun(deltaCtx, adjId)
    const adj2 = await db.payrollRun.findUnique({ where: { id: adjId } })
    expect(adj2?.totalNet).toBe(4933)
  })

  test("unchanged data → the adjustment run is an all-zero correction", async () => {
    const emp = await db.employee.create({
      data: { vendorId: vendor.id, fullName: uniq("R31 Pay2"), code: uniq("P"), joiningDate: "2026-01-01", employmentType: "PERMANENT", status: "ACTIVE" },
    })
    await db.salaryStructure.create({
      data: { vendorId: vendor.id, employeeId: emp.id, effectiveFrom: "2026-01-01", status: "ACTIVE", basic: 20000, gross: 40000 },
    })
    const src = await db.payrollRun.create({
      data: { vendorId: vendor.id, periodMonth: 10, periodYear: 2026, periodWeek: 0, frequency: "MONTHLY", runType: "REGULAR", status: "DRAFT", createdBy: owner.id },
    })
    await calculateRun(ctx, src.id)
    await db.payrollRun.update({ where: { id: src.id }, data: { status: "PAID" } })
    const adjId = await createAdjustmentRun(ctx, src.id)
    await calculateRun(ctx, adjId)
    const adj = await db.payrollRun.findUnique({ where: { id: adjId } })
    expect(adj?.totalGross).toBe(0)
    expect(adj?.totalNet).toBe(0) // ← was the FULL month before the fix
  })
})

describe("PAY-002 rogue runTypes are blocked at the dispatcher", () => {
  test("payroll.runs.create with runType BONUS → 400 with guidance", async () => {
    const r = await postHrm("payroll.runs.create", { periodMonth: 11, periodYear: 2026, runType: "BONUS" }, { bearer: token })
    expect(r.status).not.toBe(200)
  })
  test("payroll.runs.create with runType FINAL_SETTLEMENT → 400", async () => {
    const r = await postHrm("payroll.runs.create", { periodMonth: 11, periodYear: 2026, runType: "FINAL_SETTLEMENT" }, { bearer: token })
    expect(r.status).not.toBe(200)
  })
  test("a plain REGULAR run still creates fine", async () => {
    const r = await postHrm("payroll.runs.create", { periodMonth: 12, periodYear: 2026 }, { bearer: token })
    expect(r.status).toBe(200)
    expect(r.body.data.runType).toBe("REGULAR")
  })
})

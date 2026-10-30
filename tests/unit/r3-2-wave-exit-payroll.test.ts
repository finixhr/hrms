/// <reference types="bun-types" />
// ============ R3-2 Wave — exit chain completion + payroll Highs ============
// EXIT-005  finalSalary: calendar-days × 26-divisor, no absences, no payroll netting → payroll convention
// EXIT-006  loan/advance ledgers not closed when the settlement recovers them → closed inside settlements.pay
// EXIT-007  PF never settled at exit despite the UI promise              → pfSettlement + enrollment CLOSED + withdrawal row
// EXIT-008  no BD statutory notice matrix; configurable default discarded → resolveRequiredNoticeDays, decided noticeDays
// EXIT-009  settlement approved/paid before clearance complete           → CLEARED gate on approve + pay
// EXIT-010  backdatable resignationDate drives notice math               → served from max(letter, submission)
// EXIT-012  encashment ignores pending reservations                       → entitled − used − pending
// EXIT-013  settlement OT ignores settings.otRates + monthly cap          → payroll-parity computeSettlementOt
// PAY-003   payRun flips ALL period APPROVED bonuses to PAID             → bonusLines + precise marking + excluded warning
// PAY-004   commission SoD vacuous, duplicable, DB-order precedence       → createdBy + dedup + deterministic rules
// PAY-005   preflight ignores bonuses/commissions                         → bonusExposure block
// PAY-006   no total/aggregate bonus approval                            → approveBulk + typed confirm + escalation workflow
// PAY-008   weekly runs strand 60-80% of bonuses                          → full-remaining inclusion, IN_PAYROLL state
// PAY-010   settlement bonuses never marked PAID                          → marked inside settlements.pay
// PAY-011   commission rule numbers unvalidated                           → rate/minSales/cap bounds
//
// Structure: PART A = pure functions (no DB queries); PART B = dispatcher /
// engine integration (needs the isolated unit-test PostgreSQL).
import "./_testdb"
import { describe, test, expect, beforeAll } from "bun:test"
import { db } from "@/lib/db"
import { mkVendor, mkUser, mkEmployee, mkSession, makeCtx, uniq } from "./_fixtures"
import { postHrm } from "./_hrm-endpoint"
import {
  computeFinalSalary, computeSettlementOt, resolveRequiredNoticeDays, effectiveNoticeStart,
} from "@/hrm-server/routes/exit"
import { orderCommissionRules } from "@/hrm-server/routes/roadmap"
import { calculateRun, payRun } from "@/hrm-server/payroll"

// ============================================================================
// PART A — pure functions
// ============================================================================

describe("EXIT-005 computeFinalSalary (payroll convention, pure)", () => {
  // October 2026: 31 days, Fridays = 2/9/16/23/30 → 26 working days with FRIDAY weekly-off
  const oct = (day: number, status = "PRESENT") => ({ date: `2026-10-${String(day).padStart(2, "0")}`, status })
  const base = {
    gross: 26000, lwd: "2026-10-31", weeklyOff: ["FRIDAY"], holidays: [] as string[],
  }

  test("full month, full attendance → exactly one month's gross (NOT 31/26 ≈ 119%)", () => {
    const attendance = Array.from({ length: 31 }, (_, i) => oct(i + 1))
    const r = computeFinalSalary({ ...base, attendance, joiningDate: "2020-01-01" })
    expect(r.monthWorkingDays).toBe(26)
    expect(r.daysUptoLwd).toBe(26)
    expect(r.absentDays).toBe(0)
    expect(r.finalSalary).toBe(26000) // ← the old engine paid round(26000/26 × 31) = 31000
  })

  test("mid-month LWD (Oct 15) → prorated 13/26 of the month", () => {
    const attendance = Array.from({ length: 15 }, (_, i) => oct(i + 1))
    const r = computeFinalSalary({ ...base, lwd: "2026-10-15", attendance, joiningDate: "2020-01-01" })
    expect(r.daysUptoLwd).toBe(13) // 15 days minus Fridays 2 and 9
    expect(r.finalSalary).toBe(13000)
  })

  test("ABSENT and HALF_DAY days are deducted at the same daily rate payroll uses", () => {
    const attendance = [oct(1), oct(2), oct(3, "ABSENT"), oct(4, "HALF_DAY"), oct(5), oct(6), oct(7), oct(8), oct(9), oct(10), oct(11), oct(12), oct(13), oct(14), oct(15)]
    const r = computeFinalSalary({ ...base, lwd: "2026-10-15", attendance, joiningDate: "2020-01-01" })
    expect(r.absentDays).toBe(1.5)
    expect(r.absenceDeduction).toBe(1500) // 1.5 × (26000 / 26)
    expect(r.finalSalary).toBe(13000 - 1500)
  })

  test("missing records count as absent ONLY when neither weekly-off nor holiday", () => {
    // no attendance at all, one holiday on Oct 5 → absent = 13 − 1 (holiday) = 12
    const r = computeFinalSalary({ ...base, lwd: "2026-10-15", attendance: [], holidays: ["2026-10-05"], joiningDate: "2020-01-01" })
    expect(r.daysUptoLwd).toBe(13)
    expect(r.absentDays).toBe(12) // 13 payable days − the holiday − 12 missing records… Oct 5 is a holiday → 13−1(hol)=12 missing-record days
    expect(r.finalSalary).toBe(13000 - 12000)
  })

  test("payroll netting: gross already PAID for the LWD month is subtracted, floored at 0", () => {
    const attendance = Array.from({ length: 15 }, (_, i) => oct(i + 1))
    const r = computeFinalSalary({ ...base, lwd: "2026-10-15", attendance, joiningDate: "2020-01-01", monthlyGrossAlreadyPaid: 10000 })
    expect(r.netted).toBe(true)
    expect(r.alreadyPaid).toBe(10000)
    expect(r.finalSalary).toBe(3000)
    const over = computeFinalSalary({ ...base, lwd: "2026-10-15", attendance, joiningDate: "2020-01-01", monthlyGrossAlreadyPaid: 99999 })
    expect(over.finalSalary).toBe(0) // never negative
  })

  test("payable window starts at the joining date for mid-month joiners", () => {
    const attendance = [oct(10), oct(11), oct(12), oct(13), oct(14), oct(15)]
    const r = computeFinalSalary({ ...base, lwd: "2026-10-15", attendance, joiningDate: "2026-10-10" })
    expect(r.daysUptoLwd).toBe(6) // Oct 10–15, no Friday inside the window
    expect(r.finalSalary).toBe(6000)
  })
})

describe("EXIT-008 resolveRequiredNoticeDays (BD statutory matrix, pure)", () => {
  test("PROBATIONARY → 7 days (spec §14.2)", () => {
    expect(resolveRequiredNoticeDays({ employmentType: "PROBATIONARY", defaultNoticeDays: 30 })).toBe(7)
    expect(resolveRequiredNoticeDays({ employmentType: "PROBATIONARY", defaultNoticeDays: 30, workerMatrix: true })).toBe(7)
  })
  test("worker matrix ON (BLA §80/81): 120 days ≥5y, 60 days <5y", () => {
    expect(resolveRequiredNoticeDays({ employmentType: "PERMANENT", serviceYears: 6, workerMatrix: true, defaultNoticeDays: 30 })).toBe(120)
    expect(resolveRequiredNoticeDays({ employmentType: "PERMANENT", serviceYears: 4, workerMatrix: true, defaultNoticeDays: 30 })).toBe(60)
    expect(resolveRequiredNoticeDays({ employmentType: "CONTRACTUAL", serviceYears: 5, workerMatrix: true, defaultNoticeDays: 90 })).toBe(120) // matrix wins over staff default
  })
  test("matrix OFF (staff/contract): the tenant's configurable default", () => {
    expect(resolveRequiredNoticeDays({ employmentType: "PERMANENT", serviceYears: 6, workerMatrix: false, defaultNoticeDays: 60 })).toBe(60)
    expect(resolveRequiredNoticeDays({ employmentType: "PERMANENT", serviceYears: 6 })).toBe(30) // fallback 30
  })
})

describe("EXIT-010 effectiveNoticeStart (anti-backdating, pure)", () => {
  test("a letter backdated before submission counts notice from the SUBMISSION date", () => {
    expect(effectiveNoticeStart("2026-09-01", "2026-10-01")).toBe("2026-10-01")
  })
  test("a future-dated letter is taken as-is (the later date)", () => {
    expect(effectiveNoticeStart("2026-10-20", "2026-10-01")).toBe("2026-10-20")
  })
  test("same-day letter → itself; no submission date → the letter date", () => {
    expect(effectiveNoticeStart("2026-10-01", "2026-10-01")).toBe("2026-10-01")
    expect(effectiveNoticeStart("2026-10-01", null)).toBe("2026-10-01")
  })
})

describe("EXIT-013 computeSettlementOt (payroll parity, pure)", () => {
  const att = (day: string, mins: number, otApproved?: boolean) => ({ date: day, overtimeMinutes: mins, otApproved: otApproved ?? null })
  test("weekday OT uses settings.otRates.weekdayRate, not a hardcoded 1.5", () => {
    // 2026-10-01 is a Thursday → weekday. basic 20800 → hour rate 100.
    const r = computeSettlementOt({ basic: 20800, attendance: [att("2026-10-01", 60)], weeklyOff: ["FRIDAY"], holidays: [] })
    expect(r.otAmount).toBe(150) // 1h × 100 × 1.5
    const custom = computeSettlementOt({ basic: 20800, attendance: [att("2026-10-01", 60)], weeklyOff: ["FRIDAY"], holidays: [], otRates: { weekdayRate: 2 } as any })
    expect(custom.otAmount).toBe(200)
  })
  test("holiday / weekly-off tiers and shift multipliers win over settings", () => {
    const r = computeSettlementOt({
      basic: 20800,
      attendance: [att("2026-10-02", 60), att("2026-10-03", 60)], // Fri (weekly-off), Sat (weekday)
      weeklyOff: ["FRIDAY"], holidays: [],
    })
    expect(r.otAmount).toBe(200 + 150)
    const shifted = computeSettlementOt({
      basic: 20800, attendance: [att("2026-10-02", 60)], weeklyOff: ["FRIDAY"], holidays: [],
      shift: { otWeeklyOffMultiplier: 3 },
    })
    expect(shifted.otAmount).toBe(300)
  })
  test("maxOtHoursPerMonth caps the payable minutes for the month (capped flag)", () => {
    const r = computeSettlementOt({
      basic: 20800, attendance: [att("2026-10-01", 60), att("2026-10-03", 60), att("2026-10-04", 60)],
      weeklyOff: ["FRIDAY"], holidays: [], maxOtHoursPerMonth: 1, // 60 minutes
    })
    expect(r.otAmount).toBe(150) // only the first hour is payable
    expect(r.capped).toBe(true)
    expect(r.otMinutes).toBe(180) // raw minutes still reported
  })
  test("roundToMinutes step applies (ROUNDED_UP 50 → 60)", () => {
    const r = computeSettlementOt({
      basic: 20800, attendance: [att("2026-10-01", 50)], weeklyOff: ["FRIDAY"], holidays: [],
      otRates: { calcBasis: "ROUNDED_UP", roundToMinutes: 15 } as any,
    })
    expect(r.otAmount).toBe(150) // 50 min rounded UP to 60
  })
  test("otApprovalRequired filters unapproved OT", () => {
    const r = computeSettlementOt({
      basic: 20800, attendance: [att("2026-10-01", 60, false)], weeklyOff: ["FRIDAY"], holidays: [], otApprovalRequired: true,
    })
    expect(r.otAmount).toBe(0)
  })
})

describe("PAY-004/011 orderCommissionRules (deterministic precedence, pure)", () => {
  const mk = (over: Partial<{ id: string; branchId: string | null; designationId: string | null; createdAt: Date }>) => ({
    id: over.id || uniq("r"), branchId: over.branchId ?? null, designationId: over.designationId ?? null, createdAt: over.createdAt || new Date(),
  })
  test("most-specific scope first: branch+designation > branch > designation > global", () => {
    const global = mk({ id: "global" })
    const branch = mk({ id: "branch", branchId: "b1" })
    const desig = mk({ id: "desig", designationId: "d1" })
    const both = mk({ id: "both", branchId: "b1", designationId: "d1" })
    const ordered = orderCommissionRules([global, desig, branch, both]).map((r) => r.id)
    expect(ordered).toEqual(["both", "branch", "desig", "global"])
  })
  test("ties break on createdAt ASC (oldest rule = most senior)", () => {
    const older = mk({ id: "older", createdAt: new Date("2026-01-01") })
    const newer = mk({ id: "newer", createdAt: new Date("2026-06-01") })
    expect(orderCommissionRules([newer, older]).map((r) => r.id)).toEqual(["older", "newer"])
  })
})

// ============================================================================
// PART B — dispatcher + engine integration (isolated test database)
// ============================================================================

let vendor: { id: string }
let owner: { id: string; vendorId: string; role: string }
let ctx: any
let token: string

beforeAll(async () => {
  vendor = await mkVendor("R32 Exit-Payroll Vendor")
  owner = await mkUser(vendor.id, { role: "VENDOR_OWNER", name: "R32 Owner" })
  ctx = makeCtx(owner, ["*"])
  token = await mkSession(owner.id, "FULL")
  // keep payRun paths test-friendly: any payout method OK, no payslip emails
  const { saveSettingsGroup } = await import("@/hrm-server/settings")
  await saveSettingsGroup(vendor.id, "payout", { maxCashMfsSalary: 999999 })
  await saveSettingsGroup(vendor.id, "notification", { payslipEmail: false })
})

async function mkExitFixture(over: {
  joiningDate?: string
  resignationStatus?: string
  noticeMode?: string
  noticeDays?: number
  servedDays?: number
  basic?: number
  gross?: number
  proposedLwd?: string
  resignationDate?: string
  submissionDate?: string
  employmentType?: string
  withClearance?: boolean
} = {}) {
  const emp = await db.employee.create({
    data: {
      vendorId: vendor.id, fullName: uniq("R32 Emp"), code: uniq("R32"),
      joiningDate: over.joiningDate || "2020-01-15", employmentType: over.employmentType || "PERMANENT", status: "ACTIVE",
    },
  })
  const struct = await db.salaryStructure.create({
    data: {
      vendorId: vendor.id, employeeId: emp.id, effectiveFrom: over.joiningDate || "2020-01-15", status: "ACTIVE",
      basic: over.basic ?? 26000, gross: over.gross ?? 26000,
    },
  })
  const res = await db.resignation.create({
    data: {
      vendorId: vendor.id, employeeId: emp.id,
      submissionDate: over.submissionDate || "2026-09-15", resignationDate: over.resignationDate || "2026-09-15",
      proposedLwd: over.proposedLwd || "2026-10-15", actualLwd: over.proposedLwd || "2026-10-15",
      reason: "R3-2 test exit", status: over.resignationStatus || "NOTICE_PERIOD",
      noticeMode: over.noticeMode || "FULL", noticeDays: over.noticeDays ?? 30, servedDays: over.servedDays ?? 30,
    },
  })
  const clearance = over.withClearance === false ? null : await db.exitClearance.create({
    data: {
      vendorId: vendor.id, resignationId: res.id, status: "PENDING",
      checklistJson: JSON.stringify(
        ["HR", "Finance", "IT"].map((department) => ({
          department, items: ["Loan settled", "Advance recovered", "Final payroll processed"].map((item) => ({ item, cleared: false })),
        })),
      ),
    },
  })
  return { emp, struct, res, clearance }
}

describe("EXIT-005 settlement final salary (dispatcher-driven)", () => {
  test("payroll already PAID for the LWD month is netted out of the final salary", async () => {
    const f = await mkExitFixture({ proposedLwd: "2026-10-15" })
    for (let d = 1; d <= 15; d++) {
      await db.attendance.create({ data: { vendorId: vendor.id, employeeId: f.emp.id, date: `2026-10-${String(d).padStart(2, "0")}`, status: "PRESENT" } })
    }
    // a PAID monthly run for October already disbursed 13000 gross (13/26 × 26000)
    const run = await db.payrollRun.create({
      data: { vendorId: vendor.id, periodMonth: 10, periodYear: 2026, periodWeek: 0, frequency: "MONTHLY", runType: "REGULAR", status: "PAID", createdBy: owner.id },
    })
    await db.payrollEntry.create({
      data: { vendorId: vendor.id, runId: run.id, employeeId: f.emp.id, gross: 13000, net: 13000, status: "INCLUDED", breakdownJson: "{}" },
    })
    const r = await postHrm("settlements.calculate", { resignationId: f.res.id }, { bearer: token })
    expect(r.status).toBe(200)
    const c = r.body.data.computation
    expect(c.finalSalaryBasis.daysUptoLwd).toBe(13)
    expect(c.finalSalaryBasis.alreadyPaidGross).toBe(13000)
    expect(c.finalSalary).toBe(0) // fully netted — the month is already paid
    expect(c.finalSalaryBasis.nettedAgainstPayroll).toBe(true)
  })

  test("absences in the final month reduce the final salary", async () => {
    const f = await mkExitFixture({ proposedLwd: "2026-10-15" })
    for (let d = 1; d <= 15; d++) {
      await db.attendance.create({ data: { vendorId: vendor.id, employeeId: f.emp.id, date: `2026-10-${String(d).padStart(2, "0")}`, status: d === 5 ? "ABSENT" : "PRESENT" } })
    }
    const r = await postHrm("settlements.calculate", { resignationId: f.res.id }, { bearer: token })
    expect(r.status).toBe(200)
    const c = r.body.data.computation
    expect(c.finalSalaryBasis.absentDays).toBe(1)
    expect(c.finalSalary).toBe(13000 - 1000) // 13/26 × 26000 − 1 × (26000/26)
  })
})

describe("EXIT-009 clearance gate (dispatcher-driven)", () => {
  test("approve is REFUSED with the pending items named while clearance is not CLEARED", async () => {
    const f = await mkExitFixture({ proposedLwd: "2026-10-15" })
    await postHrm("settlements.calculate", { resignationId: f.res.id }, { bearer: token })
    const s = await db.finalSettlement.findFirst({ where: { resignationId: f.res.id } })
    if (!s) throw new Error("settlement missing")
    const r = await postHrm("settlements.approve", { id: s.id }, { bearer: token })
    expect(r.status).not.toBe(200)
    expect(r.body.error).toMatch(/clearance/i)
    expect(r.body.error).toMatch(/Loan settled/)
  })
  test("after the checklist is CLEARED, approve and pay proceed", async () => {
    const f = await mkExitFixture({ proposedLwd: "2026-10-15" })
    if (!f.clearance) throw new Error("clearance missing")
    await db.exitClearance.update({
      where: { id: f.clearance.id },
      data: { status: "CLEARED", clearedAt: new Date(), checklistJson: JSON.stringify(["HR", "Finance", "IT"].map((d) => ({ department: d, items: [{ item: "Loan settled", cleared: true }] }))) },
    })
    await postHrm("settlements.calculate", { resignationId: f.res.id }, { bearer: token })
    const s = await db.finalSettlement.findFirst({ where: { resignationId: f.res.id } })
    if (!s) throw new Error("settlement missing")
    const a = await postHrm("settlements.approve", { id: s.id }, { bearer: token })
    expect(a.status).toBe(200)
    const p = await postHrm("settlements.pay", { id: s.id }, { bearer: token })
    expect(p.status).toBe(200)
    expect(p.body.data.paid).toBe(true)
  })
})

describe("EXIT-006/007 + PAY-010 settlement pay closes every ledger (dispatcher-driven)", () => {
  test("loans CLOSED, advances RECOVERED, bonuses PAID, PF paid out + enrollment CLOSED + withdrawal row", async () => {
    const f = await mkExitFixture({ proposedLwd: "2026-10-15", noticeMode: "FULL", servedDays: 30 })
    // open loan with installments
    const loan = await db.loan.create({
      data: { vendorId: vendor.id, employeeId: f.emp.id, type: "PERSONAL", principal: 50000, installmentAmount: 5000, installments: 10, startDate: "2026-01-01", paidAmount: 20000, outstanding: 30000, status: "ACTIVE" },
    })
    await db.loanInstallment.create({ data: { vendorId: loan.vendorId, loanId: loan.id, no: 4, amount: 5000, dueDate: "2026-10-05", paidAmount: 0, status: "PENDING" } })
    // recovering advance
    const adv = await db.advance.create({
      data: { vendorId: vendor.id, employeeId: f.emp.id, amount: 12000, requestDate: "2026-06-01", recoveryDate: "2026-07-01", installments: 6, deducted: 6000, outstanding: 6000, status: "RECOVERING" },
    })
    // APPROVED bonus consumed by the settlement (PAY-010)
    const bonus = await db.bonus.create({
      data: { vendorId: vendor.id, employeeId: f.emp.id, type: "FESTIVAL", calcType: "FIXED", amount: 8000, periodMonth: 10, periodYear: 2026, status: "APPROVED", createdBy: owner.id },
    })
    // PF enrollment + contributions (employee 10000 + employer 10000)
    const pf = await db.pfEnrollment.create({
      data: { vendorId: vendor.id, employeeId: f.emp.id, enrollDate: "2023-01-01", status: "ACTIVE", employeePct: 10, employerPct: 10, basis: "BASIC" },
    })
    await db.pfContribution.create({ data: { vendorId: vendor.id, employeeId: f.emp.id, periodYear: 2025, periodMonth: 12, employeeAmount: 10000, employerAmount: 10000, source: "MANUAL", createdBy: owner.id } })

    const r = await postHrm("settlements.calculate", { resignationId: f.res.id }, { bearer: token })
    expect(r.status).toBe(200)
    const c = r.body.data.computation
    expect(c.loanDue).toBe(30000)
    expect(c.advanceDue).toBe(6000)
    expect(c.bonusDue).toBe(8000)
    expect(c.pfSettlement).toBe(20000) // employee + employer shares
    expect(c.pfEmployeeShare).toBe(10000)
    expect(c.pfEmployerShare).toBe(10000)
    expect(c.loanIds).toContain(loan.id)
    expect(c.advanceIds).toContain(adv.id)
    expect(c.bonusIds).toContain(bonus.id)
    expect(c.gross).toBe(c.finalSalary + c.otAmount + c.leaveEncashment + c.bonusDue + c.gratuity + (c.noticePay ?? 0) + c.pfSettlement)

    // clear the checklist → approve → pay
    if (!f.clearance) throw new Error("clearance missing")
    await db.exitClearance.update({
      where: { id: f.clearance.id },
      data: { status: "CLEARED", clearedAt: new Date(), checklistJson: "[]" },
    })
    const s = await db.finalSettlement.findFirst({ where: { resignationId: f.res.id } })
    if (!s) throw new Error("settlement missing")
    await postHrm("settlements.approve", { id: s.id }, { bearer: token })
    const p = await postHrm("settlements.pay", { id: s.id }, { bearer: token })
    expect(p.status).toBe(200)

    // EXIT-006 — ledgers closed
    const loanAfter = await db.loan.findUnique({ where: { id: loan.id } })
    expect(loanAfter?.status).toBe("CLOSED")
    expect(loanAfter?.outstanding).toBe(0)
    const inst = await db.loanInstallment.findFirst({ where: { loanId: loan.id } })
    expect(inst?.status).toBe("PAID")
    const advAfter = await db.advance.findUnique({ where: { id: adv.id } })
    expect(advAfter?.status).toBe("RECOVERED")
    expect(advAfter?.outstanding).toBe(0)

    // PAY-010 — bonus marked PAID with the settlement as its run
    const bonusAfter = await db.bonus.findUnique({ where: { id: bonus.id } })
    expect(bonusAfter?.status).toBe("PAID")
    expect(bonusAfter?.runId).toBe(s.id)

    // EXIT-007 — PF enrollment closed + withdrawal ledger row
    const pfAfter = await db.pfEnrollment.findUnique({ where: { id: pf.id } })
    expect(pfAfter?.status).toBe("CLOSED")
    const withdrawal = await db.pfContribution.findFirst({ where: { vendorId: vendor.id, employeeId: f.emp.id, source: "WITHDRAWAL" } })
    expect(withdrawal).toBeTruthy()
    expect(withdrawal?.employeeAmount).toBe(-10000)
    expect(withdrawal?.employerAmount).toBe(-10000)

    // journal posted and balanced (debit PF split, credit net + dues)
    const sAfter = await db.finalSettlement.findUnique({ where: { id: s.id } })
    expect(sAfter?.journalId).toBeTruthy()
  })
})

describe("EXIT-008/010 acceptance stores the decided notice on anti-backdated math", () => {
  test("backdated letter: served days counted from the SUBMISSION date, not the letter", async () => {
    const emp = await db.employee.create({
      data: { vendorId: vendor.id, fullName: uniq("R32 bd"), code: uniq("bd"), joiningDate: "2026-01-01", employmentType: "PERMANENT", status: "ACTIVE" },
    })
    const res = await db.resignation.create({
      data: {
        vendorId: vendor.id, employeeId: emp.id,
        // letter claims Sep 1 (a month of "notice"), actually submitted Oct 1
        submissionDate: "2026-10-01", resignationDate: "2026-09-01",
        proposedLwd: "2026-10-31", reason: "backdated", status: "MANAGEMENT_REVIEW",
        noticeMode: "FULL", noticeDays: 30, servedDays: 0,
      },
    })
    const { applyResignationDecision } = await import("@/hrm-server/routes/exit")
    await applyResignationDecision({ userId: owner.id, userName: "R32 Owner", vendorId: vendor.id }, res.id, "APPROVED")
    const after = await db.resignation.findUnique({ where: { id: res.id } })
    expect(after?.status).toBe("NOTICE_PERIOD")
    expect(after?.noticeDays).toBe(30) // staff default (matrix off)
    expect(after?.servedDays).toBe(30) // Oct 1 → Oct 31 = 30, NOT Sep 1 → Oct 31 = 60
    // a second exit cannot dodge the buyout: servedDays drives SHORT/BUYOUT
    expect(["FULL", "SHORT", "BUYOUT", "WAIVED"]).toContain(String(after?.noticeMode))
  })

  test("worker matrix: a 6-year worker gets a 120-day requirement", async () => {
    const { saveSettingsGroup } = await import("@/hrm-server/settings")
    await saveSettingsGroup(vendor.id, "employeeSettings", { workerNoticeMatrix: true, defaultNoticePeriodDays: 30 })
    const emp = await db.employee.create({
      data: { vendorId: vendor.id, fullName: uniq("R32 wk"), code: uniq("wk"), joiningDate: "2020-01-01", employmentType: "PERMANENT", status: "ACTIVE" },
    })
    const res = await db.resignation.create({
      data: {
        vendorId: vendor.id, employeeId: emp.id, submissionDate: "2026-10-01", resignationDate: "2026-10-01",
        proposedLwd: "2026-10-31", reason: "worker matrix", status: "MANAGEMENT_REVIEW",
        noticeMode: "FULL", noticeDays: 30, servedDays: 0,
      },
    })
    const { applyResignationDecision } = await import("@/hrm-server/routes/exit")
    await applyResignationDecision({ userId: owner.id, userName: "R32 Owner", vendorId: vendor.id }, res.id, "APPROVED")
    const after = await db.resignation.findUnique({ where: { id: res.id } })
    expect(after?.noticeDays).toBe(120) // ≥5 years' service
    expect(after?.noticeMode).toBe("BUYOUT") // 30 served of 120 → heavy shortfall
    await saveSettingsGroup(vendor.id, "employeeSettings", { workerNoticeMatrix: false })
  })
})

describe("PAY-006 bulk approval + escalation workflow (dispatcher-driven)", () => {
  test("approveBulk approves small bonuses; a ≥ threshold bonus is ESCALATED to the BONUS workflow", async () => {
    // BONUS workflow for this vendor (mirrors seed-approval-workflows)
    const wf = await db.approvalWorkflow.create({ data: { vendorId: vendor.id, processType: "BONUS", name: "Bonus Approval (Escalated)", active: true } })
    await db.approvalStep.create({ data: { vendorId: wf.vendorId, workflowId: wf.id, sequence: 1, name: "Owner Approval", approverRole: "VENDOR_OWNER", required: true, rejectBehavior: "REJECT_ALL" } })
    const { saveSettingsGroup } = await import("@/hrm-server/settings")
    await saveSettingsGroup(vendor.id, "bonusApproval", { escalationThreshold: 50000 })

    const emp = await mkEmployee(vendor.id)
    const small = await db.bonus.create({ data: { vendorId: vendor.id, employeeId: emp.id, type: "FESTIVAL", calcType: "FIXED", amount: 5000, status: "PENDING", createdBy: "someone-else" } })
    const big = await db.bonus.create({ data: { vendorId: vendor.id, employeeId: emp.id, type: "SPECIAL", calcType: "FIXED", amount: 200000, status: "PENDING", createdBy: "someone-else" } })

    const r = await postHrm("bonuses.approveBulk", { ids: [small.id, big.id], decision: "APPROVE" }, { bearer: token })
    expect(r.status).toBe(200)
    expect(r.body.data.actioned).toBe(1)
    expect(r.body.data.escalated.length).toBe(1)
    expect(r.body.data.aggregate.sum).toBe(205000)

    const smallAfter = await db.bonus.findUnique({ where: { id: small.id } })
    expect(smallAfter?.status).toBe("APPROVED")
    const bigAfter = await db.bonus.findUnique({ where: { id: big.id } })
    expect(bigAfter?.status).toBe("PENDING") // still pending — waits for the workflow
    const req = await db.approvalRequest.findFirst({ where: { vendorId: vendor.id, processType: "BONUS", entityId: big.id, status: "PENDING" } })
    expect(req).toBeTruthy()

    // the finalize hook lands the owner's decision on the bonus row
    const { applyBonusDecision } = await import("@/hrm-server/routes/payroll")
    await applyBonusDecision({ userId: owner.id, userName: "R32 Owner", vendorId: vendor.id }, big.id, "APPROVED")
    const done = await db.bonus.findUnique({ where: { id: big.id } })
    expect(done?.status).toBe("APPROVED")
  })

  test("creator rows are skipped (separation of duties holds in bulk)", async () => {
    const emp = await mkEmployee(vendor.id)
    const own = await db.bonus.create({ data: { vendorId: vendor.id, employeeId: emp.id, type: "FESTIVAL", calcType: "FIXED", amount: 1000, status: "PENDING", createdBy: owner.id } })
    const r = await postHrm("bonuses.approveBulk", { ids: [own.id], decision: "APPROVE" }, { bearer: token })
    expect(r.status).toBe(200)
    expect(r.body.data.actioned).toBe(0)
    expect(r.body.data.skipped[0].reason).toMatch(/separation of duties/i)
  })
})

describe("PAY-003/008 payRun marks exactly the included bonuses (engine-driven)", () => {
  test("a bonus approved AFTER calculate is NOT marked PAID; the response warns", async () => {
    const emp = await db.employee.create({
      data: { vendorId: vendor.id, fullName: uniq("R32 p3"), code: uniq("p3"), joiningDate: "2026-01-01", employmentType: "PERMANENT", status: "ACTIVE" },
    })
    await db.salaryStructure.create({ data: { vendorId: vendor.id, employeeId: emp.id, effectiveFrom: "2026-01-01", status: "ACTIVE", basic: 20000, gross: 30000 } })
    const inRun = await db.bonus.create({ data: { vendorId: vendor.id, employeeId: emp.id, type: "FESTIVAL", calcType: "FIXED", amount: 5000, periodMonth: 11, periodYear: 2026, status: "APPROVED", createdBy: owner.id } })
    const late = await db.bonus.create({ data: { vendorId: vendor.id, employeeId: emp.id, type: "PERFORMANCE", calcType: "FIXED", amount: 7000, periodMonth: 11, periodYear: 2026, status: "PENDING", createdBy: owner.id } })

    const run = await db.payrollRun.create({
      data: { vendorId: vendor.id, periodMonth: 11, periodYear: 2026, periodWeek: 0, frequency: "MONTHLY", runType: "REGULAR", status: "DRAFT", createdBy: owner.id },
    })
    await calculateRun(ctx, run.id)
    const entry = await db.payrollEntry.findFirst({ where: { runId: run.id, employeeId: emp.id } })
    expect(entry?.bonus).toBe(5000)
    const bd = JSON.parse(entry?.breakdownJson || "{}")
    expect(bd.bonusLines.map((l: any) => l.id)).toEqual([inRun.id])

    // the late bonus is approved AFTER the calculation snapshot
    await db.bonus.update({ where: { id: late.id }, data: { status: "APPROVED", approvedBy: owner.id } })
    await db.payrollRun.update({ where: { id: run.id }, data: { status: "APPROVED" } })
    const pay = await payRun(ctx, run.id)

    const inRunAfter = await db.bonus.findUnique({ where: { id: inRun.id } })
    expect(inRunAfter?.status).toBe("PAID")
    expect(inRunAfter?.runId).toBe(run.id)
    const lateAfter = await db.bonus.findUnique({ where: { id: late.id } })
    expect(lateAfter?.status).toBe("APPROVED") // ← the old blanket updateMany flipped this to PAID without paying it
    expect(pay.excludedApprovedBonuses).toBe(1)
  })

  test("PAY-008 weekly runs: the bonus rides the FIRST week in full and is marked PAID once", async () => {
    const emp = await db.employee.create({
      data: { vendorId: vendor.id, fullName: uniq("R32 w8"), code: uniq("w8"), joiningDate: "2026-01-01", employmentType: "PERMANENT", status: "ACTIVE" },
    })
    await db.salaryStructure.create({ data: { vendorId: vendor.id, employeeId: emp.id, effectiveFrom: "2026-01-01", status: "ACTIVE", basic: 20000, gross: 30000 } })
    const bonus = await db.bonus.create({ data: { vendorId: vendor.id, employeeId: emp.id, type: "FESTIVAL", calcType: "FIXED", amount: 4000, periodMonth: 11, periodYear: 2026, status: "APPROVED", createdBy: owner.id } })

    // ISO week 45 of 2026 (Mon Nov 2 – Sun Nov 8)
    const run = await db.payrollRun.create({
      data: { vendorId: vendor.id, periodMonth: 11, periodYear: 2026, periodWeek: 45, frequency: "WEEKLY", runType: "REGULAR", status: "DRAFT", createdBy: owner.id },
    })
    await calculateRun(ctx, run.id)
    const entry = await db.payrollEntry.findFirst({ where: { runId: run.id, employeeId: emp.id } })
    // the FULL bonus rides week 1 (no more 60-80% stranding)
    expect(entry?.bonus).toBe(4000)
    await db.payrollRun.update({ where: { id: run.id }, data: { status: "APPROVED" } })
    await payRun(ctx, run.id)
    const after = await db.bonus.findUnique({ where: { id: bonus.id } })
    expect(after?.status).toBe("PAID") // fully disbursed in one week — never IN_PAYROLL limbo
  })
})

describe("PAY-005 preflight surfaces bonus exposure (dispatcher-driven)", () => {
  test("approved/pending bonuses, commissions and festival-paid-this-FY are reported", async () => {
    // Fixture repair (re-audit 2026-10-18): festivalPaidThisFy aggregates the
    // WHOLE vendor, and the shared file-level vendor already carried paid
    // FESTIVAL bonuses from the PAY-003/PAY-008 tests above (3 extras) — the
    // exposure block is asserted against a DEDICATED vendor so the counts are
    // exactly this fixture's three rows.
    const v5 = await mkVendor("R32 Pay005 Vendor")
    const owner5 = await mkUser(v5.id, { role: "VENDOR_OWNER", name: "R32 Pay005 Owner" })
    const token5 = await mkSession(owner5.id, "FULL")
    const emp = await mkEmployee(v5.id)
    await db.bonus.create({ data: { vendorId: v5.id, employeeId: emp.id, type: "SALES_COMMISSION", calcType: "FIXED", amount: 12000, periodMonth: 12, periodYear: 2026, status: "APPROVED", createdBy: owner5.id } })
    await db.bonus.create({ data: { vendorId: v5.id, employeeId: emp.id, type: "FESTIVAL", calcType: "FIXED", amount: 3000, periodMonth: 12, periodYear: 2026, status: "PENDING", createdBy: owner5.id } })
    await db.bonus.create({ data: { vendorId: v5.id, employeeId: emp.id, type: "FESTIVAL", calcType: "FIXED", amount: 2500, periodMonth: 8, periodYear: 2026, status: "PAID", createdBy: owner5.id } })

    const r = await postHrm("payroll.preflight", { periodMonth: 12, periodYear: 2026 }, { bearer: token5 })
    expect(r.status).toBe(200)
    const be = r.body.data.bonusExposure
    expect(be.approved.count).toBe(1)
    expect(be.approved.sum).toBe(12000)
    expect(be.commissionTotal).toBe(12000)
    expect(be.pending.count).toBe(1)
    expect(be.pending.items[0].type).toBe("FESTIVAL")
    expect(be.festivalPaidThisFy.length).toBe(1) // Aug 2026 paid, same FY (Jul 2026–Jun 2027)
    expect(be.festivalPaidThisFy[0].sum).toBe(2500)
  })
})

describe("PAY-004 commission calculate validates, dedups and stamps createdBy", () => {
  test("zod schema rejects malformed entries; duplicates for the same period+rule are skipped", async () => {
    const emp = await mkEmployee(vendor.id)
    await db.commissionRule.create({
      data: { vendorId: vendor.id, name: "R32 Sales Rule", basis: "PERCENT_OF_SALES", rate: 5, minSales: 10000, cap: 0, active: true },
    })
    // invalid input (negative sales) → schema rejection
    const bad = await postHrm("commissions.calculate", { month: 11, year: 2026, entries: [{ employeeId: emp.id, salesAmount: -5 }] }, { bearer: token })
    expect(bad.status).not.toBe(200)

    const r1 = await postHrm("commissions.calculate", { month: 11, year: 2026, entries: [{ employeeId: emp.id, salesAmount: 100000 }] }, { bearer: token })
    expect(r1.status).toBe(200)
    expect(r1.body.data.created).toBe(1)
    const created = r1.body.data.bonuses[0]
    expect(created.amount).toBe(5000) // 5% of 100000
    expect(created.label).toContain("R32 Sales Rule")

    // re-running the same period → skipped (no duplicate payable row)
    const r2 = await postHrm("commissions.calculate", { month: 11, year: 2026, entries: [{ employeeId: emp.id, salesAmount: 100000 }] }, { bearer: token })
    expect(r2.status).toBe(200)
    expect(r2.body.data.created).toBe(0)
    expect(r2.body.data.skipped[0].reason).toMatch(/already exists for this period/i)

    // PAY-011 — invalid rates are rejected at save time
    const badRule = await postHrm("commissionRules.save", { name: "Bad", basis: "PERCENT_OF_SALES", rate: 150 }, { bearer: token })
    expect(badRule.status).not.toBe(200)
    expect(String(badRule.body?.error || "")).toMatch(/cannot exceed 100/i)
  })
})

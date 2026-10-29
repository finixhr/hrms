/// <reference types="bun-types" />
// ============ R3-4 Wave — leave money, loan recovery & attendance integrity ============
// LVE-001   unpaid (LWP) leave fully paid by payroll                          → LEAVE_UNPAID rows + payroll absence path
// LVE-002   carried-forward days unspendable; 4 balance formulas             → canonical spendableDays() everywhere
// LVE-005   encashment reservation racy; finalize resolves wrong approval    → H-9 tx + approval-id resolution + guarded decrements
// LVE-006   encashmentCap DAYS vs TAKA between the two paths                 → DAYS everywhere (encashableDaysFor)
// LOA-001   missed installments never auto-recovered; OVERDUE never set      → arrears budgeting + daily OVERDUE sweep
// LOA-002   manual installment payment race + no journal                      → guarded increments + LOAN_RECOVER journal
// ADV-001   no minimum take-home floor for the borrower                      → recoveryMaxPctOfNet floor (loan-math)
// ADV-002   advance amount-vs-salary cap                                     → advanceMaxPctOfMonthlyGross at create
// PAY-010b  settlement income disbursed with no AIT withholding              → §86 computeAit on salary-like components
// EXIT-011  settlements.calculate schema-less; negative otherDeductions     → S.settlementCalculate zod
// ATT-303   ABSENT never materialized (reports read ~0)                       → daily sweep writes missing days
// ATT-305/306/308/311 + LOA-005 — pre-R3-4 tree remnants re-verified below
// WF-001    no timeout escalation for pending approvals                       → daily reminder/escalation digest (jobs.ts)
//
// Structure: PART A = pure functions (no DB queries); PART B = dispatcher /
// engine integration (needs the isolated unit-test PostgreSQL).
import "./_testdb"
import { describe, test, expect, beforeAll } from "bun:test"
import { db } from "@/lib/db"
import { mkVendor, mkUser, mkEmployee, mkSession, uniq } from "./_fixtures"
import { postHrm } from "./_hrm-endpoint"
import { spendableDays, entitledFloor, encashableDaysFor } from "@/hrm-server/leave-math"
import { dueInstallmentsFor, dueAmountFor, applyRecoveryFloor } from "@/hrm-server/loan-math"
import { computeAttendance } from "@/hrm-server/routes/attendance"
import { applyLeaveDecision, applyEncashmentDecision } from "@/hrm-server/routes/leave"
import { materializeAbsentDay, loanOverdueSweep } from "@/hrm-server/jobs"
import { S } from "@/hrm-server/validation"

// Dates: today is the deployment-zone day; leave may be backdated at most 7
// days (settings.leave.maxBackdateDays). All apply-scenario windows start
// 2026-10-12+ (within the limit when the suite runs on 2026-10-17).
const FROM_OK = "2026-10-12"

// ============================================================================
// PART A — pure functions
// ============================================================================

describe("LVE-002 spendableDays — THE canonical balance formula", () => {
  test("entitled + carriedForward − used − pending", () => {
    expect(spendableDays({ entitled: 10, carriedForward: 3, used: 2, pending: 1 })).toBe(10)
    expect(spendableDays({ entitled: 10, carriedForward: 0, used: 2, pending: 1 })).toBe(7)
  })
  test("carried-forward days ARE spendable (the audit's core complaint)", () => {
    expect(spendableDays({ entitled: 10, carriedForward: 3, used: 2, pending: 0 })).toBe(11)
  })
  test("null/undefined fields default to 0 (never NaN)", () => {
    expect(spendableDays({ entitled: 10, used: 2 })).toBe(8)
    expect(spendableDays({ entitled: 10, used: 2, pending: undefined, carriedForward: null })).toBe(8)
    expect(spendableDays(null)).toBe(0)
    expect(spendableDays(undefined)).toBe(0)
  })
  test("half-day granularity rounds to 2 decimals (no float dust)", () => {
    expect(spendableDays({ entitled: 10, carriedForward: 0, used: 2.5, pending: 0.5 })).toBe(7)
    expect(spendableDays({ entitled: 10, used: 0.1 })).toBe(9.9)
  })
  test("negative results pass through (a corrupt ledger stays VISIBLE)", () => {
    expect(spendableDays({ entitled: 2, used: 5, pending: 0 })).toBe(-3)
  })
})

describe("LVE-008 entitledFloor — recompute never strands an over-committed ledger", () => {
  test("defaultDays is the target when nothing is committed", () => {
    expect(entitledFloor(10, 0, 0)).toBe(10)
  })
  test("floor binds when committed exceeds defaultDays minus carry", () => {
    expect(entitledFloor(10, 18, 3)).toBe(15)
    expect(entitledFloor(10, 25, 0)).toBe(25)
  })
  test("never negative, even with nonsense inputs", () => {
    expect(entitledFloor(0, 0, 0)).toBe(0)
    expect(entitledFloor(-5, -3, -2)).toBe(0)
  })
  test("the floor accounts for carriedForward (Design B: carry stays separate)", () => {
    expect(entitledFloor(10, 12, 5)).toBe(10) // target above the floor
    expect(entitledFloor(5, 12, 5)).toBe(7)   // floor binds above target
  })
})

describe("LVE-006 encashableDaysFor — DAYS-valued cap on both encashment paths", () => {
  test("cap 0 / negative / NaN = uncapped", () => {
    expect(encashableDaysFor(8, 0)).toBe(8)
    expect(encashableDaysFor(8, -3)).toBe(8)
    expect(encashableDaysFor(8, Number.NaN)).toBe(8)
  })
  test("cap truncates the DAYS, never a taka amount", () => {
    expect(encashableDaysFor(12, 5)).toBe(5)   // the old exit path paid ৳5 instead
    expect(encashableDaysFor(3, 5)).toBe(3)
  })
  test("negative / invalid spendable floors at 0", () => {
    expect(encashableDaysFor(-2, 5)).toBe(0)
    expect(encashableDaysFor(Number.NaN, 5)).toBe(0)
  })
})

describe("LOA-001 dueInstallmentsFor — arrears budgeting (calc == ledger)", () => {
  const inst = (no: number, due: string, amount: number, paid = 0) => ({ id: `i${no}`, no, dueDate: due, amount, paidAmount: paid })
  test("arrearsMax 0 = the historical current-month-only behaviour", () => {
    const rows = [inst(1, "2026-07-10", 5000), inst(2, "2026-08-10", 5000), inst(3, "2026-09-10", 5000)]
    expect(dueInstallmentsFor(rows, "2026-09", 0)).toEqual([rows[2]])
  })
  test("missed EMIs are picked up oldest-first, capped at 1 + arrearsMax", () => {
    const rows = [inst(1, "2026-06-10", 5000), inst(2, "2026-07-10", 5000), inst(3, "2026-08-10", 5000), inst(4, "2026-09-10", 5000), inst(5, "2026-10-10", 5000)]
    expect(dueInstallmentsFor(rows, "2026-09", 2)).toEqual([rows[1], rows[2], rows[3]]) // July + August arrears + current
  })
  test("future-dated and fully-paid installments never budget", () => {
    const rows = [inst(1, "2026-09-05", 5000, 5000), inst(2, "2026-10-05", 5000)]
    expect(dueInstallmentsFor(rows, "2026-09", 3)).toEqual([])
  })
  test("partial payments re-budget only the remainder", () => {
    const rows = [inst(1, "2026-08-10", 5000, 2000), inst(2, "2026-09-10", 5000)]
    const due = dueInstallmentsFor(rows, "2026-09", 1)
    expect(dueAmountFor(due)).toBe(3000 + 5000)
  })
  test("weekly fraction prorates the budgeted amount", () => {
    const due = dueInstallmentsFor([inst(1, "2026-09-10", 5000)], "2026-09", 0)
    expect(dueAmountFor(due, 0.25)).toBe(1250)
  })
})

describe("ADV-001/PAY-009 applyRecoveryFloor — minimum take-home floor", () => {
  test("floorPct 0 = disabled (historical behaviour)", () => {
    const r = applyRecoveryFloor(8000, 2000, 5000, 0)
    expect(r).toEqual({ loanDeduction: 8000, advanceDeduction: 2000, deferred: 0, capped: false })
  })
  test("recovery under the cap passes through untouched", () => {
    const r = applyRecoveryFloor(4000, 1000, 10_000, 50) // cap 5000, recovery 5000
    expect(r.capped).toBe(false)
    expect(r.loanDeduction).toBe(4000)
    expect(r.advanceDeduction).toBe(1000)
  })
  test("excess defers LOAN first (arrears re-budget it next run)", () => {
    const r = applyRecoveryFloor(8000, 1000, 10_000, 50) // cap 5000 → defer 4000
    expect(r.capped).toBe(true)
    expect(r.loanDeduction).toBe(4000)
    expect(r.advanceDeduction).toBe(1000)
    expect(r.deferred).toBe(4000)
  })
  test("loan exhausted before the cap is met → advance defers too", () => {
    const r = applyRecoveryFloor(3000, 6000, 10_000, 50) // cap 5000 → defer 4000: loan 3000 fully, advance 1000
    expect(r.loanDeduction).toBe(0)
    expect(r.advanceDeduction).toBe(5000)
    expect(r.deferred).toBe(4000)
  })
  test("zero pre-recovery net defers EVERYTHING (no ৳0 payslip by recovery)", () => {
    const r = applyRecoveryFloor(8000, 2000, 0, 50)
    expect(r.loanDeduction).toBe(0)
    expect(r.advanceDeduction).toBe(0)
    expect(r.deferred).toBe(10_000)
  })
  test("negative pre-recovery net (deductions already exceed pay) defers all", () => {
    const r = applyRecoveryFloor(8000, 0, -3000, 50)
    expect(r.loanDeduction).toBe(0)
    expect(r.deferred).toBe(8000)
  })
})

describe("ATT-308/ATT-306 computeAttendance (pre-R3-4 remnants, re-verified)", () => {
  const shift = { startTime: "09:00", endTime: "17:00", graceMinutes: 10, breakMinutes: 0, otThresholdMinutes: 30, minWorkingHours: 8 }
  test("ATT-308 — grace is DEDUCTED from lateMinutes (device-path parity)", () => {
    const r = computeAttendance(shift, "09:12", "17:30", 4, {})
    expect(r.lateMinutes).toBe(2) // 12 − 10 grace, not 12
  })
  test("arrival inside the grace window is not late at all", () => {
    const r = computeAttendance(shift, "09:09", "17:30", 4, {})
    expect(r.lateMinutes).toBe(0)
    expect(r.status).toBe("PRESENT")
  })
  test("ATT-306 — statutory daily OT ceiling caps overtimeMinutes", () => {
    const r = computeAttendance(shift, "09:00", "21:00", 4, { maxOtMinutesPerDay: 120 })
    expect(r.overtimeMinutes).toBe(120) // 4h past end → capped at 2h
  })
  test("ATT-306 — cap 0/undefined = unlimited", () => {
    const r = computeAttendance(shift, "09:00", "21:00", 4, {})
    expect(r.overtimeMinutes).toBe(240)
  })
})

describe("EXIT-011 S.settlementCalculate — schema pins otherDeductions", () => {
  test("negative otherDeductions are rejected (they used to inflate netPayable)", () => {
    expect(S.settlementCalculate.safeParse({ resignationId: "x", otherDeductions: -5 }).success).toBe(false)
  })
  test("non-numeric / non-finite values are rejected", () => {
    expect(S.settlementCalculate.safeParse({ resignationId: "x", otherDeductions: "abc" as unknown as number }).success).toBe(false)
    expect(S.settlementCalculate.safeParse({ resignationId: "x", otherDeductions: Number.POSITIVE_INFINITY }).success).toBe(false)
  })
  test("valid payloads pass (resignationId alone, or with a positive amount)", () => {
    expect(S.settlementCalculate.safeParse({ resignationId: "res1" }).success).toBe(true)
    expect(S.settlementCalculate.safeParse({ resignationId: "res1", otherDeductions: 2500.5 }).success).toBe(true)
    expect(S.settlementCalculate.safeParse({ resignationId: "res1", otherDeductions: 0 }).success).toBe(true)
  })
})

// ============================================================================
// PART B — dispatcher / engine integration (needs the unit-test PostgreSQL)
// ============================================================================

let vendor: { id: string }
let hrToken: string

beforeAll(async () => {
  vendor = await mkVendor("R3-4 Wave Vendor")
  const hr = await mkUser(vendor.id, { role: "HR_ADMIN", name: "R3-4 HR" })
  hrToken = await mkSession(hr.id, "FULL")
  // LEAVE + ENCASHMENT approval workflows (submitForApproval requires them)
  // + ADVANCE (fixture repair, re-audit 2026-10-18: the ADV-002 dispatcher
  // test pays an in-cap advance through the real route — advances.create
  // submits through the ADVANCE workflow and is rolled back with a 403
  // "No approval workflow configured" when the process type is missing;
  // the cap-refusal half passed only because it throws BEFORE submitForApproval)
  for (const pt of ["LEAVE", "ENCASHMENT", "ADVANCE"] as const) {
    const wf = await db.approvalWorkflow.create({
      data: { vendorId: vendor.id, processType: pt, name: `${pt} ${uniq()}`, active: true },
    })
    await db.approvalStep.create({
      data: { vendorId: wf.vendorId, workflowId: wf.id, sequence: 1, name: "Owner Approval", approverRole: "VENDOR_OWNER", required: true, rejectBehavior: "REJECT_ALL", departmentScope: false, branchScope: false, amountThreshold: null, allowDelegation: false },
    })
  }
})

describe("LVE-001 unpaid (LWP) leave writes LEAVE_UNPAID attendance (dispatcher + engine)", () => {
  test("approving an UNPAID type writes LEAVE_UNPAID; a PAID type writes LEAVE", async () => {
    const emp = await mkEmployee(vendor.id, { fullName: "R3-4 LWP Employee" })
    const unpaidType = await db.leaveType.create({
      data: { vendorId: vendor.id, code: uniq("LWP"), name: "Unpaid R34", paid: false, defaultDays: 15, probationEligible: true },
    })
    const paidType = await db.leaveType.create({
      data: { vendorId: vendor.id, code: uniq("PDL"), name: "Paid R34", paid: true, defaultDays: 10, probationEligible: true },
    })
    // Fixture repair (Phase 1, 2026-10-21): the original hardcoded dates
    // (2026-10-12..15) were "within the 7-day backdate window" when written;
    // the calendar advanced past it and the apply started returning 403 —
    // a time-rotted fixture, not a product regression. Dates are now derived:
    // the NEXT Monday..Thursday (future dates always apply cleanly, avoid the
    // Friday weekly-off, and never rot).
    const d = new Date()
    const dow = (d.getDay() + 6) % 7 // Mon=0
    const monday = new Date(d.getTime() + (7 - dow) * 86400000) // next Monday
    const iso = (x: Date) => x.toISOString().slice(0, 10)
    const mon = iso(monday)
    const tue = iso(new Date(monday.getTime() + 86400000))
    const wed = iso(new Date(monday.getTime() + 2 * 86400000))
    const thu = iso(new Date(monday.getTime() + 3 * 86400000))
    const balYear = monday.getFullYear()
    await db.leaveBalance.create({ data: { vendorId: vendor.id, employeeId: emp.id, leaveTypeId: unpaidType.id, year: balYear, entitled: 15, used: 0, pending: 0 } })
    await db.leaveBalance.create({ data: { vendorId: vendor.id, employeeId: emp.id, leaveTypeId: paidType.id, year: balYear, entitled: 10, used: 0, pending: 0 } })

    const u = await postHrm("leaveRequests.apply", { employeeId: emp.id, leaveTypeId: unpaidType.id, fromDate: mon, toDate: tue }, { bearer: hrToken })
    expect(u.status).toBe(200)
    expect(u.body.data.days).toBe(2)
    const p = await postHrm("leaveRequests.apply", { employeeId: emp.id, leaveTypeId: paidType.id, fromDate: wed, toDate: thu }, { bearer: hrToken })
    expect(p.status).toBe(200)
    expect(p.body.data.days).toBe(2)

    const sys = { userId: "test", userName: "R3-4", vendorId: vendor.id }
    await applyLeaveDecision(sys, u.body.data.id, "APPROVED")
    await applyLeaveDecision(sys, p.body.data.id, "APPROVED")

    const rows = await db.attendance.findMany({
      where: { vendorId: vendor.id, employeeId: emp.id, date: { gte: mon, lte: thu } },
      orderBy: { date: "asc" },
    })
    expect(rows).toHaveLength(4)
    expect(rows.filter((r) => r.status === "LEAVE_UNPAID").length).toBe(2) // LVE-001
    expect(rows.filter((r) => r.status === "LEAVE").length).toBe(2)
    // remarks keep the synthetic marker so a later cancel can restore them
    expect(rows.every((r) => /\(approved/.test(r.remarks || ""))).toBe(true)
  })
})

describe("LVE-005 encashment — approval-id resolution + guarded reservation", () => {
  test("two open encashments on one balance: finalizing the SECOND applies only its days", async () => {
    const emp = await mkEmployee(vendor.id, { fullName: "R3-4 Encasher" })
    // Fixture repair (re-audit 2026-10-18): the ENCASHMENT payout is queued as
    // a bonus ONLY when the employee has an ACTIVE salary structure (daily
    // rate = gross/26 — a structureless encasher amounts to zero and queues
    // nothing). The fixture now carries the structure the assertion assumed.
    await db.salaryStructure.create({
      data: { vendorId: vendor.id, employeeId: emp.id, effectiveFrom: "2026-01-01", status: "ACTIVE", basic: 26000, gross: 52000 },
    })
    const type = await db.leaveType.create({
      data: { vendorId: vendor.id, code: uniq("ENC"), name: "Annual R34", encashmentAllowed: true, encashmentRate: 1, encashmentCap: 0 },
    })
    const bal = await db.leaveBalance.create({
      data: { vendorId: vendor.id, employeeId: emp.id, leaveTypeId: type.id, year: 2026, entitled: 20, used: 0, pending: 0 },
    })

    // two requests against the SAME balance, both valid when filed
    const r1 = await postHrm("leave.encash", { employeeId: emp.id, leaveTypeId: type.id, days: 2 }, { bearer: hrToken })
    expect(r1.status).toBe(200)
    const r2 = await postHrm("leave.encash", { employeeId: emp.id, leaveTypeId: type.id, days: 3 }, { bearer: hrToken })
    expect(r2.status).toBe(200)

    let b = await db.leaveBalance.findUnique({ where: { id: bal.id } })
    expect(b?.pending).toBe(5) // both reservations landed
    expect(b?.used).toBe(0)

    // over-reservation is refused against the LOCKED row (H-9 parity):
    // spendable is now 15, asking 16 must fail
    const r3 = await postHrm("leave.encash", { employeeId: emp.id, leaveTypeId: type.id, days: 16 }, { bearer: hrToken })
    expect(r3.status).not.toBe(200)

    // finalize ONLY the second request (approval-id resolution — LVE-005)
    const sys = { userId: "test", userName: "R3-4", vendorId: vendor.id }
    await applyEncashmentDecision(sys, bal.id, "APPROVED", r2.body.data.approvalId)

    b = await db.leaveBalance.findUnique({ where: { id: bal.id } })
    expect(b?.pending).toBe(2)  // only request 2's reservation converted
    expect(b?.used).toBe(3)     // exactly the second request's days

    // the payout bonus is queued once, for the approved days only
    const bonuses = await db.bonus.findMany({ where: { vendorId: vendor.id, employeeId: emp.id, type: "ENCASHMENT" } })
    expect(bonuses).toHaveLength(1)
    expect(bonuses[0].status).toBe("PENDING")

    // reject the first: its reservation releases (guarded decrement)
    await applyEncashmentDecision(sys, bal.id, "REJECTED", r1.body.data.approvalId)
    b = await db.leaveBalance.findUnique({ where: { id: bal.id } })
    expect(b?.pending).toBe(0)
    expect(b?.used).toBe(3)
  })
})

describe("LVE-002 carried-forward days are spendable through the dispatcher", () => {
  test("apply-time balance check includes carriedForward (12 of 12 spendable OK; 13 refused)", async () => {
    const emp = await mkEmployee(vendor.id, { fullName: "R3-4 Carry Employee" })
    const type = await db.leaveType.create({
      // LVE-105 — carry expiry 0 (never expires): this suite tests that
      // carried days COUNT toward spendable, a property independent of the
      // expiry window (the default 3-month window would lapse a July carry by
      // the November test dates).
      data: { vendorId: vendor.id, code: uniq("CFD"), name: "Carry R34", paid: true, defaultDays: 10, probationEligible: true, carryForwardExpiryMonths: 0 },
    })
    // Fixture repair (Phase 3, 2026-10-22): same time-rot as the LVE-001
    // repair above — the original hardcoded window (2026-10-13..27) fell out
    // of the 7-day backdate window and the apply started returning 403.
    // Derived dates: a Wednesday (>= next week, so every date in both spans
    // is strictly future and the backdate guard can never fire) through the
    // following Tuesday = 14 calendar days − 2 Fridays = 12 working days;
    // stretching the start one day earlier adds a working Tuesday = 13.
    const now = new Date()
    const dow = (now.getUTCDay() + 6) % 7 // Mon=0
    let wed = new Date(now.getTime() + ((((2 - dow) + 7) % 7) + 7) * 86400000) // next week's Wednesday
    const iso = (x: Date) => x.toISOString().slice(0, 10)
    // keep the whole span inside one leave year (a Dec→Jan span would straddle
    // two balance rows); shifting a week is always enough
    while (new Date(wed.getTime() + 13 * 86400000).getUTCFullYear() !== wed.getUTCFullYear()) {
      wed = new Date(wed.getTime() + 7 * 86400000)
    }
    const from = iso(wed)                                        // Wednesday
    const to = iso(new Date(wed.getTime() + 13 * 86400000))      // Tuesday: 14 days, 2 Fridays
    const from2 = iso(new Date(wed.getTime() - 86400000))        // Tuesday: 15 days, 13 working
    const balYear = wed.getUTCFullYear()
    // entitled 10 + carried 4 − used 2 = 12 spendable: an 11+ day request used
    // to be refused (entitled-only math said 8 remaining)
    const bal = await db.leaveBalance.create({
      data: { vendorId: vendor.id, employeeId: emp.id, leaveTypeId: type.id, year: balYear, entitled: 10, carriedForward: 4, used: 2, pending: 0 },
    })
    const r = await postHrm("leaveRequests.apply", {
      employeeId: emp.id, leaveTypeId: type.id, fromDate: from, toDate: to,
    }, { bearer: hrToken })
    expect(r.status).toBe(200)
    expect(r.body.data.days).toBe(12)
    let b = await db.leaveBalance.findUnique({ where: { id: bal.id } })
    expect(b?.pending).toBe(12)

    // 13 working days exceeds the 12 spendable → refused. Cancel the first
    // request (the overlap guard would otherwise block the retry), release the
    // reservation, and file the wider span.
    await db.leaveRequest.update({ where: { id: r.body.data.id }, data: { status: "CANCELLED" } })
    await db.leaveBalance.update({ where: { id: bal.id }, data: { pending: 0 } })
    const r2 = await postHrm("leaveRequests.apply", {
      employeeId: emp.id, leaveTypeId: type.id, fromDate: from2, toDate: to, // 13 working days
    }, { bearer: hrToken })
    expect(r2.status).not.toBe(200)
    b = await db.leaveBalance.findUnique({ where: { id: bal.id } })
    expect(b?.pending).toBe(0) // refused → nothing reserved
  })
})

describe("LOA-001 OVERDUE sweep marks past-due unpaid installments", () => {
  test("PENDING installments past their due date become OVERDUE; PARTIAL keeps its signal", async () => {
    const borrower = await mkEmployee(vendor.id, { fullName: "R3-4 Borrower" })
    const loan = await db.loan.create({
      data: { vendorId: vendor.id, employeeId: borrower.id, principal: 10_000, installments: 4,
        startDate: "2026-05-01", outstanding: 10_000, status: "ACTIVE", paidAmount: 0 },
    })
    await db.loanInstallment.create({ data: { vendorId: loan.vendorId, loanId: loan.id, no: 1, dueDate: "2026-06-01", amount: 2500, paidAmount: 0, status: "PENDING" } })
    await db.loanInstallment.create({ data: { vendorId: loan.vendorId, loanId: loan.id, no: 2, dueDate: "2026-07-01", amount: 2500, paidAmount: 0, status: "PENDING" } })
    await db.loanInstallment.create({ data: { vendorId: loan.vendorId, loanId: loan.id, no: 3, dueDate: "2026-08-01", amount: 2500, paidAmount: 1000, status: "PARTIAL" } })

    const marked = await loanOverdueSweep(vendor.id, "2026-09-15")
    expect(marked).toBe(2) // only the two PENDING ones

    const rows = await db.loanInstallment.findMany({ where: { loanId: loan.id }, orderBy: { no: "asc" } })
    expect(rows[0].status).toBe("OVERDUE")
    expect(rows[1].status).toBe("OVERDUE")
    expect(rows[2].status).toBe("PARTIAL") // stronger signal preserved

    // idempotent: the conditional claim re-runs to nothing
    const again = await loanOverdueSweep(vendor.id, "2026-09-16")
    expect(again).toBe(0)
  })
})

describe("ATT-303 the daily sweep materializes the ABSENT rows reports read", () => {
  test("missing days become ABSENT; existing rows and joiners are respected; idempotent", async () => {
    const yesterday = "2026-09-14" // a Monday
    const { getSettings } = await import("@/hrm-server/settings")
    const settings = await getSettings(vendor.id)
    const main = await mkEmployee(vendor.id, { fullName: "R3-4 No Show" })
    const joiner = await mkEmployee(vendor.id, { fullName: "R3-4 Too New" })
    await db.employee.update({ where: { id: joiner.id }, data: { joiningDate: "2026-09-15" } }) // joined AFTER the day
    const punched = await mkEmployee(vendor.id, { fullName: "R3-4 Punched" })
    await db.attendance.create({
      data: { vendorId: vendor.id, employeeId: punched.id, date: yesterday, status: "PRESENT", source: "MANUAL" },
    })

    const n = await materializeAbsentDay(vendor.id, yesterday, settings)
    expect(n).toBeGreaterThanOrEqual(1) // at least the no-show

    const forMain = await db.attendance.findFirst({ where: { vendorId: vendor.id, employeeId: main.id, date: yesterday } })
    expect(forMain?.status).toBe("ABSENT") // the report surfaces finally see it
    expect(forMain?.remarks).toMatch(/ATT-303/)
    const forPunched = await db.attendance.findFirst({ where: { vendorId: vendor.id, employeeId: punched.id, date: yesterday } })
    expect(forPunched?.status).toBe("PRESENT") // existing rows never touched
    const forJoiner = await db.attendance.findFirst({ where: { vendorId: vendor.id, employeeId: joiner.id, date: yesterday } })
    expect(forJoiner).toBeNull() // joined after the day — no row

    // idempotent: a second run writes nothing new
    const again = await materializeAbsentDay(vendor.id, yesterday, settings)
    expect(again).toBe(0)
  })
})

describe("EXIT-011 settlements.calculate rejects negative otherDeductions (dispatcher)", () => {
  test("zod schema is enforced on the route (400 before the handler runs)", async () => {
    const r = await postHrm("settlements.calculate", { resignationId: "nonexistent", otherDeductions: -1000 }, { bearer: hrToken })
    expect(r.status).toBe(400)
  })
})

describe("ADV-002 advance-vs-salary cap (dispatcher)", () => {
  test("an advance beyond advanceMaxPctOfMonthlyGross of monthly gross is refused", async () => {
    const borrower = await mkEmployee(vendor.id, { fullName: "R3-4 Advance Taker" })
    await db.salaryStructure.create({
      data: { vendorId: vendor.id, employeeId: borrower.id, basic: 20_000, houseRent: 5_000, conveyance: 2_000, gross: 30_000,
        effectiveFrom: "2026-01-01", status: "ACTIVE" },
    })
    // default advanceMaxPctOfMonthlyGross = 100 → cap 30,000; ask for 40,000
    const r = await postHrm("advances.create", { employeeId: borrower.id, amount: 40_000, reason: "too much" }, { bearer: hrToken })
    expect(r.status).not.toBe(200)
    expect(String(r.body.error || "")).toMatch(/exceeds.*% of.*monthly gross/)

    // within the cap passes validation and enters the approval workflow
    const ok = await postHrm("advances.create", { employeeId: borrower.id, amount: 25_000, reason: "festival", installments: 5 }, { bearer: hrToken })
    expect(ok.status).toBe(200)
  })
})

describe("LOA-002 recordInstallment — guarded claim + LOAN_RECOVER journal (dispatcher)", () => {
  test("manual payment increments atomically, posts the journal, and settles the ledger", async () => {
    const borrower = await mkEmployee(vendor.id, { fullName: "R3-4 Manual Repayer" })
    const loan = await db.loan.create({
      data: { vendorId: vendor.id, employeeId: borrower.id, principal: 5_000, installments: 2,
        startDate: "2026-09-01", outstanding: 5_000, status: "ACTIVE", paidAmount: 0 },
    })
    const inst = await db.loanInstallment.create({
      data: { vendorId: loan.vendorId, loanId: loan.id, no: 1, dueDate: "2026-10-01", amount: 2500, paidAmount: 0, status: "PENDING" },
    })

    const r = await postHrm("loans.recordInstallment", { installmentId: inst.id, amount: 1000 }, { bearer: hrToken })
    expect(r.status).toBe(200)

    const row = await db.loanInstallment.findUnique({ where: { id: inst.id } })
    expect(row?.paidAmount).toBe(1000)
    expect(row?.status).toBe("PARTIAL")
    const l = await db.loan.findUnique({ where: { id: loan.id } })
    expect(l?.paidAmount).toBe(1000)
    expect(l?.outstanding).toBe(4000)
    // LOA-002 — the GL relieves the receivable (Dr 1100 / Cr 1150)
    const journal = await db.accountJournal.findFirst({
      where: { vendorId: vendor.id, refType: "LOAN_RECOVERY", refId: inst.id },
    })
    expect(journal).not.toBeNull()
    const lines = JSON.parse(journal!.linesJson) as { account: string; debit?: number; credit?: number }[]
    expect(lines.find((x) => x.debit === 1000 && x.account === "1100")).toBeDefined()
    expect(lines.find((x) => x.credit === 1000 && x.account === "1150")).toBeDefined()
  })
})

describe("LOA-005 loan type enum (pre-R3-4 remnant, re-verified)", () => {
  test("loanCreate rejects arbitrary type strings", async () => {
    expect(S.loanCreate.safeParse({ employeeId: "e", principal: 1000, installments: 2, startDate: "2026-10-01", type: "NONSENSE" }).success).toBe(false)
    expect(S.loanCreate.safeParse({ employeeId: "e", principal: 1000, installments: 2, startDate: "2026-10-01", type: "PERSONAL" }).success).toBe(true)
  })
})

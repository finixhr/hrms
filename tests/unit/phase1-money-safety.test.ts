/// <reference types="bun-types" />
// ============ Phase 1 money-safety regression suite ============
//   FIN-018 — payroll.runs.cancel refuses a source run with LIVE adjustment
//             children (they carry ledger movements derived from its numbers)
//   FIN-019 — advance ledger writes are atomic increments; status follows
//             the returned row (the advance closes exactly at 0)
//   FIN-009 — gratuity: the deemed-5-years bracket (4y6m…4y11m) pays the
//             eligibilityYears multiplier, not floor(months/12)
//   FIN-011 — salaryStructures.save: supersede + create + revision row land
//             in ONE transaction; the direct-edit bypass is RECORDED (SoD)
//   FIN-013 — applySalaryRevision rescales EVERY component and asserts
//             Σ(components) + Σ(flexible extras) === gross exactly
//   FIN-012 — a retro effective date inside a paid period surfaces computed
//             arrears and points at an ADJUSTMENT run
import "./_testdb"
import { describe, test, expect } from "bun:test"
import { db } from "@/lib/db"
import { mkVendor, mkUser, mkEmployee, makeCtx, mkSession, uniq, defaultCompanyId } from "./_fixtures"
import { postHrm } from "./_hrm-endpoint"
import { calculateRun, payRun, createAdjustmentRun } from "@/hrm-server/payroll"
import { computeGratuity } from "@/hrm-server/gratuity"
import { applySalaryRevision } from "@/hrm-server/routes/lifecycle"

/** July 2026 workdays (Friday weekly off). */
const JULY_WORKDAYS = (() => {
  const days: string[] = []
  for (let d = 1; d <= 31; d++) days.push(`2026-07-${String(d).padStart(2, "0")}`)
  return days.filter((d) => new Date(d + "T00:00:00Z").getUTCDay() !== 5)
})()

async function mkWorld() {
  const v = await mkVendor(uniq("p1money"))
  const u = await mkUser(v.id, { role: "VENDOR_OWNER", name: "P1 Money Owner" })
  return { v, u, c: makeCtx(u, ["*"]), token: await mkSession(u.id, "FULL") }
}

async function mkEmpWithStructure(vendorId: string, name: string, comps: Record<string, number> = { basic: 8000 }) {
  const emp = await mkEmployee(vendorId, { fullName: name })
  const gross = Object.values(comps).reduce((s, x) => s + x, 0)
  await db.salaryStructure.create({ data: { vendorId, employeeId: emp.id, effectiveFrom: "2026-01-01", status: "ACTIVE", ...comps, gross } })
  return emp
}

async function seedJulyAttendance(vendorId: string, employeeId: string) {
  await db.attendance.createMany({ data: JULY_WORKDAYS.map((d) => ({ vendorId, employeeId, date: d, status: "PRESENT" })) })
}

async function mkJulyRun(vendorId: string, createdBy: string) {
  return db.payrollRun.create({
    data: { companyId: await defaultCompanyId(vendorId), vendorId, periodMonth: 7, periodYear: 2026, periodWeek: 0, frequency: "MONTHLY", runType: "REGULAR", status: "DRAFT", createdBy },
  })
}

// ============================================================================
describe("FIN-018 — cancel guard: live adjustment children block the source", () => {
  test("a CALCULATED adjustment child refuses cancellation of its source run", async () => {
    const { v, u, c, token } = await mkWorld()
    const emp = await mkEmpWithStructure(v.id, "P1 Cancel Guard")
    await seedJulyAttendance(v.id, emp.id)
    const run = await mkJulyRun(v.id, u.id)
    await calculateRun(c, run.id)
    await db.payrollRun.update({ where: { id: run.id }, data: { status: "APPROVED" } })
    await payRun(c, run.id)
    // a live adjustment child (CALCULATED — money has moved or is moving)
    const adjId = await createAdjustmentRun(c, run.id)
    await db.payrollRun.update({ where: { id: adjId }, data: { status: "CALCULATED" } })
    const denied = await postHrm("payroll.runs.cancel", { runId: run.id, reason: "trying to cancel under a live adjustment" }, { bearer: token })
    expect(denied.status).toBe(409)
    expect(String(denied.body.error || "")).toContain("live adjustment run")
    // the source run is untouched
    const still = await db.payrollRun.findUnique({ where: { id: run.id } })
    expect(still!.status).toBe("PAID")
    // once the child is cancelled, the guard no longer fires on it
    await db.payrollRun.update({ where: { id: adjId }, data: { status: "CANCELLED" } })
    const ok = await postHrm("payroll.runs.cancel", { runId: run.id, reason: "children gone — cancelling now" }, { bearer: token })
    expect(ok.status).toBe(200)
    expect((await db.payrollRun.findUnique({ where: { id: run.id } }))!.status).toBe("CANCELLED")
  })
})

// ============================================================================
describe("FIN-019 — advance ledger closes exactly at zero through payRun", () => {
  test("a single-installment advance is recovered once and marked RECOVERED", async () => {
    const { v, u, c } = await mkWorld()
    const emp = await mkEmpWithStructure(v.id, "P1 Advance Closer")
    await seedJulyAttendance(v.id, emp.id)
    // one-installment advance of ৳4,000 requested in June → July recovers all
    // (the recovery floor caps deductions at 50% of net, so ৳4,000 fits under
    // a ৳8,000 gross in a single run)
    await db.advance.create({
      data: { vendorId: v.id, employeeId: emp.id, amount: 4000, requestDate: "2026-06-01", installments: 1, deducted: 0, outstanding: 4000, status: "RECOVERING" },
    })
    const run = await mkJulyRun(v.id, u.id)
    await calculateRun(c, run.id)
    const entry = await db.payrollEntry.findFirst({ where: { runId: run.id, employeeId: emp.id } })
    expect(entry!.advanceDeduction).toBe(4000)
    await db.payrollRun.update({ where: { id: run.id }, data: { status: "APPROVED" } })
    await payRun(c, run.id)
    const adv = await db.advance.findFirst({ where: { vendorId: v.id, employeeId: emp.id } })
    // atomic increments: deducted +5000, outstanding −5000 → exactly 0, and
    // the status follows the RETURNED row (RECOVERED, never RECOVERING)
    expect(adv!.deducted).toBe(4000)
    expect(adv!.outstanding).toBe(0)
    expect(adv!.status).toBe("RECOVERED")
  })
})

// ============================================================================
describe("FIN-009 — gratuity deemed-5-years multiplier (BLA §96(2))", () => {
  const wage = { basic: 30000, gross: 45000 } // daily wage ৳1,000 on the BASIC basis
  const g = (join: string, lwd: string) => computeGratuity(null, wage, join, lwd)

  test("4y6m0d — the deemed bracket pays FIVE years (was four — a 20% underpayment)", () => {
    const r = g("2021-01-01", "2025-07-01") // 54 completed months
    expect(r.eligible).toBe(true)
    expect(r.months).toBe(54)
    expect(r.years).toBe(4)
    expect(r.multiplier).toBe(5)
    expect(r.amount).toBe(150000) // ৳1,000 × 30 days × 5 — the old code paid 120000
  })

  test("4y5m30d — one day short of the deemed bracket: ineligible", () => {
    const r = g("2021-01-01", "2025-06-30") // 53 completed months
    expect(r.eligible).toBe(false)
    expect(r.amount).toBe(0)
  })

  test("4y11m30d — the top of the deemed bracket: five years", () => {
    const r = g("2021-01-01", "2025-11-30") // 59 completed months
    expect(r.eligible).toBe(true)
    expect(r.multiplier).toBe(5)
    expect(r.amount).toBe(150000)
  })

  test("≥5y and beyond — floor(months/12) is unchanged (only the deemed bracket moved)", () => {
    const five = g("2021-01-01", "2025-12-31") // 60 months
    expect(five.multiplier).toBe(5)
    expect(five.amount).toBe(150000)
    const sixTwo = g("2020-01-01", "2026-03-01") // 74 months
    expect(sixTwo.multiplier).toBe(6)
    expect(sixTwo.amount).toBe(180000)
  })
})

// ============================================================================
describe("FIN-011/013 — salary revision: transactional, rescaled, invariant-held", () => {
  test("applySalaryRevision rescales every component and the sum equals gross exactly", async () => {
    const { v, u, c } = await mkWorld()
    // a structure exercising every component + a flexible extra: gross ৳50,000
    const emp = await mkEmployee(v.id, { fullName: "P1 Rescale" })
    const extras = [{ label: "Transport", amount: 3000 }]
    await db.salaryStructure.create({
      data: {
        vendorId: v.id, employeeId: emp.id, effectiveFrom: "2026-01-01", status: "ACTIVE",
        basic: 20000, houseRent: 10000, medical: 4000, conveyance: 2000, food: 3000,
        mobileAllow: 2000, internetAllow: 1000, attendanceAllow: 2000, otherAllowance: 3000,
        gross: 50000, componentsJson: JSON.stringify(extras),
      },
    })
    // fixed columns sum to 47000 + 3000 flexible = 50000 ✓
    const rev = await db.salaryRevision.create({
      data: {
        vendorId: v.id, employeeId: emp.id, previousSalary: 50000, newSalary: 75000,
        increaseAmount: 25000, increasePercent: 50, effectiveDate: "2026-08-01",
        reason: "FIN-013 fixture", type: "INCREMENT", status: "PENDING",
      },
    })
    await applySalaryRevision(rev.id, u.id, v.id, "APPROVE")
    const old = await db.salaryStructure.findFirst({ where: { employeeId: emp.id, status: "SUPERSEDED" } })
    const neu = await db.salaryStructure.findFirst({ where: { employeeId: emp.id, status: "ACTIVE" } })
    expect(old).not.toBeNull()
    expect(neu).not.toBeNull()
    expect(neu!.revisionId).toBe(rev.id)
    expect(neu!.gross).toBe(75000)
    // the four components the OLD code copied verbatim are now scaled
    expect(neu!.food).toBe(4500)      // 3000 × 1.5
    expect(neu!.mobileAllow).toBe(3000) // 2000 × 1.5
    expect(neu!.internetAllow).toBe(1500)
    expect(neu!.attendanceAllow).toBe(3000)
    // the flexible extras are rescaled too
    const scaledExtras = JSON.parse(neu!.componentsJson || "[]")
    expect(scaledExtras[0].amount).toBe(4500)
    // and the invariant holds EXACTLY: Σ(fixed) + Σ(flexible) === gross
    const fixed = ["basic", "houseRent", "medical", "conveyance", "food", "mobileAllow", "internetAllow", "attendanceAllow", "otherAllowance"]
      .reduce((s: number, f: string) => s + Number((neu as any)![f]), 0)
    const flexible = scaledExtras.reduce((s: number, x: any) => s + x.amount, 0)
    expect(fixed + flexible).toBe(75000)
    // the revision is APPROVED and the history row records it
    expect((await db.salaryRevision.findUnique({ where: { id: rev.id } }))!.status).toBe("APPROVED")
    const hist = await db.employeeHistory.findFirst({ where: { vendorId: v.id, employeeId: emp.id, eventType: "SALARY_REVISION" } })
    expect(hist).not.toBeNull()
    void c
  })

  test("salaryStructures.save: the direct-edit bypass is RECORDED (SoD-visible)", async () => {
    const { v, token } = await mkWorld()
    const emp = await mkEmpWithStructure(v.id, "P1 Direct Edit", { basic: 20000, houseRent: 10000 })
    const r = await postHrm("salaryStructures.save", {
      employeeId: emp.id, effectiveFrom: "2026-09-01", basic: 25000, houseRent: 12500,
    }, { bearer: token })
    expect(r.status).toBe(200)
    // the revision row exists, is typed as a direct structure change, and its
    // reason SAYS it bypassed the approval workflow — auditable without code
    const rev = await db.salaryRevision.findFirst({ where: { vendorId: v.id, employeeId: emp.id } })
    expect(rev).not.toBeNull()
    expect(rev!.type).toBe("STRUCTURE_CHANGE")
    expect(rev!.status).toBe("APPROVED")
    expect(String(rev!.reason)).toContain("bypass")
    // both structures exist (transactional supersede + create)
    const count = await db.salaryStructure.count({ where: { vendorId: v.id, employeeId: emp.id } })
    expect(count).toBe(2)
  })
})

// ============================================================================
describe("FIN-012 — retro effective dates surface computed arrears", () => {
  test("a revision effective inside a paid period records the owed delta", async () => {
    const { v, u, c } = await mkWorld()
    const emp = await mkEmpWithStructure(v.id, "P1 Retro")
    await seedJulyAttendance(v.id, emp.id)
    const run = await mkJulyRun(v.id, u.id)
    await calculateRun(c, run.id)
    await db.payrollRun.update({ where: { id: run.id }, data: { status: "APPROVED" } })
    await payRun(c, run.id) // July 2026 is now PAID at the old salary
    // a revision effective mid-July — the overlap is one paid period
    const rev = await db.salaryRevision.create({
      data: {
        vendorId: v.id, employeeId: emp.id, previousSalary: 8000, newSalary: 13000,
        increaseAmount: 5000, increasePercent: 62.5, effectiveDate: "2026-07-15",
        reason: "FIN-012 fixture", type: "INCREMENT", status: "PENDING",
      },
    })
    await applySalaryRevision(rev.id, u.id, v.id, "APPROVE")
    const hist = await db.employeeHistory.findFirst({ where: { vendorId: v.id, employeeId: emp.id, eventType: "SALARY_REVISION" } })
    expect(hist).not.toBeNull()
    expect(String(hist!.description)).toContain("RETROACTIVE")
    expect(String(hist!.description)).toContain("2026-07")
    const data = JSON.parse(hist!.dataJson || "{}")
    expect(data.retroArrears.paidPeriods).toEqual(["2026-07"])
    expect(data.retroArrears.estimatedAmount).toBe(5000)
  })
})

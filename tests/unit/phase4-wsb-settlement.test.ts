/// <reference types="bun-types" />
// ============ Phase 4 WS-B — settlement & calculation concurrency ============
// MON-5: settlements.pay re-validates the loan/advance/bonus ledgers INSIDE
//       the payment transaction — drift between calculation and payment
//       (loan taken after, EMI recovered by payroll, bonus approved/paid in
//       between) blocks payment with the specific reason.
// MON-6: exit.assets.clearWithDeduction merges into the settlement INSIDE the
//       claim transaction, serialized per resignation by Resignation FOR
//       UPDATE — concurrent clears can no longer drop each other's deduction
//       lines; settlements.calculate refuses to silently wipe an APPROVED
//       settlement back to CALCULATED.
// MON-7: PayrollRun.calcEpoch fences calculateRun — concurrent recalcs have
//       exactly one winner (loser: friendly 409, nothing partial), sequential
//       recalcs always work, and a racing submit-for-approval aborts the
//       computation with NOTHING written.
import "./_testdb"
import { describe, test, expect, beforeAll } from "bun:test"
import { db } from "@/lib/db"
import { mkVendor, mkUser, mkEmployee, mkSession, makeCtx } from "./_fixtures"
import { postHrm } from "./_hrm-endpoint"
import { calculateRun } from "@/hrm-server/payroll"

let vendor: { id: string }
let owner: { id: string }
let ctx: any
let token: string

beforeAll(async () => {
  vendor = await mkVendor("P4 WSB Vendor")
  const u = await mkUser(vendor.id, { role: "VENDOR_OWNER", name: "P4 WSB Owner" })
  owner = u
  ctx = makeCtx(u, ["*"])
  token = await mkSession(u.id, "FULL")
})

// ---------------------------------------------------------------------------
// fixture helpers
// ---------------------------------------------------------------------------
/** A calculated+approved settlement world with controllable live ledgers. */
async function mkSettlementWorld(over?: {
  loanDue?: number; advanceDue?: number; bonusDue?: number
  withLiveLedgers?: boolean
}): Promise<{ settlementId: string; resignationId: string; employeeId: string; loanId?: string; advanceId?: string; bonusId?: string }> {
  const emp = await mkEmployee(vendor.id, { fullName: "P4 WSB Emp " + Math.random().toString(36).slice(2, 6) })
  // settlements.calculate requires an active structure even when the test
  // targets the APPROVED-rejection at the END of the handler
  await db.salaryStructure.create({ data: {
    vendorId: vendor.id, employeeId: emp.id, effectiveFrom: "2026-01-01", status: "ACTIVE",
    basic: 5000, houseRent: 0, gross: 5000,
  } })
  const res = await db.resignation.create({
    data: {
      vendorId: vendor.id, employeeId: emp.id,
      submissionDate: "2026-09-01", resignationDate: "2026-09-15", proposedLwd: "2026-10-15",
      reason: "P4 test", status: "ACCEPTED",
    },
  })
  const loanDue = over?.loanDue ?? 0
  const advanceDue = over?.advanceDue ?? 0
  const bonusDue = over?.bonusDue ?? 0
  let loanId: string | undefined
  let advanceId: string | undefined
  let bonusId: string | undefined
  if (over?.withLiveLedgers) {
    if (loanDue > 0) {
      const l = await db.loan.create({ data: {
        vendorId: vendor.id, employeeId: emp.id, principal: loanDue, installments: 1,
        installmentAmount: loanDue, startDate: "2026-10-01", status: "ACTIVE", outstanding: loanDue,
      } })
      loanId = l.id
    }
    if (advanceDue > 0) {
      const a = await db.advance.create({ data: {
        vendorId: vendor.id, employeeId: emp.id, amount: advanceDue, installments: 1,
        outstanding: advanceDue, requestDate: "2026-10-01", status: "RECOVERING",
      } })
      advanceId = a.id
    }
    if (bonusDue > 0) {
      const b = await db.bonus.create({ data: {
        vendorId: vendor.id, employeeId: emp.id, type: "FESTIVAL", amount: bonusDue,
        status: "APPROVED", periodMonth: 10, periodYear: 2026,
      } })
      bonusId = b.id
    }
  }
  const comp = {
    gross: 5000, finalSalary: 5000, otAmount: 0, leaveEncashment: 0,
    bonusDue, ...(bonusId ? { bonusIds: [bonusId] } : { bonusIds: [] }),
    gratuity: 0, noticePay: 0, pfSettlement: 0,
    loanDue, ...(loanId ? { loanIds: [loanId] } : { loanIds: [] }),
    advanceDue, ...(advanceId ? { advanceIds: [advanceId] } : { advanceIds: [] }),
    noticeBuyout: 0, otherDeductions: 0, settlementAit: 0,
    totalDeductions: loanDue + advanceDue + bonusDue * 0 + 0,
    netPayable: 5000 - loanDue - advanceDue,
  }
  const rec = await db.finalSettlement.create({
    data: {
      vendorId: vendor.id, resignationId: res.id,
      computationJson: JSON.stringify(comp), netPayable: comp.netPayable, status: "APPROVED",
    },
  })
  return { settlementId: rec.id, resignationId: res.id, employeeId: emp.id, loanId, advanceId, bonusId }
}

async function tryPay(settlementId: string) {
  return postHrm("settlements.pay", { id: settlementId }, { bearer: token })
}

// ---------------------------------------------------------------------------
describe("MON-5 — settlements.pay re-validates the ledgers in-transaction", () => {
  test("clean world: recorded dues match the live ledgers → payment succeeds", async () => {
    const w = await mkSettlementWorld({ loanDue: 1000, advanceDue: 500, bonusDue: 300, withLiveLedgers: true })
    const res = await tryPay(w.settlementId)
    expect(res.body.ok).toBe(true)
    const after = await db.finalSettlement.findUnique({ where: { id: w.settlementId } })
    expect(after?.status).toBe("PAID")
  })

  test("a loan taken AFTER the calculation blocks payment (under-recovery)", async () => {
    const w = await mkSettlementWorld({ loanDue: 1000, advanceDue: 0, withLiveLedgers: true })
    await db.loan.create({ data: {
      vendorId: vendor.id, employeeId: w.employeeId, principal: 700, installments: 1,
      installmentAmount: 700, startDate: "2026-10-05", status: "ACTIVE", outstanding: 700,
    } })
    const res = await tryPay(w.settlementId)
    expect(res.body.ok).toBe(false)
    expect(String(res.body.error)).toMatch(/Loan dues changed.*never recover it/s)
    const after = await db.finalSettlement.findUnique({ where: { id: w.settlementId } })
    expect(after?.status).toBe("APPROVED") // claim rolled back — nothing paid
  })

  test("an EMI recovered by payroll in between blocks payment (double-charge)", async () => {
    const w = await mkSettlementWorld({ loanDue: 1000, withLiveLedgers: true })
    // payroll recovered ৳400 of the loan between calculation and payment
    await db.loan.update({ where: { id: w.loanId! }, data: { outstanding: 600 } })
    const res = await tryPay(w.settlementId)
    expect(res.body.ok).toBe(false)
    expect(String(res.body.error)).toMatch(/Loan dues changed.*twice/s)
  })

  test("an advance issued AFTER the calculation blocks payment", async () => {
    const w = await mkSettlementWorld({ advanceDue: 500, withLiveLedgers: true })
    await db.advance.create({ data: {
      vendorId: vendor.id, employeeId: w.employeeId, amount: 900, installments: 1,
      outstanding: 900, requestDate: "2026-10-05", status: "RECOVERING",
    } })
    const res = await tryPay(w.settlementId)
    expect(res.body.ok).toBe(false)
    expect(String(res.body.error)).toMatch(/Advance dues changed/s)
  })

  test("an advance recovered elsewhere in between blocks payment", async () => {
    const w = await mkSettlementWorld({ advanceDue: 500, withLiveLedgers: true })
    await db.advance.update({ where: { id: w.advanceId! }, data: { outstanding: 100 } })
    const res = await tryPay(w.settlementId)
    expect(res.body.ok).toBe(false)
    expect(String(res.body.error)).toMatch(/Advance dues changed.*twice/s)
  })

  test("a bonus APPROVED after the calculation blocks payment (missed money)", async () => {
    const w = await mkSettlementWorld({ bonusDue: 0, withLiveLedgers: true })
    await db.bonus.create({ data: {
      vendorId: vendor.id, employeeId: w.employeeId, type: "FESTIVAL", amount: 800,
      status: "APPROVED", periodMonth: 10, periodYear: 2026,
    } })
    const res = await tryPay(w.settlementId)
    expect(res.body.ok).toBe(false)
    expect(String(res.body.error)).toMatch(/bonus ledger changed.*never be paid/s)
  })

  test("a recorded bonus paid by payroll in between blocks payment (double-pay)", async () => {
    const w = await mkSettlementWorld({ bonusDue: 300, withLiveLedgers: true })
    await db.bonus.update({ where: { id: w.bonusId! }, data: { status: "PAID" } })
    const res = await tryPay(w.settlementId)
    expect(res.body.ok).toBe(false)
    expect(String(res.body.error)).toMatch(/bonus ledger changed.*double-pay/s)
  })
})

// ---------------------------------------------------------------------------
describe("MON-6 — tx-scoped settlement merge, serialized per resignation", () => {
  test("two CONCURRENT asset clears: BOTH deduction lines survive in one settlement", async () => {
    const emp = await mkEmployee(vendor.id, { fullName: "P4 WSB Merge Emp" })
    const res = await db.resignation.create({
      data: {
        vendorId: vendor.id, employeeId: emp.id,
        submissionDate: "2026-09-01", resignationDate: "2026-09-15", proposedLwd: "2026-10-15",
        reason: "P4 merge", status: "ACCEPTED",
      },
    })
    const mkAssignedAsset = async (code: string) => {
      const asset = await db.asset.create({ data: { vendorId: vendor.id, code, name: code + " device", status: "ASSIGNED" } })
      const a = await db.assetAssignment.create({ data: { vendorId: vendor.id, assetId: asset.id, employeeId: emp.id } })
      return a.id
    }
    const a1 = await mkAssignedAsset("P4MERGE-1")
    const a2 = await mkAssignedAsset("P4MERGE-2")
    // fire both clears concurrently — pre-fix, each merged into the snapshot
    // it had read and the second commit dropped the first line
    const [r1, r2] = await Promise.all([
      postHrm("exit.assets.clearWithDeduction", { assignmentId: a1, recoveryAmount: 100 }, { bearer: token }),
      postHrm("exit.assets.clearWithDeduction", { assignmentId: a2, recoveryAmount: 250 }, { bearer: token }),
    ])
    expect(r1.body.ok).toBe(true)
    expect(r2.body.ok).toBe(true)
    const settlement = await db.finalSettlement.findFirst({ where: { resignationId: res.id } })
    expect(settlement).toBeTruthy()
    expect(settlement?.status).toBe("CALCULATED")
    const comp = JSON.parse(settlement!.computationJson || "{}")
    expect(comp.assetDeductions).toHaveLength(2)
    expect(comp.otherDeductions).toBe(350)
    const codes = comp.assetDeductions.map((d: any) => d.assetCode).sort()
    expect(codes).toEqual(["P4MERGE-1", "P4MERGE-2"])
  })

  test("settlements.calculate REFUSES to wipe an APPROVED settlement back to CALCULATED", async () => {
    const w = await mkSettlementWorld({ withLiveLedgers: false })
    const res = await postHrm("settlements.calculate", { resignationId: w.resignationId }, { bearer: token })
    expect(res.body.ok).toBe(false)
    expect(String(res.body.error)).toMatch(/already approved.*discard the approval/is)
    const after = await db.finalSettlement.findUnique({ where: { id: w.settlementId } })
    expect(after?.status).toBe("APPROVED") // untouched
    expect(after?.approvedBy ?? null).toBe(after?.approvedBy ?? null) // approval intact
  })
})

// ---------------------------------------------------------------------------
describe("MON-7 — calculateRun claim fencing (calcEpoch)", () => {
  async function mkCalcWorld(nEmps: number) {
    const v = await mkVendor("P4 WSB Payroll " + nEmps)
    const u = await mkUser(v.id, { role: "VENDOR_OWNER", name: "Owner" })
    const c = makeCtx(u, ["*"])
    for (let i = 0; i < nEmps; i++) {
      const emp = await mkEmployee(v.id, { fullName: `Emp ${i}` })
      await db.salaryStructure.create({ data: {
        vendorId: v.id, employeeId: emp.id, effectiveFrom: "2026-01-01", status: "ACTIVE",
        basic: 10000, houseRent: 5000, gross: 15000,
      } })
    }
    const run = await db.payrollRun.create({ data: {
      vendorId: v.id, periodMonth: 7, periodYear: 2026, periodWeek: 0,
      frequency: "MONTHLY", runType: "REGULAR", status: "DRAFT", adjustSeq: 0, createdBy: u.id,
    } })
    return { runId: run.id, ctx: c }
  }

  test("two CONCURRENT recalculations: exactly ONE winner, the loser gets a friendly 409", async () => {
    const { runId, ctx: c } = await mkCalcWorld(30)
    // the first computation pauses in its progress hook so the second claim
    // deterministically overlaps it — the SECOND caller claims the advanced
    // epoch while the first sleeps, wins the final conditional write, and the
    // sleeping first computation aborts with nothing written
    let paused = false
    const slow = calculateRun(c, runId, async () => {
      if (!paused) { paused = true; await new Promise((r) => setTimeout(r, 400)) }
    })
    await new Promise((r) => setTimeout(r, 120)) // let the first claim + hook land
    const [slowResult, secondResult] = await Promise.allSettled([slow, calculateRun(c, runId)])
    // exactly one computation owns the run at commit time — here it is the
    // second (the first's epoch was superseded mid-flight)
    expect(secondResult.status).toBe("fulfilled")
    expect(slowResult.status).toBe("rejected")
    expect(String((slowResult as PromiseRejectedResult).reason?.message)).toMatch(/moved while it was being calculated|recalculated or submitted elsewhere/i)
    const run = await db.payrollRun.findUnique({ where: { id: runId } })
    expect(run?.status).toBe("CALCULATED")
    expect(run?.employeeCount).toBe(30)
    expect(run?.calcEpoch).toBe(2) // both claims landed; only the owner's write survived
  })

  test("SEQUENTIAL recalculations all succeed (the epoch advances with them)", async () => {
    const { runId, ctx: c } = await mkCalcWorld(3)
    await calculateRun(c, runId)
    const run1 = await db.payrollRun.findUnique({ where: { id: runId } })
    expect(run1?.calcEpoch).toBe(1)
    await calculateRun(c, runId) // recalculation of a CALCULATED run is fine
    const run2 = await db.payrollRun.findUnique({ where: { id: runId } })
    expect(run2?.calcEpoch).toBe(2)
    expect(run2?.status).toBe("CALCULATED")
  })

  test("a racing submission between claim and commit aborts the calculation with NOTHING written", async () => {
    const { runId, ctx: c } = await mkCalcWorld(30)
    let flipped = false
    const calc = calculateRun(c, runId, async () => {
      if (!flipped) {
        flipped = true
        // a racing submit-for-approval flips the status while we compute
        await db.payrollRun.update({ where: { id: runId }, data: { status: "HR_REVIEW" } })
      }
    })
    await expect(calc).rejects.toThrow(/moved while it was being calculated/i)
    const run = await db.payrollRun.findUnique({ where: { id: runId } })
    expect(run?.status).toBe("HR_REVIEW") // the submission won
    const entries = await db.payrollEntry.findMany({ where: { runId } })
    expect(entries.length).toBe(0) // the wipe-and-rewrite rolled back completely
  })
})

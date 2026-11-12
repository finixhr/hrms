/// <reference types="bun-types" />
// ============ FIN-005 / FIN-053 (Phase 0) — leave cancel is money-safe ============
// The defect: cancelling an APPROVED leave whose days were already paid
// rewrote (or deleted) the attendance rows of its span WITHOUT the paid-period
// guard the manual marking path has had since PAY-017 — payslip snapshots and
// the ledger silently drifted from the underlying attendance. The sequence
// was also not transactional: a mid-flight failure could restore the balance
// but leave the LEAVE rows standing (FIN-053).
//
// The fix: the span routes through the SAME paid-lock semantics as marking
// (findPaidRunForDate — monthly run = whole month, weekly run = its ISO week),
// refusal carries the adjustment-run pointer, the attendance.process override
// mirrors the marking path (audited), and the whole cancel is ONE transaction.
// Driven through the real dispatcher.
import "./_testdb"
import { describe, test, expect } from "bun:test"
import { db } from "@/lib/db"
import { mkVendor, mkUser, mkEmployee, mkSession, uniq, defaultCompanyId } from "./_fixtures"
import { postHrm } from "./_hrm-endpoint"

/** Fresh world with an APPROVED paid leave 2026-07-06…08 (Mon–Wed) whose
 *  synthetic LEAVE rows carry the "(approved" marker the cancel path keys on. */
async function world(paid: boolean) {
  const v = await mkVendor(uniq("fin005"))
  const u = await mkUser(v.id, { role: "VENDOR_OWNER", name: "FIN-005 Owner" })
  const emp = await mkEmployee(v.id, { fullName: "FIN-005 Leave Taker" })
  const token = await mkSession(u.id, "FULL")
  const type = await db.leaveType.create({
    data: { companyId: await defaultCompanyId(v.id), vendorId: v.id, code: uniq("PL"), name: "Paid Leave FIN-005", paid: true, defaultDays: 10 },
  })
  await db.leaveBalance.create({
    data: { vendorId: v.id, employeeId: emp.id, leaveTypeId: type.id, year: 2026, entitled: 10, used: 3, pending: 0, carriedForward: 0 },
  })
  const req = await db.leaveRequest.create({
    data: { vendorId: v.id, employeeId: emp.id, leaveTypeId: type.id, fromDate: "2026-07-06", toDate: "2026-07-08", days: 3, status: "APPROVED", reason: "FIN-005 fixture" },
  })
  for (const d of ["2026-07-06", "2026-07-07", "2026-07-08"]) {
    await db.attendance.create({
      data: { vendorId: v.id, employeeId: emp.id, date: d, status: "LEAVE", source: "MANUAL", remarks: "Leave (approved via FIN-005 fixture)" },
    })
  }
  if (paid) {
    const run = await db.payrollRun.create({
      data: { companyId: await defaultCompanyId(v.id), vendorId: v.id, periodMonth: 7, periodYear: 2026, periodWeek: 0, frequency: "MONTHLY", runType: "REGULAR", status: "DRAFT", createdBy: u.id },
    })
    await db.payrollRun.update({ where: { id: run.id }, data: { status: "PAID", paymentDate: new Date().toISOString() } })
  }
  return { v, u, emp, type, req, token }
}

const stateOf = async (v: string, emp: string, type: string, req: string) => ({
  req: (await db.leaveRequest.findUnique({ where: { id: req } }))!.status,
  rows: await db.attendance.findMany({ where: { vendorId: v, employeeId: emp, date: { gte: "2026-07-06", lte: "2026-07-08" } } }),
  bal: await db.leaveBalance.findFirst({ where: { vendorId: v, employeeId: emp, leaveTypeId: type, year: 2026 } }),
})

describe("FIN-005 — leave cancel money-safety (Phase 0)", () => {
  test("PAID period: cancel refused with the adjustment-run pointer, nothing changes", async () => {
    const { v, emp, type, req, token } = await world(true)
    const r = await postHrm("leaveRequests.cancel", { id: req.id }, { bearer: token })
    expect(r.status).toBe(409)
    expect(r.body.error).toContain("already PAID")
    expect(r.body.error).toContain("ADJUSTMENT run")
    const s = await stateOf(v.id, emp.id, type.id, req.id)
    expect(s.req).toBe("APPROVED")           // claim never happened
    expect(s.rows.length).toBe(3)            // LEAVE rows still standing
    expect(s.rows.every((x) => x.status === "LEAVE")).toBe(true)
    expect(s.bal!.used).toBe(3)              // balance untouched
  })

  test("unpaid period: cancel proceeds normally (rows removed, balance restored)", async () => {
    const { v, emp, type, req, token } = await world(false)
    const r = await postHrm("leaveRequests.cancel", { id: req.id }, { bearer: token })
    expect(r.status).toBe(200)
    expect(r.body.data.cancelled).toBe(true)
    const s = await stateOf(v.id, emp.id, type.id, req.id)
    expect(s.req).toBe("CANCELLED")
    expect(s.rows.length).toBe(0)            // synthetic rows removed
    expect(s.bal!.used).toBe(0)              // 3 days restored
  })

  test("attendance.process + overridePaidLock: explicit override proceeds and is audited", async () => {
    const { v, emp, type, req, token } = await world(true)
    const r = await postHrm("leaveRequests.cancel", { id: req.id, overridePaidLock: true }, { bearer: token })
    expect(r.status).toBe(200)
    const s = await stateOf(v.id, emp.id, type.id, req.id)
    expect(s.req).toBe("CANCELLED")
    expect(s.rows.length).toBe(0)
    expect(s.bal!.used).toBe(0)
    const auditRow = await db.auditLog.findFirst({ where: { vendorId: v.id, action: "attendance.paidPeriodOverride" } })
    expect(auditRow?.summary).toContain("Overriding the PAID payroll-period lock to cancel approved leave")
  })

  test("FIN-053: a mid-cancel crash rolls the WHOLE cancel back (one transaction)", async () => {
    const { v, emp, type, req, token } = await world(false)
    // simulate a crash at the attendance-rewrite step, INSIDE the transaction
    const origTx = (db as any).$transaction.bind(db)
    ;(db as any).$transaction = async (fn: any, opts?: any) =>
      origTx(async (tx: any) => {
        tx.attendance.delete = async () => { throw new Error("simulated mid-cancel crash (FIN-053)") }
        return fn(tx)
      }, opts)
    try {
      const r = await postHrm("leaveRequests.cancel", { id: req.id }, { bearer: token })
      expect(r.status).toBeGreaterThanOrEqual(500)
    } finally {
      ;(db as any).$transaction = origTx
    }
    const s = await stateOf(v.id, emp.id, type.id, req.id)
    // NOTHING persisted: not the CANCELLED claim, not the balance restore,
    // not a partial span rewrite (the old sequence half-applied here)
    expect(s.req).toBe("APPROVED")
    expect(s.bal!.used).toBe(3)
    expect(s.rows.length).toBe(3)
    expect(s.rows.every((x) => x.status === "LEAVE")).toBe(true)
  })
})

/// <reference types="bun-types" -*-
// ============ H-9 regression: leave-balance concurrency discipline ============
// Audit H-9 (High): mixed concurrency discipline in the leave flow —
//   1. the remaining-balance check read a PRE-TRANSACTION snapshot while the
//      pending increment ran inside the tx: two concurrent applications both
//      passed and both incremented (over-reserved balance, no DB constraint)
//   2. approval/cancel wrote `pending` as an ABSOLUTE value computed from a
//      stale read while `used` used an atomic increment: concurrent approvals
//      lost one pending-decrement (pending stuck > 0 or wrong)
//
// Fix under test: (1) the balance row is locked FOR UPDATE inside the apply
// transaction and the remaining check re-runs on the locked row; (2) approval
// and cancel use guarded atomic decrements (updateMany where pending >= days,
// clamp fallback for corrupted history — never negative).
//
// Route-layer: everything drives POST /api/hrm (apply + approvals.act).
import "./_testdb"
import { describe, test, expect, beforeAll } from "bun:test"
import { db } from "@/lib/db"
import { mkVendor, mkUser, mkEmployee, mkSession, uniq } from "./_fixtures"
import { postHrm } from "./_hrm-endpoint"
import { leaveYearOf } from "@/hrm-server/leave-math"

let vendor: { id: string }
let empUserToken: string
let approverToken: string
let employeeId: string
let leaveTypeId: string

/** Module-level base date for every range in this file — chosen so that ALL
 *  test ranges land in the SAME calendar year (balance rows are per-year) and
 *  never overlap each other (the overlap guard is per-employee across types).
 *  If the +90-day window would cross year-end, jump to Jan 10 of next year. */
const BASE = (() => {
  let b = new Date()
  b.setDate(b.getDate() + 90)
  const yearEnd = new Date(b.getFullYear(), 11, 31)
  if (yearEnd.getTime() - b.getTime() < 170 * 86400000) b = new Date(b.getFullYear() + 1, 0, 10)
  return b
})()

/** n working days (weeklyOff=FRIDAY) starting `offsetDays` past BASE. */
function workDayRange(n: number, offsetDays: number): { fromDate: string; toDate: string } {
  const DAY = ["SUNDAY", "MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY"]
  const iso = (x: Date) => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`
  const from = new Date(BASE)
  from.setDate(from.getDate() + offsetDays)
  while (DAY[from.getDay()] === "FRIDAY") from.setDate(from.getDate() + 1)
  const cursor = new Date(from)
  let count = 0
  let last = new Date(from)
  while (count < n) {
    if (DAY[cursor.getDay()] !== "FRIDAY") { count++; last = new Date(cursor) }
    cursor.setDate(cursor.getDate() + 1)
  }
  return { fromDate: iso(from), toDate: iso(last) }
}

async function applyLeave(token: string, typeId: string, range: { fromDate: string; toDate: string }) {
  return postHrm("leaveRequests.apply", {
    employeeId, leaveTypeId: typeId, fromDate: range.fromDate, toDate: range.toDate,
    reason: "H9 test",
  }, { bearer: token })
}

beforeAll(async () => {
  vendor = await mkVendor("H9 Leave Vendor")
  const emp = await mkEmployee(vendor.id, { fullName: "H9 Employee" })
  employeeId = emp.id
  const empUser = await mkUser(vendor.id, { role: "EMPLOYEE", name: "H9 Self", employeeId })
  empUserToken = await mkSession(empUser.id, "FULL")
  const approver = await mkUser(vendor.id, { role: "VENDOR_OWNER", name: "H9 Approver", email: `h9-appr-${uniq()}@test.local` })
  approverToken = await mkSession(approver.id, "FULL")

  const wf = await db.approvalWorkflow.create({
    data: { vendorId: vendor.id, processType: "LEAVE", name: `Leave ${uniq()}`, active: true },
  })
  await db.approvalStep.create({
    data: { vendorId: wf.vendorId, workflowId: wf.id, sequence: 1, name: "Owner Approval", approverRole: "VENDOR_OWNER", required: true, rejectBehavior: "REJECT_ALL", departmentScope: false, branchScope: false, amountThreshold: null, allowDelegation: false },
  })
})

describe("H-9 apply: balance check is serialized inside the transaction", () => {
  test("two CONCURRENT applications cannot over-reserve the balance", async () => {
    // balance auto-creates with type.defaultDays = 10 → remaining 10
    leaveTypeId = (await db.leaveType.create({
      data: { vendorId: vendor.id, code: uniq("H9A"), name: "Annual H9 A", defaultDays: 10, paid: true },
    })).id
    // two NON-overlapping 8-day ranges, SAME calendar year (one balance row)
    const range = workDayRange(8, 0)
    const far = workDayRange(8, 30)

    const [a, b] = await Promise.allSettled([
      applyLeave(empUserToken, leaveTypeId, range),
      applyLeave(empUserToken, leaveTypeId, far),
    ])
    type Settled = PromiseFulfilledResult<{ status: number; body: any }>
    const ok = (r: PromiseSettledResult<{ status: number; body: any }>): r is Settled => r.status === "fulfilled"
    const oks = [a, b].filter(ok).filter((r) => r.value.status === 200)
    const denied = [a, b].filter(ok).filter((r) => r.value.status !== 200)
    // entitled 10, each request 8 working days → exactly ONE may reserve
    expect(oks.length).toBe(1) // ← was 2 (both passed the stale check → pending 16/10)
    expect(denied.length).toBe(1)
    expect(denied[0]!.value.body.error).toMatch(/insufficient balance: 2 day/i)
    const bal = await db.leaveBalance.findFirst({ where: { employeeId, leaveTypeId, year: leaveYearOf(range.fromDate, 6) } })
    expect(bal?.pending).toBeLessThanOrEqual(8)
  })
})

describe("H-9 approval: pending decrement is atomic and guarded", () => {
  test("two CONCURRENT approvals of different requests both land (no lost update)", async () => {
    // fresh type: 10 days entitlement; two sequential 5-day applications
    const typeId = (await db.leaveType.create({
      data: { vendorId: vendor.id, code: uniq("H9B"), name: "Annual H9 B", defaultDays: 10, paid: true },
    })).id
    const r1 = workDayRange(5, 60)
    const r2 = workDayRange(5, 90)

    const a1 = await applyLeave(empUserToken, typeId, r1)
    const a2 = await applyLeave(empUserToken, typeId, r2)
    expect(a1.status).toBe(200)
    expect(a2.status).toBe(200)

    const reqs = await db.leaveRequest.findMany({ where: { employeeId, leaveTypeId: typeId, status: "PENDING" } })
    expect(reqs.length).toBe(2)
    const approvals = await db.approvalRequest.findMany({ where: { entityId: { in: reqs.map((r) => r.id) }, processType: "LEAVE" } })

    // approve BOTH concurrently
    const acts = await Promise.allSettled(
      approvals.map((ap) => postHrm("approvals.act", { requestId: ap.id, decision: "APPROVE" }, { bearer: approverToken })),
    )
    for (const r of acts) expect(r.status === "fulfilled" && r.value.status === 200).toBe(true)

    const bal = await db.leaveBalance.findFirst({ where: { employeeId, leaveTypeId: typeId } })
    expect(bal?.used).toBe(10)
    expect(bal?.pending).toBe(0) // ← old absolute write left pending=5 (lost update)
  })

  test("a corrupted short reservation is clamped, never negative", async () => {
    const typeId = (await db.leaveType.create({
      data: { vendorId: vendor.id, code: uniq("H9C"), name: "Annual H9 C", defaultDays: 20, paid: true },
    })).id
    const r = workDayRange(5, 120)
    const applied = await applyLeave(empUserToken, typeId, r)
    expect(applied.status).toBe(200)
    const req = await db.leaveRequest.findFirst({ where: { employeeId, leaveTypeId: typeId, status: "PENDING" } })
    // simulate corrupted history: the reservation is short (3 of 5 days)
    await db.leaveBalance.updateMany({ where: { employeeId, leaveTypeId: typeId }, data: { pending: 3 } })
    const approval = await db.approvalRequest.findFirst({ where: { entityId: req!.id, processType: "LEAVE" } })
    const act = await postHrm("approvals.act", { requestId: approval!.id, decision: "APPROVE" }, { bearer: approverToken })
    expect(act.status).toBe(200)
    const bal = await db.leaveBalance.findFirst({ where: { employeeId, leaveTypeId: typeId } })
    expect(bal?.pending).toBe(0)     // clamped from 3
    expect(bal?.used).toBe(5)        // the days were still consumed
    expect((bal?.pending ?? 0) >= 0).toBe(true) // never negative
  })
})

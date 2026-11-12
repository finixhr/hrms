/// <reference types="bun-types" />
// ============ Phase 3 leave money-safety regressions (FIN-014 / FIN-015 / FIN-051) ============
// FIN-015 — concurrent OVERLAPPING leave applications of DIFFERENT types used to
//   race past the per-type balance-row lock (different types lock different
//   rows): both in-tx overlap re-checks read pre-commit state, both inserted,
//   both later approved, both charged their balance and both wrote LEAVE rows
//   for the same dates. Fix: a transaction-scoped pg_advisory_xact_lock on the
//   EMPLOYEE id serializes every application for that employee.
// FIN-051 — a 250-day request charged the FULL computed days while the finalize
//   loop capped row-writing at 200 days; days 201+ fell to the ABSENT sweep
//   (payroll deducted days the ledger says were paid leave). Fix: spans beyond
//   MAX_LEAVE_SPAN_DAYS are rejected at apply time.
// FIN-014 — approving a backdated request overwrote ABSENT rows a PAID run had
//   already deducted for (mirror image of FIN-005 on the cancel side). Fix:
//   paid-covered days are NOT rewritten (the payslip snapshot stays immutable),
//   the balance IS charged (the approval stands), and HR gets an audited
//   adjustment-run pointer.
// Everything drives the real POST /api/hrm dispatcher.
import "./_testdb"
import { describe, test, expect, beforeAll } from "bun:test"
import { db } from "@/lib/db"
import { mkVendor, mkUser, mkEmployee, mkSession, uniq, defaultCompanyId } from "./_fixtures"
import { postHrm } from "./_hrm-endpoint"

let vendor: { id: string }
let empUserToken: string
let ownerToken: string
let employeeId: string

/** Future-date base (same discipline as h9: never crosses into a past year,
 *  ranges within one calendar year). */
const BASE = (() => {
  let b = new Date()
  b.setDate(b.getDate() + 90)
  const yearEnd = new Date(b.getFullYear(), 11, 31)
  if (yearEnd.getTime() - b.getTime() < 320 * 86400000) b = new Date(b.getFullYear() + 1, 0, 10)
  return b
})()

const iso = (x: Date) => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`
/** n calendar days starting `offsetDays` past BASE. */
function span(offsetDays: number, n: number): { fromDate: string; toDate: string } {
  const from = new Date(BASE)
  from.setDate(from.getDate() + offsetDays)
  const to = new Date(from)
  to.setDate(to.getDate() + n - 1)
  return { fromDate: iso(from), toDate: iso(to) }
}

beforeAll(async () => {
  vendor = await mkVendor(uniq("P3L"))
  const emp = await mkEmployee(vendor.id, { fullName: "Phase3 Leave Taker" })
  employeeId = emp.id
  const empUser = await mkUser(vendor.id, { role: "EMPLOYEE", name: "P3 Self", employeeId })
  empUserToken = await mkSession(empUser.id, "FULL")
  const owner = await mkUser(vendor.id, { role: "VENDOR_OWNER", name: "P3 Approver", email: `p3-appr-${uniq()}@test.local` })
  ownerToken = await mkSession(owner.id, "FULL")

  const wf = await db.approvalWorkflow.create({
    data: { companyId: await defaultCompanyId(vendor.id), vendorId: vendor.id, processType: "LEAVE", name: `Leave ${uniq()}`, active: true },
  })
  await db.approvalStep.create({
    data: { vendorId: wf.vendorId, workflowId: wf.id, sequence: 1, name: "Owner Approval", approverRole: "VENDOR_OWNER", required: true, rejectBehavior: "REJECT_ALL", departmentScope: false, branchScope: false, amountThreshold: null, allowDelegation: false },
  })
})

async function applyLeave(token: string, typeId: string, range: { fromDate: string; toDate: string }) {
  return postHrm("leaveRequests.apply", {
    employeeId, leaveTypeId: typeId, fromDate: range.fromDate, toDate: range.toDate,
    reason: "Phase 3 leave test",
  }, { bearer: token })
}

describe("FIN-015 — per-employee serialization closes the cross-type overlap race", () => {
  test("two CONCURRENT OVERLAPPING applications of DIFFERENT types: exactly one lands", async () => {
    const typeA = await db.leaveType.create({
      data: { companyId: await defaultCompanyId(vendor.id), vendorId: vendor.id, code: uniq("P3XA"), name: "Annual P3 A", defaultDays: 20, paid: true },
    })
    const typeB = await db.leaveType.create({
      data: { companyId: await defaultCompanyId(vendor.id), vendorId: vendor.id, code: uniq("P3XB"), name: "Annual P3 B", defaultDays: 20, paid: true },
    })
    // OVERLAPPING ranges (the whole point: different types, same employee, same days)
    const range = span(0, 5)

    const [a, b] = await Promise.allSettled([
      applyLeave(empUserToken, typeA.id, range),
      applyLeave(empUserToken, typeB.id, range),
    ])
    type Settled = PromiseFulfilledResult<{ status: number; body: any }>
    const ok = (r: PromiseSettledResult<{ status: number; body: any }>): r is Settled => r.status === "fulfilled"
    const oks = [a, b].filter(ok).filter((r) => r.value.status === 200)
    const denied = [a, b].filter(ok).filter((r) => r.value.status !== 200)
    // ← before the advisory lock, BOTH returned 200 (both balance rows locked
    // independently, both overlap re-checks read pre-commit state)
    expect(oks.length).toBe(1)
    expect(denied.length).toBe(1)
    expect(denied[0]!.value.body.error).toMatch(/overlapping/i)
    // exactly ONE request row exists for those dates — not two competing ones
    const rows = await db.leaveRequest.findMany({
      where: { employeeId, fromDate: range.fromDate, toDate: range.toDate },
    })
    expect(rows.length).toBe(1)
  })
})

describe("FIN-051 — leave spans are bounded by what the row-writer can complete", () => {
  test("a 251-day span is rejected with the split-the-request message", async () => {
    const type = await db.leaveType.create({
      data: { companyId: await defaultCompanyId(vendor.id), vendorId: vendor.id, code: uniq("P3XL"), name: "Long P3", defaultDays: 300, paid: true },
    })
    const r = await applyLeave(empUserToken, type.id, span(30, 251))
    expect(r.status).toBe(400)
    expect(r.body.error).toMatch(/longer than 200 days are not supported \(asked 251 days\)/)
    expect(r.body.error).toMatch(/split the request/i)
    // nothing was charged, nothing was written
    const reqs = await db.leaveRequest.findMany({ where: { employeeId, leaveTypeId: type.id } })
    expect(reqs.length).toBe(0)
  })

  test("a 200-day span still passes (the boundary itself is allowed)", async () => {
    const type = await db.leaveType.create({
      data: { companyId: await defaultCompanyId(vendor.id), vendorId: vendor.id, code: uniq("P3XG"), name: "Boundary P3", defaultDays: 300, paid: true },
    })
    const r = await applyLeave(empUserToken, type.id, span(30, 200))
    expect(r.status).toBe(200)
  })
})

describe("FIN-014 — approving backdated leave inside a PAID period", () => {
  /** Backdated world: ABSENT rows for 2026-07-06…08 and (optionally) a PAID
   *  monthly run covering July 2026. Backdating is enabled through settings. */
  async function backdatedWorld(paid: boolean) {
    const v = await mkVendor(uniq("fin014"))
    const u = await mkUser(v.id, { role: "VENDOR_OWNER", name: "FIN-014 Owner" })
    // FIN-014's paid-period report notifies the HR_ADMIN role — make sure one exists
    await mkUser(v.id, { role: "HR_ADMIN", name: "FIN-014 HR", email: `fin014-hr-${uniq()}@test.local` })
    const emp = await mkEmployee(v.id, { fullName: "FIN-014 Backdated Taker" })
    const token = await mkSession(u.id, "FULL")
    const empUser = await mkUser(v.id, { role: "EMPLOYEE", name: "FIN-014 Self", employeeId: emp.id })
    const selfToken = await mkSession(empUser.id, "FULL")
    const type = await db.leaveType.create({
      data: { companyId: await defaultCompanyId(v.id), vendorId: v.id, code: uniq("BL"), name: "Paid Leave FIN-014", paid: true, defaultDays: 10 },
    })
    await db.leaveBalance.create({
      data: { vendorId: v.id, employeeId: emp.id, leaveTypeId: type.id, year: 2026, entitled: 10, used: 0, pending: 0, carriedForward: 0 },
    })
    // enable backdating wide enough for July 2026
    await db.hrSetting.create({ data: { vendorId: v.id, group: "leave", key: "allowBackdated", value: "true" } })
    await db.hrSetting.create({ data: { vendorId: v.id, group: "leave", key: "maxBackdateDays", value: "365" } })
    // ABSENT rows the paid run already deducted for
    for (const d of ["2026-07-06", "2026-07-07", "2026-07-08"]) {
      await db.attendance.create({
        data: { vendorId: v.id, employeeId: emp.id, date: d, status: "ABSENT", source: "MANUAL", remarks: "absent (fixture)" },
      })
    }
    if (paid) {
      const run = await db.payrollRun.create({
        data: { companyId: await defaultCompanyId(v.id), vendorId: v.id, periodMonth: 7, periodYear: 2026, periodWeek: 0, frequency: "MONTHLY", runType: "REGULAR", status: "DRAFT", createdBy: u.id },
      })
      await db.payrollRun.update({ where: { id: run.id }, data: { status: "PAID", paymentDate: new Date().toISOString() } })
    }
    // approval workflow for the fresh vendor
    const wf = await db.approvalWorkflow.create({
      data: { companyId: await defaultCompanyId(v.id), vendorId: v.id, processType: "LEAVE", name: `Leave ${uniq()}`, active: true },
    })
    await db.approvalStep.create({
      data: { vendorId: wf.vendorId, workflowId: wf.id, sequence: 1, name: "Owner Approval", approverRole: "VENDOR_OWNER", required: true, rejectBehavior: "REJECT_ALL", departmentScope: false, branchScope: false, amountThreshold: null, allowDelegation: false },
    })
    return { v, u, emp, type, token, selfToken }
  }

  test("PAID period: the ABSENT rows are NOT rewritten, balance IS charged, HR is told with the adjustment-run pointer", async () => {
    const { v, emp, type, token, selfToken } = await backdatedWorld(true)
    const apply = await postHrm("leaveRequests.apply", {
      employeeId: emp.id, leaveTypeId: type.id, fromDate: "2026-07-06", toDate: "2026-07-08", reason: "late-approved backdated",
    }, { bearer: selfToken })
    expect(apply.status).toBe(200)
    const req = (await db.leaveRequest.findMany({ where: { employeeId: emp.id, leaveTypeId: type.id, status: "PENDING" } }))[0]
    const approval = await db.approvalRequest.findFirst({ where: { entityId: req.id, processType: "LEAVE" } })
    const act = await postHrm("approvals.act", { requestId: approval!.id, decision: "APPROVE" }, { bearer: token })
    expect(act.status).toBe(200)

    // the approval stands
    const after = await db.leaveRequest.findUnique({ where: { id: req.id } })
    expect(after!.status).toBe("APPROVED")
    // balance charged for all 3 days
    const bal = await db.leaveBalance.findFirst({ where: { employeeId: emp.id, leaveTypeId: type.id, year: 2026 } })
    expect(bal!.used).toBe(3)
    expect(bal!.pending).toBe(0)
    // the paid attendance days are left EXACTLY as the paid run computed them
    const rows = await db.attendance.findMany({
      where: { vendorId: v.id, employeeId: emp.id, date: { gte: "2026-07-06", lte: "2026-07-08" } },
      orderBy: { date: "asc" },
    })
    expect(rows.length).toBe(3)
    expect(rows.every((x) => x.status === "ABSENT")).toBe(true) // ← was LEAVE: the silent rewrite
    expect(rows.every((x) => x.remarks === "absent (fixture)")).toBe(true)
    // the audited report + the HR notification with the adjustment-run pointer
    const auditRow = await db.auditLog.findFirst({ where: { vendorId: v.id, action: "leave.approvalPaidPeriodSkip" } })
    expect(auditRow?.summary).toContain("attendance NOT rewritten")
    expect(auditRow?.summary).toContain("ADJUSTMENT run")
    const note = await db.notification.findFirst({ where: { vendorId: v.id, title: "Leave Approved Inside Paid Period" } })
    expect(note?.message).toContain("payslip snapshot is immutable")
  })

  test("unpaid period: the approval writes LEAVE rows normally (no gate tripped)", async () => {
    const { v, emp, type, token, selfToken } = await backdatedWorld(false)
    const apply = await postHrm("leaveRequests.apply", {
      employeeId: emp.id, leaveTypeId: type.id, fromDate: "2026-07-06", toDate: "2026-07-08", reason: "normal backdated",
    }, { bearer: selfToken })
    expect(apply.status).toBe(200)
    const req = (await db.leaveRequest.findMany({ where: { employeeId: emp.id, leaveTypeId: type.id, status: "PENDING" } }))[0]
    const approval = await db.approvalRequest.findFirst({ where: { entityId: req.id, processType: "LEAVE" } })
    const act = await postHrm("approvals.act", { requestId: approval!.id, decision: "APPROVE" }, { bearer: token })
    expect(act.status).toBe(200)
    const rows = await db.attendance.findMany({
      where: { vendorId: v.id, employeeId: emp.id, date: { gte: "2026-07-06", lte: "2026-07-08" } },
    })
    expect(rows.every((x) => x.status === "LEAVE")).toBe(true)
    const auditRow = await db.auditLog.findFirst({ where: { vendorId: v.id, action: "leave.approvalPaidPeriodSkip" } })
    expect(auditRow).toBeNull() // no gate, no noise
  })

  test("weekly paid run covers ONLY its own ISO week (FIN-076 semantics carried into FIN-014)", async () => {
    // a paid WEEKLY run for the ISO week of 2026-07-06 (Monday of week 28) locks
    // exactly those 7 days; a leave spanning into the NEXT week is written only
    // on its editable days.
    const { v, emp, type, token, selfToken } = await backdatedWorld(false)
    // extend the ABSENT fixture through the whole paid week + one day beyond
    for (const d of ["2026-07-09", "2026-07-10", "2026-07-11", "2026-07-12", "2026-07-13"]) {
      await db.attendance.create({
        data: { vendorId: v.id, employeeId: emp.id, date: d, status: "ABSENT", source: "MANUAL", remarks: "absent (fixture)" },
      }).catch(() => { /* 07-06..08 already exist */ })
    }
    const run = await db.payrollRun.create({
      data: { companyId: await defaultCompanyId(v.id), vendorId: v.id, periodMonth: 7, periodYear: 2026, periodWeek: 28, frequency: "WEEKLY", runType: "REGULAR", status: "DRAFT", createdBy: (await mkUser(v.id, { role: "VENDOR_OWNER" })).id },
    })
    await db.payrollRun.update({ where: { id: run.id }, data: { status: "PAID", paymentDate: new Date().toISOString() } })
    // spans the paid week (07-06…12) and one day of the NEXT week (07-13, Monday of week 29)
    const apply = await postHrm("leaveRequests.apply", {
      employeeId: emp.id, leaveTypeId: type.id, fromDate: "2026-07-06", toDate: "2026-07-13", reason: "cross-week backdated",
    }, { bearer: selfToken })
    expect(apply.status).toBe(200)
    const req = (await db.leaveRequest.findMany({ where: { employeeId: emp.id, leaveTypeId: type.id, status: "PENDING" } }))[0]
    const approval = await db.approvalRequest.findFirst({ where: { entityId: req.id, processType: "LEAVE" } })
    await postHrm("approvals.act", { requestId: approval!.id, decision: "APPROVE" }, { bearer: token })
    // every day INSIDE the paid ISO week stays untouched …
    for (const d of ["2026-07-06", "2026-07-07", "2026-07-08", "2026-07-09", "2026-07-10", "2026-07-11", "2026-07-12"]) {
      const row = await db.attendance.findFirst({ where: { vendorId: v.id, employeeId: emp.id, date: d } })
      expect(`${d}=${row?.status}`).toBe(`${d}=ABSENT`)
    }
    // … while the day in the NEXT (not-paid) week is written as LEAVE
    const nextWeek = await db.attendance.findFirst({ where: { vendorId: v.id, employeeId: emp.id, date: "2026-07-13" } })
    expect(nextWeek?.status).toBe("LEAVE")
  })
})

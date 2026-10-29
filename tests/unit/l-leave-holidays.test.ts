/// <reference types="bun-types" />
// ============ L-9 regression: holiday-aware leave day counting ============
// Audit L-9 (Low): leaveDaysBetween ignored vendor holidays — a PUBLIC
// holiday inside a leave span consumed balance even though the employee was
// not required to work that day (internally consistent, business quibble).
//
// Fix under test: a vendor setting (leave.countHolidaysAsLeave, default TRUE
// = historical behavior) — when FALSE, PUBLIC/COMPANY holidays inside the
// span are skipped in the day count AND in the attendance LEAVE marking, so
// consumed balance always equals LEAVE-marked days. OPTIONAL holidays are
// NEVER skipped (employee-elected, not company-wide days off).
// Route-layer: drives leaveRequests.apply through POST /api/hrm.
import "./_testdb"
import { describe, test, expect, beforeAll } from "bun:test"
import { db } from "@/lib/db"
import { mkVendor, mkUser, mkEmployee, mkSession, uniq } from "./_fixtures"
import { postHrm } from "./_hrm-endpoint"
import { saveSettingsGroup } from "@/hrm-server/settings"
import { leaveYearOf } from "@/hrm-server/leave-math"

const DAY = ["SUNDAY", "MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY"]
const iso = (x: Date) => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`

/** Three CONSECUTIVE calendar days (none a Friday) starting ~offsetDays out.
 *  Returns [d1, d2, d3] — the span is exactly 3 counted days before any
 *  holiday logic, so every assertion below is deterministic. */
function threeWorkdays(offsetDays: number): [string, string, string] {
  const d1 = new Date()
  d1.setDate(d1.getDate() + offsetDays)
  // advance until d1..d1+2 contains no Friday
  while ([0, 1, 2].some((k) => DAY[new Date(d1.getTime() + k * 86400000).getDay()] === "FRIDAY")) {
    d1.setDate(d1.getDate() + 1)
  }
  return [iso(d1), iso(new Date(d1.getTime() + 86400000)), iso(new Date(d1.getTime() + 2 * 86400000))]
}

let vendor: { id: string }
let employeeId: string
let empToken: string
let approverToken: string
let leaveTypeId: string

async function applyLeave(fromDate: string, toDate: string) {
  return postHrm("leaveRequests.apply", {
    employeeId, leaveTypeId, fromDate, toDate, reason: "L-9 holiday regression",
  }, { bearer: empToken })
}

beforeAll(async () => {
  vendor = await mkVendor("L9 Holiday Vendor")
  const emp = await mkEmployee(vendor.id, { fullName: "L9 Employee" })
  employeeId = emp.id
  const empUser = await mkUser(vendor.id, { role: "EMPLOYEE", name: "L9 Self", employeeId })
  empToken = await mkSession(empUser.id, "FULL")
  const approver = await mkUser(vendor.id, { role: "VENDOR_OWNER", name: "L9 Approver", email: `l9-appr-${uniq()}@test.local` })
  approverToken = await mkSession(approver.id, "FULL")

  const wf = await db.approvalWorkflow.create({ data: { vendorId: vendor.id, processType: "LEAVE", name: `L9 ${uniq()}`, active: true } })
  await db.approvalStep.create({ data: { vendorId: wf.vendorId, workflowId: wf.id, sequence: 1, name: "Owner Approval", approverRole: "VENDOR_OWNER", required: true, rejectBehavior: "REJECT_ALL", departmentScope: false, branchScope: false, amountThreshold: null, allowDelegation: false } })

  leaveTypeId = (await db.leaveType.create({
    data: { vendorId: vendor.id, code: uniq("L9"), name: "Annual L9", defaultDays: 30, paid: true },
  })).id
  await db.leaveBalance.create({ data: { vendorId: vendor.id, employeeId, leaveTypeId, year: new Date().getFullYear(), entitled: 30 } })
})

describe("L-9 — holidays inside a leave span vs balance", () => {
  test("DEFAULT (countHolidaysAsLeave=true): a PUBLIC holiday inside the span still consumes a day (historical behavior preserved)", async () => {
    const [d1, d2, d3] = threeWorkdays(120)
    await db.holiday.create({ data: { vendorId: vendor.id, name: "L9 National Day", date: d2, type: "PUBLIC" } })
    const r = await applyLeave(d1, d3)
    expect(r.status).toBe(200)
    expect(Number(r.body?.data?.days)).toBe(3) // holiday counted (default)
  })

  test("countHolidaysAsLeave=false: the PUBLIC holiday is skipped — fewer days consumed, and approval does not mark it LEAVE", async () => {
    await saveSettingsGroup(vendor.id, "leave", { countHolidaysAsLeave: false })
    const [d1, d2, d3] = threeWorkdays(130)
    await db.holiday.create({ data: { vendorId: vendor.id, name: "L9 Company Day", date: d2, type: "COMPANY" } })
    const r = await applyLeave(d1, d3)
    expect(r.status).toBe(200)
    expect(Number(r.body?.data?.days)).toBe(2) // holiday skipped
    const reqId = r.body?.data?.id as string

    // approve through the real workflow → attendance marking must skip d2 too
    const saved = await db.leaveRequest.findUnique({ where: { id: reqId } })
    expect(saved?.approvalRequestId).toBeTruthy()
    const act = await postHrm("approvals.act", { requestId: saved!.approvalRequestId!, decision: "APPROVE" }, { bearer: approverToken })
    expect(act.status).toBe(200)

    const rows = await db.attendance.findMany({ where: { vendorId: vendor.id, employeeId, date: { in: [d1, d2, d3] } } })
    const marked = new Set(rows.map((x) => x.date))
    expect(marked.has(d1)).toBe(true)
    expect(marked.has(d2)).toBe(false) // the holiday is NOT consumed as LEAVE
    expect(marked.has(d3)).toBe(true)

    // the balance row is per the FROM-DATE's LEAVE YEAR (LVE-104 — fiscal-year
    // keying: a March 2027 request charges the leave year that started July
    // 2026, the same row the July rollover carries from)
    const bal = await db.leaveBalance.findFirst({ where: { employeeId, leaveTypeId, year: leaveYearOf(d1, 6) } })
    expect(Number(bal?.used)).toBe(2) // exactly the counted days
  })

  test("OPTIONAL holidays are NEVER skipped (employee-elected, not company-wide)", async () => {
    // countHolidaysAsLeave is still false from the previous test
    const [d1, d2, d3] = threeWorkdays(140)
    await db.holiday.create({ data: { vendorId: vendor.id, name: "L9 Optional Day", date: d2, type: "OPTIONAL" } })
    const r = await applyLeave(d1, d3)
    expect(r.status).toBe(200)
    expect(Number(r.body?.data?.days)).toBe(3) // optional holiday still counts
  })

  test("weekly-off days remain skipped regardless of the setting", async () => {
    // a 7-calendar-day span always contains exactly one FRIDAY (weekly off)
    const [d1] = threeWorkdays(150)
    const d7 = iso(new Date(new Date(d1 + "T00:00:00").getTime() + 6 * 86400000)) // 7 calendar days: exactly one Friday inside
    const r = await applyLeave(d1, d7)
    expect(r.status).toBe(200)
    expect(Number(r.body?.data?.days)).toBe(6) // 7 calendar days − 1 Friday
  })
})

/// <reference types="bun-types" />
// ============ FIN-076 (Phase 0) — paid-lock scope for WEEKLY runs ============
// The defect: assertAttendanceDateEditable queried PAID runs by (year, month)
// only — it SELECTed periodWeek but never filtered on it. A paid WEEKLY run
// for week one therefore locked weeks two to four of the same month: HR could
// not mark attendance for a not-yet-paid week and got a "payroll is already
// PAID" error. The :104 comment even claimed the ISO week was checked.
//
// The fix: a MONTHLY run (periodWeek 0) locks its whole calendar month; a
// WEEKLY run locks ONLY its own ISO week. Driven through the real dispatcher
// (POST /api/hrm → attendance.mark), same as production traffic.
import "./_testdb"
import { describe, test, expect } from "bun:test"
import { db } from "@/lib/db"
import { mkVendor, mkUser, mkEmployee, mkSession, uniq, defaultCompanyId } from "./_fixtures"
import { postHrm } from "./_hrm-endpoint"

async function paidWorld(week: number, month = 7) {
  const v = await mkVendor(uniq("fin076"))
  const u = await mkUser(v.id, { role: "VENDOR_OWNER", name: "FIN-076 Owner" })
  const emp = await mkEmployee(v.id, { fullName: "FIN-076 Marker" })
  const token = await mkSession(u.id, "FULL")
  const run = await db.payrollRun.create({
    data: { companyId: await defaultCompanyId(v.id), vendorId: v.id, periodMonth: month, periodYear: 2026, periodWeek: week, frequency: week ? "WEEKLY" : "MONTHLY", runType: "REGULAR", status: "DRAFT", createdBy: u.id },
  })
  await db.payrollRun.update({ where: { id: run.id }, data: { status: "PAID", paymentDate: new Date().toISOString() } })
  return { v, u, emp, token, run }
}

async function mark(token: string, employeeId: string, date: string) {
  return postHrm("attendance.mark", { employeeId, date, checkIn: "09:00", checkOut: "17:00" }, { bearer: token })
}

describe("FIN-076 — paid-lock week scope (Phase 0)", () => {
  test("a paid WEEKLY run locks only ITS week — later weeks of the same month stay editable", async () => {
    // ISO week 29 of 2026 = Mon 2026-07-13 … Sun 2026-07-19
    const { emp, token } = await paidWorld(29)
    // inside the paid week → locked
    const inWeek = await mark(token, emp.id, "2026-07-15")
    expect(inWeek.status).toBe(409)
    expect(inWeek.body.error).toContain("ISO week 29")
    // week 30 of the SAME month (2026-07-22) → editable (the defect refused this)
    const nextWeek = await mark(token, emp.id, "2026-07-22")
    expect(nextWeek.status).toBe(200)
    // week 28 (2026-07-08, before the paid week) → editable too
    const prevWeek = await mark(token, emp.id, "2026-07-08")
    expect(prevWeek.status).toBe(200)
  })

  test("a paid MONTHLY run still locks the whole month (unchanged semantics)", async () => {
    const { emp, token } = await paidWorld(0) // July 2026 monthly
    const early = await mark(token, emp.id, "2026-07-03")
    expect(early.status).toBe(409)
    expect(early.body.error).toContain("already PAID")
    const late = await mark(token, emp.id, "2026-07-30")
    expect(late.status).toBe(409)
  })

  test("a paid weekly run locks the ISO WEEK, not the month it was created in", async () => {
    // Week 27 of 2026 = Mon 2026-06-29 … Sun 2026-07-05 — created for July, but
    // it covers Jun 29-30 too. The lock must follow the ISO week (the run's
    // actual pay window), not the calendar month of creation.
    const { emp, token } = await paidWorld(27, 7)
    const june30 = await mark(token, emp.id, "2026-06-30") // Tuesday of week 27
    expect(june30.status).toBe(409)
    const june24 = await mark(token, emp.id, "2026-06-24") // week 26 — not covered
    expect(june24.status).toBe(200)
    const august = await mark(token, emp.id, "2026-08-05")
    expect(august.status).toBe(200)
    const inWeek = await mark(token, emp.id, "2026-07-01") // Wednesday of week 27
    expect(inWeek.status).toBe(409)
  })
})

/// <reference types="bun-types" />
// ============ FIN-002 (Phase 0) — join proration + the policy switch ============
// The defect: a mid-month joiner received the FULL monthly gross (golden g4
// pinned ৳52,000 for 13 payable days). The fix prorates gross/components by
// the service fraction through the same single mulRatio boundary the weekly
// path uses, with a policy switch (settings.payroll.joinProration, default
// ON) for tenants whose contracts pay a full month by design.
//
// Covers: monthly mid-month joiner (13/26), the OFF switch restoring the
// contractual full-month behaviour, a mid-WEEK joiner on a WEEKLY run
// (service fraction composes with the weekly window in ONE boundary), and the
// identity guarantee for employees who predate the window. Each case gets its
// own vendor (PayrollRun is unique per vendor+period+runType).
import "./_testdb"
import { describe, test, expect } from "bun:test"
import { db } from "@/lib/db"
import { mkVendor, mkUser, mkEmployee, mkSession, uniq, defaultCompanyId } from "./_fixtures"
import { postHrm } from "./_hrm-endpoint"
import { calculateRun } from "@/hrm-server/payroll"

const isFriday = (ds: string) => new Date(ds + "T00:00:00Z").getUTCDay() === 5

/** Fresh vendor + joiner + structure + attendance + run for July 2026. */
async function mkWorld(joiningDate: string, week = 0) {
  const v = await mkVendor(uniq("fin002"))
  const u = await mkUser(v.id, { role: "VENDOR_OWNER", name: "FIN-002 Owner" })
  const emp = await mkEmployee(v.id, { fullName: `FIN-002 ${joiningDate}` })
  await db.employee.update({ where: { id: emp.id }, data: { joiningDate } })
  await db.salaryStructure.create({
    data: { vendorId: v.id, employeeId: emp.id, effectiveFrom: "2026-01-01", status: "ACTIVE", basic: 30000, houseRent: 15000, medical: 5000, conveyance: 2000, gross: 52000 },
  })
  const days: string[] = []
  for (let d = 1; d <= 31; d++) days.push(`2026-07-${String(d).padStart(2, "0")}`)
  const windowDays = week ? days.filter((d) => d >= "2026-07-13" && d <= "2026-07-19") : days
  await db.attendance.createMany({
    data: windowDays.filter((d) => !isFriday(d) && d >= joiningDate).map((d) => ({ vendorId: v.id, employeeId: emp.id, date: d, status: "PRESENT" })),
  })
  const run = await db.payrollRun.create({
    data: { companyId: await defaultCompanyId(v.id), vendorId: v.id, periodMonth: 7, periodYear: 2026, periodWeek: week, frequency: week ? "WEEKLY" : "MONTHLY", runType: "REGULAR", status: "DRAFT", createdBy: u.id },
  })
  return { v, u, emp, run }
}

const ctxLite = (u: any, v: any): any => ({ userId: u.id, userName: u.name, vendorId: v.id, role: "VENDOR_OWNER", permissions: new Set(["*"]), employeeId: null, ip: "127.0.0.1" })

describe("FIN-002 — join proration (Phase 0)", () => {
  test("monthly mid-month joiner: gross prorated by service days, no absence for pre-joining days", async () => {
    const { v, u, run } = await mkWorld("2026-07-16")
    await calculateRun(ctxLite(u, v), run.id)
    const e = await db.payrollEntry.findFirst({ where: { runId: run.id } })
    expect(e!.gross).toBe(26000) // 13/26 × 52,000 — July 2026, Friday off
    expect(e!.absentDays).toBe(0) // pre-joining days are skipped, not absent
    const bd = JSON.parse(e!.breakdownJson || "{}")
    expect(bd.proration.serviceDays).toBe(13)
    expect(bd.earnings[0]).toEqual({ label: "Basic (prorated)", amount: 15000 })
  })

  test("the policy switch OFF restores the contractual full-month behaviour", async () => {
    const { v, u, run } = await mkWorld("2026-07-16")
    const token = await mkSession(u.id, "FULL")
    const sv = await postHrm("settings.save", { group: "payroll", values: { joinProration: false } }, { bearer: token })
    expect(sv.status).toBe(200)
    await calculateRun(ctxLite(u, v), run.id)
    const e = await db.payrollEntry.findFirst({ where: { runId: run.id } })
    expect(e!.gross).toBe(52000) // full month by contract
    const bd = JSON.parse(e!.breakdownJson || "{}")
    expect(bd.proration).toBeUndefined()
  })

  test("weekly run with a mid-week joiner: service fraction composes with the weekly window", async () => {
    // ISO week 29 of 2026: Mon 2026-07-13 … Sun 2026-07-19; Friday off → 6 working days.
    // Joining 2026-07-15 → payable Wed 15, Thu 16, Sat 18, Sun 19 = 4 days.
    const { v, u, run } = await mkWorld("2026-07-15", 29)
    await calculateRun(ctxLite(u, v), run.id)
    const e = await db.payrollEntry.findFirst({ where: { runId: run.id } })
    expect(e!.gross).toBe(8000) // 4/26 × 52,000 = 8,000 — ONE boundary, not week(6/26)×join(4/6)
    const bd = JSON.parse(e!.breakdownJson || "{}")
    expect(bd.proration.frequency).toBe("WEEKLY")
    expect(bd.proration.serviceDays).toBe(4)
    expect(bd.proration.fraction).toBe(0.1538) // 4/26 rounded to 4 decimals
  })

  test("a joiner before the window is untouched to the paisa (identity)", async () => {
    const { v, u, run } = await mkWorld("2024-01-01")
    await calculateRun(ctxLite(u, v), run.id)
    const e = await db.payrollEntry.findFirst({ where: { runId: run.id } })
    expect(e!.gross).toBe(52000) // full month — mulRatio identity (payDays ≥ monthWD)
    expect(e!.grossPaisa).toBe(5200000n)
  })
})

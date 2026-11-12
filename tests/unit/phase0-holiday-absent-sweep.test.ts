/// <reference types="bun-types" />
// ============ FIN-006 (Phase 0) — the absent sweep consults the Holiday table ============
// The defect: materializeAbsentDay (the job that writes the ABSENT rows every
// report reads) checked weekly-offs, existing records and joining date — but
// NEVER the Holiday table. On every holiday the whole ACTIVE workforce was
// auto-marked ABSENT, poisoning the absent report, the monthly register, the
// long-absence alert and analytics. The ALERT half of the job (which does
// check holidays) even called the sweep right after skipping everyone for the
// holiday — the sweep then marked exactly those people absent.
//
// The fix: the sweep itself consults the Holiday table with the alert's
// ATT-006 semantics — branchId null = tenant-wide, branchId set = that branch
// only. 2026-10-14 is a Wednesday (not the default Friday weekly-off).
import "./_testdb"
import { describe, test, expect } from "bun:test"
import { db } from "@/lib/db"
import { mkVendor, mkUser, mkEmployee, mkBranch, uniq, defaultCompanyId } from "./_fixtures"
import { materializeAbsentDay } from "@/hrm-server/jobs"
import { getSettings } from "@/hrm-server/settings"

const DAY = "2026-10-14" // Wednesday

async function world() {
  const v = await mkVendor(uniq("fin006"))
  const branchA = await mkBranch(v.id, "Branch A")
  const branchB = await mkBranch(v.id, "Branch B")
  const empA = await mkEmployee(v.id, { branchId: branchA.id, fullName: "FIN-006 A" })
  const empB = await mkEmployee(v.id, { branchId: branchB.id, fullName: "FIN-006 B" })
  const settings = await getSettings(v.id, { noCache: true })
  return { v, branchA, branchB, empA, empB, settings }
}

const rowsFor = (vendorId: string, date: string) =>
  db.attendance.findMany({ where: { vendorId, date, status: "ABSENT" }, select: { employeeId: true } })

describe("FIN-006 — holiday-aware absent sweep (Phase 0)", () => {
  test("tenant-wide holiday: nobody is marked absent", async () => {
    const { v, empA, empB, settings } = await world()
    await db.holiday.create({ data: { companyId: await defaultCompanyId(v.id), vendorId: v.id, date: DAY, name: "FIN-006 Tenant Holiday", type: "PUBLIC" } })
    const n = await materializeAbsentDay(v.id, DAY, settings)
    expect(n).toBe(0)
    const rows = await rowsFor(v.id, DAY)
    expect(rows.length).toBe(0)
  })

  test("branch-specific holiday: only the OTHER branch is marked absent", async () => {
    const { v, branchB, empA, empB, settings } = await world()
    await db.holiday.create({ data: { companyId: await defaultCompanyId(v.id), vendorId: v.id, date: DAY, name: "FIN-006 Branch B Holiday", type: "PUBLIC", branchId: branchB.id } })
    const n = await materializeAbsentDay(v.id, DAY, settings)
    expect(n).toBe(1)
    const rows = await rowsFor(v.id, DAY)
    expect(rows.map((r) => r.employeeId)).toEqual([empA.id]) // A marked, B skipped
    expect(rows.some((r) => r.employeeId === empB.id)).toBe(false)
  })

  test("no holiday (control): both branches are marked absent — the sweep still works", async () => {
    const { v, empA, empB, settings } = await world()
    const n = await materializeAbsentDay(v.id, DAY, settings)
    expect(n).toBe(2)
    const rows = await rowsFor(v.id, DAY)
    expect(rows.some((r) => r.employeeId === empA.id)).toBe(true)
    expect(rows.some((r) => r.employeeId === empB.id)).toBe(true)
  })

  test("the alert path passes its holidays through (no double query divergence)", async () => {
    // preloaded holidays must be honored identically to a fresh query
    const { v, empA, empB, settings } = await world()
    const n = await materializeAbsentDay(v.id, DAY, settings, {
      emps: [
        { id: empA.id, joiningDate: "2024-01-01", weeklyOff: null, shiftId: null, branchId: null },
        { id: empB.id, joiningDate: "2024-01-01", weeklyOff: null, shiftId: null, branchId: null },
      ],
      recs: [],
      shiftOffById: new Map(),
      dow: "WEDNESDAY",
      holidays: [{ date: DAY, branchId: null }], // tenant-wide via the preloaded path
    })
    expect(n).toBe(0)
    const rows = await rowsFor(v.id, DAY)
    expect(rows.length).toBe(0)
  })
})

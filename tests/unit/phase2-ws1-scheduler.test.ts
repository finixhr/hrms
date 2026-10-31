// Phase 2 WS1 — SCL-1 due-vendor discovery + SCL-14 daily-job set-ification.
// Real-database test (bootstrap via tests/preload.ts, re-entrancy via ./_testdb).
import "./_testdb"
import { describe, expect, test } from "bun:test"
import { db } from "@/lib/db"
import { uniq } from "./_fixtures"
import {
  findDueVendors,
  materializeAbsentDay,
  _resetDueCursorForTests,
} from "@/hrm-server/jobs"
import { getSettings } from "@/hrm-server/settings"

function iso(daysAgo: number): string {
  const d = new Date(Date.now() - daysAgo * 86_400_000)
  return d.toISOString().slice(0, 10)
}

describe("SCL-1 findDueVendors — due-vendor discovery by query", () => {
  test("fresh vendors (no lastDailyDate) are due; completed vendors are not", async () => {
    const v1 = await db.vendor.create({ data: { name: "due-fresh", code: uniq("scl1a") } })
    const v2 = await db.vendor.create({ data: { name: "done-today", code: uniq("scl1b") } })
    const today = new Date().toISOString().slice(0, 10)
    await db.hrSetting.create({
      data: { vendorId: v2.id, group: "jobs", key: "lastDailyDate", value: JSON.stringify(today) },
    })
    _resetDueCursorForTests()
    const due = await findDueVendors(today, 10_000)
    expect(due).toContain(v1.id)
    expect(due).not.toContain(v2.id)
  })

  test("inactive vendors are never due", async () => {
    const v = await db.vendor.create({ data: { name: "inactive", code: uniq("scl1c"), active: false } })
    const today = new Date().toISOString().slice(0, 10)
    _resetDueCursorForTests()
    const due = await findDueVendors(today, 10_000)
    expect(due).not.toContain(v.id)
  })

  test("camera clause: enabled cameras + stale sweep = due; cameras done <10min ago = not due; camera-less = not due", async () => {
    const today = new Date().toISOString().slice(0, 10)
    // (a) vendor with camera, sweep never run → due
    const vA = await db.vendor.create({ data: { name: "cam-fresh", code: uniq("scl1d") } })
    await db.camera.create({ data: { vendorId: vA.id, name: "cam", brand: "HIKVISION", enabled: true } })
    // (b) vendor with camera, sweep 1 minute ago → NOT due by camera clause (daily clause may still make it due — set lastDailyDate to today)
    const vB = await db.vendor.create({ data: { name: "cam-recent", code: uniq("scl1e") } })
    await db.camera.create({ data: { vendorId: vB.id, name: "cam", brand: "HIKVISION", enabled: true } })
    await db.hrSetting.create({ data: { vendorId: vB.id, group: "jobs", key: "lastDailyDate", value: JSON.stringify(today) } })
    await db.hrSetting.create({ data: { vendorId: vB.id, group: "jobs", key: "lastCameraSweep", value: JSON.stringify(new Date(Date.now() - 60_000).toISOString()) } })
    // (c) camera-less vendor with daily done → NOT due
    const vC = await db.vendor.create({ data: { name: "no-cam", code: uniq("scl1f") } })
    await db.hrSetting.create({ data: { vendorId: vC.id, group: "jobs", key: "lastDailyDate", value: JSON.stringify(today) } })
    // (d) vendor with DISABLED camera only + daily done → NOT due
    const vD = await db.vendor.create({ data: { name: "cam-off", code: uniq("scl1g") } })
    await db.camera.create({ data: { vendorId: vD.id, name: "cam", brand: "HIKVISION", enabled: false } })
    await db.hrSetting.create({ data: { vendorId: vD.id, group: "jobs", key: "lastDailyDate", value: JSON.stringify(today) } })

    _resetDueCursorForTests()
    const due = await findDueVendors(today, 10_000)
    expect(due).toContain(vA.id)
    expect(due).not.toContain(vB.id)
    expect(due).not.toContain(vC.id)
    expect(due).not.toContain(vD.id)
  })

  test("corrupt lastCameraSweep value (non-JSON-timestamp) is treated as due, not a query crash", async () => {
    const today = new Date().toISOString().slice(0, 10)
    const v = await db.vendor.create({ data: { name: "corrupt-sweep", code: uniq("scl1h") } })
    await db.camera.create({ data: { vendorId: v.id, name: "cam", brand: "HIKVISION", enabled: true } })
    await db.hrSetting.create({ data: { vendorId: v.id, group: "jobs", key: "lastDailyDate", value: JSON.stringify(today) } })
    await db.hrSetting.create({ data: { vendorId: v.id, group: "jobs", key: "lastCameraSweep", value: "not-json" } })
    _resetDueCursorForTests()
    const due = await findDueVendors(today, 10_000)
    expect(due).toContain(v.id)
  })

  test("round-robin purity: results are id-ordered and the function never mutates the cursor", async () => {
    const today = new Date().toISOString().slice(0, 10)
    const mk = async (n: number) => db.vendor.create({ data: { name: `rr-${n}`, code: uniq(`scl1rr${n}`) } })
    await mk(1); await mk(2); await mk(3)
    _resetDueCursorForTests()
    const page1 = await findDueVendors(today, 2)
    expect(page1.length).toBe(2)
    expect(page1[0] < page1[1]).toBe(true) // id-ordered
    // pure call: cursor untouched → same first page again
    const page1again = await findDueVendors(today, 2)
    expect(page1again).toEqual(page1)
  })
})

describe("SCL-14 materializeAbsentDay — createMany + slim selects", () => {
  test("absent rows materialize once, duplicates and races are no-ops, count matches attempts", async () => {
    const v = await db.vendor.create({ data: { name: "scl14", code: uniq("scl14") } })
    const yesterday = iso(1)
    const e1 = await db.employee.create({ data: { vendorId: v.id, code: uniq("E1"), fullName: "A", joiningDate: iso(300) } })
    const e2 = await db.employee.create({ data: { vendorId: v.id, code: uniq("E2"), fullName: "B", joiningDate: iso(300) } })
    // e2 already has an attendance row → not materialized
    await db.attendance.create({ data: { vendorId: v.id, employeeId: e2.id, date: yesterday, status: "PRESENT" } })
    // De-flake (M5, 2026-10-31): the default weekly holiday is FRIDAY (BD
    // convention) — when `yesterday` (a RELATIVE date) lands on it the sweep
    // skips everyone and the count assertions fail for calendar reasons only
    // (reproduced on Sat 2026-10-31; identical failure at the pre-M5 baseline
    // 86ef368). Neutralize the weekly-off so MATERIALIZATION is what's tested.
    const st = await getSettings(v.id)
    const hermetic = { ...st, general: { ...st.general, weeklyHoliday: [] as string[] } }
    const n = await materializeAbsentDay(v.id, yesterday, hermetic)
    expect(n).toBe(1)
    const rows = await db.attendance.findMany({ where: { vendorId: v.id, date: yesterday } })
    expect(rows.length).toBe(2)
    const absentRow = rows.find((r) => r.employeeId === e1.id)
    expect(absentRow?.status).toBe("ABSENT")
    // second run: e1 now has a row → 0 materialized (idempotent)
    const again = await materializeAbsentDay(v.id, yesterday, hermetic)
    expect(again).toBe(0)
    const rows2 = await db.attendance.findMany({ where: { vendorId: v.id, date: yesterday } })
    expect(rows2.length).toBe(2)
  })

  test("joining-date guard: employees who joined after the day are skipped", async () => {
    const v = await db.vendor.create({ data: { name: "scl14b", code: uniq("scl14b") } })
    const yesterday = iso(1)
    await db.employee.create({ data: { vendorId: v.id, code: uniq("J"), fullName: "New Joiner", joiningDate: iso(0) } })
    // De-flake (M5, 2026-10-31): same weekly-off neutralization as above —
    // on a weekly-off "yesterday" this test passed only by accident (0 rows
    // because of the calendar, not the joining guard). Deterministic now.
    const st = await getSettings(v.id)
    const hermetic = { ...st, general: { ...st.general, weeklyHoliday: [] as string[] } }
    const n = await materializeAbsentDay(v.id, yesterday, hermetic)
    expect(n).toBe(0)
  })
})

/// <reference types="bun-types" />
// ============ Phase 3 — monthly workforce snapshots (FIN-077 structural fix) ============
// The series replaces reconstructed history for workforce trend KPIs. The
// tests pin the reconstruction semantics with a deterministic timeline:
//
//   · A joined 2026-01-15, still ACTIVE
//   · B joined 2026-03-10, exited 2026-06-20 (Resignation LWD)
//   · C joined 2026-09-01, still ACTIVE
//
// Backfill of the 12 closed months before "today" = 2026-11-01 must produce:
//   Jan 2026: total 1 (A) · 1 joiner        Mar 2026: total 2 · 1 joiner
//   Jun 2026: total 1 · 1 exit               Sep 2026: total 2 · 1 joiner
//   Oct 2026: total 2 (A + C), active 2
// and re-running the backfill must be idempotent. The live-month capture
// (asOf = today) must count the CURRENT rows.
import "./_testdb"
import { describe, test, expect } from "bun:test"
import { db } from "@/lib/db"
import { mkVendor, mkUser, mkEmployee, mkSession, uniq } from "./_fixtures"
import { postHrm } from "./_hrm-endpoint"
import { backfillWorkforceSnapshots, captureWorkforceSnapshotMonth, workforceSnapshotSeries } from "@/hrm-server/workforce-snapshots"

const TODAY = "2026-11-01"

async function timeline() {
  const v = await mkVendor(uniq("fin077"))
  const u = await mkUser(v.id, { role: "VENDOR_OWNER", name: "FIN-077 Owner" })
  const token = await mkSession(u.id, "FULL")
  const a = await mkEmployee(v.id, { fullName: "A · Jan joiner, active" })
  await db.employee.update({ where: { id: a.id }, data: { joiningDate: "2026-01-15" } })
  const b = await mkEmployee(v.id, { fullName: "B · Mar joiner, exited Jun" })
  await db.employee.update({ where: { id: b.id }, data: { joiningDate: "2026-03-10" } })
  const c = await mkEmployee(v.id, { fullName: "C · Sep joiner, active" })
  await db.employee.update({ where: { id: c.id }, data: { joiningDate: "2026-09-01" } })
  // B's exit: a COMPLETED resignation with LWD 2026-06-20 (employee status was
  // flipped to RESIGNED by the closure sweep)
  await db.resignation.create({
    data: {
      vendorId: v.id, employeeId: b.id, submissionDate: "2026-05-01", resignationDate: "2026-05-01",
      proposedLwd: "2026-06-20", actualLwd: "2026-06-20", reason: "FIN-077 fixture", status: "COMPLETED", closureStatus: "DONE",
    },
  })
  await db.employee.update({ where: { id: b.id }, data: { status: "RESIGNED" } })
  return { v, token }
}

const snapOf = async (vendorId: string, year: number, month: number) =>
  db.workforceSnapshot.findUnique({ where: { vendorId_periodYear_periodMonth: { vendorId, periodYear: year, periodMonth: month } } })

describe("FIN-077 — the twelve-month backfill reconstructs honest history", () => {
  test("headcount/joiners/exits per month match the timeline", async () => {
    const { v } = await timeline()
    const out = await backfillWorkforceSnapshots(v.id, 12, TODAY)
    expect(out.wrote).toBe(12)
    expect(out.from).toBe("2025-11")
    expect(out.to).toBe("2026-10")

    const jan = await snapOf(v.id, 2026, 1)
    expect(jan?.headcountTotal).toBe(1)   // A only (B and C join later)
    expect(jan?.newJoiners).toBe(1)
    expect(jan?.exits).toBe(0)

    const mar = await snapOf(v.id, 2026, 3)
    expect(mar?.headcountTotal).toBe(2)   // A + B
    expect(mar?.newJoiners).toBe(1)

    const jun = await snapOf(v.id, 2026, 6)
    expect(jun?.headcountTotal).toBe(1)   // B's exit (06-20) ≤ month end → gone
    expect(jun?.exits).toBe(1)

    const sep = await snapOf(v.id, 2026, 9)
    expect(sep?.headcountTotal).toBe(2)   // A + C
    expect(sep?.newJoiners).toBe(1)

    const oct = await snapOf(v.id, 2026, 10)
    expect(oct?.headcountTotal).toBe(2)
    expect(oct?.headcountActive).toBe(2)  // A + C are ACTIVE; B is gone
    expect(oct?.avgTenureMonths).toBeGreaterThan(0)
  })

  test("re-running the backfill is idempotent (closed months rewrite identically)", async () => {
    const { v } = await timeline()
    await backfillWorkforceSnapshots(v.id, 12, TODAY)
    const before = await db.workforceSnapshot.findMany({ where: { vendorId: v.id }, orderBy: [{ periodYear: "asc" }, { periodMonth: "asc" }] })
    await backfillWorkforceSnapshots(v.id, 12, TODAY)
    const after = await db.workforceSnapshot.findMany({ where: { vendorId: v.id }, orderBy: [{ periodYear: "asc" }, { periodMonth: "asc" }] })
    expect(after.length).toBe(before.length)
    expect(after.map((r) => [r.periodYear, r.periodMonth, r.headcountTotal, r.headcountActive, r.newJoiners, r.exits, r.avgTenureMonths]))
      .toEqual(before.map((r) => [r.periodYear, r.periodMonth, r.headcountTotal, r.headcountActive, r.newJoiners, r.exits, r.avgTenureMonths]))
  })

  test("the live-month capture counts the CURRENT rows (as-of today)", async () => {
    const { v } = await timeline()
    const wrote = await captureWorkforceSnapshotMonth({ year: 2026, month: 11, asOf: TODAY, today: TODAY, vendorId: v.id })
    expect(wrote).toBe(1)
    const nov = await snapOf(v.id, 2026, 11)
    // A + C are current (B exited and is RESIGNED) → 2 total, 2 active
    expect(nov?.headcountTotal).toBe(2)
    expect(nov?.headcountActive).toBe(2)
  })

  test("a cancelled exit does not count (FIN-010 discipline feeds the series)", async () => {
    const v = await mkVendor(uniq("fin077c"))
    const a = await mkEmployee(v.id, { fullName: "Cancelled-exit staff" })
    await db.employee.update({ where: { id: a.id }, data: { joiningDate: "2026-01-15" } })
    await db.resignation.create({
      data: {
        vendorId: v.id, employeeId: a.id, submissionDate: "2026-06-01", resignationDate: "2026-06-01",
        proposedLwd: "2026-06-20", actualLwd: "2026-06-20", reason: "cancelled in error", status: "CANCELLED", closureStatus: "CANCELLED",
      },
    })
    await backfillWorkforceSnapshots(v.id, 6, TODAY)
    const jun = await snapOf(v.id, 2026, 6)
    expect(jun?.exits).toBe(0)
    expect(jun?.headcountTotal).toBe(1)   // the cancellation means still employed
  })
})

describe("FIN-077 — the routes (series read + backfill)", () => {
  test("analytics.snapshots.backfill + analytics.snapshots.series round-trip through the dispatcher", async () => {
    const v = await mkVendor(uniq("fin077r"))
    const u = await mkUser(v.id, { role: "VENDOR_OWNER", name: "FIN-077 Route Owner" })
    const token = await mkSession(u.id, "FULL")
    const a = await mkEmployee(v.id, { fullName: "Route staff" })
    await db.employee.update({ where: { id: a.id }, data: { joiningDate: "2026-02-10" } })

    const back = await postHrm("analytics.snapshots.backfill", { months: 12 }, { bearer: token })
    expect(back.status).toBe(200)
    expect(back.body.data.wrote).toBe(12)
    expect(back.body.data.caveat).toContain("invisible")

    const series = await postHrm("analytics.snapshots.series", { months: 13 }, { bearer: token })
    expect(series.status).toBe(200)
    const rows: any[] = series.body.data.snapshots
    expect(rows.length).toBe(12)
    expect(rows.every((r) => typeof r.label === "string" && r.label.includes(" "))).toBe(true)
    // the February 2026 snapshot carries the joiner
    const feb = rows.find((r) => r.periodYear === 2026 && r.periodMonth === 2)
    expect(feb?.newJoiners).toBe(1)
    expect(feb?.headcountTotal).toBe(1)
    // the backfill is audited
    const auditRow = await db.auditLog.findFirst({ where: { vendorId: v.id, action: "analytics.snapshots.backfill" } })
    expect(auditRow?.summary).toContain("Reconstructed 12 monthly workforce snapshot(s)")
  })

  test("analytics.snapshots.series needs reports.view (the permission gate holds)", async () => {
    const v = await mkVendor(uniq("fin077p"))
    const stranger = await mkUser(v.id, { role: "EMPLOYEE", name: "No Reports Staff" })
    const token = await mkSession(stranger.id, "FULL")
    const r = await postHrm("analytics.snapshots.series", {}, { bearer: token })
    expect(r.status).toBe(403)
  })
})

// module-level export sanity for the series reader used by the dashboard
describe("workforceSnapshotSeries — oldest → newest ordering", () => {
  test("returns the series in chronological order with labels", async () => {
    const v = await mkVendor(uniq("fin077s"))
    await mkEmployee(v.id, { fullName: "Order staff" })
    await backfillWorkforceSnapshots(v.id, 3, TODAY)
    const series = await workforceSnapshotSeries(v.id, 4)
    expect(series.length).toBe(3)
    const keys = series.map((s) => `${s.periodYear}-${String(s.periodMonth).padStart(2, "0")}`)
    expect([...keys].sort().join(",")).toBe(keys.join(","))
  })
})

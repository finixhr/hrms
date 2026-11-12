/// <reference types="bun-types" />
// ============ L-28 regression: report date ranges are bounded ============
// Audit L-28 (Low): reports.attendanceOverview / attendanceOverviewCsv
// accepted unbounded date ranges — from=2000&to=2030 pulled the WHOLE
// attendance + attendance-event tables into memory per request, and
// dashboard.stats re-aggregated the vendor on every 30s poll.
//
// Fix under test: capReportRange denies ranges wider than 366 days; the
// dashboard keeps a 60s per-scope memo.
// Route-layer: drives reports.attendanceOverview through POST /api/hrm.
import "./_testdb"
import { describe, test, expect, beforeAll } from "bun:test"
import { mkVendor, mkUser, mkSession } from "./_fixtures"
import { postHrm } from "./_hrm-endpoint"

let token: string

beforeAll(async () => {
  const vendor = await mkVendor("L28 Reports Vendor")
  const admin = await mkUser(vendor.id, { role: "VENDOR_OWNER", name: "L28 Admin" })
  token = await mkSession(admin.id, "FULL")
})

describe("L-28 — report date ranges are capped at 366 days", () => {
  test("from=2000-01-01&to=2030-12-31 → 400 with the cap named (was: full-table scan)", async () => {
    const r = await postHrm("reports.attendanceOverview", { from: "2000-01-01", to: "2030-12-31" }, { bearer: token })
    expect(r.status).toBe(400)
    expect(String(r.body?.error || "")).toContain("366")
  })

  test("a full leap-year (366 days) is still served", async () => {
    const r = await postHrm("reports.attendanceOverview", { from: "2028-01-01", to: "2028-12-31" }, { bearer: token })
    expect(r.status).toBe(200)
  })

  test("367 days → 400", async () => {
    const r = await postHrm("reports.attendanceOverview", { from: "2028-01-01", to: "2029-01-01" }, { bearer: token })
    expect(r.status).toBe(400)
  })

  test("reversed range (from > to) → 400", async () => {
    const r = await postHrm("reports.attendanceOverview", { from: "2028-05-01", to: "2028-01-01" }, { bearer: token })
    expect(r.status).toBe(400)
  })

  test("default call (no dates) still works", async () => {
    const r = await postHrm("reports.attendanceOverview", {}, { bearer: token })
    expect(r.status).toBe(200)
  })
})

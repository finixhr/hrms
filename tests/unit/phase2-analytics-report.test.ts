/// <reference types="bun-types" />
// ============ Phase 2 reporting foundation — the AnalyticsReport contract tests ============
// Exit criteria of the roadmap's Phase 2:
//   · the contract is typed and carries its methodology (contractVersion,
//     KPI definitions, warnings, scope);
//   · headcount and attendance render END-TO-END through the new stack
//     including exports — with table/KPI PARITY to their legacy twins
//     (by construction: workforce.headcount reuses scopedEmployees;
//     attendance.overview reuses attendanceOverviewData);
//   · legacy reports render through the adapter WITHOUT regression — same
//     rows as the legacy RPC, PII gates inherited.
import "./_testdb"
import { describe, test, expect, beforeAll } from "bun:test"
import { db } from "@/lib/db"
import { mkVendor, mkUser, mkEmployee, mkSession, uniq, defaultCompanyId } from "./_fixtures"
import { postHrm } from "./_hrm-endpoint"
import { listReportDefinitions, METRIC_DEFINITIONS, reportToCsv, metricDefinition } from "@/hrm-server/analytics-report"

let v: any
let token: string
let emp1: any
let emp2: any

beforeAll(async () => {
  v = await mkVendor(uniq("fin02r"))
  const owner = await mkUser(v.id, { role: "VENDOR_OWNER", name: "FIN02R Owner" })
  token = await mkSession(owner.id)
  emp1 = await mkEmployee(v.id, { fullName: "FIN02R One" })
  emp2 = await mkEmployee(v.id, { fullName: "FIN02R Two" })
  await db.employee.update({ where: { id: emp1.id }, data: { joiningDate: "2024-01-01" } })
  await db.employee.update({ where: { id: emp2.id }, data: { joiningDate: "2025-06-01", status: "ACTIVE" } })
})

// ------------------------------------------------------------ the contract ---
describe("the AnalyticsReport contract (v1)", () => {
  test("every catalogue metric carries a label, unit and written definition", () => {
    expect(METRIC_DEFINITIONS.length).toBeGreaterThanOrEqual(8)
    for (const m of METRIC_DEFINITIONS) {
      expect(m.key).toMatch(/^[a-z_]+\.[a-z_]+$/)
      expect(m.label.length).toBeGreaterThan(2)
      expect(m.definition.length).toBeGreaterThan(20) // a formula in words, not a placeholder
      expect(["count", "percent", "currency", "days", "hours", "ratio", "text"]).toContain(m.unit)
    }
    // the Phase-1 corrected definitions are the ones the catalogue pins
    const rate = metricDefinition("attendance.rate")!
    expect(rate.definition).toContain("LEAVE")
    const turnover = metricDefinition("workforce.turnover")!
    expect(turnover.definition).toContain("average headcount")
  })

  test("kpi() refuses metric keys that are not in the catalogue (no silent duplicates)", () => {
    expect(() => (require("@/hrm-server/analytics-report") as any).kpi("not.a.metric", 1)).toThrow()
  })
})

// ------------------------------------------------------------ the catalog ----
describe("analytics.report.catalog", () => {
  test("lists the two native definitions AND the legacy adapter for every reportRoute key", async () => {
    const r = await postHrm("analytics.report.catalog", {}, { bearer: token })
    expect(r.status).toBe(200)
    const defs = r.body.data.definitions as any[]
    const ids = defs.map((d) => d.reportId)
    expect(ids).toContain("workforce.headcount")
    expect(ids).toContain("attendance.overview")
    // the adapter covered the whole legacy registry (non-empty: employees etc.)
    expect(ids.filter((i) => i.startsWith("legacy.")).length).toBeGreaterThanOrEqual(30)
    expect(ids).toContain("legacy.employees")
    expect(ids).toContain("legacy.employeesBiodata")
    // PII class is visible in the catalogue so clients can gate up front
    expect(defs.find((d) => d.reportId === "legacy.employeesBiodata")?.pii).toBe(true)
  })
})

// ------------------------------------------------- workforce.headcount parity ---
describe("workforce.headcount — end-to-end with legacy table parity", () => {
  test("renders the full contract and its table matches the legacy report cell-for-cell", async () => {
    const legacy = await postHrm("reports.headcount", { dimension: "branch" }, { bearer: token })
    expect(legacy.status).toBe(200)

    const r = await postHrm("analytics.report.render", { reportId: "workforce.headcount", dimension: "branch" }, { bearer: token })
    expect(r.status).toBe(200)
    const rep = r.body.data
    expect(rep.contractVersion).toBe(1)
    expect(rep.reportId).toBe("workforce.headcount")
    expect(rep.scope.applied).toBe(false) // the owner is unscoped — honestly reported
    // KPIs from the catalogue, definitions attached
    const kpiKeys = rep.kpis.map((k: any) => k.key)
    expect(kpiKeys).toContain("headcount.total")
    expect(rep.kpis.find((k: any) => k.key === "headcount.total").value).toBe(2)
    for (const k of rep.kpis) expect(k.definition.length).toBeGreaterThan(20)
    // charts carry their purpose
    expect(rep.charts.length).toBe(1)
    expect(rep.charts[0].purpose.length).toBeGreaterThan(20)
    // PARITY: same dimension column + same rows as the legacy report
    expect(rep.table.columns.map((c: any) => c.label)).toEqual(legacy.body.data.columns)
    expect(rep.table.rows).toEqual(legacy.body.data.rows)
    // snapshot honesty: the warning names the missing comparison
    expect(rep.warnings.some((w: string) => w.toLowerCase().includes("snapshot"))).toBe(true)
    expect(rep.methodology.source.length).toBeGreaterThan(10)
  })

  test("an invalid dimension is rejected, never silently ignored", async () => {
    const r = await postHrm("analytics.report.render", { reportId: "workforce.headcount", dimension: "hairColor" }, { bearer: token })
    expect(r.status).toBe(400)
    expect(String(r.body.error || "")).toContain("hairColor")
  })

  test("a branch manager's structured headcount is scoped (wire = UI)", async () => {
    const branch = await db.branch.create({ data: { companyId: await defaultCompanyId(v.id), vendorId: v.id, name: "FIN02R Branch", code: uniq("B") } })
    await db.employee.update({ where: { id: emp1.id }, data: { branchId: branch.id } })
    const mgr = await mkUser(v.id, { role: "BRANCH_MANAGER", name: "FIN02R Mgr", branchId: branch.id })
    const mgrToken = await mkSession(mgr.id)
    const r = await postHrm("analytics.report.render", { reportId: "workforce.headcount", dimension: "branch" }, { bearer: mgrToken })
    expect(r.status).toBe(200)
    expect(r.body.data.scope.applied).toBe(true)
    expect(r.body.data.kpis.find((k: any) => k.key === "headcount.total").value).toBe(1)
    expect(r.body.data.methodology.source).toContain("scope")
    // restore
    await db.employee.update({ where: { id: emp1.id }, data: { branchId: null } })
  })
})

// --------------------------------------------- attendance.overview parity ---
describe("attendance.overview — end-to-end with legacy KPI parity + comparison", () => {
  test("KPIs are IDENTICAL to reports.attendanceOverview and carry previous-period values", async () => {
    // deterministic attendance for both employees today
    const t = new Date().toISOString().slice(0, 10)
    await db.attendance.create({ data: { vendorId: v.id, employeeId: emp1.id, date: t, status: "PRESENT", workingMinutes: 480 } })
    await db.attendance.create({ data: { vendorId: v.id, employeeId: emp2.id, date: t, status: "LATE", workingMinutes: 460, lateMinutes: 20 } })
    // comparison window: yesterday (all absent → the deltas move)
    const y = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)
    await db.attendance.create({ data: { vendorId: v.id, employeeId: emp1.id, date: y, status: "ABSENT" } })
    await db.attendance.create({ data: { vendorId: v.id, employeeId: emp2.id, date: y, status: "ABSENT" } })

    const legacy = await postHrm("reports.attendanceOverview", { from: t, to: t }, { bearer: token })
    expect(legacy.status).toBe(200)
    const r = await postHrm("analytics.report.render", { reportId: "attendance.overview", from: t, to: t }, { bearer: token })
    expect(r.status).toBe(200)
    const rep = r.body.data

    // PARITY by construction (shared aggregation) — every legacy KPI equals
    const byKey = Object.fromEntries(rep.kpis.map((k: any) => [k.key, k.value]))
    expect(byKey["headcount.active"]).toBe(legacy.body.data.kpis.totalEmployees)
    expect(byKey["attendance.rate"]).toBe(legacy.body.data.kpis.attendanceRate)
    expect(byKey["attendance.absent_days"]).toBe(legacy.body.data.kpis.absent)
    expect(byKey["attendance.late"]).toBe(legacy.body.data.kpis.late)
    expect(byKey["attendance.present_days"]).toBe(legacy.body.data.kpis.present)

    // the comparison period is the same-length window before `from`
    expect(rep.period.comparison).toBeTruthy()
    expect(rep.period.comparison.from).toBe(y)
    expect(rep.period.comparison.to).toBe(y)
    const absentKpi = rep.kpis.find((k: any) => k.key === "attendance.absent_days")!
    expect(absentKpi.previous?.value).toBe(2) // both absent yesterday
    expect(absentKpi.previous?.deltaPct).toBe(-100) // 2 → 0
    expect(absentKpi.intent).toBe("good-low")

    // charts: trend + method mix + branch rates, each with a purpose
    expect(rep.charts.length).toBe(3)
    expect(rep.charts.every((c: any) => c.purpose.length > 20)).toBe(true)
    // table: branch stats
    expect(rep.table).toBeTruthy()
    expect(rep.table.columns.some((c: any) => c.label === "Attendance rate")).toBe(true)
    // methodology records the shared source
    expect(rep.methodology.source).toContain("attendanceOverviewData")
  })
})

// ------------------------------------------------------- the legacy adapter ---
describe("the legacy adapter — legacy reports render through the contract without regression", () => {
  test("legacy.employees returns the SAME rows as reports.employees", async () => {
    const legacy = await postHrm("reports.employees", {}, { bearer: token })
    const r = await postHrm("analytics.report.render", { reportId: "legacy.employees" }, { bearer: token })
    expect(r.status).toBe(200)
    const rep = r.body.data
    expect(rep.table!.columns.map((c: any) => c.label)).toEqual(legacy.body.data.columns)
    expect(rep.table!.rows).toEqual(legacy.body.data.rows)
    // Reports overhaul — the adapter emits the honest data-table warning and
    // the business-metadata methodology (Finix HR <category> reporting engine)
    expect(rep.warnings.some((w: string) => w.includes("Data-table report"))).toBe(true)
    expect(rep.methodology.source).toContain("reporting engine")
  })

  test("the adapter INHERITS the PII gate: reports.view alone cannot render legacy.employeesBiodata", async () => {
    const viewer = await mkUser(v.id, { role: "HR_MANAGER", name: "FIN02R Viewer", permissions: ["reports.view"] })
    const viewerToken = await mkSession(viewer.id)
    const denied = await postHrm("analytics.report.render", { reportId: "legacy.employeesBiodata" }, { bearer: viewerToken })
    expect(denied.status).toBe(403)
    expect(String(denied.body.error || "")).toContain("reports.pii.view")
    // the owner CAN (reports.pii.view via "*")
    const ok = await postHrm("analytics.report.render", { reportId: "legacy.employeesBiodata" }, { bearer: token })
    expect(ok.status).toBe(200)
    expect(ok.body.data.table!.rows.length).toBe(2)
  })

  test("an unknown reportId 404s", async () => {
    const r = await postHrm("analytics.report.render", { reportId: "nope.nothing" }, { bearer: token })
    expect(r.status).toBe(404)
  })
})

// ------------------------------------------------------- the export pipeline ---
describe("the unified export pipeline (analytics.report.renderCsv)", () => {
  test("CSV is built from the SAME contract payload — KPIs + charts + table + warnings", async () => {
    const r = await postHrm("analytics.report.renderCsv", { reportId: "workforce.headcount", dimension: "branch" }, { bearer: token })
    expect(r.status).toBe(200)
    const csv: string = r.body.data.csv
    expect(csv).toContain("KPI,Value,Unit,Previous")
    expect(csv).toContain("Headcount")
    expect(csv).toContain("# Chart: Headcount by Branch")
    expect(csv).toContain("# Warnings")
    expect(csv).toContain("Snapshot report")
    // the export is AUDITED
    const auditRow = await db.auditLog.findFirst({
      where: { vendorId: v.id, action: "analytics.report.workforce.headcount.csvExport" },
      orderBy: { createdAt: "desc" },
    })
    expect(auditRow).toBeTruthy()
  })

  test("the export twin is permission-gated (reports.export required)", async () => {
    const viewer = await mkUser(v.id, { role: "HR_MANAGER", name: "FIN02R NoExport", permissions: ["reports.view", "attendance.view"] })
    const viewerToken = await mkSession(viewer.id)
    const denied = await postHrm("analytics.report.renderCsv", { reportId: "attendance.overview" }, { bearer: viewerToken })
    expect(denied.status).toBe(403)
  })

  test("reportToCsv is pure and self-contained (client-parity reference)", () => {
    const csv = reportToCsv({
      contractVersion: 1, reportId: "x", title: "X", generatedAt: "2026-11-01T00:00:00Z",
      period: { from: "2026-10-01", to: "2026-10-31", label: "Oct", comparison: null },
      filters: {}, scope: { applied: false, description: "org" },
      kpis: [{ key: "k", label: "A,B", value: 3, unit: "count", definition: "def" }],
      charts: [{ key: "c", kind: "bar", title: "T", purpose: "p", series: [{ name: "S", points: [{ label: "L", value: 2 }] }] }],
      table: { columns: [{ key: "a", label: "A" }], rows: [["v"]] },
      warnings: ["w1"],
      methodology: { source: "s", definitions: {}, generatedBy: "g" },
    })
    expect(csv).toContain('"A,B"') // CSV-quoted label with comma
    expect(csv).toContain("w1")
    expect(listReportDefinitions().length).toBeGreaterThanOrEqual(30)
  })
})

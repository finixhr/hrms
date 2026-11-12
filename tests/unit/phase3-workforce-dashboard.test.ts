/// <reference types="bun-types" />
// ============ Phase 3 — the workforce dashboard (workforce.dashboard) ============
// The roadmap's flagship analytics view: every KPI carries its catalogue
// definition and a prior-period comparison; movement KPIs come from the
// monthly snapshot series (the FIN-077 structural fix — no reconstructed
// history); financial blocks are permission-gated on the wire (the FIN-022
// discipline: never computed for callers who cannot see them).
import "./_testdb"
import { describe, test, expect } from "bun:test"
import { db } from "@/lib/db"
import { mkVendor, mkUser, mkEmployee, mkSession, uniq, makeCtx, defaultCompanyId } from "./_fixtures"
import { postHrm } from "./_hrm-endpoint"
import { renderAnalyticsReport } from "@/hrm-server/analytics-report"
import { backfillWorkforceSnapshots } from "@/hrm-server/workforce-snapshots"

const TODAY = "2026-11-01"
const FROM = "2026-01-01"

async function dashboardWorld() {
  const v = await mkVendor(uniq("finDash"))
  const u = await mkUser(v.id, { role: "VENDOR_OWNER", name: "FIN-Dash Owner" })
  const token = await mkSession(u.id, "FULL")
  const branch = await db.branch.create({ data: { companyId: await defaultCompanyId(v.id), vendorId: v.id, name: "FIN-Dash Branch", code: uniq("B") } })
  const dept = await db.department.create({ data: { companyId: await defaultCompanyId(v.id), vendorId: v.id, name: "FIN-Dash Dept", code: uniq("D") } })
  const a = await mkEmployee(v.id, { fullName: "A · Jan joiner", branchId: branch.id, departmentId: dept.id })
  await db.employee.update({ where: { id: a.id }, data: { joiningDate: "2026-01-15", dob: "1990-05-01" } })
  const b = await mkEmployee(v.id, { fullName: "B · Mar joiner, exited Jun" })
  await db.employee.update({ where: { id: b.id }, data: { joiningDate: "2026-03-10", dob: "1985-02-01" } })
  const c = await mkEmployee(v.id, { fullName: "C · Sep joiner", departmentId: dept.id })
  await db.employee.update({ where: { id: c.id }, data: { joiningDate: "2026-09-01", dob: "1998-08-01" } })
  await db.resignation.create({
    data: {
      vendorId: v.id, employeeId: b.id, submissionDate: "2026-05-01", resignationDate: "2026-05-01",
      proposedLwd: "2026-06-20", actualLwd: "2026-06-20", reason: "dashboard fixture", status: "COMPLETED", closureStatus: "DONE",
    },
  })
  await db.employee.update({ where: { id: b.id }, data: { status: "RESIGNED" } })
  // a PAID payroll run for October 2026 (the period's last closed month)
  const run = await db.payrollRun.create({
    data: { companyId: await defaultCompanyId(v.id), vendorId: v.id, periodMonth: 10, periodYear: 2026, periodWeek: 0, frequency: "MONTHLY", runType: "REGULAR", status: "DRAFT", createdBy: u.id, totalGross: 500000, totalOt: 20000 },
  })
  await db.payrollRun.update({ where: { id: run.id }, data: { status: "PAID", paymentDate: "2026-11-01" } })
  // the snapshot series (what the movement KPIs read)
  await backfillWorkforceSnapshots(v.id, 12, TODAY)
  return { v, u, token, branch, dept }
}

describe("workforce.dashboard — the contract surface", () => {
  test("every KPI carries its formula, movement comes from the snapshots, financial blocks appear for their holders", async () => {
    const { token } = await dashboardWorld()
    const r = await postHrm("analytics.report.render", { reportId: "workforce.dashboard", from: FROM, to: TODAY }, { bearer: token })
    expect(r.status).toBe(200)
    const rep = r.body.data
    expect(rep.contractVersion).toBe(1)
    expect(rep.reportId).toBe("workforce.dashboard")
    expect(rep.period.comparison).not.toBeNull()
    const kpiByKey = Object.fromEntries(rep.kpis.map((k: any) => [k.key, k]))
    // every KPI with a formula
    for (const k of rep.kpis) expect(k.definition.length).toBeGreaterThan(20)
    // movement KPIs from the snapshot series: 3 joiners, 1 exit over the year
    expect(kpiByKey["workforce.joiners"].value).toBe(3)
    expect(kpiByKey["workforce.exits"].value).toBe(1)
    expect(kpiByKey["workforce.attrition"].value).not.toBeNull()
    expect(kpiByKey["workforce.turnover"].value).not.toBeNull()
    // attrition = 1 exit ÷ ((1 + 2) ÷ 2) = 66.7%
    expect(kpiByKey["workforce.attrition"].value).toBe(66.7)
    // prior-period comparisons ride the movement KPIs
    expect(kpiByKey["workforce.joiners"].previous).toBeDefined()
    // financial blocks: the owner holds payroll.view → computed and compared
    expect(kpiByKey["payroll.cost"].value).toBe(500000)
    expect(kpiByKey["payroll.ot_cost"].value).toBe(20000)
    // age/tenure bands + distributions as charts with purposes
    const chartKeys = rep.charts.map((c: any) => c.key)
    for (const key of ["workforce.headcount_trend", "workforce.movement", "workforce.distribution", "workforce.age_bands", "workforce.tenure_bands", "workforce.payroll_cost_trend"]) {
      expect(chartKeys).toContain(key)
    }
    for (const c of rep.charts) expect(c.purpose.length).toBeGreaterThan(20)
    // the age bands chart carries all three fixture employees (incl. Unknown honesty)
    const ageChart = rep.charts.find((c: any) => c.key === "workforce.age_bands")
    const totalAge = ageChart.series[0].points.reduce((s: number, p: any) => s + p.value, 0)
    expect(totalAge).toBe(3)
    // the table is the monthly movement series
    expect(rep.table.columns.map((c: any) => c.label)).toEqual(["Month", "Headcount", "Active", "Joiners", "Exits", "Avg tenure (mo)"])
    expect(rep.table.rows.length).toBe(12)
    // the backfill ran, so the "no snapshots" warning is GONE
    expect(rep.warnings.some((w: string) => w.includes("No monthly workforce snapshots"))).toBe(false)
    expect(rep.methodology.definitions["workforce.attrition"]).toContain("snapshot series")
  })

  test("financial blocks are never computed for callers without payroll.view (FIN-022 on the wire)", async () => {
    const { v, u } = await dashboardWorld()
    const ctx = makeCtx({ id: u.id, vendorId: v.id, role: "HR_ADMIN" }, ["reports.view"])
    const rep = await renderAnalyticsReport(ctx as any, "workforce.dashboard", { from: FROM, to: TODAY })
    const keys = rep.kpis.map((k) => k.key)
    expect(keys).not.toContain("payroll.cost")
    expect(keys).not.toContain("payroll.ot_cost")
    expect(rep.charts.map((c) => c.key)).not.toContain("workforce.payroll_cost_trend")
    expect(rep.warnings.some((w) => w.includes("payroll.view"))).toBe(true)
    // everything else still renders
    expect(keys).toContain("workforce.joiners")
    expect(keys).toContain("headcount.total")
  })

  test("a branch manager gets scoped KPIs plus the vendor-wide snapshot warning", async () => {
    const { v, branch, dept } = await dashboardWorld()
    // the branch manager's visibility: employees of THEIR branch only
    const mgr = await mkUser(v.id, { role: "BRANCH_MANAGER", name: "FIN-Dash Mgr", branchId: branch.id })
    const mgrToken = await mkSession(mgr.id)
    const r = await postHrm("analytics.report.render", { reportId: "workforce.dashboard", from: FROM, to: TODAY, dimension: "department" }, { bearer: mgrToken })
    expect(r.status).toBe(200)
    const rep = r.body.data
    expect(rep.scope.applied).toBe(true)
    // A is in the manager's branch (and the manager's department dimension shows A only)
    expect(rep.kpis.find((k: any) => k.key === "headcount.total").value).toBe(1)
    expect(rep.warnings.some((w: string) => w.includes("VENDOR-WIDE"))).toBe(true)
    void dept
  })

  test("leave utilisation and attendance KPIs render with their fiscal-year basis", async () => {
    const { v, token } = await dashboardWorld()
    // give employee A a leave balance for the current fiscal leave year
    const type = await db.leaveType.create({ data: { companyId: await defaultCompanyId(v.id), vendorId: v.id, code: uniq("ANNUAL"), name: "Annual Dash", paid: true, defaultDays: 20 } })
    const a = (await db.employee.findMany({ where: { vendorId: v.id, status: "ACTIVE" } }))[0]!
    await db.leaveBalance.create({ data: { vendorId: v.id, employeeId: a.id, leaveTypeId: type.id, year: 2026, entitled: 20, used: 5 } })
    const r = await postHrm("analytics.report.render", { reportId: "workforce.dashboard", from: FROM, to: TODAY }, { bearer: token })
    expect(r.status).toBe(200)
    const kpiByKey = Object.fromEntries(r.body.data.kpis.map((k: any) => [k.key, k]))
    expect(kpiByKey["leave.utilisation"].value).toBe("25%")
    expect(kpiByKey["leave.utilisation"].definition).toContain("leave year 2026")
    expect(kpiByKey["attendance.rate"]).toBeDefined()
  })
})

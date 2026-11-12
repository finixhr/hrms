/// <reference types="bun-types" />
// ============ FIN-022/023/024/025/026 (Phase 2) — the scope-parity test class ============
// The consolidated roadmap's Phase 2 dependency note: "the scope-parity test
// (FIN-024) should be written first and then extended to cover FIN-022 /
// FIN-025, so the boundary becomes regression-pinned as a CLASS rather than
// per-route." This file is that class: one tenant, two branches, the same
// restricted manager, five surfaces — dashboard, search, analytics, the
// approval queue and role administration — all asserting the same principle:
// WHAT THE UI SHOWS IS WHAT THE WIRE CARRIES, and what the caller cannot see
// elsewhere never arrives here either.
import "./_testdb"
import { describe, test, expect, beforeAll } from "bun:test"
import { db } from "@/lib/db"
import { mkVendor, mkUser, mkEmployee, mkSession, mkBranch, uniq, defaultCompanyId } from "./_fixtures"
import { postHrm } from "./_hrm-endpoint"

let v: any
let ownerToken: string
let branchA: any
let branchB: any
let empA: any // employee INSIDE the manager's branch
let empB: any // employee OUTSIDE the manager's branch
let mgrToken: string        // BRANCH_MANAGER scoped to branch A (template perms)
let viewerToken: string     // custom role: dashboard/analytics/approvals view, NO financial perms
let viewerWithPayrollToken: string // same + payroll.view only

beforeAll(async () => {
  v = await mkVendor(uniq("fin02"))
  const owner = await mkUser(v.id, { role: "VENDOR_OWNER", name: "FIN-02 Owner" })
  ownerToken = await mkSession(owner.id)

  branchA = await mkBranch(v.id, "Branch A")
  branchB = await mkBranch(v.id, "Branch B")
  empA = await mkEmployee(v.id, { branchId: branchA.id, fullName: "FIN02 In Scope" })
  empB = await mkEmployee(v.id, { branchId: branchB.id, fullName: "FIN02 Out Of Scope" })
  await db.employee.update({ where: { id: empA.id }, data: { mobile: "01711111111", officialEmail: "inscope@fin02.test", joiningDate: "2024-01-01" } })
  await db.employee.update({ where: { id: empB.id }, data: { mobile: "01799999999", officialEmail: "oos@fin02.test", joiningDate: "2024-01-01" } })

  // the branch manager — the template already grants dashboard/analytics/
  // approvals/employees view; the SCOPE comes from user.branchId
  const mgr = await mkUser(v.id, { role: "BRANCH_MANAGER", name: "FIN02 Manager", branchId: branchA.id })
  mgrToken = await mkSession(mgr.id)

  // a paid payroll run with entries for BOTH branches (financial figures exist
  // to be leaked — FIN-022) and money split per branch (FIN-024)
  const run = await db.payrollRun.create({
    data: { companyId: await defaultCompanyId(v.id), vendorId: v.id, periodMonth: 10, periodYear: 2026, status: "PAID", totalGross: 30_000, totalNet: 27_000, totalAit: 1_000, employeeCount: 2, paymentDate: "2026-10-30" },
  })
  await db.payrollEntry.create({ data: { vendorId: v.id, runId: run.id, employeeId: empA.id, gross: 10_000, net: 9_000, ait: 500 } })
  await db.payrollEntry.create({ data: { vendorId: v.id, runId: run.id, employeeId: empB.id, gross: 20_000, net: 18_000, ait: 500 } })
  // loan + expense figures for the dashboard blocks
  await db.loan.create({ data: { vendorId: v.id, employeeId: empB.id, principal: 5_000, outstanding: 4_000, startDate: "2026-10-01", status: "ACTIVE" } })
  await db.expenseClaim.create({ data: { vendorId: v.id, employeeId: empB.id, category: "TRAVEL", title: "FIN02 claim", amount: 1_200, date: "2026-10-15", status: "PENDING" } })

  // custom role WITHOUT any financial permission (dashboard.view only family)
  await db.role.create({
    data: { vendorId: v.id, key: "FIN02VIEWER", name: "FIN02 Viewer", permissions: JSON.stringify(["dashboard.view", "analytics.view", "approvals.view", "employees.view", "reports.view"]) },
  })
  const viewer = await mkUser(v.id, { role: "FIN02VIEWER", name: "FIN02 Viewer" })
  viewerToken = await mkSession(viewer.id)
  const viewerPayroll = await mkUser(v.id, { role: "FIN02VIEWER", name: "FIN02 Viewer Payroll", permissions: ["payroll.view"] })
  viewerWithPayrollToken = await mkSession(viewerPayroll.id)

  // pending approval requests targeting both employees (payload carries the
  // employeeId the FIN-025 resolution reads)
  for (const [emp, tag] of [[empA, "A"], [empB, "B"]] as const) {
    await db.approvalRequest.create({
      data: {
        vendorId: v.id, workflowId: "", processType: "LEAVE", entityType: "LeaveRequest",
        entityId: `fin02-leave-${tag}`, entityRef: `FIN02 Leave ${tag}`, requestedBy: owner.id,
        status: "PENDING", payloadJson: JSON.stringify({ employeeId: emp.id, amount: 100 }),
      },
    })
  }
})

// ---------------------------------------------------------------- FIN-022 ---
describe("FIN-022 — dashboard financial blocks are permission-gated ON THE WIRE", () => {
  test("a dashboard.view caller WITHOUT financial perms receives null payroll/loan/expense blocks", async () => {
    const r = await postHrm("dashboard.stats", {}, { bearer: viewerToken })
    expect(r.status).toBe(200)
    expect(r.body.data.payroll).toBeNull()
    expect(r.body.data.loan).toBeNull()
    expect(r.body.data.expensesMonth).toBeNull()
    expect(r.body.data.payrollTrend).toBeNull()
    expect(r.body.data.loanInstallmentsDue).toBeNull()
    // the non-financial blocks stay fully populated (workforce/attendance)
    expect(r.body.data.workforce.total).toBeGreaterThanOrEqual(2)
    expect(r.body.data.attendanceToday).toBeTruthy()
  })

  test("the memo does not leak a privileged caller's payload to a restricted one (keyed by permission set)", async () => {
    // PRIME the 60s memo with the OWNER's (financial) payload first
    const owner = await postHrm("dashboard.stats", {}, { bearer: ownerToken })
    expect(owner.status).toBe(200)
    expect(owner.body.data.payroll).not.toBeNull()
    expect(owner.body.data.payroll.gross).toBe(30_000)
    // then the restricted caller — same vendor+scope, different permission set
    const r = await postHrm("dashboard.stats", {}, { bearer: viewerToken })
    expect(r.body.data.payroll).toBeNull()
    expect(r.body.data.loan).toBeNull()
  })

  test("the gating is per-verb: payroll.view alone restores the payroll block but not loans/expenses", async () => {
    const r = await postHrm("dashboard.stats", {}, { bearer: viewerWithPayrollToken })
    expect(r.status).toBe(200)
    expect(r.body.data.payroll).not.toBeNull()
    expect(r.body.data.payroll.gross).toBe(30_000)
    expect(r.body.data.payrollTrend).not.toBeNull()
    expect(r.body.data.loan).toBeNull()
    expect(r.body.data.expensesMonth).toBeNull()
    expect(r.body.data.loanInstallmentsDue).toBeNull()
  })

  test("the branch manager (financial perms held) still gets the blocks, scoped to branch A employees", async () => {
    const r = await postHrm("dashboard.stats", {}, { bearer: mgrToken })
    expect(r.status).toBe(200)
    expect(r.body.data.payroll).not.toBeNull()
    // R1-009 — the loan aggregates ride scopedEmployeeIds: only empA is in
    // scope, and the loan belongs to empB → outstanding 0
    expect(r.body.data.loan?.outstanding ?? 0).toBe(0)
  })
})

// ---------------------------------------------------------------- FIN-024 ---
describe("FIN-024 — analytics.all runs through employeeScopeFilter", () => {
  test("the branch manager's workforce numbers count ONLY branch A employees", async () => {
    const r = await postHrm("analytics.all", {}, { bearer: mgrToken })
    expect(r.status).toBe(200)
    const wf = r.body.data.workforce
    // empB is invisible: Branch B's headcount entry is 0 (the array keeps
    // every branch — a zero is the scoping proof; only A is counted)
    expect(wf.byBranch.find((b: any) => b.name === "Branch B")?.value).toBe(0)
    expect(wf.byBranch.find((b: any) => b.name === "Branch A")?.value).toBe(1)
    // payroll by branch: ONLY empA's net (9_000) — zero-value entries are
    // filtered out of the payroll distribution, so Branch B is absent
    const payB = r.body.data.payroll.byBranch.find((b: any) => b.name === "Branch B")
    expect(payB).toBeUndefined()
    expect(r.body.data.payroll.byBranch.find((b: any) => b.name === "Branch A")?.value).toBe(9_000)
    // per-employee + trend recomputed from the scoped entries (not run totals)
    expect(r.body.data.payroll.perEmployee).toBe(9_000)
  })

  test("an UNSCOPED caller still gets the vendor-wide numbers (golden parity path)", async () => {
    const r = await postHrm("analytics.all", {}, { bearer: ownerToken })
    expect(r.status).toBe(200)
    expect(r.body.data.payroll.byBranch.find((b: any) => b.name === "Branch B")?.value).toBe(18_000)
    expect(r.body.data.payroll.byBranch.find((b: any) => b.name === "Branch A")?.value).toBe(9_000)
    // unscoped per-employee keeps the run-total arithmetic
    expect(r.body.data.payroll.perEmployee).toBe(13_500)
    expect(r.body.data.workforce.byBranch.find((b: any) => b.name === "Branch B")?.value).toBe(1)
  })

  test("out-of-scope employees never appear as named performers/KPI rows for the manager", async () => {
    // give BOTH employees a rated review + a submitted KPI assignment
    const cycle = await db.reviewCycle.create({ data: { companyId: await defaultCompanyId(v.id), vendorId: v.id, name: "FIN02 Cycle", year: 2026, startDate: "2026-10-01", endDate: "2026-12-31", status: "ACTIVE" } })
    await db.performanceReview.create({ data: { vendorId: v.id, employeeId: empB.id, cycleId: cycle.id, overallRating: 5, status: "COMPLETED" } })
    await db.performanceReview.create({ data: { vendorId: v.id, employeeId: empA.id, cycleId: cycle.id, overallRating: 4, status: "COMPLETED" } })
    await db.kpiAssignment.create({ data: { vendorId: v.id, employeeId: empB.id, periodLabel: "2026-Q4", status: "SUBMITTED", resultsJson: JSON.stringify([{ achievementPct: 99 }]) } })

    const r = await postHrm("analytics.all", {}, { bearer: mgrToken })
    expect(r.status).toBe(200)
    const names = r.body.data.performance.topPerformers.map((p: any) => p.name)
    expect(names).toContain("FIN02 In Scope")
    expect(names).not.toContain("FIN02 Out Of Scope")
    expect(r.body.data.performance.kpiAchievement.map((k: any) => k.name)).not.toContain("FIN02 Out Of Scope")
    // the OWNER sees both
    const owner = await postHrm("analytics.all", {}, { bearer: ownerToken })
    expect(owner.body.data.performance.topPerformers.length).toBe(2)
  })
})

// ---------------------------------------------------------------- FIN-025 ---
describe("FIN-025 — the approval queue and details honor the manager's scope", () => {
  test("the queue lists only requests targeting in-scope employees", async () => {
    const r = await postHrm("approvals.queue", {}, { bearer: mgrToken })
    expect(r.status).toBe(200)
    const rows = r.body.data as any[]
    const leaveRows = rows.filter((x) => x.processType === "LEAVE")
    expect(leaveRows.length).toBe(1)
    expect(leaveRows[0].employeeId).toBe(empA.id)
    // the resolved target employee now rides every row
    expect(leaveRows[0].employeeId).toBeTruthy()
    // the owner still sees both
    const owner = await postHrm("approvals.queue", {}, { bearer: ownerToken })
    expect((owner.body.data as any[]).filter((x) => x.processType === "LEAVE").length).toBe(2)
  })

  test("approvals.details 404s for an out-of-scope target employee (PII + entity rows withheld)", async () => {
    const both = await db.approvalRequest.findMany({ where: { vendorId: v.id, processType: "LEAVE" } })
    const reqB = both.find((x) => (JSON.parse(x.payloadJson || "{}") as any).employeeId === empB.id)!
    const reqA = both.find((x) => (JSON.parse(x.payloadJson || "{}") as any).employeeId === empA.id)!
    // the manager cannot open the out-of-scope request's drawer
    const denied = await postHrm("approvals.details", { id: reqB.id }, { bearer: mgrToken })
    expect(denied.status).toBe(404)
    expect(String(denied.body.error || "")).toContain("scope")
    // ...but opens the in-scope one and gets the employee block
    const ok = await postHrm("approvals.details", { id: reqA.id }, { bearer: mgrToken })
    expect(ok.status).toBe(200)
    expect(ok.body.data.employee?.id).toBe(empA.id)
    // while employees.get for the same out-of-scope employee 404s too — the
    // surfaces now AGREE (the audit's inconsistency)
    const empDenied = await postHrm("employees.get", { id: empB.id }, { bearer: mgrToken })
    expect(empDenied.status).toBe(404)
  })
})

// ---------------------------------------------------------------- FIN-023 ---
describe("FIN-023 — global search applies the callerFieldAccess contact projection", () => {
  test("a masked role gets masked phones/emails and cannot match BY phone", async () => {
    // configure contact: mask for the custom role
    const save = await postHrm("settings.save", {
      group: "fieldPermissions",
      values: { roles: { FIN02VIEWER: { contact: "mask" } }, default: {} },
    }, { bearer: ownerToken })
    expect(save.status).toBe(200)

    const byName = await postHrm("search.global", { q: "In Scope" }, { bearer: viewerToken })
    expect(byName.status).toBe(200)
    expect(byName.body.data.employees.length).toBe(1)
    const row = byName.body.data.employees[0]
    // masked values — the same shape employees.list shows
    expect(String(row.mobile)).toMatch(/^01[•]+11$/)
    expect(String(row.email)).toMatch(/^i[•]+@fin02\.test$/)

    // match-by-raw-phone is GONE for the masked role (no digit-by-digit probing)
    const byPhone = await postHrm("search.global", { q: "01711111111" }, { bearer: viewerToken })
    expect(byPhone.status).toBe(200)
    expect(byPhone.body.data.employees.length).toBe(0)

    // an unmasked caller still matches by phone and sees raw values
    const owner = await postHrm("search.global", { q: "01711111111" }, { bearer: ownerToken })
    expect(owner.body.data.employees.length).toBe(1)
    expect(owner.body.data.employees[0].mobile).toBe("01711111111")
  })

  test("contact none drops the fields from the result entirely", async () => {
    await postHrm("settings.save", {
      group: "fieldPermissions",
      values: { roles: { FIN02VIEWER: { contact: "none" } }, default: {} },
    }, { bearer: ownerToken })
    const r = await postHrm("search.global", { q: "Out Of Scope" }, { bearer: viewerToken })
    // viewer has no branch scope — the employee is visible by name
    expect(r.body.data.employees.length).toBe(1)
    expect(r.body.data.employees[0].mobile).toBeNull()
    expect(r.body.data.employees[0].email).toBeNull()
    // restore mask for later suites in this file
    await postHrm("settings.save", {
      group: "fieldPermissions",
      values: { roles: { FIN02VIEWER: { contact: "mask" } }, default: {} },
    }, { bearer: ownerToken })
  })
})

// ---------------------------------------------------------------- FIN-026 ---
describe("FIN-026 — the last-admin guard on roles.save", () => {
  // a dedicated vendor: exactly ONE user whose ONLY admin capability comes
  // from the VENDOR_OWNER role template (no per-user explicit grants — the
  // rescue path). This is the audit's exact lockout scenario.
  let v2: any
  let hollowOwnerToken: string
  beforeAll(async () => {
    v2 = await mkVendor(uniq("fin02a"))
    const hollow = await mkUser(v2.id, { role: "VENDOR_OWNER", name: "Hollow Owner", permissions: [] })
    hollowOwnerToken = await mkSession(hollow.id)
  })

  test("stripping the admin verbs from the last admin-capable role is refused (with audit trail)", async () => {
    const blocked = await postHrm("roles.save", {
      key: "VENDOR_OWNER", name: "Vendor Owner", permissions: ["employees.view"],
    }, { bearer: hollowOwnerToken })
    expect(blocked.status).toBe(400)
    expect(String(blocked.body.error || "")).toContain("admin")

    // the refusal left a forensic audit row
    const auditRow = await db.auditLog.findFirst({
      where: { vendorId: v2.id, action: "roles.override.blocked" },
      orderBy: { createdAt: "desc" },
    })
    expect(auditRow).toBeTruthy()
    expect(String(auditRow!.summary)).toContain("VENDOR_OWNER")

    // no override row was written
    expect(await db.role.findFirst({ where: { vendorId: v2.id, key: "VENDOR_OWNER" } })).toBeNull()
  })

  test("the same save succeeds once ANOTHER admin-capable user exists (rescue path)", async () => {
    // user-level explicit users.edit grants admin capability independently
    // of the role — the guard's rescue path
    const rescuer = await mkUser(v2.id, { role: "VENDOR_OWNER", name: "Rescuer", permissions: ["users.edit"] })
    const rescuerToken = await mkSession(rescuer.id)

    const ok = await postHrm("roles.save", {
      key: "VENDOR_OWNER", name: "Vendor Owner", permissions: ["employees.view"],
    }, { bearer: rescuerToken })
    expect(ok.status).toBe(200)

    // cleanup: deleting the override restores the built-in template
    const override = await db.role.findFirst({ where: { vendorId: v2.id, key: "VENDOR_OWNER" } })
    expect(override).toBeTruthy()
    const del = await postHrm("roles.delete", { id: override!.id }, { bearer: rescuerToken })
    expect(del.status).toBe(200)
    expect(del.body.data.reset).toBe(true)
  })

  test("deleting an admin-capable custom role that still has holders is refused (the inUse lockout guard)", async () => {
    // fresh vendor whose ONLY admin source is a custom role held by one user
    const v3 = await mkVendor(uniq("fin02b"))
    await db.role.create({
      data: { vendorId: v3.id, key: "SOLE_ADMIN", name: "Sole Admin", permissions: JSON.stringify(["users.edit", "employees.view"]) },
    })
    const sole = await mkUser(v3.id, { role: "SOLE_ADMIN", name: "Sole" })
    const soleToken = await mkSession(sole.id)

    const blocked = await postHrm("roles.delete", { id: (await db.role.findFirst({ where: { vendorId: v3.id, key: "SOLE_ADMIN" } }))!.id }, { bearer: soleToken })
    expect(blocked.status).toBe(403)
    expect(String(blocked.body.error || "")).toContain("still assigned")
  })
})

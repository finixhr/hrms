/// <reference types="bun-types" />
// ============ R-03 (independent verification) — branch/department scope =======
// Regression suite for enforcement of UserCompanyAccess.branchScope /
// departmentScope across the employee directory and employee-scoped endpoints.
//
// Contract under test (schema.prisma UserCompanyAccess):
//   branchScope/departmentScope — "JSON array of branch ids; null = all
//   branches of the company". The effective scope is an INTERSECTION of every
//   applicable restriction (active company ∩ role branch/dept ∩ access-row
//   branch/department scope), never a union; an EMPTY array is a restriction
//   to nothing (fail-closed), NOT unrestricted access.
//
// Every case drives the REAL dispatcher (postHrm — the production traffic
// path) except the resolver-matrix block, which pins the filter semantics
// directly. Test IDs (A1…E20) reference the independent-verification mandate.
import "./_testdb"
import { describe, test, expect, beforeAll } from "bun:test"
import { db } from "@/lib/db"
import { mkVendor, mkUser, mkEmployee, mkSession, uniq, makeCtx } from "./_fixtures"
import { postHrm } from "./_hrm-endpoint"
import { ensureDefaultCompany } from "@/hrm-server/company"
import { employeeScopeFilter } from "@/hrm-server/rbac"
import { companyEmployeeScopeFilter } from "@/hrm-server/company"

// ---------------------------------------------------------------------------
// fixture: one vendor, two companies (C1 default + C2), branches/departments
// ---------------------------------------------------------------------------
let vendor: any, c1: any, c2: any
let br1: any, br2: any, br3: any // br1/br2 in C1, br3 in C2
let dp1: any, dp2: any // both in C1
// employee matrix in C1 (branch × department) + one C2 employee + one B1 victim
let e11: any, e21: any, e12: any, e22: any, eC2: any, e11b: any
// scoped HR_MANAGER users (non-admin role: assertCompany's admin bypass must NOT apply)
let tB1: string, tD1: string, tB1D1: string, tEmpty: string, tFull: string
// branch managers (role-scope ∩ access-scope intersection cases)
let tBmBogus: string, tBmOk: string, tBmDept: string
let shift: any

const PERMS = [
  "employees.view", "employees.edit", "employees.delete", "employees.create",
  "attendance.view", "attendance.edit", "attendance.verify",
  "performance.view", "kpi.view", "shifts.view", "shifts.assign",
  "payroll.view", "payroll.edit", "recruitment.view", "procurement.view",
  "organization.view", "ait.view", "bonus.view",
]

async function mkScopedUser(branchScope: string[] | null, departmentScope: string[] | null, role = "HR_MANAGER") {
  const u = await mkUser(vendor.id, { role: role as any, name: uniq("R03"), permissions: PERMS })
  await db.userCompanyAccess.create({
    data: {
      vendorId: vendor.id, userId: u.id, companyId: c1.id, role,
      active: true, isDefault: true,
      ...(branchScope !== null ? { branchScope: JSON.stringify(branchScope) } : {}),
      ...(departmentScope !== null ? { departmentScope: JSON.stringify(departmentScope) } : {}),
    },
  })
  return mkSession(u.id)
}

const ids = (r: { status: number; body: any }) => ((r.body?.data || []) as any[]).map((e) => e.id)

beforeAll(async () => {
  vendor = await mkVendor(uniq("R03 Vendor"), { company: false })
  const defC1 = await ensureDefaultCompany(vendor.id, { name: "R03 Company One" })
  c1 = await db.company.findUniqueOrThrow({ where: { id: defC1 } })
  c2 = await db.company.create({ data: { vendorId: vendor.id, code: uniq("C2"), name: "R03 Company Two", active: true } })

  br1 = await db.branch.create({ data: { vendorId: vendor.id, companyId: c1.id, code: uniq("R1"), name: "R03 Branch One" } })
  br2 = await db.branch.create({ data: { vendorId: vendor.id, companyId: c1.id, code: uniq("R2"), name: "R03 Branch Two" } })
  br3 = await db.branch.create({ data: { vendorId: vendor.id, companyId: c2.id, code: uniq("R3"), name: "R03 Branch C2" } })
  dp1 = await db.department.create({ data: { vendorId: vendor.id, companyId: c1.id, code: uniq("D1"), name: "R03 Dept One" } })
  dp2 = await db.department.create({ data: { vendorId: vendor.id, companyId: c1.id, code: uniq("D2"), name: "R03 Dept Two" } })

  const mk = async (name: string, branchId: string | null, departmentId: string | null, companyId: string) => {
    const e = await mkEmployee(vendor.id, { fullName: name, branchId, departmentId })
    await db.employee.update({ where: { id: e.id }, data: { companyId } })
    return db.employee.findUniqueOrThrow({ where: { id: e.id } })
  }
  e11 = await mk("R03 Emp B1 D1", br1.id, dp1.id, c1.id)
  e21 = await mk("R03 Emp B2 D1", br2.id, dp1.id, c1.id)
  e12 = await mk("R03 Emp B1 D2", br1.id, dp2.id, c1.id)
  e22 = await mk("R03 Emp B2 D2", br2.id, dp2.id, c1.id)
  eC2 = await mk("R03 Emp C2", br3.id, null, c2.id)
  e11b = await mk("R03 Emp B1 victim", br1.id, dp1.id, c1.id)

  // attendance rows for the register / otPending surfaces
  const att = async (emp: any, overtime = 0) => db.attendance.create({
    data: { vendorId: vendor.id, employeeId: emp.id, date: "2026-10-05", checkIn: "09:00", checkOut: "18:00", overtimeMinutes: overtime, otApproved: false, source: "MANUAL" },
  })
  await att(e11, 60)
  await att(e21, 90)
  await att(eC2, 30)
  // a PENDING correction for a D2 employee (department-scope leak probe) and one for a C2 employee
  await db.attendanceCorrection.create({ data: { vendorId: vendor.id, employeeId: e12.id, date: "2026-10-05", reason: "R03 probe D2", status: "PENDING" } })
  await db.attendanceCorrection.create({ data: { vendorId: vendor.id, employeeId: eC2.id, date: "2026-10-05", reason: "R03 probe C2", status: "PENDING" } })
  // a PENDING correction for the B1 victim (E18 reject path + allowed-act probe)
  await db.attendanceCorrection.create({ data: { vendorId: vendor.id, employeeId: e11b.id, date: "2026-10-05", reason: "R03 victim", status: "PENDING" } })

  shift = await db.shift.create({ data: { vendorId: vendor.id, companyId: c1.id, name: "R03 Shift", startTime: "09:00", endTime: "17:00" } })

  tB1 = await mkScopedUser([br1.id], null)
  tD1 = await mkScopedUser(null, [dp1.id])
  tB1D1 = await mkScopedUser([br1.id], [dp1.id])
  tEmpty = await mkScopedUser([], null)
  tFull = await mkScopedUser(null, null)

  // branch managers: the USER row carries their own branch (role scope)
  const bm = async (userBranch: any, scope: string[] | null, deptScope: string[] | null = null) => {
    const u = await mkUser(vendor.id, { role: "BRANCH_MANAGER", name: uniq("R03BM"), branchId: userBranch.id, permissions: PERMS })
    await db.userCompanyAccess.create({
      data: {
        vendorId: vendor.id, userId: u.id, companyId: c1.id, role: "BRANCH_MANAGER",
        active: true, isDefault: true,
        ...(scope !== null ? { branchScope: JSON.stringify(scope) } : {}),
        ...(deptScope !== null ? { departmentScope: JSON.stringify(deptScope) } : {}),
      },
    })
    return mkSession(u.id)
  }
  tBmBogus = await bm(br1, [br2.id]) // own branch B1 ∉ scope [B2] → matches NOTHING
  tBmOk = await bm(br1, [br1.id, br2.id]) // own branch ∈ scope → keeps exactly B1
  tBmDept = await bm(br1, null, [dp2.id]) // role branch B1 ∩ dept D2 → e12 only
})

// ---------------------------------------------------------------------------
// A — branch scope
// ---------------------------------------------------------------------------
describe("R-03 A — branch scope (UserCompanyAccess.branchScope = [B1])", () => {
  test("A1 · scoped user lists Branch A employees only", async () => {
    const r = await postHrm("employees.list", {}, { bearer: tB1 })
    expect(r.status).toBe(200)
    const got = ids(r)
    expect(got).toContain(e11.id)
    expect(got).toContain(e12.id)
  })

  test("A2 · Branch B employees never appear in the directory for the B1-scoped user", async () => {
    const r = await postHrm("employees.list", {}, { bearer: tB1 })
    const got = ids(r)
    expect(got).not.toContain(e21.id)
    expect(got).not.toContain(e22.id)
  })

  test("A3 · direct employees.get of a Branch B employee is denied (404)", async () => {
    const r = await postHrm("employees.get", { id: e21.id }, { bearer: tB1 })
    expect(r.status).toBe(404)
  })

  test("A4 · updating a Branch B employee is denied (404 before any write)", async () => {
    const r = await postHrm("employees.suspend", { id: e21.id, reason: "R03 probe" }, { bearer: tB1 })
    expect(r.status).toBe(404)
    const still = await db.employee.findUniqueOrThrow({ where: { id: e21.id } })
    expect(still.status).toBe("ACTIVE")
  })

  test("A5 · deleting (archiving) a Branch B employee is denied", async () => {
    const r = await postHrm("employees.delete", { id: e21.id }, { bearer: tB1 })
    expect(r.status).toBe(404)
    const still = await db.employee.findUniqueOrThrow({ where: { id: e21.id } })
    expect(still.status).toBe("ACTIVE")
  })

  test("A6 · search, pagination, counts and pickers do not leak Branch B employees", async () => {
    // directory search (q) matches the B2 employee's name tenant-wide, but the
    // scoped user's effective scope must exclude her
    const s = await postHrm("search.global", { q: e21.fullName }, { bearer: tB1 })
    expect(s.status).toBe(200)
    expect(JSON.stringify(s.body?.data || {})).not.toContain(e21.id)
    // global search surfaces the in-scope employee by the same probe
    const s2 = await postHrm("search.global", { q: e11.fullName }, { bearer: tB1 })
    expect(JSON.stringify(s2.body?.data || {})).toContain(e11.id)
    // counts: only Branch A employees are counted
    const c = await postHrm("employees.statusCounts", {}, { bearer: tB1 })
    expect(c.body?.data?.total).toBe(3) // e11, e12, e11b — never e21/e22
    expect((c.body?.data?.counts || {}).ACTIVE || 0).toBe(3)
    // picker (refList) + paginated list carry the same scope
    const ref = await postHrm("employees.refList", {}, { bearer: tB1 })
    expect((ref.body?.data?.refs || []).map((x: any) => x.id)).not.toContain(e21.id)
    expect(ref.body?.data?.total).toBe(3)
    const page = await postHrm("employees.list", { paginate: true, take: 500 }, { bearer: tB1 })
    expect((page.body?.data?.rows || []).map((x: any) => x.id)).not.toContain(e22.id)
    expect(page.body?.data?.total).toBe(3)
  })
})

// ---------------------------------------------------------------------------
// B — department scope
// ---------------------------------------------------------------------------
describe("R-03 B — department scope (UserCompanyAccess.departmentScope = [D1])", () => {
  test("B7 · Department X user cannot list Department Y employees", async () => {
    const r = await postHrm("employees.list", {}, { bearer: tD1 })
    expect(r.status).toBe(200)
    const got = ids(r)
    expect(got).toContain(e11.id)
    expect(got).toContain(e21.id)
    expect(got).not.toContain(e12.id)
    expect(got).not.toContain(e22.id)
  })

  test("B8 · direct detail access to a Department Y employee is denied", async () => {
    const r = await postHrm("employees.get", { id: e12.id }, { bearer: tD1 })
    expect(r.status).toBe(404)
  })

  test("B9 · mutations against Department Y employees are denied", async () => {
    const r = await postHrm("employees.suspend", { id: e12.id }, { bearer: tD1 })
    expect(r.status).toBe(404)
  })

  test("B10 · related employee records (corrections queue) do not expose Department Y employees", async () => {
    const r = await postHrm("attendance.corrections.list", {}, { bearer: tD1 })
    expect(r.status).toBe(200)
    const list = r.body?.data || []
    expect(list.some((c: any) => c.employeeId === e12.id)).toBe(false)
    expect(list.some((c: any) => c.employeeId === e11b.id)).toBe(true) // D1 victim stays visible
  })
})

// ---------------------------------------------------------------------------
// C — combined scope + branch-manager intersection
// ---------------------------------------------------------------------------
describe("R-03 C — combined scope and branch-manager intersection", () => {
  test("C11 · Branch A + Department X allows only employees satisfying BOTH restrictions", async () => {
    const r = await postHrm("employees.list", {}, { bearer: tB1D1 })
    expect(r.status).toBe(200)
    const got = ids(r)
    expect(got).toContain(e11.id) // B1 ∩ D1
    expect(got).not.toContain(e12.id) // B1 but D2
    expect(got).not.toContain(e21.id) // D1 but B2
    expect(got).not.toContain(e22.id) // neither
  })

  test("C12a · branch manager (own B1) + access scope [B2] must NOT expand to B2 nor keep B1 — matches NOTHING", async () => {
    const r = await postHrm("employees.list", {}, { bearer: tBmBogus })
    expect(r.status).toBe(200)
    expect(ids(r)).toEqual([])
  })

  test("C12b · branch manager (own B1) + access scope [B1,B2] keeps exactly B1 (no expansion to B2)", async () => {
    const r = await postHrm("employees.list", {}, { bearer: tBmOk })
    expect(r.status).toBe(200)
    const got = ids(r)
    expect(got).toContain(e11.id)
    expect(got).toContain(e12.id)
    expect(got).not.toContain(e21.id)
    expect(got).not.toContain(e22.id)
  })

  test("C13 · branch manager (own B1) + departmentScope [D2] enforces BOTH restrictions", async () => {
    const r = await postHrm("employees.list", {}, { bearer: tBmDept })
    expect(r.status).toBe(200)
    const got = ids(r)
    expect(got).toEqual([e12.id]) // B1 ∩ D2 — exactly one employee
  })

  test("C14 · empty branch scope fails CLOSED (no employees — never the whole company)", async () => {
    const list = await postHrm("employees.list", {}, { bearer: tEmpty })
    expect(list.status).toBe(200)
    expect(ids(list)).toEqual([])
    const detail = await postHrm("employees.get", { id: e11.id }, { bearer: tEmpty })
    expect(detail.status).toBe(404)
    const mut = await postHrm("employees.suspend", { id: e11.id }, { bearer: tEmpty })
    expect(mut.status).toBe(404)
  })
})

// ---------------------------------------------------------------------------
// D — company isolation (the first dimension of the intersection)
// ---------------------------------------------------------------------------
describe("R-03 D — company isolation", () => {
  test("D15 · an employee of ANOTHER company in the same vendor cannot be accessed", async () => {
    const get = await postHrm("employees.get", { id: eC2.id }, { bearer: tB1 })
    expect(get.status).toBe(404)
    const list = await postHrm("employees.list", {}, { bearer: tB1 })
    expect(ids(list)).not.toContain(eC2.id)
  })

  test("D16 · a client-supplied company ID cannot override the active company context", async () => {
    // (a) the switcher: a non-admin without a C2 access row cannot ACTIVATE
    // C2 — the active company is server-resolved from the session + access
    // rows, never from a client parameter
    const sw = await postHrm("companies.activate", { companyId: c2.id }, { bearer: tB1 })
    expect(sw.status).toBe(403)
    // the session still resolves C1 (no silent context change)
    const after = await postHrm("employees.list", {}, { bearer: tB1 })
    expect(after.status).toBe(200)
    expect(ids(after)).not.toContain(eC2.id)
    // (b) employee creation: the strict employeesSave whitelist REJECTS a
    // client companyId outright (unknown key → 400), and even the in-handler
    // resolution would run assertCompany (403 for a non-admin without access)
    const create = await postHrm("employees.create", { fullName: "R03 Cross Company", companyId: c2.id }, { bearer: tB1 })
    expect([400, 403]).toContain(create.status)
    const made = await db.employee.findFirst({ where: { vendorId: vendor.id, fullName: "R03 Cross Company" } })
    expect(made).toBeNull()
  })

  test("D17 · related employee records cannot cross company boundaries (corrections queue)", async () => {
    const r = await postHrm("attendance.corrections.list", {}, { bearer: tB1 })
    expect(r.status).toBe(200)
    const list = r.body?.data || []
    expect(list.some((c: any) => c.employeeId === eC2.id)).toBe(false)
    expect(list.some((c: any) => c.employeeId === e11b.id)).toBe(true) // same-company record stays visible
  })
})

// ---------------------------------------------------------------------------
// E — bulk / indirect access
// ---------------------------------------------------------------------------
describe("R-03 E — bulk and indirect access", () => {
  test("E18 · mixed authorized/unauthorized employee targets cannot cause unauthorized mutation (org-chart batch)", async () => {
    // first item in scope, second out of scope → the WHOLE batch is denied
    const r = await postHrm("orgChart.batchSetReporting", {
      updates: [
        { employeeId: e11.id, managerId: null },
        { employeeId: e21.id, managerId: null },
      ],
    }, { bearer: tB1 })
    expect(r.status).toBe(404)
    const victim = await db.employee.findUniqueOrThrow({ where: { id: e21.id } })
    expect(victim.reportingManagerId).toBeNull()
  })

  test("E18b · a single out-of-scope mutation target is denied (roster assignment)", async () => {
    const r = await postHrm("rosters.assign", { employeeId: e21.id, shiftId: shift.id, fromDate: "2026-11-01" }, { bearer: tB1 })
    expect(r.status).toBe(404)
    const assignment = await db.shiftAssignment.findFirst({ where: { vendorId: vendor.id, employeeId: e21.id } })
    expect(assignment).toBeNull()
  })

  test("E18c · attendance register client filters cannot overwrite the caller's scope (the R-03 register intersection)", async () => {
    // plain register: only Branch A records
    const plain = await postHrm("attendance.register", { month: 10, year: 2026 }, { bearer: tB1 })
    expect(plain.status).toBe(200)
    const plainRows = plain.body?.data || []
    expect(plainRows.some((x: any) => x.employeeId === e11.id)).toBe(true)
    expect(plainRows.some((x: any) => x.employeeId === e21.id)).toBe(false)
    // the OLD defect: passing branchId/q REPLACED the scoped employee set with
    // a vendor-wide one — a B1-scoped user could read Branch B's register
    const byBranch = await postHrm("attendance.register", { month: 10, year: 2026, branchId: br2.id }, { bearer: tB1 })
    expect(byBranch.status).toBe(200)
    expect((byBranch.body?.data || []).some((x: any) => x.employeeId === e21.id)).toBe(false)
    const bySearch = await postHrm("attendance.register", { month: 10, year: 2026, q: e21.fullName }, { bearer: tB1 })
    expect(bySearch.status).toBe(200)
    expect((bySearch.body?.data || []).some((x: any) => x.employeeId === e21.id)).toBe(false)
  })

  test("E19 · counts, aggregates and dropdowns respect the same effective scope (pending-OT queue)", async () => {
    const r = await postHrm("attendance.otPending", { month: 10, year: 2026 }, { bearer: tB1 })
    expect(r.status).toBe(200)
    const rows = r.body?.data || []
    expect(rows.some((x: any) => x.employeeId === e11.id)).toBe(true)
    expect(rows.some((x: any) => x.employeeId === e21.id)).toBe(false)
    expect(rows.some((x: any) => x.employeeId === eC2.id)).toBe(false)
  })

  test("E20 · related module endpoints enforce the employee's scope even when not named employees", async () => {
    // performance reviews
    const rev = await postHrm("reviews.list", { employeeId: e21.id }, { bearer: tB1 })
    expect(rev.status).toBe(404)
    // roster listings
    const ros = await postHrm("rosters.list", { employeeId: e21.id }, { bearer: tB1 })
    expect(ros.status).toBe(404)
    // salary revisions (money records)
    const sal = await postHrm("salaryRevisions.list", { employeeId: e21.id }, { bearer: tB1 })
    expect(sal.status).toBe(404)
    // onboarding tasks
    const onb = await postHrm("ats.onboarding.list", { employeeId: e21.id }, { bearer: tB1 })
    expect(onb.status).toBe(404)
    // procurement requisitions
    const req = await postHrm("requisitions.list", { employeeId: e21.id }, { bearer: tB1 })
    expect(req.status).toBe(404)
    // AIT calculation logs
    const ait = await postHrm("ait.logs.list", { employeeId: e21.id }, { bearer: tB1 })
    expect(ait.status).toBe(404)
    // in-scope ids stay readable on the same surfaces
    const revOk = await postHrm("reviews.list", { employeeId: e11.id }, { bearer: tB1 })
    expect(revOk.status).toBe(200)
  })
})

// ---------------------------------------------------------------------------
// F — allowed operations still work (no over-blocking)
// ---------------------------------------------------------------------------
describe("R-03 F — in-scope operations keep working", () => {
  test("F1 · unscoped access (null scope) still sees the whole company", async () => {
    const r = await postHrm("employees.list", {}, { bearer: tFull })
    expect(r.status).toBe(200)
    const got = ids(r)
    expect(got).toContain(e11.id)
    expect(got).toContain(e21.id)
    expect(got).toContain(e22.id)
    expect(got).not.toContain(eC2.id) // company boundary still applies
  })

  test("F2 · a scoped user CAN act on an in-scope employee (correction decision)", async () => {
    const row = await db.attendanceCorrection.findFirstOrThrow({ where: { employeeId: e11b.id, status: "PENDING" } })
    const r = await postHrm("attendance.corrections.act", { id: row.id, decision: "REJECTED" }, { bearer: tB1 })
    expect(r.status).toBe(200)
    const after = await db.attendanceCorrection.findUniqueOrThrow({ where: { id: row.id } })
    expect(after.status).toBe("REJECTED")
  })

  test("F3 · a scoped user CAN mutate an in-scope employee (suspend + archive)", async () => {
    const s = await postHrm("employees.suspend", { id: e11b.id, reason: "R03 in-scope" }, { bearer: tB1 })
    expect(s.status).toBe(200)
    const d = await postHrm("employees.delete", { id: e11b.id }, { bearer: tB1 })
    expect(d.status).toBe(200)
    const after = await db.employee.findUniqueOrThrow({ where: { id: e11b.id } })
    expect(after.status).toBe("INACTIVE")
  })
})

// ---------------------------------------------------------------------------
// G — resolver-matrix semantics (filter level)
// ---------------------------------------------------------------------------
describe("R-03 G — resolver matrix (employeeScopeFilter / companyEmployeeScopeFilter)", () => {
  const base = () => {
    const c = makeCtx({ id: "u1", vendorId: "v1", role: "HR_MANAGER" }, ["employees.view"]) as any
    c.activeCompanyId = "c1"
    c.allCompaniesMode = false
    return c
  }

  test("G1 · null scope → no branch/department narrowing (all of the company)", () => {
    const ctx = base()
    const f = employeeScopeFilter(ctx)
    expect("branchId" in f).toBe(false)
    expect("departmentId" in f).toBe(false)
  })

  test("G2 · explicit scope → {in: [ids]}", () => {
    const ctx = base()
    ctx.companyBranchScope = ["b1"]
    const f = employeeScopeFilter(ctx)
    expect(JSON.stringify(f.branchId)).toBe(JSON.stringify({ in: ["b1"] }))
  })

  test("G3 · EMPTY scope → {in: []} (fail-closed — never all branches)", () => {
    const ctx = base()
    ctx.companyBranchScope = []
    ctx.companyDepartmentScope = []
    const f = employeeScopeFilter(ctx)
    expect(JSON.stringify(f.branchId)).toBe(JSON.stringify({ in: [] }))
    expect(JSON.stringify(f.departmentId)).toBe(JSON.stringify({ in: [] }))
  })

  test("G4 · companyEmployeeScopeFilter is the SAME resolver (delegation — one source of truth)", () => {
    const ctx = base()
    ctx.companyBranchScope = ["b1", "b2"]
    expect(JSON.stringify(companyEmployeeScopeFilter(ctx))).toBe(JSON.stringify(employeeScopeFilter(ctx)))
    ctx.companyBranchScope = []
    expect(JSON.stringify(companyEmployeeScopeFilter(ctx))).toBe(JSON.stringify(employeeScopeFilter(ctx)))
    // the pre-fix copy skipped the empty scope (fail-open); the delegation now
    // fails closed with the canonical resolver
    expect(JSON.stringify(companyEmployeeScopeFilter(ctx).branchId)).toBe(JSON.stringify({ in: [] }))
  })

  test("G5 · no active company / All-Companies mode → scope is not applied (consolidated reads unchanged)", () => {
    const ctx = makeCtx({ id: "u1", vendorId: "v1", role: "VENDOR_OWNER" }, ["*"]) as any
    ctx.activeCompanyId = null
    ctx.allCompaniesMode = true
    ctx.companyBranchScope = null // auth.ts nulls it in mode
    const f = employeeScopeFilter(ctx)
    expect("branchId" in f).toBe(false)
    expect("companyId" in f).toBe(false)
  })

  test("G6 · role branch ∩ access scope: inside keeps it, outside matches nothing (both resolvers)", () => {
    const ctx = makeCtx({ id: "u1", vendorId: "v1", role: "BRANCH_MANAGER", branchId: "b1" }, ["employees.view"]) as any
    ctx.activeCompanyId = "c1"
    ctx.allCompaniesMode = false
    ctx.companyBranchScope = ["b2"]
    expect(JSON.stringify(employeeScopeFilter(ctx).branchId)).toBe(JSON.stringify({ in: [] }))
    expect(JSON.stringify(companyEmployeeScopeFilter(ctx).branchId)).toBe(JSON.stringify({ in: [] }))
    ctx.companyBranchScope = ["b1", "b2"]
    expect(employeeScopeFilter(ctx).branchId).toBe("b1")
    expect(companyEmployeeScopeFilter(ctx).branchId).toBe("b1")
  })

  test("G7 · department scope mirrors the branch semantics for DEPT_MANAGER", () => {
    const ctx = makeCtx({ id: "u1", vendorId: "v1", role: "DEPT_MANAGER", departmentId: "d1" }, ["employees.view"]) as any
    ctx.activeCompanyId = "c1"
    ctx.allCompaniesMode = false
    ctx.companyDepartmentScope = ["d2"]
    expect(JSON.stringify(employeeScopeFilter(ctx).departmentId)).toBe(JSON.stringify({ in: [] }))
    ctx.companyDepartmentScope = ["d1"]
    expect(employeeScopeFilter(ctx).departmentId).toBe("d1")
  })
})

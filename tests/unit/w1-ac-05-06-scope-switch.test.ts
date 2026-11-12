/// <reference types="bun-types" />
// ============ W1-AC-05..06 — canonical scope filters + company switching ============
// Acceptance group W1-AC-05 (canonical company/employee scope: one resolver
// family, unresolved scope -> deny, pre-attribution users keep current
// behavior, the R-03 bogus-intersection fix) and W1-AC-06 (company-switching
// consistency + the R-04 admin access-row auto-create). Unit-level resolver
// matrix + REAL dispatcher probes. 11 tests.
import "./_testdb"
import { describe, test, expect, beforeAll } from "bun:test"
import { db } from "@/lib/db"
import { mkVendor, mkUser, mkEmployee, mkSession, uniq, makeCtx } from "./_fixtures"
import { postHrm } from "./_hrm-endpoint"
import { ensureDefaultCompany } from "@/hrm-server/company"
import { employeeScopeFilter, assertEmployeeVisible } from "@/hrm-server/rbac"
import { companyWhere, companyEmployeeScopeFilter, requireCompanyAccess } from "@/hrm-server/company"

let vendor: any
let companyA: any, companyB: any
let owner: any
let ownerToken: string
let branchA: any, branchB: any
let empA: any, empB: any

async function mkCompany(vendorId: string, code: string, name: string) {
  return db.company.create({ data: { vendorId, code, name, active: true } })
}

beforeAll(async () => {
  vendor = await mkVendor(uniq("W1S Vendor"), { company: false })
  const defA = await ensureDefaultCompany(vendor.id, { name: "W1S Main" })
  companyA = await db.company.findUniqueOrThrow({ where: { id: defA } })
  companyB = await mkCompany(vendor.id, uniq("S2"), "W1S Company Two")
  owner = await mkUser(vendor.id, { role: "VENDOR_OWNER", name: "W1S Owner" })
  ownerToken = await mkSession(owner.id)
  await db.userCompanyAccess.create({
    data: { vendorId: vendor.id, userId: owner.id, companyId: companyA.id, role: "VENDOR_OWNER", active: true, isDefault: true },
  })
  branchA = await db.branch.create({ data: { vendorId: vendor.id, companyId: companyA.id, code: uniq("BA"), name: "Scope Branch A" } })
  branchB = await db.branch.create({ data: { vendorId: vendor.id, companyId: companyB.id, code: uniq("BB"), name: "Scope Branch B" } })
  empA = await mkEmployee(vendor.id, { fullName: "Scope Emp A", branchId: branchA.id })
  await db.employee.update({ where: { id: empA.id }, data: { companyId: companyA.id } })
  empB = await mkEmployee(vendor.id, { fullName: "Scope Emp B", branchId: branchB.id })
  await db.employee.update({ where: { id: empB.id }, data: { companyId: companyB.id } })
})

// ---------------------------------------------------------------------------
// W1-AC-05 — canonical company/employee scope (ONE resolver family)
// ---------------------------------------------------------------------------
describe("W1-AC-05 — canonical company/employee scope", () => {
  test("concrete-company reads pin companyId in the ONE resolver family (employeeScopeFilter / companyWhere / companyEmployeeScopeFilter)", () => {
    const ctx = makeCtx({ id: owner.id, vendorId: vendor.id, role: "VENDOR_OWNER" }, ["organization.view"]) as any
    ctx.activeCompanyId = companyA.id
    ctx.allCompaniesMode = false
    expect(employeeScopeFilter(ctx).companyId).toBe(companyA.id)
    expect(companyWhere(ctx).companyId).toBe(companyA.id)
    expect(companyEmployeeScopeFilter(ctx).companyId).toBe(companyA.id)
  })

  test("mode reads stay tenant-wide (no company clause); mode WRITES throw Deny in every resolver (the clause never dissolves)", () => {
    const ctx = makeCtx({ id: owner.id, vendorId: vendor.id, role: "VENDOR_OWNER" }, ["organization.view"]) as any
    ctx.activeCompanyId = null
    ctx.allCompaniesMode = true
    // reads: tenant-wide by design
    expect("companyId" in employeeScopeFilter(ctx)).toBe(false)
    expect("companyId" in companyWhere(ctx)).toBe(false)
    expect("companyId" in companyEmployeeScopeFilter(ctx)).toBe(false)
    // writes: every resolver refuses
    for (const fn of [() => employeeScopeFilter(ctx, { forWrite: true }), () => companyWhere(ctx, undefined, { forWrite: true }), () => companyEmployeeScopeFilter(ctx, { forWrite: true })]) {
      try {
        fn()
        throw new Error("expected a Deny")
      } catch (e: any) {
        expect(String(e?.message || e)).toContain("read-only")
      }
    }
  })

  test("concrete-company writes keep the company clause (forWrite resolution)", () => {
    const ctx = makeCtx({ id: owner.id, vendorId: vendor.id, role: "VENDOR_OWNER" }, ["organization.view"]) as any
    ctx.activeCompanyId = companyA.id
    ctx.allCompaniesMode = false
    expect(employeeScopeFilter(ctx, { forWrite: true }).companyId).toBe(companyA.id)
    expect(companyWhere(ctx, undefined, { forWrite: true }).companyId).toBe(companyA.id)
    expect(companyEmployeeScopeFilter(ctx, { forWrite: true }).companyId).toBe(companyA.id)
  })

  test("unresolved scope -> requireCompanyAccess Deny (never a silent all-companies default)", () => {
    const ctx = makeCtx({ id: owner.id, vendorId: vendor.id, role: "HR_ADMIN" }, ["organization.view"]) as any
    ctx.activeCompanyId = null
    ctx.allCompaniesMode = false
    try {
      requireCompanyAccess(ctx)
      throw new Error("expected a Deny")
    } catch (e: any) {
      expect(String(e?.message || e)).toContain("No active company")
    }
  })

  test("pre-attribution HR_ADMIN (no access rows) keeps today's default-company-scoped behavior through the dispatcher", async () => {
    const u = await mkUser(vendor.id, { role: "HR_ADMIN", name: "PreAttribution Admin", permissions: ["organization.view"] })
    const t = await mkSession(u.id)
    // no UserCompanyAccess row at all — legacy fallback resolves the default company
    const branches = await postHrm("branches.list", {}, { bearer: t })
    expect(branches.status).toBe(200)
    // default company = A: branchA visible, branchB (company B) NOT
    const codes: string[] = (branches.body?.data || []).map((b: any) => b.code)
    expect(codes).toContain(branchA.code)
    expect(codes).not.toContain(branchB.code)
  })

  test("pre-attribution NON-admin without access rows is fail-closed (403, no data)", async () => {
    const u = await mkUser(vendor.id, { role: "HR_MANAGER", name: "PreAttribution Manager", permissions: ["organization.view"] })
    const t = await mkSession(u.id)
    const r = await postHrm("branches.list", {}, { bearer: t })
    expect(r.status).toBe(403)
    expect(r.body?.data).toBeUndefined()
  })

  test("R-03 bogus-intersection fix: own-branch OUT of company scope matches NOTHING; IN scope keeps exactly it; no role branch -> company scope", async () => {
    // a branch manager whose own branch is company A's branchA…
    const mgrCtx = makeCtx({ id: owner.id, vendorId: vendor.id, role: "BRANCH_MANAGER", branchId: branchA.id }, ["organization.view"]) as any
    mgrCtx.activeCompanyId = companyA.id
    mgrCtx.allCompaniesMode = false
    // …with an access row scoped to a DIFFERENT branch of the same company
    const otherBranch = await db.branch.create({ data: { vendorId: vendor.id, companyId: companyA.id, code: uniq("OB"), name: "Other Branch" } })
    mgrCtx.companyBranchScope = [otherBranch.id]
    let f = companyEmployeeScopeFilter(mgrCtx)
    expect(JSON.stringify(f.branchId)).toBe(JSON.stringify({ in: [] })) // bogus intersection -> matches nothing

    // own branch INSIDE the scope -> keeps exactly the manager's branch
    mgrCtx.companyBranchScope = [branchA.id, otherBranch.id]
    f = companyEmployeeScopeFilter(mgrCtx)
    expect(f.branchId).toBe(branchA.id)

    // no role branch -> the company scope applies as {in: [...]}
    const plainCtx = makeCtx({ id: owner.id, vendorId: vendor.id, role: "HR_ADMIN" }, ["organization.view"]) as any
    plainCtx.activeCompanyId = companyA.id
    plainCtx.companyBranchScope = [branchA.id, otherBranch.id]
    f = companyEmployeeScopeFilter(plainCtx)
    expect(JSON.stringify(f.branchId)).toBe(JSON.stringify({ in: [branchA.id, otherBranch.id] }))

    // dispatcher probe: the out-of-scope employee is invisible to the scoped manager
    const mgr = await mkUser(vendor.id, { role: "BRANCH_MANAGER", name: "Scoped BM", branchId: branchA.id, permissions: ["organization.view", "communication.view"] })
    await db.userCompanyAccess.create({
      data: { vendorId: vendor.id, userId: mgr.id, companyId: companyA.id, role: "BRANCH_MANAGER", active: true, isDefault: true, branchScope: JSON.stringify([otherBranch.id]) },
    })
    const mt = await mkSession(mgr.id)
    const ann = await postHrm("announcements.list", { employeePicker: true }, { bearer: mt })
    // whatever the surface returns, the out-of-scope employee never appears
    expect(JSON.stringify(ann.body || {})).not.toContain(empA.fullName)
  })
})

// ---------------------------------------------------------------------------
// W1-AC-06 — company-switching consistency + R-04 auto-create
// ---------------------------------------------------------------------------
describe("W1-AC-06 — company-switching consistency + R-04 auto-create", () => {
  test("A -> B -> A re-resolves immediately with zero cross-company bleed", async () => {
    const t = await mkSession(owner.id)
    // A
    await postHrm("companies.activate", { companyId: companyA.id }, { bearer: t })
    let branches = await postHrm("branches.list", {}, { bearer: t })
    let codes: string[] = (branches.body?.data || []).map((b: any) => b.code)
    expect(codes).toContain(branchA.code)
    expect(codes).not.toContain(branchB.code)
    // B
    const swB = await postHrm("companies.activate", { companyId: companyB.id }, { bearer: t })
    expect(swB.status).toBe(200)
    branches = await postHrm("branches.list", {}, { bearer: t })
    codes = (branches.body?.data || []).map((b: any) => b.code)
    expect(codes).toContain(branchB.code)
    expect(codes).not.toContain(branchA.code)
    // back to A
    await postHrm("companies.activate", { companyId: companyA.id }, { bearer: t })
    branches = await postHrm("branches.list", {}, { bearer: t })
    codes = (branches.body?.data || []).map((b: any) => b.code)
    expect(codes).toContain(branchA.code)
    expect(codes).not.toContain(branchB.code)
  })

  test("switches are audited: audit.list carries the companies.activate entries naming both companies", async () => {
    const r = await postHrm("audit.list", { limit: 200 }, { bearer: ownerToken })
    const switches = (r.body?.data?.items || []).filter((i: any) => i.action === "companies.activate")
    expect(switches.length).toBeGreaterThan(0)
    const summaries = switches.map((s: any) => String(s.summary || "")).join(" | ")
    expect(summaries).toContain(companyA.name)
    expect(summaries).toContain(companyB.name)
  })

  test("R-04: an admin switching WITHOUT an access row gets the row auto-created in the same transaction — the NEXT request resolves the target (no silent revert); idempotent; non-admins fail closed", async () => {
    const admin = await mkUser(vendor.id, { role: "HR_ADMIN", name: "AutoCreate Admin", permissions: ["companies.view", "organization.view"] })
    const at = await mkSession(admin.id)
    // NO access row for company B
    const before = await db.userCompanyAccess.count({ where: { userId: admin.id, companyId: companyB.id } })
    expect(before).toBe(0)
    const sw = await postHrm("companies.activate", { companyId: companyB.id }, { bearer: at })
    expect(sw.status).toBe(200)
    // the row exists now, with the derived-baseline deltas
    const rows = await db.userCompanyAccess.findMany({ where: { userId: admin.id, companyId: companyB.id } })
    expect(rows.length).toBe(1)
    expect(rows[0].role).toBe("HR_ADMIN")
    expect(rows[0].permissions).toBe("[]")
    expect(rows[0].excludedPermissions).toBe("[]")
    expect(rows[0].active).toBe(true)
    expect(rows[0].isDefault).toBe(false)
    expect(String(rows[0].grantedByName || "")).toContain("auto")
    // the NEXT request resolves company B (the pre-R-04 silent revert is gone)
    const branches = await postHrm("branches.list", {}, { bearer: at })
    expect(branches.status).toBe(200)
    const codes: string[] = (branches.body?.data || []).map((b: any) => b.code)
    expect(codes).toContain(branchB.code)
    expect(codes).not.toContain(branchA.code)
    // re-switch does NOT duplicate the row
    await postHrm("companies.activate", { companyId: companyB.id }, { bearer: at })
    const after = await db.userCompanyAccess.count({ where: { userId: admin.id, companyId: companyB.id } })
    expect(after).toBe(1)
    // non-admins get NO auto-create (fail-closed, zero rows)
    const mgr = await mkUser(vendor.id, { role: "HR_MANAGER", name: "No AutoCreate", permissions: ["companies.view"] })
    const mt = await mkSession(mgr.id)
    const denied = await postHrm("companies.activate", { companyId: companyB.id }, { bearer: mt })
    expect(denied.status).toBe(403)
    const mgrRows = await db.userCompanyAccess.count({ where: { userId: mgr.id } })
    expect(mgrRows).toBe(0)
  })

  test("R-03 write-path backstop: assertEmployeeVisible(forWrite) denies in mode (on-behalf writes never dissolve the company clause)", async () => {
    const t = await mkSession(owner.id)
    await postHrm("companies.activate", { allCompanies: true }, { bearer: t })
    // the ctx of a mode request: activeCompanyId null, mode on
    const modeCtx = makeCtx({ id: owner.id, vendorId: vendor.id, role: "VENDOR_OWNER" }, ["attendance.edit"]) as any
    modeCtx.activeCompanyId = null
    modeCtx.allCompaniesMode = true
    try {
      await assertEmployeeVisible(modeCtx, empA.id, { forWrite: true })
      throw new Error("expected a Deny")
    } catch (e: any) {
      expect(String(e?.message || e)).toContain("read-only")
    }
  })
})

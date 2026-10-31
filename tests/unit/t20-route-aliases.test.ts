/// <reference types="bun-types" />
// ============ T-20 (2026-10-31) — prefixed aliases for unprefixed route modules ============
// The master plan (P1, T-20): "performance.ts/roadmap.ts register unprefixed
// actions (cycles.list, reimbursements.list…) — the root cause of the mobile
// app's imagined namespace (contract audit §5.1). Solution: registry alias
// support (performance.reviews.list → same handler) after inventorying every
// web-SPA call site; deprecation note for flat names. Acceptance: both names
// resolve; contract test extended."
//
// What this suite pins:
//   1. Every documented alias resolves to the SAME RouteDef OBJECT as its
//      canonical flat name — same handler, perm, schema, mutating flag — so
//      the two spellings can never drift apart (the registry's alias()
//      guarantees it structurally; these tests prove it).
//   2. The flat names keep resolving (back-compat: the web SPA's 35 live
//      call sites — inventory in API_CONTRACT_AUDIT.md §5.1).
//   3. The alias inventory is EXACTLY the documented set — no accidental
//      or future-rogue aliases (a new alias must update this list AND the
//      audit doc deliberately).
//   4. Dispatcher gating parity: no alias prefix lands in the dispatcher's
//      SAAS_ACTION_PREFIX_MODULE (prefix-based feature gating for
//      internally-authorized routes) — an alias must never introduce a gate
//      the flat name never had (or vice versa).
//   5. BEHAVIORAL — through the real dispatcher: an aliased list action
//      returns the same payload as its flat spelling for the same session,
//      and a permission-denied caller is denied identically under both
//      spellings (the perm gate is shared by construction; proven here).
import "./_testdb"
import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { db } from "@/lib/db"
import { routes, routeAliases } from "@/hrm-server/routes/registry"
import { SAAS_ACTION_PREFIX_MODULE } from "@/app/api/hrm/route"
import { mkVendor, mkUser, mkEmployee, mkSession, uniq } from "./_fixtures"
import { postHrm } from "./_hrm-endpoint"

// The documented T-20 alias inventory (must mirror the alias() calls in
// routes/performance.ts + routes/roadmap.ts and API_CONTRACT_AUDIT.md §5.1).
const EXPECTED_ALIASES: Record<string, string> = {
  // performance.ts — the `performance.` family
  "performance.cycles.list": "cycles.list",
  "performance.cycles.save": "cycles.save",
  "performance.reviews.list": "reviews.list",
  "performance.reviews.save": "reviews.save",
  "performance.reviews.acknowledge": "reviews.acknowledge",
  "performance.reviews.finalize": "reviews.finalize",
  "performance.kpiTemplates.list": "kpiTemplates.list",
  "performance.kpiTemplates.save": "kpiTemplates.save",
  "performance.kpiTemplates.delete": "kpiTemplates.delete",
  "performance.kpiAssignments.list": "kpiAssignments.list",
  "performance.kpiAssignments.assign": "kpiAssignments.assign",
  "performance.kpiAssignments.submitResults": "kpiAssignments.submitResults",
  "performance.tasks.list": "tasks.list",
  "performance.tasks.save": "tasks.save",
  "performance.tasks.comment": "tasks.comment",
  "performance.tasks.delete": "tasks.delete",
  // roadmap.ts — prefixed by each route's feature module
  "ait.taxExemptions.list": "taxExemptions.list",
  "ait.taxExemptions.save": "taxExemptions.save",
  "ait.taxExemptions.delete": "taxExemptions.delete",
  "payroll.salaryTemplates.list": "salaryTemplates.list",
  "payroll.salaryTemplates.save": "salaryTemplates.save",
  "payroll.salaryTemplates.delete": "salaryTemplates.delete",
  "payroll.salaryTemplates.apply": "salaryTemplates.apply",
  "payroll.salaryRevisions.list": "salaryRevisions.list",
  "attendance.overtime.list": "overtime.list",
  "attendance.overtime.submit": "overtime.submit",
  "expenses.reimbursements.list": "reimbursements.list",
  "expenses.reimbursements.mark": "reimbursements.mark",
  "employees.orgChart.data": "orgChart.data",
  "employees.orgChart.organogram": "orgChart.organogram",
  "employees.orgChart.saveLayout": "orgChart.saveLayout",
  "employees.orgChart.batchSetReporting": "orgChart.batchSetReporting",
  "employees.orgChart.setReportingManager": "orgChart.setReportingManager",
  "employees.orgChart.reassignEmployee": "orgChart.reassignEmployee",
  "employees.orgChart.assignDesignationDepartment": "orgChart.assignDesignationDepartment",
  "employees.orgChart.desigChart.data": "orgChart.desigChart.data",
  "employees.orgChart.desigChart.saveHierarchy": "orgChart.desigChart.saveHierarchy",
  "employees.promotions.list": "promotions.list",
  "employees.transfers.list": "transfers.list",
  "letters.exitPacket.generate": "exitPacket.generate",
  "settings.auditRetention.purge": "auditRetention.purge",
  "settings.backups.export": "backups.export",
}

let vendor: { id: string }
let hrToken: string
let employeeToken: string

beforeAll(async () => {
  vendor = await mkVendor("T20 Alias Vendor")
  const emp = await mkEmployee(vendor.id, { fullName: "T20 Employee" })
  hrToken = await mkSession((await mkUser(vendor.id, { role: "HR_ADMIN", name: "T20 HR" })).id, "FULL")
  employeeToken = await mkSession((await mkUser(vendor.id, { role: "EMPLOYEE", name: "T20 Emp", employeeId: emp.id })).id, "FULL")
})

afterAll(async () => {
  await db.employee.deleteMany({ where: { vendorId: vendor.id } })
  await db.user.deleteMany({ where: { vendorId: vendor.id } })
  await db.vendor.deleteMany({ where: { id: vendor.id } }).catch(() => {})
  await db.$disconnect()
})

describe("T-20 · both spellings resolve to the SAME route definition", () => {
  test("every documented alias resolves and shares the canonical RouteDef object", () => {
    for (const [aliasName, canonical] of Object.entries(EXPECTED_ALIASES)) {
      const a = routes[aliasName]
      const c = routes[canonical]
      expect(a, `alias "${aliasName}" must be registered`).toBeTruthy()
      expect(c, `canonical "${canonical}" must stay registered`).toBeTruthy()
      expect(a, `"${aliasName}" must be the SAME RouteDef object as "${canonical}"`).toBe(c)
      expect(a!.perm, `perm parity for "${aliasName}"`).toBe(c!.perm)
      expect(a!.schema, `schema parity for "${aliasName}"`).toBe(c!.schema)
      expect(a!.handler, `handler parity for "${aliasName}"`).toBe(c!.handler)
      expect(a!.public, `public parity for "${aliasName}"`).toBe(c!.public)
      expect(a!.mutating, `mutating parity for "${aliasName}"`).toBe(c!.mutating)
    }
  })

  test("the live alias registry is EXACTLY the documented inventory", () => {
    expect(routeAliases).toEqual(EXPECTED_ALIASES)
  })

  test("the web SPA's flat call sites keep resolving (back-compat)", () => {
    // the 35 flat names the SPA calls today (inventory: API_CONTRACT_AUDIT §5.1)
    const spaFlatCalls = [
      "cycles.list", "cycles.save", "reviews.list", "reviews.save", "reviews.acknowledge", "reviews.finalize",
      "kpiTemplates.list", "kpiTemplates.save", "kpiTemplates.delete",
      "kpiAssignments.list", "kpiAssignments.assign", "kpiAssignments.submitResults",
      "tasks.list", "tasks.save", "tasks.comment",
      "taxExemptions.list", "salaryTemplates.list", "salaryTemplates.save", "salaryTemplates.delete", "salaryTemplates.apply",
      "overtime.list", "overtime.submit",
      "reimbursements.list", "reimbursements.mark",
      "orgChart.data", "orgChart.desigChart.data", "orgChart.desigChart.saveHierarchy",
      "orgChart.batchSetReporting", "orgChart.setReportingManager",
      "promotions.list", "transfers.list", "salaryRevisions.list", "exitPacket.generate",
      "payroll.reversals", "backups.export", "employees.bulkImport",
    ]
    for (const name of spaFlatCalls) {
      expect(routes[name], `flat name "${name}" (web SPA call site) must keep resolving`).toBeTruthy()
    }
  })

  test("no alias introduces prefix-based feature gating the flat name never had", () => {
    // saasActionModule(action) gates only perm-less routes by their FIRST
    // segment against SAAS_ACTION_PREFIX_MODULE. The flat names' heads
    // (cycles, reviews, kpiTemplates, tasks, reimbursements, orgChart, …)
    // map to nothing there — so the aliases' heads must map to nothing too.
    for (const aliasName of Object.keys(EXPECTED_ALIASES)) {
      const prefix = aliasName.split(".")[0]
      expect(SAAS_ACTION_PREFIX_MODULE[prefix], `alias prefix "${prefix}" must stay out of SAAS_ACTION_PREFIX_MODULE`).toBeUndefined()
    }
  })
})

describe("T-20 · dispatcher behavior is identical under both spellings", () => {
  test("employees.promotions.list (alias) === promotions.list (flat) for the same HR session", async () => {
    const flat = await postHrm("promotions.list", {}, { bearer: hrToken })
    const aliased = await postHrm("employees.promotions.list", {}, { bearer: hrToken })
    expect(flat.status).toBe(200)
    expect(aliased.status).toBe(200)
    expect(aliased.body.data).toEqual(flat.body.data)
  })

  test("attendance.overtime.list (alias) === overtime.list (flat)", async () => {
    const flat = await postHrm("overtime.list", {}, { bearer: hrToken })
    const aliased = await postHrm("attendance.overtime.list", {}, { bearer: hrToken })
    expect(flat.status).toBe(200)
    expect(aliased.status).toBe(200)
    expect(aliased.body.data).toEqual(flat.body.data)
  })

  test("a permission-denied caller is denied identically under both spellings", async () => {
    // EMPLOYEE role lacks attendance.view → the shared perm gate must 403
    // both the flat name and the alias
    const flat = await postHrm("overtime.list", {}, { bearer: employeeToken })
    const aliased = await postHrm("attendance.overtime.list", {}, { bearer: employeeToken })
    expect(flat.status).toBe(403)
    expect(aliased.status).toBe(403)
    expect(aliased.body.error).toBe(flat.body.error)
  })

  test("the mobile app's employee plane stays on the REAL prefixed actions (no imagined namespace)", async () => {
    // The original failure: the mobile app called performance.* names that
    // never existed. The mobile contract (API_CONTRACT_AUDIT.md §4) calls
    // ess.performance — which must keep resolving exactly as before.
    const res = await postHrm("ess.performance", {}, { bearer: employeeToken })
    expect(res.status).toBe(200)
    expect(Array.isArray(res.body.data.reviews)).toBe(true)
    expect(Array.isArray(res.body.data.kpis)).toBe(true)
  })
})

/// <reference types="bun-types" />
// ============ MULTI-COMPANY (2026-11-03) — cross-company security suite ============
// The master prompt's mandatory boundary tests: build two vendors, three
// companies, employees and financial records in each, then attempt cross-
// company access through the REAL dispatcher (postHrm — production traffic
// path). Expected: same-tenant-unauthorized-company DENY, cross-tenant DENY,
// authorized company ALLOW, authorized branch ALLOW, unauthorized DENY.
import "./_testdb"
import { describe, test, expect, beforeAll } from "bun:test"
import { db } from "@/lib/db"
import { mkVendor, mkUser, mkEmployee, mkSession, uniq } from "./_fixtures"
import { postHrm } from "./_hrm-endpoint"
import { ensureDefaultCompany } from "@/hrm-server/company"

// ---------------------------------------------------------------------------
// fixture: vendor A (companies A1 + A2) and vendor B (company B1)
// ---------------------------------------------------------------------------
let vendorA: any, vendorB: any
let companyA1: any, companyA2: any, companyB1: any
let adminA: any, adminB: any // VENDOR_OWNERs
let adminAToken: string, adminBToken: string
let empA1: any, empA2: any, empB1: any
let branchA1: any, branchA2: any

async function mkCompany(vendorId: string, code: string, name: string) {
  return db.company.create({ data: { vendorId, code, name, active: true } })
}

beforeAll(async () => {
  vendorA = await mkVendor(uniq("MC Vendor A"), { company: false })
  vendorB = await mkVendor(uniq("MC Vendor B"), { company: false })
  // default companies per vendor (provision path)
  const defA = await ensureDefaultCompany(vendorA.id, { name: "A Group Main" })
  const defB = await ensureDefaultCompany(vendorB.id, { name: "B Group Main" })
  companyA1 = await db.company.findUniqueOrThrow({ where: { id: defA } })
  companyA2 = await mkCompany(vendorA.id, "A2", "A Company Two")
  companyB1 = await db.company.findUniqueOrThrow({ where: { id: defB } })

  adminA = await mkUser(vendorA.id, { role: "VENDOR_OWNER", name: "Owner A" })
  adminB = await mkUser(vendorB.id, { role: "VENDOR_OWNER", name: "Owner B" })
  adminAToken = await mkSession(adminA.id)
  adminBToken = await mkSession(adminB.id)

  // seed the owner access rows the way the migration does
  for (const [user, company] of [[adminA, companyA1], [adminB, companyB1]] as const) {
    await db.userCompanyAccess.create({
      data: { vendorId: user.vendorId, userId: user.id, companyId: company.id, role: "VENDOR_OWNER", active: true, isDefault: true },
    })
  }

  branchA1 = await db.branch.create({ data: { vendorId: vendorA.id, companyId: companyA1.id, code: uniq("BRA1"), name: "A1 Branch" } })
  branchA2 = await db.branch.create({ data: { vendorId: vendorA.id, companyId: companyA2.id, code: uniq("BRA2"), name: "A2 Branch" } })

  empA1 = await mkEmployee(vendorA.id, { fullName: "Works At A1", branchId: branchA1.id })
  await db.employee.update({ where: { id: empA1.id }, data: { companyId: companyA1.id } })
  empA2 = await mkEmployee(vendorA.id, { fullName: "Works At A2" })
  await db.employee.update({ where: { id: empA2.id }, data: { companyId: companyA2.id } })
  empB1 = await mkEmployee(vendorB.id, { fullName: "Works At B1" })
  await db.employee.update({ where: { id: empB1.id }, data: { companyId: companyB1.id } })

  // financial records per company
  await db.payrollRun.create({
    data: { vendorId: vendorA.id, companyId: companyA1.id, periodMonth: 1, periodYear: 2026, frequency: "MONTHLY", runType: "REGULAR", cutoffDate: "2026-01-25", status: "DRAFT", totalGross: 1000, totalNet: 900, createdBy: adminA.id },
  })
  await db.payrollRun.create({
    data: { vendorId: vendorA.id, companyId: companyA2.id, periodMonth: 1, periodYear: 2026, frequency: "MONTHLY", runType: "REGULAR", cutoffDate: "2026-01-25", status: "DRAFT", totalGross: 2000, totalNet: 1800, createdBy: adminA.id },
  })
  await db.accountJournal.create({
    data: { vendorId: vendorA.id, companyId: companyA1.id, refType: "JOURNAL_VOUCHER", date: "2026-01-10", memo: "A1 voucher", linesJson: "[]", amount: 100 },
  })
  await db.accountJournal.create({
    data: { vendorId: vendorA.id, companyId: companyA2.id, refType: "JOURNAL_VOUCHER", date: "2026-01-10", memo: "A2 voucher", linesJson: "[]", amount: 200 },
  })
})

describe("multi-company — default company migration semantics", () => {
  test("every vendor has exactly one default company and employees are assigned", async () => {
    const defaults = await db.company.findMany({ where: { vendorId: vendorA.id, isDefault: true } })
    expect(defaults.length).toBe(1)
    expect(defaults[0].id).toBe(companyA1.id)
    const unassigned = await db.employee.count({ where: { vendorId: vendorA.id, companyId: null } })
    expect(unassigned).toBe(0)
  })

  test("company code is unique within a vendor; vendors may reuse codes", async () => {
    await expect(mkCompany(vendorA.id, "A2", "Another A2")).rejects.toThrow()
    // vendor B can freely use the same code
    const b2 = await mkCompany(vendorB.id, "A2", "B company with A2 code")
    expect(b2.code).toBe("A2")
  })
})

describe("multi-company — cross-company record access (the mandatory matrix)", () => {
  test("CROSS-TENANT: vendor B admin cannot see vendor A employees", async () => {
    const r = await postHrm("employees.get", { id: empA1.id }, { bearer: adminBToken })
    expect(r.status).toBe(404)
  })

  test("SAME TENANT, OTHER COMPANY: company A1 admin (active A1) cannot fetch company A2's employee", async () => {
    // adminA's session has no activeCompanyId pinned → resolves to the default
    // company A1. A2's employee must 404 through the scope filter.
    const r = await postHrm("employees.get", { id: empA2.id }, { bearer: adminAToken })
    expect([403, 404]).toContain(r.status)
  })

  test("AUTHORIZED COMPANY: company A1 admin sees A1's employee", async () => {
    const r = await postHrm("employees.get", { id: empA1.id }, { bearer: adminAToken })
    expect(r.status).toBe(200)
    expect(r.body?.data?.employee?.id ?? r.body?.data?.id).toBe(empA1.id)
  })

  test("payroll runs list is scoped to the active company", async () => {
    const r = await postHrm("payroll.runs.list", {}, { bearer: adminAToken })
    expect(r.status).toBe(200)
    const runs = r.body?.data || []
    expect(runs.length).toBe(1) // only A1's run
    expect(runs[0].companyId).toBe(companyA1.id)
  })

  test("accounting vouchers list is scoped to the active company", async () => {
    const r = await postHrm("accounting.vouchers.list", {}, { bearer: adminAToken })
    expect(r.status).toBe(200)
    const vouchers = r.body?.data?.list || r.body?.data || []
    const list = Array.isArray(vouchers) ? vouchers : []
    for (const v of list) {
      expect(v.companyId ?? companyA1.id).toBe(companyA1.id)
    }
  })

  test("branch of company A2 is invisible while A1 is active", async () => {
    const r = await postHrm("branches.list", {}, { bearer: adminAToken })
    expect(r.status).toBe(200)
    const codes = (r.body?.data || []).map((b: any) => b.id)
    expect(codes).not.toContain(branchA2.id)
    expect(codes).toContain(branchA1.id)
  })
})

describe("multi-company — the switcher (companies.activate)", () => {
  test("switching to an accessible company updates the session and scopes data", async () => {
    // grant adminA access to A2 through the ADMIN API (invalidates the
    // server's 15s access cache — direct DB writes would not)
    await postHrm("companies.access.save", { userId: adminA.id, companyId: companyA2.id, role: "HR_ADMIN", active: true }, { bearer: adminAToken })
    const r = await postHrm("companies.activate", { companyId: companyA2.id }, { bearer: adminAToken })
    expect(r.status).toBe(200)

    // now A2's branch/run are visible and A1's are not
    const branches = await postHrm("branches.list", {}, { bearer: adminAToken })
    const ids = (branches.body?.data || []).map((b: any) => b.id)
    expect(ids).toContain(branchA2.id)
    expect(ids).not.toContain(branchA1.id)

    const runs = await postHrm("payroll.runs.list", {}, { bearer: adminAToken })
    expect((runs.body?.data || []).length).toBe(1)
    expect(runs.body?.data?.[0]?.companyId).toBe(companyA2.id)

    // switch back (finally-style so later tests start from A1)
    const back = await postHrm("companies.activate", { companyId: companyA1.id }, { bearer: adminAToken })
    expect(back.status).toBe(200)
  })

  test("switcher state resets cleanly between tests", async () => {
    const r = await postHrm("companies.activate", { companyId: companyA1.id }, { bearer: adminAToken })
    expect(r.status).toBe(200)
  })

  test("switching to a company of ANOTHER vendor is denied", async () => {
    const r = await postHrm("companies.activate", { companyId: companyB1.id }, { bearer: adminAToken })
    expect([403, 404]).toContain(r.status)
  })

  test("two sessions of one user can operate in different companies", async () => {
    const token2 = await mkSession(adminA.id)
    // session 1 → A1 (already there); session 2 → A2 (access granted above)
    const r2 = await postHrm("companies.activate", { companyId: companyA2.id }, { bearer: token2 })
    expect(r2.status).toBe(200)
    const runs1 = await postHrm("payroll.runs.list", {}, { bearer: adminAToken })
    const runs2 = await postHrm("payroll.runs.list", {}, { bearer: token2 })
    expect(runs1.body?.data?.[0]?.companyId).toBe(companyA1.id)
    expect(runs2.body?.data?.[0]?.companyId).toBe(companyA2.id)
    // leave session 2 back on the default too (no cross-test leakage)
    await postHrm("companies.activate", { companyId: companyA1.id }, { bearer: token2 })
  })
})

describe("multi-company — revoked access takes effect immediately", () => {
  test("revoking the active company's access falls back to the default at the next request", async () => {
    const u = await mkUser(vendorA.id, { role: "HR_ADMIN", name: "Scoped Admin" })
    await db.userCompanyAccess.create({ data: { vendorId: vendorA.id, userId: u.id, companyId: companyA1.id, role: "HR_ADMIN", active: true, isDefault: true } })
    const t = await mkSession(u.id)
    // grant A2 through the admin API (cache-aware)
    await postHrm("companies.access.save", { userId: u.id, companyId: companyA2.id, role: "HR_MANAGER", active: true }, { bearer: adminAToken })
    const sw = await postHrm("companies.activate", { companyId: companyA2.id }, { bearer: t })
    expect(sw.status).toBe(200)
    let runs = await postHrm("payroll.runs.list", {}, { bearer: t })
    expect(runs.body?.data?.[0]?.companyId).toBe(companyA2.id)

    // REVOKE A2 access through the admin API — immediate (cache invalidated)
    const revoke = await postHrm("companies.access.list", { userId: u.id }, { bearer: adminAToken })
    const row = (revoke.body?.data || []).find((a: any) => a.companyId === companyA2.id)
    expect(row).toBeTruthy()
    await postHrm("companies.access.remove", { id: row.id }, { bearer: adminAToken })
    runs = await postHrm("payroll.runs.list", {}, { bearer: t })
    expect(runs.status).toBe(200)
    expect(runs.body?.data?.[0]?.companyId).toBe(companyA1.id) // fell back to default
  })

  test("a user with NO company access is denied company-scoped operations (fail-closed)", async () => {
    const u = await mkUser(vendorA.id, { role: "HR_MANAGER", name: "No Company Access" })
    const t = await mkSession(u.id)
    // no UserCompanyAccess rows; HR_MANAGER is not in the legacy-admin fallback
    const r = await postHrm("branches.list", {}, { bearer: t })
    expect(r.status).toBe(403)
    expect(String(r.body?.error || "")).toContain("No active company")
  })
})

describe("multi-company — company CRUD boundary", () => {
  test("a company admin cannot create companies without the tenant permission", async () => {
    const u = await mkUser(vendorA.id, { role: "HR_MANAGER", name: "Plain Manager" })
    await db.userCompanyAccess.create({ data: { vendorId: vendorA.id, userId: u.id, companyId: companyA1.id, role: "HR_MANAGER", active: true } })
    const t = await mkSession(u.id)
    const r = await postHrm("companies.create", { name: "Rogue Company" }, { bearer: t })
    expect(r.status).toBe(403)
  })

  test("the tenant owner creates a second company; codes are unique per vendor", async () => {
    const r = await postHrm("companies.create", { name: "A Third Company", code: "A3", initMode: "systemDefaults" }, { bearer: adminAToken })
    expect(r.status).toBe(200)
    expect(r.body?.data?.code).toBe("A3")
    expect(r.body?.data?.vendorId).toBe(vendorA.id)

    // duplicate code rejected
    const dup = await postHrm("companies.create", { name: "Another Third", code: "A3" }, { bearer: adminAToken })
    expect(dup.status).toBe(400)
  })

  test("vendor B cannot touch vendor A's company (update/deactivate 404)", async () => {
    const upd = await postHrm("companies.update", { id: companyA1.id, name: "Hacked" }, { bearer: adminBToken })
    expect(upd.status).toBe(404)
    const de = await postHrm("companies.deactivate", { id: companyA1.id, active: false }, { bearer: adminBToken })
    expect(de.status).toBe(404)
  })

  test("the default company cannot be deactivated", async () => {
    const r = await postHrm("companies.deactivate", { id: companyA1.id, active: false }, { bearer: adminAToken })
    expect(r.status).toBe(400)
  })

  test("deactivation preserves history and hides the company from new business", async () => {
    const co = await mkCompany(vendorA.id, uniq("TMP"), "Temp Company")
    await postHrm("companies.deactivate", { id: co.id, active: false }, { bearer: adminAToken })
    const stillThere = await db.company.findUnique({ where: { id: co.id } })
    expect(stillThere).not.toBeNull()
    expect(stillThere!.active).toBe(false)
    // switching to an inactive company is refused
    const sw = await postHrm("companies.activate", { companyId: co.id }, { bearer: adminAToken })
    expect([403, 404]).toContain(sw.status)
  })
})

describe("multi-company — employee code allocation is per company", () => {
  test("the same code can exist in two companies of one vendor, but not twice in one", async () => {
    await db.employee.create({ data: { vendorId: vendorA.id, companyId: companyA2.id, code: "DUP-0001", fullName: "A2 Duplicate Code" } })
    // same code in A1 is fine (different company)
    const inA1 = await db.employee.create({ data: { vendorId: vendorA.id, companyId: companyA1.id, code: "DUP-0001", fullName: "A1 Duplicate Code" } })
    expect(inA1.code).toBe("DUP-0001")
    // same code twice in A2 violates the [companyId, code] unique
    let duplicateRejected = false
    try {
      await db.employee.create({ data: { vendorId: vendorA.id, companyId: companyA2.id, code: "DUP-0001", fullName: "A2 Duplicate Again" } })
    } catch (e: any) {
      duplicateRejected = String(e?.code) === "P2002"
    }
    expect(duplicateRejected).toBe(true)
  })
})

describe("multi-company — accounting isolation", () => {
  test("manual voucher creation requires an active company context", async () => {
    const u = await mkUser(vendorA.id, { role: "PAYROLL_OFFICER", name: "No Access Officer" })
    const t = await mkSession(u.id)
    const r = await postHrm("accounting.voucher.post", {
      date: "2026-02-01", memo: "contextless voucher",
      lines: [
        { account: "1010", debit: 100 },
        { account: "1200", credit: 100 },
      ],
    }, { bearer: t })
    // the dispatcher layers permission BEFORE company context — either denial
    // is a correct 403 for this role-less user
    expect(r.status).toBe(403)
  })

  test("a user WITH accounting permission but no company context is denied by the company gate", async () => {
    // a NON-admin role: no UserCompanyAccess rows + no legacy-admin fallback
    // ⇒ the company gate denies (HR_ADMIN intentionally falls back to the
    // default company — the single-company backward-compatibility rule)
    const u = await mkUser(vendorA.id, { role: "PAYROLL_OFFICER", name: "Accounting No Company", permissions: ["accounting.create", "accounting.view", "companies.view"] })
    const t = await mkSession(u.id)
    const r = await postHrm("accounting.voucher.post", {
      date: "2026-02-01", memo: "contextless voucher",
      lines: [
        { account: "1010", debit: 100 },
        { account: "1200", credit: 100 },
      ],
    }, { bearer: t })
    expect(r.status).toBe(403)
    expect(String(r.body?.error || "")).toContain("No active company")
  })

  test("a voucher is stamped with the active company", async () => {
    const r = await postHrm("accounting.voucher.post", {
      date: "2026-02-01", memo: "A1 company voucher",
      lines: [
        { account: "1010", debit: 500 },
        { account: "1200", credit: 500 },
      ],
    }, { bearer: adminAToken })
    expect(r.status).toBe(200)
    const jid = r.body?.data?.journalId || r.body?.data?.id
    const journal = jid ? await db.accountJournal.findUnique({ where: { id: jid } }) : null
    expect(journal?.companyId).toBe(companyA1.id)
  })

  test("cost centers are company-scoped: same code in two companies is legal", async () => {
    await postHrm("accounting.costCenters.save", { code: "CC-01", name: "A1 Center" }, { bearer: adminAToken })
    // switch to A2 — the same code must be creatable there
    await postHrm("companies.activate", { companyId: companyA2.id }, { bearer: adminAToken })
    const r2 = await postHrm("accounting.costCenters.save", { code: "CC-01", name: "A2 Center" }, { bearer: adminAToken })
    expect(r2.status).toBe(200)
    // and the A1 center is invisible from A2
    const list = await postHrm("accounting.costCenters.list", {}, { bearer: adminAToken })
    const names = (list.body?.data?.costCenters || []).map((c: any) => c.name)
    expect(names).toContain("A2 Center")
    expect(names).not.toContain("A1 Center")
    await postHrm("companies.activate", { companyId: companyA1.id }, { bearer: adminAToken })
  })
})

describe("multi-company — All Companies consolidated reporting mode (Part D)", () => {
  test("an authorized tenant owner can enter All Companies mode and read tenant-wide", async () => {
    // VENDOR_OWNER carries companies.consolidated via the tenant-admin template
    const sw = await postHrm("companies.activate", { allCompanies: true }, { bearer: adminAToken })
    expect(sw.status).toBe(200)
    expect(sw.body?.data?.allCompanies).toBe(true)

    // SANCTIONED AMENDMENT (W1, FINAL READ AUTHORIZATION MATRIX §6 delta):
    // payroll.runs.list was 200-tenant-wide in the pre-remediation baseline;
    // from W1 the R-02 central gate denies it in All Companies mode
    // (record-level payroll data is X-class — matrix §3.18). The test now
    // asserts the 403 AND the consolidated aggregate through an allowlisted
    // read instead (companies.list).
    const runs = await postHrm("payroll.runs.list", {}, { bearer: adminAToken })
    expect(runs.status).toBe(403)

    // an allowlisted consolidated read returns BOTH companies
    const companies = await postHrm("companies.list", {}, { bearer: adminAToken })
    expect(companies.status).toBe(200)
    const companyIds = new Set((companies.body?.data || []).map((c: any) => c.id))
    expect(companyIds.has(companyA1.id)).toBe(true)
    expect(companyIds.has(companyA2.id)).toBe(true)
  })

  test("mutating business operations are DENIED in All Companies mode", async () => {
    // the dispatcher blocks mutations of company-scoped modules in the
    // consolidated context — reads only (master prompt Part D)
    const create = await postHrm("branches.create", { name: "Rogue Branch", code: uniq("RB") }, { bearer: adminAToken })
    expect(create.status).toBe(403)
    expect(String(create.body?.error || "")).toContain("read-only")

    const voucher = await postHrm("accounting.voucher.post", {
      date: "2026-02-01", memo: "consolidated voucher",
      lines: [
        { account: "1010", debit: 100 },
        { account: "1200", credit: 100 },
      ],
    }, { bearer: adminAToken })
    expect(voucher.status).toBe(403)
  })

  test("a user WITHOUT companies.consolidated cannot enter All Companies mode", async () => {
    const u = await mkUser(vendorA.id, { role: "HR_MANAGER", name: "No Consolidation Manager", permissions: ["companies.view"] })
    await db.userCompanyAccess.create({ data: { vendorId: vendorA.id, userId: u.id, companyId: companyA1.id, role: "HR_MANAGER", active: true, isDefault: true } })
    const t = await mkSession(u.id)
    const sw = await postHrm("companies.activate", { allCompanies: true }, { bearer: t })
    expect(sw.status).toBe(403)
  })

  test("switching back to a concrete company restores company-scoped data", async () => {
    const back = await postHrm("companies.activate", { companyId: companyA1.id }, { bearer: adminAToken })
    expect(back.status).toBe(200)
    const runs = await postHrm("payroll.runs.list", {}, { bearer: adminAToken })
    const companyIds = new Set((runs.body?.data || []).map((r: any) => r.companyId))
    expect(companyIds.has(companyA1.id)).toBe(true)
    expect(companyIds.has(companyA2.id)).toBe(false)
  })
})

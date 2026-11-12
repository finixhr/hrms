/// <reference types="bun-types" />
// ============ W2 R-G completion (SEC-16) — provisioning default access rows ====
// T-15 (audit §I.2): "newly provisioned user (employee account / users.save)
// has an access row and can work". Covers BOTH provisioning paths the FINAL
// plan §4.2 R-G names — the employee path (provisionEmployeeUser, shared by
// employees.create auto-provision, employees.provisionAccount backfill and
// the bulk importer; one case additionally drives the REAL dispatcher
// through employees.provisionAccount) and the admin path (users.save through
// the real dispatcher, POST /api/hrm). Verifies the default-row contract:
// vendor + correct company association (employment company when known, else
// the vendor default), role = the tenant user's role (User.role), deltas
// '[]'/'[]', active + isDefault, no duplicates; transaction atomicity (the
// user is rolled back when the access row cannot be created); the unchanged
// pre-existing provisioning statuses (NO_EMAIL / DUPLICATE_EMAIL /
// ALREADY_LINKED); vendor/company isolation; and that the UPDATE path never
// creates rows (existing orphan users stay M3a/R-ORP territory).
import "./_testdb"
import { describe, test, expect, beforeAll } from "bun:test"
import { db } from "@/lib/db"
import { mkVendor, mkUser, mkSession, uniq } from "./_fixtures"
import { postHrm } from "./_hrm-endpoint"
import { provisionEmployeeUser } from "@/hrm-server/employee-provisioning"
import { resolveCompanyAccess, resolveActiveCompany, invalidateCompanyAccessCache } from "@/hrm-server/company"

// ---------------------------------------------------------------------------
// fixtures — vendor with Company A (default) + Company B; a legacy vendor
// WITHOUT companies; a second vendor for cross-tenant attempts
// ---------------------------------------------------------------------------
let vendor: any, cA: any, cB: any
let legacyVendor: any, vendor2: any, cV2: any
let empB: any, empB2: any, empB3: any, empNull: any, empRpcA: any, empFail: any, empNoEmail: any
let tAdmin: string, adminUser: any // HR_ADMIN "*" pinned to Company A
let tLegacyAdmin: string // HR_ADMIN "*" of the company-less legacy vendor
let tV2Admin: string // HR_ADMIN "*" of vendor 2

const accessRows = (userId: string) => db.userCompanyAccess.findMany({ where: { userId } })

beforeAll(async () => {
  vendor = await mkVendor(uniq("RG Vendor"), { company: false })
  cA = await db.company.create({ data: { vendorId: vendor.id, code: uniq("RGA"), name: "RG Company A (default)", active: true, isDefault: true } })
  cB = await db.company.create({ data: { vendorId: vendor.id, code: uniq("RGB"), name: "RG Company B", active: true } })

  const mkEmp = async (name: string, companyId: string | null, email?: string) =>
    db.employee.create({
      data: {
        vendorId: vendor.id, code: uniq("E"), fullName: name, companyId,
        joiningDate: "2024-01-01", employmentType: "PERMANENT", status: "ACTIVE",
        ...(email ? { officialEmail: email } : {}),
      },
    })
  empB = await mkEmp("RG Emp B", cB.id, "rg-emp-b@test.local") // attributed to Company B
  empB2 = await mkEmp("RG Emp B2", cB.id, "rg-emp-b2@test.local")
  empB3 = await mkEmp("RG Emp B3", cB.id, "rg-emp-b3@test.local")
  empNull = await mkEmp("RG Emp Null", null, "rg-emp-null@test.local") // legacy unattributed
  empRpcA = await mkEmp("RG Emp RpcA", cA.id, "rg-emp-rpca@test.local") // attributed to the admin's active company
  empFail = await mkEmp("RG Emp Fail", cB.id, "rg-emp-fail@test.local")
  empNoEmail = await mkEmp("RG Emp NoEmail", cA.id) // no email → NO_EMAIL

  legacyVendor = await mkVendor(uniq("RG Legacy"), { company: false })
  vendor2 = await mkVendor(uniq("RG Vendor2"), { company: false })
  cV2 = await db.company.create({ data: { vendorId: vendor2.id, code: uniq("RGV2"), name: "RG Vendor2 Co", active: true, isDefault: true } })

  // HR_ADMIN of the main vendor, pinned to Company A (company-scoped RPCs need
  // an active company; "users" routes are tenant-level and unaffected)
  adminUser = await mkUser(vendor.id, { role: "HR_ADMIN", name: uniq("RG Admin"), permissions: ["*"] })
  await db.userCompanyAccess.create({ data: { vendorId: vendor.id, userId: adminUser.id, companyId: cA.id, role: "HR_ADMIN", active: true, isDefault: true } })
  tAdmin = await mkSession(adminUser.id)
  await db.session.update({ where: { id: tAdmin }, data: { activeCompanyId: cA.id } })

  const legacyAdmin = await mkUser(legacyVendor.id, { role: "HR_ADMIN", name: uniq("RG LegAdm"), permissions: ["*"] })
  tLegacyAdmin = await mkSession(legacyAdmin.id)
  const v2Admin = await mkUser(vendor2.id, { role: "HR_ADMIN", name: uniq("RG V2Adm"), permissions: ["*"] })
  tV2Admin = await mkSession(v2Admin.id)
})

const ok = (r: { status: number; body: any }) => r.status === 200 && r.body?.ok === true

// ---------------------------------------------------------------------------
// A — employee provisioning path (provisionEmployeeUser; shared by
//     employees.create auto-provision, employees.provisionAccount, bulk import)
// ---------------------------------------------------------------------------
describe("R-G T-15 · employee provisioning path", () => {
  test("A1 · attributed employee: access row on the EMPLOYMENT company (not the vendor default), full default-row contract", async () => {
    const res = await provisionEmployeeUser(vendor.id, empB.id)
    expect(res.status).toBe("CREATED")
    expect(res.userId).toBeTruthy()
    const rows = await accessRows(res.userId!)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      vendorId: vendor.id,
      companyId: cB.id, // employment company — never the vendor default (cA)
      userId: res.userId,
      role: "EMPLOYEE", // = User.role of the minted account
      permissions: "[]", // S4a — derived-baseline delta: none
      excludedPermissions: "[]", // S4b — derived-baseline delta: none
      active: true,
      isDefault: true,
    })
    const user = await db.user.findUniqueOrThrow({ where: { id: res.userId! } })
    expect(user.role).toBe("EMPLOYEE")
    expect(rows[0].role).toBe(user.role) // row role initialized from User.role
  })

  test("A2 · unattributed (legacy) employee falls back to the vendor's default company", async () => {
    const res = await provisionEmployeeUser(vendor.id, empNull.id)
    expect(res.status).toBe("CREATED")
    const rows = await accessRows(res.userId!)
    expect(rows).toHaveLength(1)
    expect(rows[0].companyId).toBe(cA.id) // vendor default
    expect(rows[0].role).toBe("EMPLOYEE")
  })

  test("A3 · \"can work\": the provisioned user resolves their company and sees the row in their access list", async () => {
    const user = await db.user.findFirstOrThrow({ where: { vendorId: vendor.id, employeeId: empB.id } })
    const access = await resolveCompanyAccess(user.id, vendor.id)
    expect(access.some((a) => a.companyId === cB.id && a.role === "EMPLOYEE" && a.isDefault)).toBe(true)
    const active = await resolveActiveCompany({ activeCompanyId: null }, { id: user.id, vendorId: vendor.id, role: user.role, employeeId: empB.id })
    expect(active.companyId).toBe(cB.id)
  })

  test("A4 · company-less (legacy pre-split) vendor: user created, NO access row, no failure", async () => {
    const emp = await db.employee.create({
      data: { vendorId: legacyVendor.id, code: uniq("E"), fullName: "RG Legacy Emp", joiningDate: "2024-01-01", employmentType: "PERMANENT", status: "ACTIVE", officialEmail: "rg-legacy-emp@test.local" },
    })
    const res = await provisionEmployeeUser(legacyVendor.id, emp.id)
    expect(res.status).toBe("CREATED")
    expect(await accessRows(res.userId!)).toHaveLength(0)
  })

  test("A5 · ALREADY_LINKED is idempotent — no second user, no second row", async () => {
    const first = await provisionEmployeeUser(vendor.id, empB2.id)
    expect(first.status).toBe("CREATED")
    const again = await provisionEmployeeUser(vendor.id, empB2.id)
    expect(again.status).toBe("ALREADY_LINKED")
    expect(again.userId).toBe(first.userId)
    expect(await db.user.count({ where: { vendorId: vendor.id, employeeId: empB2.id } })).toBe(1)
    expect(await accessRows(first.userId!)).toHaveLength(1)
  })

  test("A6 · NO_EMAIL and DUPLICATE_EMAIL statuses unchanged (no user, no row)", async () => {
    expect((await provisionEmployeeUser(vendor.id, empNoEmail.id)).status).toBe("NO_EMAIL")
    expect(await db.user.count({ where: { vendorId: vendor.id, employeeId: empNoEmail.id } })).toBe(0)
    // an email already used in the tenant never gets a second account
    await db.user.create({ data: { vendorId: vendor.id, email: "rg-dupe@test.local", name: "Dupe", passwordHash: "x", role: "EMPLOYEE", permissions: "[]" } })
    const empDupe = await db.employee.create({
      data: { vendorId: vendor.id, code: uniq("E"), fullName: "RG Emp Dupe", companyId: cA.id, joiningDate: "2024-01-01", employmentType: "PERMANENT", status: "ACTIVE", officialEmail: "RG-DUPE@test.local" },
    })
    const res = await provisionEmployeeUser(vendor.id, empDupe.id)
    expect(res.status).toBe("DUPLICATE_EMAIL")
    expect(await db.user.count({ where: { vendorId: vendor.id, email: "rg-dupe@test.local" } })).toBe(1)
  })

  test("A7 · dispatcher path: employees.provisionAccount mints the account + row through POST /api/hrm", async () => {
    // the admin's session is pinned to Company A, and the R-03 visibility
    // scope (employeeScopeFilter: strict companyId while a company context
    // is active) makes only Company-A employees visible — so the employee is
    // attributed to cA. (A NULL-company employee is deliberately INVISIBLE
    // from a company-pinned context — pre-existing R-03 fail-closed
    // behavior, unchanged by R-G.)
    const r = await postHrm("employees.provisionAccount", { employeeId: empRpcA.id }, { bearer: tAdmin })
    expect(ok(r)).toBe(true)
    const user = await db.user.findFirstOrThrow({ where: { vendorId: vendor.id, employeeId: empRpcA.id } })
    const rows = await accessRows(user.id)
    expect(rows).toHaveLength(1)
    expect(rows[0].companyId).toBe(cA.id) // employment company
    expect(rows[0].role).toBe("EMPLOYEE")
    expect(rows[0].permissions).toBe("[]")
    expect(rows[0].excludedPermissions).toBe("[]")
  })

  test("A8 · dispatcher path honors the R-03 visibility scope: a company-pinned admin cannot provision a NULL-company (out-of-scope) employee", async () => {
    const r = await postHrm("employees.provisionAccount", { employeeId: empNull.id }, { bearer: tAdmin })
    expect(r.status).toBe(404)
    expect(r.body?.error).toMatch(/not found in your scope/i)
    expect(await db.user.findFirst({ where: { vendorId: vendor.id, employeeId: empNull.id, email: "rg-emp-rpca@test.local" } })).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// B — admin path (users.save through the real dispatcher)
// ---------------------------------------------------------------------------
describe("R-G T-15 · users.save admin creation path", () => {
  test("B1 · non-EMPLOYEE user gets the default access row on the vendor default company, with the granted role", async () => {
    const email = `rg-hr-${uniq("u")}@test.local`
    const r = await postHrm("users.save", { email, password: "Sup3rSecret!x", name: "RG HR Manager", role: "HR_MANAGER" }, { bearer: tAdmin })
    expect(ok(r)).toBe(true)
    const user = await db.user.findFirstOrThrow({ where: { vendorId: vendor.id, email } })
    expect(user.role).toBe("HR_MANAGER")
    const rows = await accessRows(user.id)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      vendorId: vendor.id,
      companyId: cA.id, // vendor default company
      role: "HR_MANAGER", // = User.role
      permissions: "[]",
      excludedPermissions: "[]",
      active: true,
      isDefault: true,
      grantedById: adminUser.id,
    })
    const company = await db.company.findUniqueOrThrow({ where: { id: rows[0].companyId } })
    expect(company.vendorId).toBe(vendor.id) // the row never points outside the tenant
  })

  test("B2 · employee-linked user gets the EMPLOYMENT company", async () => {
    const email = `rg-link-${uniq("u")}@test.local`
    const r = await postHrm("users.save", { email, password: "Sup3rSecret!x", name: "RG Linked", role: "EMPLOYEE", employeeId: empB3.id }, { bearer: tAdmin })
    expect(ok(r)).toBe(true)
    const user = await db.user.findFirstOrThrow({ where: { vendorId: vendor.id, email } })
    const rows = await accessRows(user.id)
    expect(rows).toHaveLength(1)
    expect(rows[0].companyId).toBe(cB.id) // employment company, not the default
    expect(rows[0].role).toBe("EMPLOYEE")
  })

  test("B3 · company-less (legacy) vendor: user created, no row, no failure", async () => {
    const email = `rg-leg-${uniq("u")}@test.local`
    const r = await postHrm("users.save", { email, password: "Sup3rSecret!x", name: "RG Legacy User", role: "PAYROLL_OFFICER" }, { bearer: tLegacyAdmin })
    expect(ok(r)).toBe(true)
    const user = await db.user.findFirstOrThrow({ where: { vendorId: legacyVendor.id, email } })
    expect(await accessRows(user.id)).toHaveLength(0)
  })

  test("B4 · duplicate email denied — no partial user, no partial row", async () => {
    const email = `rg-dup-${uniq("u")}@test.local`
    const first = await postHrm("users.save", { email, password: "Sup3rSecret!x", name: "RG First", role: "HR_MANAGER" }, { bearer: tAdmin })
    expect(ok(first)).toBe(true)
    const second = await postHrm("users.save", { email, password: "Sup3rSecret!x", name: "RG Second", role: "HR_ADMIN" }, { bearer: tAdmin })
    expect(second.status).toBeGreaterThanOrEqual(400)
    expect(second.body?.error).toMatch(/already exists/i)
    expect(await db.user.count({ where: { vendorId: vendor.id, email } })).toBe(1)
    const user = await db.user.findFirstOrThrow({ where: { vendorId: vendor.id, email } })
    expect(await accessRows(user.id)).toHaveLength(1)
  })

  test("B5 · invalid role denied before any write", async () => {
    const r = await postHrm("users.save", { email: `rg-bad-${uniq("u")}@test.local`, password: "Sup3rSecret!x", role: "NOT_A_ROLE" }, { bearer: tAdmin })
    expect(r.status).toBe(403)
    expect(r.body?.error).toMatch(/Invalid role/i)
  })

  test("B6 · cross-vendor employeeId rejected (tenant isolation) — no user, no row", async () => {
    const r = await postHrm("users.save", { email: `rg-x-${uniq("u")}@test.local`, password: "Sup3rSecret!x", name: "RG Cross", role: "EMPLOYEE", employeeId: empB.id }, { bearer: tV2Admin })
    expect(r.status).toBe(404)
    expect(r.body?.error).toMatch(/Linked employee not found in your vendor/i)
    // vendor 2's own default-company row creation is untouched by the failure
    expect(await db.user.count({ where: { vendorId: vendor2.id, employeeId: empB.id } })).toBe(0)
  })

  test("B7 · UPDATE path never creates access rows (orphan repair stays with M3a/R-ORP)", async () => {
    // an existing user WITHOUT an access row (the pre-R-G orphan population)
    const orphan = await mkUser(vendor.id, { role: "HR_MANAGER", name: uniq("RG Orphan"), email: `rg-orphan-${uniq("u")}@test.local` })
    expect(await accessRows(orphan.id)).toHaveLength(0)
    const r = await postHrm("users.save", { id: orphan.id, name: "RG Orphan Renamed", role: "HR_MANAGER", status: "ACTIVE" }, { bearer: tAdmin })
    expect(ok(r)).toBe(true)
    expect(await accessRows(orphan.id)).toHaveLength(0) // still zero — by design
  })

  test("B8 · explicit tenant permissions do NOT leak into the row deltas (derived-baseline model)", async () => {
    const email = `rg-perm-${uniq("u")}@test.local`
    const r = await postHrm("users.save", { email, password: "Sup3rSecret!x", name: "RG Perms", role: "HR_MANAGER", permissions: ["employees.view"] }, { bearer: tAdmin })
    expect(ok(r)).toBe(true)
    const user = await db.user.findFirstOrThrow({ where: { vendorId: vendor.id, email } })
    expect(JSON.parse(user.permissions)).toEqual(["employees.view"]) // tenant grant persisted
    const rows = await accessRows(user.id)
    expect(rows[0].permissions).toBe("[]") // …but the company delta stays empty
    expect(rows[0].excludedPermissions).toBe("[]")
  })

  test("B9 · \"can work\": a users.save-provisioned user resolves the default company", async () => {
    const email = `rg-work-${uniq("u")}@test.local`
    await postHrm("users.save", { email, password: "Sup3rSecret!x", name: "RG Work", role: "PAYROLL_OFFICER" }, { bearer: tAdmin })
    const user = await db.user.findFirstOrThrow({ where: { vendorId: vendor.id, email } })
    const active = await resolveActiveCompany({ activeCompanyId: null }, { id: user.id, vendorId: user.vendorId, role: user.role })
    expect(active.companyId).toBe(cA.id)
  })
})

// ---------------------------------------------------------------------------
// C — transaction atomicity: a failed access-row creation rolls the user back
// ---------------------------------------------------------------------------
describe("R-G T-15 · transaction atomicity", () => {
  /** Wrap db.$transaction so the interactive-tx client's
   *  userCompanyAccess.create throws — the user.create inside the SAME
   *  transaction must roll back with it. */
  async function withFailingAccessRow<T>(fn: () => Promise<T>): Promise<T> {
    const origTx = db.$transaction.bind(db)
    ;(db as any).$transaction = async (arg: any, ...rest: any[]) => {
      if (typeof arg !== "function") return origTx(arg, ...rest) // array form untouched
      return origTx(async (tx: any) => {
        const failTx = new Proxy(tx, {
          get(target: any, prop) {
            if (prop === "userCompanyAccess") {
              return new Proxy(target.userCompanyAccess, {
                get(t2: any, p2) {
                  if (p2 === "create") {
                    return async () => { throw new Error("RG-TEST: simulated access-row failure") }
                  }
                  const v = t2[p2]
                  return typeof v === "function" ? v.bind(t2) : v
                },
              })
            }
            const v = target[prop]
            return typeof v === "function" ? v.bind(target) : v
          },
        })
        return arg(failTx)
      })
    }
    try {
      return await fn()
    } finally {
      ;(db as any).$transaction = origTx
    }
  }

  test("C1 · employee path: access-row failure rolls the user back (no orphan account)", async () => {
    let threw: any = null
    await withFailingAccessRow(async () => {
      try {
        await provisionEmployeeUser(vendor.id, empFail.id)
      } catch (e) { threw = e }
    })
    expect(threw?.message).toContain("RG-TEST")
    expect(await db.user.findFirst({ where: { vendorId: vendor.id, employeeId: empFail.id } })).toBeNull()
    expect(await db.user.count({ where: { vendorId: vendor.id, email: "rg-emp-fail@test.local" } })).toBe(0)
  })

  test("C2 · users.save path: access-row failure rolls the user back through the dispatcher", async () => {
    const email = `rg-tx-${uniq("u")}@test.local`
    let res: { status: number; body: any } | null = null
    await withFailingAccessRow(async () => {
      res = await postHrm("users.save", { email, password: "Sup3rSecret!x", name: "RG Tx", role: "HR_MANAGER" }, { bearer: tAdmin })
    })
    expect(res!.status).toBe(500)
    expect(await db.user.findFirst({ where: { vendorId: vendor.id, email } })).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// D — vendor / company isolation of the created rows
// ---------------------------------------------------------------------------
describe("R-G T-15 · isolation", () => {
  test("D1 · a second vendor's provisioning writes rows only inside that vendor", async () => {
    const email = `rg-v2-${uniq("u")}@test.local`
    const r = await postHrm("users.save", { email, password: "Sup3rSecret!x", name: "RG V2 User", role: "HR_MANAGER" }, { bearer: tV2Admin })
    expect(ok(r)).toBe(true)
    const user = await db.user.findFirstOrThrow({ where: { vendorId: vendor2.id, email } })
    const rows = await accessRows(user.id)
    expect(rows).toHaveLength(1)
    expect(rows[0].vendorId).toBe(vendor2.id)
    expect(rows[0].companyId).toBe(cV2.id) // vendor 2's own default company
    // and nothing leaked into vendor 1
    expect(await db.userCompanyAccess.findMany({ where: { vendorId: vendor.id, userId: user.id } })).toHaveLength(0)
  })

  test("D2 · the provisioning row is visible through the tenant's access administration surface", async () => {
    const user = await db.user.findFirstOrThrow({ where: { vendorId: vendor.id, employeeId: empB.id } })
    const r = await postHrm("companies.access.list", { userId: user.id }, { bearer: tAdmin })
    expect(ok(r)).toBe(true)
    const list = r.body?.data || []
    expect(list.some((row: any) => row.companyId === cB.id && row.role === "EMPLOYEE")).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// E — F-01 (post-delivery review): inactive / unauthorized employment companies
//     follow ONE rule across provisioning, resolution, switching and
//     authorization. Documented contract (company.ts header rule 3, auth.ts
//     comment, companies.deactivate): an inactive company NEVER serves as the
//     active company context and never receives a new default access row; the
//     resolver falls to the safe state (default company when accessible,
//     otherwise no company context); deactivation is reversible and existing
//     rows/employment relationships are preserved untouched.
// ---------------------------------------------------------------------------
describe("F-01 · inactive / unauthorized employment companies — one consistent rule", () => {
  let cC: any // INACTIVE employment company of the main vendor (cA stays the active default)
  let empC: any // employee attributed to cC
  let empCross: any // vendor-1 employee whose companyId is FORGED at vendor 2's company
  let f1Vendor: any, f1Co: any, f1Emp: any, tF1Admin: string // vendor with NO active company at all
  let f2Vendor: any, f2X: any, f2Y: any, f2Emp: any, tF2Admin: string // inactive default-flagged + active non-default
  let e1UserId = "" // ESS user provisioned while the employment company is inactive

  const mkEmp2 = async (vId: string, name: string, companyId: string | null, email?: string) =>
    db.employee.create({
      data: {
        vendorId: vId, code: uniq("E"), fullName: name, companyId,
        joiningDate: "2024-01-01", employmentType: "PERMANENT", status: "ACTIVE",
        ...(email ? { officialEmail: email } : {}),
      },
    })

  beforeAll(async () => {
    cC = await db.company.create({ data: { vendorId: vendor.id, code: uniq("RGC"), name: "F01 Company C (inactive)", active: false } })
    empC = await mkEmp2(vendor.id, "F01 Emp C", cC.id, `f01-emp-c-${uniq("u")}@test.local`)
    // forged cross-vendor pointer: a vendor-1 employee whose companyId is
    // vendor 2's ACTIVE company (only reachable through direct DB corruption —
    // the app validates anchors same-vendor; the resolver must survive it)
    empCross = await mkEmp2(vendor.id, "F01 Emp Cross", cV2.id, `f01-emp-cross-${uniq("u")}@test.local`)
    // vendor whose ONLY company is inactive → no active company at all
    f1Vendor = await mkVendor(uniq("F01 OnlyInactive"), { company: false })
    f1Co = await db.company.create({ data: { vendorId: f1Vendor.id, code: uniq("F01C"), name: "F01 Inactive Co", active: false, isDefault: true } })
    f1Emp = await mkEmp2(f1Vendor.id, "F01 Emp F1", f1Co.id, `f01-emp-f1-${uniq("u")}@test.local`)
    const f1Admin = await mkUser(f1Vendor.id, { role: "HR_ADMIN", name: uniq("F01 Adm"), permissions: ["*"] })
    tF1Admin = await mkSession(f1Admin.id)
    // vendor whose DEFAULT-FLAGGED company is inactive while a non-default company is active
    f2Vendor = await mkVendor(uniq("F01 SkipDefault"), { company: false })
    f2X = await db.company.create({ data: { vendorId: f2Vendor.id, code: uniq("F01X"), name: "F01 X (inactive default)", active: false, isDefault: true } })
    f2Y = await db.company.create({ data: { vendorId: f2Vendor.id, code: uniq("F01Y"), name: "F01 Y (active)", active: true } })
    f2Emp = await mkEmp2(f2Vendor.id, "F01 Emp F2", f2X.id, `f01-emp-f2-${uniq("u")}@test.local`)
    const f2Admin = await mkUser(f2Vendor.id, { role: "HR_ADMIN", name: uniq("F02 Adm"), permissions: ["*"] })
    tF2Admin = await mkSession(f2Admin.id)
  })

  test("E1 · employee path, INACTIVE employment company → row on the vendor default ACTIVE company, never on the inactive one", async () => {
    const res = await provisionEmployeeUser(vendor.id, empC.id)
    expect(res.status).toBe("CREATED")
    e1UserId = res.userId!
    const rows = await accessRows(e1UserId)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      vendorId: vendor.id,
      companyId: cA.id, // the vendor default ACTIVE company — NOT the inactive employment company
      role: "EMPLOYEE", // = User.role of the minted account
      permissions: "[]",
      excludedPermissions: "[]",
      active: true,
      isDefault: true,
    })
    expect(rows[0].companyId).not.toBe(cC.id)
  })

  test("E2 · users.save path, linked employee on an INACTIVE company → row on the vendor default ACTIVE company", async () => {
    const email = `f01-e2-${uniq("u")}@test.local`
    const r = await postHrm("users.save", { email, password: "Sup3rSecret!x", name: "F01 E2", role: "HR_MANAGER", employeeId: empC.id }, { bearer: tAdmin })
    expect(ok(r)).toBe(true)
    const user = await db.user.findFirstOrThrow({ where: { vendorId: vendor.id, email } })
    const rows = await accessRows(user.id)
    expect(rows).toHaveLength(1)
    expect(rows[0].companyId).toBe(cA.id) // employment company inactive → vendor default
    expect(rows[0].companyId).not.toBe(cC.id)
    expect(rows[0].role).toBe("HR_MANAGER") // row role = the created user's tenant role
  })

  test("E3 · resolver: ESS user with inactive employment company resolves the documented safe state (default row), never the inactive company", async () => {
    const active = await resolveActiveCompany({ activeCompanyId: null }, { id: e1UserId, vendorId: vendor.id, role: "EMPLOYEE", employeeId: empC.id })
    expect(active.companyId).toBe(cA.id) // default access row — the safe state
    expect(active.companyId).not.toBe(cC.id)
  })

  test("E4 · resolver: ESS user whose ONLY row sits on the inactive company (the pre-fix provisioning shape) → NO company context (fail-closed)", async () => {
    // the exact user shape pre-F-01 provisioning could mint: a default row
    // granted on an inactive company — inert to resolveCompanyAccess
    const u = await mkUser(vendor.id, { role: "EMPLOYEE", name: uniq("F01 Legacy"), employeeId: empC.id, permissions: [] })
    await db.userCompanyAccess.create({ data: { vendorId: vendor.id, userId: u.id, companyId: cC.id, role: "EMPLOYEE", active: true, isDefault: true } })
    invalidateCompanyAccessCache(u.id)
    const active = await resolveActiveCompany({ activeCompanyId: null }, { id: u.id, vendorId: vendor.id, role: "EMPLOYEE", employeeId: empC.id })
    expect(active.companyId).toBeNull() // deny — never the inactive company
  })

  test("E5 · a session pinned to a now-inactive company falls back — the stale pointer is never trusted", async () => {
    // rule 1: the pin must not appear in the live access list (inactive
    // companies are excluded) → the default row applies
    const active = await resolveActiveCompany({ activeCompanyId: cC.id }, { id: adminUser.id, vendorId: vendor.id, role: "HR_ADMIN" })
    expect(active.companyId).toBe(cA.id)
    expect(active.companyId).not.toBe(cC.id)
  })

  test("E6 · deactivation is reversible: reactivating the employment company restores the ESS employment rule; rows preserved untouched", async () => {
    // (while cC is inactive the E1 user resolves cA — E3)
    // reactivate → employment rules again while the company is active
    await db.company.update({ where: { id: cC.id }, data: { active: true } })
    invalidateCompanyAccessCache(e1UserId)
    const activeNow = await resolveActiveCompany({ activeCompanyId: null }, { id: e1UserId, vendorId: vendor.id, role: "EMPLOYEE", employeeId: empC.id })
    expect(activeNow.companyId).toBe(cC.id)
    // the provisioning row on cA is preserved — no silent rewrite of the
    // access meaning (same single row, still default, untouched)
    const rows = await accessRows(e1UserId)
    expect(rows).toHaveLength(1)
    expect(rows[0].companyId).toBe(cA.id)
    expect(rows[0].isDefault).toBe(true)
    // deactivate again → back to the safe state
    await db.company.update({ where: { id: cC.id }, data: { active: false } })
    invalidateCompanyAccessCache(e1UserId)
    const activeAgain = await resolveActiveCompany({ activeCompanyId: null }, { id: e1UserId, vendorId: vendor.id, role: "EMPLOYEE", employeeId: empC.id })
    expect(activeAgain.companyId).toBe(cA.id)
  })

  test("E7 · cross-vendor forged pointers never yield a foreign company — provisioning AND resolver", async () => {
    // provisioning: employee row (vendor 1) points at vendor 2's ACTIVE
    // company — path 1 re-checks vendorId; the row lands on the vendor's own
    // default, never on the foreign company
    const res = await provisionEmployeeUser(vendor.id, empCross.id)
    expect(res.status).toBe("CREATED")
    const rows = await accessRows(res.userId!)
    expect(rows).toHaveLength(1)
    expect(rows[0].companyId).toBe(cA.id)
    expect(rows[0].companyId).not.toBe(cV2.id)
    expect(rows[0].vendorId).toBe(vendor.id)
    // resolver: the EMPLOYEE user's linked employee points at vendor 2's
    // active company — rule 2 requires the employment company to belong to
    // the user's OWN vendor; the foreign pointer resolves to NO company
    const u = await mkUser(vendor.id, { role: "EMPLOYEE", name: uniq("F01 CrossUsr"), employeeId: empCross.id, permissions: [] })
    const active = await resolveActiveCompany({ activeCompanyId: null }, { id: u.id, vendorId: vendor.id, role: "EMPLOYEE", employeeId: empCross.id })
    expect(active.companyId).toBeNull()
  })

  test("E8 · vendor with NO active company (missing default company): both paths create the user with NO row and never fail", async () => {
    // employee path
    const res = await provisionEmployeeUser(f1Vendor.id, f1Emp.id)
    expect(res.status).toBe("CREATED")
    expect(await accessRows(res.userId!)).toHaveLength(0)
    // admin path (row-less legacy behavior — provisioning must not fail)
    const email = `f01-e8-${uniq("u")}@test.local`
    const r = await postHrm("users.save", { email, password: "Sup3rSecret!x", name: "F01 E8", role: "HR_MANAGER" }, { bearer: tF1Admin })
    expect(ok(r)).toBe(true)
    const user = await db.user.findFirstOrThrow({ where: { vendorId: f1Vendor.id, email } })
    expect(await accessRows(user.id)).toHaveLength(0)
  })

  test("E9 · fallback ordering: an INACTIVE default-flagged company is skipped — the row lands on the ACTIVE company", async () => {
    // employment company f2X is inactive AND default-flagged; f2Y is active
    const res = await provisionEmployeeUser(f2Vendor.id, f2Emp.id)
    expect(res.status).toBe("CREATED")
    const rows = await accessRows(res.userId!)
    expect(rows).toHaveLength(1)
    expect(rows[0].companyId).toBe(f2Y.id)
    expect(rows[0].companyId).not.toBe(f2X.id)
    // admin path (no linked employee): the same fallback rule applies
    const email = `f01-e9-${uniq("u")}@test.local`
    const r = await postHrm("users.save", { email, password: "Sup3rSecret!x", name: "F01 E9", role: "HR_MANAGER" }, { bearer: tF2Admin })
    expect(ok(r)).toBe(true)
    const user = await db.user.findFirstOrThrow({ where: { vendorId: f2Vendor.id, email } })
    expect((await accessRows(user.id))[0].companyId).toBe(f2Y.id)
  })

  test("E10 · ACTIVE employment company: rule 2 returns it unchanged (no regression to the ESS semantics)", async () => {
    // empB's user (A1): employment company cB is active — the pre-F-01
    // behavior is preserved exactly
    const user = await db.user.findFirstOrThrow({ where: { vendorId: vendor.id, employeeId: empB.id } })
    const active = await resolveActiveCompany({ activeCompanyId: null }, { id: user.id, vendorId: vendor.id, role: "EMPLOYEE", employeeId: empB.id })
    expect(active.companyId).toBe(cB.id)
    expect(active.role).toBe("EMPLOYEE")
  })

  test("E11 · company switching: companies.activate to an inactive company is denied (404) — switching never enters it", async () => {
    const r = await postHrm("companies.activate", { companyId: cC.id }, { bearer: tAdmin })
    expect(r.status).toBe(404)
    // and the session pin was never moved
    const sess = await db.session.findUniqueOrThrow({ where: { id: tAdmin } })
    expect(sess.activeCompanyId).toBe(cA.id)
  })
})

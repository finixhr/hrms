/// <reference types="bun-types" />
// ============ Phase R5 — security & isolation hardening =======================
// SEC-01 mayMintTokensFor resolves the ROLE TEMPLATE (never "non-EMPLOYEE ⇒
//      entitled"); v1 user tokens carry the manager's org scope.
// API-01 the v1 password grant is throttled per resolved IP, writes
//      login-audit rows for every outcome, and resolves IPs through the
//      trust-gated resolver (never raw X-Forwarded-For).
// SEC-02 session tokens are hashed at rest (row ids are never credentials).
// DB-02 child-table rows carry their tenant; the structural unique rejects
//      duplicates; the migration's backfill statements restore vendorId.
// COM-01 announcements are audience-filtered for EMPLOYEE viewers.
// COM-03 the calendar hides colleagues' sensitive events from EMPLOYEE viewers.
// PAY-05 payroll lists honor the manager's branch/department scope.
// EMP-04 e-TIN rides the identity field group (masked) and never ships on
//      directory rows (the intended select list is live code now).
// EMP-10 hard delete is the employees.purge verb, separate from archive.
// ATT-019 devices.sync stamps status from the sweep outcome.
import "./_testdb"
import { describe, test, expect, beforeAll } from "bun:test"
import { db } from "@/lib/db"
import { mkVendor, mkUser, mkEmployee, mkBranch, uniq, mkSession } from "./_fixtures"
import { NextRequest } from "next/server"
import { POST as tokenRoute } from "@/app/api/v1/auth/token/route"
import { GET as employeesRoute } from "@/app/api/v1/employees/route"
import { getRoute } from "@/hrm-server/routes/router"
import { makeCtx } from "./_fixtures"
import { hashPasswordAsync, createSession, findSessionByToken, getCtxFromToken, sessionTokenHash, logout } from "@/hrm-server/auth"
import { getCalendarEvents } from "@/hrm-server/calendar"
import { callerFieldAccess, projectRecord } from "@/hrm-server/field-permissions"
import { getSettings, saveSettingsGroup } from "@/hrm-server/settings"

const PASSWORD = "R5Passw0rd!"

function v1req(url: string, opts: { bearer?: string; body?: unknown; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { ...(opts.headers || {}) }
  if (opts.bearer) headers.authorization = `Bearer ${opts.bearer}`
  const hasBody = opts.body != null
  if (hasBody) headers["content-type"] = "application/json"
  return new NextRequest(url, { method: hasBody ? "POST" : "GET", headers, ...(hasBody ? { body: JSON.stringify(opts.body) } : {}) } as any)
}

async function grant(body: unknown, headers?: Record<string, string>) {
  const res = await tokenRoute(v1req("http://localhost/api/v1/auth/token", { body, headers }) as any)
  return { status: res.status, json: await res.json().catch(() => null) }
}

beforeAll(async () => {
  // nothing global — every test builds its own tenant so the per-IP throttle
  // bucket (shared across this file) only matters in the throttle test, which
  // loops until 429 regardless of how many grants earlier tests consumed.
})

// ---------------------------------------------------------------------------
describe("SEC-01 — token minting resolves the ROLE TEMPLATE", () => {
  test("a BRANCH_MANAGER with default (empty) grants is REFUSED (was: self-minted tenant-wide access)", async () => {
    const v = await mkVendor("R5 SEC1 BM")
    const u = await mkUser(v.id, { role: "BRANCH_MANAGER", email: `r5bm-${uniq()}@test.example`, name: "R5 BM" })
    await db.user.update({ where: { id: u.id }, data: { passwordHash: await hashPasswordAsync(PASSWORD), passwordChangedAt: new Date() } })
    const out = await grant({ grant_type: "password", email: u.email, password: PASSWORD })
    expect(out.status).toBe(403)
    expect(out.json?.code).toBe("SCOPE_MISSING")
  })

  test("HR_ADMIN with default (empty) grants still passes (the template carries integrations.view)", async () => {
    const v = await mkVendor("R5 SEC1 HA")
    // HR_ADMIN defaults to MFA-required; a Role row with mfaRequired=false (and
    // no permissions list) disables that for this tenant while the EMPTY
    // permissions still fall through to the static template in roleTemplate().
    await db.role.create({ data: { vendorId: v.id, key: "HR_ADMIN", name: "HR Admin", mfaRequired: false } as any })
    const u = await mkUser(v.id, { role: "HR_ADMIN", email: `r5ha-${uniq()}@test.example`, name: "R5 HA" })
    await db.user.update({ where: { id: u.id }, data: { passwordHash: await hashPasswordAsync(PASSWORD), passwordChangedAt: new Date() } })
    const out = await grant({ grant_type: "password", email: u.email, password: PASSWORD })
    expect(out.status).toBe(200)
    expect(out.json?.data?.token_type).toBe("Bearer")
  })

  test("a custom DB Role row decides for custom roles (no integrations ⇒ refused; with ⇒ allowed)", async () => {
    const v = await mkVendor("R5 SEC1 CR")
    // custom role row WITHOUT integrations grants
    await db.role.create({ data: { vendorId: v.id, key: "REGIONAL_MGR", name: "Regional Manager", permissions: JSON.stringify(["dashboard.view", "employees.view"]) } as any })
    const noIntegrations = await mkUser(v.id, { role: "REGIONAL_MGR", email: `r5cr1-${uniq()}@test.example`, name: "R5 CR1" })
    await db.user.update({ where: { id: noIntegrations.id }, data: { passwordHash: await hashPasswordAsync(PASSWORD), passwordChangedAt: new Date() } })
    const refused = await grant({ grant_type: "password", email: noIntegrations.email, password: PASSWORD })
    expect(refused.status).toBe(403)

    // a SECOND custom role (distinct key — the role-row cache would serve the
    // first read for its TTL) WITH integrations.view → entitled
    await db.role.create({ data: { vendorId: v.id, key: "REGIONAL_MGR2", name: "Regional Manager II", permissions: JSON.stringify(["dashboard.view", "employees.view", "integrations.view"]) } as any })
    const entitledUser = await mkUser(v.id, { role: "REGIONAL_MGR2", email: `r5cr2-${uniq()}@test.example`, name: "R5 CR2" })
    await db.user.update({ where: { id: entitledUser.id }, data: { passwordHash: await hashPasswordAsync(PASSWORD), passwordChangedAt: new Date() } })
    const entitled = await grant({ grant_type: "password", email: entitledUser.email, password: PASSWORD })
    expect(entitled.status).toBe(200)
  })

  test("v1 user tokens carry the manager's org scope on the list surfaces (API keys stay tenant-wide)", async () => {
    const v = await mkVendor("R5 SEC1 scope")
    const b1 = await mkBranch(v.id, "Scope Branch One")
    const b2 = await mkBranch(v.id, "Scope Branch Two")
    const inBranch = await mkEmployee(v.id, { fullName: "Scoped Employee", branchId: b1.id })
    await mkEmployee(v.id, { fullName: "Other Branch Employee", branchId: b2.id })
    // a BRANCH_MANAGER carrying an EXPLICIT integrations.view grant (the minting
    // gate honors user-level grants) — their role stays BRANCH_MANAGER so the
    // v1 list surfaces scope to their linked branch, like the in-app surface
    const mgr = await mkUser(v.id, {
      role: "BRANCH_MANAGER", email: `r5sc-${uniq()}@test.example`, name: "R5 Scope Mgr", employeeId: inBranch.id,
      permissions: ["dashboard.view", "integrations.view", "employees.view", "attendance.view", "leave.view"],
    } as any)
    await db.user.update({ where: { id: mgr.id }, data: { passwordHash: await hashPasswordAsync(PASSWORD), passwordChangedAt: new Date() } })
    const out = await grant({ grant_type: "password", email: mgr.email, password: PASSWORD })
    expect(out.status).toBe(200)
    const token = out.json!.data.access_token as string

    // EMPLOYEE directory via the user token → only the manager's branch
    const res = await employeesRoute(v1req("http://localhost/api/v1/employees?pageSize=50", { bearer: token }) as any)
    expect(res.status).toBe(200)
    const body = await res.json()
    const names = (body.data as any[]).map((r: any) => r.fullName)
    expect(names).toContain("Scoped Employee")
    expect(names).not.toContain("Other Branch Employee")
  })
})

// ---------------------------------------------------------------------------
describe("API-01 — password-grant throttle, login-audit rows, trust-gated IP", () => {
  test("successful and failed grants write login-audit rows on the TENANT plane", async () => {
    const v = await mkVendor("R5 API1 audit")
    await db.role.create({ data: { vendorId: v.id, key: "HR_ADMIN", name: "HR Admin", mfaRequired: false } as any })
    const u = await mkUser(v.id, { role: "HR_ADMIN", email: `r5aud-${uniq()}@test.example`, name: "R5 Aud" })
    await db.user.update({ where: { id: u.id }, data: { passwordHash: await hashPasswordAsync(PASSWORD), passwordChangedAt: new Date() } })
    const ok = await grant({ grant_type: "password", email: u.email, password: PASSWORD })
    expect(ok.status).toBe(200)
    const bad = await grant({ grant_type: "password", email: u.email, password: "WrongPass99!" })
    expect(bad.status).toBe(401)
    const rows = await db.loginAuditLog.findMany({ where: { vendorId: v.id, email: u.email } })
    const successes = rows.filter((r) => r.success === true)
    const failures = rows.filter((r) => r.success === false)
    expect(successes.length).toBeGreaterThanOrEqual(1)
    expect(failures.some((r) => r.failureReason === "INVALID_CREDENTIALS")).toBe(true)
    await db.loginAuditLog.deleteMany({ where: { vendorId: v.id } })
  })

  test("X-Forwarded-For is honored ONLY behind a trusted proxy (never raw)", async () => {
    const v = await mkVendor("R5 API1 xff")
    await db.role.create({ data: { vendorId: v.id, key: "HR_ADMIN", name: "HR Admin", mfaRequired: false } as any })
    const u = await mkUser(v.id, { role: "HR_ADMIN", email: `r5xff-${uniq()}@test.example`, name: "R5 XFF" })
    await db.user.update({ where: { id: u.id }, data: { passwordHash: await hashPasswordAsync(PASSWORD), passwordChangedAt: new Date() } })
    const spoofed = "203.0.113.99"
    const prev = process.env.HRM_TRUST_PROXY
    try {
      // untrusted (default): the spoofed XFF must NOT reach the audit row
      process.env.HRM_TRUST_PROXY = "0"
      const untrusted = await grant({ grant_type: "password", email: u.email, password: PASSWORD }, { "x-forwarded-for": spoofed })
      expect(untrusted.status).toBe(200)
      const untrustedRows = await db.loginAuditLog.findMany({ where: { vendorId: v.id, email: u.email, success: true } })
      expect(untrustedRows.every((r) => r.ip !== spoofed)).toBe(true)

      // trusted: the XFF value IS the resolved client IP
      process.env.HRM_TRUST_PROXY = "1"
      const trusted = await grant({ grant_type: "password", email: u.email, password: PASSWORD }, { "x-forwarded-for": spoofed })
      expect(trusted.status).toBe(200)
      const trustedRows = await db.loginAuditLog.findMany({ where: { vendorId: v.id, email: u.email, success: true } })
      expect(trustedRows.some((r) => r.ip === spoofed)).toBe(true)
    } finally {
      if (prev === undefined) delete process.env.HRM_TRUST_PROXY
      else process.env.HRM_TRUST_PROXY = prev
    }
  })

  test("the per-IP throttle trips to 429 and leaves a RATE_LIMITED row", async () => {
    const v = await mkVendor("R5 API1 throttle")
    await db.role.create({ data: { vendorId: v.id, key: "HR_ADMIN", name: "HR Admin", mfaRequired: false } as any })
    const u = await mkUser(v.id, { role: "HR_ADMIN", email: `r5thr-${uniq()}@test.example`, name: "R5 Thr" })
    await db.user.update({ where: { id: u.id }, data: { passwordHash: await hashPasswordAsync(PASSWORD), passwordChangedAt: new Date() } })
    let saw429 = false
    // the bucket is shared per resolved IP across the whole file (10 / 5 min) —
    // loop until it trips; a fresh process needs the full 10+ calls.
    for (let i = 0; i < 25 && !saw429; i++) {
      const out = await grant({ grant_type: "password", email: u.email, password: "WrongPass99!" })
      if (out.status === 429) saw429 = true
    }
    expect(saw429).toBe(true)
    const rows = await db.loginAuditLog.findMany({ where: { vendorId: v.id, email: u.email, failureReason: "RATE_LIMITED" } })
    expect(rows.length).toBeGreaterThanOrEqual(1)
    // clean up: the platform-wide security-overview test (phase5-security-trust)
    // asserts offending-IP thresholds on the WHOLE login-audit table; this
    // file's failure rows must not tilt its fixtures.
    await db.loginAuditLog.deleteMany({ where: { vendorId: v.id } })
  })
})

// ---------------------------------------------------------------------------
describe("SEC-02 — session tokens hashed at rest", () => {
  test("createSession returns { token, id }; the row id is NEVER the credential; lookups resolve through the hash", async () => {
    const v = await mkVendor("R5 SEC02")
    const u = await mkUser(v.id, { role: "HR_ADMIN" })
    const s = await createSession({ id: u.id, vendorId: v.id })
    expect(typeof s.token).toBe("string")
    expect(typeof s.id).toBe("string")
    expect(s.id).not.toBe(s.token)
    const row = await db.session.findUniqueOrThrow({ where: { id: s.id } })
    expect(row.tokenHash).toBe(sessionTokenHash(s.token))
    // the credential authenticates
    const ctx = await getCtxFromToken(s.token)
    expect(ctx?.userId).toBe(u.id)
    // a leaked ROW ID presented as a token must NOT authenticate (this is the
    // read-only-DB-compromise scenario SEC-02 closes)
    const replay = await getCtxFromToken(row.id)
    expect(replay).toBeNull()
  })

  test("logout resolves through the hash and deletes the row; the token dies with it", async () => {
    const v = await mkVendor("R5 SEC02 out")
    const u = await mkUser(v.id, { role: "HR_ADMIN" })
    const s = await createSession({ id: u.id, vendorId: v.id })
    expect(await findSessionByToken(s.token)).toBeTruthy()
    await logout(s.token)
    expect(await findSessionByToken(s.token)).toBeNull()
    expect(await db.session.findUnique({ where: { id: s.id } })).toBeNull()
  })
})

// ---------------------------------------------------------------------------
describe("DB-02 — child tables carry their tenant", () => {
  test("the biodata section routes stamp vendorId on every child row (banks + family)", async () => {
    const v = await mkVendor("R5 DB02 sec")
    const emp = await mkEmployee(v.id, { fullName: "R5 DB02 Emp" })
    const admin = await mkUser(v.id, { role: "HR_ADMIN" })
    const ctx = makeCtx(admin, ["employees.view", "employees.edit", "bankInfo.view", "bankInfo.edit"])
    const created: any = await getRoute("employees.banks.create")!.handler(ctx, {
      employeeId: emp.id, holderName: "R5 Bank", bank: "DBBL", accountNumber: "1701204578001",
      paymentMethod: "BANK", accountType: "SALARY",
    })
    expect(created).toBeTruthy()
    const bankRow = await db.bankAccount.findFirstOrThrow({ where: { employeeId: emp.id, bank: "DBBL" } })
    expect(bankRow.vendorId).toBe(v.id)
    const fam: any = await getRoute("employees.family.create")!.handler(ctx, {
      employeeId: emp.id, name: "R5 Spouse", relationship: "Spouse",
    })
    expect(fam).toBeTruthy()
    const famRow = await db.familyMember.findFirstOrThrow({ where: { employeeId: emp.id } })
    expect(famRow.vendorId).toBe(v.id)
  })

  test("the structural unique (vendorId, loanId, no) rejects duplicate installment writes", async () => {
    const v = await mkVendor("R5 DB02 uniq")
    const emp = await mkEmployee(v.id, { fullName: "R5 Uniq Emp" })
    const loan = await db.loan.create({ data: { vendorId: v.id, employeeId: emp.id, principal: 5000, outstanding: 5000, status: "ACTIVE", startDate: "2026-01-01" } })
    await db.loanInstallment.create({ data: { vendorId: v.id, loanId: loan.id, no: 1, dueDate: "2026-02-01", amount: 500 } })
    let collided = false
    try {
      await db.loanInstallment.create({ data: { vendorId: v.id, loanId: loan.id, no: 1, dueDate: "2026-03-01", amount: 999 } })
    } catch { collided = true }
    expect(collided).toBe(true)
    // the same (loanId, no) under a DIFFERENT vendor stamp is a different key —
    // and a wrong-vendor row can never be created for this loan anyway
    const other = await db.loanInstallment.count({ where: { loanId: loan.id } })
    expect(other).toBe(1)
  })

  test("the migration's backfill statements restore vendorId from the parent (parsed from 9_wave9zl)", async () => {
    const v = await mkVendor("R5 DB02 backfill")
    const emp = await mkEmployee(v.id, { fullName: "R5 Backfill Emp" })
    const loan = await db.loan.create({ data: { vendorId: v.id, employeeId: emp.id, principal: 900, outstanding: 900, status: "ACTIVE", startDate: "2026-01-01" } })
    // simulate a pre-migration row: a placeholder stamp (the column is NOT NULL
    // post-migration, so the rotation story is "wrong/placeholder stamp repaired
    // from the parent by the migration's backfill statement")
    await db.loanInstallment.create({ data: { vendorId: "legacy-placeholder", loanId: loan.id, no: 1, dueDate: "2026-02-01", amount: 300 } })
    // run the EXACT backfill statement the migration ships (parsed from its SQL)
    const sql = await Bun.file("prisma/migrations/9_wave9zl_child_vendor_backfill_20261023/migration.sql").text()
    const stmt = sql.split("\n").find((l) => l.startsWith('UPDATE "LoanInstallment"'))
    expect(stmt).toBeTruthy()
    await db.$executeRawUnsafe(stmt!)
    const row = await db.loanInstallment.findFirstOrThrow({ where: { loanId: loan.id, no: 1 } })
    expect(row.vendorId).toBe(v.id)
  })
})

// ---------------------------------------------------------------------------
describe("COM-01 — announcements audience-filtered for EMPLOYEE viewers", () => {
  test("an EMPLOYEE sees ALL-branch notices and their own branch/department/person; other branches' stay hidden", async () => {
    const v = await mkVendor("R5 COM01")
    const b1 = await mkBranch(v.id, "COM01 Branch One")
    const b2 = await mkBranch(v.id, "COM01 Branch Two")
    const me = await mkEmployee(v.id, { fullName: "COM01 Me", branchId: b1.id })
    const other = await mkEmployee(v.id, { fullName: "COM01 Other", branchId: b2.id })
    const admin = await mkUser(v.id, { role: "HR_ADMIN" })
    const ctx = makeCtx(admin, ["announcements.view", "announcements.create"])
    for (const a of [
      { title: "All hands", audienceType: "ALL", audienceIds: [] as string[] },
      { title: "Branch One confidential", audienceType: "BRANCH", audienceIds: [b1.id] },
      { title: "Branch Two confidential", audienceType: "BRANCH", audienceIds: [b2.id] },
      { title: "For me only", audienceType: "SPECIFIC", audienceIds: [me.id] },
      { title: "For other only", audienceType: "SPECIFIC", audienceIds: [other.id] },
    ]) {
      await getRoute("announcements.create")!.handler(ctx, { title: a.title, body: "x", audienceType: a.audienceType, audienceIds: a.audienceIds, pinned: false })
    }
    // the EMPLOYEE persona (linked to b1) sees: ALL + b1 + own-person
    const empUser = await mkUser(v.id, { role: "EMPLOYEE", employeeId: me.id })
    const empFeed = (await getRoute("announcements.list")!.handler(makeCtx(empUser), {})) as any[]
    const titles = empFeed.map((a) => a.title)
    expect(titles).toContain("All hands")
    expect(titles).toContain("Branch One confidential")
    expect(titles).toContain("For me only")
    expect(titles).not.toContain("Branch Two confidential")
    expect(titles).not.toContain("For other only")
    // an HR_ADMIN still sees the full admin feed
    const adminFeed = (await getRoute("announcements.list")!.handler(ctx, {})) as any[]
    expect(adminFeed.map((a) => a.title)).toContain("Branch Two confidential")
  })
})

// ---------------------------------------------------------------------------
describe("COM-03 — calendar hides colleagues' sensitive events from EMPLOYEE viewers", () => {
  test("an EMPLOYEE viewer keeps company events but loses colleagues' loan/leave/contract events", async () => {
    const v = await mkVendor("R5 COM03")
    const me = await mkEmployee(v.id, { fullName: "COM03 Me" })
    const colleague = await mkEmployee(v.id, { fullName: "COM03 Colleague" })
    await db.employee.update({ where: { id: colleague.id }, data: { contractEnd: "2026-06-30" } as any })
    const now = new Date()
    const m = now.getMonth() + 1, y = now.getFullYear()
    await db.holiday.create({ data: { vendorId: v.id, name: "COM03 Founding Day", date: `2026-06-15`, type: "COMPANY" } })
    // colleague's contract expiry (June 2026) + my own contract expiry in June
    await db.employee.update({ where: { id: me.id }, data: { contractEnd: "2026-06-20" } as any })
    const all = await getCalendarEvents(v.id, 6, 2026)
    expect(all.some((e) => e.kind === "CONTRACT_EXPIRY" && e.employeeId === colleague.id)).toBe(true)
    expect(all.some((e) => e.kind === "CONTRACT_EXPIRY" && e.employeeId === me.id)).toBe(true)
    expect(all.some((e) => e.kind === "HOLIDAY")).toBe(true)
    // the EMPLOYEE scope: colleague's expiry disappears, mine + holidays stay
    const scoped = await getCalendarEvents(v.id, 6, 2026, { selfEmployeeId: me.id })
    expect(scoped.some((e) => e.kind === "CONTRACT_EXPIRY" && e.employeeId === colleague.id)).toBe(false)
    expect(scoped.some((e) => e.kind === "CONTRACT_EXPIRY" && e.employeeId === me.id)).toBe(true)
    expect(scoped.some((e) => e.kind === "HOLIDAY")).toBe(true)
    // m/y unused in this test beyond the full-view sanity check
    expect(m + y).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
describe("PAY-05 — payroll lists honor the manager scope", () => {
  test("a BRANCH_MANAGER reads only their branch's structures and entries", async () => {
    const v = await mkVendor("R5 PAY05")
    const b1 = await mkBranch(v.id, "PAY05 B1")
    const b2 = await mkBranch(v.id, "PAY05 B2")
    const mine = await mkEmployee(v.id, { fullName: "PAY05 Mine", branchId: b1.id })
    const theirs = await mkEmployee(v.id, { fullName: "PAY05 Theirs", branchId: b2.id })
    for (const e of [mine, theirs]) {
      await db.salaryStructure.create({ data: { vendorId: v.id, employeeId: e.id, gross: 30000, basic: 15000, effectiveFrom: "2026-01-01", status: "ACTIVE" } as any })
    }
    const run = await db.payrollRun.create({ data: { vendorId: v.id, periodMonth: 6, periodYear: 2026, frequency: "MONTHLY", status: "PAID" } as any })
    await db.payrollEntry.create({ data: { vendorId: v.id, runId: run.id, employeeId: mine.id, status: "INCLUDED", gross: 30000, net: 28000 } as any })
    await db.payrollEntry.create({ data: { vendorId: v.id, runId: run.id, employeeId: theirs.id, status: "INCLUDED", gross: 20000, net: 18000 } as any })
    const mgrUser = await mkUser(v.id, { role: "BRANCH_MANAGER", employeeId: mine.id })
    const mgr = makeCtx({ ...mgrUser, branchId: b1.id }, ["payroll.view"])
    const structs = (await getRoute("salaryStructures.list")!.handler(mgr, {})) as any[]
    expect(structs.every((s) => s.employeeId !== theirs.id)).toBe(true)
    expect(structs.some((s) => s.employeeId === mine.id)).toBe(true)
    const entries: any = await getRoute("payroll.entries")!.handler(mgr, { runId: run.id })
    const list = entries.items ?? entries.entries ?? entries
    expect(list.every((e: any) => e.employeeId !== theirs.id)).toBe(true)
    expect(list.some((e: any) => e.employeeId === mine.id)).toBe(true)
    // an HR_ADMIN still sees both
    const admin = makeCtx(await mkUser(v.id, { role: "HR_ADMIN" }), ["payroll.view"])
    const allStructs = (await getRoute("salaryStructures.list")!.handler(admin, {})) as any[]
    expect(allStructs.some((s) => s.employeeId === theirs.id)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
describe("EMP-04 — e-TIN is identity data (masked) and never ships on directory rows", () => {
  test("directory rows (employees.list) carry no taxTin / payout-config columns", async () => {
    const v = await mkVendor("R5 EMP04 list")
    await mkEmployee(v.id, { fullName: "EMP04 Dir Emp" })
    const admin = makeCtx(await mkUser(v.id, { role: "HR_ADMIN" }), ["employees.view"])
    const rows = (await getRoute("employees.list")!.handler(admin, {})) as any[]
    expect(rows.length).toBeGreaterThan(0)
    for (const r of rows) {
      expect("taxTin" in r).toBe(false)
      expect("salaryPayoutMethod" in r).toBe(false)
      expect("salaryPayoutAccountId" in r).toBe(false)
      expect("otEligible" in r).toBe(false)
    }
  })

  test("taxTin masks to last-4 under an identity mask rule (projectRecord, employment stays full)", () => {
    const access = callerFieldAccess({ fieldPermissions: { roles: { HR_ADMIN: { identity: "mask", contact: "mask", employment: "full" } } } } as any, "HR_ADMIN")
    const row: any = projectRecord({ taxTin: "123456789012", branchId: "b", mobile: "01712345678" } as any, access)
    expect(row.taxTin).toBe("•••• 9012")
    expect(String(row.mobile)).toContain("78") // contact masking unchanged (last digits stay)
    expect(row.branchId).toBe("b") // employment untouched by the reclassification
  })

  test("identity none nulls taxTin on the flat record", () => {
    const access = callerFieldAccess({ fieldPermissions: { roles: { HR_ADMIN: { identity: "none" } } } } as any, "HR_ADMIN")
    const row: any = projectRecord({ taxTin: "123456789012" } as any, access)
    expect(row.taxTin).toBeNull()
  })
})

// ---------------------------------------------------------------------------
describe("EMP-10 — hard delete is the employees.purge verb", () => {
  test("an employees.delete-only caller is refused; the admin templates carry purge", async () => {
    const v = await mkVendor("R5 EMP10")
    const emp = await mkEmployee(v.id, { fullName: "EMP10 Victim" })
    // through the REAL dispatcher — the perm gate lives there, not in the handler
    const { postHrm } = await import("./_hrm-endpoint")
    const deleteOnlyUser = await mkUser(v.id, { role: "HR_MANAGER", email: `r5emp10-${uniq()}@test.example`, name: "R5 Del", permissions: [] as string[] })
    await db.user.update({ where: { id: deleteOnlyUser.id }, data: { permissions: JSON.stringify(["employees.view", "employees.delete", "settings.view"]) } as any })
    const delSession = await mkSession(deleteOnlyUser.id, "FULL")
    const deniedRes = await postHrm("employees.hardDelete", { id: emp.id, confirm: emp.code }, { bearer: delSession })
    expect(deniedRes.status).toBe(403)
    expect(String(deniedRes.body?.error || "")).toContain("purge")
    // the admin template passes (HR_ADMIN carries employees.purge)
    const adminUser = await mkUser(v.id, { role: "HR_ADMIN", permissions: [] as string[] })
    await db.user.update({ where: { id: adminUser.id }, data: { permissions: JSON.stringify(["employees.view", "employees.purge", "settings.view", "attendance.view", "attendance.process"]) } as any })
    const adminSession = await mkSession(adminUser.id, "FULL")
    const okRes = await postHrm("employees.hardDelete", { id: emp.id, confirm: emp.code }, { bearer: adminSession })
    expect(okRes.status).toBe(200)
    expect(await db.employee.findUnique({ where: { id: emp.id } })).toBeNull()
  })

  test("the permission catalog exposes purge and ROLE_TEMPLATES grant it to admins only", async () => {
    const { ACTIONS, ROLE_TEMPLATES } = await import("@/hrm-server/types")
    expect(ACTIONS).toContain("purge")
    expect(ROLE_TEMPLATES.HR_ADMIN).toContain("employees.purge")
    expect(ROLE_TEMPLATES.VENDOR_OWNER).toContain("employees.purge")
    expect(ROLE_TEMPLATES.HR_MANAGER ?? []).not.toContain("employees.purge")
    expect(ROLE_TEMPLATES.BRANCH_MANAGER ?? []).not.toContain("employees.purge")
  })
})

// ---------------------------------------------------------------------------
describe("ATT-019 — devices.sync stamps status from the sweep outcome", () => {
  test("a sweep with failures leaves the device OFFLINE (was: stamped ONLINE)", async () => {
    const v = await mkVendor("R5 ATT019")
    const device = await db.attendanceDevice.create({ data: { vendorId: v.id, deviceId: uniq("D"), name: "ATT019 Device", status: "OFFLINE", syncStatus: "IDLE", lastSyncAt: new Date() } as any })
    // a raw event whose mapped employee no longer exists → the processor fails it
    await db.attendanceRawEvent.create({ data: {
      vendorId: v.id, deviceId: device.id, deviceSerial: device.deviceId, deviceUserId: "1",
      employeeId: "ghost-employee-id", eventTime: "2026-06-01 09:00:00", verifyMode: 1, attendanceStatus: 0,
      eventType: "IN", rawLine: "1\t2026-06-01 09:00:00\t1\t1\t0\t0",
      payloadHash: uniq("ph"), processingStatus: "RECEIVED",
    } as any })
    const admin = makeCtx(await mkUser(v.id, { role: "HR_ADMIN" }), ["attendance.view", "attendance.process"])
    await getRoute("attendance.devices.sync")!.handler(admin, { deviceId: device.id })
    const after = await db.attendanceDevice.findUniqueOrThrow({ where: { id: device.id } })
    expect(after.syncStatus).toBe("ERROR")
    expect(after.status).toBe("OFFLINE")
  })
})

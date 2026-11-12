/// <reference types="bun-types" />
// ============ W1-AC-01..04 — All Companies consolidated mode (R-02 / D-2) ============
// Acceptance groups W1-AC-01 (authorized reads), W1-AC-02 (denied reads,
// fail-closed), W1-AC-03 (central mutation denial incl. bypass routes) and
// W1-AC-04 (sensitive response-field redaction) — driven through the REAL
// dispatcher (postHrm — the production traffic path), per the W1 acceptance
// definitions. 24 tests.
import "./_testdb"
import { describe, test, expect, beforeAll } from "bun:test"
import { db } from "@/lib/db"
import { mkVendor, mkUser, mkEmployee, mkSession, uniq } from "./_fixtures"
import { postHrm } from "./_hrm-endpoint"
import { ensureDefaultCompany } from "@/hrm-server/company"
import { MC_MUTATION_EXCEPTIONS, MC_CONSOLIDATED_READ_ALLOWLIST } from "@/app/api/hrm/route"
import { isConsolidatedReportAction, isPiiReportKey } from "@/hrm-server/routes/reports"

let vendor: any
let companyA: any, companyB: any
let owner: any
let ownerToken: string

async function mkCompany(vendorId: string, code: string, name: string) {
  return db.company.create({ data: { vendorId, code, name, active: true } })
}

beforeAll(async () => {
  vendor = await mkVendor(uniq("W1AC Vendor"), { company: false })
  const defA = await ensureDefaultCompany(vendor.id, { name: "W1 Main" })
  companyA = await db.company.findUniqueOrThrow({ where: { id: defA } })
  companyB = await mkCompany(vendor.id, uniq("AC2"), "W1 Company Two")
  owner = await mkUser(vendor.id, { role: "VENDOR_OWNER", name: "W1 Owner" })
  ownerToken = await mkSession(owner.id)
  await db.userCompanyAccess.create({
    data: { vendorId: vendor.id, userId: owner.id, companyId: companyA.id, role: "VENDOR_OWNER", active: true, isDefault: true },
  })
  // an employee in EACH company (record-level surface probes)
  for (const c of [companyA, companyB]) {
    const e = await mkEmployee(vendor.id, { fullName: `Emp ${c.code}` })
    await db.employee.update({ where: { id: e.id }, data: { companyId: c.id } })
  }
  // attributed audit rows in both companies (redaction probes)
  for (const c of [companyA, companyB]) {
    await db.auditLog.create({
      data: {
        vendorId: vendor.id, companyId: c.id, userId: owner.id, userName: "W1 Owner",
        action: "settings.update", entity: "HrSetting", entityId: uniq("s"),
        summary: `attributed row for ${c.code}`,
        oldValue: JSON.stringify({ secret: `old-${c.code}` }),
        newValue: JSON.stringify({ secret: `new-${c.code}` }),
        reason: `reason-${c.code}`,
      },
    })
  }
  // a secret-bearing background job (jobs.list redaction probe)
  await db.bgJob.create({
    data: {
      vendorId: vendor.id,
      type: "COMMUNICATION_SEND",
      payloadJson: JSON.stringify({ secret: `payload-${uniq("p")}` }),
      resultJson: JSON.stringify({ secret: `result-${uniq("r")}` }),
      status: "DONE",
    },
  })
})

// ---------------------------------------------------------------------------
// W1-AC-01 — authorized reads in All Companies mode
// ---------------------------------------------------------------------------
describe("W1-AC-01 — All Companies authorized reads", () => {
  test("mode entry as VENDOR_OWNER returns 200 and the mode flag", async () => {
    const sw = await postHrm("companies.activate", { allCompanies: true }, { bearer: ownerToken })
    expect(sw.status).toBe(200)
    expect(sw.body?.data?.allCompanies).toBe(true)
  })

  test("auth.me marks the session as mode context", async () => {
    const me = await postHrm("auth.me", {}, { bearer: ownerToken })
    expect(me.status).toBe(200)
    expect(me.body?.data?.company?.allCompaniesMode).toBe(true)
  })

  test("a consolidated directory read returns BOTH companies", async () => {
    const list = await postHrm("companies.list", {}, { bearer: ownerToken })
    expect(list.status).toBe(200)
    const ids = new Set((list.body?.data || []).map((c: any) => c.id))
    expect(ids.has(companyA.id)).toBe(true)
    expect(ids.has(companyB.id)).toBe(true)
  })

  test("a non-PII registered report runs tenant-wide across both companies (and its CSV twin)", async () => {
    const rep = await postHrm("reports.employees", {}, { bearer: ownerToken })
    expect(rep.status).toBe(200)
    const csv = await postHrm("reports.employeesCsv", {}, { bearer: ownerToken })
    expect(csv.status).toBe(200)
    expect(typeof csv.body?.data?.csv).toBe("string")
  })

  test("full allowlist sweep: every one of the 62 entries is admitted in mode (no R-02 403)", async () => {
    for (const action of MC_CONSOLIDATED_READ_ALLOWLIST) {
      const r = await postHrm(action, {}, { bearer: ownerToken })
      expect(r.status).not.toBe(403)
    }
  })

  test("strict-200 allowlist surfaces answer 200 in mode (27 core surfaces)", async () => {
    const strict200 = [
      "auth.me", "companies.list", "companies.options", "companies.get", "companies.access.list",
      "roles.list", "roles.templates", "messageTemplates.list", "workflows.list",
      "notifications.list", "notifications.unreadCount", "users.list", "sessions.list",
      "settings.get", "jobs.list", "jobs.scheduled", "audit.list", "audit.logins.list",
      "dashboard.stats", "reports.templates.list", "accounting.periods.list",
      "push.list", "push.publicKey", "onboarding.status", "auth.password.policy",
      "subscription.overview", "subscription.usage",
    ]
    for (const action of strict200) {
      // companies.get needs an id (its 400-without-id is handler validation,
      // not a gate denial — admission is the gate's contract)
      const payload = action === "companies.get" ? { id: companyA.id } : {}
      const r = await postHrm(action, payload, { bearer: ownerToken })
      expect(`${action}: ${r.status}`).toBe(`${action}: 200`)
    }
  })

  test("reads OUTSIDE the allowlist are unreachable in mode (the R-02 mode denial)", async () => {
    for (const action of ["employees.list", "payroll.runs.list", "branches.list", "jobs.get", "tasks.list", "ess.profile"]) {
      const r = await postHrm(action, {}, { bearer: ownerToken })
      expect(r.status).toBe(403)
    }
  })
})

// ---------------------------------------------------------------------------
// W1-AC-02 — denied reads (fail-closed)
// ---------------------------------------------------------------------------
describe("W1-AC-02 — All Companies denied reads (fail-closed, D-2)", () => {
  test("D-2: an HR_ADMIN explicitly holding companies.consolidated is REFUSED mode entry", async () => {
    const u = await mkUser(vendor.id, {
      role: "HR_ADMIN", name: "HR Admin With Consolidated",
      permissions: ["companies.view", "companies.consolidated"],
    })
    await db.userCompanyAccess.create({
      data: { vendorId: vendor.id, userId: u.id, companyId: companyA.id, role: "HR_ADMIN", active: true, isDefault: true },
    })
    const t = await mkSession(u.id)
    const sw = await postHrm("companies.activate", { allCompanies: true }, { bearer: t })
    expect(sw.status).toBe(403)
    expect(String(sw.body?.error || "")).toContain("tenant owner only")
  })

  test("a user WITHOUT companies.consolidated is refused mode entry", async () => {
    const u = await mkUser(vendor.id, { role: "HR_MANAGER", name: "No Consolidation", permissions: ["companies.view"] })
    await db.userCompanyAccess.create({
      data: { vendorId: vendor.id, userId: u.id, companyId: companyA.id, role: "HR_MANAGER", active: true, isDefault: true },
    })
    const t = await mkSession(u.id)
    const sw = await postHrm("companies.activate", { allCompanies: true }, { bearer: t })
    expect(sw.status).toBe(403)
  })

  test("a FORGED session flag dissolves at the next request (per-request D-2 re-check)", async () => {
    const u = await mkUser(vendor.id, {
      role: "HR_ADMIN", name: "Forged Flag Admin",
      permissions: ["companies.view", "companies.consolidated", "organization.view"],
    })
    await db.userCompanyAccess.create({
      data: { vendorId: vendor.id, userId: u.id, companyId: companyA.id, role: "HR_ADMIN", active: true, isDefault: true },
    })
    const t = await mkSession(u.id)
    // forge: set the mode flag DIRECTLY on the session row for a non-owner
    await db.session.update({ where: { tokenHash: (await import("@/hrm-server/auth")).sessionTokenHash(t) }, data: { allCompaniesMode: true } })

    // the next request dissolves the mode: a normal company-scoped read (200,
    // C's company only) — never a consolidated context
    const branches = await postHrm("branches.list", {}, { bearer: t })
    expect(branches.status).toBe(200)
    const me = await postHrm("auth.me", {}, { bearer: t })
    expect(me.body?.data?.company?.allCompaniesMode === true).toBe(false)
  })

  test("denial bodies carry no data, no row counts, no record ids", async () => {
    const r = await postHrm("employees.list", {}, { bearer: ownerToken })
    expect(r.status).toBe(403)
    expect(r.body?.data).toBeUndefined()
    expect(String(r.body?.error || "")).not.toMatch(/\d+ (employees|rows|records)/i)
  })
})

// ---------------------------------------------------------------------------
// W1-AC-03 — central mutation denial (incl. direct RPC bypass attempts)
// ---------------------------------------------------------------------------
describe("W1-AC-03 — All Companies mutation denial (central, def.perm-independent)", () => {
  test("company-scoped mutations are denied with the read-only message", async () => {
    for (const [action, payload] of [
      ["branches.create", { name: "Rogue", code: uniq("RB") }],
      ["employees.create", { fullName: "Rogue Emp", code: uniq("RE"), mobile: "01700000000" }],
      ["shifts.create", { name: "Rogue Shift", startTime: "09:00", endTime: "17:00" }],
      ["accounting.voucher.post", { date: "2026-02-01", memo: "x", lines: [{ account: "1010", debit: 100 }, { account: "1200", credit: 100 }] }],
      ["tasks.save", { title: "Rogue Task" }],
    ] as const) {
      const r = await postHrm(action, payload as any, { bearer: ownerToken })
      expect(`${action}: ${r.status}`).toBe(`${action}: 403`)
      expect(String(r.body?.error || "")).toContain("read-only")
    }
  })

  test("SEC-12/13/15 bypass attempts (modules OUTSIDE the old gate) are denied by the CENTRAL gate", async () => {
    for (const [action, payload] of [
      ["users.save", { name: "Rogue User" }],
      ["messageTemplates.save", { name: "Rogue Template", body: "x" }],
      ["announcements.create", { title: "Rogue Announcement", message: "x" }],
    ] as const) {
      const r = await postHrm(action, payload as any, { bearer: ownerToken })
      expect(`${action}: ${r.status}`).toBe(`${action}: 403`)
    }
  })

  test("no-perm routes are covered: mutating no-perm route -> read-only 403; read no-perm route not allowlisted -> mode 403", async () => {
    const render = await postHrm("analytics.report.render", {}, { bearer: ownerToken })
    expect(render.status).toBe(403)
    expect(String(render.body?.error || "")).toContain("read-only")
    const tasks = await postHrm("tasks.list", {}, { bearer: ownerToken })
    expect(tasks.status).toBe(403)
    expect(String(tasks.body?.error || "")).toContain("not available in All Companies mode")
  })

  test("the session/self mutation exceptions work in mode (notifications.read, push.registerDevice)", async () => {
    const n = await postHrm("notifications.read", { all: true }, { bearer: ownerToken })
    expect(n.status).toBe(200)
    const p = await postHrm("push.registerDevice", { token: `expo-token-${uniq("t")}`, platform: "expo" }, { bearer: ownerToken })
    expect(p.status).toBe(200)
  })

  test("auth.logout and companies.activate (exit) work on dedicated sessions in mode", async () => {
    const t1 = await mkSession(owner.id)
    await postHrm("companies.activate", { allCompanies: true }, { bearer: t1 })
    const out = await postHrm("auth.logout", {}, { bearer: t1 })
    expect(out.status).toBe(200)

    const t2 = await mkSession(owner.id)
    await postHrm("companies.activate", { allCompanies: true }, { bearer: t2 })
    const exit = await postHrm("companies.activate", { companyId: companyA.id }, { bearer: t2 })
    expect(exit.status).toBe(200)
    expect(exit.body?.data?.allCompanies).toBe(false)
  })

  test("the mutation exception list equals EXACTLY the approved 8-entry set", () => {
    expect([...MC_MUTATION_EXCEPTIONS].sort()).toEqual([
      "auth.logout",
      "auth.password.change",
      "companies.activate",
      "notifications.read",
      "push.registerDevice",
      "push.subscribe",
      "push.unregisterDevice",
      "push.unsubscribe",
    ].sort())
    // none of the exceptions is a business-data action
    for (const e of MC_MUTATION_EXCEPTIONS) {
      expect(isConsolidatedReportAction(e)).toBe(false)
    }
  })

  test("after switching back to a concrete company, mutations succeed again", async () => {
    const t = await mkSession(owner.id)
    await postHrm("companies.activate", { allCompanies: true }, { bearer: t })
    const denied = await postHrm("branches.create", { name: "After Switch", code: uniq("AS") }, { bearer: t })
    expect(denied.status).toBe(403)
    const back = await postHrm("companies.activate", { companyId: companyA.id }, { bearer: t })
    expect(back.status).toBe(200)
    const ok = await postHrm("branches.create", { name: "After Switch", code: uniq("AS") }, { bearer: t })
    expect(ok.status).toBe(200)
  })
})

// ---------------------------------------------------------------------------
// W1-AC-04 — sensitive response-field redaction
// ---------------------------------------------------------------------------
describe("W1-AC-04 — sensitive response-field redaction in mode", () => {
  test("audit.list in mode is metadata-only: oldValue/newValue/reason absent on EVERY item, both companies visible", async () => {
    const r = await postHrm("audit.list", { limit: 200 }, { bearer: ownerToken })
    expect(r.status).toBe(200)
    const items = r.body?.data?.items || []
    expect(items.length).toBeGreaterThan(0)
    const attributed = items.filter((i: any) => i.summary?.startsWith("attributed row for"))
    expect(attributed.length).toBe(2) // both companies' rows — aggregate visibility
    for (const item of items) {
      expect(item.oldValue).toBeUndefined()
      expect(item.newValue).toBeUndefined()
      expect(item.reason).toBeUndefined()
    }
  })

  test("audit.list in CONCRETE mode keeps the full row shape (unchanged behavior)", async () => {
    const t = await mkSession(owner.id)
    await postHrm("companies.activate", { companyId: companyA.id }, { bearer: t })
    const r = await postHrm("audit.list", { limit: 200 }, { bearer: t })
    expect(r.status).toBe(200)
    // the audit trail is vendor-wide by design (unchanged pre-W1 behavior);
    // the CONTRACT here is the SHAPE: full rows incl. diffs in concrete mode
    const withDiffs = (r.body?.data?.items || []).filter((i: any) => i.summary?.startsWith("attributed row for"))
    expect(withDiffs.length).toBe(2)
    for (const item of withDiffs) {
      expect(item.oldValue !== undefined).toBe(true)
      expect(item.newValue !== undefined).toBe(true)
    }
  })

  test("audit.export carries the CompanyId column (8 columns) and exports attributed company ids", async () => {
    const r = await postHrm("audit.export", {}, { bearer: ownerToken })
    expect(r.status).toBe(200)
    const csv: string = r.body?.data?.csv || ""
    const header = csv.split("\n")[0]
    expect(header.split(",").length).toBe(8)
    expect(header).toContain("CompanyId")
    const rows = csv.split("\n").slice(1)
    const attributed = rows.filter((l) => l.includes("attributed row for"))
    expect(attributed.length).toBe(2)
    expect(attributed.some((l) => l.includes(companyA.id))).toBe(true)
    expect(attributed.some((l) => l.includes(companyB.id))).toBe(true)
  })

  test("jobs.list in mode never selects payloadJson/resultJson (seeded secret leaks nothing)", async () => {
    const r = await postHrm("jobs.list", {}, { bearer: ownerToken })
    expect(r.status).toBe(200)
    const jobs = r.body?.data?.jobs || r.body?.data?.items || r.body?.data || []
    const list = Array.isArray(jobs) ? jobs : []
    for (const j of list) {
      expect(j.payloadJson).toBeUndefined()
      expect(j.resultJson).toBeUndefined()
    }
    const raw = JSON.stringify(r.body)
    expect(raw).not.toContain("payload-")
    expect(raw).not.toContain("result-")
  })

  test("the reports lane is strict: registered non-PII keys parse, PII keys and tricks do not (unit contract)", () => {
    expect(isConsolidatedReportAction("reports.employees")).toBe(true)
    expect(isConsolidatedReportAction("reports.employeesCsv")).toBe(true)
    expect(isConsolidatedReportAction("reports.employeesBiodata")).toBe(true) // registered — but PII, denied in-handler
    expect(isPiiReportKey("employeesBiodata")).toBe(true)
    expect(isConsolidatedReportAction("reports.employeesBiodataCsv")).toBe(true)
    // unregistered keys, dotted sub-keys, suffix tricks, non-report families
    expect(isConsolidatedReportAction("reports.notARegisteredKey")).toBe(false)
    expect(isConsolidatedReportAction("reports.a.b")).toBe(false)
    expect(isConsolidatedReportAction("reports.employeesX")).toBe(false)
    expect(isConsolidatedReportAction("reportsX.employees")).toBe(false)
    expect(isConsolidatedReportAction("employees.list")).toBe(false)
  })

  test("PII reports are denied in mode through the dispatcher (both twins); record-level surfaces denied entirely", async () => {
    const bio = await postHrm("reports.employeesBiodata", {}, { bearer: ownerToken })
    expect(bio.status).toBe(403)
    expect(String(bio.body?.error || "")).toContain("not available in All Companies mode")
    const bioCsv = await postHrm("reports.employeesBiodataCsv", { confirm: "EXPORT" }, { bearer: ownerToken })
    expect(bioCsv.status).toBe(403)
    for (const action of ["employees.list", "employees.get", "search.global"]) {
      const r = await postHrm(action, action === "employees.get" ? { id: "any" } : {}, { bearer: ownerToken })
      expect(`${action}: ${r.status}`).toBe(`${action}: 403`)
    }
  })
})

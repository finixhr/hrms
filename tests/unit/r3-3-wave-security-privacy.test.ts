/// <reference types="bun-types" />
// ============ R3-3 Wave — security, privacy & entitlements ============
// SUB-103   jobs.get public + raw resultJson (salary sheet leak)         → perm + per-type result redaction
// FLD-101   salary structure/revisions on the wire to every viewer       → server-side payroll.view projection
// FLD-102   NID / identity doc numbers unmasked                          → last-4 mask + employeeDocs.reveal
// SUB-101   apiAccess plan flag never enforced (dead entitlement)        → MODULE_FEATURE_GATES + authenticateApiKey gate
// SUB-102   /api/v1 write scopes bypass the read-only lockout            → 423 SUBSCRIPTION_READONLY on write scopes
// RPT-001   scheduled report delivery bypasses the bulk-PII gate         → reports.pii + member recipients (save + run)
// RPT-002   PII export gate broken client-side                          → typed confirm (EXPORT) + XLSX gated on reports.pii
// AI-001    ai.reportAsk renders with a synthetic HR_ADMIN ctx           → caller-scope render + reports.view gate
// AI-002    ai.settings.save gated only by ai.generate                  → settings.edit
// RBAC-104  settings.edit single-perm full escalation; no owner lockout  → users.* split + last-VENDOR_OWNER guard
// RBAC-101  delegations.save/end missing the promised perm               → approvals.view + active-delegation cap
// RDM-001   auditRetention.purge anti-forensic one-click                 → owner gate + typed confirm + 365d floor + money-row protection
//
// Structure: PART A = pure functions (no DB queries); PART B = dispatcher /
// engine integration (needs the isolated unit-test PostgreSQL).
import "./_testdb"
import { describe, test, expect, beforeAll } from "bun:test"
import { db } from "@/lib/db"
import { mkVendor, mkUser, mkEmployee, mkSession, makeCtx, uniq } from "./_fixtures"
import { postHrm } from "./_hrm-endpoint"
import { maskDocNumber, isMaskedDocNumber } from "@/hrm/pii"
import { JOB_RESULT_PERM_GATE, jobResultPermFor } from "@/hrm-server/routes/admin"
import { isProtectedAuditAction, effectiveRetentionDays } from "@/hrm-server/routes/roadmap"
import { isPiiReportKey, renderReportAsCaller } from "@/hrm-server/routes/reports"
import { MODULE_FEATURE_GATES } from "@/hrm-server/saas/entitlements"
import { isWriteScope, apiEntitlementError } from "@/app/api/v1/_auth"
import type { ResolvedEntitlements } from "@/hrm-server/saas/entitlements"
import { ACTIONS, MODULES, ROLE_TEMPLATES } from "@/hrm-server/types"

// ============================================================================
// PART A — pure functions
// ============================================================================

describe("FLD-102 maskDocNumber / isMaskedDocNumber (pure)", () => {
  test("masks to last-4 with the C-05 bank vocabulary", () => {
    expect(maskDocNumber("1234567890123")).toBe("•••• 0123")
    expect(maskDocNumber("ABC123456")).toBe("•••• 3456")
  })
  test("short values never leak (≤4 chars fully masked)", () => {
    expect(maskDocNumber("1234")).toBe("••••")
    expect(maskDocNumber("12")).toBe("••••")
  })
  test("null/empty pass through as null", () => {
    expect(maskDocNumber(null)).toBeNull()
    expect(maskDocNumber(undefined)).toBeNull()
    expect(maskDocNumber("")).toBeNull()
  })
  test("isMaskedDocNumber detects ONLY masked values (the write-path guard)", () => {
    expect(isMaskedDocNumber("•••• 0123")).toBe(true)
    expect(isMaskedDocNumber("1234567890")).toBe(false)
    expect(isMaskedDocNumber("")).toBe(false)
    expect(isMaskedDocNumber(null)).toBe(false)
    expect(isMaskedDocNumber(123)).toBe(false)
  })
})

describe("SUB-103 job result redaction map (pure)", () => {
  test("sensitive job types are gated", () => {
    expect(JOB_RESULT_PERM_GATE.SALARY_EXPORT).toEqual(["payroll", "view"])
    expect(JOB_RESULT_PERM_GATE.BACKUP_EXPORT).toEqual(["settings", "edit"])
    expect(JOB_RESULT_PERM_GATE.BACKUP_PG_DUMP).toEqual(["settings", "edit"])
  })
  test("jobResultPermFor exact + prefixed types", () => {
    expect(jobResultPermFor("SALARY_EXPORT")).toEqual(["payroll", "view"])
    expect(jobResultPermFor("BACKUP_EXPORT")).toEqual(["settings", "edit"])
    expect(jobResultPermFor("PAYROLL_CALCULATE")).toBeNull() // counts/status only — not sensitive
    expect(jobResultPermFor("COMMUNICATION_SEND")).toBeNull()
  })
})

describe("SUB-101/102 apiEntitlementError (pure decision function)", () => {
  const ent = (over: Partial<ResolvedEntitlements>): ResolvedEntitlements => ({
    mode: "SUBSCRIBED", status: "ACTIVE", planId: "p", planName: "Starter", billingCycle: "MONTHLY",
    startDate: null, endDate: null, daysRemaining: null,
    features: { API: true }, limits: {}, overrides: {}, storageGbOverride: null, readonly: false, locked: false,
    ...over,
  })
  test("legacy vendor passes both gates by construction", () => {
    const legacy = ent({ mode: "LEGACY", status: "LEGACY", planName: null })
    expect(apiEntitlementError(legacy, "attendance:write")).toBeNull()
  })
  test("plan without apiAccess → 403 API_NOT_INCLUDED (SUB-101)", () => {
    const res = apiEntitlementError(ent({ features: { API: false } }), "employees:read")
    expect(res).not.toBeNull()
    expect(res!.status).toBe(403)
  })
  test("read scope on a read-only (expired/suspended) tenant passes — data stays readable", () => {
    expect(apiEntitlementError(ent({ status: "EXPIRED", readonly: true }), "employees:read")).toBeNull()
  })
  test("write scope on a read-only tenant → 423 SUBSCRIPTION_READONLY (SUB-102)", () => {
    const res = apiEntitlementError(ent({ status: "SUSPENDED", readonly: true }), "attendance:write")
    expect(res).not.toBeNull()
    expect(res!.status).toBe(423)
  })
  test("isWriteScope classifies the five v1 scopes", () => {
    expect(isWriteScope("attendance:write")).toBe(true)
    expect(isWriteScope("leave:write")).toBe(true)
    expect(isWriteScope("employees:read")).toBe(false)
    expect(isWriteScope("attendance:read")).toBe(false)
    expect(isWriteScope("attendance:write ")).toBe(true) // trailing space tolerated
  })
})

describe("SUB-101 integrations feature gate registration (pure)", () => {
  test("integrations module is gated by the API feature key", () => {
    expect(MODULE_FEATURE_GATES.integrations).toBe("API")
  })
})

describe("RDM-001 purge floor + protected audit actions (pure)", () => {
  test("retention floor: configured days never purge younger than 365d", () => {
    expect(effectiveRetentionDays(1)).toBe(365)
    expect(effectiveRetentionDays(30)).toBe(365)
    expect(effectiveRetentionDays(365)).toBe(365)
    expect(effectiveRetentionDays(400)).toBe(400)
  })
  test("unlimited (0) and garbage stay unlimited — the route refuses to purge", () => {
    expect(effectiveRetentionDays(0)).toBe(0)
    expect(effectiveRetentionDays(-10)).toBe(0)
    expect(effectiveRetentionDays(Number.NaN)).toBe(0)
  })
  test("money-related audit actions are protected from every purge", () => {
    expect(isProtectedAuditAction("payroll.pay")).toBe(true)
    expect(isProtectedAuditAction("payouts.confirm")).toBe(true)
    expect(isProtectedAuditAction("settlements.pay")).toBe(true)
    expect(isProtectedAuditAction("loans.approve")).toBe(true)
    expect(isProtectedAuditAction("advances.recover")).toBe(true)
    expect(isProtectedAuditAction("bonuses.approveBulk")).toBe(true)
    expect(isProtectedAuditAction("accounting.post")).toBe(true)
    expect(isProtectedAuditAction("backups.export")).toBe(true)
    expect(isProtectedAuditAction("auditRetention.purge")).toBe(true)
    expect(isProtectedAuditAction("employees.update")).toBe(false)
    expect(isProtectedAuditAction("auth.login")).toBe(false)
  })
})

describe("RPT-001 PII report registry (pure)", () => {
  test("employeesBiodata is PII-class; ordinary reports are not", () => {
    expect(isPiiReportKey("employeesBiodata")).toBe(true)
    expect(isPiiReportKey("employees")).toBe(false)
    expect(isPiiReportKey("payroll")).toBe(false)
  })
})

describe("RBAC-104/FLD-101/102 permission vocabulary (pure)", () => {
  test("new verbs are in the ACTIONS catalog (roles can actually hold them)", () => {
    expect(ACTIONS).toContain("reveal")
    expect(ACTIONS).toContain("pii")
  })
  test("users module exists and admin templates carry the full split", () => {
    expect(MODULES).toContain("users")
    for (const role of ["HR_ADMIN", "VENDOR_OWNER"] as const) {
      expect(ROLE_TEMPLATES[role]).toContain("users.view")
      expect(ROLE_TEMPLATES[role]).toContain("users.edit")
      expect(ROLE_TEMPLATES[role]).toContain("users.delete")
    }
    // HR_MANAGER reads the user list but cannot administer accounts
    expect(ROLE_TEMPLATES.HR_MANAGER).toContain("users.view")
    expect(ROLE_TEMPLATES.HR_MANAGER).not.toContain("users.edit")
    // ESS never touches user administration
    expect(ROLE_TEMPLATES.EMPLOYEE).not.toContain("users.view")
  })
  test("reports.pii is grantable: the HIGH-11 gate is no longer dead (RPT-001/002)", () => {
    expect(ROLE_TEMPLATES.HR_ADMIN).toContain("reports.pii")
    expect(ROLE_TEMPLATES.VENDOR_OWNER).toContain("reports.pii")
    expect(ROLE_TEMPLATES.HR_MANAGER).not.toContain("reports.pii")
  })
  test("employeeDocs.reveal: admins + HR managers see full identity numbers; ESS/branch do not", () => {
    expect(ROLE_TEMPLATES.HR_ADMIN).toContain("employeeDocs.reveal")
    expect(ROLE_TEMPLATES.VENDOR_OWNER).toContain("employeeDocs.reveal")
    expect(ROLE_TEMPLATES.HR_MANAGER).toContain("employeeDocs.reveal")
    expect(ROLE_TEMPLATES.BRANCH_MANAGER).not.toContain("employeeDocs.reveal")
    expect(ROLE_TEMPLATES.EMPLOYEE).not.toContain("employeeDocs.reveal")
  })
})

// ============================================================================
// PART B — dispatcher / engine integration (needs the unit-test PostgreSQL)
// ============================================================================

import crypto from "crypto"
import { NextRequest } from "next/server"
import { authenticateApiKey } from "@/app/api/v1/_auth"
import { runReportTemplate } from "@/hrm-server/scheduled-reports"

let vendor: any, owner: any, token: string
beforeAll(async () => {
  vendor = await mkVendor(uniq("R33"))
  owner = await mkUser(vendor.id, { role: "VENDOR_OWNER" })
  token = await mkSession(owner.id, "FULL")
})

describe("SUB-103 jobs.get (dispatcher-driven)", () => {
  test("unauthenticated → clean 401 (was a 500 crash on the public flag)", async () => {
    const r = await postHrm("jobs.get", { id: "whatever" })
    expect(r.status).toBe(401)
  })
  test("ESS role → 403 (route now requires jobs.view)", async () => {
    const emp = await mkEmployee(vendor.id)
    const ess = await mkUser(vendor.id, { role: "EMPLOYEE", employeeId: emp.id })
    const t = await mkSession(ess.id, "FULL")
    const r = await postHrm("jobs.get", { id: "x" }, { bearer: t })
    expect(r.status).toBe(403)
  })
  test("SALARY_EXPORT result redacted for a jobs.view holder without payroll.view; full for admins", async () => {
    const job = await db.bgJob.create({
      data: {
        vendorId: vendor.id, type: "SALARY_EXPORT", status: "DONE", progress: 3, total: 3,
        resultJson: JSON.stringify({ format: "xlsx", base64: "UEsDBB…", totals: { employees: 3, net: 999999 } }),
      },
    })
    // viewer with jobs.view but NOT payroll.view
    const viewer = await mkUser(vendor.id, { role: "CUSTOM_R33", permissions: ["jobs.view"] })
    const vt = await mkSession(viewer.id, "FULL")
    const redacted = await postHrm("jobs.get", { id: job.id }, { bearer: vt })
    expect(redacted.status).toBe(200)
    expect(redacted.body.data.result).toBeNull()
    expect(redacted.body.data.resultRedacted).toBe(true)
    expect(redacted.body.data.status).toBe("DONE") // progress still flows
    expect(redacted.body.data.progress).toBe(3)
    // admin sees the full result
    const full = await postHrm("jobs.get", { id: job.id }, { bearer: token })
    expect(full.status).toBe(200)
    expect(full.body.data.resultRedacted).toBeUndefined()
    expect(full.body.data.result.totals.employees).toBe(3)
  })
})

describe("FLD-101/102 employees.get server-side projection (dispatcher-driven)", () => {
  let emp: any, empVendor: any
  beforeAll(async () => {
    empVendor = await mkVendor(uniq("R33fld"))
    emp = await mkEmployee(empVendor.id, { fullName: "Sensitive Sam" })
    await db.employeeDocument.create({
      data: { vendorId: empVendor.id, employeeId: emp.id, category: "IDENTITY", docType: "NID", title: "National ID Card", docNumber: "1234567890123", status: "VALID" },
    })
    await db.salaryStructure.create({
      data: { vendorId: empVendor.id, employeeId: emp.id, effectiveFrom: "2026-01-01", status: "ACTIVE", basic: 30000, gross: 50000 },
    })
    await db.salaryRevision.create({
      data: { vendorId: empVendor.id, employeeId: emp.id, previousSalary: 42000, newSalary: 50000, increaseAmount: 8000, increasePercent: 19, effectiveDate: "2026-01-01", reason: "Annual increment", type: "INCREMENT", status: "APPROVED" },
    })
  })

  test("profile-only viewer (no payroll.view on the effective set): no salary keys, masked NID — the server never puts them on the wire", async () => {
    // Fixture repair (re-audit 2026-10-18): the viewer was a BRANCH_MANAGER,
    // but RBAC-103 (R3-5) made explicit grants ADDITIVE to the role template
    // and the BRANCH_MANAGER template carries payroll.view — so the "no
    // payroll.view" premise was false and the structure legitimately rode
    // the wire. A CUSTOM role has no template, so its effective set is exactly
    // the explicit grants: employees.view + employeeDocs.view, nothing more.
    const mgr = await mkUser(empVendor.id, { role: "CUSTOM_R33_PROFILE_ONLY", permissions: ["employees.view", "employeeDocs.view"] })
    const t = await mkSession(mgr.id, "FULL")
    const r = await postHrm("employees.get", { id: emp.id }, { bearer: t })
    expect(r.status).toBe(200)
    expect(r.body.data.structure).toBeNull()
    expect(r.body.data.revisions).toEqual([])
    expect(r.body.data.employee.salaryVisible).toBe(false)
    expect(r.body.data.employee.nid).toBe("•••• 0123")
    expect(r.body.data.employee.identityNumber).toBe("•••• 0123")
    expect(r.body.data.employee.identityNumberVisible).toBe(false)
    expect(r.body.data.docs[0].docNumber).toBe("•••• 0123")
  })

  test("payroll.view viewer sees the structure + revisions (FLD-101 lift)", async () => {
    const po = await mkUser(empVendor.id, { role: "PAYROLL_OFFICER" })
    const t = await mkSession(po.id, "FULL")
    const r = await postHrm("employees.get", { id: emp.id }, { bearer: t })
    expect(r.status).toBe(200)
    expect(r.body.data.structure.gross).toBe(50000)
    expect(r.body.data.revisions.length).toBe(1)
    expect(r.body.data.employee.salaryVisible).toBe(true)
    // PAYROLL_OFFICER has no employeeDocs.reveal → identity stays masked
    expect(r.body.data.employee.identityNumber).toBe("•••• 0123")
  })

  test("employeeDocs.reveal holder sees the full identity number (FLD-102 lift)", async () => {
    const hr = await mkUser(empVendor.id, { role: "HR_MANAGER" }) // template now carries employeeDocs.reveal
    const t = await mkSession(hr.id, "FULL")
    const r = await postHrm("employees.get", { id: emp.id }, { bearer: t })
    expect(r.status).toBe(200)
    expect(r.body.data.employee.identityNumber).toBe("1234567890123")
    expect(r.body.data.employee.identityNumberVisible).toBe(true)
    expect(r.body.data.docs[0].docNumber).toBe("1234567890123")
  })

  test("a masked value echoed back by a profile edit NEVER overwrites the stored identity", async () => {
    const mgr = await mkUser(empVendor.id, { role: "BRANCH_MANAGER" })
    const t = await mkSession(mgr.id, "FULL")
    const r = await postHrm("employees.update", { id: emp.id, fullName: "Sensitive Sam", identityType: "NID", identityNumber: "•••• 0123" }, { bearer: t })
    expect(r.status).toBe(200)
    const doc = await db.employeeDocument.findFirst({ where: { vendorId: empVendor.id, employeeId: emp.id, category: "IDENTITY" } })
    expect(doc?.docNumber).toBe("1234567890123") // unchanged — the mask is not data
  })
})

describe("RBAC-104 users/roles permission split + owner lockout (dispatcher-driven)", () => {
  test("HR_MANAGER (users.view only) cannot create/update users — 403", async () => {
    const v = await mkVendor(uniq("R33rbac"))
    const hrm = await mkUser(v.id, { role: "HR_MANAGER" })
    const t = await mkSession(hrm.id, "FULL")
    const r = await postHrm("users.save", { email: "nope@example.com", password: "Passw0rd!234", name: "Nope", role: "HR_ADMIN" }, { bearer: t })
    expect(r.status).toBe(403)
    const r2 = await postHrm("roles.save", { key: "ESCALATOR", name: "Escalator", permissions: ["settings.edit"] }, { bearer: t })
    expect(r2.status).toBe(403)
  })

  test("tenant admin WITH users.edit can create a user (regression: the split does not lock out admins)", async () => {
    const v = await mkVendor(uniq("R33adm"))
    const admin = await mkUser(v.id, { role: "HR_ADMIN" })
    const t = await mkSession(admin.id, "FULL")
    const r = await postHrm("users.save", { email: `newbie-${uniq("u")}@test.local`, password: "Passw0rd!234", name: "Newbie", role: "EMPLOYEE" }, { bearer: t })
    expect(r.status).toBe(200)
    expect(r.body.data.id).toBeTruthy()
  })

  test("demoting or suspending the last active VENDOR_OWNER is refused", async () => {
    const v = await mkVendor(uniq("R33own"))
    const theOwner = await mkUser(v.id, { role: "VENDOR_OWNER" })
    const admin = await mkUser(v.id, { role: "HR_ADMIN" })
    const t = await mkSession(admin.id, "FULL")
    const demote = await postHrm("users.save", { id: theOwner.id, name: theOwner.name, email: theOwner.email, role: "HR_ADMIN", status: "ACTIVE" }, { bearer: t })
    expect(demote.status).toBe(403)
    expect(demote.body.error).toMatch(/Vendor Owner/i)
    const suspend = await postHrm("users.save", { id: theOwner.id, name: theOwner.name, email: theOwner.email, role: "VENDOR_OWNER", status: "SUSPENDED" }, { bearer: t })
    expect(suspend.status).toBe(403)
    expect(suspend.body.error).toMatch(/Vendor Owner/i)
  })

  test("deleting the last active VENDOR_OWNER is refused (lockout guard)", async () => {
    const v = await mkVendor(uniq("R33del"))
    const theOwner = await mkUser(v.id, { role: "VENDOR_OWNER" })
    const admin = await mkUser(v.id, { role: "HR_ADMIN" })
    const t = await mkSession(admin.id, "FULL")
    const r = await postHrm("users.delete", { id: theOwner.id }, { bearer: t })
    expect(r.status).toBe(403)
    expect(r.body.error).toMatch(/last active Vendor Owner/i)
  })
})

describe("RBAC-101 delegations perm (dispatcher-driven)", () => {
  test("ESS account cannot call delegations.save (was perm-less)", async () => {
    const v = await mkVendor(uniq("R33dlg"))
    const emp = await mkEmployee(v.id)
    const ess = await mkUser(v.id, { role: "EMPLOYEE", employeeId: emp.id })
    const t = await mkSession(ess.id, "FULL")
    const r = await postHrm("delegations.save", { toUserId: owner.id, startDate: "2026-11-01", endDate: "2026-11-05" }, { bearer: t })
    expect(r.status).toBe(403)
  })
})

describe("AI-001/AI-002 (dispatcher-driven)", () => {
  test("ai.generate WITHOUT reports.view is refused the report render", async () => {
    const v = await mkVendor(uniq("R33ai"))
    const u = await mkUser(v.id, { role: "CUSTOM_R33AI", permissions: ["ai.generate"] })
    const t = await mkSession(u.id, "FULL")
    const r = await postHrm("ai.reportAsk", { question: "headcount by department last month" }, { bearer: t })
    expect(r.status).toBe(403)
    expect(r.body.error).toMatch(/reports\.view/)
  })

  test("renderReportAsCaller applies the CALLER's branch scope (BRANCH_MANAGER sees only their branch)", async () => {
    const v = await mkVendor(uniq("R33scope"))
    const hq = await db.branch.create({ data: { vendorId: v.id, name: "HQ", code: uniq("B") } })
    const sat = await db.branch.create({ data: { vendorId: v.id, name: "Satellite", code: uniq("B") } })
    await mkEmployee(v.id, { branchId: hq.id, fullName: "HQ Worker" })
    await mkEmployee(v.id, { branchId: sat.id, fullName: "Satellite Worker" })
    const mgr = await mkUser(v.id, { role: "BRANCH_MANAGER", branchId: hq.id })
    const ctx = makeCtx(mgr)
    const out = await renderReportAsCaller(ctx, "employees", {})
    expect(out).not.toBeNull()
    const names = out!.rows.map((r) => String(r[1]))
    expect(names).toContain("HQ Worker")
    expect(names).not.toContain("Satellite Worker")
    // the admin ctx still sees the whole tenant
    const voCtx = makeCtx(await mkUser(v.id, { role: "VENDOR_OWNER" }))
    const all = await renderReportAsCaller(voCtx, "employees", {})
    expect(all!.rows.length).toBeGreaterThanOrEqual(2)
  })

  test("ai.settings.save requires settings.edit (AI-002); ai.settings.get needs only ai.view", async () => {
    const v = await mkVendor(uniq("R33ai2"))
    const gen = await mkUser(v.id, { role: "CUSTOM_R33GEN", permissions: ["ai.view", "ai.generate"] })
    const gt = await mkSession(gen.id, "FULL")
    const read = await postHrm("ai.settings.get", {}, { bearer: gt })
    expect(read.status).toBe(200)
    const write = await postHrm("ai.settings.save", { model: "gpt-test" }, { bearer: gt })
    expect(write.status).toBe(403)
    const vo = await mkUser(v.id, { role: "VENDOR_OWNER" })
    const vt = await mkSession(vo.id, "FULL")
    const okSave = await postHrm("ai.settings.save", { model: "gpt-test" }, { bearer: vt })
    expect(okSave.status).toBe(200)
  })
})

describe("RDM-001 auditRetention.purge (dispatcher-driven)", () => {
  test("HR_ADMIN (settings.edit holder, non-owner role) is refused the purge", async () => {
    const v = await mkVendor(uniq("R33pur"))
    const admin = await mkUser(v.id, { role: "HR_ADMIN" })
    const t = await mkSession(admin.id, "FULL")
    const r = await postHrm("auditRetention.purge", { confirm: "PURGE", reason: "annual cleanup routine" }, { bearer: t })
    expect(r.status).toBe(403)
    expect(r.body.error).toMatch(/Vendor Owner/i)
  })

  test("VENDOR_OWNER purge: typed confirm required, 365-day floor enforced, money rows protected", async () => {
    const v = await mkVendor(uniq("R33pur2"))
    const theOwner = await mkUser(v.id, { role: "VENDOR_OWNER" })
    const t = await mkSession(theOwner.id, "FULL")
    // typed confirmation gate
    const noConfirm = await postHrm("auditRetention.purge", { reason: "annual cleanup routine" }, { bearer: t })
    expect(noConfirm.status).toBe(400)
    // retention window configured to 30 days — the floor must clamp it to 365.
    // Fixture repair (re-audit 2026-10-18): settings are served from the K-7
    // 15s TTL cache with write-through invalidation — a raw db.hrSetting row
    // bypasses the invalidation and getSettings keeps serving the cached
    // defaults ("unlimited"), so the purge was refused. The fixture now goes
    // through the same saveSettingsGroup writer the Settings UI uses.
    const { saveSettingsGroup } = await import("@/hrm-server/settings")
    await saveSettingsGroup(v.id, "auditRetention", { days: 30 })
    const old = new Date(Date.now() - 400 * 86400000)
    await db.auditLog.create({ data: { vendorId: v.id, userId: null, userName: "old", action: "employees.update", entity: "Employee", entityId: null, summary: "stale row", createdAt: old } })
    const money = await db.auditLog.create({ data: { vendorId: v.id, userId: null, userName: "old", action: "payroll.pay", entity: "PayrollRun", entityId: null, summary: "money row", createdAt: old } })
    await db.auditLog.create({ data: { vendorId: v.id, userId: null, userName: "new", action: "auth.login", entity: "User", entityId: null, summary: "young row", createdAt: new Date() } })
    const r = await postHrm("auditRetention.purge", { confirm: "PURGE", reason: "annual cleanup routine" }, { bearer: t })
    expect(r.status).toBe(200)
    expect(r.body.data.purged).toBe(1) // only the stale non-money row
    expect(r.body.data.effectiveDays).toBe(365) // floor applied over the 30d setting
    expect(await db.auditLog.count({ where: { id: money.id } })).toBe(1) // money survives
    expect(await db.auditLog.count({ where: { vendorId: v.id, action: "auth.login" } })).toBe(1) // young survives
  })
})

describe("RPT-001/RPT-002 PII report gates (dispatcher-driven)", () => {
  test("biodata CSV requires the typed confirmation (server twin of the RPT-002 dialog)", async () => {
    const r = await postHrm("reports.employeesBiodataCsv", {}, { bearer: token })
    expect(r.status).toBe(400)
    expect(r.body.error).toMatch(/confirm/i)
    const ok = await postHrm("reports.employeesBiodataCsv", { confirm: "EXPORT" }, { bearer: token })
    expect(ok.status).toBe(200)
    expect(ok.body.data.csv).toBeTruthy()
  })

  test("scheduling a PII report requires reports.pii (the previously-dead verb)", async () => {
    const v = await mkVendor(uniq("R33rpt"))
    const sched = await mkUser(v.id, { role: "CUSTOM_R33S", permissions: ["reports.schedule"] })
    const t = await mkSession(sched.id, "FULL")
    const r = await postHrm("reports.templates.save", {
      name: "Nightly biodata exfil", reportKey: "employeesBiodata", format: "CSV", schedule: "DAILY", active: true,
      recipients: [{ email: "someone@example.com" }],
    }, { bearer: t })
    expect(r.status).toBe(403)
    expect(r.body.error).toMatch(/reports\.pii/)
  })

  test("PII template recipients must be tenant members — external addresses are refused", async () => {
    const v = await mkVendor(uniq("R33rpt2"))
    const vo = await mkUser(v.id, { role: "VENDOR_OWNER" })
    const t = await mkSession(vo.id, "FULL")
    const ext = await postHrm("reports.templates.save", {
      name: "Nightly biodata", reportKey: "employeesBiodata", format: "CSV", schedule: "DAILY", active: true,
      recipients: [{ email: "outsider@attacker.example" }],
    }, { bearer: t })
    expect(ext.status).toBe(400)
    expect(ext.body.error).toMatch(/outsider@attacker\.example/)
  })

  test("member recipient saves; run-time re-check SKIPS when the member has left (RPT-001 both halves)", async () => {
    const v = await mkVendor(uniq("R33rpt3"))
    const vo = await mkUser(v.id, { role: "VENDOR_OWNER" })
    const member = await mkUser(v.id, { email: `member-${uniq("m")}@test.local` })
    const t = await mkSession(vo.id, "FULL")
    const ok = await postHrm("reports.templates.save", {
      name: "Legit biodata", reportKey: "employeesBiodata", format: "CSV", schedule: "DAILY", active: true,
      recipients: [{ email: member.email }],
    }, { bearer: t })
    expect(ok.status).toBe(200)
    const tplId = ok.body.data.template.id
    // the member leaves the tenant
    await db.user.delete({ where: { id: member.id } })
    const run = await runReportTemplate(v.id, tplId)
    expect(run.status).toBe("SKIPPED")
    expect(run.detail || "").toMatch(/no longer members/)
  })
})

describe("SUB-101/SUB-102 /api/v1 entitlement gate (authenticateApiKey-driven)", () => {
  async function mkKeyedVendor(plan: { apiAccess: boolean }, sub: { status: string }, scope: string) {
    const v = await mkVendor(uniq("R33v1"))
    const planRow = await db.saasPlan.create({
      data: {
        name: uniq("Plan"), apiAccess: plan.apiAccess,
        payrollEnabled: true, essEnabled: true, trackingEnabled: true, geofenceEnabled: true,
        cameraEnabled: true, aitEnabled: true, inventoryEnabled: true, procurementEnabled: true,
        performanceEnabled: true, advancedReports: true, fieldForceEnabled: true,
      } as any,
    })
    await db.saasSubscription.create({
      data: { vendorId: v.id, planId: planRow.id, planName: planRow.name, status: sub.status, endDate: new Date(Date.now() + 30 * 86400000) } as any,
    })
    const raw = `fk_${crypto.randomBytes(24).toString("base64url")}`
    await db.apiKey.create({
      data: { vendorId: v.id, name: "test key", prefix: raw.slice(0, 12), hash: crypto.createHash("sha256").update(raw, "utf8").digest("hex"), scopesJson: JSON.stringify([scope]) },
    })
    const req = new NextRequest("http://localhost:3000/api/v1/employees", { headers: { authorization: `Bearer ${raw}` } })
    return authenticateApiKey(req, scope)
  }

  test("plan WITHOUT apiAccess → 403 API_NOT_INCLUDED (SUB-101)", async () => {
    const res = await mkKeyedVendor({ apiAccess: false }, { status: "ACTIVE" }, "employees:read")
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.res.status).toBe(403)
      const body = await res.res.json()
      expect(body.code).toBe("API_NOT_INCLUDED")
    }
  })

  test("SUSPENDED tenant + write scope → 423 SUBSCRIPTION_READONLY (SUB-102)", async () => {
    const res = await mkKeyedVendor({ apiAccess: true }, { status: "SUSPENDED" }, "attendance:write")
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.res.status).toBe(423)
      const body = await res.res.json()
      expect(body.code).toBe("SUBSCRIPTION_READONLY")
    }
  })

  test("SUSPENDED tenant + read scope still works (read-only, not bricked)", async () => {
    const res = await mkKeyedVendor({ apiAccess: true }, { status: "SUSPENDED" }, "employees:read")
    expect(res.ok).toBe(true)
  })
})

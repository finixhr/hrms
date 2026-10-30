/// <reference types="bun-types" />
// ============ R3-5 Wave — SaaS capacity/feature gates, tenant RBAC & field permissions ============
// SUB-105   devices re-enable bypasses the DEVICES capacity               → requireCapacity on setEnabled(true) (re-verified)
// SUB-106   selfie/photo proofs are the one unmetered STORAGE inflow     → requireSelfieStorage at every AttendanceProof write site
// SUB-107   ESS/GEOFENCE/TRACKING plan gates bypassed via prefix gaps    → leaveRequests prefix map + in-handler requireFeature
// SUB-108   loans.guarantorRespond bypasses the PAYROLL gate              → in-handler requireFeature (closed with the SUB-107 class)
// RBAC-102  bankInfo.* vocabulary drift (dead edit verb, verify on employeeDocs) → banks section re-gated + masked rows
// RBAC-103  per-user permissions REPLACE the role template, unnormalized → union semantics + normalizePermissions + audit diff + UI editor
// RBAC-105  dead verbs: employees.export/assign, audit.export client-only → real server-side export routes + changeShift assign gate
// FLD-103   no field-level permission model                              → field-permissions engine + hrSettings group + server-side
//                                                                           projection/write whitelist + Settings → Field Permissions tab
//
// Structure: PART A = pure functions + route registrations (no DB queries);
// PART B = dispatcher / DB integration (needs the isolated unit-test PostgreSQL).
import "./_testdb"
import { describe, test, expect, beforeAll } from "bun:test"
import { db } from "@/lib/db"
import { mkVendor, mkUser, mkEmployee, mkSession, uniq } from "./_fixtures"
import { postHrm } from "./_hrm-endpoint"
import {
  FIELD_GROUPS, FIELD_GROUP_LABELS, parseFieldPermissionConfig, resolveFieldAccess,
  combineFieldAccess, fieldAccessMapFor, fieldPermissionsFromSettings, callerFieldAccess,
  projectRecord, stripDeniedWriteFields, maskContactValue,
} from "@/hrm-server/field-permissions"
import { getRoute } from "@/hrm-server/routes/router"
import { DEFAULT_SETTINGS, saveSettingsGroup } from "@/hrm-server/settings"
import { ROLE_TEMPLATES } from "@/hrm-server/types"
import { SAAS_ACTION_PREFIX_MODULE } from "@/app/api/hrm/route"

// ============================================================================
// PART A — pure functions & route registrations
// ============================================================================

describe("FLD-103 parseFieldPermissionConfig — defensive parsing", () => {
  test("valid config parses with per-role rules + tenant default", () => {
    const cfg = parseFieldPermissionConfig({
      roles: { BRANCH_MANAGER: { contact: "none", salary: "mask" }, AUDITOR: { bank: "none" } },
      default: { identity: "mask" },
    })
    expect(Object.keys(cfg.roles || {}).sort()).toEqual(["AUDITOR", "BRANCH_MANAGER"])
    expect((cfg.roles || {}).BRANCH_MANAGER).toEqual({ contact: "none", salary: "mask" })
    expect(cfg.default).toEqual({ identity: "mask" })
  })
  test("garbage is dropped, never thrown (arrays, wrong modes, empty roles)", () => {
    const cfg = parseFieldPermissionConfig({
      roles: "nope", default: [1, 2], extra: true,
    })
    expect(cfg.roles).toBeUndefined()
    expect(cfg.default).toBeUndefined()
    const cfg2 = parseFieldPermissionConfig({
      roles: { X: { salary: "FULL", contact: "none", bank: 7, identity: null, employment: "mask" } },
    })
    expect((cfg2.roles || {}).X).toEqual({ contact: "none", employment: "mask" })
    expect(parseFieldPermissionConfig(null)).toEqual({})
    expect(parseFieldPermissionConfig("junk")).toEqual({})
  })
  test("fieldPermissionsFromSettings reads the settings group (absent = empty)", () => {
    expect(fieldPermissionsFromSettings({ fieldPermissions: { roles: { A: { contact: "none" } } } } as any).roles).toEqual({ A: { contact: "none" } })
    expect(fieldPermissionsFromSettings({} as any)).toEqual({})
    expect(fieldPermissionsFromSettings(null)).toEqual({})
  })
})

describe("FLD-103 resolveFieldAccess — precedence & backward compatibility", () => {
  const cfg = parseFieldPermissionConfig({ roles: { BRANCH_MANAGER: { contact: "none" } }, default: { identity: "mask" } })
  test("role-specific rule wins over the tenant default", () => {
    expect(resolveFieldAccess(cfg, "BRANCH_MANAGER", "contact")).toBe("none")
  })
  test("tenant default applies to unlisted roles", () => {
    expect(resolveFieldAccess(cfg, "HR_MANAGER", "identity")).toBe("mask")
  })
  test("unlisted group/role/config = full (untouched tenants behave exactly as before)", () => {
    expect(resolveFieldAccess(cfg, "HR_MANAGER", "contact")).toBe("full")
    expect(resolveFieldAccess(cfg, "BRANCH_MANAGER", "employment")).toBe("full")
    expect(resolveFieldAccess(null, "HR_ADMIN", "salary")).toBe("full")
  })
})

describe("FLD-103 combineFieldAccess — the field layer can only NARROW", () => {
  test("module-perm denial (null) collapses to none — a field rule never rescues access", () => {
    expect(combineFieldAccess("full", null)).toBe("none")
    expect(combineFieldAccess("mask", null)).toBe("none")
  })
  test("undefined = no module-layer input → the field layer decides alone", () => {
    expect(combineFieldAccess("full", undefined)).toBe("full")
    expect(combineFieldAccess("mask", undefined)).toBe("mask")
    expect(combineFieldAccess("none", undefined)).toBe("none")
  })
  test("the MORE RESTRICTIVE of the two layers wins", () => {
    expect(combineFieldAccess("full", "full")).toBe("full")
    expect(combineFieldAccess("mask", "full")).toBe("mask")
    expect(combineFieldAccess("full", "mask")).toBe("mask")
    expect(combineFieldAccess("none", "full")).toBe("none")
    expect(combineFieldAccess("full", "none")).toBe("none")
    expect(combineFieldAccess("mask", "none")).toBe("none")
  })
  test("fieldAccessMapFor composes per group (identity mask default honored)", () => {
    const map = fieldAccessMapFor(parseFieldPermissionConfig({ roles: { A: { salary: "none" } } }), "A", {
      salary: "full", bank: null, identity: "mask",
    })
    expect(map.salary).toBe("none") // field rule narrows the payroll.view grant
    expect(map.bank).toBe("none") // no bankInfo.view → none
    expect(map.identity).toBe("mask") // no reveal verb → masked
    expect(map.contact).toBe("full")
    expect(map.employment).toBe("full")
  })
})

describe("FLD-103 maskContactValue — contact masking", () => {
  test("phones keep first 2 + last 2 with bullet middle", () => {
    const m = maskContactValue("01712345678")!
    expect(m.startsWith("01")).toBe(true)
    expect(m.endsWith("78")).toBe(true)
    expect(m).toMatch(/^01[•]+78$/)
  })
  test("emails mask the local part, keep the domain", () => {
    expect(maskContactValue("rafiq@gmail.com")).toBe("r••••@gmail.com")
    // 1-char local: the impl always keeps the first char + at least one
    // bullet (a masked value must never look unmasked) — "a" → "a•"
    expect(maskContactValue("a@b.co")).toBe("a•@b.co")
  })
  test("short values never leak (full bullets)", () => {
    expect(maskContactValue("1234")).toBe("••••")
    expect(maskContactValue("12")).toBe("••••")
  })
  test("null/empty passthrough", () => {
    expect(maskContactValue(null)).toBeNull()
    expect(maskContactValue("")).toBe("")
  })
})

describe("FLD-103 projectRecord — read-side projection", () => {
  const row = {
    id: "e1", fullName: "Rafiq Islam", code: "EMP-0001",
    mobile: "01712345678", personalEmail: "rafiq@gmail.com", presentAddress: "12 Road 3, Dhaka",
    branchId: "b1", grade: "Grade 5", joiningDate: "2024-01-01",
  }
  test("contact none → contact fields nulled, other groups untouched", () => {
    const out = projectRecord(row, { salary: "full", bank: "full", identity: "full", contact: "none", employment: "full" })
    expect(out.mobile).toBeNull()
    expect(out.personalEmail).toBeNull()
    expect(out.presentAddress).toBeNull()
    expect(out.fullName).toBe("Rafiq Islam")
    expect(out.branchId).toBe("b1")
  })
  test("contact mask → masked values (not nulled)", () => {
    const out = projectRecord(row, { salary: "full", bank: "full", identity: "full", contact: "mask", employment: "full" })
    expect(out.mobile).toMatch(/^01[•]+78$/)
    expect(out.personalEmail).toBe("r••••@gmail.com")
    expect(out.fullName).toBe("Rafiq Islam")
  })
  test("employment none → org fields nulled; contact untouched", () => {
    const out = projectRecord(row, { salary: "full", bank: "full", identity: "full", contact: "full", employment: "none" })
    expect(out.branchId).toBeNull()
    expect(out.grade).toBeNull()
    expect(out.joiningDate).toBeNull()
    expect(out.mobile).toBe("01712345678")
  })
  test("groups option narrows the projection (list rows apply contact/employment only)", () => {
    const out = projectRecord(row, { salary: "full", bank: "full", identity: "full", contact: "none", employment: "none" }, { groups: ["employment"] })
    expect(out.mobile).toBe("01712345678") // contact NOT projected (group filter)
    expect(out.grade).toBeNull()
  })
})

describe("FLD-103 stripDeniedWriteFields — write-side whitelist", () => {
  test("contact none strips the present contact keys and reports them", () => {
    const { payload, stripped } = stripDeniedWriteFields(
      { fullName: "New Name", mobile: "018", presentAddress: "Dhaka", grade: "G6", payoutMethod: "BANK", identityNumber: "123" },
      { salary: "full", bank: "none", identity: "none", contact: "none", employment: "full" },
    )
    expect(payload.fullName).toBe("New Name")
    expect(payload.mobile).toBeUndefined()
    expect(payload.presentAddress).toBeUndefined()
    expect(payload.payoutMethod).toBeUndefined() // bank none → payout fields stripped
    expect(payload.identityNumber).toBeUndefined() // identity none → id inputs stripped
    expect(payload.grade).toBe("G6") // employment full → kept
    expect(stripped.sort()).toEqual(["identityNumber", "mobile", "payoutMethod", "presentAddress"])
  })
  test("mask still allows the write (masked-on-read editors update the stored value)", () => {
    const { payload, stripped } = stripDeniedWriteFields(
      { mobile: "018", grade: "G6" },
      { salary: "full", bank: "full", identity: "full", contact: "mask", employment: "mask" },
    )
    expect(payload).toEqual({ mobile: "018", grade: "G6" })
    expect(stripped).toEqual([])
  })
  test("groups option (create/update paths pass contact/employment/bank/identity only)", () => {
    const { payload, stripped } = stripDeniedWriteFields(
      { mobile: "018", basic: 5000 },
      { salary: "none", bank: "full", identity: "full", contact: "none", employment: "none" },
      { groups: ["contact", "employment", "bank", "identity"] },
    )
    expect(payload.mobile).toBeUndefined()
    expect(payload.basic).toBe(5000) // salary group not in the strip scope here
    expect(stripped).toEqual(["mobile"])
  })
  test("absent keys are not reported as stripped", () => {
    const { stripped } = stripDeniedWriteFields({ fullName: "X" }, { salary: "none", bank: "none", identity: "none", contact: "none", employment: "none" })
    expect(stripped).toEqual([])
  })
})

describe("RBAC-102 / RBAC-105 / SUB-105 — route registrations (server-side truth)", () => {
  beforeAll(() => { /* routes registered by the router import at module top */ })

  test("SUB-105 devices.setEnabled exists and carries the devices.edit perm (re-ported R3-2)", () => {
    const def = getRoute("devices.setEnabled")
    expect(def).toBeDefined()
    expect(def!.perm).toEqual(["devices", "edit"])
  })
  test("RBAC-102 banks section rides the bankInfo family", () => {
    expect(getRoute("employees.banks.verify")!.perm).toEqual(["bankInfo", "verify"])
    expect(getRoute("employees.banks.list")!.perm).toEqual(["bankInfo", "view"])
    expect(getRoute("employees.banks.create")!.perm).toEqual(["bankInfo", "edit"])
    expect(getRoute("employees.banks.update")!.perm).toEqual(["bankInfo", "edit"])
    expect(getRoute("employees.banks.delete")!.perm).toEqual(["bankInfo", "edit"])
  })
  test("RBAC-102 the OTHER sections keep the employees family (no collateral drift)", () => {
    expect(getRoute("employees.family.create")!.perm).toEqual(["employees", "edit"])
    expect(getRoute("employees.education.update")!.perm).toEqual(["employees", "edit"])
    expect(getRoute("employees.references.delete")!.perm).toEqual(["employees", "edit"])
  })
  test("RBAC-105 audit.export + employees.exportCsv are REAL routes on their advertised verbs", () => {
    expect(getRoute("audit.export")!.perm).toEqual(["audit", "export"])
    expect(getRoute("employees.exportCsv")!.perm).toEqual(["employees", "export"])
    expect(getRoute("audit.export")!.schema).toBeDefined()
    expect(getRoute("employees.exportCsv")!.schema).toBeDefined()
  })
  test("RBAC-105 employees.changeShift keeps employees.edit + accepts assign in-handler", () => {
    expect(getRoute("employees.changeShift")!.perm).toEqual(["employees", "edit"])
  })
  test("SUB-107 the leaveRequests prefix maps to the (core) leave module", () => {
    expect(SAAS_ACTION_PREFIX_MODULE.leaveRequests).toBe("leave")
    expect(SAAS_ACTION_PREFIX_MODULE.ess).toBe("ess")
    expect(SAAS_ACTION_PREFIX_MODULE.geofences).toBe("geofence")
  })
  test("RBAC-103 vocabulary: HR managers hold the now-real bankInfo.edit verb", () => {
    expect((ROLE_TEMPLATES.HR_MANAGER as string[]).includes("bankInfo.edit")).toBe(true)
    expect((ROLE_TEMPLATES.HR_ADMIN as string[]).includes("bankInfo.edit")).toBe(true)
    expect((ROLE_TEMPLATES.HR_ADMIN as string[]).includes("bankInfo.verify")).toBe(true)
  })
  test("FLD-103 settings group exists with an empty default (backward compatibility)", () => {
    expect(DEFAULT_SETTINGS.fieldPermissions).toEqual({ roles: null, default: null })
  })
})

describe("FLD-103 fieldPermissions save-time validation (no DB on invalid shapes)", () => {
  test("unknown top-level keys are rejected", async () => {
    await expect(saveSettingsGroup("v", "fieldPermissions", { roleses: {} } as any)).rejects.toThrow(/Unknown key/)
  })
  test("bad access modes are rejected with the offending key in the message", async () => {
    await expect(saveSettingsGroup("v", "fieldPermissions", { roles: { X: { salary: "FULL" } } } as any)).rejects.toThrow(/salary/)
    await expect(saveSettingsGroup("v", "fieldPermissions", { default: { bank: "hidden" } } as any)).rejects.toThrow(/bank/)
  })
  test("roles must be role→groups objects", async () => {
    await expect(saveSettingsGroup("v", "fieldPermissions", { roles: ["a"] } as any)).rejects.toThrow(/roles must be/)
  })
})

// ============================================================================
// PART B — dispatcher / DB integration (needs the unit-test PostgreSQL)
// ============================================================================

describe("R3-5 PART B — RBAC-103 per-user grants are ADDITIVE", () => {
  test("a user's explicit grants UNION with the role template (no more freeze-out)", async () => {
    const vendor = await mkVendor()
    // HR_MANAGER template + one extra grant (reports.pii) — the old replace
    // semantics dropped every template verb not in the explicit list.
    const user = await mkUser(vendor.id, { role: "HR_MANAGER", permissions: ["reports.pii"] })
    const sess = await mkSession(user.id)
    const me = await postHrm("auth.me", {}, { bearer: sess })
    expect(me.status).toBe(200)
    const perms: string[] = me.body.data.user.permissions
    expect(perms.includes("reports.pii")).toBe(true) // the explicit grant
    expect(perms.includes("employees.view")).toBe(true) // ...AND the template
    expect(perms.includes("leave.approve")).toBe(true)
  })
  test("users.save NORMALIZES the explicit list (garbage keys never persist)", async () => {
    const vendor = await mkVendor()
    const admin = await mkUser(vendor.id, { role: "HR_ADMIN" })
    const adminSess = await mkSession(admin.id)
    const target = await mkUser(vendor.id, { role: "PAYROLL_OFFICER", permissions: [] })
    const res = await postHrm("users.save", {
      id: target.id, name: target.name, email: target.email, role: "PAYROLL_OFFICER", status: "ACTIVE",
      permissions: ["bogus.module", "reports.pii", "reports.pii", 42 as any],
    }, { bearer: adminSess })
    expect(res.status).toBe(200)
    const stored = JSON.parse((await db.user.findUnique({ where: { id: target.id } }))!.permissions || "[]")
    expect(stored).toEqual(["reports.pii"]) // deduped + validated against MODULES×ACTIONS
  })
  test("the audit row records the permission diff (old vs new explicit set)", async () => {
    const vendor = await mkVendor()
    const admin = await mkUser(vendor.id, { role: "HR_ADMIN" })
    const adminSess = await mkSession(admin.id)
    const target = await mkUser(vendor.id, { role: "PAYROLL_OFFICER", permissions: ["reports.view"] })
    await postHrm("users.save", {
      id: target.id, name: target.name, email: target.email, role: "PAYROLL_OFFICER", status: "ACTIVE",
      permissions: ["reports.pii"],
    }, { bearer: adminSess })
    const rows = await db.auditLog.findMany({
      where: { vendorId: vendor.id, action: "users.update", entityId: target.id },
      orderBy: { createdAt: "desc" }, take: 1,
    })
    expect(rows.length).toBe(1)
    const oldVal = JSON.parse(rows[0].oldValue || "{}")
    expect(oldVal.permissions).toEqual(["reports.view"])
  })
})

describe("R3-5 PART B — RBAC-102 banks vocabulary + masking", () => {
  test("employeeDocs.verify alone can NO LONGER verify a bank account (dead-verb fix)", async () => {
    const vendor = await mkVendor()
    const emp = await mkEmployee(vendor.id)
    const bank = await db.bankAccount.create({
      data: { vendorId: emp.vendorId, employeeId: emp.id, holderName: "Rafiq", bank: "DBBL", accountNumber: "1234567890", isPrimary: true },
    })
    // Old-style holder: employeeDocs.verify but NOT bankInfo.verify
    const oldStyle = await mkUser(vendor.id, { role: "DEPT_MANAGER" })
    await db.user.update({ where: { id: oldStyle.id }, data: { permissions: JSON.stringify(["employeeDocs.verify", "employees.view"]) } })
    const oldSess = await mkSession(oldStyle.id)
    const denied = await postHrm("employees.banks.verify", { id: bank.id, employeeId: emp.id }, { bearer: oldSess })
    expect(denied.status).toBe(403)

    // bankInfo.verify holder succeeds
    const verifier = await mkUser(vendor.id, { role: "HR_ADMIN" })
    const okSess = await mkSession(verifier.id)
    const okRes = await postHrm("employees.banks.verify", { id: bank.id, employeeId: emp.id }, { bearer: okSess })
    expect(okRes.status).toBe(200)
    expect(okRes.body.data.verified).toBe(true)
  })
  test("employees.banks.list masks account + MFS numbers to last-4 (C-05 on the section route)", async () => {
    const vendor = await mkVendor()
    const emp = await mkEmployee(vendor.id)
    await db.bankAccount.create({
      data: { vendorId: emp.vendorId, employeeId: emp.id, holderName: "Rafiq", bank: "DBBL", accountNumber: "1234567890", isPrimary: true },
    })
    const admin = await mkUser(vendor.id, { role: "HR_ADMIN" })
    const sess = await mkSession(admin.id)
    const res = await postHrm("employees.banks.list", { employeeId: emp.id }, { bearer: sess })
    expect(res.status).toBe(200)
    expect(res.body.data[0].accountNumber).toBe("•••• 7890")
  })
})

describe("R3-5 PART B — RBAC-105 server-side exports", () => {
  test("audit.export: audit.view alone is denied; audit.export streams CSV + writes its own audit row", async () => {
    const vendor = await mkVendor()
    // (fixture repair, re-audit 2026-10-18: a role-less mkUser defaults to
    // VENDOR_OWNER whose template carries every verb — the denial case must
    // ride a custom role so the effective set is exactly audit.view)
    const viewer = await mkUser(vendor.id, { role: "CUSTOM_R35_AUDIT_VIEWER", permissions: ["audit.view"] })
    const viewerSess = await mkSession(viewer.id)
    const denied = await postHrm("audit.export", {}, { bearer: viewerSess })
    expect(denied.status).toBe(403)

    const exporter = await mkUser(vendor.id, { role: "HR_ADMIN" })
    const exporterSess = await mkSession(exporter.id)
    // HR_ADMIN template includes audit.export
    const res = await postHrm("audit.export", { entity: "User" }, { bearer: exporterSess })
    expect(res.status).toBe(200)
    expect(typeof res.body.data.csv).toBe("string")
    expect(res.body.data.csv.split("\n")[0]).toContain("Timestamp")
    expect(res.body.data.count).toBeGreaterThanOrEqual(0)
    const auditRows = await db.auditLog.findMany({ where: { vendorId: vendor.id, action: "audit.export" } })
    expect(auditRows.length).toBe(1) // the export itself is a trail event
  })
  test("employees.exportCsv: employees.export streams the NON-PII directory", async () => {
    const vendor = await mkVendor()
    const emp = await mkEmployee(vendor.id, { fullName: "Directory Person" })
    await db.employee.update({ where: { id: emp.id }, data: { mobile: "01711111111", personalEmail: "x@y.z" } })
    const exporter = await mkUser(vendor.id, { role: "HR_ADMIN" })
    const sess = await mkSession(exporter.id)
    const res = await postHrm("employees.exportCsv", {}, { bearer: sess })
    expect(res.status).toBe(200)
    const csv: string = res.body.data.csv
    expect(csv).toContain("Directory Person")
    expect(csv).toContain("Code,Name,Designation")
    expect(csv).not.toContain("01711111111") // contact PII never rides the directory export
    expect(csv).not.toContain("x@y.z")
    // scope denial: a role without employees.export
    // (fixture repair, re-audit 2026-10-18: role-less mkUser = VENDOR_OWNER
    // template = every verb; a custom role pins the effective set)
    const viewer = await mkUser(vendor.id, { role: "CUSTOM_R35_DIR_VIEWER", permissions: ["employees.view"] })
    const viewerSess = await mkSession(viewer.id)
    const denied = await postHrm("employees.exportCsv", {}, { bearer: viewerSess })
    expect(denied.status).toBe(403)
  })
  test("employees.changeShift accepts employees.assign WITHOUT employees.edit", async () => {
    const vendor = await mkVendor()
    const emp = await mkEmployee(vendor.id)
    const branch = await db.branch.create({ data: { vendorId: vendor.id, name: "B", code: uniq("B") } })
    const shift = await db.shift.create({ data: { vendorId: vendor.id, name: "Day", startTime: "09:00", endTime: "17:00", active: true } })
    // assign-only holder (the previously dead verb)
    // (fixture repair, re-audit 2026-10-18: custom role so the effective set
    // really lacks employees.edit — a role-less mkUser would ride the
    // VENDOR_OWNER template and the case would prove nothing)
    const assigner = await mkUser(vendor.id, { role: "CUSTOM_R35_ASSIGNER", permissions: ["employees.view", "employees.assign"] })
    const sess = await mkSession(assigner.id)
    const res = await postHrm("employees.changeShift", { employeeId: emp.id, shiftId: shift.id }, { bearer: sess })
    expect(res.status).toBe(200)
    expect(res.body.data.shiftName).toBe("Day")
    // neither verb → 403
    // (fixture repair, re-audit 2026-10-18: role-less mkUser = VENDOR_OWNER
    // template = employees.edit/assign; a custom role pins the effective set)
    const stranger = await mkUser(vendor.id, { role: "CUSTOM_R35_STRANGER", permissions: ["employees.view"] })
    const strangerSess = await mkSession(stranger.id)
    const denied = await postHrm("employees.changeShift", { employeeId: emp.id, shiftId: shift.id }, { bearer: strangerSess })
    expect(denied.status).toBe(403)
  })
})

describe("R3-5 PART B — FLD-103 field permissions end-to-end", () => {
  test("contact none: projected reads + stripped writes for the restricted role", async () => {
    const vendor = await mkVendor()
    const emp = await mkEmployee(vendor.id, { fullName: "FieldPerm Person" })
    await db.employee.update({
      where: { id: emp.id },
      data: { mobile: "01722222222", personalEmail: "fp@x.y", grade: "G7", branchId: null },
    })
    const admin = await mkUser(vendor.id, { role: "HR_ADMIN" })
    const adminSess = await mkSession(admin.id)
    // configure: VIEWER role = contact none, employment none
    const saveCfg = await postHrm("settings.save", {
      group: "fieldPermissions",
      values: { roles: { VIEWER: { contact: "none", employment: "none" } }, default: {} },
    }, { bearer: adminSess })
    expect(saveCfg.status).toBe(200)

    const viewer = await mkUser(vendor.id, { role: "VIEWER" })
    await db.role.create({ data: { vendorId: vendor.id, key: "VIEWER", name: "Viewer", permissions: JSON.stringify(["employees.view", "employees.edit"]) } })
    const viewerSess = await mkSession(viewer.id)

    const got = await postHrm("employees.get", { id: emp.id }, { bearer: viewerSess })
    expect(got.status).toBe(200)
    expect(got.body.data.employee.mobile).toBeNull() // contact none
    expect(got.body.data.employee.grade).toBeNull() // employment none
    expect(got.body.data.fieldAccess.contact).toBe("none")
    expect(got.body.data.employee.fullName).toBe("FieldPerm Person") // unrestricted fields intact

    // write path: contact + employment stripped, personal fields still editable
    const upd = await postHrm("employees.update", {
      id: emp.id, fullName: "FieldPerm Person II", mobile: "01999999999", grade: "G9",
    }, { bearer: viewerSess })
    expect(upd.status).toBe(200)
    const after = await db.employee.findUnique({ where: { id: emp.id } })
    expect(after!.fullName).toBe("FieldPerm Person II") // allowed field persisted
    expect(after!.mobile).toBe("01722222222") // contact write STRIPPED (old value kept)
    expect(after!.grade).toBe("G7") // employment write STRIPPED
    // the withheld keys are audit-noted
    const auditRow = await db.auditLog.findFirst({
      where: { vendorId: vendor.id, action: "employees.update", entityId: emp.id },
      orderBy: { createdAt: "desc" },
    })
    expect(String(auditRow!.summary)).toContain("field permissions withheld")
  })
  test("salary none blocks salaryStructures.save even with payroll.edit", async () => {
    const vendor = await mkVendor()
    const emp = await mkEmployee(vendor.id)
    const admin = await mkUser(vendor.id, { role: "HR_ADMIN" })
    const adminSess = await mkSession(admin.id)
    const saveCfg = await postHrm("settings.save", {
      group: "fieldPermissions",
      values: { roles: { PAYROLL_OFFICER: { salary: "none" } }, default: {} },
    }, { bearer: adminSess })
    expect(saveCfg.status).toBe(200)
    const officer = await mkUser(vendor.id, { role: "PAYROLL_OFFICER" })
    const officerSess = await mkSession(officer.id)
    const denied = await postHrm("salaryStructures.save", {
      employeeId: emp.id, basic: 10000, effectiveFrom: "2026-10-01",
    }, { bearer: officerSess })
    expect(denied.status).toBe(403)
    expect(String(denied.body.error)).toContain("field permissions")
  })
  test("auth.me exposes the caller's fieldAccess map", async () => {
    const vendor = await mkVendor()
    const admin = await mkUser(vendor.id, { role: "HR_ADMIN" })
    const sess = await mkSession(admin.id)
    const me = await postHrm("auth.me", {}, { bearer: sess })
    expect(me.status).toBe(200)
    expect(me.body.data.user.fieldAccess).toEqual({ salary: "full", bank: "full", identity: "full", contact: "full", employment: "full" })
  })
})

describe("R3-5 PART B — SUB-107/108 plan-feature gates (in-handler)", () => {
  test("ESS-off plan blocks employee self-leave while HR keeps applying", async () => {
    const vendor = await mkVendor()
    const emp = await mkEmployee(vendor.id)
    const employeeUser = await mkUser(vendor.id, { role: "EMPLOYEE", employeeId: emp.id })
    const empSess = await mkSession(employeeUser.id)
    // (fixture repair, re-audit 2026-10-18: the HR_ADMIN template carries
    // leave.create — HR_MANAGER's template only views/approves/rejects/exports
    // leave, so the "HR keeps applying" half never passed its permission gate)
    const hr = await mkUser(vendor.id, { role: "HR_ADMIN" })
    const hrSess = await mkSession(hr.id)
    // Fixture repair (re-audit 2026-10-18): the leave-type model speaks
    // defaultDays since the R3-4 leave rework (annualDays was the pre-rework
    // column and Prisma rejects it with "Unknown argument").
    const leaveType = await db.leaveType.create({
      data: { vendorId: vendor.id, code: "CASUAL", name: "Casual", defaultDays: 10, paid: true, probationEligible: true },
    } as any)
    // Fixture repair (re-audit 2026-10-18, cont.): leaveRequests.apply submits
    // through the LEAVE approval workflow — without one the HR half of this
    // test died on "No approval workflow configured" (Deny 403) before the
    // plan-gate assertions could run. The EMPLOYEE half denies earlier (the
    // in-handler ESS gate precedes submitForApproval).
    {
      const wf = await db.approvalWorkflow.create({
        data: { vendorId: vendor.id, processType: "LEAVE", name: `LEAVE ${uniq()}`, active: true },
      })
      await db.approvalStep.create({
        data: { vendorId: wf.vendorId, workflowId: wf.id, sequence: 1, name: "Owner Approval", approverRole: "VENDOR_OWNER", required: true, rejectBehavior: "REJECT_ALL", departmentScope: false, branchScope: false, amountThreshold: null, allowDelegation: false },
      })
    }
    let vendor2: Awaited<ReturnType<typeof mkVendor>> | null = null
    // plan WITHOUT ESS
    // (fixture repair, re-audit 2026-10-18: SaasPlan speaks monthlyPrice/
    // yearlyPrice — planCode/priceMonthly/billingCycle were phantom fields
    // the `as any` cast hid from tsc but Prisma rejects at runtime; the
    // subscription snapshot requires planName)
    const plan = await db.saasPlan.create({
      data: {
        name: "No ESS", monthlyPrice: 1,
        employeeLimit: 50, userLimit: 10, branchLimit: 5, departmentLimit: 10, deviceLimit: 5,
        storageGb: 5, trackingEmployeeLimit: 10,
        payrollEnabled: true, aitEnabled: false, inventoryEnabled: false, procurementEnabled: false,
        performanceEnabled: false, essEnabled: false, cameraEnabled: false, trackingEnabled: false,
        geofenceEnabled: false, apiAccess: false, advancedReports: false, fieldForceEnabled: false,
      } as any,
    })
    const sub = await db.saasSubscription.create({
      data: { vendorId: vendor.id, planId: plan.id, planName: "No ESS", status: "ACTIVE", billingCycle: "MONTHLY", startDate: new Date(), endDate: new Date(Date.now() + 30 * 86400000) } as any,
    })
    try {
      // invalidate the 10s entitlement memo so the new subscription is seen
      const { invalidateEntitlements } = await import("@/hrm-server/saas/entitlements")
      invalidateEntitlements(vendor.id)
      const from = new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10)
      const to = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10)
      const denied = await postHrm("leaveRequests.apply", {
        employeeId: emp.id, leaveTypeId: leaveType.id, fromDate: from, toDate: to, reason: "family",
      }, { bearer: empSess })
      expect(denied.status).toBe(403)
      expect(String(denied.body.error)).toContain("ESS")

      // HR (leave.create) keeps applying — leave is core for the HR plane
      const okRes = await postHrm("leaveRequests.apply", {
        employeeId: emp.id, leaveTypeId: leaveType.id, fromDate: from, toDate: to, reason: "family",
      }, { bearer: hrSess })
      expect(okRes.status).toBe(200)

      // SUB-107: geo punch without GEOFENCE feature
      const geoDenied = await postHrm("attendance.geofence.checkin", {
        latitude: 23.8, longitude: 90.4,
      }, { bearer: empSess })
      expect(geoDenied.status).toBe(403)
      expect(String(geoDenied.body.error)).toContain("GEOFENCE")

      // SUB-107: periodic check without TRACKING feature
      const trackDenied = await postHrm("attendance.periodicCheck", {}, { bearer: empSess })
      expect(trackDenied.status).toBe(403)
      expect(String(trackDenied.body.error)).toContain("TRACKING")

      // SUB-108: guarantor respond without PAYROLL feature — verified by a
      // second vendor + payroll-off plan
      vendor2 = await mkVendor()
      const plan2 = await db.saasPlan.create({
        data: {
          name: "No Payroll", monthlyPrice: 1,
          employeeLimit: 50, userLimit: 10, branchLimit: 5, departmentLimit: 10, deviceLimit: 5,
          storageGb: 5, trackingEmployeeLimit: 10,
          payrollEnabled: false, aitEnabled: false, inventoryEnabled: false, procurementEnabled: false,
          performanceEnabled: false, essEnabled: false, cameraEnabled: false, trackingEnabled: false,
          geofenceEnabled: false, apiAccess: false, advancedReports: false, fieldForceEnabled: false,
        } as any,
      })
      await db.saasSubscription.create({
        data: { vendorId: vendor2.id, planId: plan2.id, planName: "No Payroll", status: "ACTIVE", billingCycle: "MONTHLY", startDate: new Date(), endDate: new Date(Date.now() + 30 * 86400000) } as any,
      })
      invalidateEntitlements(vendor2.id)
      const emp2 = await mkEmployee(vendor2.id)
      const g2 = await mkEmployee(vendor2.id, { fullName: "Guarantor" })
      const g2User = await mkUser(vendor2.id, { role: "EMPLOYEE", employeeId: g2.id })
      const g2Sess = await mkSession(g2User.id)
      // (fixture repair, re-audit 2026-10-18: the Loan model speaks
      // installments + startDate — installmentCount/appliedOn/disbursedOn
      // were phantom fields the `as any` cast hid from tsc)
      const loan2 = await db.loan.create({
        data: {
          vendorId: vendor2.id, employeeId: emp2.id, principal: 50000, interestRate: 0,
          installmentAmount: 5000, installments: 10, startDate: "2026-11-01", status: "PENDING", guarantorId: g2.id,
          guarantorStatus: "PENDING",
        } as any,
      })
      const grDenied = await postHrm("loans.guarantorRespond", { loanId: loan2.id, decision: "agree" }, { bearer: g2Sess })
      expect(grDenied.status).toBe(403)
      expect(String(grDenied.body.error)).toContain("PAYROLL")
    } finally {
      await db.saasSubscription.delete({ where: { id: sub.id } }).catch(() => {})
      const { invalidateEntitlements } = await import("@/hrm-server/saas/entitlements")
      invalidateEntitlements(vendor.id)
      if (vendor2) invalidateEntitlements(vendor2.id)
    }
  })
})

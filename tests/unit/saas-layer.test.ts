/// <reference types="bun-types" />
// ============ SaaS layer unit tests (§57) ============
// Covers: entitlement resolution (legacy/subscribed/overrides/readonly),
// capacity guard math, registration validation rules, subscription cycle
// computation, platform sequences, and plane separation (owner session lookups
// can never resolve tenant sessions and vice versa).
import "./_testdb"
import { beforeAll, describe, expect, test } from "bun:test"
import { db } from "@/lib/db"
import { ownerSessionTokenHash, hashOwnerPassword, getOwnerFromToken, OWNER_COOKIE } from "@/hrm-server/saas/owner-auth"
import { sessionTokenHash, getCtxFromToken } from "@/hrm-server/auth"
import { newToken } from "@/hrm-server/auth"
import {
  resolveEntitlements, requireCapacity, featureBlocked, MODULE_FEATURE_GATES, invalidateEntitlements,
} from "@/hrm-server/saas/entitlements"
import { cycleEndDate, provisionTenant } from "@/hrm-server/saas/provision"
import { nextApplicationNumber, nextPlatformSequence } from "@/hrm-server/saas/sequences"
import { getSaasSettings, saveSaasSettingsGroup, DEFAULT_SAAS_SETTINGS } from "@/hrm-server/saas/settings"
import { REGISTRATION_STATUS_FLOW } from "@/hrm-server/saas/constants"
import { mkVendor, mkUser, uniq } from "./_fixtures"
import { hashPassword } from "@/hrm-server/auth"

let seq = 0
const code = () => `T${Date.now().toString(36)}${(seq++).toString(36)}`

async function mkPlan(over: Partial<any> = {}) {
  return db.saasPlan.create({
    data: {
      name: over.name || uniq("Plan"),
      monthlyPrice: over.monthlyPrice ?? 1000,
      yearlyPrice: over.yearlyPrice ?? 10000,
      currency: "BDT",
      employeeLimit: over.employeeLimit ?? 10,
      userLimit: over.userLimit ?? 5,
      branchLimit: over.branchLimit ?? 2,
      departmentLimit: over.departmentLimit ?? 5,
      deviceLimit: over.deviceLimit ?? 2,
      storageGb: over.storageGb ?? 1,
      trackingEmployeeLimit: over.trackingEmployeeLimit ?? 3,
      payrollEnabled: over.payrollEnabled ?? false,
      aitEnabled: over.aitEnabled ?? false,
      inventoryEnabled: over.inventoryEnabled ?? false,
      procurementEnabled: over.procurementEnabled ?? false,
      performanceEnabled: over.performanceEnabled ?? false,
      essEnabled: over.essEnabled ?? true,
      cameraEnabled: over.cameraEnabled ?? false,
      trackingEnabled: over.trackingEnabled ?? false,
      geofenceEnabled: over.geofenceEnabled ?? false,
      apiAccess: over.apiAccess ?? false,
      advancedReports: over.advancedReports ?? false,
      supportLevel: "STANDARD",
      active: true,
      isPublic: true,
      ...over.extra,
    } as any,
  })
}

async function mkSubscription(vendorId: string, planId: string, over: Partial<any> = {}) {
  return db.saasSubscription.create({
    data: {
      vendorId, planId, planName: "TestPlan",
      billingCycle: over.billingCycle ?? "MONTHLY",
      status: over.status ?? "ACTIVE",
      startDate: new Date(),
      endDate: over.endDate ?? new Date(Date.now() + 20 * 86400000),
      priceAtCreation: 1000,
      currencySnapshot: "BDT",
    } as any,
  })
}

beforeAll(async () => {
  // isolate entitlement memo between tests
  invalidateEntitlements()
})

describe("SaaS entitlements", () => {
  test("LEGACY mode: vendor without subscription gets full access, no limits, never readonly", async () => {
    const v = await mkVendor()
    const ent = await resolveEntitlements(v.id)
    expect(ent.mode).toBe("LEGACY")
    expect(ent.readonly).toBe(false)
    expect(ent.limits.EMPLOYEES).toBeUndefined()
    expect(featureBlocked(ent, "payroll")).toBe(false)
  })

  test("SUBSCRIBED mode reflects plan features and limits", async () => {
    const v = await mkVendor()
    const plan = await mkPlan({ payrollEnabled: true, employeeLimit: 25 })
    await mkSubscription(v.id, plan.id)
    invalidateEntitlements(v.id)
    const ent = await resolveEntitlements(v.id)
    expect(ent.mode).toBe("SUBSCRIBED")
    expect(ent.status).toBe("ACTIVE")
    expect(ent.features.PAYROLL).toBe(true)
    expect(ent.features.INVENTORY).toBe(false)
    expect(ent.limits.EMPLOYEES).toBe(25)
    expect(ent.readonly).toBe(false)
    expect(featureBlocked(ent, "payroll")).toBe(false)
    expect(featureBlocked(ent, "inventory")).toBe(true)
  })

  test("tenant override can force a module OFF and ON regardless of plan", async () => {
    const v = await mkVendor()
    const plan = await mkPlan({ payrollEnabled: true, trackingEnabled: false })
    await mkSubscription(v.id, plan.id)
    await db.saasTenantOverride.create({ data: { vendorId: v.id, featureToggles: JSON.stringify({ payroll: false, tracking: true }) } })
    invalidateEntitlements(v.id)
    const ent = await resolveEntitlements(v.id)
    expect(featureBlocked(ent, "payroll")).toBe(true)   // overridden OFF despite plan
    expect(featureBlocked(ent, "tracking")).toBe(false) // overridden ON despite plan
    expect(ent.overrides.payroll).toBe(false)
    expect(ent.overrides.tracking).toBe(true)
  })

  test("EXPIRED / SUSPENDED / CANCELLED → readonly lockout; ACTIVE/TRIAL/GRACE_PERIOD → writable", async () => {
    for (const status of ["EXPIRED", "SUSPENDED", "CANCELLED"] as const) {
      const v = await mkVendor()
      const plan = await mkPlan()
      await mkSubscription(v.id, plan.id, { status })
      invalidateEntitlements(v.id)
      const ent = await resolveEntitlements(v.id)
      expect(ent.readonly).toBe(true)
    }
    for (const status of ["TRIAL", "ACTIVE", "PAST_DUE", "GRACE_PERIOD"] as const) {
      const v = await mkVendor()
      const plan = await mkPlan()
      await mkSubscription(v.id, plan.id, { status })
      invalidateEntitlements(v.id)
      const ent = await resolveEntitlements(v.id)
      expect(ent.readonly).toBe(false)
    }
  })

  test("storageGbOverride beats the plan quota", async () => {
    const v = await mkVendor()
    const plan = await mkPlan({ storageGb: 5 })
    await mkSubscription(v.id, plan.id)
    await db.saasTenantOverride.create({ data: { vendorId: v.id, storageGbOverride: 50 } })
    invalidateEntitlements(v.id)
    const ent = await resolveEntitlements(v.id)
    expect(ent.limits.STORAGE).toBe(50)
  })
})

describe("SaaS capacity guards", () => {
  test("requireCapacity blocks when the plan limit would be exceeded, with an actionable message", async () => {
    const v = await mkVendor()
    const plan = await mkPlan({ employeeLimit: 2 })
    await mkSubscription(v.id, plan.id)
    invalidateEntitlements(v.id)
    // create 2 employees (both count as active headcount)
    for (let i = 0; i < 2; i++) {
      await db.employee.create({
        data: { vendorId: v.id, code: `E-${code()}`, fullName: `Emp ${i}`, status: "ACTIVE", joiningDate: "2026-01-01" } as any,
      })
    }
    invalidateEntitlements(v.id)
    let err: any = null
    try { await requireCapacity(v.id, "EMPLOYEES", 1) } catch (e) { err = e }
    expect(err).not.toBeNull()
    expect(err.code).toBe(403)
    expect(String(err.message)).toContain("allows 2")
    expect(String(err.message)).toContain("currently have 2")
    expect(String(err.message)).toContain("Upgrade")
  })

  test("requireCapacity passes for LEGACY tenants with any headcount", async () => {
    const v = await mkVendor()
    for (let i = 0; i < 50; i++) {
      await db.employee.create({
        data: { vendorId: v.id, code: `E-${code()}`, fullName: `Emp ${i}`, status: "ACTIVE", joiningDate: "2026-01-01" } as any,
      })
    }
    await requireCapacity(v.id, "EMPLOYEES", 1) // must NOT throw
    expect(true).toBe(true)
  })

  test("readonly subscription blocks mutations with the renewal message", async () => {
    const v = await mkVendor()
    const plan = await mkPlan({ employeeLimit: 100 })
    await mkSubscription(v.id, plan.id, { status: "EXPIRED" })
    invalidateEntitlements(v.id)
    let err: any = null
    try { await requireCapacity(v.id, "EMPLOYEES", 1) } catch (e) { err = e }
    expect(err).not.toBeNull()
    expect(String(err.message)).toContain("expired")
    expect(String(err.message)).toContain("read-only")
  })

  test("unlimited (null) limits always pass", async () => {
    const v = await mkVendor()
    // null must reach the column itself — mkPlan's ?? defaults would turn null into 10
    const plan = await mkPlan({ extra: { employeeLimit: null } })
    await mkSubscription(v.id, plan.id)
    invalidateEntitlements(v.id)
    await requireCapacity(v.id, "EMPLOYEES", 100000) // must NOT throw
    expect(true).toBe(true)
  })
})

describe("subscription math", () => {
  test("cycleEndDate: monthly adds one month, yearly adds one year", () => {
    const start = new Date("2026-01-15T10:00:00Z")
    const m = cycleEndDate(start, "MONTHLY")
    const y = cycleEndDate(start, "YEARLY")
    expect(m.getUTCFullYear()).toBe(2026)
    expect(m.getUTCMonth()).toBe(1) // Feb
    expect(m.getUTCDate()).toBe(15)
    expect(y.getUTCFullYear()).toBe(2027)
    expect(y.getUTCMonth()).toBe(0)
  })

  test("registration status flow: rejected can re-open, approved can only suspend", () => {
    expect(REGISTRATION_STATUS_FLOW.REJECTED).toContain("PENDING")
    expect(REGISTRATION_STATUS_FLOW.APPROVED).toEqual(["SUSPENDED"])
    expect(REGISTRATION_STATUS_FLOW.CANCELLED).toEqual([])
  })
})

describe("platform sequences", () => {
  test("application numbers are monotonic and correctly formatted", async () => {
    const a = await nextApplicationNumber()
    const b = await nextApplicationNumber()
    expect(a).toMatch(/^HRM-\d{4}-\d{6}$/)
    expect(b).toMatch(/^HRM-\d{4}-\d{6}$/)
    expect(Number(b.slice(-6))).toBeGreaterThan(Number(a.slice(-6)))
  })

  test("platform sequence never collides with tenant counter keys", async () => {
    const n = await nextPlatformSequence("unit-test")
    expect(n).toBeGreaterThanOrEqual(1)
    // the row must be scoped with the reserved prefix, not a vendor id
    const row = await db.sequenceCounter.findUnique({ where: { key: `__SAAS__:unit-test` } })
    expect(row).not.toBeNull()
  })
})

describe("owner/tenant plane separation", () => {
  test("an owner session token can never authenticate as a tenant user (and vice versa)", async () => {
    const owner = await db.saasOwnerUser.create({
      data: { email: `${uniq("o")}@owner.local`, name: "Owner", passwordHash: hashOwnerPassword("Xx12Password34!"), roleKey: "SUPER_ADMIN", permissions: "[]" },
    })
    const osId = newToken()
    const os = await db.saasOwnerSession.create({
      data: { id: osId, tokenHash: ownerSessionTokenHash(osId), ownerId: owner.id, csrfToken: newToken(), expiresAt: new Date(Date.now() + 3600_000) },
    })
    // owner token resolves on the owner plane
    const octx = await getOwnerFromToken(os.id)
    expect(octx?.ownerId).toBe(owner.id)
    // the SAME token must NOT resolve on the tenant plane
    const tctx = await getCtxFromToken(os.id)
    expect(tctx).toBeNull()

    // and a tenant session token must not resolve on the owner plane
    const v = await mkVendor()
    const u = await mkUser(v.id, { role: "VENDOR_OWNER" })
    const tsId = newToken()
    const ts = await db.session.create({
      data: { id: tsId, tokenHash: sessionTokenHash(tsId), userId: u.id, kind: "FULL", csrfToken: newToken(), expiresAt: new Date(Date.now() + 3600_000) },
    })
    const t2 = await getOwnerFromToken(ts.id)
    expect(t2).toBeNull()
    const c2 = await getCtxFromToken(ts.id)
    expect(c2?.userId).toBe(u.id)

    // cookie names differ — no accidental cross-read
    expect(OWNER_COOKIE).toBe("saas_owner_session")
  })

  test("owner login lockout increments and locks", async () => {
    const { ownerLogin } = await import("@/hrm-server/saas/owner-auth")
    const email = `${uniq("l")}@owner.local`
    const pw = "Xx12Password34!"
    await db.saasOwnerUser.create({
      data: { email, name: "Locky", passwordHash: hashOwnerPassword(pw), roleKey: "ADMINISTRATOR", permissions: "[]" },
    })
    // 5 wrong attempts (default threshold) → lockedUntil set
    for (let i = 0; i < 5; i++) {
      try { await ownerLogin(email, "wrong-password") } catch { /* expected 401 */ }
    }
    const after = await db.saasOwnerUser.findUnique({ where: { email } })
    expect(after?.lockedUntil).not.toBeNull()
    // correct password now also fails (locked)
    let failed = false
    try { await ownerLogin(email, pw) } catch { failed = true }
    expect(failed).toBe(true)
  })
})

describe("provisioning (transactional tenant creation)", () => {
  test("approving a registration provisions vendor+admin+workflows+leave types+subscription atomically", async () => {
    const plan = await mkPlan({ name: uniq("Prov"), monthlyPrice: 5000 })
    const adminEmail = `${uniq("adm")}@prov.local`
    const reg = await db.saasRegistration.create({
      data: {
        applicationNumber: await nextApplicationNumber(),
        organizationName: "Provision Test Ltd.",
        officialEmail: `info@${code()}.local`,
        adminName: "Prov Admin",
        adminEmail,
        adminPasswordHash: hashPassword("ProvAdmin@2026"),
        employeeCount: 40, branchCount: 2, deviceCount: 1,
        requestedModules: JSON.stringify(["PAYROLL"]),
        planId: plan.id, planName: plan.name, billingCycle: "MONTHLY",
        status: "PENDING",
      },
    })
    const result = await provisionTenant(reg as any, plan.id, { name: "Test Owner" })
    expect(result.vendorId).toBeTruthy()
    expect(result.subscriptionId).toBeTruthy()

    const vendor = await db.vendor.findUnique({ where: { id: result.vendorId } })
    expect(vendor?.active).toBe(true)

    const admin = await db.user.findFirst({ where: { vendorId: result.vendorId, role: "VENDOR_OWNER" } })
    expect(admin?.email).toBe(adminEmail)
    expect(admin?.permissions).toContain("employees.view") // full tenant-admin set

    // password verifies with what the applicant chose
    const { verifyPasswordAsync } = await import("@/hrm-server/auth")
    expect(await verifyPasswordAsync("ProvAdmin@2026", admin!.passwordHash)).toBe(true)

    // statutory config landed — all 15 approval-engine process types
    // (the ASSET_ISSUE workflow joined the provisioning set with the
    // 2026-10-16 asset-issue approval flow; was 14 before it)
    const wfCount = await db.approvalWorkflow.count({ where: { vendorId: result.vendorId } })
    expect(wfCount).toBe(15)
    const ltCount = await db.leaveType.count({ where: { vendorId: result.vendorId } })
    // LVE-113 (R7) — the EARNED duplicate left the provisioning set (ANNUAL
    // is the one earned/annual quota): 7 statutory types.
    expect(ltCount).toBe(7)
    const passwordPolicy = await db.hrSetting.findFirst({ where: { vendorId: result.vendorId, group: "passwordPolicy", key: "expiryDays" } })
    expect(passwordPolicy?.value).toBe("90")

    // subscription snapshot carries the plan price at creation
    const sub = await db.saasSubscription.findUnique({ where: { id: result.subscriptionId } })
    expect(Number(sub?.priceAtCreation)).toBe(5000)
    // Under Part F §10 paid plans provision into PENDING_PAYMENT until settled
    expect(["ACTIVE", "PENDING_PAYMENT"]).toContain(sub!.status)
    // end date = start + 1 month
    const diffDays = ((sub!.endDate ?? new Date()).getTime() - sub!.startDate.getTime()) / 86400000
    expect(diffDays).toBeGreaterThanOrEqual(27)
    expect(diffDays).toBeLessThanOrEqual(32)

    // entitlements resolve to the new plan
    invalidateEntitlements(result.vendorId)
    const ent = await resolveEntitlements(result.vendorId)
    expect(ent.planName).toBe(plan.name)
    expect(ent.mode).toBe("SUBSCRIBED")

    // the admin's password works on the TENANT plane only
    const sessTId = newToken()
    const sessT = await db.session.create({ data: { id: sessTId, tokenHash: sessionTokenHash(sessTId), userId: admin!.id, kind: "FULL", csrfToken: newToken(), expiresAt: new Date(Date.now() + 3600_000) } })
    expect((await getCtxFromToken(sessT.id))?.vendorId).toBe(result.vendorId)
  })

  test("provisioning fails cleanly when the plan does not exist (nothing created)", async () => {
    const reg = await db.saasRegistration.create({
      data: {
        applicationNumber: await nextApplicationNumber(),
        organizationName: "Ghost Plan Ltd.",
        officialEmail: `info@${code()}.local`,
        adminName: "Ghost Admin",
        adminEmail: `${uniq("g")}@ghost.local`,
        adminPasswordHash: hashPassword("GhostAdmin@2026"),
        planId: null, billingCycle: "MONTHLY", status: "PENDING",
      },
    })
    const before = await db.vendor.count()
    let threw = false
    try { await provisionTenant(reg as any, "nonexistent-plan-id", { name: "T" }) } catch { threw = true }
    expect(threw).toBe(true)
    expect(await db.vendor.count()).toBe(before) // no partial tenant
  })
})

describe("platform settings", () => {
  test("getSaasSettings merges stored rows over defaults; save writes through the whitelist", async () => {
    const s1 = await getSaasSettings()
    expect(s1.registration.enabled).toBe(true) // default
    const saved = await saveSaasSettingsGroup("registration", {
      enabled: false,
      allowedBillingCycles: ["YEARLY"],
      messageOnSubmit: "Custom submit message",
      rogueKey: "dropped", // not in the whitelist — must be ignored
    })
    expect(saved.registration.enabled).toBe(false)
    expect(saved.registration.allowedBillingCycles).toEqual(["YEARLY"])
    expect(saved.registration.messageOnSubmit).toBe("Custom submit message")
    expect((saved as any).registration.rogueKey).toBeUndefined()
    // defaults survive for untouched keys
    expect(saved.subscription.gracePeriodDays).toBe(DEFAULT_SAAS_SETTINGS.subscription.gracePeriodDays)
    // restore for other tests
    await saveSaasSettingsGroup("registration", { enabled: true, allowedBillingCycles: ["MONTHLY", "YEARLY"], messageOnSubmit: DEFAULT_SAAS_SETTINGS.registration.messageOnSubmit })
  })
})

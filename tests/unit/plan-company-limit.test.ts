/// <reference types="bun-types" />
// ============ Plan company limit (SaasPlan.companyLimit) ============
// A tenant may run as many ACTIVE companies as its plan allows. NULL = unlimited.
// Existing companies keep working when a tenant is over its limit: only creating
// or reactivating one is refused.
import "./_testdb"
import { describe, test, expect, beforeAll } from "bun:test"
import { db } from "@/lib/db"
import { mkVendor, mkUser, mkSession, uniq, defaultCompanyId } from "./_fixtures"
import { postHrm } from "./_hrm-endpoint"
import { invalidateEntitlements } from "@/hrm-server/saas/entitlements"
import { ownerRoutes } from "@/hrm-server/saas/owner-routes"
import "@/hrm-server/saas/quotas"
import { checkQuotaThresholds } from "@/hrm-server/saas/quotas"
import { getSaasSettings, saveSaasSettingsGroup, invalidateSaasSettings } from "@/hrm-server/saas/settings"
import type { OwnerCtx } from "@/hrm-server/saas/owner-auth"

const owner = { ownerId: "limit-owner", name: "Limit Owner", email: "limit@test.local", roleKey: "SUPER_ADMIN", permissions: new Set(["*", "plans.manage", "tenants.view", "tenants.manage"]) } as unknown as OwnerCtx
const callOwner = async (action: string, payload: unknown) => {
  const def = ownerRoutes[action]
  const parsed = def.schema ? def.schema.parse(payload) : payload
  return (def.handler as any)(owner, parsed)
}

async function mkPlan(companyLimit: number | null) {
  return db.saasPlan.create({
    data: {
      name: uniq("Limit Plan"), monthlyPrice: 1000, yearlyPrice: 10000, currency: "BDT", isPublic: false, active: true,
      companyLimit, employeeLimit: null, userLimit: null, branchLimit: null, departmentLimit: null, deviceLimit: null, trackingEmployeeLimit: null, storageGb: null,
    } as any,
  })
}

/** A subscribed tenant whose fixture owner sits in the default company. */
async function tenant(companyLimit: number | null) {
  const vendor = await mkVendor(uniq("Limit Tenant"))
  const plan = await mkPlan(companyLimit)
  await db.saasSubscription.create({
    data: { vendorId: vendor.id, planId: plan.id, planName: plan.name, status: "ACTIVE", billingCycle: "MONTHLY", startDate: new Date(), endDate: new Date(Date.now() + 30 * 86_400_000), priceAtCreation: 1000, currencySnapshot: "BDT" } as any,
  })
  invalidateEntitlements(vendor.id)
  const user = await mkUser(vendor.id, { role: "VENDOR_OWNER" })
  return { vendor, plan, token: await mkSession(user.id) }
}

const create = (token: string, name = uniq("Co")) => postHrm("companies.create", { name, code: uniq("C").slice(-12) }, { bearer: token })

describe("creating companies", () => {
  test("allowed up to the limit, refused at it, with a message naming the plan and the upgrade", async () => {
    const t = await tenant(2) // the default company is the first
    expect((await create(t.token)).status).toBe(200)
    const denied = await create(t.token)
    expect(denied.status).toBe(403)
    expect(denied.body.error).toContain(t.plan.name)
    expect(denied.body.error).toContain("2 active companies")
    expect(denied.body.error).toContain("Upgrade")
    expect(await db.company.count({ where: { vendorId: t.vendor.id } })).toBe(2)
  })

  test("a limit of 1 means no additional company", async () => {
    const t = await tenant(1)
    expect((await create(t.token)).status).toBe(403)
  })

  test("no limit on the plan means unlimited", async () => {
    const t = await tenant(null)
    for (let i = 0; i < 3; i++) expect((await create(t.token)).status).toBe(200)
  })

  test("a tenant without a subscription keeps working (legacy mode)", async () => {
    const vendor = await mkVendor(uniq("Limit Legacy"))
    const user = await mkUser(vendor.id, { role: "VENDOR_OWNER" })
    expect((await create(await mkSession(user.id))).status).toBe(200)
  })

  test("simultaneous requests cannot both take the last slot", async () => {
    const t = await tenant(2)
    const results = await Promise.all([create(t.token), create(t.token), create(t.token), create(t.token)])
    expect(results.filter((r) => r.status === 200)).toHaveLength(1)
    expect(results.filter((r) => r.status === 403)).toHaveLength(3)
    expect(await db.company.count({ where: { vendorId: t.vendor.id, active: true } })).toBe(2)
  })

  test("one tenant's companies never count against another's limit", async () => {
    const a = await tenant(2)
    const b = await tenant(2)
    expect((await create(a.token)).status).toBe(200)
    expect((await create(b.token)).status).toBe(200)
  })
})

describe("deactivating and reactivating", () => {
  test("deactivating frees a slot; reactivating is refused while the plan is full", async () => {
    const t = await tenant(2)
    const first = await create(t.token)
    expect((await postHrm("companies.deactivate", { id: first.body.data.id, active: false }, { bearer: t.token })).status).toBe(200)
    expect((await create(t.token)).status).toBe(200)

    const again = await postHrm("companies.deactivate", { id: first.body.data.id, active: true }, { bearer: t.token })
    expect(again.status).toBe(403)
    expect((await db.company.findUnique({ where: { id: first.body.data.id } }))?.active).toBe(false)
  })

  test("reactivating works when there is room, and re-activating an active company takes no slot", async () => {
    const t = await tenant(2)
    const first = await create(t.token)
    await postHrm("companies.deactivate", { id: first.body.data.id, active: false }, { bearer: t.token })
    expect((await postHrm("companies.deactivate", { id: first.body.data.id, active: true }, { bearer: t.token })).status).toBe(200)
    // now at the limit: a no-op on an already-active company must not be refused
    expect((await postHrm("companies.deactivate", { id: first.body.data.id, active: true }, { bearer: t.token })).status).toBe(200)
  })
})

describe("a tenant over its limit (downgrade)", () => {
  test("existing companies keep working; only new ones are blocked", async () => {
    const t = await tenant(null)
    const extra = await create(t.token)
    await create(t.token)
    await db.saasPlan.update({ where: { id: t.plan.id }, data: { companyLimit: 1 } })
    invalidateEntitlements(t.vendor.id)

    const list = await postHrm("companies.list", {}, { bearer: t.token })
    expect(list.status).toBe(200)
    expect(list.body.data).toHaveLength(3)
    expect((await postHrm("companies.update", { id: extra.body.data.id, phone: "+8801700000001" }, { bearer: t.token })).status).toBe(200)
    expect((await postHrm("companies.activate", { companyId: extra.body.data.id }, { bearer: t.token })).status).toBe(200)
    expect((await postHrm("employees.list", {}, { bearer: t.token })).status).toBe(200)
    expect((await create(t.token)).status).toBe(403)
    // deactivating is how they get back under, so it must stay possible
    expect((await postHrm("companies.deactivate", { id: extra.body.data.id, active: false }, { bearer: t.token })).status).toBe(200)
  })
})

describe("what the tenant sees", () => {
  test("companies.capacity and the usage panel report used and limit", async () => {
    const t = await tenant(3)
    await create(t.token)
    const cap = await postHrm("companies.capacity", {}, { bearer: t.token })
    expect(cap.body.data).toEqual({ used: 2, limit: 3, planName: t.plan.name })
    const usage = await postHrm("subscription.usage", {}, { bearer: t.token })
    expect(JSON.stringify(usage.body.data)).toContain('"key":"COMPANIES"')
  })

  test("unlimited plans report a null limit", async () => {
    const t = await tenant(null)
    expect((await postHrm("companies.capacity", {}, { bearer: t.token })).body.data.limit).toBeNull()
  })

  test("permissions: a role without companies.view cannot read capacity", async () => {
    const vendor = await mkVendor(uniq("Limit Perm"))
    const emp = await mkUser(vendor.id, { role: "EMPLOYEE", permissions: [] })
    expect((await postHrm("companies.capacity", {}, { bearer: await mkSession(emp.id) })).status).toBe(403)
  })
})

describe("owner console", () => {
  const base = {
    name: "", monthlyPrice: 1000, yearlyPrice: 10000, currency: "BDT",
    employeeLimit: null, userLimit: null, branchLimit: null, departmentLimit: null, deviceLimit: null, storageGb: null, trackingEmployeeLimit: null,
  }

  test("a plan's limit can be set, changed and cleared; the change applies to subscribed tenants", async () => {
    const t = await tenant(null)
    const save = (companyLimit: number | null) => callOwner("owner.plans.save", { ...base, id: t.plan.id, name: t.plan.name, companyLimit })
    await save(1)
    expect((await db.saasPlan.findUnique({ where: { id: t.plan.id } }))?.companyLimit).toBe(1)
    invalidateEntitlements(t.vendor.id)
    expect((await create(t.token)).status).toBe(403)

    await save(null)
    invalidateEntitlements(t.vendor.id)
    expect((await create(t.token)).status).toBe(200)
  })

  test("zero is rejected: every tenant needs its default company", () => {
    expect(() => ownerRoutes["owner.plans.save"].schema!.parse({ ...base, name: "Bad plan", companyLimit: 0 })).toThrow()
  })

  test("saving a plan without the field leaves the limit alone", async () => {
    const plan = await mkPlan(5)
    await callOwner("owner.plans.save", { ...base, id: plan.id, name: plan.name })
    expect((await db.saasPlan.findUnique({ where: { id: plan.id } }))?.companyLimit).toBe(5)
  })

  test("plan duplication carries the limit", async () => {
    const plan = await mkPlan(4)
    const copy = await callOwner("owner.plans.duplicate", { id: plan.id })
    expect((await db.saasPlan.findUnique({ where: { id: copy.id } }))?.companyLimit).toBe(4)
  })

  describe("quota screens: at the limit is normal, only exceeding it is flagged", () => {
    let atLimit: Awaited<ReturnType<typeof tenant>>
    let exceeded: Awaited<ReturnType<typeof tenant>>

    beforeAll(async () => {
      atLimit = await tenant(1)
      exceeded = await tenant(null)
      await create(exceeded.token)
      await db.saasPlan.update({ where: { id: exceeded.plan.id }, data: { companyLimit: 1 } })
    })

    const row = async (name: string) => {
      const m = await callOwner("owner.quotas.matrix", { search: name, pageSize: 5 })
      return m.rows[0]
    }

    test("the matrix shows used and cap, and bands correctly", async () => {
      const a = await row(atLimit.vendor.name)
      expect(a.quotas.COMPANIES).toEqual({ used: 1, cap: 1 })
      expect(a.tier).toBe("OK")
      const b = await row(exceeded.vendor.name)
      expect(b.quotas.COMPANIES).toEqual({ used: 2, cap: 1 })
      expect(b.tier).toBe("OVER")
    })

    test("the overview counts only exceeded tenants as over", async () => {
      const before = (await callOwner("owner.quotas.overview", {})).quotas.find((q: any) => q.key === "COMPANIES")
      const extra = await tenant(1) // a new tenant sitting AT its limit
      const after = (await callOwner("owner.quotas.overview", {})).quotas.find((q: any) => q.key === "COMPANIES")
      expect(after.over).toBe(before.over)
      expect(after.metered).toBe(before.metered + 1)
      expect(extra.vendor.id).toBeTruthy()
    })

    test("the daily alert fires for exceeded tenants only", async () => {
      const prior = (await getSaasSettings()).alerts
      await saveSaasSettingsGroup("alerts", { ...prior, quotaAlertsEnabled: true, quotaThresholdPercent: 90 })
      invalidateSaasSettings()
      try {
        const res = await checkQuotaThresholds(`2099-01-${String(1 + (Date.now() % 28)).padStart(2, "0")}`)
        const companyRows = res.crossings.filter((c) => c.key === "COMPANIES")
        expect(companyRows.some((c) => c.vendorId === exceeded.vendor.id)).toBe(true)
        expect(companyRows.some((c) => c.vendorId === atLimit.vendor.id)).toBe(false)
      } finally {
        await saveSaasSettingsGroup("alerts", prior)
        invalidateSaasSettings()
      }
    })
  })
})

describe("provisioning and defaults", () => {
  test("the default company is stamped on the fixture and counts as the first slot", async () => {
    const t = await tenant(1)
    expect(await defaultCompanyId(t.vendor.id)).toBeTruthy()
    expect((await postHrm("companies.capacity", {}, { bearer: t.token })).body.data.used).toBe(1)
  })

  test("the seeded standard plans ship with no limit until the owner sets one", async () => {
    const { readFileSync } = await import("fs")
    const src = readFileSync(`${import.meta.dir}/../../src/hrm-server/saas/seed-saas.ts`, "utf8")
    expect(src).not.toContain("companyLimit")
  })
})

/// <reference types="bun-types" />
// ============ Phase 5 P1 — Lifecycle console + Quota utilization + alerts ====
// Covers the P1 (Lifecycle & Quotas) delivery:
//   1. owner.lifecycle.overview — stage counts vs the subscription table's own
//      truth (+ the NOT EXISTS LEGACY anti-join), renewal-pipeline buckets,
//      7d/30d movement windows, and the trial counters — every number is
//      compared against the database's own truth, never a fixed snapshot.
//   2. owner.lifecycle.events — DESC ordering, pagination without duplicates,
//      type + search filters narrowing in SQL.
//   3. owner.quotas.overview — per-key band counts via before/after DIFFS
//      around a fixture set (immune to other suites' rows): over at cap,
//      near at 85–99%, unlimited for null caps.
//   4. owner.quotas.matrix — band exactness (OVER at cap, NEAR at 85–99%,
//      OK below), worst-first ordering, chip filters, cell math, unlimited
//      cells, pagination, and the storage OVERRIDE winning over the plan cap.
//   5. checkQuotaThresholds — the daily pass: crossings at/above threshold,
//      exclusions (sub-cap, non-operating, unlimited), monthly dedupe +
//      re-arm, webhook SKIPPED when unconfigured (never throws), master
//      switch off, and the 50–100 clamp of the configured percentage.
import "./_testdb"
import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { db } from "@/lib/db"
import { mkVendor, mkUser, mkEmployee, mkBranch, uniq } from "./_fixtures"
import { ownerRoutes } from "@/hrm-server/saas/owner-routes"
// side-effect imports — owner.lifecycle.* / owner.quotas.* self-register into
// ownerRoutes exactly like the /api/owner dispatcher imports them
import "@/hrm-server/saas/lifecycle-console"
import "@/hrm-server/saas/quotas"
import { invalidateSaasSettings, getSaasSettings, saveSaasSettingsGroup } from "@/hrm-server/saas/settings"
import { checkQuotaThresholds } from "@/hrm-server/saas/quotas"
import type { OwnerCtx } from "@/hrm-server/saas/owner-auth"

let ctx: OwnerCtx

const call = async (action: string, payload: any) => {
  const def = ownerRoutes[action]
  if (!def) throw new Error(`unknown owner action: ${action}`)
  const parsed = def.schema ? def.schema.parse(payload) : payload
  return (def.handler as any)(ctx, parsed)
}

const GB = 1073741824
const DAY = 86400000

async function mkPlan(name: string, limits: Record<string, number | null> = {}) {
  return db.saasPlan.create({
    data: {
      name, monthlyPrice: 1000, yearlyPrice: 10000, currency: "BDT", isPublic: true, active: true, sortOrder: 1,
      employeeLimit: limits.EMPLOYEES ?? null,
      userLimit: limits.USERS ?? null,
      branchLimit: limits.BRANCHES ?? null,
      departmentLimit: limits.DEPARTMENTS ?? null,
      deviceLimit: limits.DEVICES ?? null,
      trackingEmployeeLimit: limits.TRACKING_EMPLOYEES ?? null,
      storageGb: limits.STORAGE ?? null,
    } as any,
  })
}

async function mkSub(vendorId: string, planId: string, over: Record<string, unknown> = {}) {
  return db.saasSubscription.create({
    data: {
      vendorId, planId, planName: "P1 Plan", status: "ACTIVE", billingCycle: "MONTHLY",
      startDate: new Date(), endDate: new Date(Date.now() + 30 * DAY),
      priceAtCreation: 1000, currencySnapshot: "BDT",
      ...over,
    } as any,
  })
}

async function seedEvent(sub: { id: string; vendorId: string }, type: string, daysAgo: number, note = "p1 fixture") {
  return db.saasSubscriptionEvent.create({
    data: {
      subscriptionId: sub.id, vendorId: sub.vendorId, type,
      note, actorName: "P1 Fixture",
      createdAt: new Date(Date.now() - daysAgo * DAY),
    } as any,
  })
}

async function seedStorage(vendorId: string, bytes: number) {
  await db.usageRollup.upsert({
    where: { vendorId },
    create: { vendorId, storageBytes: BigInt(Math.round(bytes)) },
    update: { storageBytes: BigInt(Math.round(bytes)) },
  })
}

beforeAll(() => {
  ctx = {
    ownerId: "p1-owner-" + uniq("o"),
    name: "P1 Console Owner",
    email: "p1-owner@test.example",
    roleKey: "SUPER_ADMIN",
    permissions: new Set(["dashboard.view", "tenants.view", "subscriptions.view", "settings.view", "settings.manage", "health.view"]),
  }
})

// ----------------------------------------------------------------------------
describe("P1 — owner.lifecycle.overview (stages / pipeline / movement / trials)", () => {
  const TAG = uniq("p1lc")
  let sub: any

  beforeAll(async () => {
    const plan = await mkPlan(`${TAG} plan`)
    const v = await mkVendor(`${TAG} Events Co`)
    await mkUser(v.id, { role: "VENDOR_OWNER" })
    sub = await mkSub(v.id, plan.id)
  })

  test("stage counts agree with the subscription table + the LEGACY anti-join", async () => {
    const o = await call("owner.lifecycle.overview", {})
    const rows = await db.saasSubscription.groupBy({ by: ["status"], _count: { _all: true } })
    for (const r of rows) {
      expect(o.stages[r.status] ?? 0).toBe(Number(r._count?._all || 0))
    }
    const legacy = await db.$queryRawUnsafe<Array<{ c: number }>>(
      `SELECT COUNT(*)::int AS c FROM "Vendor" v WHERE NOT EXISTS (SELECT 1 FROM "SaaSSubscription" s WHERE s."vendorId" = v."id")`,
    )
    expect(o.stages.LEGACY).toBe(Number(legacy[0]?.c || 0))
    // every stored status is surfaced — nothing silently dropped
    const storedStatuses = new Set(rows.map((r: any) => r.status))
    for (const s of storedStatuses) expect(Object.keys(o.stages)).toContain(s)
  })

  test("pipeline buckets are exact (SQL CASE vs the same bucketing in JS)", async () => {
    // seed one fixture per bucket (plus the already-seeded 30d sub → DUE_8_30)
    const plan = await db.saasPlan.findFirstOrThrow({ where: { name: { startsWith: TAG } } })
    const mk = async (name: string, endOffsetDays: number, over: Record<string, unknown> = {}) => {
      const v = await mkVendor(`${TAG} ${name}`)
      return mkSub(v.id, plan.id, { endDate: new Date(Date.now() + endOffsetDays * DAY), ...over })
    }
    await mk("Bucket 5d", 5)                                    // DUE_0_7
    await mk("Bucket 20d", 20)                                  // DUE_8_30
    await mk("Bucket 45d", 45)                                  // DUE_31_60
    await mk("Bucket Overdue", -3)                              // OVERDUE (term ended, still ACTIVE)

    const o = await call("owner.lifecycle.overview", {})
    const subs = await db.saasSubscription.findMany({
      where: { status: { in: ["TRIAL", "ACTIVE", "PAST_DUE", "GRACE_PERIOD"] }, endDate: { lt: new Date(Date.now() + 60 * DAY) } },
      select: { endDate: true },
    })
    const expectd: Record<string, number> = { OVERDUE: 0, DUE_0_7: 0, DUE_8_30: 0, DUE_31_60: 0 }
    for (const s of subs) {
      const t = s.endDate!.getTime()
      if (t < Date.now()) expectd.OVERDUE++
      else if (t <= Date.now() + 7 * DAY) expectd.DUE_0_7++
      else if (t <= Date.now() + 30 * DAY) expectd.DUE_8_30++
      else expectd.DUE_31_60++
    }
    expect(o.pipeline.OVERDUE).toBe(expectd.OVERDUE)
    expect(o.pipeline.DUE_0_7).toBe(expectd.DUE_0_7)
    expect(o.pipeline.DUE_8_30).toBe(expectd.DUE_8_30)
    expect(o.pipeline.DUE_31_60).toBe(expectd.DUE_31_60)
  })

  test("movement windows: 7d vs 30d agree with the event table's own truth", async () => {
    await seedEvent(sub, "EXTENDED", 3, "extended 1 month")
    await seedEvent(sub, "SUSPENDED", 3, "non-payment")
    await seedEvent(sub, "EXPIRED", 12, "grace exhausted")

    const o = await call("owner.lifecycle.overview", {})
    const d7 = new Date(Date.now() - 7 * DAY)
    const d30 = new Date(Date.now() - 30 * DAY)
    const [g7, g30] = await Promise.all([
      db.saasSubscriptionEvent.groupBy({ by: ["type"], _count: { _all: true }, where: { createdAt: { gte: d7 } } }),
      db.saasSubscriptionEvent.groupBy({ by: ["type"], _count: { _all: true }, where: { createdAt: { gte: d30 } } }),
    ])
    const m7 = new Map<string, number>((o.movement7d as { type: string; count: number }[]).map((m) => [m.type, m.count] as [string, number]))
    const m30 = new Map<string, number>((o.movement30d as { type: string; count: number }[]).map((m) => [m.type, m.count] as [string, number]))
    for (const r of g7) {
      expect(m7.get(r.type) ?? 0).toBe(Number(r._count?._all || 0))
    }
    for (const r of g30) {
      expect(m30.get(r.type) ?? 0).toBe(Number(r._count?._all || 0))
      // a 7d-window row must also appear in the 30d window
      expect(m30.get(r.type) ?? 0).toBeGreaterThanOrEqual(m7.get(r.type) ?? 0)
    }
    // the 12d-old EXPIRED event is inside the 30d window (my fixture guarantees
    // at least one), and the 7d/30d equalities above prove the window boundaries
    expect(m30.get("EXPIRED") ?? 0).toBeGreaterThan(0)
    // movement rows are sorted by count, descending
    const counts = o.movement30d.map((m: any) => m.count)
    expect([...counts].sort((a: number, b: number) => b - a)).toEqual(counts)
  })

  test("trial counters agree with the table", async () => {
    const plan = await db.saasPlan.findFirstOrThrow({ where: { name: { startsWith: TAG } } })
    const v = await mkVendor(`${TAG} Trial Co`)
    await mkSub(v.id, plan.id, { status: "TRIAL", endDate: new Date(Date.now() + 10 * DAY) })
    const v2 = await mkVendor(`${TAG} Trial Far`)
    await mkSub(v2.id, plan.id, { status: "TRIAL", endDate: new Date(Date.now() + 90 * DAY) })

    const o = await call("owner.lifecycle.overview", {})
    const current = await db.saasSubscription.count({ where: { status: "TRIAL" } })
    const soon = await db.saasSubscription.count({
      where: { status: "TRIAL", endDate: { gte: new Date(), lte: new Date(Date.now() + 21 * DAY) } },
    })
    expect(o.trials.current).toBe(current)
    expect(o.trials.endingSoon21d).toBe(soon)
    expect(o.trials.endingSoon21d).toBeGreaterThanOrEqual(1) // the 10d fixture
  })
})

// ----------------------------------------------------------------------------
describe("P1 — owner.lifecycle.events (paged in SQL, filtered in SQL)", () => {
  const TAG = uniq("p1ev")
  let subA: any, subB: any

  beforeAll(async () => {
    const plan = await mkPlan(`${TAG} plan`)
    const a = await mkVendor(`${TAG} Alpha Co`)
    const b = await mkVendor(`${TAG} Beta Co`)
    await mkUser(a.id, { role: "VENDOR_OWNER" })
    subA = await mkSub(a.id, plan.id)
    subB = await mkSub(b.id, plan.id)
    // 5 events with distinct timestamps: DESC order is fully determined
    await seedEvent(subA, "CREATED", 9)
    await seedEvent(subA, "EXTENDED", 8)
    await seedEvent(subB, "PLAN_CHANGED", 7)
    await seedEvent(subA, "SUSPENDED", 6)
    await seedEvent(subB, "REACTIVATED", 5)
  })

  test("pagination returns every row exactly once, newest first", async () => {
    const seen: string[] = []
    let page = 1
    for (;;) {
      const d = await call("owner.lifecycle.events", { page, pageSize: 2, search: TAG })
      for (const r of d.rows) seen.push(`${r.createdAt.toISOString()}|${r.id}`)
      if (page * 2 >= d.total || d.rows.length === 0) break
      page++
    }
    const unique = new Set(seen)
    expect(unique.size).toBe(seen.length) // no duplicates across pages
    // this suite's rows: newest first, strictly descending
    const ts = seen.map((s) => s.split("|")[0]).map((s) => new Date(s).getTime())
    for (let i = 1; i < ts.length; i++) expect(ts[i]).toBeLessThanOrEqual(ts[i - 1])
  })

  test("type filter narrows in SQL (total follows)", async () => {
    const d = await call("owner.lifecycle.events", { page: 1, pageSize: 50, search: TAG, type: "EXTENDED" })
    const truth = await db.saasSubscriptionEvent.count({ where: { type: "EXTENDED", vendorId: { in: [subA.vendorId, subB.vendorId] } } })
    expect(d.total).toBe(truth)
    expect(d.rows.every((r: any) => r.type === "EXTENDED")).toBe(true)
    expect(d.rows.length).toBe(truth)
  })

  test("search narrows by vendor name and deep-links carry ids", async () => {
    const d = await call("owner.lifecycle.events", { page: 1, pageSize: 50, search: `${TAG} Alpha` })
    expect(d.total).toBeGreaterThanOrEqual(2) // CREATED + EXTENDED + SUSPENDED for Alpha
    expect(d.rows.every((r: any) => r.vendorName.startsWith(`${TAG} Alpha`))).toBe(true)
    expect(d.rows[0].vendorId).toBeTruthy()
    expect(d.rows[0].vendorCode).toBeTruthy()
  })
})

// ----------------------------------------------------------------------------
describe("P1 — owner.quotas.overview (per-key bands via before/after diffs)", () => {
  const TAG = uniq("p1qo")

  test("diffs around a fixture set: over at cap, near at 85–99%, unlimited for null caps", async () => {
    const before = await call("owner.quotas.overview", {})
    const beforeByKey = new Map((before.quotas as any[]).map((q) => [q.key, q]))

    // plan: EMPLOYEES 10 (metered), USERS 5, BRANCHES null (unlimited),
    // DEPARTMENTS 5, DEVICES 2, TRACKING null, STORAGE 1GB
    const plan = await mkPlan(`${TAG} plan`, { EMPLOYEES: 10, USERS: 5, BRANCHES: null, DEPARTMENTS: 5, DEVICES: 2, TRACKING_EMPLOYEES: null, STORAGE: 1 })
    const over = await mkVendor(`${TAG} Over Co`)
    const near = await mkVendor(`${TAG} Near Co`)
    const ok = await mkVendor(`${TAG} Ok Co`)
    await Promise.all([
      mkSub(over.id, plan.id), mkSub(near.id, plan.id), mkSub(ok.id, plan.id),
    ])
    // T_over: 12 employees (OVER), 1 user (ok), 0.9→1.5GB storage (OVER)
    await Promise.all([mkEmployee(over.id), mkEmployee(over.id), mkEmployee(over.id), mkEmployee(over.id),
      mkEmployee(over.id), mkEmployee(over.id), mkEmployee(over.id), mkEmployee(over.id),
      mkEmployee(over.id), mkEmployee(over.id), mkEmployee(over.id), mkEmployee(over.id)])
    await mkUser(over.id, { role: "VENDOR_OWNER" }) // 1 user — counts toward USERS as ok
    await seedStorage(over.id, 1.5 * GB)
    // T_near: 9 employees (NEAR at 90%), 0.9GB storage (NEAR at 90%)
    for (let i = 0; i < 9; i++) await mkEmployee(near.id)
    await seedStorage(near.id, 0.9 * GB)
    // T_ok: 1 employee, 1 user, 0.1GB
    await mkEmployee(ok.id)
    await mkUser(ok.id, { role: "VENDOR_OWNER" })
    await seedStorage(ok.id, 0.1 * GB)
    // a legacy tenant (no subscription row) — counted, never banded
    await mkVendor(`${TAG} Legacy Co`)

    const after = await call("owner.quotas.overview", {})
    const byKey = new Map((after.quotas as any[]).map((q) => [q.key, q]))
    const diff = (key: string, field: string) =>
      Number(byKey.get(key)?.[field] ?? 0) - Number(beforeByKey.get(key)?.[field] ?? 0)

    expect(diff("EMPLOYEES", "over")).toBe(1)      // 12/10
    expect(diff("EMPLOYEES", "near")).toBe(1)      // 9/10 = 90%
    expect(diff("EMPLOYEES", "metered")).toBe(3)
    expect(diff("EMPLOYEES", "unlimited")).toBe(0)
    expect(diff("USERS", "over")).toBe(0)          // 1/5 and 1/5 — never at cap
    expect(diff("USERS", "near")).toBe(0)          // 20% < 85%
    expect(diff("USERS", "metered")).toBe(3)
    expect(diff("BRANCHES", "metered")).toBe(0)    // branchLimit null on the plan
    expect(diff("BRANCHES", "unlimited")).toBe(3)
    expect(diff("STORAGE", "over")).toBe(1)        // 1.5GB / 1GB
    expect(diff("STORAGE", "near")).toBe(1)        // 0.9GB / 1GB = 90%
    expect(diff("STORAGE", "unlimited")).toBe(0)
    expect(diff("DEVICES", "metered")).toBe(3)
    expect(diff("TRACKING_EMPLOYEES", "unlimited")).toBe(3)
    // fleet counters
    expect(after.subscribedTenants - before.subscribedTenants).toBe(3)
    expect(after.legacyTenants - before.legacyTenants).toBe(1)
    // response invariants: all 7 keys present, policy clamped into 50..100
    expect(new Set((after.quotas as any[]).map((q) => q.key)).size).toBe(7)
    expect(after.alertPolicy.thresholdPercent).toBeGreaterThanOrEqual(50)
    expect(after.alertPolicy.thresholdPercent).toBeLessThanOrEqual(100)
    expect(typeof after.alertPolicy.enabled).toBe("boolean")
  })
})

// ----------------------------------------------------------------------------
describe("P1 — owner.quotas.matrix (bands, ordering, filters, override)", () => {
  const TAG = uniq("p1qm")
  let overId = "", nearId = "", okId = "", storId = "", plan: any

  beforeAll(async () => {
    plan = await mkPlan(`${TAG} plan`, { EMPLOYEES: 10, USERS: 5, BRANCHES: null, DEPARTMENTS: 5, DEVICES: 2, TRACKING_EMPLOYEES: null, STORAGE: 1 })
    // M_over — employees AT cap (10/10): OVER by the no-headroom rule
    const over = await mkVendor(`${TAG} Over Co`)
    overId = over.id
    await mkSub(over.id, plan.id)
    for (let i = 0; i < 10; i++) await mkEmployee(over.id)
    await mkUser(over.id, { role: "VENDOR_OWNER" })
    await seedStorage(over.id, 0.2 * GB)
    // M_near — 9/10 employees = 90%
    const near = await mkVendor(`${TAG} Near Co`)
    nearId = near.id
    await mkSub(near.id, plan.id)
    for (let i = 0; i < 9; i++) await mkEmployee(near.id)
    await seedStorage(near.id, 0.5 * GB)
    // M_ok — everything low
    const okV = await mkVendor(`${TAG} Ok Co`)
    okId = okV.id
    await mkSub(okV.id, plan.id)
    await mkEmployee(okV.id)
    await mkUser(okV.id, { role: "VENDOR_OWNER" })
    await mkBranch(okV.id)
    await seedStorage(okV.id, 0.1 * GB)
    // M_stor — employees fine (2/10) but storage 1.5GB / 1GB plan cap
    const stor = await mkVendor(`${TAG} Storage Co`)
    storId = stor.id
    await mkSub(stor.id, plan.id)
    await mkEmployee(stor.id); await mkEmployee(stor.id)
    await seedStorage(stor.id, 1.5 * GB)
  })

  test("tiers are exact and worst-first; cells carry the SQL numbers", async () => {
    const d = await call("owner.quotas.matrix", { page: 1, pageSize: 10, search: TAG })
    const byId = new Map<string, any>((d.rows as any[]).map((r: any) => [r.id, r] as [string, any]))
    expect(d.rows.length).toBe(4)
    expect(byId.get(overId)?.tier).toBe("OVER")
    expect(byId.get(nearId)?.tier).toBe("NEAR")
    expect(byId.get(okId)?.tier).toBe("OK")
    expect(byId.get(storId)?.tier).toBe("OVER") // via the STORAGE leg of the CASE
    // worst-first ordering: OVER rows before NEAR before OK
    const tiers = d.rows.map((r: any) => r.tier)
    const rank = (t: string) => (t === "OVER" ? 0 : t === "NEAR" ? 1 : 2)
    for (let i = 1; i < tiers.length; i++) expect(rank(tiers[i])).toBeGreaterThanOrEqual(rank(tiers[i - 1]))
    // cell math — the numbers the bars are drawn from
    const overRow: any = byId.get(overId)
    expect(overRow.quotas.EMPLOYEES).toEqual({ used: 10, cap: 10 })
    expect(overRow.quotas.USERS).toEqual({ used: 1, cap: 5 })
    expect(overRow.quotas.BRANCHES).toEqual({ used: 0, cap: null }) // unlimited plan leg
    const nearRow: any = byId.get(nearId)
    expect(nearRow.quotas.EMPLOYEES).toEqual({ used: 9, cap: 10 })
    const storRow: any = byId.get(storId)
    expect(storRow.quotas.STORAGE).toEqual({ usedBytes: Math.round(1.5 * GB), capGb: 1 })
    expect(storRow.quotas.EMPLOYEES).toEqual({ used: 2, cap: 10 })
    // admin LATERAL resolved the owner email
    expect(overRow.admin?.email).toBeTruthy()
  })

  test("chip filters narrow in SQL (OVER / NEAR / OK)", async () => {
    const overPage = await call("owner.quotas.matrix", { page: 1, pageSize: 10, search: TAG, tier: "OVER" })
    expect(overPage.rows.map((r: any) => r.id).sort()).toEqual([overId, storId].sort())
    const nearPage = await call("owner.quotas.matrix", { page: 1, pageSize: 10, search: TAG, tier: "NEAR" })
    expect(nearPage.rows.map((r: any) => r.id)).toEqual([nearId])
    const okPage = await call("owner.quotas.matrix", { page: 1, pageSize: 10, search: TAG, tier: "OK" })
    expect(okPage.rows.map((r: any) => r.id)).toEqual([okId])
  })

  test("pageSize-2 pagination walks the set with no duplicates", async () => {
    const seen: string[] = []
    const p1 = await call("owner.quotas.matrix", { page: 1, pageSize: 2, search: TAG })
    const p2 = await call("owner.quotas.matrix", { page: 2, pageSize: 2, search: TAG })
    expect(p1.total).toBe(4)
    expect(p2.total).toBe(4)
    expect(p1.page).toBe(1)
    expect(p2.page).toBe(2)
    seen.push(...p1.rows.map((r: any) => r.id), ...p2.rows.map((r: any) => r.id))
    expect(new Set(seen).size).toBe(4)
  })

  test("a per-tenant storage OVERRIDE wins over the plan cap (and un-overds the row)", async () => {
    await db.saasTenantOverride.create({ data: { vendorId: storId, storageGbOverride: 5 } as any })
    try {
      const d = await call("owner.quotas.matrix", { page: 1, pageSize: 10, search: TAG })
      const stor: any = d.rows.find((r: any) => r.id === storId)
      // 1.5GB used vs the 5GB override → under cap → the row is no longer OVER via storage
      expect(stor.tier).toBe("OK")
      expect(stor.quotas.STORAGE).toEqual({ usedBytes: Math.round(1.5 * GB), capGb: 5 })
      // other rows' caps are untouched by this tenant's override
      const over: any = d.rows.find((r: any) => r.id === overId)
      expect(over.quotas.STORAGE.capGb).toBe(1)
    } finally {
      // keep the row (realistic) but drop the override so the threshold suite
      // below sees the plan cap again
      await db.saasTenantOverride.deleteMany({ where: { vendorId: storId } })
    }
  })
})

// ----------------------------------------------------------------------------
describe("P1 — checkQuotaThresholds (the daily pass)", () => {
  const TAG = uniq("p1qa")
  let hitId = "", missId = "", expId = "", unlId = ""

  beforeAll(async () => {
    // reset the alerts group to a known state (other suites may have left a
    // live webhook URL configured — the pass would then really POST to it)
    await saveSaasSettingsGroup("alerts", {
      webhookUrl: "", webhookSecret: "", webhookOnBackupFailure: true,
      quotaAlertsEnabled: true, quotaThresholdPercent: 90,
    })
    invalidateSaasSettings()

    const plan = await mkPlan(`${TAG} plan`, { EMPLOYEES: 100 }) // everything else unlimited
    const unlimitedPlan = await mkPlan(`${TAG} unlimited plan`, {})

    const hit = await mkVendor(`${TAG} Hit Co`)
    hitId = hit.id
    await mkSub(hit.id, plan.id)
    for (let i = 0; i < 95; i++) await mkEmployee(hit.id) // 95% ≥ 90%

    const miss = await mkVendor(`${TAG} Miss Co`)
    missId = miss.id
    await mkSub(miss.id, plan.id)
    for (let i = 0; i < 89; i++) await mkEmployee(miss.id) // 89% < 90%

    const exp = await mkVendor(`${TAG} Expired Co`)
    expId = exp.id
    await mkSub(exp.id, plan.id, { status: "EXPIRED", endDate: new Date(Date.now() - 5 * DAY) })
    for (let i = 0; i < 95; i++) await mkEmployee(exp.id) // over but read-only — excluded

    const unl = await mkVendor(`${TAG} Unlimited Co`)
    unlId = unl.id
    await mkSub(unl.id, unlimitedPlan.id, { status: "TRIAL" })
    for (let i = 0; i < 200; i++) await mkEmployee(unl.id) // cap null — never alerts
  })

  test("crossings at/above the threshold; exclusions honored; webhook SKIPPED when unconfigured", async () => {
    const res = await checkQuotaThresholds("2026-10-22")
    expect(res.enabled).toBe(true)
    expect(res.thresholdPercent).toBe(90)
    expect(res.totalCrossings).toBeGreaterThan(0)
    // my hit tenant is present exactly once for EMPLOYEES
    const mine = res.crossings.filter((c) => c.vendorId === hitId)
    expect(mine.length).toBe(1)
    expect(mine[0]).toMatchObject({ key: "EMPLOYEES", used: 95, cap: 100 })
    // the exclusions never appear
    expect(res.crossings.some((c) => c.vendorId === missId)).toBe(false)  // 89% < 90%
    expect(res.crossings.some((c) => c.vendorId === expId)).toBe(false)   // non-operating
    expect(res.crossings.some((c) => c.vendorId === unlId)).toBe(false)   // unlimited
    // the digest channels ran best-effort — SKIPPED (no URL), never a throw
    expect(res.webhook?.status).toBe("SKIPPED")
    expect(res.email && typeof res.email.sent).toBe("number")
    // the dedupe rows landed (group "jobs", monthly key)
    const deduped = await db.saasSetting.findMany({ where: { group: "jobs", key: { startsWith: `quota-alert:${hitId}:EMPLOYEES:` } } })
    expect(deduped.length).toBe(1)
    expect(deduped[0].key).toContain("2026-10")
  })

  test("second same-date run: crossing still true, but not fresh (monthly dedupe)", async () => {
    const res = await checkQuotaThresholds("2026-10-22")
    expect(res.totalCrossings).toBeGreaterThan(0)   // still crossing — the state is unchanged
    expect(res.freshCrossings).toBe(0)              // but nothing new this month
    expect(res.crossings.some((c) => c.vendorId === hitId)).toBe(false)
    expect(res.webhook).toBeNull()                  // no fresh rows → no digest fired
    // and the next month re-arms (a fresh nudge without daily spam)
    const nextMonth = await checkQuotaThresholds("2026-11-01")
    expect(nextMonth.crossings.some((c) => c.vendorId === hitId && c.key === "EMPLOYEES")).toBe(true)
    const deduped = await db.saasSetting.findMany({ where: { group: "jobs", key: { startsWith: `quota-alert:${hitId}:EMPLOYEES:` } } })
    expect(deduped.length).toBe(2) // 2026-10 + 2026-11
  })

  test("master switch off → early return, no crossings processed", async () => {
    await saveSaasSettingsGroup("alerts", { quotaAlertsEnabled: false })
    invalidateSaasSettings()
    const res = await checkQuotaThresholds("2026-12-01")
    expect(res.enabled).toBe(false)
    expect(res.crossings).toEqual([])
    expect(res.totalCrossings).toBe(0)
    expect(res.webhook).toBeNull()
  })

  test("the configured percentage clamps into 50..100 at the read site", async () => {
    await saveSaasSettingsGroup("alerts", { quotaAlertsEnabled: true, quotaThresholdPercent: 150 })
    invalidateSaasSettings()
    let res = await checkQuotaThresholds("2026-12-02")
    expect(res.thresholdPercent).toBe(100)
    await saveSaasSettingsGroup("alerts", { quotaThresholdPercent: 40 })
    invalidateSaasSettings()
    res = await checkQuotaThresholds("2026-12-03")
    expect(res.thresholdPercent).toBe(50)
    // and the overview surface agrees (the Quota page policy strip)
    const o = await call("owner.quotas.overview", {})
    expect(o.alertPolicy.thresholdPercent).toBeGreaterThanOrEqual(50)
    expect(o.alertPolicy.thresholdPercent).toBeLessThanOrEqual(100)
  })

  test("settings round-trip through the whitelist", async () => {
    await saveSaasSettingsGroup("alerts", { quotaAlertsEnabled: true, quotaThresholdPercent: 75 })
    invalidateSaasSettings()
    const settings = await getSaasSettings()
    expect(settings.alerts.quotaAlertsEnabled).toBe(true)
    expect(settings.alerts.quotaThresholdPercent).toBe(75)
  })

  afterAll(async () => {
    // leave the alerts group in the shipped default state for other suites
    await saveSaasSettingsGroup("alerts", {
      webhookUrl: "", webhookSecret: "", webhookOnBackupFailure: true,
      quotaAlertsEnabled: true, quotaThresholdPercent: 90,
    })
    invalidateSaasSettings()
    // drop every dedupe marker this file's passes wrote (only this suite uses
    // the quota-alert: key pattern — verified by grep across tests/unit)
    await db.saasSetting.deleteMany({ where: { group: "jobs", key: { startsWith: "quota-alert:" } } })
  })
})

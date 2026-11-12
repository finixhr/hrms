/// <reference types="bun-types" />
// ============ Phase 5 P5 — Tenants & Subscriptions console ===================
// Covers the P5 delivery (owner.customers.overview + owner.subscriptions.overview
// + the REWRITTEN owner.renewals.list in src/hrm-server/saas/customers-console.ts):
//   1. owner.customers.overview — the Tenants page KPI strip vs full-table DB
//      truth (total / active / LEGACY anti-join / trials / new signups 7d+30d
//      with the 40d-old exclusion), the renewal-window trio vs an independent
//      JS re-computation over the same operating-status filter, the fleet
//      counters, and the planOptions shape.
//   2. owner.subscriptions.overview — the status mix vs the database's own
//      groupBy (every status that exists surfaces; the canonical keys are
//      always present, zeros honest; LEGACY from the same anti-join), pending
//      plan-change requests as an exact before/after DIFF, the plan census vs
//      DB truth, and the renewal windows riding identically.
//   3. owner.renewals.list (REWRITE) — window exactness at the fractional-day
//      boundaries (6.5d in ≤7, 7.5d not; 29.5d in ≤30, 30.5d not), the CEIL
//      daysRemaining arithmetic IN SQL vs the Math.ceil JS semantics, the
//      CANCELLED / SUSPENDED exclusions, soonest-endDate-first ordering, the
//      summary block vs the windows, the settings shape (grace + reminders),
//      and pageSize pagination without duplicates.
//   4. owner.planchangerequests.list — the pagination contract the rebuilt
//      Plan Requests page now rides (pageSize walk, no duplicates).
import "./_testdb"
import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { db } from "@/lib/db"
import { mkVendor, uniq } from "./_fixtures"
import { ownerRoutes } from "@/hrm-server/saas/owner-routes"
// side-effect imports — the P5 actions self-register into ownerRoutes
// exactly like the /api/owner dispatcher imports them (the REWRITTEN
// owner.renewals.list registers here; owner-routes.ts no longer defines it)
import "@/hrm-server/saas/customers-console"
import type { OwnerCtx } from "@/hrm-server/saas/owner-auth"

let ctx: OwnerCtx

const call = async (action: string, payload: any) => {
  const def = ownerRoutes[action]
  if (!def) throw new Error(`unknown owner action: ${action}`)
  const parsed = def.schema ? def.schema.parse(payload) : payload
  return (def.handler as any)(ctx, parsed)
}

const DAY = 86_400_000
const dAgo = (days: number) => new Date(Date.now() - days * DAY)
const dAhead = (days: number) => new Date(Date.now() + days * DAY)

/** The operating statuses the renewal calendar tracks (RENEWAL_STATUSES in
 *  customers-console.ts — mirrored here so the truth is independently
 *  written, never imported from the module under test). */
const OPERATING = ["TRIAL", "ACTIVE", "PAST_DUE", "GRACE_PERIOD", "EXPIRED"]

beforeAll(() => {
  ctx = {
    ownerId: "p5-owner-" + uniq("o"),
    name: "P5 Customers Owner",
    email: "p5-owner@test.example",
    roleKey: "SUPER_ADMIN",
    permissions: new Set(["tenants.view", "subscriptions.view"]),
  } as OwnerCtx
})

// ----------------------------------------------------------------------------
describe("P5 — owner.customers.overview (the Tenants page KPI strip)", () => {
  const TAG = uniq("p5cu")
  const vendorIds: string[] = []
  let planId: string

  beforeAll(async () => {
    const plan = await db.saasPlan.create({ data: { name: `${TAG} Plan`, monthlyPrice: 1000, yearlyPrice: 12000, currency: "BDT", isPublic: false, active: true, sortOrder: 800 } as any })
    planId = plan.id
    // vendor WITHOUT a subscription → LEGACY
    const legacy = await mkVendor(`${TAG} Legacy Co`)
    vendorIds.push(legacy.id)
    // vendor created 40d ago with an ACTIVE sub ending in 45d → new30d EXCLUDES
    const old = await mkVendor(`${TAG} Forty Day Co`)
    vendorIds.push(old.id)
    await db.vendor.update({ where: { id: old.id }, data: { createdAt: dAgo(40) } })
    await db.saasSubscription.create({
      data: { vendorId: old.id, planId, planName: `${TAG} Plan`, status: "ACTIVE", billingCycle: "MONTHLY", startDate: dAgo(40), endDate: dAhead(45), priceAtCreation: 1000, currencySnapshot: "BDT" } as any,
    })
    // fresh vendor (created now) with a TRIAL sub ending in 6.5d → in ≤7
    const fresh = await mkVendor(`${TAG} Fresh Co`)
    vendorIds.push(fresh.id)
    await db.saasSubscription.create({
      data: { vendorId: fresh.id, planId, planName: `${TAG} Plan`, status: "TRIAL", billingCycle: "MONTHLY", startDate: new Date(), endDate: dAhead(6.5), priceAtCreation: 500, currencySnapshot: "BDT" } as any,
    })
    // ACTIVE sub ended 5.5d ago → overdue
    const overdue = await mkVendor(`${TAG} Overdue Co`)
    vendorIds.push(overdue.id)
    await db.saasSubscription.create({
      data: { vendorId: overdue.id, planId, planName: `${TAG} Plan`, status: "ACTIVE", billingCycle: "MONTHLY", startDate: dAgo(40), endDate: dAgo(5.5), priceAtCreation: 1000, currencySnapshot: "BDT" } as any,
    })
    // one inactive vendor with an ACTIVE sub (ends 29.5d → in ≤30)
    const inactive = await mkVendor(`${TAG} Inactive Co`)
    vendorIds.push(inactive.id)
    await db.vendor.update({ where: { id: inactive.id }, data: { active: false } })
    await db.saasSubscription.create({
      data: { vendorId: inactive.id, planId, planName: `${TAG} Plan`, status: "ACTIVE", billingCycle: "MONTHLY", startDate: dAgo(10), endDate: dAhead(29.5), priceAtCreation: 1000, currencySnapshot: "BDT" } as any,
    })
  })

  afterAll(async () => {
    await db.saasSubscription.deleteMany({ where: { vendorId: { in: vendorIds } } })
    await db.saasPlan.deleteMany({ where: { id: planId } })
    await db.vendor.deleteMany({ where: { id: { in: vendorIds } } })
  })

  test("tenant census: total / active / LEGACY anti-join / trials / signups (DB truth + the 40d exclusion)", async () => {
    const o = await call("owner.customers.overview", {})
    const [total, active, trials] = await Promise.all([
      db.vendor.count(),
      db.vendor.count({ where: { active: true } }),
      db.saasSubscription.count({ where: { status: "TRIAL" } }),
    ])
    expect(o.tenants.total).toBe(total)
    expect(o.tenants.active).toBe(active)
    expect(o.tenants.inactive).toBe(total - active)
    expect(o.tenants.trials).toBe(trials)
    // the fixtures: 5 vendors, 1 legacy (no subscription row), 2 trials >= 1
    expect(o.tenants.total).toBeGreaterThanOrEqual(5)
    expect(o.tenants.legacy).toBeGreaterThanOrEqual(1)
    expect(o.tenants.trials).toBeGreaterThanOrEqual(1)
    // new signups: 4 of the 5 fixtures are created now; Forty Day Co is NOT
    expect(o.tenants.new30d).toBeGreaterThanOrEqual(4)
    expect(o.tenants.new7d).toBeLessThanOrEqual(o.tenants.new30d)
    // LEGACY = the exact NOT EXISTS anti-join over the vendorId-unique table
    const legacyTruth = (await db.$queryRawUnsafe<Array<{ c: number }>>(
      `SELECT COUNT(*)::int AS c FROM "Vendor" v WHERE NOT EXISTS (SELECT 1 FROM "SaaSSubscription" s WHERE s."vendorId" = v."id")`,
    ))[0].c
    expect(o.tenants.legacy).toBe(Number(legacyTruth))
  })

  test("renewal windows: ≤7 / ≤30 / overdue vs an independent JS re-computation over the same statuses", async () => {
    const o = await call("owner.customers.overview", {})
    const subs = await db.saasSubscription.findMany({
      where: { status: { in: OPERATING } },
      select: { endDate: true },
    })
    const now = Date.now()
    let expiring7 = 0, expiring30 = 0, overdue = 0
    for (const s of subs) {
      const end = (s.endDate ? s.endDate.getTime() : Infinity)
      const days = Math.ceil((end - now) / DAY) // the Math.ceil semantics
      if (end < now) overdue++
      else if (days <= 7) expiring7++
      if (end >= now && days <= 30) expiring30++
    }
    expect(o.renewals.expiring7d).toBe(expiring7)
    expect(o.renewals.expiring30d).toBe(expiring30)
    expect(o.renewals.overdue).toBe(overdue)
    // the fixtures ride: 6.5d in ≤7; 6.5 + 29.5 in ≤30; the 5.5d-ago one overdue
    expect(o.renewals.expiring7d).toBeGreaterThanOrEqual(1)
    expect(o.renewals.expiring30d).toBeGreaterThanOrEqual(2)
    expect(o.renewals.overdue).toBeGreaterThanOrEqual(1)
  })

  test("fleet counters + planOptions shape ride the response", async () => {
    const o = await call("owner.customers.overview", {})
    expect(o.fleet.employees).toBeGreaterThanOrEqual(0)
    expect(o.fleet.portalUsers).toBeGreaterThanOrEqual(0)
    expect(Array.isArray(o.planOptions)).toBe(true)
    for (const p of o.planOptions) {
      expect(typeof p.id).toBe("string")
      expect(typeof p.name).toBe("string")
    }
    // only ACTIVE plans become filter options
    const inactive = await db.saasPlan.count({ where: { active: false } })
    const names = new Set(o.planOptions.map((p: any) => p.name))
    const inactivePlans = await db.saasPlan.findMany({ where: { active: false }, select: { name: true } })
    if (inactive > 0) {
      for (const p of inactivePlans) expect(names.has(p.name)).toBe(false)
    }
  })
})

// ----------------------------------------------------------------------------
describe("P5 — owner.subscriptions.overview (the Subscriptions-family KPI strip)", () => {
  const TAG = uniq("p5so")
  const vendorIds: string[] = []
  const planIds: string[] = []
  const requestIds: string[] = []

  beforeAll(async () => {
    // fixtures across the status space the mix reads
    const mkSub = async (status: string, over: Record<string, unknown> = {}) => {
      const v = await mkVendor(`${TAG} ${status} Co`)
      vendorIds.push(v.id)
      const p = await db.saasPlan.create({ data: { name: `${TAG} Plan ${status}`, monthlyPrice: 100, yearlyPrice: 1200, currency: "BDT", isPublic: false, active: true, sortOrder: 900 } as any })
      planIds.push(p.id)
      await db.saasSubscription.create({
        data: { vendorId: v.id, planId: p.id, planName: `${TAG} Plan`, status, billingCycle: "MONTHLY", startDate: dAgo(10), endDate: dAhead(20), priceAtCreation: 1000, currencySnapshot: "BDT", ...over } as any,
      })
      return v.id
    }
    await mkSub("SUSPENDED")
    await mkSub("CANCELLED")
    await mkSub("GRACE_PERIOD", { endDate: dAhead(3) }) // also rides ≤7
    // a plan pair for the census (one active+public, one inactive)
    const p1 = await db.saasPlan.create({ data: { name: `${TAG} Census A`, monthlyPrice: 100, yearlyPrice: 1200, currency: "BDT", isPublic: true, active: true, sortOrder: 900 } as any })
    const p2 = await db.saasPlan.create({ data: { name: `${TAG} Census B`, monthlyPrice: 200, yearlyPrice: 2400, currency: "BDT", isPublic: false, active: false, sortOrder: 901 } as any })
    planIds.push(p1.id, p2.id)
    // a vendor for the plan-change request DIFF
    const rv = await mkVendor(`${TAG} Requester Co`)
    vendorIds.push(rv.id)
    const r = await db.saasPlanChangeRequest.create({
      data: { vendorId: rv.id, requestedPlanId: p1.id, mode: "UPGRADE", status: "PENDING", requestedByName: `${TAG} Tenant Admin` } as any,
    })
    requestIds.push(r.id)
  })

  afterAll(async () => {
    await db.saasPlanChangeRequest.deleteMany({ where: { id: { in: requestIds } } })
    await db.saasSubscription.deleteMany({ where: { vendorId: { in: vendorIds } } })
    await db.saasPlan.deleteMany({ where: { id: { in: planIds } } })
    await db.vendor.deleteMany({ where: { id: { in: vendorIds } } })
  })

  test("status mix: every status that exists surfaces; canonical keys always present; LEGACY = the anti-join", async () => {
    const o = await call("owner.subscriptions.overview", {})
    const truth = await db.saasSubscription.groupBy({ by: ["status"], _count: { _all: true } })
    for (const r of truth) {
      expect(o.statusMix[r.status]).toBe(Number(r._count?._all || 0))
    }
    // canonical keys always present (zeros honest)
    for (const k of ["TRIAL", "ACTIVE", "PAST_DUE", "GRACE_PERIOD", "EXPIRED", "SUSPENDED", "CANCELLED", "LEGACY"]) {
      expect(typeof o.statusMix[k]).toBe("number")
    }
    // our SUSPENDED + CANCELLED + GRACE_PERIOD fixtures surface
    expect(o.statusMix.SUSPENDED).toBeGreaterThanOrEqual(1)
    expect(o.statusMix.CANCELLED).toBeGreaterThanOrEqual(1)
    expect(o.statusMix.GRACE_PERIOD).toBeGreaterThanOrEqual(1)
    // LEGACY = the exact NOT EXISTS count
    const legacyTruth = (await db.$queryRawUnsafe<Array<{ c: number }>>(
      `SELECT COUNT(*)::int AS c FROM "Vendor" v WHERE NOT EXISTS (SELECT 1 FROM "SaaSSubscription" s WHERE s."vendorId" = v."id")`,
    ))[0].c
    expect(o.statusMix.LEGACY).toBe(Number(legacyTruth))
  })

  test("pending plan-change requests move by exactly the seeded delta (DIFF)", async () => {
    const before = await call("owner.subscriptions.overview", {})
    const v = await mkVendor(`${TAG} Requester Two Co`)
    vendorIds.push(v.id)
    const p = await db.saasPlan.findFirstOrThrow({ where: { id: { in: planIds } } })
    const r = await db.saasPlanChangeRequest.create({
      data: { vendorId: v.id, requestedPlanId: p.id, mode: "DOWNGRADE", status: "PENDING", requestedByName: `${TAG} Tenant Admin 2` } as any,
    })
    requestIds.push(r.id)
    const after = await call("owner.subscriptions.overview", {})
    expect(after.pendingPlanChanges - before.pendingPlanChanges).toBe(1)
    expect(after.pendingPlanChanges).toBeGreaterThanOrEqual(2) // both fixtures
  })

  test("plan census vs DB truth; renewals windows consistent with customers.overview", async () => {
    const o = await call("owner.subscriptions.overview", {})
    const [total, active, publicPlans, trial] = await Promise.all([
      db.saasPlan.count(),
      db.saasPlan.count({ where: { active: true } }),
      db.saasPlan.count({ where: { isPublic: true } }),
      db.saasPlan.count({ where: { isTrialPlan: true } }),
    ])
    expect(o.plans.total).toBe(total)
    expect(o.plans.active).toBe(active)
    expect(o.plans.publicPlans).toBe(publicPlans)
    expect(o.plans.trialPlans).toBe(trial)
    // the two census fixtures: 1 active+public, 1 inactive+hidden
    expect(o.plans.total).toBeGreaterThanOrEqual(2)
    expect(o.plans.active).toBeLessThan(o.plans.total) // Census B is inactive
    // renewals: identical arithmetic to customers.overview — both actions
    // agree on the same database (cross-action consistency)
    const c = await call("owner.customers.overview", {})
    expect(o.renewals.expiring7d).toBe(c.renewals.expiring7d)
    expect(o.renewals.expiring30d).toBe(c.renewals.expiring30d)
    expect(o.renewals.overdue).toBe(c.renewals.overdue)
    // operating = the sum over the five statuses (from the mix itself)
    const operatingFromMix = OPERATING.reduce((s, k) => s + (o.statusMix[k] || 0), 0)
    expect(o.renewals.operating).toBe(operatingFromMix)
  })
})

// ----------------------------------------------------------------------------
describe("P5 — owner.renewals.list (REWRITE: windows, CEIL days, ordering, paging)", () => {
  const TAG = uniq("p5rn")
  const vendorIds: string[] = []
  let planId: string

  /** deterministic fractional-day fixtures — the P2 billing-console discipline
   *  (EXTRACT(DAY) integer-day fixtures drift; fractional offsets pin the CEIL
   *  boundaries exactly). */
  const mkSub = async (label: string, status: string, endDays: number) => {
    const v = await mkVendor(`${TAG} ${label}`)
    vendorIds.push(v.id)
    await db.saasSubscription.create({
      data: {
        vendorId: v.id, planId, planName: `${TAG} Plan`, status, billingCycle: "MONTHLY",
        startDate: dAgo(10),
        endDate: endDays >= 0 ? dAhead(endDays) : dAgo(-endDays),
        priceAtCreation: 1000, currencySnapshot: "BDT",
      } as any,
    })
  }

  beforeAll(async () => {
    const plan = await db.saasPlan.create({ data: { name: `${TAG} Plan`, monthlyPrice: 1000, yearlyPrice: 12000, currency: "BDT", isPublic: false, active: true, sortOrder: 810 } as any })
    planId = plan.id
    await mkSub("SixHalf", "ACTIVE", 6.5)       // ceil → 7  → in ≤7
    await mkSub("SevenHalf", "ACTIVE", 7.5)     // ceil → 8  → NOT ≤7, in ≤30
    await mkSub("TwentyNineHalf", "TRIAL", 29.5)  // ceil → 30 → in ≤30
    await mkSub("ThirtyHalf", "ACTIVE", 30.5)   // ceil → 31 → NOT ≤30, in ≤60
    await mkSub("JustExpired", "PAST_DUE", -0.5)  // ended 0.5d ago → EXPIRED
    await mkSub("FiveHalfAgo", "EXPIRED", -5.5)   // ended 5.5d ago → EXPIRED
    await mkSub("CancelledNever", "CANCELLED", 3) // never surfaces
    await mkSub("SuspendedNever", "SUSPENDED", 3) // never surfaces
  })

  /** Full-set collector: walks EVERY page of a window (other suites share
   *  the unit-test database and leave operating subscriptions behind, so a
   *  single pageSize-100 page may cut our fixtures off — the shared-DB
   *  immunity discipline: never assert membership from one page). */
  const collect = async (window: string) => {
    const first = await call("owner.renewals.list", { window, page: 1, pageSize: 100 })
    const rows = [...first.rows]
    const pages = Math.ceil(first.total / 100)
    for (let p = 2; p <= pages; p++) {
      const r = await call("owner.renewals.list", { window, page: p, pageSize: 100 })
      rows.push(...r.rows)
    }
    return { first, rows, total: first.total }
  }

  afterAll(async () => {
    await db.saasSubscription.deleteMany({ where: { vendorId: { in: vendorIds } } })
    await db.saasPlan.deleteMany({ where: { id: planId } })
    await db.vendor.deleteMany({ where: { id: { in: vendorIds } } })
  })

  test("≤7 window: 6.5d in, 7.5d out — exact boundary semantics", async () => {
    const { rows, total } = await collect("7")
    const names = rows.map((x: any) => x.tenant)
    expect(names).toContain(`${TAG} SixHalf`)
    expect(names).not.toContain(`${TAG} SevenHalf`)
    expect(names).not.toContain(`${TAG} JustExpired`)
    expect(names).not.toContain(`${TAG} CancelledNever`)
    expect(names).not.toContain(`${TAG} SuspendedNever`)
    // total matches the walked row count exactly
    expect(total).toBe(rows.length)
  })

  test("≤30 window: 6.5 + 7.5 + 29.5 in, 30.5 out", async () => {
    const { rows } = await collect("30")
    const names = rows.map((x: any) => x.tenant)
    expect(names).toContain(`${TAG} SixHalf`)
    expect(names).toContain(`${TAG} SevenHalf`)
    expect(names).toContain(`${TAG} TwentyNineHalf`)
    expect(names).not.toContain(`${TAG} ThirtyHalf`)
    expect(names).not.toContain(`${TAG} JustExpired`)
  })

  test("≤60 window adds 30.5; EXPIRED window holds the past-end fixtures only", async () => {
    const w60 = await collect("60")
    const names60 = w60.rows.map((x: any) => x.tenant)
    expect(names60).toContain(`${TAG} ThirtyHalf`)
    expect(names60).not.toContain(`${TAG} FiveHalfAgo`)
    const wexp = await collect("EXPIRED")
    const namesExp = wexp.rows.map((x: any) => x.tenant)
    expect(namesExp).toContain(`${TAG} JustExpired`)
    expect(namesExp).toContain(`${TAG} FiveHalfAgo`)
    expect(namesExp).not.toContain(`${TAG} SixHalf`)
    // EXPIRED ordering: most overdue first (endDate ASC)
    const justIdx = namesExp.indexOf(`${TAG} JustExpired`)
    const fiveIdx = namesExp.indexOf(`${TAG} FiveHalfAgo`)
    expect(fiveIdx).toBeLessThan(justIdx) // 5.5d ago < 0.5d ago in endDate ASC
  })

  test("daysRemaining is the CEIL arithmetic — 6.5d reads 7, just-expired reads 0, 5.5d-ago reads -5", async () => {
    const { rows } = await collect("ALL")
    const byName = new Map<string, any>(rows.map((x: any) => [x.tenant, x]))
    expect(byName.get(`${TAG} SixHalf`).daysRemaining).toBe(7)
    expect(byName.get(`${TAG} SevenHalf`).daysRemaining).toBe(8)
    expect(byName.get(`${TAG} TwentyNineHalf`).daysRemaining).toBe(30)
    expect(byName.get(`${TAG} ThirtyHalf`).daysRemaining).toBe(31)
    expect(byName.get(`${TAG} JustExpired`).daysRemaining).toBe(0) // ceil(-0.5) → 0, the Math.ceil semantics
    expect(byName.get(`${TAG} FiveHalfAgo`).daysRemaining).toBe(-5) // ceil(-5.5) → -5
    // row shape: the fields the page renders
    for (const r of rows) {
      expect(typeof r.id).toBe("string")
      expect(typeof r.vendorId).toBe("string")
      expect(typeof r.planName).toBe("string")
      expect(["MONTHLY", "YEARLY"]).toContain(r.cycle)
      expect(OPERATING).toContain(r.status)
      expect(r.endDate).toBeTruthy()
    }
  })

  test("soonest endDate first; summary block consistent with the windows; settings shape", async () => {
    const all = await call("owner.renewals.list", { window: "ALL", page: 1, pageSize: 100 })
    // ordering: endDate ASC (soonest first), stable id tiebreak — holds on
    // every page, whatever other suites left behind
    for (let i = 1; i < all.rows.length; i++) {
      expect(new Date(all.rows[i - 1].endDate).getTime()).toBeLessThanOrEqual(new Date(all.rows[i].endDate).getTime())
    }
    // summary: the three windows + operating, from the SAME CEIL arithmetic
    const w7 = await call("owner.renewals.list", { window: "7", page: 1, pageSize: 100 })
    const w30 = await call("owner.renewals.list", { window: "30", page: 1, pageSize: 100 })
    const wexp = await call("owner.renewals.list", { window: "EXPIRED", page: 1, pageSize: 100 })
    expect(all.summary.expiring7d).toBe(w7.total)
    expect(all.summary.expiring30d).toBe(w30.total)
    expect(all.summary.overdue).toBe(wexp.total)
    expect(all.summary.operating).toBe(all.total) // ALL window = every operating row
    // settings: grace + reminder marks ride unchanged
    expect(typeof all.settings.gracePeriodDays).toBe("number")
    expect(Array.isArray(all.settings.renewalReminderDays)).toBe(true)
    // our fixtures are in the summary
    expect(all.summary.expiring7d).toBeGreaterThanOrEqual(1) // SixHalf
    expect(all.summary.expiring30d).toBeGreaterThanOrEqual(3) // + SevenHalf, TwentyNineHalf
    expect(all.summary.overdue).toBeGreaterThanOrEqual(2) // JustExpired, FiveHalfAgo
    // the standard paging contract
    expect(all.page).toBe(1)
    expect(all.pageSize).toBe(100)
  })

  test("pageSize-2 pagination walks the whole set with no duplicates", async () => {
    const full = await call("owner.renewals.list", { window: "ALL", page: 1, pageSize: 100 })
    const seen: string[] = []
    const pages = Math.ceil(full.total / 2)
    for (let p = 1; p <= pages; p++) {
      const r = await call("owner.renewals.list", { window: "ALL", page: p, pageSize: 2 })
      expect(r.page).toBe(p)
      for (const row of r.rows) seen.push(row.id)
    }
    expect(seen.length).toBe(full.total)
    expect(new Set(seen).size).toBe(full.total)
  })
})

// ----------------------------------------------------------------------------
describe("P5 — owner.planchangerequests.list (the pagination the rebuilt page rides)", () => {
  const TAG = uniq("p5pc")
  const requestIds: string[] = []
  const vendorIds: string[] = []
  const planIds: string[] = []

  beforeAll(async () => {
    const plan = await db.saasPlan.create({ data: { name: `${TAG} Target Plan`, monthlyPrice: 300, yearlyPrice: 3600, currency: "BDT", isPublic: true, active: true, sortOrder: 950 } as any })
    planIds.push(plan.id)
    for (let i = 0; i < 5; i++) {
      const v = await mkVendor(`${TAG} Pager Co ${i}`)
      vendorIds.push(v.id)
      const r = await db.saasPlanChangeRequest.create({
        data: { vendorId: v.id, requestedPlanId: plan.id, mode: "UPGRADE", status: "PENDING", requestedByName: `${TAG} Admin ${i}` } as any,
      })
      requestIds.push(r.id)
    }
  })

  afterAll(async () => {
    await db.saasPlanChangeRequest.deleteMany({ where: { id: { in: requestIds } } })
    await db.saasPlan.deleteMany({ where: { id: { in: planIds } } })
    await db.vendor.deleteMany({ where: { id: { in: vendorIds } } })
  })

  test("PENDING-only default filter narrows in SQL; pageSize-2 walk sees every fixture once", async () => {
    const p1 = await call("owner.planchangerequests.list", { status: "PENDING", page: 1, pageSize: 2 })
    expect(p1.rows.length).toBe(2)
    expect(p1.total).toBeGreaterThanOrEqual(5) // our five fixtures (plus any others)
    const seen: string[] = []
    const pages = Math.ceil(p1.total / 2)
    for (let p = 1; p <= pages; p++) {
      const r = await call("owner.planchangerequests.list", { status: "PENDING", page: p, pageSize: 2 })
      for (const row of r.rows) seen.push(row.id)
    }
    expect(new Set(seen).size).toBe(seen.length) // no duplicates across pages
    // all five fixtures present, newest-first (createdAt DESC)
    const fixtureRows = seen.filter((id) => requestIds.includes(id))
    expect(fixtureRows.length).toBe(5)
    const all = await call("owner.planchangerequests.list", { status: "PENDING", page: 1, pageSize: 100 })
    const mine = all.rows.filter((r: any) => requestIds.includes(r.id))
    for (let i = 1; i < mine.length; i++) {
      expect(new Date(mine[i - 1].createdAt).getTime()).toBeGreaterThanOrEqual(new Date(mine[i].createdAt).getTime())
    }
  })
})

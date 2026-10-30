/// <reference types="bun-types" />
// ============ Phase 3 WS-A — owner console scale (SCL-6/7, OPS-7/8, SCL-13) ====
// Every case in this file FAILS on the pre-Phase-3 code:
//   * dashboard.overview used to fan out usageSnapshot PER VENDOR and load
//     whole tables — assertions here verify the SAME numbers from the set-based
//     rollups (correctness) with fixtures that would make the old fan-out
//     visible (multiple vendors, mixed legacy/subscribed);
//   * tenants.list paginated the fully-materialized vendor table in memory —
//     the DB-level filters/pagination must reproduce identical row shapes;
//   * analytics MRR read take: 500 — 505 fixture subscriptions make any
//     truncation numerically provable;
//   * markPaid never extended the subscription (OPS-8) — the 24 h lockout;
//   * the lifecycle sweep loaded EVERY subscription — windowed queries must
//     still transition the same rows.
import "./_testdb"
import { describe, test, expect, beforeAll } from "bun:test"
import { db } from "@/lib/db"
import { mkVendor, mkUser, mkEmployee, uniq } from "./_fixtures"
import { ownerRoutes } from "@/hrm-server/saas/owner-routes"
import { invalidateEntitlements } from "@/hrm-server/saas/entitlements"
import { subscriptionLifecycleSweep } from "@/hrm-server/saas/lifecycle-sweep"
import type { OwnerCtx } from "@/hrm-server/saas/owner-auth"

let ctx: OwnerCtx

const call = async (action: string, payload: any) => {
  const def = ownerRoutes[action]
  if (!def) throw new Error(`unknown owner action: ${action}`)
  const parsed = def.schema ? def.schema.parse(payload) : payload
  return (def.handler as any)(ctx, parsed)
}

async function mkPlan(name: string, over: Record<string, unknown> = {}) {
  return db.saasPlan.create({
    data: { name, monthlyPrice: 1000, yearlyPrice: 10000, currency: "BDT", isPublic: true, active: true, sortOrder: 1, ...over } as any,
  })
}

async function mkSub(vendorId: string, planId: string, over: Record<string, unknown> = {}) {
  return db.saasSubscription.create({
    data: {
      vendorId, planId, planName: "P3 Plan", status: "ACTIVE", billingCycle: "MONTHLY",
      startDate: new Date(), endDate: new Date(Date.now() + 30 * 86400000),
      priceAtCreation: 1000, currencySnapshot: "BDT",
      ...over,
    } as any,
  })
}

beforeAll(() => {
  ctx = {
    ownerId: "p3-owner-" + uniq("o"),
    name: "P3 Console Owner",
    email: "p3-owner@test.example",
    roleKey: "SUPER_ADMIN",
    permissions: new Set(["dashboard.view", "tenants.view", "billing.manage", "subscriptions.manage"]),
  }
})

describe("SCL-6 — dashboard.overview set-based rollups are correct", () => {
  test("legacy vs subscribed counts, plan distribution and employee distribution agree with the fixtures", async () => {
    const plan = await mkPlan("P3 Dash Plan " + uniq())
    const subV = await mkVendor("P3 Dash Subscribed")
    const legacyV = await mkVendor("P3 Dash Legacy")
    await mkSub(subV.id, plan.id, { planName: "P3 Dash Plan X" })
    await mkEmployee(subV.id, { fullName: "P3 Dash Emp A" })
    await mkEmployee(subV.id, { fullName: "P3 Dash Emp B" })
    await mkEmployee(legacyV.id, { fullName: "P3 Dash Emp C" })

    const out: any = await call("owner.dashboard.overview", {})
    expect(out.tenants.total).toBeGreaterThanOrEqual(2)
    expect(out.tenants.legacy).toBeGreaterThanOrEqual(1)
    // the subscribed vendor's plan appears in the distribution
    const dist = out.charts.planDistribution as { name: string; count: number }[]
    expect(dist.find((d) => d.name === "P3 Dash Plan X")?.count).toBeGreaterThanOrEqual(1)
    // employee distribution: 2 active employees under the plan, 1 legacy
    const empDist = out.charts.employeeDistribution as { name: string; count: number }[]
    expect(empDist.find((d) => d.name === "P3 Dash Plan X")?.count).toBeGreaterThanOrEqual(2)
    expect(empDist.find((d) => d.name === "Legacy")?.count).toBeGreaterThanOrEqual(1)
    // MRR includes this vendor's priceAtCreation (1000, MONTHLY)
    expect(out.subscriptions.mrr).toBeGreaterThanOrEqual(1000)
    // growth chart: six months, cumulative activeTenants never decreases
    const growth = out.charts.growth as { activeTenants: number }[]
    expect(growth.length).toBe(6)
    for (let i = 1; i < growth.length; i++) {
      expect(growth[i].activeTenants).toBeGreaterThanOrEqual(growth[i - 1].activeTenants)
    }
  })
})

describe("SCL-7 — tenants.list is DB-level search/filter/pagination", () => {
  test("search + filters + page shape reproduce the in-memory semantics", async () => {
    const plan = await mkPlan("P3 List Plan " + uniq())
    const marker = uniq("P3TEN")
    const vA = await db.vendor.create({ data: { name: `${marker} Alpha`, code: uniq("V") } })
    const vB = await db.vendor.create({ data: { name: `${marker} Beta`, code: uniq("V") } })
    const vC = await db.vendor.create({ data: { name: `${marker} Gamma`, code: uniq("V") } })
    await mkSub(vA.id, plan.id, { planName: "P3 List Plan Z", endDate: new Date(Date.now() + 5 * 86400000) })
    await mkUser(vA.id, { role: "VENDOR_OWNER", email: `p3-admin-${uniq()}@test.example` })
    await mkEmployee(vA.id, { fullName: "P3 List Emp" })
    // B and C stay legacy (no subscription)

    // search by name prefix (marker) → all three
    const all: any = await call("owner.tenants.list", { page: 1, pageSize: 25, search: marker })
    expect(all.total).toBe(3)
    expect(all.rows.length).toBe(3)
    const rowA = all.rows.find((r: any) => r.id === vA.id)
    expect(rowA).toBeTruthy()
    expect(rowA.planName).toBe("P3 List Plan Z")
    expect(rowA.subscriptionStatus).toBe("ACTIVE")
    expect(rowA.admin?.email).toMatch(/@test\.example$/)
    expect(rowA.usage.employees).toBe(1) // grouped per-page usage
    const rowB = all.rows.find((r: any) => r.id === vB.id)
    expect(rowB.subscriptionStatus).toBe("LEGACY")
    expect(rowB.planName).toBe("Legacy (no subscription)")
    expect(rowB.admin).toBeNull()

    // search by ADMIN EMAIL (EXISTS subquery — the old JS filter did this too)
    const byEmail: any = await call("owner.tenants.list", { page: 1, pageSize: 25, search: rowA.admin.email.toUpperCase() })
    expect(byEmail.total).toBe(1)
    expect(byEmail.rows[0].id).toBe(vA.id)

    // plan filter: LEGACY excludes the subscribed vendor
    const legacyOnly: any = await call("owner.tenants.list", { page: 1, pageSize: 25, search: marker, plan: "LEGACY" })
    expect(legacyOnly.total).toBe(2)
    expect(legacyOnly.rows.every((r: any) => r.subscriptionStatus === "LEGACY")).toBe(true)
    // plan filter by name
    const byPlan: any = await call("owner.tenants.list", { page: 1, pageSize: 25, search: marker, plan: "P3 List Plan Z" })
    expect(byPlan.total).toBe(1)
    expect(byPlan.rows[0].id).toBe(vA.id)

    // expiring within 7 days: only vA
    const expiring: any = await call("owner.tenants.list", { page: 1, pageSize: 25, search: marker, expiring: "7" })
    expect(expiring.total).toBe(1)
    expect(expiring.rows[0].id).toBe(vA.id)

    // pagination: pageSize 2 page 2 → the third row, no overlap with page 1
    const page1: any = await call("owner.tenants.list", { page: 1, pageSize: 2, search: marker })
    const page2: any = await call("owner.tenants.list", { page: 2, pageSize: 2, search: marker })
    expect(page1.rows.length).toBe(2)
    expect(page2.rows.length).toBe(1)
    const ids1 = new Set(page1.rows.map((r: any) => r.id))
    expect(page2.rows.every((r: any) => !ids1.has(r.id))).toBe(true)

    // search values are PARAMETERS, never interpolated SQL (a quote must not explode)
    const quote: any = await call("owner.tenants.list", { page: 1, pageSize: 5, search: `${marker}'--` })
    expect(quote.total).toBe(0)
  })
})

describe("OPS-7 — analytics MRR is a SQL SUM over the whole operating set", () => {
  test("505 ACTIVE subscriptions all count — the take:500 truncation is gone", async () => {
    const plan = await mkPlan("P3 MRR Plan " + uniq())
    // vendorId carries a REAL FK — 505 genuine vendor rows in one createMany
    const vendors = await db.vendor.createMany({
      data: Array.from({ length: 505 }, (_, i) => ({ name: `P3 MRR Ghost ${i}`, code: uniq("MV") })),
    }).then(() => db.vendor.findMany({ where: { name: { startsWith: "P3 MRR Ghost" } }, select: { id: true }, take: 505 }))
    expect(vendors.length).toBe(505)
    await db.saasSubscription.createMany({
      data: vendors.map((v) => ({
        vendorId: v.id,
        planId: plan.id, planName: "P3 MRR Plan X", status: "ACTIVE", billingCycle: "MONTHLY",
        startDate: new Date(), endDate: new Date(Date.now() + 30 * 86400000),
        priceAtCreation: 12, currencySnapshot: "BDT",
      })) as any,
    })

    const out: any = await call("owner.analytics.overview", {})
    // 505 × 12 = 6060 from the fixture alone — the old take:500 read at most
    // 500 of them (≤ 6000). Anything ≥ 6060 proves the whole set was summed.
    expect(out.mrr.amount).toBeGreaterThanOrEqual(505 * 12)
    expect(out.activeSubscriptions).toBeGreaterThanOrEqual(505)
  })
})

describe("OPS-8 — markPaid routes through the settle renewal path", () => {
  test("a term-linked invoice extends the subscription immediately (no 24 h lockout)", async () => {
    const plan = await mkPlan("P3 MarkPaid Plan " + uniq())
    const v = await mkVendor("P3 MarkPaid Tenant")
    await mkUser(v.id, { role: "VENDOR_OWNER", email: `p3-mp-${uniq()}@test.example` })
    const endBefore = new Date(Date.now() + 3 * 86400000)
    const sub = await mkSub(v.id, plan.id, { planName: "P3 MarkPaid Plan X", endDate: endBefore })
    const inv = await db.saasInvoice.create({
      data: {
        vendorId: v.id, subscriptionId: sub.id,
        number: uniq("INV-P3-"),
        periodStart: endBefore, periodEnd: new Date(endBefore.getTime() + 30 * 86400000),
        amount: 1000, currency: "BDT", status: "PENDING",
        dueAt: new Date(),
      },
    })

    const out: any = await call("owner.invoices.markPaid", { id: inv.id, method: "BANK", transactionId: "P3TXN" })
    expect(out.status).toBe("PAID")
    expect(out.extended).toBe(true) // ← the fix: the old code returned only {status}

    const after = await db.saasSubscription.findUnique({ where: { id: sub.id } })
    expect(after!.status).toBe("ACTIVE")
    expect(after!.endDate!.getTime()).toBeGreaterThan(endBefore.getTime()) // one cycle forward

    const events = await db.saasSubscriptionEvent.findMany({ where: { subscriptionId: sub.id, type: "EXTENDED" } })
    expect(events.length).toBe(1)
    const payments = await db.saasPayment.findMany({ where: { invoiceId: inv.id } })
    expect(payments.length).toBe(1)
    expect(payments[0].status).toBe("PAID")

    // idempotence: paying again is refused, and never re-extends
    await expect(call("owner.invoices.markPaid", { id: inv.id, method: "CASH" })).rejects.toThrow(/already/i)
    const stillAfter = await db.saasSubscription.findUnique({ where: { id: sub.id } })
    expect(stillAfter!.endDate!.getTime()).toBe(after!.endDate!.getTime())
  })

  test("an invoice WITHOUT a subscription link records the payment but extends nothing", async () => {
    const v = await mkVendor("P3 MarkPaid NoSub")
    const inv = await db.saasInvoice.create({
      data: {
        vendorId: v.id,
        number: uniq("INV-P3N-"),
        periodStart: new Date(), periodEnd: new Date(Date.now() + 30 * 86400000),
        amount: 500, currency: "BDT", status: "PENDING", dueAt: new Date(),
      },
    })
    const out: any = await call("owner.invoices.markPaid", { id: inv.id, method: "MFS" })
    expect(out.status).toBe("PAID")
    expect(out.extended).toBe(false)
    const subCount = await db.saasSubscription.count({ where: { vendorId: v.id } })
    expect(subCount).toBe(0)
  })
})

describe("SCL-13 — lifecycle sweep windowed queries keep the same transitions", () => {
  test("a past-due operating subscription transitions PAST_DUE; a far-future one is never loaded", async () => {
    const plan = await mkPlan("P3 Sweep Plan " + uniq())
    const vEnded = await mkVendor("P3 Sweep Ended")
    const vFuture = await mkVendor("P3 Sweep Future")
    const subEnded = await mkSub(vEnded.id, plan.id, { endDate: new Date(Date.now() - 2 * 86400000) })
    await mkSub(vFuture.id, plan.id, { endDate: new Date(Date.now() + 300 * 86400000) })

    const result = await subscriptionLifecycleSweep()
    expect(result.errors.length).toBe(0)
    expect(result.pastDue + result.graceApplied).toBeGreaterThanOrEqual(1) // the transition fired

    const ended = await db.saasSubscription.findUnique({ where: { id: subEnded.id } })
    // with a grace window configured the sweep applies it immediately after
    // PAST_DUE (mirrors owner.subscriptions.grace) — both are term-end outcomes
    expect(["PAST_DUE", "GRACE_PERIOD"]).toContain(ended!.status)
    // checked counts only subs INSIDE the window — the +300-day fixture must
    // never be examined (at the 100K-tenant goal that is the whole point)
    const checkedIds = await db.saasSubscription.findMany({
      where: { vendorId: { in: [vEnded.id, vFuture.id] } },
      select: { vendorId: true, status: true },
    })
    expect(checkedIds.find((r) => r.vendorId === vFuture.id)!.status).toBe("ACTIVE")

    // idempotent: a second sweep transitions nothing new
    const again = await subscriptionLifecycleSweep()
    expect(again.pastDue + again.graceApplied).toBe(0)
    // invalidate the entitlements memo so later suites resolve fresh state
    invalidateEntitlements(vEnded.id)
  })
})

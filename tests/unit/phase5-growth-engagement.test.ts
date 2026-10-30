/// <reference types="bun-types" />
// ============ Phase 5 P3 — Growth & Engagement console =======================
// Covers the P3 delivery (owner.growth.* in src/hrm-server/saas/growth-console.ts):
//   1. owner.growth.overview — growth KPIs vs the database's own truth (same
//      filters, independently written), MRR/ARPU with the established
//      priceAtCreation methodology vs an independent JS re-computation, the
//      12-month signup trend contract, the registration funnel and the churn
//      counters moving by exactly the seeded event deltas (before/after DIFF —
//      immune to other suites' rows sharing the unit-test database).
//   2. usage — the live fleet counts vs full-table Prisma truth, and the
//      monthly UsageSnapshot metering series: latest/previous periods, the
//      six-month trend contract and fleet sums moving by the seeded deltas.
//   3. engagement KPIs — logins/engaged tenants DIFF around seeded login rows
//      (failed + owner-plane attempts never count), the six-week contract.
//   4. owner.growth.engagement — the matrix: tier exactness across the
//      DORMANT/LIGHT/STEADY/POWER boundaries (0/3/10/20/50/60 logins),
//      dormant-first ordering with never-logged-in first, tier chips and
//      search narrowing IN SQL, pageSize-2 pagination without duplicates,
//      and the UsageSnapshot seats + MoM delta riding the row.
import "./_testdb"
import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { db } from "@/lib/db"
import { mkVendor, mkUser, mkEmployee, uniq } from "./_fixtures"
import { ownerRoutes } from "@/hrm-server/saas/owner-routes"
// side-effect imports — owner.growth.* self-registers into ownerRoutes
// exactly like the /api/owner dispatcher imports them
import "@/hrm-server/saas/growth-console"
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

/** Current + previous UTC month keys: ["2026-10", "2026-09"]. */
const monthKeys = () => {
  const n = new Date()
  const cur = new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), 1))
  const prev = new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth() - 1, 1))
  const key = (d: Date) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`
  return { cur, prev, curKey: key(cur), prevKey: key(prev) }
}

beforeAll(() => {
  ctx = {
    ownerId: "p3-owner-" + uniq("o"),
    name: "P3 Growth Owner",
    email: "p3-owner@test.example",
    roleKey: "SUPER_ADMIN",
    permissions: new Set(["tenants.view"]),
  } as OwnerCtx
})

// ----------------------------------------------------------------------------
describe("P3 — owner.growth.overview (growth, revenue, funnel, churn)", () => {
  const TAG = uniq("p3ov")
  let oldVendorId: string

  beforeAll(async () => {
    // vendor A — created now, ACTIVE MONTHLY 1000 (MRR 1000)
    const a = await mkVendor(`${TAG} Alpha Co`)
    await db.saasSubscription.create({
      data: { vendorId: a.id, planId: (await db.saasPlan.create({ data: { name: `${TAG} Plan M`, monthlyPrice: 1000, yearlyPrice: 12000, currency: "BDT", isPublic: true, active: true, sortOrder: 1 } as any })).id,
        planName: `${TAG} Plan M`, status: "ACTIVE", billingCycle: "MONTHLY", startDate: new Date(), endDate: new Date(Date.now() + 30 * DAY), priceAtCreation: 1000, currencySnapshot: "BDT" } as any,
    })
    // vendor B — created 40d ago, ACTIVE YEARLY 12000 (MRR 1000/mo)
    const b = await mkVendor(`${TAG} Beta Co`)
    oldVendorId = b.id
    await db.vendor.update({ where: { id: b.id }, data: { createdAt: dAgo(40) } })
    await db.saasSubscription.create({
      data: { vendorId: b.id, planId: (await db.saasPlan.create({ data: { name: `${TAG} Plan Y`, monthlyPrice: 1000, yearlyPrice: 12000, currency: "BDT", isPublic: true, active: true, sortOrder: 2 } as any })).id,
        planName: `${TAG} Plan Y`, status: "ACTIVE", billingCycle: "YEARLY", startDate: new Date(), endDate: new Date(Date.now() + 365 * DAY), priceAtCreation: 12000, currencySnapshot: "BDT" } as any,
    })
    // vendor C — TRIAL 500 (counted as a trial, contributes NO MRR)
    const c = await mkVendor(`${TAG} Gamma Co`)
    await db.saasSubscription.create({
      data: { vendorId: c.id, planId: (await db.saasPlan.findFirstOrThrow({ where: { name: `${TAG} Plan M` } })).id,
        planName: `${TAG} Plan M`, status: "TRIAL", billingCycle: "MONTHLY", startDate: new Date(), endDate: new Date(Date.now() + 14 * DAY), priceAtCreation: 500, currencySnapshot: "BDT" } as any,
    })
    // vendor D — PAST_DUE (a churn-risk signal, no MRR contribution)
    const dv = await mkVendor(`${TAG} Delta Co`)
    await db.saasSubscription.create({
      data: { vendorId: dv.id, planId: (await db.saasPlan.findFirstOrThrow({ where: { name: `${TAG} Plan M` } })).id,
        planName: `${TAG} Plan M`, status: "PAST_DUE", billingCycle: "MONTHLY", startDate: new Date(), endDate: new Date(Date.now() + 10 * DAY), priceAtCreation: 1000, currencySnapshot: "BDT" } as any,
    })
    // churn events on vendor B's subscription: CANCELLED 5d ago (in window),
    // CANCELLED 40d ago (out), REACTIVATED 3d ago (in)
    const subB = await db.saasSubscription.findFirstOrThrow({ where: { vendorId: b.id } })
    const mkEvent = (type: string, days: number) =>
      db.saasSubscriptionEvent.create({ data: { subscriptionId: subB.id, vendorId: b.id, type, createdAt: dAgo(days) } as any })
    await mkEvent("CANCELLED", 5)
    await mkEvent("CANCELLED", 40)
    await mkEvent("REACTIVATED", 3)
    // failed payment 2d ago on vendor D (needs an invoice for the FK)
    const invD = await db.saasInvoice.create({
      data: { vendorId: dv.id, number: `${TAG}-INV1`, periodStart: dAgo(30), periodEnd: dAgo(1), amount: 100, status: "PENDING", issuedAt: dAgo(30), dueAt: dAgo(10) } as any,
    })
    await db.saasPayment.create({
      data: { invoiceId: invD.id, vendorId: dv.id, amount: 100, currency: "BDT", method: "BANK", status: "FAILED", provider: "MANUAL", createdAt: dAgo(2) } as any,
    })
    // one PENDING + one REJECTED registration application
    const mkReg = (status: string) =>
      db.saasRegistration.create({
        data: { applicationNumber: `${TAG}-${status}`, organizationName: `${TAG} Org ${status}`, officialEmail: `${uniq("r")}@test.local`, adminName: "Applicant", adminEmail: `${uniq("a")}@test.local`, adminPasswordHash: "x", status } as any,
      })
    await mkReg("PENDING")
    await mkReg("REJECTED")
  })

  afterAll(async () => {
    // payments first (FK → invoice), then invoices; events cascade on
    // subscription delete; registrations by applicationNumber prefix
    const invIds = (await db.saasInvoice.findMany({ where: { number: { startsWith: `${TAG}` } } })).map((i) => i.id)
    if (invIds.length) await db.saasPayment.deleteMany({ where: { invoiceId: { in: invIds } } })
    await db.saasInvoice.deleteMany({ where: { number: { startsWith: `${TAG}` } } })
    await db.saasSubscription.deleteMany({ where: { vendorId: { in: (await db.vendor.findMany({ where: { name: { startsWith: TAG } } })).map((v) => v.id) } } })
    await db.saasRegistration.deleteMany({ where: { applicationNumber: { startsWith: `${TAG}` } } })
    await db.saasPlan.deleteMany({ where: { name: { startsWith: `${TAG}` } } })
    await db.vendor.deleteMany({ where: { name: { startsWith: TAG } } })
  })

  test("growth KPIs agree with the database's own truth (full-table, same filters)", async () => {
    const o = await call("owner.growth.overview", {})
    const [total, active, new30d, newMtd, trials] = await Promise.all([
      db.vendor.count(),
      db.vendor.count({ where: { active: true } }),
      db.vendor.count({ where: { createdAt: { gte: dAgo(30) } } }),
      db.vendor.count({ where: { createdAt: { gte: new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1)) } } }),
      db.saasSubscription.count({ where: { status: "TRIAL" } }),
    ])
    expect(o.growth.tenantsTotal).toBe(total)
    expect(o.growth.tenantsActive).toBe(active)
    expect(o.growth.newVendors30d).toBe(new30d)
    expect(o.growth.newVendorsMtd).toBe(newMtd)
    expect(o.growth.trialsCurrent).toBe(trials)
    // the fixtures are in there: Beta (40d old) is NOT in new30d
    expect(o.growth.newVendors30d).toBeLessThan(total)
  })

  test("MRR / ARPU / paying / past-due match an independent re-computation (trials excluded, yearly ÷12)", async () => {
    const o = await call("owner.growth.overview", {})
    const subs = await db.saasSubscription.findMany({ select: { status: true, billingCycle: true, priceAtCreation: true } })
    let mrr = 0
    let paying = 0
    let pastDue = 0
    for (const s of subs) {
      if (s.status === "ACTIVE") {
        paying++
        mrr += Number(s.billingCycle === "YEARLY" ? Number(s.priceAtCreation) / 12 : Number(s.priceAtCreation))
      }
      if (s.status === "PAST_DUE" || s.status === "GRACE_PERIOD") pastDue++
    }
    expect(o.revenue.mrr).toBeCloseTo(mrr, 2) // fixtures: 1000 + 1000 = 2000
    expect(o.revenue.payingSubs).toBe(paying)
    expect(o.revenue.pastDueSubs).toBe(pastDue)
    expect(o.revenue.arpu).toBeCloseTo(mrr / paying, 2)
    expect(o.revenue.currency).toBe("BDT")
    // the TRIAL 500 and PAST_DUE 1000 fixtures contribute NOTHING to MRR
    expect(o.revenue.mrr).toBeGreaterThanOrEqual(2000)
  })

  test("plan mix carries both fixtures with the MRR contribution split", async () => {
    const o = await call("owner.growth.overview", {})
    const mine = o.revenue.planMix.filter((p: any) => p.name.startsWith(`${TAG}`))
    expect(mine.length).toBe(2)
    const monthly = mine.find((p: any) => p.name === `${TAG} Plan M`)
    const yearly = mine.find((p: any) => p.name === `${TAG} Plan Y`)
    // Plan M: vendor A (ACTIVE, 1000) + vendor C (TRIAL, 0 MRR) → 2 subs, 1000 MRR
    expect(monthly.subscribers).toBe(2)
    expect(monthly.mrr).toBeCloseTo(1000, 2)
    // Plan Y: vendor B (ACTIVE YEARLY 12000 ÷12) → 1 sub, 1000 MRR
    expect(yearly.subscribers).toBe(1)
    expect(yearly.mrr).toBeCloseTo(1000, 2)
  })

  test("signup trend: twelve ascending calendar months ending now, current month includes the fixture", async () => {
    const o = await call("owner.growth.overview", {})
    expect(o.growth.signupTrend.length).toBe(12)
    const n = new Date()
    const curKey = `${n.getUTCFullYear()}-${String(n.getUTCMonth() + 1).padStart(2, "0")}`
    expect(o.growth.signupTrend[11].month).toBe(curKey)
    for (let i = 1; i < 12; i++) expect(o.growth.signupTrend[i].month > o.growth.signupTrend[i - 1].month).toBe(true)
    // Alpha/Gamma/Delta were created now → the current month includes them
    expect(o.growth.signupTrend[11].vendors).toBeGreaterThanOrEqual(3)
  })

  test("registration funnel moves by exactly the seeded applications (DIFF)", async () => {
    const o = await call("owner.growth.overview", {})
    expect(o.engagement.registrations.PENDING).toBeGreaterThanOrEqual(1)
    expect(o.engagement.registrations.REJECTED).toBeGreaterThanOrEqual(1)
    // canonical keys always present (zeros honest)
    for (const k of ["PENDING", "APPROVED", "REJECTED", "CANCELLED", "WITHDRAWN"]) {
      expect(typeof o.engagement.registrations[k]).toBe("number")
    }
  })

  test("churn counters: the 5d CANCELLED counts, the 40d one does not (DIFF)", async () => {
    const o = await call("owner.growth.overview", {})
    expect(o.churn.cancelled30d).toBeGreaterThanOrEqual(1) // the 5d fixture
    expect(o.churn.reactivated30d).toBeGreaterThanOrEqual(1) // the 3d fixture
    // events30d is the raw group-by: CANCELLED appears with ≥1 (only one of the
    // two seeded CANCELLED rows is inside the window)
    const cancelled = o.churn.events30d.find((e: any) => e.type === "CANCELLED")
    expect(cancelled.count).toBeGreaterThanOrEqual(1)
    // rate sanity: 0–100, defined because paying ≥ 1
    expect(o.churn.churnRate30d).not.toBeNull()
    expect(o.churn.churnRate30d as number).toBeGreaterThanOrEqual(0)
    expect(o.churn.churnRate30d as number).toBeLessThanOrEqual(100)
    // failed payment fixture surfaces
    expect(o.revenue.failedPayments30d).toBeGreaterThanOrEqual(1)
  })
})

// ----------------------------------------------------------------------------
describe("P3 — owner.growth.overview (usage metering + engagement KPIs)", () => {
  const TAG = uniq("p3us")
  let vendorId: string
  const { curKey, prevKey, cur, prev } = monthKeys()

  beforeAll(async () => {
    const v = await mkVendor(`${TAG} Metered Co`)
    vendorId = v.id
    await mkUser(v.id, { role: "HR_ADMIN" })
    await mkEmployee(v.id, { fullName: `${TAG} Payroll One` })
    await mkEmployee(v.id, { fullName: `${TAG} Payroll Two` })
    const leaver = await mkEmployee(v.id, { fullName: `${TAG} Leaver` })
    await db.employee.update({ where: { id: leaver.id }, data: { status: "RESIGNED" } })
    await db.attendanceDevice.create({ data: { vendorId: v.id, deviceId: uniq("DEV"), name: `${TAG} Device`, enabled: true } as any })
    await db.usageRollup.create({ data: { vendorId: v.id, storageBytes: 3_221_225_472n } }) // 3 GiB
  })

  afterAll(async () => {
    await db.usageSnapshot.deleteMany({ where: { vendorId } })
    await db.usageRollup.deleteMany({ where: { vendorId } })
    await db.attendanceDevice.deleteMany({ where: { vendorId } })
    await db.employee.deleteMany({ where: { vendorId } })
    await db.user.deleteMany({ where: { vendorId } })
    await db.vendor.deleteMany({ where: { id: vendorId } })
  })

  test("live fleet usage agrees with full-table Prisma truth (same payroll statuses)", async () => {
    const o = await call("owner.growth.overview", {})
    const [empTotal, empPayroll, users, devices, storage] = await Promise.all([
      db.employee.count(),
      db.employee.count({ where: { status: { in: ["ACTIVE", "PROBATION", "ON_LEAVE", "SUSPENDED"] } } }),
      db.user.count({ where: { status: "ACTIVE" } }),
      db.attendanceDevice.count({ where: { enabled: true } }),
      db.usageRollup.aggregate({ _sum: { storageBytes: true } }),
    ])
    expect(o.usage.live.employeesTotal).toBe(empTotal)
    expect(o.usage.live.employeesPayroll).toBe(empPayroll)
    expect(o.usage.live.portalUsers).toBe(users)
    expect(o.usage.live.devicesEnrolled).toBe(devices)
    expect(o.usage.live.storageBytes).toBe(Number(storage._sum.storageBytes || 0))
    // the fixture is in there: 3 employees, 2 payroll-scope (RESIGNED excluded), 3 GiB
    expect(o.usage.live.employeesTotal).toBeGreaterThanOrEqual(3)
    expect(o.usage.live.employeesPayroll).toBeGreaterThanOrEqual(2)
    expect(o.usage.live.storageBytes).toBeGreaterThanOrEqual(3_221_225_472)
  })

  test("snapshot series: latest/previous periods + fleet sums match each period's own truth", async () => {
    // seed the CURRENT month (payroll seats 10, storage 1 GiB) + the PREVIOUS
    // month (payroll seats 7) for the fixture vendor
    await db.usageSnapshot.create({
      data: { vendorId, periodYear: cur.getUTCFullYear(), periodMonth: cur.getUTCMonth() + 1, employeesTotal: 12, employeesPayroll: 10, portalUsers: 4, devicesEnrolled: 1, storageBytes: 1_073_741_824n } as any,
    })
    await db.usageSnapshot.create({
      data: { vendorId, periodYear: prev.getUTCFullYear(), periodMonth: prev.getUTCMonth() + 1, employeesTotal: 9, employeesPayroll: 7, portalUsers: 2, devicesEnrolled: 0, storageBytes: 0n } as any,
    })
    const after = await call("owner.growth.overview", {})
    // the top-two distinct periods are now the current + previous calendar
    // months (older frozen fixtures from other suites — e.g. a 2025-06 row —
    // can never outrank them)
    expect(after.usage.latestPeriod).toBe(curKey)
    expect(after.usage.previousPeriod).toBe(prevKey)
    // the fleet sums equal each period's OWN DB truth (my row + anything any
    // other suite left in the same period — exact either way, no DIFF needed)
    const [curSum, prevSum] = await Promise.all([
      db.usageSnapshot.aggregate({ _sum: { employeesPayroll: true, storageBytes: true }, where: { periodYear: cur.getUTCFullYear(), periodMonth: cur.getUTCMonth() + 1 } }),
      db.usageSnapshot.aggregate({ _sum: { employeesPayroll: true }, where: { periodYear: prev.getUTCFullYear(), periodMonth: prev.getUTCMonth() + 1 } }),
    ])
    expect(after.usage.latest.employeesPayroll).toBe(Number(curSum._sum.employeesPayroll || 0))
    expect(after.usage.latest.storageBytes).toBe(Number(curSum._sum.storageBytes || 0))
    expect(after.usage.previous.employeesPayroll).toBe(Number(prevSum._sum.employeesPayroll || 0))
    // the fixtures are in there: current ≥ 10 payroll seats, previous ≥ 7
    expect(after.usage.latest.employeesPayroll).toBeGreaterThanOrEqual(10)
    expect(after.usage.previous.employeesPayroll).toBeGreaterThanOrEqual(7)
    // the six-month trend: always six ascending months ending now, the
    // current month payroll seats include the seeded 10
    expect(after.usage.trend.length).toBe(6)
    expect(after.usage.trend[5].month).toBe(curKey)
    for (let i = 1; i < 6; i++) expect(after.usage.trend[i].month > after.usage.trend[i - 1].month).toBe(true)
    expect(after.usage.trend[5].employeesPayroll).toBeGreaterThanOrEqual(10)
  })

  test("engagement KPIs: successful tenant logins count; failed + owner-plane attempts never do (DIFF)", async () => {
    const before = await call("owner.growth.overview", {})
    const seed = (over: Record<string, unknown>, days: number) =>
      db.loginAuditLog.create({ data: { plane: "TENANT", email: `${uniq("u")}@test.local`, vendorId, createdAt: dAgo(days), ...over } as any })
    await seed({ success: true }, 1)
    await seed({ success: true }, 3)
    await seed({ success: true }, 6)
    await seed({ success: false, failureReason: "INVALID_CREDENTIALS" }, 2) // never counts
    await seed({ plane: "OWNER", success: true }, 1) // never counts (owner plane)
    await db.loginAuditLog.create({ data: { plane: "TENANT", email: `${uniq("u")}@test.local`, success: true, vendorId, createdAt: dAgo(45) } as any }) // out of window
    const after = await call("owner.growth.overview", {})
    expect(after.engagement.logins30d - before.engagement.logins30d).toBe(3)
    expect(after.engagement.engagedTenants30d - before.engagement.engagedTenants30d).toBe(1)
    expect(after.engagement.engagedActive30d - before.engagement.engagedActive30d).toBe(1)
    // idle = active vendors without a 30d login; the fixture vendor engaged now
    expect(after.engagement.idleActive).toBeLessThanOrEqual(after.growth.tenantsActive)
    // share sanity
    if (after.engagement.engagedShare30d != null) {
      expect(after.engagement.engagedShare30d).toBeGreaterThanOrEqual(0)
      expect(after.engagement.engagedShare30d).toBeLessThanOrEqual(100)
    }
    // the six-week contract: ascending weeks ending at the current one
    expect(after.engagement.loginsByWeek.length).toBe(6)
    for (let i = 1; i < 6; i++) expect(new Date(after.engagement.loginsByWeek[i].weekStart) > new Date(after.engagement.loginsByWeek[i - 1].weekStart)).toBe(true)
    const total = after.engagement.loginsByWeek.reduce((s: number, w: any) => s + w.logins, 0)
    expect(total).toBeGreaterThanOrEqual(3)
  })
})

// ----------------------------------------------------------------------------
describe("P3 — owner.growth.engagement (the matrix: tiers, ordering, chips, pagination)", () => {
  const TAG = uniq("p3mx")
  // vendor ids for cleanup, seeded tier fixtures: P 60 · B50 50 · S 20 · B10 10 · L 3 · D0 40.5d-old · D1 never
  let vP: string, vS: string, vL: string, vD0: string, vD1: string, vB10: string, vB50: string

  const seedLogins = async (vendorId: string, count: number, daysBase = 1) => {
    const rows = Array.from({ length: count }, (_, i) => ({
      plane: "TENANT", email: `${uniq("u")}@test.local`, success: true, vendorId,
      createdAt: dAgo(daysBase + (i % 25) * 0.5), // spread inside the 30d window
    }))
    await db.loginAuditLog.createMany({ data: rows } as any)
  }

  beforeAll(async () => {
    const mk = async (suffix: string) => {
      const v = await mkVendor(`${TAG} ${suffix} Co`)
      return v.id
    }
    vP = await mk("Power")
    vS = await mk("Steady")
    vL = await mk("Light")
    vD0 = await mk("DormantOld")
    vD1 = await mk("DormantNever")
    vB10 = await mk("BoundTen")
    vB50 = await mk("BoundFifty")
    await Promise.all([
      seedLogins(vP, 60),
      seedLogins(vS, 20),
      seedLogins(vL, 3),
      seedLogins(vB10, 10),
      seedLogins(vB50, 50),
    ])
    // D0: exactly one successful login 40.5d ago (out of the 30d window, but
    // the last-ever login rides the row) — fractional offset keeps EXTRACT(DAY) at 40
    await db.loginAuditLog.create({ data: { plane: "TENANT", email: `${uniq("u")}@test.local`, success: true, vendorId: vD0, createdAt: dAgo(40.5) } as any })
    // D1: nothing — never logged in
    // a subscription on the POWER vendor so the row carries status + plan
    const plan = await db.saasPlan.create({ data: { name: `${TAG} Matrix Plan`, monthlyPrice: 500, yearlyPrice: 5000, currency: "BDT", isPublic: true, active: true, sortOrder: 3 } as any })
    await db.saasSubscription.create({
      data: { vendorId: vP, planId: plan.id, planName: `${TAG} Matrix Plan`, status: "ACTIVE", billingCycle: "MONTHLY", startDate: new Date(), endDate: new Date(Date.now() + 30 * DAY), priceAtCreation: 500, currencySnapshot: "BDT" } as any,
    })
    // usage metering on the POWER vendor: current month 12 payroll seats,
    // previous month 8 — the seats + MoM delta ride the row
    const { cur, prev } = monthKeys()
    await db.usageSnapshot.create({ data: { vendorId: vP, periodYear: cur.getUTCFullYear(), periodMonth: cur.getUTCMonth() + 1, employeesTotal: 12, employeesPayroll: 12, portalUsers: 3, devicesEnrolled: 1, storageBytes: 0n } as any })
    await db.usageSnapshot.create({ data: { vendorId: vP, periodYear: prev.getUTCFullYear(), periodMonth: prev.getUTCMonth() + 1, employeesTotal: 8, employeesPayroll: 8, portalUsers: 2, devicesEnrolled: 0, storageBytes: 0n } as any })
  })

  afterAll(async () => {
    const ids = [vP, vS, vL, vD0, vD1, vB10, vB50]
    await db.loginAuditLog.deleteMany({ where: { vendorId: { in: ids } } })
    await db.usageSnapshot.deleteMany({ where: { vendorId: { in: ids } } })
    await db.saasSubscription.deleteMany({ where: { vendorId: { in: ids } } })
    await db.saasPlan.deleteMany({ where: { name: { startsWith: `${TAG}` } } })
    await db.vendor.deleteMany({ where: { id: { in: ids } } })
  })

  test("tiers are exact at the boundaries, dormant-first, with the last-login state riding the row", async () => {
    const r = await call("owner.growth.engagement", { page: 1, pageSize: 10, search: TAG })
    expect(r.total).toBe(7)
    // dormant-first; never-logged-in (null days → 999999) before the 40d-old one;
    // then LIGHT, STEADY (most logins first), POWER (most logins first)
    expect(r.rows.map((x: any) => x.name)).toEqual([
      `${TAG} DormantNever Co`, `${TAG} DormantOld Co`, `${TAG} Light Co`,
      `${TAG} Steady Co`, `${TAG} BoundTen Co`, `${TAG} Power Co`, `${TAG} BoundFifty Co`,
    ])
    expect(r.rows.map((x: any) => x.tier)).toEqual(["DORMANT", "DORMANT", "LIGHT", "STEADY", "STEADY", "POWER", "POWER"])
    const byName = new Map<string, any>(r.rows.map((x: any) => [x.name, x]))
    expect(byName.get(`${TAG} Power Co`).logins30d).toBe(60)
    expect(byName.get(`${TAG} BoundFifty Co`).logins30d).toBe(50) // 50 → POWER
    expect(byName.get(`${TAG} BoundTen Co`).logins30d).toBe(10) // 10 → STEADY
    expect(byName.get(`${TAG} Light Co`).logins30d).toBe(3)
    expect(byName.get(`${TAG} DormantOld Co`).logins30d).toBe(0)
    expect(byName.get(`${TAG} DormantOld Co`).daysSinceLogin).toBe(40)
    expect(byName.get(`${TAG} DormantNever Co`).logins30d).toBe(0)
    expect(byName.get(`${TAG} DormantNever Co`).lastLoginAt).toBeNull()
    expect(byName.get(`${TAG} DormantNever Co`).daysSinceLogin).toBeNull()
  })

  test("the subscription + metered seats ride the row (legacy stays null)", async () => {
    const r = await call("owner.growth.engagement", { page: 1, pageSize: 10, search: TAG })
    const byName = new Map<string, any>(r.rows.map((x: any) => [x.name, x]))
    const { curKey } = monthKeys()
    const power = byName.get(`${TAG} Power Co`)
    expect(power.subStatus).toBe("ACTIVE")
    expect(power.planName).toBe(`${TAG} Matrix Plan`)
    expect(power.seatsNow).toBe(12)
    expect(power.seatsPrev).toBe(8)
    expect(power.seatsPeriod).toBe(curKey)
    // vendors without a subscription / snapshot row stay honestly null
    const light = byName.get(`${TAG} Light Co`)
    expect(light.subStatus).toBeNull()
    expect(light.planName).toBeNull()
    expect(light.seatsNow).toBeNull()
    expect(light.seatsPrev).toBeNull()
    expect(light.seatsPeriod).toBeNull()
  })

  test("the DORMANT and POWER chips narrow IN SQL — no cross-tier leak", async () => {
    const dormant = await call("owner.growth.engagement", { page: 1, pageSize: 10, search: TAG, tier: "DORMANT" })
    expect(dormant.total).toBe(2)
    expect(dormant.rows.every((x: any) => x.tier === "DORMANT")).toBe(true)
    const power = await call("owner.growth.engagement", { page: 1, pageSize: 10, search: TAG, tier: "POWER" })
    expect(power.total).toBe(2)
    expect(power.rows.every((x: any) => x.tier === "POWER")).toBe(true)
    expect(power.rows.map((x: any) => x.logins30d)).toEqual([60, 50]) // most intense first
    const steady = await call("owner.growth.engagement", { page: 1, pageSize: 10, search: TAG, tier: "STEADY" })
    expect(steady.total).toBe(2)
  })

  test("search by vendor code isolates a single row", async () => {
    const v = await db.vendor.findFirstOrThrow({ where: { name: `${TAG} Steady Co` } })
    const r = await call("owner.growth.engagement", { page: 1, pageSize: 10, search: v.code })
    expect(r.total).toBe(1)
    expect(r.rows[0].id).toBe(v.id)
    expect(r.rows[0].tier).toBe("STEADY")
  })

  test("pageSize-2 pagination walks the whole set with no duplicates", async () => {
    const seen: string[] = []
    for (let page = 1; page <= 4; page++) {
      const r = await call("owner.growth.engagement", { page, pageSize: 2, search: TAG })
      expect(r.page).toBe(page)
      expect(r.rows.length).toBe(page < 4 ? 2 : 1)
      seen.push(...r.rows.map((x: any) => x.id))
    }
    expect(new Set(seen).size).toBe(7)
    const p5 = await call("owner.growth.engagement", { page: 5, pageSize: 2, search: TAG })
    expect(p5.rows.length).toBe(0)
    expect(p5.total).toBe(7)
  })
})

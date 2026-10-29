/// <reference types="bun-types" />
// ============ Phase 5 P2 — Revenue & Collections console =====================
// Covers the P2 delivery (owner.billing.* in src/hrm-server/saas/billing-console.ts):
//   1. owner.billing.overview — every money KPI compared against the
//      database's own truth (same filters, independently written), aging
//      buckets exact at the boundaries, the 6-month trend always carrying six
//      calendar months, and the method/provider mixes moving by exactly the
//      seeded payment deltas (before/after DIFF — immune to other suites'
//      rows sharing the unit-test database).
//   2. owner.billing.invoices — band exactness across all collection bands
//      (SQL CASE vs the same bucketing asserted per row), severity-first
//      ordering, the collection chip narrowing IN SQL, the status filter,
//      pageSize-3 pagination without duplicates, and number/tenant search.
//   3. owner.billing.payments — newest-first stream with joined invoice
//      number + tenant name, method/provider filters narrowing in SQL, and
//      search matching a transaction reference.
//   4. owner.billing.collections — the dunning workbench: only overdue
//      PENDING invoices (future-due and PAID never leak), worst-first with
//      exact day counts, the per-invoice reminder state riding the response,
//      and the manual send (owner.dunning.remind) incrementing the counter the
//      workbench reads.
import "./_testdb"
import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { db } from "@/lib/db"
import { mkVendor, mkUser, uniq } from "./_fixtures"
import { ownerRoutes } from "@/hrm-server/saas/owner-routes"
// side-effect imports — owner.billing.* self-registers into ownerRoutes
// exactly like the /api/owner dispatcher imports them
import "@/hrm-server/saas/billing-console"
import type { OwnerCtx } from "@/hrm-server/saas/owner-auth"

let ctx: OwnerCtx
let manageCtx: OwnerCtx

const call = async (action: string, payload: any) => {
  const def = ownerRoutes[action]
  if (!def) throw new Error(`unknown owner action: ${action}`)
  const parsed = def.schema ? def.schema.parse(payload) : payload
  return (def.handler as any)(ctx, parsed)
}

const DAY = 86_400_000
const dAgo = (days: number) => new Date(Date.now() - days * DAY)
const dAhead = (days: number) => new Date(Date.now() + days * DAY)

/** Independent DB truth helpers (written with Prisma, not the raw SQL under
 *  test) for the full-table money aggregates. */
const monthStartUtc = () => {
  const n = new Date()
  return new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), 1))
}

beforeAll(() => {
  const base = {
    name: "P2 Revenue Owner",
    email: "p2-owner@test.example",
    roleKey: "SUPER_ADMIN",
  }
  ctx = { ...base, ownerId: "p2-owner-" + uniq("o"), permissions: new Set(["billing.view"]) } as OwnerCtx
  manageCtx = { ...base, ownerId: "p2-manage-" + uniq("m"), permissions: new Set(["billing.view", "billing.manage"]) } as OwnerCtx
})

// ----------------------------------------------------------------------------
describe("P2 — owner.billing.overview (money KPIs, aging, trend, mixes)", () => {
  const TAG = uniq("p2ov")

  beforeAll(async () => {
    const v = await mkVendor(`${TAG} KPI Co`)
    await mkUser(v.id, { role: "VENDOR_OWNER" })
    // billed MTD (PENDING, not yet due) — billedMtd +1000, aging CURRENT +1
    await db.saasInvoice.create({
      data: { vendorId: v.id, number: `${TAG}-M1`, periodStart: dAgo(5), periodEnd: dAhead(25), amount: 1000, status: "PENDING", issuedAt: new Date(), dueAt: dAhead(30) } as any,
    })
    // collected MTD (PAID today, issued 10d ago)
    await db.saasInvoice.create({
      data: { vendorId: v.id, number: `${TAG}-M2`, periodStart: dAgo(40), periodEnd: dAgo(10), amount: 500, status: "PAID", issuedAt: dAgo(10), paidAt: new Date(), paymentMethod: "BANK" } as any,
    })
    // overdue 100.5d (OVERDUE_90 bucket) + overdue 20.5d (DUE_16_30 bucket)
    await db.saasInvoice.create({
      data: { vendorId: v.id, number: `${TAG}-M3`, periodStart: dAgo(140), periodEnd: dAgo(101), amount: 700, status: "PENDING", issuedAt: dAgo(120), dueAt: dAgo(100.5) } as any,
    })
    await db.saasInvoice.create({
      data: { vendorId: v.id, number: `${TAG}-M4`, periodStart: dAgo(60), periodEnd: dAgo(21), amount: 300, status: "PENDING", issuedAt: dAgo(50), dueAt: dAgo(20.5) } as any,
    })
  })

  afterAll(async () => {
    // payments FIRST (FK: SaaSPayment_invoiceId_fkey) — manual rows carry the
    // tag in transactionId, gateway rows in providerTxnId
    await db.saasPayment.deleteMany({ where: { OR: [{ transactionId: { startsWith: `${TAG}` } }, { providerTxnId: { startsWith: `${TAG}` } }] } })
    await db.saasInvoice.deleteMany({ where: { number: { startsWith: `${TAG}` } } })
    await db.vendor.deleteMany({ where: { name: { startsWith: `${TAG}` } } })
  })

  test("money KPIs agree with the database's own truth (full-table, same filters)", async () => {
    const o = await call("owner.billing.overview", {})
    const ms = monthStartUtc()
    const [billedMtd, collectedMtd, open, overdue] = await Promise.all([
      db.saasInvoice.aggregate({ _sum: { amount: true }, where: { issuedAt: { gte: ms } } }),
      db.saasInvoice.aggregate({ _sum: { amount: true }, where: { status: "PAID", paidAt: { gte: ms } } }),
      db.saasInvoice.aggregate({ _count: { _all: true }, _sum: { amount: true }, where: { status: "PENDING" } }),
      db.saasInvoice.aggregate({ _count: { _all: true }, _sum: { amount: true }, where: { status: "PENDING", dueAt: { lt: new Date() } } }),
    ])
    expect(o.money.billedMtd).toBe(Number(billedMtd._sum.amount || 0))
    expect(o.money.collectedMtd).toBe(Number(collectedMtd._sum.amount || 0))
    expect(o.open.count).toBe(open._count._all)
    expect(o.open.amount).toBe(Number(open._sum.amount || 0))
    expect(o.open.overdueCount).toBe(overdue._count._all)
    expect(o.open.overdueAmount).toBe(Number(overdue._sum.amount || 0))
    // the fixtures are in there: billed ≥ 1000, collected ≥ 500, overdue ≥ 1000
    expect(o.money.billedMtd).toBeGreaterThanOrEqual(1000)
    expect(o.money.collectedMtd).toBeGreaterThanOrEqual(500)
    expect(o.open.overdueAmount).toBeGreaterThanOrEqual(1000)
  })

  test("collection rate is a sane percentage and avg days-to-pay is present (10d fixture)", async () => {
    const o = await call("owner.billing.overview", {})
    if (o.money.collectionRate30d != null) {
      expect(o.money.collectionRate30d).toBeGreaterThanOrEqual(0)
      expect(o.money.collectionRate30d).toBeLessThanOrEqual(10000) // can exceed 100 when old invoices settle late
    }
    // avgDaysToPay90d is platform-wide over PAID invoices paid in the last 90d.
    // Other suites legitimately seed PAID invoices into the shared unit-test
    // DB, so the absolute value is NOT fixture-determined — assert it matches
    // the DB's own truth (the file's documented immune-to-other-suites
    // pattern) instead of a constant floor. The 10-day fixture still
    // guarantees at least one row feeds the average.
    const d90 = new Date(Date.now() - 90 * 86400000)
    const paid = await db.saasInvoice.findMany({
      where: { status: "PAID", paidAt: { gte: d90 } },
      select: { issuedAt: true, paidAt: true },
    })
    expect(paid.length).toBeGreaterThanOrEqual(1)
    const avg = paid.reduce((s, r) => s + ((r.paidAt!.getTime() - r.issuedAt.getTime()) / 86400000), 0) / paid.length
    expect(o.money.avgDaysToPay90d).not.toBeNull()
    expect(Number.isFinite(o.money.avgDaysToPay90d as number)).toBe(true)
    expect(o.money.avgDaysToPay90d as number).toBeCloseTo(Math.round(avg * 10) / 10, 1)
  })

  test("aging buckets are exact vs DB truth (boundaries: 100.5d→90+, 20.5d→16–30, future→current)", async () => {
    const o = await call("owner.billing.overview", {})
    const now = new Date()
    const bucketOf = (dueAt: Date | null): string => {
      if (!dueAt || dueAt >= now) return "CURRENT"
      const days = (now.getTime() - dueAt.getTime()) / DAY
      if (days <= 15) return "DUE_1_15"
      if (days <= 30) return "DUE_16_30"
      if (days <= 60) return "DUE_31_60"
      if (days <= 90) return "DUE_61_90"
      return "OVERDUE_90"
    }
    const rows = await db.saasInvoice.findMany({ where: { status: "PENDING" }, select: { dueAt: true, amount: true } })
    const truth: Record<string, { count: number; amount: number }> = {}
    for (const r of rows) {
      const b = bucketOf(r.dueAt)
      truth[b] ??= { count: 0, amount: 0 }
      truth[b].count++
      truth[b].amount += Number(r.amount)
    }
    expect(Object.keys(o.aging).sort()).toEqual(["CURRENT", "DUE_16_30", "DUE_1_15", "DUE_31_60", "DUE_61_90", "OVERDUE_90"])
    for (const b of Object.keys(truth)) {
      expect(o.aging[b]?.count).toBe(truth[b].count)
      expect(o.aging[b]?.amount).toBeCloseTo(truth[b].amount, 2)
    }
  })

  test("trend carries exactly six ascending calendar months ending now, current month includes the fixture", async () => {
    const o = await call("owner.billing.overview", {})
    expect(o.trend.length).toBe(6)
    const n = new Date()
    const curKey = `${n.getUTCFullYear()}-${String(n.getUTCMonth() + 1).padStart(2, "0")}`
    expect(o.trend[5].month).toBe(curKey)
    // strictly ascending, distinct
    for (let i = 1; i < o.trend.length; i++) expect(o.trend[i].month > o.trend[i - 1].month).toBe(true)
    // billed-by-issuance in the current month includes today's 1000 fixture
    expect(o.trend[5].billed).toBeGreaterThanOrEqual(1000)
    // every month carries numbers (zeros allowed — never fabricated, never missing)
    for (const t of o.trend) { expect(typeof t.billed).toBe("number"); expect(typeof t.collected).toBe("number") }
  })

  test("method + provider mixes move by exactly the seeded payment deltas (DIFF)", async () => {
    const before = await call("owner.billing.overview", {})
    const mfsBefore = before.methodMix.find((m: any) => m.key === "MFS")?.amount ?? 0
    const bkashBefore = before.providerMix.find((m: any) => m.key === "BKASH")?.amount ?? 0
    const v = await db.vendor.findFirstOrThrow({ where: { name: { startsWith: TAG } } })
    const paidInv = await db.saasInvoice.findFirstOrThrow({ where: { number: `${TAG}-M2` } })
    const gatewayInv = await db.saasInvoice.findFirstOrThrow({ where: { number: `${TAG}-M1` } })
    await db.saasPayment.create({
      data: { invoiceId: paidInv.id, vendorId: v.id, amount: 500, currency: "BDT", method: "MFS", status: "PAID", transactionId: `${TAG}-TX1`, provider: "MANUAL" } as any,
    })
    await db.saasPayment.create({
      data: { invoiceId: gatewayInv.id, vendorId: v.id, amount: 250, currency: "BDT", method: "CARD", status: "PAID", provider: "BKASH", providerTxnId: `${TAG}-GW1` } as any,
    })
    const after = await call("owner.billing.overview", {})
    const mfsAfter = after.methodMix.find((m: any) => m.key === "MFS")?.amount ?? 0
    const bkashAfter = after.providerMix.find((m: any) => m.key === "BKASH")?.amount ?? 0
    expect(mfsAfter - mfsBefore).toBe(500)
    expect(bkashAfter - bkashBefore).toBe(250)
  })
})

// ----------------------------------------------------------------------------
describe("P2 — owner.billing.invoices (bands, ordering, chips, pagination, search)", () => {
  const TAG = uniq("p2inv")
  const BANDS = ["OVERDUE_90", "OVERDUE_61_90", "OVERDUE_31_60", "OVERDUE_16_30", "OVERDUE_1_15", "DUE_SOON", "CURRENT", "PAID"]
  let vendorName: string
  let paidNumber: string

  beforeAll(async () => {
    const v = await mkVendor(`${TAG} Grid Co`)
    vendorName = v.name
    await mkUser(v.id, { role: "VENDOR_OWNER" })
    // one fixture per band — fractional-day offsets make EXTRACT(DAY) deterministic
    const mk = (number: string, amount: number, over: Record<string, unknown>) =>
      db.saasInvoice.create({ data: { vendorId: v.id, number: `${TAG}-${number}`, periodStart: dAgo(60), periodEnd: dAgo(1), amount, ...over } as any })
    await mk("G1", 91, { status: "PENDING", issuedAt: dAgo(120), dueAt: dAgo(100.5) })
    await mk("G2", 71, { status: "PENDING", issuedAt: dAgo(110), dueAt: dAgo(70.5) })
    await mk("G3", 46, { status: "PENDING", issuedAt: dAgo(100), dueAt: dAgo(45.5) })
    await mk("G4", 21, { status: "PENDING", issuedAt: dAgo(90), dueAt: dAgo(20.5) })
    await mk("G5", 6, { status: "PENDING", issuedAt: dAgo(80), dueAt: dAgo(5.5) })
    await mk("G6", 16, { status: "PENDING", issuedAt: dAgo(70), dueAt: dAhead(5.5) })
    await mk("G7", 31, { status: "PENDING", issuedAt: dAgo(60), dueAt: dAhead(30) })
    paidNumber = `${TAG}-G8`
    await mk("G8", 81, { status: "PAID", issuedAt: dAgo(50), paidAt: dAgo(10), paymentMethod: "CASH" })
  })

  afterAll(async () => {
    await db.saasInvoice.deleteMany({ where: { number: { startsWith: `${TAG}` } } })
    await db.vendor.deleteMany({ where: { name: { startsWith: `${TAG}` } } })
  })

  test("bands are exact, severity-first, with exact day counts", async () => {
    const r = await call("owner.billing.invoices", { page: 1, pageSize: 50, search: vendorName })
    expect(r.total).toBe(8)
    expect(r.rows.map((x: any) => x.band)).toEqual(BANDS)
    const byNumber = new Map<string, any>(r.rows.map((x: any) => [x.number, x] as [string, any]))
    expect(byNumber.get(`${TAG}-G1`).daysOverdue).toBe(100)
    expect(byNumber.get(`${TAG}-G2`).daysOverdue).toBe(70)
    expect(byNumber.get(`${TAG}-G3`).daysOverdue).toBe(45)
    expect(byNumber.get(`${TAG}-G4`).daysOverdue).toBe(20)
    expect(byNumber.get(`${TAG}-G5`).daysOverdue).toBe(5)
    expect(byNumber.get(`${TAG}-G6`).daysOverdue).toBe(0)
    expect(byNumber.get(`${TAG}-G8`).daysOverdue).toBe(0)
    expect(byNumber.get(`${TAG}-G1`).vendorName).toBe(vendorName)
    expect(byNumber.get(`${TAG}-G1`).amount).toBe(91)
  })

  test("the OVERDUE chip narrows IN SQL — no due-soon/current/paid leak", async () => {
    const r = await call("owner.billing.invoices", { page: 1, pageSize: 50, search: vendorName, collection: "OVERDUE" })
    expect(r.total).toBe(5)
    expect(r.rows.every((x: any) => x.band.startsWith("OVERDUE_"))).toBe(true)
    // within the overdue set the severity order still holds (90+ first)
    expect(r.rows.map((x: any) => x.band)).toEqual(["OVERDUE_90", "OVERDUE_61_90", "OVERDUE_31_60", "OVERDUE_16_30", "OVERDUE_1_15"])
  })

  test("the SETTLED chip and the status filter narrow IN SQL", async () => {
    const settled = await call("owner.billing.invoices", { page: 1, pageSize: 50, search: vendorName, collection: "SETTLED" })
    expect(settled.total).toBe(1)
    expect(settled.rows[0].number).toBe(paidNumber)
    const pending = await call("owner.billing.invoices", { page: 1, pageSize: 50, search: vendorName, status: "PENDING" })
    expect(pending.total).toBe(7)
    expect(pending.rows.every((x: any) => x.status === "PENDING")).toBe(true)
  })

  test("pageSize-3 pagination walks the whole set with no duplicates", async () => {
    const seen: string[] = []
    for (let page = 1; page <= 3; page++) {
      const r = await call("owner.billing.invoices", { page, pageSize: 3, search: vendorName })
      expect(r.page).toBe(page)
      expect(r.rows.length).toBe(page < 3 ? 3 : 2)
      seen.push(...r.rows.map((x: any) => x.id))
    }
    expect(new Set(seen).size).toBe(8)
    // page 4 is empty, total unchanged
    const p4 = await call("owner.billing.invoices", { page: 4, pageSize: 3, search: vendorName })
    expect(p4.rows.length).toBe(0)
    expect(p4.total).toBe(8)
  })

  test("search by invoice number isolates a single row", async () => {
    const r = await call("owner.billing.invoices", { page: 1, pageSize: 10, search: paidNumber })
    expect(r.total).toBe(1)
    expect(r.rows[0].number).toBe(paidNumber)
    expect(r.rows[0].band).toBe("PAID")
  })
})

// ----------------------------------------------------------------------------
describe("P2 — owner.billing.payments (stream, filters, search)", () => {
  const TAG = uniq("p2pay")
  let vendorName: string

  beforeAll(async () => {
    const v = await mkVendor(`${TAG} Stream Co`)
    vendorName = v.name
    const mkInv = (number: string) =>
      db.saasInvoice.create({ data: { vendorId: v.id, number: `${TAG}-${number}`, periodStart: dAgo(40), periodEnd: dAgo(10), amount: 400, status: "PAID", issuedAt: dAgo(40), paidAt: dAgo(2) } as any })
    const i1 = await mkInv("P1")
    const i2 = await mkInv("P2")
    const i3 = await mkInv("P3")
    const mkPay = (invoiceId: string, over: Record<string, unknown>, createdAt: Date) =>
      db.saasPayment.create({ data: { invoiceId, vendorId: v.id, amount: 400, currency: "BDT", status: "PAID", ...over, createdAt } as any })
    await mkPay(i1.id, { method: "BANK", provider: "MANUAL", transactionId: `${TAG}-B1` }, dAgo(3))
    await mkPay(i2.id, { method: "MFS", provider: "MANUAL", transactionId: `${TAG}-B2` }, dAgo(2))
    await mkPay(i3.id, { method: "CARD", provider: "BKASH", providerTxnId: `${TAG}-GW9` }, dAgo(1))
  })

  afterAll(async () => {
    await db.saasPayment.deleteMany({ where: { transactionId: { startsWith: `${TAG}` } } })
    await db.saasPayment.deleteMany({ where: { providerTxnId: { startsWith: `${TAG}` } } } as any)
    await db.saasInvoice.deleteMany({ where: { number: { startsWith: `${TAG}` } } })
    await db.vendor.deleteMany({ where: { name: { startsWith: `${TAG}` } } })
  })

  test("newest-first with the joined invoice number and tenant name", async () => {
    const r = await call("owner.billing.payments", { page: 1, pageSize: 10, search: vendorName })
    expect(r.total).toBe(3)
    const ts = r.rows.map((x: any) => new Date(x.createdAt).getTime())
    expect(ts[0]).toBeGreaterThanOrEqual(ts[1])
    expect(ts[1]).toBeGreaterThanOrEqual(ts[2])
    for (const row of r.rows) {
      expect(row.invoiceNumber.startsWith(`${TAG}-`)).toBe(true)
      expect(row.vendorName).toBe(vendorName)
    }
    const gateway = r.rows.find((x: any) => x.provider === "BKASH")
    expect(gateway?.providerTxnId).toBe(`${TAG}-GW9`)
  })

  test("method and provider filters narrow IN SQL", async () => {
    const mfs = await call("owner.billing.payments", { page: 1, pageSize: 10, search: vendorName, method: "MFS" })
    expect(mfs.total).toBe(1)
    expect(mfs.rows[0].method).toBe("MFS")
    expect(mfs.rows[0].invoiceNumber).toBe(`${TAG}-P2`)
    const gw = await call("owner.billing.payments", { page: 1, pageSize: 10, search: vendorName, provider: "BKASH" })
    expect(gw.total).toBe(1)
    expect(gw.rows[0].provider).toBe("BKASH")
    expect(gw.rows[0].providerTxnId).toBe(`${TAG}-GW9`)
  })

  test("search matches the transaction reference", async () => {
    const r = await call("owner.billing.payments", { page: 1, pageSize: 10, search: `${TAG}-GW9` })
    expect(r.total).toBe(1)
    expect(r.rows[0].provider).toBe("BKASH")
  })
})

// ----------------------------------------------------------------------------
describe("P2 — owner.billing.collections (dunning workbench + reminder state)", () => {
  const TAG = uniq("p2col")
  let vendorName: string
  let col1: any
  let col2: any

  beforeAll(async () => {
    const v = await mkVendor(`${TAG} Dunning Co`)
    vendorName = v.name
    await mkUser(v.id, { role: "HR_ADMIN" })
    const mk = (number: string, amount: number, over: Record<string, unknown>) =>
      db.saasInvoice.create({ data: { vendorId: v.id, number: `${TAG}-${number}`, periodStart: dAgo(80), periodEnd: dAgo(41), amount, ...over } as any })
    // worst: 40.5d overdue → 40 days; then 10.5d → 10 days (fractional offsets keep EXTRACT(DAY) deterministic)
    col1 = await mk("C1", 800, { status: "PENDING", issuedAt: dAgo(70), dueAt: dAgo(40.5) })
    col2 = await mk("C2", 400, { status: "PENDING", issuedAt: dAgo(30), dueAt: dAgo(10.5) })
    // never eligible: future-due PENDING + a PAID invoice
    await mk("C3", 999, { status: "PENDING", issuedAt: dAgo(5), dueAt: dAhead(10) })
    await mk("C4", 123, { status: "PAID", issuedAt: dAgo(60), paidAt: dAgo(1) })
  })

  afterAll(async () => {
    await db.saasSetting.deleteMany({ where: { group: "dunning", key: { in: [`inv:${col1?.id}`, `inv:${col2?.id}`] } } })
    await db.saasInvoice.deleteMany({ where: { number: { startsWith: `${TAG}` } } })
    await db.vendor.deleteMany({ where: { name: { startsWith: `${TAG}` } } })
  })

  test("only overdue PENDING invoices surface, worst-first, with exact day counts", async () => {
    const r = await call("owner.billing.collections", { page: 1, pageSize: 10, search: vendorName })
    expect(r.total).toBe(2)
    expect(r.rows.map((x: any) => x.number)).toEqual([`${TAG}-C1`, `${TAG}-C2`])
    expect(r.rows[0].daysOverdue).toBe(40)
    expect(r.rows[1].daysOverdue).toBe(10)
    expect(r.rows[0].remindersSent).toBe(0) // fresh fixtures — no counter yet
    expect(r.policy.cadenceDays).toBe(7)
  })

  test("the per-invoice reminder state (SaaSSetting dunning counters) rides the row", async () => {
    const lastSent = new Date(dAgo(3)).toISOString() // ONE timestamp — reused verbatim
    await db.saasSetting.upsert({
      where: { group_key: { group: "dunning", key: `inv:${col1.id}` } },
      create: { group: "dunning", key: `inv:${col1.id}`, value: JSON.stringify({ lastSent, sent: 2 }) },
      update: { value: JSON.stringify({ lastSent, sent: 2 }) },
    })
    const r = await call("owner.billing.collections", { page: 1, pageSize: 10, search: vendorName })
    const row = r.rows.find((x: any) => x.id === col1.id)
    expect(row.remindersSent).toBe(2)
    expect(row.lastReminderAt).toBe(lastSent)
    expect(r.rows.find((x: any) => x.id === col2.id).remindersSent).toBe(0)
  })

  test("a manual send (owner.dunning.remind) increments the counter the workbench reads", async () => {
    const def = ownerRoutes["owner.dunning.remind"]
    const res = await (def.handler as any)(manageCtx, { invoiceId: col1.id })
    // unconfigured gateway in the test env → SKIPPED, but the counter still bumps (dunning.ts contract)
    expect(["SENT", "SKIPPED", "FAILED"]).toContain(res.status)
    expect(res.remindersSent).toBe(3) // 2 seeded + this manual send
    const r = await call("owner.billing.collections", { page: 1, pageSize: 10, search: vendorName })
    const row = r.rows.find((x: any) => x.id === col1.id)
    expect(row.remindersSent).toBe(3)
    expect(row.lastReminderAt).toBeTruthy()
  })
})

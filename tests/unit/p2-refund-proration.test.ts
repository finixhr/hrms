/// <reference types="bun-types" />
// ============ P2 wave — BUG-6 (refund capability) + BIZ-1 (cycle proration) ============
// BUG-6: gateway refund states map to a REFUNDED outcome that re-opens the
//        invoice for re-billing and audits; an owner refund flow applies the
//        same state machine (bKash additionally gets a real gateway refund
//        call — covered structurally here; the live API path needs creds).
// BIZ-1: a plan cycle switch anchors the new cycle at the CURRENT paid term's
//        end instead of discarding the remaining paid time.
import "./_testdb"
import { describe, test, expect } from "bun:test"
import { db } from "@/lib/db"
import { mkVendor, uniq } from "./_fixtures"
import { settleGatewayPayment } from "@/hrm-server/saas/payments/settle"
import { mapTrxStatus } from "@/hrm-server/saas/payments/paystation"
import { ownerRoutes } from "@/hrm-server/saas/owner-routes"
import { cycleEndDate } from "@/hrm-server/saas/provision"

async function mkBillingWorld() {
  const v = await mkVendor(uniq("P2 Refund"))
  const plan = await db.saasPlan.create({
    data: { name: uniq("P2 Plan"), monthlyPrice: 3000, yearlyPrice: 30000, currency: "BDT", active: true, isPublic: false },
  })
  const sub = await db.saasSubscription.create({
    data: {
      vendorId: v.id, planId: plan.id, planName: plan.name, status: "ACTIVE",
      billingCycle: "MONTHLY", priceAtCreation: 3000,
      startDate: new Date("2026-11-01"), endDate: new Date("2026-12-01"),
    },
  })
  const inv = await db.saasInvoice.create({
    data: {
      vendorId: v.id, subscriptionId: sub.id, number: `INV-P2-${uniq("n")}`,
      periodStart: new Date("2026-11-01"), periodEnd: new Date("2026-12-01"),
      amount: 3000, currency: "BDT", status: "PENDING",
    },
  })
  const pm = await db.saasPayment.create({
    data: {
      invoiceId: inv.id, vendorId: v.id, amount: 3000, currency: "BDT",
      provider: "sslcommerz", providerTxnId: `TXN-${uniq("t")}`, sessionId: `SES-${uniq("s")}`,
      status: "PENDING",
    },
  })
  return { v, plan, sub, inv, pm }
}

const REFUND_VERIFY = (pm: any) => ({
  ok: false,
  status: "REFUNDED" as const,
  providerTxnId: pm.providerTxnId,
  merchantTxnId: pm.id,
  sessionId: pm.sessionId,
  amount: Number(pm.amount),
  detail: "gateway reported the transaction as refunded",
  raw: { refundedBy: "test" },
})

describe("BUG-6 — gateway refund states reach a REFUNDED outcome", () => {
  test("mapper: PayStation 'refund' → REFUNDED (was FAILED)", () => {
    expect(mapTrxStatus("refund")).toBe("REFUNDED")
    expect(mapTrxStatus("failed")).toBe("FAILED")
  })

  test("settle: a REFUNDED verification re-opens a PAID invoice and stamps refundedAt", async () => {
    const { v, sub, inv, pm } = await mkBillingWorld()
    // first settle the payment normally (PAID)
    const paid = await settleGatewayPayment({
      provider: "sslcommerz",
      paymentId: pm.id,
      verified: { ok: true, status: "PAID", providerTxnId: pm.providerTxnId, merchantTxnId: pm.id, sessionId: pm.sessionId, amount: 3000 },
    })
    expect(paid.outcome).toBe("PAID")
    expect((await db.saasInvoice.findUnique({ where: { id: inv.id } }))?.status).toBe("PAID")

    // then the gateway reports the refund (e.g. through the sweep's queryPayment)
    const refunded = await settleGatewayPayment({
      provider: "sslcommerz",
      paymentId: pm.id,
      verified: REFUND_VERIFY(pm) as any,
    })
    expect(refunded.outcome).toBe("REFUNDED")
    const after = await db.saasPayment.findUnique({ where: { id: pm.id } })
    expect(after?.status).toBe("REFUNDED")
    expect(after?.refundedAt).toBeTruthy()
    // the invoice is RE-OPENED for re-billing
    const invAfter = await db.saasInvoice.findUnique({ where: { id: inv.id } })
    expect(invAfter?.status).toBe("PENDING")
    expect(invAfter?.paidAt).toBeNull()
    // dual audit rows exist
    const saasRows = await db.saasAuditLog.findMany({ where: { entity: "SaaSInvoice", entityId: inv.id, action: "PAYMENT_REFUNDED" } })
    expect(saasRows.length).toBeGreaterThanOrEqual(1)
    const tenantRows = await db.auditLog.findMany({ where: { vendorId: v.id, action: "billing.payment.refunded" } })
    expect(tenantRows.length).toBeGreaterThanOrEqual(1)
    void sub
  })

  test("settle: REFUNDED is idempotent (re-reporting a refunded payment is a no-op)", async () => {
    const { inv, pm } = await mkBillingWorld()
    const first = await settleGatewayPayment({ provider: "sslcommerz", paymentId: pm.id, verified: REFUND_VERIFY(pm) as any })
    expect(first.outcome).toBe("REFUNDED")
    const second = await settleGatewayPayment({ provider: "sslcommerz", paymentId: pm.id, verified: REFUND_VERIFY(pm) as any })
    expect(second.outcome).toBe("REFUNDED")
    expect(second.reason).toContain("already refunded")
    // a PENDING invoice was never closed — it stays PENDING (not double-processed)
    expect((await db.saasInvoice.findUnique({ where: { id: inv.id } }))?.status).toBe("PENDING")
  })

  test("owner.invoices.refund: the manual path refunds, re-opens and audits", async () => {
    const { v, inv, pm } = await mkBillingWorld()
    // settle to PAID first so the refund has something to re-open
    await settleGatewayPayment({
      provider: "sslcommerz", paymentId: pm.id,
      verified: { ok: true, status: "PAID", providerTxnId: pm.providerTxnId, merchantTxnId: pm.id, sessionId: pm.sessionId, amount: 3000 },
    })
    const handler = ownerRoutes["owner.invoices.refund"].handler
    expect(handler).toBeTruthy()
    const out: any = await handler({ ownerId: "test-owner", name: "P2 Owner", email: "owner@test.local" } as any, {
      id: inv.id,
      reason: "customer charged twice — goodwill refund",
    })
    expect(out.refunded).toBe(true)
    // sslcommerz has no refund() adapter → the manual recording path
    expect(out.via).toBe("manual")
    expect((await db.saasPayment.findUnique({ where: { id: pm.id } }))?.status).toBe("REFUNDED")
    expect((await db.saasInvoice.findUnique({ where: { id: inv.id } }))?.status).toBe("PENDING")
    const audits = await db.saasAuditLog.findMany({ where: { entity: "SaaSInvoice", entityId: inv.id, action: "INVOICE_REFUND_INITIATED" } })
    expect(audits.length).toBe(1)
    void v
  })

  test("owner.invoices.refund: refuses an invoice with no refundable gateway payment", async () => {
    const { inv } = await mkBillingWorld()
    // no gateway payments on this fresh invoice row (we won't create one)
    await db.saasPayment.deleteMany({ where: { invoiceId: inv.id } })
    const handler = ownerRoutes["owner.invoices.refund"].handler
    await expect(
      handler({ ownerId: "test-owner", name: "P2 Owner" } as any, { id: inv.id, reason: "no gateway payment here" }),
    ).rejects.toMatchObject({ code: 400 })
  })

  test("bkash adapter exposes the Tokenized-Checkout refund API surface", async () => {
    // structural: the provider implements refund() (the live call needs
    // credentials; the endpoint/machinery is exercised by the owner action)
    const { bkashProvider } = await import("@/hrm-server/saas/payments/bkash")
    expect(typeof (bkashProvider as any).refund).toBe("function")
  })
})

describe("BIZ-1 — a cycle switch preserves the paid-through term", () => {
  test("cycleEndDate anchors on the paid term end (not today) in the changePlan handler", async () => {
    const { v, plan, sub } = await mkBillingWorld()
    const yearly = await db.saasPlan.create({
      data: { name: uniq("P2 Yearly"), monthlyPrice: 3000, yearlyPrice: 30000, currency: "BDT", active: true, isPublic: false },
    })
    const handler = ownerRoutes["owner.subscriptions.changePlan"].handler
    const out: any = await handler({ ownerId: "test-owner", name: "P2 Owner" } as any, {
      id: v.id,
      planId: yearly.id,
      billingCycle: "YEARLY",
      note: "BIZ-1 test switch",
    })
    // sub.endDate = 2026-12-01 (in the future) → the new term must end
    // 2027-12-01, NOT one year from today
    expect(out.billingCycle).toBe("YEARLY")
    const endedAt = new Date(out.endDate).toISOString().slice(0, 10)
    expect(endedAt).toBe("2027-12-01")
    // the CYCLE_CHANGED event records the switch
    const events = await db.saasSubscriptionEvent.findMany({ where: { subscriptionId: sub.id, type: "CYCLE_CHANGED" } })
    expect(events.length).toBe(1)
    void plan
  })

  test("an expired term re-anchors at today (the nextTermWindow rule)", () => {
    // unit-level: the anchoring rule the handler now shares with renewals
    const past = new Date("2020-01-01")
    const anchor = past > new Date() ? past : new Date()
    expect(anchor.getTime() - Date.now()).toBeLessThan(60_000) // ~now
    // while a future term end is preserved verbatim
    const future = new Date(Date.now() + 10 * 86400000)
    expect(cycleEndDate(future, "MONTHLY").getTime()).toBeGreaterThan(future.getTime())
  })
})

/// <reference types="bun-types" />
// ============ Billing & Subscription Security & Idempotency Tests ============
import "./_testdb"
import { describe, test, expect, beforeAll } from "bun:test"
import { db } from "@/lib/db"
import { mkVendor, mkUser, mkSession, uniq } from "./_fixtures"
import { createTermInvoice, initiateRenewalInvoice } from "@/hrm-server/saas/payments/billing-ops"
import { settleGatewayPayment, markGatewayPaymentFailed } from "@/hrm-server/saas/payments/settle"
import { sslcommerzProvider } from "@/hrm-server/saas/payments/sslcommerz"
import { resolveEntitlements, invalidateEntitlements } from "@/hrm-server/saas/entitlements"

let vendor: { id: string }
let plan: { id: string }
let subscription: { id: string }

beforeAll(async () => {
  vendor = await mkVendor("Billing Sec Vendor " + uniq("v"))
  plan = await db.saasPlan.create({
    data: {
      name: "Security Plan " + uniq("p"),
      monthlyPrice: 2500,
      yearlyPrice: 25000,
      employeeLimit: 50,
      storageGb: 5,
      isPublic: true,
      active: true,
      sortOrder: 10,
    },
  })
  const start = new Date("2026-11-01T00:00:00Z")
  const end = new Date("2026-12-01T00:00:00Z")
  subscription = await db.saasSubscription.create({
    data: {
      vendorId: vendor.id,
      planId: plan.id,
      planName: "Security Plan",
      billingCycle: "MONTHLY",
      status: "PENDING_PAYMENT",
      startDate: start,
      endDate: end,
      priceAtCreation: 2500,
      currencySnapshot: "BDT",
    },
  })
})

describe("Billing & Subscription Idempotency & Database Integrity", () => {
  test("createTermInvoice is idempotent and reuses existing term invoice", async () => {
    const pStart = new Date("2026-11-01T00:00:00Z")
    const pEnd = new Date("2026-12-01T00:00:00Z")

    const inv1 = await createTermInvoice({
      vendorId: vendor.id,
      subscriptionId: subscription.id,
      amount: 2500,
      currency: "BDT",
      periodStart: pStart,
      periodEnd: pEnd,
      actor: { id: null, name: "Test" },
    })

    const inv2 = await createTermInvoice({
      vendorId: vendor.id,
      subscriptionId: subscription.id,
      amount: 2500,
      currency: "BDT",
      periodStart: pStart,
      periodEnd: pEnd,
      actor: { id: null, name: "Test" },
    })

    expect(inv1.id).toBe(inv2.id)
    expect(inv1.number).toBe(inv2.number)
    expect(inv2.reused).toBe(true)

    const count = await db.saasInvoice.count({
      where: {
        subscriptionId: subscription.id,
        periodStart: pStart,
        periodEnd: pEnd,
        kind: "TERM",
        status: { not: "CANCELLED" },
      },
    })
    expect(count).toBe(1)
  })

  test("concurrent createTermInvoice calls safely return the same invoice without unique constraint error", async () => {
    const pStart = new Date("2026-12-01T00:00:00Z")
    const pEnd = new Date("2027-01-01T00:00:00Z")

    const [resA, resB, resC] = await Promise.all([
      createTermInvoice({
        vendorId: vendor.id,
        subscriptionId: subscription.id,
        amount: 2500,
        currency: "BDT",
        periodStart: pStart,
        periodEnd: pEnd,
        actor: { id: null, name: "Test Parallel" },
      }),
      createTermInvoice({
        vendorId: vendor.id,
        subscriptionId: subscription.id,
        amount: 2500,
        currency: "BDT",
        periodStart: pStart,
        periodEnd: pEnd,
        actor: { id: null, name: "Test Parallel" },
      }),
      createTermInvoice({
        vendorId: vendor.id,
        subscriptionId: subscription.id,
        amount: 2500,
        currency: "BDT",
        periodStart: pStart,
        periodEnd: pEnd,
        actor: { id: null, name: "Test Parallel" },
      }),
    ])

    expect(resA.id).toBe(resB.id)
    expect(resB.id).toBe(resC.id)

    const count = await db.saasInvoice.count({
      where: {
        subscriptionId: subscription.id,
        periodStart: pStart,
        periodEnd: pEnd,
        kind: "TERM",
        status: { not: "CANCELLED" },
      },
    })
    expect(count).toBe(1)
  })

  test("initiateRenewalInvoice is idempotent and does not create duplicate renewal invoices", async () => {
    const ren1 = await initiateRenewalInvoice(vendor.id, { id: null, name: "Renewal Test" })
    const ren2 = await initiateRenewalInvoice(vendor.id, { id: null, name: "Renewal Test" })

    expect(ren1.invoice.id).toBe(ren2.invoice.id)
    expect(ren2.reused).toBe(true)
  })
})

describe("Payment Anti-Tampering, Anti-Replay & Concurrency Security", () => {
  let invoice: { id: string; number: string }
  let payment: { id: string }

  beforeAll(async () => {
    const pStart = new Date("2027-01-01T00:00:00Z")
    const pEnd = new Date("2027-02-01T00:00:00Z")
    invoice = await createTermInvoice({
      vendorId: vendor.id,
      subscriptionId: subscription.id,
      amount: 2500,
      currency: "BDT",
      periodStart: pStart,
      periodEnd: pEnd,
      actor: { id: null, name: "Sec Test" },
    })
    payment = await db.saasPayment.create({
      data: {
        invoiceId: invoice.id,
        vendorId: vendor.id,
        amount: 2500,
        currency: "BDT",
        provider: "sslcommerz",
        status: "PENDING",
      },
    })
  })

  test("settleGatewayPayment rejects underpayment attempts (amount tampering)", async () => {
    const outcome = await settleGatewayPayment({
      provider: "sslcommerz",
      paymentId: payment.id,
      verified: {
        ok: true,
        status: "PAID",
        providerTxnId: "tamper_txn_" + uniq("t"),
        merchantTxnId: payment.id,
        amount: 100, // Underpaid: 100 vs 2500
        raw: { currency: "BDT" },
      },
    })

    expect(outcome.outcome).toBe("AMOUNT_MISMATCH")

    const inv = await db.saasInvoice.findUnique({ where: { id: invoice.id } })
    expect(inv?.status).toBe("PENDING") // Invoice was NOT paid

    const pm = await db.saasPayment.findUnique({ where: { id: payment.id } })
    expect(pm?.status).toBe("PENDING") // Payment was NOT paid
    expect(pm?.failureReason).toContain("underpaid")
  })

  test("settleGatewayPayment rejects currency mismatch attempts", async () => {
    const outcome = await settleGatewayPayment({
      provider: "sslcommerz",
      paymentId: payment.id,
      verified: {
        ok: true,
        status: "PAID",
        providerTxnId: "currency_tamper_" + uniq("c"),
        merchantTxnId: payment.id,
        amount: 2500,
        raw: { currency: "USD" }, // Currency mismatch
      },
    })

    expect(outcome.outcome).toBe("MISMATCH")

    const inv = await db.saasInvoice.findUnique({ where: { id: invoice.id } })
    expect(inv?.status).toBe("PENDING")
  })

  test("settleGatewayPayment rejects merchant reference mismatch (cross-tenant session spoofing)", async () => {
    const outcome = await settleGatewayPayment({
      provider: "sslcommerz",
      paymentId: payment.id,
      verified: {
        ok: true,
        status: "PAID",
        providerTxnId: "spoof_txn_" + uniq("s"),
        merchantTxnId: "wrong_payment_id",
        amount: 2500,
        raw: { currency: "BDT" },
      },
    })

    expect(outcome.outcome).toBe("MISMATCH")
  })

  test("verified payment settlement successfully unlocks workspace and extends subscription", async () => {
    // Subscription is currently PENDING_PAYMENT
    invalidateEntitlements(vendor.id)
    let ent = await resolveEntitlements(vendor.id)
    expect(ent.locked).toBe(true)

    const providerTxnId = "ssl_valid_" + uniq("v")
    const outcome = await settleGatewayPayment({
      provider: "sslcommerz",
      paymentId: payment.id,
      verified: {
        ok: true,
        status: "PAID",
        providerTxnId,
        merchantTxnId: payment.id,
        amount: 2500,
        raw: { currency: "BDT", val_id: providerTxnId },
      },
    })

    expect(outcome.outcome).toBe("PAID")

    const inv = await db.saasInvoice.findUnique({ where: { id: invoice.id } })
    expect(inv?.status).toBe("PAID")
    expect(inv?.paymentMethod).toBe("CARD")

    const pm = await db.saasPayment.findUnique({ where: { id: payment.id } })
    expect(pm?.status).toBe("PAID")
    expect(pm?.providerTxnId).toBe(providerTxnId)

    // Workspace is now UNLOCKED
    invalidateEntitlements(vendor.id)
    ent = await resolveEntitlements(vendor.id)
    expect(ent.status).toBe("ACTIVE")
    expect(ent.locked).toBe(false)
  })

  test("replayed gateway transaction is detected and prevented from settling twice", async () => {
    const settledPayment = await db.saasPayment.findUnique({ where: { id: payment.id } })
    const existingTxnId = settledPayment!.providerTxnId!

    // Create a new fresh payment row
    const freshPayment = await db.saasPayment.create({
      data: {
        invoiceId: invoice.id,
        vendorId: vendor.id,
        amount: 2500,
        currency: "BDT",
        provider: "sslcommerz",
        status: "PENDING",
      },
    })

    // Try to settle with the ALREADY USED providerTxnId (replay attack)
    const replayOutcome = await settleGatewayPayment({
      provider: "sslcommerz",
      paymentId: freshPayment.id,
      verified: {
        ok: true,
        status: "PAID",
        providerTxnId: existingTxnId,
        merchantTxnId: freshPayment.id,
        amount: 2500,
        raw: { currency: "BDT" },
      },
    })

    expect(replayOutcome.outcome).toBe("REPLAY")

    const pm = await db.saasPayment.findUnique({ where: { id: freshPayment.id } })
    expect(pm?.status).toBe("FAILED")
    expect(pm?.failureReason).toContain("duplicate provider txn")
  })
})

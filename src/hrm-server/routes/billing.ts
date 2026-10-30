// ============ WP-H/I — tenant self-service Billing portal routes ============
// Tenant-plane RPC surface for billing (POST /api/hrm {action, payload}).
// All actions are ctx.vendorId-scoped (cross-tenant ids → 404, H-10), strict
// zod payloads, and privileged actions are audited on BOTH planes (tenant
// AuditLog via ../audit + platform SaasAuditLog via the composed owner
// handlers / saasAudit).
//
// PLAN-CHANGE SEMANTICS — composed, never forked (see payments/billing-ops):
//   - Immediate changes run the REAL owner.subscriptions.changePlan handler
//     with a synthetic actor (same events, price snapshots, cycle re-anchor,
//     entitlement invalidation, saasAudit rows as the owner console).
//   - Downgrades scheduled for cycle end are stored as a SaasSubscriptionEvent
//     + SaaSSetting row (no pendingPlanId column exists — frozen schema) and
//     applied by the lifecycle sweep / renewal.
//   - Renewal anchors on provision.cycleEndDate and issues the term invoice.
//
// READONLY NOTE: the /api/hrm dispatcher's frozen MUTATING_VERBS list blocks
// "change"/"start"-headed actions for EXPIRED/SUSPENDED/CANCELLED tenants —
// by design: an expired workspace cannot upgrade or start a checkout, but it
// CAN renew ("renew" is not a mutating verb → offline revival path) and can
// always read invoices/receipts.
//
// GATEWAY FLOW (WP-I): billing.pay.start creates a PENDING SaasPayment row,
// then a hosted-checkout session at the provider; the browser is redirected
// to the gateway; the PUBLIC /api/payments/return endpoint verifies the
// completion SERVER-SIDE (provider validation API) and settles; /api/payments
// /ipn does the same for webhooks, idempotently (unique provider+txn index).
import { z } from "zod"
<<<<<<< HEAD
=======
import { PDFDocument, StandardFonts, rgb } from "pdf-lib"
>>>>>>> origin/main
import { db } from "@/lib/db"
import { route } from "./registry"
import { Deny } from "../rbac"
import { audit } from "../audit"
import { resolveEntitlements } from "../saas/entitlements"
import { getSaasSettings, calculateVatBreakdown } from "../saas/settings"
import { notifyOwnerUsers } from "../saas/notify"
import {
  initiateRenewalInvoice, getPendingDowngrade,
} from "../saas/payments/billing-ops"
import { getPaymentProvider } from "../saas/payments/registry"
import { getProviderConfig, getActivePaymentProviderId, paymentGatewaysAvailable, PROVIDER_LABELS } from "../saas/payments/credentials"
import { requestOrigin, type ProviderInvoice } from "../saas/payments/types"
import type { Ctx } from "../types"

// ---------------- helpers ----------------

async function loadSubscriptionFor(vendorId: string) {
  const sub = await db.saasSubscription.findUnique({ where: { vendorId }, include: { plan: true } })
  if (!sub) {
    throw new Deny("This workspace has no platform subscription (legacy direct-license deployment) — plan and billing are managed by the platform owner.", 400)
  }
  return sub
}

async function loadInvoiceFor(vendorId: string, invoiceId: string) {
  const inv = await db.saasInvoice.findFirst({
    where: {
      vendorId,
      OR: [{ id: invoiceId }, { number: invoiceId }],
    },
  })
  if (!inv) throw new Deny("Invoice not found for your workspace.", 404)
  return inv
}

function tenantAuditCtx(ctx: Ctx, userName?: string) {
  return { vendorId: ctx.vendorId, userId: ctx.userId, userName: userName || ctx.userName, ip: ctx.ip }
}

// ---------------- billing.overview ----------------

route("billing.overview", {
  perm: ["billing", "view"],
  handler: async (ctx) => {
    const [sub, ent, upcoming, pendingDowngrade, gateways, settings, invoiceStats] = await Promise.all([
      db.saasSubscription.findUnique({
        where: { vendorId: ctx.vendorId },
        include: { plan: true, vendor: { select: { name: true } } },
      }),
      resolveEntitlements(ctx.vendorId),
      db.saasInvoice.findFirst({
        where: { vendorId: ctx.vendorId, status: "PENDING" },
        orderBy: { createdAt: "desc" },
      }),
      getPendingDowngrade(ctx.vendorId),
      paymentGatewaysAvailable(),
      getSaasSettings(),
      db.saasInvoice.aggregate({
        where: { vendorId: ctx.vendorId },
        _count: { _all: true },
      }),
    ])
    const outstanding = await db.saasInvoice.aggregate({
      where: { vendorId: ctx.vendorId, status: "PENDING" },
      _sum: { amount: true },
    })
    const lastPaid = await db.saasInvoice.findFirst({
      where: { vendorId: ctx.vendorId, status: "PAID" },
      orderBy: { paidAt: "desc" },
      select: { paidAt: true, number: true },
    })
    return {
      mode: ent.mode,
      status: ent.status,
      planName: sub?.planName ?? null,
      planId: sub?.planId ?? null,
      billingCycle: sub?.billingCycle ?? null,
      startDate: sub?.startDate ?? null,
      endDate: sub?.endDate ?? null,
      daysRemaining: ent.daysRemaining,
      price: sub ? Number(sub.priceAtCreation) : null,
      currency: sub?.currencySnapshot ?? null,
      features: ent.mode === "SUBSCRIBED" ? ent.features : null,
      readonly: ent.readonly,
      // DERIVED display state only — never a stored status (WP-J rule)
      renewalDue: ent.status === "ACTIVE" && ent.daysRemaining != null && ent.daysRemaining >= 0 && ent.daysRemaining <= 30,
      vendorName: sub?.vendor?.name ?? null,
      upcomingInvoice: upcoming
        ? {
            id: upcoming.id, number: upcoming.number,
            amount: Number(upcoming.amount), currency: upcoming.currency,
            status: upcoming.status, dueAt: upcoming.dueAt,
            periodStart: upcoming.periodStart, periodEnd: upcoming.periodEnd,
          }
        : null,
      pendingDowngrade,
      gateways,
      bankInstructions: !!settings.billing.bankTransferInstructions.trim(),
      stats: {
        invoicesTotal: invoiceStats._count._all,
        outstandingAmount: Number(outstanding._sum.amount || 0),
        lastPaidAt: lastPaid?.paidAt ?? null,
        lastPaidInvoice: lastPaid?.number ?? null,
      },
    }
  },
})

// ---------------- billing.invoices ----------------

route("billing.invoices", {
  perm: ["billing", "view"],
  schema: z.object({ take: z.number().int().min(1).max(200).default(100) }).strict(),
  handler: async (ctx, p) => {
    const invoices = await db.saasInvoice.findMany({
      where: { vendorId: ctx.vendorId },
      orderBy: { createdAt: "desc" },
      take: p.take,
    })
    return {
      rows: invoices.map((i) => ({
        id: i.id, number: i.number,
        periodStart: i.periodStart, periodEnd: i.periodEnd,
        amount: Number(i.amount), currency: i.currency,
        status: i.status, issuedAt: i.issuedAt, dueAt: i.dueAt, paidAt: i.paidAt,
        method: i.paymentMethod, transactionId: i.transactionId,
        vatRatePercent: Number(i.vatRatePercent ?? 5.0),
        netAmount: Number(i.netAmount ?? 0),
        vatAmount: Number(i.vatAmount ?? 0),
      })),
    }
  },
})

// ---------------- billing.invoice.get ----------------

route("billing.invoice.get", {
  perm: ["billing", "view"],
  schema: z.object({ id: z.string().trim().min(1).max(40) }).strict(),
  handler: async (ctx, p) => {
    const inv = await loadInvoiceFor(ctx.vendorId, p.id)
    const [payments, sub, vendor, settings] = await Promise.all([
      db.saasPayment.findMany({
        where: { invoiceId: inv.id },
        orderBy: { createdAt: "desc" },
      }),
      inv.subscriptionId ? db.saasSubscription.findUnique({ where: { id: inv.subscriptionId }, include: { plan: true } }) : null,
      db.vendor.findUnique({
        where: { id: ctx.vendorId },
        select: { id: true, name: true, legalName: true, address: true, phone: true, email: true, code: true },
      }),
      getSaasSettings(),
    ])

    const total = Number(inv.amount) || 0
    const vatRate = Number(inv.vatRatePercent ?? settings.billing.vatRatePercent ?? 5.0)
    const net = Number(inv.netAmount) > 0 ? Number(inv.netAmount) : (vatRate > 0 ? Math.round((total / (1 + vatRate / 100)) * 100) / 100 : total)
    const vat = Number(inv.vatAmount) > 0 ? Number(inv.vatAmount) : Math.round((total - net) * 100) / 100
    const isPaid = inv.status === "PAID"
    const paid = isPaid ? total : 0
    const due = total - paid

    return {
      invoice: {
        id: inv.id, number: inv.number,
        periodStart: inv.periodStart, periodEnd: inv.periodEnd,
        amount: total, currency: inv.currency,
        status: inv.status, issuedAt: inv.issuedAt, dueAt: inv.dueAt, paidAt: inv.paidAt,
        method: inv.paymentMethod, transactionId: inv.transactionId, notes: inv.notes,
        planName: sub?.planName ?? "Cloud HR",
        billingCycle: sub?.billingCycle ?? "MONTHLY",
        maxEmployees: sub?.plan?.employeeLimit ?? 250,
        vatRatePercent: vatRate,
        netAmount: net,
        vatAmount: vat,
        paidAmount: paid,
        dueAmount: due,
      },
      vendor: {
        id: vendor?.id,
        code: vendor?.code || "—",
        name: vendor?.name || "Client",
        legalName: vendor?.legalName || vendor?.name || "Client",
        address: vendor?.address || "Dhaka, Bangladesh",
        phone: vendor?.phone || null,
        email: vendor?.email || null,
      },
      billingSettings: settings.billing,
      generalSettings: {
        platformName: settings.general.platformName || "Finix HR",
        supportEmail: settings.general.supportEmail || "support@finixhr.com",
        supportPhone: settings.general.supportPhone || "+8809643666888",
        websiteUrl: settings.general.websiteUrl || "https://hrm.finixmart.com.bd",
        tagline: settings.general.tagline || "Standalone HRM & Workforce Platform",
        address: settings.general.address || settings.billing.companyAddress || "Dhaka, Bangladesh",
        logoUrl: settings.general.logoUrl || "",
        sealUrl: settings.general.sealUrl || "",
        signatureUrl: settings.general.signatureUrl || "",
        signatoryName: settings.general.signatoryName || settings.billing.signatoryName || "MD JAKARIA",
        signatoryDesignation: settings.general.signatoryDesignation || settings.billing.signatoryDesignation || "Executive, Admin & Operations, Finix HR Ltd.",
      },
      // payment history — MASKED: no gateway session ids, no meta blobs
      payments: payments.map((pm) => ({
        id: pm.id,
        amount: Number(pm.amount), currency: pm.currency,
        method: pm.method, provider: pm.provider,
        providerLabel: PROVIDER_LABELS[pm.provider] || null,
        transactionId: pm.transactionId,
        status: pm.status, paidAt: pm.paidAt, createdAt: pm.createdAt,
        failureReason: pm.failureReason, refundedAt: pm.refundedAt,
        recordedByName: pm.recordedByName,
      })),
    }
  },
})

// ---------------- billing.payments (payment history) ----------------

route("billing.payments", {
  perm: ["billing", "view"],
  schema: z.object({ take: z.number().int().min(1).max(200).default(100) }).strict(),
  handler: async (ctx, p) => {
    const payments = await db.saasPayment.findMany({
      where: { vendorId: ctx.vendorId },
      orderBy: { createdAt: "desc" },
      take: p.take,
      include: { invoice: { select: { id: true, number: true, status: true } } },
    })
    return {
      rows: payments.map((pm) => ({
        id: pm.id,
        invoiceId: pm.invoiceId, invoiceNumber: pm.invoice.number, invoiceStatus: pm.invoice.status,
        amount: Number(pm.amount), currency: pm.currency,
        method: pm.method, provider: pm.provider,
        providerLabel: PROVIDER_LABELS[pm.provider] || null,
        transactionId: pm.transactionId,
        status: pm.status, paidAt: pm.paidAt, createdAt: pm.createdAt,
        failureReason: pm.failureReason, refundedAt: pm.refundedAt,
        recordedByName: pm.recordedByName,
      })),
    }
  },
})

// ---------------- billing.plans (public catalog projection) ----------------

route("billing.plans", {
  perm: ["billing", "view"],
  handler: async (ctx) => {
    const [plans, sub] = await Promise.all([
      db.saasPlan.findMany({
        where: { active: true, isPublic: true },
        orderBy: [{ sortOrder: "asc" }, { monthlyPrice: "asc" }],
      }),
      db.saasSubscription.findUnique({ where: { vendorId: ctx.vendorId } }),
    ])
    return {
      currentPlanId: sub?.planId ?? null,
      currentCycle: sub?.billingCycle ?? null,
      plans: plans.map((pl) => ({
        id: pl.id, name: pl.name, tagline: pl.tagline,
        monthlyPrice: Number(pl.monthlyPrice), yearlyPrice: Number(pl.yearlyPrice),
        currency: pl.currency, badge: pl.badge, isTrialPlan: pl.isTrialPlan,
        supportLevel: pl.supportLevel,
        limits: {
          employeeLimit: pl.employeeLimit, userLimit: pl.userLimit, branchLimit: pl.branchLimit,
          departmentLimit: pl.departmentLimit, deviceLimit: pl.deviceLimit,
          storageGb: pl.storageGb, trackingEmployeeLimit: pl.trackingEmployeeLimit,
        },
        features: {
          PAYROLL: pl.payrollEnabled, AIT: pl.aitEnabled, INVENTORY: pl.inventoryEnabled,
          PROCUREMENT: pl.procurementEnabled, PERFORMANCE: pl.performanceEnabled,
          ESS: pl.essEnabled, CAMERA: pl.cameraEnabled, TRACKING: pl.trackingEnabled,
          GEOFENCE: pl.geofenceEnabled, API: pl.apiAccess, ADVANCED_REPORTS: pl.advancedReports,
          FIELD_FORCE: pl.fieldForceEnabled,
        },
      })),
    }
  },
})

// ---------------- billing.changePlan (REQUEST-ONLY since 2026-10-12) ----------
// R5 — SECURITY FIX: this action used to run the REAL owner changePlan
// handler with a synthetic actor — a tenant with billing.manage could flip
// its own plan (entitlements, price snapshot, cycle) WITHOUT any owner
// approval. Tenants may now only SUBMIT a plan-change request
// (SaasPlanChangeRequest, one PENDING request per workspace); the actual
// change happens exclusively through the SaaS Owner approval workflow
// (owner.planchangerequests.approve → owner.subscriptions.changePlan).
//
// The action name is kept for backward compatibility with older SPA builds,
// but its semantics are now identical to billing.planChangeRequest. The
// `effective` parameter is accepted and recorded in the request note
// (scheduling authority stays with the owner).

route("billing.changePlan", {
  perm: ["billing", "manage"],
  schema: z.object({
    planId: z.string().trim().min(1).max(40),
    mode: z.enum(["UPGRADE", "DOWNGRADE"]),
    effective: z.enum(["CYCLE_END", "IMMEDIATE"]).optional(),
    note: z.string().max(500).optional(),
  }).strict(),
  handler: async (ctx, p) => {
    const sub = await loadSubscriptionFor(ctx.vendorId)
    if (sub.status === "CANCELLED" || sub.status === "SUSPENDED") {
      throw new Deny(`This subscription is ${sub.status.toLowerCase()} — contact the platform owner before requesting a plan change.`, 400)
    }
    // one OPEN request per workspace — the queue must stay unambiguous
    const open = await db.saasPlanChangeRequest.findFirst({ where: { vendorId: ctx.vendorId, status: "PENDING" } })
    if (open) {
      throw new Deny(`You already have a pending plan-change request (${open.mode.toLowerCase()} — decided by the platform owner first). It was submitted ${open.createdAt.toISOString().slice(0, 10)}.`, 409)
    }
    const plan = await db.saasPlan.findFirst({ where: { id: p.planId, active: true, isPublic: true } })
    if (!plan) throw new Deny("That plan is not available for selection. Pick a plan from the catalog.", 404)
    if (plan.id === sub.planId) throw new Deny("You are already on this plan.", 400)
    if (plan.isTrialPlan) throw new Deny("Trial plans cannot be requested.", 400)
    const newPrice = sub.billingCycle === "YEARLY" ? plan.yearlyPrice : plan.monthlyPrice
    const isUpgrade = newPrice.gte(sub.priceAtCreation)
    if (p.mode === "UPGRADE" && !isUpgrade) {
      throw new Deny("That plan is cheaper than your current snapshot price — request it as a downgrade instead.", 400)
    }
    if (p.mode === "DOWNGRADE" && !newPrice.lt(sub.priceAtCreation)) {
      throw new Deny("That plan costs the same or more than your current snapshot price — request it as an upgrade instead.", 400)
    }

    const req = await db.saasPlanChangeRequest.create({
      data: {
        vendorId: ctx.vendorId,
        requestedPlanId: plan.id,
        mode: p.mode,
        note: [
          p.note || null,
          p.effective ? `Requested effective: ${p.effective === "CYCLE_END" ? "at the current cycle end" : "immediately upon approval"}` : null,
        ].filter(Boolean).join(" · ") || null,
        status: "PENDING",
        requestedById: ctx.userId,
        requestedByName: ctx.userName,
      },
    })
    await notifyOwnerUsers(
      `Plan change request: ${sub.planName} → ${plan.name} (${p.mode.toLowerCase()})`,
      `A tenant submitted a plan-change request from the Billing portal.\n\n` +
        `Workspace: ${ctx.vendorId}\nCurrent plan: ${sub.planName} (${sub.billingCycle})\n` +
        `Requested: ${plan.name} as ${p.mode === "UPGRADE" ? "an upgrade" : "a downgrade"}\n` +
        (p.note ? `Note: ${p.note}\n` : "") +
        `Approve or reject it from the owner console → Plan Requests.`,
      { perm: "subscriptions.view" }
    )
    await audit(tenantAuditCtx(ctx), "billing.changePlan", "SaasPlanChangeRequest", req.id,
      `Requested plan change: ${sub.planName} → ${plan.name} (${p.mode}) — awaiting platform owner approval`,
      { newValue: { planId: plan.id, mode: p.mode, requestId: req.id } })
    return {
      requestSubmitted: true,
      requestId: req.id,
      status: req.status,
      planName: plan.name,
      mode: req.mode,
      // explicit signal for the SPA: nothing changed yet
      message: "Plan-change request submitted. The platform owner reviews and applies the change — your current plan is unchanged until then.",
    }
  },
})

// ---------------- billing.renew ----------------
// 2026-10-25 SECURITY FIX (master prompt Part F §9): "Renew for another
// cycle" NO LONGER extends the subscription. It issues (or re-uses) the
// PENDING renewal invoice for the next term; the subscription extends ONLY
// when that invoice is PAID and verified (settle.ts → applyPaidTerm, or the
// owner's markPaid). Repeated clicks are idempotent — one open renewal
// invoice per term.
route("billing.renew", {
  perm: ["billing", "manage"],
  schema: z.object({ note: z.string().max(500).optional() }).strict(),
  handler: async (ctx, p) => {
    const actor = { id: ctx.userId, name: `${ctx.userName} (tenant self-service)` }
    const renewal = await initiateRenewalInvoice(ctx.vendorId, actor, {
      note: p.note || "Renewal initiated from the tenant Billing portal",
    })
    await audit(tenantAuditCtx(ctx), "billing.renew", "SaaSInvoice", renewal.invoice.id,
      `Renewal invoice ${renewal.invoice.number} issued for ${renewal.periodStart.toISOString().slice(0, 10)} → ${renewal.periodEnd.toISOString().slice(0, 10)} — pay it to extend the subscription (nothing has changed yet)`,
      { newValue: { invoice: renewal.invoice.number, amount: renewal.amount, periodStart: renewal.periodStart.toISOString(), periodEnd: renewal.periodEnd.toISOString(), reused: renewal.reused } })
    return {
      invoice: renewal.invoice,
      periodStart: renewal.periodStart,
      periodEnd: renewal.periodEnd,
      amount: renewal.amount,
      currency: renewal.currency,
      reused: renewal.reused,
      // explicit signal — the subscription was NOT extended
      message: `Renewal invoice ${renewal.invoice.number} is ready. Complete the payment to extend your subscription — nothing changes until the payment is verified.`,
    }
  },
})

// ---------------- billing.events (subscription event feed) ----------------

route("billing.events", {
  perm: ["billing", "view"],
  schema: z.object({ take: z.number().int().min(1).max(100).default(50) }).strict(),
  handler: async (ctx, p) => {
    const sub = await db.saasSubscription.findUnique({ where: { vendorId: ctx.vendorId } })
    if (!sub) return { rows: [] }
    const events = await db.saasSubscriptionEvent.findMany({
      where: { subscriptionId: sub.id },
      orderBy: { createdAt: "desc" },
      take: p.take,
    })
    return {
      rows: events.map((e) => ({
        id: e.id, type: e.type, note: e.note,
        actorName: e.actorName, createdAt: e.createdAt,
      })),
    }
  },
})

// ---------------- billing.paymentInstructions ----------------

route("billing.paymentInstructions", {
  perm: ["billing", "view"],
  handler: async () => {
    const settings = await getSaasSettings()
    const gateways = await paymentGatewaysAvailable()
    return {
      instructions: settings.billing.bankTransferInstructions.trim() || null,
      supportEmail: settings.general.supportEmail || null,
      gateways,
    }
  },
})

// ---------------- billing.receipt (PDF download) ----------------

route("billing.receipt", {
  perm: ["billing", "view"],
  schema: z.object({ invoiceId: z.string().trim().min(1).max(40) }).strict(),
  handler: async (ctx, p) => {
    const inv = await loadInvoiceFor(ctx.vendorId, p.invoiceId)
    if (inv.status !== "PAID") {
      throw new Deny("A receipt is available once the invoice is paid. Pay the invoice first (or ask the platform owner to record the payment).", 400)
    }
    const [vendor, sub, settings, payment] = await Promise.all([
      db.vendor.findUnique({ where: { id: ctx.vendorId }, select: { name: true, legalName: true, code: true, address: true } }),
      inv.subscriptionId ? db.saasSubscription.findUnique({ where: { id: inv.subscriptionId }, include: { plan: true } }) : Promise.resolve(null),
      getSaasSettings(),
      db.saasPayment.findFirst({ where: { invoiceId: inv.id, status: "PAID" }, orderBy: { paidAt: "desc" } }),
    ])
    const methodLabel = payment?.provider && PROVIDER_LABELS[payment.provider]
      ? `${PROVIDER_LABELS[payment.provider]} (${payment.method || "—"})`
      : inv.paymentMethod || "Bank Transfer"
    const gen = settings.general
    const bill = settings.billing
    const { renderReceiptPdf } = await import("../saas/payments/receipt-pdf")
    const pdf = await renderReceiptPdf({
      platformName: gen.platformName || "Finix HR",
      tagline: gen.tagline || "Standalone HRM & Workforce Platform",
      websiteUrl: gen.websiteUrl || "https://hrm.finixmart.com.bd",
      supportEmail: gen.supportEmail || bill.companyEmail || "support@finixhr.com",
      companyAddress: gen.address || bill.companyAddress || "Dhaka, Bangladesh",
      contactPhone: gen.supportPhone || bill.companyPhone || "+8809643666888",
      logoUrl: gen.logoUrl || "",
      sealUrl: gen.sealUrl || "",
      signatureUrl: gen.signatureUrl || "",
      signatoryName: gen.signatoryName || bill.signatoryName || "MD JAKARIA",
      signatoryDesignation: gen.signatoryDesignation || bill.signatoryDesignation || "Finix HR Ltd.",
      receiptNumber: `MR-${inv.number.replace(/^INV-/, "")}`,
      invoiceNumber: inv.number,
      paidAt: inv.paidAt || payment?.paidAt || inv.issuedAt,
      tenantName: vendor?.legalName || vendor?.name || "Client",
      tenantCode: vendor?.code || `TEN-${ctx.vendorId.slice(-6).toUpperCase()}`,
      planName: sub?.planName || "Business",
      maxEmployees: sub?.plan?.employeeLimit || 250,
      billingCycle: sub?.billingCycle || "MONTHLY",
      periodStart: inv.periodStart,
      periodEnd: inv.periodEnd,
      method: methodLabel,
      transactionId: inv.transactionId || payment?.providerTxnId || payment?.transactionId || "—",
      paidBy: inv.createdByName || payment?.recordedByName || "Finance Department",
      amount: Number(inv.amount),
      currency: inv.currency,
      vatRatePercent: Number(inv.vatRatePercent ?? 5.0),
      netAmount: Number(inv.netAmount) > 0 ? Number(inv.netAmount) : Number(inv.amount),
      vatAmount: Number(inv.vatAmount) > 0 ? Number(inv.vatAmount) : 0,
    })
    return {
      filename: `MoneyReceipt-${inv.number}.pdf`,
      base64: Buffer.from(pdf).toString("base64"),
    }
  },
})

// ---------------- billing.invoice.pdf (2-page standard invoice download) ----------------

route("billing.invoice.pdf", {
  perm: ["billing", "view"],
  schema: z.object({ invoiceId: z.string().trim().min(1).max(40) }).strict(),
  handler: async (ctx, p) => {
    const inv = await loadInvoiceFor(ctx.vendorId, p.invoiceId)
    const [sub, payments, vendor, settings] = await Promise.all([
      inv.subscriptionId ? db.saasSubscription.findUnique({ where: { id: inv.subscriptionId }, include: { plan: true } }) : null,
      db.saasPayment.findMany({ where: { invoiceId: inv.id, status: "PAID" }, orderBy: { paidAt: "desc" } }),
      db.vendor.findUnique({ where: { id: ctx.vendorId } }),
      getSaasSettings(),
    ])
    const gen = settings.general
    const billing = settings.billing
    const { renderInvoicePdf } = await import("../saas/payments/invoice-pdf")
    const pdf = await renderInvoicePdf({
      platformName: gen.platformName || "Finix HR",
      tagline: gen.tagline || "Standalone HRM & Workforce Platform",
      websiteUrl: gen.websiteUrl || (billing.companyWebsite ? (billing.companyWebsite.startsWith("http") ? billing.companyWebsite : `https://${billing.companyWebsite}`) : "https://hrm.finixmart.com.bd"),
      supportEmail: gen.supportEmail || billing.companyEmail || "support@finixhr.com",
      logoUrl: gen.logoUrl || "",
      invoiceNumber: inv.number,
      issuedAt: inv.issuedAt,
      dueAt: inv.dueAt,
      status: inv.status,
      companyLegalName: billing.companyLegalName || "Finix HR Ltd.",
      companyBin: billing.companyBin || "009377515-0111",
      companyAddress: gen.address || billing.companyAddress || "House 11, Road 6, Sector 16/A, Uttara, Dhaka - 1230",
      companyPhone: gen.supportPhone || billing.companyPhone || "+8809643666888",
      companyEmail: gen.supportEmail || billing.companyEmail || "service@finixhr.com",
      companyWebsite: billing.companyWebsite || "finixhr.com",
      customerName: vendor?.legalName || vendor?.name || "Client",
      customerAddress: vendor?.address || "Dhaka, Bangladesh",
      customerPhone: vendor?.phone,
      customerEmail: vendor?.email,
      planName: sub?.planName || "Cloud HR",
      billingCycle: sub?.billingCycle || "MONTHLY",
      periodStart: inv.periodStart,
      periodEnd: inv.periodEnd,
      amount: Number(inv.amount),
      currency: inv.currency,
      vatRatePercent: Number(inv.vatRatePercent ?? billing.vatRatePercent ?? 5.0),
      transactions: payments.map((pm) => ({
        date: pm.paidAt,
        gateway: pm.provider || pm.method || "GATEWAY",
        transactionId: pm.providerTxnId || pm.transactionId || "-",
        amount: Number(pm.amount),
      })),
      primaryBank: {
        bankName: String(billing.primaryBankName || "The City Bank Ltd."),
        accountNo: String(billing.primaryAccountNo || "1233394761001"),
        payeeName: String(billing.primaryAccountName || billing.companyLegalName || "Finix HR Ltd."),
        branch: String(billing.primaryBranch || "Shyamoli"),
        routing: String(billing.primaryRouting || "225264300"),
      },
      secondaryBank: {
        bankName: String(billing.secondaryBankName || "BRAC Bank PLC"),
        accountNo: String(billing.secondaryAccountNo || "2081769340001"),
        payeeName: String(billing.secondaryAccountName || billing.companyLegalName || "Finix HR Ltd."),
        branch: String(billing.secondaryBranch || "Satmasjid Road Branch"),
        routing: String(billing.secondaryRouting || "060276074"),
      },
      mfs: {
        providerName: billing.mfsProviderName || "bKash / Bangla QR",
        merchantNumber: billing.mfsMerchantNumber || billing.bkashMerchantNumber || "01943223366",
        qrUrl: billing.mfsQrUrl || "",
        instructions: billing.mfsInstructions || "Scan QR with bKash / Nagad / Bangla QR app. Enter Invoice Number as Reference.",
      },
      bkash: {
        merchantNumber: String(billing.mfsMerchantNumber || billing.bkashMerchantNumber || "01943223366"),
      },
    })
    return {
      filename: `Invoice-${inv.number}.pdf`,
      base64: Buffer.from(pdf).toString("base64"),
    }
  },
})

// ---------------- billing.mushak.pdf (NBR Mushak-6.3 VAT Tax Invoice Download) ----------------

route("billing.mushak.pdf", {
  perm: ["billing", "view"],
  schema: z.object({ invoiceId: z.string().trim().min(1).max(40) }).strict(),
  handler: async (ctx, p) => {
    const inv = await loadInvoiceFor(ctx.vendorId, p.invoiceId)
    const [sub, vendor, settings] = await Promise.all([
      inv.subscriptionId ? db.saasSubscription.findUnique({ where: { id: inv.subscriptionId }, include: { plan: true } }) : null,
      db.vendor.findUnique({ where: { id: ctx.vendorId } }),
      getSaasSettings(),
    ])
    const gen = settings.general
    const billing = settings.billing
    const { renderMushakPdf } = await import("../saas/payments/mushak-pdf")

    const total = Number(inv.amount) || 0
    const vatRate = Number(inv.vatRatePercent ?? billing.vatRatePercent ?? 5.0)
    const net = Number(inv.netAmount) > 0 ? Number(inv.netAmount) : (vatRate > 0 ? Math.round((total / (1 + vatRate / 100)) * 100) / 100 : total)
    const vat = Number(inv.vatAmount) > 0 ? Number(inv.vatAmount) : Math.round((total - net) * 100) / 100

    const pdf = await renderMushakPdf({
      companyLegalName: billing.companyLegalName || "FINIX HR LTD.",
      companyBin: billing.companyBin || "009377515-0111",
      companyAddress: gen.address || billing.companyAddress || "House 11, Road 6, Sector 16/A, Uttara, Dhaka - 1230",
      customerName: vendor?.legalName || vendor?.name || "Client",
      customerBin: (vendor as any)?.bin || "—",
      customerAddress: vendor?.address || "Dhaka, Bangladesh",
      invoiceNumber: inv.number,
      issuedAt: inv.issuedAt,
      planName: sub?.planName || "Cloud HR",
      billingCycle: sub?.billingCycle || "MONTHLY",
      periodStart: inv.periodStart,
      periodEnd: inv.periodEnd,
      amount: total,
      currency: inv.currency,
      vatRatePercent: vatRate,
      netAmount: net,
      vatAmount: vat,
      signatoryName: gen.signatoryName || billing.signatoryName || "MD JAKARIA",
      signatoryDesignation: gen.signatoryDesignation || billing.signatoryDesignation || "Executive, Admin & Operations, Finix HR Ltd.",
      signatureUrl: gen.signatureUrl || "",
      sealUrl: gen.sealUrl || "",
    })

    return {
      filename: `Mushak-6.3-${inv.number}.pdf`,
      base64: Buffer.from(pdf).toString("base64"),
    }
  },
})



// ---------------- billing.pay.start / billing.pay.status (WP-I) ----------------

route("billing.pay.start", {
  perm: ["billing", "manage"],
  schema: z.object({
    invoiceId: z.string().trim().min(1).max(40),
    // 2026-10-25 (master prompt §7.1): the TENANT no longer selects a gateway.
    // The provider is resolved server-side from the owner-configured ACTIVE
    // gateway. The field is accepted (ignored) so older frontends keep
    // working during deploy rollover.
    provider: z.string().trim().max(20).optional(),
  }).strict(),
  handler: async (ctx, p, req) => {
    // checkout starts are throttled per tenant (row-spam guard)
    const { rateLimit } = await import("../security")
    if (await rateLimit(`pay-start:${ctx.vendorId}`, 10, 60_000)) {
      throw new Deny("Too many payment attempts — wait a minute and try again.", 429)
    }
    // SINGLE-ACTIVE-GATEWAY (master prompt Part E §8.1): server-side
    // resolution — the tenant can never choose or override the gateway.
    const activeId = await getActivePaymentProviderId()
    if (!activeId) {
      throw new Deny("Online payment is not available right now — the platform owner has not activated a payment gateway. Use the bank-transfer instructions or contact support.", 400)
    }
    const provider = getPaymentProvider(activeId)
    if (!provider) throw new Deny("The active payment provider is unavailable.", 400)
    const cfg = await getProviderConfig(provider.id)
    if (!cfg.enabled || !cfg.configured) {
      throw new Deny(`${provider.label} online payment is not enabled on this platform. Use the bank-transfer instructions or contact the platform owner.`, 400)
    }

    const inv = await loadInvoiceFor(ctx.vendorId, p.invoiceId)
    if (inv.status !== "PENDING") throw new Deny("This invoice is not open for payment.", 400)
    if (inv.currency !== "BDT") throw new Deny("Only BDT invoices can be paid through the online gateway.", 400)

    // supersede any earlier open checkout for this invoice (one live session)
    await db.saasPayment.updateMany({
      where: { invoiceId: inv.id, status: "PENDING" },
      data: { status: "FAILED", failureReason: "superseded by a new checkout session" },
    })

    // PENDING payment row first — the gateway session is traceable to it
    const payment = await db.saasPayment.create({
      data: {
        invoiceId: inv.id,
        vendorId: ctx.vendorId,
        amount: inv.amount,
        currency: inv.currency,
        provider: provider.id,
        sessionId: null,
        status: "PENDING",
        recordedById: ctx.userId,
        recordedByName: `${ctx.userName} (tenant self-service)`,
        metaJson: JSON.stringify({ startedBy: ctx.userName, startedAt: new Date().toISOString() }),
      },
    })

    const origin = requestOrigin(req)
    const [vendor, sub, admin] = await Promise.all([
      db.vendor.findUnique({ where: { id: ctx.vendorId }, select: { name: true } }),
      db.saasSubscription.findUnique({ where: { vendorId: ctx.vendorId } }),
      db.user.findFirst({ where: { vendorId: ctx.vendorId, role: "VENDOR_OWNER", status: "ACTIVE" }, select: { name: true, email: true, phone: true } }),
    ])
    const invoice: ProviderInvoice = {
      paymentId: payment.id,
      invoiceNumber: inv.number,
      vendorId: ctx.vendorId,
      tenantName: vendor?.name || "Tenant",
      planName: sub?.planName || null,
      amount: Number(inv.amount),
      currency: "BDT",
      // `ref` = our payment row id; the provider appends its own params
      // (val_id/tran_id, paymentID/status, payment_ref_id/status) to these.
      returnUrl: `${origin}/api/payments/return?provider=${provider.id}&ref=${payment.id}`,
      ipnUrl: `${origin}/api/payments/ipn?provider=${provider.id}&ref=${payment.id}`,
      customerName: admin?.name || null,
      customerEmail: admin?.email || null,
      customerPhone: admin?.phone || null,
    }

    try {
      const session = await provider.createSession(invoice)
      await db.saasPayment.update({
        where: { id: payment.id },
        data: { sessionId: session.sessionId, providerTxnId: session.providerTxnId || null },
      })
      await audit(tenantAuditCtx(ctx), "billing.pay.start", "SaaSInvoice", inv.id,
        `Checkout started for invoice ${inv.number} via ${provider.label} (৳${Number(inv.amount)})`,
        { newValue: { paymentId: payment.id, provider: provider.id, sessionId: session.sessionId } })
      return {
        paymentId: payment.id,
        provider: provider.id,
        sessionId: session.sessionId,
        redirectUrl: session.redirectUrl,
      }
    } catch (e: any) {
      // session creation failed — record it (retry creates a fresh row)
      await db.saasPayment.update({
        where: { id: payment.id },
        data: { status: "FAILED", failureReason: String(e?.message || e).slice(0, 500) },
      })
      throw e
    }
  },
})

route("billing.pay.status", {
  perm: ["billing", "view"],
  schema: z.object({ paymentId: z.string().trim().min(1).max(40) }).strict(),
  handler: async (ctx, p) => {
    const pm = await db.saasPayment.findFirst({ where: { id: p.paymentId, vendorId: ctx.vendorId } })
    if (!pm) throw new Deny("Payment not found for your workspace.", 404)
    return {
      id: pm.id,
      status: pm.status,
      provider: pm.provider,
      providerLabel: PROVIDER_LABELS[pm.provider] || null,
      method: pm.method,
      transactionId: pm.transactionId,
      failureReason: pm.failureReason,
      paidAt: pm.paidAt,
      createdAt: pm.createdAt,
    }
  },
})

// ================= 2026-10-25 — SELF-SERVICE PLAN UPGRADES (master prompt §11) =
// Upgrade with prorated credit: the tenant sees the exact amount payable
// (new-plan price − unused credit on the current plan) BEFORE confirming;
// paying creates a UPGRADE-kind invoice; the plan change is applied ONLY at
// settlement (settle.ts → applyUpgradePaid) — a pending/failed payment never
// grants higher-tier permissions. The tenant can never alter prices: the
// amounts are computed server-side from the plan tables + price snapshots.

route("billing.upgrade.quote", {
  perm: ["billing", "view"],
  schema: z.object({
    planId: z.string().trim().min(1).max(40),
    billingCycle: z.enum(["MONTHLY", "YEARLY"]).optional(),
  }).strict(),
  handler: async (ctx, p) => {
    const sub = await loadSubscriptionFor(ctx.vendorId)
    if (["CANCELLED", "SUSPENDED"].includes(sub.status)) {
      throw new Deny(`This subscription is ${sub.status.toLowerCase()} — contact the platform owner before changing plans.`, 400)
    }
    const plan = await db.saasPlan.findFirst({ where: { id: p.planId, active: true, isPublic: true } })
    if (!plan) throw new Deny("That plan is not available. Pick a plan from the catalog.", 404)
    if (plan.isTrialPlan) throw new Deny("Trial plans cannot be selected.", 400)
    if (plan.id === sub.planId && (!p.billingCycle || p.billingCycle === sub.billingCycle)) {
      throw new Deny("You are already on this plan.", 400)
    }
    const cycle = p.billingCycle || sub.billingCycle
    const newPrice = Number(cycle === "YEARLY" ? plan.yearlyPrice : plan.monthlyPrice)
    const currentPrice = Number(sub.priceAtCreation)

    // Proration credit: unused whole+fractional days of the CURRENT term at
    // the current plan's daily rate (documented policy — credit, not refund).
    const now = new Date()
    const end = sub.endDate ? sub.endDate.getTime() : null
    const termStart = sub.startDate.getTime()
    const totalMs = end && end > termStart ? end - termStart : (cycle === "YEARLY" ? 365 : 30) * 86400000
    const remainingMs = end && end > now.getTime() ? end - now.getTime() : 0
    const credit = Math.min(currentPrice, Math.max(0, Math.round((remainingMs / totalMs) * currentPrice * 100) / 100))
    const amountDue = Math.max(0, Math.round((newPrice - credit) * 100) / 100)

    return {
      currentPlanName: sub.planName,
      currentPrice,
      targetPlanName: plan.name,
      targetPlanId: plan.id,
      billingCycle: cycle,
      newPrice,
      credit: Number(credit.toFixed(2)),
      amountDue,
      daysRemaining: end ? Math.ceil((end - now.getTime()) / 86400000) : null,
      // explicit confirmation signal — the UI must show this breakdown
      message: amountDue > 0
        ? `Upgrade to ${plan.name}: ৳${newPrice.toFixed(2)} minus ৳${credit.toFixed(2)} unused-time credit = ৳${amountDue.toFixed(2)} payable now.`
        : `Upgrade to ${plan.name} is covered by your unused-time credit (৳${credit.toFixed(2)}) — no payment needed; the owner applies the change.`,
    }
  },
})

route("billing.upgrade.start", {
  perm: ["billing", "manage"],
  schema: z.object({
    planId: z.string().trim().min(1).max(40),
    billingCycle: z.enum(["MONTHLY", "YEARLY"]).optional(),
    note: z.string().trim().max(500).optional(),
  }).strict(),
  handler: async (ctx, p) => {
    const { rateLimit } = await import("../security")
    if (await rateLimit(`upgrade-start:${ctx.vendorId}`, 5, 60_000)) {
      throw new Deny("Too many upgrade attempts — wait a minute and try again.", 429)
    }
    const sub = await loadSubscriptionFor(ctx.vendorId)
    if (["CANCELLED", "SUSPENDED", "PENDING_PAYMENT"].includes(sub.status)) {
      throw new Deny(`This subscription is ${sub.status.toLowerCase().replace("_", " ")} — ${sub.status === "PENDING_PAYMENT" ? "complete the initial payment first" : "contact the platform owner"} before changing plans.`, 400)
    }
    const plan = await db.saasPlan.findFirst({ where: { id: p.planId, active: true, isPublic: true } })
    if (!plan) throw new Deny("That plan is not available. Pick a plan from the catalog.", 404)
    if (plan.isTrialPlan) throw new Deny("Trial plans cannot be selected.", 400)
    if (plan.id === sub.planId && (!p.billingCycle || p.billingCycle === sub.billingCycle)) {
      throw new Deny("You are already on this plan.", 400)
    }
    const cycle = p.billingCycle || sub.billingCycle
    const newPrice = Number(cycle === "YEARLY" ? plan.yearlyPrice : plan.monthlyPrice)
    if (newPrice < Number(sub.priceAtCreation) && plan.id !== sub.planId) {
      // cheaper plan + different plan → that's a downgrade: request-only flow
      throw new Deny("That plan is cheaper than your current snapshot price — submit a downgrade request instead (the owner approves it at cycle end).", 400)
    }

    // one OPEN upgrade invoice at a time (idempotent per target plan)
    const open = await db.saasInvoice.findFirst({
      where: { vendorId: ctx.vendorId, status: "PENDING", kind: "UPGRADE", upgradePlanId: plan.id },
    })
    if (open) {
      return {
        invoice: { id: open.id, number: open.number },
        amount: Number(open.amount),
        reused: true,
        message: `Upgrade invoice ${open.number} is already open — complete its payment to switch to ${plan.name}.`,
      }
    }

    // proration (same formula as the quote)
    const now = new Date()
    const end = sub.endDate ? sub.endDate.getTime() : null
    const termStart = sub.startDate.getTime()
    const totalMs = end && end > termStart ? end - termStart : (cycle === "YEARLY" ? 365 : 30) * 86400000
    const remainingMs = end && end > now.getTime() ? end - now.getTime() : 0
    const credit = Math.min(Number(sub.priceAtCreation), Math.max(0, Math.round((remainingMs / totalMs) * Number(sub.priceAtCreation) * 100) / 100))
    const amountDue = Math.max(0, Math.round((newPrice - credit) * 100) / 100)

    if (amountDue <= 0) {
      // credit covers it entirely — route to the owner request queue (the
      // owner applies free plan changes deliberately; nothing self-serves
      // around payment discipline)
      throw new Deny("This upgrade is fully covered by your unused-time credit — submit a plan-change request and the platform owner will apply it.", 400)
    }

    let inv: { id: string; number: string; amount: any }
    let reused = false
    try {
      const settings = await getSaasSettings()
      const vatRate = Number(settings.billing.vatRatePercent ?? 5.0)
      const { netAmount, vatAmount } = calculateVatBreakdown(amountDue, vatRate)
      const number = await (await import("../saas/sequences")).nextInvoiceNumber()
      inv = await db.saasInvoice.create({
        data: {
          vendorId: ctx.vendorId,
          subscriptionId: sub.id,
          number,
          periodStart: now,
          periodEnd: sub.endDate || now,
          amount: amountDue,
          currency: sub.currencySnapshot || plan.currency,
          vatRatePercent: vatRate,
          netAmount,
          vatAmount,
          kind: "UPGRADE",
          upgradePlanId: plan.id,
          status: "PENDING",
          dueAt: now,
          notes: `Plan upgrade — ${sub.planName} → ${plan.name} (${cycle.toLowerCase()}); new plan activates after verified payment`,
          createdById: ctx.userId,
          createdByName: `${ctx.userName} (tenant self-service)`,
        },
      })
      await audit(tenantAuditCtx(ctx), "billing.upgrade.start", "SaaSInvoice", inv.id,
        `Upgrade invoice ${number} issued: ${sub.planName} → ${plan.name}, ৳${newPrice.toFixed(2)} − ৳${credit.toFixed(2)} credit = ৳${amountDue.toFixed(2)} — plan changes only after verified payment`,
        { newValue: { planId: plan.id, planName: plan.name, newPrice, credit, amountDue } })
      const { notifyInvoiceIssued } = await import("../saas/notify")
      notifyInvoiceIssued(inv.id).catch((err) => console.error("notifyInvoiceIssued background error:", err))
    } catch (e: any) {
      const existing = await db.saasInvoice.findFirst({
        where: { vendorId: ctx.vendorId, status: "PENDING", kind: "UPGRADE", upgradePlanId: plan.id },
      })
      if (existing) {
        inv = existing
        reused = true
      } else {
        throw e
      }
    }
    return {
      invoice: { id: inv.id, number: inv.number },
      amount: Number(inv.amount),
      credit,
      newPrice,
      reused,
      message: reused
        ? `Upgrade invoice ${inv.number} is already open — complete its payment to switch to ${plan.name}.`
        : `Upgrade invoice ${inv.number} is ready. Complete the payment to activate ${plan.name} — your current plan is unchanged until then.`,
    }
  },
})

// ================= WAVE 3 WP-C — PLAN-CHANGE REQUESTS =================
// Tenants whose roles lack billing.manage cannot run billing.changePlan
// themselves. These RPCs let them SUBMIT an upgrade/downgrade request that
// the owner console approves (owner.planchangerequests.*) or rejects; the
// approval path applies the REAL owner.subscriptions.changePlan semantics.
// H-10: rows are vendorId-scoped; the notify fan-out targets owners with
// subscriptions.view exactly like the self-service change notifications.

route("billing.planChangeRequest", {
  perm: ["billing", "view"],
  schema: z.object({
    planId: z.string().trim().min(1).max(40),
    mode: z.enum(["UPGRADE", "DOWNGRADE"]),
    note: z.string().trim().max(500).optional(),
  }).strict(),
  handler: async (ctx, p) => {
    const { rateLimit } = await import("../security")
    if (await rateLimit(`plan-req:${ctx.vendorId}`, 5, 60_000)) {
      throw new Deny("Too many plan-change requests — wait a minute and try again", 429)
    }
    const sub = await loadSubscriptionFor(ctx.vendorId)
    if (sub.status === "CANCELLED" || sub.status === "SUSPENDED") {
      throw new Deny(`This subscription is ${sub.status.toLowerCase()} — contact the platform owner before requesting a plan change.`, 400)
    }
    // one OPEN request per workspace — the queue must stay unambiguous
    const open = await db.saasPlanChangeRequest.findFirst({ where: { vendorId: ctx.vendorId, status: "PENDING" } })
    if (open) {
      throw new Deny(`You already have a pending plan-change request (${open.mode.toLowerCase()} decided by the platform owner first). It was submitted ${open.createdAt.toISOString().slice(0, 10)}.`, 409)
    }
    // self-service catalog only: active + public plans (same gate as changePlan)
    const plan = await db.saasPlan.findFirst({ where: { id: p.planId, active: true, isPublic: true } })
    if (!plan) throw new Deny("That plan is not available for selection. Pick a plan from the catalog.", 404)
    if (plan.id === sub.planId) throw new Deny("You are already on this plan.", 400)
    if (plan.isTrialPlan) throw new Deny("Trial plans cannot be requested.", 400)
    const newPrice = sub.billingCycle === "YEARLY" ? plan.yearlyPrice : plan.monthlyPrice
    const isUpgrade = newPrice.gte(sub.priceAtCreation)
    if (p.mode === "UPGRADE" && !isUpgrade) {
      throw new Deny("That plan is cheaper than your current snapshot price — request it as a downgrade instead.", 400)
    }
    if (p.mode === "DOWNGRADE" && !newPrice.lt(sub.priceAtCreation)) {
      throw new Deny("That plan costs the same or more than your current snapshot price — request it as an upgrade instead.", 400)
    }
    const req = await db.saasPlanChangeRequest.create({
      data: {
        vendorId: ctx.vendorId,
        requestedPlanId: plan.id,
        mode: p.mode,
        note: p.note || null,
        status: "PENDING",
        requestedById: ctx.userId,
        requestedByName: ctx.userName,
      },
    })
    await notifyOwnerUsers(
      `Plan change request: ${sub.planName} → ${plan.name} (${p.mode.toLowerCase()})`,
      `A tenant submitted a plan-change request from the Subscription page.\n\n` +
        `Workspace: ${ctx.vendorId}\nCurrent plan: ${sub.planName} (${sub.billingCycle})\n` +
        `Requested: ${plan.name} as ${p.mode === "UPGRADE" ? "an upgrade" : "a downgrade"}\n` +
        (p.note ? `Note: ${p.note}\n` : "") +
        `Approve or reject it from the owner console → Plan Requests.`,
      { perm: "subscriptions.view" }
    )
    await audit(tenantAuditCtx(ctx), "billing.planChangeRequest", "SaasPlanChangeRequest", req.id,
      `Requested plan change: ${sub.planName} → ${plan.name} (${p.mode})`,
      { newValue: { planId: plan.id, mode: p.mode } })
    return { requestId: req.id, status: req.status, planName: plan.name, mode: req.mode }
  },
})

route("billing.planChangeRequests", {
  perm: ["billing", "view"],
  schema: z.object({}).strict(),
  handler: async (ctx) => {
    const rows = await db.saasPlanChangeRequest.findMany({
      where: { vendorId: ctx.vendorId },
      orderBy: { createdAt: "desc" },
      take: 20,
    })
    const plans = rows.length
      ? await db.saasPlan.findMany({ where: { id: { in: rows.map((r) => r.requestedPlanId) } }, select: { id: true, name: true } })
      : []
    return {
      rows: rows.map((r) => ({
        id: r.id,
        planName: plans.find((pl) => pl.id === r.requestedPlanId)?.name || r.requestedPlanId,
        mode: r.mode,
        note: r.note,
        status: r.status,
        requestedByName: r.requestedByName,
        decidedByName: r.decidedByName,
        decidedAt: r.decidedAt,
        decisionNote: r.decisionNote,
        createdAt: r.createdAt,
      })),
      pending: rows.some((r) => r.status === "PENDING"),
    }
  },
})

// ============ WP-H/I/J — shared billing operations (the composition layer) ============
// ONE place for the tenant-plane billing semantics, deliberately COMPOSING the
// owner console's plan-change actions instead of forking them:
//
//   - Immediate plan changes invoke the REAL owner action handler
//     (`ownerRoutes["owner.subscriptions.changePlan"].handler`) with a
//     synthetic owner actor, so the UPGRADED/DOWNGRADED/CYCLE_CHANGED event
//     types, price snapshotting, cycle re-anchoring, entitlement invalidation
//     and saasAudit rows are produced by the exact code the owner console
//     runs — the flows can never drift apart.
//   - Renewal/extension re-implements the owner `subscriptions.extend`
//     snapshot+audit shape MINIMALLY (documented duplication) because renewal
//     must anchor the new term with provision.cycleEndDate (setFullYear for
//     YEARLY — leap-day safe) and generate the term invoice, which the owner
//     extend handler does not do.
//   - Scheduled downgrades (no pendingPlanId column exists on
//     SaasSubscription — frozen schema) are stored as a SaasSubscriptionEvent
//     (type DOWNGRADE_SCHEDULED) + a SaaSSetting row (group "billing", key
//     `pendingPlan:<vendorId>`) and are applied by the lifecycle sweep (or by
//     renewal — see the semantics note below) at the recorded cycle end.
//
// SCHEDULED DOWNGRADE SEMANTICS (documented decision):
//   - The schedule records `scheduledFor` = the subscription's endDate at the
//     time of the request (the current term's end).
//   - The lifecycle sweep applies it once now >= scheduledFor.
//   - billing.renew applies it FIRST (a renewal starts the next term, so the
//     new term is priced on the downgraded plan — the renewal invoice
//     therefore carries the new plan's price).
//   - A subsequent immediate changePlan replaces any pending schedule.
//   - Settling an already-issued invoice never touches the schedule (that
//     invoice was priced on the then-current plan).
import { db } from "@/lib/db"
import { j } from "../../utils"
import type { Ctx } from "../../types"
import type { OwnerCtx } from "../owner-auth"
import { ownerRoutes } from "../owner-routes"
import { nextInvoiceNumber } from "../sequences"
import { cycleEndDate } from "../provision"
import { invalidateEntitlements } from "../entitlements"
import { saasAudit, type SaasAuditActor } from "../audit"
import { getSaasSettings, calculateVatBreakdown } from "../settings"

export type BillingActor = SaasAuditActor // {id?, name?} — owner user, tenant user, gateway or scheduler

/** Synthetic owner-plane actor for invoking owner action handlers from the
 *  tenant self-service portal. The actor name carries the provenance so every
 *  event/audit row it produces is traceable to a tenant user. */
export function tenantSelfServiceActor(ctx: Ctx): OwnerCtx {
  return {
    ownerId: ctx.userId,
    name: `${ctx.userName} (tenant self-service)`,
    email: "",
    roleKey: "TENANT_SELF_SERVICE",
    permissions: new Set<string>(),
  }
}

/** Actor for automated flows (gateway settlement, lifecycle sweep). */
export function systemActor(name: string): BillingActor {
  return { id: null, name }
}

// ---------------- term invoices ----------------

/** Create the invoice for one billing term — idempotent and concurrency-safe.
 *  Checks for existing non-cancelled TERM invoices for the same subscription
 *  window to prevent duplicates. Catches unique constraint violations (P2002)
 *  on concurrent requests. */
export async function createTermInvoice(input: {
  vendorId: string
  subscriptionId: string | null
  registrationId?: string | null
  amount: number
  currency: string
  periodStart: Date
  periodEnd: Date
  dueAt?: Date | null
  notes?: string | null
  actor: BillingActor
  vatRatePercent?: number
}): Promise<{ id: string; number: string; reused?: boolean }> {
  // Idempotency check: if an active (non-cancelled) term invoice already exists for this exact term, reuse it
  if (input.subscriptionId) {
    const existing = await db.saasInvoice.findFirst({
      where: {
        subscriptionId: input.subscriptionId,
        periodStart: input.periodStart,
        periodEnd: input.periodEnd,
        kind: "TERM",
        status: { not: "CANCELLED" },
      },
    })
    if (existing) {
      if ((input.registrationId && !existing.registrationId) || (input.dueAt && !existing.dueAt)) {
        await db.saasInvoice.update({
          where: { id: existing.id },
          data: {
            registrationId: input.registrationId || existing.registrationId,
            dueAt: input.dueAt || existing.dueAt,
          },
        }).catch(() => {})
      }
      return { id: existing.id, number: existing.number, reused: true }
    }
  }

  try {
    const settings = await getSaasSettings()
    const vatRate = input.vatRatePercent !== undefined ? Number(input.vatRatePercent) : Number(settings.billing.vatRatePercent ?? 5.0)
    const { netAmount, vatAmount } = calculateVatBreakdown(input.amount, vatRate)
    const number = await nextInvoiceNumber()
    const inv = await db.saasInvoice.create({
      data: {
        vendorId: input.vendorId,
        subscriptionId: input.subscriptionId,
        registrationId: input.registrationId ?? null,
        number,
        periodStart: input.periodStart,
        periodEnd: input.periodEnd,
        amount: input.amount,
        currency: input.currency || "BDT",
        vatRatePercent: vatRate,
        netAmount,
        vatAmount,
        kind: "TERM",
        status: "PENDING",
        dueAt: input.dueAt ?? null,
        notes: input.notes ?? null,
        createdById: input.actor?.id || null,
        createdByName: input.actor?.name || null,
      },
    })
    await saasAudit(input.actor, "INVOICE_CREATED", "SaaSInvoice", inv.id,
      `Invoice ${number} for term ${input.periodStart.toISOString().slice(0, 10)} → ${input.periodEnd.toISOString().slice(0, 10)} (BDT ${input.amount})`,
      { vendorId: input.vendorId, metadata: { number, amount: input.amount, periodStart: input.periodStart.toISOString(), periodEnd: input.periodEnd.toISOString() } })
    // Dispatch automated email notification with PDF attachment (best-effort background)
    const { notifyInvoiceIssued } = await import("../notify")
    notifyInvoiceIssued(inv.id).catch((err) => console.error("notifyInvoiceIssued background error:", err))
    return { id: inv.id, number: inv.number, reused: false }
  } catch (e: any) {
    // Unique constraint violation (concurrent insert race)
    if (e?.code === "P2002" && input.subscriptionId) {
      const dupe = await db.saasInvoice.findFirst({
        where: {
          subscriptionId: input.subscriptionId,
          periodStart: input.periodStart,
          periodEnd: input.periodEnd,
          kind: "TERM",
          status: { not: "CANCELLED" },
        },
      })
      if (dupe) {
        return { id: dupe.id, number: dupe.number, reused: true }
      }
    }
    throw e
  }
}

// ---------------- renewal — PAYMENT-GATED (2026-10-25, master prompt Part F §9) ----------------
//
// SECURITY FIX — the "free renewal" vulnerability:
//   BEFORE: billing.renew → renewSubscription() extended endDate by one full
//   cycle and revived EXPIRED → ACTIVE with ZERO payment verification. Worse,
//   because gateway settlement ALSO extended on the PENDING term invoice the
//   renewal had just created, a renew-then-pay sequence DOUBLE-extended the
//   subscription for one payment.
//
//   AFTER: renewal is split into two distinct, audited operations:
//     1. initiateRenewalInvoice() — what the tenant's "Renew for another
//        cycle" button does. Issues (or re-uses) the PENDING renewal invoice
//        for the NEXT term. NEVER touches the subscription. The subscription
//        only changes after that invoice is PAID and VERIFIED.
//     2. applyPaidTerm() — the ONLY code path that extends a subscription
//        from a payment. Runs when an invoice flips PENDING → PAID through
//        gateway settlement (settle.ts) or owner markPaid. Idempotent by
//        construction: it anchors on the INVOICE's own period, so re-paying,
//        duplicate webhooks and replays can never extend twice.
//
//   Owner-authorized free extensions remain available through the explicit
//   owner.subscriptions.extend action (the deliberately-authorized lever,
//   audited) — never through the tenant portal.

/** Compute the next term window for a subscription. The next term starts at
 *  the current paid-through endDate (early renewal stacks time) or at the
 *  payment moment when the term has already fully elapsed (documented
 *  post-expiry policy: the new term anchors at the payment date). */
export function nextTermWindow(sub: { endDate: Date | null; billingCycle: string }, paidAt?: Date) {
  const now = paidAt || new Date()
  const anchor = sub.endDate && sub.endDate.getTime() > now.getTime() ? sub.endDate : now
  return { start: anchor, end: cycleEndDate(anchor, sub.billingCycle) }
}

/** Create (or re-use) the PENDING renewal invoice for the subscription's
 *  next term. Safe to call repeatedly — one open renewal invoice per term
 *  (matched on vendor + period). Does NOT modify the subscription. */
export async function initiateRenewalInvoice(
  vendorId: string,
  actor: BillingActor,
  opts: { note?: string } = {},
): Promise<{
  subscriptionId: string
  invoice: { id: string; number: string }
  periodStart: Date
  periodEnd: Date
  amount: number
  currency: string
  reused: boolean
}> {
  let sub = await db.saasSubscription.findUnique({ where: { vendorId } })
  if (!sub) throw Object.assign(new Error("This workspace has no subscription — the plan is managed by the platform owner."), { code: 400 })
  if (sub.status === "CANCELLED" || sub.status === "SUSPENDED") {
    throw Object.assign(new Error(`This subscription is ${sub.status.toLowerCase()} — contact the platform owner to reactivate it before renewing.`), { code: 400 })
  }
  // ONE_TIME entitlements never renew (master prompt §12.1C): no renewal
  // invoices, no reminders — the owner re-assigns or extends explicitly.
  if (sub.billingMode === "ONE_TIME" || (await db.saasPlan.findUnique({ where: { id: sub.planId }, select: { billingMode: true } }))?.billingMode === "ONE_TIME") {
    throw Object.assign(new Error("This is a one-time plan — it does not renew automatically. Contact the platform owner to extend or re-assign your entitlement."), { code: 400 })
  }

  // A renewal invoice is priced on the plan the NEXT term will run on — a
  // scheduled downgrade applies at renewal (the invoice carries the new plan).
  const applied = await applyPendingDowngrade(vendorId, actor, { force: false })
  if (applied) {
    const refreshed = await db.saasSubscription.findUnique({ where: { vendorId } })
    if (refreshed) sub = refreshed
  }

  const term = nextTermWindow(sub)
  const amount = Number(sub.priceAtCreation)

  // idempotency: one OPEN renewal invoice per term — repeated clicks reuse it
  const existing = await db.saasInvoice.findFirst({
    where: {
      vendorId,
      status: "PENDING",
      subscriptionId: sub.id,
      periodStart: term.start,
      periodEnd: term.end,
    },
  })
  if (existing) {
    return {
      subscriptionId: sub.id,
      invoice: { id: existing.id, number: existing.number },
      periodStart: term.start,
      periodEnd: term.end,
      amount: Number(existing.amount),
      currency: existing.currency,
      reused: true,
    }
  }

  const invoice = await createTermInvoice({
    vendorId,
    subscriptionId: sub.id,
    amount,
    currency: sub.currencySnapshot,
    periodStart: term.start,
    periodEnd: term.end,
    dueAt: term.start, // the term is due by its start (cycle end)
    notes: opts.note || `Renewal — ${sub.planName} (${sub.billingCycle.toLowerCase()}); the subscription extends only after this invoice is paid`,
    actor,
  })
  await saasAudit(actor, "RENEWAL_INVOICE_ISSUED", "SaaSInvoice", invoice.id,
    `Renewal invoice ${invoice.number} issued for term ${term.start.toISOString().slice(0, 10)} → ${term.end.toISOString().slice(0, 10)} (BDT ${amount}) — the subscription is NOT extended until this invoice is paid`,
    { vendorId, metadata: { number: invoice.number, amount, periodStart: term.start.toISOString(), periodEnd: term.end.toISOString() } })
  return {
    subscriptionId: sub.id,
    invoice,
    periodStart: term.start,
    periodEnd: term.end,
    amount,
    currency: sub.currencySnapshot,
    reused: false,
  }
}

/** Apply a PAID invoice's term to the subscription — the ONLY payment-driven
 *  extension path (settle.ts + owner.invoices.markPaid). Idempotent:
 *  - extension anchors on the invoice's OWN periodEnd, so a re-paid or
 *    duplicate-settled invoice can never extend twice (sub.endDate only ever
 *    moves forward to the invoice's period end);
 *  - the PENDING_PAYMENT → ACTIVE activation is guarded by the caller's
 *    conditional PENDING→PAID invoice flip, which itself is race-safe.
 *  Late-payment policy (documented): when a term invoice is paid AFTER its
 *  period already elapsed, the paid term re-anchors at the payment date so
 *  the tenant receives a full cycle of value. */
export async function applyPaidTerm(
  invoice: { id: string; number: string; vendorId: string; subscriptionId: string | null; periodStart: Date; periodEnd: Date; amount: unknown },
  actor: BillingActor,
  opts: { note?: string } = {},
): Promise<{ subscriptionId: string; endDate: Date | null; status: string; extended: boolean; activated: boolean }> {
  if (!invoice.subscriptionId) {
    throw Object.assign(new Error("Invoice is not term-linked to a subscription."), { code: 400 })
  }
  const sub = await db.saasSubscription.findUnique({ where: { vendorId: invoice.vendorId } })
  if (!sub) {
    throw Object.assign(new Error("This workspace has no subscription — the plan is managed by the platform owner."), { code: 400 })
  }
  if (sub.status === "CANCELLED" || sub.status === "SUSPENDED") {
    // An owner suspension is an independent administrative state — paying an
    // invoice must never silently override it (master prompt Part I §14).
    return { subscriptionId: sub.id, endDate: sub.endDate, status: sub.status, extended: false, activated: false }
  }

  // Late-payment re-anchor: paying after the period elapsed buys a full term
  // from the payment moment instead of stacking dead time.
  const now = new Date()
  let periodEnd = invoice.periodEnd
  let lateReanchored = false
  const subEnd = sub.endDate // null = non-expiring ONE_TIME entitlement
  if (subEnd && invoice.periodEnd.getTime() <= now.getTime() && subEnd.getTime() <= now.getTime()) {
    periodEnd = cycleEndDate(now, sub.billingCycle)
    lateReanchored = true
  }

  const from = { endDate: subEnd ? subEnd.toISOString() : null, status: sub.status }
  const shouldExtend = subEnd ? periodEnd.getTime() > subEnd.getTime() : true
  const revivedStatuses = ["EXPIRED", "GRACE_PERIOD", "PAST_DUE", "PENDING_PAYMENT", "TRIAL"]
  const nextStatus = revivedStatuses.includes(sub.status) ? "ACTIVE" : sub.status
  const statusChange = nextStatus !== sub.status

  if (!shouldExtend && !statusChange) {
    // nothing to apply (already extended / already active) — idempotent no-op
    return { subscriptionId: sub.id, endDate: sub.endDate, status: sub.status, extended: false, activated: false }
  }

  const updated = await db.saasSubscription.update({
    where: { id: sub.id },
    data: {
      ...(shouldExtend ? { endDate: periodEnd } : {}),
      ...(statusChange ? { status: nextStatus } : {}),
      notes: opts.note || sub.notes,
    },
  })
  await db.saasSubscriptionEvent.create({
    data: {
      subscriptionId: sub.id, vendorId: invoice.vendorId,
      type: shouldExtend ? "EXTENDED" : "REACTIVATED",
      fromSnapshot: JSON.stringify(from),
      toSnapshot: JSON.stringify({ endDate: updated.endDate ? updated.endDate.toISOString() : null, status: updated.status }),
      note: opts.note || `Paid term applied from invoice ${invoice.number}` + (lateReanchored ? " (late payment — term re-anchored at payment date)" : ""),
      actorId: actor?.id || null, actorName: actor?.name || null,
    },
  })
  invalidateEntitlements(invoice.vendorId)
  await saasAudit(actor, shouldExtend ? "SUBSCRIPTION_EXTENDED" : "SUBSCRIPTION_REACTIVATED", "SaaSSubscription", sub.id,
    `Invoice ${invoice.number} paid — subscription ${shouldExtend ? `extended to ${updated.endDate ? updated.endDate.toISOString().slice(0, 10) : "(non-expiring)"}` : `status set to ${updated.status}`}`,
    { vendorId: invoice.vendorId, metadata: { from, to: updated.endDate ? updated.endDate.toISOString() : null, invoiceNumber: invoice.number, lateReanchored } })
  return { subscriptionId: sub.id, endDate: updated.endDate, status: updated.status, extended: shouldExtend, activated: statusChange }
}

/** Apply a PAID UPGRADE invoice (master prompt §11): switches the
 *  subscription to the invoice's target plan ONLY after verified payment,
 *  via the REAL owner changePlan handler (same events, price snapshot, cycle
 *  re-anchor, entitlement invalidation, saasAudit rows as the console).
 *  Idempotent: guarded by the caller's PENDING→PAID invoice flip, and a
 *  second call finds sub.planId already === target and no-ops. */
export async function applyUpgradePaid(
  invoice: { id: string; number: string; vendorId: string; upgradePlanId: string | null },
  actor: BillingActor,
  ctx?: { userId: string; userName: string },
): Promise<{ applied: boolean; planName: string | null }> {
  if (!invoice.upgradePlanId) {
    throw Object.assign(new Error("Upgrade invoice carries no target plan."), { code: 400 })
  }
  const sub = await db.saasSubscription.findUnique({ where: { vendorId: invoice.vendorId } })
  if (!sub) {
    throw Object.assign(new Error("This workspace has no subscription."), { code: 400 })
  }
  if (sub.planId === invoice.upgradePlanId) {
    return { applied: false, planName: sub.planName } // already applied — idempotent
  }
  const target = await db.saasPlan.findUnique({ where: { id: invoice.upgradePlanId } })
  if (!target) {
    throw Object.assign(new Error("The upgrade target plan no longer exists — contact the platform owner."), { code: 400 })
  }
  if (target.isCustom && target.customForVendorId && target.customForVendorId !== invoice.vendorId) {
    throw Object.assign(new Error("The upgrade target plan is not available for this workspace."), { code: 400 })
  }
  // route through the REAL owner handler so every event/audit row matches the
  // owner-console semantics exactly (documented composition pattern)
  const ownerCtx: OwnerCtx = ctx
    ? {
        ownerId: ctx.userId,
        name: `${ctx.userName} (tenant self-service upgrade)`,
        email: "",
        roleKey: "TENANT_SELF_SERVICE",
        permissions: new Set<string>(),
      }
    : {
        ownerId: actor?.id || "system",
        name: actor?.name || "Payment gateway",
        email: "",
        roleKey: "SYSTEM",
        permissions: new Set<string>(),
      }
  const out = await ownerRoutes["owner.subscriptions.changePlan"].handler(ownerCtx, {
    id: invoice.vendorId,
    planId: invoice.upgradePlanId,
    note: `Upgrade paid via invoice ${invoice.number}`,
  }) as { planName: string }
  return { applied: true, planName: out.planName }
}

// ---------------- immediate plan change (owner-console composition) ----------------

/** Run the REAL owner changePlan action for this tenant (immediate effect).
 *  The owner handler performs: plan snapshot update, price snapshot from the
 *  plan's current price, cycle re-anchor on cycle change, UPGRADED /
 *  DOWNGRADED / CYCLE_CHANGED event, entitlement invalidation and the
 *  PLAN_UPGRADED / PLAN_CHANGED saasAudit rows. */
export async function changePlanImmediate(
  vendorId: string,
  planId: string,
  ctx: Ctx,
  opts: { billingCycle?: string; note?: string } = {},
): Promise<{ planName: string; billingCycle: string; endDate: Date }> {
  // owner action handler signature: (OwnerCtx, { id: vendorId, planId, billingCycle?, note? })
  const ownerCtx = tenantSelfServiceActor(ctx)
  const out = await ownerRoutes["owner.subscriptions.changePlan"].handler(ownerCtx, {
    id: vendorId,
    planId,
    ...(opts.billingCycle ? { billingCycle: opts.billingCycle } : {}),
    note: opts.note || "Plan changed from the tenant Billing portal",
  }) as { planName: string; billingCycle: string; endDate: Date }
  return out
}

// ---------------- scheduled downgrades (frozen-schema workaround) ----------------

export type PendingPlanSchedule = {
  planId: string
  planName: string
  scheduledFor: string // ISO — the endDate captured at scheduling time
  requestedAt: string
  requestedBy: string | null
}

function pendingPlanKey(vendorId: string): string {
  return `pendingPlan:${vendorId}`
}

export async function getPendingDowngrade(vendorId: string): Promise<PendingPlanSchedule | null> {
  const row = await db.saasSetting.findUnique({ where: { group_key: { group: "billing", key: pendingPlanKey(vendorId) } } })
  if (!row) return null
  const parsed = j<PendingPlanSchedule | null>(row.value, null)
  return parsed && parsed.planId && parsed.scheduledFor ? parsed : null
}

export async function schedulePendingDowngrade(
  vendorId: string,
  planId: string,
  actor: BillingActor,
): Promise<PendingPlanSchedule> {
  const sub = await db.saasSubscription.findUnique({ where: { vendorId } })
  if (!sub) throw Object.assign(new Error("This workspace has no subscription."), { code: 400 })
  const plan = await db.saasPlan.findUnique({ where: { id: planId } })
  if (!plan) throw Object.assign(new Error("Plan not found."), { code: 404 })

  // replace any existing schedule atomically (one row per vendor)
  await cancelPendingDowngrade(vendorId, actor, "replaced by a new downgrade request")
  const schedule: PendingPlanSchedule = {
    planId: plan.id,
    planName: plan.name,
    scheduledFor: (sub.endDate ?? new Date()).toISOString(),
    requestedAt: new Date().toISOString(),
    requestedBy: actor?.name || null,
  }
  await db.saasSetting.upsert({
    where: { group_key: { group: "billing", key: pendingPlanKey(vendorId) } },
    create: { group: "billing", key: pendingPlanKey(vendorId), value: JSON.stringify(schedule) },
    update: { value: JSON.stringify(schedule) },
  })
  await db.saasSubscriptionEvent.create({
    data: {
      subscriptionId: sub.id, vendorId,
      type: "DOWNGRADE_SCHEDULED",
      fromSnapshot: JSON.stringify({ plan: sub.planName, cycle: sub.billingCycle, endDate: sub.endDate ? sub.endDate.toISOString() : null }),
      toSnapshot: JSON.stringify({ plan: plan.name, planId: plan.id, effectiveAt: schedule.scheduledFor }),
      note: `Downgrade to ${plan.name} scheduled for cycle end (${(sub.endDate ?? new Date()).toISOString().slice(0, 10)})`,
      actorId: actor?.id || null, actorName: actor?.name || null,
    },
  })
  await saasAudit(actor, "PLAN_DOWNGRADE_SCHEDULED", "SaaSSubscription", sub.id,
    `Downgrade to ${plan.name} scheduled for ${(sub.endDate ?? new Date()).toISOString().slice(0, 10)} (cycle end)`,
    { vendorId, metadata: { planId: plan.id, scheduledFor: schedule.scheduledFor } })
  return schedule
}

/** Remove a pending schedule (if any). No-op when nothing is scheduled. */
export async function cancelPendingDowngrade(vendorId: string, actor: BillingActor, note?: string): Promise<boolean> {
  const row = await db.saasSetting.findUnique({ where: { group_key: { group: "billing", key: pendingPlanKey(vendorId) } } })
  if (!row) return false
  await db.saasSetting.delete({ where: { group_key: { group: "billing", key: pendingPlanKey(vendorId) } } }).catch(() => {})
  const sub = await db.saasSubscription.findUnique({ where: { vendorId } })
  if (sub) {
    await db.saasSubscriptionEvent.create({
      data: {
        subscriptionId: sub.id, vendorId,
        type: "DOWNGRADE_CANCELLED",
        fromSnapshot: JSON.stringify({ pendingPlan: j<PendingPlanSchedule | null>(row.value, null) }),
        toSnapshot: JSON.stringify({ pendingPlan: null }),
        note: note || null,
        actorId: actor?.id || null, actorName: actor?.name || null,
      },
    })
  }
  return true
}

/** Apply the pending downgrade: switches plan fields + price snapshot to the
 *  target plan's CURRENT price (the same snapshot rule the owner changePlan
 *  action applies), writes the DOWNGRADED event, deletes the schedule row.
 *  `force` applies regardless of scheduledFor (renewal); otherwise the
 *  schedule fires only at/after the recorded cycle end. */
export async function applyPendingDowngrade(
  vendorId: string,
  actor: BillingActor,
  opts: { force?: boolean } = {},
): Promise<boolean> {
  const schedule = await getPendingDowngrade(vendorId)
  if (!schedule) return false
  if (!opts.force && Date.parse(schedule.scheduledFor) > Date.now()) return false

  const sub = await db.saasSubscription.findUnique({ where: { vendorId } })
  if (!sub) {
    await db.saasSetting.delete({ where: { group_key: { group: "billing", key: pendingPlanKey(vendorId) } } }).catch(() => {})
    return false
  }
  const plan = await db.saasPlan.findUnique({ where: { id: schedule.planId } })
  if (!plan) {
    // target plan deleted meanwhile — drop the schedule, keep the current plan
    await cancelPendingDowngrade(vendorId, actor, "target plan no longer exists")
    return false
  }

  const from = { plan: sub.planName, cycle: sub.billingCycle, status: sub.status, price: Number(sub.priceAtCreation), endDate: sub.endDate ? sub.endDate.toISOString() : null }
  const price = sub.billingCycle === "YEARLY" ? plan.yearlyPrice : plan.monthlyPrice
  const updated = await db.saasSubscription.update({
    where: { id: sub.id },
    data: {
      planId: plan.id,
      planName: plan.name,
      priceAtCreation: price,
      currencySnapshot: plan.currency,
    },
  })
  await db.saasSubscriptionEvent.create({
    data: {
      subscriptionId: sub.id, vendorId,
      type: "DOWNGRADED",
      fromSnapshot: JSON.stringify(from),
      toSnapshot: JSON.stringify({ plan: plan.name, cycle: updated.billingCycle, status: updated.status, price: Number(updated.priceAtCreation), endDate: updated.endDate ? updated.endDate.toISOString() : null }),
      note: `Scheduled downgrade applied (${schedule.scheduledFor.slice(0, 10)})`,
      actorId: actor?.id || null, actorName: actor?.name || null,
    },
  })
  await db.saasSetting.delete({ where: { group_key: { group: "billing", key: pendingPlanKey(vendorId) } } }).catch(() => {})
  invalidateEntitlements(vendorId)
  await saasAudit(actor, "PLAN_DOWNGRADED", "SaaSSubscription", sub.id,
    `Scheduled downgrade applied: ${sub.planName} → ${plan.name} (effective ${schedule.scheduledFor.slice(0, 10)})`,
    { vendorId, metadata: { from, to: { plan: plan.name, price: Number(price) } } })
  return true
}

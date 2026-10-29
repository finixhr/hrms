// ============ Wave 11 §4 — transactional outbox (durable side effects) =========
// The at-least-once relay for work that MUST survive a crash between "state
// committed" and "side effect delivered" (master prompt §4: "No lost critical
// work between database transactions and job enqueueing; use a transactional
// outbox or equivalent where needed").
//
// WHY THIS EXISTS — the settlement flow (settle.ts) used to:
//   1. claim payment PAID          ┐ two separate statements —
//   2. flip invoice PAID           ┘ a crash between them = half-settled
//   3. apply the paid term          (separate; crash window before extension)
//   4. receipt email + webhook      (fire-and-forget AFTER the commit — lost
//                                     if the process dies in between)
// Now: steps 1+2 AND the outbox rows for (4) are ONE $transaction, so the
// financial state and its notification obligations commit atomically. This
// relay delivers them with bounded exponential-backoff retries and a FAILED
// dead-letter state (never a silent loss, never a duplicate charge —
// handlers are idempotent and the money already moved inside the tx).
//
// DELIVERY MODEL
//   - at-least-once: a handler may run twice after a crash mid-delivery
//     (rare); every handler is written so a replay is a no-op or a harmless
//     duplicate journal entry (email sends are deduped by the notification
//     journal; webhookEmit writes per-delivery rows guarded by its own
//     pipeline). No handler can extend a subscription or move money — those
//     paths stay inside the original transaction (§4 "do not execute
//     subscription extensions twice because a worker retries a job").
//   - claim: UPDATE … WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED) — the
//     canonical Postgres queue claim. N app instances behind a load balancer
//     relay concurrently without double-claiming and without lock contention.
//   - crash recovery: recoverStaleOutbox() resets PROCESSING rows older than
//     10 minutes back to PENDING (mirrors recoverStaleBgJobs), bounded by
//     nextAttemptAt so a poison event cannot hot-loop.
//   - dead-letter: attempts >= maxAttempts → status FAILED with lastError —
//     surfaced through /api/metrics (hrm_outbox_failed) for ops follow-up.
import { db } from "@/lib/db"
import type { Prisma } from "@prisma/client"

// ---------------------------------------------------------------------------
// enqueue — call INSIDE the same $transaction as the state change.
// ---------------------------------------------------------------------------

export type OutboxEventType = "invoice.paid.receipt" | "invoice.paid.webhook"

export async function enqueueOutbox(
  tx: Prisma.TransactionClient,
  events: Array<{ type: OutboxEventType; vendorId: string | null; payload: Record<string, unknown> }>,
): Promise<void> {
  for (const ev of events) {
    await tx.outboxEvent.create({
      data: {
        type: ev.type,
        vendorId: ev.vendorId,
        payloadJson: JSON.stringify(ev.payload ?? {}),
      },
    })
  }
}

// ---------------------------------------------------------------------------
// handlers — idempotent side-effect runners. NEVER touch money/subscription
// state here; this relay is notifications + integrations only.
// ---------------------------------------------------------------------------

type OutboxHandlerResult = { ok: boolean; skipped?: boolean; error?: string }
type OutboxHandler = (payload: Record<string, unknown>, vendorId: string | null) => Promise<OutboxHandlerResult>

const HANDLERS: Record<string, OutboxHandler> = {
  /** Branded receipt / thank-you email (owner-configurable flags respected —
   * notifyInvoicePaid short-circuits when both are disabled). */
  "invoice.paid.receipt": async (payload) => {
    const invoice = await db.saasInvoice.findUnique({ where: { id: String(payload.invoiceId) } })
    if (!invoice) return { ok: true, skipped: true, error: "invoice row vanished" }
    if (invoice.status !== "PAID") return { ok: true, skipped: true } // defensive: only PAID invoices get receipts
    const [admin, sub] = await Promise.all([
      db.user.findFirst({
        where: { vendorId: invoice.vendorId, role: "VENDOR_OWNER", status: "ACTIVE" },
        select: { email: true, name: true },
      }),
      db.saasSubscription.findUnique({ where: { vendorId: invoice.vendorId } }),
    ])
    // `extended` for the email copy is DERIVED from committed state (a replay
    // computes the same value): a TERM invoice whose paid period now covers
    // the subscription end means the term was applied.
    const extended =
      invoice.kind === "TERM" &&
      !!sub?.endDate &&
      sub.endDate.getTime() >= invoice.periodEnd.getTime()
    const { notifyInvoicePaid } = await import("./saas/notify")
    await notifyInvoicePaid({
      vendorId: invoice.vendorId,
      vendorName: null,
      adminEmail: admin?.email || null,
      adminName: admin?.name || null,
      invoiceNumber: invoice.number,
      amount: Number(invoice.amount),
      currency: invoice.currency,
      planName: sub?.planName || null,
      periodStart: invoice.periodStart,
      periodEnd: invoice.periodEnd,
      method: String(payload.method || invoice.paymentMethod || "CARD"),
      provider: String(payload.provider || "gateway"),
      providerTxnId: payload.providerTxnId ? String(payload.providerTxnId) : invoice.transactionId,
      paidAt: invoice.paidAt || new Date(),
      extended,
    })
    return { ok: true }
  },

  /** Tenant-plane webhook (invoice.paid) — webhookEmit journals each delivery
   * with its own retry pipeline (flushWebhookDeliveries), so this handler only
   * needs to ENQUEUE that delivery durably (the old call was fire-and-forget
   * and vanished on a crash). */
  "invoice.paid.webhook": async (payload, vendorId) => {
    if (!vendorId) return { ok: true, skipped: true, error: "webhook events require a vendorId" }
    const { webhookEmit } = await import("./webhooks")
    await webhookEmit(vendorId, "invoice.paid", {
      invoiceId: payload.invoiceId,
      invoiceNumber: payload.invoiceNumber,
      amount: payload.amount,
      currency: payload.currency,
      method: payload.method,
      provider: payload.provider,
      providerTxnId: payload.providerTxnId ?? null,
      paidAt: payload.paidAt,
    })
    return { ok: true }
  },
}

// ---------------------------------------------------------------------------
// retry policy
// ---------------------------------------------------------------------------

const OUTBOX_BASE_BACKOFF_MS = 30_000
const OUTBOX_MAX_BACKOFF_MS = 15 * 60_000

/** Exponential backoff with jitter (exported for unit tests): 30s · 1m · 2m ·
 * 4m · 8m, capped at 15m, ±25% jitter so a burst of failures from one SMTP
 * outage does not retry in perfect lockstep across events. */
export function outboxBackoffMs(attempts: number): number {
  const exp = Math.min(OUTBOX_BASE_BACKOFF_MS * 2 ** Math.max(0, attempts - 1), OUTBOX_MAX_BACKOFF_MS)
  const jitter = exp * (0.75 + Math.random() * 0.5)
  return Math.round(jitter)
}

// ---------------------------------------------------------------------------
// relay
// ---------------------------------------------------------------------------

type ClaimedEvent = {
  id: string
  type: string
  vendorId: string | null
  payloadJson: string
  attempts: number
  maxAttempts: number
}

/** Claim a bounded batch of due events atomically (SKIP LOCKED — safe for any
 * number of relays/instances) and return them. The claim ALSO slides
 * nextAttemptAt to now+10min: for PROCESSING rows that value is the recovery
 * deadline (recoverStaleOutbox resets rows past it), and it is overwritten
 * with the real retry backoff if the handler fails. Exported for tests. */
export async function claimOutboxBatch(limit: number): Promise<ClaimedEvent[]> {
  const rows = await db.$queryRaw<ClaimedEvent[]>`
    UPDATE "OutboxEvent" SET "status" = 'PROCESSING', "nextAttemptAt" = now() + interval '10 minutes'
    WHERE "id" IN (
      SELECT "id" FROM "OutboxEvent"
      WHERE "status" = 'PENDING' AND "nextAttemptAt" <= now()
      ORDER BY "createdAt" ASC
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING "id", "type", "vendorId", "payloadJson", "attempts", "maxAttempts"`
  return rows
}

/** Process one claimed event → DONE, or back to PENDING with backoff, or FAILED
 * (dead-letter) when attempts are exhausted. Exported for unit tests. */
export async function settleClaimedEvent(ev: ClaimedEvent): Promise<"DONE" | "RETRY" | "FAILED"> {
  const handler = HANDLERS[ev.type]
  let result: OutboxHandlerResult
  if (!handler) {
    result = { ok: false, error: `no handler registered for outbox type "${ev.type}" (poison event)` }
  } else {
    try {
      let payload: Record<string, unknown> = {}
      try { payload = JSON.parse(ev.payloadJson || "{}") } catch { payload = {} }
      result = await handler(payload, ev.vendorId)
    } catch (e) {
      result = { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  }
  if (result.ok) {
    await db.outboxEvent.update({
      where: { id: ev.id },
      data: { status: "DONE", processedAt: new Date(), attempts: ev.attempts + 1, lastError: null },
    })
    return "DONE"
  }
  const attempts = ev.attempts + 1
  const err = (result.error || "handler failed").slice(0, 500)
  if (attempts >= ev.maxAttempts) {
    await db.outboxEvent.update({
      where: { id: ev.id },
      data: { status: "FAILED", attempts, lastError: err, processedAt: new Date() },
    })
    console.error(`[outbox] event ${ev.id} (${ev.type}) DEAD-LETTERED after ${attempts} attempts: ${err}`)
    return "FAILED"
  }
  await db.outboxEvent.update({
    where: { id: ev.id },
    data: { status: "PENDING", attempts, lastError: err, nextAttemptAt: new Date(Date.now() + outboxBackoffMs(attempts)) },
  })
  return "RETRY"
}

/** Relay one batch. Called (a) opportunistically right after a settlement
 * commits (fast path — the tenant gets the receipt in seconds, the IPN
 * response is not delayed) and (b) from every scheduler tick as the backstop.
 * Bounded work per call; failures only reschedule, never throw to the caller. */
export async function flushOutbox(opts: { limit?: number } = {}): Promise<{ done: number; retried: number; failed: number }> {
  const limit = Math.min(200, Math.max(1, opts.limit ?? 50))
  const out = { done: 0, retried: 0, failed: 0 }
  try {
    const batch = await claimOutboxBatch(limit)
    for (const ev of batch) {
      const r = await settleClaimedEvent(ev).catch(() => "RETRY" as const)
      if (r === "DONE") out.done++
      else if (r === "FAILED") out.failed++
      else out.retried++
    }
  } catch (e) {
    // claim failure (DB unavailable) — the tick retries; never propagate.
    console.error("[outbox] flush failed:", e instanceof Error ? e.message : e)
  }
  return out
}

/** Crash recovery: reset PROCESSING rows whose claim deadline (claim time +
 * 10 min — see claimOutboxBatch) has passed (the relay died mid-handler).
 * Mirrors recoverStaleBgJobs; the retry ladder still gates re-processing. */
export async function recoverStaleOutbox(): Promise<number> {
  try {
    const res = await db.outboxEvent.updateMany({
      where: { status: "PROCESSING", nextAttemptAt: { lt: new Date() } },
      data: { status: "PENDING", nextAttemptAt: new Date() },
    })
    if (res.count > 0) console.log(`[outbox] recovered ${res.count} stale PROCESSING event(s)`)
    return res.count
  } catch {
    return 0
  }
}

// ---------------------------------------------------------------------------
// settlement reconciliation — the term-application crash backstop (§4)
// ---------------------------------------------------------------------------
// Steps 1+2 of settlement (payment claim + invoice flip) and the outbox rows
// are one transaction; applyPaidTerm / applyUpgradePaid run AFTER it (they
// compose the real owner handlers with their own audit/event semantics) and
// are idempotent by construction (2026-10-25 design: a re-run anchors on the
// invoice's OWN period and can never double-extend). If the process dies
// between the transaction and the term application, THIS sweep — running on
// the scheduler tick — finds PAID invoices whose effect never landed and
// re-applies it. Predicate = "the subscription event row for this invoice
// does not exist / the target plan was never applied", so normal operation
// costs one bounded scan of RECENT payments and no-ops.

export async function reconcileSettlements(): Promise<{ terms: number; upgrades: number }> {
  const out = { terms: 0, upgrades: 0 }
  try {
    const since = new Date(Date.now() - 7 * 86400000)
    const { applyPaidTerm, applyUpgradePaid, systemActor } = await import("./saas/payments/billing-ops")
    const actor = systemActor("Settlement reconciliation sweep")

    // ---- TERM invoices: PAID, term-linked, recent, and the subscription
    // event row for this invoice number is missing ⇒ the term never applied.
    const termInvoices = await db.saasInvoice.findMany({
      where: {
        status: "PAID",
        kind: "TERM",
        subscriptionId: { not: null },
        paidAt: { gte: since },
      },
      select: {
        id: true, number: true, vendorId: true, subscriptionId: true,
        periodStart: true, periodEnd: true, amount: true,
      },
      orderBy: { paidAt: "asc" },
      take: 50,
    })
    for (const inv of termInvoices) {
      const applied = await db.saasSubscriptionEvent.findFirst({
        where: { vendorId: inv.vendorId, note: { equals: inv.number } }, // R6-004: exact match — prevents INV-1 matching INV-10, INV-12, etc.
        select: { id: true },
      })
      if (applied) continue // term already landed (EXTENDED/REACTIVATED row cites the invoice)
      try {
        await applyPaidTerm(inv, actor, {
          note: `Reconciled by settlement sweep (invoice ${inv.number} — term application lost to a crash)`,
        })
        out.terms++
        console.warn(`[outbox] reconciliation re-applied term for invoice ${inv.number} (vendor ${inv.vendorId})`)
      } catch (e) {
        console.error(`[outbox] term reconciliation failed for invoice ${inv.number}:`, e instanceof Error ? e.message : e)
      }
    }

    // ---- UPGRADE invoices: PAID and the subscription never switched to the
    // target plan ⇒ applyUpgradePaid (internally idempotent: sub.planId ===
    // target → no-op) never ran.
    const upgradeInvoices = await db.saasInvoice.findMany({
      where: {
        status: "PAID",
        kind: "UPGRADE",
        upgradePlanId: { not: null },
        paidAt: { gte: since },
      },
      select: { id: true, number: true, vendorId: true, upgradePlanId: true },
      orderBy: { paidAt: "asc" },
      take: 50,
    })
    for (const inv of upgradeInvoices) {
      const sub = await db.saasSubscription.findUnique({ where: { vendorId: inv.vendorId }, select: { planId: true } })
      if (sub?.planId === inv.upgradePlanId) continue
      try {
        await applyUpgradePaid(inv, actor)
        out.upgrades++
        console.warn(`[outbox] reconciliation re-applied upgrade for invoice ${inv.number} (vendor ${inv.vendorId})`)
      } catch (e) {
        console.error(`[outbox] upgrade reconciliation failed for invoice ${inv.number}:`, e instanceof Error ? e.message : e)
      }
    }
  } catch (e) {
    console.error("[outbox] settlement reconciliation failed:", e instanceof Error ? e.message : e)
  }
  return out
}

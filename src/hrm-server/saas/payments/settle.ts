// ============ WP-I — gateway payment settlement (the completion engine) ============
// Shared by the PUBLIC completion routes (/api/payments/return and
// /api/payments/ipn). Runs ONLY after a server-side provider verification
// (verifyCallback / handleIpn) — redirect params never reach this layer.
//
// IDEMPOTENCY (the replay design):
//   1. A payment row is only ever flipped to PAID from PENDING/FAILED via a
//      conditional update (status re-checked at write time) — concurrent
//      return + IPN arrivals can never double-settle.
//   2. The @@unique([provider, providerTxnId]) index on SaasPayment is the
//      cross-row replay guard: if the provider txn id already exists on a
//      DIFFERENT row, this completion is a replay and settles nothing.
//   3. An invoice already PAID never triggers a second term extension, and a
//      payment already PAID short-circuits to ALREADY_PAID.
//
// SIDE EFFECTS on first settle (Wave 11 §4, 2026-10-26): steps 1+2 (payment
// PAID + invoice PAID) and the DURABLE notification obligations (receipt
// email, tenant webhook) commit in ONE $transaction — a crash can no longer
// half-settle or silently swallow a receipt. The outbox relay (scheduler tick
// + opportunistic post-commit flush) delivers them with bounded retries.
//   → subscription term applied AFTER the commit by applyPaidTerm /
//     applyUpgradePaid — idempotent by construction; the tick's
//     reconcileSettlements() sweep is the crash backstop that re-applies a
//     lost term (it anchors on the invoice's OWN period — never doubles).
//   → audits on BOTH planes (SaasAuditLog PAYMENT_RECORDED + tenant AuditLog)
//     stay direct post-commit writes (no enqueue boundary, tiny window,
//     payment/invoice rows are the authoritative financial record).
import { db } from "@/lib/db"
import { audit } from "../../audit"
import { saasAudit } from "../audit"
import { applyPaidTerm, applyUpgradePaid, systemActor } from "./billing-ops"
import { enqueueOutbox, flushOutbox } from "../../outbox"
import type { ProviderVerifyResult } from "./types"

export type SettleOutcome = {
  outcome: "PAID" | "ALREADY_PAID" | "REPLAY" | "AMOUNT_MISMATCH" | "AMOUNT_UNVERIFIED" | "MISMATCH" | "NOT_FOUND" | "SKIPPED" | "REFUNDED"
  invoiceId?: string
  invoiceNumber?: string
  reason?: string
}

/** Method bucket recorded on the invoice/payment rows per gateway
 *  (SaasPayment.method vocabulary: BANK | CASH | MFS | CARD). */
const METHOD_BY_PROVIDER: Record<string, string> = {
  sslcommerz: "CARD", // cards + net-banking/NPSB aggregate checkout
  bkash: "MFS",
  nagad: "MFS",
  paystation: "CARD", // cards + EMI + wallets + bank channels aggregate checkout
  eps: "CARD", // EPS portal aggregate (cards + wallets + banks)
}

/** Settle one verified gateway completion. Safe to call repeatedly. */
export async function settleGatewayPayment(input: {
  provider: string
  paymentId: string
  verified: ProviderVerifyResult
}): Promise<SettleOutcome> {
  const { provider, paymentId, verified } = input
  const payment = await db.saasPayment.findUnique({
    where: { id: paymentId },
    include: { invoice: true },
  })
  if (!payment || payment.provider !== provider) {
    return { outcome: "MISMATCH", reason: "payment row not found for this provider" }
  }
  const invoice = payment.invoice
  if (!invoice) {
    return { outcome: "NOT_FOUND", reason: "the payment's invoice no longer exists" }
  }

  // The provider's echo of OUR reference must match this row — a session
  // created for payment A can never settle payment B. SSLCommerz echoes our
  // payment id (tran_id), Nagad our order id, bKash the merchant invoice
  // number — so the check accepts the payment row id OR the invoice number
  // (both are references WE originated; the session check below adds the
  // row-level binding for providers like bKash).
  // AUDIT M-2 (2026-11-07) — a mismatched pairing is RECORDED, never
  // persisted as FAILED: the old markGatewayPaymentFailure let a forged
  // notification pair a VERIFIED result for transaction B with OUR ref for
  // payment A (?ref=A + B's real reference) and knock A out of the
  // reconciliation sweep. The row stays PENDING — the sweep re-queries it
  // through the provider's own status API and settles the truth.
  if (verified.merchantTxnId && verified.merchantTxnId !== paymentId && verified.merchantTxnId !== invoice.number) {
    await recordPaymentAnomaly(paymentId, `merchant reference mismatch (${verified.merchantTxnId})`, verified)
    return { outcome: "MISMATCH", reason: "provider merchant reference does not match this payment", invoiceId: invoice.id, invoiceNumber: invoice.number }
  }
  // Session binding: when the provider echoes its session/payment reference
  // (bKash paymentID) it must equal the session stored on THIS row.
  // AUDIT M-2 — same record-only treatment as the merchant-reference check.
  if (verified.sessionId && payment.sessionId && verified.sessionId !== payment.sessionId) {
    await recordPaymentAnomaly(paymentId, `session mismatch (${verified.sessionId} vs ${payment.sessionId})`, verified)
    return { outcome: "MISMATCH", reason: "provider session does not match this payment", invoiceId: invoice.id, invoiceNumber: invoice.number }
  }

  // Cross-row replay: the provider txn id must not already exist elsewhere.
  if (verified.providerTxnId) {
    const dupe = await db.saasPayment.findUnique({
      where: { provider_providerTxnId: { provider, providerTxnId: verified.providerTxnId } },
    })
    if (dupe && dupe.id !== paymentId) {
      // The SAME provider transaction already settled a (different) payment
      // row — this is a replay. Record it for forensics, settle nothing.
      // AUDIT M-2 — recorded, never persisted as FAILED (see above).
      await recordPaymentAnomaly(paymentId, `duplicate provider txn ${verified.providerTxnId} (already settled on payment ${dupe.id})`, verified)
      return { outcome: "REPLAY", reason: "provider transaction already settled", invoiceId: invoice.id, invoiceNumber: invoice.number }
    }
  }

  // ---- BUG-6 (P2 wave, 2026-11-09) — REFUNDED verification ----
  // The gateway reports the transaction refunded/reversed. Attribution has
  // already been established above (merchant/session/replay checks), so this
  // is a genuine refund of THIS payment: mark the payment row REFUNDED,
  // stamp refundedAt, and RE-OPEN the invoice for re-billing (PAID → PENDING
  // conditional claim — only this call flips it). Previously a refunded bKash
  // txn mapped to PENDING (re-queried by the sweep forever) and a refunded
  // PayStation txn mapped to FAILED — the enum's REFUNDED value was never
  // set anywhere and no path re-opened the invoice.
  if (verified.status === "REFUNDED") {
    return applyGatewayRefund(paymentId, {
      provider,
      detail: verified.detail || "gateway reported the transaction as refunded",
      raw: verified.raw,
    })
  }

  // ---- AUDIT M-1 (2026-11-07) — a PAID verification MUST carry a verified
  // amount. The old check ran only `if (verified.amount != null …)`, so a
  // provider response without an amount (parseAmount returns null when the
  // field is missing/unparseable) settled the invoice IN FULL and extended
  // or upgraded the subscription — an underpayment (or a tampered response
  // routed through a misbehaving provider) was indistinguishable from a
  // correct one. Fail CLOSED: no amount ⇒ AMOUNT_UNVERIFIED, the payment
  // stays PENDING and the reconciliation sweep re-queries the gateway (its
  // status API carries the amount) or an operator reviews the audit row.
  if (verified.amount == null || !Number.isFinite(verified.amount)) {
    await db.saasPayment.update({
      where: { id: paymentId },
      data: {
        failureReason: `amount unverified: provider PAID response carried no usable amount`,
        metaJson: JSON.stringify({ lastVerify: maskRaw(verified) }),
      },
    }).catch(() => {})
    await saasAudit(
      systemActor(`Payment gateway (${provider})`),
      "PAYMENT_AMOUNT_UNVERIFIED",
      "SaaSInvoice",
      invoice.id,
      `Gateway reported PAID for ${invoice.number} but no amount — settlement held for manual review / re-query (invoice ৳${Number(invoice.amount)})`,
      { vendorId: invoice.vendorId, metadata: { provider, paymentId, invoiceAmount: Number(invoice.amount) } },
    ).catch(() => {})
    return { outcome: "AMOUNT_UNVERIFIED", reason: "provider PAID response did not carry a verifiable amount", invoiceId: invoice.id, invoiceNumber: invoice.number }
  }

  // Amount: the provider-verified amount must cover the invoice.
  if (verified.amount + 0.001 < Number(invoice.amount)) {
    await db.saasPayment.update({
      where: { id: paymentId },
      data: {
        failureReason: `underpaid: verified ${verified.amount} < invoice ${Number(invoice.amount)}`,
        metaJson: JSON.stringify({ lastVerify: maskRaw(verified) }),
      },
    })
    await saasAudit(
      systemActor(`Payment gateway (${provider})`),
      "PAYMENT_AMOUNT_MISMATCH",
      "SaaSInvoice",
      invoice.id,
      `Gateway payment for ${invoice.number} underpaid (verified ৳${verified.amount} vs invoice ৳${Number(invoice.amount)})`,
      { vendorId: invoice.vendorId, metadata: { provider, paymentId, verifiedAmount: verified.amount, invoiceAmount: Number(invoice.amount) } },
    )
    return { outcome: "AMOUNT_MISMATCH", reason: "verified amount is below the invoice amount", invoiceId: invoice.id, invoiceNumber: invoice.number }
  }

  // Currency: gateway verified currency must match invoice currency
  if (verified.raw?.currency && String(verified.raw.currency).toUpperCase() !== invoice.currency) {
    await markGatewayPaymentFailed(paymentId, provider, `currency mismatch (gateway reported ${verified.raw.currency} vs invoice ${invoice.currency})`, verified)
    return { outcome: "MISMATCH", reason: "currency mismatch between gateway and invoice", invoiceId: invoice.id, invoiceNumber: invoice.number }
  }

  if (payment.status === "PAID") {
    return { outcome: "ALREADY_PAID", invoiceId: invoice.id, invoiceNumber: invoice.number }
  }

  const method = METHOD_BY_PROVIDER[provider] || "CARD"
  const actor = systemActor(`Payment gateway (${provider})`)

  // 1+2. payment claim + invoice flip + durable side effects — ONE
  //     transaction (Wave 11 §4, 2026-10-26). The money state and its
  //     notification obligations commit atomically; a crash between them can
  //     no longer half-settle the payment or silently swallow the tenant's
  //     receipt (the outbox rows ride the commit; the relay delivers later).
  const invoiceWasPending = invoice.status === "PENDING"
  const claimOutcome = await db.$transaction(async (tx) => {
    // payment → PAID (conditional: only from PENDING/FAILED — race-safe)
    const claimed = await tx.saasPayment.updateMany({
      where: { id: paymentId, status: { in: ["PENDING", "FAILED"] } },
      data: {
        status: "PAID",
        paidAt: new Date(),
        provider,
        providerTxnId: verified.providerTxnId || null,
        method,
        transactionId: verified.providerTxnId || null,
        failureReason: null,
        recordedById: null,
        recordedByName: actor?.name || undefined,
        metaJson: JSON.stringify({ lastVerify: maskRaw(verified), settledAt: new Date().toISOString() }),
      },
    })
    if (claimed.count === 0) {
      // a concurrent completion won the race — treat as replay
      return "ALREADY_PAID" as const
    }
    // invoice → PAID (once)
    if (invoice.status === "PENDING") {
      await tx.saasInvoice.update({
        where: { id: invoice.id },
        data: {
          status: "PAID",
          paidAt: new Date(),
          paymentMethod: method,
          transactionId: verified.providerTxnId || null,
        },
      })
      // Wave 4 WP-C — outbound webhook to the TENANT's subscribed endpoints.
      // Emitted only on the PENDING→PAID flip so replays never double-fire;
      // NOW ENQUEUED IN THE SAME TRANSACTION (the old fire-and-forget call
      // vanished on a crash between commit and delivery). The outbox handler
      // hands off to webhookEmit, whose journal + flush pipeline is the
      // per-delivery retry record as before.
      await enqueueOutbox(tx, [
        {
          type: "invoice.paid.webhook",
          vendorId: invoice.vendorId,
          payload: {
            invoiceId: invoice.id,
            invoiceNumber: invoice.number,
            amount: Number(invoice.amount),
            currency: invoice.currency,
            method,
            provider,
            providerTxnId: verified.providerTxnId || null,
            paidAt: new Date().toISOString(),
          },
        },
      ])
    }
    // Branded receipt / thank-you email — one outbox row per settlement,
    // written in the SAME transaction as the payment claim so it can never
    // be lost to a crash (idempotent handler; the owner's
    // receipt/thank-you email flags are respected inside notifyInvoicePaid).
    await enqueueOutbox(tx, [
      {
        type: "invoice.paid.receipt",
        vendorId: invoice.vendorId,
        payload: { invoiceId: invoice.id, provider, method, providerTxnId: verified.providerTxnId || null },
      },
    ])
    return "PAID" as const
  })
  if (claimOutcome === "ALREADY_PAID") {
    return { outcome: "ALREADY_PAID", invoiceId: invoice.id, invoiceNumber: invoice.number }
  }

  // 3. subscription term application — ONLY when this completion flipped the
  //    invoice to PAID and the invoice is term-linked to a subscription.
  //    (Paying an already-PAID invoice again never re-extends; a replayed
  //    completion never reaches here — see the guards above.)
  //    2026-10-25 security fix: applyPaidTerm anchors on the invoice's OWN
  //    period — idempotent by construction (a re-paid/duplicate invoice can
  //    never push endDate past the invoice's period end, so the historic
  //    renew-click-then-pay DOUBLE extension is structurally impossible).
  //    UPGRADE invoices instead apply the plan change (master prompt §11 —
  //    higher-tier entitlements ONLY after verified payment).
  //    Wave 11 §4: this runs AFTER the settlement transaction; a crash in
  //    between is healed by reconcileSettlements() on the next scheduler
  //    tick (same idempotent functions — never a double extension).
  let extended = false
  let activated = false
  let upgradedTo: string | null = null
  if (invoiceWasPending && invoice.subscriptionId) {
    if (invoice.kind === "UPGRADE") {
      const upgraded = await applyUpgradePaid(invoice, actor)
      upgradedTo = upgraded.applied ? upgraded.planName : null
    } else {
      const applied = await applyPaidTerm(invoice, actor, {
        note: `Payment via ${provider} ${verified.providerTxnId || paymentId} (invoice ${invoice.number})`,
      })
      extended = applied.extended
      activated = applied.activated
    }
  }

  // 4. receipt email + tenant webhook — delivered by the transactional outbox
  //    (rows written in the SAME transaction as the claim above). This
  //    opportunistic flush is the FAST PATH (tenants usually get the receipt
  //    within seconds); the scheduler tick is the retry backstop. Intention-
  //    ally not awaited to failure — the relay must never slow the IPN
  //    response, and delivery retries are the relay's job, not this route's.
  void flushOutbox({ limit: 10 }).catch(() => {})

  // 5. dual audit (platform + tenant planes)
  await saasAudit(
    actor,
    "PAYMENT_RECORDED",
    "SaaSInvoice",
    invoice.id,
    `Invoice ${invoice.number} paid via ${provider}${verified.providerTxnId ? ` (txn ${verified.providerTxnId})` : ""}${extended ? " — subscription extended to the invoice term" : ""}${activated ? " — subscription activated" : ""}${upgradedTo ? ` — plan upgraded to ${upgradedTo}` : ""}`,
    { vendorId: invoice.vendorId, metadata: { provider, paymentId, providerTxnId: verified.providerTxnId, amount: Number(invoice.amount), method, extended, activated } },
  )
  await audit(
    { vendorId: invoice.vendorId, userId: null, userName: actor?.name || "Payment gateway" },
    "billing.payment.settled",
    "SaaSInvoice",
    invoice.id,
    `Invoice ${invoice.number} (৳${Number(invoice.amount)}) paid via ${provider}${verified.providerTxnId ? ` — txn ${verified.providerTxnId}` : ""}`,
    { newValue: { provider, amount: Number(invoice.amount), method, extended } },
  ).catch(() => {})

  return { outcome: "PAID", invoiceId: invoice.id, invoiceNumber: invoice.number }
}

/** BUG-6 (P2 wave, 2026-11-09) — apply a refund to a gateway payment row.
 *  Used by BOTH refund entry points:
 *    · settleGatewayPayment, when a callback/IPN/sweep verification reports
 *      the gateway already refunded the transaction, and
 *    · owner.invoices.refund, after the owner-initiated gateway refund call
 *      (or as the recorded manual refund when the adapter has no refund API).
 *  Effects (one transaction): payment → REFUNDED + refundedAt; the invoice is
 *  RE-OPENED for re-billing when it was PAID (conditional PAID→PENDING claim,
 *  paidAt cleared); dual-platform audit rows. Idempotent: a payment already
 *  REFUNDED is a no-op that still reports REFUNDED. */
export async function applyGatewayRefund(
  paymentId: string,
  info: {
    provider: string
    detail: string
    raw?: Record<string, unknown>
    actorName?: string
    refundTxnId?: string | null
    manual?: boolean
  },
): Promise<SettleOutcome> {
  const payment = await db.saasPayment.findUnique({ where: { id: paymentId }, include: { invoice: true } })
  if (!payment || !payment.invoice) {
    return { outcome: "NOT_FOUND", reason: "payment row (or its invoice) no longer exists" }
  }
  const invoice = payment.invoice
  const actor = systemActor(`Payment gateway (${info.provider})`)

  if (payment.status === "REFUNDED") {
    return { outcome: "REFUNDED", invoiceId: invoice.id, invoiceNumber: invoice.number, reason: "payment already refunded" }
  }

  await db.$transaction(async (tx) => {
    // payment → REFUNDED (from any live state; race-safe conditional)
    await tx.saasPayment.updateMany({
      where: { id: paymentId, status: { in: ["PENDING", "PAID", "FAILED"] } },
      data: {
        status: "REFUNDED",
        refundedAt: new Date(),
        failureReason: null,
        metaJson: JSON.stringify({
          refund: {
            detail: info.detail.slice(0, 300),
            manual: !!info.manual,
            refundTxnId: info.refundTxnId ?? null,
            at: new Date().toISOString(),
          },
          lastVerify: info.raw ? maskRaw({ status: "REFUNDED", ...info.raw } as any) : undefined,
        }),
      },
    })
    // invoice RE-OPEN for re-billing — only when it was PAID (a PENDING
    // invoice is already open; a FAILED/CANCELLED one stays as it is)
    await tx.saasInvoice.updateMany({
      where: { id: invoice.id, status: "PAID" },
      data: { status: "PENDING", paidAt: null },
    })
  })

  // dual audit (platform + tenant planes) — the refund is a money event the
  // operator must see in both consoles
  await saasAudit(
    info.manual ? systemActor(`Owner console (manual refund)`) : actor,
    "PAYMENT_REFUNDED",
    "SaaSInvoice",
    invoice.id,
    `Invoice ${invoice.number} payment refunded via ${info.provider}${info.refundTxnId ? ` (refund txn ${info.refundTxnId})` : ""} — invoice re-opened for re-billing. ${info.detail}`.slice(0, 400),
    { vendorId: invoice.vendorId, metadata: { provider: info.provider, paymentId, amount: Number(payment.amount), manual: !!info.manual } },
  ).catch(() => {})
  await audit(
    { vendorId: invoice.vendorId, userId: null, userName: info.actorName || actor?.name || "Payment gateway" },
    "billing.payment.refunded",
    "SaaSInvoice",
    invoice.id,
    `Invoice ${invoice.number} (৳${Number(payment.amount)}) refunded via ${info.provider} — re-opened for re-billing`,
    { newValue: { provider: info.provider, amount: Number(payment.amount), manual: !!info.manual } },
  ).catch(() => {})

  return { outcome: "REFUNDED", invoiceId: invoice.id, invoiceNumber: invoice.number }
}

/** Record a verification attempt on a pending payment without marking it FAILED. */
export async function recordGatewayPaymentPending(
  paymentId: string,
  _provider: string,
  verified?: ProviderVerifyResult,
): Promise<void> {
  await db.saasPayment.updateMany({
    where: { id: paymentId, status: "PENDING" },
    data: {
      providerTxnId: verified?.providerTxnId || undefined,
      metaJson: JSON.stringify({ lastVerify: verified ? maskRaw(verified) : null, verifiedAt: new Date().toISOString() }),
    },
  })
}

/** Record a failed/cancelled completion on the payment row (invoice stays
 *  PENDING — retry is allowed and creates a fresh payment row). */
export async function markGatewayPaymentFailed(
  paymentId: string,
  _provider: string, // provenance is already carried by the payment row's provider column
  reason: string,
  verified?: ProviderVerifyResult,
): Promise<void> {
  await db.saasPayment.updateMany({
    where: { id: paymentId, status: { in: ["PENDING", "FAILED"] } },
    data: {
      status: "FAILED",
      failureReason: reason.slice(0, 500),
      metaJson: JSON.stringify({ lastVerify: verified ? maskRaw(verified) : null, failedAt: new Date().toISOString() }),
    },
  })
}

/** AUDIT M-2 (2026-11-07) — record a verification ANOMALY without flipping
 *  the payment status: the row stays PENDING so the reconciliation sweep
 *  keeps re-checking it through the provider's own status API. Used for
 *  mismatched pairings and replays, where the verified result belongs to a
 *  DIFFERENT transaction than the row named by the caller. */
async function recordPaymentAnomaly(
  paymentId: string,
  reason: string,
  verified?: ProviderVerifyResult,
): Promise<void> {
  await db.saasPayment.updateMany({
    where: { id: paymentId, status: { in: ["PENDING", "FAILED"] } },
    data: {
      failureReason: `anomaly (status unchanged): ${reason}`.slice(0, 500),
      metaJson: JSON.stringify({ lastVerify: verified ? maskRaw(verified) : null, anomalyAt: new Date().toISOString() }),
    },
  }).catch(() => {})
}

/** AUDIT M-2 (2026-11-07) — the ONLY sanctioned way for the public
 * completion routes to record a gateway-reported FAILED/CANCELLED outcome.
 * Guards (fail-closed, nothing is written when any fires):
 *   1. `verified.ignored` — the notification could not even be attributed to
 *      a transaction (no reference/signature): an ignored notification is
 *      not a failed payment. A forged `?ref=<paymentId>` with an empty body
 *      used to flip PENDING → FAILED here and drop the row from the
 *      reconciliation sweep (which only looked at PENDING).
 *   2. the provider's echo of OUR reference (merchantTxnId), when present,
 *      must match the payment row id or its invoice number — a VERIFIED
 *      result for transaction B must never mark payment A failed.
 *   3. the provider's session echo (sessionId), when both sides have one,
 *      must match the session stored on the row (bKash paymentID binding).
 * Returns true when the failure was recorded. */
export async function recordVerifiedFailure(
  paymentId: string,
  provider: string,
  reason: string,
  verified: ProviderVerifyResult,
): Promise<boolean> {
  if (verified.ignored) return false
  const row = await db.saasPayment.findUnique({
    where: { id: paymentId },
    select: { id: true, sessionId: true, invoice: { select: { number: true } } },
  }).catch(() => null)
  if (!row) return false // unknown payment — nothing to mark (also no oracle)
  if (
    verified.merchantTxnId &&
    verified.merchantTxnId !== paymentId &&
    verified.merchantTxnId !== row.invoice?.number
  ) {
    return false // verified result belongs to a different transaction
  }
  if (verified.sessionId && row.sessionId && verified.sessionId !== row.sessionId) {
    return false // session binding failed
  }
  await markGatewayPaymentFailed(paymentId, provider, reason, verified)
  return true
}

/** Sweep recent PENDING gateway checkouts and query the gateway status (reconciliation backstop).
 *  AUDIT M-2 (2026-11-07) — the sweep also re-checks recent FAILED rows: a
 *  payment wrongly flipped to FAILED (pre-fix forged IPN, or a transient
 *  gateway error) used to disappear from this sweep forever, leaving a paid
 *  tenant locked until someone intervened. The settle claim already accepts
 *  FAILED → PAID, so a re-verified payment heals itself here. */
export async function reconcilePendingPayments(): Promise<{ checked: number; settled: number }> {
  const since = new Date(Date.now() - 24 * 3600 * 1000)
  const pending = await db.saasPayment.findMany({
    where: {
      status: { in: ["PENDING", "FAILED"] },
      createdAt: { gte: since },
      provider: { not: "MANUAL" },
    },
    take: 20,
    orderBy: { createdAt: "desc" },
  })
  let settled = 0
  const { getPaymentProvider } = await import("./registry")
  for (const pm of pending) {
    try {
      const provider = getPaymentProvider(pm.provider)
      if (!provider?.queryPayment) continue
      const verified = await provider.queryPayment(pm.id)
      if (verified.ok && verified.status === "PAID") {
        const outcome = await settleGatewayPayment({ provider: pm.provider, paymentId: pm.id, verified })
        if (outcome.outcome === "PAID" || outcome.outcome === "ALREADY_PAID") settled++
      } else if ((verified.status === "FAILED" || verified.status === "CANCELLED") && !verified.ignored) {
        // only a VERIFIED failure may keep a row FAILED — an ignored/unverifiable
        // query leaves the row exactly as it is (never a new flip)
        await markGatewayPaymentFailed(pm.id, pm.provider, verified.detail || `gateway reported ${verified.status}`, verified)
      }
    } catch { /* ignore individual check failures */ }
  }
  return { checked: pending.length, settled }
}

/** Strip anything sensitive/large from a provider payload before it is
 *  persisted to metaJson (booleans, ids, amounts and short status strings
 *  only — never credentials, never raw bodies). */
function maskRaw(verified: ProviderVerifyResult): Record<string, unknown> {
  const out: Record<string, unknown> = { ok: verified.ok, status: verified.status }
  if (verified.providerTxnId) out.providerTxnId = verified.providerTxnId
  if (verified.merchantTxnId) out.merchantTxnId = verified.merchantTxnId
  if (verified.amount != null) out.amount = verified.amount
  if (verified.detail) out.detail = verified.detail.slice(0, 200)
  if (verified.raw && typeof verified.raw === "object") {
    for (const [k, v] of Object.entries(verified.raw)) {
      if (v == null || typeof v === "boolean" || typeof v === "number") out[k] = v
      else if (typeof v === "string" && v.length <= 80) out[k] = v
    }
  }
  return out
}

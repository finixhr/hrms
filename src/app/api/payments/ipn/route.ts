// ============ WP-I — public gateway IPN/webhook endpoint ============
// Providers post transaction notifications here (server-to-server). The body
// is signature-validated per the provider's documented scheme
// (handleIpn — SSLCommerz val_id verification, bKash/Nagad signature checks)
// and settlement is idempotent: the SaasPayment unique index on
// (provider, providerTxnId) makes a replayed IPN map onto the SAME payment row.
//
// Wave 10 (2026-10-24): providers whose merchant portal strips our
// ?provider=&ref= query string (EPS posts only its own session reference)
// are supported — the provider adapter resolves OUR payment row inside
// handleIpn and echoes it back as merchantTxnId, which the settlement layer
// cross-checks against the row exactly as for callback-echoed references.
//
// AUDIT H-4 (2026-11-07) — throttle keys no longer collapse into ONE global
// bucket: resolveClientIp returns null unless HRM_TRUST_PROXY=1 (the shipped
// default was 0), so the old key `ipn:${ip}` literally became "ipn:null" and
// EVERY gateway notification for EVERY tenant shared 30 requests per 10
// minutes — on renewal days providers retried past the 429s and paid tenants
// stayed locked in PENDING_PAYMENT. The IPN surface is now throttled per
// (provider, payment ref) with a generous per-provider flood guard, and
// never by client IP.
import { NextRequest, NextResponse } from "next/server"
import { rateLimit } from "@/hrm-server/security"
import { getPaymentProvider } from "@/hrm-server/saas/payments/registry"
import { settleGatewayPayment, recordVerifiedFailure, recordGatewayPaymentPending } from "@/hrm-server/saas/payments/settle"

export async function POST(req: NextRequest) {
  const params: Record<string, string> = {}
  req.nextUrl.searchParams.forEach((v, k) => { params[k] = v })

  // body: form-urlencoded (SSLCommerz/Nagad) or JSON (bKash) — accept both
  try {
    const ct = req.headers.get("content-type") || ""
    if (ct.includes("application/json")) {
      const json = await req.json().catch(() => ({}))
      for (const [k, v] of Object.entries(json || {})) {
        if (v != null && typeof v !== "object") params[k] = String(v)
      }
    } else {
      const form = await req.formData().catch(() => null)
      if (form) form.forEach((v, k) => { params[k] = String(v) })
    }
  } catch { /* malformed body → params stay query-only; verification will fail safely */ }

  const providerId = String(params.provider || "")
  let paymentId = String(params.ref || "")
  if (!providerId) {
    return NextResponse.json({ ok: false, error: "missing provider reference" }, { status: 400 })
  }
  const provider = getPaymentProvider(providerId)
  if (!provider) {
    return NextResponse.json({ ok: false, error: "unknown provider" }, { status: 400 })
  }

  // AUDIT H-4 — validate the provider FIRST, then throttle per
  // (provider, payment ref): 60 notifications / 10 min for one payment
  // comfortably covers aggressive provider retries, and a ref-less
  // notification (EPS portal posts only its session reference) falls into a
  // per-provider bucket instead of a deployment-global one. The per-provider
  // flood guard (2000 / 10 min) only sheds real floods — far above the old
  // 30-per-10-minutes shared ceiling — and is never keyed on client IP, so a
  // deployment without a trusted proxy can no longer throttle its own
  // revenue confirmations.
  const refKey = paymentId.slice(0, 80)
  const limited = await Promise.all([
    rateLimit(`ipn:ref:${providerId}:${refKey || "unref"}`, 60, 600_000),
    rateLimit(`ipn:flood:${providerId}`, 2000, 600_000),
  ])
  if (limited.some(Boolean)) {
    return NextResponse.json({ ok: false, error: "rate limited" }, { status: 429 })
  }

  // A missing ?ref= is NO LONGER fatal: portal-stripped IPNs (EPS) let the
  // adapter resolve the row inside handleIpn and echo it as merchantTxnId.

  try {
    const verified = await provider.handleIpn(params)
    if (!paymentId) {
      const resolved = String(verified.merchantTxnId || "").trim()
      if (!resolved) {
        return NextResponse.json({ ok: false, error: "IPN carried no usable payment reference" }, { status: 400 })
      }
      paymentId = resolved
    }
    if (verified.status === "PENDING") {
      await recordGatewayPaymentPending(paymentId, providerId, verified).catch(() => {})
      return NextResponse.json({ ok: false, status: "PENDING" }, { status: 200 })
    }
    if (!verified.ok || verified.status !== "PAID") {
      // AUDIT M-2 (2026-11-07) — only a VERIFIED failure of THIS payment may
      // be recorded: recordVerifiedFailure refuses ignored notifications
      // (nothing was verified — a forged ?ref with an empty body must not
      // flip a PENDING payment to FAILED) and refuses results whose provider
      // echo/session belongs to a different transaction. Unrecorded
      // notifications get 400 so the provider retries with a fresh one.
      const recorded = await recordVerifiedFailure(paymentId, providerId,
        `IPN reported ${verified.status || "FAILURE"}${verified.providerTxnId ? ` (txn ${verified.providerTxnId})` : ""}${verified.detail ? `: ${verified.detail}` : ""}`, verified)
        .catch(() => false)
      if (!recorded) {
        return NextResponse.json({ ok: false, error: "notification not attributable to this payment — nothing recorded" }, { status: 400 })
      }
      // 200 + ok:false — providers stop retrying on 2xx; we recorded the failure
      return NextResponse.json({ ok: false, status: verified.status || "FAILURE" })
    }
    const outcome = await settleGatewayPayment({ provider: providerId, paymentId, verified })
    return NextResponse.json({ ok: outcome.outcome === "PAID" || outcome.outcome === "ALREADY_PAID" || outcome.outcome === "REPLAY", outcome: outcome.outcome })
  } catch (e: any) {
    // verification/signature error → 400 so the provider retries with a fresh
    // (possibly valid) notification; nothing was settled.
    return NextResponse.json({ ok: false, error: String(e?.message || e).slice(0, 200) }, { status: 400 })
  }
}

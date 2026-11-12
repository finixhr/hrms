// ============ WP-I — public gateway RETURN endpoint ============
// The provider redirects the payer's browser here after checkout. The query
// carries our own reference (?provider=…&ref=<paymentId>) plus the provider's
// appended params (val_id/tran_id, paymentID/status, payment_ref_id…).
// NOTHING is trusted from the redirect: the provider params are re-verified
// through the provider's server-side validation API (verifyCallback) before
// settlement; tampered callbacks fail verification and land as FAILED rows.
import { NextRequest, NextResponse } from "next/server"
import { db } from "@/lib/db"
import { getPaymentProvider } from "@/hrm-server/saas/payments/registry"
import { settleGatewayPayment, recordVerifiedFailure, recordGatewayPaymentPending } from "@/hrm-server/saas/payments/settle"
import { requestPublicOrigin, rateLimit } from "@/hrm-server/security"

async function handle(req: NextRequest) {
  const params: Record<string, string> = {}
  req.nextUrl.searchParams.forEach((v, k) => { params[k] = v })

  // When gateways (such as SSLCommerz) redirect via POST form submit, extract form fields
  try {
    const ct = req.headers.get("content-type") || ""
    if (ct.includes("application/json")) {
      const json = await req.json().catch(() => ({}))
      for (const [k, v] of Object.entries(json || {})) {
        if (v != null && typeof v !== "object") params[k] = String(v)
      }
    } else if (ct.includes("application/x-www-form-urlencoded") || ct.includes("multipart/form-data")) {
      const form = await req.formData().catch(() => null)
      if (form) form.forEach((v, k) => { params[k] = String(v) })
    }
  } catch { /* malformed body → params stay query-only */ }

  let providerId = String(params.provider || "")
  const paymentId = String(params.ref || params.tran_id || "")

  // S2b-001 + AUDIT H-4 (2026-11-07) — replay/flood cap keyed on the PAYMENT
  // REFERENCE, never on the client IP: with the shipped HRM_TRUST_PROXY=0
  // default the old `pay-return:${ip ?? "unknown"}` key collapsed into one
  // literal "pay-return:unknown" bucket (20 requests / 5 min) shared by every
  // payer of the platform. Each payment now gets its own bucket; ref-less
  // requests (useless anyway — they redirect "invalid") share a tight one.
  if (await rateLimit(`pay-return:ref:${paymentId.slice(0, 80) || "noref"}`, 20, 300_000)) {
    return NextResponse.redirect((requestPublicOrigin(req) || req.nextUrl.origin) + "/app?billing=error", { status: 302 })
  }

  // If provider was not in query or body, resolve it safely from the payment row
  if (!providerId && paymentId) {
    const row = await db.saasPayment.findUnique({ where: { id: paymentId }, select: { provider: true } })
    if (row?.provider) providerId = row.provider
  }

  // land the payer back on the tenant app (billing view) in every outcome.
  const appOrigin = requestPublicOrigin(req) || req.nextUrl.origin
  const redirect = (status: string) =>
    NextResponse.redirect(`${appOrigin}/app?billing=${status}`, { status: 302 })

  if (!providerId || !paymentId) return redirect("invalid")

  const provider = getPaymentProvider(providerId)
  if (!provider) return redirect("invalid")

  try {
    // server-side verification — NEVER trust the redirect params alone
    const verified = await provider.verifyCallback(params)

    // PENDING state: payment is being processed or waiting for IPN.
    // NEVER mark as FAILED! Keep in PENDING state and redirect to pending view.
    if (verified.status === "PENDING") {
      await recordGatewayPaymentPending(paymentId, providerId, verified).catch(() => {})
      return redirect("pending")
    }

    if (!verified.ok || verified.status !== "PAID") {
      // AUDIT M-2 (2026-11-07) — only a VERIFIED failure of THIS payment is
      // recorded (recordVerifiedFailure refuses ignored notifications and
      // results that belong to a different transaction — a forged
      // ?ref=<paymentId>&status=cancel must not flip a pending payment).
      const recorded = await recordVerifiedFailure(
        paymentId,
        providerId,
        `gateway reported ${verified.status || "FAILURE"} on return${verified.providerTxnId ? ` (txn ${verified.providerTxnId})` : ""}${verified.detail ? `: ${verified.detail}` : ""}`,
        verified
      ).catch(() => false)
      return redirect(recorded && verified.status === "CANCELLED" ? "cancelled" : recorded ? "failed" : "pending")
    }

    const outcome = await settleGatewayPayment({ provider: providerId, paymentId, verified })
    switch (outcome.outcome) {
      case "PAID":
      case "ALREADY_PAID":
        return redirect("paid")
      case "REPLAY":
        return redirect("paid") // idempotent replay of a settled transaction
      case "SKIPPED":
        return redirect("pending")
      default:
        // MISMATCH / AMOUNT_MISMATCH / NOT_FOUND — surfaced to the billing view
        return redirect("error")
    }
  } catch {
    // provider validation API down / malformed callback — invoice stays PENDING,
    // the SaasPayment row records nothing false; retry remains possible.
    return redirect("pending")
  }
}

export async function GET(req: NextRequest) { return handle(req) }
export async function POST(req: NextRequest) { return handle(req) }

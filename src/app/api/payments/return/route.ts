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
import { settleGatewayPayment, markGatewayPaymentFailed, recordGatewayPaymentPending } from "@/hrm-server/saas/payments/settle"
import { requestPublicOrigin, rateLimit, resolveClientIp } from "@/hrm-server/security"

async function handle(req: NextRequest) {
  // S2b-001 — rate-limit browser-redirect return endpoint: 20 requests / 5 min per IP.
  // A payer's browser redirects here once per checkout; this cap stops replay/flood attacks.
  if (await rateLimit(`pay-return:${resolveClientIp(req) ?? "unknown"}`, 20, 300_000)) {
    return NextResponse.redirect((requestPublicOrigin(req) || req.nextUrl.origin) + "/app?billing=error", { status: 302 })
  }
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
      await markGatewayPaymentFailed(
        paymentId,
        providerId,
        `gateway reported ${verified.status || "FAILURE"} on return${verified.providerTxnId ? ` (txn ${verified.providerTxnId})` : ""}${verified.detail ? `: ${verified.detail}` : ""}`,
        verified
      ).catch(() => {})
      return redirect(verified.status === "CANCELLED" ? "cancelled" : "failed")
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

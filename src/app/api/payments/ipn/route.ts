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
import { NextRequest, NextResponse } from "next/server"
import { rateLimit, resolveClientIp } from "@/hrm-server/security"
import { getPaymentProvider } from "@/hrm-server/saas/payments/registry"
import { settleGatewayPayment, markGatewayPaymentFailed, recordGatewayPaymentPending } from "@/hrm-server/saas/payments/settle"

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

  // rate-limit: 30 IPNs / 10 min per IP (providers retry aggressively)
  if (await rateLimit(`ipn:${resolveClientIp(req)}`, 30, 600_000)) {
    return NextResponse.json({ ok: false, error: "rate limited" }, { status: 429 })
  }

  const providerId = String(params.provider || "")
  let paymentId = String(params.ref || "")
  if (!providerId) {
    return NextResponse.json({ ok: false, error: "missing provider reference" }, { status: 400 })
  }
  const provider = getPaymentProvider(providerId)
  if (!provider) {
    return NextResponse.json({ ok: false, error: "unknown provider" }, { status: 400 })
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
      await markGatewayPaymentFailed(paymentId, providerId,
        `IPN reported ${verified.status || "FAILURE"}${verified.providerTxnId ? ` (txn ${verified.providerTxnId})` : ""}${verified.detail ? `: ${verified.detail}` : ""}`, verified)
        .catch(() => {})
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

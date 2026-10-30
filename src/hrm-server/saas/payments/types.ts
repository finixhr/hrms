// ============ WP-I — online payment gateway provider abstraction ============
// One interface over the three Bangladesh payment gateways (SSLCommerz,
// bKash tokenized checkout, Nagad). Providers live in ./sslcommerz.ts,
// ./bkash.ts and ./nagad.ts and are resolved through ./registry.ts.
//
// SECURITY MODEL (shared by every provider):
//   - Credentials are read from SaaSSetting group "payments" rows, ENCRYPTED
//     at rest with the platform AES-256-GCM field crypto (context
//     "saas-payments::v1" — see ./credentials.ts). Plaintext secrets never
//     leave the provider module's stack frame.
//   - REDIRECT PARAMS ARE NEVER TRUSTED. Every completion (return URL hit or
//     IPN) is verified by a server-to-server call to the provider's documented
//     validation/verification API before a single paisa is recorded.
//   - The platform bills BDT only (single-currency discipline, mirrors the
//     plan currency columns).
//
// Endpoint sources: each provider module header cites its documented API
// endpoints; sandbox/live is switched by the per-provider credential `mode`
// flag (with an optional baseUrl override for regional mirrors).

import { requestPublicOrigin } from "../../security"

/** The invoice being paid, projected for a gateway checkout session.
 *  `paymentId` is OUR SaasPayment row id — it doubles as the gateway
 *  merchant reference (tran_id / orderId / merchantInvoiceNumber) so the
 *  verification response can be cross-checked against the row. */
export type ProviderInvoice = {
  paymentId: string
  invoiceNumber: string
  vendorId: string
  tenantName: string
  planName: string | null
  amount: number // BDT, major units
  currency: "BDT"
  /** Our public completion endpoints (provider + paymentId already baked in). */
  returnUrl: string
  ipnUrl: string
  customerName: string | null
  customerEmail: string | null
  customerPhone: string | null
}

/** A created checkout session: `redirectUrl` is where the tenant browser is
 *  sent; `sessionId` is the provider's session/payment reference we store on
 *  the SaasPayment row for later verification. */
export type ProviderSession = {
  sessionId: string
  redirectUrl: string
  providerTxnId?: string | null
}

/** The result of verifying a completion (callback OR IPN) server-side.
 *  - providerTxnId: the provider's own transaction reference (val_id /
 *    trxID / payment_ref_id) — the IPN replay dedupe key.
 *  - merchantTxnId: the provider's echo of OUR reference (SaasPayment id —
 *    SSLCommerz tran_id, Nagad orderId). When present the settlement layer
 *    cross-checks it against the payment row so a session from payment A can
 *    never settle payment B.
 *  - sessionId: the provider's own session/payment reference echoed at
 *    verification (bKash paymentID). When present the settlement layer
 *    cross-checks it against the payment row's stored sessionId — same
 *    anti-forgery purpose as merchantTxnId for providers that never see our
 *    reference.
 *  - amount: the provider-verified paid amount (major units), when reported.
 *  - raw: a masked projection of the provider payload stored in
 *    SaasPayment.metaJson for forensics — providers MUST strip credentials
 *    and keep it small. */
export type ProviderVerifyResult = {
  ok: boolean
  status: "PAID" | "FAILED" | "PENDING" | "CANCELLED"
  providerTxnId: string | null
  merchantTxnId?: string | null
  sessionId?: string | null
  amount: number | null
  detail?: string
  raw?: Record<string, unknown>
}

export interface PaymentProvider {
  /** Provider id as stored on SaasPayment.provider and in settings keys. */
  id: string
  /** Human label for UIs ("SSLCommerz"). */
  label: string
  /** Create a hosted-checkout session for one invoice. Throws a controlled
   *  error (code 400) when the provider is not configured on the platform. */
  createSession(invoice: ProviderInvoice): Promise<ProviderSession>
  /** Verify a browser return/callback. `params` carries the query/body fields
   *  the provider sends; verification itself is ALWAYS a server-side API call. */
  verifyCallback(params: Record<string, string>): Promise<ProviderVerifyResult>
  /** Verify an IPN/webhook body (signature-validated per the provider's
   *  documented scheme — see each provider's header). */
  handleIpn(body: Record<string, string>): Promise<ProviderVerifyResult>
  /** Query gateway transaction status by our merchant payment/tran id (reconciliation & recovery). */
  queryPayment?(paymentId: string): Promise<ProviderVerifyResult>
}

/** Shared fetch helper with a hard timeout (providers may hang; the RPC
 *  dispatcher's own 30s client timeout must not be eaten by one gateway). */
export async function providerFetch(
  url: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<{ status: number; text: string; json: any | null }> {
  const { timeoutMs = 15_000, ...rest } = init
  const res = await fetch(url, {
    ...rest,
    signal: AbortSignal.timeout(timeoutMs),
  })
  const text = await res.text()
  let json: any = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    json = null
  }
  return { status: res.status, text, json }
}

/** POST x-www-form-urlencoded (SSLCommerz init is a form POST). */
export async function postForm(
  url: string,
  fields: Record<string, string>,
  timeoutMs?: number,
): Promise<{ status: number; json: any | null }> {
  const body = new URLSearchParams(fields).toString()
  const res = await providerFetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    timeoutMs,
  })
  return { status: res.status, json: res.json ?? tryLooseJson(res.text) }
}

/** Some gateways answer JSON with a text/html content type — parse leniently. */
function tryLooseJson(text: string): any | null {
  try {
    return text ? JSON.parse(text) : null
  } catch {
    return null
  }
}

/** Parse a provider money string ("1500.00" / "1,500") into a number,
 *  null when absent/unparseable. */
export function parseAmount(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v
  if (typeof v !== "string") return null
  const n = Number(v.replace(/[^0-9.\-]/g, ""))
  return Number.isFinite(n) ? n : null
}

/** Controlled provider error → clean 4xx at the RPC boundary. */
export class ProviderError extends Error {
  code: number
  constructor(message: string, code = 400) {
    super(message)
    this.name = "ProviderError"
    this.code = code
  }
}

/** External origin of the deployment as seen by the caller — used by
 *  billing.pay.start (return/IPN URL construction) and by the public
 *  completion routes (post-settle browser redirect). Delegates to the shared
 *  requestPublicOrigin (security.ts), which honors the TLS proxy headers AND
 *  sanitizes wildcard bind hosts (0.0.0.0 → localhost) and no longer
 *  fabricates https for plain-HTTP direct access — the 2026-10-26
 *  "http://0.0.0.0:4055/app?billing=failed → ERR_ADDRESS_INVALID" payment
 *  return bug. */
export function requestOrigin(req: Request | undefined): string {
  if (!req) return ""
  return requestPublicOrigin(req)
}

/** BDT-only guard: providers reject non-BDT invoices outright. */
export function assertBdt(currency: string): void {
  if (currency !== "BDT") {
    throw new ProviderError(`Only BDT payments are supported on this platform (got ${currency}).`)
  }
}

// ============ bKash provider (WP-I) — Tokenized Checkout v1.2.0-beta ============
// Documented flow (developer portal: "Tokenized Checkout"):
//   TOKEN GRANT  POST {base}/tokenized/checkout/token/grant
//                  headers: username, password
//                  body:    { app_key, app_secret }
//                  → { id_token, token_type: "Bearer", expires_in, … }
//   CREATE       POST {base}/tokenized/checkout/create
//                  headers: Authorization: <id_token>, X-App-Key: <app_key>
//                  body:    { mode: "0011", payerReference, callbackURL,
//                             amount, currency: "BDT", intent: "SALE",
//                             merchantInvoiceNumber }
//                  → { paymentID, createTime, transactionStatus: "Initiated", … }
//   REDIRECT     {checkoutBase}/checkout/payment/{paymentID}
//   EXECUTE      POST {base}/tokenized/checkout/execute { paymentID }
//                  → { paymentID, trxID, transactionStatus: "Completed",
//                      amount, currency, … }
//   STATUS QUERY POST {base}/tokenized/checkout/payment/status { paymentID }
//                  → { trxID, transactionStatus, amount, … }
//
// Sandbox/live bases:
//   sandbox  https://tokenized.sandbox.bka.sh/v1.2.0-beta
//   live     https://tokenized.pay.bka.sh/v1.2.0-beta
//
// CALLBACK SECURITY: the callbackURL only ever receives paymentID + status.
// Those parameters are never trusted — "success" merely means the customer
// confirmed in the bKash wallet UI; the actual capture is the server-side
// EXECUTE call, and duplicate callbacks fall back to the STATUS QUERY. The
// credential-gated execute/query calls ARE the documented verification.
// bKash's tokenized checkout has no separate HMAC IPN; handleIpn() implements
// the same payment-status query for server-to-server notifications.
import type { PaymentProvider, ProviderInvoice, ProviderSession, ProviderVerifyResult } from "./types"
import { providerFetch, parseAmount, assertBdt, ProviderError } from "./types"
import { getProviderConfig, type BkashCreds } from "./credentials"
import { validateOutboundUrl } from "../../security"

function apiBase(cfg: { mode: string; baseUrlOverride?: string }): string {
  if (cfg.baseUrlOverride) {
    // S2a-014 — validate the override URL to prevent SSRF via admin-configurable base URL
    const check = validateOutboundUrl(cfg.baseUrlOverride)
    if (!check.ok) throw new ProviderError(`bKash baseUrlOverride blocked: ${check.reason}`)
    return cfg.baseUrlOverride.replace(/\/+$/, "")
  }
  return (cfg.mode === "live" ? "https://tokenized.pay.bka.sh" : "https://tokenized.sandbox.bka.sh") + "/v1.2.0-beta"
}

function checkoutBase(cfg: { mode: string; baseUrlOverride?: string }): string {
  if (cfg.baseUrlOverride) {
    // S2a-014 — same guard for the checkout variant
    const check = validateOutboundUrl(cfg.baseUrlOverride)
    if (!check.ok) throw new ProviderError(`bKash baseUrlOverride blocked: ${check.reason}`)
    return cfg.baseUrlOverride.replace(/\/+$/, "").replace(/\/v[0-9].*$/, "")
  }
  return cfg.mode === "live" ? "https://tokenized.pay.bka.sh" : "https://tokenized.sandbox.bka.sh"
}

async function requireCreds(): Promise<BkashCreds> {
  const cfg = await getProviderConfig("bkash")
  if (!cfg.enabled || !cfg.configured || !cfg.creds) {
    throw new ProviderError("bKash online payments are not enabled on this platform. The platform owner must configure the gateway (Owner Console → Payments).")
  }
  const c = cfg.creds as BkashCreds
  if (!c.appKey || !c.appSecret || !c.username || !c.password) {
    throw new ProviderError("bKash credentials are incomplete (app key / app secret / username / password missing).")
  }
  return c
}

// ---- grant-token cache (id_token lives ~1h; refresh proactively at 50min) ----
type TokenEntry = { token: string; expiresAt: number }
const tokenCache = new Map<string, TokenEntry>()

async function grantToken(creds: BkashCreds): Promise<string> {
  const key = `${creds.mode}:${creds.appKey}`
  const hit = tokenCache.get(key)
  if (hit && hit.expiresAt > Date.now()) return hit.token
  const res = await providerFetch(`${apiBase(creds)}/tokenized/checkout/token/grant`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      username: creds.username,
      password: creds.password,
      Accept: "application/json",
    },
    body: JSON.stringify({ app_key: creds.appKey, app_secret: creds.appSecret }),
  })
  const j: any = res.json
  if (!j?.id_token) {
    throw new ProviderError(`bKash token grant failed (${String(j?.statusMessage || `HTTP ${res.status}`).slice(0, 200)}).`)
  }
  const ttlMs = Math.max(60_000, (Number(j.expires_in) || 3600) * 1000 - 10 * 60_000)
  tokenCache.set(key, { token: String(j.id_token), expiresAt: Date.now() + ttlMs })
  return String(j.id_token)
}

async function authedPost(creds: BkashCreds, path: string, body: Record<string, string>): Promise<any> {
  const token = await grantToken(creds)
  const res = await providerFetch(`${apiBase(creds)}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: token,
      "X-App-Key": creds.appKey,
    },
    body: JSON.stringify(body),
  })
  return res.json
}

function mapStatus(s: unknown): "PAID" | "FAILED" | "PENDING" | "CANCELLED" {
  const v = String(s || "").toLowerCase()
  if (v === "completed") return "PAID"
  if (v === "cancelled" || v === "cancel") return "CANCELLED"
  if (v === "failed" || v === "rejected" || v === "expired") return "FAILED"
  return "PENDING" // initiated / processing / anything else
}

/** Server-side completion: EXECUTE first; fall back to the STATUS QUERY when
 *  the execute call is refused (e.g. a duplicate callback after the payment
 *  was already executed). */
async function completeOrQuery(creds: BkashCreds, paymentId: string): Promise<ProviderVerifyResult> {
  let exec: any = null
  try {
    exec = await authedPost(creds, "/tokenized/checkout/execute", { paymentID: paymentId })
  } catch {
    exec = null
  }
  const executed =
    exec && typeof exec === "object" && exec.trxID !== undefined && mapStatus(exec.transactionStatus) === "PAID"
  const payload = executed ? exec : await authedPost(creds, "/tokenized/checkout/payment/status", { paymentID: paymentId })
  const status = mapStatus(payload?.transactionStatus)
  return {
    ok: status === "PAID",
    status,
    providerTxnId: payload?.trxID ? String(payload.trxID) : null,
    merchantTxnId: payload?.merchantInvoiceNumber ? String(payload.merchantInvoiceNumber) : null,
    // the bKash paymentID IS the session reference we stored at create time —
    // the settlement layer cross-checks it against the payment row
    sessionId: payload?.paymentID ? String(payload.paymentID) : paymentId,
    amount: parseAmount(payload?.amount),
    detail: status === "PAID" ? undefined : `bKash transactionStatus: ${String(payload?.transactionStatus || payload?.statusMessage || "unknown")}`,
    raw: {
      paymentID: payload?.paymentID,
      trxID: payload?.trxID,
      transactionStatus: payload?.transactionStatus,
      amount: payload?.amount,
      currency: payload?.currency,
      customerMsisdn: payload?.customerMsisdn,
    },
  }
}

export const bkashProvider: PaymentProvider = {
  id: "bkash",
  label: "bKash",

  async createSession(inv: ProviderInvoice): Promise<ProviderSession> {
    assertBdt(inv.currency)
    const creds = await requireCreds()
    // SALE without a saved agreement — mode "0011" is the documented
    // one-time-payment code for tokenized checkout.
    const created = await authedPost(creds, "/tokenized/checkout/create", {
      mode: "0011",
      payerReference: (inv.customerPhone || inv.paymentId).slice(0, 20),
      callbackURL: inv.returnUrl,
      amount: inv.amount.toFixed(2),
      currency: "BDT",
      intent: "SALE",
      merchantInvoiceNumber: inv.invoiceNumber.slice(0, 50),
    })
    if (!created?.paymentID) {
      throw new ProviderError(`bKash could not start the payment session (${String(created?.statusMessage || "no paymentID").slice(0, 200)}).`)
    }
    const redirectUrl = `${checkoutBase(creds)}/checkout/payment/${String(created.paymentID)}`
    return { sessionId: String(created.paymentID), redirectUrl }
  },

  async verifyCallback(params: Record<string, string>): Promise<ProviderVerifyResult> {
    const creds = await requireCreds()
    const paymentId = String(params.paymentID || params.paymentId || "").trim()
    if (!paymentId) {
      return { ok: false, status: "FAILED", providerTxnId: null, amount: null, detail: "callback without paymentID" }
    }
    const outcome = String(params.status || "").toLowerCase()
    if (outcome === "failure" || outcome === "failed") {
      return { ok: false, status: "FAILED", providerTxnId: null, sessionId: paymentId, amount: null, detail: "customer cancelled / payment failed at bKash", raw: { paymentID: paymentId, status: outcome } }
    }
    if (outcome === "cancel" || outcome === "cancelled") {
      return { ok: false, status: "CANCELLED", providerTxnId: null, sessionId: paymentId, amount: null, detail: "customer cancelled at bKash", raw: { paymentID: paymentId, status: outcome } }
    }
    try {
      return await completeOrQuery(creds, paymentId)
    } catch (e: any) {
      return { ok: false, status: "PENDING", providerTxnId: null, sessionId: paymentId, amount: null, detail: `bKash verify call failed: ${String(e?.message || e).slice(0, 200)}` }
    }
  },

  async handleIpn(body: Record<string, string>): Promise<ProviderVerifyResult> {
    const creds = await requireCreds()
    // Server-to-server notification: the ONLY trustworthy check is the
    // credential-gated payment status query — never the posted fields.
    const paymentId = String(body.paymentID || body.paymentId || "").trim()
    if (!paymentId) {
      return { ok: false, status: "FAILED", providerTxnId: null, amount: null, detail: "IPN without paymentID — ignored" }
    }
    try {
      const payload = await authedPost(creds, "/tokenized/checkout/payment/status", { paymentID: paymentId })
      const status = mapStatus(payload?.transactionStatus)
      return {
        ok: status === "PAID",
        status,
        providerTxnId: payload?.trxID ? String(payload.trxID) : null,
        sessionId: paymentId,
        amount: parseAmount(payload?.amount),
        detail: status === "PAID" ? undefined : `bKash transactionStatus: ${String(payload?.transactionStatus || "unknown")}`,
        raw: { paymentID: paymentId, trxID: payload?.trxID, transactionStatus: payload?.transactionStatus, amount: payload?.amount },
      }
    } catch (e: any) {
      return { ok: false, status: "PENDING", providerTxnId: null, sessionId: paymentId, amount: null, detail: `bKash status query failed: ${String(e?.message || e).slice(0, 200)}` }
    }
  },
}

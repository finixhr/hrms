// ============ Wave 10 (2026-10-24) — EPS provider (Eastern Payment Systems, BD) =
// Documented EPS Gateway flow (eps.com.bd — "Easy Payment System"; endpoint
// shapes per the official EPS integration guide / merchant sandbox):
//   TOKEN    POST {base}/v1/Auth/GetToken
//              headers: x-hash = base64(HMAC-SHA512(key=hashKey, msg=username))
//              body: { userName, password } → { token }
//   INIT     POST {base}/v1/EPSEngine/InitializeEPS
//              headers: x-hash = base64(HMAC-SHA512(key=hashKey,
//                        msg=merchantTransactionId)), Authorization: Bearer
//              body: merchantId, storeId, CustomerOrderId,
//                    merchantTransactionId (OURS — SaasPayment id),
//                    transactionTypeId, totalAmount, successUrl, failUrl,
//                    cancelUrl, customer* fields, productName/Profile/Category,
//                    ProductList[] → { TransactionId, RedirectURL }
//   REDIRECT RedirectURL (cards + wallets via the EPS portal)
//   VERIFY   GET {base}/v1/EPSEngine/CheckMerchantTransactionStatus
//                      ?merchantTransactionId={id}
//              headers: x-hash (msg=merchantTransactionId), Bearer
//            → { MerchantTransactionId, Status ("success"), EPSTransactionId,
//                TotalAmount, StoreAmount, FinancialEntity, … }
//
// Sandbox/live bases:
//   sandbox  https://sandboxpgapi.eps.com.bd
//   live     https://pgapi.eps.com.bd
//
// SECURITY MODEL (identical to the other providers):
//   - Credentials live encrypted in SaaSSetting group "payments"
//     (context "saas-payments::v1"): username, password, hashKey, merchantId,
//     storeId. Plaintext never leaves this stack frame.
//   - Callback AND IPN references are NEVER trusted: completion is confirmed
//     ONLY through the credential-gated CheckMerchantTransactionStatus API
//     before settlement. The bearer token is cached in-memory only.
//   - merchantTransactionId = OUR SaasPayment row id — the verify response's
//     MerchantTransactionId echo is the merchantTxnId cross-check.
//   - TransactionId (EPS's own session reference) is stored as the payment
//     row's sessionId. The merchant-portal IPN may post ONLY that session
//     reference (our query-string ref stripped by the portal) — handleIpn
//     then resolves the row through the @@index([provider, sessionId]) added
//     in migration 9_wave9zp, and the resolved row id is re-verified through
//     the status API before anything settles.
import crypto from "crypto"
import { db } from "@/lib/db"
import type { PaymentProvider, ProviderInvoice, ProviderSession, ProviderVerifyResult } from "./types"
import { providerFetch, parseAmount, assertBdt, ProviderError } from "./types"
import { getProviderConfig, type EpsCreds } from "./credentials"

function apiBase(cfg: { mode: string; baseUrlOverride?: string }): string {
  if (cfg.baseUrlOverride) return cfg.baseUrlOverride.replace(/\/+$/, "")
  return (cfg.mode === "live" ? "https://pgapi.eps.com.bd" : "https://sandboxpgapi.eps.com.bd").replace(/\/+$/, "")
}

/** EPS x-hash header: base64(HMAC-SHA512(hashKey, data)) — the documented
 *  per-request signature. For GetToken data = username; for every engine call
 *  data = the merchantTransactionId being acted on. PURE (unit-tested). */
export function epsXHash(hashKey: string, data: string): string {
  return crypto.createHmac("sha512", hashKey).update(data, "utf8").digest("base64")
}

async function requireCreds(): Promise<EpsCreds> {
  const cfg = await getProviderConfig("eps")
  if (!cfg.enabled || !cfg.configured || !cfg.creds) {
    throw new ProviderError("EPS online payments are not enabled on this platform. The platform owner must configure the gateway (Owner Console → Payments).")
  }
  const c = cfg.creds as EpsCreds
  if (!c.username || !c.password || !c.hashKey || !c.merchantId || !c.storeId) {
    throw new ProviderError("EPS credentials are incomplete (username / password / hash key / merchant id / store id missing).")
  }
  return c
}

// ---------------- bearer token (in-memory cache, single-flight) ----------------

type TokenEntry = { token: string; at: number }
let tokenCache: TokenEntry | null = null
const TOKEN_TTL_MS = 10 * 60_000

/** Invalidate the cached bearer (credential rotation / 401 retry). */
export function invalidateEpsToken(): void {
  tokenCache = null
}

async function fetchToken(creds: EpsCreds): Promise<string> {
  const res = await providerFetch(`${apiBase(creds)}/v1/Auth/GetToken`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "x-hash": epsXHash(creds.hashKey, creds.username),
    },
    body: JSON.stringify({ userName: creds.username, password: creds.password }),
  })
  const j: any = res.json
  const token = j && typeof j === "object" ? String(j.token || j.Token || "") : ""
  if (!token) {
    throw new ProviderError(`EPS authentication failed (${String(j?.message || `HTTP ${res.status}`).slice(0, 180)}).`)
  }
  tokenCache = { token, at: Date.now() }
  return token
}

async function bearer(creds: EpsCreds): Promise<string> {
  if (tokenCache && Date.now() - tokenCache.at < TOKEN_TTL_MS) return tokenCache.token
  return fetchToken(creds)
}

/** GET the documented status check for one merchantTransactionId — the ONLY
 *  completion authority. Retries once on a stale/401 token. */
async function verifyMerchantTransaction(creds: EpsCreds, merchantTransactionId: string): Promise<ProviderVerifyResult> {
  for (let attempt = 0; attempt < 2; attempt++) {
    let res: Awaited<ReturnType<typeof providerFetch>>
    try {
      res = await providerFetch(
        `${apiBase(creds)}/v1/EPSEngine/CheckMerchantTransactionStatus?merchantTransactionId=${encodeURIComponent(merchantTransactionId)}`,
        {
          method: "GET",
          headers: {
            Accept: "application/json",
            "x-hash": epsXHash(creds.hashKey, merchantTransactionId),
            Authorization: `Bearer ${await bearer(creds)}`,
          },
        },
      )
    } catch (e: any) {
      return { ok: false, status: "PENDING", providerTxnId: null, merchantTxnId: merchantTransactionId, amount: null, detail: `EPS verify call failed: ${String(e?.message || e).slice(0, 200)}` }
    }
    if (res.status === 401 || res.status === 403) {
      invalidateEpsToken()
      if (attempt === 0) continue
    }
    const j: any = res.json
    if (!j || typeof j !== "object" || !j.MerchantTransactionId) {
      return {
        ok: false,
        status: "FAILED",
        providerTxnId: null,
        merchantTxnId: merchantTransactionId,
        amount: null,
        detail: `EPS status check could not resolve the transaction (HTTP ${res.status}${j?.ErrorMessage ? `: ${String(j.ErrorMessage).slice(0, 120)}` : ""})`.slice(0, 250),
      }
    }
    const status = String(j.Status || "").trim().toLowerCase()
    if (status === "success") {
      return {
        ok: true,
        status: "PAID",
        providerTxnId: String(j.EPSTransactionId || merchantTransactionId),
        merchantTxnId: String(j.MerchantTransactionId || merchantTransactionId),
        sessionId: String(j.TransactionId || j.EPSTransactionId || "") || null,
        amount: parseAmount(j.TotalAmount ?? j.totalAmount),
        raw: {
          epsTransactionId: String(j.EPSTransactionId || "").slice(0, 80),
          financialEntity: String(j.FinancialEntity || "").slice(0, 40),
          storeAmount: parseAmount(j.StoreAmount) ?? undefined,
        },
      }
    }
    if (status === "processing" || status === "pending" || status === "") {
      return { ok: false, status: "PENDING", providerTxnId: String(j.EPSTransactionId || "") || null, merchantTxnId: String(j.MerchantTransactionId), amount: null, detail: "EPS reports the transaction as processing" }
    }
    return {
      ok: false,
      status: "FAILED",
      providerTxnId: String(j.EPSTransactionId || "") || null,
      merchantTxnId: String(j.MerchantTransactionId || merchantTransactionId),
      amount: null,
      detail: `EPS status: ${status || "unknown"}`.slice(0, 200),
      raw: { epsStatus: status.slice(0, 40) },
    }
  }
  return { ok: false, status: "PENDING", providerTxnId: null, merchantTxnId: merchantTransactionId, amount: null, detail: "EPS verification failed after token refresh" }
}

/** Resolve our payment-row reference from a provider session id — the EPS
 *  merchant-portal IPN can strip our ?provider=&ref= query string and post
 *  only ITS TransactionId. Uses the @@index([provider, sessionId]). */
export async function resolveEpsPaymentRefBySession(sessionId: string): Promise<string | null> {
  if (!sessionId) return null
  const row = await db.saasPayment.findFirst({
    where: { provider: "eps", sessionId: String(sessionId).slice(0, 120) },
    select: { id: true },
    orderBy: { createdAt: "desc" },
  })
  return row?.id || null
}

export const epsProvider: PaymentProvider = {
  id: "eps",
  label: "EPS",

  async createSession(inv: ProviderInvoice): Promise<ProviderSession> {
    assertBdt(inv.currency)
    const creds = await requireCreds()
    const merchantTransactionId = inv.paymentId.slice(0, 50)
    const token = await bearer(creds)

    const body = {
      merchantId: creds.merchantId,
      storeId: creds.storeId,
      CustomerOrderId: inv.invoiceNumber.slice(0, 80),
      merchantTransactionId,
      transactionTypeId: creds.transactionTypeId || "1", // WEB checkout (per the integration guide's type table)
      totalAmount: inv.amount.toFixed(2),
      successUrl: inv.returnUrl,
      failUrl: inv.returnUrl,
      cancelUrl: inv.returnUrl,
      customerName: (inv.customerName || inv.tenantName || "Finix HR Tenant").slice(0, 100),
      customerEmail: (inv.customerEmail || `billing@${inv.vendorId}.finixhr.local`).slice(0, 120),
      customerAddress: "Bangladesh",
      customerCity: "Dhaka",
      customerState: "Dhaka",
      customerPostcode: "1000",
      customerCountry: "BD",
      customerPhone: (inv.customerPhone || "01700000000").slice(0, 20),
      productName: `Finix HR subscription — ${inv.planName || inv.invoiceNumber}`.slice(0, 120),
      productProfile: "non-physical-goods",
      productCategory: "SaaS subscription",
      ipAddress: "0.0.0.0", // replaced by the portal from the buyer session
      version: "1.0",
      description: `Finix HR invoice ${inv.invoiceNumber}`.slice(0, 200),
      ProductList: [
        {
          productName: `Finix HR invoice ${inv.invoiceNumber}`.slice(0, 120),
          productCategory: "SaaS subscription",
          quantity: 1,
          unitPrice: inv.amount.toFixed(2),
        },
      ],
    }

    const res = await providerFetch(`${apiBase(creds)}/v1/EPSEngine/InitializeEPS`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "x-hash": epsXHash(creds.hashKey, merchantTransactionId),
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    })
    const j: any = res.json
    if (j?.ErrorMessage || !j?.RedirectURL) {
      throw new ProviderError(`EPS could not start the payment session (${String(j?.ErrorMessage || `HTTP ${res.status}`).slice(0, 200)}).`)
    }
    return {
      sessionId: String(j.TransactionId || j.RedirectURL).slice(0, 160),
      redirectUrl: String(j.RedirectURL),
    }
  },

  async verifyCallback(params: Record<string, string>): Promise<ProviderVerifyResult> {
    const creds = await requireCreds()
    const ref = String(
      params.merchantTransactionId || params.MerchantTransactionId || params.mer_txn_id || params.ref || "",
    ).trim()
    if (!ref) {
      return { ok: false, status: "FAILED", providerTxnId: null, amount: null, detail: "callback without a merchant transaction reference" }
    }
    return verifyMerchantTransaction(creds, ref)
  },

  async handleIpn(body: Record<string, string>): Promise<ProviderVerifyResult> {
    const creds = await requireCreds()
    // Preferred path: the portal echoes OUR merchantTransactionId.
    const ref = String(
      body.merchantTransactionId || body.MerchantTransactionId || body.mer_txn_id || "",
    ).trim()
    if (ref) return verifyMerchantTransaction(creds, ref)

    // Fallback path (migration 9_wave9zp): only the EPS session reference
    // arrived. Resolve OUR payment row through (provider, sessionId) and
    // re-verify the resolved row through the credential-gated status API —
    // the settlement layer still cross-checks merchantTxnId + session.
    const sessionRef = String(body.TransactionId || body.transactionId || body.EPSTransactionId || body.epsTrxId || "").trim()
    if (!sessionRef) {
      return { ok: false, status: "FAILED", providerTxnId: null, amount: null, detail: "EPS IPN without a merchant or session reference — ignored" }
    }
    const paymentId = await resolveEpsPaymentRefBySession(sessionRef)
    if (!paymentId) {
      return { ok: false, status: "PENDING", providerTxnId: null, sessionId: sessionRef, amount: null, detail: "EPS IPN session reference matches no known checkout — ignored" }
    }
    return verifyMerchantTransaction(creds, paymentId)
  },
}

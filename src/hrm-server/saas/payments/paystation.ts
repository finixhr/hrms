// ============ Wave 10 (2026-10-24) — PayStation provider (Bangladesh) ============
// Documented PayStation "Hosted Checkout" flow (paystation.com.bd/documentation,
// Service Hub Limited — API v1):
//   INIT     POST {base}/initiate-payment  (form-urlencoded)
//              body: merchantId, password, invoice_number (unique), currency,
//                    payment_amount, pay_with_charge (0|1), cust_name,
//                    cust_phone, cust_email, callback_url, opt_a/b/c
//            → { status_code: "200", status: "success",
//                payment_url: "{base}/checkout/{id}/{token}" }
//   REDIRECT payment_url (cards, EMI, bKash/Nagad/Rocket/Upay, banks)
//   VERIFY   POST {base}/transaction-status  (header: merchantId)
//              body: invoice_number
//            → { status_code: "200", data: { trx_status: processing|success|
//                failed|refund, trx_id, payment_amount, payment_method, … } }
//   IPN      POST {ipnUrl} JSON { invoice_number, trx_status: "Success",
//                trx_id, trx_amount, order_date_time, payment_method, reference }
//            — fired ONLY for successes, retried until 2xx. The gateway's own
//              checklist says treat it as untrusted and re-query.
//
// Sandbox/live bases:
//   sandbox  https://sandbox.paystation.com.bd
//   live     https://api.paystation.com.bd
//
// SECURITY MODEL (identical to the WP-I providers):
//   - Credentials live encrypted in SaaSSetting group "payments"
//     (context "saas-payments::v1"); plaintext never leaves this stack frame.
//   - Callback AND IPN params are NEVER trusted: every completion is confirmed
//     through the credential-gated transaction-status API before settlement.
//     The IPN's invoice_number only tells us WHICH row to re-verify.
//   - invoice_number = OUR SaasPayment row id (unique per attempt — retries
//     mint a fresh payment row), so the verify response's invoice echo is the
//     merchantTxnId cross-check the settlement layer enforces.
//   - sessionId = the checkout token from payment_url (the provider's session
//     reference); stored on the payment row for session-binding checks.
import type { PaymentProvider, ProviderInvoice, ProviderSession, ProviderVerifyResult } from "./types"
import { providerFetch, postForm, parseAmount, assertBdt, ProviderError } from "./types"
import { getProviderConfig, type PaystationCreds } from "./credentials"

function apiBase(cfg: { mode: string; baseUrlOverride?: string }): string {
  if (cfg.baseUrlOverride) return cfg.baseUrlOverride.replace(/\/+$/, "")
  return (cfg.mode === "live" ? "https://api.paystation.com.bd" : "https://sandbox.paystation.com.bd").replace(/\/+$/, "")
}

async function requireCreds(): Promise<PaystationCreds> {
  const cfg = await getProviderConfig("paystation")
  if (!cfg.enabled || !cfg.configured || !cfg.creds) {
    throw new ProviderError("PayStation online payments are not enabled on this platform. The platform owner must configure the gateway (Owner Console → Payments).")
  }
  const c = cfg.creds as PaystationCreds
  if (!c.merchantId || !c.password) {
    throw new ProviderError("PayStation credentials are incomplete (merchant id / password missing).")
  }
  return c
}

/** trx_status vocabulary → our completion status. The API reports
 *  processing | success | failed | refund (case varies in examples).
 *  PURE (unit-tested). */
export function mapTrxStatus(v: unknown): "PAID" | "FAILED" | "PENDING" | "CANCELLED" {
  const s = String(v ?? "").trim().toLowerCase()
  if (s === "success") return "PAID"
  if (s === "failed") return "FAILED"
  if (s === "refund") return "FAILED"
  if (s === "processing" || s === "pending" || s === "") return "PENDING"
  if (s === "cancelled" || s === "canceled") return "CANCELLED"
  return "PENDING"
}

/** Server-side verification of one invoice — the ONLY completion check.
 *  Uses providerFetch directly: the status API requires the merchantId
 *  HEADER (postForm cannot carry custom headers). */
async function verifyInvoice(creds: PaystationCreds, invoiceNumber: string): Promise<ProviderVerifyResult> {
  try {
    const res = await providerFetch(`${apiBase(creds)}/transaction-status`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
        merchantId: creds.merchantId,
      },
      body: new URLSearchParams({ invoice_number: invoiceNumber }).toString(),
    })
    const status = res.status
    const j: any = res.json
    if (!j || typeof j !== "object") {
      return { ok: false, status: "PENDING", providerTxnId: null, merchantTxnId: invoiceNumber, amount: null, detail: `PayStation verify returned HTTP ${status} without JSON` }
    }
    // 2001 = invalid merchant / not found; 1008 = duplicate invoice — both are
    // terminal for THIS attempt, not transient.
    if (String(j.status_code) !== "200" || !j.data || typeof j.data !== "object") {
      const msg = String(j.message || j.status_code || "unknown")
      return {
        ok: false,
        status: "FAILED",
        providerTxnId: null,
        merchantTxnId: invoiceNumber,
        amount: null,
        detail: `PayStation status_code ${String(j.status_code ?? "?")}: ${msg}`.slice(0, 250),
        raw: { statusCode: String(j.status_code ?? ""), message: msg.slice(0, 80) },
      }
    }
    const d = j.data
    const mapped = mapTrxStatus(d.trx_status)
    return {
      ok: mapped === "PAID",
      status: mapped,
      providerTxnId: String(d.trx_id || "").trim() || null,
      merchantTxnId: String(d.invoice_number || invoiceNumber),
      amount: parseAmount(d.payment_amount ?? d.trx_amount),
      detail: mapped === "PAID" ? undefined : `PayStation trx_status: ${String(d.trx_status ?? "?")}`.slice(0, 200),
      raw: {
        invoiceNumber: String(d.invoice_number || ""),
        trxStatus: String(d.trx_status || ""),
        paymentMethod: String(d.payment_method || "").slice(0, 40),
      },
    }
  } catch (e: any) {
    return { ok: false, status: "PENDING", providerTxnId: null, merchantTxnId: invoiceNumber, amount: null, detail: `PayStation verify call failed: ${String(e?.message || e).slice(0, 200)}` }
  }
}

export const paystationProvider: PaymentProvider = {
  id: "paystation",
  label: "PayStation",

  async createSession(inv: ProviderInvoice): Promise<ProviderSession> {
    assertBdt(inv.currency)
    const creds = await requireCreds()
    // Our SaasPayment id doubles as the unique PayStation invoice_number so the
    // verify response echoes OUR reference back (merchantTxnId cross-check).
    const invoiceNumber = inv.paymentId.slice(0, 50)
    const { status, json } = await postForm(`${apiBase(creds)}/initiate-payment`, {
      merchantId: creds.merchantId,
      password: creds.password,
      invoice_number: invoiceNumber,
      currency: "BDT",
      payment_amount: inv.amount.toFixed(2),
      // chargeBearer: 0 = merchant pays the gateway charge (default), 1 = customer
      pay_with_charge: creds.payWithCharge === 1 ? "1" : "0",
      cust_name: (inv.customerName || inv.tenantName || "Finix HR Tenant").slice(0, 100),
      cust_phone: (inv.customerPhone || "01700000000").slice(0, 20),
      cust_email: (inv.customerEmail || `billing@${inv.vendorId}.finixhr.local`).slice(0, 120),
      callback_url: inv.returnUrl,
      opt_a: `vendor:${inv.vendorId}`,
      opt_b: inv.invoiceNumber.slice(0, 100),
    })

    const j: any = json
    if (!j || String(j.status_code) !== "200" || !j.payment_url) {
      const msg = String(j?.message || `HTTP ${status}`)
      if (String(j?.status_code) === "1008") {
        throw new ProviderError("PayStation rejected the invoice number as a duplicate — start a fresh payment for this invoice.")
      }
      throw new ProviderError(`PayStation could not start the payment session (${msg.slice(0, 200)}).`)
    }
    // The checkout URL ends with the provider's session token: /checkout/{ref}/{token}
    let sessionId = String(j.invoice_number || invoiceNumber)
    try {
      const parts = new URL(String(j.payment_url)).pathname.split("/").filter(Boolean)
      if (parts.length >= 2) sessionId = parts[parts.length - 1].slice(0, 120)
    } catch { /* keep invoice echo as the session reference */ }
    return { sessionId, redirectUrl: String(j.payment_url) }
  },

  async verifyCallback(params: Record<string, string>): Promise<ProviderVerifyResult> {
    const creds = await requireCreds()
    const invoiceNumber = String(params.invoice_number || params.invoiceNumber || params.opt_b || "").trim() // S2b-010: opt_b carries invoiceNumber (opt_a carries vendorId)
    if (!invoiceNumber) {
      return { ok: false, status: "FAILED", providerTxnId: null, amount: null, detail: "callback without an invoice reference" }
    }
    return verifyInvoice(creds, invoiceNumber)
  },

  async handleIpn(body: Record<string, string>): Promise<ProviderVerifyResult> {
    const creds = await requireCreds()
    // The IPN fires only for SUCCESSFUL transactions and is explicitly
    // documented as untrusted — its invoice_number selects the row to
    // re-verify; the credential-gated status API decides the outcome.
    const invoiceNumber = String(body.invoice_number || body.invoiceNumber || "").trim()
    if (!invoiceNumber) {
      return { ok: false, status: "FAILED", providerTxnId: null, amount: null, detail: "IPN without an invoice reference — ignored" }
    }
    const verified = await verifyInvoice(creds, invoiceNumber)
    if (verified.ok && body.trx_id && !verified.providerTxnId) {
      verified.providerTxnId = String(body.trx_id).slice(0, 120)
    }
    return verified
  },
}

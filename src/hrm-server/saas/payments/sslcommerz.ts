// ============ SSLCommerz provider (WP-I) ============
// Documented SSLCommerz "Session Only" API v4:
//   INIT         POST {base}/gwprocess/v4/api.php          (form-urlencoded)
//                  → { status: "SUCCESS", sessionkey, GatewayPageURL, ... }
//   VALIDATION   GET  {base}/validator/api/validationserverAPI.php
//                  ?val_id=…&store_id=…&store_passwd=…&v=1&format=json
//                  → { status: "VALID"|"VALIDATED"|"INVALID", val_id, tran_id, amount,
//                      currency, bank_tran_id, card_type, tran_date, … }
//   TXN QUERY    GET  {base}/validator/api/merchantTransIDvalidationAPI.php
//                  ?tran_id=…&store_id=…&store_passwd=…&format=json
//                  → { APIConnect: "DONE", no_of_trans_found, element: [{ val_id, tran_id, status, amount, … }] }
//   IPN          provider POSTs (form-urlencoded) val_id + tran_id + status
//                  to our ipn_url — NEVER trusted directly; we re-validate
//                  the val_id through the VALIDATION API above. That server-
//                  side validation IS the documented signature check (the
//                  store credentials gate it); there is no separate HMAC.
// Sandbox/live endpoints:
//   sandbox  https://sandbox.sslcommerz.com
//   live     https://securepay.sslcommerz.com
// `tran_id` (our SaasPayment id) is cross-checked from the validation
// response by the settlement layer (merchantTxnId below).
import type { PaymentProvider, ProviderInvoice, ProviderSession, ProviderVerifyResult } from "./types"
import { postForm, providerFetch, parseAmount, assertBdt, ProviderError } from "./types"
import { getProviderConfig, type SslcommerzCreds } from "./credentials"

function base(cfg: { mode: string; baseUrlOverride?: string }): string {
  if (cfg.baseUrlOverride) return cfg.baseUrlOverride.replace(/\/+$/, "")
  return (cfg.mode === "live" ? "https://securepay.sslcommerz.com" : "https://sandbox.sslcommerz.com").replace(/\/+$/, "")
}

async function requireCreds(): Promise<SslcommerzCreds> {
  const cfg = await getProviderConfig("sslcommerz")
  if (!cfg.enabled || !cfg.configured || !cfg.creds) {
    throw new ProviderError("SSLCommerz online payments are not enabled on this platform. The platform owner must configure the gateway (Owner Console → Payments).")
  }
  const c = cfg.creds as SslcommerzCreds
  if (!c.storeId || !c.storePassword) {
    throw new ProviderError("SSLCommerz credentials are incomplete (store id / store password missing).")
  }
  return c
}

/** GET validationserverAPI.php and normalize the answer. */
async function validate(creds: SslcommerzCreds, valId: string): Promise<ProviderVerifyResult> {
  const url =
    `${base(creds)}/validator/api/validationserverAPI.php` +
    `?val_id=${encodeURIComponent(valId)}&store_id=${encodeURIComponent(creds.storeId)}` +
    `&store_passwd=${encodeURIComponent(creds.storePassword)}&v=1&format=json`
  try {
    const res = await providerFetch(url, { method: "GET" })
    const j: any = res.json
    if (!j || typeof j !== "object") {
      return { ok: false, status: "PENDING", providerTxnId: valId, amount: null, detail: `validationserverAPI returned HTTP ${res.status} without JSON` }
    }
    const status = String(j.status || "").toUpperCase()
    if (status === "VALID" || status === "VALIDATED") {
      return {
        ok: true,
        status: "PAID",
        providerTxnId: String(j.val_id || valId),
        merchantTxnId: j.tran_id ? String(j.tran_id) : null,
        amount: parseAmount(j.amount),
        raw: {
          val_id: j.val_id,
          tran_id: j.tran_id,
          bank_tran_id: j.bank_tran_id,
          card_type: j.card_type,
          card_no: j.card_no,
          amount: j.amount,
          currency: j.currency,
          tran_date: j.tran_date,
          store_id: creds.storeId,
          validated_status: status,
        },
      }
    }
    if (status === "FAILED") {
      return {
        ok: false,
        status: "FAILED",
        providerTxnId: String(j.val_id || valId),
        merchantTxnId: j.tran_id ? String(j.tran_id) : null,
        amount: parseAmount(j.amount),
        detail: `validationserver status: FAILED (${j.failedreason || j.error || "failed"})`,
        raw: { val_id: j.val_id, tran_id: j.tran_id, validated_status: status },
      }
    }
    if (status === "CANCELLED" || status === "UNATTEMPTED") {
      return {
        ok: false,
        status: "CANCELLED",
        providerTxnId: String(j.val_id || valId),
        merchantTxnId: j.tran_id ? String(j.tran_id) : null,
        amount: parseAmount(j.amount),
        detail: `validationserver status: ${status}`,
        raw: { val_id: j.val_id, tran_id: j.tran_id, validated_status: status },
      }
    }
    return {
      ok: false,
      status: "PENDING",
      providerTxnId: String(j.val_id || valId),
      merchantTxnId: j.tran_id ? String(j.tran_id) : null,
      amount: parseAmount(j.amount),
      detail: `validationserver status: ${status || "PENDING"}`,
      raw: { val_id: j.val_id, tran_id: j.tran_id, validated_status: status },
    }
  } catch (e: any) {
    return { ok: false, status: "PENDING", providerTxnId: valId, amount: null, detail: `validation call failed: ${String(e?.message || e).slice(0, 200)}` }
  }
}

/** GET merchantTransIDvalidationAPI.php to validate by merchant tran_id (SaasPayment id). */
async function validateByTranId(creds: SslcommerzCreds, tranId: string): Promise<ProviderVerifyResult> {
  const url =
    `${base(creds)}/validator/api/merchantTransIDvalidationAPI.php` +
    `?tran_id=${encodeURIComponent(tranId)}&store_id=${encodeURIComponent(creds.storeId)}` +
    `&store_passwd=${encodeURIComponent(creds.storePassword)}&format=json`
  try {
    const res = await providerFetch(url, { method: "GET" })
    const j: any = res.json
    if (!j || typeof j !== "object") {
      return { ok: false, status: "PENDING", providerTxnId: null, merchantTxnId: tranId, amount: null, detail: `merchantTransIDvalidationAPI returned HTTP ${res.status}` }
    }
    const elements: any[] = Array.isArray(j.element) ? j.element : []
    if (elements.length === 0) {
      return { ok: false, status: "PENDING", providerTxnId: null, merchantTxnId: tranId, amount: null, detail: "no transaction element returned by SSLCommerz for tran_id" }
    }
    // Find first VALID / VALIDATED transaction
    const valid = elements.find((el) => {
      const s = String(el.status || "").toUpperCase()
      return s === "VALID" || s === "VALIDATED"
    })
    if (valid) {
      return {
        ok: true,
        status: "PAID",
        providerTxnId: String(valid.val_id || valid.bank_tran_id || tranId),
        merchantTxnId: valid.tran_id ? String(valid.tran_id) : tranId,
        amount: parseAmount(valid.amount),
        raw: {
          val_id: valid.val_id,
          tran_id: valid.tran_id || tranId,
          bank_tran_id: valid.bank_tran_id,
          card_type: valid.card_type,
          card_no: valid.card_no,
          amount: valid.amount,
          currency: valid.currency,
          tran_date: valid.tran_date,
          store_id: creds.storeId,
          validated_status: valid.status,
          validated_via: "merchantTransIDvalidationAPI",
        },
      }
    }
    const failed = elements.find((el) => String(el.status || "").toUpperCase() === "FAILED")
    if (failed) {
      return {
        ok: false,
        status: "FAILED",
        providerTxnId: failed.val_id ? String(failed.val_id) : null,
        merchantTxnId: failed.tran_id ? String(failed.tran_id) : tranId,
        amount: parseAmount(failed.amount),
        detail: `gateway transaction status: FAILED (${failed.error || "failed"})`,
        raw: { tran_id: tranId, validated_status: "FAILED" },
      }
    }
    const cancelled = elements.find((el) => ["CANCELLED", "UNATTEMPTED"].includes(String(el.status || "").toUpperCase()))
    if (cancelled) {
      return {
        ok: false,
        status: "CANCELLED",
        providerTxnId: cancelled.val_id ? String(cancelled.val_id) : null,
        merchantTxnId: cancelled.tran_id ? String(cancelled.tran_id) : tranId,
        amount: parseAmount(cancelled.amount),
        detail: `gateway transaction status: ${cancelled.status}`,
        raw: { tran_id: tranId, validated_status: cancelled.status },
      }
    }
    return {
      ok: false,
      status: "PENDING",
      providerTxnId: elements[0]?.val_id ? String(elements[0].val_id) : null,
      merchantTxnId: tranId,
      amount: parseAmount(elements[0]?.amount),
      detail: `gateway transaction status: ${elements[0]?.status || "PENDING"}`,
      raw: { tran_id: tranId, validated_status: elements[0]?.status },
    }
  } catch (e: any) {
    return { ok: false, status: "PENDING", providerTxnId: null, merchantTxnId: tranId, amount: null, detail: `tran_id validation call failed: ${String(e?.message || e).slice(0, 200)}` }
  }
}

export const sslcommerzProvider: PaymentProvider = {
  id: "sslcommerz",
  label: "SSLCommerz",

  async createSession(inv: ProviderInvoice): Promise<ProviderSession> {
    assertBdt(inv.currency)
    const creds = await requireCreds()
    const fields: Record<string, string> = {
      store_id: creds.storeId,
      store_passwd: creds.storePassword,
      total_amount: inv.amount.toFixed(2),
      currency: "BDT",
      tran_id: inv.paymentId, // our SaasPayment id — echoed on every callback
      success_url: `${inv.returnUrl}&outcome=success`,
      fail_url: `${inv.returnUrl}&outcome=fail`,
      cancel_url: `${inv.returnUrl}&outcome=cancel`,
      ipn_url: inv.ipnUrl,
      cus_name: (inv.customerName || inv.tenantName).slice(0, 100),
      cus_email: (inv.customerEmail || "billing@finixhr.example").slice(0, 100),
      cus_add1: "Billing portal checkout",
      cus_city: "Dhaka",
      cus_country: "Bangladesh",
      shipping_method: "NO",
      num_of_item: "1",
      product_name: `Finix HR subscription — ${inv.planName || "plan"} (${inv.invoiceNumber})`.slice(0, 250),
      product_category: "SaaS subscription",
      product_profile: "general",
    }
    const res = await postForm(`${base(creds)}/gwprocess/v4/api.php`, fields)
    const j: any = res.json
    if (res.status === 401 || (j && String(j.status).toUpperCase() === "FAILED" && /store/i.test(String(j.failedreason || "")))) {
      throw new ProviderError("SSLCommerz rejected the store credentials — the platform owner should re-check them.")
    }
    if (!j || String(j.status || "").toUpperCase() !== "SUCCESS" || !j.sessionkey || !j.GatewayPageURL) {
      throw new ProviderError(`SSLCommerz could not start the payment session (${String(j?.failedreason || j?.status || `HTTP ${res.status}`).slice(0, 200)}).`)
    }
    return { sessionId: String(j.sessionkey), redirectUrl: String(j.GatewayPageURL) }
  },

  async verifyCallback(params: Record<string, string>): Promise<ProviderVerifyResult> {
    const creds = await requireCreds()
    // The redirect carries val_id on success; fail/cancel carry status only.
    const outcome = String(params.outcome || params.status || "").toLowerCase()
    const valId = String(params.val_id || "").trim()
    const tranId = String(params.tran_id || params.ref || "").trim()

    if (valId) {
      const vResult = await validate(creds, valId)
      if (vResult.ok) return vResult
      // Fallback to merchantTransIDvalidationAPI if validationserverAPI was inconclusive/pending
      if (vResult.status === "PENDING" && tranId) {
        const qResult = await validateByTranId(creds, tranId)
        if (qResult.ok) return qResult
      }
      return vResult
    }

    // If val_id was not on the callback but tran_id is available, check via tran_id
    if (tranId) {
      const qResult = await validateByTranId(creds, tranId)
      if (qResult.ok || qResult.status === "FAILED" || qResult.status === "CANCELLED") {
        return qResult
      }
    }

    if (outcome === "fail" || outcome === "failed") {
      return { ok: false, status: "FAILED", providerTxnId: null, amount: null, detail: "gateway reported failure", raw: { outcome } }
    }
    if (outcome === "cancel" || outcome === "cancelled" || outcome === "canceled") {
      return { ok: false, status: "CANCELLED", providerTxnId: null, amount: null, detail: "customer cancelled at the gateway", raw: { outcome } }
    }
    return { ok: false, status: "PENDING", providerTxnId: null, amount: null, detail: "payment verification pending at gateway", raw: { outcome } }
  },

  async handleIpn(body: Record<string, string>): Promise<ProviderVerifyResult> {
    const creds = await requireCreds()
    const valId = String(body.val_id || "").trim()
    const tranId = String(body.tran_id || "").trim()
    const postedStatus = String(body.status || "").toUpperCase()

    if (valId) {
      if (postedStatus !== "VALID" && postedStatus !== "VALIDATED") {
        const result = await validate(creds, valId)
        if (!result.ok) result.detail = `IPN reported ${postedStatus}; validation: ${result.detail || "not valid"}`
        return result
      }
      return validate(creds, valId)
    }

    if (tranId) {
      return validateByTranId(creds, tranId)
    }

    return { ok: false, status: "FAILED", providerTxnId: null, amount: null, detail: "IPN carried neither val_id nor tran_id", raw: { status: postedStatus } }
  },

  async queryPayment(paymentId: string): Promise<ProviderVerifyResult> {
    const creds = await requireCreds()
    return validateByTranId(creds, paymentId)
  },
}

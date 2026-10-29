// ============ Nagad provider (WP-I) — Payment Init API (v3 shape) ============
// Documented Nagad Digital Financial Services "Payment Gateway" flow:
//   INIT     POST {base}/api/dfs/verify/payment/init
//              headers: Account-Number: <merchant mobile account>
//              body: { accountNumber, dateTime: "yyyyMMddHHmmss",
//                      sensitiveData: "<RSA-encrypted JSON>", signature }
//            decrypted sensitiveData:
//              { merchantId, datetime, orderId, challenges, amount, currency,
//                callbackURL }
//            → { statusCode: "000", message, callbackReference }
//   REDIRECT {payBase}/payment/{callbackReference}
//   VERIFY   GET {base}/api/dfs/verify/payment/{orderId}
//              headers: Account-Number, Merchant-Id
//            → { statusCode: "000"|"…", message, orderId, amount, currency,
//                paymentRefId?, … }
//
// Sandbox/live bases:
//   sandbox  https://sandbox.mynagad.com:10084   (redirect: https://sandbox.mynagad.com)
//   live     https://api.mynagad.com             (redirect: https://pay.mynagad.com)
//
// CRYPTO (documented scheme, implemented with node:crypto):
//   sensitiveData = RSA-OAEP(SHA-256) encryption of the sensitive JSON with
//                   NAGAD'S PUBLIC key → base64.
//   signature     = RSA-SHA256 (PKCS#1 v1.5) signature of the base64
//                   sensitiveData string with the MERCHANT PRIVATE key.
//
// CALLBACK SECURITY: the callback (payment_ref_id + status) is never trusted;
// completion is confirmed only through the credential-gated VERIFY API above
// — that is Nagad's documented check (there is no HMAC-style IPN). The
// verify response's orderId is cross-checked against our payment row.
import crypto from "crypto"
import type { PaymentProvider, ProviderInvoice, ProviderSession, ProviderVerifyResult } from "./types"
import { providerFetch, parseAmount, assertBdt, ProviderError } from "./types"
import { getProviderConfig, type NagadCreds } from "./credentials"
import { validateOutboundUrl } from "../../security"

function apiBase(cfg: { mode: string; baseUrlOverride?: string }): string {
  if (cfg.baseUrlOverride) {
    const check = validateOutboundUrl(cfg.baseUrlOverride)
    if (!check.ok) throw new ProviderError(`Nagad baseUrlOverride blocked: ${check.reason}`)
    return cfg.baseUrlOverride.replace(/\/+$/, "")
  }
  return (cfg.mode === "live" ? "https://api.mynagad.com" : "https://sandbox.mynagad.com:10084").replace(/\/+$/, "")
}

function payBase(cfg: { mode: string; baseUrlOverride?: string }): string {
  if (cfg.baseUrlOverride) {
    const check = validateOutboundUrl(cfg.baseUrlOverride)
    if (!check.ok) throw new ProviderError(`Nagad payBase baseUrlOverride blocked: ${check.reason}`)
    return cfg.baseUrlOverride.replace(/\/+$/, "")
  }
  return cfg.mode === "live" ? "https://pay.mynagad.com" : "https://sandbox.mynagad.com"
}

async function requireCreds(): Promise<NagadCreds> {
  const cfg = await getProviderConfig("nagad")
  if (!cfg.enabled || !cfg.configured || !cfg.creds) {
    throw new ProviderError("Nagad online payments are not enabled on this platform. The platform owner must configure the gateway (Owner Console → Payments).")
  }
  const c = cfg.creds as NagadCreds
  if (!c.merchantId || !c.accountNumber || !c.privateKeyPem || !c.publicKeyPem) {
    throw new ProviderError("Nagad credentials are incomplete (merchant id / account number / RSA keys missing).")
  }
  return c
}

/** yyyyMMddHHmmss — Nagad's documented timestamp format. */
function nagadTimestamp(d = new Date()): string {
  const p = (n: number, w = 2) => String(n).padStart(w, "0")
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

/** RSA-OAEP(SHA-256) encrypt with Nagad's public key → base64. */
function encryptSensitive(publicKeyPem: string, sensitive: Record<string, unknown>): string {
  const encrypted = crypto.publicEncrypt(
    {
      key: publicKeyPem,
      padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: "sha256",
    },
    Buffer.from(JSON.stringify(sensitive), "utf8"),
  )
  return encrypted.toString("base64")
}

/** RSA-SHA256 (PKCS#1 v1.5) signature of the base64 sensitiveData with the
 *  merchant private key → base64. */
function signSensitive(privateKeyPem: string, sensitiveDataBase64: string): string {
  const signer = crypto.createSign("RSA-SHA256")
  signer.update(Buffer.from(sensitiveDataBase64, "utf8"))
  return signer.sign(privateKeyPem, "base64")
}

/** Random 30–40 char challenge (documented anti-replay field). */
function challenge(): string {
  return crypto.randomBytes(24).toString("hex").slice(0, 32 + Math.floor(Math.random() * 8))
}

function initPrivateKey(pem: string): crypto.KeyObject {
  try {
    return crypto.createPrivateKey(pem.includes("-----BEGIN") ? pem : `-----BEGIN PRIVATE KEY-----\n${pem}\n-----END PRIVATE KEY-----`)
  } catch {
    throw new ProviderError("The stored Nagad merchant private key is not parseable PEM — the platform owner should re-paste it.")
  }
}
function initPublicKey(pem: string): crypto.KeyObject {
  try {
    return crypto.createPublicKey(pem.includes("-----BEGIN") ? pem : `-----BEGIN PUBLIC KEY-----\n${pem}\n-----END PUBLIC KEY-----`)
  } catch {
    throw new ProviderError("The stored Nagad platform public key is not parseable PEM — the platform owner should re-paste it.")
  }
}

function successCode(code: unknown): boolean {
  const v = String(code ?? "").trim()
  return v === "000" || v === "0000" || v.toLowerCase() === "success"
}

/** Server-side verification of one order — the documented completion check. */
async function verifyOrder(creds: NagadCreds, orderId: string): Promise<ProviderVerifyResult> {
  try {
    const res = await providerFetch(`${apiBase(creds)}/api/dfs/verify/payment/${encodeURIComponent(orderId)}`, {
      method: "GET",
      headers: {
        Accept: "application/json",
        "Account-Number": creds.accountNumber,
        "Merchant-Id": creds.merchantId,
      },
    })
    const j: any = res.json
    if (!j || typeof j !== "object") {
      return { ok: false, status: "PENDING", providerTxnId: null, merchantTxnId: orderId, amount: null, detail: `Nagad verify returned HTTP ${res.status} without JSON` }
    }
    if (successCode(j.statusCode)) {
      return {
        ok: true,
        status: "PAID",
        providerTxnId: String(j.paymentRefId || j.payment_ref_id || orderId),
        merchantTxnId: String(j.orderId || orderId),
        amount: parseAmount(j.amount),
        raw: {
          orderId: j.orderId,
          paymentRefId: j.paymentRefId || j.payment_ref_id,
          amount: j.amount,
          currency: j.currency,
          statusCode: j.statusCode,
          message: j.message,
        },
      }
    }
    const msg = String(j.message || j.statusCode || "unknown")
    const failed = /fail|cancel|expire|invalid|rejected/i.test(msg)
    return {
      ok: false,
      status: failed ? "FAILED" : "PENDING",
      providerTxnId: String(j.paymentRefId || j.payment_ref_id || orderId),
      merchantTxnId: String(j.orderId || orderId),
      amount: parseAmount(j.amount),
      detail: `Nagad statusCode ${String(j.statusCode ?? "?")}: ${msg}`.slice(0, 250),
      raw: { orderId: j.orderId, statusCode: j.statusCode, message: j.message },
    }
  } catch (e: any) {
    return { ok: false, status: "PENDING", providerTxnId: null, merchantTxnId: orderId, amount: null, detail: `Nagad verify call failed: ${String(e?.message || e).slice(0, 200)}` }
  }
}

export const nagadProvider: PaymentProvider = {
  id: "nagad",
  label: "Nagad",

  async createSession(inv: ProviderInvoice): Promise<ProviderSession> {
    assertBdt(inv.currency)
    const creds = await requireCreds()
    // PEM parseability is validated up front so a malformed key surfaces as a
    // clean 400, not a 500 mid-checkout.
    initPrivateKey(creds.privateKeyPem)
    initPublicKey(creds.publicKeyPem)

    const dateTime = nagadTimestamp()
    // Our SaasPayment id doubles as the Nagad orderId so the verify response
    // can be cross-checked against the payment row (merchantTxnId).
    const orderId = inv.paymentId.slice(0, 50)
    const sensitive = {
      merchantId: creds.merchantId,
      datetime: dateTime,
      orderId,
      challenges: challenge(),
      amount: inv.amount.toFixed(2),
      currency: "BDT",
      callbackURL: inv.returnUrl,
    }
    const sensitiveData = encryptSensitive(creds.publicKeyPem, sensitive)
    const signature = signSensitive(creds.privateKeyPem, sensitiveData)

    const res = await providerFetch(`${apiBase(creds)}/api/dfs/verify/payment/init`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "Account-Number": creds.accountNumber,
      },
      body: JSON.stringify({
        accountNumber: creds.accountNumber,
        dateTime,
        sensitiveData,
        signature,
      }),
    })
    const j: any = res.json
    if (!j?.callbackReference) {
      throw new ProviderError(`Nagad could not start the payment session (${String(j?.message || `HTTP ${res.status}`).slice(0, 200)}).`)
    }
    const redirectUrl = `${payBase(creds)}/payment/${encodeURIComponent(String(j.callbackReference))}`
    return { sessionId: String(j.callbackReference), redirectUrl }
  },

  async verifyCallback(params: Record<string, string>): Promise<ProviderVerifyResult> {
    const creds = await requireCreds()
    const orderId = String(params.paymentId || params.orderId || "").trim()
    if (!orderId) {
      return { ok: false, status: "FAILED", providerTxnId: null, amount: null, detail: "callback without an order reference" }
    }
    const outcome = String(params.status || "").toLowerCase()
    if (outcome === "fail" || outcome === "failed") {
      // Even failures are confirmed through the verify API when possible — a
      // forged callback must not be able to flip state by itself.
      const verified = await verifyOrder(creds, orderId)
      if (!verified.ok) verified.detail = `callback reported failure; verify: ${verified.detail || "not completed"}`
      return verified
    }
    return verifyOrder(creds, orderId)
  },

  async handleIpn(body: Record<string, string>): Promise<ProviderVerifyResult> {
    const creds = await requireCreds()
    // Posted payment_ref_id/status fields are never trusted — the documented
    // check is the credential-gated order verification API.
    const orderId = String(body.paymentId || body.orderId || body.merchantInvoiceNumber || "").trim()
    if (!orderId) {
      return { ok: false, status: "FAILED", providerTxnId: null, amount: null, detail: "IPN without an order reference — ignored" }
    }
    return verifyOrder(creds, orderId)
  },
}

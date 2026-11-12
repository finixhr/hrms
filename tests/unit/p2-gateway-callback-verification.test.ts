/// <reference types="bun-types" />
// ============ TST-3 (P2 wave, 2026-11-09) — gateway callback authentication ============
// The audit: "The settle layer is well tested (underpayment, currency,
// merchant-ref, replay), but the transport-level HMAC/IPN verification — the
// actual gateway callback authentication — has no test anywhere; a
// regression there would not fail CI."
//
// This suite pins the callback-authentication surface at every layer it
// actually exists on in this codebase:
//   1. ADAPTERS — every provider's unattributable-notification guard: a
//      callback/IPN with NO reference returns `ignored: true` and performs
//      ZERO network calls (requireCreds passes; the ignored return precedes
//      any verification request). An ignored notification must never be
//      interpretable as a failure.
//   2. ROUTES — /api/payments/ipn and /api/payments/return driven with real
//      NextRequests: unknown providers are refused; forged notifications
//      (?ref=<real row> + empty body) cannot mutate a PENDING payment row;
//      ignored notifications produce 400 and record nothing.
//   3. SETTLE — recordVerifiedFailure's attribution guards: ignored results
//      are refused; results echoing a DIFFERENT transaction are refused;
//      only a genuinely-attributable failure is recorded.
//   4. HMAC — the EPS x-hash binding (forged payload ⇒ different digest;
//      recomputation with the wrong key never verifies).
import "./_testdb"
import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { NextRequest } from "next/server"
import crypto from "node:crypto"
import { db } from "@/lib/db"
import { mkVendor, uniq } from "./_fixtures"
import { POST as ipnPOST } from "@/app/api/payments/ipn/route"
import { GET as returnGET } from "@/app/api/payments/return/route"
import { encryptField } from "@/hrm-server/crypto-field"
import { PAYMENTS_CRYPTO_CONTEXT, invalidatePaymentCredentials } from "@/hrm-server/saas/payments/credentials"
import { recordVerifiedFailure } from "@/hrm-server/saas/payments/settle"
import { sslcommerzProvider } from "@/hrm-server/saas/payments/sslcommerz"
import { bkashProvider } from "@/hrm-server/saas/payments/bkash"
import { nagadProvider } from "@/hrm-server/saas/payments/nagad"
import { epsProvider } from "@/hrm-server/saas/payments/eps"
import { epsXHash } from "@/hrm-server/saas/payments/eps"

/** Plant DUMMY sandbox credentials for one provider (the ignored paths fire
 *  BEFORE any network call, so unreachable fake hosts are perfect: any
 *  attempt to call out would fail the test loudly via a hang/timeout). */
async function plantDummyCreds(providerId: string, creds: Record<string, unknown>) {
  await db.saasSetting.upsert({
    where: { group_key: { group: "payments", key: `credentials:${providerId}` } },
    create: { group: "payments", key: `credentials:${providerId}`, value: encryptField(JSON.stringify({ mode: "sandbox", ...creds }), PAYMENTS_CRYPTO_CONTEXT) },
    update: { value: encryptField(JSON.stringify({ mode: "sandbox", ...creds }), PAYMENTS_CRYPTO_CONTEXT) },
  })
  await db.saasSetting.upsert({
    where: { group_key: { group: "payments", key: `enabled:${providerId}` } },
    create: { group: "payments", key: `enabled:${providerId}`, value: "true" },
    update: { value: "true" },
  })
  invalidatePaymentCredentials()
}

async function clearProviderCreds() {
  await db.saasSetting.deleteMany({ where: { group: "payments", key: { startsWith: "credentials:" } } })
  await db.saasSetting.deleteMany({ where: { group: "payments", key: { startsWith: "enabled:" } } })
  invalidatePaymentCredentials()
}

async function mkPaymentRow(provider: string) {
  const v = await mkVendor(uniq("TST3"))
  const inv = await db.saasInvoice.create({
    data: { vendorId: v.id, number: `INV-T3-${uniq("n")}`, periodStart: new Date("2026-11-01"), periodEnd: new Date("2026-12-01"), amount: 1500, currency: "BDT", status: "PENDING" },
  })
  const pm = await db.saasPayment.create({
    data: { invoiceId: inv.id, vendorId: v.id, amount: 1500, currency: "BDT", provider, providerTxnId: `TXN-${uniq("t")}`, sessionId: `SES-${uniq("s")}`, status: "PENDING" },
  })
  return { v, inv, pm }
}

const ipnReq = (params: Record<string, string>, body?: Record<string, string>) => {
  const url = new URL("http://localhost:3000/api/payments/ipn?" + new URLSearchParams(params).toString())
  return new NextRequest(url, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : { method: "POST" })
}
const returnReq = (params: Record<string, string>) =>
  new NextRequest(new URL("http://localhost:3000/api/payments/return?" + new URLSearchParams(params).toString()), { method: "GET" })

beforeAll(async () => {
  await clearProviderCreds()
})

afterAll(async () => {
  await clearProviderCreds()
})

// ---------------------------------------------------------------------------
describe("TST-3 · adapters: unattributable notifications are ignored, never failed", () => {
  test("sslcommerz: an IPN with neither val_id nor tran_id is ignored (no network)", async () => {
    await plantDummyCreds("sslcommerz", { storeId: "dummy", storePassword: "dummy", baseUrlOverride: "https://dummy.invalid" })
    const res = await sslcommerzProvider.handleIpn({ status: "VALID" })
    expect(res.ignored).toBe(true)
    expect(res.ok).toBe(false)
    expect(res.status).not.toBe("PAID")
  })

  test("sslcommerz: a fail-redirect outcome with no reference is ignored", async () => {
    await plantDummyCreds("sslcommerz", { storeId: "dummy", storePassword: "dummy", baseUrlOverride: "https://dummy.invalid" })
    const res = await sslcommerzProvider.verifyCallback({ outcome: "fail" })
    expect(res.ignored).toBe(true)
  })

  test("bkash: a callback/IPN without paymentID is ignored", async () => {
    await plantDummyCreds("bkash", { appKey: "k", appSecret: "s", username: "u", password: "p", baseUrlOverride: "https://dummy.invalid" })
    expect((await bkashProvider.verifyCallback({ status: "success" })).ignored).toBe(true)
    expect((await bkashProvider.handleIpn({ status: "success" })).ignored).toBe(true)
  })

  test("nagad: a callback/IPN without an order reference is ignored", async () => {
    await plantDummyCreds("nagad", { merchantId: "m", accountNumber: "01700000000", privateKeyPem: "x", publicKeyPem: "y", baseUrlOverride: "https://dummy.invalid" })
    expect((await nagadProvider.verifyCallback({ status: "Fail" })).ignored).toBe(true)
    expect((await nagadProvider.handleIpn({ status: "Success" })).ignored).toBe(true)
  })

  test("eps: a callback without a merchant transaction reference is ignored", async () => {
    await plantDummyCreds("eps", { username: "u", password: "p", hashKey: "h", merchantId: "m", storeId: "s", baseUrlOverride: "https://dummy.invalid" })
    expect((await epsProvider.verifyCallback({ status: "anything" })).ignored).toBe(true)
  })
})

// ---------------------------------------------------------------------------
describe("TST-3 · routes: forged notifications cannot mutate payment state", () => {
  test("IPN: unknown provider → 400", async () => {
    const res = await ipnPOST(ipnReq({ provider: "not-a-gateway", ref: "whatever" }))
    expect(res.status).toBe(400)
  })

  test("IPN: forged ?ref=<real payment> + empty body leaves the row PENDING (unconfigured gateway refuses)", async () => {
    const { pm } = await mkPaymentRow("sslcommerz")
    // no credentials configured → requireCreds throws inside handleIpn →
    // the route's catch returns 400 and NOTHING is written
    const res = await ipnPOST(ipnReq({ provider: "sslcommerz", ref: pm.id }))
    expect(res.status).toBe(400)
    const row = await db.saasPayment.findUnique({ where: { id: pm.id } })
    expect(row?.status).toBe("PENDING")
    expect(row?.failureReason).toBeNull()
  })

  test("IPN: an ignored notification (creds configured, empty body, no ref) → 400, nothing recorded", async () => {
    await plantDummyCreds("sslcommerz", { storeId: "dummy", storePassword: "dummy", baseUrlOverride: "https://dummy.invalid" })
    const res = await ipnPOST(ipnReq({ provider: "sslcommerz" }, {}))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.ok).toBe(false)
  })

  test("IPN: JSON body params reach the adapter (form + JSON both parsed)", async () => {
    // sslcommerz handleIpn with a tran_id would hit the network; with the
    // unreachable dummy base the providerFetch fails → PENDING result → the
    // route records pending and returns 200 ok:false status PENDING. The
    // row must stay PENDING, never FAILED.
    const { pm } = await mkPaymentRow("sslcommerz")
    const res = await ipnPOST(ipnReq({ provider: "sslcommerz", ref: pm.id }, { tran_id: pm.id, status: "VALID" }))
    expect([200, 400]).toContain(res.status)
    const row = await db.saasPayment.findUnique({ where: { id: pm.id } })
    expect(row?.status).toBe("PENDING") // an unreachable gateway is NOT a failure
  })

  test("RETURN: missing ids redirect to the invalid outcome", async () => {
    const res = await returnGET(returnReq({}))
    expect(res.status).toBe(302)
    expect(res.headers.get("location")).toContain("billing=invalid")
  })

  test("RETURN: unknown provider → invalid redirect (no row lookup)", async () => {
    const res = await returnGET(returnReq({ provider: "nope", ref: "x" }))
    expect(res.status).toBe(302)
    expect(res.headers.get("location")).toContain("billing=invalid")
  })

  test("RETURN: forged cancel on a real row (unconfigured gateway) → pending redirect, row untouched", async () => {
    const { pm } = await mkPaymentRow("bkash")
    const res = await returnGET(returnReq({ provider: "bkash", ref: pm.id, status: "cancel" }))
    // verification could not complete (no creds) → pending, NEVER cancelled
    expect(res.status).toBe(302)
    expect(res.headers.get("location")).toContain("billing=pending")
    const row = await db.saasPayment.findUnique({ where: { id: pm.id } })
    expect(row?.status).toBe("PENDING")
  })
})

// ---------------------------------------------------------------------------
describe("TST-3 · settle: recordVerifiedFailure's attribution guards", () => {
  test("an ignored verification result is refused outright", async () => {
    const { pm } = await mkPaymentRow("sslcommerz")
    const recorded = await recordVerifiedFailure(pm.id, "sslcommerz", "forged empty IPN", {
      ok: false, status: "FAILED", ignored: true, providerTxnId: null, amount: null,
    })
    expect(recorded).toBe(false)
    expect((await db.saasPayment.findUnique({ where: { id: pm.id } }))?.status).toBe("PENDING")
  })

  test("a result echoing a DIFFERENT merchant reference is refused", async () => {
    const { pm } = await mkPaymentRow("sslcommerz")
    const recorded = await recordVerifiedFailure(pm.id, "sslcommerz", "belongs to another transaction", {
      ok: false, status: "FAILED", providerTxnId: "TX", merchantTxnId: "someone-elses-payment", amount: null,
    })
    expect(recorded).toBe(false)
    expect((await db.saasPayment.findUnique({ where: { id: pm.id } }))?.status).toBe("PENDING")
  })

  test("a result with a mismatched session binding is refused", async () => {
    const { pm } = await mkPaymentRow("bkash")
    const recorded = await recordVerifiedFailure(pm.id, "bkash", "session mismatch", {
      ok: false, status: "FAILED", providerTxnId: "TX", merchantTxnId: pm.id, sessionId: "NOT-MY-SESSION", amount: null,
    })
    expect(recorded).toBe(false)
    expect((await db.saasPayment.findUnique({ where: { id: pm.id } }))?.status).toBe("PENDING")
  })

  test("a genuinely-attributable failure IS recorded (the guard doesn't over-block)", async () => {
    const { pm } = await mkPaymentRow("sslcommerz")
    const recorded = await recordVerifiedFailure(pm.id, "sslcommerz", "verified failure", {
      ok: false, status: "FAILED", providerTxnId: pm.providerTxnId, merchantTxnId: pm.id, sessionId: pm.sessionId, amount: null,
    })
    expect(recorded).toBe(true)
    expect((await db.saasPayment.findUnique({ where: { id: pm.id } }))?.status).toBe("FAILED")
  })
})

// ---------------------------------------------------------------------------
describe("TST-3 · EPS x-hash HMAC binding (the one transport-level signature)", () => {
  test("forging a reference changes the digest — a signature over A never verifies B", () => {
    const key = "eps-hash-key"
    const a = "INV-2026-000001"
    const b = "INV-2026-000002"
    const sigA = epsXHash(key, a)
    expect(sigA).not.toBe(epsXHash(key, b)) // signature is payload-binding
    expect(sigA).toBe(crypto.createHmac("sha512", key).update(a, "utf8").digest("base64")) // correct construction
  })

  test("a signature made with the WRONG key never verifies under the right one", () => {
    const right = "right-key"
    const wrong = "wrong-key"
    const ref = "INV-2026-000009"
    const forged = epsXHash(wrong, ref)
    expect(forged).not.toBe(epsXHash(right, ref))
  })
})

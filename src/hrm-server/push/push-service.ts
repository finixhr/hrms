// ============ Push dispatch service (Phase 5 P6 WS-C) ============
// The mobile push channel. Subscriptions live in PushSubscription (one row
// per browser/device); the VAPID keypair lives per-vendor in HrSetting group
// "push" (publicKey plain — clients need it to subscribe — privateKey
// ENCRYPTED at rest under the push::v1 context, SEC-13 override HRM_PUSH_KEY).
//
// DISPATCH MODEL — hooked into notify()/notifyMany() (src/hrm-server/audit.ts):
// every in-app notification ALSO pushes to the target user's subscriptions
// (Approval Needed / Request Approved / Rejected / substitute assignments /
// task assignments / punch confirmations … all ride the same rail). Sends
// are fire-and-forget with an in-process tracking set + a cap (backpressure:
// >100 in flight → the newest sends are dropped, the in-app notification
// still landed) and NEVER throw into the caller — a push failure must not
// fail the business action that triggered it.
//
// Cleanup: HTTP 404/410 from a push service = the subscription is gone →
// the row is deleted automatically (the next subscribe re-creates it).
import { db } from "@/lib/db"
import { encryptField, decryptField, fieldKeyConfigured } from "../crypto-field"
import { sendWebPush, generateVapidKeyPair, type SendWebPushResult } from "./web-push"

const PUSH_CONTEXT = "push::v1"
const ENC_PREFIX = "enc::"

export type PushPayload = {
  title: string
  body: string
  /** nav target for notificationclick (the SPA view key) */
  url?: string
  tag?: string
}

// ---------- VAPID key management ----------

export type VapidKeys = { publicKey: string; privateKey: string }

/**
 * The vendor's VAPID keypair — lazily generated on FIRST use and stored in
 * HrSetting group "push": publicKey plain (every client needs it to
 * subscribe), privateKey encrypted at rest under push::v1 (fail-closed: a
 * keyless deployment cannot STORE a private key, so no new keypair is
 * minted until the deployment key exists).
 */
export async function ensureVapidKeys(vendorId: string): Promise<VapidKeys | null> {
  const [pubRow, privRow] = await Promise.all([
    db.hrSetting.findUnique({ where: { vendorId_group_key: { vendorId, group: "push", key: "publicKey" } } }),
    db.hrSetting.findUnique({ where: { vendorId_group_key: { vendorId, group: "push", key: "privateKey" } } }),
  ])
  if (pubRow?.value && privRow?.value) {
    const raw = JSON.parse(privRow.value)
    if (typeof raw === "string" && raw.startsWith(ENC_PREFIX)) {
      try {
        return { publicKey: JSON.parse(pubRow.value), privateKey: decryptField(raw.slice(ENC_PREFIX.length), PUSH_CONTEXT) }
      } catch {
        return null // rotated-away key — fail the push, never mint silently
      }
    }
    // legacy plaintext (never written by this code path, but readable)
    if (typeof raw === "string" && raw) return { publicKey: JSON.parse(pubRow.value), privateKey: raw }
  }
  if (!fieldKeyConfigured()) return null // cannot store the private key securely
  const pair = generateVapidKeyPair()
  await Promise.all([
    db.hrSetting.upsert({
      where: { vendorId_group_key: { vendorId, group: "push", key: "publicKey" } },
      create: { vendorId, group: "push", key: "publicKey", value: JSON.stringify(pair.publicKey) },
      update: { value: JSON.stringify(pair.publicKey) },
    }),
    db.hrSetting.upsert({
      where: { vendorId_group_key: { vendorId, group: "push", key: "privateKey" } },
      create: { vendorId, group: "push", key: "privateKey", value: JSON.stringify(ENC_PREFIX + encryptField(pair.privateKey, PUSH_CONTEXT)) },
      update: { value: JSON.stringify(ENC_PREFIX + encryptField(pair.privateKey, PUSH_CONTEXT)) },
    }),
  ])
  return pair
}

// ---------- dispatch ----------

/** In-flight tracking so tests can await every send; production never waits. */
const inFlight = new Set<Promise<unknown>>()
const MAX_IN_FLIGHT = 100 // backpressure guard — beyond this, sends drop

/** Test hook: resolve when every tracked send has settled. */
export async function __waitForPushSends(): Promise<void> {
  while (inFlight.size) {
    await Promise.allSettled([...inFlight])
  }
}

/** Test hook: observe every outgoing push (endpoint + payload) without
 *  touching the network — set BEFORE calling dispatchers; pass null to
 *  restore the real transport. */
let transportSpy: ((call: { endpoint: string; payload: PushPayload; opts: Record<string, unknown> }) => void) | null = null
let transportOverride: ((payload: string, sub: { endpoint: string; p256dh: string; auth: string }, opts: any) => Promise<SendWebPushResult>) | null = null

export function __setPushTransportForTests(impl: ((payload: string, sub: { endpoint: string; p256dh: string; auth: string }, opts: any) => Promise<SendWebPushResult>) | null): void {
  transportOverride = impl
}
export function __setPushSpyForTests(spy: ((call: { endpoint: string; payload: PushPayload; opts: Record<string, unknown> }) => void) | null): void {
  transportSpy = spy
}

async function deliverOne(sub: { id: string; endpoint: string; p256dh: string; auth: string }, payload: PushPayload, keys: VapidKeys): Promise<void> {
  const wire = JSON.stringify(payload)
  const result = transportOverride
    ? await transportOverride(wire, { endpoint: sub.endpoint, p256dh: sub.p256dh, auth: sub.auth }, { vapidPublicKey: keys.publicKey })
    : await sendWebPush(wire, { endpoint: sub.endpoint, p256dh: sub.p256dh, auth: sub.auth }, {
        vapidPublicKey: keys.publicKey,
        vapidPrivateKey: keys.privateKey,
      })
  if (transportSpy) transportSpy({ endpoint: sub.endpoint, payload, opts: { vapidPublicKey: keys.publicKey } })
  if (result.gone) {
    // the subscription no longer exists at the push service
    await db.pushSubscription.delete({ where: { id: sub.id } }).catch(() => {})
    return
  }
  if (result.ok) {
    await db.pushSubscription.update({
      where: { id: sub.id },
      data: { lastSuccessAt: new Date(), lastError: null, lastErrorAt: null },
    }).catch(() => {})
  } else {
    await db.pushSubscription.update({
      where: { id: sub.id },
      data: { lastError: String(result.error || `HTTP ${result.status}`).slice(0, 300), lastErrorAt: new Date() },
    }).catch(() => {})
  }
}

/**
 * Fire-and-forget push to every subscription of one user. Returns
 * immediately; failures update the subscription row and NEVER propagate.
 */
export function queuePushToUser(vendorId: string, userId: string | null | undefined, payload: PushPayload): void {
  if (!userId) return
  if (inFlight.size >= MAX_IN_FLIGHT) return // backpressure: in-app notification already landed
  const task = (async () => {
    try {
      const keys = await ensureVapidKeys(vendorId)
      if (!keys) return // no deployment key / rotated-away — push disabled
      const subs = await db.pushSubscription.findMany({
        where: { vendorId, userId },
        select: { id: true, endpoint: true, p256dh: true, auth: true },
      })
      for (const sub of subs) {
        await deliverOne(sub, payload, keys)
      }
    } catch {
      /* never throw into the caller — push is best-effort */
    }
  })()
  inFlight.add(task)
  void task.finally(() => inFlight.delete(task))
}

/**
 * Audited test send ("Does push work on this device?") — SYNCHRONOUS result
 * so the UI can report what actually happened.
 */
export async function sendTestPush(vendorId: string, userId: string): Promise<{ sent: number; results: SendWebPushResult[] }> {
  const keys = await ensureVapidKeys(vendorId)
  if (!keys) throw new Error("Push is not configured on this deployment (set HRM_MFA_KEY or HRM_PUSH_KEY, then retry)")
  const subs = await db.pushSubscription.findMany({
    where: { vendorId, userId },
    select: { id: true, endpoint: true, p256dh: true, auth: true },
  })
  const results: SendWebPushResult[] = []
  for (const sub of subs) {
    const r = transportOverride
      ? await transportOverride(JSON.stringify({ title: "Finix HR — test push", body: "Push notifications are working.", tag: "push-test" }), { endpoint: sub.endpoint, p256dh: sub.p256dh, auth: sub.auth }, { vapidPublicKey: keys.publicKey })
      : await sendWebPush(JSON.stringify({ title: "Finix HR — test push", body: "Push notifications are working.", tag: "push-test" }), { endpoint: sub.endpoint, p256dh: sub.p256dh, auth: sub.auth }, { vapidPublicKey: keys.publicKey, vapidPrivateKey: keys.privateKey })
    results.push(r)
    if (r.gone) await db.pushSubscription.delete({ where: { id: sub.id } }).catch(() => {})
    else if (r.ok) await db.pushSubscription.update({ where: { id: sub.id }, data: { lastSuccessAt: new Date() } }).catch(() => {})
  }
  return { sent: results.filter((r) => r.ok).length, results }
}

// ---------- subscription registration (shared by the RPC + v1 REST paths) ----------

export async function registerPushSubscription(vendorId: string, userId: string, input: {
  endpoint: string
  p256dh: string
  auth: string
  platform?: string
}): Promise<{ id: string; endpoint: string }> {
  if (!input?.endpoint || !/^https?:\/\//.test(input.endpoint)) throw new Error("A valid push endpoint URL is required")
  if (!input.p256dh || !input.auth) throw new Error("The subscription keys (p256dh, auth) are required")
  // lazy-generate + store the VAPID keypair on first subscribe (also the
  // gate: a keyless deployment cannot register — push stays off)
  const keys = await ensureVapidKeys(vendorId)
  if (!keys) throw new Error("Push is not configured on this deployment (set HRM_MFA_KEY or HRM_PUSH_KEY, then retry)")
  const rec = await db.pushSubscription.upsert({
    where: { endpoint: input.endpoint },
    create: { vendorId, userId, endpoint: input.endpoint, p256dh: input.p256dh, auth: input.auth, platform: input.platform || "web" },
    update: { vendorId, userId, p256dh: input.p256dh, auth: input.auth, platform: input.platform || "web", lastError: null, lastErrorAt: null },
  })
  return { id: rec.id, endpoint: rec.endpoint }
}

export async function listPushSubscriptions(vendorId: string, userId: string) {
  return db.pushSubscription.findMany({
    where: { vendorId, userId },
    select: { id: true, endpoint: true, platform: true, lastSuccessAt: true, lastErrorAt: true, lastError: true, createdAt: true },
    orderBy: { createdAt: "desc" },
  })
}

export async function removePushSubscription(vendorId: string, userId: string, idOrEndpoint: string): Promise<boolean> {
  // ownership is enforced by the vendorId+userId in the where — a user can
  // never delete another user's subscription
  const where = /^https?:\/\//.test(idOrEndpoint)
    ? { endpoint: idOrEndpoint }
    : { id: idOrEndpoint }
  const rec = await db.pushSubscription.findFirst({ where: { ...where, vendorId, userId } })
  if (!rec) return false
  await db.pushSubscription.delete({ where: { id: rec.id } })
  return true
}

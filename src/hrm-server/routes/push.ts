// ============ Web Push RPC routes (Phase 5 P6 WS-C) ============
// The client-facing surface of the push rail:
//   push.publicKey   — the vendor's VAPID public key (lazy-generates the
//                     keypair on first call — the subscribe flow needs it)
//   push.subscribe   — register THIS user's browser/device subscription
//   push.list        — this user's registered subscriptions
//   push.unsubscribe — remove one of THIS user's subscriptions
//   push.test        — audited test push to this user's devices
//
// All five are INTENTIONALLY_SELF_SCOPED (M-02): no module permission gates
// them because they operate exclusively on the CALLER'S OWN subscriptions —
// the handlers enforce vendorId + userId ownership on every read/write, so
// one user can never see or delete another user's devices. Push is a user
// convenience channel, not tenant data.
import { route } from "./registry"
import { z } from "zod"
import { audit } from "../audit"
import {
  ensureVapidKeys, registerPushSubscription, listPushSubscriptions,
  removePushSubscription, sendTestPush,
} from "../push/push-service"

// INTENTIONALLY_SELF_SCOPED (M-02): any authenticated user may read the
// vendor's PUBLIC VAPID key — it is the value every browser needs to create
// a push subscription, and it is public by design (RFC 8292). No tenant data.
route("push.publicKey", {
  handler: async (ctx) => {
    const keys = await ensureVapidKeys(ctx.vendorId)
    if (!keys) return { enabled: false, publicKey: null }
    return { enabled: true, publicKey: keys.publicKey }
  },
})

// INTENTIONALLY_SELF_SCOPED (M-02): registers the CALLER's own device —
// ownership (vendorId + ctx.userId) is forced server-side, a user can never
// register a subscription onto another account.
route("push.subscribe", {
  schema: z.object({
    endpoint: z.string().url().max(2048),
    keys: z.object({
      p256dh: z.string().min(1).max(512),
      auth: z.string().min(1).max(256),
    }),
    platform: z.enum(["web", "pwa", "other"]).optional(),
  }).strict(),
  handler: async (ctx, p) => {
    const rec = await registerPushSubscription(ctx.vendorId, ctx.userId, {
      endpoint: p.endpoint,
      p256dh: p.keys.p256dh,
      auth: p.keys.auth,
      platform: p.platform,
    })
    await audit(ctx, "push.subscribe", "PushSubscription", rec.id, `Registered a push ${p.platform || "web"} device (${new URL(p.endpoint).host})`)
    return rec
  },
})

// INTENTIONALLY_SELF_SCOPED (M-02): the caller's own devices only — the
// where-clause carries vendorId + ctx.userId.
route("push.list", {
  handler: async (ctx) => {
    return { items: await listPushSubscriptions(ctx.vendorId, ctx.userId) }
  },
})

// INTENTIONALLY_SELF_SCOPED (M-02): removes one of the CALLER's own
// subscriptions — ownership is enforced in the service where-clause.
route("push.unsubscribe", {
  schema: z.object({ id: z.string().min(1).max(120).optional(), endpoint: z.string().url().max(2048).optional() }).refine(
    (v) => v.id || v.endpoint, { message: "A subscription id or endpoint is required" },
  ),
  handler: async (ctx, p) => {
    const removed = await removePushSubscription(ctx.vendorId, ctx.userId, String(p.id || p.endpoint))
    if (!removed) return { removed: false }
    return { removed: true }
  },
})

// INTENTIONALLY_SELF_SCOPED (M-02): sends a test push to the CALLER's own
// devices — audited so the trail shows who verified which device.
route("push.test", {
  handler: async (ctx) => {
    const result = await sendTestPush(ctx.vendorId, ctx.userId)
    await audit(ctx, "push.test", "PushSubscription", null, `Sent a test push to ${result.sent} device(s)`)
    return result
  },
})

// ---- Phase 3 — Mobile device token registration (Expo/FCM/APNs) ----
import { db } from "@/lib/db"
import { Deny } from "../rbac"

  // INTENTIONALLY_SELF_SCOPED (M-02): registers the caller's own mobile device
route("push.registerDevice", {
  schema: z.object({
    token: z.string().min(10).max(512),
    platform: z.enum(["expo", "fcm", "apns"]).default("expo"),
    deviceName: z.string().max(100).optional(),
    appVersion: z.string().max(50).optional(),
  }),
  handler: async (ctx, p) => {
    if (!ctx.userId) throw new Deny("Authentication required", 401)
    await db.deviceToken.upsert({
      where: { userId_token: { userId: ctx.userId, token: p.token } },
      create: {
        vendorId: ctx.vendorId,
        userId: ctx.userId,
        platform: p.platform,
        token: p.token,
        deviceName: p.deviceName || null,
        appVersion: p.appVersion || null,
      },
      update: {
        platform: p.platform,
        deviceName: p.deviceName || null,
        appVersion: p.appVersion || null,
        updatedAt: new Date(),
      },
    })
    return { registered: true }
  },
})

  // INTENTIONALLY_SELF_SCOPED (M-02): removes the caller's own device token
route("push.unregisterDevice", {
  schema: z.object({
    token: z.string().min(10).max(512),
  }),
  handler: async (ctx, p) => {
    if (!ctx.userId) throw new Deny("Authentication required", 401)
    await db.deviceToken.deleteMany({ where: { userId: ctx.userId, token: p.token } })
    return { unregistered: true }
  },
})

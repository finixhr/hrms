// ============ /api/v1/push/subscriptions — public REST API (push:write) ======
// Phase 5 P6 (WS-C) — the mobile/PWA push-subscription surface:
//   GET    — list the authenticated user's registered devices
//   POST   — register this device { endpoint, keys: { p256dh, auth }, platform? }
//   DELETE — handled at /api/v1/push/subscriptions/{id} (or ?endpoint=)
//
// Auth: the SAME machinery as every v1 route (API key or OAuth-style user
// token). The subscription OWNER is the authenticated user (token user, or
// the API key's creator) — ownership is enforced on every read/write, and a
// caller can only ever see or delete THEIR OWN devices.
import { NextRequest } from "next/server"
import { z } from "zod"
import { authenticateRequest, apiOk, apiErr, readJsonBody, zodFail, auditApiRequest } from "../../_auth"
import { registerPushSubscription, listPushSubscriptions } from "@/hrm-server/push/push-service"

export const dynamic = "force-dynamic"

const createSchema = z.object({
  endpoint: z.string().url().max(2048),
  keys: z.object({
    p256dh: z.string().min(1).max(512),
    auth: z.string().min(1).max(256),
  }),
  platform: z.enum(["web", "pwa", "other"]).optional(),
}).strict()

function ownerOf(key: { createdById: string | null }): string | null {
  return key.createdById
}

export async function GET(req: NextRequest) {
  const auth = await authenticateRequest(req, "push:write")
  if (!auth.ok) return auth.res
  const { key, ip } = auth
  const ownerId = ownerOf(key)
  if (!ownerId) return apiErr(403, "SCOPE_MISSING", "This API key has no owning user — push subscriptions require a user token")
  const items = await listPushSubscriptions(key.vendorId, ownerId)
  await auditApiRequest(key, ip, "Employee", null, `GET /api/v1/push/subscriptions (${items.length} device(s))`)
  return apiOk(
    items.map((s) => ({
      id: s.id,
      endpoint: s.endpoint,
      platform: s.platform,
      lastSuccessAt: s.lastSuccessAt,
      lastErrorAt: s.lastErrorAt,
      createdAt: s.createdAt,
    })),
    { count: items.length },
  )
}

export async function POST(req: NextRequest) {
  const auth = await authenticateRequest(req, "push:write")
  if (!auth.ok) return auth.res
  const { key, ip } = auth
  const ownerId = ownerOf(key)
  if (!ownerId) return apiErr(403, "SCOPE_MISSING", "This API key has no owning user — push subscriptions require a user token")

  const body = await readJsonBody(req)
  if (!body.ok) return body.res
  const parsed = createSchema.safeParse(body.body)
  if (!parsed.success) return zodFail(parsed.error.issues)
  const p = parsed.data

  try {
    const rec = await registerPushSubscription(key.vendorId, ownerId, {
      endpoint: p.endpoint,
      p256dh: p.keys.p256dh,
      auth: p.keys.auth,
      platform: p.platform,
    })
    await auditApiRequest(key, ip, "Employee", rec.id, `POST /api/v1/push/subscriptions — registered a ${p.platform || "web"} push device`)
    return apiOk({ id: rec.id, endpoint: rec.endpoint }, { registered: true })
  } catch (e: any) {
    return apiErr(400, "VALIDATION", e?.message || "The push subscription could not be registered")
  }
}

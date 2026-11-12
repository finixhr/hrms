// ============ DELETE /api/v1/push/subscriptions/{id} — public REST API ======
// Phase 5 P6 (WS-C) — remove one of the authenticated user's OWN push
// subscriptions (by row id, or by endpoint URL when the client only kept
// the subscription object). Ownership is enforced in the service where
// (id|endpoint, vendorId, userId) — another user's device is never visible
// and never deletable (404, not 403, to avoid enumeration).
import { NextRequest } from "next/server"
import { authenticateRequest, apiOk, apiErr, auditApiRequest } from "../../../_auth"
import { removePushSubscription } from "@/hrm-server/push/push-service"

export const dynamic = "force-dynamic"

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticateRequest(req, "push:write")
  if (!auth.ok) return auth.res
  const { key, ip } = auth
  const ownerId = key.createdById
  if (!ownerId) return apiErr(403, "SCOPE_MISSING", "This API key has no owning user — push subscriptions require a user token")

  const { id } = await params
  const target = decodeURIComponent(id || "")
  if (!target) return apiErr(400, "VALIDATION", "A subscription id or endpoint is required")

  const removed = await removePushSubscription(key.vendorId, ownerId, target)
  if (!removed) return apiErr(404, "NOT_FOUND", "No such push subscription for this user")
  await auditApiRequest(key, ip, "Employee", null, `DELETE /api/v1/push/subscriptions — removed a push device`)
  return apiOk({ removed: true })
}

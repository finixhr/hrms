// ============ Expo Mobile Push (Phase 3) ============
// Delivers notifications to Expo-managed mobile apps (Android via FCM,
// iOS via APNs). Uses the Expo Push API which handles both platforms
// transparently — no per-platform credentials required on this server.
//
// Server sends to: https://exp.host/--/api/v2/push/send
// Mobile app registers its ExponentPushToken via push.registerDevice RPC.

import { db } from "@/lib/db"
import { validateOutboundUrl } from "../security"

const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send"

export interface MobilePushMessage {
  title: string
  body: string
  data?: Record<string, unknown>
  badge?: number
  sound?: "default" | null
}

export interface MobilePushResult {
  sent: number
  failed: number
  errors: string[]
  /** Tokens confirmed invalid by Expo — should be deleted from DeviceToken table */
  invalidTokens: string[]
}

/**
 * Send a push notification to all registered mobile devices for a user.
 * Called by the notification delivery pipeline (audit.ts notifyChannels).
 */
export async function sendMobilePushToUser(
  vendorId: string,
  userId: string,
  message: MobilePushMessage
): Promise<MobilePushResult> {
  const devices = await db.deviceToken.findMany({
    where: { vendorId, userId },
    select: { token: true, platform: true },
  })
  if (!devices.length) return { sent: 0, failed: 0, errors: [], invalidTokens: [] }
  return sendMobilePushToTokens(
    devices.map((d) => ({ token: d.token, platform: d.platform })),
    message
  )
}

/**
 * Send to an explicit list of tokens. Batches all Expo-format tokens in a
 * single API call (up to 100 per request, per Expo docs).
 */
export async function sendMobilePushToTokens(
  tokens: Array<{ token: string; platform: string }>,
  message: MobilePushMessage
): Promise<MobilePushResult> {
  // only Expo tokens for now (FCM/APNs direct require provider credentials)
  const expoTokens = tokens.filter(
    (t) => t.platform === "expo" || t.token.startsWith("ExponentPushToken")
  )
  if (!expoTokens.length) return { sent: 0, failed: 0, errors: [], invalidTokens: [] }

  const urlCheck = validateOutboundUrl(EXPO_PUSH_URL)
  if (!urlCheck.ok) {
    return { sent: 0, failed: expoTokens.length, errors: [`Expo push URL blocked: ${urlCheck.reason}`], invalidTokens: [] }
  }

  const BATCH = 100
  let sent = 0
  let failed = 0
  const errors: string[] = []
  const invalidTokens: string[] = []

  for (let i = 0; i < expoTokens.length; i += BATCH) {
    const batch = expoTokens.slice(i, i + BATCH)
    const messages = batch.map((t) => ({
      to: t.token,
      title: message.title,
      body: message.body,
      data: message.data || {},
      sound: message.sound ?? "default",
      badge: message.badge,
    }))

    try {
      const res = await fetch(EXPO_PUSH_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(messages),
        signal: AbortSignal.timeout(15_000),
      })
      if (!res.ok) {
        const text = await res.text().catch(() => "")
        failed += batch.length
        errors.push(`Expo API HTTP ${res.status}: ${text.slice(0, 200)}`)
        continue
      }
      const json = (await res.json()) as { data?: Array<{ status: string; message?: string; details?: { error?: string } }> }
      for (let j = 0; j < (json.data || []).length; j++) {
        const result = (json.data || [])[j]
        if (result.status === "ok") {
          sent++
        } else {
          failed++
          const errMsg = result.message || result.details?.error || "unknown"
          errors.push(errMsg)
          // DeviceNotRegistered — stale token, remove from DB
          if (result.details?.error === "DeviceNotRegistered" && batch[j]) {
            invalidTokens.push(batch[j].token)
          }
        }
      }
    } catch (e: any) {
      failed += batch.length
      errors.push(e?.message || "Push delivery error")
    }
  }

  // clean up invalid tokens automatically
  if (invalidTokens.length > 0) {
    await db.deviceToken.deleteMany({ where: { token: { in: invalidTokens } } }).catch(() => {})
  }

  return { sent, failed, errors, invalidTokens }
}

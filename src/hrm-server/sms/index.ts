// ============ SMS registry + shared send pipeline (Wave 10 / Phase 6) ============
// Both session planes funnel through THIS module:
//   resolveSmsProvider(cfg) → adapter (sslwireless | generichttp | none)
//   sendSmsViaProvider(...) → normalize → journal → adapter → journal outcome
//
// Bounded retry discipline (master prompt §6.4): OTP messages are NEVER
// retried (duplicate messages cost real money and can race the verify
// endpoint); non-OTP sends get ONE bounded retry on transient network
// errors only (timeout / ECONNRESET / 5xx), never on provider rejections.
import type { SmsSendConfig, SmsSendResult, SmsProvider } from "./types"
import { normalizeBdPhone } from "./types"
import { sslwirelessProvider } from "./sslwireless"
import { genericHttpProvider } from "./generic-http"
import { journalSmsStart, journalSmsOutcome, type SmsJournalPurpose } from "./journal"

const REGISTRY: Record<string, SmsProvider> = {
  [sslwirelessProvider.id]: sslwirelessProvider,
  [genericHttpProvider.id]: genericHttpProvider,
}

export const SMS_PROVIDER_IDS = Object.keys(REGISTRY)
export const SMS_PROVIDER_LABELS: Record<string, string> = Object.fromEntries(
  Object.values(REGISTRY).map((p) => [p.id, p.label]),
)

export function getSmsProvider(id: string): SmsProvider | null {
  return REGISTRY[String(id || "").toLowerCase()] || null
}

/** Resolve the adapter for a configuration: an explicit provider wins when
 *  its credentials are complete; otherwise fall back to the generic URL
 *  template (historic behavior); when nothing is configured → null (SKIP). */
export function resolveSmsProvider(cfg: SmsSendConfig): SmsProvider | null {
  const explicit = getSmsProvider(cfg.provider)
  if (explicit && explicit.id !== genericHttpProvider.id && explicit.configured(cfg)) {
    return explicit
  }
  if (genericHttpProvider.configured(cfg)) return genericHttpProvider
  if (explicit && explicit.configured(cfg)) return explicit
  return null
}

const TRANSIENT_HINTS = ["timeout", "timed out", "ECONNRESET", "ECONNREFUSED", "EAI_AGAIN", "socket hang up", "fetch failed"]

function isTransient(detail?: string): boolean {
  const d = String(detail || "").toLowerCase()
  return TRANSIENT_HINTS.some((h) => d.includes(h.toLowerCase())) || /HTTP 5\d\d/.test(d)
}

export type SendJournaledSmsInput = {
  plane: "TENANT" | "PLATFORM"
  vendorId?: string | null
  toPhone: string
  message: string
  purpose: SmsJournalPurpose
  templateKey?: string | null
  cfg: SmsSendConfig
}

/** Shared pipeline used by both planes: normalize → journal → send →
 *  (bounded non-OTP retry) → journal outcome. Never throws. */
export async function sendSmsJournaled(input: SendJournaledSmsInput): Promise<SmsSendResult> {
  const phone = normalizeBdPhone(input.toPhone)
  if (!phone) return { status: "SKIPPED", detail: "no phone number on file" }

  const provider = resolveSmsProvider(input.cfg)
  if (!provider) {
    return { status: "SKIPPED", detail: "SMS gateway not configured" }
  }

  const message = input.message.length > 1000 ? input.message.slice(0, 997) + "..." : input.message
  const journalId = await journalSmsStart({
    plane: input.plane,
    vendorId: input.vendorId,
    toPhone: phone,
    purpose: input.purpose,
    templateKey: input.templateKey,
    body: message,
    provider: provider.id,
  })

  let result = await provider.send(phone, message, input.cfg)
  // bounded retry — OTP purposes are exempt (cost + verify races)
  if (result.status === "FAILED" && !input.purpose.startsWith("OTP") && isTransient(result.detail)) {
    await new Promise((r) => setTimeout(r, 1_500))
    result = await provider.send(phone, message, input.cfg)
  }

  await journalSmsOutcome(journalId, result)
  return result
}

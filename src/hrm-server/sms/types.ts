// ============ Wave 10 (2026-10-24) — SMS provider abstraction (Phase 6) ============
// One interface over Bangladesh SMS providers. Provider-specific logic lives
// INSIDE adapters (never scattered through HR modules); both session planes
// (tenant gateway.ts, platform saas/notify.ts) resolve a provider from their
// own configuration and share the same journaling + normalization pipeline.
//
// Credentials stay in the EXISTING settings stores (HrSetting group for the
// tenant plane, SaaSSetting group "gateway" for the platform plane) — the
// masked-read / empty-string-keeps-existing discipline already lives there.
// No secret is ever journaled or audited.
//
// Delivery reports: SSLWireless exposes them through its merchant portal and
// arranged DLR callbacks, not a public re-query endpoint in the official v3
// spec — the adapter therefore records the provider's sms_id
// (providerMessageId) for reconciliation instead of inventing a status API
// (no-fake-integrations rule). Delivery-state callbacks can be added later
// behind this same interface.

export type SmsSendStatus = "SENT" | "FAILED" | "SKIPPED"

export type SmsSendResult = {
  status: SmsSendStatus
  detail?: string
  /** Provider submission/delivery reference (SSLWireless sms_id) — the
   *  reconciliation key stored in the SaasSmsMessage journal. */
  providerMessageId?: string | null
}

/** Normalized provider-agnostic send configuration, derived by each plane
 *  from its own settings store. */
export type SmsSendConfig = {
  /** Adapter id ("sslwireless" | "generichttp" | "none"). */
  provider: string
  /** API token / key (secret). */
  apiKey: string
  /** Sender ID / SID (SSLWireless sid; generic template {sender}). */
  senderId: string
  /** Generic template URL ({phone} {message} {sender} {apiKey}); empty when
   *  a structured adapter (sslwireless) is selected. */
  apiUrl: string
  /** GET | POST for the generic adapter. */
  method: "GET" | "POST"
}

export interface SmsProvider {
  id: string
  label: string
  /** True when the configuration carries everything this provider needs. */
  configured(cfg: SmsSendConfig): boolean
  /** Submit one message. NEVER throws — failures map to FAILED results. */
  send(to: string, message: string, cfg: SmsSendConfig): Promise<SmsSendResult>
}

/** Normalize BD phone numbers to the canonical +880… form (shared by both
 *  planes today; kept here so every adapter sees the same shape). */
export function normalizeBdPhone(raw: string): string {
  let phone = String(raw || "").trim().replace(/[^\d+]/g, "")
  if (/^01\d{9}$/.test(phone)) phone = `+880${phone.slice(1)}`
  return phone
}

/** SSLWireless expects msisdn WITHOUT the leading plus (8801XXXXXXXXX). */
export function msisdnForSslwireless(normalizedPhone: string): string {
  return normalizedPhone.replace(/^\+/, "")
}

// ============ SSLWireless adapter (Wave 10 / Phase 6) ============
// Official "iSMS Plus" Push SMS Connectivity API v3.0.0 (SSL Wireless /
// Software Shop Limited, Dhaka) as implemented by their own first-party
// WooCommerce plugin (github.com/prabalsslw/SSL-Wireless-SMS-Notification):
//
//   POST https://smsplus.sslwireless.com/api/v3/send-sms
//   Content-Type: application/json
//   {
//     "api_token": "<merchant API token>",
//     "sid":       "<registered sender id>",
//     "msisdn":    "8801XXXXXXXXX",
//     "sms":       "<message text>",
//     "csms_id":   "<our unique id per message>"
//   }
//
//   Success response (documented shape, v3.0.0 §4.1):
//   { "status": "SUCCESS", "status_code": 200, "error_message": null,
//     "sms_info": [{ "sms_id": "…", "msisdn": "…", "csms_id": "…",
//                    "sms_status": "SUCCESS" }] }
//
//   API status codes (v3.0.0 §3.1) — 200 success; 40xx family = auth /
//   parameter rejections (wrong api_token, invalid msisdn/sms, wrong sid…).
//
// Legacy iSMS (user/pass pushapi) is intentionally NOT implemented here —
// it is plain-HTTP, deprecated by SSL Wireless themselves, and superseded
// by the tokenized v3 API. Deployments still on the legacy gateway keep
// working through the generic-http adapter.
//
// Credentials map onto the EXISTING settings vocabulary:
//   apiKey   → api_token      senderId → sid
import crypto from "crypto"
import type { SmsProvider, SmsSendConfig, SmsSendResult } from "./types"
import { msisdnForSslwireless } from "./types"

const DEFAULT_BASE = "https://smsplus.sslwireless.com"
const SEND_TIMEOUT_MS = 15_000

/** One csms_id per message (the provider's idempotency/dedupe key). */
function newCsmsId(): string {
  return `fx${Date.now().toString(36)}${crypto.randomBytes(6).toString("hex")}`
}

function base(cfg: SmsSendConfig): string {
  // baseUrl override rides apiUrl for deployments with a regional mirror —
  // when provider=sslwireless the apiUrl field is repurposed as the base URL.
  const override = (cfg.apiUrl || "").trim()
  return (override || DEFAULT_BASE).replace(/\/+$/, "")
}

export const sslwirelessProvider: SmsProvider = {
  id: "sslwireless",
  label: "SSLWireless (iSMS Plus v3)",

  configured(cfg) {
    return !!(cfg.apiKey && cfg.senderId)
  },

  async send(to, message, cfg): Promise<SmsSendResult> {
    const msisdn = msisdnForSslwireless(to)
    if (!/^8801\d{9}$/.test(msisdn)) {
      return { status: "SKIPPED", detail: `not a valid BD mobile number (${msisdn || "empty"})` }
    }
    const csmsId = newCsmsId()
    try {
      const res = await fetch(`${base(cfg)}/api/v3/send-sms`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          api_token: cfg.apiKey,
          sid: cfg.senderId,
          msisdn,
          sms: message.length > 1000 ? message.slice(0, 997) + "..." : message,
          csms_id: csmsId,
        }),
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      })
      let json: any = null
      try {
        json = await res.json()
      } catch {
        json = null
      }
      if (!json || typeof json !== "object") {
        return { status: "FAILED", detail: `HTTP ${res.status} without JSON` }
      }
      const statusCode = Number(json.status_code)
      const info = Array.isArray(json.sms_info) ? json.sms_info[0] : null
      if (statusCode === 200 && String(json.status || "").toUpperCase() === "SUCCESS") {
        return {
          status: "SENT",
          detail: `status_code ${statusCode}`,
          providerMessageId: String(info?.sms_id || csmsId),
        }
      }
      // Provider-side rejection — surface the documented error field only.
      return {
        status: "FAILED",
        detail: `status_code ${statusCode}${json.error_message ? `: ${String(json.error_message).slice(0, 120)}` : ""}`,
      }
    } catch (e: any) {
      return { status: "FAILED", detail: String(e?.message || e).slice(0, 160) }
    }
  },
}

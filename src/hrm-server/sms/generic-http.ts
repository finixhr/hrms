// ============ Generic HTTP template adapter (Wave 10 / Phase 6) ============
// Extracted VERBATIM from the historic sendSms()/sendPlatformSms() logic so
// existing deployments behave byte-for-byte identically: an admin-supplied
// URL with {phone} {message} {sender} {apiKey} placeholders, GET or POST,
// with the same save-time + send-time SSRF guards (validateOutboundUrl +
// DNS re-check) and the same Authorization: Bearer header convention.
import type { SmsProvider, SmsSendResult } from "./types"
import { validateOutboundUrl } from "../security"

const trim = (s: unknown) => (typeof s === "string" ? s.trim() : "")

export const genericHttpProvider: SmsProvider = {
  id: "generichttp",
  label: "Generic HTTP gateway (URL template)",

  configured(cfg) {
    return !!(cfg.apiUrl && trim(cfg.apiUrl))
  },

  async send(to, message, cfg): Promise<SmsSendResult> {
    try {
      const url = trim(cfg.apiUrl)
        .replace(/\{phone\}/g, encodeURIComponent(to))
        .replace(/\{message\}/g, encodeURIComponent(message))
        .replace(/\{sender\}/g, encodeURIComponent(trim(cfg.senderId)))
        .replace(/\{apiKey\}/g, encodeURIComponent(trim(cfg.apiKey)))
      const check = validateOutboundUrl(url)
      if (!check.ok) {
        return { status: "FAILED", detail: `Blocked gateway URL: ${check.reason}` }
      }
      // Defense in depth: re-check the resolved hostname of the final URL
      try {
        const dns = await import("dns").then((m) => m.promises)
        const addr = await dns.lookup(check.url.hostname).then((r) => r.address).catch(() => null)
        if (addr) {
          const isV4Private = (a: string) => {
            const m = a.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/)
            if (!m) return false
            const [x, y] = m.slice(1).map(Number)
            if (x === 10 || x === 127 || x === 0 || x >= 224) return true
            if (x === 192 && y === 168) return true
            if (x === 172 && y >= 16 && y <= 31) return true
            if (x === 169 && y === 254) return true
            return false
          }
          if (isV4Private(addr) || addr === "::1" || check.url.hostname === "localhost") {
            return { status: "FAILED", detail: "gateway host resolves to a private/internal address" }
          }
        }
      } catch { /* DNS unavailable — syntactic checks already applied */ }
      const method = cfg.method === "GET" ? "GET" : "POST"
      const res = method === "GET"
        ? await fetch(url, { headers: trim(cfg.apiKey) ? { Authorization: `Bearer ${trim(cfg.apiKey)}` } : {} })
        : await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json", ...(trim(cfg.apiKey) ? { Authorization: `Bearer ${trim(cfg.apiKey)}` } : {}) },
            body: JSON.stringify({ to, message, from: trim(cfg.senderId) || undefined, sender: trim(cfg.senderId) || undefined }),
          })
      if (!res.ok) return { status: "FAILED", detail: `HTTP ${res.status}`.slice(0, 120) }
      return { status: "SENT", detail: `HTTP ${res.status}` }
    } catch (err: any) {
      return { status: "FAILED", detail: String(err?.message || err).slice(0, 120) }
    }
  },
}

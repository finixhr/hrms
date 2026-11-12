// ============ Generic HTTP template adapter (Wave 10 / Phase 6) ============
// Extracted VERBATIM from the historic sendSms()/sendPlatformSms() logic so
// existing deployments behave byte-for-byte identically: an admin-supplied
// URL with {phone} {message} {sender} {apiKey} placeholders, GET or POST,
// with the same save-time + send-time SSRF guards and the same
// Authorization: Bearer header convention.
//
// AUDIT M-10 (2026-11-07) — the send-time guard was check-then-fetch and
// IPv4-centric: it resolved only the FIRST dns.lookup address, tested IPv4
// and "::1" only (fc00::/7, fe80::/10 and IPv4-mapped IPv6 passed), and then
// handed the ORIGINAL url to fetch(), which re-resolved the name — the
// DNS-rebinding window (internal.attacker.rebind alternating 1.2.3.4 /
// 127.0.0.1 answers passed the check on the public answer and connected on
// the loopback one). The send now rides the SAME guard the webhook module
// documents (security.ts): resolveOutboundUrl (ALL A/AAAA records, ANY
// private address rejects — full v4+v6 blocklist incl. CGNAT, ULA,
// link-local, mapped and documentation ranges) + pinnedFetch (the TCP
// connect resolves through the VALIDATED address list only, never through
// DNS again) + redirects refused (a 3xx Location chosen by the endpoint
// would re-open the SSRF surface the guard just closed).
import type { SmsProvider, SmsSendResult } from "./types"
import { pinnedFetch, redirectRefusal, resolveOutboundUrl } from "../security"

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
      // AUDIT M-10 — resolve-ALL + any-private reject + PINNED connection
      // (the why lives with the shared guard in security.ts)
      const check = await resolveOutboundUrl(url)
      if (!check.ok) {
        return { status: "FAILED", detail: `Blocked gateway URL: ${check.reason}` }
      }
      const method = cfg.method === "GET" ? "GET" : "POST"
      const res = await pinnedFetch(
        check,
        method === "GET"
          ? { method: "GET", headers: trim(cfg.apiKey) ? { Authorization: `Bearer ${trim(cfg.apiKey)}` } : {} }
          : {
              method: "POST",
              headers: { "Content-Type": "application/json", ...(trim(cfg.apiKey) ? { Authorization: `Bearer ${trim(cfg.apiKey)}` } : {}) },
              body: JSON.stringify({ to, message, from: trim(cfg.senderId) || undefined, sender: trim(cfg.senderId) || undefined }),
            },
      )
      // AUDIT M-10 — the pinned transport never follows a 3xx (fetch's
      // default "follow" would let the gateway bounce this request — which
      // carries the Bearer key — onto an attacker-chosen internal Location).
      // Same refusal contract as webhooks.
      const redirected = res.status >= 300 && res.status < 400
      // fetch() drained unread bodies itself; the wrapped node stream needs
      // an explicit cancel so an unread ACK body cannot pin the socket.
      try {
        res.body?.cancel().catch(() => {})
      } catch { /* best-effort socket cleanup */ }
      if (redirected) return { status: "FAILED", detail: redirectRefusal(res, "gateway endpoints") }
      if (!res.ok) return { status: "FAILED", detail: `HTTP ${res.status}`.slice(0, 120) }
      return { status: "SENT", detail: `HTTP ${res.status}` }
    } catch (err: any) {
      return { status: "FAILED", detail: String(err?.message || err).slice(0, 120) }
    }
  },
}

// ============ Security primitives (audit remediation C-3/C-4/H-1/H-5/H-10/M-16) ============
// Single home for:
//  - HTML escaping / letter sanitization (H-1 — payslip & letter renderers)
//  - Origin allowlist matching (C-4 — CSRF defense layer 1)
//  - Sliding-window rate limiting (M-16 — auth/MFA throttling)
//  - Payload field whitelisting (C-3/H-5 — mass-assignment defense)
//  - Outbound URL validation (H-10 — SSRF guards for the SMS gateway)
// Pure functions only (no db imports) so they are unit-testable in isolation.
import crypto from "crypto"

// ---------- H-1: HTML escaping ----------

/** Escape a value for safe interpolation into HTML text content or quoted attributes. */
export function escapeHtml(v: unknown): string {
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

/** Escape a URL destined for a quoted attribute (src="…"): blocks attribute breakout. */
export function escapeAttrUrl(url: unknown): string {
  const s = String(url ?? "").trim()
  // only allow http(s) and data: image URLs (logos/photos are data-URLs or https links)
  if (!/^(https?:\/\/|data:image\/)/i.test(s)) return ""
  return escapeHtml(s)
}

const ALLOWED_TAGS = new Set([
  "p", "br", "b", "strong", "i", "em", "u", "s", "sub", "sup", "span", "div",
  "ul", "ol", "li", "blockquote", "pre", "code",
  "h1", "h2", "h3", "h4", "h5", "h6",
  "table", "thead", "tbody", "tr", "td", "th", "caption", "colgroup", "col",
  "img", "hr", "a", "font", "center", "small", "big",
])
const ALLOWED_ATTRS = new Set([
  "style", "align", "valign", "width", "height", "border", "cellpadding", "cellspacing",
  "colspan", "rowspan", "src", "alt", "title", "href", "target", "color", "face", "size",
  "bgcolor", "class", "id", "dir", "lang",
])

/**
 * Whitelist sanitizer for admin-authored rich content (letter bodies).
 * Removes every tag/attribute outside the safe set, all on* handlers,
 * javascript:/vbscript: URLs and <script>/<style>/<iframe> blocks.
 * Mirrors H-1: letter bodies keep their formatting, lose their attack surface.
 */
export function sanitizeHtml(html: string): string {
  if (!html) return ""
  let out = String(html)
  // drop dangerous whole-block elements including their content
  out = out.replace(/<script\b[\s\S]*?<\/script\s*>/gi, "")
  out = out.replace(/<style\b[\s\S]*?<\/style\s*>/gi, "")
  out = out.replace(/<(iframe|object|embed|form|meta|link|base|svg|math)\b[\s\S]*?<\/\1\s*>/gi, "")
  out = out.replace(/<(iframe|object|embed|form|meta|link|base|input|textarea|select|button)\b[^>]*\/?>/gi, "")
  // neutralize stray closers for removed blocks
  out = out.replace(/<\/(script|style|iframe|object|embed|svg|math)\s*>/gi, "")
  // filter remaining tags
  out = out.replace(/<\/?([a-zA-Z][a-zA-Z0-9-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g, (m, rawTag, rawAttrs) => {
    const tag = String(rawTag).toLowerCase()
    if (!ALLOWED_TAGS.has(tag)) return ""
    const closing = m.startsWith("</")
    if (closing) return `</${tag}>`
    let attrs = ""
    const attrRe = /([a-zA-Z][a-zA-Z0-9:-]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g
    let am: RegExpExecArray | null
    while ((am = attrRe.exec(String(rawAttrs))) !== null) {
      const name = String(am[1]).toLowerCase()
      if (!ALLOWED_ATTRS.has(name)) continue
      if (/^on/i.test(name)) continue // belt & braces (never in the allow set anyway)
      const value = String(am[3] ?? am[4] ?? am[5] ?? "")
      if ((name === "href" || name === "src") && !/^(https?:\/\/|data:image\/|#)/i.test(value.trim())) continue
      attrs += ` ${name}="${escapeHtml(value)}"`
    }
    if (tag === "img" && !/\bsrc=/.test(attrs)) return "" // an img without a safe src is noise
    return `<${tag}${attrs}>`
  })
  return out
}

// ---------- C-4: origin allowlist ----------

/** True when an Origin/Referer value matches the deployment host (or env allowlist). */
export function isOriginAllowed(origin: string | null | undefined, reqHost: string | null | undefined): boolean {
  if (!origin) return true // no header (non-browser clients) — CSRF token still applies
  let host: string | null = null
  try {
    host = new URL(origin).host // includes port when present
  } catch {
    return false // malformed origin → reject
  }
  if (!host || !reqHost) return false
  if (host === reqHost) return true
  const extra = (process.env.HRM_ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean)
  return extra.includes(host)
}

/** Extract the host (with port) from a Referer header. */
export function refererHost(referer: string | null | undefined): string | null {
  if (!referer) return null
  try {
    return new URL(referer).host
  } catch {
    return null
  }
}

/** Public origin the CLIENT can actually reach for URLs built from an
 *  incoming request (payment return/callback links, email links, post-action
 *  redirects). Honors the TLS proxy (x-forwarded-proto/-host) and sanitizes
 *  two real-world failure modes seen 2026-10-26:
 *
 *  1. WILDCARD BIND HOSTS: dev servers run `next dev -H 0.0.0.0` and users
 *     often browse that bind address. 0.0.0.0 is "listen on ALL interfaces" —
 *     as a DESTINATION it is invalid: Windows Chrome fails with
 *     ERR_ADDRESS_INVALID and no external gateway can ever route to it, so
 *     payment callbacks / redirect targets built from the Host header
 *     dead-end ("This site can't be reached"). Normalized to loopback, which
 *     is where such a session is running anyway.
 *  2. FABRICATED https: absent a proxy header, the previous hard-coded
 *     https default produced e.g. https://localhost:4055 against a plain
 *     HTTP dev listener — unreachable, so gateway returns never completed.
 *     Direct access now trusts the request's own scheme; https remains the
 *     last-resort default only when the URL cannot be parsed. */
export function requestPublicOrigin(req: Request): string {
  const headers = req.headers
  // R4-005 — only trust proxy headers when the deployment declares a trusted proxy
  const trustProxy = process.env.HRM_TRUST_PROXY === "1"
  const xfProto = trustProxy ? (headers.get("x-forwarded-proto") || "").split(",")[0].trim().toLowerCase() : ""
  const xfHost = trustProxy ? (headers.get("x-forwarded-host") || "").split(",")[0].trim() : ""
  let host = xfHost || headers.get("host") || ""
  if (/^0\.0\.0\.0(:\d+)?$/.test(host) || /^\[::\](:\d+)?$/.test(host)) {
    const port = host.match(/:(\d+)$/)
    host = port ? `localhost:${port[1]}` : "localhost"
  }
  if (host) {
    if (xfProto) return `${xfProto}://${host}`
    let scheme = ""
    try {
      scheme = new URL(req.url).protocol.replace(":", "")
    } catch { /* unparsable req.url → https fallback below */ }
    return `${scheme || "https"}://${host}`
  }
  try {
    return new URL(req.url).origin
  } catch {
    return ""
  }
}

/** Timing-safe string equality (constant-time on equal-length inputs). */
export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(String(a ?? ""))
  const bb = Buffer.from(String(b ?? ""))
  if (ba.length !== bb.length || ba.length === 0) return false
  return crypto.timingSafeEqual(ba, bb)
}

// ---------- M-16 → M-06: fixed-window rate limiter (SQLite-backed) ----------
// Rate-limit state lives in the Throttle table: it survives restarts and is
// shared across workers on a single instance. Multi-instance deployments need
// a Redis-backed store — see SETUP.md. Over-limit hits are NOT recorded, so a
// hammering client cannot extend its own window.

import { db } from "@/lib/db"

/** Record a hit and report whether the key is now over its limit (fixed window). */
export async function rateLimit(key: string, limit: number, windowMs: number): Promise<boolean> {
  const now = new Date()
  const windowStart = new Date(now.getTime() - (now.getTime() % windowMs))
  const expiresAt = new Date(windowStart.getTime() + windowMs)
  const row = await db.throttle.upsert({
    where: { key },
    create: { key, count: 1, windowStart, expiresAt },
    update: { count: { increment: 1 } },
  })
  // window rolled over since the row was last touched → reset (conditional:
  // a concurrent reset already landed if windowStart matches the current one)
  if (row.windowStart.getTime() !== windowStart.getTime()) {
    const reset = await db.throttle.updateMany({
      where: { key, windowStart: { not: windowStart } },
      data: { count: 1, windowStart, expiresAt },
    })
    if (reset.count > 0) return 1 > limit
    // someone else reset it concurrently — re-read
    const fresh = await db.throttle.findUnique({ where: { key } })
    return (fresh?.count ?? 0) > limit
  }
  return row.count > limit
}

/** Remaining hits in the current window without recording one. */
export async function rateLimitRemaining(key: string, limit: number, windowMs: number): Promise<number> {
  const now = Date.now()
  const row = await db.throttle.findUnique({ where: { key } })
  if (!row) return limit
  const windowStart = now - (now % windowMs)
  if (row.windowStart.getTime() !== windowStart) return limit // stale row → fresh window
  return Math.max(0, limit - row.count)
}

/** M-06 — sweep expired buckets (called from the jobs tick). */
export async function purgeThrottleRows(): Promise<number> {
  const res = await db.throttle.deleteMany({ where: { expiresAt: { lt: new Date() } } })
  return res.count
}

// ---------- H-7: spoof-proof client-IP resolution for throttle keys ----------

/** Minimal request shape (NextRequest / Bun Request both satisfy it). */
type IpSource = { headers?: { get?: (name: string) => string | null } } | undefined | null

/**
 * H-7 — resolve the client IP for throttle keying. The X-Forwarded-For header
 * is CLIENT-SPOOFABLE: any request can set it, and keying auth throttles on it
 * lets an attacker mint a fresh bucket per attempt. XFF is therefore only
 * honored when the deployment sits behind a trusted proxy (HRM_TRUST_PROXY=1,
 * documented in SETUP.md). In every other mode this returns null, and callers
 * fall back to identity-bound keys (email) that cannot be rotated.
 * Returns the FIRST (client-most) value of a comma-separated XFF list.
 */
export function resolveClientIp(req: IpSource, trustProxy: boolean = process.env.HRM_TRUST_PROXY === "1"): string | null {
  const h = req?.headers?.get?.("x-forwarded-for")
  if (trustProxy && h) {
    const first = String(h).split(",")[0].trim()
    if (first) return first
  }
  return null
}

/**
 * H-7 — throttle keys for the unauthenticated auth surface (auth.*).
 *  - With a KNOWN (trusted) IP: per (ip, email) bucket at the caller's limit,
 *    plus a per-real-IP global cap.
 *  - With an UNKNOWN IP: an email-bound bucket ALONE — a spoofed/absent XFF
 *    cannot rotate the key, and there is NO shared global bucket (the old
 *    single "unknown-ip" bucket throttled the entire deployment together and
 *    was both a DoS amplifier and a spoof target).
 */
export function authThrottleKeys(email: string, ip: string | null): string[] {
  const emailKey = String(email || "").toLowerCase().slice(0, 80)
  if (ip) return [`auth:ip:${ip}:${emailKey}`, `authip:${ip}`]
  return [`auth:email:${emailKey}`]
}

/** H-7 — identity-bound fallback key for per-IP throttles (password reset,
 * code brute-force): keyed on email alone when the IP is unknown. */
export function identityThrottleKey(prefix: string, email: string, ip: string | null): string {
  if (ip) return `${prefix}:${ip}`
  return `${prefix}:email:${String(email || "").toLowerCase().slice(0, 80)}`
}

// ---------- C-3/H-5: mass-assignment defense ----------

/**
 * Build a write payload restricted to an explicit field whitelist.
 * Protected fields (id, vendorId, status, createdAt, code…) never pass through
 * unless explicitly listed. Empty strings are dropped (FormDialog convention),
 * numeric coercion + finiteness is enforced for numeric fields.
 */
export function safePayload<T extends Record<string, any>>(
  p: Record<string, any> | undefined | null,
  allowed: string[],
  opts: { numericFields?: string[]; boolFields?: string[]; dropEmpty?: boolean } = {},
): T {
  const src = p || {}
  const out: Record<string, any> = {}
  const dropEmpty = opts.dropEmpty !== false
  const numeric = new Set(opts.numericFields || [])
  const bools = new Set(opts.boolFields || [])
  for (const k of allowed) {
    let v = src[k]
    if (v === undefined) continue
    if (dropEmpty && typeof v === "string" && v.trim() === "") continue
    if (numeric.has(k)) {
      const n = Number(v)
      if (v === "" || v === null) continue
      if (!Number.isFinite(n)) continue // NaN/Infinity never reach payroll arithmetic
      v = n
    }
    if (bools.has(k)) v = v === true || v === "true"
    out[k] = v
  }
  return out as T
}

// ---------- H-10: outbound URL validation (SSRF guard) ----------

const PRIVATE_HOSTS = new Set(["localhost", "metadata.google.internal", "instance-data"])
function isPrivateIpv4(host: string): boolean {
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (!m) return false
  const oct = m.slice(1).map(Number)
  if (oct.some((n) => n > 255)) return true // malformed numeric host — treat as private
  const [a, b] = oct
  if (a === 10 || a === 127) return true
  if (a === 192 && b === 168) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 169 && b === 254) return true // link-local incl. cloud metadata
  if (a === 0 || a >= 224) return true // 0.0.0.0 & multicast
  return false
}

/** SEC-6 (Phase 3 WS-E) — IPv6 private-space check. Covers loopback (::1),
 *  unspecified (::), unique-local (fc00::/7 — the fd00.. range), link-local
 *  (fe80::/10) and IPv4-mapped (::ffff:a.b.c.d — delegated to the v4 check).
 *  IPv6 literals arrive with brackets stripped by callers (hostname lowercased). */
export function isPrivateIpv6(host: string): boolean {
  if (!host.includes(":")) return false
  const h = host.toLowerCase()
  if (h === "::1" || h === "::") return true
  if (h.startsWith("fd") || h.startsWith("fc")) return true // fc00::/7 ULA
  if (/^fe[89ab]/.test(h)) return true // fe80::/10 link-local
  const mapped = h.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/) // IPv4-mapped
  if (mapped) return isPrivateIpv4(mapped[1])
  if (/^::ffff:0:/.test(h)) return true // IPv4-translated
  return false
}

/** Validate an admin-configured outbound URL: https only, public host, no credentials. */
export function validateOutboundUrl(rawUrl: string): { ok: true; url: URL } | { ok: false; reason: string } {
  let url: URL
  try {
    url = new URL(String(rawUrl || "").trim())
  } catch {
    return { ok: false, reason: "URL is not valid" }
  }
  if (url.protocol !== "https:") return { ok: false, reason: "Only https:// gateway URLs are allowed" }
  if (url.username || url.password) return { ok: false, reason: "Credentials in the URL are not allowed" }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "")
  if (PRIVATE_HOSTS.has(host)) return { ok: false, reason: "Private/internal hostnames are not allowed" }
  if (isPrivateIpv4(host)) return { ok: false, reason: "Private/internal IP ranges are not allowed" }
  if (isPrivateIpv6(host)) return { ok: false, reason: "Private/internal IPv6 ranges are not allowed" }
  return { ok: true, url }
}

/** SEC-6 (Phase 3 WS-E) — SEND-TIME SSRF validation with DNS resolution.
 *
 *  The string-level guard above checks the hostname LITERAL: a public DNS name
 *  that RESOLVES to 169.254.169.254 / 10.x / ::1 (DNS rebinding, or a host
 *  that was always internal) sailed straight through it, and fetch() follows
 *  redirects to internal targets unchecked. This companion:
 *    1. runs every string check (validateOutboundUrl), then
 *    2. RESOLVES the hostname and rejects when ANY resolved address is
 *       private (v4 or v6) — evaluated at SEND time, so a host that was
 *       public at save time and repointed internally since is caught.
 *  Callers MUST also send with `redirect: "manual"` (see webhooks.ts) —
 *  redirect-following is the other classic bypass and is disabled there.
 *  The remaining race (DNS answer flips between this check and the connect)
 *  is a sub-millisecond window documented in the module header. */
export async function resolveOutboundUrl(
  rawUrl: string,
): Promise<{ ok: true; url: URL; addresses: string[] } | { ok: false; reason: string }> {
  const check = validateOutboundUrl(rawUrl)
  if (!check.ok) return check
  const host = check.url.hostname.toLowerCase().replace(/^\[|\]$/g, "")
  // IP literals were already string-checked; only NAMES need resolution
  const isLiteral = /^(\d{1,3}\.){3}\d{1,3}$/.test(host) || host.includes(":")
  if (isLiteral) return { ok: true, url: check.url, addresses: [host] }
  let addresses: string[]
  try {
    const { lookup } = await import("node:dns/promises")
    const res = await lookup(host, { all: true, verbatim: true })
    addresses = res.map((r) => r.address)
  } catch {
    return { ok: false, reason: `Could not resolve the host "${host}" — refusing to send` }
  }
  if (!addresses.length) return { ok: false, reason: `The host "${host}" resolves to no addresses` }
  const bad = addresses.find((a) => (a.includes(":") ? isPrivateIpv6(a) : isPrivateIpv4(a)))
  if (bad) {
    return { ok: false, reason: `The host "${host}" resolves to a private/internal address (${bad}) — DNS-rebinding to internal networks is not allowed` }
  }
  return { ok: true, url: check.url, addresses }
}

/** SMTP-safe display name: strips control chars, quotes and angle brackets (H-10). */
export function sanitizeDisplayName(name: unknown): string {
  return String(name ?? "")
    .replace(/[\r\n\x00-\x1f\x7f]/g, "")
    .replace(/["<>]/g, "")
    .trim()
    .slice(0, 120)
}

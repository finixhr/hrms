// ============ Security primitives (audit remediation C-3/C-4/H-1/H-5/H-10/M-16) ============
// Single home for:
//  - HTML escaping / letter sanitization (H-1 — payslip & letter renderers)
//  - Origin allowlist matching (C-4 — CSRF defense layer 1)
//  - Sliding-window rate limiting (M-16 — auth/MFA throttling)
//  - Payload field whitelisting (C-3/H-5 — mass-assignment defense)
//  - Outbound URL validation (H-10 — SSRF guards for the SMS gateway)
//  - Pinned outbound transport (AUDIT M-10 2026-11-07 — DNS-rebinding-proof
//    connect shared by the SMS gateway + webhooks: resolve ALL records, reject
//    when ANY is private (full v4+v6 blocklist), connect through the VALIDATED
//    address list, never follow redirects)
// No db imports — everything here is unit-testable in isolation (the URL
// guard/transport helpers do DNS + socket I/O, but no database).
import crypto from "crypto"

// ---------- H-1: HTML escaping (lives in @/lib/sanitize-html) ----------
export { escapeHtml, escapeAttrUrl, sanitizeHtml } from "@/lib/sanitize-html"

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
  // AUDIT M-10 (2026-11-07) — 100.64.0.0/10 CGNAT (RFC 6598 "shared address
  // space"): not globally routable, and carrier control planes live there.
  if (a === 100 && b >= 64 && b <= 127) return true
  if (a === 0 || a >= 224) return true // 0.0.0.0/8 & multicast/reserved
  return false
}

/** SEC-6 (Phase 3 WS-E) — IPv6 private-space check. Covers loopback (::1),
 *  unspecified (::/128), unique-local (fc00::/7 — the fd00.. range),
 *  link-local (fe80::/10), documentation (2001:db8::/32) and the whole
 *  IPv4-mapped block (::ffff:0:0/96, dotted AND hex spellings).
 *  IPv6 literals arrive with brackets stripped by callers (hostname lowercased). */
export function isPrivateIpv6(host: string): boolean {
  if (!host.includes(":")) return false
  const h = host.toLowerCase()
  if (h === "::1" || h === "::") return true
  if (h.startsWith("fd") || h.startsWith("fc")) return true // fc00::/7 ULA
  if (/^fe[89ab]/.test(h)) return true // fe80::/10 link-local
  // AUDIT M-10 (2026-11-07) — two ranges the old check missed:
  //  - 2001:db8::/32 documentation range (reserved for examples, never a
  //    real endpoint);
  //  - the ENTIRE ::ffff:0:0/96 IPv4-mapped block, in BOTH spellings
  //    (dotted "::ffff:10.0.0.1" and hex "::ffff:a00:1"). The old check only
  //    rejected the mapped subset that translated to private v4, so e.g.
  //    ::ffff:8.8.8.8 sailed through and handed the HTTP client a mapped
  //    address the attacker controls the v4 routing of.
  if (/^2001:db8:/.test(h)) return true
  if (/^::ffff:(?:\d{1,3}(?:\.\d{1,3}){3}|[0-9a-f]{1,4}:[0-9a-f]{1,4})$/.test(h)) return true
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
 *  AUDIT M-10 (2026-11-07) — callers MUST send through pinnedFetch() below:
 *  it connects through THIS check's validated address list (the OS resolver
 *  is never consulted again), closing the DNS-rebinding race that remained
 *  when the guard only pre-checked and handed the original URL to fetch()
 *  (fetch re-resolves the name itself). pinnedFetch also never follows
 *  redirects — a 3xx Location chosen by the endpoint would re-open the SSRF
 *  surface this guard just closed. */
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

// ---------- AUDIT M-10 (2026-11-07): pinned outbound transport (send side) ----------

/** AUDIT M-10 (2026-11-07) — shared 3xx-refusal message for the outbound
 *  transports. pinnedFetch below never follows redirects (the raw node
 *  client has no redirect machinery — a 3xx surfaces as the terminal
 *  response, identical to fetch's redirect:"manual"), so callers translate
 *  it into this failure instead of letting an attacker-controlled endpoint
 *  bounce the request onto an internal URL. */
export function redirectRefusal(
  res: { status: number; headers: { get: (name: string) => string | null } },
  what: string,
): string {
  return `Redirect to ${res.headers.get("location") || "?"} refused — ${what} must not redirect`
}

/** Request shape pinnedFetch accepts (a deliberate subset of fetch's init:
 *  the outbound callers send string bodies and plain header maps). */
export type PinnedFetchInit = {
  method?: string
  headers?: Record<string, string>
  body?: string
  signal?: AbortSignal
}

/** AUDIT M-10 (2026-11-07) — the PINNED outbound transport (SSRF guard, part 2).
 *
 *  resolveOutboundUrl above closes the "first address only / IPv4-only"
 *  holes, but a guard that merely CHECKS DNS and then hands the original URL
 *  to fetch() leaves the DNS-rebinding window open: the HTTP client
 *  re-resolves the name itself, so a name alternating between 1.2.3.4 and
 *  127.0.0.1 passes the check on the public answer and connects on the
 *  private one. This companion closes that window by CONNECTING THROUGH THE
 *  VALIDATED ADDRESS LIST:
 *
 *    1. a custom `lookup` is installed on node:http/https so the TCP connect
 *       resolves through check.addresses (every entry already validated
 *       public by resolveOutboundUrl) — the OS resolver is never consulted
 *       again, so a mid-flight DNS flip cannot steer the connection;
 *    2. the request target stays the ORIGINAL URL (STRING form — Bun's
 *       node:http only honors a custom lookup on string targets, verified
 *       2026-11-07 on Bun 1.3.14), so the Host header, TLS SNI and
 *       certificate validation all use the real hostname while the socket
 *       goes to the pinned IP (verified: hostname-cert + pinned-IP connects
 *       succeed, mismatched hostnames still fail ERR_TLS_CERT_ALTNAME_INVALID);
 *    3. redirects are NEVER followed (node's client has no follow logic),
 *       matching the redirect:"manual" contract the webhook path already
 *       documented — callers refuse 3xx via redirectRefusal();
 *    4. every lookup call hands out a FRESH address array: the
 *       Happy-Eyeballs/autoSelectFamily connect loop CONSUMES the list
 *       (shift) — reusing one array leaves later sends with an empty list
 *       ("No records found"), verified on Bun 1.3.14.
 *
 *  Response parity with fetch(): status/ok/headers/text() via a wrapped
 *  WHATWG Response (204/205/304 get a null body; out-of-range statuses are
 *  clamped into 200..599 because the Response constructor rejects them).
 *  init.signal aborts the send — the promise rejects with the signal's own
 *  reason (TimeoutError/AbortError), like fetch, after tearing the socket
 *  down. Both runtimes of this deployment are covered: the standalone
 *  server runs under Bun, `next dev` under Node. */
export async function pinnedFetch(
  check: { url: URL; addresses: string[] },
  init: PinnedFetchInit = {},
): Promise<Response> {
  if (!check.addresses?.length) throw new Error("SSRF pin: no validated addresses to connect to")
  const scheme = check.url.protocol
  if (scheme !== "https:" && scheme !== "http:") {
    throw new Error(`Unsupported outbound URL scheme "${scheme}"`)
  }
  // validateOutboundUrl is https-only; the http branch keeps the shared
  // transport usable for local/test targets without a second code path.
  const mod: typeof import("node:http") =
    scheme === "https:" ? ((await import("node:https")) as unknown as typeof import("node:http")) : await import("node:http")
  const { Readable } = await import("node:stream")
  const lookup = ((_hostname: string, opts: { all?: boolean }, cb: (...args: any[]) => void) => {
    const list = check.addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }))
    if (opts && opts.all) cb(null, list)
    else cb(null, list[0].address, list[0].family)
  }) as unknown as NonNullable<import("node:http").RequestOptions["lookup"]>
  return await new Promise<Response>((resolve, reject) => {
    const req = mod.request(check.url.toString(), { method: init.method || "GET", headers: init.headers, lookup }, (res) => {
      // wrap the node response into a fetch-shaped Response
      const headers = new Headers()
      for (const [name, value] of Object.entries(res.headers)) {
        if (value === undefined) continue
        if (Array.isArray(value)) for (const v of value) headers.append(name, String(v))
        else headers.set(name, String(value))
      }
      const status = res.statusCode ?? 502
      // 1xx never reaches the 'response' event and 6xx is pathological, but
      // the Response constructor only accepts 200..599 — clamp so the
      // wrapper stays total instead of crashing the send.
      const safeStatus = status >= 200 && status <= 599 ? status : 502
      const nullBody = safeStatus === 204 || safeStatus === 205 || safeStatus === 304
      const body = nullBody ? null : (Readable.toWeb(res) as unknown as ReadableStream)
      resolve(new Response(body, { status: safeStatus, headers }))
    })
    const signal = init.signal
    if (signal) {
      const onAbort = () => {
        const reason: unknown = signal.reason
        const err = reason instanceof Error ? reason : Object.assign(new Error("This operation was aborted"), { name: "AbortError" })
        req.destroy() // tear the pinned socket down
        reject(err) // fetch parity: reject with the signal's own reason
      }
      if (signal.aborted) onAbort()
      else signal.addEventListener("abort", onAbort, { once: true })
    }
    req.on("error", reject)
    if (init.body != null) req.end(init.body)
    else req.end()
  })
}

/** SMTP-safe display name: strips control chars, quotes and angle brackets (H-10). */
export function sanitizeDisplayName(name: unknown): string {
  return String(name ?? "")
    .replace(/[\r\n\x00-\x1f\x7f]/g, "")
    .replace(/["<>]/g, "")
    .trim()
    .slice(0, 120)
}

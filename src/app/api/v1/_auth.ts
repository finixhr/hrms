// ============ Public REST API v1 — shared auth + response helpers ============
// Bearer-token authentication for /api/v1/* (Wave 4 WP-C / SG-E). This module
// is PRIVATE to the v1 route handlers (not a route itself).
//
// Auth chain per request:
//   Authorization: Bearer fk_…  →  prefix = first 12 chars of the FULL key
//   (including "fk_")  →  prefix-indexed candidate lookup  →  timing-safe
//   sha256 compare (safeEqual)  →  revokedAt null  →  scope granted  →
//   per-key request throttle (60/min)  →  handler.
//
// Rate limiting (security.ts fixed-window limiter):
//   - 10 FAILED authentications / minute per key prefix (brute-force guard on
//     the lookup path — valid keys never touch this bucket).
//   - 60 requests / minute per authenticated key id.
//
// Every authenticated request is audited as API_V1_REQUEST under the key
// creator's identity (userName "API key <name>").
import { NextRequest, NextResponse } from "next/server"
import crypto from "crypto"
import { db } from "@/lib/db"
import { safeEqual, rateLimit, resolveClientIp } from "@/hrm-server/security"
import { audit } from "@/hrm-server/audit"
import { resolveEntitlements, type ResolvedEntitlements } from "@/hrm-server/saas/entitlements"
// MOB-1 (Phase 3 WS-D) — user access tokens (JWT) alongside fk_ API keys
import { verifyAccessToken } from "./_tokens"

const FAILED_AUTH_PER_MIN = 10
const REQUESTS_PER_KEY_PER_MIN = 60
const REQUESTS_PER_USER_PER_MIN = 120
/** MOB-4 (Phase 3 WS-D) — read-request audit sampling. A polling mobile
 *  client wrote one AuditLog row PER GET (audit explosion at app-polling
 *  cadence). Reads are now sampled at this rate (0..1); WRITES are always
 *  audited. Default 0.1 (1 in 10); HRM_API_AUDIT_SAMPLE_RATE=1 restores the
 *  old always-audit behavior, 0 disables read audits entirely. Read at CALL
 *  time so operators (and tests) can flip it without a restart. */
function apiReadAuditSampleRate(): number {
  return Math.min(1, Math.max(0, Number(process.env.HRM_API_AUDIT_SAMPLE_RATE ?? 0.1)))
}

export type AuthedKey = {
  id: string
  vendorId: string
  name: string
  scopes: string[]
  createdById: string | null
  createdByName: string | null
  /** SEC-01 (R5) — present only on USER tokens (API keys stay tenant-wide
   *  by design): the caller's org scope, so manager-role tokens read only
   *  their own branch/department on the v1 list surfaces — exactly what the
   *  in-app /api/hrm surface enforces via employeeScopeFilter. */
  userScope?: {
    role: string
    employeeId: string | null
    branchId: string | null
    departmentId: string | null
  }
}

export type ApiAuthResult =
  | { ok: true; key: AuthedKey; ip: string | null }
  | { ok: false; res: NextResponse }

/** Seconds until the current fixed window ends (Retry-After for 429s). */
function retryAfterSec(windowMs: number): number {
  const now = Date.now()
  const windowEnd = now - (now % windowMs) + windowMs
  return Math.max(1, Math.ceil((windowEnd - now) / 1000))
}

export function apiOk(data: unknown, meta?: Record<string, unknown>): NextResponse {
  return NextResponse.json(meta ? { ok: true, data, meta } : { ok: true, data })
}

export function apiErr(status: number, code: string, error: string, retryAfter?: number): NextResponse {
  const res = NextResponse.json({ ok: false, error, code }, { status })
  if (retryAfter != null) res.headers.set("Retry-After", String(Math.max(1, retryAfter)))
  return res
}

/** page/pageSize query params clamped to 1..100 (default 1/50). */
export function pageParams(req: NextRequest): { page: number; pageSize: number } {
  const page = Math.max(1, Math.trunc(Number(req.nextUrl.searchParams.get("page")) || 1) || 1)
  const pageSizeRaw = Math.trunc(Number(req.nextUrl.searchParams.get("pageSize")) || 50) || 50
  const pageSize = Math.min(100, Math.max(1, pageSizeRaw))
  return { page, pageSize }
}

/** Parse + shape-check a JSON POST body (zod validation happens per route). */
export async function readJsonBody(
  req: NextRequest,
): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; res: NextResponse }> {
  const ct = (req.headers.get("content-type") || "").split(";")[0].trim().toLowerCase()
  if (ct !== "application/json") {
    return { ok: false, res: apiErr(415, "UNSUPPORTED_MEDIA_TYPE", "Content-Type: application/json is required") }
  }
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return { ok: false, res: apiErr(400, "MALFORMED_BODY", "Request body is not valid JSON") }
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, res: apiErr(400, "MALFORMED_BODY", "Request body must be a JSON object") }
  }
  return { ok: true, body: body as Record<string, unknown> }
}

export function zodFail(issues: { path: (string | number | symbol)[]; message: string }[]): NextResponse {
  const first = issues[0]
  const path = first?.path?.length ? ` at "${first.path.join(".")}"` : ""
  return apiErr(400, "VALIDATION", `Invalid payload${path}: ${first?.message || "validation failed"}`)
}

/** SUB-102 — a scope ending in ":write" mutates tenant data. */
export function isWriteScope(scope: string): boolean {
  return scope.trim().toLowerCase().endsWith(":write")
}

/** SUB-101/SUB-102 (Wave R3-3) — subscription gate for the public REST API.
 *  Pure decision function over the resolved entitlements so it is unit-testable
 *  without a DB. Returns the error response for the caller, or null when the
 *  request may proceed:
 *    - plan without apiAccess  → 403 API_NOT_INCLUDED (upgrade required)
 *    - EXPIRED/SUSPENDED/CANCELLED tenant + write scope → 423 SUBSCRIPTION_READONLY
 *      (the read-only lockout the /api/hrm dispatcher enforces was never
 *      consulted by the v1 surface — a suspended tenant could keep mutating
 *      attendance and leave data through its API keys indefinitely)
 *  LEGACY vendors (no subscription row) pass both gates by construction
 *  (features.API = true, readonly = false). */
export function apiEntitlementError(ent: ResolvedEntitlements, scope: string): NextResponse | null {
  if (!ent.features.API) {
    return apiErr(403, "API_NOT_INCLUDED",
      `The REST API is not included in your ${ent.planName || "current"} plan. Contact your platform administrator to upgrade.`)
  }
  if (ent.readonly && isWriteScope(scope)) {
    return NextResponse.json({
      ok: false,
      code: "SUBSCRIPTION_READONLY",
      error: `Your subscription is ${ent.status === "SUSPENDED" ? "suspended" : "expired"} — the workspace is read-only until it is renewed. Write scopes are disabled for API keys.`,
      entitlement: { status: ent.status, plan: ent.planName, readonly: true, renewalRequired: true },
    }, { status: 423 })
  }
  return null
}

/** Authenticate the Bearer API key and enforce the route's scope. */
export async function authenticateApiKey(req: NextRequest, scope: string): Promise<ApiAuthResult> {
  const ip = resolveClientIp(req)
  const header = req.headers.get("authorization") || ""
  const m = header.match(/^Bearer\s+(.+)$/i)
  const raw = m ? m[1].trim() : ""
  if (!raw) {
    return { ok: false, res: apiErr(401, "UNAUTHORIZED", "Missing Authorization header — send `Authorization: Bearer <API key>`") }
  }
  if (!raw.startsWith("fk_") || raw.length < 13 || !/^[A-Za-z0-9_-]+$/.test(raw)) {
    return { ok: false, res: apiErr(401, "UNAUTHORIZED", "Malformed API key — expected a fk_… bearer token") }
  }
  const prefix = raw.slice(0, 12)

  // candidate rows for this prefix (unique per vendor by construction; a hash
  // match picks the ONE row whose full key equals the presented key)
  const candidates = await db.apiKey.findMany({ where: { prefix } })
  const hash = crypto.createHash("sha256").update(raw, "utf8").digest("hex")
  const key = candidates.find((k) => safeEqual(k.hash, hash))
  if (!key) {
    // brute-force guard: 10 failed authentications / min per tried prefix
    if (await rateLimit(`apiv1:fail:${prefix}`, FAILED_AUTH_PER_MIN, 60_000)) {
      return { ok: false, res: apiErr(429, "RATE_LIMITED", "Too many failed authentication attempts — try again in a minute", retryAfterSec(60_000)) }
    }
    return { ok: false, res: apiErr(401, "UNAUTHORIZED", "Invalid API key") }
  }
  if (key.revokedAt) {
    return { ok: false, res: apiErr(401, "KEY_REVOKED", "This API key has been revoked — create a new one in HR Settings → Integrations") }
  }
  let scopes: string[] = []
  try {
    const v = JSON.parse(key.scopesJson || "[]")
    if (Array.isArray(v)) scopes = v.map(String)
  } catch { /* corrupt scopesJson → treat as no scopes */ }
  if (!scopes.includes(scope)) {
    return {
      ok: false,
      res: apiErr(403, "SCOPE_MISSING", `API key "${key.name}" lacks the required scope "${scope}" (granted: ${scopes.join(", ") || "none"})`),
    }
  }
  // ---- SUB-101/SUB-102 (Wave R3-3): subscription entitlements on the API ----
  // The /api/hrm dispatcher enforces feature gates + read-only lockout for
  // session traffic; the v1 surface previously authenticated keys in a vacuum.
  const ent = await resolveEntitlements(key.vendorId)
  const gate = apiEntitlementError(ent, scope)
  if (gate) return { ok: false, res: gate }
  // per-key request throttle (counts every authenticated request, including
  // the ones the handler later rejects with 404/400)
  if (await rateLimit(`apikey:${key.id}`, REQUESTS_PER_KEY_PER_MIN, 60_000)) {
    return { ok: false, res: apiErr(429, "RATE_LIMITED", `API key rate limit exceeded (${REQUESTS_PER_KEY_PER_MIN} requests/minute)`, retryAfterSec(60_000)) }
  }
  // fire-and-forget lastUsedAt — never blocks the response
  void db.apiKey.update({ where: { id: key.id }, data: { lastUsedAt: new Date() } }).catch(() => {})

  return {
    ok: true,
    ip,
    key: { id: key.id, vendorId: key.vendorId, name: key.name, scopes, createdById: key.createdById, createdByName: key.createdByName },
  }
}

/** MOB-1 (Phase 3 WS-D) — authenticate EITHER credential type:
 *  Bearer fk_…  → tenant API key (existing path above)
 *  Bearer eyJ…  (any 3-segment JWT) → USER access token (see _tokens.ts):
 *    signature + expiry verified, the backing Session re-read (revocation =
 *    session delete), the User re-read (status ACTIVE), route scope must be
 *    in the token's granted set, same entitlement gate + per-user throttle.
 *  Anything else falls through to the API-key parser (which returns the
 *  correct 401 for malformed credentials). */
export async function authenticateRequest(req: NextRequest, scope: string): Promise<ApiAuthResult> {
  const raw = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim()
  if (raw && !raw.startsWith("fk_") && raw.split(".").length === 3) {
    const claims = verifyAccessToken(raw)
    if (!claims) return { ok: false, res: apiErr(401, "UNAUTHORIZED", "Invalid or expired access token") }
    if (!claims.scp.includes(scope)) {
      return {
        ok: false,
        res: apiErr(403, "SCOPE_MISSING", `This token lacks the required scope "${scope}" (granted: ${claims.scp.join(", ") || "none"})`),
      }
    }
    const [session, user] = await Promise.all([
      db.session.findUnique({ where: { id: claims.sid }, select: { id: true, kind: true, expiresAt: true } }),
      db.user.findUnique({ where: { id: claims.uid }, select: { id: true, vendorId: true, name: true, status: true, role: true, employeeId: true } }),
    ])
    if (!session || session.kind !== "FULL" || session.expiresAt.getTime() <= Date.now()) {
      return { ok: false, res: apiErr(401, "UNAUTHORIZED", "The session behind this token has ended — use the refresh token or re-authenticate") }
    }
    if (!user || user.status !== "ACTIVE") {
      return { ok: false, res: apiErr(401, "UNAUTHORIZED", "The account behind this token is no longer active") }
    }
    if (user.vendorId !== claims.vid) {
      return { ok: false, res: apiErr(401, "UNAUTHORIZED", "Token vendor binding mismatch") }
    }
    const ent = await resolveEntitlements(user.vendorId)
    const gate = apiEntitlementError(ent, scope)
    if (gate) return { ok: false, res: gate }
    if (await rateLimit(`apiuser:${user.id}`, REQUESTS_PER_USER_PER_MIN, 60_000)) {
      return { ok: false, res: apiErr(429, "RATE_LIMITED", `User token rate limit exceeded (${REQUESTS_PER_USER_PER_MIN} requests/minute)`, Math.max(1, Math.ceil((60_000 - (Date.now() % 60_000)) / 1000))) }
    }
    // SEC-01 (R5) — resolve the manager's org scope for user tokens (one
    // employee lookup, only for the two manager roles; mirrors rbac.ts
    // employeeScopeFilter: BRANCH_MANAGER → branch, DEPT_MANAGER → department).
    let userScope: AuthedKey["userScope"]
    if (user.role === "BRANCH_MANAGER" || user.role === "DEPT_MANAGER") {
      const emp = user.employeeId
        ? await db.employee.findFirst({ where: { id: user.employeeId, vendorId: user.vendorId }, select: { id: true, branchId: true, departmentId: true } })
        : null
      userScope = { role: user.role, employeeId: user.employeeId, branchId: emp?.branchId ?? null, departmentId: emp?.departmentId ?? null }
    }
    return {
      ok: true,
      ip: resolveClientIp(req),
      key: { id: `user:${user.id}`, vendorId: user.vendorId, name: user.name, scopes: claims.scp, createdById: user.id, createdByName: user.name, userScope },
    }
  }
  return authenticateApiKey(req, scope)
}

/** Audit an authenticated v1 request under the key creator's identity.
 *  MOB-4 (Phase 3 WS-D) — READ requests (summary starts with "GET ") are
 *  SAMPLED at HRM_API_AUDIT_SAMPLE_RATE (default 0.1): a polling mobile
 *  client must not write one audit row per poll. Writes are always audited. */
export async function auditApiRequest(
  key: AuthedKey,
  ip: string | null,
  entity: "Employee" | "Attendance" | "Leave",
  entityId: string | null,
  summary: string,
): Promise<void> {
  const isRead = summary.startsWith("GET ")
  if (isRead && Math.random() >= apiReadAuditSampleRate()) return
  await audit(
    { userId: key.createdById, userName: `API key ${key.name}`, vendorId: key.vendorId, ip: ip ?? undefined },
    "API_V1_REQUEST",
    entity,
    entityId,
    summary,
  )
}

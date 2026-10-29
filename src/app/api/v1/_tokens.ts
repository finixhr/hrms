// ============ MOB-1 (Phase 3 WS-D) — user access/refresh tokens for /api/v1 ====
// Native-mobile auth story for the public REST API. Until Phase 3 the ONLY v1
// credential was a non-expiring tenant API key (fk_…) — fine for server-to-
// server integrations, wrong for a phone app (no user identity, no rotation,
// no revocation short of deleting the key).
//
// DESIGN (OAuth2-shaped, riding the EXISTING session machinery):
//   * PASSWORD GRANT — POST /api/v1/auth/token {grant_type:"password", …}
//     validates credentials through the SAME login() path as the web app
//     (lockout, password expiry, forced rotation and MFA all apply; any
//     PREAUTH outcome refuses the grant — MFA accounts keep using the web
//     flow, headless integrations keep using API keys). A FULL Session row is
//     created; a short-lived ACCESS TOKEN (JWT, 15 min, HS256) is bound to it.
//   * REFRESH GRANT — POST /api/v1/auth/token {grant_type:"refresh_token", …}
//     rotates an opaque refresh token (sha256-at-rest, 30 days, ApiRefreshToken
//     row). Presenting an ALREADY-ROTATED (revoked) token is treated as theft:
//     the entire rotation FAMILY is revoked and the backing session deleted.
//   * WHO MAY MINT — only app users whose role grants integrations.view (the
//     same capability that administers API keys): an ESS employee cannot mint
//     a directory-reading token. Requested scopes must come from the fixed
//     SCOPE_CATALOG (read scopes by default).
//   * ACCESS- TOKEN AUTH — verifyAccessToken() checks signature + expiry, then
//     re-reads the SESSION (revocation = session delete) and the USER (status
//     ACTIVE) on every request — a stolen access token dies within 15 min, a
//     disabled user immediately.
//
// Signing key: HKDF-derived from HRM_MFA_KEY (context "api-jwt::v1") — one
// root secret, cryptographically separated per purpose, no new env var.
import crypto from "crypto"
import { db } from "@/lib/db"
import { roleTemplate } from "@/hrm-server/auth"

const ACCESS_TTL_SEC = Math.max(60, Number(process.env.HRM_API_ACCESS_TTL_SEC) || 15 * 60)
const REFRESH_TTL_DAYS = Math.max(1, Number(process.env.HRM_API_REFRESH_TTL_DAYS) || 30)
const REFRESH_TTL_MS = REFRESH_TTL_DAYS * 86_400_000
const REFRESH_PREFIX = "fkr_"

/** Every scope the v1 surface understands (superset of what routes enforce). */
export const SCOPE_CATALOG = [
  "employees:read",
  "attendance:read",
  "attendance:write",
  "leave:read",
  "leave:write",
  // Phase 5 P6 (WS-C) — the push channel: register/list/remove THIS user's
  // web-push subscriptions (per-device, ownership enforced)
  "push:write",
] as const
export type ApiScope = (typeof SCOPE_CATALOG)[number]
const READ_SCOPES = SCOPE_CATALOG.filter((s) => s.endsWith(":read"))

// ---------- signing ----------

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

let cachedKey: Buffer | null = null
function signingKey(): Buffer {
  if (cachedKey) return cachedKey
  const root = process.env.HRM_MFA_KEY || ""
  if (!root) throw new Error("HRM_MFA_KEY is not configured — API access tokens cannot be signed (set it like the web MFA path requires).")
  cachedKey = Buffer.from(crypto.hkdfSync("sha256", root, "hrm:api-jwt:v1", "access-token", 32))
  return cachedKey
}

/** Test hook — the key derives from env that tests may flip. */
export function _clearSigningKeyCacheForTests(): void {
  cachedKey = null
}

export type AccessClaims = {
  sid: string // session id (revocation handle)
  uid: string // user id
  vid: string // vendor id
  role: string
  scp: string[]
  iat: number
  exp: number
}

export function signAccessToken(claims: Omit<AccessClaims, "iat" | "exp">, ttlSec = ACCESS_TTL_SEC): string {
  const now = Math.floor(Date.now() / 1000)
  const payload: AccessClaims = { ...claims, iat: now, exp: now + ttlSec }
  const header = b64url(Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })))
  const body = b64url(Buffer.from(JSON.stringify(payload)))
  const sig = b64url(crypto.createHmac("sha256", signingKey()).update(`${header}.${body}`).digest())
  return `${header}.${body}.${sig}`
}

export function verifyAccessToken(token: string): AccessClaims | null {
  const parts = token.split(".")
  if (parts.length !== 3) return null
  const [header, body, sig] = parts
  const expected = b64url(crypto.createHmac("sha256", signingKey()).update(`${header}.${body}`).digest())
  const a = Buffer.from(sig)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null
  try {
    const claims = JSON.parse(Buffer.from(body.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8")) as AccessClaims
    if (typeof claims.exp !== "number" || claims.exp < Math.floor(Date.now() / 1000)) return null
    if (!claims.sid || !claims.uid || !claims.vid || !Array.isArray(claims.scp)) return null
    return claims
  } catch {
    return null
  }
}

// ---------- refresh tokens ----------

function sha256Hex(v: string): string {
  return crypto.createHash("sha256").update(v, "utf8").digest("hex")
}

export type IssuedTokenPair = {
  accessToken: string
  refreshToken: string
  expiresIn: number
  scopes: string[]
  sessionId: string
}

async function issuePair(opts: {
  userId: string
  vendorId: string
  sessionId: string
  scopes: string[]
  familyId: string
}): Promise<IssuedTokenPair> {
  const user = await db.user.findUnique({ where: { id: opts.userId }, select: { role: true } })
  const accessToken = signAccessToken({
    sid: opts.sessionId, uid: opts.userId, vid: opts.vendorId,
    role: user?.role || "USER", scp: opts.scopes,
  })
  const raw = REFRESH_PREFIX + crypto.randomBytes(32).toString("base64url")
  await db.apiRefreshToken.create({
    data: {
      vendorId: opts.vendorId, userId: opts.userId, sessionId: opts.sessionId,
      tokenHash: sha256Hex(raw), familyId: opts.familyId,
      scopesJson: JSON.stringify(opts.scopes),
      expiresAt: new Date(Date.now() + REFRESH_TTL_MS),
    },
  })
  return { accessToken, refreshToken: raw, expiresIn: ACCESS_TTL_SEC, scopes: opts.scopes, sessionId: opts.sessionId }
}

/** Normalize a requested scope list against the catalog (read scopes default). */
export function normalizeScopes(requested: unknown): { ok: true; scopes: string[] } | { ok: false; reason: string } {
  if (requested == null) return { ok: true, scopes: [...READ_SCOPES] }
  if (!Array.isArray(requested)) return { ok: false, reason: "scopes must be an array of scope strings" }
  const out = new Set<string>()
  for (const s of requested) {
    if (typeof s !== "string" || !(SCOPE_CATALOG as readonly string[]).includes(s)) {
      return { ok: false, reason: `Unknown scope "${String(s)}" — allowed: ${SCOPE_CATALOG.join(", ")}` }
    }
    out.add(s)
  }
  return { ok: true, scopes: [...out] }
}

/** Issue the FIRST token pair for a freshly-authenticated user + session. */
export async function issueFirstPair(opts: {
  userId: string
  vendorId: string
  sessionId: string
  scopes: string[]
}): Promise<IssuedTokenPair> {
  return issuePair({ ...opts, familyId: crypto.randomUUID() })
}

export type RefreshOutcome =
  | { ok: true; pair: IssuedTokenPair }
  | { ok: false; status: 401 | 400; reason: string; reuseDetected?: boolean }

/** Rotate a refresh token. Reuse of a rotated token revokes the whole family. */
export async function rotateRefreshToken(raw: string): Promise<RefreshOutcome> {
  const row = await db.apiRefreshToken.findUnique({ where: { tokenHash: sha256Hex(raw) } })
  if (!row) return { ok: false, status: 401, reason: "Invalid refresh token" }
  if (row.revokedAt) {
    // REUSE — a rotated token being presented again means the token leaked:
    // kill the family and the session it rode on.
    await db.apiRefreshToken.updateMany({
      where: { familyId: row.familyId, revokedAt: null },
      data: { revokedAt: new Date() },
    }).catch(() => {})
    await db.session.deleteMany({ where: { id: row.sessionId } }).catch(() => {})
    return { ok: false, status: 401, reason: "Refresh token reuse detected — this token family has been revoked. Re-authenticate.", reuseDetected: true }
  }
  if (row.expiresAt.getTime() <= Date.now()) {
    return { ok: false, status: 401, reason: "Refresh token expired — re-authenticate." }
  }
  const user = await db.user.findUnique({ where: { id: row.userId }, select: { id: true, vendorId: true, status: true } })
  if (!user || user.status !== "ACTIVE") {
    return { ok: false, status: 401, reason: "The account is no longer active." }
  }
  // the session may have expired under the refresh token's lifetime — mint a
  // fresh one (the refresh token IS the standing credential; sessions rotate)
  let sessionId = row.sessionId
  const session = await db.session.findUnique({ where: { id: row.sessionId }, select: { id: true, kind: true, expiresAt: true } })
  if (!session || session.kind !== "FULL" || session.expiresAt.getTime() <= Date.now()) {
    const { createSession } = await import("@/hrm-server/auth")
    const renewed = await createSession({ id: user.id, vendorId: user.vendorId })
    // SEC-02 (R5) — store the ROW id (not the credential) as the family's
    // session reference; same value shape legacy rows already carry.
    sessionId = renewed.id
  }
  await db.apiRefreshToken.update({ where: { id: row.id }, data: { revokedAt: new Date(), lastUsedAt: new Date() } })
  let scopes: string[] = []
  try {
    const v = JSON.parse(row.scopesJson || "[]")
    if (Array.isArray(v)) scopes = v.map(String)
  } catch { /* corrupt row — fall back to read scopes */ }
  if (!scopes.length) scopes = [...READ_SCOPES]
  const pair = await issuePair({
    userId: user.id, vendorId: user.vendorId, sessionId, scopes, familyId: row.familyId,
  })
  return { ok: true, pair }
}

/** SEC-01 (R5) — who may mint user tokens, RESOLVED THROUGH THE ROLE TEMPLATE.
 *  The old rule treated ANY non-EMPLOYEE role with default (empty) grants as
 *  token-entitled, so a branch manager could self-mint tenant-wide API access.
 *  Resolution now mirrors getCtxFromToken: the user's own grants first; an
 *  empty list falls back to the role's EFFECTIVE template (the vendor-scoped
 *  DB Role row when admins customized it, else the static ROLE_TEMPLATES
 *  entry) — and only integrations.view / * on that effective list entitles.
 *  EMPLOYEE templates carry no integrations grants, so ESS stays out. */
export async function mayMintTokensFor(vendorId: string, user: { permissions: string; role: string }): Promise<boolean> {
  let perms: string[] = []
  try {
    const v = JSON.parse(user.permissions || "[]")
    if (Array.isArray(v)) perms = v.map(String)
  } catch { /* corrupt — treat as empty, resolve the template */ }
  if (!perms.length) perms = await roleTemplate(vendorId, user.role)
  return perms.includes("*") || perms.includes("integrations.view")
}

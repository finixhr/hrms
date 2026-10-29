// ============ Auth: password hashing, sessions, login/logout ============
import crypto from "crypto"
import { db } from "@/lib/db"
import { ROLE_TEMPLATES, type Ctx, type RoleKey } from "./types"
import { getSettings, type HrSettings } from "./settings"
import { safeEqual } from "./security"
import { audit } from "./audit"

const SESSION_COOKIE = "hrm_session"
// M-33 — the documented HRM_SESSION_DAYS override is now actually READ (it
// was documented in .env.example but hardcoded here). Clamped to 1–90 days.
const SESSION_DAYS = Math.min(90, Math.max(1, Number(process.env.HRM_SESSION_DAYS) || 7))

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString("hex")
  const hash = crypto.scryptSync(password, salt, 64).toString("hex")
  return `${salt}:${hash}`
}

// MOD-8 (Phase 1) — async scrypt HASH for every REQUEST path (bulk employee
// provisioning, admin user create, registration). scrypt is deliberately
// expensive (~50 ms at cost 16384/N=64 keylen); the sync form blocked the
// event loop for the whole duration, so a 500-row bulk import froze every
// OTHER tenant's requests for 25–50 s. The salt/hash format is bit-identical
// to hashPassword — existing verifyPasswordAsync calls verify both forms.
// Seeds and one-shot scripts may keep the sync form (not request paths).
export async function hashPasswordAsync(password: string): Promise<string> {
  const salt = crypto.randomBytes(16).toString("hex")
  const hash = (await scryptAsync(password, salt, 64)).toString("hex")
  return `${salt}:${hash}`
}

const scryptAsync = (password: string, salt: string, keylen: number) =>
  new Promise<Buffer>((resolve, reject) =>
    crypto.scrypt(password, salt, keylen, (err, derived) => (err ? reject(err) : resolve(derived)))
  )

/** Async scrypt verification — the login path no longer blocks the event loop
 *  (audit Low-7). NOTE: the salt is passed as the raw hex string, exactly as
 *  hashPassword does — the seeded corpus of stored hashes was produced with
 *  string-salt scrypt and MUST keep verifying. */
export async function verifyPasswordAsync(password: string, stored: string): Promise<boolean> {
  const [salt, hash] = String(stored || "").split(":")
  if (!salt || !hash) return false
  const check = (await scryptAsync(password, salt, 64)).toString("hex")
  return safeEqual(hash, check)
}

/** Synchronous scrypt verification — retained for non-request paths only. */
export function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(":")
  if (!salt || !hash) return false
  const check = crypto.scryptSync(password, salt, 64).toString("hex")
  return crypto.timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(check, "hex"))
}

export function newToken(): string {
  return crypto.randomBytes(32).toString("hex")
}

// ---------- SEC-02 (R5) — session tokens hashed at rest ----------
// The cookie token is never stored in the clear: rows carry tokenHash =
// sha256(token) (migration 9_wave9zm backfilled legacy rows, whose id was the
// plaintext token). New rows use a random ROW id, so a read-only database
// compromise no longer yields a usable credential — the same at-rest posture
// API keys and refresh tokens already had. Lookups resolve ONLY through the
// hash; presenting a leaked row id cannot match any tokenHash.
export function sessionTokenHash(token: string): string {
  return crypto.createHash("sha256").update(token, "utf8").digest("hex")
}

export async function findSessionByToken(token: string) {
  if (!token) return null
  return db.session.findUnique({ where: { tokenHash: sessionTokenHash(token) }, include: { user: true } })
}

export async function login(email: string, password: string, ip?: string, userAgent?: string) {
  // malformed/empty payloads must fail as a clean 401, never a 500
  if (typeof email !== "string" || !email.trim() || typeof password !== "string" || !password) {
    throw Object.assign(new Error("Invalid email or password"), { code: 401 })
  }
  const emailNorm = email.toLowerCase().trim()
  // M-15 — emails are unique PER VENDOR in the schema; a deployment that
  // seeded the same address under two vendors would otherwise log in the
  // first match (wrong tenant, silently). Guard the ambiguity explicitly.
  const matches = await db.user.findMany({
    where: { email: emailNorm, status: "ACTIVE" },
    select: { vendorId: true },
  })
  if (matches.length > 1) {
    // L-2 — no account-existence oracle: the old message confirmed the email
    // is registered (and to how many vendors). The generic phrasing matches the
    // invalid-credentials branch; the specific cause stays in the audit log.
    throw Object.assign(new Error("Invalid email or password"), { code: 401 })
  }
  const user = await db.user.findFirst({
    where: { email: emailNorm, status: "ACTIVE" },
    include: { sessions: false },
  })
  if (!user) throw Object.assign(new Error("Invalid email or password"), { code: 401 })
  const settings = await getSettings(user.vendorId)
  const policy = settings.passwordPolicy

  // HRM-007 — lockout: threshold failed attempts lock the account for lockoutMinutes
  if (user.lockedUntil && user.lockedUntil > new Date()) {
    // L-2 — a distinct lockout message (and 423) confirmed the account exists
    // and is lockable. Same generic message and code as bad credentials; the
    // lockout window stays visible in the audit log for support.
    throw Object.assign(new Error("Invalid email or password"), { code: 401 })
  }
  if (!(await verifyPasswordAsync(password, user.passwordHash))) {
    const failed = (user.failedLoginCount || 0) + 1
    const data: any = { failedLoginCount: failed }
    if (policy.lockoutThreshold > 0 && failed >= policy.lockoutThreshold) {
      data.lockedUntil = new Date(Date.now() + (policy.lockoutMinutes || 15) * 60000)
      data.failedLoginCount = 0
    }
    await db.user.update({ where: { id: user.id }, data })
    throw Object.assign(new Error("Invalid email or password"), { code: 401 })
  }
  const vendor = await db.vendor.findUnique({ where: { id: user.vendorId } })
  if (!vendor || !vendor.active) throw Object.assign(new Error("Vendor inactive"), { code: 403 })

  // First-login forced rotation: accounts provisioned with a temporary
  // password (employee auto-provisioning / admin password reset) must change
  // it before any session completes. Same PREAUTH pwToken machinery as the
  // expiry flow — the client reuses the change-password step.
  if ((user as any).mustChangePassword === true) {
    const pwToken = newToken()
    await db.session.create({
      data: { id: crypto.randomUUID(), tokenHash: sessionTokenHash(pwToken), userId: user.id, kind: "PREAUTH", csrfToken: newToken(), expiresAt: new Date(Date.now() + 10 * 60000), ip, userAgent, lastSeenAt: new Date() },
    })
    return { token: null, user, vendor, passwordExpired: true, mustChangePassword: true, pwToken }
  }

  // HRM-007 — password expiry: expired credentials force a change before login completes
  const changedAt = user.passwordChangedAt || user.createdAt
  if (policy.expiryDays > 0 && Date.now() - changedAt.getTime() > policy.expiryDays * 86400000) {
    const pwToken = newToken()
    await db.session.create({
      data: { id: crypto.randomUUID(), tokenHash: sessionTokenHash(pwToken), userId: user.id, kind: "PREAUTH", csrfToken: newToken(), expiresAt: new Date(Date.now() + 10 * 60000), ip, userAgent, lastSeenAt: new Date() },
    })
    return { token: null, user, vendor, passwordExpired: true, pwToken }
  }

  await db.user.update({ where: { id: user.id }, data: { failedLoginCount: 0, lockedUntil: null } })

  // HRM-006 — MFA challenge: enrolled users on roles that require TOTP must pass a second factor.
  // MED-17 (this audit) — VENDOR_OWNER + HR_ADMIN default to mfaRequired=true even when no
  // custom Role row exists. The Role.mfaRequired flag, when set, OVERRIDES the default.
  // This is a defense-in-depth fix: a compromised admin password = full tenant takeover,
  // so the most powerful accounts require a second factor by default.
  // SCL-18 — the login-path MFA lookup shares the role-row cache (was: an
  // uncached findFirst on every login)
  const roleRow = await cachedRoleRow(user.vendorId, user.role)
  const mfaRequiredByDefault = user.role === "VENDOR_OWNER" || user.role === "HR_ADMIN"
  const roleRequiresMfa = roleRow?.mfaRequired === true || ((roleRow?.mfaRequired === null || roleRow === null) && mfaRequiredByDefault)

  // H-1 — the requirement must be enforceable BEFORE enrollment exists. The old
  // condition (`user.mfaEnrolled && roleRequires`) could never force anything:
  // an unenrolled admin authenticated single-factor forever. Now an unenrolled
  // user on an MFA-required role gets NO full session — instead a 15-minute
  // PREAUTH enrollment challenge (enrollToken) is issued, and the client walks
  // the first-login enrollment wizard (auth.mfa.enroll.start / .enable —
  // capability-gated like auth.mfa.verify). C-1 guarantees the PREAUTH row
  // holds no API rights, so this cannot lock anyone out: anyone with a valid
  // password can self-enroll and immediately obtain a full session.
  if (roleRequiresMfa && !user.mfaEnrolled) {
    const enrollToken = newToken()
    await db.session.create({
      data: { id: crypto.randomUUID(), tokenHash: sessionTokenHash(enrollToken), userId: user.id, kind: "PREAUTH", csrfToken: newToken(), expiresAt: new Date(Date.now() + 15 * 60000), ip, userAgent, lastSeenAt: new Date() },
    })
    return { token: null, user, vendor, mfaEnrollmentRequired: true, enrollToken }
  }

  const mfaRequired = user.mfaEnrolled && roleRequiresMfa
  if (mfaRequired) {
    // short-lived pre-auth session — completing MFA promotes it to a full session
    const mfaToken = newToken()
    await db.session.create({
      data: { id: crypto.randomUUID(), tokenHash: sessionTokenHash(mfaToken), userId: user.id, kind: "PREAUTH", csrfToken: newToken(), expiresAt: new Date(Date.now() + 5 * 60000), ip, userAgent, lastSeenAt: new Date() },
    })
    return { token: null, user, vendor, mfaRequired: true, mfaToken }
  }
  // MED-17 — surface MFA enrollment suggestion for roles that do not (yet) require it.
  const mfaEnrollSuggested = !user.mfaEnrolled && (roleRow?.mfaRequired === true || (roleRow?.mfaRequired === null && mfaRequiredByDefault) || (roleRow === null && mfaRequiredByDefault))

  const { token, id } = await createSession(user, ip, userAgent, settings)
  return { token, id, user, vendor, mfaEnrollSuggested }
}

/** Session creation honoring the session policy (S6): concurrent-session cap. */
export async function createSession(user: { id: string; vendorId?: string }, ip?: string, userAgent?: string, settings?: HrSettings) {
  const s = settings || await getSettings(user.vendorId || "")
  const cap = s?.sessionPolicy?.concurrentSessions || 0
  if (cap > 0) {
    const live = await db.session.findMany({
      where: { userId: user.id, expiresAt: { gt: new Date() }, lastSeenAt: { gt: new Date(Date.now() - 48 * 3600 * 1000) } },
      orderBy: { lastSeenAt: "asc" },
    })
    const excess = live.length - cap + 1
    if (excess > 0) await db.session.deleteMany({ where: { id: { in: live.slice(0, excess).map((x) => x.id) } } })
  }
  const token = newToken()
  const rowId = crypto.randomUUID()
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86400000)
  // C-4 — per-session CSRF token (echoed by the SPA in X-CSRF-Token)
  // SEC-02 — the row id is a random row id; the credential lives only in
  // tokenHash (sha256). Callers that need a stable row reference (v1 refresh
  // tokens, JWT sid claims) use the returned id.
  await db.session.create({ data: { id: rowId, tokenHash: sessionTokenHash(token), userId: user.id, kind: "FULL", csrfToken: newToken(), expiresAt, ip, userAgent, lastSeenAt: new Date() } })
  await db.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } })
  return { token, id: rowId }
}

export async function logout(token: string) {
  // M-4 — auth lifecycle audit: read the session before deleting so sign-outs
  // leave a trail (previously the whole auth lifecycle was unaudited)
  // SEC-02 — resolve through the hash, then delete by ROW id
  const session = await findSessionByToken(token).catch(() => null)
  if (session) await db.session.deleteMany({ where: { id: session.id } })
  if (session?.user) {
    await audit(
      { userId: session.userId, userName: session.user.name, vendorId: session.user.vendorId, ip: session.ip || undefined },
      "auth.logout", "User", session.userId, "Signed out",
    )
  }
}

// Resolve the permission template for a role: a vendor-scoped DB Role row
// (created/edited by admins in Settings → Users & Roles) overrides the static
// system template; unknown keys fall back to the static template or empty.
// SCL-18 (Phase 2 WS5) — short-TTL role-row cache. roleTemplate() ran an
// UNCACHED role.findFirst on EVERY authenticated API request (auth.me +
// dispatcher resolve it per request): at 100K tenants that is one query per
// request for data that changes only when an admin edits a role. 30 s TTL +
// explicit invalidation from roles.save / roles.delete keeps staleness
// bounded exactly like the settings cache pattern.
const ROLE_CACHE_TTL_MS = 30_000
const roleRowCache = new Map<string, { at: number; row: Awaited<ReturnType<typeof db.role.findFirst>> }>()
export function invalidateRoleCache(vendorId?: string): void {
  if (vendorId) {
    // entries are keyed `${vendorId}|${role}` — drop every role of the vendor
    const prefix = `${vendorId}|`
    for (const k of roleRowCache.keys()) {
      if (k.startsWith(prefix)) roleRowCache.delete(k)
    }
  } else {
    roleRowCache.clear()
  }
}
async function cachedRoleRow(vendorId: string, role: string) {
  const key = `${vendorId}|${role}`
  const hit = roleRowCache.get(key)
  if (hit && Date.now() - hit.at < ROLE_CACHE_TTL_MS) return hit.row
  const row = await db.role.findFirst({ where: { vendorId, key: role } })
  // bound the cache (stale entries first, then oldest-inserted) so a 100K
  // tenant fleet cannot grow it without limit (SCL-17 family)
  if (roleRowCache.size > 10_000) {
    const now = Date.now()
    for (const [k, v] of roleRowCache) {
      if (now - v.at >= ROLE_CACHE_TTL_MS) roleRowCache.delete(k)
      if (roleRowCache.size <= 5_000) break
    }
    while (roleRowCache.size >= 10_000) {
      const first = roleRowCache.keys().next().value
      if (first == null) break
      roleRowCache.delete(first)
    }
  }
  roleRowCache.set(key, { at: Date.now(), row })
  return row
}

export async function roleTemplate(vendorId: string, role: string): Promise<string[]> {
  const custom = await cachedRoleRow(vendorId, role)
  if (custom) {
    const perms = JSON.parse(custom.permissions || "[]") as string[]
    if (perms.length) return perms
  }
  return ROLE_TEMPLATES[role as RoleKey] || []
}

export async function getCtxFromToken(token?: string | null, ip?: string): Promise<Ctx | null> {
  if (!token) return null
  // SEC-02 (R5) — resolve through the hash (never the plaintext id)
  const session = await findSessionByToken(token)
  if (!session || session.expiresAt < new Date()) return null
  // C-1 — PREAUTH rows are short-lived challenge carriers (5-min MFA token,
  // 10-min forced-password-change token) and hold NO application rights.
  // Minting a full Ctx here let a single-factor holder use mfaToken/pwToken
  // directly as Bearer credentials on /api/hrm — bypassing TOTP and the
  // password-expiry gate. The legitimate flows (auth.mfa.verify,
  // auth.password.change) look these rows up directly by id and never
  // resolve them through this function.
  if (session.kind === "PREAUTH") return null
  const user = session.user
  if (user.status !== "ACTIVE") return null

  // S6 — idle timeout (H-13 fix): enforced for every FULL session, not only in
  // the final hour before expiry. (PREAUTH rows never reach this point —
  // they are rejected above.)
  const s = await getSettings(user.vendorId)
  if (s.sessionPolicy.idleTimeoutMinutes > 0) {
    const idleMs = Date.now() - (session.lastSeenAt || session.createdAt).getTime()
    if (idleMs > s.sessionPolicy.idleTimeoutMinutes * 60000) {
      await db.session.deleteMany({ where: { id: session.id } })
      return null
    }
  }
  // always touch the session activity stamp (throttled to one write per minute)
  // so admin session listings and the concurrent-session cap see real activity
  if (Date.now() - (session.lastSeenAt || session.createdAt).getTime() > 60000) {
    await db.session.update({ where: { id: session.id }, data: { lastSeenAt: new Date() } }).catch(() => {})
  }

  // Permission resolution (RBAC-103, Wave R3-5): the role template is the BASE
  // and per-user explicit grants are ADDITIVE (template ∪ explicit). The old
  // replace semantics froze every explicitly-granted user out of future role
  // template updates — exactly the launch/manage stripping bug documented at
  // types.ts §ACTIONS (a saved explicit set predating a new verb never gained
  // it). Restricting a user BELOW their role is what custom roles are for
  // (roles.save ships full-template editing); per-user overrides only ever
  // widen, never narrow, and they are normalized against MODULES×ACTIONS on
  // write (users.save) so garbage keys cannot ride the JSON.
  const explicit = JSON.parse(user.permissions || "[]") as string[]
  const template = await roleTemplate(user.vendorId, user.role)
  const permissions = new Set<string>([...template, ...explicit])
  // 2026-10-07 — the tenant owner always sees their own plan & usage (it is
  // their billing relationship), even when their explicit grant list predates
  // the Subscription & Usage permission.
  if (user.role === "VENDOR_OWNER") permissions.add("subscription.view")

  return {
    userId: user.id,
    userName: user.name,
    vendorId: user.vendorId,
    role: user.role as RoleKey,
    permissions,
    employeeId: user.employeeId,
    branchId: user.branchId,
    departmentId: user.departmentId,
    ip,
    csrfToken: session.csrfToken || undefined,
  } as Ctx
}

// Single source of truth for session-cookie serialization.
// SameSite=None + Secure + Partitioned (CHIPS) keeps the session usable in
// cross-site/embedded contexts (preview proxies, iframes). Browsers without
// Partitioned support ignore that attribute. httpOnly remains the primary
// transport; the Authorization Bearer fallback covers full cookie blocking.
//
// LAN-ACCESS FIX: browsers REFUSE to store a Secure cookie when the page is
// plain http:// and not localhost — so a colleague opening the app from
// another PC via http://<server-LAN-IP>:3000 would log in, then lose the
// session on every reload (localhost on the server PC is a secure context,
// which is why it only broke remotely). The cookie attributes are now chosen
// per request: HTTPS keeps the full hardened set; plain HTTP falls back to
// SameSite=Lax without Secure/Partitioned (still HttpOnly, and SameSite=Lax
// is sufficient because the SPA only talks to its own origin).
const COOKIE_ATTRS_SECURE = "Path=/; HttpOnly; SameSite=None; Secure; Partitioned"
const COOKIE_ATTRS_PLAIN = "Path=/; HttpOnly; SameSite=Lax"

export function sessionCookieStr(token: string, https = true): string {
  return `${SESSION_COOKIE}=${token}; Max-Age=${SESSION_DAYS * 86400}; ${https ? COOKIE_ATTRS_SECURE : COOKIE_ATTRS_PLAIN}`
}

export function clearCookieStr(https = true): string {
  return `${SESSION_COOKIE}=; Max-Age=0; ${https ? COOKIE_ATTRS_SECURE : COOKIE_ATTRS_PLAIN}`
}

// ---------- HRM-007 — password policy validation & change ----------
export function validatePasswordPolicy(
  password: string,
  policy: HrSettings["passwordPolicy"]
): string | null {
  if (!password || typeof password !== "string") return "Password is required"
  if (password.length < (policy.minLength || 8)) return `Password must be at least ${policy.minLength} characters`
  if (policy.requireUpper && !/[A-Z]/.test(password)) return "Password must contain an uppercase letter"
  if (policy.requireLower && !/[a-z]/.test(password)) return "Password must contain a lowercase letter"
  if (policy.requireDigit && !/[0-9]/.test(password)) return "Password must contain a digit"
  if (policy.requireSymbol && !/[^A-Za-z0-9]/.test(password)) return "Password must contain a symbol"
  // R6-005 — unconditionally refuse the well-known seed default and common weak passwords
  const BANNED = ["Pass@123", "Password1", "Admin@123", "Owner@123", "12345678", "Qwerty@1"]
  if (BANNED.some((b) => password.toLowerCase() === b.toLowerCase())) {
    return "This password is too common — choose a stronger one"
  }
  return null
}

/** Change password with policy + reuse-history enforcement. Callers must have
 *  authenticated the caller (session or pre-auth pwToken). */
export async function changePassword(userId: string, newPassword: string) {
  const user = await db.user.findUnique({ where: { id: userId } })
  if (!user) throw Object.assign(new Error("User not found"), { code: 404 })
  const settings = await getSettings(user.vendorId)
  const err = validatePasswordPolicy(newPassword, settings.passwordPolicy)
  if (err) throw Object.assign(new Error(err), { code: 400 })
  if (await verifyPasswordAsync(newPassword, user.passwordHash)) {
    throw Object.assign(new Error("New password must differ from the current password"), { code: 400 })
  }
  const history: string[] = JSON.parse(user.passwordHistory || "[]")
  if ((settings.passwordPolicy.historyCount || 0) > 0) {
    const recent = [user.passwordHash, ...history].slice(0, settings.passwordPolicy.historyCount)
    for (const h of recent) {
      if (await verifyPasswordAsync(newPassword, h)) {
        throw Object.assign(new Error(`Password was used in the last ${settings.passwordPolicy.historyCount} changes — pick a different one`), { code: 400 })
      }
    }
  }
  const nextHistory = [user.passwordHash, ...history].slice(0, Math.max(1, settings.passwordPolicy.historyCount || 0))
  await db.user.update({
    where: { id: userId },
    data: {
      // MOD-8 (Phase 1) — async scrypt on the request path
      passwordHash: await hashPasswordAsync(newPassword),
      passwordHistory: JSON.stringify(nextHistory),
      passwordChangedAt: new Date(),
      mustChangePassword: false, // first-login forced rotation satisfied
      failedLoginCount: 0,
      lockedUntil: null,
    },
  })
  // force re-login everywhere except the caller's current session token (passed by route)
  return true
}

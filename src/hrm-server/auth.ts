// ============ Auth: password hashing, sessions, login/logout ============
import crypto from "crypto"
import { db } from "@/lib/db"
import { ROLE_TEMPLATES, type Ctx, type RoleKey } from "./types"
import { getSettings, type HrSettings } from "./settings"
import { safeEqual } from "./security"
import { audit } from "./audit"
import { resolveActiveCompany, resolveCompanyAccess } from "./company"

const SESSION_COOKIE = "hrm_session"
// M-33 — the documented HRM_SESSION_DAYS override is now actually READ (it
// was documented in .env.example but hardcoded here). Clamped to 1–90 days.
const SESSION_DAYS = Math.min(90, Math.max(1, Number(process.env.HRM_SESSION_DAYS) || 7))

// GAP-313 — hash format rotation. New hashes use N=2^15 and carry the cost in the
// stored value ("n32768:salt:hash"); the legacy "salt:hash" form (N=2^14) keeps
// verifying and is upgraded the next time its owner logs in, so no flag day and no
// forced password reset. maxmem is explicit because 128*N*r is above Node's default.
const SCRYPT_N = 32768
const SCRYPT_PREFIX = `n${SCRYPT_N}`
const SCRYPT_OPTS = { N: SCRYPT_N, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString("hex")
  const hash = crypto.scryptSync(password, salt, 64, SCRYPT_OPTS).toString("hex")
  return `${SCRYPT_PREFIX}:${salt}:${hash}`
}

/** True when a stored hash predates the current cost and should be re-hashed. */
export function passwordNeedsRehash(stored: string): boolean {
  return !String(stored || "").startsWith(`${SCRYPT_PREFIX}:`)
}

// MOD-8 (Phase 1) — async scrypt HASH for every REQUEST path (bulk employee
// provisioning, admin user create, registration). scrypt is deliberately
// expensive (~100 ms at the current cost); the sync form blocked the
// event loop for the whole duration, so a 500-row bulk import froze every
// OTHER tenant's requests for 25–50 s. The salt/hash format is bit-identical
// to hashPassword — existing verifyPasswordAsync calls verify both forms.
// Seeds and one-shot scripts may keep the sync form (not request paths).
export async function hashPasswordAsync(password: string): Promise<string> {
  const salt = crypto.randomBytes(16).toString("hex")
  const hash = (await scryptAsync(password, salt, 64, SCRYPT_OPTS)).toString("hex")
  return `${SCRYPT_PREFIX}:${salt}:${hash}`
}

const scryptAsync = (password: string, salt: string, keylen: number, opts: crypto.ScryptOptions = {}) =>
  new Promise<Buffer>((resolve, reject) =>
    crypto.scrypt(password, salt, keylen, opts, (err, derived) => (err ? reject(err) : resolve(derived)))
  )

/** Async scrypt verification — the login path no longer blocks the event loop
 *  (audit Low-7). NOTE: the salt is passed as the raw hex string, exactly as
 *  hashPassword does — the seeded corpus of stored hashes was produced with
 *  string-salt scrypt and MUST keep verifying. */
export async function verifyPasswordAsync(password: string, stored: string): Promise<boolean> {
  const parts = String(stored || "").split(":")
  const current = parts.length === 3 && parts[0] === SCRYPT_PREFIX
  const [salt, hash] = current ? parts.slice(1) : parts
  if (!salt || !hash) return false
  const check = (await scryptAsync(password, salt, 64, current ? SCRYPT_OPTS : {})).toString("hex")
  return safeEqual(hash, check)
}

/** Synchronous scrypt verification — retained for non-request paths only. */
export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split(":")
  const current = parts.length === 3 && parts[0] === SCRYPT_PREFIX
  const [salt, hash] = current ? parts.slice(1) : parts
  if (!salt || !hash) return false
  const check = crypto.scryptSync(password, salt, 64, current ? SCRYPT_OPTS : {}).toString("hex")
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

export async function login(email: string, password: string, ip?: string, userAgent?: string, workspace?: string) {
  // malformed/empty payloads must fail as a clean 401, never a 500
  if (typeof email !== "string" || !email.trim() || typeof password !== "string" || !password) {
    throw Object.assign(new Error("Invalid email or password"), { code: 401 })
  }
  const emailNorm = email.toLowerCase().trim()
  // M-15 — emails are unique PER VENDOR in the schema, so the same address
  // can legitimately exist under several vendors (HR-created users collide
  // across tenants even though registration blocks a NEW org with a used
  // email). AUDIT M-8 (2026-11-07) — the ambiguity is now resolved AFTER the
  // password is proven instead of being an unconditional dead end:
  //   • the OLD behavior refused ambiguous emails outright (login impossible,
  //     and forgot-password reset only the FIRST match — a functional lockout
  //     with no message that ever explained it), and it did so BEFORE the
  //     password check, so a fast-failing request was itself an oracle that
  //     the email is registered in ≥2 vendors;
  //   • NOW: every active candidate's password is verified; exactly one
  //     verified account ⇒ straight in (the common case — different tenants
  //     mean different passwords); several verified (one password reused
  //     across workspaces) ⇒ the caller is asked to PICK the workspace
  //     (`ambiguous` result — the list may only be revealed after the
  //     password proved, so it is not an account-existence oracle);
  //     `workspace` (vendor code) then selects it on the retry.
  const matches = await db.user.findMany({
    where: { email: emailNorm, status: "ACTIVE" },
  })
  if (matches.length === 0) {
    // L-2 — generic phrasing; never an account-existence oracle.
    throw Object.assign(new Error("Invalid email or password"), { code: 401 })
  }

  let user: (typeof matches)[number] | null = null

  if (matches.length === 1) {
    user = matches[0]
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
      // AUDIT L-5 (2026-11-07) — PROGRESSIVE DELAY before the failure is
      // reported: each consecutive wrong password adds 0.5s (capped at 5s),
      // so scripted guessing gets measurably slower while a legitimate user
      // with one typo waits at most half a second. This complements — not
      // replaces — the per-account hard lockout below, and mitigates the
      // L-5 concern that the hard lockout alone is a denial-of-service
      // primitive against known admin emails (anyone could keep them locked).
      // The sleep is async (never blocks the event loop).
      const delayMs = Math.min(5000, (user.failedLoginCount || 0) * 500)
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs))
      const failed = (user.failedLoginCount || 0) + 1
      const data: any = { failedLoginCount: failed }
      if (policy.lockoutThreshold > 0 && failed >= policy.lockoutThreshold) {
        data.lockedUntil = new Date(Date.now() + (policy.lockoutMinutes || 15) * 60000)
        data.failedLoginCount = 0
      }
      await db.user.update({ where: { id: user.id }, data })
      throw Object.assign(new Error("Invalid email or password"), { code: 401 })
    }
  } else {
    // ---- AUDIT M-8 — ambiguous email across vendors: resolve by proof ----
    const now = new Date()
    const candidates = matches.filter((u) => !(u.lockedUntil && u.lockedUntil > now))
    const verified: (typeof matches)[number][] = []
    for (const u of candidates) {
      if (await verifyPasswordAsync(password, u.passwordHash)) verified.push(u)
    }
    if (verified.length === 0) {
      // No increment / lockout on the ambiguous path (several accounts share
      // this inbox; a wrong password must not lock an arbitrary one of them).
      throw Object.assign(new Error("Invalid email or password"), { code: 401 })
    }
    if (verified.length > 1 && !workspace) {
      // Password proven — the workspace list is safe to disclose now. Only
      // ACTIVE vendors are listed; an all-inactive set is a plain 401/403.
      const vendors = await db.vendor.findMany({
        where: { id: { in: verified.map((u) => u.vendorId) }, active: true },
        select: { code: true, name: true },
        orderBy: { name: "asc" },
      })
      if (vendors.length === 0) throw Object.assign(new Error("Vendor inactive"), { code: 403 })
      return { ambiguous: true, workspaces: vendors.map((v) => ({ code: v.code, name: v.name })) }
    }
    if (verified.length === 1) {
      user = verified[0]
    } else {
      const chosen = await db.vendor.findFirst({
        where: { code: String(workspace || "").trim(), id: { in: verified.map((u) => u.vendorId) }, active: true },
        select: { id: true },
      })
      if (!chosen) {
        throw Object.assign(new Error("Unknown workspace — pick one of the workspaces shown for this account"), { code: 400 })
      }
      user = verified.find((u) => u.vendorId === chosen.id) || null
    }
    if (!user) throw Object.assign(new Error("Invalid email or password"), { code: 401 })
  }

  // ---- shared post-verification flow (single- and multi-vendor paths) ----
  const vendor = await db.vendor.findUnique({ where: { id: user.vendorId } })
  if (!vendor || !vendor.active) throw Object.assign(new Error("Vendor inactive"), { code: 403 })
  // policy/settings resolve ONCE for the shared tail (the single-match branch
  // already fetched them for the lockout check; getSettings is cached)
  const settings = await getSettings(user.vendorId)
  const policy = settings.passwordPolicy

  // GAP-313 — the password just verified, so its hash can move to the current cost.
  // Best effort: a failed upgrade must never fail the login; the next one retries.
  if (passwordNeedsRehash(user.passwordHash)) {
    const upgraded = await hashPasswordAsync(password)
    await db.user.updateMany({ where: { id: user.id, passwordHash: user.passwordHash }, data: { passwordHash: upgraded } }).catch(() => {})
  }

  // First-login forced rotation: accounts provisioned with a temporary
  // password (employee auto-provisioning / admin password reset) must change
  // it before any session completes. Same PREAUTH pwToken machinery as the
  // expiry flow — the client reuses the change-password step.
  // AUDIT H-2 (2026-11-07) — dedicated PWCHANGE kind: auth.password.change now
  // accepts ONLY this kind as a pwToken. The old shared "PREAUTH" kind let
  // the 5-minute MFA challenge token and the 15-minute enrollment token act
  // as password-change capabilities, so a password-only attacker on an
  // MFA-protected account could rotate the password and revoke every session
  // of the real user. Challenge kinds are now disjoint: PWCHANGE (password
  // rotation) · MFA_CHALLENGE (second factor) · MFA_ENROLL (first enrollment).
  if ((user as any).mustChangePassword === true) {
    const pwToken = newToken()
    await db.session.create({
      data: { id: crypto.randomUUID(), tokenHash: sessionTokenHash(pwToken), userId: user.id, kind: "PWCHANGE", csrfToken: newToken(), expiresAt: new Date(Date.now() + 10 * 60000), ip, userAgent, lastSeenAt: new Date() },
    })
    return { token: null, user, vendor, passwordExpired: true, mustChangePassword: true, pwToken }
  }

  // HRM-007 — password expiry: expired credentials force a change before login completes
  const changedAt = user.passwordChangedAt || user.createdAt
  if (policy.expiryDays > 0 && Date.now() - changedAt.getTime() > policy.expiryDays * 86400000) {
    const pwToken = newToken()
    await db.session.create({
      data: { id: crypto.randomUUID(), tokenHash: sessionTokenHash(pwToken), userId: user.id, kind: "PWCHANGE", csrfToken: newToken(), expiresAt: new Date(Date.now() + 10 * 60000), ip, userAgent, lastSeenAt: new Date() },
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
      data: { id: crypto.randomUUID(), tokenHash: sessionTokenHash(enrollToken), userId: user.id, kind: "MFA_ENROLL", csrfToken: newToken(), expiresAt: new Date(Date.now() + 15 * 60000), ip, userAgent, lastSeenAt: new Date() },
    })
    return { token: null, user, vendor, mfaEnrollmentRequired: true, enrollToken }
  }

  const mfaRequired = user.mfaEnrolled && roleRequiresMfa
  if (mfaRequired) {
    // short-lived pre-auth session — completing MFA promotes it to a full session
    const mfaToken = newToken()
    await db.session.create({
      data: { id: crypto.randomUUID(), tokenHash: sessionTokenHash(mfaToken), userId: user.id, kind: "MFA_CHALLENGE", csrfToken: newToken(), expiresAt: new Date(Date.now() + 5 * 60000), ip, userAgent, lastSeenAt: new Date() },
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

// GAP-212 — Vendor.active resolved per request behind a short TTL (the same
// shape as the role/settings caches). owner.tenants.suspend/reactivate invalidate
// it, so the kill switch is immediate on this instance and bounded by the TTL on
// any other. Fails closed: a missing vendor row is not active.
const VENDOR_ACTIVE_TTL_MS = 15_000
const VENDOR_ACTIVE_CACHE_MAX = 5_000
const vendorActiveCache = new Map<string, { active: boolean; at: number }>()

export async function vendorIsActive(vendorId: string): Promise<boolean> {
  const hit = vendorActiveCache.get(vendorId)
  if (hit && Date.now() - hit.at < VENDOR_ACTIVE_TTL_MS) return hit.active
  const vendor = await db.vendor.findUnique({ where: { id: vendorId }, select: { active: true } })
  const active = vendor?.active === true
  if (vendorActiveCache.size >= VENDOR_ACTIVE_CACHE_MAX) vendorActiveCache.clear()
  vendorActiveCache.set(vendorId, { active, at: Date.now() })
  return active
}

export function invalidateVendorActive(vendorId: string): void {
  vendorActiveCache.delete(vendorId)
}

export async function getCtxFromToken(token?: string | null, ip?: string): Promise<Ctx | null> {
  if (!token) return null
  // SEC-02 (R5) — resolve through the hash (never the plaintext id)
  const session = await findSessionByToken(token)
  if (!session || session.expiresAt < new Date()) return null
  // C-1 — challenge rows are short-lived capability carriers (5-min MFA
  // challenge, 10-min forced-password-change, 15-min enrollment window) and
  // hold NO application rights. Minting a full Ctx here let a single-factor
  // holder use mfaToken/pwToken directly as Bearer credentials on /api/hrm —
  // bypassing TOTP and the password-expiry gate. The legitimate flows
  // (auth.mfa.verify, auth.password.change, auth.mfa.enroll.*) look these rows
  // up directly by id and never resolve them through this function.
  // AUDIT H-2 (2026-11-07) — fail-closed on EVERY non-FULL kind: the check
  // used to name "PREAUTH" specifically, so any future/legacy challenge kind
  // would have slipped through. Only FULL sessions ever become a Ctx.
  if (session.kind !== "FULL") return null
  const user = session.user
  if (user.status !== "ACTIVE") return null
  // GAP-212 — suspending a tenant ends access for live sessions too, not just
  // new logins (they kept read access for up to the 90-day session lifetime).
  if (!(await vendorIsActive(user.vendorId))) return null

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
  // FIN-081 (Phase 1) — legacy verb expansion for the reports six-permission
  // split (view · pii.view · export · pii.export · schedule · pii.schedule).
  // A held flat reports.pii (roles/users saved before the split) expands into
  // the three split verbs, so nobody loses PII access they were granted and
  // the new route gates (reports.pii.view / .pii.export / .pii.schedule) can
  // be checked directly everywhere. Read-time expansion doubles as the
  // role-seed migration: no stored permission JSON needs rewriting.
  if (permissions.has("reports.pii")) {
    permissions.add("reports.pii.view")
    permissions.add("reports.pii.export")
    permissions.add("reports.pii.schedule")
  }

  // ---- MULTI-COMPANY (2026-11-03) — server-validated company context ----
  // The active company comes from the SESSION row (two sessions of one user
  // may operate in different companies) and is re-validated against the
  // user's live UserCompanyAccess rows on EVERY request — a revoked or
  // deactivated company falls back to the default/employee company, so
  // revoked access takes effect immediately (fail-closed, company.ts).
  const companyCtx = await resolveActiveCompany(session, user)
  const companyAccess = await resolveCompanyAccess(user.id, user.vendorId)
  // All Companies REPORTING context (master prompt Part D): only while the
  // session opted in AND the user STILL holds the tenant-level
  // companies.consolidated permission — the live re-check means a revoked
  // permission exits the mode at the next request (fail-closed).
  // D-2 (W1) — the mode is VENDOR_OWNER-ONLY, re-checked on EVERY request:
  // a session flag forged for (or surviving a role change of) a non-owner
  // dissolves here, before any handler sees a consolidated context.
  // FORENSIC AUDIT 2026-11-10, FIN-016 (Phase 2): the wildcard-blind hole.
  //   Discovered by the phase 2 e2e lane (companies.activate succeeded, the
  //   NEXT auth.me silently dissolved the mode): this inline check demanded
  //   the LITERAL "companies.consolidated" string, while the codebase's
  //   permission semantics (rbac.ts can/require, the client mirror in
  //   store.ts) honor "*" as the full set. A wildcard-permission owner —
  //   the standard seed shape — could enter the mode but never kept it.
  //   The wildcard now widens exactly like can() everywhere else.
  const allCompaniesMode =
    (session as { allCompaniesMode?: boolean }).allCompaniesMode === true &&
    user.role === "VENDOR_OWNER" &&
    (permissions.has("*") || permissions.has("companies.consolidated"))

  return {
    userId: user.id,
    userName: user.name,
    vendorId: user.vendorId,
    role: user.role as RoleKey,
    permissions,
    employeeId: user.employeeId,
    branchId: user.branchId,
    departmentId: user.departmentId,
    activeCompanyId: allCompaniesMode ? null : companyCtx.companyId,
    companyAccess,
    allCompaniesMode,
    companyBranchScope: allCompaniesMode ? null : companyCtx.branchScope ?? null,
    companyDepartmentScope: allCompaniesMode ? null : companyCtx.departmentScope ?? null,
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

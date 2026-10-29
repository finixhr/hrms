// ============ SaaS owner authentication (completely separate plane) ============
// Own table, own cookie (`saas_owner_session`), own CSRF echo, own lockout.
// A tenant Session token can NEVER satisfy an owner lookup and vice versa —
// the two auth planes share nothing but the scrypt format.
//
// 2026-10-04 — owner TOTP MFA + self-service password recovery (mirrors the
// tenant auth discipline: pre-auth challenge sessions, replay-protected TOTP,
// single-use recovery codes, hashed reset tokens, no user enumeration).
import crypto from "crypto"
import QRCode from "qrcode"
import { db } from "@/lib/db"
import { safeEqual } from "../security"
import { rateLimit } from "../security"
import { getSaasSettings } from "./settings"
import { resolveOwnerUserPermissions } from "./owner-roles"
import {
  generateTotpSecret, verifyTotpWithCounter, totpUri,
  encryptSecret, decryptSecret, needsReencrypt, mfaKeyConfigured,
  generateRecoveryCodes, hashCode, matchRecoveryCode,
} from "../totp"
import { saasAudit } from "./audit"

export const OWNER_COOKIE = "saas_owner_session"

/** SEC-02 (R5) — sha256 of an owner session token (the at-rest hash; mirror
 *  of the tenant plane's sessionTokenHash). */
export function ownerSessionTokenHash(token: string): string {
  return crypto.createHash("sha256").update(token, "utf8").digest("hex")
}

/** Session kinds. Only FULL authorizes API calls — the two PENDING kinds are
 *  short-lived pre-auth challenges that prove the PASSWORD but not the second
 *  factor (mirrors the tenant PREAUTH discipline). */
export type OwnerSessionKind = "FULL" | "MFA_PENDING" | "ENROLL_PENDING"
const MFA_CHALLENGE_MS = 5 * 60_000
const ENROLL_CHALLENGE_MS = 10 * 60_000

const scryptAsync = (password: string, salt: string, keylen: number) =>
  new Promise<Buffer>((resolve, reject) =>
    crypto.scrypt(password, salt, keylen, (err, derived) => (err ? reject(err) : resolve(derived)))
  )

export function hashOwnerPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString("hex")
  const hash = crypto.scryptSync(password, salt, 64).toString("hex")
  return `${salt}:${hash}`
}

// MOD-8 (Phase 1) — async twin for every owner-plane REQUEST path (password
// reset, owner create/update). Same `${salt}:${hash}` format as the sync
// form; verifyOwnerPassword verifies both. Seeds keep the sync form.
export async function hashOwnerPasswordAsync(password: string): Promise<string> {
  const salt = crypto.randomBytes(16).toString("hex")
  const hash = (await scryptAsync(password, salt, 64)).toString("hex")
  return `${salt}:${hash}`
}

export async function verifyOwnerPassword(password: string, stored: string): Promise<boolean> {
  const [salt, hash] = String(stored || "").split(":")
  if (!salt || !hash) return false
  const check = (await scryptAsync(password, salt, 64)).toString("hex")
  return safeEqual(hash, check)
}

export type OwnerCtx = {
  ownerId: string
  name: string
  email: string
  roleKey: string
  permissions: Set<string>
  mfaEnrolled?: boolean
  ip?: string
  csrfToken?: string
}

export function ownerCan(ctx: OwnerCtx, perm: string): boolean {
  return ctx.permissions.has(perm)
}

export class OwnerDeny extends Error {
  code: number
  constructor(msg: string, code = 403) {
    super(msg)
    this.code = code
  }
}

export function ownerRequire(ctx: OwnerCtx, perm: string): void {
  if (!ownerCan(ctx, perm)) {
    throw new OwnerDeny(`Permission denied: ${perm} is not granted to your owner role`)
  }
}

/** Resolve a valid owner session token → OwnerCtx, or null.
 *  Only FULL sessions authorize — MFA_PENDING / ENROLL_PENDING challenges
 *  must never satisfy an authenticated lookup (M-16 discipline). */
export async function getOwnerFromToken(token: string | null | undefined): Promise<OwnerCtx | null> {
  if (!token || token.length < 32) return null
  // SEC-02 (R5) — resolve through the hash (never the plaintext id)
  const sess = await db.saasOwnerSession.findUnique({
    where: { tokenHash: ownerSessionTokenHash(token) },
    include: { owner: true },
  })
  if (!sess) return null
  if (sess.kind && sess.kind !== "FULL") return null
  if (sess.expiresAt <= new Date()) {
    await db.saasOwnerSession.delete({ where: { id: sess.id } }).catch(() => {})
    return null
  }
  const owner = sess.owner
  if (owner.status !== "ACTIVE") return null
  // permissions: explicit per-user grants, else the role definition —
  // DB SaasOwnerRole row (Roles & Permissions console, honors active flag)
  // with static-template fallback
  const perms = await resolveOwnerUserPermissions(owner)
  return {
    ownerId: owner.id,
    name: owner.name,
    email: owner.email,
    roleKey: owner.roleKey,
    permissions: new Set(perms),
    mfaEnrolled: !!owner.mfaEnrolled,
    csrfToken: sess.csrfToken,
  }
}

export async function createOwnerSession(
  ownerId: string,
  ip?: string | null,
  userAgent?: string | null,
  kind: OwnerSessionKind = "FULL",
  ttlMs?: number
): Promise<{ token: string; id: string; csrfToken: string; expiresAt: Date; kind: OwnerSessionKind }> {
  const s = await getSaasSettings()
  const days = Math.min(30, Math.max(1, Number(s.security.sessionDays) || 7))
  const token = crypto.randomBytes(32).toString("hex")
  const rowId = crypto.randomUUID()
  const csrfToken = crypto.randomBytes(32).toString("hex")
  const expiresAt = kind === "FULL"
    ? new Date(Date.now() + days * 86400000)
    : new Date(Date.now() + (ttlMs ?? MFA_CHALLENGE_MS))
  // SEC-02 (R5) — id is a random ROW id; the credential lives only in
  // tokenHash (sha256), mirroring the tenant plane.
  await db.saasOwnerSession.create({
    data: { id: rowId, tokenHash: ownerSessionTokenHash(token), ownerId, csrfToken, expiresAt, ip, userAgent, lastSeenAt: new Date(), kind },
  })
  return { token, id: rowId, csrfToken, expiresAt, kind }
}

/** Owner login with lockout (mirrors the tenant auth lockout policy).
 *  Three outcomes:
 *    1. { mfaRequired, mfaToken }      — TOTP enrolled → second factor needed
 *    2. { mfaEnrollmentRequired, enrollToken } — platform requires MFA and this
 *       owner never enrolled → forced first-login enrollment wizard
 *    3. { token, owner, csrfToken, expiresAt } — full session (no MFA configured) */
export async function ownerLogin(email: string, password: string, ip?: string | null, userAgent?: string | null) {
  if (typeof email !== "string" || !email.trim() || typeof password !== "string" || !password) {
    throw Object.assign(new Error("Invalid email or password"), { code: 401 })
  }
  const emailNorm = email.toLowerCase().trim()
  // ---- SEC-5 (Phase 1) — per-IP password-spray throttle ----
  // The per-ACCOUNT lockout below already stops sustained attacks on ONE
  // email, but password SPRAYING (one attempt across MANY owner emails from
  // the same IP) was unthrottled: every attempt hit a fresh account whose
  // failedLoginCount was still zero. Mirrors the tenant plane's H-7 key
  // discipline:
  //   - known (trusted-proxy) IP → per-(ip,email) at 10/5 min + a per-IP
  //     global cap at 20/5 min;
  //   - unknown IP (no HRM_TRUST_PROXY) → the bucket binds to the EMAIL alone,
  //     so a spoofed X-Forwarded-For cannot mint fresh buckets (the per-account
  //     lockout covers the same identity, just more slowly).
  {
    const perPair = `owner-login:pair:${ip || "n"}:${emailNorm.slice(0, 80)}`
    const perIp = `owner-login:ip:${ip || "email:" + emailNorm.slice(0, 80)}`
    if (await rateLimit(perIp, 20, 5 * 60_000) || (ip ? await rateLimit(perPair, 10, 5 * 60_000) : false)) {
      throw Object.assign(new Error("Too many sign-in attempts — wait a few minutes and try again."), { code: 429 })
    }
  }
  const s = await getSaasSettings()
  const owner = await db.saasOwnerUser.findUnique({ where: { email: emailNorm } })
  if (!owner || owner.status !== "ACTIVE") {
    throw Object.assign(new Error("Invalid email or password"), { code: 401 })
  }
  if (owner.lockedUntil && owner.lockedUntil > new Date()) {
    throw Object.assign(new Error("Invalid email or password"), { code: 401 })
  }
  if (!(await verifyOwnerPassword(password, owner.passwordHash))) {
    const failed = (owner.failedLoginCount || 0) + 1
    const data: any = { failedLoginCount: failed }
    const threshold = Math.max(1, Number(s.security.lockoutThreshold) || 5)
    if (failed >= threshold) {
      data.lockedUntil = new Date(Date.now() + (Number(s.security.lockoutMinutes) || 15) * 60000)
      data.failedLoginCount = 0
    }
    await db.saasOwnerUser.update({ where: { id: owner.id }, data })
    throw Object.assign(new Error("Invalid email or password"), { code: 401 })
  }
  await db.saasOwnerUser.update({
    where: { id: owner.id },
    data: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date() },
  })

  // ---- second-factor decision ----
  if (owner.mfaEnrolled) {
    // drop any stale challenge sessions for this owner, then mint a fresh one
    await db.saasOwnerSession.deleteMany({ where: { ownerId: owner.id, kind: { in: ["MFA_PENDING", "ENROLL_PENDING"] } } })
    const ch = await createOwnerSession(owner.id, ip, userAgent, "MFA_PENDING", MFA_CHALLENGE_MS)
    return { mfaRequired: true, mfaToken: ch.token }
  }
  if (s.security.ownerMfaRequired) {
    // platform policy demands MFA and this owner never enrolled — the password
    // already verified, so a self-enrollment window is issued (never a lockout)
    await db.saasOwnerSession.deleteMany({ where: { ownerId: owner.id, kind: { in: ["MFA_PENDING", "ENROLL_PENDING"] } } })
    const ch = await createOwnerSession(owner.id, ip, userAgent, "ENROLL_PENDING", ENROLL_CHALLENGE_MS)
    return { mfaEnrollmentRequired: true, enrollToken: ch.token, owner: { name: owner.name, email: owner.email } }
  }

  const sess = await createOwnerSession(owner.id, ip, userAgent, "FULL")
  return {
    token: sess.token,
    csrfToken: sess.csrfToken,
    expiresAt: sess.expiresAt,
    owner: await ownerPayload(owner),
  }
}

async function ownerPayload(owner: { id: string; name: string; email: string; roleKey: string; permissions: string }) {
  const perms = await resolveOwnerUserPermissions(owner)
  return { id: owner.id, name: owner.name, email: owner.email, roleKey: owner.roleKey, permissions: perms }
}

/** Promote helper: burn a pre-auth challenge session, mint the FULL session. */
async function promoteChallenge(
  sess: { id: string; ownerId: string },
  ip?: string | null,
  userAgent?: string | null
) {
  await db.saasOwnerSession.delete({ where: { id: sess.id } }).catch(() => {})
  await db.saasOwnerSession.deleteMany({ where: { ownerId: sess.ownerId, kind: { in: ["MFA_PENDING", "ENROLL_PENDING"] } } }).catch(() => {})
  await db.saasOwnerUser.update({ where: { id: sess.ownerId }, data: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date() } })
  const full = await createOwnerSession(sess.ownerId, ip, userAgent, "FULL")
  const owner = await db.saasOwnerUser.findUnique({ where: { id: sess.ownerId } })
  if (!owner) throw Object.assign(new Error("Account unavailable"), { code: 401 })
  return { token: full.token, csrfToken: full.csrfToken, expiresAt: full.expiresAt, owner: await ownerPayload(owner) }
}

async function findChallenge(token: string, kind: OwnerSessionKind) {
  if (!token || token.length < 32) throw Object.assign(new Error("Challenge expired — sign in again"), { code: 401 })
  const sess = await db.saasOwnerSession.findUnique({ where: { tokenHash: ownerSessionTokenHash(token) }, include: { owner: true } })
  if (!sess || sess.kind !== kind || sess.expiresAt <= new Date()) {
    throw Object.assign(new Error("Challenge expired — sign in again"), { code: 401 })
  }
  if (sess.owner.status !== "ACTIVE") throw Object.assign(new Error("Account unavailable"), { code: 403 })
  return sess
}

// ============================ OWNER MFA (TOTP) ============================

/** Step 2 of an MFA login: verify the TOTP code (or a single-use recovery
 *  code) against the pending challenge, then mint the full session. */
export async function ownerVerifyMfa(
  mfaToken: string,
  code: string,
  opts: { useRecovery?: boolean; ip?: string | null; userAgent?: string | null } = {}
) {
  if (!mfaToken || !code) throw Object.assign(new Error("Verification code is required"), { code: 400 })
  if (await rateLimit(`owner-mfa:${mfaToken.slice(0, 16)}`, 10, 5 * 60_000)) {
    throw Object.assign(new Error("Too many verification attempts — sign in again"), { code: 429 })
  }
  const sess = await findChallenge(mfaToken, "MFA_PENDING")
  const mfa = await db.saasOwnerMfaSecret.findUnique({ where: { ownerId: sess.ownerId } })
  if (!mfa) throw Object.assign(new Error("MFA is not enrolled for this account"), { code: 400 })

  let ok = false
  let consumedRecoveryHash: string | null = null
  if (opts.useRecovery) {
    if (matchRecoveryCode(String(code), mfa.recoveryCodesHash)) {
      ok = true
      consumedRecoveryHash = hashCode(String(code))
    }
  } else {
    // replay protection: only counters strictly above the last accepted one
    const res = verifyTotpWithCounter(decryptSecret(mfa.secretEnc), String(code))
    ok = res.ok && res.counter > (mfa.lastUsedCounter ?? 0)
    if (ok) await db.saasOwnerMfaSecret.update({ where: { id: mfa.id }, data: { lastUsedCounter: res.counter } })
  }
  if (!ok) throw Object.assign(new Error("Invalid verification code"), { code: 401 })

  // transparent re-encrypt of legacy secrets (H-8 discipline, best-effort)
  if (needsReencrypt(mfa.secretEnc)) {
    try {
      await db.saasOwnerMfaSecret.update({ where: { id: mfa.id }, data: { secretEnc: encryptSecret(decryptSecret(mfa.secretEnc)) } })
    } catch { /* verification already succeeded — migration is optional */ }
  }
  if (consumedRecoveryHash) {
    const rest = (JSON.parse(mfa.recoveryCodesHash || "[]") as string[]).filter((h) => h !== consumedRecoveryHash)
    await db.saasOwnerMfaSecret.update({ where: { id: mfa.id }, data: { recoveryCodesHash: JSON.stringify(rest) } })
  }
  const result = await promoteChallenge(sess, opts.ip, opts.userAgent)
  // S1-003 — MFA step-2 must write a login-audit row; without it the owner
  // console has no forensic record of which MFA challenges succeeded.
  await saasAudit(
    { id: sess.ownerId, name: result.owner?.name ?? sess.ownerId, ip: opts.ip ?? null },
    "owner.mfa.login",
    "SaasOwnerUser",
    sess.ownerId,
    opts.useRecovery ? "Owner MFA login via recovery code" : "Owner MFA login via TOTP"
  )
  return result
}

/** Generate a candidate TOTP secret + QR for a pre-auth enrollment window.
 *  The secret stays INERT until the owner proves it with a live code. */
export async function ownerStartMfaEnroll(enrollToken: string, platformName: string) {
  if (!enrollToken) throw Object.assign(new Error("Enrollment token is required"), { code: 400 })
  if (await rateLimit(`owner-enroll:${enrollToken.slice(0, 16)}`, 10, 15 * 60_000)) {
    throw Object.assign(new Error("Too many attempts — sign in again"), { code: 429 })
  }
  const sess = await findChallenge(enrollToken, "ENROLL_PENDING")
  // factor-replacement guard: an already-enrolled owner must not replace the
  // second factor with a password alone (disable first, from a live session)
  if (sess.owner.mfaEnrolled) {
    throw Object.assign(new Error("MFA is already enabled — sign in and manage it under Platform Settings"), { code: 400 })
  }
  if (!mfaKeyConfigured()) {
    throw Object.assign(new Error("MFA cannot be enrolled because the server encryption key (HRM_MFA_KEY) is not configured"), { code: 500 })
  }
  const secret = generateTotpSecret()
  const uri = totpUri(secret, sess.owner.email, platformName || "Finix HR Owner Console")
  const qrDataUrl = await QRCode.toDataURL(uri, { width: 220, margin: 1 })
  const existing = await db.saasOwnerMfaSecret.findUnique({ where: { ownerId: sess.ownerId } })
  if (existing) {
    await db.saasOwnerMfaSecret.update({ where: { id: existing.id }, data: { secretEnc: encryptSecret(secret), recoveryCodesHash: "[]", lastUsedCounter: 0 } })
  } else {
    await db.saasOwnerMfaSecret.create({ data: { ownerId: sess.ownerId, secretEnc: encryptSecret(secret), recoveryCodesHash: "[]" } })
  }
  return { secret, uri, qrDataUrl }
}

/** Complete a forced first-login enrollment: prove the candidate secret with
 *  a live code, mint recovery codes, promote the challenge to a FULL session. */
export async function ownerCompleteMfaEnroll(
  enrollToken: string,
  code: string,
  opts: { ip?: string | null; userAgent?: string | null } = {}
) {
  if (!enrollToken || !code) throw Object.assign(new Error("Enrollment token and code are required"), { code: 400 })
  if (await rateLimit(`owner-enroll:${enrollToken.slice(0, 16)}`, 10, 15 * 60_000)) {
    throw Object.assign(new Error("Too many attempts — sign in again"), { code: 429 })
  }
  const sess = await findChallenge(enrollToken, "ENROLL_PENDING")
  if (sess.owner.mfaEnrolled) throw Object.assign(new Error("MFA is already enabled for this account"), { code: 400 })
  const mfa = await db.saasOwnerMfaSecret.findUnique({ where: { ownerId: sess.ownerId } })
  if (!mfa) throw Object.assign(new Error("Start MFA enrollment first"), { code: 400 })
  const res = verifyTotpWithCounter(decryptSecret(mfa.secretEnc), String(code))
  if (!res.ok || res.counter <= (mfa.lastUsedCounter ?? 0)) {
    throw Object.assign(new Error("That code did not match — check your authenticator app and try again"), { code: 400 })
  }
  const codes = generateRecoveryCodes()
  await db.saasOwnerMfaSecret.update({
    where: { id: mfa.id },
    data: { lastUsedCounter: res.counter, recoveryCodesHash: JSON.stringify(codes.map((c) => hashCode(c))) },
  })
  await db.saasOwnerUser.update({ where: { id: sess.ownerId }, data: { mfaEnrolled: true } })
  return { ...(await promoteChallenge(sess, opts.ip, opts.userAgent)), recoveryCodes: codes }
}

/** Self-enrollment from a LIVE session (Settings → My account): password
 *  confirmation required, returns the candidate QR. The secret stays inert
 *  until ownerCompleteSelfEnroll proves it with a code. */
export async function ownerStartSelfEnroll(ownerId: string, password: string, platformName?: string) {
  const owner = await db.saasOwnerUser.findUnique({ where: { id: ownerId } })
  if (!owner) throw Object.assign(new Error("Account unavailable"), { code: 401 })
  if (owner.mfaEnrolled) throw Object.assign(new Error("MFA is already enabled — disable it first to re-enroll"), { code: 400 })
  if (!(await verifyOwnerPassword(String(password || ""), owner.passwordHash))) {
    throw Object.assign(new Error("Password confirmation failed"), { code: 401 })
  }
  if (!mfaKeyConfigured()) {
    throw Object.assign(new Error("MFA cannot be enrolled because the server encryption key (HRM_MFA_KEY) is not configured"), { code: 500 })
  }
  const secret = generateTotpSecret()
  const uri = totpUri(secret, owner.email, platformName || "Finix HR Owner Console")
  const qrDataUrl = await QRCode.toDataURL(uri, { width: 220, margin: 1 })
  const existing = await db.saasOwnerMfaSecret.findUnique({ where: { ownerId: ownerId } })
  if (existing) {
    await db.saasOwnerMfaSecret.update({ where: { id: existing.id }, data: { secretEnc: encryptSecret(secret), recoveryCodesHash: "[]", lastUsedCounter: 0 } })
  } else {
    await db.saasOwnerMfaSecret.create({ data: { ownerId, secretEnc: encryptSecret(secret), recoveryCodesHash: "[]" } })
  }
  return { secret, uri, qrDataUrl }
}

/** Confirm a self-enrollment started from a live session. */
export async function ownerCompleteSelfEnroll(ownerId: string, code: string) {
  const owner = await db.saasOwnerUser.findUnique({ where: { id: ownerId } })
  if (!owner) throw Object.assign(new Error("Account unavailable"), { code: 401 })
  if (owner.mfaEnrolled) throw Object.assign(new Error("MFA is already enabled for this account"), { code: 400 })
  const mfa = await db.saasOwnerMfaSecret.findUnique({ where: { ownerId } })
  if (!mfa) throw Object.assign(new Error("Start MFA enrollment first"), { code: 400 })
  const res = verifyTotpWithCounter(decryptSecret(mfa.secretEnc), String(code))
  if (!res.ok || res.counter <= (mfa.lastUsedCounter ?? 0)) {
    throw Object.assign(new Error("That code did not match — check your authenticator app and try again"), { code: 400 })
  }
  const codes = generateRecoveryCodes()
  await db.saasOwnerMfaSecret.update({
    where: { id: mfa.id },
    data: { lastUsedCounter: res.counter, recoveryCodesHash: JSON.stringify(codes.map((c) => hashCode(c))) },
  })
  await db.saasOwnerUser.update({ where: { id: ownerId }, data: { mfaEnrolled: true } })
  return { recoveryCodes: codes }
}

/** Disable MFA from a live session — always requires the account password
 *  (and the TOTP code when enrolled, so a stolen cookie cannot strip the
 *  second factor). */
export async function ownerDisableMfa(ownerId: string, password: string, code?: string) {
  const owner = await db.saasOwnerUser.findUnique({ where: { id: ownerId } })
  if (!owner) throw Object.assign(new Error("Account unavailable"), { code: 401 })
  if (!(await verifyOwnerPassword(String(password || ""), owner.passwordHash))) {
    throw Object.assign(new Error("Password confirmation failed"), { code: 401 })
  }
  if (owner.mfaEnrolled) {
    const mfa = await db.saasOwnerMfaSecret.findUnique({ where: { ownerId } })
    if (!mfa) throw Object.assign(new Error("MFA secret missing — ask a super admin to reset MFA for your account"), { code: 400 })
    const res = verifyTotpWithCounter(decryptSecret(mfa.secretEnc), String(code || ""))
    if (!res.ok) throw Object.assign(new Error("Enter your current 6-digit code to disable MFA"), { code: 401 })
  }
  await db.saasOwnerUser.update({ where: { id: ownerId }, data: { mfaEnrolled: false } })
  await db.saasOwnerMfaSecret.deleteMany({ where: { ownerId } })
}

// ====================== OWNER PASSWORD RECOVERY ======================

/** Request a password reset. NEVER reveals whether the email exists — the
 *  response is identical either way. The token is stored as sha-256; the
 *  plaintext only ever travels inside the email link (or, in dev without a
 *  gateway, is echoed to the server console + audit metadata-less). */
export async function ownerRequestPasswordReset(
  email: string,
  opts: { ip?: string | null; sendEmail: (to: string, link: string) => Promise<void> }
) {
  const emailNorm = String(email || "").toLowerCase().trim()
  // per-IP throttle: 5 requests / 15 min (mail-bombing + enumeration guard)
  if (await rateLimit(`owner-forgot:${opts.ip || "unknown"}`, 5, 15 * 60_000)) {
    throw Object.assign(new Error("Too many reset requests — please wait a few minutes and try again."), { code: 429 })
  }
  const owner = await db.saasOwnerUser.findUnique({ where: { email: emailNorm } })
  if (owner && owner.status === "ACTIVE") {
    const token = crypto.randomBytes(32).toString("hex")
    await db.saasOwnerUser.update({
      where: { id: owner.id },
      data: {
        passwordResetToken: hashCode(token),
        passwordResetExpiresAt: new Date(Date.now() + 60 * 60_000),
        passwordResetRequestedAt: new Date(),
      },
    })
    try { await opts.sendEmail(owner.email, token) } catch { /* the request still succeeds — no oracle */ }
  }
  // identical response for known and unknown emails
  return { ok: true }
}

/** Complete a password reset with the emailed token. Burns every session for
 *  the account (stolen-password defense) and clears the reset fields. */
export async function ownerResetPassword(token: string, newPassword: string, ip?: string | null) {
  const PLACEHOLDER = /^(Pass@123|Owner@123|CHANGE_ME|<|12345678|password)/i
  if (!token || token.length < 32) throw Object.assign(new Error("This reset link is invalid or has expired."), { code: 400 })
  if (typeof newPassword !== "string" || newPassword.length < 12) {
    throw Object.assign(new Error("The new password must be at least 12 characters."), { code: 400 })
  }
  if (PLACEHOLDER.test(newPassword)) {
    throw Object.assign(new Error("That password is not allowed — choose something stronger."), { code: 400 })
  }
  if (await rateLimit(`owner-reset:${ip || "unknown"}`, 10, 15 * 60_000)) {
    throw Object.assign(new Error("Too many attempts — please wait a few minutes."), { code: 429 })
  }
  const owner = await db.saasOwnerUser.findFirst({
    where: { passwordResetToken: hashCode(token), passwordResetExpiresAt: { gt: new Date() } },
  })
  if (!owner) throw Object.assign(new Error("This reset link is invalid or has expired."), { code: 400 })
  await db.saasOwnerUser.update({
    where: { id: owner.id },
    data: {
      // MOD-8 (Phase 1) — async scrypt on the request path
      passwordHash: await hashOwnerPasswordAsync(newPassword),
      passwordResetToken: null,
      passwordResetExpiresAt: null,
      passwordResetRequestedAt: null,
      failedLoginCount: 0,
      lockedUntil: null,
    },
  })
  // every existing session dies with the old password
  await db.saasOwnerSession.deleteMany({ where: { ownerId: owner.id } })
  return { ok: true, email: owner.email }
}

export async function ownerLogout(token: string | null | undefined): Promise<void> {
  if (!token) return
  // SEC-02 (R5) — resolve through the hash, then delete by ROW id
  const sess = await db.saasOwnerSession.findUnique({ where: { tokenHash: ownerSessionTokenHash(token) } }).catch(() => null)
  if (sess) await db.saasOwnerSession.delete({ where: { id: sess.id } }).catch(() => {})
}

/** Cookie string builders (httpOnly, SameSite=Lax, Secure behind TLS). */
export function ownerCookieStr(token: string, expiresAt: Date, isHttps: boolean): string {
  const attrs = [
    `${OWNER_COOKIE}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Expires=${expiresAt.toUTCString()}`,
  ]
  if (isHttps) attrs.push("Secure")
  return attrs.join("; ")
}

export function ownerClearCookieStr(): string {
  return `${OWNER_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`
}

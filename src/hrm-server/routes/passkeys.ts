// ============ Passkey (WebAuthn) routes — tenant plane ============
// Biometric / platform-authenticator MFA + passwordless second step:
//   auth.passkey.list           — the caller's registered passkeys (self scope)
//   auth.passkey.register.start — begin attestation (active session required)
//   auth.passkey.register.finish— verify attestation, store the credential
//   auth.passkey.remove         — delete one of the caller's passkeys
//                                 (re-auth: account password required)
//   auth.passkey.login.start    — PUBLIC: authentication options for an email
//   auth.passkey.login.finish   — PUBLIC: verify the assertion → full session
//
// Threat model / design decisions:
//  - A passkey IS a second factor: possession (device) + user verification
//    (biometric/PIN, enforced at verification). login.finish therefore grants
//    a FULL session even for MFA-required roles — the passkey replaces the
//    TOTP step, it does not stack on the password step.
//  - PRINCIPLE: biometric material never leaves the authenticator. The RP only
//    ever sees signed assertions + a user-verified flag; we store the COSE
//    public key, a signature counter and device metadata — nothing else.
//  - Challenges are 120s, single-use and burned BEFORE the verification
//    attempt (one challenge = one guess; replay of an old assertion dies on
//    the challenge mismatch regardless).
//  - Clone detection: the signature counter must strictly advance (unless the
//    authenticator reports 0 forever — allowed, per the WebAuthn spec).
//  - login.start/finish replicate auth.login's vendor-ambiguity-guarded email
//    lookup (emails are unique PER VENDOR; an address seeded under two vendors
//    is treated as unknown) and are rate-limited per (ip, email) on top of the
//    dispatcher's built-in auth-surface throttle.
//  - register.finish upserts on the (plane, userId, credentialId) compound —
//    a credentialId already owned by ANOTHER account is refused, never
//    silently stolen (credential ids are globally unique in the schema).
import { z } from "zod"
import { db } from "@/lib/db"
import { route } from "./registry"
import { audit } from "../audit"
import { createSession, getCtxFromToken, verifyPasswordAsync } from "../auth"
import { rateLimit, resolveClientIp, identityThrottleKey } from "../security"
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from "@simplewebauthn/server"
import { isoBase64URL } from "@simplewebauthn/server/helpers"
import {
  type PasskeyPlane,
  rpFromRequest,
  storeChallenge,
  getLiveChallenge,
  consumeChallengeById,
  parseTransports,
  serializePasskey,
} from "../passkey"
import { userPayload } from "./auth"

const PLANE: PasskeyPlane = "TENANT"

// ---- zod schemas -------------------------------------------------------------
// The two assertion envelopes are the @simplewebauthn/browser response shapes
// after a JSON round-trip. They are passthrough() so clientExtensionResults /
// authenticatorAttachment and any future fields survive validation intact —
// verify*Response() reads exactly the fields it needs; everything else rides
// through untouched.

const registrationResponseSchema = z.object({
  id: z.string().min(1).max(1024),
  rawId: z.string().min(1).max(1024),
  type: z.literal("public-key"),
  response: z.object({
    clientDataJSON: z.string().min(1),
    attestationObject: z.string().min(1),
    transports: z.array(z.string().max(32)).max(16).optional(),
    clientExtensionResults: z.record(z.string(), z.any()).optional(),
  }).passthrough(),
  clientExtensionResults: z.record(z.string(), z.any()).optional(),
  authenticatorAttachment: z.string().max(32).optional(),
}).passthrough()

const authenticationResponseSchema = z.object({
  id: z.string().min(1).max(1024),
  rawId: z.string().min(1).max(1024),
  type: z.literal("public-key"),
  response: z.object({
    clientDataJSON: z.string().min(1),
    authenticatorData: z.string().min(1),
    signature: z.string().min(1),
    userHandle: z.string().max(1024).optional(),
  }).passthrough(),
  clientExtensionResults: z.record(z.string(), z.any()).optional(),
  authenticatorAttachment: z.string().max(32).optional(),
}).passthrough()

async function listPasskeys(userId: string) {
  const rows = await db.webAuthnCredential.findMany({
    where: { plane: PLANE, userId },
    orderBy: { createdAt: "desc" },
  })
  return rows.map(serializePasskey)
}

/** auth.login's user lookup, replicated: normalize, refuse vendor-ambiguous
 *  addresses with the same generic "unknown account" result (no oracle), then
 *  resolve the single ACTIVE user. */
async function findLoginUser(email: string) {
  const emailNorm = email.toLowerCase().trim()
  const matches = await db.user.findMany({
    where: { email: emailNorm, status: "ACTIVE" },
    select: { vendorId: true },
  })
  if (matches.length !== 1) return null
  return db.user.findFirst({ where: { email: emailNorm, status: "ACTIVE" } })
}

// ============================== self-service (session) ========================

// INTENTIONALLY_SELF_SCOPED (M-02): the caller's own passkeys only — the
// where-clause carries ctx.userId, no module permission gates device list.
route("auth.passkey.list", {
  handler: async (ctx) => {
    return { items: await listPasskeys(ctx.userId) }
  },
})

// INTENTIONALLY_SELF_SCOPED (M-02): begins the CALLER's own attestation —
// an active session is the authorization (any logged-in user may enroll a
// passkey on their own account, mirroring auth.mfa.start).
route("auth.passkey.register.start", {
  handler: async (ctx, _p, req?: any) => {
    const user = await db.user.findUnique({ where: { id: ctx.userId } })
    if (!user || user.status !== "ACTIVE") throw Object.assign(new Error("Account unavailable"), { code: 401 })
    const vendor = await db.vendor.findUnique({ where: { id: ctx.vendorId } })
    const { rpID } = rpFromRequest(req)
    const existing = await db.webAuthnCredential.findMany({
      where: { plane: PLANE, userId: ctx.userId },
      select: { credentialId: true, transports: true },
    })
    const options = await generateRegistrationOptions({
      rpName: vendor?.name || "Finix HR",
      rpID,
      userName: user.email,
      userDisplayName: user.name || user.email,
      // never bind the credential to a stale display name / email snapshot
      excludeCredentials: existing.map((c) => ({ id: c.credentialId, transports: parseTransports(c.transports) as any })),
      // discoverable credentials preferred (usernameless second step at sign-in)
      // + user verification preferred (biometric where the device supports it;
      // verification is still ENFORCED at finish — see below)
      authenticatorSelection: { residentKey: "preferred", userVerification: "preferred" },
    })
    await storeChallenge(PLANE, ctx.userId, options.challenge, "REGISTRATION")
    return { options } // JSON-safe object for @simplewebauthn/browser startRegistration()
  },
})

// INTENTIONALLY_SELF_SCOPED (M-02): completes the caller's own attestation.
// The challenge burned below is bound to ctx.userId by register.start, so a
// finished ceremony can only ever mint a credential for the caller.
route("auth.passkey.register.finish", {
  schema: z.object({
    name: z.string().trim().min(1).max(60).optional(),
    attestation: registrationResponseSchema,
  }),
  handler: async (ctx, p, req?: any) => {
    const user = await db.user.findUnique({ where: { id: ctx.userId } })
    if (!user || user.status !== "ACTIVE") throw Object.assign(new Error("Account unavailable"), { code: 401 })
    const live = await getLiveChallenge(PLANE, ctx.userId, "REGISTRATION")
    if (!live) throw Object.assign(new Error("Registration window expired — try adding the passkey again"), { code: 400 })
    // single-use: burn BEFORE verifying (a failed attempt costs the challenge)
    await consumeChallengeById(live.id)
    const { rpID, expectedOrigins } = rpFromRequest(req)
    let verification
    try {
      verification = await verifyRegistrationResponse({
        response: p.attestation as any,
        expectedChallenge: live.challenge,
        expectedOrigin: expectedOrigins,
        expectedRPID: rpID,
        // the passkey is an MFA factor: the ceremony must prove user
        // verification (biometric/PIN), not mere device presence
        requireUserVerification: true,
      })
    } catch (e: any) {
      // verifier errors (origin mismatch, UV not performed…) are user-facing
      // 400s — never the generic 500 the dispatcher would map them to
      throw Object.assign(new Error(e?.message || "Passkey verification failed"), { code: 400 })
    }
    if (!verification.verified || !verification.registrationInfo) {
      throw Object.assign(new Error("Passkey verification failed — the device did not complete user verification. Try again."), { code: 400 })
    }
    const info = verification.registrationInfo
    const credentialId = info.credential.id
    // Global-unique credentialId: refuse a credential already owned by a
    // DIFFERENT account/plane instead of letting the upsert steal it.
    const clash = await db.webAuthnCredential.findUnique({ where: { credentialId } })
    if (clash && (clash.plane !== PLANE || clash.userId !== ctx.userId)) {
      throw Object.assign(new Error("This passkey is already registered to a different account"), { code: 400 })
    }
    const deviceName = (p.name || "").trim().slice(0, 60) || "Passkey"
    const transports = JSON.stringify(info.credential.transports || [])
    const publicKeyB64 = isoBase64URL.fromBuffer(info.credential.publicKey)
    const counter = BigInt(info.credential.counter || 0)
    const backupEligible = info.credentialDeviceType !== "singleDevice"
    await db.webAuthnCredential.upsert({
      where: { plane_userId_credentialId: { plane: PLANE, userId: ctx.userId, credentialId } },
      create: { plane: PLANE, userId: ctx.userId, vendorId: ctx.vendorId, credentialId, publicKey: publicKeyB64, counter, transports, deviceName, backupEligible, backupState: info.credentialBackedUp },
      update: { publicKey: publicKeyB64, counter, transports, deviceName, backupEligible, backupState: info.credentialBackedUp },
    })
    await audit({ userId: ctx.userId, userName: ctx.userName, vendorId: ctx.vendorId, ip: ctx.ip },
      "auth.passkey.register", "User", ctx.userId,
      `Passkey registered (${deviceName}${backupEligible ? ", synced" : ", device-bound"})`)
    return { items: await listPasskeys(ctx.userId) }
  },
})

// INTENTIONALLY_SELF_SCOPED (M-02): removes one of the caller's own passkeys.
// L-1 discipline (mirrors auth.mfa.disable): stripping a factor requires the
// PRIMARY credential — a hijacked session cannot delete the victim's second
// factor with a click.
route("auth.passkey.remove", {
  schema: z.object({
    id: z.string().min(1).max(64),
    password: z.string().min(1).max(128),
  }),
  handler: async (ctx, p) => {
    const user = await db.user.findUnique({ where: { id: ctx.userId } })
    if (!user) throw Object.assign(new Error("Account unavailable"), { code: 401 })
    const cred = await db.webAuthnCredential.findFirst({
      where: { id: p.id, plane: PLANE, userId: ctx.userId },
    })
    if (!cred) throw Object.assign(new Error("Passkey not found"), { code: 404 })
    if (!p.password || !(await verifyPasswordAsync(p.password, user.passwordHash))) {
      throw Object.assign(new Error("Account password is required to remove a passkey"), { code: 401 })
    }
    await db.webAuthnCredential.delete({ where: { id: cred.id } })
    await audit({ userId: ctx.userId, userName: ctx.userName, vendorId: ctx.vendorId, ip: ctx.ip },
      "auth.passkey.remove", "User", ctx.userId, `Passkey removed (${cred.deviceName}) — password re-verified`)
    return { items: await listPasskeys(ctx.userId) }
  },
})

// ============================== login (public) ===============================

// INTENTIONALLY_PUBLIC (M-02): pre-auth flow — the passkey assertion itself is
// the authentication (possession + user verification). Only the allow-list of
// credential ids and a fresh challenge are exposed; nothing here authenticates
// anything on its own.
route("auth.passkey.login.start", {
  public: true,
  schema: z.object({ email: z.string().trim().toLowerCase().email().max(160) }),
  handler: async (_ctx, p, req?: any) => {
    const email = String(p.email || "")
    const ip = resolveClientIp(req)
    // per (ip, email) — email-bound when the IP is unknown (H-7 discipline),
    // ON TOP of the dispatcher's auth-surface throttle
    if (await rateLimit(identityThrottleKey("passkey-start", email, ip), 10, 60_000)) {
      throw Object.assign(new Error("Too many attempts — wait a minute and try again"), { code: 429 })
    }
    const user = await findLoginUser(email)
    const creds = user
      ? await db.webAuthnCredential.findMany({
          where: { plane: PLANE, userId: user.id },
          select: { credentialId: true, transports: true },
        })
      : []
    const { rpID } = rpFromRequest(req)
    const options = await generateAuthenticationOptions({
      rpID,
      allowCredentials: creds.map((c) => ({ id: c.credentialId, transports: parseTransports(c.transports) as any })),
      userVerification: "preferred",
    })
    // No resolvable user / no passkeys → empty allowCredentials (the UI shows
    // "no passkey enrolled"; no account-existence oracle beyond that).
    if (user && creds.length) await storeChallenge(PLANE, user.id, options.challenge, "AUTHENTICATION")
    return { options }
  },
})

// INTENTIONALLY_PUBLIC (M-02): completes passkey sign-in — a verified
// assertion (challenge-bound, origin-bound, user-verified, counter-advanced)
// IS the authentication and mints the FULL session + httpOnly cookie, exactly
// like auth.mfa.verify does for TOTP.
route("auth.passkey.login.finish", {
  public: true,
  schema: z.object({
    email: z.string().trim().toLowerCase().email().max(160),
    assertion: authenticationResponseSchema,
  }),
  handler: async (_ctx, p, req?: any) => {
    const email = String(p.email || "")
    const ip = resolveClientIp(req) || undefined
    const userAgent = req?.headers?.get?.("user-agent") || undefined
    const { recordLoginAudit } = await import("../login-audit")
    const fail = async (reason: "MFA_FAILED" | "RATE_LIMITED", userId?: string, userName?: string, vendorId?: string, role?: string) => {
      await recordLoginAudit({ plane: "TENANT", email, success: false, failureReason: reason, userId, userName, vendorId, role, mfaUsed: true, ip, userAgent })
    }
    if (await rateLimit(identityThrottleKey("passkey-finish", email, ip ?? null), 10, 60_000)) {
      await fail("RATE_LIMITED")
      throw Object.assign(new Error("Too many attempts — wait a minute and try again"), { code: 429 })
    }
    const user = await findLoginUser(email)
    if (!user) {
      await fail("MFA_FAILED")
      throw Object.assign(new Error("Invalid email or password"), { code: 401 })
    }
    const live = await getLiveChallenge(PLANE, user.id, "AUTHENTICATION")
    if (!live) {
      await fail("MFA_FAILED", user.id, user.name, user.vendorId, user.role)
      throw Object.assign(new Error("Passkey challenge expired — start the passkey sign-in again"), { code: 401 })
    }
    await consumeChallengeById(live.id) // single-use, burned before verifying
    const cred = await db.webAuthnCredential.findFirst({
      where: { plane: PLANE, userId: user.id, credentialId: String(p.assertion.id) },
    })
    if (!cred) {
      await fail("MFA_FAILED", user.id, user.name, user.vendorId, user.role)
      throw Object.assign(new Error("That passkey is not registered for this account"), { code: 400 })
    }
    const { rpID, expectedOrigins } = rpFromRequest(req)
    let verification
    try {
      verification = await verifyAuthenticationResponse({
        response: p.assertion as any,
        expectedChallenge: live.challenge,
        expectedOrigin: expectedOrigins,
        expectedRPID: rpID,
        requireUserVerification: true,
        credential: {
          id: cred.credentialId,
          publicKey: isoBase64URL.toBuffer(cred.publicKey),
          counter: Number(cred.counter), // BigInt column → number (fits in double)
          transports: parseTransports(cred.transports) as any,
        },
      })
    } catch (e: any) {
      await fail("MFA_FAILED", user.id, user.name, user.vendorId, user.role)
      throw Object.assign(new Error(e?.message || "Passkey verification failed"), { code: 401 })
    }
    if (!verification.verified) {
      await fail("MFA_FAILED", user.id, user.name, user.vendorId, user.role)
      throw Object.assign(new Error("Passkey verification failed"), { code: 401 })
    }
    const newCounter = verification.authenticationInfo.newCounter
    const storedCounter = Number(cred.counter)
    // Clone detection (M-16 replay discipline): the counter must strictly
    // advance — unless the authenticator always reports 0 (allowed by spec).
    if (newCounter !== 0 && newCounter <= storedCounter) {
      await audit({ userId: user.id, userName: user.name, vendorId: user.vendorId, ip },
        "auth.passkey.login", "User", user.id,
        `Passkey assertion REJECTED — signature counter did not advance (${storedCounter} → ${newCounter}); possible cloned credential`)
      await fail("MFA_FAILED", user.id, user.name, user.vendorId, user.role)
      throw Object.assign(new Error("This passkey failed the replay check — remove and re-add it, or use your password"), { code: 401 })
    }
    await db.webAuthnCredential.update({
      where: { id: cred.id },
      data: { counter: BigInt(newCounter), lastUsedAt: new Date(), backupState: verification.authenticationInfo.credentialBackedUp },
    })
    const vendor = await db.vendor.findUnique({ where: { id: user.vendorId } })
    if (!vendor || !vendor.active) throw Object.assign(new Error("Vendor inactive"), { code: 403 })
    // The passkey IS the second factor (possession + user verification), so a
    // verified assertion promotes straight to a FULL session — mirroring
    // auth.mfa.verify's promote path token-for-token (cookie set by dispatcher).
    const { token } = await createSession(user)
    const ctx = await getCtxFromToken(token)
    const payload = await userPayload(user, vendor, ctx ? Array.from(ctx.permissions) : [])
    // M-4 — auth lifecycle audit: passkey sign-ins leave a trail
    await audit({ userId: user.id, userName: user.name, vendorId: user.vendorId, ip },
      "auth.login", "User", user.id, `Signed in (passkey verified: ${cred.deviceName})`)
    // R16 — login audit: passkey-completed sign-in
    await recordLoginAudit({
      plane: "TENANT", email: user.email, success: true,
      userId: user.id, userName: user.name, vendorId: vendor.id, vendorName: vendor.name, role: user.role,
      mfaUsed: true, ip, userAgent,
    })
    return { ...payload, token, csrfToken: ctx?.csrfToken || null }
  },
})

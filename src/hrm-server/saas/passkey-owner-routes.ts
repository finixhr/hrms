// ============ Passkey (WebAuthn) routes — SaaS owner plane ============
// Platform-side mirror of the tenant passkey rail (routes/passkeys.ts), for
// the owner's OWN account only (My Account → Security):
//   owner.passkey.list            — the caller's registered passkeys
//   owner.passkey.register.start  — begin attestation (live FULL session)
//   owner.passkey.register.finish — verify attestation, store the credential
//   owner.passkey.remove          — delete one (re-auth: owner password)
//
// Deliberately NO owner.passkey.login.* — owner sign-in stays password+TOTP
// (ownerLogin's MFA machinery in owner-auth.ts). Passkeys are an additional
// enrolled factor / management surface for now; the login path is a separate,
// riskier surface and stays untouched.
//
// Same discipline as the tenant rail: challenges are 120s single-use, the
// signature counter must advance (clone detection), a credentialId owned by
// another account is never stolen by the upsert, factor removal re-requires
// the primary password, and the WebAuthn protocol's user-verification flag is
// the ONLY biometric signal (raw biometric data never leaves the device —
// nothing here stores or processes it).
import { z } from "zod"
import { db } from "@/lib/db"
import { ownerAction } from "./owner-routes"
import { verifyOwnerPassword } from "./owner-auth"
import { saasAudit } from "./audit"
import { getSaasSettings } from "./settings"
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
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

const PLANE: PasskeyPlane = "OWNER"

// See routes/passkeys.ts for the schema rationale (passthrough keeps
// clientExtensionResults / authenticatorAttachment intact for the verifier).
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

async function listOwnerPasskeys(ownerId: string) {
  const rows = await db.webAuthnCredential.findMany({
    where: { plane: PLANE, userId: ownerId },
    orderBy: { createdAt: "desc" },
  })
  return rows.map(serializePasskey)
}

// ============================ MY ACCOUNT — PASSKEYS ===========================

// Self-scoped like owner.auth.mfa.status: identity-bound to ctx.ownerId, no
// permission verb (the caller can only ever see their own devices).
ownerAction("owner.passkey.list", {
  handler: async (ctx) => {
    return { items: await listOwnerPasskeys(ctx.ownerId) }
  },
})

ownerAction("owner.passkey.register.start", {
  handler: async (ctx, _p, req?: any) => {
    const owner = await db.saasOwnerUser.findUnique({ where: { id: ctx.ownerId } })
    if (!owner || owner.status !== "ACTIVE") throw Object.assign(new Error("Account unavailable"), { code: 401 })
    const s = await getSaasSettings()
    const { rpID } = rpFromRequest(req)
    const existing = await db.webAuthnCredential.findMany({
      where: { plane: PLANE, userId: ctx.ownerId },
      select: { credentialId: true, transports: true },
    })
    const options = await generateRegistrationOptions({
      rpName: s.general.platformName || "Finix HR Owner Console",
      rpID,
      userName: owner.email,
      userDisplayName: owner.name || owner.email,
      excludeCredentials: existing.map((c) => ({ id: c.credentialId, transports: parseTransports(c.transports) as any })),
      authenticatorSelection: { residentKey: "preferred", userVerification: "preferred" },
    })
    await storeChallenge(PLANE, ctx.ownerId, options.challenge, "REGISTRATION")
    return { options }
  },
})

ownerAction("owner.passkey.register.finish", {
  schema: z.object({
    name: z.string().trim().min(1).max(60).optional(),
    attestation: registrationResponseSchema,
  }),
  handler: async (ctx, p, req?: any) => {
    const owner = await db.saasOwnerUser.findUnique({ where: { id: ctx.ownerId } })
    if (!owner || owner.status !== "ACTIVE") throw Object.assign(new Error("Account unavailable"), { code: 401 })
    const live = await getLiveChallenge(PLANE, ctx.ownerId, "REGISTRATION")
    if (!live) throw Object.assign(new Error("Registration window expired — try adding the passkey again"), { code: 400 })
    await consumeChallengeById(live.id) // single-use, burned before verifying
    const { rpID, expectedOrigins } = rpFromRequest(req)
    let verification
    try {
      verification = await verifyRegistrationResponse({
        response: p.attestation as any,
        expectedChallenge: live.challenge,
        expectedOrigin: expectedOrigins,
        expectedRPID: rpID,
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
    // never steal a credentialId owned by another account (global unique)
    const clash = await db.webAuthnCredential.findUnique({ where: { credentialId } })
    if (clash && (clash.plane !== PLANE || clash.userId !== ctx.ownerId)) {
      throw Object.assign(new Error("This passkey is already registered to a different account"), { code: 400 })
    }
    const deviceName = (p.name || "").trim().slice(0, 60) || "Passkey"
    const transports = JSON.stringify(info.credential.transports || [])
    const publicKeyB64 = isoBase64URL.fromBuffer(info.credential.publicKey)
    const counter = BigInt(info.credential.counter || 0)
    const backupEligible = info.credentialDeviceType !== "singleDevice"
    await db.webAuthnCredential.upsert({
      where: { plane_userId_credentialId: { plane: PLANE, userId: ctx.ownerId, credentialId } },
      create: { plane: PLANE, userId: ctx.ownerId, vendorId: null, credentialId, publicKey: publicKeyB64, counter, transports, deviceName, backupEligible, backupState: info.credentialBackedUp },
      update: { publicKey: publicKeyB64, counter, transports, deviceName, backupEligible, backupState: info.credentialBackedUp },
    })
    await saasAudit(ctx, "OWNER_PASSKEY_REGISTERED", "SaaSOwnerUser", ctx.ownerId,
      `Owner ${ctx.email} registered a passkey (${deviceName}${backupEligible ? ", synced" : ", device-bound"})`)
    return { items: await listOwnerPasskeys(ctx.ownerId) }
  },
})

ownerAction("owner.passkey.remove", {
  schema: z.object({
    id: z.string().min(1).max(64),
    password: z.string().min(1).max(128),
  }),
  handler: async (ctx, p) => {
    const owner = await db.saasOwnerUser.findUnique({ where: { id: ctx.ownerId } })
    if (!owner) throw Object.assign(new Error("Account unavailable"), { code: 401 })
    const cred = await db.webAuthnCredential.findFirst({
      where: { id: p.id, plane: PLANE, userId: ctx.ownerId },
    })
    if (!cred) throw Object.assign(new Error("Passkey not found"), { code: 404 })
    // factor removal requires the PRIMARY credential (ownerDisableMfa discipline)
    if (!p.password || !(await verifyOwnerPassword(p.password, owner.passwordHash))) {
      throw Object.assign(new Error("Account password is required to remove a passkey"), { code: 401 })
    }
    await db.webAuthnCredential.delete({ where: { id: cred.id } })
    await saasAudit(ctx, "OWNER_PASSKEY_REMOVED", "SaaSOwnerUser", ctx.ownerId,
      `Owner ${ctx.email} removed a passkey (${cred.deviceName}) — password re-verified`)
    return { items: await listOwnerPasskeys(ctx.ownerId) }
  },
})

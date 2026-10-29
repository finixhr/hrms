/// <reference types="bun-types" />
// ============ Owner console MFA + password recovery + platform gateway ============
// 2026-10-04 additions. Covers the full owner second-factor lifecycle and the
// self-service reset flow at the function level (the same functions the
// /api/owner dispatcher calls):
//   · login → MFA_PENDING challenge when enrolled; challenge grants no rights
//   · TOTP verify promotes to FULL; replay-protected; recovery codes single-use
//   · platform ownerMfaRequired policy → forced ENROLL_PENDING first-login wizard
//   · password forgot/reset: hashed token, expiry, session burn, enumeration-safe
//   · platform gateway: masked reads, empty-secret keeps value, SKIPPED when
//     unconfigured, SMS URL SSRF validation
import "./_testdb"
import { beforeAll, afterAll, describe, expect, test } from "bun:test"
import { db } from "@/lib/db"
import {
  hashOwnerPassword, ownerLogin, ownerVerifyMfa, getOwnerFromToken,
  ownerStartMfaEnroll, ownerCompleteMfaEnroll, ownerStartSelfEnroll,
  ownerCompleteSelfEnroll, ownerDisableMfa,
  ownerRequestPasswordReset, ownerResetPassword,
} from "@/hrm-server/saas/owner-auth"
import { generateTotpSecret, generateRecoveryCodes, hashCode, encryptSecret } from "@/hrm-server/totp"
import { getPlatformGateway, savePlatformGateway, maskPlatformGateway, sendPlatformEmail, invalidatePlatformGateway } from "@/hrm-server/saas/notify"
import { saveSaasSettingsGroup, getSaasSettings } from "@/hrm-server/saas/settings"
import { totpNow } from "./_hrm-endpoint"
import { uniq } from "./_fixtures"

const PASSWORD = "OwnerMfa-Test-2026!"

async function mkOwner(over: Partial<any> = {}) {
  const email = uniq("owner-mfa").toLowerCase() + "@test.local"
  const owner = await db.saasOwnerUser.create({
    data: {
      email,
      name: "MFA Test Owner",
      passwordHash: hashOwnerPassword(PASSWORD),
      roleKey: "SUPER_ADMIN",
      permissions: "[]",
      status: "ACTIVE",
      ...over,
    } as any,
  })
  return owner
}

async function plantMfa(ownerId: string, secret?: string) {
  const s = secret || generateTotpSecret()
  const codes = generateRecoveryCodes()
  await db.saasOwnerMfaSecret.create({
    data: {
      ownerId,
      secretEnc: encryptSecret(s), // real AES-256-GCM envelope (HRM_MFA_KEY from .env)
      recoveryCodesHash: JSON.stringify(codes.map((c) => hashCode(c))),
      lastUsedCounter: 0,
    },
  })
  await db.saasOwnerUser.update({ where: { id: ownerId }, data: { mfaEnrolled: true } })
  return { secret: s, codes }
}

beforeAll(async () => {
  // keep the platform MFA policy OFF for the default tests (set explicitly in the policy test)
  await saveSaasSettingsGroup("security", { ownerMfaRequired: false })
})

afterAll(async () => {
  await saveSaasSettingsGroup("security", { ownerMfaRequired: false })
})

describe("owner MFA login challenge", () => {
  test("enrolled owner gets an MFA challenge, not a session — and the challenge authorizes nothing", async () => {
    const owner = await mkOwner()
    const { secret } = await plantMfa(owner.id)
    const res: any = await ownerLogin(owner.email, PASSWORD, "127.0.0.1", "test")
    expect(res.mfaRequired).toBe(true)
    expect(res.mfaToken).toBeTruthy()
    expect(res.token).toBeUndefined() // no full session yet
    // the challenge session must not resolve as an authenticated context
    expect(await getOwnerFromToken(res.mfaToken)).toBeNull()
    // wrong code → 401
    await expect(ownerVerifyMfa(res.mfaToken, "000000")).rejects.toMatchObject({ code: 401 })
    // correct code promotes to a FULL session with owner payload
    const full: any = await ownerVerifyMfa(res.mfaToken, totpNow(secret), { ip: "127.0.0.1" })
    expect(full.token).toBeTruthy()
    expect(full.owner.email).toBe(owner.email)
    const ctx = await getOwnerFromToken(full.token)
    expect(ctx?.ownerId).toBe(owner.id)
    // challenge token is burned — reuse fails
    await expect(ownerVerifyMfa(res.mfaToken, totpNow(secret))).rejects.toMatchObject({ code: 401 })
  })

  test("a TOTP code cannot be replayed for a second challenge", async () => {
    const owner = await mkOwner()
    const { secret } = await plantMfa(owner.id)
    const login: any = await ownerLogin(owner.email, PASSWORD)
    const code = totpNow(secret)
    const first: any = await ownerVerifyMfa(login.mfaToken, code)
    expect(first.token).toBeTruthy()
    // new challenge, SAME code window → replay rejected (counter guard)
    const login2: any = await ownerLogin(owner.email, PASSWORD)
    await expect(ownerVerifyMfa(login2.mfaToken, code)).rejects.toMatchObject({ code: 401 })
  })

  test("recovery codes work exactly once and are consumed", async () => {
    const owner = await mkOwner()
    const { codes } = await plantMfa(owner.id)
    const login: any = await ownerLogin(owner.email, PASSWORD)
    const full: any = await ownerVerifyMfa(login.mfaToken, codes[0], { useRecovery: true })
    expect(full.token).toBeTruthy()
    // same code again → rejected (single-use)
    const login2: any = await ownerLogin(owner.email, PASSWORD)
    await expect(ownerVerifyMfa(login2.mfaToken, codes[0], { useRecovery: true })).rejects.toMatchObject({ code: 401 })
    // a DIFFERENT recovery code still works
    const full2: any = await ownerVerifyMfa(login2.mfaToken, codes[1], { useRecovery: true })
    expect(full2.token).toBeTruthy()
  })
})

describe("platform ownerMfaRequired policy (forced first-login enrollment)", () => {
  test("unenrolled owner is routed through the enrollment wizard, never a full session", async () => {
    const owner = await mkOwner()
    await saveSaasSettingsGroup("security", { ownerMfaRequired: true })
    try {
      const login: any = await ownerLogin(owner.email, PASSWORD)
      expect(login.mfaEnrollmentRequired).toBe(true)
      expect(login.enrollToken).toBeTruthy()
      expect(login.token).toBeUndefined()
      // the enrollment window authorizes nothing either
      expect(await getOwnerFromToken(login.enrollToken)).toBeNull()
      // start returns provisioning; wrong confirmation code fails
      const start = await ownerStartMfaEnroll(login.enrollToken, "Finix HR")
      expect(start.secret).toBeTruthy()
      expect(start.qrDataUrl).toMatch(/^data:image\/png;base64,/)
      await expect(ownerCompleteMfaEnroll(login.enrollToken, "000000")).rejects.toMatchObject({ code: 400 })
      // correct code completes: MFA enabled + FULL session + recovery codes
      const done: any = await ownerCompleteMfaEnroll(login.enrollToken, totpNow(start.secret))
      expect(done.token).toBeTruthy()
      expect(done.recoveryCodes.length).toBe(10)
      const after = await db.saasOwnerUser.findUnique({ where: { id: owner.id } })
      expect(after?.mfaEnrolled).toBe(true)
      // next login is now a TOTP challenge (policy or not — MFA exists)
      const again: any = await ownerLogin(owner.email, PASSWORD)
      expect(again.mfaRequired).toBe(true)
    } finally {
      await saveSaasSettingsGroup("security", { ownerMfaRequired: false })
    }
  })
})

describe("owner MFA self-service (live session)", () => {
  test("self-enroll requires the password, confirms with a code; disable requires password + code", async () => {
    const owner = await mkOwner()
    // wrong password → refuse
    await expect(ownerStartSelfEnroll(owner.id, "wrong-password")).rejects.toMatchObject({ code: 401 })
    const start = await ownerStartSelfEnroll(owner.id, PASSWORD, "Finix HR")
    const done = await ownerCompleteSelfEnroll(owner.id, totpNow(start.secret))
    expect(done.recoveryCodes.length).toBe(10)
    // enrolled flag set
    expect((await db.saasOwnerUser.findUnique({ where: { id: owner.id } }))?.mfaEnrolled).toBe(true)
    // disable: missing/wrong TOTP code → refuse even with the right password
    await expect(ownerDisableMfa(owner.id, PASSWORD)).rejects.toMatchObject({ code: 401 })
    await expect(ownerDisableMfa(owner.id, "wrong", totpNow(start.secret))).rejects.toMatchObject({ code: 401 })
    // correct password + code → disabled, secret rows gone
    await ownerDisableMfa(owner.id, PASSWORD, totpNow(start.secret))
    const after = await db.saasOwnerUser.findUnique({ where: { id: owner.id } })
    expect(after?.mfaEnrolled).toBe(false)
    expect(await db.saasOwnerMfaSecret.count({ where: { ownerId: owner.id } })).toBe(0)
  })
})

describe("owner password recovery", () => {
  test("forgot + reset round-trip: token hash stored, reset works, sessions burned, new password signs in", async () => {
    const owner = await mkOwner()
    // a pre-existing session that must die on reset
    const before: any = await ownerLogin(owner.email, PASSWORD)
    expect(before.token).toBeTruthy()

    let capturedToken = ""
    const res = await ownerRequestPasswordReset(owner.email, {
      ip: "127.0.0.7",
      sendEmail: async (_to, token) => { capturedToken = token },
    })
    expect(res.ok).toBe(true)
    expect(capturedToken.length).toBe(64) // 32 bytes hex

    // short password refused
    await expect(ownerResetPassword(capturedToken, "short", "127.0.0.7")).rejects.toMatchObject({ code: 400 })
    // placeholder refused
    await expect(ownerResetPassword(capturedToken, "Pass@123456789", "127.0.0.7")).rejects.toMatchObject({ code: 400 })
    // valid reset
    const NEW = "Brand-New-Passw0rd-2026"
    await ownerResetPassword(capturedToken, NEW, "127.0.0.7")
    // old session burned
    expect(await getOwnerFromToken(before.token)).toBeNull()
    // old password no longer works; new one does
    await expect(ownerLogin(owner.email, PASSWORD)).rejects.toMatchObject({ code: 401 })
    const reLogin: any = await ownerLogin(owner.email, NEW)
    expect(reLogin.token).toBeTruthy()
    // token single-use: second reset with the same token fails
    await expect(ownerResetPassword(capturedToken, "Another-New-Passw0rd", "127.0.0.7")).rejects.toMatchObject({ code: 400 })
  })

  test("unknown email gets the identical ok response (no enumeration oracle)", async () => {
    let sent = 0
    const res = await ownerRequestPasswordReset("nonexistent-" + uniq("x") + "@test.local", {
      ip: "127.0.0.8",
      sendEmail: async () => { sent++ },
    })
    expect(res.ok).toBe(true)
    expect(sent).toBe(0)
  })
})

describe("platform gateway (owner email/SMS)", () => {
  test("masked read: secrets become booleans; empty secret on save keeps the stored value", async () => {
    await savePlatformGateway({
      emailEnabled: true, emailHost: "smtp.test.local", emailPort: 587, emailSecure: false,
      emailUsername: "platform@test.local", emailPassword: "secret-value-1",
      emailFromAddress: "no-reply@test.local", emailFromName: "Test",
    })
    const raw = await getPlatformGateway()
    expect(raw.email.password).toBe("secret-value-1")
    const masked = maskPlatformGateway(raw)
    expect(masked.email.password).toBe("")
    expect(masked.email.hasPassword).toBe(true)
    // save WITHOUT the password → retained
    await savePlatformGateway({ emailPassword: "" })
    expect((await getPlatformGateway()).email.password).toBe("secret-value-1")
    // cleanup + cache invalidation check
    await savePlatformGateway({ emailEnabled: false, emailHost: "", emailUsername: "", emailPassword: "x-clear" })
    invalidatePlatformGateway()
    expect((await getPlatformGateway()).email.enabled).toBe(false)
  })

  test("sendPlatformEmail skips transparently when the gateway is unconfigured", async () => {
    await savePlatformGateway({ emailEnabled: false, emailHost: "", emailUsername: "", emailPassword: "" })
    const res = await sendPlatformEmail("someone@example.com", "test", "body")
    expect(res.status).toBe("SKIPPED")
    expect(res.detail).toContain("not configured")
  })

  test("SMS gateway URL is validated at save time (SSRF guard: localhost refused)", async () => {
    await expect(
      savePlatformGateway({ smsEnabled: true, smsApiUrl: "http://localhost:9090/send?to={phone}" })
    ).rejects.toMatchObject({ code: 400 })
    await expect(
      savePlatformGateway({ smsEnabled: true, smsApiUrl: "https://127.0.0.1/send" })
    ).rejects.toMatchObject({ code: 400 })
    // a public https URL with placeholders passes
    const out = await savePlatformGateway({ smsEnabled: true, smsApiUrl: "https://sms.example.com/send?to={phone}&msg={message}" })
    expect(out.sms.hasApiKey).toBe(false)
    await savePlatformGateway({ smsEnabled: false })
  })
})

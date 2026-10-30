/// <reference types="bun-types" />
// ============ Low-severity auth hardening: L-1, L-2, L-3 ============
// L-1 — auth.mfa.disable requires BOTH factors (password + TOTP code). The
//       route comment always claimed "password + code" but only the code was
//       checked — a hijacked session could strip the victim's second factor
//       with a shoulder-surfed code alone.
// L-2 — no account-existence oracles: the multi-vendor login branch, the
//       lockout branch, and forgotPassword all answer with generic,
//       shape-identical responses.
// L-3 — TOTP and recovery-code comparisons are constant-time (the shared
//       safeEqual), verified functionally + by source invariant.
// Route-layer: drives the REAL POST /api/hrm dispatcher.
import "./_testdb"
import { describe, test, expect } from "bun:test"
import { readFileSync } from "node:fs"
import { postHrm, totpNow } from "./_hrm-endpoint"
import { db } from "@/lib/db"
import { mkUser, mkVendor, uniq } from "./_fixtures"
import { sessionTokenHash, hashPassword } from "@/hrm-server/auth"
import { generateTotpSecret, encryptSecret, matchRecoveryCode } from "@/hrm-server/totp"

const PASSWORD = "Start!23456"

async function enrolledSession(vendorId: string) {
  const email = uniq("l1mfa") + "@t.local"
  const u = await mkUser(vendorId, { email, role: "EMPLOYEE" })
  await db.user.update({ where: { id: u.id }, data: { passwordHash: hashPassword(PASSWORD), passwordChangedAt: new Date(), mfaEnrolled: true } })
  const secret = generateTotpSecret()
  await db.userMfaSecret.create({
    data: { vendorId, userId: u.id, secretEnc: encryptSecret(secret), recoveryCodesHash: "[]" },
  })
  const sessId = `l1-${uniq("s")}`
  const sess = await db.session.create({
    data: { id: sessId, tokenHash: sessionTokenHash(sessId), userId: u.id, kind: "FULL", csrfToken: "x", expiresAt: new Date(Date.now() + 3600_000), ip: "127.0.0.1", lastSeenAt: new Date() },
  })
  return { userId: u.id, secret, token: sess.id }
}

describe("L-1 — auth.mfa.disable requires password + TOTP code", () => {
  test("code alone (no password) → 401, MFA intact", async () => {
    const vendor = await mkVendor("L1-NoPwd")
    const { userId, secret, token } = await enrolledSession(vendor.id)
    const r = await postHrm("auth.mfa.disable", { code: totpNow(secret) }, { bearer: token })
    expect(r.status).toBe(401)
    expect(String(r.body?.error || "").includes("Password")).toBe(true)
    const still = await db.userMfaSecret.findUnique({ where: { userId } })
    expect(still).toBeTruthy() // second factor NOT stripped
  })

  test("wrong password + valid code → 401, MFA intact", async () => {
    const vendor = await mkVendor("L1-BadPwd")
    const { userId, secret, token } = await enrolledSession(vendor.id)
    const r = await postHrm("auth.mfa.disable", { code: totpNow(secret), password: "Wrong!99999" }, { bearer: token })
    expect(r.status).toBe(401)
    expect(await db.userMfaSecret.findUnique({ where: { userId } })).toBeTruthy()
  })

  test("correct password + valid code → 200, MFA disabled", async () => {
    const vendor = await mkVendor("L1-Both")
    const { userId, secret, token } = await enrolledSession(vendor.id)
    const r = await postHrm("auth.mfa.disable", { code: totpNow(secret), password: PASSWORD }, { bearer: token })
    expect(r.status).toBe(200)
    expect(await db.userMfaSecret.findUnique({ where: { userId } })).toBeFalsy()
  })
})

describe("L-2 — no account-existence oracles", () => {
  test("locked account answers with the SAME generic message and code as bad credentials", async () => {
    const vendor = await mkVendor("L2-Lockout")
    const email = uniq("l2lock") + "@t.local"
    const u = await mkUser(vendor.id, { email, role: "EMPLOYEE" })
    await db.user.update({
      where: { id: u.id },
      data: { passwordHash: hashPassword(PASSWORD), passwordChangedAt: new Date(), lockedUntil: new Date(Date.now() + 10 * 60_000) },
    })
    const locked = await postHrm("auth.login", { email, password: PASSWORD })
    const unknown = await postHrm("auth.login", { email: "nobody-" + uniq("x") + "@t.local", password: PASSWORD })
    expect(locked.status).toBe(unknown.status) // both 401 (locked was 423 before)
    expect(locked.body?.error).toBe(unknown.body?.error) // byte-identical message
    expect(String(locked.body?.error)).not.toContain("locked")
  })

  test("email registered to MULTIPLE vendors answers with the same generic message", async () => {
    const vA = await mkVendor("L2-Multi-A")
    const vB = await mkVendor("L2-Multi-B")
    const shared = uniq("l2shared") + "@t.local"
    for (const v of [vA, vB]) {
      const u = await mkUser(v.id, { email: shared, role: "EMPLOYEE" })
      await db.user.update({ where: { id: u.id }, data: { passwordHash: hashPassword(PASSWORD), passwordChangedAt: new Date() } })
    }
    const multi = await postHrm("auth.login", { email: shared, password: PASSWORD })
    const unknown = await postHrm("auth.login", { email: "nobody-" + uniq("y") + "@t.local", password: PASSWORD })
    expect(multi.status).toBe(unknown.status)
    expect(multi.body?.error).toBe(unknown.body?.error) // was "registered to multiple vendors…"
    expect(String(multi.body?.error)).not.toContain("vendors")
  })

  test("forgotPassword: unknown email gets the SAME response shape as a known email", async () => {
    const vendor = await mkVendor("L2-Forgot")
    const known = uniq("l2known") + "@t.local"
    await mkUser(vendor.id, { email: known, role: "EMPLOYEE" })
    const knownRes = await postHrm("auth.forgotPassword", { email: known }, {})
    const unknownRes = await postHrm("auth.forgotPassword", { email: "nobody-" + uniq("z") + "@t.local" }, {})
    expect(knownRes.status).toBe(unknownRes.status)
    // gateway state is GLOBAL — both branches report the same delivery kind
    expect(knownRes.body?.data?.delivery).toBe(unknownRes.body?.data?.delivery)
    // whichever variant: the two hints must be the SAME kind of answer.
    // unconfigured → byte-identical admin hint; configured → both "If <email>
    // is registered…" (the only difference is the caller's own echo).
    const k = String(knownRes.body?.data?.hint || "")
    const u = String(unknownRes.body?.data?.hint || "")
    expect(k === u || (k.startsWith("If ") && u.startsWith("If "))).toBe(true)
  })
})

describe("L-3 — constant-time TOTP / recovery-code comparisons", () => {
  test("matchRecoveryCode still matches a real hash and rejects a wrong code", () => {
    // mirror the production hash pipeline (totp.ts hashCode): sha256 of the
    // trimmed lowercase code — build the stored-hashes JSON the way the
    // enroll path does
    const { createHash } = require("node:crypto") as typeof import("node:crypto")
    const hashes = JSON.stringify([createHash("sha256").update("12345678").digest("hex")])
    expect(matchRecoveryCode("12345678", hashes)).toBe(true)
    expect(matchRecoveryCode("87654321", hashes)).toBe(false)
  })

  test("source invariant: totp.ts compares codes and recovery hashes via safeEqual", () => {
    const src = readFileSync("src/hrm-server/totp.ts", "utf8")
    // strip line comments so historical notes ("was hashes.includes(...)") don't trip the invariant
    const code = src.replace(/^[ \t]*\/\/.*$/gm, "")
    expect(code).toContain("safeEqual(hotp(")                     // code compare
    expect(code).toContain("safeEqual(h, candidate)")             // recovery-hash compare
    expect(code).not.toMatch(/hotp\(secret, counter \+ drift\) === /) // no plain === on codes
    expect(code).not.toMatch(/return hashes\.includes\(/)         // no early-exit array scan
  })
})

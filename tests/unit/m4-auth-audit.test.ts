/// <reference types="bun-types" />
// ============ M-4 — auth lifecycle audit rows ============
// Regression (audit M-4): login, logout, MFA enable/disable and password
// change left ZERO audit rows (forensic blindness — MFA disable was invisible).
// Fix: each lifecycle event writes an AuditLog row. Drives the REAL
// POST /api/hrm dispatcher.
import { describe, expect, it } from "bun:test"
import { postHrm, totpNow } from "./_hrm-endpoint"
import { db } from "@/lib/db"
import { mkUser, mkVendor, uniq } from "./_fixtures"
import { sessionTokenHash, hashPassword } from "@/hrm-server/auth"
import { generateTotpSecret, encryptSecret } from "@/hrm-server/totp"

const PASSWORD = "Start!23456"

async function auditRows(userId: string) {
  return db.auditLog.findMany({ where: { userId }, orderBy: { createdAt: "asc" } })
}

describe("M-4 — auth lifecycle leaves audit rows", () => {
  it("successful sign-in writes an auth.login row", async () => {
    const vendor = await mkVendor("M4-Login")
    const email = uniq("m4login") + "@t.local"
    const u = await mkUser(vendor.id, { email, role: "EMPLOYEE" })
    await db.user.update({ where: { id: u.id }, data: { passwordHash: hashPassword(PASSWORD), passwordChangedAt: new Date() } })
    const r = await postHrm("auth.login", { email, password: PASSWORD })
    expect(r.status).toBe(200)
    expect(r.body?.data?.token).toBeTruthy()
    const rows = await auditRows(u.id)
    expect(rows.some((x) => x.action === "auth.login" && x.summary.includes("password"))).toBe(true)
  })

  it("logout writes an auth.logout row", async () => {
    const vendor = await mkVendor("M4-Logout")
    const u = await mkUser(vendor.id, { role: "EMPLOYEE" })
    const sid = `m4lo-${uniq("s")}`
    const sess = (await db.session.create({ data: { id: sid, tokenHash: sessionTokenHash(sid), userId: u.id, kind: "FULL", csrfToken: "x", expiresAt: new Date(Date.now() + 3600_000), ip: "127.0.0.1", lastSeenAt: new Date() } })).id
    const r = await postHrm("auth.logout", {}, { bearer: sess })
    expect(r.status).toBe(200)
    const rows = await auditRows(u.id)
    expect(rows.some((x) => x.action === "auth.logout")).toBe(true)
  })

  it("MFA enable and disable each write their audit rows", async () => {
    const vendor = await mkVendor("M4-Mfa")
    const email = uniq("m4mfa") + "@t.local"
    const u = await mkUser(vendor.id, { email, role: "EMPLOYEE" })
    await db.user.update({ where: { id: u.id }, data: { passwordHash: hashPassword(PASSWORD), passwordChangedAt: new Date() } })
    const login = await postHrm("auth.login", { email, password: PASSWORD })
    const token = login.body?.data?.token as string

    // enable: start (stores candidate secret) then enable with the live code
    const start = await postHrm("auth.mfa.start", {}, { bearer: token })
    expect(start.status).toBe(200)
    const secret = start.body?.data?.secret as string
    const enable = await postHrm("auth.mfa.enable", { code: totpNow(secret) }, { bearer: token })
    expect(enable.status).toBe(200)

    // disable with a fresh code (counter advanced by enable) + password (L-1:
    // BOTH factors are required to strip the factor)
    const disable = await postHrm("auth.mfa.disable", { code: totpNow(secret), password: PASSWORD }, { bearer: token })
    expect(disable.status).toBe(200)

    const rows = await auditRows(u.id)
    expect(rows.some((x) => x.action === "auth.mfa.enable")).toBe(true)
    expect(rows.some((x) => x.action === "auth.mfa.disable")).toBe(true)
  })

  it("MFA-completed sign-in (auth.mfa.verify) writes an auth.login row with the MFA note", async () => {
    const vendor = await mkVendor("M4-Verify")
    const email = uniq("m4v") + "@t.local"
    // HR_ADMIN defaults to mfaRequired (MED-17) — enrolled + required → challenge
    const u = await mkUser(vendor.id, { email, role: "HR_ADMIN" })
    await db.user.update({ where: { id: u.id }, data: { passwordHash: hashPassword(PASSWORD), passwordChangedAt: new Date() } })
    // enroll MFA directly (unit shortcut — the enable flow is covered above)
    const secret = generateTotpSecret()
    await db.userMfaSecret.create({ data: { vendorId: vendor.id, userId: u.id, secretEnc: encryptSecret(secret), recoveryCodesHash: "[]" } })
    await db.user.update({ where: { id: u.id }, data: { mfaEnrolled: true } })
    // login → mfaToken
    const login = await postHrm("auth.login", { email, password: PASSWORD })
    expect(login.body?.data?.mfaRequired).toBe(true)
    const mfaToken = login.body?.data?.mfaToken as string
    const verify = await postHrm("auth.mfa.verify", { mfaToken, code: totpNow(secret) })
    expect(verify.status).toBe(200)
    const rows = await auditRows(u.id)
    expect(rows.some((x) => x.action === "auth.login" && x.summary.includes("MFA"))).toBe(true)
  })

  it("password change writes an auth.password.change row", async () => {
    const vendor = await mkVendor("M4-Pwd")
    const email = uniq("m4pwd") + "@t.local"
    const u = await mkUser(vendor.id, { email, role: "EMPLOYEE" })
    await db.user.update({ where: { id: u.id }, data: { passwordHash: hashPassword(PASSWORD), passwordChangedAt: new Date() } })
    // the self-service flow authorizes on the session (ctx.userId)
    const login = await postHrm("auth.login", { email, password: PASSWORD })
    const token = login.body?.data?.token as string
    expect(token).toBeTruthy()
    const r = await postHrm("auth.password.change", { currentPassword: PASSWORD, newPassword: "NewPass!234" }, { bearer: token })
    expect(r.status).toBe(200)
    const rows = await auditRows(u.id)
    expect(rows.some((x) => x.action === "auth.password.change")).toBe(true)
  })
})

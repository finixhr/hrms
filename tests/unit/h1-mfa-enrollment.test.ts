/// <reference types="bun-types" />
// ============ H-1 regression: role-required MFA must force enrollment ============
// Audit H-1 (High): login() computed mfaRequired as `user.mfaEnrolled && roleRequires`
// — the requirement could never force anything, because an UNENROLLED user on an
// MFA-required role sailed through with a full single-factor session (the role
// flag only produced an advisory mfaEnrollSuggested nudge).
//
// Fix under test: role-requiring UNENROLLED users receive NO full session.
// login() returns a 15-minute PREAUTH enrollment challenge (enrollToken) and
// two capability-gated public routes (auth.mfa.enroll.start / .enable) complete
// first-login enrollment; only then is a FULL session minted. C-1 guarantees
// the PREAUTH enrollToken holds no API rights.
//
// All assertions drive the real POST /api/hrm boundary (remediation directive).
import "./_testdb"
import { describe, test, expect, beforeAll } from "bun:test"
import { db } from "@/lib/db"
import { findSessionByToken, hashPassword } from "@/hrm-server/auth"
import { mkVendor, mkUser, mkSession, uniq } from "./_fixtures"
import { postHrm, mkPreauthSession, totpNow } from "./_hrm-endpoint"

const PASSWORD = "H1-Test-Passw0rd!"

let vendor: { id: string }
let owner: { id: string; vendorId: string; email: string }        // VENDOR_OWNER — MFA required by default (MED-17), unenrolled
let plainUser: { id: string; vendorId: string; email: string }    // EMPLOYEE role — MFA not required
let gatedManager: { id: string; vendorId: string; email: string } // HR_MANAGER with an explicit Role row mfaRequired=true

beforeAll(async () => {
  vendor = await mkVendor("H1 Mfa Vendor")
  const mk = async (role: string) => {
    const u = await mkUser(vendor.id, { role, name: `H1 ${role}` })
    // login() verifies the real scrypt hash — plant one known password
    await db.user.update({ where: { id: u.id }, data: { passwordHash: hashPassword(PASSWORD) } })
    return { ...u, email: (u as any).email } as any
  }
  owner = await mk("VENDOR_OWNER")
  plainUser = await mk("EMPLOYEE")
  gatedManager = await mk("HR_MANAGER")
  // explicit Role row: HR_MANAGER requires MFA for this vendor
  await db.role.create({ data: { vendorId: vendor.id, key: "HR_MANAGER", name: "HR Manager", permissions: "[]", mfaRequired: true } as any })
})

describe("H-1 role-required MFA enforces enrollment at login", () => {
  test("unenrolled VENDOR_OWNER gets NO full session — only the enrollment challenge", async () => {
    const { status, body } = await postHrm("auth.login", { email: owner.email, password: PASSWORD })
    expect(status).toBe(200)
    expect(body.ok).toBe(true)
    expect(body.data.token ?? null).toBeNull()                // ← the bug: was a FULL session token (nullish = none minted)
    expect(body.data.mfaEnrollmentRequired).toBe(true)
    expect(typeof body.data.enrollToken).toBe("string")
    // the challenge carrier is a PREAUTH row (holds no API rights — C-1)
    const row = await findSessionByToken(body.data.enrollToken)
    expect(row?.kind).toBe("PREAUTH")
  })

  test("the enrollToken is not a Bearer credential (no API rights until enrollment completes)", async () => {
    const login = await postHrm("auth.login", { email: owner.email, password: PASSWORD })
    const res = await postHrm("employees.list", {}, { bearer: login.body.data.enrollToken })
    expect(res.status).toBe(401)
  })

  test("auth.mfa.enroll.start provisions a TOTP secret for the challenge holder", async () => {
    const login = await postHrm("auth.login", { email: owner.email, password: PASSWORD })
    const enrollToken = login.body.data.enrollToken
    const res = await postHrm("auth.mfa.enroll.start", { enrollToken, email: uniq("h1-start") })
    expect(res.status).toBe(200)
    expect(res.body.data.secret).toMatch(/^[A-Z2-7]{32}$/)
    expect(res.body.data.qrDataUrl).toMatch(/^data:image\//)
    expect(res.body.data.uri).toMatch(/^otpauth:\/\/totp\//)
  })

  test("auth.mfa.enroll.enable with a WRONG code enrolls nothing", async () => {
    const login = await postHrm("auth.login", { email: owner.email, password: PASSWORD })
    const enrollToken = login.body.data.enrollToken
    await postHrm("auth.mfa.enroll.start", { enrollToken, email: uniq("h1-wrong") })
    const res = await postHrm("auth.mfa.enroll.enable", { enrollToken, code: "000000", email: uniq("h1-wrong2") })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/did not match/i)
    const u = await db.user.findUnique({ where: { id: owner.id } })
    expect(u?.mfaEnrolled).toBe(false)
  })

  test("auth.mfa.enroll.enable with the CORRECT code enrolls and returns a working FULL session", async () => {
    const login = await postHrm("auth.login", { email: owner.email, password: PASSWORD })
    const enrollToken = login.body.data.enrollToken
    const start = await postHrm("auth.mfa.enroll.start", { enrollToken, email: uniq("h1-ok") })
    const secret = start.body.data.secret
    const res = await postHrm("auth.mfa.enroll.enable", { enrollToken, code: totpNow(secret), email: uniq("h1-ok2") })
    expect(res.status).toBe(200)
    expect(res.body.data.token).toBeTruthy()
    expect(Array.isArray(res.body.data.recoveryCodes)).toBe(true)
    // enrolled in the DB…
    const u = await db.user.findUnique({ where: { id: owner.id } })
    expect(u?.mfaEnrolled).toBe(true)
    // …and the minted session REALLY works at the boundary
    const use = await postHrm("employees.list", {}, { bearer: res.body.data.token })
    expect(use.status).toBe(200)
    // the PREAUTH challenge row is consumed
    expect(await db.session.findUnique({ where: { id: enrollToken } })).toBeNull()
  })

  test("subsequent login for the now-enrolled owner takes the normal MFA challenge path (not enrollment)", async () => {
    const res = await postHrm("auth.login", { email: owner.email, password: PASSWORD })
    expect(res.body.data.token ?? null).toBeNull()
    expect(res.body.data.mfaRequired).toBe(true)
    expect(typeof res.body.data.mfaToken).toBe("string")
    expect(res.body.data.mfaEnrollmentRequired).toBeUndefined()
  })

  test("enroll.start REFUSES an already-enrolled account (no factor-replacement with a stolen password)", async () => {
    const login = await postHrm("auth.login", { email: owner.email, password: PASSWORD })
    const mfaChallengeToken = login.body.data.mfaToken // PREAUTH row of an enrolled user
    const res = await postHrm("auth.mfa.enroll.start", { enrollToken: mfaChallengeToken, email: uniq("h1-repl") })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/already enabled/i)
  })

  test("explicit Role row mfaRequired=true gates unenrolled custom-role users too", async () => {
    const res = await postHrm("auth.login", { email: gatedManager.email, password: PASSWORD })
    expect(res.body.data.token ?? null).toBeNull()
    expect(res.body.data.mfaEnrollmentRequired).toBe(true)
  })

  test("control: a role that does NOT require MFA still logs in with a plain session (no over-blocking)", async () => {
    const res = await postHrm("auth.login", { email: plainUser.email, password: PASSWORD })
    expect(res.status).toBe(200)
    expect(typeof res.body.data.token).toBe("string")
    expect(res.body.data.mfaEnrollmentRequired).toBeUndefined()
    expect(res.body.data.mfaRequired).toBeUndefined()
  })
})

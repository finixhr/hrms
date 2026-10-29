/// <reference types="bun-types" />
// ============ C-1 regression: PREAUTH tokens must never authenticate ============
// Audit C-1 (Critical): getCtxFromToken() minted a full Ctx (permissions +
// csrfToken) for ANY live session row, including 5/10-minute PREAUTH challenge
// carriers. Anyone holding ONLY a password receives mfaToken/pwToken from the
// login response and could use them directly as Bearer credentials on /api/hrm
// — voiding TOTP and the forced password-expiry gate.
//
// ROUTE-LAYER TEST (per remediation directive): every assertion drives the
// real POST /api/hrm dispatcher with a NextRequest, exactly the way production
// traffic arrives. No engine is called directly — this is the wiring the
// audit found missing (root cause #1).
import "./_testdb" // first — sets DATABASE_URL before db.ts is constructed
import { describe, test, expect, beforeAll } from "bun:test"
import { db } from "@/lib/db"
import { mkVendor, mkUser, mkSession, uniq } from "./_fixtures"
import { postHrm, mkPreauthSession } from "./_hrm-endpoint"

let vendor: { id: string }
let owner: { id: string; vendorId: string; role: string }
let pwToken: string   // password-expiry carrier (10 min)
let mfaToken: string  // MFA challenge carrier (5 min)
let fullToken: string // control: legitimate FULL session

beforeAll(async () => {
  vendor = await mkVendor("C1 Preauth Vendor")
  owner = await mkUser(vendor.id, { role: "VENDOR_OWNER", name: "C1 Owner" })
  pwToken = await mkPreauthSession(owner.id, 10)
  mfaToken = await mkPreauthSession(owner.id, 5)
  fullToken = await mkSession(owner.id, "FULL")
})

describe("C-1 PREAUTH session tokens are rejected at the /api/hrm boundary", () => {
  test("pwToken (password-expiry carrier) as Bearer on a protected action → 401", async () => {
    const { status, body } = await postHrm("employees.list", {}, { bearer: pwToken })
    expect(status).toBe(401)
    expect(body.ok).toBe(false)
  })

  test("mfaToken (MFA challenge carrier) as Bearer on a protected action → 401", async () => {
    const { status, body } = await postHrm("employees.list", {}, { bearer: mfaToken })
    expect(status).toBe(401)
    expect(body.ok).toBe(false)
  })

  test("PREAUTH token in the session cookie (with its own CSRF echoed) is also rejected", async () => {
    // worst case: attacker uses the cookie path AND echoes the PREAUTH row's
    // csrfToken (routes/auth.ts hands it to the client in the MFA flow)
    const row = await db.session.findUnique({ where: { id: mfaToken } })
    const { status } = await postHrm("employees.list", {}, { cookie: mfaToken, csrf: row?.csrfToken || "" })
    expect(status).toBe(401)
  })

  test("PREAUTH Bearer cannot reach ANY protected action — spot-check a second module (settings.get)", async () => {
    const { status } = await postHrm("settings.get", { group: "general" }, { bearer: pwToken })
    expect(status).toBe(401)
  })

  test("control: a FULL session token on the same action still authenticates (no over-blocking)", async () => {
    const { status, body } = await postHrm("employees.list", {}, { bearer: fullToken })
    expect(status).toBe(200)
    expect(body.ok).toBe(true)
  })
})

describe("C-1 fix does not break the legitimate PREAUTH capability flows", () => {
  test("auth.mfa.verify still reaches its handler with a PREAUTH capability in the payload", async () => {
    // A garbage code must produce the HANDLER's own error ("not enrolled" for
    // this unenrolled fixture user), not the dispatcher's 401 — proving the
    // capability path is untouched by the boundary fix.
    const { status, body } = await postHrm("auth.mfa.verify", {
      mfaToken, code: "000000",
      email: uniq("c1-mfa"), // isolated dispatcher throttle bucket
    })
    expect([400, 401]).toContain(status) // handler-range, not dispatcher 401 "Authentication required"
    expect(body.error).toMatch(/not enrolled/i)
  })

  test("auth.password.change still honors the PREAUTH pwToken capability in the payload", async () => {
    // A policy-violating new password must produce the HANDLER's policy error —
    // proving the pwToken flow reached changePassword(), not a dispatcher block.
    const { status, body } = await postHrm("auth.password.change", {
      pwToken, newPassword: "short",
      email: uniq("c1-pw"), // isolated dispatcher throttle bucket
    })
    expect(status).toBe(400)
    expect(body.error).toMatch(/at least/i)
    // the pwToken session is single-use: consumed by the attempt above
    expect(await db.session.findUnique({ where: { id: pwToken } })).toBeNull()
  })
})

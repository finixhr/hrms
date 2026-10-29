/// <reference types="bun-types" />
// ============ M-1 — no shared empty-email throttle bucket on auth.* ============
// Regression (audit M-1): auth.mfa.verify / auth.password.change / auth.logout
// carried no email, so all of them collapsed onto ONE deployment-wide
// "auth:email:" bucket at 10/min (when the client IP is unknown — the default,
// untrusted-proxy configuration). Eleven unauthenticated calls with garbage
// tokens locked the second-factor step for EVERY user.
// Fix: the throttle keys on the capability/session token the action itself is
// gated on. Drives the REAL POST /api/hrm dispatcher.
import { describe, expect, it } from "bun:test"
import { sessionTokenHash } from "@/hrm-server/auth"
import { postHrm } from "./_hrm-endpoint"
import { db } from "@/lib/db"
import { mkUser, mkVendor, uniq } from "./_fixtures"

describe("M-1 — capability-token-keyed auth throttle (no shared bucket)", () => {
  it("12 auth.mfa.verify calls with DISTINCT tokens never share a bucket (all reach the handler, none 429)", async () => {
    for (let i = 0; i < 12; i++) {
      const r = await postHrm("auth.mfa.verify", { mfaToken: `distinct-token-${i}-${uniq("x")}`, code: "000000" })
      // garbage token → the handler's own 401 (challenge expired), NOT the
      // dispatcher's 429 — under the old shared bucket call #11 was 429
      expect(r.status).toBe(401)
      expect(r.body?.error).not.toContain("Too many attempts")
    }
  })

  it("11 auth.mfa.verify calls with the SAME token still throttle (per-challenge brute-force guard intact)", async () => {
    const token = `same-token-${uniq("y")}`
    let saw429 = false
    for (let i = 0; i < 11; i++) {
      const r = await postHrm("auth.mfa.verify", { mfaToken: token, code: "000000" })
      if (r.status === 429) { saw429 = true; break }
      expect(r.status).toBe(401)
    }
    expect(saw429).toBe(true)
  })

  it("mixed capability flows do not lock each other: 10 mfa.verify then a password.change with a fresh pwToken reaches its handler", async () => {
    for (let i = 0; i < 10; i++) {
      await postHrm("auth.mfa.verify", { mfaToken: `mixed-${i}-${uniq("m")}`, code: "000000" })
    }
    // distinct capability → distinct bucket → its own handler 401, not 429
    const r = await postHrm("auth.password.change", { pwToken: `pw-${uniq("p")}`, newPassword: "NewPass!234" })
    expect(r.status).toBe(401)
    expect(r.body?.error).not.toContain("Too many attempts")
  })

  it("identity-free public actions (blank-email auth.password.policy) are not throttled into a shared bucket", async () => {
    for (let i = 0; i < 12; i++) {
      const r = await postHrm("auth.password.policy", { email: "" })
      expect(r.status).toBe(200)
      expect(r.body?.data?.policy).toBeDefined()
    }
  })

  it("logout throttles per session token, not deployment-wide", async () => {
    const vendor = await mkVendor("M1-Logout")
    const u1 = await mkUser(vendor.id, { email: uniq("m1a") + "@t.local" })
    const u2 = await mkUser(vendor.id, { email: uniq("m1b") + "@t.local" })
    // two live FULL sessions
    const s1Id = `s1-${uniq("s")}`
    const s1 = (await db.session.create({ data: { id: s1Id, tokenHash: sessionTokenHash(s1Id), userId: u1.id, kind: "FULL", csrfToken: "x", expiresAt: new Date(Date.now() + 3600_000), ip: "127.0.0.1", lastSeenAt: new Date() } })).id
    const s2Id = `s2-${uniq("s")}`
    const s2 = (await db.session.create({ data: { id: s2Id, tokenHash: sessionTokenHash(s2Id), userId: u2.id, kind: "FULL", csrfToken: "x", expiresAt: new Date(Date.now() + 3600_000), ip: "127.0.0.1", lastSeenAt: new Date() } })).id
    // exhaust u1's per-session bucket (10 calls — logout is idempotent-safe: the
    // session is deleted on the first, later calls still pass the throttle)
    for (let i = 0; i < 10; i++) {
      await postHrm("auth.logout", {}, { bearer: s1 })
    }
    // u2's logout is a DIFFERENT bucket — must not be affected
    const r2 = await postHrm("auth.logout", {}, { bearer: s2 })
    expect(r2.status).toBe(200)
    // and u1's own 11th is throttled
    const r1 = await postHrm("auth.logout", {}, { bearer: s1 })
    expect(r1.status).toBe(429)
  })
})

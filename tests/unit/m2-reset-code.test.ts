/// <reference types="bun-types" />
// ============ M-2 — CSPRNG reset code + timing-safe digest compare ============
// Regression (audit M-2): the emailed password-reset code was generated with
// Math.random() (non-CSPRNG, 40-bit alphabet) and the submitted code's sha256
// digest was compared with === (non-timing-safe) across same-email users.
// Fix: crypto.randomBytes-based generation + safeEqual digest match.
// Drives the REAL POST /api/hrm dispatcher (auth.resetPassword) for the
// compare path; generateResetCode is exercised directly for the generator.
import { describe, expect, it } from "bun:test"
import { postHrm } from "./_hrm-endpoint"
import { db } from "@/lib/db"
import { mkUser, mkVendor, uniq } from "./_fixtures"
import { generateResetCode } from "@/hrm-server/routes/auth"
import crypto from "crypto"

describe("M-2 — password reset code CSPRNG + timing-safe compare", () => {
  it("generateResetCode: 8 chars, unambiguous alphabet only, non-deterministic", () => {
    const seen = new Set<string>()
    for (let i = 0; i < 200; i++) {
      const c = generateResetCode()
      expect(c).toMatch(/^[A-HJ-NP-Z2-9]{8}$/)
      seen.add(c)
    }
    // 200 draws of a 40-bit value must be far from identical
    expect(seen.size).toBeGreaterThan(150)
  })

  it("auth.resetPassword accepts a known code via the timing-safe digest compare (end-to-end)", async () => {
    const vendor = await mkVendor("M2-V")
    const email = uniq("m2") + "@t.local"
    const u = await mkUser(vendor.id, { email })
    // seed the digest exactly as forgotPassword does
    const code = "7KMF9QZT"
    await db.user.update({
      where: { id: u.id },
      data: {
        passwordResetToken: crypto.createHash("sha256").update(code).digest("hex"),
        passwordResetExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    })
    const r = await postHrm("auth.resetPassword", { email, code, newPassword: "NewPass!234" })
    expect(r.status).toBe(200)
    expect(r.body?.data?.reset).toBe(true)
    // code burned + token cleared
    const after = await db.user.findUnique({ where: { id: u.id } })
    expect(after?.passwordResetToken).toBeNull()
  })

  it("auth.resetPassword rejects a wrong code and does not burn a valid parallel one", async () => {
    const vendor = await mkVendor("M2-V2")
    const email = uniq("m2b") + "@t.local"
    const good = "ABCD2345"
    const u = await mkUser(vendor.id, { email })
    await db.user.update({
      where: { id: u.id },
      data: {
        passwordResetToken: crypto.createHash("sha256").update(good).digest("hex"),
        passwordResetExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    })
    const bad = await postHrm("auth.resetPassword", { email, code: "WRONGCODE", newPassword: "NewPass!234" })
    expect(bad.status).toBe(400)
    // the good code still works after the failed attempt
    const ok = await postHrm("auth.resetPassword", { email, code: good, newPassword: "NewPass!234" })
    expect(ok.status).toBe(200)
  })

  it("expired code is rejected even when the digest matches", async () => {
    const vendor = await mkVendor("M2-V3")
    const email = uniq("m2c") + "@t.local"
    const code = "XYZA6789"
    const u = await mkUser(vendor.id, { email })
    await db.user.update({
      where: { id: u.id },
      data: {
        passwordResetToken: crypto.createHash("sha256").update(code).digest("hex"),
        passwordResetExpiresAt: new Date(Date.now() - 1000),
      },
    })
    const r = await postHrm("auth.resetPassword", { email, code, newPassword: "NewPass!234" })
    expect(r.status).toBe(400)
    expect(r.body?.error).toContain("expired")
  })
})

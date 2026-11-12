/// <reference types="bun-types" />
// ============ M-3 — legacy MFA key rotation path ============
// Audit M-3: pre-H8 TOTP secrets are encrypted under a key derived from a
// PUBLIC repo constant. The fix ships a one-shot rotation script
// (scripts/rotate-mfa-legacy-secrets.ts) so every legacy row can be
// re-encrypted under HRM_MFA_KEY. This suite pins the crypto invariants the
// script depends on, at the unit level against the REAL crypto-field module.
import { describe, expect, it } from "bun:test"
import {
  encryptFieldMfaLegacy, decryptFieldMfaLegacy, mfaSecretNeedsReencrypt, fieldKeyConfigured,
} from "@/hrm-server/crypto-field"
import { encryptSecret, decryptSecret, needsReencrypt } from "@/hrm-server/totp"

const SECRET = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP" // standard RFC test vector base32

describe("M-3 — legacy MFA secret rotation invariants", () => {
  it("legacy format round-trips under the legacy key (public constant) — the exposure M-3 closes", () => {
    const legacy = encryptFieldMfaLegacy(SECRET)
    expect(legacy).not.toContain("v2:")
    expect(legacy.split(".")).toHaveLength(3) // iv.tag.enc
    expect(decryptFieldMfaLegacy(legacy)).toBe(SECRET)
  })

  it("mfaSecretNeedsReencrypt flags legacy rows ONLY when HRM_MFA_KEY is set", () => {
    const legacy = encryptFieldMfaLegacy(SECRET)
    const prev = process.env.HRM_MFA_KEY
    try {
      if (fieldKeyConfigured()) {
        expect(mfaSecretNeedsReencrypt(legacy)).toBe(true) // rotation candidate
      }
      delete process.env.HRM_MFA_KEY
      // nothing can be rotated without a target key
      expect(mfaSecretNeedsReencrypt(legacy)).toBe(false)
    } finally {
      if (prev) process.env.HRM_MFA_KEY = prev
    }
  })

  it("decryptSecret (totp shim) reads legacy rows and needsReencrypt drives the lazy migration", () => {
    const prev = process.env.HRM_MFA_KEY
    try {
      if (!prev) process.env.HRM_MFA_KEY = "ab".repeat(32) // 64-char hex test key
      const legacy = encryptFieldMfaLegacy(SECRET)
      expect(decryptSecret(legacy)).toBe(SECRET)
      expect(needsReencrypt(legacy)).toBe(true)
      // after rotation (v2 under env key): decrypts, no longer flagged
      const v2 = encryptSecret(SECRET)
      expect(v2.startsWith("v2:")).toBe(true)
      expect(decryptSecret(v2)).toBe(SECRET)
      expect(needsReencrypt(v2)).toBe(false)
    } finally {
      if (prev) process.env.HRM_MFA_KEY = prev
      else delete process.env.HRM_MFA_KEY
    }
  })

  it("v2 ciphertexts never decrypt under the legacy key (context separation intact)", () => {
    const prev = process.env.HRM_MFA_KEY
    try {
      if (!prev) process.env.HRM_MFA_KEY = "cd".repeat(32)
      const v2body = encryptSecret(SECRET).replace(/^v2:/, "")
      expect(() => decryptFieldMfaLegacy(v2body)).toThrow()
    } finally {
      if (prev) process.env.HRM_MFA_KEY = prev
      else delete process.env.HRM_MFA_KEY
    }
  })
})

// ============ TOTP (RFC 6238) — MFA / 2FA enrolment & verification (HRM-006) ============
// Zero-dependency implementation on node:crypto (HMAC-SHA1) + base32 encoding.
// Compatible with Google Authenticator, Microsoft Authenticator, Authy, 1Password.
import crypto from "crypto"
import { safeEqual } from "./security"

// ---------- base32 (RFC 4648, no padding) ----------
const B32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"

export function base32Encode(buf: Buffer): string {
  let bits = 0
  let value = 0
  let output = ""
  for (const byte of buf) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      output += B32_ALPHABET[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) output += B32_ALPHABET[(value << (5 - bits)) & 31]
  return output
}

export function base32Decode(s: string): Buffer {
  const clean = s.replace(/=+$/g, "").replace(/\s+/g, "").toUpperCase()
  let bits = 0
  let value = 0
  const bytes: number[] = []
  for (const ch of clean) {
    const idx = B32_ALPHABET.indexOf(ch)
    if (idx === -1) continue
    value = (value << 5) | idx
    bits += 5
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255)
      bits -= 8
    }
  }
  return Buffer.from(bytes)
}

// ---------- TOTP core ----------
const PERIOD = 30 // seconds per step (standard)
const DIGITS = 6
const WINDOW = 1 // accept ±1 step of clock drift

function hotp(secret: Buffer, counter: number): string {
  const buf = Buffer.alloc(8)
  buf.writeUInt32BE(Math.floor(counter / 2 ** 32), 0)
  buf.writeUInt32BE(counter % 2 ** 32, 4)
  const hmac = crypto.createHmac("sha1", secret).update(buf).digest()
  const offset = hmac[hmac.length - 1] & 0xf
  const code =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff)
  return String(code % 10 ** DIGITS).padStart(DIGITS, "0")
}

export function generateTotpSecret(): string {
  return base32Encode(crypto.randomBytes(20))
}

/** Verify a 6-digit TOTP code against the secret with ±1 step drift tolerance.
 * Returns the matched counter so callers can enforce replay protection (M-16). */
export function verifyTotpWithCounter(secretBase32: string, code: string): { ok: boolean; counter: number } {
  const clean = String(code || "").replace(/\D/g, "")
  if (clean.length !== DIGITS) return { ok: false, counter: 0 }
  const secret = base32Decode(secretBase32)
  const counter = Math.floor(Date.now() / 1000 / PERIOD)
  for (let drift = -WINDOW; drift <= WINDOW; drift++) {
    // L-3 — timing-safe code comparison (the codebase's shared safeEqual);
    // a plain === leaks early-exit timing on the 6-digit guess space
    if (safeEqual(hotp(secret, counter + drift), clean)) return { ok: true, counter: counter + drift }
  }
  return { ok: false, counter: 0 }
}

/** Backward-compatible boolean verification (no replay tracking). */
export function verifyTotp(secretBase32: string, code: string): boolean {
  return verifyTotpWithCounter(secretBase32, code).ok
}

/** otpauth:// URI for authenticator apps + QR provisioning. */
export function totpUri(secretBase32: string, account: string, issuer: string): string {
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secretBase32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${DIGITS}&period=${PERIOD}`
}

// ---------- secret encryption at rest (AES-256-GCM) — REFACTORED Phase 3 ----------
// All envelope crypto (encrypt/decrypt/legacy-fallback) moved to
// src/hrm-server/crypto-field.ts so the Camera Manager (Phase 3+) can reuse
// the same AES-256-GCM scheme with a context-parameterized salt
// ("cameras::v1") for domain isolation. MFA and camera credentials share
// the deployment env key (HRM_MFA_KEY) but derive DIFFERENT data-encryption
// keys — a breach of one domain's keys does NOT automatically expose the
// other.
//
// MFA backward-compat is BIT-FOR-BIT preserved:
//   - The packed format stays "v2:<ivHex>.<tagHex>.<encHex>" (the "v2:"
//     prefix marks env-keyed secrets; camera credentials do NOT use this
//     prefix — they store version in the encryptionKeyVersion column).
//   - The legacy fallback for unprefixed secrets (decryptFieldMfaLegacy)
//     stays MFA-specific. Camera credentials have no legacy fallback.
//
// Unit-tested by tests/unit/crypto-field-mfa-backcompat.test.ts: a
// pre-refactor ciphertext literal decrypts to the original plaintext under
// the refactored decryptSecret().
//
// TODO(crypto-unification): MFA's "v2:" prefix and camera's
// encryptionKeyVersion column are two separate versioning mechanisms. They
// stay separate on purpose — unifying them is future cleanup.
import {
  encryptField, decryptField, decryptFieldMfaLegacy,
  fieldKeyConfigured, mfaSecretNeedsReencrypt,
} from "./crypto-field"

const MFA_CONTEXT = "mfa::v2"

/** H-8 — MFA enrolment must refuse to store new secrets without a deployment key.
 *  Backward-compat: re-exports fieldKeyConfigured() from crypto-field.ts
 *  (callers in routes/auth.ts import this name verbatim). */
export function mfaKeyConfigured(): boolean {
  return fieldKeyConfigured()
}

/** Encrypt a TOTP secret at rest. Packed format: "v2:iv.tag.enc" — the "v2:"
 *  prefix marks this as env-keyed (vs. legacy unprefixed secrets written
 *  under the hardcoded key before H-8 remediation). Camera credentials do
 *  NOT use this prefix — they store version in the encryptionKeyVersion column. */
export function encryptSecret(plain: string): string {
  // encryptField throws (code 500) if HRM_MFA_KEY is unset — matches the
  // original fail-closed behavior at encryptSecret.
  return `v2:${encryptField(plain, MFA_CONTEXT)}`
}

/** Decrypt a TOTP secret. Handles three cases bit-for-bit as the pre-refactor
 *  implementation did:
 *    1. "v2:iv.tag.enc" + HRM_MFA_KEY set → current env-keyed key (decryptField)
 *    2. "iv.tag.enc" (legacy) + HRM_MFA_KEY set → try legacy fixed key first
 *       (decryptFieldMfaLegacy); fall through to env-keyed key on failure
 *       (migration aid for secrets encrypted under the legacy key AFTER the
 *       env key was set — unusual but defensive)
 *    3. "iv.tag.enc" (legacy) + HRM_MFA_KEY unset → legacy fixed key
 *       (decryptFieldMfaLegacy; only this path works when no env key) */
export function decryptSecret(packed: string): string {
  const [version, body] = String(packed || "").split(":")
  // Case 1: v2-prefixed → strip prefix, decrypt with env-keyed key
  if (version === "v2" && body) {
    return decryptField(body, MFA_CONTEXT)
  }
  // Cases 2 & 3: legacy unprefixed → try legacy fixed key first
  try {
    return decryptFieldMfaLegacy(packed)
  } catch {
    // Fall through to env-keyed key (only viable when env key is set)
  }
  if (!fieldKeyConfigured()) {
    throw new Error("Corrupt MFA secret (legacy decrypt failed, no HRM_MFA_KEY to fall back to)")
  }
  return decryptField(packed, MFA_CONTEXT)
}

/** H-8 — re-encrypt a legacy secret under the current key (called after
 *  successful verify). Delegates to crypto-field.ts's mfaSecretNeedsReencrypt
 *  for bit-for-bit behavior. */
export function needsReencrypt(packed: string): boolean {
  return mfaSecretNeedsReencrypt(packed)
}

// ---------- recovery codes ----------
/** Generate 10 single-use recovery codes (R6-014: 20 bytes = 160 bits entropy per code).
 *  Format: xxxxx-xxxxx-xxxxx-xxxxx (4×5 hex chars). Only SHA-256 hashes are stored. */
export function generateRecoveryCodes(): string[] {
  const codes: string[] = []
  for (let i = 0; i < 10; i++) {
    const b = crypto.randomBytes(10) // 10 bytes = 80 bits per code
    const hex = b.toString("hex")    // 20 hex chars
    codes.push(`${hex.slice(0,5)}-${hex.slice(5,10)}-${hex.slice(10,15)}-${hex.slice(15,20)}`)
  }
  return codes
}

export function hashCode(code: string): string {
  return crypto.createHash("sha256").update(code.trim().toLowerCase()).digest("hex")
}

/** Constant-time-ish comparison; returns true when the code matches any hash. */
export function matchRecoveryCode(code: string, hashesJson: string): boolean {
  let hashes: string[] = []
  try {
    hashes = JSON.parse(hashesJson || "[]")
  } catch {
    return false
  }
  // L-3 — timing-safe hash comparison (was hashes.includes(hashCode(code)))
  const candidate = hashCode(code)
  return hashes.some((h) => typeof h === "string" && h.length === candidate.length && safeEqual(h, candidate))
}

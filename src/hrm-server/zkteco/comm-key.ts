// ============ Device comm key at-rest encryption (M-20) ============
// Audit M-20: AttendanceDevice.commKey was stored in PLAINTEXT alongside the
// scrypt hash — a database dump exposed working device credentials. The value
// is now AES-256-GCM encrypted under HRM_MFA_KEY via the shared crypto-field
// scheme, context-isolated from MFA and cameras ("devices::v1").
//
// Format: "enc::<ivHex>.<tagHex>.<encHex>". Legacy plaintext rows (written
// before M-20) remain readable through readCommKey's fallback until the
// one-shot rotation script (scripts/encrypt-secrets-at-rest.ts) re-wraps them;
// rows that are hash-only (commKeyHash set, commKey null — pre-C-03
// enrollment) were never verifiable and are surfaced to ISAPI as an explicit
// re-enroll instruction instead of an empty-key HMAC mismatch.
import { encryptField, decryptField, fieldKeyConfigured } from "../crypto-field"

const DEVICE_CONTEXT = "devices::v1"
const ENC_PREFIX = "enc::"

/** True when the stored commKey value is in the M-20 encrypted format. */
export function commKeyEncrypted(value: string | null | undefined): boolean {
  return typeof value === "string" && value.startsWith(ENC_PREFIX)
}

/** Wrap a plaintext comm key for storage (requires HRM_MFA_KEY). */
export function encryptCommKey(key: string): string {
  return ENC_PREFIX + encryptField(key, DEVICE_CONTEXT)
}

/**
 * Recover the plaintext comm key for HMAC verification.
 *   - encrypted rows → decrypt under the deployment key
 *   - legacy plaintext rows → returned as-is (readable until rotated)
 *   - null → null (no key on file)
 * Decrypt failures (rotated/corrupt key) return null — the caller treats the
 * row as keyless rather than leaking a ciphertext into an HMAC.
 */
export function readCommKey(value: string | null | undefined): string | null {
  if (value == null || value === "") return null
  if (!commKeyEncrypted(value)) return value // legacy plaintext row (pre-M-20)
  try {
    return decryptField(value.slice(ENC_PREFIX.length), DEVICE_CONTEXT)
  } catch {
    return null
  }
}

/** Gate for the write path (devices.setCommKey) — fail closed without the key,
 *  exactly like MFA enrollment and camera credentials. */
export function commKeyEncryptionAvailable(): boolean {
  return fieldKeyConfigured()
}

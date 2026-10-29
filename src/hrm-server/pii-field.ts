// ============ Employee PII at-rest encryption (audit F28 — Phase 5 P6) ============
// Audit F28: BankAccount.accountNumber / mfsNumber and EmployeeDocument.
// docNumber / fileData were stored in PLAINTEXT — masking was API-layer only,
// so a database dump alone exposed every bank account, NID/passport number
// and document FILE. The same AES-256-GCM + HKDF-SHA256 scheme that already
// protects MFA secrets, camera credentials, device comm keys and comms
// secrets (crypto-field.ts, context-separated) now covers employee PII under
// the "pii::v1" context (SEC-13 per-context override: HRM_PII_KEY).
//
// TWO transport packings, ONE key context:
//   enc::<ivHex>.<tagHex>.<encHex>       — small text (account/MFS/document
//                                          numbers). Identical envelope shape
//                                          to the M-20 comm-key format.
//   encf::<ivB64>.<tagB64>.<dataB64>     — file payloads (base64 document
//                                          bytes, up to ~2.7 MB per row).
//                                          Hex would DOUBLE the stored size;
//                                          base64 keeps it ≈ input + 33%.
// Both derive the same AES-256 key via HKDF-SHA256(context="pii::v1") —
// the packing differs only in transport encoding.
//
// READ policy (exactly the M-20 comm-key discipline):
//   - null/empty                → null
//   - legacy plaintext (no prefix) → returned AS-IS (upgrade-safe until the
//     one-shot rotation script scripts/encrypt-secrets-at-rest.ts re-wraps)
//   - enc::/encf::              → decrypted under the deployment key
//   - decrypt failure (rotated-away/corrupt key):
//       readPiiText()          → null          (display paths: masked UIs
//                                               show "—" instead of throwing)
//       readPiiTextStrict()    → THROWS        (disbursement paths: a salary
//                                               export must NEVER silently
//                                               emit a missing account
//                                               number into a bank file)
//
// WRITE policy — fail-closed when no key is configured and a value is being
// written (same as MFA enrollment, setCommKey and comms secrets): storing new
// plaintext PII is never silently accepted.
import { encryptField, decryptField, fieldKeyConfigured } from "./crypto-field"

export const PII_CONTEXT = "pii::v1"
const ENC_PREFIX = "enc::"    // hex-packed small text
const ENCF_PREFIX = "encf::"  // base64-packed file payloads

/** True when the stored value is in either P6 encrypted format. */
export function piiEncrypted(value: string | null | undefined): boolean {
  return typeof value === "string" && (value.startsWith(ENC_PREFIX) || value.startsWith(ENCF_PREFIX))
}

/** Gate for the write paths — fail closed without a deployment key. */
export function piiEncryptionAvailable(): boolean {
  return fieldKeyConfigured()
}

// ---------- small text (account numbers, document numbers) ----------

/** Wrap a plaintext number for storage (requires a key; fail-closed). */
export function encryptPiiText(plain: string): string {
  return ENC_PREFIX + encryptField(plain, PII_CONTEXT)
}

/**
 * Recover a plaintext number for DISPLAY/masking.
 *   - encrypted rows → decrypt (null on failure — never throw at a UI)
 *   - legacy plaintext rows → as-is (readable until rotated)
 *   - null/empty → null
 */
export function readPiiText(value: string | null | undefined): string | null {
  if (value == null || value === "") return null
  if (!piiEncrypted(value)) return value // legacy plaintext row (pre-P6)
  try {
    return decryptField(value.slice(ENC_PREFIX.length), PII_CONTEXT)
  } catch {
    return null
  }
}

/**
 * Recover a plaintext number for DISBURSEMENT (salary export, payout
 * resolution). Decrypt failure THROWS with an operator-actionable message —
 * a bank file must never silently lose an account number.
 */
export function readPiiTextStrict(value: string | null | undefined, what = "value"): string | null {
  if (value == null || value === "") return null
  if (!piiEncrypted(value)) return value
  try {
    return decryptField(value.slice(ENC_PREFIX.length), PII_CONTEXT)
  } catch {
    throw new Error(
      `Stored ${what} is encrypted under a key this deployment no longer has (pii::v1) — set the correct HRM_PII_KEY/HRM_MFA_KEY or re-run scripts/encrypt-secrets-at-rest.ts under the new key`,
    )
  }
}

// ---------- file payloads (EmployeeDocument.fileData — base64 bytes) ----------

/**
 * Wrap a base64/data-URL file payload for storage. Uses base64 packing so a
 * 2 MB document stores as ≈ 2.7 MB instead of ≈ 5.3 MB under hex.
 * Requires a key; fail-closed.
 */
export function encryptPiiFile(plain: string): string {
  return ENCF_PREFIX + encryptFileBase64(plain)
}

/**
 * File transport: routes through crypto-field's encryptField (ONE derivation
 * path — same HKDF context, same AES-256-GCM), then re-packs the hex envelope
 * into base64 transport (see module header for why the packing differs).
 */
function encryptFileBase64(plain: string): string {
  const [ivH, tagH, encH] = encryptField(plain, PII_CONTEXT).split(".") // ivHex.tagHex.encHex
  return [
    Buffer.from(ivH, "hex").toString("base64"),
    Buffer.from(tagH, "hex").toString("base64"),
    Buffer.from(encH, "hex").toString("base64"),
  ].join(".")
}

/**
 * Recover a file payload (download/view paths — STRICT: a download that
 * cannot decrypt must fail loudly, never serve garbage bytes).
 *   - legacy plaintext rows → as-is (readable until rotated)
 *   - null → null
 */
export function readPiiFileStrict(value: string | null | undefined): string | null {
  if (value == null || value === "") return null
  if (!value.startsWith(ENCF_PREFIX)) return value // legacy plaintext
  const packed = value.slice(ENCF_PREFIX.length)
  const [ivB, tagB, dataB] = String(packed).split(".")
  if (!ivB || !tagB || !dataB) {
    throw new Error("Corrupt encrypted document payload (pii::v1/encf)")
  }
  const hex = `${Buffer.from(ivB, "base64").toString("hex")}.${Buffer.from(tagB, "base64").toString("hex")}.${Buffer.from(dataB, "base64").toString("hex")}`
  try {
    return decryptField(hex, PII_CONTEXT)
  } catch {
    throw new Error(
      "Stored document file is encrypted under a key this deployment no longer has (pii::v1) — set the correct HRM_PII_KEY/HRM_MFA_KEY or re-encrypt under the new key",
    )
  }
}

/** Lenient display variant: null on any failure (existence probes / sizes). */
export function readPiiFile(value: string | null | undefined): string | null {
  try {
    return readPiiFileStrict(value)
  } catch {
    return null
  }
}

// ---------- row-level helpers used by the route layer ----------

/**
 * Mask a (possibly encrypted) account/document number to "•••• 1234" for
 * API responses — decrypts first so the last-4 shown is always the REAL
 * last-4, then applies the C-05/RBAC-102 mask. Returns null for
 * null/empty/undecryptable values.
 */
export function maskPiiNumber(value: string | null | undefined): string | null {
  const plain = readPiiText(value)
  if (!plain) return null
  return `•••• ${String(plain).slice(-4)}`
}

/**
 * Prepare an incoming account/MFS/document-number value for storage:
 *   - null/undefined/""   → null (field cleared)
 *   - already encrypted   → returned untouched (the payout merge path keeps
 *                           stored ciphertexts when the client sends blanks)
 *   - plaintext           → encrypted (fail-closed without a key)
 */
export function piiTextForStorage(value: string | null | undefined): string | null {
  if (value == null || value === "") return null
  if (piiEncrypted(value)) return value
  return encryptPiiText(String(value).trim())
}

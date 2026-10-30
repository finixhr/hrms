// ============ Field-level encryption (AES-256-GCM) with context isolation ============
// Extracted from totp.ts in Phase 3 so the Camera Manager (and future domains)
// can reuse the same crypto scheme with a context-parameterized salt. MFA
// and camera credentials share the deployment env key (HRM_MFA_KEY) but
// derive DIFFERENT data-encryption keys via the context — a breach of one
// domain's keys does NOT automatically expose the other.
//
// Packed format: "<ivHex>.<tagHex>.<encHex>" — NO version prefix. The caller
// manages versioning separately:
//   - MFA: prepends "v2:" string prefix to the packed format (preserved
//     bit-for-bit from the pre-refactor totp.ts; legacy fallback for
//     unprefixed secrets handled by decryptFieldMfaLegacy() below).
//   - Camera: stores the version in the CameraCredential.encryptionKeyVersion
//     column (no string prefix). The two versioning mechanisms are kept
//     separate on purpose — TODO(crypto-unification) future cleanup.
//
// See src/hrm/CONVENTIONS.md and src/hrm/API.md for broader app conventions.
// MFA backward-compat is proven by tests/unit/crypto-field-mfa-backcompat.test.ts
// (decrypts a pre-refactor MFA ciphertext literal).
import crypto from "crypto"

// ---------- constants ----------

/** Namespace prefix for all key-derivation salts in this app. */
const BASE_SALT = "finix-mart-hrm"

/**
 * MFA legacy salt — preserved bit-for-bit from the pre-refactor totp.ts.
 * Used by decryptFieldMfaLegacy() to read secrets written under the original
 * hardcoded key (before H-8 remediation introduced HRM_MFA_KEY). MFA-only —
 * camera credentials have no legacy fallback.
 */
const MFA_LEGACY_SALT = "finix-mart-hrm::mfa::v1"

// ---------- env-key configuration ----------

/**
 * True when the deployment has set HRM_MFA_KEY. Despite the name (historical),
 * this single env key is the shared root for ALL encrypted-field contexts in
 * the app — MFA secrets AND camera cloud credentials. Rotating it requires
 * re-encrypting every field under the new key (MFA does this transparently
 * on next verify via totp.ts's needsReencrypt path; cameras will need a
 * migration script when rotation is added in a future phase).
 */
export function fieldKeyConfigured(): boolean {
  return !!process.env.HRM_MFA_KEY
}

// ---------- SEC-13 (Phase 1) — per-context key overrides ----------
/**
 * SEC-13: a single env key (HRM_MFA_KEY) roots every encryption context —
 * rotating it silently re-keys MFA, cameras, devices, webhooks, AI, comms and
 * payments at once, and a mistake bricks all of them together. The START of
 * the split (Phase 1) lets each context carry its OWN env key while keeping
 * HRM_MFA_KEY as the backward-compatible fallback: existing deployments
 * (single key) behave identically; new deployments can set, and rotate,
 * e.g. HRM_CAMERA_KEY alone. Set the overrides in .env / .env.keys.local
 * (both gitignored).
 */
const CONTEXT_ENV_KEYS: Array<{ test: (ctx: string) => boolean; env: string; label: string }> = [
  { test: (c) => c.startsWith("cameras::"), env: "HRM_CAMERA_KEY", label: "cameras (any version)" },
  { test: (c) => c === "devices::v1", env: "HRM_DEVICE_KEY", label: "device comm keys" },
  { test: (c) => c === "webhooks::v1", env: "HRM_WEBHOOK_KEY", label: "webhook signing secrets" },
  { test: (c) => c === "ai::v1", env: "HRM_AI_KEY", label: "AI provider keys" },
  { test: (c) => c === "comms::v1", env: "HRM_COMMS_KEY", label: "email/SMS gateway credentials" },
  { test: (c) => c === "saas-payments::v1", env: "HRM_PAYMENTS_KEY", label: "payment gateway credentials" },
  // ---- Phase 5 P6 (2026-10-22) — employee PII + web push VAPID ----
  { test: (c) => c === "pii::v1", env: "HRM_PII_KEY", label: "employee PII at rest (bank/MFS numbers, document numbers, document files)" },
  { test: (c) => c === "push::v1", env: "HRM_PUSH_KEY", label: "web-push VAPID private keys" },
  { test: (c) => c === "mfa::v2", env: "HRM_MFA_KEY", label: "MFA TOTP secrets (root, historical name)" },
]

/** SEC-13 — the env variable that currently keys `context`, and whether an
 *  explicit per-context override is active. For tooling/diagnostics. */
export function contextKeySource(context: string): { env: string; override: boolean } {
  for (const { test, env } of CONTEXT_ENV_KEYS) {
    if (test(context)) {
      return { env, override: !!process.env[env] && env !== "HRM_MFA_KEY" }
    }
  }
  return { env: "HRM_MFA_KEY", override: false } // unknown contexts ride the root key
}

/** Resolve the env key VALUE for a context (per-context override → root). */
function contextEnvKey(context: string): string {
  for (const { test, env } of CONTEXT_ENV_KEYS) {
    if (test(context) && process.env[env]) return process.env[env] as string
  }
  return process.env.HRM_MFA_KEY || ""
}

// ---------- key derivation ----------

/**
 * Derive the AES-256 key for a given context. The salt is
 *   "<BASE_SALT>::<context>::<envKey>"
 * so MFA ("mfa::v2") and cameras ("cameras::v1") derive different keys from
 * the same HRM_MFA_KEY.
 *
 * SEC-13 (Phase 1): the env key VALUE comes from the per-context override
 * when one is set (HRM_CAMERA_KEY / HRM_DEVICE_KEY / HRM_WEBHOOK_KEY /
 * HRM_AI_KEY / HRM_COMMS_KEY / HRM_PAYMENTS_KEY), falling back to HRM_MFA_KEY
 * — identical behavior for existing single-key deployments.
 * `explicitEnvKey` (rotation tooling only) bypasses the env entirely.
 *
 * Throws if no key resolves (fail-closed for new writes AND for decrypts
 * of post-refactor ciphertexts). The MFA legacy decrypt path
 * (decryptFieldMfaLegacy) does NOT use this function — it uses the hardcoded
 * MFA_LEGACY_SALT so pre-refactor secrets remain readable.
 */
function deriveKey(context: string, explicitEnvKey?: string): Buffer {
  const envKey = explicitEnvKey ?? contextEnvKey(context)
  if (!envKey) {
    throw new Error(`Cannot derive key for context "${context}": no env key configured (per-context override or HRM_MFA_KEY)`)
  }
  // MED-15 (this audit) — HKDF-SHA256 replaces the single SHA-256 hash.
  // The previous construction was a single SHA-256 over `${BASE_SALT}::${context}::${envKey}`
  // which has no work factor — if the env key is low-entropy (user-typed
  // password), derived keys are brute-forceable. HKDF-SHA256 with the salt =
  // BASE_SALT and info = context provides proper key separation per the
  // RFC 5869 extract-then-expand design. Output: 32 bytes (AES-256 key).
  //
  // Backward-compatibility: ciphertexts encrypted under the previous single-SHA-256
  // key continue to decrypt because the legacy decrypt path
  // (decryptFieldMfaLegacy) uses MFA_LEGACY_SALT, not this function. New
  // ciphertexts use HKDF — the transition is gradual (lazy re-encryption on
  // next successful decrypt via totp.ts needsReencrypt pattern).
  const salt = Buffer.from(BASE_SALT, "utf8")
  const ikm = Buffer.from(envKey, "utf8")
  const info = Buffer.from(context, "utf8")
  try {
    // Node 16+ has crypto.hkdfSync.
    return Buffer.from(crypto.hkdfSync("sha256", ikm, salt, info, 32))
  } catch {
    // Fallback: manual HKDF-Extract + HKDF-Expand per RFC 5869.
    // HMAC-SHA256(PRK=HMAC(salt, ikm), info + 0x01) for a single 32-byte block.
    const prk = crypto.createHmac("sha256", salt).update(ikm).digest()
    const t = crypto.createHmac("sha256", prk).update(Buffer.concat([info, Buffer.from([1])])).digest()
    return t.subarray(0, 32)
  }
}

// ---------- rotation tooling (SEC-13 Phase 1, explicit-key variants) ----------

/** Encrypt with an EXPLICIT env-key value (rotation tooling only). */
export function encryptFieldWithKey(plain: string, context: string, envKeyValue: string): string {
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv("aes-256-gcm", deriveKey(context, envKeyValue), iv)
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()])
  const tag = cipher.getAuthTag()
  return `${iv.toString("hex")}.${tag.toString("hex")}.${enc.toString("hex")}`
}

/** Decrypt with an EXPLICIT env-key value; throws on auth failure (no legacy
 *  fallbacks — the rotation tool wants a hard yes/no). */
export function decryptFieldWithKey(packed: string, context: string, envKeyValue: string): string {
  const [ivH, tagH, encH] = String(packed || "").split(".")
  if (!ivH || !tagH || !encH) throw new Error(`Corrupt encrypted field (context=${context})`)
  const decipher = crypto.createDecipheriv("aes-256-gcm", deriveKey(context, envKeyValue), Buffer.from(ivH, "hex"))
  decipher.setAuthTag(Buffer.from(tagH, "hex"))
  return Buffer.concat([decipher.update(Buffer.from(encH, "hex")), decipher.final()]).toString("utf8")
}

/**
 * SEC-13 — the re-encrypt PATH. Given a packed ciphertext and the env-key
 * values on both sides of a rotation:
 *   - decrypts under oldKey (the value being rotated away from),
 *   - re-wraps under newKey (already set in .env).
 * Returns the new packed string, or null when the ciphertext already decrypts
 * under newKey (nothing to do) or under neither key (surfaced as a failure by
 * the caller — never silently dropped).
 */
export function reencryptField(packed: string, context: string, newKey: string, oldKey?: string): string | null {
  // already migrated?
  try {
    decryptFieldWithKey(packed, context, newKey)
    return null
  } catch { /* not yet under the new key */ }
  if (!oldKey) return null
  try {
    const plain = decryptFieldWithKey(packed, context, oldKey)
    return encryptFieldWithKey(plain, context, newKey)
  } catch {
    return null
  }
}

// ---------- encrypt / decrypt ----------

/**
 * Encrypt a plaintext with the context-specific key.
 * Returns packed "<ivHex>.<tagHex>.<encHex>" (12-byte IV, 16-byte GCM auth tag).
 * Throws if HRM_MFA_KEY is unset (fail-closed for new writes — matches the
 * original totp.ts behavior at encryptSecret).
 *
 * Caller is responsible for prefixing/versioning:
 *   - MFA: prepend "v2:" → "v2:<ivHex>.<tagHex>.<encHex>"
 *   - Camera: store as-is in CameraCredential.encryptedPayload; bump
 *     encryptionKeyVersion in the same row.
 */
export function encryptField(plain: string, context: string): string {
  // R6-002 — use contextEnvKey(context) instead of the root-key-only guard so
  // that a per-context key (e.g. HRM_COMMS_KEY) enables encryption even when
  // HRM_MFA_KEY is not set.  deriveKey() throws its own error if neither resolves.
  const keyValue = contextEnvKey(context)
  if (!keyValue) {
    throw Object.assign(
      new Error(`Server encryption key is not configured for context "${context}" (set HRM_MFA_KEY or the per-context override)`),
      { code: 500 },
    )
  }
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv("aes-256-gcm", deriveKey(context), iv)
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()])
  const tag = cipher.getAuthTag()
  return `${iv.toString("hex")}.${tag.toString("hex")}.${enc.toString("hex")}`
}

/**
 * Decrypt a packed "<ivHex>.<tagHex>.<encHex>" string with the context-specific key.
 * Throws on corrupt input, tampering (GCM auth tag mismatch), or missing
 * HRM_MFA_KEY. The caller is responsible for stripping any version prefix
 * (MFA's "v2:") before calling.
 */
export function decryptField(packed: string, context: string): string {
  const [ivH, tagH, encH] = String(packed || "").split(".")
  if (!ivH || !tagH || !encH) throw new Error(`Corrupt encrypted field (context=${context})`)
  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", deriveKey(context), Buffer.from(ivH, "hex"))
    decipher.setAuthTag(Buffer.from(tagH, "hex"))
    return Buffer.concat([decipher.update(Buffer.from(encH, "hex")), decipher.final()]).toString("utf8")
  } catch (hkdfError) {
    // MED-15 back-compat hole (found by crypto-field-mfa-backcompat.test.ts):
    // ciphertexts written between the v2-prefix refactor and the HKDF refactor
    // were keyed with the single-SHA-256 construction
    // sha256("<BASE_SALT>::<context>::<envKey>"). HKDF cannot decrypt those
    // (GCM auth failure), and the v2:-prefixed MFA path routes HERE — not to
    // decryptFieldMfaLegacy (that only covers the v1 FIXED-KEY format) — so
    // every env-keyed enrolment from that window locked out. Retry with the
    // legacy env-keyed derivation before giving up; NEW writes stay HKDF and
    // the needsReencrypt lazy migration re-keys on the next successful verify.
    const envKey = process.env.HRM_MFA_KEY || ""
    if (!envKey) throw hkdfError
    const legacyKey = crypto.createHash("sha256").update(`${BASE_SALT}::${context}::${envKey}`).digest()
    try {
      const decipher = crypto.createDecipheriv("aes-256-gcm", legacyKey, Buffer.from(ivH, "hex"))
      decipher.setAuthTag(Buffer.from(tagH, "hex"))
      return Buffer.concat([decipher.update(Buffer.from(encH, "hex")), decipher.final()]).toString("utf8")
    } catch {
      throw hkdfError // neither derivation authenticates → surface the HKDF error
    }
  }
}

// ---------- MFA legacy fallback (pre-refactor compat only) ----------

/**
 * Decrypt an MFA secret written under the legacy hardcoded key (pre-H-8
 * remediation, no env key). Used by totp.ts's decryptSecret() shim in two
 * cases:
 *   (a) HRM_MFA_KEY is unset and the secret is unprefixed (the only readable
 *       kind when no env key is configured — fail-closed for v2 secrets).
 *   (b) HRM_MFA_KEY is set and the secret is unprefixed (legacy format) —
 *       try the legacy key first as a migration aid, then fall through to
 *       the env-keyed key (decryptField) if that fails.
 *
 * MFA-only — camera credentials have no legacy fallback (they were never
 * written under a hardcoded key). decryptField() throws cleanly if
 * HRM_MFA_KEY is unset.
 */
export function decryptFieldMfaLegacy(packed: string): string {
  // R6-013: Warn loudly in production — legacy secrets use a public constant key.
  // Run scripts/re-encrypt-fields.ts (or rotate-mfa-legacy-secrets.ts) to migrate.
  if (process.env.NODE_ENV === "production") {
    console.warn("[SECURITY] decryptFieldMfaLegacy: a legacy MFA secret (pre-HRM_MFA_KEY) is still present. Run `bun run scripts/re-encrypt-fields.ts --apply` to re-encrypt under the current key.")
  }
  const [ivH, tagH, encH] = String(packed || "").split(".")
  if (!ivH || !tagH || !encH) throw new Error("Corrupt MFA legacy secret")
  const decipher = crypto.createDecipheriv("aes-256-gcm", crypto.createHash("sha256").update(MFA_LEGACY_SALT).digest(), Buffer.from(ivH, "hex"))
  decipher.setAuthTag(Buffer.from(tagH, "hex"))
  return Buffer.concat([decipher.update(Buffer.from(encH, "hex")), decipher.final()]).toString("utf8")
}

/**
 * M-3 — the WRITE side of the legacy format (inverse of
 * decryptFieldMfaLegacy). NOT used by any production write path since H-8
 * (encryptSecret always writes "v2:" under HRM_MFA_KEY); it exists so the
 * one-shot rotation tooling (scripts/rotate-mfa-legacy-secrets.ts) and its
 * staging scenario can construct realistic legacy rows for validation.
 * The legacy key is derived from a public constant — that is exactly finding
 * M-3 — which is why rows in this format must be re-encrypted and the script
 * shipped: after it runs, no production secret is recoverable from a DB dump
 * alone.
 */
export function encryptFieldMfaLegacy(plain: string): string {
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv("aes-256-gcm", crypto.createHash("sha256").update(MFA_LEGACY_SALT).digest(), iv)
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()])
  return `${iv.toString("hex")}.${cipher.getAuthTag().toString("hex")}.${enc.toString("hex")}`
}

/**
 * True when an MFA secret is in the legacy format (no "v2:" prefix) AND the
 * deployment has HRM_MFA_KEY set — i.e. the secret was written under the old
 * hardcoded key and should be transparently re-encrypted on next successful
 * verify. Mirrors the original totp.ts needsReencrypt() behavior.
 *
 * Returns false for:
 *   - "v2:"-prefixed secrets (already migrated)
 *   - any secret when HRM_MFA_KEY is unset (can't re-encrypt without the new key)
 *   - legacy secrets that don't decrypt under the legacy key either (corrupt
 *     or unrecognized format — re-encrypting would lose data)
 */
export function mfaSecretNeedsReencrypt(packed: string): boolean {
  if (String(packed || "").startsWith("v2:")) return false
  if (!fieldKeyConfigured()) return false
  try {
    decryptFieldMfaLegacy(packed)
    return true
  } catch {
    return false
  }
}

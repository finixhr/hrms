// ============ Camera credential lifecycle wrapper ============
// Sits between the route layer (routes/cameras.ts) and the repository
// (cameras/repository.ts). Responsibilities:
//   1. Encrypt plaintext brand creds via crypto-field.ts BEFORE the
//      repository write.
//   2. Decrypt encryptedPayload via crypto-field.ts AFTER the repository
//      read — returns DecryptedCreds (parsed JSON) to the caller (provider
//      or route layer).
//   3. Derive the crypto context from the DB column (item 3 of the Phase 4
//      kickoff — see JSDoc on CAMERAS_CONTEXT_BASE).
//
// Security posture:
//   - Plaintext creds live only in this function's stack frame (and the
//     provider's, when the route layer passes them through). Never logged,
//     never persisted, never returned to the UI.
//   - The crypto scheme is AES-256-GCM with a context-parameterized salt
//     (see crypto-field.ts). MFA and cameras share the deployment env key
//     (HRM_MFA_KEY) but derive DIFFERENT data-encryption keys.
//   - MFA's "v2:" string prefix is NOT unified with the camera's
//     encryptionKeyVersion column (TODO(crypto-unification) — future cleanup).
//
// See src/hrm/CONVENTIONS.md and src/hrm/API.md for broader app conventions.
import { encryptField, decryptField, fieldKeyConfigured } from "../crypto-field"
import {
  upsertCredential as repoUpsertCredential,
  getCredential as repoGetCredential,
  deleteCredential as repoDeleteCredential,
} from "./repository"
import type { Ctx } from "../types"
import type { DecryptedCreds, CredentialRow } from "./providers/camera-provider"

// ---------- context derivation (item 3) ----------

/**
 * BASE string for camera credential crypto contexts. The full context is
 * derived as `${BASE}::v${encryptionKeyVersion}` — e.g. "cameras::v1",
 * "cameras::v2", "cameras::v3" after rotations.
 *
 * *** ITEM 3 OF PHASE 4 KICKOFF — DO NOT HARDCODE THE FULL CONTEXT ***
 *
 * Rationale: there are TWO version markers that could drift:
 *   1. The DB column `CameraCredential.encryptionKeyVersion` (Int, default 1)
 *   2. A code-side context string like "cameras::v1"
 *
 * If both exist as independent constants, they WILL drift (someone bumps the
 * column on rotation but forgets to update the code string, or vice versa).
 * The DB column is the source of truth — the code derives the context from
 * it. This means:
 *   - When ENCRYPTING a new write: use `cameras::v${newVersion}` where
 *     `newVersion = existing.encryptionKeyVersion + 1` (or 1 for first write).
 *   - When DECRYPTING a stored row: use `cameras::v${row.encryptionKeyVersion}`
 *     — reads the version from the DB, not from a code constant.
 *
 * Rotation flow: bump the column → next encrypt uses new context → next
 * decrypt uses new context → old ciphertext becomes unreadable (which is
 * the point of rotation: a leaked old key can't read new ciphertexts).
 *
 * For env-key rotation (HRM_MFA_KEY changes): re-encrypt every row under
 * the new env key with the SAME context (version doesn't bump — only the
 * env key changed, not the versioning scheme). A migration script for this
 * is a future concern (not in v1 scope).
 */
const CAMERAS_CONTEXT_BASE = "cameras"

/** Compute the crypto context for a given encryption key version.
 *  Used both at encrypt time (new writes / rotations) and at decrypt time
 *  (reading existing rows). */
export function camerasContext(encryptionKeyVersion: number): string {
  return `${CAMERAS_CONTEXT_BASE}::v${encryptionKeyVersion}`
}

// ---------- upsert (create + rotate share the same path) ----------

/**
 * Encrypt + upsert a tenant credential for a brand.
 * - First write: encryptionKeyVersion = 1, rotatedAt stays null.
 * - Rotation: encryptionKeyVersion bumps to existing+1, rotatedAt set to now.
 *
 * The caller passes the PLAINTEXT payload (a brand-specific JSON shape like
 * {appKey, appSecret}). This function encrypts it via crypto-field.ts with
 * the derived context, then hands the encrypted string + version to the
 * repository.
 *
 * Throws if HRM_MFA_KEY is unset (fail-closed for new writes — matches
 * the MFA behavior). Throws if `brand` is not a tenant-credential brand
 * (Hikvision/Dahua have no tenant creds — see isTenantCredentialBrand).
 */
export async function upsertCredential(
  ctx: Ctx,
  brand: string,
  plaintextPayload: Record<string, string>,
): Promise<CredentialRow> {
  if (!fieldKeyConfigured()) {
    const { Deny } = await import("../rbac")
    throw new Deny("Server encryption key (HRM_MFA_KEY) is not configured — cannot store camera credentials. Contact your administrator.", 500)
  }

  // Compute the new version: existing + 1 for rotation, or 1 for first write.
  const existing = await repoGetCredential(ctx, brand)
  const newVersion = existing ? existing.encryptionKeyVersion + 1 : 1
  const context = camerasContext(newVersion)  // ← derived from DB-version-aware logic

  // Encrypt the plaintext JSON with the derived context.
  const plaintext = JSON.stringify(plaintextPayload)
  const encryptedPayload = encryptField(plaintext, context)

  // Hand off to the repository, which writes encryptedPayload + version.
  return repoUpsertCredential(ctx, brand, encryptedPayload, newVersion)
}

// ---------- read (decrypt) ----------

/**
 * Fetch + decrypt a tenant credential for a brand. Returns null if no row
 * exists yet (the tenant hasn't onboarded that brand).
 *
 * The decrypted plaintext is parsed as JSON and returned as DecryptedCreds
 * (a Record<string, string>). The caller (route layer → provider) is
 * responsible for casting to the brand-specific shape ({appKey, appSecret}
 * for EZVIZ, {appId, appSecret} for Imou).
 *
 * Throws if HRM_MFA_KEY is unset (cannot decrypt without the env key) OR
 * if the ciphertext is corrupt/tampered (GCM auth tag mismatch).
 *
 * SECURITY: the returned DecryptedCreds contains PLAINTEXT secrets. The
 * caller MUST NOT retain references to it; the route layer should pass it
 * directly to the provider and let it go out of scope. Never log, never
 * return to the UI, never write to AuditLog (encryptedPayload is in the
 * AUDIT_PII_EXCLUDE set in audit.ts as belt-and-braces defense).
 */
export async function getCredential(
  ctx: Ctx,
  brand: string,
): Promise<{ row: CredentialRow; creds: DecryptedCreds } | null> {
  const row = await repoGetCredential(ctx, brand)
  if (!row) return null

  if (!fieldKeyConfigured()) {
    const { Deny } = await import("../rbac")
    throw new Deny("Server encryption key (HRM_MFA_KEY) is not configured — cannot read camera credentials. Contact your administrator.", 500)
  }

  // Derive the context from the DB column (item 3 — version is the source of truth).
  const context = camerasContext(row.encryptionKeyVersion)
  const plaintext = decryptField(row.encryptedPayload, context)

  // Parse the brand-specific JSON shape. Defensive: if it's not valid JSON
  // or not an object, return null creds (the row exists but is corrupt —
  // caller decides whether to treat as missing or throw).
  let parsed: DecryptedCreds = null
  try {
    const obj = JSON.parse(plaintext)
    if (typeof obj === "object" && obj !== null && !Array.isArray(obj)) {
      parsed = obj as Record<string, string>
    }
  } catch {
    parsed = null
  }

  return { row, creds: parsed }
}

// ---------- delete ----------

/**
 * Delete a tenant credential row (hard delete — credentials are NOT
 * soft-deleted because there is no history to preserve once the brand is
 * un-onboarded). Returns the deleted row for audit, or null if nothing
 * existed (caller decides whether that's an error).
 *
 * Does NOT decrypt — we're deleting, not reading. Just delegates to the
 * repository. Gated by `camera.manage` in the route layer.
 */
export async function deleteCredential(ctx: Ctx, brand: string): Promise<CredentialRow | null> {
  return repoDeleteCredential(ctx, brand)
}

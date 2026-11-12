// ============ Camera Provider interface + shared types ============
// See src/hrm/CONVENTIONS.md and src/hrm/API.md for broader app conventions.
//
// Provider contract (Camera Manager §6 + §8 + §12):
//   - Each brand implements CameraProvider and registers in providers/registry.ts
//     (Phase 4+ — only Hikvision in this phase; Dahua/EZVIZ/Imou follow).
//   - Providers receive the CameraRecord (full DB row, including serialNumber +
//     verificationCode for per-camera brands) and the tenant's decrypted
//     credentials (null for per-camera brands like Hikvision/Dahua).
//   - Providers NEVER touch encryptedPayload or the crypto-field utility —
//     decryption happens centrally in cameras/credentials.ts BEFORE the
//     provider is called. The decrypted secret's lifetime is as short as
//     possible and out of brand-specific files.
//
// Launch envelope (Camera Manager §12):
//   - Every provider returns BOTH a launchTarget (variant-specific) AND a
//     fallbackWebUrl. When the deep-link scheme for a brand is not citably
//     documented, the provider returns the fallbackWebUrl as the primary
//     launchTarget.url (kind=DEEP_LINK) and emits a // TODO comment.
//
// Status model (Camera Manager §5):
//   - getDeviceStatus returns EITHER a freshly-polled status (for brands with
//     an Open Platform API) OR the camera's stored last-known status (for
//     brands without one). Each provider's header comment must state which
//     applies.

import type { Camera, CameraCredential } from "@prisma/client"

// ---------- shared types ----------

/** The full Camera row as the provider sees it. Mirrors Prisma's Camera type.
 *  Providers read serialNumber + verificationCode for per-camera brands. */
export type CameraRecord = Camera

/** Decrypted tenant credentials for tenant-credential brands (EZVIZ/Imou).
 *  Shape is brand-specific JSON ({appKey, appSecret} or {appId, appSecret}).
 *  Null for per-camera brands (Hikvision/Dahua) — they have no tenant creds.
 *
 *  SECURITY: this object contains plaintext secrets. The credentials wrapper
 *  (cameras/credentials.ts) decrypts immediately before calling the provider
 *  and the object is garbage-collected when the provider call returns.
 *  Providers MUST NOT retain references to this object. */
export type DecryptedCreds = Record<string, string> | null

/** Raw credential row (for the credentials wrapper to return). */
export type CredentialRow = CameraCredential

// ---------- LaunchTarget + LaunchResult ----------

/** Brand-specific launch target. The UI (Phase 6) renders this:
 *   - DEEP_LINK → render as a clickable link (or auto-redirect)
 *   - QR_CODE   → render as a QR code via the qrcode library (already a dep)
 *   - CLOUD_STREAM_TOKEN → render as an embedded player URL with expiry
 *
 * Phase 5c Flag A: CLOUD_STREAM_TOKEN has a SEPARATE `accessToken` field
 * (NOT embedded in the URL as a ?token= query param). Embedded tokens leak
 * via referrer, browser history, and server logs — a security regression.
 * The brand's H5 player SDK accepts the token as a separate parameter;
 * the UI passes it to the player init, not as part of the URL.
 *
 * No fallbackWebUrl here — that's a sibling field in LaunchResult, because
 * the same fallback applies regardless of which LaunchTarget variant the
 * provider chose. */
export type LaunchTarget =
  | { kind: "DEEP_LINK"; url: string }
  | { kind: "QR_CODE"; payload: string }
  | {
      kind: "CLOUD_STREAM_TOKEN"
      /** The brand's documented stream URL (e.g. ezopen://open.ys7.com/{serial}/{channel}.live).
       *  Does NOT contain the access token — tokens are passed separately
       *  via the accessToken field to avoid referrer/history/log leakage. */
      url: string
      /** Short-lived OAuth access token authorizing the stream playback.
       *  Passed to the brand's H5 player SDK as a separate init parameter,
       *  NOT embedded in the url. */
      accessToken: string
      /** When the accessToken expires (the brand cloud's response typically
       *  includes this as an ISO timestamp or a TTL in seconds). The UI
       *  should refuse to render the player past this time. */
      expiresAt: Date
    }

/** Full launch response (Camera Manager §12). Every provider MUST return
 *  fallbackWebUrl. When a deep-link scheme is not citably documented, the
 *  provider returns the fallbackWebUrl as the primary launchTarget.url
 *  (kind=DEEP_LINK) and emits a // TODO comment. */
export interface LaunchResult {
  launchTarget: LaunchTarget
  fallbackWebUrl: string
}

// ---------- DeviceStatus ----------

/** Brand-API device status. For brands without an Open Platform API
 *  (Hikvision/Dahua), the provider returns the camera's stored status
 *  (last-known only — Camera Manager §5). For brands WITH an API (EZVIZ/Imou),
 *  the provider polls and returns fresh status. */
export interface DeviceStatus {
  status: "ONLINE" | "OFFLINE" | "UNKNOWN"
  lastSeenAt?: Date | null
  /** Provider-specific failure reason if status=OFFLINE (e.g. "EZVIZ token
   *  expired"). Never include credentials. The route layer writes this to
   *  Camera.lastError for status-check failures. */
  error?: string | null
}

// ---------- CameraProvider interface ----------

/** Brand-specific camera provider. Implement once per brand; register in
 *  providers/registry.ts (Phase 4+). New brands should be addable by
 *  implementing CameraProvider and adding a registry entry — no other file
 *  needs to change (Camera Manager §15 acceptance criterion). */
export interface CameraProvider {
  /** Brand key — matches Camera.brand values (HIKVISION | DAHUA | EZVIZ | IMOU). */
  brand: "HIKVISION" | "DAHUA" | "EZVIZ" | "IMOU"

  /** Validate the tenant's decrypted credentials (EZVIZ/Imou only). Returns
   *  true if the creds are usable for brand-API calls. For per-camera brands
   *  (Hikvision/Dahua), this is not called — creds is always null and the
   *  route layer refuses camera.credential.upsert for those brands. */
  validateCredentials(creds: DecryptedCreds): Promise<boolean>

  /** Get the device status. For brands WITH an Open Platform API (EZVIZ/Imou),
   *  polls the brand cloud. For brands WITHOUT one (Hikvision/Dahua), returns
   *  the camera's stored last-known status (no network call). */
  getDeviceStatus(camera: CameraRecord, creds: DecryptedCreds): Promise<DeviceStatus>

  /** Get the launch target + fallback web URL. For per-camera brands, the
   *  launch typically shows the verificationCode (UI-side) and provides a
   *  deep link to the brand's mobile app. For tenant-credential brands, the
   *  launch may use a freshly-obtained cloud-stream token. */
  getLaunchTarget(camera: CameraRecord, creds: DecryptedCreds): Promise<LaunchResult>
}

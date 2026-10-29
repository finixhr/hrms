// ============ Provider registry — brand → CameraProvider lookup ============
// Extracted from routes/cameras.ts in Phase 5 per the master spec §15
// ("a fifth brand needs no changes outside a new provider file + registry
// entry"). Route handlers import `getProvider(brand)` from here instead of
// holding an inline PROVIDERS map — keeps the route file brand-agnostic.
//
// To add a new brand:
//   1. Implement CameraProvider in src/hrm-server/cameras/providers/<brand>.ts
//   2. Import it here and add a line to the REGISTRY map.
// No other file needs to change.
//
// See src/hrm/CONVENTIONS.md and src/hrm/API.md for broader app conventions.
import { Deny } from "@/hrm-server/rbac"
import type { CameraProvider } from "./camera-provider"
import { hikvisionProvider } from "./hikvision"
import { dahuaProvider } from "./dahua"
import { ezvizProvider } from "./ezviz"
import { imouProvider } from "./imou"

/**
 * Brand → provider map. Order doesn't matter — lookup is by brand string
 * (HIKVISION | DAHUA | EZVIZ | IMOU), matching Camera.brand values.
 *
 * Future brands: add a line here + implement CameraProvider in a new file
 * under providers/. No other file in the codebase needs to change.
 */
const REGISTRY: Partial<Record<string, CameraProvider>> = {
  HIKVISION: hikvisionProvider,
  DAHUA: dahuaProvider,
  EZVIZ: ezvizProvider,  // Phase 5b — OAuth client-credentials, ezopen:// launch
  IMOU: imouProvider,    // Phase 5c — OAuth, cloud-stream URL primary, app scheme secondary
}

/**
 * Get the provider for a brand. Throws `Deny(400)` if the brand is not
 * registered (caller passed an unsupported brand string). The error message
 * lists all registered brands for actionable feedback.
 *
 * Throwing `Deny` (not returning null) is intentional — the route handlers
 * that call this have already validated the brand at the DTO layer
 * (validateCameraCreate + the EZVIZ/Imou rejection rule). An unsupported
 * brand reaching this point is either a code bug (typo in REGISTRY) or a
 * caller bypassing DTO validation; in both cases, throwing is correct.
 */
export function getProvider(brand: string): CameraProvider {
  const p = REGISTRY[brand]
  if (!p) {
    const supported = Object.keys(REGISTRY).join(", ")
    throw new Deny(
      `Unsupported camera brand: ${brand}. Supported: ${supported}.`,
      400,
    )
  }
  return p
}

/** List all registered brand keys. Used by the UI (Phase 6) to populate the
 *  brand dropdown and by tests to enumerate providers. */
export function listRegisteredBrands(): string[] {
  return Object.keys(REGISTRY)
}

/** True if a provider is registered for the given brand. Used by
 *  validateCameraCreate (Phase 3 item 5) to reject unknown brands at the
 *  DTO layer before reaching the route handler. */
export function isRegisteredBrand(brand: string): boolean {
  return brand in REGISTRY
}

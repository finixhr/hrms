# Camera Providers — How to Add a 5th Brand

The Camera Manager supports 4 brands out of the box (Hikvision, Dahua, EZVIZ, Imou). Adding a 5th brand requires exactly 2 file changes — no other file in the codebase needs to be modified.

## Steps

### 1. Implement the provider

Create `src/hrm-server/cameras/providers/<brand>.ts` (lowercase, matches the brand key):

```typescript
import type {
  CameraProvider, CameraRecord, DecryptedCreds, DeviceStatus, LaunchResult,
} from "./camera-provider"

const BRAND_WEB_PORTAL = "https://portal.example.com"  // verify against brand docs

export const brandProvider: CameraProvider = {
  brand: "<BRAND_KEY>",  // UPPERCASE, matches Camera.brand values

  async validateCredentials(creds: DecryptedCreds): Promise<boolean> {
    // For per-camera brands (no tenant creds): return creds === null
    // For tenant-credential brands: POST to OAuth token endpoint, return bool
    // Cache the token via token-cache.ts on success
  },

  async getDeviceStatus(camera: CameraRecord, creds: DecryptedCreds): Promise<DeviceStatus> {
    // For brands without a cloud API: return { status: camera.status, lastSeenAt: camera.lastSeenAt, error: null }
    // For brands with an API: call the device status endpoint, handle 401 (refresh-once-retry-once)
    // Flag 2: credential/token failures → status: "UNKNOWN" + error, NEVER "OFFLINE"
  },

  async getLaunchTarget(camera: CameraRecord, creds: DecryptedCreds): Promise<LaunchResult> {
    // Return { launchTarget, fallbackWebUrl }
    // For DEEP_LINK brands: { kind: "DEEP_LINK", url: "..." }
    // For CLOUD_STREAM_TOKEN: { kind: "CLOUD_STREAM_TOKEN", url: "...", accessToken: "...", expiresAt: ... }
    //   — accessToken is a SEPARATE field, NEVER embedded in the URL (Flag A)
    // TODO(verify): confirm deep-link scheme against brand developer docs before production
  },
}
```

### 2. Register the provider

Add one line to `src/hrm-server/cameras/providers/registry.ts`:

```typescript
import { brandProvider } from "./<brand>"

const REGISTRY: Partial<Record<string, CameraProvider>> = {
  HIKVISION: hikvisionProvider,
  DAHUA: dahuaProvider,
  EZVIZ: ezvizProvider,
  IMOU: imouProvider,
  <BRAND_KEY>: brandProvider,  // ← add this line
}
```

### 3. Update the brand classification (if needed)

If the new brand uses per-tenant cloud credentials (like EZVIZ/Imou), add it to `TENANT_CREDENTIAL_BRANDS` in `src/hrm-server/cameras/repository.ts`:

```typescript
export const TENANT_CREDENTIAL_BRANDS = new Set(["EZVIZ", "IMOU", "<BRAND_KEY>"])
```

If it uses per-camera verification codes (like Hikvision/Dahua), add it to `PER_CAMERA_BRANDS` instead.

### 4. Update the credential route (if tenant-credential brand)

In `src/hrm-server/routes/cameras.ts`, add the brand to the credential shape validation:

```typescript
if (input.brand === "<BRAND_KEY>") {
  if (!input.appKey || !input.appSecret) throw new Deny("<BRAND> credentials require appKey and appSecret", 400)
}
```

And update `camera.credential.state` route to include the new brand:

```typescript
const brands = ["EZVIZ", "IMOU", "<BRAND_KEY>"] as const
```

### 5. Update the UI (optional)

In `src/hrm/views/cameras.tsx`, add the brand to `brandOptions` and `BRAND_COLORS`:

```typescript
const brandOptions = [
  { value: "HIKVISION", label: "Hikvision" },
  { value: "DAHUA", label: "Dahua" },
  { value: "EZVIZ", label: "EZVIZ" },
  { value: "IMOU", label: "Imou" },
  { value: "<BRAND_KEY>", label: "<Brand Name>" },  // ← add
]

const BRAND_COLORS = {
  HIKVISION: "bg-blue-100 ...",
  ...
  <BRAND_KEY>: "bg-purple-100 text-purple-700 border-purple-200",  // ← add
}
```

## That's it

No other files need to change. The registry is the single source of truth — `isRegisteredBrand`, `getProvider`, `listRegisteredBrands` all pick up the new brand automatically.

## Reference implementations

- **Hikvision** (`hikvision.ts`) — per-camera, no tenant creds, no cloud API, DEEP_LINK launch. Simplest pattern.
- **Dahua** (`dahua.ts`) — mirrors Hikvision.
- **EZVIZ** (`ezviz.ts`) — OAuth client-credentials, token cache, refresh-on-401, exponential backoff, `ezopen://` documented URL, CLOUD_STREAM_TOKEN launch.
- **Imou** (`imou.ts`) — mirrors EZVIZ with cloud-stream URL primary + web portal fallback.

## Key rules

1. **Never embed access tokens in URLs** — use the `accessToken` field on `LaunchTarget`.
2. **Credential/token failures → `UNKNOWN`**, never `OFFLINE`.
3. **Unconfirmed deep-link schemes → web URL wins** (audit L-35: the open
   `TODO(verify)` markers were resolved 2026-10-02 into per-provider
   verification notes + the pre-production checklist below).
4. **Rate-limit OAuth endpoints** — 3 attempts max, 1s/2s backoff.
5. **Refresh-on-401: retry once** — if the retry also 401s, return UNKNOWN + lastError.

## Pre-production deep-link checklist (audit L-35)

Verification status as of 2026-10-02 (web-searched against each brand's
official developer portal):

| Brand | Scheme | Status | Production posture |
|-------|--------|--------|--------------------|
| Hikvision | (Hik-Connect web) | official portal URL | web URL primary — verified |
| EZVIZ | `ezopen://open.ys7.com/…` | domain CONFIRMED (open.ys7.com is EZVIZ's official open platform); scheme format community-documented only | deep link primary, web portal fallback — **verify one live launch before go-live** |
| Dahua | `dmss://` / `dahua://` | NO official scheme documentation found (app manuals only) | web URL primary (conservative default) |
| Imou | `imoulife://` | NO official scheme documentation found | never constructed — API `liveUrl` or web portal only |

Before relying on any deep link in production, an operator MUST:

1. Launch ONE live camera per brand from the Cameras tab (with real brand
   credentials) and confirm the app/portal actually opens the stream.
2. If the deep link fails, click the fallback web-portal link and confirm it
   works; then either fix the URL constant in the provider file (EZVIZ) or
   rely on the web posture (Dahua/Imou already do).
3. Record the verified scheme in this table (brand, date, result).

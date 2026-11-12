// ============ EZVIZProvider — OAuth client-credentials, ezopen:// launch ============
//
// EZVIZ (Hikvision's consumer CCTV sub-brand, separate cloud) uses an Open
// Platform API for tenant-level integration. Unlike Hikvision/Dahua (per-camera
// verificationCode, no cloud API), EZVIZ requires:
//   - Tenant-level OAuth client-credentials flow (appKey/appSecret → access token)
//   - Per-camera deviceSerial identifies the camera within the tenant's account
//   - A separate stream-token endpoint returns a short-lived URL token for
//     live viewing (typically ~30 min expiry)
//
// Auth model:
//   - validateCredentials(creds): POST /oauth/token with appKey/appSecret → bool.
//     On success, cache the token (TTL from response, minus 60s safety margin
//     per token-cache.ts). On failure, return false.
//
// Refresh-on-401 pattern (item 2b of Phase 4 answer):
//   - getDeviceStatus calls the device endpoint with the cached token.
//   - On 401: evict the cached token, fetch a fresh one, retry the original
//     call ONCE. If the retry 401s again OR the refresh itself fails, return
//     DeviceStatus { status: "UNKNOWN", lastError: "..." } per Flag 2 (Phase 5b):
//     credential/token failures → UNKNOWN (we can't see it), NOT OFFLINE
//     (camera is unreachable). The UI renders these distinctly (yellow warning
//     for UNKNOWN, red for OFFLINE).
//
// Rate-limit handling (item 2c of Phase 4 answer):
//   - EZVIZ rate-limits the /oauth/token endpoint. Exponential backoff:
//     1s, 2s, 4s between retries, max 3 attempts total.
//   - A retry storm on /oauth/token can get the tenant BANNED from the EZVIZ
//     Open Platform — the backoff + cap is mandatory.
//
// Launch model:
//   - getLaunchTarget POSTs to the stream-token endpoint, returns
//     LaunchResult with kind=CLOUD_STREAM_TOKEN and an ezopen:// URL.
//   - ezopen:// is EZVIZ's documented scheme for the web/video player —
//     NOT a TODO. Format: ezopen://{appKey}@{deviceSerial}/{channel}.hd
//     (per EZVIZ Open Platform community references; verify the exact
//     query-string shape against EZVIZ dev docs before production).
//   - fallbackWebUrl: https://i.ezvizlife.com (the user portal, not the
//     marketing site). Source: user-suggested in Phase 5b kickoff.

import type {
  CameraProvider, CameraRecord, DecryptedCreds, DeviceStatus, LaunchResult,
} from "./camera-provider"
import {
  getCachedToken, setCachedToken, clearCachedToken,
} from "./token-cache"

// ---------- constants (URLs — see citation comments) ----------

// EZVIZ Open Platform base URL. Source: widely referenced in EZVIZ developer
// community (open.ezvizlife.com / openapi.ezvizlife.com). I cannot independently
// verify without internet access; if a deployer confirms a different base URL
// (e.g. open.ezviz.com), swap the constant.
const EZVIZ_OPEN_BASE = "https://openapi.ezvizlife.com"

// OAuth token endpoint. Standard OAuth 2.0 client-credentials grant.
const EZVIZ_TOKEN_URL = `${EZVIZ_OPEN_BASE}/api/v1/oauth/token`

// Device status endpoint. Path pattern: GET /api/v1/devices/{serial}/status
function deviceStatusUrl(deviceSerial: string): string {
  return `${EZVIZ_OPEN_BASE}/api/v1/devices/${encodeURIComponent(deviceSerial)}/status`
}

// Stream-token endpoint. POST returns a short-lived token for the ezopen:// URL.
const EZVIZ_STREAM_URL = (deviceSerial: string, channel: number) =>
  `${EZVIZ_OPEN_BASE}/api/v1/devices/${encodeURIComponent(deviceSerial)}/channels/${channel}/stream`

// EZVIZ user portal — fallback web URL. Source: user-suggested in Phase 5b
// kickoff. `i.ezvizlife.com` is the post-login portal; `www.ezvizlife.com`
// is the marketing site (do NOT use as fallback). I cannot independently
// verify without internet access; conservative choice: use the user's suggestion.
const EZVIZ_WEB_PORTAL = "https://i.ezvizlife.com"

// Exponential backoff for OAuth token endpoint rate limits.
// 3 attempts total, delays 1s + 2s (the "4s" in the spec is the next-backoff
// if we were to do a 4th attempt, but we cap at 3).
const MAX_TOKEN_ATTEMPTS = 3
const BACKOFF_DELAYS_MS = [1_000, 2_000]  // before attempt 2 and attempt 3

// ---------- types (EZVIZ API response shapes) ----------

type _EzvizTokenResponse = {
  accessToken?: string
  expiresIn?: number  // seconds
  // ...other fields per EZVIZ docs
}

type EzvizDeviceStatusResponse = {
  status?: "ON" | "OFF" | "UNKNOWN"  // EZVIZ uses ON/OFF; we map to ONLINE/OFFLINE/UNKNOWN
  lastSeenAt?: string  // ISO datetime
  // ...other fields per EZVIZ docs
}

type EzvizStreamTokenResponse = {
  streamToken?: string
  expiresAt?: string  // ISO datetime
  // ...other fields per EZVIZ docs
}

// ---------- helper: fetch with timeout + JSON parse ----------

async function postJson(url: string, body: any, headers: Record<string, string> = {}): Promise<{ status: number; json: any }> {
  const response = await globalThis.fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
    // M-39 — a hung brand API must not stall camera.launch/status until the
    // platform timeout: 10s hard cap (the helper said "with timeout" but
    // never passed one).
    signal: AbortSignal.timeout(10_000),
  })
  let json: any = null
  try { json = await response.json() } catch { /* non-JSON response */ }
  return { status: response.status, json }
}

async function getJson(url: string, headers: Record<string, string> = {}): Promise<{ status: number; json: any }> {
  // M-39 — same 10s hard cap on GETs
  const response = await globalThis.fetch(url, { method: "GET", headers, signal: AbortSignal.timeout(10_000) })
  let json: any = null
  try { json = await response.json() } catch { /* non-JSON response */ }
  return { status: response.status, json }
}

// ---------- helper: fetch a fresh OAuth token (with backoff) ----------

/**
 * Fetch a fresh OAuth token from EZVIZ's /oauth/token endpoint. Applies
 * exponential backoff on 429 (rate limit). Max 3 attempts, 1s/2s delays.
 * Caches the token on success. Returns null on exhaustion or auth failure.
 */
async function fetchFreshToken(vendorId: string, creds: { appKey: string; appSecret: string }): Promise<string | null> {
  for (let attempt = 1; attempt <= MAX_TOKEN_ATTEMPTS; attempt++) {
    const { status, json } = await postJson(EZVIZ_TOKEN_URL, {
      appKey: creds.appKey,
      appSecret: creds.appSecret,
      grantType: "client_credentials",
    })

    if (status === 200 && json?.accessToken) {
      // Cache for next call's getCachedToken() lookup
      setCachedToken(vendorId, "EZVIZ", json.accessToken, Number(json.expiresIn) || 7200)
      return json.accessToken as string
    }

    if (status === 429 && attempt < MAX_TOKEN_ATTEMPTS) {
      // Rate limited — backoff before the next attempt
      const delay = BACKOFF_DELAYS_MS[attempt - 1] ?? 2_000
      await new Promise((r) => setTimeout(r, delay))
      continue
    }

    // 4xx (other than 429) or 5xx → don't retry, return null (auth failure
    // or service issue). Caller will surface as UNKNOWN + lastError.
    return null
  }
  return null  // exhausted retries
}

/** Get a usable token — cached if valid, fresh if not. */
async function getUsableToken(vendorId: string, creds: { appKey: string; appSecret: string }): Promise<string | null> {
  const cached = getCachedToken(vendorId, "EZVIZ")
  if (cached) return cached
  return fetchFreshToken(vendorId, creds)
}

// ---------- helper: cast DecryptedCreds to EZVIZ shape ----------

function toEzvizCreds(creds: DecryptedCreds): { appKey: string; appSecret: string } | null {
  if (!creds || typeof creds !== "object") return null
  const { appKey, appSecret } = creds as Record<string, string>
  if (!appKey || !appSecret) return null
  return { appKey, appSecret }
}

// ---------- the provider ----------

export const ezvizProvider: CameraProvider = {
  brand: "EZVIZ",

  async validateCredentials(creds: DecryptedCreds): Promise<boolean> {
    const ez = toEzvizCreds(creds)
    if (!ez) return false
    // Fetch a fresh token (don't use cache — the caller is explicitly validating)
    const token = await fetchFreshToken("VALIDATE", ez)
    return token !== null
  },

  async getDeviceStatus(camera: CameraRecord, creds: DecryptedCreds): Promise<DeviceStatus> {
    // Validate creds shape
    const ez = toEzvizCreds(creds)
    if (!ez) {
      // Flag 2 (Phase 5b): credential failure → UNKNOWN, NOT OFFLINE
      return {
        status: "UNKNOWN",
        error: "EZVIZ credentials are malformed — check appKey/appSecret in the tenant credential row",
      }
    }

    if (!camera.serialNumber) {
      return {
        status: "UNKNOWN",
        error: "Camera has no serialNumber — EZVIZ requires serialNumber to identify the camera in the tenant's cloud account",
      }
    }

    // Get a usable token (cached or fresh)
    const token = await getUsableToken(camera.vendorId, ez)
    if (!token) {
      // Flag 2: token fetch failure → UNKNOWN, NOT OFFLINE
      return {
        status: "UNKNOWN",
        error: "EZVIZ token fetch failed — check appKey/appSecret or try again later (rate limit?)",
      }
    }

    // Call the device status endpoint
    const { status: httpStatus, json } = await getJson(
      deviceStatusUrl(camera.serialNumber),
      { Authorization: `Bearer ${token}` },
    )

    if (httpStatus === 401) {
      // Refresh-on-401: evict the cached token, fetch a fresh one, retry ONCE
      clearCachedToken(camera.vendorId, "EZVIZ")
      const freshToken = await fetchFreshToken(camera.vendorId, ez)
      if (!freshToken) {
        return {
          status: "UNKNOWN",
          error: "EZVIZ token refresh failed after 401 — check appKey/appSecret",
        }
      }
      const retry = await getJson(
        deviceStatusUrl(camera.serialNumber),
        { Authorization: `Bearer ${freshToken}` },
      )
      if (retry.status === 401) {
        // Flag 2: 2nd 401 → UNKNOWN, NOT OFFLINE
        return {
          status: "UNKNOWN",
          error: "EZVIZ token refresh succeeded but retry still 401 — check appKey/appSecret permissions",
        }
      }
      if (retry.status !== 200) {
        return {
          status: "UNKNOWN",
          error: `EZVIZ device status check failed (HTTP ${retry.status}) after refresh`,
        }
      }
      return parseDeviceStatus(retry.json as EzvizDeviceStatusResponse)
    }

    if (httpStatus !== 200) {
      return {
        status: "UNKNOWN",
        error: `EZVIZ device status check failed (HTTP ${httpStatus})`,
      }
    }

    return parseDeviceStatus(json as EzvizDeviceStatusResponse)
  },

  async getLaunchTarget(camera: CameraRecord, creds: DecryptedCreds): Promise<LaunchResult> {
    // Validate creds
    const ez = toEzvizCreds(creds)
    if (!ez) {
      // Flag 2: credential failure → throw 400 (the route layer translates to a
      // clear user-facing error; this is a configuration issue, not a runtime
      // status check). The caller (route handler) catches and re-throws.
      const { Deny } = await import("@/hrm-server/rbac")
      throw new Deny("EZVIZ credentials are malformed — appKey/appSecret required for launch", 400)
    }

    if (!camera.serialNumber) {
      const { Deny } = await import("@/hrm-server/rbac")
      throw new Deny("Camera has no serialNumber — EZVIZ requires serialNumber to launch", 400)
    }

    // Get a usable token
    const token = await getUsableToken(camera.vendorId, ez)
    if (!token) {
      const { Deny } = await import("@/hrm-server/rbac")
      throw new Deny("EZVIZ token fetch failed — check appKey/appSecret or try again later (rate limit?)", 400)
    }

    // POST to the stream-token endpoint
    const { status: httpStatus, json } = await postJson(
      EZVIZ_STREAM_URL(camera.serialNumber, camera.channel),
      {},
      { Authorization: `Bearer ${token}` },
    )

    if (httpStatus === 401) {
      // Refresh-on-401: evict, fetch fresh, retry ONCE
      clearCachedToken(camera.vendorId, "EZVIZ")
      const freshToken = await fetchFreshToken(camera.vendorId, ez)
      if (!freshToken) {
        const { Deny } = await import("@/hrm-server/rbac")
        throw new Deny("EZVIZ token refresh failed after 401 — check appKey/appSecret", 400)
      }
      const retry = await postJson(
        EZVIZ_STREAM_URL(camera.serialNumber, camera.channel),
        {},
        { Authorization: `Bearer ${freshToken}` },
      )
      if (retry.status !== 200 || !retry.json?.streamToken) {
        const { Deny } = await import("@/hrm-server/rbac")
        throw new Deny(`EZVIZ stream token fetch failed (HTTP ${retry.status}) after refresh`, 400)
      }
      // Flag A: accessToken is the stream token (separate from the OAuth
      // bearer token). Passed to the H5 player SDK separately, NOT in the URL.
      return buildLaunchResult(camera, ez.appKey, retry.json as EzvizStreamTokenResponse, retry.json.streamToken)
    }

    if (httpStatus !== 200 || !json?.streamToken) {
      const { Deny } = await import("@/hrm-server/rbac")
      throw new Deny(`EZVIZ stream token fetch failed (HTTP ${httpStatus})`, 400)
    }

    return buildLaunchResult(camera, ez.appKey, json as EzvizStreamTokenResponse, json.streamToken)
  },
}

// ---------- helpers ----------

function parseDeviceStatus(resp: EzvizDeviceStatusResponse): DeviceStatus {
  // Map EZVIZ's ON/OFF/UNKNOWN to our ONLINE/OFFLINE/UNKNOWN
  let status: DeviceStatus["status"] = "UNKNOWN"
  if (resp.status === "ON") status = "ONLINE"
  else if (resp.status === "OFF") status = "OFFLINE"
  // else UNKNOWN

  let lastSeenAt: Date | null = null
  if (resp.lastSeenAt) {
    try { lastSeenAt = new Date(resp.lastSeenAt) } catch { /* bad ISO string */ }
  }

  return { status, lastSeenAt, error: null }
}

function buildLaunchResult(camera: CameraRecord, _appKey: string, resp: EzvizStreamTokenResponse, accessToken: string): LaunchResult {
  // Phase 5c Flag A: use the DOCUMENTED ezopen:// URL format — NO embedded
  // access token. The access token is passed SEPARATELY to the H5 player
  // SDK via the accessToken field on LaunchTarget (see camera-provider.ts:64–81).
  //
  // SECURITY: the previous implementation embedded ?token={streamToken} in
  // the URL — a security regression (tokens leak via referrer, browser
  // history, server logs). This is now fixed.
  //
  // L-35 — VERIFICATION ATTEMPT 2026-10-02: open.ys7.com is CONFIRMED as
  // EZVIZ's official Open Platform domain (open.ys7.com/help/en — verified
  // via web search against EZVIZ's own developer portal). The ezopen://
  // URL-scheme FORMAT itself is documented only in EZVIZ developer
  // communities, not in the (JS-rendered) official docs, so it stays
  // UNCONFIRMED — see the pre-production checklist in providers/README.md
  // (one live launch per brand before relying on deep links).
  // The security reasoning (never embed tokens in URLs) holds regardless of
  // the exact URL format. If a deployer finds the format is different, swap
  // the URL constant here.
  const ezopenUrl = `ezopen://open.ys7.com/${encodeURIComponent(camera.serialNumber || "")}/${camera.channel}.live`

  let expiresAt: Date
  if (resp.expiresAt) {
    try { expiresAt = new Date(resp.expiresAt) } catch { expiresAt = new Date(Date.now() + 30 * 60_000) }
  } else {
    // Default 30 min expiry if the response doesn't specify
    expiresAt = new Date(Date.now() + 30 * 60_000)
  }

  return {
    launchTarget: {
      kind: "CLOUD_STREAM_TOKEN",
      url: ezopenUrl,
      accessToken,  // separate field, NOT in the URL
      expiresAt,
    },
    fallbackWebUrl: EZVIZ_WEB_PORTAL,
  }
}

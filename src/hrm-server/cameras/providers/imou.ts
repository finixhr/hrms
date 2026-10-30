// ============ ImouProvider — OAuth client-credentials, cloud-stream URL primary ============
//
// Imou (Dahua's consumer CCTV sub-brand, separate cloud) uses an Open
// Platform API for tenant-level integration. Same OAuth pattern as EZVIZ:
//   - Tenant-level OAuth client-credentials flow (appId/appSecret → access token)
//   - Per-camera deviceSerial identifies the camera within the tenant's account
//   - A separate stream-token endpoint returns a short-lived URL + token
//     for live viewing
//
// Differences from EZVIZ (per Phase 4 answer 3):
//   - Launch: cloud-stream URL is PRIMARY (Imou's documented live-stream URL),
//     imoulife:// app scheme as SECONDARY/fallback (only if verifiable —
//     otherwise fallbackWebUrl is primary). The user said: "Imou: cloud-stream
//     URL is PRIMARY, app scheme as SECONDARY."
//   - Creds shape: { appId, appSecret } (Imou uses appId, NOT appKey like EZVIZ).
//
// Auth model (mirrors EZVIZ):
//   - validateCredentials(creds): POST /oauth/token with appId/appSecret → bool.
//     Caches token on success (TTL from response, minus 60s safety margin).
//   - getDeviceStatus(camera, creds): GET device status endpoint. On 401:
//     refresh once, retry once. On 2nd failure: return UNKNOWN + lastError
//     (Flag 2 — credential/token failures → UNKNOWN, NOT OFFLINE).
//   - getLaunchTarget(camera, creds): POST stream-token endpoint. Returns
//     LaunchResult with kind=CLOUD_STREAM_TOKEN, the documented cloud-stream
//     URL as primary, accessToken as a SEPARATE field (Flag A — no embedded
//     tokens in URLs).
//
// Rate-limit handling (mirrors EZVIZ):
//   - 3 attempts max, 1s/2s backoff on /oauth/token 429.
//
// L-35 (2026-10-02): open.imoulife.com confirmed as Imou's official open
// platform; app deep-link scheme remains undocumented — web/URL policy stays.
// TODO: verify Imou Open Platform API endpoints + cloud-stream URL format
// against Imou developer docs before production. The endpoints below are
// placeholders based on EZVIZ's pattern (Imou's API is structurally similar
// per Dahua's documentation; exact paths vary). I cannot independently
// verify without internet access — a deployer must confirm.

import type {
  CameraProvider, CameraRecord, DecryptedCreds, DeviceStatus, LaunchResult,
} from "./camera-provider"
import {
  getCachedToken, setCachedToken, clearCachedToken,
} from "./token-cache"

// ---------- constants (URLs — see citation comments) ----------

// Imou Open Platform base URL. Source: widely referenced in Imou developer
// community (open.imoulife.com / openapi.imoulife.com). I cannot independently
// verify without internet access; if a deployer confirms a different base URL,
// swap the constant.
const IMOU_OPEN_BASE = "https://openapi.imoulife.com"

// OAuth token endpoint. Standard OAuth 2.0 client-credentials grant.
const IMOU_TOKEN_URL = `${IMOU_OPEN_BASE}/api/v1/oauth/token`

// Device status endpoint. Path pattern: GET /api/v1/devices/{serial}/status
function deviceStatusUrl(deviceSerial: string): string {
  return `${IMOU_OPEN_BASE}/api/v1/devices/${encodeURIComponent(deviceSerial)}/status`
}

// Stream-token endpoint. POST returns a short-lived token for the live URL.
const IMOU_STREAM_URL = (deviceSerial: string, channel: number) =>
  `${IMOU_OPEN_BASE}/api/v1/devices/${encodeURIComponent(deviceSerial)}/channels/${channel}/stream`

// Imou user portal — fallback web URL. Source: user-suggested in Phase 5c
// kickoff. `i.imoulife.com` is the post-login portal; `www.imoulife.com`
// is the marketing site. Conservative choice: use the user portal pattern
// from EZVIZ.
const IMOU_WEB_PORTAL = "https://i.imoulife.com"

// Exponential backoff for OAuth token endpoint rate limits (mirrors EZVIZ).
const MAX_TOKEN_ATTEMPTS = 3
const BACKOFF_DELAYS_MS = [1_000, 2_000]

// ---------- types (Imou API response shapes) ----------

type _ImouTokenResponse = {
  accessToken?: string
  expiresIn?: number  // seconds
}

type ImouDeviceStatusResponse = {
  status?: "ON" | "OFF" | "UNKNOWN"  // Imou uses ON/OFF; we map to ONLINE/OFFLINE/UNKNOWN
  lastSeenAt?: string  // ISO datetime
}

type ImouStreamTokenResponse = {
  streamToken?: string
  expiresAt?: string  // ISO datetime
  // cloud-stream URL — Imou's documented live-stream URL format.
  // Returned by the API; we pass it through to the UI verbatim.
  liveUrl?: string
}

// ---------- helper: fetch with timeout + JSON parse (mirrors EZVIZ) ----------

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

// ---------- helper: fetch a fresh OAuth token (with backoff — mirrors EZVIZ) ----------

async function fetchFreshToken(vendorId: string, creds: { appId: string; appSecret: string }): Promise<string | null> {
  for (let attempt = 1; attempt <= MAX_TOKEN_ATTEMPTS; attempt++) {
    const { status, json } = await postJson(IMOU_TOKEN_URL, {
      appId: creds.appId,
      appSecret: creds.appSecret,
      grantType: "client_credentials",
    })

    if (status === 200 && json?.accessToken) {
      setCachedToken(vendorId, "IMOU", json.accessToken, Number(json.expiresIn) || 7200)
      return json.accessToken as string
    }

    if (status === 429 && attempt < MAX_TOKEN_ATTEMPTS) {
      const delay = BACKOFF_DELAYS_MS[attempt - 1] ?? 2_000
      await new Promise((r) => setTimeout(r, delay))
      continue
    }

    return null  // 4xx (other than 429) or 5xx → don't retry
  }
  return null
}

async function getUsableToken(vendorId: string, creds: { appId: string; appSecret: string }): Promise<string | null> {
  const cached = getCachedToken(vendorId, "IMOU")
  if (cached) return cached
  return fetchFreshToken(vendorId, creds)
}

// ---------- helper: cast DecryptedCreds to Imou shape ----------

function toImouCreds(creds: DecryptedCreds): { appId: string; appSecret: string } | null {
  if (!creds || typeof creds !== "object") return null
  const { appId, appSecret } = creds as Record<string, string>
  if (!appId || !appSecret) return null
  return { appId, appSecret }
}

// ---------- the provider ----------

export const imouProvider: CameraProvider = {
  brand: "IMOU",

  async validateCredentials(creds: DecryptedCreds): Promise<boolean> {
    const im = toImouCreds(creds)
    if (!im) return false
    const token = await fetchFreshToken("VALIDATE", im)
    return token !== null
  },

  async getDeviceStatus(camera: CameraRecord, creds: DecryptedCreds): Promise<DeviceStatus> {
    const im = toImouCreds(creds)
    if (!im) {
      // Flag 2: credential failure → UNKNOWN, NOT OFFLINE
      return {
        status: "UNKNOWN",
        error: "Imou credentials are malformed — check appId/appSecret in the tenant credential row",
      }
    }

    if (!camera.serialNumber) {
      return {
        status: "UNKNOWN",
        error: "Camera has no serialNumber — Imou requires serialNumber to identify the camera in the tenant's cloud account",
      }
    }

    const token = await getUsableToken(camera.vendorId, im)
    if (!token) {
      // Flag 2: token fetch failure → UNKNOWN, NOT OFFLINE
      return {
        status: "UNKNOWN",
        error: "Imou token fetch failed — check appId/appSecret or try again later (rate limit?)",
      }
    }

    const { status: httpStatus, json } = await getJson(
      deviceStatusUrl(camera.serialNumber),
      { Authorization: `Bearer ${token}` },
    )

    if (httpStatus === 401) {
      // Refresh-on-401: evict, fetch fresh, retry ONCE
      clearCachedToken(camera.vendorId, "IMOU")
      const freshToken = await fetchFreshToken(camera.vendorId, im)
      if (!freshToken) {
        return {
          status: "UNKNOWN",
          error: "Imou token refresh failed after 401 — check appId/appSecret",
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
          error: "Imou token refresh succeeded but retry still 401 — check appId/appSecret permissions",
        }
      }
      if (retry.status !== 200) {
        return {
          status: "UNKNOWN",
          error: `Imou device status check failed (HTTP ${retry.status}) after refresh`,
        }
      }
      return parseDeviceStatus(retry.json as ImouDeviceStatusResponse)
    }

    if (httpStatus !== 200) {
      return {
        status: "UNKNOWN",
        error: `Imou device status check failed (HTTP ${httpStatus})`,
      }
    }

    return parseDeviceStatus(json as ImouDeviceStatusResponse)
  },

  async getLaunchTarget(camera: CameraRecord, creds: DecryptedCreds): Promise<LaunchResult> {
    const im = toImouCreds(creds)
    if (!im) {
      const { Deny } = await import("@/hrm-server/rbac")
      throw new Deny("Imou credentials are malformed — appId/appSecret required for launch", 400)
    }

    if (!camera.serialNumber) {
      const { Deny } = await import("@/hrm-server/rbac")
      throw new Deny("Camera has no serialNumber — Imou requires serialNumber to launch", 400)
    }

    const token = await getUsableToken(camera.vendorId, im)
    if (!token) {
      const { Deny } = await import("@/hrm-server/rbac")
      throw new Deny("Imou token fetch failed — check appId/appSecret or try again later (rate limit?)", 400)
    }

    const { status: httpStatus, json } = await postJson(
      IMOU_STREAM_URL(camera.serialNumber, camera.channel),
      {},
      { Authorization: `Bearer ${token}` },
    )

    if (httpStatus === 401) {
      clearCachedToken(camera.vendorId, "IMOU")
      const freshToken = await fetchFreshToken(camera.vendorId, im)
      if (!freshToken) {
        const { Deny } = await import("@/hrm-server/rbac")
        throw new Deny("Imou token refresh failed after 401 — check appId/appSecret", 400)
      }
      const retry = await postJson(
        IMOU_STREAM_URL(camera.serialNumber, camera.channel),
        {},
        { Authorization: `Bearer ${freshToken}` },
      )
      if (retry.status !== 200 || !retry.json?.streamToken) {
        const { Deny } = await import("@/hrm-server/rbac")
        throw new Deny(`Imou stream token fetch failed (HTTP ${retry.status}) after refresh`, 400)
      }
      return buildLaunchResult(camera, retry.json as ImouStreamTokenResponse, retry.json.streamToken)
    }

    if (httpStatus !== 200 || !json?.streamToken) {
      const { Deny } = await import("@/hrm-server/rbac")
      throw new Deny(`Imou stream token fetch failed (HTTP ${httpStatus})`, 400)
    }

    return buildLaunchResult(camera, json as ImouStreamTokenResponse, json.streamToken)
  },
}

// ---------- helpers ----------

function parseDeviceStatus(resp: ImouDeviceStatusResponse): DeviceStatus {
  let status: DeviceStatus["status"] = "UNKNOWN"
  if (resp.status === "ON") status = "ONLINE"
  else if (resp.status === "OFF") status = "OFFLINE"

  let lastSeenAt: Date | null = null
  if (resp.lastSeenAt) {
    try { lastSeenAt = new Date(resp.lastSeenAt) } catch { /* bad ISO string */ }
  }

  return { status, lastSeenAt, error: null }
}

function buildLaunchResult(_camera: CameraRecord, resp: ImouStreamTokenResponse, accessToken: string): LaunchResult {
  // Phase 4 answer 3: "Imou: cloud-stream URL is PRIMARY, app scheme as
  // SECONDARY". Per Phase 5c Flag 2: when in doubt, web URL wins.
  //
  // The API-provided liveUrl (cloud-stream URL) is PRIMARY when present.
  // If the API doesn't return a liveUrl, we DO NOT construct an
  // imoulife:// URL — that scheme is unverified against Imou's developer
  // docs, and shipping an unverified scheme violates "when in doubt, web
  // URL wins". Fall back to the web portal URL as primary (DEEP_LINK).
  //
  // L-35 — VERIFICATION ATTEMPT 2026-10-02: Imou's developer portal
  // (open.imoulife.com) publishes a REST API but NO app deep-link scheme
  // documentation; no official imoulife:// URL spec is publicly available.
  // The conservative posture STAYS (API liveUrl or the web portal only —
  // no constructed scheme URLs). See the pre-production checklist in
  // providers/README.md.
  //
  // Flag A: accessToken is a SEPARATE field, NOT in the URL.

  let launchTarget: LaunchResult["launchTarget"]
  const fallbackWebUrl = IMOU_WEB_PORTAL

  if (resp.liveUrl) {
    // API returned a cloud-stream URL — use as primary
    launchTarget = {
      kind: "CLOUD_STREAM_TOKEN",
      url: resp.liveUrl,
      accessToken,
      expiresAt: parseExpiry(resp.expiresAt),
    }
  } else {
    // No liveUrl — fall back to the web portal as primary (DEEP_LINK).
    // The accessToken + expiresAt are NOT included (no stream to authorize).
    // The UI shows the web portal link + a note that no stream URL was
    // returned by the Imou API.
    launchTarget = {
      kind: "DEEP_LINK",
      url: IMOU_WEB_PORTAL,
    }
  }

  return { launchTarget, fallbackWebUrl }
}

function parseExpiry(expiresAt?: string): Date {
  if (expiresAt) {
    try { return new Date(expiresAt) } catch { /* fall through */ }
  }
  // Default 30 min expiry if the response doesn't specify
  return new Date(Date.now() + 30 * 60_000)
}

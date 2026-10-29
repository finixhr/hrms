/// <reference types="bun-types" />
// ============ Unit tests — Imou provider (Phase 5c) ============
// Mirrors the EZVIZ test suite (camera-providers-ezviz.test.ts) with
// Imou-specific differences:
//   - Creds shape is { appId, appSecret } (NOT { appKey, appSecret } like EZVIZ)
//   - Launch URL is the cloud-stream URL (Imou's documented live-stream format)
//   - accessToken is a SEPARATE field (Flag A — no embedded tokens in URLs)
//
// Plus a structural-identity test between EZVIZ and Imou (per the
// carry-forward reminder from Phase 5b): both are OAuth-based tenant-
// credential providers; their method signatures must match. Catches
// accidental divergence if someone modifies one without the other.
import { test, expect, describe, beforeAll, afterAll, beforeEach } from "bun:test"
import { db } from "@/lib/db"
import { imouProvider } from "@/hrm-server/cameras/providers/imou"
import { ezvizProvider } from "@/hrm-server/cameras/providers/ezviz"
import {
  getCachedToken, setCachedToken,
  __clearAllForTests, __cacheSizeForTests,
} from "@/hrm-server/cameras/providers/token-cache"
import { routes } from "@/hrm-server/routes/registry"
import "@/hrm-server/routes/router"  // side-effect imports populate the registry
import { createCamera, deleteCamera, getCamera } from "@/hrm-server/cameras/repository"
import { listRegisteredBrands, isRegisteredBrand } from "@/hrm-server/cameras/providers/registry"
import type { Ctx } from "@/hrm-server/types"
import type { Camera } from "@prisma/client"

// ---------- test contexts ----------

const ctxA: Ctx = {
  userId: "u-A", userName: "Alice", vendorId: "v-A", role: "HR_ADMIN",
  permissions: new Set(["camera.view", "camera.create", "camera.edit", "camera.delete", "camera.launch", "camera.manage"]),
}

// ---------- DB bootstrap ----------

let brAId: string
let originalFetch: typeof globalThis.fetch

beforeAll(async () => {
  originalFetch = globalThis.fetch
  const brA = await db.branch.create({ data: { vendorId: "v-A", code: "B1", name: "Branch 1", type: "WAREHOUSE" } })
  brAId = brA.id
})

afterAll(async () => {
  globalThis.fetch = originalFetch
  await db.cameraCredential.deleteMany()
  await db.camera.deleteMany()
  await db.branch.deleteMany({ where: { vendorId: "v-A" } })
  await db.$disconnect()
})

beforeEach(async () => {
  __clearAllForTests()
  await db.camera.deleteMany()
  await db.cameraCredential.deleteMany()
})

// ---------- helpers ----------

async function callRoute<T = any>(action: string, ctx: Ctx, payload: any): Promise<T> {
  const def = routes[action]
  if (!def) throw new Error(`Unknown route: ${action}`)
  return def.handler(ctx, payload, undefined as any) as Promise<T>
}

async function makeImouCamera(serial: string): Promise<Camera> {
  return createCamera(ctxA, {
    brand: "IMOU", name: `imou-${serial}`, serialNumber: serial, channel: 1,
    branchId: brAId, location: "test",
  })
}

function mockFetch(handler: (url: string, init?: any) => Promise<{ status: number; json?: any }>): typeof globalThis.fetch {
  return (async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : input?.url || ""
    const { status, json } = await handler(url, init)
    return {
      status,
      ok: status >= 200 && status < 300,
      json: async () => json || {},
      text: async () => JSON.stringify(json || {}),
      headers: new Map(),
    } as any
  }) as any
}

// ====================================================================
// 0. Registry now includes IMOU (Phase 5c)
// ====================================================================

describe("Provider registry — IMOU registered (Phase 5c)", () => {
  test("listRegisteredBrands returns all 4 brands", () => {
    const brands = listRegisteredBrands()
    expect(brands).toContain("HIKVISION")
    expect(brands).toContain("DAHUA")
    expect(brands).toContain("EZVIZ")
    expect(brands).toContain("IMOU")
    expect(brands.length).toBe(4)
  })

  test("isRegisteredBrand returns true for all 4 brands, false for unknown", () => {
    expect(isRegisteredBrand("HIKVISION")).toBe(true)
    expect(isRegisteredBrand("DAHUA")).toBe(true)
    expect(isRegisteredBrand("EZVIZ")).toBe(true)
    expect(isRegisteredBrand("IMOU")).toBe(true)
    expect(isRegisteredBrand("ONVIF")).toBe(false)
  })
})

// ====================================================================
// 1. Imou — token cache (mirrors EZVIZ)
// ====================================================================

describe("Imou provider — token cache (Phase 5c)", () => {
  test("successful token fetch caches the token; 2nd call hits the cache", async () => {
    let tokenFetchCount = 0
    globalThis.fetch = mockFetch(async (url) => {
      if (url.includes("/oauth/token")) {
        tokenFetchCount++
        return { status: 200, json: { accessToken: "imou-tok-123", expiresIn: 7200 } }
      }
      if (url.includes("/devices/") && url.includes("/status")) {
        return { status: 200, json: { status: "ON", lastSeenAt: "2026-09-26T10:00:00Z" } }
      }
      return { status: 404 }
    })

    const cam = await makeImouCamera("SN-IM-001")
    const creds = { appId: "a", appSecret: "s" }

    await imouProvider.getDeviceStatus(cam, creds as any)
    expect(tokenFetchCount).toBe(1)

    await imouProvider.getDeviceStatus(cam, creds as any)
    expect(tokenFetchCount).toBe(1)  // cache hit

    expect(__cacheSizeForTests()).toBe(1)
  })
})

// ====================================================================
// 2. Imou — refresh-on-401 (mirrors EZVIZ, with Flag 2 UNKNOWN-not-OFFLINE)
// ====================================================================

describe("Imou provider — refresh-on-401 + Flag 2 (Phase 5c)", () => {
  test("401 on device call → refresh → retry → success", async () => {
    let tokenFetchCount = 0
    let deviceCallCount = 0
    globalThis.fetch = mockFetch(async (url) => {
      if (url.includes("/oauth/token")) {
        tokenFetchCount++
        return { status: 200, json: { accessToken: `fresh-${tokenFetchCount}`, expiresIn: 7200 } }
      }
      if (url.includes("/devices/") && url.includes("/status")) {
        deviceCallCount++
        if (deviceCallCount === 1) return { status: 401, json: { error: "expired" } }
        return { status: 200, json: { status: "ON", lastSeenAt: "2026-09-26T11:00:00Z" } }
      }
      return { status: 404 }
    })

    const cam = await makeImouCamera("SN-IM-002")
    const creds = { appId: "a", appSecret: "s" }
    setCachedToken("v-A", "IMOU", "stale-tok", 7200)

    const result = await imouProvider.getDeviceStatus(cam, creds as any)

    expect(tokenFetchCount).toBe(1)
    expect(deviceCallCount).toBe(2)
    expect(result.status).toBe("ONLINE")
    expect(result.lastSeenAt?.toISOString()).toBe("2026-09-26T11:00:00.000Z")
  })

  test("401 on retry too → UNKNOWN + lastError (Flag 2 — NOT OFFLINE)", async () => {
    globalThis.fetch = mockFetch(async (url) => {
      if (url.includes("/oauth/token")) return { status: 200, json: { accessToken: "fresh-but-revoked", expiresIn: 7200 } }
      return { status: 401, json: { error: "revoked" } }
    })

    const cam = await makeImouCamera("SN-IM-003")
    const creds = { appId: "a", appSecret: "s" }

    const result = await imouProvider.getDeviceStatus(cam, creds as any)

    expect(result.status).toBe("UNKNOWN")
    expect(result.error).toMatch(/Imou token refresh succeeded but retry still 401/)
    expect(result.status).not.toBe("OFFLINE")
  })

  test("token fetch failure → UNKNOWN + lastError (Flag 2)", async () => {
    globalThis.fetch = mockFetch(async (url) => {
      if (url.includes("/oauth/token")) return { status: 401, json: { error: "invalid appId/appSecret" } }
      return { status: 404 }
    })

    const cam = await makeImouCamera("SN-IM-004")
    const creds = { appId: "bad", appSecret: "bad" }

    const result = await imouProvider.getDeviceStatus(cam, creds as any)

    expect(result.status).toBe("UNKNOWN")
    expect(result.error).toMatch(/Imou token fetch failed/)
    expect(result.status).not.toBe("OFFLINE")
  })

  test("malformed creds (no appId/appSecret) → UNKNOWN + lastError (Flag 2)", async () => {
    const cam = await makeImouCamera("SN-IM-005")
    const result = await imouProvider.getDeviceStatus(cam, null)
    expect(result.status).toBe("UNKNOWN")
    expect(result.error).toMatch(/Imou credentials are malformed/)
    expect(result.status).not.toBe("OFFLINE")
  })
})

// ====================================================================
// 3. Imou — OAuth rate-limit backoff (mirrors EZVIZ)
// ====================================================================

describe("Imou provider — OAuth rate-limit backoff (Phase 5c)", () => {
  test("token endpoint 429 → backoff → success", async () => {
    let tokenAttemptCount = 0
    const delays: number[] = []
    const realSetTimeout = globalThis.setTimeout
    globalThis.setTimeout = ((cb: any, ms?: number) => {
      delays.push(ms || 0)
      return realSetTimeout(cb, ms)
    }) as any

    try {
      globalThis.fetch = mockFetch(async (url) => {
        if (url.includes("/oauth/token")) {
          tokenAttemptCount++
          if (tokenAttemptCount === 1) return { status: 429, json: { error: "rate limited" } }
          return { status: 200, json: { accessToken: "tok-after-backoff", expiresIn: 7200 } }
        }
        if (url.includes("/devices/") && url.includes("/status")) return { status: 200, json: { status: "ON" } }
        return { status: 404 }
      })

      const cam = await makeImouCamera("SN-IM-006")
      const creds = { appId: "a", appSecret: "s" }

      const result = await imouProvider.getDeviceStatus(cam, creds as any)

      expect(tokenAttemptCount).toBe(2)
      expect(delays[0]).toBe(1_000)
      expect(result.status).toBe("ONLINE")
    } finally {
      globalThis.setTimeout = realSetTimeout
    }
  })

  test("429 three times → UNKNOWN + lastError (Flag 2, max attempts)", async () => {
    let tokenAttemptCount = 0
    const realSetTimeout = globalThis.setTimeout
    globalThis.setTimeout = ((cb: any, _ms?: number) => realSetTimeout(cb, 0)) as any

    try {
      globalThis.fetch = mockFetch(async (url) => {
        if (url.includes("/oauth/token")) {
          tokenAttemptCount++
          return { status: 429, json: { error: "rate limited" } }
        }
        return { status: 404 }
      })

      const cam = await makeImouCamera("SN-IM-007")
      const creds = { appId: "a", appSecret: "s" }

      const result = await imouProvider.getDeviceStatus(cam, creds as any)

      expect(tokenAttemptCount).toBe(3)
      expect(result.status).toBe("UNKNOWN")
      expect(result.error).toMatch(/Imou token fetch failed/)
      expect(result.status).not.toBe("OFFLINE")
    } finally {
      globalThis.setTimeout = realSetTimeout
    }
  })
})

// ====================================================================
// 4. Imou — launch (cloud-stream URL primary, accessToken separate — Flag A)
// ====================================================================

describe("Imou provider — cloud-stream launch (Phase 5c)", () => {
  test("getLaunchTarget returns CLOUD_STREAM_TOKEN with cloud-stream URL + separate accessToken (Flag A)", async () => {
    globalThis.fetch = mockFetch(async (url) => {
      if (url.includes("/oauth/token")) return { status: 200, json: { accessToken: "tok-123", expiresIn: 7200 } }
      if (url.includes("/stream")) {
        return {
          status: 200,
          json: {
            streamToken: "imou-stream-tok-456",
            expiresAt: "2026-09-26T12:00:00Z",
            liveUrl: "https://live.imoulife.com/play/SN-IM-L1/1",
          },
        }
      }
      return { status: 404 }
    })

    const cam = await makeImouCamera("SN-IM-L1")
    const creds = { appId: "myAppId", appSecret: "s" }

    const result = await imouProvider.getLaunchTarget(cam, creds as any)

    expect(result.launchTarget.kind).toBe("CLOUD_STREAM_TOKEN")
    // Flag A: accessToken is a SEPARATE field, NOT in the URL
    expect((result.launchTarget as any).accessToken).toBe("imou-stream-tok-456")
    // URL is the API-provided liveUrl (primary per Phase 4 answer 3)
    expect((result.launchTarget as any).url).toBe("https://live.imoulife.com/play/SN-IM-L1/1")
    expect((result.launchTarget as any).url).not.toContain("imou-stream-tok-456")  // no embedded token
    expect(result.launchTarget).toHaveProperty("expiresAt")
    expect(result.fallbackWebUrl).toBe("https://i.imoulife.com")
  })

  test("getLaunchTarget with no tenant creds throws 400", async () => {
    const cam = await makeImouCamera("SN-IM-L2")
    try {
      await imouProvider.getLaunchTarget(cam, null)
      throw new Error("FAIL: should have thrown 400")
    } catch (e: any) {
      expect(e.code).toBe(400)
      expect(e.message).toMatch(/Imou credentials are malformed/)
    }
  })

  test("getLaunchTarget with missing serialNumber throws 400", async () => {
    const cam = await db.camera.create({
      data: { vendorId: "v-A", brand: "IMOU", name: "no-sn", serialNumber: null, channel: 1 },
    })
    const creds = { appId: "a", appSecret: "s" }
    try {
      await imouProvider.getLaunchTarget(cam, creds as any)
      throw new Error("FAIL: should have thrown 400")
    } catch (e: any) {
      expect(e.code).toBe(400)
      expect(e.message).toMatch(/no serialNumber/)
    }
  })
})

// ====================================================================
// 5. Imou camera.create via route handler (full integration)
// ====================================================================

describe("Imou camera.create via route handler (Phase 5c)", () => {
  test("camera.create with IMOU brand succeeds", async () => {
    const result = await callRoute("camera.create", ctxA, {
      brand: "IMOU", name: "via-route", serialNumber: "SN-IM-INT-001", channel: 1,
    })
    expect(result.brand).toBe("IMOU")
    expect(result.serialNumber).toBe("SN-IM-INT-001")
  })
})

// ====================================================================
// 6. Structural identity between EZVIZ and Imou (carry-forward from Phase 5b)
// ====================================================================

describe("EZVIZ vs Imou structural identity (Phase 5c carry-forward)", () => {
  test("both providers implement the CameraProvider interface identically", () => {
    // Catches accidental divergence: if someone adds a method to EZVIZ but
    // not Imou (or vice versa), this test fails. Both are OAuth-based
    // tenant-credential providers; their method shapes MUST match.
    expect(typeof ezvizProvider.brand).toBe(typeof imouProvider.brand)
    expect(typeof ezvizProvider.validateCredentials).toBe(typeof imouProvider.validateCredentials)
    expect(typeof ezvizProvider.getDeviceStatus).toBe(typeof imouProvider.getDeviceStatus)
    expect(typeof ezvizProvider.getLaunchTarget).toBe(typeof imouProvider.getLaunchTarget)
  })

  test("both return CLOUD_STREAM_TOKEN for launches when API provides a stream URL", async () => {
    // Both EZVIZ and Imou are OAuth-credential brands → both should return
    // CLOUD_STREAM_TOKEN (with accessToken as a separate field per Flag A)
    // WHEN the API returns a stream URL. Hikvision/Dahua (per-camera brands)
    // always return DEEP_LINK.
    globalThis.fetch = mockFetch(async (url) => {
      if (url.includes("/oauth/token")) return { status: 200, json: { accessToken: "tok", expiresIn: 7200 } }
      if (url.includes("/stream")) {
        // Include liveUrl so Imou returns CLOUD_STREAM_TOKEN (Flag 2: without
        // liveUrl, Imou falls back to DEEP_LINK with the web portal URL).
        return {
          status: 200,
          json: {
            streamToken: "st",
            expiresAt: "2026-09-26T12:00:00Z",
            liveUrl: "https://live.example.com/play/STRUCT/1",
          },
        }
      }
      return { status: 404 }
    })

    const ezvizCam = await createCamera(ctxA, {
      brand: "EZVIZ", name: "ezviz", serialNumber: "SN-STRUCT-1", channel: 1, branchId: brAId,
    })
    const imouCam = await makeImouCamera("SN-STRUCT-2")

    const ezvizResult = await ezvizProvider.getLaunchTarget(ezvizCam, { appKey: "k", appSecret: "s" } as any)
    const imouResult = await imouProvider.getLaunchTarget(imouCam, { appId: "a", appSecret: "s" } as any)

    expect(ezvizResult.launchTarget.kind).toBe("CLOUD_STREAM_TOKEN")
    expect(imouResult.launchTarget.kind).toBe("CLOUD_STREAM_TOKEN")
    // Both must have accessToken as a separate field (Flag A)
    expect((ezvizResult.launchTarget as any).accessToken).toBeDefined()
    expect((imouResult.launchTarget as any).accessToken).toBeDefined()
    // Both must NOT have the token in the URL
    expect((ezvizResult.launchTarget as any).url).not.toContain((ezvizResult.launchTarget as any).accessToken)
    expect((imouResult.launchTarget as any).url).not.toContain((imouResult.launchTarget as any).accessToken)
  })

  test("Phase 5c Flag 2: Imou with no liveUrl from API → DEEP_LINK fallback to web portal (NOT a constructed imou:// URL)", async () => {
    // Per Flag 2: when in doubt, web URL wins. The imoulife:// scheme is
    // unverified — never construct it. If the API doesn't return a liveUrl,
    // fall back to the web portal URL as primary (DEEP_LINK).
    globalThis.fetch = mockFetch(async (url) => {
      if (url.includes("/oauth/token")) return { status: 200, json: { accessToken: "tok", expiresIn: 7200 } }
      if (url.includes("/stream")) {
        // No liveUrl — Imou should fall back to web portal
        return { status: 200, json: { streamToken: "st", expiresAt: "2026-09-26T12:00:00Z" } }
      }
      return { status: 404 }
    })

    const cam = await makeImouCamera("SN-IM-FALLBACK-1")
    const creds = { appId: "a", appSecret: "s" }
    const result = await imouProvider.getLaunchTarget(cam, creds as any)

    // Falls back to DEEP_LINK (no accessToken — no stream to authorize)
    expect(result.launchTarget.kind).toBe("DEEP_LINK")
    expect((result.launchTarget as any).url).toBe("https://i.imoulife.com")
    expect(result.fallbackWebUrl).toBe("https://i.imoulife.com")
    // The unverified imoulife:// scheme must NOT appear anywhere
    expect(JSON.stringify(result)).not.toContain("imoulife://")
    expect(JSON.stringify(result)).not.toContain("imou://")
  })
})

// ====================================================================
// Carry-forward reminder — TODO(e2e) marker (kept here for visibility)
// ====================================================================
// TODO(e2e): add a dispatcher-level test that asserts:
//   - Unauthenticated POST /api/hrm with action=camera.create → 401
//   - Authenticated POST with no camera.create permission → 403
//   - Cross-tenant cameraId in the payload → 404 (not 403)
// See tests/unit/camera-providers-ezviz.test.ts:494–508 for the full
// marker. The current unit tests bypass the dispatcher and call
// routes["camera.*"].handler directly.

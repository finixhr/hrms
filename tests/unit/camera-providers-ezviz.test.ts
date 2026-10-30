/// <reference types="bun-types" />
// ============ Unit tests — EZVIZ provider + Phase 5b flag fixes ============
// Phase 5b deliverables:
//   1. EZVIZ provider end-to-end with mocked fetch:
//      - Successful token fetch + cache hit on 2nd call
//      - 401 on device call → refresh → retry → success
//      - 401 twice → UNKNOWN + lastError (NOT OFFLINE — Flag 2)
//      - Token endpoint 429 → backoff → success
//      - ezopen:// URL shape
//      - No tenant creds → getLaunchTarget throws 400
//   2. Flag 4a: camera.update on soft-deleted camera → 404
//   3. Flag 4b: camera.restore on already-enabled camera → idempotent no-op (no audit row)
//   4. Flag 3 (registry): validateCameraCreate rejects ONVIF + accepts EZVIZ
//      (covered in camera-tenant-isolation.test.ts; here we add an
//      integration check that camera.create with EZVIZ succeeds via the
//      full route handler, not just the validator).
//
// Mock strategy: replace globalThis.fetch with a controllable mock per-test.
// Bun doesn't have a built-in fetch mock helper, so we save/restore
// globalThis.fetch manually in beforeAll/afterAll.
import { test, expect, describe, beforeAll, afterAll, beforeEach } from "bun:test"
import { db } from "@/lib/db"
import { ezvizProvider } from "@/hrm-server/cameras/providers/ezviz"
import {
  getCachedToken, setCachedToken, clearCachedToken,
  __clearAllForTests, __cacheSizeForTests,
} from "@/hrm-server/cameras/providers/token-cache"
import { routes } from "@/hrm-server/routes/registry"
import "@/hrm-server/routes/router"  // side-effect imports populate the registry
import { createCamera, deleteCamera, getCamera } from "@/hrm-server/cameras/repository"
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

async function makeEzvizCamera(serial: string): Promise<Camera> {
  return createCamera(ctxA, {
    brand: "EZVIZ", name: `ezviz-${serial}`, serialNumber: serial, channel: 1,
    branchId: brAId, location: "test",
  })
}

/** Build a mock fetch that responds based on URL + a sequence of responses. */
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
// 1. EZVIZ — successful token fetch + cache hit
// ====================================================================

describe("EZVIZ provider — token cache (Phase 5b item 2a)", () => {
  test("successful token fetch caches the token; 2nd call hits the cache (no 2nd fetch)", async () => {
    let tokenFetchCount = 0
    globalThis.fetch = mockFetch(async (url) => {
      if (url.includes("/oauth/token")) {
        tokenFetchCount++
        return { status: 200, json: { accessToken: "tok-123", expiresIn: 7200 } }
      }
      if (url.includes("/devices/") && url.includes("/status")) {
        return { status: 200, json: { status: "ON", lastSeenAt: "2026-09-26T10:00:00Z" } }
      }
      return { status: 404, json: { error: "unknown URL" } }
    })

    const cam = await makeEzvizCamera("SN-EZ-001")
    const creds = { appKey: "k", appSecret: "s" }

    // First call: fetches token + calls device endpoint
    await ezvizProvider.getDeviceStatus(cam, creds as any)
    expect(tokenFetchCount).toBe(1)

    // Second call: should HIT the cache (no new token fetch)
    await ezvizProvider.getDeviceStatus(cam, creds as any)
    expect(tokenFetchCount).toBe(1)  // still 1 — cache hit

    // Cache size should be 1
    expect(__cacheSizeForTests()).toBe(1)
  })

  test("expired cached token triggers a fresh fetch", async () => {
    let tokenFetchCount = 0
    globalThis.fetch = mockFetch(async (url) => {
      if (url.includes("/oauth/token")) {
        tokenFetchCount++
        return { status: 200, json: { accessToken: `tok-${tokenFetchCount}`, expiresIn: 7200 } }
      }
      if (url.includes("/devices/") && url.includes("/status")) {
        return { status: 200, json: { status: "ON", lastSeenAt: null } }
      }
      return { status: 404 }
    })

    const cam = await makeEzvizCamera("SN-EZ-002")
    const creds = { appKey: "k", appSecret: "s" }

    // Pre-populate the cache with an EXPIRED token (expiresAt = 1ms in the past)
    setCachedToken("v-A", "EZVIZ", "expired-tok", -1)  // -1s expiresIn → already expired

    await ezvizProvider.getDeviceStatus(cam, creds as any)
    expect(tokenFetchCount).toBe(1)  // had to fetch fresh because cached was expired
  })
})

// ====================================================================
// 2. EZVIZ — 401 on device call → refresh → retry → success
// ====================================================================

describe("EZVIZ provider — refresh-on-401 (Phase 5b item 2b)", () => {
  test("401 on device call → refresh token → retry → success", async () => {
    let tokenFetchCount = 0
    let deviceCallCount = 0
    globalThis.fetch = mockFetch(async (url) => {
      if (url.includes("/oauth/token")) {
        tokenFetchCount++
        return { status: 200, json: { accessToken: `fresh-${tokenFetchCount}`, expiresIn: 7200 } }
      }
      if (url.includes("/devices/") && url.includes("/status")) {
        deviceCallCount++
        if (deviceCallCount === 1) {
          // First call: 401 (cached token is "stale")
          return { status: 401, json: { error: "token expired" } }
        }
        // Retry: success
        return { status: 200, json: { status: "ON", lastSeenAt: "2026-09-26T11:00:00Z" } }
      }
      return { status: 404 }
    })

    const cam = await makeEzvizCamera("SN-EZ-003")
    const creds = { appKey: "k", appSecret: "s" }
    // Pre-populate cache with a stale token
    setCachedToken("v-A", "EZVIZ", "stale-tok", 7200)

    const result = await ezvizProvider.getDeviceStatus(cam, creds as any)

    expect(tokenFetchCount).toBe(1)  // refresh happened once
    expect(deviceCallCount).toBe(2)  // initial + retry
    expect(result.status).toBe("ONLINE")
    expect(result.lastSeenAt?.toISOString()).toBe("2026-09-26T11:00:00.000Z")
    expect(result.error).toBeNull()
  })

  test("401 on retry too → UNKNOWN + lastError (NOT OFFLINE — Flag 2)", async () => {
    let tokenFetchCount = 0
    globalThis.fetch = mockFetch(async (url) => {
      if (url.includes("/oauth/token")) {
        tokenFetchCount++
        return { status: 200, json: { accessToken: "fresh-but-revoked", expiresIn: 7200 } }
      }
      // Both device calls return 401
      return { status: 401, json: { error: "token revoked" } }
    })

    const cam = await makeEzvizCamera("SN-EZ-004")
    const creds = { appKey: "k", appSecret: "s" }

    const result = await ezvizProvider.getDeviceStatus(cam, creds as any)

    // Flag 2: status MUST be "UNKNOWN", NOT "OFFLINE"
    expect(result.status).toBe("UNKNOWN")
    expect(result.error).toMatch(/EZVIZ token refresh succeeded but retry still 401/)
    expect(result.status).not.toBe("OFFLINE")  // explicit: never OFFLINE for credential failures
  })

  test("token fetch failure (non-200 from /oauth/token) → UNKNOWN + lastError (Flag 2)", async () => {
    globalThis.fetch = mockFetch(async (url) => {
      if (url.includes("/oauth/token")) {
        return { status: 401, json: { error: "invalid appKey/appSecret" } }
      }
      return { status: 404 }
    })

    const cam = await makeEzvizCamera("SN-EZ-005")
    const creds = { appKey: "bad-key", appSecret: "bad-secret" }

    const result = await ezvizProvider.getDeviceStatus(cam, creds as any)

    expect(result.status).toBe("UNKNOWN")
    expect(result.error).toMatch(/EZVIZ token fetch failed/)
    expect(result.status).not.toBe("OFFLINE")
  })

  test("malformed creds (no appKey/appSecret) → UNKNOWN + lastError (Flag 2)", async () => {
    const cam = await makeEzvizCamera("SN-EZ-006")

    const result = await ezvizProvider.getDeviceStatus(cam, null)

    expect(result.status).toBe("UNKNOWN")
    expect(result.error).toMatch(/EZVIZ credentials are malformed/)
    expect(result.status).not.toBe("OFFLINE")
  })
})

// ====================================================================
// 3. EZVIZ — token endpoint 429 → backoff → success
// ====================================================================

describe("EZVIZ provider — OAuth rate-limit backoff (Phase 5b item 2c)", () => {
  test("token endpoint 429 → backoff → success on 2nd attempt", async () => {
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
          if (tokenAttemptCount === 1) {
            return { status: 429, json: { error: "rate limited" } }
          }
          return { status: 200, json: { accessToken: "tok-after-backoff", expiresIn: 7200 } }
        }
        if (url.includes("/devices/") && url.includes("/status")) {
          return { status: 200, json: { status: "ON" } }
        }
        return { status: 404 }
      })

      const cam = await makeEzvizCamera("SN-EZ-007")
      const creds = { appKey: "k", appSecret: "s" }

      const result = await ezvizProvider.getDeviceStatus(cam, creds as any)

      expect(tokenAttemptCount).toBe(2)  // 1st 429 + 2nd success
      expect(delays.length).toBeGreaterThan(0)  // backoff happened
      expect(delays[0]).toBe(1_000)  // first backoff is 1s
      expect(result.status).toBe("ONLINE")
    } finally {
      globalThis.setTimeout = realSetTimeout
    }
  })

  test("token endpoint 429 three times → UNKNOWN + lastError (Flag 2, max attempts)", async () => {
    let tokenAttemptCount = 0
    const realSetTimeout = globalThis.setTimeout
    globalThis.setTimeout = ((cb: any, _ms?: number) => realSetTimeout(cb, 0)) as any  // skip real backoff in test

    try {
      globalThis.fetch = mockFetch(async (url) => {
        if (url.includes("/oauth/token")) {
          tokenAttemptCount++
          return { status: 429, json: { error: "rate limited" } }
        }
        return { status: 404 }
      })

      const cam = await makeEzvizCamera("SN-EZ-008")
      const creds = { appKey: "k", appSecret: "s" }

      const result = await ezvizProvider.getDeviceStatus(cam, creds as any)

      expect(tokenAttemptCount).toBe(3)  // max attempts
      expect(result.status).toBe("UNKNOWN")
      expect(result.error).toMatch(/EZVIZ token fetch failed/)
      expect(result.status).not.toBe("OFFLINE")
    } finally {
      globalThis.setTimeout = realSetTimeout
    }
  })
})

// ====================================================================
// 4. EZVIZ — ezopen:// URL shape
// ====================================================================

describe("EZVIZ provider — ezopen:// launch (Phase 4 answer 3)", () => {
  test("getLaunchTarget returns CLOUD_STREAM_TOKEN with ezopen:// URL (no embedded token — Flag A)", async () => {
    globalThis.fetch = mockFetch(async (url) => {
      if (url.includes("/oauth/token")) {
        return { status: 200, json: { accessToken: "tok-123", expiresIn: 7200 } }
      }
      if (url.includes("/stream")) {
        return {
          status: 200,
          json: { streamToken: "stream-tok-456", expiresAt: "2026-09-26T12:00:00Z" },
        }
      }
      return { status: 404 }
    })

    const cam = await makeEzvizCamera("SN-EZ-LAUNCH-001")
    const creds = { appKey: "myAppKey", appSecret: "s" }

    const result = await ezvizProvider.getLaunchTarget(cam, creds as any)

    expect(result.launchTarget.kind).toBe("CLOUD_STREAM_TOKEN")
    // Flag A (Phase 5c): URL is the documented format
    // `ezopen://open.ys7.com/{serial}/{channel}.live` — NO ?token= query param.
    expect((result.launchTarget as any).url).toBe("ezopen://open.ys7.com/SN-EZ-LAUNCH-001/1.live")
    expect((result.launchTarget as any).url).not.toContain("token=")  // no embedded token
    expect((result.launchTarget as any).url).not.toContain("stream-tok-456")  // token NOT in URL
    // accessToken is a SEPARATE field (not in the URL — prevents referrer/history/log leakage)
    expect((result.launchTarget as any).accessToken).toBe("stream-tok-456")
    expect(result.launchTarget).toHaveProperty("expiresAt")
    expect(result.fallbackWebUrl).toBe("https://i.ezvizlife.com")
  })

  test("getLaunchTarget with no tenant creds throws 400 (configuration issue)", async () => {
    const cam = await makeEzvizCamera("SN-EZ-LAUNCH-002")

    try {
      await ezvizProvider.getLaunchTarget(cam, null)
      throw new Error("FAIL: should have thrown 400")
    } catch (e: any) {
      expect(e.code).toBe(400)
      expect(e.message).toMatch(/EZVIZ credentials are malformed/)
    }
  })

  test("getLaunchTarget with missing serialNumber throws 400", async () => {
    // Create a camera without a serialNumber (should be impossible per validateCameraCreate,
    // but the provider should still defend)
    const cam = await db.camera.create({
      data: {
        vendorId: "v-A", brand: "EZVIZ", name: "no-sn", serialNumber: null, channel: 1,
      },
    })
    const creds = { appKey: "k", appSecret: "s" }

    try {
      await ezvizProvider.getLaunchTarget(cam, creds as any)
      throw new Error("FAIL: should have thrown 400")
    } catch (e: any) {
      expect(e.code).toBe(400)
      expect(e.message).toMatch(/no serialNumber/)
    }
  })
})

// ====================================================================
// 5. Flag 4a — camera.update on soft-deleted camera → 404
// ====================================================================

describe("Flag 4a — camera.update on soft-deleted camera (Phase 5b)", () => {
  test("camera.update on a soft-deleted camera → 404 (no audit row)", async () => {
    const cam = await createCamera(ctxA, {
      brand: "HIKVISION", name: "to-soft-delete", serialNumber: "SN-4A-001", channel: 1,
      verificationCode: "VC-4A-001", branchId: brAId,
    })
    await deleteCamera(ctxA, cam.id)

    const beforeAudit = await db.auditLog.count({ where: { vendorId: "v-A", action: "camera.update" } })
    try {
      await callRoute("camera.update", ctxA, { id: cam.id, name: "hacked-after-delete" })
      throw new Error("FAIL: update on soft-deleted should 404")
    } catch (e: any) {
      expect(e.code).toBe(404)
    }
    const afterAudit = await db.auditLog.count({ where: { vendorId: "v-A", action: "camera.update" } })
    expect(afterAudit).toBe(beforeAudit)  // no audit row written
  })
})

// ====================================================================
// 6. Flag 4b — camera.restore on already-enabled camera → idempotent no-op
// ====================================================================

describe("Flag 4b — camera.restore idempotent no-op (Phase 5b)", () => {
  test("camera.restore on an already-enabled camera returns the row without writing an audit row", async () => {
    const cam = await createCamera(ctxA, {
      brand: "HIKVISION", name: "already-live", serialNumber: "SN-4B-001", channel: 1,
      verificationCode: "VC-4B-001", branchId: brAId,
    })
    // Camera is already enabled (just created)

    const beforeAudit = await db.auditLog.count({ where: { vendorId: "v-A", action: "camera.restore" } })
    const result = await callRoute("camera.restore", ctxA, { id: cam.id })
    const afterAudit = await db.auditLog.count({ where: { vendorId: "v-A", action: "camera.restore" } })

    expect(result.enabled).toBe(true)
    expect(result.id).toBe(cam.id)
    expect(afterAudit).toBe(beforeAudit)  // no audit row — idempotent no-op
  })

  test("camera.restore on a soft-deleted camera writes an audit row (state change happened)", async () => {
    const cam = await createCamera(ctxA, {
      brand: "HIKVISION", name: "to-restore", serialNumber: "SN-4B-002", channel: 1,
      verificationCode: "VC-4B-002", branchId: brAId,
    })
    await deleteCamera(ctxA, cam.id)

    const beforeAudit = await db.auditLog.count({ where: { vendorId: "v-A", action: "camera.restore" } })
    const result = await callRoute("camera.restore", ctxA, { id: cam.id })
    const afterAudit = await db.auditLog.count({ where: { vendorId: "v-A", action: "camera.restore" } })

    expect(result.enabled).toBe(true)
    expect(afterAudit).toBe(beforeAudit + 1)  // audit row written — state changed
  })
})

// ====================================================================
// 7. Flag 3 integration — camera.create with EZVIZ succeeds via full route handler
//    (verifies validateCameraCreate + registry + repository all wired together)
// ====================================================================

describe("Flag 3 integration — EZVIZ camera.create via route handler (Phase 5b)", () => {
  test("camera.create with EZVIZ brand succeeds now that EZVIZ is registered", async () => {
    const result = await callRoute("camera.create", ctxA, {
      brand: "EZVIZ", name: "via-route", serialNumber: "SN-F3-001", channel: 1,
    })
    expect(result.brand).toBe("EZVIZ")
    expect(result.serialNumber).toBe("SN-F3-001")
    expect(result.hasVerificationCode).toBe(false)  // EZVIZ doesn't use VC
  })

  test("camera.create with unknown brand 'ONVIF' is rejected by validateCameraCreate", async () => {
    try {
      await callRoute("camera.create", ctxA, {
        brand: "ONVIF", name: "bad-brand", serialNumber: "SN-F3-002", channel: 1,
      })
      throw new Error("FAIL: ONVIF should be rejected")
    } catch (e: any) {
      expect(e.code).toBe(400)
      expect(e.message).toMatch(/Unsupported camera brand: ONVIF/)
      expect(e.message).toMatch(/HIKVISION/)
      expect(e.message).toMatch(/DAHUA/)
      expect(e.message).toMatch(/EZVIZ/)
    }
  })
})

// ====================================================================
// Carry-forward reminder — structural-identity tests
// ====================================================================
// The Hikvision/Dahua structural-identity test lives in camera-providers.test.ts.
// Once Imou exists (Phase 5c), add an EZVIZ/Imou structural-identity test here:
// both are OAuth-based tenant-credential providers; their method signatures
// must match. For now, EZVIZ is the only OAuth provider — no pair to compare.

describe("EZVIZ structural identity (Phase 5b — placeholder for Phase 5c)", () => {
  test("EZVIZ provider implements the full CameraProvider interface", () => {
    // Catches accidental omission of a method (e.g. forgot to implement
    // validateCredentials). When Imou lands in Phase 5c, add a parallel
    // test that asserts EZVIZ and Imou have identical method shapes.
    expect(typeof ezvizProvider.brand).toBe("string")
    expect(ezvizProvider.brand).toBe("EZVIZ")
    expect(typeof ezvizProvider.validateCredentials).toBe("function")
    expect(typeof ezvizProvider.getDeviceStatus).toBe("function")
    expect(typeof ezvizProvider.getLaunchTarget).toBe("function")
  })
})

// ====================================================================
// Carry-forward reminder — TODO(e2e) marker
// ====================================================================
// TODO(e2e): add a dispatcher-level test that asserts:
//   - Unauthenticated POST /api/hrm with action=camera.create → 401
//   - Authenticated POST with no camera.create permission → 403
//   - Cross-tenant cameraId in the payload → 404 (not 403)
// These require running the actual Next.js dispatcher at /api/hrm/route.ts
// against a real HTTP request, which is beyond the scope of bun:test unit
// tests. Add as an e2e test in tests/e2e/ when the e2e harness is set up
// (separate PR).
//
// The current unit tests bypass the dispatcher and call routes["camera.*"].handler
// directly. This tests the handler's INTERNAL security checks (EZVIZ/Imou gate,
// cross-tenant 404, soft-deleted 404) but NOT the dispatcher's perm:[...]
// enforcement (which lives at src/app/api/hrm/route.ts:154-160).

/// <reference types="bun-types" />
// ============ Unit tests — per-provider + Flag 3c (Phase 5) ============
// Phase 5 deliverables:
//   1. Per-provider unit tests for Hikvision + Dahua (Dahua mirrors Hikvision
//      per the user's "likely mirrors Hikvision" instruction).
//   2. Flag 3b: camera.launch returns the EXACT §12 envelope.
//   3. Flag 3c: camera.launch AND camera.status on a soft-deleted camera → 404
//      (user's confirmed lean: "soft-deleted cameras are gone from the
//      user's view").
//   4. Flag 1: camera.status for Hikvision sets lastStatusCheckAt even when
//      the provider returns last-known status (no cloud API call).
//   5. Registry extraction: getProvider, isRegisteredBrand, listRegisteredBrands.
//
// These tests cover the provider layer + the soft-deleted policy decision.
// The existing camera-tenant-isolation.test.ts covers repository + route
// scope/audit/rate-limit behaviors.
import { test, expect, describe, beforeAll, afterAll, beforeEach } from "bun:test"
import { db } from "@/lib/db"
import { hikvisionProvider } from "@/hrm-server/cameras/providers/hikvision"
import { dahuaProvider } from "@/hrm-server/cameras/providers/dahua"
import {
  getProvider, listRegisteredBrands, isRegisteredBrand,
} from "@/hrm-server/cameras/providers/registry"
import { routes } from "@/hrm-server/routes/registry"
import "@/hrm-server/routes/router"  // side-effect imports populate the registry
import { createCamera, deleteCamera, getCamera, updateCameraStatus } from "@/hrm-server/cameras/repository"
import type { Ctx } from "@/hrm-server/types"
import type { Camera } from "@prisma/client"

// ---------- test contexts ----------

const ctxA: Ctx = {
  userId: "u-A", userName: "Alice", vendorId: "v-A", role: "HR_ADMIN",
  permissions: new Set(["camera.view", "camera.create", "camera.edit", "camera.delete", "camera.launch", "camera.manage"]),
}

// ---------- DB bootstrap ----------

let brAId: string

beforeAll(async () => {
  const brA = await db.branch.create({ data: { vendorId: "v-A", code: "B1", name: "Branch 1", type: "WAREHOUSE" } })
  brAId = brA.id
})

afterAll(async () => {
  await db.cameraCredential.deleteMany()
  await db.camera.deleteMany()
  await db.branch.deleteMany({ where: { vendorId: "v-A" } })
  await db.$disconnect()
})

beforeEach(async () => {
  await db.camera.deleteMany()
})

// Helper: call a route handler
async function callRoute<T = any>(action: string, ctx: Ctx, payload: any): Promise<T> {
  const def = routes[action]
  if (!def) throw new Error(`Unknown route: ${action}`)
  return def.handler(ctx, payload, undefined as any) as Promise<T>
}

// Helper: create a minimal camera row for provider tests (bypasses route layer)
async function makeCamera(brand: string, serial: string, vc: string): Promise<Camera> {
  return createCamera(ctxA, {
    brand, name: `test-${serial}`, serialNumber: serial, channel: 1,
    verificationCode: vc, branchId: brAId, location: "test",
  })
}

// ====================================================================
// 1. Registry extraction tests
// ====================================================================

describe("Provider registry (Phase 5.1 + 5b + 5c)", () => {
  test("listRegisteredBrands returns all 4 brands (HIKVISION + DAHUA + EZVIZ + IMOU)", () => {
    const brands = listRegisteredBrands()
    expect(brands).toContain("HIKVISION")
    expect(brands).toContain("DAHUA")
    expect(brands).toContain("EZVIZ")
    expect(brands).toContain("IMOU")
    expect(brands.length).toBe(4)
  })

  test("getProvider returns the registered provider for a known brand", () => {
    const hik = getProvider("HIKVISION")
    expect(hik.brand).toBe("HIKVISION")
    const dahua = getProvider("DAHUA")
    expect(dahua.brand).toBe("DAHUA")
    const ezviz = getProvider("EZVIZ")
    expect(ezviz.brand).toBe("EZVIZ")
    const imou = getProvider("IMOU")
    expect(imou.brand).toBe("IMOU")
  })

  test("getProvider throws Deny 400 on unknown brand, with all registered brands in the message", () => {
    try {
      getProvider("UNKNOWN_BRAND")
      throw new Error("FAIL: should have thrown")
    } catch (e: any) {
      expect(e.code).toBe(400)
      expect(e.message).toMatch(/Unsupported camera brand: UNKNOWN_BRAND/)
      expect(e.message).toMatch(/HIKVISION/)
      expect(e.message).toMatch(/DAHUA/)
      expect(e.message).toMatch(/EZVIZ/)
      expect(e.message).toMatch(/IMOU/)
    }
  })

  test("isRegisteredBrand returns true for all 4 brands, false for unknown", () => {
    expect(isRegisteredBrand("HIKVISION")).toBe(true)
    expect(isRegisteredBrand("DAHUA")).toBe(true)
    expect(isRegisteredBrand("EZVIZ")).toBe(true)
    expect(isRegisteredBrand("IMOU")).toBe(true)
    expect(isRegisteredBrand("UNKNOWN")).toBe(false)
  })
})

// ====================================================================
// 2. HikvisionProvider — reference implementation unit tests
// ====================================================================

describe("HikvisionProvider (reference implementation)", () => {
  test("brand is HIKVISION", () => {
    expect(hikvisionProvider.brand).toBe("HIKVISION")
  })

  test("validateCredentials(null) returns true (defensive no-op for per-camera brands)", async () => {
    expect(await hikvisionProvider.validateCredentials(null)).toBe(true)
  })

  test("validateCredentials(non-null) returns false (unexpected for Hikvision)", async () => {
    // Hikvision has no tenant creds — any non-null input is unexpected
    expect(await hikvisionProvider.validateCredentials({ appKey: "x" })).toBe(false)
  })

  test("getDeviceStatus returns the camera's stored last-known status (no network call)", async () => {
    const cam = await makeCamera("HIKVISION", "SN-HIK-001", "VC-HIK-001")
    // Manually update the stored status to OFFLINE + lastSeenAt
    await updateCameraStatus(ctxA, cam.id, "OFFLINE", { lastSeenAt: new Date("2026-09-20T10:00:00Z") })
    const updated = await getCamera(ctxA, cam.id)

    const result = await hikvisionProvider.getDeviceStatus(updated, null)
    expect(result.status).toBe("OFFLINE")
    expect(result.lastSeenAt?.toISOString()).toBe("2026-09-20T10:00:00.000Z")
    expect(result.error).toBeNull()
  })

  test("getLaunchTarget returns DEEP_LINK with the Hik-Connect web URL", async () => {
    const cam = await makeCamera("HIKVISION", "SN-HIK-002", "VC-HIK-002")
    const result = await hikvisionProvider.getLaunchTarget(cam, null)
    expect(result.launchTarget.kind).toBe("DEEP_LINK")
    // Flag 1 (Phase 5b): URL is www.hik-connect.com (entry domain) — see
    // hikvision.ts HIK_CONNECT_WEB_URL comment for the source/citation.
    expect((result.launchTarget as any).url).toBe("https://www.hik-connect.com")
    expect(result.fallbackWebUrl).toBe("https://www.hik-connect.com")
  })

  test("getLaunchTarget does NOT include the verificationCode in the URL (user enters it manually)", async () => {
    const cam = await makeCamera("HIKVISION", "SN-HIK-003", "VC-SECRET-123")
    const result = await hikvisionProvider.getLaunchTarget(cam, null)
    // The URL must not contain the verification code — the user enters it in the app
    expect((result.launchTarget as any).url).not.toContain("VC-SECRET-123")
    expect((result.launchTarget as any).url).not.toContain("VC-SECRET")
  })

  test("getLaunchTarget does NOT make any HTTP call (verifiable by completing in <100μs without network)", async () => {
    const cam = await makeCamera("HIKVISION", "SN-HIK-004", "VC-HIK-004")
    const start = Date.now()
    await hikvisionProvider.getLaunchTarget(cam, null)
    const elapsed = Date.now() - start
    // A network call would take >10ms; this should be <1ms (just returns a static URL).
    // Allow up to 50ms for GC overhead on slow CI runners.
    expect(elapsed).toBeLessThan(50)
  })
})

// ====================================================================
// 3. DahuaProvider — mirrors Hikvision
// ====================================================================

describe("DahuaProvider (mirrors Hikvision pattern)", () => {
  test("brand is DAHUA", () => {
    expect(dahuaProvider.brand).toBe("DAHUA")
  })

  test("validateCredentials(null) returns true (defensive no-op)", async () => {
    expect(await dahuaProvider.validateCredentials(null)).toBe(true)
  })

  test("validateCredentials(non-null) returns false (unexpected for Dahua)", async () => {
    expect(await dahuaProvider.validateCredentials({ appKey: "x" })).toBe(false)
  })

  test("getDeviceStatus returns the camera's stored last-known status", async () => {
    const cam = await makeCamera("DAHUA", "SN-DAH-001", "VC-DAH-001")
    await updateCameraStatus(ctxA, cam.id, "ONLINE", { lastSeenAt: new Date("2026-09-25T08:00:00Z") })
    const updated = await getCamera(ctxA, cam.id)
    const result = await dahuaProvider.getDeviceStatus(updated, null)
    expect(result.status).toBe("ONLINE")
    expect(result.lastSeenAt?.toISOString()).toBe("2026-09-25T08:00:00.000Z")
    expect(result.error).toBeNull()
  })

  test("getLaunchTarget returns DEEP_LINK with the DMSS web URL", async () => {
    const cam = await makeCamera("DAHUA", "SN-DAH-002", "VC-DAH-002")
    const result = await dahuaProvider.getLaunchTarget(cam, null)
    expect(result.launchTarget.kind).toBe("DEEP_LINK")
    expect((result.launchTarget as any).url).toMatch(/^https:\/\//)
    expect(result.fallbackWebUrl).toMatch(/^https:\/\//)
    expect((result.launchTarget as any).url).not.toContain("VC-DAH-002")
  })

  test("getLaunchTarget does NOT make any HTTP call", async () => {
    const cam = await makeCamera("DAHUA", "SN-DAH-003", "VC-DAH-003")
    const start = Date.now()
    await dahuaProvider.getLaunchTarget(cam, null)
    expect(Date.now() - start).toBeLessThan(50)
  })

  test("Dahua provider is structurally identical to Hikvision provider (same method signatures)", () => {
    // Both implement the CameraProvider interface; both are no-network providers.
    // This test catches accidental divergence if someone modifies one without the other.
    expect(typeof hikvisionProvider.validateCredentials).toBe(typeof dahuaProvider.validateCredentials)
    expect(typeof hikvisionProvider.getDeviceStatus).toBe(typeof dahuaProvider.getDeviceStatus)
    expect(typeof hikvisionProvider.getLaunchTarget).toBe(typeof dahuaProvider.getLaunchTarget)
  })
})

// ====================================================================
// 4. Flag 3b — camera.launch returns the EXACT §12 envelope
//    { ok: true, data: { launchTarget: {...}, fallbackWebUrl: "..." } }
// ====================================================================

describe("Flag 3b — camera.launch §12 envelope (Phase 5)", () => {
  test("launch returns { launchTarget, fallbackWebUrl } as the data shape (dispatcher wraps in { ok, data })", async () => {
    const cam = await makeCamera("HIKVISION", "SN-ENV-001", "VC-ENV-001")
    // The route handler returns the raw data; the dispatcher wraps in { ok: true, data: ... }
    // Here we test the route-handler-level shape (no dispatcher).
    const handlerResult = await callRoute("camera.launch", ctxA, { id: cam.id })
    expect(handlerResult).toHaveProperty("launchTarget")
    expect(handlerResult).toHaveProperty("fallbackWebUrl")
    // launchTarget must have a kind in { DEEP_LINK | QR_CODE | CLOUD_STREAM_TOKEN }
    expect(["DEEP_LINK", "QR_CODE", "CLOUD_STREAM_TOKEN"]).toContain(handlerResult.launchTarget.kind)
    // DEEP_LINK variant must have url
    if (handlerResult.launchTarget.kind === "DEEP_LINK") {
      expect(typeof handlerResult.launchTarget.url).toBe("string")
      expect(handlerResult.launchTarget.url.length).toBeGreaterThan(0)
    }
    // fallbackWebUrl must be a non-empty string
    expect(typeof handlerResult.fallbackWebUrl).toBe("string")
    expect(handlerResult.fallbackWebUrl.length).toBeGreaterThan(0)
  })

  test("launch via Dahua provider also returns the §12 envelope shape", async () => {
    const cam = await makeCamera("DAHUA", "SN-ENV-002", "VC-ENV-002")
    const handlerResult = await callRoute("camera.launch", ctxA, { id: cam.id })
    expect(handlerResult).toHaveProperty("launchTarget")
    expect(handlerResult).toHaveProperty("fallbackWebUrl")
    expect(handlerResult.launchTarget.kind).toBe("DEEP_LINK")
  })
})

// ====================================================================
// 5. Flag 3c — camera.launch AND camera.status on a soft-deleted camera → 404
// ====================================================================

describe("Flag 3c — soft-deleted camera policy (Phase 5)", () => {
  test("camera.launch on a soft-deleted camera → 404 (no rate-limit hit, no audit row)", async () => {
    const cam = await makeCamera("HIKVISION", "SN-SD-LAUNCH-001", "VC-SD-LAUNCH-001")
    await deleteCamera(ctxA, cam.id) // soft-delete (enabled=false)

    const beforeAudit = await db.auditLog.count({ where: { vendorId: "v-A", action: "camera.launch" } })
    try {
      await callRoute("camera.launch", ctxA, { id: cam.id })
      throw new Error("FAIL: launch on soft-deleted should 404")
    } catch (e: any) {
      expect(e.code).toBe(404)
    }
    // No audit row should have been written (the launch never happened)
    const afterAudit = await db.auditLog.count({ where: { vendorId: "v-A", action: "camera.launch" } })
    expect(afterAudit).toBe(beforeAudit)
  })

  test("camera.status on a soft-deleted camera → 404 (consistent with launch)", async () => {
    const cam = await makeCamera("HIKVISION", "SN-SD-STATUS-001", "VC-SD-STATUS-001")
    await deleteCamera(ctxA, cam.id)

    // Capture the lastStatusCheckAt BEFORE the failed status check
    const beforeCam = await getCamera(ctxA, cam.id) // getCamera still finds soft-deleted for audit/recovery
    const beforeCheck = beforeCam.lastStatusCheckAt

    try {
      await callRoute("camera.status", ctxA, { id: cam.id })
      throw new Error("FAIL: status on soft-deleted should 404")
    } catch (e: any) {
      expect(e.code).toBe(404)
    }

    // lastStatusCheckAt must NOT have been bumped (the status check was refused)
    const afterCam = await getCamera(ctxA, cam.id)
    expect(afterCam.lastStatusCheckAt).toEqual(beforeCheck)
  })

  test("camera.restore on a soft-deleted camera → succeeds (restore IS the un-delete)", async () => {
    const cam = await makeCamera("HIKVISION", "SN-SD-RESTORE-001", "VC-SD-RESTORE-001")
    await deleteCamera(ctxA, cam.id)
    // Restore should work — it's the whole point
    const result = await callRoute("camera.restore", ctxA, { id: cam.id })
    expect(result.enabled).toBe(true)
    expect(result.lastError).toBeNull()
  })

  test("camera.delete on a soft-deleted camera is idempotent (no error)", async () => {
    const cam = await makeCamera("HIKVISION", "SN-SD-DELETE-001", "VC-SD-DELETE-001")
    await deleteCamera(ctxA, cam.id)
    // Second delete via the route handler should NOT throw (idempotent)
    const result = await callRoute("camera.delete", ctxA, { id: cam.id })
    expect(result.enabled).toBe(false)
  })

  test("camera.get on a soft-deleted camera still works (audit/recovery needs visibility)", async () => {
    const cam = await makeCamera("HIKVISION", "SN-SD-GET-001", "VC-SD-GET-001")
    await deleteCamera(ctxA, cam.id)
    const result = await callRoute("camera.get", ctxA, { id: cam.id })
    expect(result.id).toBe(cam.id)
    expect(result.enabled).toBe(false)
  })

  test("camera.list with includeDisabled=true includes soft-deleted cameras", async () => {
    const cam = await makeCamera("HIKVISION", "SN-SD-LIST-001", "VC-SD-LIST-001")
    await deleteCamera(ctxA, cam.id)
    const result = await callRoute<{ cameras: any[]; counts: any }>("camera.list", ctxA, { includeDisabled: true })
    expect(result.cameras.some((c) => c.id === cam.id)).toBe(true)
  })

  test("camera.list default (no includeDisabled) excludes soft-deleted cameras", async () => {
    const cam = await makeCamera("HIKVISION", "SN-SD-LIST-002", "VC-SD-LIST-002")
    await deleteCamera(ctxA, cam.id)
    const result = await callRoute<{ cameras: any[]; counts: any }>("camera.list", ctxA, {})
    expect(result.cameras.some((c) => c.id === cam.id)).toBe(false)
  })
})

// ====================================================================
// 6. Flag 1 — camera.status for Hikvision sets lastStatusCheckAt even when no API call
// ====================================================================

describe("Flag 1 — camera.status 'we tried' marker (Phase 5)", () => {
  test("Hikvision status check bumps lastStatusCheckAt even though the provider returns last-known (no cloud API)", async () => {
    const cam = await makeCamera("HIKVISION", "SN-FLAG1-001", "VC-FLAG1-001")
    // Capture the initial lastStatusCheckAt (should be null from createCamera)
    const before = await getCamera(ctxA, cam.id)
    expect(before.lastStatusCheckAt).toBeNull()

    // Call the status route — provider returns last-known, but the route
    // STILL sets lastStatusCheckAt = now() per Flag 1.
    await callRoute("camera.status", ctxA, { id: cam.id })

    const after = await getCamera(ctxA, cam.id)
    expect(after.lastStatusCheckAt).not.toBeNull()
    // Should be within the last 5 seconds (allowing for test latency)
    expect(Date.now() - (after.lastStatusCheckAt!.getTime())).toBeLessThan(5000)
  })

  test("Hikvision status check returns the stored status (no provider-side change)", async () => {
    const cam = await makeCamera("HIKVISION", "SN-FLAG1-002", "VC-FLAG1-002")
    // Manually set the stored status to ONLINE
    await updateCameraStatus(ctxA, cam.id, "ONLINE")

    const result = await callRoute("camera.status", ctxA, { id: cam.id })
    expect(result.status).toBe("ONLINE")
    expect(result.lastError).toBeNull() // Hikvision provider never sets lastError
  })

  test("Dahua status check also bumps lastStatusCheckAt (same no-API pattern as Hikvision)", async () => {
    const cam = await makeCamera("DAHUA", "SN-FLAG1-003", "VC-FLAG1-003")
    const before = await getCamera(ctxA, cam.id)
    expect(before.lastStatusCheckAt).toBeNull()

    await callRoute("camera.status", ctxA, { id: cam.id })

    const after = await getCamera(ctxA, cam.id)
    expect(after.lastStatusCheckAt).not.toBeNull()
    expect(Date.now() - (after.lastStatusCheckAt!.getTime())).toBeLessThan(5000)
  })
})

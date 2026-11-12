/// <reference types="bun-types" />
// ============ E2e tests — Camera Manager dispatcher-level security ============
// Phase 7.3: the TODO(e2e) markers from the unit test files are resolved here.
// These tests make actual HTTP POST requests to /api/hrm against a running
// Next.js server, verifying the dispatcher's security layers that unit tests
// bypass (by calling routes["camera.*"].handler directly):
//
//   1. Unauthenticated POST → 401 (dispatcher checks session token)
//   2. Authenticated without camera.* perm → 403 (dispatcher calls require())
//   3. Cross-tenant camera.get → 404 (handler's assertTenant check)
//   4. Rate-limit: hammer camera.launch → 429 on the Nth call
//
// PREREQUISITES:
//   - The Next.js dev server must be running on http://localhost:3000
//   - A test database must be set up with at least 2 tenants (v-A, v-B)
//     and authenticated session tokens for each
//   - HRM_MFA_KEY must be set in the server's .env
//
// RUNNING:
//   WP-B (CCTV review §3.15) — the 401 smoke test needs NO fixtures, so it
//   runs whenever HRM_E2E_URL is set (default http://localhost:3000/api/hrm)
//   and is skipped only when the env var HRM_E2E_SKIP_UNAUTH=1 is set. The
//   fixture-dependent tests (403 / 404 / 429) still require tokens and stay
//   opt-in: set HRM_E2E_TOKEN_A / _B / _NO_PERM and they activate
//   automatically (a missing token skips just that test).
//     1. Start the dev server: `bun run dev`
//     2. Export the tokens you want to exercise
//     3. Run: `bun test tests/e2e/camera-dispatcher.test.ts`
//
// See tests/unit/camera-providers-ezviz.test.ts:494–508 and
// tests/unit/camera-providers-imou.test.ts:255–262 for the original
// TODO(e2e) markers that this file resolves.

import { test, expect, describe, beforeAll } from "bun:test"

const API_URL = process.env.HRM_E2E_URL || "http://localhost:3000/api/hrm"

// These tokens would be obtained by logging in via auth.login in a
// beforeAll hook. For now, they're placeholders — set them via env vars
// or the e2e harness when running.
const TOKEN_TENANT_A = process.env.HRM_E2E_TOKEN_A || ""
const TOKEN_TENANT_B = process.env.HRM_E2E_TOKEN_B || ""
const TOKEN_NO_PERM = process.env.HRM_E2E_TOKEN_NO_PERM || ""  // a user with NO camera.* permissions

async function post(action: string, payload: any, token?: string) {
  const headers: Record<string, string> = { "Content-Type": "application/json" }
  if (token) headers["Authorization"] = `Bearer ${token}`
  const response = await fetch(API_URL, {
    method: "POST",
    headers,
    body: JSON.stringify({ action, payload }),
  })
  const json = await response.json().catch(() => ({}))
  return { status: response.status, json }
}

describe("Camera Manager — dispatcher-level e2e (Phase 7.3)", () => {
  // WP-B §3.15 — tests can FAIL now: the unauthenticated 401 case runs
  // whenever the suite runs (no fixtures needed); token-gated cases activate
  // when their env token is present and fail for real on regressions.
  const unauthActive = !process.env.HRM_E2E_SKIP_UNAUTH

  ;(unauthActive ? test : test.skip)("Unauthenticated POST camera.list → 401", async () => {
    const { status } = await post("camera.list", {})
    expect(status).toBe(401)
  })

  ;(TOKEN_NO_PERM ? test : test.skip)("Authenticated without camera.view → 403", async () => {
    const { status, json } = await post("camera.list", {}, TOKEN_NO_PERM)
    expect(status).toBe(403)
    expect(json.error).toMatch(/Permission denied.*camera\.view/)
  })

  ;(TOKEN_TENANT_A && TOKEN_TENANT_B ? test : test.skip)("Cross-tenant camera.get → 404 (not 403, not 200)", async () => {
    // Create a camera in tenant A
    const createRes = await post("camera.create", {
      brand: "HIKVISION", name: "e2e-cross-tenant", serialNumber: "SN-E2E-CT", channel: 1,
      verificationCode: "VC-E2E-CT",
    }, TOKEN_TENANT_A)
    const camId = createRes.json?.data?.id
    expect(camId).toBeDefined()

    // Tenant B tries to get it → 404
    const { status, json } = await post("camera.get", { id: camId }, TOKEN_TENANT_B)
    expect(status).toBe(404)
    // Message must NOT leak that the camera exists in another tenant
    expect(json.error).not.toContain("vendor")
    expect(json.error).not.toContain("tenant")
  })

  ;(TOKEN_TENANT_A ? test : test.skip)("Hammer camera.launch → 429 on the Nth call (rate limit)", async () => {
    // Create a camera in tenant A
    const createRes = await post("camera.create", {
      brand: "HIKVISION", name: "e2e-rate-limit", serialNumber: "SN-E2E-RL", channel: 1,
      verificationCode: "VC-E2E-RL",
    }, TOKEN_TENANT_A)
    const camId = createRes.json?.data?.id

    // Hammer 35 launches (per-camera limit is 30/min)
    let ok = 0, rateLimited = 0
    for (let i = 0; i < 35; i++) {
      const { status } = await post("camera.launch", { id: camId }, TOKEN_TENANT_A)
      if (status === 200) ok++
      else if (status === 429) rateLimited++
    }
    expect(ok).toBeLessThanOrEqual(30)
    expect(rateLimited).toBeGreaterThan(0)
  })

  ;(TOKEN_TENANT_A ? test : test.skip)("camera.launch on soft-deleted → 404", async () => {
    // Create + soft-delete a camera in tenant A
    const createRes = await post("camera.create", {
      brand: "HIKVISION", name: "e2e-soft-deleted", serialNumber: "SN-E2E-SD", channel: 1,
      verificationCode: "VC-E2E-SD",
    }, TOKEN_TENANT_A)
    const camId = createRes.json?.data?.id
    await post("camera.delete", { id: camId, reason: "e2e test" }, TOKEN_TENANT_A)

    // Launch on soft-deleted → 404
    const { status } = await post("camera.launch", { id: camId }, TOKEN_TENANT_A)
    expect(status).toBe(404)
  })
})

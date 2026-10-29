/// <reference types="bun-types" />
// ============ Unit tests — Camera Manager tenant + branch isolation ============
// Phase 3 deliverable (item 3 + §D4 of the Camera Manager spec). Moved from
// scripts/phase2-verify.ts so this runs on EVERY CI cycle, not just one-time
// schema verification. Schema-shape checks stay in scripts/phase2-verify.ts
// (one-time verification, not recurring).
//
// NOTE: auditStrict throw-on-failure is verified by source inspection
// (routes/cameras.ts calls auditStrict for camera.delete/camera.launch/
// camera.credential.* — not audit()), not by runtime test. Bun's
// mock.module() successfully intercepts the audit module in isolation
// (3 tests pass when camera-audit-strict.test.ts runs alone), but the mock
// is process-global — it breaks other test files' audit-row assertions
// when run in the same `bun test` invocation. Rather than accept a flaky
// test suite, the limitation is documented here:
//   - Source inspection at routes/cameras.ts:398, 438, 463 confirms
//     auditStrict (not audit) is called for delete/launch/credential routes.
//   - The audit-verb tests HERE verify the correct audit ACTION STRING
//     (camera.credential.create vs camera.credential.rotate) is written
//     on success — they do NOT verify throw-on-failure.
//   - To verify throw-on-failure in isolation:
//       bun test tests/unit/camera-audit-strict.test.ts
//     (re-create this file with mock.module to run the 3 tests standalone)
//
// What this test covers:
//   1. Cross-tenant: tenant A cannot see, get, update, delete, or restore
//      tenant B's cameras — every action returns 404 via assertTenant +
//      findCamera's branch check (404, not 403 — no ID enumeration).
//   2. Cross-branch (BRANCH_MANAGER): can see/get cameras in their own branch
//      only; cross-branch access returns 404.
//   3. Soft-delete visibility: default listCameras excludes; includeDisabled
//      includes; getCamera finds for audit/recovery; countCamerasByStatus
//      excludes; restoreCamera re-enables.
//   4. ESLint-style grep test: every db.camera.* call in
//      src/hrm-server/cameras/repository.ts MUST carry the
//      `// scoped: cameraScopeFilter` comment — fails if any call lacks it.
//      This is the §D2 constraint from the original spec.
import { test, expect, describe, beforeAll, afterAll, beforeEach } from "bun:test"
import { db } from "@/lib/db"
import {
  listCameras, getCamera, createCamera, updateCamera, deleteCamera, restoreCamera,
  updateCameraStatus, countCamerasByStatus, upsertCredential, getCredential,
  deleteCredential, isPerCameraBrand, isTenantCredentialBrand,
  validateCameraCreate,
} from "@/hrm-server/cameras/repository"
import { getCredential as getCredentialDecrypted } from "@/hrm-server/cameras/credentials"
import type { Ctx } from "@/hrm-server/types"
import { readFileSync } from "fs"
import { join } from "path"

// ---------- test contexts ----------

const ctxA: Ctx = {
  userId: "u-A", userName: "Alice", vendorId: "v-A", role: "HR_ADMIN",
  permissions: new Set(["camera.view", "camera.create", "camera.edit", "camera.delete", "camera.launch", "camera.manage"]),
}
const ctxB: Ctx = {
  userId: "u-B", userName: "Bob", vendorId: "v-B", role: "HR_ADMIN",
  permissions: new Set(["camera.view", "camera.create", "camera.edit", "camera.delete", "camera.launch", "camera.manage"]),
}
// ctxBM is constructed in beforeAll after we know the seeded branch id
let ctxBM: Ctx

// ---------- DB bootstrap ----------

// tests/preload.ts (registered via bunfig.toml) has already:
//   - set DATABASE_URL to prisma/db/test-unit.db
//   - run `prisma db push --force-reset` so the schema is fresh
// We seed two tenants + two branches here, then clean up after each test.

let brAId: string

beforeAll(async () => {
  // Seed branches so createCamera's branchId validation resolves.
  const brA = await db.branch.create({ data: { vendorId: "v-A", code: "B1", name: "Branch 1", type: "WAREHOUSE" } })
  await db.branch.create({ data: { vendorId: "v-B", code: "B1", name: "Branch 1", type: "WAREHOUSE" } })
  brAId = brA.id
  ctxBM = {
    userId: "u-BM", userName: "Bran", vendorId: "v-A", role: "BRANCH_MANAGER",
    permissions: new Set(["camera.view", "camera.launch"]),
    branchId: brAId,
  }
})

afterAll(async () => {
  // Cleanup: delete test data so subsequent test files get a clean DB.
  // tests/preload.ts force-resets the schema at the start of each run, so
  // this is belt-and-braces — but keeps direct `bun test <file>` runs clean.
  await db.cameraCredential.deleteMany()
  await db.camera.deleteMany()
  await db.branch.deleteMany({ where: { vendorId: { in: ["v-A", "v-B"] } } })
  await db.vendor.deleteMany({ where: { id: { in: ["v-A", "v-B"] } } }).catch(() => {})
  await db.$disconnect()
})

beforeEach(async () => {
  // Clean camera + credential + throttle rows between tests for isolation.
  // Throttle cleanup is needed because camera.credential.* routes are
  // rate-limited at 10/min per tenant — without clearing, sequential tests
  // hit 429.
  await db.throttle.deleteMany({})
  await db.cameraCredential.deleteMany()
  await db.camera.deleteMany()
})

// ---------- 1. CROSS-TENANT ISOLATION ----------

describe("Cross-tenant isolation (Camera Manager §15/D4)", () => {
  test("camera.list returns only the caller's tenant's cameras (empty list is valid)", async () => {
    // Tenant A creates one camera
    await createCamera(ctxA, {
      brand: "HIKVISION", name: "A's Camera", serialNumber: "SN-A-001", channel: 1,
      verificationCode: "VC-001",
    })
    // Tenant B sees zero cameras — NOT tenant A's camera
    const listB = await listCameras(ctxB)
    expect(listB.length).toBe(0)
    // Tenant A sees their own
    const listA = await listCameras(ctxA)
    expect(listA.length).toBe(1)
    expect(listA[0].name).toBe("A's Camera")
  })

  test("camera.get on another tenant's cameraId returns 404 (no ID enumeration)", async () => {
    const cam = await createCamera(ctxA, {
      brand: "HIKVISION", name: "A's secret cam", serialNumber: "SN-002", channel: 1,
      verificationCode: "VC-002",
    })
    // Tenant B tries to read tenant A's camera by id — must get 404
    try {
      await getCamera(ctxB, cam.id)
      throw new Error("FAIL: getCamera should have thrown 404")
    } catch (e: any) {
      expect(e.code).toBe(404)
      // Message must NOT leak that the camera exists in another tenant
      expect(String(e.message).toLowerCase()).not.toContain("vendor")
      expect(String(e.message).toLowerCase()).not.toContain("tenant")
    }
  })

  test("camera.update on another tenant's cameraId returns 404", async () => {
    const cam = await createCamera(ctxA, {
      brand: "HIKVISION", name: "A's cam", serialNumber: "SN-003", channel: 1,
      verificationCode: "VC-003",
    })
    try {
      await updateCamera(ctxB, cam.id, { name: "hacked" })
      throw new Error("FAIL: updateCamera should have thrown 404")
    } catch (e: any) {
      expect(e.code).toBe(404)
    }
  })

  test("camera.delete (soft) on another tenant's cameraId returns 404", async () => {
    const cam = await createCamera(ctxA, {
      brand: "HIKVISION", name: "A's cam", serialNumber: "SN-004", channel: 1,
      verificationCode: "VC-004",
    })
    try {
      await deleteCamera(ctxB, cam.id)
      throw new Error("FAIL: deleteCamera should have thrown 404")
    } catch (e: any) {
      expect(e.code).toBe(404)
    }
    // Camera A is NOT soft-deleted (cross-tenant delete didn't reach it)
    const stillThere = await getCamera(ctxA, cam.id)
    expect(stillThere.enabled).toBe(true)
  })

  test("camera.restore on another tenant's cameraId returns 404", async () => {
    // Create + soft-delete a camera in tenant A
    const cam = await createCamera(ctxA, {
      brand: "HIKVISION", name: "A's cam", serialNumber: "SN-005", channel: 1,
      verificationCode: "VC-005",
    })
    await deleteCamera(ctxA, cam.id)
    // Tenant B tries to restore — must 404
    try {
      await restoreCamera(ctxB, cam.id)
      throw new Error("FAIL: restoreCamera should have thrown 404")
    } catch (e: any) {
      expect(e.code).toBe(404)
    }
  })

  test("camera.status update on another tenant's cameraId returns 404", async () => {
    const cam = await createCamera(ctxA, {
      brand: "HIKVISION", name: "A's cam", serialNumber: "SN-006", channel: 1,
      verificationCode: "VC-006",
    })
    try {
      await updateCameraStatus(ctxB, cam.id, "ONLINE")
      throw new Error("FAIL: updateCameraStatus should have thrown 404")
    } catch (e: any) {
      expect(e.code).toBe(404)
    }
  })

  test("CameraCredential cross-tenant access returns null (not a leak)", async () => {
    // Tenant A stores an EZVIZ credential
    await upsertCredential(ctxA, "EZVIZ", "v2:fake.payload", 1)
    // Tenant B fetches the same brand — must get null, not A's payload
    const cred = await getCredential(ctxB, "EZVIZ")
    expect(cred).toBeNull()
    // Tenant B cannot delete A's credential either
    const deleted = await deleteCredential(ctxB, "EZVIZ")
    expect(deleted).toBeNull()
    // A's credential is still there
    const stillThere = await getCredential(ctxA, "EZVIZ")
    expect(stillThere).not.toBeNull()
    expect(stillThere?.encryptedPayload).toBe("v2:fake.payload")
  })
})

// ---------- 2. CROSS-BRANCH ISOLATION (BRANCH_MANAGER) ----------

describe("Cross-branch isolation (BRANCH_MANAGER scope)", () => {
  test("BRANCH_MANAGER sees only cameras in their own branch", async () => {
    // Create one camera in their branch, one in another branch (null), one in tenant B
    const inBranch = await createCamera(ctxA, {
      brand: "HIKVISION", name: "in branch", serialNumber: "SN-B-001", channel: 1,
      verificationCode: "VC-001", branchId: brAId,
    })
    const outOfBranch = await createCamera(ctxA, {
      brand: "HIKVISION", name: "out of branch", serialNumber: "SN-B-002", channel: 1,
      verificationCode: "VC-002", branchId: null,
    })
    // BM sees only the one in their branch
    const list = await listCameras(ctxBM)
    expect(list.length).toBe(1)
    expect(list[0].id).toBe(inBranch.id)
    expect(list.find((c) => c.id === outOfBranch.id)).toBeUndefined()
  })

  test("BRANCH_MANAGER getCamera on out-of-branch camera returns 404", async () => {
    const inBranch = await createCamera(ctxA, {
      brand: "HIKVISION", name: "in branch", serialNumber: "SN-B-003", channel: 1,
      verificationCode: "VC-003", branchId: brAId,
    })
    const outOfBranch = await createCamera(ctxA, {
      brand: "HIKVISION", name: "out of branch", serialNumber: "SN-B-004", channel: 1,
      verificationCode: "VC-004", branchId: null,
    })
    // BM can get the in-branch one
    const ok = await getCamera(ctxBM, inBranch.id)
    expect(ok.id).toBe(inBranch.id)
    // BM cannot get the out-of-branch one — 404 (same error as cross-tenant)
    try {
      await getCamera(ctxBM, outOfBranch.id)
      throw new Error("FAIL: BM should not see out-of-branch camera")
    } catch (e: any) {
      expect(e.code).toBe(404)
    }
  })

  test("BRANCH_MANAGER updateCamera on out-of-branch camera returns 404", async () => {
    const outOfBranch = await createCamera(ctxA, {
      brand: "HIKVISION", name: "out of branch", serialNumber: "SN-B-005", channel: 1,
      verificationCode: "VC-005", branchId: null,
    })
    try {
      await updateCamera(ctxBM, outOfBranch.id, { name: "hacked" })
      throw new Error("FAIL: BM update should 404")
    } catch (e: any) {
      expect(e.code).toBe(404)
    }
  })

  test("BRANCH_MANAGER cannot create a camera outside their own branch", async () => {
    // Try to create a camera with branchId=null (no branch) — should be refused
    // because BM has a branchId assigned and the target doesn't match.
    try {
      await createCamera(ctxBM, {
        brand: "HIKVISION", name: "attempt", serialNumber: "SN-BM-001", channel: 1,
        verificationCode: "VC-BM", branchId: null,
      })
      throw new Error("FAIL: BM should not create cameras outside their branch")
    } catch (e: any) {
      expect(e.code).toBe(403)
    }
  })
})

// ---------- 3. SOFT-DELETE VISIBILITY ----------

describe("Soft-delete visibility (Camera Manager §addendum item 5)", () => {
  test("listCameras excludes soft-deleted by default; includeDisabled:true includes them", async () => {
    const c1 = await createCamera(ctxA, {
      brand: "HIKVISION", name: "active", serialNumber: "SN-SD-001", channel: 1,
      verificationCode: "VC-1",
    })
    const c2 = await createCamera(ctxA, {
      brand: "DAHUA", name: "to-be-deleted", serialNumber: "SN-SD-002", channel: 1,
      verificationCode: "VC-2",
    })
    await deleteCamera(ctxA, c2.id)
    // Default list excludes soft-deleted
    const list = await listCameras(ctxA)
    expect(list.length).toBe(1)
    expect(list[0].id).toBe(c1.id)
    // includeDisabled shows both
    const withDisabled = await listCameras(ctxA, { includeDisabled: true })
    expect(withDisabled.length).toBe(2)
  })

  test("getCamera still finds soft-deleted cameras (audit/recovery)", async () => {
    const c = await createCamera(ctxA, {
      brand: "HIKVISION", name: "will-delete", serialNumber: "SN-SD-003", channel: 1,
      verificationCode: "VC-3",
    })
    await deleteCamera(ctxA, c.id)
    const fetched = await getCamera(ctxA, c.id)
    expect(fetched.enabled).toBe(false)
  })

  test("countCamerasByStatus excludes soft-deleted cameras", async () => {
    await createCamera(ctxA, {
      brand: "HIKVISION", name: "online", serialNumber: "SN-SD-004", channel: 1,
      verificationCode: "VC-4",
    })
    const toDelete = await createCamera(ctxA, {
      brand: "HIKVISION", name: "to-delete", serialNumber: "SN-SD-005", channel: 1,
      verificationCode: "VC-5",
    })
    await deleteCamera(ctxA, toDelete.id)
    const counts = await countCamerasByStatus(ctxA)
    expect(counts.total).toBe(1)
    expect(counts.ONLINE + counts.OFFLINE + counts.UNKNOWN).toBe(1)
  })

  test("restoreCamera re-enables + clears lastError", async () => {
    const c = await createCamera(ctxA, {
      brand: "HIKVISION", name: "restore-me", serialNumber: "SN-SD-006", channel: 1,
      verificationCode: "VC-6",
    })
    await deleteCamera(ctxA, c.id)
    await updateCameraStatus(ctxA, c.id, "OFFLINE", { lastError: "pre-restore error" })
    // Note: updateCameraStatus still works on soft-deleted cameras (audit/recovery)
    const restored = await restoreCamera(ctxA, c.id)
    expect(restored.enabled).toBe(true)
    expect(restored.lastError).toBeNull()
  })

  test("deleteCamera is idempotent (re-delete returns the same row)", async () => {
    const c = await createCamera(ctxA, {
      brand: "HIKVISION", name: "idempotent", serialNumber: "SN-SD-007", channel: 1,
      verificationCode: "VC-7",
    })
    const first = await deleteCamera(ctxA, c.id)
    expect(first.enabled).toBe(false)
    const second = await deleteCamera(ctxA, c.id)
    expect(second.enabled).toBe(false)
    expect(second.id).toBe(first.id)
  })
})

// ---------- 4. ESLINT-STYLE GREP TEST (§D2 constraint) ----------

describe("Repository scoping comment discipline (§D2)", () => {
  test("every db.camera.* call in repository.ts carries the // scoped: cameraScopeFilter comment", () => {
    // Read the repository file and check that every db.camera.* call (except
    // inside cameraScopeFilter's own definition) is followed on the same line
    // by the `// scoped: cameraScopeFilter` comment.
    //
    // Why this matters: §D2 of the Camera Manager spec requires this comment
    // on every Camera query so a future grep audit can verify scoping is
    // enforced. If a developer adds a new db.camera.findUnique without the
    // comment, this test fails — forcing them to think about scoping.
    const repoPath = join(import.meta.dir, "..", "..", "src", "hrm-server", "cameras", "repository.ts")
    const src = readFileSync(repoPath, "utf8")
    const lines = src.split("\n")
    const violations: string[] = []
    lines.forEach((line, i) => {
      // Match calls like `db.camera.findUnique`, `db.camera.findMany`, `db.camera.create`,
      // `db.camera.update`, `db.camera.delete`, `db.camera.groupBy`, `db.camera.count`,
      // `db.camera.findFirst`. Skip the type-only `Prisma.CameraWhereInput` references.
      if (/db\.camera\.(findUnique|findMany|findFirst|create|update|delete|groupBy|count|upsert)\b/.test(line)) {
        // Skip the comment lines (the regex above shouldn't match comments, but defensive)
        if (line.trim().startsWith("//")) return
        // Require the trailing `// scoped: cameraScopeFilter` comment OR
        // `// scoped: vendorId` (for createCamera's branch lookup which uses
        // db.branch, not db.camera) — but the regex above only matches db.camera.*
        // so we only need cameraScopeFilter.
        if (!line.includes("// scoped: cameraScopeFilter")) {
          violations.push(`  line ${i + 1}: ${line.trim()}`)
        }
      }
    })
    if (violations.length > 0) {
      throw new Error(
        `FAIL: ${violations.length} db.camera.* call(s) missing the // scoped: cameraScopeFilter comment:\n${violations.join("\n")}\n\n` +
          "Every Camera query MUST spread cameraScopeFilter(ctx) into its where clause and carry the trailing comment (§D2 of the Camera Manager spec)."
      )
    }
  })
})

// ---------- 5. validateCameraCreate (Phase 3 item 5) ----------

describe("validateCameraCreate (Phase 3 item 5 — pure-null rejection + Phase 5b Flag 3 — unknown-brand rejection)", () => {
  test("rejects pure-null cameras (no serialNumber AND no verificationCode)", async () => {
    const r = await validateCameraCreate({ brand: "HIKVISION", serialNumber: null, verificationCode: null })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/at least one identifier/)
  })

  test("rejects pure-null cameras even with empty/whitespace strings", async () => {
    const r = await validateCameraCreate({ brand: "HIKVISION", serialNumber: "   ", verificationCode: "" })
    expect(r.ok).toBe(false)
  })

  test("HIKVISION requires verificationCode (even if serialNumber is present)", async () => {
    const r = await validateCameraCreate({ brand: "HIKVISION", serialNumber: "SN-001", verificationCode: null })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/HIKVISION cameras require a verificationCode/)
  })

  test("DAHUA requires verificationCode (same as HIKVISION)", async () => {
    const r = await validateCameraCreate({ brand: "DAHUA", serialNumber: "SN-002", verificationCode: null })
    expect(r.ok).toBe(false)
  })

  test("EZVIZ requires serialNumber (verificationCode is N/A)", async () => {
    const r = await validateCameraCreate({ brand: "EZVIZ", serialNumber: null, verificationCode: "VC-001" })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/EZVIZ cameras require a serialNumber/)
  })

  test("IMOU requires serialNumber (same as EZVIZ)", async () => {
    const r = await validateCameraCreate({ brand: "IMOU", serialNumber: null, verificationCode: "VC-002" })
    expect(r.ok).toBe(false)
  })

  test("accepts HIKVISION with serialNumber + verificationCode", async () => {
    const r = await validateCameraCreate({ brand: "HIKVISION", serialNumber: "SN-001", verificationCode: "VC-001" })
    expect(r.ok).toBe(true)
  })

  test("accepts HIKVISION with verificationCode only (serial optional)", async () => {
    const r = await validateCameraCreate({ brand: "HIKVISION", serialNumber: null, verificationCode: "VC-001" })
    expect(r.ok).toBe(true)
  })

  test("accepts EZVIZ with serialNumber only (verificationCode N/A)", async () => {
    const r = await validateCameraCreate({ brand: "EZVIZ", serialNumber: "SN-001", verificationCode: null })
    expect(r.ok).toBe(true)
  })

  test("Phase 5b Flag 3: rejects unknown brand 'ONVIF' with a clear 400-ready reason", async () => {
    const r = await validateCameraCreate({ brand: "ONVIF", serialNumber: "SN-X", verificationCode: "VC-X" })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.reason).toMatch(/Unsupported camera brand: ONVIF/)
      expect(r.reason).toMatch(/HIKVISION/)
      expect(r.reason).toMatch(/DAHUA/)
    }
  })

  test("Phase 5b Flag 3: rejects missing brand entirely", async () => {
    const r = await validateCameraCreate({ serialNumber: "SN-X", verificationCode: "VC-X" })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/Brand is required/)
  })

  test("Phase 5c Flag C: brand 'hikvision' (lowercase) is accepted (normalized to HIKVISION)", async () => {
    const r = await validateCameraCreate({ brand: "hikvision", serialNumber: "SN-001", verificationCode: "VC-001" })
    expect(r.ok).toBe(true)
  })

  test("Phase 5c Flag C: brand 'HikVision' (mixed case) is accepted (normalized)", async () => {
    const r = await validateCameraCreate({ brand: "HikVision", serialNumber: "SN-001", verificationCode: "VC-001" })
    expect(r.ok).toBe(true)
  })

  test("Phase 5c Flag C: brand 'ezviz' (lowercase) is accepted", async () => {
    const r = await validateCameraCreate({ brand: "ezviz", serialNumber: "SN-001", verificationCode: null })
    expect(r.ok).toBe(true)
  })

  test("Phase 5c Flag C: brand 'imou' (lowercase) is accepted", async () => {
    const r = await validateCameraCreate({ brand: "imou", serialNumber: "SN-001", verificationCode: null })
    expect(r.ok).toBe(true)
  })

  test("Phase 5c Flag C: brand 'onvif' (lowercase) is still rejected — error message references normalized UPPERCASE form", async () => {
    const r = await validateCameraCreate({ brand: "onvif", serialNumber: "SN-X", verificationCode: "VC-X" })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      // Normalization happened before the registry lookup, so the error
      // message references "ONVIF" (uppercase), not "onvif".
      expect(r.reason).toMatch(/Unsupported camera brand: ONVIF/)
    }
  })

  test("Phase 5c Flag C: camera.create route stores brand as UPPERCASE even when input is lowercase", async () => {
    const result = await callRoute("camera.create", ctxA, {
      brand: "hikvision", name: "lowercase brand test", serialNumber: "SN-CASE-001", channel: 1,
      verificationCode: "VC-CASE-001",
    })
    expect(result.brand).toBe("HIKVISION")  // stored as uppercase
  })

  test("Phase 5c Flag C: camera.create route stores mixed-case brand as UPPERCASE", async () => {
    const result = await callRoute("camera.create", ctxA, {
      brand: "HikVision", name: "mixed case brand test", serialNumber: "SN-CASE-002", channel: 1,
      verificationCode: "VC-CASE-002",
    })
    expect(result.brand).toBe("HIKVISION")
  })

  test("brand helpers report the correct classification", () => {
    expect(isPerCameraBrand("HIKVISION")).toBe(true)
    expect(isPerCameraBrand("DAHUA")).toBe(true)
    expect(isPerCameraBrand("EZVIZ")).toBe(false)
    expect(isPerCameraBrand("IMOU")).toBe(false)
    expect(isTenantCredentialBrand("EZVIZ")).toBe(true)
    expect(isTenantCredentialBrand("IMOU")).toBe(true)
    expect(isTenantCredentialBrand("HIKVISION")).toBe(false)
    expect(isTenantCredentialBrand("DAHUA")).toBe(false)
  })
})

// ====================================================================
// Phase 4 — Route handler integration tests (item 5 of Phase 4 kickoff)
// ====================================================================
// Calls the actual route handlers (registered in routes/registry) to verify
// the full stack: permission checks, DTO validation, scope filters, audit
// calls, rate limits. The dispatcher at /api/hrm/route.ts is bypassed (we
// call routes["camera.*"].handler directly), so permission checks at the
// perm: [...] level are NOT enforced here — we test the handler's INTERNAL
// checks (EZVIZ/Imou rejection, cross-tenant 404, etc.).

import { routes } from "@/hrm-server/routes/registry"
import "@/hrm-server/routes/router"  // triggers side-effect imports that populate the routes registry

// Helper: call a route handler and return its result or throw
async function callRoute<T = any>(action: string, ctx: Ctx, payload: any): Promise<T> {
  const def = routes[action]
  if (!def) throw new Error(`Unknown route: ${action}`)
  return def.handler(ctx, payload, undefined as any) as Promise<T>
}

// ---------- Phase 4 item: route-level cross-tenant 404s ----------

describe("Route-level cross-tenant isolation (Phase 4)", () => {
  test("camera.get route throws 404 for cross-tenant cameraId", async () => {
    const cam = await createCamera(ctxA, {
      brand: "HIKVISION", name: "A's cam", serialNumber: "SN-RT-001", channel: 1,
      verificationCode: "VC-RT-001",
    })
    try {
      await callRoute("camera.get", ctxB, { id: cam.id })
      throw new Error("FAIL: camera.get should 404 cross-tenant")
    } catch (e: any) {
      expect(e.code).toBe(404)
    }
  })

  test("camera.update route throws 404 for cross-tenant cameraId", async () => {
    const cam = await createCamera(ctxA, {
      brand: "HIKVISION", name: "A's cam", serialNumber: "SN-RT-002", channel: 1,
      verificationCode: "VC-RT-002",
    })
    try {
      await callRoute("camera.update", ctxB, { id: cam.id, name: "hacked" })
      throw new Error("FAIL: camera.update should 404 cross-tenant")
    } catch (e: any) {
      expect(e.code).toBe(404)
    }
  })

  test("camera.delete route throws 404 for cross-tenant cameraId", async () => {
    const cam = await createCamera(ctxA, {
      brand: "HIKVISION", name: "A's cam", serialNumber: "SN-RT-003", channel: 1,
      verificationCode: "VC-RT-003",
    })
    try {
      await callRoute("camera.delete", ctxB, { id: cam.id })
      throw new Error("FAIL: camera.delete should 404 cross-tenant")
    } catch (e: any) {
      expect(e.code).toBe(404)
    }
  })

  test("camera.launch route throws 404 for cross-tenant cameraId (no rate-limit hit, no audit row)", async () => {
    const cam = await createCamera(ctxA, {
      brand: "HIKVISION", name: "A's cam", serialNumber: "SN-RT-004", channel: 1,
      verificationCode: "VC-RT-004",
    })
    try {
      await callRoute("camera.launch", ctxB, { id: cam.id })
      throw new Error("FAIL: camera.launch should 404 cross-tenant")
    } catch (e: any) {
      expect(e.code).toBe(404)
    }
    // No audit row should have been written for the failed launch
    const auditRows = await db.auditLog.findMany({
      where: { vendorId: "v-B", action: "camera.launch" },
    })
    expect(auditRows.length).toBe(0)
  })

  test("camera.status route throws 404 for cross-tenant cameraId", async () => {
    const cam = await createCamera(ctxA, {
      brand: "HIKVISION", name: "A's cam", serialNumber: "SN-RT-005", channel: 1,
      verificationCode: "VC-RT-005",
    })
    try {
      await callRoute("camera.status", ctxB, { id: cam.id })
      throw new Error("FAIL: camera.status should 404 cross-tenant")
    } catch (e: any) {
      expect(e.code).toBe(404)
    }
  })

  test("camera.restore route throws 404 for cross-tenant cameraId", async () => {
    const cam = await createCamera(ctxA, {
      brand: "HIKVISION", name: "A's cam", serialNumber: "SN-RT-006", channel: 1,
      verificationCode: "VC-RT-006",
    })
    await deleteCamera(ctxA, cam.id)
    try {
      await callRoute("camera.restore", ctxB, { id: cam.id })
      throw new Error("FAIL: camera.restore should 404 cross-tenant")
    } catch (e: any) {
      expect(e.code).toBe(404)
    }
  })

  test("camera.list route returns only the caller's tenant's cameras", async () => {
    await createCamera(ctxA, {
      brand: "HIKVISION", name: "A1", serialNumber: "SN-RT-007", channel: 1,
      verificationCode: "VC-RT-007",
    })
    await createCamera(ctxA, {
      brand: "DAHUA", name: "A2", serialNumber: "SN-RT-008", channel: 1,
      verificationCode: "VC-RT-008",
    })
    const resultB = await callRoute<{ cameras: any[]; counts: any }>("camera.list", ctxB, {})
    expect(resultB.cameras.length).toBe(0)
    expect(resultB.counts.total).toBe(0)
    const resultA = await callRoute<{ cameras: any[]; counts: any }>("camera.list", ctxA, {})
    expect(resultA.cameras.length).toBe(2)
    expect(resultA.counts.total).toBe(2)
  })
})

// ---------- Phase 4 item 4: HR_MANAGER cannot create EZVIZ/Imou ----------

describe("HR_MANAGER EZVIZ/Imou rejection (Phase 4 item 4)", () => {
  // HR_MANAGER per the confirmed table: view, create, edit, launch — NO manage
  const ctxHRM: Ctx = {
    userId: "u-HRM", userName: "Harold", vendorId: "v-A", role: "HR_MANAGER",
    permissions: new Set(["camera.view", "camera.create", "camera.edit", "camera.launch"]),
  }

  test("HR_MANAGER can create HIKVISION (per-camera brand, no tenant creds needed)", async () => {
    const result = await callRoute("camera.create", ctxHRM, {
      brand: "HIKVISION", name: "HR's hik cam", serialNumber: "SN-HRM-001", channel: 1,
      verificationCode: "VC-HRM-001",
    })
    expect(result.brand).toBe("HIKVISION")
    expect(result.name).toBe("HR's hik cam")
  })

  test("HR_MANAGER can create DAHUA (per-camera brand)", async () => {
    const result = await callRoute("camera.create", ctxHRM, {
      brand: "DAHUA", name: "HR's dahua cam", serialNumber: "SN-HRM-002", channel: 1,
      verificationCode: "VC-HRM-002",
    })
    expect(result.brand).toBe("DAHUA")
  })

  test("HR_MANAGER CANNOT create EZVIZ (requires camera.manage)", async () => {
    try {
      await callRoute("camera.create", ctxHRM, {
        brand: "EZVIZ", name: "HR's ezviz cam", serialNumber: "SN-HRM-003", channel: 1,
      })
      throw new Error("FAIL: HR_MANAGER should not create EZVIZ cameras")
    } catch (e: any) {
      expect(e.code).toBe(403)
      expect(e.message).toMatch(/camera\.manage/)
      expect(e.message).toMatch(/EZVIZ/)
    }
  })

  test("HR_MANAGER CANNOT create IMOU (requires camera.manage)", async () => {
    try {
      await callRoute("camera.create", ctxHRM, {
        brand: "IMOU", name: "HR's imou cam", serialNumber: "SN-HRM-004", channel: 1,
      })
      throw new Error("FAIL: HR_MANAGER should not create IMOU cameras")
    } catch (e: any) {
      expect(e.code).toBe(403)
      expect(e.message).toMatch(/camera\.manage/)
      expect(e.message).toMatch(/IMOU/)
    }
  })

  test("HR_ADMIN CAN create EZVIZ (has camera.manage)", async () => {
    const result = await callRoute("camera.create", ctxA, {
      brand: "EZVIZ", name: "Admin's ezviz cam", serialNumber: "SN-ADMIN-001", channel: 1,
    })
    expect(result.brand).toBe("EZVIZ")
  })
})

// ---------- Phase 4 item 5b: HR_ADMIN can create branchId=null ----------

describe("HR_ADMIN branchId=null (Phase 4 item 5b — unassigned cameras are legal)", () => {
  test("HR_ADMIN can create a camera with branchId=null (unassigned)", async () => {
    const result = await callRoute("camera.create", ctxA, {
      brand: "HIKVISION", name: "unassigned cam", serialNumber: "SN-UN-001", channel: 1,
      verificationCode: "VC-UN-001", branchId: null,
    })
    expect(result.branchId).toBeNull()
    expect(result.name).toBe("unassigned cam")
  })

  test("HR_ADMIN can create a camera without passing branchId at all", async () => {
    const result = await callRoute("camera.create", ctxA, {
      brand: "HIKVISION", name: "no-branch-specified", serialNumber: "SN-UN-002", channel: 1,
      verificationCode: "VC-UN-002",
    })
    expect(result.branchId).toBeNull()
  })

  test("BRANCH_MANAGER auto-defaults to their own branch when branchId is not passed (item 5a)", async () => {
    const result = await callRoute("camera.create", ctxBM, {
      brand: "HIKVISION", name: "BM auto-default cam", serialNumber: "SN-BM-AD-001", channel: 1,
      verificationCode: "VC-BM-AD-001",
      // branchId intentionally omitted — should auto-default to ctxBM.branchId
    })
    expect(result.branchId).toBe(brAId)
  })

  test("BRANCH_MANAGER can explicitly create in their own branch", async () => {
    const result = await callRoute("camera.create", ctxBM, {
      brand: "HIKVISION", name: "BM explicit branch", serialNumber: "SN-BM-EX-001", channel: 1,
      verificationCode: "VC-BM-EX-001", branchId: brAId,
    })
    expect(result.branchId).toBe(brAId)
  })

  test("BRANCH_MANAGER CANNOT create with branchId=null explicitly (refused)", async () => {
    try {
      await callRoute("camera.create", ctxBM, {
        brand: "HIKVISION", name: "BM null attempt", serialNumber: "SN-BM-NULL-001", channel: 1,
        verificationCode: "VC-BM-NULL-001", branchId: null,
      })
      throw new Error("FAIL: BM should not create unassigned cameras")
    } catch (e: any) {
      expect(e.code).toBe(403)
    }
  })
})

// ---------- Phase 4: camera.launch audit + rate limit ----------

describe("camera.launch audit + rate limit (Phase 4)", () => {
  test("successful launch writes an audit row (auditStrict)", async () => {
    const cam = await createCamera(ctxA, {
      brand: "HIKVISION", name: "launch me", serialNumber: "SN-LAUNCH-001", channel: 1,
      verificationCode: "VC-LAUNCH-001",
    })
    const beforeCount = await db.auditLog.count({ where: { vendorId: "v-A", action: "camera.launch" } })
    await callRoute("camera.launch", ctxA, { id: cam.id })
    const afterCount = await db.auditLog.count({ where: { vendorId: "v-A", action: "camera.launch" } })
    expect(afterCount).toBe(beforeCount + 1)
    const row = await db.auditLog.findFirst({
      where: { vendorId: "v-A", action: "camera.launch", entityId: cam.id },
      orderBy: { createdAt: "desc" },
    })
    expect(row).not.toBeNull()
    expect(row?.summary).toMatch(/Launched HIKVISION camera/)
  })

  test("launch returns the expected envelope { launchTarget, fallbackWebUrl }", async () => {
    const cam = await createCamera(ctxA, {
      brand: "HIKVISION", name: "envelope test", serialNumber: "SN-LAUNCH-002", channel: 1,
      verificationCode: "VC-LAUNCH-002",
    })
    const result = await callRoute("camera.launch", ctxA, { id: cam.id })
    expect(result).toHaveProperty("launchTarget")
    expect(result).toHaveProperty("fallbackWebUrl")
    expect(result.launchTarget).toHaveProperty("kind")
    expect(result.launchTarget.kind).toBe("DEEP_LINK")
    expect(result.launchTarget).toHaveProperty("url")
    expect(typeof result.fallbackWebUrl).toBe("string")
  })

  test("launch strips verificationCode from the camera record (never exposed)", async () => {
    const cam = await createCamera(ctxA, {
      brand: "HIKVISION", name: "strip test", serialNumber: "SN-LAUNCH-003", channel: 1,
      verificationCode: "VC-LAUNCH-003-SECRET",
    })
    const getResult = await callRoute("camera.get", ctxA, { id: cam.id })
    // verificationCode must NOT be in the response — only hasVerificationCode boolean
    expect(getResult).not.toHaveProperty("verificationCode")
    expect(getResult).toHaveProperty("hasVerificationCode")
    expect(getResult.hasVerificationCode).toBe(true)
  })

  test("rate limit: hammer camera.launch exceeds per-camera limit → 429", async () => {
    const cam = await createCamera(ctxA, {
      brand: "HIKVISION", name: "rate limit test", serialNumber: "SN-RL-001", channel: 1,
      verificationCode: "VC-RL-001",
    })
    // The per-camera limit is 30/min. Hammer 35 launches; expect at least one 429.
    let okCount = 0
    let rateLimitedCount = 0
    for (let i = 0; i < 35; i++) {
      try {
        await callRoute("camera.launch", ctxA, { id: cam.id })
        okCount++
      } catch (e: any) {
        if (e.code === 429) rateLimitedCount++
        else throw e  // unexpected error
      }
    }
    expect(okCount).toBeLessThanOrEqual(30)  // 30 is the per-camera limit
    expect(rateLimitedCount).toBeGreaterThan(0)  // at least one 429
  })
})

// ---------- Phase 4: camera.credential.upsert + delete (EZVIZ/Imou only) ----------

describe("camera.credential routes (Phase 4 — EZVIZ/Imou only)", () => {
  test("HR_ADMIN can upsert EZVIZ credentials (camera.manage)", async () => {
    const result = await callRoute("camera.credential.upsert", ctxA, {
      brand: "EZVIZ", appKey: "my-app-key", appSecret: "my-app-secret",
    })
    expect(result.brand).toBe("EZVIZ")
    expect(result.encryptionKeyVersion).toBe(1)
    expect(result.rotatedAt).toBeNull()
  })

  test("rotation bumps encryptionKeyVersion and sets rotatedAt", async () => {
    // First write
    await callRoute("camera.credential.upsert", ctxA, {
      brand: "EZVIZ", appKey: "first-key", appSecret: "first-secret",
    })
    // Rotate
    const result = await callRoute("camera.credential.upsert", ctxA, {
      brand: "EZVIZ", appKey: "second-key", appSecret: "second-secret",
    })
    expect(result.encryptionKeyVersion).toBe(2)
    expect(result.rotatedAt).not.toBeNull()
  })

  test("upserting HIKVISION credentials is rejected (per-camera brand)", async () => {
    try {
      await callRoute("camera.credential.upsert", ctxA, {
        brand: "HIKVISION", appKey: "x", appSecret: "y",
      })
      throw new Error("FAIL: HIKVISION should not accept tenant credentials")
    } catch (e: any) {
      expect(e.code).toBe(400)
      expect(e.message).toMatch(/do not use tenant credentials/)
    }
  })

  test("getCredential decrypts the stored payload via dynamic context (item 3)", async () => {
    // Upsert with a known plaintext
    await callRoute("camera.credential.upsert", ctxA, {
      brand: "EZVIZ", appKey: "test-key-123", appSecret: "test-secret-456",
    })
    // Read via the credentials wrapper — should decrypt to the original
    const result = await getCredentialDecrypted(ctxA, "EZVIZ")
    expect(result).not.toBeNull()
    expect(result?.creds).not.toBeNull()
    expect(result?.creds?.appKey).toBe("test-key-123")
    expect(result?.creds?.appSecret).toBe("test-secret-456")
  })

  test("delete removes the credential row", async () => {
    await callRoute("camera.credential.upsert", ctxA, {
      brand: "EZVIZ", appKey: "to-delete", appSecret: "to-delete-secret",
    })
    const result = await callRoute("camera.credential.delete", ctxA, { brand: "EZVIZ" })
    expect(result.brand).toBe("EZVIZ")
    expect(result.deleted).toBe(true)
    // Confirm it's gone
    const after = await getCredentialDecrypted(ctxA, "EZVIZ")
    expect(after).toBeNull()
  })

  // Phase 7 Item 2: audit-verb tests for credential create vs rotate

  test("Phase 7 Item 2: first upsert writes audit row with action=camera.credential.create (not rotate)", async () => {
    // Clear any prior EZVIZ creds for this tenant
    await callRoute("camera.credential.delete", ctxA, { brand: "EZVIZ" }).catch(() => {})
    // Clear prior audit rows for this action to isolate the test
    await db.auditLog.deleteMany({ where: { vendorId: "v-A", action: { in: ["camera.credential.create", "camera.credential.rotate"] } } })

    // First upsert — should fire camera.credential.create
    await callRoute("camera.credential.upsert", ctxA, {
      brand: "EZVIZ", appKey: "first-key", appSecret: "first-secret",
    })

    const createRows = await db.auditLog.findMany({ where: { vendorId: "v-A", action: "camera.credential.create" } })
    expect(createRows.length).toBe(1)
    expect(createRows[0].summary).toMatch(/Onboarded EZVIZ/)

    // Ensure camera.credential.rotate was NOT written on first upsert
    const rotateRows = await db.auditLog.findMany({ where: { vendorId: "v-A", action: "camera.credential.rotate" } })
    expect(rotateRows.length).toBe(0)
  })

  test("Phase 7 Item 2: second upsert (rotation) writes audit row with action=camera.credential.rotate (not create)", async () => {
    // Ensure creds exist (first upsert)
    await callRoute("camera.credential.upsert", ctxA, {
      brand: "EZVIZ", appKey: "first-key", appSecret: "first-secret",
    })
    // Clear audit rows to isolate the rotation test
    await db.auditLog.deleteMany({ where: { vendorId: "v-A", action: { in: ["camera.credential.create", "camera.credential.rotate"] } } })

    // Second upsert — should fire camera.credential.rotate
    await callRoute("camera.credential.upsert", ctxA, {
      brand: "EZVIZ", appKey: "second-key", appSecret: "second-secret",
    })

    const rotateRows = await db.auditLog.findMany({ where: { vendorId: "v-A", action: "camera.credential.rotate" } })
    expect(rotateRows.length).toBe(1)
    expect(rotateRows[0].summary).toMatch(/Rotated EZVIZ/)

    // Ensure camera.credential.create was NOT written on rotation
    const createRows = await db.auditLog.findMany({ where: { vendorId: "v-A", action: "camera.credential.create" } })
    expect(createRows.length).toBe(0)
  })

  test("Phase 7 Item 2: credential delete writes audit row with action=camera.credential.delete", async () => {
    // Ensure creds exist
    await callRoute("camera.credential.upsert", ctxA, {
      brand: "EZVIZ", appKey: "to-delete", appSecret: "to-delete-secret",
    })
    await db.auditLog.deleteMany({ where: { vendorId: "v-A", action: "camera.credential.delete" } })

    await callRoute("camera.credential.delete", ctxA, { brand: "EZVIZ" })

    const deleteRows = await db.auditLog.findMany({ where: { vendorId: "v-A", action: "camera.credential.delete" } })
    expect(deleteRows.length).toBe(1)
    expect(deleteRows[0].summary).toMatch(/Deleted EZVIZ/)
  })

  test("Phase 7 Item 2: credential delete response includes affectedCameraCount", async () => {
    // Ensure creds exist
    await callRoute("camera.credential.upsert", ctxA, {
      brand: "EZVIZ", appKey: "count-test", appSecret: "count-test-secret",
    })
    // Create 2 EZVIZ cameras (they'll be affected by the credential delete)
    await createCamera(ctxA, { brand: "EZVIZ", name: "cam-1", serialNumber: "SN-AFF-1", channel: 1 })
    await createCamera(ctxA, { brand: "EZVIZ", name: "cam-2", serialNumber: "SN-AFF-2", channel: 1 })

    const result = await callRoute<{ brand: string; deleted: boolean; affectedCameraCount: number }>(
      "camera.credential.delete", ctxA, { brand: "EZVIZ" },
    )
    expect(result.affectedCameraCount).toBe(2)
  })

  test("Phase 7 Item 1: camera.credential.state returns { EZVIZ: boolean, IMOU: boolean } without decrypting", async () => {
    // No creds configured yet → both should be false
    await callRoute("camera.credential.delete", ctxA, { brand: "EZVIZ" }).catch(() => {})
    await callRoute("camera.credential.delete", ctxA, { brand: "IMOU" }).catch(() => {})

    const state1 = await callRoute<Record<string, boolean>>("camera.credential.state", ctxA, {})
    expect(state1.EZVIZ).toBe(false)
    expect(state1.IMOU).toBe(false)

    // Configure EZVIZ
    await callRoute("camera.credential.upsert", ctxA, { brand: "EZVIZ", appKey: "k", appSecret: "s" })

    const state2 = await callRoute<Record<string, boolean>>("camera.credential.state", ctxA, {})
    expect(state2.EZVIZ).toBe(true)
    expect(state2.IMOU).toBe(false)  // still not configured
  })
})

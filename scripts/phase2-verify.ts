// Phase-2 verification: schema shape + repository end-to-end smoke test.
// Run: DATABASE_URL="file:./db/phase2-test.db" bun run scripts/phase2-verify.ts
import { db } from "../src/lib/db"
import {
  listCameras, getCamera, createCamera, updateCamera, deleteCamera, restoreCamera,
  updateCameraStatus, countCamerasByStatus, upsertCredential, getCredential, deleteCredential,
  isPerCameraBrand, isTenantCredentialBrand,
} from "../src/hrm-server/cameras/repository"
import type { Ctx } from "../src/hrm-server/types"

// ---------- 1. SCHEMA SHAPE ----------
async function checkSchema() {
  console.log("\n=== 1. SCHEMA SHAPE ===")
  const cameraInfo: any[] = await db.$queryRaw`PRAGMA table_info(Camera)`
  const credInfo: any[] = await db.$queryRaw`PRAGMA table_info(CameraCredential)`
  const cameraIndexes: any[] = await db.$queryRaw`PRAGMA index_list(Camera)`
  const credIndexes: any[] = await db.$queryRaw`PRAGMA index_list(CameraCredential)`

  console.log("\nCamera columns:")
  for (const c of cameraInfo) console.log(`  ${c.name.padEnd(20)} ${String(c.type).padEnd(12)} notnull=${c.notnull} dflt=${c.dflt_value ?? "—"}`)
  console.log("\nCameraCredential columns:")
  for (const c of credInfo) console.log(`  ${c.name.padEnd(20)} ${String(c.type).padEnd(12)} notnull=${c.notnull} dflt=${c.dflt_value ?? "—"}`)
  console.log("\nCamera indexes:")
  for (const i of cameraIndexes) console.log(`  ${i.name}  unique=${i.unique}  origin=${i.origin}`)
  console.log("\nCameraCredential indexes:")
  for (const i of credIndexes) console.log(`  ${i.name}  unique=${i.unique}  origin=${i.origin}`)

  // Camera columns (addendum shape)
  const cameraNames = cameraInfo.map((c: any) => c.name)
  const expectedCamera = ["id", "vendorId", "brand", "name", "model", "serialNumber", "channel",
    "verificationCode", "branchId", "location", "installDate", "status", "lastStatusCheckAt",
    "lastSeenAt", "lastError", "enabled", "createdAt", "updatedAt"]
  const missing = expectedCamera.filter((n) => !cameraNames.includes(n))
  if (missing.length) throw new Error(`Camera missing columns: ${missing.join(", ")}`)
  // Verify metadata field is GONE (addendum item 3 — minimal addition principle)
  if (cameraNames.includes("metadata")) throw new Error("Camera.metadata should be removed (addendum item 3)")
  // Verify deviceSerial is GONE (renamed to serialNumber per addendum item 6)
  if (cameraNames.includes("deviceSerial")) throw new Error("Camera.deviceSerial should be renamed to serialNumber (addendum item 6)")
  // Verify installDate is TEXT (String) not DATETIME (addendum item 2)
  const installDateCol = cameraInfo.find((c: any) => c.name === "installDate")
  if (installDateCol && installDateCol.type !== "TEXT") throw new Error(`installDate should be TEXT (String), got ${installDateCol.type}`)
  // Verify updatedAt has DEFAULT CURRENT_TIMESTAMP (addendum: match AttendanceDevice)
  const updatedAtCol = cameraInfo.find((c: any) => c.name === "updatedAt")
  if (updatedAtCol && updatedAtCol.dflt_value !== "CURRENT_TIMESTAMP") {
    throw new Error(`updatedAt should default to CURRENT_TIMESTAMP, got dflt=${updatedAtCol.dflt_value}`)
  }
  // Verify enabled has default 1 (boolean true)
  const enabledCol = cameraInfo.find((c: any) => c.name === "enabled")
  if (enabledCol && enabledCol.dflt_value !== "1") {
    throw new Error(`enabled should default to 1, got dflt=${enabledCol.dflt_value}`)
  }

  // CameraCredential columns
  const credNames = credInfo.map((c: any) => c.name)
  const expectedCred = ["id", "vendorId", "brand", "encryptedPayload", "encryptionKeyVersion", "createdAt", "rotatedAt"]
  const missingCred = expectedCred.filter((n) => !credNames.includes(n))
  if (missingCred.length) throw new Error(`CameraCredential missing columns: ${missingCred.join(", ")}`)

  // Camera indexes (addendum: includes @@unique([vendorId, id]) + @@index([vendorId, enabled]))
  const cameraIdxNames = cameraIndexes.map((i: any) => i.name)
  for (const expected of [
    "Camera_vendorId_id_key",                                   // H-10 structural scoping (addendum item 1)
    "Camera_vendorId_serialNumber_channel_key",                 // composite unique (renamed from deviceSerial)
    "Camera_vendorId_idx",
    "Camera_vendorId_brand_idx",
    "Camera_vendorId_branchId_idx",
    "Camera_vendorId_enabled_idx",                              // soft-delete filter (addendum item 5)
  ]) {
    if (!cameraIdxNames.includes(expected)) throw new Error(`Missing index: ${expected}`)
  }
  const credIdxNames = credIndexes.map((i: any) => i.name)
  for (const expected of [
    "CameraCredential_vendorId_id_key",       // H-10 structural scoping (addendum item 1)
    "CameraCredential_vendorId_brand_key",
    "CameraCredential_vendorId_idx",
  ]) {
    if (!credIdxNames.includes(expected)) throw new Error(`Missing index: ${expected}`)
  }

  console.log("\n✓ Schema shape: all addendum-driven columns + indexes present, metadata/deviceSerial removed, installDate is TEXT, updatedAt has CURRENT_TIMESTAMP default, enabled defaults to 1")
}

// ---------- 2. REPOSITORY END-TO-END ----------
async function checkRepository() {
  console.log("\n=== 2. REPOSITORY END-TO-END ===")
  const ctxA: Ctx = { userId: "u-A", userName: "Alice", vendorId: "v-A", role: "HR_ADMIN",
    permissions: new Set(["camera.view", "camera.create", "camera.edit", "camera.delete", "camera.launch", "camera.manage"]) }
  const ctxB: Ctx = { userId: "u-B", userName: "Bob", vendorId: "v-B", role: "HR_ADMIN",
    permissions: new Set(["camera.view", "camera.create", "camera.edit", "camera.delete", "camera.launch", "camera.manage"]) }
  const ctxBM: Ctx = { userId: "u-BM", userName: "Bran", vendorId: "v-A", role: "BRANCH_MANAGER",
    permissions: new Set(["camera.view", "camera.launch"]), branchId: "b-1" }

  console.log("\nlistCameras(A) on empty DB:", (await listCameras(ctxA)).length, "rows (expect 0)")

  // Seed one branch per tenant so branchId lookups resolve. Branch.code is
  // unique per vendor (schema: @@unique([vendorId, code])).
  const brA = await db.branch.create({ data: { vendorId: "v-A", code: "B1", name: "Branch 1", type: "WAREHOUSE" } })
  await db.branch.create({ data: { vendorId: "v-B", code: "B1", name: "Branch 1", type: "WAREHOUSE" } })
  // Use the actual branch id for ctxBM.branchId and camera creation.
  const bmBranchId = brA.id

  // Camera 1: no branch (HR_ADMIN registers a camera without assigning to a branch yet)
  const camA = await createCamera(ctxA, {
    brand: "HIKVISION", name: "Warehouse Gate 2", serialNumber: "SN-A-001", channel: 1,
    verificationCode: "VC-001", branchId: null, location: "Gate 2",
    installDate: "2026-09-26", // ISO date string — addendum item 2
  })
  console.log(`createCamera(A): id=${camA.id.slice(-8)}, brand=${camA.brand}, status=${camA.status}, channel=${camA.channel}, enabled=${camA.enabled}, installDate=${camA.installDate}`)

  // Cross-tenant: B must not see A's camera
  const listB = await listCameras(ctxB)
  if (listB.length !== 0) throw new Error("Cross-tenant leak in listCameras!")
  console.log(`listCameras(B): ${listB.length} rows (expect 0) — cross-tenant isolation ✓`)

  // Cross-tenant point lookup: 404, not 403
  try {
    await getCamera(ctxB, camA.id)
    throw new Error("FAIL: should have thrown 404")
  } catch (e: any) {
    if (e?.code !== 404) throw new Error(`FAIL: wrong code ${e?.code}: ${e?.message}`)
    console.log(`getCamera(B, A's id): Deny 404 — "${e.message}" ✓ (no ID enumeration)`)
  }

  // BRANCH_MANAGER with no cameras in their branch → empty
  const ctxBMReal = { ...ctxBM, branchId: bmBranchId }
  const listBM = await listCameras(ctxBMReal)
  if (listBM.length !== 0) throw new Error("BM scope leak before camera added")
  console.log(`listCameras(BM, branch-1, empty): ${listBM.length} rows (expect 0)`)

  // Camera 2: in branch-1 → BM should see it
  const camA2 = await createCamera(ctxA, {
    brand: "DAHUA", name: "Reception Cam", serialNumber: "SN-A-002", channel: 1,
    branchId: bmBranchId, location: "Reception desk",
  })
  const listBM2 = await listCameras(ctxBMReal)
  if (listBM2.length !== 1 || listBM2[0].id !== camA2.id) throw new Error("BM scope broken")
  console.log(`listCameras(BM, branch-1, after add): ${listBM2.length} row, id matches ✓`)

  // Cross-branch access: BM can't getCamera on camA (branchId=null, not branch-1)
  try {
    await getCamera(ctxBMReal, camA.id)
    throw new Error("FAIL: BM should not see out-of-branch camera")
  } catch (e: any) {
    if (e?.code !== 404) throw new Error(`FAIL: wrong code ${e?.code}: ${e?.message}`)
    console.log(`getCamera(BM, A's camera in different branch): Deny 404 ✓`)
  }

  // Update + lastError
  const updated = await updateCamera(ctxA, camA.id, { name: "Warehouse Gate 2 (renamed)", status: "ONLINE" })
  if (updated.name !== "Warehouse Gate 2 (renamed)") throw new Error("update didn't apply name")
  if (updated.status !== "ONLINE") throw new Error("update didn't apply status")
  console.log(`updateCamera(A): name → "${updated.name}", status → ${updated.status} ✓`)

  // Status update with error
  const errUpdated = await updateCameraStatus(ctxA, camA.id, "OFFLINE", { lastError: "EZVIZ token expired" })
  if (errUpdated.status !== "OFFLINE" || errUpdated.lastError !== "EZVIZ token expired") {
    throw new Error(`status+error update failed: status=${errUpdated.status} lastError=${errUpdated.lastError}`)
  }
  console.log(`updateCameraStatus(A, OFFLINE, lastError="EZVIZ token expired"): ✓`)

  // Status update clearing error (lastError: null)
  const errCleared = await updateCameraStatus(ctxA, camA.id, "ONLINE", { lastError: null })
  if (errCleared.lastError !== null) throw new Error(`lastError should be cleared, got ${errCleared.lastError}`)
  console.log(`updateCameraStatus(A, ONLINE, lastError=null): lastError cleared ✓`)

  // Cross-tenant update → 404
  try {
    await updateCamera(ctxB, camA.id, { name: "hacked" })
    throw new Error("FAIL: cross-tenant update should 404")
  } catch (e: any) {
    if (e?.code !== 404) throw new Error(`FAIL: wrong code ${e?.code}: ${e?.message}`)
    console.log(`updateCamera(B, A's id): Deny 404 ✓`)
  }

  // Status counts
  const counts = await countCamerasByStatus(ctxA)
  if (counts.total !== 2) throw new Error(`countCamerasByStatus total=${counts.total}, expected 2`)
  console.log(`countCamerasByStatus(A):`, counts)

  // Brand helpers
  if (!isTenantCredentialBrand("EZVIZ")) throw new Error("EZVIZ should be tenant-credential")
  if (!isPerCameraBrand("HIKVISION")) throw new Error("HIKVISION should be per-camera")
  if (isTenantCredentialBrand("HIKVISION")) throw new Error("HIKVISION should NOT be tenant-credential")
  if (isPerCameraBrand("EZVIZ")) throw new Error("EZVIZ should NOT be per-camera")
  console.log(`isPerCameraBrand / isTenantCredentialBrand: ✓`)

  // Credential lifecycle
  const cred = await upsertCredential(ctxA, "EZVIZ", "v2:fake.payload.here", 1)
  if (cred.rotatedAt !== null) throw new Error("First-time credential should have null rotatedAt")
  console.log(`upsertCredential(A, EZVIZ) create: keyVer=${cred.encryptionKeyVersion}, rotatedAt=null ✓`)

  const rotated = await upsertCredential(ctxA, "EZVIZ", "v2:rotated.payload.here", 2)
  if (rotated.rotatedAt === null) throw new Error("Rotation should set rotatedAt")
  if (rotated.encryptionKeyVersion !== 2) throw new Error("Rotation should bump key version")
  console.log(`upsertCredential(A, EZVIZ) rotate: keyVer=${rotated.encryptionKeyVersion}, rotatedAt set ✓`)

  // Cross-tenant credential fetch
  const credB = await getCredential(ctxB, "EZVIZ")
  if (credB !== null) throw new Error("Cross-tenant credential leak!")
  console.log(`getCredential(B, EZVIZ): null ✓ (no cross-tenant leak)`)

  // Delete credential returns the deleted row
  const deletedCred = await deleteCredential(ctxA, "EZVIZ")
  if (!deletedCred) throw new Error("deleteCredential should return the deleted row")
  console.log(`deleteCredential(A, EZVIZ): returned row for audit ✓`)
  const afterDelete = await getCredential(ctxA, "EZVIZ")
  if (afterDelete !== null) throw new Error("Credential still present after delete!")
  console.log(`getCredential(A, EZVIZ) after delete: null ✓`)

  // SOFT-DELETE: camera.delete sets enabled=false, doesn't actually remove the row
  const softDeleted = await deleteCamera(ctxA, camA2.id)
  if (softDeleted.enabled !== false) throw new Error(`Soft-delete should set enabled=false, got enabled=${softDeleted.enabled}`)
  console.log(`deleteCamera(A, camA2): enabled=false (soft-delete) ✓`)

  // Soft-deleted camera should NOT appear in default listCameras
  const listAfterDelete = await listCameras(ctxA)
  if (listAfterDelete.some((c) => c.id === camA2.id)) throw new Error("Soft-deleted camera leaked into default listCameras")
  console.log(`listCameras(A) after soft-delete: ${listAfterDelete.length} rows (camA2 excluded) ✓`)

  // Soft-deleted camera SHOULD appear with includeDisabled: true
  const listWithDisabled = await listCameras(ctxA, { includeDisabled: true })
  if (!listWithDisabled.some((c) => c.id === camA2.id)) throw new Error("Soft-deleted camera missing from includeDisabled list")
  console.log(`listCameras(A, includeDisabled:true): ${listWithDisabled.length} rows (camA2 included) ✓`)

  // getCamera still finds the soft-deleted camera (for audit/recovery)
  const fetched = await getCamera(ctxA, camA2.id)
  if (fetched.enabled !== false) throw new Error("getCamera on soft-deleted should still find it with enabled=false")
  console.log(`getCamera(A, camA2.id) after soft-delete: found, enabled=false ✓`)

  // Soft-deleted camera is excluded from countCamerasByStatus
  const countsAfter = await countCamerasByStatus(ctxA)
  if (countsAfter.total !== 1) throw new Error(`countCamerasByStatus should exclude soft-deleted, got total=${countsAfter.total}`)
  console.log(`countCamerasByStatus(A) after soft-delete: total=${countsAfter.total} (camA2 excluded) ✓`)

  // Restore
  const restored = await restoreCamera(ctxA, camA2.id)
  if (restored.enabled !== true) throw new Error("Restore should set enabled=true")
  if (restored.lastError !== null) throw new Error("Restore should clear lastError")
  console.log(`restoreCamera(A, camA2.id): enabled=true, lastError cleared ✓`)

  // Cross-tenant delete → 404
  try {
    await deleteCamera(ctxB, camA.id)
    throw new Error("FAIL: cross-tenant delete should 404")
  } catch (e: any) {
    if (e?.code !== 404) throw new Error(`FAIL: wrong code: ${e?.code}: ${e?.message}`)
    console.log(`deleteCamera(B, A's id): Deny 404 ✓`)
  }

  // Idempotent soft-delete (re-delete already-disabled camera)
  const camA3 = await createCamera(ctxA, {
    brand: "EZVIZ", name: "Test Cam", serialNumber: "SN-A-003", channel: 1,
  })
  await deleteCamera(ctxA, camA3.id)
  const reDeleted = await deleteCamera(ctxA, camA3.id) // second call
  if (reDeleted.enabled !== false) throw new Error("Idempotent soft-delete broken")
  console.log(`deleteCamera(A) twice (idempotent): second call returns row, enabled=false ✓`)

  console.log("\n✓ Repository end-to-end: all scope + soft-delete checks passed")
}

;(async () => {
  try {
    await checkSchema()
    await checkRepository()
    console.log("\n=== PHASE 2 VERIFICATION PASSED ===")
  } catch (e: any) {
    console.error("\n=== PHASE 2 VERIFICATION FAILED ===")
    console.error(e)
    process.exit(1)
  } finally {
    await db.$disconnect()
  }
})()

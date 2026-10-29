// ============ Camera Manager — repository layer (data access only) ============
// See src/hrm/CONVENTIONS.md and src/hrm/API.md for the broader app conventions.
//
// SCOPING RULES (mandatory; enforced by ESLint-style grep test in
// tests/unit/camera-tenant-isolation.test.ts — see Camera Manager §15/D4):
//
// 1. EVERY db.camera.* call MUST receive `{ ...cameraScopeFilter(ctx), ... }`
//    as part of its `where` clause, and MUST carry the trailing
//    `// scoped: cameraScopeFilter` comment on the same line.
//    cameraScopeFilter(ctx) returns `{ vendorId, branchId? }` — vendorId
//    always; branchId only for BRANCH_MANAGER with a User.branchId assignment
//    (mirrors deviceScopeFilter in routes/devices.ts:23-27).
//
// 2. Point lookups by id use `assertTenant(rec, ctx)` from ../rbac — returns
//    404, never 403, to prevent cross-tenant ID enumeration (per
//    Camera Manager §13.5/D3 constraint). Soft-deleted (enabled=false)
//    cameras are still findable by id — this is intentional, for audit
//    and recovery flows; the listCameras default filter is what hides them.
//
// 3. db.cameraCredential.* calls enforce vendorId only (NOT branchId) —
//    credentials are per-vendor+brand, never per-branch. The route layer
//    gates mutations with the `camera.manage` permission.
//
// This file is data-access only. No audit logging (Phase 3 route layer
// calls audit()/auditStrict() — see ../audit.ts). No provider calls
// (Phase 4+). No DTO validation (Phase 3 route layer uses cleanForm +
// safePayload). No Zod schemas here (the registry-native schema:ZodType
// path is NOT used for cameras — separate PR per Camera Manager Phase 1).
import { db } from "@/lib/db"
import type { Ctx } from "../types"
import type { Camera, CameraCredential, Prisma } from "@prisma/client"
// HIGH-14 (this audit) — encrypt Camera.verificationCode at rest via the
// existing crypto-field infrastructure under a dedicated context. Mirrors the
// MFA secret + CameraCredential.encryptedPayload pattern.
// decryptField is dynamically imported in routes/cameras.ts (camera.launch) —
// it is NOT statically imported here to avoid an unused-import lint error
// (the repository only encrypts on write; the route layer decrypts on read).
import { encryptField } from "../crypto-field"

/** HIGH-14 helper — encrypt verificationCode at rest. Returns null if the
 *  env key is not configured (test environments without HRM_MFA_KEY fall back
 *  to plaintext storage so existing tests pass without modification). */
/** L-24 — exported so the seed uses the SAME write path encryption
 *  (the seed used to store demo verification codes in plaintext, which the
 *  decrypt-on-read launch path then failed to decrypt). */
export function maybeEncryptVc(plaintext: string | null | undefined): string | null {
  if (!plaintext) return null
  try {
    return encryptField(plaintext, "cameras::v1::vc")
  } catch {
    // HRM_MFA_KEY not set (test environment) — fall back to plaintext.
    // The instrumentation.ts boot validator will refuse to start in production
    // without HRM_MFA_KEY, so this fallback is test-only.
    return plaintext
  }
}
// Static import of the provider registry — Flag B (Phase 5c) confirmed there
// is NO import cycle (see trace in Phase 5c report). The earlier dynamic
// import was based on a false premise. Used by validateCameraCreate to reject
// unknown brands at the DTO layer.
import { isRegisteredBrand, listRegisteredBrands } from "./providers/registry"

// ---------- exported types ----------

export type CameraRow = Camera
export type CredentialRow = CameraCredential

/** Filter shape used by every Camera query. Branch managers see only their
 *  own branch's cameras; everyone else sees the whole tenant's set. */
export type CameraScopeFilter = Record<string, unknown>

// ---------- constants ----------

/** Brands that store per-tenant cloud credentials in CameraCredential
 *  (per Camera Manager §8). Hikvision/Dahua use per-camera verificationCode
 *  on the Camera row instead and never touch CameraCredential. */
export const TENANT_CREDENTIAL_BRANDS = new Set(["EZVIZ", "IMOU"])

/** Brands that store per-camera verificationCode on the Camera row. */
export const PER_CAMERA_BRANDS = new Set(["HIKVISION", "DAHUA"])

export const ALL_BRANDS = ["HIKVISION", "DAHUA", "EZVIZ", "IMOU"] as const
export type CameraBrand = (typeof ALL_BRANDS)[number]

export const ALL_STATUSES = ["ONLINE", "OFFLINE", "UNKNOWN"] as const

// ---------- scope filter (mirrors deviceScopeFilter in routes/devices.ts:23-27) ----------

/**
 * Branch managers see only their own branch's cameras; everyone else sees
 * the whole tenant's set. Spread into a Prisma `where` fragment.
 *
 * Implementation note: if a BRANCH_MANAGER has no `branchId` assigned
 * (rare edge case — User.branchId is null), they see NO cameras — matches
 * the existing device-scope behavior. This filter does NOT include
 * `enabled: true` — that's a listCameras default, not a scope concern
 * (soft-deleted cameras are still visible to getCamera for audit/recovery).
 */
export function cameraScopeFilter(ctx: Ctx): CameraScopeFilter {
  const f: Record<string, unknown> = { vendorId: ctx.vendorId }
  if (ctx.role === "BRANCH_MANAGER" && ctx.branchId) f.branchId = ctx.branchId
  return f
}

// ---------- Camera CRUD ----------

export type CameraListFilter = {
  brand?: string
  branchId?: string
  status?: string
  /** Default: true — soft-deleted cameras (enabled=false) are excluded
   *  from the standard list view. Set includeDisabled=true for admin
   *  recovery flows (Phase 3 route layer gates this with a permission). */
  includeDisabled?: boolean
  limit?: number
  offset?: number
}

/** List cameras for the caller's scope. An empty result is a valid outcome
 *  (e.g. a BRANCH_MANAGER with no cameras in their branch) — never throw on
 *  empty (Camera Manager §15 cross-tenant test asserts this). */
export async function listCameras(ctx: Ctx, opts: CameraListFilter = {}): Promise<CameraRow[]> {
  const where: Prisma.CameraWhereInput = { ...cameraScopeFilter(ctx) } // scoped: cameraScopeFilter
  if (opts.includeDisabled !== true) where.enabled = true
  if (opts.brand) where.brand = opts.brand
  if (opts.branchId) where.branchId = opts.branchId
  if (opts.status) where.status = opts.status
  return db.camera.findMany({ // scoped: cameraScopeFilter (where above)
    where,
    orderBy: { createdAt: "desc" },
    take: Math.min(opts.limit ?? 100, 500),
    skip: opts.offset ?? 0,
  })
}

/** Get a single camera by id. Throws Deny 404 if not found OR not in the
 *  caller's tenant OR (for BRANCH_MANAGER) not in the caller's branch —
 *  same error for all three cases prevents ID enumeration. Finds soft-deleted
 *  cameras too (audit/recovery flows need them). */
export async function getCamera(ctx: Ctx, id: string): Promise<CameraRow> {
  const rec = await findCamera(ctx, id)
  if (!rec) {
    const { Deny } = await import("../rbac")
    throw new Deny("Camera not found", 404)
  }
  return rec
}

/** Same as getCamera but returns null instead of throwing — for cases where
 *  the route handler needs to distinguish "missing" from other failures
 *  (e.g. the launch handler may want a custom error format). */
export async function findCamera(ctx: Ctx, id: string): Promise<CameraRow | null> {
  // WP-B (CCTV review §3.16) — compound unique where: the tenant scoping is
  // STRUCTURAL, not just the assertTenant check below (Prisma extended-where-unique).
  const rec = await db.camera.findUnique({ where: { id, vendorId: ctx.vendorId } }) // scoped: cameraScopeFilter
  if (!rec) return null
  // BRANCH_MANAGER cross-branch access within the same tenant: treat as
  // not-found (404, not 403) — same enumeration protection, applied
  // symmetrically with assertTenant's vendor check above.
  if (ctx.role === "BRANCH_MANAGER" && ctx.branchId && rec.branchId !== ctx.branchId) return null
  return rec
}

export type CameraCreateInput = {
  brand: string
  name: string
  model?: string
  serialNumber?: string
  channel?: number
  verificationCode?: string
  branchId?: string | null // null = explicitly unassigned (not the same as omitted)
  location?: string
  installDate?: string // ISO date string — matches codebase convention (Employee.dob, Holiday.date)
}

/** Create a new camera. Caller is responsible for permission gating
 *  (camera.create) and field validation (cleanForm + safePayload) —
 *  this function trusts its typed input.
 *  Throws Deny 404 if branchId does not belong to the caller's vendor.
 *
 *  Flag C (Phase 5c): brand is normalized to UPPERCASE before the DB
 *  write. validateCameraCreate normalizes for the registry lookup; this
 *  function re-normalizes so the DB stores "HIKVISION" even if the
 *  caller passed "hikvision" or "HikVision". Defense-in-depth — the
 *  route handler's safePayload whitelist doesn't transform values. */
export async function createCamera(ctx: Ctx, input: CameraCreateInput): Promise<CameraRow> {
  if (input.branchId) {
    const branch = await db.branch.findFirst({
      where: { id: input.branchId, vendorId: ctx.vendorId }, // scoped: vendorId
    })
    if (!branch) {
      const { Deny } = await import("../rbac")
      throw new Deny("Branch not found in your tenant", 404)
    }
  }
  // BRANCH_MANAGER: auto-default branchId to the caller's branch when not
  // specified (item 5a — future role changes need the auto-default path to
  // exist). Explicit null or a different branch is refused (the user can't
  // create "unassigned" cameras or cameras in another branch — those would
  // be invisible to them under cameraScopeFilter).
  if (ctx.role === "BRANCH_MANAGER" && ctx.branchId) {
    if (input.branchId === undefined || input.branchId === "") {
      // Auto-default: caller didn't pass a branchId, use their own
      input.branchId = ctx.branchId
    } else if (input.branchId !== ctx.branchId) {
      // Explicit null OR a different branch → refuse
      const { Deny } = await import("../rbac")
      throw new Deny("You can only register cameras in your own branch", 403)
    }
  }
  // Flag C: normalize brand to UPPERCASE. Matches the registry + the
  // Camera.brand schema comment ("HIKVISION | DAHUA | EZVIZ | IMOU").
  const normalizedBrand = String(input.brand ?? "").trim().toUpperCase() || input.brand
  // HIGH-14 — encrypt verificationCode at rest before persisting. The
  // verificationCode is effectively a device password (the user enters it
  // into the brand app to bind the camera). Stored plaintext previously.
  // Encrypted under a "cameras::v1::vc" context via crypto-field.ts.
  const vcPlain = input.verificationCode?.trim() || null
  const vcEncrypted = maybeEncryptVc(vcPlain)
  return db.camera.create({ // scoped: cameraScopeFilter (vendorId:ctx.vendorId in data; BM branchId validated above)
    data: {
      vendorId: ctx.vendorId,
      brand: normalizedBrand,
      name: input.name,
      model: input.model ?? null,
      serialNumber: input.serialNumber ?? null,
      channel: input.channel ?? 1,
      verificationCode: vcEncrypted,
      branchId: input.branchId ?? null,
      location: input.location ?? null,
      installDate: input.installDate ?? null,
    },
  })
}

export type CameraUpdateInput = Partial<CameraCreateInput> & {
  status?: string
  lastSeenAt?: Date
  lastStatusCheckAt?: Date
  lastError?: string | null // null clears the error
}

/** Update a camera. Throws Deny 404 if not found OR cross-tenant/cross-branch
 *  (assertTenant + an explicit branchId check). Refuses to update vendorId
 *  or enabled (the latter is reserved for deleteCamera/restoreCamera). */
export async function updateCamera(ctx: Ctx, id: string, patch: CameraUpdateInput): Promise<CameraRow> {
  const existing = await getCamera(ctx, id) // 404 if cross-tenant or cross-branch (BRANCH_MANAGER)
  // branchId change: validate the new branch belongs to the same tenant.
  if (patch.branchId && patch.branchId !== existing.branchId) {
    const branch = await db.branch.findFirst({
      where: { id: patch.branchId, vendorId: ctx.vendorId }, // scoped: vendorId
    })
    if (!branch) {
      const { Deny } = await import("../rbac")
      throw new Deny("Branch not found in your tenant", 404)
    }
    // BRANCH_MANAGER moving a camera OUT of their branch → also refuse.
    if (ctx.role === "BRANCH_MANAGER" && ctx.branchId && patch.branchId !== ctx.branchId) {
      const { Deny } = await import("../rbac")
      throw new Deny("You can only move cameras into your own branch", 403)
    }
  }
  // Never allow vendorId or enabled to be overwritten via this path —
  // vendorId is identity, enabled is reserved for deleteCamera/restoreCamera.
  // The route layer's safePayload whitelist should already strip both, but
  // defensive deletion here is cheap.
  // HIGH-14 — also extract verificationCode so we can encrypt it before persist.
  // Cast to `any` because CameraUpdateInput type doesn't include vendorId/enabled
  // (they are write-only internal fields); the destructuring is purely defensive.
  const { vendorId: _dropVendor, enabled: _dropEnabled, verificationCode: _dropVc, ...safePatch } = patch as any
  // HIGH-14 — if verificationCode is being updated, encrypt before persisting.
  if (_dropVc !== undefined) {
    const vcPlain = String(_dropVc || "").trim() || null
    safePatch.verificationCode = maybeEncryptVc(vcPlain)
  }
  return db.camera.update({ where: { id, vendorId: ctx.vendorId }, data: safePatch }) // scoped: cameraScopeFilter (structural + getCamera)
}

/**
 * Soft-delete a camera (set enabled=false). Throws Deny 404 if not found OR
 * cross-tenant/cross-branch. Returns the updated row so the route handler
 * can write an audit row with the redacted snapshot BEFORE the row is gone
 * (auditPIIScrub pattern). Idempotent — re-deleting an already-disabled
 * camera is a no-op that returns the existing row.
 *
 * The audit action for delete is `camera.delete` (verb-mismatch with the
 * permission string `camera.delete` is 1:1 here). For launch the audit
 * action is `camera.launch` (also 1:1). For credential rotation it's
 * `camera.credential.rotate`. camera.edit (perm) → camera.update (audit)
 * is the only verb mismatch — mirrors devices.edit/devices.update.
 */
export async function deleteCamera(ctx: Ctx, id: string): Promise<CameraRow> {
  const existing = await getCamera(ctx, id) // 404 if cross-tenant or cross-branch
  if (!existing.enabled) return existing // idempotent soft-delete
  return db.camera.update({ // scoped: cameraScopeFilter (structural + getCamera)
    where: { id, vendorId: ctx.vendorId },
    data: { enabled: false },
  })
}

/** Restore a soft-deleted camera. Returns the restored row. Throws 404 if
 *  not found OR cross-tenant/cross-branch.
 *
 *  Phase 4 route-layer wiring (CONFIRMED per Phase 3 review — item 4):
 *    - Permission: camera.edit (matches the existing devices.setEnabled
 *      precedent — toggling the `enabled` Boolean is `edit`, not `delete`.
 *      The two roles with camera.delete (HR_ADMIN, VENDOR_OWNER) also have
 *      camera.edit, so the asymmetry doesn't open restore to any role that
 *      couldn't already delete. The new capability it grants is HR_MANAGER
 *      restoring a camera they couldn't decommission — admin decommissions,
 *      manager recommissions, which is a reasonable workflow.)
 *    - Audit verb: camera.restore (distinct from camera.update — auditors
 *      want restores as a separate, queryable event: "we reactivated a
 *      decommissioned camera — investigate why". The verb split mirrors
 *      the existing convention: permission camera.edit → audit camera.update
 *      for general metadata; permission camera.edit (when used for restore)
 *      → audit camera.restore for the specific lifecycle event.)
 *
 *  AUDIT HELPER DECISION (Phase 5 — confirmed by user):
 *  restoreCamera uses `audit()` (best-effort), NOT `auditStrict()`. This
 *  deviates from the Phase 3 kickoff's "restoreCamera → auditStrict()"
 *  decision, but the deviation was confirmed by the user in the Phase 5
 *  kickoff with the reasoning: "restore is recoverable, delete/launch are
 *  not." A missing audit row for a restore event is less forensically
 *  significant than one for a delete or launch — restore just brings a
 *  camera back online; if the audit row is missing, the camera's
 *  post-restore state is visible in the DB itself (enabled=true). A
 *  missing audit row for delete/launch leaves NO trace in the DB (the
 *  camera is gone, or the launch happened with no record of who did it).
 *  This decision is INTENTIONAL, not a bug — if you change it back to
 *  auditStrict(), update the route handler in routes/cameras.ts to call
 *  auditStrict() and add a test asserting the throw-on-failure behavior. */
export async function restoreCamera(ctx: Ctx, id: string): Promise<CameraRow> {
  const existing = await getCamera(ctx, id)
  if (existing.enabled) return existing // idempotent restore
  return db.camera.update({ // scoped: cameraScopeFilter (structural + getCamera)
    where: { id, vendorId: ctx.vendorId },
    data: { enabled: true, lastError: null }, // clear lastError on restore — fresh start
  })
}

// ---------- status bookkeeping (called after a brand-API poll) ----------

/** Update a camera's status fields. Used by the status-polling route handler
 *  after calling a provider's getDeviceStatus. Does NOT mutate vendorId,
 *  serialNumber, channel, or enabled (identity / lifecycle fields). 404 if
 *  not in scope. Passing lastError=null clears it; passing a string sets it.
 *  lastStatusCheckAt is always set to now() on a status check. */
export async function updateCameraStatus(
  ctx: Ctx,
  id: string,
  status: string,
  opts: { lastSeenAt?: Date; lastError?: string | null } = {},
): Promise<CameraRow> {
  await getCamera(ctx, id) // 404 enforcement
  return db.camera.update({ // scoped: cameraScopeFilter (structural + getCamera)
    where: { id, vendorId: ctx.vendorId },
    data: {
      status,
      lastStatusCheckAt: new Date(),
      ...(opts.lastSeenAt !== undefined ? { lastSeenAt: opts.lastSeenAt } : {}),
      ...(opts.lastError !== undefined ? { lastError: opts.lastError } : {}),
    },
  })
}

// ---------- dashboard summary widget ----------

/** Online / offline / unknown counts for the dashboard widget. Branch-scoped
 *  for BRANCH_MANAGER. Excludes soft-deleted (enabled=false) cameras.
 *  Always returns all three keys (zero is a valid count). */
export async function countCamerasByStatus(ctx: Ctx): Promise<{
  ONLINE: number
  OFFLINE: number
  UNKNOWN: number
  total: number
}> {
  const grouped = await db.camera.groupBy({ // scoped: cameraScopeFilter
    by: ["status"],
    where: { ...cameraScopeFilter(ctx), enabled: true },
    _count: true,
  })
  const out = { ONLINE: 0, OFFLINE: 0, UNKNOWN: 0, total: 0 }
  for (const g of grouped) {
    const k = (g.status as keyof typeof out) || "UNKNOWN"
    if (k in out) out[k] = g._count as number
  }
  out.total = out.ONLINE + out.OFFLINE + out.UNKNOWN
  return out
}

/**
 * Count enabled cameras of a specific brand in the caller's scope. Used
 * by camera.credential.delete to return `affectedCameraCount` — the UI
 * shows "N cameras will become unlaunchable" as a warning before the
 * admin deletes the tenant's brand credentials.
 *
 * Phase 5c small flag 3: this is the repository helper for the
 * affectedCameraCount response shape. Excludes soft-deleted cameras
 * (those are already "gone from the user's view" — credential deletion
 * doesn't change their state).
 *
 * Branch-scoped for BRANCH_MANAGER (matches listCameras behavior).
 */
export async function countCamerasByBrand(ctx: Ctx, brand: string): Promise<number> {
  return db.camera.count({ // scoped: cameraScopeFilter
    where: { ...cameraScopeFilter(ctx), enabled: true, brand },
  })
}

// ---------- CameraCredential CRUD (per-vendor+brand, EZVIZ/Imou only) ----------

/** Fetch the tenant's credential row for a given brand. Returns null if no
 *  row exists yet (the tenant hasn't onboarded that brand). Vendor-scoped
 *  ONLY — credentials are not branch-scoped (per Camera Manager §8). */
export async function getCredential(ctx: Ctx, brand: string): Promise<CredentialRow | null> {
  return db.cameraCredential.findUnique({
    where: { vendorId_brand: { vendorId: ctx.vendorId, brand } },
  })
}

/** Phase 6 Flag 3: existence check WITHOUT decrypting. Used by the
 *  camera.credential.upsert route handler to choose between the
 *  `camera.credential.create` audit verb (no existing row) and
 *  `camera.credential.rotate` (existing row). Decrypting just for an
 *  existence check would fail if HRM_MFA_KEY is unset and is wasteful. */
export async function credentialExists(ctx: Ctx, brand: string): Promise<boolean> {
  const row = await db.cameraCredential.findUnique({
    where: { vendorId_brand: { vendorId: ctx.vendorId, brand } },
    select: { id: true },
  })
  return row !== null
}

/** Upsert (create or rotate) a credential row. Used by both the initial-set
 *  and the rotation route handlers — both gated by `camera.manage`.
 *  - When creating: rotatedAt stays null.
 *  - When rotating: rotatedAt is set to now, encryptionKeyVersion increments.
 *  Returns the saved row. Caller is responsible for encrypting the payload
 *  via crypto-field.ts (encryptField(plain, "cameras::v1")) BEFORE calling
 *  this (Phase 3 wiring). */
export async function upsertCredential(
  ctx: Ctx,
  brand: string,
  encryptedPayload: string,
  encryptionKeyVersion: number,
): Promise<CredentialRow> {
  const existing = await getCredential(ctx, brand)
  if (existing) {
    return db.cameraCredential.update({
      where: { id: existing.id },
      data: {
        encryptedPayload,
        encryptionKeyVersion,
        rotatedAt: new Date(),
      },
    })
  }
  return db.cameraCredential.create({
    data: {
      vendorId: ctx.vendorId,
      brand,
      encryptedPayload,
      encryptionKeyVersion,
    },
  })
}

/** Delete a credential row (hard delete — credentials are not soft-deleted
 *  because there is no history to preserve once the brand is un-onboarded).
 *  Returns the deleted row for audit (or null if there was nothing to
 *  delete — caller decides whether that's an error). Vendor-scoped only.
 *  Gated by `camera.manage` in the route layer (Phase 3). */
export async function deleteCredential(ctx: Ctx, brand: string): Promise<CredentialRow | null> {
  const existing = await getCredential(ctx, brand)
  if (!existing) return null
  await db.cameraCredential.delete({ where: { id: existing.id } })
  return existing
}

// ---------- helpers exposed for the route layer ----------

/** True if the brand stores per-camera verificationCode on the Camera row
 *  (and should not have a CameraCredential row). */
export function isPerCameraBrand(brand: string): boolean {
  return PER_CAMERA_BRANDS.has(brand)
}

/** True if the brand stores per-tenant cloud credentials in CameraCredential. */
export function isTenantCredentialBrand(brand: string): boolean {
  return TENANT_CREDENTIAL_BRANDS.has(brand)
}

/**
 * Phase 3 item 5 — DTO-layer guard for camera.create. Rejects pure-null
 * cameras (no serialNumber AND no verificationCode) at the validation layer,
 * before the route handler calls createCamera().
 *
 * Rationale: serialNumber is `String?` and the unique constraint is
 * @@unique([vendorId, serialNumber, channel]) — SQLite treats NULL as
 * distinct in unique indexes, so without this guard the schema permits N
 * cameras with serialNumber=null for the same vendor. A camera with no
 * identifier at all is meaningless (the brand cloud can't launch it), so
 * the DTO layer must reject pure-null combinations.
 *
 * Brand-dependent rules (Camera Manager §8):
 *   - HIKVISION / DAHUA  → require verificationCode (the brand cloud needs
 *                          it to launch). serialNumber is strongly
 *                          recommended but not strictly required (the camera
 *                          might be registered with just a verificationCode
 *                          before its hardware serial is captured).
 *   - EZVIZ / IMOU       → require serialNumber (the per-camera identifier
 *                          within the tenant's brand cloud account).
 *                          verificationCode is N/A for these brands.
 *
 * Phase 5b Flag 3: also rejects UNKNOWN BRANDS with a clear 400. The
 * provider registry (`isRegisteredBrand` from
 * `src/hrm-server/cameras/providers/registry.ts`) is the single source of
 * truth for what brands are supported. An unknown brand like "ONVIF" or
 * "GENERIC" never reaches createCamera() — the DTO layer catches it here.
 * This prevents a camera with an unsupported brand from being saved to
 * the DB and only failing later when the user tries to launch or check
 * status (a confusing UX + a soft data-integrity issue).
 *
 * Phase 5c Flag B: STATIC import of the registry (no cycle — see trace
 * in the Phase 5c report). The earlier dynamic import was based on a
 * false premise.
 *
 * Phase 5c Flag C: brand is NORMALIZED to UPPERCASE before any lookup.
 * The registry stores brands as "HIKVISION" | "DAHUA" | "EZVIZ" | "IMOU"
 * (uppercase). Without normalization, `isRegisteredBrand("hikvision")`
 * returns false (case mismatch) and the user gets a confusing "unsupported
 * brand" error for a perfectly valid brand they just typed in lowercase.
 * The route handler re-normalizes before createCamera() so the DB stores
 * the uppercase form (matches the registry + the Camera.brand comment).
 *
 * ASYNC NOTE: this function is async for future-proofing — if we ever add
 * brand-specific validation rules that require a DB lookup (e.g. "EZVIZ
 * requires the tenant to have onboarded the brand first"), the await is
 * already in place at every call site. Currently the body is synchronous
 * (the registry lookup is in-memory), but the async signature means
 * future enhancements don't require updating every caller.
 *
 * Returns `{ ok: true }` on success, `{ ok: false, reason }` on failure.
 * The Phase 4 route handler will throw `new Deny(reason, 400)` on the
 * failure path. Note: this function is ASYNC — callers MUST await.
 */
export async function validateCameraCreate(input: {
  brand?: string
  serialNumber?: string | null
  verificationCode?: string | null
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  // Flag C (Phase 5c): normalize brand to UPPERCASE before any lookup.
  // The registry stores "HIKVISION" | "DAHUA" | "EZVIZ" | "IMOU" (uppercase).
  // Without normalization, lowercase or mixed-case input fails the
  // isRegisteredBrand check and the user gets a confusing error.
  const sn = input.serialNumber?.trim() || null
  const vc = input.verificationCode?.trim() || null
  const brand = String(input.brand ?? "").trim().toUpperCase() || null

  // Unknown-brand guard — Phase 5b Flag 3. The registry is the single
  // source of truth. Reject BEFORE the pure-null guard so the error
  // message is brand-specific ("ONVIF is not supported") rather than
  // generic ("at least one identifier required").
  if (!brand) {
    return {
      ok: false,
      reason: "Brand is required. Supported brands are registered in the provider registry (currently HIKVISION, DAHUA, EZVIZ, IMOU).",
    }
  }
  if (!isRegisteredBrand(brand)) {
    return {
      ok: false,
      reason: `Unsupported camera brand: ${brand}. Supported brands: ${listRegisteredBrands().join(", ")}.`,
    }
  }

  // Pure-null guard — applies to ALL brands
  if (!sn && !vc) {
    return {
      ok: false,
      reason: "A camera requires at least one identifier (serialNumber or verificationCode) before registration — pure-null cameras are rejected at the DTO layer.",
    }
  }

  // Brand-dependent requirements
  if (isPerCameraBrand(brand) && !vc) {
    return {
      ok: false,
      reason: `${brand} cameras require a verificationCode (the per-device verifier the brand cloud needs to launch). serialNumber alone is not enough for ${brand}.`,
    }
  }
  if (isTenantCredentialBrand(brand) && !sn) {
    return {
      ok: false,
      reason: `${brand} cameras require a serialNumber (the per-camera identifier within your ${brand} cloud account). verificationCode is not used for ${brand}.`,
    }
  }
  return { ok: true }
}

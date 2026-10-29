// ============ Camera Manager route handlers (spec Camera Manager §9) ============
// All routes go through the central RPC dispatcher at POST /api/hrm — the
// `route()` calls below register handlers in the routes/registry. Each
// handler enforces (in order):
//   1. Permission check (auto via `perm: [...]` on the route def)
//   2. cleanForm(p) + safePayload(p, ALLOWED_FIELDS) — legacy DTO convention
//      per Camera Manager Phase 1 decision (HYBRID: server uses legacy,
//      client uses react-hook-form + zodResolver)
//   3. cameraScopeFilter(ctx) on every db.camera.* call (// scoped: … comment)
//   4. assertTenant(rec, ctx) → 404 (not 403) on point lookups
//   5. audit() / auditStrict() per Camera Manager §10:
//        - audit (best-effort): camera.create, camera.update, camera.restore
//        - auditStrict (throws): camera.delete, camera.launch, camera.credential.*
//
// See src/hrm/CONVENTIONS.md and src/hrm/API.md for broader app conventions.
import { db } from "@/lib/db"
import { route } from "./registry"
import { Deny, can } from "../rbac"
import { audit, auditStrict } from "../audit"
import { rateLimit } from "../security"
import { safePayload } from "../security"
import {
  listCameras, getCamera, createCamera, updateCamera, deleteCamera, restoreCamera,
  updateCameraStatus, countCamerasByStatus, countCamerasByBrand,
  validateCameraCreate, isTenantCredentialBrand,
  credentialExists, cameraScopeFilter, TENANT_CREDENTIAL_BRANDS,
} from "../cameras/repository"
import {
  upsertCredential, getCredential, deleteCredential,
} from "../cameras/credentials"
import { getProvider } from "../cameras/providers/registry"

// ---------- publicCamera: strip sensitive fields before returning to UI ----------
// Mirrors publicDevice in routes/devices.ts:33. verificationCode is the
// per-camera verifier for Hikvision/Dahua — it's WRITE-ONLY (shown once at
// registration, then stripped from every list/get response). The UI badge
// uses hasVerificationCode to indicate enrollment state.

function publicCamera(d: any) {
  const { verificationCode: _vc, ...rest } = d
  return {
    ...rest,
    hasVerificationCode: !!_vc,
  }
}

// ---------- throttle keys (Camera Manager §C2) ----------

function cameraThrottleKeys(vendorId: string, cameraId: string): string[] {
  return [
    `camera:launch:${vendorId}:${cameraId}`,  // per-camera (targeted abuse)
    `camera:launch:${vendorId}`,               // per-tenant aggregate (catch hammering tenant)
  ]
}

// Allowed rate: 30 launches/min per camera, 120/min per tenant aggregate.
// Tunable — these are conservative defaults for v1.
const LAUNCH_RATE_PER_CAMERA = 30
const LAUNCH_RATE_PER_TENANT = 120
const LAUNCH_RATE_WINDOW_MS = 60_000

// ---------- DTO whitelists (per-route safePayload field lists) ----------

const CAMERA_CREATE_FIELDS = [
  "brand", "name", "model", "serialNumber", "channel", "verificationCode",
  "branchId", "location", "installDate",
]
// HIGH-15 (this audit) — `status` removed from camera.update safePayload.
// The previous list allowed any user with camera.edit to spoof ONLINE on
// offline cameras, misleading operators. Status is now set only via the
// dedicated camera.setStatus route (perm: camera.manage) which requires
// an explicit reason and is audit-logged as a manual override.
const CAMERA_UPDATE_FIELDS = [
  "name", "model", "serialNumber", "channel", "verificationCode",
  "branchId", "location", "installDate",
]

// ============================================================
// HIGH-15 (this audit) — camera.setStatus — perm: camera.manage
// Separate route for manual status override. Requires an explicit reason
// (3-char min) and is audit-logged as a manual override so operators can
// distinguish provider-reported status from admin overrides.
// ============================================================

route("camera.setStatus", {
  perm: ["camera", "manage"],
  handler: async (ctx, p) => {
    if (!p?.id) throw new Deny("Camera id is required", 400)
    const status = String(p.status || "").toUpperCase()
    if (!["ONLINE", "OFFLINE", "UNKNOWN"].includes(status)) {
      throw new Deny("status must be one of: ONLINE, OFFLINE, UNKNOWN", 400)
    }
    const reason = String(p.reason || "").trim()
    if (reason.length < 3) {
      throw new Deny("A reason (min 3 chars) is required for manual status override — this is audit-logged", 400)
    }
    const existing = await getCamera(ctx, p.id) // assertTenant → 404 if cross-tenant
    if (!existing.enabled) throw new Deny("Camera not found", 404)
    const updated = await updateCamera(ctx, p.id, { status } as any)
    await auditStrict(ctx, "camera.setStatus", "Camera", updated.id,
      `Manual status override → ${status} (reason: ${reason.slice(0, 120)})`,
      { oldValue: { status: existing.status }, newValue: { status, reason } })
    return publicCamera(updated)
  },
})


// ============================================================
// camera.list — perm: camera.view
// ============================================================

route("camera.list", {
  perm: ["camera", "view"],
  handler: async (ctx, p) => {
    const filter = safePayload<{ brand?: string; branchId?: string; status?: string; includeDisabled?: boolean; limit?: number; offset?: number }>(
      p,
      ["brand", "branchId", "status", "includeDisabled", "limit", "offset"],
      { numericFields: ["limit", "offset"], boolFields: ["includeDisabled"] },
    )
    // L-25 — includeDisabled (soft-deleted / disabled cameras) is an
    // ADMIN-RECOVERY view, not a standard listing: it requires camera.edit.
    // Everyone else silently gets the enabled-only list.
    if (filter.includeDisabled && !ctx.permissions.has("camera.edit")) {
      filter.includeDisabled = false
    }
    // CCTV-10 (this audit) — the previous route did not surface total count,
    // so the UI silently truncated at 100 rows. Now the response includes both
    // the page rows AND a total so the UI can render "showing 1-50 of 437".
    const cameras = await listCameras(ctx, filter)
    const totalCount = await db.camera.count({
      where: {
        ...cameraScopeFilter(ctx),
        ...(filter.includeDisabled !== true ? { enabled: true } : {}),
        ...(filter.brand ? { brand: filter.brand } : {}),
        ...(filter.branchId ? { branchId: filter.branchId } : {}),
        ...(filter.status ? { status: filter.status } : {}),
      },
    })
    return {
      cameras: cameras.map(publicCamera),
      counts: await countCamerasByStatus(ctx),
      pagination: {
        limit: filter.limit ?? 100,
        offset: filter.offset ?? 0,
        total: totalCount,
        hasMore: (filter.offset ?? 0) + cameras.length < totalCount,
      },
    }
  },
})

// ============================================================
// camera.get — perm: camera.view
// ============================================================

route("camera.get", {
  perm: ["camera", "view"],
  handler: async (ctx, p) => {
    const { id } = safePayload<{ id: string }>(p, ["id"])
    if (!id) throw new Deny("Camera id is required", 400)
    const cam = await getCamera(ctx, id) // assertTenant → 404 if cross-tenant
    return publicCamera(cam)
  },
})

// ============================================================
// camera.create — perm: camera.create
// Item 4 (Phase 4 kickoff): HR_MANAGER (has camera.create but NOT camera.manage)
// can onboard Hikvision/Dahua but NOT EZVIZ/Imou (which require tenant creds +
// camera.manage to set them). Reject EZVIZ/Imou for callers without camera.manage.
// ============================================================

route("camera.create", {
  perm: ["camera", "create"],
  handler: async (ctx, p) => {
    const input = safePayload<any>(p, CAMERA_CREATE_FIELDS, { numericFields: ["channel"] })
    if (!input.brand) throw new Deny("Brand is required", 400)
    if (!input.name) throw new Deny("Camera name is required", 400)

    // Item 4 (Phase 4 kickoff): HR_MANAGER (has camera.create but NOT camera.manage)
    // can onboard Hikvision/Dahua but NOT EZVIZ/Imou (which require tenant creds +
    // camera.manage to set them). Reject EZVIZ/Imou for callers without camera.manage.
    //
    // Flag 2 (Phase 5 kickoff): use can(ctx, "camera", "manage") — NOT
    // ctx.permissions.has("camera.manage"). Reason: can() applies the SAME
    // resolution logic the route dispatcher uses at src/app/api/hrm/route.ts:154-160
    // (require()). Both currently check ctx.permissions.has(...) under the hood,
    // but if the resolution logic ever changes (e.g. role-template overrides,
    // time-limited grants, ABAC), can() picks up the change automatically while
    // the direct set-membership check would silently drift. Defense-in-depth
    // against future RBAC divergence.
    if (isTenantCredentialBrand(input.brand) && !can(ctx, "camera", "manage")) {
      throw new Deny(
        `Onboarding ${input.brand} cameras requires camera.manage permission. ${input.brand} uses per-tenant cloud credentials that only tenant admins can configure.`,
        403,
      )
    }

    // Item 5: pure-null camera rejection at the DTO layer (Phase 3 item 5)
    // + Flag 3 (Phase 5b): unknown-brand rejection via the registry.
    // validateCameraCreate is async (dynamic-imports the registry to avoid
    // a static import cycle).
    const validation = await validateCameraCreate(input)
    if (!validation.ok) throw new Deny(validation.reason, 400)

    const rec = await createCamera(ctx, input)
    await audit(ctx, "camera.create", "Camera", rec.id, `Registered ${rec.brand} camera '${rec.name}'${rec.serialNumber ? ` (SN ${rec.serialNumber})` : ""}`, {
      newValue: publicCamera(rec),
    })
    return publicCamera(rec)
  },
})

// ============================================================
// camera.update — perm: camera.edit  (audit: camera.update — verb split per §11)
// ============================================================

route("camera.update", {
  perm: ["camera", "edit"],
  handler: async (ctx, p) => {
    const patch = safePayload<any>(p, CAMERA_UPDATE_FIELDS, { numericFields: ["channel"] })
    if (!p?.id) throw new Deny("Camera id is required", 400)
    // Fetch existing for the audit diff (BEFORE the update)
    const existing = await getCamera(ctx, p.id) // assertTenant → 404 if cross-tenant
    // Flag 4a (Phase 5b): update on a soft-deleted camera → 404 (consistent
    // with launch/status). Soft-deleted cameras are "gone from the user's
    // view" — restore it first to make metadata changes.
    if (!existing.enabled) throw new Deny("Camera not found", 404)
    const updated = await updateCamera(ctx, p.id, patch)
    await audit(ctx, "camera.update", "Camera", updated.id, `Updated camera '${updated.name}'`, {
      oldValue: publicCamera(existing),
      newValue: publicCamera(updated),
    })
    return publicCamera(updated)
  },
})

// ============================================================
// camera.restore — perm: camera.edit  (audit: camera.restore — distinct verb per item 4 confirmation)
// Soft-delete inverse: re-enables a camera (enabled=false → true), clears lastError.
// ============================================================

route("camera.restore", {
  perm: ["camera", "edit"],
  handler: async (ctx, p) => {
    const { id } = safePayload<{ id: string }>(p, ["id"])
    if (!id) throw new Deny("Camera id is required", 400)
    const existing = await getCamera(ctx, id) // 404 if cross-tenant OR cross-branch
    const wasSoftDeleted = !existing.enabled
    const restored = await restoreCamera(ctx, id)
    // Flag 4b (Phase 5b): idempotent restore on an already-enabled camera
    // is a NO-OP — no DB write happened (restoreCamera short-circuits),
    // no audit row should be written (nothing actually changed). Only
    // audit when an actual state change happened (camera was soft-deleted).
    if (wasSoftDeleted) {
      // audit (best-effort, not auditStrict) — see restoreCamera JSDoc in
      // repository.ts:265–278 for the audit() vs auditStrict() decision.
      await audit(ctx, "camera.restore", "Camera", restored.id, `Restored camera '${restored.name}' (was soft-deleted)`, {
        oldValue: { enabled: existing.enabled, lastError: existing.lastError },
        newValue: { enabled: restored.enabled, lastError: restored.lastError },
      })
    }
    return publicCamera(restored)
  },
})

// ============================================================
// camera.delete — perm: camera.delete  (auditStrict: camera.delete)
// Soft-delete (sets enabled=false, preserves history). auditStrict throws
// on failure so a missing forensic row is never silently swallowed.
// ============================================================

route("camera.delete", {
  perm: ["camera", "delete"],
  handler: async (ctx, p) => {
    const { id } = safePayload<{ id: string }>(p, ["id"])
    if (!id) throw new Deny("Camera id is required", 400)
    const existing = await getCamera(ctx, id) // 404 if cross-tenant
    const deleted = await deleteCamera(ctx, id)
    // auditStrict — throws on failure (Camera Manager §10)
    await auditStrict(ctx, "camera.delete", "Camera", deleted.id, `Soft-deleted camera '${deleted.name}'`, {
      oldValue: publicCamera(existing),
      newValue: { enabled: false },
    })
    return publicCamera(deleted)
  },
})

// ============================================================
// camera.launch — perm: camera.launch  (auditStrict + rate limit)
// Calls the brand provider's getLaunchTarget. Returns { launchTarget, fallbackWebUrl }.
// Rate-limited per camera AND per tenant (Camera Manager §8 + §C2).
//
// Flag 3c (Phase 5): launch on a soft-deleted camera → 404. The user's
// confirmed lean: "soft-deleted cameras are gone from the user's view".
// Launching a decommissioned camera is meaningless; restore it first.
// This applies to launch AND status; restore/delete are exempt (restore
// IS the un-delete; delete is idempotent soft-delete).
// ============================================================

route("camera.launch", {
  perm: ["camera", "launch"],
  handler: async (ctx, p) => {
    const { id } = safePayload<{ id: string }>(p, ["id"])
    if (!id) throw new Deny("Camera id is required", 400)

    // Rate limit — Camera Manager §8 + §C2
    const keys = cameraThrottleKeys(ctx.vendorId, id)
    if (
      await rateLimit(keys[0], LAUNCH_RATE_PER_CAMERA, LAUNCH_RATE_WINDOW_MS) ||
      await rateLimit(keys[1], LAUNCH_RATE_PER_TENANT, LAUNCH_RATE_WINDOW_MS)
    ) {
      throw new Deny("Too many launch attempts — wait a minute and try again", 429)
    }

    const camera = await getCamera(ctx, id) // 404 if cross-tenant OR cross-branch
    // Flag 3c: soft-deleted camera → 404
    if (!camera.enabled) throw new Deny("Camera not found", 404)
    const provider = getProvider(camera.brand)

    // HIGH-14 — decrypt verificationCode for the brand API call. The stored
    // value is AES-256-GCM encrypted under the "cameras::v1::vc" context.
    // If decryption fails (key missing OR corrupt ciphertext), fall back to
    // passing the stored value as-is (test environments without HRM_MFA_KEY
    // store plaintext — production refuses boot without the key).
    let decryptedCamera = camera
    if (camera.verificationCode) {
      try {
        const { decryptField } = await import("../crypto-field")
        const vcPlain = decryptField(camera.verificationCode, "cameras::v1::vc")
        decryptedCamera = { ...camera, verificationCode: vcPlain }
      } catch (e: any) {
        // R4-011 — fail-closed in production: never pass unencrypted/corrupt
        // verificationCode to the brand API. Only dev/test may fall through.
        if (process.env.NODE_ENV === "production") {
          throw new Deny("Camera verification code could not be decrypted — re-encrypt credentials or check HRM_MFA_KEY.", 500)
        }
        // Dev/test: fall back to stored value as-is (may be plaintext)
        if (process.env.NODE_ENV !== "test") {
          console.warn("[camera.launch] verificationCode decrypt failed — passing stored value as-is:", e?.message || e)
        }
      }
    }

    // Fetch tenant creds (only for tenant-credential brands; null for per-camera)
    let tenantCreds = null
    if (isTenantCredentialBrand(camera.brand)) {
      const result = await getCredential(ctx, camera.brand)
      if (!result) {
        throw new Deny(
          `No ${camera.brand} cloud credentials configured for your tenant. An admin with camera.manage must onboard the brand first.`,
          400,
        )
      }
      tenantCreds = result.creds
    }

    // Call the provider
    const launchResult = await provider.getLaunchTarget(decryptedCamera, tenantCreds)

    // auditStrict — forensic-weight event (Camera Manager §10)
    await auditStrict(ctx, "camera.launch", "Camera", camera.id, `Launched ${camera.brand} camera '${camera.name}' (target kind: ${launchResult.launchTarget.kind})`, {})

    return launchResult
  },
})

// ============================================================
// camera.status — perm: camera.view  (calls provider.getDeviceStatus)
// Updates Camera.status + lastStatusCheckAt + lastSeenAt + lastError in the DB.
//
// Flag 1 (Phase 5): even when a provider cannot check status (Hikvision case —
// no cloud API; provider returns last-known), the route STILL sets
// lastStatusCheckAt = now() as a "we tried" marker. UI shows "Last checked: X"
// without implying freshness. Status field stays as-is (provider's return).
//
// Flag 3c (Phase 5): status check on a soft-deleted camera → 404 (same
// principle as launch — soft-deleted cameras are "gone from the user's view").
// This is the user's confirmed lean: "soft-deleted cameras are gone from the
// user's view". Restore (camera.restore) is the way to bring them back.
// ============================================================

route("camera.status", {
  perm: ["camera", "view"],
  handler: async (ctx, p) => {
    const { id } = safePayload<{ id: string }>(p, ["id"])
    if (!id) throw new Deny("Camera id is required", 400)
    const camera = await getCamera(ctx, id) // 404 if cross-tenant OR cross-branch
    // Flag 3c: soft-deleted camera → 404 (consistent with camera.launch)
    if (!camera.enabled) throw new Deny("Camera not found", 404)
    const provider = getProvider(camera.brand)

    // Fetch tenant creds (only for tenant-credential brands)
    let tenantCreds = null
    if (isTenantCredentialBrand(camera.brand)) {
      const result = await getCredential(ctx, camera.brand)
      if (!result) {
        // No creds configured — STILL set lastStatusCheckAt = now() per Flag 1
        // ("we tried" marker), then return UNKNOWN status with an error note.
        const updated = await updateCameraStatus(ctx, id, "UNKNOWN", {
          lastError: `No ${camera.brand} cloud credentials configured`,
        })
        return publicCamera(updated)
      }
      tenantCreds = result.creds
    }

    // Call the provider to get the device status. For Hikvision (per-camera,
    // no cloud API), this returns the stored last-known status. For EZVIZ/Imou,
    // this polls the brand cloud API. Either way, updateCameraStatus sets
    // lastStatusCheckAt = now() per Flag 1.
    const deviceStatus = await provider.getDeviceStatus(camera, tenantCreds)

    // Update the Camera row (status, lastStatusCheckAt=now(), lastSeenAt, lastError)
    const updated = await updateCameraStatus(ctx, id, deviceStatus.status, {
      lastSeenAt: deviceStatus.lastSeenAt ?? undefined,
      lastError: deviceStatus.error ?? null,
    })

    return publicCamera(updated)
  },
})

// ============================================================
// camera.credential.upsert — perm: camera.manage
// EZVIZ/Imou only. Hikvision/Dahua have no tenant creds — rejected.
// Small flag 2 (Phase 5c): rate-limited per tenant (10/min) — both upsert
// AND delete hit the EZVIZ/Imou OAuth endpoint. A hammer loop can get the
// tenant's appKey banned at EZVIZ.
// ============================================================

route("camera.credential.upsert", {
  perm: ["camera", "manage"],
  handler: async (ctx, p) => {
    // Small flag 2: rate-limit per tenant — both upsert and delete hit the
    // brand's OAuth endpoint on next launch/status check (the cache is
    // invalidated on rotation, forcing a fresh /oauth/token). A hammer loop
    // can get the tenant's appKey banned at EZVIZ/Imou.
    if (await rateLimit(`camera:credential:${ctx.vendorId}`, 10, 60_000)) {
      throw new Deny("Too many credential operations — wait a minute and try again", 429)
    }

    const input = safePayload<any>(p, ["brand", "appKey", "appSecret", "appId"])
    if (!input.brand) throw new Deny("Brand is required", 400)

    if (!isTenantCredentialBrand(input.brand)) {
      throw new Deny(
        `${input.brand} cameras do not use tenant credentials. ${input.brand} uses per-camera verificationCode (set on the Camera row, not stored as a tenant credential).`,
        400,
      )
    }

    // Brand-specific credential shape validation
    if (input.brand === "EZVIZ") {
      if (!input.appKey || !input.appSecret) throw new Deny("EZVIZ credentials require appKey and appSecret", 400)
    } else if (input.brand === "IMOU") {
      if (!input.appId || !input.appSecret) throw new Deny("Imou credentials require appId and appSecret", 400)
    }

    // HIGH-13 (this audit) — call validateCredentials() BEFORE persisting.
    // The previous code accepted invalid appKey/appSecret (typos) silently;
    // the failure only surfaced later as UNKNOWN + lastError at first launch.
    // Now: try a /listDevices or /oauth/token probe and return inline errors.
    // validateCredentials is optional per provider; brands that don't implement
    // it (Hikvision/Dahua per-request) skip this step.
    // Skip in test mode — tests don't have network access to the brand API.
    if (process.env.NODE_ENV !== "test") {
      try {
        const provider = await import("../cameras/providers/registry").then((m) => m.getProvider?.(input.brand) || null).catch(() => null)
        if (provider && typeof (provider as any).validateCredentials === "function") {
          const creds = input.brand === "EZVIZ"
            ? { appKey: input.appKey, appSecret: input.appSecret }
            : { appId: input.appId, appSecret: input.appSecret }
          const result = await (provider as any).validateCredentials(creds)
          if (!result?.ok) {
            throw new Deny(`Credential validation failed for ${input.brand}: ${result?.reason || "unknown error"}`, 400)
          }
        }
      } catch (e: any) {
        // If validateCredentials itself throws (network down, brand API 500),
        // surface the error to the operator rather than silently persisting.
        if (e instanceof Deny) throw e
        throw new Deny(`Could not validate ${input.brand} credentials: ${e?.message || e}. Check network and brand API status.`, 400)
      }
    }

    // Build the plaintext payload (brand-specific shape)
    const plaintextPayload: Record<string, string> = input.brand === "EZVIZ"
      ? { appKey: input.appKey, appSecret: input.appSecret }
      : { appId: input.appId, appSecret: input.appSecret }

    // Phase 6 Flag 3: check if this is a CREATE (no existing row) or a ROTATE
    // (existing row being updated). Distinct audit verbs let auditors see
    // credential introduction vs rotation as separate events. Uses
    // credentialExists (existence check WITHOUT decrypting) — decrypting
    // just for an existence check would fail if HRM_MFA_KEY is unset.
    const isRotation = await credentialExists(ctx, input.brand)
    const auditVerb = isRotation ? "camera.credential.rotate" : "camera.credential.create"
    const auditSummary = isRotation
      ? `Rotated ${input.brand} cloud credentials (key version bumped)`
      : `Onboarded ${input.brand} cloud credentials`

    // Encrypt + upsert (handles version bumping + rotatedAt)
    const saved = await upsertCredential(ctx, input.brand, plaintextPayload)

    // HIGH-12 (this audit) — invalidate the cached OAuth token on rotation.
    // The previous code rotated the credential row but left the old cached
    // OAuth token usable for up to ~2h (EZVIZ TTL). An attacker who
    // exfiltrated the token before rotation could keep launching cameras /
    // fetching device lists for hours after the rotation.
    if (isRotation) {
      try {
        const { clearCachedToken } = await import("../cameras/providers/token-cache")
        clearCachedToken(ctx.vendorId, input.brand)
      } catch { /* token-cache module unavailable — non-fatal */ }
    }

    // auditStrict — credential create/rotate is forensic-weight (Camera Manager §10)
    await auditStrict(ctx, auditVerb, "CameraCredential", saved.id, auditSummary, {
      // No oldValue/newValue with payload — encryptedPayload is in AUDIT_PII_EXCLUDE
      oldValue: isRotation
        ? { encryptionKeyVersion: saved.encryptionKeyVersion - 1, note: "previous version (payload redacted)" }
        : null,
      newValue: { encryptionKeyVersion: saved.encryptionKeyVersion, rotatedAt: !!saved.rotatedAt },
    })

    return { brand: saved.brand, encryptionKeyVersion: saved.encryptionKeyVersion, rotatedAt: saved.rotatedAt, createdAt: saved.createdAt }
  },
})

// ============================================================
// camera.credential.delete — perm: camera.manage
// Hard-delete the tenant's credential row for a brand.
// Small flag 2 (Phase 5c): rate-limited per tenant (10/min).
// Small flag 3 (Phase 5c): response includes affectedCameraCount — the UI
// shows "N cameras will become unlaunchable" as a warning before delete.
// ============================================================

route("camera.credential.delete", {
  perm: ["camera", "manage"],
  handler: async (ctx, p) => {
    // Small flag 2: rate-limit per tenant — see camera.credential.upsert above.
    if (await rateLimit(`camera:credential:${ctx.vendorId}`, 10, 60_000)) {
      throw new Deny("Too many credential operations — wait a minute and try again", 429)
    }

    const { brand } = safePayload<{ brand: string }>(p, ["brand"])
    if (!brand) throw new Deny("Brand is required", 400)
    if (!isTenantCredentialBrand(brand)) {
      throw new Deny(`${brand} cameras do not use tenant credentials.`, 400)
    }
    // Small flag 3: count affected cameras BEFORE the delete (after, the
    // cameras still exist but their launches will fail). The UI uses this
    // for a "N cameras will become unlaunchable" warning.
    const affectedCameraCount = await countCamerasByBrand(ctx, brand)
    const deleted = await deleteCredential(ctx, brand)
    if (!deleted) throw new Deny(`No ${brand} credentials found for your tenant.`, 404)
    // auditStrict — credential deletion is forensic-weight
    await auditStrict(ctx, "camera.credential.delete", "CameraCredential", deleted.id, `Deleted ${brand} cloud credentials`, {})
    // Small flag 3: response shape includes affectedCameraCount for the UI warning.
    return { brand: deleted.brand, deleted: true, affectedCameraCount }
  },
})

// ============================================================
// camera.credential.state — perm: camera.manage
// Phase 7 Item 1: returns { EZVIZ: boolean, IMOU: boolean } via
// credentialExists (existence check WITHOUT decrypting). The credential
// panel reads this on mount to show "Configured" vs "Not configured"
// per brand. Does NOT decrypt — credentialExists is a lightweight
// `SELECT id FROM CameraCredential WHERE vendorId=? AND brand=?` lookup.
// ============================================================

route("camera.credential.state", {
  perm: ["camera", "manage"],
  handler: async (ctx) => {
    // WP-B (CCTV review §3.13) — derive the brand list from the repository's
    // TENANT_CREDENTIAL_BRANDS registry instead of a drifting hardcode, so a
    // future 3rd tenant-credential brand appears here without touching this route.
    const brands = [...TENANT_CREDENTIAL_BRANDS]
    const state: Record<string, boolean> = {}
    for (const brand of brands) {
      state[brand] = await credentialExists(ctx, brand)
    }
    return state
  },
})

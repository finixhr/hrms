# Camera Manager — Production Readiness Checklist

Before deploying the Camera Manager to production, verify each item below.

## 1. Environment Variables

- [ ] **`HRM_MFA_KEY`** is set (256-bit hex key, e.g. `openssl rand -hex 32`).
  - Used by `crypto-field.ts` for AES-256-GCM encryption of camera credentials.
  - If unset, `encryptField()` throws (fail-closed) — no new credentials can be saved.
  - Existing credentials remain readable if they were encrypted under a previous key (legacy fallback).
  - **Generate your own key — do NOT reuse the example value from `.env.example`.**

- [ ] **`DATABASE_URL`** points to the production SQLite file (`file:./db/custom.db` or equivalent).

## 2. Database Migration

- [ ] Run `prisma migrate status` against the production database.
  - Expected: `Database schema is up to date!`
  - If `20260921000900_cameras` shows as pending, run `prisma migrate deploy`.
  - The migration creates 2 new tables (`Camera`, `CameraCredential`) — zero `ALTER TABLE` on existing tables, zero data migration.

## 3. Brand Portal URL Verification

Each provider has a `// TODO(verify)` marker for URLs that were not independently verified against the brand's official developer docs. Before production, verify and update if needed:

- [ ] **Hikvision:** `https://www.hik-connect.com` (file: `providers/hikvision.ts:88`)
  - If `i.hik-connect.com` is the direct post-login portal, swap the constant.
- [ ] **Dahua:** `https://dmss.dahuasecurity.com` (file: `providers/dahua.ts:60`)
  - If a different DMSS portal URL is correct (e.g. `web.dahuacloud.com`), swap.
- [ ] **EZVIZ:** `ezopen://open.ys7.com/{serial}/{channel}.live` (file: `providers/ezviz.ts:352`)
  - Verify the exact URL format against EZVIZ Open Platform docs.
  - Also verify the OAuth endpoint base URL (`https://openapi.ezvizlife.com`).
- [ ] **Imou:** OAuth endpoint + cloud-stream URL format (file: `providers/imou.ts`)
  - Verify `https://openapi.imoulife.com` against Imou developer docs.
  - The `imoulife://` app scheme is NOT used (unverified) — the provider falls back to the web portal when the API doesn't return a `liveUrl`.

## 4. Multi-Instance Deployments

- [ ] If running multiple Next.js instances (horizontal scaling), the in-memory `Throttle` table (rate limiting) and `token-cache.ts` (OAuth token cache) are **per-process** — they don't share state across instances.
  - **Throttle:** multi-instance needs Redis-backed rate limiting (see `security.ts:121–122` comment).
  - **Token cache:** multi-instance needs Redis-backed token cache (see `token-cache.ts:7–13` comment).
  - Single-instance deployments work correctly without Redis.

## 5. Rate Limits

The Camera Manager enforces the following rate limits per tenant:

| Endpoint | Limit | Window | Key |
|---|---|---|---|
| `camera.launch` (per-camera) | 30 | 60s | `camera:launch:{vendorId}:{cameraId}` |
| `camera.launch` (per-tenant aggregate) | 120 | 60s | `camera:launch:{vendorId}` |
| `camera.credential.upsert` | 10 | 60s | `camera:credential:{vendorId}` |
| `camera.credential.delete` | 10 | 60s | `camera:credential:{vendorId}` |

- [ ] These limits are conservative defaults. Tune in `routes/cameras.ts` (`LAUNCH_RATE_PER_CAMERA`, `LAUNCH_RATE_PER_TENANT`) based on your brand API quotas.
- [ ] EZVIZ and Imou rate-limit their OAuth endpoints — the provider implementations have exponential backoff (3 attempts, 1s/2s delays) to avoid getting the tenant's appKey banned.

## 6. RBAC Backfill

Existing tenants' `Role` rows in the DB need the `camera.*` permissions backfilled:

- [ ] Run `bun run scripts/migrate-role-perms-cameras.ts` to add `camera.*` grants to existing `Role` rows.
  - The script is additive (never removes custom admin edits) and idempotent (running twice is a no-op).
  - New tenants automatically get `camera.*` via the static `ROLE_TEMPLATES` in `src/hrm-server/types.ts`.

## 7. Security Checklist

- [ ] `verificationCode` is never returned in any API response (stripped by `publicCamera()`).
- [ ] `encryptedPayload` is never written to `AuditLog` rows (in `AUDIT_PII_EXCLUDE` set).
- [ ] Cross-tenant point lookups return 404, not 403 (prevents ID enumeration).
- [ ] Soft-deleted cameras (`enabled=false`) are excluded from `camera.list` by default.
- [ ] `camera.launch` and `camera.status` on soft-deleted cameras return 404.
- [ ] `accessToken` is a separate field in `LaunchTarget`, never embedded in URLs.
- [ ] All `db.camera.*` calls in `src/hrm-server/cameras/repository.ts` carry `// scoped: cameraScopeFilter` comments.
- [ ] `camera.get` is read-only (no timestamp bumps, no side effects).
- [ ] Credential/token failures return `status: "UNKNOWN"`, never `"OFFLINE"`.

## 8. Test Suite

Before deploy, run the full test suite:

```bash
export HRM_MFA_KEY="<your-production-key>"
bun test tests/unit/camera-tenant-isolation.test.ts \
  tests/unit/camera-providers.test.ts \
  tests/unit/camera-providers-ezviz.test.ts \
  tests/unit/camera-providers-imou.test.ts \
  tests/unit/crypto-field-mfa-backcompat.test.ts
```

Expected: all tests pass (195+ tests across 8 files as of Phase 7).

## 9. E2e Tests (when the e2e harness is set up)

The e2e tests at `tests/e2e/camera-dispatcher.test.ts` are skipped by default. To run them:

1. Start the Next.js dev server: `bun run dev`
2. Set up test session tokens via env vars (`HRM_E2E_TOKEN_A`, `HRM_E2E_TOKEN_B`, `HRM_E2E_TOKEN_NO_PERM`)
3. Uncomment the `test.skip` calls (remove `.skip`)
4. Run: `bun test tests/e2e/camera-dispatcher.test.ts`

These tests verify the dispatcher's security layers (401/403/404/429) at the HTTP level, complementing the unit tests which test handler internals.

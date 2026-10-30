# CCTV / Camera Manager — Code Review & Improvement Plan

**Reviewer:** Cline · **Date:** 2026-09-27 · **Scope:** the complete CCTV/Camera Manager module as it
exists on `master` today.

**Method:** full read of the server layer (`src/hrm-server/cameras/**`, `src/hrm-server/routes/cameras.ts`),
the client view (`src/hrm/views/cameras.tsx`, `camera-dashboard-charts.tsx`, the dashboard widget), the
Prisma models, the RBAC backfill script, all 4 unit-test files + the e2e file, and the module docs
(`CONVENTIONS.md`, `API.md`, `PRODUCTION-READY.md`, `src/hrm-server/cameras/providers/README.md`). Every finding below carries a
`file:line` reference and, where noted, a reproducible command (see §5).

---

## 1. Verdict

The module is **structurally the best-built part of the codebase**: a pluggable provider registry,
tenant/branch scoping enforced at the repository layer, `auditStrict` on forensic events,
AES-256-GCM credential encryption with DB-driven key versioning, rate limits on the abuse-prone routes,
130 unit tests, a production-readiness checklist and a "how to add a 5th brand" guide. No architectural
rework is needed.

What is *not* finished is the last mile: **two documented behaviours were never wired up** (§3.1 rotation
never invalidates the token cache, §3.2 `validateCredentials` is dead code), **status data goes stale
because nothing refreshes it on a schedule** (§3.4), and the view has visible small defects — error
toasts that render as success (§3.3), a "Disabled" filter that can never return a row (§3.6), and a
credential-state call fired twice by users who lack the permission for it (§3.7). 43 project-wide
`tsc --noEmit` errors (34 of them in camera code, §3.11) mean `bun run typecheck` cannot be a CI gate,
so this class of drift keeps accumulating.

**Recommended order:** the six quick wins in §4.1 (≈1–2 hours, all low-risk, each independently
testable), then P1-4 (scheduled status sweep — the only item that changes behaviour beyond bug-fixing),
then the P2/P3 hardening pass.

---

## 2. What is already solid — do not regress

---

## 3. Findings

### P1 — correctness / security

#### 3.1 Credential rotation does not invalidate the cached OAuth token
**Symptom.** After an admin rotates an EZVIZ/Imou appKey+appSecret, launches and status checks keep using
the token minted from the **old** keys for up to ~2 hours.

**Evidence.**
- `src/hrm-server/cameras/providers/token-cache.ts:68-70` states `clearCachedToken` is *"Also called on credential rotation or
  deletion"* — it is not.
- A repo-wide grep finds `clearCachedToken` only inside the providers, on their 401 paths
  (`ezviz.ts:220,290`; `imou.ts:200,263`).
- The rotation path `src/hrm-server/routes/cameras.ts:395` (`upsertCredential`) and the delete path `:435`
  (`deleteCredential`) never touch the cache.

**Impact.** Rotating a credential because a secret leaked leaves the leaked key usable until the cached
token expires; if the old key was revoked at the brand, users see confusing `UNKNOWN`/401s on launch for
the rest of the TTL.

**Fix** (≈6 lines in `src/hrm-server/routes/cameras.ts`):
```ts
import { clearCachedToken } from "../cameras/providers/token-cache"
// camera.credential.upsert — right after upsertCredential(...):
clearCachedToken(ctx.vendorId, input.brand)   // next launch/status mints a token from the NEW keys
// camera.credential.delete — right after the successful deleteCredential(...):
clearCachedToken(ctx.vendorId, brand)
```
Regression test: upsert creds → launch (token cached) → upsert again → assert the next provider call hits
`/oauth/token`. The EZVIZ test file already has the fetch-mock harness for this.

#### 3.2 `CameraProvider.validateCredentials` is dead code — invalid credentials are saved silently
**Symptom.** A typo in the appSecret is accepted, encrypted, audited as *"Onboarded EZVIZ cloud
credentials"*, and only surfaces later as `status: UNKNOWN` + `lastError` on the first launch.

**Evidence.**
- Declared at `src/hrm-server/cameras/providers/camera-provider.ts:121`; implemented in all four providers
  (`ezviz.ts:176`, `imou.ts:160`, `hikvision.ts:93`, `dahua.ts:65`).
- **No call site outside the test files** (grep over `src/`, `tests/`, `scripts/`).
- `camera.credential.upsert` (`src/hrm-server/routes/cameras.ts:350-407`) validates *shape* only (`:372-376`), then
  encrypts + stores.

**Impact.** Admins cannot distinguish "I typed the key wrong" from "the brand API is down" — exactly the
failure the credential panel exists to prevent.

**Fix.** In the upsert handler, after the shape validation:
```ts
const provider = getProvider(input.brand)
if (!(await provider.validateCredentials(plaintextPayload))) {
  throw new Deny(`${input.brand} rejected these credentials — check the appKey/appSecret in the ${input.brand} Open Platform console.`, 400)
}
```
This hits the brand's OAuth endpoint, already covered by the 10/min tenant limit at `:357`. Note the
interface returns a bare boolean, so a network timeout is indistinguishable from a genuine 4xx rejection —
consider widening it to `{ ok: boolean; reason?: string }` and surfacing the reason in the 400 body.

#### 3.3 Error toasts render as *success* toasts in the Camera view (12 call sites)
**Symptom.** "Save failed", "Status check failed" and credential errors all appear with default (success)
styling.

**Evidence.**
- Contract: `store.ts:38` → `toast: (text: string, kind?: "ok" | "err") => void`.
- Renderer: `app-shell.tsx:48` → `variant: toastMsg.kind === "err" ? "destructive" : undefined` — any other
  string silently falls into the success branch.

#### 3.4 Nothing refreshes camera status on a schedule
**Symptom.** A newly registered camera sits at `UNKNOWN` forever unless a human clicks the per-row Refresh
button, so the dashboard widget and the four StatCards are routinely stale.

**Evidence.**
- `src/hrm-server/jobs.ts` — the 60-second scheduler — contains **zero** camera references (grep). It has
  the pattern to copy: `jobState`/`setJobState` (`jobs.ts:48-54`) plus a date/interval guard.
- The only writer of `status`/`lastStatusCheckAt` is `camera.status` (`src/hrm-server/routes/cameras.ts:301-340`), whose
  only caller is the row button (`cameras.tsx:198,221`).
- `PRODUCTION-READY.md:71-76` promises `lastStatusCheckAt` is a "we tried" marker — that only holds for
  manual clicks.

**Impact.** The module's headline feature (knowing which cameras are reachable) is only as fresh as the last
human click; on a 100-camera site, refreshing the whole board means 100 RPCs by hand.

**Fix.** Add a sweep called from `runTick`, mirroring `dailyJobs`:
```ts
async function cameraStatusSweep(vendorId: string) {
  const last = await jobState(vendorId, "lastCameraSweep")
  if (last && Date.now() - Date.parse(last) < 10 * 60_000) return    // ≤ 1 sweep / 10 min / tenant
  const cams = await listCameras(ctxFor(vendorId), { limit: 25 })     // cap per tick
  // skip soft-deleted; skip tenant-credential brands with no credential row;
  // provider.getDeviceStatus → updateCameraStatus; never write OFFLINE on a credential failure
  await setJobState(vendorId, "lastCameraSweep", new Date().toISOString())
}
```
Stagger per camera (index × 2 s) so the brand API isn't hammered, reuse the token cache (it exists for
exactly this), write `UNKNOWN` + `lastError` on failure, and keep a per-tenant cap so a 500-camera tenant
can't blow the tick budget (`TICK_MS = 60_000`; overlapping passes are already guarded at `jobs.ts:30`).

### P2 — functional gaps and UI/logic defects

#### 3.5 The "Disabled" filter can never list anything
**Evidence.** `cameras.tsx:105-108` requests `includeDisabled: true` **only** when
`filterStatus === "all"`, but the memo at `:123-128` maps `filterStatus === "disabled"` to
`data.cameras.filter(c => !c.enabled)` — always empty, because the request asked for enabled-only rows
(`repository.ts:100`: `if (opts.includeDisabled !== true) where.enabled = true`).

**Impact.** After decommissioning, the "Disabled" view says "No cameras" — users conclude the camera is
gone, and the restore path is only discoverable via "All". Contradicts the recoverability promise in
`PRODUCTION-READY.md:71`.

**Fix.** Cheapest: fetch once with `includeDisabled: true` and treat Active/Disabled/All as pure
client-side filters (`:107` → `includeDisabled: true`). Alternative: `includeDisabled: filterStatus !== ""`.

#### 3.6 100-row silent truncation on large sites
**Evidence.** `repository.ts:107` → `take: Math.min(opts.limit ?? 100, 500)`; the view never passes
`limit`/`offset` (`cameras.tsx:105`) and `DataTable` paginates only the rows it was handed
(`data-table.tsx:59-61`), while `counts` counts the whole tenant (`repository.ts:332-350`).

**Impact.** A 150-camera site shows 100 rows while the stat cards say 150 — looks like data loss — and the
CSV export omits 50 rows.

**Fix.** Drive `limit`/`offset` from the table's page state, or return `{ cameras, counts, total, truncated }`
and render a "showing the first 100 of N" banner. Don't silently cap.

#### 3.7 `camera.credential.state` is called by users who cannot read it
**Evidence.** `cameras.tsx:121` calls it unconditionally for every viewer, and `CredentialPanel` calls it
again at `:739` — the panel is mounted unconditionally at `:408`, and its `if (!canManage) return null`
(`:779`) runs *after* the hook. The route requires `camera.manage` (`src/hrm-server/routes/cameras.ts:454`).

**Impact.** HR_MANAGER/BRANCH_MANAGER fire two 403s on every page load — log noise, wasted round-trips, and
an ignored error that can mask messaging.

**Fix.** `useApi(can("camera", "manage") ? "camera.credential.state" : null, {})` in both places —
`useApi` already accepts a null action (`api.ts:120-133`).

- Violations in `cameras.tsx`: `225, 228, 448, 449, 450, 451, 468, 633, 745, 749, 769, 773`
  (`"success"` → `"ok"`, `"error"` → `"err"`). `tsc --noEmit` flags all 12 (`TS2345`). The same bug exists
  in `src/hrm/views/employees.tsx:446,449`.

**Impact.** Real failures look like successes; also 12 of the 43 project-wide type errors.


| Property | Where |
|---|---|
| Tenant + branch scoping on every camera read/write | `src/hrm-server/cameras/repository.ts:75-79,98-110,128-136`; `@@unique([vendorId, id])` in the schema |
| 404-not-403 on cross-tenant/branch point lookups | `repository.ts:116-136` (assertTenant + explicit branch check) |
| Credentials encrypted at rest; rotation = version bump + derived crypto context | `src/hrm-server/cameras/credentials.ts:63-109` (version read from the DB column, never hardcoded) |
| `auditStrict` (throws) on delete / launch / credential ops; best-effort `audit` elsewhere | `src/hrm-server/routes/cameras.ts:223,280,398,438` |
| Rate limits: launch 30/min per camera + 120/min per tenant; credential ops 10/min per tenant | `src/hrm-server/routes/cameras.ts:59-61,243-256,357,422` |
| Soft-delete policy explicit and consistently applied (list hides, get finds, launch/status 404) | `repository.ts:100`; `src/hrm-server/routes/cameras.ts:170,260,308` |
| Access tokens never embedded in launch URLs (separate `accessToken` field) | `src/hrm-server/cameras/providers/camera-provider.ts` `LaunchTarget`; `cameras.tsx:686-696` |
| Credential/token failures → `UNKNOWN`, never `OFFLINE` | `src/hrm-server/cameras/providers/README.md:119`; ezviz/imou status paths |
| Permission templates + backfill script + nav/module-map wiring | `types.ts:123,165,219`; `scripts/migrate-role-perms-cameras.ts`; `nav.ts:38`, `module-map.ts:53` |
| 130 unit tests across 4 files (67 isolation, 30 provider, 17 EZVIZ, 16 Imou) — green today | `tests/unit/camera-*.test.ts` (§5) |

#### 3.8 Provider HTTP calls have no timeout
**Evidence.** `ezviz.ts:102-118` defines `postJson`/`getJson` under the comment *"helper: fetch with timeout
+ JSON parse"* — neither passes a signal; `imou.ts:94-110` copies the same pattern. The only `setTimeout`s in
those files are the OAuth backoff delays (`ezviz.ts:144`, `imou.ts:131`), and Node's global `fetch` has no
default timeout.

**Impact.** A brand API that accepts the connection and never responds pins the RPC handler indefinitely.
The client aborts at 30 s (`api.ts:70`), but that does not stop the server-side work — during an EZVIZ/Imou
incident, repeated launch/status calls pile up, and the status sweep proposed in §3.4 would make it worse.

**Fix.** `signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS)` with `PROVIDER_TIMEOUT_MS = 10_000`, catching
`TimeoutError`/`AbortError` and returning `{ status: 0, json: null }` so callers map it to `UNKNOWN` +
`lastError: "… did not respond within 10s"` (never `OFFLINE`, per the module's own rule).

#### 3.9 `status` is client-writable through `camera.update`
**Evidence.** `CAMERA_UPDATE_FIELDS` includes `"status"` (`src/hrm-server/routes/cameras.ts:69-72`) and `updateCamera`
writes the patch straight through (`repository.ts:214-237`). `ALL_STATUSES` exists (`repository.ts:61`) but
is never used for validation, and `countCamerasByStatus` silently drops unknown values
(`repository.ts:344-348` — `k in out` guard, `total = ONLINE + OFFLINE + UNKNOWN`).

**Impact.** Any `camera.edit` holder can spoof `ONLINE` on a camera that is actually offline (audited only
as a generic "Updated camera"), and a bad value makes the stat cards disagree with the table.

**Fix.** Remove `"status"` from the update whitelist (nothing in the UI sends it — `cameras.tsx:454-463`)
or validate `ALL_STATUSES.includes(v)` → 400. The provider must remain the only writer of `status`.

#### 3.10 The decommission reason is collected and then discarded
**Evidence.** The dialog uses `requireReason` and sends it (`cameras.tsx:382-385`:
`rpc("camera.delete", { id, reason })`), but the handler whitelists only `["id"]` (`src/hrm-server/routes/cameras.ts:218`)
and `safePayload` drops unknown keys silently (`security.ts:230-242`); the audit summary at
`src/hrm-server/routes/cameras.ts:223` has no reason field.

**Impact.** Operators supply a justification for a forensic-weight event and it never reaches `AuditLog` —
worse than not asking at all.

**Fix.** Add `"reason"` to the whitelist and include it in the audit write (`metadata: { reason }` or the
summary string), or drop `requireReason` from the dialog.

### P3 — hygiene, drift and coverage

#### 3.11 Type-check debt: 43 errors project-wide, 34 in camera code
Measured with `node node_modules/typescript/bin/tsc --noEmit` (§5). Breakdown:

| Area | Count | Notes |
|---|---|---|
| `src/hrm/views/cameras.tsx` | 15 | 12 × toast kind (§3.3); 1 × `PageHeader title` is `string` but a badge element is passed (`:239`; prop declared `string` at `src/hrm/shared/ui-kit.tsx:133`); 2 × union narrowing at `:682,:691` |
| `src/hrm-server/cameras/repository.ts` | 2 | `:235` destructures `vendorId`/`enabled` off `CameraUpdateInput`, which declares neither (`:204-209`) |
| `tests/unit/camera-*` | 17 | `LaunchTarget` narrowing (`camera-providers.test.ts:156,164,165,210,212`; `-ezviz:342-346`; `-imou:312,314,315,434`) + `null` vs `undefined` (`camera-tenant-isolation.test.ts:226,242,259,275`) |
| elsewhere | 9 | `seed.ts` 5, `employees.tsx` 2 (same toast bug), `src/components/ui/sidebar.tsx` 1 (missing `@/hooks/use-mobile`), `scripts/phase2-verify.ts` 1 |

**Fixes.**
- Toast kinds: mechanical rename (§3.3).
- Union narrowing: capture once above the JSX — `const target = launch.launchTarget` — then
  `target.kind === "CLOUD_STREAM_TOKEN" && <code>{target.url}</code>`; in tests, narrow (or use a
  `switch`) before touching `.url`/`.accessToken`. (Narrowing is lost inside the inline arrow callbacks at
  `:682/:691`, which is why TS objects.)
- `PageHeader`: widen to `title: React.ReactNode` (`ui-kit.tsx:133`) — the camera view deliberately passes
  the permission badge there.
- `repository.ts:235`: type the parameter as
  `CameraUpdateInput & { vendorId?: unknown; enabled?: unknown }` so the defensive strip compiles.
- Then add `bun run typecheck` to `scripts/ci.sh` so this cannot drift again.


#### 3.12 `verificationCode` is stored in plaintext
`Camera.verificationCode` has no encryption while `CameraCredential.encryptedPayload` is AES-256-GCM via
`crypto-field.ts`. `PRODUCTION-READY.md:68` only guarantees it is stripped from responses.

**Impact.** The verifier is effectively a device password for Hikvision/Dahua cloud viewing; a DB or backup
leak plus serial numbers grants live-view access. **Options:** encrypt with `crypto-field` (context
`cameras-vc::v1`) and decrypt inside the provider (with `hasVerificationCode` derived from the ciphertext's
presence), or record the accepted risk explicitly in `PRODUCTION-READY.md`. Silence is the only bad option.

#### 3.13 Adding a 5th brand is 3+ code files, not 2 as the README claims
`src/hrm-server/cameras/providers/README.md:3` says exactly 2 file changes; in reality `src/hrm-server/routes/cameras.ts:456` hardcodes
`const brands = ["EZVIZ", "IMOU"]` for `camera.credential.state`, plus the UI lists
(`cameras.tsx:68-85`) — the README concedes step 5 but calls it optional.

**Fix.** Derive the credential-state list from `[...TENANT_CREDENTIAL_BRANDS]` (`repository.ts:53`), and
consider a `camera.brands` route backed by `listRegisteredBrands()` so the UI brand list is
registry-driven too. Then the README's "2 files" claim becomes true.

#### 3.14 Dead code and doc drift
- `src/hrm-server/routes/cameras.ts:18` imports `employeeScopeFilter` — never used.
- `src/hrm-server/routes/cameras.ts:6` says the handler does `cleanForm(p) + safePayload(...)`; `cleanForm` is unused here.
- `repository.ts:33-37` says `validateCameraCreate` "dynamic-imports the registry" — it is a static import
  now; `src/hrm-server/routes/cameras.ts:143-144` still repeats the stale claim.
- `src/hrm-server/cameras/providers/README.md:87-102` names `brandOptions`/lowercase keys; the view uses `BRAND_OPTIONS`
  (`cameras.tsx:80`) and a `Record<string,string>` `BRAND_COLORS` (`:68`).

#### 3.15 The e2e dispatcher tests can never fail
`tests/e2e/camera-dispatcher.test.ts` — all 5 tests are `test.skip` and need env tokens, so nothing in CI
exercises dispatcher behaviour (401/403/404/429). The 401 case needs **no fixtures**: make it run whenever
`HRM_E2E_URL` is set (skip only when unset) so the auth layer is at least smoke-tested.

#### 3.16 The scope invariant is enforced by a grep, not by the type system
Every `db.camera.*` call carries `// scoped: cameraScopeFilter` and
`camera-tenant-isolation.test.ts:34-37` greps for the comment — but
`db.camera.findUnique({ where: { id } })` (`repository.ts:129`) and `db.camera.update({ where: { id } })`
(`:236`) rely on `getCamera`/`assertTenant` having run first.

**Fix (defense in depth).** Use the compound unique the schema already declares:
`where: { id, vendorId: ctx.vendorId }` (Prisma 6 extended-where-unique). A future refactor then cannot
bypass tenant scoping even if the helper is skipped — the invariant becomes structural, not comment-based.

#### 3.17 Multi-instance deployments (already documented — repeating for completeness)
`PRODUCTION-READY.md:37-42` is correct: the `Throttle` rate-limit table and `src/hrm-server/cameras/providers/token-cache.ts`
(`:8-13`) are per-process `Map`s. A second Next.js instance means up to 2× the configured launch rate and
duplicate token minting. Redis (or a `CameraCredential`-backed token cache keyed `(vendorId, brand)`) is the
fix when horizontal scaling starts.


---

## 4. Improvement plan

### 4.1 Quick wins — ≈1–2 hours, low risk, each independently verifiable
1. **Toast kinds** (§3.3): `"success"`→`"ok"`, `"error"`→`"err"` in `cameras.tsx` (12 sites) and
   `employees.tsx:446,449`. Removes 14 of the 43 type errors and fixes error styling.
2. **`clearCachedToken` on rotate/delete** (§3.1): 6 lines + 1 test.
3. **"Disabled" filter** (§3.5): one-line `includeDisabled` change; then a decommissioned camera is
   reachable without guessing "All".
4. **Gate `camera.credential.state`** (§3.7): pass `null` when `!can("camera","manage")` in both call sites.
5. **`reason` on decommission** (§3.10) *or* drop `requireReason` — pick one so the UI stops lying.
6. **Remove `status` from the update whitelist** (§3.9) and the dead `employeeScopeFilter` import (§3.14).

### 4.2 Next — behaviour and reliability (≈1 day)
7. **Scheduled status sweep** (§3.4) plus a `camera.status` refactor so the sweep and the route share one
   code path (extract `refreshCameraStatus(ctx, camera)` into a dedicated `status.ts` module inside the cameras layer). Tests: sweep skips
   disabled cameras, respects the per-tenant cap, writes UNKNOWN + lastError on provider failure.
8. **Provider fetch timeouts** (§3.8): `AbortSignal.timeout(10_000)` in `ezviz.ts:102-118` /
   `imou.ts:94-110`, mapping `TimeoutError` → UNKNOWN + *"… timed out"*. Without this, one hung brand API
   can pin server requests — the client-side 30 s abort (`api.ts:70`) does not stop the server work.
9. **`validateCredentials` in the upsert path** (§3.2) plus a "Test credentials" button in the credential
   panel that runs the check on demand.
10. **`camera.list` pagination / truncation flag** (§3.6), driven by the table's page state.

### 4.3 Then — hygiene and depth (≈1 day)
11. Type-debt sweep (§3.11) + `bun run typecheck` in `scripts/ci.sh`.
12. Invariant hardening: compound `(id, vendorId)` wheres (§3.16) and status validation (§3.9).
13. Docs: fix §3.13/§3.14 drift; decide and record the `verificationCode` posture (§3.12).
14. Coverage: e2e 401 smoke test (§3.15); unit tests for rotation→cache-clear, sweep caps, and the
    "Disabled" filter.

### 4.4 Backlog / optional (product ideas, not defects)
- **Bulk actions**: multi-select launch / status-refresh for a floor of cameras.
- **Status history**: an append-only `CameraStatusEvent` table (cameraId, status, at, error) so uptime can
  be charted — today only the latest values survive (`lastStatusCheckAt`, `lastError`).
- **Registry-driven brand UI**: `camera.brands` from `listRegisteredBrands()` (see §3.13).
- **Attendance/HR crossover**: the ZKTeco/ISAPI device plane (`src/app/ISAPI/**`) and the CCTV registry are
  two independent registries for "which entrance is where"; linking a camera to the same branch/door
  records would make the security console coherent.
- **Local-network probe** for per-camera brands: an opt-in ONVIF/HTTP reachability check from the server
  would make Hikvision/Dahua status real instead of last-known — at the cost of the server reaching into
  customer LANs, so it needs an explicit setting and a documented security note.

---

## 5. Verification appendix (reproducible)

All commands run from `c:\HRMS_CCTV` on 2026-09-27.

```powershell
# 1. Camera unit suite — the baseline is green today.
bun test tests/unit/camera-tenant-isolation.test.ts tests/unit/camera-providers.test.ts `
  tests/unit/camera-providers-ezviz.test.ts tests/unit/camera-providers-imou.test.ts
# → 130 pass, 0 fail, 327 expect() calls, 4 files (EXIT=0)

# 2. Type-check (project has no working `npx tsc` shim — call the binary directly).
node node_modules/typescript/bin/tsc --noEmit
# → 43 errors: cameras.tsx 15, src/hrm-server/cameras/repository.ts 2, camera tests 17,
#   seed.ts 5, employees.tsx 2, src/components/ui/sidebar.tsx 1, scripts/phase2-verify.ts 1

# 3. Evidence for §3.1 / §3.2 — the "documented but never wired" calls.
Get-ChildItem src,tests,scripts -Recurse -Include *.ts,*.tsx |
  Select-String -Pattern 'clearCachedToken|validateCredentials' |
  ForEach-Object { "$($_.Path):$($_.LineNumber): $($_.Line.Trim())" }
# → clearCachedToken: only providers (401 paths) + token-cache.ts itself
# → validateCredentials: providers + tests only, no route/repository call site

# 4. Evidence for §3.4 — the scheduler never touches cameras.
Select-String -Path src/hrm-server/jobs.ts -Pattern 'camera' -CaseSensitive:$false
# → (no output)
```

**Not covered by this review** (out of scope, no evidence gathered): live behaviour of the real EZVIZ/Imou
APIs (all endpoint URLs still carry `TODO(verify)` markers — see `PRODUCTION-READY.md:22-35`), and
production load characteristics.


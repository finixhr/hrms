# Finix HR — Production Readiness Checklist

> Honest, evidence-based readiness assessment. Every line cites what was
> actually verified (gate run, test count, commit) on its stated date.
> Nothing here is aspirational: an item is checked only when its proof exists.
> Assessment date: 2026-10-31 (after M5 — hosted-CI verification + T-18…T-20 + TD-27 investigation).

## Overall verdict

| Environment | Verdict | Basis |
|---|---|---|
| **Development** | ✅ READY | Full 14-stage local gate exits 0 (2026-10-31, on a Saturday — after the weekend-flake fix); unit suite **1776/1776**; lint 0 errors (9 advisory warnings, TD-22); mobile tsc 0; **mobile eslint now runs: 0 errors / 10 warnings** (TD-23 resolved, TD-29 tracks the warnings) |
| **Staging** | ⚠️ READY WITH CAVEATS | Hosted CI **verified green on real runners** (run 41091970369 @ `86ef368`, §6) — but the M5 commits are LOCAL ONLY (no push credential in the sandbox); desktop builds unverified on Windows/macOS (TD-11); device pass BLOCKED (§8, TD-26) |
| **Production** | ❌ NOT READY | No release process, no monitoring/alerting wiring verification, no restore drill executed, no device verification, M5 commits not pushed; pending P1/P2 debt (TD register) |

---

## 1. Code quality gates — ✅ (development; hosted verified at the pre-M5 SHA)

- [x] TypeScript strict typecheck — root AND mobile (`tsc --noEmit`, gate stage 1; mobile job in workflow)
- [x] ESLint — 0 errors (9 advisory warnings tracked as TD-22); mobile eslint lane runs clean of errors too (TD-23 fixed this cycle)
- [x] Unit suite — **1776 pass / 0 fail** (2026-10-31; was 1742 at M4, 1728 at M3, 1683 at M2 — +34 M5 tests: 6 T-18 caps, 20 T-19 ESS isolation, 8 T-20 aliases). The two Friday/Saturday-only flakes (ATT-006, SCL-14) were root-caused as date-dependent, proven pre-existing at `86ef368`, and de-flaked (TD-31)
- [x] Secret scan, scrypt gate, destructive-op guard, docs guard, permission-registry lint (602 actions gated or annotated), dependency audit, fresh-DB migration smoke, schema-drift gate, perf budget — all green in `scripts/ci.sh` (exit 0, 2026-10-31)
- [x] **Hosted CI execution** — VERIFIED (run 41091970369, §6): all three jobs green at `main` @ `86ef368`. The M5 commits sit on top locally and must get their own hosted run after the next push
- [ ] **Hosted CI on the M5 commits** — the local gate is stage-identical and green, but the run at `86ef368` does not cover `da905bf…` (push needs credentials, §6)

## 2. Database & migrations — ✅

- [x] Migration chain applies cleanly to a fresh database (stage 11, throwaway DB each run)
- [x] Zero drift between migration chain and `schema.prisma` (stage 12)
- [x] M3 changed no schema (the outbox is device-side; server replay reuses the existing `unique(vendorId, clientEventId)`)
- [x] Destructive-operation guard + migration naming policy maintained
- [ ] Production `migrate deploy` execution — by policy, no production deployment from this environment (needs release process, §5)

## 3. Security & multi-tenancy — ✅ code-level

- [x] Tenant isolation pinned by tests (M3 replay lookup is vendor-scoped; cross-tenant same-`clientEventId` = new event, never a replay); **M5 adds the ESS-plane negative suite** — 20 dispatcher-boundary tests proving `ess.*` / `tracking.status` / punch actor resolution under forged employeeId/vendorId payloads, cross-tenant AND cross-employee, including the staff act-for-other permission+scope path (T-19)
- [x] Selfie proofs: authenticated upload, byte-sniffed mime (JPEG/PNG/WebP ≤ 2 MB), sha-256 hash, private DB storage, retention (`tracking.retentionDays`), storage-quota metering, no public URLs
- [x] Offline queue carries no secrets (no tokens/passwords/biometrics; auth token read live from secure store at submission)
- [x] Permission registry: 602 actions gated or annotated (stage 9 — `auth.supportExit` marker added this cycle)
- [x] CSP hardened in the desktop config (T-09) — build verification still owed (TD-11)
- [ ] Penetration test / external security audit — never performed

## 4. Functional readiness (mobile M3+M4 scope) — ✅ code-level

- [x] Offline attendance punches: enqueue offline → survive restart → replay with the same `clientEventId` → exactly one attendance row/event/proof/notification server-side (12 server contract tests)
- [x] Honest offline UX: success shown only after server confirmation; 401 pauses the queue and resumes post-login; permanent rejections keep the server's message
- [x] Selfie capture: permission flow → preview → capture → downscale ≤640px → explicit confirm → upload; retry reuses the idempotency key (no double punch, photo stored once)
- [x] Native MFA enrollment wizard (M4/T-14): 3-step QR → code → recovery-codes-once; contract-pinned against the existing H-1 server suite; no success before the server accepts
- [x] Push registration honesty (M4/T-15): fail-closed registration, projectId resolved from the linked EAS project, no dead tokens, no startup breakage
- [x] Export honesty (M4/T-16): 12 boundary tests pin failure/delivery paths of the money-critical exports; the one silent-no-op client path fixed
- [x] No fabricated data: GPS/time captured at punch time, replayed verbatim; delayed deliveries flagged for HR review, not silently accepted
- [ ] Device-level field testing (real airplane-mode toggle, real camera, QR scan, real Expo push received) — the react-native wiring layers are typecheck/contract-verified only (TD-26)

## 5. Operations — ❌ (the production blocker set)

- [ ] Release process (tags `v*`/`mobile-v*`, draft releases, smoke checklist) — T-29, not started
- [ ] Monitoring & alerting wiring (metrics endpoint + `deploy/hrm-alerts.rules.yml` → Prometheus/alertmanager) — T-26, unverified end-to-end
- [ ] Backup cadence + a full restore drill executed and witnessed — T-27 (scripts/timers exist, no executed drill on record)
- [ ] Dependency/provenance audit cadence — T-28 (single audit passes; cadence unowned)
- [ ] Term-invoice partial unique index (TD-21) — deliberately deferred pending dirty-data review
- [ ] Hosted CI (§6) — must be green on real runners before any production claim

## 6. Hosted CI — ✅ VERIFIED (2026-10-31, M5 Phase 1) at the pre-M5 SHA

The M4 blocker (no push credential) was resolved OUTSIDE the sandbox: the
M4 integration was pushed to `origin/main` by the operator, and the first
honest hosted run executed and passed.

**Verified run** — evidence from the GitHub REST API (per-job, per-step):

| Field | Value |
|---|---|
| Run | **41091970369** (CI run #8) — https://github.com/finixhr/hrms/actions/runs/41091970369 |
| Commit | `86ef3689cbe15ef5ec1ce254c802d02dc8e22563` — **the latest intended `main`** (verified identical to `origin/main` HEAD at inspection time) |
| Branch / event | `main` / `push` (a genuine push event, not a re-run of a stale SHA) |
| Conclusion | **success** (16:40:08Z → 16:48:53Z, 8m 45s) |
| Web job | success, all 16 steps green — checkout, Bun 1.4.2 pinned install (frozen lockfile), Prisma generate, migrate deploy, **tsc**, **ESLint hard gate**, **secret scan**, **full `scripts/ci.sh` gate**, **Next.js build** |
| Mobile job | success — npm ci (lockfile-exact), **tsc**, expo-doctor (advisory) |
| Docker job | success — `docker build -t finix-hr:86ef3689cbe1…` |

**Honest limits of that evidence:**
- The **Docker job builds and tags the image on the ephemeral runner ONLY — there is no registry push step** in the workflow. No image tag or digest is published anywhere; "build" ≠ "push", and neither is a deployment.
- Two deliberate skips stay in force and are printed, not masked: `E2E_SKIP=1` (stage 14 — the HTTP-journey lane needs local PostgreSQL tooling) and expo-doctor as `continue-on-error` advisory (it reports 1 version-pin finding — TD-30; this is the run's single "error" annotation and does NOT fail the job).
- The run covers `86ef368` (M4 tip). **The M5 commits (`da905bf`…, T-18/T-19/T-20 + de-flake + mobile lint fix + docs) are local only** — this sandbox again has no push credential (gh CLI and credential store were wiped by the sandbox recycle). After the next push, re-verify with the same API method before treating the M5 SHA as hosted-green.
- Nothing here claims production deployment: no image is published, no environment is provisioned, no release is cut.

## 7. Known residual risks (top, honest)

1. **M5 commits not pushed** (credential again missing after the sandbox recycle) — the hosted-green verdict covers `86ef368` only; the stage-identical local gate is green on the M5 tip.
2. **Device-dependent features unverified on hardware** (TD-26, §8) — the entire Phase-2 matrix is BLOCKED; typecheck/contract/unit evidence is NOT device evidence.
3. **React-native outbox wiring untested on devices** — all queue logic is unit-tested in the dependency-free engine, but NetInfo/AppState behavior is verified by typecheck + reasoning only.
4. **Background/terminated sync not implemented** (TD-27) — fully investigated with a concrete, platform-honest recommendation (`OFFLINE_OUTBOX.md` §11): Android feasible via WorkManager-backed expo-background-fetch (best-effort ≥15 min), **iOS impossible for terminated apps by OS design**; deferred until a device can validate the Android acceptance test.
5. **Offline punch official time = server receipt time** — delayed punches land as REVIEW_REQUIRED with the device timestamp preserved; reviewers must act on the queue (by design, but it is an operational dependency).
6. **Selfie ≠ identity verification** — no face detection/liveness is claimed or implemented; policy text must never market it as biometric identity proof.
7. **Desktop builds unverified** on Windows/macOS (TD-11) — unchanged from M4.
8. **No monitoring/alerting/restore-drill evidence** (§5) — the production blocker set is unchanged.
9. **Advisory lint noise** — 9 web warnings (TD-22), 10 mobile warnings (TD-29), expo-doctor version pin (TD-30); none gate-blocking.
10. **Docker image is never pushed** — the CI Docker job is build-only; publishing to a registry (and the registry choice) is an open decision before any staging deployment.

## 8. Device verification matrix (M5 Phase 2, 2026-10-31) — ALL BLOCKED

The directive for this cycle required physical Android and iOS device
verification of the auth / attendance / offline-outbox / push surfaces.
**This sandbox contains no physical device of either platform, no Android
SDK emulator image, no Xcode, and no iOS simulator** — and per the directive,
device verification must NOT be claimed from typecheck or simulator
reasoning. Every device-dependent item below is therefore **BLOCKED**; the
matrix records the scripted scenarios and expected results so a
device-in-the-loop session can execute it without re-derivation.

Verification status vocabulary: VERIFIED-ON-DEVICE / BLOCKED (no device) /
AUTOMATED-TEST-VERIFIED (server contract, in `tests/unit/`) — the third column
records what IS proven today so nothing device-dependent hides behind it.

| # | Scenario | Expected result | Status | Evidence today |
|---|---|---|---|---|
| **Authentication** ||||
| A1 | Login + logout on device | Session works; logout clears token + cookie; next open lands on login | BLOCKED (Android + iOS) | `auth.login/logout` contract unit-tested incl. MFA promote path |
| A2 | Session persistence across cold start | `auth.me` restores session from secure store; no re-login prompt | BLOCKED | Token storage (`auth.ts` mobile) typecheck + unit pin |
| A3 | Token refresh (5-min memory bearer + cookie) | 401 → cookie-auth fallback transparent; no user-visible bounce | BLOCKED | H-08 design; web-path unit tests |
| A4 | MFA enrollment via T-14 wizard (QR → code → recovery codes) | QR renders and scans; code accepted once; recovery codes shown EXACTLY once; wizard only proceeds on server acceptance | BLOCKED | 37 contract pins in `mobile-contract.test.ts` + `h1-mfa-enrollment.test.ts` behavioral suite |
| A5 | MFA verification on login | Correct TOTP → session; wrong code → retry with clear error; throttle visible | BLOCKED | Server-side verify + throttle unit-tested |
| A6 | Recovery codes (single-use) | Each code consumes once; exhausted set forces re-enroll path | BLOCKED | Server suite |
| A7 | Expired/invalid token handling | 401 → clear token → login screen; no infinite loops; offline queue pauses, nothing lost | BLOCKED | Outbox 401-pause engine tests (m3-outbox-core) |
| **Attendance** ||||
| B1 | Normal geofence check-in/out | Punch lands; statuses + toast honest; method policy respected | BLOCKED | 12 server replay-contract tests + policy gates unit-tested |
| B2 | Geolocation permission grant/deny flows | Grant → punch; deny → actionable message, no crash | BLOCKED | Permission code path typecheck-only |
| B3 | Geofence validation (inside/outside fence) | Inside → accepted; outside → denied with distance info | BLOCKED | Server-side distance math unit-tested; client capture typecheck-only |
| B4 | Selfie attendance (camera permission → preview → capture → confirm → upload) | Full flow completes; ≤640px upload; explicit confirm required | BLOCKED | T-13 flow unit + contract pinned; camera UX unverified |
| B5 | Camera permission denied/recovery | Deny → guidance to settings; no hang | BLOCKED | — |
| B6 | Image upload failure + retry | Failed upload keeps entry pending; retry reuses the SAME idempotency key; no double punch | BLOCKED | Server replay idempotency fully unit-tested |
| **Offline outbox** ||||
| C1 | Capture attendance while offline | Entry queued locally with honest pending state; UI never claims success | BLOCKED | 30 engine tests (queue/backoff/persistence) |
| C2 | Restore connectivity → sync | NetInfo reconnect triggers debounced drain; entries sync automatically | BLOCKED | Engine + wiring design; NetInfo behavior device-only |
| C3 | Duplicate event prevention | Same `clientEventId` replays idempotently — one row, one event, one notification | BLOCKED | AUTOMATED-TEST-VERIFIED (12 server tests) — device leg pending |
| C4 | Auth expiry DURING sync | Queue pauses (`authPaused`), nothing lost; re-login drains | BLOCKED | Engine unit tests |
| C5 | Permanent failure handling | Entry terminal with server message; dismiss requires acknowledgment | BLOCKED | Engine unit tests |
| C6 | REVIEW_REQUIRED delayed punches | Delayed offline punch → HR review queue with device timestamp evidence | BLOCKED | Server classification matrix unit-tested |
| **Push notifications** ||||
| D1 | Device registration on login | `push.registerDevice` with real Expo token; fails closed without projectId | BLOCKED | Config + schema contract pinned (T-15) |
| D2 | Token refresh (app reinstall/update) | New token registered; old token gone (unregister on logout) | BLOCKED | Contract pinned |
| D3 | Notification receipt (foreground/background) | Tenant push arrives and renders | BLOCKED | Requires real EAS push — impossible from sandbox |
| D4 | Notification tap → deep navigation | Tap routes to the right screen | BLOCKED | — |
| D5 | Logout token cleanup | `push.unregisterDevice` on logout; no ghost devices | BLOCKED | Server contract pinned |

**To unblock §8**: one physical Android device (any API 33+) + one physical
iOS device, a debug/dev-client build with push capability, a test tenant
with MFA-enforced + normal accounts, and ~2 hours of scripted execution.
Record per-scenario: device model, OS version, app build, expected vs actual,
PASS/FAIL, screenshots/logs — then update this matrix and TD-26.

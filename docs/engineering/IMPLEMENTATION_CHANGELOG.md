# Finix HR — Implementation Changelog

> One entry per completed task, per the directive's Step 6 reporting format: task, files changed, functionality, DB changes, tests executed + results, remaining limitations, next task.
> Newest first.

---

## 2026-10-31 — Sixth implementation cycle (M5.1: local build & device-testing preparation)

> Scope discipline: preparation + validation only — no M6 features. Two confirmed
> build/configuration blockers fixed; everything else is verification, documentation
> and one generated APK artefact.

### Entry 30 · M5.1 baseline recovery + repository/environment audit (Phase 1) **[no commit — verification only]**
- **Baseline**: restored from the user's `finix-hr-main-20261031-session5.bundle` (verified complete history, HEAD `5b8071d` — the M5 documentation commit, 23 commits, clean working tree, 0 modified files). The stale pre-M3 tree found at `source/finix-hr` (corrupted `.git`, HEAD unresolvable) was replaced, not merged.
- **Audit findings recorded for the guide**: Bun 1.4.2 pin is load-bearing (sandbox's stock 1.3.14 cannot parse `bun.lock` — `UnknownLockfileVersion`, reproduced); the boot-time env guard refuses unknown `HRM_*`/`ZKTECO_*`/`ADMS_*` names; the seed's SaaS layer rides the main `bun run seed` (owner console `owner@finixhr.local` / dev default `SaasOwner@2026`); mobile URL chain is `EXPO_PUBLIC_API_BASE_URL` → `app.json extra.apiBaseUrl` (**production `https://oms.finixhr.com`**) → `localhost:4055`, so local builds MUST set the env var explicitly; EAS `preview` profile bakes `staging-oms.finixhr.com` (host did NOT resolve from the build environment); desktop config is the post-`591a82e` local-hub design (`frontendDist: "../ui"`, runtime-configurable server URL) — `docs/MULTI-PLATFORM.md` §3 still documents the pre-hub config (flagged as stale, deliberately not rewritten in this cycle).
- **Tests executed**: full gate on the untouched baseline — `scripts/ci.sh` (E2E_SKIP=1) exit 0 (14 stages, 1,776/1,776 unit), root + mobile `tsc` 0, ESLint 0 errors (12/10 advisory warnings), `next build` exit 0, expo-doctor 17/18 (the one advisory → Entry 32).
- **Next task**: Entry 31.

### Entry 31 · Fix `bun run seed` crash — the EARNED leave-type alias has no `ltDefs` row **[commit `fix(seed)`]**
- **Task**: the first real blocker of the M5.1 directive — "the web app must actually run locally".
- **Files changed**: `src/hrm-server/seed.ts` (leave-balance loop, +9/−3).
- **Functionality**: the loop iterated `Object.entries(leaveTypes)` — a map that carries the LVE-113 `EARNED → ANNUAL` alias — and dereferenced `ltDefs.find(x => x[0] === ltCode)![3]`, which is `undefined` for the alias → `TypeError`, seed aborts mid-employee-loop. Broken since the baseline commit (the alias row never existed in `ltDefs` in any commit; CI never saw it because the unit lane never runs the dev seed). It now iterates `ltDefs` (the 7 real types) using the destructured `entitledDays`; the alias stays for the later fixtures that reference `leaveTypes["EARNED"]` (they resolve to ANNUAL's id). Behaviour-identical for every real type — and a second balance row for the alias would have violated `@@unique([employeeId, leaveTypeId, year])` anyway (same leaveTypeId as ANNUAL).
- **DB changes**: none (seed script only; no schema/migration change).
- **Tests executed**: full `bun run seed` to completion on a fresh `hrm_dev` — 134,239 rows across 45 tables; `bun run seed:verify` exit 0 (one date-dependent fixture quirk documented in the guide §11.3: the October payroll run legitimately recovers one of the two loan-arrears installments); `scripts/seed-new-modules.ts`, `scripts/migrate-role-perms.ts`, `scripts/seed-approval-workflows.ts` all exit 0.
- **Remaining limitations**: no automated test pins the dev seed (dev-only tooling; e2e lane boots the real app without it) — the honest guard is this entry + the guide's re-run instructions.
- **Next task**: Entry 32.

### Entry 32 · Align `expo-image-manipulator` to the SDK-52-expected version **[commit `chore(mobile)`]**
- **Task**: the single expo-doctor advisory found in the baseline audit (TD-30 family).
- **Files changed**: `mobile/package.json` (`~13.0.3` → `~13.0.6`), `mobile/package-lock.json`.
- **Functionality**: patch-level alignment inside Expo SDK 52 — exactly what `expo-doctor` prescribes (`npx expo install expo-image-manipulator`). Selfie-resize behaviour unchanged (the module is used for the ≤640px selfie downscale).
- **DB changes**: none.
- **Tests executed**: `npx expo-doctor` → **18/18 checks pass** (was 17/18); mobile `tsc --noEmit` 0; mobile ESLint 0 errors; `npm ci` lockfile-exact.
- **Remaining limitations**: none.
- **Next task**: Entry 33.

### Entry 33 · Web local-execution verification (end-to-end, against the real server) **[no commit — verification only]**
- **Verified chain** (PostgreSQL 17.11 local, dev `.env` with a freshly generated `HRM_MFA_KEY`): `bun install --frozen-lockfile` (579 pkgs) → `bunx prisma generate` → `prisma migrate deploy` (48 migrations, clean DB creation) → full seed chain (Entry 31) → `bun run dev` (binds `0.0.0.0:4055`) → `/login` renders → `POST /api/hrm {"action":"auth.login","payload":{…}}` → first-login rotation (`passwordExpired` + `pwToken`) → `auth.password.change` → re-login (Bearer token) → authenticated `ess.dashboard` returns live seeded data (23 present / 12 late / 1 absent etc.).
- **Honest detours recorded** (now §9.4 of the guide): the RPC envelope is `{action, payload}` — top-level params produce a clean 401 with an empty-email audit row; a foreign `DATABASE_URL` in the shell (sandbox artifact) overrides `.env` for the Prisma CLI and produces a confusing P1012.
- **Next task**: Entry 34.

### Entry 34 · Android development APK — actually generated and verified in the build environment **[no commit — artefact + guide; `mobile/android/` is gitignored CNG output]**
- **Toolchain assembled** (all inside the build environment): Android cmdline-tools + `platform-tools`, `platforms;android-35`, `build-tools;35.0.0`, NDK 26.1.10909125 (auto-installed by Gradle), Temurin JDK 17 (the sandbox's Java 21 is JRE-only — Gradle toolchain fails with `[JAVA_COMPILER]` missing), Gradle 8.10.2 via the RN wrapper, AGP 8.6.0. A **sandbox-only** `~/.gradle/init.gradle` mirrored `repo.maven.apache.org` → Aliyun because Maven Central rate-limited (429) the sandbox IP on the large `react-android` AAR; no project file was modified for this.
- **Build**: `npx expo prebuild -p android --no-install` → `gradlew assembleDebug` (13 attempts across disk/JDK/429 failures; final successful pass with `reactNativeArchitectures=arm64-v8a`) → **`app-debug.apk` — 151,081,956 bytes, 1,231 entries**. One cosmetic ledger task (`createDebugApkListingFileRedirect`, an IDE redirect file) could not complete — sandbox disk exhaustion (9.9 GB rootfs); the APK itself was fully packaged and is intact.
- **Artefact verification**: `aapt2 dump badging` → package `com.finixhr.app`, versionName 1.0.0, versionCode 1, compileSdk 35, all expected permissions (fine/coarse/background location, camera, internet, notifications + POST_NOTIFICATIONS, boot-completed, vibrate, c2dm/FCM receive); `apksigner verify --print-certs` → exit 0, Android Debug certificate; contents: 22 dex files + full arm64-v8a native set (libc++_shared, libexpo-modules-core, libfbjni, libhermes, libjsi, fresco); **no embedded JS bundle** (debug build — JS is served by Metro at runtime, by design). Copied to the delivery folder as `finix-hr-dev-arm64-debug.apk`.
- **Constraints stated in the guide**: debug-signed with the build environment's keystore (uninstall before reinstalling a locally-built variant), arm64-v8a only, requires Metro + `adb reverse tcp:8081 tcp:8081` (or the in-app dev-server host setting) — §4/§5 of the guide.
- **DB changes**: none.
- **Tests executed**: the build itself; `aapt2`/`apksigner` verification; gradle task ledger in `/tmp/gradle-final*.log` (ephemeral — the guide records the outcome, not the sandbox logs).
- **Remaining limitations**: release-APK variant not built (disk); EAS cloud build not run (no EAS credentials in this environment); iOS untouched.
- **Next task**: Entry 35.

### Entry 35 · `LOCAL_BUILD_AND_DEVICE_TESTING_GUIDE.md` — the M5.1 deliverable **[this commit]**
- **Files changed**: `docs/engineering/LOCAL_BUILD_AND_DEVICE_TESTING_GUIDE.md` (new, 11 required sections + a verified-evidence §0), this changelog.
- **Functionality**: the single document the owner needs to build, install, launch and manually test Web + Android + Windows Desktop on their own hardware — exact commands only (Bun 1.4.2, JDK 17, PostgreSQL 17, `adb reverse`, firewall rule, `tauri dev`/`tauri build`, EAS profiles audit, URL-resolution rules, logging/troubleshooting incl. the seven traps actually hit during this cycle), the §8-matrix-based manual checklist with per-scenario evidence fields (A1–A7, B1–B6, C1–C6, D1–D5, + W1–W5 desktop rows), and the honest limitations register (device pass BLOCKED pending the owner's execution; iOS BLOCKED; hosted URLs unverified from here; targetSdk 34 store-ineligible by design for now).
- **DB changes**: none.
- **Tests executed**: `bash scripts/check-docs.sh` → all referenced paths/scripts exist (stage 8 green with the new file); full AFTER-gate below.
- **Remaining limitations**: §10 execution is the owner's act — nothing in the repo claims VERIFIED-ON-DEVICE.
- **Next task**: M6 planning with the owner (awaiting review/approval per the directive).

### Cycle verification summary (M5.1)

| Check | Before cycle (baseline `5b8071d`) | After cycle (verified 2026-10-31) |
|---|---|---|
| Root typecheck | PASS | **PASS** |
| Root ESLint | 0 errors / 12 warnings | **0 errors / 12 warnings** (unchanged) |
| Mobile typecheck | PASS | **PASS** |
| Mobile ESLint | 0 errors / 10 warnings | **0 errors / 10 warnings** (unchanged) |
| expo-doctor | 17/18 (1 advisory) | **18/18** |
| Full gate `scripts/ci.sh` | exit 0 | **exit 0** — 14/14 stages |
| Unit tests | 1,776/1,776 | **1,776/1,776** (158 files) |
| Next.js production build | PASS | **PASS** |
| Dev seed (`bun run seed`) | **CRASH** (TypeError, since baseline) | **completes** — 134,239 rows + verify exit 0 |
| Web app local run | never verified | **verified end-to-end** (login → rotation → Bearer RPC) |
| Android APK | not buildable here | **built + verified** (151 MB debug arm64) |
| Windows desktop build | n/a in sandbox | **BLOCKED here** (no Rust/webkit2gtk) — previously verified on the owner's machine; exact commands in the guide |

---

## 2026-10-31 — Fifth implementation cycle (M5: hosted-CI verification + T-18…T-20 + TD-27 investigation)

### Entry 23 · Baseline recovery + hosted-CI run verification (Phase 1) **[no commit — verification only]**
- **Baseline found (not assumed)**: the sandbox recycle again destroyed `.git/objects` (and the gh CLI/credential store). Restored from the user's `finix-hr-main-20261030-session4.bundle` (HEAD `86ef368`), re-fetched `origin/main` — **local `main` = `origin/main` = `86ef368`, clean tree, 0/0 ahead-behind**. The stale pre-M3 working tree found in the sandbox was moved aside, nothing deleted.
- **Hosted CI verified with API evidence** (not the JS-heavy web page): run **41091970369** — CI #8, push event, `main` @ `86ef368` (the latest intended main), conclusion **success** 16:40:08Z→16:48:53Z. Per-job/per-step: Web success (16/16 steps: pinned Bun 1.4.2 frozen install, prisma generate + migrate deploy, tsc, ESLint hard gate, secret scan, full `scripts/ci.sh`, Next.js build), Mobile success (npm ci, tsc, expo-doctor advisory), Docker success (`docker build -t finix-hr:86ef368…`).
- **Honest findings recorded**: the Docker job is **build-only — no registry push step exists**; no image tag/digest is published anywhere (build ≠ push ≠ deployment). The run's one "error" annotation is the advisory expo-doctor version-pin finding (TD-30) — continue-on-error by design. E2E_SKIP=1 is the only other deliberate skip (printed, not masked).
- **Timing cross-check** resolved a contradiction in the web-page scrape ("Mobile failed"): `docker-build` has `needs: [web, mobile]` and it RAN (1m44s after Web finished) — a failed Mobile would have skipped Docker and ended the run at Web's 6m53s, not 8m45s. The API's per-step data confirms Mobile green.
- **Tests executed**: GitHub REST API `/actions/runs/41091970369` + `/jobs` (HTTP 200) — the authoritative source.
- **Limitations**: the run covers the M4 SHA `86ef368`; M5 commits are local (no push credential again — wiped by the recycle).
- **Next task**: T-18.

### Entry 24 · T-18 · `ess.leave` payload bound + full ESS list-caps audit **[commit `da905bf`]**
- **Task**: cap the one remaining unbounded ESS read; audit every remaining ESS action for unbounded reads (master plan T-18, P1).
- **Files changed**: `src/hrm-server/routes/ess.ts` (+50/−6), `tests/unit/t18-ess-list-caps.test.ts` (new).
- **Functionality**: request history `take: 200` (newest first) + OPTIONAL `{ month, year }` filter on the leave START date (`fromDate` prefix, mirroring `ess.attendance`); substitutes 200; profile documents 100; own bank accounts 20 (primary-first — the model has no timestamp, caught by tsc); loans/advances/guarantees 100; performance reviews/kpis/cycles 100; documents/letters 100; myAssets 200; leave-type catalog 100; colleagues org catalogs 200. Decoration `in:`-set reads classified transitively bounded with the reasoning pinned in the test allowlist. Response shape unchanged — existing web/mobile callers send no payload.
- **DB changes**: none.
- **Tests executed**: `bun test tests/unit/t18-ess-list-caps.test.ts` — **6/6** (behavioral cap at 230 seeded rows, month filter incl. cross-year, substitute cap at 250, shape preservation, structural pin over EVERY findMany in ess.ts, documented cap values).
- **Remaining limitations**: the structural pin allowlists month-prefix reads and `in:`-set decoration reads by design (each classification documented in-file).
- **Next task**: T-19.

### Entry 25 · T-19 · Tenant-isolation negative tests for the ESS plane **[commit `c13b68d`]**
- **Task**: prove vendor/employee scoping under adversarial payloads for `ess.*` + `tracking.status` + punch actor resolution (master plan T-19, P1).
- **Files changed**: `tests/unit/ess-isolation.test.ts` (new, 290 lines).
- **Functionality**: 20 tests at the REAL dispatcher boundary — cross-tenant ess.* reads under forged `employeeId`+`vendorId` payloads never leak vendor-B rows (six read families + symmetric positive control); same-tenant coworker markers never leak; `ess.payroll.html` IDOR (every entryId combination → 404); `tracking.status` actor resolution (EMPLOYEE self-only, staff-without-attendance.edit via PAYROLL_OFFICER); punch actor resolution for all three self-service punch actions (forged id → 403; staff act-for-other needs permission AND tenant scope — cross-tenant 404 with zero rows written; same-tenant privileged path as audited positive control); no-profile sessions get clean denials.
- **DB changes**: none (fixtures only).
- **Tests executed**: `bun test tests/unit/ess-isolation.test.ts` — **20/20 twice consecutive**.
- **Re-learned honestly en route**: RBAC-103 permission resolution is role-template ∪ explicit grants (grants only widen) — an HR_ADMIN can never be stripped below template, so the missing-permission denial is probed with PAYROLL_OFFICER (a role whose template genuinely lacks `attendance.edit`); `tracking.status`'s no-profile Deny carries no explicit code (403) while ess.* uses 400. Expectations were corrected against actual behavior, never the reverse.
- **Remaining limitations**: none for the documented scope.
- **Next task**: T-20.

### Entry 26 · T-20 · Prefixed aliases for unprefixed route modules **[commit `1a0f9d9`]**
- **Task**: registry alias support with both names resolving, after the web call-site inventory (master plan T-20, P1; contract audit §5.1).
- **Files changed**: `src/hrm-server/routes/registry.ts` (+38), `performance.ts` (+29), `roadmap.ts` (+31), `ess.ts` (orderBy fix), `tests/unit/t20-route-aliases.test.ts` (new), `docs/engineering/API_CONTRACT_AUDIT.md` (§5.1 resolution + §9 M5 record).
- **Functionality**: `alias(action, target)` registers a prefixed twin sharing the canonical RouteDef OBJECT (perm/schema/handler/lockout classification identical by construction; loud failures on unknown target/collision); 42 aliases (16 `performance.*`, 26 feature-module-prefixed roadmap twins); flat names stay canonical + deprecated for new consumers. Dispatcher gating parity proven: no alias prefix enters `SAAS_ACTION_PREFIX_MODULE`, alias heads match canonical heads for the lockout heuristic, perm gates are shared objects.
- **DB changes**: none.
- **Tests executed**: `bun test tests/unit/t20-route-aliases.test.ts` — **8/8** (def-object identity for all 42, exact inventory pin, 37 SPA flat call sites keep resolving, prefix-gate parity, dispatcher behavioral parity incl. identical permission denials); `python3 scripts/audit-perms.py` — 602 actions gated/annotated, frontend calls all resolve; regression batch (mobile-contract, payload-validation, r3-5-wave, employees-perms + the three M5 suites) — **133/133**.
- **Remaining limitations**: flat-name removal would need a coordinated migration — explicitly out of scope (deprecation only).
- **Next task**: full-gate regression.

### Entry 27 · De-flake the attendance sweeps (weekend class) **[commit `2a24156`]**
- **Task found during regression**: ATT-006 + SCL-14 failed on the full suite run — investigation proved the failures PRE-EXISTING (identical at baseline `86ef368`, the SHA that passed hosted CI): both tests use a RELATIVE `yesterday`, and the default `weeklyHoliday` is `["FRIDAY"]` (BD convention) — on Sat 2026-10-31 "yesterday" was the weekly off, so the sweep skipped everyone. Hosted CI passed Friday only because Thursday preceded it; every Fri/Sat gate run would have been red.
- **Files changed**: `tests/unit/r3-engines.test.ts`, `tests/unit/phase2-ws1-scheduler.test.ts` (weekly-off-hermetic settings objects passed to the sweeps; each test keeps verifying exactly what it verified before).
- **Tests executed**: the two files — 28/28 on a Saturday; full suite **1776/1776**.
- **Remaining limitations**: r3-4's ATT-303 was already safe (fixed Monday date).
- **Next task**: mobile lane verification.

### Entry 28 · Mobile ESLint crash fixed + mobile lane verified **[commit `a248376`]**
- **Task**: the M3-known `npx eslint .` crash (TD-23) — root-caused and fixed while running the M5 regression lanes.
- **Root cause**: mobile had NO ESLint config of its own; ESLint 8.57 (flat-capable) searched ancestors, loaded the ROOT web-app `eslint.config.mjs`, and instantiated its typescript-eslint v8 rules under the mobile-local 8.57 linter → TypeError on `no-unused-expressions` options shape.
- **Files changed**: `mobile/eslint.config.mjs` (new — FlatCompat bridge for `eslint-config-expo@8`, plugins resolve from the mobile tree), `mobile/app/(auth)/mfa-enroll.tsx` + `mobile/src/components/SelfieCapture.tsx` (two dead a11y disable pragmas removed — they referenced a rule no mobile config defines and broke the now-working run).
- **Tests executed**: `npx eslint .` in mobile/ — **0 errors / 10 warnings, exit 0** (warnings split out as TD-29); `npx tsc --noEmit` — 0; `npx expo-doctor` — 17/18 (1 advisory version-pin finding, TD-30, same as the hosted run's annotation); `npm ci` — clean.
- **Remaining limitations**: mobile lint is still NOT a hosted-CI gate (candidate once TD-29's warnings clear); no dependency changes made (eslint-plugin-jsx-a11y was tested and removed — the config chain does not reference it).
- **Next task**: documentation.

### Entry 29 · M5 documentation + TD-27 investigation + device matrix **[this commit]**
- **TD-27 (Phase 3) investigated, NOT implemented**: full platform analysis + wiring recommendation in `OFFLINE_OUTBOX.md` §11 — Android feasible via expo-background-fetch (WorkManager, best-effort ≥15 min, `stopOnTerminate:false` covers terminated apps; Doze/vendor battery managers may defer); **iOS BackgroundFetch never fires for terminated apps (official Expo docs)** — the honest iOS contract is foreground/notification-tap sync; headless-context drain is spec'd (`getEngine(); load(); syncOnce()`); the M3 idempotent-replay contract already makes cross-context duplicate-safe. Deferred: the acceptance test needs a physical device.
- **Device pass (Phase 2) BLOCKED, honestly**: no physical device/emulator/Xcode in the sandbox. The complete scripted matrix (24 scenarios: auth A1–A7, attendance B1–B6, offline outbox C1–C6, push D1–D5, each with expected results and today's evidence column) is recorded in `PRODUCTION_READINESS_CHECKLIST.md` §8.
- **Docs updated**: MASTER_IMPLEMENTATION_PLAN (T-18/19/20 delivered + M5 record + M6 recommendation), TECHNICAL_DEBT_REGISTER (TD-7/9/23/24 resolved; TD-26/27 re-scoped; TD-29/30/31 added), MODULE_IMPLEMENTATION_STATUS (counts + affected rows), PRODUCTION_READINESS_CHECKLIST (verdicts, §6 hosted-CI resolution, §7 risks, §8 device matrix), API_CONTRACT_AUDIT (§5.1 resolution + §9), OFFLINE_OUTBOX (§11).
- **Full-gate regression (Phase 5)**: `scripts/ci.sh` (E2E_SKIP=1) — **exit 0, 1m58s** on a Saturday (all 14 stages: tsc, lint 0 errors, unit 1776/1776, config guard, secret scan, scrypt gate, destructive-op guard, docs guard, permission lint 602, dependency audit, fresh-DB migration smoke, schema drift, perf budget, E2E skipped-by-design). Mobile: npm ci + tsc 0 + eslint 0 errors + expo-doctor 17/18. Docker build: **NOT RUN locally (no docker in this sandbox)** — last verified by hosted CI at `86ef368`.
- **Remaining limitations**: M5 commits local (no push credential); device matrix BLOCKED; TD-27 implementation deferred to a device-in-the-loop session.
- **Next task**: M6 — push + re-verify hosted CI on the M5 SHA, then the device pass + TD-27 Android wiring.

---

## Continuation note (2026-10-30, second session)

The first implementation cycle was interrupted mid-flight: the mobile fixes,
migration 11 and the desktop CSP edit existed only as UNCOMMITTED working-tree
changes, and two entries below (T-01's workflow rewrite, T-17's contract test)
had been written into this changelog before the files were actually created.
This session verified every claim against the tree, completed the missing
pieces, and committed the cycle as one commit per task. Entries corrected
below are marked **[corrected]**; nothing else about the first cycle changed.

Additional contract bugs found and fixed while completing the cycle (folded
into the T-06 commit):
- `push.registerDevice` was sent `platform: Platform.OS` (`"android"`/`"ios"`)
  which is NOT in the server enum `["expo","fcm","apns"]` — every push
  registration was silently rejected by schema validation;
- `push.unregisterDevice` was called with an EMPTY payload on logout although
  the schema REQUIRES `token` — the 400 was swallowed, so devices kept
  receiving tenant pushes after sign-out. The token is now persisted at
  registration and sent at logout;
- the Modules hub's promised permission gating (Entry 6) had never been
  written — it is now implemented with a registry-derived perm map;
- `profile.tsx` guarded against the now-optional `AuthUser.vendorId`.

---

## 2026-10-30 — Fourth implementation cycle (M4: GitHub integration + T-14…T-16)

### Entry 17 · Baseline verification + GitHub integration · resolve the botched New-Update merge **[commit `ac022d4`]**
- **Baseline found (not assumed)**: the sandbox recycle had destroyed `.git/objects` (refs intact, reflog showing only the GitHub clone). Recovered the M3 history from `finix-hr-main-20261030-session3.bundle` (verified complete, HEAD `b4c0f15`) into `refs/heads/m3-history`, re-fetched `origin/main`.
- **The real state of GitHub `main` (`c172f2c` "New Update")**: a merge of the M3 tree into the release line committed WITH unresolved conflicts — 71 tracked files carried `<<<<<<< ======= >>>>>>>` markers (`bun.lock`, `next-env.d.ts`, every mobile screen the merge touched, owner-console pages, server routes) and `bun install --frozen-lockfile` + `tsc` both failed. The release line's CI could not catch it (`|| true` typecheck — TD-1/TD-01 unfixed on GitHub).
- **Resolution evidence (no blind overwrite)**: release tip `591a82e` vs M3 vendor-drop root `e7e34eb` differ only in lockfiles + file modes (zero source lines — the vendor drop already contains the whole release line: EAS/google-services wiring, desktop iframe fix, bearer/CSRF tightening, desktop UI); `c172f2c`'s tree adds no file `b4c0f15` lacks (it only lacks `prisma/db/.gitkeep`). Therefore every conflict resolves to the M3 side: tree reset to `b4c0f15` exactly as a FORWARD commit on top of the user's own `c172f2c` — no force-push, no history rewrite, no remote commits deleted. This also restored the honest 14-stage `ci.yml` (+84 lines) and the conflicted `bun.lock` → the verified M3 lockfile.
- **Files changed**: 929 files (−1846 conflict-junk lines, +84 CI-gate/.gitkeep lines; the rest mode-only).
- **Verification on the resolved tree**: `bun install --frozen-lockfile` 579 packages; `tsc --noEmit` 0; eslint 0 errors (9 advisory warnings); `bun test tests/unit` **1728/1728 in two consecutive runs**; mobile `npm ci` + `tsc` 0.
- **Limitations**: push to GitHub blocked (no credential — TD-24); the M3 line's 22-commit history is preserved locally as `m3-history` and in the bundle, NOT pushed.

### Entry 18 · Test isolation · de-flake phase3-wsd-mobile (pwgrant throttle bucket) **[commit `ae90869`]**
- **Root cause**: `phase-r5-security-isolation`'s deliberate per-IP-throttle exhaustion test left the DB-backed `pwgrant:ip:*` bucket (Throttle table, 10/5 min) full after cleaning only its login-audit rows. bun runs all unit files in one process against one database, so phase3-wsd-mobile's bad-credential grant inherited the full bucket → 429 instead of 401. Deterministic in any full suite not crossing a 5-minute window boundary (the M3 runs got lucky); passes in isolation.
- **Fix**: the test's cleanup now also deletes the `pwgrant:ip:*` namespace — hermetic-suite class, same as `a5fc1af`. No assertion weakened.
- **Tests**: full suite 1728/1728 twice after the fix.

### Entry 19 · T-14 · Native first-login MFA enrollment wizard **[commit `cc280f0`]**
- **Files changed**: `mobile/src/lib/auth.ts` (+98 — `enrollToken` state, `startMfaEnrollment`, `completeMfaEnrollment`, honest `login()` result), `mobile/app/(auth)/mfa-enroll.tsx` (new, 3-step wizard), `mobile/app/(auth)/login.tsx` (hand-off), `tests/unit/mobile-contract.test.ts` (pins).
- **Functionality**: unenrolled users on MFA-required roles complete enrollment natively: server-issued QR (220px PNG data-URL) + selectable manual-entry secret → first TOTP code → recovery codes shown EXACTLY once with explicit save confirmation. The 15-minute PREAUTH enrollToken carries no API rights (C-1). Errors surfaced verbatim (expired window → back to sign-in; rate limit; wrong code). No success before `auth.mfa.enroll.enable` returns.
- **DB changes**: none (server contract pre-existing — H-1 suite, 10 behavioral tests, untouched).
- **Tests**: contract pins (both actions registered + public + app-referenced) — green; mobile tsc 0.
- **Limitations**: NOT device-verified (TD-26); no biometric/liveness claims anywhere.

### Entry 20 · T-15 · Push registration honesty + EAS projectId resolution **[commit `4234159`]**
- **Premise correction**: app.json already carried `expo.extra.eas.projectId` `5df89cc1-1316-49e8-ae1d-4ced3b9a69b5` (release line's `eas init`, EAS build `30e4a348` completed against it). The M-line audit missed the nested key. The plan's task text is annotated accordingly.
- **Files changed**: `mobile/src/lib/push.ts` (full guard, fail-closed, explicit resolution), `tests/unit/mobile-contract.test.ts` (config pin).
- **Functionality**: registration can no longer throw past its caller or break startup; unconfigured projectId → no token minted (no dead `DeviceToken` rows); server-registration failure → null + honest log + nothing stored (was: minted token returned as success). `EXPO_PUBLIC_EAS_PROJECT_ID` overrides the manifest for build-time repointing. Unregister payload already correct from the first cycle.
- **DB changes**: none. **Tests**: contract pin green; mobile tsc 0.
- **Limitations**: real-device push receive + logout-unregister NOT verified (TD-26).

### Entry 21 · T-16 · Web export honesty audit + failure tests **[commit `7ffda93`]**
- **Audit result (server handler + client toast timing, every web export path)**:
  | Path | Verdict |
  |---|---|
  | `payroll.export.salary` (csv/xlsx/pdf) | honest — 404 no-match, 400 cancelled run, 403 BANK w/o `bankInfo.view`; real bytes, truthful totals, audited; client toasts AFTER the blob click with response totals |
  | `backups.export` | honest — 3 gates (typed confirm, password re-auth, pre-audit), job queue → poll → download → toast with real table/row counts |
  | `attendance.events.export` | honest — rowCount + truncated cap flag; client toasts real counts, truncation is an error toast |
  | `employees.exportCsv`, `reports.audit.export` | honest — capped, count + truncated flags; toasts after click with real counts |
  | `reports.attendanceOverviewCsv`, `reports.holidayCalendarIcs`, shared `DataTable` CSV | honest — real generated text; toast (if any) after delivery |
  | `employees.docs.download`, `letters.download` | honest — 404s, entitlement/self-scope gates, strict decrypt fails loudly |
  | `pf.template.download` (client) | **WAS broken** — silent no-op when the response carried no base64; now errors loudly (`payroll.tsx`) |
- **Files changed**: `src/hrm/views/payroll.tsx`, `tests/unit/t16-export-honesty.test.ts` (new, 12 cases).
- **DB changes**: none.
- **Tests**: 12/12 green — unknown-run 404; cancelled-run 400; no-match 404; BANK-without-perm 403 (custom-role fixture); csv/xlsx/pdf real bytes (ZIP `%PDF` magic) + true totals; designated-but-accountless BANK employee → visible skip list; audit row with real totals; events rowCount == delivered lines; PF template always a decodable workbook (zero-employee tenant included).
- **Limitations**: toast timing is code-audited, not browser-E2E-tested (no Playwright lane for the SPA).

### Entry 22 · M4 documentation + CI env hardening **[commits `817503e` + this one]**
- **CI env fix (`817503e`)**: running the full gate under the workflow's OWN exported env (both URLs at hrm_test) exposed a latent first-run failure — the unit preload's dev-database protection refuses the TEST_DATABASE_URL candidate and falls through to the `?schema=hrm_unit_test` topology, under which the trigram DDL test fails (42704, pg_trgm dropped with the reset public schema). Fix: workflow `DATABASE_URL` points at the maintenance `postgres` database; the migrate-deploy step gets an explicit hrm_test step env. Proof: the full 14-stage gate passes under the exact fixed env locally.
- Master plan (phase map, T-14/15/16 entries with delivered scope + corrected T-15 premise, M4 completion record, M5 recommendation), module status (auth row now Functional w/ wizard; push shell note; NOT-claimed list refreshed), debt register (stale TD-4/TD-5 annotated RESOLVED per M2 evidence; TD-24 re-scoped to the precise credential blocker; new TD-26 device verification, TD-27 headless background sync, TD-28 the broken-main incident), readiness checklist (§1 counts, §4 M4 scope, §6 exact blocker + setup steps, §7 refreshed risks), API contract audit (§8 M4 addendum).

---

## 2026-10-30 — Third implementation cycle (M3: offline outbox + selfie attendance)

### Entry 12 — T-12 (server half) · Idempotent replay + offline-capture classification **[commit `dcbea29`, verified this session]**
- **Files changed**: `src/hrm-server/routes/attendance.ts` (+192), `src/hrm-server/validation.ts` (+10), `tests/unit/m3-offline-outbox-server.test.ts` (new, 292 lines).
- **Functionality**: all three punch routes (`attendance.geofence.checkin/checkout`, `attendance.selfie.checkin`) recognize a retried punch by its tenant-scoped `{vendorId, "ci:"/"co:"/"si:" + clientEventId}` key and return the recorded outcome (`idempotentReplay: true`) with ZERO side effects re-run (pre-M3: selfie bytes stored twice, notifications re-fired, a lost-response retry answered with a bogus `Already checked in today` 400). Replay check precedes feature gate / selfie throttle / storage quota / method policy / geofence / H-4. New optional schema fields `offlineCapture` + `clientTimestamp` classify delayed device captures: ≤120 s like online; >120 s or missing timestamp → `OFFLINE_CAPTURE` flag, `REVIEW_REQUIRED` + `PENDING`, HR notified, device timestamp preserved; attendance punch time stays the server receipt time.
- **DB changes**: none (reuses the existing `unique(vendorId, clientEventId)` on AttendanceEvent).
- **Tests executed**: `tests/unit/m3-offline-outbox-server.test.ts` — 12/12 PASS (replay exactly-one row/event/proof/notification; review verdict survives replay; throttle bypass; H-4 for distinct ids; tenant scoping; offlineCapture matrix).
- **Remaining limitations**: none known in this half; full architecture record in `docs/engineering/OFFLINE_OUTBOX.md`.

### Entry 13 — T-12 (mobile half) · Persistent offline outbox for attendance punches
- **Files changed**: `mobile/src/lib/outbox-core.ts` (new, 517 lines — dependency-free engine), `mobile/src/lib/offline.ts` (new, 275 lines — AsyncStorage/NetInfo/AppState/zustand wiring), `mobile/app/(tabs)/attendance.tsx` (offline UX + queue UI), `mobile/app/_layout.tsx` (boot + resume hooks), `mobile/src/lib/api.ts` (error-body precedence fix), `mobile/package.json` + lockfile (`@react-native-community/netinfo`, `expo-image-manipulator`), `tests/unit/m3-outbox-core.test.ts` (new, 30 tests), `tests/unit/mobile-contract.test.ts` (+3 pins).
- **Functionality**: closed action union (`attendance.geofence.checkin/checkout` ONLY); AsyncStorage persistence (`finixhr_outbox_v1`) surviving app/device restart; stuck-`syncing` recovery on load; exponential backoff 5 s→10 min cap ±20 % jitter; error classification (401→auth pause + post-login resume; network/429/5xx→retryable; other 4xx→permanent rejected with the server's message); one unresolved check-in AND one check-out at a time; queue cap 50; retention 72 h synced / 7 d rejected / pending never dropped; sync triggers on enqueue/reconnect (3 s debounce)/foreground/boot/re-login; the SAME `clientEventId` on every attempt; punch success shown only after server confirmation (today card + 7-state Sync Queue UI).
- **DB changes**: none.
- **Tests executed**: `tests/unit/m3-outbox-core.test.ts` — 30/30 PASS (restart, backoff gating, idempotency field reuse, idempotentReplay resolution, 401 pause/resume, permanent-rejection terminality, photo-safety removal, retention, summary truth). Mobile typecheck PASS. Full suite 1728/1728.
- **Remaining limitations**: leave requests NOT offline-eligible (needs a server idempotency contract first — TD-25); react-native wiring layer verified by typecheck + reasoning only (no device lane in bun); no headless background sync while terminated.
- **Next task**: T-13.

### Entry 14 — T-13 · Native selfie attendance capture
- **Files changed**: `mobile/src/components/SelfieCapture.tsx` (new, 289 lines), `mobile/app/(tabs)/attendance.tsx` (selfie check-in button + policy-required selfie attach + in-memory upload retry).
- **Functionality**: camera-permission flow (actionable denial states) → live front-camera preview with framing guide (guidance only — NO face detection) → shutter → one-pass native downscale to ≤640 px JPEG q0.7 data-URL (matches the web contract; nothing full-res leaves the pipeline) → explicit Confirm/Retake → submit via `attendance.selfie.checkin` with best-effort GPS and honest metadata. Policy-required selfies attach to geo punches; if the first submission of a photo-carrying punch fails, the pending outbox entry is REMOVED (photo bytes never rest in device storage) and the user is told the punch was not recorded. Upload retries reuse the same `clientEventId` (server replay → photo stored once, never a double punch). Online-only by design; selfie = proof of presence, NOT identity verification.
- **DB changes**: none (server side pre-existing: byte-sniff validation, quota metering, sha-256 hash, retention, private storage).
- **Tests executed**: schema/payload pins in `mobile-contract.test.ts` (photo required, GPS optional, quality metadata accepted); selfie replay guarantees in `m3-offline-outbox-server.test.ts`; pre-existing `selfie-checkin.test.ts` (7 policy tests) unchanged and green.
- **Remaining limitations**: no liveness/face detection (deliberate — no biometric claims); capture component itself not device-tested in this environment.
- **Next task**: baseline re-verification repairs (Entry 15).

### Entry 15 — M3 baseline repairs · three gate blockers found while re-verifying M2
- **Files changed**: `tests/unit/phase5-security-trust.test.ts`, `.gitignore` + `prisma/db/.gitkeep` (new, tracked), `src/hrm-server/routes/auth.ts` (1 marker comment), `.env` (local only, gitignored).
- **Functionality**:
  1. **Flaky security test de-flaked**: the six fixture IPs were `Math.random()`-drawn from three shared documentation ranges; a same-range collision (p≈1/200 per pair) merged fixtures and failed the ordering/exclusion assertions (observed once in three runs, passes in isolation — classic flake signature). Now deterministic fixed slots ≥201, outside every random range. Assertions unchanged.
  2. **`prisma/db/.gitkeep` docs-guard invariant made repo-self-contained**: the file existed only as an untracked working-tree leftover; the sandbox recycle deleted it and stage 8 failed. Now tracked via `.gitignore` `prisma/db/*` + `!prisma/db/.gitkeep` (contents-level ignore keeps `custom.db` protection intact — verified).
  3. **`auth.supportExit` permission-lint marker**: shipped unmarked in the vendor baseline (Wave 10) — stage 9 has been red on it ever since. Added the `INTENTIONALLY_SELF_SCOPED` marker with the honest reason (identity-bound, in-handler 403 guard). 602 actions now all gated or annotated.
  4. **Local `.env` restored** (gitignored): the session recycle lost the previous shell env (`DATABASE_URL` had reverted to the legacy SQLite file URL, breaking the migration-smoke stage). Postgres URLs for dev/test + the CI dummy MFA key.
- **DB changes**: none.
- **Tests executed**: full `scripts/ci.sh` (14 stages, `E2E_SKIP=1`) → **exit 0**; unit suite 1728/1728 (runs after the flake fix: 12 consecutive clean full runs total across the session); `python3 scripts/audit-perms.py` → 0 violations.
- **Remaining limitations**: mobile eslint lane still crashes on rule load (pre-existing, TD-23 — mobile typecheck is the gate).
- **Next task**: Entry 16 (docs).

### Entry 16 — M3 documentation
- **Files changed**: `docs/engineering/OFFLINE_OUTBOX.md` (new — full architecture record: data model, contract, idempotency, retry, classification, storage/security, test coverage, known limitations), `PRODUCTION_READINESS_CHECKLIST.md` (new — evidence-based dev/staging/production verdicts + the hosted-CI blocker record), `MASTER_IMPLEMENTATION_PLAN.md` (phase map, T-12/T-13 delivered-scope, M3 completion record), `MODULE_IMPLEMENTATION_STATUS.md` (attendance offline + selfie rows), `API_CONTRACT_AUDIT.md` (§7 M3 contract additions), `TECHNICAL_DEBT_REGISTER.md` (TD-19 resolved; TD-23/TD-24/TD-25 added).
- **Functionality**: every claim traces to a test, gate run or commit; the hosted-CI blocker (no remote, no credentials) is recorded verbatim rather than papered over.
- **DB changes**: none.
- **Tests executed**: docs guard stage PASS (all markdown-referenced paths exist).
- **Remaining limitations**: hosted CI remains unexecuted (TD-24).

---

## 2026-10-30 — Second implementation cycle (M2: make the honest CI green)

### Entry 10 — T-10 · Clear the unit-suite failures (1683/1683 green)
- **Files changed**: `src/hrm-server/routes/roadmap.ts`, `src/hrm-server/saas/payments/billing-ops.ts`, `tests/unit/phase2-ws4-employee-approval.test.ts`, `tests/unit/phase5-revenue-collections.test.ts` (commit `d3c90aa`); plus 12 route files for the pagination follow-up (commit `eefefa4`).
- **Functionality**: see the three root causes below. Deterministic outcome: the full suite is green in THREE consecutive runs (1683 tests, 13,561 assertions each).
- **DB changes**: none.
- **Root cause 1 — code was wrong (reimbursements.list)**: the handler returned the `{items,total}` envelope UNCONDITIONALLY (V1-002 pagination change), which crashed the web reimbursements register (`rows.filter is not a function` — every HR user with expenses.view) and failed FIN-02. Restored the MOD-16 dual-mode convention: explicit `page`/`pageSize` → paged envelope; absent → legacy array. The receiptData-column exclusion (the valuable half of V1-002) is preserved in both branches.
- **Root cause 2 — code was wrong (createTermInvoice race)**: check-then-create with a P2002 catch that was DEAD CODE (no unique index exists on the term window). Three concurrent calls for the same term each created an invoice — silently duplicated billing. Fixed with a transaction-scoped Postgres advisory lock (`pg_advisory_xact_lock(hashtext(termKey))`) serializing the check+create pair across processes; the P2002 catch stays as defense-in-depth. A partial unique index was deliberately NOT added: it needs a dirty-data review before deployment (existing duplicates would fail `migrate deploy`) — recorded in the debt register.
- **Root cause 3 — tests predated intentional contract moves**: FE-1 `employees.refList` pins `id/code/fullName/status` (the R6/R7 pickers filter by `e.status` — inventory/fieldforce/loans/leave views consume it); `owner.dunning.remind` pins S1-012 (the cadence counter bumps ONLY on a delivered SENT reminder).
- **Flakiness root cause (found live, then fixed)**: the audit's "P6 WS-B loans pagination" failure is REAL and intermittent — OFFSET pagination over non-unique `orderBy createdAt` lets tie order flip between page queries, so a row can appear on two pages or be skipped. 18 paginated queries across 12 route files had the defect class (one had NO orderBy at all). All now end with a unique `{ id: "asc" }` tie-breaker (leave balances use their unique year/employee/type triple). Primary orders unchanged.
- **Not reproducible today**: H-10 ×3, H-3 ×3, M-20, L-10 passed in every run of this environment (fresh-reset DB). They were likely residue/order-dependent in the audit environment; the now-honest CI gate will surface any recurrence.
- **Tests executed**: `bun test tests/unit` ×3 (1683 pass / 0 fail each); the previously-failing files standalone; schema-drift gate PASS; fresh-DB migration smoke PASS.
- **Remaining limitations**: the advisory-lock timeout is 15s (serialized callers queue behind a slow create); the partial unique index is deferred pending a dirty-data review.
- **Next task**: T-11.

### Entry 11 — T-11 · Clear the 87-error lint debt (eslint exits 0)
- **Files changed**: 13 mobile files + 26 web/server files (commits `308ee38`). Full list in the commit message.
- **Functionality**: 82 errors cleared (the audit's 87 minus five that were warnings-class) — 42 unused imports/vars, 7 unescaped JSX entities, 19 refs-in-render, 5 setState-in-useMemo, 3 unpreservable memoizations, 2 impure Date.now calls, 2 non-literal dependency lists, plus one dead-code helper and one non-null assertion.
- **Bonus bug fixed by the pass**: the AIT `SLAB_OVERFLOW` warning always reported `৳0` — `remaining` was zeroed BEFORE the warning message was built. The amount is now captured first.
- **Notable conversions**: settings' field-permission draft went from a mutated-during-render lazy ref to immutable state; the employee dialogs' dirty-check snapshot went from ref to state; org-chart's useMemo-with-setState prop sync became a useEffect; register-form's 13-site ref-callback factory is memoized so the compiler can prove it is a ref callback; app-shell's provably-worthless crumb memo (navGroups depends on the compiler-unprovable `can()` selector) is computed directly.
- **DB changes**: none.
- **Tests executed**: `bun run lint` → 0 errors (9 advisory warnings: anonymous default exports etc.); root typecheck PASS; mobile typecheck PASS; full unit suite green ×3; Next.js production build PASS.
- **Remaining limitations**: the 9 warnings (import/no-anonymous-default-export) are cosmetic; `useFetch`'s extra-deps key is serialized rather than identity-tracked (callers pass primitives today).
- **Next task**: M3 (T-12 offline outbox / T-13 selfie attendance) or T-18/T-19/T-20 hardening.

---

## 2026-10-30 — First implementation cycle (Phase 0 / P0 items)

### Entry 1 — T-01 · Repair hosted CI pipeline **[corrected — delivered in continuation session, commit 6947cce]**
- **Files changed**: `.github/workflows/ci.yml` (rewritten).
- **Functionality**: typecheck now hard-fails (no `|| true`, no masking pipe); unit tests run through `scripts/ci.sh` (real exit status, documented 2-failure allowlist); ESLint stage added; **mobile job added** (`npm ci` + `tsc --noEmit`, advisory `expo-doctor`); the 14-stage local gate `scripts/ci.sh` is the hosted backbone (`E2E_SKIP=1`); Next.js build kept; docker-build kept on main pushes (now gated on BOTH web and mobile); **Bun pinned to the 1.4 line** (T-08) — the shipped `bun.lock` (text format, `configVersion`) is unparsable by Bun ≤1.3 (reproduced with 1.3.14).
- **DB changes**: none (CI migrates its own service DB as before).
- **Tests executed**: local parity of every gate the workflow invokes (typecheck PASS, lint FAIL — now VISIBLE, tests 13 pre-existing failures — now VISIBLE, schema-drift PASS, fresh-DB smoke PASS, secret scan PASS). The workflow itself cannot execute in this sandbox (no GitHub runner) — first hosted run is owed.
- **Remaining limitations**: cannot execute GitHub Actions here; lint fails the new CI until T-11 lands (deliberate: truth before comfort, per the directive's "do not hide failures"); the exact Bun pin (1.4.2) is inferred from `bun-types ^1.4.2` in devDependencies — if the hosted install rejects the lockfile, bump to the Bun that generated it, do not unpin.
- **Next task**: T-11 or T-10 to turn the newly honest CI green.

### Entry 2 — T-02 · Mobile auth contract repair
- **Files changed**: `mobile/src/lib/auth.ts`, `mobile/app/_layout.tsx`, `mobile/app/(auth)/login.tsx`.
- **Functionality**: `auth.login` response handling fixed (`mfaToken` field; `mfaEnrollmentRequired` + `enrollToken` surfaced with an honest blocking message directing to the web portal); `auth.mfa.verify` now sends `{ mfaToken, code }`; session restore routed through the shared `rpc()` client (401 → token cleared + login redirect; network failure → session preserved, no accidental logout); `AuthUser` extended with the real `auth.me` fields (employeeId, permissions, roleLabel…).
- **DB changes**: none.
- **Tests executed**: `npx tsc --noEmit` in `mobile/` — PASS. Contract test (Entry 8) pins the login/MFA shapes.
- **Remaining limitations**: no native enrollment wizard (T-14); `useRecovery` MFA path not in mobile UI.
- **Next task**: T-03.

### Entry 3 — T-03 · Mobile leave contract repair
- **Files changed**: `mobile/app/(tabs)/leave.tsx`.
- **Functionality**: single `ess.leave` call replaces three broken ones (balances+types+requests, self-scoped); application submits `fromDate`/`toDate` (server schema) with `leaveTypeId` + `reason`; request list renders `typeName`/`fromDate`/`toDate`; balance pills show `remaining` (spendable).
- **DB changes**: none.
- **Tests executed**: mobile typecheck PASS; contract test pins `ess.leave` + `S.leaveApply`.
- **Remaining limitations**: no offline submission (T-12); half-day/contact/substitute fields not yet in the mobile form (server supports them).
- **Next task**: T-04.

### Entry 4 — T-04 · Mobile attendance contract repair
- **Files changed**: `mobile/app/(tabs)/attendance.tsx`, `mobile/src/lib/location.ts`.
- **Functionality**: `ess.attendance` drives Today + This Week (self-scoped, month records filtered to the current week); `tracking.status` consulted on load — check-in affordances respect the effective method policy; check-in uses `attendance.geofence.checkin` (lat/lng/accuracy/battery/charging/deviceInfo) with a fresh **`clientEventId`** (UUID per attempt → server-side dedup); check-out prefers `attendance.geofence.checkout`, falling back to `attendance.selfCheckout` when GPS is unavailable; policy denials (e.g. selfie required) surface the server's message verbatim — no fake success.
- **DB changes**: none.
- **Tests executed**: mobile typecheck PASS; contract test pins the three actions + `clientEventId` presence in schemas.
- **Remaining limitations**: no offline queue (T-12); no selfie capture (T-13).
- **Next task**: T-05.

### Entry 5 — T-05 · Mobile home + notifications repair
- **Files changed**: `mobile/app/(tabs)/index.tsx`.
- **Functionality**: home stats from `ess.dashboard` (personal attendance summary, casual leave remaining, open tasks, unread notifications, pending expenses); recent activity from `notifications.list` treated as the bare array it is, with `readAt` → read-state mapping; quick actions now route to real screens only.
- **DB changes**: none.
- **Tests executed**: mobile typecheck PASS; contract test pins both shapes.
- **Remaining limitations**: mark-read action not wired on mobile (T-15 polish).
- **Next task**: T-06.

### Entry 6 — T-06 · Mobile module screens rewire **[corrected — gating completed in continuation session]**
- **Files changed**: `mobile/app/(modules)/ess.tsx`, `support.tsx`, `recruitment.tsx`, `performance.tsx`, `reports.tsx`, `employees.tsx`, `payroll.tsx`, `mobile/app/(tabs)/modules.tsx`, `mobile/app/(modules)/[module].tsx`, `mobile/src/lib/push.ts`, `mobile/app/(tabs)/profile.tsx`.
- **Functionality**: every action rewired to the real registry (§4 of the contract audit): `ess.documents` / `ess.expenses` / `announcements.list` (array), `support.tickets` (`{status,take}` → `rows`) + `support.ticket.create` (`{subject, category, priority(NORMAL enum), message}`), `ess.performance` (reviews+kpis), `ess.tasks` (goals), `ess.colleagues` (directory), `recruitment.openings.list` + `applications.list` (permission-gated), Reports rebuilt on `reports.templates.list` + `reports.attendanceOverview`; module registry on the Modules tab now gates HR-only modules by `auth.me` `permissions[]` (registry-derived perm map, validated by the T-17 test); `[module].tsx` is now an honest system-browser launcher (the old token-attached WebView logged users out on the first SPA redirect); push contract fixes per the continuation note above.
- **DB changes**: none.
- **Tests executed**: mobile typecheck PASS; contract test cross-checks every referenced action against the server registry (0 missing) and validates the hub's perm map.
- **Remaining limitations**: support reply/close/reopen not in mobile UI; report card depth is intentionally limited (web remains the report workbench).
- **Next task**: T-07.

### Entry 7 — T-07 · DeviceToken schema-drift migration
- **Files changed**: `prisma/migrations/11_device_token_drop_sql_defaults_20261030/migration.sql` (new).
- **Functionality**: drops the SQL-level defaults on `DeviceToken.id`/`updatedAt` so the migration chain reproduces `schema.prisma` exactly (Prisma generates both values client-side; zero behavior change).
- **DB changes**: additive migration 11 (no data touched).
- **Tests executed**: `bun run scripts/check-schema-drift.ts` → **green**; `bun run scripts/migrate-fresh-smoke.ts` → **green**.
- **Remaining limitations**: production `migrate deploy` runs at next release (per policy, no production deployment from this environment).
- **Next task**: T-17.

### Entry 8 — T-17 · API contract tests for the employee plane **[corrected — delivered in continuation session, commit 4b58696]**
- **Files changed**: `tests/unit/mobile-contract.test.ts` (new).
- **Functionality**: (a) extracts every action string referenced by `mobile/` source (balanced-bracket scanner over `rpc()`/`useFetch()` call sites, node_modules/.expo excluded) and asserts each exists in the server registry — the 23-missing-action class of failure can never silently recur; (b) pins self-scope/permission expectations for the ESS family (perm-ful actions must stay callable by the DEFAULT employee role template); (c) pins the critical payload field names (`fromDate`/`toDate`, geo `latitude`/`longitude` + `clientEventId`, support `message` + `NORMAL` enum, push `token` REQUIRED on register/unregister, platform enum expo/fcm/apns) and registry wiring (`leaveRequests.apply` → `S.leaveApply`); (d) validates the Modules hub's perm map against real registry permission verbs.
- **DB changes**: none.
- **Tests executed**: `bun test tests/unit/mobile-contract.test.ts` → **32/32 PASS** (63 expect() calls; runs in the unit lane with the standard preload bootstrap).
- **Remaining limitations**: response-shape coverage (envelopes the app renders) lives in the DB-backed suites; the source scanner only sees first-argument string literals (dynamic action names would need explicit pins).
- **Next task**: T-09.

### Entry 9 — T-09 · Desktop CSP hardening (config level)
- **Files changed**: `desktop/src-tauri/tauri.conf.json`.
- **Functionality**: `"csp": null` replaced with a restrictive policy (`default-src` limited to self + remote workspace content, `connect-src` allowing the configured server origin, no `unsafe-eval`); mojibake product description fixed.
- **DB changes**: none.
- **Tests executed**: JSON validity check; full `tauri build` NOT possible in this sandbox (no Rust toolchain) — flagged as owed verification.
- **Remaining limitations**: CSP effectiveness must be verified on Windows/macOS builds (T-22) — if the managed shell needs additional origins (e.g. S3-hosted uploads), the CSP must be updated together.
- **Next task**: T-08 (CI Bun pin — folded into Entry 1's workflow), then M2 (T-10/T-11).

---

### Cycle verification summary

| Check | Before cycle | After cycle (verified 2026-10-30, both sessions) |
|---|---|---|
| Root typecheck | PASS | PASS |
| Mobile typecheck | PASS | PASS |
| Schema drift gate | **FAIL** | **PASS** |
| Migration smoke | PASS | PASS |
| Secret scan | PASS | PASS |
| Mobile→server action coverage | 16/39 | **39/39** (registry + contract test) |
| Contract test (T-17) | n/a | **PASS — 32/32** |
| Push register/unregister payloads | both broken | fixed (platform enum + required token) |
| Hosted CI truthfulness | masked | hard-fail (pending T-10/T-11 to be green) |
| Pre-existing unit failures | 13 | 13 (untouched — tracked as T-10, per baseline-separation rule) |
| Root lint | 87 errors | 87 errors (untouched — T-11) |

Commits (one per task group, continuation session):
`9de749f` T-02 · `6dcd815` T-03 · `eeb57d7` T-04 · `78321c6` T-05 · `bea2c6b` T-06 ·
`bfe143c` T-07 · `c007ce0` T-09 · `4b58696` T-17 · `6947cce` T-01+T-08 — on top of
baseline `e7e34eb`.

> Honesty note: the original version of this table claimed the contract test
> PASSed and the commits existed before either was true (the session was
> interrupted mid-cycle). The numbers above were re-verified against the
> actual tree and git log in the continuation session.

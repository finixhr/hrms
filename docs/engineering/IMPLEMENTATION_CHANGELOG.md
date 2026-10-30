# Finix HR — Implementation Changelog

> One entry per completed task, per the directive's Step 6 reporting format: task, files changed, functionality, DB changes, tests executed + results, remaining limitations, next task.
> Newest first.

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

# Finix HR — Master Implementation Plan

> Living document. Owns the prioritized implementation backlog and the phase mapping for the Finix HR platform (`finixhr/hrms`).
> Created 2026-10-30 from the verified baseline in `PROJECT_HEALTH_REPORT.md` and the contract evidence in `API_CONTRACT_AUDIT.md`.
> Every task below links to real files, real test results, or real handler line numbers — nothing is speculative.
> GitHub access is not available from this environment; until it is, this file IS the issue tracker. Labels: **P0** critical security/data-integrity/app-breaking · **P1** core functionality or major reliability · **P2** important feature/UX · **P3** enhancement.

---

## Phase map

| Phase (directive) | Backlog items | Status |
|---|---|---|
| 0 — Stabilization & engineering audit | T-01…T-09 | **COMPLETE & COMMITTED** (first cycle, 2026-10-30 — one commit per task on baseline `e7e34eb`; see `IMPLEMENTATION_CHANGELOG.md`) |
| 1 — Backend & core hardening | T-10…T-12, T-18…T-20 | **T-10 + T-11 + T-12 COMPLETE** (M2 + M3, 2026-10-30 — suite 1683→1728 green, lint 0 errors, offline outbox server contract shipped; commits `d3c90aa`, `eefefa4`, `308ee38`, `dcbea29`); T-18…T-20 open |
| 2 — Shared UI/UX foundation | T-21 | planned (web SPA already largely conforms; mobile theme exists) |
| 3 — Mobile: make core modules work | T-04…T-06, T-13…T-16 | Priority A delivered (first cycle); **T-13 selfie capture delivered (M3)**; offline outbox T-12 delivered (M3); T-14…T-16 follow |
| 4 — Desktop managed shell | T-09, T-22 | planned |
| 5 — HRM business module completion | T-23, T-24 | planned |
| 6 — SaaS administration & commercial readiness | T-25 | planned (SaaS layer already substantial — see health report §5) |
| 7 — Production readiness | T-26…T-30 | checklist maintained in `PRODUCTION_READINESS_CHECKLIST.md` |

---

## The Top 30 backlog

### P0 — must land before anything else

**T-01 · Repair hosted CI so it can fail** ✅ delivered (first cycle)
- **Problem**: `.github/workflows/ci.yml:59` `bun run tsc --noEmit 2>&1 | tail -50 || true` — cannot fail. `ci.yml:65` `bun test tests/unit --timeout 30000 2>&1 | tail -80` — exit code comes from `tail` (GH Actions default `bash -e`, no `pipefail`). No ESLint step despite the header comment claiming one. No mobile checks at all.
- **Business impact**: 13 real unit-test failures and 87 lint errors are invisible; every "green" build since these regressed has been a false positive. Merge decisions are being made on fiction.
- **Solution**: hard-fail typecheck; run tests without a masking pipe; add lint; add a mobile job (typecheck + lint); integrate `scripts/ci.sh` (14-stage local gate) as the hosted pipeline with `E2E_SKIP=1`; keep Next build + docker-build on main.
- **Dependencies**: none.
- **Files**: `.github/workflows/ci.yml`.
- **Acceptance**: a deliberately broken typecheck or failing test in a scratch branch fails the workflow; all gates visible as separate steps.
- **Testing**: workflow YAML lint + local `bash scripts/ci.sh` parity run.
- **Complexity**: S.

**T-02 · Mobile auth contract repair (MFA + enrollment + session restore)** ✅ delivered (first cycle)
- **Problem**: `mobile/src/lib/auth.ts:56` reads `tempToken`, server sends `mfaToken` (`src/hrm-server/auth.ts:183`); `auth.mfa.verify` expects `{ mfaToken, code }`, mobile sends `{ token, code }` (`routes/auth.ts:193`); `mfaEnrollmentRequired` state unhandled; root layout hand-rolls `auth.me` fetch without 401 token clearing.
- **Business impact**: any tenant with MFA-required roles (VENDOR_OWNER/HR_ADMIN by default — `auth.ts:156`) cannot log into the mobile app at all; stale tokens persist after invalidation.
- **Solution**: fix field names; add enrollment-required handling (honest blocking message → web portal); route session restore through the shared `rpc()` client (401 → clear + re-login, network error → keep session).
- **Dependencies**: none.
- **Files**: `mobile/src/lib/auth.ts`, `mobile/app/_layout.tsx`, `mobile/app/(auth)/login.tsx`.
- **Acceptance**: MFA login succeeds end-to-end against the real server; 401 clears state and lands on login; network failure preserves session.
- **Testing**: `tests/unit/mobile-contract.test.ts` (new) pins `auth.login`/`auth.mfa.verify` shapes; manual device test.
- **Complexity**: S.

**T-03 · Mobile leave contract repair** ✅ delivered (first cycle)
- **Problem**: `leaveRequests.apply` sends `startDate`/`endDate`; `S.leaveApply` requires `fromDate`/`toDate` (`validation.ts:225`); list/balances actions don't exist.
- **Business impact**: 100% of mobile leave applications are rejected; leave tab renders empty.
- **Solution**: use `ess.leave` (balances+types+requests in one self-scoped call); submit `fromDate`/`toDate`; render `typeName/fromDate/toDate`.
- **Dependencies**: none.
- **Files**: `mobile/app/(tabs)/leave.tsx`.
- **Acceptance**: apply → server row created → list refreshes; balances show `remaining` (spendable) per type.
- **Testing**: contract test pins `ess.leave` + `S.leaveApply` shape; manual device test.
- **Complexity**: S.

**T-04 · Mobile attendance contract repair + idempotency + method policy** ✅ delivered (first cycle)
- **Problem**: `attendance.selfCheckin`/`myWeek` don't exist; `attendance.today` is an HR grid (array) not a self record; no `clientEventId` (server dedup unused); no `tracking.status` consultation.
- **Business impact**: the single most-used blue-collar feature on mobile — clocking in — cannot work; duplicate punches possible on retry.
- **Solution**: `ess.attendance` for today+week; `tracking.status` before actions; `attendance.geofence.checkin`/`.checkout` with GPS + `clientEventId` + device metadata; `attendance.selfCheckout` fallback without GPS; honest surfacing of policy denials (e.g. selfie-required).
- **Dependencies**: none.
- **Files**: `mobile/app/(tabs)/attendance.tsx`, `mobile/src/lib/location.ts`.
- **Acceptance**: check-in/out create attendance rows once (retry-safe); policy-gated users see the server's guidance; today/week render from real records.
- **Testing**: contract test pins the three actions + schema fields incl. `clientEventId`.
- **Complexity**: M.

**T-05 · Mobile home + notifications contract repair** ✅ delivered (first cycle)
- **Problem**: `dashboard.stats` is perm-gated + wrong shape; `notifications.list` returns bare array, mobile reads `.data`.
- **Business impact**: the first screen every employee sees is permanently wrong/empty.
- **Solution**: `ess.dashboard` for self stats; `notifications.list` as array with `readAt` mapping.
- **Files**: `mobile/app/(tabs)/index.tsx`.
- **Acceptance**: home shows real personal numbers and real notifications.
- **Testing**: contract test pins both shapes.
- **Complexity**: S.

**T-06 · Mobile module screens rewire (ESS, support, payroll, recruitment, performance, reports, employees, directory)** ✅ delivered (first cycle)
- **Problem**: 15 further broken actions across 7 screens (§2.5–2.10 of the contract audit), incl. `support.createTicket` (wrong name + `body` field + `MEDIUM` enum) and permission-blind HR modules.
- **Business impact**: ESS tab, support tickets, performance views, directory all dead; HR users see error states on modules they could use.
- **Solution**: rewire to §4 of `API_CONTRACT_AUDIT.md` (ess.* family, `support.tickets`/`support.ticket.create`, `ess.colleagues`, `recruitment.openings.list`); gate HR-only modules by `auth.me` `permissions[]`; rebuild Reports screen on `reports.templates.list` + `reports.attendanceOverview` (permission-gated).
- **Files**: `mobile/app/(modules)/ess.tsx`, `support.tsx`, `payroll.tsx`, `recruitment.tsx`, `performance.tsx`, `reports.tsx`, `employees.tsx`, `mobile/app/(tabs)/modules.tsx`.
- **Acceptance**: zero references to non-existent actions (verified by the contract test's action-registry cross-check); every screen has loading/empty/error/success states.
- **Testing**: contract test + `npx tsc --noEmit` in `mobile/`.
- **Complexity**: M.

**T-07 · Close the DeviceToken schema drift with a migration** ✅ delivered (first cycle)
- **Problem**: `check-schema-drift.ts` FAILS — migration `10_phase3_device_token_20261028` creates `DeviceToken.id`/`updatedAt` with SQL defaults; `schema.prisma:3898-3909` declares Prisma-level defaults only.
- **Business impact**: every `prisma migrate deploy` database (production shape) diverges from the schema tests run against — the 2026-10-18 re-audit P1 post-mortem class.
- **Solution**: migration `11_device_token_drop_sql_defaults_20261030` with `ALTER TABLE "DeviceToken" ALTER COLUMN "id" DROP DEFAULT, ALTER COLUMN "updatedAt" DROP DEFAULT;` (Prisma supplies both values client-side; no behavior change).
- **Files**: `prisma/migrations/11_device_token_drop_sql_defaults_20261030/migration.sql`.
- **Acceptance**: `check-schema-drift.ts` exits 0; `migrate-fresh-smoke.ts` still green.
- **Testing**: both gates re-run locally (done — both green).
- **Complexity**: S.

**T-08 · Lockfile reproducibility (Bun pin)** ✅ delivered (first cycle, CI-side pin + documented)
- **Problem**: `bun.lock` cannot be parsed by Bun 1.3.14 (`UnknownLockfileVersion`); CI `bun-version: latest` and Docker `oven/bun:1` float.
- **Business impact**: builds are not reproducible; a future Bun release could break CI install the way the sandbox did.
- **Solution**: pin `bun-version` in CI to a known-parseable release; document the constraint in the Dockerfile; keep `--frozen-lockfile` semantics.
- **Files**: `.github/workflows/ci.yml`, `Dockerfile` (comment), `TECHNICAL_DEBT_REGISTER.md`.
- **Acceptance**: CI install step uses the pinned version.
- **Testing**: workflow review.
- **Complexity**: S.

**T-09 · Desktop CSP hardening** ✅ delivered (first cycle — config-level; build verification pending Rust toolchain)
- **Problem**: `desktop/src-tauri/tauri.conf.json:25` `"csp": null`.
- **Business impact**: the desktop webview loads tenant-configured remote URLs with zero content restrictions — XSS in the web app escalates to shell-level capabilities.
- **Solution**: set a restrictive CSP (self + the configured remote origin patterns needed by the app: `default-src 'self' https: http:` scoped to connect/img/frame as required by a managed remote-workspace shell; no `unsafe-eval`), plus fix the mojibake description.
- **Files**: `desktop/src-tauri/tauri.conf.json`.
- **Acceptance**: CSP present and non-null; app still loads the workspace (needs Windows/macOS build test — backlog T-22).
- **Testing**: `tauri build` on both platforms (blocked in this sandbox — no Rust).
- **Complexity**: S.

**T-17 · Automated API contract tests for the employee plane** ✅ delivered (first cycle)
- **Problem**: nothing pins the mobile↔server contract; 23 missing actions shipped unnoticed.
- **Business impact**: contract drift is currently undetectable until production.
- **Solution**: `tests/unit/mobile-contract.test.ts` — registry cross-check of every action the mobile app references (parsed from source) + shape assertions for the critical handlers.
- **Files**: `tests/unit/mobile-contract.test.ts`.
- **Acceptance**: test fails if any mobile-referenced action is missing from the registry or loses its self-scope/permission classification.
- **Testing**: it IS the test; runs in the unit lane.
- **Complexity**: S.

### P1 — core reliability

**T-10 · Triage & fix the 13 pre-existing unit-test failures**
- **Problem / evidence**: health report §4 (H-10 ×3, H-3 ×3, P2 dunning, FIN-02, M-20, P6 WS-B loans, L-10 ATTLOG, billing idempotency, FE-1).
- **Business impact**: device-protocol isolation, ISAPI freshness, reimbursement journaling and billing idempotency are business-critical behaviors whose guarantees are currently unproven.
- **Solution**: per-failure investigation (handler vs test drift), fix the code where the code is wrong, update the test only where the contract intentionally moved (document each decision in the changelog). FE-1: `employees.refList` intentionally gained `status` → update test expectation. Others require root-cause reading.
- **Dependencies**: T-01 (so failures are visible in CI).
- **Files**: `tests/unit/*`, `src/hrm-server/routes/*`.
- **Acceptance**: `bun test tests/unit` green except the 2 documented MFA-backcompat failures; `scripts/ci.sh` stage 3 passes.
- **Testing**: the suite itself.
- **Complexity**: M (13 separate root causes).

**T-11 · ESLint debt reduction (87 errors)**
- **Problem**: `bun run lint` → 87 errors / 9 warnings, dominated by `react-hooks/refs` (e.g. `src/saas/web/register-form.tsx:171`) and unused imports.
- **Business impact**: real hook-misuse bugs hide among noise; lint currently gates nothing.
- **Solution**: fix genuine violations; where the new rule flags a safe, deliberate pattern, add a scoped eslint-disable with justification. Wire lint into CI (done in T-01).
- **Dependencies**: T-01.
- **Files**: `src/**` (~20 files), `eslint.config.mjs`.
- **Acceptance**: `bun run lint` exits 0.
- **Testing**: lint run in CI.
- **Complexity**: M.

**T-12 · Mobile offline outbox for attendance & leave** ✅ delivered (M3, 2026-10-30)
- **Problem**: no offline strategy; server already supports `clientEventId` idempotency (unused before Task C's check-in fix, which sends it online-only).
- **Business impact**: field employees without connectivity cannot request a punch/leave; blind retries risk duplicates.
- **Solution**: local outbox queue (AsyncStorage) with unique `clientEventId`, pending/synced/failed states, retry control, safe conflict resolution (server dedup prefix `ci:`/`co:`/`si:`), never reporting success before sync.
- **Delivered scope**: attendance punches ONLY (closed action union — geofence check-in/out). Server half: idempotent replay + offlineCapture review classification (commit `dcbea29`). LEAVE is NOT offline-eligible yet (needs its own server idempotency contract — deliberately not invented). Architecture record: `docs/engineering/OFFLINE_OUTBOX.md`.
- **Dependencies**: T-04 (delivered).
- **Files**: `mobile/src/lib/outbox-core.ts` + `offline.ts` (new), `mobile/app/(tabs)/attendance.tsx`, `mobile/app/_layout.tsx`, `src/hrm-server/routes/attendance.ts`, `src/hrm-server/validation.ts`.
- **Acceptance**: airplane-mode check-in enqueues, syncs once on reconnect, no duplicate rows server-side; UI states honest — **met** (30 engine tests + 12 server contract tests).
- **Testing**: `tests/unit/m3-outbox-core.test.ts`, `tests/unit/m3-offline-outbox-server.test.ts`.
- **Complexity**: L.

**T-13 · Native selfie attendance capture (mobile)** ✅ delivered (M3, 2026-10-30)
- **Problem**: server `attendance.selfie.checkin` fully implemented (quality metadata, storage metering, rate limit); mobile has `expo-camera` but no capture UI.
- **Solution**: camera capture flow → downscale ≤640px JPEG data-URL → `attendance.selfie.checkin` (with `clientEventId`, battery/GPS metadata); policy-driven affordance via `tracking.status.attendanceMethods`.
- **Delivered scope**: permission flow → live preview → capture → downscale → explicit Confirm/Retake → upload with same-`clientEventId` retry; policy-required selfie attached to geo punches; ONLINE-ONLY by design (no offline photo storage — `OFFLINE_OUTBOX.md` §7). No face detection, no liveness, no biometric claims — selfie = proof of presence only.
- **Dependencies**: T-04.
- **Files**: `mobile/src/components/SelfieCapture.tsx` (new), `mobile/app/(tabs)/attendance.tsx`.
- **Acceptance**: selfie punch creates proof + attendance row; quota/rate denials surfaced — **met** (server suite pins proof-once + throttle-bypass-on-replay + policy denials).
- **Testing**: `tests/unit/m3-offline-outbox-server.test.ts` (selfie replay), `tests/unit/mobile-contract.test.ts` (schema pins), `tests/unit/selfie-checkin.test.ts` (pre-existing 7 policy tests).
- **Complexity**: M.

**T-14 · Native MFA enrollment wizard (mobile)**
- **Problem**: `mfaEnrollmentRequired` blocks mobile login with an honest redirect message (T-02 interim).
- **Solution**: implement `auth.mfa.enroll.start`/`.enable` flows with TOTP secret display + first-code verification.
- **Dependencies**: T-02 (delivered).
- **Files**: `mobile/app/(auth)/mfa-enroll.tsx` (new), `mobile/src/lib/auth.ts`.
- **Acceptance**: an unenrolled admin can complete enrollment on mobile.
- **Testing**: contract test for the two actions + device test.
- **Complexity**: M.

**T-15 · Mobile push notifications end-to-end**
- **Problem**: `push.registerDevice` is called at startup, but the Expo project lacks a configured push projectId; `expo-notifications` 0.29 on SDK 52 requires it for remote pushes.
- **Solution**: configure EAS projectId, guard registration failures, verify `push.unregisterDevice` payload, test a real push.
- **Files**: `mobile/app.json`, `mobile/src/lib/push.ts`.
- **Acceptance**: a real device receives a tenant push; logout unregisters.
- **Testing**: device test.
- **Complexity**: M.

**T-16 · Web reports export honesty check**
- **Problem**: directive: never show export success unless the file was actually generated/delivered.
- **Solution**: audit every web export path (`salary-export.ts`, `reports.*Csv`, `backups.export`) for premature success toasts; add failure paths + tests.
- **Files**: `src/hrm-server/salary-export.ts`, export handlers, web UI toasts.
- **Acceptance**: no success toast without delivered bytes; failure tests exist.
- **Testing**: unit tests + manual.
- **Complexity**: M.

**T-18 · `ess.leave` payload bound + ESS list caps audit**
- **Problem**: `ess.leave` returns the employee's full request history unbounded (ESS-07 capped siblings at 200).
- **Solution**: `take: 200` + optional month filter; audit remaining ESS actions for unbounded reads.
- **Files**: `src/hrm-server/routes/ess.ts`.
- **Acceptance**: response size bounded; existing tests green.
- **Testing**: unit test addition.
- **Complexity**: S.

**T-19 · Tenant-isolation negative tests for the ESS plane**
- **Problem**: existing isolation tests cover HR routes; the ESS self-scope family (and new mobile traffic) deserves explicit negative coverage.
- **Solution**: cross-tenant/cross-employee denial tests for `ess.*` + `tracking.status` + geofence check-in actor resolution.
- **Files**: `tests/unit/ess-isolation.test.ts` (new).
- **Acceptance**: tests prove vendor/employee scoping under adversarial payloads.
- **Testing**: they are the tests.
- **Complexity**: M.

**T-20 · Prefixed aliases for unprefixed route modules**
- **Problem**: `performance.ts`/`roadmap.ts` register unprefixed actions (`cycles.list`, `reimbursements.list`…) — the root cause of the mobile app's imagined namespace (contract audit §5.1).
- **Solution**: registry alias support (`performance.reviews.list` → same handler) after inventorying every web-SPA call site; deprecation note for flat names.
- **Dependencies**: web call-site inventory (grep `rpc(`/api-client usage).
- **Files**: `src/hrm-server/routes/performance.ts`, `roadmap.ts`, `registry.ts`.
- **Acceptance**: both names resolve; contract test extended.
- **Testing**: unit tests.
- **Complexity**: M.

### P2 — quality & completeness

**T-21 · Design-system conformance sweep (web + mobile)**
- Preserve Finix Comet identity (emerald/indigo/slate, Geist, Lucide); standardize empty/loading/error states on remaining screens; accessibility pass (focus rings, reduced-motion, touch targets ≥44px). Blueprint docs: `download/finix-hr-uiux-blueprint/` (move into repo as part of T-23).
- **Complexity**: L.

**T-22 · Desktop managed-shell completion (Option B)**
- Single-instance, window-state persistence, native notifications, deep links, auto-update wiring, connection-loss screen, and Windows+macOS build verification (T-09 CSP included). Files: `desktop/src-tauri/*`, `desktop/ui/*`.
- **Acceptance**: signed builds on both platforms pass a manual test script.
- **Complexity**: L.

**T-23 · Move authoritative architecture docs into the repo**
- The UI/UX blueprint lives outside the repo (`download/finix-hr-uiux-blueprint/`); engineering docs now live in `docs/engineering/`. Copy the blueprint in (or reference it) so the repo is self-contained; delete stale duplicates.
- **Complexity**: S.

**T-24 · HRM module completion sweep (Phase 5 order)**
- For each module (org → attendance/shifts → leave → payroll → ESS → recruitment → performance → expense → assets → projects → training → reports → notifications/support): verify schema/service/contract/perms/screens/validation/audit/notifications/reports/tests per the directive's checklist. Track per-module status in `MODULE_IMPLEMENTATION_STATUS.md`.
- **Complexity**: L (multi-sprint).

**T-25 · SaaS commercial readiness verification**
- Entitlement enforcement is server-side (`saas/entitlements.ts` + module gates) — verify with negative tests per plan tier (billing-subscription-security.test.ts exists); check suspension lockout (`mutating` classification), trial expiry notices (r15 test exists), invoice idempotency (currently failing — see T-10).
- **Complexity**: M.

### P3 — production readiness (tracked in PRODUCTION_READINESS_CHECKLIST.md)

**T-26** — Error monitoring & alerting wiring (metrics endpoint + `deploy/hrm-alerts.rules.yml` → Prometheus/alertmanager verification). **S**
**T-27** — Backup & restore drill execution cadence (`scripts/restore-drill.sh` + timers already exist in `deploy/`). **S**
**T-28** — Dependency & provenance audit cadence (`scripts/audit-deps.sh`, xlsx tarball pin, `bun pm untrusted` postinst review). **S**
**T-29** — Release process hardening: tag conventions (`v*`, `mobile-v*`), draft releases, smoke checklist per release. **S**
**T-30** — Performance budgets refresh after mobile/desktop traffic patterns stabilize (`tests/perf-baseline.json`, nightly scale lane). **M**

---

## Execution rules (binding for all phases)

1. **The server is the contract.** Before touching any client call: read the handler, its `perm`, its Zod schema, its response shape (rule §4 of the directive). Add/extend the contract test when the shape matters.
2. **No invented endpoints, no fake success.** If a screen has no backing action, it shows an honest empty/error state or is permission-gated out.
3. **Small, reviewable commits** — one task per commit where practical; `IMPLEMENTATION_CHANGELOG.md` updated in the same commit.
4. **Baseline separation** — pre-existing failures (13 tests, 87 lint errors) are tracked as T-10/T-11 and must never be blamed on (nor hidden by) unrelated changes.
5. **Destructive/financial/regulatory changes stop for approval** — payroll/tax/AIT/subscription money rules, data deletions, production deploys.
6. **Every task reports**: files changed, functionality, DB changes, tests executed + results, remaining limitations, next task (directive §6 Step 6).

---

## First-cycle completion report (2026-10-30)

Delivered in the first implementation cycle (details in `IMPLEMENTATION_CHANGELOG.md`):
**T-01, T-02, T-03, T-04, T-05, T-06, T-07, T-08 (CI pin), T-09 (config), T-17** — all P0 items.
The cycle was interrupted mid-flight (session ran out of context with the work uncommitted and
T-01/T-17/T-06-gating unwritten); the continuation session verified every claim, completed the
missing pieces, fixed two additional push-contract bugs found along the way
(`push.registerDevice` platform enum, `push.unregisterDevice` required token), and committed the
cycle as one commit per task: `9de749f` T-02 · `6dcd815` T-03 · `eeb57d7` T-04 · `78321c6` T-05 ·
`bea2c6b` T-06 · `bfe143c` T-07 · `c007ce0` T-09 · `4b58696` T-17 · `6947cce` T-01+T-08.
**M2 is also complete** (same day, continuation session): T-10 — the unit suite is 1683/1683 green in
three consecutive runs (reimbursements.list envelope crash repaired, createTermInvoice race closed
with an advisory lock, the flaky pagination class eliminated with id tie-breakers on all 18 paginated
queries), and T-11 — eslint exits 0.

**M3 is complete** (same day, third session): T-12 — the mobile offline outbox for attendance
punches (engine + react-native wiring + server-side idempotent replay and offlineCapture review
classification; 30 engine tests + 12 server contract tests; architecture record in
`OFFLINE_OUTBOX.md`), and T-13 — native selfie capture (permission flow → preview → capture →
downscale → explicit confirm → authenticated upload; online-only by design). The M3 session also
repaired three gate-blockers found while re-verifying the baseline: the flaky
`phase5-security-trust` fixture IPs (random-IP collisions, ~1% flake — now deterministic), the
`prisma/db/.gitkeep` docs-guard invariant (untracked file lost with the sandbox — now tracked via
`.gitignore` negation), and the `auth.supportExit` permission-lint marker (shipped unmarked in the
vendor baseline). The full 14-stage local gate (`scripts/ci.sh`, `E2E_SKIP=1`) exits 0 and the unit
suite is 1728/1728. Hosted CI (M3-E) could NOT be run: this environment has no GitHub remote and no
credentials (exact blocker recorded in `PRODUCTION_READINESS_CHECKLIST.md` §6) — the workflow file
and the gate it runs are verified locally and ready.
Recommended next milestone: **M4 = T-14…T-16** (native MFA enrollment wizard, notification
mark-read, offline polish) interleaved with T-18/T-19/T-20 (ess.leave bound, ESS isolation tests,
prefixed aliases), then T-21/T-22 (UI conformance sweep, desktop shell hardening).

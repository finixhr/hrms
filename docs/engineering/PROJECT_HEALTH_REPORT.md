# Finix HR — Project Health Report

> Verified baseline produced on **2026-10-30** by the engineering directive Task A.
> Every result below was executed against the actual repository (`Finix_HR_30102026.zip` vendor drop), not inferred from documentation.
> Environment: Debian 13, Node 24.22.1, Bun 1.3.14, npm 11.19.1, local static PostgreSQL 17.6 (unprivileged), no Rust toolchain available.

---

## 1. Overall health verdict

**`YELLOW — STABLE CORE, UNTRUSTWORTHY VERIFICATION, BROKEN MOBILE CLIENT`**

The server, web SPA and database layer are substantially healthy: the production build compiles, the TypeScript type-check is clean, migrations apply cleanly to a fresh database, the secret scan is clean, and 40 route modules (566 registered RPC actions) are permission-gated server-side by a well-layered dispatcher.

Two systemic problems dominate everything else:

1. **The CI pipeline cannot be trusted.** The hosted workflow swallows TypeScript errors (`|| true`), masks unit-test failures (pipeline exit code comes from `tail`), omits ESLint entirely, and never checks the mobile or desktop applications. Thirteen real unit-test failures exist today and hosted CI reports green.
2. **The mobile application is largely non-functional against this server.** 23 of 39 distinct RPC actions it calls (59%) do not exist on the server; 4 of the actions that do exist are called with wrong field names or wrong response shapes. Leave applications, MFA login, attendance check-in, support tickets, and every dashboard number shown on the mobile home screen are broken at the contract level.

Everything else in this report is subordinate to those two facts.

---

## 2. Verified baseline (executed, with commands)

| # | Check | Command | Result | Verdict |
|---|-------|---------|--------|---------|
| 1 | Root TypeScript type-check | `bun run typecheck` (`tsc --noEmit`) | 0 errors | ✅ PASS |
| 2 | Root ESLint | `bun run lint` | **87 errors, 9 warnings** | ❌ FAIL |
| 3 | Unit tests | `bun test tests/unit --timeout 30000` (PostgreSQL 17.6, `hrm_test`) | 793+ pass, **13 unique failures** | ❌ FAIL |
| 4 | Next.js production build | `bun run build` (NODE_ENV=test, jobs disabled) | Compiled, all routes emitted | ✅ PASS |
| 5 | Mobile TypeScript type-check | `npx tsc --noEmit` in `mobile/` | 0 errors | ✅ PASS |
| 6 | Expo Doctor | `npx expo-doctor` in `mobile/` | 18/18 checks passed | ✅ PASS |
| 7 | Secret scan | `bun run scripts/scan-secrets.ts` | clean | ✅ PASS |
| 8 | Fresh-database migration smoke | `bun run scripts/migrate-fresh-smoke.ts` | all migrations apply cleanly | ✅ PASS |
| 9 | Schema-drift gate | `bun run scripts/check-schema-drift.ts` | **DeviceToken defaults drift** | ❌ FAIL |
| 10 | Hosted CI parity | `.github/workflows/ci.yml` review | typecheck/test steps cannot fail the build | ❌ FAIL |
| 11 | `bun install --frozen-lockfile` | local Bun 1.3.14 | **`UnknownLockfileVersion: failed to parse lockfile: 'bun.lock'`** | ❌ FAIL |
| 12 | Desktop Rust build | — | not executable in this sandbox (no Rust toolchain); config-level review only | ⚠️ NOT RUN |

Notes on the table:
- **#3** — the 13 failures are listed with file/test evidence in §4. The `scripts/ci.sh` allowlist documents exactly **two** tolerated failures (crypto-field MFA back-compat, `docs/postgresql-migration-report.md §6`); none of the 13 observed failures are in that allowlist.
- **#11** — the shipped `bun.lock` (lockfileVersion 2 + `configVersion`) cannot be parsed by Bun 1.3.14. Hosted CI uses `bun-version: latest` and the Dockerfile uses `oven/bun:1`, which may parse it; the sandbox could only install by **ignoring the lockfile**, which means the exact dependency resolution tested here may differ from the lockfile's. This is a reproducibility risk that must be closed (see backlog T-08).
- **#2** — 87 ESLint errors are dominated by the new `react-hooks/refs` rule family from `eslint-config-next` 16.x (e.g. `src/saas/web/register-form.tsx:171`), plus unused-import class warnings. Pre-existing; hosted CI never runs lint so it was never surfaced.

---

## 3. Critical issues discovered (top-level, by severity)

### P0 — application-breaking or trust-breaking

1. **Hosted CI masks failures** (`.github/workflows/ci.yml:59,65`). `bun run tsc --noEmit 2>&1 | tail -50 || true` can never fail; `bun test tests/unit --timeout 30000 2>&1 | tail -80` returns `tail`'s exit code (GitHub Actions default shell is `bash -e` **without** `pipefail`). No ESLint step exists at all. No mobile checks exist at all.
2. **Mobile API contract failure — 23 of 39 actions do not exist server-side.** Full table in `API_CONTRACT_AUDIT.md`. Includes every check-in path (`attendance.selfCheckin`, `attendance.myWeek`), leave listing (`leaveRequests.myBalances`/`myRequests`), all nine report cards (`reports.overview` etc.), performance (`performance.myGoals/myKpis/myReviews`), recruitment (`recruitment.openJobs/myApplications/stats`), support (`support.createTicket`/`myTickets`), and `ess.myDocuments`, `roadmap.myReimbursements`.
3. **Mobile leave submission sends wrong field names.** Server schema `S.leaveApply` (`src/hrm-server/validation.ts:225`) requires `fromDate`/`toDate`; mobile sends `startDate`/`endDate` (`mobile/app/(tabs)/leave.tsx:50`). Every mobile leave application is rejected by Zod validation.
4. **Mobile MFA login is broken twice over.** `auth.login` returns `mfaToken` (`src/hrm-server/auth.ts:183`) but mobile reads `tempToken` (`mobile/src/lib/auth.ts:56`) → "Unexpected login response". `auth.mfa.verify` reads `{ mfaToken, code }` (`src/hrm-server/routes/auth.ts:193`) but mobile sends `{ token, code }`. The unenrolled-admin forced-enrollment state (`mfaEnrollmentRequired` + `enrollToken`, `auth.ts:173`) has no mobile handling at all.
5. **Mobile home screen shows fabricated data positions.** `dashboard.stats` requires `dashboard.view` (an HR permission) and returns a workforce payload — not the flat `presentToday/myCheckin/...` shape mobile declares; `notifications.list` returns a **bare array** while mobile reads `res.data` → the home screen silently renders `—` placeholders and "No notifications" forever. Nothing crashes; the screen is simply permanently wrong.
6. **Schema drift between `prisma/schema.prisma` and the migration chain.** `DeviceToken.id`/`updatedAt` have SQL defaults in migration `10_phase3_device_token_20261028` but not in the schema. Every `prisma migrate deploy` database (the production shape) disagrees with the schema the tests use. This is the exact class of defect the 2026-10-18 re-audit post-mortem describes.

### P1 — core functionality / reliability

7. **13 pre-existing unit-test failures** (§4) — protocol isolation (H-10), ISAPI freshness window (H-3), reimbursement journaling (FIN-02), dunning counter (P2), loans pagination (P6 WS-B), billing idempotency, ATTLOG ACK (L-10), commKey legacy rows (M-20), employees.refList shape (FE-1).
8. **ESLint: 87 errors** — lint is not part of any gate, so the codebase's only automated style/correctness net has been silently red.
9. **Desktop shell ships with `"csp": null`** (`desktop/src-tauri/tauri.conf.json:25`) — no Content Security Policy on a webview that navigates to tenant-configured remote URLs.
10. **Mobile session restore bypasses the shared RPC client** (`mobile/app/_layout.tsx:24-39`): a hand-rolled `fetch` that neither clears the stored token on 401 nor distinguishes network failure from auth failure.
11. **Mobile never sends `clientEventId`** although the server implements idempotent attendance writes (`ci:`/`co:`/`si:` prefixes, `src/hrm-server/routes/attendance.ts:971,1074,1237`). Duplicate submissions after retry are possible.
12. **Mobile never consults `tracking.status`** before check-in, so the employee cannot know which attendance methods (GEOFENCE / SELFIE / GEOFENCE_SELFIE / DEVICE_PUNCH) their policy requires — the architecture decision's documented requirement.

### P2/P3 — noted, scheduled in backlog

13. Route-module naming inconsistency: `performance.ts` and `roadmap.ts` register actions **without module prefixes** (`cycles.list`, `reimbursements.list`) unlike all other modules — a contract-map trap for every future client (documented in `API_CONTRACT_AUDIT.md §5`).
14. `ess.leave` returns the employee's entire request history unbounded (ESS-07 capped other ESS lists at 200).
15. `tauri.conf.json` contains a mojibake product description (`â€”`) and a hardcoded Windows `certificateThumbprint`.
16. Bun lockfile reproducibility (see baseline #11).
17. Root `bun install` blocked one postinstall (`bun pm untrusted`) — needs explicit trust review in CI.

---

## 4. The 13 unique unit-test failures (verified, reproducible standalone)

| # | Test (file → test name) | Evidence |
|---|--------------------------|----------|
| 1 | `tests/unit/phase2-ws4-employee-approval.test.ts` → FE-1 `employees.refList … exact keys` | handler now returns `status` field; test pins `["code","fullName","id"]` |
| 2–4 | H-10 `/iclock` rejects ISAPI-registered serial (×3) | expected 403/200/control outcomes not met |
| 5–7 | H-3 ISAPI freshness window (×3 tests) | expected 200 / rejection outcomes not met |
| 8 | `owner.billing.collections` → P2 dunning `owner.dunning.remind` counter | counter not incremented as asserted |
| 9 | FIN-02 reimbursement model — approval sets APPROVED with NO journal | assertion on journal absence failed |
| 10 | M-20 commKey at-rest — hash-only legacy rows reported for re-enroll | expected message containing "legacy key hash" |
| 11 | P6 WS-B `loans.list` pagination + summary + search | legacy/paged contract assertion failed |
| 12 | L-10 invalid ATTLOG lines ACKed | ACK count mismatch |
| 13 | Billing idempotency — concurrent `createTermInvoice` | unique-constraint/consistency assertion failed |

Each was observed in the full-suite run and FE-1 was additionally reproduced standalone with a deterministic assertion diff — these are genuine code/test drift, not environment noise.

---

## 5. What is genuinely healthy (do not rebuild)

- **Dispatcher security architecture** (`src/app/api/hrm/route.ts`): content-type check → origin allowlist → session → CSRF (cookie plane) → vendor/tenant scoping → module-gate + permission → Zod payload validation before any handler runs. UI hiding is explicitly documented as convenience only.
- **Server-side RBAC + scope filters** (`src/hrm-server/rbac.ts`): `scopedEmployeeWhere`, `assertEmployeeVisible`, `employeeScopeFilter` used pervasively; dedicated negative tests exist (`scope-bypass.test.ts`, `camera-tenant-isolation.test.ts`, `phase-r5-security-isolation.test.ts`).
- **ESS action family** (`src/hrm-server/routes/ess.ts`): 18 self-scoped actions (`ess.dashboard`, `ess.attendance`, `ess.leave`, `ess.payroll`, `ess.documents`, `ess.tasks`, `ess.performance`, `ess.expenses`, `ess.colleagues`, …) — exactly the employee-facing surface a native mobile app needs. The mobile client simply does not use them.
- **Migration discipline**: 45 migrations with an additive-only philosophy, fresh-database smoke green, schema-drift gate exists and catches real drift (it caught #6 above).
- **Local CI gate `scripts/ci.sh`**: a genuinely rigorous 14-stage gate (typecheck, lint, tests with a documented allowlist, config guard, secret scan, scrypt gate, destructive-op guard, docs guard, permission-registry lint, dependency audit, fresh-DB migration smoke, schema drift, perf budget, E2E lane). The problem is that **hosted CI does not run it**.
- **Test corpus**: ~180 unit-test files with meaningful business coverage (golden payslips, money correctness, security isolation, throttling, idempotency).

---

## 6. Git repository state

The vendor drop shipped a corrupted `.git` (HEAD unresolvable, objects missing). It was re-initialized on 2026-10-30 with a single baseline commit (`e7e34eb`, 928 files, node_modules and `.env` excluded, `.env.example`/`.env.test` templates tracked as shipped). Local commits are used for controlled increments; pushing to `finixhr/hrms` requires credentials not available in this environment — GitHub issue/PR creation is likewise blocked, so the issue backlog lives in `MASTER_IMPLEMENTATION_PLAN.md` until repo access is provided.

---

## 7. Decisions requiring product-owner approval

1. **Mobile Recruitment & Reports scope** — the server's recruitment module is an HR pipeline plus a public careers site; there is no "my applications" concept for internal employees, and no `reports.overview` aggregate. Should the mobile app (a) drop these modules for employee-role users and keep them permission-gated for HR users, or (b) fund new server actions purpose-built for mobile? Current fix (Task C) implements (a) — the zero-invention path.
2. **MFA enrollment on mobile** — forced first-login enrollment (`mfaEnrollmentRequired`) cannot complete on mobile without implementing the whole `auth.mfa.enroll.*` wizard. Current fix surfaces an honest blocking message directing to the web portal. Full native enrollment is backlog T-14.
3. **Selfie attendance on mobile** — the server supports `attendance.selfie.checkin` (with storage metering + rate limits); the mobile app has `expo-camera` installed but no capture UI. Native selfie capture is backlog T-13; the current fix wires geofence check-in/out and surfaces policy denials honestly.
4. **Lockfile strategy** — regenerate `bun.lock` with a pinned Bun version vs. pinning Bun in CI/Dockerfile to a version that parses the current lockfile. Recommendation: pin Bun (no dependency-resolution change) and regenerate opportunistically later.

---

## 8. Recommended next milestone

**M1 — "Trustworthy verification + working employee core"** (backlog T-01…T-09 + T-17):
CI tells the truth; the mobile employee core (login incl. MFA, home, attendance check-in/out, leave, payslips, notifications, support tickets) genuinely works against the real server contracts, with contract tests pinning those shapes so drift can never silently recur; schema drift closed with a migration.

Implementation of M1's P0 items began immediately after this report (see `IMPLEMENTATION_CHANGELOG.md`).

# Finix HR — Wave 4 Changes (2026-10-08)

Wave 4 = platform hardening (CI/CD, Docker, telemetry) + the full product-upgrade roadmap: scheduled reports, accounting depth, public REST API + webhooks, ATS depth, PWA, i18n extension, unified approval inbox, owner analytics + dunning, AI assist, and the Bangladesh compliance pack. **Zero new npm dependencies** — every feature is built on the existing stack (nodemailer, SheetJS, recharts, zod, node:crypto).

Verification gates (all green): `bun run typecheck` · `bun run lint` (whole repo) · `bun run build` · `bun test tests/unit` (**772/772**) · fresh `prisma migrate reset --force` + seed (18 migrations) · `scripts/wave3-smoke.ts` (42/42) · `scripts/wave4-smoke.ts` (**52/52**) · `node scripts/check-migrations.mjs`.

---

## 1. Migrations (4, additive-only, sort-safe)

All names sort AFTER `9_wave3_b_plan_requests_20261008` (`wave3` < `wave4` lexicographically — the same convention that fixed the P3018 fresh-database bug):

| Migration | Contents |
|---|---|
| `9_wave4_a_reports_20261008` | `ReportTemplate` + `ReportDeliveryLog` |
| `9_wave4_b_accounting_20261008` | `AccountingPeriod`, `CostCenter`, `Budget`, `AccountJournal.costCenterId` |
| `9_wave4_c_integrations_20261008` | `ApiKey`, `WebhookEndpoint`, `WebhookDelivery` |
| `9_wave4_d_ats_20261008` | `JobInterview`, `OfferLetter`, `OnboardingTask` |

Apply order verified by the new naming guard: `bun run check:migrations` (see §A4). Upgrade path for existing Wave-3 databases: `bunx prisma migrate deploy` — all four are additive (new tables + one nullable column), no data transformation.

## 2. New permissions & modules

- Modules: `integrations` (API & Webhooks), `ai` (AI Assist); action: `reports.schedule`.
- Grants: tenant admins get `integrations.view/create/edit/delete`, `ai.view+generate`, `reports.schedule`; HR managers get `ai.view` + `reports.schedule`. All assignable in Settings → Roles & Permissions.

## 3. A. Fine-tuning (platform hardening)

- **A1 CI/CD** — `.github/workflows/ci.yml`: PostgreSQL 17 service, Bun, frozen install, `prisma generate`, migration naming guard, the FULL local gate (`scripts/ci.sh`: typecheck · lint · unit tests · config/destructive/docs/permission/dependency guards · fresh-database migration smoke), production build + standalone artifact upload. No repository secrets required.
- **A2 Docker** — multi-stage `Dockerfile` (oven/bun; standalone runtime + Prisma CLI), `docker/entrypoint.sh` (TCP wait → `migrate deploy` → exec server), `docker-compose.yml` (app + postgres:17 + optional `--profile redis`), `.dockerignore` (`.env` never baked).
- **A3 Report print polish** — rows never split across pages, repeated table header per page chunk, `table-layout: fixed` + word-break for long Bangla text, Bangla-capable print font stack (Noto Sans Bengali → Hind Siliguri → SolaimanLipi), nowrap numeric columns. Wave-3 footer/dotted-separator behavior untouched.
- **A4 Migration hygiene** — `scripts/check-migrations.mjs` + `bun run check:migrations` + a CI stage: rejects 2+-digit numeric prefixes (the P3018 trap — `10_`/`2026…` sort between `1_` and `2_`), asserts monotonic apply order, asserts the chain tip. Repo rule stays: new migrations use `9_wave<N>_<letter>_<topic>_<yyyymmdd>`.
- **A5 Error tracking** — `src/hrm-server/telemetry.ts`: zero-dependency Sentry/GlitchTip-compatible capture (envelope POST, PII/secret scrubbing, 20 events/min local cap, 4s timeout, never throws into request paths). Enabled only when `TELEMETRY_DSN` is set (optional `TELEMETRY_ENV`); wired into the `/api/hrm` dispatcher's unexpected-error path.

## 4. Tier 1 product upgrades

### 4.1 Saved report templates + scheduled email delivery (WP-A)
- RPCs: `reports.templates.list/save/delete/runNow` (perm `reports.schedule`; unknown report keys refused against the live registry).
- `scheduled-reports.ts` (jobs tick, per vendor): DAILY / WEEKLY-Monday / MONTHLY-1st due computation vs `lastRunAt`; renders through the SAME `renderReportForVendor()` engine the Reports view uses; XLSX (SheetJS) or CSV (UTF-8 BOM) attachment; every send lands in `ReportDeliveryLog` with the gateway SENT/FAILED/SKIPPED contract; one template failing never breaks the loop.
- `gateway.ts` `sendEmail` gained an OPTIONAL `attachments` parameter (backward-compatible).
- Reports page: "Saved Templates" card (perm-gated) — run-now with result toast, edit/delete, "Save current as template" dialog prefilled from the active filters, recent deliveries.

### 4.2 Unified approval inbox (refined scope)
Discovery: the codebase already ships a full approval-workflow **engine** (multi-step, thresholds, delegation). Wave 4 extends the existing inbox instead of replacing it:
- `approvals.queue`/`approvals.history` now also surface manual vouchers (`PENDING_APPROVAL` → POSTED/REJECTED) as pointer rows (`canAct: false`, deep link `accounting?vouchers`) — voucher approval stays in the accounting module where H-9 + the state machine live.
- Approvals view: VOUCHER badge colors, amount column, "Open Vouchers →" deep link, separate voucher count stat.

### 4.3 Accounting depth (WP-B)
- **Periods** — `accounting.periods.list/save/close/reopen` (close/reopen gated on `accounting.approve`, type-to-confirm in UI). `assertPeriodOpen()` enforced at **five** write points: voucher save (create+update), submit, approve, post, and the journal-delete reversal insert — manual vouchers only; auto-journals and posted history untouched.
- **Cost centers** — register CRUD + optional tag on manual vouchers + `vouchers.list` filter; delete refused while POSTED journals reference the center.
- **Cash flow** — `accounting.cashFlow` (direct method): opening/net/closing over cash accounts (1010/1200/1210), movements grouped by counterpart account group, explicit `balanced`/`difference` guard; reuses the shared statement print/export.
- **Budgets** — `accounting.budgets.list/save/delete` with computed actuals (POSTED journals, optionally period- and cost-center-scoped) and variance %; UI tab with pickers.
- Accounting tab order: Vouchers · CoA · Trial Balance · Balance Sheet · **Cash Flow** · Ledger · Income Statement · **Periods** · **Cost Centers** · **Budgets** (grouped SectionTabs).

### 4.4 PWA for ESS (WP-D)
- `public/manifest.webmanifest` + 192/512 PNG icons (rasterized from the logo via sharp).
- `public/sw.js` (vanilla, cache-versioned): cache-first for `/_next/static` + static assets ONLY (never `/api/hrm` responses, never authenticated HTML); network-first navigation with an inline offline shell.
- **Offline attendance queue**: the three punch RPCs (geofence check-in/out, selfie check-in) POSTed while offline are captured to IndexedDB with their CSRF/Bearer headers, answered with a synthetic 202; drained in order on `online` / Background Sync / manual "Sync now (N)" — 2xx deletes, 401/403 + other 4xx delete-with-notify (poison-pill guard), 408/429/5xx retried. ESS shows an offline banner + queued count + sync button.
- Registered only from the ESS view; root layout carries the manifest + theme color.

### 4.5 i18n coverage extension
The Bangla infra already existed (nav-level). Wave 4 adds **81 dictionary keys** (215 total): common actions, ESS tabs + headings, login strings, offline strings; ESS + login now consume `useI18n()`; locale toggle on the login page. Deeper per-view translation continues incrementally.

## 5. Tier 2 product upgrades

### 5.1 Public REST API + API keys + webhooks (WP-C)
- **API keys** — `integrations.keys.list/create/revoke` (perm `integrations.*`): raw key `fk_<32 url-safe>` shown ONCE, sha256-stored, 12-char prefix indexed, ≤10 active keys per vendor, 5 creates/hour.
- **REST v1** (Next route handlers, Bearer auth, scope-checked, 60 req/min per key, every request audited as `API key <name>`): `GET /api/v1/employees`, `GET /api/v1/employees/[id]`, `GET|POST /api/v1/attendance`, `GET /api/v1/leave-balances`, `POST /api/v1/leave-requests`. Envelope `{ ok, data, meta }`; errors 400/401/403/404/415/429 with `Retry-After`. Failed authentications additionally rate-limited at 10/min per prefix (brute-force guard). Employee reads expose a curated directory subset (no addresses/family/tax/payout/photo).
- **Webhooks** — `integrations.webhooks.list/save/delete/test`: https-only URLs re-validated with the SSRF guard before EVERY send; signing secret AES-256-GCM at rest (crypto-field), raw shown once; signature `x-finx-signature: sha256=HMAC(secret, body)` + event/delivery headers; deliveries logged per attempt with 1m/5m/30m/2h/6h backoff, 5 attempts → FAILED; flush driven by the jobs tick (cap 20/pass).
- **Events**: `employee.created/updated`, `leave.requested`, `voucher.posted`, `invoice.paid` (gateway settlement AND owner mark-paid, emitted only on the PENDING→PAID flip) + the REST leave-request path.
- Settings → new **"API & Webhooks"** tab (keys table, one-time secret dialogs, typed-prefix revoke, endpoint CRUD, test ping, delivery history).

### 5.2 ATS depth (WP-D)
Recruitment grows from 2 to 5 tabs: Openings · Pipeline · **Interviews** · **Offers** · **Onboarding**.
- Interviews: scheduling (round/mode/datetime/interviewer/duration/link), outcome (PASSED bumps NEW/SHORTLISTED → INTERVIEW), next-7-days pill; decided interviews frozen (409).
- Offers: 5-component salary with live gross preview, one-live-offer rule (409), DRAFT → SENT (best-effort email to the applicant via the tenant gateway), SENT → ACCEPTED/DECLINED; **acceptance auto-creates 3 starter onboarding tasks** (one audit row) and marks the application OFFERED; printable offer letter via the letters-module print convention (escaped HTML, CSP-safe).
- Onboarding: checklist linked to an application OR employee, assignee, due dates, overdue coloring, done/reopen with doneBy audit.

### 5.3 Owner console analytics + dunning
- `/owner/analytics` (nav: Analytics) + `owner.analytics.overview` (perm `tenants.view`): tenant counts by status, plan distribution, MRR (yearly cycles normalized ÷12, trials excluded), 12-month signup trend, churn risk (past-due + grace-period subs, failed payments 30d, idle tenants 14d via last platform audit), dunning queue.
- `maybeRunDunning(date)` (platform daily job, self-guarded): overdue PENDING invoices → reminder email via the platform gateway to the tenant's active admins, ≤1 reminder/invoice/7 days (counters in `SaaSSetting` — invoice rows never mutated), every send audited; `owner.dunning.remind` = manual send with cadence bypass. Analytics page has a per-invoice "Send reminder" action.

## 6. Tier 3 strategic

### 6.1 AI Assist (new "AI Assist" nav item, perm `ai.view`)
Deterministic-first design — nothing depends on an LLM being configured:
- **NL report queries** (`ai.reportAsk`, 20/h/user): a 13-report intent catalogue with Unicode-safe keyword matching + date/dimension extraction routes questions through the REAL report engine (rows capped 100); no match + LLM configured → one strict-JSON OpenAI-compatible chat call (20s timeout, filter whitelisting); no match + no LLM → actionable Deny.
- **Attendance anomalies** (`ai.anomalies`, pure statistics): buddy-punching (same device fingerprint ≤~90s, ≥3 days), impossible travel (>5km/<15min haversine, midnight-spanning), odd-hours (00:00–04:00), weekend review — severity-sorted, advisory only.
- **Resume screening** (`ai.resumeScreen`, 30/h/user): deterministic keyword score (opening description vs cover note) always available; optional LLM verdict merged when configured; failures degrade to the deterministic result.
- **LLM provider config** — `ai.settings.get/save` (perm `ai.generate`): baseUrl SSRF-validated, key AES-256-GCM at rest, returned only as `apiKeySet`.

### 6.2 BD compliance pack
- **Validators** (`src/hrm/validators-bd.ts`, client-safe, unit-tested 13/13): NID (10/13/17-digit shapes, birth-year plausibility), e-TIN (12-digit NBR checksum — mismatch stays ADVISORY), BIN (13/9-digit), `takaInWords()` (lakh/crore + poisha, BD "and" convention). Wired into the Mushak print's BIN fields; ready for future NID/TIN columns (Employee currently stores NID as a document TYPE, not a number — no false enforcement).
- **Mushak 6.3 invoice print** (Billing → Invoices → "Mushak 6.3"): in-app modal print (same isolation pattern as ReportPrintModal — never a new tab), supplier/customer boxes with live-validated BIN inputs, VAT-inclusive breakdown (net = total ÷ (1+r/100)), amount in words, signature block, computer-generated footer.
- **Gratuity provision report** (`reports.gratuity`): BLA 2006 projection — 30 days' basic per completed year for 5y+ employees, divisor 30/26 selectable, per-employee + total exposure, printable/exportable/schedulable. Advisory only — never posts a liability.
- **Festival bonus preview** (`reports.festivalBonus`): % of basic/gross per active employee + totals; actual payment stays in the payroll bonus engine.

## 7. Fixes landed along the way

- `scripts/wave3-smoke.ts` + `public/sw.js` lint compliance; **two pre-existing unit-test failures fixed** (present before Wave 4): `m04-job-queue` expected the removed `FAILED` status (queue semantics are retry→DEAD since the 2026-10 job-queue round — test now asserts DEAD dead-lettering with `maxAttempts: 1`) and `global-search` uniqueness now keys on `(view, tab, tpl)` because the settings→templates tab legitimately holds 4 distinct search targets (generic + sms/email/letter deep links).
- Sandbox hygiene: the repo had accidentally committed 4,049 live PostgreSQL data files (`pg/data/**`) — now untracked + `pg/` in `.gitignore` (stashing a live database nearly corrupted it).
- ApprovalDelegate/delegation, the approval engine, Bangla nav i18n, `scripts/ci.sh` — verified to ALREADY exist (Wave 4 scope was adjusted to extension, not reimplementation).

## 8. Post-pull steps

```bash
bun install
bunx prisma migrate deploy      # applies the 4 wave-4 migrations (additive)
bunx prisma generate
bun run typecheck && bun run lint && bun test tests/unit
bun run build && bun start
# optional fresh database instead:
bunx prisma migrate reset --force && bun run seed
# smoke (scratch DB):
DATABASE_URL=… bun run scripts/wave3-smoke.ts
DATABASE_URL=… bun run scripts/wave4-smoke.ts
```

- Docker: `docker compose up --build` (set `HRM_MFA_KEY` via env; see `docker-compose.yml`).
- Telemetry: set `TELEMETRY_DSN` (Sentry/GlitchTip) to enable error capture — off by default.
- CI: push to GitHub with `.github/workflows/ci.yml` — needs no secrets.
- AI assist: configure an OpenAI-compatible provider in AI Assist → LLM Provider (optional; anomalies + deterministic screening work without it).

---

## 8. Post-release fix (same day): Field Force entitlement gap

**Symptom**: owner console → tenant detail showed `field force` unchecked for Enterprise-plan tenants; the module was hidden/blocked for them.

**Root cause**: the Wave-2 migration added `SaaSPlan.fieldForceEnabled` (default `false`), but no plan definition ever enabled it — the seed's `PLAN_DEFS` set every other premium flag on Professional/Enterprise, and `owner.plans.save`'s zod schema had no `fieldForceEnabled` field, so the owner console plan editor had no toggle for it either. Every SUBSCRIBED tenant therefore resolved `FIELD_FORCE: false` (LEGACY tenants — no subscription row — were unaffected; they get all features).

**Fix (8 files, zero migrations — the column already existed)**:

| File | Change |
|---|---|
| `src/hrm-server/saas/seed-saas.ts` | `fieldForceEnabled: true` on Professional + Enterprise (Starter/Business/Trial stay off) |
| `src/hrm-server/saas/owner-routes.ts` | `planSchema` gains `fieldForceEnabled: z.boolean().default(false)` |
| `src/app/owner/(console)/plans/page.tsx` | Plan editor: type + BLANK + openEdit + save payload + "Field force" entitlement chip |
| `src/hrm-server/saas/entitlements.ts` | `FIELD_FORCE: plan.fieldForceEnabled` (typed access, `as any` removed) |
| `pricing-cards.tsx` + `pricing-contact-blocks.tsx` + `/pricing` + `/register` + `/api/saas` | `fieldForce` row in the marketing feature checklist and its five projections |

**Verification**: typecheck EXIT 0 · eslint (9 files) EXIT 0 · `bun test tests/unit` **772/772** · fresh reset + seed → wave3-smoke ALL PASSED · wave4-smoke ALL PASSED · live entitlement probe: Enterprise-subscribed tenant resolves `FIELD_FORCE: true`, `featureBlocked("fieldforce") = false` (`scripts/verify-fieldforce.ts`, self-cleaning).

**Applying to an already-seeded database** (the seed skips existing plans by name): Owner console → Plans → Enterprise (or Professional) → toggle the **Field force** chip → Save. Entitlements refresh within 10s (memo TTL). SQL equivalent:

```sql
UPDATE "SaaSPlan" SET "fieldForceEnabled" = true WHERE name IN ('Professional', 'Enterprise');
```

---

## 9. Post-release fix (same day): permission catalog gap — Camera Manager invisible / EZVIZ "Configure" unreachable

**Symptom**: a tenant admin reported that after granting "all permissions" to the Vendor Owner, the Camera Manager module was nowhere in the tenant panel and the EZVIZ credentials **Configure** button never appeared.

**Root causes — two independent defects**:

1. **Plan gating (data, by design)**: `SAAS_GATED_MODULE_FEATURE.camera → CAMERA` feature; Starter and Trial plans seed `cameraEnabled: false`, so SUBSCRIBED tenants on those plans have the whole module hidden (nav, routes, search). Permissions cannot lift a plan gate — only a plan change or a per-tenant override can. The **Trial** plan, however, advertises "Full Business feature set" while shipping `cameraEnabled: false` **and** `advancedReports: false` — both contradicted its own tagline, so evaluators lost Camera Manager (incl. EZVIZ credential setup) and analytics mid-trial.
2. **Permission-catalog gap (code bug, three silent-failure sites)**: `ACTIONS` (`src/hrm-server/types.ts`) — the verb catalog behind the role editor AND `normalizePermissions` — lacked **`launch`** and **`manage`**, while live routes require them (`camera.launch`, `camera.manage` ×4, `tracking.manage`, `jobs.manage`, `billing.manage`) and `ROLE_TEMPLATES` grant them. Consequences:
   - `roles.save` **stripped** those verbs from every saved role override — editing the Vendor Owner role and saving "all permissions" actually *removed* camera launch/credential-manage rights (the "Configure"/"Manage brand credentials" button requires `camera.manage`);
   - the Settings → Roles & Permissions matrix could never display or grant them (invisible columns);
   - `provisionTenant` + `seed-owner` write the owner's **explicit** permission set as `MODULES × ACTIONS` — every registration-provisioned tenant's Vendor Owner permanently lacked them (explicit sets override the role template in `getCtxFromToken`).

**Fix**:

| File | Change |
|---|---|
| `src/hrm-server/types.ts` | `ACTIONS` += `"launch", "manage"` — fixes all three sites at once (matrix columns, normalize filter, provisioned owner sets) |
| `src/hrm-server/saas/seed-saas.ts` | Trial plan: `cameraEnabled: true`, `advancedReports: true` (tagline parity with Business) |
| `scripts/fix-permissions-catalog.ts` | **New** — scans existing DBs for damaged rows (users with explicit sets / role overrides missing template verbs; pre-fix Trial plan) and repairs them with `--repair` (adds only, never removes; users regain verbs at next login) |
| `scripts/verify-permissions-catalog.ts` | **New** — 21 assertions: catalog contents, provision-shaped set survives normalize, every `ROLE_TEMPLATES` verb inside `MODULES × ACTIONS` (regression guard), Trial-plan CAMERA entitlement probe (self-cleaning) |
| `src/hrm-server/routes/accounting.ts` | Bonus bug found while re-verifying: `costCenters.save`'s clash guard made the documented **upsert-by-code** path unreachable (no-id save of an existing code always threw "already in use"); the probe now only guards the rename-collision case |
| `scripts/wave3-smoke.ts`, `scripts/wave4-smoke.ts` | Harness idempotency fixes so re-runs against one DB stay green: cycle-consistent plan-change target pick + ordered `findMany`; trial-balance **delta** assertion; run-unique period name; fresh ATS application per run; smoke-owned throttle + pending-webhook-delivery residue cleanup; structural dunning assertion |
| `scripts/verify-fieldforce.ts` | Full subscription snapshot restore (`priceAtCreation`/`currencySnapshot` were left at probe values, breaking later plan-change smokes) |
| `scripts/repair-rongin-sub.ts` | **New** — one-off repair restoring the demo tenant's seeded subscription snapshot |

**Verification**: typecheck EXIT 0 · eslint (10 touched files) EXIT 0 · `bun test tests/unit` **772/772** · build EXIT 0 · wave3-smoke ALL PASSED (×2 consecutive) · wave4-smoke ALL PASSED (×3 consecutive) · `verify-permissions-catalog` 21/21 · `verify-fieldforce` all-pass (self-cleaning).

**Applying to an already-seeded database**:

1. Run `bun run scripts/fix-permissions-catalog.ts` (scan) then `--repair` — merges `camera.launch`/`camera.manage`/`tracking.manage`/`jobs.manage`/`billing.manage` back into damaged explicit sets and role overrides, and flips the Trial plan flags. Affected users **log out and back in**.
   - Quicker role-only path: Settings → Roles & Permissions → Vendor Owner → **Reset to built-in template** (deletes the override; the static template was always correct), then re-login. SQL equivalent for user-level explicit sets: `UPDATE "User" SET permissions = '[]' WHERE role = 'VENDOR_OWNER';`
2. Camera Manager visibility needs a plan that includes it (Business/Professional/Enterprise — or the repaired Trial). Starter tenants: upgrade via owner console, or set a per-tenant override — Owner console → Tenants → tenant detail → Feature overrides → **Camera Manager** → on (entitlements refresh ≤10s).
3. SQL for the Trial plan alone: `UPDATE "SaaSPlan" SET "cameraEnabled" = true, "advancedReports" = true WHERE name = 'Trial';`

**EZVIZ credential setup for tenant admins (once the Camera Manager is visible)**: sidebar → **Camera Manager** → **Manage brand credentials** (visible to `camera.manage` holders: Vendor Owner / HR Admin) → brand **EZVIZ** → **Configure** → paste `appKey` + `appSecret` from the EZVIZ Open Platform (open.ezvizlife.com → your application) → **Save** — credentials are encrypted at rest and never displayed again; **Rotate** replaces them. IMOU uses the same dialog with `appId`/`appSecret`; Hikvision/Dahua need no tenant credentials (per-camera verification codes).

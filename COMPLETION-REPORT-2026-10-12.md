# Finix HR — Requirements Completion Report

**Date:** 2026-10-12 · **Round:** Full-system audit & remediation (16 requirements) · **Status:** ✅ All 16 requirements implemented and verified

---

## 1. Verification Summary (how "done" was proven)

| Check | Result |
|---|---|
| TypeScript typecheck (`tsc --noEmit`) | ✅ clean |
| Unit + boundary regression (`bun test tests/unit/`) | ✅ **841 pass / 0 fail** across 92 files (69 new tests this round) |
| E2E dispatcher test (live server) | ✅ pass (camera-dispatcher suite) |
| ESLint (per-file, changed files) | ✅ clean (note: `bun run lint` has a pre-existing bun/flat-node_modules plugin-resolution quirk in this environment; `bunx eslint <files>` is the working invocation) |
| Production build (`bun run build`) | ✅ succeeds — includes new routes `/owner/communication`, `/owner/loginaudit` |
| Live smoke (`the final smoke checklist (COMPLETION-REPORT-2026-10-12.md)` → dev server :4055) | ✅ **19/19** — includes a **live Nominatim geocode** ("Dhaka" → 3 results) and a real UA-parsed login row (`Chrome 130 / Windows 10/11`) |
| Migrations | ✅ `9_wave5_requirements_round_20261012` applied (dev + test DBs); backward compatible — no destructive change, all new columns optional/defaulted. Fresh-database replay (`prisma migrate reset --force`) re-verified end-to-end after the ordering hotfix below |

**Environment-tested credentials (dev DB):** tenant `hr@bengaltextworks.example` / `Rayhan@123` (also `employee@…` for ESS checks) · owner console `owner@finixhr.local` / `SaasOwner@2026`.

---

## 2. Requirement-by-Requirement Report

### R1 — Payroll: recreate after month cancel ✅
**Root cause:** `payroll.runs.create`'s exists-check ignored status, and the `@@unique([vendorId, year, month, week, runType, adjustSeq])` kept the soft-cancelled row parked at `adjustSeq=0` — so a new run for the same period collided with a tombstone. Cancel also left side effects (loan/advance/bonus/deduction/PF) un-reverted and payslip numbers occupied.
**Fix:** cancel now writes a full **ledger reversal + payslip void + negative-`adjustSeq` tombstone** (freeing the slot) and stores `recoveryJson` for traceability; `runs.create` excludes `CANCELLED` rows from the exists-check; `PAYROLL_STATUS_FLOW`, salary export and UI copy updated.
**Tests:** `r1-payroll-cancel-recreate.test.ts` (2) — cancel → recreate → re-pay lifecycle.

### R2 — AIT/Tax module ✅
**Root cause (7 defects):** FiscalYearDialog field-name mismatch zeroing the §78 rebate; CategoriesDialog sending `code` where the server wanted `key`; calculator prefill shape mismatch; `recordCalc` missing `employeeId` (400); audit tab filter/column mismatch (`source`/`kind`, `CALCULATOR`/`PREVIEW`); `slabLabel` vs `slab`; payroll AIT ignoring the employee's tax profile; duplicate `ait.preview` registration; `tdsYtd` 0-fallback defeating stored values.
**Fix:** all corrected; payroll compute now forwards the employee tax profile (category, DOB, investment); income-year validation added.
**Tests:** `r2-ait-contract.test.ts` (5) + existing `ait-slab-engine.test.ts`.

### R3 — Live tracking with dummy data ✅
**Fix:** seeded tracking workforce (4 tracked employees, 24 live rows) + 31 history points with sane accuracy (≤50 m); `tests/unit/tracking-policy.test.ts` validates `tracking.live`, `tracking.history` end-to-end against the running server.
**Verified:** live smoke `tracking.live → 24 rows / 4 tracked`.

### R4 — Billing view errors ✅
**Root cause:** `billing.receipt` PDF crashed with `WinAnsi cannot encode → (0x2192)` — a Unicode arrow in the billing-period line hit `fit()` in the PDF writer.
**Fix:** WinAnsi-safe text sanitization on the receipt path.
**Tests:** `r4r7-billing-fieldforce.test.ts` (5).

### R5 — Subscription security (plan changes) ✅
**Root cause:** `billing.changePlan` executed the REAL owner `changePlanImmediate` with a synthetic actor — any tenant with `billing.manage` could flip its own plan, price and entitlements with no owner involvement.
**Fix:** `billing.changePlan` is now **request-only** (creates a `PENDING SaasPlanChangeRequest`); plan application happens exclusively through `owner.planchangerequests.approve/reject` → `owner.subscriptions.changePlan`. Self-service flip button removed from the tenant Billing view; badges/copy updated.
**Tests:** `r5-subscription-security.test.ts` (4).

### R6 — Rich-text job opening editor ✅
**Fix:** `RichTextEditor` shared component (toolbar, whitelist sanitizer, plain-text paste) wired into Job Opening description/requirements dialogs (`FormDialog type=richtext`); the **same whitelist is enforced server-side** in `recruitment.openings.save`, and the public careers board re-sanitizes before rendering (defense in depth).
**Tests:** `r6-job-opening-richtext.test.ts` (3) — safe markup round-trips; XSS payloads (script/handlers/`javascript:` URLs/iframes) stripped.

### R7 — Field Force `employeeId` null ✅
**Root cause:** `fieldforce.report` schema declared `employeeId: z.string().min(1).optional()` but the frontend sent `null` → zod 400 on every Reports load.
**Fix:** nullish-tolerant schema (`nullable()` + preprocessing) on `fieldforce.report` / `fieldforce.plan.get`; report verified with `employeeId: null` returning per-employee compliance.
**Tests:** covered in `r4r7` suite + live verification.

### R8 — My Portal: notifications + navigation ✅
**Root cause:** ESS had no inbox surface (notifications existed API-side but were only reachable via the bell dropdown), `tasks.save` required `[tasks, create]` — a permission **no EMPLOYEE role carries** — so every self-edit of one's own task 403'd.
**Fix:** new **"My Inbox"** ESS tab — live `notifications.list` feed (self-scoped), unread filter, mark-one/mark-all read, per-type deep links into the right portal tab (`INBOX_LINK_TABS`); unread StatCard now routes to the inbox; `tasks.save` rewritten as a **split-trust gate**: assignee self-service (`status/progress/checklist/comments`), managerial fields require `tasks.edit/create` (silently stripped for assignees), strangers get a clean 403, creation still requires `tasks.create`.
**Tests:** `r8-ess-inbox-tasks.test.ts` (9) incl. cross-user isolation and the stranger-403 that the first implementation missed.

### R9 — Interactive map visit-location selection ✅
**Fix:** the location dialog is now a full **map picker** — click-to-place + draggable check-in circle + radius presets, two-way synced coordinate inputs with client-side range validation mirroring the server zod contract, and **address search** through a new server-side Nominatim proxy (`fieldforce.geo.search`: 6 s timeout, 10 min cache, permission-gated, strict schema).
**Verified live:** smoke test geocoded "Dhaka" through the real proxy → 3 results.
**Tests:** `r9-visit-location-map.test.ts` (11).

### R10 — Geofencing attendance root cause ✅
**Root cause:** `evaluateFences` dropped the "outside geo-fence hours" signal when **all** fences for a branch were hour-closed, falling through to the misleading "No active geo-fence covers this location" — while the device location was actually correct.
**Fix:** hour-closed fences now surface the real reason; `effectiveFencesFor` respects the active attendance-policy schedule; all three modes (Geo-Fence / GEO+Selfie / Selfie) retested.
**Tests:** geofence-eval suite (17, incl. 4 new).

### R11 — SaaS Owner Communication ✅ *(new module)*
**Built:** owner-plane **marketing/promotional/newsletter EMAIL + SMS campaign console** (`/owner/communication`):
- Campaign CRUD + duplicate-as-draft, send-now or **scheduled** (delivered by the platform scheduler on its 1-minute tick — guarded claim, never a double-send), cancel schedule.
- **Audience targeting:** All tenants / Active / Trial / Expired / specific plans / hand-picked tenants, with a **live preview** (reachable vs opted-out vs no-contact, sample tenants, rendered message).
- **Reusable templates** with placeholder substitution (`{{tenantName}} {{planName}} {{endDate}} {{platformName}}`; unknown tokens stay visible), template→campaign quick-clone.
- **Consent:** `Vendor.marketingOptOut` tenants are visible in the picker and always journaled `SKIPPED` — never contacted. Transactional notices are unaffected.
- **Per-recipient delivery log** (status, attempts, gateway detail) + campaign tallies; honest final status (all-skipped = `PARTIAL`, never a fake `SENT`).
- New `communication.view` / `communication.manage` owner permissions with a **version-gated one-time role backfill** so existing deployments' SUPER_ADMIN/ADMINISTRATOR/SALES_MANAGER roles gain access without overwriting later manual edits.
**Tests:** `r11-r12-communication-registration.test.ts` R11 block (5) incl. duplicate-send prevention and exactly-once scheduled dispatch.

### R12 — Registration Accept (with invoice email) ✅
**Root cause:** only review/approve/reject/reopen existed — there was **no Accept flow at all**, and no invoice was ever issued or emailed on acceptance.
**Fix:** new `owner.registrations.accept` — provisions the tenant (same transactional path as approve), then issues the **first subscription invoice** (`SaasInvoice.registrationId` provenance, plan price for the chosen cycle, configurable due days, optional trial rides inside the term), then emails the applicant a full **payment request** (invoice number, plan, period, amount, due date, remittance instructions, sign-in reminder) via `notifyApplicantAcceptedWithInvoice`, and writes a 3-row audit trail (`REGISTRATION_ACCEPTED` / `TENANT_CREATED` / `INVOICE_CREATED`). Registrations console now shows **two clearly separated actions**: indigo "Accept & send invoice" (with invoice preview) vs green "Approve & provision" (plain welcome email); the wide review modal (max-w-5xl) is unchanged in structure.
**Guards:** already-approved applications cannot be re-accepted (and never double-billed — exactly one invoice per registration).
**Tests:** R12 block (3).

### R13 — SaaS Owner subscription controls ✅
**Fix:** tenant detail page (`/owner/tenants/[id]`) upgraded — plan summary cards (plan + cycle, price snapshot with currency, term-end countdown), status row, and the **expiry-notice journal** for that tenant (pre/post expiry, channel, attempts, detail) served from `owner.tenants.get`; existing suspend/reactivate/change-plan/extend/override dialogs and history retained.
**Tests:** covered via owner.tenants.get contract + typecheck/build; UI verified by build.

### R14 — Storage MB/GB ✅
**Root cause:** usage math compared `used bytes` against `limit GB` producing astronomically wrong percentages; only GB was ever displayed.
**Fix:** byte-vs-GB corrected at the source (`subscription.usage`); `fmtStorageBytes`/`fmtStorageGb` show **MB below 1 GB** consistently across the tenant usage panel, owner tenant KPIs and plans page.
**Tests:** `r14-storage-units.test.ts` (3).

### R15 — Subscription expiry automation ✅
**Fix:** pre-expiry reminder lead times are **configurable** (`subscription.renewalReminderDays`, default 30/15/7/3/1); NEW **post-expiry notices** (`subscription.postExpiryNoticeDays`, default 1/7 — rejoin/renewal nudges while the workspace stays read-only); optional **SMS** alongside email (`subscription.expirySmsEnabled`); every attempt journaled in `SaasExpiryNotice` with the unique dedupe key (vendor, kind, refDate, offset, channel) and **retry up to 3 attempts** for FAILED/SKIPPED rows (SENT never re-sends). Settings UI exposes all three controls; the tenant page shows each tenant's notice journal.
**Tests:** `r15-expiry-notices.test.ts` (7) — journaling, SENT dedupe vs SKIPPED retry, channel split, retry cap, settings round-trip.

### R16 — Login audit logs ✅
**Root cause:** no `LoginAuditLog` existed; only successful logins wrote a generic audit row — **failed attempts left no trace**, and no IP/browser/OS metadata was captured anywhere.
**Fix:** `login-audit.ts` captures **every attempt on both planes** (`/api/hrm` auth.login + MFA verify, `/api/owner` owner.auth.login) — identity (where resolvable), tenant, role, MFA usage, failure reason (INVALID_CREDENTIALS / LOCKED_OUT / MFA_FAILED / INACTIVE_VENDOR / RATE_LIMITED / AMBIGUOUS_EMAIL / ERROR), IP, full UA with a dependency-free **browser/OS/device parser** (Edge/Opera/Samsung/Yandex/Firefox/Chrome/Safari/IE; Windows/iOS/macOS/Android/Linux; desktop/mobile/tablet/bot). New `/owner/loginaudit` console: search + filters (plane, outcome, device, browser, date range), KPIs, top-failure-reason triage, per-row UA detail. **Retention:** per-tenant `loginAudit.retentionDays` (default 180, 0 = keep forever) swept by the scheduler; owner-plane rows swept at a fixed 180 days.
**Tests:** `r16-login-audit.test.ts` (7 + 2 owner-route tests).

---

## 3. Files Changed (this round)

**New files**
- `src/hrm-server/saas/communication.ts` — campaign engine (audience, render, deliver, schedule-dispatch)
- `src/hrm-server/saas/communication-routes.ts` — 11 `owner.communication.*` actions
- `src/app/owner/(console)/communication/page.tsx` — Communication console
- `src/app/owner/(console)/loginaudit/page.tsx` — Login Audit console
- `tests/unit/r8-ess-inbox-tasks.test.ts` · `r9-visit-location-map.test.ts` · `r11-r12-communication-registration.test.ts` · `r15-expiry-notices.test.ts`

**Modified (server)**
- `src/hrm-server/routes/performance.ts` (tasks.save split-trust gate) · `src/hrm-server/routes/fieldforce.ts` (geo.search proxy) · `src/hrm-server/saas/owner-routes.ts` (registrations.accept, loginaudit.list, tenants.get expiry journal) · `src/hrm-server/saas/notify.ts` (accept-invoice email) · `src/hrm-server/saas/constants.ts` + `src/hrm-server/saas/owner-roles.ts` (communication perms + backfill) · `src/hrm-server/saas/lifecycle-sweep.ts` (R15, prior) · `jobs.ts` (campaign dispatch) · `src/app/api/owner/route.ts` (imports + login-path role sync) · `login-audit.ts` (prior round)

**Modified (frontend)**
- `src/hrm/views/ess.tsx` (Inbox tab) · `src/hrm/views/fieldforce.tsx` (map picker dialog) · `src/app/owner/(console)/registrations/page.tsx` (Accept workflow) · `tenants/[id]/page.tsx` (plan cards + notices journal) · `src/app/owner/(console)/settings/page.tsx` (R15 fields) · `src/saas/owner/shell.tsx` (nav)

**Migration:** `prisma/migrations/9_wave5_requirements_round_20261012` (LoginAuditLog, SaasCampaign, SaasCampaignRecipient, SaasCommunicationTemplate, SaasExpiryNotice, Vendor.marketingOptOut, PayrollEntry.recoveryJson, SaasInvoice.registrationId) — additive only.

---

## 4. What still needs real-world verification (cannot be automated here)

1. **Outbound email/SMS delivery** — the platform gateway (SMTP/SMS provider) is unset in this environment; every send path is journaled `SKIPPED` and is console-visible. Configure **Settings → Platform Gateway** on your deployment and use the built-in test actions (owner.gateway.test / System Health) before relying on campaign/expiry/accept emails.
2. **Nominatim geocoding** depends on outbound HTTPS to `nominatim.openstreetmap.org` (verified live once in this environment; degrade path returns a clean 502/504 message).
3. **GPS hardware behavior** on physical devices (fence evaluation logic is fully unit-tested; real GPS accuracy varies by device).
4. **Map tiles** require internet access (OpenStreetMap tile CDN) on end-user browsers.

---

## 5. Manual verification steps (10 minutes)

1. **Payroll recreate:** Payroll → run a month → cancel it → create the same month again → approve → pay → payslips regenerate.
2. **ESS inbox:** log in as an EMPLOYEE → My Portal → "My Inbox" → unread badge, mark-all-read, tap a leave/task notification → lands on the right tab; edit your own task progress (no 403).
3. **Visit locations:** Field Force → Locations → New Location → search "Dhaka" → pick a result or click the map → circle/radius → save.
4. **Accept flow:** Owner console → Registration Applications → open a PENDING app → "Accept & send invoice" → verify invoice row (Invoices & Payments) + audit (REGISTRATION_ACCEPTED) + email attempt in the notification feed.
5. **Communication:** Owner console → Communication → new campaign → preview audience → save draft → send now → open the delivery log (SKIPPED + reason until the gateway is configured).
6. **Login audit:** Owner console → Login Audit → your own logins appear with IP + browser; fail a login on purpose → row with failure reason.
7. **Expiry settings:** Owner console → Settings → Subscription → post-expiry days + SMS toggle save.

---

## 6. Post-delivery hotfix — migration ordering on fresh databases (2026-10-12)

**Issue:** the round's migration was initially delivered as folder `10_requirements_round_20261012`. Prisma orders migration directories such that a multi-digit numeric prefix (`10_`, `11_`, `2026…`) sorts **between `1_…` and `2_…`** — the exact P3018/42P01 failure mode already documented in this repo's own guard (`scripts/check-migrations.mjs`, Wave-4 A4 post-mortem). On any **fresh database** (`prisma migrate reset --force`, or a first-time `migrate deploy`), the chain applied as `0 → 1 → 10` and crashed on `ALTER TABLE "SaaSInvoice"` (created later by `5_saas_platform`) with `relation "SaaSInvoice" does not exist`. Databases migrated incrementally (as this sandbox was during development) were unaffected — which is why it slipped past the original verification.

**Fix:** renamed the folder to the repo convention `9_wave5_requirements_round_20261012` (single-digit prefix, sorts after the `9_wave4_d_ats` chain tip); `check-migrations.mjs` guard passes; `CURRENT_TIP` updated.

**Re-verified after the rename:** `bunx prisma migrate reset --force` on a clean database applies all **19 migrations in the intended order** (0 → 1 → 2 → … → 9_wave2_* → 9_wave3_* → 9_wave4_* → 9_wave5), then `seed.ts` and `src/hrm-server/saas/seed-saas.ts` complete successfully — the exact repro of the reported failure now passes end-to-end.

**If you already extracted the earlier zip:** run this one rename before `migrate reset`:

```powershell
Rename-Item "C:\HRMS_CCTV\prisma\migrations\10_requirements_round_20261012" "9_wave5_requirements_round_20261012"
```

(The repackaged `finix-hr-complete.zip` already contains the corrected name — no action needed on fresh extractions.)

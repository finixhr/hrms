# Implementation Report — 2026-10-08 (Wave 3)

Scope: the six Wave 3 work packages (WP-A…WP-F) executed against the full
codebase with no breaking changes to routes, permissions, tenant isolation,
APIs or business logic. No new runtime dependency (recharts + SheetJS `xlsx`
were already present).

Verification: `bun run typecheck` clean, `bun run lint` clean (whole repo),
`next build` compiles (route table includes the new `/owner/planchanges`),
and a 42-assertion functional smoke suite (`scripts/wave3-smoke.ts`) passes
end-to-end against a live PostgreSQL after `migrate reset --force` + seed:
voucher DRAFT→PENDING→POSTED/REJECTED transitions, H-9 refusals, POSTED-only
ledger math, balance-sheet identity A = L + E, all nine new reports (+CSV
twins), plan-change request submission → owner approval → subscription
mutation → event record, duplicate/permission guards.

---

## 1. WP-A — EZVIZ / Imou credential onboarding UX

The Cameras → Credentials dialog (tenant-level AES-256-GCM appKey/appSecret,
rotate/delete) already existed; the Add-Camera pre-flight warning now closes
the loop:

- **Non-managers see exactly who to contact**: the warning names the active
  users who actually hold `camera.manage` (VENDOR_OWNER / HR_ADMIN / explicit
  grants) — fetched via `users.list` gated on `settings.view`, with a
  role-level fallback when the caller cannot list users.
- **Where the keys come from**: brand-specific one-line hint — EZVIZ: "Get
  your appKey and appSecret from the EZVIZ Open Platform
  (open.ezvizlife.com) → your application."; Imou: open.imoulife.com.
- The "Configure now →" shortcut for `camera.manage` holders is unchanged.

## 2. WP-B — Voucher Posting Approval (Accounting)

Manual journal vouchers can now travel **DRAFT → PENDING_APPROVAL →
POSTED / REJECTED**. Auto-generated journals (payroll, payouts, loans,
expenses, settlements) keep their auto-POSTED semantics — the migration
defaults every existing and system row to POSTED.

- **Schema (migration `9_wave3_a_voucher_approval_20261008`, additive):**
  `AccountJournal` += `status` (DRAFT | PENDING_APPROVAL | POSTED | REJECTED,
  default POSTED), `approvedById/Name`, `approvedAt`, `rejectionReason` +
  `(vendorId, status)` index.
- **New permission `accounting.approve`** (ACTIONS already contained it) —
  granted to HR_ADMIN + VENDOR_OWNER templates; `accounting.create` was also
  added to the admin templates (it was granted to NO role template before —
  the voucher UI was effectively dead for everyone).
- **New RPCs** (all H-10 vendor-scoped, zod `.strict()`, audit-logged,
  `assertNotReadonly` in-handler):
  - `accounting.voucher.save` — create or update a DRAFT; H-9 validated at
    save (a draft is never stored unbalanced);
  - `accounting.voucher.submit` — DRAFT → PENDING_APPROVAL, H-9 re-checked on
    the stored lines;
  - `accounting.voucher.approve` — PENDING → POSTED (perm
    `accounting.approve`); H-9 re-validated at approve time with exactly the
    voucher.post semantics; stamps approver + time;
  - `accounting.voucher.reject` — PENDING → REJECTED with a required reason.
  - `accounting.vouchers.list` += `status` filter + per-status `statusCounts`
    (groupBy) + the workflow queue data.
- **Ledger correctness:** `accounting.ledger`, `accounting.trialBalance`,
  `accounting.incomeStatement`, `accounting.balanceSheet`,
  `reports.journals.list` (Payroll → Journals) and the stats money figures
  now read **POSTED journals only** — drafts and pending approvals are not
  money yet. Existing rows are POSTED by default, so pre-wave-3 behavior is
  unchanged.
- **Void (reversal) discipline:** only POSTED vouchers can be voided via
  reversal; DRAFT → edit and resubmit, PENDING → reject, REJECTED never hit
  the ledger. Posted money history stays immutable as before.
- **Vouchers tab UI:** Save Draft / Submit for Approval / Post Directly on
  the entry form (H-9 live mirror unchanged); Edit-draft loads the row back
  into the form; status chips + clickable per-status filter; a "Pending My
  Approval" queue card for approvers; row + drill-dialog actions
  (Approve/Reject/Submit/Edit/Void) role-gated; rejection reason surfaced in
  the drill-down.

## 3. WP-C — Tenant plan-change self-service

Two gaps closed (the backend `billing.changePlan` / `billing.renew` already
existed):

- **Step 1 — permissions:** `billing.view` is now granted to HR_MANAGER in
  addition to HR_ADMIN / VENDOR_OWNER (billing.manage stays admin/owner), so
  the Billing page and the new catalog surface appear for management roles.
- **Step 2 — Subscription & Usage page plan catalog:** a "Plan Catalog &
  Changes" section (current plan highlighted; price in the tenant's billing
  cycle). Roles WITH `billing.manage` get Upgrade now / Schedule downgrade
  inline — the same `billing.changePlan` RPC as the Billing page (one server
  path, two surfaces). Roles WITHOUT it get the **Request Plan Change**
  flow: dialog with auto-derived mode + note → `billing.planChangeRequest`.
- **Step 3 — request queue (migration
  `9_wave3_b_plan_requests_20261008`, additive):** new `SaasPlanChangeRequest`
  model (vendorId, requestedPlanId, mode, note, status
  PENDING|APPROVED|REJECTED, requestedBy/decidedBy + decidedAt +
  decisionNote) with vendor + status indexes, plain-String FKs per the H-10
  convention. Tenant RPCs: `billing.planChangeRequest` (perm billing.view,
  rate-limited, one open request per workspace, same plan-validity gates as
  changePlan, notifyOwnerUsers fan-out) and `billing.planChangeRequests`
  (own history, last 20). Owner console: **/owner/planchanges** (nav "Plan
  Requests", perm subscriptions.view) — list with status filter/search, and
  approve/reject. Approving runs the REAL
  `owner.subscriptions.changePlan` handler (composed, never forked — same
  events, price snapshots, entitlement invalidation, saasAudit as an
  owner-console change) and marks the request decided; rejecting records the
  reason. The tenant sees request status inline on the Subscription page.

## 4. WP-D — Module Visibility: KEPT (copy change only)

Module Visibility stays (Settings → Module Visibility, `module-map.ts` M-08
single source of truth). It is UX de-cluttering, NOT access control —
server-side RBAC + plan entitlement still authorize every RPC. Only the card
copy changed to say exactly that: "Hides modules from navigation only.
Access is still controlled by role permissions and your plan."

## 5. WP-E — HR Reports engine overhaul

`src/hrm/views/reports.tsx` rebuilt around a shared engine
(`src/hrm/shared/report-print.tsx`), now also used by the Accounting
statements:

- **ReportShell print layout — Modern ERP SaaS grade:** company identity
  (logo when set, name, address, phone, email, BIN/VAT/TIN) → **dotted
  separator** → Report Name (bold) + meta line (period / filters / row
  count) → zebra table with right-aligned tabular numerics (+ optional chart
  on page 1) → **dotted separator** → footer, three parts: left
  `Print Date & Time : 10/8/2026 12:10:49PM` (exact `M/d/yyyy h:mm:sstt`
  format, refreshed live when Print is clicked), center `Powered by Finix
  HR`, right `Page X of Y` — REAL page numbers via client-side pagination
  (24 rows/page default, chart pages carry fewer), thead repeated on every
  page, A4 portrait.
- **Print = in-app modal, never a new tab:** a portal at document.body
  renders the pages; `@media print` hides everything else
  (`body > *:not(#finix-report-print-root)`); the modal's Print button calls
  `window.print()` after a double-rAF timestamp refresh. The old
  `openPrintWindow` new-tab path is removed from Reports.
- **Explicit generation:** no auto-fetch — filters + **View / Generate**
  button; last-used filters cached per report key (localStorage); switching
  reports resets the view.
- **Charts only where meaningful:** `REPORTS[].charts` flags (pie/donut/bar/
  line). Flagged: headcount, demographics, salaryBands, payrollBranch (pie/
  donut/bar), attendanceBranch/Department/Absence/Overtime/WorkingHours,
  payrollDepartment, payrollDeductions, leaveUtilization, performanceKpi,
  headcountMovement (bar/line), performanceTrend (line/bar), recruitment
  Funnel, fieldforceVisits. Register/detail reports (Employee Register,
  Biodata, Directory, Ledger-like lists) show NO chart UI. Chart data is
  derived client-side from the rendered rows (label column = first
  non-numeric; series = numeric columns excluding pure-percentage columns;
  top 14) — **toggling chart type never refetches**.
- **"Export as" split-button:** exactly two items — **Export as .xlsx**
  (SheetJS, client-side from the rendered rows, Bengali/৳-safe, sane column
  widths) and **Export as .csv** (the existing audited server CSV path,
  UTF-8 BOM). PII reports keep their typed-confirmation gate unchanged.
- **Nine new reports** (same `reportRoute` envelope + CSV twins, H-10 scoped,
  L-28 capped): Headcount (branch/department/status/employment-type
  dimension), Demographics (gender/blood group/marital status/religion),
  Salary Bands (current basic-salary distribution), Probation & Contract
  Expiry (30/60/90/180/366-day horizon), Birthdays & Anniversaries (month),
  Headcount Movement (monthly joiners vs exits with the exit-date
  convention documented), Recruitment Funnel, Asset Assignment register
  (Wave-2 WP-K data), Field-Force Visit summary (Wave-2 WP-M data).

## 6. WP-F — Balance Sheet (Accounting)

New **Balance Sheet** tab immediately after Trial Balance (tab order:
Vouchers · Chart of Accounts · Trial Balance · Balance Sheet · Ledger ·
Income Statement):

- **`accounting.balanceSheet` route** (perm accounting.view, as-of date):
  prefix-derived sections over every journal-touched account (1xxx assets
  debit-positive · 2xxx liabilities credit-positive · 3xxx equity · 4xxx
  revenue · rest expenses), **Retained Earnings = revenues − expenses** to
  the as-of date, section subtotals + grand totals, and the **A = L + E
  check paisa-exact — a non-zero difference gets its own UNBALANCED row and
  a red banner, never hidden**. POSTED journals only, bounded sweep like the
  other statements.
- The Trial Balance, Balance Sheet and Income Statement all render through
  the shared ReportShell print/export path (flat projections with section
  labels and totals rows; "Export as .xlsx/.csv"; in-app print preview with
  the dotted header/footer layout from WP-E).

---

## Migrations (additive-only)

- `9_wave3_a_voucher_approval_20261008` — AccountJournal status/approval
  columns + status index.
- `9_wave3_b_plan_requests_20261008` — SaasPlanChangeRequest + indexes.

### Migration naming — deliberate deviation from the master prompt

The master prompt suggested timestamp prefixes (`20261009093000_feature`).
**That is unsafe in THIS repo**: Prisma applies migrations alphabetically
and `2026…` sorts between `1_…` and `2_…` — before `5_saas_platform` —
which would re-create the exact P3018 fresh-install bug fixed earlier on
2026-10-08. The wave-3 migrations therefore use `9_wave3_…` prefixes, which
sort after `9_wave2_saas_ops_20261008` under every collation
(`9_wave2_jobs` < `9_wave2_modules` < `9_wave2_saas_ops` < `9_wave3_a_…` <
`9_wave3_b_…`). **Future migrations must keep sorting after
`9_wave3_b_…`** — `9_wave4_…`, `9_wave5_…` etc. are the safe convention
here; a wholesale rename to timestamp prefixes would only be safe if EVERY
historical directory were renamed in the same change.

## New permissions

- Tenant plane: `accounting.approve` (voucher workflow) — granted to
  HR_ADMIN + VENDOR_OWNER templates; `accounting.create` now actually
  granted (was orphaned); `billing.view` extended to HR_MANAGER. All
  editable per role in HR Settings → Roles & Permissions as usual.
- Owner plane: no new permission — the request queue reuses
  `subscriptions.view` (list) and `subscriptions.manage` (decide).

## Files

New: `src/hrm/shared/report-print.tsx` (shared print/export/chart engine),
`src/app/owner/(console)/planchanges/page.tsx`,
`scripts/wave3-smoke.ts` (42-assertion functional smoke suite),
`prisma/migrations/9_wave3_a_voucher_approval_20261008/`,
`prisma/migrations/9_wave3_b_plan_requests_20261008/`.
Extended: accounting src/hrm-server/routes/view (voucher workflow + balance sheet +
statement print), reports src/hrm-server/routes/view (engine + 9 reports), billing routes
(plan-change requests), owner-routes + owner shell (request queue),
subscription view (plan catalog + request flow), cameras view (WP-A),
settings view (WP-D copy), `prisma/schema.prisma`, `src/hrm-server/types.ts`
(role templates).

## After pulling these changes

1. `bun install` (no dependency changes).
2. `bun run db:deploy` (migrations `9_wave3_a_…` + `9_wave3_b_…`). Databases
   that recorded the wave-2 names need nothing extra — these are new
   directories that simply apply next.
3. Restart `bun run dev` once.
4. Grant the new permissions where needed (Roles & Permissions):
   `accounting.approve` for voucher approvers (HR_ADMIN / VENDOR_OWNER get
   it by default on fresh roles), `billing.view` for roles that should see
   the Billing portal / plan catalog (HR managers get it by default).
   Roles stored as DB rows (custom templates created before this wave) keep
   their stored lists — edit them in the UI to add the new verbs.
5. Optional: `DATABASE_URL=… bun run scripts/wave3-smoke.ts` on a TEST
   database to re-verify the workflow end-to-end (it MUTATES data — never
   run it on production).

# Phase 5 — P5 Tenants & Subscriptions (2026-10-22): customer census, renewal calendar rewrite, the panel capstone

The Tenants & Subscriptions slice of the SaaS Owner Panel roadmap, delivered
as P5 on top of the P4 baseline (Phase 4 remediation + P0 observability +
P1 lifecycle & quotas + P2 revenue & collections + P3 growth & engagement +
P4 security & trust). **The capstone: with P5 every surface in the owner
panel is P0-generation or newer.** The Customers and Subscriptions & Billing
groups held the last old-generation pages — Tenants, Subscriptions, Renewals
and Plan Requests all hard-pinned `page:1 / pageSize:100` with no pagination
UI and no KPIs, the plan-change decision flow fired four `alert()`s through
a hand-rolled modal, Plans showed errors via `alert()`, and — worst —
`owner.renewals.list` was the LAST full-table JS-filtered list in the panel
(it loaded EVERY operating subscription with a vendor include, then filtered
windows in memory). **No schema migrations, no new dependencies, no env
changes**; every mutation stays untouched (extend / changePlan / cycle /
grace / suspend / reactivate, plan save/duplicate/toggle, plan-change
approve/reject — all as-is).

## What shipped

### 1. `owner.customers.overview` — the Tenants page KPI strip (NEW)

One round trip, fixed grouped aggregates (tenants.view): tenants total /
active / inactive (one Vendor scan, FILTER clauses), **LEGACY** via the NOT
EXISTS anti-join (1:1 over the vendorId-unique SaaSSubscription — the P0/P1
discipline), trials live now, new signups 7d + 30d, the renewal-window trio
(≤7d / ≤30d / overdue among OPERATING subscriptions, one FILTER-clause scan
using the SAME CEIL day arithmetic the rewritten renewals.list uses — the
numbers can never drift), fleet employees (payroll-scope statuses) + active
portal users, and the **plan options** (id + name of active plans — exactly
what the Tenants page's plan filter needs; the filter had been hardcoded to
ALL since Wave 4).

### 2. `owner.subscriptions.overview` — the Subscriptions-family KPI strip (NEW)

One round trip (subscriptions.view), shared by the Subscriptions / Renewals
/ Plan Requests / Plans pages: the **status mix** from ONE Subscription
groupBy (every status that exists surfaces — the P1 "future statuses still
surface" discipline — with the canonical seven always present, zeros honest,
plus LEGACY from the same anti-join), pending plan-change requests, the
plan census (total / active / public / trial, one FILTER scan), and the
renewal-window trio + operating total (identical arithmetic to
customers.overview — cross-action consistency is test-asserted).

### 3. `owner.renewals.list` — REWRITTEN to the SQL-paged console standard

The last full-table JS-filtered list in the panel is gone. Same action
name, same window enum, same `rows` + `settings` response shape (a
SUPERSET — total / page / pageSize / summary added; the smoke script and
any existing caller keep working):

- **Window semantics IN SQL** — `≤7/≤30/≤60` become
  `endDate >= now() AND CEIL(EXTRACT(EPOCH FROM (endDate - now())) / 86400.0) <= N`
  over the [status, endDate] index; EXPIRED is `endDate < now()`. The CEIL
  arithmetic reproduces the old `Math.ceil` JS semantics exactly (a sub
  ending in 6.5 days reads 7; one that ended 0.5 days ago reads 0) — with
  one deliberate improvement: a just-expired subscription (ended 0.5d ago,
  JS `Math.ceil(-0.5) = -0` which failed the old `< 0` test) now correctly
  lands in the EXPIRED window via the `endDate < now()` comparison.
- **daysRemaining computed IN SQL** on the same expression.
- **Soonest endDate first** (most urgent renewal first; EXPIRED = most
  overdue first), stable id tiebreak.
- **SQL paging** with the standard total/page/pageSize contract.
- **Summary block** — operating / ≤7d / ≤30d / overdue from one
  FILTER-clause scan, so the page's KPI strip is one round trip.
- `RENEWAL_STATUSES` newly exported so future consumers import the
  canonical set (the CADENCE_DAYS discipline from P2).

### 4. REBUILT `/owner/tenants` — the Tenants console

Indigo→violet gradient header, KPI strip (tenant census with LEGACY, new
signups with the 7d/30d split + trials, expiring ≤30d with the ≤7d + overdue
context, fleet workforce), **the plan filter is LIVE** (All / Legacy / every
active plan name — matching the SQL `s."planName"` filter the backend
already had), status + expiring filters, debounced search (Enter commits),
true pagination over the already-SQL-paged `owner.tenants.list` (the Phase 3
SCL-7 rewrite — page-scoped usage, LATERAL admin), 60 s auto-refresh, dark +
light modes.

### 5. REBUILT `/owner/subscriptions` — the Subscriptions console

Sky→cyan gradient header, KPI strip (operating mix with ACTIVE/TRIAL/LEGACY
sub-lines, past-due + grace risk card, expiring ≤30d, pending plan requests
+ plan census), **cycle filter added** (client-side narrowing over the
SQL-paged rows with an honest "N of M on this page" counter), status filter,
search, true pagination over `owner.subscriptions.list` (SQL-paged from
birth; the P0 fix made LEGACY a NOT EXISTS anti-join), 60 s auto-refresh,
dark + light modes.

### 6. REBUILT `/owner/renewals` — the Renewal Calendar console

Teal→emerald gradient header, KPI strip from the response's own summary
(operating, ≤7d, ≤30d, past-end-date with the grace sweep context), the
grace-policy banner (unchanged), **window chips** instead of a Select, the
paged table (soonest first, days-remaining tone-coded, deep-link extend
actions), true pagination, 60 s auto-refresh, and a footnote explaining the
whole-day ceiling arithmetic.

### 7. REBUILT `/owner/planchanges` — the Plan Requests console

Fuchsia→violet gradient header, KPI strip (pending queue, decided all-time,
plan catalog, renewals ≤30d), **the decision flow rebuilt**: the hand-rolled
modal replaced with the shared Dialog component, all four `alert()`s
replaced with self-dismissing inline toasts (approve result, rejection
validation with the min-3-char rule, both failure paths — the P2 zero-alert
discipline), mode chips with up/down arrow icons, status chips + true
pagination over the already-paged `owner.planchangerequests.list`, 60 s
auto-refresh. Approving still runs the REAL
`owner.subscriptions.changePlan` semantics — composed, never forked.

### 8. POLISHED `/owner/plans` — the Plans console

Blue→indigo gradient header, a derived KPI strip (plans total/active, public
on /pricing, trial plans, total subscribers — computed from the loaded
plans array, no extra round trip), the duplicate / toggle paths now show
inline toasts with human context instead of `alert()`, and the plan rows
badge trial plans. The editor dialog was already on the shared Dialog —
unchanged.

## Files

- NEW `src/hrm-server/saas/customers-console.ts` — the two overview actions
  + the rewritten renewals.list (self-registering side-effect module) +
  the exported `RENEWAL_STATUSES`.
- MOD `src/hrm-server/saas/owner-routes.ts` — the OLD renewals.list
  definition removed (replaced by the rewrite; a pointer comment remains).
- MOD `src/app/api/owner/route.ts` — the side-effect import.
- REBUILT `src/app/owner/(console)/tenants/page.tsx`.
- REBUILT `src/app/owner/(console)/subscriptions/page.tsx`.
- REBUILT `src/app/owner/(console)/renewals/page.tsx`.
- REBUILT `src/app/owner/(console)/planchanges/page.tsx`.
- POLISHED `src/app/owner/(console)/plans/page.tsx`.
- NEW `tests/unit/phase5-tenants-subscriptions.test.ts` — 13 tests.

## Tests (13 new)

`tests/unit/phase5-tenants-subscriptions.test.ts`:

- **customers.overview** — tenant census vs full-table DB truth (total /
  active / inactive / trials), LEGACY vs the raw NOT EXISTS anti-join, the
  40d-old-signup exclusion, renewal windows vs an independent JS
  re-computation over the same statuses, planOptions shape + the
  only-active-plans rule.
- **subscriptions.overview** — the status mix vs the database's own groupBy
  (every existing status exact, canonical keys always present, LEGACY =
  the anti-join), pending plan-change requests as an exact DIFF, the plan
  census vs DB truth, and cross-action consistency: both overview actions
  agree on the renewal windows; operating = the mix sum.
- **renewals.list (rewrite)** — window exactness at fractional-day
  boundaries (6.5d in ≤7 / 7.5d out; 29.5d in ≤30 / 30.5d out; 30.5d in
  ≤60), the CEIL arithmetic (6.5→7, 7.5→8, 29.5→30, 30.5→31, just-expired
  −0.5→0, 5.5d-ago→−5), CANCELLED/SUSPENDED never surface, EXPIRED holds
  only past-end rows with most-overdue first, soonest-endDate-first
  ordering, the summary block consistent with every window's total,
  settings shape (grace + reminders), pageSize-2 pagination without
  duplicates. Window membership assertions walk EVERY page (the shared-DB
  immunity discipline — a single pageSize-100 page can cut fixtures off
  when other suites leave operating subscriptions behind; this exact
  failure was caught by the full-gate run and fixed before delivery).
- **planchangerequests.list** — the pagination contract the rebuilt page
  rides: PENDING narrowing in SQL, pageSize-2 walk with no duplicates,
  newest-first ordering.

## Verification (2026-10-22)

- `bunx tsc --noEmit` — 0 errors.
- `bun run lint` — 0 errors (4 pre-existing org-chart warnings).
- `DATABASE_URL=…hrm_test bash scripts/ci.sh` — **ALL 13 STAGES GREEN,
  EXIT 0**: 1429 unit tests (1416 + 13) + 6 perf, zero unexpected
  failures, fresh-database migration smoke clean, zero schema drift, perf
  budgets green.
- `bun run build` — compiles; all five rebuilt pages prerender as static
  routes (`/owner/tenants`, `/owner/subscriptions`, `/owner/renewals`,
  `/owner/planchanges`, `/owner/plans`).

## Hot-apply (existing installs)

Extract over the existing workspace (the overlay convention of every prior
delivery), then restart `bun run dev`. 9 files changed vs P4 —
`customers-console.ts` (NEW), `phase5-tenants-subscriptions.test.ts` (NEW),
the 5 rebuilt pages, the owner-routes.ts renewal-list replacement, and the
route side-effect import. No migrations, no env changes, no new
dependencies.

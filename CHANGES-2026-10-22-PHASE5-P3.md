# Phase 5 — P3 Growth & Engagement (2026-10-22): growth KPIs, usage metering, engagement matrix

The Growth & Engagement slice of the SaaS Owner Panel roadmap, delivered as P3
on top of the P2 baseline (Phase 4 remediation + P0 observability + P1
lifecycle & quotas + P2 revenue & collections). The Analytics page was the
last Wave-4-generation surface in the panel — take:50 capped lists, an
`alert()`-based reminder flow, and a dunning queue superseded by P2's
Collections tab. P3 rebuilds it to the P0/P1/P2 console standard and unlocks
the Phase 4 WS-D `UsageSnapshot` monthly series fleet-wide (previously
reachable only per-tenant through `owner.usage.history`). **No schema
migrations, no new dependencies, no env changes** — everything rides existing
tables (`Vendor`, `SaaSSubscription`, `SaaSSubscriptionEvent`,
`SaaSRegistration`, `LoginAuditLog`, `UsageSnapshot`, `SaaSPayment`) and
indexes; the long-standing `owner.analytics.overview` action stays untouched
and compatible.

## What shipped

### 1. `owner.growth.overview` — growth, revenue, funnel, churn, usage, engagement

One round trip answering EVERY number with a FIXED set of ~17 grouped
aggregates (fleet-size independent — no per-tenant fan-out, no take-capped
lists; the old page seeded take:50 lists into the UI):

- **Growth KPIs** — tenants total / active, new signups 30d + MTD (FILTER
  clauses over one Vendor scan), trials live now, and a 12-month signup
  trend (`date_trunc('month', createdAt)`, UTC) folded into an
  always-twelve-months array ending at the current month (zeros honest).
- **Revenue** — MRR + paying subs + past-due + trials from ONE Subscription
  scan (the established `priceAtCreation` methodology: ACTIVE × snapshot
  price, YEARLY ÷12, TRIAL excluded, unchanged from
  `owner.analytics.overview` / `owner.dashboard.overview`), ARPU
  (MRR ÷ paying subs, null when nothing is paying — never a fabricated 0),
  a plan mix with each plan's subscribers AND MRR contribution (JOIN to
  `SaaSPlan`, MRR-sorted), and failed-payment attempts in 30d.
- **Registration funnel** — applications by status (`SaaSRegistration`
  groupBy); every status that exists surfaces (the P1 "future statuses still
  surface" discipline) with the canonical five always present.
- **Churn** — every lifecycle event type in the trailing 30d
  (`SaaSSubscriptionEvent` groupBy) with cancelled / expired / suspended /
  reactivated counters and the 30-day churn rate
  (cancellations ÷ (paying now + cancelled in window), null when nothing
  was operating).
- **Fleet usage** — LIVE counts of the same five numbers the nightly capture
  writes (employees total, payroll-scope seats, active portal users, enabled
  devices, storage bytes) plus the monthly metering series: the top-two
  distinct `UsageSnapshot` periods (index-driven `GROUP BY … LIMIT 2`), the
  fleet sums for exactly those periods (the MoM delta pair), and a 6-month
  usage trend (payroll seats / portal users / employees / devices / storage
  per month) folded into an always-six-months array ending now.
- **Engagement** — successful tenant-plane logins in 30d, distinct engaged
  tenants (all + active-only with the honest share %), idle ACTIVE tenants
  (active count − engaged-active — never a per-vendor LATERAL fan-out), and
  a 6-week login activity series (`date_trunc('week')`, Monday starts, UTC,
  always six weeks ending at the current one).

### 2. `owner.growth.engagement` — the per-tenant engagement matrix

The login-intensity lens over the fleet, paged in SQL with the tier computed
IN SQL (the `owner.fleet.tenants` discipline — chips and sorts never
materialize the fleet):

- **Tier**: one `CASE` over a login LATERAL (successful TENANT-plane logins:
  30-day count + last-ever timestamp in ONE scan over the `[vendorId,
  createdAt]` index) — **DORMANT** (0 logins in 30d) / **LIGHT** (1–9) /
  **STEADY** (10–49) / **POWER** (50+).
- **Dormant-first ordering** (the actionable end first): DORMANT → LIGHT →
  STEADY → POWER; within a tier most-intense first, then the stalest
  (`COALESCE(daysSinceLogin, 999999) DESC` — a never-logged-in tenant sorts
  ahead of one seen 40 days ago), then name/id for deterministic pagination.
- **Usage seats ride the row from the metering series, never live tables**:
  two `UsageSnapshot` LATERALs (latest period via the `(vendorId,
  periodYear, periodMonth)` unique index; previous period via `OFFSET 1`)
  give `seatsNow` (payroll-scope employees), `seatsPeriod` and the MoM
  `seatsPrev` delta — null (rendered "—", never 0) when a tenant has no
  metering record yet.
- Per-row subscription status + plan name (LEFT JOIN; null → LEGACY chip),
  tier chips (All / Dormant / Light / Steady / Power) as `tier IN (…)` SQL
  filters, and name/code search as SQL WHERE.

### 3. Rebuilt `/owner/analytics` — "Growth & Engagement"

Matching the P0/P1/P2 console design system (gradient-icon page header —
violet→fuchsia TrendingUp, dark + light-mode variants everywhere):

- 4 headline KPI cards (Tenants / MRR with ARPU + paying count / Engaged
  30d with share % + idle / Churn 30d — red only when something actually
  cancelled) with honest sub-lines.
- Three tabs — **Growth** (12-month signup chart in pure CSS bars, the
  plan-mix MRR panel, the 6-tile registration funnel strip, and a churn
  rail with tone-graded event chips + past-due + failed-payment counters,
  deep-linking to the Lifecycle Console and Revenue & Collections), **Usage**
  (5 live-count tiles each with a signed MoM delta chip from the metering
  pair — ▲ emerald / ▼ red / ±0 slate, "metering pending" when no snapshot
  exists; the 6-month payroll-seats-vs-portal-users grouped bar chart; the
  frozen-series methodology note), **Engagement** (the 6-week login
  activity chart, the engagement lens card + tier-definition legend, and
  the matrix: tier chips + search + pagination + per-tenant deep links).
- The old dunning queue is gone (it lives in Revenue & Collections →
  Collections since P2); the page is read-only — zero mutations, zero
  `alert()`s. 60 s auto-refresh of the overview + the active tab.
- Nav: new **Growth & Engagement** sidebar group (Analytics → "Growth &
  Engagement", `tenants.view`) between Subscriptions & Billing and
  Administration.

## Files

- NEW `src/hrm-server/saas/growth-console.ts` (owner.growth.* — 2 actions)
- NEW `tests/unit/phase5-growth-engagement.test.ts` (14 tests)
- REBUILT `src/app/owner/(console)/analytics/page.tsx`
- MOD `src/app/api/owner/route.ts` (side-effect import)
- MOD `src/saas/owner/shell.tsx` (Growth & Engagement nav group)

## Tests (14 new)

`tests/unit/phase5-growth-engagement.test.ts`:

- overview growth: every KPI vs the database's own truth (full-table,
  independently-written Prisma counts with the same filters); the 40d-old
  fixture vendor excluded from new-30d.
- MRR / ARPU / paying / past-due vs an independent JS re-computation over
  the subscription table (MONTHLY + YEARLY ÷12 fixtures, TRIAL 500 and
  PAST_DUE 1000 contributing nothing); the plan-mix split (2 subs / 1000
  MRR vs 1 sub / 1000 MRR).
- signup trend: twelve ascending calendar months ending now, current month
  including the fixtures.
- registration funnel: canonical keys always present, seeded PENDING +
  REJECTED surfacing.
- churn: the 5d CANCELLED counting while the 40d one does not, REACTIVATED
  present, rate sanity (0–100, never null when something is paying), failed
  payments 30d.
- usage: live fleet counts vs full-table Prisma truth (payroll statuses
  matching the nightly capture; RESIGNED excluded; BigInt storage sum);
  the snapshot series vs each period's OWN aggregate truth (immune to other
  suites' rows — the phase4 frozen 2025-06 fixture can never outrank the
  seeded current + previous months); the always-six-months trend contract.
- engagement KPIs: successful TENANT logins counting while failed attempts,
  owner-plane logins and 45d-old rows never do (before/after DIFF); the
  six-week contract.
- matrix: tier exactness at every boundary (0 / 3 / 10 / 20 / 50 / 60
  logins → DORMANT / LIGHT / STEADY / STEADY / POWER / POWER),
  dormant-first with never-logged-in ahead of the 40d-old login, exact
  daysSinceLogin (fractional-day fixture keeps `EXTRACT(DAY)` at 40), the
  subscription + metered seats + period riding the row (legacy tenants
  honestly null), tier chips narrowing IN SQL with no cross-tier leak,
  code-search isolating one row, and pageSize-2 pagination walking all 7
  fixtures with no duplicates.

## Verification (2026-10-22)

- `DATABASE_URL=…hrm_test bash scripts/ci.sh` — **ALL 13 STAGES GREEN,
  1400/1400** (1386 + 14 new; 0 unexpected failures, migrations apply
  cleanly, zero schema drift, perf budgets green)
- `bunx tsc --noEmit` — 0 errors
- `bun run build` — compiles cleanly; `/owner/analytics` prerenders as
  static content
- No migrations, no env changes, no new dependencies

## Hot-apply (existing installs)

Extract over the workspace (same overlay convention as every prior
delivery), or apply just the 5 files listed above and restart
`bun run dev`. The old `/owner/analytics` page and `owner.analytics.overview`
action are fully replaced/superseded but the action remains available for
compatibility.

# Phase 5 — P1 Lifecycle & Quotas (2026-10-22): Lifecycle console, quota matrix, threshold alerts

The Lifecycle & Quotas slice of the SaaS Owner Panel roadmap, delivered as P1
on top of the P0 observability baseline. Baseline: Phase 4 delivery (all 100
audit findings dispositioned) + three post-delivery hotfixes + P0 (fleet
health, performance, alert routing). **No schema migrations, no new
dependencies, no env changes** — everything rides existing tables, indexes
and the P0 settings/alert machinery.

## What shipped

### 1. Lifecycle console (`/owner/lifecycle`) — new page + `owner.lifecycle.*`

The subscription lifecycle on one screen, scale-first:

- **`owner.lifecycle.overview`** (perm `subscriptions.view`) — a FIXED set of
  grouped aggregates (fleet-size independent, the SCL-6 discipline from birth):
  - **Stage cards**: a status `groupBy` + a `NOT EXISTS` anti-join for LEGACY
    tenants — TRIAL / ACTIVE / PAST_DUE / GRACE_PERIOD / EXPIRED / SUSPENDED /
    CANCELLED / LEGACY, each with its honest share-of-fleet percentage. Any
    future status value still surfaces (nothing silently dropped).
  - **Renewal pipeline**: one raw `CASE`-bucket query over the operating
    statuses — OVERDUE (term already ended) / DUE ≤ 7d / 8–30d / 31–60d —
    plus live-trial counters (current + ending ≤ 21d).
  - **Fleet movement**: event-type `groupBy` over `SaaSSubscriptionEvent` in
    two windows (7d / 30d) — the first owner surface reading the append-only
    history ACROSS tenants.
- **`owner.lifecycle.events`** (perm `subscriptions.view`) — the fleet-wide
  lifecycle event stream: JOIN to Vendor for name/code display, paged in SQL
  (`LIMIT/OFFSET` over the wrapped query), type + tenant search filters as SQL
  WHERE conditions, `createdAt DESC` ordering. Never post-filtered in JS.
- UI: gradient-icon header, 8 tone-coded stage KPI cards, a 6-tile pipeline
  strip (red OVERDUE / amber ≤ 7d), the movement chip rail with per-type
  30d + 7d counts, the event stream table with type filter + search +
  pagination, 60 s auto-refresh, deep links into tenant pages. Dark theme +
  light-mode variants, matching the console design system.

### 2. Quota utilization console (`/owner/quotas`) — new page + `owner.quotas.*`

Plan-cap governance across the fleet:

- **`owner.quotas.overview`** (perm `tenants.view`) — ONE round trip: a
  `UNION ALL` of per-key rows folded into ONE row per limit key —
  `{over, near, metered, unlimited}` for all 7 limit keys
  (EMPLOYEES / USERS / BRANCHES / DEPARTMENTS / DEVICES / TRACKING_EMPLOYEES /
  STORAGE) — plus subscribed/LEGACY counts and the alert policy (threshold %,
  enabled) riding the response so the page needs no `settings.view`.
  **Bands** (single source = the SQL): **OVER** = used ≥ cap (the create path
  is already blocked there — no headroom; existing records above cap stay
  usable, never bricked), **NEAR** = ≥ 85% of cap and < cap, **OK** below.
  STORAGE compares the `UsageRollup` read path against
  `COALESCE(override.storageGbOverride, plan.storageGb)` in GB (double math,
  `::bigint` casts on the byte side — int32 overflow was caught and fixed
  during development).
- **`owner.quotas.matrix`** (perm `tenants.view`) — the per-tenant grid. The
  per-row usage numbers AND the worst-quota band are computed IN SQL (7 LATERAL
  counts + the admin LATERAL + a `CASE` across the seven cap comparisons), so
  the band chips filter and worst-first sort never materialize the fleet (the
  `owner.fleet.tenants` discipline). Every cell is `{used, cap}` (STORAGE:
  `{usedBytes, capGb}` with `Number()` at the BigInt boundary — the H-09
  JSON-serialization lesson).
- UI: 4 honest "tenant × quota point" KPI cards (a tenant over on two quotas
  = 2 points — framed exactly), 7 per-quota tiles with over/near/metered/
  unlimited subs, the alert-policy tile (deep-links into Settings), and the
  matrix: band chips (All/Over/Near/OK), search, worst-first table with a
  two-tone micro utilization bar per cell (rose at/above cap, amber ≥ 85%,
  emerald below; ∞ for unlimited legs), pagination, 60 s auto-refresh.

### 3. Quota threshold alerts — new daily pass + settings

- **`checkQuotaThresholds(date)`** in the new `quotas.ts` — wired into
  `platformDailyJobs` (jobs.ts) right after the usage-snapshot capture:
  - ONE set-based query returns ONLY the crossing rows (a `UNION` of per-key
    SELECTs that filters in SQL: cap `IS NOT NULL`, operating statuses only —
    read-only tenants can't grow usage — and `used × 100 ≥ threshold × cap`).
  - **One digest** per run (never per row): a QUOTA_THRESHOLD webhook event
    riding the P0 SSRF-guarded signed-POST machinery + one owner email
    (perm `tenants.view`). Best-effort end to end — a webhook failure never
    masks the email, neither stops the dedupe rows.
  - **Dedupe per (vendor, quota, calendar month)** in `SaaSSetting` group
    "jobs" (`quota-alert:<vendorId>:<key>:<YYYY-MM>`) — the renewal-reminder
    key pattern: a crossing alerts at most once per month; the next month
    re-arms (a fresh nudge without daily spam). Proven in tests: same-date
    rerun fires nothing, next-month rerun fires again.
  - New settings keys (group `alerts`, whitelisted): `quotaAlertsEnabled`
    (master switch, default on) and `quotaThresholdPercent` (default 90,
    clamped to 50–100 at every read site — saving 150 reads as 100, 40 as 50).
    Editable in Settings → Alerts (threshold input + enable toggle).

### 4. Navigation

New **Lifecycle & Quotas** sidebar group (Lifecycle Console — `subscriptions.view`,
Quota Utilization — `tenants.view`) between Observability and Subscriptions & Billing.

## Files

- NEW `src/hrm-server/saas/quotas.ts` (owner.quotas.* + checkQuotaThresholds)
- NEW `src/hrm-server/saas/lifecycle-console.ts` (owner.lifecycle.*)
- NEW `src/app/owner/(console)/lifecycle/page.tsx`
- NEW `src/app/owner/(console)/quotas/page.tsx`
- NEW `tests/unit/phase5-lifecycle-quotas.test.ts` (17 tests)
- MOD `src/hrm-server/jobs.ts` (quota threshold pass in platformDailyJobs)
- MOD `src/hrm-server/saas/settings.ts` (quotaAlertsEnabled + quotaThresholdPercent: type, defaults, whitelist)
- MOD `src/app/api/owner/route.ts` (lifecycle-console + quotas side-effect imports)
- MOD `src/saas/owner/shell.tsx` (Lifecycle & Quotas nav group)
- MOD `src/app/owner/(console)/settings/page.tsx` (Alerts card: threshold + enable)

## Tests (17 new)

`tests/unit/phase5-lifecycle-quotas.test.ts`:

- lifecycle.overview: stage counts vs the subscription table's own truth +
  the LEGACY anti-join; pipeline buckets exact (SQL CASE vs the same bucketing
  in JS — one fixture per bucket incl. an overdue ACTIVE); movement 7d/30d vs
  the event table's own groupBy truth; trial counters vs the table.
- lifecycle.events: pagination walks every row exactly once newest-first
  (no duplicates across pages), type filter narrows with total following,
  search narrows by vendor name and deep-link ids resolve.
- quotas.overview: before/after DIFFS around a fixture set (immune to other
  suites' rows): over at cap, near at 90%, unlimited for null caps — across
  EMPLOYEES / USERS / BRANCHES / STORAGE / TRACKING legs + response invariants
  (7 keys, policy clamp 50–100).
- quotas.matrix: tiers exact (OVER at cap via the no-headroom rule, NEAR at
  90%, OVER via the STORAGE leg alone), worst-first ordering, cell math
  (`{used: 10, cap: 10}` style), unlimited cells (`cap: null`), chip filters
  narrow, pageSize-2 pagination with no duplicates, and a per-tenant storage
  OVERRIDE (5GB vs 1GB plan) un-overds the row while other tenants keep the
  plan cap — proving the COALESCE leg.
- checkQuotaThresholds: crossings at/above threshold with exclusions honored
  (89% below, EXPIRED read-only excluded, unlimited never), webhook SKIPPED
  when unconfigured (never throws), email digest shape, dedupe rows land with
  monthly keys; same-date rerun fires nothing fresh; next-month re-arms;
  master switch off → early return; the configured percentage clamps to
  50–100 at the read site; settings round-trip through the whitelist.

## Verification (2026-10-22)

- `DATABASE_URL=…hrm_test bash scripts/ci.sh` — **ALL 13 STAGES GREEN,
  1370/1370** (1353 + 17 new; 0 unexpected failures, migrations apply cleanly,
  zero schema drift, perf budgets green)
- `bunx tsc --noEmit` clean (the two Map-inference strictness fixes in the
  test file were caught by this stage, not by bun's looser transform)
- `bun run build` — production build compiles cleanly; `/owner/lifecycle` and
  `/owner/quotas` prerender as static content
- During development the gate caught and fixed two raw-SQL defects before
  delivery: a missing `name`/`code` in the matrix count inner-select (search
  referenced columns the wrapper didn't expose) and an int32 overflow in the
  GB→bytes comparison (`int × 1073741824` now `::bigint`)

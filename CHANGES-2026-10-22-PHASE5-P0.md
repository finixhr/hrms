# Phase 5 — P0 Observability (2026-10-22): Fleet Health, Performance panel, alert routing

Scope 4 + Scope 5 of the agreed SaaS Owner Panel roadmap, delivered as P0.
Baseline: Phase 4 delivery (all 100 audit findings dispositioned) + the three
post-delivery hotfixes. **No schema migrations** — everything in this phase
rides existing tables and indexes.

## What shipped

### 1. Fleet Health console (`/owner/fleet`) — new page + `owner.fleet.*`

Per-tenant operational health for the owner, built scale-first:

- **`owner.fleet.overview`** (perm `tenants.view`) — every KPI card answered
  by a FIXED set of ~14 grouped aggregates, fleet-size independent (the
  SCL-6 discipline applied from birth): tenants (total/active/dormant —
  dormant = no successful tenant-plane login in 30d via one indexed
  `COUNT(DISTINCT vendorId)`), workforce, devices online/enabled, storage
  (`SUM(UsageRollup.storageBytes)`), renewals ≤ 30d, failed logins 24h,
  subscription status mix, plus a **backup compliance strip** (last backup
  status/age/size/error, last restore drill + pass, encryption on/off,
  schedule on/off, retention).
- **`owner.fleet.tenants`** (perm `tenants.view`) — the fleet grid, paged in
  SQL. The **health tier is computed IN SQL** (one `CASE` over the
  subscription row + a last-login `LATERAL` over `LoginAuditLog`
  `[vendorId, createdAt]` + an active-employee `LATERAL`), so filtering and
  risk-first sorting by tier never materializes the fleet:
  - **AT_RISK** — subscription EXPIRED / SUSPENDED / PAST_DUE, or the term
    ends ≤ 3 days, or an ACTIVE tenant has zero active employees
  - **DORMANT** — no successful tenant login in 30 days
  - **WATCH** — GRACE_PERIOD, or the term ends ≤ 14 days
  - **HEALTHY** — everything else
  Per-page usage (users / devices / storage) comes from grouped queries
  restricted to the current page's vendorIds (the owner.tenants.list
  discipline). Search matches name / code / admin email (the admin rides a
  first-VENDOR_OWNER LATERAL).
- UI: gradient-icon page header, 8 KPI cards, 4-card backup compliance strip
  with honest tones (green/amber/red), tier filter chips, status select,
  search, risk-first table with animated ping on AT_RISK rows, deep links
  into the tenant detail page, 60 s auto-refresh. Dark theme + light-mode
  variants, matching the console design system.

### 2. Performance panel (`/owner/performance`) — new page + `owner.metrics.snapshot`

- `snapshotForOwner()` in `src/hrm-server/metrics.ts` exposes the in-memory
  RPC rings the Prometheus endpoint already serves: per-module-family
  requests / errors / error rate / p50 / p95 / last / sample ring, plus the
  scheduler-tick gauge (passes, last, p95, vendors/pass, last run time).
  **Zero DB reads** — viewing the panel can never load the database it
  measures; rings are bounded (≤ 256 samples/family, ≤ 64 ticks).
- `owner.metrics.snapshot` (perm `health.view`) is a pure passthrough.
- UI: 4 KPI cards (uptime, requests, errors, slowest p95), tick gauge card,
  families table sorted slowest-first with CSS sparklines (last 40 samples,
  color-coded at the perf-budget §11.1 thresholds), p95 latency bars, error
  rate bars, 15 s auto-refresh, honest "rings reset on restart" framing.

### 3. Scale fix — `owner.subscriptions.list` LEGACY leg (the last F36/F37-class fan-out)

The LEGACY filter used to `vendor.findMany({ include: { saasSubscriptions } })`
— EVERY vendor row materialized with its subscription relation, filtered in
JS, sliced in JS (`page: 1` always). Now a `NOT EXISTS` anti-join over the
vendorId-unique `SaaSSubscription` with `LIMIT/OFFSET` in SQL + a first
-VENDOR_OWNER LATERAL for the admin, search included. Response shape is
unchanged except `page` now reflects the requested page (previously
hardcoded 1).

### 4. Alert routing (webhook) — new settings group + `owner.alerts.testWebhook`

- New `alerts` settings group (webhookUrl / webhookSecret /
  webhookOnBackupFailure) — whitelisted in `SETTINGS_WHITELIST`, defaulted
  empty (disabled), editable in Settings → **Alerts**.
- `sendPlatformAlertWebhook()` in `notify.ts` rides the tenant-webhook
  machinery (`webhooks.ts postSigned`): send-time DNS resolution (DNS
  rebinding to internal addresses blocked), `redirect: "manual"` (3xx is a
  failure, never followed), HMAC-SHA256 signature header when a secret is
  set, hard timeout. Every attempt (SENT/FAILED/SKIPPED) lands in the
  notifications feed + audit log. SKIPPED when no URL is configured —
  never throws.
- `alertBackupFailure` now fires `BACKUP_FAILED` / `RESTORE_DRILL_FAILED`
  events alongside the existing email (suppressed when
  `webhookOnBackupFailure=false`; best-effort — a webhook failure never
  masks the original run error).
- `owner.alerts.testWebhook` (perm `health.manage`) sends a test event
  through the exact real path and audits the attempt. Settings UI: Alert
  Routing card with URL + secret fields, toggle, and a Send-test button
  with inline SENT/FAILED/SKIPPED result.

### 5. Navigation

New **Observability** sidebar group (Fleet Health — `tenants.view`,
Performance — `health.view`) between Customers and Subscriptions & Billing.

## Files

- NEW `src/hrm-server/saas/fleet.ts` (owner.fleet.* actions)
- NEW `src/app/owner/(console)/fleet/page.tsx`
- NEW `src/app/owner/(console)/performance/page.tsx`
- NEW `tests/unit/phase5-fleet-observability.test.ts` (12 tests)
- MOD `src/hrm-server/metrics.ts` (snapshotForOwner export)
- MOD `src/hrm-server/saas/owner-routes.ts` (metrics + alerts actions,
  LEGACY pagination fix)
- MOD `src/hrm-server/saas/settings.ts` (alerts group)
- MOD `src/hrm-server/saas/notify.ts` (sendPlatformAlertWebhook)
- MOD `src/hrm-server/saas/backup.ts` (webhook on backup/drill failure)
- MOD `src/app/api/owner/route.ts` (fleet side-effect import)
- MOD `src/saas/owner/shell.tsx` (Observability nav group)
- MOD `src/app/owner/(console)/settings/page.tsx` (Alerts tab + card)

## Tests (12 new)

`tests/unit/phase5-fleet-observability.test.ts`:

- overview KPIs agree with the database's own truth (same counts, same
  filters) + backup strip reflects seeded DONE/drill rows
- tier derivation exact across 4 fixture tenants (HEALTHY / WATCH via ≤14d
  end date / AT_RISK via EXPIRED / DORMANT via 40d-old login), risk-first
  ordering, tier + search filters narrow in SQL, per-page usage numbers,
  pageSize-2 pagination with no duplicate rows
- LEGACY subscriptions: 3 legacy + 1 subscribed fixture → pages 1+2 at
  pageSize 2 return exactly the legacy set, subscribed never leaks, admin
  LATERAL resolves, search narrows by name
- metrics snapshot: p50/p95 math over a seeded ring ([90,100,120,800] →
  p50 100 / p95 800), error rate 0.25, slowest-first sort, owner action
  passthrough
- alert webhook: SKIPPED when unconfigured (never throws), URL round-trips
  through settings.save, test action audits its attempt,
  webhookOnBackupFailure=false suppression contract

## Verification (2026-10-22)

- `bash scripts/ci.sh` — **ALL 13 STAGES GREEN, 1353/1353** (1341 + 12 new;
  0 unexpected failures, migrations apply cleanly, zero schema drift, perf
  budgets green)
- `bun run build` — production build compiles cleanly; `/owner/fleet` and
  `/owner/performance` prerender as static content
- No migrations, no env changes, no new dependencies

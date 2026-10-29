# Phase 3 — Platform Scale & Mobile v1.1 (2026-10-22)

Phase 3 of the 2026-10 codebase audit remediation (report: *Finix HR — Complete
Codebase Audit & Performance Optimization*, Section 10, Table 14). Built on top
of the Phase 1 + Phase 2 deliverables; the full 12-stage CI gate
(`scripts/ci.sh`) passes: **1287 unit tests green (53 new), tsc clean, lint
clean, fresh-database migration smoke green, zero schema drift.**

Functional-compatibility constraint preserved throughout: no user-visible
behavior changed except where a finding documented a defect. The v1 API keeps
its existing page/pageSize contract (cursor mode is opt-in), the owner console
payloads keep their field-for-field shapes, and campaign/webhook semantics are
settle-compatible with in-flight rows.

---

## WS-A — Owner console scale (SCL-6, SCL-7, SCL-13, OPS-7, OPS-8)

**SCL-6 · `owner.dashboard.overview` set-based rollups** — the handler fanned
out `usageSnapshot` per vendor (7 queries × N tenants) plus full-table
vendor/subscription/registration loads (>700K queries per dashboard load at
100K tenants; the console died at ~1-2K tenants). Rewritten as a FIXED set of
~25 grouped SQL aggregates — identical response fields and math, fleet-size
independent: `COUNT(DISTINCT vendorId)` for subscribed, SQL `SUM` MRR, one
`groupBy` each for plan/status distribution, a single LEFT-JOIN GROUP BY for
employees-by-plan, one `FILTER`-aggregation for feature adoption, and
`date_trunc('month', …)` buckets for the growth chart.
[`src/hrm-server/saas/owner-routes.ts`]

**SCL-7 · `owner.tenants.list` DB-level search/filter/pagination** — was:
load EVERY vendor (with subscription include) + every owner user +
`resolveEntitlements` + `usageSnapshot` PER VENDOR, then filter/paginate the
materialized array in JS. Now: one parameterized SQL query (WHERE / ORDER BY /
LIMIT+OFFSET, LATERAL first-VENDOR_OWNER join for the admin), a COUNT twin for
totals, per-page usage answered by 7 grouped queries restricted to the page's
vendorIds, and entitlements per page row only. All filter values ride as `$n`
placeholders — request data is never interpolated into SQL text.
[`src/hrm-server/saas/owner-routes.ts`]

**SCL-13 · lifecycle sweep windowed queries** — was: load EVERY
TRIAL/ACTIVE/PAST_DUE/GRACE/EXPIRED subscription + one invoice findFirst per
ended sub + per-sub dedupe lookups. Now: only subscriptions whose endDate is
inside the reminder/post-expiry horizons can transition or notify, so the load
is windowed; covering-invoice lookups and the reminder/post-expiry dedupe
reads are batched into three IN queries up front. Same transitions, same
notices, `checked` now counts the rows actually examined.
[`src/hrm-server/saas/lifecycle-sweep.ts`]

**OPS-7 · analytics MRR is a true SQL SUM** — the `take: 500` read made MRR
silently wrong beyond 500 subscriptions. Now a single `SUM(CASE …)` over the
entire ACTIVE set, plan-distribution subscribers via `groupBy`, the 12-month
signup trend via SQL month buckets (no take), and idle-tenant detection as one
grouped LEFT JOIN query with the cutoff and LIMIT in the database (was: every
vendor + a groupBy over all audit rows, filtered/sorted in JS).
[`src/hrm-server/saas/owner-routes.ts`]

**OPS-8 · `owner.invoices.markPaid` routes through the settle renewal path** —
the manual PENDING→PAID flip never extended a term-linked subscription, so a
bank-transfer-paying tenant stayed read-only up to 24 h until the daily
sweep's paid-term catch-up. The handler now calls the same
`renewSubscription` the gateway settle flow uses (EXTENDED event, entitlement
invalidation, `extended` flag in the response and the `invoice.paid` webhook).
A CANCELLED/SUSPENDED subscription records the payment and a warning instead
of failing. [`src/hrm-server/saas/owner-routes.ts`]

## WS-B — Multi-instance readiness (SCL-21)

**New module `src/hrm-server/coordination.ts`** — distributed locks and rate
buckets with two backends: Redis (`REDIS_URL`, SET NX PX + compare-and-del
release; INCR+EXPIRE buckets) preferred, Postgres (`CoordinationLock` rows,
conditional-update claims — atomic) always available. Every Redis call is
wrapped: on failure the module degrades to the fallback for 60 s instead of
failing requests. Redis stays deliberately confined to locks/buckets/cache —
the BgJob queue semantics (priority lanes, dead-letter, recovery) stay in
Postgres.

- **Cluster-wide scheduler tick lock** — `runTick()` acquires
  `scheduler:tick` (TTL = tick interval + 60 s): behind a load balancer,
  exactly ONE instance ticks; the others skip cleanly. The in-process `ticking`
  guard is retained as the fast path (and is correctly reset when the
  distributed lock is unavailable). [`src/hrm-server/jobs.ts`]
- **Distributed rate buckets** — the tracking-ingestion limiter
  (`rate-limit.ts`) grows an async twin `rateLimitDistributed()` that prefers
  the Redis bucket; the selfie/visit-photo/location guards in
  `routes/attendance.ts`, `routes/fieldforce.ts`, `routes/tracking.ts` use it.
  Single-instance deployments keep the previous in-memory behavior.
- **Once-per-period claims** — `claimPeriodAction()` closes the two-instance
  double-submit window on the nightly scheduled backup (see WS-C).
- Migration `9_wave9zi_coordination_tokens_bounce_20261022` adds the
  `CoordinationLock` table.

## WS-C — Backup & readiness (OPS-1, OPS-2, OPS-3)

- **OPS-2 · `pg_dump --format=custom`** — PostgreSQL dumps are now
  self-compressed by pg_dump itself; the in-process fflate gzip (which blocked
  the event loop on every 4 MB chunk, stalling ALL http traffic during a
  backup) is gone from the PostgreSQL path (the SQLite dev flavor keeps it).
  Artifacts: `hrm-<stamp>.dump` / `.db.gz`, plus `.enc` variants.
  [`src/hrm-server/saas/backup.ts`]
- **OPS-1 · at-rest encryption** — when `HRM_BACKUP_KEY` is set, artifacts are
  AES-256-CBC encrypted (PBKDF2-SHA256, 150k iterations, 16B salt + 16B IV
  header, streaming — the same key `scripts/backup.sh` uses). Without a key
  the run row and report record `encrypted: false` explicitly. The restore
  drill understands EVERY artifact flavor this engine ever wrote:
  `.dump[.enc]` (pg_restore), `.sql.gz[.enc]` (legacy plain SQL), `.db.gz[.enc]`
  (SQLite).
- **OPS-1 · replica-sourced dumps** — `HRM_BACKUP_SOURCE_URL` points the dump
  at a read replica; everything else keeps using `DATABASE_URL`.
- **OPS-3 · long-job exclusion from /readyz** — `BACKUP_PG_DUMP` and
  `RESTORE_DRILL` no longer count as stale RUNNING jobs: a legitimate >10-min
  backup no longer flips the container NOT READY (which under Docker's 30 s
  healthcheck restarted the instance MID-BACKUP). Genuinely stuck ordinary
  jobs still drain the LB pool. [`src/app/api/readyz/route.ts`]
- **Zero-traffic backup days fixed (OPS-9 root cause)** — the nightly in-app
  backup used to fire only on owner-console traffic; the tick now drives
  `maybeRunScheduledBackup()` (internally guarded: enabled · past schedule ·
  none ran today · none in flight · 60 s throttle · cluster-wide per-day claim
  via WS-B).

## WS-D — Mobile v1.1 (MOB-1 … MOB-6)

- **MOB-1 · `/api/v1/auth/token`** — OAuth2-shaped password + refresh grants
  riding the EXISTING session machinery. Password grants flow through the
  same `login()` path as the web app (lockout, password expiry, forced
  rotation, MFA — any PREAUTH outcome refuses the grant); a FULL Session is
  created and a 15-min HS256 access JWT (HKDF-derived from `HRM_MFA_KEY`,
  context `api-jwt::v1`) is bound to it. Refresh tokens are opaque
  (`fkr_…`), sha256-at-rest (`ApiRefreshToken` table), 30-day, and rotate
  per-family — **reuse of a rotated token revokes the whole family and the
  backing session**. Only roles carrying `integrations.view` (the API-key
  administration capability) may mint user tokens; ESS employees cannot.
  [`src/app/api/v1/_tokens.ts`, `src/app/api/v1/auth/token/route.ts`]
- **MOB-1 · unified authenticator** — `authenticateRequest()` accepts BOTH
  credentials: `Bearer fk_…` (tenant API key, unchanged) and `Bearer eyJ…`
  (user JWT: signature + expiry, session re-read every request — revocation is
  a session delete — user status re-read, scope check against the token's
  granted set, same entitlement gate, 120 req/min per-user throttle). All five
  v1 routes switched to it. [`src/app/api/v1/_auth.ts`]
- **MOB-2/3 · cursor pagination** — new `?cursor=` keyset mode on employees
  (createdAt, id) and attendance (date, createdAt, id): `meta.nextCursor` +
  `hasMore`, no overlap, stable across writes, malformed cursors degrade to a
  fresh first page. Page/pageSize mode is byte-for-byte unchanged. The
  attendance `truncated` flag now tells the truth in both modes.
  [`src/app/api/v1/_page.ts`, `src/app/api/v1/employees/route.ts`,
  `src/app/api/v1/attendance/route.ts`]
- **MOB-4 · read-audit sampling** — v1 GETs write an `API_V1_REQUEST` audit
  row only at `HRM_API_AUDIT_SAMPLE_RATE` (default 0.1); writes are always
  audited. Kills the audit explosion under app polling.
- **MOB-5 · page-scoped decoration** — branch/department/designation/manager
  names resolve only the ids on the current page (was: whole-org id/name loads
  per request). Response shape unchanged.
- **MOB-6 · delta sync + ETag** — `?updatedSince=ISO` filters `updatedAt` on
  employees / attendance / leave-balances; every list response carries a weak
  ETag and honors `If-None-Match` with a 304.
- **MOB-6 · OpenAPI 3.1 contract + generated client** —
  `src/api-contract/openapi-v1.ts` (served at `GET /api/v1/openapi.json`),
  `scripts/gen-api-client.ts` → `src/api-client/index.ts` (typed client with
  `passwordGrant`/`refresh`, per-operation methods, `listAllEmployees()`
  delta-sync walker). The contract test fails CI if spec, routes and client
  drift apart.

## WS-E — Webhooks & campaigns (SEC-6, OPS-5)

- **SEC-6 · DNS-resolving SSRF guard** — `resolveOutboundUrl()` runs every
  string check and then RESOLVES the hostname, rejecting when ANY resolved
  address is private (v4 or v6 — the new `isPrivateIpv6` covers loopback,
  unspecified, fc00::/7 ULA, fe80::/10, IPv4-mapped). Applied at webhook SEND
  time (catches post-save DNS rebinding) and at `integrations.webhooks.save`.
  Webhook sends use `redirect: "manual"` — a 3xx is a failure, never
  followed. [`src/hrm-server/security.ts`, `src/hrm-server/webhooks.ts`,
  `src/hrm-server/routes/integrations.ts`]
- **OPS-5 · webhook delivery scale** — the flush pass drains up to 60 due
  deliveries through an 8-worker concurrent pool (was 20 strictly sequential
  per minute ≈ 28.8K/day — an unbounded backlog at 100K tenants);
  per-endpoint politeness cap unchanged. A daily dead-letter sweep fails
  PENDING deliveries older than `HRM_WEBHOOK_BACKLOG_DAYS` (default 7).
- **OPS-5 · campaign engine: chunked, resumable, bounce-aware** —
  `deliverCampaign` processes at most `HRM_CAMPAIGN_BATCH` (default 200)
  recipients per pass and yields the event loop between chunks; SENDING
  campaigns re-enter freely (a crash mid-run no longer strands every remaining
  recipient — `dispatchDueCampaigns` resumes them on the next tick); recipient
  journaling is set-based (`createMany` + skipDuplicates); failed sends upsert
  a `CampaignBounce` row and addresses at 3+ bounces are suppressed (journaled
  SKIPPED — deleting the row re-enables); final status/counts are computed
  table-wide so resumed campaigns report true totals; a per-campaign
  distributed lock makes concurrent manual + tick sends single-flight.
  [`src/hrm-server/saas/communication.ts`]

## Fixtures & time-rot repair (carried into this phase)

`LVE-002 carried-forward days` (tests/unit/r3-4-wave-leave-loan-attendance)
was a date-pinned fixture whose hardcoded window (2026-10-13..27) aged out of
the 7-day backdate policy — the apply began returning 403 on 2026-10-22. Same
repair pattern as the Phase 1 LVE-001 fix: dates are now derived from the
calendar (next-week Wednesday anchor, strictly-future, single leave-year).

## Tests added (all fail on the pre-Phase-3 code)

| Suite | Covers |
|---|---|
| `tests/unit/phase3-wsa-console.test.ts` | SCL-6 rollup correctness · SCL-7 DB-level list (search incl. admin email, plan/legacy, expiring, pagination, injection probe) · OPS-7 MRR over 505 subscriptions · OPS-8 markPaid extension + idempotence · SCL-13 windowed sweep |
| `tests/unit/phase3-wsb-coordination.test.ts` | lock acquire/refuse/release · expiry takeover · stranger-release no-op · wrapper finally-release · period claims · cluster-wide tick lock · CoordinationLock rows |
| `tests/unit/phase3-wsc-backup.test.ts` | AES round-trip + wrong key + header guard · flavor router · readyz long-job exclusion (backup/drill ready, ordinary stale job drains) |
| `tests/unit/phase3-wsd-mobile.test.ts` | password grant/refresh/reuse-revocation/session-kill · scope enforcement · cursor walking · updatedSince · ETag 304 · audit sampling · page-scoped decoration |
| `tests/unit/phase3-wse-ssrf-campaign.test.ts` | IPv6 private space · literal + DNS-resolved rebinding (nip.io / localtest.me) · redirect refusal (fetch stub) end-to-end · webhook dead-letter · campaign resume/bounce/single-flight/tick-resume |
| `tests/unit/phase3-wsd-openapi.test.ts` | spec ↔ route files ↔ generated client ↔ scope catalog · openapi.json serving · client cursor walker |

## Operational notes

- New env (all optional, defaults preserve single-instance behavior):
  `REDIS_URL`, `HRM_BACKUP_SOURCE_URL`, `HRM_WEBHOOK_BACKLOG_DAYS`,
  `HRM_CAMPAIGN_BATCH`, `HRM_API_AUDIT_SAMPLE_RATE`, `HRM_API_ACCESS_TTL_SEC`,
  `HRM_API_REFRESH_TTL_DAYS` — documented in `.env.example`.
- New migration (additive, three tables):
  `prisma/migrations/9_wave9zi_coordination_tokens_bounce_20261022`.
- Deployment recipe for the 2-node soak (exit criterion): set `REDIS_URL` on
  both instances, `HRM_DEPLOYMENT_MODE=multi`, run `DATABASE_URL=<primary>
  bun run scripts/ci.sh` once, then point the LB at both nodes — the tick
  lock and per-day claims are the duplicate-work proofs.

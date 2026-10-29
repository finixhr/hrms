# Finix HR — Scalability & Capacity Runbook (Wave 11, 2026-10-26)

**Scope:** the architecture, configuration and measurement plan backing the
enterprise-scalability master prompt (§1–§5, §13, §15). This document is the
operational companion to `DEPLOYMENT-GUIDE.md` — that file gets a single node
running; THIS file is how the deployment grows to the 100,000-tenant target.

> **The honesty rule (§15):** nothing in this document claims the 100K-tenant
> capacity has been *achieved*. §1 defines the model, §8 defines the
> instruments (k6), and §9 states exactly what is measured vs. projected. The
> platform is *built* for horizontal scale; capacity is *proven* by running the
> load kit on production-like hardware and recording the numbers.

---

## §1 — Capacity model for 100,000 tenants (assumptions to validate)

All numbers below are **modeling inputs** for sizing the architecture and for
parameterizing the load tests. They are deliberately conservative; replace them
with your own telemetry once the platform is live (the `/api/metrics` family
was built for exactly that).

### 1.1 Fleet shape

| Parameter | Assumption | Rationale |
|---|---|---|
| Registered tenants | 100,000 | target |
| Tenants active on a given day | 30% (30,000) | long tail of small workspaces is dormant most days |
| Tenant size mix | 90% ≤25 employees · 9% ≤200 · 1% ≤2,000 | typical SMB HRM distribution |
| Employee records (fleet) | ≈ 3.0M | 100K × ~30 average |
| Users with login access | ≈ 1.2M (40% of employees) | ESS accounts + managers |
| Average record size | ~2 KB/employee; ~150 B/attendance event | schema payload columns |

### 1.2 Traffic model (normal / peak / stress)

| Workload | Normal | Daily peak | Stress (3× peak) |
|---|---|---|---|
| Human RPC sessions | 180K DAU sessions/day | 27K concurrent (peak-hour) | 80K concurrent |
| Tenant RPC rate (auth.me, lists, dashboards, billing, support) | ~50 RPS | **~150 RPS** | **~450 RPS** |
| Employee search rate | ~10 RPS | ~25 RPS | ~75 RPS |
| Device punch ingestion (ATTLOG) | ~5/s | **~50/s** (2×2h punch windows) | ~150/s |
| ESS geo/selfie punches | ~2/s | ~20/s | ~60/s |
| Payroll runs | scattered | ~2K tenant-runs in the last 3 days of the month | batch window x3 |
| Scheduled reports / emails | night hours | 30K tenant jobs/day | backlog replay |
| Read : write ratio | 85 : 15 | 80 : 20 during punch windows | — |

Peak combined application load ≈ **600–800 RPS** (450 tenant RPC + 150 device
+ headroom). At the measured single-instance throughput (see §8) this maps to
**3–6 stateless app instances** behind the load balancer — that is the first
scaling rung, not a rewrite.

### 1.3 Data growth (bounded by retention sweeps)

| Stream | Growth estimate | Bounded by |
|---|---|---|
| AttendanceEvent | ~660M rows/yr fleet-wide at full load | archival plan (§5.4) |
| AttendanceRawEvent (device plane) | ~1.8M/day peak | sweeper processes → DEAD_LETTER/OUT_OF_WINDOW; retention purge |
| Tracking points + selfie proofs | ~150M points/yr | existing retention sweeps (`sweepTrackingRetention`, `sweepProofRetention`, ADMS photo retention days) |
| Login/audit logs | ~5M rows/yr | 180-day purge (tenant) / 180-day (owner) sweeps already in the tick |
| Tenant documents (storage) | quota-capped per plan | UsageRollup reconciliation + server-side quota enforcement |

### 1.4 SLOs (starting gates — re-baseline after load testing)

| Surface | SLO |
|---|---|
| Tenant RPC latency | p50 < 300 ms · p95 < 800 ms · p99 < 2 s |
| Device punch ack | p95 < 300 ms (fast-ack, processing is async) |
| Error rate | < 1% (5xx), < 0.1% on payment surfaces |
| Availability | 99.9% monthly (≈ 43 min budget) |
| Scheduler tick | tick p95 < 25 s (never exceeds the tick budget) |
| BgJob backlog | recovers to < 100 pending within 15 min after a burst |
| Outbox | `hrm_outbox_failed` == 0 (any dead-letter pages) |
| Payment settlement | replay-safe; receipt delivered ≤ 60 s after commit (fast path) |

---

## §2 — Horizontal scaling (stateless app + load balancer)

### 2.1 The statelessness contract (already enforced by the code)

Every piece of shared state lives OUTSIDE the app process, so any instance is
interchangeable:

| State | Lives in | Notes |
|---|---|---|
| Sessions (tenant, owner, support) | PostgreSQL (`UserSession` etc.) | DB-backed, token-hash lookup (wave9zm) — no sticky sessions needed |
| Background jobs | PostgreSQL `BgJob` | priority lanes, dead-letter, `recoverStaleBgJobs` on restart |
| Transactional outbox | PostgreSQL `OutboxEvent` (Wave 11) | `FOR UPDATE SKIP LOCKED` claims — any instance may relay |
| Scheduler single-flight | Redis/PG lock `scheduler:tick` (SCL-21) | exactly one instance ticks per interval |
| Daily one-shots (backup, reconciliation) | `claimPeriodAction` TTL claims | idempotent across instances |
| Rate buckets | Redis (fixed window) with in-process fallback | cluster-wide counting when Redis is up |
| Entitlements / tenant metadata | L1 process memo (10 s) + **L2 Redis (Wave 11)** + Postgres authoritative | see §4 |
| In-process rings/counts (metrics) | per-instance | scrape every instance behind the LB and sum |

Scaling out is therefore: **add instance → point DNS/LB at it → done**.

### 2.2 Load balancer

- **Reference config:** `deploy/Caddyfile.lb` — N upstream instances, active
  health checks against `/api/readyz`, `least_conn` for the human plane,
  `first_available` for the device plane (keeps terminal connections warm),
  bounded retry window (`lb_try_duration`) so a rolling restart sheds no
  requests.
- **Health endpoints:** `/api/health` (liveness — process up) and
  `/api/readyz` (readiness — DB reachable, migrations applied). Wire the LB to
  `readyz`; wire systemd/restart policy to `health`.
- **Graceful deploys:** the app installs SIGTERM/SIGINT handlers (HIGH-4), drains
  in-flight requests and BgJob claims for up to 30 s, and refuses new scheduler
  claims while draining. Combine with the LB's `fail_duration` +
  `lb_try_duration` for zero-downtime rolling restarts.
- **Unhealthy instance replacement:** Caddy drops a peer after 3 failed probes
  (10 s interval) and re-adds automatically; systemd `Restart=always` (see
  `deploy/hrm.service`) rebuilds the process.
- **Overload behavior:** the RPC dispatcher applies per-identity throttle
  buckets and the device plane rate-limits per SN; the LB adds no artificial
  concurrency limit, so overload surfaces as controlled 429s — never a crash.
- **Connection/timeouts:** 25 MB body cap for the human plane, 3 MB for the
  device plane, 120 s upstream response timeout (payroll/report headroom) —
  mirrored from the single-node `deploy/Caddyfile`.

### 2.3 Rolling out N instances (operational recipe)

```bash
# 1) Shared state is already external — set the Redis URL on every instance:
#    REDIS_URL=redis://:secret@redis-host:6379/0
# 2) Start additional instances (systemd template unit or compose --scale app=3)
# 3) Swap the edge to the LB config:
caddy run --config deploy/Caddyfile.lb
# 4) Watch for one full scheduler interval: /api/metrics on each instance must
#    show hrm_jobs_tick_total advancing on exactly ONE instance at a time
#    (the distributed tick lock working), and hrm_cache_backend == 1 everywhere.
```

---

## §3 — CDN & static asset delivery

### 3.1 What MAY be cached at the edge

| Content | Cache policy |
|---|---|
| `/_next/static/*` | **immutable**, `max-age=31536000` — content-hashed filenames; safe forever |
| `/favicon.ico`, `/icon-*.png`, `/logo.svg`, `/manifest.webmanifest` | `max-age=31536000` (re-deploy purges by filename hash for icons; logo re-check monthly) |
| Public marketing pages (`/`, `/pricing`, `/features/*`, `/careers`) — anonymous HTML | edge cache 5 min + revalidate; pages are CMS-driven and hot-reloaded |
| Public website fonts/CSS/JS bundles | ride the `/_next/static` immutable rule |

`deploy/Caddyfile.lb` already emits the immutable header for the asset paths so
a CDN in front inherits cacheability without guesswork.

### 3.2 What must NEVER be cached (hard rules)

- **Anything under `/app` (tenant HRM)** — it is a session-bound SPA; HTML is
  thin but responses carry `Cache-Control: no-store` semantics. Do not create
  a CDN rule that matches it.
- **`/api/*` responses** — tenant-scoped data, owner console, device plane.
  All POST anyway; CDN must be set to bypass `/api/*` entirely.
- **`/iclock/*` (device plane)** — terminal pushes with comm-key auth; caching
  a response and replaying it to another device would corrupt ingestion.
- **Payment return/IPN paths** — transient, session and replay protected.
- **Employee photos, documents, selfie proofs, payroll exports** — served via
  authenticated routes / signed URLs; CDN must not cache them (signed URLs are
  unique per request anyway, which naturally defeats edge caching).

### 3.3 Cloudflare reference (or equivalent)

- Proxy the site (orange cloud), cache level *Standard*, **Bypass cache for
  `/api/*`, `/iclock/*`, `/app`, `/owner`** via a cache rule.
- Upload `max_size` alignment: Cloudflare free tier caps uploads at 100 MB —
  the app's own caps (25 MB / 3 MB) sit far below; no action needed.
- Enable Brotli + HTTP/3; the app already sends HSTS/nosniff at origin.
- Purge on CMS changes is unnecessary (5-min TTL); purge on *deployment* only
  if you change non-hashed public assets (icons/logo).

---

## §4 — Redis (shared cache, locks, rate buckets)

Zero new application dependencies: the client is **Bun's built-in**
(`Bun.redis`, bound to `REDIS_URL`). Under the Node runtime (or when
`REDIS_URL` is unset) every consumer degrades gracefully to its
Postgres/in-process fallback — Redis is an accelerator, never a dependency.

### 4.1 Usage inventory + TTL contract

| Consumer | Keys | TTL | Invalidation |
|---|---|---|---|
| Distributed locks (coordination.ts) | `lock:*` | lock TTL (≤ tick+60 s) | released on completion; TTL bounds crashes |
| Cluster rate buckets | `rl:*` | 1 window | natural expiry |
| Periodic one-shots | `lock:period:*` | until period end | TTL *is* the claim |
| **Entitlements L2 (Wave 11, cache.ts)** | `hrm:c1:ent:<vendorId>` | **10 s — identical to the in-process memo** | `invalidateEntitlements()` issues a cluster-wide `DEL` on every subscription change (settlement, plan change, suspension, override save, provisioning) |

**The never-stale-grant rule (§2 of the prompt):** the L2 serves the exact same
10-second window the per-process memo always had — a longer TTL is forbidden at
the call site (`resolveEntitlements` passes `MEMO_TTL_MS / 1000`). Financial
and subscription truth is read from PostgreSQL inside the settle/provision
transactions; the cache only mirrors the re-derivable projection. When Redis is
down, the module marks it dead for 60 s and serves Postgres reads directly.

### 4.2 Sizing & failure

- Working set: one `ent:` entry ≈ 1–2 KB × active vendors per 10 s → **≤ 256 MB
  covers ~100K active vendors with room**; compose ships `maxmemory 256mb,
  allkeys-lru` (cache keys are pure cache — eviction is always safe).
- Persistence: AOF (`appendonly yes`) is enough; this Redis holds no
  authoritative state. Losing it costs one DB resolve per active vendor.
- Monitoring: `hrm_cache_backend` (1 = Redis reachable), `hrm_cache_hits_total`
  / `misses_total` / `errors_total` on `/api/metrics`; alert when `backend`
  reads 0 for > 5 minutes on a deployment where Redis is configured.

---

## §5 — PostgreSQL at scale

### 5.1 Already in place (audit summary — do not redo)

- Composite/partial indexes for every hot query family, including: session
  expiry lookups, device sweep scans (vendor+time), attendance raw-event
  sweeper + vendor indexes, employee trigram search, payment replay
  (`provider_providerTxnId` unique), support queues, usage rollups.
- Server-side pagination with hard ceilings everywhere lists exist
  (`take ≤ 1000` pattern), selective field retrieval (`_EMPLOYEE_SELECT`),
  and the SCL-1 due-vendor discovery (the tick asks the DB which of 100K
  vendors is DUE, in bounded batches behind a round-robin cursor, inside a
  wall-clock budget).
- N+1 eliminations documented across prior waves: batched account-map
  lookups, `decorate()` batching, aggregate CTEs (`reconcileStorageRollups`
  is ONE set-based statement for the whole fleet).
- Money correctness: paisa-integer columns (BigInt) with golden payslip tests.

### 5.2 Connections & PgBouncer

PostgreSQL backends are the scarcest resource under horizontal scaling:
`instances × Prisma connection pool` must stay below `max_connections` minus
headroom for migrations/ops.

1. Set the pool per instance: `?connection_limit=8` in `DATABASE_URL` (the
   app is mostly request-bound; 8 conns/instance ≈ 48 server conns at 6
   instances).
2. Put **PgBouncer** in front (`deploy/pgbouncer/pgbouncer.ini`,
   `pool_mode=transaction`, `default_pool_size=20`): the DB then sees ~20–40
   server backends regardless of instance count, and `max_client_conn=400`
   absorbs connection churn.
3. Prisma through PgBouncer: append `?pgbouncer=true&connection_limit=8`
   (disables the prepared-statement caching that transaction pooling cannot
   honor; `max_prepared_statements=0` is pre-set in the shipped ini).
4. Migrations always connect DIRECTLY to :5432, never through the pool.
5. Monitoring: `pg_stat_activity` saturation, `query_wait_timeout` errors in
   the PgBouncer log, and the DB gauges on `/api/metrics`.

### 5.3 Read replicas (only where consistency allows)

| Query family | Replicas allowed? |
|---|---|
| Dashboards, analytics, report reads | Yes, with a documented ≤1 s lag budget |
| Employee directory / search | Yes (≤1 s lag) |
| Attendance summary for past days | Yes |
| **Entitlement resolution** | **No — always primary** (authorization must never read stale) |
| **Payment/subscription/settlement** | **No — primary only**, inside the settle transaction |
| Payroll computation reads | No (correctness over latency) |
| Device ingestion | No (dedupe/idempotency windows must see the freshest rows) |

Route by splitting Prisma clients: a second client pointed at the replica
DSN, used only by the read families listed as replica-safe. Introduce this
AFTER measured primary saturation — not preemptively.

### 5.4 Partitioning & archival for the attendance firehose

`AttendanceRawEvent`/`AttendanceEvent` are the only tables with fleet-scale
row counts (§1.3). Partitioning is **on the roadmap, not preemptive** — the
prompt's rule: only when measured growth and query patterns justify it.

- **Trigger thresholds:** monthly RANGE partitions when a table exceeds
  ~50M rows AND `pg_stat_user_tables.seq_scan` shows the sweeper/aggregation
  scans reading cold months, or vacuum cost becomes visible in
  `pg_stat_progress_vacuum`.
- **Plan (execute in a maintenance window, all additive):**
  1. `CREATE TABLE AttendanceEvent_2026_11 (LIKE AttendanceEvent INCLUDING ALL)`
     per month going forward; parent becomes a view over children (or use
  native declarative partitioning via a new-table migration).
  2. Adopt `pg_partman` for automatic monthly partition creation + drop of
     partitions older than the retention horizon.
  3. Backfill in batches (`ORDER BY createdAt` slices ≤ 1M rows) during
     low-traffic windows; each batch is a single transaction.
  4. The existing query paths already filter by `vendorId + date`, so
     partition pruning is effective without query rewrites.
- **Archival policy:** aggregate month-old raw events into the existing
  summary tables, then DROP (not DELETE) old partitions — instant space
  reclaim, no bloat. Retention sweeps already bound tracking points, selfie
  proofs, ADMS photos and login/audit logs; the same policy extends to raw
  punches once the trigger threshold arrives.

### 5.5 Vacuum, bloat, maintenance

- Autovacuum defaults suffice at first; review `autovacuum_vacuum_scale_factor`
  (0.05) on the punch tables once they pass 10M rows.
- `pg_dump` nightly via `deploy/backup.service` is unchanged; partitioned
  tables back up per-partition faster (exclude cold partitions if needed).

---

## §6 — Background processing & the transactional outbox (§4 of the prompt)

### 6.1 The two durable lanes (both in PostgreSQL — no second database yet)

| Lane | Table | Claim mechanism | Retry policy | Dead-letter |
|---|---|---|---|---|
| Fan-out jobs (emails to 1K recipients, payslip emailAll, exports, camera sweeps) | `BgJob` | priority scan + conditional claim; `recoverStaleBgJobs` resets stale RUNNING | per-job `attempts`/`maxAttempts` (WP-A) | `DEAD` status |
| Critical side effects (receipt emails, invoice.paid webhooks — Wave 11) | `OutboxEvent` | `UPDATE … SELECT … FOR UPDATE SKIP LOCKED` (safe across N instances) | exponential backoff 30 s → 15 min with jitter, max 5 attempts | `FAILED` + `hrm_outbox_failed` gauge |

### 6.2 The no-lost-work guarantee

Settlement (`settle.ts`) now commits the money state AND its notification
obligations in ONE `$transaction` (payment PAID + invoice PAID + outbox rows).
The relay delivers from the tick (backstop) and opportunistically right after
commit (fast path ≤ 60 s). The term application that runs after the commit is
idempotent (anchored to the invoice's own period) and `reconcileSettlements()`
re-applies anything a crash ate. **A retried relay job can never extend a
subscription twice** — the relay's handlers are notifications-only by design.

### 6.3 Monitoring

`/api/metrics`: `hrm_bgjob_pending/running/failed`, `hrm_outbox_pending/
processing/failed`, tick p95/p99 and vendor coverage. The shipped
`deploy/hrm-alerts.rules.yml` alerting posture extends naturally: page on
`hrm_outbox_failed > 0` and warn on `hrm_bgjob_pending > 1000` for 15 min.

---

## §7 — Observability (§13 of the prompt)

Metric families on `/api/metrics` (Prometheus text, token-gated):

- **Latency percentiles:** `hrm_rpc_duration_ms_p50/p95/p99` per module family
  (bounded cardinality: family = first path segment, ≤ 60 families).
- **Throughput & errors:** `hrm_rpc_requests_total`, `hrm_rpc_errors_total`.
- **Scheduler:** tick totals, p95/p99, last vendor count.
- **Queues:** BgJob + outbox gauges (30 s-cached COUNTs so scrapes are cheap).
- **Cache:** backend availability + hit/miss/set/del/error counters.
- **Ingestion:** raw-event backlog by state (RECEIVED / DEAD_LETTER /
  OUT_OF_WINDOW) + device online counts; duplicate-event rate is derivable
  from the replay/outcome logs (settlement REPLAY outcomes + device dedupe).
- **Payments:** settlement outcomes are audited on both planes
  (PAYMENT_RECORDED rows); reconciliation failures surface via the outbox and
  `reconcileSettlements` logs.

Structured logs (JSON in production) + correlation IDs ride `telemetry.ts`;
sensitive data (PII, secrets, tokens, biometric material) is already excluded
by the audit/PII scrubbers (`audit-pii` tests). Log rotation via
`deploy/logrotate.conf` + SIGUSR2 reopen.

---

## §8 — Load testing (§15 of the prompt) — how to run it

The kit lives in **`loadtest/`** (k6). See `loadtest/README.md` for the full
matrix: auth journey, tenant read journey, employee search, ESS write path,
device-plane ingestion via the ADMS simulator.

**Method (per the prompt):** baseline → normal → peak → stress → spike →
report. Record k6 summary JSONs next to `tests/perf-baseline.json` so every
future change has a before/after. The pure-JS perf suite
(`tests/_perf-env.ts` driven unit tests) remains the fast regression signal
inside CI; k6 is the staging instrument.

**What to measure on the way:** DB CPU + `pg_stat_activity` saturation, Redis
hit rate, queue depth, tick p95, outbox zero-loss, error budgets per §1.4.

## §9 — Capacity statement (measured vs. projected — no claims beyond evidence)

- **Measured in CI (this round):** `tsc --noEmit` clean; `next build` clean;
  unit suites per CHANGES docs; pure perf baseline exists
  (`tests/perf-baseline.json`). No live multi-tenant load test was run in the
  build sandbox (no PostgreSQL/Redis available there) — **the k6 numbers must
  be produced on your staging hardware before any capacity claim.**
- **Architecturally supported (projected, not certified):** the §1 model's
  600–800 RPS peak maps to 3–6 app instances + PgBouncer + Redis on a
  well-provisioned single PostgreSQL primary (16 vCPU / 64 GB class), with the
  partitioning trigger (§5.4) expected inside the first year at full fleet
  load.
- **Known limits of the single-node reference deployment:** one app instance
  + one Postgres comfortably serves the seeded demo fleet and mid-size
  production tenants (hundreds of tenants); beyond that, follow §2→§5 in
  order, re-running the load kit after each rung.

## §10 — Checklist when crossing each scale rung

1. **> 1 instance:** set `REDIS_URL` everywhere, swap to `Caddyfile.lb`,
   verify single-flight tick + cluster rate limits.
2. **> ~10 instances or DB connection pressure:** PgBouncer in front, direct
   migration connections preserved.
3. **> ~50M attendance rows:** partitioning per §5.4, then replicas for the
   read families in §5.3.
4. **Geo-latency complaints (outside primary region):** read replicas + CDN
   for marketing; multi-region writes remain out of scope until measured.
5. **Every rung:** re-run the load kit, update the SLO thresholds, record the
   results beside `tests/perf-baseline.json`.

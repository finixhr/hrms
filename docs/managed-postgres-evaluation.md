# Managed PostgreSQL Evaluation — Supabase vs Neon for Finix HR

**Wave 10 / Phase 5 (master prompt §5) · 2026-10-24**

Finix HR today runs self-managed PostgreSQL (Ubuntu VPS, `deploy/Caddyfile` +
`hrm.service`, `scripts/backup.sh` + `restore-drill.sh`, WAL-level nightly
backups with a tested DR runbook — see `docs/postgresql-cutover.md`). This
document evaluates the two managed-PostgreSQL candidates the master prompt
names — **Supabase** and **Neon** — against the platform's actual workload
profile, then gives the connection-string and pool tuning that applies to
WHICHEVER deployment path is chosen (including staying self-managed).

---

## 1. What the workload actually looks like

The platform's database profile (from the 1,586-test CI baseline, the R6
performance round and the quota/usage metering added in Phase 5 of the SaaS
layer) is:

| Property | Value / shape | Consequence for a managed provider |
|---|---|---|
| Tenancy model | Shared schema, `vendorId` column on every row (checked by `scripts/audit-perms.py` + the R5 NOT-NULL backfill) | NO per-tenant databases/RLS needed — provider must merely run one solid Postgres |
| Query mix | Short, indexed, OLTP — RPC-per-action over `/api/hrm` (a dispatcher request typically runs 1–15 queries) | Latency per round-trip dominates; CPU per query is trivial |
| Batchy spikes | Nightly jobs (`jobs.ts` daily/overnight sweeps, payroll month-end, usage snapshots) | Headroom bursts, not sustained write load |
| Row counts (typical tenant) | 10⁴–10⁵ employees × attendance rows/yr; payruns create thousands of payslip rows | A few GB per mid-size tenant; well below any managed tier's storage floor |
| New in Wave 10 | Binary payloads move OUT of the DB (StorageObject journal + R2/Cloudinary) → the DB gets SMALLER over time, not bigger | Storage-heavy provider features matter less than they did last month |
| Connections | Bun standalone server + Prisma; single app process per VPS today | Pool discipline matters more than raw max_connections |

The single most important number for a Bangladesh-hosted user base is
**p50 round-trip latency to the database** — every RPC action pays it 1–15
times.

## 2. Candidate comparison

### 2.1 Supabase (supabase.com)

- **Architecture**: single-tenant Postgres 15/16/17 per project, always-on
  compute, on top of standard EBS/pg storage. What you provision is a
  dedicated Postgres instance — no storage-compute separation.
- **Connection handling**: TWO endpoints — direct (`:5432`, dedicated
  `max_connections`) and Supavisor pooler (`:6543`, transaction mode,
  multi-tenant pgbouncer-compatible). Prisma works cleanly via the pooler
  with `?pgbouncer=true` (see §4).
- **Latency from Dhaka**: regions include **Singapore (ap-southeast-1)** and
  **Mumbai (ap-south-1)**. Realistic RTT from BD: **~30–60 ms Singapore**,
  ~25–45 ms Mumbai. An in-country VPS gives ~0.5–2 ms — a managed move costs
  roughly one extra RTT per query round-trip.
- **Backups / PITR**: free tier = 7 daily backups (no PITR); Pro adds
  PITR (WAL to 2-minute granularity) — the feature parity this platform's
  current nightly-WAL + restore-drill runbook already assumes.
- **Extensions/limits**: generous (pg_trgm **already used** by the R6 trigram
  employee-search indexes — verify availability on the chosen plan; it is
  standard on Supabase).
- **Cost shape**: Pro ≈ $25/mo base + compute hours + storage + egress
  (egress included allowances are the usual surprise line-item — small for
  an API workload, large if you serve the media through the DB… which Wave 10
  deliberately stops doing).
- **Operational fit**: `pg_dump`/logical backups + the existing
  `scripts/backup.sh` hooks port over with a URL change; the restore drill
  (`scripts/restore-drill.sh`) remains the acceptance test.

### 2.2 Neon (neon.tech)

- **Architecture**: storage-compute separation. Compute is a STARTABLE
  Postgres cluster writing to shared-page storage; the branch is the killer
  feature (copy-on-write database branches for testing migrations — genuinely
  valuable for the migration-heavy cadence this repo runs).
- **The cold-start question**: Neon scale-to-zero suspends idle compute;
  first query after suspend pays a cold resume (typically **~300 ms–1.5 s**,
  region dependent). For an HR system whose traffic is office-hours-only,
  scale-to-zero SAVES real money but the FIRST punch of the morning (a
  device sync or an ESS check-in) can eat a one-off delay. Keep-warm /
  minimum-compute settings remove the delay at the cost of the savings.
- **Connection handling**: pooled endpoint (`-pooler` host, pgbouncer
  transaction mode) + direct endpoint. Same Prisma caveat (`pgbouncer=true`),
  same fix.
- **Latency from Dhaka**: AWS regions including **Singapore**; same ~30–60 ms
  RTT class as Supabase. Neon also supports read replicas in-region if a
  reporting tenant needs isolation later.
- **Backups / PITR**: PITR to any point within the retention window on ALL
  paid plans; scale-to-zero free tier still keeps 7-day PITR — the most
  generous baseline of the two.
- **Cost shape**: usage-based (compute seconds + storage); for an
  office-hours HRM this is the cheaper curve in the small-tenant phase, but
  the cold-resume trade-off has to be accepted or paid away.

### 2.3 Scorecard

| Criterion (weighted by this workload) | Supabase | Neon |
|---|---|---|
| Steady p50 query latency BD→SG (same-region class) | tie | tie |
| Worst-case tail (cold resume) | none (always-on) | **penalty** unless min-compute |
| Connection pooling for Prisma | Supavisor, battle-tested | PgBouncer pooled endpoint, equally standard |
| PITR baseline | Pro plan | **all paid plans + free 7-day** |
| Database branching for migration testing | no | **yes — unique advantage** |
| pg_trgm (R6 search indexes) | yes | yes |
| Cost at ≤10 small tenants | ~$25–35/mo | **~$5–15/mo** (office-hours compute) |
| Cost at 50+ tenants / 24×7 devices (ZKTeco ADMS pushes) | predictable | compute-hours grow; re-evaluate |
| Vendor lock-in | low (plain Postgres + pg_dump) | low (plain Postgres + pg_dump) |
| Ops burden moved off the VPS | backups, patching, monitoring | same |

### 2.4 Recommendation

1. **Stay self-managed through private beta.** The current VPS runbook is
   already PITR-grade (nightly WAL + restore drills), the RTT advantage
   (~1 ms vs ~40 ms) is a real UX feature for device sync, and neither
   provider can beat $0 incremental.
2. **When you outgrow the VPS (first simultaneous-outage, first missed
   patch, first disk scare), move to Supabase Pro (Singapore)** as the
   default: predictable pricing, no cold starts for the 24×7 ADMS device
   lane (attendance terminals push around the clock — scale-to-zero would
   penalize exactly the traffic this platform most cares about), PITR parity
   with the current runbook.
3. **Adopt Neon later for its branching, not its hosting** — CI (stage 10's
   schema-drift gate + stage 11's fresh-DB smoke) is the natural consumer of
   copy-on-write branches; the `TEST_DATABASE_URL` env var the test preload
   already reads accepts a Neon branch URL unmodified.

**Either way, the platform is now provider-independent by construction**:
Wave 10 moved binaries to R2/Cloudinary (§4), the schema uses no
provider-specific column types, and `docs/postgresql-cutover.md` /
`docs/postgresql-rollback.md` document the dump-and-restore procedure that
works identically against Supabase, Neon, or any vanilla Postgres.

## 3. What does NOT change

- `prisma/migrations/` chain applies as-is on both providers
  (`bun run db:deploy`); the Wave 10 migration
  `9_wave9zp_infra_support_payments_storage_sms_20261024` is plain DDL.
- The schema-drift gate (`scripts/check-schema-drift.ts`) and the
  fresh-database smoke (`scripts/migrate-fresh-smoke.ts`) are
  provider-agnostic — point `TEST_DATABASE_URL` and they validate the
  managed instance's DDL equivalence.

## 4. Connection-string + pool tuning (applies to ALL three paths)

Prisma against a **transaction-mode pooler** (Supabase Supavisor `:6543`,
Neon `-pooler` host, or a self-hosted pgbouncer):

```
# Pooled (transaction mode) — REQUIRED flags:
DATABASE_URL="postgresql://postgres.xxx:PASSWORD@aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres?pgbouncer=true&connection_limit=10"
# Neon pooled:
#   postgresql://user:PASSWORD@ep-cool-name-pooler.ap-southeast-1.aws.neon.tech/neondb?sslmode=require&pgbouncer=true&connection_limit=10
```

- **`pgbouncer=true`** — Prisma disables prepared-statement caching for
  transaction mode (PgBouncer < 1.21 breaks on them). Without the flag you
  get intermittent `prepared statement "s0" does not exist` errors under
  load.
- **`connection_limit=10`** — hard cap the app's pool; the pooler multiplies
  effective capacity across app instances. Never let Prisma default
  (num_cpus × 2 + 1) size itself against a managed max_connections.
- **Direct (session) endpoint** (`:5432` / non-pooler host) ONLY for
  `prisma migrate deploy` — migrations + advisory locks want a real session.
  The `db:deploy` npm script reads the same `DATABASE_URL`; on a managed
  move, run it once with the direct URL.
- **`sslmode=require`** on every managed URL (self-managed behind Caddy
  already terminates TLS at the proxy; the DB socket stays local).
- Bun-specific: the standalone server runs ONE process — the effective
  ceiling is `connection_limit × replica count`; keep it ≤ 10 per replica
  and let Supavisor/PgBouncer absorb the ESS morning peak.

### Self-managed tuning that carries the same spirit

`postgresql.conf` knobs the managed providers bake in (mirrored here for
the VPS path): `max_connections=200` ceiling with the app pool capped at 10,
`work_mem=8MB`, `shared_buffers=25% RAM`, `effective_cache_size=60% RAM`,
`wal_level=replica` + `archive_mode=on` (already the backup runbook's
assumption), and `statement_timeout=15s` on the app role so a runaway
report can never pin a connection.

## 5. Migration procedure (identical for either provider)

1. Provision the project in **ap-southeast-1 (Singapore)**; save the direct
   + pooled URLs as secrets.
2. `bun run seed:owner`-less cutover: `pg_dump --format=custom` on the VPS →
   `pg_restore --jobs=4` into the managed direct URL (follow
   `docs/postgresql-cutover.md` verbatim — it was written provider-neutral).
3. `DATABASE_URL=<direct> bun run db:deploy` → confirm zero pending
   migrations (`scripts/check-migrations.mjs`).
4. Switch the app env to the **pooled** URL; restart `hrm.service`;
   watch `/api/readyz` (DB probe) + `/api/metrics` RPC p95s for one day.
5. Keep the VPS warm in DNS-limbo for one billing cycle as the rollback
   (`docs/postgresql-rollback.md`); decommission after the first clean
   restore drill against the MANAGED instance.

# CHANGES — 2026-10-26 — Wave 11: Enterprise Scalability Round

**Scope:** the 2026-10-26 master prompt (enterprise scalability & feature
implementation, §1–§17), built ON TOP of the completed 2026-10-25 Parts A–Q
round (support center, live support + resume, unified billing, payment
enforcement, custom plans, storage monitoring, passkeys, design systems).
This round adds what that prompt asked for and the platform did not yet have:
the transactional outbox, a shared Redis cache tier, p99 observability, the
two new public-site cursor effects, the multi-instance deployment artifacts,
the PgBouncer/CDN/partitioning runbooks, the k6 load-test kit — plus the
**boot-blocking env-allowlist fix** from the passkey round.

**Verification performed in this workspace:**
`tsc --noEmit` **clean** · `next build` **compiles successfully** (all routes) ·
`eslint` on every changed file **0 errors** · migration checker **44 migrations, apply order verified** ·
new Wave-11 unit tests **20/20 pass** · `master-prompt-security.test.ts` **12/12 pass** ·
pure-suite batch **335 pass / 13 fail — every failure is `P1001 Can't reach database server`
(no PostgreSQL in the build sandbox; DB-backed suites run green on your machine
per every prior round). No 100,000-tenant capacity claim is made — §15 below
states exactly what is measured vs. projected.

---

## 1. Hotfix — the boot blocker you hit on 2026-10-25/26

`src/instrumentation.ts` rejected `HRM_WEBAUTHN_RPID` / `HRM_WEBAUTHN_ORIGINS`
at boot ("Unknown or renamed environment variable(s): the server refuses to
start") because the passkey round documented both keys in `.env.example` but
never added them to `KNOWN_ENV_KEYS`. Both are now allowlisted (still optional —
unset means derive from the request host, as documented), and a **permanent
regression guard** now cross-checks `.env.example` against the allowlist so
"documented but not allowlisted" drift fails CI instead of your boot
(`tests/unit/wave11-env-allowlist.test.ts`). If you applied the workaround from
the chat (deleting the two lines from `.env`), you can put them back — with a
real domain set them to e.g. `HRM_WEBAUTHN_RPID=hrm.yourdomain.com` /
`HRM_WEBAUTHN_ORIGINS=https://hrm.yourdomain.com`.

## 2. Transactional outbox (master prompt §4)

- **New model + migration `9_wave11a_outbox_20261026`** (fully additive: one
  table, two indexes, zero column changes — verified against the schema by the
  migration checker).
- **`src/hrm-server/outbox.ts`** — the at-least-once relay:
  `FOR UPDATE SKIP LOCKED` batch claims (safe with N instances), exponential
  backoff 30 s → 15 min with ±25 % jitter, 5-attempt dead-letter to `FAILED`,
  `recoverStaleOutbox()` crash recovery, and **`reconcileSettlements()`** — the
  term-application backstop that re-applies lost subscription terms/upgrades
  using the SAME idempotent billing functions (anchored on the invoice's own
  period — a replay can never double-extend).
- **`settle.ts` atomicity refactor:** payment claim + invoice flip + the
  durable notification rows now commit in ONE `$transaction`; the receipt
  email and `invoice.paid` webhook can no longer be lost to a crash between
  commit and delivery. Opportunistic post-commit flush = the fast path (receipt
  within seconds); the scheduler tick is the retry backstop.
- Handlers are notifications-only by design — **a retried relay job can never
  extend a subscription or move money twice** (§4's hard rule).
- The jobs tick now runs: `recoverStaleOutbox → reconcileSettlements →
  flushOutbox` after the BgJob drain (single-flighted cluster-wide by the
  existing tick lock).

## 3. Shared Redis cache tier (§2)

- **`src/hrm-server/cache.ts`** — versioned keys (`hrm:c1:`), mandatory TTLs
  (1 s–24 h clamp), JSON-only values, cluster-wide `DEL` invalidation, 60 s
  dead-marking degradation, hit/miss/error counters. Zero new dependencies —
  Bun's built-in `Bun.redis` (same pattern as coordination.ts); under Node or
  without `REDIS_URL` every call miss-firsts to Postgres, which remains the
  authoritative source.
- **Entitlements L2** (`saas/entitlements.ts`): memo miss → Redis → DB, with
  the L2 TTL **identical** to the existing 10 s memo window — the never-
  stale-grant rule holds: a longer TTL is structurally impossible at the call
  site. `invalidateEntitlements()` now issues the cluster-wide `DEL` on every
  subscription change, so a payment settled on instance A unlocks the tenant
  on instance B immediately (previously: up to 10 s per instance).
- Compose: `redis` profile wired with `maxmemory 256mb / allkeys-lru` +
  `REDIS_URL` passthrough into the app service.

## 4. Observability (§13)

`/api/metrics` (Prometheus, token-gated) now exposes:
`hrm_rpc_duration_ms_p99` + tick p99 (the p50/p95/p99 contract is complete) ·
`hrm_outbox_pending/processing/failed` · `hrm_cache_backend/hits/misses/sets/
deletes/errors`. The owner Performance snapshot type carries `p99Ms` too
(additive — existing consumers unaffected).

## 5. Public-site cursor effects (§12)

- **Aurora Trail** (`aurora-trail`) — subtle multi-hue gradient ribbon: 12
  chained segments, per-index gradient/hue/blur/opacity in CSS
  (`--fx-i`), fades along the chain.
- **Magnetic Spark** (`magnetic-spark`) — lightweight fading particle trail: a
  14-spark pool with real physics (spawn-on-movement, inherited direction,
  damping, 240–500 ms quadratic fade), transform/opacity only.
- Both follow the engine's performance contract (rAF sleeps when idle;
  compositor-only writes; diff-cached styles) and inherit the existing
  reduced-motion / touch / `pointer: fine` gates.
- **Comet is now the default** style everywhere: `cms-defaults.ts`
  (fresh installs), the owner-save zod schema default, and the owner tab
  preset ("Balanced"). The Owner Console picker shows all five designs with
  live CSS previews (cursor-tab v3 + new demo animations).

## 6. Deployment & scaling artifacts (§2/§3/§15)

- **`deploy/Caddyfile.lb`** — multi-instance edge: N upstreams, active health
  checks on `/api/readyz`, `least_conn` (human plane) / `first_available`
  (device plane), bounded retry window for zero-downtime rolling restarts,
  explicit immutable cache headers for `/_next/static`.
- **`deploy/pgbouncer/`** — production `pgbouncer.ini` (transaction pooling,
  pool sizing math in the header) + SCRAM `userlist.txt` template.
- **`docs/SCALING.md`** — the runbook: 100 K-tenant capacity model with
  explicit assumptions (traffic matrix, growth, SLOs), statelessness contract,
  CDN cache/never-cache rules (Cloudflare reference), Redis TTL/invalidation
  table, PgBouncer + connection math, read-replica consistency matrix,
  attendance-table partitioning plan with measured trigger thresholds,
  observability inventory, and an honest measured-vs-projected capacity
  statement (§9 of that doc — **no capacity claim without test results**).
- **`DEPLOYMENT-GUIDE.md`** — new §Multi-Instance & Scaling section (the
  destination the boot warning always referenced).
- **`loadtest/`** — 5 k6 scenarios against the REAL RPC contract
  (`POST /api/hrm {action,payload}`, Bearer auth, `Origin` allowlist):
  auth journey, tenant read journey, employee search (trigram path), ESS geo
  punch writes, device-plane ATTLOG ingestion via the ADMS simulator → real
  `/iclock/cdata` gateway. Threshold gates match the SLO table; README has the
  full method (baseline → normal → peak → stress → spike → report).

## 7. Files changed / added this round

**Server:** `instrumentation.ts` (allowlist + test hook), `hrm-server/outbox.ts`
*(new)*, `hrm-server/cache.ts` *(new)*, `hrm-server/metrics.ts` (p99 + gauges),
`hrm-server/jobs.ts` (outbox relay in tick), `hrm-server/saas/entitlements.ts`
(L2 + invalidation), `hrm-server/saas/payments/settle.ts` (atomic settlement),
`hrm-server/saas/cms-routes.ts` (cursor enum/default + schema export),
`hrm-server/saas/cms-defaults.ts` (comet default).
**Schema:** `prisma/schema.prisma` (+`OutboxEvent`),
`prisma/migrations/9_wave11a_outbox_20261026/migration.sql` *(new)*.
**Web:** `saas/web/content-types.ts`, `saas/web/cursor/custom-cursor.tsx`
(v3 engine), `saas/web/cursor/cursor.css`, `saas/owner/website/cursor-tab.tsx`
(v3), `saas/owner/website/cursor-demo.css`.
**Infra/docs/tests:** `docker-compose.yml`, `deploy/Caddyfile.lb` *(new)*,
`deploy/pgbouncer/*` *(new)*, `docs/SCALING.md` *(new)*, `DEPLOYMENT-GUIDE.md`,
`loadtest/**` *(new)*, `tests/unit/wave11-{env-allowlist,cache,scalability}.test.ts`
*(new)* + `tests/unit/_wave11-cache-env.ts` *(new)*.

## 8. Environment variables & prerequisites

| Variable | Required? | Purpose |
|---|---|---|
| `HRM_WEBAUTHN_RPID` / `HRM_WEBAUTHN_ORIGINS` | optional (prod passkeys: yes) | WebAuthn RP ID (no port/scheme) + allowed origins — now boot-legal |
| `REDIS_URL` | optional; required for multi-instance | Shared cache/locks/rate buckets + entitlements L2 |
| `HRM_DEPLOYMENT_MODE=multi` | optional | Advisory flag (warning now has a real doc target) |
| `?pgbouncer=true&connection_limit=8` | when pooling | Prisma through PgBouncer |
| `ZKTECO_SIMULATOR_ENABLED=true` | staging only | Device-plane load tests |
| k6 run env vars | load testing | see `loadtest/README.md` |

No new package dependencies. No new background workers (the relay rides the
existing scheduler tick + opportunistic flushes).

## 9. Migration & deployment steps

1. `bun install` (no new deps — lockfile unchanged) then `bunx prisma generate`
   (adds the `outboxEvent` delegate; the client in the zip is pre-generated).
2. `bun run db:deploy` (applies `9_wave11a_outbox_…` — additive only).
3. `bun run build && bun start` — or scale out: `REDIS_URL=…` everywhere +
   `caddy run --config deploy/Caddyfile.lb` (per-instance ports via `PORT`).
4. Optional: PgBouncer (deploy/pgbouncer/) + CDN per docs/SCALING.md §3–§5.
5. **Rollback:** single additive migration — `prisma migrate resolve` is not
   needed; rolling back the app binary alone is safe (the outbox table is
   simply unused by older builds). Data is never reset.

## 10. Honest results & limitations

- **Ran here:** typecheck, lint, build, migration checker, 20 new unit tests,
  the pure-suite batch (335 pass; the 13 fails are all `P1001` — no PostgreSQL
  in this sandbox, identical pre-existing files), and the 12/12 payment-
  enforcement regression suite.
- **Not runnable here (needs your PostgreSQL/Redis):** the 117 DB-backed suite
  files and any live load test. Run on your machine:
  `bun test tests/unit` (auto-creates `hrm_test`), then the k6 kit on staging.
- **Before/after benchmarks:** the pure-JS perf baseline
  (`tests/perf-baseline.json`) is unchanged — this round touched no payroll
  math or query paths, so no golden numbers moved. The interesting deltas
  (entitlement L2 hit rate, settle latency, outbox delivery time) only exist
  under load — measure them with the k6 kit + `/api/metrics` and record the
  JSONs next to the baseline.
- **Capacity:** per docs/SCALING.md §9 — the architecture supports the
  modeled 600–800 RPS peak on 3–6 instances + PgBouncer + Redis; the number is
  **projected until you run the kit on production-like hardware**.

## 11. Outstanding / your action

- Run the DB-backed suite + build with your real `.env` before deploying.
- Produce the first real load-test numbers (loadtest/README.md method) and
  update the SLO thresholds to measured p99 + headroom.
- WebAuthn production values (`HRM_WEBAUTHN_RPID/ORIGINS`) for your domain.
- The k6 device-punch scenario needs a staging-only flag
  (`ZKTECO_SIMULATOR_ENABLED=true`); never enable it in production.
- Partitioning (§5.4 of SCALING.md) is intentionally NOT pre-applied — execute
  when the attendance tables hit the documented thresholds.

# Finix HR — Load Test Kit (Wave 11, master prompt §15)

k6 scenarios exercising the platform's critical journeys. Run them against a
**staging** deployment that mirrors production hardware (or a production-like
single node) — results from a laptop dev server are only useful as relative
baselines.

> **Honesty note (§15):** no 100,000-tenant capacity claim is made from these
> scripts alone. The capacity model, measured baselines and the supported
> scaling plan live in `docs/SCALING.md` §1 and §8. These scenarios are the
> instruments; run them, record the numbers, and scale the architecture as
> described there.

## Install

```bash
# https://k6.io/docs/getting-started/install/
brew install k6          # macOS
# or: sudo apt install k6 / choco install k6 / docker run grafana/k6
```

## Scenarios

| File | Journey | What it stresses |
|---|---|---|
| `k6/auth-journey.js` | full login + `auth.me` | credential hashing, session creation, **throttle limiter** (needs a pool of users), login-audit writes |
| `k6/tenant-read-journey.js` | login once → attendance today/summary → employees list → billing overview → support tickets | the everyday read mix: entitlements resolve, scoped queries, pagination, caches |
| `k6/employee-search.js` | constant-RPS employee directory search | pg_trigram ILIKE path, `take/skip` pagination, field-permission projection |
| `k6/attendance-write.js` | ESS geo check-in/out loop | write path, geofence evaluation, punch idempotency, rate limits |
| `k6/device-punch.js` | ATTLOG punches via the dev simulator → real `/iclock/cdata` gateway | **the ingestion plane**: raw-event insert, fast-ack contract, sweeper backlog |
| `k6/payroll-preflight.js` (OPS-4) | admin login → `payroll.preflight` for the current period, review loop | **money path**: whole-company payroll classification read (structures, payout validation, NID docs) |
| `k6/payroll-run-payment.js` (OPS-4) | admin login → `payroll.runs.list` → one page of `payroll.entries` (LISTING ONLY — never creates/pays runs) | **money path**: runs table + entry pagination under a live pay cycle |
| `k6/leave-approval.js` (OPS-4) | admin login → `leaveRequests.list` → `leaveBalances.list` loop | **money path**: approval inbox + balance-sheet reads the approve/reject decision is built on |

## Quick start

```bash
# 1) Tenant read journey (the core day-to-day load)
k6 run -e BASE_URL=http://localhost:3000 \
       -e TENANT_EMAIL=hradmin@demo.local \
       -e TENANT_PASSWORD='Pass@123' \
       -e VUS=50 -e DURATION=5m \
       loadtest/k6/tenant-read-journey.js

# 2) Employee search at a steady 40 req/s
k6 run -e BASE_URL=http://localhost:3000 \
       -e TENANT_EMAIL=hradmin@demo.local -e TENANT_PASSWORD='Pass@123' \
       -e RPS=40 -e DURATION=3m \
       loadtest/k6/employee-search.js

# 3) Device-plane ingestion at 150 punches/s (staging only)
k6 run -e BASE_URL=http://localhost:3000 \
       -e TENANT_EMAIL=hradmin@demo.local -e TENANT_PASSWORD='Pass@123' \
       -e DEVICE_SN=AC0123456789 -e DEVICE_KEY='<comm key>' \
       -e RPS=150 -e DURATION=5m \
       loadtest/k6/device-punch.js

# 4) Money paths (OPS-4): payroll preflight + run monitor + leave approvals
#    (TENANT_EMAIL must be a payroll-entitled admin WITHOUT MFA; k6 runs ONE
#    script per invocation; VUS defaults stay at 10 — the login throttle is
#    10/min per identity+IP, see the scenario headers)
k6 run -e BASE_URL=http://localhost:3000 \
       -e TENANT_EMAIL=hradmin@demo.local -e TENANT_PASSWORD='Pass@123' \
       -e VUS=10 -e DURATION=3m \
       loadtest/k6/payroll-preflight.js
k6 run -e BASE_URL=http://localhost:3000 \
       -e TENANT_EMAIL=hradmin@demo.local -e TENANT_PASSWORD='Pass@123' \
       -e VUS=10 -e DURATION=3m \
       loadtest/k6/payroll-run-payment.js
k6 run -e BASE_URL=http://localhost:3000 \
       -e TENANT_EMAIL=hradmin@demo.local -e TENANT_PASSWORD='Pass@123' \
       -e VUS=10 -e DURATION=3m \
       loadtest/k6/leave-approval.js
```

## Environment variables

| Var | Meaning | Default |
|---|---|---|
| `BASE_URL` | deployment root (no trailing slash) | `http://localhost:3000` |
| `ORIGIN` | Origin header sent with RPC calls (must match the host allowlist; defaults to `BASE_URL`) | `BASE_URL` |
| `TENANT_EMAIL` / `TENANT_PASSWORD` | login identity for the scenario | demo owner |
| `VUS` / `DURATION` / `RPS` / `MAX_VUS` | scenario sizing | per script |
| `SEARCH_TERMS` | comma pool for employee search | sample names |
| `WORKPLACE_LAT` / `WORKPLACE_LNG` | geofence center for ESS punches | Dhaka CBD |
| `DEVICE_SN` / `DEVICE_KEY` / `EMPLOYEE_PINS` | device-plane simulator wiring | placeholders |
| `PREFLIGHT_GAP_SECONDS` | think time between `payroll.preflight` calls (the expensive money-path read) | `10` |

## What "good" looks like (default thresholds)

- `http_req_failed` < **1%** (device plane < 2%, it may shed at 429 first)
- `http_req_duration` **p95 < 800 ms**, **p99 < 2 s** (writes: p95 < 1.2 s)
- `rpc_failures` / `punch_failures` counters stay near zero

These are the **starting gates** from docs/SCALING.md §7 SLO table. Re-baseline
them on your own hardware and update the thresholds to the measured
p99 + 50% headroom once you have real numbers.

## Method checklist (per §15)

1. **Baseline first**: run `k6/tenant-read-journey.js` with `VUS=10` and record
   p50/p95/p99 — everything else is compared to this.
2. **Normal load**: size VUs so RPS ≈ your modeled steady-state (§1 capacity
   model). Watch DB CPU, connection saturation (`pg_stat_activity`), Redis hit
   rate (`hrm_cache_*` from `/api/metrics`) and queue depth (`hrm_bgjob_pending`,
   `hrm_outbox_pending`).
3. **Peak**: 5× normal for 10 minutes — the scheduler must never starve; tick
   p95 (`hrm_jobs_tick_duration_ms_p95`) must stay under the tick budget.
4. **Stress**: ramp until p99 crosses the SLO — that point IS your measured
   single-node capacity; record it and scale out (SCALING.md §2) before
   repeating.
5. **Spike recovery**: 0 → peak in 30 s, hold 2 min, back to 0 — verify error
   rate returns to baseline and no queued work was lost (`hrm_outbox_failed`
   must stay 0; replayed receipts land exactly once).
6. **Report**: store the k6 summary JSON (`k6 run --summary-export=out.json`)
   next to `tests/perf-baseline.json` for before/after comparisons.

## Nightly money-path gate (OPS-4)

The three money-path scenarios run as a CI **nightly lane**, not on every
push — they need a reachable staging server and seeded payroll/leave data.
`scripts/ci.sh` gates the lane behind `NIGHTLY=1` (+ `HRM_K6_BASE_URL` and
credentials); see the stage-16 section there for the intended cron schedule
(00:30 Asia/Dhaka, ahead of the 01:05 nightly backup) and the matching
`.github/workflows/ci.yml` schedule comment.

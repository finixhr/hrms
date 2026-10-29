# Phase 4 — Hardening & End-State (2026-10-22)

Phase 4 (final) of the 2026-10 codebase audit remediation (report: *Finix HR —
Complete Codebase Audit & Performance Optimization*, §10 roadmap Table 15 /
§11 regression requirements). Built on the Phase 1 + 2 + 3 deliverables. Closes
the long-tail integrity items, finishes the money-math end-state, and
institutionalizes performance as a regression gate.

---

## WS-A — Money end-state (MON-9, MON-11, MON-12)

**MON-9 · integer-paisa arithmetic at computation time, one rounding
boundary** — the payroll engine's per-employee computation previously ran in
Float taka with `Math.round` at inconsistent boundaries (per component, per
loop, per accumulator) and *derived* the paisa shadow columns from the result —
the shadows faithfully recorded float error instead of preventing it, and the
unrounded `otherDeduction` sum broke payslip line-sum parity by a paisa.
The end-state (this phase) inverts the direction:

- `src/hrm-server/money.ts` gains the integer core: `toPaisa` (the single
  Float→paisa ingestion boundary), `fromPaisa` (the derivation boundary for
  the legacy Float columns), `divHalfUp` / `divFloor` (explicit half-up /
  mathematical-floor bigint division), `mulRatio` (exact proration) and
  `mulPct` (exact percentage). Every quantity has exactly ONE rounding
  boundary.
- `calculateRun` computes **every** money amount as integer paisa: gross
  proration, OT (per-tier integer numerators, one division by 60×208×100),
  absence (half-days via a ×2 numerator), all five late-policy modes, the
  late cap, early-leave, bonus remainders, loan budgets (arrears-aware), the
  advance rational sum over a common denominator, the other-deductions sum
  (the parity defect — now exact), PF employee/employer, the AIT ingestion,
  and the take-home recovery floor (`applyRecoveryFloorPaisa`, the bigint
  twin of the float helper with identical semantics).
- **The payslip identity**: `netPaisa` is the exact integer
  sum/difference of the component paisa values — line-sum parity to the paisa
  is guaranteed by construction. The Float columns (`gross`, `net`, …) are
  derived (`fromPaisa`); the H-09 dual-write invariant
  (`paisaOf(float) === paisa`) holds by construction.
- The guarantor fallback post-pass and `applyAdjustmentDeltas` operate in
  paisa too (source rows without paisa columns — pre-migration data — ingest
  their Float once through the same boundary). Run totals accumulate in
  paisa; the Float totals are derived.
- `tsconfig.json` target ES2017 → **ES2020** (BigInt literals — the engine's
  paisa arithmetic). Bun and Next's swc both fully support ES2020; no other
  behavior changes.
- Behavior deltas (documented, all in the defect direction): fractional
  (paisa-precision) salary inputs are no longer rounded to whole taka per
  component; whole-taka inputs produce byte-identical results.
- **Golden payslips gate the migration** (audit §11.2): a curated corpus —
  whole-taka month, fractional loaded month (absence/half-day/unpaid
  leave/per-minute late/OT tiers/loan arrears/advance/PF/AIT/manual
  deduction), weekly proration, mid-month joiner, negative-delta adjustment —
  pinned byte-stable in `tests/golden/payslips/*.json` with per-component
  migration-bound assertions. Regeneration is deliberate:
  `HRM_GOLDEN_REGEN=1 bun test tests/unit/phase4-golden-payslips.test.ts`.
  [`src/hrm-server/{money,payroll,loan-math}.ts`, `tests/unit/phase4-golden-payslips.test.ts`, `tests/unit/phase4-wsa-money.test.ts`]

**MON-11 · calendar-month loan EMIs** — installment schedules were generated
with `addDays(startDate, i × 30)`: a 360-day year drifting ~5 days per real
year, February EMIs eventually landing in March where payroll's month-prefix
budgeting (`dueDate.slice(0, 7)`) never picked them up (the daily job then
marked them OVERDUE while money was available). New `addMonthsIso` (utils)
adds calendar months with end-of-month clamping (Jan 31 + 1 = Feb 28/29, Mar
31 + 1 = Apr 30); `applyLoanDecision` uses it for every installment due date
and the term's `endDate`. Existing approved loans keep their stored schedules
(data preserved). [`src/hrm-server/utils.ts`, `src/hrm-server/routes/finance.ts`]

**MON-12 · AIT slab-table admin-facing validation** — the engine interprets
`upperLimit` as the BAND WIDTH of each marginal slab, but nothing told the
admin: pasting a published CUMULATIVE table (1,00,000 / 4,00,000 /
9,00,000 …) silently over-taxed every employee. `ait.slabs.save` now rejects
structurally impossible tables (a DECREASING rate — marginal schedules never
decrease; an all-zero table; a mid-table unlimited band), and the response
carries the exact **bracket table the engine will apply** (`from`/`to`/rate),
a worked example on ৳10,00,000, the explicit `semantics: WIDTHS` note, and a
`warning` when the widths look like a pasted cumulative table.
[`src/hrm-server/routes/ait.ts`]

## WS-B — Settlement & concurrency (MON-5, MON-6, MON-7)

**MON-5 · settlement pay-time ledger re-checks** — `settlements.pay`
re-validated only the final-salary gross leg (EXIT-005). The loan / advance /
bonus ledgers could drift between calculation and payment: a loan taken after
calculation (under-recovery), a payroll run recovering an EMI in between (the
settlement credits the recorded dues — the employee pays the same installment
twice), a bonus approved after calculation (missed) or paid by payroll in
between (double-paid via `bonusDue`). Inside the payment transaction, after
the exactly-once claim: the union of recorded + live loan ids must total the
recorded dues (±৳0.01, both directions); same for advances; the
APPROVED-unpaid bonus set must still match the snapshot exactly. Any drift
blocks payment with the specific reason and forces a recalculation — the same
discipline MON-1/MON-2 apply to payroll. [`src/hrm-server/routes/exit.ts`]

**MON-6 · tx-scoped settlement merge** — `exit.assets.clearWithDeduction`
merged the asset-recovery deduction into `FinalSettlement.computationJson`
AFTER the asset-claim transaction committed: two concurrent clears (or a
clear racing a `settlements.calculate`) each merged into the snapshot they
had read and the second commit silently dropped the first deduction line.
The merge now rides the SAME transaction, serialized per resignation by a
`SELECT … FOR UPDATE` on the Resignation row (the one row every settlement
writer passes), with the APPROVED/PAID guard re-evaluated on the fresh
in-transaction read. `settlements.calculate` takes the same lock and can no
longer silently wipe an APPROVED settlement back to CALCULATED (explicit
rejection instead). [`src/hrm-server/routes/exit.ts`]

**MON-7 · calculateRun conditional claim** — concurrent recalculations both
passed the DRAFT/CALCULATED status read, both computed, and raced on the
`(runId, employeeId)` unique — the loser surfaced a raw P2002 500 and both
computations journaled their AIT rows. `PayrollRun.calcEpoch` (migration
`9_wave10a`) fences the computation: a recalculation bumps the epoch
conditionally (`WHERE status IN (DRAFT, CALCULATED) AND calcEpoch = <read>`),
and the final wipe-and-rewrite only commits when this computation still owns
the run (epoch unchanged, status still claimable — a racing
submit-for-approval aborts it with nothing written). A crash after the claim
leaves only a bumped epoch — no stuck intermediate status.
[`src/hrm-server/payroll.ts`]

## WS-C — Data integrity (MOD-10, MOD-14, MOD-15)

**MOD-10 · lifecycle.transfer FK validation** — the transfer row stored
whatever ids the caller sent: another TENANT's branch/department/
designation/shift or manager passed the create (no cross-tenant FK) and was
applied verbatim to the employee record at approval. Every provided target
is now validated vendor-scoped before the create (≤1 count query per entity
kind, only for the kinds addressed), with an actionable 400 naming the field.
[`src/hrm-server/routes/lifecycle.ts`]

**MOD-14 · workflows.save transaction + pending guard** — the save path was
a non-transactional upsert + `deleteMany(all steps)` + sequential creates:
a mid-failure left the workflow with zero/partial steps and every in-flight
approval of that type hung, and editing a workflow with PENDING requests
silently detached the running requests from their step definitions. Now:
PENDING requests of the process type block the edit (resolve first), and the
whole rewrite (upsert + wipe + `createMany`) is one transaction.
[`src/hrm-server/routes/organization.ts`]

**MOD-15 · hardDelete preserves the audit trail** — the irreversible
hard-delete erased the employee's AuditLog rows inside its transaction: the
forensic record of everything ever done to the employee (including the
deletion itself) was destroyed by the action that needed it most. The
AuditLog delete is removed — the rows survive as historical evidence; every
other cleanup is unchanged. [`src/hrm-server/routes/employees.ts`]

## WS-D — Platform hygiene (SEC-16, FE-7, usage metering)

**SEC-16 · SaaSAuditLog retention** — platform audit rows (owner actions +
a `NOTIFICATION_*` row for every email ever sent) accumulated forever, with
recipient emails riding in the metadata. `sweepSaasAuditRetention` (jobs.ts,
exported + tick-wired via the daily platform pass) purges rows older than
`HRM_SAAS_AUDIT_RETENTION_DAYS` (default **730** = 2 years; explicit `0`
disables — parsed without the falsy-`||` trap). Owner-session purge was
already delivered by Phase 2 (SCL-19); the per-tenant AuditLog keeps its own
5-year policy. [`src/hrm-server/jobs.ts`]

**FE-7 · dead dependencies removed** — `@xyflow/react`, `dagre`,
`html-to-image` and `@types/dagre` (zero imports anywhere in `src/`) are gone
from `package.json` + `bun.lock`. A reintroduction guard pins both the
manifest and the source tree. [`package.json`, `tests/unit/phase4-wsd-platform.test.ts`]

**Per-tenant usage metering for billing** — new `UsageSnapshot` model
(migration `9_wave10b`): a monthly, billing-grade usage series per tenant
(employees total + payroll-scope, portal users, enrolled devices, storage
bytes). The daily platform pass captures/refreshes the CURRENT month for
every vendor in ONE set-based `INSERT … ON CONFLICT` (fleet-size
independent); the last daily write of a month is that month's frozen
end-of-month record. `owner.usage.history` (owner console, `tenants.view`)
serves the series with vendor names — billing reconciliation no longer has to
re-derive usage from live tables, which only ever answers "now". Additive: no
existing behavior reads the table except the endpoint + the tick writer.
[`prisma/schema.prisma`, `src/hrm-server/jobs.ts`, `src/hrm-server/saas/owner-routes.ts`]

## WS-E — End-state regression infrastructure (§11 exit criteria)

- **Perf-budget CI (stage 13)** — `tests/unit/phase4-perf-budget.test.ts`:
  (1) hard **query-count caps** per critical action (auth.me ≤ 15,
  employees.list ≤ 12/page, attendance.summary ≤ 8, payroll.runs.list ≤ 8)
  measured through the production dispatcher with opt-in Prisma query
  instrumentation (`HRM_QUERY_COUNT=1` via `tests/_perf-env.ts`; zero
  overhead unless enabled); (2) **p95 budgets** + a committed baseline
  (`tests/perf-baseline.json`) — a build fails when an action's p95 exceeds
  its budget or regresses past max(baseline +15%, baseline +30ms).
  Deliberate perf changes refresh the baseline:
  `HRM_PERF_BASELINE_UPDATE=1 bun test tests/unit/phase4-perf-budget.test.ts`.
- **Golden payslips** — the MON-9 migration gate above (byte-stable corpus;
  any arithmetic change must update the goldens deliberately).
- **Scale fixtures** — `scripts/seed-scale.ts` generates the synthetic
  5,000-employee tenant and the 100,000-vendor fleet (chunked `createMany`,
  `SCALE-` prefixed codes for selective cleanup). The **nightly lane**:
  `bun run scripts/seed-scale.ts --employees 5000 --vendors 100000` then
  `HRM_PERF_PROFILE=nightly bun test tests/unit/phase4-perf-budget.test.ts`
  (raised iteration counts).

## Schema

- `9_wave10a_payroll_calc_epoch_20261022` — `PayrollRun.calcEpoch Int
  @default(0)` (MON-7 fencing; additive, no backfill).
- `9_wave10b_usage_snapshot_metering_20261022` — `UsageSnapshot` table
  (`@@unique([vendorId, periodYear, periodMonth])`; additive).

## Tests (49 new, all failing on the pre-Phase-4 code)

`phase4-golden-payslips` (5 — the migration gate), `phase4-wsa-money` (13 —
money core, EMI calendar, slab validation), `phase4-wsb-settlement` (12 —
claim race, ledger drift, merge race, approval wipe), `phase4-wsc-integrity`
(6 — cross-tenant FKs, pending guard, audit survival), `phase4-wsd-platform`
(7 — retention ×2, metering ×3, dead-deps guard ×2), `phase4-perf-budget`
(6 — caps + baseline gate).

## Verification (2026-10-22)

`bash scripts/ci.sh` — ALL 13 STAGES GREEN. tsc 0 errors · eslint 0 errors ·
**1336/1336 unit tests** (49 new; 0 unexpected failures) · config/destructive/
docs/permission guards OK · dependency audit OK · fresh-database migration
smoke: full chain incl. both wave10 migrations applies cleanly · schema-drift
gate: zero drift · perf budget: caps + p95 baseline gate green.

## Hotfix (2026-10-22, post-delivery) — BigInt-safe audit serialization

**Found by the customer's verification run** (Windows / Bun 1.4.2): the full
suite printed `audit failed … TypeError: JSON.stringify cannot serialize
BigInt` once, on `salaryStructures.save (update existing)` — while every test
stayed green. Root cause: the H-09 paisa shadow columns are Prisma **BigInt**
(Int overflowed at totalGrossPaisa = 5,003,650,000), Prisma returns JS
`BigInt` for them, and `JSON.stringify` refuses BigInt. `routes/payroll.ts`
passes the raw pre-update row as the audit `oldValue`, so the serialization
threw inside `audit()`'s best-effort catch — the mutation succeeded but its
**audit row was silently dropped** (the exact F32 failure class the audit
flagged). Reproduced deterministically on the delivery sandbox.

Fix — one boundary, every call site safe by default:

- `src/hrm-server/audit.ts` — new exported `auditJson()` (BigInt → decimal
  string via a stringify replacer) now serializes `oldValue`/`newValue` in
  BOTH `audit()` and `auditStrict()`. `auditDiff()` consumers are covered
  transitively (its output crosses the same boundary).
- `src/hrm-server/saas/audit.ts` — `saasAudit()` metadata uses the same
  `auditJson()` (defensive; no owner-plane BigInt columns today).
- `tests/unit/h8-paisa-dualwrite.test.ts` — the update test now asserts the
  `salaryStructures.update` audit row lands with both snapshots serialized
  (old `500050`, new `600075` paisa). Test count stays 1336.

Verification: `bash scripts/ci.sh` — ALL 13 STAGES GREEN, **1336/1336**, and
the full-suite stderr now contains **zero** `audit failed` lines.

For clarity, the OTHER scary-looking output blocks during a test run are
expected negative-path logging, not errors: `prisma:error … RESTRICT/Unique
constraint failed` lines are tests deliberately provoking the DB guards
(H-10 FK integrity, M-13 payslip uniqueness, SCL-21 lock contention — each
is immediately followed by its ✓ passing assertion), `[jobs]
BACKUP_EXPORT: 16 model(s) not present` is the backup exporter's graceful
skip of vendor-scoped child tables, and the 24.7 s `runTick` test holds the
scheduler tick lock on purpose (SCL-21 cluster dedup).

## Hotfix #2 (2026-10-22, post-delivery) — dev-console noise: Edge-Runtime
`crypto` warning spam + `prisma:error` lock dumps

Reported from the customer's `bun run dev` console. Both were noise issues,
not functional failures — but each made the console unusable for spotting
real problems, and one masked a genuine design flaw in the lock path.

**1. `⚠ ./src/instrumentation.ts:18 — A Node.js module is loaded ('crypto')
which is not supported in the Edge Runtime` + `Ecmascript file had an
error`, printed on EVERY request.** Next.js compiles `instrumentation.ts`
for every runtime — including the Edge runtime that `proxy.ts` runs on —
and the static top-level `import crypto from "crypto"` (used only for the
SEC-1 leaked-secret sha256 blocklist) made every Edge compile of the file
fail. The Node-runtime `register()` itself kept working (the boot banner
printed normally), but the failed Edge compile re-printed per request in
dev. Fix — the Next-documented pattern: `node:crypto` is now dynamically
imported INSIDE the `process.env.NEXT_RUNTIME === "nodejs"` branch of
`register()`, with the sha256 helper injected into `validateEnvValues()`
/ `isKnownLeakedSecret()`. Turbopack inlines `NEXT_RUNTIME` per compile
target and dead-code-eliminates that branch (and its dynamic imports) from
the Edge bundle — warning AND error gone. Boot validation behavior is
unchanged (same hashes, same blocklist, same fail-fast messages).

**2. `prisma:error Invalid … db.coordinationLock.create() … Unique
constraint failed on the fields: (key)` on every scheduler tick.** By
design `releaseLock()` leaves the lock row behind (released = epoch
backdate), so every re-acquisition — each `scheduler:tick` after the
first, every `backup-scheduled:<date>` period claim after a restart —
collided on the PK. The old code CAUGHT the P2002 and followed up with a
conditional takeover, but the Prisma ENGINE logs the error before user
code can catch it: the lock's HAPPY path ran through a database error and
dumped a full invocation trace per tick (alert fatigue — a real
`prisma:error` would drown in expected noise). Fix — one atomic
statement, no error in any outcome:

```sql
INSERT INTO "CoordinationLock" (…) VALUES (…)
ON CONFLICT ("key") DO UPDATE SET …
  WHERE (expired OR same-holder)
RETURNING "key"
```

Row absent → INSERT wins (we hold it) · expired/released row → takeover
(TTL-bounded crash recovery) · same holder → TTL refresh · live foreign
holder → 0 rows → null ("someone else's job"). Expiry compares against a
JS Date PARAMETER, not the DB's `now()`: the column is naive
`timestamp(3)` and Prisma serializes Date params as UTC wall-clock —
identical to the old `lt: new Date()` comparison, and immune to a non-UTC
Postgres session timezone (e.g. `Asia/Dhaka` on a Windows install), which
would otherwise judge every lock by local wall-clock and break mutual
exclusion across instances.

Regression coverage: the existing SCL-21 suite
(`tests/unit/phase3-wsb-coordination.test.ts` — exclusive acquire /
refuse / release / re-acquire, expiry takeover, non-holder release no-op,
single-flight wrapper, period claims, cluster-wide tick lock, row shape)
plus the campaign single-flight lock test — all run against the real
Postgres backend; all green, and the two lock suites' output now contains
ZERO `prisma:error` lines.

Verification: `bash scripts/ci.sh` — ALL 13 STAGES GREEN, **1336/1336**.
After this hotfix a dev console shows only the boot banner and request
lines; the expected negative-path output during `bun test` (documented
under Hotfix #1) is unchanged.

## Hotfix #3 (2026-10-22, post-delivery) — backup ENOENT: the PostgreSQL
dump was never renamed to its final artifact name

Reported from the customer's Windows machine: a manual backup from the
Owner Panel failed with

```
[jobs] job BACKUP_PG_DUMP … failed Error: ENOENT: no such file or directory,
  open 'C:\HRMS_CCTV\finix-hr-p4\backups\hrm-20261022T052055Z.dump'
    at async encryptFile (src\hrm-server\saas\backup.ts:180)
    at async runBackup  (src\hrm-server\saas\backup.ts:802)
```

**Root cause.** The Phase-3 WS-C rework (OPS-2, pg_dump `--format=custom`)
made pg_dump write its archive to a temp sibling —
`backups/hrm-<stamp>.dump.tmp` — but the rename to the final
`hrm-<stamp>.dump` was never added. Phase 2 then opened the never-created
final name: `encryptFile()` with `HRM_BACKUP_KEY` set (the customer's case),
`sha256File()` without it — **every PostgreSQL backup failed**, encrypted
or plain, on every OS, since Phase 3 shipped. It slipped through because
the test container ships no `pg_dump`/`pg_restore` (documented in
`phase3-wsc-backup.test.ts`'s header), so the full `runBackup` PostgreSQL
leg had never once executed end-to-end in CI — the same
"untested leg regresses silently" failure class the audit flagged for
other modules.

**Two fixes** in `src/hrm-server/saas/backup.ts`:

1. The missing `rename(dumpTmp, plainArtifact)` — same-directory (same
   volume), atomic on POSIX, safe on Windows (pg_dump has exited; nothing
   else holds the file).
2. A second latent bug of the same family found while fixing #1: the
   SQLite leg pushed its plain `.db.gz` into the temp-cleanup list
   *unconditionally*, so a no-encryption SQLite run **deleted its own
   delivered artifact** in the `finally` (the DONE row then pointed at a
   file that no longer existed). The plain artifact now enters the temp
   list ONLY when encryption is about to replace it with the final `.enc`.

**Regression coverage** — new suite
`tests/unit/hotfix3-backup-artifact-lifecycle.test.ts` (5 tests) runs the
REAL `runBackup` end-to-end against stub `pg_dump`/`sqlite3` executables
on PATH (the container still ships no real ones), covering: encrypted
PostgreSQL (DONE, only `.dump.enc` on disk, no plain/.tmp leftovers,
checksum + report row) · plain PostgreSQL (the `.dump` deliverable
survives) · phase-1 pg_dump failure (nothing left behind, FAILED row) ·
encrypted SQLite (`​.db.gz.enc` survives, plain removed) · plain SQLite
(the `.db.gz` deliverable survives — fails on the old code). Verified
failing-direction-aware: with the rename removed, the suite reproduces
the customer's ENOENT character-for-character; with it, all green.

Verification: `bash scripts/ci.sh` — ALL 13 STAGES GREEN, **1341/1341**
(1336 + the 5 new). No other behavior changed; SQLite-with-encryption and
the deploy/`backup.sh` out-of-app path are untouched.

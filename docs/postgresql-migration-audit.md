# HRMS_CCTV — SQLite → PostgreSQL Migration Audit

**Date:** 2026-09-30 · **Phase:** 0–2 (read-only audit + compatibility plan)
**Source of truth:** the actual repository + the actual SQLite database (`prisma/db/custom.db`, md5 `23ff93188d8308cc09f255b2f062050b`, size 2,301,952 B, sha256 `a778a920e6ff21c07f7c5948e08e5261b89b968691e13822069ac84919527d77`).
**Immutable backup:** `/home/z/my-project/pg_migration/backup_sqlite/custom.db.immutable` (recorded in `BACKUP_RECORD.md`). The live file was never opened read-write during the audit.

---

## A. Current architecture

```
Internet → Caddy (HTTPS, reverse proxy) → Next.js 16.3.5 standalone (Bun runtime)
  → single RPC dispatcher POST /api/hrm {action,payload}
  → Prisma 6.19.3 (prisma-client-js)
  → SQLite file prisma/db/custom.db (WAL-less, 100 tables, 96 models)
ZKTeco devices → /iclock/* (ADMS) and Hikvision → /ISAPI/* (same Next.js process)
Background jobs: in-process scheduler + BgJob table queue (jobs.ts)
systemd: hrm.service, backup.service/timer, vacuum.service/timer, restore-drill.service/timer
```

Runtime facts verified from code:
- **Prisma client singleton** (`src/lib/db.ts`) with env-driven log level; a `file:`-URL anchoring workaround for bundler/standalone CWD issues.
- **96 Prisma models** → 100 SQLite tables: 96 model tables + `_prisma_migrations` + 3 `_archived_*` FK-integrity safety tables (from migration `20260921000300_h10_fk_integrity`, all three EMPTY).
- **12 SQLite migrations** in `prisma/migrations/` (`20260921000000_baseline` … `20260929000000_employee_photo_thumb`), `migration_lock.toml` provider `sqlite`.
- **All 96 primary keys are `String`** — 93 `@default(cuid())`, 3 explicit (`User.id`, `Setting.key`, `Throttle.key`-style). **No `autoincrement`, no Int ids, no BigInt, no Bytes, no enums, no Prisma `Decimal`, no `Json`-typed fields** (JSON payloads are stored as TEXT in `*Json` String columns).
- Total data: **2,122 rows across 45 non-empty tables** (largest: Attendance 1,237; LeaveBalance 192; PayrollEntry 72). `_prisma_migrations`: 11 applied rows (12th migration is the photo_thumb one added after this DB was last migrated — it applies on next `migrate deploy`).
- Full inventory with per-column NULL/empty stats, indexes, FKs and row counts was captured as a machine-readable JSON during the audit (retained in the migration workspace; not a shipped repo file).

## B. Target architecture

```
Internet → Caddy (unchanged) → Next.js standalone (Bun, unchanged)
  → Prisma 6.19.3 (unchanged) → PostgreSQL 17 (localhost/private bind only)
```
- Same process, same routes, same RPC contract, same ADMS endpoints. Only the database engine and everything that touches it directly change.
- PostgreSQL binds `127.0.0.1` (or private NIC); never publicly exposed; Caddy still the only public edge.

## C. SQLite-specific files (complete list, from grep)

| File | What's SQLite-specific |
|---|---|
| `src/lib/db.ts` | `resolveDatabaseUrl()` — `file:`-URL anchoring (inert for postgres URLs, but dead weight + its dedicated test) |
| `src/app/api/readyz/route.ts` | two `sqlite_master` queries (checks 1 & 2) |
| `scripts/backup.sh` | python `sqlite3` backup API + `sqlite_master` verify + custom.db path resolution |
| `scripts/restore-drill.sh` | python `sqlite3` restore + integrity + payroll spot-check SQL |
| `scripts/disk-check.sh` | DB path = sqlite file; size math from file |
| `scripts/e2e-test.sh` | python `sqlite3` cleanup + `DB_FILE` path logic |
| `scripts/setup-and-seed.sh` | `DEFAULT_DB="file:…custom.db"` |
| `scripts/test-zkteco-flow.sh` | `file:` DB URL + `sqlite3` CLI usage (legacy shell variant) |
| `scripts/zkteco-test.sh`, `scripts/remediation-verify.sh` | python `sqlite3.connect('db/custom.db')` — one-off audit/remediation verifiers (historical) |
| `scripts/check-docs.sh` | asserts `prisma/db/custom.db` does not ship in the git artifact |
| `scripts/phase2-verify.ts` | `DATABASE_URL="file:…"` example in header comment |
| `vacuum.service` + `vacuum.timer` units (deploy/) | `bun:sqlite` VACUUM + `PRAGMA optimize` |
| `deploy/backup.service` | env-comment `DATABASE_URL=file:…` |
| `tests/preload.ts` | sets `DATABASE_URL=file:test-unit.db`, `prisma db push --force-reset` |
| database-runtime build script (under tests/) | tests the `file:` anchoring logic of db.ts |
| `prisma/schema.prisma` | `provider = "sqlite"` |
| `prisma/migrations/*` (12) | SQLite-dialect SQL |
| `.env` / `.env.example` | `DATABASE_URL="file:./db/custom.db"` |
| `src/hrm/views/settings.tsx:1774` | UI help text mentions "sqlite3 .backup" |

## D. SQLite-specific SQL (raw SQL audit — spec §24)

Complete `$queryRaw/$executeRaw` census (5 call sites, all `$queryRaw`, **no Unsafe variants, no string interpolation**):
1. `src/app/api/health/route.ts:13` — `SELECT 1` — portable, **no change**.
2. `src/app/api/readyz/route.ts:21` — `SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='Employee'` — **rewrite** to `information_schema.tables`.
3. `src/app/api/readyz/route.ts:30` — same for `_prisma_migrations` — **rewrite**.
4/5. `src/app/api/integrations/zkteco/adms/health/route.ts:20,29` — `SELECT 1` — portable, **no change**.

No `PRAGMA`, no `datetime()/julianday()/strftime()`, no SQLite locking assumptions in application code. The only `PRAGMA` usages live in `vacuum.service` unit and the audit tooling (`pg_audit_inventory.py` style — dev only).

## E. SQLite-specific runtime assumptions

1. **Case-insensitive string search.** SQLite `LIKE` (Prisma `contains`/`startsWith`) is ASCII-case-insensitive; PostgreSQL `LIKE` is case-sensitive. **16 `contains:` + 22 `startsWith:`/`endsWith:` call sites** (employees, global search, reports, inventory, device lists). Without action, `search "tasnim"` stops matching "Tasnim Rahman" — a user-visible regression. Fix: add `mode: "insensitive"` (PG-only Prisma feature → `ILIKE`) at user-facing search sites.
2. **Job claiming** (`jobs.ts` 681–689): find-first + conditional `updateMany({where:{id,status:"PENDING"}})` — atomic first-wins claim. On PG this is **more** correct (row-level locking); no rewrite, but concurrency must be re-tested (spec §34/§48).
3. **Throttle upsert** (`security.ts`): Prisma upsert + conditional updateMany reset — maps to PG `INSERT … ON CONFLICT`; atomicity improves. Re-test under parallel requests.
4. **Boolean storage**: SQLite `0/1` → PG `true/false`. Prisma handles transparently; migration converts.
5. **DateTime storage**: SQLite INTEGER epoch-ms (verified: `AuditLog.createdAt` typeof integer) → PG `timestamp(3)`. Prisma client converts both ways; displayed/calculated times unchanged. All attendance boundary math is JS (`dayjs`-style arithmetic on Date), not SQL — no SQL date functions anywhere.
6. **Money**: no `Decimal`/`Numeric` types — all money is `Float` (SQLite REAL, verified typeof=real). Migration maps REAL → `double precision`, preserving bit-exact values. *Known pre-existing issue (documented, NOT changed): Float money can accumulate rounding noise; converting to Decimal would be a redesign — out of scope per §0/§50.*
7. **JSON-as-TEXT**: 20 `*Json` String columns (verified TEXT with `{}`/`[]` defaults) → PG `text`, content copied verbatim. No `jsonb` conversion (preserves exact semantics; §10 "do NOT blindly convert").
8. **Transactions**: Prisma interactive transactions used throughout — PG semantics equal or stricter. No `BEGIN IMMEDIATE`-style SQLite locks in code.
9. **`relationMode`**: not set → real FK constraints exist in SQLite and will exist in PG.

## F. SQLite-specific tests

- `tests/preload.ts` (+ `bunfig.toml [test].preload`) — **must become PG**: isolated `hrm_test` database, refuse production URLs, `db push --force-reset` there.
- `tests/unit/_testdb.ts` — re-exports preload (no own logic).
- The database-runtime build script under tests/ — tested db.ts `file:` anchoring; logic removed ⇒ test retired (documented).
- 31 unit test files + `tests/e2e/camera-dispatcher.test.ts` are DB-agnostic (Prisma + fetch); expected to pass unchanged once preload targets PG.
- `scripts/e2e-test.sh` (test:e2e) — python sqlite3 cleanup/asserts → rewrite to psql.
- 2 pre-existing MFA unit-test failures (unrelated to DB; same on v2 baseline — documented, not fixed per §50).

## G. SQLite-specific deployment scripts

- `deploy/hrm.service`: `ReadWritePaths=/opt/hrm/prisma/db …` → `/opt/hrm/storage /opt/hrm/backups /opt/hrm/logs` (DB dir no longer written by app); add `After=postgresql.service` + `Wants=postgresql.service`.
- `vacuum.service` unit/`vacuum.timer`: **REMOVE** (SQLite VACUUM/PRAGMA) — replaced by PG autovacuum; optional monthly `ANALYZE` documented.
- `deploy/backup.service`/`.timer`: keep schedule/alerting/encryption; env comment + script target change to pg_dump.
- `deploy/restore-drill.service`/`.timer`: keep cadence; drill script rewritten for pg_restore.
- `Caddyfile` / `deploy/Caddyfile`: no DB references — **untouched**.

## H. SQLite-specific backup/restore logic

`scripts/backup.sh`: python sqlite3 online-backup → verify core tables → optional AES-256-CBC (openssl, key from `HRM_BACKUP_KEY`) → SHA-256 manifest → optional offsite `{file}` cmd → 14-day retention → failure email via `scripts/backup-alert.ts`. `scripts/restore-drill.sh`: newest backup → checksum → decrypt → read-only boot → core-table + payroll-totals spot-check → drill log.
**PG replacement preserves every property**: `pg_dump --format=custom` (compressed, pg_restore-able) → same openssl encryption, same manifest/offsite/retention/alerting; drill restores with `pg_restore` into a scratch database + same spot-checks.

## I. PostgreSQL compatibility risks

| Risk | Severity | Handling |
|---|---|---|
| Case-sensitive `LIKE` breaks searches | **High (UX regression)** | `mode: "insensitive"` at user-facing search sites + regression tests |
| readyz `sqlite_master` queries crash on PG | **High (readiness 503s forever)** | rewrite with `information_schema` |
| Test harness points at SQLite file | **High (CI broken)** | preload → isolated PG test DB |
| Nullable-column uniques (`@@unique([vendorId, serialNumber, channel])` w/ NULL serialNumber) | Medium | SQLite & PG both treat NULLs as distinct by default → **same behavior**, verified by test |
| `Booleans` in raw SQL/JSON payloads | Low | no raw-SQL booleans; JSON stays TEXT |
| PG 17 client/server version parity | Low | pinned 17.11 both sides in sandbox; deployment doc pins distro PG 16/17 |
| `CURRENT_TIMESTAMP` default in `_archived_*` DDL (SQLite=UTC vs PG=session TZ) | Low | baseline uses `(now() AT TIME ZONE 'UTC')`; tables empty |

## J. Data migration risks

- **2,122 rows, 45 non-empty tables** — small; single transaction per table + full-table checksums are cheap.
- Duplicate candidate found: `Department.name="Operations"` ×2 — legitimate multi-tenant data (two vendors), and `Department` has no unique on name → **not a blocker**.
- No orphan FK rows detected (H-10 migration historically swept them into `_archived_*`, all empty).
- DateTime columns stored as INTEGER ms must be converted to `Date` on import (per-field type map from schema); `*Json` TEXT copied verbatim; REAL→double precision exact.
- Photos (data URLs in TEXT columns, `Employee.photoUrl` up to ~18 KB strings) — TEXT→text, no size issue.

## K. Prisma migration risks

- The 12 existing migrations are SQLite-dialect SQL — **cannot** run on PG (would fail, and must not be "marked applied" dishonestly).
- Strategy (spec §14): archive them to `prisma/migrations_sqlite/` (rollback + history preservation), generate ONE PG baseline `prisma/migrations/0_init_postgresql/migration.sql` from the current schema via `prisma migrate diff --from-empty --to-schema-datamodel`, apply on PG with `prisma migrate deploy` — **no fake history**: the baseline genuinely builds the schema; boundary documented in docs + `migration_lock.toml` becomes `postgresql`.
- `_archived_*` tables are outside schema.prisma → added to the baseline DDL explicitly (documented intentional difference).
- Future `migrate dev`/`migrate deploy` work normally against PG.

## L. ZKTeco ADMS risks

- No ADMS code touches SQLite directly — everything goes through Prisma (verified: only 5 raw-SQL sites app-wide, none in `src/hrm-server/zkteco/` or `src/app/iclock/`).
- Idempotency relies on `@@unique([deviceId, deviceUserId])` + conditional updates — identical semantics on PG.
- Event time strings (`'2026-09-28 08:51:00'` TEXT) pass through untouched; `ADMS_TIMEZONE_OFFSET_HOURS=6` math is JS-side — unaffected.
- Device registration/comm-key hashes are TEXT/`sha256` hex — unaffected.
- Risks to verify by test: duplicate-ACK behavior, concurrent ingestion, unknown-device rejection (test plan in §M).

## M. Recommended migration sequence

1. **Phase 3** Schema: switch provider → `postgresql`; regenerate client; archive SQLite migrations; create + apply PG baseline; validate structure vs SQLite inventory (table/column/constraint diff).
2. **Phase 4** Build `scripts/migrate-sqlite-to-postgres.ts` (bun:sqlite reader + Prisma PG writer; topological order from live FK graph; batched createMany; per-row error surface; JSON state log; deterministic; re-runnable via staging-recreation).
3. **Phase 5** Run against disposable `hrm_staging` (sandbox PG 17.11).
4. **Phase 6** Reconciliation: row counts, PK ranges, FK integrity, per-table canonical checksums, financial aggregates; **sequence sync** — N/A (zero autoincrement IDs; verified no PG sequences owned by tables except none) — but automated check asserts this (spec §13).
5. **Phase 7** App gates: `db:generate`, `typecheck`, `lint`, `bun test tests/unit` (PG test DB), build.
6. **Phase 8** ZKTeco: `bun run test:zkteco` + duplicate/unknown-device/concurrency checks.
7. **Phase 9** Backup/restore: pg_dump → pg_restore into `hrm_restore_test` → integrity + smoke.
8. **Phase 10–11** Local staging deployment (standalone build + Caddyfile config + systemd unit review) + full browser smoke E2E (login, MFA-ready auth, employees, photo pipeline, attendance, payroll views).
9. **Phase 12** Cutover + rollback docs; **production cutover only with explicit human approval** (not performed here).

## N. Files expected to change

**Code:** `prisma/schema.prisma` (provider), `src/lib/db.ts` (drop file:-anchoring), `src/app/api/readyz/route.ts` (information_schema), search call sites adding `mode:"insensitive"` (`src/hrm-server/routes/employees.ts`, `src/hrm-server/routes/search.ts`, `src/hrm-server/routes/reports.ts`, `src/hrm-server/routes/inventory.ts` + reviewed `startsWith` sites), `src/hrm/views/settings.tsx` (help text).
**Prisma:** `prisma/migrations/` → PG baseline; `prisma/migrations_sqlite/` (archived at cutover; removed from the deliverable by audit L-6 — see the pre-cutover git history); `migration_lock.toml`.
**Tests:** `tests/preload.ts`, `bunfig.toml` (comment), retire the database-runtime build script under tests/, `scripts/e2e-test.sh` (PG cleanup), `scripts/test-zkteco-flow.sh` (DB resolution).
**Ops:** `scripts/backup.sh`, `scripts/restore-drill.sh`, `scripts/disk-check.sh`, `scripts/setup-and-seed.sh`, `scripts/check-docs.sh`, `deploy/hrm.service`, `deploy/backup.service`, **remove** `vacuum.service` unit+`vacuum.timer`, `package.json` (scripts: `db:migrate-sqlite`, `backup` unchanged target), `.env`, `.env.example`.
**New:** `scripts/migrate-sqlite-to-postgres.ts`, `docs/postgresql-migration-report.md`, `docs/postgresql-cutover.md`, `docs/postgresql-rollback.md`, `docs/postgresql-backup-restore.md`, updated `docs/BACKUP_RESTORE.md`, `DEPLOYMENT-GUIDE.md` (PG install/bootstrap), `CHANGES.md`.

## O. Files that must remain untouched

All UI views/components (except the one help-text line), `src/hrm-server/**` route logic (except the 4 search sites), `src/app/iclock/**` + `src/hrm-server/zkteco/**` (ADMS protocol), `src/hrm-server/auth.ts`/`rbac.ts`/`security.ts` (except nothing), camera providers, `middleware.ts`, `Caddyfile`s, all business rules, tests/unit/* logic, seed scripts (still dev-only), `scripts/db-push.sh` guard (already DB-agnostic).

---

## Appendices

### A1. Type mapping (verified against actual storage)

| SQLite actual | Prisma type | PostgreSQL target | Conversion |
|---|---|---|---|
| TEXT | String | text | verbatim |
| INTEGER (epoch ms) | DateTime | timestamp(3) | `new Date(n)` on import |
| TEXT ('2026-08-01') on String fields | String | text | verbatim (dates-as-strings stay strings) |
| INTEGER 0/1 | Boolean | boolean | `!== 0` |
| REAL | Float | double precision | exact (IEEE754 both sides) |
| TEXT ('{}'/'[{…}]') | String (JSON-as-text) | text | verbatim — NO jsonb |
| (none) | — | — | no Bytes / BigInt / Decimal / Json / enums in schema |

### A2. Row counts (all 45 non-empty tables)

Attendance 1237 · LeaveBalance 192 · PayrollEntry 72 · Education 48 · EmployeeDocument 48 · FamilyMember 48 · Referee 48 · ApprovalStep 39 · Employee 25 · SalaryStructure 25 · ApprovalWorkflow 24 · BankAccount 24 · EmployeeHistory 24 · Notification 24 · AttendanceRawEvent 21 · AttendanceDeviceUser 19 · LetterTemplate 19 · HrSetting 18 · AuditLog 16 · Designation 16 · Department 13 · Holiday 13 · User 11 · _prisma_migrations 11 · Camera 10 · (20 more tables ≤ 10 rows each — full list in `db_inventory.json`)

### A3. Nullable-unique audit (spec §22)

36 `@@unique` + 41 `@unique` constraints inspected. Only one contains nullable columns beyond the tenant pattern: `Camera @@unique([vendorId, serialNumber, channel])` with nullable `serialNumber` (schema comment: "NULL serialNumber treated as distinct per SQLite (accepted; cameras may pre-register)"). PostgreSQL default unique semantics also treat NULLs as distinct → **behavior preserved without partial indexes**. Regression test added.

### A4. Case-sensitivity call-site register (spec §23)

User-facing (get `mode:"insensitive"`): `src/hrm-server/routes/employees.ts` list `q` (code, fullName, mobile, officialEmail, personalEmail); `src/hrm-server/routes/search.ts` employee/global search (code, fullName, preferredName, mobile, emails, id) + employee-picker (fullName) + announcement-ish (title/description/id); `src/hrm-server/routes/reports.ts` audit summary `q`; `src/hrm-server/routes/inventory.ts` item `q`. The remaining `startsWith/endsWith` sites are code-prefix generations (e.g., `EMP-` + sequence) and protocol prefixes where case sensitivity is either irrelevant (values are machine-generated uppercase) or already exact-match — reviewed individually during implementation; only user-facing search changes.

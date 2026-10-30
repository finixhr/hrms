# PostgreSQL Cutover Runbook

> **Phase 12 — documentation only.** No production cutover has been performed.
> Cutover requires **explicit human approval** from the system owner, a
> maintenance window, and a verified rollback path (see
> `docs/postgresql-rollback.md`).
> Evidence that the migration is ready: `docs/postgresql-migration-report.md`.

## 1. Preconditions (all mandatory)

1. **Approval**: the system owner has explicitly approved the cutover date and
   window in writing. Default expectation: ≤ 1 hour of read-only downtime
   during data transfer.
2. **Rollback armed**: the immutable SQLite backup (`prisma/db/custom.db` at
   cutover time, copied to offsite storage) AND a fresh pre-cutover artifact
   are both restorable — verified by a completed restore drill
   (`bash scripts/restore-drill.sh`).
3. **Gates green on staging**: the migration report's verification suite has
   been re-run against the current data within 24 h of the window
   (reconciliation PASS, unit tests, `bun run build`, ZKTeco suite, smoke E2E).
4. **Freeze**: from the start of the window, the application is stopped or put
   in read-only mode. New writes between the final backup and the freeze are
   the only rows at risk — do not skip the freeze.
5. **Access**: PostgreSQL 16/17 server installed on the target host
   (`DEPLOYMENT-GUIDE.md` → Prerequisites), `postgresql-client` (psql,
   pg_dump, pg_restore) on the app host, and the app role/database created.

## 2. Cutover steps

### Step 1 — Snapshot the SQLite source (rollback anchor)

```bash
# never migrate from a moving source
sudo systemctl stop hrm.service          # freeze the app
cp -a prisma/db/custom.db /srv/offsite/custom.db.$(date -u +%Y%m%dT%H%M%SZ)
sha256sum /srv/offsite/custom.db.* | tee -a /srv/offsite/sqlite-manifest.txt
```

Keep this copy for the entire rollback horizon (30 days recommended). The
migration utility only **reads** `prisma/db/custom.db`; it never writes to it.

### Step 2 — Prepare the PostgreSQL database

```bash
# as the postgres superuser, once:
createuser hrm_user
psql -c "ALTER USER hrm_user WITH PASSWORD '<strong-password>';"
createdb -O hrm_user hrm_production
```

Point the deployment `.env` at it (never commit this file):

```bash
DATABASE_URL="postgresql://hrm_user:<strong-password>@127.0.0.1:5432/hrm_production"
```

Bind PostgreSQL to `127.0.0.1` or a private NIC — never expose it publicly.

### Step 3 — Apply the schema

```bash
bun run db:generate
bun run db:deploy      # prisma migrate deploy — single PG baseline
```

### Step 4 — Migrate the data

```bash
DATABASE_URL="postgresql://hrm_user:<strong-password>@127.0.0.1:5432/hrm_production" \
  bun run db:migrate-sqlite --allow-production
```

The utility refuses production-looking database names without
`--allow-production`; that flag is the deliberate human-in-the-loop gate. It
prints per-table row counts and finishes with a full reconciliation (row
checksums per table). **A reconciliation FAIL is an abort, not a warning.**

### Step 5 — Verify before going live

Minimum gate (all must pass):

```bash
# counts match the SQLite source (per the utility's reconciliation output)
psql "$DATABASE_URL" -tAc 'SELECT COUNT(*) FROM "Employee"'
psql "$DATABASE_URL" -tAc 'SELECT COUNT(*) FROM "Attendance"'

# app-level health + readiness
curl -s http://127.0.0.1:3000/api/health     # {"ok":true,"db":"up",…}
curl -s http://127.0.0.1:3000/api/readyz     # ready:true, migrations ok

# login smoke with a known account, one search, one payroll view
```

For a first cutover, prefer re-running the staging verification suite
(ZKTeco suite, restore drill, browser smoke) against a COPY of the production
database before allowing writes.

### Step 6 — Go live

```bash
sudo systemctl start hrm.service      # After=postgresql.service handles ordering
sudo systemctl enable --now backup.timer restore-drill.timer
```

Watch the first night's backup complete, then record the cutover in the ops
log: timestamp, source row counts, destination row counts, verification
results, and who approved it.

### Step 7 — Post-cutover housekeeping

- Keep the SQLite file read-only on disk for the rollback horizon; after it,
  archive it offsite (it remains the canonical pre-migration record).
- Run `bash scripts/restore-drill.sh` once in the first week on real backups.
- Update the vendor's monitoring: `/api/readyz` now checks
  `information_schema`; add a PostgreSQL connection/latency alert if the
  monitoring stack supports it.

## 3. Abort criteria

Abort the window and roll back (see `docs/postgresql-rollback.md`) if ANY of:

- reconciliation reports any table mismatch that cannot be re-run cleanly;
- `/api/readyz` reports `migrations` or `db` failing after Step 3/4;
- login or payroll smoke fails after Step 5;
- the window exceeds the approved downtime budget.

A partial cutover (schema applied, data incomplete) is safe to abandon: the
SQLite source is untouched and the app simply restarts against it.

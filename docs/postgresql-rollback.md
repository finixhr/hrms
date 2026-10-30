# PostgreSQL Rollback Runbook

> Companion to `docs/postgresql-cutover.md`. Rollback is a **drilled, timed
> procedure**, not an improvisation: rehearse it on staging before every
> cutover window. RTO target: 1 hour from decision to production traffic.

## 1. Decision framework

| Situation | Action |
|---|---|
| Cutover window still open, gates failed (reconciliation/readyz/login) | **Immediate rollback** — SQLite source is untouched; restart the app against it. Zero data loss. |
| Post-go-live incident, within 24 h, few new writes | Prefer **fix-forward** (patch + redeploy); if not feasible, roll back and replay/re-enter the post-cutover writes manually (they are enumerable — see §3). |
| Post-go-live, days of new writes | Roll back only for catastrophic failure. Consider restoring PostgreSQL from backup instead (same engine, no reversal needed). |

Rule of thumb: rolling back the ENGINE reverses writes written after cutover;
restoring from a PostgreSQL backup only loses writes after the backup. Choose
the smallest loss that fixes the incident.

## 2. Rollback to SQLite (engine reversal)

Preconditions: the archived pre-cutover SQLite file (cutover Step 1) and the
pre-migration application build.

```bash
# 1. stop the app and take a safety snapshot of the PG database (never lose data)
sudo systemctl stop hrm.service
pg_dump "$DATABASE_URL" --format=custom --file=backups/pg-before-rollback-$(date -u +%Y%m%dT%H%M%SZ).dump

# 2. restore the archived SQLite file into place
cp -a /srv/offsite/custom.db.<STAMP> prisma/db/custom.db
sha256sum -c <(grep custom.db.<STAMP> /srv/offsite/sqlite-manifest.txt)

# 3. deploy the pre-migration application build (the pre-cutover git tag
#    carries the SQLite schema history and the file:-anchoring db client;
#    the archived migrations_sqlite directory was removed from the current
#    tree by audit L-6 — it exists in the pre-cutover history only)
git checkout <pre-migration-tag>      # or re-extract the pre-migration archive
bun install && bun run db:generate && bun run build

# 4. point .env back at SQLite
#    DATABASE_URL="file:./db/custom.db"

# 5. verify and go live
sudo systemctl start hrm.service
curl -s http://127.0.0.1:3000/api/readyz
```

## 3. Handling writes created after cutover

The SQLite rollback target predates cutover; anything written to PostgreSQL
afterwards is not in it. Recover them in this order:

1. **Enumerate**: query the PG snapshot for rows created after the cutover
   timestamp (`createdAt` exists on business tables; the audit trail in
   `AuditLog` also records every mutation with an actor).
2. **Re-enter** the business-critical ones (attendance punches, leave
   requests, payroll runs) through the application UI or audited scripts.
3. **Notify** affected employees/managers for anything not re-entered before
   the next payroll run.

If the volume is large, an alternative is a targeted export from the PG
snapshot (`psql --csv`) and a reviewed manual import — but do NOT attempt an
automated reverse migration without a reconciliation pass; the utility in
`scripts/migrate-sqlite-to-postgres.ts` is one-directional by design.

## 4. Rollback within PostgreSQL (restore from backup)

For engine-unrelated incidents (bad deploy, data corruption), restore the
latest verified backup instead of reversing engines:

```bash
bash scripts/backup.sh                       # fresh backup of current state first
BACKUP_PASSPHRASE="$HRM_BACKUP_KEY" openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 \
  -in backups/hrm-<STAMP>.dump.enc -out /tmp/hrm.dump -pass env:BACKUP_PASSPHRASE
psql "postgresql://postgres@127.0.0.1:5432/postgres" -c 'DROP DATABASE hrm_production WITH (FORCE);'
psql "postgresql://postgres@127.0.0.1:5432/postgres" -c 'CREATE DATABASE hrm_production OWNER hrm_user;'
pg_restore --dbname "$DATABASE_URL" --no-owner --no-privileges /tmp/hrm.dump
```

The quarterly drill (`bash scripts/restore-drill.sh`) exercises exactly this
path into a scratch database and verifies table counts plus payroll totals.

## 5. Post-rollback actions

- Freeze automatic backups until the story is written (avoid backing up a
  state you may not want to keep); re-enable afterwards.
- File an incident record: trigger, decision point, data delta, re-entry list.
- Re-plan the next cutover attempt with the failure addressed; the migration
  utility is idempotent (`--fresh` recreates the destination from source).

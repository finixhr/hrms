# PostgreSQL Backup & Restore Runbook

> Authoritative runbook for the HRMS_CCTV backup subsystem on PostgreSQL.
> This is the full reference; the operator quick-reference is
> `docs/BACKUP_RESTORE.md`. The subsystem was verified end-to-end during the
> migration (two encrypted-backup restore drills passed — see
> `docs/postgresql-migration-report.md` §5).

## 1. Architecture

- **Nightly backup** at 02:30 server-local via `deploy/backup.timer` →
  `deploy/backup.service` → `scripts/backup.sh`.
- **Format**: `pg_dump --format=custom` — a single compressed file restored
  with `pg_restore` (no superuser rights needed; dump taken with
  `--no-owner --no-privileges` so role grants stay deployment-owned).
- **Verification at creation**: the dump must list the core tables in
  `pg_restore --list` output before it is called a backup.
- **Encryption by default** (`BACKUP_ENCRYPT=true`): OpenSSL AES-256-CBC with
  PBKDF2 (600,000 iterations, per OWASP 2023 guidance), key from
  `HRM_BACKUP_KEY` — never inline, never in the repo.
- **Integrity manifest**: SHA-256 checksum written next to every backup; the
  restore drill refuses a checksum mismatch.
- **Offsite sync** (optional): `BACKUP_OFFSITE_CMD` — an rclone/rsync-style
  command where `{file}` is substituted with the absolute backup path.
- **Retention**: 14 days local by default (`BACKUP_KEEP_DAYS`).
- **Failure alerting**: `scripts/backup-alert.ts` emails via the configured
  gateway (best-effort, never blocks the exit code).
- **RPO / RTO**: 24 h / 1 h. Backups land in `backups/` (gitignored).

## 2. Configuration (environment)

| Variable | Required | Purpose |
|---|---|---|
| `DATABASE_URL` | yes | Target PostgreSQL URL (app role is sufficient for pg_dump) |
| `HRM_BACKUP_KEY` | yes (encrypted mode) | 32-char hex key — generate with `openssl rand -hex 32` |
| `BACKUP_ENCRYPT` | no (default `true`) | Set `false` only for throwaway snapshots |
| `BACKUP_DIR` | no (default `backups/`) | Destination directory |
| `BACKUP_KEEP_DAYS` | no (default `14`) | Local retention before pruning |
| `BACKUP_OFFSITE_CMD` | no | e.g. `rclone copy {file} offsite:hrm-backups/` |
| `HRM_BACKUP_ALERT_EMAIL` | no | Failure-alert recipient |

## 3. Manual backup

```bash
bash scripts/backup.sh
# BACKUP_DIR=/somewhere bash scripts/backup.sh     # custom destination
```

Output: `backups/hrm-<UTC-STAMP>.dump.enc` + `hrm-<UTC-STAMP>.dump.enc.sha256`.
The script exits non-zero on any failure (missing pg_dump, failed dump
verification, encryption without a key) and fires the alert hook.

## 4. Restore procedure

> **RTO target: 1 hour** from backup availability to production traffic.

### 4.1 Decrypt (encrypted backups)

```bash
BACKUP_PASSPHRASE="$HRM_BACKUP_KEY" openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 \
  -in backups/hrm-<STAMP>.dump.enc -out /tmp/hrm.dump -pass env:BACKUP_PASSPHRASE
```

### 4.2 Verify integrity

```bash
cd backups && sha256sum -c hrm-<STAMP>.dump.enc.sha256 && cd ..
pg_restore --list /tmp/hrm.dump | head     # sane TOC: tables, indexes, data
```

### 4.3 Restore into the target database

```bash
# stop writers first
sudo systemctl stop hrm.service

# recreate the database (DANGER: this replaces the target's contents)
psql "postgresql://postgres@127.0.0.1:5432/postgres" -c 'DROP DATABASE hrm_production WITH (FORCE);'
psql "postgresql://postgres@127.0.0.1:5432/postgres" -c 'CREATE DATABASE hrm_production OWNER hrm_user;'
pg_restore --dbname "$DATABASE_URL" --no-owner --no-privileges --exit-on-error /tmp/hrm.dump

# verify + restart
psql "$DATABASE_URL" -tAc 'SELECT COUNT(*) FROM "Employee"'
sudo systemctl start hrm.service
curl -s http://127.0.0.1:3000/api/readyz
```

## 5. Quarterly restore drill (automated)

```bash
bash scripts/restore-drill.sh                    # auto-picks the newest backup
FILE=backups/hrm-<STAMP>.dump.enc bash scripts/restore-drill.sh
```

The drill restores into the disposable `hrm_restore_test` database (never
production; it refuses names containing "production"), verifies: checksum →
decrypt → `pg_restore` clean → ≥90 tables → Employee/User counts → payroll
run-totals vs entry-sums (0 mismatches, 1-taka tolerance) → the app's
readiness contract tables → drops the scratch database. Results append to
`backups/restore-drill.log`. Schedule it with `deploy/restore-drill.timer`
(quarterly). A failed drill is a P1: the backups are the incident.

## 6. Bootstrap from a backup onto a new host

1. Install PostgreSQL 16/17 + `postgresql-client` (see `DEPLOYMENT-GUIDE.md`).
2. Create the app role and an empty `hrm_production` database (§4.3).
3. Copy the `.dump.enc` + `.sha256` pair offsite, verify the checksum.
4. Follow §4 (decrypt → verify → restore).
5. Deploy the application, run `bun run db:deploy` ONLY if the dump predates
   the baseline migration (a dump taken by this subsystem already contains
   `_prisma_migrations`).
6. Enable `backup.timer` + `restore-drill.timer` immediately — a restored
   system without backups is half a system.

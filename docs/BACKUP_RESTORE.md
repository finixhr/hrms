# HRMS_CCTV — Backup & Restore Runbook (PostgreSQL)

> Operator quick-reference. The **full reference** (env-var table, bootstrap-
> from-backup, key rotation detail) is `docs/postgresql-backup-restore.md`.
> This file was rewritten for the SQLite → PostgreSQL migration (2026-09-30):
> the database is PostgreSQL, backups are `pg_dump` custom-format dumps, and
> restores use `pg_restore`. Verified end-to-end during the migration — two
> encrypted-backup restore drills passed (see
> `docs/postgresql-migration-report.md`).

## 1. Backup architecture (verified)

- **Nightly backup** at 02:30 server-local via `deploy/backup.timer` →
  `deploy/backup.service` → `scripts/backup.sh`
- **Format**: `pg_dump --format=custom` (single compressed file; restored with
  `pg_restore`; `--no-owner --no-privileges` so role grants stay
  deployment-owned)
- **Verification at creation**: dump must list Employee/User/PayrollRun in
  `pg_restore --list` before it is called a backup
- **Encryption**: AES-256-CBC + PBKDF2 (600,000 iterations, per OWASP 2023)
  with the key from `HRM_BACKUP_KEY` — on by default
- **Manifest**: SHA-256 checksum alongside every `.dump.enc`
- **Retention**: 14 days local (configurable via `BACKUP_KEEP_DAYS`)
- **Offsite sync**: optional `BACKUP_OFFSITE_CMD` (rclone/rsync-style; `{file}`
  is substituted)
- **Alert**: `scripts/backup-alert.ts` emails on failure only
- **Pre-flight**: `scripts/disk-check.sh` fails fast when headroom is short
- **RPO / RTO**: 24 h / 1 h

## 2. Manual backup

```bash
sudo systemctl start hrm-backup.service     # via systemd, journal follows
sudo journalctl -u hrm-backup.service -f

# or directly (same code path):
bash scripts/backup.sh
```

The script: disk pre-flight → `pg_dump` → `pg_restore --list` verification →
openssl encryption → SHA-256 manifest → optional offsite sync → retention
pruning. Any failure exits non-zero and triggers the email alert.

## 3. Restore procedure

> **RTO target**: 1 hour from backup availability to production traffic.

### 3.1 Stop the HRM server
```bash
sudo systemctl stop hrm.service
```

### 3.2 Pick the backup + verify checksum
```bash
LATEST=$(ls -t backups/hrm-*.dump.enc | head -1)
echo "Restoring from: $LATEST"
cd backups && sha256sum -c "$(basename $LATEST).sha256"; cd ..
```

### 3.3 Decrypt
```bash
BACKUP_PASSPHRASE="$HRM_BACKUP_KEY" openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 \
  -in "$LATEST" -out /tmp/hrm-restore.dump -pass env:BACKUP_PASSPHRASE
pg_restore --list /tmp/hrm-restore.dump | head    # sane table-of-contents
```

### 3.4 Safety-net the current database, then restore
```bash
pg_dump "$DATABASE_URL" --format=custom --file=backups/pg-before-restore-$(date -u +%Y%m%dT%H%M%SZ).dump

psql "postgresql://postgres@127.0.0.1:5432/postgres" -c 'DROP DATABASE hrm_production WITH (FORCE);'
psql "postgresql://postgres@127.0.0.1:5432/postgres" -c 'CREATE DATABASE hrm_production OWNER hrm_user;'
pg_restore --dbname "$DATABASE_URL" --no-owner --no-privileges --exit-on-error /tmp/hrm-restore.dump
rm /tmp/hrm-restore.dump
```

### 3.5 Start + verify end-to-end
```bash
sudo systemctl start hrm.service
sudo journalctl -u hrm.service -f
```
- `https://<your-host>/api/health` → `{"ok":true,"db":"up"}`
- `https://<your-host>/api/readyz` → `ready:true` (DB + migrations + queue)
- Log in as owner; confirm employee count and the last payroll run
- `bun run scripts/verify-seed.ts` (database consistency check)

## 4. Restore drill (quarterly — automated)

```bash
sudo systemctl start hrm-restore-drill.service
sudo journalctl -u hrm-restore-drill.service -f
# or directly:
bash scripts/restore-drill.sh
```

The drill picks the newest backup, verifies the checksum, decrypts, restores
via `pg_restore` into the disposable `hrm_restore_test` database (never
production — names containing "production" are refused), then checks: ≥90
tables, Employee/User counts, payroll run-totals vs entry-sums (0 mismatches,
1-taka tolerance), and the app readiness-contract tables. The scratch database
is dropped afterwards; the live database is untouched. Results append to
`backups/restore-drill.log`. **A failed drill is a P1** — your backups are the
incident.

## 5. Offsite backup integrity (OPS-R15)

After every offsite sync via `BACKUP_OFFSITE_CMD`, diff the remote checksum
against the local manifest:

```bash
# Example for rclone:
rclone cat <remote>:hrm-backups/$(basename $LATEST).sha256 | diff - <(cat $LATEST.sha256)
```

A mismatch fires `scripts/backup-alert.ts` with the subject
"OFFSITE BACKUP INTEGRITY MISMATCH".

## 6. Key rotation

1. Generate the new key: `openssl rand -hex 32`
2. Decrypt existing backups with the OLD key; re-encrypt with the NEW key
3. Update the deployment env (`/etc/systemd/system/hrm-backup.env`)
4. Restart the backup service; confirm the next nightly run
5. Update the offside tooling config if it stores the key
6. Destroy the old key from every persisted location

## 7. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `HRM_BACKUP_KEY is not set` | env file missing/not loaded | check `/etc/systemd/system/hrm-backup.env` exists and `EnvironmentFile=` is set in `deploy/backup.service` |
| `pg_dump not found` | client tools missing | `apt-get install postgresql-client-17` (see `DEPLOYMENT-GUIDE.md` prerequisites) |
| checksum mismatch in drill | corrupt/tampered backup | fetch the previous nightly backup; treat as P1 |
| `pg_restore` errors | dump/tool major-version skew | restore with the same or newer `pg_restore` major version than the dump |
| Payroll totals mismatch | inconsistent backup mid-payroll | use an older backup from before the failed payroll run |
| `bun: command not found` in drill | bun not in systemd PATH | `ln -s /home/hrm/.bun/bin/bun /usr/local/bin/bun` |
| Backup timer does not fire | timer disabled | `sudo systemctl enable --now hrm-backup.timer` |

## 8. Multi-instance note

Single-instance (one app node + one PostgreSQL node) is the supported
production shape. Multi-instance deployments additionally require Redis for
the rate-limit throttle, the BgJob queue, and the camera token cache — see
`DEPLOYMENT-GUIDE.md` for the multi-instance checklist. Backups are engine-
level (`pg_dump`) and unaffected by app node count; a PostgreSQL streaming
replica (physical WAL) can complement — not replace — the nightly dump RPO.

#!/usr/bin/env bash
# ============ PostgreSQL backup: pg_dump + encryption + checksum + offsite + retention ============
# H-11 (updated for PostgreSQL 2026-09-30): production-grade backup.
#   • Logical snapshot via pg_dump --format=custom (compressed, pg_restore-able)
#     — replaces the former SQLite python-backup API after the migration.
#   • Encrypted by DEFAULT (BACKUP_ENCRYPT=true) with the key from HRM_BACKUP_KEY.
#   • SHA-256 checksum manifest written alongside every backup.
#   • Optional offsite sync (BACKUP_OFFSITE_CMD, e.g. an rclone/rsync command).
#   • Failure alerting through the existing email gateway (scripts/backup-alert.ts).
#   • Restore verification: scripts/restore-drill.sh (pg_restore into a scratch DB).
#
# Usage:
#   bash scripts/backup.sh                        # encrypted snapshot into backups/
#   BACKUP_ENCRYPT=false bash scripts/backup.sh   # plain snapshot (NOT recommended)
#
# Destination DB comes from DATABASE_URL (never hardcoded). The connection uses
# the app role; no superuser rights are required for pg_dump.
set -euo pipefail
cd "$(dirname "$0")/.."

BACKUP_DIR="${BACKUP_DIR:-backups}"
KEEP_DAYS="${BACKUP_KEEP_DAYS:-14}"
# H-11 — encrypted by DEFAULT. Key MUST come from HRM_BACKUP_KEY (never inline).
BACKUP_ENCRYPT="${BACKUP_ENCRYPT:-true}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
TARGET="$BACKUP_DIR/hrm-$STAMP.dump"

# ---------- destination resolution ----------
DB_URL="${DATABASE_URL:-}"
if [ -z "$DB_URL" ]; then
  echo "ERROR: DATABASE_URL is not set — refusing to guess a database target." >&2
  echo "       Set DATABASE_URL to the PostgreSQL URL (e.g. postgresql://hrm_user@127.0.0.1:5432/hrm_production)." >&2
  exit 1
fi
if ! command -v pg_dump >/dev/null 2>&1; then
  echo "ERROR: pg_dump not found on PATH. Install the PostgreSQL client tools" >&2
  echo "       (Debian/Ubuntu: apt-get install postgresql-client-17) — see DEPLOYMENT-GUIDE.md." >&2
  exit 1
fi
# pre-flight disk-space check (OPS-R10) — still applicable: dumps need headroom
bash scripts/disk-check.sh "$BACKUP_DIR" || true

on_failure() {
  local code=$?
  echo "✗ BACKUP FAILED (exit $code) at $(date -u +%Y-%m-%dT%H:%M:%SZ)" >&2
  # H-11 — alert through the existing email gateway (best-effort, never blocks)
  if [ -x "$(command -v bun)" ]; then
    bun run scripts/backup-alert.ts \
      "HRM backup FAILED on $(hostname)" \
      "The nightly backup on $(hostname) failed with exit code $code at $(date -u +%Y-%m-%dT%H:%M:%SZ). See the systemd journal (backup.service) for the full log. Database: $DB_URL" \
      || echo "  (email alert could not be sent — is the email gateway configured?)" >&2
  fi
  exit $code
}
trap on_failure ERR

mkdir -p "$BACKUP_DIR"

echo "▸ pg_dump (custom format, compressed) → $TARGET"
# --format=custom : single compressed file, restored with pg_restore
# --no-owner      : restore does not require the source role to exist
# --no-privileges : role grants are managed by the deployment, not the dump
pg_dump "$DB_URL" --format=custom --no-owner --no-privileges --file="$TARGET"

# verify the dump is usable BEFORE calling it a backup: it must parse and list
# the core tables (restore-side proof lives in scripts/restore-drill.sh)
if ! command -v pg_restore >/dev/null 2>&1; then
  echo "⚠️  pg_restore not found on PATH — could not verify the dump listing (install postgresql-client-17)." >&2
else
  LISTING="$(pg_restore --list "$TARGET")"
  for t in Employee User PayrollRun; do
    if ! grep -qE "TABLE [^ ]+ $t( |$)" <<<"$LISTING"; then
      echo "✗ dump verification failed: core table $t missing from pg_restore --list output" >&2
      exit 1
    fi
  done
  echo "  dump verified (core tables present in pg_restore --list)"
fi

if [ "$BACKUP_ENCRYPT" = "true" ]; then
  # H-11 — key from HRM_BACKUP_KEY only; refuse to ship an unencrypted backup silently
  if [ -z "${HRM_BACKUP_KEY:-}" ]; then
    echo "ERROR: BACKUP_ENCRYPT=true but HRM_BACKUP_KEY is not set." >&2
    echo "       Generate one: openssl rand -hex 32 → store it in the deployment env (not the repo)." >&2
    exit 1
  fi
  # T2-013 — AES-256-GCM (authenticated encryption); CBC has no auth tag so
  # ciphertext tampering goes undetected. GCM provides confidentiality + integrity.
  echo "▸ encrypting (openssl aes-256-gcm, key from HRM_BACKUP_KEY)"
  BACKUP_PASSPHRASE="$HRM_BACKUP_KEY" openssl enc -aes-256-gcm -pbkdf2 -salt -iter 600000 -in "$TARGET" -out "$TARGET.enc" -pass env:BACKUP_PASSPHRASE
  rm "$TARGET"
  FINAL="$TARGET.enc"
  echo "✅ encrypted backup: $FINAL"
else
  FINAL="$TARGET"
  echo "⚠️  PLAIN (unencrypted) backup: $FINAL — set BACKUP_ENCRYPT=true (default) + HRM_BACKUP_KEY for production."
fi

# ---------- H-11: SHA-256 checksum manifest ----------
# Written from inside the backup dir so the manifest references the bare
# filename (portable: `sha256sum -c` works wherever the pair lives together).
(cd "$BACKUP_DIR" && sha256sum "$(basename "$FINAL")" > "$(basename "$FINAL").sha256")
echo "▸ checksum manifest: $FINAL.sha256 ($(cut -d' ' -f1 "$FINAL.sha256" | head -c 16)…)"

# ---------- H-11: offsite sync (placeholder — configure per deployment) ----------
# BACKUP_OFFSITE_CMD is an rclone/rsync-style command in which {file} is
# substituted with the absolute backup path, e.g.:
#   BACKUP_OFFSITE_CMD='rclone copy {file} offsite:hrm-backups/'
#   BACKUP_OFFSITE_CMD='rsync -a {file} backup.example.com:/srv/hrm-backups/'
if [ -n "${BACKUP_OFFSITE_CMD:-}" ]; then
  echo "▸ offsite sync"
  CMD="${BACKUP_OFFSITE_CMD//\{file\}/$(readlink -f "$FINAL")}"
  if eval "$CMD"; then
    echo "  offsite sync complete"
  else
    echo "  ⚠️ offsite sync FAILED — backup remains local" >&2
  fi
else
  echo "▸ offsite sync skipped (set BACKUP_OFFSITE_CMD — see docs/postgresql-backup-restore.md)"
fi

# retention
find "$BACKUP_DIR" -name 'hrm-*.dump*' -mtime +"$KEEP_DAYS" -delete 2>/dev/null || true
echo "▸ retention: snapshots older than $KEEP_DAYS day(s) pruned"

trap - ERR
cat <<NOTE

Restore drill (automated: bash scripts/restore-drill.sh — run at least quarterly):
  # plain:     pg_restore --dbname <scratch_db> --no-owner $FINAL
  # encrypted: openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 -in $FINAL -out hrm.dump -pass env:BACKUP_PASSPHRASE
  # verify:    psql <scratch_db> -c 'SELECT count(*) FROM "Employee"'
  Full runbook: docs/postgresql-backup-restore.md
NOTE

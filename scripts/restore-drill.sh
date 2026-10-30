#!/usr/bin/env bash
# ============ H-11 (PostgreSQL) — restore drill: PROVE the backups restore ============
# Restores the newest backup into a THROWAWAY scratch database via pg_restore,
# verifies core tables + row counts + the payroll-totals spot-check, then drops
# the scratch database. Nothing touches the live database.
#
# Usage: bash scripts/restore-drill.sh          # auto-picks the latest backup
#        FILE=backups/hrm-….dump.enc bash scripts/restore-drill.sh
#        DRILL_DB=hrm_restore_test bash scripts/restore-drill.sh
#
# Exit codes: 0 = drill passed · 1 = drill failed · 2 = no backup found
#
# Requires: pg_restore + psql on PATH, and a scratch database the current role
# may create/drop (DRILL_DB, default hrm_restore_test — created & dropped here;
# for sandboxed servers pre-create it once with:
#   psql "postgresql://postgres@127.0.0.1:5432/postgres" -c 'CREATE DATABASE hrm_restore_test'
# and pass ADMIN_URL below).
set -euo pipefail
cd "$(dirname "$0")/.."

RESULT_LOG="backups/restore-drill.log"
log() { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*" | tee -a "$RESULT_LOG"; }

BACKUP_DIR="${BACKUP_DIR:-backups}"
DRILL_DB="${DRILL_DB:-hrm_restore_test}"
ADMIN_URL="${ADMIN_URL:-${DATABASE_URL:-postgresql://postgres@127.0.0.1:5432/postgres}}"
mkdir -p "$BACKUP_DIR" "$(dirname "$RESULT_LOG")"

# ---------- 1. pick the newest backup ----------
if [ -n "${FILE:-}" ]; then
  FINAL="$FILE"
else
  FINAL="$(ls -1t "$BACKUP_DIR"/hrm-*.dump.enc "$BACKUP_DIR"/hrm-*.dump 2>/dev/null | head -1 || true)"
fi
if [ -z "${FINAL:-}" ] || [ ! -f "$FINAL" ]; then
  log "FAIL: no backup found in $BACKUP_DIR — run scripts/backup.sh first."
  exit 2
fi
log "drill start — backup: $FINAL"

# ---------- 2. verify the checksum manifest (when present) ----------
if [ -f "$FINAL.sha256" ]; then
  if (cd "$BACKUP_DIR" && sha256sum -c "$(basename "$FINAL").sha256" >/dev/null 2>&1); then
    log "checksum OK ($(basename "$FINAL").sha256)"
  else
    log "FAIL: checksum mismatch for $FINAL — the backup is corrupt or tampered."
    exit 1
  fi
else
  log "WARN: no checksum manifest for $FINAL (pre-H-11 backup?)"
fi

# ---------- 3. decrypt to a temp dump ----------
DRILL_DIR="$(mktemp -d)"
trap 'rm -rf "$DRILL_DIR"' EXIT
RESTORED="$DRILL_DIR/hrm-restored.dump"
case "$FINAL" in
  *.enc)
    if [ -z "${HRM_BACKUP_KEY:-}" ]; then
      log "FAIL: encrypted backup but HRM_BACKUP_KEY is not set."
      exit 1
    fi
    BACKUP_PASSPHRASE="$HRM_BACKUP_KEY" openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 -in "$FINAL" -out "$RESTORED" -pass env:BACKUP_PASSPHRASE
    ;;
  *) cp "$FINAL" "$RESTORED" ;;
esac
log "decrypted to $RESTORED ($(stat -c%s "$RESTORED") bytes)"

# ---------- 4. recreate the scratch DB and pg_restore into it ----------
# The drill database is disposable by definition: it is dropped and recreated
# on every drill run. It must never be the production database.
if [[ "$DRILL_DB" == *production* ]]; then
  log "FAIL: refusing to drill into a database named '$DRILL_DB'."
  exit 1
fi
psql "$ADMIN_URL" -v ON_ERROR_STOP=0 -c "DROP DATABASE IF EXISTS \"$DRILL_DB\" WITH (FORCE);" >/dev/null 2>&1 || true
psql "$ADMIN_URL" -v ON_ERROR_STOP=1 -c "CREATE DATABASE \"$DRILL_DB\";" >/dev/null
APP_URL="${DATABASE_URL%/*}/$DRILL_DB"
if ! pg_restore --dbname "$APP_URL" --no-owner --no-privileges --exit-on-error "$RESTORED"; then
  log "FAIL: pg_restore reported errors — the backup does not restore cleanly."
  exit 1
fi
log "pg_restore into $DRILL_DB completed cleanly"

# ---------- 5. integrity + row counts + payroll-totals spot check ----------
psql "$APP_URL" -v ON_ERROR_STOP=1 <<'SQL' | tee -a "$RESULT_LOG"
DO $$
DECLARE
  tables int;
  employees int;
  users int;
  runs int;
  mismatch int;
BEGIN
  SELECT COUNT(*) INTO tables FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE';
  IF tables < 90 THEN
    RAISE EXCEPTION 'restored DB has only % tables (expected >= 90)', tables;
  END IF;
  RAISE NOTICE '  core schema OK (% tables)', tables;

  SELECT COUNT(*) INTO employees FROM "Employee";
  SELECT COUNT(*) INTO users FROM "User";
  RAISE NOTICE '  rows: Employee=% User=%', employees, users;

  -- payroll-totals spot check: every PAID run's stored totals match its entries
  SELECT COUNT(*) INTO mismatch FROM (
    SELECT pr."id", pr."totalGross", pr."totalNet",
           COALESCE((SELECT SUM(pe."gross") FROM "PayrollEntry" pe WHERE pe."runId" = pr."id"), 0) AS g,
           COALESCE((SELECT SUM(pe."net")   FROM "PayrollEntry" pe WHERE pe."runId" = pr."id"), 0) AS n
    FROM "PayrollRun" pr
  ) x WHERE ABS(x."totalGross" - x.g) > 1 OR ABS(x."totalNet" - x.n) > 1;
  IF mismatch > 0 THEN
    RAISE EXCEPTION 'payroll totals mismatch on % run(s)', mismatch;
  END IF;
  RAISE NOTICE '  payroll totals spot-check OK (0 mismatches, taka tolerance 1)';
END $$;
SQL
log "integrity checks passed on $DRILL_DB"

# ---------- 6. application smoke: readiness contract ----------
# The restored DB must expose the tables the app's /api/readyz probes for.
for t in Employee _prisma_migrations; do
  if ! psql "$APP_URL" -tAc "SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='$t'" | grep -q 1; then
    log "FAIL: readyz contract table $t missing after restore."
    exit 1
  fi
done
log "readiness contract satisfied (Employee + _prisma_migrations present)"

# ---------- 7. cleanup ----------
psql "$ADMIN_URL" -c "DROP DATABASE IF EXISTS \"$DRILL_DB\" WITH (FORCE);" >/dev/null 2>&1 || true
log "drill PASSED — scratch database dropped, backup proven restorable."

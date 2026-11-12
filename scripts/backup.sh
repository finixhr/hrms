#!/usr/bin/env bash
# ============ PostgreSQL backup: pg_dump + encryption + checksum + offsite + retention ============
# H-11 (updated for PostgreSQL 2026-09-30): production-grade backup.
#   • Logical snapshot via pg_dump --format=custom (compressed, pg_restore-able)
#     — replaces the former SQLite python-backup API after the migration.
#   • Encrypted by DEFAULT (BACKUP_ENCRYPT=true) with the key from HRM_BACKUP_KEY.
#   • SHA-256 checksum manifest written alongside every backup.
#   • REQUIRED offsite copy (OPS-3, 2026-11-09 P1 wave): BACKUP_OFFSITE_CMD
#     is dispatched on a known command name (rsync | scp | rclone | aws) —
#     NO eval. A missing command or a failed copy is FATAL by default;
#     HRM_BACKUP_OFFSITE_OPTIONAL=1 restores the legacy optional behavior.
#   • Failure alerting through the existing email gateway (scripts/backup-alert.ts).
#   • Restore verification: scripts/restore-drill.sh (pg_restore into a scratch DB).
#
# Usage:
#   bash scripts/backup.sh                        # encrypted snapshot into backups/
#   BACKUP_ENCRYPT=false bash scripts/backup.sh   # plain snapshot (NOT recommended)
#   BACKUP_OFFSITE_CMD='rclone copy {file} offsite:hrm-backups/' bash scripts/backup.sh
#                                                  # snapshot + REQUIRED offsite copy
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
  # FIN-001 (Phase 0) — never leave the PLAINTEXT dump behind on a failed run.
  # The old flow aborted at the encryption step and exited with the
  # unencrypted $TARGET still on disk (every night, for as long as the broken
  # GCM invocation lived there). In encrypt mode the plaintext dump is an
  # intermediate artifact ONLY: it must not survive any failure path. In
  # BACKUP_ENCRYPT=false mode the plain dump IS the deliverable — keep it.
  if [ "${BACKUP_ENCRYPT:-true}" = "true" ] && [ -f "$TARGET" ] && [ ! -f "$TARGET.enc" ]; then
    rm -f "$TARGET"
    echo "  removed the unencrypted intermediate dump $TARGET (no ciphertext was produced)" >&2
  fi
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
  # FIN-001 (Phase 0) — aes-256-cbc + PBKDF2, matching scripts/restore-drill.sh
  # and docs/postgresql-backup-restore.md EXACTLY. The former `-aes-256-gcm`
  # here was a silent P0: `openssl enc` does not support AEAD ciphers at all,
  # so the invocation failed on EVERY run (after the plaintext dump had landed
  # on disk), the trap aborted the script, and no encrypted backup ever existed.
  # Integrity is not lost: the SHA-256 manifest below is the tamper-evidence
  # layer, and scripts/restore-drill.sh verifies it BEFORE decrypting.
  echo "▸ encrypting (openssl aes-256-cbc + pbkdf2, key from HRM_BACKUP_KEY)"
  if ! BACKUP_PASSPHRASE="$HRM_BACKUP_KEY" openssl enc -aes-256-cbc -pbkdf2 -salt -iter 600000 -in "$TARGET" -out "$TARGET.enc" -pass env:BACKUP_PASSPHRASE; then
    echo "ERROR: openssl encryption failed — removing the plaintext intermediate dump." >&2
    rm -f "$TARGET"
    exit 1
  fi
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

# ---------- OPS-3 (2026-11-09 P1 wave): REQUIRED offsite sync ----------
# The old flow eval'd BACKUP_OFFSITE_CMD verbatim — arbitrary shell execution
# as the backup user (a compromised env var was a code-execution foothold) —
# and only WARNED when the copy failed, so a deployment that never configured
# it (or whose offsite target silently broke) produced local-only "backups"
# every night. Now:
#   • BACKUP_OFFSITE_CMD is whitespace-split into argv (NO shell evaluation:
#     no quoting, pipes, $(), or semicolons — arguments are passed VERBATIM)
#     and dispatched on a KNOWN command name: rsync | scp | rclone | aws.
#     {file} is replaced with the absolute path of the final artifact.
#     Anything else is a configuration error and FAILS the run.
#   • A missing BACKUP_OFFSITE_CMD or a failed copy is FATAL by default —
#     a backup that never left the host is not a backup.
#   • Escape hatch (legacy optional behavior, per-deployment opt-in):
#       HRM_BACKUP_OFFSITE_OPTIONAL=1
#     keeps the OLD semantics: unset = skip with a warning, failed copy =
#     warning, backup stays local. NOT recommended — offsite is the point.
# Examples:
#   BACKUP_OFFSITE_CMD='rclone copy {file} offsite:hrm-backups/'
#   BACKUP_OFFSITE_CMD='rsync -a {file} backup.example.com:/srv/hrm-backups/'
#   BACKUP_OFFSITE_CMD='scp {file} backup.example.com:/srv/hrm-backups/'
#   BACKUP_OFFSITE_CMD='aws s3 cp {file} s3://my-bucket/hrm-backups/'
OFFSITE_OPTIONAL="${HRM_BACKUP_OFFSITE_OPTIONAL:-0}"
if [ -z "${BACKUP_OFFSITE_CMD:-}" ]; then
  if [ "$OFFSITE_OPTIONAL" = "1" ]; then
    echo "▸ offsite sync skipped (HRM_BACKUP_OFFSITE_OPTIONAL=1 — legacy optional behavior; set BACKUP_OFFSITE_CMD, see docs/postgresql-backup-restore.md)" >&2
  else
    echo "✗ BACKUP FAILED: BACKUP_OFFSITE_CMD is not set — the offsite copy is REQUIRED (OPS-3)." >&2
    echo "  Configure one of the supported commands (rsync | scp | rclone | aws), e.g.:" >&2
    echo "    BACKUP_OFFSITE_CMD='rclone copy {file} offsite:hrm-backups/'" >&2
    echo "  Legacy optional behavior: HRM_BACKUP_OFFSITE_OPTIONAL=1 (NOT recommended — offsite is the point)." >&2
    false # deliberate failure → ERR trap (on_failure: alert email) → non-zero exit
  fi
else
  echo "▸ offsite sync"
  FINAL_ABS="$(readlink -f "$FINAL")"
  # whitespace-split into argv — no eval, no shell metacharacter interpretation
  read -r -a OFFSITE_ARGS <<<"$BACKUP_OFFSITE_CMD"
  if [ "${#OFFSITE_ARGS[@]}" -eq 0 ]; then
    echo "✗ BACKUP FAILED: BACKUP_OFFSITE_CMD is empty/whitespace — refusing to guess an offsite target (OPS-3)." >&2
    false
  else
    OFFSITE_BIN="${OFFSITE_ARGS[0]}"
    # {file} → absolute artifact path, in whichever argument it appears
    for i in "${!OFFSITE_ARGS[@]}"; do
      OFFSITE_ARGS["${i}"]="${OFFSITE_ARGS["${i}"]//\{file\}/$FINAL_ABS}"
    done
    case "$OFFSITE_BIN" in
      rsync|scp|rclone|aws)
        # direct argv invocation of a KNOWN binary — every argument quoted
        if "$OFFSITE_BIN" "${OFFSITE_ARGS[@]:1}"; then
          echo "  offsite sync complete ($OFFSITE_BIN)"
        elif [ "$OFFSITE_OPTIONAL" = "1" ]; then
          echo "  ⚠️ offsite sync FAILED — backup remains local (HRM_BACKUP_OFFSITE_OPTIONAL=1 legacy behavior)" >&2
        else
          echo "✗ BACKUP FAILED: offsite sync FAILED — the backup never left this host (OPS-3)." >&2
          echo "  A local-only copy is not an offsite backup: fix the offsite target and re-run the job." >&2
          false # deliberate failure → ERR trap (on_failure: alert email) → non-zero exit
        fi
        ;;
      *)
        echo "✗ BACKUP FAILED: unsupported BACKUP_OFFSITE_CMD command '$OFFSITE_BIN' (OPS-3)." >&2
        echo "  Supported: rsync | scp | rclone | aws — arguments are passed verbatim (no shell evaluation)." >&2
        false
        ;;
    esac
  fi
fi

# retention
find "$BACKUP_DIR" -name 'hrm-*.dump*' -mtime +"$KEEP_DAYS" -delete 2>/dev/null || true
echo "▸ retention: snapshots older than $KEEP_DAYS day(s) pruned"

trap - ERR
cat <<NOTE

Restore drill (automated: bash scripts/restore-drill.sh — run at least quarterly):
  # verify:    sha256sum -c $FINAL.sha256        (tamper evidence — do this FIRST)
  # plain:     pg_restore --dbname <scratch_db> --no-owner $FINAL
  # encrypted: openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 -in $FINAL -out hrm.dump -pass env:BACKUP_PASSPHRASE
  # verify:    psql <scratch_db> -c 'SELECT count(*) FROM "Employee"'
  Full runbook: docs/postgresql-backup-restore.md
NOTE

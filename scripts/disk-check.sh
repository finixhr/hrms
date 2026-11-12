#!/usr/bin/env bash
# OPS-R10 (this audit, updated for PostgreSQL) — pre-flight disk-space check
# before backup. There is no single database FILE anymore (PostgreSQL lives in
# its own data directory, backed up by the DBA/pg_basebackup separately); what
# needs headroom here is the dump output. Fails fast if free space is below
# 2x the newest existing backup's size, or the minimum floor.
set -euo pipefail

BACKUP_DIR="${1:-backups}"
MIN_FREE_GB="${3:-2}"
MIN_FREE_GB="${MIN_FREE_GB:-2}"

LAST_SIZE=$(stat -c%s "$BACKUP_DIR"/hrm-*.dump* 2>/dev/null | sort -n | tail -1 || echo 0)
LAST_SIZE=${LAST_SIZE:-0}
REQUIRED_BYTES=$(( LAST_SIZE * 2 ))

AVAIL_BYTES=$(df -B1 --output=avail "$(pwd)" | tail -1 | tr -d ' ')
MIN_BYTES=$(( MIN_FREE_GB * 1024 * 1024 * 1024 ))
if [ "$REQUIRED_BYTES" -lt "$MIN_BYTES" ]; then
  REQUIRED_BYTES=$MIN_BYTES
fi

echo "[disk-check] last backup: ${LAST_SIZE} B · available: ${AVAIL_BYTES} B · required: ${REQUIRED_BYTES} B"
if [ "$AVAIL_BYTES" -lt "$REQUIRED_BYTES" ]; then
  echo "[disk-check] FAIL: not enough free space for tonight's backup (need ${REQUIRED_BYTES} B, have ${AVAIL_BYTES} B)" >&2
  exit 1
fi
echo "[disk-check] OK"

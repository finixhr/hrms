#!/usr/bin/env bash
# ============ FIN-038 (Phase 0) — re-key encrypted backups after key rotation ============
# After HRM_BACKUP_KEY is rotated (scripts/rotate-secrets.ts), every existing
# encrypted backup still decrypts ONLY under the OLD key. This script re-keys
# them in place:
#   for each backups/hrm-*.dump.enc:
#     1. verify the SHA-256 manifest (tamper evidence — refuse to touch a
#        backup that does not match its checksum);
#     2. decrypt with OLD_HRM_BACKUP_KEY (aes-256-cbc + pbkdf2 + 600k iters,
#        the exact flags of scripts/backup.sh);
#     3. re-encrypt with the NEW key and rewrite the manifest;
#     4. re-verify: decrypt again with the new key and compare byte-for-byte.
# A backup that fails ANY step is left UNTOUCHED and reported — re-keying must
# never destroy the only copy.
#
# Usage:
#   OLD_HRM_BACKUP_KEY=<old hex> bash scripts/rekey-backups.sh [--dry-run]
# The NEW key is read from HRM_BACKUP_KEY in the environment or .env (the
# rotation script has already written it there).
#
# Note (2026-11-01): backups created while the FIN-001 GCM bug was live never
# existed — the encryption step failed every night. Any *.enc file found was
# created after the aes-256-cbc fix, so the flags below always match.
set -euo pipefail
cd "$(dirname "$0")/.."

BACKUP_DIR="${BACKUP_DIR:-backups}"
DRY_RUN=0
[ "${1:-}" = "--dry-run" ] && DRY_RUN=1

if [ -z "${OLD_HRM_BACKUP_KEY:-}" ]; then
  echo "ERROR: OLD_HRM_BACKUP_KEY is not set — the pre-rotation key is required to decrypt." >&2
  echo "       (It is safe to type here: it is compromised material on its way out.)" >&2
  exit 1
fi
NEW_KEY="${HRM_BACKUP_KEY:-}"
if [ -z "$NEW_KEY" ] && [ -f .env ]; then
  NEW_KEY="$(grep -E '^[[:space:]]*HRM_BACKUP_KEY[[:space:]]*=' .env | tail -1 | cut -d= -f2- | sed 's/^[[:space:]]*//; s/[[:space:]]*$//; s/^"//; s/"$//')"
fi
if [ -z "$NEW_KEY" ]; then
  echo "ERROR: new HRM_BACKUP_KEY not found (env or .env) — run scripts/rotate-secrets.ts first." >&2
  exit 1
fi
if [ "$NEW_KEY" = "$OLD_HRM_BACKUP_KEY" ]; then
  echo "ERROR: OLD_HRM_BACKUP_KEY and the new HRM_BACKUP_KEY are identical — nothing to re-key." >&2
  exit 1
fi

rekey_one() {
  local enc="$1" base dir tmp
  base="$(basename "$enc")"
  dir="$(dirname "$enc")"
  tmp="$(mktemp -d)"
  local rc=0

  # 1. checksum manifest (when present) — refuse to touch a mismatched backup
  if [ -f "$enc.sha256" ]; then
    if ! (cd "$dir" && sha256sum -c "$base.sha256" >/dev/null 2>&1); then
      echo "  SKIP $base — checksum mismatch; refusing to re-key (investigate manually)" >&2
      rm -rf "$tmp"; return 1
    fi
  fi

  # 2. decrypt under the OLD key → 3. re-encrypt under the NEW key
  if ! BACKUP_PASSPHRASE="$OLD_HRM_BACKUP_KEY" openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 \
        -in "$enc" -out "$tmp/old.dump" -pass env:BACKUP_PASSPHRASE 2>/dev/null; then
    echo "  SKIP $base — does not decrypt under OLD_HRM_BACKUP_KEY (different era/key?)" >&2
    rm -rf "$tmp"; return 1
  fi
  if [ "$DRY_RUN" = "1" ]; then
    echo "  DRY-RUN OK $base — would re-key ($(stat -c%s "$tmp/old.dump") bytes plaintext)"
    rm -rf "$tmp"; return 0
  fi
  if ! BACKUP_PASSPHRASE="$NEW_KEY" openssl enc -aes-256-cbc -pbkdf2 -salt -iter 600000 \
        -in "$tmp/old.dump" -out "$tmp/new.enc" -pass env:BACKUP_PASSPHRASE; then
    echo "  FAIL $base — re-encryption failed; original left untouched" >&2
    rm -rf "$tmp"; return 1
  fi

  # 4. prove the new ciphertext before replacing anything
  if ! BACKUP_PASSPHRASE="$NEW_KEY" openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 \
        -in "$tmp/new.enc" -out "$tmp/verify.dump" -pass env:BACKUP_PASSPHRASE 2>/dev/null \
        || ! cmp -s "$tmp/old.dump" "$tmp/verify.dump"; then
    echo "  FAIL $base — re-encrypted copy does not verify; original left untouched" >&2
    rm -rf "$tmp"; return 1
  fi

  mv "$tmp/new.enc" "$enc"
  (cd "$dir" && sha256sum "$base" > "$base.sha256")
  chmod 600 "$enc" "$enc.sha256" 2>/dev/null || true
  rm -rf "$tmp"
  echo "  RE-KEYED $base"
}

echo "▸ re-keying encrypted backups in $BACKUP_DIR (dry-run: $([ $DRY_RUN = 1 ] && echo yes || echo no))"
count=0
failed=0
shopt -s nullglob
for enc in "$BACKUP_DIR"/hrm-*.dump.enc; do
  count=$((count + 1))
  rekey_one "$enc" || failed=$((failed + 1))
done
shopt -u nullglob

if [ "$count" -eq 0 ]; then
  echo "  (no encrypted backups found — nothing to re-key)"
  exit 0
fi
echo "▸ done: $count backup(s) examined, $failed left untouched/failed"
[ "$failed" -gt 0 ] && exit 1
exit 0

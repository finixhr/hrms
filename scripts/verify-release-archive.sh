#!/usr/bin/env bash
# ============ FORENSIC AUDIT 2026-11-10, FIN-001 (Phase 0) — archive verifier =
# Verifies a RELEASE ARCHIVE (however it was built — sanctioned lane or not)
# before distribution. The 2026-11-09 archive shipped a live .env and a
# decryptable production backup because it was cut OUTSIDE scripts/package-zip.sh;
# tree-level gates never saw it. This script closes that hole: the CHECK runs
# against the ARTIFACT ITSELF.
#
#   bash scripts/verify-release-archive.sh <archive.zip>
#
# Gates (all must pass; exit 1 with specifics on any hit):
#   G1  forbidden content by name — .env-family files, backups/, *.dump*,
#       *.db, .git/, node_modules/, .next/, upload/, skills/, tool-results/
#   G2  secret-value scan — bun run scripts/scan-secrets.ts inside the
#       extracted tree (known-leaked values ANYWHERE, live-looking assignments
#       in tracked-looking files; the blocklist covers all three leaked
#       generations)
#   G3  release-manifest lockstep — node scripts/check-release-artifact.mjs
#       --image (V1–V6, V8–V10) when the archive carries a manifest
#   G4  key-file presence — schema, lock file, validator, scanner
#
# scripts/package-zip.sh runs this on its own output; CI can run it on any
# artifact before publish. A distribution channel that skips this gate is,
# by definition, not a release channel.
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: bash scripts/verify-release-archive.sh <archive.zip>" >&2
  exit 1
fi
ARCHIVE="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
if [[ ! -f "$ARCHIVE" ]]; then
  echo "verify-release-archive: '$1' not found" >&2
  exit 1
fi
command -v unzip >/dev/null 2>&1 || { echo "verify-release-archive: unzip required" >&2; exit 1; }
command -v bun  >/dev/null 2>&1 || { echo "verify-release-archive: bun required (secret scan)" >&2; exit 1; }

# The VERIFYING tree's scanner — NOT the archive's own copy. An archive built
# from an older tree carries an older blocklist and would miss the newest
# leaked generation; the verifier's scanner is by definition current.
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CURRENT_SCANNER="$REPO_ROOT/scripts/scan-secrets.ts"

WORK="$(mktemp -d /tmp/verify-archive.XXXXXX)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/root"
unzip -q "$ARCHIVE" -d "$WORK/root"

FAIL=0
echo "== G1: forbidden content by name =="
LISTING="$(unzip -l "$ARCHIVE" | awk '{print $4}')"
# .env family: EVERYTHING except .env.example (the documented template — G4
# requires it). A live .env, .env.production, .env.orig-backup, rotation logs
# or per-context key overrides must never ride in an archive.
ENV_HITS="$(printf '%s\n' "$LISTING" | grep -E '^\.env' | grep -vx '.env.example' || true)"
if [[ -n "$ENV_HITS" ]]; then
  echo "  FAIL: .env-family files present (only .env.example may ship):"
  printf '%s\n' "$ENV_HITS" | head -5 | sed 's/^/        /'
  FAIL=1
else
  echo "  ok: no .env-family files (except .env.example)"
fi
for pattern in "^backups/" "^\.git/" "node_modules/" "^\.next/" "^upload/" "^skills/" "^tool-results/" "\.dump" "\.db$"; do
  n=$(printf '%s\n' "$LISTING" | grep -c "$pattern" || true)
  if [[ "${n:-0}" -gt 0 ]]; then
    echo "  FAIL: $n path(s) match forbidden pattern '$pattern':"
    printf '%s\n' "$LISTING" | grep "$pattern" | head -5 | sed 's/^/        /'
    FAIL=1
  else
    echo "  ok: $pattern -> 0"
  fi
done

echo "== G2: secret-value scan (extracted tree) =="
# 2a. the CURRENT scanner (authoritative blocklist) walks the extracted tree —
#     scan-secrets.ts uses process.cwd() as its root, so an absolute script
#     path + cwd inside the extraction scans the ARCHIVE contents.
if (cd "$WORK/root" && bun run "$CURRENT_SCANNER"); then
  echo "  ok: current-scanner clean"
else
  echo "  FAIL: current scanner reported violations inside the archive" >&2
  FAIL=1
fi
# 2b. the archive's own scanner (if bundled) — a second opinion that also
#     catches archives whose scanner knows MORE than the verifying tree.
if [[ -f "$WORK/root/scripts/scan-secrets.ts" ]]; then
  if (cd "$WORK/root" && bun run scripts/scan-secrets.ts); then
    echo "  ok: archived-scanner clean"
  else
    echo "  FAIL: the archive's own scanner reported violations" >&2
    FAIL=1
  fi
else
  echo "  note: archive bundles no scanner of its own"
fi

echo "== G3: release-manifest lockstep (image mode) =="
if [[ -f "$WORK/root/deploy/release-manifest.json" ]]; then
  # same rule as G2: the verifying tree's validator is authoritative
  if (cd "$WORK/root" && node "$REPO_ROOT/scripts/check-release-artifact.mjs" --image .); then
    echo "  ok: manifest matches the archived migration tree"
  else
    echo "  FAIL: archived manifest does not match the archived migration tree (V-rules above)" >&2
    FAIL=1
  fi
else
  echo "  SKIP: archive carries no deploy/release-manifest.json"
fi

echo "== G4: key files present =="
for f in "prisma/schema.prisma" "prisma/migrations/migration_lock.toml" \
         "deploy/release-manifest.json" "scripts/check-release-artifact.mjs" \
         "scripts/scan-secrets.ts" "scripts/package-zip.sh" ".env.example"; do
  if [[ -e "$WORK/root/$f" ]]; then echo "  ok: $f"; else echo "  FAIL: $f missing from archive"; FAIL=1; fi
done

echo ""
if [[ "$FAIL" -ne 0 ]]; then
  echo "RESULT: REJECT — do not distribute this archive (FIN-001 gate)." >&2
  exit 1
fi
echo "RESULT: ACCEPT — archive is free of forbidden content and known-leaked secrets."
exit 0

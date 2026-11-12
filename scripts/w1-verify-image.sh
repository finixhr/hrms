#!/usr/bin/env bash
# ============ W1-AC-10 — Docker image migration inspection (R-30 / V6) ============
# Staged-image equivalent: no docker binary in the sandbox — this procedure
# stages the EXACT tree the Dockerfile COPYs into the runtime image
# (prisma/migrations + deploy/release-manifest.json + the validator) and runs
# the validator in --image mode against it, plus the M4-absence check and the
# V12 wiring check (entrypoint runs --image validation BEFORE
# `prisma migrate deploy`). The REAL docker build + `docker create` extraction
# run in the CI docker-build job wired by R-30. 4 steps.
set -euo pipefail
cd "$(dirname "$0")/.."
source scripts/w1-env.sh
LOG_DIR="${W1_LOG_DIR:-/home/z/my-project/scripts}"
STAGE="$(mktemp -d /tmp/w1-ac10-image-XXXX)"
trap 'rm -rf "$STAGE"' EXIT

echo "── [W1-AC-10 step 1/4] stage the image layout (what the Dockerfile COPYs)"
mkdir -p "$STAGE/app/deploy" "$STAGE/app/scripts" "$STAGE/app/prisma"
cp -r prisma/migrations/. "$STAGE/app/prisma/migrations/"
cp deploy/release-manifest.json "$STAGE/app/deploy/release-manifest.json"
cp scripts/check-release-artifact.mjs "$STAGE/app/scripts/check-release-artifact.mjs"
DIRS=$(ls "$STAGE/app/prisma/migrations" | grep -v migration_lock | wc -l)
echo "  staged migration directories: $DIRS (expected 58)"
[ "$DIRS" = "58" ] || { echo "── W1-AC-10: FAIL at step 1 (staged=$DIRS)"; exit 1; }

echo "── [W1-AC-10 step 2/4] validator --image against the staged tree (V1–V6, V8–V10) + M4 absence"
node scripts/check-release-artifact.mjs --image "$STAGE/app" | tee "$LOG_DIR/w1-ac10-image-inspection.log"
if find "$STAGE/app/prisma/migrations" -maxdepth 1 -type d -name '*enforce*' | grep -q .; then
  echo "── W1-AC-10: FAIL at step 2 (an *enforce* directory is present in the image tree)"
  exit 2
fi

echo "── [W1-AC-10 step 3/4] tampered images are rejected"
BAD1="$(mktemp -d /tmp/w1-ac10-bad1-XXXX)"; BAD2="$(mktemp -d /tmp/w1-ac10-bad2-XXXX)"
trap 'rm -rf "$STAGE" "$BAD1" "$BAD2"' EXIT
cp -r "$STAGE/app" "$BAD1/"; cp -r "$STAGE/app" "$BAD2/"
mkdir -p "$BAD1/app/prisma/migrations/9_wave9zzb_mc_enforce_20261103"   # extra M4 directory
rm -rf "$BAD2/app/prisma/migrations/9_wave9zza_mc_expand_20261103"       # missing declared directory
if node scripts/check-release-artifact.mjs --image "$BAD1/app" >/dev/null 2>&1; then
  echo "── W1-AC-10: FAIL at step 3 (extra M4 directory was NOT rejected)"; exit 3
fi
if node scripts/check-release-artifact.mjs --image "$BAD2/app" >/dev/null 2>&1; then
  echo "── W1-AC-10: FAIL at step 3 (missing declared directory was NOT rejected)"; exit 3
fi
echo "  both tampered images rejected (extra M4 dir / missing declared dir)"

echo "── [W1-AC-10 step 4/4] V12 wiring: the entrypoint validates BEFORE prisma migrate deploy"
# skip comment lines (# …) — the header comment also mentions the command
ENT="$(grep -vn '^\s*#' docker/entrypoint.sh | grep -n "check-release-artifact.mjs --image" | head -1 | cut -d: -f2)"
MIG="$(grep -vn '^\s*#' docker/entrypoint.sh | grep -n "prisma migrate deploy" | head -1 | cut -d: -f2)"
echo "  entrypoint (executable lines): --image validation at line $ENT; migrate deploy at line $MIG"
[ -n "$ENT" ] && [ -n "$MIG" ] && [ "$ENT" -lt "$MIG" ] || {
  echo "── W1-AC-10: FAIL at step 4 (V12 assertion is not wired before prisma migrate deploy)"
  exit 4
}

echo "── W1-AC-10: PASS (staged-image equivalent; real docker build runs in CI)"
exit 0

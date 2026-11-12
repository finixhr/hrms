#!/usr/bin/env bash
# typecheck.sh — FIN-018 (Phase 2): the SHARDED type-check lane.
# Replaces the single whole-program `tsc --noEmit` (which needs ~8GB: one
# compiler process holds the entire 1,022-file program; default CI runners
# with 4GB OOM mid-check). Each shard runs in its OWN tsc process, so peak
# memory is the largest SHARD's program, not the whole repo's — a 4GB runner
# completes comfortably (exit criterion; measured under NODE_OPTIONS heap
# caps in docs/runbooks/type-checking.md).
#
# Usage:
#   bash scripts/typecheck.sh               # all shards, stop at first failure
#   TSC_SHARDS="check-app" bash ...         # one shard
#   NODE_OPTIONS="--max-old-space-size=2048" bash ...   # cap each process's heap
#   bash scripts/typecheck.sh --list
set -euo pipefail
cd "$(dirname "$0")/.."

ALL=("check-app" "check-server" "check-tests")
if [ "${1:-}" = "--list" ]; then printf '%s\n' "${ALL[@]}"; exit 0; fi
if [ -n "${TSC_SHARDS:-}" ]; then IFS=',' read -ra SELECTED <<< "$TSC_SHARDS"; else SELECTED=("${ALL[@]}"); fi

# TSC_BIN may be a full command with args (e.g. "node_modules/.bin/tsc");
# the default is `bunx tsc`.
if [ -z "${TSC_BIN:-}" ]; then TSC_CMD=(bunx tsc); else read -ra TSC_CMD <<< "$TSC_BIN"; fi
FAIL=0
for s in "${SELECTED[@]}"; do
  cfg="tsconfig.${s}.json"
  if [ ! -f "$cfg" ]; then echo "typecheck: unknown shard '$s' (expected one of: ${ALL[*]})" >&2; exit 2; fi
  start=$(date +%s)
  if "${TSC_CMD[@]}" --noEmit -p "$cfg"; then
    echo "✓ shard ${s}: $(( $(date +%s) - start ))s"
  else
    echo "✗ shard ${s} FAILED ($(( $(date +%s) - start ))s)" >&2
    FAIL=1
    break
  fi
done
exit $FAIL

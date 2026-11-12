#!/usr/bin/env bash
# ============ SEC-1 (Phase 1) — install the pre-commit secret scan ============
# Installs a git pre-commit hook that:
#   1. SEC-1 (P0 audit wave, 2026-11-09) — refuses to commit ANY .env-family
#      file BY NAME (deterministic block: .env, .env.production, .env.local,
#      .env.orig-backup, .env.test, .env.rotation-log — every profile that can
#      carry real credentials; only .env.example placeholders may ship). The
#      audit found the shipped artifact carried a live .env even though the
#      packaging lane refuses one — the commit-side gate must be just as dumb
#      and absolute as the package-side gate.
#   2. runs scripts/scan-secrets.ts --staged (the staged-index variant of the
#      CI stage-5 scanner — known-leaked values + secret names assigned
#      live-looking values).
# The hook is a pure guard: it never modifies files, it only blocks.
#
#   bash scripts/install-hooks.sh            # install (idempotent)
#   bash scripts/install-hooks.sh --optional # same, but a non-git tree only
#                                            # warns instead of failing (used
#                                            # by the package.json prepare
#                                            # script so `bun install` never
#                                            # breaks inside a plain extract)
#   git rev-parse --git-path hooks           # verify: pre-commit exists
set -euo pipefail
cd "$(dirname "$0")/.."

OPTIONAL=0
if [[ "${1:-}" == "--optional" ]]; then
  OPTIONAL=1
fi

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  if [[ $OPTIONAL -eq 1 ]]; then
    echo "install-hooks: not a git repository — pre-commit secret guard NOT installed (extract-only tree)."
    exit 0
  fi
  echo "install-hooks: not a git repository — run inside a clone." >&2
  exit 1
fi

HOOK="$(git rev-parse --git-path hooks)/pre-commit"
cat > "$HOOK" <<'EOF'
#!/usr/bin/env bash
# Installed by scripts/install-hooks.sh (Phase 1, SEC-1) — pre-commit secret guard.
#   1. BLOCKS any .env-family file by name (SEC-1, P0 audit wave 2026-11-09).
#   2. Runs the staged secret scan (known-leaked values, live-looking assignments).
# Manual override for emergencies: git commit --no-verify (never do this for
# real secrets; rotate them instead).
set -euo pipefail

# ---- 1. deterministic .env filename block (SEC-1) --------------------------
BLOCKED_ENV=0
while IFS= read -r staged; do
  base="$(basename "$staged")"
  case "$base" in
    .env|.env.production|.env.local|.env.orig-backup|.env.test|.env.rotation-log|.env.keys.local)
      echo "pre-commit: REFUSING to commit '$staged' — environment files never enter history (SEC-1)." >&2
      echo "             Secrets live in the (gitignored) working-tree .env only; commit .env.example placeholders." >&2
      BLOCKED_ENV=1
      ;;
  esac
done < <(git diff --cached --name-only --diff-filter=ACM 2>/dev/null || true)
if [[ $BLOCKED_ENV -ne 0 ]]; then
  exit 1
fi

# ---- 2. staged secret-value scan --------------------------------------------
bun run scripts/scan-secrets.ts --staged
EOF
chmod +x "$HOOK"
echo "installed: $HOOK (blocks .env-family files by name + runs bun run scripts/scan-secrets.ts --staged on every commit)"

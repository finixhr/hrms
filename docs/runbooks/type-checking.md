# Type-Checking Runbook (FIN-018 + FIN-034, Phase 2)

**Findings:** FIN-018 (High) — the whole-program `tsc --noEmit` needs ~8GB:
one compiler process holds the entire 1,022-file program; CI and typical dev
machines (4GB) OOM mid-check. FIN-034 (Low) — the ops/deploy docs never
mentioned the memory threshold.

## The two lanes

| Lane | Command | Peak memory | Where it runs |
|---|---|---|---|
| **Sharded (default)** | `bun run typecheck` → `bash scripts/typecheck.sh` | largest single shard (check-app): node's default ~2GB heap OOMs; `NODE_OPTIONS="--max-old-space-size=4096"` completes with headroom on a 4GB runner (measured 2026-11-10: check-app 56s · check-server 20s · check-tests 50s) | CI stage 1, dev machines, 4GB runners |
| Whole-program (legacy) | `bun run typecheck:whole` | ≥8GB heap (FIN-018's measured threshold) | only on large runners, by choice |

The sharded lane runs each shard in its **own tsc process**, so peak memory
is the largest shard's program, not the whole repo's:

- `tsconfig.check-app.json` — the Next.js app surface (src/hrm, src/saas,
  src/app, components, hooks, api-client/contract, lib, instrumentation)
- `tsconfig.check-server.json` — the server + ops scripts (src/hrm-server,
  scripts/*.ts)
- `tsconfig.check-tests.json` — tests/** (+ `next-env.d.ts`, which declares
  the `*.css` module imports the app components under test carry)

Shared code that several shards import is checked in each of them — that is
deliberate (a shard can never pass on a stale view of a dependency).

## Operating notes

- Single shard: `TSC_SHARDS="check-server" bash scripts/typecheck.sh`
- Heap cap per process: `NODE_OPTIONS="--max-old-space-size=4096" bash scripts/typecheck.sh` — on a 4GB runner this is the measured working size for check-app (the app-surface shard); the ~2GB default heap OOMs inside that shard (re-measured 2026-11-10 after the Phase 2 edits; smaller caps such as 2048/2560 predate the Phase 2 surface growth and are no longer sufficient for check-app)
- Custom tsc binary: `TSC_BIN="node_modules/.bin/tsc" bash scripts/typecheck.sh`
- Adding a shard: create `tsconfig.<name>.json` (extends `tsconfig.base.json`,
  disjoint include), then add it to `ALL` in `scripts/typecheck.sh`.

## What NOT to do

- Do not reinstate whole-program checks in CI: a 4GB runner OOMs at the
  ~8GB threshold (FIN-018, unchanged for the whole-program lane).
- `next build` still runs its own in-process type pass on the app surface —
  on constrained machines run `next build` where memory allows (the build
  lane in CI), and rely on the sharded lane for pre-commit feedback.

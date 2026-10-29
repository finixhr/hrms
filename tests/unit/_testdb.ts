/// <reference types="bun-types" />
// ============ Shared test-database bootstrap (import-order safety net) ============
// The authoritative bootstrap lives in tests/preload.ts and is registered in
// bunfig.toml [test].preload, so it runs before ANY test file is loaded. This
// module remains as an explicit, self-contained re-entrancy guard for direct
// `bun test <file>` invocations of a single test file (preload also covers
// those, but keeping this import makes each file's DB dependency explicit).
import "../preload"

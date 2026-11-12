/// <reference types="bun-types" />
// ============ Shared test-database bootstrap (import-order safety net) ============
// The environment-selection part lives in tests/preload.ts (registered in
// bunfig.toml [test].preload, so it runs before ANY test file is loaded and
// points DATABASE_URL at the isolated unit-test database).
//
// FIN-037 (Phase 2): the `prisma db push --force-reset` bootstrap is LAZY —
// this module awaits it at module scope, so the database is fully prepared
// before the importing file's next imports (@/lib/db, engines, …) evaluate
// and long before its first query. Test files that do NOT import this module
// (pure-logic suites: money math, leave math, AIT slabs, …) never trigger
// the bootstrap and run in DB-less environments.
//
// Every DB-backed test file imports this FIRST:
//   import "./_testdb"
//   import { db } from "@/lib/db"
// (the _fixtures and _hrm-endpoint helpers already do).
import { ensureTestDatabase } from "../preload"

await ensureTestDatabase()

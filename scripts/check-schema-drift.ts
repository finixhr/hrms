// ============ schema-drift gate (re-audit 2026-10-18 remediation) ============
// WHY: the merged state shipped schema.prisma changes with NO migration —
// 6 Item columns, 5 StockEntryItem columns and the entire ItemCategory /
// ItemUnit / InventoryItemSerial tables existed only in the schema, so every
// `prisma migrate deploy` database (production shape) crashed with P2021 /
// P2022 the moment the inventory-serial feature was used. The unit-test
// database never noticed because tests provision via `prisma db push`
// (schema-direct, migrations bypassed) — the exact blind spot the
// fresh-database smoke of 2026-10-03 closed for BROKEN migration SQL. This
// gate closes the complementary gap: it diffs the MIGRATION CHAIN against
// the SCHEMA and fails CI on ANY drift, so "schema edited, migration
// forgotten" can never reach a release again.
//
// WHAT: provision a throwaway SHADOW database, run
//   prisma migrate diff \
//     --from-migrations prisma/migrations \
//     --to-schema-datamodel prisma/schema.prisma \
//     --shadow-database-url <scratch> --script
// and require the diff to be EMPTY. The scratch database is dropped again
// in a finally block. Same production-refusal convention as
// tests/preload.ts and scripts/migrate-fresh-smoke.ts.
//
// Run standalone:   bun run scripts/check-schema-drift.ts
// Wired into:       scripts/ci.sh (stage 10) → .github/workflows/ci.yml
import { execSync } from "child_process"
import * as path from "path"
import { PrismaClient } from "@prisma/client"

const ROOT = path.resolve(import.meta.dir, "..")

const BASE_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || ""
if (/production/i.test(BASE_URL)) {
  console.error("[schema-drift] REFUSING: URL looks like production:", BASE_URL.replace(/:[^:@/]+@/, ":***@"))
  process.exit(1)
}
if (!BASE_URL) {
  console.error("[schema-drift] REFUSING: no DATABASE_URL/TEST_DATABASE_URL to derive a shadow database from")
  process.exit(1)
}
const SCRATCH = "hrm_schema_drift"
const scratchUrl = BASE_URL.replace(/\/[^/?]+(\?|$)/, `/${SCRATCH}$1`)
if (scratchUrl === BASE_URL) {
  console.error("[schema-drift] REFUSING: could not rewrite database name in URL")
  process.exit(1)
}

// Admin client on the default 'postgres' database — only used to CREATE/DROP
// the shadow database.
const admin = new PrismaClient({ datasources: { db: { url: BASE_URL.replace(/\/[^/?]+(\?|$)/, "/postgres$1") } } })

async function main() {
  console.log(`[schema-drift] shadow database: ${SCRATCH}`)
  await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${SCRATCH}"`)
  await admin.$executeRawUnsafe(`CREATE DATABASE "${SCRATCH}"`)
  try {
    // --script prints the SQL that would bring the MIGRATIONS' database to
    // the SCHEMA's state. An empty chain-vs-schema pair yields the literal
    // placeholder "-- This is an empty migration." — anything else is drift.
    let diff = ""
    try {
      diff = execSync(
        "bunx prisma migrate diff" +
          " --from-migrations prisma/migrations" +
          " --to-schema-datamodel prisma/schema.prisma" +
          ` --shadow-database-url "${scratchUrl}"` +
          " --script",
        { cwd: ROOT, env: { ...process.env }, encoding: "utf8", timeout: 180_000, stdio: ["ignore", "pipe", "pipe"] },
      )
    } catch (e: any) {
      // prisma migrate diff writes real errors to stderr and exits non-zero
      console.error("[schema-drift] `prisma migrate diff` failed:")
      console.error(String(e.stderr || e.stdout || e.message))
      process.exitCode = 1
      return
    }
    // Phase 2 (MOD-17) — DELIBERATE raw-SQL objects Prisma cannot declare:
    // the pg_trgm GIN indexes owned by migration 9_wave9zf serve the employee
    // directory ILIKE searches. The datamodel has no trigram syntax, so the
    // diff always proposes dropping them; they are allow-listed HERE (with
    // their owning migration named) instead of being silently tolerated.
    // Everything else must still round-trip exactly.
    const RAW_SQL_ALLOWLIST: RegExp[] = [
      /-- DropIndex\nDROP INDEX "Employee_fullName_trgm_idx";?/g,
      /-- DropIndex\nDROP INDEX "Employee_code_trgm_idx";?/g,
      // R6 / EMP-13 — the four directory-search trigram indexes (mobile/emails)
      /-- DropIndex\nDROP INDEX "Employee_mobile_trgm_idx";?/g,
      /-- DropIndex\nDROP INDEX "Employee_altMobile_trgm_idx";?/g,
      /-- DropIndex\nDROP INDEX "Employee_officialEmail_trgm_idx";?/g,
      /-- DropIndex\nDROP INDEX "Employee_personalEmail_trgm_idx";?/g,
    ]
    let normalized = diff.replace(/-- This is an empty migration\./g, "").trim()
    for (const pattern of RAW_SQL_ALLOWLIST) normalized = normalized.replace(pattern, "").trim()
    if (normalized.length === 0) {
      console.log("[schema-drift] ✅ migration chain matches schema.prisma exactly (zero drift, raw-SQL allowlist applied)")
      return
    }
    console.error("[schema-drift] ❌ SCHEMA DRIFT DETECTED — schema.prisma and the migration chain disagree.")
    console.error("[schema-drift] The following SQL is missing from the migrations (or must be reverted in the schema):")
    console.error(normalized)
    console.error("")
    console.error("[schema-drift] Fix: author a migration for the change (bun run db:migrate -- --name <topic>),")
    console.error("[schema-drift] or revert the schema edit. NEVER ship a schema.prisma change without its migration —")
    console.error("[schema-drift] every `prisma migrate deploy` database runs the migrations only (see the 2026-10-18 re-audit P1).")
    process.exitCode = 1
  } finally {
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${SCRATCH}" WITH (FORCE)`)
    console.log("[schema-drift] shadow database dropped")
  }
}

main()
  .catch((e) => { console.error("[schema-drift] FAILED:", e.message); process.exitCode = 1 })
  .finally(() => admin.$disconnect())

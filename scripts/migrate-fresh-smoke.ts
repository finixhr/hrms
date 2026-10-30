// ============ fresh-database migration smoke (audit follow-up 2026-10-03) ============
// WHY: migration 3_audit_remediation_20261002 shipped with an UPDATE ordering
// by PayrollEntry."createdAt" — a column that does not exist. Every FRESH
// database failed at `prisma migrate deploy` (P3009, SQLSTATE 42703). The CI
// gate never caught it because the unit-test database persists between runs
// and already had the migration recorded as applied, so migrate deploy was a
// no-op and the broken SQL never executed during any gate run.
//
// WHAT: create a THROWAWAY database, run `prisma migrate deploy` against it
// from zero, then drop it. Every migration file must apply cleanly to an
// empty database — this is the only stage that actually executes the SQL of
// already-recorded migrations.
//
// Run standalone:   bun run scripts/migrate-fresh-smoke.ts
// Wired into:       scripts/ci.sh (stage 9) and .github/workflows/ci.yml
import { execSync } from "child_process"
import * as path from "path"
import { PrismaClient } from "@prisma/client"

const ROOT = path.resolve(import.meta.dir, "..")

// Same production-refusal convention as tests/preload.ts — never point this
// at anything that looks like production (it creates AND drops databases).
const BASE_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || ""
if (/production/i.test(BASE_URL)) {
  console.error("[migrate-smoke] REFUSING: URL looks like production:", BASE_URL.replace(/:[^:@/]+@/, ":***@"))
  process.exit(1)
}
if (!BASE_URL) {
  console.error("[migrate-smoke] REFUSING: no DATABASE_URL/TEST_DATABASE_URL to derive a scratch database from")
  process.exit(1)
}
const SCRATCH = "hrm_migrate_smoke"
const scratchUrl = BASE_URL.replace(/\/[^/?]+(\?|$)/, `/${SCRATCH}$1`)
if (scratchUrl === BASE_URL) {
  console.error("[migrate-smoke] REFUSING: could not rewrite database name in URL")
  process.exit(1)
}

// Admin client on the default 'postgres' database — only used to CREATE/DROP
// the scratch database. Datasource override keeps the generated client usable.
const admin = new PrismaClient({ datasources: { db: { url: BASE_URL.replace(/\/[^/?]+(\?|$)/, "/postgres$1") } } })

async function main() {
  console.log(`[migrate-smoke] scratch database: ${SCRATCH}`)
  await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${SCRATCH}"`)
  await admin.$executeRawUnsafe(`CREATE DATABASE "${SCRATCH}"`)
  try {
    console.log("[migrate-smoke] prisma migrate deploy (fresh) …")
    execSync("bunx prisma migrate deploy", {
      cwd: ROOT,
      stdio: "inherit",
      env: { ...process.env, DATABASE_URL: scratchUrl },
      timeout: 180_000,
    })
    console.log("[migrate-smoke] ✅ all migrations apply cleanly to a fresh database")
  } finally {
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${SCRATCH}" WITH (FORCE)`)
    console.log("[migrate-smoke] scratch database dropped")
  }
}

main()
  .catch((e) => { console.error("[migrate-smoke] FAILED — a migration does not apply to a fresh database:", e.message); process.exitCode = 1 })
  .finally(() => admin.$disconnect())

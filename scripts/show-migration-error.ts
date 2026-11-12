// ============ P3009 self-diagnosis — read failed migrations from the DB ============
// When `prisma migrate deploy` exits P3009 ("migrate found failed migrations
// in the target database") the database itself holds the real error text.
// This script prints every non-applied migration record with its logs, so an
// operator sees exactly which statement failed and why — no psql needed.
//
//   bun run scripts/show-migration-error.ts
//
// Typical output for a failed migration 3 on dirty data:
//   ✗ 3_audit_remediation_20261002  started 2026-10-02 17:48:10
//     ERROR: could not create unique index "Employee_vendorId_officialEmail_key"
//     DETAIL: Key ("vendorId", "officialEmail")=(xxx, dup@corp.test) is duplicated.
//
// Recovery runbook (audit follow-up 2026-10-03, see RELEASE-NOTES-ADMIN.md):
//   1. bunx prisma migrate resolve --rolled-back 3_audit_remediation_20261002
//   2. bun run scripts/check-employee-identity-uniques.ts   (reports collisions)
//   3. bun run scripts/fix-identity-uniques.ts [--apply]    (clears them)
//   4. bunx prisma migrate deploy
import { PrismaClient } from "@prisma/client"

const db = new PrismaClient()

interface MigrationRow {
  migration_name: string
  started_at: Date
  finished_at: Date | null
  rolled_back_at: Date | null
  applied_steps_count: number
  logs: string | null
}

async function main() {
  const rows = (await db.$queryRawUnsafe(
    `SELECT migration_name, started_at, finished_at, rolled_back_at, applied_steps_count, logs
     FROM "_prisma_migrations"
     WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL
     ORDER BY started_at`,
  )) as MigrationRow[]

  const applied = await db.$queryRawUnsafe(
    `SELECT COUNT(*)::int AS n FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`,
  ) as { n: number }[]

  console.log(`applied migrations: ${applied[0]?.n ?? "?"}`)
  if (!rows.length) {
    console.log("No failed or rolled-back migrations — the migration history is healthy.")
    return
  }
  for (const r of rows) {
    const state = r.rolled_back_at ? "rolled back" : "FAILED"
    console.log(`\n✗ ${r.migration_name}  ${state}  (started ${r.started_at.toISOString()})`)
    if (r.logs) {
      const tail = r.logs.trimEnd().split("\n").slice(-25).join("\n")
      console.log(tail)
    } else {
      console.log("(no error text recorded — the migration was interrupted before producing logs)")
    }
  }
  console.log("\nRecovery: bunx prisma migrate resolve --rolled-back <migration_name>, fix the reported problem, then re-run deploy.")
}

main()
  .catch((e) => { console.error("FAILED:", e); process.exitCode = 1 })
  .finally(() => db.$disconnect())

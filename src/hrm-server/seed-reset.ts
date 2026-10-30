// ============ Shared full-schema wipe for the seed scripts ============
// Used by the TEST seed (seed.ts) and the PRODUCTION seed (seed-owner.ts) so
// both always start from a completely empty database.
//
// History: this used to be a hand-maintained list of model names wiped with
// deleteMany("children before parents"). The list predates several modules and
// had rotted — 53 of ~145 models were missing (the whole SaaS layer, tracking,
// assets, recruitment, reports, API keys, …). Re-seeding then crashed on
// RESTRICT foreign keys (e.g. SaaSSubscription → Vendor) or silently left
// stale rows behind. A static list will rot again the next time a module is
// added, so the wipe now DISCOVERS every table in the public schema and
// truncates them all in ONE statement — CASCADE resolves foreign-key order
// automatically, so a newly added model can never break the reset again.
import type { PrismaClient } from "@prisma/client"

/** Wipe every user table in the database. Returns tables wiped. */
export async function resetDatabase(db: PrismaClient, label = "seed"): Promise<number> {
  const tables = await db.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'
    ORDER BY tablename`
  if (tables.length === 0) return 0
  const list = tables.map((t) => `"${t.tablename.replace(/"/g, '""')}"`).join(", ")
  await db.$executeRawUnsafe(`TRUNCATE TABLE ${list} CASCADE`)
  console.log(`✓ wiped ${tables.length} tables (full reset — ${label})`)
  return tables.length
}

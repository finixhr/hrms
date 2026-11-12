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
//
// ---- SEC-2 (P0 audit wave, 2026-11-09) — the wipe is GUARDED --------------
// The audit's Critical finding: `bun run seed` against ANY DATABASE_URL
// (NODE_ENV is unset by default) truncated every table with CASCADE — one
// wrong .env or wrong host wiped every tenant, subscription and payroll
// record; the only guards protected the seed password, and only when
// NODE_ENV=production. resetDatabase() now refuses to wipe unless ONE of:
//   1. the DATABASE_URL obviously names a local/test database
//      (test | localhost | 127.0.0.1 | ::1 — the dev/demo/CI targets);
//   2. the operator passes the TYPED confirmation flag: --confirm-wipe on the
//      command line, or HRM_SEED_CONFIRM_WIPE=I-ACCEPT-FULL-WIPE in the
//      environment (the production bootstrap path — `bun run seed:prod` —
//      uses this deliberately, mirroring the requireConfirmation() gate
//      scripts/lib/guard.ts applies to every other destructive script).
// The refusal prints the exact target database (password masked) BEFORE any
// table is touched. The guard lives INSIDE resetDatabase() so both seed entry
// points (and any future caller) inherit it — it cannot be forgotten again.
import type { PrismaClient } from "@prisma/client"
import { loggerFor } from "@/hrm-server/log"
const log = loggerFor("seed-reset")

/** SEC-2 — mask the password in a DATABASE_URL before printing it. */
function maskUrl(url: string): string {
  return url.replace(/:[^:@/]*@/, ":***@")
}

/** SEC-2 — refuse an unguarded full-database TRUNCATE (see header). */
function requireSeedWipeConfirmation(label: string): void {
  const url = (process.env.DATABASE_URL || "").trim()
  const typedConfirm =
    process.argv.includes("--confirm-wipe") ||
    process.env.HRM_SEED_CONFIRM_WIPE === "I-ACCEPT-FULL-WIPE"
  // Local/test targets: the documented dev (127.0.0.1/hrm_dev), test
  // (hrm_test) and CI scratch databases. Seeding these is the seed's job.
  const localTarget = /test|localhost|127\.0\.0\.1|::1/i.test(url)
  if (typedConfirm || localTarget) return
  log.error("")
  log.error(`✖ REFUSING to wipe the database for "${label}" (SEC-2 guard).`)
  log.error(`  target database : ${url ? maskUrl(url) : "(DATABASE_URL unset — datasource default)"}`)
  log.error("  resetDatabase() TRUNCATEs EVERY table in the public schema WITH CASCADE —")
  log.error("  every tenant, subscription, payroll record and audit row is destroyed.")
  log.error("")
  log.error("  This does not look like a local/test database. To wipe it deliberately:")
  log.error("    HRM_SEED_CONFIRM_WIPE=I-ACCEPT-FULL-WIPE bun run seed    # typed confirmation")
  log.error("    bun run src/hrm-server/seed.ts -- --confirm-wipe          # or the CLI flag")
  log.error("")
  process.exit(1)
}

/** Wipe every user table in the database. Returns tables wiped. */
export async function resetDatabase(db: PrismaClient, label = "seed"): Promise<number> {
  // SEC-2 — run BEFORE the table discovery/truncate (see header).
  requireSeedWipeConfirmation(label)
  const tables = await db.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'
    ORDER BY tablename`
  if (tables.length === 0) return 0
  const list = tables.map((t) => `"${t.tablename.replace(/"/g, '""')}"`).join(", ")
  await db.$executeRawUnsafe(`TRUNCATE TABLE ${list} CASCADE`)
  log.info(`✓ wiped ${tables.length} tables (full reset — ${label})`)
  return tables.length
}

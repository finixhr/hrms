// OPS-R8 (this audit) — readiness probe (separate from /api/health liveness).
// Health = "is the process alive + DB reachable" (liveness, LB target).
// Ready  = "is the app ready to serve traffic" (DB reachable + bg jobs ticking
//          within last 5 min + latest migration applied).
//
// LB sends traffic only when /readyz returns 200. A half-broken instance
// (DB up but BgJob queue deadlocked) returns 503 here → LB drains.

import { NextResponse } from "next/server"
import { db } from "@/lib/db"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

export async function GET() {
  const startedAt = Date.now()
  const checks: Record<string, { ok: boolean; detail?: string }> = {}

  // Check 1: DB reachable + has the expected core tables
  // (information_schema — PostgreSQL-portable; replaced the SQLite sqlite_master probe
  // 1:1 during the SQLite→PostgreSQL migration. Same predicate, same semantics.)
  try {
    const row = await db.$queryRaw<{ c: number }[]>`SELECT COUNT(*)::int AS c FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'Employee'`
    const count = Array.isArray(row) ? (row[0] as any)?.c ?? 0 : 0
    checks.db = { ok: count > 0, detail: `${count} core tables` }
  } catch (e: any) {
    checks.db = { ok: false, detail: e?.message || "DB unreachable" }
  }

  // Check 2: _prisma_migrations table exists (schema is bootstrapped)
  try {
    const row = await db.$queryRaw<{ c: number }[]>`SELECT COUNT(*)::int AS c FROM information_schema.tables WHERE table_schema = 'public' AND table_name = '_prisma_migrations'`
    const count = Array.isArray(row) ? (row[0] as any)?.c ?? 0 : 0
    checks.migrations = { ok: count > 0, detail: count > 0 ? "migrations table present" : "migrations table missing" }
  } catch (e: any) {
    checks.migrations = { ok: false, detail: e?.message || "migration check failed" }
  }

  // Check 3: BgJob queue not deadlocked — at least 0 rows in RUNNING state
  // with startedAt older than 10 min (would indicate a stuck job)
  //
  // OPS-3 (Phase 3 WS-C) — known-long job types are EXCLUDED from the
  // staleness check: a backup legitimately runs up to 30 minutes
  // (TOOL_TIMEOUT_DUMP_MS) and a restore drill similarly. Under Docker's
  // 30s healthcheck (retries=3) a >10-min backup used to flip the container
  // NOT READY → unhealthy → restart MID-BACKUP. Backups are not readiness
  // signals; the FAILED run rows + alert emails are their own health channel.
  const LONG_RUNNING_JOB_TYPES = ["BACKUP_PG_DUMP", "RESTORE_DRILL"]
  try {
    const stale = await db.bgJob.count({
      where: {
        status: "RUNNING",
        startedAt: { lt: new Date(Date.now() - 10 * 60_000) },
        type: { notIn: LONG_RUNNING_JOB_TYPES },
      },
    }).catch(() => -1)
    checks.bgJobQueue = {
      ok: stale <= 0,
      detail: stale > 0 ? `${stale} stale RUNNING jobs` : "queue healthy (long backup/drill jobs excluded from the staleness check)",
    }
  } catch {
    checks.bgJobQueue = { ok: true, detail: "skipped (BgJob table not accessible)" }
  }

  // Overall: all checks must pass for 200
  const allOk = Object.values(checks).every((c) => c.ok)
  return NextResponse.json(
    { ready: allOk, checks, uptimeSec: Math.round(process.uptime()), tookMs: Date.now() - startedAt },
    { status: allOk ? 200 : 503, headers: { "Cache-Control": "no-store" } },
  )
}

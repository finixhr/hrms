// ============ Fleet Health console (Phase 5 P0 — Scope 5 observability) =======
// Per-tenant operational health for the owner console: KPI cards, a backup
// compliance strip, and a searchable/filterable fleet grid where every tenant
// carries a derived health tier (HEALTHY / WATCH / AT_RISK / DORMANT).
//
// SCALE DISCIPLINE (the SCL-6/SCL-7 rules from Phase 3, applied from birth):
//   - owner.fleet.overview answers EVERY card with a fixed set of grouped
//     aggregates (~14 queries) — fleet-size independent, no per-vendor fan-out.
//   - owner.fleet.tenants pages in SQL (LIMIT/OFFSET over a wrapped query);
//     per-row usage (users / devices / storage) is answered by grouped queries
//     restricted to the CURRENT PAGE's vendorIds (≤ pageSize), exactly like
//     owner.tenants.list. The health tier is computed IN SQL (one CASE over
//     the subscription row + a last-login LATERAL + an active-employee
//     LATERAL) so filtering and sorting by tier never materializes the fleet.
//   - Last login reads LoginAuditLog (indexed [vendorId, createdAt]); the
//     login-audit retention sweep keeps that table bounded.
//
// TIER RULES (documented for the UI tooltip; single source = the SQL CASE):
//   AT_RISK  — subscription EXPIRED / SUSPENDED / PAST_DUE, or the term ends
//              within 3 days, or an ACTIVE tenant has ZERO active employees.
//   DORMANT  — no successful tenant-plane login in the last 30 days.
//   WATCH    — GRACE_PERIOD, or the term ends within 14 days.
//   HEALTHY  — everything else.
import { z } from "zod"
import { db } from "@/lib/db"
import { ownerAction } from "./owner-routes"
import { backupEncryptionEnabled, getBackupSettings } from "./backup"

const FLEET_PAGE = z.object({
  page: z.number().int().min(1).default(1),
  pageSize: z.number().int().min(1).max(100).default(25),
  search: z.string().trim().max(120).optional(),
  tier: z.enum(["ALL", "HEALTHY", "WATCH", "AT_RISK", "DORMANT"]).default("ALL"),
  status: z.enum(["ALL", "ACTIVE", "INACTIVE"]).default("ALL"),
}).passthrough()

const TIER_ORDER_SQL = `CASE t."tier" WHEN 'AT_RISK' THEN 0 WHEN 'WATCH' THEN 1 WHEN 'DORMANT' THEN 2 ELSE 3 END`

/** The per-tenant SELECT with the SQL-computed tier (shared by page + count). */
const FLEET_INNER_SQL = `
  FROM "Vendor" v
  LEFT JOIN "SaaSSubscription" s ON s."vendorId" = v."id"
  LEFT JOIN LATERAL (
    SELECT u."name", u."email" FROM "User" u
    WHERE u."vendorId" = v."id" AND u."role" = 'VENDOR_OWNER'
    ORDER BY u."createdAt" ASC LIMIT 1
  ) adm ON true
  LEFT JOIN LATERAL (
    SELECT MAX(l."createdAt") AS "at" FROM "LoginAuditLog" l
    WHERE l."vendorId" = v."id" AND l."success" = true AND l."plane" = 'TENANT'
  ) ll ON true
  LEFT JOIN LATERAL (
    SELECT COUNT(*)::int AS c FROM "Employee" e
    WHERE e."vendorId" = v."id"
      AND e."status" NOT IN ('RESIGNED', 'TERMINATED', 'RETIRED', 'INACTIVE')
  ) ec ON true`

const TIER_CASE_SQL = `
  CASE
    WHEN s."status" IN ('EXPIRED', 'SUSPENDED', 'PAST_DUE')
      OR (v."active" = true AND COALESCE(ec."c", 0) = 0)
      OR (s."endDate" IS NOT NULL AND s."endDate" <= now() + interval '3 days')
      THEN 'AT_RISK'
    WHEN ll."at" IS NULL OR ll."at" < now() - interval '30 days'
      THEN 'DORMANT'
    WHEN s."status" = 'GRACE_PERIOD'
      OR (s."endDate" IS NOT NULL AND s."endDate" <= now() + interval '14 days')
      THEN 'WATCH'
    ELSE 'HEALTHY'
  END`

ownerAction("owner.fleet.overview", {
  perm: "tenants.view",
  handler: async () => {
    const now = Date.now()
    const OPERATING = ["TRIAL", "ACTIVE", "PAST_DUE", "GRACE_PERIOD"]

    // ---- tenant + workforce + fleet gauges (fixed grouped set) ----
    const [totalTenants, activeTenants, workforce, activeUsers, devicesOnline, devicesEnabled, storageAgg, subsByStatus, renewals30d, failedRows, activeRows] = await Promise.all([
      db.vendor.count(),
      db.vendor.count({ where: { active: true } }),
      db.employee.count({ where: { status: { notIn: ["RESIGNED", "TERMINATED", "RETIRED", "INACTIVE"] } } }),
      db.user.count({ where: { status: "ACTIVE" } }),
      db.attendanceDevice.count({ where: { status: "ONLINE", enabled: true } }),
      db.attendanceDevice.count({ where: { enabled: true } }),
      db.usageRollup.aggregate({ _sum: { storageBytes: true } }),
      db.saasSubscription.groupBy({ by: ["status"], _count: { _all: true } }),
      db.saasSubscription.count({
        where: { status: { in: OPERATING }, endDate: { gte: new Date(now), lte: new Date(now + 30 * 86400000) } },
      }),
      db.$queryRawUnsafe<Array<{ c: number }>>(
        `SELECT COUNT(*)::int AS c FROM "LoginAuditLog" WHERE "success" = false AND "createdAt" > now() - interval '24 hours'`,
      ),
      db.$queryRawUnsafe<Array<{ c: number }>>(
        `SELECT COUNT(DISTINCT "vendorId")::int AS c FROM "LoginAuditLog" WHERE "success" = true AND "plane" = 'TENANT' AND "createdAt" > now() - interval '30 days'`,
      ),
    ])

    const totalStorageBytes = Number(storageAgg._sum.storageBytes ?? 0)
    const failedLogins24h = Number(failedRows[0]?.c || 0)
    const activeLast30d = Number(activeRows[0]?.c || 0)
    const dormantTenants = Math.max(0, totalTenants - activeLast30d)

    // ---- backup compliance strip (platform-level engine state) ----
    const [lastBackup, lastDrill, backupSettings] = await Promise.all([
      db.saasBackupRun.findFirst({ where: { type: "BACKUP" }, orderBy: { startedAt: "desc" }, select: { status: true, startedAt: true, finishedAt: true, checksum: true, sizeBytes: true, error: true } }),
      db.saasBackupRun.findFirst({ where: { type: "DRILL" }, orderBy: { startedAt: "desc" }, select: { status: true, startedAt: true, finishedAt: true, reportJson: true } }),
      getBackupSettings(),
    ])
    let lastDrillPass: boolean | null = null
    if (lastDrill) {
      try { lastDrillPass = Boolean(JSON.parse(lastDrill.reportJson ?? "{}").pass) } catch { lastDrillPass = null }
    }

    return {
      generatedAt: new Date().toISOString(),
      tenants: { total: totalTenants, active: activeTenants, inactive: totalTenants - activeTenants, dormant: dormantTenants, activeLast30d },
      workforce: { activeEmployees: workforce, activeUsers },
      devices: { online: devicesOnline, enabled: devicesEnabled },
      storageBytes: totalStorageBytes,
      renewalsNext30d: renewals30d,
      failedLogins24h,
      subscriptionsByStatus: subsByStatus.map((r) => ({ status: r.status, count: Number(r._count?._all || 0) })),
      backup: {
        lastBackup: lastBackup
          ? { status: lastBackup.status, startedAt: lastBackup.startedAt, finishedAt: lastBackup.finishedAt, checksum: lastBackup.checksum, sizeBytes: lastBackup.sizeBytes, error: lastBackup.error }
          : null,
        lastDrill: lastDrill ? { status: lastDrill.status, startedAt: lastDrill.startedAt, finishedAt: lastDrill.finishedAt, pass: lastDrillPass } : null,
        encryptionEnabled: backupEncryptionEnabled(),
        scheduleEnabled: backupSettings.enabled,
        retention: backupSettings.retention,
      },
    }
  },
})

ownerAction("owner.fleet.tenants", {
  perm: "tenants.view",
  schema: FLEET_PAGE,
  handler: async (_ctx, p) => {
    // Parameterized construction — request data only ever rides as $n
    // placeholders; the SQL text is static fragments.
    const params: unknown[] = []
    const conds: string[] = []
    if (p.status === "ACTIVE") conds.push(`t."active" = true`)
    if (p.status === "INACTIVE") conds.push(`t."active" = false`)
    if (p.tier !== "ALL") conds.push(`t."tier" = $${params.push(p.tier)}`)
    if (p.search) {
      const q = `%${p.search.toLowerCase()}%`
      conds.push(
        `(LOWER(t."name") LIKE $${params.push(q)} OR LOWER(t."code") LIKE $${params.push(q)} OR LOWER(COALESCE(t."adminEmail", '')) LIKE $${params.push(q)})`,
      )
    }
    const whereSql = conds.length ? `WHERE ${conds.join(" AND ")}` : ""
    const offset = (p.page - 1) * p.pageSize
    const limitIdx = params.length + 1
    const offsetIdx = params.length + 2
    params.push(p.pageSize, offset)

    const [countRows, pageRows] = await Promise.all([
      db.$queryRawUnsafe<Array<{ c: number }>>(
        `SELECT COUNT(*)::int AS c FROM (
           SELECT v."name", v."code", v."active", ${TIER_CASE_SQL} AS "tier", adm."email" AS "adminEmail"${FLEET_INNER_SQL}
         ) t ${whereSql}`,
        ...params.slice(0, -2),
      ),
      db.$queryRawUnsafe<Array<{
        id: string; name: string; code: string; active: boolean; createdAt: Date
        planName: string | null; subStatus: string | null; endDate: Date | null
        adminName: string | null; adminEmail: string | null
        lastLoginAt: Date | null; activeEmployees: number; tier: string
      }>>(
        `SELECT t."id", t."name", t."code", t."active", t."createdAt",
                t."planName", t."subStatus", t."endDate",
                t."adminName", t."adminEmail", t."lastLoginAt", t."activeEmployees", t."tier"
         FROM (
           SELECT v."id", v."name", v."code", v."active", v."createdAt",
                  s."planName", s."status" AS "subStatus", s."endDate",
                  adm."name" AS "adminName", adm."email" AS "adminEmail",
                  ll."at" AS "lastLoginAt", ec."c" AS "activeEmployees",
                  ${TIER_CASE_SQL} AS "tier"${FLEET_INNER_SQL}
         ) t
         ${whereSql}
         ORDER BY ${TIER_ORDER_SQL}, t."createdAt" DESC
         LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
        ...params,
      ),
    ])

    const total = Number(countRows[0]?.c || 0)
    const ids = pageRows.map((r) => r.id)

    // per-page usage (grouped, restricted to this page's ids — SCL-7 discipline)
    const [userRows, deviceRows, deviceOnlineRows, storageRows] = ids.length
      ? await Promise.all([
          db.user.groupBy({ by: ["vendorId"], where: { vendorId: { in: ids }, status: "ACTIVE" }, _count: { _all: true } }),
          db.attendanceDevice.groupBy({ by: ["vendorId"], where: { vendorId: { in: ids }, enabled: true }, _count: { _all: true } }),
          db.attendanceDevice.groupBy({ by: ["vendorId"], where: { vendorId: { in: ids }, enabled: true, status: "ONLINE" }, _count: { _all: true } }),
          db.usageRollup.findMany({ where: { vendorId: { in: ids } }, select: { vendorId: true, storageBytes: true } }),
        ])
      : [[], [], [], []]
    const cnt = (rows: { vendorId: string; _count?: { _all?: number } }[], id: string) =>
      Number(rows.find((r) => r.vendorId === id)?._count?._all || 0)
    const storageOf = new Map(storageRows.map((r) => [r.vendorId, Number(r.storageBytes)]))

    return {
      total,
      page: p.page,
      pageSize: p.pageSize,
      rows: pageRows.map((r) => ({
        id: r.id,
        name: r.name,
        code: r.code,
        active: r.active,
        createdAt: r.createdAt,
        admin: r.adminEmail ? { name: r.adminName || "", email: r.adminEmail } : null,
        planName: r.planName || "Legacy (no subscription)",
        subscriptionStatus: r.subStatus || "LEGACY",
        endDate: r.endDate,
        tier: r.tier,
        lastLoginAt: r.lastLoginAt,
        activeEmployees: Number(r.activeEmployees || 0),
        activeUsers: cnt(userRows, r.id),
        devicesEnabled: cnt(deviceRows, r.id),
        devicesOnline: cnt(deviceOnlineRows, r.id),
        storageBytes: storageOf.get(r.id) ?? 0,
      })),
    }
  },
})

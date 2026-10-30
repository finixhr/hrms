// ============ Quota Utilization console + threshold alerts (Phase 5 P1) =======
// Fleet-wide plan-quota governance for the owner console:
//   1. owner.quotas.overview  — one fixed-set aggregate query answering every
//      per-quota KPI (over / near / metered / unlimited per limit key) —
//      fleet-size independent, no per-vendor fan-out.
//   2. owner.quotas.matrix    — the per-tenant utilization grid. Pages in SQL
//      over a wrapped query; the per-row usage numbers AND the worst-quota
//      tier are computed IN SQL (7 LATERAL counts + the admin LATERAL), so
//      filtering and worst-first sorting by tier never materializes the fleet
//      (the owner.fleet.tenants discipline, applied from birth).
//   3. checkQuotaThresholds() — the daily platform pass (jobs.ts
//      platformDailyJobs) that fires QUOTA_THRESHOLD alerts when a subscribed
//      tenant crosses the configured utilization threshold. One set-based
//      query returns ONLY the crossing rows; deduped per (vendor, key, month)
//      in SaaSSetting group "jobs" (the renewal-reminder key pattern), so a
//      crossing alerts at most once per calendar month per tenant per quota.
//
// UTILITIZATION BANDS (single source = the SQL CASE; documented for the UI):
//   OVER — used >= cap. The create path is already blocked here
//          (requireCapacity rejects used + 1 > cap, so a tenant AT cap has no
//          headroom); existing records above cap stay usable (never bricked).
//   NEAR — used >= 85% of cap and used < cap. Upgrade-conversation territory.
//   OK   — everything below 85%.
//   LEGACY tenants (no subscription row) have no caps and never appear in the
//   matrix; they are counted separately in the overview.
import { z } from "zod"
import { db } from "@/lib/db"
import { ownerAction } from "./owner-routes"
import { getSaasSettings } from "./settings"
import { sendPlatformAlertWebhook, notifyOwnerUsers } from "./notify"

/** The fraction of a quota's cap at which a row is labelled NEAR (must match
 *  the SQL — quoted here so the UI tooltip and the docs agree). */
export const NEAR_FLOOR_PCT = 0.85

const GB = 1073741824

// ---- per-key usage SQL fragments (must match usageSnapshot() semantics) ----
// Each fragment is a scalar subquery over s (the subscription row's tenant).
const USED_SQL: Record<string, string> = {
  EMPLOYEES: `(SELECT COUNT(*)::int FROM "Employee" e WHERE e."vendorId" = s."vendorId" AND e."status" NOT IN ('RESIGNED','TERMINATED','RETIRED','INACTIVE'))::double precision`,
  USERS: `(SELECT COUNT(*)::int FROM "User" ur WHERE ur."vendorId" = s."vendorId" AND ur."status" = 'ACTIVE')::double precision`,
  BRANCHES: `(SELECT COUNT(*)::int FROM "Branch" b WHERE b."vendorId" = s."vendorId")::double precision`,
  DEPARTMENTS: `(SELECT COUNT(*)::int FROM "Department" d WHERE d."vendorId" = s."vendorId")::double precision`,
  DEVICES: `(SELECT COUNT(*)::int FROM "AttendanceDevice" ad WHERE ad."vendorId" = s."vendorId" AND ad."enabled" = true)::double precision`,
  TRACKING_EMPLOYEES: `(SELECT COUNT(*)::int FROM "EmployeeTrackingState" ts WHERE ts."vendorId" = s."vendorId" AND ts."trackingEnabled" = true)::double precision`,
  // storage: the UsageRollup read path (entitlements.storageUsedBytes) —
  // the nightly set-based reconciliation keeps it correct. Expressed in GB
  // (double) so the over/near math shares one code path with the headcounts.
  STORAGE: `(SELECT COALESCE(r."storageBytes", 0) FROM "UsageRollup" r WHERE r."vendorId" = s."vendorId")::double precision / ${GB}.0`,
}

const CAP_SQL: Record<string, string> = {
  EMPLOYEES: `CAST(p."employeeLimit" AS double precision)`,
  USERS: `CAST(p."userLimit" AS double precision)`,
  BRANCHES: `CAST(p."branchLimit" AS double precision)`,
  DEPARTMENTS: `CAST(p."departmentLimit" AS double precision)`,
  DEVICES: `CAST(p."deviceLimit" AS double precision)`,
  TRACKING_EMPLOYEES: `CAST(p."trackingEmployeeLimit" AS double precision)`,
  STORAGE: `CAST(COALESCE(o."storageGbOverride", p."storageGb") AS double precision)`,
}

const CAP_IS_NOT_NULL_SQL: Record<string, string> = {
  EMPLOYEES: `p."employeeLimit" IS NOT NULL`,
  USERS: `p."userLimit" IS NOT NULL`,
  BRANCHES: `p."branchLimit" IS NOT NULL`,
  DEPARTMENTS: `p."departmentLimit" IS NOT NULL`,
  DEVICES: `p."deviceLimit" IS NOT NULL`,
  TRACKING_EMPLOYEES: `p."trackingEmployeeLimit" IS NOT NULL`,
  STORAGE: `COALESCE(o."storageGbOverride", p."storageGb") IS NOT NULL`,
}

const LIMIT_KEYS_ORDER = ["EMPLOYEES", "USERS", "BRANCHES", "DEPARTMENTS", "DEVICES", "TRACKING_EMPLOYEES", "STORAGE"] as const

/** The per-tenant SELECT with the SQL-computed per-quota numbers and the
 *  worst-quota tier (shared by page + count; mirrors owner.fleet.tenants). */
const QUOTA_INNER_SQL = `
  FROM "Vendor" v
  JOIN "SaaSSubscription" s ON s."vendorId" = v."id"
  JOIN "SaaSPlan" p ON p."id" = s."planId"
  LEFT JOIN "SaaSTenantOverride" o ON o."vendorId" = v."id"
  LEFT JOIN LATERAL (
    SELECT u."name", u."email" FROM "User" u
    WHERE u."vendorId" = v."id" AND u."role" = 'VENDOR_OWNER'
    ORDER BY u."createdAt" ASC LIMIT 1
  ) adm ON true
  LEFT JOIN LATERAL (
    SELECT COUNT(*)::int AS c FROM "Employee" e
    WHERE e."vendorId" = v."id"
      AND e."status" NOT IN ('RESIGNED', 'TERMINATED', 'RETIRED', 'INACTIVE')
  ) ec ON true
  LEFT JOIN LATERAL (
    SELECT COUNT(*)::int AS c FROM "User" ur
    WHERE ur."vendorId" = v."id" AND ur."status" = 'ACTIVE'
  ) uc ON true
  LEFT JOIN LATERAL (
    SELECT COUNT(*)::int AS c FROM "Branch" b WHERE b."vendorId" = v."id"
  ) bc ON true
  LEFT JOIN LATERAL (
    SELECT COUNT(*)::int AS c FROM "Department" d WHERE d."vendorId" = v."id"
  ) dc ON true
  LEFT JOIN LATERAL (
    SELECT COUNT(*)::int AS c FROM "AttendanceDevice" ad
    WHERE ad."vendorId" = v."id" AND ad."enabled" = true
  ) devc ON true
  LEFT JOIN LATERAL (
    SELECT COUNT(*)::int AS c FROM "EmployeeTrackingState" ts
    WHERE ts."vendorId" = v."id" AND ts."trackingEnabled" = true
  ) tc ON true
  LEFT JOIN LATERAL (
    SELECT COALESCE(r."storageBytes", 0) AS b FROM "UsageRollup" r WHERE r."vendorId" = v."id"
  ) st ON true`

const TIER_CASE_SQL = `
  CASE
    WHEN (p."employeeLimit" IS NOT NULL AND ec."c" >= p."employeeLimit")
      OR (p."userLimit" IS NOT NULL AND uc."c" >= p."userLimit")
      OR (p."branchLimit" IS NOT NULL AND bc."c" >= p."branchLimit")
      OR (p."departmentLimit" IS NOT NULL AND dc."c" >= p."departmentLimit")
      OR (p."deviceLimit" IS NOT NULL AND devc."c" >= p."deviceLimit")
      OR (p."trackingEmployeeLimit" IS NOT NULL AND tc."c" >= p."trackingEmployeeLimit")
      OR (COALESCE(o."storageGbOverride", p."storageGb") IS NOT NULL
          AND st."b" >= COALESCE(o."storageGbOverride", p."storageGb") * ${GB}::bigint)
      THEN 'OVER'
    WHEN (p."employeeLimit" IS NOT NULL AND ec."c" >= ${NEAR_FLOOR_PCT} * p."employeeLimit" AND ec."c" < p."employeeLimit")
      OR (p."userLimit" IS NOT NULL AND uc."c" >= ${NEAR_FLOOR_PCT} * p."userLimit" AND uc."c" < p."userLimit")
      OR (p."branchLimit" IS NOT NULL AND bc."c" >= ${NEAR_FLOOR_PCT} * p."branchLimit" AND bc."c" < p."branchLimit")
      OR (p."departmentLimit" IS NOT NULL AND dc."c" >= ${NEAR_FLOOR_PCT} * p."departmentLimit" AND dc."c" < p."departmentLimit")
      OR (p."deviceLimit" IS NOT NULL AND devc."c" >= ${NEAR_FLOOR_PCT} * p."deviceLimit" AND devc."c" < p."deviceLimit")
      OR (p."trackingEmployeeLimit" IS NOT NULL AND tc."c" >= ${NEAR_FLOOR_PCT} * p."trackingEmployeeLimit" AND tc."c" < p."trackingEmployeeLimit")
      OR (COALESCE(o."storageGbOverride", p."storageGb") IS NOT NULL
          AND st."b" >= ${NEAR_FLOOR_PCT} * COALESCE(o."storageGbOverride", p."storageGb") * ${GB}::bigint
          AND st."b" < COALESCE(o."storageGbOverride", p."storageGb") * ${GB}::bigint)
      THEN 'NEAR'
    ELSE 'OK'
  END`

const QUOTA_PAGE = z.object({
  page: z.number().int().min(1).default(1),
  pageSize: z.number().int().min(1).max(100).default(25),
  search: z.string().trim().max(120).optional(),
  tier: z.enum(["ALL", "OVER", "NEAR", "OK"]).default("ALL"),
}).passthrough()

// ---- 1. overview — fixed-set per-quota aggregates ---------------------------
ownerAction("owner.quotas.overview", {
  perm: "tenants.view",
  handler: async () => {
    // One round trip: a UNION ALL of per-key rows (one row per subscribed
    // tenant per key), folded into ONE row per key. Output is therefore
    // FIXED at ≤ 7 rows regardless of fleet size.
    const perKey = LIMIT_KEYS_ORDER.map((key) => `
      SELECT '${key}'::text AS key,
             (${CAP_IS_NOT_NULL_SQL[key]}) AS metered,
             ${CAP_SQL[key]} AS cap,
             ${USED_SQL[key]} AS used
      FROM "SaaSSubscription" s
      JOIN "SaaSPlan" p ON p."id" = s."planId"
      ${key === "STORAGE" ? 'LEFT JOIN "SaaSTenantOverride" o ON o."vendorId" = s."vendorId"' : ""}`).join("\nUNION ALL")

    const [bandRows, subscribed, legacy] = await Promise.all([
      db.$queryRawUnsafe<Array<{ key: string; over: number; near: number; metered: number; unlimited: number }>>(
        `SELECT k."key",
                COUNT(*) FILTER (WHERE k.metered AND k.used >= k.cap)::int AS over,
                COUNT(*) FILTER (WHERE k.metered AND k.used < k.cap AND k.used >= ${NEAR_FLOOR_PCT} * k.cap)::int AS near,
                COUNT(*) FILTER (WHERE k.metered)::int AS metered,
                COUNT(*) FILTER (WHERE NOT k.metered)::int AS unlimited
         FROM (${perKey}) k
         GROUP BY k."key"`,
      ),
      db.saasSubscription.count(),
      db.$queryRawUnsafe<Array<{ c: number }>>(
        `SELECT COUNT(*)::int AS c FROM "Vendor" v
         WHERE NOT EXISTS (SELECT 1 FROM "SaaSSubscription" s WHERE s."vendorId" = v."id")`,
      ),
    ])

    const byKey = new Map(bandRows.map((r) => [r.key, r]))
    const quotas = LIMIT_KEYS_ORDER.map((key) => {
      const r = byKey.get(key)
      return {
        key,
        over: Number(r?.over || 0),
        near: Number(r?.near || 0),
        metered: Number(r?.metered || 0),
        unlimited: Number(r?.unlimited || 0),
      }
    })
    // the alert policy rides the overview (no settings.view needed on this
    // page — the values carry no secrets and are display-only)
    const settings = await getSaasSettings()
    const rawPct = Number(settings.alerts.quotaThresholdPercent)
    const thresholdPercent = Math.max(50, Math.min(100, Number.isFinite(rawPct) && rawPct > 0 ? rawPct : 90))
    return {
      generatedAt: new Date().toISOString(),
      subscribedTenants: subscribed,
      legacyTenants: Number(legacy[0]?.c || 0),
      quotas,
      alertPolicy: {
        enabled: settings.alerts.quotaAlertsEnabled === true,
        thresholdPercent,
        nearFloorPercent: Math.round(NEAR_FLOOR_PCT * 100),
      },
    }
  },
})

// ---- 2. matrix — the per-tenant grid, paged + tiered in SQL ----------------
ownerAction("owner.quotas.matrix", {
  perm: "tenants.view",
  schema: QUOTA_PAGE,
  handler: async (_ctx, p) => {
    // Parameterized construction — request data only ever rides as $n
    // placeholders; the SQL text is static fragments (fleet.ts discipline).
    const params: unknown[] = []
    const conds: string[] = []
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

    const selectCols = `
      v."id", v."name", v."code", v."createdAt",
      s."planName", s."status" AS "subStatus", s."endDate",
      adm."name" AS "adminName", adm."email" AS "adminEmail",
      ${TIER_CASE_SQL} AS "tier",
      ec."c" AS "employeesUsed", p."employeeLimit" AS "employeesCap",
      uc."c" AS "usersUsed", p."userLimit" AS "usersCap",
      bc."c" AS "branchesUsed", p."branchLimit" AS "branchesCap",
      dc."c" AS "departmentsUsed", p."departmentLimit" AS "departmentsCap",
      devc."c" AS "devicesUsed", p."deviceLimit" AS "devicesCap",
      tc."c" AS "trackingUsed", p."trackingEmployeeLimit" AS "trackingCap",
      st."b" AS "storageBytes", COALESCE(o."storageGbOverride", p."storageGb") AS "storageCapGb"`

    const [countRows, pageRows] = await Promise.all([
      db.$queryRawUnsafe<Array<{ c: number }>>(
        `SELECT COUNT(*)::int AS c FROM (
           SELECT v."name", v."code", ${TIER_CASE_SQL} AS "tier", adm."email" AS "adminEmail"${QUOTA_INNER_SQL}
         ) t ${whereSql}`,
        ...params.slice(0, -2),
      ),
      db.$queryRawUnsafe<Array<{
        id: string; name: string; code: string; createdAt: Date
        planName: string | null; subStatus: string; endDate: Date | null
        adminName: string | null; adminEmail: string | null; tier: string
        employeesUsed: number; employeesCap: number | null
        usersUsed: number; usersCap: number | null
        branchesUsed: number; branchesCap: number | null
        departmentsUsed: number; departmentsCap: number | null
        devicesUsed: number; devicesCap: number | null
        trackingUsed: number; trackingCap: number | null
        storageBytes: bigint; storageCapGb: number | null
      }>>(
        `SELECT t."id", t."name", t."code", t."createdAt",
                t."planName", t."subStatus", t."endDate",
                t."adminName", t."adminEmail", t."tier",
                t."employeesUsed", t."employeesCap",
                t."usersUsed", t."usersCap",
                t."branchesUsed", t."branchesCap",
                t."departmentsUsed", t."departmentsCap",
                t."devicesUsed", t."devicesCap",
                t."trackingUsed", t."trackingCap",
                t."storageBytes", t."storageCapGb"
         FROM (
           SELECT ${selectCols}${QUOTA_INNER_SQL}
         ) t
         ${whereSql}
         ORDER BY CASE t."tier" WHEN 'OVER' THEN 0 WHEN 'NEAR' THEN 1 ELSE 2 END, t."createdAt" DESC
         LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
        ...params,
      ),
    ])

    const total = Number(countRows[0]?.c || 0)
    const num = (v: unknown): number => Number(v ?? 0)

    return {
      total,
      page: p.page,
      pageSize: p.pageSize,
      rows: pageRows.map((r) => ({
        id: r.id,
        name: r.name,
        code: r.code,
        createdAt: r.createdAt,
        admin: r.adminEmail ? { name: r.adminName || "", email: r.adminEmail } : null,
        planName: r.planName || "—",
        subscriptionStatus: r.subStatus,
        endDate: r.endDate,
        tier: r.tier,
        quotas: {
          EMPLOYEES: { used: num(r.employeesUsed), cap: r.employeesCap == null ? null : Number(r.employeesCap) },
          USERS: { used: num(r.usersUsed), cap: r.usersCap == null ? null : Number(r.usersCap) },
          BRANCHES: { used: num(r.branchesUsed), cap: r.branchesCap == null ? null : Number(r.branchesCap) },
          DEPARTMENTS: { used: num(r.departmentsUsed), cap: r.departmentsCap == null ? null : Number(r.departmentsCap) },
          DEVICES: { used: num(r.devicesUsed), cap: r.devicesCap == null ? null : Number(r.devicesCap) },
          TRACKING_EMPLOYEES: { used: num(r.trackingUsed), cap: r.trackingCap == null ? null : Number(r.trackingCap) },
          // storage bytes are BigInt in the rollup — Number() at the boundary
          // (JSON.stringify would drop the row otherwise; the H-09 lesson)
          STORAGE: { usedBytes: Number(r.storageBytes ?? 0), capGb: r.storageCapGb == null ? null : Number(r.storageCapGb) },
        },
      })),
    }
  },
})

// ---- 3. daily threshold pass (jobs.ts platformDailyJobs) -------------------
export type QuotaCrossing = {
  vendorId: string
  vendorName: string
  key: string
  used: number
  cap: number
}

export type QuotaThresholdResult = {
  ranAt: string
  enabled: boolean
  thresholdPercent: number
  totalCrossings: number
  freshCrossings: number
  crossings: QuotaCrossing[]
  webhook: { status: "SENT" | "FAILED" | "SKIPPED"; detail?: string } | null
  email: { sent: number; skipped: number; failed: number } | null
}

/** The ONE set-based crossings query: a UNION of per-key SELECTs that already
 *  filters in SQL (cap IS NOT NULL, operating status, used ≥ threshold% of
 *  cap), so the result only ever contains rows worth alerting on. */
function crossingsSql(thresholdPercent: number): string {
  return LIMIT_KEYS_ORDER.map((key) => `
    SELECT s."vendorId", v."name" AS "vendorName", '${key}'::text AS key,
           ${USED_SQL[key]} AS used, ${CAP_SQL[key]} AS cap
    FROM "SaaSSubscription" s
    JOIN "SaaSPlan" p ON p."id" = s."planId"
    JOIN "Vendor" v ON v."id" = s."vendorId"
    ${key === "STORAGE" ? 'LEFT JOIN "SaaSTenantOverride" o ON o."vendorId" = s."vendorId"' : ""}
    WHERE s."status" IN ('TRIAL', 'ACTIVE', 'PAST_DUE', 'GRACE_PERIOD')
      AND ${CAP_IS_NOT_NULL_SQL[key]}
      AND ${USED_SQL[key]} * 100 >= ${thresholdPercent} * ${CAP_SQL[key]}`).join("\nUNION ALL")
}

const pct = (v: number) => `${v.toFixed(1)}%`

/** Daily quota-threshold pass. Never throws (jobs.ts wraps it, but the P0
 *  alert contract is best-effort end to end): a webhook failure never masks
 *  the email digest, and neither stops the dedupe rows being written. */
export async function checkQuotaThresholds(date: string): Promise<QuotaThresholdResult> {
  const settings = await getSaasSettings()
  const rawPct = Number(settings.alerts.quotaThresholdPercent)
  const thresholdPercent = Math.max(50, Math.min(100, Number.isFinite(rawPct) && rawPct > 0 ? rawPct : 90))
  const base: QuotaThresholdResult = {
    ranAt: new Date().toISOString(),
    enabled: settings.alerts.quotaAlertsEnabled === true,
    thresholdPercent,
    totalCrossings: 0,
    freshCrossings: 0,
    crossings: [],
    webhook: null,
    email: null,
  }
  if (!base.enabled) return base

  const rows = await db.$queryRawUnsafe<Array<{ vendorId: string; vendorName: string; key: string; used: number | bigint; cap: number | bigint }>>(
    `SELECT * FROM (${crossingsSql(thresholdPercent)}) c ORDER BY c."vendorName", c."key"`,
  )
  const crossings: QuotaCrossing[] = rows.map((r) => ({
    vendorId: r.vendorId,
    vendorName: r.vendorName,
    key: r.key,
    used: Number(r.used),
    cap: Number(r.cap),
  }))
  base.totalCrossings = crossings.length
  if (crossings.length === 0) return base

  // dedupe per (vendor, key, calendar month) — the renewal-reminder pattern:
  // a key alerts at most once per month, so a tenant riding at the threshold
  // gets a fresh nudge each month without daily spam.
  const month = date.slice(0, 7)
  const dedupeKey = (c: QuotaCrossing) => `quota-alert:${c.vendorId}:${c.key}:${month}`
  const keys = crossings.map(dedupeKey)
  const seen = await db.saasSetting.findMany({ where: { group: "jobs", key: { in: keys } }, select: { key: true } })
  const seenSet = new Set(seen.map((s) => s.key))
  const fresh = crossings.filter((c) => !seenSet.has(dedupeKey(c)))
  base.freshCrossings = fresh.length
  base.crossings = fresh
  if (fresh.length === 0) return base

  // one digest over every fresh crossing (never one email/webhook per row)
  const lines = fresh.map((c) =>
    c.key === "STORAGE"
      ? `${c.vendorName} — storage ${(c.used / GB).toFixed(2)} GB of ${c.cap} GB (${pct((c.used / GB / c.cap) * 100)})`
      : `${c.vendorName} — ${c.key.toLowerCase().replace(/_/g, " ")} ${Math.round(c.used)} of ${Math.round(c.cap)} (${pct((c.used / c.cap) * 100)})`,
  )
  const subject = `Quota threshold report — ${fresh.length} crossing${fresh.length === 1 ? "" : "s"} at ≥ ${thresholdPercent}%`
  const detail = [
    `${fresh.length} tenant quota crossing(s) at or above ${thresholdPercent}% of the plan cap:`,
    ...lines.map((l) => `  • ${l}`),
    "Upgrade conversations or a plan change resolve these; the daily pass re-arms per tenant per quota each calendar month.",
  ].join("\n")

  // best-effort, in order, never short-circuiting each other
  const webhook = await sendPlatformAlertWebhook("QUOTA_THRESHOLD", subject, detail).catch(() => ({ status: "FAILED" as const, detail: "webhook send threw" }))
  const email = await notifyOwnerUsers(subject, detail, { perm: "tenants.view" }).catch(() => ({ sent: 0, skipped: 0, failed: fresh.length }))
  base.webhook = webhook
  base.email = { sent: email.sent, skipped: email.skipped, failed: email.failed }

  try {
    await db.saasSetting.createMany({
      data: fresh.map((c) => ({ group: "jobs", key: dedupeKey(c), value: JSON.stringify(date) })),
      skipDuplicates: true,
    })
  } catch { /* a concurrent run wrote the same dedupe rows — the findMany above already filtered ours */ }
  return base
}

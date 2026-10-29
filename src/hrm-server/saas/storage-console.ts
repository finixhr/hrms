// ============ Storage Monitoring console (master prompt Part J §15) ==========
// Platform-wide storage governance for the owner console (/owner/storage).
// ONE action answers every number on the page with a FIXED set of ~8 set-based
// queries — fleet-size independent, no per-tenant fan-out (the quotas.ts /
// fleet.ts / growth-console.ts discipline, applied from birth):
//
//   owner.storage.overview
//     totals — allocated / consumed / remaining bytes + tenant, unlimited and
//              object counts (3 aggregates: the subscription JOIN fold, the
//              UsageRollup SUM, the StorageObject COUNT) + the provider split
//              (1 StorageObject groupBy, STORED only)
//     tiers  — over / near / ok tenant counts, folded into the SAME
//              subscription JOIN aggregate via FILTER clauses (one scan feeds
//              both; the bands can never disagree with the rows)
//     rows   — the per-tenant grid: tier computed IN SQL, filter + search +
//              worst-first sort applied in SQL over a wrapped subquery (the
//              owner.quotas.matrix pattern), so paging never materializes the
//              fleet. Object counts ride ONE StorageObject groupBy scoped to
//              the page's vendor ids ONLY — never a count per row.
//     trend  — the last 12 UsageSnapshot periods (vendorId × periodYear ×
//              periodMonth monthly series, Phase 4 WS-D) summed platform-wide
//              per month (1 groupBy + take 12, riding the [periodYear,
//              periodMonth] index — the growth-console.ts read path).
//
// BANDS (single source = quotas.ts NEAR_FLOOR_PCT, so this console and the
// Quota Utilization matrix can never label the same tenant differently):
//   OVER — consumed >= cap bytes (cap = effective storageGb × 1024³, i.e.
//          SaaSTenantOverride.storageGbOverride ?? SaasPlan.storageGb; the
//          upload path is already blocked here by requireCapacity).
//   NEAR — consumed >= NEAR_FLOOR_PCT (85%) of cap and below it.
//   OK   — everything else, INCLUDING unlimited tenants (null cap — they can
//          never be over; the grid renders ∞ for them).
//
// HONEST FRAMING (the UI copy agrees): "allocated" is the SUM OF TENANT
// QUOTAS (effective plan/override storageGb), NOT physical provider capacity
// — the platform does not provision a bucket per tenant. consumedBytes is the
// sum of EVERY UsageRollup row (legacy tenants included — they store real
// bytes too, they just carry no cap). remainingBytes sums max(0, cap −
// consumed) per METERED tenant only: over-quota tenants never contribute
// negative headroom and unlimited tenants contribute none.
//
// BYTES DISCIPLINE (the H-09 lesson): UsageRollup.storageBytes and every
// SUM(...) over it are BigInt/numeric at the SQL boundary — cast ::float8 in
// SQL or Number() in JS BEFORE anything crosses into JSON.
import { z } from "zod"
import { db } from "@/lib/db"
import { ownerAction } from "./owner-routes"
import { NEAR_FLOOR_PCT } from "./quotas"

const GB = 1073741824 // 1024³ — storageGb columns are GB, UsageRollup is bytes

// page cap 500: the grid pages at ≤100 rows, so 500 pages covers a 50K-tenant
// fleet without ever letting a caller demand an unbounded scan
const OVERVIEW_PAGE = z.object({
  page: z.number().int().min(1).max(500).default(1),
  take: z.number().int().min(10).max(100).default(25),
  tier: z.enum(["ALL", "OVER", "NEAR", "OK"]).default("ALL"),
  search: z.string().trim().max(120).optional(),
}).strict()

// ---- shared SQL fragments (static text; request data only rides as $n) ----
// The effective cap: per-tenant override wins over the plan (entitlements.ts
// resolveEntitlements reads exactly this expression).
const CAP = `COALESCE(o."storageGbOverride", p."storageGb")`
// The consumed side: the UsageRollup read path (entitlements.storageUsedBytes)
// — the nightly reconcileStorageRollups() pass keeps it correct.
const USED = `COALESCE(r."storageBytes", 0)`

/** Storage-only tier band — the STORAGE arm of quotas.ts TIER_CASE_SQL (same
 * NEAR_FLOOR_PCT, same >= / < boundaries). Unlimited tenants are always OK. */
const TIER_SQL = `
  CASE
    WHEN ${CAP} IS NOT NULL AND ${USED} >= ${CAP} * ${GB}::bigint THEN 'OVER'
    WHEN ${CAP} IS NOT NULL AND ${USED} >= ${NEAR_FLOOR_PCT} * ${CAP} * ${GB}::bigint
                              AND ${USED} < ${CAP} * ${GB}::bigint THEN 'NEAR'
    ELSE 'OK'
  END`

/** Vendor + current subscription + plan + override + rollup — the population
 * of every storage number on the page (LEGACY tenants have no subscription
 * row and never appear, exactly like the quotas matrix). */
const INNER_SQL = `
  FROM "Vendor" v
  JOIN "SaaSSubscription" s ON s."vendorId" = v."id"
  JOIN "SaaSPlan" p ON p."id" = s."planId"
  LEFT JOIN "SaaSTenantOverride" o ON o."vendorId" = v."id"
  LEFT JOIN "UsageRollup" r ON r."vendorId" = v."id"`

ownerAction("owner.storage.overview", {
  perm: "tenants.view",
  schema: OVERVIEW_PAGE,
  handler: async (_ctx, p) => {
    // ---- rows: parameterized WHERE construction (quotas.ts discipline) ----
    const params: unknown[] = []
    const conds: string[] = []
    if (p.tier !== "ALL") conds.push(`t."tier" = $${params.push(p.tier)}`)
    if (p.search) {
      const q = `%${p.search.toLowerCase()}%`
      conds.push(`(LOWER(t."vendorName") LIKE $${params.push(q)} OR LOWER(t."vendorCode") LIKE $${params.push(q)})`)
    }
    const whereSql = conds.length ? `WHERE ${conds.join(" AND ")}` : ""
    const offset = (p.page - 1) * p.take
    const limitIdx = params.length + 1
    const offsetIdx = params.length + 2
    params.push(p.take, offset)

    // ---- ONE fixed set of 7 parallel queries (fleet-size independent) ----
    // (1) the subscription fold: tenant/unlimited counts, allocated + remaining
    //     bytes and the over/near tier counts, all in a single scan;
    // (2) consumed = SUM(UsageRollup.storageBytes) over EVERY row (legacy
    //     tenants store real bytes too — they carry no cap, not zero bytes);
    // (3) objects = STORED StorageObject count; (4) the same count per
    //     provider; (5) the 12 most recent UsageSnapshot periods, summed
    //     platform-wide per month; (6)+(7) the wrapped count + page for the
    //     grid (tier computed IN SQL so filtering and the worst-first sort
    //     never materialize the fleet).
    const [fold, rollupAgg, objectAgg, providerRows, trendRows, countRows, pageRows] = await Promise.all([
      db.$queryRawUnsafe<Array<{
        tenants: number; unlimited: number
        allocated: number; remaining: number
        over: number; near: number
      }>>(
        `SELECT COUNT(*)::int AS tenants,
                COUNT(*) FILTER (WHERE ${CAP} IS NULL)::int AS unlimited,
                COALESCE(SUM(COALESCE(${CAP}, 0) * ${GB}::bigint), 0)::float8 AS allocated,
                COALESCE(SUM(GREATEST(${CAP} * ${GB}::bigint - ${USED}, 0))
                         FILTER (WHERE ${CAP} IS NOT NULL), 0)::float8 AS remaining,
                COUNT(*) FILTER (WHERE ${CAP} IS NOT NULL AND ${USED} >= ${CAP} * ${GB}::bigint)::int AS over,
                COUNT(*) FILTER (WHERE ${CAP} IS NOT NULL AND ${USED} < ${CAP} * ${GB}::bigint
                                                AND ${USED} >= ${NEAR_FLOOR_PCT} * ${CAP} * ${GB}::bigint)::int AS near
         FROM "SaaSSubscription" s
         JOIN "SaaSPlan" p ON p."id" = s."planId"
         LEFT JOIN "SaaSTenantOverride" o ON o."vendorId" = s."vendorId"
         LEFT JOIN "UsageRollup" r ON r."vendorId" = s."vendorId"`,
      ),
      db.usageRollup.aggregate({ _sum: { storageBytes: true } }),
      db.storageObject.aggregate({ _count: { _all: true }, where: { status: "STORED" } }),
      db.storageObject.groupBy({ by: ["provider"], where: { status: "STORED" }, _count: { _all: true } }),
      db.usageSnapshot.groupBy({
        by: ["periodYear", "periodMonth"],
        _sum: { storageBytes: true },
        orderBy: [{ periodYear: "desc" }, { periodMonth: "desc" }],
        take: 12,
      }),
      db.$queryRawUnsafe<Array<{ c: number }>>(
        `SELECT COUNT(*)::int AS c FROM (
           SELECT v."name" AS "vendorName", v."code" AS "vendorCode", ${TIER_SQL} AS "tier"${INNER_SQL}
         ) t ${whereSql}`,
        ...params.slice(0, -2),
      ),
      db.$queryRawUnsafe<Array<{
        vendorId: string; vendorName: string; vendorCode: string
        planName: string; storageGb: number | null
        consumedBytes: bigint; tier: string
      }>>(
        `SELECT t."vendorId", t."vendorName", t."vendorCode", t."planName",
                t."storageGb", t."consumedBytes", t."tier"
         FROM (
           SELECT v."id" AS "vendorId", v."name" AS "vendorName", v."code" AS "vendorCode",
                  s."planName", ${CAP} AS "storageGb", ${USED} AS "consumedBytes",
                  ${TIER_SQL} AS "tier"${INNER_SQL}
         ) t
         ${whereSql}
         ORDER BY CASE t."tier" WHEN 'OVER' THEN 0 WHEN 'NEAR' THEN 1 ELSE 2 END,
                  t."consumedBytes" DESC
         LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
        ...params,
      ),
    ])

    // ---- object counts for the PAGE's vendors only (one grouped query) ----
    const vendorIds = pageRows.map((r) => r.vendorId)
    const objectCounts = vendorIds.length
      ? await db.storageObject.groupBy({
          by: ["vendorId"],
          where: { vendorId: { in: vendorIds }, status: "STORED" },
          _count: { _all: true },
        })
      : []
    const objectsByVendor = new Map(objectCounts.map((r) => [r.vendorId, Number(r._count?._all || 0)]))

    // ---- assemble the payload (BigInt/numeric → Number at the boundary) ----
    const f = fold[0]
    const tenants = Number(f?.tenants || 0)
    const over = Number(f?.over || 0)
    const near = Number(f?.near || 0)
    const allocatedBytes = Number(f?.allocated || 0)
    const consumedBytes = Number(rollupAgg._sum?.storageBytes || 0)
    const provCount = (id: string) => Number(providerRows.find((r) => r.provider === id)?._count?._all || 0)

    const rows = pageRows.map((r) => {
      // unlimited tenants (storageGb null) carry null allocation/remaining/
      // percent — the grid renders ∞; JS math only for the metered rows
      const capGb = r.storageGb == null ? null : Number(r.storageGb)
      const allocated = capGb == null ? null : capGb * GB
      const consumed = Number(r.consumedBytes ?? 0)
      return {
        vendorId: r.vendorId,
        vendorName: r.vendorName,
        vendorCode: r.vendorCode,
        planName: r.planName || "—",
        storageGb: capGb,
        allocatedBytes: allocated,
        consumedBytes: consumed,
        remainingBytes: allocated == null ? null : Math.max(0, allocated - consumed),
        // a 0-GB metered cap with any bytes is mathematically ∞% — clamp to
        // the band the SQL already assigned (OVER) instead of dividing by 0
        usedPercent: allocated == null ? null
          : allocated === 0 ? (consumed > 0 ? 100 : 0)
          : Math.round((consumed / allocated) * 1000) / 10,
        tier: r.tier,
        objects: objectsByVendor.get(r.vendorId) || 0,
      }
    })

    return {
      generatedAt: new Date().toISOString(),
      totals: {
        allocatedBytes,
        consumedBytes,
        remainingBytes: Number(f?.remaining || 0),
        usedPercent: allocatedBytes > 0 ? Math.round((consumedBytes / allocatedBytes) * 1000) / 10 : 0,
        tenants,
        unlimitedTenants: Number(f?.unlimited || 0),
        objects: Number(objectAgg._count?._all || 0),
        providers: { r2: provCount("r2"), cloudinary: provCount("cloudinary"), local: provCount("local") },
      },
      tiers: { over, near, ok: Math.max(0, tenants - over - near) },
      page: p.page,
      take: p.take,
      total: Number(countRows[0]?.c || 0),
      rows,
      // newest-first from the groupBy → reversed so the chart reads
      // left-to-right, oldest → latest month
      trend: trendRows.slice().reverse().map((r) => ({
        month: `${r.periodYear}-${String(r.periodMonth).padStart(2, "0")}`,
        totalBytes: Number(r._sum?.storageBytes || 0),
      })),
    }
  },
})

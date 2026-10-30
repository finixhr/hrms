// ============ Growth & Engagement console (Phase 5 P3) ========================
// The growth slice of the SaaS Owner Panel: signup growth, MRR + plan mix,
// the registration funnel, churn signals, fleet-wide usage metering (the
// Phase 4 WS-D UsageSnapshot monthly series — previously reachable only
// per-tenant through owner.usage.history), and the per-tenant engagement
// matrix (login intensity over LoginAuditLog). Rebuilds the old Wave 4 SG-C
// analytics surface to the P0/P1/P2 console standard; the long-standing
// owner.analytics.overview action stays untouched and compatible.
//
// SCALE DISCIPLINE (fleet.ts / lifecycle-console.ts / billing-console.ts,
// applied from birth):
//   - owner.growth.overview answers EVERY number with a FIXED set of ~17
//     grouped aggregates (FILTER-clause counts/sums, month/week-truncation
//     trend queries, group-bys) — fleet-size independent, no per-tenant
//     fan-out, no take-capped lists (the old analytics page seeded take:50
//     lists into the UI — those are gone).
//   - owner.growth.engagement pages in SQL with the engagement tier computed
//     IN SQL (one CASE over a login LATERAL over the LoginAuditLog
//     [vendorId, createdAt] index), so the tier chips filter and the
//     dormant-first sort never materialize the fleet. Per-row usage seats
//     ride UsageSnapshot LATERALs (the (vendorId, periodYear, periodMonth)
//     unique index) — latest + previous period, so the MoM delta is one row.
//     Search (name / code) is a SQL WHERE condition, never JS post-filtering.
//
// MONEY: SaasSubscription.priceAtCreation is Decimal(12,2); every raw sum is
// cast ::float8 BEFORE crossing the Prisma boundary, every count ::int — no
// BigInt ever reaches JSON (the H-09 lesson). UsageSnapshot.storageBytes is
// BigInt — summed ::float8 (byte magnitudes are exact in float64 far beyond
// any real fleet).
//
// MRR METHODOLOGY (unchanged from owner.analytics.overview /
// owner.dashboard.overview): every ACTIVE subscription contributes its
// priceAtCreation snapshot per cycle, YEARLY cycles divided by 12; TRIAL rows
// are excluded (a trial is not yet paying); PAST_DUE/GRACE rows contribute
// nothing until they settle (they surface as churn signals instead).
import { z } from "zod"
import { db } from "@/lib/db"
import { ownerAction } from "./owner-routes"

const DAY_MS = 86_400_000

/** The payroll-scope statuses a run can pay — the same set the nightly
 *  captureUsageSnapshots pass counts into employeesPayroll (jobs.ts). */
const PAYROLL_STATUSES = ["ACTIVE", "PROBATION", "ON_LEAVE", "SUSPENDED"]

const MATRIX_PAGE = z.object({
  page: z.number().int().min(1).default(1),
  pageSize: z.number().int().min(1).max(100).default(25),
  search: z.string().trim().max(120).optional(),
  tier: z.enum(["ALL", "DORMANT", "LIGHT", "STEADY", "POWER"]).default("ALL"),
}).passthrough()

// tier chips → the SQL tier values they keep (static enum values — the same
// collection-band pattern as billing-console.ts)
const TIER_TO_VALUES: Record<string, string[]> = {
  DORMANT: ["DORMANT"],
  LIGHT: ["LIGHT"],
  STEADY: ["STEADY"],
  POWER: ["POWER"],
}

// ---- 1. overview — growth, revenue, funnel, churn, usage, engagement --------
ownerAction("owner.growth.overview", {
  perm: "tenants.view",
  handler: async () => {
    const now = new Date()
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
    const d30 = new Date(now.getTime() - 30 * DAY_MS)
    const signupStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 11, 1))
    const usageStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 5, 1))

    // The usage-metering months — three index-driven set queries over the
    // [periodYear, periodMonth] index, never a full-table group-by:
    //   (a) the two most recent DISTINCT periods anywhere (the MoM pair),
    //   (b) the fleet sums for exactly those periods,
    //   (c) the per-month sums inside the 6-month trend window.
    const [topPeriods, usageTrendRows] = await Promise.all([
      db.$queryRawUnsafe<Array<{ y: number; m: number }>>(
        `SELECT "periodYear" AS y, "periodMonth" AS m
         FROM "UsageSnapshot"
         GROUP BY 1, 2
         ORDER BY 1 DESC, 2 DESC
         LIMIT 2`,
      ),
      db.$queryRawUnsafe<Array<{
        y: number; m: number
        employeesTotal: number; employeesPayroll: number; portalUsers: number
        devicesEnrolled: number; storageBytes: number
      }>>(
        `SELECT "periodYear" AS y, "periodMonth" AS m,
                SUM("employeesTotal")::float8 AS "employeesTotal",
                SUM("employeesPayroll")::float8 AS "employeesPayroll",
                SUM("portalUsers")::float8 AS "portalUsers",
                SUM("devicesEnrolled")::float8 AS "devicesEnrolled",
                SUM("storageBytes")::float8 AS "storageBytes"
         FROM "UsageSnapshot"
         WHERE "periodYear" > $1 OR ("periodYear" = $1 AND "periodMonth" >= $2)
         GROUP BY 1, 2
         ORDER BY 1 DESC, 2 DESC`,
        usageStart.getUTCFullYear(), usageStart.getUTCMonth() + 1,
      ),
    ])

    // fleet sums for the top-two periods (empty when nothing is metered yet)
    let usageMonths: Array<{
      y: number; m: number
      employeesTotal: number; employeesPayroll: number; portalUsers: number
      devicesEnrolled: number; storageBytes: number
    }> = []
    if (topPeriods.length) {
      const pair = topPeriods.map((p) => `(${p.y}, ${p.m})`).join(", ") // ints from our own GROUP BY — no user input
      usageMonths = await db.$queryRawUnsafe(
        `SELECT "periodYear" AS y, "periodMonth" AS m,
                SUM("employeesTotal")::float8 AS "employeesTotal",
                SUM("employeesPayroll")::float8 AS "employeesPayroll",
                SUM("portalUsers")::float8 AS "portalUsers",
                SUM("devicesEnrolled")::float8 AS "devicesEnrolled",
                SUM("storageBytes")::float8 AS "storageBytes"
         FROM "UsageSnapshot"
         WHERE ("periodYear", "periodMonth") IN (${pair})
         GROUP BY 1, 2
         ORDER BY 1 DESC, 2 DESC`,
      )
    }

    const [
      vendorRows,
      subRows,
      planRows,
      registrationRows,
      churnRows,
      failedPayments,
      signupRows,
      empTotal,
      empPayroll,
      portalUsersLive,
      devicesLive,
      storageLive,
      loginRows,
      engagedActiveRows,
      weekRows,
    ] = await Promise.all([
      // one Vendor scan: total / active / new-30d / new-MTD (FILTER clauses)
      db.$queryRawUnsafe<Array<{ total: number; active: number; new30d: number; newMtd: number }>>(
        `SELECT COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE "active")::int AS active,
                COUNT(*) FILTER (WHERE "createdAt" >= $1)::int AS "new30d",
                COUNT(*) FILTER (WHERE "createdAt" >= $2)::int AS "newMtd"
         FROM "Vendor"`,
        d30, monthStart,
      ),
      // one Subscription scan: MRR + paying subs + past-due + trials
      db.$queryRawUnsafe<Array<{ mrr: number; payingSubs: number; pastDueSubs: number; trials: number }>>(
        `SELECT COALESCE(SUM(CASE WHEN "status" = 'ACTIVE' AND "billingCycle" = 'YEARLY' THEN "priceAtCreation" / 12.0
                                  WHEN "status" = 'ACTIVE' THEN "priceAtCreation"
                                  ELSE 0 END), 0)::float8 AS mrr,
                COUNT(*) FILTER (WHERE "status" = 'ACTIVE')::int AS "payingSubs",
                COUNT(*) FILTER (WHERE "status" IN ('PAST_DUE', 'GRACE_PERIOD'))::int AS "pastDueSubs",
                COUNT(*) FILTER (WHERE "status" = 'TRIAL')::int AS trials
         FROM "SaaSSubscription"`,
      ),
      // plan mix — operating subs per plan with each plan's MRR contribution
      db.$queryRawUnsafe<Array<{ planId: string; name: string; subscribers: number; mrr: number }>>(
        `SELECT s."planId", p."name", COUNT(*)::int AS subscribers,
                COALESCE(SUM(CASE WHEN s."status" = 'ACTIVE' AND s."billingCycle" = 'YEARLY' THEN s."priceAtCreation" / 12.0
                                  WHEN s."status" = 'ACTIVE' THEN s."priceAtCreation"
                                  ELSE 0 END), 0)::float8 AS mrr
         FROM "SaaSSubscription" s JOIN "SaaSPlan" p ON p."id" = s."planId"
         WHERE s."status" IN ('ACTIVE', 'TRIAL')
         GROUP BY 1, 2
         ORDER BY 4 DESC`,
      ),
      // registration funnel — applications by status
      db.saasRegistration.groupBy({ by: ["status"], _count: { _all: true } }),
      // churn signals — every lifecycle event type in the trailing 30d
      db.saasSubscriptionEvent.groupBy({ by: ["type"], _count: { _all: true }, where: { createdAt: { gte: d30 } } }),
      // failed payment attempts in the trailing 30d
      db.saasPayment.count({ where: { status: "FAILED", createdAt: { gte: d30 } } }),
      // 12-month signup trend (by vendor creation month, UTC)
      db.$queryRawUnsafe<Array<{ m: string; c: number }>>(
        `SELECT to_char(date_trunc('month', "createdAt"), 'YYYY-MM') AS m, COUNT(*)::int AS c
         FROM "Vendor" WHERE "createdAt" >= $1 GROUP BY 1`,
        signupStart,
      ),
      // live fleet usage — the same five numbers the nightly capture writes
      db.employee.count(),
      db.employee.count({ where: { status: { in: PAYROLL_STATUSES } } }),
      db.user.count({ where: { status: "ACTIVE" } }),
      db.attendanceDevice.count({ where: { enabled: true } }),
      db.usageRollup.aggregate({ _sum: { storageBytes: true } }),
      // engagement — successful tenant-plane logins in the trailing 30d
      db.$queryRawUnsafe<Array<{ logins: number; engaged: number }>>(
        `SELECT COUNT(*)::int AS logins, COUNT(DISTINCT "vendorId")::int AS engaged
         FROM "LoginAuditLog"
         WHERE "plane" = 'TENANT' AND "success" = true AND "createdAt" >= $1`,
        d30,
      ),
      // engaged ACTIVE tenants (the honest denominator for the share)
      db.$queryRawUnsafe<Array<{ engaged: number }>>(
        `SELECT COUNT(DISTINCT l."vendorId")::int AS engaged
         FROM "LoginAuditLog" l JOIN "Vendor" v ON v."id" = l."vendorId"
         WHERE l."plane" = 'TENANT' AND l."success" = true AND l."createdAt" >= $1 AND v."active" = true`,
        d30,
      ),
      // logins by week — the trailing 6 calendar weeks (Monday starts, UTC)
      db.$queryRawUnsafe<Array<{ w: string; c: number }>>(
        `SELECT to_char(date_trunc('week', "createdAt"), 'YYYY-MM-DD') AS w, COUNT(*)::int AS c
         FROM "LoginAuditLog"
         WHERE "plane" = 'TENANT' AND "success" = true AND "createdAt" >= $1
         GROUP BY 1`,
        new Date(now.getTime() - 42 * DAY_MS),
      ),
    ])

    const vendors = vendorRows[0] || { total: 0, active: 0, new30d: 0, newMtd: 0 }
    const subs = subRows[0] || { mrr: 0, payingSubs: 0, pastDueSubs: 0, trials: 0 }
    const logins = loginRows[0] || { logins: 0, engaged: 0 }
    const engagedActive = Number(engagedActiveRows[0]?.engaged || 0)

    // signup trend: last 12 calendar months ALWAYS present (zero months stay
    // zero — never fabricated, never missing)
    const signupOf = new Map(signupRows.map((r) => [r.m, Number(r.c || 0)]))
    const signupTrend: { month: string; vendors: number }[] = []
    for (let i = 11; i >= 0; i--) {
      const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1))
      const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`
      signupTrend.push({ month: key, vendors: signupOf.get(key) || 0 })
    }

    // usage metering: latest + previous distinct period (fleet sums) → MoM
    const periodKey = (r: { y: number; m: number }) => `${r.y}-${String(r.m).padStart(2, "0")}`
    const latestSnap = usageMonths[0] || null
    const previousSnap = usageMonths[1] || null
    const snapMetrics = (r: typeof latestSnap) => r ? {
      employeesTotal: Number(r.employeesTotal || 0),
      employeesPayroll: Number(r.employeesPayroll || 0),
      portalUsers: Number(r.portalUsers || 0),
      devicesEnrolled: Number(r.devicesEnrolled || 0),
      storageBytes: Number(r.storageBytes || 0),
    } : null

    // usage trend: last 6 calendar months ALWAYS present (zeros honest — a
    // month without a snapshot row renders as zero, never fabricated)
    const usageOf = new Map(usageTrendRows.map((r) => [periodKey(r), r]))
    const usageTrend: { month: string; employeesTotal: number; employeesPayroll: number; portalUsers: number; devicesEnrolled: number; storageBytes: number }[] = []
    for (let i = 5; i >= 0; i--) {
      const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1))
      const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`
      const r = usageOf.get(key)
      usageTrend.push({
        month: key,
        employeesTotal: r ? Number(r.employeesTotal || 0) : 0,
        employeesPayroll: r ? Number(r.employeesPayroll || 0) : 0,
        portalUsers: r ? Number(r.portalUsers || 0) : 0,
        devicesEnrolled: r ? Number(r.devicesEnrolled || 0) : 0,
        storageBytes: r ? Number(r.storageBytes || 0) : 0,
      })
    }

    // churn counts from the event group-by (types absent in the window → 0)
    const churnOf = new Map(churnRows.map((r) => [r.type, Number(r._count?._all || 0)]))
    const cancelled30d = churnOf.get("CANCELLED") || 0
    const churnDenominator = subs.payingSubs + cancelled30d
    const churnRate30d = churnDenominator > 0 ? Math.round((cancelled30d / churnDenominator) * 1000) / 10 : null

    // engagement weeks: the 6 calendar weeks ending at the current one
    const weekMs = 7 * DAY_MS
    const thisWeekStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
    thisWeekStart.setUTCDate(thisWeekStart.getUTCDate() - ((thisWeekStart.getUTCDay() + 6) % 7)) // Monday
    const weekOf = new Map(weekRows.map((r) => [r.w, Number(r.c || 0)]))
    const loginsByWeek: { weekStart: string; logins: number }[] = []
    for (let i = 5; i >= 0; i--) {
      const ws = new Date(thisWeekStart.getTime() - i * weekMs)
      const key = ws.toISOString().slice(0, 10)
      loginsByWeek.push({ weekStart: key, logins: weekOf.get(key) || 0 })
    }

    // registration funnel — every status that exists surfaces (the P1
    // lifecycle "future statuses still surface" discipline); the UI tiles read
    // the canonical five, nothing is silently dropped
    const registrations: Record<string, number> = {}
    for (const r of registrationRows) registrations[r.status] = Number(r._count?._all || 0)
    for (const k of ["PENDING", "APPROVED", "REJECTED", "CANCELLED", "WITHDRAWN"]) {
      if (!(k in registrations)) registrations[k] = 0
    }

    return {
      generatedAt: new Date().toISOString(),
      growth: {
        tenantsTotal: vendors.total,
        tenantsActive: vendors.active,
        newVendors30d: vendors.new30d,
        newVendorsMtd: vendors.newMtd,
        trialsCurrent: subs.trials,
        signupTrend,
      },
      revenue: {
        mrr: subs.mrr,
        currency: "BDT",
        payingSubs: subs.payingSubs,
        arpu: subs.payingSubs > 0 ? Math.round((subs.mrr / subs.payingSubs) * 100) / 100 : null,
        planMix: planRows.map((r) => ({
          planId: r.planId, name: r.name,
          subscribers: Number(r.subscribers || 0), mrr: Number(r.mrr || 0),
        })),
        pastDueSubs: subs.pastDueSubs,
        failedPayments30d: Number(failedPayments || 0),
      },
      churn: {
        cancelled30d,
        expired30d: churnOf.get("EXPIRED") || 0,
        suspended30d: churnOf.get("SUSPENDED") || 0,
        reactivated30d: churnOf.get("REACTIVATED") || 0,
        churnRate30d, // null when nothing was operating — never a fabricated 0%
        events30d: churnRows
          .map((r) => ({ type: r.type, count: Number(r._count?._all || 0) }))
          .sort((a, b) => b.count - a.count),
      },
      usage: {
        live: {
          employeesTotal: Number(empTotal || 0),
          employeesPayroll: Number(empPayroll || 0),
          portalUsers: Number(portalUsersLive || 0),
          devicesEnrolled: Number(devicesLive || 0),
          storageBytes: Number(storageLive._sum.storageBytes || 0),
        },
        latestPeriod: latestSnap ? periodKey(latestSnap) : null,
        previousPeriod: previousSnap ? periodKey(previousSnap) : null,
        latest: snapMetrics(latestSnap),
        previous: snapMetrics(previousSnap),
        trend: usageTrend,
      },
      engagement: {
        engagedTenants30d: logins.engaged,
        engagedActive30d: engagedActive,
        idleActive: Math.max(0, vendors.active - engagedActive),
        logins30d: logins.logins,
        engagedShare30d: vendors.active > 0 ? Math.round((engagedActive / vendors.active) * 100) : null,
        loginsByWeek,
        registrations,
      },
    }
  },
})

// ---- 2. engagement — the per-tenant engagement matrix, paged in SQL --------
// The tier is computed IN SQL from a login LATERAL (successful tenant-plane
// logins: 30-day count + last-ever timestamp in one scan over the
// [vendorId, createdAt] index); usage seats ride UsageSnapshot LATERALs
// (latest + previous period). DORMANT first (the actionable end), then LIGHT,
// STEADY, POWER; within a tier the most intense first, then the stalest.
ownerAction("owner.growth.engagement", {
  perm: "tenants.view",
  schema: MATRIX_PAGE,
  handler: async (_ctx, p) => {
    const params: unknown[] = []
    const conds: string[] = []
    if (p.search) {
      const q = `%${p.search.toLowerCase()}%`
      conds.push(`(LOWER(t."name") LIKE $${params.push(q)} OR LOWER(t."code") LIKE $${params.push(q)})`)
    }
    const tierValues = TIER_TO_VALUES[p.tier] || null
    if (tierValues?.length) {
      const quoted = tierValues.map((v) => `'${v}'`).join(", ") // static enum values — no user input interpolated
      conds.push(`t."tier" IN (${quoted})`)
    }
    const whereSql = conds.length ? `WHERE ${conds.join(" AND ")}` : ""

    const offset = (p.page - 1) * p.pageSize
    const limitIdx = params.length + 1
    const offsetIdx = params.length + 2
    params.push(p.pageSize, offset)

    // one shared inner select: every display column + the SQL-computed tier
    const INNER = `SELECT v."id", v."name", v."code", v."active" AS "vendorActive", v."createdAt" AS "vendorCreatedAt",
                         s."status" AS "subStatus", s."planName",
                         COALESCE(login."c30", 0)::int AS "logins30d",
                         login."lastAt" AS "lastLoginAt",
                         EXTRACT(DAY FROM now() - login."lastAt")::int AS "daysSinceLogin",
                         cur."seats" AS "seatsNow", cur."seatsYear" AS "seatsYear", cur."seatsMonth" AS "seatsMonth",
                         prev."seats" AS "seatsPrev",
                         CASE WHEN COALESCE(login."c30", 0) = 0 THEN 'DORMANT'
                              WHEN login."c30" < 10 THEN 'LIGHT'
                              WHEN login."c30" < 50 THEN 'STEADY'
                              ELSE 'POWER' END AS "tier"
                  FROM "Vendor" v
                  LEFT JOIN "SaaSSubscription" s ON s."vendorId" = v."id"
                  LEFT JOIN LATERAL (
                    SELECT COUNT(*) FILTER (WHERE l."createdAt" >= now() - interval '30 days')::int AS c30,
                           MAX(l."createdAt") AS "lastAt"
                    FROM "LoginAuditLog" l
                    WHERE l."vendorId" = v."id" AND l."success" = true AND l."plane" = 'TENANT'
                  ) login ON true
                  LEFT JOIN LATERAL (
                    SELECT u."employeesPayroll"::int AS seats,
                           u."periodYear" AS "seatsYear", u."periodMonth" AS "seatsMonth"
                    FROM "UsageSnapshot" u
                    WHERE u."vendorId" = v."id"
                    ORDER BY u."periodYear" DESC, u."periodMonth" DESC
                    LIMIT 1
                  ) cur ON true
                  LEFT JOIN LATERAL (
                    SELECT u."employeesPayroll"::int AS seats
                    FROM "UsageSnapshot" u
                    WHERE u."vendorId" = v."id"
                    ORDER BY u."periodYear" DESC, u."periodMonth" DESC
                    LIMIT 1 OFFSET 1
                  ) prev ON true`
    const RANK = `CASE t."tier" WHEN 'DORMANT' THEN 0 WHEN 'LIGHT' THEN 1 WHEN 'STEADY' THEN 2 ELSE 3 END`

    const [countRows, rows] = await Promise.all([
      db.$queryRawUnsafe<Array<{ c: number }>>(
        `SELECT COUNT(*)::int AS c FROM (${INNER}) t ${whereSql}`,
        ...params.slice(0, -2),
      ),
      db.$queryRawUnsafe<Array<{
        id: string; name: string; code: string; vendorActive: boolean; vendorCreatedAt: Date
        subStatus: string | null; planName: string | null
        logins30d: number; lastLoginAt: Date | null; daysSinceLogin: number | null
        seatsNow: number | null; seatsYear: number | null; seatsMonth: number | null; seatsPrev: number | null
        tier: string
      }>>(
        `SELECT t."id", t."name", t."code", t."vendorActive", t."vendorCreatedAt",
                t."subStatus", t."planName",
                t."logins30d", t."lastLoginAt", t."daysSinceLogin",
                t."seatsNow", t."seatsYear", t."seatsMonth", t."seatsPrev", t."tier"
         FROM (${INNER}) t ${whereSql}
         ORDER BY ${RANK} ASC, t."logins30d" DESC,
                  COALESCE(t."daysSinceLogin", 999999) DESC,
                  t."name" ASC, t."id" ASC
         LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
        ...params,
      ),
    ])

    return {
      total: Number(countRows[0]?.c || 0),
      page: p.page,
      pageSize: p.pageSize,
      rows: rows.map((r) => ({
        id: r.id,
        name: r.name,
        code: r.code,
        vendorActive: r.vendorActive,
        vendorCreatedAt: r.vendorCreatedAt,
        subStatus: r.subStatus, // null → no subscription (legacy tenant)
        planName: r.planName,
        logins30d: Number(r.logins30d || 0),
        lastLoginAt: r.lastLoginAt,
        daysSinceLogin: r.daysSinceLogin == null ? null : Number(r.daysSinceLogin),
        seatsNow: r.seatsNow == null ? null : Number(r.seatsNow),
        seatsPeriod: r.seatsYear == null || r.seatsMonth == null
          ? null
          : `${r.seatsYear}-${String(r.seatsMonth).padStart(2, "0")}`,
        seatsPrev: r.seatsPrev == null ? null : Number(r.seatsPrev),
        tier: r.tier,
      })),
    }
  },
})

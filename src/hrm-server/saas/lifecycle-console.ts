// ============ Lifecycle console (Phase 5 P1) ===================================
// The single-pane-of-glass for the subscription lifecycle: stage counts with
// movement trends, the renewal pipeline horizon, and the fleet-wide lifecycle
// event stream (SaasSubscriptionEvent is append-only history — this console
// is the first owner surface that reads it ACROSS tenants).
//
// SCALE DISCIPLINE (fleet.ts, applied from birth):
//   - owner.lifecycle.overview answers every number with a FIXED set of
//     grouped aggregates (status groupBy, event-type groupBy ×2 windows, one
//     raw pipeline-bucket query, two trial counts, one NOT EXISTS legacy
//     count) — fleet-size independent, no per-vendor fan-out.
//   - owner.lifecycle.events pages in SQL (LIMIT/OFFSET over a JOIN of the
//     event table to Vendor for name/code display); type and search filters
//     are SQL WHERE conditions, never JS post-filtering.
import { z } from "zod"
import { db } from "@/lib/db"
import { ownerAction } from "./owner-routes"

const EVENTS_PAGE = z.object({
  page: z.number().int().min(1).default(1),
  pageSize: z.number().int().min(1).max(100).default(25),
  search: z.string().trim().max(120).optional(),
  type: z.string().trim().max(40).optional(),
}).passthrough()

// ---- 1. overview — stages, pipeline, movement -------------------------------
ownerAction("owner.lifecycle.overview", {
  perm: "subscriptions.view",
  handler: async () => {
    const now = Date.now()
    const d7 = new Date(now - 7 * 86400000)
    const d30 = new Date(now - 30 * 86400000)

    const [statusRows, legacyRows, pipelineRows, movement7d, movement30d, trialCurrent, trialSoon] = await Promise.all([
      db.saasSubscription.groupBy({ by: ["status"], _count: { _all: true } }),
      db.$queryRawUnsafe<Array<{ c: number }>>(
        `SELECT COUNT(*)::int AS c FROM "Vendor" v
         WHERE NOT EXISTS (SELECT 1 FROM "SaaSSubscription" s WHERE s."vendorId" = v."id")`,
      ),
      db.$queryRawUnsafe<Array<{ bucket: string; c: number }>>(
        `SELECT CASE
                 WHEN s."endDate" < now() THEN 'OVERDUE'
                 WHEN s."endDate" <= now() + interval '7 days' THEN 'DUE_0_7'
                 WHEN s."endDate" <= now() + interval '30 days' THEN 'DUE_8_30'
                 ELSE 'DUE_31_60'
               END AS bucket,
               COUNT(*)::int AS c
         FROM "SaaSSubscription" s
         WHERE s."status" IN ('TRIAL', 'ACTIVE', 'PAST_DUE', 'GRACE_PERIOD')
           AND s."endDate" IS NOT NULL
           AND s."endDate" < now() + interval '60 days'
         GROUP BY 1`,
      ),
      db.saasSubscriptionEvent.groupBy({ by: ["type"], _count: { _all: true }, where: { createdAt: { gte: d7 } } }),
      db.saasSubscriptionEvent.groupBy({ by: ["type"], _count: { _all: true }, where: { createdAt: { gte: d30 } } }),
      db.saasSubscription.count({ where: { status: "TRIAL" } }),
      db.saasSubscription.count({
        where: { status: "TRIAL", endDate: { gte: new Date(now), lte: new Date(now + 21 * 86400000) } },
      }),
    ])

    const stages: Record<string, number> = {
      TRIAL: 0, ACTIVE: 0, PAST_DUE: 0, GRACE_PERIOD: 0, EXPIRED: 0, SUSPENDED: 0, CANCELLED: 0,
    }
    for (const r of statusRows) {
      const n = Number(r._count?._all || 0)
      if (r.status in stages) stages[r.status] = n
      else stages[r.status] = n // future/new statuses still surface honestly
    }
    stages.LEGACY = Number(legacyRows[0]?.c || 0)

    const pipeline: Record<string, number> = { OVERDUE: 0, DUE_0_7: 0, DUE_8_30: 0, DUE_31_60: 0 }
    for (const r of pipelineRows) {
      if (r.bucket in pipeline) pipeline[r.bucket] = Number(r.c)
    }

    const fmt = (rows: { type: string; _count?: { _all?: number } }[]) =>
      rows.map((r) => ({ type: r.type, count: Number(r._count?._all || 0) })).sort((a, b) => b.count - a.count)

    return {
      generatedAt: new Date().toISOString(),
      stages,
      pipeline,
      movement7d: fmt(movement7d),
      movement30d: fmt(movement30d),
      trials: { current: trialCurrent, endingSoon21d: trialSoon },
    }
  },
})

// ---- 2. events — the fleet-wide lifecycle stream, paged in SQL --------------
ownerAction("owner.lifecycle.events", {
  perm: "subscriptions.view",
  schema: EVENTS_PAGE,
  handler: async (_ctx, p) => {
    const params: unknown[] = []
    const conds: string[] = []
    if (p.type && p.type !== "ALL") conds.push(`e."type" = $${params.push(p.type)}`)
    if (p.search) {
      const q = `%${p.search.toLowerCase()}%`
      conds.push(`(LOWER(v."name") LIKE $${params.push(q)} OR LOWER(v."code") LIKE $${params.push(q)})`)
    }
    const whereSql = conds.length ? `WHERE ${conds.join(" AND ")}` : ""
    const offset = (p.page - 1) * p.pageSize
    const limitIdx = params.length + 1
    const offsetIdx = params.length + 2
    params.push(p.pageSize, offset)

    const [countRows, rows] = await Promise.all([
      db.$queryRawUnsafe<Array<{ c: number }>>(
        `SELECT COUNT(*)::int AS c
         FROM "SaaSSubscriptionEvent" e JOIN "Vendor" v ON v."id" = e."vendorId"
         ${whereSql}`,
        ...params.slice(0, -2),
      ),
      db.$queryRawUnsafe<Array<{
        id: string; type: string; vendorId: string; vendorName: string; vendorCode: string
        note: string | null; actorName: string | null; createdAt: Date
      }>>(
        `SELECT e."id", e."type", e."vendorId", v."name" AS "vendorName", v."code" AS "vendorCode",
                e."note", e."actorName", e."createdAt"
         FROM "SaaSSubscriptionEvent" e JOIN "Vendor" v ON v."id" = e."vendorId"
         ${whereSql}
         ORDER BY e."createdAt" DESC
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
        type: r.type,
        vendorId: r.vendorId,
        vendorName: r.vendorName,
        vendorCode: r.vendorCode,
        note: r.note,
        actorName: r.actorName,
        createdAt: r.createdAt,
      })),
    }
  },
})

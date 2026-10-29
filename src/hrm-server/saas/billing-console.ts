// ============ Revenue & Collections console (Phase 5 P2) =====================
// The revenue slice of the SaaS Owner Panel: money KPIs, invoice aging, the
// billed-vs-collected trend, the payment history stream, and the collections
// (dunning) workbench — on top of the existing billing machinery (invoices,
// payments, the dunning engine, owner.invoices.create/markPaid) which stays
// untouched and compatible.
//
// SCALE DISCIPLINE (fleet.ts / lifecycle-console.ts, applied from birth):
//   - owner.billing.overview answers EVERY number with a FIXED set of ~9
//     grouped aggregates (FILTER-clause sums, one CASE-bucket aging query,
//     two month-truncation trend queries, three mix group-bys) — invoice-count
//     independent, no per-tenant fan-out.
//   - owner.billing.invoices pages in SQL with the collection band AND
//     days-overdue computed IN SQL (one CASE over status + dueAt vs now), so
//     the band chips filter and the severity-first sort never materialize the
//     invoice table. Search (number / tenant name) is a SQL WHERE condition.
//   - owner.billing.payments is the fleet-wide payment stream, paged in SQL
//     (JOIN invoice for the number + vendor for the name), method / provider
//     filters as SQL WHERE, createdAt DESC — never post-filtered in JS.
//   - owner.billing.collections is the dunning workbench: overdue PENDING
//     invoices worst-first (days-overdue computed IN SQL) with the per-invoice
//     reminder state from SaaSSetting group "dunning" read in ONE query
//     (restricted to the returned page — the dunning.ts counter discipline).
//     The send action is the EXISTING owner.dunning.remind (billing.manage):
//     audited, cadence-bypassing by design, identical machinery to the daily
//     automatic pass.
//
// MONEY: SaasInvoice.amount / SaasPayment.amount are Decimal(12,2); every raw
// sum is cast ::float8 BEFORE crossing the Prisma boundary (values are capped
// at 9,999,999.99 per invoice — float64 is exact far beyond that), and every
// count is ::int — no BigInt ever reaches JSON (the H-09 lesson).
import { z } from "zod"
import { db } from "@/lib/db"
import { ownerAction } from "./owner-routes"

const DAY_MS = 86_400_000

const PAGE = z.object({
  page: z.number().int().min(1).default(1),
  pageSize: z.number().int().min(1).max(100).default(25),
  search: z.string().trim().max(120).optional(),
}).passthrough()

const INVOICES_PAGE = PAGE.extend({
  status: z.enum(["ALL", "PENDING", "PAID", "FAILED", "REFUNDED", "CANCELLED"]).default("ALL"),
  // the collection chip — maps to a band IN(...) set in SQL
  collection: z.enum(["ALL", "OVERDUE", "DUE_SOON", "CURRENT", "SETTLED", "CLOSED"]).default("ALL"),
})

const PAYMENTS_PAGE = PAGE.extend({
  method: z.enum(["ALL", "BANK", "CASH", "MFS", "CARD"]).default("ALL"),
  provider: z.enum(["ALL", "MANUAL", "SSLCOMMERZ", "BKASH", "NAGAD"]).default("ALL"),
})

// band values the SQL CASE can emit (see the invoices handler)
const OVERDUE_BANDS = ["OVERDUE_90", "OVERDUE_61_90", "OVERDUE_31_60", "OVERDUE_16_30", "OVERDUE_1_15"] as const
const COLLECTION_TO_BANDS: Record<string, string[]> = {
  OVERDUE: [...OVERDUE_BANDS],
  DUE_SOON: ["DUE_SOON"],
  CURRENT: ["CURRENT"],
  SETTLED: ["PAID"],
  CLOSED: ["FAILED", "REFUNDED", "CANCELLED"],
}

// ---- 1. overview — money KPIs, aging, trend, mixes --------------------------
ownerAction("owner.billing.overview", {
  perm: "billing.view",
  handler: async () => {
    const now = new Date()
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
    const d30 = new Date(now.getTime() - 30 * DAY_MS)
    const d90 = new Date(now.getTime() - 90 * DAY_MS)
    const trendStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 5, 1))

    const [issuedRows, collectedRows, openRows, agingRows, trendBilled, trendCollected, methodRows, providerRows, statusRows] =
      await Promise.all([
        // billed MTD + trailing 30d — FILTER clauses over one scan
        db.$queryRawUnsafe<Array<{ billedMtd: number; billed30d: number }>>(
          `SELECT COALESCE(SUM("amount") FILTER (WHERE "issuedAt" >= $1), 0)::float8 AS "billedMtd",
                  COALESCE(SUM("amount") FILTER (WHERE "issuedAt" >= $2), 0)::float8 AS "billed30d"
           FROM "SaaSInvoice"`,
          monthStart, d30,
        ),
        // collected MTD + trailing 30d + avg days-to-pay (PAID invoices paid in the last 90d)
        db.$queryRawUnsafe<Array<{ collectedMtd: number; collected30d: number; avgDaysToPay: number | null }>>(
          `SELECT COALESCE(SUM("amount") FILTER (WHERE "status" = 'PAID' AND "paidAt" >= $1), 0)::float8 AS "collectedMtd",
                  COALESCE(SUM("amount") FILTER (WHERE "status" = 'PAID' AND "paidAt" >= $2), 0)::float8 AS "collected30d",
                  (AVG(EXTRACT(EPOCH FROM ("paidAt" - "issuedAt")) / 86400.0)
                     FILTER (WHERE "status" = 'PAID' AND "paidAt" >= $3 AND "paidAt" IS NOT NULL))::float8 AS "avgDaysToPay"
           FROM "SaaSInvoice"`,
          monthStart, d30, d90,
        ),
        // outstanding + overdue — counts and amounts in one scan
        db.$queryRawUnsafe<Array<{ openCount: number; openAmount: number; overdueCount: number; overdueAmount: number }>>(
          `SELECT COUNT(*) FILTER (WHERE "status" = 'PENDING')::int AS "openCount",
                  COALESCE(SUM("amount") FILTER (WHERE "status" = 'PENDING'), 0)::float8 AS "openAmount",
                  COUNT(*) FILTER (WHERE "status" = 'PENDING' AND "dueAt" < now())::int AS "overdueCount",
                  COALESCE(SUM("amount") FILTER (WHERE "status" = 'PENDING' AND "dueAt" < now()), 0)::float8 AS "overdueAmount"
           FROM "SaaSInvoice"`,
        ),
        // aging buckets — PENDING invoices bucketed by how far past due they are
        db.$queryRawUnsafe<Array<{ bucket: string; c: number; s: number }>>(
          `SELECT CASE
                    WHEN "dueAt" IS NULL OR "dueAt" >= now() THEN 'CURRENT'
                    WHEN "dueAt" >= now() - interval '15 days' THEN 'DUE_1_15'
                    WHEN "dueAt" >= now() - interval '30 days' THEN 'DUE_16_30'
                    WHEN "dueAt" >= now() - interval '60 days' THEN 'DUE_31_60'
                    WHEN "dueAt" >= now() - interval '90 days' THEN 'DUE_61_90'
                    ELSE 'OVERDUE_90'
                  END AS bucket,
                  COUNT(*)::int AS c,
                  SUM("amount")::float8 AS s
           FROM "SaaSInvoice"
           WHERE "status" = 'PENDING'
           GROUP BY 1`,
        ),
        // 6-month billed trend (by issuance month, UTC)
        db.$queryRawUnsafe<Array<{ m: string; s: number }>>(
          `SELECT to_char(date_trunc('month', "issuedAt"), 'YYYY-MM') AS m, SUM("amount")::float8 AS s
           FROM "SaaSInvoice"
           WHERE "issuedAt" >= $1
           GROUP BY 1`,
          trendStart,
        ),
        // 6-month collected trend (by payment month, UTC — settled money only)
        db.$queryRawUnsafe<Array<{ m: string; s: number }>>(
          `SELECT to_char(date_trunc('month', "paidAt"), 'YYYY-MM') AS m, SUM("amount")::float8 AS s
           FROM "SaaSInvoice"
           WHERE "status" = 'PAID' AND "paidAt" >= $1
           GROUP BY 1`,
          trendStart,
        ),
        // method mix — settled payments by recorded method
        db.$queryRawUnsafe<Array<{ m: string; c: number; s: number }>>(
          `SELECT COALESCE("method", '—') AS m, COUNT(*)::int AS c, SUM("amount")::float8 AS s
           FROM "SaaSPayment"
           WHERE "status" = 'PAID'
           GROUP BY 1
           ORDER BY 3 DESC`,
        ),
        // provider mix — settled payments by provider (MANUAL vs gateways)
        db.$queryRawUnsafe<Array<{ m: string; c: number; s: number }>>(
          `SELECT "provider" AS m, COUNT(*)::int AS c, SUM("amount")::float8 AS s
           FROM "SaaSPayment"
           WHERE "status" = 'PAID'
           GROUP BY 1
           ORDER BY 3 DESC`,
        ),
        // invoice status mix
        db.$queryRawUnsafe<Array<{ m: string; c: number; s: number }>>(
          `SELECT "status" AS m, COUNT(*)::int AS c, SUM("amount")::float8 AS s
           FROM "SaaSInvoice"
           GROUP BY 1
           ORDER BY 2 DESC`,
        ),
      ])

    const issued = issuedRows[0] || { billedMtd: 0, billed30d: 0 }
    const collected = collectedRows[0] || { collectedMtd: 0, collected30d: 0, avgDaysToPay: null }
    const open = openRows[0] || { openCount: 0, openAmount: 0, overdueCount: 0, overdueAmount: 0 }

    // aging: every bucket always present (0 when empty — the UI strip is fixed)
    const aging: Record<string, { count: number; amount: number }> = {}
    for (const b of ["CURRENT", "DUE_1_15", "DUE_16_30", "DUE_31_60", "DUE_61_90", "OVERDUE_90"]) aging[b] = { count: 0, amount: 0 }
    for (const r of agingRows) if (r.bucket in aging) aging[r.bucket] = { count: Number(r.c || 0), amount: Number(r.s || 0) }

    // trend: last 6 calendar months ALWAYS present (zero months render as zero,
    // never fabricated) — billed by issuance, collected by settlement
    const billedOf = new Map(trendBilled.map((r) => [r.m, Number(r.s || 0)]))
    const collectedOf = new Map(trendCollected.map((r) => [r.m, Number(r.s || 0)]))
    const trend: { month: string; billed: number; collected: number }[] = []
    for (let i = 5; i >= 0; i--) {
      const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1))
      const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`
      trend.push({ month: key, billed: billedOf.get(key) || 0, collected: collectedOf.get(key) || 0 })
    }

    const mix = (rows: Array<{ m: string; c: number; s: number }>) =>
      rows.map((r) => ({ key: r.m, count: Number(r.c || 0), amount: Number(r.s || 0) }))

    const rate30d = issued.billed30d > 0 ? Math.round((collected.collected30d / issued.billed30d) * 100) : null

    return {
      generatedAt: new Date().toISOString(),
      money: {
        billedMtd: issued.billedMtd,
        billed30d: issued.billed30d,
        collectedMtd: collected.collectedMtd,
        collected30d: collected.collected30d,
        collectionRate30d: rate30d, // null when nothing billed — never a fabricated 0%
        avgDaysToPay90d: collected.avgDaysToPay == null ? null : Math.round(collected.avgDaysToPay * 10) / 10,
        currency: "BDT",
      },
      open: {
        count: open.openCount,
        amount: open.openAmount,
        overdueCount: open.overdueCount,
        overdueAmount: open.overdueAmount,
      },
      aging,
      trend,
      methodMix: mix(methodRows),
      providerMix: mix(providerRows),
      statusMix: mix(statusRows),
    }
  },
})

// ---- 2. invoices — the collections workbench grid ---------------------------
// Band + days-overdue computed IN SQL; the severity-first ORDER BY ranks the
// worst overdue first, then due-soon, then current, then terminal states.
ownerAction("owner.billing.invoices", {
  perm: "billing.view",
  schema: INVOICES_PAGE,
  handler: async (_ctx, p) => {
    const params: unknown[] = []
    const conds: string[] = []
    if (p.status !== "ALL") conds.push(`i."status" = $${params.push(p.status)}`)
    if (p.search) {
      const q = `%${p.search.toLowerCase()}%`
      conds.push(`(LOWER(i."number") LIKE $${params.push(q)} OR LOWER(v."name") LIKE $${params.push(q)})`)
    }

    const collectionBands = COLLECTION_TO_BANDS[p.collection] || null
    const outerConds: string[] = []
    if (collectionBands?.length) {
      const quoted = collectionBands.map((b) => `'${b}'`).join(", ") // static enum values — no interpolation of user input
      outerConds.push(`t."band" IN (${quoted})`)
    }
    const outerWhere = outerConds.length ? `WHERE ${outerConds.join(" AND ")}` : ""

    const offset = (p.page - 1) * p.pageSize
    const limitIdx = params.length + 1
    const offsetIdx = params.length + 2
    params.push(p.pageSize, offset)

    // one shared inner select: every display column + the SQL-computed band
    const INNER = `SELECT i."id", i."number", i."vendorId", v."name" AS "vendorName", v."code" AS "vendorCode",
                         i."amount"::float8 AS "amount", i."currency", i."status",
                         i."periodStart", i."periodEnd", i."issuedAt", i."dueAt", i."paidAt",
                         i."paymentMethod", i."transactionId",
                         CASE WHEN i."status" <> 'PENDING' THEN i."status"
                              WHEN i."dueAt" IS NULL THEN 'CURRENT'
                              WHEN i."dueAt" < now() - interval '90 days' THEN 'OVERDUE_90'
                              WHEN i."dueAt" < now() - interval '60 days' THEN 'OVERDUE_61_90'
                              WHEN i."dueAt" < now() - interval '30 days' THEN 'OVERDUE_31_60'
                              WHEN i."dueAt" < now() - interval '15 days' THEN 'OVERDUE_16_30'
                              WHEN i."dueAt" < now() THEN 'OVERDUE_1_15'
                              WHEN i."dueAt" <= now() + interval '7 days' THEN 'DUE_SOON'
                              ELSE 'CURRENT' END AS "band",
                         CASE WHEN i."status" = 'PENDING' AND i."dueAt" IS NOT NULL AND i."dueAt" < now()
                              THEN EXTRACT(DAY FROM now() - i."dueAt")::int ELSE 0 END AS "daysOverdue"
                  FROM "SaaSInvoice" i JOIN "Vendor" v ON v."id" = i."vendorId"`
    const innerWhere = conds.length ? `WHERE ${conds.join(" AND ")}` : ""
    const RANK = `CASE t."band" WHEN 'OVERDUE_90' THEN 0 WHEN 'OVERDUE_61_90' THEN 1 WHEN 'OVERDUE_31_60' THEN 2
                              WHEN 'OVERDUE_16_30' THEN 3 WHEN 'OVERDUE_1_15' THEN 4 WHEN 'DUE_SOON' THEN 5
                              WHEN 'CURRENT' THEN 6 WHEN 'PAID' THEN 7 WHEN 'FAILED' THEN 8 WHEN 'REFUNDED' THEN 9 ELSE 10 END`

    const [countRows, rows] = await Promise.all([
      db.$queryRawUnsafe<Array<{ c: number }>>(
        `SELECT COUNT(*)::int AS c FROM (${INNER} ${innerWhere}) t ${outerWhere}`,
        ...params.slice(0, -2),
      ),
      db.$queryRawUnsafe<Array<{
        id: string; number: string; vendorId: string; vendorName: string; vendorCode: string
        amount: number; currency: string; status: string
        periodStart: Date; periodEnd: Date; issuedAt: Date; dueAt: Date | null; paidAt: Date | null
        paymentMethod: string | null; transactionId: string | null; band: string; daysOverdue: number
      }>>(
        `SELECT t."id", t."number", t."vendorId", t."vendorName", t."vendorCode", t."amount", t."currency", t."status",
                t."periodStart", t."periodEnd", t."issuedAt", t."dueAt", t."paidAt",
                t."paymentMethod", t."transactionId", t."band", t."daysOverdue"
         FROM (${INNER} ${innerWhere}) t ${outerWhere}
         ORDER BY ${RANK} ASC, t."daysOverdue" DESC, t."issuedAt" DESC, t."id" ASC
         LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
        ...params,
      ),
    ])

    return {
      total: Number(countRows[0]?.c || 0),
      page: p.page,
      pageSize: p.pageSize,
      rows: rows.map((r) => ({
        id: r.id, number: r.number, vendorId: r.vendorId,
        vendorName: r.vendorName, vendorCode: r.vendorCode,
        amount: Number(r.amount || 0), currency: r.currency, status: r.status,
        periodStart: r.periodStart, periodEnd: r.periodEnd,
        issuedAt: r.issuedAt, dueAt: r.dueAt, paidAt: r.paidAt,
        method: r.paymentMethod, transactionId: r.transactionId,
        band: r.band, daysOverdue: Number(r.daysOverdue || 0),
      })),
    }
  },
})

// ---- 3. payments — the fleet-wide payment history stream --------------------
ownerAction("owner.billing.payments", {
  perm: "billing.view",
  schema: PAYMENTS_PAGE,
  handler: async (_ctx, p) => {
    const params: unknown[] = []
    const conds: string[] = []
    if (p.method !== "ALL") conds.push(`p."method" = $${params.push(p.method)}`)
    if (p.provider !== "ALL") conds.push(`p."provider" = $${params.push(p.provider)}`)
    if (p.search) {
      const q = `%${p.search.toLowerCase()}%`
      conds.push(
        `(LOWER(i."number") LIKE $${params.push(q)} OR LOWER(v."name") LIKE $${params.push(q)}` +
          ` OR LOWER(COALESCE(p."transactionId", '') || COALESCE(p."providerTxnId", '')) LIKE $${params.push(q)})`,
      )
    }
    const whereSql = conds.length ? `WHERE ${conds.join(" AND ")}` : ""
    const offset = (p.page - 1) * p.pageSize
    const limitIdx = params.length + 1
    const offsetIdx = params.length + 2
    params.push(p.pageSize, offset)

    const [countRows, rows] = await Promise.all([
      db.$queryRawUnsafe<Array<{ c: number }>>(
        `SELECT COUNT(*)::int AS c
         FROM "SaaSPayment" p JOIN "SaaSInvoice" i ON i."id" = p."invoiceId" JOIN "Vendor" v ON v."id" = p."vendorId"
         ${whereSql}`,
        ...params.slice(0, -2),
      ),
      db.$queryRawUnsafe<Array<{
        id: string; invoiceId: string; invoiceNumber: string; vendorId: string; vendorName: string
        amount: number; currency: string; method: string | null; status: string; paidAt: Date
        transactionId: string | null; provider: string; providerTxnId: string | null
        failureReason: string | null; recordedByName: string | null; createdAt: Date
      }>>(
        `SELECT p."id", p."invoiceId", i."number" AS "invoiceNumber", p."vendorId", v."name" AS "vendorName",
                p."amount"::float8 AS "amount", p."currency", p."method", p."status", p."paidAt",
                p."transactionId", p."provider", p."providerTxnId", p."failureReason", p."recordedByName", p."createdAt"
         FROM "SaaSPayment" p JOIN "SaaSInvoice" i ON i."id" = p."invoiceId" JOIN "Vendor" v ON v."id" = p."vendorId"
         ${whereSql}
         ORDER BY p."createdAt" DESC, p."id" ASC
         LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
        ...params,
      ),
    ])

    return {
      total: Number(countRows[0]?.c || 0),
      page: p.page,
      pageSize: p.pageSize,
      rows: rows.map((r) => ({
        id: r.id, invoiceId: r.invoiceId, invoiceNumber: r.invoiceNumber,
        vendorId: r.vendorId, vendorName: r.vendorName,
        amount: Number(r.amount || 0), currency: r.currency,
        method: r.method, status: r.status, paidAt: r.paidAt,
        transactionId: r.transactionId, provider: r.provider, providerTxnId: r.providerTxnId,
        failureReason: r.failureReason, recordedByName: r.recordedByName, createdAt: r.createdAt,
      })),
    }
  },
})

// ---- 4. collections — the dunning workbench ---------------------------------
// Overdue PENDING invoices worst-first, each with its reminder state (the same
// SaaSSetting "dunning" counters the automatic daily pass reads — ONE query
// restricted to the returned page). Sending rides owner.dunning.remind.
ownerAction("owner.billing.collections", {
  perm: "billing.view",
  schema: PAGE,
  handler: async (_ctx, p) => {
    const params: unknown[] = []
    const conds: string[] = [`i."status" = 'PENDING'`, `i."dueAt" IS NOT NULL`, `i."dueAt" < now()`]
    if (p.search) {
      const q = `%${p.search.toLowerCase()}%`
      conds.push(`(LOWER(i."number") LIKE $${params.push(q)} OR LOWER(v."name") LIKE $${params.push(q)})`)
    }
    const whereSql = `WHERE ${conds.join(" AND ")}`
    const offset = (p.page - 1) * p.pageSize
    const limitIdx = params.length + 1
    const offsetIdx = params.length + 2
    params.push(p.pageSize, offset)

    const [countRows, rows] = await Promise.all([
      db.$queryRawUnsafe<Array<{ c: number }>>(
        `SELECT COUNT(*)::int AS c
         FROM "SaaSInvoice" i JOIN "Vendor" v ON v."id" = i."vendorId"
         ${whereSql}`,
        ...params.slice(0, -2),
      ),
      db.$queryRawUnsafe<Array<{
        id: string; number: string; vendorId: string; vendorName: string
        amount: number; currency: string; issuedAt: Date; dueAt: Date; daysOverdue: number
      }>>(
        `SELECT i."id", i."number", i."vendorId", v."name" AS "vendorName",
                i."amount"::float8 AS "amount", i."currency", i."issuedAt", i."dueAt",
                EXTRACT(DAY FROM now() - i."dueAt")::int AS "daysOverdue"
         FROM "SaaSInvoice" i JOIN "Vendor" v ON v."id" = i."vendorId"
         ${whereSql}
         ORDER BY "daysOverdue" DESC, i."issuedAt" ASC, i."id" ASC
         LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
        ...params,
      ),
    ])

    // reminder state for exactly the returned page (the dunning.ts counter map,
    // page-scoped): { lastSent, sent } per invoice id
    const reminderOf = new Map<string, { lastSent: string; sent: number }>()
    if (rows.length) {
      const keys = rows.map((r) => `inv:${r.id}`)
      const stateRows = await db.saasSetting.findMany({ where: { group: "dunning", key: { in: keys } } })
      for (const s of stateRows) {
        try {
          const parsed = JSON.parse(s.value as string) as { lastSent?: string; sent?: number }
          reminderOf.set(s.key.slice(4), { lastSent: parsed.lastSent || "", sent: Number(parsed.sent || 0) })
        } catch { /* a corrupt counter never breaks the workbench */ }
      }
    }

    // the cadence constant rides the response — imported from the engine itself
    // so the console can never drift from dunning.ts
    const { CADENCE_DAYS } = await import("./dunning")

    return {
      total: Number(countRows[0]?.c || 0),
      page: p.page,
      pageSize: p.pageSize,
      policy: { cadenceDays: CADENCE_DAYS },
      rows: rows.map((r) => {
        const st = reminderOf.get(r.id)
        return {
          id: r.id, number: r.number, vendorId: r.vendorId, vendorName: r.vendorName,
          amount: Number(r.amount || 0), currency: r.currency,
          issuedAt: r.issuedAt, dueAt: r.dueAt,
          daysOverdue: Number(r.daysOverdue || 0),
          remindersSent: st?.sent || 0,
          lastReminderAt: st?.lastSent || null,
        }
      }),
    }
  },
})

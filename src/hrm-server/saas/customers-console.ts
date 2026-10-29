// ============ Tenants & Subscriptions console (Phase 5 P5) ===================
// The customer-management slice of the SaaS Owner Panel — the capstone: with
// P0 observability, P1 lifecycle & quotas, P2 revenue & collections, P3
// growth & engagement and P4 security & trust delivered, the Customers and
// Subscriptions & Billing groups held the last old-generation surfaces
// (page:1/pageSize:100 hard caps with no pagination UI, no KPI strips, an
// alert()-driven plan-change decision flow, and one remaining full-table
// JS-filtered list — owner.renewals.list). P5 completes the panel.
//
// NEW ACTIONS (self-registering side-effect module, the fleet/lifecycle/
// billing/growth/security pattern):
//   - owner.customers.overview (tenants.view) — the Tenants page KPI strip +
//     the plan options for its filter: one Vendor scan with FILTER clauses
//     (total / active / new 7d / new 30d), a NOT EXISTS LEGACY anti-join
//     count (the P0/P1 discipline), trials, the renewal-window trio
//     (≤7d / ≤30d / overdue among OPERATING subscriptions, one FILTER scan),
//     fleet employees + active portal users, and the plan options
//     (id + name + active) for the Select.
//   - owner.subscriptions.overview (subscriptions.view) — the KPI strip for
//     the Subscriptions / Renewals / Plan Requests / Plans pages: the status
//     mix from ONE Subscription groupBy (every status that exists surfaces —
//     the P1 "future statuses still surface" discipline — with the canonical
//     nine always present, LEGACY from the same NOT EXISTS anti-join),
//     pending plan-change requests, plan census (total / active / public /
//     trial), and the same renewal-window trio + total operating.
//
// REWRITE — owner.renewals.list: the LAST full-table JS-filtered list in the
// panel (it loaded EVERY operating subscription with a vendor include, then
// filtered windows in memory). Now: window semantics as a SQL WHERE over
// CEIL(EXTRACT(EPOCH …)) day arithmetic — the exact Math.ceil JS semantics —
// daysRemaining computed IN SQL, soonest-endDate-first ordering (most urgent
// renewal first; EXPIRED = most overdue first), SQL paging with the standard
// total/page/pageSize contract, and a summary block (≤7d / ≤30d / overdue /
// operating, one FILTER-clause scan). The response is a SUPERSET of the old
// one (rows + settings unchanged in shape; total/page/pageSize/summary added)
// — the smoke script and any existing caller keep working.
//
// HONESTY RULES (the P1–P4 discipline): counts are honest zeros, rates are
// null on empty denominators, every count crosses the Prisma boundary ::int
// (no BigInt in JSON — H-09), and the KPI strips never fabricate.
import { z } from "zod"
import { db } from "@/lib/db"
import { ownerAction } from "./owner-routes"
import { getSaasSettings } from "./settings"

const DAY_MS = 86_400_000

/** The operating statuses the renewal calendar tracks (unchanged from the
 *  pre-P5 action — CANCELLED / SUSPENDED rows never surface there).
 *  Exported so any future consumer (and the test suite's independently
 *  written mirror) can import the canonical set instead of re-typing it. */
export const RENEWAL_STATUSES = ["TRIAL", "ACTIVE", "PAST_DUE", "GRACE_PERIOD", "EXPIRED"]

// ---- 1. customers.overview — the Tenants page KPI strip + plan options -----
ownerAction("owner.customers.overview", {
  perm: "tenants.view",
  handler: async () => {
    const now = new Date()
    const d7 = new Date(now.getTime() - 7 * DAY_MS)
    const d30 = new Date(now.getTime() - 30 * DAY_MS)

    const [vendorRows, legacyRows, trialRows, renewalRows, empCount, portalCount, planRows] = await Promise.all([
      // one Vendor scan: total / active / new 7d / new 30d (FILTER clauses)
      db.$queryRawUnsafe<Array<{ total: number; active: number; new7d: number; new30d: number }>>(
        `SELECT COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE "active")::int AS active,
                COUNT(*) FILTER (WHERE "createdAt" >= $1)::int AS "new7d",
                COUNT(*) FILTER (WHERE "createdAt" >= $2)::int AS "new30d"
         FROM "Vendor"`,
        d7, d30,
      ),
      // LEGACY — vendors without a subscription row (NOT EXISTS anti-join,
      // 1:1 over the vendorId-unique SaaSSubscription)
      db.$queryRawUnsafe<Array<{ c: number }>>(
        `SELECT COUNT(*)::int AS c FROM "Vendor" v
         WHERE NOT EXISTS (SELECT 1 FROM "SaaSSubscription" s WHERE s."vendorId" = v."id")`,
      ),
      // trials live now
      db.saasSubscription.count({ where: { status: "TRIAL" } }),
      // renewal windows among OPERATING subscriptions — one FILTER scan; the
      // day buckets are the SAME CEIL arithmetic the rewritten renewals.list
      // uses (a sub ending in 6.5d is 7d-rounded: inside ≤7)
      db.$queryRawUnsafe<Array<{ expiring7: number; expiring30: number; overdue: number }>>(
        `SELECT COUNT(*) FILTER (WHERE "endDate" >= now() AND CEIL(EXTRACT(EPOCH FROM ("endDate" - now())) / 86400.0) <= 7)::int AS "expiring7",
                COUNT(*) FILTER (WHERE "endDate" >= now() AND CEIL(EXTRACT(EPOCH FROM ("endDate" - now())) / 86400.0) <= 30)::int AS "expiring30",
                COUNT(*) FILTER (WHERE "endDate" < now())::int AS overdue
         FROM "SaaSSubscription"
         WHERE "status" IN ('TRIAL', 'ACTIVE', 'PAST_DUE', 'GRACE_PERIOD', 'EXPIRED')`,
      ),
      // fleet workforce + active portal users (the live counters, full-table)
      db.employee.count({ where: { status: { in: ["ACTIVE", "PROBATION", "ON_LEAVE", "SUSPENDED"] } } }),
      db.user.count({ where: { status: "ACTIVE" } }),
      // plan options for the Tenants filter Select (name is what the
      // tenants.list plan filter matches — s."planName")
      db.saasPlan.findMany({
        where: { active: true },
        select: { id: true, name: true, sortOrder: true },
        orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
      }),
    ])

    const v = vendorRows[0] || { total: 0, active: 0, new7d: 0, new30d: 0 }
    const r = renewalRows[0] || { expiring7: 0, expiring30: 0, overdue: 0 }

    return {
      generatedAt: new Date().toISOString(),
      tenants: {
        total: v.total,
        active: v.active,
        inactive: Math.max(0, v.total - v.active),
        legacy: Number(legacyRows[0]?.c || 0),
        new7d: v.new7d,
        new30d: v.new30d,
        trials: Number(trialRows || 0),
      },
      renewals: {
        expiring7d: r.expiring7,
        expiring30d: r.expiring30,
        overdue: r.overdue,
      },
      fleet: {
        employees: Number(empCount || 0),
        portalUsers: Number(portalCount || 0),
      },
      planOptions: planRows.map((p) => ({ id: p.id, name: p.name })),
    }
  },
})

// ---- 2. subscriptions.overview — the Subscriptions-family KPI strip --------
ownerAction("owner.subscriptions.overview", {
  perm: "subscriptions.view",
  handler: async () => {
    const [statusRows, legacyRows, pendingChanges, planRows, renewalRows] = await Promise.all([
      // every status that exists surfaces (groupBy over the whole table)
      db.saasSubscription.groupBy({ by: ["status"], _count: { _all: true } }),
      // LEGACY — vendors without a subscription row
      db.$queryRawUnsafe<Array<{ c: number }>>(
        `SELECT COUNT(*)::int AS c FROM "Vendor" v
         WHERE NOT EXISTS (SELECT 1 FROM "SaaSSubscription" s WHERE s."vendorId" = v."id")`,
      ),
      // pending plan-change requests (the queue the Plan Requests page works)
      db.saasPlanChangeRequest.count({ where: { status: "PENDING" } }),
      // plan census — one scan with FILTER clauses
      db.$queryRawUnsafe<Array<{ total: number; active: number; publicPlans: number; trial: number }>>(
        `SELECT COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE "active")::int AS active,
                COUNT(*) FILTER (WHERE "isPublic")::int AS "publicPlans",
                COUNT(*) FILTER (WHERE "isTrialPlan")::int AS trial
         FROM "SaaSPlan"`,
      ),
      // renewal windows + operating total — the same CEIL arithmetic as
      // customers.overview / the rewritten renewals.list (never drifts)
      db.$queryRawUnsafe<Array<{ operating: number; expiring7: number; expiring30: number; overdue: number }>>(
        `SELECT COUNT(*)::int AS operating,
                COUNT(*) FILTER (WHERE "endDate" >= now() AND CEIL(EXTRACT(EPOCH FROM ("endDate" - now())) / 86400.0) <= 7)::int AS "expiring7",
                COUNT(*) FILTER (WHERE "endDate" >= now() AND CEIL(EXTRACT(EPOCH FROM ("endDate" - now())) / 86400.0) <= 30)::int AS "expiring30",
                COUNT(*) FILTER (WHERE "endDate" < now())::int AS overdue
         FROM "SaaSSubscription"
         WHERE "status" IN ('TRIAL', 'ACTIVE', 'PAST_DUE', 'GRACE_PERIOD', 'EXPIRED')`,
      ),
    ])

    // status mix — the canonical nine always present, zeros honest
    const mix: Record<string, number> = {}
    for (const r of statusRows) mix[r.status] = Number(r._count?._all || 0)
    for (const k of ["TRIAL", "ACTIVE", "PAST_DUE", "GRACE_PERIOD", "EXPIRED", "SUSPENDED", "CANCELLED"]) {
      if (!(k in mix)) mix[k] = 0
    }
    mix.LEGACY = Number(legacyRows[0]?.c || 0)

    const p = planRows[0] || { total: 0, active: 0, publicPlans: 0, trial: 0 }
    const r = renewalRows[0] || { operating: 0, expiring7: 0, expiring30: 0, overdue: 0 }

    return {
      generatedAt: new Date().toISOString(),
      statusMix: mix,
      pendingPlanChanges: Number(pendingChanges || 0),
      plans: {
        total: p.total,
        active: p.active,
        publicPlans: p.publicPlans,
        trialPlans: p.trial,
      },
      renewals: {
        operating: r.operating,
        expiring7d: r.expiring7,
        expiring30d: r.expiring30,
        overdue: r.overdue,
      },
    }
  },
})

// ---- 3. renewals.list — REWRITTEN to the SQL-paged console standard --------
// Same action name, same window enum, same rows+settings shape — now with
// total/page/pageSize and a summary block. The window filtering and the
// daysRemaining arithmetic live IN SQL (CEIL of fractional days — the exact
// Math.ceil semantics the JS version had), soonest endDate first.
const RENEWALS_PAGE = z.object({
  window: z.enum(["7", "30", "60", "EXPIRED", "ALL"]).default("30"),
  page: z.number().int().min(1).default(1),
  pageSize: z.number().int().min(1).max(100).default(25),
}).passthrough()

ownerAction("owner.renewals.list", {
  perm: "subscriptions.view",
  schema: RENEWALS_PAGE,
  handler: async (_ctx, p) => {
    // window semantics as SQL conditions over the CEIL day arithmetic
    const dayExpr = `CEIL(EXTRACT(EPOCH FROM (s."endDate" - now())) / 86400.0)`
    let windowCond: string
    if (p.window === "EXPIRED") windowCond = `s."endDate" < now()`
    else if (p.window === "ALL") windowCond = `TRUE`
    else windowCond = `s."endDate" >= now() AND ${dayExpr} <= ${Number(p.window)}`

    const whereSql = `WHERE s."status" IN ('TRIAL', 'ACTIVE', 'PAST_DUE', 'GRACE_PERIOD', 'EXPIRED') AND (${windowCond})`
    const offset = (p.page - 1) * p.pageSize

    const [countRows, rows, summaryRows, settings] = await Promise.all([
      db.$queryRawUnsafe<Array<{ c: number }>>(
        `SELECT COUNT(*)::int AS c FROM "SaaSSubscription" s ${whereSql}`,
      ),
      db.$queryRawUnsafe<Array<{
        id: string; vendorId: string; tenant: string; planName: string
        cycle: string; status: string; endDate: Date; daysRemaining: number
      }>>(
        `SELECT s."id", s."vendorId", v."name" AS tenant, s."planName",
                s."billingCycle" AS cycle, s."status", s."endDate",
                ${dayExpr}::int AS "daysRemaining"
         FROM "SaaSSubscription" s
         JOIN "Vendor" v ON v."id" = s."vendorId"
         ${whereSql}
         ORDER BY s."endDate" ASC, s."id" ASC
         LIMIT $1 OFFSET $2`,
        p.pageSize, offset,
      ),
      // summary — the three window counts + operating total, one FILTER scan
      db.$queryRawUnsafe<Array<{ operating: number; expiring7: number; expiring30: number; overdue: number }>>(
        `SELECT COUNT(*)::int AS operating,
                COUNT(*) FILTER (WHERE "endDate" >= now() AND CEIL(EXTRACT(EPOCH FROM ("endDate" - now())) / 86400.0) <= 7)::int AS "expiring7",
                COUNT(*) FILTER (WHERE "endDate" >= now() AND CEIL(EXTRACT(EPOCH FROM ("endDate" - now())) / 86400.0) <= 30)::int AS "expiring30",
                COUNT(*) FILTER (WHERE "endDate" < now())::int AS overdue
         FROM "SaaSSubscription"
         WHERE "status" IN ('TRIAL', 'ACTIVE', 'PAST_DUE', 'GRACE_PERIOD', 'EXPIRED')`,
      ),
      getSaasSettings().then((s) => s.subscription),
    ])

    const sum = summaryRows[0] || { operating: 0, expiring7: 0, expiring30: 0, overdue: 0 }
    return {
      rows: rows.map((r) => ({
        id: r.id,
        vendorId: r.vendorId,
        tenant: r.tenant,
        planName: r.planName,
        cycle: r.cycle,
        status: r.status,
        endDate: r.endDate,
        daysRemaining: Number(r.daysRemaining || 0),
      })),
      settings, // gracePeriodDays + renewalReminderDays — unchanged shape
      summary: {
        operating: sum.operating,
        expiring7d: sum.expiring7,
        expiring30d: sum.expiring30,
        overdue: sum.overdue,
      },
      total: Number(countRows[0]?.c || 0),
      page: p.page,
      pageSize: p.pageSize,
    }
  },
})

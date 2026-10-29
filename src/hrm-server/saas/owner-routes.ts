// ============ SaaS owner RPC route table (consumed by /api/owner dispatcher) ============
// Every action is registered with `ownerAction(name, { perm, schema?, handler })`.
// The permission gate + CSRF echo run in the dispatcher BEFORE the handler.
import { z } from "zod"
import { db } from "@/lib/db"
import { hashOwnerPasswordAsync, ownerStartSelfEnroll, ownerCompleteSelfEnroll, ownerDisableMfa, type OwnerCtx } from "./owner-auth"
import { saasAudit } from "./audit"
import { getSaasSettings, saveSaasSettingsGroup, calculateVatBreakdown } from "./settings"
import { nextInvoiceNumber } from "./sequences"
import { provisionTenant, cycleEndDate } from "./provision"
import { resolveEntitlements, usageSnapshot, invalidateEntitlements } from "./entitlements"
import { OWNER_ROLE_LABELS, OWNER_ROLE_TEMPLATES, OWNER_PERMISSIONS, type OwnerPermission } from "./constants"
import { ensureSystemOwnerRolesSeeded, allOwnerRoleKeys, parseOwnerPermissions } from "./owner-roles"
import {
  getPlatformGateway, savePlatformGateway, maskPlatformGateway,
  sendPlatformEmail, logPlatformNotification, notifyApplicantApproved, notifyApplicantRejected,
  notifyInvoiceIssued,
} from "./notify"
import { j } from "../utils"

// NOTE: cms-routes.ts (owner.cms.*) registers itself via ownerAction() and is
// imported by the API dispatcher AFTER this module — importing it here would
// create a cycle (ownerRoutes is not yet initialized when the side-effect
// import evaluates).

export type OwnerRouteDef = {
  /** Must be a real key of the OWNER_PERMISSIONS vocabulary. Typed (not a bare
   *  string) so the COMPILER catches a route demanding a permission no role
   *  can ever hold — the 2026-10-26 "Permission denied: support.view" bug on
   *  the Owner Console → Support tabs 1-2 slipped through as a runtime 403
   *  because perm was an unchecked string. Handler-level guards keep the
   *  looser ownerCan/ownerRequire helpers (contextual checks). */
  perm?: OwnerPermission
  schema?: z.ZodType<any, any>
  /** The /api/owner dispatcher passes the raw NextRequest as an optional 3rd
   *  argument (needed by route families that derive request-bound config —
   *  e.g. the WebAuthn Relying Party in passkey-owner-routes.ts). Existing
   *  two-arg handlers ignore it. */
  handler: (ctx: OwnerCtx, payload: any, req?: any) => Promise<unknown>
}
export const ownerRoutes: Record<string, OwnerRouteDef> = {}
export function ownerAction(name: string, def: OwnerRouteDef) {
  ownerRoutes[name] = def
}

const PAGINATION = z.object({
  page: z.number().int().min(1).default(1),
  pageSize: z.number().int().min(1).max(100).default(25),
  search: z.string().trim().max(120).optional(),
}).passthrough()

// ============================ DASHBOARD ============================
// SCL-6 (Phase 3 WS-A) — set-based rollups. The pre-Phase-3 handler ran
// usageSnapshot PER VENDOR (6 COUNTs + a storage rollup read per tenant) plus
// full-table vendor/subscription/registration loads and per-vendor fan-out:
// >700K queries per dashboard load at 100K tenants (the console died at
// ~1-2K tenants). The rewrite answers every card with a FIXED set of grouped
// SQL aggregates (~25 queries total, independent of tenant count) with
// IDENTICAL response semantics — same fields, same math, same statuses.
const OPERATING_STATUSES = ["TRIAL", "ACTIVE", "PAST_DUE", "GRACE_PERIOD"] as const

ownerAction("owner.dashboard.overview", {
  perm: "dashboard.view",
  handler: async () => {
    // ---- tenant metrics (six single-row COUNTs — index-only scans) ----
    const [totalTenants, activeTenants, pendingRegs, trialSubs, expiredSubs, suspendedSubs] = await Promise.all([
      db.vendor.count(),
      db.vendor.count({ where: { active: true } }),
      db.saasRegistration.count({ where: { status: { in: ["PENDING", "UNDER_REVIEW"] } } }),
      db.saasSubscription.count({ where: { status: "TRIAL" } }),
      db.saasSubscription.count({ where: { status: "EXPIRED" } }),
      db.saasSubscription.count({ where: { status: "SUSPENDED" } }),
    ])
    // subscribed = vendors with at least one subscription row (SCL-6: was a
    // full vendor findMany with a relation include, filtered in JS)
    const subscribedRows = await db.$queryRaw<Array<{ c: number }>>`
      SELECT COUNT(DISTINCT "vendorId")::int AS c FROM "SaaSSubscription"`
    const subscribed = Number(subscribedRows[0]?.c || 0)
    const legacyCount = totalTenants - subscribed

    // ---- workforce metrics (real counts, never invented) ----
    const [totalEmployees, activeEmployees, employeesThisMonth] = await Promise.all([
      db.employee.count(),
      db.employee.count({ where: { status: { notIn: ["RESIGNED", "TERMINATED", "RETIRED", "INACTIVE"] } } }),
      db.employee.count({ where: { createdAt: { gte: new Date(new Date().getFullYear(), new Date().getMonth(), 1) } } }),
    ])

    // ---- subscription metrics (grouped, fleet-size independent) ----
    const now = Date.now()
    // MRR/ARR only from actual pricing snapshots of operating subscriptions
    // (same statuses and normalization as pre-Phase-3: MONTHLY at face value,
    // YEARLY divided by 12).
    const mrrRows = await db.$queryRaw<Array<{ mrr: number }>>`
      SELECT COALESCE(SUM(
        CASE WHEN "billingCycle" = 'YEARLY' THEN "priceAtCreation" / 12.0 ELSE "priceAtCreation" END
      ), 0)::float8 AS mrr
      FROM "SaaSSubscription"
      WHERE "status" IN ('TRIAL', 'ACTIVE', 'PAST_DUE', 'GRACE_PERIOD')`
    const mrr = Number(mrrRows[0]?.mrr || 0)
    const arr = mrr * 12
    const [cycleRows, cancelledSubs, upcoming, expiring7, expiring30, expiring60] = await Promise.all([
      db.saasSubscription.groupBy({
        by: ["billingCycle", "status"],
        where: { status: { in: [...OPERATING_STATUSES] } },
        _count: { _all: true },
      }),
      db.saasSubscription.count({ where: { status: "CANCELLED" } }),
      db.saasSubscription.findMany({
        where: { status: { in: [...OPERATING_STATUSES] } },
        select: { id: true, vendorId: true, planName: true, billingCycle: true, endDate: true },
        orderBy: { endDate: "asc" },
        take: 12,
      }),
      db.saasSubscription.count({ where: { status: { in: [...OPERATING_STATUSES] }, endDate: { gte: new Date(now), lte: new Date(now + 7 * 86400000) } } }),
      db.saasSubscription.count({ where: { status: { in: [...OPERATING_STATUSES] }, endDate: { gt: new Date(now + 7 * 86400000), lte: new Date(now + 30 * 86400000) } } }),
      db.saasSubscription.count({ where: { status: { in: [...OPERATING_STATUSES] }, endDate: { gt: new Date(now + 30 * 86400000), lte: new Date(now + 60 * 86400000) } } }),
    ])
    const monthlySubs = cycleRows.filter((r) => r.billingCycle === "MONTHLY").reduce((a, r) => a + Number(r._count?._all || 0), 0)
    const yearlySubs = cycleRows.filter((r) => r.billingCycle === "YEARLY").reduce((a, r) => a + Number(r._count?._all || 0), 0)

    // ---- plan / status distributions (groupBy — no row materialization) ----
    const [byPlanRows, byStatusRows] = await Promise.all([
      db.saasSubscription.groupBy({ by: ["planName"], _count: { _all: true } }),
      db.saasSubscription.groupBy({ by: ["status"], _count: { _all: true } }),
    ])
    const planDistribution = byPlanRows
      .map((r) => ({ name: r.planName || "Unnamed plan", count: Number(r._count?._all || 0) }))
      .concat(legacyCount > 0 ? [{ name: "Legacy (no subscription)", count: legacyCount }] : [])
    const statusDistribution = byStatusRows
      .map((r) => ({ name: r.status, count: Number(r._count?._all || 0) }))
      .concat(legacyCount > 0 ? [{ name: "LEGACY", count: legacyCount }] : [])

    // ---- platform usage (set-based; was usageSnapshot per vendor) ----
    const [storageRows, quotaRows, empByPlanRows, adoptionRows] = await Promise.all([
      db.$queryRaw<Array<{ total: bigint }>>`SELECT COALESCE(SUM("storageBytes"), 0) AS total FROM "UsageRollup"`,
      db.$queryRaw<Array<{ total: number }>>`
        SELECT COALESCE(SUM(p."storageGb"), 0)::float8 AS total
        FROM "SaaSSubscription" s JOIN "SaaSPlan" p ON p."id" = s."planId"
        WHERE s."status" IN ('TRIAL', 'ACTIVE', 'PAST_DUE', 'GRACE_PERIOD')`,
      db.$queryRaw<Array<{ name: string; count: number }>>`
        SELECT COALESCE(s."planName", 'Legacy') AS name, COUNT(e."id")::int AS count
        FROM "Employee" e
        LEFT JOIN "SaaSSubscription" s ON s."vendorId" = e."vendorId"
        WHERE e."status" NOT IN ('RESIGNED', 'TERMINATED', 'RETIRED', 'INACTIVE')
        GROUP BY 1`,
      db.$queryRaw<Array<{
        payroll: number; tracking: number; inventory: number; performance: number; camera: number; devices: number
      }>>`
        SELECT
          COUNT(*) FILTER (WHERE p."payrollEnabled")::int AS payroll,
          COUNT(*) FILTER (WHERE p."trackingEnabled")::int AS tracking,
          COUNT(*) FILTER (WHERE p."inventoryEnabled")::int AS inventory,
          COUNT(*) FILTER (WHERE p."performanceEnabled")::int AS performance,
          COUNT(*) FILTER (WHERE p."cameraEnabled")::int AS camera,
          0::int AS devices
        FROM "SaaSSubscription" s JOIN "SaaSPlan" p ON p."id" = s."planId"
        WHERE s."status" IN ('TRIAL', 'ACTIVE', 'PAST_DUE', 'GRACE_PERIOD')`,
    ])
    const storageUsedTotal = Number(storageRows[0]?.total || 0)
    const storageQuotaTotalGb = Number(quotaRows[0]?.total || 0)
    const employeeDistribution = empByPlanRows.map((r) => ({ name: r.name || "Legacy", count: Number(r.count || 0) }))
    const [devicesTotal, trackingEnabled, activeModuleCount] = await Promise.all([
      db.attendanceDevice.count({ where: { enabled: true } }),
      db.employeeTrackingState.count({ where: { trackingEnabled: true } }),
      db.saasSubscription.count({ where: { status: { in: [...OPERATING_STATUSES] } } }),
    ])
    const ad = adoptionRows[0]
    const featureAdoption = [
      { name: "Payroll", count: Number(ad?.payroll || 0) },
      // same pre-Phase-3 semantics: the "Attendance Devices" card counts every
      // operating subscription when the platform has at least one device
      { name: "Attendance Devices", count: devicesTotal > 0 ? activeModuleCount : 0 },
      { name: "Live Tracking", count: Number(ad?.tracking || 0) },
      { name: "Inventory", count: Number(ad?.inventory || 0) },
      { name: "Performance", count: Number(ad?.performance || 0) },
      { name: "Camera", count: Number(ad?.camera || 0) },
    ]
    const storageUsage = [
      { name: "Used", gb: Number((storageUsedTotal / 1024 ** 3).toFixed(2)) },
      { name: "Available", gb: Math.max(0, Number((storageQuotaTotalGb - storageUsedTotal / 1024 ** 3).toFixed(2))) },
    ]

    // ---- chart series (SQL month buckets; was full-table loads into JS) ----
    const MONTHS_BACK = 6
    const months: { key: string; label: string; start: Date; end: Date }[] = []
    const anchor = new Date()
    for (let i = MONTHS_BACK - 1; i >= 0; i--) {
      const start = new Date(anchor.getFullYear(), anchor.getMonth() - i, 1)
      const end = new Date(anchor.getFullYear(), anchor.getMonth() - i + 1, 1)
      months.push({ key: `${start.getFullYear()}-${start.getMonth() + 1}`, label: start.toLocaleString("en", { month: "short" }), start, end })
    }
    const windowStart = months[0].start
    const [growthRegRows, growthVendorRows] = await Promise.all([
      db.$queryRaw<Array<{ m: Date; c: number }>>`
        SELECT date_trunc('month', "createdAt") AS m, COUNT(*)::int AS c
        FROM "SaaSRegistration" WHERE "createdAt" >= ${windowStart} GROUP BY 1`,
      db.$queryRaw<Array<{ m: Date; c: number }>>`
        SELECT date_trunc('month', "createdAt") AS m, COUNT(*)::int AS c
        FROM "Vendor" WHERE "createdAt" >= ${windowStart} GROUP BY 1`,
    ])
    const regByMonth = new Map<string, number>()
    for (const r of growthRegRows) regByMonth.set(new Date(r.m).toISOString().slice(0, 7), Number(r.c || 0))
    const vendorByMonth = new Map<string, number>()
    for (const r of growthVendorRows) vendorByMonth.set(new Date(r.m).toISOString().slice(0, 7), Number(r.c || 0))
    let cumulative = 0
    const growth = months.map((m) => {
      const key = `${m.start.getFullYear()}-${String(m.start.getMonth() + 1).padStart(2, "0")}`
      cumulative += vendorByMonth.get(key) || 0
      return {
        month: m.label,
        registrations: regByMonth.get(key) || 0,
        approvedTenants: vendorByMonth.get(key) || 0,
        activeTenants: cumulative,
      }
    })

    return {
      tenants: { total: totalTenants, active: activeTenants, legacy: legacyCount, pendingRegistrations: pendingRegs, trial: trialSubs, expired: expiredSubs, suspended: suspendedSubs },
      workforce: { totalEmployees, activeEmployees, employeesThisMonth },
      subscriptions: {
        monthly: monthlySubs,
        yearly: yearlySubs,
        cancelled: cancelledSubs,
        mrr: Number(mrr.toFixed(2)),
        arr: Number(arr.toFixed(2)),
        upcomingRenewals: upcoming.map((s) => ({
          id: s.id, vendorId: s.vendorId, planName: s.planName, cycle: s.billingCycle, endDate: s.endDate,
          days: s.endDate ? Math.ceil((s.endDate.getTime() - now) / 86400000) : null,
        })),
        expiring7,
        expiring30,
        expiring60,
      },
      platform: {
        storageUsedBytes: storageUsedTotal,
        storageQuotaGb: storageQuotaTotalGb,
        devices: devicesTotal,
        trackingEnabledEmployees: trackingEnabled,
        operatingSubscriptions: activeModuleCount,
      },
      charts: { growth, planDistribution, statusDistribution, employeeDistribution, featureAdoption, storageUsage },
    }
  },
})

// ============================ REGISTRATIONS ============================
const regListSchema = PAGINATION.extend({
  status: z.enum(["ALL", "PENDING", "UNDER_REVIEW", "APPROVED", "REJECTED", "SUSPENDED", "CANCELLED"]).default("ALL"),
})

ownerAction("owner.registrations.list", {
  perm: "registrations.view",
  schema: regListSchema,
  handler: async (_ctx, p) => {
    const where: any = {}
    if (p.status !== "ALL") where.status = p.status
    if (p.search) {
      where.OR = [
        { organizationName: { contains: p.search, mode: "insensitive" } },
        { applicationNumber: { contains: p.search, mode: "insensitive" } },
        { adminEmail: { contains: p.search, mode: "insensitive" } },
        { officialEmail: { contains: p.search, mode: "insensitive" } },
      ]
    }
    const [total, rows] = await Promise.all([
      db.saasRegistration.count({ where }),
      db.saasRegistration.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (p.page - 1) * p.pageSize,
        take: p.pageSize,
      }),
    ])
    return {
      total,
      page: p.page,
      pageSize: p.pageSize,
      rows: rows.map((r) => ({
        id: r.id,
        applicationNumber: r.applicationNumber,
        organizationName: r.organizationName,
        industry: r.industry,
        adminName: r.adminName,
        adminEmail: r.adminEmail,
        adminPhone: r.adminPhone,
        employeeCount: r.employeeCount,
        branchCount: r.branchCount,
        deviceCount: r.deviceCount,
        requestedModules: j(r.requestedModules, []),
        planName: r.planName,
        billingCycle: r.billingCycle,
        status: r.status,
        reviewedByName: r.reviewedByName,
        createdAt: r.createdAt,
        reviewedAt: r.reviewedAt,
      })),
    }
  },
})

ownerAction("owner.registrations.get", {
  perm: "registrations.view",
  schema: z.object({ id: z.string().min(1) }),
  handler: async (_ctx, p) => {
    const r = await db.saasRegistration.findUnique({ where: { id: p.id } })
    if (!r) throw Object.assign(new Error("Application not found"), { code: 404 })
    return {
      ...r,
      adminPasswordHash: undefined, // never leave the server
      requestedModules: j(r.requestedModules, []),
    }
  },
})

ownerAction("owner.registrations.review", {
  // review = save notes / move between PENDING ⇄ UNDER_REVIEW / request info
  perm: "registrations.manage",
  schema: z.object({
    id: z.string().min(1),
    toStatus: z.enum(["UNDER_REVIEW", "PENDING", "REQUEST_INFO"]).optional(),
    internalNote: z.string().max(4000).optional(),
    reviewNote: z.string().max(2000).optional(),
  }),
  handler: async (ctx, p) => {
    const r = await db.saasRegistration.findUnique({ where: { id: p.id } })
    if (!r) throw Object.assign(new Error("Application not found"), { code: 404 })
    if (r.status === "APPROVED" || r.status === "CANCELLED") {
      throw Object.assign(new Error("This application is closed — its status can no longer change."), { code: 400 })
    }
    const data: any = {}
    if (typeof p.internalNote === "string") data.internalNote = p.internalNote
    if (typeof p.reviewNote === "string") data.reviewNote = p.reviewNote
    if (p.toStatus === "UNDER_REVIEW" && r.status === "PENDING") data.status = "UNDER_REVIEW"
    if (p.toStatus === "PENDING" && r.status === "UNDER_REVIEW") data.status = "PENDING"
    if (p.toStatus === "REQUEST_INFO") data.requestedInfoAt = new Date()
    data.reviewedById = ctx.ownerId
    data.reviewedByName = ctx.name
    if (data.status) data.reviewedAt = new Date()
    const updated = await db.saasRegistration.update({ where: { id: r.id }, data })
    await saasAudit(ctx, "REGISTRATION_REVIEWED", "SaaSRegistration", r.id,
      `Application ${r.applicationNumber} reviewed (${p.toStatus || "notes updated"}; status ${r.status} → ${updated.status})`,
      { vendorId: null, metadata: { from: r.status, to: updated.status } })
    return { status: updated.status, internalNote: updated.internalNote, reviewNote: updated.reviewNote }
  },
})

ownerAction("owner.registrations.approve", {
  perm: "registrations.approve",
  schema: z.object({
    id: z.string().min(1),
    planId: z.string().min(1), // explicit at approval time — never trust the stale registration planId
    billingCycle: z.enum(["MONTHLY", "YEARLY"]).optional(),
    reviewNote: z.string().max(2000).optional(),
    trialDays: z.number().int().min(0).max(90).optional(),
  }),
  handler: async (ctx, p) => {
    const r = await db.saasRegistration.findUnique({ where: { id: p.id } })
    if (!r) throw Object.assign(new Error("Application not found"), { code: 404 })
    if (r.status === "APPROVED") throw Object.assign(new Error("This application is already approved."), { code: 400 })
    if (r.status === "CANCELLED") throw Object.assign(new Error("This application was cancelled — re-open it first."), { code: 400 })

    // S1-001 — conditional claim: atomically move status out of the approvable
    // set so a concurrent approve request on the same row is blocked.
    const claimed = await db.saasRegistration.updateMany({
      where: { id: r.id, status: { in: ["PENDING", "UNDER_REVIEW", "REQUEST_INFO"] } },
      data: { status: "PROVISIONING" },
    })
    if (claimed.count === 0) {
      throw Object.assign(new Error("This application was already claimed by another operator. Refresh and try again."), { code: 409 })
    }

    try {
    if (p.billingCycle) {
      await db.saasRegistration.update({ where: { id: r.id }, data: { billingCycle: p.billingCycle } })
      r.billingCycle = p.billingCycle
    }

    // 1. provision the tenant transactionally (vendor+admin+config+subscription)
    const result = await provisionTenant(r, p.planId, { id: ctx.ownerId, name: ctx.name })

    // 2. optional trial window: pull the end date in
    if (p.trialDays && p.trialDays > 0) {
      const endDate = new Date(Date.now() + p.trialDays * 86400000)
      await db.saasSubscription.update({ where: { id: result.subscriptionId }, data: { status: "TRIAL", endDate } })
    }

    // 3. stamp the application
    const updated = await db.saasRegistration.update({
      where: { id: r.id },
      data: {
        status: "APPROVED",
        approvedVendorId: result.vendorId,
        subscriptionId: result.subscriptionId,
        reviewedById: ctx.ownerId,
        reviewedByName: ctx.name,
        reviewedAt: new Date(),
        reviewNote: p.reviewNote || r.reviewNote,
      },
    })
    invalidateEntitlements(result.vendorId)
    await saasAudit(ctx, "REGISTRATION_APPROVED", "SaaSRegistration", r.id,
      `Approved ${r.applicationNumber} — tenant "${r.organizationName}" provisioned (code ${result.vendorCode}, admin ${r.adminEmail})`,
      { vendorId: result.vendorId, metadata: { applicationNumber: r.applicationNumber, vendorCode: result.vendorCode, subscriptionId: result.subscriptionId, warnings: result.warnings } })
    await saasAudit(ctx, "TENANT_CREATED", "Vendor", result.vendorId,
      `Tenant provisioned from application ${r.applicationNumber}`,
      { vendorId: result.vendorId, metadata: { code: result.vendorCode } })
    // platform gateway — email the applicant (skips transparently when the
    // gateway is not configured; every attempt is console-visible via audit)
    const notify = await notifyApplicantApproved({
      adminEmail: r.adminEmail, adminName: r.adminName, organizationName: r.organizationName,
      applicationNumber: r.applicationNumber, planName: p.planId ? (await db.saasPlan.findUnique({ where: { id: p.planId } }))?.name || null : null,
      billingCycle: p.billingCycle || r.billingCycle, trialDays: p.trialDays || null,
    })
    return {
      applicationNumber: updated.applicationNumber,
      status: updated.status,
      vendorId: result.vendorId,
      vendorCode: result.vendorCode,
      adminEmail: r.adminEmail,
      subscriptionId: result.subscriptionId,
      warnings: result.warnings,
      applicantNotified: notify.status,
    }
    } catch (err) {
      // S1-001 — rollback the claim on failure so the registration is re-approvable
      await db.saasRegistration.update({ where: { id: r.id }, data: { status: r.status } }).catch(() => {})
      throw err
    }
  },
})

// ---- R12 (2026-10-12) — Accept & invoice. Distinct from approve: accepting
// provisions the tenant AND issues the FIRST subscription invoice (linked via
// SaasInvoice.registrationId) AND emails the applicant a payment request with
// the full invoice details (number, plan, period, amount, due date, remit
// instructions). Approve stays the plain-welcome path; Accept is the
// "you're in — here's your bill" path.
ownerAction("owner.registrations.accept", {
  perm: "registrations.approve",
  schema: z.object({
    id: z.string().min(1),
    planId: z.string().min(1),
    billingCycle: z.enum(["MONTHLY", "YEARLY"]).optional(),
    reviewNote: z.string().max(2000).optional(),
    trialDays: z.number().int().min(0).max(90).optional(),
    invoiceDueDays: z.number().int().min(0).max(60).default(7),
  }),
  handler: async (ctx, p) => {
    const r = await db.saasRegistration.findUnique({ where: { id: p.id } })
    if (!r) throw Object.assign(new Error("Application not found"), { code: 404 })
    if (r.status === "APPROVED") throw Object.assign(new Error("This application is already approved."), { code: 400 })
    if (r.status === "CANCELLED") throw Object.assign(new Error("This application was cancelled — re-open it first."), { code: 400 })

    // S1-001 — conditional claim (same as approve): prevent double-accept race
    const claimed = await db.saasRegistration.updateMany({
      where: { id: r.id, status: { in: ["PENDING", "UNDER_REVIEW", "REQUEST_INFO"] } },
      data: { status: "PROVISIONING" },
    })
    if (claimed.count === 0) {
      throw Object.assign(new Error("This application was already claimed by another operator. Refresh and try again."), { code: 409 })
    }

    try {
    if (p.billingCycle) {
      await db.saasRegistration.update({ where: { id: r.id }, data: { billingCycle: p.billingCycle } })
      r.billingCycle = p.billingCycle
    }

    // 1. provision the tenant transactionally (same path as approve)
    const result = await provisionTenant(r, p.planId, { id: ctx.ownerId, name: ctx.name })
    const plan = await db.saasPlan.findUnique({ where: { id: p.planId } })
    if (!plan) throw Object.assign(new Error("Plan not found."), { code: 400 })
    const billingCycle = r.billingCycle === "YEARLY" ? "YEARLY" : "MONTHLY"

    // 2. read back the fresh subscription (provision sets ACTIVE + term)
    const sub = await db.saasSubscription.findUnique({ where: { id: result.subscriptionId } })
    if (!sub) throw Object.assign(new Error("Provisioned subscription not found."), { code: 500 })
    const periodStart = sub.startDate
    let periodEnd = sub.endDate

    // 3. optional trial window (invoice still covers the full term — the
    //    trial rides INSIDE the term, exactly like approve)
    const trialDays = p.trialDays || 0
    if (trialDays > 0) {
      const endDate = new Date(Date.now() + trialDays * 86400000)
      await db.saasSubscription.update({ where: { id: sub.id }, data: { status: "TRIAL", endDate } })
      periodEnd = endDate
    }

    // 4. FIRST invoice — the piece Accept adds over Approve. Amount is the
    //    plan's price snapshot for the chosen cycle; due date defaults to
    //    +invoiceDueDays (0 = due on receipt).
    //    IDEMPOTENCY FIX (2026-10-26): provisionTenant already generates the initial
    //    term invoice for PENDING_PAYMENT subscriptions. Re-use and update it with
    //    the accept metadata (registrationId + custom dueAt) rather than creating
    //    a second duplicate invoice for the same subscription term.
    const amount = Number(billingCycle === "YEARLY" ? plan.yearlyPrice : plan.monthlyPrice)
    const dueAt = p.invoiceDueDays > 0 ? new Date(Date.now() + p.invoiceDueDays * 86400000) : null
    let inv = result.initialInvoiceId
      ? await db.saasInvoice.findUnique({ where: { id: result.initialInvoiceId } })
      : await db.saasInvoice.findFirst({
          where: { subscriptionId: sub.id, kind: "TERM", status: { not: "CANCELLED" } },
          orderBy: { createdAt: "desc" },
        })

    if (inv) {
      inv = await db.saasInvoice.update({
        where: { id: inv.id },
        data: {
          registrationId: r.id,
          dueAt: dueAt ?? inv.dueAt,
          notes: `First invoice issued on accepting application ${r.applicationNumber} (${r.organizationName}).`,
        },
      })
    } else {
      const { createTermInvoice } = await import("./payments/billing-ops")
      const termInv = await createTermInvoice({
        vendorId: result.vendorId,
        subscriptionId: sub.id,
        registrationId: r.id,
        amount,
        currency: sub.currencySnapshot || plan.currency || "BDT",
        periodStart,
        periodEnd: periodEnd ?? new Date(periodStart.getTime() + 30 * 86400000),
        dueAt,
        notes: `First invoice issued on accepting application ${r.applicationNumber} (${r.organizationName}).`,
        actor: { id: ctx.ownerId, name: ctx.name },
      })
      const createdInv = await db.saasInvoice.findUnique({ where: { id: termInv.id } })
      if (!createdInv) throw Object.assign(new Error("Failed to load created invoice"), { code: 500 })
      inv = createdInv
    }

    // 5. stamp the application (APPROVED outcome — Accept is an approval
    //    variant; the audit + invoice rows carry the accept distinction)
    const updated = await db.saasRegistration.update({
      where: { id: r.id },
      data: {
        status: "APPROVED",
        approvedVendorId: result.vendorId,
        subscriptionId: result.subscriptionId,
        reviewedById: ctx.ownerId,
        reviewedByName: ctx.name,
        reviewedAt: new Date(),
        reviewNote: p.reviewNote || r.reviewNote,
      },
    })
    invalidateEntitlements(result.vendorId)

    // 6. automated invoice issue email with 2-page PDF attachment
    const notify = await notifyInvoiceIssued(inv.id)

    // 7. audit trail (three rows: accept, tenant, invoice)
    await saasAudit(ctx, "REGISTRATION_ACCEPTED", "SaaSRegistration", r.id,
      `Accepted ${r.applicationNumber} — tenant "${r.organizationName}" provisioned (code ${result.vendorCode}) and first invoice ${inv.number} (${inv.currency} ${amount}) emailed to ${r.adminEmail}`,
      { vendorId: result.vendorId, metadata: { applicationNumber: r.applicationNumber, vendorCode: result.vendorCode, subscriptionId: result.subscriptionId, invoiceId: inv.id, invoiceNumber: inv.number, amount, invoiceEmailStatus: notify.status, warnings: result.warnings } })
    await saasAudit(ctx, "TENANT_CREATED", "Vendor", result.vendorId,
      `Tenant provisioned from application ${r.applicationNumber} (accept flow)`,
      { vendorId: result.vendorId, metadata: { code: result.vendorCode } })
    await saasAudit(ctx, "INVOICE_CREATED", "SaaSInvoice", inv.id,
      `Invoice ${inv.number} (accept flow) for ${r.organizationName}: ${inv.currency} ${amount}, due ${dueAt ? dueAt.toISOString().slice(0, 10) : "on receipt"}`,
      { vendorId: result.vendorId, metadata: { number: inv.number, amount, registrationId: r.id } })

    return {
      applicationNumber: updated.applicationNumber,
      status: updated.status,
      vendorId: result.vendorId,
      vendorCode: result.vendorCode,
      adminEmail: r.adminEmail,
      subscriptionId: result.subscriptionId,
      invoice: { id: inv.id, number: inv.number, amount, currency: inv.currency, dueAt: dueAt ? dueAt.toISOString() : null, status: inv.status },
      invoiceEmailStatus: notify.status,
      invoiceEmailDetail: notify.detail || undefined,
      warnings: result.warnings,
    }
    } catch (err) {
      // S1-001 — rollback the claim on failure so the registration is re-approvable
      await db.saasRegistration.update({ where: { id: r.id }, data: { status: r.status } }).catch(() => {})
      throw err
    }
  },
})

ownerAction("owner.registrations.reject", {
  perm: "registrations.reject",
  schema: z.object({
    id: z.string().min(1),
    rejectionReason: z.string().trim().min(10, "A rejection reason is required (min 10 characters)").max(2000),
    reviewNote: z.string().max(2000).optional(),
  }),
  handler: async (ctx, p) => {
    const r = await db.saasRegistration.findUnique({ where: { id: p.id } })
    if (!r) throw Object.assign(new Error("Application not found"), { code: 404 })
    if (r.status === "APPROVED") {
      throw Object.assign(new Error("An approved application cannot be rejected — suspend the tenant instead."), { code: 400 })
    }
    const updated = await db.saasRegistration.update({
      where: { id: r.id },
      data: {
        status: "REJECTED",
        rejectionReason: p.rejectionReason,
        reviewNote: p.reviewNote || r.reviewNote,
        reviewedById: ctx.ownerId,
        reviewedByName: ctx.name,
        reviewedAt: new Date(),
      },
    })
    // history is preserved — the row is NEVER deleted
    await saasAudit(ctx, "REGISTRATION_REJECTED", "SaaSRegistration", r.id,
      `Rejected ${r.applicationNumber} (${r.organizationName}): ${p.rejectionReason}`,
      { metadata: { applicationNumber: r.applicationNumber, reason: p.rejectionReason } })
    // platform gateway — notify the applicant (transparent skip when unset)
    const notify = await notifyApplicantRejected({
      adminEmail: r.adminEmail, organizationName: r.organizationName,
      applicationNumber: r.applicationNumber, reason: p.rejectionReason,
    })
    return { status: updated.status, applicantNotified: notify.status }
  },
})

ownerAction("owner.registrations.reopen", {
  perm: "registrations.manage",
  schema: z.object({ id: z.string().min(1) }),
  handler: async (ctx, p) => {
    const r = await db.saasRegistration.findUnique({ where: { id: p.id } })
    if (!r) throw Object.assign(new Error("Application not found"), { code: 404 })
    if (r.status !== "REJECTED") throw Object.assign(new Error("Only rejected applications can be re-opened."), { code: 400 })
    const updated = await db.saasRegistration.update({
      where: { id: r.id },
      data: { status: "PENDING", reviewedById: ctx.ownerId, reviewedByName: ctx.name, reviewedAt: new Date() },
    })
    await saasAudit(ctx, "REGISTRATION_REVIEWED", "SaaSRegistration", r.id,
      `Re-opened rejected application ${r.applicationNumber}`,
      { metadata: { from: "REJECTED", to: "PENDING" } })
    return { status: updated.status }
  },
})

// ============================ TENANTS ============================
const tenantListSchema = PAGINATION.extend({
  status: z.enum(["ALL", "ACTIVE", "INACTIVE"]).default("ALL"),
  plan: z.string().max(60).optional(), // plan name or "LEGACY"
  expiring: z.enum(["ALL", "7", "30", "60", "EXPIRED"]).default("ALL"),
})

ownerAction("owner.tenants.list", {
  perm: "tenants.view",
  schema: tenantListSchema,
  handler: async (_ctx, p) => {
    // SCL-7 (Phase 3 WS-A) — DATABASE-LEVEL search, filtering and pagination.
    // The pre-Phase-3 handler loaded EVERY vendor (with subscription include),
    // EVERY owner user, ran resolveEntitlements + usageSnapshot per vendor
    // (2 awaited calls × N tenants), then filtered/paginated the fully
    // materialized array in JS — O(N) queries + O(N) payload per page view,
    // unusable past a few thousand tenants. The rewrite:
    //   * WHERE / ORDER BY / LIMIT+OFFSET in SQL (parameterized, 1:1 with the
    //     vendor row via the vendorId-unique SaaSSubscription);
    //   * admin resolved by a LATERAL first-VENDOR_OWNER join (same
    //     first-by-creation semantics as the old in-memory map);
    //   * usage for ONLY the current page, answered by 7 grouped queries
    //     restricted to the page's vendorIds (not per-row fan-out);
    //   * entitlements per page row only (bounded by pageSize ≤ 100).
    // Parameterized construction: every user-controlled value rides as a $n
    // placeholder (params array in order); the SQL text itself is static
    // fragments only — no string interpolation of request data anywhere.
    const params: unknown[] = []
    const conds: string[] = []
    if (p.status === "ACTIVE") conds.push(`v."active" = true`)
    if (p.status === "INACTIVE") conds.push(`v."active" = false`)
    if (p.plan) {
      if (p.plan === "LEGACY") conds.push(`s."id" IS NULL`)
      else conds.push(`s."planName" = $${params.push(p.plan)}`)
    }
    if (p.expiring === "EXPIRED") {
      conds.push(`s."endDate" < now()`)
    } else if (p.expiring !== "ALL") {
      const d = Number(p.expiring)
      conds.push(`s."endDate" >= now() AND s."endDate" <= now() + ($${params.push(d)} * interval '1 day')`)
    }
    if (p.search) {
      const q = `%${p.search.toLowerCase()}%`
      conds.push(
        `(LOWER(v."name") LIKE $${params.push(q)} OR LOWER(v."code") LIKE $${params.push(q)} OR EXISTS (` +
        `SELECT 1 FROM "User" u WHERE u."vendorId" = v."id" AND u."role" = 'VENDOR_OWNER' AND LOWER(u."email") LIKE $${params.push(q)}))`,
      )
    }
    const whereSql = conds.length ? `WHERE ${conds.join(" AND ")}` : ""
    const offset = (p.page - 1) * p.pageSize
    const limitIdx = params.length + 1
    const offsetIdx = params.length + 2
    params.push(p.pageSize, offset)

    const [countRows, pageRows] = await Promise.all([
      db.$queryRawUnsafe<Array<{ c: number }>>(
        `SELECT COUNT(*)::int AS c
         FROM "Vendor" v
         LEFT JOIN "SaaSSubscription" s ON s."vendorId" = v."id"
         ${whereSql}`,
        ...params.slice(0, -2),
      ),
      db.$queryRawUnsafe<Array<{
        id: string; name: string; code: string; active: boolean; createdAt: Date
        planName: string | null; subStatus: string | null; billingCycle: string | null; endDate: Date | null
        adminName: string | null; adminEmail: string | null
      }>>(
        `SELECT v."id", v."name", v."code", v."active", v."createdAt",
                s."planName", s."status" AS "subStatus", s."billingCycle", s."endDate",
                adm."name" AS "adminName", adm."email" AS "adminEmail"
         FROM "Vendor" v
         LEFT JOIN "SaaSSubscription" s ON s."vendorId" = v."id"
         LEFT JOIN LATERAL (
           SELECT u."name", u."email" FROM "User" u
           WHERE u."vendorId" = v."id" AND u."role" = 'VENDOR_OWNER'
           ORDER BY u."createdAt" ASC LIMIT 1
         ) adm ON true
         ${whereSql}
         ORDER BY v."createdAt" DESC
         LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
        ...params,
      ),
    ])
    const total = Number(countRows[0]?.c || 0)
    const ids = pageRows.map((r) => r.id)

    // usage for the PAGE ONLY — 7 grouped queries, fleet-size independent
    const [empRows, userRows, branchRows, deptRows, deviceRows, trackRows, storageRows] = ids.length
      ? await Promise.all([
          db.employee.groupBy({ by: ["vendorId"], where: { vendorId: { in: ids }, status: { notIn: ["RESIGNED", "TERMINATED", "RETIRED", "INACTIVE"] } }, _count: { _all: true } }),
          db.user.groupBy({ by: ["vendorId"], where: { vendorId: { in: ids }, status: "ACTIVE" }, _count: { _all: true } }),
          db.branch.groupBy({ by: ["vendorId"], where: { vendorId: { in: ids } }, _count: { _all: true } }),
          db.department.groupBy({ by: ["vendorId"], where: { vendorId: { in: ids } }, _count: { _all: true } }),
          db.attendanceDevice.groupBy({ by: ["vendorId"], where: { vendorId: { in: ids }, enabled: true }, _count: { _all: true } }),
          db.employeeTrackingState.groupBy({ by: ["vendorId"], where: { vendorId: { in: ids }, trackingEnabled: true }, _count: { _all: true } }),
          db.usageRollup.findMany({ where: { vendorId: { in: ids } }, select: { vendorId: true, storageBytes: true } }),
        ])
      : [[], [], [], [], [], [], []]
    const cnt = (rows: { vendorId: string; _count?: { _all?: number } }[], id: string) =>
      Number(rows.find((r) => r.vendorId === id)?._count?._all || 0)
    const storageOf = new Map(storageRows.map((r) => [r.vendorId, Number(r.storageBytes)]))
    const now = Date.now()

    const rows = await Promise.all(
      pageRows.map(async (v) => {
        const ent = await resolveEntitlements(v.id)
        const usage = {
          employees: cnt(empRows, v.id),
          users: cnt(userRows, v.id),
          branches: cnt(branchRows, v.id),
          departments: cnt(deptRows, v.id),
          devices: cnt(deviceRows, v.id),
          trackingEmployees: cnt(trackRows, v.id),
          storageUsedBytes: storageOf.get(v.id) ?? 0,
        }
        const days = v.endDate ? Math.ceil((v.endDate.getTime() - now) / 86400000) : null
        return {
          id: v.id,
          name: v.name,
          code: v.code,
          active: v.active,
          createdAt: v.createdAt,
          admin: v.adminEmail ? { name: v.adminName || "", email: v.adminEmail } : null,
          planName: v.planName || "Legacy (no subscription)",
          subscriptionStatus: v.subStatus || "LEGACY",
          billingCycle: v.billingCycle,
          endDate: v.endDate,
          daysRemaining: days,
          usage,
          storageGb: ent.limits.STORAGE ?? null,
          trackingStatus: usage.trackingEmployees > 0 ? "ENABLED" : "OFF",
        }
      }),
    )
    return { total, page: p.page, pageSize: p.pageSize, rows }
  },
})

ownerAction("owner.tenants.get", {
  perm: "tenants.view",
  schema: z.object({ id: z.string().min(1) }),
  handler: async (_ctx, p) => {
    const v: any = await db.vendor.findUnique({
      where: { id: p.id },
      include: {
        saasSubscriptions: { include: { plan: true, events: { orderBy: { createdAt: "desc" } as any, take: 50 } } },
      },
    })
    if (!v) throw Object.assign(new Error("Tenant not found"), { code: 404 })
    const users = await db.user.findMany({
      where: { vendorId: p.id },
      select: { id: true, name: true, email: true, role: true, status: true, lastLoginAt: true },
    })
    const sub = v.saasSubscriptions[0] || null
    const ent = await resolveEntitlements(v.id)
    const usage = await usageSnapshot(v.id)
    // the originating registration, if any
    const reg = await db.saasRegistration.findFirst({ where: { approvedVendorId: v.id }, select: { applicationNumber: true, createdAt: true, status: true } })
    // tenant-level platform audit trail
    const auditRows = await db.saasAuditLog.findMany({
      where: { vendorId: v.id },
      orderBy: { createdAt: "desc" },
      take: 50,
    })
    // R13/R15 — expiry-notice journal for this tenant (pre/post expiry,
    // email + SMS, with retries) so the tenant page shows the reminder
    // history alongside the subscription controls
    const expiryNotices = await db.saasExpiryNotice.findMany({
      where: { vendorId: v.id },
      orderBy: { sentAt: "desc" },
      take: 15,
    })
    return {
      tenant: {
        id: v.id, name: v.name, code: v.code, active: v.active, createdAt: v.createdAt,
        email: v.email, phone: v.phone, address: v.address,
      },
      admin: users.filter((u: any) => u.role === "VENDOR_OWNER")[0] || null,
      users,
      subscription: sub
        ? {
            id: sub.id, planName: sub.planName, planId: sub.planId, status: sub.status,
            billingCycle: sub.billingCycle, startDate: sub.startDate, endDate: sub.endDate,
            priceAtCreation: Number(sub.priceAtCreation), currency: sub.currencySnapshot,
            history: sub.events.map((e: any) => ({ id: e.id, type: e.type, note: e.note, actorName: e.actorName, createdAt: e.createdAt, to: j(e.toSnapshot, {}) })),
          }
        : null,
      entitlements: {
        mode: ent.mode, status: ent.status, features: ent.features, limits: ent.limits,
        overrides: ent.overrides, storageGbOverride: ent.storageGbOverride, readonly: ent.readonly,
      },
      usage,
      registration: reg,
      audit: auditRows.map((a) => ({ id: a.id, action: a.action, actorName: a.actorName, summary: a.summary, createdAt: a.createdAt })),
      expiryNotices: expiryNotices.map((n) => ({
        id: n.id, kind: n.kind, refDate: n.refDate, daysOffset: n.daysOffset,
        channel: n.channel, status: n.status, attempts: n.attempts, detail: n.detail, sentAt: n.sentAt,
      })),
    }
  },
})

// ---- Phase 4 WS-D — per-tenant usage metering for billing -------------------
// The monthly UsageSnapshot series for one tenant (the daily platform pass
// keeps the current month fresh; the last write of a month is that month's
// frozen end-of-month record). Billing reconciliation no longer has to
// re-derive historical usage from live tables, which only ever answer "now".
ownerAction("owner.usage.history", {
  perm: "tenants.view",
  schema: z.object({ id: z.string().min(1), months: z.number().int().min(1).max(60).optional() }),
  handler: async (_ctx, p) => {
    const v = await db.vendor.findUnique({ where: { id: p.id }, select: { id: true, name: true, code: true } })
    if (!v) throw Object.assign(new Error("Tenant not found"), { code: 404 })
    const rows = await db.usageSnapshot.findMany({
      where: { vendorId: p.id },
      orderBy: [{ periodYear: "desc" }, { periodMonth: "desc" }],
      take: p.months ?? 24,
    })
    return {
      tenant: { id: v.id, name: v.name, code: v.code },
      months: rows.map((r) => ({
        period: `${r.periodYear}-${String(r.periodMonth).padStart(2, "0")}`,
        employeesTotal: r.employeesTotal,
        employeesPayroll: r.employeesPayroll,
        portalUsers: r.portalUsers,
        devicesEnrolled: r.devicesEnrolled,
        storageBytes: Number(r.storageBytes),
        capturedAt: r.capturedAt,
        updatedAt: r.updatedAt,
      })),
    }
  },
})

// ---- tenant lifecycle actions (each: load → validate → update → audit) ----
async function loadSubscription(vendorId: string) {
  const sub = await db.saasSubscription.findUnique({ where: { vendorId } })
  if (!sub) throw Object.assign(new Error("This tenant has no subscription (legacy tenant). Assign a plan first."), { code: 400 })
  return sub
}

ownerAction("owner.tenants.suspend", {
  perm: "tenants.manage",
  schema: z.object({ id: z.string().min(1), reason: z.string().trim().min(5).max(1000) }),
  handler: async (ctx, p) => {
    const sub = await loadSubscription(p.id)
    const from = sub.status
    if (sub.status === "SUSPENDED") throw Object.assign(new Error("This tenant is already suspended."), { code: 400 })
    const updated = await db.saasSubscription.update({ where: { id: sub.id }, data: { status: "SUSPENDED", notes: p.reason } })
    await db.saasSubscriptionEvent.create({
      data: { subscriptionId: sub.id, vendorId: sub.vendorId, type: "SUSPENDED", fromSnapshot: JSON.stringify({ status: from }), toSnapshot: JSON.stringify({ status: "SUSPENDED" }), note: p.reason, actorId: ctx.ownerId, actorName: ctx.name },
    })
    await db.vendor.update({ where: { id: p.id }, data: { active: false } })
    invalidateEntitlements(p.id)
    await saasAudit(ctx, "TENANT_SUSPENDED", "Vendor", p.id, `Tenant subscription suspended: ${p.reason}`, { vendorId: p.id, metadata: { from, to: "SUSPENDED", reason: p.reason } })
    return { status: updated.status }
  },
})

ownerAction("owner.tenants.reactivate", {
  perm: "tenants.manage",
  schema: z.object({ id: z.string().min(1), note: z.string().max(1000).optional() }),
  handler: async (ctx, p) => {
    const sub = await loadSubscription(p.id)
    const from = sub.status
    if (sub.status === "ACTIVE") throw Object.assign(new Error("This tenant is already active."), { code: 400 })
    const updated = await db.saasSubscription.update({ where: { id: sub.id }, data: { status: "ACTIVE", notes: p.note || null } })
    await db.saasSubscriptionEvent.create({
      data: { subscriptionId: sub.id, vendorId: sub.vendorId, type: "REACTIVATED", fromSnapshot: JSON.stringify({ status: from }), toSnapshot: JSON.stringify({ status: "ACTIVE" }), note: p.note || null, actorId: ctx.ownerId, actorName: ctx.name },
    })
    await db.vendor.update({ where: { id: p.id }, data: { active: true } })
    invalidateEntitlements(p.id)
    await saasAudit(ctx, "TENANT_ACTIVATED", "Vendor", p.id, `Tenant reactivated (was ${from})`, { vendorId: p.id, metadata: { from, to: "ACTIVE" } })
    return { status: updated.status }
  },
})

// 2026-10-25 (master prompt Part C §6): the registered platform tenant name
// is OWNER-controlled. Tenant users cannot rename their workspace (the
// settings.save/patch server-side strips prove it); this is the sanctioned
// owner-side rename path — audited, with the previous name preserved.
ownerAction("owner.tenants.rename", {
  perm: "tenants.manage",
  schema: z.object({
    id: z.string().min(1),
    name: z.string().trim().min(2).max(160),
    reason: z.string().trim().min(5).max(500),
  }),
  handler: async (ctx, p) => {
    const vendor = await db.vendor.findUnique({ where: { id: p.id } })
    if (!vendor) throw Object.assign(new Error("Tenant not found"), { code: 404 })
    const name = p.name.trim()
    if (name === vendor.name) throw Object.assign(new Error("The tenant name is unchanged."), { code: 400 })
    await db.vendor.update({ where: { id: p.id }, data: { name } })
    // keep the tenant-plane display mirror in sync (read-only for tenants)
    await db.hrSetting.upsert({
      where: { vendorId_group_key: { vendorId: p.id, group: "general", key: "companyName" } },
      create: { vendorId: p.id, group: "general", key: "companyName", value: name },
      update: { value: name },
    }).catch(() => {})
    await saasAudit(ctx, "TENANT_RENAMED", "Vendor", p.id,
      `Registered tenant name changed: "${vendor.name}" → "${name}" — ${p.reason}`,
      { vendorId: p.id, metadata: { from: vendor.name, to: name, reason: p.reason } })
    return { id: p.id, name }
  },
})

ownerAction("owner.subscriptions.changePlan", {
  // shared by tenants.changePlan and subscriptions.upgrade/downgrade
  perm: "tenants.manage",
  schema: z.object({
    id: z.string().min(1), // vendorId
    planId: z.string().min(1),
    billingCycle: z.enum(["MONTHLY", "YEARLY"]).optional(),
    note: z.string().max(1000).optional(),
  }),
  handler: async (ctx, p) => {
    const sub = await loadSubscription(p.id)
    const plan = await db.saasPlan.findUnique({ where: { id: p.planId } })
    if (!plan) throw Object.assign(new Error("Plan not found"), { code: 404 })
    // 2026-10-25 custom plans (master prompt Part G §12): a tenant-specific
    // custom plan can ONLY be assigned to the tenant it was built for.
    if (plan.isCustom && plan.customForVendorId && plan.customForVendorId !== p.id) {
      throw Object.assign(new Error("That custom plan was built for a different tenant."), { code: 400 })
    }
    const cycle = p.billingCycle || sub.billingCycle
    const from = { plan: sub.planName, cycle: sub.billingCycle, status: sub.status, price: Number(sub.priceAtCreation), endDate: sub.endDate ? sub.endDate.toISOString() : null }
    // upgrade/downgrade is determined by price+limits direction — recorded verbatim
    const isUpgrade = (cycle === "MONTHLY" ? plan.monthlyPrice : plan.yearlyPrice).gte(sub.priceAtCreation)
    const data: any = {
      planId: plan.id,
      planName: plan.name,
      billingCycle: cycle,
      priceAtCreation: cycle === "MONTHLY" ? plan.monthlyPrice : plan.yearlyPrice,
      currencySnapshot: plan.currency,
      // billing-mode snapshot (RECURRING | ONE_TIME) from the plan
      billingMode: plan.billingMode || "RECURRING",
    }
    // cycle change re-anchors the end date from today
    if (cycle !== sub.billingCycle) {
      const end = cycleEndDate(new Date(), cycle)
      data.endDate = end
      data.startDate = new Date()
    }
    // ONE_TIME custom plans (master prompt §12.1C): the owner EXPLICITLY
    // defines validity — oneTimeValidityDays null = non-expiring (endDate
    // null), a number = fixed window from assignment. The subscription does
    // not auto-renew: no renewal invoices or reminders (the lifecycle sweep
    // and initiateRenewalInvoice skip billingMode ONE_TIME).
    if (plan.billingMode === "ONE_TIME") {
      data.endDate = plan.oneTimeValidityDays != null
        ? new Date(Date.now() + plan.oneTimeValidityDays * 86400000)
        : null
      data.startDate = new Date()
    }
    const updated = await db.saasSubscription.update({ where: { id: sub.id }, data })
    await db.saasSubscriptionEvent.create({
      data: {
        subscriptionId: sub.id, vendorId: sub.vendorId,
        type: cycle !== sub.billingCycle ? "CYCLE_CHANGED" : (isUpgrade ? "UPGRADED" : "DOWNGRADED"),
        fromSnapshot: JSON.stringify(from),
        toSnapshot: JSON.stringify({ plan: plan.name, cycle, status: updated.status, price: Number(updated.priceAtCreation), endDate: updated.endDate ? updated.endDate.toISOString() : null, billingMode: updated.billingMode }),
        note: p.note || (plan.billingMode === "ONE_TIME" ? `One-time plan${plan.oneTimeValidityDays != null ? ` — valid ${plan.oneTimeValidityDays} days from assignment` : " — non-expiring"}` : null), actorId: ctx.ownerId, actorName: ctx.name,
      },
    })
    invalidateEntitlements(p.id)
    await saasAudit(ctx, isUpgrade ? "PLAN_UPGRADED" : "PLAN_CHANGED", "SaaSSubscription", sub.id,
      `Subscription for tenant ${p.id}: ${sub.planName} (${sub.billingCycle}) → ${plan.name} (${cycle}${plan.billingMode === "ONE_TIME" ? ", one-time" : ""})`,
      { vendorId: p.id, metadata: { from, to: { plan: plan.name, cycle, billingMode: plan.billingMode || "RECURRING", oneTimeValidityDays: plan.oneTimeValidityDays ?? null } } })
    return { planName: updated.planName, billingCycle: updated.billingCycle, endDate: updated.endDate }
  },
})

// ============ 2026-10-25 — CUSTOM PLAN BUILDER (master prompt Part G §12) ======
// A custom plan is a tenant-specific SaasPlan row: isCustom + customForVendorId
// bind it to ONE tenant; isPublic=false keeps it out of every catalog (the
// tenant catalog filters isPublic). The builder exposes the COMPLETE module
// + limit surface of the platform (the same columns the standard plan editor
// uses) — nothing is a hardcoded subset. Historical invoices/payments are
// never rewritten: plan changes snapshot on the subscription + events.
ownerAction("owner.plans.saveCustom", {
  perm: "tenants.manage",
  schema: z.object({
    planId: z.string().trim().max(40).optional(), // edit an existing custom plan
    vendorId: z.string().trim().min(1).max(40),
    basePlanId: z.string().trim().max(40).optional(), // starting point (ignored on edit)
    name: z.string().trim().min(2).max(80),
    tagline: z.string().trim().max(160).optional(),
    description: z.string().trim().max(1000).optional(),
    billingMode: z.enum(["RECURRING", "ONE_TIME"]),
    billingCycle: z.enum(["MONTHLY", "YEARLY"]).default("MONTHLY"),
    monthlyPrice: z.number().min(0).max(10_000_000),
    yearlyPrice: z.number().min(0).max(10_000_000).optional(),
    oneTimeValidityDays: z.number().int().min(1).max(3650).nullable().optional(),
    currency: z.string().trim().length(3).default("BDT"),
    employeeLimit: z.number().int().min(1).max(1_000_000).nullable().optional(),
    userLimit: z.number().int().min(1).max(100_000).nullable().optional(),
    branchLimit: z.number().int().min(1).max(10_000).nullable().optional(),
    departmentLimit: z.number().int().min(1).max(10_000).nullable().optional(),
    deviceLimit: z.number().int().min(1).max(10_000).nullable().optional(),
    storageGb: z.number().int().min(1).max(100_000).nullable().optional(),
    trackingEmployeeLimit: z.number().int().min(1).max(1_000_000).nullable().optional(),
    payrollEnabled: z.boolean().optional(),
    aitEnabled: z.boolean().optional(),
    inventoryEnabled: z.boolean().optional(),
    procurementEnabled: z.boolean().optional(),
    performanceEnabled: z.boolean().optional(),
    essEnabled: z.boolean().optional(),
    cameraEnabled: z.boolean().optional(),
    trackingEnabled: z.boolean().optional(),
    geofenceEnabled: z.boolean().optional(),
    apiAccess: z.boolean().optional(),
    advancedReports: z.boolean().optional(),
    fieldForceEnabled: z.boolean().optional(),
    supportLevel: z.enum(["STANDARD", "PRIORITY", "DEDICATED"]).default("STANDARD"),
    assignNow: z.boolean().default(false), // also changePlan this vendor onto it
    reason: z.string().trim().min(5).max(500),
  }).strict(),
  handler: async (ctx, p) => {
    const vendor = await db.vendor.findUnique({ where: { id: p.vendorId }, select: { id: true, name: true } })
    if (!vendor) throw Object.assign(new Error("Tenant not found"), { code: 404 })

    // module flags default from the base plan when provided, else all-off
    const base = p.basePlanId ? await db.saasPlan.findUnique({ where: { id: p.basePlanId } }) : null
    const flag = (k: keyof typeof p, dflt: boolean) => (p[k] !== undefined ? (p[k] as boolean) : base ? Boolean((base as any)[k]) : dflt)

    if (p.billingMode === "ONE_TIME" && p.oneTimeValidityDays === undefined) {
      throw Object.assign(new Error("A one-time plan must define its validity: a number of days, or null for explicitly non-expiring."), { code: 400 })
    }

    const fields = {
      name: p.name,
      tagline: p.tagline || null,
      description: p.description || (base?.description ?? null),
      billingMode: p.billingMode,
      monthlyPrice: p.monthlyPrice,
      oneTimeValidityDays: p.billingMode === "ONE_TIME" ? (p.oneTimeValidityDays ?? null) : null,
      currency: p.currency,
      employeeLimit: p.employeeLimit !== undefined ? p.employeeLimit : (base?.employeeLimit ?? null),
      userLimit: p.userLimit !== undefined ? p.userLimit : (base?.userLimit ?? null),
      branchLimit: p.branchLimit !== undefined ? p.branchLimit : (base?.branchLimit ?? null),
      departmentLimit: p.departmentLimit !== undefined ? p.departmentLimit : (base?.departmentLimit ?? null),
      deviceLimit: p.deviceLimit !== undefined ? p.deviceLimit : (base?.deviceLimit ?? null),
      storageGb: p.storageGb !== undefined ? p.storageGb : (base?.storageGb ?? null),
      trackingEmployeeLimit: p.trackingEmployeeLimit !== undefined ? p.trackingEmployeeLimit : (base?.trackingEmployeeLimit ?? null),
      payrollEnabled: flag("payrollEnabled", false),
      aitEnabled: flag("aitEnabled", false),
      inventoryEnabled: flag("inventoryEnabled", false),
      procurementEnabled: flag("procurementEnabled", false),
      performanceEnabled: flag("performanceEnabled", false),
      essEnabled: flag("essEnabled", true),
      cameraEnabled: flag("cameraEnabled", false),
      trackingEnabled: flag("trackingEnabled", false),
      geofenceEnabled: flag("geofenceEnabled", false),
      apiAccess: flag("apiAccess", false),
      advancedReports: flag("advancedReports", false),
      fieldForceEnabled: flag("fieldForceEnabled", false),
      supportLevel: p.supportLevel,
      isCustom: true,
      customForVendorId: vendor.id,
      isPublic: false, // NEVER in any public/self-service catalog
      active: true,
      isTrialPlan: false,
    }

    let planRow
    if (p.planId) {
      const existing = await db.saasPlan.findUnique({ where: { id: p.planId } })
      if (!existing) throw Object.assign(new Error("Custom plan not found"), { code: 404 })
      if (!existing.isCustom || existing.customForVendorId !== vendor.id) {
        throw Object.assign(new Error("Only the tenant's own custom plan can be edited here."), { code: 400 })
      }
      planRow = await db.saasPlan.update({
        where: { id: p.planId },
        data: { ...fields, yearlyPrice: p.yearlyPrice ?? Number(existing.yearlyPrice) },
      })
    } else {
      planRow = await db.saasPlan.create({
        data: {
          ...fields,
          yearlyPrice: p.yearlyPrice ?? p.monthlyPrice,
          sortOrder: 900, // custom plans sort after the standard catalog
        },
      })
    }

    await saasAudit(ctx, "CUSTOM_PLAN_SAVED", "SaasPlan", planRow.id,
      `Custom plan "${planRow.name}" ${p.planId ? "updated" : "created"} for tenant "${vendor.name}" (${p.billingMode}${p.billingMode === "ONE_TIME" ? (p.oneTimeValidityDays != null ? `, ${p.oneTimeValidityDays}d validity` : ", non-expiring") : `, ${p.billingCycle.toLowerCase()}, ৳${p.monthlyPrice}`}) — ${p.reason}`,
      { vendorId: vendor.id, metadata: { reason: p.reason, billingMode: p.billingMode, monthlyPrice: p.monthlyPrice, fields: Object.keys(fields) } })

    let assigned = false
    if (p.assignNow) {
      // assign through the REAL changePlan handler (events + snapshots + audit)
      const out = await ownerRoutes["owner.subscriptions.changePlan"].handler(ctx, {
        id: vendor.id,
        planId: planRow.id,
        billingCycle: p.billingMode === "ONE_TIME" ? undefined : p.billingCycle,
        note: `Custom plan assigned by ${ctx.name} — ${p.reason}`,
      }) as { planName: string }
      assigned = !!out.planName
    }
    return { planId: planRow.id, name: planRow.name, assigned }
  },
})

/** List a tenant's custom plans + the full module/limit surface for the builder. */
ownerAction("owner.plans.customList", {
  perm: "tenants.view",
  schema: z.object({ vendorId: z.string().trim().min(1).max(40) }).strict(),
  handler: async (_ctx, p) => {
    const [vendor, customPlans, standardPlans] = await Promise.all([
      db.vendor.findUnique({ where: { id: p.vendorId }, select: { id: true, name: true } }),
      db.saasPlan.findMany({
        where: { isCustom: true, customForVendorId: p.vendorId },
        orderBy: { createdAt: "desc" },
      }),
      db.saasPlan.findMany({
        where: { active: true, isPublic: true },
        orderBy: { sortOrder: "asc" },
        select: { id: true, name: true, tagline: true },
      }),
    ])
    if (!vendor) throw Object.assign(new Error("Tenant not found"), { code: 404 })
    return {
      vendor: { id: vendor.id, name: vendor.name },
      customPlans: customPlans.map((pl) => ({
        id: pl.id, name: pl.name, tagline: pl.tagline, description: pl.description,
        billingMode: pl.billingMode, oneTimeValidityDays: pl.oneTimeValidityDays,
        monthlyPrice: Number(pl.monthlyPrice), yearlyPrice: Number(pl.yearlyPrice),
        currency: pl.currency, active: pl.active,
        limits: {
          employeeLimit: pl.employeeLimit, userLimit: pl.userLimit, branchLimit: pl.branchLimit,
          departmentLimit: pl.departmentLimit, deviceLimit: pl.deviceLimit, storageGb: pl.storageGb,
          trackingEmployeeLimit: pl.trackingEmployeeLimit,
        },
        modules: {
          payrollEnabled: pl.payrollEnabled, aitEnabled: pl.aitEnabled, inventoryEnabled: pl.inventoryEnabled,
          procurementEnabled: pl.procurementEnabled, performanceEnabled: pl.performanceEnabled,
          essEnabled: pl.essEnabled, cameraEnabled: pl.cameraEnabled, trackingEnabled: pl.trackingEnabled,
          geofenceEnabled: pl.geofenceEnabled, apiAccess: pl.apiAccess,
          advancedReports: pl.advancedReports, fieldForceEnabled: pl.fieldForceEnabled,
        },
        supportLevel: pl.supportLevel, createdAt: pl.createdAt,
      })),
      basePlans: standardPlans,
    }
  },
})

ownerAction("owner.subscriptions.extend", {
  perm: "subscriptions.manage",
  schema: z.object({
    id: z.string().min(1), // vendorId
    days: z.number().int().min(1).max(1095).optional(),
    months: z.number().int().min(1).max(36).optional(),
    note: z.string().max(1000).optional(),
  }),
  handler: async (ctx, p) => {
    const sub = await loadSubscription(p.id)
    // 2026-10-25 — a non-expiring (ONE_TIME, null endDate) subscription cannot
    // be "extended" relative to a term end; anchor at now instead.
    const anchorEnd = sub.endDate ?? new Date()
    const from = anchorEnd.toISOString()
    let newEnd = new Date(anchorEnd)
    if (p.months) {
      newEnd = new Date(anchorEnd)
      newEnd.setMonth(newEnd.getMonth() + p.months)
    } else if (p.days) {
      newEnd = new Date(anchorEnd.getTime() + p.days * 86400000)
    } else {
      throw Object.assign(new Error("Specify days or months to extend by."), { code: 400 })
    }
    const status = sub.status === "EXPIRED" || sub.status === "GRACE_PERIOD" ? "ACTIVE" : sub.status
    const updated = await db.saasSubscription.update({ where: { id: sub.id }, data: { endDate: newEnd, status, notes: p.note || sub.notes } })
    await db.saasSubscriptionEvent.create({
      data: { subscriptionId: sub.id, vendorId: sub.vendorId, type: "EXTENDED", fromSnapshot: JSON.stringify({ endDate: from, status: sub.status }), toSnapshot: JSON.stringify({ endDate: newEnd.toISOString(), status }), note: p.note || null, actorId: ctx.ownerId, actorName: ctx.name },
    })
    invalidateEntitlements(p.id)
    await saasAudit(ctx, "SUBSCRIPTION_EXTENDED", "SaaSSubscription", sub.id,
      `Subscription extended: end ${from.slice(0, 10)} → ${newEnd.toISOString().slice(0, 10)} (${p.months ? `${p.months} months` : `${p.days} days`})`,
      { vendorId: p.id, metadata: { from, to: newEnd.toISOString() } })
    return { endDate: updated.endDate, status: updated.status }
  },
})

ownerAction("owner.subscriptions.cycle", {
  perm: "subscriptions.manage",
  schema: z.object({ id: z.string().min(1), billingCycle: z.enum(["MONTHLY", "YEARLY"]), note: z.string().max(1000).optional() }),
  handler: async (ctx, p) => {
    // reuse changePlan with the same plan, different cycle
    const sub = await loadSubscription(p.id)
    if (p.billingCycle === sub.billingCycle) throw Object.assign(new Error(`Already on ${p.billingCycle.toLowerCase()} billing.`), { code: 400 })
    return ownerRoutes["owner.subscriptions.changePlan"].handler(ctx, { id: p.id, planId: sub.planId, billingCycle: p.billingCycle, note: p.note || `Billing cycle switched to ${p.billingCycle}` })
  },
})

ownerAction("owner.subscriptions.grace", {
  perm: "subscriptions.manage",
  schema: z.object({ id: z.string().min(1), days: z.number().int().min(1).max(90), note: z.string().max(1000).optional() }),
  handler: async (ctx, p) => {
    const sub = await loadSubscription(p.id)
    const from = sub.status
    if (!sub.endDate) throw Object.assign(new Error("A non-expiring subscription cannot enter a grace period."), { code: 400 })
    const graceEnd = new Date(sub.endDate.getTime() + p.days * 86400000)
    const updated = await db.saasSubscription.update({
      where: { id: sub.id },
      data: { status: "GRACE_PERIOD", endDate: graceEnd, gracePeriodDays: p.days, notes: p.note || sub.notes },
    })
    await db.saasSubscriptionEvent.create({
      data: { subscriptionId: sub.id, vendorId: sub.vendorId, type: "GRACE_APPLIED", fromSnapshot: JSON.stringify({ status: from }), toSnapshot: JSON.stringify({ status: "GRACE_PERIOD", endDate: graceEnd.toISOString() }), note: p.note || null, actorId: ctx.ownerId, actorName: ctx.name },
    })
    invalidateEntitlements(p.id)
    await saasAudit(ctx, "SUBSCRIPTION_GRACE_APPLIED", "SaaSSubscription", sub.id,
      `Grace period applied: ${p.days} days (end → ${graceEnd.toISOString().slice(0, 10)})`,
      { vendorId: p.id, metadata: { from, to: "GRACE_PERIOD", days: p.days } })
    return { status: updated.status, endDate: updated.endDate }
  },
})

ownerAction("owner.subscriptions.cancel", {
  perm: "subscriptions.manage",
  schema: z.object({ id: z.string().min(1), reason: z.string().trim().min(5).max(1000) }),
  handler: async (ctx, p) => {
    const sub = await loadSubscription(p.id)
    if (sub.status === "CANCELLED") throw Object.assign(new Error("Already cancelled."), { code: 400 })
    const from = sub.status
    const updated = await db.saasSubscription.update({ where: { id: sub.id }, data: { status: "CANCELLED", notes: p.reason } })
    await db.saasSubscriptionEvent.create({
      data: { subscriptionId: sub.id, vendorId: sub.vendorId, type: "CANCELLED", fromSnapshot: JSON.stringify({ status: from }), toSnapshot: JSON.stringify({ status: "CANCELLED" }), note: p.reason, actorId: ctx.ownerId, actorName: ctx.name },
    })
    invalidateEntitlements(p.id)
    await saasAudit(ctx, "SUBSCRIPTION_CANCELLED", "SaaSSubscription", sub.id, `Subscription cancelled: ${p.reason}`, { vendorId: p.id, metadata: { from, to: "CANCELLED", reason: p.reason } })
    return { status: updated.status }
  },
})

ownerAction("owner.tenants.setOverride", {
  perm: "tenants.manage",
  schema: z.object({
    id: z.string().min(1),
    featureToggles: z.record(z.string().max(40), z.boolean()).optional(), // { payroll: false, tracking: true, ... } by HRM module key
    storageGbOverride: z.number().int().min(1).max(10000).nullable().optional(),
    note: z.string().max(1000).optional(),
  }),
  handler: async (ctx, p) => {
    const existing = await db.saasTenantOverride.findUnique({ where: { vendorId: p.id } })
    const fromToggles = existing?.featureToggles || "{}"
    const fromStorage = existing?.storageGbOverride ?? null
    const data: any = { updatedById: ctx.ownerId, updatedByName: ctx.name }
    if (p.featureToggles) data.featureToggles = JSON.stringify(p.featureToggles)
    if (p.storageGbOverride !== undefined) data.storageGbOverride = p.storageGbOverride
    if (p.note !== undefined) data.note = p.note
    const row = existing
      ? await db.saasTenantOverride.update({ where: { vendorId: p.id }, data })
      : await db.saasTenantOverride.create({ data: { vendorId: p.id, ...data } })
    invalidateEntitlements(p.id)
    const sub = await db.saasSubscription.findUnique({ where: { vendorId: p.id } })
    if (sub) {
      await db.saasSubscriptionEvent.create({
        data: { subscriptionId: sub.id, vendorId: p.id, type: "OVERRIDE_CHANGED", fromSnapshot: JSON.stringify({ toggles: fromToggles, storage: fromStorage }), toSnapshot: JSON.stringify({ toggles: row.featureToggles, storage: row.storageGbOverride }), note: p.note || null, actorId: ctx.ownerId, actorName: ctx.name },
      })
    }
    await saasAudit(ctx, "FEATURE_OVERRIDE_CHANGED", "Vendor", p.id,
      `Tenant overrides changed (storage ${fromStorage ?? "—"} → ${row.storageGbOverride ?? "—"}; toggles updated)`,
      { vendorId: p.id, metadata: { fromToggles, toToggles: row.featureToggles, fromStorage, toStorage: row.storageGbOverride } })
    return { featureToggles: JSON.parse(row.featureToggles), storageGbOverride: row.storageGbOverride, note: row.note }
  },
})

// ============================ PLANS ============================
ownerAction("owner.plans.list", {
  perm: "plans.view",
  handler: async () => {
    const plans = await db.saasPlan.findMany({ orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] })
    const counts = await db.saasSubscription.groupBy({ by: ["planId"], _count: { planId: true } })
    const countMap = new Map(counts.map((c) => [c.planId, c._count.planId]))
    return {
      plans: plans.map((p) => ({
        ...p,
        monthlyPrice: Number(p.monthlyPrice),
        yearlyPrice: Number(p.yearlyPrice),
        subscriberCount: countMap.get(p.id) || 0,
      })),
    }
  },
})

const planSchema = z.object({
  id: z.string().max(40).optional(), // absent = create
  name: z.string().trim().min(2).max(60),
  tagline: z.string().trim().max(120).optional().nullable(),
  description: z.string().trim().max(2000).optional().nullable(),
  monthlyPrice: z.number().min(0).max(9999999),
  yearlyPrice: z.number().min(0).max(99999999),
  currency: z.string().trim().length(3).default("BDT"),
  employeeLimit: z.number().int().min(1).max(500000).nullable(),
  userLimit: z.number().int().min(1).max(10000).nullable(),
  branchLimit: z.number().int().min(1).max(5000).nullable(),
  departmentLimit: z.number().int().min(1).max(5000).nullable(),
  deviceLimit: z.number().int().min(1).max(5000).nullable(),
  storageGb: z.number().int().min(1).max(10000).nullable(),
  trackingEmployeeLimit: z.number().int().min(1).max(100000).nullable(),
  payrollEnabled: z.boolean().default(false),
  aitEnabled: z.boolean().default(false),
  inventoryEnabled: z.boolean().default(false),
  procurementEnabled: z.boolean().default(false),
  performanceEnabled: z.boolean().default(false),
  essEnabled: z.boolean().default(true),
  cameraEnabled: z.boolean().default(false),
  trackingEnabled: z.boolean().default(false),
  geofenceEnabled: z.boolean().default(false),
  apiAccess: z.boolean().default(false),
  advancedReports: z.boolean().default(false),
  fieldForceEnabled: z.boolean().default(false),
  supportLevel: z.enum(["STANDARD", "PRIORITY", "DEDICATED"]).default("STANDARD"),
  isPublic: z.boolean().default(true),
  active: z.boolean().default(true),
  isTrialPlan: z.boolean().default(false),
  badge: z.string().trim().max(40).optional().nullable(),
  sortOrder: z.number().int().min(0).max(999).default(0),
})

ownerAction("owner.plans.save", {
  perm: "plans.manage",
  schema: planSchema,
  handler: async (ctx, p) => {
    if (p.id) {
      const existing = await db.saasPlan.findUnique({ where: { id: p.id } })
      if (!existing) throw Object.assign(new Error("Plan not found"), { code: 404 })
      const { id: _id, ...changes } = p
      const updated = await db.saasPlan.update({ where: { id: p.id }, data: changes })
      await saasAudit(ctx, "PLAN_UPDATED", "SaaSPlan", updated.id, `Plan "${updated.name}" updated`, { metadata: { from: { name: existing.name, monthly: Number(existing.monthlyPrice) }, to: { name: updated.name, monthly: Number(updated.monthlyPrice) } } })
      return { id: updated.id }
    }
    const { id: _omit, ...data } = p
    const created = await db.saasPlan.create({ data })
    await saasAudit(ctx, "PLAN_CREATED", "SaaSPlan", created.id, `Plan "${created.name}" created (BDT ${p.monthlyPrice}/mo, BDT ${p.yearlyPrice}/yr)`, {})
    return { id: created.id }
  },
})

ownerAction("owner.plans.duplicate", {
  perm: "plans.manage",
  schema: z.object({ id: z.string().min(1) }),
  handler: async (ctx, p) => {
    const src = await db.saasPlan.findUnique({ where: { id: p.id } })
    if (!src) throw Object.assign(new Error("Plan not found"), { code: 404 })
    const { id: _id, createdAt: _ca, updatedAt: _ua, name: _n, ...rest } = src
    const copy = await db.saasPlan.create({
      data: { ...rest, name: `${src.name} (Copy)`, isPublic: false, active: false, badge: null },
    })
    await saasAudit(ctx, "PLAN_CREATED", "SaaSPlan", copy.id, `Plan "${src.name}" duplicated as "${copy.name}" (draft)`, { metadata: { sourcePlanId: src.id } })
    return { id: copy.id }
  },
})

ownerAction("owner.plans.toggle", {
  perm: "plans.manage",
  schema: z.object({ id: z.string().min(1), active: z.boolean(), isPublic: z.boolean().optional() }),
  handler: async (ctx, p) => {
    const data: any = { active: p.active }
    if (typeof p.isPublic === "boolean") data.isPublic = p.isPublic
    const updated = await db.saasPlan.update({ where: { id: p.id }, data })
    await saasAudit(ctx, "PLAN_UPDATED", "SaaSPlan", updated.id, `Plan "${updated.name}" ${p.active ? "activated" : "deactivated"}`, { metadata: { active: p.active } })
    return { active: updated.active }
  },
})

// ============================ SUBSCRIPTIONS LIST / RENEWALS ============================
ownerAction("owner.subscriptions.list", {
  perm: "subscriptions.view",
  schema: PAGINATION.extend({
    status: z.enum(["ALL", "TRIAL", "ACTIVE", "PAST_DUE", "GRACE_PERIOD", "EXPIRED", "SUSPENDED", "CANCELLED", "LEGACY"]).default("ALL"),
  }),
  handler: async (_ctx, p) => {
    const where: any = {}
    if (p.status === "LEGACY") {
      // Phase 5 P0 — vendors WITHOUT a subscription row, paged in SQL. (The
      // pre-Phase-5 leg loaded EVERY vendor with a saasSubscriptions include
      // and filtered in JS — the last remaining full-table fan-out in the
      // owner console, the exact SCL-6/F36 class.) NOT EXISTS over the
      // vendorId-unique SaaSSubscription is a 1:1 anti-join; the admin rides
      // a LATERAL first-VENDOR_OWNER (same semantics as owner.tenants.list).
      const params: unknown[] = []
      const conds: string[] = [`NOT EXISTS (SELECT 1 FROM "SaaSSubscription" s WHERE s."vendorId" = v."id")`]
      if (p.search) {
        const q = `%${p.search.toLowerCase()}%`
        conds.push(`(LOWER(v."name") LIKE $${params.push(q)} OR LOWER(v."code") LIKE $${params.push(q)})`)
      }
      const whereSql = `WHERE ${conds.join(" AND ")}`
      const offset = (p.page - 1) * p.pageSize
      const limitIdx = params.length + 1
      const offsetIdx = params.length + 2
      params.push(p.pageSize, offset)
      const [countRows, pageRows] = await Promise.all([
        db.$queryRawUnsafe<Array<{ c: number }>>(
          `SELECT COUNT(*)::int AS c FROM "Vendor" v ${whereSql}`,
          ...params.slice(0, -2),
        ),
        db.$queryRawUnsafe<Array<{ id: string; name: string; code: string; adminName: string | null; adminEmail: string | null }>>(
          `SELECT v."id", v."name", v."code", adm."name" AS "adminName", adm."email" AS "adminEmail"
           FROM "Vendor" v
           LEFT JOIN LATERAL (
             SELECT u."name", u."email" FROM "User" u
             WHERE u."vendorId" = v."id" AND u."role" = 'VENDOR_OWNER'
             ORDER BY u."createdAt" ASC LIMIT 1
           ) adm ON true
           ${whereSql}
           ORDER BY v."createdAt" DESC
           LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
          ...params,
        ),
      ])
      return {
        total: Number(countRows[0]?.c || 0), page: p.page, pageSize: p.pageSize,
        rows: pageRows.map((v) => ({
          vendorId: v.id, vendorName: v.name, vendorCode: v.code,
          admin: v.adminEmail ? { name: v.adminName || "", email: v.adminEmail } : null,
          planName: null, status: "LEGACY", billingCycle: null, startDate: null, endDate: null, price: null, currency: null,
        })),
      }
    }
    if (p.status !== "ALL") where.status = p.status
    if (p.search) {
      where.OR = [
        { planName: { contains: p.search, mode: "insensitive" } },
        { vendor: { name: { contains: p.search, mode: "insensitive" } } },
      ]
    }
    const [total, subs] = await Promise.all([
      db.saasSubscription.count({ where }),
      db.saasSubscription.findMany({
        where,
        include: { vendor: { select: { name: true, code: true } } },
        orderBy: { endDate: "asc" },
        skip: (p.page - 1) * p.pageSize,
        take: p.pageSize,
      }),
    ])
    const ownerRows = subs.length
      ? await db.user.findMany({
          where: { vendorId: { in: subs.map((x: any) => x.vendorId) }, role: "VENDOR_OWNER" },
          select: { vendorId: true, name: true, email: true },
        })
      : []
    const adminOf = new Map<string, { name: string; email: string }>()
    for (const o of ownerRows) if (!adminOf.has(o.vendorId)) adminOf.set(o.vendorId, { name: o.name, email: o.email })
    return {
      total, page: p.page, pageSize: p.pageSize,
      rows: subs.map((s: any) => ({
        id: s.id, vendorId: s.vendorId, vendorName: s.vendor.name, vendorCode: s.vendor.code,
        admin: adminOf.get(s.vendorId) || null,
        planName: s.planName, status: s.status, billingCycle: s.billingCycle,
        startDate: s.startDate, endDate: s.endDate,
        price: Number(s.priceAtCreation), currency: s.currencySnapshot,
        gracePeriodDays: s.gracePeriodDays,
      })),
    }
  },
})

// owner.renewals.list MOVED to customers-console.ts (Phase 5 P5) — the last
// full-table JS-filtered list in the panel, rewritten to the SQL-paged
// console standard (window semantics + CEIL day arithmetic IN SQL, summary
// block, total/page/pageSize; rows + settings shape unchanged — a superset).
// The re-registration there overwrites nothing here: this file no longer
// defines it.

// ============================ INQUIRIES ============================
ownerAction("owner.inquiries.list", {
  perm: "inquiries.view",
  schema: PAGINATION.extend({ status: z.enum(["ALL", "NEW", "IN_REVIEW", "RESPONDED", "CLOSED"]).default("ALL") }),
  handler: async (_ctx, p) => {
    const where: any = {}
    if (p.status !== "ALL") where.status = p.status
    if (p.search) {
      where.OR = [
        { name: { contains: p.search, mode: "insensitive" } },
        { email: { contains: p.search, mode: "insensitive" } },
        { company: { contains: p.search, mode: "insensitive" } },
      ]
    }
    const [total, rows] = await Promise.all([
      db.saasContactInquiry.count({ where }),
      db.saasContactInquiry.findMany({ where, orderBy: { createdAt: "desc" }, skip: (p.page - 1) * p.pageSize, take: p.pageSize }),
    ])
    return { total, page: p.page, pageSize: p.pageSize, rows: rows.map((r) => ({ ...r, modulesRequested: j(r.modulesRequested, []) })) }
  },
})

ownerAction("owner.inquiries.handle", {
  perm: "inquiries.manage",
  schema: z.object({ id: z.string().min(1), status: z.enum(["IN_REVIEW", "RESPONDED", "CLOSED"]), note: z.string().max(2000).optional() }),
  handler: async (ctx, p) => {
    const updated = await db.saasContactInquiry.update({
      where: { id: p.id },
      data: { status: p.status, handleNote: p.note || null, handledById: ctx.ownerId, handledByName: ctx.name, handledAt: new Date() },
    })
    await saasAudit(ctx, "INQUIRY_HANDLED", "SaaSContactInquiry", updated.id, `Inquiry from ${updated.name} marked ${p.status}`, { metadata: { status: p.status } })
    return { status: updated.status }
  },
})

// ============================ BILLING (manual, gateway-ready) ============================
ownerAction("owner.invoices.list", {
  perm: "billing.view",
  schema: PAGINATION.extend({ status: z.enum(["ALL", "PENDING", "PAID", "FAILED", "REFUNDED", "CANCELLED"]).default("ALL") }),
  handler: async (_ctx, p) => {
    const where: any = {}
    if (p.status !== "ALL") where.status = p.status
    if (p.search) where.number = { contains: p.search, mode: "insensitive" }
    const [total, invoices] = await Promise.all([
      db.saasInvoice.count({ where }),
      db.saasInvoice.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (p.page - 1) * p.pageSize,
        take: p.pageSize,
      }),
    ])
    const vendors = invoices.length
      ? await db.vendor.findMany({ where: { id: { in: invoices.map((x: any) => x.vendorId) } }, select: { id: true, name: true, code: true } })
      : []
    const vendorOf = new Map(vendors.map((v: any) => [v.id, v]))
    return {
      total, page: p.page, pageSize: p.pageSize,
      rows: invoices.map((i: any) => ({
        id: i.id, number: i.number, vendorId: i.vendorId,
        vendorName: vendorOf.get(i.vendorId)?.name || "(deleted tenant)",
        vendorCode: vendorOf.get(i.vendorId)?.code || "—",
        amount: Number(i.amount),
        currency: i.currency, status: i.status, periodStart: i.periodStart, periodEnd: i.periodEnd,
        vatRatePercent: Number(i.vatRatePercent ?? 5.0),
        netAmount: Number(i.netAmount ?? 0),
        vatAmount: Number(i.vatAmount ?? 0),
        issuedAt: i.issuedAt, dueAt: i.dueAt, paidAt: i.paidAt, method: i.paymentMethod, transactionId: i.transactionId,
      })),
    }
  },
})

ownerAction("owner.invoices.create", {
  perm: "billing.manage",
  schema: z.object({
    vendorId: z.string().min(1),
    amount: z.number().min(0).max(9999999),
    periodStart: z.string().datetime(),
    periodEnd: z.string().datetime(),
    dueAt: z.string().datetime().optional(),
    notes: z.string().max(1000).optional(),
  }),
  handler: async (ctx, p) => {
    const vendor = await db.vendor.findUnique({ where: { id: p.vendorId } })
    if (!vendor) throw Object.assign(new Error("Tenant not found"), { code: 404 })
    const sub = await db.saasSubscription.findUnique({ where: { vendorId: p.vendorId } })
    const pStart = new Date(p.periodStart)
    const pEnd = new Date(p.periodEnd)
    if (sub) {
      const existing = await db.saasInvoice.findFirst({
        where: {
          subscriptionId: sub.id,
          periodStart: pStart,
          periodEnd: pEnd,
          kind: "TERM",
          status: { not: "CANCELLED" },
        },
      })
      if (existing) {
        throw Object.assign(new Error(`An active term invoice (${existing.number}) already exists for this subscription period.`), { code: 409 })
      }
    }
    const settings = await getSaasSettings()
    const vatRate = Number(settings.billing.vatRatePercent ?? 5.0)
    const { netAmount, vatAmount } = calculateVatBreakdown(p.amount, vatRate)
    const number = await nextInvoiceNumber()
    const inv = await db.saasInvoice.create({
      data: {
        vendorId: p.vendorId,
        subscriptionId: sub?.id || null,
        number,
        periodStart: pStart,
        periodEnd: pEnd,
        amount: p.amount,
        currency: sub?.currencySnapshot || "BDT",
        vatRatePercent: vatRate,
        netAmount,
        vatAmount,
        status: "PENDING",
        dueAt: p.dueAt ? new Date(p.dueAt) : null,
        notes: p.notes || null,
        createdById: ctx.ownerId,
        createdByName: ctx.name,
      },
    })
    await saasAudit(ctx, "INVOICE_CREATED", "SaaSInvoice", inv.id, `Invoice ${number} for ${vendor.name} (BDT ${p.amount})`, { vendorId: p.vendorId, metadata: { number, amount: p.amount } })
    notifyInvoiceIssued(inv.id).catch((err) => console.error("notifyInvoiceIssued background error:", err))
    return { id: inv.id, number: inv.number }
  },
})

ownerAction("owner.invoices.markPaid", {
  perm: "billing.manage",
  schema: z.object({
    id: z.string().min(1),
    method: z.enum(["BANK", "CASH", "MFS", "CARD"]),
    transactionId: z.string().trim().max(120).optional(),
  }),
  handler: async (ctx, p) => {
    const inv = await db.saasInvoice.findUnique({ where: { id: p.id } })
    if (!inv) throw Object.assign(new Error("Invoice not found"), { code: 404 })
    if (inv.status === "PAID") throw Object.assign(new Error("Invoice already marked paid."), { code: 400 })
    const updated = await db.saasInvoice.update({
      where: { id: inv.id },
      data: { status: "PAID", paidAt: new Date(), paymentMethod: p.method, transactionId: p.transactionId || null },
    })
    await db.saasPayment.create({
      data: {
        invoiceId: inv.id, vendorId: inv.vendorId, amount: inv.amount, currency: inv.currency,
        method: p.method, transactionId: p.transactionId || null, status: "PAID",
        recordedById: ctx.ownerId, recordedByName: ctx.name,
      },
    })
    // OPS-8 (Phase 3 WS-A) — the manual PENDING→PAID flip now routes through
    // the SAME paid-term application the gateway settle flow uses (settle.ts
    // step 3 / billing-ops applyPaidTerm): a term-linked invoice extends the
    // subscription to the invoice's own term immediately instead of waiting
    // up to 24 h for the daily lifecycle sweep. Idempotent by construction
    // (anchored on the invoice period — never double-extends). A
    // CANCELLED/SUSPENDED subscription cannot renew — recorded as a warning,
    // never failing the payment recording.
    let extended = false
    let activated = false
    let upgradedTo: string | null = null
    let extensionNote: string | null = null
    if (inv.subscriptionId) {
      try {
        const { applyPaidTerm, applyUpgradePaid, systemActor } = await import("./payments/billing-ops")
        const actor = { ...(systemActor("Owner console (manual payment)") || { id: null, name: "Owner console" }), id: ctx.ownerId, name: ctx.name }
        if (inv.kind === "UPGRADE" && inv.upgradePlanId) {
          const upgraded = await applyUpgradePaid(inv, actor as any)
          upgradedTo = upgraded.applied ? upgraded.planName : null
        } else {
          const applied = await applyPaidTerm(inv, actor as any, {
            note: `Manual ${p.method} payment${p.transactionId ? ` (txn ${p.transactionId})` : ""} — invoice ${inv.number}`,
          })
          extended = applied.extended
          activated = applied.activated
        }
      } catch (e: any) {
        extensionNote = String(e?.message || e).slice(0, 300)
        console.error(`[markPaid] paid-term application failed for invoice ${inv.number}:`, extensionNote)
      }
    }
    await saasAudit(ctx, "PAYMENT_RECORDED", "SaaSInvoice", inv.id,
      `Invoice ${inv.number} marked PAID via ${p.method}${p.transactionId ? ` (txn ${p.transactionId})` : ""}` +
        (extended ? " — subscription extended to the invoice term" : activated ? " — subscription activated" : upgradedTo ? ` — plan upgraded to ${upgradedTo}` : extensionNote ? ` — term application skipped: ${extensionNote}` : ""),
      { vendorId: inv.vendorId, metadata: { method: p.method, transactionId: p.transactionId || null, amount: Number(inv.amount), extended, activated, upgradedTo, extensionNote } })
    // Wave 4 WP-C — outbound webhook to the tenant's endpoints on the manual
    // PENDING→PAID flip (fire-and-forget; delivery log is the record).
    try {
      const { webhookEmit } = await import("../webhooks")
      void webhookEmit(inv.vendorId, "invoice.paid", {
        invoiceId: inv.id, invoiceNumber: inv.number,
        amount: Number(inv.amount), currency: inv.currency,
        method: p.method, provider: "MANUAL", providerTxnId: p.transactionId || null,
        paidAt: new Date().toISOString(),
        extended,
      })
    } catch { /* never fail the settlement for a webhook */ }
    return { status: updated.status, extended }
  },
})

// ============================ OWNER USERS ============================
ownerAction("owner.users.list", {
  perm: "users.view",
  handler: async () => {
    const [users, customRoles] = await Promise.all([
      db.saasOwnerUser.findMany({ orderBy: { createdAt: "asc" } }),
      db.saasOwnerRole.findMany({ select: { key: true, name: true } }),
    ])
    // custom role names take precedence, built-in labels as fallback
    const roleNames = new Map(customRoles.map((r) => [r.key, r.name]))
    return {
      users: users.map((u) => ({
        id: u.id, email: u.email, name: u.name, roleKey: u.roleKey,
        roleLabel: roleNames.get(u.roleKey) || OWNER_ROLE_LABELS[u.roleKey] || u.roleKey,
        permissions: j(u.permissions, []),
        status: u.status, lastLoginAt: u.lastLoginAt, createdAt: u.createdAt,
        mfaEnrolled: !!u.mfaEnrolled,
      })),
    }
  },
})

const ownerUserSchema = z.object({
  id: z.string().max(40).optional(),
  email: z.string().trim().toLowerCase().email().max(160),
  name: z.string().trim().min(2).max(120),
  // builtin template key OR a custom SaasOwnerRole key (validated in-handler
  // against allOwnerRoleKeys — Roles & Permissions console)
  roleKey: z.string().trim().min(2).max(60),
  // empty array = derive from role template; explicit list = custom grants
  permissions: z.array(z.string().max(60)).max(60).default([]),
  status: z.enum(["ACTIVE", "SUSPENDED"]).default("ACTIVE"),
  // set ONLY when creating or explicitly resetting
  password: z.string().min(12).max(128).optional(),
  // SUPER_ADMIN rescue: strip a lost second factor for a locked-out owner
  resetMfa: z.boolean().optional(),
})

ownerAction("owner.users.save", {
  perm: "users.manage",
  schema: ownerUserSchema,
  handler: async (ctx, p) => {
    // guard BEFORE any write: an owner can never suspend their own account
    // (otherwise a misclick locks the whole console out).
    if (p.id && p.status === "SUSPENDED" && p.id === ctx.ownerId) {
      throw Object.assign(new Error("You cannot suspend your own account."), { code: 400 })
    }
    // roleKey must be a defined owner role (built-in template or custom
    // SaasOwnerRole row from the Roles & Permissions console)
    const knownRoles = await allOwnerRoleKeys()
    if (!knownRoles.includes(p.roleKey)) {
      throw Object.assign(new Error(`Unknown role "${p.roleKey}". Create it first under Roles & Permissions.`), { code: 400 })
    }
    if (p.id) {
      const existing = await db.saasOwnerUser.findUnique({ where: { id: p.id } })
      if (!existing) throw Object.assign(new Error("Owner user not found"), { code: 404 })
      const data: any = {
        email: p.email, name: p.name, roleKey: p.roleKey,
        permissions: JSON.stringify(p.permissions), status: p.status,
      }
      // MOD-8 (Phase 1) — async scrypt on the request path
      if (p.password) data.passwordHash = await hashOwnerPasswordAsync(p.password)
      if (p.resetMfa) {
        // SUPER_ADMIN only — never let a lesser role strip someone's second factor
        const self = await db.saasOwnerUser.findUnique({ where: { id: ctx.ownerId } })
        if (self?.roleKey !== "SUPER_ADMIN") {
          throw Object.assign(new Error("Only a super admin can reset another owner's MFA."), { code: 403 })
        }
        data.mfaEnrolled = false
        await db.saasOwnerMfaSecret.deleteMany({ where: { ownerId: p.id } })
        await db.saasOwnerSession.deleteMany({ where: { ownerId: p.id } })
        await saasAudit(ctx, "OWNER_MFA_RESET", "SaaSOwnerUser", p.id,
          `MFA reset for owner ${existing.email} by super admin ${ctx.email}`, {})
      }
      const updated = await db.saasOwnerUser.update({ where: { id: p.id }, data })
      await saasAudit(ctx, "OWNER_USER_CHANGED", "SaaSOwnerUser", updated.id,
        `Owner user ${updated.email} updated (role ${updated.roleKey})`,
        { metadata: { from: { role: existing.roleKey, status: existing.status }, to: { role: updated.roleKey, status: updated.status }, passwordReset: !!p.password, mfaReset: !!p.resetMfa } })
      return { id: updated.id }
    }
    if (!p.password || p.password.length < 12) {
      throw Object.assign(new Error("A password of at least 12 characters is required for a new owner user."), { code: 400 })
    }
    const dupe = await db.saasOwnerUser.findUnique({ where: { email: p.email } })
    if (dupe) throw Object.assign(new Error("An owner user with this email already exists."), { code: 409 })
    const created = await db.saasOwnerUser.create({
      data: {
        email: p.email, name: p.name, roleKey: p.roleKey,
        permissions: JSON.stringify(p.permissions),
        status: p.status, passwordHash: await hashOwnerPasswordAsync(p.password),
      },
    })
    await saasAudit(ctx, "OWNER_USER_CREATED", "SaaSOwnerUser", created.id,
      `Owner user ${created.email} created (role ${created.roleKey})`,
      { metadata: { role: created.roleKey } })
    return { id: created.id }
  },
})

// ============================ ROLES & PERMISSIONS ============================
// Owner-console role management (Owner Console → Roles & Permissions).
// Resolution: explicit user grants → SaasOwnerRole row (honors active) →
// static template. All writes are audited (OWNER_ROLE_CREATED / CHANGED /
// DELETED / TOGGLED) with from/to permission diffs.

ownerAction("owner.roles.list", {
  perm: "roles.view",
  handler: async () => {
    // lazily surface the 5 built-in template roles as editable isSystem rows
    await ensureSystemOwnerRolesSeeded()
    const [rows, userCounts] = await Promise.all([
      db.saasOwnerRole.findMany({ orderBy: [{ isSystem: "desc" }, { name: "asc" }] }),
      db.saasOwnerUser.groupBy({ by: ["roleKey"], _count: { _all: true } }),
    ])
    const countMap = new Map(userCounts.map((g: any) => [g.roleKey, g._count._all]))
    // include template keys without rows yet (fresh DB pre-seed) for visibility
    const rowKeys = new Set(rows.map((r) => r.key))
    const extra = (Object.keys(OWNER_ROLE_TEMPLATES) as string[]).filter((k) => !rowKeys.has(k))
    return {
      roles: [
        ...rows.map((r) => ({
          id: r.id, key: r.key, name: r.name, description: r.description || "",
          permissions: parseOwnerPermissions(r.permissions),
          isSystem: r.isSystem, active: r.active,
          userCount: countMap.get(r.key) || 0,
          createdAt: r.createdAt, updatedAt: r.updatedAt,
        })),
        ...extra.map((k) => ({
          id: "", key: k, name: OWNER_ROLE_LABELS[k] || k,
          description: "Built-in template (not yet materialized).",
          permissions: OWNER_ROLE_TEMPLATES[k as keyof typeof OWNER_ROLE_TEMPLATES] || [],
          isSystem: true, active: true, userCount: countMap.get(k) || 0,
          createdAt: null, updatedAt: null,
        })),
      ],
    }
  },
})

ownerAction("owner.roles.get", {
  perm: "roles.view",
  schema: z.object({ key: z.string().trim().min(2).max(60) }),
  handler: async (_ctx, p) => {
    const row = await db.saasOwnerRole.findUnique({ where: { key: p.key } })
    if (row) {
      return {
        id: row.id, key: row.key, name: row.name, description: row.description || "",
        permissions: parseOwnerPermissions(row.permissions),
        isSystem: row.isSystem, active: row.active, createdAt: row.createdAt, updatedAt: row.updatedAt,
      }
    }
    // fall back to the static template definition
    const tmpl = OWNER_ROLE_TEMPLATES[p.key as keyof typeof OWNER_ROLE_TEMPLATES]
    if (!tmpl) throw Object.assign(new Error("Role not found"), { code: 404 })
    return {
      id: "", key: p.key, name: OWNER_ROLE_LABELS[p.key] || p.key,
      description: "Built-in template (not yet materialized).",
      permissions: tmpl, isSystem: true, active: true, createdAt: null, updatedAt: null,
    }
  },
})

const roleSaveSchema = z.object({
  key: z.string().trim().min(2).max(40).regex(/^[A-Z][A-Z0-9_]*$/, "Key must be UPPERCASE letters, digits and underscores (e.g. REGIONAL_MANAGER)"),
  name: z.string().trim().min(2).max(80),
  description: z.string().trim().max(300).optional().default(""),
  permissions: z.array(z.string().max(60)).max(60).default([]),
  active: z.boolean().default(true),
  // id = edit existing; absent = create
  id: z.string().max(40).optional(),
})

ownerAction("owner.roles.save", {
  perm: "roles.manage",
  schema: roleSaveSchema,
  handler: async (ctx, p) => {
    // every permission must be a real owner permission from the vocabulary
    const valid = new Set<string>(OWNER_PERMISSIONS)
    const bad = p.permissions.filter((x: string) => !valid.has(x))
    if (bad.length > 0) {
      throw Object.assign(new Error(`Unknown permission(s): ${bad.join(", ")}`), { code: 400 })
    }
    const dedup = Array.from(new Set(p.permissions))

    if (p.id) {
      // ---- edit ----
      const existing = await db.saasOwnerRole.findUnique({ where: { id: p.id } })
      if (!existing) throw Object.assign(new Error("Role not found"), { code: 404 })
      // immutable key on system roles (user rows reference roleKey)
      if (existing.isSystem && p.key !== existing.key) {
        throw Object.assign(new Error("The key of a built-in role cannot be changed."), { code: 400 })
      }
      // key uniqueness (custom roles may rename their key)
      if (p.key !== existing.key) {
        const dupe = await db.saasOwnerRole.findUnique({ where: { key: p.key } })
        if (dupe) throw Object.assign(new Error("Another role already uses this key."), { code: 409 })
      }
      // SUPER_ADMIN is the break-glass role — never deactivate it
      if (existing.key === "SUPER_ADMIN" && !p.active) {
        throw Object.assign(new Error("The SUPER_ADMIN role cannot be deactivated."), { code: 400 })
      }
      const updated = await db.saasOwnerRole.update({
        where: { id: p.id },
        data: {
          key: p.key, name: p.name, description: p.description || null,
          permissions: JSON.stringify(dedup), active: p.active,
        },
      })
      await saasAudit(ctx, "OWNER_ROLE_CHANGED", "SaaSOwnerRole", updated.id,
        `Owner role ${updated.key} updated (${dedup.length} permissions, ${updated.active ? "active" : "inactive"})`,
        { metadata: {
          from: { key: existing.key, name: existing.name, permissions: parseOwnerPermissions(existing.permissions), active: existing.active },
          to: { key: updated.key, name: updated.name, permissions: dedup, active: updated.active },
        } })
      return { id: updated.id, key: updated.key }
    }

    // ---- create ----
    const dupe = await db.saasOwnerRole.findUnique({ where: { key: p.key } })
    if (dupe) throw Object.assign(new Error("A role with this key already exists."), { code: 409 })
    if (Object.prototype.hasOwnProperty.call(OWNER_ROLE_TEMPLATES, p.key)) {
      throw Object.assign(new Error("This key is reserved by a built-in role."), { code: 409 })
    }
    const created = await db.saasOwnerRole.create({
      data: {
        key: p.key, name: p.name, description: p.description || null,
        permissions: JSON.stringify(dedup), isSystem: false, active: p.active,
      },
    })
    await saasAudit(ctx, "OWNER_ROLE_CREATED", "SaaSOwnerRole", created.id,
      `Owner role ${created.key} created (${dedup.length} permissions)`,
      { metadata: { key: created.key, name: created.name, permissions: dedup } })
    return { id: created.id, key: created.key }
  },
})

ownerAction("owner.roles.delete", {
  perm: "roles.manage",
  schema: z.object({ id: z.string().max(40) }),
  handler: async (ctx, p) => {
    const existing = await db.saasOwnerRole.findUnique({ where: { id: p.id } })
    if (!existing) throw Object.assign(new Error("Role not found"), { code: 404 })
    if (existing.isSystem) {
      throw Object.assign(new Error("Built-in roles cannot be deleted — deactivate them instead."), { code: 400 })
    }
    const users = await db.saasOwnerUser.count({ where: { roleKey: existing.key } })
    if (users > 0) {
      throw Object.assign(
        new Error(`${users} owner user(s) still hold this role. Reassign them to another role first.`),
        { code: 400 }
      )
    }
    await db.saasOwnerRole.delete({ where: { id: p.id } })
    await saasAudit(ctx, "OWNER_ROLE_DELETED", "SaaSOwnerRole", p.id,
      `Owner role ${existing.key} deleted`,
      { metadata: { key: existing.key, name: existing.name, permissions: parseOwnerPermissions(existing.permissions) } })
    return { ok: true }
  },
})

ownerAction("owner.roles.toggle", {
  perm: "roles.manage",
  schema: z.object({ id: z.string().max(40), active: z.boolean() }),
  handler: async (ctx, p) => {
    const existing = await db.saasOwnerRole.findUnique({ where: { id: p.id } })
    if (!existing) throw Object.assign(new Error("Role not found"), { code: 404 })
    if (existing.key === "SUPER_ADMIN" && !p.active) {
      throw Object.assign(new Error("The SUPER_ADMIN role cannot be deactivated."), { code: 400 })
    }
    const updated = await db.saasOwnerRole.update({ where: { id: p.id }, data: { active: p.active } })
    await saasAudit(ctx, "OWNER_ROLE_TOGGLED", "SaaSOwnerRole", updated.id,
      `Owner role ${updated.key} ${p.active ? "activated" : "deactivated"}`,
      { metadata: { key: updated.key, from: existing.active, to: p.active } })
    return { id: updated.id, active: updated.active }
  },
})

// ============================ AUDIT ============================
ownerAction("owner.audit.list", {
  perm: "audit.view",
  schema: PAGINATION.extend({
    entity: z.string().max(40).optional(),
    action: z.string().max(60).optional(),
  }),
  handler: async (_ctx, p) => {
    const where: any = {}
    if (p.entity && p.entity !== "ALL") where.entity = p.entity
    if (p.action) where.action = { contains: p.action, mode: "insensitive" }
    if (p.search) {
      where.OR = [
        { summary: { contains: p.search, mode: "insensitive" } },
        { actorName: { contains: p.search, mode: "insensitive" } },
        { action: { contains: p.search, mode: "insensitive" } },
      ]
    }
    const [total, rows] = await Promise.all([
      db.saasAuditLog.count({ where }),
      db.saasAuditLog.findMany({ where, orderBy: { createdAt: "desc" }, skip: (p.page - 1) * p.pageSize, take: p.pageSize }),
    ])
    return { total, page: p.page, pageSize: p.pageSize, rows: rows.map((r) => ({ ...r, metadata: j(r.metadata, {}) })) }
  },
})

// ---- R16 (2026-10-12) — login-attempt audit report. Records BOTH planes
// (tenant /api/hrm + owner /api/owner), success and failure, with IP,
// user-agent, derived browser/OS/device labels. Retention-swept by jobs.ts
// (tenant rows: per-tenant loginAudit.retentionDays; owner rows: 180d).
ownerAction("owner.loginaudit.list", {
  perm: "audit.view",
  schema: PAGINATION.extend({
    plane: z.enum(["ALL", "TENANT", "OWNER"]).default("ALL"),
    outcome: z.enum(["ALL", "SUCCESS", "FAILURE"]).default("ALL"),
    browser: z.string().trim().max(60).optional(),
    os: z.string().trim().max(60).optional(),
    deviceType: z.enum(["ALL", "desktop", "mobile", "tablet", "bot"]).default("ALL"),
    from: z.string().datetime().optional(),
    to: z.string().datetime().optional(),
  }),
  handler: async (_ctx, p) => {
    const where: any = {}
    if (p.plane !== "ALL") where.plane = p.plane
    if (p.outcome === "SUCCESS") where.success = true
    if (p.outcome === "FAILURE") where.success = false
    if (p.browser) where.browser = { contains: p.browser, mode: "insensitive" }
    if (p.os) where.os = { contains: p.os, mode: "insensitive" }
    if (p.deviceType !== "ALL") where.deviceType = p.deviceType
    if (p.from || p.to) {
      where.createdAt = {}
      if (p.from) where.createdAt.gte = new Date(p.from)
      if (p.to) where.createdAt.lte = new Date(p.to)
    }
    if (p.search) {
      where.OR = [
        { email: { contains: p.search, mode: "insensitive" } },
        { userName: { contains: p.search, mode: "insensitive" } },
        { vendorName: { contains: p.search, mode: "insensitive" } },
        { ip: { contains: p.search } },
      ]
    }
    // Tally chips must describe the FILTERED window. When the outcome filter
    // narrows to one side, the other side is 0 by construction — the previous
    // `{ ...where, success: true }` override silently dropped the outcome
    // predicate from `where` and counted SUCCESS rows the filter had already
    // excluded (R16 fix: leak of out-of-window totals).
    const [total, rows, failCount, successCount] = await Promise.all([
      db.loginAuditLog.count({ where }),
      db.loginAuditLog.findMany({ where, orderBy: { createdAt: "desc" }, skip: (p.page - 1) * p.pageSize, take: p.pageSize }),
      p.outcome === "SUCCESS" ? Promise.resolve(0) : db.loginAuditLog.count({ where: { ...where, success: false } }),
      p.outcome === "FAILURE" ? Promise.resolve(0) : db.loginAuditLog.count({ where: { ...where, success: true } }),
    ])
    // top failure reasons within the current filter window (quick triage)
    const recentFailures = await db.loginAuditLog.findMany({
      where: { ...where, success: false },
      select: { failureReason: true },
      take: 500,
      orderBy: { createdAt: "desc" },
    })
    const reasons: Record<string, number> = {}
    for (const r of recentFailures) if (r.failureReason) reasons[r.failureReason] = (reasons[r.failureReason] || 0) + 1
    return { total, page: p.page, pageSize: p.pageSize, rows, failureCount: failCount, successCount, failureReasons: reasons }
  },
})

// ============================ SETTINGS ============================
ownerAction("owner.settings.get", {
  perm: "settings.view",
  handler: async () => {
    const [settings, planList] = await Promise.all([
      getSaasSettings(),
      db.saasPlan.findMany({ where: { active: true }, select: { id: true, name: true }, orderBy: { sortOrder: "asc" } }),
    ])
    return { settings, plans: planList }
  },
})

ownerAction("owner.settings.save", {
  perm: "settings.manage",
  schema: z.object({ group: z.string().max(40), values: z.record(z.string(), z.unknown()) }),
  handler: async (ctx, p) => {
    const before = await getSaasSettings()
    const updated = await saveSaasSettingsGroup(p.group, p.values)
    await saasAudit(ctx, "SETTINGS_CHANGED", "SaaSSetting", null,
      `Platform settings group "${p.group}" updated`,
      { metadata: { group: p.group, keys: Object.keys(p.values || {}), from: (before as any)[p.group] } })
    return { settings: updated }
  },
})

// ============================ PLANS (public helper for approve dialog) =========
ownerAction("owner.plans.forApproval", {
  perm: "registrations.approve",
  handler: async () => {
    const plans = await db.saasPlan.findMany({ where: { active: true }, orderBy: { sortOrder: "asc" } })
    return { plans: plans.map((p) => ({ id: p.id, name: p.name, monthlyPrice: Number(p.monthlyPrice), yearlyPrice: Number(p.yearlyPrice), currency: p.currency, employeeLimit: p.employeeLimit, storageGb: p.storageGb, supportLevel: p.supportLevel })) }
  },
})

// ============================ PLATFORM GATEWAY (email/SMS) =====================
// Own settings group ("gateway" rows in SaaSSetting), deliberately outside the
// typed SaasSettings so secrets never ride along with settings.get responses.
// Reads are MASKED (hasPassword / hasApiKey booleans); writes with an empty
// secret keep the existing value.
ownerAction("owner.gateway.get", {
  perm: "settings.view",
  handler: async () => {
    return { gateway: maskPlatformGateway(await getPlatformGateway()) }
  },
})

ownerAction("owner.gateway.save", {
  perm: "settings.manage",
  schema: z.object({
    emailEnabled: z.boolean().optional(),
    emailHost: z.string().trim().max(200).optional(),
    emailPort: z.number().int().min(1).max(65535).optional(),
    emailSecure: z.boolean().optional(),
    emailUsername: z.string().trim().max(200).optional(),
    emailPassword: z.string().max(200).optional(), // empty = keep existing
    emailFromAddress: z.string().trim().max(200).optional(),
    emailFromName: z.string().trim().max(120).optional(),
    smsEnabled: z.boolean().optional(),
    smsApiUrl: z.string().trim().max(500).optional(),
    smsMethod: z.enum(["GET", "POST"]).optional(),
    smsSenderId: z.string().trim().max(40).optional(),
    smsApiKey: z.string().max(300).optional(), // empty = keep existing
    // Wave 10 — explicit SMS adapter selection (SSLWireless v3 vs the generic
    // HTTP URL template).
    smsProvider: z.enum(["sslwireless", "generichttp", "none"]).optional(),
  }),
  handler: async (ctx, p) => {
    const before = maskPlatformGateway(await getPlatformGateway())
    const gateway = await savePlatformGateway(p as Record<string, unknown>)
    await saasAudit(ctx, "GATEWAY_SETTINGS_CHANGED", "SaaSSetting", null,
      `Platform gateway settings updated (email ${gateway.email.enabled ? "enabled" : "disabled"}, sms ${gateway.sms.enabled ? "enabled" : "disabled"})`,
      { metadata: { before, after: gateway } })
    return { gateway }
  },
})

ownerAction("owner.gateway.test", {
  perm: "settings.manage",
  schema: z.object({ to: z.string().trim().email().max(160) }),
  handler: async (ctx, p) => {
    const res = await sendPlatformEmail(p.to, "Finix HR — platform gateway test", "This is a test email from the Finix HR owner console platform gateway. If you can read this, the email gateway works.")
    await logPlatformNotification("EMAIL", "Gateway test", [p.to], res)
    await saasAudit(ctx, "GATEWAY_TEST", "SaaSSetting", null,
      `Platform gateway test email to ${p.to}: ${res.status}`, { metadata: { to: p.to, status: res.status, detail: res.detail } })
    return res
  },
})

// ============================ NOTIFICATIONS FEED ===============================
// The owner-console notification feed: every NOTIFICATION_* audit entry (sent,
// skipped, failed) from the platform gateway. No permission gate — any signed-in
// owner sees platform delivery status (same visibility as the audit page).
ownerAction("owner.notifications.list", {
  schema: z.object({ take: z.number().int().min(1).max(50).default(25) }),
  handler: async (_ctx, p) => {
    const rows = await db.saasAuditLog.findMany({
      where: { action: { startsWith: "NOTIFICATION_" } },
      orderBy: { createdAt: "desc" },
      take: p.take,
    })
    return {
      rows: rows.map((r) => ({
        id: r.id, action: r.action, summary: r.summary, createdAt: r.createdAt,
        meta: j(r.metadata, {}),
      })),
    }
  },
})

// ============================ MY ACCOUNT — MFA =================================
// Self-service second-factor management from a live FULL session (the login-time
// flows live in /api/owner auth.* — these are the Settings-page counterparts).

ownerAction("owner.auth.mfa.status", {
  handler: async (ctx) => {
    const owner = await db.saasOwnerUser.findUnique({ where: { id: ctx.ownerId } })
    if (!owner) throw Object.assign(new Error("Account unavailable"), { code: 401 })
    const s = await getSaasSettings()
    return {
      mfaEnrolled: !!owner.mfaEnrolled,
      platformRequires: !!s.security.ownerMfaRequired,
    }
  },
})

ownerAction("owner.auth.mfa.selfEnroll.start", {
  schema: z.object({ password: z.string().min(1).max(128) }),
  handler: async (ctx, p) => {
    const s = await getSaasSettings()
    const out = await ownerStartSelfEnroll(ctx.ownerId, String(p.password), s.general.platformName)
    await saasAudit(ctx, "OWNER_MFA_ENROLL_STARTED", "SaaSOwnerUser", ctx.ownerId,
      `Owner ${ctx.email} started MFA self-enrollment`, {})
    return out
  },
})

ownerAction("owner.auth.mfa.selfEnroll.complete", {
  schema: z.object({ code: z.string().min(6).max(10) }),
  handler: async (ctx, p) => {
    const out = await ownerCompleteSelfEnroll(ctx.ownerId, String(p.code))
    await saasAudit(ctx, "OWNER_MFA_ENABLED", "SaaSOwnerUser", ctx.ownerId,
      `Owner ${ctx.email} enabled MFA (self-enrollment completed)`, {})
    return out
  },
})

ownerAction("owner.auth.mfa.disable", {
  schema: z.object({ password: z.string().min(1).max(128), code: z.string().max(10).optional() }),
  handler: async (ctx, p) => {
    const owner = await db.saasOwnerUser.findUnique({ where: { id: ctx.ownerId } })
    if (!owner) throw Object.assign(new Error("Account unavailable"), { code: 401 })
    await ownerDisableMfa(ctx.ownerId, String(p.password), p.code ? String(p.code) : undefined)
    await saasAudit(ctx, "OWNER_MFA_DISABLED", "SaaSOwnerUser", ctx.ownerId,
      `Owner ${ctx.email} disabled MFA (password + code confirmed)`, {})
    return { ok: true }
  },
})

// ============================ WAVE 3 WP-C — PLAN-CHANGE REQUESTS ============================
// Tenant-submitted upgrade/downgrade requests (tenants whose roles lack
// billing.manage). Approving runs the REAL owner.subscriptions.changePlan
// handler with the requester as the recorded actor — same events, price
// snapshots, entitlement invalidation and saasAudit rows as any owner-side
// change. Rejecting keeps the row for the audit trail with a decision note.

ownerAction("owner.planchangerequests.list", {
  perm: "subscriptions.view",
  schema: PAGINATION.extend({ status: z.enum(["ALL", "PENDING", "APPROVED", "REJECTED"]).default("ALL") }),
  handler: async (_ctx, p) => {
    const where: any = {}
    if (p.status !== "ALL") where.status = p.status
    if (p.search) where.vendorId = { contains: p.search, mode: "insensitive" }
    const [total, rows] = await Promise.all([
      db.saasPlanChangeRequest.count({ where }),
      db.saasPlanChangeRequest.findMany({ where, orderBy: { createdAt: "desc" }, skip: (p.page - 1) * p.pageSize, take: p.pageSize }),
    ])
    const plans = rows.length
      ? await db.saasPlan.findMany({ where: { id: { in: rows.map((r) => r.requestedPlanId) } }, select: { id: true, name: true, monthlyPrice: true, yearlyPrice: true } })
      : []
    const vendors = rows.length
      ? await db.vendor.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.vendorId))] } }, select: { id: true, name: true, code: true } })
      : []
    const subs = rows.length
      ? await db.saasSubscription.findMany({ where: { vendorId: { in: [...new Set(rows.map((r) => r.vendorId))] } }, select: { vendorId: true, planName: true, billingCycle: true, priceAtCreation: true, status: true } })
      : []
    return {
      total, page: p.page, pageSize: p.pageSize,
      rows: rows.map((r) => {
        const plan = plans.find((pl) => pl.id === r.requestedPlanId)
        const sub = subs.find((s) => s.vendorId === r.vendorId)
        return {
          id: r.id,
          vendorId: r.vendorId,
          vendorName: vendors.find((v) => v.id === r.vendorId)?.name || r.vendorId,
          vendorCode: vendors.find((v) => v.id === r.vendorId)?.code || null,
          currentPlan: sub?.planName || null,
          billingCycle: sub?.billingCycle || null,
          subscriptionStatus: sub?.status || null,
          requestedPlanId: r.requestedPlanId,
          requestedPlanName: plan?.name || r.requestedPlanId,
          mode: r.mode,
          note: r.note,
          status: r.status,
          requestedByName: r.requestedByName,
          decidedByName: r.decidedByName,
          decidedAt: r.decidedAt,
          decisionNote: r.decisionNote,
          createdAt: r.createdAt,
        }
      }),
    }
  },
})

ownerAction("owner.planchangerequests.approve", {
  perm: "subscriptions.manage",
  schema: z.object({ id: z.string().min(1), note: z.string().max(500).optional() }).strict(),
  handler: async (ctx, p) => {
    const req = await db.saasPlanChangeRequest.findUnique({ where: { id: p.id } })
    if (!req) throw Object.assign(new Error("Request not found"), { code: 404 })
    if (req.status !== "PENDING") throw Object.assign(new Error(`This request was already ${req.status.toLowerCase()} — no double decisions`), { code: 400 })
    const plan = await db.saasPlan.findUnique({ where: { id: req.requestedPlanId } })
    if (!plan) throw Object.assign(new Error("The requested plan no longer exists — reject the request"), { code: 400 })
    // the REAL owner changePlan handler: events + price snapshot + entitlement
    // invalidation + saasAudit, exactly like an owner-console change (composed,
    // never forked — same pattern as owner.subscriptions.cycle)
    const out = (await ownerRoutes["owner.subscriptions.changePlan"].handler(ctx, {
      id: req.vendorId,
      planId: plan.id,
      note: p.note || `Plan-change request approved (requested by ${req.requestedByName || "tenant"})`,
    })) as { planName: string; billingCycle: string; endDate: Date }
    const updated = await db.saasPlanChangeRequest.update({
      where: { id: req.id },
      data: { status: "APPROVED", decidedById: ctx.ownerId, decidedByName: ctx.name, decidedAt: new Date(), decisionNote: p.note || null },
    })
    await saasAudit(ctx, "PLAN_REQUEST_APPROVED", "SaasPlanChangeRequest", req.id,
      `Approved tenant plan-change request: ${out.planName || plan.name} (${out.billingCycle}) for tenant ${req.vendorId} — requested by ${req.requestedByName || "tenant"}`,
      { vendorId: req.vendorId, metadata: { mode: req.mode, plan: plan.name } })
    return { status: updated.status, planName: out.planName, billingCycle: out.billingCycle, endDate: out.endDate }
  },
})

ownerAction("owner.planchangerequests.reject", {
  perm: "subscriptions.manage",
  schema: z.object({ id: z.string().min(1), reason: z.string().trim().min(3).max(500) }).strict(),
  handler: async (ctx, p) => {
    const req = await db.saasPlanChangeRequest.findUnique({ where: { id: p.id } })
    if (!req) throw Object.assign(new Error("Request not found"), { code: 404 })
    if (req.status !== "PENDING") throw Object.assign(new Error(`This request was already ${req.status.toLowerCase()} — no double decisions`), { code: 400 })
    const updated = await db.saasPlanChangeRequest.update({
      where: { id: req.id },
      data: { status: "REJECTED", decidedById: ctx.ownerId, decidedByName: ctx.name, decidedAt: new Date(), decisionNote: p.reason },
    })
    await saasAudit(ctx, "PLAN_REQUEST_REJECTED", "SaasPlanChangeRequest", req.id,
      `Rejected tenant plan-change request for tenant ${req.vendorId}. Reason: ${p.reason.slice(0, 300)}`,
      { vendorId: req.vendorId, metadata: { reason: p.reason } })
    return { status: updated.status }
  },
})

// ============================ WAVE 4 SG-C — ANALYTICS + DUNNING ============================
// Cross-tenant platform analytics (the console's /owner/analytics page) and the
// manual dunning action. Platform plane BY DESIGN — the owner console exists
// to see across tenants; H-10 vendor scoping applies to tenant routes only.
// Every query is bounded (take caps / count aggregations).

ownerAction("owner.analytics.overview", {
  perm: "tenants.view",
  handler: async () => {
    const now = new Date()
    const DAY_MS = 86_400_000

    // ---- tenant + subscription counts (single-row count aggregations) ----
    const [total, active, trial, pastDue, suspended, expired] = await Promise.all([
      db.vendor.count(),
      db.vendor.count({ where: { active: true } }),
      db.saasSubscription.count({ where: { status: "TRIAL" } }),
      db.saasSubscription.count({ where: { status: "PAST_DUE" } }),
      db.saasSubscription.count({ where: { status: "SUSPENDED" } }),
      db.saasSubscription.count({ where: { status: "EXPIRED" } }),
    ])

    // ---- plan distribution + MRR (OPS-7, Phase 3 WS-A: SQL aggregates) ----
    // subscribers = ACTIVE/TRIAL subscriptions joined onto SaasPlan (the two
    // statuses that represent a live relationship; legacy tenants without a
    // subscription row are counted under tenants.total, not under a plan).
    // The pre-Phase-3 code read subscriptions with take: 500 — MRR was silently
    // WRONG beyond 500 subscriptions at the 100K-tenant goal. The SUM now runs
    // in the database over the ENTIRE operating set.
    const [plans, subsByPlanRows, mrrRows] = await Promise.all([
      db.saasPlan.findMany({
        where: { active: true },
        select: { id: true, name: true, monthlyPrice: true, currency: true },
        orderBy: { monthlyPrice: "asc" },
        take: 50,
      }),
      db.saasSubscription.groupBy({
        by: ["planId"],
        where: { status: { in: ["ACTIVE", "TRIAL"] } },
        _count: { _all: true },
      }),
      db.$queryRaw<Array<{ mrr: number; actives: number }>>`
        SELECT
          COALESCE(SUM(CASE WHEN "status" = 'ACTIVE' AND "billingCycle" = 'YEARLY'
                THEN "priceAtCreation" / 12.0
                WHEN "status" = 'ACTIVE' THEN "priceAtCreation"
                ELSE 0 END), 0)::float8 AS mrr,
          COUNT(*) FILTER (WHERE "status" = 'ACTIVE')::int AS actives
        FROM "SaaSSubscription"
        WHERE "status" IN ('ACTIVE', 'TRIAL')`,
    ])
    const subsByPlan = new Map(subsByPlanRows.map((r) => [r.planId, Number(r._count?._all || 0)]))
    // MRR monthly normalization (SIMPLIFICATION, documented): every ACTIVE
    // subscription contributes its priceAtCreation snapshot per cycle, with
    // YEARLY cycles divided by 12 — the schema defines no separate cycle
    // multiplier field, so the 12 divisor IS the cycle multiplier (the same
    // methodology owner.dashboard.overview uses; TRIAL rows are excluded
    // because a trial is not yet paying).
    const mrrAmount = Number(mrrRows[0]?.mrr || 0)
    const activeSubscriptions = Number(mrrRows[0]?.actives || 0)

    // ---- signup trend: last 12 calendar months from vendor.createdAt ----
    // (OPS-7: was take: 500 over the raw rows — silently capped; now a
    // SQL month-bucketed GROUP BY over the whole window)
    const trendStart = new Date(now.getFullYear(), now.getMonth() - 11, 1)
    const trendRows = await db.$queryRaw<Array<{ m: Date; c: number }>>`
      SELECT date_trunc('month', "createdAt") AS m, COUNT(*)::int AS c
      FROM "Vendor" WHERE "createdAt" >= ${trendStart} GROUP BY 1`
    const trendByMonth = new Map<string, number>()
    for (const r of trendRows) trendByMonth.set(new Date(r.m).toISOString().slice(0, 7), Number(r.c || 0))
    const signupTrend: { month: string; vendors: number }[] = []
    for (let i = 11; i >= 0; i--) {
      const start = new Date(now.getFullYear(), now.getMonth() - i, 1)
      signupTrend.push({
        month: `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, "0")}`,
        vendors: trendByMonth.get(`${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, "0")}`) || 0,
      })
    }

    // ---- churn risk ----
    // past-due subs: PAST_DUE plus GRACE_PERIOD (the negotiated last stop
    // before expiry — the highest-churn window); status is shown per row.
    const pastDueSubRows = await db.saasSubscription.findMany({
      where: { status: { in: ["PAST_DUE", "GRACE_PERIOD"] } },
      orderBy: { endDate: "asc" },
      take: 50,
      include: { vendor: { select: { name: true } } },
    })
    // failed payments in the last 30 days (status FAILED — the only FAILED-ish
    // value in the SaaSPayment enum PENDING|PAID|FAILED|REFUNDED); failedAt is
    // the row's createdAt (the recorded attempt time).
    const failedRows = await db.saasPayment.findMany({
      where: { status: "FAILED", createdAt: { gte: new Date(now.getTime() - 30 * DAY_MS) } },
      orderBy: { createdAt: "desc" },
      take: 50,
      select: { vendorId: true, invoiceId: true, amount: true, method: true, provider: true, createdAt: true },
    })
    const failedInvoiceIds = [...new Set(failedRows.map((f) => f.invoiceId))]
    const failedInvoices = failedInvoiceIds.length
      ? await db.saasInvoice.findMany({ where: { id: { in: failedInvoiceIds } }, select: { id: true, number: true } })
      : []
    // vendor-name join (SaasPayment carries vendorId but no Vendor relation)
    const churnVendorIds = [...new Set([...pastDueSubRows.map((s) => s.vendorId), ...failedRows.map((f) => f.vendorId)])]
    const churnVendors = churnVendorIds.length
      ? await db.vendor.findMany({ where: { id: { in: churnVendorIds } }, select: { id: true, name: true } })
      : []
    const churnNameOf = new Map(churnVendors.map((v) => [v.id, v.name]))
    // idle tenants (OPS-7, Phase 3 WS-A): ONE grouped SQL query with the
    // cutoff + LIMIT in the database — the old path loaded EVERY vendor plus a
    // groupBy over all audit rows and filtered/sorted in JS.
    const idleCutoff = new Date(now.getTime() - 14 * DAY_MS)
    const idleRows = await db.$queryRaw<Array<{ vendorName: string; lastActivityAt: Date | null }>>`
      SELECT v."name" AS "vendorName", MAX(a."createdAt") AS "lastActivityAt"
      FROM "Vendor" v
      LEFT JOIN "SaaSAuditLog" a ON a."vendorId" = v."id"
      GROUP BY v."id", v."name"
      HAVING MAX(a."createdAt") IS NULL OR MAX(a."createdAt") < ${idleCutoff}
      ORDER BY "lastActivityAt" ASC NULLS FIRST
      LIMIT 20`
    const idleTenants14d = idleRows.map((r) => ({ vendorName: r.vendorName, lastActivityAt: r.lastActivityAt || null }))

    // ---- dunning queue: PENDING invoices past due, oldest first ----
    const overdueInvoices = await db.saasInvoice.findMany({
      where: { status: "PENDING", dueAt: { lt: now } },
      orderBy: { dueAt: "asc" },
      take: 50,
      select: { id: true, vendorId: true, number: true, amount: true, currency: true, dueAt: true },
    })
    // reminder counters live ONLY in SaaSSetting group "dunning" (invoice
    // history is never mutated) — read them all in one query
    const dunningSettings = await db.saasSetting.findMany({ where: { group: "dunning", key: { startsWith: "inv:" } } })
    const reminderOf = new Map<string, { lastSent: string; sent: number }>()
    for (const r of dunningSettings) {
      try {
        const v = JSON.parse(r.value) as { lastSent?: unknown; sent?: unknown }
        if (v && typeof v === "object" && typeof v.lastSent === "string") {
          reminderOf.set(r.key.slice(4), { lastSent: v.lastSent, sent: Number(v.sent) || 0 })
        }
      } catch { /* corrupt row — treated as never reminded */ }
    }
    const dunningVendorIds = [...new Set(overdueInvoices.map((i) => i.vendorId))]
    const dunningVendors = dunningVendorIds.length
      ? await db.vendor.findMany({ where: { id: { in: dunningVendorIds } }, select: { id: true, name: true } })
      : []
    const dunningNameOf = new Map(dunningVendors.map((v) => [v.id, v.name]))

    return {
      tenants: { total, active, trial, pastDue, suspended, expired },
      activeSubscriptions,
      plans: plans.map((p) => ({
        planId: p.id,
        name: p.name,
        price: Number(p.monthlyPrice) || 0,
        currency: p.currency,
        subscribers: subsByPlan.get(p.id) || 0,
      })),
      mrr: { amount: Number(mrrAmount.toFixed(2)), currency: "BDT" },
      signupTrend,
      churnRisk: {
        pastDueSubs: pastDueSubRows.map((s) => ({
          vendorName: s.vendor.name,
          planName: s.planName,
          status: s.status,
          cycleEndDate: s.endDate,
        })),
        failedPayments30d: failedRows.map((f) => ({
          vendorName: churnNameOf.get(f.vendorId) || f.vendorId,
          invoiceNumber: failedInvoices.find((i) => i.id === f.invoiceId)?.number || "—",
          amount: Number(f.amount) || 0,
          method: f.method || f.provider,
          failedAt: f.createdAt,
        })),
        idleTenants14d,
      },
      dunningQueue: overdueInvoices.map((inv) => {
        const st = reminderOf.get(inv.id)
        return {
          invoiceId: inv.id,
          invoiceNumber: inv.number,
          vendorName: dunningNameOf.get(inv.vendorId) || inv.vendorId,
          amount: Number(inv.amount) || 0,
          currency: inv.currency,
          dueAt: inv.dueAt,
          daysOverdue: inv.dueAt ? Math.max(0, Math.floor((now.getTime() - inv.dueAt.getTime()) / DAY_MS)) : 0,
          remindersSent: st?.sent || 0,
          lastReminderAt: st?.lastSent || null,
        }
      }),
      generatedAt: now.toISOString(),
    }
  },
})

ownerAction("owner.dunning.remind", {
  perm: "billing.manage",
  schema: z.object({ invoiceId: z.string().min(1) }).strict(),
  handler: async (ctx, p) => {
    // dynamic import keeps this append-only section free of import-block edits
    // (dunning.ts imports notify/audit/settings — no cycle with owner-routes)
    const { sendReminderNow } = await import("./dunning")
    const res = await sendReminderNow(String(p.invoiceId), ctx.name)
    await saasAudit(ctx, "OWNER_DUNNING_REMIND", "SaasInvoice", res.invoiceId,
      `Manual overdue reminder for invoice ${res.invoiceNumber} → ${res.recipients.length} recipient(s): ${res.status}${res.detail ? ` (${res.detail.slice(0, 200)})` : ""}`,
      {
        metadata: {
          invoiceNumber: res.invoiceNumber, status: res.status,
          sent: res.sent, skipped: res.skipped, failed: res.failed,
          remindersSent: res.remindersSent, daysOverdue: res.daysOverdue,
        },
      })
    return res
  },
})

// ============================ OBSERVABILITY (Phase 5 P0) ============================
// Performance panel source — the in-memory RPC rings + scheduler-tick stats
// the /api/metrics Prometheus endpoint already exposes. Read-only, zero DB
// queries (the rings live in process memory; queue gauges stay on the
// Prometheus endpoint where they are TTL-cached).
ownerAction("owner.metrics.snapshot", {
  perm: "health.view",
  handler: async () => {
    const { snapshotForOwner } = await import("../metrics")
    return snapshotForOwner()
  },
})

// Alert-routing test send — exercises the EXACT same signed-POST path a real
// backup-failure alert takes (SSRF guard, HMAC signature, redirect refusal).
ownerAction("owner.alerts.testWebhook", {
  perm: "health.manage",
  handler: async (ctx) => {
    const { sendPlatformAlertWebhook } = await import("./notify")
    const res = await sendPlatformAlertWebhook(
      "ALERT_TEST",
      "Finix HR — test alert",
      `This is a test alert webhook fired by ${ctx.name} from the owner console Alert Routing settings. If you can read this, alert routing is configured correctly.`,
    )
    await saasAudit(ctx, "ALERT_WEBHOOK_TEST", "SaasSetting", null,
      `Test alert webhook → ${res.status}${res.detail ? `: ${res.detail.slice(0, 200)}` : ""}`, { metadata: { status: res.status } })
    return res
  },
})

// convenience export so the owner console can render role labels without duplicating
export { OWNER_ROLE_LABELS, OWNER_ROLE_TEMPLATES }

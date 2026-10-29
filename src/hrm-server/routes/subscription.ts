// ============ Tenant-side subscription surface (the customer's own view) ============
// Served to logged-in tenant users on /app → Subscription. Read-only by
// design: plan changes go through the platform owner (or a future automated
// payment flow). Also exposes the tenant's SAFE usage snapshot.
import { db } from "@/lib/db"
import { route } from "./registry"
import { resolveEntitlements, usageSnapshot } from "../saas/entitlements"
import { j } from "../utils"

route("subscription.overview", {
  // 2026-10-07 — gated by the `subscription.view` permission (HR Settings →
  // Roles & Permissions → Subscription & Usage). Management roles hold it by
  // default; the Employee (Self-Service) role does not. Data is still only
  // the platform's own records for the caller's vendorId (server-resolved).
  perm: ["subscription", "view"],
  handler: async (ctx) => {
    const [sub, ent, usage] = await Promise.all([
      db.saasSubscription.findUnique({
        where: { vendorId: ctx.vendorId },
        include: {
          plan: true,
          events: { orderBy: { createdAt: "desc" as const }, take: 25 },
        },
      }),
      resolveEntitlements(ctx.vendorId),
      usageSnapshot(ctx.vendorId),
    ])
    return {
      mode: ent.mode,
      status: ent.status,
      planName: sub?.planName ?? null,
      planId: sub?.planId ?? null,
      billingCycle: sub?.billingCycle ?? null,
      startDate: sub?.startDate ?? null,
      endDate: sub?.endDate ?? null,
      daysRemaining: ent.daysRemaining,
      price: sub ? Number(sub.priceAtCreation) : null,
      currency: sub?.currencySnapshot ?? null,
      readonly: ent.readonly,
      features: ent.mode === "SUBSCRIBED" ? ent.features : null,
      limits: ent.mode === "SUBSCRIBED" ? ent.limits : null,
      usage,
      history: sub
        ? sub.events.map((e: any) => ({
            id: e.id, type: e.type, note: e.note,
            actorName: e.actorName, createdAt: e.createdAt,
            to: j(e.toSnapshot, {}),
          }))
        : [],
    }
  },
})

// ================= WP-C (2026-10-08) — live usage vs plan limits ============
// Per-limit {used, limit, pct, status} rows for the UsagePanel (Billing page,
// Subscription & Usage view, plan-usage dashboard widget — ONE data source).
// status: ok | warning (≥80%) | danger (≥95%) | over (usage > limit).
// LEGACY tenants: every limit reports unlimited (null) — the panel hides bars.
route("subscription.usage", {
  perm: ["subscription", "view"],
  handler: async (ctx) => {
    const [ent, usage] = await Promise.all([
      resolveEntitlements(ctx.vendorId),
      usageSnapshot(ctx.vendorId),
    ])
    const limits = ent.mode === "SUBSCRIBED" ? ent.limits : {}
    const usedOf: Record<string, number> = {
      EMPLOYEES: usage.employees,
      USERS: usage.users,
      BRANCHES: usage.branches,
      DEPARTMENTS: usage.departments,
      DEVICES: usage.devices,
      TRACKING_EMPLOYEES: usage.trackingEmployees,
      // R14 (2026-10-12) — STORAGE used is in BYTES (storageUsedBytes) while
      // the plan limit is in GB: the old pct math divided bytes by GB,
      // producing astronomically wrong percentages (e.g. 2MB used / 5GB cap
      // → 40000%) and a permanent "over limit" callout. Normalize both sides
      // to BYTES here; the UsagePanel formats MB/GB for display.
      STORAGE: usage.storageUsedBytes,
    }
    const rows = (Object.keys(usedOf) as (keyof typeof usedOf)[]).map((key) => {
      const limit = (limits as Record<string, number | null | undefined>)[key] ?? null
      const used = usedOf[key]
      const limitBytes = key === "STORAGE" && limit != null ? limit * 1024 * 1024 * 1024 : limit
      const pct = limitBytes == null ? null : Math.round((used / Math.max(1, limitBytes)) * 100)
      const status = limitBytes == null ? "unlimited" : used > limitBytes ? "over" : pct != null && pct >= 95 ? "danger" : pct != null && pct >= 80 ? "warning" : "ok"
      return {
        key,
        used,
        limit, // STORAGE: GB (plan unit); everything else: count. null = unlimited
        limitBytes: key === "STORAGE" ? limitBytes : limit,
        pct, // null when unlimited
        status,
        unit: key === "STORAGE" ? "GB" : "count",
      }
    })
    // The single most-constrained limit surfaces as the contextual callout
    // ("You are using 82% of your employee limit.").
    const tightest = rows
      .filter((r) => r.pct != null)
      .sort((a, b) => (b.pct ?? 0) - (a.pct ?? 0))[0] ?? null
    // R14 — human-readable storage amounts (MB under 1GB, GB above).
    const fmtLimitLabel = (r: (typeof rows)[number]): string =>
      r.key === "STORAGE"
        ? r.limit == null ? "unlimited" : r.limit >= 1 ? `${r.limit} GB` : `${Math.round(r.limit * 1024)} MB`
        : `${r.limit?.toLocaleString() ?? "unlimited"}`
    const fmtUsedLabel = (r: (typeof rows)[number]): string =>
      r.key === "STORAGE"
        ? r.used >= 1024 ** 3 ? `${(r.used / 1024 ** 3).toFixed(2)} GB` : `${(r.used / 1024 ** 2).toFixed(1)} MB`
        : r.used.toLocaleString()
    return {
      mode: ent.mode,
      planName: ent.planName,
      rows,
      callout: tightest && tightest.status !== "ok"
        ? {
            key: tightest.key,
            pct: tightest.pct,
            status: tightest.status,
            message: tightest.status === "over"
              ? `You are OVER your ${tightest.key === "STORAGE" ? "storage" : tightest.key.toLowerCase()} limit (${fmtUsedLabel(tightest)} of ${fmtLimitLabel(tightest)}). New records of this type are blocked until you upgrade.`
              : `You are using ${tightest.pct}% of your ${tightest.key === "STORAGE" ? "storage" : tightest.key.toLowerCase()} limit.`,
          }
        : null,
    }
  },
})

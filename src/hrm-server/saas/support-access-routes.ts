// ============ Wave 10 (2026-10-24) — Support Access owner-console routes ============
// Self-registering ownerAction() module (same side-effect pattern as
// cms-routes.ts / health.ts — pulled into /api/owner's module graph by one
// import line). All actions are permission-gated by the dispatcher:
//   - support.access  : start a session, view ACTIVE sessions, end OWN session
//   - support.manage  : revoke ANY session, edit the platform policy
// CONTROLLED_WRITE additionally requires support.manage at START time — the
// "additional approval for sensitive access" control (master prompt §2.1).
//
// The enter URL (one-time, 60s capability) is returned ONCE by
// owner.supportAccess.start and never persisted in plaintext — only its
// sha256 hash lives on the session row.
import { z } from "zod"
import { db } from "@/lib/db"
import { ownerAction } from "./owner-routes"
import { saasAudit } from "./audit"
import { ownerRequire, type OwnerCtx } from "./owner-auth"
import {
  startSupportSession, endSupportSession, getSupportAccessPolicy, saveSupportAccessPolicy,
  SUPPORT_WRITE_CATALOG,
} from "./support-access"

/** Label map for the console UI. */
export const SUPPORT_WRITE_CATALOG_LIST = Array.from(SUPPORT_WRITE_CATALOG).sort()

function actorOf(ctx: OwnerCtx) {
  return { id: ctx.ownerId, name: ctx.name, ip: ctx.ip }
}

// ---- tenant picker (id + name + active only — the console already has a
//      full tenants.list under tenants.view; this slim action lets support
//      operators with ONLY support.access start sessions without gaining the
//      whole tenant census) ----
ownerAction("owner.supportAccess.tenants", {
  perm: "support.access",
  schema: z.object({
    search: z.string().trim().max(120).optional(),
  }).strict(),
  handler: async (_ctx, p) => {
    const search = (p.search || "").trim()
    const rows = await db.vendor.findMany({
      where: search
        ? { OR: [{ name: { contains: search, mode: "insensitive" } }, { code: { contains: search, mode: "insensitive" } }] }
        : {},
      select: { id: true, name: true, code: true, active: true },
      orderBy: { name: "asc" },
      take: 50,
    })
    return { tenants: rows.map((r) => ({ id: r.id, name: r.name, code: r.code, active: r.active })) }
  },
})

// ---- policy + catalog read (drives the start form) ----
ownerAction("owner.supportAccess.policy", {
  perm: "support.access",
  handler: async () => {
    return {
      policy: await getSupportAccessPolicy(),
      writeCatalog: SUPPORT_WRITE_CATALOG_LIST,
      canManage: true, // the dispatcher already required support.access; the
      // console merges the caller's actual permission set client-side
    }
  },
})

// ---- start a support session (authorization + one-time enter capability) ----
ownerAction("owner.supportAccess.start", {
  perm: "support.access",
  schema: z.object({
    vendorId: z.string().trim().min(1).max(40),
    reason: z.string().trim().min(10).max(500),
    ticketRef: z.string().trim().max(80).optional(),
    accessMode: z.enum(["READ_ONLY", "CONTROLLED_WRITE"]),
    minutes: z.number().int().min(5).max(240).optional(),
    scope: z.array(z.string().trim().max(60)).max(20).optional(),
  }).strict(),
  handler: async (ctx, p) => {
    // sensitive-access approval: controlled write needs BOTH permissions
    if (p.accessMode === "CONTROLLED_WRITE") {
      ownerRequire(ctx, "support.manage")
    }
    const res = await startSupportSession(
      { ...actorOf(ctx), roleKey: ctx.roleKey },
      {
        vendorId: p.vendorId,
        reason: p.reason,
        ticketRef: p.ticketRef || null,
        accessMode: p.accessMode,
        minutes: p.minutes,
        scope: p.scope || [],
      },
    )
    if (!res.ok) {
      throw Object.assign(new Error(res.error), { code: res.code })
    }
    return {
      sessionId: res.sessionId,
      // ONE-TIME capability: shown once, valid 60 seconds, operator-bound.
      enterUrl: res.enterUrl,
      expiresAt: res.expiresAt.toISOString(),
    }
  },
})

// ---- live session board ----
ownerAction("owner.supportAccess.active", {
  perm: "support.access",
  handler: async (ctx) => {
    const rows = await db.saasSupportAccessSession.findMany({
      where: { status: "ACTIVE", expiresAt: { gt: new Date() } },
      orderBy: { startedAt: "desc" },
      take: 50,
      select: {
        id: true, targetVendorId: true, targetVendorName: true, operatorOwnerId: true,
        operatorName: true, accessMode: true, reason: true, ticketRef: true,
        startedAt: true, expiresAt: true, lastSeenAt: true, ip: true,
      },
    })
    const now = Date.now()
    return {
      sessions: rows.map((r) => ({
        ...r,
        remainingSeconds: Math.max(0, Math.floor(((r.expiresAt as Date).getTime() - now) / 1000)),
        mine: r.operatorOwnerId === ctx.ownerId,
      })),
    }
  },
})

// ---- end a session (own = support.access; anyone else's = support.manage) ----
ownerAction("owner.supportAccess.end", {
  perm: "support.access",
  schema: z.object({
    sessionId: z.string().trim().min(1).max(40),
    reason: z.string().trim().max(200).optional(),
  }).strict(),
  handler: async (ctx, p) => {
    const row = await db.saasSupportAccessSession.findUnique({ where: { id: p.sessionId } })
    if (!row) throw Object.assign(new Error("Support session not found."), { code: 404 })
    if (row.operatorOwnerId !== ctx.ownerId) {
      ownerRequire(ctx, "support.manage")
    }
    const res = await endSupportSession(
      row.id, actorOf(ctx), row.operatorOwnerId === ctx.ownerId ? "ENDED" : "REVOKED",
      p.reason || (row.operatorOwnerId === ctx.ownerId ? "operator exit (console)" : "revoked by administrator"),
    )
    if (!res.ended) throw Object.assign(new Error("The session is no longer active."), { code: 409 })
    return { ended: true }
  },
})

// ---- history with filters (tenant / operator / status / date / reason) ----
ownerAction("owner.supportAccess.history", {
  perm: "support.access",
  schema: z.object({
    page: z.number().int().min(1).default(1),
    pageSize: z.number().int().min(1).max(100).default(25),
    vendorId: z.string().trim().max(40).optional(),
    operatorOwnerId: z.string().trim().max(40).optional(),
    status: z.enum(["PENDING", "ACTIVE", "ENDED", "EXPIRED", "REVOKED"]).optional(),
    since: z.string().trim().max(30).optional(), // ISO date
    until: z.string().trim().max(30).optional(), // ISO date
    search: z.string().trim().max(120).optional(), // free text over reason / ticket
  }).strict(),
  handler: async (_ctx, p) => {
    const where: Record<string, unknown> = {}
    if (p.vendorId) where.targetVendorId = p.vendorId
    if (p.operatorOwnerId) where.operatorOwnerId = p.operatorOwnerId
    if (p.status) where.status = p.status
    if (p.since || p.until) {
      where.createdAt = {
        ...(p.since ? { gte: new Date(p.since) } : {}),
        ...(p.until ? { lte: new Date(p.until) } : {}),
      }
    }
    if (p.search) {
      where.OR = [
        { reason: { contains: p.search, mode: "insensitive" } },
        { ticketRef: { contains: p.search, mode: "insensitive" } },
        { targetVendorName: { contains: p.search, mode: "insensitive" } },
        { operatorName: { contains: p.search, mode: "insensitive" } },
      ]
    }
    const [rows, total] = await Promise.all([
      db.saasSupportAccessSession.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (p.page - 1) * p.pageSize,
        take: p.pageSize,
        select: {
          id: true, targetVendorId: true, targetVendorName: true, operatorOwnerId: true,
          operatorName: true, accessMode: true, status: true, reason: true, ticketRef: true,
          scopeJson: true, requestedMinutes: true, startedAt: true, expiresAt: true,
          endedAt: true, endedReason: true, endedByName: true, ip: true, createdAt: true,
        },
      }),
      db.saasSupportAccessSession.count({ where }),
    ])
    return {
      sessions: rows.map((r) => ({ ...r, scope: (() => { try { return JSON.parse(r.scopeJson || "[]") } catch { return [] } })() })),
      total,
      page: p.page,
      pageSize: p.pageSize,
    }
  },
})

// ---- platform policy editor (support.manage) ----
ownerAction("owner.supportAccess.savePolicy", {
  perm: "support.manage",
  schema: z.object({
    enabled: z.boolean().optional(),
    defaultMinutes: z.number().int().min(5).max(240).optional(),
    maxMinutes: z.number().int().min(15).max(240).optional(),
    requireTicketForWrite: z.boolean().optional(),
    maxConcurrentActive: z.number().int().min(1).max(100).optional(),
  }).strict(),
  handler: async (ctx, p) => {
    const before = await getSupportAccessPolicy()
    await saveSupportAccessPolicy(p)
    const after = await getSupportAccessPolicy()
    await saasAudit(actorOf(ctx), "SUPPORT_ACCESS_POLICY_CHANGED", "SaaSSetting", null,
      `Support-access policy updated (default ${after.defaultMinutes} min, max ${after.maxMinutes} min, enabled: ${after.enabled ? "yes" : "no"})`,
      { metadata: { before, after } })
    return { policy: after }
  },
})

// ---- summary for the console header / health snapshot ----
ownerAction("owner.supportAccess.overview", {
  perm: "support.access",
  handler: async () => {
    const now = new Date()
    const [active, todayStarted, todayDenied, last24] = await Promise.all([
      db.saasSupportAccessSession.count({ where: { status: "ACTIVE", expiresAt: { gt: now } } }),
      db.saasSupportAccessSession.count({ where: { createdAt: { gte: new Date(now.getTime() - 86400000) } } }),
      db.saasAuditLog.count({ where: { action: "SUPPORT_ACCESS_DENIED", createdAt: { gte: new Date(now.getTime() - 86400000) } } }),
      db.saasSupportAccessSession.count({ where: { startedAt: { gte: new Date(now.getTime() - 86400000) } } }),
    ])
    return { active, startedLast24h: last24, sessionsCreatedLast24h: todayStarted, deniedLast24h: todayDenied }
  },
})

// ============ 2026-10-25 — Support Center owner-console routes (Part A §3.1) =
// Self-registering ownerAction() module: the SUPPORT side of the ticket chat
// + the Live Support Access review queue (Part B §4.1).
//   - support.view   : read tickets, reply, assign, set status
//   - support.manage : approve/reject live-support requests (privileged access
//                      review), close/reopen any ticket
// Tenant isolation: every ticket read/write carries the vendorId scope from
// the ROW itself (support personnel are platform-plane actors); replies are
// attributed to the owner user with first-response tracking.
//
// RE-ENTRY (master prompt §5) needs NO owner action: the console renders a
// plain link to /api/support-access/resume?session=<id> — that endpoint
// authenticates the operator via the FULL owner session, validates status/
// expiry/binding server-side and rotates the token (see support-access.ts).
import { z } from "zod"
import { db } from "@/lib/db"
import { ownerAction } from "./owner-routes"
import { saasAudit } from "./audit"
import { ownerRequire, type OwnerCtx } from "./owner-auth"
import { approveLiveSupportRequest, rejectLiveSupportRequest } from "./support-access"
import { signedObjectUrl } from "./storage"
import { j } from "../utils"
import { notifyOwnerUsers } from "./notify"
import type { SaasAuditActor } from "./audit"

type AttachmentMeta = { objectKey: string; fileName: string; mimeType: string; sizeBytes: number; uploadedBy: string }

async function attachmentsWithUrls(attachmentsJson: string) {
  const list = j<AttachmentMeta[]>(attachmentsJson, [])
  if (!list.length) return []
  const out = []
  for (const a of list.slice(0, 10)) {
    out.push({ ...a, url: await signedObjectUrl(a.objectKey, 900) })
  }
  return out
}

/** Notify the tenant that support replied (best-effort; journaled). */
async function notifyTenantReply(vendorId: string, ticketNumber: string, subject: string) {
  try {
    const admins = await db.user.findMany({
      where: { vendorId, role: "VENDOR_OWNER", status: "ACTIVE" },
      select: { email: true, name: true },
      take: 5,
    })
    if (!admins.length) return
    const { sendPlatformEmail } = await import("./notify")
    for (const a of admins) {
      await sendPlatformEmail(a.email, `Finix HR Support replied — ticket ${ticketNumber}`,
        `Hello ${a.name},\n\nThe Finix HR support team replied on ticket ${ticketNumber} ("${subject}").\nOpen your workspace → Support to read the message and continue the conversation.\n\n— Finix HR Support`)
    }
  } catch { /* notification failures never block the reply */ }
}

// ---------------- ticket queue ----------------

ownerAction("owner.supportTickets.list", {
  perm: "support.view",
  schema: z.object({
    status: z.string().trim().max(30).default("ALL"),
    priority: z.string().trim().max(20).default("ALL"),
    search: z.string().trim().max(120).optional(),
    vendorId: z.string().trim().max(40).optional(),
    page: z.number().int().min(1).max(500).default(1),
    take: z.number().int().min(10).max(100).default(25),
  }).strict(),
  handler: async (_ctx, p) => {
    const where = {
      ...(p.status !== "ALL" ? { status: p.status } : {}),
      ...(p.priority !== "ALL" ? { priority: p.priority } : {}),
      ...(p.vendorId ? { vendorId: p.vendorId } : {}),
      ...(p.search
        ? {
            OR: [
              { subject: { contains: p.search, mode: "insensitive" as const } },
              { number: { contains: p.search, mode: "insensitive" as const } },
              { requesterName: { contains: p.search, mode: "insensitive" as const } },
            ],
          }
        : {}),
    }
    const [rows, total] = await Promise.all([
      db.saasSupportTicket.findMany({
        where,
        orderBy: [{ status: "asc" }, { updatedAt: "desc" }],
        skip: (p.page - 1) * p.take,
        take: p.take,
      }),
      db.saasSupportTicket.count({ where }),
    ])
    return {
      rows: rows.map((t) => ({
        id: t.id, number: t.number, vendorId: t.vendorId, subject: t.subject,
        category: t.category, priority: t.priority, status: t.status,
        requesterName: t.requesterName, assigneeName: t.assigneeName,
        assigneeOwnerId: t.assigneeOwnerId,
        lastMessageAt: t.lastMessageAt, firstResponseAt: t.firstResponseAt,
        createdAt: t.createdAt, closedAt: t.closedAt,
      })),
      total, page: p.page, take: p.take,
    }
  },
})

ownerAction("owner.supportTickets.get", {
  perm: "support.view",
  schema: z.object({ ticketId: z.string().trim().min(1).max(40) }).strict(),
  handler: async (_ctx, p) => {
    const t = await db.saasSupportTicket.findUnique({ where: { id: p.ticketId } })
    if (!t) throw Object.assign(new Error("Ticket not found"), { code: 404 })
    const vendor = await db.vendor.findUnique({ where: { id: t.vendorId }, select: { name: true, code: true } })
    const messages = await db.saasSupportMessage.findMany({
      where: { ticketId: t.id },
      orderBy: { createdAt: "asc" },
      take: 300,
    })
    // mark tenant messages read by support
    const unread = messages.filter((m) => m.authorRole === "TENANT" && !m.readBySupportAt)
    if (unread.length) {
      await db.saasSupportMessage.updateMany({
        where: { id: { in: unread.map((m) => m.id) } },
        data: { readBySupportAt: new Date() },
      })
    }
    return {
      ticket: {
        id: t.id, number: t.number, subject: t.subject, category: t.category,
        priority: t.priority, status: t.status, vendorId: t.vendorId,
        vendorName: vendor?.name || t.vendorId, vendorCode: vendor?.code || null,
        requesterName: t.requesterName, assigneeName: t.assigneeName,
        assigneeOwnerId: t.assigneeOwnerId, firstResponseAt: t.firstResponseAt,
        createdAt: t.createdAt, closedAt: t.closedAt, closedByName: t.closedByName,
      },
      messages: await Promise.all(messages.map(async (m) => ({
        id: m.id, authorRole: m.authorRole, authorName: m.authorName,
        body: m.body, internalNote: m.internalNote, createdAt: m.createdAt,
        attachments: await attachmentsWithUrls(m.attachmentsJson),
      }))),
    }
  },
})

ownerAction("owner.supportTickets.reply", {
  perm: "support.view",
  schema: z.object({
    ticketId: z.string().trim().min(1).max(40),
    message: z.string().trim().min(1).max(5000),
    internalNote: z.boolean().default(false),
  }).strict(),
  handler: async (ctx: OwnerCtx, p) => {
    const t = await db.saasSupportTicket.findUnique({ where: { id: p.ticketId } })
    if (!t) throw Object.assign(new Error("Ticket not found"), { code: 404 })
    if (t.status === "CLOSED") throw Object.assign(new Error("This ticket is closed — reopen it before replying."), { code: 400 })
    const now = new Date()
    const msg = await db.saasSupportMessage.create({
      data: {
        ticketId: t.id,
        authorRole: "SUPPORT",
        authorId: ctx.ownerId,
        authorName: ctx.name,
        body: p.message,
        internalNote: p.internalNote,
        readBySupportAt: now,
      },
    })
    // first response tracking + status transitions
    const patch: Record<string, unknown> = { lastMessageAt: now }
    if (!t.firstResponseAt && !p.internalNote) patch.firstResponseAt = now
    if (!p.internalNote) {
      if (t.status === "OPEN") patch.status = "ASSIGNED"
      if (t.status === "WAITING_SUPPORT" || t.status === "ASSIGNED" || t.status === "IN_PROGRESS") patch.status = "WAITING_TENANT"
    }
    if (!t.assigneeOwnerId && !p.internalNote) {
      patch.assigneeOwnerId = ctx.ownerId
      patch.assigneeName = ctx.name
    }
    await db.saasSupportTicket.update({ where: { id: t.id }, data: patch })
    if (!p.internalNote) await notifyTenantReply(t.vendorId, t.number, t.subject)
    await saasAudit(ctx as SaasAuditActor, "SUPPORT_TICKET_REPLIED", "SaasSupportTicket", t.id,
      `Support replied on ticket ${t.number}${p.internalNote ? " (internal note)" : ""}`,
      { vendorId: t.vendorId })
    return { messageId: msg.id, status: patch.status || t.status }
  },
})

ownerAction("owner.supportTickets.assign", {
  perm: "support.view",
  schema: z.object({
    ticketId: z.string().trim().min(1).max(40),
    agentOwnerId: z.string().trim().min(1).max(40),
    agentName: z.string().trim().min(1).max(120),
  }).strict(),
  handler: async (ctx: OwnerCtx, p) => {
    const t = await db.saasSupportTicket.findUnique({ where: { id: p.ticketId } })
    if (!t) throw Object.assign(new Error("Ticket not found"), { code: 404 })
    await db.saasSupportTicket.update({
      where: { id: t.id },
      data: {
        assigneeOwnerId: p.agentOwnerId,
        assigneeName: p.agentName,
        ...(t.status === "OPEN" ? { status: "ASSIGNED" } : {}),
      },
    })
    await notifyOwnerUsers(
      `Support ticket ${t.number} assigned to you`,
      `Ticket ${t.number} ("${t.subject}") was assigned to you by ${ctx.name}.\nOpen the Owner Console → Support → Tickets.`,
      { userIds: [p.agentOwnerId] },
    ).catch(() => {})
    await saasAudit(ctx as SaasAuditActor, "SUPPORT_TICKET_ASSIGNED", "SaasSupportTicket", t.id,
      `Ticket ${t.number} assigned to ${p.agentName}`,
      { vendorId: t.vendorId })
    return { status: t.status === "OPEN" ? "ASSIGNED" : t.status }
  },
})

ownerAction("owner.supportTickets.status", {
  perm: "support.view",
  schema: z.object({
    ticketId: z.string().trim().min(1).max(40),
    status: z.enum(["OPEN", "ASSIGNED", "IN_PROGRESS", "WAITING_TENANT", "WAITING_SUPPORT", "RESOLVED", "CLOSED"]),
    note: z.string().trim().max(500).optional(),
  }).strict(),
  handler: async (ctx: OwnerCtx, p) => {
    const t = await db.saasSupportTicket.findUnique({ where: { id: p.ticketId } })
    if (!t) throw Object.assign(new Error("Ticket not found"), { code: 404 })
    await db.saasSupportTicket.update({
      where: { id: t.id },
      data: {
        status: p.status,
        ...(p.status === "CLOSED" ? { closedAt: new Date(), closedByName: `${ctx.name} (support)` } : {}),
        ...(p.status !== "CLOSED" ? { closedAt: null, closedByName: null } : {}),
      },
    })
    await saasAudit(ctx as SaasAuditActor, "SUPPORT_TICKET_STATUS", "SaasSupportTicket", t.id,
      `Ticket ${t.number}: ${t.status} → ${p.status}${p.note ? ` — ${p.note}` : ""}`,
      { vendorId: t.vendorId, metadata: { from: t.status, to: p.status } })
    return { status: p.status }
  },
})

// ---------------- Live Support Access review queue (Part B §4.1) ----------------

ownerAction("owner.supportLive.requests", {
  perm: "support.view",
  schema: z.object({
    status: z.string().trim().max(30).default("ALL"),
    page: z.number().int().min(1).max(500).default(1),
    take: z.number().int().min(10).max(100).default(25),
  }).strict(),
  handler: async (_ctx, p) => {
    const where = p.status !== "ALL" ? { status: p.status } : {}
    const [rows, total] = await Promise.all([
      db.saasLiveSupportRequest.findMany({
        where,
        orderBy: [{ status: "asc" }, { createdAt: "desc" }],
        skip: (p.page - 1) * p.take,
        take: p.take,
      }),
      db.saasLiveSupportRequest.count({ where }),
    ])
    const vendorIds = [...new Set(rows.map((r) => r.vendorId))]
    const vendors = vendorIds.length
      ? await db.vendor.findMany({ where: { id: { in: vendorIds } }, select: { id: true, name: true, code: true } })
      : []
    const sessions = rows.length
      ? await db.saasSupportAccessSession.findMany({
          where: { liveRequestId: { in: rows.map((r) => r.id) } },
          orderBy: { createdAt: "desc" },
        })
      : []
    return {
      rows: rows.map((r) => {
        const v = vendors.find((x) => x.id === r.vendorId)
        const session = sessions.find((s) => s.liveRequestId === r.id)
        return {
          id: r.id, title: r.title, description: r.description, category: r.category,
          modules: j<string[]>(r.modulesJson, []), priority: r.priority, status: r.status,
          contextNote: r.contextNote, ticketId: r.ticketId,
          vendorId: r.vendorId, vendorName: v?.name || r.vendorId, vendorCode: v?.code || null,
          requestedByName: r.requestedByName, requestedAt: r.requestedAt,
          reviewedByName: r.reviewedByName, reviewedAt: r.reviewedAt, reviewNote: r.reviewNote,
          approvedModules: r.approvedModulesJson ? j<string[]>(r.approvedModulesJson, []) : null,
          approvedMinutes: r.approvedMinutes,
          approvedAgentName: r.approvedAgentName, approvedAgentOwnerId: r.approvedAgentOwnerId,
          session: session
            ? {
                id: session.id, status: session.status, accessMode: session.accessMode,
                operatorName: session.operatorName, operatorOwnerId: session.operatorOwnerId,
                modules: j<string[]>(session.approvedModulesJson, []),
                startedAt: session.startedAt, expiresAt: session.expiresAt,
                enterPending: session.status === "PENDING" && !!session.enterExpiresAt && session.enterExpiresAt > new Date(),
                endedReason: session.endedReason,
              }
            : null,
        }
      }),
      total, page: p.page, take: p.take,
    }
  },
})

ownerAction("owner.supportLive.approve", {
  perm: "support.view",
  schema: z.object({
    requestId: z.string().trim().min(1).max(40),
    modules: z.array(z.string().trim().min(1).max(40)).min(1).max(20),
    minutes: z.number().int().min(5).max(240).optional(),
    accessMode: z.enum(["READ_ONLY", "CONTROLLED_WRITE"]).default("READ_ONLY"),
    agentOwnerId: z.string().trim().min(1).max(40),
    agentName: z.string().trim().min(1).max(120),
    note: z.string().trim().max(1000).optional(),
    origin: z.string().trim().max(300).optional(),
  }).strict(),
  handler: async (ctx: OwnerCtx, p) => {
    // approving privileged access is a support.manage decision (§4.1 — the
    // reviewer must be authorized for sensitive-access approval)
    ownerRequire(ctx, "support.manage")
    if (p.accessMode === "CONTROLLED_WRITE") {
      // controlled write needs BOTH the approver AND the agent to hold manage
      ownerRequire(ctx, "support.manage")
    }
    const res = await approveLiveSupportRequest(
      { id: ctx.ownerId, name: ctx.name, ip: ctx.ip },
      {
        requestId: p.requestId,
        modules: p.modules,
        minutes: p.minutes,
        accessMode: p.accessMode,
        agentOwnerId: p.agentOwnerId,
        agentName: p.agentName,
        note: p.note,
        origin: p.origin,
      },
    )
    if (!res.ok) throw Object.assign(new Error(res.error), { code: res.code })
    // tell the agent their activation link is waiting
    await notifyOwnerUsers(
      "Live Support Access approved — activation link ready",
      `A live-support request you were assigned was approved by ${ctx.name}.\n\nOpen the Owner Console → Support → Live Support Requests and use the activation link within 10 minutes.\n\nThe link is single-use and requires your signed-in owner session.`,
      { userIds: [p.agentOwnerId] },
    ).catch(() => {})
    return {
      sessionId: res.sessionId,
      // the one-time activation URL — returned ONCE, never persisted plaintext
      enterUrl: res.enterUrl,
      activationExpiresAt: res.expiresAt,
    }
  },
})

ownerAction("owner.supportLive.reject", {
  perm: "support.view",
  schema: z.object({
    requestId: z.string().trim().min(1).max(40),
    reason: z.string().trim().min(5).max(1000),
  }).strict(),
  handler: async (ctx: OwnerCtx, p) => {
    ownerRequire(ctx, "support.manage")
    const res = await rejectLiveSupportRequest({ id: ctx.ownerId, name: ctx.name, ip: ctx.ip }, p.requestId, p.reason)
    if (!res.ok) throw Object.assign(new Error(res.error || "Rejection failed"), { code: 400 })
    return { status: "REJECTED" }
  },
})

/** KPI strip for the Support console (queue health at a glance). */
ownerAction("owner.supportTickets.overview", {
  perm: "support.view",
  handler: async () => {
    const now = new Date()
    const dayAgo = new Date(now.getTime() - 86400_000)
    const [open, assigned, inProgress, waitingTenant, waitingSupport, resolvedToday, livePending, liveActive, unassigned] = await Promise.all([
      db.saasSupportTicket.count({ where: { status: "OPEN" } }),
      db.saasSupportTicket.count({ where: { status: "ASSIGNED" } }),
      db.saasSupportTicket.count({ where: { status: "IN_PROGRESS" } }),
      db.saasSupportTicket.count({ where: { status: "WAITING_TENANT" } }),
      db.saasSupportTicket.count({ where: { status: "WAITING_SUPPORT" } }),
      db.saasSupportTicket.count({ where: { status: "RESOLVED", updatedAt: { gte: dayAgo } } }),
      db.saasLiveSupportRequest.count({ where: { status: "PENDING_REVIEW" } }),
      db.saasSupportAccessSession.count({ where: { status: "ACTIVE", expiresAt: { gt: now } } }),
      db.saasSupportTicket.count({ where: { status: { in: ["OPEN", "WAITING_SUPPORT"] }, assigneeOwnerId: null } }),
    ])
    return {
      open, assigned, inProgress, waitingTenant, waitingSupport, resolvedToday,
      livePending, liveActive, unassigned,
      totalOpenWork: open + assigned + inProgress + waitingSupport,
    }
  },
})

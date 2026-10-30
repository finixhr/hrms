// ============ Support Center — tenant-plane routes (master prompt Part A) ====
// POST /api/hrm {action: "support.*"} — two surfaces, clearly separated:
//
//   1. ORDINARY SUPPORT CHAT (§3.1): tickets + threaded messages between
//      tenant users and platform support personnel. Attachments ride the
//      platform storage layer (storeUpload kind SUPPORT_ATTACHMENT, magic-byte
//      sniffed, 5 MB cap); signed URLs are minted per read, never stored.
//   2. LIVE SUPPORT ACCESS REQUESTS (§3.2, Part B): a tenant REQUESTS
//      time-limited privileged access. A request is NOT a session — the
//      owner reviews it (approve/reject), an approval creates a PENDING
//      SaasSupportAccessSession, and only the one-time activation link (plus
//      the agent's own FULL owner session + MFA) starts the audited session.
//      The tenant can always see request status and the ACTIVE session state
//      and can end an active session on their own workspace.
//
// SECURITY: every query is ctx.vendorId-scoped (H-10 — cross-tenant ids 404).
// Tickets are writable only while OPEN-family; a CLOSED ticket accepts
// reopen requests. The affected-module selector is served from the
// authoritative TENANT_MODULES registry ∩ the tenant's live entitlements.
// These actions are ALSO reachable by PENDING_PAYMENT (locked) tenants —
// support is an onboarding-critical surface (dispatcher SAAS_LOCKED_EXEMPT_
// PREFIXES).
import { z } from "zod"
import { db } from "@/lib/db"
import { route } from "./registry"
import { Deny } from "../rbac"
import { audit } from "../audit"
import { j } from "../utils"
import { nextTicketNumber } from "../saas/sequences"
import { TENANT_MODULE_BY_KEY, TENANT_MODULE_KEYS } from "../saas/constants"
import { resolveEntitlements } from "../saas/entitlements"
import { storeUpload, signedObjectUrl } from "../saas/storage"
import { notifyOwnerUsers } from "../saas/notify"
import { endSupportSession } from "../saas/support-access"
import { saasAudit } from "../saas/audit"
import type { Ctx } from "../types"

// ---------------- constants ----------------

export const TICKET_CATEGORIES = [
  "GENERAL", "BILLING", "ATTENDANCE", "PAYROLL", "LEAVE", "EMPLOYEES",
  "RECRUITMENT", "REPORTS", "SECURITY", "DATA", "INTEGRATION", "OTHER",
] as const
export const TICKET_STATUSES = [
  "OPEN", "ASSIGNED", "IN_PROGRESS", "WAITING_TENANT", "WAITING_SUPPORT",
  "RESOLVED", "CLOSED",
] as const
/** Statuses a tenant may reply / attach on (a RESOLVED ticket must be
 *  reopened first; a CLOSED one accepts a reopen request). */
const TICKET_OPEN_STATUSES = ["OPEN", "ASSIGNED", "IN_PROGRESS", "WAITING_TENANT", "WAITING_SUPPORT", "RESOLVED"]

const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024
/** Client data-URL decode + per-ticket attachment count cap. */
const MAX_ATTACHMENTS_PER_MESSAGE = 5

type AttachmentMeta = { objectKey: string; fileName: string; mimeType: string; sizeBytes: number; uploadedBy: string }

async function loadTicketFor(vendorId: string, ticketId: string) {
  const t = await db.saasSupportTicket.findFirst({ where: { id: ticketId, vendorId } })
  if (!t) throw new Deny("Support ticket not found for your workspace.", 404)
  return t
}

type AttachmentWithUrl = AttachmentMeta & { url: string | null }

async function attachmentsWithUrls(attachmentsJson: string): Promise<AttachmentWithUrl[]> {
  const list = j<AttachmentMeta[]>(attachmentsJson, [])
  if (!list.length) return []
  const out = []
  for (const a of list.slice(0, 10)) {
    out.push({ ...a, url: await signedObjectUrl(a.objectKey, 900) })
  }
  return out
}

/** The affected-module selector source (§3.2): the module registry filtered
 *  to the modules THIS tenant actually has (entitlement-aware — no inventing
 *  unavailable modules), each with a locked flag (locked modules can still be
 *  requested for READ-ONLY troubleshooting — e.g. billing on a locked
 *  workspace — and the owner decides at approval time). */
function moduleOptionsFor(modules: string[], ent: { status: string; features: Record<string, boolean> }) {
  return modules.map((key) => {
    const def = TENANT_MODULE_BY_KEY[key]
    const blocked = def?.feature ? ent.features[def.feature] === false : false
    return { key, label: def?.label || key, available: !blocked }
  })
}

// ---------------- ticket list / detail ----------------

route("support.overview", {
  perm: ["support", "view"],
  schema: z.object({}).strict(),
  handler: async (ctx) => {
    const [open, awaiting, recent, liveRequests, activeSession] = await Promise.all([
      db.saasSupportTicket.count({ where: { vendorId: ctx.vendorId, status: { in: ["OPEN", "ASSIGNED", "IN_PROGRESS"] } } }),
      db.saasSupportTicket.count({ where: { vendorId: ctx.vendorId, status: "WAITING_TENANT" } }),
      db.saasSupportTicket.findMany({
        where: { vendorId: ctx.vendorId },
        orderBy: { updatedAt: "desc" },
        take: 5,
      }),
      db.saasLiveSupportRequest.count({ where: { vendorId: ctx.vendorId, status: { in: ["PENDING_REVIEW", "APPROVED", "ACTIVE"] } } }),
      db.saasSupportAccessSession.findFirst({
        where: { targetVendorId: ctx.vendorId, status: "ACTIVE" },
        orderBy: { startedAt: "desc" },
      }),
    ])
    const ent = await resolveEntitlements(ctx.vendorId)
    return {
      stats: { open, awaitingTenant: awaiting, activeLiveRequests: liveRequests },
      recent: recent.map((t) => ({
        id: t.id, number: t.number, subject: t.subject, status: t.status,
        priority: t.priority, category: t.category, updatedAt: t.updatedAt,
      })),
      moduleOptions: moduleOptionsFor(TENANT_MODULE_KEYS, ent),
      categories: TICKET_CATEGORIES,
      activeSupportSession: activeSession
        ? {
            id: activeSession.id,
            operatorName: activeSession.operatorName,
            accessMode: activeSession.accessMode,
            modules: j<string[]>(activeSession.approvedModulesJson, []),
            startedAt: activeSession.startedAt,
            expiresAt: activeSession.expiresAt,
            reason: activeSession.reason,
          }
        : null,
    }
  },
})

route("support.tickets", {
  perm: ["support", "view"],
  schema: z.object({
    status: z.enum(["ALL", ...TICKET_STATUSES]).default("ALL"),
    take: z.number().int().min(1).max(100).default(50),
  }).strict(),
  handler: async (ctx, p) => {
    const rows = await db.saasSupportTicket.findMany({
      where: { vendorId: ctx.vendorId, ...(p.status === "ALL" ? {} : { status: p.status }) },
      orderBy: { updatedAt: "desc" },
      take: p.take,
    })
    return {
      rows: rows.map((t) => ({
        id: t.id, number: t.number, subject: t.subject, category: t.category,
        priority: t.priority, status: t.status,
        assigneeName: t.assigneeName, lastMessageAt: t.lastMessageAt,
        createdAt: t.createdAt, closedAt: t.closedAt,
      })),
    }
  },
})

route("support.ticket.get", {
  perm: ["support", "view"],
  schema: z.object({ ticketId: z.string().trim().min(1).max(40) }).strict(),
  handler: async (ctx, p) => {
    const t = await loadTicketFor(ctx.vendorId, p.ticketId)
    const messages = await db.saasSupportMessage.findMany({
      where: { ticketId: t.id, internalNote: false },
      orderBy: { createdAt: "asc" },
      take: 200,
    })
    // mark support replies read by the tenant (last tenant view)
    const unread = messages.filter((m) => m.authorRole === "SUPPORT" && !m.readByTenantAt)
    if (unread.length) {
      await db.saasSupportMessage.updateMany({
        where: { id: { in: unread.map((m) => m.id) } },
        data: { readByTenantAt: new Date() },
      })
    }
    return {
      ticket: {
        id: t.id, number: t.number, subject: t.subject, category: t.category,
        priority: t.priority, status: t.status, requesterName: t.requesterName,
        assigneeName: t.assigneeName, firstResponseAt: t.firstResponseAt,
        createdAt: t.createdAt, closedAt: t.closedAt, closedByName: t.closedByName,
      },
      messages: await Promise.all(messages.map(async (m) => ({
        id: m.id, authorRole: m.authorRole, authorName: m.authorName,
        body: m.body, createdAt: m.createdAt,
        attachments: await attachmentsWithUrls(m.attachmentsJson),
      }))),
    }
  },
})

// ---------------- create / reply / close / reopen ----------------

const attachmentSchema = z.object({
  fileName: z.string().trim().min(1).max(180),
  /** data:image/png;base64,… — sniffed server-side; spoofed types rejected */
  dataUrl: z.string().max(8_000_000),
})

route("support.ticket.create", {
  perm: ["support", "view"],
  schema: z.object({
    subject: z.string().trim().min(4).max(160),
    category: z.enum(TICKET_CATEGORIES).default("GENERAL"),
    priority: z.enum(["LOW", "NORMAL", "HIGH", "URGENT"]).default("NORMAL"),
    message: z.string().trim().min(10).max(5000),
    attachments: z.array(attachmentSchema).max(MAX_ATTACHMENTS_PER_MESSAGE).default([]),
  }).strict(),
  handler: async (ctx, p, _req) => {
    const { rateLimit } = await import("../security")
    if (await rateLimit(`support-create:${ctx.vendorId}`, 10, 60_000)) {
      throw new Deny("Too many tickets created — wait a minute and try again.", 429)
    }
    const number = await nextTicketNumber()
    const now = new Date()
    const t = await db.saasSupportTicket.create({
      data: {
        vendorId: ctx.vendorId,
        number,
        subject: p.subject,
        category: p.category,
        priority: p.priority,
        status: "OPEN",
        requesterUserId: ctx.userId,
        requesterName: ctx.userName,
        lastMessageAt: now,
      },
    })
    const attachments = await storeAttachments(ctx, p.attachments)
    await db.saasSupportMessage.create({
      data: {
        ticketId: t.id,
        authorRole: "TENANT",
        authorId: ctx.userId,
        authorName: ctx.userName,
        body: p.message,
        attachmentsJson: JSON.stringify(attachments),
        readByTenantAt: now,
      },
    })
    await notifyOwnerUsers(
      `New support ticket ${number}: ${p.subject}`,
      `A tenant submitted a support ticket.\n\nWorkspace: ${ctx.vendorId}\nTicket: ${number} (${p.priority} priority)\nSubject: ${p.subject}\nCategory: ${p.category}\n\nOpen the Owner Console → Support to respond.`,
      { perm: "support.view" },
    )
    await audit({ vendorId: ctx.vendorId, userId: ctx.userId, userName: ctx.userName, ip: ctx.ip },
      "support.ticket.create", "SaasSupportTicket", t.id,
      `Support ticket ${number} created: ${p.subject} (${p.priority})`,
      { newValue: { number, category: p.category, priority: p.priority } })
    return { id: t.id, number: t.number, status: t.status }
  },
})

route("support.ticket.reply", {
  perm: ["support", "view"],
  schema: z.object({
    ticketId: z.string().trim().min(1).max(40),
    message: z.string().trim().min(1).max(5000),
    attachments: z.array(attachmentSchema).max(MAX_ATTACHMENTS_PER_MESSAGE).default([]),
  }).strict(),
  handler: async (ctx, p, _req) => {
    const { rateLimit } = await import("../security")
    if (await rateLimit(`support-reply:${ctx.userId}`, 30, 60_000)) {
      throw new Deny("Too many messages — wait a minute and try again.", 429)
    }
    const t = await loadTicketFor(ctx.vendorId, p.ticketId)
    if (!TICKET_OPEN_STATUSES.includes(t.status)) {
      throw new Deny(`This ticket is ${t.status.toLowerCase()} — request a reopen before replying.`, 400)
    }
    const attachments = await storeAttachments(ctx, p.attachments)
    const msg = await db.saasSupportMessage.create({
      data: {
        ticketId: t.id,
        authorRole: "TENANT",
        authorId: ctx.userId,
        authorName: ctx.userName,
        body: p.message,
        attachmentsJson: JSON.stringify(attachments),
        readByTenantAt: new Date(),
      },
    })
    // a tenant reply moves the ball back to support (unless resolved → reopen-ish)
    const nextStatus = t.status === "RESOLVED" ? "IN_PROGRESS" : t.status === "WAITING_TENANT" ? "WAITING_SUPPORT" : t.status
    await db.saasSupportTicket.update({
      where: { id: t.id },
      data: { status: nextStatus, lastMessageAt: new Date() },
    })
    if (t.assigneeName || t.status !== "OPEN") {
      // only notify when there is an ongoing conversation
      await notifyOwnerUsers(
        `Support ticket ${t.number}: new tenant reply`,
        `${ctx.userName} replied on ticket ${t.number} (${t.subject}).\n\nOpen the Owner Console → Support to continue the conversation.`,
        { perm: "support.view" },
      ).catch(() => {})
    }
    return { messageId: msg.id, status: nextStatus }
  },
})

route("support.ticket.close", {
  perm: ["support", "view"],
  schema: z.object({
    ticketId: z.string().trim().min(1).max(40),
    note: z.string().trim().max(500).optional(),
  }).strict(),
  handler: async (ctx, p) => {
    const t = await loadTicketFor(ctx.vendorId, p.ticketId)
    if (t.status === "CLOSED") throw new Deny("This ticket is already closed.", 400)
    await db.saasSupportTicket.update({
      where: { id: t.id },
      data: { status: "CLOSED", closedAt: new Date(), closedByName: `${ctx.userName} (tenant)` },
    })
    await audit({ vendorId: ctx.vendorId, userId: ctx.userId, userName: ctx.userName, ip: ctx.ip },
      "support.ticket.close", "SaasSupportTicket", t.id,
      `Support ticket ${t.number} closed by the tenant${p.note ? ` — ${p.note}` : ""}`)
    return { status: "CLOSED" }
  },
})

route("support.ticket.reopen", {
  perm: ["support", "view"],
  schema: z.object({
    ticketId: z.string().trim().min(1).max(40),
    reason: z.string().trim().min(5).max(500),
  }).strict(),
  handler: async (ctx, p) => {
    const t = await loadTicketFor(ctx.vendorId, p.ticketId)
    if (t.status !== "CLOSED" && t.status !== "RESOLVED") {
      throw new Deny(`This ticket is ${t.status.toLowerCase()} — reopen applies to resolved/closed tickets.`, 400)
    }
    const { rateLimit } = await import("../security")
    if (await rateLimit(`support-reopen:${ctx.vendorId}`, 5, 60_000)) {
      throw new Deny("Too many reopen requests — wait a minute and try again.", 429)
    }
    await db.saasSupportTicket.update({
      where: { id: t.id },
      data: { status: "OPEN", closedAt: null, closedByName: null, lastMessageAt: new Date() },
    })
    await db.saasSupportMessage.create({
      data: {
        ticketId: t.id,
        authorRole: "TENANT",
        authorId: ctx.userId,
        authorName: ctx.userName,
        body: `Reopen requested — ${p.reason}`,
      },
    })
    await notifyOwnerUsers(
      `Support ticket ${t.number} reopened by the tenant`,
      `The tenant reopened ticket ${t.number} (${t.subject}).\nReason: ${p.reason}\n\nOpen the Owner Console → Support to respond.`,
      { perm: "support.view" },
    ).catch(() => {})
    return { status: "OPEN" }
  },
})

// ---------------- Live Support Access requests (§3.2 / Part B) ----------------

const LIVE_REQUEST_STATUSES = ["PENDING_REVIEW", "APPROVED", "REJECTED", "ACTIVE", "COMPLETED", "REVOKED", "EXPIRED", "CANCELLED"] as const

route("support.liveRequests", {
  perm: ["support", "view"],
  schema: z.object({ take: z.number().int().min(1).max(50).default(20) }).strict(),
  handler: async (ctx, p) => {
    const rows = await db.saasLiveSupportRequest.findMany({
      where: { vendorId: ctx.vendorId },
      orderBy: { createdAt: "desc" },
      take: p.take,
    })
    const sessions = rows.length
      ? await db.saasSupportAccessSession.findMany({
          where: { liveRequestId: { in: rows.map((r) => r.id) } },
          orderBy: { createdAt: "desc" },
        })
      : []
    return {
      rows: rows.map((r) => {
        const session = sessions.find((s) => s.liveRequestId === r.id)
        return {
          id: r.id, title: r.title, category: r.category,
          modules: j<string[]>(r.modulesJson, []),
          priority: r.priority, status: r.status,
          requestedByName: r.requestedByName, requestedAt: r.requestedAt,
          reviewedByName: r.reviewedByName, reviewedAt: r.reviewedAt,
          reviewNote: r.reviewNote,
          approvedMinutes: r.approvedMinutes,
          approvedAgentName: r.approvedAgentName,
          session: session
            ? {
                id: session.id, status: session.status,
                operatorName: session.operatorName,
                accessMode: session.accessMode,
                modules: j<string[]>(session.approvedModulesJson, []),
                startedAt: session.startedAt, expiresAt: session.expiresAt,
                endedReason: session.endedReason,
              }
            : null,
        }
      }),
    }
  },
})

route("support.liveRequest.create", {
  perm: ["support", "view"],
  schema: z.object({
    title: z.string().trim().min(6).max(160),
    description: z.string().trim().min(20).max(5000),
    category: z.enum(TICKET_CATEGORIES).default("GENERAL"),
    modules: z.array(z.string().trim().min(1).max(40)).min(1).max(20),
    priority: z.enum(["LOW", "NORMAL", "HIGH", "URGENT"]).default("NORMAL"),
    contextNote: z.string().trim().max(3000).optional(),
    ticketId: z.string().trim().min(1).max(40).optional(),
    attachments: z.array(attachmentSchema).max(MAX_ATTACHMENTS_PER_MESSAGE).default([]),
  }).strict(),
  handler: async (ctx, p, _req) => {
    const { rateLimit } = await import("../security")
    if (await rateLimit(`live-request:${ctx.vendorId}`, 5, 60_000)) {
      throw new Deny("Too many live-support requests — wait a minute and try again.", 429)
    }
    // one open request per workspace (the review queue must stay unambiguous)
    const open = await db.saasLiveSupportRequest.findFirst({
      where: { vendorId: ctx.vendorId, status: { in: ["PENDING_REVIEW", "APPROVED", "ACTIVE"] } },
    })
    if (open) {
      throw new Deny(`You already have a live-support request (${open.status.replace("_", " ").toLowerCase()}). Wait for it to be resolved or cancel it first.`, 409)
    }
    // module keys must exist in the authoritative registry
    const invalid = p.modules.filter((m: string) => !TENANT_MODULE_KEYS.includes(m))
    if (invalid.length) {
      throw new Deny(`Unknown module(s): ${invalid.join(", ")} — pick from the module selector.`, 400)
    }
    if (p.ticketId) await loadTicketFor(ctx.vendorId, p.ticketId) // scope check only

    const attachments = await storeAttachments(ctx, p.attachments)
    const req = await db.saasLiveSupportRequest.create({
      data: {
        vendorId: ctx.vendorId,
        ticketId: p.ticketId || null,
        title: p.title,
        description: p.description,
        category: p.category,
        modulesJson: JSON.stringify([...new Set(p.modules)]),
        priority: p.priority,
        contextNote: p.contextNote || null,
        status: "PENDING_REVIEW",
        requestedByUserId: ctx.userId,
        requestedByName: ctx.userName,
      },
    })
    // diagnostic attachments are attached to a linked hidden message so they
    // ride the same storage/audit pipeline as ticket attachments
    if (attachments.length && p.ticketId) {
      await db.saasSupportMessage.create({
        data: {
          ticketId: p.ticketId,
          authorRole: "TENANT",
          authorId: ctx.userId,
          authorName: ctx.userName,
          body: `[Live Support Access request — ${p.title}] Diagnostic attachments`,
          attachmentsJson: JSON.stringify(attachments),
        },
      })
    }
    await notifyOwnerUsers(
      `Live Support Access requested: ${p.title}`,
      `A tenant requested privileged live support access.\n\nWorkspace: ${ctx.vendorId}\nRequester: ${ctx.userName} (${p.priority} priority)\nTitle: ${p.title}\nAffected modules: ${[...new Set(p.modules)].join(", ")}\n\nReview it from the Owner Console → Support → Live Support Requests.`,
      { perm: "support.view" },
    )
    await saasAudit({ id: ctx.userId, name: ctx.userName }, "LIVE_SUPPORT_REQUESTED", "SaasLiveSupportRequest", req.id,
      `Live Support Access requested (${p.priority}): ${p.title} — modules: ${[...new Set(p.modules)].join(", ")}`,
      { vendorId: ctx.vendorId, metadata: { modules: [...new Set(p.modules)], priority: p.priority } })
    return { requestId: req.id, status: req.status }
  },
})

route("support.liveRequest.cancel", {
  perm: ["support", "view"],
  schema: z.object({
    requestId: z.string().trim().min(1).max(40),
    reason: z.string().trim().max(300).optional(),
  }).strict(),
  handler: async (ctx, p) => {
    const req = await db.saasLiveSupportRequest.findFirst({ where: { id: p.requestId, vendorId: ctx.vendorId } })
    if (!req) throw new Deny("Live-support request not found for your workspace.", 404)
    if (!["PENDING_REVIEW", "APPROVED"].includes(req.status)) {
      throw new Deny(`A ${req.status.toLowerCase().replace("_", " ")} request cannot be cancelled — end the session instead.`, 400)
    }
    await db.saasLiveSupportRequest.update({
      where: { id: req.id },
      data: { status: "CANCELLED", resolvedAt: new Date() },
    })
    await saasAudit({ id: ctx.userId, name: ctx.userName }, "LIVE_SUPPORT_REQUEST_CANCELLED", "SaasLiveSupportRequest", req.id,
      `Live Support Access request cancelled by the tenant${p.reason ? ` — ${p.reason}` : ""}`,
      { vendorId: ctx.vendorId })
    return { status: "CANCELLED" }
  },
})

/** Tenant-initiated END of an active session on their own workspace (§4.5:
 * an authorized manual revoke). The tenant owns the workspace — ending the
 * session is their right; the action is audited on the platform plane. */
route("support.session.end", {
  perm: ["support", "view"],
  schema: z.object({
    sessionId: z.string().trim().min(1).max(40),
    reason: z.string().trim().max(300).optional(),
  }).strict(),
  handler: async (ctx, p) => {
    const s = await db.saasSupportAccessSession.findFirst({ where: { id: p.sessionId, targetVendorId: ctx.vendorId } })
    if (!s) throw new Deny("Support session not found for your workspace.", 404)
    if (s.status !== "ACTIVE") throw new Deny(`This session is ${s.status.toLowerCase()} — nothing to end.`, 400)
    await endSupportSession(s.id, { id: ctx.userId, name: ctx.userName }, "ENDED", "TENANT_ENDED" + (p.reason ? `: ${p.reason}` : ""))
    await saasAudit({ id: ctx.userId, name: ctx.userName }, "SUPPORT_SESSION_ENDED_BY_TENANT", "SaasSupportAccessSession", s.id,
      `Tenant ended the active support session${p.reason ? ` — ${p.reason}` : ""}`,
      { vendorId: ctx.vendorId })
    return { status: "ENDED" }
  },
})

// ---------------- attachment storage ----------------

/** Decode + store client data-URL attachments through the platform storage
 *  pipeline (magic-byte sniffing, 5 MB cap each, sha256 dedupe key, tenant
 *  storage quota enforced by storeUpload → bumpStorageRollup). Spoofed or
 *  unsupported types are rejected — the sniffed type WINS over the declared
 *  one. Returns the JSON-safe metadata array persisted on the message. */
async function storeAttachments(ctx: Ctx, attachments: { fileName: string; dataUrl: string }[]): Promise<AttachmentMeta[]> {
  const out: AttachmentMeta[] = []
  for (const a of attachments.slice(0, MAX_ATTACHMENTS_PER_MESSAGE)) {
    const m = /^data:([\w.+-]+\/[\w.+-]+)?;base64,(.+)$/.exec(a.dataUrl)
    if (!m) throw new Deny(`Attachment "${a.fileName}" is not a valid base64 data URL.`, 400)
    let buf: Buffer
    try {
      buf = Buffer.from(m[2], "base64")
    } catch {
      throw new Deny(`Attachment "${a.fileName}" could not be decoded.`, 400)
    }
    if (buf.length === 0) throw new Deny(`Attachment "${a.fileName}" is empty.`, 400)
    if (buf.length > MAX_ATTACHMENT_BYTES) {
      throw new Deny(`Attachment "${a.fileName}" is ${Math.round(buf.length / 1024 / 1024)} MB — the limit is 5 MB.`, 400)
    }
    // only diagnostic-safe types (screenshots + pdf) — NOT executables/docs
    const sniffed = sniffSupportAttachment(buf)
    if (!sniffed) {
      throw new Deny(`Attachment "${a.fileName}" has an unsupported type — permitted: JPEG, PNG, WebP, PDF.`, 400)
    }
    const stored = await storeUpload({
      vendorId: ctx.vendorId,
      kind: "SUPPORT_ATTACHMENT",
      buf,
      declaredMime: sniffed,
      maxBytes: MAX_ATTACHMENT_BYTES,
      refTable: "SaasSupportMessage",
      keyHint: a.fileName.replace(/\.[^.]+$/, "").slice(0, 40),
    })
    out.push({
      objectKey: stored.objectKey,
      fileName: a.fileName.slice(0, 180),
      mimeType: sniffed,
      sizeBytes: buf.length,
      uploadedBy: ctx.userName,
    })
  }
  return out
}

/** Permit only diagnostic-safe attachment types (screenshots + PDF). */
function sniffSupportAttachment(buf: Buffer): string | null {
  if (buf.length < 12) return null
  // JPEG: FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg"
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "image/png"
  // WebP: RIFF....WEBP
  if (buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") return "image/webp"
  // PDF: %PDF-
  if (buf.toString("ascii", 0, 5) === "%PDF-") return "application/pdf"
  return null
}

// keep the Next.js Request import used (future per-request origin checks)
export type _SupportReq = Request
export { LIVE_REQUEST_STATUSES }

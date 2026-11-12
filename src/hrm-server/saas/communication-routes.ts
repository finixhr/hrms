// ============ R11 (2026-10-12) — SaaS Owner Communication routes ============
// owner.communication.* — marketing / promotional / newsletter campaign
// console + reusable templates. Self-registers into the owner dispatcher
// (same pattern as cms-routes.ts: imported AFTER owner-routes from the
// /api/owner route file so the ownerAction table is populated).
//
// Capabilities: campaign CRUD, audience preview (with opt-out visibility),
// send-now / schedule, cancel scheduled runs, per-recipient delivery log,
// template CRUD + template→campaign clone. Consent: vendors with
// marketingOptOut are journaled SKIPPED — never contacted.
import { z } from "zod"
import { db } from "@/lib/db"
import { ownerAction } from "./owner-routes"
import { saasAudit } from "./audit"
import { resolveCampaignAudience, renderCampaignMessage, deliverCampaign } from "./communication"

function err(code: number, message: string): never {
  const e = new Error(message) as Error & { code?: number }
  e.code = code
  throw e
}

const CAMPAIGN_KINDS = ["MARKETING", "PROMOTIONAL", "CAMPAIGN", "OFFER", "NEWSLETTER"] as const
const AUDIENCE_TYPES = ["ALL", "ACTIVE", "TRIAL", "EXPIRED", "PLAN", "CUSTOM"] as const

// ------------------------------ templates ------------------------------

ownerAction("owner.communication.templates.list", {
  perm: "communication.view",
  handler: async () => {
    const rows = await db.saasCommunicationTemplate.findMany({ orderBy: { updatedAt: "desc" } })
    return { templates: rows }
  },
})

ownerAction("owner.communication.templates.save", {
  perm: "communication.manage",
  schema: z.object({
    id: z.string().min(1).optional(),
    name: z.string().trim().min(1).max(120),
    kind: z.enum(CAMPAIGN_KINDS).default("MARKETING"),
    channel: z.enum(["EMAIL", "SMS"]).default("EMAIL"),
    subject: z.string().trim().max(200).optional(),
    body: z.string().trim().min(1).max(8000),
    active: z.boolean().default(true),
  }),
  handler: async (ctx, p) => {
    if (p.channel === "EMAIL" && !p.subject?.trim()) err(400, "Email templates need a subject line")
    if (p.channel === "SMS" && p.body.length > 480) err(400, "SMS templates are limited to 480 characters")
    if (p.id) {
      const rec = await db.saasCommunicationTemplate.findUnique({ where: { id: p.id } })
      if (!rec) err(404, "Template not found")
      const updated = await db.saasCommunicationTemplate.update({
        where: { id: p.id },
        data: {
          name: p.name, kind: p.kind, channel: p.channel,
          subject: p.subject || null, body: p.body, active: p.active,
        },
      })
      await saasAudit(ctx, "COMM_TEMPLATE_UPDATED", "SaasCommunicationTemplate", p.id,
        `Updated ${p.channel} template "${p.name}"`, { metadata: { kind: p.kind, chars: p.body.length } })
      return { id: updated.id }
    }
    const rec = await db.saasCommunicationTemplate.create({
      data: {
        name: p.name, kind: p.kind, channel: p.channel,
        subject: p.subject || null, body: p.body, active: p.active,
        createdById: ctx.ownerId, createdByName: ctx.name,
      },
    })
    await saasAudit(ctx, "COMM_TEMPLATE_CREATED", "SaasCommunicationTemplate", rec.id,
      `Created ${p.channel} template "${p.name}"`, { metadata: { kind: p.kind, chars: p.body.length } })
    return { id: rec.id }
  },
})

ownerAction("owner.communication.templates.delete", {
  perm: "communication.manage",
  schema: z.object({ id: z.string().min(1) }),
  handler: async (ctx, p) => {
    const rec = await db.saasCommunicationTemplate.findUnique({ where: { id: p.id } })
    if (!rec) err(404, "Template not found")
    // campaigns keep templateId for provenance — history is never rewritten;
    // deleting only stops future cloning.
    await db.saasCommunicationTemplate.delete({ where: { id: p.id } })
    await saasAudit(ctx, "COMM_TEMPLATE_DELETED", "SaasCommunicationTemplate", p.id,
      `Deleted template "${rec.name}"`, { metadata: { name: rec.name } })
    return { ok: true }
  },
})

// ------------------------------ campaigns ------------------------------

const PAGINATION = z.object({
  page: z.number().int().min(1).default(1),
  pageSize: z.number().int().min(1).max(100).default(25),
  search: z.string().trim().max(120).optional(),
}).passthrough()

ownerAction("owner.communication.campaigns.list", {
  perm: "communication.view",
  schema: PAGINATION.extend({
    status: z.enum(["ALL", "DRAFT", "SCHEDULED", "SENDING", "SENT", "PARTIAL", "FAILED"]).default("ALL"),
    channel: z.enum(["ALL", "EMAIL", "SMS"]).default("ALL"),
  }),
  handler: async (_ctx, p) => {
    const where: any = {}
    if (p.status !== "ALL") where.status = p.status
    if (p.channel !== "ALL") where.channel = p.channel
    if (p.search) where.name = { contains: p.search, mode: "insensitive" }
    const [rows, total] = await Promise.all([
      db.saasCampaign.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (p.page - 1) * p.pageSize,
        take: p.pageSize,
      }),
      db.saasCampaign.count({ where }),
    ])
    return { campaigns: rows, total, page: p.page, pageSize: p.pageSize }
  },
})

ownerAction("owner.communication.campaigns.get", {
  perm: "communication.view",
  schema: z.object({
    id: z.string().min(1),
    page: z.number().int().min(1).max(1000).default(1),
    pageSize: z.number().int().min(1).max(100).default(50),
  }),
  handler: async (_ctx, p) => {
    const c = await db.saasCampaign.findUnique({ where: { id: p.id } })
    if (!c) err(404, "Campaign not found")
    const [recipients, total] = await Promise.all([
      db.saasCampaignRecipient.findMany({
        where: { campaignId: p.id },
        orderBy: [{ status: "asc" }, { vendorName: "asc" }],
        skip: (p.page - 1) * p.pageSize,
        take: p.pageSize,
      }),
      db.saasCampaignRecipient.count({ where: { campaignId: p.id } }),
    ])
    return { campaign: c, recipients, recipientTotal: total, page: p.page, pageSize: p.pageSize }
  },
})

ownerAction("owner.communication.campaigns.preview", {
  perm: "communication.view",
  schema: z.object({
    audienceType: z.enum(AUDIENCE_TYPES).default("ALL"),
    audienceIds: z.array(z.string().min(1)).max(500).default([]),
    templateBody: z.string().max(8000).optional(),
    subject: z.string().max(200).optional(),
  }),
  handler: async (_ctx, p) => {
    const audience = await resolveCampaignAudience({ audienceType: p.audienceType, audienceIds: JSON.stringify(p.audienceIds) })
    const reachable = audience.filter((m) => !m.optOut)
    const optedOut = audience.filter((m) => m.optOut)
    // sample render for the first reachable tenant WITH a contact on file
    // (a placeholder demo for an uncontactable tenant is useless)
    let sample: { to: string; message: string } | null = null
    const sampleTarget = reachable.find((m) => !!m.email)
    if (sampleTarget && sampleTarget.email && p.templateBody) {
      sample = {
        to: sampleTarget.email,
        message: renderCampaignMessage(p.templateBody, {
          tenantName: sampleTarget.vendorName,
          planName: sampleTarget.planName || "your current plan",
          endDate: sampleTarget.endDate ? sampleTarget.endDate.toISOString().slice(0, 10) : "your renewal date",
          platformName: "Finix HR",
          offerCode: "",
        }),
      }
    }
    return {
      total: audience.length,
      reachable: reachable.length,
      optedOut: optedOut.length,
      noContact: audience.filter((m) => !m.optOut && !m.email && !m.phone).length,
      sampleTenants: audience.slice(0, 8).map((m) => ({ name: m.vendorName, email: m.email, planName: m.planName, optOut: m.optOut })),
      sample,
    }
  },
})

ownerAction("owner.communication.campaigns.save", {
  perm: "communication.manage",
  schema: z.object({
    id: z.string().min(1).optional(),
    name: z.string().trim().min(1).max(120),
    kind: z.enum(CAMPAIGN_KINDS).default("MARKETING"),
    channel: z.enum(["EMAIL", "SMS"]).default("EMAIL"),
    subject: z.string().trim().max(200).optional(),
    body: z.string().trim().min(1).max(8000),
    audienceType: z.enum(AUDIENCE_TYPES).default("ALL"),
    audienceIds: z.array(z.string().min(1)).max(500).default([]),
    templateId: z.string().min(1).optional(),
  }),
  handler: async (ctx, p) => {
    if (p.channel === "EMAIL" && !p.subject?.trim()) err(400, "Email campaigns need a subject line")
    if (p.channel === "SMS" && p.body.length > 480) err(400, "SMS campaigns are limited to 480 characters")
    if (p.id) {
      const rec = await db.saasCampaign.findUnique({ where: { id: p.id } })
      if (!rec) err(404, "Campaign not found")
      if (["SENDING", "SENT", "PARTIAL", "FAILED"].includes(rec.status)) {
        err(400, `This campaign already ran (${rec.status.toLowerCase()}) — duplicate it to re-send`)
      }
      const updated = await db.saasCampaign.update({
        where: { id: p.id },
        data: {
          name: p.name, kind: p.kind, channel: p.channel, subject: p.subject || null, body: p.body,
          audienceType: p.audienceType, audienceIds: JSON.stringify(p.audienceIds),
          templateId: p.templateId || null,
        },
      })
      await saasAudit(ctx, "CAMPAIGN_UPDATED", "SaasCampaign", p.id,
        `Updated campaign "${p.name}" (${p.channel}, audience ${p.audienceType})`,
        { metadata: { kind: p.kind, channel: p.channel, audienceType: p.audienceType } })
      return { id: updated.id, status: updated.status }
    }
    const rec = await db.saasCampaign.create({
      data: {
        name: p.name, kind: p.kind, channel: p.channel, subject: p.subject || null, body: p.body,
        audienceType: p.audienceType, audienceIds: JSON.stringify(p.audienceIds),
        templateId: p.templateId || null, status: "DRAFT",
        createdById: ctx.ownerId, createdByName: ctx.name,
      },
    })
    await saasAudit(ctx, "CAMPAIGN_CREATED", "SaasCampaign", rec.id,
      `Created campaign "${p.name}" (${p.channel}, audience ${p.audienceType})`,
      { metadata: { kind: p.kind, channel: p.channel, audienceType: p.audienceType } })
    return { id: rec.id, status: rec.status }
  },
})

ownerAction("owner.communication.campaigns.duplicate", {
  perm: "communication.manage",
  schema: z.object({ id: z.string().min(1) }),
  handler: async (ctx, p) => {
    const rec = await db.saasCampaign.findUnique({ where: { id: p.id } })
    if (!rec) err(404, "Campaign not found")
    const copy = await db.saasCampaign.create({
      data: {
        name: `${rec.name} (copy)`, kind: rec.kind, channel: rec.channel, subject: rec.subject, body: rec.body,
        audienceType: rec.audienceType, audienceIds: rec.audienceIds, templateId: rec.templateId,
        status: "DRAFT", createdById: ctx.ownerId, createdByName: ctx.name,
      },
    })
    await saasAudit(ctx, "CAMPAIGN_DUPLICATED", "SaasCampaign", copy.id,
      `Duplicated campaign "${rec.name}" as a fresh draft`, { metadata: { sourceId: rec.id } })
    return { id: copy.id }
  },
})

ownerAction("owner.communication.campaigns.send", {
  perm: "communication.manage",
  schema: z.object({
    id: z.string().min(1),
    mode: z.enum(["NOW", "SCHEDULE"]).default("NOW"),
    scheduledFor: z.string().datetime().optional(),
  }),
  handler: async (ctx, p) => {
    const rec = await db.saasCampaign.findUnique({ where: { id: p.id } })
    if (!rec) err(404, "Campaign not found")
    if (["SENDING", "SENT", "PARTIAL", "FAILED"].includes(rec.status)) {
      err(400, `This campaign already ran (${rec.status.toLowerCase()}) — duplicate it to re-send`)
    }
    if (p.mode === "SCHEDULE") {
      if (!p.scheduledFor) err(400, "A schedule time is required")
      const when = new Date(p.scheduledFor)
      if (when.getTime() <= Date.now() + 60000) err(400, "Schedule at least 1 minute ahead")
      await db.saasCampaign.update({ where: { id: p.id }, data: { status: "SCHEDULED", scheduledFor: when } })
      await saasAudit(ctx, "CAMPAIGN_SCHEDULED", "SaasCampaign", p.id,
        `Scheduled campaign "${rec.name}" for ${when.toISOString()}`,
        { metadata: { scheduledFor: when.toISOString() } })
      return { status: "SCHEDULED", scheduledFor: when.toISOString() }
    }
    const tally = await deliverCampaign(p.id, { id: ctx.ownerId, name: ctx.name })
    return { status: "SENT", ...tally }
  },
})

ownerAction("owner.communication.campaigns.cancel", {
  perm: "communication.manage",
  schema: z.object({ id: z.string().min(1) }),
  handler: async (ctx, p) => {
    const rec = await db.saasCampaign.findUnique({ where: { id: p.id } })
    if (!rec) err(404, "Campaign not found")
    if (rec.status !== "SCHEDULED") err(400, "Only scheduled campaigns can be cancelled")
    await db.saasCampaign.update({ where: { id: p.id }, data: { status: "DRAFT", scheduledFor: null } })
    await saasAudit(ctx, "CAMPAIGN_CANCELLED", "SaasCampaign", p.id,
      `Cancelled the schedule for "${rec.name}" — back to draft`, { metadata: { campaignId: p.id } })
    return { status: "DRAFT" }
  },
})

ownerAction("owner.communication.campaigns.delete", {
  perm: "communication.manage",
  schema: z.object({ id: z.string().min(1) }),
  handler: async (ctx, p) => {
    const rec = await db.saasCampaign.findUnique({ where: { id: p.id } })
    if (!rec) err(404, "Campaign not found")
    if (["SENDING"].includes(rec.status)) err(400, "A sending campaign cannot be deleted — wait for it to finish")
    await db.saasCampaign.delete({ where: { id: p.id } }) // recipients cascade
    await saasAudit(ctx, "CAMPAIGN_DELETED", "SaasCampaign", p.id,
      `Deleted campaign "${rec.name}" and its delivery log`, { metadata: { name: rec.name } })
    return { ok: true }
  },
})

// ------------------------------ tenants picker ------------------------------

/** Minimal tenant picker for the CUSTOM audience — id, name, plan, status
 *  and marketing consent (so the operator SEES who opted out while
 *  hand-picking recipients). */
ownerAction("owner.communication.tenants", {
  perm: "communication.view",
  schema: z.object({
    search: z.string().trim().max(120).optional(),
    limit: z.number().int().min(1).max(200).default(100),
  }),
  handler: async (_ctx, p) => {
    const vendors = await db.vendor.findMany({
      where: p.search ? { name: { contains: p.search, mode: "insensitive" } } : {},
      select: {
        id: true, name: true, code: true, active: true, marketingOptOut: true,
        saasSubscriptions: { select: { status: true, planName: true }, orderBy: { endDate: "desc" }, take: 1 },
      },
      orderBy: { name: "asc" },
      take: p.limit,
    })
    return {
      tenants: vendors.map((v) => ({
        id: v.id, name: v.name, code: v.code, active: v.active, marketingOptOut: v.marketingOptOut,
        planName: v.saasSubscriptions[0]?.planName || null,
        subscriptionStatus: v.saasSubscriptions[0]?.status || "LEGACY",
      })),
    }
  },
})

// ============ API keys + webhooks management (Wave 4 WP-C / SG-E, 2026-10-08) ============
// Tenant administration of: hashed bearer keys for the public /api/v1 REST
// surface, and outbound webhook endpoints + their delivery log.
//
// Secrets discipline (non-negotiable):
//  - API keys: sha256(raw) hex at rest; `prefix` (first 12 chars, INCLUDING
//    the "fk_" marker) is the only displayable fragment; the raw key is
//    returned exactly ONCE at creation and never again.
//  - Webhook signing secrets: encrypted at rest (crypto-field, context
//    "webhooks::v1"); the raw secret is returned exactly ONCE at creation;
//    list responses expose only a boolean `hasSecret`.
// Rate limits: 10 active keys per vendor + 5 creates/hour; test pings 6/hour
// per vendor. Every mutation is audited.
import crypto from "crypto"
import { z } from "zod"
import { route } from "./registry"
import { Deny } from "../rbac"
import { audit } from "../audit"
import { db } from "@/lib/db"
import { rateLimit, resolveOutboundUrl } from "../security"
import { encryptField } from "../crypto-field"
import { attemptDelivery } from "../webhooks"

// ---------- fixed registries (v1 surface — additive only) ----------
/** Scopes an API key can carry; each /api/v1 route requires exactly one. */
export const API_SCOPES = ["employees:read", "attendance:read", "attendance:write", "leave:read", "leave:write"] as const
/** Events a webhook endpoint can subscribe to ("test.ping" is synthetic —
 *  fired only by integrations.webhooks.test, never subscribable). */
export const WEBHOOK_EVENTS = ["employee.created", "employee.updated", "leave.requested", "voucher.posted", "invoice.paid"] as const

const MAX_KEYS_PER_VENDOR = 10
const KEY_CREATES_PER_HOUR = 5
const WEBHOOK_TESTS_PER_HOUR = 6
const SECRET_CONTEXT = "webhooks::v1"

function parseJsonArray(raw: string): string[] {
  try {
    const v = JSON.parse(raw || "[]")
    return Array.isArray(v) ? v.map(String) : []
  } catch {
    return []
  }
}

// ---------- FEATURE 1: API keys ----------

route("integrations.keys.list", {
  perm: ["integrations", "view"],
  schema: z.object({}).strict(),
  handler: async (ctx) => {
    // hash is NEVER selected — a list response can never leak key material
    const rows = await db.apiKey.findMany({
      where: { vendorId: ctx.vendorId, revokedAt: null },
      orderBy: { createdAt: "desc" },
      select: { id: true, name: true, prefix: true, scopesJson: true, lastUsedAt: true, createdByName: true, createdAt: true },
    })
    return {
      scopes: API_SCOPES,
      keys: rows.map((r) => ({ ...r, scopes: parseJsonArray(r.scopesJson), scopesJson: undefined })),
    }
  },
})

route("integrations.keys.create", {
  perm: ["integrations", "create"],
  schema: z.object({
    name: z.string().trim().min(1).max(60),
    scopes: z.array(z.enum(API_SCOPES)).min(1).max(API_SCOPES.length),
  }).strict(),
  handler: async (ctx, p) => {
    const active = await db.apiKey.count({ where: { vendorId: ctx.vendorId, revokedAt: null } })
    if (active >= MAX_KEYS_PER_VENDOR) {
      throw new Deny(`API key limit reached — at most ${MAX_KEYS_PER_VENDOR} active keys per workspace. Revoke one first.`, 400)
    }
    if (await rateLimit(`apikey:create:${ctx.vendorId}`, KEY_CREATES_PER_HOUR, 3_600_000)) {
      throw new Deny(`Too many API keys created this hour (limit ${KEY_CREATES_PER_HOUR}) — try again later`, 429)
    }
    // `fk_` + 32 url-safe random chars; prefix = first 12 chars INCLUDING "fk_"
    for (let i = 0; i < 5; i++) {
      const raw = `fk_${crypto.randomBytes(24).toString("base64url")}`
      const prefix = raw.slice(0, 12)
      const hash = crypto.createHash("sha256").update(raw, "utf8").digest("hex")
      try {
        const rec = await db.apiKey.create({
          data: {
            vendorId: ctx.vendorId,
            name: p.name,
            prefix,
            hash,
            scopesJson: JSON.stringify([...new Set(p.scopes)]),
            createdById: ctx.userId,
            createdByName: ctx.userName,
          },
        })
        await audit(ctx, "INTEGRATION_KEY_CREATE", "ApiKey", rec.id,
          `Created API key "${p.name}" (${prefix}…) with scopes ${[...new Set(p.scopes)].join(", ")}`)
        // the ONLY time the raw key is ever returned — never persisted, never shown again
        return { id: rec.id, key: raw, prefix, scopes: [...new Set(p.scopes)] }
      } catch (e: any) {
        if (String(e?.code) === "P2002") continue // prefix collision — regenerate and retry
        throw e
      }
    }
    throw new Deny("Could not allocate a unique key prefix — try again", 500)
  },
})

route("integrations.keys.revoke", {
  perm: ["integrations", "delete"],
  schema: z.object({ id: z.string().min(1) }).strict(),
  handler: async (ctx, p) => {
    const rec = await db.apiKey.findFirst({ where: { id: p.id, vendorId: ctx.vendorId } })
    if (!rec) throw new Deny("API key not found", 404)
    if (rec.revokedAt) throw new Deny("API key is already revoked", 400)
    const revokedAt = new Date()
    await db.apiKey.update({ where: { id: rec.id }, data: { revokedAt } })
    await audit(ctx, "INTEGRATION_KEY_REVOKE", "ApiKey", rec.id,
      `Revoked API key "${rec.name}" (${rec.prefix}…) — requests using it now fail with 401`)
    return { id: rec.id, revokedAt: revokedAt.toISOString() }
  },
})

// ---------- FEATURE 2: webhook endpoints + deliveries ----------

route("integrations.webhooks.list", {
  perm: ["integrations", "view"],
  schema: z.object({}).strict(),
  handler: async (ctx) => {
    const [endpoints, deliveries] = await Promise.all([
      db.webhookEndpoint.findMany({
        where: { vendorId: ctx.vendorId },
        orderBy: { createdAt: "desc" },
        // secret is selected ONLY to derive the hasSecret boolean — it never leaves
        select: { id: true, url: true, eventsJson: true, secret: true, active: true, description: true, lastStatus: true, lastDeliveredAt: true, createdAt: true },
      }),
      db.webhookDelivery.findMany({
        where: { vendorId: ctx.vendorId },
        orderBy: { createdAt: "desc" },
        take: 20,
        select: { id: true, endpointId: true, event: true, status: true, responseStatus: true, responseBody: true, attempts: true, nextAttemptAt: true, deliveredAt: true, createdAt: true },
      }),
    ])
    return {
      events: WEBHOOK_EVENTS,
      endpoints: endpoints.map((e) => ({
        id: e.id,
        url: e.url,
        events: parseJsonArray(e.eventsJson),
        hasSecret: !!e.secret,
        active: e.active,
        description: e.description,
        lastStatus: e.lastStatus,
        lastDeliveredAt: e.lastDeliveredAt,
        createdAt: e.createdAt,
      })),
      deliveries,
    }
  },
})

route("integrations.webhooks.save", {
  perm: ["integrations", "edit"],
  schema: z.object({
    id: z.string().min(1).optional(),
    url: z.string().trim().min(1).max(500),
    events: z.array(z.enum(WEBHOOK_EVENTS)).min(1).max(WEBHOOK_EVENTS.length),
    description: z.string().max(200).optional(),
    active: z.boolean(),
  }).strict(),
  handler: async (ctx, p) => {
    // SEC-6 (Phase 3 WS-E) — save-time validation now RESOLVES the hostname
    // and rejects private RESOLVED addresses too (the send-time guard applies
    // the same rule on every delivery, catching post-save DNS repointing).
    const check = await resolveOutboundUrl(p.url)
    if (!check.ok) throw new Deny(check.reason, 400)
    const url = check.url.toString()
    const description = (p.description || "").trim() || null
    const events = [...new Set(p.events)]
    if (p.id) {
      const existing = await db.webhookEndpoint.findFirst({ where: { id: p.id, vendorId: ctx.vendorId } })
      if (!existing) throw new Deny("Webhook endpoint not found", 404)
      // update keeps the existing signing secret (rotation = delete + recreate)
      const rec = await db.webhookEndpoint.update({
        where: { id: existing.id },
        data: { url, eventsJson: JSON.stringify(events), description, active: p.active },
      })
      await audit(ctx, "WEBHOOK_SAVE", "WebhookEndpoint", rec.id,
        `Updated webhook ${url} — events ${events.join(", ")}${p.active ? "" : " (paused)"}`,
        {
          oldValue: { url: existing.url, events: parseJsonArray(existing.eventsJson), active: existing.active, description: existing.description },
          newValue: { url, events, active: p.active, description },
        })
      return { id: rec.id, url, events, active: p.active, description, hasSecret: !!existing.secret, secretRotated: false }
    }
    // create — generate + encrypt the signing secret, return the RAW secret ONCE
    const rawSecret = crypto.randomBytes(16).toString("hex") // 32 chars
    let encrypted: string
    try {
      encrypted = encryptField(rawSecret, SECRET_CONTEXT)
    } catch {
      throw new Deny("Server encryption key (HRM_MFA_KEY) is not configured — webhook signing secrets cannot be stored safely. Ask your administrator to set it and try again.", 500)
    }
    const rec = await db.webhookEndpoint.create({
      data: { vendorId: ctx.vendorId, url, eventsJson: JSON.stringify(events), secret: encrypted, active: p.active, description },
    })
    await audit(ctx, "WEBHOOK_SAVE", "WebhookEndpoint", rec.id,
      `Created webhook ${url} — events ${events.join(", ")}${p.active ? "" : " (paused)"}`,
      { newValue: { url, events, active: p.active, description } })
    return { id: rec.id, url, events, active: p.active, description, hasSecret: true, secret: rawSecret }
  },
})

route("integrations.webhooks.delete", {
  perm: ["integrations", "delete"],
  schema: z.object({ id: z.string().min(1) }).strict(),
  handler: async (ctx, p) => {
    const existing = await db.webhookEndpoint.findFirst({ where: { id: p.id, vendorId: ctx.vendorId } })
    if (!existing) throw new Deny("Webhook endpoint not found", 404)
    await db.webhookEndpoint.delete({ where: { id: existing.id } })
    // delivery rows are KEPT — they are the historical record of what was sent;
    // still-pending rows for this endpoint are failed cleanly by the flusher
    await audit(ctx, "WEBHOOK_DELETE", "WebhookEndpoint", existing.id,
      `Deleted webhook ${existing.url} — events ${parseJsonArray(existing.eventsJson).join(", ")}`,
      { oldValue: { url: existing.url, events: parseJsonArray(existing.eventsJson), active: existing.active, description: existing.description } })
    return { id: existing.id }
  },
})

route("integrations.webhooks.test", {
  perm: ["integrations", "edit"],
  schema: z.object({ id: z.string().min(1) }).strict(),
  handler: async (ctx, p) => {
    const ep = await db.webhookEndpoint.findFirst({ where: { id: p.id, vendorId: ctx.vendorId } })
    if (!ep) throw new Deny("Webhook endpoint not found", 404)
    if (await rateLimit(`webhook:test:${ctx.vendorId}`, WEBHOOK_TESTS_PER_HOUR, 3_600_000)) {
      throw new Deny(`Test ping limit reached (${WEBHOOK_TESTS_PER_HOUR} per hour) — try again later`, 429)
    }
    // synthetic test.ping delivery — recorded in the log, sent NOW via the exact
    // same signing/bookkeeping path as a real event delivery
    const payload = {
      event: "test.ping",
      createdAt: new Date().toISOString(),
      data: { ping: true, endpointId: ep.id, note: "Synthetic test delivery from HR Settings → Integrations" },
    }
    const delivery = await db.webhookDelivery.create({
      data: { vendorId: ctx.vendorId, endpointId: ep.id, event: "test.ping", payloadJson: JSON.stringify(payload) },
    })
    const r = await attemptDelivery(delivery)
    await audit(ctx, "WEBHOOK_TEST", "WebhookEndpoint", ep.id,
      `Test ping to ${ep.url} → ${r.attempted ? (r.ok ? `delivered (HTTP ${r.status})` : `failed (${r.detail})`) : r.detail}`)
    return { deliveryId: delivery.id, ok: r.ok, status: r.status, detail: r.detail }
  },
})

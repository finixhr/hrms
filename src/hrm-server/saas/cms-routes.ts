// ============ Website CMS owner routes (owner.cms.*) ============
// Registered into the same dispatcher as every other owner action:
// session → CSRF echo → permission gate → zod parse → handler → audit.
// All writes invalidate the public-site cache (src/hrm-server/saas/cms.ts)
// so changes go live on the next request — no rebuild, no redeploy.
import { z } from "zod"
import { createHmac } from "node:crypto"
import type { Prisma } from "@prisma/client"
import { db } from "@/lib/db"
import { ownerAction } from "./owner-routes"
import { saasAudit } from "./audit"
import type { OwnerCtx } from "./owner-auth"
import { invalidateCmsCache } from "./cms"
import { FEATURE_VISUAL_KEYS } from "./cms-defaults"

// V6-002: Shared safe-href validator — blocks javascript: and data: schemes.
const safeHref = z.string().max(300).refine(
  (v) => !v || /^(https?:\/\/|\/|#)/.test(v),
  { message: "Href must be a relative path (#, /...) or an http(s) URL" }
)
import {
  decodeMediaData, normalizeFolder, normalizeTags, readImageSize, sha256Hex,
  sniffMediaMime, slugifySeoFilename, type ImageSize,
} from "./media-backfill"

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const MAX_IMAGE_BYTES = 400 * 1024 // 400 KB raw → ~533 KB base64 (fits the 1 MB API cap)
const ALLOWED_MEDIA_TYPES = ["image/png", "image/jpeg", "image/webp", "image/svg+xml", "image/x-icon", "image/vnd.microsoft.icon", "image/ico"]

function err(code: number, message: string): never {
  const e = new Error(message) as Error & { code?: number }
  e.code = code
  throw e
}

function parseOr<T>(raw: string, fallback: T): T {
  try { return JSON.parse(raw) as T } catch { return fallback }
}

// ------------------------------ shared zod shapes ------------------------------

const blockData = z.record(z.string(), z.unknown())

const cmsBlock = z.object({
  id: z.string().min(1).max(80),
  type: z.enum([
    "hero", "stats", "value-props", "features", "feature-demo", "how-it-works",
    "clients", "testimonials", "cta", "faq", "pricing", "contact-form",
    "text", "text-image", "cards", "logos", "custom-html",
  ]),
  visible: z.boolean().default(true),
  data: blockData.default({}),
})

const featureContent = z.object({
  problem: z.array(z.string().max(2000)).max(12).default([]),
  solution: z.array(z.string().max(2000)).max(12).default([]),
  capabilities: z.array(z.object({
    title: z.string().max(200),
    items: z.array(z.string().max(500)).max(20),
  })).max(8).default([]),
  workflow: z.array(z.object({
    title: z.string().max(200),
    body: z.string().max(2000),
  })).max(10).default([]),
  security: z.array(z.string().max(2000)).max(12).default([]),
  cta: z.object({ primary: z.string().max(200), secondary: z.string().max(200) }).default({ primary: "", secondary: "" }),
}).passthrough()

// ============================== OVERVIEW ==============================

ownerAction("owner.cms.overview", {
  perm: "cms.view",
  handler: async () => {
    const [pages, features, clients, testimonials, media, settingsRows] = await Promise.all([
      db.saasCmsPage.count(),
      db.saasCmsFeature.count(),
      db.saasCmsClient.count(),
      db.saasCmsTestimonial.count(),
      db.saasCmsMedia.count(),
      db.saasSiteSetting.count(),
    ])
    const lastUpdated = await db.saasCmsPage.findMany({ orderBy: { updatedAt: "desc" }, take: 1, select: { updatedAt: true } })
    const seeded = settingsRows > 0 || features > 0
    return { counts: { pages, features, clients, testimonials, media }, seeded, lastUpdatedAt: lastUpdated[0]?.updatedAt?.toISOString() ?? null }
  },
})

// ============================== SITE SETTINGS ==============================

const identitySchema = z.object({
  siteName: z.string().trim().min(1).max(80),
  tagline: z.string().max(200).default(""),
  description: z.string().max(2000).default(""),
  company: z.string().max(120).default(""),
  country: z.string().max(80).default(""),
  supportEmail: z.string().max(160).default(""),
  supportPhone: z.string().max(60).default(""),
  address: z.string().max(300).default(""),
  logoUrl: z.string().max(600_000).default("/logo.svg"), // media:<id> | data URL | path
  faviconUrl: z.string().max(600_000).default("/logo.svg"),
  navCtaLabel: z.string().max(60).default("Get Started"),
  navCtaHref: z.string().max(300).default("/register"),
  navSignInLabel: z.string().max(60).default("Sign in"),
  navSignInHref: z.string().max(300).default("/login"),
})

const navSchema = z.object({
  nav: z.array(z.object({
    label: z.string().trim().min(1).max(60),
    href: safeHref, // V6-002: blocks javascript: scheme
    children: z.array(z.object({
      label: z.string().max(60),
      href: safeHref, // V6-002
      desc: z.string().max(200).optional(),
    })).max(24).optional(),
  })).max(20),
})

const footerSchema = z.object({
  groups: z.array(z.object({
    title: z.string().trim().min(1).max(60),
    links: z.array(z.object({
      label: z.string().max(80),
      href: safeHref, // V6-002: blocks javascript: scheme
    })).max(16),
  })).max(8),
  note: z.string().max(1000).default(""),
})

const seoSchema = z.object({
  metaTitle: z.string().max(200).default(""),
  metaDescription: z.string().max(400).default(""),
  keywords: z.array(z.string().max(60)).max(30).default([]),
  ogTitle: z.string().max(200).default(""),
  ogDescription: z.string().max(400).default(""),
})

const contactSchema = z.object({
  heading: z.string().max(200).default(""),
  sub: z.string().max(1000).default(""),
  phone: z.string().max(60).default(""),
  email: z.string().max(160).default(""),
  address: z.string().max(300).default(""),
  hours: z.string().max(120).default(""),
  showForm: z.boolean().default(true),
})

const hexColorSchema = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, "6-digit hex color like #818cf8")

const cursorSchema = z.object({
  enabled: z.boolean().default(true),
  // Wave 11 §12 — aurora-trail ("Aurora Trail") + magnetic-spark ("Magnetic
  // Spark") join the catalog; COMET is now the platform default effect for
  // the public marketing website. Exported for the wave11 regression tests
  // (tests/unit/wave11-scalability.test.ts) so the enum contract is pinned.
  style: z.enum(["aurora", "comet", "classic", "aurora-trail", "magnetic-spark"]).default("comet"),
  primaryColor: hexColorSchema.default("#818cf8"),
  accentColor: hexColorSchema.default("#a78bfa"),
  pullStrength: z.number().min(0).max(10).default(5),
  trailIntensity: z.number().min(0).max(100).default(65),
  glow: z.number().min(0).max(100).default(65),
  magnetic: z.boolean().default(true),
  tilt: z.boolean().default(true),
  ripple: z.boolean().default(true),
  viewLabels: z.boolean().default(true),
  viewLabel: z.string().trim().min(1).max(8).default("VIEW"),
})
export { cursorSchema }

async function saveSiteSetting(key: string, value: unknown) {
  await db.saasSiteSetting.upsert({
    where: { key },
    create: { key, value: JSON.stringify(value) },
    update: { value: JSON.stringify(value) },
  })
}

ownerAction("owner.cms.settings.get", {
  perm: "cms.view",
  handler: async () => {
    const rows = await db.saasSiteSetting.findMany()
    const out: Record<string, unknown> = {}
    for (const row of rows) out[row.key] = parseOr(row.value, null)
    return { settings: out }
  },
})

async function saveSettingsKey(ctx: OwnerCtx, key: string, value: unknown) {
  await saveSiteSetting(key, value)
  invalidateCmsCache()
  await saasAudit(ctx, "CMS_SETTINGS_SAVED", "SaasSiteSetting", key, `Website ${key} settings saved`, { metadata: { key } })
}

ownerAction("owner.cms.identity.save", {
  perm: "cms.manage",
  schema: z.object({ identity: identitySchema }),
  handler: async (ctx, payload) => saveSettingsKey(ctx, "identity", payload.identity),
})

ownerAction("owner.cms.nav.save", {
  perm: "cms.manage",
  schema: navSchema,
  handler: async (ctx, payload) => saveSettingsKey(ctx, "nav", payload.nav),
})

ownerAction("owner.cms.footer.save", {
  perm: "cms.manage",
  schema: z.object({ footer: footerSchema }),
  handler: async (ctx, payload) => saveSettingsKey(ctx, "footer", payload.footer),
})

ownerAction("owner.cms.seo.save", {
  perm: "cms.manage",
  schema: z.object({ seo: seoSchema }),
  handler: async (ctx, payload) => saveSettingsKey(ctx, "seo", payload.seo),
})

ownerAction("owner.cms.contact.save", {
  perm: "cms.manage",
  schema: z.object({ contact: contactSchema }),
  handler: async (ctx, payload) => saveSettingsKey(ctx, "contact", payload.contact),
})

ownerAction("owner.cms.cursor.save", {
  perm: "cms.manage",
  schema: z.object({ cursor: cursorSchema }),
  handler: async (ctx, payload) => saveSettingsKey(ctx, "cursor", payload.cursor),
})

// ============================== PAGES ==============================

const pageSaveSchema = z.object({
  id: z.string().optional(),
  slug: z.string().regex(SLUG_RE, "lowercase-kebab-case only").max(120),
  title: z.string().trim().min(1).max(160),
  pageType: z.enum(["HOME", "SYSTEM", "CUSTOM"]).default("CUSTOM"),
  status: z.enum(["DRAFT", "PUBLISHED"]).default("DRAFT"),
  visible: z.boolean().default(true),
  sortOrder: z.number().int().min(0).max(9999).default(0),
  showInNav: z.boolean().default(false),
  navLabel: z.string().max(60).nullable().default(null),
  seoTitle: z.string().max(200).nullable().default(null),
  seoDesc: z.string().max(400).nullable().default(null),
  blocks: z.array(cmsBlock).max(40).default([]),
})

ownerAction("owner.cms.pages.list", {
  perm: "cms.view",
  handler: async () => {
    const rows = await db.saasCmsPage.findMany({ orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] })
    return {
      pages: rows.map((r) => ({
        ...r,
        blocks: parseOr(r.blocks, []),
        updatedAt: r.updatedAt.toISOString(),
        createdAt: r.createdAt.toISOString(),
      })),
    }
  },
})

ownerAction("owner.cms.pages.save", {
  perm: "cms.manage",
  schema: pageSaveSchema,
  handler: async (ctx, payload) => {
    const { id, ...rest } = payload as z.infer<typeof pageSaveSchema> & { id?: string }
    const blocks = JSON.stringify(rest.blocks)
    // slug conflicts
    const clash = await db.saasCmsPage.findFirst({ where: { slug: rest.slug, NOT: id ? { id } : undefined } })
    if (clash) err(400, `Slug "${rest.slug}" is already used by another page`)
    // system pages keep their identity
    if (id) {
      const existing = await db.saasCmsPage.findUnique({ where: { id } })
      if (!existing) err(404, "Page not found")
      if (existing.isSystem) {
        if (existing.slug !== rest.slug) err(400, "System page slugs cannot change")
      }
      const row = await db.saasCmsPage.update({
        where: { id },
        data: { ...rest, slug: existing.isSystem ? existing.slug : rest.slug, blocks },
      })
      invalidateCmsCache()
      await saasAudit(ctx, "CMS_PAGE_SAVED", "SaasCmsPage", row.id, `Page "${row.title}" saved (${row.status})`)
      return { page: { ...row, blocks: parseOr(row.blocks, []), updatedAt: row.updatedAt.toISOString(), createdAt: row.createdAt.toISOString() } }
    }
    const row = await db.saasCmsPage.create({ data: { ...rest, blocks } })
    invalidateCmsCache()
    await saasAudit(ctx, "CMS_PAGE_CREATED", "SaasCmsPage", row.id, `Page "${row.title}" created (${rest.slug})`)
    return { page: { ...row, blocks: parseOr(row.blocks, []), updatedAt: row.updatedAt.toISOString(), createdAt: row.createdAt.toISOString() } }
  },
})

ownerAction("owner.cms.pages.delete", {
  perm: "cms.manage",
  schema: z.object({ id: z.string() }),
  handler: async (ctx, payload) => {
    const existing = await db.saasCmsPage.findUnique({ where: { id: payload.id } })
    if (!existing) err(404, "Page not found")
    if (existing.isSystem) err(400, "System pages cannot be deleted — hide them instead")
    await db.saasCmsPage.delete({ where: { id: payload.id } })
    invalidateCmsCache()
    await saasAudit(ctx, "CMS_PAGE_DELETED", "SaasCmsPage", payload.id, `Page "${existing.title}" deleted`)
    return { ok: true }
  },
})

ownerAction("owner.cms.pages.reorder", {
  perm: "cms.manage",
  schema: z.object({ order: z.array(z.object({ id: z.string(), sortOrder: z.number().int().min(0).max(9999) })).max(100) }),
  handler: async (ctx, payload) => {
    const { order } = payload as { order: { id: string; sortOrder: number }[] }
    await db.$transaction(order.map((o) => db.saasCmsPage.update({ where: { id: o.id }, data: { sortOrder: o.sortOrder } })))
    invalidateCmsCache()
    await saasAudit(ctx, "CMS_PAGES_REORDERED", "SaasCmsPage", "batch", `${order.length} pages reordered`)
    return { ok: true }
  },
})

ownerAction("owner.cms.pages.publish", {
  perm: "cms.manage",
  schema: z.object({ id: z.string(), status: z.enum(["DRAFT", "PUBLISHED"]) }),
  handler: async (ctx, payload) => {
    const row = await db.saasCmsPage.update({ where: { id: payload.id }, data: { status: payload.status } })
    if (!row) err(404, "Page not found")
    invalidateCmsCache()
    await saasAudit(ctx, "CMS_PAGE_PUBLISH_STATE", "SaasCmsPage", row.id, `Page "${row.title}" → ${payload.status}`)
    return { ok: true }
  },
})

// ============================== FEATURES ==============================

const featureSaveSchema = z.object({
  id: z.string().optional(),
  slug: z.string().regex(SLUG_RE, "lowercase-kebab-case only").max(120),
  title: z.string().trim().min(1).max(160),
  navLabel: z.string().max(80).default(""),
  headline: z.string().max(300).default(""),
  sub: z.string().max(2000).default(""),
  visual: z.enum(FEATURE_VISUAL_KEYS).nullable().default(null),
  icon: z.string().max(40).default("star"),
  accent: z.enum(["blue", "indigo", "violet", "cyan", "emerald", "amber", "rose", "orange"]).default("blue"),
  sortOrder: z.number().int().min(0).max(9999).default(0),
  visible: z.boolean().default(true),
  showOnHome: z.boolean().default(true),
  content: featureContent,
})

ownerAction("owner.cms.features.list", {
  perm: "cms.view",
  handler: async () => {
    const rows = await db.saasCmsFeature.findMany({ orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] })
    return {
      features: rows.map((r) => ({ ...r, content: parseOr(r.content, {}), updatedAt: r.updatedAt.toISOString(), createdAt: r.createdAt.toISOString() })),
      visualKeys: FEATURE_VISUAL_KEYS,
    }
  },
})

ownerAction("owner.cms.features.save", {
  perm: "cms.manage",
  schema: featureSaveSchema,
  handler: async (ctx, payload) => {
    const { id, ...rest } = payload as z.infer<typeof featureSaveSchema> & { id?: string }
    const content = JSON.stringify(rest.content)
    const clash = await db.saasCmsFeature.findFirst({ where: { slug: rest.slug, NOT: id ? { id } : undefined } })
    if (clash) err(400, `Slug "${rest.slug}" is already used by another feature`)
    if (id) {
      const existing = await db.saasCmsFeature.findUnique({ where: { id } })
      if (!existing) err(404, "Feature not found")
      const row = await db.saasCmsFeature.update({ where: { id }, data: { ...rest, content } })
      invalidateCmsCache()
      await saasAudit(ctx, "CMS_FEATURE_SAVED", "SaasCmsFeature", row.id, `Feature "${row.title}" saved`)
      return { feature: { ...row, content: parseOr(row.content, {}), updatedAt: row.updatedAt.toISOString(), createdAt: row.createdAt.toISOString() } }
    }
    const row = await db.saasCmsFeature.create({ data: { ...rest, content } })
    invalidateCmsCache()
    await saasAudit(ctx, "CMS_FEATURE_CREATED", "SaasCmsFeature", row.id, `Feature "${row.title}" created (${rest.slug})`)
    return { feature: { ...row, content: parseOr(row.content, {}), updatedAt: row.updatedAt.toISOString(), createdAt: row.createdAt.toISOString() } }
  },
})

ownerAction("owner.cms.features.delete", {
  perm: "cms.manage",
  schema: z.object({ id: z.string() }),
  handler: async (ctx, payload) => {
    const existing = await db.saasCmsFeature.findUnique({ where: { id: payload.id } })
    if (!existing) err(404, "Feature not found")
    await db.saasCmsFeature.delete({ where: { id: payload.id } })
    invalidateCmsCache()
    await saasAudit(ctx, "CMS_FEATURE_DELETED", "SaasCmsFeature", payload.id, `Feature "${existing.title}" deleted`)
    return { ok: true }
  },
})

ownerAction("owner.cms.features.reorder", {
  perm: "cms.manage",
  schema: z.object({ order: z.array(z.object({ id: z.string(), sortOrder: z.number().int().min(0).max(9999) })).max(100) }),
  handler: async (ctx, payload) => {
    const { order } = payload as { order: { id: string; sortOrder: number }[] }
    await db.$transaction(order.map((o) => db.saasCmsFeature.update({ where: { id: o.id }, data: { sortOrder: o.sortOrder } })))
    invalidateCmsCache()
    await saasAudit(ctx, "CMS_FEATURES_REORDERED", "SaasCmsFeature", "batch", `${order.length} features reordered`)
    return { ok: true }
  },
})

// ============================== CLIENTS ==============================

const clientSaveSchema = z.object({
  id: z.string().optional(),
  name: z.string().trim().min(1).max(160),
  industry: z.string().max(120).default(""),
  description: z.string().max(1000).default(""),
  story: z.string().max(20_000).nullable().default(null),
  quote: z.string().max(2000).nullable().default(null),
  personName: z.string().max(120).nullable().default(null),
  personRole: z.string().max(120).nullable().default(null),
  metrics: z.array(z.object({ label: z.string().max(80), value: z.string().max(80) })).max(8).default([]),
  logoText: z.string().max(8).nullable().default(null),
  logoColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).default("#2563eb"),
  logoUrl: z.string().max(600_000).nullable().default(null),
  website: z.string().max(300).nullable().default(null),
  featured: z.boolean().default(false),
  visible: z.boolean().default(true),
  sortOrder: z.number().int().min(0).max(9999).default(0),
})

ownerAction("owner.cms.clients.list", {
  perm: "cms.view",
  handler: async () => {
    const rows = await db.saasCmsClient.findMany({ orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] })
    return { clients: rows.map((r) => ({ ...r, metrics: parseOr(r.metrics, []), updatedAt: r.updatedAt.toISOString(), createdAt: r.createdAt.toISOString() })) }
  },
})

ownerAction("owner.cms.clients.save", {
  perm: "cms.manage",
  schema: clientSaveSchema,
  handler: async (ctx, payload) => {
    const { id, ...rest } = payload as z.infer<typeof clientSaveSchema> & { id?: string }
    const metrics = JSON.stringify(rest.metrics)
    if (id) {
      const row = await db.saasCmsClient.update({ where: { id }, data: { ...rest, metrics } })
      if (!row) err(404, "Client not found")
      invalidateCmsCache()
      await saasAudit(ctx, "CMS_CLIENT_SAVED", "SaasCmsClient", row.id, `Client "${row.name}" saved`)
      return { client: { ...row, metrics: parseOr(row.metrics, []), updatedAt: row.updatedAt.toISOString(), createdAt: row.createdAt.toISOString() } }
    }
    const row = await db.saasCmsClient.create({ data: { ...rest, metrics } })
    invalidateCmsCache()
    await saasAudit(ctx, "CMS_CLIENT_CREATED", "SaasCmsClient", row.id, `Client "${row.name}" created`)
    return { client: { ...row, metrics: parseOr(row.metrics, []), updatedAt: row.updatedAt.toISOString(), createdAt: row.createdAt.toISOString() } }
  },
})

ownerAction("owner.cms.clients.delete", {
  perm: "cms.manage",
  schema: z.object({ id: z.string() }),
  handler: async (ctx, payload) => {
    const existing = await db.saasCmsClient.findUnique({ where: { id: payload.id } })
    if (!existing) err(404, "Client not found")
    await db.saasCmsClient.delete({ where: { id: payload.id } })
    invalidateCmsCache()
    await saasAudit(ctx, "CMS_CLIENT_DELETED", "SaasCmsClient", payload.id, `Client "${existing.name}" deleted`)
    return { ok: true }
  },
})

ownerAction("owner.cms.clients.reorder", {
  perm: "cms.manage",
  schema: z.object({ order: z.array(z.object({ id: z.string(), sortOrder: z.number().int().min(0).max(9999) })).max(200) }),
  handler: async (ctx, payload) => {
    const { order } = payload as { order: { id: string; sortOrder: number }[] }
    await db.$transaction(order.map((o) => db.saasCmsClient.update({ where: { id: o.id }, data: { sortOrder: o.sortOrder } })))
    invalidateCmsCache()
    await saasAudit(ctx, "CMS_CLIENTS_REORDERED", "SaasCmsClient", "batch", `${order.length} clients reordered`)
    return { ok: true }
  },
})

// ============================== TESTIMONIALS ==============================

const testimonialSaveSchema = z.object({
  id: z.string().optional(),
  clientName: z.string().trim().min(1).max(160),
  personName: z.string().max(120).default(""),
  personRole: z.string().max(120).default(""),
  quote: z.string().min(1).max(3000),
  rating: z.number().int().min(1).max(5).default(5),
  visible: z.boolean().default(true),
  sortOrder: z.number().int().min(0).max(9999).default(0),
})

ownerAction("owner.cms.testimonials.list", {
  perm: "cms.view",
  handler: async () => {
    const rows = await db.saasCmsTestimonial.findMany({ orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] })
    return { testimonials: rows.map((r) => ({ ...r, updatedAt: r.updatedAt.toISOString(), createdAt: r.createdAt.toISOString() })) }
  },
})

ownerAction("owner.cms.testimonials.save", {
  perm: "cms.manage",
  schema: testimonialSaveSchema,
  handler: async (ctx, payload) => {
    const { id, ...rest } = payload as z.infer<typeof testimonialSaveSchema> & { id?: string }
    if (id) {
      const row = await db.saasCmsTestimonial.update({ where: { id }, data: rest })
      if (!row) err(404, "Testimonial not found")
      invalidateCmsCache()
      await saasAudit(ctx, "CMS_TESTIMONIAL_SAVED", "SaasCmsTestimonial", row.id, `Testimonial from "${row.clientName}" saved`)
      return { testimonial: { ...row, updatedAt: row.updatedAt.toISOString(), createdAt: row.createdAt.toISOString() } }
    }
    const row = await db.saasCmsTestimonial.create({ data: rest })
    invalidateCmsCache()
    await saasAudit(ctx, "CMS_TESTIMONIAL_CREATED", "SaasCmsTestimonial", row.id, `Testimonial from "${row.clientName}" created`)
    return { testimonial: { ...row, updatedAt: row.updatedAt.toISOString(), createdAt: row.createdAt.toISOString() } }
  },
})

ownerAction("owner.cms.testimonials.delete", {
  perm: "cms.manage",
  schema: z.object({ id: z.string() }),
  handler: async (ctx, payload) => {
    const existing = await db.saasCmsTestimonial.findUnique({ where: { id: payload.id } })
    if (!existing) err(404, "Testimonial not found")
    await db.saasCmsTestimonial.delete({ where: { id: payload.id } })
    invalidateCmsCache()
    await saasAudit(ctx, "CMS_TESTIMONIAL_DELETED", "SaasCmsTestimonial", payload.id, `Testimonial from "${existing.clientName}" deleted`)
    return { ok: true }
  },
})

ownerAction("owner.cms.testimonials.reorder", {
  perm: "cms.manage",
  schema: z.object({ order: z.array(z.object({ id: z.string(), sortOrder: z.number().int().min(0).max(9999) })).max(200) }),
  handler: async (ctx, payload) => {
    const { order } = payload as { order: { id: string; sortOrder: number }[] }
    await db.$transaction(order.map((o) => db.saasCmsTestimonial.update({ where: { id: o.id }, data: { sortOrder: o.sortOrder } })))
    invalidateCmsCache()
    await saasAudit(ctx, "CMS_TESTIMONIALS_REORDERED", "SaasCmsTestimonial", "batch", `${order.length} testimonials reordered`)
    return { ok: true }
  },
})

// ============================== MEDIA (WP-Q — Media Library 2.0) ==============================
// Upload pipeline: decode → byte-sniff (declared mime must match the bytes) →
// sha256 over the decoded payload → DUPLICATE CHECK (reject with a pointer to
// the original row — never store a second copy) → intrinsic dimensions from a
// pure-TS header reader → optional AVIF/WebP variants via sharp (gracefully
// skipped with an honest note when sharp is unavailable — NEVER faked) →
// storage (LOCAL inline data URL by default; S3-compatible target via
// SAAS_S3_* env vars with AWS SigV4 signed in pure TS) → row + audit.
//
// Compatibility contract: every response is ADDITIVE over the Wave-1 shapes —
// media.list keeps {media:[{id,name,mimeType,size,createdAt,preview}]}
// (preview still truncated at 200k chars), upload keeps {media:{…preview}}
// (the duplicate path points `media` at the EXISTING row so the Website
// Studio picker transparently attaches the original), delete keeps {ok:true}
// for unreferenced media. media:<id> resolution in cms.ts is untouched.

type MediaRow = {
  id: string; name: string; mimeType: string; size: number; data: string
  folder: string; tags: string; alt: string | null
  width: number | null; height: number | null; sizeBytes: number | null
  sha256: string | null; seoFilename: string | null; variantsJson: string | null
  createdAt: Date
}

type MediaVariant = { kind: "webp" | "avif"; width: number; mime: string; data: string }

function parseVariants(raw: string | null): MediaVariant[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter((v): v is MediaVariant =>
      !!v && typeof v === "object" && typeof (v as MediaVariant).kind === "string" &&
      typeof (v as MediaVariant).width === "number" && typeof (v as MediaVariant).mime === "string" &&
      typeof (v as MediaVariant).data === "string")
  } catch {
    return []
  }
}

/** Metadata serialization shared by list (truncated preview) and the
 * upload/update/duplicate responses (full preview — the studio picker renders
 * it directly). Additive over the Wave-1 fields, never narrower. */
function serializeMediaMeta(r: MediaRow, fullPreview: boolean) {
  const variants = parseVariants(r.variantsJson)
  return {
    // ---- Wave-1 contract (unchanged) ----
    id: r.id, name: r.name, mimeType: r.mimeType, size: r.size,
    createdAt: r.createdAt.toISOString(),
    preview: fullPreview ? r.data : r.data.length < 200_000 ? r.data : null,
    // ---- WP-Q additive fields ----
    folder: r.folder,
    tags: parseOr(r.tags, [] as string[]),
    alt: r.alt,
    width: r.width, height: r.height, sizeBytes: r.sizeBytes,
    seoFilename: r.seoFilename,
    hasVariants: variants.length > 0,
    variantCount: variants.length,
    hashed: r.sha256 != null,
    storage: r.data.startsWith("data:") ? "local" : "external",
    url: r.data,
  }
}

// ---------------- optional sharp renditions (AVIF + WebP) ----------------

const VARIANT_WIDTHS = [480, 960, 1600]
const MAX_VARIANT_B64 = 300_000 // ~225 KB decoded per rendition
const MAX_VARIANTS_JSON = 900_000 // total renditions payload cap

type SharpFactory = typeof import("sharp")["default"]

/** Lazy, cached sharp probe. A failed native load (wrong platform, stripped
 * deployment) degrades to null — variants are then skipped with an honest
 * note; the original image is always served unchanged. */
let sharpProbe: Promise<SharpFactory | null> | null = null
function loadSharp(): Promise<SharpFactory | null> {
  sharpProbe ??= import("sharp")
    .then((m) => m.default)
    .catch((e: unknown) => {
      console.error("[cms-media] sharp unavailable — optimized variants are skipped (originals are served unchanged):", (e as Error)?.message || e)
      return null
    })
  return sharpProbe
}

async function generateVariants(buf: Buffer, dims: ImageSize): Promise<{ variants: MediaVariant[] | null; note: string | null }> {
  const sharp = await loadSharp()
  if (!sharp) {
    return { variants: null, note: "sharp is not available on this host — optimized variants were skipped and the original image is served unchanged" }
  }
  const out: MediaVariant[] = []
  const jsonLen = () => out.reduce((n, v) => n + v.data.length + 80, 2)
  const render = async (width: number, format: "webp" | "avif"): Promise<MediaVariant | null> => {
    try {
      // only downscale — a breakpoint wider than the source is never enlarged
      const pipeline = sharp(buf).resize({ width, withoutEnlargement: true })
      const b = format === "webp" ? await pipeline.webp({ quality: 82 }).toBuffer() : await pipeline.avif({ quality: 60 }).toBuffer()
      const data = b.toString("base64")
      if (b.length === 0 || data.length > MAX_VARIANT_B64) return null // honest skip, never a truncated rendition
      return { kind: format, width, mime: `image/${format}`, data }
    } catch {
      return null
    }
  }
  for (const w of VARIANT_WIDTHS) {
    if (dims.width <= w) continue
    const v = await render(w, "webp")
    if (v && jsonLen() + v.data.length + 80 <= MAX_VARIANTS_JSON) out.push(v)
  }
  if (dims.width > 960) {
    const v = await render(960, "avif")
    if (v && jsonLen() + v.data.length + 80 <= MAX_VARIANTS_JSON) out.push(v)
  }
  return out.length > 0 ? { variants: out, note: null } : { variants: null, note: null }
}

// ---------------- storage abstraction (local v1 + S3-compatible target) ----------------
// Master requirement: S3 via env vars — SAAS_S3_ENDPOINT, SAAS_S3_BUCKET,
// SAAS_S3_ACCESS_KEY_ID, SAAS_S3_SECRET_ACCESS_KEY (+ optional SAAS_S3_REGION,
// SAAS_S3_KEY_PREFIX, SAAS_S3_CDN_BASE_URL). When endpoint+bucket+credentials
// are ALL present, uploads PUT the bytes to the S3-compatible store (AWS
// Signature V4, path-style addressing — works with MinIO/R2/S3 alike) and the
// row stores the resulting PUBLIC/CDN URL in `data` instead of a base64 data
// URL; media:<id> resolution returns the stored value either way. When the
// vars are absent → LOCAL inline storage, exactly the Wave-1 behavior, and
// the upload response says "S3 not configured" honestly.
//
// HONEST LIMIT (documented, not faked): the stored URL assumes the bucket (or
// the CDN in front of it) serves anonymous GETs — no presigned GETs are
// minted at render time. Failure to PUT fails the upload loudly (502) — a row
// is never written with an unverifiable URL.

type S3Config = {
  endpoint: string; bucket: string; region: string
  accessKeyId: string; secretAccessKey: string
  keyPrefix: string; cdnBaseUrl: string | null
}

function s3ConfigFromEnv(): S3Config | null {
  const endpoint = (process.env.SAAS_S3_ENDPOINT || "").trim().replace(/\/+$/, "")
  const bucket = (process.env.SAAS_S3_BUCKET || "").trim()
  const accessKeyId = (process.env.SAAS_S3_ACCESS_KEY_ID || "").trim()
  const secretAccessKey = (process.env.SAAS_S3_SECRET_ACCESS_KEY || "").trim()
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) return null
  const keyPrefix = (process.env.SAAS_S3_KEY_PREFIX || "").trim().replace(/^\/+|\/+$/g, "")
  const cdnBaseUrl = (process.env.SAAS_S3_CDN_BASE_URL || "").trim().replace(/\/+$/, "") || null
  return { endpoint, bucket, region: (process.env.SAAS_S3_REGION || "us-east-1").trim() || "us-east-1", accessKeyId, secretAccessKey, keyPrefix, cdnBaseUrl }
}

function hmacSha256(key: Buffer, data: string): Buffer {
  return createHmac("sha256", key).update(data, "utf8").digest()
}

/** Minimal S3 PUT with AWS SigV4 (pure TS, node:crypto — no SDK dependency).
 * Signs host / x-amz-date / x-amz-content-sha256, UNSIGNED payload chunking
 * (single-shot body). Throws on any non-2xx response. */
async function s3Put(cfg: S3Config, key: string, body: Buffer, contentType: string): Promise<{ url: string; etag: string | null }> {
  const target = new URL(`${cfg.endpoint}/${cfg.bucket}/${key}`)
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, "") // 20261008T123456Z
  const dateStamp = amzDate.slice(0, 8)
  const payloadHash = sha256Hex(body)
  const canonicalHeaders = `host:${target.host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`
  const signedHeaders = "host;x-amz-content-sha256;x-amz-date"
  const canonicalRequest = `PUT\n${target.pathname}\n\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`
  const scope = `${dateStamp}/${cfg.region}/s3/aws4_request`
  const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${sha256Hex(Buffer.from(canonicalRequest, "utf8"))}`
  const signingKey = hmacSha256(hmacSha256(hmacSha256(hmacSha256(Buffer.from(`AWS4${cfg.secretAccessKey}`, "utf8"), dateStamp), cfg.region), "s3"), "aws4_request")
  const signature = hmacSha256(signingKey, stringToSign).toString("hex")
  const res = await fetch(target, {
    method: "PUT",
    headers: {
      Authorization: `AWS4-HMAC-SHA256 Credential=${cfg.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
      "x-amz-date": amzDate,
      "x-amz-content-sha256": payloadHash,
      "Content-Type": contentType,
    },
    body: new Uint8Array(body),
    signal: AbortSignal.timeout(20_000),
  })
  if (!res.ok) {
    let detail = ""
    try { detail = (await res.text()).slice(0, 300) } catch { /* unreadable body — status line is enough */ }
    throw new Error(`S3 PUT failed (${res.status} ${res.statusText})${detail ? `: ${detail}` : ""}`)
  }
  const publicUrl = cfg.cdnBaseUrl ? `${cfg.cdnBaseUrl}/${key}` : `${cfg.endpoint}/${cfg.bucket}/${key}`
  return { url: publicUrl, etag: res.headers.get("etag") }
}

/** The single storage seam: LOCAL is the always-available v1 implementation;
 * the S3 driver activates purely from env config. A future settings-backed
 * target only adds another branch here — every caller goes through put(). */
interface MediaStorageTarget {
  kind: "local" | "s3"
  put(buf: Buffer, mime: string, folder: string, seoFilename: string, sha256: string): Promise<{ data: string; note?: string }>
}

function resolveStorageTarget(): MediaStorageTarget {
  const cfg = s3ConfigFromEnv()
  if (!cfg) {
    return {
      kind: "local",
      async put(buf, mime) {
        return { data: `data:${mime};base64,${buf.toString("base64")}` }
      },
    }
  }
  return {
    kind: "s3",
    async put(buf, mime, folder, seoFilename, sha) {
      // content-addressed key: folder path + slug + short hash — collision-free
      // even when a deleted object's filename is re-uploaded later
      const folderPath = folder ? `${folder.replace(/[^a-z0-9/_-]+/gi, "-")}/` : ""
      const stem = seoFilename.replace(/\.[a-z0-9]+$/i, "")
      const ext = seoFilename.slice(stem.length + 1) || "bin"
      const key = `${cfg.keyPrefix ? `${cfg.keyPrefix}/` : ""}${folderPath}${stem}-${sha.slice(0, 10)}.${ext}`.toLowerCase()
      const { url } = await s3Put(cfg, key, buf, mime)
      return { data: url, note: `stored at s3 key ${key} (public URL — bucket/CDN must allow anonymous reads)` }
    },
  }
}

// ---------------- shared helpers ----------------

/** Uniquify an SEO filename within a folder: "logo.png" → "logo-2.png", -3 … */
async function uniqueSeoFilename(folder: string, base: string, excludeId?: string): Promise<string> {
  const stem = base.replace(/\.[a-z0-9]+$/i, "")
  const ext = base.slice(stem.length) // includes the leading dot
  let candidate = base
  for (let i = 0; i < 60; i++) {
    const clash = await db.saasCmsMedia.findFirst({
      where: { folder, seoFilename: candidate, ...(excludeId ? { id: { not: excludeId } } : {}) },
      select: { id: true },
    })
    if (!clash) return candidate
    candidate = `${stem}-${i + 2}${ext}`
  }
  return `${stem}-${Date.now().toString(36)}${ext}` // pathological fallback — still practically unique
}

/** Scan every CMS surface that can carry a "media:<id>" reference (site
 * settings JSON, page blocks, feature content, client logo/story/description,
 * testimonial quotes) — LIKE passes over the text columns. Shared by the
 * usage action and the delete guard so both always agree. */
async function scanMediaUsage(mediaId: string): Promise<{ surface: string; id: string | null; label: string; detail?: string }[]> {
  const ref = `media:${mediaId}`
  const usage: { surface: string; id: string | null; label: string; detail?: string }[] = []
  const settingRows = await db.saasSiteSetting.findMany({ where: { value: { contains: ref } } })
  for (const s of settingRows) {
    const parsed = parseOr<Record<string, unknown>>(s.value, {})
    const fields = Object.entries(parsed).filter(([, v]) => typeof v === "string" && String(v).includes(ref)).map(([k]) => k)
    usage.push({ surface: "settings", id: s.key, label: `Site settings → ${s.key}`, detail: fields.length ? `field${fields.length > 1 ? "s" : ""} ${fields.join(", ")}` : "referenced in the stored JSON" })
  }
  const pages = await db.saasCmsPage.findMany({ where: { blocks: { contains: ref } }, select: { id: true, slug: true, title: true } })
  for (const pg of pages) usage.push({ surface: "page", id: pg.id, label: `Page “${pg.title}”`, detail: `/${pg.slug} (blocks)` })
  const features = await db.saasCmsFeature.findMany({ where: { content: { contains: ref } }, select: { id: true, slug: true, title: true } })
  for (const f of features) usage.push({ surface: "feature", id: f.id, label: `Feature “${f.title}”`, detail: `/features/${f.slug}` })
  const clients = await db.saasCmsClient.findMany({
    where: { OR: [{ logoUrl: { contains: ref } }, { story: { contains: ref } }, { description: { contains: ref } }] },
    select: { id: true, name: true, logoUrl: true },
  })
  for (const c of clients) usage.push({ surface: "client", id: c.id, label: `Client “${c.name}”`, detail: c.logoUrl === ref ? "logo" : "story/description" })
  const testimonials = await db.saasCmsTestimonial.findMany({ where: { quote: { contains: ref } }, select: { id: true, clientName: true } })
  for (const t of testimonials) usage.push({ surface: "testimonial", id: t.id, label: `Testimonial from “${t.clientName}”`, detail: "quote text" })
  return usage
}

// ---------------- actions ----------------

const mediaListSchema = z.object({
  folder: z.string().max(300).optional(), // exact folder path; "" = root folder only; omitted = all folders
  tag: z.string().max(40).optional(),
  q: z.string().max(120).optional(), // name / alt / seoFilename (case-insensitive)
  page: z.number().int().min(1).max(10_000).default(1),
  pageSize: z.number().int().min(1).max(200).default(200),
})

ownerAction("owner.cms.media.list", {
  perm: "cms.view",
  schema: mediaListSchema,
  handler: async (_ctx, payload) => {
    const p = payload as z.infer<typeof mediaListSchema>
    const where: Prisma.SaasCmsMediaWhereInput = {}
    if (p.folder !== undefined) where.folder = p.folder
    if (p.tag) where.tags = { contains: `"${p.tag}"` } // tags are slug-charset only — LIKE-safe
    if (p.q) where.OR = [
      { name: { contains: p.q, mode: "insensitive" } },
      { alt: { contains: p.q, mode: "insensitive" } },
      { seoFilename: { contains: p.q, mode: "insensitive" } },
    ]
    const [rows, total, folderGroups, tagRows] = await Promise.all([
      db.saasCmsMedia.findMany({ where, orderBy: { createdAt: "desc" }, skip: (p.page - 1) * p.pageSize, take: p.pageSize }),
      db.saasCmsMedia.count({ where }),
      db.saasCmsMedia.groupBy({ by: ["folder"], _count: { _all: true } }),
      db.saasCmsMedia.findMany({ select: { tags: true }, take: 2000 }), // tag facets — bounded sweep, aggregated in JS
    ])
    const tagCounts = new Map<string, number>()
    for (const r of tagRows) for (const t of parseOr(r.tags, [] as string[])) tagCounts.set(t, (tagCounts.get(t) || 0) + 1)
    return {
      // ---- Wave-1 contract (unchanged field set; only ADDITIVE row fields) ----
      media: rows.map((r) => serializeMediaMeta(r, false)),
      // ---- WP-Q additive pagination + facets ----
      total,
      page: p.page,
      pageSize: p.pageSize,
      hasMore: p.page * p.pageSize < total,
      folders: folderGroups
        .map((g) => ({ folder: g.folder, count: g._count._all }))
        .sort((a, b) => a.folder.localeCompare(b.folder)),
      tags: [...tagCounts.entries()]
        .map(([tag, count]) => ({ tag, count }))
        .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag))
        .slice(0, 50),
    }
  },
})

const mediaUploadSchema = z.object({
  name: z.string().trim().min(1).max(160),
  dataUrl: z.string().regex(/^data:image\/[a-z+.-]+;base64,[A-Za-z0-9+/=\s]+$/, "Must be a data:image/... base64 URL"),
  // ---- WP-Q additive metadata ----
  folder: z.string().max(300).optional(),
  tags: z.array(z.string().max(60)).max(12).optional(),
  alt: z.string().max(500).optional(),
})

ownerAction("owner.cms.media.upload", {
  perm: "cms.manage",
  schema: mediaUploadSchema,
  handler: async (ctx, payload) => {
    const p = payload as z.infer<typeof mediaUploadSchema>
    const declaredMime = /^data:(image\/[a-z+.-]+);/.exec(p.dataUrl)?.[1] ?? ""
    if (!ALLOWED_MEDIA_TYPES.includes(declaredMime)) err(400, `Unsupported image type: ${declaredMime || "unknown"} (allowed: PNG, JPEG, WebP, SVG, ICO)`)
    // decode the real payload — every downstream decision is made on BYTES
    const buf = decodeMediaData(p.dataUrl)
    if (!buf || buf.length === 0) err(400, "The image payload could not be decoded as base64")
    if (buf.length > MAX_IMAGE_BYTES) err(413, `Image too large (${Math.round(buf.length / 1024)} KB decoded) — the limit is ${MAX_IMAGE_BYTES / 1024} KB`)
    // byte-level sniff (M-37 discipline): the DECLARED data-URL mime must match
    // the actual bytes — a renamed executable never rides along as an "image".
    const sniffed = sniffMediaMime(buf)
    if (!sniffed) err(400, "Unsupported file type — the content does not look like a PNG, JPEG, WebP, SVG or ICO image")
    const normalizedDeclared = declaredMime === "image/vnd.microsoft.icon" || declaredMime === "image/ico" ? "image/x-icon" : declaredMime
    if (sniffed !== normalizedDeclared) err(400, `Type mismatch: the payload declares ${declaredMime} but the bytes are ${sniffed}`)

    const sha = sha256Hex(buf)
    // DUPLICATE CHECK — identical content already in the library: reject the
    // upload with a pointer to the original row (no second copy is stored).
    // `media` in the response points at the EXISTING row so Wave-1 consumers
    // (the Website Studio picker) transparently attach the original.
    const dup = await db.saasCmsMedia.findFirst({ where: { sha256: sha }, orderBy: { createdAt: "asc" } })
    if (dup) {
      await saasAudit(ctx, "CMS_MEDIA_DUPLICATE_REJECTED", "SaasCmsMedia", dup.id, `Upload of "${p.name}" rejected — identical content already exists as "${dup.name}"`, { metadata: { sha256: sha } })
      return { duplicate: true, existingId: dup.id, existingName: dup.name, media: serializeMediaMeta(dup, true) }
    }

    const folder = normalizeFolder(p.folder)
    const tags = normalizeTags(p.tags)
    const dims = readImageSize(sniffed, buf)
    const seoFilename = await uniqueSeoFilename(folder, slugifySeoFilename(p.name, sniffed))
    // optional AVIF/WebP renditions — only when sharp imports successfully
    const { variants, note: variantNote } = dims ? await generateVariants(buf, dims) : { variants: null, note: null }
    // storage: local inline (default) or the env-configured S3-compatible target
    const storage = resolveStorageTarget()
    let stored: { data: string; note?: string }
    try {
      stored = await storage.put(buf, sniffed, folder, seoFilename, sha)
    } catch (e) {
      err(502, `Media storage failed: ${(e as Error)?.message || e}`)
    }
    const row = await db.saasCmsMedia.create({
      data: {
        name: p.name, mimeType: sniffed, size: buf.length, data: stored.data,
        folder, tags: JSON.stringify(tags), alt: p.alt?.trim() || null,
        width: dims?.width ?? null, height: dims?.height ?? null,
        sizeBytes: buf.length, sha256: sha, seoFilename,
        variantsJson: variants ? JSON.stringify(variants) : null,
      },
    })
    await saasAudit(ctx, "CMS_MEDIA_UPLOADED", "SaasCmsMedia", row.id, `Media "${row.name}" uploaded (${sniffed}, ${buf.length} B${variants ? `, ${variants.length} variant(s)` : ""})`, {
      metadata: {
        storage: storage.kind, sha256: sha,
        width: dims?.width ?? null, height: dims?.height ?? null,
        variants: variants?.length ?? 0, variantNote,
        storageNote: stored.note ?? null,
      },
    })
    return {
      media: serializeMediaMeta(row, true),
      storage: { kind: storage.kind, note: stored.note ?? (storage.kind === "local" ? "S3 not configured — stored inline as a data URL" : null) },
      variants: { count: variants?.length ?? 0, note: variantNote },
    }
  },
})

ownerAction("owner.cms.media.get", {
  perm: "cms.view",
  schema: z.object({ id: z.string() }),
  handler: async (_ctx, payload) => {
    const row = await db.saasCmsMedia.findUnique({ where: { id: payload.id } })
    if (!row) err(404, "Media not found")
    const variants = parseVariants(row.variantsJson)
    return {
      media: {
        ...serializeMediaMeta(row, true),
        sha256: row.sha256,
        variants: variants.map((v) => ({ kind: v.kind, width: v.width, mime: v.mime, dataUrl: `data:${v.mime};base64,${v.data}` })),
      },
    }
  },
})

const mediaUpdateSchema = z.object({
  id: z.string(),
  name: z.string().trim().min(1).max(160).optional(),
  alt: z.string().max(500).nullable().optional(),
  tags: z.array(z.string().max(60)).max(12).optional(),
  folder: z.string().max(300).optional(), // "" moves the item to the root folder
})

ownerAction("owner.cms.media.update", {
  perm: "cms.manage",
  schema: mediaUpdateSchema,
  handler: async (ctx, payload) => {
    const p = payload as z.infer<typeof mediaUpdateSchema>
    const existing = await db.saasCmsMedia.findUnique({ where: { id: p.id } })
    if (!existing) err(404, "Media not found")
    const data: Prisma.SaasCmsMediaUpdateInput = {}
    if (p.name !== undefined && p.name !== existing.name) data.name = p.name
    if (p.alt !== undefined) data.alt = p.alt === null || p.alt.trim() === "" ? null : p.alt.trim()
    if (p.tags !== undefined) data.tags = JSON.stringify(normalizeTags(p.tags))
    const folder = p.folder !== undefined ? normalizeFolder(p.folder) : existing.folder
    if (p.folder !== undefined && folder !== existing.folder) data.folder = folder
    // a rename regenerates the SEO filename (uniquified in the destination folder)
    const nameChanged = data.name !== undefined
    const folderChanged = data.folder !== undefined
    if (nameChanged || folderChanged) {
      data.seoFilename = await uniqueSeoFilename(folder, slugifySeoFilename(String(data.name ?? existing.name), existing.mimeType), p.id)
    }
    if (Object.keys(data).length === 0) return { media: serializeMediaMeta(existing, true) }
    const row = await db.saasCmsMedia.update({ where: { id: p.id }, data })
    const changes = [
      nameChanged ? "renamed" : null,
      folderChanged ? `folder → ${folder || "(root)"}` : null,
      p.alt !== undefined ? "alt text" : null,
      p.tags !== undefined ? "tags" : null,
    ].filter((x): x is string => !!x)
    await saasAudit(ctx, "CMS_MEDIA_UPDATED", "SaasCmsMedia", row.id, `Media "${row.name}" updated (${changes.join(", ")})`)
    return { media: serializeMediaMeta(row, true) }
  },
})

ownerAction("owner.cms.media.usage", {
  perm: "cms.view",
  schema: z.object({ id: z.string() }),
  handler: async (_ctx, payload) => {
    const media = await db.saasCmsMedia.findUnique({ where: { id: payload.id }, select: { id: true } })
    if (!media) err(404, "Media not found")
    const usage = await scanMediaUsage(payload.id)
    return { id: payload.id, usage, count: usage.length }
  },
})

ownerAction("owner.cms.media.dedupeReport", {
  perm: "cms.view",
  handler: async () => {
    const [totalMedia, pendingBackfill] = await Promise.all([
      db.saasCmsMedia.count(),
      db.saasCmsMedia.count({ where: { sha256: null } }),
    ])
    // duplicate groups: identical content hash on 2+ rows
    const groups = await db.saasCmsMedia.groupBy({
      by: ["sha256"],
      where: { sha256: { not: null } },
      _count: { _all: true },
      having: { sha256: { _count: { gt: 1 } } },
    })
    const duplicateGroups: { sha256: string; count: number; items: { id: string; name: string; folder: string; createdAt: string }[] }[] = []
    for (const g of groups.slice(0, 50)) {
      const items = await db.saasCmsMedia.findMany({
        where: { sha256: g.sha256 },
        select: { id: true, name: true, folder: true, createdAt: true },
        orderBy: { createdAt: "asc" },
      })
      duplicateGroups.push({ sha256: g.sha256 ?? "", count: g._count._all, items: items.map((i) => ({ ...i, createdAt: i.createdAt.toISOString() })) })
    }
    // latest MEDIA_BACKFILL job — the UI re-queries this report to poll it
    const lastJob = await db.bgJob.findFirst({ where: { type: "MEDIA_BACKFILL" }, orderBy: { createdAt: "desc" } })
    return {
      totalMedia,
      pendingBackfill,
      duplicateGroupCount: groups.length,
      duplicateGroups,
      lastBackfillJob: lastJob ? {
        id: lastJob.id, status: lastJob.status, progress: lastJob.progress, total: lastJob.total,
        createdAt: lastJob.createdAt.toISOString(), finishedAt: lastJob.finishedAt?.toISOString() ?? null,
        error: lastJob.error,
      } : null,
    }
  },
})

ownerAction("owner.cms.media.backfill", {
  perm: "cms.manage",
  handler: async (ctx) => {
    // vendorId anchor: BgJob.vendorId is a structurally required column of the
    // tenant-plane queue (plain String, no FK); MEDIA_BACKFILL itself is
    // PLATFORM-plane work (SaasCmsMedia has no vendorId — the CMS is the
    // platform's own website) and the runner ignores ctx entirely. Documented
    // choice: anchor on the FIRST vendor (creation order — the same order the
    // scheduler's claim scan iterates vendors); with zero tenants the literal
    // sentinel "platform" keeps the queue row valid.
    const anchorVendor = (await db.vendor.findFirst({ orderBy: { createdAt: "asc" }, select: { id: true } }))?.id ?? "platform"
    const pending = await db.saasCmsMedia.count({ where: { sha256: null } })
    // never stack a second enrichment job while one is in flight
    const active = await db.bgJob.findFirst({ where: { type: "MEDIA_BACKFILL", status: { in: ["PENDING", "RUNNING"] } }, orderBy: { createdAt: "desc" } })
    if (active) return { jobId: active.id, alreadyRunning: true, pending }
    if (pending === 0) {
      await saasAudit(ctx, "CMS_MEDIA_BACKFILL_SKIPPED", "SaasCmsMedia", null, "Media backfill requested but every row is already hashed")
      return { jobId: null, skipped: "nothing-pending", pending }
    }
    // lazy import — keeps jobs.ts out of this module's load-time graph (same
    // pattern as routes/roadmap.ts; jobs.ts lazy-imports media-backfill back)
    const { submitJob } = await import("../jobs")
    const jobId = await submitJob(
      { userId: ctx.ownerId, userName: `${ctx.name} (owner console)`, vendorId: anchorVendor },
      "MEDIA_BACKFILL",
      {},
      { total: pending, priority: 4, maxAttempts: 2 },
    )
    await saasAudit(ctx, "CMS_MEDIA_BACKFILL_SUBMITTED", "SaasCmsMedia", null, `Media enrichment job submitted for ${pending} unhashed row(s)`, { metadata: { pending, anchorVendor } })
    return { jobId, pending }
  },
})

ownerAction("owner.cms.media.delete", {
  perm: "cms.manage",
  schema: z.object({ id: z.string() }),
  handler: async (ctx, payload) => {
    const existing = await db.saasCmsMedia.findUnique({ where: { id: payload.id } })
    if (!existing) err(404, "Media not found")
    // WP-Q delete guard: refuse to delete media still referenced by a CMS
    // surface (identity logo/favicon, page blocks, client logos…). Previously
    // a referenced delete silently broke the public site (the resolver keeps
    // the dead "media:<id>" string); now the surfaces are named explicitly.
    const refs = await scanMediaUsage(payload.id)
    if (refs.length > 0) {
      const where = refs.slice(0, 5).map((r) => r.label).join("; ")
      err(409, `“${existing.name}” is still referenced by ${refs.length} surface(s) — ${where}${refs.length > 5 ? " …" : ""}. Remove those references first, then delete.`)
    }
    await db.saasCmsMedia.delete({ where: { id: payload.id } })
    await saasAudit(ctx, "CMS_MEDIA_DELETED", "SaasCmsMedia", payload.id, `Media "${existing.name}" deleted`)
    return { ok: true }
  },
})

// ============================== SEED / RESET ==============================

ownerAction("owner.cms.seed", {
  perm: "cms.manage",
  schema: z.object({ only: z.enum(["all", "features", "clients", "testimonials", "pages", "settings"]).default("all") }),
  handler: async (ctx, payload) => {
    // imports kept lazy so this route file stays tree-shakeable in the API path
    const { seedCmsContent } = await import("./seed-cms")
    const result = await seedCmsContent({ only: payload.only })
    invalidateCmsCache()
    await saasAudit(ctx, "CMS_SEEDED", "SaasCms", payload.only, `CMS default content seeded (${payload.only})`)
    return result
  },
})

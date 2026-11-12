// ============ Website CMS server resolver ============
// Reads SaasSiteSetting / SaasCmsPage / SaasCmsFeature / SaasCmsClient /
// SaasCmsTestimonial rows and merges them over the code-level defaults
// (cms-defaults.ts). Guarantees:
//   1. The public site renders sensibly even with an empty DB (defaults).
//   2. Owner console saves invalidate the cache so changes go live at once.
//   3. Read failures degrade to defaults instead of crashing the site.
// Plane discipline: marketing content only — never tenant business data.
import { db } from "@/lib/db"
import {
  DEFAULT_CLIENTS, DEFAULT_FEATURES, DEFAULT_HOME_BLOCKS, DEFAULT_PAGES,
  DEFAULT_SITE_FOOTER, DEFAULT_SITE_IDENTITY, DEFAULT_SITE_NAV, DEFAULT_SEO, DEFAULT_CONTACT,
  DEFAULT_TESTIMONIALS, DEFAULT_CURSOR_CONFIG,
} from "./cms-defaults"
import type {
  CmsBlock, CmsPageRecord, ClientRecord, CursorConfig, FeatureRecord, FooterConfig,
  SiteContact, SiteIdentity, SiteNav, SiteSeo, TestimonialRecord,
} from "@/saas/web/content-types"
import { featurePageBySlug, FAQ_ITEMS, LANDING_FEATURE_GROUPS } from "@/saas/web/features"

// ---- read-through strategy ----------------------------------------------------
// PRF-11 (P2 wave, 2026-11-09) — the marketing plane now reads through Next's
// unstable_cache with TAG-based invalidation instead of hitting PostgreSQL on
// every pageview (bots included): the loaders below are wrapped with
//   · reactCache()          — request-scoped dedupe (layout + metadata + page
//                             body share ONE read per request, as before)
//   · unstable_cache(...)   — cross-request cache with tags
//       "cms-site-settings" — identity/nav/footer/seo/contact/cursor + the
//                             SaaS general-settings merge
//       "cms-content"       — pages/features/clients/testimonials
// Invalidation: every owner CMS save routes through invalidateCmsCache()
// (revalidateTag on both tags); owner general-settings saves additionally
// bust "cms-site-settings" (see invalidateSiteSettingsCache). A 300-second
// revalidate floor bounds staleness if a future save path forgets to call
// the invalidation hook (owner publishes still land instantly via the tag).
// (A module-level TTL cache was rejected earlier: Next dev/prod can hold
// separate module instances per route bundle, which /api/owner invalidation
// can never reach — unstable_cache + revalidateTag is the supported channel.)
import { cache as reactCache } from "react"
import { unstable_cache, revalidateTag } from "next/cache"

export const CMS_SETTINGS_TAG = "cms-site-settings"
export const CMS_CONTENT_TAG = "cms-content"
export const SAAS_PLANS_TAG = "saas-plans"

/** Invalidate both CMS cache tags. Called by every owner CMS save action
 * (cms-routes.ts). Outside a request context (scripts/tests importing the
 * module directly) revalidateTag is unavailable — the call degrades to a
 * documented no-op and the 300s revalidate floor recovers. */
export function invalidateCmsCache() {
  for (const tag of [CMS_SETTINGS_TAG, CMS_CONTENT_TAG]) {
    // "max" profile: expire the entries at the next request (the strongest
    // purge revalidateTag offers outside Server Actions)
    try { revalidateTag(tag, "max") } catch { /* not in a request context */ }
  }
}

/** Invalidate the settings tag only — used when the OWNER GENERAL settings
 * (SaaS settings group "general": platform name/logo/favicon) change, since
 * getSiteSettings merges those over the CMS identity. */
export function invalidateSiteSettingsCache() {
  try { revalidateTag(CMS_SETTINGS_TAG, "max") } catch { /* not in a request context */ }
}

/** Invalidate the public pricing plans cache — called by the owner plan
 * save/duplicate/toggle actions (the /pricing page reads plans through
 * unstable_cache under SAAS_PLANS_TAG). */
export function invalidatePlansCache() {
  try { revalidateTag(SAAS_PLANS_TAG, "max") } catch { /* not in a request context */ }
}

function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback
  try { return JSON.parse(raw) as T } catch { return fallback }
}

// ---- site settings (identity / nav / footer / seo / contact) -------------------

export type SiteSettings = {
  identity: SiteIdentity
  nav: SiteNav
  footer: FooterConfig
  seo: SiteSeo
  contact: SiteContact
  cursor: CursorConfig
}

const loadSiteSettings = reactCache(unstable_cache(
  async (): Promise<SiteSettings> => {
    const defaults: SiteSettings = {
      identity: { ...DEFAULT_SITE_IDENTITY },
      nav: JSON.parse(JSON.stringify(DEFAULT_SITE_NAV)),
      footer: JSON.parse(JSON.stringify(DEFAULT_SITE_FOOTER)),
      seo: { ...DEFAULT_SEO },
      contact: { ...DEFAULT_CONTACT },
      cursor: { ...DEFAULT_CURSOR_CONFIG },
    }
    try {
      const rows = await db.saasSiteSetting.findMany()
      for (const row of rows) {
        const value = parseJson<unknown>(row.value, null)
        if (value == null) continue
        if (row.key === "identity") defaults.identity = { ...defaults.identity, ...(value as Partial<SiteIdentity>) }
        else if (row.key === "nav") {
          const nav = value as SiteNav
          if (Array.isArray(nav)) defaults.nav = nav
        } else if (row.key === "footer") {
          const footer = value as FooterConfig
          if (footer && Array.isArray(footer.groups)) defaults.footer = footer
        } else if (row.key === "seo") defaults.seo = { ...defaults.seo, ...(value as Partial<SiteSeo>) }
        else if (row.key === "contact") defaults.contact = { ...defaults.contact, ...(value as Partial<SiteContact>) }
        else if (row.key === "cursor") defaults.cursor = { ...defaults.cursor, ...(value as Partial<CursorConfig>) }
      }
      // resolve media references to data URLs
      const [logoId, faviconId] = [identityMediaId(defaults.identity.logoUrl), identityMediaId(defaults.identity.faviconUrl)]
      if (logoId || faviconId) {
        const media = await db.saasCmsMedia.findMany({
          where: { id: { in: [logoId, faviconId].filter((x): x is string => !!x) } },
          select: { id: true, data: true },
        })
        const byId = new Map(media.map((m) => [m.id, m.data]))
        const resolvedLogo = logoId ? byId.get(logoId) : undefined
        const resolvedFavicon = faviconId ? byId.get(faviconId) : undefined
        if (resolvedLogo) defaults.identity.logoUrl = resolvedLogo
        if (resolvedFavicon) defaults.identity.faviconUrl = resolvedFavicon
      }

      // Sync with Owner Panel General Settings (Platform Settings -> General)
      try {
        const { getSaasSettings } = await import("./settings")
        const saasSettings = await getSaasSettings()
        if (saasSettings?.general) {
          if (saasSettings.general.logoUrl) {
            defaults.identity.logoUrl = saasSettings.general.logoUrl
          }
          if (saasSettings.general.faviconUrl) {
            defaults.identity.faviconUrl = saasSettings.general.faviconUrl
          }
          if (saasSettings.general.platformName) {
            defaults.identity.siteName = saasSettings.general.platformName
          }
        }
      } catch {}
    } catch {
      // DB unavailable → defaults keep the site alive
    }
    return defaults
  },
  ["cms", "site-settings"],
  { tags: [CMS_SETTINGS_TAG], revalidate: 300 },
))

export async function getSiteSettings(): Promise<SiteSettings> {
  return loadSiteSettings()
}

/** logo/favicon values may be "media:<id>" references or direct URLs. */
function identityMediaId(url: string): string | null {
  return url?.startsWith("media:") ? url.slice("media:".length) : null
}

// ---- pages ------------------------------------------------------------------------

const loadCmsPages = reactCache(unstable_cache(
  async (): Promise<CmsPageRecord[]> => {
    try {
      const rows = await db.saasCmsPage.findMany({
        orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
      })
      const records = rows.map(serializePage)
      // ensure the system pages exist even before seeding
      const slugs = new Set(records.map((r) => r.slug))
      for (const def of DEFAULT_PAGES) {
        if (!slugs.has(def.slug)) {
          records.push({
            id: `default-${def.slug}`,
            slug: def.slug,
            title: def.title,
            pageType: def.pageType,
            status: "PUBLISHED",
            visible: true,
            sortOrder: 0,
            showInNav: def.showInNav,
            navLabel: def.navLabel,
            seoTitle: def.seoTitle,
            seoDesc: def.seoDesc,
            blocks: def.slug === "home" ? DEFAULT_HOME_BLOCKS : def.blocks,
            isSystem: def.isSystem,
            updatedAt: new Date(0).toISOString(),
          })
        }
      }
      return records
    } catch {
      return DEFAULT_PAGES.map((def) => ({
        id: `default-${def.slug}`,
        slug: def.slug,
        title: def.title,
        pageType: def.pageType,
        status: "PUBLISHED",
        visible: true,
        sortOrder: 0,
        showInNav: def.showInNav,
        navLabel: def.navLabel,
        seoTitle: def.seoTitle,
        seoDesc: def.seoDesc,
        blocks: def.slug === "home" ? DEFAULT_HOME_BLOCKS : def.blocks,
        isSystem: def.isSystem,
        updatedAt: new Date(0).toISOString(),
      })) as CmsPageRecord[]
    }
  },
  ["cms", "pages"],
  { tags: [CMS_CONTENT_TAG], revalidate: 300 },
))

export async function getCmsPages(): Promise<CmsPageRecord[]> {
  return loadCmsPages()
}

export async function getCmsPage(slug: string): Promise<CmsPageRecord | null> {
  const pages = await getCmsPages()
  return pages.find((p) => p.slug === slug && p.status === "PUBLISHED" && p.visible) ?? null
}

function serializePage(row: {
  id: string; slug: string; title: string; pageType: string; status: string;
  visible: boolean; sortOrder: number; showInNav: boolean; navLabel: string | null;
  seoTitle: string | null; seoDesc: string | null; blocks: string;
  isSystem: boolean; updatedAt: Date;
}): CmsPageRecord {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    pageType: row.pageType,
    status: row.status,
    visible: row.visible,
    sortOrder: row.sortOrder,
    showInNav: row.showInNav,
    navLabel: row.navLabel,
    seoTitle: row.seoTitle,
    seoDesc: row.seoDesc,
    blocks: parseJson<CmsBlock[]>(row.blocks, []),
    isSystem: row.isSystem,
    updatedAt: row.updatedAt.toISOString(),
  }
}

// ---- features -----------------------------------------------------------------------

const loadCmsFeatures = reactCache(unstable_cache(
  async (): Promise<FeatureRecord[]> => {
    try {
      const rows = await db.saasCmsFeature.findMany({
        orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
      })
      if (rows.length === 0) return DEFAULT_FEATURES
      const emptyContent = { problem: [], solution: [], capabilities: [], workflow: [], security: [], cta: { primary: "", secondary: "" } }
      return rows
        .filter((r) => r.visible)
        .map((r) => ({
          id: r.id,
          slug: r.slug,
          title: r.title,
          navLabel: r.navLabel,
          headline: r.headline,
          sub: r.sub,
          visual: r.visual,
          icon: r.icon,
          accent: r.accent,
          sortOrder: r.sortOrder,
          visible: r.visible,
          showOnHome: r.showOnHome,
          content: parseJson<FeatureRecord["content"]>(r.content, emptyContent),
          updatedAt: r.updatedAt.toISOString(),
        }))
    } catch {
      return DEFAULT_FEATURES
    }
  },
  ["cms", "features"],
  { tags: [CMS_CONTENT_TAG], revalidate: 300 },
))

export async function getCmsFeatures(): Promise<FeatureRecord[]> {
  return loadCmsFeatures()
}

export async function getCmsFeature(slug: string): Promise<FeatureRecord | null> {
  const all = await getCmsFeatures()
  return all.find((f) => f.slug === slug) ?? null
}

// ---- clients --------------------------------------------------------------------------

const loadCmsClients = reactCache(unstable_cache(
  async (): Promise<ClientRecord[]> => {
    try {
      const rows = await db.saasCmsClient.findMany({
        orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
      })
      if (rows.length === 0) return DEFAULT_CLIENTS
      return rows
        .filter((r) => r.visible)
        .map((r) => ({
          id: r.id,
          name: r.name,
          industry: r.industry,
          description: r.description,
          story: r.story,
          quote: r.quote,
          personName: r.personName,
          personRole: r.personRole,
          metrics: parseJson(r.metrics, []),
          logoText: r.logoText,
          logoColor: r.logoColor,
          logoUrl: r.logoUrl,
          website: r.website,
          featured: r.featured,
          visible: r.visible,
          sortOrder: r.sortOrder,
          updatedAt: r.updatedAt.toISOString(),
        }))
    } catch {
      return DEFAULT_CLIENTS
    }
  },
  ["cms", "clients"],
  { tags: [CMS_CONTENT_TAG], revalidate: 300 },
))

export async function getCmsClients(): Promise<ClientRecord[]> {
  return loadCmsClients()
}

// ---- testimonials ------------------------------------------------------------------------

const loadCmsTestimonials = reactCache(unstable_cache(
  async (): Promise<TestimonialRecord[]> => {
    try {
      const rows = await db.saasCmsTestimonial.findMany({
        orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
      })
      if (rows.length === 0) return DEFAULT_TESTIMONIALS as TestimonialRecord[]
      return rows
        .filter((r) => r.visible)
        .map((r) => ({
          id: r.id,
          clientName: r.clientName,
          personName: r.personName,
          personRole: r.personRole,
          quote: r.quote,
          rating: r.rating,
          visible: r.visible,
          sortOrder: r.sortOrder,
          updatedAt: r.updatedAt.toISOString(),
        }))
    } catch {
      return DEFAULT_TESTIMONIALS as TestimonialRecord[]
    }
  },
  ["cms", "testimonials"],
  { tags: [CMS_CONTENT_TAG], revalidate: 300 },
))

export async function getCmsTestimonials(): Promise<TestimonialRecord[]> {
  return loadCmsTestimonials()
}

// ---- FAQ (page-block driven with constant fallback) -----------------------------------------

export async function getCmsFaq(): Promise<{ q: string; a: string }[]> {
  const page = await getCmsPage("faq")
  const faqBlock = page?.blocks.find((bl) => bl.type === "faq" && bl.visible !== false)
  const items = (faqBlock?.data?.items as { q: string; a: string }[] | undefined) ?? undefined
  if (items && Array.isArray(items) && items.length > 0) return items
  return FAQ_ITEMS
}

// ---- landing feature groups (kept for compat; DB-aware) ---------------------------------------

export function getLandingFeatureGroups() {
  return LANDING_FEATURE_GROUPS
}

export { featurePageBySlug }

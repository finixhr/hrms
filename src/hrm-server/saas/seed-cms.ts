// ============ Website CMS default-content seeder ============
// Idempotent: inserts default rows ONLY where none exist (never overwrites
// owner-edited content). Invoked by:
//   · `bun run src/hrm-server/saas/seed-cms.ts` (standalone)
//   · seedSaaSLayer() so normal seed flows produce a ready-to-edit CMS
//   · the owner console action owner.cms.seed (explicit re-seed)
import { db } from "@/lib/db"
import {
  DEFAULT_CLIENTS, DEFAULT_FEATURES, DEFAULT_HOME_BLOCKS, DEFAULT_PAGES,
  DEFAULT_SITE_FOOTER, DEFAULT_SITE_IDENTITY, DEFAULT_SITE_NAV, DEFAULT_SEO,
  DEFAULT_TESTIMONIALS, DEFAULT_CURSOR_CONFIG,
} from "./cms-defaults"
import { FAQ_ITEMS } from "@/saas/web/features"
import { invalidateCmsCache } from "./cms"

export async function seedCmsContent(opts: { only?: "all" | "features" | "clients" | "testimonials" | "pages" | "settings" } = {}) {
  const only = opts.only ?? "all"
  const summary: Record<string, number> = {}

  if (only === "all" || only === "settings") {
    const rows: { key: string; value: string }[] = [
      { key: "identity", value: JSON.stringify(DEFAULT_SITE_IDENTITY) },
      { key: "nav", value: JSON.stringify(DEFAULT_SITE_NAV) },
      { key: "footer", value: JSON.stringify(DEFAULT_SITE_FOOTER) },
      { key: "seo", value: JSON.stringify(DEFAULT_SEO) },
      { key: "cursor", value: JSON.stringify(DEFAULT_CURSOR_CONFIG) },
    ]
    for (const row of rows) {
      // upsert WITHOUT overwrite: existing owner-edited values win
      const existing = await db.saasSiteSetting.findUnique({ where: { key: row.key } })
      if (!existing) {
        await db.saasSiteSetting.create({ data: row })
        summary[row.key] = 1
      }
    }
  }

  if (only === "all" || only === "features") {
    const count = await db.saasCmsFeature.count()
    if (count === 0) {
      await db.saasCmsFeature.createMany({
        data: DEFAULT_FEATURES.map((f) => ({
          slug: f.slug, title: f.title, navLabel: f.navLabel, headline: f.headline,
          sub: f.sub, visual: f.visual, icon: f.icon, accent: f.accent,
          sortOrder: f.sortOrder, visible: f.visible, showOnHome: f.showOnHome,
          content: JSON.stringify(f.content),
        })),
      })
      summary.features = DEFAULT_FEATURES.length
    }
  }

  if (only === "all" || only === "clients") {
    const count = await db.saasCmsClient.count()
    if (count === 0) {
      await db.saasCmsClient.createMany({
        data: DEFAULT_CLIENTS.map((c) => ({
          name: c.name, industry: c.industry, description: c.description, story: c.story,
          quote: c.quote, personName: c.personName, personRole: c.personRole,
          metrics: JSON.stringify(c.metrics), logoText: c.logoText, logoColor: c.logoColor,
          website: c.website, featured: c.featured, visible: c.visible, sortOrder: c.sortOrder,
        })),
      })
      summary.clients = DEFAULT_CLIENTS.length
    }
  }

  if (only === "all" || only === "testimonials") {
    const count = await db.saasCmsTestimonial.count()
    if (count === 0) {
      await db.saasCmsTestimonial.createMany({
        data: DEFAULT_TESTIMONIALS.map((t) => ({
          clientName: t.clientName, personName: t.personName, personRole: t.personRole,
          quote: t.quote, rating: t.rating, visible: t.visible, sortOrder: t.sortOrder,
        })),
      })
      summary.testimonials = DEFAULT_TESTIMONIALS.length
    }
  }

  if (only === "all" || only === "pages") {
    for (const def of DEFAULT_PAGES) {
      const existing = await db.saasCmsPage.findUnique({ where: { slug: def.slug } })
      if (!existing) {
        const blocks = def.slug === "home"
          ? DEFAULT_HOME_BLOCKS
          : def.slug === "faq"
            ? [{ id: "default-faq-1", type: "faq", visible: true, data: { title: "Frequently asked questions", sub: "Everything about plans, modules, devices and security.", items: FAQ_ITEMS } }]
            : def.blocks
        await db.saasCmsPage.create({
          data: {
            slug: def.slug, title: def.title, pageType: def.pageType,
            status: "PUBLISHED", visible: true, sortOrder: 0, showInNav: def.showInNav,
            navLabel: def.navLabel, seoTitle: def.seoTitle, seoDesc: def.seoDesc,
            blocks: JSON.stringify(blocks), isSystem: def.isSystem,
          },
        })
        summary[`page:${def.slug}`] = 1
      }
    }
  }

  invalidateCmsCache()
  return { seeded: summary, skippedExisting: Object.keys(summary).length === 0 }
}

// standalone execution: `bun run src/hrm-server/saas/seed-cms.ts`
if (process.argv[1] && process.argv[1].endsWith("seed-cms.ts")) {
  seedCmsContent()
    .then((r) => {
      console.log("[seed-cms] done:", JSON.stringify(r))
      process.exit(0)
    })
    .catch((e) => {
      console.error("[seed-cms] failed:", e)
      process.exit(1)
    })
}

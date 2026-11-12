// ============ sitemap.xml — public surfaces only (§62), CMS-driven ============
import type { MetadataRoute } from "next"
import { SITE } from "@/saas/web/site"
import { getCmsFeatures, getCmsPages } from "@/hrm-server/saas/cms"

export const dynamic = "force-dynamic"

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const base = SITE.url.replace(/\/$/, "")
  const now = new Date()
  const statics: MetadataRoute.Sitemap = [
    { url: `${base}/`, lastModified: now, changeFrequency: "weekly", priority: 1 },
    { url: `${base}/features`, lastModified: now, changeFrequency: "weekly", priority: 0.9 },
    { url: `${base}/clients`, lastModified: now, changeFrequency: "weekly", priority: 0.85 },
    { url: `${base}/pricing`, lastModified: now, changeFrequency: "weekly", priority: 0.95 },
    { url: `${base}/register`, lastModified: now, changeFrequency: "monthly", priority: 0.9 },
    { url: `${base}/about`, lastModified: now, changeFrequency: "monthly", priority: 0.5 },
    { url: `${base}/faq`, lastModified: now, changeFrequency: "monthly", priority: 0.6 },
    { url: `${base}/contact`, lastModified: now, changeFrequency: "monthly", priority: 0.6 },
    { url: `${base}/careers`, lastModified: now, changeFrequency: "weekly", priority: 0.7 }, // U2-006: /careers was missing
    { url: `${base}/legal/privacy`, lastModified: now, changeFrequency: "yearly", priority: 0.2 },
    { url: `${base}/legal/terms`, lastModified: now, changeFrequency: "yearly", priority: 0.2 },
  ]
  const [features, pages] = await Promise.all([getCmsFeatures(), getCmsPages()])
  const featureUrls: MetadataRoute.Sitemap = features.map((f) => ({
    url: `${base}/features/${f.slug}`,
    lastModified: new Date(f.updatedAt),
    changeFrequency: "weekly",
    priority: 0.8,
  }))
  const customUrls: MetadataRoute.Sitemap = pages
    .filter((p) => p.pageType === "CUSTOM" && p.status === "PUBLISHED" && p.visible)
    .map((p) => ({
      url: `${base}/p/${p.slug}`,
      lastModified: new Date(p.updatedAt),
      changeFrequency: "monthly",
      priority: 0.5,
    }))
  // NOTE: /app (customer HRM), /owner (SaaS console), /api/*, /iclock, /ISAPI
  // and /registration-status are intentionally absent — private surfaces.
  return [...statics, ...featureUrls, ...customUrls]
}

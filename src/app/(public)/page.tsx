// ============ Landing page — rendered from the CMS page builder ============
// The homepage is a CMS page (slug "home"): its blocks, order and visibility
// are managed in the Owner Console → Platform Settings → Website Studio.
// Code-level defaults (cms-defaults.ts) render before any content is seeded,
// so the site is never blank after migration.
import { BlockRenderer } from "@/saas/web/blocks/block-renderer"
import { getCmsPage, getSiteSettings } from "@/hrm-server/saas/cms"

export const dynamic = "force-dynamic"

export async function generateMetadata() {
  const [{ identity }, page] = await Promise.all([getSiteSettings(), getCmsPage("home")])
  return {
    title: page?.seoTitle || `${identity.siteName} — ${identity.tagline}`,
    description: page?.seoDesc || identity.description,
    alternates: { canonical: "/" },
  }
}

export default async function LandingPage() {
  const [{ identity }, page] = await Promise.all([getSiteSettings(), getCmsPage("home")])
  const blocks = page?.blocks ?? []
  if (blocks.length > 0) {
    return <BlockRenderer blocks={blocks} identity={identity} />
  }
  // safety net — a homepage with zero blocks still renders a hero + CTA
  return (
    <BlockRenderer
      identity={identity}
      blocks={[
        { id: "fallback-hero", type: "hero", visible: true, data: {} },
        { id: "fallback-cta", type: "cta", visible: true, data: {} },
      ]}
    />
  )
}

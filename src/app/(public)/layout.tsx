// ============ Public site chrome (header + footer) — CMS-driven ============
// Scope note: this layout only wraps the marketing route group. The HRM app
// (/app) and owner console (/owner) deliberately do NOT inherit it.
// Identity/nav/footer/SEO come from the Website CMS (owner console) with
// code-level defaults as fallback. force-dynamic guarantees owner publishes
// are reflected on the very next request.
import type { Metadata, Viewport } from "next"
import { SiteHeader } from "@/saas/web/header"
import { SiteFooter } from "@/saas/web/footer"
import { SiteThemeSync } from "@/saas/web/theme"
import { SiteCursor } from "@/saas/web/cursor"
import { getSiteSettings } from "@/hrm-server/saas/cms"
import { SITE } from "@/saas/web/site"

export const dynamic = "force-dynamic"

export async function generateMetadata(): Promise<Metadata> {
  const { identity, seo } = await getSiteSettings()
  return {
    metadataBase: new URL(SITE.url),
    title: {
      default: `${identity.siteName} — ${identity.tagline}`,
      template: `%s · ${identity.siteName}`,
    },
    description: seo.metaDescription || identity.description,
    keywords: seo.keywords.length > 0 ? seo.keywords : ["HRM", "HR software", "workforce management", "attendance", "payroll"],
    openGraph: {
      type: "website",
      siteName: identity.siteName,
      title: seo.ogTitle || `${identity.siteName} — ${identity.tagline}`,
      description: seo.ogDescription || identity.description,
    },
    twitter: {
      card: "summary_large_image",
      title: seo.ogTitle || `${identity.siteName} — ${identity.tagline}`,
      description: seo.ogDescription || identity.description,
    },
    alternates: { canonical: "/" },
  }
}

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#020617" },
  ],
}

export default async function PublicLayout({ children }: { children: React.ReactNode }) {
  const { identity, nav, footer, cursor } = await getSiteSettings()
  return (
    <div className="min-h-dvh bg-slate-950 light:bg-white">
      <SiteThemeSync />
      <SiteCursor config={cursor} />
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-[100] focus:rounded-lg focus:bg-white focus:px-4 focus:py-2 focus:text-sm focus:font-semibold focus:text-slate-900">
        Skip to content
      </a>
      <SiteHeader nav={nav} identity={identity} />
      <main id="main">{children}</main>
      <SiteFooter footer={footer} identity={identity} />
    </div>
  )
}

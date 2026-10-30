// ============ /p/[slug] — custom CMS pages from the page builder ============
import type { Metadata } from "next"
import { notFound } from "next/navigation"
import { BlockRenderer } from "@/saas/web/blocks/block-renderer"
import { getCmsPage, getSiteSettings } from "@/hrm-server/saas/cms"

export const dynamic = "force-dynamic"

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params
  const page = await getCmsPage(slug)
  if (!page || page.pageType !== "CUSTOM") return {}
  return {
    title: page.seoTitle || page.title,
    description: page.seoDesc || undefined,
    alternates: { canonical: `/p/${slug}` },
  }
}

export default async function CustomPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const [{ identity }, page] = await Promise.all([getSiteSettings(), getCmsPage(slug)])
  if (!page || page.pageType !== "CUSTOM") notFound()
  return <BlockRenderer blocks={page.blocks} identity={identity} />
}

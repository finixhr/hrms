// ============ /contact — CMS-driven contact info + inquiry form ============
import type { Metadata } from "next"
import { ContactBlock } from "@/saas/web/blocks/pricing-contact-blocks"
import { CtaBand } from "@/saas/web/sections"

// PRF-11 (P2 wave, 2026-11-09) — force-dynamic removed: content reads
// through unstable_cache with tag invalidation (owner CMS saves call
// invalidateCmsCache → revalidateTag), so the page is statically rendered
// and revalidated instead of querying the database on every pageview.

export const metadata: Metadata = {
  title: "Contact",
  description: "Sales and support inquiries for the Finix HR platform — stored securely and answered by the platform team.",
  alternates: { canonical: "/contact" },
}

export default function ContactPage() {
  return (
    <>
      <ContactBlock data={{}} />
      <CtaBand />
    </>
  )
}

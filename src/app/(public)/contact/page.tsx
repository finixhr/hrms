// ============ /contact — CMS-driven contact info + inquiry form ============
import type { Metadata } from "next"
import { ContactBlock } from "@/saas/web/blocks/pricing-contact-blocks"
import { CtaBand } from "@/saas/web/sections"

export const dynamic = "force-dynamic"

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

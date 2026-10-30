// ============ /registration-status — NOINDEX (private lookup surface) ============
import type { Metadata } from "next"
import { Suspense } from "react"
import { StatusForm } from "@/saas/web/status-form"
import { SectionHeading } from "@/saas/web/sections"

export const metadata: Metadata = {
  title: "Track your application",
  description: "Check the review status of your HR workspace application with your Application ID and email.",
  alternates: { canonical: "/registration-status" },
  robots: { index: false, follow: true }, // §62 — registration status is NOINDEX
}

export default function RegistrationStatusPage() {
  return (
    <section className="bg-slate-950 light:bg-white">
      <div className="mx-auto max-w-7xl px-4 py-16 sm:px-6">
        <SectionHeading
          eyebrow="Application status"
          title="Where is my application?"
          sub="Enter your Application ID (like HRM-2026-000123) and your administrator or official email. Only the review state is shown — no internal notes, reviewer identities or any other tenant's data."
        />
        <div className="mt-12">
          <Suspense>
            <StatusForm />
          </Suspense>
        </div>
      </div>
    </section>
  )
}

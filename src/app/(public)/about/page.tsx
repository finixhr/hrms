// ============ /about — CMS page with code-level fallback prose ============
import type { Metadata } from "next"
import { CtaBand, Grad, SectionHeading } from "@/saas/web/sections"
import { getCmsPage, getSiteSettings } from "@/hrm-server/saas/cms"
import { BlockRenderer } from "@/saas/web/blocks/block-renderer"

export const dynamic = "force-dynamic"

export async function generateMetadata(): Promise<Metadata> {
  const page = await getCmsPage("about")
  return {
    title: page?.seoTitle || "About",
    description: page?.seoDesc || "About the multi-tenant HR operations platform: what it is, how it is built, and the principles it follows.",
    alternates: { canonical: "/about" },
  }
}

export default async function AboutPage() {
  const [{ identity }, page] = await Promise.all([getSiteSettings(), getCmsPage("about")])
  const blocks = page?.blocks ?? []
  if (blocks.length > 0) {
    return (
      <>
        <BlockRenderer blocks={blocks} identity={identity} />
        <CtaBand />
      </>
    )
  }
  return (
    <>
      <section className="bg-slate-950 light:bg-white">
        <div className="mx-auto max-w-4xl px-4 py-20 sm:px-6">
          <SectionHeading
            align="left"
            eyebrow="About"
            title={<>A workforce platform built like <Grad>infrastructure</Grad></>}
          />
          <div className="mt-8 space-y-6 text-[15px] leading-relaxed text-slate-400 light:text-slate-600">
            <p>
              {identity.siteName} is a multi-tenant HR operations platform: every organization gets an isolated workspace with
              its own people, branches, policies and payroll — running on shared, audited infrastructure. It combines
              HR, attendance with verification, live tracking, payroll and AIT, leave, performance, inventory and
              procurement, communication, security and analytics.
            </p>
            <p>
              The product principle is simple: never advertise what does not exist. Every feature page on this site
              describes a capability in the shipped software, and where something is only a foundation (for example
              Hikvision ISAPI), the page says so plainly.
            </p>
            <p>
              Security is enforced server-side on every request — tenant isolation on every query, role-based access
              control with custom roles, MFA for privileged roles, an audit trail with before/after values, CSRF
              protection, per-request CSP nonces and rate limiting on authentication surfaces.
            </p>
            <p>
              The platform is operated by {identity.company}. Registration is approval-based: an application is reviewed
              by the platform team, then the workspace is provisioned with statutory configuration ready on day one.
            </p>
          </div>
        </div>
      </section>
      <section className="border-t border-white/10 bg-slate-950 light:border-slate-200 light:bg-slate-50">
        <div className="mx-auto max-w-7xl px-4 py-16 sm:px-6">
          <div className="grid gap-4 md:grid-cols-3">
            {[
              { t: "Operational truth", d: "The interface shows what the data layer enforces. If a number is on screen, it is the same number payroll, reports and audits use." },
              { t: "Auditability first", d: "Every mutation is logged with actor, target, before/after and reason. Attendance carries provenance; corrections run through approval workflows." },
              { t: "Boring reliability", d: "Rate limits, lockouts, session policy and device health thresholds are defaults, not options. The boring parts are done on purpose." },
            ].map((x) => (
              <div key={x.t} className="rounded-2xl border border-white/10 bg-white/[0.03] p-6 light:border-slate-200 light:bg-white light:shadow-sm">
                <p className="text-sm font-bold text-white light:text-slate-900">{x.t}</p>
                <p className="mt-2 text-[13px] leading-relaxed text-slate-400 light:text-slate-600">{x.d}</p>
              </div>
            ))}
          </div>
        </div>
      </section>
      <CtaBand />
    </>
  )
}

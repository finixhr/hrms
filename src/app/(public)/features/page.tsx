// ============ /features — feature catalog from the CMS ============
import type { Metadata } from "next"
import Link from "next/link"
import { ArrowRight } from "lucide-react"
import { SectionHeading, Grad } from "@/saas/web/sections"
import { getCmsFeatures } from "@/hrm-server/saas/cms"

export const dynamic = "force-dynamic"

export const metadata: Metadata = {
  title: "Features",
  description: "Every Finix HR module explained and demonstrated — employees, attendance, tracking, payroll, devices, cameras, performance and analytics.",
  alternates: { canonical: "/features" },
}

export default async function FeaturesIndex() {
  const features = await getCmsFeatures()
  return (
    <section className="bg-slate-950 light:bg-white">
      <div className="mx-auto max-w-7xl px-4 py-20 sm:px-6">
        <SectionHeading
          eyebrow="Feature catalog"
          title={<>Seventeen modules, <Grad>one workforce platform</Grad></>}
          sub="Every feature below exists in the shipped product today. Open any page to see an interactive product simulation — built from the real interface, not screenshots."
        />
        <div className="mt-12 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {features.map((f) => (
            <Link
              key={f.slug}
              href={`/features/${f.slug}`}
              data-cursor="view"
              data-cursor-label="OPEN"
              className="group flex flex-col rounded-2xl border border-white/10 bg-white/[0.03] p-6 transition-all hover:-translate-y-0.5 hover:border-indigo-400/40 hover:bg-white/[0.05] light:border-slate-200 light:bg-white light:shadow-sm light:hover:border-indigo-500/50"
            >
              <div className="flex items-center justify-between">
                <h3 className="text-[15px] font-bold text-white light:text-slate-900">{f.title}</h3>
                {f.visual && (
                  <span className="rounded-full bg-indigo-500/10 px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide text-indigo-300 ring-1 ring-indigo-400/30 light:bg-indigo-50 light:text-indigo-700 light:ring-indigo-200">
                    Live demo
                  </span>
                )}
              </div>
              <p className="mt-3 flex-1 text-[13px] leading-relaxed text-slate-400 light:text-slate-600">{f.sub}</p>
              <p className="mt-4 inline-flex items-center gap-1.5 text-xs font-semibold text-indigo-300 light:text-indigo-600">
                Explore this feature <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" />
              </p>
            </Link>
          ))}
        </div>
      </div>
    </section>
  )
}

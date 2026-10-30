// ============ /faq — CMS-driven (native details/summary, zero client JS) ============
import type { Metadata } from "next"
import { ChevronDown } from "lucide-react"
import { CtaBand, SectionHeading } from "@/saas/web/sections"
import { getCmsFaq } from "@/hrm-server/saas/cms"

export const dynamic = "force-dynamic"

export const metadata: Metadata = {
  title: "FAQ",
  description: "Answers about multi-tenancy, pricing, registration approval, ZKTeco devices, live tracking, payroll & AIT, data protection and more.",
  alternates: { canonical: "/faq" },
}

export default async function FaqPage() {
  const items = await getCmsFaq()
  return (
    <>
      <section className="bg-slate-950 light:bg-white">
        <div className="mx-auto max-w-3xl px-4 py-20 sm:px-6">
          <SectionHeading
            eyebrow="FAQ"
            title="Frequently asked questions"
            sub="Only answers supported by the actual application — nothing aspirational."
          />
          <div className="mt-10 space-y-3">
            {items.map((item) => (
              <details key={item.q} className="group rounded-2xl border border-white/10 bg-white/[0.03] open:border-indigo-400/30 open:bg-indigo-600/5 light:border-slate-200 light:bg-white light:shadow-sm light:open:border-indigo-500/40 light:open:bg-indigo-50/60">
                <summary className="flex cursor-pointer list-none items-center gap-3 p-5 text-[15px] font-semibold text-white light:text-slate-900 [&::-webkit-details-marker]:hidden">
                  <span className="flex-1">{item.q}</span>
                  <ChevronDown className="h-4 w-4 shrink-0 text-slate-500 transition-transform group-open:rotate-180" />
                </summary>
                <p className="px-5 pb-5 text-[14px] leading-relaxed text-slate-400 light:text-slate-600">{item.a}</p>
              </details>
            ))}
          </div>
        </div>
      </section>
      <CtaBand />
    </>
  )
}

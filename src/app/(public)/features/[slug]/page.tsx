// ============ /features/[slug] — visual-first feature detail page ============
// Layout: hero → floating coded product simulation (NOT a screenshot) →
// problem/solution → capabilities → workflow → security → CTA.
// Feature data comes from the CMS (owner-editable); the simulation component
// is selected by the `visual` key.
import type { Metadata } from "next"
import Link from "next/link"
import { notFound } from "next/navigation"
import { AlertTriangle, ArrowRight, CheckCircle2, ListChecks, Lock, Sparkles, Workflow } from "lucide-react"
import { CtaBand, GlassPanel, SectionHeading, Grad } from "@/saas/web/sections"
import { getCmsFeature, getCmsFeatures } from "@/hrm-server/saas/cms"
import { FeatureVisual } from "@/saas/web/visuals"

export const dynamic = "force-dynamic"

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params
  const feature = await getCmsFeature(slug)
  if (!feature) return {}
  return {
    title: feature.title,
    description: feature.sub,
    alternates: { canonical: `/features/${feature.slug}` },
    openGraph: { title: `${feature.title} · ${feature.headline}`, description: feature.sub },
  }
}

export default async function FeatureDetail({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const [feature, all] = await Promise.all([getCmsFeature(slug), getCmsFeatures()])
  if (!feature) notFound()
  const content = feature.content
  const related = all.filter((f) => f.slug !== feature.slug).slice(0, 3)

  return (
    <>
      {/* ---- hero ---- */}
      <section className="relative overflow-hidden bg-slate-950 light:bg-white">
        <div aria-hidden className="pointer-events-none absolute inset-0">
          <div className="absolute left-1/2 top-[-180px] h-[380px] w-[720px] -translate-x-1/2 rounded-full bg-indigo-600/20 blur-[120px] light:opacity-50" />
        </div>
        <div className="relative mx-auto max-w-4xl px-4 py-16 text-center sm:px-6 sm:py-20">
          <p className="text-xs font-bold uppercase tracking-[0.2em] text-indigo-300 light:text-indigo-600">{feature.title}</p>
          <h1 className="mt-4 text-4xl font-bold tracking-tight text-white text-balance light:text-slate-900 sm:text-5xl">{feature.headline}</h1>
          <p className="mx-auto mt-6 max-w-2xl text-lg leading-relaxed text-slate-400 light:text-slate-600">{feature.sub}</p>
          <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <Link href="/register" className="inline-flex h-11 items-center gap-2 rounded-xl bg-gradient-to-r from-blue-600 to-violet-600 px-6 text-sm font-semibold text-white shadow-lg shadow-indigo-950/60 hover:from-blue-500 hover:to-violet-500">
              {content?.cta?.primary || "Register your organization"} <ArrowRight className="h-4 w-4" />
            </Link>
            <Link href="/pricing" className="inline-flex h-11 items-center rounded-xl border border-white/15 px-6 text-sm font-semibold text-white hover:bg-white/5 light:border-slate-300 light:text-slate-800 light:hover:bg-slate-100">
              {content?.cta?.secondary || "View pricing"}
            </Link>
          </div>
        </div>

        {/* ---- floating product simulation (the centerpiece) ---- */}
        {feature.visual && (
          <div className="relative mx-auto max-w-6xl px-4 pb-20 sm:px-6">
            <div aria-hidden className="pointer-events-none absolute inset-0">
              <div className="absolute left-1/2 top-10 h-[360px] w-[760px] -translate-x-1/2 rounded-full bg-violet-600/15 blur-[130px] light:opacity-60" />
            </div>
            <div className="relative">
              <div className="mb-4 flex items-center justify-center gap-2 text-[11px] font-semibold uppercase tracking-widest text-slate-500">
                <Sparkles className="h-3.5 w-3.5 text-indigo-400" />
                Interactive product simulation — coded, not a screenshot
              </div>
              <FeatureVisual visual={feature.visual} />
            </div>
          </div>
        )}
      </section>

      {/* ---- problem / solution ---- */}
      {(content?.problem?.length > 0 || content?.solution?.length > 0) && (
        <section className="border-y border-white/10 bg-slate-950 light:border-slate-200 light:bg-slate-50">
          <div className="mx-auto grid max-w-7xl gap-4 px-4 py-16 sm:px-6 lg:grid-cols-2">
            {content.problem.length > 0 && (
              <GlassPanel className="p-6">
                <h2 className="flex items-center gap-2 text-lg font-bold text-white light:text-slate-900">
                  <AlertTriangle className="h-5 w-5 text-amber-400 light:text-amber-600" /> The problem
                </h2>
                <ul className="mt-4 space-y-3">
                  {content.problem.map((p, i) => (
                    <li key={i} className="text-[14px] leading-relaxed text-slate-400 light:text-slate-600">{p}</li>
                  ))}
                </ul>
              </GlassPanel>
            )}
            {content.solution.length > 0 && (
              <GlassPanel className="p-6">
                <h2 className="flex items-center gap-2 text-lg font-bold text-white light:text-slate-900">
                  <CheckCircle2 className="h-5 w-5 text-emerald-400 light:text-emerald-600" /> How {`Finix HR`} solves it
                </h2>
                <ul className="mt-4 space-y-3">
                  {content.solution.map((p, i) => (
                    <li key={i} className="text-[14px] leading-relaxed text-slate-400 light:text-slate-600">{p}</li>
                  ))}
                </ul>
              </GlassPanel>
            )}
          </div>
        </section>
      )}

      {/* ---- capabilities ---- */}
      {content?.capabilities?.length > 0 && (
        <section className="bg-slate-950 light:bg-white">
          <div className="mx-auto max-w-7xl px-4 py-16 sm:px-6">
            <SectionHeading eyebrow="What's in the box" title={<>Everything <Grad>{feature.title.toLowerCase()}</Grad> includes</>} />
            <div className="mt-12 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              {content.capabilities.map((c, i) => (
                <GlassPanel key={i} className="p-6">
                  <h3 className="flex items-center gap-2 text-[15px] font-bold text-white light:text-slate-900">
                    <ListChecks className="h-4 w-4 text-indigo-300 light:text-indigo-600" /> {c.title}
                  </h3>
                  <ul className="mt-4 space-y-2">
                    {c.items.map((it, j) => (
                      <li key={j} className="flex items-start gap-2 text-[13px] leading-relaxed text-slate-400 light:text-slate-600">
                        <span className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-indigo-400/70 light:bg-indigo-500/70" /> {it}
                      </li>
                    ))}
                  </ul>
                </GlassPanel>
              ))}
            </div>
          </div>
        </section>
      )}

      {/* ---- workflow ---- */}
      {content?.workflow?.length > 0 && (
        <section className="border-y border-white/10 bg-slate-950 light:border-slate-200 light:bg-slate-50">
          <div className="mx-auto max-w-7xl px-4 py-16 sm:px-6">
            <SectionHeading eyebrow="How it works" title="Step by step, in the product" />
            <div className="mt-12 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
              {content.workflow.map((s, i) => (
                <div key={i} className="rounded-2xl border border-white/10 bg-white/[0.03] p-6 light:border-slate-200 light:bg-white light:shadow-sm">
                  <span className="flex h-9 w-9 items-center justify-center rounded-full bg-gradient-to-br from-blue-600 to-violet-600 text-sm font-bold text-white shadow-lg shadow-indigo-950/50">
                    {i + 1}
                  </span>
                  <h3 className="mt-4 flex items-center gap-2 text-[15px] font-bold text-white light:text-slate-900">
                    <Workflow className="h-3.5 w-3.5 text-indigo-300 light:text-indigo-600" /> {s.title}
                  </h3>
                  <p className="mt-2 text-[13px] leading-relaxed text-slate-400 light:text-slate-600">{s.body}</p>
                </div>
              ))}
            </div>
          </div>
        </section>
      )}

      {/* ---- security ---- */}
      {content?.security?.length > 0 && (
        <section className="bg-slate-950 light:bg-white">
          <div className="mx-auto max-w-4xl px-4 py-16 sm:px-6">
            <SectionHeading eyebrow="Security & controls" title="How this feature stays safe" align="center" />
            <ul className="mt-10 space-y-3">
              {content.security.map((s, i) => (
                <li key={i} className="flex items-start gap-3 rounded-xl border border-white/10 bg-white/[0.03] p-4 text-[14px] leading-relaxed text-slate-300 light:border-slate-200 light:bg-white light:shadow-sm light:text-slate-700">
                  <Lock className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400 light:text-emerald-600" /> {s}
                </li>
              ))}
            </ul>
          </div>
        </section>
      )}

      {/* ---- related features ---- */}
      {related.length > 0 && (
        <section className="border-t border-white/10 bg-slate-950 light:border-slate-200 light:bg-slate-50">
          <div className="mx-auto max-w-7xl px-4 py-12 sm:px-6">
            <p className="text-xs font-bold uppercase tracking-[0.2em] text-slate-500">Explore next</p>
            <div className="mt-4 grid gap-4 md:grid-cols-3">
              {related.map((f) => (
                <Link key={f.slug} href={`/features/${f.slug}`} className="group rounded-2xl border border-white/10 bg-white/[0.03] p-5 transition-all hover:border-indigo-400/40 light:border-slate-200 light:bg-white light:hover:border-indigo-500/50">
                  <div className="flex items-center justify-between">
                    <h3 className="text-[14px] font-bold text-white light:text-slate-900">{f.title}</h3>
                    <ArrowRight className="h-4 w-4 text-slate-600 transition-all group-hover:translate-x-0.5 group-hover:text-indigo-300 light:text-slate-400" />
                  </div>
                  <p className="mt-2 line-clamp-2 text-[12px] leading-relaxed text-slate-400 light:text-slate-600">{f.sub}</p>
                </Link>
              ))}
            </div>
          </div>
        </section>
      )}

      <CtaBand />
    </>
  )
}

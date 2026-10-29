// ============ /clients — Valued Clients & client stories ============
import type { Metadata } from "next"
import Link from "next/link"
import { ArrowRight, Building2, Quote, Star, TrendingUp } from "lucide-react"
import { GlassPanel, Grad, SectionHeading } from "@/saas/web/sections"
import { getCmsClients, getCmsTestimonials } from "@/hrm-server/saas/cms"
import { ClientLogo } from "@/saas/web/blocks/data-blocks"

export const dynamic = "force-dynamic"

export const metadata: Metadata = {
  title: "Valued Clients & Stories",
  description: "Organizations across manufacturing, logistics, retail, healthcare, construction and software run their workforce on Finix HR — read their stories and results.",
  alternates: { canonical: "/clients" },
}

function anchor(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")
}

export default async function ClientsPage() {
  const [clients, testimonials] = await Promise.all([getCmsClients(), getCmsTestimonials()])
  const featured = clients.filter((c) => c.featured)
  const stories = clients.filter((c) => c.story)

  return (
    <>
      {/* ---- header ---- */}
      <section className="relative overflow-hidden bg-slate-950 light:bg-white">
        <div aria-hidden className="pointer-events-none absolute inset-0">
          <div className="absolute left-1/2 top-[-180px] h-[380px] w-[720px] -translate-x-1/2 rounded-full bg-cyan-500/15 blur-[120px] light:opacity-50" />
        </div>
        <div className="relative mx-auto max-w-4xl px-4 py-20 text-center sm:px-6">
          <p className="text-xs font-bold uppercase tracking-[0.2em] text-cyan-300 light:text-cyan-700">Valued clients</p>
          <h1 className="mt-4 text-4xl font-bold tracking-tight text-white text-balance light:text-slate-900 sm:text-5xl">
            Teams that run HR on <Grad>Finix HR</Grad>
          </h1>
          <p className="mx-auto mt-6 max-w-2xl text-lg leading-relaxed text-slate-400 light:text-slate-600">
            From factory floors to field fleets, organizations trust Finix HR for daily workforce operations —
            attendance, payroll, tracking and analytics in one workspace.
          </p>
        </div>
      </section>

      {/* ---- logo wall ---- */}
      <section className="border-y border-white/10 bg-slate-950 light:border-slate-200 light:bg-slate-50">
        <div className="mx-auto max-w-7xl px-4 py-12 sm:px-6">
          <div className="flex flex-wrap items-center justify-center gap-x-14 gap-y-8">
            {clients.map((c) => (
              <ClientLogo key={c.id} client={c} size={56} />
            ))}
          </div>
          <p className="mt-8 text-center text-[11px] text-slate-500">
            Reference clients shown with placeholder branding — managed entirely from the Owner Console.
          </p>
        </div>
      </section>

      {/* ---- featured clients ---- */}
      {featured.length > 0 && (
        <section className="bg-slate-950 light:bg-white">
          <div className="mx-auto max-w-7xl px-4 py-20 sm:px-6">
            <SectionHeading eyebrow="Featured" title="Client highlights" sub="A closer look at the organizations getting the most from the platform." />
            <div className="mt-12 grid gap-4 md:grid-cols-2">
              {featured.map((c) => (
                <GlassPanel key={c.id} className="p-6">
                  <div className="flex items-start gap-4">
                    <ClientLogo client={c} size={52} />
                    <div className="min-w-0 flex-1">
                      <h3 className="text-[16px] font-bold text-white light:text-slate-900">{c.name}</h3>
                      <p className="mt-0.5 flex items-center gap-1.5 text-xs font-medium text-cyan-600 light:text-cyan-700">
                        <Building2 className="h-3 w-3" /> {c.industry}
                      </p>
                      <p className="mt-2 text-[13px] leading-relaxed text-slate-400 light:text-slate-600">{c.description}</p>
                    </div>
                  </div>
                  {c.quote && (
                    <blockquote className="mt-4 rounded-xl border border-white/10 bg-gradient-to-br from-white/[0.04] to-transparent p-4 light:border-slate-200 light:from-slate-50 light:to-white">
                      <Quote className="h-3.5 w-3.5 text-cyan-500/70" />
                      <p className="mt-1.5 text-[13px] italic leading-relaxed text-slate-300 light:text-slate-700">“{c.quote}”</p>
                      {c.personName && <p className="mt-2 text-[11px] font-semibold text-slate-400 light:text-slate-500">{c.personName}{c.personRole ? ` · ${c.personRole}` : ""}</p>}
                    </blockquote>
                  )}
                  <Link href="#stories" className="mt-4 inline-flex items-center gap-1 text-xs font-semibold text-cyan-600 hover:text-cyan-500 light:text-cyan-700">
                    Read the full story <ArrowRight className="h-3 w-3" />
                  </Link>
                </GlassPanel>
              ))}
            </div>
          </div>
        </section>
      )}

      {/* ---- detailed stories ---- */}
      <section id="stories" className="border-y border-white/10 bg-slate-950 light:border-slate-200 light:bg-slate-50">
        <div className="mx-auto max-w-4xl px-4 py-20 sm:px-6">
          <SectionHeading eyebrow="Client stories" title="From spreadsheet islands to one workspace" sub="How teams moved to Finix HR and what changed — in their own workflows, with real results." />
          <div className="mt-12 space-y-6">
            {stories.map((c) => (
              <section key={c.id} id={anchor(c.name)} className="scroll-mt-24">
                <GlassPanel className="p-6 sm:p-8">
                  <div className="flex flex-wrap items-center gap-4">
                    <ClientLogo client={c} size={48} />
                    <div>
                      <h3 className="text-[17px] font-bold text-white light:text-slate-900">{c.name}</h3>
                      <p className="mt-0.5 text-xs font-medium text-cyan-600 light:text-cyan-700">{c.industry}</p>
                    </div>
                  </div>
                  <p className="mt-4 text-[14px] leading-relaxed text-slate-300 light:text-slate-700">{c.story}</p>
                  {c.metrics.length > 0 && (
                    <div className="mt-6 grid gap-3 sm:grid-cols-3">
                      {c.metrics.map((m, i) => (
                        <div key={i} className="rounded-xl border border-white/10 bg-white/[0.02] p-4 text-center light:border-slate-200 light:bg-white">
                          <p className="flex items-center justify-center gap-1.5 text-lg font-bold text-white light:text-slate-900">
                            {i === 0 && <TrendingUp className="h-4 w-4 text-emerald-400 light:text-emerald-600" />}
                            {m.value}
                          </p>
                          <p className="mt-1 text-[11px] text-slate-500">{m.label}</p>
                        </div>
                      ))}
                    </div>
                  )}
                  {c.quote && (
                    <blockquote className="mt-6 border-l-2 border-cyan-500/60 pl-4">
                      <p className="text-[13px] italic leading-relaxed text-slate-400 light:text-slate-600">“{c.quote}”</p>
                      {c.personName && <footer className="mt-2 text-[11px] font-semibold text-slate-500">{c.personName}{c.personRole ? ` · ${c.personRole}, ${c.name}` : ""}</footer>}
                    </blockquote>
                  )}
                </GlassPanel>
              </section>
            ))}
          </div>
        </div>
      </section>

      {/* ---- testimonials wall ---- */}
      {testimonials.length > 0 && (
        <section className="bg-slate-950 light:bg-white">
          <div className="mx-auto max-w-7xl px-4 py-20 sm:px-6">
            <SectionHeading eyebrow="Testimonials" title="What operators say" />
            <div className="mt-12 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
              {testimonials.map((t) => (
                <GlassPanel key={t.id} className="flex flex-col p-6">
                  <div className="flex gap-0.5">
                    {Array.from({ length: Math.max(1, Math.min(5, t.rating)) }).map((_, i) => (
                      <Star key={i} className="h-3.5 w-3.5 fill-amber-400 text-amber-400" />
                    ))}
                  </div>
                  <p className="mt-3 flex-1 text-[13px] italic leading-relaxed text-slate-300 light:text-slate-700">“{t.quote}”</p>
                  <div className="mt-4 border-t border-white/10 pt-4 light:border-slate-200">
                    <p className="text-[12px] font-semibold text-white light:text-slate-900">{t.personName}</p>
                    <p className="text-[11px] text-slate-500">{t.personRole} · {t.clientName}</p>
                  </div>
                </GlassPanel>
              ))}
            </div>
          </div>
        </section>
      )}

      {/* ---- CTA ---- */}
      <section className="relative overflow-hidden border-t border-white/10 bg-slate-950 light:border-slate-200 light:bg-slate-50">
        <div aria-hidden className="pointer-events-none absolute inset-0">
          <div className="absolute left-1/2 top-0 h-[420px] w-[820px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-cyan-500/15 blur-3xl light:opacity-60" />
        </div>
        <div className="relative mx-auto max-w-4xl px-4 py-20 text-center sm:px-6">
          <h2 className="text-3xl font-bold tracking-tight text-white light:text-slate-900 sm:text-4xl">Join these teams on Finix HR</h2>
          <p className="mx-auto mt-4 max-w-2xl text-base leading-relaxed text-slate-400 light:text-slate-600">
            Register your organization in about five minutes. A platform administrator reviews every application before workspaces go live.
          </p>
          <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <Link href="/register" className="inline-flex h-11 items-center gap-2 rounded-xl bg-gradient-to-r from-blue-600 to-violet-600 px-6 text-sm font-semibold text-white shadow-lg shadow-indigo-950/60 hover:from-blue-500 hover:to-violet-500">
              Register your organization <ArrowRight className="h-4 w-4" />
            </Link>
            <Link href="/features" className="inline-flex h-11 items-center rounded-xl border border-white/15 px-6 text-sm font-semibold text-white hover:bg-white/5 light:border-slate-300 light:text-slate-800 light:hover:bg-slate-100">
              Explore features
            </Link>
          </div>
        </div>
      </section>
    </>
  )
}

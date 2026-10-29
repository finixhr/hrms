// ============ Data-driven blocks: features, feature-demo, clients, testimonials, FAQ ============
// Server components that read the live CMS collections (features/clients/
// testimonials) — so the homepage and custom pages always show what the
// owner published. Fallbacks keep sections graceful when empty.
import Link from "next/link"
import { ArrowRight, CheckCircle2, ChevronDown, Quote, Star, TrendingUp } from "lucide-react"
import { GlassPanel, Grad, SectionHeading } from "@/saas/web/sections"
import { getCmsFeatures, getCmsClients, getCmsTestimonials } from "@/hrm-server/saas/cms"
import { FeatureVisual } from "@/saas/web/visuals"
import type { ClientRecord } from "@/saas/web/content-types"

const str = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : fallback)
const arr = <T,>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : [])

// ---------- shared client logo ----------
export function ClientLogo({ client, size = 44 }: { client: ClientRecord; size?: number }) {
  if (client.logoUrl) {
    return (
      <img src={client.logoUrl} alt={client.name} className="rounded-xl object-contain" style={{ height: size, width: size }} />
    )
  }
  return (
    <span
      className="flex items-center justify-center rounded-xl text-sm font-bold text-white shadow-lg"
      style={{ height: size, width: size, background: `linear-gradient(135deg, ${client.logoColor}, ${client.logoColor}cc)` }}
    >
      {(client.logoText || client.name.split(" ").map((w) => w[0]).slice(0, 2).join("")).toUpperCase()}
    </span>
  )
}

// ---------- features grid (from CMS features or custom items) ----------
export async function FeaturesBlock({ data }: { data: Record<string, unknown> }) {
  let items: { title: string; desc: string; href: string; icon?: string }[] = []
  if (data.source === "cms-features") {
    const features = (await getCmsFeatures()).filter((f) => f.showOnHome)
    items = features.map((f) => ({ title: f.title, desc: f.sub, href: `/features/${f.slug}`, icon: f.icon }))
  } else {
    items = arr<{ title: string; desc?: string; href?: string; icon?: string }>(data.items).map((it) => ({
      title: it.title, desc: it.desc ?? "", href: it.href ?? "#", icon: it.icon,
    }))
  }
  if (items.length === 0) return null
  const title = str(data.title)
  return (
    <section className="bg-slate-950 light:bg-white">
      <div className="mx-auto max-w-7xl px-4 py-20 sm:px-6">
        <SectionHeading
          eyebrow={str(data.eyebrow, "One platform")}
          title={title ? <>{title}</> : <>Everything your HR team runs, <Grad>in one system</Grad></>}
          sub={str(data.sub, "Each module below exists in the shipped product today — nothing on this page is a promise about the future.")}
        />
        <div className="mt-12 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {items.map((it) => (
            <Link
              key={it.href + it.title}
              href={it.href}
              data-cursor="card"
              className="group rounded-2xl border border-white/10 bg-white/[0.03] p-6 transition-all hover:-translate-y-0.5 hover:border-indigo-400/40 hover:bg-white/[0.05] light:border-slate-200 light:bg-white light:shadow-sm light:hover:border-indigo-500/50"
            >
              <div className="flex items-center justify-between gap-3">
                <h3 className="text-[15px] font-bold text-white light:text-slate-900">{it.title}</h3>
                <ArrowRight className="h-4 w-4 shrink-0 text-slate-600 transition-all group-hover:translate-x-0.5 group-hover:text-indigo-300 light:text-slate-400 light:group-hover:text-indigo-600" />
              </div>
              <p className="mt-3 line-clamp-3 text-[13px] leading-relaxed text-slate-400 light:text-slate-600">{it.desc}</p>
            </Link>
          ))}
        </div>
        <div className="mt-8 text-center">
          <Link href="/features" className="text-sm font-semibold text-indigo-300 hover:text-indigo-200 light:text-indigo-600 light:hover:text-indigo-500">
            Browse the full feature catalog →
          </Link>
        </div>
      </div>
    </section>
  )
}

// ---------- feature demo (floating visual simulation) ----------
export async function FeatureDemoBlock({ data }: { data: Record<string, unknown> }) {
  const slug = str(data.featureSlug)
  const features = await getCmsFeatures()
  const feature = features.find((f) => f.slug === slug) ?? features[0]
  if (!feature) return null
  const flip = data.flip === true
  const bullets = feature.content?.capabilities?.[0]?.items?.slice(0, 4) ?? []
  return (
    <section className="border-y border-white/10 bg-slate-950 light:border-slate-200 light:bg-slate-50">
      <div className="mx-auto max-w-7xl px-4 py-20 sm:px-6">
        <div className="grid items-center gap-10 lg:grid-cols-2">
          {!flip && <FeatureDemoCopy feature={feature} eyebrow={str(data.eyebrow)} title={str(data.title)} sub={str(data.sub)} bullets={bullets} />}
          <div className="relative">
            <div aria-hidden className="absolute -inset-8 rounded-[40px] bg-gradient-to-br from-indigo-600/20 via-violet-600/10 to-transparent blur-2xl light:opacity-60" />
            <FeatureVisual visual={feature.visual} className="relative" />
          </div>
          {flip && <FeatureDemoCopy feature={feature} eyebrow={str(data.eyebrow)} title={str(data.title)} sub={str(data.sub)} bullets={bullets} />}
        </div>
      </div>
    </section>
  )
}

function FeatureDemoCopy({ feature, eyebrow, title, sub, bullets }: {
  feature: { title: string; headline: string; sub: string; slug: string }
  eyebrow: string; title: string; sub: string; bullets: string[]
}) {
  return (
    <div>
      <SectionHeading
        align="left"
        eyebrow={eyebrow || feature.title}
        title={<>{title || feature.headline}</>}
        sub={sub || feature.sub}
      />
      {bullets.length > 0 && (
        <ul className="mt-6 space-y-2.5">
          {bullets.map((b, i) => (
            <li key={i} className="flex items-start gap-2.5 text-[14px] text-slate-300 light:text-slate-700">
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400 light:text-emerald-600" /> {b}
            </li>
          ))}
        </ul>
      )}
      <Link href={`/features/${feature.slug}`} className="mt-6 inline-flex items-center gap-1.5 text-sm font-semibold text-indigo-300 hover:text-indigo-200 light:text-indigo-600 light:hover:text-indigo-500">
        Explore {feature.title} <ArrowRight className="h-4 w-4" />
      </Link>
    </div>
  )
}

// ---------- valued clients ----------
export async function ClientsBlock({ data }: { data: Record<string, unknown> }) {
  const clients = await getCmsClients()
  if (clients.length === 0) return null
  const layout = str(data.layout, "grid")
  const showStories = data.showStories !== false

  if (layout === "logos") {
    return (
      <section className="border-y border-white/10 bg-slate-950 light:border-slate-200 light:bg-slate-50">
        <div className="mx-auto max-w-7xl px-4 py-12 sm:px-6">
          <SectionHeading eyebrow={str(data.eyebrow, "Valued clients")} title={<>{str(data.title, "Trusted by teams across industries")}</>} sub={str(data.sub)} />
          <div className="mt-10 flex flex-wrap items-center justify-center gap-x-12 gap-y-6">
            {clients.map((c) => (
              <ClientLogo key={c.id} client={c} size={52} />
            ))}
          </div>
        </div>
      </section>
    )
  }

  return (
    <section className="relative overflow-hidden bg-slate-950 light:bg-white">
      <div aria-hidden className="pointer-events-none absolute inset-0">
        <div className="absolute right-[-140px] top-[80px] h-[320px] w-[320px] rounded-full bg-cyan-500/10 blur-[110px] light:opacity-50" />
      </div>
      <div className="relative mx-auto max-w-7xl px-4 py-20 sm:px-6">
        <SectionHeading
          eyebrow={str(data.eyebrow, "Valued clients")}
          title={<>{str(data.title, "Teams that run HR on Finix HR")}</>}
          sub={str(data.sub)}
        />
        <div className="mt-12 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {clients.map((c) => (
            <ClientCard key={c.id} client={c} showStory={showStories} />
          ))}
        </div>
        <div className="mt-10 text-center">
          <Link href="/clients" className="inline-flex items-center gap-1.5 rounded-xl border border-white/15 px-5 py-2.5 text-sm font-semibold text-white hover:bg-white/5 light:border-slate-300 light:text-slate-800 light:hover:bg-slate-100">
            Read client stories <ArrowRight className="h-4 w-4" />
          </Link>
        </div>
      </div>
    </section>
  )
}

export function ClientCard({ client, showStory = true }: { client: ClientRecord; showStory?: boolean }) {
  return (
    <GlassPanel className="p-6 transition-all hover:-translate-y-0.5 hover:border-indigo-400/40">
      <div className="flex items-start gap-4">
        <ClientLogo client={client} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="truncate text-[15px] font-bold text-white light:text-slate-900">{client.name}</h3>
            {client.featured && (
              <span className="rounded-full bg-gradient-to-r from-amber-400/20 to-orange-400/20 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-amber-300 light:text-amber-700 ring-1 ring-amber-400/30 light:ring-amber-300">
                Featured
              </span>
            )}
          </div>
          <p className="mt-0.5 text-xs font-medium text-indigo-300 light:text-indigo-600">{client.industry}</p>
          <p className="mt-2 text-[13px] leading-relaxed text-slate-400 light:text-slate-600">{client.description}</p>
        </div>
      </div>

      {client.metrics.length > 0 && (
        <div className="mt-4 grid grid-cols-3 gap-2 rounded-xl border border-white/10 bg-white/[0.02] p-3 light:border-slate-200 light:bg-slate-50">
          {client.metrics.slice(0, 3).map((m, i) => (
            <div key={i} className="text-center">
              <p className="flex items-center justify-center gap-1 text-[13px] font-bold text-white light:text-slate-900">
                {i === 0 && <TrendingUp className="h-3 w-3 text-emerald-400 light:text-emerald-600" />}
                {m.value}
              </p>
              <p className="mt-0.5 text-[10px] leading-tight text-slate-500">{m.label}</p>
            </div>
          ))}
        </div>
      )}

      {showStory && client.quote && (
        <div className="mt-4 rounded-xl border border-white/10 bg-gradient-to-br from-white/[0.04] to-transparent p-4 light:border-slate-200 light:from-slate-50 light:to-white">
          <Quote className="h-3.5 w-3.5 text-indigo-400/70" />
          <p className="mt-1.5 line-clamp-3 text-[13px] italic leading-relaxed text-slate-300 light:text-slate-700">“{client.quote}”</p>
          {client.personName && (
            <p className="mt-2 text-[11px] font-semibold text-slate-400 light:text-slate-500">
              {client.personName}{client.personRole ? ` · ${client.personRole}` : ""}
            </p>
          )}
        </div>
      )}

      <Link href={`/clients#${slugAnchor(client.name)}`} className="mt-4 inline-flex items-center gap-1 text-xs font-semibold text-indigo-300 hover:text-indigo-200 light:text-indigo-600">
        Read the full story <ArrowRight className="h-3 w-3" />
      </Link>
    </GlassPanel>
  )
}

function slugAnchor(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")
}

// ---------- testimonials ----------
export async function TestimonialsBlock({ data }: { data: Record<string, unknown> }) {
  const testimonials = await getCmsTestimonials()
  if (testimonials.length === 0) return null
  return (
    <section className="border-y border-white/10 bg-slate-950 light:border-slate-200 light:bg-slate-50">
      <div className="mx-auto max-w-7xl px-4 py-20 sm:px-6">
        <SectionHeading eyebrow={str(data.eyebrow, "Testimonials")} title={<>{str(data.title, "What HR teams say")}</>} sub={str(data.sub)} />
        <div className="mt-12 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          {testimonials.slice(0, 8).map((t) => (
            <GlassPanel key={t.id} className="flex flex-col p-6">
              <div className="flex gap-0.5">
                {Array.from({ length: Math.max(1, Math.min(5, t.rating)) }).map((_, i) => (
                  <Star key={i} className="h-3.5 w-3.5 fill-amber-400 text-amber-400" />
                ))}
              </div>
              <p className="mt-3 flex-1 text-[13px] italic leading-relaxed text-slate-300 light:text-slate-700">“{t.quote}”</p>
              <div className="mt-4 flex items-center gap-3 border-t border-white/10 pt-4 light:border-slate-200">
                <span className="flex h-8 w-8 items-center justify-center rounded-full bg-gradient-to-br from-blue-600 to-violet-600 text-[11px] font-bold text-white">
                  {t.personName.split(" ").map((w) => w[0]).slice(0, 2).join("").toUpperCase()}
                </span>
                <div className="min-w-0">
                  <p className="truncate text-[12px] font-semibold text-white light:text-slate-900">{t.personName}</p>
                  <p className="truncate text-[11px] text-slate-500">{t.personRole} · {t.clientName}</p>
                </div>
              </div>
            </GlassPanel>
          ))}
        </div>
      </div>
    </section>
  )
}

// ---------- FAQ (native details/summary — zero client JS) ----------
export function FaqBlock({ data }: { data: Record<string, unknown> }) {
  const items = arr<{ q: string; a: string }>(data.items)
  if (items.length === 0) return null
  return (
    <section className="bg-slate-950 light:bg-white">
      <div className="mx-auto max-w-3xl px-4 py-20 sm:px-6">
        <SectionHeading eyebrow={str(data.eyebrow, "FAQ")} title={<>{str(data.title, "Frequently asked questions")}</>} sub={str(data.sub)} />
        <div className="mt-10 space-y-3">
          {items.map((f, i) => (
            <details key={i} className="group rounded-xl border border-white/10 bg-white/[0.03] transition-colors hover:border-white/20 light:border-slate-200 light:bg-white light:shadow-sm">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-4 px-5 py-4 text-[15px] font-semibold text-white light:text-slate-900 [&::-webkit-details-marker]:hidden">
                {f.q}
                <ChevronDown className="h-4 w-4 shrink-0 text-slate-500 transition-transform group-open:rotate-180" />
              </summary>
              <p className="px-5 pb-5 text-[14px] leading-relaxed text-slate-400 light:text-slate-600">{f.a}</p>
            </details>
          ))}
        </div>
      </div>
    </section>
  )
}

// ============ Simple page-builder blocks (server components, zero client JS) ============
// Rendered by BlockRenderer from CMS page JSON. Each block reads its shape
// from `data` with graceful fallbacks so half-edited content never breaks
// the page. Data shapes are validated owner-side (cms-routes zod) — here we
// only default missing optional fields.
import Link from "next/link"
import type { ReactNode } from "react"
import {
  Activity, ArrowRight, Building2, CheckCircle2, Layers, Quote, Scaling, ShieldCheck, Star, Users,
} from "lucide-react"
import { GlassPanel, SectionHeading } from "@/saas/web/sections"
import { cn } from "@/lib/utils"

const str = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : fallback)
const arr = <T,>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : [])

// ---------- stats ----------
export function StatsBlock({ data }: { data: Record<string, unknown> }) {
  const items = arr<{ value: string; label: string; sub?: string }>(data.items)
  return (
    <section className="border-y border-white/10 bg-slate-950 light:border-slate-200 light:bg-slate-50">
      <div className="mx-auto max-w-7xl px-4 py-12 sm:px-6">
        {str(data.title) && (
          <p className="mb-6 text-center text-xs font-bold uppercase tracking-[0.2em] text-indigo-300 light:text-indigo-600">{str(data.title)}</p>
        )}
        <div className="grid grid-cols-2 gap-6 sm:grid-cols-3 lg:grid-cols-5">
          {items.map((s, i) => (
            <div key={i} className="text-center">
              <p className="bg-gradient-to-r from-blue-400 to-violet-400 bg-clip-text text-3xl font-bold tabular-nums text-transparent light:from-blue-600 light:to-violet-600">{s.value}</p>
              <p className="mt-1 text-xs text-slate-400 light:text-slate-600">{s.label}</p>
              {s.sub && <p className="mt-0.5 text-[10px] text-slate-500">{s.sub}</p>}
            </div>
          ))}
        </div>
        {str(data.note) && <p className="mt-6 text-center text-[11px] text-slate-500">{str(data.note)}</p>}
      </div>
    </section>
  )
}

// ---------- value props ----------
const VALUE_ICONS: Record<string, any> = {
  layers: Layers, building: Building2, activity: Activity, shield: ShieldCheck, scaling: Scaling, users: Users,
}

export function ValuePropsBlock({ data }: { data: Record<string, unknown> }) {
  const items = arr<{ icon: string; title: string; body: string }>(data.items)
  return (
    <section className="border-y border-white/10 bg-slate-950 light:border-slate-200 light:bg-slate-50">
      <div className="mx-auto max-w-7xl px-4 py-16 sm:px-6">
        {str(data.title) && (
          <SectionHeading eyebrow={str(data.eyebrow)} title={<>{str(data.title)}</>} sub={str(data.sub)} />
        )}
        <div className={cn("mt-10 grid gap-4", items.length === 5 ? "sm:grid-cols-2 lg:grid-cols-5" : "sm:grid-cols-2 lg:grid-cols-3")}>
          {items.map((v, i) => {
            const Icon = VALUE_ICONS[v.icon] ?? Layers
            return (
              <div key={i} data-cursor="card" className="rounded-2xl border border-white/10 bg-white/[0.03] p-5 transition-colors hover:border-white/20 hover:bg-white/[0.05] light:border-slate-200 light:bg-white light:shadow-sm light:hover:border-slate-300">
                <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-gradient-to-br from-blue-500/20 to-violet-500/20 ring-1 ring-white/10 light:ring-slate-200">
                  <Icon className="h-4 w-4 text-indigo-300 light:text-indigo-600" />
                </span>
                <h3 className="mt-4 text-[15px] font-bold text-white light:text-slate-900">{v.title}</h3>
                <p className="mt-2 text-[13px] leading-relaxed text-slate-400 light:text-slate-600">{v.body}</p>
              </div>
            )
          })}
        </div>
      </div>
    </section>
  )
}

// ---------- generic cards ----------
export function CardsBlock({ data }: { data: Record<string, unknown> }) {
  const items = arr<{ icon?: string; title: string; body: string; items?: string[]; href?: string }>(data.items)
  return (
    <section className={cn("py-16", str(data.tone) === "muted" ? "border-y border-white/10 bg-slate-950 light:border-slate-200 light:bg-slate-50" : "bg-slate-950 light:bg-white")}>
      <div className="mx-auto max-w-7xl px-4 sm:px-6">
        <SectionHeading eyebrow={str(data.eyebrow)} title={<>{str(data.title)}</>} sub={str(data.sub)} />
        <div className="mt-12 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {items.map((c, i) => (
            <GlassPanel key={i} className="p-6">
              <h3 className="text-[15px] font-bold text-white light:text-slate-900">{c.title}</h3>
              <p className="mt-2 text-[13px] leading-relaxed text-slate-400 light:text-slate-600">{c.body}</p>
              {c.items && c.items.length > 0 && (
                <ul className="mt-4 space-y-1.5">
                  {c.items.map((it, j) => (
                    <li key={j} className="flex items-center gap-2 text-[12px] text-slate-300 light:text-slate-700">
                      <CheckCircle2 className="h-3 w-3 text-emerald-400 light:text-emerald-600 shrink-0" /> {it}
                    </li>
                  ))}
                </ul>
              )}
              {c.href && (
                <Link href={c.href} className="mt-4 inline-flex items-center gap-1 text-xs font-semibold text-indigo-300 hover:text-indigo-200 light:text-indigo-600">
                  Learn more <ArrowRight className="h-3 w-3" />
                </Link>
              )}
            </GlassPanel>
          ))}
        </div>
      </div>
    </section>
  )
}

// ---------- how it works ----------
export function HowItWorksBlock({ data }: { data: Record<string, unknown> }) {
  const steps = arr<{ step: string; title: string; body: string }>(data.steps)
  return (
    <section className="bg-slate-950 light:bg-white">
      <div className="mx-auto max-w-7xl px-4 py-20 sm:px-6">
        <SectionHeading eyebrow={str(data.eyebrow) || "How it works"} title={<>{str(data.title)}</>} sub={str(data.sub)} />
        <div className="relative mt-12 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          {steps.map((s, i) => (
            <div key={i} className="relative rounded-2xl border border-white/10 bg-white/[0.03] p-6 light:border-slate-200 light:bg-white light:shadow-sm">
              <span className="flex h-9 w-9 items-center justify-center rounded-full bg-gradient-to-br from-blue-600 to-violet-600 text-sm font-bold text-white shadow-lg shadow-indigo-950/50">
                {s.step || String(i + 1)}
              </span>
              <h3 className="mt-4 text-[15px] font-bold text-white light:text-slate-900">{s.title}</h3>
              <p className="mt-2 text-[13px] leading-relaxed text-slate-400 light:text-slate-600">{s.body}</p>
              {i < steps.length - 1 && (
                <ArrowRight aria-hidden className="absolute -right-3.5 top-1/2 hidden h-6 w-6 -translate-y-1/2 rounded-full border border-white/10 bg-slate-900 p-1 text-slate-500 light:border-slate-200 light:bg-white light:text-slate-400 xl:block" />
              )}
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}

// ---------- CTA band ----------
export function CtaBlock({ data }: { data: Record<string, unknown> }) {
  const primaryHref = str(data.primaryHref, "/register")
  const secondaryHref = str(data.secondaryHref, "/pricing")
  return (
    <section className="relative overflow-hidden border-y border-white/10 bg-slate-950 light:border-slate-200 light:bg-slate-50">
      <div aria-hidden className="pointer-events-none absolute inset-0">
        <div className="absolute left-1/2 top-0 h-[420px] w-[820px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-indigo-600/20 blur-3xl light:opacity-60" />
      </div>
      <div className="relative mx-auto max-w-4xl px-4 py-20 text-center sm:px-6">
        <h2 className="text-3xl font-bold tracking-tight text-white light:text-slate-900 sm:text-4xl">{str(data.title, "Start Your HR Journey")}</h2>
        <p className="mx-auto mt-4 max-w-2xl text-base leading-relaxed text-slate-400 light:text-slate-600">{str(data.sub)}</p>
        <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
          <Link href={primaryHref} className="inline-flex h-11 items-center gap-2 rounded-xl bg-gradient-to-r from-blue-600 to-violet-600 px-6 text-sm font-semibold text-white shadow-lg shadow-indigo-950/60 transition-all hover:from-blue-500 hover:to-violet-500">
            {str(data.primaryLabel, "Register your organization")} <ArrowRight className="h-4 w-4" />
          </Link>
          {str(data.secondaryLabel) && (
            <Link href={secondaryHref} className="inline-flex h-11 items-center rounded-xl border border-white/15 px-6 text-sm font-semibold text-white transition-colors hover:bg-white/5 light:border-slate-300 light:text-slate-800 light:hover:bg-slate-100">
              {str(data.secondaryLabel)}
            </Link>
          )}
        </div>
        {str(data.note) && (
          <p className="mt-6 text-xs text-slate-500">
            {str(data.note)} <Link href="/registration-status" className="text-indigo-300 hover:text-indigo-200 light:text-indigo-600 light:hover:text-indigo-500">Track your application status</Link>
          </p>
        )}
      </div>
    </section>
  )
}

// ---------- plain text ----------
export function TextBlock({ data }: { data: Record<string, unknown> }) {
  const paragraphs = arr<string>(data.body)
  return (
    <section className="bg-slate-950 light:bg-white">
      <div className="mx-auto max-w-3xl px-4 py-16 sm:px-6">
        <h2 className="text-2xl font-bold tracking-tight text-white light:text-slate-900">{str(data.title)}</h2>
        {paragraphs.map((p, i) => (
          <p key={i} className="mt-4 text-[15px] leading-relaxed text-slate-400 light:text-slate-600">{p}</p>
        ))}
      </div>
    </section>
  )
}

// ---------- text + image ----------
export function TextImageBlock({ data }: { data: Record<string, unknown> }) {
  const bullets = arr<string>(data.bullets)
  const image = str(data.image)
  const flip = data.flip === true
  const media: ReactNode = image ? (
    <img src={image} alt={str(data.imageAlt, str(data.title))} className="h-auto w-full rounded-2xl border border-white/10 object-cover shadow-2xl light:border-slate-200" />
  ) : (
    <div className="flex h-64 items-center justify-center rounded-2xl border border-dashed border-white/15 bg-white/[0.02] text-sm text-slate-500 light:border-slate-300 light:bg-slate-50">
      Image placeholder
    </div>
  )
  const copy = (
    <div>
      <h2 className="text-2xl font-bold tracking-tight text-white light:text-slate-900 sm:text-3xl">{str(data.title)}</h2>
      {arr<string>(data.body).map((p, i) => (
        <p key={i} className="mt-4 text-[15px] leading-relaxed text-slate-400 light:text-slate-600">{p}</p>
      ))}
      {bullets.length > 0 && (
        <ul className="mt-5 space-y-2">
          {bullets.map((b, i) => (
            <li key={i} className="flex items-start gap-2 text-[14px] text-slate-300 light:text-slate-700">
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400 light:text-emerald-600" /> {b}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
  return (
    <section className="bg-slate-950 light:bg-white">
      <div className="mx-auto grid max-w-7xl items-center gap-10 px-4 py-16 sm:px-6 lg:grid-cols-2">
        {flip ? <>{media}{copy}</> : <>{copy}{media}</>}
      </div>
    </section>
  )
}

// ---------- logo strip ----------
export function LogosBlock({ data }: { data: Record<string, unknown> }) {
  const items = arr<{ name: string; logoText?: string | null; logoColor?: string; logoUrl?: string | null }>(data.items)
  return (
    <section className="border-y border-white/10 bg-slate-950 light:border-slate-200 light:bg-slate-50">
      <div className="mx-auto max-w-7xl px-4 py-10 sm:px-6">
        {str(data.title) && <p className="text-center text-xs font-bold uppercase tracking-[0.2em] text-slate-500">{str(data.title)}</p>}
        <div className="mt-6 flex flex-wrap items-center justify-center gap-x-10 gap-y-4">
          {items.map((l, i) => (
            <div key={i} className="flex items-center gap-2 opacity-70 transition-opacity hover:opacity-100">
              {l.logoUrl ? (
                <img src={l.logoUrl} alt={l.name} className="h-7 w-auto" />
              ) : (
                <span className="flex h-8 w-8 items-center justify-center rounded-lg text-xs font-bold text-white" style={{ background: l.logoColor || "#334155" }}>
                  {(l.logoText || l.name.slice(0, 2)).toUpperCase()}
                </span>
              )}
              <span className="text-sm font-semibold text-slate-400 light:text-slate-500">{l.name}</span>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}

// ---------- custom HTML (owner-authored; platform plane) ----------
/** V6-001: Sanitize owner-authored CMS HTML to strip script tags and inline
 *  event handlers. This content is editable only by platform owners (not
 *  tenants or end-users), but defence-in-depth still applies. */
function sanitizeCmsHtml(raw: string): string {
  return raw
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
    .replace(/on\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/javascript\s*:/gi, "")
    .replace(/href\s*=\s*["']?\s*javascript/gi, "href=\"#\"")
}

export function CustomHtmlBlock({ data }: { data: Record<string, unknown> }) {
  const html = str(data.html)
  if (!html) return null
  return (
    <section className="bg-slate-950 light:bg-white">
      <div className="mx-auto max-w-7xl px-4 py-12 sm:px-6">
        <div className="cms-custom-html text-slate-300 light:text-slate-700 [&_a]:text-indigo-300 [&_a]:underline light:[&_a]:text-indigo-600" dangerouslySetInnerHTML={{ __html: sanitizeCmsHtml(html) }} />
      </div>
    </section>
  )
}

// ---------- shared quote snippet ----------
export function QuoteMark({ children }: { children: ReactNode }) {
  return (
    <span className="flex gap-2">
      <Quote className="h-4 w-4 shrink-0 text-indigo-400/70" />
      <span>{children}</span>
    </span>
  )
}

export const STARS = [Star, Star, Star, Star, Star]

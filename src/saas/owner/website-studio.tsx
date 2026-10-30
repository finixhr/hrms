"use client"
// ============ Website Studio — complete public-site CMS management ============
// Lives as a tab inside Platform Settings. Sub-tabs cover: identity/branding,
// navigation, footer, pages & page builder, features, clients & stories,
// testimonials, media library, SEO and contact info. Everything saves through
// owner.cms.* actions (zod-validated, audited, cache-invalidating) so changes
// go live on the public site immediately after saving.
import { useEffect, useState } from "react"
import Link from "next/link"
import {
  Building2, Contact, FileText, Globe, Image, LayoutTemplate, Megaphone, Menu,
  MousePointerClick, Palette, Search, Sparkles, Star, Upload,
} from "lucide-react"
import { useOwnerApi, ownerRpc } from "@/saas/owner/client"
import { ErrorBanner, Loading } from "@/saas/owner/ui"
import type { SiteIdentity } from "@/saas/web/content-types"
import { StudioTabs, WCard, WField, WTextArea, ImagePicker, inputCls, SuccessNote, ErrorNote } from "./website/ui"
import { Input } from "@/components/ui/input"
import { NavFooterTabs } from "./website/nav-footer-tab"
import { PagesTab } from "./website/pages-tab"
import { FeaturesTab } from "./website/features-tab"
import { ClientsTab } from "./website/clients-tab"
import { TestimonialsTab } from "./website/testimonials-tab"
import { MediaTab } from "./website/seo-contact-tab"
import { SeoContactTabs } from "./website/seo-contact-tab"
import { CursorTab } from "./website/cursor-tab"

type StudioTab =
  | "overview" | "identity" | "nav" | "footer" | "pages"
  | "features" | "clients" | "testimonials" | "media" | "seo" | "contact" | "cursor"

const TABS: { key: StudioTab; label: string; icon: any }[] = [
  { key: "overview", label: "Overview", icon: LayoutTemplate },
  { key: "identity", label: "Identity & Branding", icon: Palette },
  { key: "nav", label: "Navigation", icon: Menu },
  { key: "footer", label: "Footer", icon: FileText },
  { key: "pages", label: "Pages & Builder", icon: LayoutTemplate },
  { key: "features", label: "Features", icon: Sparkles },
  { key: "clients", label: "Clients & Stories", icon: Building2 },
  { key: "testimonials", label: "Testimonials", icon: Star },
  { key: "media", label: "Media Library", icon: Image },
  { key: "seo", label: "SEO", icon: Search },
  { key: "contact", label: "Contact Info", icon: Contact },
  { key: "cursor", label: "Cursor Effect", icon: MousePointerClick },
]

export function WebsiteStudio() {
  const [tab, setTab] = useState<StudioTab>("overview")
  return (
    <div className="space-y-4">
      <div className="rounded-2xl border border-white/10 light:border-slate-200 bg-gradient-to-br from-indigo-600/10 via-violet-600/5 to-transparent p-4 light:border-slate-200 light:from-indigo-50 light:to-white">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="flex items-center gap-2 text-sm font-bold text-white light:text-slate-900">
              <Globe className="h-4 w-4 text-indigo-400" /> Website Studio
            </p>
            <p className="mt-0.5 text-[11px] leading-relaxed text-slate-500">
              Everything you publish here appears on the public website immediately — branding, pages, sections, features, clients, SEO.
            </p>
          </div>
          <Link href="/" target="_blank" className="rounded-lg border border-white/15 px-3 py-1.5 text-[11px] font-semibold text-slate-300 light:border-slate-300 light:text-slate-700 hover:bg-white/5 light:hover:bg-slate-100">
            View live site ↗
          </Link>
        </div>
        <div className="mt-4">
          <StudioTabs tabs={TABS} active={tab} onChange={setTab} />
        </div>
      </div>

      {tab === "overview" && <OverviewTab onGo={setTab} />}
      {tab === "identity" && <IdentityTab />}
      {tab === "nav" && <NavFooterTabs initial="nav" />}
      {tab === "footer" && <NavFooterTabs initial="footer" />}
      {tab === "pages" && <PagesTab />}
      {tab === "features" && <FeaturesTab />}
      {tab === "clients" && <ClientsTab />}
      {tab === "testimonials" && <TestimonialsTab />}
      {tab === "media" && <MediaTab />}
      {tab === "seo" && <SeoContactTabs initial="seo" />}
      {tab === "contact" && <SeoContactTabs initial="contact" />}
      {tab === "cursor" && <CursorTab />}
    </div>
  )
}

// ============================== OVERVIEW ==============================
function OverviewTab({ onGo }: { onGo: (t: StudioTab) => void }) {
  const { data, loading, error, reload } = useOwnerApi<{
    counts: { pages: number; features: number; clients: number; testimonials: number; media: number }
    seeded: boolean
    lastUpdatedAt: string | null
  }>("owner.cms.overview", {})
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)

  if (loading) return <Loading />
  if (error) return <ErrorBanner message={error} />

  const seed = async () => {
    setBusy(true); setMsg(null); setErr(null)
    try {
      const r = await ownerRpc<{ seeded: Record<string, number> }>("owner.cms.seed", { only: "all" })
      const n = Object.keys(r.seeded || {}).length
      setMsg(n > 0 ? `Seeded ${n} default content entries (existing content untouched).` : "Everything is already seeded — nothing to add.")
      reload()
    } catch (e: any) { setErr(e?.message || "Seed failed") } finally { setBusy(false) }
  }

  const cards: { label: string; value: number; tab: StudioTab; icon: any }[] = [
    { label: "Pages", value: data?.counts.pages ?? 0, tab: "pages", icon: FileText },
    { label: "Features", value: data?.counts.features ?? 0, tab: "features", icon: Sparkles },
    { label: "Clients", value: data?.counts.clients ?? 0, tab: "clients", icon: Building2 },
    { label: "Testimonials", value: data?.counts.testimonials ?? 0, tab: "testimonials", icon: Star },
    { label: "Media files", value: data?.counts.media ?? 0, tab: "media", icon: Upload },
  ]

  return (
    <div className="space-y-4">
      <SuccessNote msg={msg} />
      <ErrorNote msg={err} />
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        {cards.map((c) => (
          <button key={c.label} type="button" onClick={() => onGo(c.tab)} className="rounded-2xl border border-white/10 bg-white/[0.03] p-4 text-left transition-colors hover:border-indigo-400/40 light:border-slate-200 light:bg-white light:shadow-sm light:hover:border-indigo-500/50">
            <c.icon className="h-4 w-4 text-indigo-300 light:text-indigo-600" />
            <p className="mt-2 text-2xl font-bold tabular-nums text-white light:text-slate-900">{c.value}</p>
            <p className="text-[11px] text-slate-500">{c.label}</p>
          </button>
        ))}
      </div>
      <WCard title="Getting started" desc={data?.seeded ? "The website is seeded and fully editable — your changes publish instantly." : "No CMS content in the database yet. The site currently renders built-in defaults; seed them to make everything editable."}>
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={seed} disabled={busy} className="rounded-lg bg-gradient-to-r from-blue-600 to-violet-600 px-4 py-2 text-xs font-semibold text-white disabled:opacity-60">
            {busy ? "Seeding…" : "Seed default content"}
          </button>
          <button type="button" onClick={() => onGo("identity")} className="rounded-lg border border-white/15 px-4 py-2 text-xs font-semibold text-slate-300 light:border-slate-300 light:text-slate-700 hover:bg-white/5 light:hover:bg-slate-100">
            Start with branding
          </button>
        </div>
        {data?.lastUpdatedAt && (
          <p className="text-[11px] text-slate-500">Last content update: {new Date(data.lastUpdatedAt).toLocaleString()}</p>
        )}
      </WCard>
    </div>
  )
}

// ============================== IDENTITY ==============================
function IdentityTab() {
  const { data, loading, error } = useOwnerApi<{ settings: { identity?: SiteIdentity } }>("owner.cms.settings.get", {})
  const [form, setForm] = useState<SiteIdentity | null>(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    if (data?.settings?.identity) setForm({ ...defaultIdentity, ...data.settings.identity })
  }, [data])

  if (loading) return <Loading />
  if (error) return <ErrorBanner message={error} />
  if (!form) return null

  const save = async () => {
    setBusy(true); setMsg(null); setErr(null)
    try {
      await ownerRpc("owner.cms.identity.save", { identity: form })
      setMsg("Identity saved — the site header, footer and metadata now use it."); setTimeout(() => setMsg(null), 5000)
    } catch (e: any) { setErr(e?.message || "Save failed") } finally { setBusy(false) }
  }

  return (
    <div className="space-y-4">
      <SuccessNote msg={msg} />
      <ErrorNote msg={err} />
      <div className="grid gap-4 xl:grid-cols-2">
        <WCard title="Brand identity" desc="Site name, tagline and description shown across the website, metadata and footer." onSave={save} busy={busy}>
          <WField label="Site name"><Input value={form.siteName} onChange={(e) => setForm({ ...form, siteName: e.target.value })} className={inputCls} /></WField>
          <WField label="Tagline"><Input value={form.tagline} onChange={(e) => setForm({ ...form, tagline: e.target.value })} className={inputCls} /></WField>
          <WTextArea label="Site description" value={form.description} onChange={(v) => setForm({ ...form, description: v })} rows={3} maxLength={2000} />
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <WField label="Company (legal/footer)"><Input value={form.company} onChange={(e) => setForm({ ...form, company: e.target.value })} className={inputCls} /></WField>
            <WField label="Country"><Input value={form.country} onChange={(e) => setForm({ ...form, country: e.target.value })} className={inputCls} /></WField>
          </div>
        </WCard>

        <WCard title="Logo & favicon" desc="PNG/JPG/WebP/SVG up to 400 KB. Stored in the media library and served as data URLs." onSave={save} busy={busy}>
          <ImagePicker
            label="Logo"
            value={form.logoUrl}
            hint="Square images work best. Blank removes the custom logo (gradient mark is used)."
            onPick={(v) => setForm({ ...form, logoUrl: v || "/logo.svg" })}
          />
          <ImagePicker
            label="Favicon"
            value={form.faviconUrl}
            accept="image/png,image/jpeg,image/webp,image/svg+xml,image/x-icon"
            hint="Shown in browser tabs. PNG/ICO 32×32 or SVG recommended."
            onPick={(v) => setForm({ ...form, faviconUrl: v || "/logo.svg" })}
          />
        </WCard>

        <WCard title="Header actions" desc="Sign-in and primary CTA labels in the site header." onSave={save} busy={busy}>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <WField label="Sign-in label"><Input value={form.navSignInLabel} onChange={(e) => setForm({ ...form, navSignInLabel: e.target.value })} className={inputCls} /></WField>
            <WField label="Sign-in link"><Input value={form.navSignInHref} onChange={(e) => setForm({ ...form, navSignInHref: e.target.value })} className={inputCls} /></WField>
            <WField label="CTA label"><Input value={form.navCtaLabel} onChange={(e) => setForm({ ...form, navCtaLabel: e.target.value })} className={inputCls} /></WField>
            <WField label="CTA link"><Input value={form.navCtaHref} onChange={(e) => setForm({ ...form, navCtaHref: e.target.value })} className={inputCls} /></WField>
          </div>
        </WCard>

        <WCard title="Support contact" desc="Used by the footer and contact page; also feeds platform emails." onSave={save} busy={busy}>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <WField label="Support email"><Input value={form.supportEmail} onChange={(e) => setForm({ ...form, supportEmail: e.target.value })} className={inputCls} /></WField>
            <WField label="Support phone"><Input value={form.supportPhone} onChange={(e) => setForm({ ...form, supportPhone: e.target.value })} className={inputCls} /></WField>
          </div>
          <WField label="Address"><Input value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} className={inputCls} /></WField>
        </WCard>
      </div>
    </div>
  )
}

const defaultIdentity: SiteIdentity = {
  siteName: "Finix HR", tagline: "", description: "", company: "", country: "",
  supportEmail: "", supportPhone: "", address: "", logoUrl: "/logo.svg", faviconUrl: "/logo.svg",
  navCtaLabel: "Get Started", navCtaHref: "/register", navSignInLabel: "Sign in", navSignInHref: "/login",
}

export { Megaphone }

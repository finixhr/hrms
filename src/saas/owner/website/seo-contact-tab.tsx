"use client"
// ============ Media Library + SEO + Contact tabs ============
import { useRef, useState } from "react"
import { Trash2, Upload } from "lucide-react"
import { useOwnerApi, ownerRpc } from "@/saas/owner/client"
import { ErrorBanner, Loading } from "@/saas/owner/ui"
import type { SiteContact, SiteSeo } from "@/saas/web/content-types"
import { ErrorNote, SuccessNote, WCard, WField, WTextArea, WToggle, inputCls } from "./ui"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"

// ============================== MEDIA ==============================
type MediaItem = { id: string; name: string; mimeType: string; size: number; createdAt: string; preview: string | null }

export function MediaTab() {
  const { data, loading, error, reload } = useOwnerApi<{ media: MediaItem[] }>("owner.cms.media.list", {})
  const fileRef = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  if (loading) return <Loading />
  if (error) return <ErrorBanner message={error} />

  const media = data?.media ?? []

  const upload = async (file: File) => {
    setBusy(true); setErr(null)
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(String(reader.result))
        reader.onerror = () => reject(new Error("Could not read the file"))
        reader.readAsDataURL(file)
      })
      await ownerRpc("owner.cms.media.upload", { name: file.name.replace(/\.[a-z0-9]+$/i, "").slice(0, 80) || "image", dataUrl })
      reload()
    } catch (e: any) { setErr(e?.message || "Upload failed") } finally { setBusy(false) }
  }

  const remove = async (m: MediaItem) => {
    if (!confirm(`Delete "${m.name}"? Logos still referencing it fall back to the default mark.`)) return
    try { await ownerRpc("owner.cms.media.delete", { id: m.id }); reload() } catch (e: any) { alert(e?.message) }
  }

  return (
    <div className="space-y-4">
      <ErrorNote msg={err} />
      <WCard title="Media library" desc="Logo, favicon and content images. PNG/JPG/WebP/SVG up to 400 KB each.">
        <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml,image/x-icon" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) upload(f); e.target.value = "" }} />
        <Button size="sm" className="bg-gradient-to-r from-blue-600 to-violet-600 text-white" disabled={busy} onClick={() => fileRef.current?.click()}>
          {busy ? "Uploading…" : <><Upload className="mr-1.5 h-3.5 w-3.5" /> Upload image</>}
        </Button>
        {media.length === 0 ? (
          <p className="text-xs text-slate-500">No media yet. Uploaded images appear here and can be picked from the Identity tab or referenced by <span className="font-mono">media:&lt;id&gt;</span>.</p>
        ) : (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 xl:grid-cols-6">
            {media.map((m) => (
              <div key={m.id} className="overflow-hidden rounded-xl border border-white/10 light:border-slate-200 bg-white/[0.02] light:bg-slate-50">
                <div className="flex h-24 items-center justify-center bg-slate-900/60 light:bg-white">
                  {m.preview ? (
                    <img src={m.preview} alt={m.name} className="h-full w-full object-contain p-2" />
                  ) : (
                    <span className="px-2 text-center text-[10px] text-slate-500">{m.mimeType}</span>
                  )}
                </div>
                <div className="p-2">
                  <p className="truncate text-[11px] font-semibold text-white light:text-slate-900">{m.name}</p>
                  <p className="text-[10px] text-slate-500">{Math.round(m.size / 1024)} KB · {new Date(m.createdAt).toLocaleDateString()}</p>
                  <p className="mt-1 truncate font-mono text-[9px] text-indigo-300 light:text-indigo-600" title={`media:${m.id}`}>media:{m.id}</p>
                  <Button size="sm" variant="outline" className="mt-1.5 h-6 w-full text-[10px] text-red-400 light:text-red-600" onClick={() => remove(m)}><Trash2 className="mr-1 h-3 w-3" /> Delete</Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </WCard>
    </div>
  )
}

// ============================== SEO + CONTACT ==============================
export function SeoContactTabs({ initial }: { initial: "seo" | "contact" }) {
  const [tab] = useState<"seo" | "contact">(initial)
  return <>{tab === "seo" ? <SeoTab /> : <ContactTab />}</>
}

function SeoTab() {
  const { data, loading, error } = useOwnerApi<{ settings: { seo?: SiteSeo } }>("owner.cms.settings.get", {})
  const [form, setForm] = useState<SiteSeo | null>(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)

  if (loading) return <Loading />
  if (error) return <ErrorBanner message={error} />

  const seo = form ?? { metaTitle: "", metaDescription: "", keywords: [], ogTitle: "", ogDescription: "", ...data?.settings?.seo }

  const save = async () => {
    setBusy(true); setMsg(null); setErr(null)
    try {
      await ownerRpc("owner.cms.seo.save", { seo })
      setMsg("SEO defaults saved — pages without explicit SEO inherit them."); setTimeout(() => setMsg(null), 5000)
    } catch (e: any) { setErr(e?.message || "Save failed") } finally { setBusy(false) }
  }

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <SuccessNote msg={msg} />
      <ErrorNote msg={err} />
      <WCard title="SEO defaults" desc="Site-wide metadata: used by the homepage and any page without its own SEO override." onSave={save} busy={busy}>
        <WField label="Meta title"><Input value={seo.metaTitle} onChange={(e) => setForm({ ...seo, metaTitle: e.target.value })} className={inputCls} maxLength={200} /></WField>
        <WTextArea label="Meta description" value={seo.metaDescription} onChange={(v) => setForm({ ...seo, metaDescription: v })} rows={3} maxLength={400} />
        <WField label="Keywords (comma-separated)"><Input value={seo.keywords.join(", ")} onChange={(e) => setForm({ ...seo, keywords: e.target.value.split(",").map((k) => k.trim()).filter(Boolean).slice(0, 30) })} className={inputCls} /></WField>
        <WField label="Open Graph title"><Input value={seo.ogTitle} onChange={(e) => setForm({ ...seo, ogTitle: e.target.value })} className={inputCls} maxLength={200} /></WField>
        <WTextArea label="Open Graph description" value={seo.ogDescription} onChange={(v) => setForm({ ...seo, ogDescription: v })} rows={2} maxLength={400} />
      </WCard>
    </div>
  )
}

function ContactTab() {
  const { data, loading, error } = useOwnerApi<{ settings: { contact?: SiteContact } }>("owner.cms.settings.get", {})
  const [form, setForm] = useState<SiteContact | null>(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)

  if (loading) return <Loading />
  if (error) return <ErrorBanner message={error} />

  const contact = form ?? { heading: "", sub: "", phone: "", email: "", address: "", hours: "", showForm: true, ...data?.settings?.contact }

  const save = async () => {
    setBusy(true); setMsg(null); setErr(null)
    try {
      await ownerRpc("owner.cms.contact.save", { contact })
      setMsg("Contact info saved — the contact page and footer use it."); setTimeout(() => setMsg(null), 5000)
    } catch (e: any) { setErr(e?.message || "Save failed") } finally { setBusy(false) }
  }

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <SuccessNote msg={msg} />
      <ErrorNote msg={err} />
      <WCard title="Contact information" desc="Shown on /contact and available to the footer." onSave={save} busy={busy}>
        <WField label="Heading"><Input value={contact.heading} onChange={(e) => setForm({ ...contact, heading: e.target.value })} className={inputCls} maxLength={200} /></WField>
        <WTextArea label="Subheading" value={contact.sub} onChange={(v) => setForm({ ...contact, sub: v })} rows={2} maxLength={1000} />
        <div className="grid gap-3 sm:grid-cols-2">
          <WField label="Phone"><Input value={contact.phone} onChange={(e) => setForm({ ...contact, phone: e.target.value })} className={inputCls} /></WField>
          <WField label="Email"><Input value={contact.email} onChange={(e) => setForm({ ...contact, email: e.target.value })} className={inputCls} /></WField>
        </div>
        <WField label="Address"><Input value={contact.address} onChange={(e) => setForm({ ...contact, address: e.target.value })} className={inputCls} maxLength={300} /></WField>
        <WField label="Business hours"><Input value={contact.hours} onChange={(e) => setForm({ ...contact, hours: e.target.value })} className={inputCls} placeholder="Sunday – Thursday, 9:00 – 18:00" maxLength={120} /></WField>
        <WToggle label="Show the inquiry form on the contact page" checked={contact.showForm} onChange={(v) => setForm({ ...contact, showForm: v })} />
      </WCard>
    </div>
  )
}

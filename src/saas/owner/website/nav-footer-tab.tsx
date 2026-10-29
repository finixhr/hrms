"use client"
// ============ Navigation + Footer editors ============
import { useEffect, useState } from "react"
import { GripVertical, Plus, Trash2 } from "lucide-react"
import { useOwnerApi, ownerRpc } from "@/saas/owner/client"
import { ErrorBanner, Loading } from "@/saas/owner/ui"
import type { FooterConfig, NavChild, NavItem, SiteNav } from "@/saas/web/content-types"
import { ErrorNote, SuccessNote, WCard, WField, WTextArea, inputCls } from "./ui"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"

export function NavFooterTabs({ initial }: { initial: "nav" | "footer" }) {
  const [tab] = useState<"nav" | "footer">(initial)
  return <>{tab === "nav" ? <NavEditor /> : <FooterEditor />}</>
}

// ============================== NAV ==============================
function NavEditor() {
  const { data, loading, error } = useOwnerApi<{ settings: { nav?: SiteNav } }>("owner.cms.settings.get", {})
  const [items, setItems] = useState<NavItem[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    if (data?.settings?.nav && Array.isArray(data.settings.nav)) setItems(JSON.parse(JSON.stringify(data.settings.nav)))
  }, [data])

  if (loading) return <Loading />
  if (error) return <ErrorBanner message={error} />
  if (!items) return null

  const save = async () => {
    setBusy(true); setMsg(null); setErr(null)
    try {
      await ownerRpc("owner.cms.nav.save", { nav: items })
      setMsg("Navigation saved — the header now shows it."); setTimeout(() => setMsg(null), 5000)
    } catch (e: any) { setErr(e?.message || "Save failed") } finally { setBusy(false) }
  }

  const setItem = (i: number, patch: Partial<NavItem>) => setItems(items.map((x, j) => (j === i ? { ...x, ...patch } : x)))
  const move = (i: number, dir: -1 | 1) => {
    const next = [...items]
    const j = i + dir
    if (j < 0 || j >= next.length) return
    ;[next[i], next[j]] = [next[j], next[i]]
    setItems(next)
  }

  return (
    <div className="space-y-4">
      <SuccessNote msg={msg} />
      <ErrorNote msg={err} />
      <WCard title="Top navigation" desc="Menu items in the site header. Items with children render a dropdown (e.g. Features)." onSave={save} busy={busy}>
        <div className="space-y-3">
          {items.map((item, i) => (
            <div key={i} className="rounded-xl border border-white/10 light:border-slate-200 bg-white/[0.02] light:bg-slate-50 p-3">
              <div className="flex flex-wrap items-end gap-2">
                <span className="mb-2.5 text-slate-500"><GripVertical className="h-4 w-4" /></span>
                <WField label="Label"><Input value={item.label} onChange={(e) => setItem(i, { label: e.target.value })} className={`${inputCls} w-36`} /></WField>
                <WField label="Link"><Input value={item.href} onChange={(e) => setItem(i, { href: e.target.value })} className={`${inputCls} w-44`} /></WField>
                <div className="mb-1 flex gap-1">
                  <Button size="sm" variant="outline" className="h-9 px-2 text-xs" onClick={() => move(i, -1)} disabled={i === 0}>↑</Button>
                  <Button size="sm" variant="outline" className="h-9 px-2 text-xs" onClick={() => move(i, 1)} disabled={i === items.length - 1}>↓</Button>
                  {item.children && (
                    <Button size="sm" variant="outline" className="h-9 px-2 text-xs" onClick={() => setItem(i, { children: undefined })}>Flatten</Button>
                  )}
                  {!item.children && (
                    <Button size="sm" variant="outline" className="h-9 px-2 text-xs" onClick={() => setItem(i, { children: [] })}>+ Dropdown</Button>
                  )}
                  <Button size="sm" variant="outline" className="h-9 px-2 text-xs text-red-400 light:text-red-600" onClick={() => setItems(items.filter((_, j) => j !== i))}><Trash2 className="h-3.5 w-3.5" /></Button>
                </div>
              </div>
              {item.children && (
                <div className="mt-3 space-y-2 rounded-lg border border-white/10 light:border-slate-200 bg-white/[0.02] p-2.5 light:bg-white">
                  <p className="text-[10px] font-bold uppercase tracking-widest text-slate-500">Dropdown items</p>
                  {item.children.map((c, j) => {
                    const setChild = (patch: (x: NavChild) => NavChild) =>
                      setItem(i, { children: (item.children ?? []).map((x, k) => (k === j ? patch(x) : x)) })
                    return (
                      <div key={j} className="flex flex-wrap items-end gap-2">
                        <Input value={c.label} onChange={(e) => setChild((x) => ({ ...x, label: e.target.value }))} className={`${inputCls} w-40`} placeholder="Label" />
                        <Input value={c.href} onChange={(e) => setChild((x) => ({ ...x, href: e.target.value }))} className={`${inputCls} w-48`} placeholder="/features/…" />
                        <Input value={c.desc || ""} onChange={(e) => setChild((x) => ({ ...x, desc: e.target.value }))} className={`${inputCls} flex-1 min-w-40`} placeholder="Short description" />
                        <Button size="sm" variant="outline" className="mb-0.5 h-9 px-2 text-xs text-red-400 light:text-red-600" onClick={() => setItem(i, { children: (item.children ?? []).filter((_, k) => k !== j) })}><Trash2 className="h-3.5 w-3.5" /></Button>
                      </div>
                    )
                  })}
                  <Button size="sm" variant="outline" className="text-xs" onClick={() => setItem(i, { children: [...(item.children ?? []), { label: "New item", href: "/" }] })}><Plus className="mr-1 h-3 w-3" /> Add item</Button>
                </div>
              )}
            </div>
          ))}
          <Button size="sm" variant="outline" className="text-xs" onClick={() => setItems([...items, { label: "New page", href: "/p/…" }])}><Plus className="mr-1 h-3 w-3" /> Add top-level item</Button>
        </div>
      </WCard>
    </div>
  )
}

// ============================== FOOTER ==============================
function FooterEditor() {
  const { data, loading, error } = useOwnerApi<{ settings: { footer?: FooterConfig } }>("owner.cms.settings.get", {})
  const [form, setForm] = useState<FooterConfig | null>(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    if (data?.settings?.footer) setForm(JSON.parse(JSON.stringify(data.settings.footer)))
  }, [data])

  if (loading) return <Loading />
  if (error) return <ErrorBanner message={error} />
  if (!form) return null

  const save = async () => {
    setBusy(true); setMsg(null); setErr(null)
    try {
      await ownerRpc("owner.cms.footer.save", { footer: form })
      setMsg("Footer saved — it renders on every public page."); setTimeout(() => setMsg(null), 5000)
    } catch (e: any) { setErr(e?.message || "Save failed") } finally { setBusy(false) }
  }

  return (
    <div className="space-y-4">
      <SuccessNote msg={msg} />
      <ErrorNote msg={err} />
      <WCard title="Footer groups & links" desc="Column groups of links shown in the site footer." onSave={save} busy={busy}>
        <div className="grid gap-3 md:grid-cols-2">
          {form.groups.map((g, i) => {
            const setGroup = (patch: Partial<typeof g>) => setForm({ ...form, groups: form.groups.map((x, j) => (j === i ? { ...x, ...patch } : x)) })
            return (
              <div key={i} className="rounded-xl border border-white/10 light:border-slate-200 bg-white/[0.02] light:bg-slate-50 p-3">
                <div className="flex items-end gap-2">
                  <WField label="Group title"><Input value={g.title} onChange={(e) => setGroup({ title: e.target.value })} className={inputCls} /></WField>
                  <Button size="sm" variant="outline" className="mb-1 h-9 px-2 text-xs text-red-400 light:text-red-600" onClick={() => setForm({ ...form, groups: form.groups.filter((_, j) => j !== i) })}><Trash2 className="h-3.5 w-3.5" /></Button>
                </div>
                <div className="mt-2 space-y-1.5">
                  {g.links.map((l, j) => (
                    <div key={j} className="flex items-end gap-1.5">
                      <Input value={l.label} onChange={(e) => setGroup({ links: g.links.map((x, k) => (k === j ? { ...x, label: e.target.value } : x)) })} className={`${inputCls} w-36`} placeholder="Label" />
                      <Input value={l.href} onChange={(e) => setGroup({ links: g.links.map((x, k) => (k === j ? { ...x, href: e.target.value } : x)) })} className={`${inputCls} flex-1`} placeholder="/link" />
                      <Button size="sm" variant="outline" className="mb-0.5 h-9 px-2 text-xs text-red-400 light:text-red-600" onClick={() => setGroup({ links: g.links.filter((_, k) => k !== j) })}><Trash2 className="h-3.5 w-3.5" /></Button>
                    </div>
                  ))}
                  <Button size="sm" variant="outline" className="h-8 text-[11px]" onClick={() => setGroup({ links: [...g.links, { label: "New link", href: "/" }] })}><Plus className="mr-1 h-3 w-3" /> Add link</Button>
                </div>
              </div>
            )
          })}
        </div>
        <Button size="sm" variant="outline" className="text-xs" onClick={() => setForm({ ...form, groups: [...form.groups, { title: "New group", links: [] }] })}><Plus className="mr-1 h-3 w-3" /> Add group</Button>
        <WTextArea label="Footer note" value={form.note} onChange={(v) => setForm({ ...form, note: v })} rows={2} maxLength={1000} />
      </WCard>
    </div>
  )
}

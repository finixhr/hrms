"use client"
// ============ Features tab — manage the feature catalog ============
import { useState } from "react"
import { ArrowDown, ArrowUp, Eye, EyeOff, Pencil, Plus, Save, Trash2, X } from "lucide-react"
import { useOwnerApi, ownerRpc } from "@/saas/owner/client"
import { ErrorBanner, Loading } from "@/saas/owner/ui"
import type { FeatureRecord, FeatureContent } from "@/saas/web/content-types"
import { ErrorNote, SuccessNote, WCard, WField, WTextArea, WToggle, inputCls } from "./ui"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"

const emptyContent: FeatureContent = {
  problem: [], solution: [], capabilities: [], workflow: [], security: [], cta: { primary: "Register your organization", secondary: "View pricing" },
}

export function FeaturesTab() {
  const { data, loading, error, reload } = useOwnerApi<{ features: FeatureRecord[]; visualKeys: string[] }>("owner.cms.features.list", {})
  const [editing, setEditing] = useState<FeatureRecord | null>(null)
  const [creating, setCreating] = useState(false)

  if (loading) return <Loading />
  if (error) return <ErrorBanner message={error} />

  if (creating || editing) {
    return <FeatureEditor feature={editing} visualKeys={data?.visualKeys ?? []} onClose={() => { setEditing(null); setCreating(false); reload() }} />
  }

  const features = data?.features ?? []

  const toggle = async (f: FeatureRecord) => {
    try { await ownerRpc("owner.cms.features.save", { ...f, content: f.content }); reload() } catch (e: any) { alert(e?.message) }
  }
  const remove = async (f: FeatureRecord) => {
    if (!confirm(`Delete feature "${f.title}"? Its page disappears from the site.`)) return
    try { await ownerRpc("owner.cms.features.delete", { id: f.id }); reload() } catch (e: any) { alert(e?.message) }
  }
  const move = async (index: number, dir: -1 | 1) => {
    const j = index + dir
    if (j < 0 || j >= features.length) return
    const next = [...features]
    ;[next[index], next[j]] = [next[j], next[index]]
    try { await ownerRpc("owner.cms.features.reorder", { order: next.map((f, i) => ({ id: f.id, sortOrder: i })) }); reload() } catch (e: any) { alert(e?.message) }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-bold text-white light:text-slate-900">Feature catalog ({features.length})</p>
        <Button size="sm" className="bg-gradient-to-r from-blue-600 to-violet-600 text-white" onClick={() => setCreating(true)}><Plus className="mr-1 h-3.5 w-3.5" /> New feature</Button>
      </div>
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {features.map((f, i) => (
          <div key={f.id} className="rounded-2xl border border-white/10 light:border-slate-200 bg-white/[0.03] light:bg-white p-4 light:shadow-sm">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="truncate text-[13px] font-bold text-white light:text-slate-900">{f.title}</p>
                <p className="truncate font-mono text-[10px] text-slate-500">/features/{f.slug}</p>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <button type="button" title={f.visible ? "Hide" : "Show"} onClick={() => toggle({ ...f, visible: !f.visible })} className="rounded-md p-1.5 text-slate-500 hover:bg-white/5 light:hover:bg-slate-100">
                  {f.visible ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
                </button>
              </div>
            </div>
            <p className="mt-2 line-clamp-2 text-[11px] leading-relaxed text-slate-500">{f.sub}</p>
            <div className="mt-3 flex flex-wrap items-center gap-1.5 text-[10px]">
              {f.visual ? (
                <span className="rounded-full bg-indigo-500/10 px-2 py-0.5 font-bold uppercase text-indigo-300 ring-1 ring-indigo-400/30 light:bg-indigo-50 light:text-indigo-700 light:ring-indigo-200">visual: {f.visual}</span>
              ) : (
                <span className="rounded-full bg-slate-500/10 px-2 py-0.5 font-bold uppercase text-slate-400 ring-1 ring-slate-400/20">no visual</span>
              )}
              {f.showOnHome && <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 font-bold uppercase text-emerald-300 ring-1 ring-emerald-400/30 light:text-emerald-700">on home</span>}
            </div>
            <div className="mt-3 flex items-center gap-1">
              <Button size="sm" variant="outline" className="h-7 px-1.5 text-[11px]" onClick={() => move(i, -1)} disabled={i === 0}><ArrowUp className="h-3 w-3" /></Button>
              <Button size="sm" variant="outline" className="h-7 px-1.5 text-[11px]" onClick={() => move(i, 1)} disabled={i === features.length - 1}><ArrowDown className="h-3 w-3" /></Button>
              <Button size="sm" variant="outline" className="ml-auto h-7 px-2.5 text-[11px]" onClick={() => setEditing(f)}><Pencil className="mr-1 h-3 w-3" /> Edit</Button>
              <Button size="sm" variant="outline" className="h-7 px-1.5 text-[11px] text-red-400 light:text-red-600" onClick={() => remove(f)}><Trash2 className="h-3 w-3" /></Button>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function FeatureEditor({ feature, visualKeys, onClose }: { feature: FeatureRecord | null; visualKeys: string[]; onClose: () => void }) {
  const [form, setForm] = useState<FeatureRecord>(() =>
    feature ?? {
      id: "", slug: "", title: "", navLabel: "", headline: "", sub: "", visual: null,
      icon: "star", accent: "blue", sortOrder: 99, visible: true, showOnHome: true,
      content: { ...emptyContent }, updatedAt: new Date().toISOString(),
    }
  )
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)

  const save = async () => {
    setBusy(true); setMsg(null); setErr(null)
    try {
      await ownerRpc("owner.cms.features.save", {
        ...(form.id ? { id: form.id } : {}),
        slug: form.slug, title: form.title, navLabel: form.navLabel, headline: form.headline, sub: form.sub,
        visual: form.visual, icon: form.icon, accent: form.accent, sortOrder: form.sortOrder,
        visible: form.visible, showOnHome: form.showOnHome, content: form.content,
      })
      setMsg("Feature saved — /features/" + form.slug + " is updated.")
    } catch (e: any) { setErr(e?.message || "Save failed") } finally { setBusy(false) }
  }

  const setContent = (patch: Partial<FeatureContent>) => setForm({ ...form, content: { ...form.content, ...patch } })

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" className="text-xs" onClick={onClose}><X className="mr-1 h-3.5 w-3.5" /> Back</Button>
          <p className="text-sm font-bold text-white light:text-slate-900">{feature ? `Edit: ${form.title}` : "New feature"}</p>
        </div>
        <Button size="sm" className="bg-gradient-to-r from-blue-600 to-violet-600 text-white" onClick={save} disabled={busy}><Save className="mr-1 h-3.5 w-3.5" /> Save feature</Button>
      </div>
      <SuccessNote msg={msg} />
      <ErrorNote msg={err} />

      <div className="grid gap-4 xl:grid-cols-2">
        <WCard title="Feature basics" desc="Title, page copy and where it appears.">
          <WField label="Title"><Input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value, navLabel: form.navLabel || e.target.value })} className={inputCls} /></WField>
          <WField label="Slug" hint="Page route: /features/<slug>"><Input value={form.slug} disabled={!!feature?.id} onChange={(e) => setForm({ ...form, slug: e.target.value.toLowerCase().replace(/[^a-z0-9-]+/g, "-") })} className={inputCls} /></WField>
          <WField label="Headline"><Input value={form.headline} onChange={(e) => setForm({ ...form, headline: e.target.value })} className={inputCls} /></WField>
          <WTextArea label="Subtitle" value={form.sub} onChange={(v) => setForm({ ...form, sub: v })} rows={2} />
          <WField label="Product visual" hint="The coded simulation shown on the feature page.">
            <Select value={form.visual || "none"} onValueChange={(v) => setForm({ ...form, visual: v === "none" ? null : v })}>
              <SelectTrigger className={inputCls}><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="none">No visual (text page)</SelectItem>
                {visualKeys.map((k) => <SelectItem key={k} value={k}>{k}</SelectItem>)}
              </SelectContent>
            </Select>
          </WField>
          <div className="grid grid-cols-2 gap-3">
            <WField label="Accent color">
              <Select value={form.accent} onValueChange={(v) => setForm({ ...form, accent: v })}>
                <SelectTrigger className={inputCls}><SelectValue /></SelectTrigger>
                <SelectContent>
                  {["blue", "indigo", "violet", "cyan", "emerald", "amber", "rose", "orange"].map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}
                </SelectContent>
              </Select>
            </WField>
            <WField label="Sort order"><Input type="number" value={form.sortOrder} onChange={(e) => setForm({ ...form, sortOrder: Number(e.target.value) || 0 })} className={inputCls} /></WField>
          </div>
          <WToggle label="Visible on the site" checked={form.visible} onChange={(v) => setForm({ ...form, visible: v })} />
          <WToggle label="Show on homepage feature grid" checked={form.showOnHome} onChange={(v) => setForm({ ...form, showOnHome: v })} />
        </WCard>

        <WCard title="Page content" desc="Problem/solution bullets, capabilities, workflow and security copy.">
          <StringListEditor label="The problem (bullets)" items={form.content.problem} onChange={(v) => setContent({ problem: v })} />
          <StringListEditor label="How the platform solves it (bullets)" items={form.content.solution} onChange={(v) => setContent({ solution: v })} />
          <WField label="CTA primary label"><Input value={form.content.cta?.primary || ""} onChange={(e) => setContent({ cta: { ...form.content.cta, primary: e.target.value } })} className={inputCls} /></WField>
          <WField label="CTA secondary label"><Input value={form.content.cta?.secondary || ""} onChange={(e) => setContent({ cta: { ...form.content.cta, secondary: e.target.value } })} className={inputCls} /></WField>
        </WCard>

        <WCard title="Capabilities ('What's in the box')" desc="Cards with bullet lists.">
          <div className="space-y-2">
            {form.content.capabilities.map((c, i) => (
              <div key={i} className="space-y-1.5 rounded-lg border border-white/10 light:border-slate-200 p-2">
                <div className="flex gap-1.5">
                  <Input value={c.title} onChange={(e) => setContent({ capabilities: form.content.capabilities.map((x, j) => (j === i ? { ...x, title: e.target.value } : x)) })} className={inputCls} placeholder="Card title" />
                  <Button size="sm" variant="outline" className="h-10 px-2 text-xs text-red-400 light:text-red-600" onClick={() => setContent({ capabilities: form.content.capabilities.filter((_, j) => j !== i) })}><Trash2 className="h-3.5 w-3.5" /></Button>
                </div>
                <StringListEditor label="" items={c.items} onChange={(v) => setContent({ capabilities: form.content.capabilities.map((x, j) => (j === i ? { ...x, items: v } : x)) })} />
              </div>
            ))}
            <Button size="sm" variant="outline" className="h-8 text-[11px]" onClick={() => setContent({ capabilities: [...form.content.capabilities, { title: "", items: [] }] })}><Plus className="mr-1 h-3 w-3" /> Add card</Button>
          </div>
        </WCard>

        <WCard title="Workflow & security">
          <div className="space-y-2">
            {form.content.workflow.map((s, i) => (
              <div key={i} className="space-y-1.5 rounded-lg border border-white/10 light:border-slate-200 p-2">
                <div className="flex gap-1.5">
                  <Input value={s.title} onChange={(e) => setContent({ workflow: form.content.workflow.map((x, j) => (j === i ? { ...x, title: e.target.value } : x)) })} className={inputCls} placeholder="Step title" />
                  <Button size="sm" variant="outline" className="h-10 px-2 text-xs text-red-400 light:text-red-600" onClick={() => setContent({ workflow: form.content.workflow.filter((_, j) => j !== i) })}><Trash2 className="h-3.5 w-3.5" /></Button>
                </div>
                <Input value={s.body} onChange={(e) => setContent({ workflow: form.content.workflow.map((x, j) => (j === i ? { ...x, body: e.target.value } : x)) })} className={inputCls} placeholder="Step description" />
              </div>
            ))}
            <Button size="sm" variant="outline" className="h-8 text-[11px]" onClick={() => setContent({ workflow: [...form.content.workflow, { title: "", body: "" }] })}><Plus className="mr-1 h-3 w-3" /> Add step</Button>
          </div>
          <StringListEditor label="Security & controls bullets" items={form.content.security} onChange={(v) => setContent({ security: v })} />
        </WCard>
      </div>
    </div>
  )
}

function StringListEditor({ label, items, onChange }: { label: string; items: string[]; onChange: (v: string[]) => void }) {
  return (
    <WField label={label}>
      <div className="space-y-1.5">
        {(items ?? []).map((it, i) => (
          <div key={i} className="flex gap-1.5">
            <Input value={it} onChange={(e) => onChange(items.map((x, j) => (j === i ? e.target.value : x)))} className={inputCls} />
            <Button size="sm" variant="outline" className="h-10 px-2 text-xs text-red-400 light:text-red-600" onClick={() => onChange(items.filter((_, j) => j !== i))}><Trash2 className="h-3.5 w-3.5" /></Button>
          </div>
        ))}
        <Button size="sm" variant="outline" className="h-8 text-[11px]" onClick={() => onChange([...(items ?? []), ""])}><Plus className="mr-1 h-3 w-3" /> Add</Button>
      </div>
    </WField>
  )
}

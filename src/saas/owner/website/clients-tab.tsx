"use client"
// ============ Clients & Stories tab ============
import { useState } from "react"
import { ArrowDown, ArrowUp, Eye, EyeOff, Pencil, Plus, Save, Star, Trash2, X } from "lucide-react"
import { useOwnerApi, ownerRpc } from "@/saas/owner/client"
import { ErrorBanner, Loading } from "@/saas/owner/ui"
import type { ClientRecord } from "@/saas/web/content-types"
import { ErrorNote, SuccessNote, WCard, WField, WTextArea, WToggle, inputCls } from "./ui"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"

export function ClientsTab() {
  const { data, loading, error, reload } = useOwnerApi<{ clients: ClientRecord[] }>("owner.cms.clients.list", {})
  const [editing, setEditing] = useState<ClientRecord | null>(null)
  const [creating, setCreating] = useState(false)

  if (loading) return <Loading />
  if (error) return <ErrorBanner message={error} />

  if (creating || editing) {
    return <ClientEditor client={editing} onClose={() => { setEditing(null); setCreating(false); reload() }} />
  }

  const clients = data?.clients ?? []

  const toggle = async (c: ClientRecord) => {
    try { await ownerRpc("owner.cms.clients.save", { ...c }); reload() } catch (e: any) { alert(e?.message) }
  }
  const remove = async (c: ClientRecord) => {
    if (!confirm(`Delete client "${c.name}"?`)) return
    try { await ownerRpc("owner.cms.clients.delete", { id: c.id }); reload() } catch (e: any) { alert(e?.message) }
  }
  const move = async (index: number, dir: -1 | 1) => {
    const j = index + dir
    if (j < 0 || j >= clients.length) return
    const next = [...clients]
    ;[next[index], next[j]] = [next[j], next[index]]
    try { await ownerRpc("owner.cms.clients.reorder", { order: next.map((c, i) => ({ id: c.id, sortOrder: i })) }); reload() } catch (e: any) { alert(e?.message) }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-bold text-white light:text-slate-900">Valued clients ({clients.length})</p>
        <Button size="sm" className="bg-gradient-to-r from-blue-600 to-violet-600 text-white" onClick={() => setCreating(true)}><Plus className="mr-1 h-3.5 w-3.5" /> Add client</Button>
      </div>
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {clients.map((c, i) => (
          <div key={c.id} className="rounded-2xl border border-white/10 light:border-slate-200 bg-white/[0.03] light:bg-white p-4 light:shadow-sm">
            <div className="flex items-start gap-3">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-xs font-bold text-white" style={{ background: `linear-gradient(135deg, ${c.logoColor}, ${c.logoColor}cc)` }}>
                {(c.logoText || c.name.slice(0, 2)).toUpperCase()}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <p className="truncate text-[13px] font-bold text-white light:text-slate-900">{c.name}</p>
                  {c.featured && <Star className="h-3.5 w-3.5 shrink-0 fill-amber-400 text-amber-400" />}
                </div>
                <p className="truncate text-[10px] text-slate-500">{c.industry}</p>
              </div>
              <button type="button" title={c.visible ? "Hide" : "Show"} onClick={() => toggle({ ...c, visible: !c.visible })} className="rounded-md p-1.5 text-slate-500 hover:bg-white/5 light:hover:bg-slate-100">
                {c.visible ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
              </button>
            </div>
            <p className="mt-2 line-clamp-2 text-[11px] leading-relaxed text-slate-500">{c.description}</p>
            {c.metrics.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {c.metrics.slice(0, 3).map((m, j) => (
                  <span key={j} className="rounded-full bg-slate-500/10 px-2 py-0.5 text-[10px] font-semibold text-slate-400 light:text-slate-600">{m.value} · {m.label}</span>
                ))}
              </div>
            )}
            <div className="mt-3 flex items-center gap-1">
              <Button size="sm" variant="outline" className="h-7 px-1.5 text-[11px]" onClick={() => move(i, -1)} disabled={i === 0}><ArrowUp className="h-3 w-3" /></Button>
              <Button size="sm" variant="outline" className="h-7 px-1.5 text-[11px]" onClick={() => move(i, 1)} disabled={i === clients.length - 1}><ArrowDown className="h-3 w-3" /></Button>
              <Button size="sm" variant="outline" className="ml-auto h-7 px-2.5 text-[11px]" onClick={() => setEditing(c)}><Pencil className="mr-1 h-3 w-3" /> Edit</Button>
              <Button size="sm" variant="outline" className="h-7 px-1.5 text-[11px] text-red-400 light:text-red-600" onClick={() => remove(c)}><Trash2 className="h-3 w-3" /></Button>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function ClientEditor({ client, onClose }: { client: ClientRecord | null; onClose: () => void }) {
  const [form, setForm] = useState<ClientRecord>(() =>
    client ?? {
      id: "", name: "", industry: "", description: "", story: null, quote: null, personName: null, personRole: null,
      metrics: [], logoText: null, logoColor: "#2563eb", logoUrl: null, website: null, featured: false,
      visible: true, sortOrder: 99, updatedAt: new Date().toISOString(),
    }
  )
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)

  const save = async () => {
    setBusy(true); setMsg(null); setErr(null)
    try {
      await ownerRpc("owner.cms.clients.save", {
        ...(form.id ? { id: form.id } : {}), name: form.name, industry: form.industry, description: form.description,
        story: form.story, quote: form.quote, personName: form.personName, personRole: form.personRole,
        metrics: form.metrics, logoText: form.logoText, logoColor: form.logoColor, website: form.website,
        featured: form.featured, visible: form.visible, sortOrder: form.sortOrder,
      })
      setMsg("Client saved — the Valued Clients section is updated.")
    } catch (e: any) { setErr(e?.message || "Save failed") } finally { setBusy(false) }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" className="text-xs" onClick={onClose}><X className="mr-1 h-3.5 w-3.5" /> Back</Button>
          <p className="text-sm font-bold text-white light:text-slate-900">{client ? `Edit: ${form.name}` : "New client"}</p>
        </div>
        <Button size="sm" className="bg-gradient-to-r from-blue-600 to-violet-600 text-white" onClick={save} disabled={busy}><Save className="mr-1 h-3.5 w-3.5" /> Save client</Button>
      </div>
      <SuccessNote msg={msg} />
      <ErrorNote msg={err} />

      <div className="grid gap-4 xl:grid-cols-2">
        <WCard title="Client profile" desc="Shown on the homepage clients section and /clients.">
          <div className="grid grid-cols-[auto_1fr] items-end gap-3">
            <WField label="Logo initials"><Input value={form.logoText || ""} onChange={(e) => setForm({ ...form, logoText: e.target.value.slice(0, 4) })} className={`${inputCls} w-20 text-center`} placeholder="BT" /></WField>
            <WField label="Logo color"><input type="color" value={form.logoColor} onChange={(e) => setForm({ ...form, logoColor: e.target.value })} className="h-10 w-full cursor-pointer rounded-lg border border-white/10 bg-transparent" /></WField>
          </div>
          <WField label="Client name"><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className={inputCls} /></WField>
          <WField label="Industry"><Input value={form.industry} onChange={(e) => setForm({ ...form, industry: e.target.value })} className={inputCls} placeholder="Textile & Garments Manufacturing" /></WField>
          <WTextArea label="Short description" value={form.description} onChange={(v) => setForm({ ...form, description: v })} rows={2} maxLength={1000} />
          <WField label="Website (optional)"><Input value={form.website || ""} onChange={(e) => setForm({ ...form, website: e.target.value })} className={inputCls} placeholder="https://…" /></WField>
          <WToggle label="Featured (shown in highlights)" checked={form.featured} onChange={(v) => setForm({ ...form, featured: v })} />
          <WToggle label="Visible" checked={form.visible} onChange={(v) => setForm({ ...form, visible: v })} />
        </WCard>

        <WCard title="Story, testimonial & metrics" desc="The success story shown on /clients#stories.">
          <WTextArea label="Client success story" value={form.story || ""} onChange={(v) => setForm({ ...form, story: v || null })} rows={7} maxLength={20000} />
          <WTextArea label="Testimonial quote (short)" value={form.quote || ""} onChange={(v) => setForm({ ...form, quote: v || null })} rows={3} maxLength={2000} />
          <div className="grid grid-cols-2 gap-3">
            <WField label="Quote person name"><Input value={form.personName || ""} onChange={(e) => setForm({ ...form, personName: e.target.value })} className={inputCls} /></WField>
            <WField label="Quote person role"><Input value={form.personRole || ""} onChange={(e) => setForm({ ...form, personRole: e.target.value })} className={inputCls} /></WField>
          </div>
          <WField label="Result metrics">
            <div className="space-y-1.5">
              {form.metrics.map((m, i) => (
                <div key={i} className="flex gap-1.5">
                  <Input value={m.value} onChange={(e) => setForm({ ...form, metrics: form.metrics.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)) })} className={`${inputCls} w-28`} placeholder="−80%" />
                  <Input value={m.label} onChange={(e) => setForm({ ...form, metrics: form.metrics.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)) })} className={inputCls} placeholder="label" />
                  <Button size="sm" variant="outline" className="h-10 px-2 text-xs text-red-400 light:text-red-600" onClick={() => setForm({ ...form, metrics: form.metrics.filter((_, j) => j !== i) })}><Trash2 className="h-3.5 w-3.5" /></Button>
                </div>
              ))}
              <Button size="sm" variant="outline" className="h-8 text-[11px]" onClick={() => setForm({ ...form, metrics: [...form.metrics, { value: "", label: "" }] })}><Plus className="mr-1 h-3 w-3" /> Add metric</Button>
            </div>
          </WField>
        </WCard>
      </div>
    </div>
  )
}

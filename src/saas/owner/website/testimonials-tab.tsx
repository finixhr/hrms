"use client"
// ============ Testimonials tab ============
import { useState } from "react"
import { ArrowDown, ArrowUp, Pencil, Plus, Save, Star, Trash2, X } from "lucide-react"
import { useOwnerApi, ownerRpc } from "@/saas/owner/client"
import { ErrorBanner, Loading } from "@/saas/owner/ui"
import type { TestimonialRecord } from "@/saas/web/content-types"
import { ErrorNote, SuccessNote, WCard, WField, WTextArea, WToggle, inputCls } from "./ui"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

export function TestimonialsTab() {
  const { data, loading, error, reload } = useOwnerApi<{ testimonials: TestimonialRecord[] }>("owner.cms.testimonials.list", {})
  const [editing, setEditing] = useState<TestimonialRecord | null>(null)
  const [creating, setCreating] = useState(false)

  if (loading) return <Loading />
  if (error) return <ErrorBanner message={error} />

  if (creating || editing) {
    return <TestimonialEditor testimonial={editing} onClose={() => { setEditing(null); setCreating(false); reload() }} />
  }

  const items = data?.testimonials ?? []

  const remove = async (t: TestimonialRecord) => {
    if (!confirm(`Delete the testimonial from "${t.clientName}"?`)) return
    try { await ownerRpc("owner.cms.testimonials.delete", { id: t.id }); reload() } catch (e: any) { alert(e?.message) }
  }
  const move = async (index: number, dir: -1 | 1) => {
    const j = index + dir
    if (j < 0 || j >= items.length) return
    const next = [...items]
    ;[next[index], next[j]] = [next[j], next[index]]
    try { await ownerRpc("owner.cms.testimonials.reorder", { order: next.map((t, i) => ({ id: t.id, sortOrder: i })) }); reload() } catch (e: any) { alert(e?.message) }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-bold text-white light:text-slate-900">Testimonials ({items.length})</p>
        <Button size="sm" className="bg-gradient-to-r from-blue-600 to-violet-600 text-white" onClick={() => setCreating(true)}><Plus className="mr-1 h-3.5 w-3.5" /> Add testimonial</Button>
      </div>
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {items.map((t, i) => (
          <div key={t.id} className={cn("rounded-2xl border p-4", t.visible ? "border-white/10 light:border-slate-200 bg-white/[0.03] light:bg-white" : "border-white/5 light:border-slate-200 opacity-60")}>
            <div className="flex gap-0.5">
              {Array.from({ length: Math.max(1, Math.min(5, t.rating)) }).map((_, j) => <Star key={j} className="h-3.5 w-3.5 fill-amber-400 text-amber-400" />)}
            </div>
            <p className="mt-2 line-clamp-4 text-[12px] italic leading-relaxed text-slate-400 light:text-slate-600">“{t.quote}”</p>
            <p className="mt-3 text-[11px] font-semibold text-white light:text-slate-900">{t.personName}</p>
            <p className="text-[10px] text-slate-500">{t.personRole} · {t.clientName}</p>
            <div className="mt-3 flex items-center gap-1">
              <Button size="sm" variant="outline" className="h-7 px-1.5 text-[11px]" onClick={() => move(i, -1)} disabled={i === 0}><ArrowUp className="h-3 w-3" /></Button>
              <Button size="sm" variant="outline" className="h-7 px-1.5 text-[11px]" onClick={() => move(i, 1)} disabled={i === items.length - 1}><ArrowDown className="h-3 w-3" /></Button>
              <Button size="sm" variant="outline" className="ml-auto h-7 px-2.5 text-[11px]" onClick={() => setEditing(t)}><Pencil className="mr-1 h-3 w-3" /> Edit</Button>
              <Button size="sm" variant="outline" className="h-7 px-1.5 text-[11px] text-red-400 light:text-red-600" onClick={() => remove(t)}><Trash2 className="h-3 w-3" /></Button>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function TestimonialEditor({ testimonial, onClose }: { testimonial: TestimonialRecord | null; onClose: () => void }) {
  const [form, setForm] = useState<TestimonialRecord>(() =>
    testimonial ?? {
      id: "", clientName: "", personName: "", personRole: "", quote: "", rating: 5,
      visible: true, sortOrder: 99, updatedAt: new Date().toISOString(),
    }
  )
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)

  const save = async () => {
    setBusy(true); setMsg(null); setErr(null)
    try {
      await ownerRpc("owner.cms.testimonials.save", {
        ...(form.id ? { id: form.id } : {}), clientName: form.clientName, personName: form.personName,
        personRole: form.personRole, quote: form.quote, rating: form.rating, visible: form.visible, sortOrder: form.sortOrder,
      })
      setMsg("Testimonial saved.")
    } catch (e: any) { setErr(e?.message || "Save failed") } finally { setBusy(false) }
  }

  return (
    <div className="mx-auto max-w-xl space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" className="text-xs" onClick={onClose}><X className="mr-1 h-3.5 w-3.5" /> Back</Button>
          <p className="text-sm font-bold text-white light:text-slate-900">{testimonial ? "Edit testimonial" : "New testimonial"}</p>
        </div>
        <Button size="sm" className="bg-gradient-to-r from-blue-600 to-violet-600 text-white" onClick={save} disabled={busy}><Save className="mr-1 h-3.5 w-3.5" /> Save</Button>
      </div>
      <SuccessNote msg={msg} />
      <ErrorNote msg={err} />
      <WCard title="Testimonial">
        <WField label="Client / company name"><Input value={form.clientName} onChange={(e) => setForm({ ...form, clientName: e.target.value })} className={inputCls} /></WField>
        <div className="grid grid-cols-2 gap-3">
          <WField label="Person name"><Input value={form.personName} onChange={(e) => setForm({ ...form, personName: e.target.value })} className={inputCls} /></WField>
          <WField label="Person role"><Input value={form.personRole} onChange={(e) => setForm({ ...form, personRole: e.target.value })} className={inputCls} /></WField>
        </div>
        <WTextArea label="Quote" value={form.quote} onChange={(v) => setForm({ ...form, quote: v })} rows={4} maxLength={3000} />
        <WField label="Rating">
          <div className="flex gap-1.5">
            {[1, 2, 3, 4, 5].map((r) => (
              <button key={r} type="button" onClick={() => setForm({ ...form, rating: r })} className="rounded-lg border border-white/10 p-1.5">
                <Star className={cn("h-4 w-4", r <= form.rating ? "fill-amber-400 text-amber-400" : "text-slate-600")} />
              </button>
            ))}
          </div>
        </WField>
        <WToggle label="Visible" checked={form.visible} onChange={(v) => setForm({ ...form, visible: v })} />
      </WCard>
    </div>
  )
}

"use client"
// ============ Pages & Page Builder ============
// Page list (status/visibility/order) + full block editor: add, reorder,
// hide, delete and edit sections. Block editors cover every shipped block
// type; unknown/future blocks fall back to a raw JSON editor.
import { useState } from "react"
import {
  ArrowDown, ArrowUp, Copy, Eye, EyeOff, FileText, Pencil, Plus, Save, Trash2, X, Loader2,
} from "lucide-react"
import { useOwnerApi, ownerRpc } from "@/saas/owner/client"
import { ErrorBanner, Loading } from "@/saas/owner/ui"
import type { CmsBlock, CmsBlockType, CmsPageRecord } from "@/saas/web/content-types"
import { ErrorNote, SuccessNote, WCard, WField, WTextArea, WToggle, inputCls } from "./ui"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

const BLOCK_TYPES: { type: CmsBlockType; label: string; desc: string }[] = [
  { type: "hero", label: "Hero", desc: "Headline, sub, CTAs, stats + dashboard mock" },
  { type: "value-props", label: "Value props", desc: "Icon + title + body grid" },
  { type: "features", label: "Feature showcase", desc: "Live feature cards from the catalog" },
  { type: "feature-demo", label: "Feature visual demo", desc: "Floating product simulation + copy" },
  { type: "clients", label: "Valued clients", desc: "Client cards from the clients library" },
  { type: "testimonials", label: "Testimonials", desc: "Quote wall from testimonials library" },
  { type: "how-it-works", label: "How it works", desc: "Numbered steps" },
  { type: "stats", label: "Stats", desc: "Value + label stat strip" },
  { type: "cta", label: "CTA band", desc: "Call-to-action with buttons" },
  { type: "faq", label: "FAQ", desc: "Q&A accordion" },
  { type: "pricing", label: "Pricing", desc: "Live plan cards from the database" },
  { type: "contact-form", label: "Contact", desc: "Contact info + inquiry form" },
  { type: "text", label: "Text", desc: "Title + paragraphs" },
  { type: "text-image", label: "Text + image", desc: "Copy beside an image" },
  { type: "cards", label: "Cards", desc: "Generic 3-column card grid" },
  { type: "logos", label: "Logo strip", desc: "Row of client/brand logos" },
  { type: "custom-html", label: "Custom HTML", desc: "Owner-authored raw HTML" },
]

let uid = 0
const newBlockId = () => `b-${Date.now().toString(36)}-${++uid}`

export function PagesTab() {
  const { data, loading, error, reload } = useOwnerApi<{ pages: CmsPageRecord[] }>("owner.cms.pages.list", {})
  const [editing, setEditing] = useState<CmsPageRecord | null>(null)
  const [creating, setCreating] = useState(false)

  if (loading) return <Loading />
  if (error) return <ErrorBanner message={error} />

  if (creating) {
    return <PageEditor page={null} onClose={() => { setCreating(false); reload() }} />
  }
  if (editing) {
    return <PageEditor page={editing} onClose={() => { setEditing(null); reload() }} />
  }

  const pages = data?.pages ?? []

  const publish = async (id: string, status: "DRAFT" | "PUBLISHED") => {
    try { await ownerRpc("owner.cms.pages.publish", { id, status }); reload() } catch { /* surfaced on next load */ }
  }
  const remove = async (id: string, title: string) => {
    if (!confirm(`Delete page "${title}"? This cannot be undone.`)) return
    try { await ownerRpc("owner.cms.pages.delete", { id }); reload() } catch (e: any) { alert(e?.message || "Delete failed") }
  }
  const move = async (index: number, dir: -1 | 1) => {
    const j = index + dir
    if (j < 0 || j >= pages.length) return
    const next = [...pages]
    ;[next[index], next[j]] = [next[j], next[index]]
    try {
      await ownerRpc("owner.cms.pages.reorder", { order: next.map((p, i) => ({ id: p.id, sortOrder: i })) })
      reload()
    } catch (e: any) { alert(e?.message || "Reorder failed") }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-bold text-white light:text-slate-900">Pages ({pages.length})</p>
        <Button size="sm" className="bg-gradient-to-r from-blue-600 to-violet-600 text-white" onClick={() => setCreating(true)}><Plus className="mr-1 h-3.5 w-3.5" /> New page</Button>
      </div>
      <div className="overflow-x-auto rounded-2xl border border-white/10 light:border-slate-200">
        <table className="w-full min-w-[640px] text-left text-sm">
          <thead>
            <tr className="border-b border-white/10 light:border-slate-200 text-[11px] uppercase tracking-widest text-slate-500">
              <th className="p-3">Page</th>
              <th className="p-3">Type</th>
              <th className="p-3">Route</th>
              <th className="p-3">Status</th>
              <th className="p-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {pages.map((p, i) => (
              <tr key={p.id} className="border-b border-white/5 light:border-slate-100 last:border-0">
                <td className="p-3">
                  <div className="flex items-center gap-2">
                    <FileText className="h-3.5 w-3.5 text-slate-500" />
                    <div>
                      <p className="font-semibold text-white light:text-slate-900">{p.title} {p.isSystem && <span className="ml-1 rounded bg-slate-700/60 light:bg-slate-200 px-1.5 py-0.5 text-[9px] font-bold uppercase text-slate-300 light:text-slate-600">system</span>}</p>
                      <p className="text-[11px] text-slate-500">{p.blocks.length} section{p.blocks.length === 1 ? "" : "s"} · updated {new Date(p.updatedAt).toLocaleDateString()}</p>
                    </div>
                  </div>
                </td>
                <td className="p-3 text-xs text-slate-400 light:text-slate-600">{p.pageType}</td>
                <td className="p-3 font-mono text-[11px] text-indigo-300 light:text-indigo-600">{p.slug === "home" ? "/" : p.pageType === "CUSTOM" ? `/p/${p.slug}` : `/${p.slug}`}</td>
                <td className="p-3">
                  <button
                    type="button"
                    onClick={() => publish(p.id, p.status === "PUBLISHED" ? "DRAFT" : "PUBLISHED")}
                    className={cn(
                      "rounded-full px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide ring-1",
                      p.status === "PUBLISHED"
                        ? "bg-emerald-500/10 text-emerald-300 ring-emerald-400/30 light:bg-emerald-50 light:text-emerald-700 light:ring-emerald-300"
                        : "bg-amber-500/10 text-amber-300 ring-amber-400/30 light:bg-amber-50 light:text-amber-700 light:ring-amber-300"
                    )}
                  >
                    {p.status}
                  </button>
                </td>
                <td className="p-3">
                  <div className="flex items-center justify-end gap-1">
                    <Button size="sm" variant="outline" className="h-8 px-2 text-xs" onClick={() => move(i, -1)} disabled={i === 0}><ArrowUp className="h-3.5 w-3.5" /></Button>
                    <Button size="sm" variant="outline" className="h-8 px-2 text-xs" onClick={() => move(i, 1)} disabled={i === pages.length - 1}><ArrowDown className="h-3.5 w-3.5" /></Button>
                    <Button size="sm" variant="outline" className="h-8 px-2.5 text-xs" onClick={() => setEditing(p)}><Pencil className="mr-1 h-3.5 w-3.5" /> Edit</Button>
                    <Button size="sm" variant="outline" className="h-8 px-2 text-xs text-red-400 light:text-red-600" onClick={() => remove(p.id, p.title)} disabled={p.isSystem}><Trash2 className="h-3.5 w-3.5" /></Button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-[11px] leading-relaxed text-slate-500">
        System pages (Home, About, FAQ) back fixed routes and cannot be deleted — hide or repurpose them instead.
        Custom pages render at <span className="font-mono">/p/&lt;slug&gt;</span>. Draft pages stay invisible to visitors.
      </p>
    </div>
  )
}

// ============================== PAGE EDITOR ==============================
function PageEditor({ page, onClose }: { page: CmsPageRecord | null; onClose: () => void }) {
  const [form, setForm] = useState<CmsPageRecord>(() =>
    page ?? {
      id: "", slug: "", title: "", pageType: "CUSTOM", status: "DRAFT", visible: true, sortOrder: 99,
      showInNav: false, navLabel: null, seoTitle: null, seoDesc: null, blocks: [], isSystem: false,
      updatedAt: new Date().toISOString(),
    }
  )
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)

  const save = async () => {
    setBusy(true); setMsg(null); setErr(null)
    try {
      await ownerRpc("owner.cms.pages.save", {
        ...(form.id ? { id: form.id } : {}),
        slug: form.slug, title: form.title, pageType: form.pageType, status: form.status,
        visible: form.visible, sortOrder: form.sortOrder, showInNav: form.showInNav,
        navLabel: form.navLabel, seoTitle: form.seoTitle, seoDesc: form.seoDesc, blocks: form.blocks,
      })
      setMsg("Page saved." + (form.status === "PUBLISHED" ? " Changes are live on the website." : " It stays hidden until you publish."))
    } catch (e: any) { setErr(e?.message || "Save failed") } finally { setBusy(false) }
  }

  const setBlocks = (blocks: CmsBlock[]) => setForm({ ...form, blocks })

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" className="text-xs" onClick={onClose}><X className="mr-1 h-3.5 w-3.5" /> Back to pages</Button>
          <p className="text-sm font-bold text-white light:text-slate-900">{page ? `Edit: ${form.title}` : "New page"}</p>
        </div>
        <Button size="sm" className="bg-gradient-to-r from-blue-600 to-violet-600 text-white" onClick={save} disabled={busy}>
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <><Save className="mr-1 h-3.5 w-3.5" /> {form.status === "PUBLISHED" ? "Save & publish" : "Save draft"}</>}
        </Button>
      </div>
      <SuccessNote msg={msg} />
      <ErrorNote msg={err} />

      <div className="grid gap-4 xl:grid-cols-[1fr_2fr]">
        <div className="space-y-4">
          <WCard title="Page settings" desc="Identity, routing, visibility and SEO.">
            <WField label="Title"><Input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} className={inputCls} /></WField>
            <WField label="Slug" hint={form.pageType === "CUSTOM" ? "Renders at /p/<slug> — lowercase kebab-case." : "System pages keep their route slug."}>
              <Input value={form.slug} disabled={form.isSystem} onChange={(e) => setForm({ ...form, slug: e.target.value.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") })} className={inputCls} />
            </WField>
            {form.id === "" && (
              <WField label="Page type">
                <div className="flex gap-2">
                  {(["CUSTOM", "SYSTEM"] as const).map((t) => (
                    <button key={t} type="button" onClick={() => setForm({ ...form, pageType: t, isSystem: t === "SYSTEM" })} className={cn("rounded-lg border px-3 py-1.5 text-xs font-semibold", form.pageType === t ? "border-indigo-400/50 bg-indigo-600/20 text-white light:text-slate-900" : "border-white/10 text-slate-500 light:border-slate-300")}>
                      {t}
                    </button>
                  ))}
                </div>
              </WField>
            )}
            <WToggle label="Visible (listed & linked)" checked={form.visible} onChange={(v) => setForm({ ...form, visible: v })} />
            <WToggle label="Published (visible to visitors)" checked={form.status === "PUBLISHED"} onChange={(v) => setForm({ ...form, status: v ? "PUBLISHED" : "DRAFT" })} />
            <WToggle label="Show in navigation menu" checked={form.showInNav} onChange={(v) => setForm({ ...form, showInNav: v })} />
            {form.showInNav && <WField label="Navigation label"><Input value={form.navLabel || ""} onChange={(e) => setForm({ ...form, navLabel: e.target.value })} className={inputCls} /></WField>}
            <WField label="SEO title (optional)"><Input value={form.seoTitle || ""} onChange={(e) => setForm({ ...form, seoTitle: e.target.value })} className={inputCls} maxLength={200} /></WField>
            <WTextArea label="SEO description (optional)" value={form.seoDesc || ""} onChange={(v) => setForm({ ...form, seoDesc: v })} rows={2} maxLength={400} />
          </WCard>
        </div>

        <BlockListEditor blocks={form.blocks} onChange={setBlocks} />
      </div>
    </div>
  )
}

// ============================== BLOCK LIST ==============================
function BlockListEditor({ blocks, onChange }: { blocks: CmsBlock[]; onChange: (b: CmsBlock[]) => void }) {
  const [adding, setAdding] = useState(false)
  const [openBlock, setOpenBlock] = useState<string | null>(null)

  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir
    if (j < 0 || j >= blocks.length) return
    const next = [...blocks]
    ;[next[i], next[j]] = [next[j], next[i]]
    onChange(next)
  }
  const patch = (id: string, p: Partial<CmsBlock>) => onChange(blocks.map((b) => (b.id === id ? { ...b, ...p } : b)))

  return (
    <WCard title={`Page sections (${blocks.length})`} desc="Sections render top-to-bottom. Reorder, hide, duplicate or delete — changes publish with the page.">
      <div className="space-y-2">
        {blocks.map((b, i) => {
          const meta = BLOCK_TYPES.find((t) => t.type === b.type)
          return (
            <div key={b.id} className={cn("rounded-xl border p-3 transition-colors", b.visible ? "border-white/10 light:border-slate-200 bg-white/[0.02] light:bg-slate-50" : "border-white/5 light:border-slate-200 bg-transparent opacity-60")}>
              <div className="flex flex-wrap items-center gap-2">
                <span className="flex h-6 w-6 items-center justify-center rounded-md bg-indigo-600/20 text-[11px] font-bold text-indigo-300 light:text-indigo-700">{i + 1}</span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13px] font-semibold text-white light:text-slate-900">{meta?.label ?? b.type}</p>
                  <p className="truncate text-[10px] text-slate-500">{meta?.desc ?? "Custom block"}</p>
                </div>
                <div className="flex items-center gap-1">
                  <Button size="sm" variant="outline" className="h-7 px-2 text-[11px]" onClick={() => patch(b.id, { visible: !b.visible })} title={b.visible ? "Hide section" : "Show section"}>
                    {b.visible ? <Eye className="h-3 w-3" /> : <EyeOff className="h-3 w-3" />}
                  </Button>
                  <Button size="sm" variant="outline" className="h-7 px-2 text-[11px]" onClick={() => move(i, -1)} disabled={i === 0}><ArrowUp className="h-3 w-3" /></Button>
                  <Button size="sm" variant="outline" className="h-7 px-2 text-[11px]" onClick={() => move(i, 1)} disabled={i === blocks.length - 1}><ArrowDown className="h-3 w-3" /></Button>
                  <Button size="sm" variant="outline" className="h-7 px-2 text-[11px]" onClick={() => onChange([...blocks.slice(0, i + 1), { ...b, id: newBlockId() }, ...blocks.slice(i + 1)])} title="Duplicate"><Copy className="h-3 w-3" /></Button>
                  <Button size="sm" variant="outline" className="h-7 px-2.5 text-[11px]" onClick={() => setOpenBlock(openBlock === b.id ? null : b.id)}>
                    {openBlock === b.id ? "Close" : "Edit"}
                  </Button>
                  <Button size="sm" variant="outline" className="h-7 px-2 text-[11px] text-red-400 light:text-red-600" onClick={() => onChange(blocks.filter((x) => x.id !== b.id))}><Trash2 className="h-3 w-3" /></Button>
                </div>
              </div>
              {openBlock === b.id && (
                <div className="mt-3 border-t border-white/10 light:border-slate-200 pt-3">
                  <BlockDataEditor block={b} onChange={(data) => patch(b.id, { data })} />
                </div>
              )}
            </div>
          )
        })}
      </div>

      {adding ? (
        <div className="mt-3 rounded-xl border border-white/10 light:border-slate-200 bg-white/[0.02] light:bg-slate-50 p-3">
          <div className="grid gap-1.5 sm:grid-cols-2">
            {BLOCK_TYPES.map((t) => (
              <button key={t.type} type="button" className="rounded-lg border border-white/10 light:border-slate-200 p-2.5 text-left transition-colors hover:border-indigo-400/40 hover:bg-white/5 light:hover:bg-white" onClick={() => { onChange([...blocks, { id: newBlockId(), type: t.type, visible: true, data: {} }]); setAdding(false) }}>
                <p className="text-[12px] font-semibold text-white light:text-slate-900">{t.label}</p>
                <p className="text-[10px] text-slate-500">{t.desc}</p>
              </button>
            ))}
          </div>
          <Button size="sm" variant="outline" className="mt-2 text-xs" onClick={() => setAdding(false)}>Cancel</Button>
        </div>
      ) : (
        <Button size="sm" variant="outline" className="mt-3 text-xs" onClick={() => setAdding(true)}><Plus className="mr-1 h-3.5 w-3.5" /> Add section</Button>
      )}
    </WCard>
  )
}

// ============================== BLOCK DATA EDITORS ==============================
function BlockDataEditor({ block, onChange }: { block: CmsBlock; onChange: (data: Record<string, unknown>) => void }) {
  const d = block.data ?? {}
  const set = (k: string, v: unknown) => onChange({ ...d, [k]: v })

  switch (block.type) {
    case "hero":
      return (
        <div className="grid gap-3 sm:grid-cols-2">
          <WField label="Badge"><Input value={S(d.badge)} onChange={(e) => set("badge", e.target.value)} className={inputCls} /></WField>
          <WField label="Title"><Input value={S(d.title)} onChange={(e) => set("title", e.target.value)} className={inputCls} /></WField>
          <div className="sm:col-span-2"><WTextArea label="Subtitle" value={S(d.sub)} onChange={(v) => set("sub", v)} rows={2} /></div>
          <WField label="Primary CTA label"><Input value={S(d.primaryLabel)} onChange={(e) => set("primaryLabel", e.target.value)} className={inputCls} /></WField>
          <WField label="Primary CTA link"><Input value={S(d.primaryHref, "/register")} onChange={(e) => set("primaryHref", e.target.value)} className={inputCls} /></WField>
          <WField label="Secondary CTA label"><Input value={S(d.secondaryLabel)} onChange={(e) => set("secondaryLabel", e.target.value)} className={inputCls} /></WField>
          <WField label="Secondary CTA link"><Input value={S(d.secondaryHref, "/features")} onChange={(e) => set("secondaryHref", e.target.value)} className={inputCls} /></WField>
          <ListEditor label="Bullet points" items={A(d.bullets)} onChange={(v) => set("bullets", v)} />
          <StatListEditor label="Stat strip" items={A(d.stats)} onChange={(v) => set("stats", v)} />
        </div>
      )
    case "cta":
      return (
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="sm:col-span-2"><WField label="Title"><Input value={S(d.title)} onChange={(e) => set("title", e.target.value)} className={inputCls} /></WField></div>
          <div className="sm:col-span-2"><WTextArea label="Subtitle" value={S(d.sub)} onChange={(v) => set("sub", v)} rows={2} /></div>
          <WField label="Primary label"><Input value={S(d.primaryLabel)} onChange={(e) => set("primaryLabel", e.target.value)} className={inputCls} /></WField>
          <WField label="Primary link"><Input value={S(d.primaryHref, "/register")} onChange={(e) => set("primaryHref", e.target.value)} className={inputCls} /></WField>
          <WField label="Secondary label"><Input value={S(d.secondaryLabel)} onChange={(e) => set("secondaryLabel", e.target.value)} className={inputCls} /></WField>
          <WField label="Secondary link"><Input value={S(d.secondaryHref, "/pricing")} onChange={(e) => set("secondaryHref", e.target.value)} className={inputCls} /></WField>
          <div className="sm:col-span-2"><WField label="Note line"><Input value={S(d.note)} onChange={(e) => set("note", e.target.value)} className={inputCls} /></WField></div>
        </div>
      )
    case "stats":
      return <StatListEditor label="Stats" items={A(d.items)} onChange={(v) => set("items", v)} />
    case "value-props":
    case "cards":
      return <IconItemListEditor label="Items" items={A(d.items)} onChange={(v) => set("items", v)} withIcon />
    case "features":
      return (
        <div className="grid gap-3 sm:grid-cols-2">
          <WField label="Eyebrow"><Input value={S(d.eyebrow)} onChange={(e) => set("eyebrow", e.target.value)} className={inputCls} /></WField>
          <WField label="Title"><Input value={S(d.title)} onChange={(e) => set("title", e.target.value)} className={inputCls} /></WField>
          <div className="sm:col-span-2"><WTextArea label="Subtitle" value={S(d.sub)} onChange={(v) => set("sub", v)} rows={2} /></div>
          <WField label="Source" hint="Live feature cards read the Features tab; custom items are defined below.">
            <Select2 value={S(d.source, "cms-features")} options={[["cms-features", "Feature catalog (live)"], ["custom", "Custom items"]]} onChange={(v) => set("source", v)} />
          </WField>
          {d.source === "custom" && <div className="sm:col-span-2"><IconItemListEditor label="Custom items" items={A(d.items)} onChange={(v) => set("items", v)} withHref /></div>}
        </div>
      )
    case "feature-demo":
      return (
        <div className="grid gap-3 sm:grid-cols-2">
          <WField label="Feature slug" hint="Which feature's simulation to embed (see Features tab).">
            <Input value={S(d.featureSlug)} onChange={(e) => set("featureSlug", e.target.value)} className={inputCls} placeholder="all-in-one-dashboard" />
          </WField>
          <WField label="Title override"><Input value={S(d.title)} onChange={(e) => set("title", e.target.value)} className={inputCls} /></WField>
          <WField label="Eyebrow"><Input value={S(d.eyebrow)} onChange={(e) => set("eyebrow", e.target.value)} className={inputCls} /></WField>
          <WField label="Subtitle override"><Input value={S(d.sub)} onChange={(e) => set("sub", e.target.value)} className={inputCls} /></WField>
          <WToggle label="Flip layout (visual on the left)" checked={d.flip === true} onChange={(v) => set("flip", v)} />
        </div>
      )
    case "how-it-works":
      return (
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <WField label="Title"><Input value={S(d.title)} onChange={(e) => set("title", e.target.value)} className={inputCls} /></WField>
            <WField label="Eyebrow"><Input value={S(d.eyebrow)} onChange={(e) => set("eyebrow", e.target.value)} className={inputCls} /></WField>
          </div>
          <WTextArea label="Subtitle" value={S(d.sub)} onChange={(v) => set("sub", v)} rows={2} />
          <StepListEditor label="Steps" items={A(d.steps)} onChange={(v) => set("steps", v)} />
        </div>
      )
    case "clients":
      return (
        <div className="space-y-3">
          <WField label="Title"><Input value={S(d.title)} onChange={(e) => set("title", e.target.value)} className={inputCls} /></WField>
          <WTextArea label="Subtitle" value={S(d.sub)} onChange={(v) => set("sub", v)} rows={2} />
          <WField label="Layout">
            <Select2 value={S(d.layout, "grid")} options={[["grid", "Client cards"], ["logos", "Logo wall"]]} onChange={(v) => set("layout", v)} />
          </WField>
          <WToggle label="Show quotes/stories on cards" checked={d.showStories !== false} onChange={(v) => set("showStories", v)} />
        </div>
      )
    case "testimonials":
      return (
        <div className="grid gap-3 sm:grid-cols-2">
          <WField label="Title"><Input value={S(d.title)} onChange={(e) => set("title", e.target.value)} className={inputCls} /></WField>
          <WField label="Eyebrow"><Input value={S(d.eyebrow)} onChange={(e) => set("eyebrow", e.target.value)} className={inputCls} /></WField>
          <div className="sm:col-span-2"><WTextArea label="Subtitle" value={S(d.sub)} onChange={(v) => set("sub", v)} rows={2} /></div>
        </div>
      )
    case "faq":
      return <QaListEditor label="Questions" items={A(d.items)} onChange={(v) => set("items", v)} />
    case "text":
      return (
        <div className="space-y-3">
          <WField label="Title"><Input value={S(d.title)} onChange={(e) => set("title", e.target.value)} className={inputCls} /></WField>
          <ListEditor label="Paragraphs" items={A(d.body)} onChange={(v) => set("body", v)} />
        </div>
      )
    case "text-image":
      return (
        <div className="space-y-3">
          <WField label="Title"><Input value={S(d.title)} onChange={(e) => set("title", e.target.value)} className={inputCls} /></WField>
          <ListEditor label="Paragraphs" items={A(d.body)} onChange={(v) => set("body", v)} />
          <WField label="Image (URL or data URL)"><Input value={S(d.image)} onChange={(e) => set("image", e.target.value)} className={inputCls} placeholder="https://… or paste data URL" /></WField>
          <ListEditor label="Bullets" items={A(d.bullets)} onChange={(v) => set("bullets", v)} />
          <WToggle label="Flip layout (image on the left)" checked={d.flip === true} onChange={(v) => set("flip", v)} />
        </div>
      )
    case "logos":
      return <LogoListEditor label="Logos" items={A(d.items)} onChange={(v) => set("items", v)} />
    case "custom-html":
      return <WTextArea label="HTML" value={S(d.html)} onChange={(v) => set("html", v)} rows={8} placeholder="<div>…</div>" />
    case "pricing":
    case "contact-form":
      return (
        <div className="grid gap-3 sm:grid-cols-2">
          <WField label="Eyebrow"><Input value={S(d.eyebrow)} onChange={(e) => set("eyebrow", e.target.value)} className={inputCls} /></WField>
          <WField label="Title"><Input value={S(d.title)} onChange={(e) => set("title", e.target.value)} className={inputCls} /></WField>
          <div className="sm:col-span-2"><WTextArea label="Subtitle" value={S(d.sub)} onChange={(v) => set("sub", v)} rows={2} /></div>
          {block.type === "contact-form" && <WToggle label="Show the inquiry form" checked={d.showForm !== false} onChange={(v) => set("showForm", v)} />}
        </div>
      )
    default:
      return <WTextArea label="Block JSON (advanced)" value={JSON.stringify(d, null, 2)} onChange={(v) => { try { onChange(JSON.parse(v)) } catch { /* ignore invalid json while typing */ } }} rows={8} />
  }
}

// ---------- small list editors ----------
const S = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : fallback)
const A = (v: unknown): any[] => (Array.isArray(v) ? v : [])

function ListEditor({ label, items, onChange }: { label: string; items: string[]; onChange: (v: string[]) => void }) {
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

function StatListEditor({ label, items, onChange }: { label: string; items: { value: string; label: string }[]; onChange: (v: any[]) => void }) {
  return (
    <WField label={label}>
      <div className="space-y-1.5">
        {(items ?? []).map((it, i) => (
          <div key={i} className="flex gap-1.5">
            <Input value={it.value} onChange={(e) => onChange(items.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))} className={`${inputCls} w-24`} placeholder="value" />
            <Input value={it.label} onChange={(e) => onChange(items.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} className={inputCls} placeholder="label" />
            <Button size="sm" variant="outline" className="h-10 px-2 text-xs text-red-400 light:text-red-600" onClick={() => onChange(items.filter((_, j) => j !== i))}><Trash2 className="h-3.5 w-3.5" /></Button>
          </div>
        ))}
        <Button size="sm" variant="outline" className="h-8 text-[11px]" onClick={() => onChange([...(items ?? []), { value: "", label: "" }])}><Plus className="mr-1 h-3 w-3" /> Add</Button>
      </div>
    </WField>
  )
}

function IconItemListEditor({ label, items, onChange, withIcon, withHref }: {
  label: string; items: { icon?: string; title: string; body?: string; href?: string }[]
  onChange: (v: any[]) => void; withIcon?: boolean; withHref?: boolean
}) {
  return (
    <WField label={label}>
      <div className="space-y-2">
        {(items ?? []).map((it, i) => (
          <div key={i} className="flex flex-wrap gap-1.5 rounded-lg border border-white/10 light:border-slate-200 p-2">
            {withIcon && <Input value={it.icon || ""} onChange={(e) => onChange(items.map((x, j) => (j === i ? { ...x, icon: e.target.value } : x)))} className={`${inputCls} w-24`} placeholder="icon" />}
            <Input value={it.title} onChange={(e) => onChange(items.map((x, j) => (j === i ? { ...x, title: e.target.value } : x)))} className={`${inputCls} ${withHref ? "w-40" : "flex-1"}`} placeholder="Title" />
            {withHref && <Input value={it.href || ""} onChange={(e) => onChange(items.map((x, j) => (j === i ? { ...x, href: e.target.value } : x)))} className={`${inputCls} w-40`} placeholder="/link" />}
            <div className="flex w-full gap-1.5">
              <Input value={it.body || ""} onChange={(e) => onChange(items.map((x, j) => (j === i ? { ...x, body: e.target.value } : x)))} className={inputCls} placeholder="Body text" />
              <Button size="sm" variant="outline" className="h-10 px-2 text-xs text-red-400 light:text-red-600" onClick={() => onChange(items.filter((_, j) => j !== i))}><Trash2 className="h-3.5 w-3.5" /></Button>
            </div>
          </div>
        ))}
        <Button size="sm" variant="outline" className="h-8 text-[11px]" onClick={() => onChange([...(items ?? []), { title: "", body: "" }])}><Plus className="mr-1 h-3 w-3" /> Add</Button>
      </div>
    </WField>
  )
}

function StepListEditor({ label, items, onChange }: { label: string; items: { step: string; title: string; body: string }[]; onChange: (v: any[]) => void }) {
  return (
    <WField label={label}>
      <div className="space-y-2">
        {(items ?? []).map((it, i) => (
          <div key={i} className="flex flex-wrap gap-1.5 rounded-lg border border-white/10 light:border-slate-200 p-2">
            <Input value={it.step} onChange={(e) => onChange(items.map((x, j) => (j === i ? { ...x, step: e.target.value } : x)))} className={`${inputCls} w-14`} placeholder="1" />
            <Input value={it.title} onChange={(e) => onChange(items.map((x, j) => (j === i ? { ...x, title: e.target.value } : x)))} className={`${inputCls} flex-1`} placeholder="Step title" />
            <div className="flex w-full gap-1.5">
              <Input value={it.body} onChange={(e) => onChange(items.map((x, j) => (j === i ? { ...x, body: e.target.value } : x)))} className={inputCls} placeholder="Step description" />
              <Button size="sm" variant="outline" className="h-10 px-2 text-xs text-red-400 light:text-red-600" onClick={() => onChange(items.filter((_, j) => j !== i))}><Trash2 className="h-3.5 w-3.5" /></Button>
            </div>
          </div>
        ))}
        <Button size="sm" variant="outline" className="h-8 text-[11px]" onClick={() => onChange([...(items ?? []), { step: String((items?.length ?? 0) + 1), title: "", body: "" }])}><Plus className="mr-1 h-3 w-3" /> Add step</Button>
      </div>
    </WField>
  )
}

function QaListEditor({ label, items, onChange }: { label: string; items: { q: string; a: string }[]; onChange: (v: any[]) => void }) {
  return (
    <WField label={label}>
      <div className="space-y-2">
        {(items ?? []).map((it, i) => (
          <div key={i} className="space-y-1.5 rounded-lg border border-white/10 light:border-slate-200 p-2">
            <div className="flex gap-1.5">
              <Input value={it.q} onChange={(e) => onChange(items.map((x, j) => (j === i ? { ...x, q: e.target.value } : x)))} className={inputCls} placeholder="Question" />
              <Button size="sm" variant="outline" className="h-10 px-2 text-xs text-red-400 light:text-red-600" onClick={() => onChange(items.filter((_, j) => j !== i))}><Trash2 className="h-3.5 w-3.5" /></Button>
            </div>
            <textarea value={it.a} rows={2} onChange={(e) => onChange(items.map((x, j) => (j === i ? { ...x, a: e.target.value } : x)))} className="w-full rounded-lg border border-white/10 light:border-slate-200 bg-white/5 light:bg-white p-2.5 text-sm text-white light:text-slate-900" placeholder="Answer" />
          </div>
        ))}
        <Button size="sm" variant="outline" className="h-8 text-[11px]" onClick={() => onChange([...(items ?? []), { q: "", a: "" }])}><Plus className="mr-1 h-3 w-3" /> Add question</Button>
      </div>
    </WField>
  )
}

function LogoListEditor({ label, items, onChange }: { label: string; items: { name: string; logoText?: string; logoColor?: string; logoUrl?: string }[]; onChange: (v: any[]) => void }) {
  return (
    <WField label={label}>
      <div className="space-y-1.5">
        {(items ?? []).map((it, i) => (
          <div key={i} className="flex flex-wrap gap-1.5">
            <Input value={it.name} onChange={(e) => onChange(items.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} className={`${inputCls} w-40`} placeholder="Name" />
            <Input value={it.logoText || ""} onChange={(e) => onChange(items.map((x, j) => (j === i ? { ...x, logoText: e.target.value } : x)))} className={`${inputCls} w-16`} placeholder="AB" />
            <input type="color" value={it.logoColor || "#2563eb"} onChange={(e) => onChange(items.map((x, j) => (j === i ? { ...x, logoColor: e.target.value } : x)))} className="h-10 w-12 cursor-pointer rounded-lg border border-white/10 bg-transparent" title="Logo color" />
            <Button size="sm" variant="outline" className="h-10 px-2 text-xs text-red-400 light:text-red-600" onClick={() => onChange(items.filter((_, j) => j !== i))}><Trash2 className="h-3.5 w-3.5" /></Button>
          </div>
        ))}
        <Button size="sm" variant="outline" className="h-8 text-[11px]" onClick={() => onChange([...(items ?? []), { name: "" }])}><Plus className="mr-1 h-3 w-3" /> Add</Button>
      </div>
    </WField>
  )
}

function Select2({ value, options, onChange }: { value: string; options: [string, string][]; onChange: (v: string) => void }) {
  return (
    <div className="flex flex-wrap gap-2">
      {options.map(([k, l]) => (
        <button key={k} type="button" onClick={() => onChange(k)} className={cn("rounded-lg border px-3 py-1.5 text-xs font-semibold", value === k ? "border-indigo-400/50 bg-indigo-600/20 text-white light:text-slate-900" : "border-white/10 text-slate-500 light:border-slate-300")}>
          {l}
        </button>
      ))}
    </div>
  )
}

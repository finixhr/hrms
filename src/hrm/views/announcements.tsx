"use client"
// ============ HR Announcements ============
// Company-wide / targeted announcements with pinning and audience scoping.
import { useEffect, useState } from "react"
import {
  Megaphone, Pin, Plus, Trash2, Send, Search, Users, Building2,
  Network, IdCard, Globe, Eye,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Switch } from "@/components/ui/switch"
import { Checkbox } from "@/components/ui/checkbox"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { useHrm } from "../store"
import { useApi, rpc, useLookup } from "../api"
import { PageHeader, SectionCard, fmtDateTime } from "../shared/ui-kit"
import { ConfirmDialog } from "../shared/form-dialog"

const AUDIENCE_TYPES = [
  { value: "ALL", label: "All Employees", icon: Globe },
  { value: "BRANCH", label: "Specific Branches", icon: Building2 },
  { value: "DEPARTMENT", label: "Specific Departments", icon: Network },
  { value: "DESIGNATION", label: "Specific Designations", icon: IdCard },
  { value: "SPECIFIC", label: "Specific Employees", icon: Users },
]

export default function AnnouncementsView() {
  const { can } = useHrm()
  const canCreate = can("announcements", "create")
  const canDelete = can("announcements", "delete")
  const { data, loading, error, reload } = useApi<any[]>("announcements.list")
  const [open, setOpen] = useState(false)
  const [delTarget, setDelTarget] = useState<any>(null)

  const items = data || []
  const pinned = items.filter((a) => a.pinned)
  const rest = items.filter((a) => !a.pinned)

  return (
    <div className="space-y-4">
      <PageHeader
        title="HR Announcements"
        subtitle={`${items.length} announcement${items.length === 1 ? "" : "s"}${pinned.length ? ` · ${pinned.length} pinned` : ""}`}
        actions={canCreate && (
          <Button size="sm" className="h-8 text-xs " onClick={() => setOpen(true)}>
            <Plus className="h-3.5 w-3.5 mr-1" /> New Announcement
          </Button>
        )}
      />

      {loading && <div className="rounded-xl border bg-white dark:bg-slate-900 p-6 text-center text-sm text-slate-400">Loading announcements…</div>}
      {error && <div className="rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700">{error}</div>}

      {!loading && !error && items.length === 0 && (
        <div className="rounded-xl border border-dashed bg-white dark:bg-slate-900">
          <div className="py-14 text-center">
            <Megaphone className="h-10 w-10 text-slate-300 dark:text-slate-600 mx-auto mb-3" />
            <p className="text-sm font-medium text-slate-500 dark:text-slate-400">No announcements yet</p>
            <p className="text-xs text-slate-400 mt-1">Company news and notices for employees will appear here.</p>
          </div>
        </div>
      )}

      <div className="grid md:grid-cols-2 gap-4">
        {[...pinned, ...rest].map((a) => (
          <div key={a.id} className={`rounded-xl border p-4 flex flex-col gap-2 ${a.pinned ? "border-amber-300 dark:border-amber-800 bg-amber-50/60 dark:bg-amber-950/30" : "border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900"}`}>
            <div className="flex items-start gap-2">
              {a.pinned ? <Pin className="h-4 w-4 text-amber-500 shrink-0 mt-0.5 fill-amber-500" /> : <Megaphone className="h-4 w-4 text-slate-400 shrink-0 mt-0.5" />}
              <div className="min-w-0 flex-1">
                <p className="text-sm font-bold text-slate-800 dark:text-slate-100 leading-snug">{a.title}</p>
                <p className="text-[10px] text-slate-500 dark:text-slate-400 mt-0.5">{fmtDateTime(a.publishedAt || a.createdAt)} · {a.audienceLabel || "All Employees"}</p>
              </div>
              {canDelete && (
                <Button aria-label="Delete" size="icon" variant="ghost" className="h-7 w-7 text-slate-400 hover:text-rose-600 shrink-0" onClick={() => setDelTarget(a)}>
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              )}
            </div>
            <p className="text-xs text-slate-600 dark:text-slate-300 whitespace-pre-wrap leading-relaxed break-words">{a.body}</p>
            <div className="flex flex-wrap items-center gap-1.5 mt-auto pt-1">
              <Badge variant="outline" className="text-[10px] bg-white dark:bg-slate-900 max-w-full truncate">
                <Users className="h-3 w-3 mr-1 text-emerald-600 shrink-0" /> {a.audienceLabel || "All Employees"}
              </Badge>
              {a.pinned && <Badge className="bg-amber-100 text-amber-700 text-[10px]">Pinned</Badge>}
            </div>
            {/* COM-02 (R7) — read-receipt progress: how much of the audience
                has opened the notice (audience members' readAt receipts). */}
            {typeof a.audienceSize === "number" && a.audienceSize > 0 && (
              <div className="mt-1 rounded-lg border border-emerald-100 dark:border-emerald-900/50 bg-emerald-50/50 dark:bg-emerald-950/20 px-2.5 py-2">
                <div className="flex items-center justify-between text-[10px] font-medium text-emerald-700 dark:text-emerald-400">
                  <span className="flex items-center gap-1"><Eye className="h-3 w-3" /> Read by employees</span>
                  <span className="tabular-nums">{a.readCount} / {a.audienceSize} ({Math.round((a.readCount / a.audienceSize) * 100)}%)</span>
                </div>
                <div className="mt-1.5 h-1.5 rounded-full bg-emerald-100 dark:bg-emerald-900/60 overflow-hidden">
                  <div className="h-full rounded-full bg-gradient-to-r from-emerald-500 to-teal-500 transition-all" style={{ width: `${Math.min(100, Math.round((a.readCount / a.audienceSize) * 100))}%` }} />
                </div>
              </div>
            )}
          </div>
        ))}
      </div>

      {items.length > 0 && (
        <SectionCard title="Delivery">
          <p className="text-xs text-slate-500">
            Announcements fan out in-app notifications to targeted employees (branches, departments, designations or
            specific people). Pinned announcements stay at the top of the list.
          </p>
        </SectionCard>
      )}

      <AnnouncementDialog open={open} onOpenChange={(v) => { setOpen(v); if (!v) reload() }} />

      <ConfirmDialog open={!!delTarget} onOpenChange={(v) => { if (!v) setDelTarget(null) }} title="Delete announcement"
        message={`Delete "${delTarget?.title}"? It disappears from every employee's portal.`}
        danger confirmLabel="Delete"
        onConfirm={async () => { await rpc("announcements.delete", { id: delTarget.id }); reload() }} />
    </div>
  )
}

function AnnouncementDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const toast = useHrm((s) => s.toast)
  const [values, setValues] = useState<Record<string, any>>({})
  const [ids, setIds] = useState<string[]>([])
  const [idQuery, setIdQuery] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const { data: branches } = useApi<any[]>(open ? "branches.list" : null, {})
  const { data: departments } = useApi<any[]>(open ? "departments.list" : null, {})
  const { data: designations } = useApi<any[]>(open ? "designations.list" : null, {})
  const { data: employees } = useLookup<any[]>("employees.list", {}, open && values.audienceType === "SPECIFIC")

  useEffect(() => {
    if (open) { setValues({ title: "", body: "", audienceType: "ALL", pinned: false }); setIds([]); setIdQuery(""); setError(null) }
  }, [open])

  const set = (n: string, v: any) => setValues((s) => ({ ...s, [n]: v }))

  const audienceType = values.audienceType || "ALL"
  const options: { id: string; label: string; sub?: string }[] =
    audienceType === "BRANCH" ? (branches || []).map((b: any) => ({ id: b.id, label: b.name, sub: b.code })) :
    audienceType === "DEPARTMENT" ? (departments || []).map((d: any) => ({ id: d.id, label: d.name, sub: d.code })) :
    audienceType === "DESIGNATION" ? (designations || []).map((d: any) => ({ id: d.id, label: d.name, sub: d.grade })) :
    audienceType === "SPECIFIC" ? (employees || []).map((e: any) => ({ id: e.id, label: e.fullName, sub: e.code })) : []

  const filteredOptions = options.filter((o) =>
    !idQuery || o.label.toLowerCase().includes(idQuery.toLowerCase()) || (o.sub || "").toLowerCase().includes(idQuery.toLowerCase())
  )

  const toggleId = (id: string) => setIds((s) => s.includes(id) ? s.filter((x) => x !== id) : [...s, id])

  const submit = async () => {
    if (!values.title || !values.title.trim()) { setError("Title is required"); return }
    if (!values.body || !values.body.trim()) { setError("Body is required"); return }
    if (audienceType !== "ALL" && ids.length === 0) { setError("Select at least one audience target"); return }
    setBusy(true)
    setError(null)
    try {
      await rpc("announcements.create", {
        title: values.title, body: values.body,
        audienceType, audienceIds: audienceType === "ALL" ? [] : ids, pinned: !!values.pinned,
      })
      toast("Announcement published")
      onOpenChange(false)
    } catch (e: any) { setError(e.message) } finally { setBusy(false) }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !busy && onOpenChange(v)}>
      <DialogContent className="sm:max-w-xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-base">New Announcement</DialogTitle>
          <p className="text-xs text-slate-500">Targeted announcements notify employees in-app when published.</p>
        </DialogHeader>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 py-2">
          <div className="sm:col-span-2 space-y-1.5">
            <Label className="text-xs font-medium">Title <span className="text-rose-500">*</span></Label>
            <Input value={values.title || ""} onChange={(e) => set("title", e.target.value)} className="h-9" placeholder="e.g. Eid Holidays Announced" />
          </div>
          <div className="sm:col-span-2 space-y-1.5">
            <Label className="text-xs font-medium">Body <span className="text-rose-500">*</span></Label>
            <Textarea rows={4} value={values.body || ""} onChange={(e) => set("body", e.target.value)} placeholder="Write the announcement…" />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs font-medium">Audience</Label>
            <Select value={audienceType} onValueChange={(v) => { set("audienceType", v); setIds([]) }}>
              <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
              <SelectContent>{AUDIENCE_TYPES.map((a) => <SelectItem key={a.value} value={a.value}>{a.label}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div className="flex items-center gap-2 pt-1">
            <Switch id="pinned" checked={!!values.pinned} onCheckedChange={(c) => set("pinned", c)} />
            <Label htmlFor="pinned" className="text-xs font-medium">Pin to top</Label>
          </div>
          {audienceType !== "ALL" && (
            <div className="sm:col-span-2 space-y-1.5">
              <Label className="text-xs font-medium">
                Target {AUDIENCE_TYPES.find((a) => a.value === audienceType)?.label.replace("Specific ", "").toLowerCase()}
                {" "}({ids.length} selected) <span className="text-rose-500">*</span>
              </Label>
              {options.length > 6 && (
                <div className="relative">
                  <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-slate-400" />
                  <Input value={idQuery} onChange={(e) => setIdQuery(e.target.value)} placeholder="Filter…" className="pl-8 h-9 text-xs" />
                </div>
              )}
              <div className="border rounded-md p-2 max-h-48 overflow-y-auto space-y-1">
                {filteredOptions.map((o) => (
                  <label key={o.id} className="flex items-center gap-2 text-xs text-slate-700 dark:text-slate-300 rounded px-1.5 py-1 hover:bg-slate-50 dark:hover:bg-slate-800">
                    <Checkbox checked={ids.includes(o.id)} onCheckedChange={() => toggleId(o.id)} />
                    <span className="truncate">{o.label}</span>
                    {o.sub && <span className="ml-auto text-[10px] text-slate-500 dark:text-slate-400 shrink-0">{o.sub}</span>}
                  </label>
                ))}
                {filteredOptions.length === 0 && <p className="text-[11px] text-slate-500 dark:text-slate-400 py-2 text-center">No options{options.length === 0 ? " — loading…" : " match your filter"}.</p>}
              </div>
            </div>
          )}
        </div>
        {error && <p className="text-sm text-rose-600 bg-rose-50 rounded-md px-3 py-2">{error}</p>}
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
          <Button onClick={submit} disabled={busy}>
            <Send className="h-3.5 w-3.5 mr-1" /> {busy ? "Publishing…" : "Publish"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

"use client"
// ============ Letter Templates tab (shared: HR Settings → Templates) ============
// 2026-10 restructure — moved out of the "HR Letters" view (documents.tsx)
// into HR Settings → Templates → Letter Templates. Same data, same routes
// (templates.list / save / delete), same editor — relocated, not rewritten.
import { useEffect, useState } from "react"
import { Plus, Pencil, Trash2, Ban, Clock, Check, FileSignature } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Switch } from "@/components/ui/switch"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { useHrm } from "../store"
import { useApi, rpc } from "../api"
import { StatCard, titleCase } from "./ui-kit"
import { DataTable, type Column } from "./data-table"
import { ConfirmDialog } from "./form-dialog"

export const LETTER_TYPES = [
  "APPOINTMENT", "CONFIRMATION", "PROBATION_EXT", "SALARY_CERT", "EMPLOYMENT_CERT", "EXPERIENCE",
  "INCREMENT", "PROMOTION", "TRANSFER", "WARNING", "APPRECIATION", "SHOW_CAUSE", "SUSPENSION",
  "TERMINATION", "RESIGN_ACCEPT", "RELEASE", "RELIEVING", "NOC", "CUSTOM",
]

export const TEMPLATE_VARS = [
  "employee_name", "employee_id", "designation", "department", "branch", "joining_date", "salary",
  "basic_salary", "gross_salary", "manager_name", "effective_date", "company_name", "date",
  "probation_months", "employment_type",
]

export function LetterTemplatesTab() {
  const { can } = useHrm()
  const toast = useHrm((s) => s.toast)
  const { data, loading, error, reload } = useApi<any[]>("templates.list", {})
  const [open, setOpen] = useState(false)
  const [editRec, setEditRec] = useState<any>(null)
  const [delTarget, setDelTarget] = useState<any>(null)

  // visually grouped by type: server returns rows ordered by type — only the first row of each group shows the type label
  const rows = [...(data || [])].sort((a, b) => (a.type || "").localeCompare(b.type || ""))
  const firstIds = new Set<string>()
  let lastType = ""
  for (const t of rows) {
    if (t.type !== lastType) { firstIds.add(t.id); lastType = t.type }
  }

  const toggleActive = async (t: any) => {
    try {
      await rpc("templates.save", { id: t.id, active: t.active === false })
      toast(t.active === false ? "Template activated" : "Template deactivated")
      reload()
    } catch (e: any) {
      toast(e.message, "err")
    }
  }

  const columns: Column<any>[] = [
    {
      key: "type", label: "Type", sortValue: (t) => t.type,
      render: (t) => firstIds.has(t.id)
        ? <Badge variant="outline" className="text-[10px] font-semibold">{titleCase(t.type)}</Badge>
        : <span className="text-[10px] text-slate-300 dark:text-slate-600">〃</span>,
    },
    {
      key: "name", label: "Template", sortValue: (t) => t.name,
      render: (t) => (
        <div>
          <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">{t.name}</p>
          <p className="text-[11px] text-slate-500 dark:text-slate-400 truncate max-w-xs">{t.subject || "—"}</p>
        </div>
      ),
    },
    { key: "signatoryName", label: "Signatory", render: (t) => <span className="text-xs text-slate-600 dark:text-slate-300">{t.signatoryName || "Vendor default"}</span> },
    {
      key: "requiresApproval", label: "Approval Required",
      render: (t) => t.requiresApproval !== false
        ? <Badge className="bg-amber-100 text-amber-700 text-[10px]">Required</Badge>
        : <Badge className="bg-slate-100 text-slate-600 text-[10px]">Not required</Badge>,
    },
    { key: "active", label: "Active", render: (t) => <Badge className={t.active !== false ? "bg-emerald-100 text-emerald-700" : "bg-slate-200 text-slate-600"}>{t.active !== false ? "Active" : "Inactive"}</Badge> },
    {
      key: "actions", label: "", align: "right", render: (t) => can("letters", "edit") && (
        <div className="flex gap-1">
          <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => { setEditRec(t); setOpen(true) }}><Pencil className="h-3.5 w-3.5" /></Button>
          <Button size="icon" variant="ghost" className="h-7 w-7 text-slate-400 hover:text-amber-600" title={t.active !== false ? "Deactivate" : "Activate"} onClick={() => toggleActive(t)}>
            <Ban className="h-3.5 w-3.5" />
          </Button>
          <Button size="icon" variant="ghost" className="h-7 w-7 text-slate-400 hover:text-rose-600" onClick={() => setDelTarget(t)}><Trash2 className="h-3.5 w-3.5" /></Button>
        </div>
      ),
    },
  ]

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
        <StatCard label="Templates" value={rows.length} icon={FileSignature} tone="emerald" />
        <StatCard label="Approval Required" value={rows.filter((t) => t.requiresApproval !== false).length} icon={Clock} tone="amber" />
        <StatCard label="Active" value={rows.filter((t) => t.active !== false).length} icon={Check} tone="teal" />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-slate-500">Grouped by letter type — {LETTER_TYPES.length} supported types with {"{{variables}}"} rendered per employee.</p>
        {can("letters", "edit") && (
          <Button size="sm" onClick={() => { setEditRec(null); setOpen(true) }} className="h-8 ">
            <Plus className="h-3.5 w-3.5 mr-1" /> New Template
          </Button>
        )}
      </div>

      <DataTable columns={columns} rows={rows} loading={loading} error={error} csvName="letter-templates"
        searchPlaceholder="Search name, type, subject…" emptyTitle="No templates" emptyHint="Create a letter template with {{variables}} for employee data." />

      <TemplateDialog open={open} onOpenChange={(v) => { setOpen(v); if (!v) { setEditRec(null); reload() } }} template={editRec} onDone={reload} />

      <ConfirmDialog open={!!delTarget} onOpenChange={(v) => { if (!v) setDelTarget(null) }} title="Delete template"
        message={`Delete "${delTarget?.name}"? Blocked if letters have already been generated from it — deactivate instead.`} danger confirmLabel="Delete"
        onConfirm={async () => { await rpc("templates.delete", { id: delTarget.id }); reload() }} />
    </div>
  )
}

// ---------- Custom wide template editor (monospace body + variable help) ----------
function TemplateDialog({ open, onOpenChange, template, onDone }: {
  open: boolean; onOpenChange: (v: boolean) => void; template?: any; onDone: () => void
}) {
  const toast = useHrm((s) => s.toast)
  const [values, setValues] = useState<Record<string, any>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (open) {
      setValues(template ? {
        type: template.type, name: template.name, subject: template.subject || "",
        body: template.body || "", signatoryName: template.signatoryName || "",
        signatoryDesignation: template.signatoryDesignation || "",
        requiresApproval: template.requiresApproval !== false, active: template.active !== false,
      } : {
        type: "APPOINTMENT", name: "", subject: "", body: "", signatoryName: "", signatoryDesignation: "",
        requiresApproval: true, active: true,
      })
      setError(null)
    }
  }, [open, template])

  const set = (n: string, v: any) => setValues((s) => ({ ...s, [n]: v }))

  const insertVar = (v: string) => {
    setValues((s) => ({ ...s, body: (s.body || "") + `{{${v}}}` }))
  }

  const submit = async () => {
    if (!values.name?.trim()) { setError("Template name is required"); return }
    if (!values.subject?.trim()) { setError("Subject is required"); return }
    if (!values.body?.trim()) { setError("Body is required"); return }
    setBusy(true)
    try {
      await rpc("templates.save", {
        id: template?.id,
        type: values.type, name: values.name.trim(), subject: values.subject.trim(), body: values.body,
        signatoryName: values.signatoryName || undefined, signatoryDesignation: values.signatoryDesignation || undefined,
        requiresApproval: !!values.requiresApproval, active: !!values.active,
      })
      toast("Template saved")
      onOpenChange(false)
      onDone()
    } catch (e: any) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !busy && onOpenChange(v)}>
      <DialogContent className="sm:max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-base">{template ? `Edit Template — ${template.name}` : "New Letter Template"}</DialogTitle>
          <p className="text-xs text-slate-500">Use {"{{variables}}"} in the body — they are rendered from the employee record when a letter is generated.</p>
        </DialogHeader>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 py-2">
          <div className="space-y-1.5">
            <Label className="text-xs font-medium">Letter Type <span className="text-rose-500">*</span></Label>
            <Select value={values.type || "APPOINTMENT"} onValueChange={(v) => set("type", v)}>
              <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
              <SelectContent>
                {LETTER_TYPES.map((t) => <SelectItem key={t} value={t}>{titleCase(t)}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs font-medium">Template Name <span className="text-rose-500">*</span></Label>
            <Input value={values.name || ""} onChange={(e) => set("name", e.target.value)} className="h-9" placeholder="e.g. Standard Appointment Letter" />
          </div>
          <div className="sm:col-span-2 space-y-1.5">
            <Label className="text-xs font-medium">Subject <span className="text-rose-500">*</span></Label>
            <Input value={values.subject || ""} onChange={(e) => set("subject", e.target.value)} className="h-9" placeholder="Letter subject line" />
          </div>
          <div className="sm:col-span-2 space-y-1.5">
            <Label className="text-xs font-medium">Body <span className="text-rose-500">*</span></Label>
            <Textarea value={values.body || ""} onChange={(e) => set("body", e.target.value)} rows={12}
              className="font-mono text-xs leading-relaxed" placeholder={"Dear {{employee_name}},\n\nWe are pleased to…"} />
            <div className="rounded-lg border border-dashed border-slate-300 dark:border-slate-700 p-2.5">
              <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400 mb-1.5">Available variables — click to insert</p>
              <div className="flex flex-wrap gap-1.5">
                {TEMPLATE_VARS.map((v) => (
                  <button key={v} type="button" onClick={() => insertVar(v)}
                    className="rounded-md bg-slate-100 dark:bg-slate-800 px-1.5 py-0.5 font-mono text-[10px] text-slate-600 dark:text-slate-300 hover:bg-emerald-100 hover:text-emerald-700 dark:hover:bg-emerald-950 dark:hover:text-emerald-300 transition-colors">
                    {`{{${v}}}`}
                  </button>
                ))}
              </div>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs font-medium">Signatory Name</Label>
            <Input value={values.signatoryName || ""} onChange={(e) => set("signatoryName", e.target.value)} className="h-9" placeholder="Defaults to vendor name" />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs font-medium">Signatory Designation</Label>
            <Input value={values.signatoryDesignation || ""} onChange={(e) => set("signatoryDesignation", e.target.value)} className="h-9" placeholder="e.g. Managing Director" />
          </div>
          <div className="flex items-center gap-2 pt-1">
            <Switch id="tpl-approval" checked={!!values.requiresApproval} onCheckedChange={(c) => set("requiresApproval", c)} className="data-[state=checked]:bg-primary" />
            <Label htmlFor="tpl-approval" className="text-xs font-medium text-slate-600 dark:text-slate-300">Approval required before issuing</Label>
          </div>
          <div className="flex items-center gap-2 pt-1">
            <Switch id="tpl-active" checked={!!values.active} onCheckedChange={(c) => set("active", c)} className="data-[state=checked]:bg-primary" />
            <Label htmlFor="tpl-active" className="text-xs font-medium text-slate-600 dark:text-slate-300">Active (available for generation)</Label>
          </div>
        </div>

        {error && <p className="text-sm text-rose-600 bg-rose-50 dark:bg-rose-950 rounded-md px-3 py-2">{error}</p>}
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
          <Button onClick={submit} disabled={busy}>{busy ? "Saving…" : "Save Template"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

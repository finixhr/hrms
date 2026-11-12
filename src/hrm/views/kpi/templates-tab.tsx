"use client"
// ============ KPI Templates tab (2026-11 redesign) ============
// Company → Department → Template → Indicators. ONE template per
// (company, department). Built-in indicators come from the system registry
// (live Finix HR data); custom indicators are administrator-defined.
import { useEffect, useMemo, useState } from "react"
import {
  Building2, Plus, Pencil, Trash2, Layers, ShieldCheck, Eye, Power, Users, Target, Sparkles, ArrowLeft, ArrowRight, Save,
} from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Checkbox } from "@/components/ui/checkbox"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { useHrm } from "../../store"
import { useApi, rpc } from "../../api"
import { SectionCard, EmptyState, fmtDate } from "../../shared/ui-kit"
import { ConfirmDialog } from "../../shared/form-dialog"
import { DataTable, type Column } from "../../shared/data-table"
import { DIRECTION_OPTIONS, UNIT_OPTIONS, directionShort, unitLabel, SourceBadge } from "./shared"

type WizardIndicator = {
  key: string // local row key
  indicatorId?: string // template indicator id (edit mode)
  name: string
  description: string
  builtinKey: string | null
  unit: string
  unitLabel: string
  direction: string
  weight: number | string
  targetValue: number | string
}

export default function KpiTemplatesTab() {
  const { can, activeCompanyId, allCompaniesMode } = useHrm()
  const { data, loading, error, reload } = useApi<any[]>("kpi.templates.list", {})
  const { data: departments } = useApi<any[]>("departments.list", {})
  const { data: deptSummary } = useApi<any[]>("kpi.templates.departmentSummary", {})
  const [wizardOpen, setWizardOpen] = useState(false)
  const [editRec, setEditRec] = useState<any>(null)
  const [detail, setDetail] = useState<any>(null)
  const [delTarget, setDelTarget] = useState<any>(null)

  const rows = data || []
  const columns: Column<any>[] = [
    {
      key: "name", label: "Template", sortValue: (t) => t.name,
      render: (t) => (
        <div>
          <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">{t.name}</p>
          <p className="text-[11px] text-slate-500 dark:text-slate-400">{(t.indicators || []).length} indicator{(t.indicators || []).length === 1 ? "" : "s"} · {t.periodType?.toLowerCase()}</p>
        </div>
      ),
    },
    {
      key: "departmentName", label: "Department", sortValue: (t) => t.departmentName || "",
      render: (t) => t.departmentName
        ? <Badge variant="outline" className="text-[10px]">{t.departmentName}</Badge>
        : <Badge variant="outline" className="text-[10px] text-amber-700 border-amber-200">Legacy — no department</Badge>,
    },
    {
      key: "sources", label: "Indicators", render: (t) => {
        const inds = t.indicators || []
        const builtins = inds.filter((i: any) => i.source === "BUILTIN").length
        return (
          <span className="inline-flex items-center gap-1.5 text-xs text-slate-600 dark:text-slate-300">
            <Layers className="h-3.5 w-3.5 text-violet-500" /> {builtins} built-in
            <span className="text-slate-300">·</span> {inds.length - builtins} custom
          </span>
        )
      },
    },
    {
      key: "weight", label: "Weight", align: "right", render: (t) => {
        const total = (t.indicators || []).reduce((s: number, i: any) => s + (Number(i.weight) || 0), 0)
        return <Badge className={`${Math.round(total) === 100 ? "bg-emerald-100 text-emerald-700" : "bg-amber-100 text-amber-700"} text-[10px] tabular-nums`}>{Math.round(total * 100) / 100}%</Badge>
      },
    },
    { key: "assignmentCount", label: "Assignments", align: "right", sortValue: (t) => t.assignmentCount || 0, render: (t) => <span className="text-xs tabular-nums text-slate-600 dark:text-slate-300">{t.assignmentCount ?? 0}</span> },
    { key: "active", label: "Status", render: (t) => <Badge className={t.active ? "bg-emerald-100 text-emerald-700" : "bg-slate-200 text-slate-600"}>{t.active ? "Active" : "Inactive"}</Badge> },
    {
      key: "actions", label: "", align: "right", exportable: false, render: (t) => (
        <div className="flex gap-1" onClick={(e) => e.stopPropagation()}>
          <Button size="icon" variant="ghost" className="h-7 w-7" title="View details" onClick={() => setDetail(t)}><Eye className="h-3.5 w-3.5" /></Button>
          {can("kpi", "edit") && (
            <Button size="icon" variant="ghost" className="h-7 w-7" title={t.active ? "Deactivate" : "Activate"}
              onClick={async () => { await rpc("kpi.templates.setStatus", { id: t.id, active: !t.active }); reload() }}>
              <Power className={`h-3.5 w-3.5 ${t.active ? "text-amber-500" : "text-emerald-500"}`} />
            </Button>
          )}
          {can("kpi", "edit") && (
            <Button size="icon" variant="ghost" className="h-7 w-7" title="Edit" onClick={() => { setEditRec(t); setWizardOpen(true) }}><Pencil className="h-3.5 w-3.5" /></Button>
          )}
          {can("kpi", "delete") && (
            <Button size="icon" variant="ghost" className="h-7 w-7 text-slate-400 hover:text-rose-600" title="Delete / archive" onClick={() => setDelTarget(t)}><Trash2 className="h-3.5 w-3.5" /></Button>
          )}
        </div>
      ),
    },
  ]

  const deptsWithoutTemplate = (deptSummary || []).filter((d: any) => !d.template && d.eligibleEmployees > 0)

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-slate-500 flex items-center gap-1">
          <ShieldCheck className="h-3.5 w-3.5 text-emerald-600" />
          One KPI template per Company + Department · indicator weights must total exactly 100% · editing a template never changes existing assignments (they hold historical snapshots).
        </p>
        {can("kpi", "create") && !allCompaniesMode && (
          <Button size="sm" onClick={() => { setEditRec(null); setWizardOpen(true) }} className="h-8" disabled={!activeCompanyId}>
            <Plus className="h-3.5 w-3.5 mr-1" /> New Template
          </Button>
        )}
      </div>

      {deptsWithoutTemplate.length > 0 && (
        <SectionCard title="Departments without a KPI template" description="Create a Company + Department template to make these employees eligible for KPI assignment.">
          <div className="flex flex-wrap gap-1.5">
            {deptsWithoutTemplate.map((d: any) => (
              <Badge key={d.departmentId} variant="outline" className="text-[10px] gap-1 py-1">
                <Building2 className="h-3 w-3 text-slate-400" /> {d.departmentName}
                <span className="text-slate-400">· {d.eligibleEmployees} employees</span>
              </Badge>
            ))}
          </div>
        </SectionCard>
      )}

      <DataTable columns={columns} rows={rows} loading={loading} error={error} csvName="kpi-templates"
        searchPlaceholder="Search template or department…" onRowClick={(t) => setDetail(t)}
        emptyTitle="No KPI templates" emptyHint={allCompaniesMode ? "Switch to a specific company to create templates (All Companies is read-only)." : "Create a Company + Department KPI template to begin."} />

      <TemplateWizard open={wizardOpen} onOpenChange={(v) => { setWizardOpen(v); if (!v) { setEditRec(null); reload() } }}
        template={editRec} departments={departments || []} deptSummary={deptSummary || []} />

      <TemplateDetailDialog open={!!detail} onOpenChange={(v) => { if (!v) setDetail(null) }} template={detail}
        onEdit={() => { setEditRec(detail); setDetail(null); setWizardOpen(true) }} />

      <ConfirmDialog open={!!delTarget} onOpenChange={(v) => { if (!v) setDelTarget(null) }}
        title="Delete KPI template"
        message={delTarget?.assignmentCount
          ? `"${delTarget?.name}" has ${delTarget.assignmentCount} historical assignment(s). It will be ARCHIVED (soft-deleted) — assignments and their history are preserved.`
          : `Delete "${delTarget?.name}"? It has no assignments.`}
        danger confirmLabel={delTarget?.assignmentCount ? "Archive" : "Delete"}
        onConfirm={async () => { await rpc("kpi.templates.delete", { id: delTarget.id, confirm: "DELETE" }); reload() }} />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Template wizard — department → info → built-in → custom → weights review
// ---------------------------------------------------------------------------

const WIZARD_STEPS = [
  { title: "Department & Info", hint: "Company + Department + template basics" },
  { title: "Built-in Indicators", hint: "Live system metrics from Finix HR modules" },
  { title: "Custom Indicators", hint: "Administrator-defined metrics" },
  { title: "Weights & Review", hint: "Weights must total 100% — then save" },
]

function TemplateWizard({ open, onOpenChange, template, departments, deptSummary }: {
  open: boolean; onOpenChange: (v: boolean) => void; template?: any; departments: any[]; deptSummary: any[]
}) {
  const toast = useHrm((s) => s.toast)
  const { data: builtins } = useApi<any[]>("kpi.builtinIndicators", {})
  const [step, setStep] = useState(0)
  const [name, setName] = useState("")
  const [description, setDescription] = useState("")
  const [periodType, setPeriodType] = useState("MONTHLY")
  const [departmentId, setDepartmentId] = useState("")
  const [inds, setInds] = useState<WizardIndicator[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (open) {
      setStep(0)
      setError(null)
      setName(template?.name || "")
      setDescription(template?.description || "")
      setPeriodType(template?.periodType || "MONTHLY")
      setDepartmentId(template?.departmentId || "")
      setInds((template?.indicators || []).map((i: any, idx: number) => ({
        key: `t-${i.id}-${idx}`,
        indicatorId: i.id,
        name: i.name,
        description: i.description || "",
        builtinKey: i.builtinKey,
        unit: i.unit,
        unitLabel: i.unitLabel || "",
        direction: i.direction,
        weight: i.weight,
        targetValue: i.defaultTarget ?? "",
      })))
    }
     
  }, [open, template])

  const totalWeight = useMemo(() => inds.reduce((s, i) => s + (Number(i.weight) || 0), 0), [inds])
  const occupied = useMemo(() => {
    const target = departments.find((d) => d.id === departmentId)
    if (!target) return null
    const existing = (deptSummary || []).find((s: any) => s.departmentId === departmentId && s.template && s.template.id !== template?.id)
    return existing?.template || null
  }, [departmentId, deptSummary, departments, template])

  const addBuiltin = (b: any) => {
    setInds((arr) => arr.some((i) => i.builtinKey === b.key) ? arr : [...arr, {
      key: `b-${b.key}-${Date.now()}`,
      name: b.label,
      description: b.description,
      builtinKey: b.key,
      unit: b.unit,
      unitLabel: "",
      direction: b.direction,
      weight: "",
      targetValue: b.defaultTarget,
    }])
  }

  const stepValid = (i: number): boolean => {
    if (i === 0) return !!name.trim() && !!departmentId && (!occupied)
    if (i === 1 || i === 2) return true
    if (i === 3) return inds.length > 0 && Math.round(totalWeight * 100) === 10000
    return true
  }

  const submit = async () => {
    setBusy(true)
    setError(null)
    try {
      await rpc(template ? "kpi.templates.update" : "kpi.templates.create", {
        id: template?.id,
        departmentId,
        name: name.trim(),
        description: description.trim() || null,
        periodType,
        indicators: inds.map((i, idx) => ({
          indicatorId: i.indicatorId || null,
          name: i.name.trim(),
          description: i.description.trim() || null,
          builtinKey: i.builtinKey,
          unit: i.unit,
          unitLabel: i.unit === "CUSTOM" ? i.unitLabel.trim() || null : null,
          direction: i.direction,
          weight: Number(i.weight) || 0,
          targetValue: i.targetValue === "" ? null : Number(i.targetValue),
          sortOrder: idx + 1,
        })),
      })
      toast(template ? "KPI template updated" : "KPI template created")
      onOpenChange(false)
    } catch (e: any) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  const setInd = (key: string, patch: Partial<WizardIndicator>) => setInds((arr) => arr.map((i) => (i.key === key ? { ...i, ...patch } : i)))
  const builtinInds = inds.filter((i) => i.builtinKey)
  const customInds = inds.filter((i) => !i.builtinKey)

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!busy) onOpenChange(v) }}>
      <DialogContent className="sm:max-w-4xl max-h-[92vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-base">{template ? `Edit KPI Template — ${template.name}` : "New KPI Template"}</DialogTitle>
          <div className="flex items-center gap-1.5 pt-1">
            {WIZARD_STEPS.map((s, i) => (
              <button key={s.title} type="button" disabled={i > step} onClick={() => i < step && setStep(i)}
                className={`flex-1 text-left rounded-md px-2 py-1.5 transition ${i === step ? "bg-emerald-50 dark:bg-emerald-950/50 border border-emerald-200 dark:border-emerald-900" : i < step ? "hover:bg-slate-50 dark:hover:bg-slate-800" : "opacity-50"}`}>
                <div className="flex items-center gap-1.5">
                  <span className={`h-4 w-4 rounded-full text-[9px] font-bold flex items-center justify-center ${i <= step ? "bg-emerald-500 text-white" : "bg-slate-200 text-slate-500"}`}>{i + 1}</span>
                  <span className={`text-[11px] font-semibold ${i === step ? "text-emerald-700 dark:text-emerald-300" : "text-slate-500"}`}>{s.title}</span>
                </div>
              </button>
            ))}
          </div>
          <p className="text-[11px] text-slate-500">{WIZARD_STEPS[step].hint}</p>
        </DialogHeader>

        {step === 0 && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 py-2">
            <div className="space-y-1.5">
              <Label className="text-xs font-medium">Department <span className="text-rose-500">*</span></Label>
              <Select value={departmentId || "none"} onValueChange={(v) => setDepartmentId(v === "none" ? "" : v)}>
                <SelectTrigger className="h-9"><SelectValue placeholder="Select department" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none" disabled>Select department…</SelectItem>
                  {departments.map((d: any) => (
                    <SelectItem key={d.id} value={d.id}>{d.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {occupied && (
                <p className="text-[11px] text-amber-600 bg-amber-50 dark:bg-amber-950/40 rounded-md px-2 py-1.5">
                  ⚠ This department already has the template <b>{occupied.name}</b> — only ONE template is allowed per Company + Department. {occupied.active ? "" : "It is currently inactive — reactivate it instead."}
                </p>
              )}
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs font-medium">Template Name <span className="text-rose-500">*</span></Label>
              <Input value={name} onChange={(e) => setName(e.target.value)} className="h-9" placeholder="e.g. Engineering KPI" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs font-medium">Default Period Type</Label>
              <Select value={periodType} onValueChange={setPeriodType}>
                <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="MONTHLY">Monthly</SelectItem>
                  <SelectItem value="QUARTERLY">Quarterly</SelectItem>
                  <SelectItem value="YEARLY">Yearly</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <Label className="text-xs font-medium">Description</Label>
              <Textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What this template measures and any policy notes" />
            </div>
          </div>
        )}

        {step === 1 && (
          <div className="space-y-2 py-2">
            <p className="text-xs text-slate-500 flex items-center gap-1"><Sparkles className="h-3.5 w-3.5 text-violet-500" /> Built-in indicators retrieve live data from Finix HR modules (Attendance, Leave, Field Force). Actual values are computed automatically at achievement time.</p>
            {(builtins || []).map((b: any) => {
              const selected = builtinInds.some((i) => i.builtinKey === b.key)
              const row = builtinInds.find((i) => i.builtinKey === b.key)
              return (
                <div key={b.key} className={`rounded-xl border p-3 transition ${selected ? "border-emerald-300 dark:border-emerald-800 bg-emerald-50/40 dark:bg-emerald-950/20" : "border-slate-200 dark:border-slate-800"}`}>
                  <div className="flex items-start gap-3">
                    <Checkbox checked={selected} onCheckedChange={(v) => {
                      if (v) addBuiltin(b)
                      else setInds((arr) => arr.filter((i) => i.builtinKey !== b.key))
                    }} className="mt-0.5" />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-slate-800 dark:text-slate-100">{b.label}</p>
                      <p className="text-[11px] text-slate-500 dark:text-slate-400">{b.description}</p>
                      {selected && row && (
                        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mt-2">
                          <div>
                            <Label className="text-[10px] text-slate-400">Default target</Label>
                            <Input className="h-8 text-xs tabular-nums" type="number" value={row.targetValue} onChange={(e) => setInd(row.key, { targetValue: e.target.value })} />
                          </div>
                          <div>
                            <Label className="text-[10px] text-slate-400">Weight %</Label>
                            <Input className="h-8 text-xs tabular-nums" type="number" value={row.weight} onChange={(e) => setInd(row.key, { weight: e.target.value })} />
                          </div>
                          <div>
                            <Label className="text-[10px] text-slate-400">Direction</Label>
                            <div className="h-8 flex items-center text-xs text-slate-600 dark:text-slate-300">{directionShort(row.direction)}</div>
                          </div>
                          <div>
                            <Label className="text-[10px] text-slate-400">Unit</Label>
                            <div className="h-8 flex items-center text-xs text-slate-600 dark:text-slate-300">{unitLabel(row.unit)}</div>
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        )}

        {step === 2 && (
          <div className="space-y-2 py-2">
            <div className="flex items-center justify-between">
              <p className="text-xs text-slate-500">Administrator-defined metrics — name, unit, direction, default target and weight.</p>
              <Button size="sm" variant="outline" className="h-8 text-xs" onClick={() => setInds((arr) => [...arr, {
                key: `c-${Date.now()}`, name: "", description: "", builtinKey: null, unit: "NUMBER", unitLabel: "", direction: "HIGHER_IS_BETTER", weight: "", targetValue: "",
              }])}><Plus className="h-3.5 w-3.5 mr-1" /> Add Custom Indicator</Button>
            </div>
            {customInds.length === 0 && <EmptyState icon={Target} title="No custom indicators" hint="Built-in indicators may be enough — add customs only for metrics outside Finix HR data." />}
            {customInds.map((i) => (
              <div key={i.key} className="rounded-xl border border-slate-200 dark:border-slate-800 p-3 space-y-2">
                <div className="grid grid-cols-1 sm:grid-cols-12 gap-2">
                  <div className="sm:col-span-5">
                    <Label className="text-[10px] text-slate-400">Indicator name *</Label>
                    <Input className="h-8 text-xs" value={i.name} onChange={(e) => setInd(i.key, { name: e.target.value })} placeholder="e.g. Task Completion" />
                  </div>
                  <div className="sm:col-span-3">
                    <Label className="text-[10px] text-slate-400">Measurement unit</Label>
                    <Select value={i.unit} onValueChange={(v) => setInd(i.key, { unit: v })}>
                      <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                      <SelectContent>{UNIT_OPTIONS.map((u) => <SelectItem key={u.value} value={u.value}>{u.label}</SelectItem>)}</SelectContent>
                    </Select>
                  </div>
                  {i.unit === "CUSTOM" && (
                    <div className="sm:col-span-2">
                      <Label className="text-[10px] text-slate-400">Custom unit label</Label>
                      <Input className="h-8 text-xs" value={i.unitLabel} onChange={(e) => setInd(i.key, { unitLabel: e.target.value })} placeholder="e.g. tickets" />
                    </div>
                  )}
                  <div className="sm:col-span-3">
                    <Label className="text-[10px] text-slate-400">Target direction</Label>
                    <Select value={i.direction} onValueChange={(v) => setInd(i.key, { direction: v })}>
                      <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                      <SelectContent>{DIRECTION_OPTIONS.map((d) => <SelectItem key={d.value} value={d.value}>{d.label}</SelectItem>)}</SelectContent>
                    </Select>
                  </div>
                  <div className="sm:col-span-2">
                    <Label className="text-[10px] text-slate-400">Default target</Label>
                    <Input className="h-8 text-xs tabular-nums" type="number" value={i.targetValue} onChange={(e) => setInd(i.key, { targetValue: e.target.value })} />
                  </div>
                  <div className="sm:col-span-2">
                    <Label className="text-[10px] text-slate-400">Weight %</Label>
                    <Input className="h-8 text-xs tabular-nums" type="number" value={i.weight} onChange={(e) => setInd(i.key, { weight: e.target.value })} />
                  </div>
                  <div className="sm:col-span-1 flex items-end">
                    <Button size="icon" variant="ghost" className="h-8 w-8 text-slate-400 hover:text-rose-600" onClick={() => setInds((arr) => arr.filter((x) => x.key !== i.key))}><Trash2 className="h-3.5 w-3.5" /></Button>
                  </div>
                </div>
                <Input className="h-8 text-xs" value={i.description} onChange={(e) => setInd(i.key, { description: e.target.value })} placeholder="Description / calculation method (optional)" />
              </div>
            ))}
          </div>
        )}

        {step === 3 && (
          <div className="space-y-3 py-2">
            <div className="rounded-xl border overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-slate-50 dark:bg-slate-800/60 text-[10px] uppercase tracking-wide text-slate-400">
                    <th className="text-left font-semibold px-3 py-2">Indicator</th>
                    <th className="text-left font-semibold px-3 py-2">Type</th>
                    <th className="text-left font-semibold px-3 py-2">Unit</th>
                    <th className="text-left font-semibold px-3 py-2">Direction</th>
                    <th className="text-right font-semibold px-3 py-2">Default Target</th>
                    <th className="text-right font-semibold px-3 py-2 w-28">Weight %</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {inds.map((i) => (
                    <tr key={i.key}>
                      <td className="px-3 py-2 text-sm font-medium text-slate-800 dark:text-slate-100">{i.name || <span className="text-slate-400 italic">unnamed</span>}</td>
                      <td className="px-3 py-2"><SourceBadge source={i.builtinKey ? "BUILTIN" : "CUSTOM"} /></td>
                      <td className="px-3 py-2 text-xs text-slate-500">{unitLabel(i.unit, i.unitLabel) || i.unit}</td>
                      <td className="px-3 py-2 text-xs text-slate-500">{directionShort(i.direction)}</td>
                      <td className="px-3 py-2 text-right text-xs tabular-nums text-slate-600 dark:text-slate-300">{i.targetValue === "" ? "—" : i.targetValue}</td>
                      <td className="px-3 py-2 text-right">
                        <Input className="h-7 w-24 text-xs tabular-nums ml-auto" type="number" value={i.weight} onChange={(e) => setInd(i.key, { weight: e.target.value })} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="flex items-center justify-between">
              <Badge className={`${Math.round(totalWeight * 100) === 10000 ? "bg-emerald-100 text-emerald-700" : "bg-amber-100 text-amber-700"} text-[10px] tabular-nums`}>
                Total weight: {Math.round(totalWeight * 100) / 100}% {Math.round(totalWeight * 100) === 10000 ? "✓" : "— must equal 100"}
              </Badge>
              {inds.length > 0 && Math.round(totalWeight * 100) !== 10000 && (
                <Button size="sm" variant="outline" className="h-8 text-xs"
                  onClick={() => {
                    const w = Math.round((100 / inds.length) * 100) / 100
                    setInds((arr) => arr.map((i) => ({ ...i, weight: w })))
                  }}>
                  Distribute evenly
                </Button>
              )}
            </div>
          </div>
        )}

        {error && <p className="text-sm text-rose-600 bg-rose-50 dark:bg-rose-950 rounded-md px-3 py-2">{error}</p>}
        <DialogFooter className="gap-2 sm:justify-between">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
          <div className="flex gap-2">
            {step > 0 && <Button variant="outline" onClick={() => setStep(step - 1)} disabled={busy}><ArrowLeft className="h-3.5 w-3.5 mr-1" /> Back</Button>}
            {step < WIZARD_STEPS.length - 1 && (
              <Button onClick={() => setStep(step + 1)} disabled={!stepValid(step) || (step === 0 && !!occupied)}>
                Next <ArrowRight className="h-3.5 w-3.5 ml-1" />
              </Button>
            )}
            {step === WIZARD_STEPS.length - 1 && (
              <Button onClick={submit} disabled={busy || !stepValid(step)}>
                {busy ? "Saving…" : <><Save className="h-3.5 w-3.5 mr-1" /> {template ? "Save Changes" : "Create Template"}</>}
              </Button>
            )}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------
// Template detail dialog
// ---------------------------------------------------------------------------

function TemplateDetailDialog({ open, onOpenChange, template, onEdit }: {
  open: boolean; onOpenChange: (v: boolean) => void; template: any; onEdit: () => void
}) {
  const { can } = useHrm()
  if (!template) return null
  const inds = template.indicators || []
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-base flex items-center gap-2">
            {template.name}
            <Badge className={template.active ? "bg-emerald-100 text-emerald-700" : "bg-slate-200 text-slate-600"}>{template.active ? "Active" : "Inactive"}</Badge>
          </DialogTitle>
          <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
            {template.departmentName && <Badge variant="outline" className="text-[10px]">{template.departmentName}</Badge>}
            <span>period: {template.periodType?.toLowerCase()}</span>
            <span>· {inds.length} indicator(s)</span>
            <span>· {template.assignmentCount} assignment(s)</span>
            <span>· created {fmtDate(template.createdAt)}</span>
          </div>
        </DialogHeader>
        {template.description && <p className="text-sm text-slate-600 dark:text-slate-300 rounded-lg bg-slate-50 dark:bg-slate-800/60 p-3">{template.description}</p>}
        <div className="rounded-xl border overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-slate-50 dark:bg-slate-800/60 text-[10px] uppercase tracking-wide text-slate-400">
                <th className="text-left font-semibold px-3 py-2">Indicator</th>
                <th className="text-left font-semibold px-3 py-2">Type</th>
                <th className="text-left font-semibold px-3 py-2">Unit</th>
                <th className="text-left font-semibold px-3 py-2">Direction</th>
                <th className="text-right font-semibold px-3 py-2">Default Target</th>
                <th className="text-right font-semibold px-3 py-2">Weight</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {inds.map((i: any) => (
                <tr key={i.id}>
                  <td className="px-3 py-2">
                    <p className="text-sm font-medium text-slate-800 dark:text-slate-100">{i.name}</p>
                    {i.description && <p className="text-[10px] text-slate-500 dark:text-slate-400">{i.description}</p>}
                  </td>
                  <td className="px-3 py-2"><SourceBadge source={i.source} /></td>
                  <td className="px-3 py-2 text-xs text-slate-500">{unitLabel(i.unit, i.unitLabel) || i.unit}</td>
                  <td className="px-3 py-2 text-xs text-slate-500">{directionShort(i.direction)}</td>
                  <td className="px-3 py-2 text-right text-xs tabular-nums text-slate-600 dark:text-slate-300">{i.defaultTarget ?? "—"}</td>
                  <td className="px-3 py-2 text-right text-xs tabular-nums text-slate-600 dark:text-slate-300">{i.weight}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <DialogFooter className="gap-2 sm:justify-between">
          <p className="text-[11px] text-slate-500 flex items-center gap-1"><Users className="h-3 w-3" /> Employees of this department become eligible for KPI assignment — targets are assigned per period, never automatically.</p>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)}>Close</Button>
            {can("kpi", "edit") && <Button onClick={onEdit}><Pencil className="h-3.5 w-3.5 mr-1" /> Edit</Button>}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

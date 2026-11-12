"use client"
// ============ KPI Target Assignments tab (2026-11 redesign) ============
// Dashboard cards → single employee assignment (auto-loads the department
// template with per-employee target overrides) → bulk Excel assignment
// (download dynamic template → upload → validated preview → submit → batch
// approval). Server-side pagination for large organizations.
import { useEffect, useMemo, useState } from "react"
import {
  Users, UserPlus, Upload, ShieldCheck, Pencil, Ban, FileSpreadsheet, ArrowLeft, ArrowRight, Download,
  CheckCircle2, XCircle, Layers, History, ChevronRight, ChevronDown, Eye,
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
import { rpc, useApi, useLookup } from "../../api"
import { StatCard, StatusBadge, EmptyState, ErrorBanner, fmtDate, fmtDateTime, KV } from "../../shared/ui-kit"
import { ConfirmDialog } from "../../shared/form-dialog"
import { DataTable, type Column } from "../../shared/data-table"
import { useServerPagedList, PagedControls } from "../../server-paged"
import {
  ApprovalActions, PeriodPicker, SourceBadge, fmtPeriod, fmtStatus, downloadBase64File,
  downloadErrorReport, readFileAsBase64, unitLabel, directionShort,
} from "./shared"

const TARGET_STATUS_OPTIONS = [
  { value: "PENDING_APPROVAL", label: "Pending Approval" },
  { value: "APPROVED", label: "Approved" },
  { value: "REJECTED", label: "Rejected" },
  { value: "CHANGES_REQUESTED", label: "Changes Requested" },
  { value: "DRAFT", label: "Draft" },
  { value: "CANCELLED", label: "Cancelled" },
]

export default function KpiTargetsTab() {
  const { can } = useHrm()
  const toast = useHrm((s) => s.toast)
  const [departmentId, setDepartmentId] = useState("")
  const [periodLabel, setPeriodLabel] = useState(() => `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, "0")}`)
  const [status, setStatus] = useState("")
  const [search, setSearch] = useState("")
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [approvingAll, setApprovingAll] = useState(false)
  const [bulkActionBusy, setBulkActionBusy] = useState(false)
  const [reasonDialog, setReasonDialog] = useState<{ decision: "REQUEST_CHANGES" | "REJECT"; reason: string } | null>(null)
  const [pageSize, setPageSize] = useState(25)
  const { data: departments } = useLookup<any[]>("departments.list", {})
  const filters = useMemo(() => ({
    departmentId: departmentId || undefined,
    periodLabel: periodLabel || undefined,
    status: status || undefined,
    q: search || undefined,
  }), [departmentId, periodLabel, status, search])
  const { data: summary, reload: reloadSummary } = useApi<any>("kpi.targets.summary", { departmentId: departmentId || undefined, periodLabel: periodLabel || undefined })
  const { rows, total, page, maxPage, loading, error, reload, setPage } = useServerPagedList<any>("kpi.targets.list", filters, pageSize)
  const [assignOpen, setAssignOpen] = useState(false)
  const [bulkOpen, setBulkOpen] = useState(false)
  const [batchesOpen, setBatchesOpen] = useState(false)
  const [detailId, setDetailId] = useState<string | null>(null)

  // Reset selection when rows change (page / filter change)
  useEffect(() => { setSelected(new Set()) }, [rows])

  const allPendingIds = rows.filter((r: any) => r.status === "PENDING_APPROVAL").map((r: any) => r.id)
  const allChecked = allPendingIds.length > 0 && allPendingIds.every((id: string) => selected.has(id))
  const someChecked = allPendingIds.some((id: string) => selected.has(id))

  const toggleRow = (id: string) => setSelected(prev => {
    const next = new Set(prev)
    next.has(id) ? next.delete(id) : next.add(id)
    return next
  })
  const toggleAll = () => setSelected(allChecked
    ? new Set([...selected].filter(id => !allPendingIds.includes(id)))
    : new Set([...selected, ...allPendingIds])
  )

  const approveSelected = async () => {
    if (!selected.size || approvingAll) return
    setApprovingAll(true)
    try {
      let done = 0
      for (const id of selected) {
        try { await rpc("kpi.targets.decide", { id, decision: "APPROVE" }); done++ } catch { /* skip */ }
      }
      toast(`Approved ${done} of ${selected.size} target(s)`)
      setSelected(new Set())
      reload(); reloadSummary()
    } finally { setApprovingAll(false) }
  }

  const bulkDecide = async (decision: "REQUEST_CHANGES" | "REJECT", comment: string) => {
    if (!selected.size || bulkActionBusy) return
    setBulkActionBusy(true)
    try {
      let done = 0
      for (const id of selected) {
        try { await rpc("kpi.targets.decide", { id, decision, comment }); done++ } catch { /* skip */ }
      }
      const label = decision === "REJECT" ? "Rejected" : "Changes requested for"
      toast(`${label} ${done} of ${selected.size} target(s)`)
      setSelected(new Set())
      setReasonDialog(null)
      reload(); reloadSummary()
    } finally { setBulkActionBusy(false) }
  }

  const columns: Column<any>[] = [
    {
      key: "_sel", label: "",
      header: () => can("kpi", "approve") ? (
        <Checkbox
          checked={allChecked ? true : someChecked ? "indeterminate" : false}
          onCheckedChange={toggleAll}
          aria-label="Select all pending"
          onClick={(e) => e.stopPropagation()}
        />
      ) : null,
      render: (r) => r.status === "PENDING_APPROVAL" && can("kpi", "approve") ? (
        <Checkbox
          checked={selected.has(r.id)}
          onCheckedChange={() => toggleRow(r.id)}
          aria-label="Select row"
          onClick={(e) => e.stopPropagation()}
        />
      ) : null,
    },
    {
      key: "employeeName", label: "Employee", sortValue: (r) => r.employeeName,
      render: (r) => (
        <div>
          <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">{r.employeeName}</p>
          <p className="text-[11px] text-slate-500 dark:text-slate-400">{r.employeeCode} · {r.departmentName || "—"}</p>
        </div>
      ),
    },
    { key: "periodLabel", label: "Period", render: (r) => <Badge variant="outline" className="text-[10px] tabular-nums">{fmtPeriod(r.periodLabel, r.periodStart, r.periodEnd)}</Badge> },
    {
      key: "dueDate", label: "Due Date", sortValue: (r) => r.dueDate || "",
      render: (r) => {
        const past = r.dueDate && new Date(r.dueDate) < new Date() && ["PENDING_APPROVAL", "DRAFT"].includes(r.status)
        return <span className={`text-xs ${past ? "text-rose-600 font-medium" : "text-slate-500"}`}>{r.dueDate ? fmtDate(r.dueDate) : "—"}</span>
      },
    },
    {
      key: "indicators", label: "Indicators & Target", render: (r) => (
        <div className="flex flex-wrap gap-1 max-w-md">
          {(r.indicators || []).slice(0, 4).map((i: any) => (
            <Badge key={i.id} variant="outline" className="text-[9px] tabular-nums gap-1">
              {i.name}: <b>{i.targetValue ?? "—"}{unitLabel(i.unit, i.unitLabel)}</b>
            </Badge>
          ))}
          {(r.indicators || []).length > 4 && <Badge variant="outline" className="text-[9px]">+{r.indicators.length - 4} more</Badge>}
          {!(r.indicators || []).length && <span className="text-xs text-slate-400">—</span>}
        </div>
      ),
    },
    { key: "status", label: "Status", render: (r) => <StatusBadge status={r.status} /> },
    { key: "revision", label: "Rev.", align: "center", render: (r) => <span className="text-[11px] text-slate-400 tabular-nums">{r.revision > 1 ? `v${r.revision}` : ""}</span> },
  ]

  return (
    <div className="space-y-4">
      {/* filters + actions — above the summary cards */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="w-full sm:w-52">
          <Select value={departmentId || "all"} onValueChange={(v) => setDepartmentId(v === "all" ? "" : v)}>
            <SelectTrigger className="h-8 text-xs"><SelectValue placeholder="Department" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All departments</SelectItem>
              {(departments || []).map((d: any) => <SelectItem key={d.id} value={d.id}>{d.name}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <PeriodPicker value={periodLabel} onChange={setPeriodLabel} />
        <div className="w-full sm:w-44">
          <Select value={status || "all"} onValueChange={(v) => setStatus(v === "all" ? "" : v)}>
            <SelectTrigger className="h-8 text-xs"><SelectValue placeholder="Status" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              {TARGET_STATUS_OPTIONS.map((s) => <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div className="flex-1" />
        {can("kpi", "assign") && (
          <>
            <Button size="sm" className="h-8 text-xs" onClick={() => setAssignOpen(true)}>
              <UserPlus className="h-3.5 w-3.5 mr-1" /> Set KPI Target
            </Button>
            <Button size="sm" variant="outline" className="h-8 text-xs" onClick={() => setBulkOpen(true)}>
              <Upload className="h-3.5 w-3.5 mr-1" /> Bulk KPI Target
            </Button>
          </>
        )}
        <Button size="sm" variant="outline" className="h-8 text-xs" onClick={() => setBatchesOpen(true)}>
          <Layers className="h-3.5 w-3.5 mr-1" /> Bulk Review
        </Button>
      </div>

      {/* summary cards — respect the department + period filters */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
        <StatCard label="Total Employees" value={summary?.totalEmployees ?? "—"} icon={Users} tone="slate" />
        <StatCard label="KPI Target Assigned" value={summary?.assigned ?? "—"} icon={CheckCircle2} tone="emerald" />
        <StatCard label="Not Assigned" value={summary?.notAssigned ?? "—"} icon={XCircle} tone="rose" />
        <StatCard label="Pending Approval" value={summary?.pendingApproval ?? "—"} icon={ShieldCheck} tone="amber" />
        <StatCard label="Approved" value={summary?.approved ?? "—"} icon={CheckCircle2} tone="emerald" />
        <StatCard label="Rejected" value={summary?.rejected ?? "—"} icon={XCircle} tone="rose" />
      </div>

      <DataTable columns={columns} rows={rows} loading={loading} error={error} dense
        pageSize={pageSize}
        searchPlaceholder="Search employee…"
        onSearch={setSearch}
        onRowClick={(r) => setDetailId(r.id)}
        toolbar={selected.size > 0 && can("kpi", "approve") ? (
          <div className="flex items-center gap-2">
            <span className="text-xs text-slate-600 dark:text-slate-300 font-medium">
              Total {selected.size} Selected
            </span>
            <Button size="sm" className="h-8 text-xs bg-emerald-600 hover:bg-emerald-700" disabled={approvingAll || bulkActionBusy} onClick={approveSelected}>
              <CheckCircle2 className="h-3.5 w-3.5 mr-1" />
              {approvingAll ? "Approving…" : "Approve All"}
            </Button>
            <Button size="sm" variant="outline" className="h-8 text-xs border-amber-400 text-amber-700 hover:bg-amber-50 dark:border-amber-600 dark:text-amber-400"
              disabled={approvingAll || bulkActionBusy}
              onClick={() => setReasonDialog({ decision: "REQUEST_CHANGES", reason: "" })}>
              <History className="h-3.5 w-3.5 mr-1" /> Request Changes
            </Button>
            <Button size="sm" variant="outline" className="h-8 text-xs border-rose-400 text-rose-700 hover:bg-rose-50 dark:border-rose-600 dark:text-rose-400"
              disabled={approvingAll || bulkActionBusy}
              onClick={() => setReasonDialog({ decision: "REJECT", reason: "" })}>
              <XCircle className="h-3.5 w-3.5 mr-1" /> Reject All
            </Button>
          </div>
        ) : undefined}
        emptyTitle="No KPI target assignments" emptyHint="Assign a department KPI template to employees for a period — individually or in bulk via Excel." />

      {/* Reason dialog for Request Changes / Reject All */}
      <Dialog open={!!reasonDialog} onOpenChange={(v) => { if (!v) setReasonDialog(null) }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className={reasonDialog?.decision === "REJECT" ? "text-rose-600" : "text-amber-600"}>
              {reasonDialog?.decision === "REJECT" ? "Reject All Selected" : "Request Changes"}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-1">
            <p className="text-sm text-slate-600 dark:text-slate-400">
              This will apply to <strong>{selected.size}</strong> selected target{selected.size !== 1 ? "s" : ""}.
              A reason is required.
            </p>
            <Label className="text-xs font-medium">Reason <span className="text-rose-500">*</span></Label>
            <Textarea
              rows={3}
              placeholder="Enter reason…"
              value={reasonDialog?.reason ?? ""}
              onChange={(e) => setReasonDialog(prev => prev ? { ...prev, reason: e.target.value } : null)}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setReasonDialog(null)}>Cancel</Button>
            <Button
              size="sm"
              disabled={!reasonDialog?.reason.trim() || bulkActionBusy}
              className={reasonDialog?.decision === "REJECT" ? "bg-rose-600 hover:bg-rose-700" : "bg-amber-600 hover:bg-amber-700"}
              onClick={() => reasonDialog && bulkDecide(reasonDialog.decision, reasonDialog.reason.trim())}
            >
              {bulkActionBusy ? "Processing…" : reasonDialog?.decision === "REJECT" ? "Reject All" : "Request Changes"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <PagedControls page={page} maxPage={maxPage} total={total} pageSize={pageSize} onPage={setPage} loading={loading} onPageSizeChange={(s) => { setPageSize(s); setPage(1) }} />

      <SingleAssignDialog open={assignOpen} onOpenChange={(v) => { setAssignOpen(v); if (!v) { reload(); reloadSummary() } }} />
      <BulkTargetWizard open={bulkOpen} onOpenChange={(v) => { setBulkOpen(v); if (!v) { reload(); reloadSummary() } }} departments={departments || []} />
      <BatchesDialog open={batchesOpen} onOpenChange={setBatchesOpen} onChanged={reload} />
      <TargetDetailDrawer id={detailId} onOpenChange={(v) => { if (!v) setDetailId(null) }} onChanged={() => { reload(); reloadSummary() }} />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Single employee assignment — auto-loads the department template
// ---------------------------------------------------------------------------

function SingleAssignDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const toast = useHrm((s) => s.toast)
  const [employeeId, setEmployeeId] = useState("")
  const [periodLabel, setPeriodLabel] = useState(() => `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, "0")}`)
  const [dueDate, setDueDate] = useState("")
  const [remarks, setRemarks] = useState("")
  const [inds, setInds] = useState<any[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // employee directory (lightweight cached) — refList returns { refs, total,
  // truncated }, not a bare array
  const { data: employees } = useApi<{ refs: any[]; total: number; truncated: boolean }>("employees.refList", { take: 10000 })
  const refs = employees?.refs || []

  // load the department template once the employee&apos;s department is known
  const loadTemplate = async (deptId: string) => {
    try {
      const list = await rpc<any[]>("kpi.templates.list", { departmentId: deptId })
      const t = list?.[0]
      if (!t) {
        setInds([])
        setError("No KPI template exists for this employee&apos;s department — create the Company + Department template first (KPI Templates tab).")
        return
      }
      setError(null)
      setInds((t.indicators || []).map((i: any, idx: number) => ({
        key: `i-${i.id}-${idx}`, indicatorId: i.id, name: i.name, builtinKey: i.builtinKey,
        unit: i.unit, unitLabel: i.unitLabel, direction: i.direction, weight: i.weight,
        targetValue: i.defaultTarget ?? "", templateName: t.name,
      })))
    } catch (e: any) {
      setError(e.message)
    }
  }

  // resolve employee → department through the employee profile (single fetch)
  useEffect(() => {
    if (!employeeId || !open) return
    let cancelled = false
    ;(async () => {
      try {
        const res = await rpc<any>("employees.get", { id: employeeId })
        if (cancelled) return
        // employees.get returns { employee: {...} } (field-permission projected)
        const emp = res?.employee || res
        if (emp?.departmentId) await loadTemplate(emp.departmentId)
        else { setInds([]); setError("This employee has no department — KPI templates are department-based.") }
      } catch (e: any) {
        if (!cancelled) setError(e.message)
      }
    })()
    return () => { cancelled = true }
     
  }, [employeeId, open])

  const totalWeight = inds.reduce((s, i) => s + (Number(i.weight) || 0), 0)

  const submit = async (submitForApproval: boolean) => {
    setBusy(true)
    setError(null)
    try {
      await rpc("kpi.targets.assign", {
        employeeId,
        periodLabel,
        dueDate: dueDate || undefined,
        remarks: remarks.trim() || undefined,
        submit: submitForApproval,
        indicators: inds.map((i, idx) => ({
          indicatorId: i.indicatorId, name: i.name, builtinKey: i.builtinKey, unit: i.unit,
          unitLabel: i.unitLabel, direction: i.direction, weight: Number(i.weight) || 0,
          targetValue: i.targetValue === "" ? null : Number(i.targetValue), sortOrder: idx + 1,
        })),
      })
      toast(submitForApproval ? "KPI target submitted for approval" : "Draft saved")
      onOpenChange(false)
      setEmployeeId(""); setDueDate(""); setRemarks(""); setInds([])
    } catch (e: any) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  const setInd = (key: string, patch: any) => setInds((arr) => arr.map((i) => (i.key === key ? { ...i, ...patch } : i)))

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!busy) onOpenChange(v) }}>
      <DialogContent className="sm:max-w-3xl max-h-[92vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-base">Set Single Employee KPI Target</DialogTitle>
          <p className="text-xs text-slate-500">Pick an employee — their department&apos;s KPI template loads automatically. Adjust per-employee targets and weights, then submit for approval.</p>
        </DialogHeader>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 py-1">
          <div className="space-y-1.5 sm:col-span-2">
            <Label className="text-xs font-medium">Employee <span className="text-rose-500">*</span></Label>
            <Select value={employeeId || "none"} onValueChange={(v) => { setEmployeeId(v === "none" ? "" : v); setError(null) }}>
              <SelectTrigger className="h-9"><SelectValue placeholder="Select employee…" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="none" disabled>Select employee…</SelectItem>
                {refs.map((e: any) => <SelectItem key={e.id} value={e.id}>{e.fullName} ({e.code})</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs font-medium">Period <span className="text-rose-500">*</span></Label>
            <PeriodPicker value={periodLabel} onChange={setPeriodLabel} />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs font-medium">Due Date</Label>
            <Input type="date" className="h-9" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
          </div>
          {inds.length > 0 && (
            <div className="sm:col-span-2 rounded-xl border overflow-x-auto">
              <div className="px-3 py-2 bg-slate-50 dark:bg-slate-800/60 flex items-center justify-between">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">{inds[0]?.templateName} — per-employee targets</p>
                <Badge className={`${Math.round(totalWeight * 100) === 10000 ? "bg-emerald-100 text-emerald-700" : "bg-amber-100 text-amber-700"} text-[10px] tabular-nums`}>Σ {Math.round(totalWeight * 100) / 100}%</Badge>
              </div>
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-[10px] uppercase tracking-wide text-slate-400 border-b">
                    <th className="text-left font-semibold px-3 py-1.5">Indicator</th>
                    <th className="text-left font-semibold px-3 py-1.5 w-20">Type</th>
                    <th className="text-right font-semibold px-3 py-1.5 w-24">Target</th>
                    <th className="text-right font-semibold px-3 py-1.5 w-24">Weight %</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {inds.map((i) => (
                    <tr key={i.key}>
                      <td className="px-3 py-1.5">
                        <p className="text-sm font-medium text-slate-800 dark:text-slate-100">{i.name}</p>
                        <p className="text-[10px] text-slate-400">{directionShort(i.direction)} · {unitLabel(i.unit, i.unitLabel) || i.unit}</p>
                      </td>
                      <td className="px-3 py-1.5"><SourceBadge source={i.builtinKey ? "BUILTIN" : "CUSTOM"} /></td>
                      <td className="px-3 py-1.5"><Input className="h-8 text-xs tabular-nums" type="number" value={i.targetValue} onChange={(e) => setInd(i.key, { targetValue: e.target.value })} /></td>
                      <td className="px-3 py-1.5"><Input className="h-8 text-xs tabular-nums" type="number" value={i.weight} onChange={(e) => setInd(i.key, { weight: e.target.value })} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="space-y-1.5 sm:col-span-2">
            <Label className="text-xs font-medium">Remarks</Label>
            <Textarea rows={2} value={remarks} onChange={(e) => setRemarks(e.target.value)} placeholder="Optional notes for the approver" />
          </div>
        </div>
        {error && <ErrorBanner message={error} />}
        <DialogFooter className="gap-2 sm:justify-between">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
          <div className="flex gap-2">
            <Button variant="outline" disabled={busy || !employeeId || !inds.length} onClick={() => submit(false)}>Save as Draft</Button>
            <Button disabled={busy || !employeeId || !inds.length || Math.round(totalWeight * 100) !== 10000} onClick={() => submit(true)}>
              {busy ? "Submitting…" : "Submit for Approval"}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------
// Bulk target wizard — config → download → upload → preview → submit
// ---------------------------------------------------------------------------

const BULK_STEPS = [
  { title: "Configuration", hint: "Department, period, due date and optional employee filters" },
  { title: "Download Template", hint: "A dynamic Excel file generated from the department's KPI template" },
  { title: "Upload & Validate", hint: "Every row validated before anything is saved" },
  { title: "Submit", hint: "All created targets enter Pending Approval" },
]

function BulkTargetWizard({ open, onOpenChange, departments }: { open: boolean; onOpenChange: (v: boolean) => void; departments: any[] }) {
  const toast = useHrm((s) => s.toast)
  const { data: branches } = useLookup<any[]>("branches.list", {})
  const { data: designations } = useLookup<any[]>("designations.list", {})
  const [step, setStep] = useState(0)
  const [departmentId, setDepartmentId] = useState("")
  const [periodLabel, setPeriodLabel] = useState(() => `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, "0")}`)
  const [dueDate, setDueDate] = useState("")
  const [employmentType, setEmploymentType] = useState("")
  const [branchId, setBranchId] = useState("")
  const [designationId, setDesignationId] = useState("")
  const [templateInfo, setTemplateInfo] = useState<any>(null)
  const [file, setFile] = useState<File | null>(null)
  const [preview, setPreview] = useState<any>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (open) { setStep(0); setTemplateInfo(null); setFile(null); setPreview(null); setError(null) }
     
  }, [open])

  const config = {
    departmentId, periodLabel,
    dueDate: dueDate || null,
    employmentType: employmentType || null,
    branchId: branchId || null,
    designationId: designationId || null,
  }

  const downloadTemplate = async () => {
    setBusy(true)
    setError(null)
    try {
      const res = await rpc<any>("kpi.targets.bulkTemplate", config)
      downloadBase64File(res)
      setTemplateInfo(res)
      toast(`Template downloaded — ${res.eligibleEmployees} eligible employee(s)`)
      setStep(1)
    } catch (e: any) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  const uploadAndPreview = async () => {
    if (!file) return
    setBusy(true)
    setError(null)
    try {
      const base64 = await readFileAsBase64(file)
      const res = await rpc<any>("kpi.targets.bulkPreview", { ...config, base64 })
      setPreview(res)
      setStep(3)
    } catch (e: any) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  const submit = async () => {
    if (!file) return
    setBusy(true)
    setError(null)
    try {
      const base64 = await readFileAsBase64(file)
      const res = await rpc<any>("kpi.targets.bulkSubmit", { ...config, base64 })
      toast(`Bulk assignment created — ${res.created} employee target(s) submitted for approval (batch ${res.batchId.slice(-6)})`)
      onOpenChange(false)
    } catch (e: any) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  const summary = preview?.summary
  const readyCount = summary?.valid || 0

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!busy) onOpenChange(v) }}>
      <DialogContent className="sm:max-w-4xl max-h-[92vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-base flex items-center gap-2"><FileSpreadsheet className="h-4 w-4 text-emerald-600" /> Bulk Employee KPI Target</DialogTitle>
          <div className="flex items-center gap-1.5 pt-1">
            {BULK_STEPS.map((s, i) => (
              <div key={s.title} className={`flex-1 rounded-md px-2 py-1.5 ${i === step ? "bg-emerald-50 dark:bg-emerald-950/50 border border-emerald-200 dark:border-emerald-900" : i < step ? "" : "opacity-50"}`}>
                <div className="flex items-center gap-1.5">
                  <span className={`h-4 w-4 rounded-full text-[9px] font-bold flex items-center justify-center ${i <= step ? "bg-emerald-500 text-white" : "bg-slate-200 text-slate-500"}`}>{i + 1}</span>
                  <span className={`text-[11px] font-semibold ${i === step ? "text-emerald-700 dark:text-emerald-300" : "text-slate-500"}`}>{s.title}</span>
                </div>
              </div>
            ))}
          </div>
          <p className="text-[11px] text-slate-500">{BULK_STEPS[step].hint}</p>
        </DialogHeader>

        {step === 0 && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 py-2">
            <div className="space-y-1.5">
              <Label className="text-xs font-medium">Department <span className="text-rose-500">*</span></Label>
              <Select value={departmentId || "none"} onValueChange={(v) => setDepartmentId(v === "none" ? "" : v)}>
                <SelectTrigger className="h-9"><SelectValue placeholder="Select department" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none" disabled>Select department…</SelectItem>
                  {departments.map((d: any) => <SelectItem key={d.id} value={d.id}>{d.name}</SelectItem>)}
                </SelectContent>
              </Select>
              <p className="text-[10px] text-slate-400">The department determines which KPI Template is loaded.</p>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs font-medium">Period <span className="text-rose-500">*</span></Label>
              <PeriodPicker value={periodLabel} onChange={setPeriodLabel} />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs font-medium">Due Date</Label>
              <Input type="date" className="h-9" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs font-medium">Employment Type (optional)</Label>
              <Select value={employmentType || "all"} onValueChange={(v) => setEmploymentType(v === "all" ? "" : v)}>
                <SelectTrigger className="h-9 text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All types</SelectItem>
                  {["FULL_TIME", "PART_TIME", "CONTRACT", "INTERN", "PROBATION"].map((t) => <SelectItem key={t} value={t}>{t.replace(/_/g, " ")}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs font-medium">Branch / Location (optional)</Label>
              <Select value={branchId || "all"} onValueChange={(v) => setBranchId(v === "all" ? "" : v)}>
                <SelectTrigger className="h-9 text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All branches</SelectItem>
                  {(branches || []).map((b: any) => <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs font-medium">Designation (optional)</Label>
              <Select value={designationId || "all"} onValueChange={(v) => setDesignationId(v === "all" ? "" : v)}>
                <SelectTrigger className="h-9 text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All designations</SelectItem>
                  {(designations || []).map((d: any) => <SelectItem key={d.id} value={d.id}>{d.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </div>
        )}

        {step === 1 && (
          <div className="space-y-3 py-2">
            <div className="rounded-xl border border-emerald-200 dark:border-emerald-900 bg-emerald-50/50 dark:bg-emerald-950/20 p-4 space-y-2">
              <p className="text-sm font-medium text-emerald-800 dark:text-emerald-300 flex items-center gap-1.5"><Download className="h-4 w-4" /> Dynamic Excel template</p>
              <p className="text-xs text-slate-600 dark:text-slate-300">
                The file is generated from the selected department&apos;s KPI template with one row per eligible employee
                (already-assigned employees are excluded) and one column per indicator, pre-filled with default targets.
                Employee ID columns are authoritative — do not rename or reorder them.
              </p>
              {templateInfo && (
                <div className="flex flex-wrap gap-2 text-xs">
                  <Badge variant="outline">{templateInfo.eligibleEmployees} eligible</Badge>
                  <Badge variant="outline">{templateInfo.alreadyAssigned} already assigned</Badge>
                  <Badge variant="outline">{(templateInfo.indicators || []).length} indicator columns</Badge>
                </div>
              )}
              <Button className="h-9" onClick={downloadTemplate} disabled={busy || !departmentId}>
                <Download className="h-3.5 w-3.5 mr-1.5" /> {busy ? "Generating…" : "Download Excel Template"}
              </Button>
            </div>
          </div>
        )}

        {step === 2 && (
          <div className="space-y-3 py-2">
            <div className="rounded-xl border border-dashed border-slate-300 dark:border-slate-700 p-6 text-center">
              <Upload className="h-8 w-8 mx-auto text-slate-400 mb-2" />
              <p className="text-sm font-medium text-slate-700 dark:text-slate-200">Upload the completed Excel file</p>
              <p className="text-xs text-slate-500 mb-3">.xlsx only · the file is validated server-side before the preview</p>
              <input type="file" accept=".xlsx" className="hidden" id="kpi-bulk-file"
                onChange={(e) => { setFile(e.target.files?.[0] || null); setPreview(null) }} />
              <Button variant="outline" className="h-9" onClick={() => document.getElementById("kpi-bulk-file")?.click()}>
                {file ? file.name : "Choose file"}
              </Button>
            </div>
          </div>
        )}

        {step === 3 && preview && (
          <div className="space-y-3 py-2">
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
              {[
                { label: "Detected", value: summary.total, tone: "slate" },
                { label: "Valid", value: summary.valid, tone: "emerald" },
                { label: "Invalid", value: summary.invalid, tone: "rose" },
                { label: "Duplicates", value: summary.duplicates, tone: "amber" },
                { label: "Already assigned", value: summary.existing, tone: "amber" },
              ].map((c) => (
                <div key={c.label} className="rounded-lg border p-2.5 text-center">
                  <p className="text-[10px] uppercase tracking-wide text-slate-400">{c.label}</p>
                  <p className={`text-lg font-bold tabular-nums ${c.tone === "emerald" ? "text-emerald-600" : c.tone === "rose" ? "text-rose-600" : c.tone === "amber" ? "text-amber-600" : "text-slate-700 dark:text-slate-200"}`}>{c.value}</p>
                </div>
              ))}
            </div>
            {(preview.missingHeaders || []).length > 0 && (
              <ErrorBanner message={`Missing columns: ${(preview.missingHeaders || []).join(", ")} — use the template downloaded from this wizard.`} />
            )}
            <div className="rounded-xl border max-h-72 overflow-y-auto">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-slate-50 dark:bg-slate-800/80">
                  <tr className="text-[10px] uppercase tracking-wide text-slate-400">
                    <th className="text-left font-semibold px-3 py-2 w-12">Row</th>
                    <th className="text-left font-semibold px-3 py-2">Employee</th>
                    <th className="text-left font-semibold px-3 py-2">Status</th>
                    <th className="text-left font-semibold px-3 py-2">Detail</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {(preview.rows || []).map((r: any) => (
                    <tr key={r.rowNo}>
                      <td className="px-3 py-1.5 text-xs tabular-nums text-slate-400">{r.rowNo}</td>
                      <td className="px-3 py-1.5 text-xs">
                        <span className="font-medium text-slate-800 dark:text-slate-100">{r.employeeName || "—"}</span>
                        <span className="text-slate-400 ml-1.5">{r.employeeCode}</span>
                      </td>
                      <td className="px-3 py-1.5">
                        <Badge className={r.status === "READY" ? "bg-emerald-100 text-emerald-700" : r.status === "ERROR" ? "bg-rose-100 text-rose-700" : "bg-amber-100 text-amber-700"}>{r.status}</Badge>
                      </td>
                      <td className="px-3 py-1.5 text-[11px] text-slate-500 max-w-md">{r.error || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {summary.invalid > 0 && (
              <Button size="sm" variant="outline" className="h-8 text-xs" onClick={() => downloadErrorReport(preview.rows)}>
                <Download className="h-3.5 w-3.5 mr-1" /> Download Error Report
              </Button>
            )}
          </div>
        )}

        {error && <ErrorBanner message={error} />}
        <DialogFooter className="gap-2 sm:justify-between">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
          <div className="flex gap-2">
            {step > 0 && <Button variant="outline" onClick={() => setStep(step - 1)} disabled={busy}><ArrowLeft className="h-3.5 w-3.5 mr-1" /> Back</Button>}
            {step === 0 && <Button onClick={() => setStep(1)} disabled={!departmentId}>Next <ArrowRight className="h-3.5 w-3.5 ml-1" /></Button>}
            {step === 1 && <Button onClick={() => setStep(2)} disabled={!templateInfo}>I&apos;ve filled the file <ArrowRight className="h-3.5 w-3.5 ml-1" /></Button>}
            {step === 2 && <Button onClick={uploadAndPreview} disabled={!file || busy}>{busy ? "Validating…" : "Validate & Preview"}</Button>}
            {step === 3 && (
              <Button onClick={submit} disabled={busy || readyCount === 0}>
                {busy ? "Submitting…" : <>Submit {readyCount} Target(s) <CheckCircle2 className="h-3.5 w-3.5 ml-1" /></>}
              </Button>
            )}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------
// Batches dialog (bulk review interface)
// ---------------------------------------------------------------------------

function BatchesDialog({ open, onOpenChange, onChanged }: { open: boolean; onOpenChange: (v: boolean) => void; onChanged: () => void }) {
  const { can } = useHrm()
  const [status, setStatus] = useState("PENDING_APPROVAL")
  const { rows, total, page, pageSize, maxPage, loading, error, reload, setPage } = useServerPagedList<any>("kpi.targets.batches", { status: status || undefined }, 10)
  const [openBatchId, setOpenBatchId] = useState<string | null>(null)

  return (
    <>
      <Dialog open={open && !openBatchId} onOpenChange={(v) => { onOpenChange(v); if (!v) { reload(); onChanged() } }}>
        <DialogContent className="sm:max-w-3xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="text-base flex items-center gap-2"><Layers className="h-4 w-4 text-emerald-600" /> Bulk Assignment Batches</DialogTitle>
          </DialogHeader>
          <div className="w-full sm:w-56">
            <Select value={status || "all"} onValueChange={(v) => setStatus(v === "all" ? "" : v)}>
              <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All statuses</SelectItem>
                {["PENDING_APPROVAL", "PARTIALLY_APPROVED", "APPROVED", "REJECTED"].map((s) => <SelectItem key={s} value={s}>{fmtStatus(s)}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          {loading ? <p className="text-xs text-slate-500 py-6 text-center">Loading batches…</p> : error ? <ErrorBanner message={error} /> : (
            <div className="space-y-2">
              {rows.length === 0 && <EmptyState icon={Layers} title="No batches" hint="Bulk Excel assignments appear here for review." />}
              {rows.map((b) => (
                <button key={b.id} type="button"
                  className="w-full text-left rounded-xl border border-slate-200 dark:border-slate-800 p-3 hover:border-emerald-300 dark:hover:border-emerald-800 hover:bg-emerald-50/30 dark:hover:bg-emerald-950/20 transition"
                  onClick={() => setOpenBatchId(b.id)}>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">
                        {b.departmentName || "—"} · {fmtPeriod(b.periodLabel)}
                      </p>
                      <p className="text-[11px] text-slate-500">
                        {b.validCount} submitted · {b.invalidCount} skipped · by {b.createdByName || "—"} · {fmtDateTime(b.createdAt)}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <StatusBadge status={b.status} />
                      <ChevronRight className="h-4 w-4 text-slate-400" />
                    </div>
                  </div>
                </button>
              ))}
              <PagedControls page={page} maxPage={maxPage} total={total} pageSize={pageSize} onPage={setPage} loading={loading} />
            </div>
          )}
          {!can("kpi", "approve") && <p className="text-[11px] text-slate-400">You need the KPI approve permission to act on batches.</p>}
        </DialogContent>
      </Dialog>
      <BatchReviewDialog batchId={openBatchId} onOpenChange={(v) => { if (!v) { setOpenBatchId(null); reload() } }} onChanged={onChanged} />
    </>
  )
}

function BatchReviewDialog({ batchId, onOpenChange, onChanged }: { batchId: string | null; onOpenChange: (v: boolean) => void; onChanged: () => void }) {
  const { can } = useHrm()
  const toast = useHrm((s) => s.toast)
  const [data, setData] = useState<any>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [expanded, setExpanded] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const load = async () => {
    if (!batchId) return
    setLoading(true)
    setError(null)
    try {
      const res = await rpc<any>("kpi.targets.batchGet", { id: batchId })
      setData(res)
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { setSelected(new Set()); load()   }, [batchId])

  const pending = (data?.employees || []).filter((e: any) => e.status === "PENDING_APPROVAL")
  const act = async (decision: "APPROVE" | "REJECT" | "REQUEST_CHANGES", comment?: string) => {
    setBusy(true)
    try {
      const res = await rpc<any>("kpi.targets.batchDecide", {
        id: batchId, decision,
        ...(selected.size ? { ids: [...selected] } : {}),
        ...(comment ? { comment } : {}),
      })
      toast(`${decision === "APPROVE" ? "Approved" : decision === "REJECT" ? "Rejected" : "Changes requested"} — ${res.approved || res.decided || 0} record(s), ${res.skipped?.length || 0} skipped`)
      setSelected(new Set())
      await load()
      onChanged()
    } catch (e: any) {
      toast(e.message, "err")
    } finally {
      setBusy(false)
    }
  }

  if (!batchId) return null
  return (
    <Dialog open={!!batchId} onOpenChange={(v) => { if (!busy) onOpenChange(v) }}>
      <DialogContent className="sm:max-w-4xl max-h-[92vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-base">Bulk Batch Review</DialogTitle>
          {data?.batch && (
            <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
              <StatusBadge status={data.batch.status} />
              <span>{data.batch.departmentName || "—"}</span>
              <Badge variant="outline" className="text-[10px]">{fmtPeriod(data.batch.periodLabel)}</Badge>
              {data.batch.dueDate && <span>· due {fmtDate(data.batch.dueDate)}</span>}
              <span>· {(data.employees || []).length} employee(s)</span>
              <span>· by {data.batch.createdByName || "—"} · {fmtDateTime(data.batch.createdAt)}</span>
            </div>
          )}
        </DialogHeader>
        {loading ? <p className="text-xs text-slate-500 py-6 text-center">Loading batch…</p> : error ? <ErrorBanner message={error} /> : data && (
          <>
            {pending.length > 0 && can("kpi", "approve") && (
              <div className="rounded-xl border border-emerald-200 dark:border-emerald-900 bg-emerald-50/40 dark:bg-emerald-950/20 p-3 space-y-2">
                <p className="text-xs text-slate-600 dark:text-slate-300">
                  {selected.size ? `${selected.size} employee(s) selected` : `${pending.length} employee(s) pending — acting without a selection applies to ALL pending records.`}
                </p>
                <ApprovalActions busy={busy} onDecide={async (d, c) => act(d, c)} />
              </div>
            )}
            <div className="rounded-xl border divide-y divide-slate-100 dark:divide-slate-800 max-h-[52vh] overflow-y-auto">
              {(data.employees || []).map((e: any) => (
                <div key={e.assignmentId}>
                  <div className="flex items-center gap-2 px-3 py-2">
                    <Checkbox
                      checked={selected.has(e.assignmentId)}
                      disabled={e.status !== "PENDING_APPROVAL"}
                      onCheckedChange={(v) => setSelected((s) => { const n = new Set(s); if (v) n.add(e.assignmentId); else n.delete(e.assignmentId); return n })}
                    />
                    <button type="button" className="flex-1 text-left min-w-0" onClick={() => setExpanded(expanded === e.assignmentId ? null : e.assignmentId)}>
                      <p className="text-sm font-medium text-slate-800 dark:text-slate-100 truncate">{e.employeeName} <span className="text-slate-400 font-normal">{e.employeeCode}</span></p>
                      <p className="text-[11px] text-slate-500">{(e.indicators || []).length} indicator(s) · {e.designationName || "—"}</p>
                    </button>
                    <StatusBadge status={e.status} />
                    {expanded === e.assignmentId ? <ChevronDown className="h-4 w-4 text-slate-400" /> : <ChevronRight className="h-4 w-4 text-slate-400" />}
                  </div>
                  {expanded === e.assignmentId && (
                    <div className="px-8 pb-3">
                      <table className="w-full text-xs">
                        <thead>
                          <tr className="text-[10px] uppercase tracking-wide text-slate-400 border-b">
                            <th className="text-left font-semibold py-1.5">Indicator</th>
                            <th className="text-right font-semibold py-1.5">Target</th>
                            <th className="text-right font-semibold py-1.5">Weight</th>
                          </tr>
                        </thead>
                        <tbody>
                          {(e.indicators || []).map((i: any) => (
                            <tr key={i.id}>
                              <td className="py-1.5 font-medium text-slate-700 dark:text-slate-200">{i.name}</td>
                              <td className="py-1.5 text-right tabular-nums">{i.targetValue ?? "—"}{unitLabel(i.unit, i.unitLabel)}</td>
                              <td className="py-1.5 text-right tabular-nums">{i.weight}%</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      {e.remarks && <p className="text-[11px] text-slate-500 mt-1.5">Remarks: {e.remarks}</p>}
                    </div>
                  )}
                </div>
              ))}
            </div>
            {(data.history || []).length > 0 && (
              <details className="rounded-xl border p-3">
                <summary className="text-xs font-semibold text-slate-600 dark:text-slate-300 flex items-center gap-1 cursor-pointer"><History className="h-3.5 w-3.5" /> Batch approval history</summary>
                <div className="mt-2 space-y-1">
                  {data.history.map((h: any) => (
                    <p key={h.id} className="text-[11px] text-slate-500">
                      <b>{h.actorName || "—"}</b> · {fmtStatus(h.action)} · {fmtDateTime(h.createdAt)}{h.comment ? ` — ${h.comment}` : ""}
                    </p>
                  ))}
                </div>
              </details>
            )}
          </>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------
// Target detail drawer — full info + indicators + approvals + revisions
// ---------------------------------------------------------------------------

function TargetDetailDrawer({ id, onOpenChange, onChanged }: { id: string | null; onOpenChange: (v: boolean) => void; onChanged: () => void }) {
  const { can } = useHrm()
  const toast = useHrm((s) => s.toast)
  const [data, setData] = useState<any>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [editOpen, setEditOpen] = useState(false)
  const [cancelOpen, setCancelOpen] = useState(false)
  const [busy, setBusy] = useState(false)

  const load = async () => {
    if (!id) return
    setLoading(true)
    setError(null)
    try {
      setData(await rpc<any>("kpi.targets.get", { id }))
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { load()   }, [id])

  const decide = async (decision: any, comment?: string) => {
    setBusy(true)
    try {
      await rpc("kpi.targets.decide", { id, decision, comment })
      toast(`Target ${decision === "APPROVE" ? "approved" : decision === "REJECT" ? "rejected" : "returned"}`)
      await load()
      onChanged()
    } finally {
      setBusy(false)
    }
  }

  if (!id) return null
  const a = data
  return (
    <>
      <Dialog open={!!id && !editOpen && !cancelOpen} onOpenChange={(v) => { if (!v) onOpenChange(false) }}>
        <DialogContent className="sm:max-w-3xl max-h-[92vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="text-base">KPI Target — {a?.employee?.fullName || "…"}</DialogTitle>
            {a && (
              <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
                <StatusBadge status={a.status} />
                <Badge variant="outline" className="text-[10px]">{fmtPeriod(a.periodLabel, a.periodStart, a.periodEnd)}</Badge>
                {a.dueDate && <span>· due {fmtDate(a.dueDate)}</span>}
                {a.revision > 1 && <Badge variant="outline" className="text-[10px]">revision {a.revision}</Badge>}
                {a.templateName && <span>· {a.templateName}</span>}
              </div>
            )}
          </DialogHeader>
          {loading ? <p className="text-xs text-slate-500 py-6 text-center">Loading…</p> : error ? <ErrorBanner message={error} /> : a && (
            <>
              <KV cols={3} items={[
                ["Employee", `${a.employee?.fullName || "—"} (${a.employee?.code || "—"})`],
                ["Department", a.employee?.departmentName || "—"],
                ["Designation", a.employee?.designationName || "—"],
                ["Creator", a.createdByName || "—"],
                ["Approver", a.decidedByName || "—"],
                ["Submitted", a.submittedAt ? fmtDateTime(a.submittedAt) : "—"],
              ]} />
              <div className="rounded-xl border overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-slate-50 dark:bg-slate-800/60 text-[10px] uppercase tracking-wide text-slate-400">
                      <th className="text-left font-semibold px-3 py-2">Indicator</th>
                      <th className="text-left font-semibold px-3 py-2 w-20">Type</th>
                      <th className="text-left font-semibold px-3 py-2">Direction</th>
                      <th className="text-right font-semibold px-3 py-2">Target</th>
                      <th className="text-right font-semibold px-3 py-2">Weight</th>
                      <th className="text-left font-semibold px-3 py-2 w-24">Actual</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                    {(a.indicators || []).map((i: any) => (
                      <tr key={i.id}>
                        <td className="px-3 py-2">
                          <p className="text-sm font-medium text-slate-800 dark:text-slate-100">{i.name}</p>
                          <p className="text-[10px] text-slate-400">{unitLabel(i.unit, i.unitLabel) || i.unit}</p>
                        </td>
                        <td className="px-3 py-2"><SourceBadge source={i.source} /></td>
                        <td className="px-3 py-2 text-xs text-slate-500">{directionShort(i.direction)}</td>
                        <td className="px-3 py-2 text-right text-xs tabular-nums font-semibold">{i.targetValue ?? "—"}</td>
                        <td className="px-3 py-2 text-right text-xs tabular-nums text-slate-500">{i.weight}%</td>
                        <td className="px-3 py-2 text-xs">{i.achievement ? <span className="tabular-nums">{i.achievement.actualValue ?? "—"} <StatusBadge status={i.achievement.status} /></span> : <span className="text-slate-400 text-[10px]">not recorded</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {a.remarks && <p className="text-xs text-slate-600 dark:text-slate-300 rounded-lg bg-slate-50 dark:bg-slate-800/60 p-3">{a.remarks}</p>}
              {(a.history || []).length > 0 && (
                <details className="rounded-xl border p-3" open>
                  <summary className="text-xs font-semibold text-slate-600 dark:text-slate-300 flex items-center gap-1 cursor-pointer"><History className="h-3.5 w-3.5" /> Approval history</summary>
                  <div className="mt-2 space-y-1.5">
                    {a.history.map((h: any) => (
                      <div key={h.id} className="flex items-start gap-2 text-[11px]">
                        <Badge variant="outline" className="text-[9px] shrink-0 mt-0.5">{fmtStatus(h.action)}</Badge>
                        <p className="text-slate-500">
                          <b className="text-slate-700 dark:text-slate-300">{h.actorName || "—"}</b> · {fmtDateTime(h.createdAt)}{h.comment ? ` — ${h.comment}` : ""}
                        </p>
                      </div>
                    ))}
                  </div>
                </details>
              )}
              {(a.revisions || []).length > 0 && (
                <details className="rounded-xl border p-3">
                  <summary className="text-xs font-semibold text-slate-600 dark:text-slate-300 flex items-center gap-1 cursor-pointer"><Eye className="h-3.5 w-3.5" /> Revision archive ({a.revisions.length})</summary>
                  <div className="mt-2 space-y-1.5">
                    {a.revisions.map((r: any) => (
                      <p key={r.id} className="text-[11px] text-slate-500">
                        <b>rev {r.revision}</b> archived {fmtDateTime(r.createdAt)} — {(r.snapshot?.indicators || []).length} indicator(s){r.changeSummary ? ` · ${r.changeSummary}` : ""}
                      </p>
                    ))}
                  </div>
                </details>
              )}
              <DialogFooter className="gap-2 sm:justify-between">
                <div className="flex gap-2">
                  {can("kpi", "assign") && ["DRAFT", "PENDING_APPROVAL", "CHANGES_REQUESTED", "REJECTED", "APPROVED"].includes(a.status) && (
                    <Button variant="outline" onClick={() => setEditOpen(true)} disabled={busy}>
                      <Pencil className="h-3.5 w-3.5 mr-1" /> {a.status === "APPROVED" ? "Edit (revision)" : "Edit"}
                    </Button>
                  )}
                  {can("kpi", "edit") && a.status !== "CANCELLED" && (
                    <Button variant="outline" className="text-rose-600 hover:text-rose-700" onClick={() => setCancelOpen(true)} disabled={busy}>
                      <Ban className="h-3.5 w-3.5 mr-1" /> Cancel
                    </Button>
                  )}
                </div>
                <div className="flex gap-2">
                  <Button variant="outline" onClick={() => onOpenChange(false)}>Close</Button>
                  {can("kpi", "approve") && a.status === "PENDING_APPROVAL" && <ApprovalActions busy={busy} onDecide={decide} />}
                </div>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      {editOpen && a && (
        <TargetEditDialog open={editOpen} onOpenChange={(v) => { setEditOpen(v); if (!v) { load(); onChanged() } }} target={a} />
      )}
      <ConfirmDialog open={cancelOpen} onOpenChange={setCancelOpen} title="Cancel KPI target" danger confirmLabel="Cancel Target"
        requireReason
        message={`Cancel the KPI target for ${a?.employee?.fullName} (${a?.periodLabel})? The employee keeps visibility of the cancelled record.`}
        onConfirm={async (reason) => { await rpc("kpi.targets.cancel", { id, reason: reason || "" }); setCancelOpen(false); await load(); onChanged() }} />
    </>
  )
}

// ---------------------------------------------------------------------------
// Target edit — approved targets roll into a revision + re-approval
// ---------------------------------------------------------------------------

function TargetEditDialog({ open, onOpenChange, target }: { open: boolean; onOpenChange: (v: boolean) => void; target: any }) {
  const toast = useHrm((s) => s.toast)
  const [dueDate, setDueDate] = useState(target?.dueDate || "")
  const [remarks, setRemarks] = useState(target?.remarks || "")
  const [inds, setInds] = useState<any[]>(() => (target?.indicators || []).map((i: any, idx: number) => ({
    key: `e-${i.id}-${idx}`, id: i.id, indicatorId: i.indicatorId, name: i.name, builtinKey: i.builtinKey,
    unit: i.unit, unitLabel: i.unitLabel, direction: i.direction, weight: i.weight, targetValue: i.targetValue ?? "",
    hasAchievement: !!i.achievement,
  })))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const wasApproved = target?.status === "APPROVED"
  const totalWeight = inds.reduce((s, i) => s + (Number(i.weight) || 0), 0)

  const submit = async (resubmit: boolean) => {
    setBusy(true)
    setError(null)
    try {
      await rpc("kpi.targets.update", {
        id: target.id,
        dueDate: dueDate || null,
        remarks,
        resubmit,
        indicators: inds.map((i, idx) => ({
          id: i.id || undefined,
          indicatorId: i.indicatorId || null, name: i.name, builtinKey: i.builtinKey, unit: i.unit,
          unitLabel: i.unitLabel, direction: i.direction, weight: Number(i.weight) || 0,
          targetValue: i.targetValue === "" ? null : Number(i.targetValue), sortOrder: idx + 1,
        })),
      })
      toast(wasApproved ? "Revision submitted — the previous approved target is archived and awaits re-approval" : resubmit ? "Target submitted for approval" : "Draft updated")
      onOpenChange(false)
    } catch (e: any) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  const setInd = (key: string, patch: any) => setInds((arr) => arr.map((i) => (i.key === key ? { ...i, ...patch } : i)))

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!busy) onOpenChange(v) }}>
      <DialogContent className="sm:max-w-3xl max-h-[92vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-base">Edit KPI Target — {target?.employee?.fullName}</DialogTitle>
          <p className="text-xs text-slate-500">
            {wasApproved
              ? "This target is APPROVED — editing archives the current approved state and resubmits it for re-approval (revision)."
              : target?.status === "DRAFT" ? "Draft — save changes or submit for approval." : "Edit and resubmit for approval."}
          </p>
        </DialogHeader>
        <div className="space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs font-medium">Due Date</Label>
              <Input type="date" className="h-9" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs font-medium">Remarks</Label>
              <Input className="h-9" value={remarks} onChange={(e) => setRemarks(e.target.value)} />
            </div>
          </div>
          <div className="rounded-xl border overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-slate-50 dark:bg-slate-800/60 text-[10px] uppercase tracking-wide text-slate-400">
                  <th className="text-left font-semibold px-3 py-2">Indicator</th>
                  <th className="text-right font-semibold px-3 py-2 w-28">Target</th>
                  <th className="text-right font-semibold px-3 py-2 w-24">Weight %</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {inds.map((i) => (
                  <tr key={i.key}>
                    <td className="px-3 py-2">
                      <p className="text-sm font-medium text-slate-800 dark:text-slate-100">{i.name}</p>
                      <p className="text-[10px] text-slate-400">{directionShort(i.direction)} · {unitLabel(i.unit, i.unitLabel) || i.unit}{i.hasAchievement ? " · has achievement data" : ""}</p>
                    </td>
                    <td className="px-3 py-2"><Input className="h-8 text-xs tabular-nums" type="number" value={i.targetValue} onChange={(e) => setInd(i.key, { targetValue: e.target.value })} /></td>
                    <td className="px-3 py-2"><Input className="h-8 text-xs tabular-nums" type="number" value={i.weight} onChange={(e) => setInd(i.key, { weight: e.target.value })} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Badge className={`${Math.round(totalWeight * 100) === 10000 ? "bg-emerald-100 text-emerald-700" : "bg-amber-100 text-amber-700"} text-[10px] tabular-nums`}>
            Total weight: {Math.round(totalWeight * 100) / 100}%
          </Badge>
        </div>
        {error && <ErrorBanner message={error} />}
        <DialogFooter className="gap-2 sm:justify-between">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
          <div className="flex gap-2">
            {!wasApproved && target?.status === "DRAFT" && (
              <Button variant="outline" disabled={busy || Math.round(totalWeight * 100) !== 10000} onClick={() => submit(false)}>Save Draft</Button>
            )}
            <Button disabled={busy || Math.round(totalWeight * 100) !== 10000} onClick={() => submit(true)}>
              {busy ? "Submitting…" : wasApproved ? "Submit Revision for Re-approval" : "Submit for Approval"}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

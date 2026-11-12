"use client"
// ============ KPI Target Achievement tab (2026-11 redesign) ============
// Actual employee KPI achievement data — single employee update (with live
// built-in prefill) and bulk Excel upload, both entering mandatory approval.
// Achievement entry is only possible against APPROVED targets.
import { useEffect, useMemo, useState } from "react"
import {
  Users, Upload, UserCheck, FileSpreadsheet, ArrowLeft, ArrowRight, Download, CheckCircle2, XCircle,
  Layers, History, ChevronRight, ChevronDown, Pencil, ShieldCheck, Sparkles,
} from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Label } from "@/components/ui/label"
import { Checkbox } from "@/components/ui/checkbox"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { useHrm } from "../../store"
import { rpc, useApi, useLookup } from "../../api"
import { StatCard, StatusBadge, EmptyState, ErrorBanner, fmtDate, fmtDateTime } from "../../shared/ui-kit"
import { DataTable, type Column } from "../../shared/data-table"
import { useServerPagedList, PagedControls } from "../../server-paged"
import {
  ApprovalActions, PeriodPicker, RatingBadge, ScoreBadge, downloadBase64File,
  downloadErrorReport, fmtPeriod, fmtStatus, readFileAsBase64, unitLabel, directionShort,
} from "./shared"

const ACH_STATUS_OPTIONS = [
  { value: "NOT_UPLOADED", label: "Not Uploaded" },
  { value: "PENDING_APPROVAL", label: "Pending Approval" },
  { value: "APPROVED", label: "Approved" },
  { value: "REJECTED", label: "Rejected" },
  { value: "CHANGES_REQUESTED", label: "Changes Requested" },
]

export default function KpiAchievementsTab() {
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

  const { data: summary, reload: reloadSummary } = useApi<any>("kpi.achievements.summary", filters)
  const { rows, total, page, maxPage, loading, error, reload, setPage } = useServerPagedList<any>("kpi.achievements.list", filters, pageSize)
  const [updateOpen, setUpdateOpen] = useState(false)
  const [bulkOpen, setBulkOpen] = useState(false)
  const [batchesOpen, setBatchesOpen] = useState(false)
  const [detailId, setDetailId] = useState<string | null>(null)

  // Reset selection when rows change (page / filter change)
  useEffect(() => { setSelected(new Set()) }, [rows])

  const allPendingIds = rows.filter((r: any) => r.status === "PENDING_APPROVAL").map((r: any) => r.assignmentId)
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
      for (const assignmentId of selected) {
        try { await rpc("kpi.achievements.decide", { assignmentId, decision: "APPROVE" }); done++ } catch { /* skip */ }
      }
      toast(`Approved ${done} of ${selected.size} achievement(s)`)
      setSelected(new Set())
      reload(); reloadSummary()
    } finally { setApprovingAll(false) }
  }

  const bulkDecide = async (decision: "REQUEST_CHANGES" | "REJECT", comment: string) => {
    if (!selected.size || bulkActionBusy) return
    setBulkActionBusy(true)
    try {
      let done = 0
      for (const assignmentId of selected) {
        try { await rpc("kpi.achievements.decide", { assignmentId, decision, comment }); done++ } catch { /* skip */ }
      }
      const label = decision === "REJECT" ? "Rejected" : "Changes requested for"
      toast(`${label} ${done} of ${selected.size} achievement(s)`)
      setSelected(new Set())
      setReasonDialog(null)
      reload(); reloadSummary()
    } finally { setBulkActionBusy(false) }
  }

  const unitTotals = Object.entries(summary?.unitTotals || {}) as [string, { label: string; target: number; achieved: number; count: number }][]

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
          checked={selected.has(r.assignmentId)}
          onCheckedChange={() => toggleRow(r.assignmentId)}
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
    { key: "periodLabel", label: "Period", render: (r) => <Badge variant="outline" className="text-[10px] tabular-nums">{r.periodDisplay}</Badge> },
    {
      key: "dueDate", label: "Due Date", sortValue: (r) => r.dueDate || "",
      render: (r) => <span className="text-xs text-slate-500">{r.dueDate ? fmtDate(r.dueDate) : "—"}</span>,
    },
    {
      key: "indicators", label: "Indicators & Target", render: (r) => (
        <div className="flex flex-wrap gap-1 max-w-md">
          {(r.indicators || []).slice(0, 3).map((i: any) => (
            <Badge key={i.id} variant="outline" className="text-[9px] tabular-nums gap-1">
              {i.indicatorName}: <b>{i.actualValue ?? "—"}{unitLabel(i.unit)}</b> / {i.targetValue ?? "—"}
            </Badge>
          ))}
          {r.totalIndicators > 3 && <Badge variant="outline" className="text-[9px]">{r.uploadedIndicators}/{r.totalIndicators} recorded</Badge>}
          {!r.indicators?.length && <span className="text-[10px] text-slate-400">no achievement data yet</span>}
        </div>
      ),
    },
    { key: "status", label: "Status", render: (r) => <StatusBadge status={r.status} /> },
    { key: "score", label: "Score", align: "right", sortValue: (r) => r.score ?? -1, render: (r) => <ScoreBadge score={r.score} /> },
  ]

  return (
    <div className="space-y-4">
      {/* period selector, filters + actions */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium text-slate-500">Period:</span>
        <PeriodPicker value={periodLabel} onChange={setPeriodLabel} />
        <div className="w-full sm:w-52">
          <Select value={departmentId || "all"} onValueChange={(v) => setDepartmentId(v === "all" ? "" : v)}>
            <SelectTrigger className="h-8 text-xs"><SelectValue placeholder="Department" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All departments</SelectItem>
              {(departments || []).map((d: any) => <SelectItem key={d.id} value={d.id}>{d.name}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div className="w-full sm:w-44">
          <Select value={status || "all"} onValueChange={(v) => setStatus(v === "all" ? "" : v)}>
            <SelectTrigger className="h-8 text-xs"><SelectValue placeholder="Status" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              {ACH_STATUS_OPTIONS.map((s) => <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div className="flex-1" />
        {can("kpi", "edit") && (
          <>
            <Button size="sm" className="h-8 text-xs" onClick={() => setUpdateOpen(true)}>
              <UserCheck className="h-3.5 w-3.5 mr-1" /> Update Achievement
            </Button>
            <Button size="sm" variant="outline" className="h-8 text-xs" onClick={() => setBulkOpen(true)}>
              <Upload className="h-3.5 w-3.5 mr-1" /> Bulk Achievement
            </Button>
          </>
        )}
        <Button size="sm" variant="outline" className="h-8 text-xs" onClick={() => setBatchesOpen(true)}>
          <Layers className="h-3.5 w-3.5 mr-1" /> Bulk Review
        </Button>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
        <StatCard label="Eligible Employees" value={summary?.totalEligible ?? "—"} sub="approved targets" icon={Users} tone="slate" />
        <StatCard label="Data Uploaded" value={summary?.uploaded ?? "—"} icon={Upload} tone="emerald" />
        <StatCard label="Not Uploaded" value={summary?.notUploaded ?? "—"} icon={XCircle} tone="rose" />
        <StatCard label="Pending Approval" value={summary?.pendingApproval ?? "—"} icon={ShieldCheck} tone="amber" />
        <StatCard label="Approved" value={summary?.approved ?? "—"} icon={CheckCircle2} tone="emerald" />
        <StatCard label="Rejected" value={summary?.rejected ?? "—"} icon={XCircle} tone="rose" />
      </div>
      {unitTotals.length > 0 && (
        <div className="rounded-xl border p-3">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400 mb-2">Total KPI Target vs Achieved (approved, unit-aware)</p>
          <div className="flex flex-wrap gap-2">
            {unitTotals.map(([key, v]) => (
              <Badge key={key} variant="outline" className="text-[10px] tabular-nums gap-1.5 py-1">
                {v.label}: <b className="text-emerald-600">{Math.round(v.achieved * 100) / 100}</b> / {Math.round(v.target * 100) / 100} ({v.count} indicator records)
              </Badge>
            ))}
          </div>
          <p className="text-[10px] text-slate-400 mt-1.5">Incompatible measurement units are never merged into one meaningless total — each unit is summarized separately.</p>
        </div>
      )}

      <DataTable columns={columns} rows={rows} loading={loading} error={error} dense
        pageSize={pageSize}
        searchPlaceholder="Search employee…"
        onSearch={setSearch}
        onRowClick={(r) => setDetailId(r.assignmentId)}
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
        emptyTitle="No achievement data" emptyHint="Achievements are recorded against approved KPI targets — approve targets first (KPI Target Assignments tab)." />

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
              This will apply to <strong>{selected.size}</strong> selected achievement{selected.size !== 1 ? "s" : ""}.
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

      <SingleAchievementDialog open={updateOpen} onOpenChange={(v) => { setUpdateOpen(v); if (!v) { reload(); reloadSummary() } }} />
      <BulkAchievementWizard open={bulkOpen} onOpenChange={(v) => { setBulkOpen(v); if (!v) { reload(); reloadSummary() } }} />
      <AchievementBatchesDialog open={batchesOpen} onOpenChange={setBatchesOpen} onChanged={reload} />
      <AchievementDetailDrawer id={detailId} onOpenChange={(v) => { if (!v) setDetailId(null) }} onChanged={() => { reload(); reloadSummary() }} />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Single employee achievement update (built-in values pre-computed)
// ---------------------------------------------------------------------------

function SingleAchievementDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const toast = useHrm((s) => s.toast)
  const [employeeId, setEmployeeId] = useState("")
  const [assignments, setAssignments] = useState<any[]>([])
  const [assignmentId, setAssignmentId] = useState("")
  const [detail, setDetail] = useState<any>(null)
  const [values, setValues] = useState<Record<string, string>>({})
  const [remarks, setRemarks] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const dir = useEmployeeDir()
  const refs = dir || []

  // load the employee's approved target assignments
  useEffect(() => {
    if (!employeeId || !open) { setAssignments([]); setAssignmentId(""); setDetail(null); return }
    let cancelled = false
    ;(async () => {
      try {
        const res = await rpc<any>("kpi.achievements.list", { employeeId, pageSize: 100 })
        if (cancelled) return
        setAssignments(res?.items || [])
        setAssignmentId(res?.items?.[0]?.assignmentId || "")
      } catch (e: any) {
        if (!cancelled) setError(e.message)
      }
    })()
    return () => { cancelled = true }
     
  }, [employeeId, open])

  // load indicators + prefill built-ins
  useEffect(() => {
    if (!assignmentId || !open) { setDetail(null); setValues({}); setRemarks({}); return }
    let cancelled = false
    ;(async () => {
      try {
        const res = await rpc<any>("kpi.achievements.get", { assignmentId })
        if (cancelled) return
        setDetail(res)
        const v: Record<string, string> = {}
        for (const i of res.indicators || []) {
          v[i.id] = i.achievement?.actualValue != null ? String(i.achievement.actualValue) : ""
        }
        setValues(v)
        // pre-compute built-in values from live Finix HR data
        const pre = await rpc<any>("kpi.achievements.prefill", { assignmentId })
        if (cancelled) return
        if (pre?.values?.length) {
          setValues((prev) => {
            const next = { ...prev }
            for (const p of pre.values) {
              if (next[p.indicatorRowId] === "" && p.value != null) next[p.indicatorRowId] = String(p.value)
            }
            return next
          })
        }
      } catch (e: any) {
        if (!cancelled) setError(e.message)
      }
    })()
    return () => { cancelled = true }
     
  }, [assignmentId, open])

  const submit = async (submitForApproval: boolean) => {
    setBusy(true)
    setError(null)
    try {
      const vals = Object.entries(values)
        .filter(([, v]) => v !== "")
        .map(([indicatorRowId, v]) => ({
          indicatorRowId,
          actualValue: Number(v),
          ...(remarks[indicatorRowId] ? { remarks: remarks[indicatorRowId] } : {}),
        }))
      if (!vals.length) throw new Error("Enter at least one achievement value")
      const res = await rpc("kpi.achievements.update", { assignmentId, values: vals, submit: submitForApproval })
      toast(`${res.updated} indicator value(s) ${submitForApproval ? "submitted for approval" : "saved as draft"}`)
      onOpenChange(false)
      setEmployeeId(""); setAssignmentId(""); setDetail(null); setValues({})
    } catch (e: any) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  const prefilledBuiltins = new Set<string>()
  if (detail) for (const i of detail.indicators || []) if (i.source === "BUILTIN") prefilledBuiltins.add(i.id)

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!busy) onOpenChange(v) }}>
      <DialogContent className="sm:max-w-2xl max-h-[92vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-base">Update Single Employee Achievement</DialogTitle>
          <p className="text-xs text-slate-500">Only approved KPI targets are listed. Built-in indicators are pre-filled with live Finix HR data — review and adjust before submitting.</p>
        </DialogHeader>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div className="space-y-1.5">
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
            <Label className="text-xs font-medium">Approved Target Period <span className="text-rose-500">*</span></Label>
            <Select value={assignmentId || "none"} onValueChange={(v) => setAssignmentId(v === "none" ? "" : v)} disabled={!employeeId}>
              <SelectTrigger className="h-9"><SelectValue placeholder={employeeId ? "No approved targets" : "Select employee first"} /></SelectTrigger>
              <SelectContent>
                <SelectItem value="none" disabled>{assignments.length ? "Select period…" : "No approved targets for this employee"}</SelectItem>
                {assignments.map((a: any) => (
                  <SelectItem key={a.assignmentId} value={a.assignmentId}>{a.periodDisplay}{a.status !== "APPROVED" ? ` — ${fmtStatus(a.status)}` : ""}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        {detail && (
          <div className="space-y-2 max-h-[46vh] overflow-y-auto pr-1">
            {(detail.indicators || []).map((i: any) => {
              const isBuiltin = i.source === "BUILTIN" || !!i.builtinKey
              return (
                <div key={i.id} className="rounded-xl border border-slate-200 dark:border-slate-800 p-3 space-y-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-sm font-medium text-slate-800 dark:text-slate-100 flex items-center gap-1.5">
                      {i.name}
                      {isBuiltin && <Badge variant="secondary" className="text-[9px]">Built-in (locked)</Badge>}
                      {i.achievement?.status === "APPROVED" && <Badge className="bg-emerald-100 text-emerald-700 text-[9px]">approved — editing creates a revision</Badge>}
                    </p>
                    <span className="text-[10px] text-slate-400 shrink-0">target {i.targetValue ?? "—"}{unitLabel(i.unit, i.unitLabel)} · {directionShort(i.direction)} · w {i.weight}%</span>
                  </div>
                  <div className="grid grid-cols-3 gap-2">
                    <div className="col-span-1">
                      <Label className="text-[10px] text-slate-400">Actual achievement</Label>
                      <Input
                        className="h-8 text-xs tabular-nums disabled:bg-slate-100 dark:disabled:bg-slate-800 disabled:text-slate-500 disabled:cursor-not-allowed"
                        type="number"
                        value={values[i.id] ?? ""}
                        placeholder={isBuiltin ? "System" : "—"}
                        disabled={isBuiltin}
                        onChange={(e) => setValues((v) => ({ ...v, [i.id]: e.target.value }))}
                      />
                    </div>
                    <div className="col-span-2">
                      <Label className="text-[10px] text-slate-400">Remarks / evidence note</Label>
                      <Input
                        className="h-8 text-xs disabled:bg-slate-100 dark:disabled:bg-slate-800 disabled:text-slate-500 disabled:cursor-not-allowed"
                        value={remarks[i.id] ?? ""}
                        onChange={(e) => setRemarks((r) => ({ ...r, [i.id]: e.target.value }))}
                        placeholder={isBuiltin ? "System computed" : "Optional"}
                        disabled={isBuiltin}
                      />
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        )}
        {error && <ErrorBanner message={error} />}
        <DialogFooter className="gap-2 sm:justify-between">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
          <div className="flex gap-2">
            <Button variant="outline" disabled={busy || !assignmentId} onClick={() => submit(false)}>Save as Draft</Button>
            <Button disabled={busy || !assignmentId} onClick={() => submit(true)}>
              <Sparkles className="h-3.5 w-3.5 mr-1" /> {busy ? "Submitting…" : "Submit for Approval"}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function useEmployeeDir(): any[] | null {
  const [dir, setDir] = useState<any[] | null>(null)
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const res = await rpc<any>("employees.refList", { take: 10000 })
        if (!cancelled) setDir(res?.refs || [])
      } catch { if (!cancelled) setDir([]) }
    })()
    return () => { cancelled = true }
  }, [])
  return dir
}

// ---------------------------------------------------------------------------
// Bulk achievement wizard
// ---------------------------------------------------------------------------

const BULK_ACH_STEPS = [
  { title: "Select Filters", hint: "Department + period — the template is generated from approved target assignments" },
  { title: "Download Template", hint: "One row per (employee, manual indicator) — built-ins are computed from system data" },
  { title: "Upload & Validate", hint: "Every row validated against the approved assignments" },
  { title: "Submit", hint: "All uploaded records enter Pending Approval — never auto-approved" },
]

function BulkAchievementWizard({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const toast = useHrm((s) => s.toast)
  const { data: departments } = useLookup<any[]>("departments.list", {})
  const [step, setStep] = useState(0)
  const [departmentId, setDepartmentId] = useState("")
  const [periodLabel, setPeriodLabel] = useState(() => `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, "0")}`)
  const [templateInfo, setTemplateInfo] = useState<any>(null)
  const [file, setFile] = useState<File | null>(null)
  const [preview, setPreview] = useState<any>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (open) { setStep(0); setTemplateInfo(null); setFile(null); setPreview(null); setError(null) }
     
  }, [open])

  const config = { departmentId: departmentId || null, periodLabel }

  const downloadTemplate = async () => {
    setBusy(true)
    setError(null)
    try {
      const res = await rpc<any>("kpi.achievements.bulkTemplate", config)
      downloadBase64File(res)
      setTemplateInfo(res)
      toast(`Template downloaded — ${res.rows} row(s) from ${res.assignments} approved assignment(s)`)
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
      const res = await rpc<any>("kpi.achievements.bulkPreview", { ...config, base64 })
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
      const res = await rpc<any>("kpi.achievements.bulkSubmit", { ...config, base64 })
      toast(`Uploaded — ${res.updated} value(s) across ${res.employees} employee(s) submitted for approval`)
      onOpenChange(false)
    } catch (e: any) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  const summary = preview?.summary

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!busy) onOpenChange(v) }}>
      <DialogContent className="sm:max-w-4xl max-h-[92vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-base flex items-center gap-2"><FileSpreadsheet className="h-4 w-4 text-emerald-600" /> Bulk Achievement Upload</DialogTitle>
          <div className="flex items-center gap-1.5 pt-1">
            {BULK_ACH_STEPS.map((s, i) => (
              <div key={s.title} className={`flex-1 rounded-md px-2 py-1.5 ${i === step ? "bg-emerald-50 dark:bg-emerald-950/50 border border-emerald-200 dark:border-emerald-900" : i < step ? "" : "opacity-50"}`}>
                <div className="flex items-center gap-1.5">
                  <span className={`h-4 w-4 rounded-full text-[9px] font-bold flex items-center justify-center ${i <= step ? "bg-emerald-500 text-white" : "bg-slate-200 text-slate-500"}`}>{i + 1}</span>
                  <span className={`text-[11px] font-semibold ${i === step ? "text-emerald-700 dark:text-emerald-300" : "text-slate-500"}`}>{s.title}</span>
                </div>
              </div>
            ))}
          </div>
          <p className="text-[11px] text-slate-500">{BULK_ACH_STEPS[step].hint}</p>
        </DialogHeader>

        {step === 0 && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 py-2">
            <div className="space-y-1.5">
              <Label className="text-xs font-medium">Department (optional)</Label>
              <Select value={departmentId || "all"} onValueChange={(v) => setDepartmentId(v === "all" ? "" : v)}>
                <SelectTrigger className="h-9 text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All departments</SelectItem>
                  {(departments || []).map((d: any) => <SelectItem key={d.id} value={d.id}>{d.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs font-medium">Period <span className="text-rose-500">*</span></Label>
              <PeriodPicker value={periodLabel} onChange={setPeriodLabel} />
            </div>
          </div>
        )}

        {step === 1 && (
          <div className="rounded-xl border border-emerald-200 dark:border-emerald-900 bg-emerald-50/50 dark:bg-emerald-950/20 p-4 space-y-2">
            <p className="text-sm font-medium text-emerald-800 dark:text-emerald-300 flex items-center gap-1.5"><Download className="h-4 w-4" /> Achievement template (from approved assignments)</p>
            <p className="text-xs text-slate-600 dark:text-slate-300">
              Generated from the approved KPI target assignments for manual indicators. System built-in indicators
              (attendance, leave, etc.) are computed automatically from live Finix HR data and do not require manual input.
              Indicators that already have submitted or approved achievements are skipped at validation.
            </p>
            {templateInfo && (
              <div className="flex flex-wrap gap-2 text-xs">
                <Badge variant="outline">{templateInfo.assignments} assignments</Badge>
                <Badge variant="outline">{templateInfo.rows} manual rows</Badge>
                {templateInfo.prefilledBuiltins > 0 && <Badge variant="outline">{templateInfo.prefilledBuiltins} pre-filled built-ins</Badge>}
              </div>
            )}
            <Button className="h-9" onClick={downloadTemplate} disabled={busy}>
              <Download className="h-3.5 w-3.5 mr-1.5" /> {busy ? "Generating…" : "Download Excel Template"}
            </Button>
          </div>
        )}

        {step === 2 && (
          <div className="space-y-3 py-2">
            <div className="rounded-xl border border-dashed border-slate-300 dark:border-slate-700 p-6 text-center">
              <Upload className="h-8 w-8 mx-auto text-slate-400 mb-2" />
              <p className="text-sm font-medium text-slate-700 dark:text-slate-200">Upload the completed Excel file</p>
              <p className="text-xs text-slate-500 mb-3">.xlsx only · Employee ID + Indicator ID columns are authoritative</p>
              <input type="file" accept=".xlsx" className="hidden" id="kpi-ach-file"
                onChange={(e) => { setFile(e.target.files?.[0] || null); setPreview(null) }} />
              <Button variant="outline" className="h-9" onClick={() => document.getElementById("kpi-ach-file")?.click()}>
                {file ? file.name : "Choose file"}
              </Button>
            </div>
            <Button className="w-full h-10" disabled={!file || busy} onClick={uploadAndPreview}>
              {busy ? "Validating…" : "Validate & Preview"} <ArrowRight className="h-3.5 w-3.5 ml-1.5" />
            </Button>
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
                { label: "Skipped", value: summary.skipped, tone: "amber" },
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
                    <th className="text-left font-semibold px-3 py-2">Indicator</th>
                    <th className="text-left font-semibold px-3 py-2">Status</th>
                    <th className="text-left font-semibold px-3 py-2">Detail</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {(preview.rows || []).slice(0, 200).map((r: any) => (
                    <tr key={r.rowNo}>
                      <td className="px-3 py-1.5 text-xs tabular-nums text-slate-400">{r.rowNo}</td>
                      <td className="px-3 py-1.5 text-xs">{r.employeeName} <span className="text-slate-400">{r.employeeCode}</span></td>
                      <td className="px-3 py-1.5 text-xs text-slate-600 dark:text-slate-300">{r.indicatorName}</td>
                      <td className="px-3 py-1.5">
                        <Badge className={r.status === "READY" ? "bg-emerald-100 text-emerald-700" : r.status === "ERROR" ? "bg-rose-100 text-rose-700" : "bg-amber-100 text-amber-700"}>{r.status}</Badge>
                      </td>
                      <td className="px-3 py-1.5 text-[11px] text-slate-500 max-w-sm">{r.error || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {(preview.rows || []).length > 200 && <p className="text-[10px] text-slate-400 px-3 py-2">Showing the first 200 of {preview.rows.length} rows</p>}
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
            {step === 0 && <Button onClick={() => setStep(1)} disabled={!periodLabel}>Next <ArrowRight className="h-3.5 w-3.5 ml-1" /></Button>}
            {step === 1 && <Button onClick={() => setStep(2)} disabled={!templateInfo}>I&apos;ve filled the file <ArrowRight className="h-3.5 w-3.5 ml-1" /></Button>}
            {step === 2 && <Button onClick={uploadAndPreview} disabled={!file || busy}>{busy ? "Validating…" : "Validate & Preview"}</Button>}
            {step === 3 && (
              <Button onClick={submit} disabled={busy || !(summary?.valid)}>
                {busy ? "Submitting…" : <>Submit {summary?.valid || 0} Record(s) <CheckCircle2 className="h-3.5 w-3.5 ml-1" /></>}
              </Button>
            )}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------
// Achievement batches (bulk review)
// ---------------------------------------------------------------------------

function AchievementBatchesDialog({ open, onOpenChange, onChanged }: { open: boolean; onOpenChange: (v: boolean) => void; onChanged: () => void }) {
  const { can } = useHrm()
  const [status, setStatus] = useState("PENDING_APPROVAL")
  const { rows, total, page, pageSize, maxPage, loading, error, reload, setPage } = useServerPagedList<any>("kpi.achievements.batches", { status: status || undefined }, 10)
  const [openBatchId, setOpenBatchId] = useState<string | null>(null)

  return (
    <>
      <Dialog open={open && !openBatchId} onOpenChange={(v) => { onOpenChange(v); if (!v) { reload(); onChanged() } }}>
        <DialogContent className="sm:max-w-3xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="text-base flex items-center gap-2"><Layers className="h-4 w-4 text-emerald-600" /> Achievement Upload Batches</DialogTitle>
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
              {rows.length === 0 && <EmptyState icon={Layers} title="No batches" hint="Bulk achievement uploads appear here for review." />}
              {rows.map((b) => (
                <button key={b.id} type="button"
                  className="w-full text-left rounded-xl border border-slate-200 dark:border-slate-800 p-3 hover:border-emerald-300 dark:hover:border-emerald-800 hover:bg-emerald-50/30 dark:hover:bg-emerald-950/20 transition"
                  onClick={() => setOpenBatchId(b.id)}>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">{b.departmentName || "All departments"} · {fmtPeriod(b.periodLabel)}</p>
                      <p className="text-[11px] text-slate-500">{b.validCount} record(s) · by {b.createdByName || "—"} · {fmtDateTime(b.createdAt)}</p>
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
      <AchievementBatchReview batchId={openBatchId} onOpenChange={(v) => { if (!v) { setOpenBatchId(null); reload() } }} onChanged={onChanged} />
    </>
  )
}

function AchievementBatchReview({ batchId, onOpenChange, onChanged }: { batchId: string | null; onOpenChange: (v: boolean) => void; onChanged: () => void }) {
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
      setData(await rpc<any>("kpi.achievements.batchGet", { id: batchId }))
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { setSelected(new Set()); load()   }, [batchId])

  const pending = (data?.employees || []).filter((e: any) => e.status === "PENDING_APPROVAL")
  const act = async (decision: any, comment?: string) => {
    setBusy(true)
    try {
      const res = await rpc<any>("kpi.achievements.batchDecide", {
        id: batchId, decision,
        ...(selected.size ? { ids: [...selected] } : {}),
        ...(comment ? { comment } : {}),
      })
      toast(`Decided ${res.decided} employee set(s), ${res.skipped?.length || 0} skipped`)
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
          <DialogTitle className="text-base">Achievement Batch Review — Target vs Actual</DialogTitle>
          {data?.batch && (
            <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
              <StatusBadge status={data.batch.status} />
              <span>{data.batch.departmentName || "All departments"}</span>
              <Badge variant="outline" className="text-[10px]">{fmtPeriod(data.batch.periodLabel)}</Badge>
              <span>· by {data.batch.createdByName || "—"} · {fmtDateTime(data.batch.createdAt)}</span>
            </div>
          )}
        </DialogHeader>
        {loading ? <p className="text-xs text-slate-500 py-6 text-center">Loading…</p> : error ? <ErrorBanner message={error} /> : data && (
          <>
            {pending.length > 0 && can("kpi", "approve") && (
              <div className="rounded-xl border border-emerald-200 dark:border-emerald-900 bg-emerald-50/40 dark:bg-emerald-950/20 p-3 space-y-2">
                <p className="text-xs text-slate-600 dark:text-slate-300">
                  {selected.size ? `${selected.size} employee set(s) selected` : `${pending.length} employee set(s) pending — acting without a selection applies to ALL pending records.`}
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
                      <p className="text-[11px] text-slate-500">{(e.indicators || []).length} indicator record(s)</p>
                    </button>
                    <StatusBadge status={e.status} />
                    {expanded === e.assignmentId ? <ChevronDown className="h-4 w-4 text-slate-400" /> : <ChevronRight className="h-4 w-4 text-slate-400" />}
                  </div>
                  {expanded === e.assignmentId && (
                    <div className="px-8 pb-3 overflow-x-auto">
                      <table className="w-full text-xs">
                        <thead>
                          <tr className="text-[10px] uppercase tracking-wide text-slate-400 border-b">
                            <th className="text-left font-semibold py-1.5">Indicator</th>
                            <th className="text-right font-semibold py-1.5">Target</th>
                            <th className="text-right font-semibold py-1.5">Actual</th>
                            <th className="text-right font-semibold py-1.5">Ach. %</th>
                            <th className="text-right font-semibold py-1.5">Score</th>
                          </tr>
                        </thead>
                        <tbody>
                          {(e.indicators || []).map((i: any) => (
                            <tr key={i.id}>
                              <td className="py-1.5 font-medium text-slate-700 dark:text-slate-200">{i.indicatorName}</td>
                              <td className="py-1.5 text-right tabular-nums">{i.targetValue ?? "—"}</td>
                              <td className="py-1.5 text-right tabular-nums font-semibold">{i.actualValue ?? "—"}</td>
                              <td className="py-1.5 text-right tabular-nums">{i.achievementPct != null ? `${i.achievementPct}%` : "—"}</td>
                              <td className="py-1.5 text-right tabular-nums">{i.score ?? "—"}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              ))}
            </div>
            {(data.history || []).length > 0 && (
              <details className="rounded-xl border p-3">
                <summary className="text-xs font-semibold text-slate-600 dark:text-slate-300 flex items-center gap-1 cursor-pointer"><History className="h-3.5 w-3.5" /> Batch history</summary>
                <div className="mt-2 space-y-1">
                  {data.history.map((h: any) => (
                    <p key={h.id} className="text-[11px] text-slate-500"><b>{h.actorName || "—"}</b> · {fmtStatus(h.action)} · {fmtDateTime(h.createdAt)}{h.comment ? ` — ${h.comment}` : ""}</p>
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
// Achievement detail drawer (per employee + period)
// ---------------------------------------------------------------------------

function AchievementDetailDrawer({ id, onOpenChange, onChanged }: { id: string | null; onOpenChange: (v: boolean) => void; onChanged: () => void }) {
  const { can } = useHrm()
  const toast = useHrm((s) => s.toast)
  const [data, setData] = useState<any>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [editOpen, setEditOpen] = useState(false)
  const [busy, setBusy] = useState(false)

  const load = async () => {
    if (!id) return
    setLoading(true)
    setError(null)
    try {
      setData(await rpc<any>("kpi.achievements.get", { assignmentId: id }))
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
      await rpc("kpi.achievements.decide", { assignmentId: id, decision, comment })
      toast(`Achievements ${decision === "APPROVE" ? "approved" : decision === "REJECT" ? "rejected" : "returned"}`)
      await load()
      onChanged()
    } finally {
      setBusy(false)
    }
  }

  if (!id) return null
  const hasPending = (data?.indicators || []).some((i: any) => i.achievement?.status === "PENDING_APPROVAL")
  return (
    <>
      <Dialog open={!!id && !editOpen} onOpenChange={(v) => { if (!v) onOpenChange(false) }}>
        <DialogContent className="sm:max-w-3xl max-h-[92vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="text-base">KPI Achievement — {data?.employee?.fullName || "…"}</DialogTitle>
            {data?.assignment && (
              <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
                <Badge variant="outline" className="text-[10px]">{data.assignment.periodDisplay}</Badge>
                {data.assignment.dueDate && <span>· due {fmtDate(data.assignment.dueDate)}</span>}
                {data.assignment.rating && <RatingBadge rating={data.assignment.rating} />}
                {data.assignment.totalScore ? <ScoreBadge score={data.assignment.totalScore} /> : null}
              </div>
            )}
          </DialogHeader>
          {loading ? <p className="text-xs text-slate-500 py-6 text-center">Loading…</p> : error ? <ErrorBanner message={error} /> : data && (
            <>
              <div className="rounded-xl border overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-slate-50 dark:bg-slate-800/60 text-[10px] uppercase tracking-wide text-slate-400">
                      <th className="text-left font-semibold px-3 py-2">Indicator</th>
                      <th className="text-right font-semibold px-3 py-2">Target</th>
                      <th className="text-right font-semibold px-3 py-2">Actual</th>
                      <th className="text-right font-semibold px-3 py-2">Ach. %</th>
                      <th className="text-right font-semibold px-3 py-2">Weight</th>
                      <th className="text-right font-semibold px-3 py-2">Score</th>
                      <th className="text-left font-semibold px-3 py-2">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                    {(data.indicators || []).map((i: any) => {
                      const a = i.achievement
                      return (
                        <tr key={i.id}>
                          <td className="px-3 py-2">
                            <p className="text-sm font-medium text-slate-800 dark:text-slate-100">{i.name}</p>
                            <p className="text-[10px] text-slate-400">{directionShort(i.direction)} · {unitLabel(i.unit, i.unitLabel) || i.unit}{a?.revision && a.revision > 1 ? ` · rev ${a.revision}` : ""}</p>
                          </td>
                          <td className="px-3 py-2 text-right text-xs tabular-nums">{i.targetValue ?? "—"}</td>
                          <td className="px-3 py-2 text-right text-xs tabular-nums font-semibold">{a?.actualValue ?? "—"}</td>
                          <td className={`px-3 py-2 text-right text-xs tabular-nums ${a?.achievementPct != null ? (a.achievementPct >= 100 ? "text-emerald-600" : a.achievementPct >= 70 ? "text-teal-600" : a.achievementPct >= 50 ? "text-amber-600" : "text-rose-600") : "text-slate-400"}`}>
                            {a?.achievementPct != null ? `${a.achievementPct}%` : "—"}
                          </td>
                          <td className="px-3 py-2 text-right text-xs tabular-nums text-slate-500">{i.weight}%</td>
                          <td className="px-3 py-2 text-right text-xs tabular-nums">{a?.score ?? "—"}</td>
                          <td className="px-3 py-2">{a ? <StatusBadge status={a.status} /> : <span className="text-[10px] text-slate-400">not recorded</span>}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
              {(data.history || []).length > 0 && (
                <details className="rounded-xl border p-3" open>
                  <summary className="text-xs font-semibold text-slate-600 dark:text-slate-300 flex items-center gap-1 cursor-pointer"><History className="h-3.5 w-3.5" /> Approval history</summary>
                  <div className="mt-2 space-y-1.5">
                    {data.history.map((h: any) => (
                      <div key={h.id} className="flex items-start gap-2 text-[11px]">
                        <Badge variant="outline" className="text-[9px] shrink-0 mt-0.5">{fmtStatus(h.action)}</Badge>
                        <p className="text-slate-500"><b className="text-slate-700 dark:text-slate-300">{h.actorName || "—"}</b> · {fmtDateTime(h.createdAt)}{h.comment ? ` — ${h.comment}` : ""}</p>
                      </div>
                    ))}
                  </div>
                </details>
              )}
              <DialogFooter className="gap-2 sm:justify-between">
                <div className="flex gap-2">
                  {can("kpi", "edit") && data.assignment?.status === "APPROVED" && (data.indicators || []).length > 0 && (
                    <Button variant="outline" onClick={() => setEditOpen(true)} disabled={busy}>
                      <Pencil className="h-3.5 w-3.5 mr-1" /> Update Values
                    </Button>
                  )}
                </div>
                <div className="flex gap-2">
                  <Button variant="outline" onClick={() => onOpenChange(false)}>Close</Button>
                  {can("kpi", "approve") && hasPending && <ApprovalActions busy={busy} onDecide={decide} />}
                </div>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
      {editOpen && data && (
        <AchievementEditDialog open={editOpen} onOpenChange={(v) => { setEditOpen(v); if (!v) { load(); onChanged() } }} detail={data} />
      )}
    </>
  )
}

function AchievementEditDialog({ open, onOpenChange, detail }: { open: boolean; onOpenChange: (v: boolean) => void; detail: any }) {
  const toast = useHrm((s) => s.toast)
  const [values, setValues] = useState<Record<string, string>>(() => {
    const v: Record<string, string> = {}
    for (const i of detail?.indicators || []) v[i.id] = i.achievement?.actualValue != null ? String(i.achievement.actualValue) : ""
    return v
  })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async (submitForApproval: boolean) => {
    setBusy(true)
    setError(null)
    try {
      const vals = Object.entries(values).filter(([, v]) => v !== "").map(([indicatorRowId, v]) => ({ indicatorRowId, actualValue: Number(v) }))
      if (!vals.length) throw new Error("Enter at least one achievement value")
      const res = await rpc("kpi.achievements.update", { assignmentId: detail.assignment.id, values: vals, submit: submitForApproval })
      toast(`${res.updated} value(s) ${submitForApproval ? "submitted for approval" : "saved as draft"}`)
      onOpenChange(false)
    } catch (e: any) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!busy) onOpenChange(v) }}>
      <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-base">Update Achievement — {detail?.employee?.fullName}</DialogTitle>
          <p className="text-xs text-slate-500">Approved values are archived and resubmitted for re-approval (revision).</p>
        </DialogHeader>
        <div className="space-y-2 max-h-[55vh] overflow-y-auto pr-1">
          {(detail.indicators || []).map((i: any) => {
            const isBuiltin = i.source === "BUILTIN" || !!i.builtinKey
            return (
              <div key={i.id} className="space-y-1">
                <Label className="text-xs font-medium text-slate-600 dark:text-slate-300 flex items-center justify-between">
                  <span className="flex items-center gap-1.5">
                    {i.name}
                    {isBuiltin && <Badge variant="secondary" className="text-[9px] py-0 px-1 font-normal">Built-in (locked)</Badge>}
                  </span>
                  <span className="text-[10px] text-slate-400 font-normal">target {i.targetValue ?? "—"}{unitLabel(i.unit, i.unitLabel)}</span>
                </Label>
                <Input
                  className="h-8 text-xs tabular-nums disabled:bg-slate-100 dark:disabled:bg-slate-800 disabled:text-slate-500 disabled:cursor-not-allowed"
                  type="number"
                  value={values[i.id] ?? ""}
                  placeholder={isBuiltin ? "Computed from system" : "Actual value"}
                  disabled={isBuiltin}
                  onChange={(e) => setValues((v) => ({ ...v, [i.id]: e.target.value }))}
                />
              </div>
            )
          })}
        </div>
        {error && <ErrorBanner message={error} />}
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
          <Button variant="outline" disabled={busy} onClick={() => submit(false)}>Save as Draft</Button>
          <Button disabled={busy} onClick={() => submit(true)}>{busy ? "Submitting…" : "Submit for Approval"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

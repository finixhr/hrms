"use client"
// ============ Leave Management (spec §8) ============
// Requests with the substitute system, per-year balances with recompute,
// policy types & carry-forward rules, plus a personal "My Leave" tab
// (balances, own requests, pending substitute assignments).
import { useEffect, useMemo, useState } from "react"
import {
  Ban, Check, Loader2, Paperclip, Pencil, Plane, Plus, RefreshCw, Users, X, UserRound,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { useHrm } from "../store"
import { useApi, rpc, useEmployeeDirectory } from "../api"
import { useServerPagedList, PagedControls } from "../server-paged"
import {
  EmptyState, PageHeader, RowButton, RowIconButton, SectionCard, SectionTabs, StatusBadge,
  fmtDate, fmtDateTime, titleCase,
} from "../shared/ui-kit"
import { DataTable, type Column } from "../shared/data-table"
import { ConfirmDialog, FormDialog, type FieldDef } from "../shared/form-dialog"

const STATUS_FILTERS = ["all", "PENDING", "APPROVED", "REJECTED", "CANCELLED"]

function FilterChip({ active, children, onClick }: { active: boolean; children: React.ReactNode; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick}
      className={`rounded-full px-3 py-1 text-xs font-medium transition-colors whitespace-nowrap ${
        active
          ? "bg-primary text-primary-foreground"
          : "border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-300 hover:border-emerald-400"
      }`}>
      {children}
    </button>
  )
}

export default function LeaveView() {
  const { user } = useHrm()
  // global-search deep link: pre-select a tab (params arrive with the view)
  const presetTab = useHrm((s) => (s.view?.key === "leave" && s.view?.params?.tab) || undefined)
  const tabs: { value: string; label: string; content: React.ReactNode }[] = [
    { value: "requests", label: "Requests", content: <RequestsTab /> },
    { value: "balances", label: "Balances", content: <BalancesTab /> },
    { value: "types", label: "Types & Policies", content: <TypesTab /> },
  ]
  if (user?.employeeId) tabs.push({ value: "my", label: "My Leave", content: <MyLeaveTab /> })
  return (
    <div className="space-y-4">
      <PageHeader
        title="Leave Management"
        subtitle="Requests with substitute acceptance, entitlement balances and policy types — approved leave writes attendance rows consumed by payroll"
      />
      <SectionTabs defaultValue={presetTab as string | undefined} tabs={tabs} />
    </div>
  )
}

// ================= Tab 1 — Requests =================
function RequestsTab() {
  const { can, user, toast, navigate } = useHrm()
  const [status, setStatus] = useState("all")
  // 2026-10-14 — Employee Actions deep link (employee 360° → "Leave History"):
  // server-side pre-filter to ONE employee until cleared (✕ chip).
  // leaveRequests.list has always accepted employeeId (scopedEmployeeWhere).
  const presetEmployeeId = useHrm((s) => (s.view?.key === "leave" ? ((s.view?.params as any)?.employeeId as string | undefined) : undefined))
  const { data, loading, error, reload } = useApi<any[]>("leaveRequests.list", {
    ...(status === "all" ? {} : { status }),
    ...(presetEmployeeId ? { employeeId: presetEmployeeId } : {}),
  })
  const { data: types } = useApi<any[]>("leaveTypes.list", {})
  const { data: employees } = useEmployeeDirectory()
  const [applyOpen, setApplyOpen] = useState(false)
  const [cancelTarget, setCancelTarget] = useState<any>(null)
  const [act, setAct] = useState<any>(null)
  const [changeSub, setChangeSub] = useState<any>(null)
  const [changeSubId, setChangeSubId] = useState("")
  const [changeSubBusy, setChangeSubBusy] = useState(false)
  const canApply = can("ess", "create") || can("leave", "create")
  const isHr = (user?.role || "") !== "EMPLOYEE"

  // Inline approvals: cross-reference pending workflow requests (entityType
  // "LeaveRequest") so managers can approve/reject directly from this table
  // instead of hunting through the separate Approval Queue.
  const canSeeQueue = can("approvals", "view")
  const { data: queue, reload: reloadQueue } = useApi<any[]>(canSeeQueue ? "approvals.queue" : null, { status: "PENDING" })
  const pendingApproval = useMemo(() => {
    const m = new Map<string, any>()
    for (const q of queue || []) {
      if (q.processType === "LEAVE" && q.entityId) m.set(q.entityId, q)
    }
    return m
  }, [queue])

  const columns: Column<any>[] = [
    {
      key: "employeeName", label: "Employee", sortValue: (r) => r.employeeName,
      render: (r) => (
        <div>
          <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">{r.employeeName}</p>
          {r.employeeCode && <p className="text-[11px] text-slate-500 dark:text-slate-400">{r.employeeCode}</p>}
        </div>
      ),
    },
    {
      key: "typeName", label: "Type", sortValue: (r) => r.typeName,
      render: (r) => (
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-xs font-medium text-slate-700 dark:text-slate-200">{r.typeName}</span>
          {r.paid != null && (
            <Badge className={r.paid ? "bg-emerald-100 text-emerald-700 text-[9px]" : "bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-300 text-[9px]"}>
              {r.paid ? "Paid" : "Unpaid"}
            </Badge>
          )}
        </div>
      ),
    },
    { key: "fromDate", label: "From", sortValue: (r) => r.fromDate, render: (r) => <span className="text-xs tabular-nums text-slate-600 dark:text-slate-300">{fmtDate(r.fromDate)}</span> },
    { key: "toDate", label: "To", sortValue: (r) => r.toDate, render: (r) => <span className="text-xs tabular-nums text-slate-600 dark:text-slate-300">{fmtDate(r.toDate)}</span> },
    {
      key: "days", label: "Days", align: "right", sortValue: (r) => r.days,
      render: (r) => (
        <span className="inline-flex items-center gap-1">
          <b className="text-xs tabular-nums text-slate-700 dark:text-slate-200">{r.days}</b>
          {r.halfDay && <Badge variant="outline" className="text-[9px]">½</Badge>}
        </span>
      ),
    },
    {
      key: "substitute", label: "Substitute",
      render: (r) => r.substituteName ? (
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-xs text-slate-600 dark:text-slate-300">{r.substituteName}</span>
          {r.substituteStatus && <StatusBadge status={r.substituteStatus} />}
          {r.substituteStatus === "DECLINED" && r.status === "PENDING" && can("leave", "edit") && (
            <Button size="sm" variant="outline" className="h-6 text-[10px] text-amber-700 border-amber-300 hover:bg-amber-50"
              onClick={() => setChangeSub(r)}>Change</Button>
          )}
        </div>
      ) : <span className="text-xs text-slate-400">—</span>,
    },
    {
      key: "contactNumber", label: "Contact",
      render: (r) => r.contactNumber
        ? <span className="text-xs tabular-nums text-slate-600 dark:text-slate-300">{r.contactNumber}</span>
        : <span className="text-xs text-slate-400">—</span>,
    },
    {
      // R3 — supporting-document download (audit-logged)
      key: "attachment", label: "File",
      render: (r) => r.attachment?.name ? (
        <Button size="icon" variant="ghost" className="h-7 w-7 text-emerald-600 hover:text-emerald-700" title={`Download attachment — ${r.attachment.name}`}
          onClick={async () => {
            try {
              const res = await rpc<any>("leaveRequests.attachment", { id: r.id })
              const a = document.createElement("a")
              a.href = `data:application/octet-stream;base64,${res.fileData}`
              a.download = res.fileName || "attachment"
              a.click()
            } catch (e: any) {
              toast(e?.message || "Could not download attachment", "err")
            }
          }}>
          <Paperclip className="h-3.5 w-3.5" />
        </Button>
      ) : <span className="text-xs text-slate-400">—</span>,
    },
    { key: "status", label: "Status", render: (r) => <StatusBadge status={r.status} /> },
    { key: "createdAt", label: "Applied", sortValue: (r) => r.createdAt, render: (r) => <span className="text-[11px] text-slate-500 dark:text-slate-400">{fmtDateTime(r.createdAt)}</span> },
    {
      key: "actions", label: "", align: "right",
      render: (r) => {
        const q = r.status === "PENDING" ? pendingApproval.get(r.id) : null
        return (
          <div className="flex items-center justify-end gap-1">
            {q && q.canAct && can("leave", "approve") && (
              <>
                {/* UI-R4 — one action-size system: Approve is the solid primary,
                    Reject stays a quiet danger outline (audit: equal-weight
                    outlined buttons made the primary workflow action hard to find) */}
                <RowButton icon={Check} tone="brand" onClick={() => setAct({ row: r, q, decision: "APPROVE" })}>Approve</RowButton>
                <RowButton icon={X} tone="danger" onClick={() => setAct({ row: r, q, decision: "REJECT" })}>Reject</RowButton>
              </>
            )}
            {q && !q.canAct && (
              <Badge className="bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-500 dark:text-slate-400 text-[9px] whitespace-nowrap" title="Waiting for an earlier workflow step to complete">
                at step: {q.stepName}
              </Badge>
            )}
            {["PENDING", "APPROVED"].includes(r.status) && (
              <RowIconButton icon={Ban} tone="neutral" label="Cancel request" onClick={() => setCancelTarget(r)} />
            )}
          </div>
        )
      },
    },
  ]

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap gap-1.5">
          {STATUS_FILTERS.map((s) => (
            <FilterChip key={s} active={status === s} onClick={() => setStatus(s)}>
              {s === "all" ? "All" : titleCase(s)}
            </FilterChip>
          ))}
        </div>
        {presetEmployeeId && (
          <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-200 bg-emerald-50 dark:bg-emerald-950/40 pl-2.5 pr-1 py-0.5 text-[11px] text-emerald-800 dark:text-emerald-300">
            <UserRound className="h-3 w-3" />
            {(employees || []).find((e: any) => e.id === presetEmployeeId)?.fullName || "Selected employee"}
            <button type="button" title="Clear the employee filter" onClick={() => navigate("leave", { tab: "requests" })}
              className="h-4 w-4 rounded-full inline-flex items-center justify-center hover:bg-emerald-200 dark:hover:bg-emerald-900">
              <X className="h-2.5 w-2.5" />
            </button>
          </span>
        )}
        {canApply && (
          <Button size="sm" onClick={() => setApplyOpen(true)} className="h-8 text-xs ">
            <Plus className="h-3.5 w-3.5 mr-1" /> Apply Leave
          </Button>
        )}
      </div>

      <DataTable columns={columns} rows={data || undefined} loading={loading} error={error} pageSize={15}
        csvName="leave-requests" searchPlaceholder="Search employee…"
        emptyTitle="No leave requests" emptyHint="Approved requests deduct balances and write attendance LEAVE rows for payroll." />

      <ApplyLeaveDialog
        open={applyOpen}
        onOpenChange={(v) => { setApplyOpen(v); if (!v) reload() }}
        types={types || []}
        employees={employees || []}
        isHr={isHr}
      />

      <ConfirmDialog open={!!cancelTarget} onOpenChange={(v) => { if (!v) setCancelTarget(null) }}
        title="Cancel leave request"
        message={cancelTarget
          ? `Cancel ${cancelTarget.employeeName}'s ${cancelTarget.typeName} leave (${fmtDate(cancelTarget.fromDate)} → ${fmtDate(cancelTarget.toDate)})? Consumed days are returned to the balance.`
          : ""}
        danger confirmLabel="Cancel Request"
        onConfirm={async () => { await rpc("leaveRequests.cancel", { id: cancelTarget.id }); reload() }} />

      {/* inline approve/reject via the unified approval engine */}
      {/* change substitute after a decline (spec §8.3) */}
      <Dialog open={!!changeSub} onOpenChange={(v) => { if (!v) { setChangeSub(null); setChangeSubId("") } }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Change Substitute</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <p className="text-xs text-slate-500 leading-relaxed">
              {changeSub?.employeeName}&rsquo;s leave ({fmtDate(changeSub?.fromDate)} → {fmtDate(changeSub?.toDate)}) — the previous substitute
              (&ldquo;{changeSub?.substituteName}&rdquo;) declined. Pick a new substitute; eligibility is validated server-side
              (same branch/department, not on leave, not scheduled off).
            </p>
            <Select value={changeSubId} onValueChange={setChangeSubId}>
              <SelectTrigger className="h-9 text-sm"><SelectValue placeholder="Select a new substitute…" /></SelectTrigger>
              <SelectContent>
                {(employees || [])
                  .filter((e: any) => e.id !== changeSub?.employeeId && e.status !== "INACTIVE")
                  .map((e: any) => <SelectItem key={e.id} value={e.id}>{e.fullName} ({e.code})</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setChangeSub(null); setChangeSubId("") }} className="h-9">Cancel</Button>
            <Button className="h-9 " disabled={changeSubBusy || !changeSubId}
              onClick={async () => {
                setChangeSubBusy(true)
                try {
                  await rpc("leaveRequests.substitute.change", { id: changeSub.id, substituteEmployeeId: changeSubId })
                  toast("Substitute updated — the new substitute was notified")
                  setChangeSub(null)
                  setChangeSubId("")
                  reload()
                } catch (e: any) {
                  toast(e.message || "Could not change substitute", "err")
                } finally { setChangeSubBusy(false) }
              }}>
              {changeSubBusy ? "Saving…" : "Save Substitute"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog open={!!act} onOpenChange={(v) => { if (!v) setAct(null) }}
        title={act?.decision === "APPROVE" ? "Approve leave request" : "Reject leave request"}
        message={act
          ? `${act.row.employeeName} — ${act.row.typeName} leave, ${act.row.days} day(s) from ${fmtDate(act.row.fromDate)} to ${fmtDate(act.row.toDate)}.${
              act.decision === "APPROVE"
                ? " Approving runs the next workflow step (balance deduction + attendance rows on final approval)."
                : " Rejecting stops the workflow and notifies the requester."
            }`
          : ""}
        danger={act?.decision === "REJECT"}
        requireReason={act?.decision === "REJECT"}
        confirmLabel={act?.decision === "APPROVE" ? "Approve" : "Reject"}
        onConfirm={async (reason) => {
          await rpc("approvals.act", { requestId: act.q.id, decision: act.decision, comment: reason })
          reload()
          reloadQueue()
        }} />
    </div>
  )
}

// ---------- Apply Leave dialog (custom: dynamic substitute options) ----------
function ApplyLeaveDialog({ open, onOpenChange, types, employees, isHr }: {
  open: boolean
  onOpenChange: (v: boolean) => void
  types: any[]
  employees: any[]
  isHr: boolean
}) {
  const toast = useHrm((s) => s.toast)
  const [v, setV] = useState({ employeeId: "", leaveTypeId: "", fromDate: "", toDate: "", reason: "", contactNumber: "", substituteEmployeeId: "none", halfDay: false })
  const [subs, setSubs] = useState<any[] | null>(null)
  const [subsLoading, setSubsLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // R3 — optional supporting document (PDF / image, ≤ 2 MB, stored base64)
  const [attachment, setAttachment] = useState<{ name: string; data: string } | null>(null)

  const onAttachmentFile = (f: File | null) => {
    if (!f) { setAttachment(null); return }
    if (f.size > 2 * 1024 * 1024) { setError("Attachment too large (max 2 MB)"); return }
    const reader = new FileReader()
    reader.onload = () => setAttachment({ name: f.name, data: String(reader.result).split(",")[1] || "" })
    reader.readAsDataURL(f)
  }

  useEffect(() => {
    if (open) {
      setV({ employeeId: "", leaveTypeId: "", fromDate: "", toDate: "", reason: "", contactNumber: "", substituteEmployeeId: "none", halfDay: false })
      setSubs(null)
      setAttachment(null)
      setError(null)
    }
  }, [open])

  // Fetch substitute options whenever both dates (and the employee for HR) are set.
  useEffect(() => {
    if (!open || !v.fromDate || !v.toDate) { setSubs(null); return }
    let dead = false
    setSubsLoading(true)
    rpc<any[]>("leaveRequests.substituteOptions", {
      employeeId: isHr && v.employeeId ? v.employeeId : undefined,
      fromDate: v.fromDate,
      toDate: v.toDate,
    })
      .then((r) => { if (!dead) setSubs(r || []) })
      .catch(() => { if (!dead) setSubs([]) })
      .finally(() => { if (!dead) setSubsLoading(false) })
    return () => { dead = true }
  }, [open, v.fromDate, v.toDate, v.employeeId])

  const subOptions = useMemo(() => {
    const list = subs || []
    return [...list].sort((a, b) => Number(b.eligible) - Number(a.eligible))
  }, [subs])

  const previewDays = v.fromDate && v.toDate && v.fromDate <= v.toDate
    ? Math.round((new Date(v.toDate).getTime() - new Date(v.fromDate).getTime()) / 86400000) + 1
    : 0

  const set = (k: string, val: any) => setV((s) => ({ ...s, [k]: val }))

  const selectedType = types.find((t: any) => t.id === v.leaveTypeId)
  const needsAttachment = !!selectedType?.requiresAttachment

  const submit = async () => {
    if (!v.leaveTypeId) { setError("Select a leave type"); return }
    if (!v.fromDate || !v.toDate) { setError("Select the from and to dates"); return }
    if (v.fromDate > v.toDate) { setError("From date cannot be after the to date"); return }
    if (!v.reason.trim()) { setError("A reason is required"); return }
    if (needsAttachment && !attachment) { setError("This leave type requires a supporting document — attach a file"); return }
    setBusy(true)
    setError(null)
    try {
      await rpc("leaveRequests.apply", {
        employeeId: isHr && v.employeeId ? v.employeeId : undefined,
        leaveTypeId: v.leaveTypeId,
        fromDate: v.fromDate,
        toDate: v.toDate,
        reason: v.reason.trim(),
        contactNumber: v.contactNumber.trim() || undefined,
        halfDay: v.halfDay,
        substituteEmployeeId: v.substituteEmployeeId !== "none" ? v.substituteEmployeeId : undefined,
        attachmentName: attachment?.name || undefined,
        attachmentData: attachment?.data || undefined,
      })
      toast("Leave request submitted")
      onOpenChange(false)
    } catch (e: any) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-base">Apply for Leave</DialogTitle>
          <p className="text-xs text-slate-500">
            Balance, probation eligibility, backdate rules and substitute eligibility are validated server-side.
          </p>
        </DialogHeader>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 py-2">
          {isHr && (
            <div className="space-y-1.5">
              <Label className="text-xs font-medium">Employee</Label>
              <Select value={v.employeeId} onValueChange={(x) => set("employeeId", x)}>
                <SelectTrigger className="h-9"><SelectValue placeholder="Select employee…" /></SelectTrigger>
                <SelectContent>
                  {employees.map((e: any) => <SelectItem key={e.id} value={e.id}>{e.fullName} ({e.code})</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          )}
          <div className="space-y-1.5">
            <Label className="text-xs font-medium">Leave Type <span className="text-rose-500">*</span></Label>
            <Select value={v.leaveTypeId} onValueChange={(x) => set("leaveTypeId", x)}>
              <SelectTrigger className="h-9"><SelectValue placeholder="Select type…" /></SelectTrigger>
              <SelectContent>
                {types.map((t: any) => (
                  <SelectItem key={t.id} value={t.id}>
                    {t.name} {t.paid ? "(paid)" : "(unpaid)"} · {t.defaultDays}d
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs font-medium">From Date <span className="text-rose-500">*</span></Label>
            <Input type="date" className="h-9" value={v.fromDate} onChange={(e) => set("fromDate", e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs font-medium">To Date <span className="text-rose-500">*</span></Label>
            <Input type="date" className="h-9" value={v.toDate} onChange={(e) => set("toDate", e.target.value)} />
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label className="text-xs font-medium">Reason <span className="text-rose-500">*</span></Label>
            <Textarea rows={2} value={v.reason} placeholder="Why are you taking this leave?"
              onChange={(e) => set("reason", e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs font-medium">Contact Number During Leave</Label>
            <Input type="tel" className="h-9" value={v.contactNumber} placeholder="e.g. +880 1712-345678"
              onChange={(e) => set("contactNumber", e.target.value)} />
            <p className="text-[10px] text-slate-500 dark:text-slate-400">Where HR / your manager can reach you while on leave.</p>
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label className="text-xs font-medium">Substitute Employee</Label>
            <Select value={v.substituteEmployeeId} onValueChange={(x) => set("substituteEmployeeId", x)} disabled={!subs}>
              <SelectTrigger className="h-9">
                <SelectValue placeholder={subsLoading ? "Checking eligible colleagues…" : "Select both dates to load options"} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">— No substitute —</SelectItem>
                {subOptions.map((s: any) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.fullName} — {s.eligible ? "eligible" : `not eligible (${s.reason})`}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {subs && subs.length > 0 && (
              <p className="text-[10px] text-slate-500 dark:text-slate-400">
                {subs.filter((s: any) => s.eligible).length} eligible of {subs.length} colleagues. Eligible substitutes are listed first.
              </p>
            )}
          </div>
          <div className="flex items-center gap-2 pt-1">
            <Switch id="halfDay" checked={v.halfDay} onCheckedChange={(c) => set("halfDay", c)} />
            <Label htmlFor="halfDay" className="text-xs font-medium">Half day</Label>
          </div>
          {previewDays > 0 && (
            <div className="flex items-end">
              <Badge variant="outline" className="text-[10px] whitespace-nowrap">
                ≈ {previewDays} calendar day(s) — weekly offs excluded server-side
              </Badge>
            </div>
          )}
          {/* R3 — supporting document (optional; enforced when the leave type requires one) */}
          <div className="space-y-1.5 sm:col-span-2">
            <Label className="text-xs font-medium">
              Attachment (supporting document)
              {needsAttachment && <span className="text-rose-500"> *</span>}
            </Label>
            <div className="flex flex-wrap items-center gap-2">
              <input
                type="file"
                accept="image/*,application/pdf"
                className="block w-full text-xs text-slate-500 dark:text-slate-400
                  file:mr-3 file:rounded-md file:border-0 file:bg-emerald-50 dark:file:bg-emerald-950
                  file:px-3 file:py-1.5 file:text-xs file:font-medium file:text-emerald-700 dark:file:text-emerald-300
                  hover:file:bg-emerald-100 dark:hover:file:bg-emerald-900"
                onChange={(e) => onAttachmentFile(e.target.files?.[0] || null)}
              />
              {attachment && (
                <span className="inline-flex items-center gap-1 rounded-md bg-emerald-50 dark:bg-emerald-950/50 px-2 py-1 text-[11px] text-emerald-700 dark:text-emerald-300">
                  {attachment.name}
                  <button type="button" className="text-rose-500 hover:text-rose-700" onClick={() => setAttachment(null)}>×</button>
                </span>
              )}
            </div>
            <p className="text-[10px] text-slate-500 dark:text-slate-400">
              PDF or image, max 2 MB{needsAttachment ? " — required for this leave type." : " — optional; required for some leave types (e.g. sick leave medical certificate)."}
            </p>
          </div>
        </div>
        {error && <p className="text-sm text-rose-600 dark:text-rose-400 bg-rose-50 dark:bg-rose-950 rounded-md px-3 py-2">{error}</p>}
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
          <Button onClick={submit} disabled={busy}>
            {busy ? <><Loader2 className="h-4 w-4 mr-1 animate-spin" /> Submitting…</> : "Submit Request"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ================= Tab 2 — Balances =================
function BalancesTab() {
  const { toast, can } = useHrm()
  const now = new Date()
  const [year, setYear] = useState(now.getFullYear())
  // P6 WS-B — server-paged balances (MOD-16 contract): every employee × type
  // row of the year no longer ships to the browser; search runs in SQL.
  const [q, setQ] = useState("")
  const { rows: pageRows, total, page, pageSize, maxPage, loading, error, reload, setPage } =
    useServerPagedList<any>("leaveBalances.list", { year, q: q || undefined }, 50)
  const [busy, setBusy] = useState(false)
  // LVE-007 (R3-4) — the in-service encashment workflow is finally reachable:
  // the route + approval engine + finalize hook existed, but NOTHING called
  // leave.encash (the feature was configured-but-dead). HR can now raise an
  // encashment request from the Balances tab; employees get the same action
  // on their ESS My Leave tab.
  const [encashTarget, setEncashTarget] = useState<any | null>(null)
  const [encashDays, setEncashDays] = useState("")
  const [encashBusy, setEncashBusy] = useState(false)
  const years = useMemo(() => {
    const y = new Date().getFullYear()
    return [y - 2, y - 1, y, y + 1]
  }, [])

  const rows = useMemo(() =>
    [...(pageRows || [])].sort((a, b) =>
      String(a.employeeName || "").localeCompare(String(b.employeeName || "")) ||
      String(a.typeName || "").localeCompare(String(b.typeName || ""))), [pageRows])

  const recompute = async () => {
    setBusy(true)
    try {
      const r = await rpc<{ employees: number; types: number }>("leaveBalances.recompute", { year })
      toast(`Recomputed entitlements for ${r.employees} employee(s) × ${r.types} leave type(s) in ${year}`)
      reload()
    } catch (e: any) {
      toast(e.message, "err")
    } finally {
      setBusy(false)
    }
  }

  const submitEncash = async () => {
    if (!encashTarget) return
    const days = Number(encashDays)
    if (!(days > 0)) { toast("Enter the number of days to encash", "err"); return }
    setEncashBusy(true)
    try {
      await rpc("leave.encash", { employeeId: encashTarget.employeeId, leaveTypeId: encashTarget.leaveTypeId, days })
      toast(`Encashment request for ${days} day(s) of ${encashTarget.typeName} submitted for approval — the payout rides payroll as a bonus once approved`)
      setEncashTarget(null); setEncashDays("")
      reload()
    } catch (e: any) {
      toast(e.message, "err")
    } finally {
      setEncashBusy(false)
    }
  }

  const columns: Column<any>[] = [
    {
      key: "employeeName", label: "Employee", sortValue: (r) => r.employeeName,
      render: (r) => (
        <div>
          <p className="text-sm font-medium text-slate-800 dark:text-slate-100">{r.employeeName}</p>
          {r.typeCode && <p className="text-[11px] text-slate-500 dark:text-slate-400">{r.typeCode} · {r.paid ? "paid" : "unpaid"}</p>}
        </div>
      ),
    },
    { key: "typeName", label: "Leave Type", sortValue: (r) => r.typeName, render: (r) => <span className="text-xs font-medium text-slate-700 dark:text-slate-200">{r.typeName || "—"}</span> },
    { key: "entitled", label: "Entitled", align: "right", sortValue: (r) => r.entitled, render: (r) => <span className="text-xs tabular-nums font-medium text-slate-700 dark:text-slate-200">{r.entitled}</span> },
    { key: "carriedForward", label: "Carried Fwd", align: "right", render: (r) => <span className="text-xs tabular-nums text-slate-500">{r.carriedForward || 0}</span> },
    { key: "used", label: "Used", align: "right", sortValue: (r) => r.used, render: (r) => <span className="text-xs tabular-nums text-slate-600 dark:text-slate-300">{r.used}</span> },
    { key: "pending", label: "Pending", align: "right", render: (r) => <span className="text-xs tabular-nums text-amber-600">{r.pending}</span> },
    {
      key: "remaining", label: "Remaining", align: "right", sortValue: (r) => r.remaining,
      render: (r) => <b className={`text-sm tabular-nums ${r.remaining < 0 ? "text-rose-600 dark:text-rose-400" : "text-emerald-700 dark:text-emerald-400"}`}>{r.remaining}</b>,
    },
    {
      // LVE-007 — encashment entry point for encashment-eligible types
      key: "actions", label: "", align: "right",
      render: (r) => r.encashmentAllowed && r.remaining > 0 && (can("leave", "edit") || can("leave", "approve")) ? (
        <Button size="sm" variant="outline" className="h-7 text-[11px]" onClick={() => { setEncashTarget(r); setEncashDays(String(Math.min(Math.floor(r.remaining), r.encashmentCap > 0 ? r.encashmentCap : Math.floor(r.remaining)))) }}>
          Encash
        </Button>
      ) : null,
    },
  ]

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Select value={String(year)} onValueChange={(x) => setYear(Number(x))}>
          <SelectTrigger className="w-[110px] h-9"><SelectValue /></SelectTrigger>
          <SelectContent>
            {years.map((y) => <SelectItem key={y} value={String(y)}>{y}</SelectItem>)}
          </SelectContent>
        </Select>
        <Button size="sm" variant="outline" className="h-9 text-xs" disabled={busy} onClick={recompute}>
          {busy ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5 mr-1" />} Recompute Entitlements
        </Button>
        <p className="text-xs text-slate-400">Remaining = Entitled + Carried Fwd − Used − Pending. Negative values are highlighted.</p>
      </div>
      <DataTable columns={columns} rows={rows} loading={loading} error={error} pageSize={20}
        csvName={`leave-balances-${year}`} searchPlaceholder="Search employee…" onSearch={setQ}
        emptyTitle={`No balances for ${year}`} emptyHint="Run Recompute Entitlements to generate this year's balances from active leave types." />
      <PagedControls page={page} maxPage={maxPage} total={total} pageSize={pageSize} onPage={setPage} loading={loading} />
      <Dialog open={!!encashTarget} onOpenChange={(v) => { if (!v) { setEncashTarget(null); setEncashDays("") } }}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Request leave encashment</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <p className="text-xs text-slate-500 dark:text-slate-400">
              {encashTarget?.employeeName} — {encashTarget?.typeName} · {encashTarget?.remaining} day(s) available
              {encashTarget?.encashmentCap > 0 ? ` · capped at ${encashTarget.encashmentCap} day(s) per request` : ""}
            </p>
            <div>
              <Label htmlFor="encash-days">Days to encash</Label>
              <Input id="encash-days" type="number" min={0.5} step={0.5} value={encashDays} onChange={(e) => setEncashDays(e.target.value)} />
            </div>
            <p className="text-[11px] text-slate-400">
              Approval follows the ENCASHMENT workflow (Settings → Workflow). Once approved, the days convert to used balance and the payout queues as a bonus for the next payroll run.
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setEncashTarget(null); setEncashDays("") }} disabled={encashBusy}>Cancel</Button>
            <Button onClick={submitEncash} disabled={encashBusy || !(Number(encashDays) > 0)}>
              {encashBusy ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : null} Submit for approval
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

// ================= Tab 3 — Types & policies =================
const typeFields: FieldDef[] = [
  { name: "code", label: "Code", required: true, placeholder: "CL" },
  { name: "name", label: "Name", required: true, placeholder: "Casual Leave" },
  { name: "paid", label: "Paid leave", type: "switch", defaultValue: true },
  { name: "defaultDays", label: "Default Days / Year", type: "number", min: 0, defaultValue: 10 },
  { name: "carryForward", label: "Carry forward allowed", type: "switch" },
  { name: "maxCarryForward", label: "Max Carry-Forward Days", type: "number", min: 0, defaultValue: 0 },
  { name: "encashmentAllowed", label: "Encashment allowed", type: "switch" },
  { name: "waitingPeriodDays", label: "Waiting Period (days)", type: "number", min: 0, defaultValue: 0, help: "Days of service before this leave unlocks" },
  { name: "probationEligible", label: "Eligible during probation", type: "switch" },
  { name: "requiresAttachment", label: "Attachment required", type: "switch" },
  { name: "active", label: "Active", type: "switch", defaultValue: true },
]

function TypesTab() {
  const { can } = useHrm()
  const { data, loading, error, reload } = useApi<any[]>("leaveTypes.list", {})
  const [open, setOpen] = useState(false)
  const [editRec, setEditRec] = useState<any>(null)

  const columns: Column<any>[] = [
    {
      key: "code", label: "Code", sortValue: (t) => t.code,
      render: (t) => (
        <div className="flex items-center gap-2">
          <Badge variant="outline" className="font-mono text-[10px]">{t.code}</Badge>
          <span className="text-sm font-medium text-slate-800 dark:text-slate-100">{t.name}</span>
        </div>
      ),
    },
    { key: "paid", label: "Paid", render: (t) => <Badge className={t.paid ? "bg-emerald-100 text-emerald-700 text-[9px]" : "bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-300 text-[9px]"}>{t.paid ? "Paid" : "Unpaid"}</Badge> },
    { key: "defaultDays", label: "Default Days", align: "right", sortValue: (t) => t.defaultDays, render: (t) => <span className="text-xs tabular-nums font-medium">{t.defaultDays}</span> },
    { key: "carryForward", label: "Carry Fwd", render: (t) => t.carryForward ? <Check className="h-3.5 w-3.5 text-emerald-600" /> : <span className="text-xs text-slate-400">—</span> },
    { key: "maxCarryForward", label: "Max CF", align: "right", render: (t) => <span className="text-xs tabular-nums text-slate-500">{t.carryForward ? (t.maxCarryForward || "—") : "—"}</span> },
    { key: "encashmentAllowed", label: "Encashment", render: (t) => t.encashmentAllowed ? <Check className="h-3.5 w-3.5 text-emerald-600" /> : <span className="text-xs text-slate-400">—</span> },
    { key: "waitingPeriodDays", label: "Waiting Period", align: "right", render: (t) => <span className="text-xs tabular-nums text-slate-500">{t.waitingPeriodDays ? `${t.waitingPeriodDays}d` : "—"}</span> },
    { key: "probationEligible", label: "Probation", render: (t) => t.probationEligible ? <Check className="h-3.5 w-3.5 text-emerald-600" /> : <span className="text-xs text-slate-400">—</span> },
    { key: "active", label: "Active", render: (t) => <Badge className={t.active ? "bg-emerald-100 text-emerald-700" : "bg-slate-200 text-slate-600"}>{t.active ? "Active" : "Inactive"}</Badge> },
    {
      key: "actions", label: "", align: "right",
      render: (t) => can("settings", "edit") && (
        <Button aria-label="Edit" size="icon" variant="ghost" className="h-7 w-7" onClick={() => { setEditRec(t); setOpen(true) }}>
          <Pencil className="h-3.5 w-3.5" />
        </Button>
      ),
    },
  ]

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-slate-500">
          Policy changes apply to future entitlements — existing balances are not retroactively adjusted.
        </p>
        {can("settings", "edit") && (
          <Button size="sm" onClick={() => { setEditRec(null); setOpen(true) }} className="h-8 text-xs ">
            <Plus className="h-3.5 w-3.5 mr-1" /> Add Leave Type
          </Button>
        )}
      </div>
      <DataTable columns={columns} rows={data || undefined} loading={loading} error={error} pageSize={15}
        csvName="leave-types" searchPlaceholder="Search type…" emptyTitle="No leave types"
        emptyHint="Define casual, sick, earned and unpaid policies with carry-forward rules." />
      <FormDialog open={open} onOpenChange={(v) => { setOpen(v); if (!v) { setEditRec(null); reload() } }}
        title={editRec ? `Edit — ${editRec.name}` : "Add Leave Type"} wide
        description="Entitlements are generated from these rules via Balances → Recompute."
        fields={typeFields} initial={editRec}
        onSubmit={async (v) => { await rpc("leaveTypes.save", editRec ? { id: editRec.id, ...v } : v) }} />
    </div>
  )
}

// ================= Tab 4 — My Leave (self-service) =================
function MyLeaveTab() {
  const { toast } = useHrm()
  const { data, loading, error, reload } = useApi<any>("ess.leave", {})
  const { data: employees } = useEmployeeDirectory()
  const [busyId, setBusyId] = useState<string | null>(null)

  const empName = (id: string) => (employees || []).find((e: any) => e.id === id)?.fullName || "Employee"

  const respond = async (id: string, decision: "ACCEPTED" | "DECLINED") => {
    setBusyId(id)
    try {
      await rpc("leaveRequests.substitute.respond", { id, decision })
      toast(`Substitute assignment ${decision.toLowerCase()}`)
      reload()
    } catch (e: any) {
      toast(e.message, "err")
    } finally {
      setBusyId(null)
    }
  }

  const myColumns: Column<any>[] = [
    { key: "typeName", label: "Type", render: (r) => <span className="text-xs font-medium text-slate-700 dark:text-slate-200">{r.typeName || "—"}</span> },
    { key: "fromDate", label: "From", sortValue: (r) => r.fromDate, render: (r) => <span className="text-xs tabular-nums text-slate-600 dark:text-slate-300">{fmtDate(r.fromDate)}</span> },
    { key: "toDate", label: "To", render: (r) => <span className="text-xs tabular-nums text-slate-600 dark:text-slate-300">{fmtDate(r.toDate)}</span> },
    { key: "days", label: "Days", align: "right", sortValue: (r) => r.days, render: (r) => <b className="text-xs tabular-nums">{r.days}</b> },
    { key: "status", label: "Status", render: (r) => <StatusBadge status={r.status} /> },
    { key: "substituteStatus", label: "Substitute", render: (r) => r.substituteStatus ? <StatusBadge status={r.substituteStatus} /> : <span className="text-xs text-slate-400">—</span> },
    { key: "createdAt", label: "Applied", render: (r) => <span className="text-[11px] text-slate-500 dark:text-slate-400">{fmtDateTime(r.createdAt)}</span> },
  ]

  const balances = data?.balances || []
  const requests = data?.requests || []
  const substitutes = data?.substituteRequests || []

  return (
    <div className="space-y-4">
      <SectionCard title="My Leave Balances" actions={<Badge variant="outline" className="text-[10px]">{new Date().getFullYear()}</Badge>}>
        {loading ? (
          <p className="text-xs text-slate-400">Loading balances…</p>
        ) : error ? (
          <p className="text-xs text-rose-600">{error}</p>
        ) : balances.length === 0 ? (
          <EmptyState icon={Plane} title="No balances yet" hint="Your entitlements appear once leave types are assigned for this year." />
        ) : (
          <div className="space-y-3.5">
            {balances.map((b: any) => {
              const total = Number(b.entitled) || 1
              const usedPct = Math.min(100, (Number(b.used) / total) * 100)
              const pendPct = Math.min(100 - usedPct, (Number(b.pending) / total) * 100)
              return (
                <div key={b.id} className="space-y-1">
                  <div className="flex flex-wrap items-center justify-between gap-1">
                    <span className="text-xs font-semibold text-slate-700 dark:text-slate-200">{b.typeName || "Leave"}</span>
                    <span className="text-xs tabular-nums text-slate-500">
                      {b.used} used · {b.pending} pending ·{" "}
                      <b className={b.remaining < 0 ? "text-rose-600 dark:text-rose-400" : "text-emerald-700 dark:text-emerald-400"}>{b.remaining}</b> left of {b.entitled}
                    </span>
                  </div>
                  <div className="h-2 rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden flex" role="progressbar"
                    aria-label={`${b.typeName} balance`}>
                    <div className="h-full bg-emerald-500" style={{ width: `${usedPct}%` }} />
                    <div className="h-full bg-amber-400" style={{ width: `${pendPct}%` }} />
                  </div>
                </div>
              )
            })}
            <p className="text-[10px] text-slate-500 dark:text-slate-400">
              <span className="inline-block h-2 w-2 rounded-full bg-emerald-500 mr-1" />used
              <span className="inline-block h-2 w-2 rounded-full bg-amber-400 ml-3 mr-1" />pending approval
            </p>
          </div>
        )}
      </SectionCard>

      <SectionCard title="Pending Substitute Requests">
        {substitutes.length === 0 ? (
          <EmptyState icon={Users} title="No pending substitute requests"
            hint="You'll be asked to accept or decline when a colleague names you as their leave substitute." />
        ) : (
          <div className="space-y-2">
            {substitutes.map((s: any) => (
              <div key={s.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-2">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-slate-800 dark:text-slate-100">{empName(s.employeeId)}</p>
                  <p className="text-[11px] text-slate-500 dark:text-slate-400 truncate">
                    {fmtDate(s.fromDate)} → {fmtDate(s.toDate)} · {s.days} day(s){s.reason ? ` · “${s.reason}”` : ""}
                  </p>
                </div>
                <div className="flex gap-1.5 shrink-0">
                  <Button size="sm" className="h-7 text-[10px] " disabled={busyId === s.id}
                    onClick={() => respond(s.id, "ACCEPTED")}>
                    {busyId === s.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3 mr-0.5" />} Accept
                  </Button>
                  <Button size="sm" variant="outline" className="h-7 text-[10px] text-rose-700 border-rose-200 hover:bg-rose-50 dark:text-rose-400"
                    disabled={busyId === s.id} onClick={() => respond(s.id, "DECLINED")}>
                    <X className="h-3 w-3 mr-0.5" /> Decline
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </SectionCard>

      <SectionCard title="My Leave Requests">
        <DataTable columns={myColumns} rows={requests} loading={loading} error={error} pageSize={10}
          searchable={false} emptyTitle="No requests yet" emptyHint="Apply for leave from the Requests tab or self-service." />
      </SectionCard>
    </div>
  )
}

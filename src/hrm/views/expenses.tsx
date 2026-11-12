"use client"
// ============ Expense Claims (spec §10): submit → approve → reimburse,
// receipts as base64 attachments, accounting journal integration.
import { useEffect, useMemo, useState } from "react"
import { Plus, Receipt, Paperclip, Download, Info, Wallet, Clock, Check, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { useHrm } from "../store"
import { useApi, rpc, useEmployeeDirectory } from "../api"
import { useServerPagedList, PagedControls } from "../server-paged"
import { PageHeader, StatCard, StatusBadge, fmtMoney, fmtDate, titleCase, KV, todayDhaka } from "../shared/ui-kit"
import { DataTable, type Column } from "../shared/data-table"
import { ConfirmDialog } from "../shared/form-dialog"

const EXPENSE_CATEGORIES = ["TRAVEL", "FOOD", "MEDICAL", "OFFICE", "TRANSPORT", "CLIENT", "OTHER"]
const CAT_COLORS: Record<string, string> = {
  TRAVEL: "bg-teal-100 text-teal-700 dark:bg-teal-950 dark:text-teal-300",
  FOOD: "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
  MEDICAL: "bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300",
  OFFICE: "bg-slate-200 text-slate-600 dark:bg-slate-700 dark:text-slate-300",
  TRANSPORT: "bg-cyan-100 text-cyan-700 dark:bg-cyan-950 dark:text-cyan-300",
  CLIENT: "bg-violet-100 text-violet-700 dark:bg-violet-950 dark:text-violet-300",
  OTHER: "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300",
}

const mimeFor = (name?: string | null) => {
  const ext = (name || "").split(".").pop()?.toLowerCase()
  if (ext === "pdf") return "application/pdf"
  if (ext === "png") return "image/png"
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg"
  if (ext === "webp") return "image/webp"
  if (ext === "gif") return "image/gif"
  return "application/octet-stream"
}

export default function ExpensesView() {
  return <ExpensesPage />
}

function ExpensesPage() {
  const { can, user } = useHrm()
  const [status, setStatus] = useState("")
  const [q, setQ] = useState("")
  // P6 WS-B — server-paged list (MOD-16 contract): search + status +
  // pagination in SQL; the KPI strip reads the paged `summary` block.
  const { rows: pageRows, total, page, pageSize, maxPage, loading, error, reload, setPage, envelope } =
    useServerPagedList<any>("expenses.list", { status: status || undefined, q: q || undefined }, 50)
  const { data: employees } = useEmployeeDirectory()
  const [submitOpen, setSubmitOpen] = useState(false)
  const [detail, setDetail] = useState<any>(null)
  const [act, setAct] = useState<any>(null)
  const stats: any = envelope?.summary

  const isEmployee = user?.role === "EMPLOYEE"
  const canSubmit = can("expenses", "create") || can("ess", "create")

  // Inline approvals: cross-reference pending workflow requests (entityType
  // "ExpenseClaim") so approvers can act directly from this table.
  const canSeeQueue = can("approvals", "view")
  const { data: queue, reload: reloadQueue } = useApi<any[]>(canSeeQueue ? "approvals.queue" : null, { status: "PENDING" })
  const pendingApproval = useMemo(() => {
    const m = new Map<string, any>()
    for (const q of queue || []) {
      if (q.processType === "EXPENSE" && q.entityId) m.set(q.entityId, q)
    }
    return m
  }, [queue])

  const all = pageRows
  const rows = all

  // P6 WS-B — the KPI strip reads the set-based summary (cohort truth);
  // page-scoped fallbacks keep the cards honest if the envelope is absent
  const now = new Date()
  const pendingCount = stats ? Number(stats.pending) : all.filter((e) => e.status === "PENDING").length
  const reimbursedThisMonth = stats
    ? Number(stats.reimbursedThisMonth)
    : all
        .filter((e) => {
          if (e.status !== "REIMBURSED" || !e.reimbursementDate) return false
          const d = new Date(e.reimbursementDate)
          return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear()
        })
        .reduce((s, e) => s + (e.amount || 0), 0)
  const totalClaimed = stats ? Number(stats.totalClaimed) : all.reduce((s, e) => s + (e.amount || 0), 0)

  const columns: Column<any>[] = [
    {
      key: "employeeName", label: "Employee", sortValue: (e) => e.employeeName,
      render: (e) => (
        <div>
          <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">{e.employeeName}</p>
          <p className="text-[11px] text-slate-500 dark:text-slate-400">{e.employeeCode}</p>
        </div>
      ),
    },
    {
      key: "title", label: "Title", sortValue: (e) => e.title,
      render: (e) => (
        <div className="min-w-0">
          <p className="text-sm text-slate-700 dark:text-slate-200 truncate max-w-[240px]">{e.title}</p>
          {e.projectRef && <p className="text-[11px] text-slate-500 dark:text-slate-400">ref: {e.projectRef}</p>}
        </div>
      ),
    },
    { key: "category", label: "Category", render: (e) => <Badge className={`text-[10px] ${CAT_COLORS[e.category] || CAT_COLORS.OTHER}`}>{titleCase(e.category)}</Badge> },
    { key: "amount", label: "Amount", align: "right", sortValue: (e) => e.amount, render: (e) => <span className="text-xs font-semibold tabular-nums">{fmtMoney(e.amount)}</span> },
    { key: "date", label: "Date", sortValue: (e) => e.date, render: (e) => <span className="text-xs text-slate-500 tabular-nums">{fmtDate(e.date)}</span> },
    { key: "paymentMethod", label: "Payment", render: (e) => <span className="text-xs text-slate-500">{titleCase(e.paymentMethod)}</span> },
    { key: "status", label: "Status", render: (e) => <StatusBadge status={e.status} /> },
    { key: "reimbursementDate", label: "Reimbursed On", sortValue: (e) => e.reimbursementDate || "", render: (e) => <span className="text-xs text-slate-500 tabular-nums">{fmtDate(e.reimbursementDate)}</span> },
    {
      key: "receipt", label: "", align: "center",
      render: (e) => e.receiptData ? (
        <span title="Receipt attached" className="inline-flex items-center gap-1 text-[10px] text-emerald-600 font-medium"><Paperclip className="h-3 w-3" /> receipt</span>
      ) : null,
    },
    {
      key: "actions", label: "", align: "right",
      render: (e) => {
        const q = e.status === "PENDING" ? pendingApproval.get(e.id) : null
        return (
          <div className="flex items-center justify-end gap-1">
            {q && q.canAct && can("expenses", "approve") && (
              <>
                <Button size="sm" variant="outline" className="h-7 text-[10px] text-emerald-700 border-emerald-300 hover:bg-emerald-50 dark:text-emerald-400 dark:border-emerald-900"
                  onClick={() => setAct({ row: e, q, decision: "APPROVE" })}>
                  <Check className="h-3 w-3 mr-0.5" /> Approve
                </Button>
                <Button size="sm" variant="outline" className="h-7 text-[10px] text-rose-700 border-rose-300 hover:bg-rose-50 dark:text-rose-400 dark:border-rose-900"
                  onClick={() => setAct({ row: e, q, decision: "REJECT" })}>
                  <X className="h-3 w-3 mr-0.5" /> Reject
                </Button>
              </>
            )}
            {q && !q.canAct && (
              <Badge className="bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-500 dark:text-slate-400 text-[9px] whitespace-nowrap" title="Waiting for an earlier workflow step to complete">
                at step: {q.stepName}
              </Badge>
            )}
          </div>
        )
      },
    },
  ]

  return (
    <div className="space-y-4">
      <PageHeader
        title="Expense Claims"
        subtitle="Employee expense reimbursement with receipts, approval workflow and accounting integration"
        actions={canSubmit && (
          <Button size="sm" onClick={() => setSubmitOpen(true)} className="h-8 text-xs ">
            <Plus className="h-3.5 w-3.5 mr-1" /> Submit Claim
          </Button>
        )}
      />

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <StatCard label="Pending Claims" value={pendingCount} icon={Clock} tone="amber" />
        <StatCard label="Reimbursed This Month" value={fmtMoney(reimbursedThisMonth)} icon={Wallet} tone="emerald" />
        <StatCard label="Total Claimed" value={fmtMoney(totalClaimed)} icon={Receipt} tone="violet" />
      </div>

      <div className="flex flex-wrap gap-2">
        <FilterChip label="All" active={!status} onClick={() => setStatus("")} />
        {["PENDING", "REIMBURSED", "REJECTED"].map((s) => (
          <FilterChip key={s} label={titleCase(s)} active={status === s} onClick={() => setStatus(s)} />
        ))}
      </div>

      <DataTable
        columns={columns} rows={rows} loading={loading} error={error} pageSize={15} csvName="expense-claims"
        searchPlaceholder="Search employee, title…" onSearch={setQ} onRowClick={(e) => setDetail(e)}
        emptyTitle="No expense claims" emptyHint="Submit a claim with an attached receipt — approvals happen in the Approval Queue."
      />
      <PagedControls page={page} maxPage={maxPage} total={total} pageSize={pageSize} onPage={setPage} loading={loading} />

      <div className="rounded-xl border border-emerald-200 dark:border-emerald-900 bg-emerald-50/60 dark:bg-emerald-950/40 p-3 flex items-start gap-2">
        <Info className="h-4 w-4 text-emerald-600 mt-0.5 shrink-0" />
        <p className="text-xs text-slate-600 dark:text-slate-300">
          Approved claims are reimbursed and posted to the accounting journal (Employee Expense / Reimbursement).
        </p>
      </div>

      <ClaimFormDialog
        open={submitOpen}
        onOpenChange={(v) => { setSubmitOpen(v); if (!v) reload() }}
        employees={employees || []}
        isEmployee={isEmployee}
      />

      <ClaimDetailDialog claim={detail} onOpenChange={(v) => { if (!v) setDetail(null) }} />

      {/* inline approve/reject via the unified approval engine */}
      <ConfirmDialog open={!!act} onOpenChange={(v) => { if (!v) setAct(null) }}
        title={act?.decision === "APPROVE" ? "Approve expense claim" : "Reject expense claim"}
        message={act
          ? `${act.row.employeeName} — ${act.row.title}, ${fmtMoney(act.row.amount)} (${titleCase(act.row.category)}).${
              act.decision === "APPROVE"
                ? " Approving runs the next workflow step (reimbursement + accounting journal on final approval)."
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

function FilterChip({ label, active, onClick }: { label: string; active?: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick} className={`h-7 rounded-full px-3 text-xs font-medium border transition-colors ${active ? "bg-primary text-primary-foreground border-primary" : "bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-300 border-slate-200 dark:border-slate-700 hover:border-emerald-400"}`}>
      {label}
    </button>
  )
}

// ---------- Submit claim (custom dialog: receipt upload via FileReader → base64) ----------
function ClaimFormDialog({ open, onOpenChange, employees, isEmployee }: {
  open: boolean; onOpenChange: (v: boolean) => void; employees: any[]; isEmployee: boolean
}) {
  const toast = useHrm((s) => s.toast)
  const [values, setValues] = useState<Record<string, any>>({})
  const [file, setFile] = useState<{ name: string; data: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (open) {
      setError(null)
      setFile(null)
      setValues({
        employeeId: "", category: "TRAVEL", title: "", amount: "",
        date: todayDhaka(), description: "", projectRef: "", paymentMethod: "BANK",
      })
    }
  }, [open])

  const onFile = (f: File | null) => {
    if (!f) return setFile(null)
    if (f.size > 2 * 1024 * 1024) { setError("Receipt too large (max 2 MB)"); return }
    const reader = new FileReader()
    reader.onload = () => setFile({ name: f.name, data: String(reader.result).split(",")[1] || "" })
    reader.readAsDataURL(f)
  }

  const set = (n: string, v: any) => setValues((s) => ({ ...s, [n]: v }))

  const submit = async () => {
    if (!isEmployee && !values.employeeId) { setError("Employee is required"); return }
    if (!values.title) { setError("Title is required"); return }
    if (!(Number(values.amount) > 0)) { setError("Amount must be positive"); return }
    if (!values.date) { setError("Date is required"); return }
    setBusy(true)
    try {
      await rpc("expenses.create", {
        ...(isEmployee ? {} : { employeeId: values.employeeId }),
        category: values.category,
        title: values.title,
        amount: Number(values.amount),
        date: values.date,
        description: values.description || undefined,
        projectRef: values.projectRef || undefined,
        paymentMethod: values.paymentMethod,
        receiptName: file?.name,
        receiptData: file?.data,
      })
      toast("Expense claim submitted — pending approval")
      onOpenChange(false)
    } catch (e: any) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !busy && onOpenChange(v)}>
      <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-base">Submit Expense Claim</DialogTitle>
          <p className="text-xs text-slate-500">Claims go through the approval workflow; approved claims are reimbursed and posted to the accounting journal.</p>
        </DialogHeader>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 py-1">
          {!isEmployee && (
            <div className="space-y-1.5">
              <Label className="text-xs font-medium">Employee <span className="text-rose-500">*</span></Label>
              <Select value={values.employeeId || ""} onValueChange={(v) => set("employeeId", v)}>
                <SelectTrigger className="h-9"><SelectValue placeholder="Select employee…" /></SelectTrigger>
                <SelectContent>
                  {employees.map((e: any) => <SelectItem key={e.id} value={e.id}>{e.fullName} ({e.code})</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          )}
          <div className="space-y-1.5">
            <Label className="text-xs font-medium">Category</Label>
            <Select value={values.category || "TRAVEL"} onValueChange={(v) => set("category", v)}>
              <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
              <SelectContent>
                {EXPENSE_CATEGORIES.map((c) => <SelectItem key={c} value={c}>{titleCase(c)}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label className="text-xs font-medium">Title <span className="text-rose-500">*</span></Label>
            <Input value={values.title || ""} onChange={(e) => set("title", e.target.value)} className="h-9" placeholder="e.g. Client visit — intercity travel" />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs font-medium">Amount (৳) <span className="text-rose-500">*</span></Label>
            <Input type="number" min={1} value={values.amount ?? ""} onChange={(e) => set("amount", e.target.value)} className="h-9" placeholder="0" />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs font-medium">Date <span className="text-rose-500">*</span></Label>
            <Input type="date" value={values.date || ""} onChange={(e) => set("date", e.target.value)} className="h-9" />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs font-medium">Payment Method</Label>
            <Select value={values.paymentMethod || "BANK"} onValueChange={(v) => set("paymentMethod", v)}>
              <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
              <SelectContent>
                {["BANK", "MFS", "CASH", "OTHER"].map((m) => <SelectItem key={m} value={m}>{titleCase(m)}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs font-medium">Project Ref</Label>
            <Input value={values.projectRef || ""} onChange={(e) => set("projectRef", e.target.value)} className="h-9" placeholder="Optional" />
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label className="text-xs font-medium">Description</Label>
            <Textarea rows={2} value={values.description || ""} onChange={(e) => set("description", e.target.value)} placeholder="What was this expense for?" />
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label className="text-xs font-medium">Receipt (max 2 MB)</Label>
            <Input type="file" accept="image/*,.pdf" onChange={(e) => onFile(e.target.files?.[0] || null)} className="h-9 text-xs" />
            {file && <p className="text-[11px] text-emerald-600">✓ {file.name}</p>}
          </div>
        </div>
        {error && <p className="text-sm text-rose-600 dark:text-rose-400 bg-rose-50 dark:bg-rose-950 rounded-md px-3 py-2">{error}</p>}
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
          <Button onClick={submit} disabled={busy}>{busy ? "Submitting…" : "Submit Claim"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ---------- Claim detail dialog ----------
function ClaimDetailDialog({ claim, onOpenChange }: { claim: any; onOpenChange: (v: boolean) => void }) {
  if (!claim) return null

  const downloadReceipt = () => {
    const a = document.createElement("a")
    a.href = `data:${mimeFor(claim.receiptName)};base64,${claim.receiptData}`
    a.download = claim.receiptName || "receipt"
    document.body.appendChild(a)
    a.click()
    a.remove()
  }

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-base">{claim.title}</DialogTitle>
          <p className="text-xs text-slate-500">{claim.employeeName} · {fmtMoney(claim.amount)} · {fmtDate(claim.date)}</p>
        </DialogHeader>

        <KV cols={2} items={[
          ["Category", <Badge key="c" className={`text-[10px] ${CAT_COLORS[claim.category] || CAT_COLORS.OTHER}`}>{titleCase(claim.category)}</Badge>],
          ["Amount", fmtMoney(claim.amount)],
          ["Payment Method", titleCase(claim.paymentMethod)],
          ["Project Ref", claim.projectRef || "—"],
          ["Status", <StatusBadge key="s" status={claim.status} />],
          ["Reimbursed On", fmtDate(claim.reimbursementDate)],
        ]} />

        {claim.description && (
          <div>
            <p className="text-[11px] font-medium uppercase tracking-wide text-slate-400">Description</p>
            <p className="text-sm text-slate-600 dark:text-slate-300 whitespace-pre-wrap">{claim.description}</p>
          </div>
        )}

        {claim.receiptData ? (
          <div className="flex items-center justify-between gap-2 rounded-lg border px-3 py-2">
            <span className="flex items-center gap-1.5 text-xs text-slate-600 dark:text-slate-300 min-w-0">
              <Paperclip className="h-3.5 w-3.5 text-emerald-600 shrink-0" />
              receipt attached<span className="text-slate-400 truncate">({claim.receiptName})</span>
            </span>
            <Button size="sm" variant="outline" className="h-7 text-xs shrink-0" onClick={downloadReceipt}>
              <Download className="h-3 w-3 mr-1" /> Download
            </Button>
          </div>
        ) : (
          <p className="text-xs text-slate-400">No receipt attached.</p>
        )}

        <div className="rounded-lg bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-900 px-3 py-2 flex items-start gap-2">
          <Info className="h-3.5 w-3.5 text-emerald-600 mt-0.5 shrink-0" />
          <p className="text-[11px] text-slate-600 dark:text-slate-300">
            Approved claims are reimbursed and posted to the accounting journal (Employee Expense / Reimbursement).
          </p>
        </div>
      </DialogContent>
    </Dialog>
  )
}

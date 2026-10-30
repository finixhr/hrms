"use client"
// ============ Reimbursements (HRM-015) ============
// Payout register for approved expense claims: mark reimbursed (audited,
// cash journal posted), track journal linkage.
import { useMemo, useState } from "react"
import { HandCoins, Wallet, Clock, Info } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { useHrm } from "../store"
import { useApi, rpc, useEmployeeDirectory } from "../api"
import { PageHeader, StatCard, StatusBadge, fmtMoney, fmtDate, titleCase, ErrorBanner } from "../shared/ui-kit"
import { DataTable, type Column } from "../shared/data-table"
import { ConfirmDialog } from "../shared/form-dialog"

type Claim = {
  id: string
  employeeId: string
  employeeName: string
  employeeCode?: string | null
  category: string
  title: string
  amount: number
  approvedAmount?: number | null
  date: string
  paymentMethod?: string | null
  status: string
  reimbursementDate?: string | null
  journalId?: string | null
  reimbursementStatus: "APPROVED" | "REIMBURSED"
}

const CAT_COLORS: Record<string, string> = {
  TRAVEL: "bg-teal-100 text-teal-700 dark:bg-teal-950 dark:text-teal-300",
  FOOD: "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
  MEDICAL: "bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300",
  OFFICE: "bg-slate-200 text-slate-600 dark:bg-slate-700 dark:text-slate-300",
  TRANSPORT: "bg-cyan-100 text-cyan-700 dark:bg-cyan-950 dark:text-cyan-300",
  CLIENT: "bg-violet-100 text-violet-700 dark:bg-violet-950 dark:text-violet-300",
  OTHER: "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300",
}

// Sentinel for "All" in selects (Radix rejects value="").
const ALL = "__all__"

export default function ReimbursementsView() {
  const { can, toast } = useHrm()
  const [month, setMonth] = useState("")
  const [employeeId, setEmployeeId] = useState("")
  const [status, setStatus] = useState("")
  const [target, setTarget] = useState<Claim | null>(null)

  const { data: employees } = useEmployeeDirectory()

  const payload = useMemo(() => ({
    month: month || undefined,
    employeeId: employeeId || undefined,
    status: status || undefined,
  }), [month, employeeId, status])

  const canView = can("expenses", "view")
  const { data, loading, error, reload } = useApi<Claim[]>(canView ? "reimbursements.list" : null, payload)
  const rows = data || []

  const pending = rows.filter((r) => r.reimbursementStatus === "APPROVED")
  const reimbursed = rows.filter((r) => r.reimbursementStatus === "REIMBURSED")
  const payable = (r: Claim) => r.approvedAmount ?? r.amount
  const pendingSum = pending.reduce((s, r) => s + payable(r), 0)
  const reimbursedSum = reimbursed.reduce((s, r) => s + payable(r), 0)

  if (!canView) {
    return (
      <div className="space-y-4">
        <PageHeader title="Reimbursements" subtitle="Approved expense claim payouts" />
        <ErrorBanner message="You do not have permission to view reimbursements (expenses.view required)." />
      </div>
    )
  }

  const columns: Column<Claim>[] = [
    { key: "date", label: "Date", sortValue: (r) => r.date, render: (r) => <span className="text-xs text-slate-500 tabular-nums">{fmtDate(r.date)}</span> },
    {
      key: "employeeName", label: "Employee", sortValue: (r) => r.employeeName,
      render: (r) => (
        <div>
          <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">{r.employeeName}</p>
          <p className="text-[11px] text-slate-500 dark:text-slate-400">{r.employeeCode || "—"}</p>
        </div>
      ),
    },
    { key: "category", label: "Category", render: (r) => <Badge className={`text-[10px] ${CAT_COLORS[r.category] || CAT_COLORS.OTHER}`}>{titleCase(r.category)}</Badge> },
    {
      key: "title", label: "Title", sortValue: (r) => r.title,
      render: (r) => (
        <div className="min-w-0">
          <p className="text-sm text-slate-700 dark:text-slate-200 truncate max-w-[240px]">{r.title}</p>
          {r.reimbursementDate && <p className="text-[11px] text-slate-500 dark:text-slate-400">paid {fmtDate(r.reimbursementDate)}</p>}
        </div>
      ),
    },
    {
      key: "approvedAmount", label: "Approved Amount", align: "right", sortValue: (r) => payable(r),
      render: (r) => (
        <span className="text-xs font-semibold tabular-nums">
          {fmtMoney(payable(r))}
          {r.approvedAmount != null && r.approvedAmount !== r.amount && (
            <span className="ml-1 text-[10px] font-normal text-slate-400">(of {fmtMoney(r.amount)})</span>
          )}
        </span>
      ),
    },
    { key: "paymentMethod", label: "Payment", render: (r) => <span className="text-xs text-slate-500">{titleCase(r.paymentMethod)}</span> },
    { key: "reimbursementStatus", label: "Status", sortValue: (r) => r.reimbursementStatus, render: (r) => <StatusBadge status={r.reimbursementStatus} /> },
    {
      key: "journalId", label: "Journal", sortValue: (r) => (r.journalId ? "posted" : ""),
      render: (r) => r.journalId
        ? <span className="inline-flex items-center gap-1 text-[10px] font-medium text-emerald-600 dark:text-emerald-400" title={`Journal ${r.journalId}`}>✓ Posted</span>
        : <span className="text-xs text-slate-400">—</span>,
    },
    {
      key: "actions", label: "", align: "right",
      render: (r) => r.reimbursementStatus === "APPROVED" && can("expenses", "edit") ? (
        <Button size="sm" variant="outline" className="h-7 text-[10px] text-emerald-700 border-emerald-300 hover:bg-emerald-50 dark:text-emerald-400 dark:border-emerald-900"
          onClick={() => setTarget(r)}>
          <HandCoins className="h-3 w-3 mr-0.5" /> Mark Reimbursed
        </Button>
      ) : null,
    },
  ]

  return (
    <div className="space-y-4">
      <PageHeader
        title="Reimbursements"
        subtitle="Approved expense claim payouts — marking reimbursed stamps the date and posts the accounting journal"
      />

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <StatCard label="Pending Reimbursements" value={pending.length} sub={`${fmtMoney(pendingSum)} awaiting payout`} icon={Clock} tone="amber" />
        <StatCard label="Reimbursed (this filter)" value={reimbursed.length} sub={`${fmtMoney(reimbursedSum)} paid out`} icon={Wallet} tone="emerald" />
      </div>

      {/* Filter bar */}
      <div className="flex flex-wrap items-end gap-2">
        <div className="space-y-1.5">
          <Label className="text-xs font-medium">Month</Label>
          <Input type="month" value={month} onChange={(e) => setMonth(e.target.value)} className="h-9 w-[160px]" />
        </div>
        <div className="space-y-1.5 min-w-[200px]">
          <Label className="text-xs font-medium">Employee</Label>
          <Select value={employeeId || ALL} onValueChange={(v) => setEmployeeId(v === ALL ? "" : v)}>
            <SelectTrigger className="h-9"><SelectValue placeholder="All employees" /></SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All employees</SelectItem>
              {(employees || []).map((e: any) => (
                <SelectItem key={e.id} value={e.id}>{e.fullName} ({e.code})</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs font-medium">Status</Label>
          <Select value={status || ALL} onValueChange={(v) => setStatus(v === ALL ? "" : v)}>
            <SelectTrigger className="h-9 w-[150px]"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All</SelectItem>
              <SelectItem value="PENDING">Pending</SelectItem>
              <SelectItem value="REIMBURSED">Reimbursed</SelectItem>
            </SelectContent>
          </Select>
        </div>
        {(month || employeeId || status) && (
          <Button variant="ghost" size="sm" className="h-9 text-xs"
            onClick={() => { setMonth(""); setEmployeeId(""); setStatus("") }}>
            Clear filters
          </Button>
        )}
      </div>

      <DataTable
        columns={columns} rows={rows} loading={loading} error={error} pageSize={15} csvName="reimbursements"
        searchPlaceholder="Search employee, title…"
        emptyTitle="No reimbursements found"
        emptyHint="Approved expense claims appear here for payout — submit and approve claims under Expense Claims."
      />

      <div className="rounded-xl border border-emerald-200 dark:border-emerald-900 bg-emerald-50/60 dark:bg-emerald-950/40 p-3 flex items-start gap-2">
        <Info className="h-4 w-4 text-emerald-600 mt-0.5 shrink-0" />
        <p className="text-xs text-slate-600 dark:text-slate-300">
          Marking a claim reimbursed posts a cash journal (Staff Welfare &amp; Expenses / Cash &amp; Bank) and notifies the employee.
        </p>
      </div>

      {/* Mark reimbursed */}
      <ConfirmDialog open={!!target} onOpenChange={(v) => { if (!v) setTarget(null) }}
        title="Mark reimbursed"
        message={target
          ? `Confirm cash payout of ${fmtMoney(payable(target))} to ${target.employeeName} for "${target.title}" (${titleCase(target.category)}, ${titleCase(target.paymentMethod)})?`
          : ""}
        confirmLabel="Mark Reimbursed"
        onConfirm={async () => {
          if (!target) return
          await rpc("reimbursements.mark", { id: target.id })
          toast(`Reimbursed ${fmtMoney(payable(target))} to ${target.employeeName}`)
          reload()
        }} />
    </div>
  )
}

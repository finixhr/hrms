"use client"
// ============ Payroll (spec §9): run lifecycle DRAFT→…→PAID, salary structures,
// bonuses/commission, other deductions, provident fund and payslips.
// AIT/TDS lives in its own "AIT / Income Tax" module (views/ait.tsx) — this page
// only SNAPSHOTS the AIT deduction into runs/payslips; all tax setup and
// calculation happens there.
import { useEffect, useState, useMemo, useRef } from "react"
import {
  Plus, ArrowLeft, Calculator, Send, Banknote, FileText, RefreshCcw, Printer,
  CheckCircle2, XCircle, Trash2, Wallet, Clock, Gift, TrendingDown, Info, Pencil, Loader2, Mail,
  UserPlus, History, PiggyBank, Download, AlertTriangle, ShieldCheck, Ban, ChevronRight,
  Landmark, UserCheck, Coins, FileSpreadsheet, Upload, Check, Search, X,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { useHrm } from "../store"
import { useApi, rpc, useEmployeeDirectory, runJob } from "../api"
import { useServerPagedList, PagedControls } from "../server-paged"
import {
  PageHeader, StatCard, StatusBadge, fmtMoney, fmtDate, fmtDateTime, titleCase, SectionCard, SectionTabs, KV, minutesHHMM, openPrintWindow, ErrorBanner,
} from "../shared/ui-kit"
import { DataTable, type Column } from "../shared/data-table"
import { FormDialog, ConfirmDialog, type FieldDef } from "../shared/form-dialog"

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"]
const monthLabel = (m?: number | null) => (Number(m) >= 1 && Number(m) <= 12 ? MONTHS[Number(m) - 1] : "—")
const today = () => new Date().toISOString().slice(0, 10)
const DEDUCTION_TYPES = ["ABSENCE", "LATE", "ADVANCE", "LOAN", "AIT", "OTHER"]

export default function PayrollView() {
  const { can, view } = useHrm()
  const [payslipRunId, setPayslipRunId] = useState<string | null>(null)
  // global-search deep link: seed the internal tab state from view params
  // (the view remounts on param change, so the initializer runs per navigation)
  const [nav, setNav] = useState({ tab: ((view.params as any)?.tab as string) || "runs", seq: 0 })

  const showPayslips = (runId: string) => {
    setPayslipRunId(runId)
    setNav((s) => ({ tab: "payslips", seq: s.seq + 1 }))
  }

  // UI-R7 (2026-10-04 UI audit): the 9 payroll tabs rendered as one wrapping
  // pill row. Grouped into three workflow sections — Pay Runs / Structures /
  // Rewards & Deductions. Tab values (and permission gates) unchanged, so
  // global-search deep links and showPayslips() navigation keep working.
  const groups = [
    { label: "Pay Runs", tabs: [
      { value: "runs", label: "Payroll Runs", content: <RunsTab onShowPayslips={showPayslips} /> },
      ...(can("payslip", "view") ? [{ value: "payslips", label: "Payslips", content: <PayslipsTab runId={payslipRunId} presetEmployeeId={((view.params as any)?.employeeId as string) || null} /> }] : []),
      ...(can("payroll", "export") ? [{ value: "export", label: "Salary Export", content: <SalaryExportTab /> }] : []),
      // WP-F — accounting journals viewer (refType/date filters + line drill-down)
      ...(can("accounting", "view") ? [{ value: "journals", label: "Journals", content: <JournalsTab /> }] : []),
    ] },
    { label: "Structures", tabs: [
      { value: "structures", label: "Salary Structures", content: <StructuresTab /> },
      ...(can("payroll", "view") ? [{ value: "templates", label: "Salary Templates", content: <TemplatesTab /> }] : []),
      ...(can("settings", "edit") ? [{ value: "payout", label: "Payout Settings", content: <PayoutSettingsTab /> }] : []),
    ] },
    // 2026-10-14 — Loan & Advance recovery control system: settings switches
    // (incl. guarantor fallback), the period recovery plan (who pays each
    // installment — borrower / guarantor / deferred — with exact amounts) and
    // per-guarantor exposure, all mirrored from the payroll engine's rules.
    ...(can("payroll", "view") ? [{ label: "Recovery Control", tabs: [
      { value: "loanControl", label: "Loan & Advance Control", content: <LoanAdvanceControlTab /> },
    ] }] : []),
  ]

  return (
    <div className="space-y-4">
      <PageHeader
        title="Payroll"
        subtitle="Monthly payroll runs, salary structures and payslips — Deductions and Provident Fund have their own menu entries under Payroll & Finance"
      />
      <SectionTabs key={`${nav.tab}-${nav.seq}`} defaultValue={nav.tab} groups={groups} />
    </div>
  )
}

// ================= STANDALONE DEDUCTIONS VIEW =================
// Mounted as its own sidebar page: Payroll & Finance → Deductions
export function DeductionsView() {
  return (
    <div className="space-y-4">
      <PageHeader
        title="Deductions"
        subtitle="One-time and recurring salary deductions applied at payroll calculation"
      />
      <DeductionsTab />
    </div>
  )
}

// ================= STANDALONE PROVIDENT FUND VIEW =================
// Mounted as its own sidebar page: Payroll & Finance → Provident Fund
export function PfView() {
  return (
    <div className="space-y-4">
      <PageHeader
        title="Provident Fund"
        subtitle="Employee enrollments, contribution ledger, and PF policy settings"
      />
      <PfTab />
    </div>
  )
}

// ================= PAYROLL RUNS =================
function RunsTab({ onShowPayslips }: { onShowPayslips: (runId: string) => void }) {
  const { can } = useHrm()
  const { data, loading, error, reload } = useApi<any[]>("payroll.runs.list", {})
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const [preflightOpen, setPreflightOpen] = useState(false)
  const run = (data || []).find((r: any) => r.id === selectedId)

  if (run) {
    return <RunDetail run={run} onBack={() => setSelectedId(null)} onRunsChanged={reload} onShowPayslips={onShowPayslips} />
  }

  const columns: Column<any>[] = [
    {
      key: "period", label: "Period", sortValue: (r) => `${r.periodYear}-${String(r.periodMonth).padStart(2, "0")}`,
      render: (r) => (
        <div>
          <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">{monthLabel(r.periodMonth)} {r.periodYear}</p>
          {r.runType === "ADJUSTMENT" && <p className="text-[10px] text-amber-600 font-medium">adjustment run</p>}
        </div>
      ),
    },
    {
      key: "runType", label: "Type",
      render: (r) => <Badge variant="outline" className={r.runType === "ADJUSTMENT" ? "text-[10px] bg-amber-50 border-amber-300 text-amber-700" : "text-[10px]"}>{titleCase(r.runType)}</Badge>,
    },
    { key: "status", label: "Status", render: (r) => <StatusBadge status={r.status} /> },
    { key: "employeeCount", label: "Employees", align: "right", sortValue: (r) => r.employeeCount, render: (r) => <span className="text-xs font-semibold tabular-nums">{r.employeeCount}</span> },
    { key: "totalGross", label: "Gross", align: "right", sortValue: (r) => r.totalGross, render: (r) => <span className="text-xs text-slate-600 dark:text-slate-300 tabular-nums">{fmtMoney(r.totalGross)}</span> },
    { key: "totalOt", label: "OT", align: "right", sortValue: (r) => r.totalOt, render: (r) => <span className="text-xs tabular-nums">{fmtMoney(r.totalOt)}</span> },
    { key: "totalBonus", label: "Bonus", align: "right", sortValue: (r) => r.totalBonus, render: (r) => <span className="text-xs tabular-nums">{fmtMoney(r.totalBonus)}</span> },
    { key: "totalDeduction", label: "Deductions", align: "right", sortValue: (r) => r.totalDeduction, render: (r) => <span className="text-xs tabular-nums">{fmtMoney(r.totalDeduction)}</span> },
    { key: "totalAit", label: "AIT", align: "right", sortValue: (r) => r.totalAit, render: (r) => <span className="text-xs tabular-nums">{fmtMoney(r.totalAit)}</span> },
    { key: "totalNet", label: "Net", align: "right", sortValue: (r) => r.totalNet, render: (r) => <span className="text-sm font-bold text-emerald-600 dark:text-emerald-400 tabular-nums">{fmtMoney(r.totalNet)}</span> },
    { key: "paymentDate", label: "Payment Date", sortValue: (r) => r.paymentDate || "", render: (r) => <span className="text-xs text-slate-500 tabular-nums">{fmtDate(r.paymentDate)}</span> },
  ]

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-slate-500 flex items-start gap-1.5 min-w-0">
          <Info className="h-3.5 w-3.5 text-emerald-600 shrink-0 mt-0.5" />
          <span className="min-w-0">
            <span className="block truncate">Auto-run scheduling and the attendance cutoff day are configured in HR Settings → Payroll.</span>
            <span className="block truncate text-slate-400 dark:text-slate-500">Run flow: DRAFT → CALCULATED → HR → MANAGER → ACCOUNTING → APPROVED → PAID</span>
          </span>
        </p>
        <div className="flex items-center gap-1.5">
          {/* WP-G — preflight preview beside New Run */}
          {can("payroll", "view") && (
            <Button size="sm" variant="outline" onClick={() => setPreflightOpen(true)} className="h-8 text-xs">
              <ShieldCheck className="h-3.5 w-3.5 mr-1" /> Preflight
            </Button>
          )}
          {can("payroll", "create") && (
            <Button size="sm" onClick={() => setCreateOpen(true)} className="h-8 text-xs ">
              <Plus className="h-3.5 w-3.5 mr-1" /> New Run
            </Button>
          )}
        </div>
      </div>
      <PreflightPanel open={preflightOpen} onOpenChange={setPreflightOpen} />
      <DataTable
        columns={columns} rows={data || undefined} loading={loading} error={error} pageSize={12} csvName="payroll-runs"
        searchPlaceholder="Search period…" onRowClick={(r) => setSelectedId(r.id)}
        emptyTitle="No payroll runs yet" emptyHint="Create a run for the salary month, then calculate it to generate entries."
      />
      {/* P2 — adjustment-run reversal register (hidden when there are none) */}
      <ReversalRegister />
      <FormDialog
        open={createOpen} onOpenChange={(v) => { setCreateOpen(v); if (!v) reload() }}
        title="New Payroll Run"
        description="Creates a DRAFT run for the salary month. Attendance, structures, bonuses, loan/advance recovery and AIT are snapshotted when you calculate."
        submitLabel="Create Run"
        fields={[
          { name: "month", label: "Salary Month", type: "select", required: true, options: MONTHS.map((m, i) => ({ value: String(i + 1), label: m })), defaultValue: String(new Date().getMonth() + 1) },
          { name: "year", label: "Year", type: "number", required: true, defaultValue: new Date().getFullYear() },
        ]}
        onSubmit={async (v) => { await rpc("payroll.runs.create", { periodMonth: Number(v.month), periodYear: Number(v.year) }) }}
      />
    </div>
  )
}

// ================= RUN DETAIL =================
function RunDetail({ run, onBack, onRunsChanged, onShowPayslips }: {
  run: any; onBack: () => void; onRunsChanged: () => void; onShowPayslips: (runId: string) => void
}) {
  const { can } = useHrm()
  // P6 WS-B — server-paged entries (MOD-16 contract): a 10K-employee run no
  // longer ships every entry + breakdown JSON to the browser; the Loan/PF
  // KPI cards read the run-scoped `summary` block instead of page sums.
  const [q, setQ] = useState("")
  const { rows: entryRows, total, page, pageSize, maxPage, loading, error, reload, setPage, envelope } =
    useServerPagedList<any>("payroll.entries", { runId: run.id, q: q || undefined }, 50)
  const [confirmKind, setConfirmKind] = useState<null | "calculate" | "submit" | "pay" | "adjustment" | "payoutConfirm" | "cancelRun">(null)
  const [entry, setEntry] = useState<any>(null)
  const stats: any = envelope?.summary

  const r = (envelope as any)?.run || run
  const entries = entryRows

  const confirmations = {
    calculate: {
      title: "Calculate payroll",
      message: `Compute salary entries for ${monthLabel(r.periodMonth)} ${r.periodYear}? Attendance, OT, bonuses, deductions, loan/advance recovery and AIT are snapshotted at this moment.`,
      label: "Calculate",
    },
    submit: {
      title: "Submit for approval",
      message: "Send this calculated run into the approval workflow (HR review → Manager → Accounting)? It moves to HR_REVIEW and becomes read-only for editing.",
      label: "Submit",
    },
    pay: {
      title: "Pay now",
      message: "Pays salaries, generates payslips, posts the accounting journal and recovers outstanding loans/advances. This action is irreversible.",
      label: "Pay Now",
    },
    adjustment: {
      title: "Create adjustment run",
      message: "Approved payroll is immutable; corrections use adjustment runs. A new DRAFT ADJUSTMENT run is created for the same period.",
      label: "Create Adjustment",
    },
    // WP-F — payout confirmation + run cancellation
    payoutConfirm: {
      title: "Confirm salary payout",
      message: "Marks the disbursement as settled in the books: Dr Salaries Payable, Cr Bank / Cash / MFS split by each employee's payout method. Idempotent — confirming twice posts nothing.",
      label: "Confirm Payout",
    },
    cancelRun: {
      title: "Cancel this run",
      message: "A PAID run with a posted journal posts a full reversal entry (every debit becomes a credit), reverts loan/advance recoveries, bonuses and deductions, and voids payslips. The month can then be re-created and re-paid from scratch.",
      label: "Cancel Run",
    },
  } as const

  const act = async () => {
    if (confirmKind === "calculate") await rpc("payroll.calculate", { runId: r.id })
    if (confirmKind === "submit") await rpc("payroll.submitApproval", { runId: r.id })
    if (confirmKind === "pay") await rpc("payroll.pay", { runId: r.id })
    if (confirmKind === "adjustment") await rpc("payroll.adjustmentCreate", { runId: r.id })
    if (confirmKind === "payoutConfirm") await rpc("payroll.payout.confirm", { runId: r.id })
    if (confirmKind === "cancelRun") await rpc("payroll.runs.cancel", { runId: r.id, reason: "Cancelled from Payroll run detail" })
    reload()
    onRunsChanged()
  }

  const entryColumns: Column<any>[] = [
    {
      key: "employeeName", label: "Employee", sortValue: (e) => e.employeeName,
      render: (e) => (
        <div className="min-w-0">
          <p className="text-sm font-semibold text-slate-800 dark:text-slate-100 truncate">{e.employeeName}</p>
          <p className="text-[11px] text-slate-500 dark:text-slate-400">{e.employeeCode} · {e.designationName || "—"}</p>
        </div>
      ),
    },
    { key: "presentDays", label: "Present", align: "right", sortValue: (e) => e.presentDays, render: (e) => <span className="text-xs tabular-nums">{e.presentDays}d</span> },
    { key: "absentDays", label: "Absent", align: "right", sortValue: (e) => e.absentDays, render: (e) => <span className={`text-xs tabular-nums ${e.absentDays > 0 ? "text-rose-600" : ""}`}>{e.absentDays}d</span> },
    { key: "gross", label: "Gross", align: "right", sortValue: (e) => e.gross, render: (e) => <span className="text-xs text-slate-600 dark:text-slate-300 tabular-nums">{fmtMoney(e.gross)}</span> },
    { key: "otAmount", label: "OT", align: "right", sortValue: (e) => e.otAmount, render: (e) => <span className="text-xs tabular-nums">{fmtMoney(e.otAmount)}</span> },
    { key: "bonus", label: "Bonus", align: "right", sortValue: (e) => e.bonus, render: (e) => <span className="text-xs tabular-nums">{fmtMoney(e.bonus)}</span> },
    { key: "commission", label: "Commission", align: "right", sortValue: (e) => e.commission, render: (e) => <span className="text-xs tabular-nums">{fmtMoney(e.commission)}</span> },
    // 2026-10-14 — the ACTUAL loan / advance / guarantor deduction amounts,
    // visible at calculation time (before final approval) per the recovery
    // control requirements. Zero amounts render muted so healthy rows stay
    // scannable.
    { key: "loanDeduction", label: "Loan", align: "right", sortValue: (e) => e.loanDeduction || 0, render: (e) => <span className={`text-xs tabular-nums ${(e.loanDeduction || 0) > 0 ? "text-amber-700 dark:text-amber-400 font-medium" : "text-slate-300 dark:text-slate-600"}`}>{fmtMoney(e.loanDeduction || 0)}</span> },
    { key: "advanceDeduction", label: "Advance", align: "right", sortValue: (e) => e.advanceDeduction || 0, render: (e) => <span className={`text-xs tabular-nums ${(e.advanceDeduction || 0) > 0 ? "text-amber-700 dark:text-amber-400 font-medium" : "text-slate-300 dark:text-slate-600"}`}>{fmtMoney(e.advanceDeduction || 0)}</span> },
    { key: "guarantorDeduction", label: "Guarantor", align: "right", sortValue: (e) => e.guarantorDeduction || 0, render: (e) => (e.guarantorDeduction || 0) > 0
      ? <span className="text-xs tabular-nums text-violet-700 dark:text-violet-400 font-medium" title="Loan/advance installments of absent borrowers recovered from this employee as guarantor">{fmtMoney(e.guarantorDeduction)}</span>
      : <span className="text-xs tabular-nums text-slate-300 dark:text-slate-600">{fmtMoney(0)}</span> },
    {
      key: "pfDeduction", label: "PF", align: "right",
      sortValue: (e) => e.pfDeduction ?? e.breakdown?.pf?.employeeAmount ?? 0,
      render: (e) => {
        const val = e.pfDeduction ?? e.breakdown?.pf?.employeeAmount ?? 0
        return val > 0 ? (
          <span className="text-xs tabular-nums text-cyan-700 dark:text-cyan-400 font-medium" title="Provident Fund (Employee Contribution)">
            {fmtMoney(val)}
          </span>
        ) : (
          <span className="text-xs tabular-nums text-slate-300 dark:text-slate-600">{fmtMoney(0)}</span>
        )
      },
    },
    { key: "ait", label: "AIT", align: "right", sortValue: (e) => e.ait, render: (e) => <span className="text-xs tabular-nums">{fmtMoney(e.ait)}</span> },
    { key: "net", label: "Net", align: "right", sortValue: (e) => e.net, render: (e) => <span className="text-sm font-bold text-emerald-600 dark:text-emerald-400 tabular-nums">{fmtMoney(e.net)}</span> },
  ]

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button variant="ghost" size="sm" onClick={onBack} className="h-8 text-xs">
          <ArrowLeft className="h-4 w-4 mr-1" /> All Runs
        </Button>
        <div className="flex items-center gap-2">
          {r.runType === "ADJUSTMENT" && <Badge variant="outline" className="bg-amber-50 border-amber-300 text-amber-700 text-[10px]">Adjustment</Badge>}
          <StatusBadge status={r.status} />
        </div>
      </div>

      <SectionCard title={`${monthLabel(r.periodMonth)} ${r.periodYear} — Payroll Run${r.runType === "ADJUSTMENT" ? " (Adjustment — deltas vs the paid source run)" : ""}`}>
        {/* PAY-001 — adjustment runs carry CORRECTIONS, never a second month */}
        {r.runType === "ADJUSTMENT" && (
          <p className="text-[11px] leading-relaxed bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-900 text-amber-800 dark:text-amber-300 rounded-md px-2.5 py-1.5 mb-2">
            Adjustment run #{r.adjustSeq ?? 1} — every entry is the <b>correction</b> against the paid source run
            (recomputed − paid). A negative net is an amount recovered from the employee, not a payout. The totals
            below are deltas, not a second month of payroll.
          </p>
        )}
        <div className="flex flex-col lg:flex-row lg:items-end justify-between gap-3">
          <KV cols={4} items={[
            ["Period", `${monthLabel(r.periodMonth)} ${r.periodYear}`],
            ["Cutoff Date", fmtDate(r.cutoffDate)],
            ["Employees", r.employeeCount],
            ["Payment Date", fmtDate(r.paymentDate)],
            ...(r.payoutConfirmedAt ? ([["Payout Confirmed", fmtDateTime(r.payoutConfirmedAt)]] as [string, React.ReactNode][]) : []),
          ]} />
          <div className="flex flex-wrap gap-1.5">
            {r.status === "DRAFT" && can("payroll", "calculate") && (
              <Button size="sm" onClick={() => setConfirmKind("calculate")} className="h-8 text-xs ">
                <Calculator className="h-3.5 w-3.5 mr-1" /> Calculate
              </Button>
            )}
            {r.status === "CALCULATED" && can("payroll", "process") && (
              <Button size="sm" onClick={() => setConfirmKind("submit")} className="h-8 text-xs ">
                <Send className="h-3.5 w-3.5 mr-1" /> Submit for Approval
              </Button>
            )}
            {r.status === "APPROVED" && can("payroll", "pay") && (
              <Button size="sm" onClick={() => setConfirmKind("pay")} className="h-8 text-xs ">
                <Banknote className="h-3.5 w-3.5 mr-1" /> Pay Now
              </Button>
            )}
            {r.status === "PAID" && can("payroll", "create") && (
              <Button size="sm" variant="outline" onClick={() => setConfirmKind("adjustment")} className="h-8 text-xs">
                <RefreshCcw className="h-3.5 w-3.5 mr-1" /> Create Adjustment Run
              </Button>
            )}
            {r.status === "PAID" && can("payslip", "view") && (
              <Button size="sm" variant="outline" onClick={() => onShowPayslips(r.id)} className="h-8 text-xs">
                <FileText className="h-3.5 w-3.5 mr-1" /> Payslips
              </Button>
            )}
            {/* WP-F — payout confirmation leg + cancellation with reversal */}
            {r.status === "PAID" && can("payroll", "pay") && !r.payoutConfirmedAt && (
              <Button size="sm" variant="outline" className="h-8 text-xs border-emerald-300 text-emerald-700 dark:text-emerald-400" onClick={() => setConfirmKind("payoutConfirm")}>
                <CheckCircle2 className="h-3.5 w-3.5 mr-1" /> Confirm Payout
              </Button>
            )}
            {r.status === "PAID" && r.payoutConfirmedAt && (
              <Badge variant="outline" className="text-[10px] border-emerald-300 text-emerald-700 dark:text-emerald-400">
                <CheckCircle2 className="h-3 w-3 mr-1" /> Payout confirmed {fmtDateTime(r.payoutConfirmedAt)}
              </Badge>
            )}
            {["DRAFT", "CALCULATED", "HR_REVIEW", "APPROVED", "PAID"].includes(r.status) && can("payroll", "pay") && (
              <Button size="sm" variant="outline" className="h-8 text-xs border-rose-200 text-rose-600 dark:text-rose-400" onClick={() => setConfirmKind("cancelRun")}>
                <XCircle className="h-3.5 w-3.5 mr-1" /> Cancel Run
              </Button>
            )}
          </div>
        </div>
      </SectionCard>

      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-8 gap-3">
        <StatCard label="Gross" value={fmtMoney(r.totalGross)} icon={Wallet} tone="emerald" />
        <StatCard label="Overtime" value={fmtMoney(r.totalOt)} icon={Clock} tone="teal" />
        <StatCard label="Bonus" value={fmtMoney(r.totalBonus)} icon={Gift} tone="violet" />
        {/* 2026-10-14 — Loan + Advance recovery total (the amount that lands on
            the loan/advance ledgers at final approval) shown on the run card
            so the deduction is visible at calculation time. */}
        <StatCard label="Loan+Adv Recovery" value={fmtMoney(stats ? Number(stats.loanRecovery) + Number(stats.advanceRecovery) + Number(stats.guarantorRecovery) : entries.reduce((s: number, e: any) => s + (e.loanDeduction || 0) + (e.advanceDeduction || 0) + (e.guarantorDeduction || 0), 0))} icon={Landmark} tone="amber" />
        <StatCard label="Provident Fund" value={fmtMoney(stats ? Number(stats.pfEmployee) : entries.reduce((s: number, e: any) => s + (e.pfDeduction ?? e.breakdown?.pf?.employeeAmount ?? 0), 0))} icon={PiggyBank} tone="cyan" />
        <StatCard label="Deductions + AIT" value={fmtMoney((r.totalDeduction || 0) + (r.totalAit || 0))} icon={TrendingDown} tone="rose" />
        <StatCard label="Net Payable" value={fmtMoney(r.totalNet)} icon={Banknote} tone="emerald" />
        <StatCard label="Status" value={titleCase(r.status)} icon={Info} tone="slate" />
      </div>

      <DataTable
        columns={entryColumns} rows={entries} loading={loading} error={error} pageSize={15} csvName="payroll-run"
        searchPlaceholder="Search employee…" onSearch={setQ} onRowClick={(e) => setEntry(e)}
        emptyTitle="No entries yet" emptyHint="Calculate the run to generate per-employee salary entries."
      />
      <PagedControls page={page} maxPage={maxPage} total={total} pageSize={pageSize} onPage={setPage} loading={loading} />

      <ConfirmDialog
        open={!!confirmKind}
        onOpenChange={(v) => { if (!v) setConfirmKind(null) }}
        title={confirmKind ? confirmations[confirmKind].title : ""}
        message={confirmKind ? confirmations[confirmKind].message : ""}
        confirmLabel={confirmKind ? confirmations[confirmKind].label : "Confirm"}
        danger={confirmKind === "pay" || confirmKind === "cancelRun"}
        onConfirm={act}
      />

      <BreakdownDialog entry={entry} onOpenChange={(v) => { if (!v) setEntry(null) }} />
    </div>
  )
}

// ---------- Entry breakdown dialog ----------
function BreakdownDialog({ entry, onOpenChange }: { entry: any; onOpenChange: (v: boolean) => void }) {
  if (!entry) return null
  const bd = entry.breakdown || {}
  const earnings: any[] = bd.earnings || []
  const deductions: any[] = bd.deductions || []
  const att = bd.attendance || {}
  // 2026-10-14 — AIT is rendered EXACTLY ONCE. The engine's breakdown already
  // carries the AIT line (labelled with the applied rule set, e.g. "AIT (FY
  // 2025-26 (Income Tax Act 2023))"); legacy entries without a breakdown AIT
  // line fall back to a single "AIT (income tax)" row from the entry column.
  // The previous dialog appended the hardcoded row unconditionally — AIT
  // showed twice with identical amounts (e.g. ৳72,721 + ৳72,721).
  const AIT_LABEL = /^AIT\s*\(/i
  const breakdownAit = deductions.find((d: any) => AIT_LABEL.test(String(d.label)))
  const pfAmount = Number(entry.pfDeduction ?? bd.pf?.employeeAmount ?? 0)
  const hasPfInDeductions = deductions.some((d: any) => /provident fund/i.test(String(d.label)))
  const extraPfLines = !hasPfInDeductions && pfAmount > 0 ? [{ label: "Provident Fund (Employee)", amount: pfAmount }] : []
  const otherDeductionLines = [...deductions.filter((d: any) => !AIT_LABEL.test(String(d.label))), ...extraPfLines]
  const aitLabel = breakdownAit ? String(breakdownAit.label) : "AIT (income tax)"
  const aitAmount = breakdownAit ? Number(breakdownAit.amount) || 0 : Number(entry.ait) || 0
  const guarantorLines: any[] = Array.isArray(bd.guarantorRecoveries) ? bd.guarantorRecoveries : []
  const grossTotal = (entry.gross || 0) + (entry.otAmount || 0) + (entry.bonus || 0) + (entry.commission || 0)
  const deductionsTotal = otherDeductionLines.reduce((s: number, d: any) => s + (Number(d.amount) || 0), 0) + aitAmount

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-base">Breakdown — {entry.employeeName}</DialogTitle>
          <p className="text-xs text-slate-500">{entry.designationName || "—"} · {entry.branchName || "—"} · {entry.departmentName || "—"}</p>
        </DialogHeader>

        <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
          {([
            ["Present", `${att.presentDays ?? entry.presentDays ?? 0}d`],
            ["Absent", `${att.absentDays ?? entry.absentDays ?? 0}d`],
            ["Leave", `${att.leaveDays ?? entry.leaveDays ?? 0}d`],
            ["Late", `${att.lateDays != null ? `${att.lateDays}d · ` : ""}${minutesHHMM(att.lateMinutes ?? entry.lateMinutes)}`],
            ["Overtime", minutesHHMM(att.otMinutes ?? entry.otMinutes)],
          ] as [string, string][]).map(([k, v]) => (
            <div key={k} className="rounded-lg border bg-slate-50 dark:bg-slate-900 px-2.5 py-1.5 text-center">
              <p className="text-[10px] uppercase tracking-wide text-slate-400">{k}</p>
              <p className="text-xs font-bold tabular-nums">{v}</p>
            </div>
          ))}
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div className="rounded-lg border overflow-hidden">
            <div className="px-3 py-1.5 bg-emerald-50 dark:bg-emerald-950 text-[11px] font-semibold uppercase tracking-wide text-emerald-700 dark:text-emerald-400">Earnings</div>
            <Table>
              <TableBody>
                {earnings.map((e: any, i: number) => (
                  <TableRow key={i}>
                    <TableCell className="text-xs py-1.5">{e.label}</TableCell>
                    <TableCell className="text-xs py-1.5 text-right tabular-nums">{fmtMoney(e.amount)}</TableCell>
                  </TableRow>
                ))}
                <TableRow><TableCell className="text-xs py-1.5">Overtime</TableCell><TableCell className="text-xs py-1.5 text-right tabular-nums">{fmtMoney(entry.otAmount)}</TableCell></TableRow>
                <TableRow><TableCell className="text-xs py-1.5">Bonus</TableCell><TableCell className="text-xs py-1.5 text-right tabular-nums">{fmtMoney(entry.bonus)}</TableCell></TableRow>
                <TableRow><TableCell className="text-xs py-1.5">Commission</TableCell><TableCell className="text-xs py-1.5 text-right tabular-nums">{fmtMoney(entry.commission)}</TableCell></TableRow>
                <TableRow className="bg-emerald-50/50 dark:bg-emerald-950/40">
                  <TableCell className="text-xs font-bold py-1.5">Gross Earnings</TableCell>
                  <TableCell className="text-xs font-bold py-1.5 text-right tabular-nums text-emerald-700 dark:text-emerald-400">{fmtMoney(grossTotal)}</TableCell>
                </TableRow>
              </TableBody>
            </Table>
          </div>

          <div className="rounded-lg border overflow-hidden">
            <div className="px-3 py-1.5 bg-rose-50 dark:bg-rose-950 text-[11px] font-semibold uppercase tracking-wide text-rose-700 dark:text-rose-400">Deductions</div>
            <Table>
              <TableBody>
                {otherDeductionLines.length === 0 && aitAmount === 0 && (
                  <TableRow><TableCell className="text-xs text-slate-400 py-1.5">No deductions</TableCell><TableCell /></TableRow>
                )}
                {otherDeductionLines.map((d: any, i: number) => (
                  <TableRow key={`od-${i}`}>
                    <TableCell className="text-xs py-1.5">{d.label}</TableCell>
                    <TableCell className="text-xs py-1.5 text-right tabular-nums">{fmtMoney(d.amount)}</TableCell>
                  </TableRow>
                ))}
                {aitAmount > 0 && (
                  <TableRow>
                    <TableCell className="text-xs py-1.5">{aitLabel}</TableCell>
                    <TableCell className="text-xs py-1.5 text-right tabular-nums">{fmtMoney(aitAmount)}</TableCell>
                  </TableRow>
                )}
                <TableRow className="bg-rose-50/50 dark:bg-rose-950/40">
                  <TableCell className="text-xs font-bold py-1.5">Total Deductions</TableCell>
                  <TableCell className="text-xs font-bold py-1.5 text-right tabular-nums text-rose-700 dark:text-rose-400">{fmtMoney(deductionsTotal)}</TableCell>
                </TableRow>
              </TableBody>
            </Table>
          </div>
        </div>

        {/* Late leave adjustment detail */}
        {bd.lateLeaveAdjustment && bd.lateLeaveAdjustment.adjustedDays > 0 && (
          <div className="rounded-lg border border-amber-200 dark:border-amber-900 bg-amber-50/60 dark:bg-amber-950/30 px-3 py-2.5">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-400 mb-1.5 flex items-center gap-1.5">
              <Clock className="h-3.5 w-3.5" /> Late-policy leave adjustment
            </p>
            <div className="space-y-1 text-xs text-slate-700 dark:text-slate-300">
              <div className="flex items-center justify-between gap-3">
                <span>Leave deducted ({bd.lateLeaveAdjustment.leaveTypeName})</span>
                <span className="font-semibold tabular-nums text-amber-700 dark:text-amber-400">{bd.lateLeaveAdjustment.adjustedDays}d</span>
              </div>
              {bd.lateLeaveAdjustment.unadjustedDays > 0 && (
                <div className="flex items-center justify-between gap-3">
                  <span>Insufficient balance — remaining deducted from salary</span>
                  <span className="font-semibold tabular-nums text-rose-600 dark:text-rose-400">{bd.lateLeaveAdjustment.unadjustedDays}d</span>
                </div>
              )}
              <div className="flex items-center justify-between gap-3 border-t pt-1 dark:border-amber-800/50">
                <span className="text-[10px] text-amber-600 dark:text-amber-400/80">Total late days triggering policy: {att.lateDays ?? 0}d · Deduction days: {bd.lateLeaveAdjustment.totalDays}d</span>
              </div>
            </div>
          </div>
        )}

        {/* Guarantor recovery detail */}
        {guarantorLines.length > 0 && (
          <div className="rounded-lg border border-violet-200 dark:border-violet-900 bg-violet-50/60 dark:bg-violet-950/30 px-3 py-2.5">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-violet-700 dark:text-violet-400 mb-1.5 flex items-center gap-1.5">
              <UserCheck className="h-3.5 w-3.5" /> Guarantor recovery — {fmtMoney(entry.guarantorDeduction || guarantorLines.reduce((s: number, g: any) => s + (Number(g.amount) || 0), 0))}
            </p>
            <div className="space-y-1">
              {guarantorLines.map((g: any, i: number) => (
                <div key={`g-${i}`} className="flex items-center justify-between gap-3 text-xs">
                  <span className="text-slate-700 dark:text-slate-300">
                    {g.kind === "ADVANCE" ? "Advance" : "Loan"} installment of <b>{g.borrowerName || "the borrower"}</b>{g.borrowerCode ? ` (${g.borrowerCode})` : ""}
                  </span>
                  <span className="font-semibold tabular-nums text-violet-700 dark:text-violet-400">{fmtMoney(g.amount)}</span>
                </div>
              ))}
            </div>
            <p className="text-[10px] text-violet-600/80 dark:text-violet-400/80 mt-1.5">
              The borrower has no payable salary this period — the installment deducts from this guarantor&apos;s salary and posts to the borrower&apos;s ledger at final approval.
            </p>
          </div>
        )}

        <div className="flex items-center justify-between rounded-lg bg-primary text-primary-foreground px-4 py-2.5">
          <span className="text-xs font-semibold uppercase tracking-wide">Net Salary</span>
          <span className="text-base font-bold tabular-nums">{fmtMoney(entry.net)}</span>
        </div>
      </DialogContent>
    </Dialog>
  )
}

// ================= SALARY STRUCTURES =================
function StructuresTab() {
  const { can } = useHrm()
  const { data, loading, error, reload } = useApi<any[]>("salaryStructures.list", {})
  const { data: employees } = useEmployeeDirectory()
  const [open, setOpen] = useState(false)

  const otherAllowances = (s: any) => (s.gross || 0) - (s.basic || 0) - (s.houseRent || 0) - (s.medical || 0)

  const columns: Column<any>[] = [
    {
      key: "employeeName", label: "Employee", sortValue: (s) => s.employeeName,
      render: (s) => (
        <div>
          <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">{s.employeeName}</p>
          <p className="text-[11px] text-slate-500 dark:text-slate-400">{s.employeeCode}</p>
        </div>
      ),
    },
    { key: "effective", label: "Effective", sortValue: (s) => s.effectiveFrom, render: (s) => <span className="text-xs text-slate-500 tabular-nums">{fmtDate(s.effectiveFrom)} → {s.effectiveTo ? fmtDate(s.effectiveTo) : "current"}</span> },
    { key: "basic", label: "Basic", align: "right", sortValue: (s) => s.basic, render: (s) => <span className="text-xs tabular-nums">{fmtMoney(s.basic)}</span> },
    { key: "houseRent", label: "House Rent", align: "right", sortValue: (s) => s.houseRent, render: (s) => <span className="text-xs tabular-nums">{fmtMoney(s.houseRent)}</span> },
    { key: "medical", label: "Medical", align: "right", sortValue: (s) => s.medical, render: (s) => <span className="text-xs tabular-nums">{fmtMoney(s.medical)}</span> },
    { key: "other", label: "Other Allowances", align: "right", sortValue: (s) => otherAllowances(s), render: (s) => <span className="text-xs tabular-nums">{fmtMoney(otherAllowances(s))}</span> },
    { key: "gross", label: "Gross", align: "right", sortValue: (s) => s.gross, render: (s) => <span className="text-sm font-bold text-emerald-600 dark:text-emerald-400 tabular-nums">{fmtMoney(s.gross)}</span> },
    { key: "status", label: "Status", render: (s) => <Badge className={s.status === "ACTIVE" ? "bg-emerald-100 text-emerald-700" : "bg-slate-200 text-slate-600"}>{titleCase(s.status)}</Badge> },
  ]

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-slate-500 flex items-center gap-1.5">
          <Info className="h-3.5 w-3.5 text-emerald-600 shrink-0" />
          Saving a new structure supersedes the current one — superseded history stays for audits.
        </p>
        {can("payroll", "edit") && (
          <Button size="sm" onClick={() => setOpen(true)} className="h-8 text-xs ">
            <Plus className="h-3.5 w-3.5 mr-1" /> New / Revise Structure
          </Button>
        )}
      </div>
      <DataTable
        columns={columns} rows={data || undefined} loading={loading} error={error} pageSize={12} csvName="salary-structures"
        searchPlaceholder="Search employee…" emptyTitle="No salary structures" emptyHint="Set a structure for each employee before running payroll."
      />
      <StructureFormDialog open={open} onOpenChange={(v) => { setOpen(v); if (!v) reload() }} employees={employees || []} />
    </div>
  )
}

const STRUCTURE_COMPONENTS: [string, string][] = [
  ["basic", "Basic"], ["houseRent", "House Rent"], ["medical", "Medical"], ["conveyance", "Conveyance"],
  ["food", "Food"], ["mobileAllow", "Mobile"], ["internetAllow", "Internet"], ["attendanceAllow", "Attendance Allow."], ["otherAllowance", "Other"],
]

function StructureFormDialog({ open, onOpenChange, employees }: { open: boolean; onOpenChange: (v: boolean) => void; employees: any[] }) {
  const toast = useHrm((s) => s.toast)
  const [values, setValues] = useState<Record<string, any>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (open) {
      setError(null)
      const v: Record<string, any> = { employeeId: "", effectiveFrom: today() }
      for (const [k] of STRUCTURE_COMPONENTS) v[k] = ""
      setValues(v)
    }
  }, [open])

  const total = STRUCTURE_COMPONENTS.reduce((s, [k]) => s + Number(values[k] || 0), 0)
  const set = (n: string, v: any) => setValues((s) => ({ ...s, [n]: v }))

  const submit = async () => {
    if (!values.employeeId) { setError("Employee is required"); return }
    if (!values.effectiveFrom) { setError("Effective date is required"); return }
    if (!(Number(values.basic) > 0)) { setError("Basic salary must be positive"); return }
    setBusy(true)
    try {
      const payload: Record<string, unknown> = { employeeId: values.employeeId, effectiveFrom: values.effectiveFrom }
      for (const [k] of STRUCTURE_COMPONENTS) payload[k] = Number(values[k] || 0)
      await rpc("salaryStructures.save", payload)
      toast("Salary structure saved — previous structure superseded")
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
          <DialogTitle className="text-base">New / Revise Salary Structure</DialogTitle>
          <p className="text-xs text-slate-500">Saving a new structure supersedes the current one — full history is preserved for payroll audits.</p>
        </DialogHeader>
        <div className="rounded-lg bg-emerald-50 dark:bg-emerald-950 border border-emerald-200 dark:border-emerald-900 px-3 py-2 flex items-center justify-between">
          <span className="text-xs font-medium text-emerald-800 dark:text-emerald-300">Live gross total (all components)</span>
          <span className="text-sm font-bold text-emerald-700 dark:text-emerald-400 tabular-nums">{fmtMoney(total)}</span>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 py-1">
          <div className="space-y-1.5">
            <Label className="text-xs font-medium">Employee <span className="text-rose-500">*</span></Label>
            <Select value={values.employeeId || ""} onValueChange={(v) => set("employeeId", v)}>
              <SelectTrigger className="h-9"><SelectValue placeholder="Select employee…" /></SelectTrigger>
              <SelectContent>
                {employees.map((e: any) => <SelectItem key={e.id} value={e.id}>{e.fullName} ({e.code})</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs font-medium">Effective From <span className="text-rose-500">*</span></Label>
            <Input type="date" value={values.effectiveFrom || ""} onChange={(e) => set("effectiveFrom", e.target.value)} className="h-9" />
          </div>
          {STRUCTURE_COMPONENTS.map(([k, label]) => (
            <div key={k} className="space-y-1.5">
              <Label className="text-xs font-medium">{label} (৳)</Label>
              <Input type="number" min={0} value={values[k] ?? ""} placeholder="0"
                onChange={(e) => set(k, e.target.value === "" ? "" : Number(e.target.value))} className="h-9" />
            </div>
          ))}
        </div>
        {error && <p className="text-sm text-rose-600 dark:text-rose-400 bg-rose-50 dark:bg-rose-950 rounded-md px-3 py-2">{error}</p>}
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
          <Button onClick={submit} disabled={busy}>{busy ? "Saving…" : "Save Structure"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function ResultStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border bg-white dark:bg-slate-900 px-3 py-2">
      <p className="text-[10px] uppercase tracking-wide text-slate-400">{label}</p>
      <p className="text-sm font-bold tabular-nums">{value}</p>
    </div>
  )
}

// ================= OTHER DEDUCTIONS =================
function DeductionsTab() {
  const { can } = useHrm()
  const { data, loading, error, reload } = useApi<any[]>("deductions.list", {})
  const { data: employees } = useEmployeeDirectory()
  const [open, setOpen] = useState(false)
  const [delTarget, setDelTarget] = useState<any>(null)

  const empOpts = (employees || []).map((e: any) => ({ value: e.id, label: `${e.fullName} (${e.code})` }))

  const fields: FieldDef[] = [
    { name: "employeeId", label: "Employee", type: "select", required: true, options: empOpts },
    { name: "type", label: "Deduction Type", type: "select", options: DEDUCTION_TYPES.map((t) => ({ value: t, label: titleCase(t) })), defaultValue: "OTHER" },
    { name: "label", label: "Label", required: true, placeholder: "e.g. Damaged goods recovery" },
    { name: "amount", label: "Amount (৳)", type: "number", required: true, min: 1 },
    { name: "month", label: "Month", type: "select", required: true, options: MONTHS.map((m, i) => ({ value: String(i + 1), label: m })), defaultValue: String(new Date().getMonth() + 1) },
    { name: "year", label: "Year", type: "number", required: true, defaultValue: new Date().getFullYear() },
    { name: "recurring", label: "Recurring (every month until stopped)", type: "switch" },
  ]

  const columns: Column<any>[] = [
    {
      key: "employeeName", label: "Employee", sortValue: (d) => d.employeeName,
      render: (d) => <span className="text-sm font-medium text-slate-800 dark:text-slate-100">{d.employeeName}</span>,
    },
    { key: "type", label: "Type", render: (d) => <Badge variant="outline" className="text-[10px]">{titleCase(d.type)}</Badge> },
    { key: "label", label: "Label", render: (d) => <span className="text-xs text-slate-600 dark:text-slate-300">{d.label}</span> },
    { key: "amount", label: "Amount", align: "right", sortValue: (d) => d.amount, render: (d) => <span className="text-xs font-semibold tabular-nums">{fmtMoney(d.amount)}</span> },
    { key: "period", label: "Period", sortValue: (d) => `${d.year}-${String(d.month).padStart(2, "0")}`, render: (d) => <span className="text-xs text-slate-500">{monthLabel(d.month)} {d.year}</span> },
    { key: "recurring", label: "Recurring", render: (d) => <Badge className={d.recurring ? "bg-amber-100 text-amber-700" : "bg-slate-100 text-slate-500"}>{d.recurring ? "Recurring" : "One-time"}</Badge> },
    { key: "status", label: "Status", render: (d) => <StatusBadge status={d.status} /> },
    {
      key: "actions", label: "", align: "right",
      render: (d) => d.status !== "PAID" && can("payroll", "edit") ? (
        <Button aria-label="Delete" size="icon" variant="ghost" className="h-7 w-7 text-slate-400 hover:text-rose-600" onClick={() => setDelTarget(d)}>
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      ) : null,
    },
  ]

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-slate-500 flex items-center gap-1.5">
          <Info className="h-3.5 w-3.5 text-emerald-600 shrink-0" />
          ACTIVE deductions for a period are applied by that period&apos;s payroll calculation; paid ones are locked.
        </p>
        {can("payroll", "edit") && (
          <Button size="sm" onClick={() => setOpen(true)} className="h-8 text-xs ">
            <Plus className="h-3.5 w-3.5 mr-1" /> Add Deduction
          </Button>
        )}
      </div>
      <DataTable
        columns={columns} rows={data || undefined} loading={loading} error={error} pageSize={12} csvName="deductions"
        searchPlaceholder="Search employee, label…" emptyTitle="No other deductions" emptyHint="Add one-time or recurring deductions outside the standard engine."
      />
      <FormDialog
        open={open} onOpenChange={(v) => { setOpen(v); if (!v) reload() }}
        title="Add Deduction" wide
        description="Recurring deductions apply every month until stopped or deleted."
        submitLabel="Add Deduction"
        fields={fields}
        onSubmit={async (v) => {
          await rpc("deductions.save", {
            employeeId: v.employeeId, type: v.type, label: v.label, amount: Number(v.amount),
            month: Number(v.month), year: Number(v.year), recurring: !!v.recurring,
          })
        }}
      />
      <ConfirmDialog
        open={!!delTarget} onOpenChange={(v) => { if (!v) setDelTarget(null) }}
        title="Delete deduction"
        message={delTarget ? `Delete "${delTarget.label}" (${fmtMoney(delTarget.amount)}) for ${delTarget.employeeName}?` : ""}
        danger confirmLabel="Delete"
        onConfirm={async () => { await rpc("deductions.delete", { id: delTarget.id }); reload() }}
      />
    </div>
  )
}

// ================= PAYSLIPS =================
function PayslipsTab({ runId, presetEmployeeId }: { runId: string | null; presetEmployeeId?: string | null }) {
  const { can } = useHrm()
  const [filterRunId, setFilterRunId] = useState<string | null>(runId)
  useEffect(() => { if (runId) setFilterRunId(runId) }, [runId])
  // 2026-10-14 — employee filter: Employee Directory → quick action "View
  // Payslip" deep-links here with a preset employee (view params), and the
  // filter is useful on its own for per-employee payslip history.
  const [filterEmployeeId, setFilterEmployeeId] = useState<string | null>(presetEmployeeId || null)
  const { data: runs } = useApi<any[]>("payroll.runs.list", {})
  const { data: directory } = useEmployeeDirectory()
  const { data, loading, error } = useApi<any[]>("payslips.list", { ...(filterRunId ? { runId: filterRunId } : {}), ...(filterEmployeeId ? { employeeId: filterEmployeeId } : {}) })
  const [printingId, setPrintingId] = useState<string | null>(null)
  const [emailingId, setEmailingId] = useState<string | null>(null)
  const [bulkBusy, setBulkBusy] = useState(false)
  const toast = useHrm((s) => s.toast)

  const emailPayslip = async (r: any) => {
    setEmailingId(r.id)
    try {
      const res = await rpc<any>("payslips.email", { entryId: r.entryId || r.id })
      if (res.status === "SENT") toast(`Payslip ${r.payslipNumber} emailed to the employee`)
      else if (res.status === "SKIPPED") toast(`Payslip email skipped: ${res.detail || "gateway not configured / no address"}`, "err")
      else toast(`Payslip email failed: ${res.detail || "unknown error"}`, "err")
    } catch (e: any) {
      toast(e.message, "err")
    } finally {
      setEmailingId(null)
    }
  }

  const emailAllForRun = async () => {
    if (!filterRunId) { toast("Select a specific run first — bulk email is per run", "err"); return }
    const run = (runs || []).find((r: any) => r.id === filterRunId)
    if (run?.status !== "PAID") { toast("Only PAID runs can be bulk-emailed", "err"); return }
    setBulkBusy(true)
    try {
      // M-04/M-05 — bulk email runs as a background job; runJob polls jobs.get
      const res = await runJob<any>("payslips.emailAll", { runId: filterRunId })
      toast(`Bulk payslip email: ${res.sent} sent · ${res.failed} failed · ${res.skipped} skipped`)
    } catch (e: any) {
      toast(e.message, "err")
    } finally {
      setBulkBusy(false)
    }
  }

  const openPayslip = async (r: any) => {
    setPrintingId(r.id)
    try {
      const d = await rpc<{ html: string }>("payslips.html", { entryId: r.entryId || r.id })
      const w = openPrintWindow(d.html)
      if (!w) {
        toast("Popup blocked — allow popups to view payslips", "err")
        return
      }
    } catch (e: any) {
      toast(e.message, "err")
    } finally {
      setPrintingId(null)
    }
  }

  const columns: Column<any>[] = [
    { key: "payslipNumber", label: "Payslip No", sortValue: (r) => r.payslipNumber || "", render: (r) => <span className="text-xs font-semibold tabular-nums text-slate-700 dark:text-slate-200">{r.payslipNumber || "—"}</span> },
    {
      key: "employeeName", label: "Employee", sortValue: (r) => r.employeeName,
      render: (r) => (
        <div>
          <p className="text-sm font-medium text-slate-800 dark:text-slate-100">{r.employeeName}</p>
          <p className="text-[11px] text-slate-500 dark:text-slate-400">{r.employeeCode}</p>
        </div>
      ),
    },
    { key: "period", label: "Period", render: (r) => <span className="text-xs text-slate-500">{r.period}</span> },
    { key: "gross", label: "Gross", align: "right", sortValue: (r) => r.gross, render: (r) => <span className="text-xs text-slate-600 dark:text-slate-300 tabular-nums">{fmtMoney(r.gross)}</span> },
    { key: "ait", label: "AIT", align: "right", sortValue: (r) => r.ait, render: (r) => <span className="text-xs tabular-nums">{fmtMoney(r.ait)}</span> },
    { key: "net", label: "Net", align: "right", sortValue: (r) => r.net, render: (r) => <span className="text-sm font-bold text-emerald-600 dark:text-emerald-400 tabular-nums">{fmtMoney(r.net)}</span> },
    { key: "status", label: "Status", render: (r) => <StatusBadge status={r.status} /> },
    { key: "paidOn", label: "Paid On", sortValue: (r) => r.paidOn || "", render: (r) => <span className="text-xs text-slate-500 tabular-nums">{fmtDate(r.paidOn)}</span> },
    {
      key: "actions", label: "", align: "right",
      render: (r) => can("payslip", "download") && (
        <div className="flex gap-1">
          <Button size="sm" variant="outline" className="h-7 text-xs" disabled={printingId === r.id} onClick={() => openPayslip(r)}>
            {printingId === r.id ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <Printer className="h-3 w-3 mr-1" />} View / Print
          </Button>
          <Button size="sm" variant="outline" className="h-7 text-xs" disabled={emailingId === r.id} title="Email this payslip to the employee" onClick={() => emailPayslip(r)}>
            {emailingId === r.id ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <Mail className="h-3 w-3 mr-1" />} Email
          </Button>
        </div>
      ),
    },
  ]

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-slate-500 flex items-center gap-1.5">
          <Info className="h-3.5 w-3.5 text-emerald-600 shrink-0" />
          Payslip view/download is audit-logged. The opened document is print-ready (photo + payment method included).
        </p>
        <div className="flex items-center gap-2">
          {can("payslip", "download") && (
            <Button size="sm" variant="outline" className="h-8 text-xs" disabled={bulkBusy || !filterRunId} title="Email every payslip of the selected PAID run" onClick={emailAllForRun}>
              {bulkBusy ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <Send className="h-3.5 w-3.5 mr-1" />} Email All (run)
            </Button>
          )}
          <Select value={filterEmployeeId || "all"} onValueChange={(v) => setFilterEmployeeId(v === "all" ? null : v)}>
            <SelectTrigger className="h-8 w-[190px] text-xs"><SelectValue placeholder="All employees" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All employees</SelectItem>
              {(directory || []).map((e: any) => (
                <SelectItem key={e.id} value={e.id}>{e.fullName} ({e.code})</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={filterRunId || "all"} onValueChange={(v) => setFilterRunId(v === "all" ? null : v)}>
            <SelectTrigger className="h-8 w-[210px] text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All runs</SelectItem>
              {(runs || []).map((r: any) => (
                <SelectItem key={r.id} value={r.id}>
                  {monthLabel(r.periodMonth)} {r.periodYear}{r.periodWeek ? ` W${r.periodWeek}` : ""}{r.runType === "ADJUSTMENT" ? " (adj)" : ""}{r.status === "PAID" ? " · paid" : ""}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      <DataTable
        columns={columns} rows={data || undefined} loading={loading} error={error} pageSize={15} csvName="payslips"
        searchPlaceholder="Search payslip, employee…" emptyTitle="No payslips yet" emptyHint="Payslips are generated when a payroll run is paid."
      />
    </div>
  )
}

// ================= SALARY TEMPLATES (P1 — salary structure templates) =================
function TemplatesTab() {
  const { can } = useHrm()
  const { data, loading, error, reload } = useApi<any[]>("salaryTemplates.list", {})
  const { data: employees } = useEmployeeDirectory()
  const [formOpen, setFormOpen] = useState(false)
  const [editRec, setEditRec] = useState<any>(null)
  const [applyTarget, setApplyTarget] = useState<any>(null)
  const [delTarget, setDelTarget] = useState<any>(null)

  const canEdit = can("payroll", "edit")

  const componentCount = (t: any) => {
    const base = STRUCTURE_COMPONENTS.filter(([k]) => Number(t[k] || 0) > 0).length
    let extra = 0
    try { extra = (JSON.parse(t.componentsJson || "[]") || []).length } catch { extra = 0 }
    return { base, extra }
  }

  const columns: Column<any>[] = [
    {
      key: "name", label: "Template", sortValue: (t) => t.name,
      render: (t) => (
        <div className="min-w-0">
          <p className="text-sm font-semibold text-slate-800 dark:text-slate-100 truncate">{t.name}</p>
          {t.description && <p className="text-[11px] text-slate-500 dark:text-slate-400 truncate max-w-[260px]">{t.description}</p>}
        </div>
      ),
    },
    { key: "basic", label: "Basic", align: "right", sortValue: (t) => t.basic, render: (t) => <span className="text-xs tabular-nums">{fmtMoney(t.basic)}</span> },
    {
      key: "gross", label: "Gross", align: "right", sortValue: (t) => t.gross,
      render: (t) => (
        <div className="text-right">
          <p className="text-sm font-bold text-emerald-600 dark:text-emerald-400 tabular-nums">{fmtMoney(t.gross)}</p>
          <p className="text-[10px] text-slate-500 dark:text-slate-400 tabular-nums">basic {fmtMoney(t.basic)} + allow. {fmtMoney((t.gross || 0) - (t.basic || 0))}</p>
        </div>
      ),
    },
    {
      key: "components", label: "Components", align: "center", sortValue: (t) => componentCount(t).base,
      render: (t) => {
        const c = componentCount(t)
        return (
          <span className="text-xs text-slate-500 tabular-nums">
            {c.base} earning{c.base !== 1 ? "s" : ""}{c.extra > 0 ? ` +${c.extra} extra` : ""}
          </span>
        )
      },
    },
    { key: "active", label: "Status", render: (t) => <Badge className={t.active ? "bg-emerald-100 text-emerald-700" : "bg-slate-200 text-slate-600"}>{t.active ? "Active" : "Inactive"}</Badge> },
    { key: "createdAt", label: "Created", sortValue: (t) => t.createdAt || "", render: (t) => <span className="text-xs text-slate-500 tabular-nums">{fmtDateTime(t.createdAt)}</span> },
    {
      key: "actions", label: "", align: "right",
      render: (t) => canEdit && (
        <div className="flex justify-end gap-1">
          <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => setApplyTarget(t)}>
            <UserPlus className="h-3 w-3 mr-1" /> Apply
          </Button>
          <Button size="icon" variant="ghost" className="h-7 w-7" title="Edit template" onClick={() => { setEditRec(t); setFormOpen(true) }}>
            <Pencil className="h-3.5 w-3.5" />
          </Button>
          <Button size="icon" variant="ghost" className="h-7 w-7 text-slate-400 hover:text-rose-600" title="Delete template" onClick={() => setDelTarget(t)}>
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      ),
    },
  ]

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-slate-500 flex items-center gap-1.5 min-w-0">
          <Info className="h-3.5 w-3.5 text-emerald-600 shrink-0" />
          <span className="truncate">Reusable salary structures — apply one to an employee to create their structure (the previous one is superseded).</span>
        </p>
        {canEdit && (
          <Button size="sm" onClick={() => { setEditRec(null); setFormOpen(true) }} className="h-8 text-xs ">
            <Plus className="h-3.5 w-3.5 mr-1" /> New Template
          </Button>
        )}
      </div>
      <DataTable
        columns={columns} rows={data || undefined} loading={loading} error={error} pageSize={10} csvName="salary-templates"
        searchPlaceholder="Search template…" emptyTitle="No salary templates" emptyHint="Create a template with standard earning components, then apply it to employees in one click."
      />
      <TemplateFormDialog
        open={formOpen}
        onOpenChange={(v) => { setFormOpen(v); if (!v) { setEditRec(null); reload() } }}
        editRec={editRec}
      />
      <ApplyTemplateDialog
        template={applyTarget}
        employees={employees || []}
        onOpenChange={(v) => { if (!v) setApplyTarget(null) }}
      />
      <ConfirmDialog
        open={!!delTarget}
        onOpenChange={(v) => { if (!v) setDelTarget(null) }}
        title="Delete salary template"
        message={delTarget ? `Delete "${delTarget.name}" (${fmtMoney(delTarget.gross)} gross)? Existing salary structures created from it are not affected.` : ""}
        danger confirmLabel="Delete"
        onConfirm={async () => { await rpc("salaryTemplates.delete", { id: delTarget.id }); reload() }}
      />
    </div>
  )
}

function TemplateFormDialog({ open, onOpenChange, editRec }: { open: boolean; onOpenChange: (v: boolean) => void; editRec: any }) {
  const toast = useHrm((s) => s.toast)
  const [v, setV] = useState<Record<string, any>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (open) {
      setError(null)
      const init: Record<string, any> = {
        name: editRec?.name || "",
        description: editRec?.description || "",
        active: editRec ? !!editRec.active : true,
      }
      for (const [k] of STRUCTURE_COMPONENTS) init[k] = editRec ? (editRec[k] ?? 0) : ""
      setV(init)
    }
  }, [open, editRec])

  const total = STRUCTURE_COMPONENTS.reduce((s, [k]) => s + Number(v[k] || 0), 0)
  const set = (n: string, val: any) => setV((s) => ({ ...s, [n]: val }))

  const submit = async () => {
    if (!v.name) { setError("Template name is required"); return }
    if (!(Number(v.basic) > 0)) { setError("Basic salary must be positive"); return }
    setBusy(true)
    try {
      const payload: Record<string, unknown> = {
        ...(editRec?.id ? { id: editRec.id } : {}),
        name: String(v.name).trim(),
        description: String(v.description || "").trim(),
        active: !!v.active,
      }
      for (const [k] of STRUCTURE_COMPONENTS) payload[k] = Number(v[k] || 0)
      await rpc("salaryTemplates.save", payload)
      toast(editRec ? "Salary template updated" : "Salary template created")
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
          <DialogTitle className="text-base">{editRec ? `Edit — ${editRec.name}` : "New Salary Template"}</DialogTitle>
          <p className="text-xs text-slate-500">Templates capture standard earning components; gross is computed from the components. Apply one to an employee from the template list.</p>
        </DialogHeader>
        <div className="rounded-lg bg-emerald-50 dark:bg-emerald-950 border border-emerald-200 dark:border-emerald-900 px-3 py-2 flex items-center justify-between">
          <span className="text-xs font-medium text-emerald-800 dark:text-emerald-300">Live gross total (all components)</span>
          <span className="text-sm font-bold text-emerald-700 dark:text-emerald-400 tabular-nums">{fmtMoney(total)}</span>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 py-1">
          <div className="space-y-1.5">
            <Label className="text-xs font-medium">Name <span className="text-rose-500">*</span></Label>
            <Input value={v.name || ""} onChange={(e) => set("name", e.target.value)} className="h-9" placeholder="e.g. Officer Grade-2 (Dhaka)" />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs font-medium">Description</Label>
            <Input value={v.description || ""} onChange={(e) => set("description", e.target.value)} className="h-9" placeholder="e.g. Standard package for officers" />
          </div>
          {STRUCTURE_COMPONENTS.map(([k, label]) => (
            <div key={k} className="space-y-1.5">
              <Label className="text-xs font-medium">{label} (৳)</Label>
              <Input type="number" min={0} value={v[k] ?? ""} placeholder="0"
                onChange={(e) => set(k, e.target.value === "" ? "" : Number(e.target.value))} className="h-9" />
            </div>
          ))}
          <div className="flex items-center gap-2 sm:col-span-2 pt-1">
            <Switch checked={!!v.active} onCheckedChange={(c) => set("active", c)} />
            <Label className="text-xs font-medium">Active (available when applying to employees)</Label>
          </div>
        </div>
        {error && <p className="text-sm text-rose-600 dark:text-rose-400 bg-rose-50 dark:bg-rose-950 rounded-md px-3 py-2">{error}</p>}
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
          <Button onClick={submit} disabled={busy}>{busy ? "Saving…" : "Save Template"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function ApplyTemplateDialog({ template, employees, onOpenChange }: {
  template: any; employees: any[]; onOpenChange: (v: boolean) => void
}) {
  const toast = useHrm((s) => s.toast)
  const [employeeId, setEmployeeId] = useState("")
  const [effectiveFrom, setEffectiveFrom] = useState(today())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (template) {
      setEmployeeId("")
      setEffectiveFrom(today())
      setError(null)
    }
  }, [template])

  const submit = async () => {
    if (!template) return
    if (!employeeId) { setError("Select an employee"); return }
    if (!effectiveFrom) { setError("Effective date is required"); return }
    setBusy(true)
    try {
      await rpc("salaryTemplates.apply", { templateId: template.id, employeeId, effectiveFrom })
      toast(`Template applied — structure created from ${fmtDate(effectiveFrom)}`)
      onOpenChange(false)
    } catch (e: any) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  if (!template) return null

  return (
    <Dialog open onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-base">Apply Template — {template.name}</DialogTitle>
          <p className="text-xs text-slate-500">
            Gross {fmtMoney(template.gross)} · the employee&apos;s current structure is superseded from the effective date (history is kept for audits).
          </p>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label className="text-xs font-medium">Employee <span className="text-rose-500">*</span></Label>
            <Select value={employeeId || ""} onValueChange={setEmployeeId}>
              <SelectTrigger className="h-9"><SelectValue placeholder="Select employee…" /></SelectTrigger>
              <SelectContent>
                {employees.map((e: any) => <SelectItem key={e.id} value={e.id}>{e.fullName} ({e.code})</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs font-medium">Effective From <span className="text-rose-500">*</span></Label>
            <Input type="date" value={effectiveFrom} onChange={(e) => setEffectiveFrom(e.target.value)} className="h-9" />
          </div>
          {error && <p className="text-sm text-rose-600 dark:text-rose-400 bg-rose-50 dark:bg-rose-950 rounded-md px-3 py-2">{error}</p>}
        </div>
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
          <Button onClick={submit} disabled={busy}>
            {busy && <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />} Apply Template
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ================= REVERSAL REGISTER (P2 — adjustment-run register) =================
function ReversalRegister() {
  const { data, loading, error } = useApi<any[]>("payroll.reversals", {})
  const { data: employees } = useEmployeeDirectory()
  const [openRec, setOpenRec] = useState<any>(null)

  const empLabel = (id: string) => {
    const e = (employees || []).find((x: any) => x.id === id)
    return e ? `${e.fullName} (${e.code})` : (id || "").slice(0, 8)
  }

  // the register only appears once adjustment runs exist — keeps the runs tab clean
  if (loading || error || !data || data.length === 0) return null

  return (
    <SectionCard
      title="Reversal Register"
      actions={<Badge variant="outline" className="text-[10px] bg-amber-50 border-amber-300 text-amber-700">{data.length} adjustment run{data.length !== 1 ? "s" : ""}</Badge>}
    >
      <p className="text-xs text-slate-500 mb-2 flex items-center gap-1.5">
        <History className="h-3.5 w-3.5 text-amber-600 shrink-0" />
        Approved payroll is immutable — corrections are made through adjustment runs. Click a row for its entries.
      </p>
      <div className="rounded-lg border overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow className="bg-slate-50/80 dark:bg-slate-800/60">
              <TableHead className="text-[10px] uppercase text-slate-500">Period</TableHead>
              <TableHead className="text-[10px] uppercase text-slate-500">Created</TableHead>
              <TableHead className="text-[10px] uppercase text-slate-500 text-right">Entries</TableHead>
              <TableHead className="text-[10px] uppercase text-slate-500 text-right">Net</TableHead>
              <TableHead className="text-[10px] uppercase text-slate-500">Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.map((r: any) => (
              <TableRow key={r.id} className="cursor-pointer" onClick={() => setOpenRec(r)}>
                <TableCell className="text-xs font-medium py-2">{monthLabel(r.periodMonth)} {r.periodYear}</TableCell>
                <TableCell className="text-xs text-slate-500 py-2 tabular-nums">{fmtDateTime(r.createdAt)}</TableCell>
                <TableCell className="text-xs py-2 text-right tabular-nums">{r.entryCount}</TableCell>
                <TableCell className="text-xs py-2 text-right font-semibold tabular-nums">{fmtMoney(r.totalNet)}</TableCell>
                <TableCell className="py-2"><StatusBadge status={r.status} /></TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <Dialog open={!!openRec} onOpenChange={(v) => { if (!v) setOpenRec(null) }}>
        <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="text-base">Adjustment Run — {monthLabel(openRec?.periodMonth)} {openRec?.periodYear}</DialogTitle>
            <p className="text-xs text-slate-500">
              Created {fmtDateTime(openRec?.createdAt)} · parent run status {openRec?.parentStatus ? titleCase(openRec.parentStatus) : "—"}
              {openRec?.processedDate ? ` · processed ${fmtDate(openRec.processedDate)}` : ""}
            </p>
          </DialogHeader>
          <div className="grid grid-cols-3 gap-2">
            <ResultStat label="Entries" value={String(openRec?.entryCount ?? 0)} />
            <ResultStat label="Gross" value={fmtMoney(openRec?.totalGross)} />
            <ResultStat label="Net" value={fmtMoney(openRec?.totalNet)} />
          </div>
          <div className="rounded-lg border overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow className="bg-slate-50 dark:bg-slate-800/60">
                  <TableHead className="text-[10px] uppercase text-slate-500">Employee</TableHead>
                  <TableHead className="text-[10px] uppercase text-slate-500 text-right">Gross</TableHead>
                  <TableHead className="text-[10px] uppercase text-slate-500 text-right">AIT</TableHead>
                  <TableHead className="text-[10px] uppercase text-slate-500 text-right">Net</TableHead>
                  <TableHead className="text-[10px] uppercase text-slate-500">Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(openRec?.entries || []).map((e: any) => (
                  <TableRow key={e.id}>
                    <TableCell className="text-xs py-2">{empLabel(e.employeeId)}</TableCell>
                    <TableCell className="text-xs py-2 text-right tabular-nums">{fmtMoney(e.gross)}</TableCell>
                    <TableCell className="text-xs py-2 text-right tabular-nums">{fmtMoney(e.ait)}</TableCell>
                    <TableCell className="text-xs py-2 text-right font-semibold tabular-nums">{fmtMoney(e.net)}</TableCell>
                    <TableCell className="py-2"><StatusBadge status={e.status} /></TableCell>
                  </TableRow>
                ))}
                {(openRec?.entries || []).length === 0 && (
                  <TableRow>
                    <TableCell colSpan={5} className="text-xs text-slate-400 text-center py-4">No entries — calculate the adjustment run to generate them.</TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        </DialogContent>
      </Dialog>
    </SectionCard>
  )
}

// ================= PROVIDENT FUND =================
// Vendor rules: Settings → Payroll → Provident Fund. This tab manages per-
// employee enrollment, the contribution ledger (statement) and manual/opening
// entries. Payroll withholding + employer cost + journal lines are wired in the
// payroll engine (payroll.ts) — rows land here when a run is PAID.
function PfTab() {
  const { can } = useHrm()
  const canEdit = can("payroll", "edit")
  const { data, loading, error, reload } = useApi<any[]>("pf.list", {})
  const { data: employees } = useEmployeeDirectory()
  const { data: settings } = useApi<any>(can("settings", "view") ? "settings.get" : null)
  const [enrollOpen, setEnrollOpen] = useState(false)
  const [editRec, setEditRec] = useState<any>(null)
  const [statement, setStatement] = useState<any>(null)
  const [manualOpen, setManualOpen] = useState(false)
  const [bulkOpen, setBulkOpen] = useState(false)

  const pfEnabled = settings?.pf?.enabled === true
  const pfEligibleStatuses: string[] = settings?.pf?.eligibleStatuses?.length
    ? settings.pf.eligibleStatuses
    : ["ACTIVE", "PROBATION"]
  const rows = data || []

  const enrollFields: FieldDef[] = [
    ...(editRec ? [] : [{
      name: "employeeId", label: "Employee", type: "select", required: true, span: 2,
      options: (employees || [])
        .filter((e: any) => {
          const isEligible = !e.status || pfEligibleStatuses.includes(e.status)
          return isEligible && (!rows.some((r) => r.employeeId === e.id) || e.id === editRec?.employeeId)
        })
        .map((e: any) => ({ value: e.id, label: `${e.fullName} (${e.code}) — ${e.status || "Active"}` })),
      help: `Only employees matching configured eligible statuses (${pfEligibleStatuses.map(titleCase).join(", ")}) without an active enrollment are listed`,
    } as FieldDef]),
    { name: "employeePct", label: "Employee Contribution (%)", type: "number", min: 0, step: 0.5, required: true },
    { name: "employerPct", label: "Employer Contribution (%)", type: "number", min: 0, step: 0.5, required: true },
    { name: "basis", label: "Contribution Basis", type: "select", options: [
      { value: "BASIC", label: "Basic salary" }, { value: "GROSS", label: "Gross salary" },
    ] },
    { name: "note", label: "Note", type: "textarea", span: 2 },
  ]

  const exportColumns: Column<any>[] = [
    { key: "employeeCode", label: "Employee Code", csvValue: (r) => r.employeeCode },
    { key: "employeeName", label: "Employee Name", csvValue: (r) => r.employeeName },
    { key: "departmentName", label: "Department", csvValue: (r) => r.departmentName || "—" },
    { key: "designationName", label: "Designation", csvValue: (r) => r.designationName || "—" },
    { key: "employeeStatus", label: "Employment Status", csvValue: (r) => r.employeeStatus || "ACTIVE" },
    { key: "status", label: "PF Status", csvValue: (r) => r.status },
    { key: "enrollDate", label: "Enrollment Date", csvValue: (r) => r.enrollDate || "—" },
    { key: "joiningDate", label: "Joining Date", csvValue: (r) => r.joiningDate || "—" },
    { key: "employeePct", label: "Employee Contribution (%)", csvValue: (r) => r.employeePct },
    { key: "employerPct", label: "Employer Contribution (%)", csvValue: (r) => r.employerPct },
    { key: "basis", label: "Contribution Basis", csvValue: (r) => r.basis },
    { key: "rates", label: "Contribution Rule", csvValue: (r) => `${r.employeePct}% + ${r.employerPct}% on ${titleCase(r.basis)}` },
    { key: "employeeTotal", label: "Employee Paid (BDT)", csvValue: (r) => r.employeeTotal },
    { key: "employerTotal", label: "Employer Paid (BDT)", csvValue: (r) => r.employerTotal },
    { key: "balance", label: "Total PF Balance (BDT)", csvValue: (r) => r.balance },
    { key: "months", label: "Contribution Months", csvValue: (r) => r.months },
    { key: "note", label: "Note", csvValue: (r) => r.note || "" },
  ]

  const columns: Column<any>[] = [
    {
      key: "employee",
      label: "Employee",
      sortValue: (r) => r.employeeName,
      searchValue: (r) => `${r.employeeName} ${r.employeeCode}`,
      csvValue: (r) => `${r.employeeName} (${r.employeeCode})`,
      render: (r) => {
        const isIneligibleStatus = r.employeeStatus && !pfEligibleStatuses.includes(r.employeeStatus)
        return (
          <div>
            <div className="flex items-center gap-1.5 flex-wrap">
              <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">{r.employeeName}</p>
              {isIneligibleStatus && (
                <Badge variant="outline" className="text-[9px] px-1.5 py-0 border-amber-300 dark:border-amber-700 text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-950/40" title={`Employment status is ${r.employeeStatus} — excluded from PF deductions`}>
                  {r.employeeStatus} (PF Excluded)
                </Badge>
              )}
            </div>
            <p className="text-[11px] text-slate-500 dark:text-slate-400 font-mono">{r.employeeCode}</p>
          </div>
        )
      },
    },
    {
      key: "status",
      label: "Status",
      sortValue: (r) => r.status,
      csvValue: (r) => r.status,
      render: (r) => <StatusBadge status={r.status === "ACTIVE" ? "ACTIVE" : r.status === "PAUSED" ? "SUSPENDED" : "INACTIVE"} />,
    },
    {
      key: "rates",
      label: "Contribution",
      sortValue: (r) => Number(r.employeePct || 0) + Number(r.employerPct || 0),
      csvValue: (r) => `${r.employeePct}% + ${r.employerPct}% on ${titleCase(r.basis)}`,
      render: (r) => <span className="text-xs text-slate-600 dark:text-slate-300 tabular-nums">{r.employeePct}% + {r.employerPct}% on {titleCase(r.basis)}</span>,
    },
    {
      key: "employeeTotal",
      label: "Employee Paid",
      align: "right",
      sortValue: (r) => r.employeeTotal,
      csvValue: (r) => r.employeeTotal,
      render: (r) => <span className="text-xs tabular-nums text-slate-600 dark:text-slate-300">{fmtMoney(r.employeeTotal)}</span>,
    },
    {
      key: "employerTotal",
      label: "Employer Paid",
      align: "right",
      sortValue: (r) => r.employerTotal,
      csvValue: (r) => r.employerTotal,
      render: (r) => <span className="text-xs tabular-nums text-slate-600 dark:text-slate-300">{fmtMoney(r.employerTotal)}</span>,
    },
    {
      key: "balance",
      label: "Balance",
      align: "right",
      sortValue: (r) => r.balance,
      csvValue: (r) => r.balance,
      render: (r) => <span className="text-sm font-bold tabular-nums text-emerald-700 dark:text-emerald-400">{fmtMoney(r.balance)}</span>,
    },
    {
      key: "months",
      label: "Months",
      align: "right",
      sortValue: (r) => r.months,
      csvValue: (r) => r.months,
      render: (r) => <span className="text-xs text-slate-500 tabular-nums">{r.months}</span>,
    },
    {
      key: "actions",
      label: "",
      align: "right",
      exportable: false,
      render: (r) => canEdit && (
        <div className="flex gap-1">
          <Button size="icon" variant="ghost" className="h-7 w-7" title="Statement" onClick={() => setStatement(r)}><History className="h-3.5 w-3.5" /></Button>
          <Button size="icon" variant="ghost" className="h-7 w-7" title="Edit enrollment" onClick={() => { setEditRec(r); setEnrollOpen(true) }}><Pencil className="h-3.5 w-3.5" /></Button>
          {r.status !== "CLOSED" ? (
            <Button size="icon" variant="ghost" className="h-7 w-7 text-slate-400 hover:text-amber-600" title={r.status === "ACTIVE" ? "Pause contributions" : "Resume contributions"}
              onClick={async () => { await rpc("pf.setStatus", { id: r.id, status: r.status === "ACTIVE" ? "PAUSED" : "ACTIVE" }); reload() }}>
              {r.status === "ACTIVE" ? <Clock className="h-3.5 w-3.5" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
            </Button>
          ) : null}
        </div>
      ),
    },
  ]

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard label="Enrollments" value={rows.length} icon={PiggyBank} tone="emerald" />
        <StatCard label="Active" value={rows.filter((r) => r.status === "ACTIVE").length} icon={CheckCircle2} tone="teal" />
        <StatCard label="Total Balance" value={fmtMoney(rows.reduce((s, r) => s + r.balance, 0))} icon={Wallet} tone="sky" />
        <StatCard label="Policy" value={pfEnabled ? "Enabled" : "Disabled"} sub={pfEnabled ? `${settings.pf.employeePct}% + ${settings.pf.employerPct}% · ${pfEligibleStatuses.map(titleCase).join(", ")}` : "Settings → Payroll"} icon={Info} tone={pfEnabled ? "emerald" : "amber"} />
      </div>
      {!pfEnabled && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 dark:bg-amber-950/30 px-3 py-2 text-xs text-amber-800 dark:text-amber-300">
          Provident Fund is currently <b>disabled</b> in Settings → Payroll → Provident Fund — enrollments exist but nothing is withheld until it is enabled.
        </div>
      )}
      {canEdit && (
        <div className="flex flex-wrap gap-1.5">
          <Button size="sm" onClick={() => { setEditRec(null); setEnrollOpen(true) }} className="h-8 text-xs ">
            <Plus className="h-3.5 w-3.5 mr-1" /> Enroll Employee
          </Button>
          <Button size="sm" variant="outline" className="h-8 text-xs" onClick={() => setManualOpen(true)}>
            <Banknote className="h-3.5 w-3.5 mr-1" /> Manual / Opening Entry
          </Button>
          <Button size="sm" variant="outline" className="h-8 text-xs text-indigo-700 dark:text-indigo-300 border-indigo-200 dark:border-indigo-800 hover:bg-indigo-50 dark:hover:bg-indigo-950/30" onClick={() => setBulkOpen(true)}>
            <FileSpreadsheet className="h-3.5 w-3.5 mr-1 text-indigo-600" /> Bulk Import Opening PF
          </Button>
        </div>
      )}
      <DataTable columns={columns} exportColumns={exportColumns} rows={rows} loading={loading} error={error} pageSize={15} csvName="pf-enrollments" emptyTitle="No PF enrollments" emptyHint="Enroll employees to start withholding contributions at payroll." />

      <FormDialog open={enrollOpen} onOpenChange={(v) => { setEnrollOpen(v); if (!v) { setEditRec(null); reload() } }}
        title={editRec ? `Edit PF — ${editRec.employeeName}` : "Enroll in Provident Fund"} fields={enrollFields} wide
        initial={editRec ? { employeePct: editRec.employeePct, employerPct: editRec.employerPct, basis: editRec.basis, note: editRec.note || "" } : {
          employeePct: settings?.pf?.employeePct ?? 10, employerPct: settings?.pf?.employerPct ?? 10, basis: settings?.pf?.basis || "BASIC",
        }}
        description="The employee portion is withheld at payroll; the employer portion accrues as a company cost. Percentages here override the vendor defaults."
        onSubmit={async (v) => { await rpc("pf.enroll", { employeeId: editRec?.employeeId || v.employeeId, ...v }) }} />

      {statement && <PfStatementDialog enrollment={statement} onClose={() => setStatement(null)} />}
      {manualOpen && <PfManualEntryDialog onClose={() => setManualOpen(false)} onDone={reload} onOpenBulk={() => setBulkOpen(true)} />}
      {bulkOpen && <PfBulkImportDialog onClose={() => setBulkOpen(false)} onDone={reload} />}
    </div>
  )
}

function PfStatementDialog({ enrollment, onClose }: { enrollment: any; onClose: () => void }) {
  const { data, loading, error } = useApi<any>("pf.statement", { employeeId: enrollment.employeeId })
  const [open, setOpen] = useState(true)

  return (
    <Dialog open={open} onOpenChange={(v) => { setOpen(v); if (!v) onClose() }}>
      <DialogContent className="sm:max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-base flex items-center gap-2">
            <PiggyBank className="h-4 w-4 text-emerald-600" /> PF Statement — {data?.employee?.fullName || enrollment.employeeName}
          </DialogTitle>
        </DialogHeader>
        {loading ? (
          <div className="h-40 bg-slate-100 dark:bg-slate-800 rounded-lg animate-pulse" />
        ) : error ? (
          <p className="text-sm text-rose-600">{error}</p>
        ) : data ? (
          <div className="space-y-3">
            <div className="grid grid-cols-3 gap-2">
              <div className="rounded-lg border p-2.5 text-center">
                <p className="text-[10px] text-slate-500 uppercase tracking-wide">Employee</p>
                <p className="text-sm font-bold tabular-nums text-slate-800 dark:text-slate-100">{fmtMoney(data.employeeTotal)}</p>
              </div>
              <div className="rounded-lg border p-2.5 text-center">
                <p className="text-[10px] text-slate-500 uppercase tracking-wide">Employer</p>
                <p className="text-sm font-bold tabular-nums text-slate-800 dark:text-slate-100">{fmtMoney(data.employerTotal)}</p>
              </div>
              <div className="rounded-lg border border-emerald-200 dark:border-emerald-900 bg-emerald-50 dark:bg-emerald-950/40 p-2.5 text-center">
                <p className="text-[10px] text-emerald-700 dark:text-emerald-400 uppercase tracking-wide">Balance</p>
                <p className="text-sm font-bold tabular-nums text-emerald-700 dark:text-emerald-300">{fmtMoney(data.balance)}</p>
              </div>
            </div>
            <div className="rounded-lg border overflow-hidden">
              <div className="max-h-72 overflow-y-auto">
                <table className="w-full text-[11px]">
                  <thead className="bg-slate-50 dark:bg-slate-800/80 sticky top-0">
                    <tr>
                      <th className="text-left px-2 py-1.5 font-medium text-slate-500">Period</th>
                      <th className="text-left px-2 py-1.5 font-medium text-slate-500">Source</th>
                      <th className="text-right px-2 py-1.5 font-medium text-slate-500">Employee</th>
                      <th className="text-right px-2 py-1.5 font-medium text-slate-500">Employer</th>
                      <th className="text-left px-2 py-1.5 font-medium text-slate-500">Note</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(data.ledger || []).length === 0 ? (
                      <tr><td colSpan={5} className="px-2 py-6 text-center text-slate-400">No contributions yet — rows appear when a payroll run is paid.</td></tr>
                    ) : data.ledger.map((c: any) => (
                      <tr key={c.id} className="border-t border-slate-100 dark:border-slate-800">
                        <td className="px-2 py-1 tabular-nums text-slate-600 dark:text-slate-300">{c.period}</td>
                        <td className="px-2 py-1"><Badge variant="outline" className="text-[9px]">{titleCase(c.source)}</Badge></td>
                        <td className="px-2 py-1 text-right tabular-nums text-slate-700 dark:text-slate-200">{fmtMoney(c.employeeAmount)}</td>
                        <td className="px-2 py-1 text-right tabular-nums text-slate-700 dark:text-slate-200">{fmtMoney(c.employerAmount)}</td>
                        <td className="px-2 py-1 text-slate-500 max-w-[220px] truncate" title={c.note || ""}>{c.note || "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

const getInitials = (name?: string | null) =>
  (name || "")
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() || "")
    .join("") || "E"

function EmployeeSearchPicker({
  employees,
  selectedId,
  onSelect,
}: {
  employees: any[]
  selectedId: string | null
  onSelect: (emp: any | null) => void
}) {
  const [query, setQuery] = useState("")
  const [isOpen, setIsOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  const selectedEmp = useMemo(
    () => employees.find((e) => e.id === selectedId),
    [employees, selectedId]
  )

  const filteredEmployees = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return employees.slice(0, 25)
    return employees
      .filter((e) => {
        const nameMatch = (e.fullName || "").toLowerCase().includes(q)
        const codeMatch = (e.code || "").toLowerCase().includes(q)
        const deptMatch = (e.department?.name || e.department || "").toLowerCase().includes(q)
        const desigMatch = (e.designation?.name || e.designation || "").toLowerCase().includes(q)
        return nameMatch || codeMatch || deptMatch || desigMatch
      })
      .slice(0, 35)
  }, [employees, query])

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false)
      }
    }
    document.addEventListener("mousedown", handleClickOutside)
    return () => document.removeEventListener("mousedown", handleClickOutside)
  }, [])

  return (
    <div ref={containerRef} className="space-y-1.5 relative">
      <div className="flex items-center justify-between">
        <Label className="text-xs font-semibold text-slate-800 dark:text-slate-200">
          Employee <span className="text-rose-500">*</span>
        </Label>
        {selectedEmp && (
          <button
            type="button"
            onClick={() => {
              onSelect(null)
              setQuery("")
              setIsOpen(true)
            }}
            className="text-[11px] text-indigo-600 dark:text-indigo-400 hover:underline flex items-center gap-1 font-medium"
          >
            Change employee
          </button>
        )}
      </div>

      {selectedEmp ? (
        <div className="flex items-center justify-between p-2.5 rounded-lg border border-emerald-200 dark:border-emerald-800 bg-emerald-50/50 dark:bg-emerald-950/20">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="h-8 w-8 rounded-full bg-emerald-600 text-white flex items-center justify-center font-bold text-xs shrink-0 shadow-xs">
              {getInitials(selectedEmp.fullName)}
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="font-semibold text-xs text-slate-900 dark:text-slate-100 truncate">
                  {selectedEmp.fullName}
                </span>
                <span className="text-[10px] font-mono px-1.5 py-0.2 rounded bg-white dark:bg-slate-800 border border-emerald-200 dark:border-emerald-800 text-emerald-800 dark:text-emerald-300">
                  {selectedEmp.code}
                </span>
                {selectedEmp.status && (
                  <span className={`text-[9px] px-1.5 py-0.2 rounded font-medium ${
                    selectedEmp.status === "ACTIVE" ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/60 dark:text-emerald-200" :
                    selectedEmp.status === "PROBATION" ? "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300" :
                    "bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-300"
                  }`}>
                    {selectedEmp.status}
                  </span>
                )}
              </div>
              <p className="text-[10px] text-muted-foreground truncate mt-0.5">
                {[
                  selectedEmp.department?.name || selectedEmp.department,
                  selectedEmp.designation?.name || selectedEmp.designation,
                ]
                  .filter(Boolean)
                  .join(" · ") || "Active Employee"}
              </p>
            </div>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 w-7 p-0 text-slate-400 hover:text-rose-600 rounded-full"
            onClick={() => {
              onSelect(null)
              setQuery("")
              setIsOpen(true)
            }}
            title="Deselect employee"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      ) : (
        <div className="relative">
          <div className="relative">
            <Search className="h-4 w-4 text-slate-400 absolute left-3 top-2.5" />
            <Input
              type="text"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value)
                setIsOpen(true)
              }}
              onFocus={() => setIsOpen(true)}
              placeholder="Search by name, ID (e.g. EMP-001), department…"
              className="pl-9 pr-8 h-9 text-xs"
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery("")}
                className="absolute right-2.5 top-2.5 text-slate-400 hover:text-slate-600"
              >
                <X className="h-4 w-4" />
              </button>
            )}
          </div>

          {isOpen && (
            <div className="absolute z-50 left-0 right-0 top-full mt-1 bg-white dark:bg-slate-900 border border-border rounded-lg shadow-lg max-h-56 overflow-y-auto divide-y divide-border">
              <div className="px-2.5 py-1.5 bg-slate-50 dark:bg-slate-800/60 text-[10px] text-muted-foreground flex justify-between items-center font-medium sticky top-0 z-10">
                <span>
                  {query ? `Found ${filteredEmployees.length} matching` : `Showing first ${filteredEmployees.length} of ${employees.length} employees`}
                </span>
                {query && <span className="font-normal italic">Type to filter more</span>}
              </div>

              {filteredEmployees.length === 0 ? (
                <div className="p-4 text-center text-xs text-muted-foreground">
                  No employees found matching &quot;{query}&quot;
                </div>
              ) : (
                filteredEmployees.map((emp) => {
                  const dept = emp.department?.name || emp.department || ""
                  const desig = emp.designation?.name || emp.designation || ""
                  return (
                    <button
                      key={emp.id}
                      type="button"
                      onClick={() => {
                        onSelect(emp)
                        setIsOpen(false)
                        setQuery("")
                      }}
                      className="w-full px-3 py-2 text-left hover:bg-slate-50 dark:hover:bg-slate-800 flex items-center gap-2.5 transition-colors text-xs"
                    >
                      <div className="h-7 w-7 rounded-full bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 flex items-center justify-center font-bold text-[10px] text-slate-700 dark:text-slate-200 shrink-0">
                        {getInitials(emp.fullName)}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <span className="font-semibold text-slate-900 dark:text-slate-100 truncate">
                            {emp.fullName}
                          </span>
                          <span className="font-mono text-[10px] text-slate-500 bg-slate-100 dark:bg-slate-800 px-1 py-0.2 rounded">
                            {emp.code}
                          </span>
                          {emp.status && emp.status !== "ACTIVE" && (
                            <span className={`text-[9px] px-1 py-0.2 rounded font-medium ${
                              emp.status === "PROBATION" ? "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300" :
                              emp.status === "SUSPENDED" || emp.status === "TERMINATED" ? "bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-300" :
                              "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300"
                            }`}>
                              {emp.status}
                            </span>
                          )}
                        </div>
                        <p className="text-[10px] text-muted-foreground truncate">
                          {[dept, desig].filter(Boolean).join(" · ") || "Active Employee"}
                        </p>
                      </div>
                      <span className="text-[10px] text-indigo-600 dark:text-indigo-400 font-medium shrink-0">
                        Select
                      </span>
                    </button>
                  )
                })
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function PfManualEntryDialog({ onClose, onDone, onOpenBulk }: { onClose: () => void; onDone: () => void; onOpenBulk?: () => void }) {
  const toast = useHrm((s) => s.toast)
  const { data: employees } = useEmployeeDirectory()
  const [values, setValues] = useState<any>({
    source: "OPENING",
    periodYear: new Date().getFullYear(),
    periodMonth: new Date().getMonth() + 1,
    employeeId: "",
    employeeAmount: "",
    employerAmount: "",
    note: "Opening balance carried from previous system",
  })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState(true)
  const set = (k: string, v: any) => setValues((s: any) => ({ ...s, [k]: v }))

  const totalSum = (Number(values.employeeAmount) || 0) + (Number(values.employerAmount) || 0)

  const submit = async () => {
    setError(null)
    if (!values.employeeId) { setError("Please search and select an employee"); return }
    if (!(Number(values.employeeAmount) > 0 || Number(values.employerAmount) > 0)) {
      setError("Enter an employee and/or employer contribution amount")
      return
    }
    setBusy(true)
    try {
      await rpc("pf.contribution.add", {
        employeeId: values.employeeId,
        source: values.source,
        periodYear: Number(values.periodYear),
        periodMonth: Number(values.periodMonth),
        employeeAmount: Number(values.employeeAmount) || 0,
        employerAmount: Number(values.employerAmount) || 0,
        note: values.note,
      })
      toast("PF entry successfully recorded")
      setOpen(false)
      onDone()
    } catch (e: any) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { setOpen(v); if (!v) onClose() }}>
      <DialogContent className="sm:max-w-lg p-6">
        <DialogHeader className="pb-1">
          <DialogTitle className="text-base flex items-center gap-2">
            <Banknote className="h-4 w-4 text-emerald-600" /> PF Manual / Opening Entry
          </DialogTitle>
          <p className="text-xs text-muted-foreground">
            Record opening balances or manual adjustments directly into an employee&apos;s Provident Fund ledger.
          </p>
        </DialogHeader>

        <div className="space-y-4 pt-1">
          {onOpenBulk && (
            <div className="rounded-lg border border-indigo-200/80 bg-indigo-50/60 dark:border-indigo-900/60 dark:bg-indigo-950/30 p-2.5 flex items-center justify-between gap-2 text-xs text-indigo-900 dark:text-indigo-200">
              <div className="flex items-center gap-2 min-w-0">
                <FileSpreadsheet className="h-4 w-4 text-indigo-600 dark:text-indigo-400 shrink-0" />
                <span className="truncate">Need to enter opening PF for multiple employees?</span>
              </div>
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-[11px] shrink-0 font-medium border-indigo-300 dark:border-indigo-800 text-indigo-700 dark:text-indigo-300 hover:bg-indigo-100 dark:hover:bg-indigo-900/50"
                onClick={() => {
                  setOpen(false)
                  onClose()
                  onOpenBulk()
                }}
              >
                Bulk Excel Import
              </Button>
            </div>
          )}

          {/* Searchable Employee Selection */}
          <EmployeeSearchPicker
            employees={employees || []}
            selectedId={values.employeeId || null}
            onSelect={(emp) => set("employeeId", emp ? emp.id : "")}
          />

          {/* Period & Source Row */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
            <div className="space-y-1.5">
              <Label className="text-xs font-semibold">Entry Source</Label>
              <Select value={values.source} onValueChange={(v) => {
                set("source", v)
                if (v === "OPENING" && !values.note) set("note", "Opening balance carried from previous system")
                if (v === "MANUAL" && values.note === "Opening balance carried from previous system") set("note", "Manual adjustment")
              }}>
                <SelectTrigger className="h-9 text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="OPENING">Opening Balance</SelectItem>
                  <SelectItem value="MANUAL">Manual Entry</SelectItem>
                  <SelectItem value="WITHDRAWAL">Withdrawal</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs font-semibold">Year</Label>
              <Input
                type="number"
                min={2000}
                max={2100}
                className="h-9 text-xs font-mono"
                value={values.periodYear}
                onChange={(e) => set("periodYear", e.target.value)}
              />
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs font-semibold">Month</Label>
              <Select
                value={String(values.periodMonth)}
                onValueChange={(v) => set("periodMonth", Number(v))}
              >
                <SelectTrigger className="h-9 text-xs"><SelectValue /></SelectTrigger>
                <SelectContent className="max-h-52">
                  {MONTHS.map((m, idx) => (
                    <SelectItem key={idx + 1} value={String(idx + 1)}>
                      {idx + 1} - {m}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Contribution Amounts */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
            <div className="space-y-1.5">
              <Label className="text-xs font-semibold">
                {values.source === "WITHDRAWAL" ? "Employee Debit (৳)" : "Employee Amount (৳)"}
              </Label>
              <Input
                type="number"
                min={0}
                className="h-9 text-xs tabular-nums"
                placeholder="0"
                value={values.employeeAmount ?? ""}
                onChange={(e) => set("employeeAmount", e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs font-semibold">
                {values.source === "WITHDRAWAL" ? "Employer Debit (৳)" : "Employer Amount (৳)"}
              </Label>
              <Input
                type="number"
                min={0}
                className="h-9 text-xs tabular-nums"
                placeholder="0"
                value={values.employerAmount ?? ""}
                onChange={(e) => set("employerAmount", e.target.value)}
              />
            </div>
          </div>

          {/* Live Balance Impact Preview */}
          <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50/80 dark:bg-slate-900/40 px-3 py-2 flex items-center justify-between text-xs">
            <span className="text-muted-foreground font-medium">
              {values.source === "WITHDRAWAL" ? "Total Ledger Deduction:" : "Total Balance Added:"}
            </span>
            <span className="text-sm font-bold tabular-nums text-emerald-700 dark:text-emerald-400">
              {values.source === "WITHDRAWAL" ? "-" : "+"} {fmtMoney(totalSum)}
            </span>
          </div>

          {/* Note & Quick Presets */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label className="text-xs font-semibold">Note / Remarks</Label>
              <span className="text-[10px] text-muted-foreground">Optional</span>
            </div>
            <Input
              className="h-9 text-xs"
              value={values.note ?? ""}
              onChange={(e) => set("note", e.target.value)}
              placeholder="e.g. Opening balance carried from previous system"
            />
            <div className="flex items-center gap-1.5 flex-wrap pt-0.5">
              <span className="text-[10px] text-muted-foreground">Quick presets:</span>
              <button
                type="button"
                onClick={() => set("note", "Opening balance carried from previous system")}
                className="text-[10px] px-2 py-0.5 rounded border border-border bg-card hover:bg-muted text-slate-600 dark:text-slate-300 transition-colors"
              >
                Opening balance
              </button>
              <button
                type="button"
                onClick={() => set("note", "Manual ledger adjustment")}
                className="text-[10px] px-2 py-0.5 rounded border border-border bg-card hover:bg-muted text-slate-600 dark:text-slate-300 transition-colors"
              >
                Manual adjustment
              </button>
              <button
                type="button"
                onClick={() => set("note", "Previous organization PF transfer")}
                className="text-[10px] px-2 py-0.5 rounded border border-border bg-card hover:bg-muted text-slate-600 dark:text-slate-300 transition-colors"
              >
                Previous Org Transfer
              </button>
            </div>
          </div>

          {error && (
            <div className="rounded-lg border border-rose-200 bg-rose-50 dark:bg-rose-950/40 px-3 py-2 text-xs text-rose-700 dark:text-rose-300 flex items-start gap-2">
              <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}
        </div>

        <DialogFooter className="pt-3 border-t border-border flex items-center justify-between sm:justify-between">
          <Button variant="outline" size="sm" onClick={() => { setOpen(false); onClose() }}>
            Cancel
          </Button>
          <Button
            size="sm"
            disabled={busy || !values.employeeId}
            className="bg-emerald-600 hover:bg-emerald-700 text-white gap-1.5"
            onClick={submit}
          >
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
            {busy ? "Saving…" : "Record Entry"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function PfBulkImportDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const toast = useHrm((s) => s.toast)
  const [open, setOpen] = useState(true)
  const [templateScope, setTemplateScope] = useState<"ELIGIBLE" | "ENROLLED" | "ALL">("ELIGIBLE")
  const [downloading, setDownloading] = useState(false)
  const [analyzing, setAnalyzing] = useState(false)
  const [importing, setImporting] = useState(false)
  const [fileName, setFileName] = useState<string | null>(null)
  const [base64Data, setBase64Data] = useState<string | null>(null)
  const [previewData, setPreviewData] = useState<any | null>(null)
  const [importError, setImportError] = useState<string | null>(null)
  const [filterTab, setFilterTab] = useState<"ALL" | "READY" | "SKIPPED" | "ERROR">("ALL")

  const handleDownloadTemplate = async () => {
    setDownloading(true)
    try {
      const res = await rpc<any>("pf.template.download", { filter: templateScope })
      // T-16 honesty: a response without real file bytes is a failure —
      // say so instead of spinning the button down in silence.
      if (!res?.base64) {
        toast("Template download failed — the server returned no file. Try again or contact support.", "err")
        return
      }
      const bin = atob(res.base64)
      const bytes = new Uint8Array(bin.length)
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
      const blob = new Blob([bytes], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" })
      const url = URL.createObjectURL(blob)
      const a = document.createElement("a")
      a.href = url
      a.download = res.fileName || "PF_Opening_Balances.xlsx"
      a.click()
      URL.revokeObjectURL(url)
      toast("Template downloaded with PF employees")
    } catch (e: any) {
      toast(String(e?.message || e), "err")
    } finally {
      setDownloading(false)
    }
  }

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    setFileName(file.name)
    setAnalyzing(true)
    setImportError(null)
    const reader = new FileReader()
    reader.onload = async (evt) => {
      try {
        const arrayBuffer = evt.target?.result as ArrayBuffer
        let binary = ""
        const bytes = new Uint8Array(arrayBuffer)
        const len = bytes.byteLength
        for (let i = 0; i < len; i++) {
          binary += String.fromCharCode(bytes[i])
        }
        const b64 = btoa(binary)
        setBase64Data(b64)

        const preview = await rpc<any>("pf.import.preview", { base64: b64 })
        setPreviewData(preview)
      } catch (err: any) {
        setImportError(err.message || "Failed to parse file")
      } finally {
        setAnalyzing(false)
      }
    }
    reader.readAsArrayBuffer(file)
  }

  const handleExecuteImport = async () => {
    if (!base64Data) return
    setImporting(true)
    setImportError(null)
    try {
      const res = await rpc<any>("pf.import.execute", { base64: base64Data })
      toast(`Successfully imported ${res.importedCount} PF records (${fmtMoney(res.totalCombined)} balance)${res.autoEnrolledCount ? ` · ${res.autoEnrolledCount} auto-enrolled` : ""}`)
      onDone()
      setOpen(false)
      onClose()
    } catch (err: any) {
      setImportError(err.message || "Import execution failed")
    } finally {
      setImporting(false)
    }
  }

  const filteredItems = (previewData?.items || []).filter((item: any) => {
    if (filterTab === "READY") return item.status === "READY"
    if (filterTab === "SKIPPED") return item.status === "SKIPPED"
    if (filterTab === "ERROR") return item.status === "ERROR"
    return true
  })

  return (
    <Dialog open={open} onOpenChange={(v) => { setOpen(v); if (!v) onClose() }}>
      <DialogContent className="sm:max-w-4xl max-h-[90vh] flex flex-col p-6">
        <DialogHeader className="shrink-0 pb-2">
          <DialogTitle className="text-base flex items-center gap-2">
            <FileSpreadsheet className="h-5 w-5 text-indigo-600" /> Bulk Import Opening / Historical PF
          </DialogTitle>
          <p className="text-xs text-muted-foreground">
            Download the pre-filled template with active employees, fill in their previously deducted PF contributions, and preview before importing.
          </p>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto space-y-4 pr-1">
          {/* Step 1 & Step 2 Cards */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {/* Step 1 */}
            <div className="rounded-xl border border-border bg-slate-50/50 dark:bg-slate-900/40 p-3.5 flex flex-col justify-between">
              <div>
                <div className="flex items-center gap-2 mb-1.5">
                  <span className="flex items-center justify-center w-5 h-5 rounded-full bg-indigo-100 dark:bg-indigo-900/60 text-indigo-700 dark:text-indigo-300 text-xs font-bold">1</span>
                  <span className="font-semibold text-xs text-slate-800 dark:text-slate-200">Download Pre-filled Template</span>
                </div>
                <p className="text-[11px] text-muted-foreground leading-relaxed mb-2.5">
                  Generates an Excel sheet pre-populated with employees, their Basic Salary, and PF status.
                </p>
                <div className="space-y-1">
                  <Label className="text-[10px] text-muted-foreground uppercase font-semibold">Include Employees</Label>
                  <Select value={templateScope} onValueChange={(v: any) => setTemplateScope(v)}>
                    <SelectTrigger className="h-7 text-xs bg-white dark:bg-slate-800">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="ELIGIBLE">PF Eligible Employees Only (Recommended)</SelectItem>
                      <SelectItem value="ENROLLED">Currently Enrolled in PF Only</SelectItem>
                      <SelectItem value="ALL">All Active Employees</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="mt-3">
                <Button size="sm" variant="outline" className="w-full h-8 text-xs gap-1.5 border-indigo-200 dark:border-indigo-800 text-indigo-700 dark:text-indigo-300 hover:bg-indigo-50 dark:hover:bg-indigo-950/40"
                  onClick={handleDownloadTemplate} disabled={downloading}>
                  {downloading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
                  Download Template (.xlsx)
                </Button>
              </div>
            </div>

            {/* Step 2 */}
            <div className="rounded-xl border border-border bg-slate-50/50 dark:bg-slate-900/40 p-3.5 flex flex-col justify-between">
              <div>
                <div className="flex items-center gap-2 mb-1.5">
                  <span className="flex items-center justify-center w-5 h-5 rounded-full bg-indigo-100 dark:bg-indigo-900/60 text-indigo-700 dark:text-indigo-300 text-xs font-bold">2</span>
                  <span className="font-semibold text-xs text-slate-800 dark:text-slate-200">Upload Filled Spreadsheet</span>
                </div>
                <p className="text-[11px] text-muted-foreground leading-relaxed">
                  Select your updated spreadsheet. Blank or zero amounts are cleanly skipped so you can keep the full employee list intact.
                </p>
              </div>
              <div className="mt-3">
                <label className="flex items-center justify-center gap-1.5 h-8 px-3 rounded-md border border-dashed border-indigo-300 dark:border-indigo-700 bg-white dark:bg-slate-800/80 hover:bg-indigo-50/50 dark:hover:bg-slate-800 cursor-pointer text-xs font-medium text-slate-700 dark:text-slate-200 transition-colors">
                  {analyzing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5 text-indigo-600" />}
                  <span className="truncate max-w-[200px]">{fileName || "Choose file to verify…"}</span>
                  <input type="file" accept=".xlsx, .xls" className="hidden" onChange={handleFileUpload} disabled={analyzing} />
                </label>
              </div>
            </div>
          </div>

          {/* Import Error Banner */}
          {importError && (
            <div className="rounded-lg border border-rose-200 bg-rose-50 dark:bg-rose-950/40 px-3 py-2 text-xs text-rose-700 dark:text-rose-300 flex items-start gap-2">
              <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
              <div>{importError}</div>
            </div>
          )}

          {/* Verification Stats Summary */}
          {previewData && (
            <div className="space-y-3">
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
                <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900/30 p-2 text-center">
                  <p className="text-[10px] text-muted-foreground uppercase font-semibold">Total Rows</p>
                  <p className="text-sm font-bold text-slate-800 dark:text-slate-100">{previewData.totalRows}</p>
                </div>
                <div className="rounded-lg border border-emerald-200 dark:border-emerald-900 bg-emerald-50 dark:bg-emerald-950/40 p-2 text-center">
                  <p className="text-[10px] text-emerald-700 dark:text-emerald-400 uppercase font-semibold">Ready to Import</p>
                  <p className="text-sm font-bold text-emerald-700 dark:text-emerald-300">{previewData.validCount}</p>
                </div>
                <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900/30 p-2 text-center">
                  <p className="text-[10px] text-slate-500 uppercase font-semibold">Skipped (0/Blank)</p>
                  <p className="text-sm font-bold text-slate-600 dark:text-slate-400">{previewData.skippedCount}</p>
                </div>
                <div className="rounded-lg border border-rose-200 dark:border-rose-900 bg-rose-50 dark:bg-rose-950/40 p-2 text-center">
                  <p className="text-[10px] text-rose-700 dark:text-rose-400 uppercase font-semibold">Errors</p>
                  <p className="text-sm font-bold text-rose-700 dark:text-rose-300">{previewData.errorCount}</p>
                </div>
              </div>

              {/* Financial Totals Banner */}
              <div className="rounded-lg border border-indigo-100 dark:border-indigo-950/60 bg-gradient-to-r from-indigo-50/50 via-slate-50/50 to-emerald-50/50 dark:from-indigo-950/20 dark:via-slate-900/30 dark:to-emerald-950/20 p-2.5 flex flex-wrap items-center justify-between gap-3 text-xs">
                <div className="flex items-center gap-4 flex-wrap">
                  <div>
                    <span className="text-[10px] text-muted-foreground block">Employee Sum:</span>
                    <span className="font-semibold text-slate-800 dark:text-slate-200 tabular-nums">{fmtMoney(previewData.totalEmployeeAmount)}</span>
                  </div>
                  <div>
                    <span className="text-[10px] text-muted-foreground block">Employer Sum:</span>
                    <span className="font-semibold text-slate-800 dark:text-slate-200 tabular-nums">{fmtMoney(previewData.totalEmployerAmount)}</span>
                  </div>
                  <div className="border-l border-border pl-4">
                    <span className="text-[10px] text-emerald-700 dark:text-emerald-400 block font-semibold">Combined Balance:</span>
                    <span className="text-sm font-bold text-emerald-700 dark:text-emerald-300 tabular-nums">{fmtMoney(previewData.totalCombined)}</span>
                  </div>
                </div>

                {/* Filter Pills */}
                <div className="flex items-center gap-1 bg-white dark:bg-slate-800 p-0.5 rounded-lg border border-border">
                  <button type="button" onClick={() => setFilterTab("ALL")}
                    className={`px-2 py-0.5 text-[11px] rounded font-medium transition-colors ${filterTab === "ALL" ? "bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900" : "text-muted-foreground hover:text-foreground"}`}>
                    All ({previewData.totalRows})
                  </button>
                  <button type="button" onClick={() => setFilterTab("READY")}
                    className={`px-2 py-0.5 text-[11px] rounded font-medium transition-colors ${filterTab === "READY" ? "bg-emerald-600 text-white" : "text-emerald-700 dark:text-emerald-400 hover:text-emerald-800"}`}>
                    Ready ({previewData.validCount})
                  </button>
                  <button type="button" onClick={() => setFilterTab("SKIPPED")}
                    className={`px-2 py-0.5 text-[11px] rounded font-medium transition-colors ${filterTab === "SKIPPED" ? "bg-slate-600 text-white" : "text-muted-foreground hover:text-foreground"}`}>
                    Skipped ({previewData.skippedCount})
                  </button>
                  {previewData.errorCount > 0 && (
                    <button type="button" onClick={() => setFilterTab("ERROR")}
                      className={`px-2 py-0.5 text-[11px] rounded font-medium transition-colors ${filterTab === "ERROR" ? "bg-rose-600 text-white" : "text-rose-600 hover:text-rose-700"}`}>
                      Errors ({previewData.errorCount})
                    </button>
                  )}
                </div>
              </div>

              {/* Preview Table */}
              <div className="rounded-lg border border-border overflow-hidden">
                <div className="max-h-56 overflow-y-auto">
                  <table className="w-full text-[11px]">
                    <thead className="bg-slate-50 dark:bg-slate-800/80 sticky top-0 text-slate-500 font-medium">
                      <tr>
                        <th className="text-left px-2.5 py-1.5 w-12">Row</th>
                        <th className="text-left px-2.5 py-1.5 w-24">Status</th>
                        <th className="text-left px-2.5 py-1.5">Employee</th>
                        <th className="text-left px-2.5 py-1.5">Department</th>
                        <th className="text-right px-2.5 py-1.5">Employee (৳)</th>
                        <th className="text-right px-2.5 py-1.5">Employer (৳)</th>
                        <th className="text-right px-2.5 py-1.5">Total (৳)</th>
                        <th className="text-left px-2.5 py-1.5">Period</th>
                        <th className="text-left px-2.5 py-1.5">Remarks / Details</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {filteredItems.length === 0 ? (
                        <tr>
                          <td colSpan={9} className="px-3 py-6 text-center text-muted-foreground">
                            No records in this tab.
                          </td>
                        </tr>
                      ) : (
                        filteredItems.map((r: any) => (
                          <tr key={r.rowNo} className={r.status === "ERROR" ? "bg-rose-50/40 dark:bg-rose-950/20" : r.status === "SKIPPED" ? "opacity-60" : ""}>
                            <td className="px-2.5 py-1 font-mono text-muted-foreground">#{r.rowNo}</td>
                            <td className="px-2.5 py-1">
                              <Badge variant="outline" className={`text-[9px] px-1.5 py-0 ${
                                r.status === "READY"
                                  ? "border-emerald-500 text-emerald-700 dark:text-emerald-300 bg-emerald-50 dark:bg-emerald-950/30"
                                  : r.status === "SKIPPED"
                                  ? "border-slate-300 text-slate-600 dark:text-slate-400"
                                  : "border-rose-500 text-rose-700 dark:text-rose-300 bg-rose-50 dark:bg-rose-950/30"
                              }`}>
                                {r.status}
                              </Badge>
                            </td>
                            <td className="px-2.5 py-1">
                              <span className="font-semibold text-slate-800 dark:text-slate-100">{r.employeeName}</span>
                              <span className="text-[10px] text-muted-foreground font-mono ml-1.5">({r.employeeCode})</span>
                              {!r.alreadyEnrolled && r.status === "READY" && (
                                <span className="ml-1.5 text-[9px] text-indigo-600 dark:text-indigo-400 bg-indigo-50 dark:bg-indigo-950/40 px-1 py-0.2 rounded border border-indigo-200 dark:border-indigo-900" title="Will be automatically enrolled upon import">
                                  Auto-enroll
                                </span>
                              )}
                            </td>
                            <td className="px-2.5 py-1 text-muted-foreground truncate max-w-[130px]" title={r.department}>{r.department}</td>
                            <td className="px-2.5 py-1 text-right tabular-nums text-slate-700 dark:text-slate-200">{fmtMoney(r.employeeAmount)}</td>
                            <td className="px-2.5 py-1 text-right tabular-nums text-slate-700 dark:text-slate-200">{fmtMoney(r.employerAmount)}</td>
                            <td className="px-2.5 py-1 text-right tabular-nums font-semibold text-slate-900 dark:text-slate-100">{fmtMoney(r.totalAmount)}</td>
                            <td className="px-2.5 py-1 font-mono text-muted-foreground">{r.year}-{String(r.month).padStart(2, "0")}</td>
                            <td className="px-2.5 py-1 text-muted-foreground max-w-[200px] truncate" title={r.error || r.note}>
                              {r.error ? <span className="text-rose-600 dark:text-rose-400 font-medium">{r.error}</span> : r.note}
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}
        </div>

        <DialogFooter className="shrink-0 pt-3 border-t border-border flex items-center justify-between">
          <div className="text-[11px] text-muted-foreground">
            {previewData && previewData.validCount > 0 ? (
              <span>Ready to commit <b className="text-emerald-600 dark:text-emerald-400">{previewData.validCount}</b> rows ({fmtMoney(previewData.totalCombined)} balance).</span>
            ) : (
              <span>Upload a valid Excel file to proceed.</span>
            )}
          </div>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => { setOpen(false); onClose() }}>
              Cancel
            </Button>
            <Button size="sm" disabled={!previewData || previewData.validCount === 0 || importing}
              className="bg-indigo-600 hover:bg-indigo-700 text-white gap-1.5"
              onClick={handleExecuteImport}>
              {importing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
              {importing ? "Importing…" : `Confirm & Import ${previewData?.validCount ? `(${previewData.validCount})` : ""}`}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ============================================================
// 2026-10 round — Payout Settings + Dynamic Salary Export (§44–§54, §76–§77)
// ============================================================

/** Payroll → Payout Settings (§44): method toggles + Cash/MFS salary ceiling. */
function PayoutSettingsTab() {
  const settings = useHrm((s) => s.settings)
  const toast = useHrm((s) => s.toast)
  const [busy, setBusy] = useState(false)
  const payout = (settings as any)?.payout ?? { bankEnabled: true, cashEnabled: true, mfsEnabled: true, maxCashMfsSalary: 10000, thresholdBasis: "GROSS" }
  const [form, setForm] = useState<any>(null)
  const v = form ?? payout

  const save = async () => {
    setBusy(true)
    try {
      // H-12 — shared save path merges the response into the store so the
      // toggles reflect what was persisted (they previously snapped back)
      await useHrm.getState().saveSettingsGroup("payout", { ...v, maxCashMfsSalary: Number(v.maxCashMfsSalary) || 0 })
      toast("Payout settings saved — applies to new validations immediately")
      setForm(null)
    } catch (e: any) {
      toast(String(e?.message || e), "err")
    } finally {
      setBusy(false)
    }
  }


  return (
    <SectionCard title="Payout Settings" actions={
      <Button size="sm" disabled={busy || !form} onClick={save}>{busy ? "Saving…" : "Save Changes"}</Button>
    }>
      <div className="grid sm:grid-cols-2 gap-4 max-w-2xl">
        <label className="flex items-center justify-between rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-2.5 text-sm">
          <span>Bank payout <span className="text-slate-400 text-xs">enabled</span></span>
          <Switch checked={!!v.bankEnabled} onCheckedChange={(x) => setForm({ ...v, bankEnabled: x })} />
        </label>
        <label className="flex items-center justify-between rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-2.5 text-sm">
          <span>Cash payout <span className="text-slate-400 text-xs">enabled</span></span>
          <Switch checked={!!v.cashEnabled} onCheckedChange={(x) => setForm({ ...v, cashEnabled: x })} />
        </label>
        <label className="flex items-center justify-between rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-2.5 text-sm">
          <span>MFS payout <span className="text-slate-400 text-xs">bKash / Nagad / Rocket</span></span>
          <Switch checked={!!v.mfsEnabled} onCheckedChange={(x) => setForm({ ...v, mfsEnabled: x })} />
        </label>
        <div>
          <Label className="text-xs">Maximum salary eligible for Cash / MFS (৳)</Label>
          <Input type="number" min={0} value={v.maxCashMfsSalary} onChange={(e) => setForm({ ...v, maxCashMfsSalary: e.target.value })} className="text-sm" />
          <p className="text-[11px] text-slate-400 mt-1">Salaries above this ceiling are Bank-only — enforced server-side at create/edit, payroll pay and export (§45).</p>
        </div>
        <div>
          <Label className="text-xs">Threshold basis</Label>
          <Select value={v.thresholdBasis || "GROSS"} onValueChange={(x) => setForm({ ...v, thresholdBasis: x })}>
            <SelectTrigger className="text-sm"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="GROSS">Gross salary</SelectItem>
              <SelectItem value="NET">Net salary</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
    </SectionCard>
  )
}

/** Payroll → Salary Export (§48–§53, §76): run + filters + type + format,
 *  server-side preview totals, then XLSX / CSV / PDF download. */
function SalaryExportTab() {
  const { can, toast } = useHrm()
  const [runId, setRunId] = useState("")
  const [type, setType] = useState<"ALL" | "BANK" | "CASH" | "MFS">("ALL")
  const [format, setFormat] = useState<"xlsx" | "csv" | "pdf">("xlsx")
  const [branchId, setBranchId] = useState("all")
  const [departmentId, setDepartmentId] = useState("all")
  const [employeeId, setEmployeeId] = useState("all")
  const [preview, setPreview] = useState<any | null>(null)
  const [busy, setBusy] = useState(false)
  const { data: runs } = useApi<any[]>("payroll.runs.list", {})
  const { data: branches } = useApi<any[]>("branches.list", {})
  const { data: departments } = useApi<any[]>("departments.list", {})
  const dir = useEmployeeDirectory()

  const filterPayload = () => ({
    runId,
    type,
    branchId: branchId === "all" ? null : branchId,
    departmentId: departmentId === "all" ? null : departmentId,
    employeeId: employeeId === "all" ? null : employeeId,
  })

  const doPreview = async () => {
    if (!runId) return
    setBusy(true)
    try {
      const r = await rpc("payroll.export.preview", filterPayload())
      setPreview(r)
    } catch (e: any) {
      toast(String(e?.message || e), "err")
      setPreview(null)
    } finally {
      setBusy(false)
    }
  }

  const doExport = async () => {
    if (!runId) return
    setBusy(true)
    try {
      const r = await rpc("payroll.export.salary", { ...filterPayload(), format })
      // browser download from the returned payload (csv text or base64 file)
      const a = document.createElement("a")
      if (r.format === "csv") {
        // RPT-09 — UTF-8 BOM so Bangla names survive Excel's encoding guess
        // (every other CSV download in the app already does this).
        a.href = URL.createObjectURL(new Blob(["\ufeff" + r.csv], { type: "text/csv;charset=utf-8" }))
      } else {
        const bin = atob(r.base64)
        const bytes = new Uint8Array(bin.length)
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
        a.href = URL.createObjectURL(new Blob([bytes], { type: r.format === "pdf" ? "application/pdf" : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }))
      }
      a.download = r.filename
      a.click()
      URL.revokeObjectURL(a.href)
      toast(`Exported ${r.totals.employees} employee(s) · net ${fmtMoney(r.totals.net)}${r.skipped?.length ? ` · ${r.skipped.length} skipped (no designated account)` : ""}`)
      setPreview(r)
    } catch (e: any) {
      toast(String(e?.message || e), "err")
    } finally {
      setBusy(false)
    }
  }

  const exportRuns = (runs ?? []).filter((r: any) => ["CALCULATED", "HR_REVIEW", "MANAGER_APPROVAL", "ACCOUNTING_APPROVAL", "APPROVED", "PAID"].includes(r.status))

  return (
    <SectionCard title="Salary Export" actions={<span className="text-xs text-slate-400">exports are audit-logged with run, type, filters and totals</span>}>
      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-64">
          <Label className="text-xs">Payroll run</Label>
          <Select value={runId} onValueChange={(v) => { setRunId(v); setPreview(null) }}>
            <SelectTrigger className="text-sm"><SelectValue placeholder="Select a run…" /></SelectTrigger>
            <SelectContent>
              {exportRuns.map((r: any) => (
                <SelectItem key={r.id} value={r.id}>
                  {r.periodYear}-{String(r.periodMonth).padStart(2, "0")}{r.periodWeek ? ` W${r.periodWeek}` : ""} · {titleCase(r.status)} · {fmtMoney(r.totalNet)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label className="text-xs">Export type</Label>
          <Select value={type} onValueChange={(v: any) => { setType(v); setPreview(null) }}>
            <SelectTrigger className="w-44 text-sm"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">All Employees</SelectItem>
              <SelectItem value="BANK">Bank Transfer</SelectItem>
              <SelectItem value="CASH">Cash Salary</SelectItem>
              <SelectItem value="MFS">MFS Salary</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label className="text-xs">Format</Label>
          <Select value={format} onValueChange={(v: any) => setFormat(v)}>
            <SelectTrigger className="w-28 text-sm"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="xlsx">Excel</SelectItem>
              <SelectItem value="csv">CSV</SelectItem>
              <SelectItem value="pdf">PDF</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label className="text-xs">Branch</Label>
          <Select value={branchId} onValueChange={(v) => { setBranchId(v); setPreview(null) }}>
            <SelectTrigger className="w-40 text-sm"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All branches</SelectItem>
              {(branches ?? []).map((b: any) => <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label className="text-xs">Department</Label>
          <Select value={departmentId} onValueChange={(v) => { setDepartmentId(v); setPreview(null) }}>
            <SelectTrigger className="w-44 text-sm"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All departments</SelectItem>
              {(departments ?? []).map((d: any) => <SelectItem key={d.id} value={d.id}>{d.name}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label className="text-xs">Employee</Label>
          <Select value={employeeId} onValueChange={(v) => { setEmployeeId(v); setPreview(null) }}>
            <SelectTrigger className="w-52 text-sm"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All employees</SelectItem>
              {(dir.data ?? []).map((e: any) => <SelectItem key={e.id} value={e.id}>{e.fullName} ({e.code})</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <Button size="sm" variant="outline" disabled={!runId || busy} onClick={doPreview}>Preview</Button>
        <Button size="sm" disabled={!runId || busy || !can("payroll", "export")} onClick={doExport}>
          <Download className="h-3.5 w-3.5 mr-1.5" />Export
        </Button>
      </div>

      {preview && (
        <div className="mt-4 grid sm:grid-cols-3 lg:grid-cols-6 gap-2">
          {[
            { label: "Employees", value: preview.totals?.employees ?? 0 },
            { label: "Gross", value: fmtMoney(preview.totals?.gross ?? 0) },
            { label: "Deductions", value: fmtMoney(preview.totals?.deductions ?? 0) },
            { label: "AIT", value: fmtMoney(preview.totals?.ait ?? 0) },
            { label: "Net", value: fmtMoney(preview.totals?.net ?? 0) },
            ...(type === "BANK" || type === "MFS" ? [{ label: "Payout recipients", value: preview.payoutRecipients ?? 0 }] : []),
          ].map((c) => (
            <div key={c.label} className="rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-2">
              <p className="text-[11px] uppercase tracking-wide text-slate-400">{c.label}</p>
              <p className="text-sm font-bold tabular-nums">{c.value}</p>
            </div>
          ))}
          {!!preview.skipped?.length && (
            <div className="sm:col-span-3 lg:col-span-6 rounded-lg border border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/40 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
              Not included (no designated {type.toLowerCase()} account): {preview.skipped.map((s: any) => `${s.employeeId} (${s.reason})`).join("; ")}
            </div>
          )}
        </div>
      )}
    </SectionCard>
  )
}


// ================= WP-F — Accounting Journals viewer =================
// List AccountJournal by refType/date with line drill-down, vendor-scoped
// (perm accounting.view). Every entry balances to the paisa (H-9); the
// viewer makes that auditable from the Payroll workspace.
function JournalsTab() {
  const [refType, setRefType] = useState<string>("")
  const [from, setFrom] = useState<string>("")
  const [to, setTo] = useState<string>("")
  const [page, setPage] = useState(1)
  const [detail, setDetail] = useState<any>(null)
  const PAGE = 50
  const payload = {
    ...(refType ? { refType } : {}),
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
    limit: PAGE, offset: (page - 1) * PAGE,
  }
  const { data, loading, error } = useApi<any>("journals.list", payload)
  const journals = data?.journals || []
  const total = data?.total || 0
  const refTypes: string[] = data?.refTypes || []

  const columns: Column<any>[] = [
    { key: "date", label: "Date", sortValue: (r) => r.date, render: (r) => <span className="text-xs tabular-nums">{fmtDate(r.date)}</span> },
    { key: "refType", label: "Type", render: (r) => <Badge variant="outline" className="text-[10px]">{r.refType}</Badge> },
    { key: "memo", label: "Memo", render: (r) => <span className="text-xs line-clamp-1 max-w-80 inline-block align-middle" title={r.memo}>{r.memo}</span> },
    { key: "amount", label: "Amount", align: "right", sortValue: (r) => r.amount, render: (r) => <span className="text-sm font-semibold tabular-nums">{fmtMoney(r.amount)}</span> },
    { key: "lines", label: "Lines", render: (r) => <span className="text-xs text-slate-400">{(r.lines || []).length}</span> },
    { key: "actions", label: "", align: "right", render: (r) => (
      <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setDetail(r)}>View</Button>
    ) },
  ]

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Select value={refType || "all"} onValueChange={(v) => { setRefType(v === "all" ? "" : v); setPage(1) }}>
          <SelectTrigger className="w-44 h-8 text-sm"><SelectValue placeholder="All types" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All types</SelectItem>
            {refTypes.map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}
          </SelectContent>
        </Select>
        <input type="date" value={from} onChange={(e) => { setFrom(e.target.value); setPage(1) }} className="h-8 rounded-md border border-slate-200 dark:border-slate-700 bg-transparent px-2 text-sm" title="From date" />
        <span className="text-xs text-slate-400">→</span>
        <input type="date" value={to} onChange={(e) => { setTo(e.target.value); setPage(1) }} className="h-8 rounded-md border border-slate-200 dark:border-slate-700 bg-transparent px-2 text-sm" title="To date" />
        {(refType || from || to) && (
          <Button size="sm" variant="ghost" className="h-8" onClick={() => { setRefType(""); setFrom(""); setTo(""); setPage(1) }}>Clear</Button>
        )}
        <span className="text-xs text-slate-400 ml-auto">{total.toLocaleString()} journal(s)</span>
      </div>
      {error && <ErrorBanner message={error} />}
      <DataTable
        columns={columns} rows={journals} loading={loading} error={error} searchable={false} pageSize={PAGE}
        emptyTitle="No journals match these filters" emptyHint="Journals post automatically when payroll runs are paid, payouts confirmed or runs cancelled (with reversal)."
        onRowClick={(r) => setDetail(r)}
      />
      {total > PAGE && (
        <div className="flex items-center justify-between">
          <Button size="sm" variant="outline" className="h-8 text-xs" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Previous</Button>
          <span className="text-xs text-slate-400">Page {page} of {Math.ceil(total / PAGE)}</span>
          <Button size="sm" variant="outline" className="h-8 text-xs" disabled={page * PAGE >= total} onClick={() => setPage((p) => p + 1)}>Next</Button>
        </div>
      )}

      <Dialog open={!!detail} onOpenChange={(v) => { if (!v) setDetail(null) }}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle className="text-base flex items-center gap-2">
              <Badge variant="outline">{detail?.refType}</Badge>
              <span className="text-xs text-slate-400 font-normal">{detail?.id}</span>
            </DialogTitle>
            <p className="text-xs text-slate-500">{detail?.memo}</p>
          </DialogHeader>
          <div className="grid grid-cols-3 gap-2 text-xs py-1">
            <div><span className="text-slate-400">Date: </span><span className="tabular-nums">{detail?.date}</span></div>
            <div><span className="text-slate-400">Amount: </span><span className="font-semibold tabular-nums">{fmtMoney(detail?.amount)}</span></div>
            <div><span className="text-slate-400">Source: </span>{detail?.source || "HRM"}</div>
          </div>
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-slate-200 dark:border-slate-800 text-slate-400">
                <th className="text-left font-medium py-1.5">Account</th>
                <th className="text-left font-medium py-1.5 pl-2">Name</th>
                <th className="text-right font-medium py-1.5">Debit</th>
                <th className="text-right font-medium py-1.5">Credit</th>
              </tr>
            </thead>
            <tbody>
              {(detail?.lines || []).map((l: any, i: number) => (
                <tr key={i} className="border-b border-slate-100 dark:border-slate-800/60">
                  <td className="py-1.5 font-mono">{l.account}</td>
                  <td className="py-1.5 pl-2 text-slate-500">{l.accountName}</td>
                  <td className="py-1.5 text-right tabular-nums">{l.debit ? fmtMoney(l.debit) : ""}</td>
                  <td className="py-1.5 text-right tabular-nums">{l.credit ? fmtMoney(l.credit) : ""}</td>
                </tr>
              ))}
              <tr className="font-semibold border-t-2 border-slate-200 dark:border-slate-700">
                <td colSpan={2} className="py-1.5">Total</td>
                <td className="py-1.5 text-right tabular-nums">{fmtMoney((detail?.lines || []).reduce((s: number, l: any) => s + (l.debit || 0), 0))}</td>
                <td className="py-1.5 text-right tabular-nums">{fmtMoney((detail?.lines || []).reduce((s: number, l: any) => s + (l.credit || 0), 0))}</td>
              </tr>
            </tbody>
          </table>
          <p className="text-[10px] text-slate-400">Debits and credits must equal to the paisa (H-9 invariant, enforced at post time).</p>
        </DialogContent>
      </Dialog>
    </div>
  )
}


// ================= WP-G — Payroll Preflight panel =================
// Preview BEFORE generation: "Employees: 248 · Ready: 239 · Warnings: 7 ·
// Blocked: 2", expandable Warning/Blocked lists with reason chips and deep
// links into the employee profile, plus "Generate for Ready + Warnings only"
// (blocked employees are excluded from the calculation and recorded in the
// run summary — server re-validates at generate time, defense in depth).
function PreflightPanel({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const { can, navigate } = useHrm()
  const toast = useHrm((s) => s.toast)
  const [month, setMonth] = useState(new Date().getMonth() + 1)
  const [year, setYear] = useState(new Date().getFullYear())
  const [data, setData] = useState<any>(null)
  const [busy, setBusy] = useState(false)
  const [expanded, setExpanded] = useState<"warning" | "blocked" | null>(null)
  const [genBusy, setGenBusy] = useState(false)

  useEffect(() => {
    if (!open) { setData(null); setExpanded(null); return }
    setBusy(true)
    rpc<any>("payroll.preflight", { periodMonth: month, periodYear: year })
      .then((d) => setData(d))
      .catch((e: any) => toast(String(e?.message || e), "err"))
      .finally(() => setBusy(false))
  }, [open, month, year])

  const generate = async () => {
    setGenBusy(true)
    try {
      // Blocked employees are auto-excluded from generation (recorded in the
      // run summary via excludedJson; the server re-validates everything).
      const blockedIds = (data?.blocked || []).map((b: any) => b.employeeId)
      const run = await rpc<any>("payroll.runs.create", { periodMonth: month, periodYear: year })
      await rpc("payroll.calculate", { runId: run.id, ...(blockedIds.length ? { excludeEmployeeIds: blockedIds } : {}) })
      toast(`Run created for ${monthLabel(month)} ${year}${blockedIds.length ? ` — ${blockedIds.length} blocked employee(s) excluded` : ""}`)
      onOpenChange(false)
    } catch (e: any) {
      toast(String(e?.message || e), "err")
    } finally { setGenBusy(false) }
  }

  const c = data?.counts
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-base flex items-center gap-2">
            <ShieldCheck className="h-4 w-4 text-emerald-600" /> Payroll Preflight — {monthLabel(month)} {year}
          </DialogTitle>
          <p className="text-xs text-slate-500">
            Per-employee readiness before generation. Classifications mirror exactly what generation and payment enforce — a READY employee is never blocked later.
          </p>
        </DialogHeader>

        <div className="flex items-center gap-2">
          <Select value={String(month)} onValueChange={(v) => setMonth(Number(v))}>
            <SelectTrigger className="w-32 h-8 text-sm"><SelectValue /></SelectTrigger>
            <SelectContent>{MONTHS.map((m, i) => <SelectItem key={m} value={String(i + 1)}>{m}</SelectItem>)}</SelectContent>
          </Select>
          <Input type="number" value={year} onChange={(e) => setYear(Number(e.target.value) || year)} className="w-24 h-8 text-sm" />
        </div>

        {busy && <div className="flex items-center justify-center gap-2 py-8 text-sm text-slate-400"><Loader2 className="h-4 w-4 animate-spin" /> Checking every employee…</div>}
        {!busy && data && (
          <>
            <div className="grid grid-cols-4 gap-2">
              <div className="rounded-lg border border-slate-200 dark:border-slate-800 p-3 text-center">
                <p className="text-xl font-bold tabular-nums">{c.total}</p>
                <p className="text-[10px] uppercase tracking-wide text-slate-400">Employees</p>
              </div>
              <div className="rounded-lg border border-emerald-200 dark:border-emerald-900 bg-emerald-50/50 dark:bg-emerald-950/30 p-3 text-center">
                <p className="text-xl font-bold tabular-nums text-emerald-600">{c.ready}</p>
                <p className="text-[10px] uppercase tracking-wide text-emerald-600/70">Ready</p>
              </div>
              <div className="rounded-lg border border-amber-200 dark:border-amber-900 bg-amber-50/50 dark:bg-amber-950/30 p-3 text-center">
                <p className="text-xl font-bold tabular-nums text-amber-600">{c.warning}</p>
                <p className="text-[10px] uppercase tracking-wide text-amber-600/70">Warnings</p>
              </div>
              <div className="rounded-lg border border-rose-200 dark:border-rose-900 bg-rose-50/50 dark:bg-rose-950/30 p-3 text-center">
                <p className="text-xl font-bold tabular-nums text-rose-600">{c.blocked}</p>
                <p className="text-[10px] uppercase tracking-wide text-rose-600/70">Blocked</p>
              </div>
            </div>

            {/* PAY-005 — bonus & commission exposure riding this period */}
            {data.bonusExposure && (data.bonusExposure.approved.count > 0 || data.bonusExposure.pending.count > 0) && (() => {
              const be = data.bonusExposure
              return (
                <div className={`rounded-xl border p-3 space-y-2 ${be.exposureWarning ? "border-amber-300 dark:border-amber-800 bg-amber-50/60 dark:bg-amber-950/30" : "border-slate-200 dark:border-slate-800"}`}>
                  <div className="flex items-center justify-between gap-2">
                    <span className={`flex items-center gap-1.5 text-sm font-semibold ${be.exposureWarning ? "text-amber-700 dark:text-amber-400" : "text-slate-700 dark:text-slate-200"}`}>
                      <Gift className="h-4 w-4" /> Bonuses & commissions in this period
                    </span>
                    {be.exposureWarning && (
                      <Badge className="bg-amber-100 text-amber-700 text-[10px]">exposure {be.exposurePct}% &gt; {be.exposureWarnPct}% of payroll</Badge>
                    )}
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div className="rounded-lg border border-emerald-200 dark:border-emerald-900 bg-emerald-50/50 dark:bg-emerald-950/30 p-2.5">
                      <p className="text-[10px] uppercase tracking-wide text-emerald-600/80">Will be included (APPROVED)</p>
                      <p className="text-lg font-bold tabular-nums text-emerald-700">{fmtMoney(be.approved.sum)}</p>
                      <p className="text-[10px] text-slate-500">{be.approved.count} bonus(es){be.commissionTotal > 0 ? ` · incl. commissions ${fmtMoney(be.commissionTotal)}` : ""}</p>
                      <p className="text-[10px] text-slate-400 mt-0.5">{Object.entries(be.approved.byType || {}).map(([t, v]: any) => `${titleCase(t)} ${fmtMoney(v.sum)}`).join(" · ")}</p>
                    </div>
                    <div className="rounded-lg border border-amber-200 dark:border-amber-900 bg-amber-50/50 dark:bg-amber-950/30 p-2.5">
                      <p className="text-[10px] uppercase tracking-wide text-amber-600/80">Will be MISSED (PENDING)</p>
                      <p className="text-lg font-bold tabular-nums text-amber-700">{fmtMoney(be.pending.sum)}</p>
                      <p className="text-[10px] text-slate-500">{be.pending.count} bonus(es) not yet approved — approve before calculating</p>
                      {be.pending.items?.length > 0 && (
                        <ul className="text-[10px] text-slate-400 mt-0.5 space-y-0.5">
                          {be.pending.items.slice(0, 4).map((it: any, i: number) => (
                            <li key={i} className="truncate">• {it.employeeName} — {titleCase(it.type)} {fmtMoney(it.amount)}</li>
                          ))}
                          {be.pending.count > 4 && <li>… +{be.pending.count - 4} more</li>}
                        </ul>
                      )}
                    </div>
                  </div>
                  {be.festivalPaidThisFy?.length > 0 && (
                    <p className="text-[11px] text-slate-500">
                      <AlertTriangle className="h-3 w-3 inline-block text-amber-500 mr-1" />
                      Festival bonus already paid this fiscal year: {be.festivalPaidThisFy.slice(0, 5).map((f: any) => `${f.employeeName} (${fmtMoney(f.sum)})`).join(", ")}{be.festivalPaidThisFy.length > 5 ? ` +${be.festivalPaidThisFy.length - 5} more` : ""}
                    </p>
                  )}
                  <p className="text-[10px] text-slate-400">
                    Payroll baseline (ready + warning employees): {fmtMoney(be.payrollGross)} · bonus exposure {be.exposurePct != null ? `${be.exposurePct}%` : "—"}
                  </p>
                </div>
              )
            })()}

            {(["warning", "blocked"] as const).map((section) => {
              const rows = data[section] || []
              if (!rows.length) return null
              const isOpen = expanded === section
              return (
                <div key={section} className="rounded-xl border border-slate-200 dark:border-slate-800">
                  <button className="w-full flex items-center justify-between gap-2 px-3 py-2.5 text-left" onClick={() => setExpanded(isOpen ? null : section)}>
                    <span className={`flex items-center gap-1.5 text-sm font-semibold ${section === "blocked" ? "text-rose-600" : "text-amber-600"}`}>
                      {section === "blocked" ? <Ban className="h-4 w-4" /> : <AlertTriangle className="h-4 w-4" />}
                      {section === "blocked" ? "Blocked" : "Warnings"} ({rows.length})
                    </span>
                    <ChevronRight className={`h-4 w-4 text-slate-400 transition-transform ${isOpen ? "rotate-90" : ""}`} />
                  </button>
                  {isOpen && (
                    <div className="divide-y divide-slate-100 dark:divide-slate-800 max-h-72 overflow-y-auto">
                      {rows.map((r: any) => (
                        <div key={r.employeeId} className="px-3 py-2.5">
                          <div className="flex items-center justify-between gap-2">
                            <div className="min-w-0">
                              <p className="text-sm font-medium truncate">{r.name}</p>
                              <p className="text-[11px] text-slate-400">{r.code}</p>
                            </div>
                            <Button size="sm" variant="ghost" className="h-7 text-xs shrink-0" onClick={() => { onOpenChange(false); navigate("employees", { employeeId: r.employeeId, tab: "profile" }) }}>
                              Resolve Issues
                            </Button>
                          </div>
                          <div className="flex flex-wrap gap-1 mt-1.5">
                            {[...(section === "blocked" ? r.reasons : r.warnings)].map((reason: string, i: number) => (
                              <span key={i} className={`text-[10px] rounded-full px-2 py-0.5 font-medium ${section === "blocked" ? "bg-rose-50 dark:bg-rose-950/50 text-rose-600 dark:text-rose-400" : "bg-amber-50 dark:bg-amber-950/50 text-amber-700 dark:text-amber-400"}`}>{reason}</span>
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )
            })}

            {can("payroll", "create") && (
              <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
                <p className="text-[11px] text-slate-400">
                  {c.blocked > 0
                    ? `Generating includes READY + WARNING employees only — ${c.blocked} blocked employee(s) are excluded and noted in the run summary.`
                    : "Every employee is ready — generation includes everyone."}
                </p>
                <Button size="sm" onClick={generate} disabled={genBusy} className="h-8 text-xs gap-1.5">
                  {genBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
                  Generate for Ready + Warnings{c.blocked > 0 ? " only" : ""}
                </Button>
              </div>
            )}
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}

// ================= 2026-10-14 — LOAN & ADVANCE RECOVERY CONTROL =================
// The control system under Payroll: (1) recovery policy switches — including
// the GUARANTOR FALLBACK (when a borrower has no payable salary in a period,
// the installment deducts from the agreed guarantor's salary, capped at a % of
// the guarantor's net); (2) the period recovery PLAN — every due installment,
// who pays it and the exact amount payroll will deduct at final approval;
// (3) per-guarantor exposure. Mirrors calculateRun's rules exactly.
function LoanAdvanceControlTab() {
  const { can } = useHrm()
  const settings = useHrm((s) => s.settings)
  const toast = useHrm((s) => s.toast)
  const [busy, setBusy] = useState(false)
  const [form, setForm] = useState<any>(null)
  const payroll = (settings as any)?.payroll
  const v = form ?? payroll
  const canEdit = can("settings", "edit")

  const [month, setMonth] = useState(new Date().getMonth() + 1)
  const [year, setYear] = useState(new Date().getFullYear())
  const { data: plan, loading, error, reload } = useApi<any>("payroll.recoveryPlan", { month, year })
  const rows: any[] = plan?.rows || []
  const exposure: any[] = plan?.guarantorExposure || []

  const save = async () => {
    setBusy(true)
    try {
      await useHrm.getState().saveSettingsGroup("payroll", {
        loanDeductionEnabled: !!v.loanDeductionEnabled,
        advanceDeductionEnabled: !!v.advanceDeductionEnabled,
        loanGuarantorFallback: !!v.loanGuarantorFallback,
        loanGuarantorMaxPct: Math.min(100, Math.max(1, Number(v.loanGuarantorMaxPct) || 25)),
      })
      toast("Recovery controls saved — applies to the next payroll calculation")
      setForm(null)
      reload()
    } catch (e: any) {
      toast(String(e?.message || e), "err")
    } finally {
      setBusy(false)
    }
  }

  const SOURCE_TONE: Record<string, string> = {
    EMPLOYEE: "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/60 dark:text-emerald-300",
    GUARANTOR: "border-violet-200 bg-violet-50 text-violet-700 dark:border-violet-900 dark:bg-violet-950/60 dark:text-violet-300",
    DEFERRED: "border-slate-200 bg-slate-100 text-slate-500 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-400",
  }

  const planColumns: Column<any>[] = [
    {
      key: "borrowerName", label: "Borrower", sortValue: (r) => r.borrowerName,
      render: (r) => (
        <div className="min-w-0">
          <p className="text-sm font-semibold text-slate-800 dark:text-slate-100 truncate">{r.borrowerName}</p>
          <p className="text-[11px] text-slate-500 dark:text-slate-400">{r.borrowerCode || "—"} · {r.kind === "ADVANCE" ? "Advance" : `Loan${r.installmentNo ? ` · installment #${r.installmentNo}` : ""}`}</p>
        </div>
      ),
    },
    { key: "dueDate", label: "Due", sortValue: (r) => r.dueDate || "", render: (r) => <span className="text-xs text-slate-500 tabular-nums">{fmtDate(r.dueDate)}</span> },
    { key: "dueAmount", label: "Due", align: "right", sortValue: (r) => r.dueAmount, render: (r) => <span className="text-xs tabular-nums text-slate-700 dark:text-slate-300">{fmtMoney(r.dueAmount)}</span> },
    {
      key: "presence", label: "Borrower Presence", sortValue: (r) => r.presence,
      render: (r) => <span className="text-[11px] text-slate-500 dark:text-slate-400">{r.presence || "—"}</span>,
    },
    {
      key: "guarantor", label: "Guarantor", sortValue: (r) => r.guarantorName || "",
      render: (r) => r.guarantorName
        ? <span className="text-xs text-slate-700 dark:text-slate-300">{r.guarantorName}{r.guarantorConsent && r.guarantorConsent !== "AGREED" ? <Badge variant="outline" className="ml-1.5 text-[9px] border-amber-300 text-amber-700 dark:text-amber-400">{titleCase(r.guarantorConsent)}</Badge> : null}</span>
        : <span className="text-xs text-slate-300 dark:text-slate-600">—</span>,
    },
    {
      key: "source", label: "Deducts From", sortValue: (r) => r.source,
      render: (r) => (
        <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold whitespace-nowrap ${SOURCE_TONE[r.source] || SOURCE_TONE.DEFERRED}`}>
          {r.source === "EMPLOYEE" ? <UserCheck className="h-3 w-3" /> : r.source === "GUARANTOR" ? <ShieldCheck className="h-3 w-3" /> : <Clock className="h-3 w-3" />}
          {r.source === "EMPLOYEE" ? "Employee salary" : r.source === "GUARANTOR" ? "Guarantor salary" : "Deferred"}
        </span>
      ),
    },
    { key: "plannedAmount", label: "This Period", align: "right", sortValue: (r) => r.plannedAmount, render: (r) => <span className={`text-xs font-semibold tabular-nums ${r.source === "GUARANTOR" ? "text-violet-700 dark:text-violet-400" : r.source === "EMPLOYEE" ? "text-emerald-700 dark:text-emerald-400" : "text-slate-400"}`}>{r.source === "DEFERRED" ? "—" : fmtMoney(r.plannedAmount)}</span> },
    {
      key: "note", label: "Note", sortValue: (r) => r.note || "",
      render: (r) => <span className="text-[11px] text-slate-500 dark:text-slate-400">{r.note || (r.source === "EMPLOYEE" ? "Deducts from the borrower's salary at final approval" : "")}</span>,
    },
  ]

  return (
    <div className="space-y-4">
      {/* ---- policy switches ---- */}
      <SectionCard title="Loan & Advance Recovery Controls" actions={
        canEdit ? <Button size="sm" disabled={busy || !form} onClick={save}>{busy ? "Saving…" : "Save Controls"}</Button> : undefined
      }>
        <div className="grid sm:grid-cols-2 gap-4 max-w-3xl">
          <label className="flex items-center justify-between rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-2.5 text-sm">
            <span>Loan installments <span className="text-slate-400 text-xs">deducted via payroll</span></span>
            <Switch disabled={!canEdit} checked={v ? !!v.loanDeductionEnabled : true} onCheckedChange={(x) => setForm({ ...v, loanDeductionEnabled: x })} />
          </label>
          <label className="flex items-center justify-between rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-2.5 text-sm">
            <span>Advance recovery <span className="text-slate-400 text-xs">deducted via payroll</span></span>
            <Switch disabled={!canEdit} checked={v ? !!v.advanceDeductionEnabled : true} onCheckedChange={(x) => setForm({ ...v, advanceDeductionEnabled: x })} />
          </label>
          <label className="flex items-center justify-between rounded-lg border border-violet-200 dark:border-violet-900 bg-violet-50/40 dark:bg-violet-950/20 px-3 py-2.5 text-sm">
            <span>Guarantor fallback <span className="text-slate-400 text-xs">borrower absent → guarantor pays</span></span>
            <Switch disabled={!canEdit} checked={v ? !!v.loanGuarantorFallback : true} onCheckedChange={(x) => setForm({ ...v, loanGuarantorFallback: x })} />
          </label>
          <div>
            <Label className="text-xs">Guarantor deduction cap (% of net pay)</Label>
            <Input type="number" min={1} max={100} disabled={!canEdit} value={v?.loanGuarantorMaxPct ?? 25}
              onChange={(e) => setForm({ ...v, loanGuarantorMaxPct: e.target.value })} className="text-sm" />
            <p className="text-[11px] text-slate-400 mt-1">
              A guarantor never loses more than this share of their net salary per period (cumulative across every loan they guarantee); the remainder of the installment is deferred.
            </p>
          </div>
        </div>
        <p className="text-xs text-slate-500 dark:text-slate-400 mt-3 flex items-start gap-1.5 max-w-3xl">
          <Info className="h-3.5 w-3.5 text-emerald-600 shrink-0 mt-0.5" />
          When a borrower has no payable salary in a period (absent the whole period, or off the payroll), their installment moves to the salary of the loan&apos;s agreed guarantor. Loans require the guarantor&apos;s consent in their self-service portal; advances are HR-designated. The deduction lands on the loan/advance ledger only at payroll FINAL APPROVAL — the calculation shows the exact amounts first.
        </p>
      </SectionCard>

      {/* ---- period recovery plan ---- */}
      <SectionCard title={`Recovery Plan — ${monthLabel(month)} ${year}`} actions={
        <div className="flex items-center gap-1.5">
          <Select value={String(month)} onValueChange={(x) => setMonth(Number(x))}>
            <SelectTrigger size="sm" className="h-8 w-[110px] text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>{MONTHS.map((m, i) => <SelectItem key={m} value={String(i + 1)}>{m}</SelectItem>)}</SelectContent>
          </Select>
          <Input type="number" value={year} onChange={(e) => setYear(Number(e.target.value) || year)} className="h-8 w-[80px] text-xs" aria-label="Year" />
          <Button size="sm" variant="outline" className="h-8 text-xs" onClick={() => reload()}><RefreshCcw className="h-3.5 w-3.5" /></Button>
        </div>
      }>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-3">
          <StatCard label="Planned Rows" value={plan?.totals?.rows ?? "—"} icon={Landmark} tone="slate" />
          <StatCard label="From Employee Salaries" value={fmtMoney(plan?.totals?.fromEmployee || 0)} icon={UserCheck} tone="emerald" />
          <StatCard label="From Guarantors" value={fmtMoney(plan?.totals?.fromGuarantor || 0)} icon={ShieldCheck} tone="violet" />
          <StatCard label="Deferred" value={plan?.totals?.deferred ?? "—"} icon={Clock} tone="amber" />
        </div>
        <DataTable
          columns={planColumns} rows={rows} loading={loading} error={error} pageSize={12} csvName={`loan-recovery-plan-${year}-${String(month).padStart(2, "0")}`}
          searchPlaceholder="Search borrower or guarantor…"
          emptyTitle="No due installments" emptyHint="Active loans with installments due this month and advances under recovery appear here."
        />
      </SectionCard>

      {/* ---- guarantor exposure ---- */}
      <SectionCard title="Guarantor Exposure">
        <p className="text-xs text-slate-500 dark:text-slate-400 -mt-1 mb-2">Total outstanding this guarantor is liable for across the loans and advances they guarantee</p>
        {exposure.length === 0 ? (
          <p className="text-xs text-slate-400 py-3 text-center">No guarantors are named on any active loan or recovering advance yet.</p>
        ) : (
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {exposure.map((g: any) => (
              <div key={g.guarantorId} className="rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-2.5">
                <div className="flex items-center justify-between gap-2 mb-1">
                  <p className="text-sm font-semibold text-slate-800 dark:text-slate-100 truncate">{g.guarantorName}</p>
                  <Coins className="h-4 w-4 text-violet-500 shrink-0" />
                </div>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  {g.loans} loan{g.loans !== 1 ? "s" : ""}{g.advances ? ` · ${g.advances} advance${g.advances !== 1 ? "s" : ""}` : ""} guaranteed
                </p>
                <p className="text-sm font-bold tabular-nums text-violet-700 dark:text-violet-400 mt-1">{fmtMoney(g.outstanding)} outstanding</p>
              </div>
            ))}
          </div>
        )}
      </SectionCard>
    </div>
  )
}

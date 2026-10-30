"use client"
// ============ Wave 2 WP-E — Accounting module view ============
// The tenant-side accounting workspace: manual Journal Vouchers (balanced to
// the paisa before they can be posted — H-9), the chart of accounts with the
// tenant's effective role mapping, per-account ledger with running balance,
// trial balance, balance sheet and the payroll-centric statement. The
// vouchers list composes the SAME AccountJournal rows the Payroll → Journals
// tab shows (accounting.vouchers.list re-queries them for ALL refTypes);
// voiding a voucher posts a REVERSAL — money history is never deleted.
//
// Wave 4 "Accounting Depth" adds: an optional cost-center tag on manual
// vouchers (select + list column + filter), a direct-method Cash Flow
// statement (reuses the shared TB/BS/IS print/export shell), accounting
// periods with a type-to-confirm close (soft lock enforced server-side),
// cost-center management and budgets with variance. Ten tabs now use the
// UI-R3 grouped SectionTabs pattern; flattened order is the canonical order:
// Vouchers · Chart · Trial Balance · Balance Sheet · Cash Flow · Ledger ·
// Income Statement · Periods · Cost Centers · Budgets.
import { useMemo, useState } from "react"
import {
  BookOpen, ShieldCheck, CalendarDays, FilePenLine, Plus, Trash2, Scale,
  AlertTriangle, Ban, Info, Landmark, ArrowLeftRight, Settings2, Send, CheckCircle2, XCircle, Hourglass,
  Wallet, Lock, LockOpen, Target,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { useHrm } from "../store"
import { useApi, rpc } from "../api"
import { ACCOUNTS } from "../accounting-chart"
import {
  PageHeader, StatCard, SectionCard, SectionTabs, ErrorBanner, LoadingRows,
  FieldError, fmtMoney, fmtDate, fmtDateTime,
  type SectionTabGroup, todayDhaka,
} from "../shared/ui-kit"
import { DataTable, type Column } from "../shared/data-table"
import { ConfirmDialog, FormDialog, type FieldDef } from "../shared/form-dialog"
import {
  ExportAsMenu, ReportPrintModal, exportFileCsv,
  type PrintPayload, type ReportCompany,
} from "../shared/report-print"

const today = () => todayDhaka()
const round2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100
/** Wave 3 WP-B — chip tone per voucher workflow status (shared by list + dialog). */
const voucherStatusTone = (s: string) =>
  s === "POSTED" ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300"
  : s === "PENDING_APPROVAL" ? "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300"
  : s === "DRAFT" ? "bg-slate-200 text-slate-600 dark:bg-slate-800 dark:text-slate-300"
  : "bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300"
const voucherStatusLabel = (s: string) => (s === "PENDING_APPROVAL" ? "PENDING" : s)
/** Signed ledger balance → "1,234.00 Dr" / "1,234.00 Cr" (debit-positive). */
const fmtDrCr = (n: number) => {
  const v = round2(n)
  if (v === 0) return "0.00"
  return v > 0 ? `${fmtMoney(v)} Dr` : `${fmtMoney(-v)} Cr`
}
const ACCOUNT_OPTIONS = Object.entries(ACCOUNTS).map(([code, name]) => ({ value: code, label: `${code} — ${name}` }))
const ACCOUNT_GROUPS = [
  { key: "ASSETS", label: "Assets", codes: Object.keys(ACCOUNTS).filter((c) => c.startsWith("1")) },
  { key: "LIABILITIES", label: "Liabilities", codes: Object.keys(ACCOUNTS).filter((c) => c.startsWith("2")) },
  { key: "EXPENSES", label: "Expenses", codes: Object.keys(ACCOUNTS).filter((c) => c.startsWith("5") || c.startsWith("6")) },
]
const MAX_LINES = 30
/** Default role → code chart, shown on remapped chips ("↺" = tenant override). */
const DEFAULT_LABELS: Record<string, string> = {
  salaryExpense: "5100", otExpense: "5110", bonusExpense: "5120", pfEmployerExpense: "5150",
  aitPayable: "2105", pfPayable: "2150", salariesPayable: "2100", loanReceivable: "1150",
  advances: "1155", deductionsRecovered: "5290", bank: "1200", cash: "1010", mfs: "1210",
}

export default function AccountingView() {
  const { data: stats, loading: statsLoading, reload: reloadStats } = useApi<any>("accounting.stats", {})
  // Wave 3 WP-E/F — company identity for the shared statement print shell
  const { data: settingsData } = useApi<any>("settings.get")
  const company: ReportCompany = (settingsData?.general || {}) as ReportCompany
  const presetTab = useHrm((s) => (s.view?.key === "accounting" && (s.view?.params as any)?.tab) || undefined)

  // Wave 4 — ten tabs now use the UI-R3 two-level SectionTabs pattern. The
  // FLATTENED order across groups is the canonical tab order (deep links via
  // ?tab=<value> keep working — group membership is derived from the flat list).
  const groups: SectionTabGroup[] = [
    { label: "Vouchers & Chart", tabs: [
      { value: "vouchers", label: "Vouchers", content: <VouchersTab onPosted={() => { reloadStats() }} /> },
      { value: "coa", label: "Chart of Accounts", content: <CoaTab /> },
    ] },
    { label: "Statements", tabs: [
      { value: "trialBalance", label: "Trial Balance", content: <TrialBalanceTab company={company} /> },
      // Wave 3 WP-F — Balance Sheet sits right after Trial Balance
      { value: "balanceSheet", label: "Balance Sheet", content: <BalanceSheetTab company={company} /> },
      { value: "cashFlow", label: "Cash Flow", content: <CashFlowTab company={company} /> },
      { value: "ledger", label: "Ledger", content: <LedgerTab /> },
      { value: "incomeStatement", label: "Income Statement", content: <IncomeStatementTab company={company} /> },
    ] },
    { label: "Controls & Budgets", tabs: [
      { value: "periods", label: "Periods", content: <PeriodsTab /> },
      { value: "costCenters", label: "Cost Centers", content: <CostCentersTab /> },
      { value: "budgets", label: "Budgets", content: <BudgetsTab /> },
    ] },
  ]

  return (
    <div className="space-y-4">
      <PageHeader
        title="Accounting"
        subtitle="Journal vouchers, statements and period controls — every entry balances to the paisa (H-9), money history is never deleted, and closed periods lock new manual writes"
      />
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard label="Total Journals" value={statsLoading ? "…" : (stats?.total ?? 0)} sub="postings from every source" icon={BookOpen} tone="slate" />
        <StatCard
          label="Unbalanced Entries"
          value={statsLoading ? "…" : (stats?.unbalanced ?? 0)}
          sub={(stats?.unbalanced ?? 0) > 0 ? "H-9 invariant violated — contact support" : "balanced to the paisa at post time (H-9)"}
          icon={ShieldCheck}
          tone={(stats?.unbalanced ?? 0) > 0 ? "rose" : "emerald"}
        />
        <StatCard
          label="This Month"
          value={statsLoading ? "…" : (stats?.thisMonth ?? 0)}
          sub={stats ? `৳${(stats.thisMonthAmount ?? 0).toLocaleString("en-IN", { maximumFractionDigits: 0 })} posted` : undefined}
          icon={CalendarDays}
          tone="teal"
        />
        <StatCard label="Manual Vouchers" value={statsLoading ? "…" : (stats?.manualVouchers ?? 0)} sub="JOURNAL_VOUCHER entries" icon={FilePenLine} tone="amber" />
      </div>
      <SectionTabs defaultValue={presetTab as string | undefined} groups={groups} />
    </div>
  )
}

// ================= VOUCHERS — manual entry + full journal list =================
function VouchersTab({ onPosted }: { onPosted: () => void }) {
  const { can } = useHrm()
  const toast = useHrm((s) => s.toast)
  const canCreate = can("accounting", "create")
  const canVoid = can("accounting", "delete")
  // Wave 3 WP-B — approval workflow permission + queue state
  const canApprove = can("accounting", "approve")

  // ---- Wave 4 — cost centers (optional tag on manual vouchers) ----
  const { data: ccData } = useApi<any>("accounting.costCenters.list", {})
  const costCenters: any[] = ccData?.costCenters || []
  const ccLabel = (id?: string | null) => {
    const c = id ? costCenters.find((x: any) => x.id === id) : null
    return c ? `${c.code} — ${c.name}` : null
  }

  // ---- manual voucher entry state ----
  const [date, setDate] = useState(today())
  const [memo, setMemo] = useState("")
  const [note, setNote] = useState("")
  const [costCenterId, setCostCenterId] = useState("") // Wave 4 — optional tag
  const [lines, setLines] = useState<{ account: string; debit: string; credit: string }[]>([
    { account: "", debit: "", credit: "" },
    { account: "", debit: "", credit: "" },
  ])
  const [busy, setBusy] = useState(false)
  const [editingDraft, setEditingDraft] = useState<any>(null) // Wave 3 — DRAFT row loaded into the form

  // ---- list state (server-paginated) ----
  const [refType, setRefType] = useState("")
  const [statusFilter, setStatusFilter] = useState("") // Wave 3 — workflow filter
  const [ccFilter, setCcFilter] = useState("") // Wave 4 — cost-center filter
  const [from, setFrom] = useState("")
  const [to, setTo] = useState("")
  const [page, setPage] = useState(1)
  const [detail, setDetail] = useState<any>(null)
  const [voiding, setVoiding] = useState<any>(null)
  const [rejecting, setRejecting] = useState<any>(null) // Wave 3 — PENDING voucher being rejected
  const PAGE = 50
  const payload = {
    ...(refType ? { refType } : {}),
    ...(statusFilter ? { status: statusFilter } : {}),
    ...(ccFilter ? { costCenterId: ccFilter } : {}),
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
    limit: PAGE, offset: (page - 1) * PAGE,
  }
  const { data, loading, error, reload } = useApi<any>("accounting.vouchers.list", payload)
  const journals = data?.journals || []
  const total = data?.total || 0
  const refTypes: string[] = data?.refTypes || []
  const statusCounts: Record<string, number> = data?.statusCounts || {}

  // ---- live Dr/Cr totals (the H-9 gate, mirrored client-side) ----
  const sumDr = round2(lines.reduce((s, l) => s + (Number(l.debit) || 0), 0))
  const sumCr = round2(lines.reduce((s, l) => s + (Number(l.credit) || 0), 0))
  const diff = round2(sumDr - sumCr)
  const balanced = diff === 0 && sumDr > 0
  const accountMissing = lines.some((l) => !l.account)
  const bothSides = lines.some((l) => l.debit !== "" && l.credit !== "")
  const emptyAmount = lines.some((l) => l.debit === "" && l.credit === "")
  const canPost = canCreate && !busy && balanced && !accountMissing && !bothSides && !emptyAmount
    && !!date && memo.trim().length >= 3 && lines.length >= 2

  const setLine = (i: number, patch: Partial<{ account: string; debit: string; credit: string }>) =>
    setLines((ls) => ls.map((l, idx) => (idx === i ? { ...l, ...patch } : l)))
  const addLine = () => setLines((ls) => (ls.length >= MAX_LINES ? ls : [...ls, { account: "", debit: "", credit: "" }]))
  const removeLine = (i: number) => setLines((ls) => (ls.length <= 2 ? ls : ls.filter((_, idx) => idx !== i)))

  const resetForm = () => {
    setMemo(""); setNote(""); setCostCenterId(""); setEditingDraft(null)
    setLines([{ account: "", debit: "", credit: "" }, { account: "", debit: "", credit: "" }])
  }

  /** Load a DRAFT row into the entry form for editing. */
  const startEditDraft = (row: any) => {
    setEditingDraft(row)
    setDate(row.date || today())
    setMemo(row.memo || "")
    setNote("")
    setCostCenterId(row.costCenterId || "")
    setLines((row.lines || []).map((l: any) => ({
      account: l.account || "",
      debit: l.debit != null ? String(l.debit) : "",
      credit: l.credit != null ? String(l.credit) : "",
    })))
  }

  /** effective lines (blank amounts dropped, 2dp) — shared by post/save/submit */
  const effectiveLines = () => lines
    .map((l) => ({
      account: l.account,
      debit: l.debit === "" ? undefined : round2(Number(l.debit)),
      credit: l.credit === "" ? undefined : round2(Number(l.credit)),
    }))
    .filter((l) => l.debit != null || l.credit != null)

  // ---- Wave 3 WP-B: save-draft / submit / approve / reject ----
  const saveDraft = async () => {
    setBusy(true)
    try {
      const res = await rpc<any>("accounting.voucher.save", {
        ...(editingDraft ? { id: editingDraft.id } : {}),
        date, memo: memo.trim(), note: note.trim() || undefined,
        ...(costCenterId ? { costCenterId } : {}),
        lines: effectiveLines(),
      })
      toast(`Draft saved — ৳${(res.amount ?? 0).toLocaleString("en-IN")} · #${res.journalId.slice(0, 8)}`)
      resetForm()
      reload()
      onPosted()
    } catch (e: any) { toast(e.message, "err") } finally { setBusy(false) }
  }

  const submitDraft = async () => {
    setBusy(true)
    try {
      // save (create or update) THEN submit — the submit RPC re-validates H-9
      const saved = await rpc<any>("accounting.voucher.save", {
        ...(editingDraft ? { id: editingDraft.id } : {}),
        date, memo: memo.trim(), note: note.trim() || undefined,
        ...(costCenterId ? { costCenterId } : {}),
        lines: effectiveLines(),
      })
      await rpc<any>("accounting.voucher.submit", { id: saved.journalId })
      toast("Voucher submitted for approval")
      resetForm()
      reload()
      onPosted()
    } catch (e: any) { toast(e.message, "err") } finally { setBusy(false) }
  }

  const submitExisting = async (row: any) => {
    try {
      await rpc<any>("accounting.voucher.submit", { id: row.id })
      toast("Voucher submitted for approval")
      reload()
      onPosted()
      setDetail(null)
    } catch (e: any) { toast(e.message, "err") }
  }

  const approveVoucher = async (row: any) => {
    try {
      const res = await rpc<any>("accounting.voucher.approve", { id: row.id })
      toast(`Voucher approved and posted — ৳${(res.amount ?? 0).toLocaleString("en-IN")}`)
      reload()
      onPosted()
      setDetail(null)
    } catch (e: any) { toast(e.message, "err") }
  }

  const rejectVoucher = async (reason?: string) => {
    if (!rejecting) return
    try {
      await rpc<any>("accounting.voucher.reject", { id: rejecting.id, reason: reason || "" })
      toast("Voucher rejected — the requester can edit the draft and resubmit")
      setRejecting(null)
      reload()
      onPosted()
      setDetail(null)
    } catch (e: any) { toast(e.message, "err") }
  }

  const post = async () => {
    // drop fully-blank amount lines; round to 2dp; server re-validates + balances anyway
    const eff = effectiveLines()
    setBusy(true)
    try {
      const res = await rpc<any>("accounting.voucher.post", {
        date, memo: memo.trim(), note: note.trim() || undefined,
        ...(costCenterId ? { costCenterId } : {}),
        lines: eff,
      })
      toast(`Journal voucher posted — ৳${(res.amount ?? 0).toLocaleString("en-IN")} · #${res.journalId.slice(0, 8)}`)
      resetForm()
      reload()
      onPosted()
    } catch (e: any) { toast(e.message, "err") } finally { setBusy(false) }
  }

  const voidVoucher = async (reason?: string) => {
    if (!voiding) return
    try {
      const res = await rpc<any>("accounting.journal.delete", { id: voiding.id, reason: reason || "" })
      toast(res?.alreadyVoided ? "This voucher was already voided — no change" : `Voucher voided — reversal #${(res?.reversalJournalId || "").slice(0, 8)} posted`)
      reload()
      onPosted()
      setDetail(null)
    } catch (e: any) { toast(e.message, "err") }
  }

  const columns: Column<any>[] = [
    { key: "date", label: "Date", sortValue: (r) => r.date, render: (r) => <span className="text-xs tabular-nums">{fmtDate(r.date)}</span> },
    { key: "refType", label: "Type", render: (r) => (
      <Badge variant="outline" className="text-[10px]">{r.refType === "JOURNAL_VOUCHER" ? "JOURNAL VOUCHER" : r.refType}</Badge>
    ) },
    // Wave 3 WP-B — workflow status chips (system journals are always POSTED)
    { key: "status", label: "Status", render: (r) => (
      <Badge variant="secondary" className={`text-[9px] ${voucherStatusTone(r.status || "POSTED")}`}>{voucherStatusLabel(r.status || "POSTED")}</Badge>
    ) },
    { key: "source", label: "Source", render: (r) => (
      <Badge variant="secondary" className={r.source === "MANUAL" ? "text-[9px] bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300" : "text-[9px] bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300"}>{r.source || "HRM"}</Badge>
    ) },
    { key: "memo", label: "Memo", render: (r) => <span className="text-xs line-clamp-1 max-w-80 inline-block align-middle" title={r.memo}>{r.memo}</span> },
    // Wave 4 — cost-center tag (manual vouchers; system journals show —)
    { key: "costCenter", label: "Cost Center", render: (r) => {
      const label = ccLabel(r.costCenterId)
      return label ? <Badge variant="outline" className="text-[10px]">{label}</Badge> : <span className="text-xs text-slate-400">—</span>
    } },
    { key: "amount", label: "Amount", align: "right", sortValue: (r) => r.amount, render: (r) => <span className="text-sm font-semibold tabular-nums">{fmtMoney(r.amount)}</span> },
    { key: "lines", label: "Lines", align: "center", render: (r) => <span className="text-xs text-slate-400">{(r.lines || []).length}</span> },
    { key: "actions", label: "", align: "right", render: (r) => (
      <div className="flex items-center justify-end gap-1">
        <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setDetail(r)}>View</Button>
        {/* Wave 3 WP-B — workflow actions on manual vouchers */}
        {canCreate && r.refType === "JOURNAL_VOUCHER" && r.status === "DRAFT" && (
          <>
            <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => startEditDraft(r)} title="Load this draft into the entry form">Edit</Button>
            <Button size="sm" variant="ghost" className="h-7 text-xs text-sky-600 hover:text-sky-700 hover:bg-sky-500/10" onClick={() => submitExisting(r)} title="Send to an approver">
              <Send className="h-3 w-3" aria-hidden="true" /> Submit
            </Button>
          </>
        )}
        {canApprove && r.refType === "JOURNAL_VOUCHER" && r.status === "PENDING_APPROVAL" && (
          <>
            <Button size="sm" variant="ghost" className="h-7 text-xs text-emerald-600 hover:text-emerald-700 hover:bg-emerald-500/10" onClick={() => approveVoucher(r)} title="Approve and post to the ledger">
              <CheckCircle2 className="h-3 w-3" aria-hidden="true" /> Approve
            </Button>
            <Button size="sm" variant="ghost" className="h-7 text-xs text-rose-600 hover:text-rose-700 hover:bg-rose-500/10" onClick={() => setRejecting(r)} title="Reject with a reason">
              <XCircle className="h-3 w-3" aria-hidden="true" /> Reject
            </Button>
          </>
        )}
        {canVoid && r.refType === "JOURNAL_VOUCHER" && (r.status || "POSTED") === "POSTED" && (
          <Button size="sm" variant="ghost" className="h-7 text-xs text-rose-600 hover:text-rose-700 hover:bg-rose-500/10" onClick={() => setVoiding(r)} title="Post a reversal voucher — the original is kept">
            <Ban className="h-3 w-3" aria-hidden="true" /> Void
          </Button>
        )}
      </div>
    ) },
  ]

  return (
    <div className="space-y-4">
      {canCreate && (
        <SectionCard
          title={editingDraft ? `Edit Draft Voucher — #${editingDraft.id.slice(0, 8)}` : "New Journal Voucher"}
          actions={
            <div className="flex items-center gap-2">
              {/* Wave 3 WP-B — the approval workflow entry points */}
              <Button size="sm" variant="outline" className="h-8 text-xs" onClick={saveDraft} disabled={!canPost}>
                <FilePenLine className="h-3.5 w-3.5 mr-1" aria-hidden="true" />
                {editingDraft ? "Update Draft" : "Save Draft"}
              </Button>
              <Button size="sm" variant="outline" className="h-8 text-xs" onClick={submitDraft} disabled={!canPost}>
                <Send className="h-3.5 w-3.5 mr-1" aria-hidden="true" /> Submit for Approval
              </Button>
              <Button size="sm" className="h-8 text-xs" onClick={post} disabled={!canPost}>
                <CheckCircle2 className="h-3.5 w-3.5 mr-1" aria-hidden="true" />
                {busy ? "Posting…" : "Post Directly"}
              </Button>
              {editingDraft && (
                <Button size="sm" variant="ghost" className="h-8 text-xs text-slate-500" onClick={resetForm}>Cancel edit</Button>
              )}
            </div>
          }
        >
          <p className="text-xs text-slate-500 mb-3">
            Debits and credits must balance to the paisa (H-9 — enforced again server-side at every step).
            <b> Save Draft</b> parks a balanced voucher for later, <b>Submit for Approval</b> sends it to an approver
            with <b>accounting.approve</b>, and <b>Post Directly</b> posts to the ledger at once (the classic path).
            Manual vouchers never touch payroll: system journals remain immutable.
          </p>
          <div className="grid gap-2 sm:grid-cols-[150px_minmax(0,1fr)_minmax(0,1fr)] mb-2">
            <div className="space-y-1">
              <Label htmlFor="jv-date" className="text-[11px] font-medium text-slate-500">Voucher date</Label>
              <Input id="jv-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} className="h-9 text-sm" />
            </div>
            <div className="space-y-1">
              <Label htmlFor="jv-memo" className="text-[11px] font-medium text-slate-500">Memo <span className="text-rose-500">*</span></Label>
              <Input id="jv-memo" value={memo} onChange={(e) => setMemo(e.target.value)} placeholder="e.g. Office rent adjustment — April" maxLength={500} className="h-9 text-sm" />
            </div>
            <div className="space-y-1">
              <Label htmlFor="jv-note" className="text-[11px] font-medium text-slate-500">Note (optional)</Label>
              <Input id="jv-note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="appended to the memo" maxLength={500} className="h-9 text-sm" />
            </div>
          </div>

          {/* Wave 4 — optional cost-center tag (only centers the vendor defined;
              the server validates the id against the vendor's list) */}
          <div className="mb-3 max-w-xs">
            <Label className="text-[11px] font-medium text-slate-500">Cost center (optional)</Label>
            <Select value={costCenterId || "none"} onValueChange={(v) => setCostCenterId(v === "none" ? "" : v)}>
              <SelectTrigger className="h-9 text-sm" aria-label="Voucher cost center"><SelectValue placeholder="— none —" /></SelectTrigger>
              <SelectContent className="max-h-64">
                <SelectItem value="none" className="text-xs">— None —</SelectItem>
                {costCenters.filter((c: any) => c.active !== false).map((c: any) => (
                  <SelectItem key={c.id} value={c.id} className="text-xs">{c.code} — {c.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-[10px] text-slate-400 mt-1">Tag the voucher for cost-center reporting — manage the list on the Cost Centers tab.</p>
          </div>

          <div className="hidden sm:grid grid-cols-[minmax(0,1fr)_110px_110px_36px] gap-2 px-0.5 mb-1 text-[10px] font-semibold uppercase tracking-wide text-slate-400">
            <span>Account</span>
            <span className="text-right">Debit (৳)</span>
            <span className="text-right">Credit (৳)</span>
            <span className="sr-only">Remove</span>
          </div>
          <div className="space-y-2">
            {lines.map((l, i) => (
              <div key={i} className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_110px_110px_36px] sm:items-center">
                <div className="flex items-center gap-2">
                  <Select value={l.account || "none"} onValueChange={(v) => setLine(i, { account: v === "none" ? "" : v })}>
                    <SelectTrigger className="flex-1 h-9 text-xs" aria-label={`Line ${i + 1} account`}><SelectValue placeholder="Select account…" /></SelectTrigger>
                    <SelectContent className="max-h-64">{ACCOUNT_OPTIONS.map((o) => (
                      <SelectItem key={o.value} value={o.value} className="text-xs">{o.label}</SelectItem>
                    ))}</SelectContent>
                  </Select>
                  <Button variant="ghost" size="icon" className="h-9 w-9 shrink-0 sm:hidden" onClick={() => removeLine(i)} disabled={lines.length <= 2} aria-label={`Remove line ${i + 1}`}>
                    <Trash2 className="h-3.5 w-3.5 text-slate-400" aria-hidden="true" />
                  </Button>
                </div>
                <div className="grid grid-cols-2 gap-2 sm:contents">
                  <Input
                    type="number" min={0} step="0.01" inputMode="decimal" aria-label={`Line ${i + 1} debit`}
                    value={l.debit} onChange={(e) => setLine(i, { debit: e.target.value, ...(e.target.value !== "" ? { credit: "" } : {}) })}
                    placeholder="—" disabled={l.credit !== ""}
                    className="h-9 text-right tabular-nums text-sm disabled:opacity-40"
                  />
                  <Input
                    type="number" min={0} step="0.01" inputMode="decimal" aria-label={`Line ${i + 1} credit`}
                    value={l.credit} onChange={(e) => setLine(i, { credit: e.target.value, ...(e.target.value !== "" ? { debit: "" } : {}) })}
                    placeholder="—" disabled={l.debit !== ""}
                    className="h-9 text-right tabular-nums text-sm disabled:opacity-40"
                  />
                </div>
                <Button variant="ghost" size="icon" className="hidden sm:inline-flex h-9 w-9" onClick={() => removeLine(i)} disabled={lines.length <= 2} aria-label={`Remove line ${i + 1}`}>
                  <Trash2 className="h-3.5 w-3.5 text-slate-400" aria-hidden="true" />
                </Button>
              </div>
            ))}
          </div>
          <div className="mt-2">
            <Button size="sm" variant="outline" className="h-8 text-xs" onClick={addLine} disabled={lines.length >= MAX_LINES} title={lines.length >= MAX_LINES ? `A voucher carries at most ${MAX_LINES} lines` : undefined}>
              <Plus className="h-3.5 w-3.5 mr-1" aria-hidden="true" /> Add Line
            </Button>
          </div>

          <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-lg border bg-muted/30 px-3 py-2">
            <div className="flex flex-wrap gap-4 text-xs text-slate-500">
              <span>Debit total <b className="tabular-nums text-slate-800 dark:text-slate-100">{fmtMoney(sumDr)}</b></span>
              <span>Credit total <b className="tabular-nums text-slate-800 dark:text-slate-100">{fmtMoney(sumCr)}</b></span>
            </div>
            {balanced ? (
              <span className="flex items-center gap-1 text-xs font-medium text-emerald-600 dark:text-emerald-400">
                <Scale className="h-3.5 w-3.5" aria-hidden="true" /> Balanced to the paisa
              </span>
            ) : sumDr === 0 && sumCr === 0 ? (
              <span className="flex items-center gap-1 text-xs text-slate-400"><Info className="h-3.5 w-3.5" aria-hidden="true" /> Enter amounts on both sides</span>
            ) : (
              <span className="flex items-center gap-1 text-xs font-medium text-rose-600 dark:text-rose-400">
                <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" /> Out of balance by {fmtMoney(Math.abs(diff))}
              </span>
            )}
          </div>
          {(accountMissing || bothSides || emptyAmount) && (
            <p className="mt-2 text-[11px] text-amber-600 dark:text-amber-400">
              {accountMissing && "Every line needs an account. "}
              {bothSides && "A line posts to ONE side only — debit or credit, not both. "}
              {emptyAmount && "Every line needs a debit or a credit amount."}
            </p>
          )}
        </SectionCard>
      )}

      {/* Wave 3 WP-B — "Pending my approval" queue for approvers */}
      {canApprove && (statusCounts.PENDING_APPROVAL || 0) > 0 && statusFilter !== "PENDING_APPROVAL" && (
        <SectionCard title="Pending My Approval" actions={<Badge className="bg-amber-100 text-amber-700 text-[10px]">{statusCounts.PENDING_APPROVAL} awaiting</Badge>}>
          <div className="space-y-2">
            {journals.filter((j: any) => j.status === "PENDING_APPROVAL").slice(0, 5).map((j: any) => (
              <div key={j.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-amber-200 dark:border-amber-900 bg-amber-50/60 dark:bg-amber-950/20 px-3 py-2">
                <Hourglass className="h-4 w-4 shrink-0 text-amber-600" aria-hidden="true" />
                <span className="text-xs tabular-nums text-slate-500">{fmtDate(j.date)}</span>
                <span className="min-w-0 flex-1 truncate text-xs font-medium text-slate-700 dark:text-slate-200" title={j.memo}>{j.memo}</span>
                <span className="text-sm font-semibold tabular-nums">{fmtMoney(j.amount)}</span>
                <div className="flex items-center gap-1">
                  <Button size="sm" variant="ghost" className="h-7 text-xs text-emerald-600 hover:text-emerald-700 hover:bg-emerald-500/10" onClick={() => approveVoucher(j)}>
                    <CheckCircle2 className="h-3 w-3" aria-hidden="true" /> Approve
                  </Button>
                  <Button size="sm" variant="ghost" className="h-7 text-xs text-rose-600 hover:text-rose-700 hover:bg-rose-500/10" onClick={() => setRejecting(j)}>
                    <XCircle className="h-3 w-3" aria-hidden="true" /> Reject
                  </Button>
                </div>
              </div>
            ))}
            {(statusCounts.PENDING_APPROVAL || 0) > 5 && (
              <Button size="sm" variant="ghost" className="h-7 text-xs text-slate-500" onClick={() => { setStatusFilter("PENDING_APPROVAL"); setPage(1) }}>
                View all {statusCounts.PENDING_APPROVAL} pending →
              </Button>
            )}
          </div>
        </SectionCard>
      )}

      <SectionCard title="All Journal Postings" actions={
        <span className="text-xs text-slate-400">{total.toLocaleString()} journal{total !== 1 ? "s" : ""}</span>
      }>
        <div className="flex flex-wrap items-center gap-2 mb-3">
          {/* Wave 3 WP-B — workflow status chips (click to filter) */}
          <div className="flex flex-wrap items-center gap-1.5">
            {(["ALL", "DRAFT", "PENDING_APPROVAL", "POSTED", "REJECTED"] as const).map((s) => {
              const n = s === "ALL" ? undefined : statusCounts[s] || 0
              const on = s === "ALL" ? !statusFilter : statusFilter === s
              if (s !== "ALL" && !n) return null
              return (
                <button key={s} onClick={() => { setStatusFilter(s === "ALL" ? "" : s); setPage(1) }}
                  className={`rounded-full px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide transition-colors ${on ? "bg-emerald-600 text-white" : "bg-slate-100 dark:bg-slate-800 text-slate-500 hover:bg-slate-200 dark:hover:bg-slate-700"}`}>
                  {s === "ALL" ? "All" : s === "PENDING_APPROVAL" ? "Pending" : s}{n != null ? ` ${n}` : ""}
                </button>
              )
            })}
          </div>
          <Select value={refType || "all"} onValueChange={(v) => { setRefType(v === "all" ? "" : v); setPage(1) }}>
            <SelectTrigger className="w-44 h-8 text-sm" aria-label="Filter by type"><SelectValue placeholder="All types" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All types</SelectItem>
              {refTypes.map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}
            </SelectContent>
          </Select>
          {/* Wave 4 — cost-center filter (manual vouchers carry the tag) */}
          <Select value={ccFilter || "all"} onValueChange={(v) => { setCcFilter(v === "all" ? "" : v); setPage(1) }}>
            <SelectTrigger className="w-48 h-8 text-sm" aria-label="Filter by cost center"><SelectValue placeholder="All cost centers" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All cost centers</SelectItem>
              {costCenters.map((c: any) => (
                <SelectItem key={c.id} value={c.id}>{c.code} — {c.name}{c.active === false ? " (inactive)" : ""}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <input type="date" value={from} onChange={(e) => { setFrom(e.target.value); setPage(1) }} className="h-8 rounded-md border border-slate-200 dark:border-slate-700 bg-transparent px-2 text-sm" title="From date" aria-label="From date" />
          <span className="text-xs text-slate-400" aria-hidden="true">→</span>
          <input type="date" value={to} onChange={(e) => { setTo(e.target.value); setPage(1) }} className="h-8 rounded-md border border-slate-200 dark:border-slate-700 bg-transparent px-2 text-sm" title="To date" aria-label="To date" />
          {(refType || from || to || statusFilter || ccFilter) && (
            <Button size="sm" variant="ghost" className="h-8" onClick={() => { setRefType(""); setFrom(""); setTo(""); setStatusFilter(""); setCcFilter(""); setPage(1) }}>Clear</Button>
          )}
        </div>
        {error && <ErrorBanner message={error} />}
        <DataTable
          columns={columns} rows={journals} loading={loading} error={error} searchable={false} pageSize={PAGE} dense
          emptyTitle="No journals match these filters"
          emptyHint="Journals post automatically when payroll runs are paid, payouts confirmed or runs cancelled. Manual vouchers you post appear here too."
          onRowClick={(r) => setDetail(r)}
        />
        {total > PAGE && (
          <div className="flex items-center justify-between mt-3">
            <Button size="sm" variant="outline" className="h-8 text-xs" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Previous</Button>
            <span className="text-xs text-slate-400">Page {page} of {Math.ceil(total / PAGE)}</span>
            <Button size="sm" variant="outline" className="h-8 text-xs" disabled={page * PAGE >= total} onClick={() => setPage((p) => p + 1)}>Next</Button>
          </div>
        )}
      </SectionCard>

      {/* line drill-down — same layout as the Payroll view's Journals tab */}
      <Dialog open={!!detail} onOpenChange={(v) => { if (!v) setDetail(null) }}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle className="text-base flex items-center gap-2">
              <Badge variant="outline">{detail?.refType}</Badge>
              <span className="text-xs text-slate-400 font-normal">{detail?.id}</span>
            </DialogTitle>
            <p className="text-xs text-slate-500">{detail?.memo}</p>
          </DialogHeader>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs py-1">
            <div><span className="text-slate-400">Date: </span><span className="tabular-nums">{fmtDate(detail?.date)}</span></div>
            <div><span className="text-slate-400">Amount: </span><span className="font-semibold tabular-nums">{fmtMoney(detail?.amount)}</span></div>
            <div><span className="text-slate-400">Source: </span>{detail?.source || "HRM"}</div>
            <div><span className="text-slate-400">Cost Center: </span>{ccLabel(detail?.costCenterId) || <span className="text-slate-400">—</span>}</div>
          </div>
          {/* Wave 3 WP-B — workflow info in the drill-down */}
          {detail?.refType === "JOURNAL_VOUCHER" && (
            <div className="rounded-lg border bg-muted/30 px-3 py-2 text-xs space-y-1">
              <div className="flex items-center gap-2">
                <span className="text-slate-400">Status:</span>
                <Badge variant="secondary" className={`text-[9px] ${voucherStatusTone(detail?.status || "POSTED")}`}>
                  {voucherStatusLabel(detail?.status || "POSTED")}
                </Badge>
                {detail?.approvedByName && <span className="text-slate-400">by {detail.approvedByName}{detail.approvedAt ? ` · ${fmtDate(String(detail.approvedAt))}` : ""}</span>}
              </div>
              {detail?.rejectionReason && <p className="text-rose-600 dark:text-rose-400">Rejection reason: {detail.rejectionReason}</p>}
            </div>
          )}
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
          <DialogFooter className="gap-1.5 sm:gap-2">
            {canCreate && detail?.refType === "JOURNAL_VOUCHER" && detail?.status === "DRAFT" && (
              <>
                <Button size="sm" variant="outline" className="h-8 text-xs" onClick={() => { startEditDraft(detail); setDetail(null) }}>Edit Draft</Button>
                <Button size="sm" variant="outline" className="h-8 text-xs text-sky-600 hover:text-sky-700" onClick={() => submitExisting(detail)}>
                  <Send className="h-3.5 w-3.5 mr-1" aria-hidden="true" /> Submit for Approval
                </Button>
              </>
            )}
            {canApprove && detail?.refType === "JOURNAL_VOUCHER" && detail?.status === "PENDING_APPROVAL" && (
              <>
                <Button size="sm" className="h-8 text-xs" onClick={() => approveVoucher(detail)}>
                  <CheckCircle2 className="h-3.5 w-3.5 mr-1" aria-hidden="true" /> Approve & Post
                </Button>
                <Button size="sm" variant="outline" className="h-8 text-xs text-rose-600 hover:text-rose-700" onClick={() => setRejecting(detail)}>
                  <XCircle className="h-3.5 w-3.5 mr-1" aria-hidden="true" /> Reject
                </Button>
              </>
            )}
            {canVoid && detail?.refType === "JOURNAL_VOUCHER" && (detail?.status || "POSTED") === "POSTED" && (
              <Button size="sm" variant="outline" className="text-rose-600 hover:text-rose-700 hover:bg-rose-500/10 h-8" onClick={() => setVoiding(detail)}>
                <Ban className="h-3.5 w-3.5 mr-1" aria-hidden="true" /> Void Voucher
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={!!voiding}
        onOpenChange={(v) => { if (!v) setVoiding(null) }}
        title="Void this voucher?"
        message={`A reversal voucher with the flipped lines will be posted (memo "REVERSAL — reason"). The original entry is kept — money history is never deleted. Amount: ${fmtMoney(voiding?.amount)}`}
        confirmLabel="Post Reversal" danger requireReason
        onConfirm={voidVoucher}
      />

      {/* Wave 3 WP-B — reject a pending voucher (reason required) */}
      <ConfirmDialog
        open={!!rejecting}
        onOpenChange={(v) => { if (!v) setRejecting(null) }}
        title="Reject this voucher?"
        message={`The voucher stays on record as REJECTED with your reason — it never reaches the ledger. The requester can edit the draft and resubmit. Amount: ${fmtMoney(rejecting?.amount)}`}
        confirmLabel="Reject Voucher" danger requireReason
        onConfirm={rejectVoucher}
      />
    </div>
  )
}

// ================= CHART OF ACCOUNTS =================
function CoaTab() {
  const navigate = useHrm((s) => s.navigate)
  const { data, loading, error } = useApi<any>("accounting.coa", {})
  const accounts: any[] = data?.accounts || []
  const byGroup = useMemo(() => ACCOUNT_GROUPS.map((g) => ({
    ...g,
    rows: accounts.filter((a) => a.group === g.key),
  })), [accounts])

  return (
    <div className="space-y-4">
      {data?.autoPost === false && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-200 dark:border-amber-900 bg-amber-50/60 dark:bg-amber-950/30 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
          <Info className="h-4 w-4 shrink-0 mt-0.5" aria-hidden="true" />
          <span>Auto-post payroll to accounting is OFF — payroll runs no longer journal automatically (remap it in Settings → Payroll → Accounting).</span>
        </div>
      )}
      {error && <ErrorBanner message={error} />}
      {loading ? <LoadingRows rows={6} /> : (
        <>
          {byGroup.map((g) => (
            <SectionCard key={g.key} title={g.label}>
              <Table>
                <TableHeader>
                  <TableRow className="bg-muted/50 hover:bg-muted/50 border-b">
                    <TableHead className="text-[10.5px] font-semibold uppercase tracking-wide text-muted-foreground w-20">Code</TableHead>
                    <TableHead className="text-[10.5px] font-semibold uppercase tracking-wide text-muted-foreground">Account</TableHead>
                    <TableHead className="text-[10.5px] font-semibold uppercase tracking-wide text-muted-foreground w-24">Normal Side</TableHead>
                    <TableHead className="text-[10.5px] font-semibold uppercase tracking-wide text-muted-foreground">Posts from (journal roles)</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {g.rows.map((a) => (
                    <TableRow key={a.code} className="border-b border-slate-100 dark:border-slate-800/60">
                      <TableCell className="py-1.5 text-[13px] font-mono font-semibold">{a.code}</TableCell>
                      <TableCell className="py-1.5 text-[13px]">{a.name}</TableCell>
                      <TableCell className="py-1.5 text-[11px] text-slate-500">{a.normalSide === "debit" ? "Debit" : "Credit"}</TableCell>
                      <TableCell className="py-1.5">
                        <div className="flex flex-wrap gap-1">
                          {(a.roles || []).length === 0 ? (
                            <span className="text-[11px] text-slate-400">— manual entries only —</span>
                          ) : (a.roles || []).map((r: any) => (
                            <Badge
                              key={r.role}
                              variant="secondary"
                              title={r.isDefault ? "Default mapping" : `Remapped (default ${DEFAULT_LABELS[r.role] || "?"})`}
                              className={r.isDefault
                                ? "text-[10px] bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300"
                                : "text-[10px] bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300"}
                            >
                              {r.label}{!r.isDefault && " ↺"}
                            </Badge>
                          ))}
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                  {g.rows.length === 0 && (
                    <TableRow><TableCell colSpan={4} className="py-3 text-xs text-slate-400">No accounts in this group.</TableCell></TableRow>
                  )}
                </TableBody>
              </Table>
            </SectionCard>
          ))}
          <button
            type="button"
            onClick={() => navigate("settings", { tab: "payroll" })}
            className="inline-flex items-center gap-1.5 text-xs font-medium text-emerald-600 dark:text-emerald-400 hover:underline"
          >
            <Settings2 className="h-3.5 w-3.5" aria-hidden="true" />
            Remap roles in Settings → Payroll → Accounting
          </button>
        </>
      )}
    </div>
  )
}

// ================= TRIAL BALANCE =================
function TrialBalanceTab({ company }: { company: ReportCompany }) {
  const [from, setFrom] = useState("")
  const [to, setTo] = useState("")
  const [printPayload, setPrintPayload] = useState<PrintPayload | null>(null)
  const payload = { ...(from ? { from } : {}), ...(to ? { to } : {}) }
  const { data, loading, error } = useApi<any>("accounting.trialBalance", payload)
  const rows: any[] = data?.rows || []

  // Wave 3 WP-E — flat print/export projection of the statement
  const flatRows: (string | number | null)[][] = rows.map((r) => [r.code, r.name, r.totalDebit, r.totalCredit, r.balanceDr || null, r.balanceCr || null])
  const flatColumns = ["Code", "Account", "Total Debit", "Total Credit", "Balance Dr", "Balance Cr"]
  const flatNumeric = { 2: true, 3: true, 4: true, 5: true }

  const columns: Column<any>[] = [
    { key: "code", label: "Code", sortValue: (r) => r.code, render: (r) => <span className="font-mono text-[13px] font-semibold">{r.code}</span> },
    { key: "name", label: "Account", render: (r) => <span className="text-[13px]">{r.name}</span> },
    { key: "totalDebit", label: "Total Debit", align: "right", sortValue: (r) => r.totalDebit, render: (r) => <span className="text-xs tabular-nums">{fmtMoney(r.totalDebit)}</span> },
    { key: "totalCredit", label: "Total Credit", align: "right", sortValue: (r) => r.totalCredit, render: (r) => <span className="text-xs tabular-nums">{fmtMoney(r.totalCredit)}</span> },
    { key: "balanceDr", label: "Balance Dr", align: "right", sortValue: (r) => r.balanceDr, render: (r) => <span className="text-xs font-semibold tabular-nums text-emerald-700 dark:text-emerald-400">{r.balanceDr ? fmtMoney(r.balanceDr) : "—"}</span> },
    { key: "balanceCr", label: "Balance Cr", align: "right", sortValue: (r) => r.balanceCr, render: (r) => <span className="text-xs font-semibold tabular-nums text-amber-700 dark:text-amber-400">{r.balanceCr ? fmtMoney(r.balanceCr) : "—"}</span> },
  ]

  const periodLabel = `${from || "start of history"} → ${to || today()}`

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="h-8 rounded-md border border-slate-200 dark:border-slate-700 bg-transparent px-2 text-sm" title="From date (blank = all history)" aria-label="From date" />
        <span className="text-xs text-slate-400" aria-hidden="true">→</span>
        <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="h-8 rounded-md border border-slate-200 dark:border-slate-700 bg-transparent px-2 text-sm" title="To date (blank = today)" aria-label="To date" />
        {(from || to) && <Button size="sm" variant="ghost" className="h-8" onClick={() => { setFrom(""); setTo("") }}>All history</Button>}
        <span className="text-xs text-slate-400 ml-auto">
          {data ? `${(data.journalCount ?? 0).toLocaleString()} journal${(data.journalCount ?? 0) !== 1 ? "s" : ""} in range · ${(rows.length)} account${rows.length !== 1 ? "s" : ""} with activity` : ""}
        </span>
        {/* Wave 3 WP-E — shared Export as + in-app print preview */}
        <ExportAsMenu
          fileBase={`trial-balance-${to || today()}`}
          onCsv={() => exportFileCsv(flatColumns, flatRows, `trial-balance-${to || today()}`)}
          getXlsxData={() => ({ columns: flatColumns, rows: flatRows })}
          disabled={!data}
        />
        <Button size="sm" variant="outline" className="h-8 text-xs" disabled={!data} onClick={() => setPrintPayload({
          company,
          title: "Trial Balance",
          meta: `${periodLabel} · ${rows.length} account${rows.length === 1 ? "" : "s"} with activity · grand debit ${fmtMoney(data?.totals?.debit)} = grand credit ${fmtMoney(data?.totals?.credit)}`,
          columns: flatColumns,
          numericCols: flatNumeric,
          rows: flatRows,
          totalsRow: ["", "TOTAL", data?.totals?.debit, data?.totals?.credit, data?.totals?.balanceDr, data?.totals?.balanceCr],
        })}>
          Print
        </Button>
      </div>
      {error && <ErrorBanner message={error} />}
      {data && !data.balanced && (
        <div className="flex items-start gap-2 rounded-lg border border-rose-200 dark:border-rose-900 bg-rose-50/70 dark:bg-rose-950/30 px-3 py-2 text-xs text-rose-700 dark:text-rose-300">
          <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" aria-hidden="true" />
          <span>{data.warning}</span>
        </div>
      )}
      <DataTable
        columns={columns} rows={rows} loading={loading} error={error} searchable={false} pageSize={20} csvName="trial-balance" dense
        emptyTitle="No journal lines in this period"
        emptyHint="Post payroll runs or manual vouchers first — the trial balance aggregates every AccountJournal line in the date range."
      />
      {data && rows.length > 0 && (
        <div className="rounded-xl border bg-card hrm-shadow-xs px-4 py-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs">
              <span className="text-slate-500">Grand Debit <b className="tabular-nums text-slate-800 dark:text-slate-100">{fmtMoney(data.totals?.debit)}</b></span>
              <span className="text-slate-500">Grand Credit <b className="tabular-nums text-slate-800 dark:text-slate-100">{fmtMoney(data.totals?.credit)}</b></span>
              <span className="text-slate-500">Dr − Cr <b className={`tabular-nums ${data.balanced ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600"}`}>{fmtMoney(round2((data.totals?.debit || 0) - (data.totals?.credit || 0)))}</b></span>
              <span className="text-slate-500">Net balances <b className="tabular-nums">{fmtMoney(data.totals?.balanceDr)} Dr = {fmtMoney(data.totals?.balanceCr)} Cr</b></span>
            </div>
            {data.balanced && (
              <span className="flex items-center gap-1 text-xs font-medium text-emerald-600 dark:text-emerald-400">
                <Scale className="h-3.5 w-3.5" aria-hidden="true" /> Grand debit = grand credit (H-9)
              </span>
            )}
          </div>
          <p className="mt-1.5 text-[10px] text-slate-400">Print/export includes the per-account rows; the footer of the print preview carries the grand totals line.</p>
        </div>
      )}
      {/* Wave 3 WP-E — in-app print preview */}
      <ReportPrintModal payload={printPayload} onClose={() => setPrintPayload(null)} />
    </div>
  )
}

// ================= WAVE 3 WP-F — BALANCE SHEET =================
function BalanceSheetTab({ company }: { company: ReportCompany }) {
  const [asOf, setAsOf] = useState(today())
  const [printPayload, setPrintPayload] = useState<PrintPayload | null>(null)
  const payload = { asOf }
  const { data, loading, error } = useApi<any>("accounting.balanceSheet", payload)

  // flat print/export projection: sections + subtotals + the A = L + E check
  const flatColumns = ["Section", "Code", "Account", "Amount"]
  const flatNumeric = { 3: true }
  const flatRows: (string | number | null)[][] = data ? [
    ...data.assets.map((r: any) => ["Assets", r.code, r.name, r.amount]),
    ["", "", "TOTAL ASSETS", data.totalAssets],
    ...data.liabilities.map((r: any) => ["Liabilities", r.code, r.name, r.amount]),
    ["", "", "TOTAL LIABILITIES", data.totalLiabilities],
    ...(data.equity || []).map((r: any) => ["Equity", r.code, r.name, r.amount]),
    ["", "", "Retained Earnings (revenues − expenses to date)", data.retainedEarnings],
    ["", "", "TOTAL EQUITY", data.totalEquity],
    ["", "", "LIABILITIES + EQUITY", round2(data.totalLiabilities + data.totalEquity)],
    ...(data.balanced ? [] : [["!", "", "UNBALANCED (Assets − L − E)", data.difference]]),
  ] : []

  const sectionBlock = (title: string, rows: any[], total: number) => (
    <SectionCard title={title}>
      <StatementTable rows={rows} codeKey="code" nameKey="name" columns={[{ key: "amount", label: "Amount", bold: true }]} />
      <TotalRow label={`Total ${title}`} value={fmtMoney(total)} />
    </SectionCard>
  )

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} className="h-8 rounded-md border border-slate-200 dark:border-slate-700 bg-transparent px-2 text-sm" title="As-of date (position built from history up to this date)" aria-label="As-of date" />
        <span className="text-xs text-slate-400">
          {data ? `${(data.journalCount ?? 0).toLocaleString()} posted journal${(data.journalCount ?? 0) !== 1 ? "s" : ""} up to ${asOf}` : ""}
        </span>
        <div className="ml-auto flex items-center gap-2">
          <ExportAsMenu
            fileBase={`balance-sheet-${asOf}`}
            onCsv={() => exportFileCsv(flatColumns, flatRows, `balance-sheet-${asOf}`)}
            getXlsxData={() => ({ columns: flatColumns, rows: flatRows })}
            disabled={!data}
          />
          <Button size="sm" variant="outline" className="h-8 text-xs" disabled={!data} onClick={() => setPrintPayload({
            company,
            title: "Balance Sheet",
            meta: `As of ${asOf} · assets ${fmtMoney(data?.totalAssets)} = liabilities ${fmtMoney(data?.totalLiabilities)} + equity ${fmtMoney(data?.totalEquity)}${data?.balanced ? "" : ` · UNBALANCED by ${fmtMoney(data?.difference)}`}`,
            columns: flatColumns,
            numericCols: flatNumeric,
            rows: flatRows,
            rowsPerPage: 30,
          })}>
            Print
          </Button>
        </div>
      </div>
      {error && <ErrorBanner message={error} />}
      {data && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-200 dark:border-amber-900 bg-amber-50/60 dark:bg-amber-950/30 px-3 py-2 text-xs text-amber-800 dark:text-amber-300">
          <Info className="h-4 w-4 shrink-0 mt-0.5" aria-hidden="true" />
          <span><b>Statement of Position</b> — {data.scopeNote}</span>
        </div>
      )}
      {loading ? <LoadingRows rows={8} /> : data && (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <StatCard label="Total Assets" value={fmtMoney(data.totalAssets)} sub={`${data.assets.length} account${data.assets.length === 1 ? "" : "s"}`} icon={Landmark} tone="emerald" />
            <StatCard label="Total Liabilities" value={fmtMoney(data.totalLiabilities)} sub={`${data.liabilities.length} account${data.liabilities.length === 1 ? "" : "s"}`} icon={ArrowLeftRight} tone="amber" />
            <StatCard label="Total Equity" value={fmtMoney(data.totalEquity)} sub={`incl. retained earnings ${fmtMoney(data.retainedEarnings)}`} icon={Scale} tone="teal" />
            <StatCard
              label="A = L + E"
              value={data.balanced ? "Balanced" : fmtMoney(data.difference)}
              sub={data.balanced ? "accounting identity holds to the paisa" : "UNBALANCED — surfaced, never hidden"}
              icon={data.balanced ? Scale : AlertTriangle}
              tone={data.balanced ? "emerald" : "rose"}
            />
          </div>

          {sectionBlock("Assets", data.assets, data.totalAssets)}
          {sectionBlock("Liabilities", data.liabilities, data.totalLiabilities)}
          {sectionBlock("Equity", [
            ...(data.equity || []),
            { code: "—", name: "Retained Earnings (revenues − expenses to date)", amount: data.retainedEarnings },
          ], data.totalEquity)}

          {!data.balanced && (
            <div className="flex items-start gap-2 rounded-lg border border-rose-200 dark:border-rose-900 bg-rose-50/70 dark:bg-rose-950/30 px-3 py-2 text-xs text-rose-700 dark:text-rose-300">
              <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" aria-hidden="true" />
              <span>
                <b>Unbalanced by {fmtMoney(data.difference)}</b> — Assets do not equal Liabilities + Equity. The sheet shows
                the difference instead of hiding it; verify recent manual vouchers and contact support if it persists.
              </span>
            </div>
          )}
        </>
      )}
      {/* Wave 3 WP-E — in-app print preview */}
      <ReportPrintModal payload={printPayload} onClose={() => setPrintPayload(null)} />
    </div>
  )
}

// ================= LEDGER =================
function LedgerTab() {
  const [account, setAccount] = useState("")
  const [from, setFrom] = useState("")
  const [to, setTo] = useState("")

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Select value={account || "none"} onValueChange={(v) => setAccount(v === "none" ? "" : v)}>
          <SelectTrigger className="w-64 h-9 text-sm" aria-label="Ledger account"><SelectValue placeholder="Select an account…" /></SelectTrigger>
          <SelectContent className="max-h-72">{ACCOUNT_OPTIONS.map((o) => (
            <SelectItem key={o.value} value={o.value} className="text-xs">{o.label}</SelectItem>
          ))}</SelectContent>
        </Select>
        <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="h-9 rounded-md border border-slate-200 dark:border-slate-700 bg-transparent px-2 text-sm" title="From date (opening balance computed before this)" aria-label="From date" />
        <span className="text-xs text-slate-400" aria-hidden="true">→</span>
        <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="h-9 rounded-md border border-slate-200 dark:border-slate-700 bg-transparent px-2 text-sm" title="To date" aria-label="To date" />
        {(from || to) && <Button size="sm" variant="ghost" className="h-8" onClick={() => { setFrom(""); setTo("") }}>Clear</Button>}
      </div>
      {account ? <LedgerReport account={account} from={from} to={to} /> : (
        <div className="rounded-xl border bg-card hrm-shadow-xs px-4 py-8 text-center">
          <Landmark className="h-6 w-6 mx-auto text-slate-300 mb-2" aria-hidden="true" />
          <p className="text-sm font-medium text-slate-600 dark:text-slate-300">Pick an account to open its ledger</p>
          <p className="text-xs text-slate-400 mt-1">Every journal line that touches the account, in date order, with the opening and closing balance.</p>
        </div>
      )}
    </div>
  )
}

function LedgerReport({ account, from, to }: { account: string; from: string; to: string }) {
  const payload = { account, ...(from ? { from } : {}), ...(to ? { to } : {}) }
  const { data, loading, error } = useApi<any>("accounting.ledger", payload)
  const lines: any[] = data?.lines || []

  const columns: Column<any>[] = [
    { key: "date", label: "Date", sortValue: (r) => r.date, render: (r) => <span className="text-xs tabular-nums">{fmtDate(r.date)}</span> },
    { key: "refType", label: "Type", render: (r) => <Badge variant="outline" className="text-[10px]">{r.refType}</Badge> },
    { key: "memo", label: "Memo", render: (r) => <span className="text-xs line-clamp-1 max-w-72 inline-block align-middle" title={r.memo}>{r.memo}</span> },
    { key: "debit", label: "Debit", align: "right", sortValue: (r) => r.debit, render: (r) => <span className="text-xs tabular-nums">{r.debit ? fmtMoney(r.debit) : "—"}</span> },
    { key: "credit", label: "Credit", align: "right", sortValue: (r) => r.credit, render: (r) => <span className="text-xs tabular-nums">{r.credit ? fmtMoney(r.credit) : "—"}</span> },
    { key: "balance", label: "Balance", align: "right", sortValue: (r) => r.balance, render: (r) => <span className="text-xs font-semibold tabular-nums">{fmtDrCr(r.balance)}</span> },
  ]

  return (
    <div className="space-y-3">
      {error && <ErrorBanner message={error} />}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <StatCard label="Account" value={account} sub={ACCOUNTS[account] || ""} icon={Landmark} tone="slate" />
        <StatCard label="Opening Balance" value={loading ? "…" : fmtDrCr(data?.opening ?? 0)} sub={from ? `before ${from}` : "start of history"} icon={ArrowLeftRight} tone="teal" />
        <StatCard label="Closing Balance" value={loading ? "…" : fmtDrCr(data?.closing ?? 0)} sub={`${(data?.count ?? 0).toLocaleString()} line${(data?.count ?? 0) !== 1 ? "s" : ""} in period`} icon={Scale} tone="emerald" />
        <StatCard label="Period Movement" value={loading ? "…" : fmtDrCr(round2((data?.closing ?? 0) - (data?.opening ?? 0)))} sub="closing − opening" icon={CalendarDays} tone="amber" />
      </div>
      <DataTable
        columns={columns} rows={lines} loading={loading} error={error} searchable={false} pageSize={20} dense
        csvName={`ledger-${account}`}
        emptyTitle="No postings hit this account in the period"
        emptyHint="Try widening the date range — the ledger only shows journal lines whose account matches."
      />
    </div>
  )
}

// ================= INCOME STATEMENT (payroll-centric) =================
function IncomeStatementTab({ company }: { company: ReportCompany }) {
  const [from, setFrom] = useState("")
  const [to, setTo] = useState("")
  const [printPayload, setPrintPayload] = useState<PrintPayload | null>(null)
  const payload = { ...(from ? { from } : {}), ...(to ? { to } : {}) }
  const { data, loading, error } = useApi<any>("accounting.incomeStatement", payload)
  const expenses: any[] = data?.expenses || []
  const recovered: any[] = data?.recoveredSettled || []
  const assets: any[] = data?.assetMovements || []

  // Wave 3 WP-E — flat print/export projection of the statement
  const flatColumns = ["Section", "Code", "Account", "Debit", "Credit", "Net"]
  const flatNumeric = { 3: true, 4: true, 5: true }
  const flatRows: (string | number | null)[][] = data ? [
    ...expenses.map((r: any) => ["Expenses", r.code, r.name, r.debit, r.credit, r.net]),
    ["", "", "TOTAL NET EXPENSES", null, null, data.totalExpenses],
    ...recovered.map((r: any) => ["Payables", r.code, r.name, r.debit, r.credit, r.net]),
    ["", "", "NET PAYABLES Δ", null, null, data.netMovement?.netLiabilities],
    ...assets.map((r: any) => ["Assets", r.code, r.name, r.debit, r.credit, r.net]),
    ["", "", "NET ASSET MOVEMENT", null, null, data.assetTotals?.net],
  ] : []

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="h-8 rounded-md border border-slate-200 dark:border-slate-700 bg-transparent px-2 text-sm" title="From date" aria-label="From date" />
        <span className="text-xs text-slate-400" aria-hidden="true">→</span>
        <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="h-8 rounded-md border border-slate-200 dark:border-slate-700 bg-transparent px-2 text-sm" title="To date" aria-label="To date" />
        {(from || to) && <Button size="sm" variant="ghost" className="h-8" onClick={() => { setFrom(""); setTo("") }}>All history</Button>}
        <span className="text-xs text-slate-400 ml-auto">{data ? `${(data.journalCount ?? 0).toLocaleString()} journal${(data.journalCount ?? 0) !== 1 ? "s" : ""} in range` : ""}</span>
        {/* Wave 3 WP-E — shared Export as + in-app print preview */}
        <ExportAsMenu
          fileBase={`income-statement-${to || today()}`}
          onCsv={() => exportFileCsv(flatColumns, flatRows, `income-statement-${to || today()}`)}
          getXlsxData={() => ({ columns: flatColumns, rows: flatRows })}
          disabled={!data}
        />
        <Button size="sm" variant="outline" className="h-8 text-xs" disabled={!data} onClick={() => setPrintPayload({
          company,
          title: "Income Statement (Payroll-Centric)",
          meta: `${from || "start of history"} → ${to || today()} · total net expenses ${fmtMoney(data?.totalExpenses)} · double-entry check ${fmtMoney(data?.netMovement?.check)}`,
          columns: flatColumns,
          numericCols: flatNumeric,
          rows: flatRows,
          rowsPerPage: 30,
        })}>
          Print
        </Button>
      </div>
      {error && <ErrorBanner message={error} />}
      {data && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-200 dark:border-amber-900 bg-amber-50/60 dark:bg-amber-950/30 px-3 py-2 text-xs text-amber-800 dark:text-amber-300">
          <Info className="h-4 w-4 shrink-0 mt-0.5" aria-hidden="true" />
          <span><b>{data.title}</b> — {data.scopeNote}</span>
        </div>
      )}
      {loading ? <LoadingRows rows={8} /> : data && (
        <>
          <SectionCard title="Expenses">
            <StatementTable
              rows={expenses} codeKey="code" nameKey="name"
              columns={[{ key: "debit", label: "Debits" }, { key: "credit", label: "Credits (recoveries)" }, { key: "net", label: "Net Expense", bold: true }]}
            />
            <TotalRow label="Total Expenses (net)" value={fmtMoney(data.totalExpenses)} />
          </SectionCard>

          <SectionCard title="Recovered / Settled — Payables">
            <StatementTable
              rows={recovered} codeKey="code" nameKey="name"
              columns={[{ key: "credit", label: "Accrued (Cr)" }, { key: "debit", label: "Settled (Dr)" }, { key: "net", label: "Net Liability Δ", bold: true }]}
            />
            <TotalRow
              label="Payables — accrued less settled"
              value={`${fmtMoney(data.recoveredTotals?.accrued)} accrued − ${fmtMoney(data.recoveredTotals?.settled)} settled = ${fmtMoney(data.netMovement?.netLiabilities)} Δ`}
            />
          </SectionCard>

          <SectionCard title="Asset Movements">
            <StatementTable
              rows={assets} codeKey="code" nameKey="name"
              columns={[{ key: "debit", label: "Inflow (Dr)" }, { key: "credit", label: "Outflow (Cr)" }, { key: "net", label: "Net Movement", bold: true }]}
            />
            <TotalRow label="Net Asset Movement" value={fmtMoney(data.assetTotals?.net)} />
          </SectionCard>

          <div className="rounded-xl border bg-card hrm-shadow-xs px-4 py-3 space-y-1.5">
            <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
              <span className="font-semibold text-slate-700 dark:text-slate-200">Net Movement</span>
              <span className="font-bold tabular-nums text-slate-900 dark:text-slate-50">{fmtMoney(data.netMovement?.net)} <span className="text-xs font-normal text-slate-400">expenses recognized less accrued payables</span></span>
            </div>
            <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-slate-500">
              <span>Total expenses (net) <b className="tabular-nums text-slate-800 dark:text-slate-100">{fmtMoney(data.netMovement?.totalExpenses)}</b></span>
              <span>Net payables Δ <b className="tabular-nums text-slate-800 dark:text-slate-100">{fmtMoney(data.netMovement?.netLiabilities)}</b></span>
              <span>Net assets Δ <b className="tabular-nums text-slate-800 dark:text-slate-100">{fmtMoney(data.netMovement?.netAssets)}</b></span>
            </div>
            <div className={`flex items-center gap-1.5 text-xs ${data.netMovement?.balanced ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400"}`}>
              <Scale className="h-3.5 w-3.5" aria-hidden="true" />
              Double-entry check — assets Δ − payables Δ + expenses = <b className="tabular-nums">{fmtMoney(data.netMovement?.check)}</b> {data.netMovement?.balanced ? "(zero, as it must be)" : "(NON-ZERO — H-9 violated, contact support)"}
            </div>
          </div>
        </>
      )}
      {/* Wave 3 WP-E — in-app print preview */}
      <ReportPrintModal payload={printPayload} onClose={() => setPrintPayload(null)} />
    </div>
  )
}

function StatementTable({ rows, codeKey, nameKey, columns }: {
  rows: any[]; codeKey: string; nameKey: string
  columns: { key: string; label: string; bold?: boolean }[]
}) {
  if (!rows.length) return <p className="text-xs text-slate-400 py-2">No activity in this period.</p>
  return (
    <Table>
      <TableHeader>
        <TableRow className="bg-muted/50 hover:bg-muted/50 border-b">
          <TableHead className="text-[10.5px] font-semibold uppercase tracking-wide text-muted-foreground w-20">Code</TableHead>
          <TableHead className="text-[10.5px] font-semibold uppercase tracking-wide text-muted-foreground">Account</TableHead>
          {columns.map((c) => (
            <TableHead key={c.key} className="text-[10.5px] font-semibold uppercase tracking-wide text-muted-foreground text-right">{c.label}</TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((r) => (
          <TableRow key={r[codeKey]} className="border-b border-slate-100 dark:border-slate-800/60">
            <TableCell className="py-1.5 text-[13px] font-mono font-semibold">{r[codeKey]}</TableCell>
            <TableCell className="py-1.5 text-[13px]">{r[nameKey]}</TableCell>
            {columns.map((c) => (
              <TableCell key={c.key} className={`py-1.5 text-right tabular-nums ${c.bold ? "text-[13px] font-semibold" : "text-xs"}`}>
                {r[c.key] != null ? fmtMoney(r[c.key]) : "—"}
              </TableCell>
            ))}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

function TotalRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between border-t-2 border-slate-200 dark:border-slate-700 mt-2 pt-2 px-1">
      <span className="text-xs font-semibold text-slate-600 dark:text-slate-300">{label}</span>
      <span className="text-sm font-bold tabular-nums text-slate-900 dark:text-slate-50">{value}</span>
    </div>
  )
}

// ================= WAVE 4 — CASH FLOW (direct method) =================
// Cash = 1010 + 1200 + 1210 (debit-normal). Server-side, every POSTED journal
// that touches a cash account contributes its non-cash counterpart lines
// (credit − debit = cash effect) grouped into operating receipts/payments,
// employee lending and financing; opening = signed cash balance before `from`.
// Print/export rides the SAME shared statement shell as TB/BS/IS.
function CashFlowTab({ company }: { company: ReportCompany }) {
  const monthStart = `${today().slice(0, 7)}-01`
  const [from, setFrom] = useState(monthStart)
  const [to, setTo] = useState(today())
  const [printPayload, setPrintPayload] = useState<PrintPayload | null>(null)
  // the statement needs a concrete range (opening is everything before `from`)
  const ready = !!from && !!to && from <= to
  const { data, loading, error } = useApi<any>(ready ? "accounting.cashFlow" : null, ready ? { from, to } : undefined)
  const sections: any[] = data?.sections || []
  const sectionsSum = sections.reduce((s, sec) => s + Math.round((sec.total || 0) * 100), 0) / 100

  // flat print/export projection: sections + subtotals + the opening/net/closing
  // reconciliation (+ the UNBALANCED guard row, only when it ever trips)
  const flatColumns = ["Section", "Code", "Account", "Amount"]
  const flatNumeric = { 3: true }
  const flatRows: (string | number | null)[][] = data ? [
    ...sections.flatMap((s: any) => [
      ...s.items.map((it: any) => [s.label, it.code, it.name, it.amount]),
      ["", "", `TOTAL ${s.label.toUpperCase()}`, s.total],
    ]),
    ["", "", "NET CHANGE IN CASH", data.netChange],
    ["", "", "CASH AT START OF PERIOD (opening)", data.opening],
    ["", "", "CASH AT END OF PERIOD (closing)", data.closing],
    ...(data.balanced ? [] : [["!", "", "UNBALANCED (cash net − counterpart sections)", data.difference]]),
  ] : []

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="h-8 rounded-md border border-slate-200 dark:border-slate-700 bg-transparent px-2 text-sm" title="From date (opening cash is everything before this)" aria-label="From date" />
        <span className="text-xs text-slate-400" aria-hidden="true">→</span>
        <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="h-8 rounded-md border border-slate-200 dark:border-slate-700 bg-transparent px-2 text-sm" title="To date" aria-label="To date" />
        <Button size="sm" variant="ghost" className="h-8" onClick={() => { setFrom(monthStart); setTo(today()) }}>This month</Button>
        <span className="text-xs text-slate-400 ml-auto">
          {data ? `${(data.journalCount ?? 0).toLocaleString()} cash-touching journal${(data.journalCount ?? 0) !== 1 ? "s" : ""} in range` : ""}
        </span>
        {/* Wave 4 — shared Export as + in-app print preview (same shell as TB/BS/IS) */}
        <ExportAsMenu
          fileBase={`cash-flow-${to || today()}`}
          onCsv={() => exportFileCsv(flatColumns, flatRows, `cash-flow-${to || today()}`)}
          getXlsxData={() => ({ columns: flatColumns, rows: flatRows })}
          disabled={!data}
        />
        <Button size="sm" variant="outline" className="h-8 text-xs" disabled={!data} onClick={() => setPrintPayload({
          company,
          title: "Cash Flow Statement (Direct Method)",
          meta: `${from} → ${to} · opening ${fmtMoney(data?.opening)} + net change ${fmtMoney(data?.netChange)} = closing ${fmtMoney(data?.closing)}${data?.balanced ? "" : ` · UNBALANCED by ${fmtMoney(data?.difference)}`}`,
          columns: flatColumns,
          numericCols: flatNumeric,
          rows: flatRows,
          rowsPerPage: 30,
        })}>
          Print
        </Button>
      </div>
      {error && <ErrorBanner message={error} />}
      {!ready && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-200 dark:border-amber-900 bg-amber-50/60 dark:bg-amber-950/30 px-3 py-2 text-xs text-amber-800 dark:text-amber-300">
          <Info className="h-4 w-4 shrink-0 mt-0.5" aria-hidden="true" />
          <span>Pick both dates — the cash flow needs a concrete range (the opening balance is everything before the from date).</span>
        </div>
      )}
      {data && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-200 dark:border-amber-900 bg-amber-50/60 dark:bg-amber-950/30 px-3 py-2 text-xs text-amber-800 dark:text-amber-300">
          <Info className="h-4 w-4 shrink-0 mt-0.5" aria-hidden="true" />
          <span><b>{data.title}</b> — {data.scopeNote}</span>
        </div>
      )}
      {loading ? <LoadingRows rows={8} /> : data && (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <StatCard label="Opening Cash" value={fmtMoney(data.opening)} sub={`balance before ${from}`} icon={Wallet} tone="teal" />
            <StatCard label="Net Change" value={fmtMoney(data.netChange)} sub={`${sections.length} section${sections.length === 1 ? "" : "s"} of flows`} icon={ArrowLeftRight} tone={data.netChange >= 0 ? "emerald" : "rose"} />
            <StatCard label="Closing Cash" value={fmtMoney(data.closing)} sub="opening + net change" icon={Landmark} tone="slate" />
            <StatCard
              label="Sections Explain Cash"
              value={data.balanced ? "Yes" : fmtMoney(data.difference)}
              sub={data.balanced ? "counterpart flows net to the cash movement" : "UNBALANCED — surfaced, never hidden"}
              icon={data.balanced ? Scale : AlertTriangle}
              tone={data.balanced ? "emerald" : "rose"}
            />
          </div>

          {sections.length === 0 && (
            <div className="rounded-xl border bg-card hrm-shadow-xs px-4 py-8 text-center">
              <Wallet className="h-6 w-6 mx-auto text-slate-300 mb-2" aria-hidden="true" />
              <p className="text-sm font-medium text-slate-600 dark:text-slate-300">No cash movements in this period</p>
              <p className="text-xs text-slate-400 mt-1">Journals that touch Cash on Hand, Bank Accounts or MFS Wallets appear here with their counterpart flows.</p>
            </div>
          )}
          {sections.map((s: any) => (
            <SectionCard key={s.key} title={s.label}>
              <StatementTable rows={s.items} codeKey="code" nameKey="name" columns={[{ key: "amount", label: "Amount (cash effect)", bold: true }]} />
              <TotalRow label={`Total ${s.label}`} value={fmtMoney(s.total)} />
            </SectionCard>
          ))}

          <div className="rounded-xl border bg-card hrm-shadow-xs px-4 py-3 space-y-1.5">
            <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
              <span className="font-semibold text-slate-700 dark:text-slate-200">Net Change in Cash</span>
              <span className="font-bold tabular-nums text-slate-900 dark:text-slate-50">{fmtMoney(data.netChange)}</span>
            </div>
            <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-slate-500">
              <span>Opening <b className="tabular-nums text-slate-800 dark:text-slate-100">{fmtMoney(data.opening)}</b></span>
              <span>Closing <b className="tabular-nums text-slate-800 dark:text-slate-100">{fmtMoney(data.closing)}</b></span>
              <span>Counterpart sections <b className="tabular-nums text-slate-800 dark:text-slate-100">{fmtMoney(sectionsSum)}</b></span>
            </div>
            <div className={`flex items-center gap-1.5 text-xs ${data.balanced ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400"}`}>
              <Scale className="h-3.5 w-3.5" aria-hidden="true" />
              {data.balanced
                ? "Counterpart flows explain the cash movement to the paisa (H-9)"
                : `Cash net and counterpart sections differ by ${fmtMoney(data.difference)} — the H-9 invariant is violated; contact support immediately.`}
            </div>
          </div>
        </>
      )}
      {/* Wave 4 — in-app print preview (shared statement shell) */}
      <ReportPrintModal payload={printPayload} onClose={() => setPrintPayload(null)} />
    </div>
  )
}

// ================= WAVE 4 — ACCOUNTING PERIODS (soft lock) =================
function PeriodsTab() {
  const { can } = useHrm()
  const toast = useHrm((s) => s.toast)
  const canEdit = can("accounting", "edit")
  // closing/reopening deliberately need the STRICTER approve gate (server rule)
  const canClose = can("accounting", "approve")
  const { data, loading, error, reload } = useApi<any>("accounting.periods.list", {})
  const periods: any[] = data?.periods || []
  const openCount = periods.filter((p) => p.status !== "CLOSED").length

  const [createOpen, setCreateOpen] = useState(false)
  const [editRow, setEditRow] = useState<any>(null)
  const [closing, setClosing] = useState<any>(null)
  const [reopening, setReopening] = useState<any>(null)

  const fields: FieldDef[] = [
    { name: "name", label: "Period name", required: true, placeholder: "e.g. FY2026-Q1 or October 2026", help: "Unique per workspace." },
    { name: "startDate", label: "Start date", type: "date", required: true },
    { name: "endDate", label: "End date", type: "date", required: true },
  ]

  const closePeriod = async () => {
    if (!closing) return
    await rpc<any>("accounting.periods.close", { id: closing.id })
    toast(`Period ${closing.name} closed — manual voucher writes dated ${closing.startDate} → ${closing.endDate} are now refused`)
    reload()
  }

  const reopenPeriod = async (reason?: string) => {
    if (!reopening) return
    await rpc<any>("accounting.periods.reopen", { id: reopening.id, ...(reason ? { reason } : {}) })
    toast(`Period ${reopening.name} reopened — voucher writes are accepted again (last closed by ${reopening.closedByName || "unknown"})`)
    reload()
  }

  const columns: Column<any>[] = [
    { key: "name", label: "Period", sortValue: (r) => r.name, render: (r) => (
      <div className="flex items-center gap-2">
        {r.status === "CLOSED" ? <Lock className="h-3.5 w-3.5 text-rose-500" aria-hidden="true" /> : <LockOpen className="h-3.5 w-3.5 text-emerald-500" aria-hidden="true" />}
        <span className="text-[13px] font-semibold">{r.name}</span>
      </div>
    ) },
    { key: "startDate", label: "Start", sortValue: (r) => r.startDate, render: (r) => <span className="text-xs tabular-nums">{fmtDate(r.startDate)}</span> },
    { key: "endDate", label: "End", sortValue: (r) => r.endDate, render: (r) => <span className="text-xs tabular-nums">{fmtDate(r.endDate)}</span> },
    { key: "status", label: "Status", render: (r) => (
      <Badge variant="secondary" className={r.status === "CLOSED" ? "text-[9px] bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300" : "text-[9px] bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300"}>{r.status}</Badge>
    ) },
    { key: "journalCount", label: "Journals", align: "right", sortValue: (r) => r.journalCount ?? 0, render: (r) => <span className="text-xs tabular-nums">{(r.journalCount ?? 0).toLocaleString()}</span> },
    { key: "closedBy", label: "Closed By", render: (r) => r.closedByName ? (
      <span className="text-xs text-slate-500">{r.closedByName}{r.closedAt ? ` · ${fmtDateTime(r.closedAt)}` : ""}</span>
    ) : <span className="text-xs text-slate-400">—</span> },
    { key: "actions", label: "", align: "right", render: (r) => (
      <div className="flex items-center justify-end gap-1">
        {canEdit && r.status !== "CLOSED" && (
          <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setEditRow(r)}>Edit</Button>
        )}
        {canClose && r.status !== "CLOSED" && (
          <Button size="sm" variant="ghost" className="h-7 text-xs text-rose-600 hover:text-rose-700 hover:bg-rose-500/10" onClick={() => setClosing(r)} title="Lock the date range against new manual voucher writes">
            <Lock className="h-3 w-3" aria-hidden="true" /> Close
          </Button>
        )}
        {canClose && r.status === "CLOSED" && (
          <Button size="sm" variant="ghost" className="h-7 text-xs text-emerald-600 hover:text-emerald-700 hover:bg-emerald-500/10" onClick={() => setReopening(r)} title="Allow manual voucher writes in the range again">
            <LockOpen className="h-3 w-3" aria-hidden="true" /> Reopen
          </Button>
        )}
      </div>
    ) },
  ]

  return (
    <div className="space-y-3">
      <SectionCard title="Accounting Periods" actions={
        <div className="flex items-center gap-2">
          <span className="text-xs text-slate-400">{openCount} open · {periods.length - openCount} closed</span>
          {canEdit && (
            <Button size="sm" className="h-8 text-xs" onClick={() => setCreateOpen(true)}>
              <Plus className="h-3.5 w-3.5 mr-1" aria-hidden="true" /> New Period
            </Button>
          )}
        </div>
      }>
        <p className="text-xs text-slate-500 mb-3">
          A <b>CLOSED</b> period is a soft lock: new manual journal vouchers dated inside the range are refused — drafts,
          submissions, approvals and direct posts alike. System journals (payroll, payouts, loans, expenses) are unaffected,
          and posted history is never edited by closing. Reopening is allowed and audited; the Closed By column keeps the last closer.
        </p>
        <DataTable
          columns={columns} rows={periods} loading={loading} error={error} searchable={false} pageSize={20} csvName="accounting-periods" dense
          emptyTitle="No accounting periods yet"
          emptyHint="Create one to start locking months or quarters — e.g. October 2026 (2026-10-01 → 2026-10-31)."
        />
      </SectionCard>

      <FormDialog open={createOpen} onOpenChange={(v) => { setCreateOpen(v); if (!v) reload() }}
        title="New Accounting Period" description="A named date range you can close to lock manual voucher writes."
        fields={fields}
        onSubmit={async (v) => {
          await rpc("accounting.periods.save", { name: String(v.name || "").trim(), startDate: v.startDate, endDate: v.endDate })
        }} />

      <FormDialog key={editRow?.id || "edit-period"} open={!!editRow} onOpenChange={(v) => { if (!v) setEditRow(null); reload() }}
        title="Edit Accounting Period" description={editRow ? `${editRow.name} · ${editRow.startDate} → ${editRow.endDate}` : undefined}
        fields={fields}
        initial={editRow ? { name: editRow.name, startDate: editRow.startDate, endDate: editRow.endDate } : undefined}
        onSubmit={async (v) => {
          await rpc("accounting.periods.save", { id: editRow.id, name: String(v.name || "").trim(), startDate: v.startDate, endDate: v.endDate })
        }} />

      {/* type-to-confirm close — the typed period name IS the confirmation */}
      <PeriodCloseDialog key={closing?.id || "none"} period={closing}
        onOpenChange={(v) => { if (!v) setClosing(null) }}
        onConfirm={closePeriod} />

      <ConfirmDialog
        open={!!reopening}
        onOpenChange={(v) => { if (!v) setReopening(null) }}
        title="Reopen this period?"
        message={`${reopening?.name || ""} becomes OPEN again — manual voucher writes dated ${reopening?.startDate || ""} → ${reopening?.endDate || ""} are accepted immediately. The Closed By trail keeps the last closer (${reopening?.closedByName || "unknown"}).`}
        confirmLabel="Reopen Period" requireReason
        onConfirm={reopenPeriod}
      />
    </div>
  )
}

/** Type-to-confirm close dialog: the destructive button unlocks only when the
 *  typed text matches the period name exactly (locking a date range deserves
 *  more friction than a plain confirm). Keyed remount resets the typed state —
 *  no setState-in-effect. */
function PeriodCloseDialog({ period, onOpenChange, onConfirm }: {
  period: any | null
  onOpenChange: (v: boolean) => void
  onConfirm: () => Promise<void>
}) {
  const [typed, setTyped] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const matches = !!period && typed.trim() === period.name

  const go = async () => {
    if (!period || !matches || busy) return
    setBusy(true)
    setError(null)
    try {
      await onConfirm()
      onOpenChange(false)
    } catch (e: any) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={!!period} onOpenChange={(v) => { if (!busy) onOpenChange(v) }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-base flex items-center gap-2">
            <Lock className="h-4 w-4 text-rose-500" aria-hidden="true" />
            Close period{period ? ` — ${period.name}` : ""}
          </DialogTitle>
        </DialogHeader>
        <p className="text-sm text-slate-600 dark:text-slate-300">
          Manual journal vouchers dated <span className="tabular-nums font-medium">{period?.startDate} → {period?.endDate}</span> will be
          refused — drafts, submissions, approvals and direct posts alike. Posted history is untouched; an approver can reopen the
          period later.
        </p>
        <div className="space-y-1.5">
          <Label htmlFor="period-close-confirm" className="text-xs font-medium">
            Type the period name to confirm <span className="text-rose-500">*</span>
          </Label>
          <Input
            id="period-close-confirm"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder={period?.name || ""}
            autoComplete="off"
          />
          {typed.trim() !== "" && !matches && (
            <p className="text-[11px] text-amber-600 dark:text-amber-400">
              The typed name does not match “{period?.name}” exactly.
            </p>
          )}
        </div>
        {/* M-9 — announced to screen readers (role=alert) */}
        <FieldError message={error} />
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
          <Button variant="destructive" onClick={go} disabled={busy || !matches}>
            {busy ? "Closing…" : "Close Period"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ================= WAVE 4 — COST CENTERS =================
function CostCentersTab() {
  const { can } = useHrm()
  const canEdit = can("accounting", "edit")
  const { data, loading, error, reload } = useApi<any>("accounting.costCenters.list", {})
  const costCenters: any[] = data?.costCenters || []
  const [createOpen, setCreateOpen] = useState(false)
  const [editRow, setEditRow] = useState<any>(null)
  const [deleting, setDeleting] = useState<any>(null)

  const fields: FieldDef[] = [
    { name: "code", label: "Code", required: true, placeholder: "e.g. HQ / PLANT / CC-01", help: "Unique per workspace — shown on vouchers and budget lines." },
    { name: "name", label: "Name", required: true, placeholder: "e.g. Head Office" },
    { name: "active", label: "Active (offered on new vouchers & budgets)", type: "switch", defaultValue: true },
  ]

  const save = async (v: Record<string, any>) => {
    await rpc("accounting.costCenters.save", {
      ...(editRow ? { id: editRow.id } : {}),
      code: String(v.code || "").trim(),
      name: String(v.name || "").trim(),
      active: v.active !== false,
    })
  }

  const columns: Column<any>[] = [
    { key: "code", label: "Code", sortValue: (r) => r.code, render: (r) => <span className="font-mono text-[13px] font-semibold">{r.code}</span> },
    { key: "name", label: "Name", sortValue: (r) => r.name, render: (r) => <span className="text-[13px]">{r.name}</span> },
    { key: "active", label: "Status", render: (r) => (
      <Badge variant="secondary" className={r.active ? "text-[9px] bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300" : "text-[9px] bg-slate-200 text-slate-600 dark:bg-slate-800 dark:text-slate-300"}>{r.active ? "ACTIVE" : "INACTIVE"}</Badge>
    ) },
    { key: "createdAt", label: "Created", sortValue: (r) => String(r.createdAt || ""), render: (r) => (
      <span className="text-xs tabular-nums text-slate-500">{fmtDate(String(r.createdAt || "").slice(0, 10))}</span>
    ) },
    { key: "actions", label: "", align: "right", render: (r) => canEdit ? (
      <div className="flex items-center justify-end gap-1">
        <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setEditRow(r)}>Edit</Button>
        <Button size="sm" variant="ghost" className="h-7 text-xs text-rose-600 hover:text-rose-700 hover:bg-rose-500/10" onClick={() => setDeleting(r)}>Delete</Button>
      </div>
    ) : null },
  ]

  return (
    <div className="space-y-3">
      <SectionCard title="Cost Centers" actions={
        <div className="flex items-center gap-2">
          <span className="text-xs text-slate-400">{costCenters.filter((c) => c.active).length} active of {costCenters.length}</span>
          {canEdit && (
            <Button size="sm" className="h-8 text-xs" onClick={() => setCreateOpen(true)}>
              <Plus className="h-3.5 w-3.5 mr-1" aria-hidden="true" /> New Cost Center
            </Button>
          )}
        </div>
      }>
        <p className="text-xs text-slate-500 mb-3">
          An optional tag for manual journal vouchers and budget lines — one center per voucher, so cost-center reporting stays
          unambiguous. Deleting is refused while POSTED journals carry the tag (deactivate instead); non-posted vouchers get
          untagged automatically.
        </p>
        <DataTable
          columns={columns} rows={costCenters} loading={loading} error={error} searchable pageSize={20} csvName="cost-centers" dense
          emptyTitle="No cost centers yet"
          emptyHint="Add one — e.g. HQ for head-office costs — then tag manual vouchers with it on the Vouchers tab."
        />
      </SectionCard>

      <FormDialog open={createOpen} onOpenChange={(v) => { setCreateOpen(v); if (!v) reload() }}
        title="New Cost Center" description="Codes are unique per workspace; inactive centers stop appearing on new vouchers and budgets."
        fields={fields}
        onSubmit={save} />

      <FormDialog key={editRow?.id || "edit-cc"} open={!!editRow} onOpenChange={(v) => { if (!v) setEditRow(null); reload() }}
        title="Edit Cost Center" description={editRow ? `${editRow.code} — ${editRow.name}` : undefined}
        fields={fields}
        initial={editRow ? { code: editRow.code, name: editRow.name, active: !!editRow.active } : undefined}
        onSubmit={save} />

      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(v) => { if (!v) setDeleting(null) }}
        title="Delete this cost center?"
        message={`${deleting?.code || ""} — ${deleting?.name || ""}. Refused automatically while POSTED journals reference it (deactivate instead); otherwise non-posted vouchers get untagged.`}
        confirmLabel="Delete" danger requireReason
        onConfirm={async (reason) => {
          if (!deleting) return
          await rpc("accounting.costCenters.delete", { id: deleting.id, ...(reason ? { reason } : {}) })
          reload()
        }}
      />
    </div>
  )
}

// ================= WAVE 4 — BUDGETS (with variance) =================
function BudgetsTab() {
  const { can } = useHrm()
  const canEdit = can("accounting", "edit")
  const [periodFilter, setPeriodFilter] = useState("")
  const payload = { ...(periodFilter ? { periodId: periodFilter } : {}) }
  const { data, loading, error, reload } = useApi<any>("accounting.budgets.list", payload)
  const rows: any[] = data?.rows || []
  const periods: any[] = data?.periods || []
  const costCenters: any[] = data?.costCenters || []
  const [createOpen, setCreateOpen] = useState(false)
  const [editRow, setEditRow] = useState<any>(null)
  const [deleting, setDeleting] = useState<any>(null)

  // grouped account picker — the chart sections order the flat option list
  const accountOptions = ACCOUNT_GROUPS.flatMap((g) =>
    g.codes.map((c) => ({ value: c, label: `${g.label} · ${c} — ${ACCOUNTS[c]}` })),
  )
  const periodOptions = [
    { value: "", label: "— No period (all history) —" },
    ...periods.map((p) => ({ value: p.id, label: `${p.name} (${p.startDate} → ${p.endDate})` })),
  ]
  const ccOptions = [
    { value: "", label: "— No cost center —" },
    ...costCenters.filter((c) => c.active).map((c) => ({ value: c.id, label: `${c.code} — ${c.name}` })),
  ]

  const fields: FieldDef[] = [
    { name: "accountCode", label: "Account", type: "select", options: accountOptions, required: true, span: 2, help: "Grouped by chart section — Assets, Liabilities, Expenses." },
    { name: "amount", label: "Budget amount (৳)", type: "number", required: true, min: 0, step: 0.01, span: 2 },
    { name: "periodId", label: "Period (optional)", type: "select", options: periodOptions, help: "Actuals are then computed inside the period dates." },
    { name: "costCenterId", label: "Cost center (optional)", type: "select", options: ccOptions, help: "Actuals are then computed from journals tagged with it." },
    { name: "notes", label: "Notes (optional)", type: "textarea", rows: 2, span: 2 },
  ]

  const save = async (v: Record<string, any>) => {
    await rpc("accounting.budgets.save", {
      ...(editRow ? { id: editRow.id } : {}),
      accountCode: v.accountCode,
      amount: Number(v.amount || 0),
      periodId: v.periodId || null,
      costCenterId: v.costCenterId || null,
      notes: v.notes || null,
    })
  }

  const varianceTone = (r: any) =>
    r.variance < 0 ? "text-rose-600 dark:text-rose-400" : r.variance > 0 ? "text-emerald-600 dark:text-emerald-400" : "text-slate-500"

  const columns: Column<any>[] = [
    { key: "account", label: "Account", sortValue: (r) => r.accountCode, render: (r) => (
      <div className="flex items-baseline gap-2">
        <span className="font-mono text-[13px] font-semibold">{r.accountCode}</span>
        <span className="text-xs text-slate-500">{r.accountName}</span>
      </div>
    ) },
    { key: "periodName", label: "Period", sortValue: (r) => r.periodName || "", render: (r) => r.periodName
      ? <Badge variant="outline" className="text-[10px]">{r.periodName}</Badge>
      : <span className="text-xs text-slate-400">all history</span> },
    { key: "costCenterName", label: "Cost Center", sortValue: (r) => r.costCenterName || "", render: (r) => r.costCenterName
      ? <Badge variant="secondary" className="text-[10px] bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300">{r.costCenterName}</Badge>
      : <span className="text-xs text-slate-400">—</span> },
    { key: "budget", label: "Budget", align: "right", sortValue: (r) => r.budget, render: (r) => <span className="text-xs tabular-nums">{fmtMoney(r.budget)}</span> },
    { key: "actual", label: "Actual", align: "right", sortValue: (r) => r.actual, render: (r) => <span className="text-xs tabular-nums">{fmtMoney(r.actual)}</span> },
    // Wave 4 — variance = budget − actual (negative = OVER budget, red)
    { key: "variance", label: "Variance", align: "right", sortValue: (r) => r.variance, render: (r) => (
      <span className={`text-xs font-semibold tabular-nums ${varianceTone(r)}`} title={r.variance < 0 ? "Over budget" : r.variance > 0 ? "Under budget" : "On budget"}>
        {r.variance < 0 ? "over " : r.variance > 0 ? "under " : ""}{fmtMoney(Math.abs(r.variance))}
      </span>
    ) },
    { key: "pct", label: "%", align: "right", sortValue: (r) => r.pct ?? 0, render: (r) => r.pct != null ? (
      <span className={`text-xs tabular-nums ${varianceTone(r)}`}>{r.pct > 0 ? "+" : ""}{r.pct}%</span>
    ) : <span className="text-xs text-slate-400">—</span> },
    { key: "actions", label: "", align: "right", render: (r) => canEdit ? (
      <div className="flex items-center justify-end gap-1">
        <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setEditRow(r)}>Edit</Button>
        <Button size="sm" variant="ghost" className="h-7 text-xs text-rose-600 hover:text-rose-700 hover:bg-rose-500/10" onClick={() => setDeleting(r)}>Delete</Button>
      </div>
    ) : null },
  ]

  const totalBudget = data?.totals?.budget ?? 0
  const totalActual = data?.totals?.actual ?? 0
  const totalVariance = round2(totalBudget - totalActual)

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <StatCard label="Budget Lines" value={rows.length} sub={totalBudget > 0 ? `${((totalActual / totalBudget) * 100).toFixed(0)}% consumed` : "no budget set"} icon={Target} tone="slate" />
        <StatCard label="Total Budgeted" value={loading ? "…" : fmtMoney(totalBudget)} sub={periodFilter ? (periods.find((p) => p.id === periodFilter)?.name || "filtered") : "all periods"} icon={Wallet} tone="teal" />
        <StatCard label="Total Actual" value={loading ? "…" : fmtMoney(totalActual)} sub="POSTED journal lines (Σ|net|)" icon={BookOpen} tone="amber" />
        <StatCard label="Total Variance" value={loading ? "…" : fmtMoney(totalVariance)} sub={totalVariance < 0 ? "OVER budget in aggregate" : "headroom remaining"} icon={Scale} tone={totalVariance < 0 ? "rose" : "emerald"} />
      </div>

      <SectionCard title="Budget Lines" actions={
        <div className="flex items-center gap-2">
          <Select value={periodFilter || "all"} onValueChange={(v) => setPeriodFilter(v === "all" ? "" : v)}>
            <SelectTrigger className="w-56 h-8 text-sm" aria-label="Filter by period"><SelectValue placeholder="All periods" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All periods</SelectItem>
              {periods.map((p) => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}
            </SelectContent>
          </Select>
          {canEdit && (
            <Button size="sm" className="h-8 text-xs" onClick={() => setCreateOpen(true)}>
              <Plus className="h-3.5 w-3.5 mr-1" aria-hidden="true" /> New Budget Line
            </Button>
          )}
        </div>
      }>
        <p className="text-xs text-slate-500 mb-3">
          Actuals are recomputed from POSTED journal lines on the account (per-line |debit − credit|), scoped by the
          line&apos;s period dates and cost-center tag; <b>variance = budget − actual</b> (negative = over budget, shown red).
          Rows without a period read all history.
        </p>
        <DataTable
          columns={columns} rows={rows} loading={loading} error={error} searchable pageSize={20} csvName="budgets" dense
          emptyTitle="No budget lines yet"
          emptyHint="Budget an account — e.g. 5100 Salary and Wages for a period — and track actuals against it here."
        />
      </SectionCard>

      <FormDialog open={createOpen} onOpenChange={(v) => { setCreateOpen(v); if (!v) reload() }}
        title="New Budget Line" description="Actuals are recomputed live from posted journals — no double bookkeeping."
        fields={fields}
        onSubmit={save} />

      <FormDialog key={editRow?.id || "edit-budget"} open={!!editRow} onOpenChange={(v) => { if (!v) setEditRow(null); reload() }}
        title="Edit Budget Line" description={editRow ? `${editRow.accountCode} — ${editRow.accountName}` : undefined}
        fields={fields}
        initial={editRow ? {
          accountCode: editRow.accountCode,
          amount: editRow.budget,
          periodId: editRow.periodId || "",
          costCenterId: editRow.costCenterId || "",
          notes: editRow.notes || "",
        } : undefined}
        onSubmit={save} />

      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(v) => { if (!v) setDeleting(null) }}
        title="Delete this budget line?"
        message={`${deleting?.accountCode || ""} — ${deleting?.accountName || ""} · budget ${fmtMoney(deleting?.budget)}. Posted journals are never touched; only the plan row goes away.`}
        confirmLabel="Delete" danger requireReason
        onConfirm={async (reason) => {
          if (!deleting) return
          await rpc("accounting.budgets.delete", { id: deleting.id, ...(reason ? { reason } : {}) })
          reload()
        }}
      />
    </div>
  )
}

// ============ Standalone page views for the new Accounting sidebar items ============
// Each view below is registered in registry.tsx under its own view key (acc-coa,
// acc-vouchers, acc-approvals, acc-statements, acc-controls). They reuse the
// existing tab components — no new features; just a standalone page wrapper with
// a PageHeader and optional sub-tabs so the sidebar destinations land somewhere
// meaningful.

/** Chart of Accounts — standalone sidebar page */
export function AccCoaView() {
  return (
    <div className="space-y-4">
      <PageHeader
        title="Chart of Accounts"
        subtitle="View and manage the tenant's account hierarchy — assets, liabilities, equity, income and expenses. Account codes follow the system chart; custom mapping is available per account."
      />
      <CoaTab />
    </div>
  )
}

/** Voucher Entry — standalone sidebar page */
export function AccVouchersView() {
  const { reload: reloadStats } = useApi<any>("accounting.stats", {})
  return (
    <div className="space-y-4">
      <PageHeader
        title="Voucher Entry"
        subtitle="Create, review and post balanced journal vouchers. Every entry must balance to the paisa (H-9). Posted vouchers are immutable — void and reverse to correct errors."
      />
      <VouchersTab onPosted={() => { reloadStats() }} />
    </div>
  )
}

/** Voucher Approval — standalone sidebar page.
 *  Reuses VouchersTab which already shows the PENDING_APPROVAL queue at the top
 *  when the user has the accounting.approve permission (canApprove gate). */
export function AccApprovalsView() {
  const { reload: reloadStats } = useApi<any>("accounting.stats", {})
  return (
    <div className="space-y-4">
      <PageHeader
        title="Voucher Approval"
        subtitle="Review and approve pending journal vouchers submitted by team members. Approved vouchers are posted to the ledger; rejected ones return to draft."
      />
      <VouchersTab onPosted={() => { reloadStats() }} />
    </div>
  )
}

/** Statements — standalone sidebar page with Trial Balance, Balance Sheet, Cash Flow,
 *  Ledger Statement and Income Statement sub-tabs. */
export function AccStatementsView() {
  const { data: settingsData } = useApi<any>("settings.get")
  const company: ReportCompany = (settingsData?.general || {}) as ReportCompany
  const presetTab = useHrm((s) => (s.view?.key === "acc-statements" && (s.view?.params as any)?.tab) || undefined)

  const groups: SectionTabGroup[] = [
    { label: "Statements", tabs: [
      { value: "trialBalance",    label: "Trial Balance",     content: <TrialBalanceTab company={company} /> },
      { value: "balanceSheet",    label: "Balance Sheet",     content: <BalanceSheetTab company={company} /> },
      { value: "cashFlow",        label: "Cash Flow",         content: <CashFlowTab company={company} /> },
      { value: "ledger",          label: "Ledger Statement",  content: <LedgerTab /> },
      { value: "incomeStatement", label: "Income Statement",  content: <IncomeStatementTab company={company} /> },
    ] },
  ]

  return (
    <div className="space-y-4">
      <PageHeader
        title="Statements"
        subtitle="Financial statements generated from posted journal entries — trial balance, balance sheet, cash flow (direct method), per-account ledger and income statement."
      />
      <SectionTabs defaultValue={presetTab as string | undefined} groups={groups} />
    </div>
  )
}

/** Controls & Budgets — standalone sidebar page with Periods, Cost Centers and Budgets sub-tabs. */
export function AccControlsView() {
  const presetTab = useHrm((s) => (s.view?.key === "acc-controls" && (s.view?.params as any)?.tab) || undefined)

  const groups: SectionTabGroup[] = [
    { label: "Controls & Budgets", tabs: [
      { value: "periods",     label: "Periods",       content: <PeriodsTab /> },
      { value: "costCenters", label: "Cost Centers",  content: <CostCentersTab /> },
      { value: "budgets",     label: "Budgets",       content: <BudgetsTab /> },
    ] },
  ]

  return (
    <div className="space-y-4">
      <PageHeader
        title="Controls & Budgets"
        subtitle="Define accounting periods (soft-lock closed periods), organise cost centres for dimensional reporting, and set budget lines to track actual spend against targets."
      />
      <SectionTabs defaultValue={presetTab as string | undefined} groups={groups} />
    </div>
  )
}

"use client"
// ============ /owner/billing — Revenue & Collections console (Phase 5 P2) ====
// The revenue slice of the Owner Panel, rebuilt on the P0/P1 console design
// system. Data sources (all fixed-set, scale-first):
//   - owner.billing.overview — money KPIs (billed/collected MTD + 30d,
//     collection rate, avg days-to-pay), the PENDING aging strip, a 6-month
//     billed-vs-collected trend, payment method/provider mix, status mix.
//   - owner.billing.invoices — the workbench grid: the collection band and
//     days-overdue are computed IN SQL (chips filter server-side, severity
//     first, never materializes the invoice table).
//   - owner.billing.payments — the fleet-wide payment stream (manual + gateway
//     rows), paged in SQL, method/provider filters.
//   - owner.billing.collections — the dunning workbench: overdue PENDING
//     invoices worst-first with per-invoice reminder state; sending rides the
//     existing owner.dunning.remind (audited, same machinery as the daily
//     automatic pass).
// Mutations stay on the long-standing actions: owner.invoices.create and
// owner.invoices.markPaid (which records the SaaSPayment row, renews the term,
// emits the invoice.paid webhook) — the mark-paid flow is now a proper dialog
// instead of the old window.prompt.
import { useCallback, useEffect, useState } from "react"
import {
  AlertTriangle, BadgeCheck, Banknote, CalendarClock, ChevronLeft, ChevronRight, Clock3,
  CreditCard, FileText, Landmark, Loader2, Plus, RefreshCw, Search, Send, Wallet,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { useOwnerApi, ownerRpc } from "@/saas/owner/client"
import { ErrorBanner, KpiCard, Loading, PageHeader, StatusChip, TableShell, Td, fmtDate } from "@/saas/owner/ui"
import { cn } from "@/lib/utils"

// ---- types ------------------------------------------------------------------
type Overview = {
  generatedAt: string
  money: {
    billedMtd: number; billed30d: number; collectedMtd: number; collected30d: number
    collectionRate30d: number | null; avgDaysToPay90d: number | null; currency: string
  }
  open: { count: number; amount: number; overdueCount: number; overdueAmount: number }
  aging: Record<string, { count: number; amount: number }>
  trend: { month: string; billed: number; collected: number }[]
  methodMix: { key: string; count: number; amount: number }[]
  providerMix: { key: string; count: number; amount: number }[]
  statusMix: { key: string; count: number; amount: number }[]
}

type InvoiceRow = {
  id: string; number: string; vendorId: string; vendorName: string; vendorCode: string
  amount: number; currency: string; status: string
  periodStart: string; periodEnd: string; issuedAt: string; dueAt: string | null; paidAt: string | null
  method: string | null; transactionId: string | null; band: string; daysOverdue: number
}

type PaymentRow = {
  id: string; invoiceId: string; invoiceNumber: string; vendorId: string; vendorName: string
  amount: number; currency: string; method: string | null; status: string; paidAt: string
  transactionId: string | null; provider: string; providerTxnId: string | null
  failureReason: string | null; recordedByName: string | null; createdAt: string
}

type CollectionRow = {
  id: string; number: string; vendorId: string; vendorName: string
  amount: number; currency: string; issuedAt: string; dueAt: string
  daysOverdue: number; remindersSent: number; lastReminderAt: string | null
}

// ---- formatting + band metadata ---------------------------------------------
const fmtMoney = (n: number, currency = "BDT") =>
  `${currency === "BDT" ? "৳" : `${currency} `}${(Number(n) || 0).toLocaleString("en-IN")}`

const METHOD_LABEL: Record<string, string> = { BANK: "Bank transfer", CASH: "Cash", MFS: "Mobile FS", CARD: "Card" }
const PROVIDER_LABEL: Record<string, string> = { MANUAL: "Manual", SSLCOMMERZ: "SSLCommerz", BKASH: "bKash", NAGAD: "Nagad", PAYSTATION: "PayStation", EPS: "EPS" }

const BAND_META: Record<string, { label: string; chip: string }> = {
  OVERDUE_90: { label: "90+ days over", chip: "border-red-400/40 bg-red-500/10 text-red-300 light:text-red-600" },
  OVERDUE_61_90: { label: "61–90d over", chip: "border-red-400/40 bg-red-500/10 text-red-300 light:text-red-600" },
  OVERDUE_31_60: { label: "31–60d over", chip: "border-orange-400/40 bg-orange-500/10 text-orange-300 light:text-orange-700" },
  OVERDUE_16_30: { label: "16–30d over", chip: "border-orange-400/40 bg-orange-500/10 text-orange-300 light:text-orange-700" },
  OVERDUE_1_15: { label: "1–15d over", chip: "border-amber-400/40 bg-amber-500/10 text-amber-300 light:text-amber-700" },
  DUE_SOON: { label: "due ≤ 7d", chip: "border-sky-400/40 bg-sky-500/10 text-sky-300 light:text-sky-700" },
  CURRENT: { label: "on schedule", chip: "border-emerald-400/40 bg-emerald-500/10 text-emerald-300 light:text-emerald-700" },
  PAID: { label: "settled", chip: "border-emerald-400/40 bg-emerald-500/10 text-emerald-300 light:text-emerald-700" },
  FAILED: { label: "failed", chip: "border-red-400/40 bg-red-500/10 text-red-300 light:text-red-600" },
  REFUNDED: { label: "refunded", chip: "border-violet-400/40 bg-violet-500/10 text-violet-300 light:text-violet-700" },
  CANCELLED: { label: "cancelled", chip: "border-slate-400/40 bg-slate-500/10 text-slate-400 light:text-slate-600" },
}

const AGING_META: { key: string; label: string; tile: string }[] = [
  { key: "CURRENT", label: "Not yet due", tile: "border-white/10 light:border-slate-200" },
  { key: "DUE_1_15", label: "1–15 days", tile: "border-amber-400/30 bg-amber-500/[0.06] light:bg-amber-100/50" },
  { key: "DUE_16_30", label: "16–30 days", tile: "border-amber-400/40 bg-amber-500/[0.09] light:bg-amber-100/60" },
  { key: "DUE_31_60", label: "31–60 days", tile: "border-orange-400/40 bg-orange-500/[0.09] light:bg-orange-100/60" },
  { key: "DUE_61_90", label: "61–90 days", tile: "border-rose-400/40 bg-rose-500/[0.09] light:bg-rose-100/60" },
  { key: "OVERDUE_90", label: "90+ days", tile: "border-red-400/40 bg-red-500/[0.10] light:bg-red-100/60" },
]

const COLLECTION_CHIPS = [
  { key: "ALL", label: "All" },
  { key: "OVERDUE", label: "Overdue" },
  { key: "DUE_SOON", label: "Due ≤ 7d" },
  { key: "CURRENT", label: "Current" },
  { key: "SETTLED", label: "Settled" },
  { key: "CLOSED", label: "Closed" },
] as const
type CollectionChip = (typeof COLLECTION_CHIPS)[number]["key"]

/** The 6-month billed-vs-collected chart — pure CSS grouped bars. */
function TrendChart({ trend }: { trend: Overview["trend"] }) {
  const max = Math.max(1, ...trend.map((t) => Math.max(t.billed, t.collected)))
  return (
    <div className="rounded-2xl border border-white/10 light:border-slate-200 bg-white/[0.03] light:bg-slate-100/60 p-5">
      <div className="mb-1 flex items-center justify-between">
        <p className="text-xs font-bold uppercase tracking-widest text-slate-500">Billed vs collected — last 6 months</p>
        <div className="flex items-center gap-3 text-[10px] font-semibold text-slate-500">
          <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-indigo-400" /> Billed</span>
          <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-emerald-400" /> Collected</span>
        </div>
      </div>
      <p className="mb-4 text-[11px] text-slate-600 light:text-slate-500">Billed by issuance month; collected by settlement month (settled invoices only).</p>
      <div className="flex h-40 items-end gap-2 sm:gap-4">
        {trend.map((t) => (
          <div key={t.month} className="flex h-full flex-1 flex-col items-center justify-end gap-1.5">
            <div className="flex h-full w-full items-end justify-center gap-1" aria-hidden>
              <div
                className="w-full max-w-[22px] rounded-t-md bg-gradient-to-t from-indigo-600/70 to-indigo-400 transition-all"
                style={{ height: `${Math.max(t.billed > 0 ? 4 : 0, (t.billed / max) * 100)}%` }}
                title={`Billed ${fmtMoney(t.billed)}`}
              />
              <div
                className="w-full max-w-[22px] rounded-t-md bg-gradient-to-t from-emerald-600/70 to-emerald-400 transition-all"
                style={{ height: `${Math.max(t.collected > 0 ? 4 : 0, (t.collected / max) * 100)}%` }}
                title={`Collected ${fmtMoney(t.collected)}`}
              />
            </div>
            <span className="text-[10px] font-semibold tabular-nums text-slate-500">
              {new Date(`${t.month}-01T00:00:00Z`).toLocaleString("en", { month: "short", timeZone: "UTC" })}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

/** One horizontal mix bar (method / provider / status mix rows). */
function MixRow({ label, count, amount, max, tone }: { label: string; count: number; amount: number; max: number; tone: string }) {
  const pct = max > 0 ? Math.max(2, Math.round((amount / max) * 100)) : 0
  return (
    <div className="flex items-center gap-3">
      <span className="w-28 shrink-0 truncate text-xs font-semibold text-slate-300 light:text-slate-700" title={label}>{label}</span>
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-white/10 light:bg-slate-200">
        <div className={cn("h-full rounded-full", tone)} style={{ width: `${pct}%` }} />
      </div>
      <span className="w-24 shrink-0 text-right text-xs tabular-nums text-slate-400 light:text-slate-600">{fmtMoney(amount)}</span>
      <span className="w-14 shrink-0 text-right text-[10px] tabular-nums text-slate-600 light:text-slate-500">{count}×</span>
    </div>
  )
}

// ===== RENDER =====
type Tab = "invoices" | "payments" | "collections"
const TABS: { key: Tab; label: string; icon: any }[] = [
  { key: "invoices", label: "Invoices", icon: FileText },
  { key: "payments", label: "Payments", icon: Banknote },
  { key: "collections", label: "Collections", icon: CalendarClock },
]

export default function BillingPage() {
  const overview = useOwnerApi<Overview>("owner.billing.overview")
  const me = useOwnerApi<{ owner: { permissions: string[] } }>("owner.auth.me", {})
  const canManage = !!me.data?.owner?.permissions?.includes("billing.manage")
  const [tab, setTab] = useState<Tab>("invoices")
  const [toast, setToast] = useState<{ kind: "ok" | "err"; text: string } | null>(null)
  const showToast = useCallback((kind: "ok" | "err", text: string) => {
    setToast({ kind, text })
    setTimeout(() => setToast(null), 6000)
  }, [])

  // ---- invoices tab ---------------------------------------------------------
  const [invPage, setInvPage] = useState(1)
  const [invChip, setInvChip] = useState<CollectionChip>("ALL")
  const [invStatus, setInvStatus] = useState("ALL")
  const [invSearch, setInvSearch] = useState("")
  const [invQuery, setInvQuery] = useState("")
  const [invRows, setInvRows] = useState<InvoiceRow[]>([])
  const [invTotal, setInvTotal] = useState(0)
  const [invLoading, setInvLoading] = useState(true)
  const [invError, setInvError] = useState<string | null>(null)
  const [invPageSize] = useState(15)

  const loadInvoices = useCallback(async () => {
    setInvLoading(true); setInvError(null)
    try {
      const r = await ownerRpc<{ total: number; rows: InvoiceRow[] }>("owner.billing.invoices", {
        page: invPage, pageSize: invPageSize, collection: invChip, status: invStatus, search: invQuery || undefined,
      })
      setInvRows(r.rows); setInvTotal(r.total)
    } catch (e: any) { setInvError(e?.message || "Failed to load invoices") } finally { setInvLoading(false) }
  }, [invPage, invPageSize, invChip, invStatus, invQuery])
  useEffect(() => { loadInvoices().catch(() => {}) }, [loadInvoices])

  // ---- payments tab ---------------------------------------------------------
  const [payPage, setPayPage] = useState(1)
  const [payMethod, setPayMethod] = useState("ALL")
  const [payProvider, setPayProvider] = useState("ALL")
  const [paySearch, setPaySearch] = useState("")
  const [payQuery, setPayQuery] = useState("")
  const [payRows, setPayRows] = useState<PaymentRow[]>([])
  const [payTotal, setPayTotal] = useState(0)
  const [payLoading, setPayLoading] = useState(true)
  const [payError, setPayError] = useState<string | null>(null)
  const [payPageSize] = useState(15)

  const loadPayments = useCallback(async () => {
    setPayLoading(true); setPayError(null)
    try {
      const r = await ownerRpc<{ total: number; rows: PaymentRow[] }>("owner.billing.payments", {
        page: payPage, pageSize: payPageSize, method: payMethod, provider: payProvider, search: payQuery || undefined,
      })
      setPayRows(r.rows); setPayTotal(r.total)
    } catch (e: any) { setPayError(e?.message || "Failed to load payments") } finally { setPayLoading(false) }
  }, [payPage, payPageSize, payMethod, payProvider, payQuery])
  useEffect(() => { loadPayments().catch(() => {}) }, [loadPayments])

  // ---- collections tab --------------------------------------------------------
  const [colPage, setColPage] = useState(1)
  const [colSearch, setColSearch] = useState("")
  const [colQuery, setColQuery] = useState("")
  const [colRows, setColRows] = useState<CollectionRow[]>([])
  const [colTotal, setColTotal] = useState(0)
  const [colPolicy, setColPolicy] = useState<{ cadenceDays: number } | null>(null)
  const [colLoading, setColLoading] = useState(true)
  const [colError, setColError] = useState<string | null>(null)
  const [colPageSize] = useState(15)
  const [reminding, setReminding] = useState<string | null>(null)

  const loadCollections = useCallback(async () => {
    setColLoading(true); setColError(null)
    try {
      const r = await ownerRpc<{ total: number; rows: CollectionRow[]; policy: { cadenceDays: number } }>("owner.billing.collections", {
        page: colPage, pageSize: colPageSize, search: colQuery || undefined,
      })
      setColRows(r.rows); setColTotal(r.total); setColPolicy(r.policy)
    } catch (e: any) { setColError(e?.message || "Failed to load collections") } finally { setColLoading(false) }
  }, [colPage, colPageSize, colQuery])
  useEffect(() => { loadCollections().catch(() => {}) }, [loadCollections])

  const sendReminder = async (inv: CollectionRow) => {
    if (reminding) return
    setReminding(inv.id)
    try {
      const out = await ownerRpc<{ status: string; recipients: string[]; remindersSent: number; detail?: string }>(
        "owner.dunning.remind", { invoiceId: inv.id },
      )
      showToast("ok", out.status === "SENT"
        ? `Reminder sent for ${inv.number} → ${out.recipients.length} recipient(s) — reminder #${out.remindersSent} on record.`
        : `Reminder for ${inv.number}: ${out.status}${out.detail ? ` — ${out.detail}` : ""}. Check the platform email gateway under Settings.`)
      await loadCollections()
    } catch (e: any) { showToast("err", e?.message || "Failed to send the reminder") } finally { setReminding(null) }
  }

  // ---- record-payment dialog (replaces the old window.prompt) ----------------
  const [payDialog, setPayDialog] = useState<InvoiceRow | null>(null)
  const [payForm, setPayForm] = useState({ method: "BANK", transactionId: "" })
  const [payBusy, setPayBusy] = useState(false)
  const [payFormError, setPayFormError] = useState<string | null>(null)

  const recordPayment = async () => {
    if (!payDialog) return
    setPayBusy(true); setPayFormError(null)
    try {
      const out = await ownerRpc<{ extended: boolean }>("owner.invoices.markPaid", {
        id: payDialog.id, method: payForm.method, transactionId: payForm.transactionId.trim() || undefined,
      })
      showToast("ok", `${payDialog.number} recorded as PAID${out.extended ? " — subscription term extended one cycle" : ""}.`)
      setPayDialog(null); setPayForm({ method: "BANK", transactionId: "" })
      await Promise.all([loadInvoices(), overview.reload().catch(() => {})])
    } catch (e: any) { setPayFormError(e?.message || "Failed to record the payment") } finally { setPayBusy(false) }
  }

  // ---- new-invoice dialog -----------------------------------------------------
  const [createOpen, setCreateOpen] = useState(false)
  const [createBusy, setCreateBusy] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)
  const [form, setForm] = useState({ vendorId: "", amount: "", periodStart: "", periodEnd: "", dueAt: "", notes: "" })
  const tenants = useOwnerApi<{ rows: { id: string; name: string }[] }>("owner.tenants.list", { page: 1, pageSize: 200 })

  const createInvoice = async () => {
    setCreateBusy(true); setCreateError(null)
    try {
      const out = await ownerRpc<{ number: string }>("owner.invoices.create", {
        vendorId: form.vendorId,
        amount: Number(form.amount) || 0,
        periodStart: new Date(form.periodStart).toISOString(),
        periodEnd: new Date(form.periodEnd).toISOString(),
        dueAt: form.dueAt ? new Date(form.dueAt).toISOString() : undefined,
        notes: form.notes || undefined,
      })
      showToast("ok", `Invoice ${out.number} created.`)
      setCreateOpen(false); setForm({ vendorId: "", amount: "", periodStart: "", periodEnd: "", dueAt: "", notes: "" })
      await Promise.all([loadInvoices(), overview.reload().catch(() => {})])
    } catch (e: any) { setCreateError(e?.message || "Create failed") } finally { setCreateBusy(false) }
  }

  // ---- 60 s auto-refresh: the overview + whichever tab is active --------------
  useEffect(() => {
    const t = setInterval(() => {
      overview.reload().catch(() => {})
      if (tab === "invoices") loadInvoices().catch(() => {})
      else if (tab === "payments") loadPayments().catch(() => {})
      else loadCollections().catch(() => {})
    }, 60_000)
    return () => clearInterval(t)
  }, [tab, overview.reload, loadInvoices, loadPayments, loadCollections])

  const d = overview.data
  const money = d?.money
  const open = d?.open
  const invMaxPage = Math.max(1, Math.ceil(invTotal / invPageSize))
  const payMaxPage = Math.max(1, Math.ceil(payTotal / payPageSize))
  const colMaxPage = Math.max(1, Math.ceil(colTotal / colPageSize))
  const methodMax = Math.max(1, ...(d?.methodMix || []).map((m) => m.amount))
  const providerMax = Math.max(1, ...(d?.providerMix || []).map((m) => m.amount))

  return (
    <div className="space-y-5">
      <PageHeader
        title={
          <span className="flex items-center gap-2.5">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-emerald-500 to-teal-600 shadow-lg shadow-emerald-950/50">
              <Wallet className="h-4 w-4 text-white" />
            </span>
            Revenue &amp; Collections
          </span>
        }
        sub="Billing health across the fleet — money KPIs, invoice aging, the payment stream and the collections workbench. Manual records today; the schema is gateway-ready."
        actions={
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" disabled={overview.loading || invLoading}
              onClick={() => { overview.reload().catch(() => {}); if (tab === "invoices") loadInvoices().catch(() => {}); else if (tab === "payments") loadPayments().catch(() => {}); else loadCollections().catch(() => {}) }}>
              <RefreshCw className={cn("h-3.5 w-3.5", (overview.loading || invLoading) && "animate-spin")} /> Refresh
            </Button>
            {canManage && (
              <Button size="sm" onClick={() => setCreateOpen(true)} className="bg-gradient-to-r from-emerald-600 to-teal-600 text-white light:text-slate-900 hover:from-emerald-500 hover:to-teal-500">
                <Plus className="h-3.5 w-3.5" /> New invoice
              </Button>
            )}
          </div>
        }
      />

      {toast && (
        <div className={cn("flex items-center gap-2 rounded-xl border p-3 text-sm",
          toast.kind === "ok"
            ? "border-emerald-400/30 bg-emerald-500/10 text-emerald-300 light:text-emerald-700"
            : "border-red-400/30 bg-red-500/10 text-red-300 light:text-red-600")}>
          {toast.kind === "ok" ? <BadgeCheck className="h-4 w-4 shrink-0" /> : <AlertTriangle className="h-4 w-4 shrink-0" />}
          {toast.text}
        </div>
      )}
      {overview.error && <ErrorBanner message={overview.error} />}
      {overview.loading && !d ? <Loading label="Computing revenue analytics…" /> : money && open ? (
        <>
          {/* ---- money KPIs ---- */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <KpiCard label="Billed — this month" value={fmtMoney(money.billedMtd)} tone="indigo" icon={FileText}
              sub={`Trailing 30 days: ${fmtMoney(money.billed30d)}`} />
            <KpiCard label="Collected — this month" value={fmtMoney(money.collectedMtd)} tone="emerald" icon={Banknote}
              sub={money.collectionRate30d == null ? "Trailing 30 days: nothing billed yet" : `Collection rate (30d): ${money.collectionRate30d}% of ${fmtMoney(money.billed30d)}`} />
            <KpiCard label="Outstanding" value={fmtMoney(open.amount)} tone="amber" icon={Clock3}
              sub={`${open.count} open invoice${open.count === 1 ? "" : "s"} · avg days-to-pay (90d): ${money.avgDaysToPay90d == null ? "—" : money.avgDaysToPay90d}`} />
            <KpiCard label="Overdue" value={fmtMoney(open.overdueAmount)} tone={open.overdueCount > 0 ? "red" : "default"} icon={AlertTriangle}
              sub={open.overdueCount > 0 ? `${open.overdueCount} invoice${open.overdueCount === 1 ? "" : "s"} past due — see Collections` : "Nothing past due"} />
          </div>

          {/* ---- aging strip (PENDING invoices by how far past due) ---- */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
            {AGING_META.map((a) => {
              const b = d.aging[a.key] || { count: 0, amount: 0 }
              const hot = a.key !== "CURRENT" && b.count > 0
              return (
                <div key={a.key} className={cn("rounded-2xl border p-4", a.tile)}>
                  <p className="text-[10px] font-bold uppercase tracking-widest text-slate-500">{a.label}</p>
                  <p className={cn("mt-1.5 text-xl font-bold tabular-nums", hot ? "text-red-300 light:text-red-600" : "text-white light:text-slate-900")}>
                    {b.count}
                  </p>
                  <p className="mt-0.5 text-[11px] tabular-nums text-slate-500">{fmtMoney(b.amount)}</p>
                </div>
              )
            })}
          </div>

          {/* ---- trend + mixes ---- */}
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
            <div className="xl:col-span-2"><TrendChart trend={d.trend} /></div>
            <div className="space-y-4">
              <div className="rounded-2xl border border-white/10 light:border-slate-200 bg-white/[0.03] light:bg-slate-100/60 p-5">
                <p className="mb-3 text-xs font-bold uppercase tracking-widest text-slate-500">How money arrives — method mix</p>
                {d.methodMix.length ? (
                  <div className="space-y-2.5">
                    {d.methodMix.map((m) => (
                      <MixRow key={m.key} label={METHOD_LABEL[m.key] || m.key} count={m.count} amount={m.amount} max={methodMax} tone="bg-indigo-400" />
                    ))}
                  </div>
                ) : <p className="text-xs text-slate-600 light:text-slate-500">No settled payments recorded yet.</p>}
              </div>
              <div className="rounded-2xl border border-white/10 light:border-slate-200 bg-white/[0.03] light:bg-slate-100/60 p-5">
                <p className="mb-3 text-xs font-bold uppercase tracking-widest text-slate-500">Provider mix — settled payments</p>
                {d.providerMix.length ? (
                  <div className="space-y-2.5">
                    {d.providerMix.map((m) => (
                      <MixRow key={m.key} label={PROVIDER_LABEL[m.key] || m.key} count={m.count} amount={m.amount} max={providerMax} tone="bg-teal-400" />
                    ))}
                  </div>
                ) : <p className="text-xs text-slate-600 light:text-slate-500">No settled payments recorded yet.</p>}
              </div>
            </div>
          </div>
        </>
      ) : null}

      {/* ---- tab bar ---- */}
      <div className="-mx-1 overflow-x-auto scroll-thin px-1 pb-1" role="tablist" aria-label="Billing sections">
        <div className="flex min-w-max gap-1.5">
          {TABS.map((t) => (
            <button
              key={t.key} role="tab" aria-selected={tab === t.key} type="button" onClick={() => setTab(t.key)}
              className={cn("flex items-center gap-1.5 whitespace-nowrap rounded-lg px-3.5 py-2 text-[12px] font-semibold transition-colors",
                tab === t.key
                  ? "bg-gradient-to-r from-emerald-600 to-teal-600 text-white shadow-lg shadow-emerald-950/40"
                  : "border border-white/10 light:border-slate-200 text-slate-400 light:text-slate-600 hover:bg-white/5 light:hover:bg-slate-100 hover:text-white light:hover:text-slate-900")}>
              <t.icon className="h-3.5 w-3.5" /> {t.label}
            </button>
          ))}
        </div>
      </div>

      {/* ---- INVOICES tab ---- */}
      {tab === "invoices" && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex flex-wrap gap-1.5">
              {COLLECTION_CHIPS.map((c) => (
                <button key={c.key} type="button" onClick={() => { setInvChip(c.key); setInvPage(1) }}
                  className={cn("rounded-full border px-3 py-1 text-[11px] font-bold uppercase tracking-wider transition-colors",
                    invChip === c.key
                      ? c.key === "OVERDUE" ? "border-red-400/50 bg-red-500/15 text-red-300 light:text-red-600" : "border-emerald-400/50 bg-emerald-500/15 text-emerald-300 light:text-emerald-700"
                      : "border-white/10 light:border-slate-200 text-slate-500 light:text-slate-600 hover:bg-white/5 light:hover:bg-slate-100")}>
                  {c.label}
                </button>
              ))}
            </div>
            <Select value={invStatus} onValueChange={(v) => { setInvStatus(v); setInvPage(1) }}>
              <SelectTrigger className="h-9 w-40 border-white/10 light:border-slate-200 bg-white/5 light:bg-slate-100 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                {["ALL", "PENDING", "PAID", "FAILED", "REFUNDED", "CANCELLED"].map((s) => (
                  <SelectItem key={s} value={s}>{s === "ALL" ? "Any status" : s}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <form className="flex flex-1 items-center gap-2 sm:justify-end" onSubmit={(e) => { e.preventDefault(); setInvQuery(invSearch.trim()); setInvPage(1) }}>
              <div className="relative w-full max-w-xs">
                <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-500" />
                <Input value={invSearch} onChange={(e) => setInvSearch(e.target.value)} placeholder="Invoice # or tenant…" aria-label="Search invoices"
                  className="h-9 pl-9 text-xs border-white/10 light:border-slate-200 bg-white/5 light:bg-slate-100" />
              </div>
              <Button type="submit" size="sm" variant="outline" className="h-9 border-white/10 light:border-slate-200 bg-white/5 light:bg-slate-100">Find</Button>
            </form>
          </div>
          {invError && <ErrorBanner message={invError} />}
          {invLoading ? <Loading /> : (
            <TableShell headers={["Invoice", "Tenant", "Period", "Amount", "Status", "Collection", "Issued", "Due", "Paid", "Method / Txn", ""]} empty={invRows.length === 0}>
              {invRows.map((i) => {
                const band = BAND_META[i.band] || BAND_META.CURRENT
                return (
                  <tr key={i.id} className="transition-colors hover:bg-white/[0.03] light:hover:bg-slate-100/60">
                    <Td className="font-mono text-xs text-indigo-300 light:text-indigo-700">{i.number}</Td>
                    <Td className="text-xs">{i.vendorName}</Td>
                    <Td className="text-xs">{fmtDate(i.periodStart)} → {fmtDate(i.periodEnd)}</Td>
                    <Td className="tabular-nums">{fmtMoney(i.amount, i.currency)}</Td>
                    <Td><StatusChip status={i.status} /></Td>
                    <Td>
                      <span className={cn("inline-flex items-center rounded-full border px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-widest", band.chip)}>
                        {band.label}
                      </span>
                    </Td>
                    <Td className="text-xs">{fmtDate(i.issuedAt)}</Td>
                    <Td className="text-xs">{fmtDate(i.dueAt)}</Td>
                    <Td className="text-xs">{fmtDate(i.paidAt)}</Td>
                    <Td className="text-xs">{i.method ? (METHOD_LABEL[i.method] || i.method) : "—"}{i.transactionId ? ` · ${i.transactionId}` : ""}</Td>
                    <Td>
                      {canManage && i.status !== "PAID" && i.status !== "CANCELLED" && (
                        <Button size="sm" variant="outline" onClick={() => { setPayDialog(i); setPayForm({ method: i.method || "BANK", transactionId: "" }) }}
                          className="h-7 border-emerald-400/30 bg-emerald-500/10 text-[11px] text-emerald-300 light:text-emerald-700 hover:bg-emerald-500/20">
                          <CreditCard className="mr-1 h-3 w-3" /> Record payment
                        </Button>
                      )}
                    </Td>
                  </tr>
                )
              })}
            </TableShell>
          )}
          <div className="flex items-center justify-between text-xs text-slate-500">
            <span>{invTotal} invoice{invTotal === 1 ? "" : "s"}</span>
            <div className="flex items-center gap-2">
              <Button size="sm" variant="outline" disabled={invPage <= 1} onClick={() => setInvPage((p) => p - 1)}
                className="h-8 border-white/10 light:border-slate-200 bg-white/5 light:bg-slate-100"><ChevronLeft className="h-3.5 w-3.5" /></Button>
              <span className="tabular-nums">Page {invPage} / {invMaxPage}</span>
              <Button size="sm" variant="outline" disabled={invPage >= invMaxPage} onClick={() => setInvPage((p) => p + 1)}
                className="h-8 border-white/10 light:border-slate-200 bg-white/5 light:bg-slate-100"><ChevronRight className="h-3.5 w-3.5" /></Button>
            </div>
          </div>
        </div>
      )}

      {/* ---- PAYMENTS tab ---- */}
      {tab === "payments" && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <Select value={payMethod} onValueChange={(v) => { setPayMethod(v); setPayPage(1) }}>
              <SelectTrigger className="h-9 w-40 border-white/10 light:border-slate-200 bg-white/5 light:bg-slate-100 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                {["ALL", "BANK", "CASH", "MFS", "CARD"].map((s) => (
                  <SelectItem key={s} value={s}>{s === "ALL" ? "Any method" : (METHOD_LABEL[s] || s)}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={payProvider} onValueChange={(v) => { setPayProvider(v); setPayPage(1) }}>
              <SelectTrigger className="h-9 w-40 border-white/10 light:border-slate-200 bg-white/5 light:bg-slate-100 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                {["ALL", "MANUAL", "SSLCOMMERZ", "BKASH", "NAGAD"].map((s) => (
                  <SelectItem key={s} value={s}>{s === "ALL" ? "Any provider" : (PROVIDER_LABEL[s] || s)}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <form className="flex flex-1 items-center gap-2 sm:justify-end" onSubmit={(e) => { e.preventDefault(); setPayQuery(paySearch.trim()); setPayPage(1) }}>
              <div className="relative w-full max-w-xs">
                <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-500" />
                <Input value={paySearch} onChange={(e) => setPaySearch(e.target.value)} placeholder="Invoice #, txn or tenant…" aria-label="Search payments"
                  className="h-9 pl-9 text-xs border-white/10 light:border-slate-200 bg-white/5 light:bg-slate-100" />
              </div>
              <Button type="submit" size="sm" variant="outline" className="h-9 border-white/10 light:border-slate-200 bg-white/5 light:bg-slate-100">Find</Button>
            </form>
          </div>
          {payError && <ErrorBanner message={payError} />}
          {payLoading ? <Loading /> : (
            <TableShell headers={["Recorded", "Invoice", "Tenant", "Amount", "Method", "Provider", "Txn reference", "Recorded by", "Status"]} empty={payRows.length === 0}>
              {payRows.map((p) => (
                <tr key={p.id} className="transition-colors hover:bg-white/[0.03] light:hover:bg-slate-100/60">
                  <Td className="text-xs">{fmtDate(p.createdAt)}</Td>
                  <Td className="font-mono text-xs text-indigo-300 light:text-indigo-700">{p.invoiceNumber}</Td>
                  <Td className="text-xs">{p.vendorName}</Td>
                  <Td className="tabular-nums">{fmtMoney(p.amount, p.currency)}</Td>
                  <Td className="text-xs">{p.method ? (METHOD_LABEL[p.method] || p.method) : "—"}</Td>
                  <Td className="text-xs">{PROVIDER_LABEL[p.provider] || p.provider}</Td>
                  <Td className="text-xs"><span className="block max-w-40 truncate text-slate-400 light:text-slate-600" title={p.providerTxnId || p.transactionId || ""}>
                    {p.providerTxnId || p.transactionId || "—"}
                  </span></Td>
                  <Td className="text-xs">{p.recordedByName || (p.provider !== "MANUAL" ? "Gateway" : "—")}</Td>
                  <Td>
                    <StatusChip status={p.status} />
                    {p.failureReason && <p className="mt-0.5 max-w-44 truncate text-[10px] text-red-400 light:text-red-600" title={p.failureReason}>{p.failureReason}</p>}
                  </Td>
                </tr>
              ))}
            </TableShell>
          )}
          <div className="flex items-center justify-between text-xs text-slate-500">
            <span>{payTotal} payment{payTotal === 1 ? "" : "s"}</span>
            <div className="flex items-center gap-2">
              <Button size="sm" variant="outline" disabled={payPage <= 1} onClick={() => setPayPage((p) => p - 1)}
                className="h-8 border-white/10 light:border-slate-200 bg-white/5 light:bg-slate-100"><ChevronLeft className="h-3.5 w-3.5" /></Button>
              <span className="tabular-nums">Page {payPage} / {payMaxPage}</span>
              <Button size="sm" variant="outline" disabled={payPage >= payMaxPage} onClick={() => setPayPage((p) => p + 1)}
                className="h-8 border-white/10 light:border-slate-200 bg-white/5 light:bg-slate-100"><ChevronRight className="h-3.5 w-3.5" /></Button>
            </div>
          </div>
        </div>
      )}

      {/* ---- COLLECTIONS tab ---- */}
      {tab === "collections" && (
        <div className="space-y-3">
          <p className="flex items-start gap-2 rounded-xl border border-blue-400/25 bg-blue-500/10 p-3 text-sm text-blue-200 light:text-blue-700">
            <CalendarClock className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              Overdue PENDING invoices, worst-first, with each invoice&apos;s reminder state. The automatic pass sends at most one
              reminder per invoice every {colPolicy?.cadenceDays ?? 7} days; a manual send bypasses the cadence by design and is always audited.
              Reminders go to the tenant&apos;s admin users through the platform email gateway.
            </span>
          </p>
          <form className="flex flex-wrap items-center gap-2 sm:justify-end" onSubmit={(e) => { e.preventDefault(); setColQuery(colSearch.trim()); setColPage(1) }}>
            <div className="relative w-full max-w-xs">
              <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-500" />
              <Input value={colSearch} onChange={(e) => setColSearch(e.target.value)} placeholder="Invoice # or tenant…" aria-label="Search collections"
                className="h-9 pl-9 text-xs border-white/10 light:border-slate-200 bg-white/5 light:bg-slate-100" />
            </div>
            <Button type="submit" size="sm" variant="outline" className="h-9 border-white/10 light:border-slate-200 bg-white/5 light:bg-slate-100">Find</Button>
          </form>
          {colError && <ErrorBanner message={colError} />}
          {colLoading ? <Loading /> : (
            <TableShell headers={["Invoice", "Tenant", "Amount", "Overdue", "Due date", "Reminders", "Last reminder", ""]} empty={colRows.length === 0}>
              {colRows.map((c) => (
                <tr key={c.id} className="transition-colors hover:bg-white/[0.03] light:hover:bg-slate-100/60">
                  <Td className="font-mono text-xs text-indigo-300 light:text-indigo-700">{c.number}</Td>
                  <Td className="text-xs">{c.vendorName}</Td>
                  <Td className="tabular-nums">{fmtMoney(c.amount, c.currency)}</Td>
                  <Td>
                    <span className={cn("inline-flex items-center rounded-full border px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-widest",
                      c.daysOverdue >= 30 ? "border-red-400/40 bg-red-500/10 text-red-300 light:text-red-600"
                        : c.daysOverdue >= 7 ? "border-orange-400/40 bg-orange-500/10 text-orange-300 light:text-orange-700"
                        : "border-amber-400/40 bg-amber-500/10 text-amber-300 light:text-amber-700")}>
                      {c.daysOverdue}d
                    </span>
                  </Td>
                  <Td className="text-xs">{fmtDate(c.dueAt)}</Td>
                  <Td className="text-xs tabular-nums">{c.remindersSent}</Td>
                  <Td className="text-xs">{c.lastReminderAt ? fmtDate(c.lastReminderAt) : "—"}</Td>
                  <Td>
                    {canManage && (
                      <Button size="sm" variant="outline" disabled={reminding === c.id} onClick={() => sendReminder(c)}
                        className="h-7 border-sky-400/30 bg-sky-500/10 text-[11px] text-sky-300 light:text-sky-700 hover:bg-sky-500/20">
                        {reminding === c.id ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <Send className="mr-1 h-3 w-3" />} Remind
                      </Button>
                    )}
                  </Td>
                </tr>
              ))}
            </TableShell>
          )}
          <div className="flex items-center justify-between text-xs text-slate-500">
            <span>{colTotal} overdue invoice{colTotal === 1 ? "" : "s"}</span>
            <div className="flex items-center gap-2">
              <Button size="sm" variant="outline" disabled={colPage <= 1} onClick={() => setColPage((p) => p - 1)}
                className="h-8 border-white/10 light:border-slate-200 bg-white/5 light:bg-slate-100"><ChevronLeft className="h-3.5 w-3.5" /></Button>
              <span className="tabular-nums">Page {colPage} / {colMaxPage}</span>
              <Button size="sm" variant="outline" disabled={colPage >= colMaxPage} onClick={() => setColPage((p) => p + 1)}
                className="h-8 border-white/10 light:border-slate-200 bg-white/5 light:bg-slate-100"><ChevronRight className="h-3.5 w-3.5" /></Button>
            </div>
          </div>
        </div>
      )}

      {/* ---- record-payment dialog ---- */}
      <Dialog open={!!payDialog} onOpenChange={(o) => { if (!o) { setPayDialog(null); setPayFormError(null) } }}>
        <DialogContent className="max-w-md border-white/10 light:border-slate-200 bg-slate-950 light:bg-slate-50">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-white light:text-slate-900">
              <CreditCard className="h-4 w-4 text-emerald-400" /> Record payment
            </DialogTitle>
          </DialogHeader>
          {payDialog && (
            <>
              <div className="rounded-xl border border-white/10 light:border-slate-200 bg-white/[0.03] light:bg-slate-100/60 p-3 text-xs">
                <p className="font-mono text-indigo-300 light:text-indigo-700">{payDialog.number}</p>
                <p className="mt-1 text-slate-300 light:text-slate-700">{payDialog.vendorName}</p>
                <p className="mt-1.5 text-sm font-bold tabular-nums text-white light:text-slate-900">{fmtMoney(payDialog.amount, payDialog.currency)}</p>
                {payDialog.dueAt && <p className="mt-1 text-slate-500">Due {fmtDate(payDialog.dueAt)}</p>}
              </div>
              {payFormError && <p className="rounded-lg border border-red-400/30 bg-red-500/10 p-3 text-sm text-red-300 light:text-red-600">{payFormError}</p>}
              <div className="space-y-3">
                <div>
                  <Label className="text-xs text-slate-400 light:text-slate-600">Method</Label>
                  <Select value={payForm.method} onValueChange={(v) => setPayForm({ ...payForm, method: v })}>
                    <SelectTrigger className="mt-1.5 h-10 border-white/10 light:border-slate-200 bg-white/5 light:bg-slate-100"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {Object.entries(METHOD_LABEL).map(([k, v]) => <SelectItem key={k} value={k}>{v}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label className="text-xs text-slate-400 light:text-slate-600">Transaction reference (optional)</Label>
                  <Input value={payForm.transactionId} onChange={(e) => setPayForm({ ...payForm, transactionId: e.target.value })} maxLength={120}
                    placeholder="e.g. bank slip / MFS trx id" className="mt-1.5 h-10 border-white/10 light:border-slate-200 bg-white/5 light:bg-slate-100" />
                </div>
              </div>
              <p className="text-[11px] leading-relaxed text-slate-500">
                Marks the invoice PAID, records the payment row, and — for a term-linked invoice — renews the subscription
                immediately (the same path the payment gateway uses). The tenant is notified via the invoice.paid webhook.
              </p>
              <div className="mt-2 flex justify-end gap-2">
                <Button variant="outline" onClick={() => { setPayDialog(null); setPayFormError(null) }}
                  className="border-white/10 light:border-slate-200 bg-white/5 light:bg-slate-100 text-white light:text-slate-900">Cancel</Button>
                <Button onClick={recordPayment} disabled={payBusy}
                  className="bg-gradient-to-r from-emerald-600 to-teal-600 text-white light:text-slate-900">
                  {payBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <BadgeCheck className="h-4 w-4" />} Record payment
                </Button>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* ---- new-invoice dialog ---- */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-w-md border-white/10 light:border-slate-200 bg-slate-950 light:bg-slate-50">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-white light:text-slate-900">
              <Landmark className="h-4 w-4 text-teal-400" /> New invoice
            </DialogTitle>
          </DialogHeader>
          {createError && <p className="rounded-lg border border-red-400/30 bg-red-500/10 p-3 text-sm text-red-300 light:text-red-600">{createError}</p>}
          <div className="space-y-3">
            <div>
              <Label className="text-xs text-slate-400 light:text-slate-600">Tenant</Label>
              <Select value={form.vendorId} onValueChange={(v) => setForm({ ...form, vendorId: v })}>
                <SelectTrigger className="mt-1.5 h-10 border-white/10 light:border-slate-200 bg-white/5 light:bg-slate-100"><SelectValue placeholder="Choose tenant…" /></SelectTrigger>
                <SelectContent>
                  {(tenants.data?.rows || []).map((t) => <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-xs text-slate-400 light:text-slate-600">Amount (BDT)</Label>
              <Input type="number" min={0} max={9999999} step="0.01" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })}
                className="mt-1.5 h-10 border-white/10 light:border-slate-200 bg-white/5 light:bg-slate-100" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-xs text-slate-400 light:text-slate-600">Period start</Label>
                <Input type="date" value={form.periodStart} onChange={(e) => setForm({ ...form, periodStart: e.target.value })}
                  className="mt-1.5 h-10 border-white/10 light:border-slate-200 bg-white/5 light:bg-slate-100" />
              </div>
              <div>
                <Label className="text-xs text-slate-400 light:text-slate-600">Period end</Label>
                <Input type="date" value={form.periodEnd} onChange={(e) => setForm({ ...form, periodEnd: e.target.value })}
                  className="mt-1.5 h-10 border-white/10 light:border-slate-200 bg-white/5 light:bg-slate-100" />
              </div>
            </div>
            <div>
              <Label className="text-xs text-slate-400 light:text-slate-600">Due date (optional)</Label>
              <Input type="date" value={form.dueAt} onChange={(e) => setForm({ ...form, dueAt: e.target.value })}
                className="mt-1.5 h-10 border-white/10 light:border-slate-200 bg-white/5 light:bg-slate-100" />
            </div>
            <div>
              <Label className="text-xs text-slate-400 light:text-slate-600">Notes (optional)</Label>
              <Input value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} maxLength={1000}
                className="mt-1.5 h-10 border-white/10 light:border-slate-200 bg-white/5 light:bg-slate-100" />
            </div>
          </div>
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="outline" onClick={() => setCreateOpen(false)}
              className="border-white/10 light:border-slate-200 bg-white/5 light:bg-slate-100 text-white light:text-slate-900">Cancel</Button>
            <Button onClick={createInvoice} disabled={createBusy || !form.vendorId || !form.periodStart || !form.periodEnd}
              className="bg-gradient-to-r from-emerald-600 to-teal-600 text-white light:text-slate-900">
              {createBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />} Create invoice
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}


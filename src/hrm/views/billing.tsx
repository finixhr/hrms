"use client"
// ============ Billing & Subscription — the unified tenant billing portal ============
// 2026-10-25 (master prompt Part D §7): the former "Billing" and
// "Subscription & Usage" pages are ONE surface now — plan + renew + pay,
// invoices/payments/events, the plan catalog with self-service prorated
// upgrades, and live usage & limits. (subscription.tsx is a thin redirect.)
//
// Renewal semantics (Part F §9): "Renew for another cycle" NO LONGER extends
// the subscription — it issues the PENDING renewal invoice for the next term;
// the end date moves only when that invoice is PAID and verified.
//
// Checkout (Part E §8.1): the tenant never picks a gateway — billing.pay.start
// resolves the owner-configured ACTIVE gateway server-side; when none is
// active the server 400s and this UI falls back to the bank-transfer
// instructions.
//
// Self-service upgrades (§11): higher-priced plans quote up-front (new price −
// unused-time credit = amount due); confirming issues an UPGRADE-kind invoice
// whose payment applies the change at settlement. Cheaper plans stay
// REQUEST-ONLY (billing.planChangeRequest → owner approval).
//
// PENDING_PAYMENT (Part F §10): locked tenants keep full access to this page
// (the dispatcher exempts "billing.*"); a prominent banner + Pay Now on the
// initial invoice unlocks the workspace.

import { useCallback, useEffect, useState } from "react"
import { createPortal } from "react-dom"
import {
  ArrowUpRight, ArrowDownRight, RefreshCw, Download, CreditCard,
  AlertTriangle, Clock, CheckCircle2, Landmark, Receipt, History, Printer, X, FileText,
  Send, Lock, Wallet, Boxes, ShoppingCart, TrendingUp, UserRound, Cctv, MapPin, Globe, Mail, ShieldCheck, ArrowLeftRight,
} from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { useHrm } from "../store"
import { rpc, useApi } from "../api"
import { PageHeader, SectionCard, SectionTabs, StatusBadge, fmtDate, fmtDateTime, ErrorBanner, EmptyState, LoadingRows } from "../shared/ui-kit"
import { ConfirmDialog } from "../shared/form-dialog"
import { DataTable, type Column } from "../shared/data-table"
import { UsagePanel } from "../shared/usage-panel"

type Overview = {
  mode: string; status: string; planName: string | null; planId: string | null
  billingCycle: string | null; startDate: string | null; endDate: string | null; daysRemaining: number | null
  price: number | null; currency: string | null; readonly: boolean; renewalDue: boolean; vendorName: string | null
  features: Record<string, boolean> | null
  upcomingInvoice: { id: string; number: string; amount: number; currency: string; status: string; dueAt: string | null; periodStart: string; periodEnd: string } | null
  pendingDowngrade: { planId: string; planName: string; effectiveAt: string } | null
  /** Single-active-gateway surface (§8.1) — `active` marks the ONE gateway
   *  the owner activated; the tenant checkout uses it (or none → bank). */
  gateways: { id: string; label: string; enabled: boolean; active: boolean }[]
  bankInstructions: boolean
  stats: { invoicesTotal: number; outstandingAmount: number; lastPaidAt: string | null; lastPaidInvoice: string | null }
}
type PlanRow = { id: string; name: string; tagline: string | null; monthlyPrice: number; yearlyPrice: number; currency: string; badge: string | null; isTrialPlan: boolean; limits: Record<string, number | null>; features: Record<string, boolean> }
/** 2026-10-25 — rows carry kind ("TERM"|"UPGRADE") + upgradePlanId; optional
 *  here so the table degrades gracefully against an older payload. */
type InvoiceRow = { id: string; number: string; periodStart: string; periodEnd: string; amount: number; currency: string; status: string; issuedAt: string; dueAt: string | null; paidAt: string | null; method: string | null; transactionId: string | null; kind?: string | null; upgradePlanId?: string | null }
type PaymentRow = { id: string; invoiceNumber: string; amount: number; currency: string; providerLabel: string | null; method: string | null; status: string; paidAt: string | null; createdAt: string; failureReason: string | null; refundedAt: string | null; recordedByName: string | null }
type EventRow = { id: string; type: string; note: string | null; actorName: string | null; createdAt: string }
type RequestRow = { id: string; planName: string; mode: string; note: string | null; status: string; requestedByName: string | null; decidedByName: string | null; decidedAt: string | null; decisionNote: string | null; createdAt: string }
/** billing.renew — issues (or re-uses) the renewal invoice; NEVER extends. */
type RenewResult = { invoice: { id: string; number: string }; periodStart: string; periodEnd: string; amount: number; currency: string; reused: boolean; message: string }
/** billing.upgrade.quote — the prorated breakdown shown BEFORE confirming. */
type UpgradeQuote = { currentPlanName: string; currentPrice: number; targetPlanName: string; targetPlanId: string; billingCycle: string; newPrice: number; credit: number; amountDue: number; daysRemaining: number | null; message: string }
/** billing.upgrade.start — issues the UPGRADE invoice (pay to activate). */
type UpgradeStartResult = { invoice: { id: string; number: string }; amount: number; credit: number; newPrice: number; reused: boolean; message: string }
/** billing.pay.start — server-resolved gateway session; redirect the browser. */
type PayStartResult = { paymentId: string; provider: string; providerLabel?: string | null; sessionId: string | null; redirectUrl: string | null }
/** Minimal invoice shape the Pay Now dialog needs (table rows, the upcoming
 *  invoice from the overview, or a just-issued upgrade invoice). */
type PayTarget = { id: string; number: string; amount: number; currency?: string | null; periodStart?: string | null; periodEnd?: string | null }

function downloadBase64(name: string, base64: string) {
  const a = document.createElement("a")
  a.href = `data:application/pdf;base64,${base64}`
  a.download = name
  a.click()
}

// ---------------- subscription status chip (ALL statuses, incl. the new
// PENDING_PAYMENT full-lock state) ----------------
const SUB_STATUS: Record<string, { label: string; cls: string }> = {
  TRIAL: { label: "Trial", cls: "bg-sky-100 text-sky-700 dark:bg-sky-950 dark:text-sky-300" },
  ACTIVE: { label: "Active", cls: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300" },
  PAST_DUE: { label: "Past due — payment required", cls: "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300" },
  GRACE_PERIOD: { label: "Grace period", cls: "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300" },
  PENDING_PAYMENT: { label: "Payment pending — workspace locked", cls: "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300" },
  EXPIRED: { label: "Expired", cls: "bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300" },
  SUSPENDED: { label: "Suspended", cls: "bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300" },
  CANCELLED: { label: "Cancelled", cls: "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400" },
}
function SubStatusChip({ status }: { status?: string | null }) {
  if (!status) return <span className="text-slate-500 dark:text-slate-400">—</span>
  const meta = SUB_STATUS[status]
  if (!meta) return <StatusBadge status={status} />
  return (
    <Badge variant="secondary" className={`font-medium whitespace-nowrap gap-1.5 ${meta.cls}`}>
      <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-current opacity-80 shrink-0" />
      {meta.label}
    </Badge>
  )
}

export default function BillingView() {
  const { can, toast, vendor, subscription: subSnap } = useHrm()
  const canManage = can("billing", "manage")
  const canSeeCatalog = can("billing", "view")
  const presetTab = useHrm((s) => (s.view?.key === "billing" ? ((s.view?.params as any)?.tab as string | undefined) : undefined))
  const { data, loading, error, reload } = useApi<Overview>("billing.overview", {})
  const { data: invoiceData, reload: reloadInvoices } = useApi<{ rows: InvoiceRow[] }>("billing.invoices", { take: 100 })
  const { data: paymentData } = useApi<{ rows: PaymentRow[] }>("billing.payments", { take: 100 })
  const { data: eventData } = useApi<{ rows: EventRow[] }>("billing.events", { take: 50 })
  const { data: instructions } = useApi<{ instructions: string | null; supportEmail: string | null } | any>("billing.paymentInstructions", {})
  const { data: reqData, reload: reloadRequests } = useApi<{ rows: RequestRow[]; pending: boolean }>(canSeeCatalog ? "billing.planChangeRequests" : null, {})
  const [tab, setTab] = useState<string>(presetTab && ["overview", "invoices", "plans", "usage"].includes(presetTab) ? presetTab : "overview")
<<<<<<< HEAD
=======
  const [busy, setBusy] = useState<string | null>(null)
>>>>>>> origin/main
  const [renewOpen, setRenewOpen] = useState(false)
  const [payTarget, setPayTarget] = useState<PayTarget | null>(null)
  const [viewInvoice, setViewInvoice] = useState<InvoiceRow | null>(null)
  const [mushakInvoice, setMushakInvoice] = useState<InvoiceRow | null>(null)
  const [receiptInvoice, setReceiptInvoice] = useState<InvoiceRow | null>(null)
  const [upgradePlan, setUpgradePlan] = useState<PlanRow | null>(null)
  const [requestPlan, setRequestPlan] = useState<PlanRow | null>(null)

  const reloadAll = useCallback(() => { reload(); reloadInvoices() }, [reload, reloadInvoices])

<<<<<<< HEAD
=======
  const act = async (kind: string, fn: () => Promise<void>) => {
    setBusy(kind)
    try { await fn(); toast(`${kind} completed`, "ok"); reloadAll() }
    catch (e: any) { toast(String(e?.message || e), "err") }
    finally { setBusy(null) }
  }
>>>>>>> origin/main

  if (loading) {
    return (
      <div className="space-y-4">
        <PageHeader title="Billing & Subscription" subtitle="Loading your subscription…" />
        <LoadingRows rows={6} />
      </div>
    )
  }
  if (error || !data) {
    return (
      <div className="space-y-4">
        <PageHeader title="Billing & Subscription" subtitle={vendor?.name} />
        <ErrorBanner message={error || "Billing information is unavailable right now."} />
      </div>
    )
  }

  const legacy = data.mode === "LEGACY"
  const cur = data.currency === "BDT" ? "৳" : `${data.currency || ""} `
  const activeGateway = data.gateways.find((g) => g.active && g.enabled) || null
  const bankNote = instructions?.instructions || "Contact the platform owner for payment instructions."
  // Full-lock state (Part F §10): the auth.me snapshot carries the status (a
  // `locked` flag is mirrored if the payload ever exposes one); the overview
  // status is the belt-and-braces fallback.
  const locked = !legacy && (
    (subSnap as any)?.locked === true || subSnap?.status === "PENDING_PAYMENT" || data.status === "PENDING_PAYMENT"
  )
  const openInvoices = (invoiceData?.rows || []).filter((r) => r.status === "PENDING")

  const invoiceColumns: Column<InvoiceRow>[] = [
    {
      key: "number", label: "Invoice",
      render: (r) => (
        <span className="flex items-center gap-1.5">
          <span className="font-mono text-xs font-semibold">{r.number}</span>
          {r.kind === "UPGRADE" && (
            <Badge className="bg-violet-100 text-violet-700 dark:bg-violet-950 dark:text-violet-300 text-[9px] px-1.5" title="Plan upgrade invoice">Upgrade</Badge>
          )}
        </span>
      ),
    },
    { key: "period", label: "Period", render: (r) => <span className="text-xs">{fmtDate(r.periodStart.slice(0, 10))} → {fmtDate(r.periodEnd.slice(0, 10))}</span> },
    { key: "amount", label: "Amount", align: "right", render: (r) => <span className="text-sm font-semibold tabular-nums">{cur}{r.amount.toLocaleString()}</span> },
    { key: "status", label: "Status", render: (r) => <StatusBadge status={r.status} /> },
    { key: "dueAt", label: "Due", render: (r) => <span className="text-xs tabular-nums">{r.dueAt ? fmtDate(r.dueAt.slice(0, 10)) : "—"}</span> },
    {
      key: "actions", label: "", align: "right", render: (r) => (
        <div className="flex items-center justify-end gap-1">
          {/* single button — the server resolves the ACTIVE gateway (§8.1);
              a no-active-gateway 400 surfaces the bank-transfer fallback */}
          {r.status === "PENDING" && canManage && (
            <Button size="sm" className="h-7 text-xs gap-1" onClick={() => setPayTarget(r)}>
              <CreditCard className="h-3.5 w-3.5" /> Pay Now
            </Button>
          )}
          {r.status === "PAID" && (
            <Button size="sm" variant="outline" className="h-7 text-xs gap-1 text-emerald-700 dark:text-emerald-400 border-emerald-300 dark:border-emerald-800 hover:bg-emerald-50 dark:hover:bg-emerald-950/40" onClick={() => setReceiptInvoice(r)}>
              <Receipt className="h-3.5 w-3.5" /> Money Receipt
            </Button>
          )}
          {/* 2-page Invoice view & print */}
          <Button size="sm" variant="outline" className="h-7 text-xs gap-1" onClick={() => setViewInvoice(r)}>
            <FileText className="h-3.5 w-3.5" /> Invoice
          </Button>
          {/* Wave 4 BD compliance — Mushak 6.3 (BD VAT invoice format) print */}
          <Button size="sm" variant="outline" className="h-7 text-xs gap-1" onClick={() => setMushakInvoice(r)}>
            <Printer className="h-3.5 w-3.5" /> Mushak 6.3
          </Button>
        </div>
      ),
    },
  ]

  const paymentColumns: Column<PaymentRow>[] = [
    { key: "invoiceNumber", label: "Invoice", render: (r) => <span className="font-mono text-xs">{r.invoiceNumber}</span> },
    { key: "amount", label: "Amount", align: "right", render: (r) => <span className="text-sm tabular-nums">{cur}{r.amount.toLocaleString()}</span> },
    { key: "provider", label: "Via", render: (r) => <span className="text-xs">{r.providerLabel || r.method || "—"}</span> },
    { key: "status", label: "Status", render: (r) => <StatusBadge status={r.status} /> },
    { key: "paidAt", label: "Paid At", render: (r) => <span className="text-xs tabular-nums">{r.paidAt ? fmtDateTime(r.paidAt) : "—"}</span> },
    { key: "failureReason", label: "Note", render: (r) => r.failureReason ? <span className="text-xs text-rose-500 line-clamp-1 max-w-48 inline-block align-middle">{r.failureReason}</span> : <span className="text-slate-300">—</span> },
  ]

  return (
    <div className="space-y-5">
      <PageHeader
        title="Billing & Subscription"
        subtitle={`${vendor?.name || "Your workspace"} · plan, invoices, payments and live usage in one place — no waiting on the platform team`}
        actions={
          <div className="flex items-center gap-2">
            {legacy ? <Badge variant="secondary" className="text-xs">Direct-license workspace</Badge> : <SubStatusChip status={data.status} />}
            {data.renewalDue && (
              <Badge variant="outline" className="text-xs border-amber-400 text-amber-600 dark:text-amber-400">
                <Clock className="mr-1 h-3 w-3" /> Renewal due in {data.daysRemaining}d
              </Badge>
            )}
          </div>
        }
      />

      {/* full-lock banner (PENDING_PAYMENT) — pay the initial invoice to unlock */}
      {locked && (
        <div className="rounded-xl border border-amber-300 bg-amber-50 dark:bg-amber-950/40 dark:border-amber-800 p-4 text-sm text-amber-900 dark:text-amber-200 flex flex-wrap items-center gap-3">
          <Lock className="h-5 w-5 shrink-0" />
          <div className="min-w-0 flex-1">
            <p className="font-semibold">Complete your subscription payment to unlock your workspace</p>
            <p className="mt-0.5 text-amber-800/80 dark:text-amber-300/80">
              Your HR modules are locked until the initial invoice is paid{data.upcomingInvoice ? ` — invoice ${data.upcomingInvoice.number}, ${cur}${data.upcomingInvoice.amount.toLocaleString()}` : ""}. All data is safe.
            </p>
          </div>
          {canManage && data.upcomingInvoice && (
            <Button size="sm" className="h-8 gap-1.5 shrink-0" onClick={() => setPayTarget(data.upcomingInvoice)}>
              <CreditCard className="h-3.5 w-3.5" /> Pay Now
            </Button>
          )}
        </div>
      )}

      {data.readonly && (
        <div className="rounded-xl border border-red-200 bg-red-50 dark:bg-red-950/40 dark:border-red-900 p-4 text-sm text-red-800 dark:text-red-300 flex gap-3">
          <AlertTriangle className="h-5 w-5 shrink-0" />
          <div>
            <p className="font-semibold">Workspace is read-only</p>
            <p className="mt-0.5">The subscription is {String(data.status).toLowerCase()}. All data is safe; renew below or contact the platform owner to restore full access.</p>
          </div>
        </div>
      )}

      <SectionTabs
        value={tab}
        onValueChange={setTab}
        tabs={[
        { value: "overview", label: "Overview", content: (
          <div className="space-y-5">
            {/* payment required / failed — any outstanding balance */}
            {!legacy && data.stats.outstandingAmount > 0 && !locked && (
              <div className="rounded-xl border border-amber-200 dark:border-amber-900 bg-amber-50/70 dark:bg-amber-950/30 p-4 text-sm text-amber-800 dark:text-amber-300 flex flex-wrap items-center gap-3">
                <AlertTriangle className="h-5 w-5 shrink-0" />
                <div className="min-w-0 flex-1">
                  <p className="font-semibold">Payment required — {cur}{data.stats.outstandingAmount.toLocaleString()} outstanding</p>
                  <p className="mt-0.5">An open invoice is awaiting payment. Settle it to keep the workspace fully active{data.stats.lastPaidInvoice ? ` (last paid: ${data.stats.lastPaidInvoice})` : ""}.</p>
                </div>
                {canManage && data.upcomingInvoice && (
                  <Button size="sm" className="h-8 gap-1.5 shrink-0" onClick={() => setPayTarget(data.upcomingInvoice)}>
                    <CreditCard className="h-3.5 w-3.5" /> Pay Now
                  </Button>
                )}
              </div>
            )}

            <SectionCard title="Current Plan" actions={canManage && !legacy && (
<<<<<<< HEAD
              <Button size="sm" className="h-8 text-xs gap-1" onClick={() => setRenewOpen(true)}>
=======
              <Button size="sm" className="h-8 text-xs gap-1" disabled={!!busy} onClick={() => setRenewOpen(true)}>
>>>>>>> origin/main
                <RefreshCw className="h-3.5 w-3.5" /> Renew for another cycle
              </Button>
            )}>
              {legacy ? (
                <p className="text-sm text-slate-500 max-w-2xl">This workspace was provisioned before platform subscriptions were introduced — it runs with the full module set and no metered limits. Nothing changes.</p>
              ) : (
                <div className="grid gap-4 md:grid-cols-4">
                  <div>
                    <p className="text-xs uppercase tracking-wider text-slate-500">Plan</p>
                    <p className="mt-1 text-2xl font-bold tracking-tight">{data.planName || "—"}</p>
                    <div className="mt-1.5 flex flex-wrap items-center gap-2">
                      <SubStatusChip status={data.status} />
                      <span className="text-sm text-slate-500">{data.billingCycle === "YEARLY" ? "Yearly billing" : "Monthly billing"}</span>
                    </div>
                  </div>
                  <div>
                    <p className="text-xs uppercase tracking-wider text-slate-500">Term</p>
                    <p className="mt-1 text-sm font-semibold">{data.startDate ? fmtDate(data.startDate.slice(0, 10)) : "—"} → {data.endDate ? fmtDate(data.endDate.slice(0, 10)) : "—"}</p>
                    {data.daysRemaining != null && (
                      <p className={`mt-1 text-sm ${data.daysRemaining < 0 ? "text-red-600" : data.daysRemaining <= 14 ? "text-amber-600" : "text-slate-500"}`}>
                        {data.daysRemaining < 0 ? `expired ${Math.abs(data.daysRemaining)}d ago` : `${data.daysRemaining} days remaining`}
                      </p>
                    )}
                  </div>
                  <div>
                    <p className="text-xs uppercase tracking-wider text-slate-500">Price at assignment</p>
                    <p className="mt-1 text-lg font-semibold">{data.price != null ? `${cur}${data.price.toLocaleString()}/${data.billingCycle === "YEARLY" ? "yr" : "mo"}` : "—"}</p>
                    <p className="mt-1 text-xs text-slate-400">Plan prices are preserved for existing customers.</p>
                  </div>
                  <div className="flex items-end">
                    <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900 p-3 text-xs text-slate-600 dark:text-slate-300 w-full">
                      {activeGateway ? (
                        <>
                          <Landmark className="mb-1 h-4 w-4 text-emerald-600" />
                          <p>Online payments via <b>{activeGateway.label}</b> — the platform&apos;s active gateway.</p>
                        </>
                      ) : (
                        <>
                          <Landmark className="mb-1 h-4 w-4 text-slate-400" />
                          <p>No online gateway is active — pay by <b>bank transfer</b> (instructions on the Invoices &amp; Payments tab).</p>
                        </>
                      )}
                      <p className="mt-1.5">
                        {data.stats.outstandingAmount > 0
                          ? `Outstanding: ${cur}${data.stats.outstandingAmount.toLocaleString()} across open invoice(s).`
                          : "No outstanding invoices — you're all settled."}
                      </p>
                    </div>
                  </div>
                </div>
              )}
              {data.pendingDowngrade && (
                <div className="mt-3 rounded-lg border border-amber-200 dark:border-amber-900 bg-amber-50/60 dark:bg-amber-950/30 p-3 text-xs text-amber-800 dark:text-amber-300 flex items-center justify-between gap-2">
                  <span><ArrowDownRight className="inline h-3.5 w-3.5 mr-1" />Downgrade to <b>{data.pendingDowngrade.planName}</b> scheduled for {fmtDate(data.pendingDowngrade.effectiveAt.slice(0, 10))} (cycle end).</span>
                  {canManage && (
                    <span className="text-[11px]">Contact the platform owner to cancel before it applies.</span>
                  )}
                </div>
              )}
              {data.upcomingInvoice && (
                <div className="mt-3 rounded-lg border border-slate-200 dark:border-slate-800 p-3 text-xs flex flex-wrap items-center justify-between gap-2">
                  <span className="text-slate-600 dark:text-slate-300">
                    Next invoice <b className="font-mono">{data.upcomingInvoice.number}</b>{data.upcomingInvoice.status === "PENDING" ? "" : ` (${data.upcomingInvoice.status.toLowerCase()})`} · {cur}{data.upcomingInvoice.amount.toLocaleString()} · {data.upcomingInvoice.dueAt ? `due ${fmtDate(data.upcomingInvoice.dueAt.slice(0, 10))}` : "open"}
                  </span>
                  {canManage && data.upcomingInvoice.status === "PENDING" && (
                    <Button size="sm" className="h-7 text-xs gap-1" onClick={() => setPayTarget(data.upcomingInvoice)}>
                      <CreditCard className="h-3.5 w-3.5" /> Pay Now
                    </Button>
                  )}
                </div>
              )}
            </SectionCard>
          </div>
        ) },
        { value: "invoices", label: "Invoices & Payments", badge: openInvoices.length || undefined, badgeTone: "amber", content: (
          <SectionTabs tabs={[
            { value: "inv", label: "Invoices", content: (
              <div className="space-y-3">
                {!activeGateway && data.bankInstructions && (
                  <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900 p-4 text-sm">
                    <p className="font-semibold text-xs uppercase tracking-wide text-slate-500 mb-1">Payment instructions (bank transfer)</p>
                    <p className="whitespace-pre-wrap text-slate-600 dark:text-slate-300 text-sm">{bankNote}</p>
                  </div>
                )}
                <DataTable columns={invoiceColumns} rows={invoiceData?.rows || []} pageSize={12} csvName="invoices" emptyTitle="No invoices yet" emptyHint="Invoices appear here when your subscription is created, renewed or upgraded." />
              </div>
            ) },
            { value: "pay", label: "Payment History", content: (
              <DataTable columns={paymentColumns} rows={paymentData?.rows || []} pageSize={12} emptyTitle="No payments recorded" emptyHint="Gateway payments and owner-recorded payments appear here." />
            ) },
            { value: "ev", label: "Events", content: (
              !eventData?.rows.length ? <EmptyState icon={History} title="No subscription events yet" /> : (
                <div className="divide-y divide-slate-100 dark:divide-slate-800">
                  {eventData.rows.map((e) => (
                    <div key={e.id} className="flex items-start justify-between gap-3 py-2.5">
                      <div className="min-w-0">
                        <Badge variant="outline" className="text-[10px]">{e.type}</Badge>
                        <p className="text-sm mt-1">{e.note || "—"}</p>
                        <p className="text-xs text-slate-400">{e.actorName || "system"}</p>
                      </div>
                      <span className="text-xs tabular-nums text-slate-400 shrink-0">{fmtDateTime(e.createdAt)}</span>
                    </div>
                  ))}
                </div>
              )
            ) },
          ]} />
        ) },
        { value: "plans", label: "Plans & Upgrade", content: (
          !legacy ? (
            <PlanCatalog
              overview={data}
              currency={cur}
              canManage={canManage}
              canRequest={canSeeCatalog}
              reqData={reqData}
              onUpgradePlan={setUpgradePlan}
              onRequestPlan={setRequestPlan}
            />
          ) : (
            <SectionCard title="Available Plans">
              <p className="text-sm text-slate-500 max-w-2xl">This workspace runs on a direct license — plan and billing are managed by the platform owner.</p>
            </SectionCard>
          )
        ) },
        { value: "usage", label: "Usage", content: (
          <div className="space-y-5">
            <SectionCard title="Usage & Limits" actions={<span className="text-xs text-slate-400">live counts</span>}>
              <UsagePanel onUpgrade={() => setTab("plans")} />
              <p className="mt-3 text-xs text-slate-400">
                Storage counts employee photos, documents, leave attachments and selfie attendance proofs stored for your organization.
              </p>
            </SectionCard>
            {!legacy && data.features && (
              <SectionCard title="Modules in Your Plan">
                <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                  {FEATURE_META.map((f) => {
                    const on = !!data.features?.[f.key]
                    const Icon = f.icon
                    return (
                      <div
                        key={f.key}
                        className={`flex items-center gap-2.5 rounded-lg border p-3 ${
                          on
                            ? "border-emerald-200 bg-emerald-50/60 dark:border-emerald-900 dark:bg-emerald-950/30"
                            : "border-slate-200 bg-slate-50 dark:border-slate-800 dark:bg-slate-900"
                        }`}
                      >
                        <Icon className={`h-4 w-4 shrink-0 ${on ? "text-emerald-600" : "text-slate-400"}`} />
                        <span className={`text-sm font-medium ${on ? "" : "text-slate-400"}`}>{f.label}</span>
                        <span className={`ml-auto text-[10px] font-bold uppercase tracking-wider ${on ? "text-emerald-600" : "text-slate-400"}`}>
                          {on ? "included" : "not in plan"}
                        </span>
                      </div>
                    )
                  })}
                </div>
              </SectionCard>
            )}
          </div>
        ) },
      ]} />

      {/* renewal confirm — NEW semantics: invoice first, extension only after verified payment */}
      <ConfirmDialog
        open={renewOpen}
        onOpenChange={setRenewOpen}
        title="Renew subscription"
        message="This issues the renewal invoice for the next term — your subscription extends ONLY after the payment is verified. Nothing changes until you complete the payment."
        confirmLabel="Issue renewal invoice"
        onConfirm={async () => {
          const res = await rpc<RenewResult>("billing.renew", {})
          toast(res?.message || "Renewal invoice issued — complete the payment to extend your subscription.", "ok")
          reloadAll()
        }}
      />

      {/* gateway Pay Now dialog (WP-I, §8.1 — server picks the ACTIVE gateway) */}
      {payTarget && (
        <PayNowDialog
          target={payTarget}
          currency={cur}
          activeGatewayLabel={activeGateway?.label || null}
          bankInstructions={data.bankInstructions ? bankNote : null}
          onClose={() => setPayTarget(null)}
        />
      )}

      {/* self-service upgrade quote → confirm → invoice (§11) */}
      {upgradePlan && (
        <UpgradeQuoteDialog
          plan={upgradePlan}
          cycle={data.billingCycle}
          currency={cur}
          onClose={() => setUpgradePlan(null)}
          onStarted={(res) => {
            setUpgradePlan(null)
            reloadAll()
            setTab("invoices")
            setPayTarget({ id: res.invoice.id, number: res.invoice.number, amount: res.amount, currency: data.currency, periodStart: null, periodEnd: null })
          }}
        />
      )}

      {/* cheaper plans / non-managers — request-only plan change (owner approval) */}
      {requestPlan && (
        <RequestPlanDialog
          plan={requestPlan}
          currentPlanName={data.planName}
          cycle={data.billingCycle}
          currentPrice={data.price}
          onClose={() => setRequestPlan(null)}
          onSubmitted={() => { setRequestPlan(null); reloadRequests(); reloadAll() }}
        />
      )}

      {/* 2-page standard invoice view & print */}
      {viewInvoice && <InvoiceViewDialog invoiceId={viewInvoice.id} onClose={() => setViewInvoice(null)} />}

      {/* Official Money Receipt view & print */}
      {receiptInvoice && <MoneyReceiptDialog invoiceId={receiptInvoice.id} onClose={() => setReceiptInvoice(null)} />}

      {/* Wave 4 BD compliance — Mushak 6.3 print */}
      {mushakInvoice && <MushakDialog invoiceId={mushakInvoice.id} onClose={() => setMushakInvoice(null)} />}
    </div>
  )
}

/** Plan catalog: self-service PRORATED UPGRADES for higher-priced public
 *  plans (quote → UPGRADE invoice → pay to activate); cheaper plans (and
 *  roles without billing.manage) stay on the owner-approved request flow. */
function PlanCatalog({ overview, currency, canManage, canRequest, reqData, onUpgradePlan, onRequestPlan }: {
  overview: Overview
  currency: string
  canManage: boolean
  canRequest: boolean
  reqData: { rows: RequestRow[]; pending: boolean } | null
  onUpgradePlan: (p: PlanRow) => void
  onRequestPlan: (p: PlanRow) => void
}) {
  const { data: planData } = useApi<{ plans: PlanRow[]; currentPlanId: string | null; currentCycle: string | null }>("billing.plans", {})
  const plans = (planData?.plans || []).filter((p) => !p.isTrialPlan)
  const cycle = planData?.currentCycle || overview.billingCycle
  const currentPlanId = planData?.currentPlanId || overview.planId
  if (!plans.length) return null
  return (
    <SectionCard
      title="Available Plans"
      actions={
        canManage ? (
          <Badge variant="outline" className="text-[10px] text-amber-600 border-amber-200 dark:border-amber-900">upgrades pay-to-activate · downgrades owner-approved</Badge>
        ) : (
          <Badge variant="outline" className="text-[10px] text-amber-600 border-amber-200 dark:border-amber-900">owner approval required</Badge>
        )
      }
    >
      {(reqData?.pending || (reqData?.rows || []).length > 0) && (
        <div className="mb-4 space-y-2">
          {(reqData?.rows || []).slice(0, 3).map((r) => (
            <div key={r.id} className={`flex flex-wrap items-center gap-2 rounded-lg border px-3 py-2 text-xs ${r.status === "PENDING" ? "border-amber-200 dark:border-amber-900 bg-amber-50/60 dark:bg-amber-950/20" : "border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900"}`}>
              <ArrowLeftRight className="h-3.5 w-3.5 shrink-0 text-slate-400" />
              <span className="font-medium">{r.planName} · {r.mode.toLowerCase()}</span>
              <StatusBadge status={r.status === "PENDING" ? "PENDING" : r.status === "APPROVED" ? "ACTIVE" : "CANCELLED"} />
              <span className="ml-auto text-slate-400">
                {r.status === "PENDING"
                  ? `requested ${fmtDate(r.createdAt.slice(0, 10))} — awaiting the platform owner`
                  : `${r.status.toLowerCase()}${r.decidedByName ? ` by ${r.decidedByName}` : ""}${r.decidedAt ? ` · ${fmtDateTime(r.decidedAt)}` : ""}`}
              </span>
              {r.decisionNote && <p className="w-full text-slate-500">Note: {r.decisionNote}</p>}
            </div>
          ))}
        </div>
      )}
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {plans.map((p) => {
          const price = cycle === "YEARLY" ? p.yearlyPrice : p.monthlyPrice
          const current = p.id === currentPlanId
          const isUpgrade = overview.price == null ? true : price >= overview.price
          const featureCount = Object.values(p.features).filter(Boolean).length
          return (
            <div key={p.id} className={`rounded-xl border p-4 flex flex-col gap-3 ${current ? "border-emerald-300 dark:border-emerald-800 bg-emerald-50/40 dark:bg-emerald-950/20" : "border-slate-200 dark:border-slate-800"}`}>
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="font-semibold">{p.name}</p>
                  {p.tagline && <p className="text-xs text-slate-500 mt-0.5 line-clamp-2">{p.tagline}</p>}
                </div>
                {p.badge && <Badge className="bg-emerald-100 text-emerald-700 text-[10px]">{p.badge}</Badge>}
              </div>
              <p className="text-2xl font-bold">{currency}{price.toLocaleString()}<span className="text-xs font-normal text-slate-400">/{cycle === "YEARLY" ? "yr" : "mo"}</span></p>
              <p className="text-xs text-slate-500">{featureCount} modules · up to {p.limits.employeeLimit?.toLocaleString() ?? "∞"} employees · {p.limits.storageGb?.toLocaleString() ?? "—"} GB storage</p>
              <div className="mt-auto">
                {current ? (
                  <Badge variant="outline" className="w-full justify-center border-emerald-300 text-emerald-600 text-xs py-1"><CheckCircle2 className="h-3 w-3 mr-1" /> Current plan</Badge>
                ) : canManage && isUpgrade ? (
                  <Button size="sm" className="h-8 text-xs w-full gap-1" onClick={() => onUpgradePlan(p)}>
                    <ArrowUpRight className="h-3.5 w-3.5" /> Upgrade
                  </Button>
                ) : canRequest ? (
                  <Button size="sm" variant="outline" className="h-8 text-xs w-full gap-1" disabled={!!reqData?.pending} onClick={() => onRequestPlan(p)}>
                    <Send className="h-3.5 w-3.5" /> {reqData?.pending ? "request pending…" : "Request change"}
                  </Button>
                ) : null}
              </div>
            </div>
          )
        })}
      </div>
      <p className="mt-3 text-[11px] text-slate-400">
        Upgrades are prorated: your unused time on the current plan becomes credit against the new plan&apos;s price, and the change applies only after the upgrade invoice is paid and verified.
      </p>
    </SectionCard>
  )
}

/** Pay Now — one button, no gateway picker: billing.pay.start resolves the
 *  owner-configured ACTIVE gateway server-side and returns a redirectUrl. A
 *  400 "no active gateway" answer surfaces the bank-transfer fallback. */
function PayNowDialog({ target, currency, activeGatewayLabel, bankInstructions, onClose }: {
  target: PayTarget
  currency: string
  activeGatewayLabel: string | null
  bankInstructions: string | null
  onClose: () => void
}) {
  const { toast } = useHrm()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const cur = target.currency ? (target.currency === "BDT" ? "৳" : `${target.currency} `) : currency

  const pay = async () => {
    setBusy(true)
    setError(null)
    try {
      const res = await rpc<PayStartResult>("billing.pay.start", { invoiceId: target.id })
      if (res?.redirectUrl) {
        window.location.href = res.redirectUrl
        return
      }
      toast("Gateway session started — follow the provider's instructions", "ok")
      onClose()
    } catch (e: any) {
      const msg = String(e?.message || e)
      setError(msg)
      toast(msg, "err")
    } finally { setBusy(false) }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4" onClick={() => { if (!busy) onClose() }}>
      <div className="w-full max-w-md rounded-xl bg-white dark:bg-slate-950 p-5 shadow-2xl space-y-4" onClick={(e) => e.stopPropagation()}>
        <div>
          <p className="font-semibold flex items-center gap-2"><CreditCard className="h-4 w-4 text-emerald-600" /> Pay Invoice {target.number}</p>
          <p className="text-sm text-slate-500 mt-1">
            {cur}{target.amount.toLocaleString()}{target.periodStart && target.periodEnd ? ` · ${fmtDate(target.periodStart.slice(0, 10))} → ${fmtDate(target.periodEnd.slice(0, 10))}` : ""}
          </p>
        </div>
        <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900 p-3 text-xs text-slate-600 dark:text-slate-300">
          {activeGatewayLabel ? (
            <p>You will be redirected to <b>{activeGatewayLabel}</b> — this platform&apos;s active payment gateway. On success the invoice is marked paid, your subscription updates automatically and a receipt is emailed.</p>
          ) : (
            <p>No online payment gateway is active on this platform right now — use the bank-transfer instructions below, or contact the platform owner.</p>
          )}
        </div>
        {error && <div role="alert" className="rounded-lg border border-rose-200 dark:border-rose-900 bg-rose-50 dark:bg-rose-950/40 p-3 text-xs text-rose-700 dark:text-rose-300">{error}</div>}
        {(!!error || !activeGatewayLabel) && bankInstructions && (
          <div className="rounded-lg border border-slate-200 dark:border-slate-800 p-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-1">Bank transfer instructions</p>
            <p className="whitespace-pre-wrap text-xs text-slate-600 dark:text-slate-300">{bankInstructions}</p>
          </div>
        )}
        <div className="flex gap-2 justify-end">
          <Button size="sm" variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button size="sm" className="gap-1.5" disabled={busy} onClick={pay}>
            <Receipt className="h-3.5 w-3.5" /> {busy ? "Starting…" : activeGatewayLabel ? `Pay ${cur}${target.amount.toLocaleString()} now` : "Try online payment"}
          </Button>
        </div>
      </div>
    </div>
  )
}

/** Upgrade quote dialog: fetches the server-computed proration BEFORE the
 *  tenant confirms (new price − unused-time credit = amount due). Confirming
 *  issues the UPGRADE invoice — the plan changes only at settlement. */
function UpgradeQuoteDialog({ plan, cycle, currency, onClose, onStarted }: {
  plan: PlanRow
  cycle: string | null
  currency: string
  onClose: () => void
  onStarted: (res: UpgradeStartResult) => void
}) {
  const { toast } = useHrm()
  const [quote, setQuote] = useState<UpgradeQuote | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let alive = true
    setLoading(true)
    setError(null)
    rpc<UpgradeQuote>("billing.upgrade.quote", { planId: plan.id, ...(cycle ? { billingCycle: cycle } : {}) })
      .then((q) => { if (alive) setQuote(q) })
      .catch((e: any) => { if (alive) setError(String(e?.message || e)) })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [plan.id, cycle])

  const start = async () => {
    setBusy(true)
    setError(null)
    try {
      const res = await rpc<UpgradeStartResult>("billing.upgrade.start", { planId: plan.id, ...(cycle ? { billingCycle: cycle } : {}) })
      toast(res?.message || `Upgrade invoice ${res?.invoice?.number} issued.`, "ok")
      onStarted(res)
    } catch (e: any) {
      setError(String(e?.message || e))
      toast(String(e?.message || e), "err")
    } finally { setBusy(false) }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4" onClick={() => { if (!busy) onClose() }}>
      <div className="w-full max-w-md rounded-xl bg-white dark:bg-slate-950 p-5 shadow-2xl space-y-4" onClick={(e) => e.stopPropagation()}>
        <div>
          <p className="font-semibold flex items-center gap-2"><ArrowUpRight className="h-4 w-4 text-emerald-600" /> Upgrade to {plan.name}</p>
          <p className="text-sm text-slate-500 mt-1">Prorated, server-computed — the exact amount payable before you confirm.</p>
        </div>

        {loading && <div className="rounded-lg border border-slate-200 dark:border-slate-800 p-4 text-sm text-slate-500">Preparing your upgrade quote…</div>}
        {error && !loading && <div role="alert" className="rounded-lg border border-rose-200 dark:border-rose-900 bg-rose-50 dark:bg-rose-950/40 p-3 text-xs text-rose-700 dark:text-rose-300">{error}</div>}

        {quote && !loading && (
          <>
            <table className="w-full text-sm">
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                <tr>
                  <td className="py-2 text-slate-500">Current plan</td>
                  <td className="py-2 text-right">{quote.currentPlanName} · {currency}{quote.currentPrice.toLocaleString()}</td>
                </tr>
                <tr>
                  <td className="py-2 text-slate-500">New plan ({quote.billingCycle === "YEARLY" ? "yearly" : "monthly"})</td>
                  <td className="py-2 text-right font-semibold">{quote.targetPlanName} · {currency}{quote.newPrice.toLocaleString()}</td>
                </tr>
                <tr>
                  <td className="py-2 text-slate-500">Unused-time credit{quote.daysRemaining != null ? ` (${quote.daysRemaining}d remaining)` : ""}</td>
                  <td className="py-2 text-right text-emerald-600">− {currency}{quote.credit.toLocaleString()}</td>
                </tr>
                <tr>
                  <td className="py-2.5 font-bold">Amount due now</td>
                  <td className="py-2.5 text-right text-lg font-bold tabular-nums">{currency}{quote.amountDue.toLocaleString()}</td>
                </tr>
              </tbody>
            </table>
            <p className="text-xs text-slate-500">{quote.message}</p>
            {quote.amountDue > 0 ? (
              <p className="text-[11px] text-slate-400">
                Your current plan stays active unchanged until the payment is verified — the new plan activates at settlement.
              </p>
            ) : (
              <div className="rounded-lg border border-amber-200 dark:border-amber-900 bg-amber-50/70 dark:bg-amber-950/30 p-3 text-xs text-amber-800 dark:text-amber-300">
                This upgrade is fully covered by your unused-time credit — no invoice is issued. Submit a plan-change request instead and the platform owner will apply it.
              </div>
            )}
            <div className="flex gap-2 justify-end">
              <Button size="sm" variant="outline" onClick={onClose} disabled={busy}>{quote.amountDue > 0 ? "Cancel" : "Close"}</Button>
              {quote.amountDue > 0 && (
                <Button size="sm" className="gap-1.5" disabled={busy} onClick={start}>
                  <Receipt className="h-3.5 w-3.5" /> {busy ? "Issuing…" : "Issue upgrade invoice"}
                </Button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  )
}

/** Request-only plan change (cheaper plans, or roles without billing.manage):
 *  submits a SaasPlanChangeRequest the owner console approves/rejects. */
function RequestPlanDialog({ plan, currentPlanName, cycle, currentPrice, onClose, onSubmitted }: {
  plan: PlanRow
  currentPlanName: string | null
  cycle: string | null
  currentPrice: number | null
  onClose: () => void
  onSubmitted: () => void
}) {
  const { toast } = useHrm()
  const [note, setNote] = useState("")
  const [busy, setBusy] = useState(false)
  const price = cycle === "YEARLY" ? plan.yearlyPrice : plan.monthlyPrice
  const mode = currentPrice == null || price >= currentPrice ? "UPGRADE" : "DOWNGRADE"

  const submit = async () => {
    setBusy(true)
    try {
      await rpc("billing.planChangeRequest", { planId: plan.id, mode, note: note.trim() || undefined })
      toast("Request submitted — the platform owner will decide. Its status appears on the Plans & Upgrade tab.")
      onSubmitted()
    } catch (e: any) {
      toast(e?.message || "Failed to submit request", "err")
    } finally { setBusy(false) }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 dark:bg-black/60 p-4" onClick={() => { if (!busy) onClose() }}>
      <div className="w-full max-w-md rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6" onClick={(e) => e.stopPropagation()}>
        <p className="text-base font-semibold">Request Plan Change</p>
        <p className="mt-1 text-sm text-slate-500">
          {currentPlanName || "Current plan"} → <b>{plan.name}</b> ({price.toLocaleString()} {plan.currency}/{cycle === "YEARLY" ? "yr" : "mo"})
        </p>
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Note for the platform owner (optional) — e.g. why you need the change, timing…"
          maxLength={500}
          className="mt-4 min-h-24 w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-transparent p-3 text-sm"
        />
        <div className="mt-4 flex items-center justify-end gap-2">
          <button className="rounded-md px-3 py-2 text-xs font-medium text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800" onClick={onClose} disabled={busy}>Cancel</button>
          <button
            className="rounded-md bg-emerald-600 px-3 py-2 text-xs font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
            disabled={busy}
            onClick={submit}
          >
            {busy ? "Submitting…" : "Submit Request"}
          </button>
        </div>
        <p className="mt-3 text-[11px] text-slate-400">
          The request is recorded and auditable. If approved, the change applies with the same semantics as an owner-console change and appears in your subscription events immediately — your current plan is unchanged until then.
        </p>
      </div>
    </div>
  )
}

/** Module entitlements grid (merged from the former Subscription & Usage page). */
const FEATURE_META: { key: string; label: string; icon: any }[] = [
  { key: "PAYROLL", label: "Payroll & Finance", icon: Wallet },
  { key: "AIT", label: "AIT / Income Tax", icon: Landmark },
  { key: "INVENTORY", label: "Stock Inventory", icon: Boxes },
  { key: "PROCUREMENT", label: "Requisition & Purchase", icon: ShoppingCart },
  { key: "PERFORMANCE", label: "Performance & KPI", icon: TrendingUp },
  { key: "ESS", label: "Employee Self-Service", icon: UserRound },
  { key: "CAMERA", label: "Camera Manager", icon: Cctv },
  { key: "TRACKING", label: "Live Employee Tracking", icon: MapPin },
  { key: "GEOFENCE", label: "Geo-Fence", icon: ShieldCheck },
  { key: "API", label: "API Access", icon: ArrowUpRight },
  { key: "ADVANCED_REPORTS", label: "Advanced Reports", icon: History },
]

// ================= 2-Page Standard Invoice View & Print Dialog =================
function InvoiceViewDialog({ invoiceId, onClose }: { invoiceId: string; onClose: () => void }) {
  const { data, loading, error } = useApi<{
    invoice: any
    vendor: { name: string; legalName: string; address: string; phone: string | null; email: string | null }
    billingSettings: any
    generalSettings?: any
    payments: any[]
  }>("billing.invoice.get", { id: invoiceId })
  const [downloading, setDownloading] = useState(false)
  const [qrUrl, setQrUrl] = useState("")

  useEffect(() => {
    if (data?.invoice && data?.billingSettings) {
      if (data.billingSettings.mfsQrUrl) {
        setQrUrl(data.billingSettings.mfsQrUrl)
        return
      }
      import("qrcode").then((mod) => {
        const QRCode = (mod as any).default || mod
        const merchant = data.billingSettings.mfsMerchantNumber || data.billingSettings.bkashMerchantNumber || ""
        if (!merchant) return // S2b-008: no fallback merchant number — owner must configure in Owner Console → Settings → Billing
        const provider = data.billingSettings.mfsProviderName || "bKash"
        const payload = `${provider}:MakePayment:Merchant=${merchant}:Amount=${data.invoice.amount}:Ref=${data.invoice.number}`
        QRCode.toDataURL(payload, { width: 140, margin: 1 }).then((u: string) => setQrUrl(u)).catch(() => {})
      }).catch(() => {})
    }
  }, [data])

  const handleDownloadPdf = async () => {
    if (!data?.invoice) return
    setDownloading(true)
    try {
      const res = await rpc<{ filename: string; base64: string }>("billing.invoice.pdf", { invoiceId: data.invoice?.id || invoiceId })
      downloadBase64(res.filename, res.base64)
    } catch (err: any) {
      alert(err?.message || "Failed to download PDF invoice")
    } finally {
      setDownloading(false)
    }
  }

  if (loading) {
    return createPortal(
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
        <div className="rounded-xl bg-white p-6 shadow-xl dark:bg-slate-900 text-slate-800 dark:text-slate-100 flex items-center gap-3">
          <RefreshCw className="h-5 w-5 animate-spin text-blue-600" />
          <span>Loading invoice details...</span>
        </div>
      </div>,
      document.body,
    )
  }

  if (error || !data) {
    return createPortal(
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
        <div className="rounded-xl bg-white p-6 shadow-xl dark:bg-slate-900 max-w-md w-full">
          <p className="font-semibold text-rose-600">Failed to load invoice</p>
          <p className="text-sm mt-1 text-slate-600 dark:text-slate-300">{error || "Invoice not found"}</p>
          <div className="mt-4 flex justify-end">
            <Button size="sm" onClick={onClose}>Close</Button>
          </div>
        </div>
      </div>,
      document.body,
    )
  }

  const { invoice: inv, vendor: ven, billingSettings: bs, generalSettings: gs, payments } = data
  const total = Number(inv.amount) || 0
  const vatRate = Number(inv.vatRatePercent ?? 5.0)
  const net = Number(inv.netAmount ?? (vatRate > 0 ? total / (1 + vatRate / 100) : total))
  const vat = Number(inv.vatAmount ?? (total - net))
  const isPaid = inv.status === "PAID"
  const paid = Number(inv.paidAmount ?? (isPaid ? total : 0))
  const due = Number(inv.dueAmount ?? (total - paid))

  const platformName = gs?.platformName || "Finix HR"
  const tagline = gs?.tagline || "Standalone HRM & Workforce Platform"
  const companyAddress = gs?.address || bs.companyAddress || "House 11, Road 6, Sector 16/A, Uttara, Dhaka - 1230"
<<<<<<< HEAD
=======
  const companyPhone = gs?.supportPhone || bs.companyPhone || "+8809643666888"
>>>>>>> origin/main
  const companyEmail = gs?.supportEmail || bs.companyEmail || "service@finixhr.com"
  const companyWebsite = gs?.websiteUrl || (bs.companyWebsite ? (bs.companyWebsite.startsWith("http") ? bs.companyWebsite : `https://${bs.companyWebsite}`) : "https://hrm.finixmart.com.bd")
  const logoUrl = gs?.logoUrl || ""

  return createPortal(
    <div id="finix-invoice-print-root" className="fixed inset-0 z-50 overflow-y-auto bg-slate-900/60 p-4 print:bg-white print:p-0 print:static print:overflow-visible backdrop-blur-sm">
      <style>{`
        @page {
          size: A4 portrait;
          margin: 6mm 10mm;
        }
        @media print {
          body > *:not(#finix-invoice-print-root) { display: none !important; }
          #finix-invoice-print-root {
            position: static !important; inset: auto !important; display: block !important;
            background: #fff !important; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif !important;
            padding: 0 !important; margin: 0 !important;
          }
          #finix-invoice-print-root .invoice-toolbar { display: none !important; }
          #finix-invoice-print-root .invoice-page-sheet {
            box-shadow: none !important; border: none !important; margin: 0 auto !important;
            width: 190mm !important; max-width: 190mm !important;
            min-height: auto !important; height: auto !important;
            padding: 10px 14px !important;
            box-sizing: border-box !important;
            break-inside: avoid !important;
            page-break-inside: avoid !important;
          }
          #finix-invoice-print-root td, #finix-invoice-print-root th {
            padding: 2.5px 4px !important;
          }
        }
      `}</style>

      {/* Floating Toolbar (Screen only) */}
      <div className="invoice-toolbar sticky top-0 z-20 mx-auto flex max-w-[210mm] flex-wrap items-center justify-between gap-2 rounded-xl bg-white/95 p-3.5 shadow-xl backdrop-blur dark:bg-slate-900/95 border border-slate-200 dark:border-slate-800 print:hidden mb-4">
        <div>
          <p className="text-sm font-bold text-slate-900 dark:text-slate-100 flex items-center gap-2">
            <span>Invoice #{inv.number}</span>
            <Badge className={isPaid ? "bg-emerald-600 text-white" : "bg-amber-600 text-white"}>
              {isPaid ? "PAID" : "UNPAID"}
            </Badge>
          </p>
          <p className="text-xs text-slate-500">Official Tax Invoice</p>
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="default" className="h-8 gap-1.5 text-xs bg-blue-600 hover:bg-blue-700 text-white" disabled={downloading} onClick={handleDownloadPdf}>
            {downloading ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />} Download PDF
          </Button>
          <Button size="sm" variant="outline" className="h-8 gap-1.5 text-xs" onClick={() => window.print()}>
            <Printer className="h-3.5 w-3.5" /> Print
          </Button>
          <Button size="sm" variant="outline" className="h-8 gap-1.5 text-xs" onClick={onClose}>
            <X className="h-3.5 w-3.5" /> Close
          </Button>
        </div>
      </div>

      <div className="mx-auto max-w-[210mm] space-y-6 print:space-y-0">
        {/* =========================================================================
            SINGLE PAGE A4 INVOICE
        ========================================================================= */}
        <div className="invoice-page-sheet rounded-lg border border-slate-200 bg-white p-7 text-slate-900 shadow-2xl relative flex flex-col justify-between min-h-[285mm]">
          <div>
            {/* 1. Header (Logo + Contact matching Money Receipt) */}
            <div className="flex items-start justify-between pb-2.5">
              <div className="flex items-center gap-3">
                {logoUrl ? (
                  <img src={logoUrl} alt="Logo" className="h-10 max-w-32 object-contain rounded" />
                ) : (
                  <div className="h-10 w-10 rounded-lg bg-blue-600 flex items-center justify-center text-white font-black text-2xl shadow-sm">
                    F
                  </div>
                )}
                <div>
                  <h1 className="text-2xl font-black tracking-tight text-slate-900">{platformName}</h1>
                  <p className="text-xs text-slate-500">{tagline}</p>
                </div>
              </div>
              <div className="text-right text-xs space-y-0.5">
                <p className="font-bold text-slate-900">{platformName}</p>
                <p className="text-slate-500 text-[11px]">Smarter People. Stronger Teams.</p>
                <p className="text-slate-600 text-[11px] flex items-center justify-end gap-1.5">
                  <Globe className="h-3 w-3 text-blue-600 shrink-0" />
                  <span>{companyWebsite}</span>
                </p>
                <p className="text-slate-600 text-[11px] flex items-center justify-end gap-1.5">
                  <Mail className="h-3 w-3 text-blue-600 shrink-0" />
                  <span>{companyEmail}</span>
                </p>
                <p className="text-slate-600 text-[11px] flex items-center justify-end gap-1.5">
                  <MapPin className="h-3 w-3 text-blue-600 shrink-0" />
                  <span>{companyAddress}</span>
                </p>
              </div>
            </div>

            {/* Blue Divider Line */}
            <div className="h-0.5 w-full bg-blue-600 my-2" />

            {/* Invoice Info & Mushak Header */}
            <div className="flex items-start justify-between border-b border-slate-200 pb-3">
              <div>
                <h1 className="text-lg font-bold tracking-tight text-slate-900">Invoice # {inv.number}</h1>
                <p className="mt-0.5 text-xs text-slate-600"><span className="font-semibold">Date Issued:</span> {fmtDate(inv.issuedAt.slice(0, 10))}</p>
                <p className="text-xs text-slate-600"><span className="font-semibold">Due Date:</span> {inv.dueAt ? fmtDate(inv.dueAt.slice(0, 10)) : "—"}</p>
              </div>
              <div className="text-right">
                <p className="text-sm font-bold text-slate-900">Mushak-6.3 Tax Invoice</p>
                <p className="text-xs text-slate-600">{bs.companyLegalName || "Finix HR Ltd."}</p>
                <p className="text-xs font-semibold text-slate-800">BIN: {bs.companyBin || "009377515-0111"}</p>
              </div>
            </div>

            {/* INVOICE TO & PAYMENT DETAILS */}
            <div className="grid grid-cols-2 gap-4 py-3 border-b border-slate-200 text-xs">
              <div>
                <p className="font-bold uppercase tracking-wider text-slate-500 mb-1">INVOICE TO:</p>
                <p className="font-bold text-slate-900 text-sm">{ven.legalName || ven.name}</p>
                <p className="text-slate-600 mt-0.5 whitespace-pre-line">{ven.address || "Dhaka, Bangladesh"}</p>
                <p className="text-slate-600 mt-0.5">{[ven.phone, ven.email].filter(Boolean).join(", ")}</p>
              </div>
              <div className="text-right">
                <p className="font-bold uppercase tracking-wider text-slate-500 mb-1">PAYMENT DETAILS:</p>
                <p className="text-slate-700"><span className="font-medium text-slate-500">Invoice Amount:</span> <span className="font-semibold text-slate-900">{total.toFixed(2)} BDT</span></p>
                <p className="text-slate-700 mt-0.5"><span className="font-medium text-slate-500">Total Due:</span> <span className="font-bold text-slate-900">{due.toFixed(2)} BDT</span></p>
                <p className="text-slate-700 mt-0.5"><span className="font-medium text-slate-500">Paid Amount:</span> <span className="font-semibold text-slate-900">{paid.toFixed(2)} BDT</span></p>
                <div className="mt-1 flex items-center justify-end gap-1.5">
                  <span className="font-medium text-slate-500">Invoice Status:</span>
                  <span className={`inline-block px-2.5 py-0.5 rounded text-[11px] font-bold text-white ${isPaid ? "bg-emerald-600" : "bg-rose-600"}`}>
                    {isPaid ? "PAID" : "UNPAID"}
                  </span>
                </div>
              </div>
            </div>

            {/* Description Line Items Table */}
            <table className="mt-3 w-full border-collapse border border-slate-300 text-xs">
              <thead>
                <tr className="bg-slate-100 text-slate-800">
                  <th className="border border-slate-300 p-2 text-left font-bold">Description</th>
                  <th className="border border-slate-300 p-2 text-center font-bold w-16">Quantity</th>
                  <th className="border border-slate-300 p-2 text-right font-bold w-24">Unit Price</th>
                  <th className="border border-slate-300 p-2 text-right font-bold w-24">Total</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td className="border border-slate-300 p-2 align-top">
                    <p className="font-bold text-slate-900 text-xs">Finix HR - {inv.planName} Subscription</p>
                    <p className="text-slate-500 text-[11px]">Billing Cycle: {inv.billingCycle.toLowerCase()} | Period: {fmtDate(inv.periodStart.slice(0, 10))} - {fmtDate(inv.periodEnd.slice(0, 10))}</p>
                    <p className="text-slate-500 text-[10px]">Cloud HR, Payroll, Attendance &amp; Workforce Management Platform</p>
                  </td>
                  <td className="border border-slate-300 p-2 text-center align-top tabular-nums">1.00</td>
                  <td className="border border-slate-300 p-2 text-right align-top tabular-nums font-medium">Tk {net.toFixed(2)}</td>
                  <td className="border border-slate-300 p-2 text-right align-top tabular-nums font-semibold">Tk {net.toFixed(2)}</td>
                </tr>
                <tr>
                  <td colSpan={3} className="border border-slate-300 p-1.5 text-right font-medium text-slate-600">Subtotal</td>
                  <td className="border border-slate-300 p-1.5 text-right font-semibold tabular-nums">Tk {net.toFixed(2)}</td>
                </tr>
                <tr>
                  <td colSpan={3} className="border border-slate-300 p-1.5 text-right font-medium text-slate-600">VAT ({vatRate}% inclusive)</td>
                  <td className="border border-slate-300 p-1.5 text-right font-semibold tabular-nums">Tk {vat.toFixed(2)}</td>
                </tr>
                <tr>
                  <td colSpan={3} className="border border-slate-300 p-1.5 text-right font-medium text-slate-600">Paid</td>
                  <td className="border border-slate-300 p-1.5 text-right font-semibold tabular-nums">(-) Tk {paid.toFixed(2)}</td>
                </tr>
                <tr className="bg-slate-100 font-bold text-slate-900 text-xs">
                  <td colSpan={3} className="border border-slate-300 p-1.5 text-right">Total Due</td>
                  <td className="border border-slate-300 p-1.5 text-right tabular-nums text-sm">Tk {due.toFixed(2)}</td>
                </tr>
              </tbody>
            </table>

            {/* TRANSACTIONS Table */}
            <div className="mt-3">
              <p className="font-bold text-[11px] uppercase tracking-wider text-slate-700 mb-1">TRANSACTIONS</p>
              <table className="w-full border-collapse border border-slate-300 text-xs">
                <thead>
                  <tr className="bg-slate-100 text-slate-800">
                    <th className="border border-slate-300 p-1.5 text-left font-semibold">Transaction Date</th>
                    <th className="border border-slate-300 p-1.5 text-left font-semibold">Gateway</th>
                    <th className="border border-slate-300 p-1.5 text-left font-semibold">Transaction ID</th>
                    <th className="border border-slate-300 p-1.5 text-right font-semibold">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {payments && payments.length > 0 ? (
                    payments.map((pm: any) => (
                      <tr key={pm.id}>
                        <td className="border border-slate-300 p-1.5 tabular-nums">{fmtDate(pm.paidAt?.slice(0, 10))}</td>
                        <td className="border border-slate-300 p-1.5">{pm.providerLabel || pm.provider || pm.method}</td>
                        <td className="border border-slate-300 p-1.5 font-mono">{pm.providerTxnId || pm.transactionId || "—"}</td>
                        <td className="border border-slate-300 p-1.5 text-right tabular-nums font-semibold">Tk {Number(pm.amount).toFixed(2)}</td>
                      </tr>
                    ))
                  ) : (
                    <tr>
                      <td colSpan={4} className="border border-slate-300 p-1.5 text-slate-500 text-center italic text-[11px]">No transaction data available.</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            {/* SIDE-BY-SIDE PAYMENT METHODS (Left: Two Banks, Right: MFS/QR) */}
            <div className="mt-3 grid grid-cols-2 gap-3 text-xs">
              {/* Left Box: Bank Transfer / Deposit (Primary Bank + Secondary Bank) */}
              <div className="rounded border border-slate-300 p-2.5 bg-slate-50/70">
                <p className="font-bold text-[#162055] uppercase tracking-wide text-[11px] mb-1.5 pb-1 border-b border-slate-200">
                  BANK TRANSFER / DEPOSIT
                </p>
                <div className="space-y-1 text-[11px]">
                  <p className="font-bold text-slate-900">{bs.primaryBankName || "—"}</p>
                  <p className="text-slate-600"><span className="font-medium">A/C No:</span> <span className="font-mono font-bold text-slate-900">{bs.primaryAccountNo || "—"}</span></p>
                  <p className="text-slate-600"><span className="font-medium">A/C Name:</span> <span className="font-medium text-slate-800">{bs.primaryAccountName || bs.companyLegalName || "—"}</span></p>
                  <div className="flex items-center justify-between text-slate-600 text-[10px]">
                    <span><span className="font-medium">Branch:</span> {bs.primaryBranch || "—"}</span>
                    <span><span className="font-medium">Routing:</span> <span className="font-mono">{bs.primaryRouting || "—"}</span></span>
                  </div>
                </div>

                {(bs.secondaryBankName || bs.secondaryAccountNo) && (
                  <div className="mt-2 pt-1.5 border-t border-slate-200 space-y-1 text-[11px]">
                    <p className="font-bold text-slate-900">{bs.secondaryBankName || "—"}</p>
                    <p className="text-slate-600"><span className="font-medium">A/C No:</span> <span className="font-mono font-bold text-slate-900">{bs.secondaryAccountNo || "—"}</span></p>
                    <p className="text-slate-600"><span className="font-medium">A/C Name:</span> <span className="font-medium text-slate-800">{bs.secondaryAccountName || bs.companyLegalName || "Finix HR Ltd."}</span></p>
                    <div className="flex items-center justify-between text-slate-600 text-[10px]">
                      <span><span className="font-medium">Branch:</span> {bs.secondaryBranch || "Satmasjid Road Branch"}</span>
                      <span><span className="font-medium">Routing:</span> <span className="font-mono">{bs.secondaryRouting || "060276074"}</span></span>
                    </div>
                  </div>
                )}
              </div>

              {/* Right Box: MFS / Bangla QR / bKash / Nagad Payment */}
              <div className="rounded border border-slate-300 p-2.5 bg-white">
                <p className="font-bold text-[#d12053] uppercase tracking-wide text-[11px] mb-1.5 pb-1 border-b border-slate-200">
                  {(bs.mfsProviderName || "bKash / Bangla QR").toUpperCase()} PAYMENT
                </p>
                <div className="flex items-start gap-2.5">
                  <div className="shrink-0 border border-slate-200 rounded p-1 bg-white shadow-sm flex flex-col items-center">
                    {bs.mfsQrUrl || qrUrl ? (
                      <img src={bs.mfsQrUrl || qrUrl} alt="Payment QR" className="h-20 w-20 object-contain" />
                    ) : (
                      <div className="h-20 w-20 flex items-center justify-center bg-slate-100 text-slate-400 text-[10px] text-center p-1">
                        Scan QR
                      </div>
                    )}
                    <span className="text-[9px] text-slate-500 font-medium mt-0.5">Scan to Pay</span>
                  </div>
                  <div className="min-w-0 flex-1 space-y-1 text-[11px]">
                    <div>
                      <span className="font-medium text-slate-500">Merchant No: </span>
                      <span className="font-mono font-bold text-slate-900">{bs.mfsMerchantNumber || bs.bkashMerchantNumber || "—"}</span>
                    </div>
                    <div>
                      <span className="font-medium text-slate-500">Reference: </span>
                      <span className="font-mono font-bold text-slate-900">{inv.number}</span>
                    </div>
                    <div className="text-[10px] text-slate-500 leading-tight pt-0.5">
                      {bs.mfsInstructions || `Scan QR code with ${(bs.mfsProviderName || "bKash")} app or enter Merchant No. Use Reference "${inv.number}" & enter exact amount Tk ${total.toFixed(2)}.`}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Single Page Footer */}
          <div>
            <div className="mt-3 border-t border-blue-300 pt-1.5 flex items-center justify-between text-xs">
              <span className="font-serif italic text-blue-600 text-xs">Building a better workplace together</span>
              <span className="text-slate-500 text-[10px]">Computer Generated Tax Invoice</span>
              <span className="text-slate-500 text-[11px]">{platformName} | {companyWebsite}</span>
            </div>
            {/* Bottom Wave SVG Accent */}
            <div className="overflow-hidden rounded-b-lg -mx-7 -mb-7 mt-1.5">
              <svg viewBox="0 0 595 18" className="w-full h-3 text-blue-600 fill-current block" preserveAspectRatio="none">
                <path d="M 0 18 L 0 6 Q 166 18, 345 6 T 595 10 L 595 18 Z" />
              </svg>
            </div>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  )
}

// ================= Official Tenant Payment Money Receipt Dialog =================
function MoneyReceiptDialog({ invoiceId, onClose }: { invoiceId: string; onClose: () => void }) {
  const { data, loading, error } = useApi<{
    invoice: any
    vendor: { id?: string; code?: string; name: string; legalName: string; address: string; phone: string | null; email: string | null }
    billingSettings: any
    generalSettings?: any
    payments: any[]
  }>("billing.invoice.get", { id: invoiceId })
  const [downloading, setDownloading] = useState(false)
  const [qrUrl, setQrUrl] = useState("")

  const inv = data?.invoice
  const ven = data?.vendor
  const bs = data?.billingSettings || {}
  const gs = data?.generalSettings || {}
  const pm = (data?.payments || [])[0]

  useEffect(() => {
    if (inv && ven) {
      import("qrcode").then((mod) => {
        const QRCode = (mod as any).default || mod
        const payload = `FinixHR:MoneyReceipt:No=MR-${inv.number.replace(/^INV-/, "")}:Tenant=${ven.name}:Amount=${inv.amount}:Date=${inv.paidAt || inv.issuedAt}`
        QRCode.toDataURL(payload, { width: 140, margin: 1 }).then((u: string) => setQrUrl(u)).catch(() => {})
      }).catch(() => {})
    }
  }, [inv, ven])

  const handleDownloadPdf = async () => {
    if (!data?.invoice) return
    setDownloading(true)
    try {
      const res = await rpc<{ filename: string; base64: string }>("billing.receipt", { invoiceId: data.invoice?.id || invoiceId })
      downloadBase64(res.filename, res.base64)
    } catch (err: any) {
      alert(err?.message || "Failed to download Money Receipt")
    } finally {
      setDownloading(false)
    }
  }

  if (loading) {
    return createPortal(
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
        <div className="rounded-xl bg-white p-6 shadow-xl dark:bg-slate-900 text-slate-800 dark:text-slate-100 flex items-center gap-3">
          <RefreshCw className="h-5 w-5 animate-spin text-blue-600" />
          <span>Loading money receipt...</span>
        </div>
      </div>,
      document.body,
    )
  }

  if (error || !data || !inv) {
    return createPortal(
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
        <div className="rounded-xl bg-white p-6 shadow-xl dark:bg-slate-900 max-w-md w-full">
          <p className="font-semibold text-rose-600">Failed to load money receipt</p>
          <p className="text-sm mt-1 text-slate-600 dark:text-slate-300">{error || "Receipt data not found"}</p>
          <div className="mt-4 flex justify-end">
            <Button size="sm" onClick={onClose}>Close</Button>
          </div>
        </div>
      </div>,
      document.body,
    )
  }

  const total = Number(inv.amount) || 0
  const vatRate = Number(inv.vatRatePercent ?? 5.0)
  const net = Number(inv.netAmount ?? (vatRate > 0 ? total / (1 + vatRate / 100) : total))
  const vat = Number(inv.vatAmount ?? (total - net))
  const recNo = `MR-${inv.number.replace(/^INV-/, "")}`
  const paidDateStr = fmtDateTime(inv.paidAt || pm?.paidAt || inv.issuedAt)
  const platformName = gs.platformName || "Finix HR"
  const websiteUrl = gs.websiteUrl || "https://hrm.finixmart.com.bd"
  const supportEmail = gs.supportEmail || "support@finixhr.com"
  const companyAddress = bs.companyAddress || "Dhaka, Bangladesh"
  const methodLabel = pm?.providerLabel || pm?.provider || pm?.method || inv.method || "Bank Transfer"
  const txnId = pm?.providerTxnId || pm?.transactionId || inv.transactionId || "—"
  const paidBy = inv.createdByName || pm?.recordedByName || "Finance Department"
  const maxEmployees = inv.maxEmployees || 250

  return createPortal(
    <div id="finix-receipt-print-root" className="fixed inset-0 z-50 overflow-y-auto bg-slate-900/60 p-4 print:bg-white print:p-0 print:static print:overflow-visible backdrop-blur-sm">
      <style>{`
        @page {
          size: A4 portrait;
          margin: 8mm 12mm;
        }
        @media print {
          body > *:not(#finix-receipt-print-root) { display: none !important; }
          #finix-receipt-print-root {
            position: static !important; inset: auto !important; display: block !important;
            background: #fff !important; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif !important;
            padding: 0 !important; margin: 0 !important;
          }
          #finix-receipt-print-root .receipt-toolbar { display: none !important; }
          #finix-receipt-print-root .receipt-sheet {
            box-shadow: none !important; border: 1px solid #cbd5e1 !important; margin: 0 auto !important;
            width: 190mm !important; max-width: 190mm !important;
            min-height: auto !important; height: auto !important;
            padding: 20px !important;
            box-sizing: border-box !important;
            break-inside: avoid !important;
            page-break-inside: avoid !important;
          }
        }
      `}</style>

      {/* Floating Toolbar */}
      <div className="receipt-toolbar sticky top-0 z-20 mx-auto flex max-w-[210mm] flex-wrap items-center justify-between gap-2 rounded-xl bg-white/95 p-3.5 shadow-xl backdrop-blur dark:bg-slate-900/95 border border-slate-200 dark:border-slate-800 print:hidden mb-4">
        <div>
          <p className="text-sm font-bold text-slate-900 dark:text-slate-100 flex items-center gap-2">
            <span>Money Receipt #{recNo}</span>
            <Badge className="bg-emerald-600 text-white gap-1">
              <CheckCircle2 className="h-3 w-3" /> PAID
            </Badge>
          </p>
          <p className="text-xs text-slate-500">Official Tenant Payment Money Receipt</p>
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="default" className="h-8 gap-1.5 text-xs bg-blue-600 hover:bg-blue-700 text-white" disabled={downloading} onClick={handleDownloadPdf}>
            {downloading ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />} Download PDF
          </Button>
          <Button size="sm" variant="outline" className="h-8 gap-1.5 text-xs" onClick={() => window.print()}>
            <Printer className="h-3.5 w-3.5" /> Print
          </Button>
          <Button size="sm" variant="outline" className="h-8 gap-1.5 text-xs" onClick={onClose}>
            <X className="h-3.5 w-3.5" /> Close
          </Button>
        </div>
      </div>

      {/* Receipt Sheet */}
      <div className="mx-auto max-w-[210mm]">
        <div className="receipt-sheet rounded-lg border border-slate-200 bg-white p-8 text-slate-900 shadow-2xl relative flex flex-col justify-between">
          <div>
            {/* 1. Header (Logo + Contact) */}
            <div className="flex items-start justify-between pb-3">
              <div className="flex items-center gap-3">
                {gs.logoUrl ? (
                  <img src={gs.logoUrl} alt="Platform Logo" className="h-10 max-w-32 object-contain rounded" />
                ) : (
                  <div className="h-10 w-10 rounded-lg bg-blue-600 flex items-center justify-center text-white font-black text-2xl shadow-sm">
                    F
                  </div>
                )}
                <div>
                  <h1 className="text-2xl font-black tracking-tight text-slate-900">{platformName}</h1>
                  <p className="text-xs text-slate-500">{gs.tagline || "Standalone HRM & Workforce Platform"}</p>
                </div>
              </div>
              <div className="text-right text-xs space-y-0.5">
                <p className="font-bold text-slate-900">{platformName}</p>
                <p className="text-slate-500 text-[11px]">{gs.tagline || "Smarter People. Stronger Teams."}</p>
                <p className="text-slate-600 text-[11px] flex items-center justify-end gap-1.5">
                  <Globe className="h-3 w-3 text-blue-600 shrink-0" />
                  <span>{websiteUrl}</span>
                </p>
                <p className="text-slate-600 text-[11px] flex items-center justify-end gap-1.5">
                  <Mail className="h-3 w-3 text-blue-600 shrink-0" />
                  <span>{supportEmail}</span>
                </p>
                <p className="text-slate-600 text-[11px] flex items-center justify-end gap-1.5">
                  <MapPin className="h-3 w-3 text-blue-600 shrink-0" />
                  <span>{companyAddress}</span>
                </p>
              </div>
            </div>

            {/* Blue Divider Line */}
            <div className="h-0.5 w-full bg-blue-600 my-2.5" />

            {/* 2. Receipt Title & PAID Status */}
            <div className="flex items-start justify-between my-3">
              <div>
                <h2 className="text-xl font-extrabold text-slate-900 tracking-tight">Tenant Payment Money Receipt</h2>
                <p className="text-xs text-slate-500 mt-1">This is to acknowledge receipt of your payment for Finix HR subscription.</p>
              </div>
              <div className="text-right">
                <div className="inline-flex items-center gap-1.5 bg-emerald-600 text-white text-xs font-bold px-3 py-1 rounded-full shadow-sm mb-1.5">
                  <CheckCircle2 className="h-3.5 w-3.5" /> PAID
                </div>
                <p className="text-xs font-bold text-slate-900">Receipt No: <span className="font-mono">{recNo}</span></p>
                <p className="text-xs text-slate-500">Date: {paidDateStr}</p>
              </div>
            </div>

            {/* 3. Two Side-by-Side Information Cards */}
            <div className="grid grid-cols-2 gap-4 my-3.5">
              {/* Card 1: Tenant Information */}
              <div className="rounded-xl border border-blue-200 bg-blue-50/50 p-4 text-xs">
                <p className="font-bold text-blue-700 text-sm mb-2.5">Tenant Information</p>
                <div className="space-y-1.5">
                  <div className="grid grid-cols-[110px_10px_1fr]">
                    <span className="text-slate-500 font-medium">Tenant Name</span>
                    <span className="text-slate-400">:</span>
                    <span className="font-bold text-slate-900">{ven?.legalName || ven?.name || "Client"}</span>
                  </div>
                  <div className="grid grid-cols-[110px_10px_1fr]">
                    <span className="text-slate-500 font-medium">Tenant ID</span>
                    <span className="text-slate-400">:</span>
                    <span className="font-mono font-bold text-slate-900">{ven?.code || "TEN-" + String(ven?.id || "").slice(-6).toUpperCase()}</span>
                  </div>
                  <div className="grid grid-cols-[110px_10px_1fr]">
                    <span className="text-slate-500 font-medium">Plan</span>
                    <span className="text-slate-400">:</span>
                    <span className="font-bold text-slate-900">{inv.planName || "Business"}</span>
                  </div>
                  <div className="grid grid-cols-[110px_10px_1fr]">
                    <span className="text-slate-500 font-medium">Employee Limit</span>
                    <span className="text-slate-400">:</span>
                    <span className="font-bold text-slate-900">{maxEmployees}</span>
                  </div>
                  <div className="grid grid-cols-[110px_10px_1fr]">
                    <span className="text-slate-500 font-medium">Billing Cycle</span>
                    <span className="text-slate-400">:</span>
                    <span className="font-bold text-slate-900 capitalize">{String(inv.billingCycle || "Monthly").toLowerCase()}</span>
                  </div>
                  <div className="grid grid-cols-[110px_10px_1fr]">
                    <span className="text-slate-500 font-medium">Subscription Period</span>
                    <span className="text-slate-400">:</span>
                    <span className="font-bold text-slate-900">{fmtDate(inv.periodStart.slice(0, 10))} – {fmtDate(inv.periodEnd.slice(0, 10))}</span>
                  </div>
                </div>
              </div>

              {/* Card 2: Payment Information */}
              <div className="rounded-xl border border-blue-200 bg-blue-50/50 p-4 text-xs">
                <p className="font-bold text-blue-700 text-sm mb-2.5">Payment Information</p>
                <div className="space-y-1.5">
                  <div className="grid grid-cols-[110px_10px_1fr]">
                    <span className="text-slate-500 font-medium">Payment Method</span>
                    <span className="text-slate-400">:</span>
                    <span className="font-bold text-slate-900">{methodLabel}</span>
                  </div>
                  <div className="grid grid-cols-[110px_10px_1fr]">
                    <span className="text-slate-500 font-medium">Transaction ID</span>
                    <span className="text-slate-400">:</span>
                    <span className="font-mono font-bold text-slate-900">{txnId}</span>
                  </div>
                  <div className="grid grid-cols-[110px_10px_1fr]">
                    <span className="text-slate-500 font-medium">Payment Date</span>
                    <span className="text-slate-400">:</span>
                    <span className="font-bold text-slate-900">{paidDateStr}</span>
                  </div>
                  <div className="grid grid-cols-[110px_10px_1fr]">
                    <span className="text-slate-500 font-medium">Paid By</span>
                    <span className="text-slate-400">:</span>
                    <span className="font-bold text-slate-900">{paidBy}</span>
                  </div>
                </div>
              </div>
            </div>

            {/* 4. Payment Breakdown Table */}
            <div className="my-3.5">
              <p className="font-bold text-xs uppercase tracking-wide text-slate-800 mb-2">Payment Breakdown</p>
              <table className="w-full border-collapse rounded-lg overflow-hidden border border-slate-200 text-xs">
                <thead>
                  <tr className="bg-blue-600 text-white font-bold">
                    <th className="p-2.5 text-left">Description</th>
                    <th className="p-2.5 text-center w-48">Period</th>
                    <th className="p-2.5 text-right w-36">Amount (BDT)</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200">
                  <tr className="bg-white">
                    <td className="p-2.5 font-semibold text-slate-900">
                      Finix HR Subscription ({inv.planName} Plan)
                    </td>
                    <td className="p-2.5 text-center text-slate-600">
                      {fmtDate(inv.periodStart.slice(0, 10))} – {fmtDate(inv.periodEnd.slice(0, 10))}
                    </td>
                    <td className="p-2.5 text-right font-bold tabular-nums text-slate-900">
                      ৳ {net.toFixed(2)}
                    </td>
                  </tr>
                  {vat > 0 && (
                    <tr className="bg-slate-50/60 text-slate-600">
                      <td className="p-2">VAT ({vatRate}% inclusive)</td>
                      <td className="p-2 text-center">—</td>
                      <td className="p-2 text-right font-semibold tabular-nums text-slate-800">৳ {vat.toFixed(2)}</td>
                    </tr>
                  )}
                  <tr className="bg-blue-50/80 font-bold border-t-2 border-blue-200">
                    <td colSpan={2} className="p-2.5 text-right text-sm text-slate-800">Total Paid</td>
                    <td className="p-2.5 text-right text-base text-blue-700 tabular-nums">৳ {total.toFixed(2)}</td>
                  </tr>
                </tbody>
              </table>
            </div>

            {/* 5. Bottom Info Cards */}
            <div className="grid grid-cols-2 gap-4 my-3.5">
              {/* Payment Received Card */}
              <div className="rounded-xl border border-emerald-200 bg-emerald-50/60 p-3.5 text-xs">
                <div className="flex items-center gap-1.5 mb-1.5 text-emerald-700 font-bold text-sm">
                  <CheckCircle2 className="h-4 w-4" />
                  <span>Payment Received</span>
                </div>
                <p className="text-emerald-800 text-[11px] leading-relaxed">
                  Thank you for choosing Finix HR. Your payment has been successfully received and your subscription is now active.
                </p>
              </div>

              {/* Important Notes Card */}
              <div className="rounded-xl border border-blue-200 bg-blue-50/60 p-3.5 text-xs">
                <div className="flex items-center gap-1.5 mb-1.5 text-blue-700 font-bold text-sm">
                  <span className="flex h-3.5 w-3.5 items-center justify-center rounded-full bg-blue-600 text-[9px] font-bold text-white">i</span>
                  <span>Important Notes</span>
                </div>
                <ul className="text-slate-600 text-[11px] space-y-0.5 list-disc list-inside">
                  <li>This receipt is computer generated and does not require a signature.</li>
                  <li>Keep this receipt for your records.</li>
                  <li>For any queries, please contact our support team.</li>
                </ul>
              </div>
            </div>

            {/* 6. Verification QR, Stamp & Signature */}
            <div className="grid grid-cols-3 items-center pt-3 my-3 border-t border-slate-200">
              {/* QR Code */}
              <div className="flex items-center gap-3">
                <div className="border border-slate-200 rounded p-1 bg-white shadow-sm">
                  {qrUrl ? (
                    <img src={qrUrl} alt="Verify Receipt QR" className="h-14 w-14" />
                  ) : (
                    <div className="h-14 w-14 bg-slate-100 flex items-center justify-center text-[10px] text-slate-400">QR Code</div>
                  )}
                </div>
                <div className="text-[11px]">
                  <p className="font-bold text-slate-900">Scan to verify</p>
                  <p className="font-bold text-slate-900">this receipt</p>
                  <p className="text-[10px] text-slate-500 mt-0.5">(Optional)</p>
                </div>
              </div>

              {/* Circular PAID Stamp */}
              <div className="flex justify-center">
                {gs.sealUrl ? (
                  <img src={gs.sealUrl} alt="Official Seal" className="h-20 w-20 object-contain rounded-full shadow-sm" />
                ) : (
                  <div className="relative flex h-20 w-20 items-center justify-center rounded-full border-2 border-dashed border-blue-600/80 p-0.5 text-center select-none rotate-[-6deg]">
                    <div className="flex h-full w-full flex-col items-center justify-center rounded-full border-2 border-blue-600 bg-blue-50/30 text-blue-700">
                      <span className="text-[8px] font-black tracking-widest uppercase">{platformName}</span>
                      <span className="text-[11px] font-black tracking-wider text-blue-600 my-0.5">★ PAID ★</span>
                      <span className="text-[7px] font-bold uppercase tracking-tight text-blue-500">Official Seal</span>
                    </div>
                  </div>
                )}
              </div>

              {/* Authorized Signature */}
              <div className="text-right">
                <div className="inline-block text-center min-w-36">
                  {gs.signatureUrl ? (
                    <div className="flex justify-center pb-1 border-b border-slate-400">
                      <img src={gs.signatureUrl} alt="Signature" className="h-10 max-w-40 object-contain" />
                    </div>
                  ) : (
                    <p className="font-serif italic text-base text-slate-900 select-none pb-0.5 border-b border-slate-400">
                      {gs.signatoryName || bs.signatoryName || "MD Jakaria"}
                    </p>
                  )}
                  <p className="font-bold text-xs text-slate-900 mt-1">Authorized Signature</p>
                  <p className="text-[11px] text-slate-500">{gs.signatoryDesignation || bs.signatoryDesignation || "Finix HR Ltd."}</p>
                </div>
              </div>
            </div>
          </div>

          {/* 7. Bottom Baseline */}
          <div>
            <div className="mt-3 pt-2.5 border-t border-blue-300 flex items-center justify-between text-xs">
              <span className="font-serif italic text-blue-600 text-xs">Building a better workplace together</span>
              <span className="text-slate-500 text-[11px]">{platformName} | {websiteUrl}</span>
            </div>
            {/* Bottom Wave SVG Accent */}
            <div className="overflow-hidden rounded-b-lg -mx-8 -mb-8 mt-2">
              <svg viewBox="0 0 595 18" className="w-full h-3.5 text-blue-600 fill-current block" preserveAspectRatio="none">
                <path d="M 0 18 L 0 6 Q 166 18, 345 6 T 595 10 L 595 18 Z" />
              </svg>
            </div>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  )
}

// ================= Official Bangladesh NBR Mushak-6.3 Dialog =================
function MushakDialog({ invoiceId, onClose }: { invoiceId: string; onClose: () => void }) {
  const { data, loading, error } = useApi<{
    invoice: any
    vendor: { name: string; legalName: string; address: string; phone: string | null; email: string | null; bin?: string | null }
    billingSettings: any
    generalSettings?: any
  }>("billing.invoice.get", { id: invoiceId })
  const [downloading, setDownloading] = useState(false)

  const handleDownloadPdf = async () => {
    if (!data?.invoice) return
    setDownloading(true)
    try {
      const res = await rpc<{ filename: string; base64: string }>("billing.mushak.pdf", { invoiceId: data.invoice?.id || invoiceId })
      downloadBase64(res.filename, res.base64)
    } catch (err: any) {
      alert(err?.message || "Failed to download Mushak-6.3 PDF")
    } finally {
      setDownloading(false)
    }
  }

  if (loading) {
    return createPortal(
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
        <div className="rounded-xl bg-white p-6 shadow-xl dark:bg-slate-900 text-slate-800 dark:text-slate-100 flex items-center gap-3">
          <RefreshCw className="h-5 w-5 animate-spin text-blue-600" />
          <span>Loading Mushak-6.3 form...</span>
        </div>
      </div>,
      document.body,
    )
  }

  if (error || !data) {
    return createPortal(
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
        <div className="rounded-xl bg-white p-6 shadow-xl dark:bg-slate-900 max-w-md w-full">
          <p className="font-semibold text-rose-600">Failed to load Mushak-6.3</p>
          <p className="text-sm mt-1 text-slate-600 dark:text-slate-300">{error || "Invoice not found"}</p>
          <div className="mt-4 flex justify-end">
            <Button size="sm" onClick={onClose}>Close</Button>
          </div>
        </div>
      </div>,
      document.body,
    )
  }

  const { invoice: inv, vendor: ven, billingSettings: bs, generalSettings: gs } = data
  const total = Number(inv.amount) || 0
  const vatRate = Number(inv.vatRatePercent ?? bs?.vatRatePercent ?? 5.0)
  const rate = Math.min(100, Math.max(0, vatRate))
  const net = Number(inv.netAmount ?? (rate > 0 ? total / (1 + rate / 100) : total))
  const vat = Number(inv.vatAmount ?? (total - net))

  const supplierBin = bs?.companyBin || "009377515-0111"
  const customerBin = (ven as any)?.bin || "—"

  const issuedDate = new Date(inv.issuedAt)
  const issueDateStr = `${String(issuedDate.getDate()).padStart(2, "0")}/${String(issuedDate.getMonth() + 1).padStart(2, "0")}/${issuedDate.getFullYear()}`
  const issueTimeStr = issuedDate.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: true })

  return createPortal(
    <div id="finix-mushak-print-root" className="fixed inset-0 z-50 overflow-y-auto bg-slate-900/60 p-4 print:bg-[#74CCFC] print:p-0 print:static print:overflow-visible backdrop-blur-sm">
      <style>{`
        @page {
          size: A4 portrait;
          margin: 6mm 10mm;
        }
        @media print {
          body > *:not(#finix-mushak-print-root) { display: none !important; }
          #finix-mushak-print-root {
            position: static !important; inset: auto !important; display: block !important;
            background: #74CCFC !important;
            -webkit-print-color-adjust: exact !important;
            print-color-adjust: exact !important;
            font-family: "Noto Sans Bengali", "Hind Siliguri", "Kalpurush", system-ui, sans-serif !important;
            padding: 0 !important; margin: 0 !important;
          }
          #finix-mushak-print-root .mushak-toolbar { display: none !important; }
          #finix-mushak-print-root .mushak-sheet {
            box-shadow: none !important; border: 1.5px solid #000 !important; margin: 0 auto !important;
            width: 190mm !important; max-width: 190mm !important;
            min-height: 275mm !important; height: auto !important;
            padding: 12px 14px !important;
            background: #74CCFC !important;
            background-color: #74CCFC !important;
            box-sizing: border-box !important;
            break-inside: avoid !important;
            page-break-inside: avoid !important;
          }
          #finix-mushak-print-root td, #finix-mushak-print-root th {
            padding: 2.5px 4px !important;
            border-color: #000 !important;
          }
        }
      `}</style>

      {/* Toolbar with marked Download PDF button */}
      <div className="mushak-toolbar sticky top-0 z-20 mx-auto flex max-w-[210mm] flex-wrap items-center justify-between gap-2 rounded-xl bg-white/95 p-3.5 shadow-xl backdrop-blur dark:bg-slate-900/95 border border-slate-200 dark:border-slate-800 print:hidden mb-4">
        <div>
          <p className="text-sm font-bold text-slate-900 dark:text-slate-100">কর চালানপত্র (মূসক-৬.৩)</p>
          <p className="text-xs text-slate-500">Official National Board of Revenue VAT Invoice</p>
        </div>
        <div className="flex items-center gap-2">
          {/* Download Button right at marked position */}
          <Button
            size="sm"
            variant="default"
            className="h-8 gap-1.5 text-xs bg-blue-600 hover:bg-blue-700 text-white font-medium shadow-sm"
            disabled={downloading}
            onClick={handleDownloadPdf}
          >
            {downloading ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
            Download PDF
          </Button>
          <Button size="sm" variant="outline" className="h-8 gap-1.5 text-xs" onClick={() => window.print()}>
            <Printer className="h-3.5 w-3.5" /> Print Form
          </Button>
          <Button size="sm" variant="outline" className="h-8 gap-1.5 text-xs" onClick={onClose}>
            <X className="h-3.5 w-3.5" /> Close
          </Button>
        </div>
      </div>

      {/* Official Mushak 6.3 Sheet (Strict A4 Size with authentic NBR Blue Background #74CCFC) */}
      <div
        className="mushak-sheet mx-auto max-w-[210mm] min-h-[297mm] border-2 border-slate-900 bg-[#74CCFC] p-7 text-slate-950 shadow-2xl relative font-sans text-xs flex flex-col justify-between"
        style={{ backgroundColor: "#74CCFC" }}
      >
        <div>
          {/* Top Header Grid: Left = BD Govt Logo, Center = NBR Headers, Right = Form Tag */}
          <div className="relative flex items-start justify-between pb-3">
            {/* Top-Left: Government of Bangladesh Logo */}
            <div className="shrink-0 flex items-center justify-center">
              <img
                src="/bd-govt-logo.png"
                alt="Government of Bangladesh"
                className="h-16 w-16 object-contain rounded-full shadow-sm"
              />
            </div>

            {/* Top-Center: Headers */}
            <div className="text-center flex-1 px-4">
              <p className="text-sm font-bold tracking-wide text-slate-950">গণপ্রজাতন্ত্রী বাংলাদেশ সরকার, জাতীয় রাজস্ব বোর্ড</p>
              <h2 className="mt-0.5 text-lg font-black tracking-wider text-slate-950">কর চালানপত্র</h2>
              <p className="text-[11px] font-medium text-slate-800 mt-0.5">[বিধি ৪০ এর উপ-বিধি (১) এর দফা (গ) ও (চ) দ্রষ্টব্য]</p>
            </div>

            {/* Top-Right: Form Copy & Mushak-6.3 Tag */}
            <div className="shrink-0 text-right">
              <p className="text-[11px] font-semibold text-slate-900">প্রথম কপি</p>
              <div className="mt-1 rounded-full border-2 border-slate-950 px-3.5 py-0.5 inline-block font-black text-xs text-slate-950">
                মূসক-৬.৩
              </div>
            </div>
          </div>

          {/* Registered Supplier Details */}
          <div className="text-center space-y-0.5 border-b border-slate-900/40 pb-2.5 text-xs text-slate-950">
            <p><span className="font-semibold">নিবন্ধিত ব্যক্তির নাম :</span> <span className="font-bold uppercase tracking-wide">{bs?.companyLegalName || "FINIX HR LTD."}</span></p>
            <p><span className="font-semibold">নিবন্ধিত ব্যক্তির বিআইএন :</span> <span className="font-mono font-bold tracking-wider">{supplierBin}</span></p>
            <p><span className="font-semibold">চালানপত্র ইস্যুর ঠিকানা :</span> <span>{gs?.address || bs?.companyAddress || "House 11, Road 6, Sector 16/A, Uttara, Dhaka - 1230"}</span></p>
          </div>

          {/* Customer & Invoice Details (2 Columns) */}
          <div className="grid grid-cols-2 gap-4 py-2.5 text-xs leading-relaxed text-slate-950">
            <div className="space-y-0.5">
              <p><span className="font-semibold">ক্রেতার নাম :</span> <span className="font-bold">{ven.legalName || ven.name}</span></p>
              <p><span className="font-semibold">ক্রেতার বিআইএন (প্রযোজ্য ক্ষেত্রে) :</span> <span className="font-mono">{customerBin}</span></p>
              <p><span className="font-semibold">ক্রেতার ঠিকানা :</span> <span>{ven.address || "Dhaka, Bangladesh"}</span></p>
              <p><span className="font-semibold">সরবরাহের গন্তব্যস্থল :</span> <span>—</span></p>
              <p><span className="font-semibold">যানবাহনের প্রকৃতি ও নম্বর :</span> <span>—</span></p>
            </div>
            <div className="space-y-0.5 text-right">
              <p><span className="font-semibold">চালানপত্র নম্বর :</span> <span className="font-mono font-bold">{inv.number}</span></p>
              <p><span className="font-semibold">ইস্যুর তারিখ :</span> <span className="font-mono font-bold">{issueDateStr}</span></p>
              <p><span className="font-semibold">ইস্যুর সময় :</span> <span className="font-mono font-bold">{issueTimeStr}</span></p>
            </div>
          </div>

          {/* The Official 11-Column NBR Table */}
          <table className="mt-1 w-full border-collapse border border-slate-950 text-[10px] text-slate-950">
            <thead>
              <tr className="bg-[#5ec5fc] text-slate-950 text-center font-bold">
                <th className="border border-slate-950 p-1 w-7">ক্রম নম্বর</th>
                <th className="border border-slate-950 p-1 text-left">পণ্য বা সেবার বিবরণ<br />(প্রযোজ্য ক্ষেত্রে ব্র্যান্ড নামসহ)</th>
                <th className="border border-slate-950 p-1 w-11">সরবরাহের একক</th>
                <th className="border border-slate-950 p-1 w-11">পরিমাণ</th>
                <th className="border border-slate-950 p-1 w-16">একক মূল্য ১<br />(টাকায়)</th>
                <th className="border border-slate-950 p-1 w-16">মোট মূল্য<br />(টাকায়)</th>
                <th className="border border-slate-950 p-1 w-11">সম্পূরক শুল্কের হার</th>
                <th className="border border-slate-950 p-1 w-14">সম্পূরক শুল্কের পরিমাণ (টাকায়)</th>
                <th className="border border-slate-950 p-1 w-14">মূল্য সংযোজন করের হার/নির্দিষ্ট কর</th>
                <th className="border border-slate-950 p-1 w-16">মূল্য সংযোজন কর/সুনির্দিষ্ট কর এর পরিমাণ (টাকায়)</th>
                <th className="border border-slate-950 p-1 w-18">সকল প্রকার শুল্ক ও করসহ মূল্য</th>
              </tr>
              <tr className="bg-[#6ec9fc] text-slate-900 text-center text-[9px] font-semibold">
                <th className="border border-slate-950 p-0.5">(১)</th>
                <th className="border border-slate-950 p-0.5">(২)</th>
                <th className="border border-slate-950 p-0.5">(৩)</th>
                <th className="border border-slate-950 p-0.5">(৪)</th>
                <th className="border border-slate-950 p-0.5">(৫)</th>
                <th className="border border-slate-950 p-0.5">(৬)</th>
                <th className="border border-slate-950 p-0.5">(৭)</th>
                <th className="border border-slate-950 p-0.5">(৮)</th>
                <th className="border border-slate-950 p-0.5">(৯)</th>
                <th className="border border-slate-950 p-0.5">(১০)</th>
                <th className="border border-slate-950 p-0.5">(১১)</th>
              </tr>
            </thead>
            <tbody>
              <tr className="bg-[#74CCFC]">
                <td className="border border-slate-950 p-1 text-center align-top font-bold">১</td>
                <td className="border border-slate-950 p-1.5 align-top">
                  <p className="font-bold text-slate-950">Finix HR - {inv.planName} Plan</p>
                  <p className="text-slate-800 mt-0.5">Billing Cycle: {inv.billingCycle.toLowerCase()}</p>
                  <p className="text-slate-800 mt-0.5">Billing Period: {fmtDate(inv.periodStart.slice(0, 10))} - {fmtDate(inv.periodEnd.slice(0, 10))}</p>
                  <p className="text-slate-800 mt-0.5">Specification: Cloud Workforce &amp; Payroll Management Platform</p>
                </td>
                <td className="border border-slate-950 p-1 text-center align-top">—</td>
                <td className="border border-slate-950 p-1 text-center align-top tabular-nums">1.00</td>
                <td className="border border-slate-950 p-1 text-right align-top tabular-nums">{net.toFixed(2)}</td>
                <td className="border border-slate-950 p-1 text-right align-top tabular-nums font-bold">{net.toFixed(2)}</td>
                <td className="border border-slate-950 p-1 text-center align-top">—</td>
                <td className="border border-slate-950 p-1 text-center align-top">—</td>
                <td className="border border-slate-950 p-1 text-center align-top font-bold tabular-nums">{rate.toFixed(2)}%</td>
                <td className="border border-slate-950 p-1 text-right align-top tabular-nums font-bold">{vat.toFixed(2)}</td>
                <td className="border border-slate-950 p-1 text-right align-top tabular-nums font-bold">{total.toFixed(2)}</td>
              </tr>
              <tr className="bg-[#5ec5fc] font-bold text-slate-950">
                <td colSpan={4} className="border border-slate-950 p-1 text-right">সর্বমোট</td>
                <td className="border border-slate-950 p-1 text-right tabular-nums">{net.toFixed(2)}</td>
                <td className="border border-slate-950 p-1 text-right tabular-nums">{net.toFixed(2)}</td>
                <td className="border border-slate-950 p-1 text-center">—</td>
                <td className="border border-slate-950 p-1 text-center">—</td>
                <td className="border border-slate-950 p-1 text-center tabular-nums">{rate.toFixed(2)}%</td>
                <td className="border border-slate-950 p-1 text-right tabular-nums">{vat.toFixed(2)}</td>
                <td className="border border-slate-950 p-1 text-right tabular-nums text-xs">{total.toFixed(2)}</td>
              </tr>
            </tbody>
          </table>

          {/* Signatory & Official Seal */}
          <div className="mt-4 flex items-end justify-between text-xs pt-1 text-slate-950">
            <div className="space-y-1">
              <p><span className="font-semibold">প্রতিষ্ঠান কর্তৃপক্ষের দায়িত্বপ্রাপ্ত ব্যক্তির নাম:</span> <span className="font-bold">{gs?.signatoryName || bs?.signatoryName || "MD JAKARIA"}</span></p>
              <p><span className="font-semibold">পদবি:</span> <span className="font-medium">{gs?.signatoryDesignation || bs?.signatoryDesignation || "Executive, Admin & Operations, Finix HR Ltd."}</span></p>
              <div className="pt-2 flex items-center gap-2">
                <span className="font-semibold">স্বাক্ষর:</span>
                {gs?.signatureUrl ? (
                  <img src={gs.signatureUrl} alt="Signature" className="h-10 max-w-44 object-contain inline-block ml-1" />
                ) : (
                  <span className="font-serif italic text-lg text-blue-950 tracking-wider font-bold">
                    {gs?.signatoryName || "Zakaria"}
                  </span>
                )}
              </div>
            </div>

            {/* Official Round Stamp / Seal */}
            <div className="text-center">
              {gs?.sealUrl ? (
                <img src={gs.sealUrl} alt="Official Seal" className="h-20 w-20 object-contain rounded-full inline-block shadow-sm" />
              ) : (
                <div className="h-20 w-20 rounded-full border-2 border-dashed border-blue-950/70 flex flex-col items-center justify-center text-[8px] font-bold text-blue-950 uppercase tracking-tighter mx-auto p-1 text-center">
                  <span>FINIX HR</span>
                  <span className="my-0.5 text-[6px]">★ ★ ★</span>
                  <span>LTD.</span>
                </div>
              )}
            </div>
          </div>

          {/* Footnote */}
          <p className="mt-2 text-[10px] text-slate-800 italic">১ সকল প্রকার কর ব্যতীত মূল্য</p>
        </div>

        {/* Page 1 of 1 Footer */}
        <div className="mt-4 border-t border-slate-900/30 pt-1.5 text-center text-[10px] text-slate-700">
          Page 1 of 1
        </div>
      </div>
    </div>,
    document.body,
  )
}

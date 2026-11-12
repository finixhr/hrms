"use client"
// ============ /owner/planchanges — Plan Requests console (P5 rebuild) =======
// Wave 3 WP-C tenant plan-change requests, rebuilt on the P0–P4 console
// design system. The old flow hard-pinned page:1 / pageSize:100, fired four
// alert()s (approve result, rejection validation, and both failure paths) and
// used a hand-rolled modal. Now:
//   - KPI strip: pending queue (from owner.subscriptions.overview, P5) + the
//     decided counts + the at-a-glance queue share.
//   - The decision flow rides the shared Dialog component with inline toasts
//     (the P2 discipline — zero browser alerts); the rejection note rule
//     (min 3 chars) is enforced inline with a live hint.
//   - Status chips + true pagination over the already-paged
//     owner.planchangerequests.list; 60 s auto-refresh; dark + light modes.
// Approving still runs the REAL owner.subscriptions.changePlan semantics
// (events, snapshots, entitlement invalidation, saasAudit) — composed, never
// forked.
import { useCallback, useEffect, useState } from "react"
import Link from "next/link"
import { ArrowLeftRight, ArrowUpRight, ArrowDownRight, CheckCircle2, ChevronLeft, ChevronRight, Clock, RefreshCw, Search, XCircle } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Input } from "@/components/ui/input"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { useOwnerApi, ownerRpc } from "@/saas/owner/client"
import { ErrorBanner, KpiCard, PageHeader, StatusChip, TableShell, Td, fmtDateTime, Loading } from "@/saas/owner/ui"
import { cn } from "@/lib/utils"

type Row = {
  id: string; vendorId: string; vendorName: string; vendorCode: string | null
  currentPlan: string | null; billingCycle: string | null; subscriptionStatus: string | null
  requestedPlanId: string; requestedPlanName: string; mode: string; note: string | null
  status: string; requestedByName: string | null; decidedByName: string | null
  decidedAt: string | null; decisionNote: string | null; createdAt: string
}

type Overview = {
  generatedAt: string
  pendingPlanChanges: number
  statusMix: Record<string, number>
  plans: { total: number; active: number; publicPlans: number; trialPlans: number }
  renewals: { operating: number; expiring7d: number; expiring30d: number; overdue: number }
}

const STATUS_CHIPS = [
  { key: "PENDING", label: "Pending" },
  { key: "APPROVED", label: "Approved" },
  { key: "REJECTED", label: "Rejected" },
  { key: "ALL", label: "All" },
] as const
type StatusChipKey = (typeof STATUS_CHIPS)[number]["key"]

const PAGE_SIZE = 25

/** Inline toast (the P2 billing discipline — zero browser alerts). */
function Toast({ tone, children }: { tone: "ok" | "err"; children: React.ReactNode }) {
  return (
    <div className={cn("flex items-start gap-2 rounded-xl border p-3 text-sm",
      tone === "ok"
        ? "border-emerald-400/30 bg-emerald-500/10 text-emerald-200 light:text-emerald-700"
        : "border-rose-400/40 bg-rose-500/10 text-rose-200 light:text-rose-700")}>
      {tone === "ok" ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" /> : <XCircle className="mt-0.5 h-4 w-4 shrink-0" />}
      <span className="whitespace-pre-wrap">{children}</span>
    </div>
  )
}

export default function PlanChangeRequestsPage() {
  const overview = useOwnerApi<Overview>("owner.subscriptions.overview")
  const [status, setStatus] = useState<StatusChipKey>("PENDING")
  const [search, setSearch] = useState("")
  const [query, setQuery] = useState("")
  const [page, setPage] = useState(1)
  const { data, loading, error, reload } = useOwnerApi<{ rows: Row[]; total: number }>(
    "owner.planchangerequests.list", { status, search: query || undefined, page, pageSize: PAGE_SIZE }, [status, query, page]
  )

  const [selected, setSelected] = useState<Row | null>(null)
  const [note, setNote] = useState("")
  const [busy, setBusy] = useState(false)
  const [toast, setToast] = useState<{ tone: "ok" | "err"; text: string } | null>(null)

  const load = useCallback(() => {
    overview.reload().catch(() => {})
    reload().catch(() => {})
  }, [overview.reload, reload])

  // 60 s auto-refresh (the P0–P4 console rhythm)
  useEffect(() => {
    const t = setInterval(() => load(), 60_000)
    return () => clearInterval(t)
  }, [load])

  // toasts self-dismiss after 6 s
  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(null), 6_000)
    return () => clearTimeout(t)
  }, [toast])

  const approve = async () => {
    if (!selected) return
    setBusy(true)
    try {
      const out = await ownerRpc("owner.planchangerequests.approve", { id: selected.id, note: note || undefined })
      setToast({ tone: "ok", text: `Approved — plan changed to ${out.planName} (${out.billingCycle}). The tenant sees it in Subscription History immediately.` })
      setSelected(null); setNote("")
      load()
    } catch (e: any) { setToast({ tone: "err", text: e?.message || "Failed to approve" }) } finally { setBusy(false) }
  }

  const reject = async () => {
    if (!selected) return
    if ((note || "").trim().length < 3) {
      setToast({ tone: "err", text: "A rejection reason (min 3 chars) is required — the tenant sees it." })
      return
    }
    setBusy(true)
    try {
      await ownerRpc("owner.planchangerequests.reject", { id: selected.id, reason: note.trim() })
      setToast({ tone: "ok", text: "Rejected — the tenant sees the decision note in their Subscription page." })
      setSelected(null); setNote("")
      load()
    } catch (e: any) { setToast({ tone: "err", text: e?.message || "Failed to reject" }) } finally { setBusy(false) }
  }

  const o = overview.data
  const total = data?.total || 0
  const maxPage = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const mix = o?.statusMix || {}
  const decided = (mix.APPROVED || 0) + (mix.REJECTED || 0)

  return (
    <div className="space-y-5">
      <PageHeader
        title={
          <span className="flex items-center gap-2.5">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-fuchsia-500 to-violet-600 shadow-lg shadow-fuchsia-950/50">
              <ArrowLeftRight className="h-4 w-4 text-white" />
            </span>
            Plan Change Requests
          </span>
        }
        sub="Tenant-submitted upgrades and downgrades. Approving applies the same plan-change semantics as the Subscriptions console — events, price snapshots and entitlements update instantly."
        actions={
          <div className="flex items-center gap-2">
            {o && <span className="hidden text-xs text-slate-500 sm:inline">generated {new Date(o.generatedAt).toLocaleTimeString()}</span>}
            <Button variant="outline" size="sm" disabled={overview.loading || loading} onClick={load}>
              <RefreshCw className={cn("h-3.5 w-3.5", (overview.loading || loading) && "animate-spin")} /> Refresh
            </Button>
          </div>
        }
      />

      {overview.error && <ErrorBanner message={overview.error} />}
      {o && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <KpiCard label="Pending requests" value={o.pendingPlanChanges.toLocaleString("en-IN")}
            tone={o.pendingPlanChanges > 0 ? "amber" : "emerald"} icon={Clock}
            sub="the queue this page works — oldest first is one click away" />
          <KpiCard label="Decided — all time" value={decided.toLocaleString("en-IN")} icon={CheckCircle2}
            sub={`${mix.APPROVED || 0} approved · ${mix.REJECTED || 0} rejected`} />
          <KpiCard label="Plans in catalog" value={o.plans.active.toLocaleString("en-IN")} icon={ArrowLeftRight}
            sub={`${o.plans.total} total · ${o.plans.trialPlans} trial · ${o.plans.publicPlans} public`} />
          <KpiCard label="Renewals ≤ 30d" value={o.renewals.expiring30d.toLocaleString("en-IN")}
            tone={o.renewals.expiring30d > 0 ? "amber" : "default"} icon={ArrowUpRight}
            sub={`${o.renewals.expiring7d} within 7 days · ${o.renewals.overdue} past end date`} />
        </div>
      )}

      {/* filter rail */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-500" />
          <Input value={search} onChange={(e) => { setSearch(e.target.value); setPage(1) }}
            onKeyDown={(e) => { if (e.key === "Enter") { setQuery(search); setPage(1) } }}
            placeholder="Search vendor id…" className="h-9 w-56 border-white/10 light:border-slate-200 bg-white/5 light:bg-slate-100 pl-8 text-xs" />
        </div>
        <div className="flex gap-1">
          {STATUS_CHIPS.map((c) => (
            <button key={c.key} type="button" onClick={() => { setStatus(c.key); setPage(1) }}
              className={cn("rounded-full border px-2.5 py-1 text-[11px] font-semibold transition-colors",
                status === c.key
                  ? "border-fuchsia-400/50 bg-fuchsia-500/15 text-fuchsia-200 light:text-fuchsia-700"
                  : "border-white/10 light:border-slate-200 text-slate-500 light:text-slate-600 hover:text-white light:hover:text-slate-900")}>
              {c.label}
            </button>
          ))}
        </div>
        {query && (
          <button type="button" onClick={() => { setQuery(""); setSearch("") }}
            className="text-[11px] font-semibold text-slate-500 underline-offset-2 hover:text-white light:hover:text-slate-900 hover:underline">
            clear “{query}”
          </button>
        )}
        <span className="ml-auto text-xs text-slate-500">{total.toLocaleString("en-IN")} request{total === 1 ? "" : "s"}</span>
      </div>

      {toast && <Toast tone={toast.tone}>{toast.text}</Toast>}
      {error && <ErrorBanner message={error} />}
      {loading && !data ? <Loading /> : (
        <TableShell headers={["Tenant", "Current", "Requested", "Mode", "Requested By", "Status", "Received", ""]} empty={data?.rows.length === 0}>
          {data?.rows.map((r) => (
            <tr key={r.id} className="cursor-pointer transition-colors hover:bg-white/[0.03] light:hover:bg-slate-100/60"
              onClick={() => { setSelected(r); setNote(r.decisionNote || ""); setToast(null) }}>
              <Td>
                <Link href={`/owner/tenants/${r.vendorId}`} className="font-medium text-white light:text-slate-900 hover:text-indigo-300 light:hover:text-indigo-700" onClick={(e) => e.stopPropagation()}>
                  {r.vendorName}
                </Link>
                <span className="block text-xs text-slate-500">{r.vendorCode || r.vendorId}</span>
              </Td>
              <Td className="text-xs">{r.currentPlan || "—"}{r.billingCycle ? ` (${r.billingCycle.toLowerCase()})` : ""}</Td>
              <Td className="text-xs font-medium">{r.requestedPlanName}</Td>
              <Td>
                <span className={cn("inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider",
                  r.mode === "UPGRADE"
                    ? "border-emerald-400/40 bg-emerald-500/10 text-emerald-300 light:text-emerald-700"
                    : "border-amber-400/40 bg-amber-500/10 text-amber-300 light:text-amber-700")}>
                  {r.mode === "UPGRADE" ? <ArrowUpRight className="h-3 w-3" /> : <ArrowDownRight className="h-3 w-3" />} {r.mode}
                </span>
              </Td>
              <Td className="text-xs">{r.requestedByName || "—"}</Td>
              <Td><StatusChip status={r.status === "PENDING" ? "PENDING" : r.status === "APPROVED" ? "ACTIVE" : "CANCELLED"} /></Td>
              <Td className="text-xs">{fmtDateTime(r.createdAt)}</Td>
              <Td><span className="text-xs text-indigo-300 light:text-indigo-700">open →</span></Td>
            </tr>
          ))}
        </TableShell>
      )}

      {total > PAGE_SIZE && (
        <div className="flex items-center justify-center gap-3">
          <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}
            className="border-white/10 light:border-slate-200 bg-white/5 light:bg-slate-100 text-white light:text-slate-900">
            <ChevronLeft className="h-3.5 w-3.5" /> Previous
          </Button>
          <span className="text-xs text-slate-500">page {page} / {maxPage}</span>
          <Button variant="outline" size="sm" disabled={page >= maxPage} onClick={() => setPage((p) => p + 1)}
            className="border-white/10 light:border-slate-200 bg-white/5 light:bg-slate-100 text-white light:text-slate-900">
            Next <ChevronRight className="h-3.5 w-3.5" />
          </Button>
        </div>
      )}

      {/* ---- decision dialog (the shared Dialog — P2 discipline) ---- */}
      <Dialog open={!!selected} onOpenChange={(open) => { if (!open) setSelected(null) }}>
        <DialogContent className="max-h-[85dvh] overflow-y-auto border-white/10 light:border-slate-200 bg-slate-950 light:bg-slate-50 sm:max-w-xl">
          {selected && (
            <>
              <DialogHeader>
                <DialogTitle className="text-white light:text-slate-900">{selected.vendorName}</DialogTitle>
                <p className="text-xs text-slate-500">
                  {selected.currentPlan || "—"} → <span className="font-semibold">{selected.requestedPlanName}</span> · {selected.mode}
                  {" · "}requested by {selected.requestedByName || "tenant"} · {fmtDateTime(selected.createdAt)}
                </p>
              </DialogHeader>
              {selected.note && (
                <p className="whitespace-pre-wrap rounded-xl border border-white/10 light:border-slate-200 bg-white/[0.03] light:bg-slate-100/60 p-4 text-sm text-slate-300 light:text-slate-700">
                  {selected.note}
                </p>
              )}
              {selected.status === "PENDING" ? (
                <>
                  <Textarea
                    value={note} onChange={(e) => setNote(e.target.value)}
                    placeholder="Decision note (required for rejection — the tenant sees it)"
                    className="min-h-24 border-white/10 light:border-slate-200 bg-white/5 light:bg-slate-100"
                  />
                  <div className="flex items-center justify-end gap-2">
                    <Button variant="outline" className="border-rose-500/40 text-rose-400 light:text-rose-700 hover:bg-rose-500/10" disabled={busy} onClick={reject}>
                      Reject Request
                    </Button>
                    <Button disabled={busy} onClick={approve}>
                      Approve &amp; Apply Plan Change
                    </Button>
                  </div>
                  <p className="text-[11px] text-slate-500">
                    Approving runs the standard plan-change flow (subscription event, price snapshot, entitlement refresh,
                    audit trail) exactly like the Subscriptions console — the tenant sees the change in Subscription History.
                  </p>
                </>
              ) : (
                <div className="rounded-xl border border-white/10 light:border-slate-200 bg-white/[0.03] light:bg-slate-100/60 p-4 text-sm">
                  <p className="text-slate-300 light:text-slate-700">
                    <b>{selected.status}</b>{selected.decidedByName ? ` by ${selected.decidedByName}` : ""}
                    {selected.decidedAt ? ` · ${fmtDateTime(selected.decidedAt)}` : ""}
                  </p>
                  {selected.decisionNote && <p className="mt-2 text-slate-400 light:text-slate-600">{selected.decisionNote}</p>}
                </div>
              )}
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}

"use client"
// ============ /owner/subscriptions — Subscriptions console (P5 rebuild) =====
// §26, rebuilt on the P0–P4 console design system. The old page hard-pinned
// page:1 / pageSize:100 with no pagination UI and no KPIs. Now:
//   - KPI strip from owner.subscriptions.overview (P5): the operating mix
//     with past-due + grace risk, trials, pending plan-change requests, the
//     renewal-window trio.
//   - Cycle filter added; status filter and search ride the already-SQL-paged
//     owner.subscriptions.list (P0 fixed the LEGACY leg with a NOT EXISTS
//     anti-join; the rest was SQL-paged from birth).
//   - True pagination + 60 s auto-refresh, dark + light modes.
import { useEffect, useState } from "react"
import Link from "next/link"
import { ArrowLeftRight, CalendarClock, CreditCard, Landmark, RefreshCw, Search } from "lucide-react"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { useOwnerApi } from "@/saas/owner/client"
import { ErrorBanner, KpiCard, PageHeader, StatusChip, TableShell, Td, fmtDate, Loading } from "@/saas/owner/ui"
import { cn } from "@/lib/utils"

type Row = {
  id: string; vendorId: string; vendorName: string; vendorCode: string
  admin: { name: string; email: string } | null
  planName: string | null; status: string; billingCycle: string
  startDate: string | null; endDate: string | null
  price: number | null; currency: string | null; gracePeriodDays: number
}

type Overview = {
  generatedAt: string
  statusMix: Record<string, number>
  pendingPlanChanges: number
  plans: { total: number; active: number; publicPlans: number; trialPlans: number }
  renewals: { operating: number; expiring7d: number; expiring30d: number; overdue: number }
}

const STATUSES = ["ALL", "TRIAL", "ACTIVE", "PAST_DUE", "GRACE_PERIOD", "EXPIRED", "SUSPENDED", "CANCELLED", "LEGACY"]
const PAGE_SIZE = 25

export default function SubscriptionsPage() {
  const overview = useOwnerApi<Overview>("owner.subscriptions.overview")
  const [status, setStatus] = useState("ALL")
  const [cycle, setCycle] = useState("ALL")
  const [search, setSearch] = useState("")
  const [query, setQuery] = useState("")
  const [page, setPage] = useState(1)

  const { data, loading, error, reload } = useOwnerApi<{ rows: Row[]; total: number }>(
    "owner.subscriptions.list",
    { status, search: query || undefined, page, pageSize: PAGE_SIZE },
    [status, query, page]
  )

  // 60 s auto-refresh (the P0–P4 console rhythm)
  useEffect(() => {
    const t = setInterval(() => {
      overview.reload().catch(() => {})
      reload().catch(() => {})
    }, 60_000)
    return () => clearInterval(t)
  }, [overview.reload, reload])

  const o = overview.data
  const total = data?.total || 0
  const maxPage = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const mix = o?.statusMix || {}
  const pastDue = (mix.PAST_DUE || 0) + (mix.GRACE_PERIOD || 0)

  // client-side cycle narrowing on the page (the backend action has no cycle
  // param — the filter is a display convenience over the SQL-paged rows)
  const rows = (data?.rows || []).filter((r) => cycle === "ALL" || r.billingCycle === cycle)

  return (
    <div className="space-y-5">
      <PageHeader
        title={
          <span className="flex items-center gap-2.5">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-sky-500 to-cyan-600 shadow-lg shadow-sky-950/50">
              <Landmark className="h-4 w-4 text-white" />
            </span>
            Subscriptions
          </span>
        }
        sub="One current subscription per tenant. History is preserved on every change — records are never silently overwritten."
        actions={
          <div className="flex items-center gap-2">
            {o && <span className="hidden text-xs text-slate-500 sm:inline">generated {new Date(o.generatedAt).toLocaleTimeString()}</span>}
            <Button variant="outline" size="sm" disabled={overview.loading || loading}
              onClick={() => { overview.reload().catch(() => {}); reload().catch(() => {}) }}>
              <RefreshCw className={cn("h-3.5 w-3.5", (overview.loading || loading) && "animate-spin")} /> Refresh
            </Button>
          </div>
        }
      />

      {overview.error && <ErrorBanner message={overview.error} />}
      {o && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <KpiCard label="Operating subscriptions" value={o.renewals.operating.toLocaleString("en-IN")} icon={CreditCard}
            sub={`${mix.ACTIVE || 0} ACTIVE · ${mix.TRIAL || 0} TRIAL · ${mix.LEGACY || 0} legacy tenants`} />
          <KpiCard label="Past due / grace" value={pastDue.toLocaleString("en-IN")}
            tone={pastDue > 0 ? "red" : "emerald"} icon={CalendarClock}
            sub={`${mix.PAST_DUE || 0} past due · ${mix.GRACE_PERIOD || 0} in grace · ${o.renewals.overdue} past end date`} />
          <KpiCard label="Expiring ≤ 30 days" value={o.renewals.expiring30d.toLocaleString("en-IN")}
            tone={o.renewals.expiring30d > 0 ? "amber" : "default"} icon={CalendarClock}
            sub={`${o.renewals.expiring7d} within 7 days — extend from each tenant's page`} />
          <KpiCard label="Pending plan requests" value={o.pendingPlanChanges.toLocaleString("en-IN")}
            tone={o.pendingPlanChanges > 0 ? "amber" : "default"} icon={ArrowLeftRight}
            sub={`${o.plans.active} active plans · ${o.plans.trialPlans} trial · ${o.plans.publicPlans} public`} />
        </div>
      )}

      {/* filters */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-500" />
          <Input value={search} onChange={(e) => { setSearch(e.target.value); setPage(1) }}
            onKeyDown={(e) => { if (e.key === "Enter") { setQuery(search); setPage(1) } }}
            placeholder="Search tenant or plan…" className="h-9 w-64 border-white/10 light:border-slate-200 bg-white/5 light:bg-slate-100 pl-8 text-xs" />
        </div>
        <Select value={status} onValueChange={(v) => { setStatus(v); setPage(1) }}>
          <SelectTrigger className="h-9 w-48 border-white/10 light:border-slate-200 bg-white/5 light:bg-slate-100 text-xs"><SelectValue /></SelectTrigger>
          <SelectContent>
            {STATUSES.map((s) => <SelectItem key={s} value={s}>{s === "ALL" ? "All statuses" : s === "LEGACY" ? "Legacy (no subscription)" : s.replace(/_/g, " ")}</SelectItem>)}
          </SelectContent>
        </Select>
        <Select value={cycle} onValueChange={(v) => { setCycle(v); setPage(1) }}>
          <SelectTrigger className="h-9 w-36 border-white/10 light:border-slate-200 bg-white/5 light:bg-slate-100 text-xs"><SelectValue /></SelectTrigger>
          <SelectContent>
            {[["ALL", "All cycles"], ["MONTHLY", "Monthly"], ["YEARLY", "Yearly"]].map(([v, l]) => <SelectItem key={v} value={v}>{l}</SelectItem>)}
          </SelectContent>
        </Select>
        {query && (
          <button type="button" onClick={() => { setQuery(""); setSearch("") }}
            className="text-[11px] font-semibold text-slate-500 underline-offset-2 hover:text-white light:hover:text-slate-900 hover:underline">
            clear “{query}”
          </button>
        )}
        <span className="ml-auto text-xs text-slate-500">
          {cycle === "ALL" ? `${total.toLocaleString("en-IN")} subscription${total === 1 ? "" : "s"}` : `${rows.length} of ${total.toLocaleString("en-IN")} on this page`}
        </span>
      </div>

      {error && <ErrorBanner message={error} />}
      {loading && !data ? <Loading /> : (
        <TableShell headers={["Tenant", "Admin", "Plan", "Cycle", "Status", "Price snapshot", "Start", "Ends", "Grace"]} empty={rows.length === 0}>
          {rows.map((r) => (
            <tr key={r.id} className="transition-colors hover:bg-white/[0.03] light:hover:bg-slate-100/60">
              <Td>
                <Link href={`/owner/tenants/${r.vendorId}`} className="font-medium text-white light:text-slate-900 hover:text-indigo-300 light:hover:text-indigo-700">{r.vendorName}</Link>
                <span className="block text-xs text-slate-500">{r.vendorCode}</span>
              </Td>
              <Td className="text-xs">{r.admin ? r.admin.email : "—"}</Td>
              <Td className="text-xs">{r.planName || "—"}</Td>
              <Td className="text-xs">{r.billingCycle ? <StatusChip status={r.billingCycle} /> : "—"}</Td>
              <Td><StatusChip status={r.status} /></Td>
              <Td className="tabular-nums text-xs">{r.price != null ? `৳${r.price.toLocaleString("en-IN")}` : "—"}</Td>
              <Td className="text-xs">{fmtDate(r.startDate)}</Td>
              <Td className="text-xs">{fmtDate(r.endDate)}</Td>
              <Td className="text-xs">{r.gracePeriodDays ? `${r.gracePeriodDays}d` : "—"}</Td>
            </tr>
          ))}
        </TableShell>
      )}

      {total > PAGE_SIZE && (
        <div className="flex items-center justify-center gap-3">
          <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}
            className="border-white/10 light:border-slate-200 bg-white/5 light:bg-slate-100 text-white light:text-slate-900">
            Previous
          </Button>
          <span className="text-xs text-slate-500">page {page} / {maxPage}</span>
          <Button variant="outline" size="sm" disabled={page >= maxPage} onClick={() => setPage((p) => p + 1)}
            className="border-white/10 light:border-slate-200 bg-white/5 light:bg-slate-100 text-white light:text-slate-900">
            Next
          </Button>
        </div>
      )}
      <p className="text-xs text-slate-500">
        Lifecycle actions (extend, change plan, cycle, grace, suspend, reactivate) live on each tenant&apos;s page — every
        action writes an append-only history event.
      </p>
    </div>
  )
}

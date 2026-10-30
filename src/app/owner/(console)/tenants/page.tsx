"use client"
// ============ /owner/tenants — Tenants console (Phase 5 P5 rebuild) =========
// Customer management (§23), rebuilt on the P0–P4 console design system — the
// capstone slice completing the panel. The old page hard-pinned page:1 /
// pageSize:100 with no pagination UI, hardcoded the plan filter to ALL and
// showed no KPIs. Now:
//   - KPI strip from owner.customers.overview (P5): tenant census with the
//     LEGACY anti-join, trials, new signups, the renewal-window trio.
//   - The plan filter is LIVE (options from the overview's planOptions —
//     the same names owner.tenants.list filters on).
//   - True pagination over the already-SQL-paged owner.tenants.list (the
//     Phase 3 SCL-7 rewrite: WHERE/ORDER/LIMIT in SQL, page-scoped usage).
//   - 60 s auto-refresh, dark + light modes.
import { useEffect, useState } from "react"
import Link from "next/link"
import { Building2, CalendarClock, ChevronLeft, ChevronRight, RefreshCw, Search, Sparkles, Users } from "lucide-react"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { useOwnerApi } from "@/saas/owner/client"
import { ErrorBanner, KpiCard, PageHeader, StatusChip, TableShell, Td, fmtDate, gb, Loading } from "@/saas/owner/ui"
import { cn } from "@/lib/utils"

type Row = {
  id: string
  name: string
  code: string
  active: boolean
  createdAt: string
  admin: { name: string; email: string } | null
  planName: string
  subscriptionStatus: string
  billingCycle: string | null
  endDate: string | null
  daysRemaining: number | null
  usage: {
    employees: number; users: number; branches: number; departments: number; devices: number
    trackingEmployees: number; storageUsedBytes: number
  }
  storageGb: number | null
  trackingStatus: string
}

type Overview = {
  generatedAt: string
  tenants: { total: number; active: number; inactive: number; legacy: number; new7d: number; new30d: number; trials: number }
  renewals: { expiring7d: number; expiring30d: number; overdue: number }
  fleet: { employees: number; portalUsers: number }
  planOptions: { id: string; name: string }[]
}

const PAGE_SIZE = 25

export default function TenantsPage() {
  const overview = useOwnerApi<Overview>("owner.customers.overview")
  const [search, setSearch] = useState("")
  const [query, setQuery] = useState("")
  const [status, setStatus] = useState("ALL")
  const [plan, setPlan] = useState("ALL")
  const [expiring, setExpiring] = useState("ALL")
  const [page, setPage] = useState(1)

  const { data, loading, error, reload } = useOwnerApi<{ rows: Row[]; total: number }>(
    "owner.tenants.list",
    { search: query || undefined, status, plan: plan === "ALL" ? undefined : plan, expiring, page, pageSize: PAGE_SIZE },
    [query, status, plan, expiring, page]
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

  return (
    <div className="space-y-5">
      <PageHeader
        title={
          <span className="flex items-center gap-2.5">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 to-violet-600 shadow-lg shadow-indigo-950/50">
              <Building2 className="h-4 w-4 text-white" />
            </span>
            Tenants
          </span>
        }
        sub="Every organization on the platform — subscription state, live usage and module access. Search, filters and paging all run in SQL."
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
          <KpiCard label="Tenants" value={o.tenants.total.toLocaleString("en-IN")} icon={Building2}
            sub={`${o.tenants.active.toLocaleString("en-IN")} active · ${o.tenants.legacy} legacy (no subscription) · ${o.tenants.inactive} inactive`} />
          <KpiCard label="New signups — 30d" value={o.tenants.new30d.toLocaleString("en-IN")} tone={o.tenants.new30d > 0 ? "emerald" : "default"} icon={Sparkles}
            sub={`${o.tenants.new7d} in the last 7 days · ${o.tenants.trials} live trials now`} />
          <KpiCard label="Expiring ≤ 30 days" value={o.renewals.expiring30d.toLocaleString("en-IN")}
            tone={o.renewals.expiring30d > 0 ? "amber" : "default"} icon={CalendarClock}
            sub={`${o.renewals.expiring7d} within 7 days · ${o.renewals.overdue} already past end date`} />
          <KpiCard label="Fleet workforce" value={o.fleet.employees.toLocaleString("en-IN")} tone="indigo" icon={Users}
            sub={`${o.fleet.portalUsers.toLocaleString("en-IN")} active portal users across all tenants`} />
        </div>
      )}

      {/* filters */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-500" />
          <Input value={search} onChange={(e) => { setSearch(e.target.value); setPage(1) }}
            onKeyDown={(e) => { if (e.key === "Enter") { setQuery(search); setPage(1) } }}
            placeholder="Organization, code or admin email…"
            className="h-9 w-72 border-white/10 light:border-slate-200 bg-white/5 light:bg-slate-100 pl-8 text-xs" />
        </div>
        <Select value={status} onValueChange={(v) => { setStatus(v); setPage(1) }}>
          <SelectTrigger className="h-9 w-36 border-white/10 light:border-slate-200 bg-white/5 light:bg-slate-100 text-xs"><SelectValue /></SelectTrigger>
          <SelectContent>
            {["ALL", "ACTIVE", "INACTIVE"].map((s) => <SelectItem key={s} value={s}>{s === "ALL" ? "All tenants" : s === "ACTIVE" ? "Active" : "Inactive"}</SelectItem>)}
          </SelectContent>
        </Select>
        <Select value={plan} onValueChange={(v) => { setPlan(v); setPage(1) }}>
          <SelectTrigger className="h-9 w-48 border-white/10 light:border-slate-200 bg-white/5 light:bg-slate-100 text-xs"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">All plans</SelectItem>
            <SelectItem value="LEGACY">Legacy (no subscription)</SelectItem>
            {(o?.planOptions || []).map((p) => <SelectItem key={p.id} value={p.name}>{p.name}</SelectItem>)}
          </SelectContent>
        </Select>
        <Select value={expiring} onValueChange={(v) => { setExpiring(v); setPage(1) }}>
          <SelectTrigger className="h-9 w-44 border-white/10 light:border-slate-200 bg-white/5 light:bg-slate-100 text-xs"><SelectValue /></SelectTrigger>
          <SelectContent>
            {[["ALL", "Any renewal date"], ["7", "Expiring ≤ 7 days"], ["30", "Expiring ≤ 30 days"], ["60", "Expiring ≤ 60 days"], ["EXPIRED", "Already expired"]].map(([v, l]) => (
              <SelectItem key={v} value={v}>{l}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        {query && (
          <button type="button" onClick={() => { setQuery(""); setSearch("") }}
            className="text-[11px] font-semibold text-slate-500 underline-offset-2 hover:text-white light:hover:text-slate-900 hover:underline">
            clear “{query}”
          </button>
        )}
        <span className="ml-auto text-xs text-slate-500">{total.toLocaleString("en-IN")} tenant{total === 1 ? "" : "s"}</span>
      </div>

      {error && <ErrorBanner message={error} />}
      {loading && !data ? <Loading /> : (
        <TableShell
          headers={["Organization", "Admin", "Plan", "Status", "Employees", "Devices", "Storage", "Tracking", "Renewal", ""]}
          empty={data?.rows.length === 0}
        >
          {data?.rows.map((r) => (
            <tr key={r.id} className="transition-colors hover:bg-white/[0.03] light:hover:bg-slate-100/60">
              <Td>
                <Link href={`/owner/tenants/${r.id}`} className="font-medium text-white light:text-slate-900 hover:text-indigo-300 light:hover:text-indigo-700">{r.name}</Link>
                <span className="block text-xs text-slate-500">{r.code}{!r.active && " · inactive"}</span>
              </Td>
              <Td>
                {r.admin ? <><span className="text-white light:text-slate-900">{r.admin.name}</span><span className="block text-xs text-slate-500">{r.admin.email}</span></> : "—"}
              </Td>
              <Td className="text-xs">{r.planName}</Td>
              <Td><StatusChip status={r.subscriptionStatus} /></Td>
              <Td className="tabular-nums">{r.usage.employees.toLocaleString("en-IN")}</Td>
              <Td className="tabular-nums">{r.usage.devices}</Td>
              <Td className="text-xs">
                {gb(r.usage.storageUsedBytes)} GB{r.storageGb ? ` / ${r.storageGb} GB` : ""}
              </Td>
              <Td className="text-xs">{r.usage.trackingEmployees > 0 ? `${r.usage.trackingEmployees} live` : "off"}</Td>
              <Td className="text-xs">
                {r.endDate ? (
                  <span className={r.daysRemaining != null && r.daysRemaining < 0 ? "text-red-300 light:text-red-600" : r.daysRemaining != null && r.daysRemaining <= 14 ? "text-amber-300 light:text-amber-700" : "text-slate-400 light:text-slate-600"}>
                    {fmtDate(r.endDate)}{r.daysRemaining != null && r.daysRemaining >= 0 ? ` (${r.daysRemaining}d)` : ""}
                  </span>
                ) : "—"}
              </Td>
              <Td>
                <Link href={`/owner/tenants/${r.id}`} className="flex h-8 w-8 items-center justify-center rounded-lg hover:bg-white/5 light:hover:bg-slate-100" aria-label={`Open ${r.name}`}>
                  <ChevronRight className="h-4 w-4 text-slate-500" />
                </Link>
              </Td>
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
    </div>
  )
}

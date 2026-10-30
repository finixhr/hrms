"use client"
// ============ /owner/quotas — Quota Utilization console (Phase 5 P1) ==========
// Fleet-wide plan-quota governance: per-quota KPIs (over / near / metered /
// unlimited per limit key — one fixed-set aggregate query), and the per-tenant
// utilization matrix where every cell is the SQL-computed used/cap pair and
// every row carries its worst-quota band (OVER / NEAR / OK), computed IN SQL
// so filtering and worst-first sorting never materialize the fleet.
// Bands: OVER = used >= cap (the create path is already blocked — no
// headroom); NEAR = >= 85% of cap; OK below. LEGACY tenants have no caps and
// never appear in the matrix (the Fleet grid covers them). All numbers come
// from owner.quotas.overview / owner.quotas.matrix — nothing fabricated.
import { useCallback, useEffect, useState } from "react"
import Link from "next/link"
import {
  Boxes, Building2, ChevronLeft, ChevronRight, CircleUser, Cpu, HardDrive, Loader2, MapPin,
  Network, RefreshCw, Search, Users,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { useOwnerApi, ownerRpc } from "@/saas/owner/client"
import { ErrorBanner, KpiCard, Loading, PageHeader, StatusChip, TableShell, Td, fmtDate } from "@/saas/owner/ui"
import { cn } from "@/lib/utils"

type Overview = {
  generatedAt: string
  subscribedTenants: number
  legacyTenants: number
  quotas: { key: string; over: number; near: number; metered: number; unlimited: number }[]
  alertPolicy: { enabled: boolean; thresholdPercent: number; nearFloorPercent: number }
}

type QuotaCell = { used: number; cap: number | null }
type MatrixRow = {
  id: string; name: string; code: string; createdAt: string
  admin: { name: string; email: string } | null
  planName: string; subscriptionStatus: string; endDate: string | null
  tier: string
  quotas: {
    EMPLOYEES: QuotaCell
    USERS: QuotaCell
    BRANCHES: QuotaCell
    DEPARTMENTS: QuotaCell
    DEVICES: QuotaCell
    TRACKING_EMPLOYEES: QuotaCell
    STORAGE: { usedBytes: number; capGb: number | null }
  }
}

type MatrixPage = { total: number; page: number; pageSize: number; rows: MatrixRow[] }

const TIERS = ["ALL", "OVER", "NEAR", "OK"] as const
type Tier = (typeof TIERS)[number]

const TIER_STYLE: Record<string, { chip: string; dot: string; label: string }> = {
  OVER: { chip: "border-rose-400/40 bg-rose-500/10 text-rose-300 light:text-rose-600", dot: "bg-rose-400", label: "Over" },
  NEAR: { chip: "border-amber-400/40 bg-amber-500/10 text-amber-300 light:text-amber-700", dot: "bg-amber-400", label: "Near" },
  OK: { chip: "border-emerald-400/40 bg-emerald-500/10 text-emerald-300 light:text-emerald-700", dot: "bg-emerald-400", label: "OK" },
}

const QUOTA_META: Record<string, { label: string; icon: any }> = {
  EMPLOYEES: { label: "Active employees", icon: Users },
  USERS: { label: "App users", icon: CircleUser },
  BRANCHES: { label: "Branches", icon: Building2 },
  DEPARTMENTS: { label: "Departments", icon: Network },
  DEVICES: { label: "Attendance devices", icon: Cpu },
  TRACKING_EMPLOYEES: { label: "Live tracking", icon: MapPin },
  STORAGE: { label: "Storage", icon: HardDrive },
}

function fmtGB(bytes: number): string {
  const gb = bytes / 1024 ** 3
  return gb >= 10 ? `${gb.toFixed(1)} GB` : gb >= 1 ? `${gb.toFixed(2)} GB` : `${(bytes / 1024 ** 2).toFixed(0)} MB`
}

/** One utilization cell: used/cap + a two-tone micro bar. cap null = the
 *  plan (or a per-tenant override) is unlimited for this quota — render ∞. */
function QuotaCellBar({ used, cap, unitFmt }: { used: number; cap: number | null; unitFmt?: (n: number) => string }) {
  const fmt = unitFmt || ((n: number) => n.toLocaleString())
  if (cap == null) {
    return (
      <span className="flex min-w-[86px] flex-col gap-1">
        <span className="text-xs tabular-nums text-slate-400 light:text-slate-600">{fmt(used)} <span className="text-slate-600 light:text-slate-500">/ ∞</span></span>
        <span className="h-1 w-full overflow-hidden rounded-full bg-white/10 light:bg-slate-200" />
      </span>
    )
  }
  const pct = Math.min(100, Math.round((used / cap) * 100))
  const band: "over" | "near" | "ok" = used >= cap ? "over" : pct >= 85 ? "near" : "ok"
  const barCls = band === "over" ? "bg-rose-400" : band === "near" ? "bg-amber-400" : "bg-emerald-400"
  const numCls = band === "over" ? "text-rose-300 light:text-rose-600 font-semibold" : band === "near" ? "text-amber-300 light:text-amber-700" : "text-slate-200 light:text-slate-800"
  return (
    <span className="flex min-w-[86px] flex-col gap-1">
      <span className={cn("text-xs tabular-nums", numCls)}>{fmt(used)} / {fmt(cap)}</span>
      <span className="h-1 w-full overflow-hidden rounded-full bg-white/10 light:bg-slate-200">
        <span className={cn("block h-full rounded-full transition-all", barCls)} style={{ width: `${Math.max(3, pct)}%` }} />
      </span>
    </span>
  )
}

export default function OwnerQuotasPage() {
  const overview = useOwnerApi<Overview>("owner.quotas.overview")
  const [page, setPage] = useState(1)
  const [tier, setTier] = useState<Tier>("ALL")
  const [search, setSearch] = useState("")
  const [query, setQuery] = useState("")
  const [rows, setRows] = useState<MatrixRow[]>([])
  const [total, setTotal] = useState(0)
  const [pageSize] = useState(20)
  const [gridLoading, setGridLoading] = useState(true)
  const [gridError, setGridError] = useState<string | null>(null)

  // auto-refresh the KPI overview every 60 s (interval cleaned up on unmount)
  useEffect(() => {
    const t = setInterval(() => { overview.reload().catch(() => {}) }, 60_000)
    return () => clearInterval(t)
  }, [overview.reload])

  const loadGrid = useCallback(async () => {
    setGridLoading(true)
    setGridError(null)
    try {
      const d = await ownerRpc<MatrixPage>("owner.quotas.matrix", { page, pageSize, tier, search: query || undefined })
      setRows(d.rows)
      setTotal(d.total)
    } catch (e: unknown) {
      setGridError((e as Error)?.message || "Failed to load the quota matrix")
    } finally {
      setGridLoading(false)
    }
  }, [page, pageSize, tier, query])

  useEffect(() => { loadGrid().catch(() => {}) }, [loadGrid])

  const totalPages = Math.max(1, Math.ceil(total / pageSize))
  const o = overview.data
  const sum = (sel: (q: Overview["quotas"][number]) => number) => (o?.quotas || []).reduce((a, q) => a + sel(q), 0)
  const overPoints = sum((q) => q.over)
  const nearPoints = sum((q) => q.near)
  const meteredPoints = sum((q) => q.metered)
  const unlimitedPoints = sum((q) => q.unlimited)

  return (
    <div className="space-y-5">
      <PageHeader
        title={
          <span className="flex items-center gap-2.5">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-amber-500 to-rose-600 shadow-lg shadow-rose-950/50">
              <Boxes className="h-4 w-4 text-white" />
            </span>
            Quota Utilization
          </span>
        }
        sub="Plan-cap governance across the fleet. Over = at/above cap (creates are already blocked server-side; existing records stay usable). Near = 85%+ of cap. Unlimited cells are null caps on that plan."
        actions={
          <Button variant="outline" size="sm" onClick={() => { overview.reload().catch(() => {}); loadGrid().catch(() => {}) }}
            disabled={overview.loading || gridLoading}
            className="h-9 border-white/10 light:border-slate-300 bg-white/5 light:bg-white text-white light:text-slate-900">
            {overview.loading || gridLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />} Refresh
          </Button>
        }
      />

      {overview.error && <ErrorBanner message={overview.error} />}

      {overview.loading && !o ? (
        <Loading label="Metering the fleet…" />
      ) : o ? (
        <>
          {/* ---- KPI hero (honest framing: tenant × quota points) ---- */}
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <KpiCard label="Over-quota points" value={overPoints.toLocaleString()} icon={Boxes}
              tone={overPoints > 0 ? "red" : "default"} sub={`${o.subscribedTenants.toLocaleString()} subscribed tenant${o.subscribedTenants === 1 ? "" : "s"} · counts each tenant × quota at/above cap`} />
            <KpiCard label="Near-threshold points" value={nearPoints.toLocaleString()} icon={Cpu}
              tone={nearPoints > 0 ? "amber" : "default"} sub={`85–99% of cap — upgrade-conversation territory`} />
            <KpiCard label="Metered quotas" value={meteredPoints.toLocaleString()} icon={HardDrive}
              sub={`quotas with a cap in effect (plan or per-tenant override)`} />
            <KpiCard label="Unlimited quotas" value={unlimitedPoints.toLocaleString()} icon={CircleUser}
              sub={`${o.legacyTenants.toLocaleString()} legacy tenant${o.legacyTenants === 1 ? "" : "s"} ride outside the plan system entirely`} />
          </div>

          {/* ---- per-quota tiles ---- */}
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {o.quotas.map((q) => {
              const Meta = QUOTA_META[q.key] || { label: q.key, icon: Boxes }
              const Icon = Meta.icon
              return (
                <div key={q.key} className={cn(
                  "rounded-2xl border p-4",
                  q.over > 0 ? "border-rose-400/40 bg-rose-500/10" : q.near > 0 ? "border-amber-400/40 bg-amber-500/10" : "border-white/10 light:border-slate-200 bg-white/[0.03] light:bg-slate-100/60",
                )}>
                  <div className="flex items-center justify-between">
                    <p className="text-[11px] font-bold uppercase tracking-widest text-slate-400 light:text-slate-600">{Meta.label}</p>
                    <Icon className="h-4 w-4 text-slate-500" />
                  </div>
                  <p className={cn("mt-1.5 text-2xl font-bold tabular-nums", q.over > 0 ? "text-rose-300 light:text-rose-600" : "text-white light:text-slate-900")}>
                    {q.over.toLocaleString()}
                    <span className="ml-1.5 text-[11px] font-semibold uppercase tracking-widest text-slate-500">over</span>
                  </p>
                  <p className="mt-1 text-[11px] leading-relaxed text-slate-400 light:text-slate-600">
                    {q.near.toLocaleString()} near · {q.metered.toLocaleString()} metered · {q.unlimited.toLocaleString()} unlimited
                  </p>
                </div>
              )
            })}
            {/* alert policy strip rides the last grid slot */}
            <Link href="/owner/settings" className={cn(
              "flex flex-col justify-between rounded-2xl border p-4 transition-colors",
              o.alertPolicy.enabled ? "border-emerald-400/40 bg-emerald-500/10 hover:bg-emerald-500/20" : "border-amber-400/40 bg-amber-500/10 hover:bg-amber-500/20",
            )}>
              <div className="flex items-center justify-between">
                <p className="text-[11px] font-bold uppercase tracking-widest text-slate-400 light:text-slate-600">Threshold alerts</p>
                <span className={cn("rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-widest",
                  o.alertPolicy.enabled ? "border-emerald-400/40 bg-emerald-500/20 text-emerald-300 light:text-emerald-700" : "border-amber-400/40 bg-amber-500/20 text-amber-300 light:text-amber-700")}>
                  {o.alertPolicy.enabled ? "On" : "Off"}
                </span>
              </div>
              <p className="mt-1.5 text-2xl font-bold tabular-nums text-white light:text-slate-900">≥ {o.alertPolicy.thresholdPercent}%</p>
              <p className="mt-1 text-[11px] leading-relaxed text-slate-400 light:text-slate-600">
                daily digest to the owner team + the alert webhook · deduped per tenant per quota monthly · tune it in Settings → Alerts
              </p>
            </Link>
          </div>
        </>
      ) : null}

      {/* ---- matrix grid ---- */}
      <div className="rounded-2xl border border-white/10 light:border-slate-200 bg-white/[0.03] light:bg-slate-100/60">
        <div className="flex flex-wrap items-center gap-3 border-b border-white/10 light:border-slate-200 px-4 py-3.5 sm:px-5">
          <p className="text-[11px] font-bold uppercase tracking-widest text-slate-500">Utilization matrix</p>
          <div className="flex flex-wrap items-center gap-1.5">
            {TIERS.map((t) => (
              <button key={t} type="button" onClick={() => { setTier(t); setPage(1) }}
                className={`rounded-full border px-3 py-1 text-[11px] font-bold uppercase tracking-widest transition-colors ${
                  tier === t
                    ? t === "ALL"
                      ? "border-blue-400/50 bg-blue-500/15 text-blue-300 light:text-blue-700"
                      : TIER_STYLE[t]?.chip || ""
                    : "border-white/10 light:border-slate-300 text-slate-500 light:text-slate-600 hover:text-slate-300 light:hover:text-slate-800"
                }`}>
                {t === "ALL" ? "All tenants" : TIER_STYLE[t]?.label}
              </button>
            ))}
          </div>
          <form className="ml-auto flex items-center gap-2" onSubmit={(e) => { e.preventDefault(); setQuery(search.trim()); setPage(1) }}>
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-500" />
              <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Tenant, code or admin email…"
                className="h-9 w-56 border-white/10 light:border-slate-300 bg-white/5 light:bg-white pl-8 text-xs text-white light:text-slate-900" />
            </div>
            <Button type="submit" size="sm" className="h-9 bg-gradient-to-r from-amber-500 to-rose-600 text-white light:text-slate-900">Find</Button>
          </form>
        </div>

        {gridError && <div className="px-5 pt-4"><ErrorBanner message={gridError} /></div>}
        {gridLoading && rows.length === 0 ? (
          <Loading label="Loading the matrix…" />
        ) : (
          <TableShell headers={["Band", "Tenant", "Plan", "Employees", "Users", "Branches", "Departments", "Devices", "Tracking", "Storage", "Term"]} empty={rows.length === 0}>
            {rows.map((r) => {
              const t = TIER_STYLE[r.tier] || TIER_STYLE.OK
              const q = r.quotas
              return (
                <tr key={r.id} className="group transition-colors hover:bg-white/[0.03] light:hover:bg-slate-100/70">
                  <Td>
                    <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-widest ${t.chip}`}>
                      <span className={`h-1.5 w-1.5 rounded-full ${t.dot}`} />
                      {t.label}
                    </span>
                  </Td>
                  <Td>
                    <Link href={`/owner/tenants/${r.id}`} className="flex flex-col">
                      <span className="font-semibold text-white light:text-slate-900 group-hover:text-amber-600 light:group-hover:text-amber-700">{r.name}</span>
                      <span className="text-[11px] text-slate-500">
                        {r.code}{r.admin ? ` · ${r.admin.email}` : ""}
                      </span>
                    </Link>
                  </Td>
                  <Td>
                    <span className="flex flex-col gap-1">
                      <span className="text-xs font-medium text-slate-200 light:text-slate-800">{r.planName}</span>
                      <StatusChip status={r.subscriptionStatus} />
                    </span>
                  </Td>
                  <Td><QuotaCellBar used={q.EMPLOYEES.used} cap={q.EMPLOYEES.cap} /></Td>
                  <Td><QuotaCellBar used={q.USERS.used} cap={q.USERS.cap} /></Td>
                  <Td><QuotaCellBar used={q.BRANCHES.used} cap={q.BRANCHES.cap} /></Td>
                  <Td><QuotaCellBar used={q.DEPARTMENTS.used} cap={q.DEPARTMENTS.cap} /></Td>
                  <Td><QuotaCellBar used={q.DEVICES.used} cap={q.DEVICES.cap} /></Td>
                  <Td><QuotaCellBar used={q.TRACKING_EMPLOYEES.used} cap={q.TRACKING_EMPLOYEES.cap} /></Td>
                  {/* STORAGE: both sides in BYTES so the ratio (and therefore the
                      band + bar width) is unit-correct; fmtGB renders both. */}
                  <Td><QuotaCellBar used={q.STORAGE.usedBytes} cap={q.STORAGE.capGb == null ? null : q.STORAGE.capGb * 1024 ** 3} unitFmt={(n) => fmtGB(n)} /></Td>
                  <Td className="text-xs text-slate-400 light:text-slate-600">{r.endDate ? fmtDate(r.endDate) : "—"}</Td>
                </tr>
              )
            })}
          </TableShell>
        )}

        {/* pagination */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-white/10 light:border-slate-200 px-4 py-3 sm:px-5">
          <p className="text-xs text-slate-500">
            {total.toLocaleString()} subscribed tenant{total === 1 ? "" : "s"} · page {page} of {totalPages} · worst-band first
          </p>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" disabled={page <= 1 || gridLoading} onClick={() => setPage((p) => Math.max(1, p - 1))}
              className="h-8 border-white/10 light:border-slate-300 bg-white/5 light:bg-white text-white light:text-slate-900">
              <ChevronLeft className="h-3.5 w-3.5" /> Prev
            </Button>
            <Button variant="outline" size="sm" disabled={page >= totalPages || gridLoading} onClick={() => setPage((p) => p + 1)}
              className="h-8 border-white/10 light:border-slate-300 bg-white/5 light:bg-white text-white light:text-slate-900">
              Next <ChevronRight className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}

"use client"
// ============ /owner/storage — Storage Monitoring console (Part J §15) =======
// Platform-wide storage governance, one RPC answering everything: fleet KPIs
// (allocated / consumed / remaining + the over/near tenant counts), the
// provider + object summary, the UsageSnapshot monthly trend, and the
// per-tenant grid where the tier band (OVER / NEAR / OK) is computed IN SQL
// server-side so filtering + worst-first sorting never materializes the fleet.
// Bands mirror the Quota Utilization console (OVER = at/above quota — uploads
// are already blocked by requireCapacity; NEAR = 85%+ of quota, the
// quotas.ts NEAR_FLOOR_PCT single source). All numbers come from
// owner.storage.overview — nothing fabricated.
//
// HONEST FRAMING: "allocated" is the SUM OF TENANT QUOTAS (plan or per-tenant
// override storageGb), NOT physical provider capacity — the platform runs on
// shared buckets. Unlimited tenants render ∞ and never count toward
// allocated/remaining. Consumed includes every UsageRollup row (legacy tenants
// store real bytes too).
import { useEffect, useState } from "react"
import Link from "next/link"
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts"
import {
  Cloud, Database, HardDrive, Loader2, Package, RefreshCw, Search, Server,
  ChevronLeft, ChevronRight, Infinity as InfinityIcon,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { useOwnerApi } from "@/saas/owner/client"
import { ErrorBanner, KpiCard, Loading, PageHeader, TableShell, Td } from "@/saas/owner/ui"
import { cn } from "@/lib/utils"

type Totals = {
  allocatedBytes: number
  consumedBytes: number
  remainingBytes: number
  usedPercent: number
  tenants: number
  unlimitedTenants: number
  objects: number
  providers: { r2: number; cloudinary: number; local: number }
}
type Row = {
  vendorId: string; vendorName: string; vendorCode: string; planName: string
  storageGb: number | null
  allocatedBytes: number | null
  consumedBytes: number
  remainingBytes: number | null
  usedPercent: number | null
  tier: string
  objects: number
}
type Overview = {
  generatedAt: string
  totals: Totals
  tiers: { over: number; near: number; ok: number }
  page: number
  take: number
  total: number
  rows: Row[]
  trend: { month: string; totalBytes: number }[]
}

const TIERS = ["ALL", "OVER", "NEAR", "OK"] as const
type Tier = (typeof TIERS)[number]

const TIER_STYLE: Record<string, { chip: string; dot: string; bar: string; label: string }> = {
  OVER: { chip: "border-rose-400/40 bg-rose-500/10 text-rose-300 light:text-rose-600", dot: "bg-rose-400", bar: "bg-rose-400", label: "Over" },
  NEAR: { chip: "border-amber-400/40 bg-amber-500/10 text-amber-300 light:text-amber-700", dot: "bg-amber-400", bar: "bg-amber-400", label: "Near" },
  OK: { chip: "border-emerald-400/40 bg-emerald-500/10 text-emerald-300 light:text-emerald-700", dot: "bg-emerald-400", bar: "bg-emerald-400", label: "OK" },
}

/** Human-readable bytes: GB at 2 decimals (1 past 100 GB for column sanity),
 *  MB below 1 GB, KB/B for the degenerate tail. */
function fmtBytes(bytes: number): string {
  if (!Number.isFinite(bytes)) return "—"
  const gb = bytes / 1024 ** 3
  if (gb >= 100) return `${gb.toFixed(1)} GB`
  if (gb >= 1) return `${gb.toFixed(2)} GB`
  const mb = bytes / 1024 ** 2
  if (mb >= 1) return `${mb.toFixed(1)} MB`
  const kb = bytes / 1024
  return kb >= 1 ? `${kb.toFixed(0)} KB` : `${bytes} B`
}

/** The % used micro bar — color follows the SERVER-computed tier band, so the
 *  bar and the chip in the same row can never disagree. null = unlimited. */
function UsageBar({ row }: { row: Row }) {
  const t = TIER_STYLE[row.tier] || TIER_STYLE.OK
  if (row.usedPercent == null) {
    return <span className="inline-flex items-center gap-1 text-xs text-slate-500 light:text-slate-600"><InfinityIcon className="h-3.5 w-3.5" /> unlimited</span>
  }
  const pct = row.usedPercent
  return (
    <span className="flex min-w-[96px] flex-col gap-1">
      <span className={cn("text-xs tabular-nums", row.tier === "OVER" ? "text-rose-300 light:text-rose-600 font-semibold" : row.tier === "NEAR" ? "text-amber-300 light:text-amber-700" : "text-slate-200 light:text-slate-800")}>
        {pct.toFixed(1)}%
      </span>
      <span className="h-1 w-full overflow-hidden rounded-full bg-white/10 light:bg-slate-200">
        <span className={cn("block h-full rounded-full transition-all", t.bar)} style={{ width: `${Math.min(100, Math.max(2, pct))}%` }} />
      </span>
    </span>
  )
}

export default function OwnerStoragePage() {
  const [page, setPage] = useState(1)
  const [tier, setTier] = useState<Tier>("ALL")
  const [search, setSearch] = useState("")
  const [query, setQuery] = useState("")
  // ONE action answers totals + tiers + the paged grid + the trend — a
  // payload change (page/tier/committed search) re-runs the hook's load.
  const { data, loading, error, reload } = useOwnerApi<Overview>("owner.storage.overview", {
    page, take: 25, tier, search: query || undefined,
  })

  // auto-refresh every 60 s (interval cleaned up on unmount; reload identity
  // changes with the payload, resetting the timer on every filter flip)
  useEffect(() => {
    const t = setInterval(() => { reload().catch(() => {}) }, 60_000)
    return () => clearInterval(t)
  }, [reload])

  const o = data
  const totalPages = o ? Math.max(1, Math.ceil(o.total / o.take)) : 1
  const platformPct = o ? o.totals.usedPercent : 0

  return (
    <div className="space-y-5">
      <PageHeader
        title={
          <span className="flex items-center gap-2.5">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 to-blue-600 shadow-lg shadow-indigo-950/50">
              <HardDrive className="h-4 w-4 text-white" />
            </span>
            Storage Monitoring
          </span>
        }
        sub="Platform-wide storage: quota allocation, consumption and the per-tenant utilization grid. Over = at/above quota (uploads are already blocked server-side). Near = 85%+ of quota — same band as the Quota Utilization console. Allocated is the sum of tenant quotas, not physical provider capacity."
        actions={
          <Button variant="outline" size="sm" onClick={() => reload().catch(() => {})} disabled={loading}
            className="h-9 border-white/10 light:border-slate-300 bg-white/5 light:bg-white text-white light:text-slate-900">
            {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />} Refresh
          </Button>
        }
      />

      {error && <ErrorBanner message={error} />}

      {loading && !o ? (
        <Loading label="Metering platform storage…" />
      ) : o ? (
        <>
          {/* ---- KPI hero ---- */}
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <KpiCard label="Total allocated" value={fmtBytes(o.totals.allocatedBytes)} icon={HardDrive}
              sub={`${o.totals.tenants.toLocaleString()} subscribed tenant${o.totals.tenants === 1 ? "" : "s"} · sum of tenant quotas, not provider capacity`} />
            {/* consumed carries its own usage bar (band-colored like the grid) */}
            <div className="rounded-2xl border border-white/10 light:border-slate-200 bg-white/[0.03] light:bg-slate-100/60 p-5">
              <div className="flex items-center justify-between">
                <p className="text-[11px] font-bold uppercase tracking-widest text-slate-500">Total consumed</p>
                <Database className="h-4 w-4 text-slate-600 light:text-slate-500" />
              </div>
              <p className="mt-2 text-3xl font-bold tabular-nums tracking-tight text-white light:text-slate-900">{fmtBytes(o.totals.consumedBytes)}</p>
              <div className="mt-2.5 h-1.5 w-full overflow-hidden rounded-full bg-white/10 light:bg-slate-200">
                <span
                  className={cn("block h-full rounded-full transition-all", platformPct >= 100 ? "bg-rose-400" : platformPct >= 85 ? "bg-amber-400" : "bg-emerald-400")}
                  style={{ width: `${Math.min(100, Math.max(2, platformPct))}%` }}
                />
              </div>
              <p className="mt-1 text-xs text-slate-500">{platformPct.toFixed(1)}% of allocated · every tenant&apos;s reconciled rollup, legacy included</p>
            </div>
            <KpiCard label="Total remaining" value={fmtBytes(o.totals.remainingBytes)} icon={Server}
              sub="metered tenants only — max(0, quota − used); unlimited tenants add none" />
            <KpiCard label="Tenants over / near" value={`${o.tiers.over.toLocaleString()} / ${o.tiers.near.toLocaleString()}`}
              tone={o.tiers.over > 0 ? "red" : o.tiers.near > 0 ? "amber" : "default"} icon={Package}
              sub={`${o.tiers.ok.toLocaleString()} OK · ${o.totals.unlimitedTenants.toLocaleString()} unlimited (always OK)`} />
          </div>

          {/* ---- platform summary: providers + objects + honest-framing note ---- */}
          <div className="rounded-2xl border border-white/10 light:border-slate-200 bg-white/[0.03] light:bg-slate-100/60 p-5">
            <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
              <p className="text-[11px] font-bold uppercase tracking-widest text-slate-500">Stored objects</p>
              <p className="text-2xl font-bold tabular-nums text-white light:text-slate-900">{o.totals.objects.toLocaleString()}</p>
              <span className="text-xs text-slate-500">status STORED, all providers</span>
              <div className="ml-auto flex flex-wrap items-center gap-2">
                {[
                  { id: "r2", label: "Cloudflare R2", count: o.totals.providers.r2, icon: Cloud },
                  { id: "cloudinary", label: "Cloudinary", count: o.totals.providers.cloudinary, icon: Cloud },
                  { id: "local", label: "Local fallback", count: o.totals.providers.local, icon: Server },
                ].map((p) => (
                  <span key={p.id}
                    className={cn("inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-[11px] font-semibold",
                      p.count > 0
                        ? "border-indigo-400/40 bg-indigo-500/10 text-indigo-300 light:text-indigo-700"
                        : "border-white/10 light:border-slate-300 text-slate-500 light:text-slate-600")}>
                    <p.icon className="h-3.5 w-3.5" /> {p.label} · {p.count.toLocaleString()}
                  </span>
                ))}
              </div>
            </div>
            <p className="mt-3 text-[11px] leading-relaxed text-slate-500">
              “Allocated” is the sum of tenant quotas (plan or per-tenant override), not physical provider capacity — tenants share the platform&apos;s buckets.
              {o.totals.unlimitedTenants > 0 && <> {o.totals.unlimitedTenants.toLocaleString()} tenant{o.totals.unlimitedTenants === 1 ? " has" : "s have"} unlimited storage (excluded from allocated/remaining).</>}
              {" "}Configure providers under Settings → Integrations → Storage.
            </p>
          </div>

          {/* ---- trend (hidden until the UsageSnapshot series has months) ---- */}
          {o.trend.length > 0 && (
            <div className="rounded-2xl border border-white/10 light:border-slate-200 bg-white/[0.03] light:bg-slate-100/60 p-5">
              <p className="mb-4 text-sm font-bold text-white light:text-slate-900">
                Platform storage trend — last {o.trend.length} metered month{o.trend.length === 1 ? "" : "s"}
              </p>
              <ResponsiveContainer width="100%" height={220}>
                <AreaChart data={o.trend.map((t) => ({ month: t.month, gb: +(t.totalBytes / 1024 ** 3).toFixed(3) }))}>
                  <defs>
                    <linearGradient id="storageTrendFill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#6366f1" stopOpacity={0.5} />
                      <stop offset="95%" stopColor="#6366f1" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                  <XAxis dataKey="month" stroke="#64748b" fontSize={11} />
                  <YAxis stroke="#64748b" fontSize={11} unit=" GB" />
                  <Tooltip contentStyle={{ background: "#0f172a", border: "1px solid #1e293b", borderRadius: 12, color: "#e2e8f0" }}
                    formatter={(v) => [`${Number(v).toFixed(2)} GB`, "Consumed"]} />
                  <Area type="monotone" dataKey="gb" name="Consumed" stroke="#6366f1" fill="url(#storageTrendFill)" strokeWidth={2} />
                </AreaChart>
              </ResponsiveContainer>
              <p className="mt-2 text-[11px] text-slate-500">
                UsageSnapshot monthly series — the platform-wide sum of every tenant&apos;s reconciled storage rollup (the nightly metering pass freezes each month&apos;s last value).
              </p>
            </div>
          )}

          {/* ---- per-tenant grid ---- */}
          <div className="rounded-2xl border border-white/10 light:border-slate-200 bg-white/[0.03] light:bg-slate-100/60">
            <div className="flex flex-wrap items-center gap-3 border-b border-white/10 light:border-slate-200 px-4 py-3.5 sm:px-5">
              <p className="text-[11px] font-bold uppercase tracking-widest text-slate-500">Tenant storage</p>
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
                  <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Tenant name or code…"
                    className="h-9 w-56 border-white/10 light:border-slate-300 bg-white/5 light:bg-white pl-8 text-xs text-white light:text-slate-900" />
                </div>
                <Button type="submit" size="sm" className="h-9 bg-gradient-to-r from-indigo-500 to-blue-600 text-white light:text-slate-900">Find</Button>
              </form>
            </div>

            {loading && o.rows.length === 0 ? (
              <Loading label="Loading the storage grid…" />
            ) : (
              <TableShell headers={["Band", "Tenant", "Plan", "Quota", "Used", "Remaining", "% used", "Objects"]} empty={o.rows.length === 0}>
                {o.rows.map((r) => {
                  const t = TIER_STYLE[r.tier] || TIER_STYLE.OK
                  return (
                    <tr key={r.vendorId} className="group transition-colors hover:bg-white/[0.03] light:hover:bg-slate-100/70">
                      <Td>
                        <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-widest ${t.chip}`}>
                          <span className={`h-1.5 w-1.5 rounded-full ${t.dot}`} />
                          {t.label}
                        </span>
                      </Td>
                      <Td>
                        <Link href={`/owner/tenants/${r.vendorId}`} className="flex flex-col">
                          <span className="font-semibold text-white light:text-slate-900 group-hover:text-indigo-400 light:group-hover:text-indigo-700">{r.vendorName}</span>
                          <span className="text-[11px] text-slate-500">{r.vendorCode}</span>
                        </Link>
                      </Td>
                      <Td><span className="text-xs font-medium text-slate-200 light:text-slate-800">{r.planName}</span></Td>
                      <Td>
                        {r.storageGb == null ? (
                          <span className="inline-flex items-center gap-1 text-xs text-slate-400 light:text-slate-600"><InfinityIcon className="h-3.5 w-3.5" /> Unlimited</span>
                        ) : (
                          <span className="text-xs tabular-nums text-slate-300 light:text-slate-700">{r.storageGb.toLocaleString()} GB</span>
                        )}
                      </Td>
                      <Td><span className="text-xs tabular-nums text-slate-200 light:text-slate-800">{fmtBytes(r.consumedBytes)}</span></Td>
                      <Td>
                        {r.remainingBytes == null ? (
                          <span className="inline-flex items-center gap-1 text-xs text-slate-400 light:text-slate-600"><InfinityIcon className="h-3.5 w-3.5" /></span>
                        ) : (
                          <span className="text-xs tabular-nums text-slate-300 light:text-slate-700">{fmtBytes(r.remainingBytes)}</span>
                        )}
                      </Td>
                      <Td><UsageBar row={r} /></Td>
                      <Td><span className="text-xs tabular-nums text-slate-400 light:text-slate-600">{r.objects.toLocaleString()}</span></Td>
                    </tr>
                  )
                })}
              </TableShell>
            )}

            {/* pagination */}
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-white/10 light:border-slate-200 px-4 py-3 sm:px-5">
              <p className="text-xs text-slate-500">
                {o.total.toLocaleString()} subscribed tenant{o.total === 1 ? "" : "s"} · page {o.page} of {totalPages} · worst-band first, then bytes consumed
              </p>
              <div className="flex items-center gap-2">
                <Button variant="outline" size="sm" disabled={page <= 1 || loading} onClick={() => setPage((p) => Math.max(1, p - 1))}
                  className="h-8 border-white/10 light:border-slate-300 bg-white/5 light:bg-white text-white light:text-slate-900">
                  <ChevronLeft className="h-3.5 w-3.5" /> Prev
                </Button>
                <Button variant="outline" size="sm" disabled={page >= totalPages || loading} onClick={() => setPage((p) => p + 1)}
                  className="h-8 border-white/10 light:border-slate-300 bg-white/5 light:bg-white text-white light:text-slate-900">
                  Next <ChevronRight className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
          </div>
        </>
      ) : null}
    </div>
  )
}

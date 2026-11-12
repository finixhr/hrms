"use client"
// ============ /owner — dashboard (real DB data) ============
// Every number is computed from actual records — zero, "no data yet", or real
// counts. Never fabricated (§44).
// PRF-13 (P2 wave, 2026-11-09) — recharts is code-split out of the first-load
// JS: the six chart cards live in ./dashboard-charts (next/dynamic, ssr off,
// skeleton while the chunk streams in — same split as the HRM dashboard's
// widgets). KPI cards + the renewals list render from this module alone.
import dynamic from "next/dynamic"
import {
  Building2, CalendarClock, Database, Landmark, TrendingUp, Users, Wallet,
} from "lucide-react"
import {
  ErrorBanner, KpiCard, Loading, PageHeader, StatusChip, fmtDate, gb,
} from "@/saas/owner/ui"
import { useOwnerApi } from "@/saas/owner/client"

const DashboardCharts = dynamic(
  () => import("./dashboard-charts").then((m) => ({ default: m.DashboardCharts })),
  {
    ssr: false,
    loading: () => (
      <div className="grid gap-4 xl:grid-cols-2" aria-busy="true" aria-label="Loading charts">
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <div key={i} className="h-[264px] animate-pulse rounded-2xl border border-white/10 light:border-slate-200 bg-white/[0.03] light:bg-slate-100/60" />
        ))}
      </div>
    ),
  },
)

type Overview = {
  tenants: { total: number; active: number; legacy: number; pendingRegistrations: number; trial: number; expired: number; suspended: number }
  workforce: { totalEmployees: number; activeEmployees: number; employeesThisMonth: number }
  subscriptions: {
    monthly: number; yearly: number; cancelled: number; mrr: number; arr: number
    upcomingRenewals: { id: string; vendorId: string; planName: string; cycle: string; endDate: string; days: number }[]
    expiring7: number; expiring30: number; expiring60: number
  }
  platform: { storageUsedBytes: number; storageQuotaGb: number; devices: number; trackingEnabledEmployees: number; operatingSubscriptions: number }
  charts: {
    growth: { month: string; registrations: number; approvedTenants: number; activeTenants: number }[]
    planDistribution: { name: string; count: number }[]
    statusDistribution: { name: string; count: number }[]
    employeeDistribution: { name: string; count: number }[]
    featureAdoption: { name: string; count: number }[]
    storageUsage: { name: string; gb: number }[]
  }
}

export default function OwnerDashboard() {
  const { data, loading, error } = useOwnerApi<Overview>("owner.dashboard.overview")

  if (loading) return <Loading label="Computing platform metrics…" />
  if (error) return <ErrorBanner message={error} />
  if (!data) return null

  const o = data
  return (
    <div className="space-y-6">
      <PageHeader
        title="Platform Overview"
        sub="Live metrics computed from actual records — no projected or invented numbers."
      />

      {/* KPI rows */}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard label="Total tenants" value={o.tenants.total} sub={`${o.tenants.active} active · ${o.tenants.legacy} legacy (pre-subscription)`} icon={Building2} />
        <KpiCard label="Pending applications" value={o.tenants.pendingRegistrations} tone={o.tenants.pendingRegistrations > 0 ? "amber" : "default"} sub="awaiting review" icon={CalendarClock} />
        <KpiCard label="Workforce (all tenants)" value={o.workforce.activeEmployees.toLocaleString()} sub={`${o.workforce.employeesThisMonth} added this month · ${o.workforce.totalEmployees} total rows`} icon={Users} />
        <KpiCard label="MRR" value={`৳${o.subscriptions.mrr.toLocaleString()}`} tone="emerald" sub={`ARR ৳${o.subscriptions.arr.toLocaleString()} · from actual price snapshots`} icon={Wallet} />
        <KpiCard label="Monthly subs" value={o.subscriptions.monthly} icon={Landmark} />
        <KpiCard label="Yearly subs" value={o.subscriptions.yearly} icon={Landmark} />
        <KpiCard label="Expiring ≤ 7 days" value={o.subscriptions.expiring7} tone={o.subscriptions.expiring7 > 0 ? "amber" : "default"} sub={`≤30d: ${o.subscriptions.expiring30} · ≤60d: ${o.subscriptions.expiring60}`} icon={CalendarClock} />
        <KpiCard label="Storage used" value={`${gb(o.platform.storageUsedBytes)} GB`} sub={`quota across plans: ${o.platform.storageQuotaGb} GB`} icon={Database} />
      </div>

      {/* charts — PRF-13: dynamically imported (recharts off the critical path) */}
      <DashboardCharts charts={o.charts} />

      {/* upcoming renewals */}
      <div className="rounded-2xl border border-white/10 light:border-slate-200 bg-white/[0.03] light:bg-slate-100/60 p-5">
        <p className="flex items-center gap-2 text-sm font-bold text-white light:text-slate-900">
          <CalendarClock className="h-4 w-4 text-amber-300 light:text-amber-700" /> Upcoming renewals
        </p>
        {o.subscriptions.upcomingRenewals.length === 0 ? (
          <p className="mt-3 text-sm text-slate-500">No upcoming renewals yet.</p>
        ) : (
          <div className="mt-3 space-y-1.5">
            {o.subscriptions.upcomingRenewals.slice(0, 8).map((r) => (
              <div key={r.id} className="flex flex-wrap items-center gap-3 rounded-lg border border-white/5 light:border-slate-200 bg-white/[0.02] light:bg-slate-50 px-3 py-2 text-sm">
                <span className="font-medium text-slate-200 light:text-slate-800">{r.planName}</span>
                <StatusChip status={r.cycle} />
                <span className="text-slate-500">ends {fmtDate(r.endDate)}</span>
                <span className={r.days <= 7 ? "ml-auto font-semibold text-amber-300 light:text-amber-700" : "ml-auto text-slate-400 light:text-slate-600"}>
                  {r.days < 0 ? `expired ${Math.abs(r.days)}d ago` : `${r.days}d left`}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      <p className="flex items-start gap-2 text-[11px] leading-relaxed text-slate-500">
        <TrendingUp className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        Financial metrics are computed only from actual subscription price snapshots of operating subscriptions. Where
        the deployment has no data yet, cards show zero — never invented statistics.
      </p>
    </div>
  )
}


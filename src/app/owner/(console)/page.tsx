"use client"
// ============ /owner — dashboard (real DB data, recharts) ============
// Every number is computed from actual records — zero, "no data yet", or real
// counts. Never fabricated (§44).
import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Legend, Pie, PieChart,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts"
import {
  Building2, CalendarClock, Database, Landmark, TrendingUp, Users, Wallet,
} from "lucide-react"
import {
  ErrorBanner, KpiCard, Loading, PageHeader, StatusChip, fmtDate, gb,
} from "@/saas/owner/ui"
import { useOwnerApi } from "@/saas/owner/client"

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

const PIE_COLORS = ["#6366f1", "#8b5cf6", "#22c55e", "#f59e0b", "#ef4444", "#64748b", "#0ea5e9", "#a855f7"]

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

      {/* charts */}
      <div className="grid gap-4 xl:grid-cols-2">
        <ChartCard title="Tenant growth (6 months)">
          <ResponsiveContainer width="100%" height={240}>
            <AreaChart data={o.charts.growth}>
              <defs>
                <linearGradient id="g1" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#6366f1" stopOpacity={0.5} />
                  <stop offset="95%" stopColor="#6366f1" stopOpacity={0} />
                </linearGradient>
                <linearGradient id="g2" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#22c55e" stopOpacity={0.4} />
                  <stop offset="95%" stopColor="#22c55e" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
              <XAxis dataKey="month" stroke="#64748b" fontSize={11} />
              <YAxis stroke="#64748b" fontSize={11} allowDecimals={false} />
              <Tooltip contentStyle={{ background: "#0f172a", border: "1px solid #1e293b", borderRadius: 12, color: "#e2e8f0" }} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              <Area type="monotone" dataKey="activeTenants" name="Active tenants" stroke="#22c55e" fill="url(#g2)" />
              <Area type="monotone" dataKey="registrations" name="Applications" stroke="#6366f1" fill="url(#g1)" />
            </AreaChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="Plan distribution">
          <ResponsiveContainer width="100%" height={240}>
            <PieChart>
              <Pie data={o.charts.planDistribution} dataKey="count" nameKey="name" innerRadius={55} outerRadius={85} paddingAngle={3}>
                {o.charts.planDistribution.map((_, i) => (
                  <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} stroke="#020617" strokeWidth={2} />
                ))}
              </Pie>
              <Tooltip contentStyle={{ background: "#0f172a", border: "1px solid #1e293b", borderRadius: 12, color: "#e2e8f0" }} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
            </PieChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="Subscription status">
          <ResponsiveContainer width="100%" height={240}>
            <BarChart data={o.charts.statusDistribution}>
              <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
              <XAxis dataKey="name" stroke="#64748b" fontSize={10} interval={0} angle={-18} textAnchor="end" height={50} />
              <YAxis stroke="#64748b" fontSize={11} allowDecimals={false} />
              <Tooltip contentStyle={{ background: "#0f172a", border: "1px solid #1e293b", borderRadius: 12, color: "#e2e8f0" }} />
              <Bar dataKey="count" name="Tenants" radius={[6, 6, 0, 0]}>
                {o.charts.statusDistribution.map((entry, i) => (
                  <Cell key={i} fill={entry.name === "ACTIVE" || entry.name === "TRIAL" ? "#22c55e" : entry.name === "LEGACY" ? "#64748b" : PIE_COLORS[i % PIE_COLORS.length]} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="Employees by plan">
          <ResponsiveContainer width="100%" height={240}>
            <BarChart data={o.charts.employeeDistribution} layout="vertical">
              <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
              <XAxis type="number" stroke="#64748b" fontSize={11} allowDecimals={false} />
              <YAxis type="category" dataKey="name" stroke="#64748b" fontSize={10} width={110} />
              <Tooltip contentStyle={{ background: "#0f172a", border: "1px solid #1e293b", borderRadius: 12, color: "#e2e8f0" }} />
              <Bar dataKey="count" name="Employees" fill="#8b5cf6" radius={[0, 6, 6, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="Feature adoption (plans that unlock each module)">
          <ResponsiveContainer width="100%" height={240}>
            <BarChart data={o.charts.featureAdoption}>
              <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
              <XAxis dataKey="name" stroke="#64748b" fontSize={10} interval={0} angle={-18} textAnchor="end" height={60} />
              <YAxis stroke="#64748b" fontSize={11} allowDecimals={false} />
              <Tooltip contentStyle={{ background: "#0f172a", border: "1px solid #1e293b", borderRadius: 12, color: "#e2e8f0" }} />
              <Bar dataKey="count" name="Subscriptions" fill="#6366f1" radius={[6, 6, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="Storage — used vs available quota">
          <ResponsiveContainer width="100%" height={240}>
            <PieChart>
              <Pie data={o.charts.storageUsage} dataKey="gb" nameKey="name" innerRadius={55} outerRadius={85} paddingAngle={3}>
                <Cell fill="#6366f1" stroke="#020617" strokeWidth={2} />
                <Cell fill="#1e293b" stroke="#020617" strokeWidth={2} />
              </Pie>
              <Tooltip contentStyle={{ background: "#0f172a", border: "1px solid #1e293b", borderRadius: 12, color: "#e2e8f0" }} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
            </PieChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>

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

function ChartCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-white/10 light:border-slate-200 bg-white/[0.03] light:bg-slate-100/60 p-5">
      <p className="mb-4 text-sm font-bold text-white light:text-slate-900">{title}</p>
      {children}
    </div>
  )
}

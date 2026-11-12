"use client"
// ============ Owner dashboard chart cards (code-split from page.tsx) ============
// PRF-13 (P2 wave, 2026-11-09) — the whole recharts bundle left the owner
// console's first-load JS: page.tsx next/dynamic-imports THIS module (ssr off,
// skeleton while loading), exactly like the HRM dashboard's chart-widgets
// split (src/hrm/dashboard/widgets.tsx). KPI cards + the renewals list render
// instantly from the page module; the charting cost is paid only when the
// charts actually hydrate.
import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Legend, Pie, PieChart,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts"

export type DashboardChartsData = {
  growth: { month: string; registrations: number; approvedTenants: number; activeTenants: number }[]
  planDistribution: { name: string; count: number }[]
  statusDistribution: { name: string; count: number }[]
  employeeDistribution: { name: string; count: number }[]
  featureAdoption: { name: string; count: number }[]
  storageUsage: { name: string; gb: number }[]
}

const PIE_COLORS = ["#6366f1", "#8b5cf6", "#22c55e", "#f59e0b", "#ef4444", "#64748b", "#0ea5e9", "#a855f7"]
const TOOLTIP_STYLE = { background: "#0f172a", border: "1px solid #1e293b", borderRadius: 12, color: "#e2e8f0" }

export function DashboardCharts({ charts }: { charts: DashboardChartsData }) {
  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <ChartCard title="Tenant growth (6 months)">
        <ResponsiveContainer width="100%" height={240}>
          <AreaChart data={charts.growth}>
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
            <Tooltip contentStyle={TOOLTIP_STYLE} />
            <Legend wrapperStyle={{ fontSize: 11 }} />
            <Area type="monotone" dataKey="activeTenants" name="Active tenants" stroke="#22c55e" fill="url(#g2)" />
            <Area type="monotone" dataKey="registrations" name="Applications" stroke="#6366f1" fill="url(#g1)" />
          </AreaChart>
        </ResponsiveContainer>
      </ChartCard>

      <ChartCard title="Plan distribution">
        <ResponsiveContainer width="100%" height={240}>
          <PieChart>
            <Pie data={charts.planDistribution} dataKey="count" nameKey="name" innerRadius={55} outerRadius={85} paddingAngle={3}>
              {charts.planDistribution.map((_, i) => (
                <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} stroke="#020617" strokeWidth={2} />
              ))}
            </Pie>
            <Tooltip contentStyle={TOOLTIP_STYLE} />
            <Legend wrapperStyle={{ fontSize: 11 }} />
          </PieChart>
        </ResponsiveContainer>
      </ChartCard>

      <ChartCard title="Subscription status">
        <ResponsiveContainer width="100%" height={240}>
          <BarChart data={charts.statusDistribution}>
            <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
            <XAxis dataKey="name" stroke="#64748b" fontSize={10} interval={0} angle={-18} textAnchor="end" height={50} />
            <YAxis stroke="#64748b" fontSize={11} allowDecimals={false} />
            <Tooltip contentStyle={TOOLTIP_STYLE} />
            <Bar dataKey="count" name="Tenants" radius={[6, 6, 0, 0]}>
              {charts.statusDistribution.map((entry, i) => (
                <Cell key={i} fill={entry.name === "ACTIVE" || entry.name === "TRIAL" ? "#22c55e" : entry.name === "LEGACY" ? "#64748b" : PIE_COLORS[i % PIE_COLORS.length]} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </ChartCard>

      <ChartCard title="Employees by plan">
        <ResponsiveContainer width="100%" height={240}>
          <BarChart data={charts.employeeDistribution} layout="vertical">
            <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
            <XAxis type="number" stroke="#64748b" fontSize={11} allowDecimals={false} />
            <YAxis type="category" dataKey="name" stroke="#64748b" fontSize={10} width={110} />
            <Tooltip contentStyle={TOOLTIP_STYLE} />
            <Bar dataKey="count" name="Employees" fill="#8b5cf6" radius={[0, 6, 6, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </ChartCard>

      <ChartCard title="Feature adoption (plans that unlock each module)">
        <ResponsiveContainer width="100%" height={240}>
          <BarChart data={charts.featureAdoption}>
            <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
            <XAxis dataKey="name" stroke="#64748b" fontSize={10} interval={0} angle={-18} textAnchor="end" height={60} />
            <YAxis stroke="#64748b" fontSize={11} allowDecimals={false} />
            <Tooltip contentStyle={TOOLTIP_STYLE} />
            <Bar dataKey="count" name="Subscriptions" fill="#6366f1" radius={[6, 6, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </ChartCard>

      <ChartCard title="Storage — used vs available quota">
        <ResponsiveContainer width="100%" height={240}>
          <PieChart>
            <Pie data={charts.storageUsage} dataKey="gb" nameKey="name" innerRadius={55} outerRadius={85} paddingAngle={3}>
              <Cell fill="#6366f1" stroke="#020617" strokeWidth={2} />
              <Cell fill="#1e293b" stroke="#020617" strokeWidth={2} />
            </Pie>
            <Tooltip contentStyle={TOOLTIP_STYLE} />
            <Legend wrapperStyle={{ fontSize: 11 }} />
          </PieChart>
        </ResponsiveContainer>
      </ChartCard>
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

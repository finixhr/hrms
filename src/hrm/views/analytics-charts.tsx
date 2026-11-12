"use client"
// ============ L-5 — lazy-loaded analytics chart sections ============
// recharts is a heavy client dependency; the whole chart body of the
// Analytics view loads on demand (next/dynamic in analytics.tsx) so the
// route's first paint ships without the charting library.
import {
  ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip, BarChart, Bar,
  LineChart, Line, CartesianGrid, Legend,
} from "recharts"
import { Badge } from "@/components/ui/badge"
import { Sparkles } from "lucide-react"
import { SectionCard, fmtMoney, RatingStars, EmptyState } from "../shared/ui-kit"

export default function AnalyticsCharts({
  workforce, attendance, payroll, performance,
}: {
  workforce: any
  attendance: any
  payroll: any
  performance: any
}) {
  return (
    <>
      <div className="grid lg:grid-cols-3 gap-4">
        <SectionCard title="Headcount Trend (12 months)">
          <ResponsiveContainer width="100%" height={220}>
            <AreaChart data={workforce.headcount}>
              <defs>
                <linearGradient id="ahc" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#059669" stopOpacity={0.3} />
                  <stop offset="95%" stopColor="#059669" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
              <XAxis dataKey="period" tick={{ fontSize: 10 }} stroke="#94a3b8" />
              <YAxis tick={{ fontSize: 10 }} stroke="#94a3b8" allowDecimals={false} />
              <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8 }} />
              <Area type="monotone" dataKey="value" stroke="#059669" strokeWidth={2} fill="url(#ahc)" name="Employees" />
            </AreaChart>
          </ResponsiveContainer>
        </SectionCard>

        <SectionCard title="Employees by Branch">
          {workforce.byBranch.length === 0 ? <EmptyState title="No branch data" /> : (
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={workforce.byBranch}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
                <XAxis dataKey="name" tick={{ fontSize: 9 }} stroke="#94a3b8" interval={0} angle={-12} textAnchor="end" height={50} />
                <YAxis tick={{ fontSize: 10 }} stroke="#94a3b8" allowDecimals={false} />
                <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8 }} />
                <Bar dataKey="value" fill="#0d9488" radius={[6, 6, 0, 0]} name="Employees" />
              </BarChart>
            </ResponsiveContainer>
          )}
        </SectionCard>

        <SectionCard title="Employees by Department">
          <div className="space-y-1.5">
            {(workforce.byDepartment || []).sort((a: any, b: any) => b.value - a.value).map((d: any) => {
              const max = Math.max(...workforce.byDepartment.map((x: any) => x.value), 1)
              return (
                <div key={d.name} className="flex items-center gap-2">
                  <span className="text-xs w-28 truncate text-slate-600 dark:text-slate-300">{d.name}</span>
                  <div className="flex-1 h-4 bg-slate-100 dark:bg-slate-800 rounded overflow-hidden">
                    <div className="h-full bg-gradient-to-r from-emerald-500 to-teal-500 rounded" style={{ width: `${Math.max(6, (d.value / max) * 100)}%` }} />
                  </div>
                  <span className="text-xs font-bold tabular-nums text-slate-700 dark:text-slate-200 w-6 text-right">{d.value}</span>
                </div>
              )
            })}
            {(workforce.byDepartment || []).length === 0 && <EmptyState title="No department data" />}
          </div>
        </SectionCard>
      </div>

      {/* ---------- attendance section ---------- */}
      <div className="grid lg:grid-cols-3 gap-4">
        <SectionCard title="Attendance Trend (6 months)" className="lg:col-span-2">
          <ResponsiveContainer width="100%" height={230}>
            <LineChart data={attendance.attTrend}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
              <XAxis dataKey="period" tick={{ fontSize: 10 }} stroke="#94a3b8" />
              <YAxis yAxisId="left" tick={{ fontSize: 10 }} stroke="#94a3b8" />
              <YAxis yAxisId="right" orientation="right" tick={{ fontSize: 10 }} stroke="#94a3b8" allowDecimals={false} />
              <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8 }} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              <Line yAxisId="left" type="monotone" dataKey="rate" name="Attendance rate %" stroke="#059669" strokeWidth={2} dot={{ r: 3 }} />
              <Line yAxisId="right" type="monotone" dataKey="absent" name="Absent days" stroke="#f43f5e" strokeWidth={1.5} dot={{ r: 2 }} />
              <Line yAxisId="right" type="monotone" dataKey="late" name="Late arrivals" stroke="#f59e0b" strokeWidth={1.5} dot={{ r: 2 }} />
            </LineChart>
          </ResponsiveContainer>
        </SectionCard>

        <SectionCard title="Overtime Hours (6 months)">
          <ResponsiveContainer width="100%" height={230}>
            <BarChart data={attendance.attTrend}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
              <XAxis dataKey="period" tick={{ fontSize: 10 }} stroke="#94a3b8" />
              <YAxis tick={{ fontSize: 10 }} stroke="#94a3b8" />
              <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8 }} />
              <Bar dataKey="otHours" fill="#f59e0b" radius={[6, 6, 0, 0]} name="OT hours" />
            </BarChart>
          </ResponsiveContainer>
        </SectionCard>
      </div>

      {/* ---------- working-hour trend (HRM-020) ---------- */}
      <SectionCard title="Working-Hour Trend (6 months)" className="lg:col-span-3">
        {(attendance.workingHourTrend || []).length === 0 ? (
          <EmptyState title="No working-hour data" hint="Average hours per working day appear once attendance is recorded." />
        ) : (
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={attendance.workingHourTrend}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
              <XAxis dataKey="period" tick={{ fontSize: 10 }} stroke="#94a3b8" />
              <YAxis tick={{ fontSize: 10 }} stroke="#94a3b8" />
              <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8 }} formatter={(v: any) => `${Number(v)}h`} />
              <Bar dataKey="avgHoursPerDay" fill="#059669" radius={[6, 6, 0, 0]} name="Avg hours/day" />
            </BarChart>
          </ResponsiveContainer>
        )}
      </SectionCard>

      {/* ---------- payroll section ---------- */}
      <div className="grid lg:grid-cols-3 gap-4">
        <SectionCard title="Payroll Trend (gross / net / AIT)" className="lg:col-span-2">
          <ResponsiveContainer width="100%" height={230}>
            <AreaChart data={payroll.trend}>
              <defs>
                <linearGradient id="agross" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#f59e0b" stopOpacity={0.25} />
                  <stop offset="95%" stopColor="#f59e0b" stopOpacity={0} />
                </linearGradient>
                <linearGradient id="anet" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#059669" stopOpacity={0.3} />
                  <stop offset="95%" stopColor="#059669" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
              <XAxis dataKey="period" tick={{ fontSize: 10 }} stroke="#94a3b8" />
              <YAxis tick={{ fontSize: 10 }} stroke="#94a3b8" />
              <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8 }} formatter={(v: any) => fmtMoney(Number(v))} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              <Area type="monotone" dataKey="gross" stroke="#f59e0b" strokeWidth={2} fill="url(#agross)" name="Gross" />
              <Area type="monotone" dataKey="net" stroke="#059669" strokeWidth={2} fill="url(#anet)" name="Net" />
              <Area type="monotone" dataKey="ait" stroke="#8b5cf6" strokeWidth={1.5} fill="#8b5cf611" name="AIT" />
            </AreaChart>
          </ResponsiveContainer>
        </SectionCard>

        <SectionCard title="Payroll Cost by Branch">
          {payroll.byBranch.length === 0 ? <EmptyState title="No paid runs yet" hint="Payroll analytics appear after the first paid run." /> : (
            <ResponsiveContainer width="100%" height={230}>
              <BarChart data={payroll.byBranch}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
                <XAxis dataKey="name" tick={{ fontSize: 9 }} stroke="#94a3b8" interval={0} angle={-12} textAnchor="end" height={50} />
                <YAxis tick={{ fontSize: 10 }} stroke="#94a3b8" />
                <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8 }} formatter={(v: any) => fmtMoney(Number(v))} />
                <Bar dataKey="value" fill="#0d9488" radius={[6, 6, 0, 0]} name="Net cost" />
              </BarChart>
            </ResponsiveContainer>
          )}
        </SectionCard>
      </div>

      {/* ---------- payroll by department (real sums) ---------- */}
      {(payroll.byDepartment || []).length > 0 && (
        <SectionCard title="Payroll Cost by Department">
          <ResponsiveContainer width="100%" height={230}>
            <BarChart data={payroll.byDepartment}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
              <XAxis dataKey="name" tick={{ fontSize: 9 }} stroke="#94a3b8" interval={0} angle={-12} textAnchor="end" height={50} />
              <YAxis tick={{ fontSize: 10 }} stroke="#94a3b8" />
              <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8 }} formatter={(v: any) => fmtMoney(Number(v))} />
              <Bar dataKey="value" fill="#6366f1" radius={[6, 6, 0, 0]} name="Net cost" />
            </BarChart>
          </ResponsiveContainer>
        </SectionCard>
      )}

      {/* ---------- performance section ---------- */}
      <div className="grid lg:grid-cols-3 gap-4">
        <SectionCard title="Top Performers" actions={<Badge variant="outline" className="text-[10px]">rating ≥ 4</Badge>}>
          <div className="space-y-1.5">
            {performance.topPerformers.map((p: any, i: number) => (
              <div key={i} className="flex items-center gap-2.5 rounded-lg bg-slate-50 dark:bg-slate-800/60 px-2.5 py-2">
                <span className={`h-6 w-6 rounded-full flex items-center justify-center text-[10px] font-bold shrink-0 ${i === 0 ? "bg-amber-100 text-amber-700" : i === 1 ? "bg-slate-200 text-slate-600" : "bg-orange-100 text-orange-700"}`}>
                  {i === 0 ? <Sparkles className="h-3 w-3" /> : i + 1}
                </span>
                <span className="text-xs font-medium text-slate-700 dark:text-slate-200 truncate flex-1">{p.name}</span>
                <RatingStars value={p.rating} />
              </div>
            ))}
            {performance.topPerformers.length === 0 && <EmptyState title="No top performers yet" hint="Reviews with overall rating ≥ 4 appear here." />}
          </div>
        </SectionCard>

        <SectionCard title="Needs Attention" actions={<Badge variant="outline" className="text-[10px]">rating ≤ 2</Badge>}>
          <div className="space-y-1.5">
            {(performance.lowPerformers || []).map((p: any, i: number) => (
              <div key={i} className="flex items-center gap-2.5 rounded-lg bg-rose-50/70 dark:bg-rose-950/30 px-2.5 py-2">
                <span className="h-6 w-6 rounded-full flex items-center justify-center text-[10px] font-bold shrink-0 bg-rose-100 text-rose-700">{i + 1}</span>
                <span className="text-xs font-medium text-slate-700 dark:text-slate-200 truncate flex-1">{p.name}</span>
                <RatingStars value={p.rating} />
              </div>
            ))}
            {(!performance.lowPerformers || performance.lowPerformers.length === 0) && <EmptyState title="No low ratings" hint="Reviews rated ≤ 2 appear here for coaching follow-up." />}
          </div>
        </SectionCard>

        <SectionCard title="Department Performance">
          <div className="space-y-2">
            {(performance.departmentPerformance || []).map((d: any, i: number) => (
              <div key={i} className="flex items-center gap-2">
                <span className="text-xs w-32 truncate text-slate-600 dark:text-slate-300">{d.name}</span>
                <div className="flex-1 h-4 bg-slate-100 dark:bg-slate-800 rounded overflow-hidden">
                  <div className="h-full rounded bg-gradient-to-r from-indigo-400 to-violet-500" style={{ width: `${Math.min(100, (d.value / 5) * 100)}%` }} />
                </div>
                <span className="text-xs font-bold tabular-nums w-8 text-right text-slate-700 dark:text-slate-200">{d.value}</span>
              </div>
            ))}
            {(!performance.departmentPerformance || performance.departmentPerformance.length === 0) && <EmptyState title="No review data" hint="Average rating per department appears after reviews are completed." />}
          </div>
        </SectionCard>
      </div>

      {/* ---------- performance trend ---------- */}
      {(performance.performanceTrend || []).length > 0 && (
        <SectionCard title="Performance Trend by Cycle">
          <ResponsiveContainer width="100%" height={220}>
            <LineChart data={performance.performanceTrend}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
              <XAxis dataKey="period" tick={{ fontSize: 10 }} stroke="#94a3b8" />
              <YAxis domain={[0, 5]} tick={{ fontSize: 10 }} stroke="#94a3b8" />
              <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8 }} />
              <Line type="monotone" dataKey="value" stroke="#f59e0b" strokeWidth={2.5} dot={{ r: 4 }} name="Avg rating" />
            </LineChart>
          </ResponsiveContainer>
        </SectionCard>
      )}

      <div className="grid lg:grid-cols-3 gap-4">
        <SectionCard title="KPI Achievement" className="lg:col-span-3">
          <div className="space-y-2">
            {performance.kpiAchievement.slice(0, 10).map((k: any, i: number) => (
              <div key={i} className="flex items-center gap-2">
                <span className="text-xs w-32 truncate text-slate-600 dark:text-slate-300">{k.name}</span>
                <div className="flex-1 h-4 bg-slate-100 dark:bg-slate-800 rounded overflow-hidden relative">
                  <div className={`h-full rounded ${k.achievementPct >= 100 ? "bg-gradient-to-r from-emerald-500 to-teal-500" : k.achievementPct >= 70 ? "bg-gradient-to-r from-amber-400 to-amber-500" : "bg-gradient-to-r from-rose-400 to-rose-500"}`}
                    style={{ width: `${Math.min(100, Math.max(4, k.achievementPct))}%` }} />
                </div>
                <span className={`text-xs font-bold tabular-nums w-12 text-right ${k.achievementPct >= 100 ? "text-emerald-600" : k.achievementPct >= 70 ? "text-amber-600" : "text-rose-600"}`}>{k.achievementPct}%</span>
              </div>
            ))}
            {performance.kpiAchievement.length === 0 && <EmptyState title="No KPI results yet" hint="Submit KPI results to see achievement bars." />}
          </div>
        </SectionCard>
      </div>
    </>
  )
}

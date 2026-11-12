"use client"
// ============ HR Analytics (spec §17.6) ============
// Workforce / attendance / payroll / performance analytics + total employee cost.
import {
  Users, TrendingUp, Timer,
  Award, ShieldCheck, Receipt, Coins, CalendarX, AlarmClock,
} from "lucide-react"
import dynamic from "next/dynamic"
// L-5 — chart sections lazy-load (analytics-charts.tsx): recharts stays out of
// the analytics route's first-paint bundle
const AnalyticsCharts = dynamic(() => import("./analytics-charts"), {
  ssr: false,
  loading: () => <div className="h-[600px] rounded-xl bg-slate-100 dark:bg-slate-800/60 animate-pulse" />,
})
import { Card, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { useHrm } from "../store"
import { useApi } from "../api"
import { PageHeader, StatCard, fmtMoney } from "../shared/ui-kit"

export default function AnalyticsView() {
  const { can } = useHrm()
  const allowed = can("analytics", "view")
  const { data, loading, error } = useApi<any>(allowed ? "analytics.all" : null)

  if (!allowed) {
    return (
      <div className="rounded-xl border bg-white dark:bg-slate-900 p-8 text-center">
        <ShieldCheck className="h-8 w-8 text-slate-300 mx-auto mb-2" />
        <p className="text-sm font-medium text-slate-600 dark:text-slate-300">You do not have permission to view HR analytics.</p>
      </div>
    )
  }
  if (loading) {
    return <div className="space-y-4">
      <div className="h-28 bg-slate-100 dark:bg-slate-800 rounded-xl animate-pulse" />
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">{Array.from({ length: 4 }).map((_, i) => <div key={i} className="h-24 bg-slate-100 dark:bg-slate-800 rounded-xl animate-pulse" />)}</div>
      <div className="h-64 bg-slate-100 dark:bg-slate-800 rounded-xl animate-pulse" />
    </div>
  }
  if (error) return <div className="rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700">{error}</div>
  if (!data) return null

  const { workforce, attendance, payroll, performance, cost } = data
  const headcountNow = workforce.headcount.length ? workforce.headcount[workforce.headcount.length - 1].value : 0

  return (
    <div className="space-y-5">
      <PageHeader
        title="HR Analytics"
        subtitle="Workforce, attendance, payroll and performance intelligence for your vendor"
      />

      {/* ---------- total employee cost hero ---------- */}
      <Card className="overflow-hidden border-emerald-200 dark:border-emerald-900">
        <div className="h-1.5 bg-gradient-to-r from-emerald-500 via-teal-500 to-amber-500" />
        <CardContent className="p-5">
          <div className="flex flex-col lg:flex-row lg:items-center gap-4">
            <div className="flex items-center gap-4 min-w-0">
              <div className="h-14 w-14 rounded-xl bg-gradient-to-br from-emerald-500 to-teal-600 text-white flex items-center justify-center shadow-sm shrink-0">
                <Coins className="h-7 w-7" />
              </div>
              <div>
                <p className="text-[11px] font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">Total Employee Cost (last paid period)</p>
                <p className="text-3xl font-bold text-slate-900 dark:text-slate-50 tabular-nums">{fmtMoney(cost.totalEmployeeCost)}</p>
                <p className="text-xs text-slate-400 mt-0.5">Salary + Overtime + Bonus + Expense Reimbursement + Employer Costs</p>
              </div>
            </div>
            <div className="flex flex-wrap gap-2 lg:ml-auto">
              <Badge className="bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300 text-[11px]">
                Employer contribution {cost.employerPct}% of gross
              </Badge>
              <Badge className="bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300 text-[11px]">
                <Receipt className="h-3 w-3 mr-1" /> Expense reimbursed {fmtMoney(cost.expenseReimbursed)}
              </Badge>
              <Badge variant="outline" className="text-[11px] bg-white dark:bg-slate-900">
                Net per employee {fmtMoney(payroll.perEmployee)}
              </Badge>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* ---------- workforce section ---------- */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard label="Headcount" value={headcountNow} sub={`${workforce.byBranch.length} branches`} icon={Users} tone="emerald" />
        <StatCard label="Turnover" value={`${workforce.turnover}%`} sub="exited / total employees" icon={TrendingUp} tone="rose" />
        <StatCard label="Avg tenure" value={`${workforce.avgTenureMonths} mo`} sub="across all employees" icon={Timer} tone="violet" />
        <StatCard label="Avg review rating" value={performance.avgRating || "—"} sub="out of 5" icon={Award} tone="amber" />
        {/* HRM-020 — attendance KPI cards */}
        <StatCard label="Absenteeism Rate" value={`${attendance.absenteeismRate}%`} sub="absent days ÷ recorded days, 6 mo" icon={CalendarX} tone="rose" />
        <StatCard label="Late Frequency" value={`${attendance.lateFrequency}/mo`} sub="late days per employee" icon={AlarmClock} tone="amber" />
        <StatCard
          label="Avg Working Hours"
          value={`${(attendance.workingHourTrend?.length ? attendance.workingHourTrend[attendance.workingHourTrend.length - 1].avgHoursPerDay : 0)}h`}
          sub="per working day, latest month" icon={Timer} tone="teal"
        />
      </div>
      {/* L-5 — the chart body lazy-loads; recharts stays out of the first paint */}
      <AnalyticsCharts workforce={workforce} attendance={attendance} payroll={payroll} performance={performance} />
    </div>
  )
}

"use client"
// ============ Performance Review & Analytics tab (2026-11 redesign) ============
// The UNIFIED experience replacing the standalone Review + Analytics systems.
// Every insight derives from approved KPI targets + approved achievements;
// pending/rejected data never moves a score. Multi-period + custom date range.
import { useEffect, useMemo, useState } from "react"
import {
  Users, CheckCircle2, TrendingUp, TrendingDown, Award, AlertTriangle, ShieldCheck, SlidersHorizontal,
  Eye, Printer, Download, History, GitCompare, MoreVertical, Settings2, Search, X,
} from "lucide-react"
import {
  ResponsiveContainer, BarChart, Bar, LineChart, Line, PieChart, Pie, Cell, XAxis, YAxis, CartesianGrid, Tooltip,
} from "recharts"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Checkbox } from "@/components/ui/checkbox"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { useHrm } from "../../store"
import { rpc, useApi, useLookup } from "../../api"
import { StatCard, StatusBadge, EmptyState, ErrorBanner, esc, fmtDate, openPrintWindow } from "../../shared/ui-kit"
import { DataTable, type Column } from "../../shared/data-table"
import { useServerPagedList, PagedControls } from "../../server-paged"
import { KpiExportButton, RatingBadge, ScoreBadge, fmtPeriod, fmtStatus, unitLabel, directionShort } from "./shared"

const CHART_COLORS = ["#059669", "#0d9488", "#d97706", "#7c3aed", "#db2777", "#65a30d", "#ea580c", "#0891b2"]

export default function KpiAnalyticsTab() {
  const { can, navigate } = useHrm()
  const { data: departments } = useLookup<any[]>("departments.list", {})
  const { data: designations } = useLookup<any[]>("designations.list", {})
  const [departmentId, setDepartmentId] = useState("")
  const [designationId, setDesignationId] = useState("")
  const [employeeId, setEmployeeId] = useState("")
  const [empQuery, setEmpQuery] = useState("")
  const [empResults, setEmpResults] = useState<any[]>([])
  const [periods, setPeriods] = useState<string[]>([])
  const [from, setFrom] = useState("")
  const [to, setTo] = useState("")
  const [rating, setRating] = useState("")
  const [showFilters, setShowFilters] = useState(false)
  const [configOpen, setConfigOpen] = useState(false)

  const filters = useMemo(() => ({
    departmentId: departmentId || undefined,
    designationId: designationId || undefined,
    employeeId: employeeId || undefined,
    ...(periods.length ? { periods } : {}),
    from: from || undefined,
    to: to || undefined,
    rating: rating || undefined,
  }), [departmentId, designationId, employeeId, periods, from, to, rating])

  const { data: summary, loading: sumLoading } = useApi<any>("kpi.analytics.summary", filters)
  const { data: charts, loading: chartsLoading } = useApi<any>("kpi.analytics.charts", filters)
  const { rows, total, page, pageSize, maxPage, loading, error, reload, setPage } = useServerPagedList<any>("kpi.analytics.employees", filters, 25)
  const [detail, setDetail] = useState<any>(null)
  const reloadAnalytics = () => { reload() }

  // employee search (debounced, server-side)
  useEffect(() => {
    if (!empQuery.trim()) { setEmpResults([]); return }
    const t = setTimeout(async () => {
      try {
        const res = await rpc<any>("employees.refList", { q: empQuery, take: 10 })
        setEmpResults(res?.refs || [])
      } catch { setEmpResults([]) }
    }, 300)
    return () => clearTimeout(t)
  }, [empQuery])

  const removePeriod = (p: string) => setPeriods((arr) => arr.filter((x) => x !== p))

  const columns: Column<any>[] = [
    {
      key: "employeeName", label: "Employee", sortValue: (r) => r.employeeName,
      render: (r) => (
        <div>
          <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">{r.employeeName}</p>
          <p className="text-[11px] text-slate-500 dark:text-slate-400">{r.employeeCode} · {r.departmentName || "—"}</p>
        </div>
      ),
    },
    { key: "departmentName", label: "Department", sortValue: (r) => r.departmentName || "", render: (r) => <span className="text-xs text-slate-600 dark:text-slate-300">{r.departmentName || "—"}</span> },
    { key: "periodLabel", label: "Period", render: (r) => <Badge variant="outline" className="text-[10px]">{r.periodDisplay}</Badge> },
    { key: "score", label: "KPI Score", align: "right", sortValue: (r) => r.score ?? -1, render: (r) => <ScoreBadge score={r.score} /> },
    { key: "achievementAvg", label: "Achievement", align: "right", sortValue: (r) => r.achievementAvg ?? -1, render: (r) => r.achievementAvg != null ? <span className="text-xs tabular-nums font-medium">{r.achievementAvg}%</span> : <span className="text-xs text-slate-400">—</span> },
    { key: "rating", label: "Performance Rating", render: (r) => <RatingBadge rating={r.rating} /> },
    { key: "status", label: "Review Status", render: (r) => <StatusBadge status={r.status} /> },
    {
      key: "trendCol", label: "Trend", align: "center", render: (r) => r.trend != null ? (
        <span className={`inline-flex items-center gap-0.5 text-xs font-semibold tabular-nums ${r.trend >= 0 ? "text-emerald-600" : "text-rose-600"}`}>
          {r.trend >= 0 ? <TrendingUp className="h-3.5 w-3.5" /> : <TrendingDown className="h-3.5 w-3.5" />}
          {Math.abs(r.trend)}%
        </span>
      ) : <span className="text-xs text-slate-400">—</span>,
    },
    {
      key: "actions", label: "", align: "right", exportable: false, render: (r) => (
        <div onClick={(e) => e.stopPropagation()}>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="icon" variant="ghost" className="h-7 w-7"><MoreVertical className="h-4 w-4" /></Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-60">
              <DropdownMenuItem onClick={() => setDetail(r)}><Eye className="h-3.5 w-3.5 mr-2" /> View Performance Details</DropdownMenuItem>
              <DropdownMenuItem onClick={() => printEmployeeReport(r)}><Printer className="h-3.5 w-3.5 mr-2" /> Print Performance Report</DropdownMenuItem>
              <DropdownMenuItem onClick={() => printEmployeeReport(r)}><Download className="h-3.5 w-3.5 mr-2" /> Print / Save as PDF</DropdownMenuItem>
              <DropdownMenuItem onClick={() => setDetail(r)}><GitCompare className="h-3.5 w-3.5 mr-2" /> Compare Performance</DropdownMenuItem>
              <DropdownMenuItem onClick={() => setDetail(r)}><History className="h-3.5 w-3.5 mr-2" /> View KPI History</DropdownMenuItem>
              <DropdownMenuItem onClick={() => navigate("performance", { tab: "achievements" })}><Award className="h-3.5 w-3.5 mr-2" /> View Approval History</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      ),
    },
  ]

  return (
    <div className="space-y-4">
      {/* filter bar */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="w-full sm:w-52">
          <Select value={departmentId || "all"} onValueChange={(v) => setDepartmentId(v === "all" ? "" : v)}>
            <SelectTrigger className="h-8 text-xs"><SelectValue placeholder="Department" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All departments</SelectItem>
              {(departments || []).map((d: any) => <SelectItem key={d.id} value={d.id}>{d.name}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div className="relative w-full sm:w-60">
          <Search className="h-3.5 w-3.5 absolute left-2.5 top-2.5 text-slate-400" />
          <Input className="h-8 text-xs pl-8" placeholder="Employee…" value={employeeId ? (empResults.find((e) => e.id === employeeId)?.fullName || "") : empQuery}
            onChange={(e) => { setEmpQuery(e.target.value); setEmployeeId("") }} />
          {employeeId && (
            <button type="button" className="absolute right-2 top-2" onClick={() => { setEmployeeId(""); setEmpQuery("") }}><X className="h-3.5 w-3.5 text-slate-400" /></button>
          )}
          {!employeeId && empResults.length > 0 && (
            <div className="absolute z-20 mt-1 w-full rounded-lg border bg-white dark:bg-slate-900 shadow-lg max-h-56 overflow-y-auto">
              {empResults.map((e) => (
                <button key={e.id} type="button" className="w-full text-left px-3 py-1.5 text-xs hover:bg-emerald-50 dark:hover:bg-emerald-950/40"
                  onClick={() => { setEmployeeId(e.id); setEmpQuery(""); setEmpResults([]) }}>
                  {e.fullName} <span className="text-slate-400">({e.code})</span>
                </button>
              ))}
            </div>
          )}
        </div>
        <Button size="sm" variant="outline" className="h-8 text-xs" onClick={() => setShowFilters((v) => !v)}>
          <SlidersHorizontal className="h-3.5 w-3.5 mr-1" /> {showFilters ? "Hide" : "More"} Filters
        </Button>
        <div className="flex-1" />
        {can("performance", "export") && <KpiExportButton action="kpi.analytics.export" filters={filters} label="Report" />}
        {can("settings", "edit") && (
          <Button size="sm" variant="outline" className="h-8 text-xs" onClick={() => setConfigOpen(true)}>
            <Settings2 className="h-3.5 w-3.5 mr-1" /> Rating Configuration
          </Button>
        )}
      </div>

      {showFilters && (
        <div className="rounded-xl border p-3 grid grid-cols-1 sm:grid-cols-4 gap-3">
          <div className="space-y-1.5">
            <Label className="text-xs">Designation</Label>
            <Select value={designationId || "all"} onValueChange={(v) => setDesignationId(v === "all" ? "" : v)}>
              <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All designations</SelectItem>
                {(designations || []).map((d: any) => <SelectItem key={d.id} value={d.id}>{d.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Date range (custom)</Label>
            <div className="flex items-center gap-1.5">
              <Input type="date" className="h-8 text-xs" value={from} onChange={(e) => setFrom(e.target.value)} />
              <span className="text-slate-400 text-xs">→</span>
              <Input type="date" className="h-8 text-xs" value={to} onChange={(e) => setTo(e.target.value)} />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Performance rating</Label>
            <Select value={rating || "all"} onValueChange={(v) => setRating(v === "all" ? "" : v)}>
              <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All ratings</SelectItem>
                {((summary?.periods || charts?.ratingBands || []) as any) && (charts?.ratingBands || []).map((b: any) => (
                  <SelectItem key={b.label} value={b.label}>{b.label} (≥ {b.min})</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Selected periods {periods.length > 0 && `(${periods.length})`}</Label>
            <div className="flex flex-wrap gap-1">
              {periods.map((p) => (
                <Badge key={p} variant="outline" className="text-[10px] gap-1">
                  {fmtPeriod(p)}
                  <button type="button" onClick={() => removePeriod(p)}><X className="h-2.5 w-2.5" /></button>
                </Badge>
              ))}
              {!periods.length && <span className="text-[11px] text-slate-400">All periods (use the trend chart legend to add)</span>}
            </div>
          </div>
        </div>
      )}

      {/* summary cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-3">
        <StatCard label="Total Employees" value={sumLoading ? "…" : summary?.totalEmployees ?? 0} icon={Users} tone="slate" />
        <StatCard label="Approved Targets" value={sumLoading ? "…" : summary?.withApprovedTargets ?? 0} icon={CheckCircle2} tone="teal" />
        <StatCard label="Approved Achievements" value={sumLoading ? "…" : summary?.withApprovedAchievements ?? 0} icon={Award} tone="emerald" />
        <StatCard label="Avg Performance Score" value={sumLoading ? "…" : summary?.avgScore ?? "—"} icon={TrendingUp} tone="sky" />
        <StatCard label="High Performers" value={sumLoading ? "…" : summary?.highPerformers ?? 0} icon={Award} tone="emerald" />
        <StatCard label="Needs Improvement" value={sumLoading ? "…" : summary?.needImprovement ?? 0} icon={AlertTriangle} tone="amber" />
        <StatCard label="Pending Reviews" value={sumLoading ? "…" : (summary?.pendingAchievementReviews ?? 0) + (summary?.pendingTargets ?? 0)} icon={ShieldCheck} tone="rose" />
      </div>

      {/* charts */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <ChartCard title="Department-wise Performance" loading={chartsLoading} empty={!((charts?.departmentPerformance || []).length)}>
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={(charts?.departmentPerformance || []).slice(0, 10)} margin={{ top: 5, right: 8, left: -18, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
              <XAxis dataKey="name" tick={{ fontSize: 10 }} stroke="#94a3b8" interval={0} angle={-18} textAnchor="end" height={48} />
              <YAxis tick={{ fontSize: 10 }} stroke="#94a3b8" domain={[0, 100]} />
              <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8 }} />
              <Bar dataKey="avgScore" name="Avg score" fill="#059669" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="Performance Rating Distribution" loading={chartsLoading} empty={!((charts?.ratingDistribution || []).some((r: any) => r.count > 0))}>
          <div className="flex items-center gap-3">
            <ResponsiveContainer width="55%" height={200}>
              <PieChart>
                <Pie data={(charts?.ratingDistribution || []).filter((r: any) => r.count > 0)} dataKey="count" nameKey="label" innerRadius={45} outerRadius={80} paddingAngle={2}>
                  {(charts?.ratingDistribution || []).filter((r: any) => r.count > 0).map((_: any, i: number) => (
                    <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />
                  ))}
                </Pie>
                <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8 }} />
              </PieChart>
            </ResponsiveContainer>
            <div className="flex-1 space-y-1">
              {(charts?.ratingDistribution || []).map((r: any, i: number) => (
                <div key={r.label} className="flex items-center justify-between text-xs">
                  <span className="flex items-center gap-1.5 text-slate-600 dark:text-slate-300">
                    <span className="h-2.5 w-2.5 rounded-full" style={{ background: CHART_COLORS[i % CHART_COLORS.length] }} />
                    {r.label}
                  </span>
                  <span className="font-semibold tabular-nums">{r.count}</span>
                </div>
              ))}
            </div>
          </div>
        </ChartCard>

        <ChartCard title="Period-over-Period Performance Trend" loading={chartsLoading} empty={!((charts?.periodTrend || []).length)}
          actions={(charts?.periodTrend || []).length > 1 ? (
            <div className="flex flex-wrap gap-1">
              {(charts?.periodTrend || []).slice(-6).map((p: any) => (
                <button key={p.period} type="button"
                  className={`rounded-full border px-2 py-0.5 text-[10px] ${periods.includes(p.period) ? "bg-emerald-100 border-emerald-300 text-emerald-700" : "border-slate-200 dark:border-slate-700 text-slate-500 hover:border-emerald-300"}`}
                  onClick={() => setPeriods((arr) => arr.includes(p.period) ? arr.filter((x) => x !== p.period) : [...arr, p.period])}>
                  {p.display}
                </button>
              ))}
            </div>
          ) : undefined}>
          <ResponsiveContainer width="100%" height={200}>
            <LineChart data={charts?.periodTrend || []} margin={{ top: 5, right: 8, left: -18, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
              <XAxis dataKey="display" tick={{ fontSize: 10 }} stroke="#94a3b8" />
              <YAxis tick={{ fontSize: 10 }} stroke="#94a3b8" domain={[0, 100]} />
              <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8 }} />
              <Line type="monotone" dataKey="avgScore" name="Avg score" stroke="#059669" strokeWidth={2.5} dot={{ r: 4 }} />
            </LineChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="KPI Indicator-wise Achievement" loading={chartsLoading} empty={!((charts?.indicatorAchievement || []).length)}>
          <div className="max-h-52 overflow-y-auto space-y-2 pr-1">
            {(charts?.indicatorAchievement || []).slice(0, 8).map((i: any, idx: number) => (
              <div key={i.name} className="space-y-0.5">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-slate-600 dark:text-slate-300 truncate">{i.name}</span>
                  <span className="font-semibold tabular-nums text-slate-700 dark:text-slate-200">{i.avgAchievementPct ?? "—"}%</span>
                </div>
                <div className="h-2 rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden">
                  <div className="h-full rounded-full" style={{ width: `${Math.min(100, i.avgAchievementPct || 0)}%`, background: CHART_COLORS[idx % CHART_COLORS.length] }} />
                </div>
                <p className="text-[10px] text-slate-400">target {i.avgTarget ?? "—"} · actual {i.avgActual ?? "—"} {unitLabel(i.unit)} · {i.count} record(s)</p>
              </div>
            ))}
          </div>
        </ChartCard>
      </div>

      {/* top / bottom performers */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <PerformerList title="Top Performers" icon={<Award className="h-3.5 w-3.5 text-amber-500" />} rows={charts?.topPerformers || []} onSelect={(r) => setDetail({ employeeId: r.employeeId, employeeName: r.employeeName, employeeCode: "" })} />
        <PerformerList title="Requiring Improvement" icon={<AlertTriangle className="h-3.5 w-3.5 text-rose-500" />} rows={charts?.bottomPerformers || []} onSelect={(r) => setDetail({ employeeId: r.employeeId, employeeName: r.employeeName, employeeCode: "" })} />
      </div>

      {/* employee-wise review table */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-200">Employee-wise Performance Review</h3>
          <span className="text-xs text-slate-400">{total} employee-period row(s) · scores from approved achievements only</span>
        </div>
        <DataTable columns={columns} rows={rows} loading={loading} error={error} dense
          onRowClick={(r) => setDetail(r)}
          emptyTitle="No performance data" emptyHint="Assign KPI targets, approve them, then record + approve achievements." />
        <PagedControls page={page} maxPage={maxPage} total={total} pageSize={pageSize} onPage={setPage} loading={loading} />
      </div>

      <EmployeeDetailDrawer row={detail} onOpenChange={(v) => { if (!v) setDetail(null) }} onPrint={printEmployeeReport} />
      <RatingConfigDialog open={configOpen} onOpenChange={(v) => { setConfigOpen(v); if (!v) reloadAnalytics() }} />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Chart card wrapper
// ---------------------------------------------------------------------------

function ChartCard({ title, loading, empty, children, actions }: {
  title: string; loading?: boolean; empty?: boolean; children: React.ReactNode; actions?: React.ReactNode
}) {
  return (
    <div className="rounded-xl border bg-white dark:bg-slate-900 p-4 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">{title}</h3>
        {actions}
      </div>
      {loading ? <div className="h-52 animate-pulse rounded-lg bg-slate-100 dark:bg-slate-800" /> : empty ? (
        <EmptyState icon={TrendingUp} title="No data for the selected filters" hint="Approved KPI targets and approved achievements feed these analytics." />
      ) : children}
    </div>
  )
}

function PerformerList({ title, icon, rows, onSelect }: {
  title: string; icon: React.ReactNode; rows: any[]; onSelect: (r: any) => void
}) {
  return (
    <div className="rounded-xl border bg-white dark:bg-slate-900 p-4 space-y-2">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400 flex items-center gap-1.5">{icon} {title}</h3>
      {rows.length === 0 ? <EmptyState icon={Users} title="No scored employees yet" /> : (
        <div className="space-y-1.5">
          {rows.map((r, i) => (
            <button key={`${r.employeeId}-${r.period}`} type="button" className="w-full text-left flex items-center gap-3 rounded-lg border border-slate-100 dark:border-slate-800 px-3 py-2 hover:border-emerald-300 dark:hover:border-emerald-800 hover:bg-emerald-50/30 dark:hover:bg-emerald-950/20 transition"
              onClick={() => onSelect(r)}>
              <span className={`h-6 w-6 shrink-0 rounded-full flex items-center justify-center text-[10px] font-bold ${i === 0 ? "bg-amber-100 text-amber-700" : i === 1 ? "bg-slate-200 text-slate-600" : i === 2 ? "bg-orange-100 text-orange-700" : "bg-slate-100 text-slate-500"}`}>{i + 1}</span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-slate-800 dark:text-slate-100 truncate">{r.employeeName}</p>
                <p className="text-[10px] text-slate-500 truncate">{r.departmentName || "—"} · {r.period}</p>
              </div>
              <div className="text-right shrink-0">
                <ScoreBadge score={r.score} />
                <p className="text-[10px] text-slate-400">{r.rating || ""}</p>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Employee performance detail drawer (multi-period deep dive)
// ---------------------------------------------------------------------------

function EmployeeDetailDrawer({ row, onOpenChange, onPrint }: {
  row: any; onOpenChange: (v: boolean) => void; onPrint: (r: any) => void
}) {
  const [data, setData] = useState<any>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!row?.employeeId) { setData(null); return }
    let cancelled = false
    setLoading(true)
    setError(null)
    ;(async () => {
      try {
        const res = await rpc<any>("kpi.analytics.employeeDetail", { employeeId: row.employeeId })
        if (!cancelled) setData(res)
      } catch (e: any) {
        if (!cancelled) setError(e.message)
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
     
  }, [row?.employeeId])

  if (!row) return null
  const trend = data?.trend || []
  return (
    <Dialog open={!!row} onOpenChange={(v) => { if (!v) onOpenChange(false) }}>
      <DialogContent className="sm:max-w-4xl max-h-[92vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-base">Performance Details — {data?.employee?.fullName || row.employeeName || "…"}</DialogTitle>
          {data?.employee && (
            <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
              <span>{data.employee.code}</span>
              <span>· {data.employee.departmentName || "—"}</span>
              <span>· {data.employee.designationName || "—"}</span>
              {data.avgScore != null && <><span>· avg score</span><ScoreBadge score={data.avgScore} /></>}
            </div>
          )}
        </DialogHeader>
        {loading ? <p className="text-xs text-slate-500 py-6 text-center">Loading performance history…</p> : error ? <ErrorBanner message={error} /> : data && (
          <>
            {trend.length > 1 && (
              <div className="rounded-xl border p-3">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400 mb-1">Performance Trend</p>
                <ResponsiveContainer width="100%" height={140}>
                  <LineChart data={trend} margin={{ top: 5, right: 8, left: -18, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
                    <XAxis dataKey="display" tick={{ fontSize: 10 }} stroke="#94a3b8" />
                    <YAxis tick={{ fontSize: 10 }} stroke="#94a3b8" domain={[0, 100]} />
                    <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8 }} />
                    <Line type="monotone" dataKey="score" name="KPI score" stroke="#059669" strokeWidth={2.5} dot={{ r: 4 }} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            )}
            {(data.periods || []).map((p: any) => (
              <div key={p.assignmentId} className="rounded-xl border p-3 space-y-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <Badge variant="outline" className="text-[10px]">{p.periodDisplay}</Badge>
                    <StatusBadge status={p.targetStatus} />
                    {p.dueDate && <span className="text-[11px] text-slate-400">due {fmtDate(p.dueDate)}</span>}
                  </div>
                  <div className="flex items-center gap-2">
                    <ScoreBadge score={p.score} />
                    <RatingBadge rating={p.rating} />
                  </div>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-[10px] uppercase tracking-wide text-slate-400 border-b">
                        <th className="text-left font-semibold py-1.5">Indicator</th>
                        <th className="text-left font-semibold py-1.5 w-16">Type</th>
                        <th className="text-left font-semibold py-1.5">Direction</th>
                        <th className="text-right font-semibold py-1.5">Target</th>
                        <th className="text-right font-semibold py-1.5">Actual</th>
                        <th className="text-right font-semibold py-1.5">Ach. %</th>
                        <th className="text-right font-semibold py-1.5">Weight</th>
                        <th className="text-left font-semibold py-1.5">Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(p.indicators || []).map((i: any) => (
                        <tr key={i.indicatorRowId}>
                          <td className="py-1.5 font-medium text-slate-700 dark:text-slate-200">{i.name}</td>
                          <td className="py-1.5 text-[9px] text-slate-400">{i.source === "BUILTIN" ? "built-in" : "custom"}</td>
                          <td className="py-1.5 text-slate-500">{directionShort(i.direction)}</td>
                          <td className="py-1.5 text-right tabular-nums">{i.targetValue ?? "—"}{unitLabel(i.unit, i.unitLabel)}</td>
                          <td className="py-1.5 text-right tabular-nums font-semibold">{i.actualValue ?? "—"}</td>
                          <td className={`py-1.5 text-right tabular-nums ${i.achievementPct != null ? (i.achievementPct >= 100 ? "text-emerald-600" : i.achievementPct >= 70 ? "text-teal-600" : i.achievementPct >= 50 ? "text-amber-600" : "text-rose-600") : "text-slate-400"}`}>
                            {i.achievementPct != null ? `${i.achievementPct}%` : "—"}
                          </td>
                          <td className="py-1.5 text-right tabular-nums text-slate-500">{i.weight}%</td>
                          <td className="py-1.5"><StatusBadge status={i.status} /></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ))}
            {!(data.periods || []).length && <EmptyState icon={TrendingUp} title="No KPI periods for this employee" hint="Assign a department KPI target first." />}
          </>
        )}
        <DialogFooter className="gap-2 sm:justify-between">
          <p className="text-[11px] text-slate-400">Scores are computed from APPROVED achievements only · {data?.bestPeriod ? `best period: ${fmtPeriod(data.bestPeriod)}` : ""}</p>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)}>Close</Button>
            <Button onClick={() => onPrint({ ...(row || {}), ...(data?.employee || {}) })}>
              <Printer className="h-3.5 w-3.5 mr-1" /> Print Report
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------
// Printable employee performance report (print → Save as PDF in the dialog)
// ---------------------------------------------------------------------------

async function printEmployeeReport(row: any) {
  let data: any = null
  try {
    data = await rpc<any>("kpi.analytics.employeeDetail", { employeeId: row.employeeId })
  } catch {
    /* fall back to the row alone */
  }
  const emp = data?.employee || row
  const periods = data?.periods || []
  const trendRows = (data?.trend || []).map((t: any) => `<tr><td>${esc(t.display)}</td><td class="r">${t.score ?? "—"}</td><td>${esc(t.rating || "—")}</td></tr>`).join("")
  const periodTables = periods.map((p: any) => `
    <h3>${esc(p.periodDisplay)} — score ${p.score ?? "—"} · ${esc(p.rating?.label || "unrated")}</h3>
    <table>
      <thead><tr><th>Indicator</th><th class="r">Target</th><th class="r">Actual</th><th class="r">Ach. %</th><th class="r">Weight</th><th>Status</th></tr></thead>
      <tbody>
        ${(p.indicators || []).map((i: any) => `<tr>
          <td>${esc(i.name)}${i.source === "BUILTIN" ? ' <span class="tag">built-in</span>' : ""}</td>
          <td class="r">${i.targetValue ?? "—"} ${esc(unitLabel(i.unit, i.unitLabel))}</td>
          <td class="r"><b>${i.actualValue ?? "—"}</b></td>
          <td class="r">${i.achievementPct != null ? `${i.achievementPct}%` : "—"}</td>
          <td class="r">${i.weight}%</td>
          <td>${esc(fmtStatus(i.status))}</td>
        </tr>`).join("")}
      </tbody>
    </table>`).join("")
  const html = `
  <html><head><title>Performance Report — ${esc(emp.fullName || "")}</title>
  <style>
    body { font-family: ui-sans-serif, system-ui, sans-serif; color: #1e293b; margin: 24px; font-size: 12px; }
    h1 { font-size: 18px; margin: 0 0 2px; } h2 { font-size: 13px; margin: 18px 0 6px; color: #059669; }
    h3 { font-size: 12px; margin: 14px 0 4px; }
    .sub { color: #64748b; font-size: 11px; margin-bottom: 14px; }
    table { width: 100%; border-collapse: collapse; margin-bottom: 8px; }
    th, td { border: 1px solid #e2e8f0; padding: 4px 8px; text-align: left; }
    th { background: #f8fafc; font-size: 10px; text-transform: uppercase; letter-spacing: .04em; color: #64748b; }
    .r { text-align: right; } .tag { background: #f1f5f9; border-radius: 4px; padding: 0 4px; font-size: 9px; }
    .kpi-row { display: flex; gap: 12px; margin: 10px 0; }
    .kpi { border: 1px solid #e2e8f0; border-radius: 8px; padding: 8px 14px; text-align: center; }
    .kpi b { display: block; font-size: 16px; }
    .kpi span { font-size: 9px; text-transform: uppercase; color: #94a3b8; }
    @media print { @page { margin: 14mm; } }
  </style></head><body>
    <h1>Employee Performance Report</h1>
    <p class="sub">${esc(emp.fullName || "")} (${esc(emp.code || "")}) · ${esc(emp.departmentName || "—")} · ${esc(emp.designationName || "—")} · generated ${new Date().toLocaleString()}</p>
    <div class="kpi-row">
      <div class="kpi"><span>Average score</span><b>${data?.avgScore ?? "—"}</b></div>
      <div class="kpi"><span>Periods</span><b>${periods.length}</b></div>
      <div class="kpi"><span>Best period</span><b>${data?.bestPeriod ? esc(fmtPeriod(data.bestPeriod)) : "—"}</b></div>
    </div>
    ${trendRows ? `<h2>Score history</h2><table><thead><tr><th>Period</th><th class="r">Score</th><th>Rating</th></tr></thead><tbody>${trendRows}</tbody></table>` : ""}
    <h2>Period detail (approved achievements only)</h2>
    ${periodTables || "<p>No KPI periods recorded.</p>"}
  </body></html>`
  openPrintWindow(html, { print: true })
}

// ---------------------------------------------------------------------------
// Rating configuration dialog (Settings → performance group)
// ---------------------------------------------------------------------------

function RatingConfigDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const toast = useHrm((s) => s.toast)
  const [ratings, setRatings] = useState<{ min: number | string; label: string }[]>([])
  // string states: these are controlled text inputs; the save handler coerces
  // with Number() (settings.patch receives numbers either way)
  const [maxPct, setMaxPct] = useState<string>("100")
  const [tolerance, setTolerance] = useState<string>("5")
  const [missingZero, setMissingZero] = useState(false)
  const [selfApproval, setSelfApproval] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    ;(async () => {
      try {
        const s = await rpc<any>("settings.get", {})
        const perf = s?.performance || {}
        setRatings((perf.ratings || []).map((r: any) => ({ min: r.min, label: r.label })))
        setMaxPct(String(perf.achievementMaxPct ?? 100))
        setTolerance(String(perf.exactTolerancePct ?? 5))
        setMissingZero(!!perf.missingDataCountsZero)
        setSelfApproval(!!perf.selfApprovalAllowed)
        setError(null)
      } catch (e: any) {
        setError(e.message)
      }
    })()
  }, [open])

  const save = async () => {
    setBusy(true)
    setError(null)
    try {
      const clean = ratings
        .filter((r) => String(r.label).trim() && r.min !== "")
        .map((r) => ({ min: Number(r.min), label: String(r.label).trim() }))
        .sort((a, b) => b.min - a.min)
      if (clean.length < 2) throw new Error("Define at least two rating bands")
      await rpc("settings.patch", {
        group: "performance",
        values: {
          ratings: clean,
          achievementMaxPct: Number(maxPct) || 100,
          exactTolerancePct: Number(tolerance) || 0,
          missingDataCountsZero: missingZero,
          selfApprovalAllowed: selfApproval,
        },
      })
      toast("Performance rating configuration saved")
      onOpenChange(false)
    } catch (e: any) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!busy) onOpenChange(v) }}>
      <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-base">Performance Rating Configuration</DialogTitle>
          <p className="text-xs text-slate-500">Rating bands and scoring rules apply tenant-wide (company-overridable). Feature code reads these bands — they are never hardcoded.</p>
        </DialogHeader>
        <div className="space-y-3">
          <div className="rounded-xl border overflow-hidden">
            <div className="grid grid-cols-12 gap-2 px-3 py-1.5 bg-slate-50 dark:bg-slate-800/60 text-[10px] font-semibold uppercase tracking-wide text-slate-400">
              <span className="col-span-4">Minimum score</span>
              <span className="col-span-8">Rating label</span>
            </div>
            {ratings.map((r, idx) => (
              <div key={idx} className="grid grid-cols-12 gap-2 px-3 py-1.5 items-center border-t border-slate-100 dark:border-slate-800">
                <Input className="col-span-4 h-8 text-xs tabular-nums" type="number" value={r.min}
                  onChange={(e) => setRatings((arr) => arr.map((x, i) => (i === idx ? { ...x, min: e.target.value } : x)))} />
                <Input className="col-span-7 h-8 text-xs" value={r.label}
                  onChange={(e) => setRatings((arr) => arr.map((x, i) => (i === idx ? { ...x, label: e.target.value } : x)))} />
                <Button size="icon" variant="ghost" className="col-span-1 h-7 w-7 text-slate-400 hover:text-rose-600"
                  disabled={ratings.length <= 2}
                  onClick={() => setRatings((arr) => arr.filter((_, i) => i !== idx))}>×</Button>
              </div>
            ))}
            <div className="px-3 py-2 border-t border-slate-100 dark:border-slate-800">
              <Button size="sm" variant="outline" className="h-7 text-xs"
                onClick={() => setRatings((arr) => [...arr, { min: "", label: "" }])}>+ Add band</Button>
            </div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs">Over-achievement cap (%)</Label>
              <Input className="h-8 text-xs tabular-nums" type="number" min={100} value={maxPct} onChange={(e) => setMaxPct(e.target.value)} />
              <p className="text-[10px] text-slate-400">Achievement % is clamped to this maximum (default 100 — no over-achievement inflation).</p>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Exact-target tolerance (%)</Label>
              <Input className="h-8 text-xs tabular-nums" type="number" min={0} max={100} value={tolerance} onChange={(e) => setTolerance(e.target.value)} />
              <p className="text-[10px] text-slate-400">Exact-target indicators within ± this % of the target score 100.</p>
            </div>
          </div>
          <div className="space-y-2">
            <label className="flex items-center gap-2 text-xs text-slate-600 dark:text-slate-300">
              <Checkbox checked={missingZero} onCheckedChange={(v) => setMissingZero(!!v)} />
              Indicators without approved achievements count as 0 (unchecked: they are excluded from the weighted average)
            </label>
            <label className="flex items-center gap-2 text-xs text-slate-600 dark:text-slate-300">
              <Checkbox checked={selfApproval} onCheckedChange={(v) => setSelfApproval(!!v)} />
              Allow the creator to approve their own submission (SoD lift — off by default)
            </label>
          </div>
        </div>
        {error && <ErrorBanner message={error} />}
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
          <Button onClick={save} disabled={busy}>{busy ? "Saving…" : "Save Configuration"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

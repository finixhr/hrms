"use client"
// ============ Attendance Overview report (2026-10 round §39–§41) ============
// Server-authoritative aggregates (reports.attendanceOverview): KPI cards,
// attendance + suspicious trends, branch/department rates, method
// distribution donut, GPS/geo-fence compliance — every chart has title,
// period, filters, totals, legend, tooltip and an empty state (§40).
import { useState } from "react"
import {
  ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip, BarChart, Bar,
  LineChart, Line, CartesianGrid, Legend, PieChart, Pie, Cell,
} from "recharts"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { useApi, rpc } from "../api"
import { useHrm } from "../store"
import { SectionCard, EmptyState, fmtDate } from "../shared/ui-kit"

const DONUT_COLORS = ["#059669", "#0d9488", "#2563eb", "#d97706", "#dc2626", "#9333ea", "#64748b", "#e11d48"]

function todayIso(offsetDays = 0): string {
  const d = new Date(Date.now() + offsetDays * 86400000)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
}

export default function AttendanceOverviewReport() {
  const { toast } = useHrm()
  const [from, setFrom] = useState(todayIso(-29))
  const [to, setTo] = useState(todayIso())
  const [applied, setApplied] = useState({ from: todayIso(-29), to: todayIso() })
  const [busy, setBusy] = useState(false)

  const { data, loading, error } = useApi<any>("reports.attendanceOverview", { from: applied.from, to: applied.to })

  const exportCsv = async () => {
    setBusy(true)
    try {
      const r = await rpc<{ csv: string }>("reports.attendanceOverviewCsv", { from: applied.from, to: applied.to })
      const blob = new Blob(["\uFEFF" + r.csv], { type: "text/csv;charset=utf-8" })
      const url = URL.createObjectURL(blob)
      const a = document.createElement("a")
      a.href = url
      a.download = `attendance-overview-${applied.from}-to-${applied.to}.csv`
      a.click()
      URL.revokeObjectURL(url)
    } catch (e: any) {
      toast(String(e?.message || e), "err")
    } finally {
      setBusy(false)
    }
  }

  const k = data?.kpis
  const kpiCards: { label: string; value: string | number; tone?: string }[] = k ? [
    { label: "Total Employees", value: k.totalEmployees },
    { label: "Present", value: k.present, tone: "text-emerald-600" },
    { label: "Absent", value: k.absent, tone: "text-rose-600" },
    { label: "Late", value: k.late, tone: "text-amber-600" },
    { label: "Early Leave", value: k.earlyLeave, tone: "text-orange-600" },
    { label: "On Leave", value: k.onLeave, tone: "text-teal-600" },
    { label: "Geo-Fence Check-Ins", value: k.geofenceAttendance, tone: "text-teal-600" },
    { label: "Selfie Check-Ins", value: k.selfieAttendance, tone: "text-blue-600" },
    { label: "Device Punches", value: k.deviceAttendance, tone: "text-indigo-600" },
    { label: "Periodic Checks", value: k.multipleChecks, tone: "text-cyan-600" },
    { label: "GPS Violations", value: k.gpsViolations, tone: "text-rose-600" },
    { label: "Suspicious Events", value: k.suspiciousEvents, tone: "text-purple-600" },
  ] : []

  return (
    <div className="space-y-4">
      {/* period filter */}
      <SectionCard
        title="Attendance Overview — period"
        actions={<span className="text-xs text-slate-400">{fmtDate(applied.from)} → {fmtDate(applied.to)} · attendance rate {k ? `${Math.round(k.attendanceRate)}%` : "—"}</span>}
      >
        <div className="flex flex-wrap items-end gap-2">
          <div>
            <Label className="text-xs">From</Label>
            <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="h-9 w-40 text-xs" />
          </div>
          <div>
            <Label className="text-xs">To</Label>
            <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="h-9 w-40 text-xs" />
          </div>
          <Button size="sm" className="h-9" onClick={() => setApplied({ from, to })}>Apply</Button>
          <div className="flex gap-1.5 ml-auto">
            <Button size="sm" variant="outline" className="h-8 text-xs" onClick={() => { const f = todayIso(-6); setFrom(f); setTo(todayIso()); setApplied({ from: f, to: todayIso() }) }}>Last 7 days</Button>
            <Button size="sm" variant="outline" className="h-8 text-xs" onClick={() => { const f = todayIso(-29); setFrom(f); setTo(todayIso()); setApplied({ from: f, to: todayIso() }) }}>Last 30 days</Button>
            <Button size="sm" variant="outline" className="h-8 text-xs" disabled={busy} onClick={exportCsv}>Export CSV</Button>
          </div>
        </div>
      </SectionCard>

      {loading ? (
        <div className="grid grid-cols-2 sm:grid-cols-4 xl:grid-cols-6 gap-3">
          {Array.from({ length: 12 }).map((_, i) => <div key={i} className="h-16 rounded-xl bg-slate-100 dark:bg-slate-800 animate-pulse" />)}
        </div>
      ) : error ? (
        <SectionCard title="Attendance Overview"><EmptyState title="Could not load the overview" hint={String(error)} /></SectionCard>
      ) : !data?.kpis ? (
        <SectionCard title="Attendance Overview"><EmptyState title="No data for this period" hint="Pick a different date range." /></SectionCard>
      ) : (
        <>
          {/* KPI cards (§39) */}
          <div className="grid grid-cols-2 sm:grid-cols-4 xl:grid-cols-6 gap-3">
            {kpiCards.map((c) => (
              <div key={c.label} className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-3 py-2.5">
                <p className="text-[11px] uppercase tracking-wide text-slate-400 truncate">{c.label}</p>
                <p className={`text-xl font-bold tabular-nums ${c.tone ?? ""}`}>{c.value}</p>
              </div>
            ))}
          </div>

          {/* trend (§40) */}
          <div className="grid lg:grid-cols-2 gap-4">
            <SectionCard title={<span>Attendance Trend <span className="text-slate-400 font-normal">· present vs absent vs late</span></span>}>
              {data.trend?.length ? (
                <ResponsiveContainer width="100%" height={240}>
                  <AreaChart data={data.trend}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
                    <XAxis dataKey="date" tick={{ fontSize: 9 }} stroke="#94a3b8" />
                    <YAxis tick={{ fontSize: 10 }} stroke="#94a3b8" allowDecimals={false} />
                    <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8 }} />
                    <Legend wrapperStyle={{ fontSize: 11 }} />
                    <Area type="monotone" dataKey="present" stackId="1" stroke="#059669" fill="#059669" fillOpacity={0.35} name="Present" />
                    <Area type="monotone" dataKey="late" stackId="1" stroke="#d97706" fill="#d97706" fillOpacity={0.3} name="Late" />
                    <Area type="monotone" dataKey="absent" stackId="1" stroke="#dc2626" fill="#dc2626" fillOpacity={0.25} name="Absent" />
                  </AreaChart>
                </ResponsiveContainer>
              ) : <EmptyState title="No attendance records in this period" />}
            </SectionCard>

            <SectionCard title={<span>Suspicious Attendance Trend <span className="text-slate-400 font-normal">· flagged events per day</span></span>}>
              {data.trend?.some((t: any) => t.suspicious > 0) ? (
                <ResponsiveContainer width="100%" height={240}>
                  <LineChart data={data.trend}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
                    <XAxis dataKey="date" tick={{ fontSize: 9 }} stroke="#94a3b8" />
                    <YAxis tick={{ fontSize: 10 }} stroke="#94a3b8" allowDecimals={false} />
                    <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8 }} />
                    <Legend wrapperStyle={{ fontSize: 11 }} />
                    <Line type="monotone" dataKey="suspicious" stroke="#9333ea" strokeWidth={2} name="Suspicious events" dot={false} />
                  </LineChart>
                </ResponsiveContainer>
              ) : <EmptyState title="No suspicious events recorded" hint="Geo-fence, selfie and integrity-flagged events appear here when they occur." />}
            </SectionCard>
          </div>

          {/* branch + department rates (§41) */}
          <div className="grid lg:grid-cols-2 gap-4">
            <SectionCard title={<span>Branch Attendance Rate <span className="text-slate-400 font-normal">· {data.branchStats?.length ?? 0} branches</span></span>}>
              {data.branchStats?.length ? (
                <ResponsiveContainer width="100%" height={Math.max(220, data.branchStats.length * 34)}>
                  <BarChart data={data.branchStats} layout="vertical">
                    <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" horizontal={false} />
                    <XAxis type="number" domain={[0, 100]} tick={{ fontSize: 10 }} stroke="#94a3b8" unit="%" />
                    <YAxis type="category" dataKey="name" tick={{ fontSize: 10 }} stroke="#94a3b8" width={130} />
                    <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8 }} />
                    <Bar dataKey="rate" fill="#059669" name="Attendance rate %" radius={[0, 4, 4, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              ) : <EmptyState title="No branch data" />}
            </SectionCard>

            <SectionCard title={<span>Department Attendance Rate <span className="text-slate-400 font-normal">· top {data.departmentStats?.length ?? 0}</span></span>}>
              {data.departmentStats?.length ? (
                <ResponsiveContainer width="100%" height={Math.max(220, (data.departmentStats?.length ?? 0) * 34)}>
                  <BarChart data={data.departmentStats} layout="vertical">
                    <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" horizontal={false} />
                    <XAxis type="number" domain={[0, 100]} tick={{ fontSize: 10 }} stroke="#94a3b8" unit="%" />
                    <YAxis type="category" dataKey="name" tick={{ fontSize: 10 }} stroke="#94a3b8" width={150} />
                    <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8 }} />
                    <Bar dataKey="rate" fill="#0d9488" name="Attendance rate %" radius={[0, 4, 4, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              ) : <EmptyState title="No department data" />}
            </SectionCard>
          </div>

          {/* method distribution + compliance donuts (§40) */}
          <div className="grid lg:grid-cols-3 gap-4">
            <SectionCard title={<span>Attendance Method Distribution <span className="text-slate-400 font-normal">· {data.compliance?.locatedEvents ?? 0} method events</span></span>}>
              {data.methodDistribution?.length ? (
                <ResponsiveContainer width="100%" height={240}>
                  <PieChart>
                    <Pie data={data.methodDistribution} dataKey="value" nameKey="name" innerRadius={55} outerRadius={85} paddingAngle={2}>
                      {data.methodDistribution.map((_: any, i: number) => <Cell key={i} fill={DONUT_COLORS[i % DONUT_COLORS.length]} />)}
                    </Pie>
                    <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8 }} />
                    <Legend wrapperStyle={{ fontSize: 10 }} />
                  </PieChart>
                </ResponsiveContainer>
              ) : <EmptyState title="No method data" hint="Methods appear once geo-fence/selfie/device check-ins are used." />}
            </SectionCard>

            <SectionCard title={<span>GPS Compliance <span className="text-slate-400 font-normal">· OK vs disabled</span></span>}>
              <ResponsiveContainer width="100%" height={240}>
                <PieChart>
                  <Pie
                    data={[
                      { name: "GPS OK", value: data.compliance?.gpsOk ?? 0 },
                      { name: "GPS disabled", value: data.compliance?.gpsDisabled ?? 0 },
                    ]}
                    dataKey="value" nameKey="name" innerRadius={55} outerRadius={85} paddingAngle={2}
                  >
                    <Cell fill="#059669" />
                    <Cell fill="#dc2626" />
                  </Pie>
                  <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8 }} />
                  <Legend wrapperStyle={{ fontSize: 10 }} />
                </PieChart>
              </ResponsiveContainer>
              {(data.compliance?.gpsOk ?? 0) + (data.compliance?.gpsDisabled ?? 0) === 0 && <EmptyState title="No GPS data in this period" />}
            </SectionCard>

            <SectionCard title={<span>Geo-Fence Compliance <span className="text-slate-400 font-normal">· inside vs outside</span></span>}>
              <ResponsiveContainer width="100%" height={240}>
                <PieChart>
                  <Pie
                    data={[
                      { name: "Inside fence", value: data.compliance?.insideFence ?? 0 },
                      { name: "Outside fence", value: data.compliance?.outsideFence ?? 0 },
                    ]}
                    dataKey="value" nameKey="name" innerRadius={55} outerRadius={85} paddingAngle={2}
                  >
                    <Cell fill="#0d9488" />
                    <Cell fill="#e11d48" />
                  </Pie>
                  <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8 }} />
                  <Legend wrapperStyle={{ fontSize: 10 }} />
                </PieChart>
              </ResponsiveContainer>
              {(data.compliance?.insideFence ?? 0) + (data.compliance?.outsideFence ?? 0) === 0 && <EmptyState title="No geo-fence data in this period" />}
            </SectionCard>
          </div>

          {/* branch/department tables (§41 totals) */}
          <div className="grid lg:grid-cols-2 gap-4">
            <SectionCard title="Branch Totals">
              {data.branchStats?.length ? (
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-slate-400 text-left border-b border-slate-200 dark:border-slate-800">
                      <th className="py-1.5 font-medium">Branch</th>
                      <th className="py-1.5 font-medium text-right">Employees</th>
                      <th className="py-1.5 font-medium text-right">Present</th>
                      <th className="py-1.5 font-medium text-right">Late</th>
                      <th className="py-1.5 font-medium text-right">Absent</th>
                      <th className="py-1.5 font-medium text-right">Rate</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.branchStats.map((b: any) => (
                      <tr key={b.name} className="border-b border-slate-100 dark:border-slate-800/60">
                        <td className="py-1.5 font-medium">{b.name}</td>
                        <td className="py-1.5 text-right tabular-nums">{b.employees}</td>
                        <td className="py-1.5 text-right tabular-nums">{b.present}</td>
                        <td className="py-1.5 text-right tabular-nums">{b.late}</td>
                        <td className="py-1.5 text-right tabular-nums">{b.absent}</td>
                        <td className="py-1.5 text-right tabular-nums font-semibold">{Math.round(b.rate)}%</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : <EmptyState title="No branch data" />}
            </SectionCard>

            <SectionCard title={<span>Location Integrity Signals <span className="text-slate-400 font-normal">· flagged events by type</span></span>}>
              {data.integrityDistribution?.length ? (
                <div className="space-y-1.5">
                  {data.integrityDistribution.map((s: any, i: number) => (
                    <div key={s.name} className="flex items-center gap-2">
                      <span className="w-2.5 h-2.5 rounded-full" style={{ background: DONUT_COLORS[i % DONUT_COLORS.length] }} />
                      <span className="text-xs flex-1">{s.name}</span>
                      <span className="text-xs font-bold tabular-nums">{s.value}</span>
                    </div>
                  ))}
                </div>
              ) : <EmptyState title="No integrity flags" hint="Mock-location, impossible-movement and stale-fix signals appear here." />}
            </SectionCard>
          </div>
        </>
      )}
    </div>
  )
}

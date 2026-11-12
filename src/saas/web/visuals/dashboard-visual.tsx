"use client"
// ============ Visual 01 · All in One Dashboard ============
// Miniature console simulation: KPI row (with a count-up on headcount), a
// 14-day attendance trend, payroll composition donut, department headcount
// bars, pending tasks, activity feed, notifications and an attendance summary
// strip. All numbers are internally consistent with a 1,248-person workforce.
import { useEffect, useState } from "react"
import type { LucideIcon } from "lucide-react"
import {
  Activity, ArrowUpRight, Bell, CalendarCheck, Check, FileDown, LayoutDashboard,
  ListChecks, MapPin, Plus, Settings, TrendingUp, Users, Wallet, Zap,
} from "lucide-react"
import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Pie, PieChart,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts"
import { cn } from "@/lib/utils"
import { Avatar, CHART_TOOLTIP_STYLE, Chip, FV, Meter, Panel, StatusDot, TONE_TEXT, WindowChrome } from "./chrome"
import type { ChipTone } from "./chrome"

/* ---------- demo data (internally consistent: 1,248 employees) ---------- */
const TREND_14: { d: string; pct: number }[] = [
  { d: "01", pct: 94.1 }, { d: "02", pct: 95.2 }, { d: "03", pct: 94.8 }, { d: "04", pct: 95.9 },
  { d: "05", pct: 96.1 }, { d: "06", pct: 93.8 }, { d: "07", pct: 92.4 }, { d: "08", pct: 95.5 },
  { d: "09", pct: 96.3 }, { d: "10", pct: 95.7 }, { d: "11", pct: 94.9 }, { d: "12", pct: 96.6 },
  { d: "13", pct: 95.2 }, { d: "14", pct: 95.3 },
]

const PAYROLL_MIX: { name: string; value: number }[] = [
  { name: "Basic", value: 50 }, { name: "House Rent", value: 30 },
  { name: "Conveyance", value: 8 }, { name: "Overtime", value: 12 },
]
const MIX_COLORS = [FV.indigo, FV.violet, FV.cyan, FV.amber]

// department headcount sums to 1,248
const DEPARTMENTS: { name: string; value: number }[] = [
  { name: "Sales", value: 312 }, { name: "Operations", value: 284 }, { name: "Engineering", value: 241 },
  { name: "Support", value: 170 }, { name: "Finance", value: 96 }, { name: "Marketing", value: 87 },
  { name: "HR", value: 58 },
]

const STRIP: { label: string; value: string; pct: number; tone: ChipTone }[] = [
  { label: "Present", value: "1,141", pct: 91.4, tone: "emerald" },
  { label: "Late", value: "48", pct: 3.8, tone: "amber" },
  { label: "On Leave", value: "37", pct: 3.0, tone: "cyan" },
  { label: "Absent", value: "22", pct: 1.8, tone: "rose" },
]

const TASKS: { title: string; done: boolean; priority: string; tone: ChipTone }[] = [
  { title: "Approve payroll run 2026-09", done: false, priority: "High", tone: "rose" },
  { title: "Review 18 flagged attendance entries", done: false, priority: "High", tone: "rose" },
  { title: "Verify N. Akter passport renewal", done: false, priority: "Med", tone: "amber" },
  { title: "Publish holiday calendar (Nov)", done: true, priority: "Med", tone: "amber" },
  { title: "Rotate device comm key A8C2", done: true, priority: "Low", tone: "slate" },
]

const FEED: { time: string; who: string; text: string }[] = [
  { time: "09:42", who: "NJ", text: "Nusrat Jahan approved leave · Annual · 2 days" },
  { time: "09:15", who: "SYS", text: "Device A8C2-9F41 synced 12 punch events" },
  { time: "08:58", who: "TA", text: "Tanvir Alam checked in · Selfie · Gulshan-1" },
  { time: "08:41", who: "FM", text: "Payroll 2026-09 moved to Approvals" },
  { time: "08:22", who: "HR", text: "Sabrina Akter document verified (NID)" },
]

const NOTES: { text: string; count: number; tone: ChipTone }[] = [
  { text: "Payroll 2026-09 awaiting approval", count: 1, tone: "indigo" },
  { text: "Attendance flags for review", count: 18, tone: "amber" },
  { text: "Document expiries this month", count: 3, tone: "rose" },
]

const RAIL: { icon: LucideIcon; label: string; active?: boolean }[] = [
  { icon: LayoutDashboard, label: "Dashboard", active: true },
  { icon: Users, label: "Employees" },
  { icon: CalendarCheck, label: "Attendance" },
  { icon: Wallet, label: "Payroll" },
  { icon: MapPin, label: "Tracking" },
  { icon: Activity, label: "Performance" },
]

/* ---------- count-up (skips animation under reduced motion) ---------- */
function useCountUp(target: number, duration = 1100): number {
  const [value, setValue] = useState(0)
  useEffect(() => {
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches
    let raf = 0
    let start = 0
    const tick = (now: number) => {
      if (!start) start = now
      const t = reduce ? 1 : Math.min(1, (now - start) / duration)
      setValue(Math.round(target * (1 - Math.pow(1 - t, 3))))
      if (t < 1) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [target, duration])
  return value
}

function KpiCard({ icon: Icon, label, value, delta, tone }: {
  icon: LucideIcon; label: string; value: string; delta: string; tone: ChipTone
}) {
  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.03] p-2.5 light:border-slate-200 light:bg-white light:shadow-sm">
      <p className="flex items-center gap-1 text-[9px] font-bold uppercase tracking-widest text-slate-500">
        <Icon className="h-3 w-3 text-indigo-300 light:text-indigo-600" /> {label}
      </p>
      <p className="mt-1 text-lg font-bold tabular-nums leading-tight text-white light:text-slate-900">{value}</p>
      <p className={cn("mt-0.5 text-[9px] font-medium", TONE_TEXT[tone])}>{delta}</p>
    </div>
  )
}

/* ---------- the visual ---------- */
export function DashboardVisual() {
  const employees = useCountUp(1248)
  return (
    <WindowChrome title={
      <>
        finixhr.app — Dashboard · Gulshan HQ
        <span className="ml-2 inline-flex items-center gap-1 text-emerald-400 light:text-emerald-600">
          <StatusDot tone="emerald" pulse /> live · 11:02
        </span>
      </>
    }>
      <div className="flex gap-2 sm:gap-3">
        {/* icon rail — makes the miniature read as a real app */}
        <nav aria-label="App navigation" className="hidden w-10 shrink-0 flex-col items-center gap-1 rounded-xl border border-white/10 bg-white/[0.02] p-1.5 sm:flex light:border-slate-200 light:bg-slate-50">
          <span className="mb-1 flex h-6 w-6 items-center justify-center rounded-lg bg-gradient-to-br from-blue-600 to-violet-600 text-[9px] font-black text-white">F</span>
          {RAIL.map((item) => (
            <span
              key={item.label}
              title={item.label}
              className={cn(
                "flex h-6 w-6 items-center justify-center rounded-lg",
                item.active
                  ? "bg-indigo-500/20 text-indigo-300 ring-1 ring-indigo-400/40 light:bg-indigo-500/10 light:text-indigo-600"
                  : "text-slate-500 light:text-slate-400",
              )}
            >
              <item.icon className="h-3.5 w-3.5" />
            </span>
          ))}
          <span className="relative mt-auto flex h-6 w-6 items-center justify-center rounded-lg text-slate-500 light:text-slate-400">
            <Bell className="h-3.5 w-3.5" />
            <span className="absolute -right-0.5 -top-0.5 flex h-3 w-3 items-center justify-center rounded-full bg-rose-500 text-[7px] font-bold text-white">4</span>
          </span>
          <Settings className="h-3.5 w-3.5 text-slate-500 light:text-slate-400" />
        </nav>

        <div className="min-w-0 flex-1 space-y-2 sm:space-y-3">
          {/* KPI row */}
          <div className="grid grid-cols-2 gap-2 lg:grid-cols-4 sm:gap-3">
            <KpiCard icon={Users} label="Total Employees" value={employees.toLocaleString()} delta="+12 this month" tone="emerald" />
            <KpiCard icon={CalendarCheck} label="Present Today" value="1,189" delta="95.3% · incl. 48 late" tone="emerald" />
            <KpiCard icon={Activity} label="On Leave" value="37" delta="8 casual · 29 other" tone="amber" />
            <div className="rounded-xl border border-violet-400/25 bg-violet-500/[0.06] p-2.5 light:border-violet-500/30 light:bg-violet-500/5">
              <p className="flex items-center gap-1 text-[9px] font-bold uppercase tracking-widest text-slate-500">
                <Wallet className="h-3 w-3 text-violet-300 light:text-violet-600" /> Payroll Runs
              </p>
              <p className="mt-1 flex items-center gap-2 text-lg font-bold tabular-nums leading-tight text-white light:text-slate-900">
                2 <StatusDot tone="violet" pulse />
              </p>
              <p className="mt-0.5 text-[9px] font-medium text-violet-300 light:text-violet-600">2026-09 &amp; bonus run · processing</p>
            </div>
          </div>

          <div className="grid gap-2 gap-y-3 lg:grid-cols-3 sm:gap-3">
            {/* left column: charts + strip + actions */}
            <div className="space-y-3 lg:col-span-2">
              <div className="grid gap-3 sm:grid-cols-2">
                <Panel title="Attendance trend · 14 days" icon={TrendingUp}>
                  <div className="h-[150px]">
                    <ResponsiveContainer width="100%" height="100%">
                      <AreaChart data={TREND_14} margin={{ top: 4, right: 4, bottom: 0, left: -18 }}>
                        <defs>
                          <linearGradient id="fvDashAtt" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="5%" stopColor={FV.indigo} stopOpacity={0.35} />
                            <stop offset="95%" stopColor={FV.indigo} stopOpacity={0} />
                          </linearGradient>
                        </defs>
                        <CartesianGrid stroke="rgba(148,163,184,0.12)" vertical={false} />
                        <XAxis dataKey="d" tick={{ fontSize: 9, fill: "#94a3b8" }} stroke="rgba(148,163,184,0.15)" interval={1} tickLine={false} />
                        <YAxis domain={[90, 98]} tick={{ fontSize: 9, fill: "#94a3b8" }} stroke="rgba(148,163,184,0.15)" tickLine={false} axisLine={false} unit="%" />
                        <Tooltip contentStyle={CHART_TOOLTIP_STYLE} formatter={(v) => `${v}% present`} />
                        <Area type="monotone" dataKey="pct" stroke="#818cf8" strokeWidth={2} fill="url(#fvDashAtt)" name="Present" />
                      </AreaChart>
                    </ResponsiveContainer>
                  </div>
                </Panel>
                <Panel title="Payroll composition" icon={Wallet}>
                  <div className="relative h-[150px]">
                    <ResponsiveContainer width="100%" height="100%">
                      <PieChart>
                        <Pie data={PAYROLL_MIX} dataKey="value" nameKey="name" innerRadius={38} outerRadius={54} paddingAngle={3} strokeWidth={0}>
                          {PAYROLL_MIX.map((entry, i) => <Cell key={entry.name} fill={MIX_COLORS[i]} />)}
                        </Pie>
                        <Tooltip contentStyle={CHART_TOOLTIP_STYLE} formatter={(v) => `${v}% of gross`} />
                      </PieChart>
                    </ResponsiveContainer>
                    <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
                      <span className="text-[10px] font-bold text-white light:text-slate-900">2026-09</span>
                      <span className="text-[8px] font-semibold uppercase tracking-widest text-slate-500">run mix</span>
                    </div>
                  </div>
                  <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1">
                    {PAYROLL_MIX.map((m, i) => (
                      <span key={m.name} className="flex items-center gap-1 text-[9px] text-slate-400 light:text-slate-600">
                        <span className="h-1.5 w-1.5 rounded-full" style={{ background: MIX_COLORS[i] }} />
                        {m.name} {m.value}%
                      </span>
                    ))}
                  </div>
                </Panel>
              </div>

              <Panel title="Department headcount" icon={Users}>
                <div className="h-[150px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={DEPARTMENTS} margin={{ top: 4, right: 4, bottom: 0, left: -18 }}>
                      <CartesianGrid stroke="rgba(148,163,184,0.12)" vertical={false} />
                      <XAxis dataKey="name" tick={{ fontSize: 8, fill: "#94a3b8" }} stroke="rgba(148,163,184,0.15)" interval={0} angle={-18} textAnchor="end" height={36} tickLine={false} />
                      <YAxis tick={{ fontSize: 9, fill: "#94a3b8" }} stroke="rgba(148,163,184,0.15)" tickLine={false} axisLine={false} width={30} />
                      <Tooltip contentStyle={CHART_TOOLTIP_STYLE} cursor={{ fill: "rgba(99,102,241,0.08)" }} />
                      <Bar dataKey="value" fill={FV.indigo} radius={[4, 4, 0, 0]} maxBarSize={24} name="Employees" />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </Panel>

              <Panel title="Attendance today · 1,248 tracked" icon={CalendarCheck}>
                <div className="grid gap-x-4 gap-y-2 sm:grid-cols-2">
                  {STRIP.map((s) => (
                    <div key={s.label}>
                      <div className="mb-1 flex items-center justify-between text-[10px]">
                        <span className="flex items-center gap-1.5 font-medium text-slate-300 light:text-slate-700">
                          <StatusDot tone={s.tone} /> {s.label}
                        </span>
                        <span className="tabular-nums text-slate-400 light:text-slate-600">{s.value} · {s.pct}%</span>
                      </div>
                      <Meter value={s.pct} tone={s.tone} />
                    </div>
                  ))}
                </div>
              </Panel>

              {/* action buttons */}
              <div className="flex flex-wrap gap-1.5">
                <span className="inline-flex items-center gap-1 rounded-lg bg-gradient-to-r from-blue-600 to-violet-600 px-2.5 py-1 text-[10px] font-semibold text-white shadow-lg shadow-indigo-950/40">
                  <Zap className="h-3 w-3" /> Run payroll
                </span>
                <span className="inline-flex items-center gap-1 rounded-lg border border-white/15 px-2.5 py-1 text-[10px] font-semibold text-slate-300 light:border-slate-300 light:text-slate-700">
                  <Plus className="h-3 w-3" /> Add employee
                </span>
                <span className="inline-flex items-center gap-1 rounded-lg border border-white/15 px-2.5 py-1 text-[10px] font-semibold text-slate-300 light:border-slate-300 light:text-slate-700">
                  <FileDown className="h-3 w-3" /> Export report
                </span>
                <span className="inline-flex items-center gap-1 rounded-lg border border-white/15 px-2.5 py-1 text-[10px] font-semibold text-slate-300 light:border-slate-300 light:text-slate-700">
                  <ListChecks className="h-3 w-3" /> Approval queue · 4
                </span>
              </div>
            </div>

            {/* right column: tasks, activity, notifications */}
            <div className="space-y-3">
              <Panel title="Pending tasks" icon={ListChecks} action={<Chip tone="rose">3 open</Chip>}>
                <ul className="space-y-1.5">
                  {TASKS.map((t) => (
                    <li key={t.title} className="flex items-center gap-2 rounded-lg bg-white/[0.03] px-2 py-1.5 light:bg-slate-50">
                      <span className={cn(
                        "flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border",
                        t.done ? "border-emerald-400/60 bg-emerald-400/20 text-emerald-300 light:text-emerald-600" : "border-white/20 light:border-slate-300",
                      )}>
                        {t.done && <Check className="h-2.5 w-2.5" />}
                      </span>
                      <span className={cn(
                        "min-w-0 flex-1 truncate text-[10px] font-medium",
                        t.done ? "text-slate-500 line-through" : "text-slate-300 light:text-slate-700",
                      )}>
                        {t.title}
                      </span>
                      <Chip tone={t.tone}>{t.priority}</Chip>
                    </li>
                  ))}
                </ul>
              </Panel>

              <Panel title="Recent activity" icon={Activity}>
                <ul className="space-y-1.5">
                  {FEED.map((f) => (
                    <li key={f.time} className="flex items-center gap-2">
                      <Avatar initials={f.who} className="h-5 w-5 text-[8px]" />
                      <span className="min-w-0 flex-1 truncate text-[10px] text-slate-300 light:text-slate-600">{f.text}</span>
                      <span className="shrink-0 font-mono text-[9px] text-slate-500">{f.time}</span>
                    </li>
                  ))}
                </ul>
              </Panel>

              <Panel title="Notifications" icon={Bell}>
                <ul className="space-y-1.5">
                  {NOTES.map((n) => (
                    <li key={n.text} className="flex items-center gap-2 rounded-lg bg-white/[0.03] px-2 py-1.5 light:bg-slate-50">
                      <StatusDot tone={n.tone} pulse />
                      <span className="min-w-0 flex-1 truncate text-[10px] font-medium text-slate-300 light:text-slate-700">{n.text}</span>
                      <span className="flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-indigo-500 px-1 text-[8px] font-bold text-white">
                        {n.count}
                      </span>
                    </li>
                  ))}
                </ul>
                <div className="mt-2 flex items-center gap-1.5 text-[9px] text-slate-500">
                  <ArrowUpRight className="h-3 w-3" /> Demo data — your workspace shows live figures
                </div>
              </Panel>
            </div>
          </div>
        </div>
      </div>
    </WindowChrome>
  )
}

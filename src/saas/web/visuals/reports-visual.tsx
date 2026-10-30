"use client"
// ============ Visual 12 · Reports & Analytics ============
// Report gallery, featured analytics (headcount by department bars + 12-month
// turnover line), KPI chips, export buttons and the scheduled-reports card.
import {
  CalendarClock, CalendarCheck, Download, FileBarChart2, FileSpreadsheet, FileText,
  History, Mail, ReceiptText, Timer, TrendingUp, Users,
} from "lucide-react"
import type { LucideIcon } from "lucide-react"
import {
  Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts"
import { cn } from "@/lib/utils"
import { CHART_TOOLTIP_STYLE, Chip, Panel, StatusDot, WindowChrome } from "./chrome"

/* ---------- data ---------- */
const GALLERY: { icon: LucideIcon; name: string; desc: string }[] = [
  { icon: CalendarCheck, name: "Attendance Summary", desc: "daily presence, late & OT by branch" },
  { icon: ReceiptText, name: "Payroll Register", desc: "run-wise salary journal · BDT" },
  { icon: Users, name: "Headcount", desc: "org & department snapshot" },
  { icon: TrendingUp, name: "Turnover", desc: "attrition, exits & tenure" },
  { icon: Timer, name: "Device Uptime", desc: "ZKTeco health & sync log" },
]

// department headcount mirrors the dashboard visual (sums to 1,248)
const HEADCOUNT: { name: string; value: number }[] = [
  { name: "Sales", value: 312 }, { name: "Operations", value: 284 }, { name: "Engineering", value: 241 },
  { name: "Support", value: 170 }, { name: "Finance", value: 96 }, { name: "Marketing", value: 87 },
  { name: "HR", value: 58 },
]

const TURNOVER: { m: string; pct: number }[] = [
  { m: "Nov", pct: 3.6 }, { m: "Dec", pct: 3.4 }, { m: "Jan", pct: 3.8 }, { m: "Feb", pct: 3.1 },
  { m: "Mar", pct: 2.9 }, { m: "Apr", pct: 3.3 }, { m: "May", pct: 3.0 }, { m: "Jun", pct: 2.8 },
  { m: "Jul", pct: 3.4 }, { m: "Aug", pct: 3.2 }, { m: "Sep", pct: 3.1 }, { m: "Oct", pct: 3.2 },
]

const EXPORTS: { label: string; icon: LucideIcon; cls: string }[] = [
  { label: "PDF", icon: FileText, cls: "border-rose-400/30 bg-rose-400/10 text-rose-300 light:border-rose-500/30 light:bg-rose-500/10 light:text-rose-700" },
  { label: "XLSX", icon: FileSpreadsheet, cls: "border-emerald-400/30 bg-emerald-400/10 text-emerald-300 light:border-emerald-500/30 light:bg-emerald-500/10 light:text-emerald-700" },
  { label: "CSV", icon: Download, cls: "border-white/15 bg-white/5 text-slate-300 light:border-slate-300 light:bg-slate-100 light:text-slate-700" },
]

const PARAMS: [string, string][] = [
  ["Range", "Oct 2026"],
  ["Branches", "All (3)"],
  ["Group by", "Department"],
  ["Employment", "All types"],
]

const GENERATIONS: { name: string; when: string; by: string; size: string }[] = [
  { name: "Attendance Summary · Sep", when: "today 08:01", by: "scheduled", size: "412 KB" },
  { name: "Payroll Register · 2026-09", when: "10-12 16:40", by: "finance.mgr", size: "1.2 MB" },
  { name: "Device Uptime · 30d", when: "10-11 09:15", by: "hr.admin", size: "96 KB" },
]

/* ---------- the visual ---------- */
export function ReportsVisual() {
  return (
    <WindowChrome
      title={<>finixhr.app — Reports &amp; Analytics
        <span className="ml-2 inline-flex items-center gap-1 text-indigo-300 light:text-indigo-600">
          <StatusDot tone="indigo" pulse /> 2 jobs running
        </span>
      </>}
    >
      <div className="space-y-3">
        {/* gallery */}
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-5 sm:gap-3">
          {GALLERY.map((g) => (
            <div key={g.name} className="group rounded-xl border border-white/10 bg-white/[0.03] p-2.5 transition-colors hover:border-indigo-400/40 hover:bg-indigo-500/[0.06] light:border-slate-200 light:bg-white light:shadow-sm light:hover:border-indigo-400/60">
              <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-gradient-to-br from-blue-500/25 to-violet-500/20 ring-1 ring-white/10 light:ring-slate-200">
                <g.icon className="h-3.5 w-3.5 text-indigo-300 light:text-indigo-600" />
              </span>
              <p className="mt-2 truncate text-[11px] font-bold text-white light:text-slate-900">{g.name}</p>
              <p className="mt-0.5 line-clamp-2 text-[9px] leading-snug text-slate-500">{g.desc}</p>
              <span className="mt-2 inline-flex items-center gap-1 rounded-md bg-indigo-500/15 px-1.5 py-0.5 text-[8px] font-bold uppercase tracking-wider text-indigo-300 light:bg-indigo-500/10 light:text-indigo-600">
                Generate
              </span>
            </div>
          ))}
        </div>

        {/* featured analytics */}
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[9px] font-bold uppercase tracking-widest text-slate-500">View</span>
          {["Chart", "Table", "Pivot"].map((v, i) => (
            <span key={v} className={cn(
              "rounded-lg px-2 py-1 text-[9px] font-semibold",
              i === 0
                ? "bg-indigo-500/20 text-indigo-200 ring-1 ring-indigo-400/40 light:bg-indigo-500/10 light:text-indigo-600"
                : "text-slate-500 light:text-slate-500",
            )}>{v}</span>
          ))}
          <span className="ml-auto inline-flex items-center gap-1 rounded-lg border border-white/10 bg-white/[0.03] px-2 py-1 text-[9px] text-slate-500 light:border-slate-200 light:bg-white">
            <FileText className="h-3 w-3" /> attendance · payroll · leave sources
          </span>
        </div>
        <div className="grid gap-3 lg:grid-cols-2">
          <Panel title="Headcount by department · Oct 2026" icon={Users} action={<Chip tone="indigo">1,248 total</Chip>}>
            <div className="mb-2 flex flex-wrap gap-x-3 gap-y-1">
              {PARAMS.map(([k, v]) => (
                <span key={k} className="text-[9px] text-slate-500">
                  {k}: <span className="font-semibold text-slate-300 light:text-slate-700">{v}</span>
                </span>
              ))}
            </div>
            <div className="h-[160px]">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={HEADCOUNT} margin={{ top: 4, right: 4, bottom: 0, left: -20 }}>
                  <CartesianGrid stroke="rgba(148,163,184,0.12)" vertical={false} />
                  <XAxis dataKey="name" tick={{ fontSize: 8, fill: "#94a3b8" }} stroke="rgba(148,163,184,0.15)" interval={0} angle={-18} textAnchor="end" height={34} tickLine={false} />
                  <YAxis tick={{ fontSize: 9, fill: "#94a3b8" }} stroke="rgba(148,163,184,0.15)" tickLine={false} axisLine={false} width={30} />
                  <Tooltip contentStyle={CHART_TOOLTIP_STYLE} cursor={{ fill: "rgba(99,102,241,0.08)" }} />
                  <Bar dataKey="value" fill="#6366f1" radius={[4, 4, 0, 0]} maxBarSize={24} name="Employees" />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </Panel>

          <Panel title="Turnover trend · 12 months" icon={TrendingUp} action={<Chip tone="emerald">▼ improving</Chip>}>
            <div className="h-[160px]">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={TURNOVER} margin={{ top: 4, right: 6, bottom: 0, left: -22 }}>
                  <CartesianGrid stroke="rgba(148,163,184,0.12)" vertical={false} />
                  <XAxis dataKey="m" tick={{ fontSize: 8, fill: "#94a3b8" }} stroke="rgba(148,163,184,0.15)" interval={1} tickLine={false} />
                  <YAxis domain={[2, 4]} tick={{ fontSize: 9, fill: "#94a3b8" }} stroke="rgba(148,163,184,0.15)" tickLine={false} axisLine={false} unit="%" width={30} />
                  <Tooltip contentStyle={CHART_TOOLTIP_STYLE} formatter={(v) => `${v}% monthly attrition`} />
                  <Line type="monotone" dataKey="pct" stroke="#06b6d4" strokeWidth={2} dot={false} name="Attrition" activeDot={{ r: 3 }} />
                </LineChart>
              </ResponsiveContainer>
            </div>
            <div className="flex flex-wrap gap-1.5">
              <Chip tone="cyan">Attrition 3.2%</Chip>
              <Chip tone="violet">Avg tenure 2.8y</Chip>
              <Chip tone="emerald">Retention 96.8%</Chip>
            </div>
          </Panel>
        </div>

        {/* exports + scheduled */}
        <div className="grid gap-3 lg:grid-cols-[1fr_320px]">
          <Panel title="Export · Attendance Summary (Oct)" icon={FileBarChart2}>
            <div className="flex flex-wrap gap-1.5">
              {EXPORTS.map((e) => (
                <span key={e.label} className={cn("inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[10px] font-bold", e.cls)}>
                  <e.icon className="h-3.5 w-3.5" /> {e.label}
                </span>
              ))}
            </div>
            <p className="mt-2 text-[9px] text-slate-500">
              Generated server-side from the live database — PDF payslips are digitally verified, XLSX/CSV carry audit headers.
            </p>
          </Panel>

          <div className="fv-float-b rotate-[1deg] rounded-xl border border-white/15 bg-slate-900/95 p-2.5 shadow-xl shadow-black/40 light:border-slate-200 light:bg-white light:shadow-xl light:shadow-slate-900/15">
            <p className="flex items-center gap-1.5 text-[9px] font-bold uppercase tracking-widest text-slate-500">
              <CalendarClock className="h-3 w-3 text-indigo-300 light:text-indigo-600" /> Scheduled reports
            </p>
            <ul className="mt-1.5 space-y-1.5">
              {[
                { name: "Attendance Summary · weekly", run: "Mon 26 Oct · 08:00" },
                { name: "Payroll Register · monthly", run: "01 Nov · 09:00" },
              ].map((s) => (
                <li key={s.name} className="flex items-center gap-2 rounded-lg bg-white/[0.03] px-2 py-1.5 light:bg-slate-50">
                  <Mail className="h-3 w-3 shrink-0 text-cyan-400 light:text-cyan-600" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[10px] font-medium text-slate-300 light:text-slate-700">{s.name}</p>
                    <p className="truncate text-[9px] text-slate-500">next run {s.run} → hr@finixhr.app</p>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </div>

        {/* recent generations */}
        <Panel title="Recent generations" icon={History} action={<Chip tone="slate">148 this month</Chip>}>
          <ul className="grid gap-1.5 sm:grid-cols-3">
            {GENERATIONS.map((g) => (
              <li key={g.name} className="flex items-center gap-2 rounded-lg bg-white/[0.03] px-2 py-1.5 light:bg-slate-50">
                <FileText className="h-3.5 w-3.5 shrink-0 text-indigo-300 light:text-indigo-600" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[10px] font-medium text-slate-300 light:text-slate-700">{g.name}</p>
                  <p className="truncate text-[9px] text-slate-500">{g.when} · {g.by} · {g.size}</p>
                </div>
                <Chip tone="emerald">PDF</Chip>
              </li>
            ))}
          </ul>
        </Panel>
      </div>
    </WindowChrome>
  )
}

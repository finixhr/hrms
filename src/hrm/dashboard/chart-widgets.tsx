"use client"
// ============ Dashboard chart primitives (lazy-loaded, recharts) ============
// Each chart is a small default-export component so next/dynamic can code-split
// recharts out of the dashboard's first paint (same L-5 discipline as before).
// Data arrives via props — no fetches here. Styling follows the 2026 design
// system: muted axes, 10.5px ticks, soft brand fills, themed tooltip cards.
import {
  ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip, BarChart, Bar,
  PieChart, Pie, Cell,
} from "recharts"

export const CHART_COLORS = ["#059669", "#0d9488", "#6366f1", "#f59e0b", "#ec4899", "#64748b", "#14b8a6", "#f43f5e"]
const AXIS = "#94a3b8"

/** Shared tooltip card — themed to match the design system in both modes. */
function ChartTip({ active, payload, label, formatter }: any) {
  if (!active || !payload?.length) return null
  return (
    <div className="rounded-lg border bg-popover text-popover-foreground hrm-shadow-md px-2.5 py-1.5 text-[11px]">
      {label != null && <p className="font-semibold mb-0.5">{label}</p>}
      {payload.map((p: any, i: number) => (
        <p key={i} className="flex items-center gap-1.5 tabular-nums">
          <span className="h-1.5 w-1.5 rounded-full" style={{ background: p.color || p.fill }} />
          <span className="text-muted-foreground">{p.name}:</span>
          <b>{formatter ? formatter(p.value) : p.value}</b>
        </p>
      ))}
    </div>
  )
}

// ---------- Headcount trend (area) ----------
export function HeadcountTrendChart({ data }: { data: any[] }) {
  return (
    <div className="hrm-chart">
      <ResponsiveContainer width="100%" height={190}>
        <AreaChart data={data} margin={{ top: 12, right: 8, left: -18, bottom: 0 }}>
          <defs>
            <linearGradient id="hcFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor="#059669" stopOpacity={0.28} />
              <stop offset="95%" stopColor="#059669" stopOpacity={0} />
            </linearGradient>
          </defs>
          <XAxis dataKey="period" tick={{ fontSize: 10.5, fill: AXIS }} stroke={AXIS} tickLine={false} axisLine={false} />
          <YAxis tick={{ fontSize: 10.5, fill: AXIS }} stroke={AXIS} allowDecimals={false} tickLine={false} axisLine={false} width={44} />
          <Tooltip content={<ChartTip />} cursor={{ stroke: AXIS, strokeDasharray: "3 3" }} />
          <Area type="monotone" dataKey="value" stroke="#059669" strokeWidth={2} fill="url(#hcFill)" name="Employees" />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  )
}

// ---------- Employees by branch (bars) ----------
export function BranchBarsChart({ data, onBarClick }: { data: any[]; onBarClick?: () => void }) {
  return (
    <div className="hrm-chart">
      <ResponsiveContainer width="100%" height={190}>
        <BarChart data={data} margin={{ top: 12, right: 8, left: -18, bottom: 0 }}>
          <XAxis dataKey="name" tick={{ fontSize: 9.5, fill: AXIS }} stroke={AXIS} interval={0} angle={-12} textAnchor="end" height={44} tickLine={false} axisLine={false} />
          <YAxis tick={{ fontSize: 10.5, fill: AXIS }} stroke={AXIS} allowDecimals={false} tickLine={false} axisLine={false} width={44} />
          <Tooltip content={<ChartTip />} cursor={{ fill: "rgba(148,163,184,0.12)" }} />
          <Bar dataKey="value" fill="#0d9488" radius={[5, 5, 0, 0]} name="Employees" maxBarSize={34}
            onClick={onBarClick} className={onBarClick ? "cursor-pointer" : undefined} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}

// ---------- Payroll trend (gross vs net areas) ----------
export function PayrollTrendChart({ data, fmtMoney }: { data: any[]; fmtMoney: (n: number) => string }) {
  return (
    <div className="hrm-chart">
      <ResponsiveContainer width="100%" height={190}>
        <AreaChart data={data} margin={{ top: 14, right: 10, left: -2, bottom: 0 }}>
          <XAxis dataKey="period" tick={{ fontSize: 10.5, fill: AXIS }} stroke={AXIS} tickLine={false} axisLine={false} />
          <YAxis tick={{ fontSize: 10, fill: AXIS }} stroke={AXIS} tickFormatter={(v: any) => fmtMoney(Number(v)).replace(/\.\d+$/, "")} width={70} tickLine={false} axisLine={false} domain={["auto", "auto"]} />
          <Tooltip content={<ChartTip formatter={(v: any) => fmtMoney(Number(v))} />} cursor={{ stroke: AXIS, strokeDasharray: "3 3" }} />
          <Area type="monotone" dataKey="gross" stroke="#f59e0b" strokeWidth={2} fill="#f59e0b1f" name="Gross" />
          <Area type="monotone" dataKey="net" stroke="#059669" strokeWidth={2} fill="#05966922" name="Net" />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  )
}

// ---------- Distribution donut ----------
export function DonutChart({ data, offset = 0, height = 190 }: { data: any[]; offset?: number; height?: number }) {
  return (
    <div className="hrm-chart">
      <ResponsiveContainer width="100%" height={height}>
        <PieChart>
          <Pie data={data} dataKey="value" nameKey="name" innerRadius={38} outerRadius={64} paddingAngle={2} strokeWidth={0}>
            {data.map((_: any, i: number) => <Cell key={i} fill={CHART_COLORS[(i + offset) % CHART_COLORS.length]} />)}
          </Pie>
          <Tooltip content={<ChartTip />} />
        </PieChart>
      </ResponsiveContainer>
    </div>
  )
}

// ---------- Department distribution (progress bars) ----------
export function DepartmentBars({ data, onClick }: { data: any[]; onClick?: () => void }) {
  const max = Math.max(...data.map((x: any) => x.value), 1)
  return (
    <div className="space-y-1.5">
      {data.slice(0, 8).map((d: any) => (
        <button key={d.name} onClick={onClick} className="w-full flex items-center gap-2 text-left group focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring rounded">
          <span className="text-[11px] w-24 truncate text-slate-600 dark:text-slate-300">{d.name}</span>
          <div className="flex-1 h-3.5 bg-muted rounded overflow-hidden">
            <div className="h-full rounded bg-primary/80 group-hover:bg-primary transition-colors" style={{ width: `${Math.max(6, (d.value / max) * 100)}%` }} />
          </div>
          <span className="text-[11px] font-bold tabular-nums text-slate-700 dark:text-slate-200 w-7 text-right">{d.value}</span>
        </button>
      ))}
    </div>
  )
}

// ---------- Top designations (ranked list) ----------
export function DesignationList({ data }: { data: any[] }) {
  return (
    <div className="space-y-1">
      {data.slice(0, 8).map((d: any, i: number) => (
        <div key={d.name} className="flex items-center gap-2 text-xs">
          <span className={`w-4 text-center text-[10px] font-bold tabular-nums ${i < 3 ? "text-primary" : "text-muted-foreground"}`}>{i + 1}</span>
          <span className="flex-1 truncate text-slate-600 dark:text-slate-300">{d.name}</span>
          <span className="font-bold tabular-nums text-slate-700 dark:text-slate-200">{d.value}</span>
        </div>
      ))}
    </div>
  )
}

// ---------- Attendance rate ring (pure SVG, no recharts) ----------
export function RateRing({ rate, label, sub }: { rate: number; label: string; sub?: string }) {
  const r = 52
  const circ = 2 * Math.PI * r
  const off = circ * (1 - Math.min(100, Math.max(0, rate)) / 100)
  return (
    <div className="flex flex-col items-center justify-center py-1">
      <div className="relative">
        <svg width="128" height="128" viewBox="0 0 128 128" role="img" aria-label={`${label}: ${rate}%`}>
          <circle cx="64" cy="64" r={r} fill="none" stroke="currentColor" className="text-muted" strokeWidth="11" />
          <circle cx="64" cy="64" r={r} fill="none" stroke="#059669" strokeWidth="11" strokeLinecap="round"
            strokeDasharray={circ} strokeDashoffset={off} transform="rotate(-90 64 64)"
            style={{ transition: "stroke-dashoffset 900ms cubic-bezier(0.22, 1, 0.36, 1)" }} />
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-2xl font-bold tabular-nums text-slate-900 dark:text-slate-50">{rate}%</span>
          <span className="text-[10px] text-muted-foreground uppercase tracking-wide">{label}</span>
        </div>
      </div>
      {sub && <p className="text-[11px] text-muted-foreground mt-1.5 text-center">{sub}</p>}
    </div>
  )
}

export default function ChartWidgetsIndex() { return null }

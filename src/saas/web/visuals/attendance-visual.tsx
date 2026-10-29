"use client"
// ============ Visual 05 · Attendance ============
// Daily summary cards, the today sheet (source + status chips), a color-coded
// October strip, 30-day trend line, check-in source pie and a floating
// selfie-verification proof card. Present 1,141 + late 48 + leave 37 +
// absent 22 = 1,248 tracked.
import { CalendarCheck, Camera, CheckCircle2, Clock, MapPin, ScanFace, Smartphone, TrendingUp } from "lucide-react"
import {
  CartesianGrid, Cell, Line, LineChart, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts"
import { cn } from "@/lib/utils"
import { Avatar, CHART_TOOLTIP_STYLE, Chip, FV, Panel, StatusDot, WindowChrome } from "./chrome"
import type { ChipTone } from "./chrome"

/* ---------- data ---------- */
const SUMMARY: { label: string; value: number; tone: ChipTone; note: string }[] = [
  { label: "Present", value: 1189, tone: "emerald", note: "incl. 48 late" },
  { label: "Absent", value: 22, tone: "rose", note: "3 unnotified" },
  { label: "Late", value: 48, tone: "amber", note: "avg 14 min" },
  { label: "On Leave", value: 37, tone: "cyan", note: "8 casual · 29 sick/earned" },
]

const SHEET: { name: string; who: string; shift: string; in: string; out: string; ot: string; source: string; srcIcon: "device" | "mobile" | "selfie"; status: string; tone: ChipTone }[] = [
  { name: "Nusrat Jahan", who: "NJ", shift: "General 09:00", in: "08:58", out: "17:32", ot: "0.5", source: "Device", srcIcon: "device", status: "Present", tone: "emerald" },
  { name: "Arif Hossain", who: "AH", shift: "General 09:00", in: "09:12", out: "18:05", ot: "1.0", source: "Selfie", srcIcon: "selfie", status: "Late", tone: "amber" },
  { name: "Mahmudul Hasan", who: "MH", shift: "Evening 15:00", in: "15:02", out: "23:20", ot: "0.0", source: "Device", srcIcon: "device", status: "Present", tone: "emerald" },
  { name: "Sabrina Akter", who: "SA", shift: "General 09:00", in: "08:45", out: "17:10", ot: "0.0", source: "Mobile", srcIcon: "mobile", status: "Present", tone: "emerald" },
  { name: "Farhana Rahman", who: "FR", shift: "General 09:00", in: "—", out: "—", ot: "—", source: "—", srcIcon: "device", status: "On Leave", tone: "cyan" },
]

// October 2026 · P present · A absent · L leave · W weekend · T today
const DAYS: string[] = "PPWWPPPPWWPPPTPPWWPALPWWPPPPPW".split("")
const DAY_STYLE: Record<string, string> = {
  P: "bg-emerald-400/15 text-emerald-300 light:bg-emerald-500/10 light:text-emerald-700",
  A: "bg-rose-400/15 text-rose-300 light:bg-rose-500/10 light:text-rose-700",
  L: "bg-cyan-400/15 text-cyan-300 light:bg-cyan-500/10 light:text-cyan-700",
  W: "bg-white/5 text-slate-500 light:bg-slate-100 light:text-slate-400",
  T: "bg-indigo-500/25 text-indigo-200 ring-1 ring-indigo-400/50 light:bg-indigo-500/15 light:text-indigo-700",
}

const TREND_30: { d: string; pct: number }[] = Array.from({ length: 30 }, (_, i) => ({
  d: `${i + 1}`,
  pct: [94.2, 95.1, 95.8, 94.6, 96.2, 93.9, 92.8, 95.4, 96.0, 95.1, 94.7, 96.4, 95.2, 95.3, 94.9, 95.8, 96.1, 94.3, 93.7, 95.6, 96.2, 95.0, 94.4, 95.9, 96.3, 95.4, 94.8, 95.7, 96.0, 95.3][i],
}))

const SOURCES: { name: string; value: number }[] = [
  { name: "Device (ZKTeco)", value: 58 }, { name: "Mobile GPS", value: 26 }, { name: "Selfie", value: 16 },
]
const SOURCE_COLORS = [FV.indigo, FV.cyan, FV.violet]

function SourceIcon({ kind }: { kind: "device" | "mobile" | "selfie" }) {
  if (kind === "selfie") return <ScanFace className="h-2.5 w-2.5" />
  if (kind === "mobile") return <Smartphone className="h-2.5 w-2.5" />
  return <CalendarCheck className="h-2.5 w-2.5" />
}

/* ---------- floating selfie proof card ---------- */
function SelfieProof() {
  return (
    <div className="fv-float-a rotate-[-2deg] rounded-xl border border-white/15 bg-slate-900/95 p-3 shadow-xl shadow-black/40 light:border-slate-200 light:bg-white light:shadow-xl light:shadow-slate-900/15">
      <p className="flex items-center gap-1.5 text-[9px] font-bold uppercase tracking-widest text-slate-500">
        <Camera className="h-3 w-3 text-indigo-300 light:text-indigo-600" /> Selfie check-in proof
      </p>
      <div className="mt-2 flex items-center gap-2.5">
        <span className="relative flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-gradient-to-br from-indigo-500 to-violet-600 text-[13px] font-bold text-white">
          AH
          <span className="absolute inset-0 rounded-xl ring-1 ring-inset ring-white/20" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[11px] font-bold text-white light:text-slate-900">Arif Hossain</p>
          <p className="font-mono text-[9px] text-slate-500">2026-10-14 09:12:41</p>
          <p className="mt-0.5 flex items-center gap-1 text-[9px] text-slate-400 light:text-slate-600">
            <MapPin className="h-2.5 w-2.5 text-emerald-400 light:text-emerald-600" /> Gulshan-1 office · 12 m
          </p>
        </div>
      </div>
      <div className="mt-2 flex flex-wrap gap-1.5">
        <Chip tone="emerald"><CheckCircle2 className="h-2.5 w-2.5" /> Verified</Chip>
        <Chip tone="indigo">Face match 98.6%</Chip>
        <Chip tone="slate">Device · iPhone 15</Chip>
      </div>
    </div>
  )
}

/* ---------- the visual ---------- */
export function AttendanceVisual() {
  return (
    <WindowChrome
      title={<>finixhr.app — Attendance · 2026-10-14
        <span className="ml-2 inline-flex items-center gap-1 text-emerald-400 light:text-emerald-600">
          <StatusDot tone="emerald" pulse /> live sheet
        </span>
      </>}
    >
      <div className="space-y-3">
        {/* summary cards */}
        <div className="grid grid-cols-2 gap-2 lg:grid-cols-4 sm:gap-3">
          {SUMMARY.map((s) => (
            <div key={s.label} className="rounded-xl border border-white/10 bg-white/[0.03] p-2.5 light:border-slate-200 light:bg-white light:shadow-sm">
              <p className="flex items-center gap-1.5 text-[9px] font-bold uppercase tracking-widest text-slate-500">
                <StatusDot tone={s.tone} /> {s.label}
              </p>
              <p className="mt-1 text-lg font-bold tabular-nums leading-tight text-white light:text-slate-900">{s.value.toLocaleString()}</p>
              <p className="text-[9px] text-slate-500">{s.note}</p>
            </div>
          ))}
        </div>

        <div className="grid gap-3 lg:grid-cols-[1.35fr_240px]">
          <div className="min-w-0 space-y-3">
            <Panel title="Today · live sheet" icon={Clock} action={<Chip tone="emerald">auto-sync 12s</Chip>}>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[560px] text-left text-[10px]">
                  <thead>
                    <tr className="text-[9px] uppercase tracking-wider text-slate-500">
                      <th className="pb-1.5 font-semibold">Employee</th>
                      <th className="pb-1.5 font-semibold">Shift</th>
                      <th className="pb-1.5 font-semibold">In</th>
                      <th className="pb-1.5 font-semibold">Out</th>
                      <th className="pb-1.5 font-semibold">OT h</th>
                      <th className="pb-1.5 font-semibold">Source</th>
                      <th className="pb-1.5 text-right font-semibold">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {SHEET.map((r) => (
                      <tr key={r.name} className="border-t border-white/5 transition-colors hover:bg-white/[0.03] light:border-slate-100 light:hover:bg-slate-50">
                        <td className="py-1.5">
                          <span className="flex items-center gap-1.5">
                            <Avatar initials={r.who} className="h-5 w-5 text-[8px]" />
                            <span className="font-medium text-slate-200 light:text-slate-800">{r.name}</span>
                          </span>
                        </td>
                        <td className="py-1.5 text-slate-400 light:text-slate-600">{r.shift}</td>
                        <td className="py-1.5 font-mono tabular-nums text-slate-300 light:text-slate-700">{r.in}</td>
                        <td className="py-1.5 font-mono tabular-nums text-slate-300 light:text-slate-700">{r.out}</td>
                        <td className="py-1.5 tabular-nums text-slate-400 light:text-slate-600">{r.ot}</td>
                        <td className="py-1.5">
                          {r.source === "—" ? <span className="text-slate-600">—</span> : (
                            <Chip tone={r.srcIcon === "selfie" ? "violet" : r.srcIcon === "mobile" ? "cyan" : "indigo"}>
                              <SourceIcon kind={r.srcIcon} /> {r.source}
                            </Chip>
                          )}
                        </td>
                        <td className="py-1.5 text-right"><Chip tone={r.tone}>{r.status}</Chip></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Panel>

            <div className="grid gap-3 sm:grid-cols-2">
              <Panel title="Attendance trend · 30 days" icon={TrendingUp}>
                <div className="h-[130px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={TREND_30} margin={{ top: 4, right: 6, bottom: 0, left: -22 }}>
                      <CartesianGrid stroke="rgba(148,163,184,0.12)" vertical={false} />
                      <XAxis dataKey="d" tick={{ fontSize: 8, fill: "#94a3b8" }} stroke="rgba(148,163,184,0.15)" interval={4} tickLine={false} />
                      <YAxis domain={[90, 98]} tick={{ fontSize: 9, fill: "#94a3b8" }} stroke="rgba(148,163,184,0.15)" tickLine={false} axisLine={false} unit="%" width={30} />
                      <Tooltip contentStyle={CHART_TOOLTIP_STYLE} formatter={(v) => `${v}% present`} />
                      <Line type="monotone" dataKey="pct" stroke="#818cf8" strokeWidth={2} dot={false} name="Present" activeDot={{ r: 3 }} />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              </Panel>
              <Panel title="Check-in sources · today" icon={ScanFace}>
                <div className="relative h-[130px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie data={SOURCES} dataKey="value" nameKey="name" innerRadius={32} outerRadius={48} paddingAngle={3} strokeWidth={0}>
                        {SOURCES.map((s, i) => <Cell key={s.name} fill={SOURCE_COLORS[i]} />)}
                      </Pie>
                      <Tooltip contentStyle={CHART_TOOLTIP_STYLE} formatter={(v) => `${v}% of check-ins`} />
                    </PieChart>
                  </ResponsiveContainer>
                  <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
                    <span className="text-[10px] font-bold text-white light:text-slate-900">3,542</span>
                    <span className="text-[8px] uppercase tracking-widest text-slate-500">punches</span>
                  </div>
                </div>
                <div className="flex flex-wrap gap-x-3 gap-y-1">
                  {SOURCES.map((s, i) => (
                    <span key={s.name} className="flex items-center gap-1 text-[9px] text-slate-400 light:text-slate-600">
                      <span className="h-1.5 w-1.5 rounded-full" style={{ background: SOURCE_COLORS[i] }} /> {s.name} {s.value}%
                    </span>
                  ))}
                </div>
              </Panel>
            </div>
          </div>

          {/* right rail: selfie proof + month strip */}
          <div className="min-w-0 space-y-3">
            <SelfieProof />
            <Panel title="October 2026" icon={CalendarCheck}>
              <div className="grid grid-cols-7 gap-1 text-center">
                {["S", "M", "T", "W", "T", "F", "S"].map((dw, i) => (
                  <span key={`${dw}-${i}`} className="text-[8px] font-bold uppercase text-slate-600">{dw}</span>
                ))}
                {[0, 1, 2, 3].map((i) => <span key={`pad-${i}`} className="h-5" />)}
                {DAYS.map((d, i) => (
                  <span key={i} className={cn("flex h-5 items-center justify-center rounded text-[9px] font-medium tabular-nums", DAY_STYLE[d] ?? DAY_STYLE.P)}>
                    {i + 1}
                  </span>
                ))}
              </div>
              <div className="mt-2 flex flex-wrap gap-x-2.5 gap-y-1 text-[8px] text-slate-500">
                <span className="flex items-center gap-1"><span className="h-1.5 w-1.5 rounded-sm bg-emerald-400" /> Present</span>
                <span className="flex items-center gap-1"><span className="h-1.5 w-1.5 rounded-sm bg-rose-400" /> Absent</span>
                <span className="flex items-center gap-1"><span className="h-1.5 w-1.5 rounded-sm bg-cyan-400" /> Leave</span>
                <span className="flex items-center gap-1"><span className="h-1.5 w-1.5 rounded-sm bg-slate-500" /> Weekend</span>
              </div>
            </Panel>
          </div>
        </div>
      </div>
    </WindowChrome>
  )
}

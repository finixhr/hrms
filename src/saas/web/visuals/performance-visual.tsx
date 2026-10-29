"use client"
// ============ Visual 04 · Performance & KPI ============
// Review-cycle workflow (currently stage 3 of 4), a KPI radar for one employee,
// weighted score bars, a compact report card and the team review status list.
import { Award, Check, ClipboardCheck, Gauge, Star, Target, TrendingUp } from "lucide-react"
import type { LucideIcon } from "lucide-react"
import {
  PolarAngleAxis, PolarRadiusAxis, Radar, RadarChart, ResponsiveContainer, Tooltip,
} from "recharts"
import { cn } from "@/lib/utils"
import { Avatar, CHART_TOOLTIP_STYLE, Chip, Meter, Panel, StatusDot, WindowChrome } from "./chrome"
import type { ChipTone } from "./chrome"

/* ---------- data ---------- */
const RADAR: { subject: string; score: number }[] = [
  { subject: "Communication", score: 82 },
  { subject: "Delivery", score: 91 },
  { subject: "Quality", score: 88 },
  { subject: "Collaboration", score: 76 },
  { subject: "Leadership", score: 70 },
]

const WEIGHTED: { name: string; score: number; weight: number }[] = [
  { name: "Delivery", score: 91, weight: 30 },
  { name: "Quality", score: 88, weight: 25 },
  { name: "Collaboration", score: 76, weight: 20 },
]

type Stage = { label: string; meta: string; state: "done" | "active" | "todo" }
const STAGES: Stage[] = [
  { label: "Goal Setting", meta: "2026-09-05", state: "done" },
  { label: "Mid Review", meta: "09-26", state: "done" },
  { label: "Final Review", meta: "in progress", state: "active" },
  { label: "Calibration", meta: "starts Nov 04", state: "todo" },
]

const REVIEWS: { name: string; who: string; status: string; tone: ChipTone; due: string }[] = [
  { name: "Arif Hossain", who: "AH", status: "Complete", tone: "emerald", due: "—" },
  { name: "Nusrat Jahan", who: "NJ", status: "Calibrating", tone: "violet", due: "Oct 28" },
  { name: "Mahmudul Hasan", who: "MH", status: "In Review", tone: "indigo", due: "Oct 25" },
  { name: "Sabrina Akter", who: "SA", status: "In Review", tone: "indigo", due: "Oct 25" },
  { name: "Tanvir Alam", who: "TA", status: "Draft", tone: "slate", due: "Oct 22" },
]

const GOALS: { title: string; progress: number; due: string; tone: ChipTone }[] = [
  { title: "Close 42 renewals · Q4 pipeline", progress: 74, due: "Dec 31", tone: "indigo" },
  { title: "Cut ticket turnaround to 8h", progress: 88, due: "Nov 30", tone: "violet" },
  { title: "Onboard 6 new team members", progress: 50, due: "Nov 15", tone: "cyan" },
]

const DISTRIBUTION: { band: string; count: number; pct: number }[] = [
  { band: "4.5 – 5.0", count: 14, pct: 9 },
  { band: "4.0 – 4.4", count: 62, pct: 42 },
  { band: "3.5 – 3.9", count: 58, pct: 39 },
  { band: "3.0 – 3.4", count: 11, pct: 7 },
  { band: "below 3.0", count: 3, pct: 2 },
]

/* ---------- workflow strip ---------- */
function Workflow() {
  return (
    <div className="overflow-x-auto rounded-xl border border-white/10 bg-white/[0.03] p-2.5 light:border-slate-200 light:bg-white light:shadow-sm">
      <div className="flex min-w-[360px] items-center">
        {STAGES.map((s, i) => (
          <div key={s.label} className={cn("flex items-center", i < STAGES.length - 1 && "flex-1")}>
            <div className="flex items-center gap-2">
              <span className={cn(
                "flex h-7 w-7 shrink-0 items-center justify-center rounded-full border",
                s.state === "done" && "border-emerald-400/50 bg-emerald-400/15 text-emerald-300 light:text-emerald-600",
                s.state === "active" && "border-violet-400/60 bg-violet-500/20 text-violet-300 ring-2 ring-violet-400/30 light:text-violet-600",
                s.state === "todo" && "border-white/15 text-slate-500 light:border-slate-300",
              )}>
                {s.state === "done" ? <Check className="h-3.5 w-3.5" /> : s.state === "active" ? <StatusDot tone="violet" pulse /> : <span className="text-[10px] font-bold">{i + 1}</span>}
              </span>
              <div className="whitespace-nowrap">
                <p className={cn("text-[10px] font-bold", s.state === "todo" ? "text-slate-500" : "text-white light:text-slate-900")}>{s.label}</p>
                <p className="text-[8px] text-slate-500">{s.meta}</p>
              </div>
            </div>
            {i < STAGES.length - 1 && (
              <span className={cn("mx-2 h-px flex-1", s.state === "done" ? "bg-emerald-400/40" : "bg-white/10 light:bg-slate-200")} />
            )}
          </div>
        ))}
      </div>
      <p className="mt-1.5 text-[9px] text-slate-500">Review cycle 2026-H2 · stage 3 of 4 · 14 managers participating</p>
    </div>
  )
}

function KpiCard({ name, score, weight }: { name: string; score: number; weight: number }) {
  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.03] p-2.5 light:border-slate-200 light:bg-white light:shadow-sm">
      <div className="flex items-center justify-between">
        <p className="text-[10px] font-bold text-white light:text-slate-900">{name}</p>
        <Chip tone="slate">w {weight}%</Chip>
      </div>
      <p className="mt-1 text-lg font-bold tabular-nums leading-none text-violet-300 light:text-violet-600">{score}<span className="text-[10px] text-slate-500"> /100</span></p>
      <Meter value={score} tone="violet" className="mt-1.5" />
    </div>
  )
}

/* ---------- the visual ---------- */
export function PerformanceVisual() {
  return (
    <WindowChrome
      title={<>finixhr.app — Performance · Cycle 2026-H2
        <span className="ml-2 text-violet-300 light:text-violet-600">stage 3 / 4</span>
      </>}
      glow="bg-violet-600/20"
    >
      <div className="space-y-3">
        <Workflow />

        <div className="grid gap-3 lg:grid-cols-[1.15fr_1fr]">
          <div className="min-w-0 space-y-3">
            <Panel title="KPI radar · Sabrina Akter (Operations)" icon={Target} action={<Chip tone="violet">self + 2 peers</Chip>}>
              <div className="h-[220px]">
                <ResponsiveContainer width="100%" height="100%">
                  <RadarChart data={RADAR} outerRadius="72%">
                    <PolarAngleAxis dataKey="subject" tick={{ fontSize: 9, fill: "#94a3b8" }} />
                    <PolarRadiusAxis domain={[0, 100]} tick={false} axisLine={false} />
                    <Radar dataKey="score" stroke="#8b5cf6" fill="#8b5cf6" fillOpacity={0.35} strokeWidth={2} name="Score" />
                    <Tooltip contentStyle={CHART_TOOLTIP_STYLE} formatter={(v) => `${v} / 100`} />
                  </RadarChart>
                </ResponsiveContainer>
              </div>
            </Panel>

            <div className="grid grid-cols-3 gap-2 sm:gap-3">
              {WEIGHTED.map((k) => <KpiCard key={k.name} {...k} />)}
            </div>
          </div>

          <div className="min-w-0 space-y-3">
            <Panel title="Report card · 2026-H2" icon={Award}>
              <div className="flex items-center gap-2.5">
                <Avatar initials="SA" className="h-10 w-10 text-[11px]" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13px] font-bold text-white light:text-slate-900">Sabrina Akter</p>
                  <p className="truncate text-[10px] text-slate-500">Executive, Operations · EMP-1154</p>
                </div>
                <div className="text-right">
                  <p className="flex items-center gap-1 text-[15px] font-bold text-amber-300 light:text-amber-600">
                    <Star className="h-4 w-4 fill-amber-300 light:fill-amber-500" /> 4.2<span className="text-[10px] text-slate-500">/5</span>
                  </p>
                  <p className="flex items-center justify-end gap-1 text-[9px] font-semibold text-emerald-400 light:text-emerald-600">
                    <TrendingUp className="h-3 w-3" /> +0.3 vs H1
                  </p>
                </div>
              </div>
              <div className="mt-2.5 grid grid-cols-3 gap-2 text-center">
                {[
                  { v: "82", u: "weighted score", icon: Gauge },
                  { v: "Top 12%", u: "percentile", icon: Award },
                  { v: "91%", u: "goal attainment", icon: ClipboardCheck },
                ].map((m: { v: string; u: string; icon: LucideIcon }) => (
                  <div key={m.u} className="rounded-lg bg-white/[0.04] py-1.5 light:bg-slate-50">
                    <m.icon className="mx-auto h-3 w-3 text-violet-300 light:text-violet-600" />
                    <p className="mt-0.5 text-[12px] font-bold tabular-nums text-white light:text-slate-900">{m.v}</p>
                    <p className="text-[8px] uppercase tracking-wider text-slate-500">{m.u}</p>
                  </div>
                ))}
              </div>
            </Panel>

            <Panel title="Review status · team" icon={ClipboardCheck} action={<Chip tone="indigo">4 of 5 started</Chip>}>
              <ul className="space-y-1.5">
                {REVIEWS.map((r) => (
                  <li key={r.name} className="flex items-center gap-2 rounded-lg bg-white/[0.03] px-2 py-1.5 light:bg-slate-50">
                    <Avatar initials={r.who} className="h-5 w-5 text-[8px]" />
                    <span className="min-w-0 flex-1 truncate text-[10px] font-medium text-slate-300 light:text-slate-700">{r.name}</span>
                    <span className="shrink-0 text-[9px] text-slate-500">due {r.due}</span>
                    <Chip tone={r.tone}>{r.status}</Chip>
                  </li>
                ))}
              </ul>
            </Panel>

            <Panel title="Rating distribution · 148 rated" icon={Gauge}>
              <ul className="space-y-1.5">
                {DISTRIBUTION.map((d) => (
                  <li key={d.band}>
                    <div className="flex items-center justify-between text-[9px]">
                      <span className="font-mono text-slate-400 light:text-slate-600">{d.band}</span>
                      <span className="tabular-nums text-slate-500">{d.count} · {d.pct}%</span>
                    </div>
                    <Meter value={d.pct * 2.2} tone={d.band === "below 3.0" ? "rose" : "violet"} className="mt-0.5 h-1" />
                  </li>
                ))}
              </ul>
            </Panel>

            <Panel title="Goals · 2026-H2" icon={Target}>
              <ul className="space-y-2">
                {GOALS.map((g) => (
                  <li key={g.title}>
                    <div className="flex items-center justify-between gap-2 text-[10px]">
                      <span className="min-w-0 truncate font-medium text-slate-300 light:text-slate-700">{g.title}</span>
                      <span className="shrink-0 font-bold tabular-nums text-slate-200 light:text-slate-800">{g.progress}%</span>
                    </div>
                    <Meter value={g.progress} tone={g.tone} className="mt-1" />
                    <p className="mt-0.5 text-[8px] text-slate-500">due {g.due}</p>
                  </li>
                ))}
              </ul>
            </Panel>
          </div>
        </div>
      </div>
    </WindowChrome>
  )
}

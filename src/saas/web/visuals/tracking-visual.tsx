"use client"
// ============ Visual 02 · Live Employee Tracking ============
// Two panels: a stylized SVG city map (roads, blocks, river, geo-fence around
// HQ, pulsing field markers and one marker gliding along its route via CSS
// offset-path) and the live detail panel for the selected field technician.
import { BatteryMedium, Clock, History, MapPin, Navigation, Route, Wifi } from "lucide-react"
import { cn } from "@/lib/utils"
import { Avatar, Chip, Meter, Panel, StatusDot, WindowChrome } from "./chrome"
import type { ChipTone } from "./chrome"

/* ---------- stylized Dhaka map geometry (viewBox 400x300) ---------- */
const ROUTE_PATH = "M 40 238 L 196 238 L 196 148 L 268 148 L 268 118 L 348 118"
const RIVER_PATH = "M 0 40 C 70 24, 130 66, 200 52 S 320 18, 400 40"
const BLOCKS: [number, number, number, number][] = [
  [16, 72, 64, 34], [124, 74, 58, 30], [312, 76, 64, 28],
  [16, 130, 72, 28], [124, 128, 56, 28],
  [16, 182, 64, 32], [118, 182, 58, 30], [212, 182, 56, 30], [312, 184, 64, 28],
  [16, 248, 70, 30], [110, 250, 60, 26], [206, 248, 64, 30], [300, 250, 70, 26],
]

const MARKER_FILL: Record<string, string> = {
  indigo: "fill-indigo-500", violet: "fill-violet-500", cyan: "fill-cyan-500",
  amber: "fill-amber-400", slate: "fill-slate-500",
}

type FieldMarker = { x: number; y: number; tone: keyof typeof MARKER_FILL; label: string }
const STATIC_MARKERS: FieldMarker[] = [
  { x: 96, y: 92, tone: "violet", label: "S. Akter · field visit" },
  { x: 86, y: 172, tone: "cyan", label: "R. Karim · delivery" },
  { x: 286, y: 214, tone: "amber", label: "M. Hasan · idle 14m" },
  { x: 334, y: 58, tone: "slate", label: "K. Uddin · offline" },
]

const HISTORY: { time: string; place: string; note: string }[] = [
  { time: "11:22", place: "Mohakhali DOHS gate", note: "moving · 32 km/h" },
  { time: "10:52", place: "ABC Towers, Banani", note: "stop · 14 min" },
  { time: "10:08", place: "Banani Block-D junction", note: "passed" },
  { time: "09:35", place: "HQ · Gulshan-1", note: "departed" },
  { time: "09:02", place: "HQ · Gulshan-1", note: "selfie check-in" },
]

const LEGEND: { label: string; tone: ChipTone }[] = [
  { label: "Moving", tone: "indigo" },
  { label: "Idle", tone: "amber" },
  { label: "Offline", tone: "slate" },
]

function MapMarker({ m }: { m: FieldMarker }) {
  return (
    <g>
      <circle cx={m.x} cy={m.y} r={9} fillOpacity={0.35} className={cn(MARKER_FILL[m.tone], "fv-marker-pulse")} />
      <circle cx={m.x} cy={m.y} r={5.5} strokeWidth={1.5} className={cn(MARKER_FILL[m.tone], "stroke-white/70")} />
      <text x={m.x + 9} y={m.y + 2.5} fontSize={7} className="fill-slate-400 light:fill-slate-500">{m.label}</text>
    </g>
  )
}

function CityMap() {
  return (
    <div className="relative aspect-[4/3] w-full overflow-hidden rounded-xl border border-white/10 bg-slate-950 light:border-slate-200 light:bg-slate-100">
      <svg viewBox="0 0 400 300" className="h-full w-full" role="img" aria-label="Stylized live map of field employees around Gulshan, Dhaka">
        {/* river */}
        <path d={RIVER_PATH} className="fill-none stroke-cyan-400/15" strokeWidth={16} strokeLinecap="round" />
        <path d={RIVER_PATH} className="fill-none stroke-cyan-400/40" strokeWidth={1} strokeLinecap="round" strokeDasharray="8 6" />
        <text x={150} y={30} fontSize={7} className="fill-cyan-500/60">Hatirjheel</text>

        {/* city blocks */}
        {BLOCKS.map(([x, y, w, h], i) => (
          <rect key={i} x={x} y={y} width={w} height={h} rx={3} className={cn(i === 1 ? "fill-emerald-500/10" : "fill-slate-800 light:fill-slate-200", i === 1 && "stroke-emerald-400/25")} />
        ))}
        <text x={138} y={92} fontSize={6.5} className="fill-emerald-500/60">Gulshan Park</text>

        {/* roads */}
        <line x1={0} y1={118} x2={400} y2={118} className="stroke-slate-700 light:stroke-slate-300" strokeWidth={7} />
        <line x1={0} y1={170} x2={400} y2={170} className="stroke-slate-700 light:stroke-slate-300" strokeWidth={3.5} />
        <line x1={0} y1={236} x2={400} y2={236} className="stroke-slate-700 light:stroke-slate-300" strokeWidth={3.5} />
        <line x1={196} y1={0} x2={196} y2={300} className="stroke-slate-700 light:stroke-slate-300" strokeWidth={7} />
        <line x1={104} y1={0} x2={104} y2={300} className="stroke-slate-700 light:stroke-slate-300" strokeWidth={3.5} />
        <line x1={288} y1={0} x2={288} y2={300} className="stroke-slate-700 light:stroke-slate-300" strokeWidth={3.5} />
        <line x1={0} y1={118} x2={400} y2={118} className="stroke-amber-300/20" strokeWidth={1} strokeDasharray="10 8" />
        <text x={8} y={114} fontSize={7} className="fill-slate-500">Gulshan Ave</text>

        {/* geo-fence around HQ */}
        <circle cx={222} cy={148} r={50} className="fill-emerald-400/5 stroke-emerald-400/60" strokeWidth={1.5} strokeDasharray="5 4" />
        <g>
          <circle cx={222} cy={148} r={9} fillOpacity={0.4} className="fill-emerald-400 fv-marker-pulse" />
          <rect x={216} y={142} width={12} height={12} rx={3} strokeWidth={1.2} className="fill-emerald-500 stroke-white/80" />
          <text x={216} y={151.5} fontSize={6.5} className="fill-white font-bold">F</text>
          <text x={228} y={166} fontSize={7} className="fill-emerald-400/90">HQ · geofence</text>
        </g>

        {/* route + gliding marker (CSS offset-path, reduced-motion aware) */}
        <path d={ROUTE_PATH} className="fill-none stroke-indigo-400/60" strokeWidth={2} strokeLinecap="round" strokeDasharray="4 4" />
        <path d={ROUTE_PATH} className="fill-none stroke-indigo-300/60 fv-dash-flow" strokeWidth={2} strokeLinecap="round" strokeDasharray="4 4" />
        <g className="fv-route-marker" style={{ offsetPath: `path("${ROUTE_PATH}")` }}>
          <circle r={9} fillOpacity={0.35} className="fill-indigo-500 fv-marker-pulse" />
          <circle r={5.5} strokeWidth={1.5} className="fill-indigo-500 stroke-white/80" />
        </g>

        {/* static field markers */}
        {STATIC_MARKERS.map((m) => <MapMarker key={m.label} m={m} />)}
      </svg>

      {/* HTML overlays */}
      <span className="absolute left-2 top-2 inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-slate-950/80 px-2 py-1 text-[9px] font-bold text-slate-300 backdrop-blur light:border-slate-200 light:bg-white/80">
        <StatusDot tone="emerald" pulse /> LIVE · 5 tracked
      </span>
      <span className="absolute bottom-2 left-2 rounded bg-slate-950/70 px-1.5 py-0.5 font-mono text-[8px] text-slate-400 backdrop-blur light:bg-white/70">≈ 240 m</span>
      <span className="absolute right-2 top-2 flex flex-col overflow-hidden rounded-md border border-white/10 text-[10px] font-bold text-slate-400 light:border-slate-200">
        <span className="flex h-5 w-5 items-center justify-center bg-slate-950/80 light:bg-white/80">+</span>
        <span className="flex h-5 w-5 items-center justify-center bg-slate-950/80 light:bg-white/80">−</span>
      </span>
    </div>
  )
}

/* ---------- the visual ---------- */
export function TrackingVisual() {
  return (
    <WindowChrome
      title={<>finixhr.app — Live Tracking · Dhaka
        <span className="ml-2 inline-flex items-center gap-1 text-emerald-400 light:text-emerald-600">
          <StatusDot tone="emerald" pulse /> GPS stream
        </span>
      </>}
      glow="bg-cyan-600/20"
    >
      <div className="grid gap-3 lg:grid-cols-[1.25fr_1fr]">
        <div className="min-w-0 space-y-2">
          <CityMap />
          <div className="flex flex-wrap items-center gap-1.5">
            {LEGEND.map((l) => (
              <Chip key={l.label} tone={l.tone}>
                <StatusDot tone={l.tone} /> {l.label}
              </Chip>
            ))}
            <Chip tone="emerald">Dashed circle = geofence</Chip>
          </div>
        </div>

        {/* selected employee panel */}
        <div className="min-w-0 space-y-2.5">
          <Panel className="border-indigo-400/25 bg-indigo-500/[0.06] light:border-indigo-500/25 light:bg-indigo-500/5">
            <div className="flex items-center gap-2.5">
              <Avatar initials="TA" className="h-10 w-10 text-[11px]" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13px] font-bold text-white light:text-slate-900">Tanvir Alam</p>
                <p className="truncate text-[10px] text-slate-500">Field Technician · EMP-1077 · Support</p>
              </div>
              <Chip tone="indigo"><Navigation className="h-2.5 w-2.5" /> On route</Chip>
            </div>
            <div className="mt-2.5 grid grid-cols-2 gap-x-4 gap-y-2 text-[10px]">
              <div>
                <p className="flex items-center justify-between text-slate-400 light:text-slate-600">
                  <span className="flex items-center gap-1"><BatteryMedium className="h-3 w-3" /> Battery</span>
                  <span className="font-bold text-emerald-400 light:text-emerald-600">78%</span>
                </p>
                <Meter value={78} tone="emerald" className="mt-1" />
              </div>
              <div>
                <p className="flex items-center justify-between text-slate-400 light:text-slate-600">
                  <span className="flex items-center gap-1"><Wifi className="h-3 w-3" /> GPS</span>
                  <span className="font-bold text-emerald-400 light:text-emerald-600">Strong</span>
                </p>
                <p className="mt-1 text-[9px] text-slate-500">8 m accuracy · 5 s ping</p>
              </div>
            </div>
            <p className="mt-2 flex items-center gap-1.5 rounded-lg bg-white/[0.04] px-2 py-1.5 text-[9px] text-slate-400 light:bg-slate-100">
              <Clock className="h-3 w-3 shrink-0 text-indigo-300 light:text-indigo-600" />
              Last update 2 min ago · next ping in 3 s
            </p>
          </Panel>

          <Panel title="Location history" icon={History}>
            <ol className="relative ml-1.5 space-y-2 border-l border-dashed border-white/15 pl-3 light:border-slate-300">
              {HISTORY.map((h, i) => (
                <li key={h.time} className="relative">
                  <span className={cn(
                    "absolute -left-[17.5px] top-1 h-2 w-2 rounded-full",
                    i === 0 ? "bg-indigo-400 ring-2 ring-indigo-400/30" : "bg-slate-600 light:bg-slate-400",
                  )} />
                  <div className="flex items-baseline gap-2">
                    <span className="font-mono text-[9px] text-slate-500">{h.time}</span>
                    <span className="min-w-0 flex-1 truncate text-[10px] font-medium text-slate-300 light:text-slate-700">
                      <MapPin className="mr-1 inline h-2.5 w-2.5 text-slate-500" />{h.place}
                    </span>
                    <span className="shrink-0 text-[9px] text-slate-500">{h.note}</span>
                  </div>
                </li>
              ))}
            </ol>
          </Panel>

          <Panel title="Route stats · today" icon={Route}>
            <div className="grid grid-cols-3 gap-2 text-center">
              {[
                { v: "12.4", u: "km distance" },
                { v: "3", u: "stops" },
                { v: "1h 45", u: "m duration" },
              ].map((s) => (
                <div key={s.u} className="rounded-lg bg-white/[0.04] py-1.5 light:bg-slate-50">
                  <p className="text-[13px] font-bold tabular-nums text-white light:text-slate-900">{s.v}</p>
                  <p className="text-[8px] uppercase tracking-wider text-slate-500">{s.u}</p>
                </div>
              ))}
            </div>
          </Panel>
        </div>
      </div>
    </WindowChrome>
  )
}

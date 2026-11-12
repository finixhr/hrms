"use client"
// ============ Visual 09 · CCTV Camera Manager ============
// 2×3 grid of live-feed panels (CRT scanlines + a sweeping scan bar + mono
// timestamp overlay), status LEDs, brand badges, and the fleet-health /
// camera-info / recent-events rail. The feed stays dark in both themes — it
// depicts a night video signal.
import { Activity, AlertTriangle, Cctv, Database, Eye, HardDrive, Radio, Video, VideoOff } from "lucide-react"
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from "recharts"
import { CHART_TOOLTIP_STYLE, Chip, Meter, Panel, StatusDot, WindowChrome } from "./chrome"
import type { ChipTone } from "./chrome"

/* ---------- data ---------- */
type CamState = "online" | "offline" | "unknown"
const CAMERAS: { id: string; name: string; branch: string; brand: string; state: CamState; note?: string }[] = [
  { id: "CAM-01", name: "Main Gate", branch: "Gulshan", brand: "HIKVISION", state: "online" },
  { id: "CAM-02", name: "Reception", branch: "Gulshan", brand: "DAHUA", state: "online" },
  { id: "CAM-03", name: "Server Room", branch: "Uttara", brand: "EZVIZ", state: "offline", note: "Last seen 2h ago" },
  { id: "CAM-04", name: "Parking", branch: "Gulshan", brand: "IMOU", state: "online" },
  { id: "CAM-05", name: "Store Floor", branch: "Dhanmondi", brand: "HIKVISION", state: "online" },
  { id: "CAM-06", name: "Loading Bay", branch: "Dhanmondi", brand: "DAHUA", state: "unknown", note: "Awaiting discovery" },
]

const FLEET: { name: string; value: number }[] = [
  { name: "Online", value: 14 }, { name: "Offline", value: 2 }, { name: "Unknown", value: 1 },
]
const FLEET_COLORS = ["#10b981", "#f43f5e", "#64748b"]

const EVENTS: { time: string; text: string; tone: ChipTone }[] = [
  { time: "10:58", text: "Motion detected · CAM-01 Main Gate", tone: "indigo" },
  { time: "10:41", text: "Live stream started by hr.admin · CAM-02", tone: "cyan" },
  { time: "09:30", text: "Health check passed · 16 cameras", tone: "emerald" },
  { time: "08:12", text: "CAM-03 went offline · ISAPI timeout", tone: "rose" },
]

const STATE_META: Record<CamState, { led: ChipTone; label: string }> = {
  online: { led: "emerald", label: "ONLINE" },
  offline: { led: "rose", label: "OFFLINE" },
  unknown: { led: "slate", label: "UNKNOWN" },
}

const STREAM_STATS: [string, string][] = [
  ["Storage · 30d retention", "2.1 TB / 4 TB"],
  ["Aggregate bitrate", "14.6 Mbps"],
  ["Recordings today", "384 clips"],
  ["Motion alerts today", "17"],
]

/* ---------- one live-feed panel ---------- */
function CameraPanel({ cam }: { cam: typeof CAMERAS[number] }) {
  const meta = STATE_META[cam.state]
  const online = cam.state === "online"
  return (
    <div className="overflow-hidden rounded-xl border border-white/10 bg-white/[0.03] light:border-slate-200 light:bg-white light:shadow-sm">
      <div className="relative h-[92px] bg-gradient-to-br from-slate-950 to-slate-900 light:from-slate-900 light:to-slate-800">
        {/* stylized scene: doorway, floor, a silhouette */}
        <span className="absolute bottom-0 left-[12%] h-[70%] w-[26%] border border-white/10 border-b-0 bg-white/[0.02]" />
        <span className="absolute bottom-0 right-[16%] h-[55%] w-[10%] rounded-t-full bg-white/[0.04] blur-[1px]" />
        <span className="absolute bottom-[28%] right-[34%] h-[24%] w-[5%] rounded-t-full bg-white/[0.05] blur-[1px]" />
        <span className="absolute bottom-0 left-0 right-0 h-px bg-white/10" />
        {/* CRT scanlines */}
        <span className="absolute inset-0" style={{ backgroundImage: "repeating-linear-gradient(0deg, rgba(255,255,255,0.035) 0 1px, transparent 1px 3px)" }} />
        {/* sweeping scan bar */}
        {online && <span className="fv-scan absolute left-0 right-0 h-5 bg-gradient-to-b from-transparent via-white/[0.07] to-transparent" />}
        {/* overlays */}
        {cam.id === "CAM-01" && (
          <span className="absolute left-1.5 top-1.5 inline-flex items-center gap-1 rounded bg-rose-600/90 px-1.5 py-0.5 text-[8px] font-black tracking-widest text-white">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-white" /> LIVE
          </span>
        )}
        {online ? (
          <span className="absolute bottom-1.5 left-1.5 font-mono text-[8px] text-white/60">2026-10-14 11:02:41</span>
        ) : (
          <span className="absolute inset-0 flex items-center justify-center bg-slate-950/60">
            <span className="flex items-center gap-1.5 rounded-full border border-white/10 bg-slate-950/80 px-2.5 py-1 text-[9px] font-semibold text-slate-400">
              <VideoOff className="h-3 w-3" /> {cam.note ?? "No signal"}
            </span>
          </span>
        )}
        <span className="absolute bottom-1.5 right-1.5 font-mono text-[8px] text-white/40">{cam.id}</span>
      </div>
      <div className="flex items-center gap-1.5 p-2">
        <StatusDot tone={meta.led} pulse={online} />
        <span className="min-w-0 flex-1 truncate text-[10px] font-bold text-white light:text-slate-900">
          {cam.name}
          <span className="ml-1 font-normal text-slate-500">· {cam.branch}</span>
        </span>
        <Chip tone={online ? "emerald" : cam.state === "offline" ? "rose" : "slate"}>{cam.brand}</Chip>
      </div>
    </div>
  )
}

/* ---------- the visual ---------- */
export function CameraVisual() {
  return (
    <WindowChrome
      title={<>finixhr.app — Camera Manager · CCTV
        <span className="ml-2 inline-flex items-center gap-1 text-emerald-400 light:text-emerald-600">
          <StatusDot tone="emerald" pulse /> 14 / 17 online
        </span>
      </>}
      glow="bg-emerald-600/20"
    >
      <div className="grid gap-3 lg:grid-cols-[1fr_250px]">
        <div className="min-w-0">
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 sm:gap-3 xl:grid-cols-3">
            {CAMERAS.map((c) => <CameraPanel key={c.id} cam={c} />)}
          </div>
          <p className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[9px] text-slate-500">
            <span className="flex items-center gap-1"><StatusDot tone="emerald" /> online</span>
            <span className="flex items-center gap-1"><StatusDot tone="rose" /> offline</span>
            <span className="flex items-center gap-1"><StatusDot tone="slate" /> unknown</span>
            <span className="flex items-center gap-1"><Eye className="h-3 w-3" /> streams are permission-gated &amp; audit-logged</span>
          </p>
        </div>

        <div className="min-w-0 space-y-3">
          <Panel title="Fleet health · 17 cams" icon={Cctv}>
            <div className="relative h-[120px]">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie data={FLEET} dataKey="value" nameKey="name" innerRadius={30} outerRadius={46} paddingAngle={3} strokeWidth={0}>
                    {FLEET.map((f, i) => <Cell key={f.name} fill={FLEET_COLORS[i]} />)}
                  </Pie>
                  <Tooltip contentStyle={CHART_TOOLTIP_STYLE} formatter={(v) => `${v} cameras`} />
                </PieChart>
              </ResponsiveContainer>
              <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
                <span className="text-[13px] font-bold tabular-nums text-white light:text-slate-900">82%</span>
                <span className="text-[8px] uppercase tracking-widest text-slate-500">online</span>
              </div>
            </div>
            <div className="flex flex-wrap gap-x-3 gap-y-1">
              {FLEET.map((f, i) => (
                <span key={f.name} className="flex items-center gap-1 text-[9px] text-slate-400 light:text-slate-600">
                  <span className="h-1.5 w-1.5 rounded-full" style={{ background: FLEET_COLORS[i] }} />
                  {f.name} {f.value}
                </span>
              ))}
            </div>
          </Panel>

          <Panel title="Camera info · CAM-01" icon={HardDrive}>
            <dl className="space-y-1 text-[9px]">
              {[
                ["Model", "DS-2CD1043G0-I"],
                ["Serial", "DS2CD10···F3817"],
                ["Brand", "HIKVISION · ISAPI"],
                ["Installed", "2025-04-12"],
                ["Stream", "2304×1296 · 20 fps · H.265"],
              ].map(([k, v]) => (
                <div key={k} className="flex justify-between gap-2 rounded-md bg-white/[0.03] px-2 py-1 light:bg-slate-50">
                  <dt className="text-slate-500">{k}</dt>
                  <dd className="truncate font-mono font-medium text-slate-300 light:text-slate-700">{v}</dd>
                </div>
              ))}
            </dl>
          </Panel>

          <Panel title="Recent events" icon={Activity}>
            <ul className="space-y-1.5">
              {EVENTS.map((e) => (
                <li key={e.text} className="flex items-start gap-1.5">
                  <span className="mt-0.5 font-mono text-[8px] text-slate-500">{e.time}</span>
                  <StatusDot tone={e.tone} className="mt-1.5" />
                  <span className="min-w-0 flex-1 text-[9px] leading-snug text-slate-300 light:text-slate-600">{e.text}</span>
                </li>
              ))}
            </ul>
          </Panel>

          <Panel title="Streams & storage" icon={Database}>
            <dl className="space-y-1 text-[9px]">
              {STREAM_STATS.map(([k, v]) => (
                <div key={k} className="flex justify-between gap-2 rounded-md bg-white/[0.03] px-2 py-1 light:bg-slate-50">
                  <dt className="text-slate-500">{k}</dt>
                  <dd className="font-mono font-medium text-slate-300 light:text-slate-700">{v}</dd>
                </div>
              ))}
            </dl>
            <div className="mt-2">
              <p className="mb-1 flex justify-between text-[9px] text-slate-500">
                <span>Storage used</span><span className="tabular-nums">52%</span>
              </p>
              <Meter value={52} tone="emerald" />
            </div>
          </Panel>

          <div className="rounded-xl border border-amber-400/30 bg-amber-500/[0.06] p-2.5 light:border-amber-500/30 light:bg-amber-500/5">
            <p className="flex items-center gap-1.5 text-[10px] font-bold text-amber-300 light:text-amber-700">
              <AlertTriangle className="h-3.5 w-3.5" /> CAM-03 offline for 2h
            </p>
            <p className="mt-1 flex items-center gap-1 text-[9px] text-slate-500">
              <Radio className="h-3 w-3 shrink-0" /> Retry scheduled · on-call notified
            </p>
          </div>

          <p className="flex items-center gap-1.5 px-1 text-[9px] text-slate-500">
            <Video className="h-3 w-3 shrink-0 text-emerald-400 light:text-emerald-600" />
            Hikvision · Dahua · EZVIZ · Imou — one manager, per-tenant credentials encrypted at rest.
          </p>
        </div>
      </div>
    </WindowChrome>
  )
}

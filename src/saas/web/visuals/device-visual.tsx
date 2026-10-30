"use client"
// ============ Visual 06 · ZKTeco Attendance Device Integration ============
// Device cards with pulsing ONLINE dots, a live punch-event feed (rows slide
// in via fv-event-in), the PIN ↔ employee mapping, device health with a mono
// comm-log excerpt and the command queue. Push protocol path mirrors the real
// /iclock/cdata endpoints.
import { Check, Database, Radio, RefreshCw, Send, Terminal, Usb } from "lucide-react"
import { cn } from "@/lib/utils"
import { Avatar, Chip, Meter, Panel, StatusDot, WindowChrome } from "./chrome"
import type { ChipTone } from "./chrome"

/* ---------- data ---------- */
const DEVICES: { sn: string; branch: string; sync: string; events: number; state: "online" | "warning"; note: string }[] = [
  { sn: "A8C2-9F41", branch: "Gulshan HQ", sync: "12s ago", events: 431, state: "online", note: "push · comm key OK" },
  { sn: "B7D1-2K90", branch: "Uttara Branch", sync: "38s ago", events: 210, state: "online", note: "push · comm key OK" },
  { sn: "C9E4-7M55", branch: "Dhanmondi", sync: "4m ago", events: 96, state: "warning", note: "retrying · packet loss" },
]

const EVENTS: { time: string; pin: string; name: string; out: boolean }[] = [
  { time: "09:02:41", pin: "1042", name: "Arif Hossain", out: false },
  { time: "09:01:58", pin: "1087", name: "Nusrat Jahan", out: false },
  { time: "08:58:12", pin: "1123", name: "Mahmudul Hasan", out: false },
  { time: "08:57:44", pin: "1154", name: "Sabrina Akter", out: false },
  { time: "08:44:03", pin: "1077", name: "Tanvir Alam", out: false },
  { time: "23:59:57", pin: "1087", name: "Nusrat Jahan", out: true },
]

const MAPPING: { pin: string; emp: string; name: string; device: string }[] = [
  { pin: "1042", emp: "EMP-1042", name: "Arif Hossain", device: "A8C2-9F41" },
  { pin: "1087", emp: "EMP-1087", name: "Nusrat Jahan", device: "A8C2-9F41" },
  { pin: "1123", emp: "EMP-1123", name: "Mahmudul Hasan", device: "B7D1-2K90" },
  { pin: "1154", emp: "EMP-1154", name: "Sabrina Akter", device: "A8C2-9F41" },
]

const COMM_LOG: { line: string; ok: boolean }[] = [
  { line: "09:02:41 POST /iclock/cdata?SN=A8C2-9F41 → 200 · 48ms", ok: true },
  { line: "09:02:39 ATTLOG PIN=1042 status=0 verify=1", ok: true },
  { line: "09:01:12 devicecmd SetTime → ack 200", ok: true },
  { line: "09:00:58 POST /iclock/cdata?SN=C9E4-7M55 → 503 · retry 2/5", ok: false },
  { line: "08:58:03 heartbeat A8C2-9F41 rtt=23ms", ok: true },
]

const COMMANDS: { cmd: string; tone: ChipTone; state: string }[] = [
  { cmd: "GetUserInfo", tone: "indigo", state: "queued" },
  { cmd: "SetTime", tone: "emerald", state: "done ✓" },
  { cmd: "ClearLog", tone: "amber", state: "needs approval" },
]

/* ---------- the visual ---------- */
export function DeviceVisual() {
  return (
    <WindowChrome
      title={<>finixhr.app — Attendance Devices · ZKTeco ADMS
        <span className="ml-2 inline-flex items-center gap-1 text-emerald-400 light:text-emerald-600">
          <StatusDot tone="emerald" pulse /> 2 healthy · 1 warning
        </span>
      </>}
      glow="bg-blue-600/20"
    >
      <div className="grid gap-3 lg:grid-cols-[1fr_280px]">
        <div className="min-w-0 space-y-3">
          {/* device cards */}
          <div className="grid gap-2 sm:grid-cols-3 sm:gap-3">
            {DEVICES.map((d) => (
              <div key={d.sn} className={cn(
                "rounded-xl border p-2.5",
                d.state === "warning"
                  ? "border-amber-400/30 bg-amber-500/[0.06] light:border-amber-500/30 light:bg-amber-500/5"
                  : "border-white/10 bg-white/[0.03] light:border-slate-200 light:bg-white light:shadow-sm",
              )}>
                <div className="flex items-center gap-2">
                  <span className={cn(
                    "flex h-8 w-8 shrink-0 items-center justify-center rounded-lg",
                    d.state === "warning"
                      ? "bg-amber-500/15 text-amber-300 ring-1 ring-amber-400/30 light:text-amber-600"
                      : "bg-indigo-500/15 text-indigo-300 ring-1 ring-indigo-400/30 light:text-indigo-600",
                  )}>
                    <Usb className="h-4 w-4" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-mono text-[11px] font-bold text-white light:text-slate-900">SN {d.sn}</p>
                    <p className="truncate text-[9px] text-slate-500">ZKTeco K40 · {d.branch}</p>
                  </div>
                </div>
                <div className="mt-2 flex items-center justify-between">
                  <span className="flex items-center gap-1.5 text-[10px] font-bold text-slate-300 light:text-slate-700">
                    <StatusDot tone={d.state === "warning" ? "amber" : "emerald"} pulse /> {d.state === "warning" ? "WARNING" : "ONLINE"}
                  </span>
                  <span className="font-mono text-[9px] text-slate-500">sync {d.sync}</span>
                </div>
                <div className="mt-1.5 flex items-center justify-between text-[9px]">
                  <span className="text-slate-500">{d.events} events today</span>
                  <span className={d.state === "warning" ? "text-amber-400 light:text-amber-600" : "text-emerald-400 light:text-emerald-600"}>{d.note}</span>
                </div>
              </div>
            ))}
          </div>

          {/* live event feed */}
          <Panel
            title="Live punch events · A8C2-9F41"
            icon={Radio}
            action={<Chip tone="emerald"><StatusDot tone="emerald" pulse /> streaming</Chip>}
          >
            <ul className="space-y-1">
              {EVENTS.map((e, i) => (
                <li
                  key={`${e.pin}-${e.time}`}
                  className="fv-event-in flex items-center gap-2 rounded-lg bg-white/[0.03] px-2 py-1.5 font-mono text-[10px] light:bg-slate-50"
                  style={{ animationDelay: `${0.15 + i * 0.3}s` }}
                >
                  <span className="shrink-0 text-slate-500">{e.time}</span>
                  <Chip tone="slate" className="font-mono">PIN {e.pin}</Chip>
                  <span className="min-w-0 flex-1 truncate font-sans font-medium text-slate-300 light:text-slate-700">{e.name}</span>
                  <Chip tone={e.out ? "rose" : "emerald"}>{e.out ? "check-out" : "check-in"}</Chip>
                  <Check className="h-3 w-3 shrink-0 text-emerald-400 light:text-emerald-600" />
                </li>
              ))}
            </ul>
          </Panel>

          {/* mapping */}
          <Panel title="PIN ↔ employee mapping" icon={Database}>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[440px] text-left text-[10px]">
                <thead>
                  <tr className="text-[9px] uppercase tracking-wider text-slate-500">
                    <th className="pb-1.5 font-semibold">Device PIN</th>
                    <th className="pb-1.5 font-semibold">Employee code</th>
                    <th className="pb-1.5 font-semibold">Name</th>
                    <th className="pb-1.5 text-right font-semibold">Device SN</th>
                  </tr>
                </thead>
                <tbody>
                  {MAPPING.map((m) => (
                    <tr key={m.pin} className="border-t border-white/5 transition-colors hover:bg-white/[0.03] light:border-slate-100 light:hover:bg-slate-50">
                      <td className="py-1.5 font-mono font-bold text-indigo-300 light:text-indigo-600">{m.pin}</td>
                      <td className="py-1.5 font-mono text-slate-400 light:text-slate-600">{m.emp}</td>
                      <td className="py-1.5">
                        <span className="flex items-center gap-1.5 font-medium text-slate-200 light:text-slate-800">
                          <Avatar initials={m.name.split(" ").map((p) => p[0]).join("")} className="h-4 w-4 text-[7px]" />
                          {m.name}
                        </span>
                      </td>
                      <td className="py-1.5 text-right font-mono text-slate-400 light:text-slate-600">{m.device}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>
        </div>

        {/* right rail: health + commands */}
        <div className="min-w-0 space-y-3">
          <Panel title="Device health" icon={RefreshCw}>
            <div className="space-y-2 text-[10px]">
              <div>
                <p className="flex justify-between text-slate-400 light:text-slate-600">
                  <span>Fleet uptime · 30d</span><span className="font-bold text-emerald-400 light:text-emerald-600">99.2%</span>
                </p>
                <Meter value={99.2} tone="emerald" className="mt-1" />
              </div>
              <div className="flex justify-between rounded-md bg-white/[0.03] px-2 py-1 light:bg-slate-50">
                <span className="text-slate-400 light:text-slate-600">Reachability</span>
                <span className="font-medium text-slate-200 light:text-slate-800">3 / 3 devices · 1 degraded</span>
              </div>
              <div className="flex justify-between rounded-md bg-white/[0.03] px-2 py-1 light:bg-slate-50">
                <span className="text-slate-400 light:text-slate-600">Mode</span>
                <span className="font-medium text-emerald-300 light:text-emerald-700">push (ADMS) · no CSV</span>
              </div>
            </div>
            <p className="mt-2 flex items-center gap-1 text-[9px] font-bold uppercase tracking-widest text-slate-500">
              <Terminal className="h-3 w-3" /> comm log
            </p>
            <div className="scroll-thin mt-1 space-y-1 overflow-y-auto rounded-lg bg-slate-950/80 p-2 font-mono text-[9px] leading-relaxed light:bg-slate-900 light:text-slate-300">
              {COMM_LOG.map((l) => (
                <p key={l.line} className={l.ok ? "text-slate-400" : "text-amber-400 light:text-amber-500"}>
                  <span className="text-slate-600">▸</span> {l.line}
                </p>
              ))}
            </div>
          </Panel>

          <Panel title="Command queue" icon={Send}>
            <ul className="space-y-1.5">
              {COMMANDS.map((c) => (
                <li key={c.cmd} className="flex items-center gap-2 rounded-lg bg-white/[0.03] px-2 py-1.5 font-mono text-[10px] font-medium text-slate-300 light:bg-slate-50 light:text-slate-700">
                  {c.cmd}
                  <Chip tone={c.tone} className="ml-auto font-sans">{c.state}</Chip>
                </li>
              ))}
            </ul>
            <p className="mt-2 text-[9px] leading-relaxed text-slate-500">
              Destructive commands require a second approval — audit-logged end to end.
            </p>
          </Panel>
        </div>
      </div>
    </WindowChrome>
  )
}

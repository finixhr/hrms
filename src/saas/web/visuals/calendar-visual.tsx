"use client"
// ============ Visual · Company Calendar ============
// Month grid with holidays, events, birthdays and leave chips, plus the
// holiday management side panel with optional holidays.
import { Cake, CalendarDays, CalendarPlus, PartyPopper, Plane, Sparkles } from "lucide-react"
import { cn } from "@/lib/utils"
import { Chip, Panel, WindowChrome } from "./chrome"

/* ---------- data ---------- */
const DAYS = ["S", "M", "T", "W", "T", "F", "S"]
// kinds: h = holiday, e = event, b = birthday, l = leave, o = optional holiday
const CELLS: ({ d: string; kind?: "h" | "e" | "b" | "l" | "o"; label?: string } | null)[] = [
  null, { d: "1", kind: "h", label: "Ashura" }, { d: "2" }, { d: "3", kind: "l", label: "Arif · casual" }, { d: "4" }, { d: "5" }, { d: "6" },
  { d: "7", kind: "b", label: "Nusrat's birthday" }, { d: "8" }, { d: "9", kind: "e", label: "Town hall" }, { d: "10" }, { d: "11" }, { d: "12", kind: "l", label: "Sabrina · sick" }, { d: "13" },
  { d: "14" }, { d: "15", kind: "l", label: "Tanvir · earned" }, { d: "16" }, { d: "17", kind: "b", label: "Raihan's birthday" }, { d: "18", kind: "o", label: "Shab-e-Barat (optional)" }, { d: "19" }, { d: "20" },
  { d: "21" }, { d: "22" }, { d: "23", kind: "e", label: "Training day" }, { d: "24" }, { d: "25" }, { d: "26" }, { d: "27" },
  { d: "28" }, { d: "29", kind: "l", label: "Farhana · optional" }, { d: "30", kind: "b", label: "2 anniversaries" }, { d: "31", kind: "h", label: "Victory Day" },
]

const KIND_STYLES: Record<string, string> = {
  h: "border-rose-400/40 bg-rose-400/10 text-rose-200 light:text-rose-700",
  e: "border-indigo-400/40 bg-indigo-400/10 text-indigo-200 light:text-indigo-700",
  b: "border-violet-400/40 bg-violet-400/10 text-violet-200 light:text-violet-700",
  l: "border-cyan-400/40 bg-cyan-400/10 text-cyan-200 light:text-cyan-700",
  o: "border-amber-400/40 bg-amber-400/10 text-amber-200 light:text-amber-700",
}

const LEGEND: { k: string; label: string }[] = [
  { k: "h", label: "Holiday" },
  { k: "e", label: "Company event" },
  { k: "b", label: "Birthday / anniversary" },
  { k: "l", label: "On leave" },
  { k: "o", label: "Optional holiday" },
]

const HOLIDAY_ROWS: { name: string; date: string; scope: string }[] = [
  { name: "Ashura", date: "01 Dec", scope: "All branches" },
  { name: "Victory Day", date: "16 Dec", scope: "All branches" },
  { name: "Shab-e-Barat", date: "18 Dec", scope: "Optional · limit 2" },
  { name: "Durga Puja", date: "—", scope: "CTG branch only" },
]

export function CalendarVisual() {
  return (
    <WindowChrome title="finixhr.app · Company Calendar — December 2026" glow="bg-violet-600/20">
      <div className="grid gap-2.5 lg:grid-cols-5">
        {/* left — month grid */}
        <div className="lg:col-span-3">
          <Panel title="December 2026" icon={CalendarDays} action={<Chip tone="violet">4 marked days</Chip>}>
            <div className="grid grid-cols-7 gap-1">
              {DAYS.map((d, i) => (
                <div key={i} className="pb-0.5 text-center text-[8px] font-bold uppercase tracking-widest text-slate-500">{d}</div>
              ))}
              {CELLS.map((c, i) => (
                <div key={i} className={cn(
                  "min-h-[34px] rounded-md border p-1",
                  c === null ? "border-transparent"
                    : c.kind ? KIND_STYLES[c.kind]
                    : "border-white/10 bg-white/[0.02] light:border-slate-200 light:bg-slate-50",
                )}>
                  {c && (
                    <>
                      <p className="text-[9px] font-bold tabular-nums text-slate-200 light:text-slate-700">{c.d}</p>
                      {c.kind === "h" && <span className="block truncate text-[6px] font-semibold text-rose-300 light:text-rose-600">{c.label}</span>}
                      {c.kind === "e" && <span className="block truncate text-[6px] font-semibold text-indigo-300 light:text-indigo-600">{c.label}</span>}
                      {c.kind === "b" && <Cake className="h-2.5 w-2.5 text-violet-300" />}
                      {c.kind === "l" && <Plane className="h-2.5 w-2.5 text-cyan-300" />}
                      {c.kind === "o" && <span className="block truncate text-[6px] font-semibold text-amber-300 light:text-amber-600">optional</span>}
                    </>
                  )}
                </div>
              ))}
            </div>
            <div className="mt-1.5 flex flex-wrap gap-x-2.5 gap-y-1">
              {LEGEND.map((l) => (
                <span key={l.k} className="inline-flex items-center gap-1 text-[7px] text-slate-500">
                  <span className={cn("h-1.5 w-1.5 rounded-sm", KIND_STYLES[l.k].split(" ")[0])} />
                  {l.label}
                </span>
              ))}
            </div>
          </Panel>
        </div>

        {/* right — holiday management + today */}
        <div className="space-y-2.5 lg:col-span-2">
          <Panel title="Holiday calendar" icon={CalendarPlus} action={<Chip tone="emerald">BD defaults loaded</Chip>}>
            <ul className="space-y-1">
              {HOLIDAY_ROWS.map((h) => (
                <li key={h.name} className="flex items-center gap-2 rounded-lg bg-white/[0.03] px-2 py-1.5 light:bg-slate-50">
                  <span className="min-w-0 flex-1 truncate text-[9px] font-semibold text-slate-200 light:text-slate-700">{h.name}</span>
                  <span className="shrink-0 text-[8px] tabular-nums text-slate-500">{h.date}</span>
                  <span className="shrink-0 truncate text-[7px] text-slate-500">{h.scope}</span>
                </li>
              ))}
            </ul>
            <p className="mt-1.5 text-center text-[8px] text-slate-500">bulk import · branch-specific · optional limits</p>
          </Panel>
          <Panel title="Today · 18 Dec" icon={PartyPopper}>
            <div className="space-y-1.5">
              <div className="flex items-center gap-2 rounded-lg bg-violet-400/10 px-2 py-1.5">
                <Cake className="h-3.5 w-3.5 shrink-0 text-violet-300" />
                <div className="min-w-0">
                  <p className="truncate text-[9px] font-semibold text-violet-100 light:text-violet-800">Raihan Karim&apos;s birthday</p>
                  <p className="text-[7px] text-slate-400 light:text-slate-500">wish fires automatically (email + in-app)</p>
                </div>
              </div>
              <div className="flex items-center gap-2 rounded-lg bg-indigo-400/10 px-2 py-1.5">
                <Sparkles className="h-3.5 w-3.5 shrink-0 text-indigo-300" />
                <div className="min-w-0">
                  <p className="truncate text-[9px] font-semibold text-indigo-100 light:text-indigo-800">Shab-e-Barat — optional</p>
                  <p className="text-[7px] text-slate-400 light:text-slate-500">employees elect it against their 2-day quota</p>
                </div>
              </div>
            </div>
          </Panel>
        </div>
      </div>
    </WindowChrome>
  )
}

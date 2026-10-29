"use client"
// ============ Visual 08 · Leave & Self-Service ============
// Balance cards with meters, the requests table (Approved / Pending / Rejected
// with approver), the approval workflow strip, a floating ESS phone mock and
// the team-off calendar.
import { Bell, CalendarCheck, CalendarDays, FileText, Moon, Send, Smartphone, Users } from "lucide-react"
import { cn } from "@/lib/utils"
import { Avatar, Chip, Meter, Panel, StatusDot, WindowChrome } from "./chrome"
import type { ChipTone } from "./chrome"

/* ---------- data ---------- */
const BALANCES: { type: string; used: string; total: string; pct: number; tone: ChipTone }[] = [
  { type: "Casual", used: "8", total: "10 days", pct: 80, tone: "cyan" },
  { type: "Sick", used: "5", total: "14 days", pct: 36, tone: "rose" },
  { type: "Earned", used: "3.5", total: "18 days", pct: 19, tone: "violet" },
  { type: "Maternity", used: "—", total: "90 days", pct: 0, tone: "emerald" },
]

const REQUESTS: { name: string; who: string; type: string; range: string; days: string; status: string; tone: ChipTone; approver: string }[] = [
  { name: "Nusrat Jahan", who: "NJ", type: "Sick", range: "10-03 → 10-04", days: "2", status: "Approved", tone: "emerald", approver: "Manager, HR" },
  { name: "Arif Hossain", who: "AH", type: "Casual", range: "10-18 → 10-19", days: "2", status: "Pending", tone: "amber", approver: "Manager, Sales" },
  { name: "Sabrina Akter", who: "SA", type: "Earned", range: "09-28 → 09-30", days: "3", status: "Approved", tone: "emerald", approver: "Manager, Ops" },
  { name: "Tanvir Alam", who: "TA", type: "Casual", range: "10-25 → 10-27", days: "3", status: "Rejected", tone: "rose", approver: "Manager, Support" },
  { name: "Farhana Rahman", who: "FR", type: "Sick", range: "10-15 → 10-16", days: "2", status: "Pending", tone: "amber", approver: "Manager, HR" },
]

type Stage = { label: string; meta: string; state: "done" | "active" | "todo" }
const STAGES: Stage[] = [
  { label: "Applied", meta: "09:41 today", state: "done" },
  { label: "Manager", meta: "awaiting · 2h", state: "active" },
  { label: "HR", meta: "auto after", state: "todo" },
  { label: "Complete", meta: "balance updates", state: "todo" },
]

const ESS_MENU: { icon: typeof CalendarDays; label: string; badge?: string }[] = [
  { icon: CalendarDays, label: "My leaves", badge: "2" },
  { icon: Send, label: "Apply leave" },
  { icon: FileText, label: "My payslips", badge: "Sep ✓" },
  { icon: Bell, label: "Notifications", badge: "5" },
]

const OFF_TODAY: { who: string; name: string; note: string }[] = [
  { who: "NJ", name: "Nusrat Jahan", note: "Sick · back Wed" },
  { who: "RK", name: "Raihan Karim", note: "Casual · back Thu" },
]
const OFF_WEEK = ["MH", "SA", "TA", "FR", "AK", "SM"]

/* ---------- ESS phone mock (floating) ---------- */
function EssPhone() {
  return (
    <div className="fv-float-a mx-auto w-[172px] rotate-[-2deg] rounded-[26px] border border-white/15 bg-slate-950 p-2 shadow-2xl shadow-black/50 ring-1 ring-white/5 light:border-slate-300">
      <div className="mx-auto mb-1.5 h-1 w-10 rounded-full bg-white/20" />
      <div className="flex items-center justify-between px-1 text-[8px] text-slate-400">
        <span>9:41</span>
        <span className="flex items-center gap-1">GPS <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" /></span>
      </div>
      <div className="rounded-xl bg-gradient-to-b from-indigo-600/25 to-slate-900 p-2">
        <p className="text-[10px] font-bold text-white">Finix ESS</p>
        <p className="text-[7px] text-slate-400">Good morning, Arif</p>
      </div>
      <ul className="mt-1.5 space-y-1">
        {ESS_MENU.map((m) => (
          <li key={m.label} className="flex items-center gap-1.5 rounded-lg bg-white/[0.05] px-2 py-1.5">
            <m.icon className="h-3 w-3 text-indigo-300" />
            <span className="flex-1 text-[9px] font-medium text-slate-200">{m.label}</span>
            {m.badge && (
              <span className={cn(
                "rounded-full px-1 text-[7px] font-bold",
                m.badge === "Sep ✓" ? "bg-emerald-500/20 text-emerald-300" : "bg-indigo-500/30 text-indigo-200",
              )}>
                {m.badge}
              </span>
            )}
          </li>
        ))}
      </ul>
      <div className="mt-1.5 rounded-lg bg-white/[0.03] p-1.5 text-center">
        <p className="text-[7px] uppercase tracking-widest text-slate-500">leave balance</p>
        <p className="text-[11px] font-bold text-indigo-300">8 / 10 casual</p>
      </div>
    </div>
  )
}

/* ---------- the visual ---------- */
export function LeaveVisual() {
  return (
    <WindowChrome
      title={<>finixhr.app — Leave · Self-service
        <span className="ml-2 inline-flex items-center gap-1 text-amber-300 light:text-amber-600">
          <StatusDot tone="amber" pulse /> 2 awaiting
        </span>
      </>}
      glow="bg-cyan-600/20"
    >
      <div className="grid gap-3 lg:grid-cols-[1.3fr_200px]">
        <div className="min-w-0 space-y-3">
          {/* balances */}
          <div className="grid grid-cols-2 gap-2 lg:grid-cols-4 sm:gap-3">
            {BALANCES.map((b) => (
              <div key={b.type} className="rounded-xl border border-white/10 bg-white/[0.03] p-2.5 light:border-slate-200 light:bg-white light:shadow-sm">
                <p className="flex items-center gap-1 text-[9px] font-bold uppercase tracking-widest text-slate-500">
                  <Moon className="h-2.5 w-2.5" /> {b.type}
                </p>
                <p className="mt-1 text-[15px] font-bold tabular-nums leading-tight text-white light:text-slate-900">
                  {b.used}<span className="text-[10px] font-medium text-slate-500"> / {b.total}</span>
                </p>
                <Meter value={b.pct} tone={b.tone} className="mt-1.5" />
              </div>
            ))}
          </div>

          {/* requests */}
          <Panel title="Leave requests" icon={CalendarCheck} action={<Chip tone="slate">window: 2026</Chip>}>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[560px] text-left text-[10px]">
                <thead>
                  <tr className="text-[9px] uppercase tracking-wider text-slate-500">
                    <th className="pb-1.5 font-semibold">Employee</th>
                    <th className="pb-1.5 font-semibold">Type</th>
                    <th className="pb-1.5 font-semibold">From → to</th>
                    <th className="pb-1.5 font-semibold">Days</th>
                    <th className="pb-1.5 font-semibold">Approver</th>
                    <th className="pb-1.5 text-right font-semibold">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {REQUESTS.map((r) => (
                    <tr key={`${r.name}-${r.range}`} className="border-t border-white/5 transition-colors hover:bg-white/[0.03] light:border-slate-100 light:hover:bg-slate-50">
                      <td className="py-1.5">
                        <span className="flex items-center gap-1.5">
                          <Avatar initials={r.who} className="h-5 w-5 text-[8px]" />
                          <span className="font-medium text-slate-200 light:text-slate-800">{r.name}</span>
                        </span>
                      </td>
                      <td className="py-1.5"><Chip tone={r.tone === "rose" ? "rose" : "slate"}>{r.type}</Chip></td>
                      <td className="py-1.5 font-mono tabular-nums text-slate-400 light:text-slate-600">{r.range}</td>
                      <td className="py-1.5 tabular-nums text-slate-300 light:text-slate-700">{r.days}</td>
                      <td className="py-1.5 text-slate-500">{r.approver}</td>
                      <td className="py-1.5 text-right"><Chip tone={r.tone}>{r.status}</Chip></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>

          {/* approval workflow */}
          <div className="overflow-x-auto rounded-xl border border-white/10 bg-white/[0.03] p-2.5 light:border-slate-200 light:bg-white light:shadow-sm">
            <p className="mb-2 flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-widest text-slate-500">
              <Send className="h-3 w-3" /> Approval workflow · request #LVR-2102 (A. Hossain)
            </p>
            <div className="flex min-w-[330px] items-center">
              {STAGES.map((s, i) => (
                <div key={s.label} className={cn("flex items-center", i < STAGES.length - 1 && "flex-1")}>
                  <div className="flex items-center gap-1.5">
                    <span className={cn(
                      "flex h-5 w-5 items-center justify-center rounded-full border text-[9px] font-bold",
                      s.state === "done" && "border-emerald-400/50 bg-emerald-400/15 text-emerald-300 light:text-emerald-600",
                      s.state === "active" && "border-amber-400/60 bg-amber-500/20 text-amber-300 ring-2 ring-amber-400/30 light:text-amber-600",
                      s.state === "todo" && "border-white/15 text-slate-500 light:border-slate-300",
                    )}>
                      {s.state === "active" ? <StatusDot tone="amber" pulse /> : i + 1}
                    </span>
                    <div>
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
          </div>
        </div>

        {/* right rail: ESS phone + team calendar */}
        <div className="min-w-0 space-y-3">
          <EssPhone />
          <Panel title="Team off · today" icon={Users}>
            <ul className="space-y-1.5">
              {OFF_TODAY.map((o) => (
                <li key={o.name} className="flex items-center gap-2">
                  <Avatar initials={o.who} className="h-6 w-6 text-[8px]" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[10px] font-medium text-slate-300 light:text-slate-700">{o.name}</p>
                    <p className="truncate text-[9px] text-slate-500">{o.note}</p>
                  </div>
                </li>
              ))}
            </ul>
            <p className="mt-2 text-[9px] font-bold uppercase tracking-widest text-slate-500">This week · 6 away</p>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {OFF_WEEK.map((w) => <Avatar key={w} initials={w} className="h-6 w-6 text-[8px] opacity-80" />)}
            </div>
          </Panel>
          <p className="flex items-center gap-1.5 px-1 text-[9px] text-slate-500">
            <Smartphone className="h-3 w-3 shrink-0 text-cyan-400 light:text-cyan-600" />
            Employees apply, track and see balances themselves — HR stops chasing paper.
          </p>
        </div>
      </div>
    </WindowChrome>
  )
}

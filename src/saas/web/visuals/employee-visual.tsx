"use client"
// ============ Visual 07 · Employee 360° Profile ============
// Profile header with tab strip, a Personal-details field grid, floating
// document / bank cards, and the immutable lifecycle timeline below — every
// event carries an actor, a date and a lock (append-only trail).
import {
  ArrowLeftRight, Banknote, Briefcase, Building2, CalendarCheck, FileText,
  IdCard, Lock, ShieldCheck, TrendingUp, UserPlus, Users,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { Avatar, Chip, Panel, StatusDot, WindowChrome } from "./chrome"
import type { ChipTone } from "./chrome"

/* ---------- data ---------- */
const TABS = ["Personal", "Family", "Education", "Employment", "Documents", "Bank"]

const FIELDS: { label: string; value: string; span?: boolean }[] = [
  { label: "Full name", value: "Arif Hossain" },
  { label: "Date of birth", value: "1994-03-18" },
  { label: "Father name", value: "Md. Anwar Hossain" },
  { label: "National ID (NID)", value: "•••• •••• 5621" },
  { label: "Phone", value: "+880 1712 45••89" },
  { label: "Email", value: "arif.hossain@finixhr.app" },
  { label: "Blood group", value: "B+" },
  { label: "Marital status", value: "Married" },
  { label: "Present address", value: "House 42, Road 11, Banani, Dhaka 1213", span: true },
  { label: "Permanent address", value: "Vill. Shibpur, Dist. Narsingdi", span: true },
  { label: "Emergency contact", value: "Nasrin Hossain (spouse) · +880 1819 22••54", span: true },
]

const DOCUMENTS: { name: string; meta: string; state: string; tone: ChipTone }[] = [
  { name: "National ID (NID)", meta: "verified 2021-06-02", state: "verified", tone: "emerald" },
  { name: "Passport", meta: "expires 2026-11-30", state: "47d", tone: "amber" },
  { name: "Employment contract", meta: "signed 2021-06-01", state: "signed", tone: "indigo" },
]

const LIFECYCLE: { icon: typeof UserPlus; title: string; date: string; actor: string; detail: string; tone: ChipTone }[] = [
  { icon: UserPlus, title: "Joined", date: "2021-06-01", actor: "hr.admin", detail: "Onboarded as Executive, Sales · Gulshan HQ", tone: "indigo" },
  { icon: ArrowLeftRight, title: "Transfer", date: "2022-11-14", actor: "hr.admin", detail: "Uttara Branch → Gulshan HQ", tone: "cyan" },
  { icon: TrendingUp, title: "Promotion", date: "2023-06-01", actor: "ceo (approver)", detail: "Executive → Senior Executive, Sales", tone: "violet" },
  { icon: Banknote, title: "Salary revision", date: "2024-01-01", actor: "finance.manager", detail: "৳ 68,000 → ৳ 82,000 gross", tone: "amber" },
  { icon: CalendarCheck, title: "Leave encashment", date: "2024-09-20", actor: "hr.officer", detail: "4.0 casual days encashed", tone: "emerald" },
  { icon: ShieldCheck, title: "Status change", date: "2025-08-01", actor: "hr.admin", detail: "Probation completed → ACTIVE", tone: "rose" },
]

const SNAPSHOTS: { label: string; value: string; note: string }[] = [
  { label: "Tenure", value: "4y 4m", note: "since 2021-06-01" },
  { label: "Leave balance", value: "8 / 10", note: "casual · 3.5 earned" },
  { label: "Last appraisal", value: "4.2 / 5", note: "2026-H1 · +0.3" },
  { label: "Attendance", value: "96.8%", note: "last 90 days" },
]

const TONE_RING: Record<ChipTone, string> = {
  emerald: "bg-emerald-500/15 text-emerald-300 ring-emerald-400/40 light:bg-emerald-500/10 light:text-emerald-600",
  amber: "bg-amber-500/15 text-amber-300 ring-amber-400/40 light:bg-amber-500/10 light:text-amber-600",
  rose: "bg-rose-500/15 text-rose-300 ring-rose-400/40 light:bg-rose-500/10 light:text-rose-600",
  slate: "bg-slate-500/15 text-slate-300 ring-slate-400/40 light:bg-slate-400/10 light:text-slate-600",
  indigo: "bg-indigo-500/15 text-indigo-300 ring-indigo-400/40 light:bg-indigo-500/10 light:text-indigo-600",
  cyan: "bg-cyan-500/15 text-cyan-300 ring-cyan-400/40 light:bg-cyan-500/10 light:text-cyan-600",
  violet: "bg-violet-500/15 text-violet-300 ring-violet-400/40 light:bg-violet-500/10 light:text-violet-600",
}

/* ---------- the visual ---------- */
export function EmployeeVisual() {
  return (
    <WindowChrome
      title={<>finixhr.app — Employee 360° · EMP-1042
        <span className="ml-2 text-emerald-400 light:text-emerald-600">immutable trail</span>
      </>}
    >
      <div className="space-y-3">
        {/* profile header */}
        <div className="rounded-xl border border-white/10 bg-white/[0.03] p-3 light:border-slate-200 light:bg-white light:shadow-sm">
          <div className="flex flex-wrap items-center gap-3">
            <Avatar initials="AH" className="h-12 w-12 text-[14px]" />
            <div className="min-w-0 flex-1">
              <p className="flex flex-wrap items-center gap-2 text-[14px] font-bold text-white light:text-slate-900">
                Arif Hossain <Chip tone="emerald"><StatusDot tone="emerald" pulse /> active</Chip>
              </p>
              <p className="text-[11px] text-slate-500">EMP-1042 · Senior Executive, Sales · joined 2021-06-01</p>
              <div className="mt-1 flex flex-wrap gap-1.5">
                <Chip tone="indigo"><Briefcase className="h-2.5 w-2.5" /> Sales dept</Chip>
                <Chip tone="cyan"><Building2 className="h-2.5 w-2.5" /> Gulshan HQ</Chip>
                <Chip tone="violet"><Users className="h-2.5 w-2.5" /> reports to Manager, Sales</Chip>
              </div>
            </div>
            <div className="flex gap-1.5">
              <span className="inline-flex items-center gap-1 rounded-lg bg-gradient-to-r from-blue-600 to-violet-600 px-2.5 py-1 text-[10px] font-semibold text-white shadow-lg shadow-indigo-950/40">
                <FileText className="h-3 w-3" /> HR letter
              </span>
              <span className="inline-flex items-center gap-1 rounded-lg border border-white/15 px-2.5 py-1 text-[10px] font-semibold text-slate-300 light:border-slate-300 light:text-slate-700">
                <IdCard className="h-3 w-3" /> ID card
              </span>
            </div>
          </div>
          {/* tab strip */}
          <div className="scroll-thin mt-3 flex gap-1 overflow-x-auto">
            {TABS.map((t) => (
              <span key={t} className={cn(
                "shrink-0 rounded-lg px-2.5 py-1 text-[10px] font-semibold",
                t === "Personal"
                  ? "bg-indigo-500/20 text-indigo-200 ring-1 ring-indigo-400/40 light:bg-indigo-500/10 light:text-indigo-600"
                  : "text-slate-500 light:text-slate-500",
              )}>
                {t}
              </span>
            ))}
          </div>
        </div>

        {/* reporting chain */}
        <div className="flex items-center gap-2 overflow-x-auto rounded-xl border border-white/10 bg-white/[0.03] px-2.5 py-2 light:border-slate-200 light:bg-white light:shadow-sm">
          <span className="shrink-0 text-[9px] font-bold uppercase tracking-widest text-slate-500">Reports to</span>
          {[
            { who: "SA", name: "Director, Sales" },
            { who: "MR", name: "Manager, Sales" },
            { who: "AH", name: "Arif Hossain" },
          ].map((c, i) => (
            <span key={c.name} className="flex shrink-0 items-center gap-1.5">
              {i > 0 && <span className="text-slate-600">→</span>}
              <Avatar initials={c.who} className={cn("h-5 w-5 text-[8px]", i === 2 && "ring-2 ring-indigo-400/50")} />
              <span className={cn(
                "text-[10px] font-medium",
                i === 2 ? "text-indigo-300 light:text-indigo-600" : "text-slate-400 light:text-slate-600",
              )}>
                {c.name}{i === 2 ? " (this profile)" : ""}
              </span>
            </span>
          ))}
        </div>

        {/* snapshot strip */}
        <div className="grid grid-cols-2 gap-2 lg:grid-cols-4 sm:gap-3">
          {SNAPSHOTS.map((s) => (
            <div key={s.label} className="rounded-xl border border-white/10 bg-white/[0.03] p-2.5 light:border-slate-200 light:bg-white light:shadow-sm">
              <p className="text-[9px] font-bold uppercase tracking-widest text-slate-500">{s.label}</p>
              <p className="mt-1 text-[15px] font-bold tabular-nums leading-tight text-white light:text-slate-900">{s.value}</p>
              <p className="text-[9px] text-slate-500">{s.note}</p>
            </div>
          ))}
        </div>

        {/* fields + floating cards */}
        <div className="grid gap-3 lg:grid-cols-[1.3fr_240px]">
          <Panel title="Personal details" icon={IdCard} action={<Chip tone="slate">6 sections</Chip>}>
            <dl className="grid grid-cols-1 gap-x-4 gap-y-2 sm:grid-cols-2">
              {FIELDS.map((f) => (
                <div key={f.label} className={cn(f.span && "sm:col-span-2")}>
                  <dt className="text-[8px] font-bold uppercase tracking-widest text-slate-500">{f.label}</dt>
                  <dd className="mt-0.5 truncate text-[11px] font-medium text-slate-200 light:text-slate-800">{f.value}</dd>
                </div>
              ))}
            </dl>
          </Panel>

          <div className="min-w-0 space-y-3">
            <Panel title="Documents" icon={FileText} action={<Chip tone="amber">1 expiring</Chip>}>
              <ul className="space-y-1.5">
                {DOCUMENTS.map((d) => (
                  <li key={d.name} className="flex items-center gap-2 rounded-lg bg-white/[0.03] px-2 py-1.5 light:bg-slate-50">
                    <FileText className="h-3.5 w-3.5 shrink-0 text-slate-500" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[10px] font-medium text-slate-300 light:text-slate-700">{d.name}</p>
                      <p className="truncate text-[9px] text-slate-500">{d.meta}</p>
                    </div>
                    <Chip tone={d.tone}>{d.state}</Chip>
                  </li>
                ))}
              </ul>
            </Panel>

            <div className="fv-float-b rotate-[1.5deg] rounded-xl border border-white/15 bg-slate-900/95 p-3 shadow-xl shadow-black/40 light:border-slate-200 light:bg-white light:shadow-xl light:shadow-slate-900/15">
              <p className="flex items-center gap-1.5 text-[9px] font-bold uppercase tracking-widest text-slate-500">
                <Banknote className="h-3 w-3 text-emerald-400 light:text-emerald-600" /> Bank account
              </p>
              <p className="mt-1.5 text-[12px] font-bold text-white light:text-slate-900">City Bank PLC</p>
              <p className="font-mono text-[10px] text-slate-400 light:text-slate-600">salary a/c •••• 4523</p>
              <div className="mt-2 flex gap-1.5">
                <Chip tone="emerald">primary</Chip>
                <Chip tone="slate">verified</Chip>
              </div>
            </div>
          </div>
        </div>

        {/* lifecycle timeline */}
        <Panel title="Lifecycle · immutable trail" icon={Lock} action={<Chip tone="slate">append-only</Chip>}>
          <ol className="relative ml-2 space-y-3 border-l border-dashed border-white/15 pl-4 light:border-slate-300">
            {LIFECYCLE.map((e) => (
              <li key={`${e.title}-${e.date}`} className="relative">
                <span className={cn(
                  "absolute -left-[26px] top-0 flex h-6 w-6 items-center justify-center rounded-full ring-1",
                  TONE_RING[e.tone],
                )}>
                  <e.icon className="h-3 w-3" />
                </span>
                <div className="rounded-lg bg-white/[0.03] px-2.5 py-2 light:bg-slate-50">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <p className="text-[11px] font-bold text-white light:text-slate-900">{e.title}</p>
                    <span className="font-mono text-[9px] text-slate-500">{e.date}</span>
                    <span className="text-[9px] text-slate-500">by {e.actor}</span>
                    <span className="ml-auto flex items-center gap-1 text-[8px] font-bold uppercase tracking-wider text-slate-500">
                      <Lock className="h-2.5 w-2.5" /> immutable
                    </span>
                  </div>
                  <p className="mt-0.5 text-[10px] text-slate-400 light:text-slate-600">{e.detail}</p>
                </div>
              </li>
            ))}
          </ol>
        </Panel>
      </div>
    </WindowChrome>
  )
}

"use client"
// ============ Visual · Exit & Offboarding ============
// Resignation timeline, the full & final settlement sheet, and the offboarding
// checklist with automatic device deactivation.
import { BadgeCheck, CalendarX, DoorOpen, Fingerprint, Landmark, LogOut, Wallet } from "lucide-react"
import { cn } from "@/lib/utils"
import { Avatar, Chip, Panel, StatusDot, WindowChrome } from "./chrome"
import type { ChipTone } from "./chrome"

/* ---------- data ---------- */
const TIMELINE: { label: string; meta: string; state: "done" | "active" | "todo" }[] = [
  { label: "Resigned (ESS)", meta: "02 Oct · notice 30d", state: "done" },
  { label: "Reviewed by HR", meta: "negotiated LWD 30 Oct", state: "done" },
  { label: "Clearance", meta: "3 of 4 signed", state: "active" },
  { label: "Settlement paid", meta: "scheduled 01 Nov", state: "todo" },
]

const SETTLEMENT: { item: string; amount: string; sign: "+" | "−"; tone: ChipTone }[] = [
  { item: "Salary — Oct (prorated 30d)", amount: "৳48,200", sign: "+", tone: "emerald" },
  { item: "Leave encashment · 6.5 days", amount: "৳11,375", sign: "+", tone: "emerald" },
  { item: "Provident fund payout", amount: "৳36,900", sign: "+", tone: "emerald" },
  { item: "Loan outstanding · 2 installments", amount: "৳8,400", sign: "−", tone: "rose" },
]

const CHECKLIST: { label: string; done: boolean }[] = [
  { label: "Asset return — laptop, ID card", done: true },
  { label: "Accounts clearance", done: true },
  { label: "Department handover notes", done: true },
  { label: "Exit interview", done: false },
]

export function ExitVisual() {
  return (
    <WindowChrome title="finixhr.app · Exit Management" glow="bg-rose-600/20">
      <div className="grid gap-2.5 lg:grid-cols-5">
        {/* left — resignation card + timeline */}
        <div className="space-y-2.5 lg:col-span-2">
          <Panel title="Resignation in notice" icon={LogOut} action={<Chip tone="amber">LWD 30 Oct</Chip>}>
            <div className="flex items-center gap-2">
              <Avatar initials="FR" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-[10px] font-bold text-slate-100 light:text-slate-800">Farhana Rahman</p>
                <p className="truncate text-[8px] text-slate-500">Executive, Support · since Mar 2023</p>
              </div>
              <Chip tone="rose">NOTICE</Chip>
            </div>
            <div className="mt-2 rounded-lg border border-white/10 bg-white/[0.03] p-2 text-center light:border-slate-200 light:bg-slate-50">
              <p className="text-[8px] uppercase tracking-widest text-slate-500">days remaining</p>
              <p className="text-lg font-black tabular-nums text-rose-300 light:text-rose-600">4</p>
              <p className="text-[7px] text-slate-500">proposed 02 Nov → accepted 30 Oct</p>
            </div>
          </Panel>
          <Panel title="Process" icon={DoorOpen}>
            <ol className="space-y-1.5">
              {TIMELINE.map((t) => (
                <li key={t.label} className="flex items-center gap-2">
                  <StatusDot tone={t.state === "done" ? "emerald" : t.state === "active" ? "amber" : "slate"} pulse={t.state === "active"} />
                  <span className="text-[9px] font-semibold text-slate-200 light:text-slate-700">{t.label}</span>
                  <span className="ml-auto truncate text-[8px] text-slate-500">{t.meta}</span>
                </li>
              ))}
            </ol>
          </Panel>
        </div>

        {/* right — settlement + offboarding */}
        <div className="space-y-2.5 lg:col-span-3">
          <Panel title="Full & final settlement" icon={Wallet} action={<Chip tone="indigo">Draft</Chip>}>
            <ul className="space-y-1">
              {SETTLEMENT.map((s) => (
                <li key={s.item} className="flex items-center gap-2 rounded-lg bg-white/[0.03] px-2 py-1.5 light:bg-slate-50">
                  <span className={cn("text-[10px] font-black tabular-nums", s.sign === "+" ? "text-emerald-400" : "text-rose-400")}>{s.sign}</span>
                  <span className="min-w-0 flex-1 truncate text-[9px] text-slate-300 light:text-slate-600">{s.item}</span>
                  <span className="text-[9px] font-bold tabular-nums text-slate-100 light:text-slate-800">{s.amount}</span>
                </li>
              ))}
            </ul>
            <div className="mt-1.5 flex items-center justify-between rounded-lg border border-indigo-400/30 bg-indigo-400/10 px-2 py-1.5">
              <span className="inline-flex items-center gap-1 text-[9px] font-bold text-indigo-200 light:text-indigo-700"><Landmark className="h-3 w-3" /> Net payable</span>
              <span className="text-[11px] font-black tabular-nums text-indigo-200 light:text-indigo-700">৳88,075</span>
            </div>
          </Panel>
          <div className="grid grid-cols-2 gap-2.5">
            <Panel title="Clearance" icon={BadgeCheck}>
              <div className="space-y-1">
                {CHECKLIST.map((c) => (
                  <div key={c.label} className="flex items-center gap-1.5">
                    <StatusDot tone={c.done ? "emerald" : "amber"} />
                    <span className={cn("truncate text-[8px]", c.done ? "text-slate-500 line-through" : "font-medium text-slate-200 light:text-slate-700")}>{c.label}</span>
                  </div>
                ))}
              </div>
            </Panel>
            <Panel title="On LWD · automatic" icon={Fingerprint}>
              <ul className="space-y-1 text-[8px] text-slate-400 light:text-slate-600">
                <li className="flex items-center gap-1.5"><Fingerprint className="h-3 w-3 text-rose-400" /> Device PIN 1043 → deactivated</li>
                <li className="flex items-center gap-1.5"><CalendarX className="h-3 w-3 text-amber-400" /> Status → EXITED</li>
                <li className="flex items-center gap-1.5"><DoorOpen className="h-3 w-3 text-indigo-400" /> Portal access ends</li>
                <li className="flex items-center gap-1.5"><BadgeCheck className="h-3 w-3 text-emerald-400" /> History archived (immutable)</li>
              </ul>
            </Panel>
          </div>
        </div>
      </div>
    </WindowChrome>
  )
}

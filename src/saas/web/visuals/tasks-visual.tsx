"use client"
// ============ Visual · Tasks, Approvals & Workflows ============
// The unified approval queue, a task with checklist + comments, and the
// workflow chain with delegation.
import { ArrowRight, CheckCircle2, Circle, ClipboardList, ListChecks, MessageCircle, UserRoundCheck } from "lucide-react"
import { cn } from "@/lib/utils"
import { Avatar, Chip, Panel, StatusDot, WindowChrome } from "./chrome"
import type { ChipTone } from "./chrome"

/* ---------- data ---------- */
const QUEUE: { name: string; who: string; kind: string; meta: string; tone: ChipTone }[] = [
  { name: "Arif Hossain", who: "AH", kind: "Leave · Casual 2d", meta: "10-18 → 10-19", tone: "amber" },
  { name: "Sabrina Akter", who: "SA", kind: "Expense · ৳4,200", meta: "Client visit · Dhaka", tone: "violet" },
  { name: "Tanvir Alam", who: "TA", kind: "Loan · ৳50,000", meta: "12 mo · 5% ", tone: "cyan" },
  { name: "Nusrat Jahan", who: "NJ", kind: "Attendance correction", meta: "10-15 · device miss", tone: "indigo" },
  { name: "Farhana Rahman", who: "FR", kind: "Resignation", meta: "LWD 30 Nov", tone: "rose" },
]

const TASK_CHECKS: { label: string; done: boolean }[] = [
  { label: "Collect device PIN deactivation list", done: true },
  { label: "Verify leave balances for F&F", done: true },
  { label: "PF settlement sheet draft", done: false },
  { label: "Exit interview schedule", done: false },
]

const COMMENTS: { who: string; text: string; at: string }[] = [
  { who: "RK", text: "PF sheet needs the employer contribution column.", at: "09:32" },
  { who: "HR", text: "Added — please re-check by EOD.", at: "09:41" },
]

const CHAIN: { role: string; state: "done" | "active" | "todo"; note?: string }[] = [
  { role: "Manager", state: "done" },
  { role: "HR", state: "active", note: "delegated → R. Karim" },
  { role: "Accounts", state: "todo" },
]

export function TasksVisual() {
  return (
    <WindowChrome title="finixhr.app · Approvals & Tasks" glow="bg-indigo-600/20">
      <div className="grid gap-2.5 lg:grid-cols-5">
        {/* left — unified queue */}
        <div className="lg:col-span-2">
          <Panel title="Approval queue · 5 pending" icon={CheckCircle2} action={<Chip tone="amber">2 due today</Chip>}>
            <ul className="space-y-1">
              {QUEUE.map((q) => (
                <li key={q.who + q.kind} className="flex items-center gap-2 rounded-lg bg-white/[0.03] px-2 py-1.5 light:bg-slate-50">
                  <Avatar initials={q.who} className="h-5 w-5 text-[7px]" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[9px] font-semibold text-slate-200 light:text-slate-700">{q.name}</p>
                    <p className="truncate text-[8px] text-slate-500">{q.kind} · {q.meta}</p>
                  </div>
                  <Chip tone={q.tone}>{q.kind.split(" ")[0]}</Chip>
                </li>
              ))}
            </ul>
            <div className="mt-1.5 flex items-center justify-between text-[8px] text-slate-500">
              <span>history keeps every decision + actor</span>
              <span className="font-bold text-indigo-300 light:text-indigo-600">approve all ✓</span>
            </div>
          </Panel>
        </div>

        {/* right — task detail + workflow */}
        <div className="space-y-2.5 lg:col-span-3">
          <Panel title="Task · Exit clearance — Farhana Rahman" icon={ListChecks} action={<Chip tone="rose">Due 28 Oct</Chip>}>
            <div className="grid gap-2 sm:grid-cols-2">
              <div className="space-y-1">
                {TASK_CHECKS.map((c) => (
                  <div key={c.label} className="flex items-start gap-1.5 rounded-lg bg-white/[0.03] px-2 py-1.5 light:bg-slate-50">
                    {c.done
                      ? <CheckCircle2 className="mt-px h-3 w-3 shrink-0 text-emerald-400" />
                      : <Circle className="mt-px h-3 w-3 shrink-0 text-slate-500" />}
                    <span className={cn("text-[9px] leading-snug", c.done ? "text-slate-500 line-through" : "font-medium text-slate-200 light:text-slate-700")}>{c.label}</span>
                  </div>
                ))}
              </div>
              <div className="space-y-1">
                {COMMENTS.map((c, i) => (
                  <div key={i} className="flex items-start gap-1.5">
                    <Avatar initials={c.who} className="h-4 w-4 text-[6px]" />
                    <div className="min-w-0 rounded-lg bg-white/[0.03] px-2 py-1 light:bg-slate-50">
                      <p className="text-[8px] leading-snug text-slate-300 light:text-slate-600">{c.text}</p>
                      <p className="mt-px text-[7px] text-slate-500"><MessageCircle className="mr-0.5 inline h-2.5 w-2.5" />{c.at}</p>
                    </div>
                  </div>
                ))}
                <div className="flex items-center gap-1.5 rounded-lg border border-dashed border-white/15 px-2 py-1 light:border-slate-300">
                  <ClipboardList className="h-3 w-3 text-slate-500" />
                  <span className="text-[8px] text-slate-500">add a comment…</span>
                </div>
              </div>
            </div>
          </Panel>
          <Panel title="Workflow · Expense claim" icon={UserRoundCheck}>
            <div className="flex items-center">
              {CHAIN.map((c, i) => (
                <div key={c.role} className="flex flex-1 items-center">
                  <div className="flex min-w-0 flex-col items-center gap-0.5">
                    <StatusDot tone={c.state === "done" ? "emerald" : c.state === "active" ? "amber" : "slate"} pulse={c.state === "active"} />
                    <span className="truncate text-[8px] font-semibold text-slate-200 light:text-slate-700">{c.role}</span>
                    {c.note && <span className="truncate text-[7px] text-amber-400/90">{c.note}</span>}
                  </div>
                  {i < CHAIN.length - 1 && <ArrowRight className="mx-1 h-3 w-3 shrink-0 text-slate-600" />}
                </div>
              ))}
            </div>
            <p className="mt-1.5 text-center text-[8px] text-slate-500">14 process types · substitutes keep requests moving</p>
          </Panel>
        </div>
      </div>
    </WindowChrome>
  )
}

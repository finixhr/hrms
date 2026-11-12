"use client"
// ============ Visual · Recruitment & Careers ============
// A published opening card, the mini pipeline with live application counts,
// a website application alert, and the kanban board ending in a Hired card
// that prefills the Add Employee form.
import { Briefcase, FileDown, Globe, Send, Sparkles, UserCheck } from "lucide-react"
import { Avatar, Chip, Panel, StatusDot, WindowChrome } from "./chrome"
import type { ChipTone } from "./chrome"

/* ---------- data ---------- */
const PIPELINE: { stage: string; count: number; tone: ChipTone }[] = [
  { stage: "New", count: 4, tone: "cyan" },
  { stage: "Shortlisted", count: 3, tone: "violet" },
  { stage: "Interview", count: 2, tone: "amber" },
  { stage: "Offered", count: 1, tone: "emerald" },
]

const APPLICANTS: { name: string; who: string; opening: string; source: "WEBSITE" | "MANUAL"; cv: boolean; tone: ChipTone; status: string }[] = [
  { name: "Farhana Yasmin", who: "FY", opening: "Senior Accountant", source: "WEBSITE", cv: true, tone: "cyan", status: "New" },
  { name: "Arif Hossain", who: "AH", opening: "Senior Accountant", source: "WEBSITE", cv: true, tone: "violet", status: "Shortlisted" },
  { name: "Sabbir Rahman", who: "SR", opening: "Branch Officer", source: "MANUAL", cv: false, tone: "amber", status: "Interview" },
  { name: "Nusrat Jahan", who: "NJ", opening: "Senior Accountant", source: "WEBSITE", cv: true, tone: "emerald", status: "Hired" },
]

export function RecruitmentVisual() {
  return (
    <WindowChrome title="finixhr.app · Recruitment" glow="bg-violet-600/20">
      <div className="grid gap-2.5 lg:grid-cols-5">
        {/* left — published opening + pipeline counts */}
        <div className="space-y-2.5 lg:col-span-2">
          <Panel title="Published opening" icon={Briefcase} action={<Chip tone="emerald">Public</Chip>}>
            <div className="rounded-lg border border-white/10 bg-white/[0.03] px-2.5 py-2 light:border-slate-200 light:bg-slate-50">
              <div className="flex items-center justify-between gap-2">
                <p className="truncate text-[10px] font-bold text-slate-100 light:text-slate-800">Senior Accountant</p>
                <Chip tone="indigo">Full Time</Chip>
              </div>
              <p className="mt-1 truncate text-[8px] text-slate-500">Finix Group Ltd. · Gulshan, Dhaka · Finance</p>
              <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[8px] text-slate-500">
                <span className="inline-flex items-center gap-1"><Globe className="h-2.5 w-2.5" /> /careers</span>
                <span>Deadline 30 Nov 2026</span>
                <span>৳35k–45k</span>
              </div>
            </div>
            <p className="mt-2 text-center text-[8px] text-slate-500">Open + Public openings list on the careers page — server-filtered</p>
          </Panel>
          <Panel title="Pipeline" icon={Sparkles}>
            <ul className="space-y-1.5">
              {PIPELINE.map((p) => (
                <li key={p.stage} className="flex items-center gap-2">
                  <StatusDot tone={p.tone} pulse={p.stage === "New"} />
                  <span className="text-[10px] font-semibold text-slate-200 light:text-slate-700">{p.stage}</span>
                  <span className="ml-auto tabular-nums text-[9px] text-slate-500">{p.count}</span>
                  <Chip tone={p.tone}>{p.count}</Chip>
                </li>
              ))}
              <li className="flex items-center gap-2">
                <StatusDot tone="emerald" />
                <span className="text-[10px] font-semibold text-slate-200 light:text-slate-700">Hired</span>
                <span className="ml-auto tabular-nums text-[9px] text-slate-500">1</span>
                <Chip tone="emerald">1</Chip>
              </li>
            </ul>
          </Panel>
          <Panel title="New application alert" icon={Send}>
            <div className="rounded-lg border border-emerald-400/30 bg-emerald-400/10 px-2 py-1.5 light:border-emerald-500/30 light:bg-emerald-500/10">
              <p className="truncate text-[9px] font-bold text-emerald-200 light:text-emerald-700">Farhana Yasmin → Senior Accountant</p>
              <p className="mt-0.5 truncate text-[8px] text-slate-500">careers page · CV attached · rate-limited &amp; honeypot-guarded</p>
            </div>
          </Panel>
        </div>

        {/* right — applicant board + hire card */}
        <div className="space-y-2.5 lg:col-span-3">
          <Panel title="Applicant pipeline" icon={UserCheck} action={<Chip tone="violet">4 active</Chip>}>
            <ul className="space-y-1">
              {APPLICANTS.map((a) => (
                <li key={a.name} className="flex items-center gap-2 rounded-lg bg-white/[0.03] px-2 py-1.5 light:bg-slate-50">
                  <Avatar initials={a.who} className="h-5 w-5 text-[7px]" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[10px] font-semibold text-slate-200 light:text-slate-700">{a.name}</p>
                    <p className="truncate text-[8px] text-slate-500">{a.opening} · {a.source === "WEBSITE" ? "careers page" : "manual entry"}</p>
                  </div>
                  {a.cv && <FileDown className="h-3 w-3 shrink-0 text-emerald-400 light:text-emerald-600" aria-label="CV attached" />}
                  <Chip tone={a.tone}>{a.status}</Chip>
                </li>
              ))}
            </ul>
          </Panel>
          <Panel title="Hire → Add Employee" icon={UserCheck} action={<Chip tone="emerald">Prefilled</Chip>}>
            <div className="rounded-lg border border-white/10 bg-white/[0.03] p-2 light:border-slate-200 light:bg-slate-50">
              <div className="grid grid-cols-2 gap-1.5">
                {[
                  ["Full name", "Nusrat Jahan"],
                  ["Personal email", "nusrat@mail.com"],
                  ["Personal mobile", "01711-000000"],
                  ["Department", "Finance (from opening)"],
                ].map(([k, v]) => (
                  <div key={k} className="min-w-0">
                    <p className="truncate text-[7px] font-bold uppercase tracking-widest text-slate-500">{k}</p>
                    <p className="truncate text-[9px] font-semibold text-slate-200 light:text-slate-700">{v}</p>
                  </div>
                ))}
              </div>
              <div className="mt-2 flex items-center gap-1.5">
                <span className="inline-flex items-center gap-1 rounded-md bg-emerald-500/20 px-2 py-1 text-[8px] font-bold text-emerald-200 light:text-emerald-700"><UserCheck className="h-2.5 w-2.5" /> Mark Hired</span>
                <span className="text-[8px] text-slate-500">→ the wizard opens pre-filled, audited end to end</span>
              </div>
            </div>
          </Panel>
        </div>
      </div>
    </WindowChrome>
  )
}

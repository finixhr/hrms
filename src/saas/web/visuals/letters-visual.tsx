"use client"
// ============ Visual · HR Letters ============
// Letter-type gallery, the 3-step issuance flow (generate → approve → issue),
// a live letter preview with letterhead + seal, and the issued register.
import { BadgeCheck, FileSignature, FileText, Printer, Send, Stamp } from "lucide-react"
import { cn } from "@/lib/utils"
import { Avatar, Chip, Panel, StatusDot, WindowChrome } from "./chrome"
import type { ChipTone } from "./chrome"

/* ---------- data ---------- */
const TYPES: { type: string; tone: ChipTone; approval: string }[] = [
  { type: "Appointment", tone: "indigo", approval: "Approval" },
  { type: "Salary Cert.", tone: "emerald", approval: "Auto" },
  { type: "Experience", tone: "cyan", approval: "Auto" },
  { type: "Promotion", tone: "violet", approval: "Approval" },
  { type: "NOC", tone: "slate", approval: "Auto" },
  { type: "Warning", tone: "amber", approval: "Approval" },
]

const STAGES: { label: string; meta: string; state: "done" | "active" | "todo" }[] = [
  { label: "Generated", meta: "L-2026-0041 · draft", state: "done" },
  { label: "Approved", meta: "MD sign-off ✓", state: "done" },
  { label: "Issued", meta: "portal + email", state: "active" },
]

const REGISTER: { name: string; who: string; type: string; no: string; status: string; tone: ChipTone }[] = [
  { name: "Arif Hossain", who: "AH", type: "Appointment", no: "L-2026-0038", status: "Issued", tone: "emerald" },
  { name: "Sabrina Akter", who: "SA", type: "Salary Cert.", no: "L-2026-0039", status: "Issued", tone: "emerald" },
  { name: "Tanvir Alam", who: "TA", type: "Experience", no: "L-2026-0040", status: "Approved", tone: "indigo" },
  { name: "Nusrat Jahan", who: "NJ", type: "Promotion", no: "L-2026-0041", status: "Issuing", tone: "amber" },
]

export function LettersVisual() {
  return (
    <WindowChrome title="finixhr.app · HR Letters" glow="bg-violet-600/20">
      <div className="grid gap-2.5 lg:grid-cols-5">
        {/* left — type gallery + flow */}
        <div className="space-y-2.5 lg:col-span-2">
          <Panel title="19 letter types" icon={FileSignature}>
            <div className="grid grid-cols-2 gap-1.5">
              {TYPES.map((t) => (
                <div key={t.type} className="flex items-center justify-between rounded-lg border border-white/10 bg-white/[0.03] px-2 py-1.5 light:border-slate-200 light:bg-slate-50">
                  <span className="truncate text-[10px] font-semibold text-slate-200 light:text-slate-700">{t.type}</span>
                  <Chip tone={t.tone}>{t.approval}</Chip>
                </div>
              ))}
            </div>
          </Panel>
          <Panel title="Issuance flow" icon={BadgeCheck}>
            <ol className="space-y-1.5">
              {STAGES.map((s) => (
                <li key={s.label} className="flex items-center gap-2">
                  <StatusDot tone={s.state === "done" ? "emerald" : s.state === "active" ? "amber" : "slate"} pulse={s.state === "active"} />
                  <span className="text-[10px] font-semibold text-slate-200 light:text-slate-700">{s.label}</span>
                  <span className="ml-auto truncate text-[9px] text-slate-500">{s.meta}</span>
                </li>
              ))}
            </ol>
            <div className="mt-2 flex gap-1.5">
              <span className="inline-flex items-center gap-1 rounded-md bg-indigo-500/20 px-2 py-1 text-[9px] font-bold text-indigo-200 light:text-indigo-700"><Send className="h-3 w-3" /> Portal</span>
              <span className="inline-flex items-center gap-1 rounded-md bg-cyan-500/20 px-2 py-1 text-[9px] font-bold text-cyan-200 light:text-cyan-700"><Send className="h-3 w-3" /> Email</span>
              <span className="inline-flex items-center gap-1 rounded-md bg-slate-500/20 px-2 py-1 text-[9px] font-bold text-slate-300 light:text-slate-600"><Printer className="h-3 w-3" /> Print</span>
            </div>
          </Panel>
        </div>

        {/* right — letter preview + register */}
        <div className="space-y-2.5 lg:col-span-3">
          <Panel title="Preview · L-2026-0041" icon={FileText} action={<Chip tone="amber">Issuing</Chip>}>
            <div className="rounded-lg border border-white/10 bg-white/95 p-3 light:border-slate-200">
              <div className="flex items-start justify-between border-b border-slate-200 pb-2">
                <div className="flex items-center gap-2">
                  <span className="flex h-7 w-7 items-center justify-center rounded-md bg-gradient-to-br from-indigo-500 to-violet-600 text-[10px] font-black text-white">FX</span>
                  <div>
                    <p className="text-[10px] font-black text-slate-800">Finix Group Ltd.</p>
                    <p className="text-[7px] text-slate-500">Gulshan Ave, Dhaka · +880 2 8834400</p>
                  </div>
                </div>
                <div className="relative">
                  <span className="flex h-9 w-9 items-center justify-center rounded-full border-2 border-dashed border-indigo-300 text-[5px] font-black uppercase text-indigo-400">OFFICIAL SEAL</span>
                  <Stamp className="absolute -bottom-1 -right-1 h-3 w-3 text-indigo-400" />
                </div>
              </div>
              <p className="mt-2 text-[7px] font-semibold uppercase tracking-widest text-slate-500">Promotion Letter</p>
              <p className="mt-1 text-[8px] leading-relaxed text-slate-600">
                Dear <b>Nusrat Jahan</b>, we are pleased to promote you to <b>Senior Executive, HR</b> effective
                <b> 01 Nov 2026</b>…
              </p>
              <div className="mt-2 flex items-end justify-between border-t border-slate-200 pt-1.5">
                <div>
                  <p className="w-20 border-b border-slate-400 pb-px text-[7px] italic text-slate-700" style={{ fontFamily: "cursive" }}>Nazmul Hasan</p>
                  <p className="text-[6px] text-slate-500">Managing Director</p>
                </div>
                <p className="text-[6px] text-slate-400">Ref L-2026-0041 · 27 Oct 2026</p>
              </div>
            </div>
          </Panel>
          <Panel title="Issued register" icon={FileSignature}>
            <ul className="space-y-1">
              {REGISTER.map((r) => (
                <li key={r.no} className="flex items-center gap-2 rounded-lg bg-white/[0.03] px-2 py-1.5 light:bg-slate-50">
                  <Avatar initials={r.who} className="h-5 w-5 text-[7px]" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[10px] font-semibold text-slate-200 light:text-slate-700">{r.name}</p>
                    <p className="text-[8px] text-slate-500">{r.type} · {r.no}</p>
                  </div>
                  <Chip tone={r.tone}>{r.status}</Chip>
                </li>
              ))}
            </ul>
            <p className={cn("mt-1.5 text-center text-[8px] text-slate-500")}>
              Sequential numbering · download counter · reason-capture on sensitive types
            </p>
          </Panel>
        </div>
      </div>
    </WindowChrome>
  )
}

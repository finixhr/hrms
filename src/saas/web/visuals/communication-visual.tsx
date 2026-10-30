"use client"
// ============ Visual · Email, SMS & Announcements ============
// Gateway status, the compose card with audience chips + channel toggle, the
// automated event matrix and the delivery log with recipient-level status.
import { AtSign, Bell, CheckCheck, MessageSquare, Megaphone, Send, Smartphone } from "lucide-react"
import { cn } from "@/lib/utils"
import { Avatar, Chip, Meter, Panel, StatusDot, WindowChrome } from "./chrome"
import type { ChipTone } from "./chrome"

/* ---------- data ---------- */
const AUDIENCE: { label: string; count: string; on: boolean }[] = [
  { label: "Head Office", count: "142", on: true },
  { label: "Sales Dept.", count: "38", on: true },
  { label: "Chattogram Branch", count: "27", on: true },
  { label: "Designation: Executive", count: "31", on: false },
]

const EVENTS: { ev: string; email: boolean; sms: boolean; inApp: boolean }[] = [
  { ev: "Leave decision", email: true, sms: false, inApp: true },
  { ev: "Payslip generated", email: true, sms: false, inApp: true },
  { ev: "Salary credited", email: false, sms: true, inApp: true },
  { ev: "Document expiry", email: true, sms: false, inApp: true },
  { ev: "Birthday wishes", email: true, sms: true, inApp: true },
]

const LOG: { name: string; who: string; ch: "EMAIL" | "SMS"; status: string; tone: ChipTone; detail: string }[] = [
  { name: "Arif Hossain", who: "AH", ch: "EMAIL", status: "Sent", tone: "emerald", detail: "via smtp · 09:41" },
  { name: "Sabrina Akter", who: "SA", ch: "SMS", status: "Sent", tone: "emerald", detail: "+880 1712… · 09:41" },
  { name: "Tanvir Alam", who: "TA", ch: "EMAIL", status: "Sent", tone: "emerald", detail: "via smtp · 09:42" },
  { name: "Nusrat Jahan", who: "NJ", ch: "SMS", status: "Skipped", tone: "amber", detail: "no mobile on file" },
]

export function CommunicationVisual() {
  return (
    <WindowChrome title="finixhr.app · Email & SMS Center" glow="bg-cyan-600/20">
      <div className="grid gap-2.5 lg:grid-cols-5">
        {/* left — compose + gateways */}
        <div className="space-y-2.5 lg:col-span-3">
          <Panel title="Compose broadcast" icon={Send} action={<Chip tone="cyan">EMAIL + SMS</Chip>}>
            <div className="rounded-lg border border-white/10 bg-white/[0.03] p-2 light:border-slate-200 light:bg-slate-50">
              <p className="text-[10px] font-bold text-slate-200 light:text-slate-800">October town-hall moved to Nov 2</p>
              <p className="mt-0.5 text-[8px] leading-relaxed text-slate-500">
                Hi {"{{name}}"}, the October town-hall moves to <b>Nov 2, 4:00 PM</b> at the Head Office auditorium. See you there — {"{{company}}"}.
              </p>
              <div className="mt-1.5 flex flex-wrap items-center gap-1">
                {AUDIENCE.map((a) => (
                  <span key={a.label} className={cn(
                    "inline-flex items-center gap-1 rounded-full border px-1.5 py-px text-[8px] font-bold",
                    a.on ? "border-cyan-400/40 bg-cyan-400/10 text-cyan-200 light:text-cyan-700" : "border-white/10 text-slate-500 light:border-slate-300",
                  )}>
                    {a.on && <StatusDot tone="cyan" />}
                    {a.label} · {a.count}
                  </span>
                ))}
              </div>
            </div>
            <div className="mt-1.5 flex items-center gap-2 text-[8px] text-slate-500">
              <span className="inline-flex items-center gap-1"><AtSign className="h-3 w-3" /> variables render per recipient</span>
              <span className="ml-auto inline-flex items-center gap-1"><Megaphone className="h-3 w-3" /> mirror as announcement</span>
            </div>
          </Panel>
          <div className="grid grid-cols-2 gap-2.5">
            <Panel title="Email gateway" icon={AtSign}>
              <div className="flex items-center gap-1.5"><StatusDot tone="emerald" pulse /><span className="text-[9px] font-semibold text-emerald-300 light:text-emerald-700">SMTP connected</span></div>
              <Meter value={92} tone="emerald" className="mt-1.5" />
              <p className="mt-1 text-[8px] text-slate-500">207 / 235 delivered this month</p>
            </Panel>
            <Panel title="SMS gateway" icon={MessageSquare}>
              <div className="flex items-center gap-1.5"><StatusDot tone="emerald" /><span className="text-[9px] font-semibold text-emerald-300 light:text-emerald-700">Provider ready</span></div>
              <Meter value={64} tone="cyan" className="mt-1.5" />
              <p className="mt-1 text-[8px] text-slate-500">1,204 credits remaining</p>
            </Panel>
          </div>
        </div>

        {/* right — event matrix + delivery log */}
        <div className="space-y-2.5 lg:col-span-2">
          <Panel title="Automated events" icon={Bell}>
            <ul className="space-y-1">
              {EVENTS.map((e) => (
                <li key={e.ev} className="flex items-center gap-1.5 rounded-lg bg-white/[0.03] px-2 py-1.5 light:bg-slate-50">
                  <span className="min-w-0 flex-1 truncate text-[9px] font-semibold text-slate-200 light:text-slate-700">{e.ev}</span>
                  <AtSign className={cn("h-3 w-3", e.email ? "text-cyan-400" : "text-slate-600")} />
                  <Smartphone className={cn("h-3 w-3", e.sms ? "text-emerald-400" : "text-slate-600")} />
                  <Bell className={cn("h-3 w-3", e.inApp ? "text-violet-400" : "text-slate-600")} />
                </li>
              ))}
            </ul>
            <p className="mt-1.5 text-center text-[8px] text-slate-500">system templates are editable — no code</p>
          </Panel>
          <Panel title="Delivery log" icon={CheckCheck}>
            <ul className="space-y-1">
              {LOG.map((l) => (
                <li key={l.who + l.ch} className="flex items-center gap-2 rounded-lg bg-white/[0.03] px-2 py-1.5 light:bg-slate-50">
                  <Avatar initials={l.who} className="h-5 w-5 text-[7px]" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[9px] font-semibold text-slate-200 light:text-slate-700">{l.name}</p>
                    <p className="text-[7px] text-slate-500">{l.ch} · {l.detail}</p>
                  </div>
                  <Chip tone={l.tone}>{l.status}</Chip>
                </li>
              ))}
            </ul>
          </Panel>
        </div>
      </div>
    </WindowChrome>
  )
}

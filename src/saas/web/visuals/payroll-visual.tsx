"use client"
// ============ Visual 03 · Payroll & Finance ============
// Run workflow stepper (Draft → Calculations → Approvals → Payments →
// Complete), salary table, payment-method donut, AIT certificate, summary KPIs
// and a floating paper payslip preview. BDT figures are internally consistent.
import {
  BadgeCheck, Banknote, Calculator, Check, FileText, Landmark, Percent, ReceiptText, Wallet, Zap,
} from "lucide-react"
import type { LucideIcon } from "lucide-react"
import {
  Cell, Pie, PieChart, ResponsiveContainer, Tooltip,
} from "recharts"
import { cn } from "@/lib/utils"
import { Avatar, CHART_TOOLTIP_STYLE, Chip, Panel, StatusDot, WindowChrome } from "./chrome"

/* ---------- data ---------- */
type Stage = { label: string; meta: string; state: "done" | "active" | "todo" }
const STAGES: Stage[] = [
  { label: "Draft", meta: "2026-09-28", state: "done" },
  { label: "Calculations", meta: "09-29 · no errors", state: "done" },
  { label: "Approvals", meta: "10-12 · 2 sign-offs", state: "done" },
  { label: "Payments", meta: "disbursing", state: "active" },
  { label: "Complete", meta: "ETA 10-16", state: "todo" },
]

const SALARIES: { name: string; role: string; gross: string; ded: string; net: string }[] = [
  { name: "Arif Hossain", role: "Sr. Executive, Sales", gross: "82,000", ded: "12,300", net: "69,700" },
  { name: "Nusrat Jahan", role: "HR Officer", gross: "65,000", ded: "9,750", net: "55,250" },
  { name: "Mahmudul Hasan", role: "Accounts Manager", gross: "95,000", ded: "14,250", net: "80,750" },
  { name: "Sabrina Akter", role: "Executive, Operations", gross: "52,000", ded: "7,800", net: "44,200" },
  { name: "Tanvir Alam", role: "Field Technician", gross: "48,000", ded: "7,200", net: "40,800" },
]

const METHODS: { name: string; value: number }[] = [
  { name: "Bank transfer", value: 62 }, { name: "Cash", value: 18 },
  { name: "bKash", value: 12 }, { name: "Nagad", value: 8 },
]
const METHOD_COLORS = ["#6366f1", "#f59e0b", "#06b6d4", "#8b5cf6"]

const KPIS: { label: string; value: string; sub: string; icon: LucideIcon }[] = [
  { label: "Total payout", value: "৳ 4.2M", sub: "net · 1,248 employees", icon: Banknote },
  { label: "AIT withheld", value: "৳ 182K", sub: "deposited to exchequer", icon: Percent },
  { label: "Bank disbursal", value: "62%", sub: "rest via cash / MFS", icon: Landmark },
]

const EARNINGS: [string, string][] = [
  ["Basic", "50,000"], ["House rent", "24,600"], ["Conveyance", "7,400"],
]
const DEDUCTIONS: [string, string][] = [
  ["Income tax (AIT)", "5,740"], ["Provident fund", "5,000"], ["Others", "1,560"],
]

/* ---------- stepper ---------- */
function Stepper() {
  return (
    <div className="overflow-x-auto rounded-xl border border-white/10 bg-white/[0.03] p-2.5 light:border-slate-200 light:bg-white light:shadow-sm">
      <div className="flex min-w-[430px] items-center">
        {STAGES.map((s, i) => (
          <div key={s.label} className={cn("flex items-center", i < STAGES.length - 1 && "flex-1")}>
            <div className="flex items-center gap-2">
              <span className={cn(
                "flex h-7 w-7 shrink-0 items-center justify-center rounded-full border",
                s.state === "done" && "border-emerald-400/50 bg-emerald-400/15 text-emerald-300 light:text-emerald-600",
                s.state === "active" && "border-indigo-400/60 bg-indigo-500/20 text-indigo-300 ring-2 ring-indigo-400/30 light:text-indigo-600",
                s.state === "todo" && "border-white/15 text-slate-500 light:border-slate-300",
              )}>
                {s.state === "done" ? <Check className="h-3.5 w-3.5" /> : s.state === "active" ? <StatusDot tone="indigo" pulse /> : <span className="text-[10px] font-bold">{i + 1}</span>}
              </span>
              <div className="whitespace-nowrap">
                <p className={cn(
                  "text-[10px] font-bold",
                  s.state === "todo" ? "text-slate-500" : "text-white light:text-slate-900",
                )}>{s.label}</p>
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
  )
}

/* ---------- floating payslip (paper, slightly rotated) ---------- */
function Payslip() {
  return (
    <div className="fv-float-b rotate-[1.5deg] rounded-xl bg-slate-50 p-3 text-slate-900 shadow-xl shadow-black/30 ring-1 ring-black/10 light:shadow-slate-900/20">
      <div className="flex items-center gap-2 border-b border-slate-200 pb-2">
        <span className="flex h-6 w-6 items-center justify-center rounded-md bg-gradient-to-br from-blue-600 to-violet-600 text-[9px] font-black text-white">F</span>
        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-bold leading-tight">FINIX HR LTD.</p>
          <p className="text-[8px] text-slate-500">Payslip · September 2026</p>
        </div>
        <Chip tone="indigo" className="border-indigo-500/30 bg-indigo-500/10 text-indigo-600">Secure PDF</Chip>
      </div>
      <div className="mt-2 flex items-center gap-2">
        <Avatar initials="AH" className="h-7 w-7 text-[9px]" />
        <div className="min-w-0">
          <p className="truncate text-[11px] font-bold leading-tight">Arif Hossain</p>
          <p className="truncate text-[8px] text-slate-500">EMP-1042 · Sr. Executive, Sales</p>
        </div>
      </div>
      <div className="mt-2 grid grid-cols-2 gap-3 border-t border-slate-200 pt-2">
        <div>
          <p className="text-[8px] font-bold uppercase tracking-widest text-slate-400">Earnings</p>
          <ul className="mt-1 space-y-0.5">
            {EARNINGS.map(([k, v]) => (
              <li key={k} className="flex justify-between text-[9px] text-slate-600">
                <span>{k}</span><span className="tabular-nums font-medium">{v}</span>
              </li>
            ))}
            <li className="flex justify-between border-t border-slate-200 pt-0.5 text-[9px] font-bold">
              <span>Gross</span><span className="tabular-nums">82,000</span>
            </li>
          </ul>
        </div>
        <div>
          <p className="text-[8px] font-bold uppercase tracking-widest text-slate-400">Deductions</p>
          <ul className="mt-1 space-y-0.5">
            {DEDUCTIONS.map(([k, v]) => (
              <li key={k} className="flex justify-between text-[9px] text-slate-600">
                <span>{k}</span><span className="tabular-nums font-medium">{v}</span>
              </li>
            ))}
            <li className="flex justify-between border-t border-slate-200 pt-0.5 text-[9px] font-bold">
              <span>Total</span><span className="tabular-nums">12,300</span>
            </li>
          </ul>
        </div>
      </div>
      <div className="mt-2 flex items-center justify-between rounded-lg bg-emerald-600/10 px-2.5 py-1.5">
        <span className="text-[9px] font-bold uppercase tracking-wider text-emerald-700">Net pay</span>
        <span className="text-[13px] font-bold tabular-nums text-emerald-700">৳ 69,700</span>
      </div>
      <p className="mt-1.5 flex items-center gap-1 text-[8px] text-slate-500">
        <BadgeCheck className="h-3 w-3 text-emerald-600" /> Digitally verified · AIT deducted at source
      </p>
    </div>
  )
}

/* ---------- the visual ---------- */
export function PayrollVisual() {
  return (
    <WindowChrome
      title={<>finixhr.app — Payroll · Run 2026-09
        <span className="ml-2 inline-flex items-center gap-1 text-violet-300 light:text-violet-600">
          <StatusDot tone="violet" pulse /> disbursing
        </span>
      </>}
      glow="bg-violet-600/20"
    >
      <div className="space-y-3">
        <Stepper />

        <div className="grid grid-cols-3 gap-2 sm:gap-3">
          {KPIS.map((k) => (
            <div key={k.label} className="rounded-xl border border-white/10 bg-white/[0.03] p-2.5 light:border-slate-200 light:bg-white light:shadow-sm">
              <p className="flex items-center gap-1 text-[9px] font-bold uppercase tracking-widest text-slate-500">
                <k.icon className="h-3 w-3 text-violet-300 light:text-violet-600" /> {k.label}
              </p>
              <p className="mt-1 text-[15px] font-bold tabular-nums text-white light:text-slate-900">{k.value}</p>
              <p className="text-[9px] text-slate-500">{k.sub}</p>
            </div>
          ))}
        </div>

        <div className="grid gap-3 lg:grid-cols-[1.2fr_240px]">
          <div className="min-w-0 space-y-3">
            <Panel title="Employee salaries · 2026-09" icon={ReceiptText} action={<Chip tone="slate">BDT</Chip>}>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[480px] text-left text-[10px]">
                  <thead>
                    <tr className="text-[9px] uppercase tracking-wider text-slate-500">
                      <th className="pb-1.5 font-semibold">Employee</th>
                      <th className="pb-1.5 font-semibold">Designation</th>
                      <th className="pb-1.5 text-right font-semibold">Gross</th>
                      <th className="pb-1.5 text-right font-semibold">Deductions</th>
                      <th className="pb-1.5 text-right font-semibold">Net</th>
                    </tr>
                  </thead>
                  <tbody>
                    {SALARIES.map((r) => (
                      <tr key={r.name} className="border-t border-white/5 transition-colors hover:bg-white/[0.03] light:border-slate-100 light:hover:bg-slate-50">
                        <td className="py-1.5 font-medium text-slate-200 light:text-slate-800">{r.name}</td>
                        <td className="py-1.5 text-slate-400 light:text-slate-600">{r.role}</td>
                        <td className="py-1.5 text-right tabular-nums text-slate-300 light:text-slate-700">{r.gross}</td>
                        <td className="py-1.5 text-right tabular-nums text-rose-300 light:text-rose-600">− {r.ded}</td>
                        <td className="py-1.5 text-right font-bold tabular-nums text-emerald-300 light:text-emerald-700">{r.net}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Panel>

            <div className="grid gap-3 sm:grid-cols-2">
              <Panel title="Payment methods" icon={Wallet}>
                <div className="relative h-[130px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie data={METHODS} dataKey="value" nameKey="name" innerRadius={34} outerRadius={50} paddingAngle={3} strokeWidth={0}>
                        {METHODS.map((m, i) => <Cell key={m.name} fill={METHOD_COLORS[i]} />)}
                      </Pie>
                      <Tooltip contentStyle={CHART_TOOLTIP_STYLE} formatter={(v) => `${v}% of net`} />
                    </PieChart>
                  </ResponsiveContainer>
                  <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
                    <span className="text-[10px] font-bold text-white light:text-slate-900">62%</span>
                    <span className="text-[8px] uppercase tracking-widest text-slate-500">bank</span>
                  </div>
                </div>
                <div className="flex flex-wrap gap-x-3 gap-y-1">
                  {METHODS.map((m, i) => (
                    <span key={m.name} className="flex items-center gap-1 text-[9px] text-slate-400 light:text-slate-600">
                      <span className="h-1.5 w-1.5 rounded-full" style={{ background: METHOD_COLORS[i] }} />
                      {m.name} {m.value}%
                    </span>
                  ))}
                </div>
              </Panel>

              <Panel title="AIT certificate" icon={FileText}>
                <div className="flex items-center gap-2">
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-amber-500/25 to-orange-500/20 ring-1 ring-amber-400/30">
                    <Calculator className="h-4 w-4 text-amber-300 light:text-amber-600" />
                  </span>
                  <div>
                    <p className="text-[11px] font-bold text-white light:text-slate-900">Tax year 2025-26 · #AIT-2026-0891</p>
                    <p className="text-[9px] text-slate-500">auto-generated per employee on payment</p>
                  </div>
                </div>
                <dl className="mt-2 space-y-1 text-[10px]">
                  <div className="flex justify-between rounded-md bg-white/[0.03] px-2 py-1 light:bg-slate-50">
                    <dt className="text-slate-400 light:text-slate-600">Taxable income</dt>
                    <dd className="font-bold tabular-nums text-slate-200 light:text-slate-800">৳ 18,45,000</dd>
                  </div>
                  <div className="flex justify-between rounded-md bg-white/[0.03] px-2 py-1 light:bg-slate-50">
                    <dt className="text-slate-400 light:text-slate-600">Tax paid (AIT)</dt>
                    <dd className="font-bold tabular-nums text-amber-300 light:text-amber-700">৳ 1,82,000</dd>
                  </div>
                  <div className="flex justify-between rounded-md bg-white/[0.03] px-2 py-1 light:bg-slate-50">
                    <dt className="text-slate-400 light:text-slate-600">Deposited</dt>
                    <dd className="flex items-center gap-1 font-medium text-emerald-300 light:text-emerald-700">
                      <Check className="h-3 w-3" /> 2026-10-10
                    </dd>
                  </div>
                </dl>
              </Panel>
            </div>
          </div>

          {/* floating payslip column */}
          <div className="min-w-0">
            <Payslip />
            <p className="mt-2 flex items-center gap-1.5 px-1 text-[9px] text-slate-500">
              <Zap className="h-3 w-3 shrink-0 text-violet-300 light:text-violet-600" />
              Every payslip is generated from the same audited run — no spreadsheets.
            </p>
          </div>
        </div>
      </div>
    </WindowChrome>
  )
}

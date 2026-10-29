"use client"
// ============ Pricing cards (client — monthly/yearly toggle) ============
// Data always comes from the DATABASE (loaded by the server page and passed
// in); nothing about pricing is hardcoded in any component.
import Link from "next/link"
import { ArrowRight, Check, Minus } from "lucide-react"
import { useState } from "react"
import { cn } from "@/lib/utils"

export type PublicPlan = {
  id: string
  name: string
  tagline: string | null
  description: string | null
  monthlyPrice: number
  yearlyPrice: number
  currency: string
  badge: string | null
  isTrialPlan: boolean
  limits: {
    employeeLimit: number | null
    userLimit: number | null
    branchLimit: number | null
    departmentLimit: number | null
    deviceLimit: number | null
    storageGb: number | null
    trackingEmployeeLimit: number | null
  }
  features: Record<string, boolean>
  supportLevel: string
}

const FEATURE_ROWS: { key: string; label: string }[] = [
  { key: "payroll", label: "Payroll & finance" },
  { key: "ait", label: "AIT / income tax" },
  { key: "inventory", label: "Stock inventory" },
  { key: "procurement", label: "Requisition & purchase" },
  { key: "performance", label: "Performance & KPI" },
  { key: "ess", label: "Employee self-service" },
  { key: "camera", label: "Camera manager" },
  { key: "tracking", label: "Live employee tracking" },
  { key: "geofence", label: "Geo-fencing" },
  { key: "api", label: "API access" },
  { key: "advancedReports", label: "Advanced reports" },
  { key: "fieldForce", label: "Field force ops" },
]

function money(v: number, currency: string): string {
  const sym = currency === "BDT" ? "৳" : currency === "USD" ? "$" : `${currency} `
  return sym + v.toLocaleString()
}

function limitCell(v: number | null, unit = ""): string {
  return v == null ? "Unlimited" : `${v.toLocaleString()}${unit}`
}

export function PricingCards({ plans }: { plans: PublicPlan[] }) {
  const [yearly, setYearly] = useState(false)

  if (plans.length === 0) {
    return (
      <div className="mx-auto max-w-2xl rounded-2xl border border-white/10 bg-white/[0.03] p-8 text-center light:border-slate-200 light:bg-white light:shadow-sm">
        <p className="text-lg font-semibold text-white light:text-slate-900">Plans are being configured</p>
        <p className="mt-2 text-sm text-slate-400 light:text-slate-600">
          The platform operator hasn&apos;t published subscription plans yet. Register your organization anyway — the
          review team will propose a plan during the application review.
        </p>
        <div className="mt-6 flex justify-center">
          <Link href="/register" className="inline-flex h-11 items-center gap-2 rounded-xl bg-gradient-to-r from-blue-600 to-violet-600 px-6 text-sm font-semibold text-white">
            Register your organization <ArrowRight className="h-4 w-4" />
          </Link>
        </div>
      </div>
    )
  }

  return (
    <div>
      {/* billing cycle toggle */}
      <div className="flex items-center justify-center gap-3">
        <span className={cn("text-sm font-medium transition-colors", !yearly ? "text-white light:text-slate-900" : "text-slate-500")}>Monthly</span>
        <button
          type="button"
          role="switch"
          aria-checked={yearly}
          aria-label="Toggle yearly billing"
          onClick={() => setYearly((v) => !v)}
          className={cn(
            "relative h-6 w-11 rounded-full transition-colors",
            yearly ? "bg-gradient-to-r from-blue-600 to-violet-600" : "bg-white/10 light:bg-slate-300"
          )}
        >
          <span className={cn("absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all", yearly ? "left-[22px]" : "left-0.5")} />
        </button>
        <span className={cn("text-sm font-medium transition-colors", yearly ? "text-white light:text-slate-900" : "text-slate-500")}>
          Yearly
          <span className="ml-1.5 rounded-full bg-emerald-400/15 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-emerald-300 light:bg-emerald-500/10 light:text-emerald-700">
            ~2 months free
          </span>
        </span>
      </div>

      {/* cards */}
      <div className={cn(
        "mt-10 grid gap-4",
        plans.length === 1 && "mx-auto max-w-md",
        plans.length === 2 && "mx-auto max-w-2xl md:grid-cols-2",
        plans.length === 3 && "mx-auto max-w-5xl md:grid-cols-3",
        plans.length >= 4 && "md:grid-cols-2 xl:grid-cols-4"
      )}>
        {plans.map((p) => {
          const price = yearly ? p.yearlyPrice : p.monthlyPrice
          const per = yearly ? "/year" : "/month"
          const highlighted = !!p.badge
          return (
            <div
              key={p.id}
              data-cursor="card"
              className={cn(
                "relative flex flex-col rounded-2xl border p-6 transition-all hover:-translate-y-0.5",
                highlighted
                  ? "border-indigo-400/50 bg-gradient-to-b from-indigo-600/15 to-transparent shadow-xl shadow-indigo-950/40 light:border-indigo-500/60 light:from-indigo-500/10 light:shadow-indigo-900/10"
                  : "border-white/10 bg-white/[0.03] light:border-slate-200 light:bg-white light:shadow-sm"
              )}
            >
              {p.badge && (
                <span className="absolute -top-3 left-6 rounded-full bg-gradient-to-r from-blue-600 to-violet-600 px-3 py-1 text-[10px] font-bold uppercase tracking-widest text-white shadow-lg">
                  {p.badge}
                </span>
              )}
              <h3 className="text-lg font-bold text-white light:text-slate-900">{p.name}</h3>
              <p className="mt-1 min-h-10 text-[13px] leading-relaxed text-slate-400 light:text-slate-600">{p.tagline || p.description?.slice(0, 90) || ""}</p>
              <p className="mt-5 flex items-baseline gap-1">
                <span className="text-4xl font-bold tracking-tight text-white light:text-slate-900">{money(price, p.currency)}</span>
                <span className="text-sm text-slate-500">{per}</span>
              </p>
              {(yearly ? p.monthlyPrice * 12 : p.yearlyPrice) > 0 && (
                <p className="mt-1 text-[11px] text-slate-500">
                  {yearly
                    ? `equivalent to ${money(Math.round(p.yearlyPrice / 12), p.currency)}/month`
                    : p.yearlyPrice > 0 ? `yearly: ${money(p.yearlyPrice, p.currency)} (${Math.round((1 - p.yearlyPrice / (p.monthlyPrice * 12)) * 100)}% off)` : "yearly billing available"}
                </p>
              )}
              <Link
                href={`/register?plan=${p.id}${yearly ? "&cycle=YEARLY" : ""}`}
                data-cursor={highlighted ? "magnetic" : "link"}
                className={cn(
                  "mt-5 inline-flex h-10 items-center justify-center gap-2 rounded-xl text-sm font-semibold transition-all",
                  highlighted
                    ? "bg-gradient-to-r from-blue-600 to-violet-600 text-white hover:from-blue-500 hover:to-violet-500"
                    : "border border-white/15 text-white hover:bg-white/5 light:border-slate-300 light:text-slate-800 light:hover:bg-slate-100"
                )}
              >
                {p.isTrialPlan ? "Start free" : "Choose plan"} <ArrowRight className="h-4 w-4" />
              </Link>

              <div className="mt-6 space-y-2 border-t border-white/10 pt-5 text-[13px] light:border-slate-200">
                <p className="text-[11px] font-bold uppercase tracking-widest text-slate-500">Capacity limits</p>
                <Row label="Employees" value={limitCell(p.limits.employeeLimit)} />
                <Row label="Users" value={limitCell(p.limits.userLimit)} />
                <Row label="Branches" value={limitCell(p.limits.branchLimit)} />
                <Row label="Departments" value={limitCell(p.limits.departmentLimit)} />
                <Row label="Attendance devices" value={limitCell(p.limits.deviceLimit)} />
                <Row label="Storage" value={limitCell(p.limits.storageGb, " GB")} />
                <Row label="Live-tracking employees" value={limitCell(p.limits.trackingEmployeeLimit)} />
                <p className="pt-2 text-[11px] font-bold uppercase tracking-widest text-slate-500">Modules</p>
                {FEATURE_ROWS.map((f) => (
                  <Row key={f.key} label={f.label} value={p.features[f.key] ? "included" : "—"} ok={!!p.features[f.key]} />
                ))}
                <Row label="Support" value={p.supportLevel.toLowerCase()} />
              </div>
            </div>
          )
        })}
      </div>

      <p className="mt-8 text-center text-xs text-slate-500">
        Prices and limits come from the platform database and are set by the operator — nothing on this page is
        hardcoded. “Unlimited” reflects the operator&apos;s plan configuration; fair-use still applies.
      </p>
    </div>
  )
}

function Row({ label, value, ok }: { label: string; value: string; ok?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-slate-400 light:text-slate-600">{label}</span>
      {ok === true ? (
        <span className="flex items-center gap-1 text-[12px] font-medium text-emerald-300 light:text-emerald-700">
          <Check className="h-3 w-3" /> {value}
        </span>
      ) : ok === false ? (
        <span className="flex items-center gap-1 text-[12px] font-medium text-slate-600 light:text-slate-400">
          <Minus className="h-3 w-3" />
        </span>
      ) : (
        <span className="text-[12px] font-medium tabular-nums text-slate-200 light:text-slate-800">{value}</span>
      )}
    </div>
  )
}

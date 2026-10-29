"use client"
// ============ Owner console UI primitives ============
import type { ReactNode } from "react"
import { AlertTriangle, Loader2 } from "lucide-react"
import { cn } from "@/lib/utils"

export function PageHeader({ title, sub, actions }: { title: ReactNode; sub?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-xl font-bold tracking-tight text-white light:text-slate-900">{title}</h1>
        {sub && <p className="mt-1 text-sm text-slate-400 light:text-slate-600">{sub}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  )
}

export function KpiCard({ label, value, sub, tone = "default", icon: Icon }: {
  label: string; value: ReactNode; sub?: ReactNode; tone?: "default" | "emerald" | "amber" | "red" | "indigo"; icon?: any
}) {
  const toneCls = {
    default: "text-white light:text-slate-900",
    emerald: "text-emerald-300 light:text-emerald-700",
    amber: "text-amber-300 light:text-amber-700",
    red: "text-red-300 light:text-red-600",
    indigo: "text-indigo-300 light:text-indigo-700",
  }[tone]
  return (
    <div className="rounded-2xl border border-white/10 light:border-slate-200 bg-white/[0.03] light:bg-slate-100/60 p-5">
      <div className="flex items-center justify-between">
        <p className="text-[11px] font-bold uppercase tracking-widest text-slate-500">{label}</p>
        {Icon && <Icon className="h-4 w-4 text-slate-600 light:text-slate-500" />}
      </div>
      <p className={cn("mt-2 text-3xl font-bold tabular-nums tracking-tight", toneCls)}>{value}</p>
      {sub && <p className="mt-1 text-xs text-slate-500">{sub}</p>}
    </div>
  )
}

export function Glass({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("rounded-2xl border border-white/10 light:border-slate-200 bg-white/[0.03] light:bg-slate-100/60 p-5", className)}>{children}</div>
}

export function StatusChip({ status }: { status: string }) {
  const map: Record<string, string> = {
    PENDING: "border-amber-400/40 bg-amber-500/10 text-amber-300 light:text-amber-700",
    UNDER_REVIEW: "border-blue-400/40 bg-blue-500/10 text-blue-300 light:text-blue-700",
    APPROVED: "border-emerald-400/40 bg-emerald-500/10 text-emerald-300 light:text-emerald-700",
    REJECTED: "border-red-400/40 bg-red-500/10 text-red-300 light:text-red-600",
    SUSPENDED: "border-red-400/40 bg-red-500/10 text-red-300 light:text-red-600",
    CANCELLED: "border-slate-400/40 bg-slate-500/10 light:bg-slate-200 text-slate-400 light:text-slate-600",
    ACTIVE: "border-emerald-400/40 bg-emerald-500/10 text-emerald-300 light:text-emerald-700",
    TRIAL: "border-indigo-400/40 bg-indigo-500/10 text-indigo-300 light:text-indigo-700",
    PAST_DUE: "border-amber-400/40 bg-amber-500/10 text-amber-300 light:text-amber-700",
    GRACE_PERIOD: "border-blue-400/40 bg-blue-500/10 text-blue-300 light:text-blue-700",
    EXPIRED: "border-red-400/40 bg-red-500/10 text-red-300 light:text-red-600",
    LEGACY: "border-slate-400/40 bg-slate-500/10 light:bg-slate-200 text-slate-400 light:text-slate-600",
    MONTHLY: "border-slate-400/40 bg-slate-500/10 light:bg-slate-200 text-slate-300 light:text-slate-700",
    YEARLY: "border-violet-400/40 bg-violet-500/10 text-violet-300 light:text-violet-700",
  }
  return (
    <span className={cn("inline-flex items-center rounded-full border px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-widest", map[status] || "border-slate-400/40 bg-slate-500/10 light:bg-slate-200 text-slate-300 light:text-slate-700")}>
      {status.replace(/_/g, " ")}
    </span>
  )
}

export function TableShell({ headers, children, empty }: { headers: string[]; children: ReactNode; empty?: boolean }) {
  return (
    <div className="overflow-x-auto rounded-2xl border border-white/10 light:border-slate-200">
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="border-b border-white/10 light:border-slate-200 bg-white/[0.02] light:bg-slate-50">
            {headers.map((h) => (
              <th key={h} className="whitespace-nowrap px-4 py-3 text-[11px] font-bold uppercase tracking-widest text-slate-500">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-white/5 light:divide-slate-200">
          {empty ? (
            <tr>
              <td colSpan={headers.length} className="px-4 py-10 text-center text-sm text-slate-500">
                Nothing here yet.
              </td>
            </tr>
          ) : (
            children
          )}
        </tbody>
      </table>
    </div>
  )
}

export function Td({ children, className }: { children: ReactNode; className?: string }) {
  return <td className={cn("whitespace-nowrap px-4 py-3 text-slate-300 light:text-slate-700", className)}>{children}</td>
}

export function Loading({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-3 py-16 text-sm text-slate-500">
      <Loader2 className="h-4 w-4 animate-spin" /> {label}
    </div>
  )
}

export function ErrorBanner({ message }: { message: string }) {
  return (
    <div role="alert" className="flex items-start gap-3 rounded-xl border border-red-400/30 bg-red-500/10 p-4 text-sm text-red-300 light:text-red-600">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
      {message}
    </div>
  )
}

export function fmtDate(d?: string | Date | null): string {
  if (!d) return "—"
  const dt = typeof d === "string" ? new Date(d) : d
  return dt.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })
}

export function fmtDateTime(d?: string | Date | null): string {
  if (!d) return "—"
  const dt = typeof d === "string" ? new Date(d) : d
  return dt.toLocaleString("en-GB", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" })
}

export function gb(bytes: number): string {
  return (bytes / 1024 ** 3).toFixed(2)
}

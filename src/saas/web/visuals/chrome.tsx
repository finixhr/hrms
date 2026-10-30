"use client"
// ============ Shared chrome for the 12 marketing feature visuals ============
// Every simulation floats in the same "app window" — traffic-light dots, a
// fake browser tab and a soft gradient glow behind the frame. Chip / StatusDot
// / Meter / Panel / Ring keep the twelve windows visually consistent. All
// surfaces carry paired light: utilities so the miniature re-skins together
// with the page when the .dark class is absent (see src/app/globals.css).
import type { CSSProperties, ReactNode } from "react"
import type { LucideIcon } from "lucide-react"
import { cn } from "@/lib/utils"

export type ChipTone = "emerald" | "amber" | "rose" | "slate" | "indigo" | "cyan" | "violet"

/* ---------- status chip ---------- */
const CHIP_TONES: Record<ChipTone, string> = {
  emerald: "border-emerald-400/30 bg-emerald-400/10 text-emerald-300 light:border-emerald-500/30 light:bg-emerald-500/10 light:text-emerald-700",
  amber: "border-amber-400/30 bg-amber-400/10 text-amber-300 light:border-amber-500/40 light:bg-amber-500/10 light:text-amber-700",
  rose: "border-rose-400/30 bg-rose-400/10 text-rose-300 light:border-rose-500/30 light:bg-rose-500/10 light:text-rose-700",
  slate: "border-white/15 bg-white/5 text-slate-400 light:border-slate-300 light:bg-slate-100 light:text-slate-600",
  indigo: "border-indigo-400/30 bg-indigo-400/10 text-indigo-300 light:border-indigo-500/30 light:bg-indigo-500/10 light:text-indigo-700",
  cyan: "border-cyan-400/30 bg-cyan-400/10 text-cyan-300 light:border-cyan-500/30 light:bg-cyan-500/10 light:text-cyan-700",
  violet: "border-violet-400/30 bg-violet-400/10 text-violet-300 light:border-violet-500/30 light:bg-violet-500/10 light:text-violet-700",
}

export function Chip({ tone = "slate", children, className }: {
  tone?: ChipTone; children: ReactNode; className?: string
}) {
  return (
    <span className={cn(
      "inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-1.5 py-px text-[9px] font-bold uppercase tracking-wider",
      CHIP_TONES[tone], className,
    )}>
      {children}
    </span>
  )
}

/* ---------- plain-text tone (labels, deltas, values) ---------- */
export const TONE_TEXT: Record<ChipTone, string> = {
  emerald: "text-emerald-400 light:text-emerald-600",
  amber: "text-amber-400 light:text-amber-600",
  rose: "text-rose-400 light:text-rose-600",
  slate: "text-slate-500 light:text-slate-500",
  indigo: "text-indigo-300 light:text-indigo-600",
  cyan: "text-cyan-400 light:text-cyan-600",
  violet: "text-violet-300 light:text-violet-600",
}

/* ---------- pulsing status dot ---------- */
const DOT_TONES: Record<ChipTone, string> = {
  emerald: "bg-emerald-400", amber: "bg-amber-400", rose: "bg-rose-400", slate: "bg-slate-400",
  indigo: "bg-indigo-400", cyan: "bg-cyan-400", violet: "bg-violet-400",
}

export function StatusDot({ tone = "emerald", pulse = false, className }: {
  tone?: ChipTone; pulse?: boolean; className?: string
}) {
  return (
    <span className={cn("relative flex h-1.5 w-1.5 shrink-0", className)}>
      {pulse && <span className={cn("absolute inline-flex h-full w-full animate-ping rounded-full opacity-60", DOT_TONES[tone])} />}
      <span className={cn("relative inline-flex h-full w-full rounded-full", DOT_TONES[tone])} />
    </span>
  )
}

/* ---------- floating app window ---------- */
export function WindowChrome({ title, children, className, contentClassName, glow = "bg-indigo-600/20" }: {
  title: ReactNode; children: ReactNode; className?: string; contentClassName?: string; glow?: string
}) {
  return (
    <div className={cn("relative", className)}>
      <div aria-hidden className={cn("pointer-events-none absolute -inset-5 rounded-[28px] blur-2xl light:opacity-50", glow)} />
      <div className="relative overflow-hidden rounded-2xl border border-white/15 bg-slate-900/95 shadow-2xl shadow-black/50 backdrop-blur-xl light:border-slate-200 light:bg-white light:shadow-xl light:shadow-slate-900/10">
        <div className="flex items-center gap-1.5 border-b border-white/10 bg-white/[0.03] px-3 py-2 light:border-slate-200 light:bg-slate-50">
          <span className="h-2.5 w-2.5 rounded-full bg-rose-500/80" />
          <span className="h-2.5 w-2.5 rounded-full bg-amber-400/80" />
          <span className="h-2.5 w-2.5 rounded-full bg-emerald-400/80" />
          <span className="ml-2 flex h-6 min-w-0 flex-1 items-center truncate rounded-md bg-white/5 px-2 text-[10px] font-medium text-slate-400 light:bg-slate-100 light:text-slate-500">
            {title}
          </span>
        </div>
        <div className={cn("p-3 sm:p-4", contentClassName)}>{children}</div>
      </div>
    </div>
  )
}

/* ---------- titled inner panel ---------- */
export function Panel({ title, icon: Icon, children, className, action }: {
  title?: ReactNode; icon?: LucideIcon; children: ReactNode; className?: string; action?: ReactNode
}) {
  return (
    <section className={cn(
      "rounded-xl border border-white/10 bg-white/[0.03] p-2.5 light:border-slate-200 light:bg-white light:shadow-sm",
      className,
    )}>
      {(title !== undefined || action) && (
        <header className="mb-2 flex items-center gap-1.5">
          {Icon && <Icon className="h-3 w-3 shrink-0 text-indigo-300 light:text-indigo-600" />}
          {title !== undefined && (
            <h3 className="truncate text-[10px] font-bold uppercase tracking-widest text-slate-500">{title}</h3>
          )}
          {action && <div className="ml-auto shrink-0">{action}</div>}
        </header>
      )}
      {children}
    </section>
  )
}

/* ---------- initials avatar ---------- */
export function Avatar({ initials, className }: { initials: string; className?: string }) {
  return (
    <span className={cn(
      "flex h-7 w-7 shrink-0 select-none items-center justify-center rounded-full bg-gradient-to-br from-indigo-500 to-violet-600 text-[9px] font-bold text-white shadow-sm",
      className,
    )}>
      {initials}
    </span>
  )
}

/* ---------- progress meter (fills on mount via fv-fill-x) ---------- */
const METER_TONES: Record<ChipTone, string> = {
  emerald: "bg-emerald-400 light:bg-emerald-500",
  amber: "bg-amber-400 light:bg-amber-500",
  rose: "bg-rose-400 light:bg-rose-500",
  slate: "bg-slate-400",
  indigo: "bg-indigo-400 light:bg-indigo-500",
  cyan: "bg-cyan-400 light:bg-cyan-500",
  violet: "bg-violet-400 light:bg-violet-500",
}

export function Meter({ value, tone = "indigo", className }: { value: number; tone?: ChipTone; className?: string }) {
  const v = Math.min(100, Math.max(0, value))
  return (
    <div className={cn("h-1.5 overflow-hidden rounded-full bg-white/10 light:bg-slate-200", className)}>
      <div className={cn("fv-fill-x h-full rounded-full", METER_TONES[tone])} style={{ width: `${v}%` }} />
    </div>
  )
}

/* ---------- score ring (draws itself via fv-ring + CSS vars) ---------- */
export function Ring({ value, size = 84, stroke = 8, color = "#6366f1", label, sub }: {
  value: number; size?: number; stroke?: number; color?: string; label?: ReactNode; sub?: string
}) {
  const r = (size - stroke) / 2
  const circ = 2 * Math.PI * r
  const off = circ * (1 - Math.min(100, Math.max(0, value)) / 100)
  return (
    <div className="relative inline-flex shrink-0 items-center justify-center" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth={stroke} className="stroke-white/10 light:stroke-slate-200" />
        <circle
          cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth={stroke} stroke={color} strokeLinecap="round"
          strokeDasharray={circ} strokeDashoffset={off} className="fv-ring"
          style={{ "--fv-circ": circ, "--fv-off": off } as CSSProperties}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-sm font-bold tabular-nums text-white light:text-slate-900">{label ?? value}</span>
        {sub && <span className="text-[8px] font-semibold uppercase tracking-widest text-slate-500">{sub}</span>}
      </div>
    </div>
  )
}

/* ---------- shared chart styling ---------- */
export const CHART_TOOLTIP_STYLE: CSSProperties = {
  fontSize: 10,
  borderRadius: 8,
  border: "1px solid rgba(148,163,184,0.25)",
  background: "rgba(15,23,42,0.94)",
  color: "#e2e8f0",
  padding: "3px 8px",
  boxShadow: "0 10px 30px rgba(0,0,0,0.35)",
}

export const FV = {
  indigo: "#6366f1", violet: "#8b5cf6", cyan: "#06b6d4", emerald: "#10b981",
  amber: "#f59e0b", rose: "#f43f5e", slate: "#64748b",
} as const

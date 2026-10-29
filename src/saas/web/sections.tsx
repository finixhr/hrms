// ============ Marketing primitives shared by all public pages (server) ============
import Link from "next/link"
import type { ReactNode } from "react"
import { Activity, ArrowRight, Building2, Layers, Scaling, ShieldCheck } from "lucide-react"
import { HOW_IT_WORKS, VALUE_PROPS } from "./site"
import { cn } from "@/lib/utils"

// ---------- section heading ----------
export function SectionHeading({
  eyebrow, title, sub, align = "center",
}: {
  eyebrow?: string
  title: ReactNode
  sub?: ReactNode
  align?: "center" | "left"
}) {
  return (
    <div className={cn("max-w-3xl", align === "center" && "mx-auto text-center")}>
      {eyebrow && (
        <p className="text-xs font-bold uppercase tracking-[0.2em] text-indigo-300 light:text-indigo-600">
          {eyebrow}
        </p>
      )}
      <h2 className="mt-3 text-3xl font-bold tracking-tight text-balance text-white light:text-slate-900 sm:text-4xl">
        {title}
      </h2>
      {sub && (
        <p className="mt-4 text-base leading-relaxed text-slate-400 light:text-slate-600">
          {sub}
        </p>
      )}
    </div>
  )
}

// ---------- gradient text ----------
export function Grad({ children }: { children: ReactNode }) {
  return (
    <span className="bg-gradient-to-r from-blue-400 via-indigo-400 to-violet-400 bg-clip-text text-transparent light:from-blue-600 light:via-indigo-600 light:to-violet-600">
      {children}
    </span>
  )
}

// ---------- primary CTA band ----------
export function CtaBand({
  title = "Start Your HR Journey",
  sub = "Register your organization in about five minutes. No payment information — a platform administrator reviews every application before workspaces go live.",
}: { title?: string; sub?: string }) {
  return (
    <section className="relative overflow-hidden border-y border-white/10 bg-slate-950 light:border-slate-200 light:bg-slate-50">
      <div aria-hidden className="pointer-events-none absolute inset-0">
        <div className="absolute left-1/2 top-0 h-[420px] w-[820px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-indigo-600/20 blur-3xl light:opacity-60" />
      </div>
      <div className="relative mx-auto max-w-4xl px-4 py-20 text-center sm:px-6">
        <h2 className="text-3xl font-bold tracking-tight text-white light:text-slate-900 sm:text-4xl">{title}</h2>
        <p className="mx-auto mt-4 max-w-2xl text-base leading-relaxed text-slate-400 light:text-slate-600">{sub}</p>
        <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
          <Link
            href="/register"
            data-cursor="magnetic"
            className="inline-flex h-11 items-center gap-2 rounded-xl bg-gradient-to-r from-blue-600 to-violet-600 px-6 text-sm font-semibold text-white shadow-lg shadow-indigo-950/60 transition-all hover:from-blue-500 hover:to-violet-500"
          >
            Register your organization <ArrowRight className="h-4 w-4" />
          </Link>
          <Link
            href="/pricing"
            className="inline-flex h-11 items-center rounded-xl border border-white/15 px-6 text-sm font-semibold text-white transition-colors hover:bg-white/5 light:border-slate-300 light:text-slate-800 light:hover:bg-slate-100"
          >
            View pricing
          </Link>
        </div>
        <p className="mt-6 text-xs text-slate-500">
          Already applied? <Link href="/registration-status" className="text-indigo-300 hover:text-indigo-200 light:text-indigo-600 light:hover:text-indigo-500">Track your application status</Link>
        </p>
      </div>
    </section>
  )
}

// ---------- value props strip ----------
const VALUE_ICONS: Record<string, any> = {
  layers: Layers, building: Building2, activity: Activity, shield: ShieldCheck, scaling: Scaling,
}

export function ValueProps() {
  return (
    <section className="border-y border-white/10 bg-slate-950 light:border-slate-200 light:bg-slate-50">
      <div className="mx-auto max-w-7xl px-4 py-16 sm:px-6">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
          {VALUE_PROPS.map((v) => {
            const Icon = VALUE_ICONS[v.icon] ?? Layers
            return (
              <div
                key={v.title}
                className="rounded-2xl border border-white/10 bg-white/[0.03] p-5 transition-colors hover:border-white/20 hover:bg-white/[0.05] light:border-slate-200 light:bg-white light:shadow-sm light:hover:border-slate-300"
              >
                <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-gradient-to-br from-blue-500/20 to-violet-500/20 ring-1 ring-white/10 light:ring-slate-200">
                  <Icon className="h-4.5 w-4.5 text-indigo-300 light:text-indigo-600" />
                </span>
                <h3 className="mt-4 text-[15px] font-bold text-white light:text-slate-900">{v.title}</h3>
                <p className="mt-2 text-[13px] leading-relaxed text-slate-400 light:text-slate-600">{v.body}</p>
              </div>
            )
          })}
        </div>
      </div>
    </section>
  )
}

// ---------- how it works ----------
export function HowItWorks() {
  return (
    <section className="bg-slate-950 light:bg-white">
      <div className="mx-auto max-w-7xl px-4 py-20 sm:px-6">
        <SectionHeading
          eyebrow="How it works"
          title="From application to workspace in four steps"
          sub="Every organization on the platform goes through the same transparent review — you always know exactly where your application stands."
        />
        <div className="relative mt-12 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          {HOW_IT_WORKS.map((s, i) => (
            <div key={s.step} className="relative rounded-2xl border border-white/10 bg-white/[0.03] p-6 light:border-slate-200 light:bg-white light:shadow-sm">
              <span className="flex h-9 w-9 items-center justify-center rounded-full bg-gradient-to-br from-blue-600 to-violet-600 text-sm font-bold text-white shadow-lg shadow-indigo-950/50">
                {s.step}
              </span>
              <h3 className="mt-4 text-[15px] font-bold text-white light:text-slate-900">{s.title}</h3>
              <p className="mt-2 text-[13px] leading-relaxed text-slate-400 light:text-slate-600">{s.body}</p>
              {i < HOW_IT_WORKS.length - 1 && (
                <ArrowRight aria-hidden className="absolute -right-3.5 top-1/2 hidden h-6 w-6 -translate-y-1/2 rounded-full border border-white/10 bg-slate-900 p-1 text-slate-500 light:border-slate-200 light:bg-white light:text-slate-400 xl:block" />
              )}
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}

// ---------- glass panel ----------
export function GlassPanel({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn(
      "rounded-2xl border border-white/10 bg-white/[0.04] backdrop-blur-xl light:border-slate-200 light:bg-white light:shadow-sm light:backdrop-blur-none",
      className
    )}>
      {children}
    </div>
  )
}

// ---------- stats strip (capability facts, never fake customer counts) ----------
export function CapabilityStrip() {
  const items: { value: string; label: string }[] = [
    { value: "14", label: "approval workflow types" },
    { value: "7", label: "system roles + custom roles" },
    { value: "8+", label: "statutory BD leave types" },
    { value: "12+", label: "HR modules in one workspace" },
    { value: "1", label: "sign-in for your whole team" },
  ]
  return (
    <section className="border-y border-white/10 bg-slate-950 light:border-slate-200 light:bg-slate-50">
      <div className="mx-auto max-w-7xl px-4 py-10 sm:px-6">
        <div className="grid grid-cols-2 gap-6 sm:grid-cols-3 lg:grid-cols-5">
          {items.map((s) => (
            <div key={s.label} className="text-center">
              <p className="bg-gradient-to-r from-blue-400 to-violet-400 bg-clip-text text-3xl font-bold tabular-nums text-transparent light:from-blue-600 light:to-violet-600">
                {s.value}
              </p>
              <p className="mt-1 text-xs text-slate-400 light:text-slate-600">{s.label}</p>
            </div>
          ))}
        </div>
        <p className="mt-6 text-center text-[11px] text-slate-500">
          Capability facts about the product — we do not display invented customer or usage statistics.
        </p>
      </div>
    </section>
  )
}

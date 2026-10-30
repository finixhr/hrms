"use client"
// ============ Post-approval onboarding checklist (2026-10-04) ==================
// Renders on the HR dashboard for VENDOR_OWNER / HR_ADMIN while setup steps
// remain. Steps are computed LIVE server-side (onboarding.status) from real DB
// rows — never client-side guessing — and each item links to the module that
// completes it. Dismissal persists per vendor (HrSetting group "onboarding").
// The card hides itself automatically once everything is done.
import { useEffect, useState } from "react"
import {
  Building2, Users, CalendarClock, UserPlus, UserCog, ShieldCheck,
  CheckCircle2, Circle, X, Loader2,
} from "lucide-react"
import { useHrm } from "../store"
import { rpc } from "../api"

const ICONS: Record<string, any> = {
  branch: Building2, department: Users, designation: UserCog,
  employee: UserPlus, shift: CalendarClock, colleague: Users, mfa: ShieldCheck,
}

type Step = {
  key: string
  label: string
  description: string
  view: string
  done: boolean
  optional?: boolean
}

export function OnboardingChecklist() {
  const user = useHrm((s) => s.user)
  const navigate = useHrm((s) => s.navigate)
  const [data, setData] = useState<{
    steps: Step[]; completed: number; total: number
    dismissedAt: string | null; canDismiss: boolean
  } | null>(null)
  const [loading, setLoading] = useState(true)
  const [hidden, setHidden] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!user) return
    let cancelled = false
    setLoading(true)
    rpc<any>("onboarding.status", {})
      .then((d) => { if (!cancelled) setData(d) })
      .catch(() => { if (!cancelled) setData(null) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [user])

  if (loading || !data || hidden) return null
  // admins only; auto-hide when everything is done; respect dismissal
  const isAdmin = user?.role === "VENDOR_OWNER" || user?.role === "HR_ADMIN"
  if (!isAdmin || data.dismissedAt || data.completed >= data.total) return null

  const dismiss = async () => {
    setBusy(true)
    try {
      await rpc("onboarding.dismiss", {})
      setHidden(true)
    } catch { /* keep the card on failure */ } finally { setBusy(false) }
  }

  const pct = Math.round((data.completed / data.total) * 100)

  return (
    <section className="rounded-xl border border-emerald-200 bg-gradient-to-br from-emerald-50 to-teal-50/50 p-4 dark:border-emerald-900/50 dark:from-emerald-950/40 dark:to-teal-950/20">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-bold text-slate-800 dark:text-slate-100">
            Set up your workspace
            <span className="ml-2 rounded-full bg-primary px-2 py-0.5 text-[10px] font-bold text-white">{data.completed}/{data.total}</span>
          </p>
          <p className="mt-0.5 text-xs text-slate-600 dark:text-slate-400">
            Your workspace was provisioned with approvals, leave types and tax config ready. Finish these steps to go live.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <div className="hidden h-2 w-28 overflow-hidden rounded-full bg-emerald-100 dark:bg-emerald-900/60 sm:block">
            <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${pct}%` }} />
          </div>
          {data.canDismiss && (
            <button
              type="button" onClick={dismiss} disabled={busy}
              aria-label="Dismiss the setup checklist"
              title="Dismiss — you can finish setup anytime from the modules"
              className="rounded-md p-1 text-slate-400 transition-colors hover:bg-white/60 hover:text-slate-700 dark:hover:bg-slate-800 dark:hover:text-slate-200"
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <X className="h-4 w-4" />}
            </button>
          )}
        </div>
      </div>

      <div className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
        {data.steps.map((s) => {
          const Icon = ICONS[s.key] || Circle
          return (
            <button
              key={s.key}
              type="button"
              onClick={() => navigate(s.view)}
              className={`group flex items-start gap-2.5 rounded-lg border p-2.5 text-left transition-colors ${
                s.done
                  ? "border-emerald-200 bg-white/70 dark:border-emerald-900/40 dark:bg-emerald-950/30"
                  : "border-slate-200 bg-white hover:border-emerald-400 hover:bg-emerald-50/50 dark:border-slate-800 dark:bg-slate-900 dark:hover:border-emerald-700"
              }`}
            >
              <span className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md ${
                s.done ? "bg-primary text-primary-foreground" : "bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400"
              }`}>
                {s.done ? <CheckCircle2 className="h-4 w-4" /> : <Icon className="h-3.5 w-3.5" />}
              </span>
              <span className="min-w-0">
                <span className={`block truncate text-xs font-semibold ${s.done ? "text-slate-500 line-through dark:text-slate-500" : "text-slate-800 dark:text-slate-200"}`}>
                  {s.label}
                  {s.optional && !s.done && <span className="ml-1.5 font-normal text-slate-400">(recommended)</span>}
                </span>
                <span className="mt-0.5 block text-[11px] leading-snug text-slate-500 dark:text-slate-400">{s.description}</span>
              </span>
            </button>
          )
        })}
      </div>
    </section>
  )
}

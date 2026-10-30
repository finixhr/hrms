"use client"
// ============ /owner/lifecycle — Lifecycle console (Phase 5 P1) ================
// The subscription lifecycle at a glance: stage cards (with honest share-of-
// fleet subs), the renewal pipeline horizon, fleet movement by event type
// (7d / 30d windows, straight from the append-only SaasSubscriptionEvent
// table), and the fleet-wide lifecycle event stream — paged in SQL, filtered
// in SQL, never post-filtered in JS. All numbers come from
// owner.lifecycle.overview / owner.lifecycle.events — nothing fabricated.
// Auto-refreshes the overview every 60 s; deep-links into the tenant pages.
import { useCallback, useEffect, useState } from "react"
import Link from "next/link"
import {
  ChevronLeft, ChevronRight, History, Loader2, RefreshCw, Search, Timer, Workflow,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { useOwnerApi, ownerRpc } from "@/saas/owner/client"
import { ErrorBanner, KpiCard, Loading, PageHeader, TableShell, Td, fmtDateTime } from "@/saas/owner/ui"
import { cn } from "@/lib/utils"

type Overview = {
  generatedAt: string
  stages: Record<string, number>
  pipeline: { OVERDUE: number; DUE_0_7: number; DUE_8_30: number; DUE_31_60: number }
  movement7d: { type: string; count: number }[]
  movement30d: { type: string; count: number }[]
  trials: { current: number; endingSoon21d: number }
}

type EventRow = {
  id: string; type: string; vendorId: string; vendorName: string; vendorCode: string
  note: string | null; actorName: string | null; createdAt: string
}

type EventsPage = { total: number; page: number; pageSize: number; rows: EventRow[] }

const EVENT_TYPES = [
  "ALL", "CREATED", "EXTENDED", "PLAN_CHANGED", "UPGRADED", "DOWNGRADED", "CYCLE_CHANGED",
  "PAST_DUE", "GRACE_APPLIED", "SUSPENDED", "REACTIVATED", "CANCELLED", "EXPIRED", "TRIAL_CONVERTED",
] as const

const STAGE_CARDS: { key: string; label: string; tone: "default" | "emerald" | "amber" | "red" | "indigo" }[] = [
  { key: "TRIAL", label: "Trial", tone: "indigo" },
  { key: "ACTIVE", label: "Active", tone: "emerald" },
  { key: "PAST_DUE", label: "Past due", tone: "amber" },
  { key: "GRACE_PERIOD", label: "Grace period", tone: "default" },
  { key: "EXPIRED", label: "Expired", tone: "red" },
  { key: "SUSPENDED", label: "Suspended", tone: "red" },
  { key: "CANCELLED", label: "Cancelled", tone: "default" },
  { key: "LEGACY", label: "Legacy (no sub)", tone: "default" },
]

const PIPELINE_CARDS: { key: keyof Overview["pipeline"]; label: string; hint: string; tone: "red" | "amber" | "default" }[] = [
  { key: "OVERDUE", label: "Overdue", hint: "term already ended — the daily sweep transitions them", tone: "red" },
  { key: "DUE_0_7", label: "Due ≤ 7 days", hint: "the renewal crunch window", tone: "amber" },
  { key: "DUE_8_30", label: "Due 8–30 days", hint: "reminder emails already firing", tone: "default" },
  { key: "DUE_31_60", label: "Due 31–60 days", hint: "early renewals + upgrade talks", tone: "default" },
]

const TYPE_STYLE: Record<string, string> = {
  CREATED: "border-emerald-400/40 bg-emerald-500/10 text-emerald-300 light:text-emerald-700",
  EXTENDED: "border-emerald-400/40 bg-emerald-500/10 text-emerald-300 light:text-emerald-700",
  REACTIVATED: "border-emerald-400/40 bg-emerald-500/10 text-emerald-300 light:text-emerald-700",
  UPGRADED: "border-emerald-400/40 bg-emerald-500/10 text-emerald-300 light:text-emerald-700",
  TRIAL_CONVERTED: "border-emerald-400/40 bg-emerald-500/10 text-emerald-300 light:text-emerald-700",
  PLAN_CHANGED: "border-blue-400/40 bg-blue-500/10 text-blue-300 light:text-blue-700",
  CYCLE_CHANGED: "border-blue-400/40 bg-blue-500/10 text-blue-300 light:text-blue-700",
  GRACE_APPLIED: "border-blue-400/40 bg-blue-500/10 text-blue-300 light:text-blue-700",
  DOWNGRADED: "border-amber-400/40 bg-amber-500/10 text-amber-300 light:text-amber-700",
  PAST_DUE: "border-amber-400/40 bg-amber-500/10 text-amber-300 light:text-amber-700",
  SUSPENDED: "border-rose-400/40 bg-rose-500/10 text-rose-300 light:text-rose-600",
  CANCELLED: "border-rose-400/40 bg-rose-500/10 text-rose-300 light:text-rose-600",
  EXPIRED: "border-rose-400/40 bg-rose-500/10 text-rose-300 light:text-rose-600",
}

export default function OwnerLifecyclePage() {
  const overview = useOwnerApi<Overview>("owner.lifecycle.overview")
  const [page, setPage] = useState(1)
  const [type, setType] = useState<string>("ALL")
  const [search, setSearch] = useState("")
  const [query, setQuery] = useState("")
  const [rows, setRows] = useState<EventRow[]>([])
  const [total, setTotal] = useState(0)
  const [pageSize] = useState(20)
  const [streamLoading, setStreamLoading] = useState(true)
  const [streamError, setStreamError] = useState<string | null>(null)

  // auto-refresh the overview every 60 s (interval cleaned up on unmount)
  useEffect(() => {
    const t = setInterval(() => { overview.reload().catch(() => {}) }, 60_000)
    return () => clearInterval(t)
  }, [overview.reload])

  const loadStream = useCallback(async () => {
    setStreamLoading(true)
    setStreamError(null)
    try {
      const d = await ownerRpc<EventsPage>("owner.lifecycle.events", { page, pageSize, type, search: query || undefined })
      setRows(d.rows)
      setTotal(d.total)
    } catch (e: unknown) {
      setStreamError((e as Error)?.message || "Failed to load the event stream")
    } finally {
      setStreamLoading(false)
    }
  }, [page, pageSize, type, query])

  useEffect(() => { loadStream().catch(() => {}) }, [loadStream])

  const totalPages = Math.max(1, Math.ceil(total / pageSize))
  const o = overview.data
  const fleetTotal = o ? Object.values(o.stages).reduce((a, b) => a + b, 0) : 0

  return (
    <div className="space-y-5">
      <PageHeader
        title={
          <span className="flex items-center gap-2.5">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-600 to-fuchsia-600 shadow-lg shadow-indigo-950/50">
              <Workflow className="h-4 w-4 text-white" />
            </span>
            Lifecycle Console
          </span>
        }
        sub="Where every tenant sits in the subscription lifecycle — stages, the renewal pipeline, fleet movement, and the append-only event stream. Transitions are applied by the daily sweep; manual actions live on each tenant's page."
        actions={
          <Button variant="outline" size="sm" onClick={() => { overview.reload().catch(() => {}); loadStream().catch(() => {}) }}
            disabled={overview.loading || streamLoading}
            className="h-9 border-white/10 light:border-slate-300 bg-white/5 light:bg-white text-white light:text-slate-900">
            {overview.loading || streamLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />} Refresh
          </Button>
        }
      />

      {overview.error && <ErrorBanner message={overview.error} />}

      {/* ---- stage cards ---- */}
      {overview.loading && !o ? (
        <Loading label="Reading the lifecycle…" />
      ) : o ? (
        <>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {STAGE_CARDS.map((s) => {
              const n = o.stages[s.key] ?? 0
              const share = fleetTotal > 0 ? Math.round((n / fleetTotal) * 100) : 0
              return (
                <KpiCard key={s.key} label={s.label} value={n.toLocaleString()} tone={s.tone}
                  sub={fleetTotal > 0 ? `${share}% of the fleet` : "—"} />
              )
            })}
          </div>

          {/* ---- renewal pipeline + trials ---- */}
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-6">
            {PIPELINE_CARDS.map((p) => (
              <div key={p.key} className={cn(
                "rounded-2xl border p-4",
                p.tone === "red" ? "border-rose-400/40 bg-rose-500/10"
                : p.tone === "amber" ? "border-amber-400/40 bg-amber-500/10"
                : "border-white/10 light:border-slate-200 bg-white/[0.03] light:bg-slate-100/60",
              )}>
                <div className="flex items-center justify-between">
                  <p className="text-[11px] font-bold uppercase tracking-widest text-slate-400 light:text-slate-600">{p.label}</p>
                  <Timer className={cn("h-4 w-4", p.tone === "red" ? "text-rose-400" : p.tone === "amber" ? "text-amber-400" : "text-slate-500")} />
                </div>
                <p className={cn("mt-1.5 text-2xl font-bold tabular-nums",
                  p.tone === "red" ? "text-rose-300 light:text-rose-600" : p.tone === "amber" ? "text-amber-300 light:text-amber-700" : "text-white light:text-slate-900")}>
                  {(o.pipeline[p.key] || 0).toLocaleString()}
                </p>
                <p className="mt-1 text-[11px] leading-relaxed text-slate-400 light:text-slate-600">{p.hint}</p>
              </div>
            ))}
            <div className="rounded-2xl border border-indigo-400/40 bg-indigo-500/10 p-4">
              <p className="text-[11px] font-bold uppercase tracking-widest text-indigo-300/80 light:text-indigo-700">Trials live</p>
              <p className="mt-1.5 text-2xl font-bold tabular-nums text-indigo-300 light:text-indigo-700">{o.trials.current.toLocaleString()}</p>
              <p className="mt-1 text-[11px] leading-relaxed text-slate-400 light:text-slate-600">
                {o.trials.endingSoon21d > 0
                  ? `${o.trials.endingSoon21d.toLocaleString()} ending ≤ 21 days — convert or lose them`
                  : "none ending within 21 days"}
              </p>
            </div>
            <div className="rounded-2xl border border-white/10 light:border-slate-200 bg-white/[0.03] light:bg-slate-100/60 p-4">
              <p className="text-[11px] font-bold uppercase tracking-widest text-slate-400 light:text-slate-600">Calendar</p>
              <p className="mt-1.5 text-sm font-semibold leading-snug text-white light:text-slate-900">
                <Link href="/owner/renewals" className="text-indigo-300 light:text-indigo-700 hover:text-indigo-200 light:hover:text-indigo-800">
                  Renewal calendar →
                </Link>
              </p>
              <p className="mt-1 text-[11px] leading-relaxed text-slate-400 light:text-slate-600">full window list with grace policy</p>
            </div>
          </div>

          {/* ---- fleet movement (7d / 30d) ---- */}
          <div className="rounded-2xl border border-white/10 light:border-slate-200 bg-white/[0.03] light:bg-slate-100/60 p-5">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <p className="text-sm font-bold text-white light:text-slate-900">Fleet movement</p>
              <p className="text-[11px] text-slate-500">append-only event history — the same rows the sweep and every manual action write</p>
            </div>
            {o.movement30d.length === 0 ? (
              <p className="mt-3 text-sm text-slate-500">No lifecycle events in the last 30 days.</p>
            ) : (
              <div className="mt-3 flex flex-wrap gap-2">
                {o.movement30d.map((m) => {
                  const d7 = o.movement7d.find((x) => x.type === m.type)?.count ?? 0
                  return (
                    <div key={m.type} className="flex items-center gap-2.5 rounded-xl border border-white/10 light:border-slate-200 bg-white/[0.02] light:bg-slate-50 px-3.5 py-2">
                      <span className={cn("rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-widest", TYPE_STYLE[m.type] || "border-white/15 light:border-slate-300 text-slate-400 light:text-slate-600")}>
                        {m.type.replace(/_/g, " ")}
                      </span>
                      <span className="text-sm font-bold tabular-nums text-white light:text-slate-900">{m.count.toLocaleString()}
                        <span className="ml-1 text-[11px] font-medium text-slate-500">/ 30d</span>
                      </span>
                      <span className="text-[11px] tabular-nums text-slate-500">{d7.toLocaleString()} in 7d</span>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        </>
      ) : null}

      {/* ---- event stream ---- */}
      <div className="rounded-2xl border border-white/10 light:border-slate-200 bg-white/[0.03] light:bg-slate-100/60">
        <div className="flex flex-wrap items-center gap-3 border-b border-white/10 light:border-slate-200 px-4 py-3.5 sm:px-5">
          <p className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-widest text-slate-500">
            <History className="h-3.5 w-3.5" /> Event stream
          </p>
          <Select value={type} onValueChange={(v) => { setType(v); setPage(1) }}>
            <SelectTrigger className="h-8 w-52 border-white/10 light:border-slate-300 bg-white/5 light:bg-white text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {EVENT_TYPES.map((t) => (
                <SelectItem key={t} value={t}>{t === "ALL" ? "All event types" : t.replace(/_/g, " ")}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <form className="ml-auto flex items-center gap-2" onSubmit={(e) => { e.preventDefault(); setQuery(search.trim()); setPage(1) }}>
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-500" />
              <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Tenant name or code…"
                className="h-9 w-56 border-white/10 light:border-slate-300 bg-white/5 light:bg-white pl-8 text-xs text-white light:text-slate-900" />
            </div>
            <Button type="submit" size="sm" className="h-9 bg-gradient-to-r from-indigo-600 to-fuchsia-600 text-white light:text-slate-900">Find</Button>
          </form>
        </div>

        {streamError && <div className="px-5 pt-4"><ErrorBanner message={streamError} /></div>}
        {streamLoading && rows.length === 0 ? (
          <Loading label="Loading the stream…" />
        ) : (
          <TableShell headers={["When", "Event", "Tenant", "Note", "By"]} empty={rows.length === 0}>
            {rows.map((r) => (
              <tr key={r.id} className="transition-colors hover:bg-white/[0.03] light:hover:bg-slate-100/70">
                <Td className="whitespace-nowrap">
                  <span className="flex flex-col">
                    <span className="text-xs text-slate-300 light:text-slate-700">{fmtDateTime(r.createdAt)}</span>
                  </span>
                </Td>
                <Td>
                  <span className={cn("inline-flex items-center rounded-full border px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-widest", TYPE_STYLE[r.type] || "border-white/15 light:border-slate-300 text-slate-400 light:text-slate-600")}>
                    {r.type.replace(/_/g, " ")}
                  </span>
                </Td>
                <Td>
                  <Link href={`/owner/tenants/${r.vendorId}`} className="flex flex-col">
                    <span className="font-semibold text-white light:text-slate-900 hover:text-indigo-300 light:hover:text-indigo-700">{r.vendorName}</span>
                    <span className="text-[11px] text-slate-500">{r.vendorCode}</span>
                  </Link>
                </Td>
                <Td className="max-w-md">
                  <span className="block truncate text-xs text-slate-300 light:text-slate-700" title={r.note || ""}>{r.note || "—"}</span>
                </Td>
                <Td className="text-xs text-slate-500">{r.actorName || "system"}</Td>
              </tr>
            ))}
          </TableShell>
        )}

        {/* pagination */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-white/10 light:border-slate-200 px-4 py-3 sm:px-5">
          <p className="text-xs text-slate-500">
            {total.toLocaleString()} event{total === 1 ? "" : "s"} · page {page} of {totalPages}
          </p>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" disabled={page <= 1 || streamLoading} onClick={() => setPage((p) => Math.max(1, p - 1))}
              className="h-8 border-white/10 light:border-slate-300 bg-white/5 light:bg-white text-white light:text-slate-900">
              <ChevronLeft className="h-3.5 w-3.5" /> Prev
            </Button>
            <Button variant="outline" size="sm" disabled={page >= totalPages || streamLoading} onClick={() => setPage((p) => p + 1)}
              className="h-8 border-white/10 light:border-slate-300 bg-white/5 light:bg-white text-white light:text-slate-900">
              Next <ChevronRight className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}

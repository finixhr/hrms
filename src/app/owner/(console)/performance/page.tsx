"use client"
// ============ /owner/performance — RPC performance panel (Phase 5 P0) ==========
// Live view of the in-memory metrics rings the platform already records for
// /api/metrics (Prometheus): per-module-family request counts, error rates,
// p50/p95 latency and a per-family sparkline, plus the scheduler-tick gauge.
// Source: owner.metrics.snapshot — a pure read of process memory (zero DB
// queries), so this page itself can never load the database it measures.
// Auto-refreshes every 15 s; note the honest "since process start / last 256
// observations" framing — these are RINGS, not permanent history.
import { useEffect, useMemo, useState } from "react"
import {
  Activity, AlertTriangle, ArrowDownUp, Gauge, Loader2, RefreshCw, Server, Timer, Zap,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { useOwnerApi } from "@/saas/owner/client"
import { ErrorBanner, Glass, KpiCard, Loading, PageHeader, TableShell, Td } from "@/saas/owner/ui"

type Family = {
  family: string
  count: number
  errors: number
  errorRate: number
  lastMs: number
  p50Ms: number
  p95Ms: number
  samples: number[]
}

type Snapshot = {
  generatedAt: string
  uptimeSeconds: number
  families: Family[]
  tick: { total: number; lastMs: number; p95Ms: number; lastVendors: number; lastAt: number | null }
}

function fmtUptime(s: number): string {
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (d > 0) return `${d}d ${h}h`
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}

/** Latency tone — the same thresholds the perf-budget CI gate uses (§11.1). */
function latencyTone(ms: number): string {
  if (ms <= 100) return "text-emerald-300 light:text-emerald-700"
  if (ms <= 500) return "text-amber-300 light:text-amber-700"
  return "text-rose-300 light:text-rose-600"
}

/** CSS sparkline of the family's ring (last 40 samples, oldest → newest). */
function Sparkline({ samples }: { samples: number[] }) {
  const data = useMemo(() => samples.slice(-40), [samples])
  if (data.length < 2) return <span className="text-[10px] text-slate-600">warming up…</span>
  const max = Math.max(...data, 1)
  return (
    <div className="flex h-6 items-end gap-[2px]" title={`last ${data.length} calls, peak ${Math.round(max)}ms`}>
      {data.map((v, i) => {
        const pct = Math.max(6, Math.round((v / max) * 100))
        const hot = v > 500
        return (
          <span key={i}
            className={`w-[3px] rounded-sm ${hot ? "bg-rose-400/80" : v > 100 ? "bg-amber-400/70" : "bg-blue-400/60"}`}
            style={{ height: `${pct}%` }} />
        )
      })}
    </div>
  )
}

/** p95 bar — width proportional to a 2s ceiling for visual comparison. */
function LatencyBar({ ms }: { ms: number }) {
  const pct = Math.min(100, Math.round((ms / 2000) * 100))
  const cls = ms <= 100 ? "bg-emerald-400/70" : ms <= 500 ? "bg-amber-400/70" : "bg-rose-400/70"
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 w-16 overflow-hidden rounded-full bg-white/10 light:bg-slate-200">
        <div className={`h-full rounded-full ${cls}`} style={{ width: `${pct}%` }} />
      </div>
      <span className={`w-16 text-right text-xs font-semibold tabular-nums ${latencyTone(ms)}`}>{ms} ms</span>
    </div>
  )
}

export default function OwnerPerformancePage() {
  const { data, loading, error, reload } = useOwnerApi<Snapshot>("owner.metrics.snapshot")
  const [sortDesc, setSortDesc] = useState(true)

  // auto-refresh every 15 s — rings move fast; the read is memory-only
  useEffect(() => {
    const t = setInterval(() => { reload().catch(() => {}) }, 15_000)
    return () => clearInterval(t)
  }, [reload])

  const families = useMemo(() => {
    if (!data) return []
    const sorted = [...data.families].sort((a, b) => (sortDesc ? b.p95Ms - a.p95Ms : a.p95Ms - b.p95Ms))
    return sorted
  }, [data, sortDesc])

  const totals = useMemo(() => ({
    requests: data?.families.reduce((a, f) => a + f.count, 0) ?? 0,
    errors: data?.families.reduce((a, f) => a + f.errors, 0) ?? 0,
    worstP95: data?.families[0]?.p95Ms ?? 0,
  }), [data])

  return (
    <div className="space-y-5">
      <PageHeader
        title={
          <span className="flex items-center gap-2.5">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-blue-600 to-violet-600 shadow-lg shadow-indigo-950/50">
              <Gauge className="h-4 w-4 text-white" />
            </span>
            Performance
          </span>
        }
        sub="Live RPC latency by module family — p50 / p95 over the most recent observations per family, error rates, and the scheduler-tick gauge. Pure in-memory read: viewing this page never queries the database."
        actions={
          <Button variant="outline" size="sm" onClick={() => { reload().catch(() => {}) }} disabled={loading}
            className="h-9 border-white/10 light:border-slate-300 bg-white/5 light:bg-white text-white light:text-slate-900">
            {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />} Refresh
          </Button>
        }
      />

      {error && <ErrorBanner message={error} />}
      {loading && !data ? (
        <Loading label="Reading the metrics rings…" />
      ) : data ? (
        <>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <KpiCard label="Uptime" value={fmtUptime(data.uptimeSeconds)} icon={Server}
              sub={`since process start · ${new Date(data.generatedAt).toLocaleTimeString()}`} />
            <KpiCard label="RPC requests" value={totals.requests.toLocaleString()} icon={Activity} tone="indigo"
              sub={`${data.families.length} module families observed`} />
            <KpiCard label="Errors" value={totals.errors.toLocaleString()} icon={AlertTriangle}
              tone={totals.errors > 0 ? "red" : "emerald"}
              sub={totals.requests ? `${((totals.errors / totals.requests) * 100).toFixed(2)}% of all requests` : "no traffic yet"} />
            <KpiCard label="Slowest p95" value={`${totals.worstP95} ms`} icon={Zap}
              tone={totals.worstP95 > 500 ? "red" : totals.worstP95 > 100 ? "amber" : "emerald"}
              sub={data.families[0] ? `family “${data.families[0].family}”` : "no traffic yet"} />
          </div>

          {/* scheduler tick gauge */}
          <Glass>
            <div className="flex flex-wrap items-center gap-x-8 gap-y-3">
              <div className="flex items-center gap-2.5">
                <span className="flex h-9 w-9 items-center justify-center rounded-xl border border-violet-400/40 bg-violet-500/10">
                  <Timer className="h-4 w-4 text-violet-300 light:text-violet-700" />
                </span>
                <div>
                  <p className="text-sm font-bold text-white light:text-slate-900">Scheduler tick</p>
                  <p className="text-[11px] text-slate-500">the jobs loop — payroll, wishes, alerts, expiry</p>
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-xs">
                <span className="text-slate-400 light:text-slate-600">passes <b className="ml-1 tabular-nums text-slate-200 light:text-slate-800">{data.tick.total.toLocaleString()}</b></span>
                <span className="text-slate-400 light:text-slate-600">last <b className={`ml-1 tabular-nums ${latencyTone(data.tick.lastMs)}`}>{data.tick.lastMs} ms</b></span>
                <span className="text-slate-400 light:text-slate-600">p95 <b className={`ml-1 tabular-nums ${latencyTone(data.tick.p95Ms)}`}>{data.tick.p95Ms} ms</b></span>
                <span className="text-slate-400 light:text-slate-600">vendors/pass <b className="ml-1 tabular-nums text-slate-200 light:text-slate-800">{data.tick.lastVendors.toLocaleString()}</b></span>
                {data.tick.lastAt ? (
                  <span className="text-slate-400 light:text-slate-600">last run <b className="ml-1 text-slate-200 light:text-slate-800">{new Date(data.tick.lastAt).toLocaleTimeString()}</b></span>
                ) : null}
              </div>
            </div>
          </Glass>

          {/* families table */}
          <div className="rounded-2xl border border-white/10 light:border-slate-200 bg-white/[0.03] light:bg-slate-100/60">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/10 light:border-slate-200 px-4 py-3.5 sm:px-5">
              <p className="text-[11px] font-bold uppercase tracking-widest text-slate-500">Module families — slowest first</p>
              <Button variant="outline" size="sm" onClick={() => setSortDesc((v) => !v)}
                className="h-8 border-white/10 light:border-slate-300 bg-white/5 light:bg-white text-white light:text-slate-900">
                <ArrowDownUp className="h-3.5 w-3.5" /> Sort by p95 {sortDesc ? "desc" : "asc"}
              </Button>
            </div>
            <TableShell headers={["Family", "Requests", "Errors", "Error rate", "p50", "p95", "Last", "Recent"]} empty={families.length === 0}>
              {families.map((f) => (
                <tr key={f.family} className="transition-colors hover:bg-white/[0.03] light:hover:bg-slate-100/70">
                  <Td className="font-semibold text-white light:text-slate-900">{f.family}</Td>
                  <Td className="tabular-nums text-slate-300 light:text-slate-700">{f.count.toLocaleString()}</Td>
                  <Td className={`tabular-nums ${f.errors > 0 ? "text-rose-300 light:text-rose-600" : "text-slate-500"}`}>{f.errors.toLocaleString()}</Td>
                  <Td>
                    <div className="flex items-center gap-2">
                      <div className="h-1.5 w-12 overflow-hidden rounded-full bg-white/10 light:bg-slate-200">
                        <div className={`h-full rounded-full ${f.errorRate > 0.05 ? "bg-rose-400/80" : f.errorRate > 0.01 ? "bg-amber-400/70" : "bg-emerald-400/60"}`}
                          style={{ width: `${Math.min(100, Math.round(f.errorRate * 100))}%` }} />
                      </div>
                      <span className={`w-12 text-xs tabular-nums ${f.errorRate > 0.05 ? "text-rose-300 light:text-rose-600" : "text-slate-400 light:text-slate-600"}`}>
                        {(f.errorRate * 100).toFixed(1)}%
                      </span>
                    </div>
                  </Td>
                  <Td><span className={`text-xs font-semibold tabular-nums ${latencyTone(f.p50Ms)}`}>{f.p50Ms} ms</span></Td>
                  <Td><LatencyBar ms={f.p95Ms} /></Td>
                  <Td className="tabular-nums text-slate-400 light:text-slate-600">{f.lastMs} ms</Td>
                  <Td><Sparkline samples={f.samples} /></Td>
                </tr>
              ))}
            </TableShell>
            <p className="border-t border-white/10 light:border-slate-200 px-4 py-2.5 text-[10px] leading-relaxed text-slate-500 sm:px-5">
              Latency rings keep the most recent observations per family (max 256) since process start — the same data
              <span className="mx-1 font-semibold text-slate-400">/api/metrics</span>
              exports in Prometheus format. Green ≤ 100 ms · amber ≤ 500 ms · red above (the perf-budget gate&apos;s §11.1 thresholds).
              A restart resets every ring.
            </p>
          </div>
        </>
      ) : null}
    </div>
  )
}

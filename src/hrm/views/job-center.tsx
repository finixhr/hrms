"use client"
// ============ Job Center (WP-A) — observable, controllable background queue ============
// Admin view over the BgJob queue: live table with 15s polling, status/type/
// date filters, a detail drawer (full error, run log, redacted payload) and
// operator actions — Retry now, Cancel (cooperative), Requeue from DEAD.
// Everything is vendor-scoped server-side (H-10): tenant admins see their
// own jobs only. jobs.view gates the page; jobs.manage gates the actions.

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  ListChecks, RefreshCw, Ban, RotateCcw, Clock, X, AlertTriangle, CheckCircle2,
  Loader2, Timer, CalendarClock, Wrench, ChevronRight,
} from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { useHrm } from "../store"
import { rpc } from "../api"
import { PageHeader, SectionCard, fmtDateTime, EmptyState, ErrorBanner, LoadingRows } from "../shared/ui-kit"
import { DataTable, type Column } from "../shared/data-table"

type JobRow = {
  id: string
  type: string
  status: string
  progress: number
  total: number
  error: string | null
  priority: number
  attempts: number
  maxAttempts: number
  scheduledFor: string | null
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
  lastErrorAt: string | null
  cancelledAt: string | null
  createdBy: string | null
  createdByName: string | null
}

type JobDetail = JobRow & {
  payload: unknown
  runLog: { startedAt: string; finishedAt: string; error?: string; durationMs: number }[]
  result: unknown
}

type ListResponse = {
  jobs: JobRow[]
  types: string[]
  statusCounts: Record<string, number>
}

type ScheduledResponse = {
  jobs: JobRow[]
  scheduler: { tickSeconds: number; recurring: { name: string; cadence: string }[] }
}

const STATUSES = ["PENDING", "RUNNING", "DONE", "FAILED", "CANCELLED", "DEAD"] as const

const STATUS_TONE: Record<string, string> = {
  PENDING: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
  RUNNING: "bg-sky-100 text-sky-700 dark:bg-sky-900/60 dark:text-sky-300",
  DONE: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/60 dark:text-emerald-300",
  FAILED: "bg-amber-100 text-amber-700 dark:bg-amber-900/60 dark:text-amber-300",
  CANCELLED: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400",
  DEAD: "bg-rose-100 text-rose-700 dark:bg-rose-900/60 dark:text-rose-300",
}

function JobStatusBadge({ status }: { status: string }) {
  return <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold ${STATUS_TONE[status] || STATUS_TONE.PENDING}`}>{status}</span>
}

function durationOf(j: JobRow): string | null {
  if (!j.startedAt) return null
  const end = j.finishedAt ? new Date(j.finishedAt).getTime() : Date.now()
  const ms = end - new Date(j.startedAt).getTime()
  if (!Number.isFinite(ms) || ms < 0) return null
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`
}

function retryNote(j: JobRow): string {
  if (j.status === "DEAD") return "dead-lettered"
  if (j.status === "FAILED" || j.status === "PENDING") {
    if (j.attempts > 0 && j.scheduledFor) return `retry at ${fmtDateTime(j.scheduledFor)}`
  }
  return `${j.attempts}/${j.maxAttempts}`
}

export default function JobCenterView() {
  const can = useHrm((s) => s.can)
  const toast = useHrm((s) => s.toast)
  const canManage = can("jobs", "manage")

  const [tab, setTab] = useState<"queue" | "scheduled">("queue")
  const [status, setStatus] = useState<string>("all")
  const [type, setType] = useState<string>("all")
  const [dateFilter, setDateFilter] = useState<string>("") // YYYY-MM-DD
  const [data, setData] = useState<ListResponse | null>(null)
  const [scheduled, setScheduled] = useState<ScheduledResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [detail, setDetail] = useState<JobDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null)
  const mounted = useRef(true)

  const load = useCallback(async () => {
    const payload: Record<string, unknown> = { limit: 100 }
    if (status !== "all") payload.status = status
    if (type !== "all") payload.type = type
    if (dateFilter) payload.createdAfter = `${dateFilter}T00:00:00.000Z`
    try {
      const res = await rpc<ListResponse>("jobs.list", payload)
      if (!mounted.current) return
      setData(res)
      setError(null)
      setLastRefresh(new Date())
    } catch (e: any) {
      if (mounted.current) setError(String(e?.message || e))
    } finally {
      if (mounted.current) setLoading(false)
    }
  }, [status, type, dateFilter])

  const loadScheduled = useCallback(async () => {
    try {
      const res = await rpc<ScheduledResponse>("jobs.scheduled", {})
      if (mounted.current) setScheduled(res)
    } catch { /* scheduled tab is best-effort */ }
  }, [])

  useEffect(() => {
    mounted.current = true
    void load()
    void loadScheduled()
    // WP-A — 15s live poll (the queue is the operational heartbeat)
    const timer = setInterval(() => {
      void load()
      if (tab === "scheduled") void loadScheduled()
    }, 15_000)
    return () => { mounted.current = false; clearInterval(timer) }
  }, [load, loadScheduled, tab])

  const openDetail = async (id: string) => {
    setDetailLoading(true)
    setDetail(null)
    try {
      const res = await rpc<JobDetail>("jobs.detail", { id })
      if (mounted.current) setDetail(res)
    } catch (e: any) {
      toast(String(e?.message || e), "err")
    } finally {
      if (mounted.current) setDetailLoading(false)
    }
  }

  const act = async (action: "jobs.retry" | "jobs.cancel" | "jobs.recoverStale", payload: Record<string, unknown>, label: string) => {
    setBusy(label)
    try {
      await rpc(action, payload)
      toast(`${label} — done`, "ok")
      await load()
      if (detail) await openDetail(detail.id)
    } catch (e: any) {
      toast(String(e?.message || e), "err")
    } finally {
      if (mounted.current) setBusy(null)
    }
  }

  const failedCount = useMemo(() => (data?.statusCounts?.FAILED || 0) + (data?.statusCounts?.DEAD || 0), [data])

  const columns: Column<JobRow>[] = [
    {
      key: "type", label: "Type", render: (j) => (
        <div className="flex flex-col gap-0.5">
          <span className="font-medium text-slate-800 dark:text-slate-100">{j.type}</span>
          <span className="text-xs text-slate-400">{j.createdByName || "system"}</span>
        </div>
      ),
    },
    { key: "status", label: "Status", render: (j) => <JobStatusBadge status={j.status} /> },
    {
      key: "progress", label: "Progress", render: (j) => (
        j.status === "RUNNING" && j.total > 0 ? (
          <div className="w-28">
            <Progress value={Math.min(100, Math.round((j.progress / Math.max(1, j.total)) * 100))} className="h-1.5" />
            <span className="text-xs text-slate-400 tabular-nums">{j.progress}/{j.total}</span>
          </div>
        ) : <span className="text-xs text-slate-400">{j.total > 0 ? `${j.progress}/${j.total}` : "—"}</span>
      ),
    },
    {
      key: "priority", label: "Priority", render: (j) => (
        <Badge variant="outline" className={j.priority <= 2 ? "border-rose-300 text-rose-600" : j.priority >= 8 ? "border-slate-300 text-slate-400" : ""}>
          P{j.priority}
        </Badge>
      ),
    },
    { key: "createdAt", label: "Created", render: (j) => <span className="text-xs tabular-nums">{fmtDateTime(j.createdAt)}</span> },
    {
      key: "startedAt", label: "Started", render: (j) => (
        <div className="flex flex-col">
          <span className="text-xs tabular-nums">{j.startedAt ? fmtDateTime(j.startedAt) : "—"}</span>
          {j.startedAt && <span className="text-xs text-slate-400 flex items-center gap-1"><Timer className="h-3 w-3" />{durationOf(j) || "running"}</span>}
        </div>
      ),
    },
    { key: "attempts", label: "Attempts", render: (j) => <span className="text-xs tabular-nums">{retryNote(j)}</span> },
    {
      key: "error", label: "Error", render: (j) => j.error ? (
        <span className="text-xs text-rose-600 dark:text-rose-400 line-clamp-1 max-w-56 inline-block align-middle">{j.error}</span>
      ) : <span className="text-slate-300">—</span>,
    },
    {
      key: "_actions", label: "", render: (j) => (
        <div className="flex items-center justify-end gap-1">
          {canManage && ["FAILED", "DEAD", "CANCELLED"].includes(j.status) && (
            <Button size="sm" variant="outline" className="h-7 gap-1" disabled={busy != null} onClick={() => act("jobs.retry", { id: j.id }, "Requeue")}>
              <RotateCcw className="h-3.5 w-3.5" /> {j.status === "DEAD" ? "Requeue" : "Retry"}
            </Button>
          )}
          {canManage && ["PENDING", "RUNNING"].includes(j.status) && (
            <Button size="sm" variant="outline" className="h-7 gap-1" disabled={busy != null} onClick={() => act("jobs.cancel", { id: j.id }, "Cancel")}>
              <Ban className="h-3.5 w-3.5" /> Cancel
            </Button>
          )}
          <Button size="sm" variant="ghost" className="h-7" onClick={() => openDetail(j.id)}>
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      ),
    },
  ]

  return (
    <div className="space-y-4">
      <PageHeader
        title={
          <span className="flex items-center gap-2">
            <ListChecks className="h-5 w-5 text-emerald-600" />
            Job Center
            {failedCount > 0 && (
              <Badge className="bg-rose-100 text-rose-700 dark:bg-rose-900/60 dark:text-rose-300 hover:bg-rose-100">
                <AlertTriangle className="h-3 w-3 mr-1" />{failedCount} failed
              </Badge>
            )}
          </span>
        }
        subtitle={`Background queue — every heavy operation (payroll runs, bulk email/SMS, exports, sweeps) with live progress.${lastRefresh ? ` Refreshed ${fmtDateTime(lastRefresh.toISOString())}.` : ""}`}
        actions={
          <div className="flex items-center gap-2">
            <Button size="sm" variant="outline" className="gap-1.5" onClick={() => { void load(); if (tab === "scheduled") void loadScheduled() }}>
              <RefreshCw className="h-3.5 w-3.5" /> Refresh
            </Button>
            {canManage && (
              <Button size="sm" variant="outline" className="gap-1.5" disabled={busy != null} onClick={() => act("jobs.recoverStale", { staleMinutes: 10 }, "Recover stale")}>
                <Wrench className="h-3.5 w-3.5" /> Recover stale
              </Button>
            )}
          </div>
        }
      />

      <div className="flex items-center gap-1 rounded-lg bg-slate-100 dark:bg-slate-800 p-1 w-fit">
        <button className={`px-3 py-1.5 text-sm rounded-md flex items-center gap-1.5 ${tab === "queue" ? "bg-white dark:bg-slate-900 shadow-sm font-medium" : "text-slate-500"}`} onClick={() => setTab("queue")}>
          <Clock className="h-3.5 w-3.5" /> Queue
        </button>
        <button className={`px-3 py-1.5 text-sm rounded-md flex items-center gap-1.5 ${tab === "scheduled" ? "bg-white dark:bg-slate-900 shadow-sm font-medium" : "text-slate-500"}`} onClick={() => setTab("scheduled")}>
          <CalendarClock className="h-3.5 w-3.5" /> Scheduled
        </button>
      </div>

      {tab === "queue" && (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <Select value={status} onValueChange={setStatus}>
              <SelectTrigger className="w-36 h-8 text-sm"><SelectValue placeholder="Status" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All statuses</SelectItem>
                {STATUSES.map((s) => (
                  <SelectItem key={s} value={s}>
                    {s}
                    {data?.statusCounts?.[s] ? ` (${data.statusCounts[s]})` : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={type} onValueChange={setType}>
              <SelectTrigger className="w-56 h-8 text-sm"><SelectValue placeholder="Type" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All types</SelectItem>
                {(data?.types || []).map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}
              </SelectContent>
            </Select>
            <input
              type="date" value={dateFilter} onChange={(e) => setDateFilter(e.target.value)}
              className="h-8 rounded-md border border-slate-200 dark:border-slate-700 bg-transparent px-2 text-sm"
              title="Show jobs created on/after this date"
            />
            {(status !== "all" || type !== "all" || dateFilter) && (
              <Button size="sm" variant="ghost" className="h-8" onClick={() => { setStatus("all"); setType("all"); setDateFilter("") }}>Clear</Button>
            )}
          </div>

          {error && <ErrorBanner message={error} />}
          {loading && !data ? <LoadingRows rows={6} /> : !data?.jobs.length ? (
            <EmptyState icon={ListChecks} title="No jobs match these filters" hint="Heavy operations (payroll calculation, bulk sends, exports, device syncs) appear here the moment they are queued." />
          ) : (
            <DataTable columns={columns} rows={data.jobs} pageSize={15} stickyHeader csvName="job-center" dense />
          )}
        </>
      )}

      {tab === "scheduled" && (
        <div className="grid gap-4 lg:grid-cols-3">
          <SectionCard title="Recurring scheduler" className="lg:col-span-1">
            <div className="space-y-3">
              <div className="flex items-center gap-2 text-sm">
                <Clock className="h-4 w-4 text-emerald-600" />
                Tick every <b>{scheduled?.scheduler.tickSeconds ?? 60}s</b>
              </div>
              {(scheduled?.scheduler.recurring || []).map((r) => (
                <div key={r.name} className="rounded-lg border border-slate-200 dark:border-slate-800 p-2.5">
                  <div className="text-sm font-medium leading-tight">{r.name}</div>
                  <div className="text-xs text-slate-500">{r.cadence}</div>
                </div>
              ))}
              <p className="text-xs text-slate-400">The scheduler is managed by the platform (HRM_JOBS_TICK_MS); this view is read-only.</p>
            </div>
          </SectionCard>
          <SectionCard title="Scheduled &amp; retrying jobs" className="lg:col-span-2">
            {!scheduled?.jobs.length ? (
              <EmptyState icon={CalendarClock} title="Nothing scheduled" hint="Deferred jobs (scheduledFor in the future) and retry backoffs appear here." />
            ) : (
              <div className="divide-y divide-slate-100 dark:divide-slate-800">
                {scheduled.jobs.map((j) => (
                  <div key={j.id} className="flex items-center justify-between gap-3 py-2.5">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-sm truncate">{j.type}</span>
                        <Badge variant="outline" className="text-xs">P{j.priority}</Badge>
                        {j.attempts > 0 && <span className="text-xs text-amber-600">retry {j.attempts}/{j.maxAttempts}</span>}
                      </div>
                      <div className="text-xs text-slate-500 truncate">{j.error ? `last error: ${j.error}` : j.createdByName || "system"}</div>
                    </div>
                    <div className="text-right shrink-0">
                      <div className="text-xs tabular-nums font-medium">{j.scheduledFor ? fmtDateTime(j.scheduledFor) : "—"}</div>
                      <div className="text-xs text-slate-400">next run</div>
                    </div>
                    {canManage && (
                      <Button size="sm" variant="outline" className="h-7 gap-1 shrink-0" disabled={busy != null} onClick={() => act("jobs.cancel", { id: j.id }, "Cancel")}>
                        <Ban className="h-3.5 w-3.5" />
                      </Button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </SectionCard>
        </div>
      )}

      {(detail || detailLoading) && (
        <div className="fixed inset-0 z-50 flex justify-end bg-black/30" onClick={() => { if (!detailLoading) setDetail(null) }}>
          <div className="h-full w-full max-w-xl bg-white dark:bg-slate-950 shadow-2xl overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            {detailLoading || !detail ? (
              <div className="flex items-center justify-center h-40 gap-2 text-slate-400"><Loader2 className="h-4 w-4 animate-spin" /> Loading job…</div>
            ) : (
              <div className="p-5 space-y-5">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2">
                      <JobStatusBadge status={detail.status} />
                      <span className="font-semibold">{detail.type}</span>
                    </div>
                    <div className="text-xs text-slate-400 mt-1 font-mono">{detail.id}</div>
                  </div>
                  <Button size="sm" variant="ghost" onClick={() => setDetail(null)}><X className="h-4 w-4" /></Button>
                </div>

                <div className="grid grid-cols-2 gap-3 text-sm">
                  <div><div className="text-xs text-slate-400">Created</div><div className="tabular-nums">{fmtDateTime(detail.createdAt)}</div></div>
                  <div><div className="text-xs text-slate-400">By</div><div>{detail.createdByName || "system"}</div></div>
                  <div><div className="text-xs text-slate-400">Started</div><div className="tabular-nums">{detail.startedAt ? fmtDateTime(detail.startedAt) : "—"}</div></div>
                  <div><div className="text-xs text-slate-400">Finished</div><div className="tabular-nums">{detail.finishedAt ? fmtDateTime(detail.finishedAt) : "—"}</div></div>
                  <div><div className="text-xs text-slate-400">Duration</div><div>{durationOf(detail) || "—"}</div></div>
                  <div><div className="text-xs text-slate-400">Attempts</div><div>{detail.attempts} / {detail.maxAttempts}</div></div>
                  <div><div className="text-xs text-slate-400">Priority</div><div>P{detail.priority}</div></div>
                  <div><div className="text-xs text-slate-400">Scheduled for</div><div className="tabular-nums">{detail.scheduledFor ? fmtDateTime(detail.scheduledFor) : "immediate"}</div></div>
                </div>

                {detail.error && (
                  <div className="rounded-lg bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900 p-3">
                    <div className="flex items-center gap-1.5 text-rose-700 dark:text-rose-300 text-xs font-semibold mb-1"><AlertTriangle className="h-3.5 w-3.5" /> Last error</div>
                    <div className="text-xs font-mono whitespace-pre-wrap break-words text-rose-700 dark:text-rose-300">{detail.error}</div>
                  </div>
                )}

                {detail.status === "DONE" && detail.result != null && (
                  <div className="rounded-lg bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-900 p-3">
                    <div className="flex items-center gap-1.5 text-emerald-700 dark:text-emerald-300 text-xs font-semibold mb-1"><CheckCircle2 className="h-3.5 w-3.5" /> Result</div>
                    <pre className="text-xs whitespace-pre-wrap break-words max-h-40 overflow-y-auto">{JSON.stringify(detail.result, null, 2)}</pre>
                  </div>
                )}

                <div>
                  <div className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">Run log (append-only)</div>
                  {!detail.runLog?.length ? (
                    <div className="text-xs text-slate-400">No attempts recorded yet.</div>
                  ) : (
                    <div className="space-y-1.5">
                      {detail.runLog.map((a, i) => (
                        <div key={i} className="flex items-start gap-2 text-xs rounded-lg border border-slate-200 dark:border-slate-800 p-2">
                          {a.error ? <AlertTriangle className="h-3.5 w-3.5 text-rose-500 mt-0.5 shrink-0" /> : <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500 mt-0.5 shrink-0" />}
                          <div className="min-w-0 flex-1">
                            <div className="tabular-nums text-slate-500">{fmtDateTime(a.startedAt)} → {fmtDateTime(a.finishedAt)} · {a.durationMs < 1000 ? `${a.durationMs}ms` : `${(a.durationMs / 1000).toFixed(1)}s`}</div>
                            {a.error && <div className="font-mono break-words text-rose-600 dark:text-rose-400">{a.error}</div>}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <div>
                  <div className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">Payload (redacted)</div>
                  <pre className="text-xs whitespace-pre-wrap break-words rounded-lg bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-3 max-h-48 overflow-y-auto">{JSON.stringify(detail.payload, null, 2)}</pre>
                </div>

                {canManage && (
                  <div className="flex gap-2 border-t border-slate-100 dark:border-slate-800 pt-4">
                    {["FAILED", "DEAD", "CANCELLED"].includes(detail.status) && (
                      <Button size="sm" className="gap-1.5" disabled={busy != null} onClick={() => act("jobs.retry", { id: detail.id }, "Requeue")}>
                        <RotateCcw className="h-3.5 w-3.5" /> {detail.status === "DEAD" ? "Requeue from DEAD" : "Retry now"}
                      </Button>
                    )}
                    {["PENDING", "RUNNING"].includes(detail.status) && (
                      <Button size="sm" variant="outline" className="gap-1.5" disabled={busy != null} onClick={() => act("jobs.cancel", { id: detail.id }, "Cancel")}>
                        <Ban className="h-3.5 w-3.5" /> Cancel job
                      </Button>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

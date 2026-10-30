"use client"
// ============ /owner/backup — Backup & Disaster Recovery console (Wave 2 WP-R) ============
// Server engine: owner.backup.* (src/hrm-server/saas/backup.ts — also the
// BACKUP_PG_DUMP / RESTORE_DRILL BgJob runners). Every value on this page comes
// from the owner.backup.list / owner.backup.report responses — no fabricated
// numbers, no fake progress: the run rows flip PENDING → RUNNING → DONE/FAILED
// as the engine completes REAL phases.
//
// Behavior:
//   - polls every 5 s while any run is queued/running (progress = run status)
//   - "Run Backup Now" / "Run Restore Drill" are privileged (settings.manage)
//     and require typing the exact word BACKUP / DRILL to confirm; the server
//     independently enforces one concurrent run per type (429) and one drill
//     per 24 h (429)
//   - the deploy/backup.timer + scripts/backup.sh production path is surfaced
//     as an honest tip card (it runs OUTSIDE the app)
//   - the nightly in-app schedule is the cron-free piggyback design: it is
//     checked lazily on this page's own list calls (and on System Health
//     snapshots) — see the engine module header for the full design note.
import { useEffect, useMemo, useState } from "react"
import {
  AlertTriangle, Archive, CheckCircle2, Clock, Database, FileDown, FlaskConical, History,
  Info, Loader2, Play, RefreshCw, ShieldAlert, ShieldCheck, Timer, XCircle,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { useOwnerApi, ownerRpc } from "@/saas/owner/client"
import { ErrorBanner, Loading, PageHeader, TableShell, Td, fmtDateTime } from "@/saas/owner/ui"

// ------------------------------ types (mirror the server responses) ------------------------------

type RunStatus = "PENDING" | "RUNNING" | "DONE" | "FAILED"

type BackupRun = {
  id: string
  type: "BACKUP" | "DRILL"
  trigger: "MANUAL" | "SCHEDULED"
  status: RunStatus
  startedAt: string
  finishedAt: string | null
  sizeBytes: number | null
  checksum: string | null
  locationType: string
  locationPath: string | null
  retentionKept: number | null
  error: string | null
  hasReport: boolean
  createdAt: string
}

type BackupSettings = {
  enabled: boolean
  retention: number
  scheduleTime: string
  alertEmail: string
  dir: string
}

type BackupList = {
  total: number
  rows: BackupRun[]
  lastBackup: BackupRun | null
  lastDrill: BackupRun | null
  lastDrillPass: boolean | null
  inFlight: { backup: boolean; drill: boolean }
  settings: BackupSettings
  schedule: { timezone: string; ranToday: boolean; check: string; submittedByThisCall: boolean }
  dbFlavor: string
  engineNote: string
  timerNote: string
}

type DrillReport = {
  artifact: string | null
  artifactBytes: number | null
  checksumVerified: boolean
  restoredTables: number | null
  counts: { table: string; source: number; restored: number; match: boolean }[]
  pass: boolean
  notes: string[]
  durationMs: number
  drilledAt: string
}

type BackupReport = {
  flavor: string
  format: string
  gzip: { inputBytes: number; outputBytes: number }
  durationMs: number
}

type ReportResponse = { run: BackupRun; report: DrillReport | BackupReport | null }

// ------------------------------ formatting helpers ------------------------------

const STATUS_TONE: Record<RunStatus, string> = {
  PENDING: "border-amber-400/40 bg-amber-500/10 text-amber-300 light:text-amber-700",
  RUNNING: "border-blue-400/40 bg-blue-500/10 text-blue-300 light:text-blue-700",
  DONE: "border-emerald-400/40 bg-emerald-500/10 text-emerald-300 light:text-emerald-700",
  FAILED: "border-rose-400/40 bg-rose-500/10 text-rose-300 light:text-rose-600",
}

function StatusChip({ status }: { status: RunStatus }) {
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-widest ${STATUS_TONE[status]}`}>
      {status === "RUNNING" && <Loader2 className="h-3 w-3 animate-spin" aria-hidden />}
      {status}
    </span>
  )
}

function fmtBytes(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes)) return "—"
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${bytes} B`
}

function fmtDuration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return "—"
  if (ms < 1000) return `${Math.round(ms)} ms`
  const s = ms / 1000
  if (s < 60) return `${s.toFixed(1)} s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${Math.round(s % 60)}s`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

function runDurationMs(r: BackupRun): number | null {
  if (!r.finishedAt) return null
  return new Date(r.finishedAt).getTime() - new Date(r.startedAt).getTime()
}

function timeAgo(iso: string): string {
  const s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000))
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

const SCHEDULE_TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

// ============================== the page ==============================

export default function OwnerBackupPage() {
  const { data, loading, error, reload } = useOwnerApi<BackupList>("owner.backup.list", { limit: 50 })
  const me = useOwnerApi<{ owner: { permissions: string[] } }>("owner.auth.me", {})
  const canManage = useMemo(() => !!me.data?.owner?.permissions?.includes("settings.manage"), [me.data])

  // poll every 5 s while any run is queued/executing — the SaasBackupRun row
  // (fetched by owner.backup.list) IS the progress signal; cleaned up on unmount
  const anyInFlight = !!data && (data.inFlight.backup || data.inFlight.drill)
  useEffect(() => {
    if (!anyInFlight) return
    const t = setInterval(() => { reload().catch(() => {}) }, 5_000)
    return () => clearInterval(t)
  }, [anyInFlight, reload])

  // ---- run actions (type-to-confirm dialogs) ----
  const [backupOpen, setBackupOpen] = useState(false)
  const [drillOpen, setDrillOpen] = useState(false)
  const [runBusy, setRunBusy] = useState(false)
  const [runError, setRunError] = useState<string | null>(null)
  const [submitted, setSubmitted] = useState<{ type: string; jobId: string; runId: string } | null>(null)

  const submitRun = async (type: "BACKUP" | "DRILL") => {
    setRunBusy(true)
    setRunError(null)
    try {
      const d = await ownerRpc<{ jobId: string; runId: string; type: string }>("owner.backup.run", { type })
      setSubmitted({ type: d.type, jobId: d.jobId, runId: d.runId })
      setBackupOpen(false)
      setDrillOpen(false)
      await reload()
    } catch (e: unknown) {
      setRunError((e as Error)?.message || "Submission failed")
    } finally {
      setRunBusy(false)
    }
  }

  // ---- report dialog ----
  const [reportOpen, setReportOpen] = useState(false)
  const [reportLoading, setReportLoading] = useState(false)
  const [reportError, setReportError] = useState<string | null>(null)
  const [reportData, setReportData] = useState<ReportResponse | null>(null)

  const openReport = async (id: string) => {
    setReportOpen(true)
    setReportLoading(true)
    setReportError(null)
    setReportData(null)
    try {
      const d = await ownerRpc<ReportResponse>("owner.backup.report", { id })
      setReportData(d)
    } catch (e: unknown) {
      setReportError((e as Error)?.message || "Failed to load the report")
    } finally {
      setReportLoading(false)
    }
  }

  // ---- schedule check (manual piggyback trigger) ----
  const [schedBusy, setSchedBusy] = useState(false)
  const [schedMsg, setSchedMsg] = useState<string | null>(null)
  const checkSchedule = async () => {
    setSchedBusy(true)
    setSchedMsg(null)
    try {
      const d = await ownerRpc<{ submitted: boolean; reason: string }>("owner.backup.schedule.check")
      setSchedMsg(d.submitted ? `${d.reason} — a scheduled backup was just submitted.` : d.reason)
      await reload()
    } catch (e: unknown) {
      setSchedMsg((e as Error)?.message || "Schedule check failed")
    } finally {
      setSchedBusy(false)
    }
  }

  // ---- settings form ----
  // No init effect: the effective form is the user's local override when one
  // exists, else the server-loaded settings (React "derive during render"
  // discipline — setState only from event handlers, never effect bodies).
  const [formOverride, setFormOverride] = useState<BackupSettings | null>(null)
  const form = formOverride ?? data?.settings ?? null
  const setForm = (next: BackupSettings) => { setFormOverride(next) }
  const [saveBusy, setSaveBusy] = useState(false)
  const [saveMsg, setSaveMsg] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)

  const formValid = !!form
    && Number.isFinite(form.retention) && form.retention >= 1 && form.retention <= 365
    && SCHEDULE_TIME_RE.test(form.scheduleTime)
    && (form.alertEmail === "" || EMAIL_RE.test(form.alertEmail))
    && form.dir.trim().length > 0

  const saveSettings = async () => {
    if (!form || !formValid) return
    setSaveBusy(true)
    setSaveMsg(null)
    setSaveError(null)
    try {
      const d = await ownerRpc<{ settings: BackupSettings }>("owner.backup.settings.save", {
        enabled: form.enabled,
        retention: Number(form.retention),
        scheduleTime: form.scheduleTime,
        alertEmail: form.alertEmail,
        dir: form.dir,
      })
      setFormOverride(d.settings)
      setSaveMsg("Saved — the nightly piggyback schedule uses these values on its next check.")
      await reload()
    } catch (e: unknown) {
      setSaveError((e as Error)?.message || "Save failed")
    } finally {
      setSaveBusy(false)
    }
  }

  const lastBackup = data?.lastBackup ?? null
  const lastDrill = data?.lastDrill ?? null
  const lastDrillPass = data?.lastDrillPass ?? null

  return (
    <div className="space-y-5">
      <PageHeader
        title="Backup & Recovery"
        sub="Database backup engine and restore drills — run history, integrity verification and the nightly schedule. Runs execute in the background job queue; this page polls every 5 s while a run is in flight."
        actions={(
          <Button variant="outline" size="sm" onClick={() => { reload().catch(() => {}) }} disabled={loading}
            className="h-9 border-white/10 light:border-slate-300 bg-white/5 light:bg-white text-white light:text-slate-900">
            {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />} Refresh
          </Button>
        )}
      />

      {error && <ErrorBanner message={error} />}

      {/* in-flight banner */}
      {anyInFlight && (
        <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-blue-400/30 bg-blue-500/10 p-4" role="status">
          <span className="relative flex h-3 w-3">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-blue-400 opacity-60" />
            <span className="relative inline-flex h-3 w-3 rounded-full bg-blue-400" />
          </span>
          <p className="text-sm font-semibold text-blue-200 light:text-blue-800">
            {data?.inFlight.backup ? "A backup" : "A restore drill"} is {data?.rows.some((r) => r.status === "RUNNING") ? "running" : "queued"} — live progress polls every 5 s and reflects real engine phases (dump → gzip → checksum → record → prune / restore → verify → compare).
          </p>
        </div>
      )}

      {/* status cards */}
      {loading && !data ? (
        <Loading label="Loading backup run history…" />
      ) : data ? (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {/* ---- last backup ---- */}
          <div className="rounded-2xl border border-white/10 light:border-slate-200 bg-white/[0.03] light:bg-slate-100/60 p-5">
            <div className="flex items-center justify-between gap-2">
              <p className="text-[11px] font-bold uppercase tracking-widest text-slate-500">Last Backup</p>
              <Archive className="h-4 w-4 text-slate-600 light:text-slate-500" />
            </div>
            {lastBackup ? (
              <div className="mt-3 space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <StatusChip status={lastBackup.status} />
                  <span className="text-xs text-slate-400 light:text-slate-600" title={fmtDateTime(lastBackup.startedAt)}>
                    {timeAgo(lastBackup.startedAt)} · {lastBackup.trigger === "SCHEDULED" ? "nightly schedule" : "manual"}
                  </span>
                </div>
                <p className="text-2xl font-bold tabular-nums tracking-tight text-white light:text-slate-900">
                  {fmtBytes(lastBackup.sizeBytes)}
                </p>
                <dl className="space-y-1 text-xs">
                  <div className="flex justify-between gap-3">
                    <dt className="text-slate-500">Checksum</dt>
                    <dd className="truncate font-mono text-slate-300 light:text-slate-700" title={lastBackup.checksum ?? undefined}>
                      {lastBackup.checksum ? `${lastBackup.checksum.slice(0, 16)}…` : "—"}
                    </dd>
                  </div>
                  <div className="flex justify-between gap-3">
                    <dt className="text-slate-500">Location</dt>
                    <dd className="truncate text-slate-300 light:text-slate-700" title={lastBackup.locationPath ?? undefined}>
                      {lastBackup.locationPath || "—"}
                    </dd>
                  </div>
                  <div className="flex justify-between gap-3">
                    <dt className="text-slate-500">Retention kept</dt>
                    <dd className="tabular-nums text-slate-300 light:text-slate-700">{lastBackup.retentionKept ?? "—"}</dd>
                  </div>
                  <div className="flex justify-between gap-3">
                    <dt className="text-slate-500">Duration</dt>
                    <dd className="tabular-nums text-slate-300 light:text-slate-700">{fmtDuration(runDurationMs(lastBackup))}</dd>
                  </div>
                </dl>
                {lastBackup.error && (
                  <p className="break-words rounded-lg border border-rose-400/30 bg-rose-500/10 p-2 text-[11px] leading-relaxed text-rose-300 light:text-rose-600">
                    {lastBackup.error}
                  </p>
                )}
              </div>
            ) : (
              <p className="mt-3 text-sm leading-relaxed text-slate-400 light:text-slate-600">
                No backup has ever run from the platform. Run your first backup below — the System Health backup card and this console stay honest about that until a run exists.
              </p>
            )}
          </div>

          {/* ---- last restore drill ---- */}
          <div className="rounded-2xl border border-white/10 light:border-slate-200 bg-white/[0.03] light:bg-slate-100/60 p-5">
            <div className="flex items-center justify-between gap-2">
              <p className="text-[11px] font-bold uppercase tracking-widest text-slate-500">Last Restore Drill</p>
              <FlaskConical className="h-4 w-4 text-slate-600 light:text-slate-500" />
            </div>
            {lastDrill ? (
              <div className="mt-3 space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  {lastDrillPass == null ? (
                    <StatusChip status={lastDrill.status} />
                  ) : lastDrillPass ? (
                    <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-400/40 bg-emerald-500/10 px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-widest text-emerald-300 light:text-emerald-700">
                      <ShieldCheck className="h-3 w-3" /> Passed
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1.5 rounded-full border border-rose-400/40 bg-rose-500/10 px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-widest text-rose-300 light:text-rose-600">
                      <ShieldAlert className="h-3 w-3" /> Failed
                    </span>
                  )}
                  <span className="text-xs text-slate-400 light:text-slate-600" title={fmtDateTime(lastDrill.startedAt)}>
                    {timeAgo(lastDrill.startedAt)}
                  </span>
                </div>
                <p className="text-sm leading-relaxed text-slate-300 light:text-slate-700">
                  Latest artifact restored into a disposable <span className="font-mono">hrm_drill_*</span> database — checksum re-verified and core-table counts compared against the live database.
                </p>
                <div className="flex justify-between gap-3 text-xs">
                  <span className="text-slate-500">Drilled artifact</span>
                  <span className="truncate text-slate-300 light:text-slate-700" title={lastDrill.locationPath ?? undefined}>
                    {lastDrill.locationPath || "—"}
                  </span>
                </div>
                <div className="flex justify-between gap-3 text-xs">
                  <span className="text-slate-500">Duration</span>
                  <span className="tabular-nums text-slate-300 light:text-slate-700">{fmtDuration(runDurationMs(lastDrill))}</span>
                </div>
                {lastDrill.error && (
                  <p className="break-words rounded-lg border border-rose-400/30 bg-rose-500/10 p-2 text-[11px] leading-relaxed text-rose-300 light:text-rose-600">
                    {lastDrill.error}
                  </p>
                )}
                {lastDrill.hasReport && (
                  <Button variant="outline" size="sm" onClick={() => { void openReport(lastDrill.id) }}
                    className="h-8 border-white/10 light:border-slate-300 bg-white/5 light:bg-white text-white light:text-slate-900">
                    <FileDown className="h-3.5 w-3.5" /> View drill report
                  </Button>
                )}
              </div>
            ) : (
              <p className="mt-3 text-sm leading-relaxed text-slate-400 light:text-slate-600">
                No restore drill has run yet. A drill proves a backup is actually restorable — run one after your first backup (at most once per 24 h).
              </p>
            )}
          </div>

          {/* ---- engine & schedule state ---- */}
          <div className="rounded-2xl border border-white/10 light:border-slate-200 bg-white/[0.03] light:bg-slate-100/60 p-5">
            <div className="flex items-center justify-between gap-2">
              <p className="text-[11px] font-bold uppercase tracking-widest text-slate-500">Engine & Nightly Schedule</p>
              <Timer className="h-4 w-4 text-slate-600 light:text-slate-500" />
            </div>
            <div className="mt-3 space-y-2 text-xs">
              <div className="flex items-center justify-between gap-3">
                <span className="text-slate-500">Database</span>
                <span className="inline-flex items-center gap-1.5 text-slate-300 light:text-slate-700">
                  <Database className="h-3.5 w-3.5" /> {data.dbFlavor}
                </span>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="text-slate-500">Nightly (piggyback)</span>
                <span className={data.settings.enabled ? "font-semibold text-emerald-300 light:text-emerald-700" : "font-semibold text-slate-400 light:text-slate-600"}>
                  {data.settings.enabled ? `${data.settings.scheduleTime} ${data.schedule.timezone}` : "disabled"}
                </span>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="text-slate-500">Ran today</span>
                <span className="text-slate-300 light:text-slate-700">{data.schedule.ranToday ? "Yes" : "Not yet"}</span>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="text-slate-500">Concurrency</span>
                <span className="text-slate-300 light:text-slate-700">
                  {data.inFlight.backup || data.inFlight.drill ? "1 run in flight" : "idle"}
                </span>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="text-slate-500">Retention</span>
                <span className="tabular-nums text-slate-300 light:text-slate-700">{data.settings.retention} artifacts</span>
              </div>
              <p className="rounded-lg border border-white/10 light:border-slate-200 bg-white/[0.02] light:bg-slate-50 p-2 leading-relaxed text-slate-500">
                <Info className="mr-1 inline h-3 w-3" aria-hidden />
                Schedule check: {data.schedule.check}
              </p>
              {canManage && (
                <Button variant="outline" size="sm" onClick={checkSchedule} disabled={schedBusy}
                  className="h-8 border-white/10 light:border-slate-300 bg-white/5 light:bg-white text-white light:text-slate-900">
                  {schedBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Clock className="h-3.5 w-3.5" />} Check schedule now
                </Button>
              )}
              {schedMsg && <p className="leading-relaxed text-slate-400 light:text-slate-600">{schedMsg}</p>}
            </div>
          </div>
        </div>
      ) : null}

      {/* ---- actions (settings.manage) ---- */}
      {canManage && data ? (
        <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-white/10 light:border-slate-200 bg-white/[0.03] light:bg-slate-100/60 p-3">
          <p className="mr-1 text-[10px] font-bold uppercase tracking-widest text-slate-500">Actions</p>
          <Button size="sm" onClick={() => { setRunError(null); setBackupOpen(true) }} disabled={anyInFlight || runBusy}
            className="h-9 bg-gradient-to-r from-blue-600 to-violet-600 text-white light:text-slate-900 hover:from-blue-500 hover:to-violet-500">
            <Play className="h-3.5 w-3.5" /> Run Backup Now
          </Button>
          <Button size="sm" onClick={() => { setRunError(null); setDrillOpen(true) }} disabled={anyInFlight || runBusy || !lastBackup}
            className="h-9 bg-gradient-to-r from-blue-600 to-violet-600 text-white light:text-slate-900 hover:from-blue-500 hover:to-violet-500">
            <FlaskConical className="h-3.5 w-3.5" /> Run Restore Drill
          </Button>
          <p className="w-full text-[10px] leading-relaxed text-slate-500 sm:w-auto sm:ml-1">
            both actions require type-to-confirm · one run of each kind at a time · drills max once per 24 h · audited server-side
          </p>
          {submitted && (
            <p className="w-full rounded-lg border border-emerald-400/30 bg-emerald-500/10 p-2 text-[11px] text-emerald-300 light:text-emerald-700">
              {submitted.type} submitted — background job <span className="font-mono">{submitted.jobId.slice(0, 12)}…</span> (run <span className="font-mono">{submitted.runId.slice(0, 12)}…</span>). Status appears below and in the Job Center.
            </p>
          )}
          {runError && (
            <p className="w-full break-words rounded-lg border border-rose-400/30 bg-rose-500/10 p-2 text-[11px] text-rose-300 light:text-rose-600" role="alert">
              {runError}
            </p>
          )}
        </div>
      ) : null}

      {/* ---- production-grade timer tip ---- */}
      {data && (
        <div className="flex items-start gap-3 rounded-2xl border border-amber-400/30 bg-amber-500/[0.07] p-4">
          <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" aria-hidden />
          <div className="min-w-0 text-xs leading-relaxed text-slate-300 light:text-slate-700">
            <p className="font-bold text-amber-300 light:text-amber-700">Production-grade path — deploy/backup.timer (runs outside the app)</p>
            <p className="mt-1">{data.timerNote}</p>
            <p className="mt-1 text-slate-500">
              Recommended: enable the timer for the encrypted offsite copy AND keep this console for the queryable run history, scheduled convenience and drills. Runbook: <span className="font-mono">docs/postgresql-backup-restore.md</span>.
            </p>
          </div>
        </div>
      )}

      {/* ---- engine note ---- */}
      {data && (
        <p className="flex items-start gap-2 text-[11px] leading-relaxed text-slate-500">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          {data.engineNote}
        </p>
      )}

      {/* ---- settings (settings.manage) ---- */}
      {canManage && form ? (
        <div className="rounded-2xl border border-white/10 light:border-slate-200 bg-white/[0.03] light:bg-slate-100/60 p-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-bold text-white light:text-slate-900">Schedule & Settings</p>
            <p className="text-[11px] text-slate-500">stored in SaaSSetting group <span className="font-mono">backup</span> · editable by settings.manage holders</p>
          </div>
          <div className="mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            <div className="space-y-2">
              <Label htmlFor="backup-enabled" className="text-xs text-slate-400 light:text-slate-600">Nightly backup (piggyback schedule)</Label>
              <div className="flex items-center gap-2.5">
                <Switch id="backup-enabled" checked={form.enabled} onCheckedChange={(v) => setForm({ ...form, enabled: v })} />
                <span className="text-xs text-slate-400 light:text-slate-600">{form.enabled ? `on · ${form.scheduleTime} Asia/Dhaka` : "off"}</span>
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="backup-schedule" className="text-xs text-slate-400 light:text-slate-600">Schedule time (HH:MM, Asia/Dhaka)</Label>
              <Input id="backup-schedule" value={form.scheduleTime} onChange={(e) => setForm({ ...form, scheduleTime: e.target.value })}
                placeholder="01:05" className="h-10 border-white/10 light:border-slate-300 bg-white/5 light:bg-white text-white light:text-slate-900" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="backup-retention" className="text-xs text-slate-400 light:text-slate-600">Retention (artifacts kept)</Label>
              <Input id="backup-retention" type="number" min={1} max={365} value={form.retention}
                onChange={(e) => setForm({ ...form, retention: Number(e.target.value) })}
                className="h-10 border-white/10 light:border-slate-300 bg-white/5 light:bg-white text-white light:text-slate-900" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="backup-alert" className="text-xs text-slate-400 light:text-slate-600">Failure alert email</Label>
              <Input id="backup-alert" type="email" value={form.alertEmail} onChange={(e) => setForm({ ...form, alertEmail: e.target.value })}
                placeholder="first SUPER_ADMIN owner user" className="h-10 border-white/10 light:border-slate-300 bg-white/5 light:bg-white text-white light:text-slate-900" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="backup-dir" className="text-xs text-slate-400 light:text-slate-600">Backup directory</Label>
              <Input id="backup-dir" value={form.dir} onChange={(e) => setForm({ ...form, dir: e.target.value })}
                placeholder="backups" className="h-10 border-white/10 light:border-slate-300 bg-white/5 light:bg-white text-white light:text-slate-900" />
              <p className="text-[10px] leading-relaxed text-slate-500">relative paths resolve against the server working directory — use an absolute path (e.g. /srv/hrm-backups) for production</p>
            </div>
            <div className="flex items-end">
              <Button onClick={saveSettings} disabled={saveBusy || !formValid}
                className="h-10 bg-gradient-to-r from-blue-600 to-violet-600 text-white light:text-slate-900">
                {saveBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : null} Save settings
              </Button>
            </div>
          </div>
          {saveMsg && <p className="mt-3 rounded-lg border border-emerald-400/30 bg-emerald-500/10 p-2 text-[11px] text-emerald-300 light:text-emerald-700">{saveMsg}</p>}
          {saveError && <p className="mt-3 rounded-lg border border-rose-400/30 bg-rose-500/10 p-2 text-[11px] text-rose-300 light:text-rose-600" role="alert">{saveError}</p>}
        </div>
      ) : null}

      {/* ---- history table ---- */}
      {data && (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <History className="h-4 w-4 text-slate-500" aria-hidden />
            <p className="text-sm font-bold text-white light:text-slate-900">Run History</p>
            <span className="ml-auto text-xs text-slate-500">{data.total} run{data.total === 1 ? "" : "s"}</span>
          </div>
          <TableShell headers={["Type", "Trigger", "Status", "Started", "Finished", "Duration", "Size", "Report"]} empty={data.rows.length === 0}>
            {data.rows.map((r) => (
              <tr key={r.id} className="align-top transition-colors hover:bg-white/[0.03] light:hover:bg-slate-100/60">
                <Td className="text-xs font-semibold">{r.type === "BACKUP" ? "Backup" : "Restore drill"}</Td>
                <Td className="text-xs">{r.trigger === "SCHEDULED" ? "Scheduled" : "Manual"}</Td>
                <Td><StatusChip status={r.status} /></Td>
                <Td className="text-xs">{fmtDateTime(r.startedAt)}</Td>
                <Td className="text-xs">{r.finishedAt ? fmtDateTime(r.finishedAt) : "—"}</Td>
                <Td className="text-xs tabular-nums">{fmtDuration(runDurationMs(r))}</Td>
                <Td className="text-xs tabular-nums">{fmtBytes(r.sizeBytes)}</Td>
                <Td>
                  <Button variant="outline" size="sm" onClick={() => { void openReport(r.id) }}
                    className="h-7 border-white/10 light:border-slate-300 bg-white/5 light:bg-white px-2.5 text-[11px] text-white light:text-slate-900">
                    <FileDown className="h-3 w-3" /> View
                  </Button>
                </Td>
              </tr>
            ))}
          </TableShell>
          <p className="text-[10px] leading-relaxed text-slate-500">
            FAILED rows record the exact tool error (credential-free); drill rows carry the full count-comparison report. History is append-only — pruned artifacts stay listed with their recorded checksum.
          </p>
        </div>
      )}

      {/* ---- type-to-confirm: run backup (keyed remount — typed resets on every open) ---- */}
      <ConfirmRunDialog
        key={backupOpen ? "backup-open" : "backup-closed"}
        open={backupOpen}
        onOpenChange={setBackupOpen}
        kind="BACKUP"
        busy={runBusy}
        error={runError}
        onConfirm={() => { void submitRun("BACKUP") }}
      />

      {/* ---- type-to-confirm: run drill ---- */}
      <ConfirmRunDialog
        key={drillOpen ? "drill-open" : "drill-closed"}
        open={drillOpen}
        onOpenChange={setDrillOpen}
        kind="DRILL"
        busy={runBusy}
        error={runError}
        onConfirm={() => { void submitRun("DRILL") }}
      />

      {/* ---- report dialog ---- */}
      <Dialog open={reportOpen} onOpenChange={setReportOpen}>
        <DialogContent className="max-w-2xl border-white/10 light:border-slate-200 bg-slate-950 light:bg-slate-50 light:bg-white">
          <DialogHeader>
            <DialogTitle className="flex flex-wrap items-center gap-2 text-white light:text-slate-900">
              Run Report
              {reportData && <StatusChip status={reportData.run.status} />}
              {reportData && <span className="text-xs font-normal text-slate-500">{reportData.run.type === "BACKUP" ? "Backup" : "Restore drill"} · {reportData.run.trigger === "SCHEDULED" ? "scheduled" : "manual"}</span>}
            </DialogTitle>
          </DialogHeader>
          {reportError && <p className="rounded-lg border border-red-400/30 bg-red-500/10 p-3 text-sm text-red-300 light:text-red-600">{reportError}</p>}
          {reportLoading && <Loading label="Loading report…" />}
          {reportData && <ReportBody data={reportData} />}
        </DialogContent>
      </Dialog>
    </div>
  )
}

// ============================== type-to-confirm dialog ==============================

function ConfirmRunDialog({ open, onOpenChange, kind, busy, error, onConfirm }: {
  open: boolean
  onOpenChange: (v: boolean) => void
  kind: "BACKUP" | "DRILL"
  busy: boolean
  error: string | null
  onConfirm: () => void
}) {
  const [typed, setTyped] = useState("") // reset via parent's keyed remount on every open
  const word = kind === "BACKUP" ? "BACKUP" : "DRILL"
  const Icon = kind === "BACKUP" ? Archive : FlaskConical
  const confirmed = typed === word
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md border-white/10 light:border-slate-200 bg-slate-950 light:bg-slate-50 light:bg-white">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-white light:text-slate-900">
            <Icon className="h-4 w-4" /> {kind === "BACKUP" ? "Run Backup Now" : "Run Restore Drill"}
          </DialogTitle>
        </DialogHeader>
        {error && <p className="break-words rounded-lg border border-red-400/30 bg-red-500/10 p-3 text-sm text-red-300 light:text-red-600" role="alert">{error}</p>}
        <div className="space-y-3">
          <p className="text-xs leading-relaxed text-slate-300 light:text-slate-700">
            {kind === "BACKUP"
              ? "Takes a logical dump of the live database, gzips it, records its sha256 checksum, prunes retention and appends the run to the history below. The database stays fully online."
              : "Restores the LATEST backup into a disposable hrm_drill_* scratch database — never the live one — re-verifies the checksum and compares core-table row counts. The scratch database is dropped afterwards. Drills run at most once per 24 h."}
          </p>
          <div>
            <Label htmlFor={`confirm-${kind.toLowerCase()}`} className="text-xs text-slate-400 light:text-slate-600">
              Type <span className="font-mono font-bold text-amber-300 light:text-amber-700">{word}</span> to confirm
            </Label>
            <Input
              id={`confirm-${kind.toLowerCase()}`}
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              autoComplete="off"
              spellCheck={false}
              placeholder={word}
              className="mt-1.5 h-10 border-white/10 light:border-slate-300 bg-white/5 light:bg-white font-mono tracking-widest text-white light:text-slate-900"
            />
          </div>
          {kind === "DRILL" && (
            <p className="flex items-start gap-2 rounded-lg border border-emerald-400/30 bg-emerald-500/10 p-2 text-[11px] leading-relaxed text-emerald-300 light:text-emerald-700">
              <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
              Hard guard: the engine refuses any drill target that equals the live DATABASE_URL — restore-over-live is impossible by construction.
            </p>
          )}
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} className="border-white/10 light:border-slate-300 bg-white/5 light:bg-white text-white light:text-slate-900">Cancel</Button>
          <Button onClick={onConfirm} disabled={busy || !confirmed}
            className="bg-gradient-to-r from-blue-600 to-violet-600 text-white light:text-slate-900">
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />} Run {word === "BACKUP" ? "backup" : "drill"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

// ============================== report dialog body ==============================

function ReportBody({ data }: { data: ReportResponse }) {
  const { run, report } = data
  const drill = run.type === "DRILL" ? (report as DrillReport | null) : null
  const backup = run.type === "BACKUP" ? (report as BackupReport | null) : null
  const duration = runDurationMs(run) ?? backup?.durationMs ?? drill?.durationMs ?? null
  return (
    <div className="space-y-4">
      {run.error && (
        <p className="break-words rounded-lg border border-rose-400/30 bg-rose-500/10 p-3 text-xs leading-relaxed text-rose-300 light:text-rose-600" role="alert">
          <AlertTriangle className="mr-1 inline h-3.5 w-3.5" aria-hidden />
          {run.error}
        </p>
      )}

      {/* ---- shared artifact details ---- */}
      <dl className="divide-y divide-white/5 light:divide-slate-200 rounded-xl border border-white/10 light:border-slate-200">
        <div className="grid grid-cols-[minmax(110px,38%)_1fr] gap-3 px-4 py-2.5">
          <dt className="text-xs text-slate-500">Location</dt>
          <dd className="break-words text-xs text-slate-200 light:text-slate-800">
            <span className="mr-1.5 rounded border border-white/10 light:border-slate-300 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-widest">{run.locationType}</span>
            <span className="font-mono">{run.locationPath || "—"}</span>
          </dd>
        </div>
        <div className="grid grid-cols-[minmax(110px,38%)_1fr] gap-3 px-4 py-2.5">
          <dt className="text-xs text-slate-500">Size</dt>
          <dd className="text-xs tabular-nums text-slate-200 light:text-slate-800">{fmtBytes(run.sizeBytes)}</dd>
        </div>
        <div className="grid grid-cols-[minmax(110px,38%)_1fr] gap-3 px-4 py-2.5">
          <dt className="text-xs text-slate-500">Checksum (sha256)</dt>
          <dd className="break-all font-mono text-[11px] leading-relaxed text-slate-200 light:text-slate-800">{run.checksum || "—"}</dd>
        </div>
        <div className="grid grid-cols-[minmax(110px,38%)_1fr] gap-3 px-4 py-2.5">
          <dt className="text-xs text-slate-500">Started / finished</dt>
          <dd className="text-xs text-slate-200 light:text-slate-800">
            {fmtDateTime(run.startedAt)} → {run.finishedAt ? fmtDateTime(run.finishedAt) : "in flight"}
            {duration != null && <span className="ml-1 text-slate-500">({fmtDuration(duration)})</span>}
          </dd>
        </div>
        {run.retentionKept != null && (
          <div className="grid grid-cols-[minmax(110px,38%)_1fr] gap-3 px-4 py-2.5">
            <dt className="text-xs text-slate-500">Retention kept</dt>
            <dd className="text-xs tabular-nums text-slate-200 light:text-slate-800">{run.retentionKept} artifacts</dd>
          </div>
        )}
      </dl>

      {/* ---- backup-specific: engine stats ---- */}
      {backup && (
        <div className="rounded-xl border border-white/10 light:border-slate-200 p-4">
          <p className="mb-2 text-[10px] font-bold uppercase tracking-widest text-slate-500">Artifact details</p>
          <dl className="space-y-1.5 text-xs">
            <div className="flex justify-between gap-3">
              <dt className="text-slate-500">Engine</dt>
              <dd className="text-right text-slate-200 light:text-slate-800">{backup.format}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-slate-500">Dump size (pre-gzip)</dt>
              <dd className="tabular-nums text-slate-200 light:text-slate-800">{fmtBytes(backup.gzip?.inputBytes)}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-slate-500">Compressed size</dt>
              <dd className="tabular-nums text-slate-200 light:text-slate-800">{fmtBytes(backup.gzip?.outputBytes)}</dd>
            </div>
            {Number.isFinite(backup.gzip?.inputBytes) && (backup.gzip.inputBytes || 0) > 0 && (
              <div className="flex justify-between gap-3">
                <dt className="text-slate-500">Compression ratio</dt>
                <dd className="tabular-nums text-slate-200 light:text-slate-800">
                  {(backup.gzip.inputBytes / Math.max(1, backup.gzip.outputBytes)).toFixed(1)}×
                </dd>
              </div>
            )}
          </dl>
        </div>
      )}

      {/* ---- drill-specific: verification + counts ---- */}
      {drill && (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-widest ${drill.pass ? "border-emerald-400/40 bg-emerald-500/10 text-emerald-300 light:text-emerald-700" : "border-rose-400/40 bg-rose-500/10 text-rose-300 light:text-rose-600"}`}>
              {drill.pass ? <ShieldCheck className="h-3 w-3" /> : <ShieldAlert className="h-3 w-3" />}
              {drill.pass ? "Passed" : "Failed"}
            </span>
            <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-widest ${drill.checksumVerified ? "border-emerald-400/40 bg-emerald-500/10 text-emerald-300 light:text-emerald-700" : "border-rose-400/40 bg-rose-500/10 text-rose-300 light:text-rose-600"}`}>
              <CheckCircle2 className="h-3 w-3" /> checksum {drill.checksumVerified ? "verified" : "MISMATCH"}
            </span>
            <span className="text-[11px] text-slate-500">
              {drill.restoredTables != null ? `${drill.restoredTables} tables restored` : "tables not counted"}{drill.drilledAt ? ` · drilled ${timeAgo(drill.drilledAt)}` : ""}
            </span>
          </div>
          <TableShell headers={["Core table", "Live (source)", "Restored", "Match"]} empty={drill.counts.length === 0}>
            {drill.counts.map((c) => (
              <tr key={c.table}>
                <Td className="text-xs font-mono">{c.table}</Td>
                <Td className="text-xs tabular-nums">{c.source.toLocaleString()}</Td>
                <Td className="text-xs tabular-nums">{c.restored.toLocaleString()}</Td>
                <Td>
                  {c.match ? (
                    <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-emerald-300 light:text-emerald-700"><CheckCircle2 className="h-3.5 w-3.5" aria-hidden /> exact</span>
                  ) : (
                    <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-rose-300 light:text-rose-600"><XCircle className="h-3.5 w-3.5" aria-hidden /> Δ {c.restored - c.source > 0 ? "+" : ""}{c.restored - c.source}</span>
                  )}
                </Td>
              </tr>
            ))}
          </TableShell>
          <ul className="space-y-1 rounded-xl border border-white/10 light:border-slate-200 p-4">
            {drill.notes.map((n, i) => (
              <li key={i} className="flex items-start gap-2 text-[11px] leading-relaxed text-slate-500">
                <Info className="mt-0.5 h-3 w-3 shrink-0" aria-hidden /> {n}
              </li>
            ))}
          </ul>
        </>
      )}
      {!drill && !backup && !run.error && (
        <p className="text-xs leading-relaxed text-slate-500">No engine report was recorded for this run (it may predate the report format or have failed before reporting).</p>
      )}
    </div>
  )
}

"use client"
// ============ /owner/health — System Health console (Wave 2 WP-N) ============
// Live server-side checks (owner.health.snapshot): application, database,
// background jobs, email/SMS gateways, ZKTeco ADMS plane, camera services,
// backups, storage, disk, SSL, failed logins. Every value on this page comes
// from the snapshot response — no fabricated numbers.
//
// Auto-refreshes every 60 s (matching the server-side per-check cache TTL);
// manual test actions (Send test email / SMS, Clear cache) are gated on the
// session's health.manage permission and audited server-side.
import { useEffect, useMemo, useState } from "react"
import {
  Activity, Archive, ChevronDown, Database, Disc, Fingerprint, Globe, HardDrive,
  ListChecks, Loader2, Mail, MessageSquare, RefreshCw, Server, Trash2, Video,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { useOwnerApi, ownerRpc } from "@/saas/owner/client"
import { ErrorBanner, Loading, PageHeader, fmtDateTime } from "@/saas/owner/ui"

type HealthStatus = "ok" | "degraded" | "down" | "unknown"

type HealthCheck = {
  id: string
  label: string
  status: HealthStatus
  detail: string
  lastCheckedAt: string
  meta: Record<string, unknown>
}

type Snapshot = {
  overall: "ok" | "degraded" | "down"
  overallNote: string
  counts: { ok: number; degraded: number; down: number; unknown: number }
  generatedAt: string
  cacheTtlSec: number
  checks: HealthCheck[]
}

type TestOutcome = { status: string; detail?: string; note?: string }

const CHECK_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  application: Server,
  database: Database,
  jobs: ListChecks,
  email: Mail,
  sms: MessageSquare,
  zkteco: Fingerprint,
  cameras: Video,
  backup: Archive,
  storage: HardDrive,
  disk: Disc,
  ssl: Globe,
  logins: Activity,
}

const STATUS_TONE: Record<HealthStatus, { dot: string; chip: string }> = {
  ok: { dot: "bg-emerald-400", chip: "border-emerald-400/40 bg-emerald-500/10 text-emerald-300 light:text-emerald-700" },
  degraded: { dot: "bg-amber-400", chip: "border-amber-400/40 bg-amber-500/10 text-amber-300 light:text-amber-700" },
  down: { dot: "bg-rose-400", chip: "border-rose-400/40 bg-rose-500/10 text-rose-300 light:text-rose-600" },
  unknown: { dot: "bg-slate-400", chip: "border-slate-400/40 bg-slate-500/10 light:bg-slate-200 text-slate-400 light:text-slate-600" },
}

const BANNER: Record<"ok" | "degraded" | "down", { label: string; cls: string; dot: string }> = {
  ok: { label: "System Healthy", cls: "border-emerald-400/30 bg-emerald-500/10", dot: "bg-emerald-400" },
  degraded: { label: "Degraded", cls: "border-amber-400/30 bg-amber-500/10", dot: "bg-amber-400" },
  down: { label: "System Down", cls: "border-rose-400/40 bg-rose-500/10", dot: "bg-rose-400" },
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

function fmtBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${bytes} B`
}

function metaLabel(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/^./, (c) => c.toUpperCase())
}

function fmtMetaValue(key: string, v: unknown): string {
  if (v === null || v === undefined) return "—"
  if (typeof v === "boolean") return v ? "Yes" : "No"
  if (typeof v === "number") return /bytes$/i.test(key) ? fmtBytes(v) : v.toLocaleString()
  if (typeof v === "string") {
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(v)) return new Date(v).toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })
    return v
  }
  return JSON.stringify(v)
}

function outcomeTone(status: string): string {
  if (status === "SENT") return "border-emerald-400/40 bg-emerald-500/10 text-emerald-300 light:text-emerald-700"
  if (status === "FAILED") return "border-rose-400/40 bg-rose-500/10 text-rose-300 light:text-rose-600"
  return "border-slate-400/40 bg-slate-500/10 light:bg-slate-200 text-slate-400 light:text-slate-600"
}

export default function OwnerHealthPage() {
  const { data, loading, error, reload } = useOwnerApi<Snapshot>("owner.health.snapshot")
  const me = useOwnerApi<{ owner: { permissions: string[] } }>("owner.auth.me", {})
  const canManage = useMemo(() => !!me.data?.owner?.permissions?.includes("health.manage"), [me.data])

  // auto-refresh every 60 s — matches the server-side per-check cache TTL; the
  // interval is cleaned up on unmount so leaving the page stops the polling.
  useEffect(() => {
    const t = setInterval(() => { reload() }, 60_000)
    return () => clearInterval(t)
  }, [reload])

  // ---- manual test actions (perm health.manage) ----
  const [emailOpen, setEmailOpen] = useState(false)
  const [smsOpen, setSmsOpen] = useState(false)
  const [emailTo, setEmailTo] = useState("")
  const [smsTo, setSmsTo] = useState("")
  const [busy, setBusy] = useState(false)
  const [emailError, setEmailError] = useState<string | null>(null)
  const [smsError, setSmsError] = useState<string | null>(null)
  const [emailResult, setEmailResult] = useState<TestOutcome | null>(null)
  const [smsResult, setSmsResult] = useState<TestOutcome | null>(null)

  // after a manual action, drop the server check cache so the next snapshot
  // reflects the fresh send attempt immediately (both need health.manage)
  const refreshAfterAction = () => {
    ownerRpc("owner.health.clearCache", {})
      .catch(() => {})
      .then(() => { reload().catch(() => {}) })
  }

  const openEmailDialog = () => {
    setEmailError(null); setEmailResult(null); setEmailTo("")
    setEmailOpen(true)
  }
  const openSmsDialog = () => {
    setSmsError(null); setSmsResult(null); setSmsTo("")
    setSmsOpen(true)
  }

  const sendTestEmail = async () => {
    setBusy(true); setEmailError(null); setEmailResult(null)
    try {
      const d = await ownerRpc<{ result: { status: string; detail?: string } }>("owner.health.testEmail", { to: emailTo })
      setEmailResult({ status: d.result.status, detail: d.result.detail })
      refreshAfterAction()
    } catch (e: unknown) {
      setEmailError((e as Error)?.message || "Send failed")
    } finally { setBusy(false) }
  }

  const sendTestSms = async () => {
    setBusy(true); setSmsError(null); setSmsResult(null)
    try {
      const d = await ownerRpc<{ result: { status: string; detail?: string }; note?: string }>("owner.health.testSms", { to: smsTo })
      setSmsResult({ status: d.result.status, detail: d.result.detail, note: d.note })
      refreshAfterAction()
    } catch (e: unknown) {
      setSmsError((e as Error)?.message || "Send failed")
    } finally { setBusy(false) }
  }

  const clearCache = async () => {
    setBusy(true)
    try {
      await ownerRpc("owner.health.clearCache", {})
      await reload()
    } catch (e: unknown) {
      window.alert((e as Error)?.message || "Failed to clear cache")
    } finally { setBusy(false) }
  }

  const banner = data ? BANNER[data.overall] : null

  return (
    <div className="space-y-5">
      <PageHeader
        title="System Health"
        sub="Live platform checks — application, database, job queue, gateways, devices, cameras, storage. Server-side checks cache for 60 s; this page re-polls on the same cadence."
      />

      {/* overall banner */}
      {banner && data ? (
        <div className={`flex flex-wrap items-center gap-x-6 gap-y-3 rounded-2xl border p-4 sm:p-5 ${banner.cls}`}>
          <div className="flex items-center gap-3">
            <span className="relative flex h-3.5 w-3.5">
              <span className={`absolute inline-flex h-full w-full animate-ping rounded-full ${banner.dot} opacity-60`} />
              <span className={`relative inline-flex h-3.5 w-3.5 rounded-full ${banner.dot}`} />
            </span>
            <p className="text-lg font-bold tracking-tight text-white light:text-slate-900">{banner.label}</p>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            {(["ok", "degraded", "down", "unknown"] as HealthStatus[]).map((s) => (
              <span key={s} className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-bold uppercase tracking-widest ${STATUS_TONE[s].chip}`}>
                <span className={`h-1.5 w-1.5 rounded-full ${STATUS_TONE[s].dot}`} aria-hidden />
                {data.counts[s]} {s}
              </span>
            ))}
          </div>
          <div className="ml-auto flex items-center gap-3">
            <div className="text-right">
              <p className="text-[11px] text-slate-400 light:text-slate-600" title={data.generatedAt ? fmtDateTime(data.generatedAt) : undefined}>
                refreshed {timeAgo(data.generatedAt)} · auto 60 s
              </p>
              {loading && <p className="text-[10px] text-slate-500">refreshing…</p>}
            </div>
            <Button variant="outline" size="sm" onClick={() => { reload().catch(() => {}) }} disabled={loading}
              className="h-9 border-white/10 light:border-slate-300 bg-white/5 light:bg-white text-white light:text-slate-900">
              {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />} Refresh
            </Button>
          </div>
        </div>
      ) : null}

      {/* manual actions toolbar — perm-gated on health.manage */}
      {canManage ? (
        <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-white/10 light:border-slate-200 bg-white/[0.03] light:bg-slate-100/60 p-3">
          <p className="mr-1 text-[10px] font-bold uppercase tracking-widest text-slate-500">Manual actions</p>
          <Button size="sm" onClick={openEmailDialog} className="h-9 bg-gradient-to-r from-blue-600 to-violet-600 text-white light:text-slate-900 hover:from-blue-500 hover:to-violet-500">
            <Mail className="h-3.5 w-3.5" /> Send test email
          </Button>
          <Button size="sm" onClick={openSmsDialog} className="h-9 bg-gradient-to-r from-blue-600 to-violet-600 text-white light:text-slate-900 hover:from-blue-500 hover:to-violet-500">
            <MessageSquare className="h-3.5 w-3.5" /> Send test SMS
          </Button>
          <Button size="sm" variant="outline" onClick={clearCache} disabled={busy}
            className="h-9 border-white/10 light:border-slate-300 bg-white/5 light:bg-white text-white light:text-slate-900">
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />} Clear check cache
          </Button>
          <p className="w-full text-[10px] text-slate-500 sm:w-auto sm:ml-1">test sends are rate-limited to 1 per 60 s and audited</p>
        </div>
      ) : null}

      {error && <ErrorBanner message={error} />}
      {loading && !data ? (
        <Loading label="Running system health checks…" />
      ) : data ? (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {data.checks.map((c) => <HealthCard key={c.id} check={c} />)}
        </div>
      ) : null}

      {/* ---- send test email dialog ---- */}
      <Dialog open={emailOpen} onOpenChange={setEmailOpen}>
        <DialogContent className="max-w-md border-white/10 light:border-slate-200 bg-slate-950 light:bg-slate-50 light:bg-white">
          <DialogHeader><DialogTitle className="text-white light:text-slate-900">Send test email</DialogTitle></DialogHeader>
          {emailError && <p className="rounded-lg border border-red-400/30 bg-red-500/10 p-3 text-sm text-red-300 light:text-red-600">{emailError}</p>}
          <div className="space-y-3">
            <div>
              <Label htmlFor="health-test-email" className="text-xs text-slate-400 light:text-slate-600">To address</Label>
              <Input id="health-test-email" type="email" value={emailTo} onChange={(e) => setEmailTo(e.target.value)}
                placeholder="ops@example.com" className="mt-1.5 h-10 border-white/10 light:border-slate-300 bg-white/5 light:bg-white text-white light:text-slate-900" />
              <p className="mt-1.5 text-[11px] leading-relaxed text-slate-500">
                Sends a short message through the platform email gateway (Settings → Platform Gateway). The result is recorded in the notification feed and audited.
              </p>
            </div>
            {emailResult && (
              <div className="rounded-lg border border-white/10 light:border-slate-200 bg-white/[0.03] light:bg-slate-100/60 p-3">
                <span className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-widest ${outcomeTone(emailResult.status)}`}>
                  {emailResult.status}
                </span>
                {emailResult.detail ? <p className="mt-2 text-xs leading-relaxed text-slate-300 light:text-slate-700">{emailResult.detail}</p> : null}
              </div>
            )}
          </div>
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="outline" onClick={() => setEmailOpen(false)} className="border-white/10 light:border-slate-300 bg-white/5 light:bg-white text-white light:text-slate-900">Close</Button>
            <Button onClick={sendTestEmail} disabled={busy || !emailTo}
              className="bg-gradient-to-r from-blue-600 to-violet-600 text-white light:text-slate-900">
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Mail className="h-4 w-4" />} Send test
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* ---- send test SMS dialog ---- */}
      <Dialog open={smsOpen} onOpenChange={setSmsOpen}>
        <DialogContent className="max-w-md border-white/10 light:border-slate-200 bg-slate-950 light:bg-slate-50 light:bg-white">
          <DialogHeader><DialogTitle className="text-white light:text-slate-900">Send test SMS</DialogTitle></DialogHeader>
          {smsError && <p className="rounded-lg border border-red-400/30 bg-red-500/10 p-3 text-sm text-red-300 light:text-red-600">{smsError}</p>}
          <div className="space-y-3">
            <div>
              <Label htmlFor="health-test-sms" className="text-xs text-slate-400 light:text-slate-600">To phone number</Label>
              <Input id="health-test-sms" type="tel" value={smsTo} onChange={(e) => setSmsTo(e.target.value)}
                placeholder="+8801XXXXXXXXX" className="mt-1.5 h-10 border-white/10 light:border-slate-300 bg-white/5 light:bg-white text-white light:text-slate-900" />
              <p className="mt-1.5 text-[11px] leading-relaxed text-slate-500">
                Best-effort: sends through the platform SMS gateway when one is configured (Settings → Platform Gateway). Tenant workspaces own their own SMS settings.
              </p>
            </div>
            {smsResult && (
              <div className="rounded-lg border border-white/10 light:border-slate-200 bg-white/[0.03] light:bg-slate-100/60 p-3">
                <span className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-widest ${outcomeTone(smsResult.status)}`}>
                  {smsResult.status}
                </span>
                {smsResult.note ? <p className="mt-2 text-xs leading-relaxed text-slate-300 light:text-slate-700">{smsResult.note}</p> : null}
                {smsResult.detail ? <p className="mt-2 text-xs leading-relaxed text-slate-300 light:text-slate-700">{smsResult.detail}</p> : null}
              </div>
            )}
          </div>
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="outline" onClick={() => setSmsOpen(false)} className="border-white/10 light:border-slate-300 bg-white/5 light:bg-white text-white light:text-slate-900">Close</Button>
            <Button onClick={sendTestSms} disabled={busy || !smsTo}
              className="bg-gradient-to-r from-blue-600 to-violet-600 text-white light:text-slate-900">
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <MessageSquare className="h-4 w-4" />} Send test
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function HealthCard({ check }: { check: HealthCheck }) {
  const Icon = CHECK_ICONS[check.id] || Activity
  const tone = STATUS_TONE[check.status]
  return (
    <Collapsible className="overflow-hidden rounded-2xl border border-white/10 light:border-slate-200 bg-white/[0.03] light:bg-slate-100/60">
      <CollapsibleTrigger className="group w-full px-4 py-4 text-left transition-colors hover:bg-white/[0.02] light:hover:bg-slate-100/70 sm:px-5">
        <div className="flex items-start gap-3">
          <span className={`mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border ${tone.chip}`} aria-hidden>
            <Icon className="h-4 w-4" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className={`h-2 w-2 shrink-0 rounded-full ${tone.dot}`} aria-hidden />
              <p className="truncate text-sm font-bold text-white light:text-slate-900">{check.label}</p>
              <ChevronDown className="ml-auto h-4 w-4 shrink-0 text-slate-500 transition-transform group-data-[state=open]:rotate-180" aria-hidden />
            </div>
            <span className={`mt-1.5 inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-widest ${tone.chip}`}>
              {check.status}
            </span>
            <p className="mt-1.5 text-xs leading-relaxed text-slate-300 light:text-slate-700">{check.detail}</p>
            <p className="mt-1.5 text-[10px] text-slate-500">checked {timeAgo(check.lastCheckedAt)}</p>
          </div>
        </div>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="border-t border-white/10 light:border-slate-200 px-4 py-3 sm:px-5">
          <p className="mb-1.5 text-[10px] font-bold uppercase tracking-widest text-slate-500">Details</p>
          <div className="max-h-72 divide-y divide-white/5 overflow-y-auto scroll-thin light:divide-slate-200">
            {Object.entries(check.meta).map(([k, v]) => (
              <div key={k} className="grid grid-cols-[minmax(110px,42%)_1fr] gap-3 py-1.5">
                <span className="text-xs text-slate-500">{metaLabel(k)}</span>
                <span className="break-words text-xs text-slate-200 light:text-slate-800">{fmtMetaValue(k, v)}</span>
              </div>
            ))}
          </div>
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}

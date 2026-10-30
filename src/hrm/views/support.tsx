"use client"
// ============ Support Center (master prompt §3.1 + §3.2) — tenant plane ====
// Two CLEARLY separated surfaces (ordinary chat must never blur with the
// privileged Live Support Access plane):
//   1. SUPPORT TICKETS — threaded chat with support (list + filters, bubbles:
//      TENANT right / SUPPORT left, attachments ≤5 MB via FileReader → dataUrl,
//      reply/close/reopen, and a 15s visibility-gated conversation poll — the
//      attendance.liveFeed pattern).
//   2. LIVE SUPPORT ACCESS — amber-tinted privileged plane: request → owner
//      review → ACTIVE time-limited, module-scoped, audited session; the
//      tenant can end it any time. One-open-request rule: the server 409s a
//      second live request — the form hides while one is open (409 surfaced).

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  AlertTriangle, CheckCircle2, Clock, Eye, FileDown, Headset, History, Inbox,
  MessageSquare, Paperclip, PenLine, Plus, RotateCcw, Send, ShieldAlert,
  ShieldCheck, Timer, X,
} from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { Textarea } from "@/components/ui/textarea"
import { useHrm } from "../store"
import { rpc, useApi } from "../api"
import {
  EmptyState, ErrorBanner, FieldError, LoadingRows, PageHeader, SectionCard,
  SectionTabs, fmtDateTime, titleCase,
} from "../shared/ui-kit"
import { ConfirmDialog } from "../shared/form-dialog"

// ---------------- contracts (src/hrm-server/routes/support.ts) ----------------

type TicketStatus = "OPEN" | "ASSIGNED" | "IN_PROGRESS" | "WAITING_TENANT" | "WAITING_SUPPORT" | "RESOLVED" | "CLOSED"
type Priority = "LOW" | "NORMAL" | "HIGH" | "URGENT"
type LiveStatus = "PENDING_REVIEW" | "APPROVED" | "REJECTED" | "ACTIVE" | "COMPLETED" | "REVOKED" | "EXPIRED" | "CANCELLED"
/** Request statuses that block a new live request (one-open-request rule). */
const OPEN_LIVE_STATUSES: LiveStatus[] = ["PENDING_REVIEW", "APPROVED", "ACTIVE"]
const PRIORITIES: Priority[] = ["LOW", "NORMAL", "HIGH", "URGENT"]

type SessionInfo = {
  id: string; operatorName: string | null; accessMode: string; modules: string[]
  startedAt: string | null; expiresAt: string | null; reason?: string | null
}
type Overview = {
  stats: { open: number; awaitingTenant: number; activeLiveRequests: number }
  recent: { id: string; number: string; subject: string; status: TicketStatus; priority: Priority; category: string; updatedAt: string }[]
  moduleOptions: { key: string; label: string; available: boolean }[]
  categories: string[]
  activeSupportSession: SessionInfo | null
}
type TicketRow = {
  id: string; number: string; subject: string; category: string; priority: Priority; status: TicketStatus
  assigneeName: string | null; lastMessageAt: string | null; createdAt: string; closedAt: string | null
}
type TicketAttachment = { objectKey: string; fileName: string; mimeType: string; sizeBytes: number; uploadedBy: string; url: string | null }
type TicketMessage = {
  id: string; authorRole: "TENANT" | "SUPPORT"; authorName: string; body: string; createdAt: string
  attachments: TicketAttachment[]
}
type TicketDetail = {
  ticket: {
    id: string; number: string; subject: string; category: string; priority: Priority; status: TicketStatus
    requesterName: string; assigneeName: string | null; firstResponseAt: string | null
    createdAt: string; closedAt: string | null; closedByName: string | null
  }
  messages: TicketMessage[]
}
type LiveSession = {
  id: string; status: string; operatorName: string | null; accessMode: string; modules: string[]
  startedAt: string | null; expiresAt: string | null; endedReason: string | null
}
type LiveRequestRow = {
  id: string; title: string; category: string; modules: string[]; priority: Priority; status: LiveStatus
  requestedByName: string; requestedAt: string; reviewedByName: string | null; reviewedAt: string | null
  reviewNote: string | null; approvedMinutes: number | null; approvedAgentName: string | null
  session: LiveSession | null
}

// ---------------- shared visual vocabulary ----------------

/** §3.2 — the ticket-status chip colors mandated for this surface. */
const TICKET_STATUS_TONE: Record<string, string> = {
  OPEN: "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300",
  ASSIGNED: "bg-indigo-100 text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300",
  IN_PROGRESS: "bg-violet-100 text-violet-700 dark:bg-violet-950 dark:text-violet-300",
  WAITING_TENANT: "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
  WAITING_SUPPORT: "bg-cyan-100 text-cyan-700 dark:bg-cyan-950 dark:text-cyan-300",
  RESOLVED: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
  CLOSED: "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400",
}
const LIVE_STATUS_TONE: Record<string, string> = {
  PENDING_REVIEW: "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
  APPROVED: "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300",
  ACTIVE: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
  REJECTED: "bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300",
  COMPLETED: "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400",
}
LIVE_STATUS_TONE.REVOKED = LIVE_STATUS_TONE.EXPIRED = LIVE_STATUS_TONE.REJECTED
LIVE_STATUS_TONE.CANCELLED = LIVE_STATUS_TONE.COMPLETED
const PRIORITY_TONE: Record<string, string> = {
  LOW: "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400",
  NORMAL: "bg-sky-100 text-sky-700 dark:bg-sky-950 dark:text-sky-300",
  HIGH: "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
  URGENT: "bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300",
}
const TICKET_FILTERS: { value: "ALL" | TicketStatus; label: string }[] = [
  { value: "ALL", label: "All" }, { value: "OPEN", label: "Open" }, { value: "ASSIGNED", label: "Assigned" },
  { value: "IN_PROGRESS", label: "In progress" }, { value: "WAITING_TENANT", label: "Waiting you" },
  { value: "WAITING_SUPPORT", label: "Waiting support" }, { value: "RESOLVED", label: "Resolved" },
  { value: "CLOSED", label: "Closed" },
]

function StatusChip({ status, tone }: { status: string; tone: Record<string, string> }) {
  return <Badge variant="secondary" className={`font-semibold whitespace-nowrap ${tone[status] || ""}`}>{titleCase(status)}</Badge>
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

/** Shared category / priority selects (New Ticket + Live Request forms). */
function CategorySelect({ value, onChange, categories }: { value: string; onChange: (v: string) => void; categories: string[] }) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger aria-label="Category" className="text-sm"><SelectValue /></SelectTrigger>
      <SelectContent>
        {categories.map((c) => <SelectItem key={c} value={c}>{titleCase(c)}</SelectItem>)}
      </SelectContent>
    </Select>
  )
}
function PrioritySelect({ value, onChange }: { value: Priority; onChange: (v: string) => void }) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger aria-label="Priority" className="text-sm"><SelectValue /></SelectTrigger>
      <SelectContent>
        {PRIORITIES.map((p) => <SelectItem key={p} value={p}>{titleCase(p)}</SelectItem>)}
      </SelectContent>
    </Select>
  )
}

// ---------------- attachments (client-side validation + FileReader) ----------------

const MAX_ATTACHMENTS = 5
const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024
const ATTACH_ACCEPT = "image/jpeg,image/png,image/webp,application/pdf"
const ATTACH_TYPES = ["image/jpeg", "image/png", "image/webp", "application/pdf"]
type PendingAttachment = { fileName: string; sizeBytes: number; dataUrl: string }

/** Attach button + file chips. Validates type/size/count client-side (the
 *  server re-sniffs magic bytes and rejects anything else — belt & braces). */
function AttachmentPicker({ value, onChange, id }: {
  value: PendingAttachment[]; onChange: (v: PendingAttachment[]) => void; id: string
}) {
  const [error, setError] = useState<string | null>(null)
  // a ref mirror keeps concurrent FileReader callbacks from clobbering each other
  const valueRef = useRef(value)
  useEffect(() => { valueRef.current = value })

  const addFiles = (files: FileList | null) => {
    if (!files || !files.length) return
    setError(null)
    const picked = Array.from(files)
    const room = MAX_ATTACHMENTS - valueRef.current.length
    if (picked.length > room) setError(`At most ${MAX_ATTACHMENTS} attachments per message`)
    for (const f of picked.slice(0, Math.max(0, room))) {
      if (!ATTACH_TYPES.includes(f.type)) { setError(`"${f.name}" is not a JPEG, PNG, WebP or PDF file`); continue }
      if (f.size > MAX_ATTACHMENT_BYTES) { setError(`"${f.name}" is ${(f.size / 1024 / 1024).toFixed(1)} MB — the limit is 5 MB`); continue }
      const reader = new FileReader()
      reader.onload = () => {
        valueRef.current = [...valueRef.current, { fileName: f.name, sizeBytes: f.size, dataUrl: String(reader.result || "") }]
        onChange(valueRef.current)
      }
      reader.onerror = () => setError(`"${f.name}" could not be read`)
      reader.readAsDataURL(f)
    }
  }

  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <label htmlFor={id} className="inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-md border bg-background px-2.5 text-xs font-medium transition-colors hover:bg-accent hover:text-accent-foreground">
          <Paperclip className="h-3.5 w-3.5" /> Attach files
        </label>
        <input id={id} type="file" multiple accept={ATTACH_ACCEPT} className="hidden"
          onChange={(e) => { addFiles(e.target.files); e.target.value = "" }} />
        {value.map((a, i) => (
          <span key={`${a.fileName}-${i}`} className="inline-flex items-center gap-1 rounded-full border border-slate-200 bg-slate-50 py-0.5 pl-2.5 pr-1 text-[11px] font-medium text-slate-600 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300">
            {a.fileName} <span className="text-slate-400">({fmtBytes(a.sizeBytes)})</span>
            <button type="button" aria-label={`Remove attachment ${a.fileName}`}
              className="rounded-full p-0.5 text-slate-400 hover:bg-slate-200 hover:text-slate-700 dark:hover:bg-slate-800 dark:hover:text-slate-200"
              onClick={() => onChange(value.filter((_, idx) => idx !== i))}>
              <X className="h-3 w-3" />
            </button>
          </span>
        ))}
      </div>
      {error ? <FieldError message={error} /> : <p className="text-[11px] text-slate-400">JPEG, PNG, WebP or PDF — up to {MAX_ATTACHMENTS} files, 5 MB each.</p>}
    </div>
  )
}

// ---------------- countdown (UX only — the server enforces expiry) ----------------

function Countdown({ expiresAt, onExpire }: { expiresAt: string | null; onExpire?: () => void }) {
  const [left, setLeft] = useState<number | null>(null)
  const firedRef = useRef(false)
  useEffect(() => { firedRef.current = false }, [expiresAt])
  useEffect(() => {
    if (!expiresAt) return
    const end = new Date(expiresAt).getTime()
    const tick = () => {
      const ms = end - Date.now()
      setLeft(ms)
      if (ms <= 0 && !firedRef.current) { firedRef.current = true; onExpire?.() }
    }
    tick()
    const t = setInterval(tick, 1000)
    return () => clearInterval(t)
  }, [expiresAt, onExpire])
  if (left == null) return <span className="text-slate-400">—</span>
  if (left <= 0) return <span className="font-bold text-rose-600 dark:text-rose-400">expired</span>
  const s = Math.floor(left / 1000)
  return (
    <span className={`inline-flex items-center gap-1 font-bold tabular-nums ${left < 120_000 ? "text-rose-600 dark:text-rose-400" : ""}`}>
      <Timer className="h-3.5 w-3.5" /> {Math.floor(s / 60)}:{String(s % 60).padStart(2, "0")}
    </span>
  )
}

// =====================================================================
// View root
// =====================================================================

export default function SupportView() {
  const vendor = useHrm((s) => s.vendor)
  // stale data stays mounted during reloads — a silent overview refresh must
  // never unmount the conversation pane
  const { data, loading, error, reload } = useApi<Overview>("support.overview", {})
  // selection survives tab switches (the tickets tab content unmounts)
  const [selectedTicketId, setSelectedTicketId] = useState<string | null>(null)

  if (loading && !data) return <PageHeader title="Support Center" subtitle="Loading support…" />
  if (!data) {
    return (
      <div className="space-y-4">
        <PageHeader title="Support Center" subtitle={vendor?.name} />
        <ErrorBanner message={error || "Support Center is unavailable right now. Please try again in a moment."} />
      </div>
    )
  }

  return (
    <div className="space-y-5">
      <PageHeader title="Support Center"
        subtitle={`${vendor?.name || "Your workspace"} · chat with the platform support team, or request audited live support access`}
        actions={data.activeSupportSession ? (
          <Badge variant="outline" className="gap-1 border-amber-400 text-amber-600 dark:text-amber-400">
            <ShieldAlert className="h-3 w-3" /> Live session active
          </Badge>
        ) : undefined} />

      <SectionTabs tabs={[
        {
          value: "tickets",
          label: "Support Tickets",
          badge: data.stats.open > 0 ? data.stats.open : undefined,
          content: <TicketsTab overview={data} reloadOverview={reload}
            selectedId={selectedTicketId} onSelect={setSelectedTicketId} />,
        },
        {
          value: "live",
          label: "Live Support Access",
          badge: data.stats.activeLiveRequests > 0 ? data.stats.activeLiveRequests : undefined,
          badgeTone: "amber",
          description: (
            <div className="flex gap-3 rounded-xl border border-amber-300 bg-amber-50/80 p-4 text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
              <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden />
              <div>
                <p className="flex flex-wrap items-center gap-1.5 text-sm font-bold">
                  <ShieldCheck className="h-4 w-4 text-amber-600 dark:text-amber-400" aria-hidden />
                  Live Support Access — privileged, audited, time-limited
                </p>
                <p className="mt-1 text-[13px] font-normal">
                  Grants authorized Finix HR support staff time-limited, audited, module-scoped access to your
                  workspace to investigate issues. They never see your password.
                </p>
              </div>
            </div>
          ),
          content: <LiveAccessTab overview={data} reloadOverview={reload} />,
        },
      ]} />
    </div>
  )
}

// =====================================================================
// TAB 1 — ordinary chat support
// =====================================================================

function StatPill({ icon: Icon, label, value, tone }: { icon: any; label: string; value: number; tone: string }) {
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-semibold tabular-nums ${tone}`}>
      <Icon className="h-3.5 w-3.5" aria-hidden /> {label}: {value}
    </span>
  )
}

function TicketsTab({ overview, reloadOverview, selectedId, onSelect }: {
  overview: Overview; reloadOverview: () => void
  selectedId: string | null; onSelect: (id: string | null) => void
}) {
  const [filter, setFilter] = useState<"ALL" | TicketStatus>("ALL")
  const [rows, setRows] = useState<TicketRow[] | null>(null)
  const [listLoading, setListLoading] = useState(true); const [listError, setListError] = useState<string | null>(null)
  const [newOpen, setNewOpen] = useState(false)

  const loadList = useCallback(async (silent = false) => {
    if (!silent) setListLoading(true)
    try {
      const res = await rpc<{ rows: TicketRow[] }>("support.tickets", { status: filter, take: 50 })
      setRows(res.rows)
      setListError(null)
    } catch (e: any) {
      if (!silent) setListError(e?.message || String(e))
    } finally {
      if (!silent) setListLoading(false)
    }
  }, [filter])

  useEffect(() => { loadList() }, [loadList])
  /** Poll-driven list refresh — silent, so the skeletons never flash. */
  const handlePoll = useCallback(() => { void loadList(true) }, [loadList])
  /** Mutation-driven refresh — list + overview stats. */
  const handleMutated = useCallback(() => { void loadList(true); reloadOverview() }, [loadList, reloadOverview])

  return (
    <div className="space-y-4">
      {/* header strip — stats chips + New Ticket */}
      <div className="flex flex-wrap items-center gap-2">
        <StatPill icon={Inbox} label="Open" value={overview.stats.open} tone="border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-900 dark:bg-blue-950/40 dark:text-blue-300" />
        <StatPill icon={Clock} label="Awaiting your reply" value={overview.stats.awaitingTenant} tone="border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300" />
        <StatPill icon={ShieldAlert} label="Active live requests" value={overview.stats.activeLiveRequests} tone="border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300" />
        <Button size="sm" className="ml-auto h-8 gap-1.5" onClick={() => setNewOpen(true)}>
          <Plus className="h-3.5 w-3.5" /> New Ticket
        </Button>
      </div>

      <div className="grid items-start gap-4 lg:grid-cols-[minmax(300px,360px)_1fr]">
        {/* left — filterable ticket list */}
        <div className="rounded-xl border bg-card">
          <div className="flex flex-wrap gap-1 border-b p-2.5" role="group" aria-label="Filter tickets by status">
            {TICKET_FILTERS.map((f) => (
              <button key={f.value} type="button" aria-pressed={filter === f.value} onClick={() => setFilter(f.value)}
                className={`h-6 rounded-full border px-2.5 text-[11px] font-medium transition-colors ${
                  filter === f.value
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-slate-200 bg-white text-slate-600 hover:border-slate-300 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300"
                }`}>
                {f.label}
              </button>
            ))}
          </div>
          {listLoading && !rows ? (
            <LoadingRows rows={6} />
          ) : listError ? (
            <div className="space-y-2 p-4">
              <ErrorBanner message={listError} />
              <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => loadList()}>Retry</Button>
            </div>
          ) : !rows?.length ? (
            <EmptyState icon={Inbox} title="No tickets here" hint="Create a ticket and the platform support team will reply in this thread." />
          ) : (
            <ul className="max-h-[560px] divide-y overflow-y-auto">
              {rows.map((t) => (
                <li key={t.id}>
                  <button type="button" onClick={() => onSelect(t.id)} aria-current={selectedId === t.id}
                    aria-label={`Ticket ${t.number}: ${t.subject} (${titleCase(t.status)})`}
                    className={`block w-full px-3.5 py-2.5 text-left transition-colors hover:bg-accent/50 ${selectedId === t.id ? "bg-accent" : ""}`}>
                    <span className="flex items-center justify-between gap-2">
                      <span className="font-mono text-[11px] font-semibold text-slate-400">{t.number}</span>
                      <StatusChip status={t.status} tone={TICKET_STATUS_TONE} />
                    </span>
                    <span className="mt-1 block truncate text-sm font-medium">{t.subject}</span>
                    <span className="mt-0.5 block text-[11px] text-slate-500 dark:text-slate-400">{titleCase(t.category)} · {titleCase(t.priority)} priority{t.assigneeName ? ` · ${t.assigneeName}` : ""}</span>
                    <span className="mt-0.5 block text-[10px] text-slate-400">{t.lastMessageAt ? `last message ${fmtDateTime(t.lastMessageAt)}` : `created ${fmtDateTime(t.createdAt)}`}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* right — conversation pane */}
        {selectedId ? (
          <TicketThread ticketId={selectedId} onMutated={handleMutated} onPoll={handlePoll} />
        ) : (
          <div className="flex min-h-[420px] items-center justify-center rounded-xl border border-dashed bg-card/50">
            <EmptyState icon={MessageSquare} title="Select a ticket" hint="Pick a ticket on the left to read the conversation, reply and attach diagnostics." />
          </div>
        )}
      </div>

      <NewTicketDialog open={newOpen} onOpenChange={setNewOpen} categories={overview.categories}
        onCreated={(id) => { onSelect(id); handleMutated() }} />
    </div>
  )
}

// ---------------- conversation pane ----------------

function TicketThread({ ticketId, onMutated, onPoll }: {
  ticketId: string; onMutated: () => void; onPoll: () => void
}) {
  const toast = useHrm((s) => s.toast)
  const [detail, setDetail] = useState<TicketDetail | null>(null); const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null); const [reply, setReply] = useState("")
  const [attachments, setAttachments] = useState<PendingAttachment[]>([])
  const [busy, setBusy] = useState(false)
  const [confirm, setConfirm] = useState<null | "close" | "reopen">(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  const load = useCallback(async (silent = false) => {
    if (!silent) { setLoading(true); setError(null) }
    try {
      const res = await rpc<TicketDetail>("support.ticket.get", { ticketId })
      setDetail(res)
    } catch (e: any) {
      if (!silent) setError(e?.message || String(e))
    } finally {
      if (!silent) setLoading(false)
    }
  }, [ticketId])

  useEffect(() => { setDetail(null); setReply(""); setAttachments([]); void load() }, [load])

  // 15s conversation poll (attendance.liveFeed pattern): runs only while this
  // tab is mounted (Radix unmounts inactive tab content) and the browser tab
  // is visible; the list is refreshed alongside, both silently.
  useEffect(() => {
    const poll = async () => {
      if (typeof document !== "undefined" && document.visibilityState !== "visible") return
      try { await load(true) } catch { /* best-effort — never disturb the pane */ }
      onPoll()
    }
    const timer = setInterval(poll, 15_000)
    return () => clearInterval(timer)
  }, [load, onPoll])

  // keep the thread pinned to the latest message (inner container only —
  // never scrolls the page)
  const msgCount = detail?.messages.length ?? 0
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [msgCount, ticketId, loading])

  const t = detail?.ticket
  const canClose = !!t && t.status !== "CLOSED"
  const canReopen = !!t && (t.status === "CLOSED" || t.status === "RESOLVED")
  const composerActive = canClose

  const sendReply = async () => {
    const m = reply.trim()
    if (!m) { toast("Write a message before sending", "err"); return }
    setBusy(true)
    try {
      await rpc("support.ticket.reply", {
        ticketId, message: m,
        attachments: attachments.map((a) => ({ fileName: a.fileName, dataUrl: a.dataUrl })),
      })
      setReply("")
      setAttachments([])
      toast("Reply sent — support has been notified", "ok")
      await load(true)
      onMutated()
    } catch (e: any) {
      toast(e?.message || String(e), "err")
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex max-h-[calc(100vh-230px)] min-h-[480px] flex-col rounded-xl border bg-card">
      {loading || !detail ? (
        <div className="space-y-3 p-4">
          {error ? (<>
            <ErrorBanner message={error} />
            <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => load()}>Retry</Button>
          </>) : (<>
            <Skeleton className="h-6 w-2/3" />
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-48 w-full" />
          </>)}
        </div>
      ) : (
        <>
          {/* thread header */}
          <div className="border-b p-3.5">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-xs font-semibold text-slate-400">{detail.ticket.number}</span>
              <StatusChip status={detail.ticket.status} tone={TICKET_STATUS_TONE} />
              <StatusChip status={detail.ticket.priority} tone={PRIORITY_TONE} />
              <Badge variant="outline" className="text-[10px]">{titleCase(detail.ticket.category)}</Badge>
              <span className="ml-auto flex gap-1.5">
                {canReopen && (
                  <Button size="sm" variant="outline" className="h-7 gap-1 text-xs" onClick={() => setConfirm("reopen")}>
                    <RotateCcw className="h-3.5 w-3.5" /> Request reopen
                  </Button>
                )}
                {canClose && (
                  <Button size="sm" variant="outline" className="h-7 gap-1 text-xs text-rose-700 hover:bg-rose-50 hover:text-rose-800 dark:text-rose-400 dark:hover:bg-rose-950" onClick={() => setConfirm("close")}>
                    <CheckCircle2 className="h-3.5 w-3.5" /> Close ticket
                  </Button>
                )}
              </span>
            </div>
            <p className="mt-2 text-sm font-semibold">{detail.ticket.subject}</p>
            <p className="mt-1 text-[11px] leading-relaxed text-slate-400">
              opened {fmtDateTime(detail.ticket.createdAt)} by {detail.ticket.requesterName}
              {detail.ticket.assigneeName ? ` · assigned to ${detail.ticket.assigneeName}` : ""}
              {detail.ticket.firstResponseAt ? ` · first response ${fmtDateTime(detail.ticket.firstResponseAt)}` : " · awaiting first response"}
              {detail.ticket.closedAt ? ` · closed ${fmtDateTime(detail.ticket.closedAt)}${detail.ticket.closedByName ? ` by ${detail.ticket.closedByName}` : ""}` : ""}
            </p>
          </div>

          {/* messages */}
          <div ref={scrollRef} role="log" aria-label={`Conversation on ticket ${detail.ticket.number}`} className="flex-1 space-y-3 overflow-y-auto p-4">
            {detail.messages.length === 0 ? <EmptyState icon={MessageSquare} title="No messages yet" />
              : detail.messages.map((m) => <MessageBubble key={m.id} m={m} />)}
          </div>

          {/* composer (per status: closed tickets get the reopen CTA instead) */}
          {composerActive ? (
            <div className="space-y-2 border-t p-3">
              <Textarea value={reply} rows={3} maxLength={5000} aria-label="Reply message"
                placeholder="Write your reply… (Ctrl/⌘+Enter to send)"
                onChange={(e) => setReply(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void sendReply() } }} />
              <AttachmentPicker id="reply-attachments" value={attachments} onChange={setAttachments} />
              <div className="flex items-center gap-2">
                <p className="flex-1 text-[11px] text-slate-400">{reply.trim().length}/5000 characters</p>
                <Button size="sm" className="gap-1.5" disabled={busy || !reply.trim()} onClick={() => void sendReply()}>
                  <Send className="h-3.5 w-3.5" aria-hidden /> Send
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-2 border-t bg-slate-50 p-3 dark:bg-slate-900/50">
              <p className="flex-1 text-xs text-slate-500 dark:text-slate-400">
                This ticket is closed — the conversation stays readable. Request a reopen if the issue returns.
              </p>
              <Button size="sm" variant="outline" className="h-7 gap-1 text-xs" onClick={() => setConfirm("reopen")}>
                <RotateCcw className="h-3.5 w-3.5" /> Request reopen
              </Button>
            </div>
          )}
        </>
      )}

      {/* close confirm (note is optional server-side — kept one-click here) */}
      <ConfirmDialog open={confirm === "close"} onOpenChange={(v) => { if (!v) setConfirm(null) }}
        title="Close ticket"
        message={t ? `Close ticket ${t.number} (“${t.subject}”)? The conversation stays readable, and a closed ticket can be reopened if the issue comes back.` : ""}
        confirmLabel="Close Ticket" danger
        onConfirm={async () => {
          await rpc("support.ticket.close", { ticketId })
          await load(true)
          onMutated()
        }} />
      {/* reopen confirm — reason is required by the contract (5–500 chars) */}
      <ConfirmDialog open={confirm === "reopen"} onOpenChange={(v) => { if (!v) setConfirm(null) }}
        title="Request reopen"
        message={t ? `Reopen ticket ${t.number}? Tell the support team what still needs attention — they will be notified.` : ""}
        confirmLabel="Request Reopen" requireReason
        onConfirm={async (reason) => {
          const r = (reason || "").trim()
          if (r.length < 5) throw new Error("Please describe what still needs attention (at least 5 characters)")
          await rpc("support.ticket.reopen", { ticketId, reason: r })
          await load(true)
          onMutated()
        }} />
    </div>
  )
}

function MessageBubble({ m }: { m: TicketMessage }) {
  const mine = m.authorRole === "TENANT"
  return (
    <div className={`flex ${mine ? "justify-end" : "justify-start"}`}>
      <div className={`max-w-[85%] rounded-2xl px-3.5 py-2.5 sm:max-w-[75%] ${
        mine ? "rounded-br-sm bg-primary text-primary-foreground" : "rounded-bl-sm border bg-muted"}`}>
        <p className={`mb-1 text-[10px] font-bold uppercase tracking-wide ${mine ? "text-primary-foreground/75" : "text-slate-500 dark:text-slate-400"}`}>
          {m.authorName} · {mine ? "you" : "support"}
        </p>
        <p className="whitespace-pre-wrap break-words text-sm">{m.body}</p>
        {m.attachments.length > 0 && (
          <div className="mt-2 space-y-1">
            {m.attachments.map((a, i) => a.url ? (
              <a key={`${a.objectKey}-${i}`} href={a.url} target="_blank" rel="noreferrer"
                className={`flex items-center gap-1.5 text-xs underline underline-offset-2 ${mine ? "text-primary-foreground" : "text-sky-700 dark:text-sky-400"}`}>
                <FileDown className="h-3.5 w-3.5 shrink-0" aria-hidden />
                {a.fileName} <span className="no-underline opacity-70">({fmtBytes(a.sizeBytes)})</span>
              </a>
            ) : (
              <span key={`${a.objectKey}-${i}`} className="flex items-center gap-1.5 text-xs opacity-70">
                <FileDown className="h-3.5 w-3.5 shrink-0" aria-hidden />
                {a.fileName} ({fmtBytes(a.sizeBytes)}) — link unavailable
              </span>
            ))}
          </div>
        )}
        <p className={`mt-1 text-[10px] tabular-nums ${mine ? "text-primary-foreground/70" : "text-slate-400"}`}>{fmtDateTime(m.createdAt)}</p>
      </div>
    </div>
  )
}

// ---------------- new ticket dialog ----------------

function NewTicketDialog({ open, onOpenChange, categories, onCreated }: {
  open: boolean; onOpenChange: (v: boolean) => void
  categories: string[]; onCreated: (ticketId: string) => void
}) {
  const toast = useHrm((s) => s.toast)
  const [subject, setSubject] = useState(""); const [category, setCategory] = useState("GENERAL")
  const [priority, setPriority] = useState<Priority>("NORMAL"); const [message, setMessage] = useState("")
  const [attachments, setAttachments] = useState<PendingAttachment[]>([])
  const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (open) {
      setSubject(""); setCategory(categories[0] || "GENERAL"); setPriority("NORMAL")
      setMessage(""); setAttachments([]); setError(null)
    }
  }, [open, categories])

  const submit = async () => {
    setError(null)
    const s = subject.trim()
    const m = message.trim()
    if (s.length < 4 || s.length > 160) { setError("Subject must be 4–160 characters."); return }
    if (!m || m.length < 10 || m.length > 5000) { setError("Describe the issue in 10–5000 characters."); return }
    setBusy(true)
    try {
      const res = await rpc<{ id: string; number: string }>("support.ticket.create", {
        subject: s, category, priority, message: m,
        attachments: attachments.map((a) => ({ fileName: a.fileName, dataUrl: a.dataUrl })),
      })
      toast(`Ticket ${res.number} created — the support team will reply here`, "ok")
      onCreated(res.id)
      onOpenChange(false)
    } catch (e: any) {
      setError(e?.message || String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!busy) onOpenChange(v) }}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <Headset className="h-4 w-4 text-emerald-600" aria-hidden /> New Support Ticket
          </DialogTitle>
          <p className="text-xs text-slate-500">
            Ordinary chat support — a threaded conversation with the Finix HR support team. For the team to enter your
            workspace, use the Live Support Access tab instead.
          </p>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="nt-subject" className="text-xs font-medium">Subject <span className="text-rose-500">*</span></Label>
            <Input id="nt-subject" value={subject} maxLength={160} placeholder="Short summary, e.g. “Payroll batch stuck at HR review”"
              onChange={(e) => setSubject(e.target.value)} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs font-medium">Category</Label>
              <CategorySelect value={category} onChange={setCategory} categories={categories} />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs font-medium">Priority</Label>
              <PrioritySelect value={priority} onChange={(v) => setPriority(v as Priority)} />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="nt-message" className="text-xs font-medium">Message <span className="text-rose-500">*</span></Label>
            <Textarea id="nt-message" value={message} rows={5} maxLength={5000}
              placeholder="What happened, what you expected, and anything you already tried…"
              onChange={(e) => setMessage(e.target.value)} />
            <p className="text-[11px] text-slate-400">{message.trim().length}/5000 characters (minimum 10)</p>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs font-medium">Attachments</Label>
            <AttachmentPicker id="nt-attachments" value={attachments} onChange={setAttachments} />
          </div>
        </div>
        <FieldError message={error} />
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
          <Button onClick={() => void submit()} disabled={busy}>{busy ? "Submitting…" : "Create Ticket"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// =====================================================================
// TAB 2 — Live Support Access (privileged, visually distinct)
// =====================================================================

function LiveAccessTab({ overview, reloadOverview }: { overview: Overview; reloadOverview: () => void }) {
  const { data: reqData, loading: reqLoading, error: reqError, reload: reloadReqs } =
    useApi<{ rows: LiveRequestRow[] }>("support.liveRequests", { take: 20 })
  const [cancelTarget, setCancelTarget] = useState<LiveRequestRow | null>(null)

  const rows = reqData?.rows ?? []
  const openRequest = rows.find((r) => OPEN_LIVE_STATUSES.includes(r.status)) ?? null
  // the overview payload is authoritative; a request-row session covers races
  const rowSession = rows.find((r) => r.session?.status === "ACTIVE")?.session ?? null
  const activeSession: SessionInfo | null = overview.activeSupportSession || (rowSession ? { ...rowSession } : null)

  const moduleLabel = useCallback(
    (key: string) => overview.moduleOptions.find((m) => m.key === key)?.label || titleCase(key),
    [overview.moduleOptions],
  )
  const refreshAll = useCallback(() => { reloadReqs(); reloadOverview() }, [reloadReqs, reloadOverview])

  return (
    <div className="space-y-4">
      {activeSession && <ActiveSessionCard session={activeSession} onEnded={refreshAll} labelFor={moduleLabel} />}

      <SectionCard
        title={<span className="flex items-center gap-1.5"><ShieldCheck className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400" aria-hidden /> Request Live Support Access</span>}
        description="One open request per workspace — the platform owner reviews every request before any session starts.">
        {reqLoading && !reqData ? (
          <LoadingRows rows={4} />
        ) : reqError ? (
          <div className="space-y-2">
            <ErrorBanner message={reqError} />
            <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => reloadReqs()}>Retry</Button>
          </div>
        ) : openRequest ? (
          <OpenRequestCard request={openRequest} onCancel={() => setCancelTarget(openRequest)} />
        ) : (
          <LiveRequestForm moduleOptions={overview.moduleOptions} categories={overview.categories} onSubmitted={refreshAll} />
        )}
      </SectionCard>

      <SectionCard title="Request History" description="Every live support request on this workspace — approvals, sessions and outcomes are audited.">
        {rows.length === 0 ? (
          <EmptyState icon={History} title="No live support requests yet" hint="When ordinary chat is not enough, request a time-limited, module-scoped support session above." />
        ) : (
          <div className="space-y-2.5">
            {rows.map((r) => (
              <div key={r.id} className="rounded-lg border p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <StatusChip status={r.status} tone={LIVE_STATUS_TONE} />
                  <p className="min-w-0 flex-1 truncate text-sm font-semibold">{r.title}</p>
                  <span className="shrink-0 text-[11px] text-slate-400">{fmtDateTime(r.requestedAt)} · {r.requestedByName}</span>
                </div>
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {r.modules.map((k) => <Badge key={k} variant="outline" className="text-[10px]">{moduleLabel(k)}</Badge>)}
                </div>
                <p className="mt-1.5 text-xs text-slate-500 dark:text-slate-400">
                  {titleCase(r.category)} · {titleCase(r.priority)} priority
                  {r.approvedAgentName ? ` · agent: ${r.approvedAgentName}` : ""}
                  {r.approvedMinutes ? ` · approved for ${r.approvedMinutes} min` : ""}
                </p>
                {r.reviewNote && (
                  <p className="mt-1.5 rounded-md bg-slate-50 p-2 text-xs text-slate-600 dark:bg-slate-900 dark:text-slate-300">
                    <span className="font-semibold">Review note:</span> {r.reviewNote}
                  </p>
                )}
                {r.reviewedByName && r.reviewedAt && (
                  <p className="mt-1 text-[11px] text-slate-400">reviewed by {r.reviewedByName} · {fmtDateTime(r.reviewedAt)}</p>
                )}
                {r.session && r.status !== "ACTIVE" && (
                  <p className="mt-1 text-[11px] text-slate-400">
                    session {titleCase(r.session.status)}{r.session.operatorName ? ` — ${r.session.operatorName}` : ""}{r.session.endedReason ? ` · ${r.session.endedReason}` : ""}
                  </p>
                )}
                {(r.status === "PENDING_REVIEW" || r.status === "APPROVED") && (
                  <Button size="sm" variant="outline" className="mt-2 h-7 text-xs" onClick={() => setCancelTarget(r)}>Cancel request</Button>
                )}
              </div>
            ))}
          </div>
        )}
      </SectionCard>

      {/* cancel request confirm (PENDING_REVIEW / APPROVED only) */}
      <ConfirmDialog open={!!cancelTarget} onOpenChange={(v) => { if (!v) setCancelTarget(null) }}
        title="Cancel live support request"
        message={cancelTarget ? `Cancel “${cancelTarget.title}”? The platform team will not review it, and you can submit a new request afterwards.` : ""}
        confirmLabel="Cancel Request" danger
        onConfirm={async () => {
          if (!cancelTarget) return
          await rpc("support.liveRequest.cancel", { requestId: cancelTarget.id })
          setCancelTarget(null)
          refreshAll()
        }} />
    </div>
  )
}

// ---------------- active session card ----------------

function ActiveSessionCard({ session, onEnded, labelFor }: {
  session: SessionInfo; onEnded: () => void; labelFor?: (key: string) => string
}) {
  const write = session.accessMode === "CONTROLLED_WRITE"
  const [confirmEnd, setConfirmEnd] = useState(false)
  const handleExpire = useCallback(() => onEnded(), [onEnded])
  return (
    <div role="alert" aria-label="Active live support session" className="rounded-xl border border-amber-300 bg-amber-50/70 p-4 dark:border-amber-800 dark:bg-amber-950/40">
      <div className="flex flex-wrap items-center gap-2">
        <ShieldAlert className="h-4 w-4 text-amber-600 dark:text-amber-400" aria-hidden />
        <p className="text-sm font-bold text-amber-900 dark:text-amber-200">Live support session in progress</p>
        <Badge variant="secondary" className="gap-1 bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300">
          <span aria-hidden className="h-1.5 w-1.5 animate-pulse rounded-full bg-current" /> Active
        </Badge>
        {/* §4.5 — the tenant's inalienable right: end the session at any time */}
        <Button size="sm" variant="destructive" className="ml-auto h-7 gap-1 text-xs" onClick={() => setConfirmEnd(true)}>
          <X className="h-3.5 w-3.5" aria-hidden /> End Session
        </Button>
      </div>
      <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">Operator</p>
          <p className="mt-0.5 text-sm font-semibold">{session.operatorName || "Finix HR support"}</p>
        </div>
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">Access mode</p>
          <p className="mt-0.5 flex items-center gap-1.5 text-sm font-semibold">
            {write ? <PenLine className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400" aria-hidden /> : <Eye className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400" aria-hidden />}
            {write ? "Controlled write (scoped)" : "Read-only"}
          </p>
        </div>
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">Started</p>
          <p className="mt-0.5 text-sm tabular-nums">{fmtDateTime(session.startedAt)}</p>
        </div>
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">Expires in</p>
          <p className="mt-0.5 text-sm"><Countdown expiresAt={session.expiresAt} onExpire={handleExpire} /></p>
        </div>
      </div>
      <div className="mt-3">
        <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">Approved modules</p>
        <div className="mt-1 flex flex-wrap gap-1">
          {session.modules.length ? session.modules.map((k) => (
            <Badge key={k} variant="outline" className="border-amber-300 text-[10px] text-amber-800 dark:border-amber-800 dark:text-amber-300">{labelFor ? labelFor(k) : k}</Badge>
          )) : <span className="text-xs text-slate-400">—</span>}
        </div>
      </div>
      <p className="mt-2 flex items-start gap-1.5 text-[11px] text-amber-700/90 dark:text-amber-300/80">
        <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
        Every action the operator takes is audited, and the session hard-expires server-side regardless of the clock above.
      </p>

      {/* end-session confirm (audited — support.session.end) */}
      <ConfirmDialog open={confirmEnd} onOpenChange={setConfirmEnd} title="End support session"
        message="Immediately revoke the support operator's access to your workspace? The session is marked ended (audited) and cannot be resumed — submit a new request if more help is needed."
        confirmLabel="End Session" danger
        onConfirm={async () => {
          await rpc("support.session.end", { sessionId: session.id })
          onEnded()
        }} />
    </div>
  )
}

// ---------------- open request card (one-open-request rule) ----------------

function OpenRequestCard({ request, onCancel }: { request: LiveRequestRow; onCancel: () => void }) {
  return (
    <div className="rounded-xl border border-blue-200 bg-blue-50/50 p-4 dark:border-blue-900 dark:bg-blue-950/20">
      <div className="flex flex-wrap items-center gap-2">
        <StatusChip status={request.status} tone={LIVE_STATUS_TONE} />
        <p className="min-w-0 flex-1 text-sm font-semibold">{request.title}</p>
        {request.status !== "ACTIVE" && (
          <Button size="sm" variant="outline" className="h-7 text-xs" onClick={onCancel}>Cancel request</Button>
        )}
      </div>
      <p className="mt-2 text-xs text-slate-600 dark:text-slate-300">
        {request.status === "PENDING_REVIEW" && <>Submitted — a platform owner is reviewing your request. The outcome appears here (and in the history below).</>}
        {request.status === "APPROVED" && <>Approved{request.reviewedByName ? ` by ${request.reviewedByName}` : ""}
          {request.approvedMinutes ? ` for up to ${request.approvedMinutes} minutes` : ""}
          {request.approvedAgentName ? ` — agent ${request.approvedAgentName}` : " — the authorized agent"} will start the audited session shortly.</>}
        {request.status === "ACTIVE" && <>A session is active on your workspace right now — see the session card above. You can end it at any time.</>}
      </p>
      <p className="mt-1.5 text-[11px] text-slate-400">requested {fmtDateTime(request.requestedAt)} by {request.requestedByName} · {titleCase(request.category)} · {titleCase(request.priority)} priority</p>
      {request.reviewNote && (
        <p className="mt-1.5 rounded-md bg-white/70 p-2 text-xs text-slate-600 dark:bg-slate-900/60 dark:text-slate-300">
          <span className="font-semibold">Review note:</span> {request.reviewNote}
        </p>
      )}
      <p className="mt-2 text-[11px] text-slate-400">
        Only one open request is allowed at a time — this one must complete, expire or be cancelled before a new request can be submitted.
      </p>
    </div>
  )
}

// ---------------- live request form ----------------

function LiveRequestForm({ moduleOptions, categories, onSubmitted }: {
  moduleOptions: { key: string; label: string; available: boolean }[]
  categories: string[]
  onSubmitted: () => void
}) {
  const toast = useHrm((s) => s.toast)
  const [title, setTitle] = useState(""); const [category, setCategory] = useState("GENERAL")
  const [priority, setPriority] = useState<Priority>("NORMAL"); const [description, setDescription] = useState("")
  const [modules, setModules] = useState<string[]>([]); const [contextNote, setContextNote] = useState("")
  const [attachments, setAttachments] = useState<PendingAttachment[]>([])
  const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null)

  // available modules first; unavailable ones stay selectable (greyed, hinted)
  const sortedModules = useMemo(
    () => [...moduleOptions.filter((m) => m.available), ...moduleOptions.filter((m) => !m.available)],
    [moduleOptions],
  )
  const toggleModule = (key: string) =>
    setModules((cur) => (cur.includes(key) ? cur.filter((k) => k !== key) : [...cur, key]))

  const submit = async () => {
    setError(null)
    const t = title.trim()
    const d = description.trim()
    if (t.length < 6 || t.length > 160) { setError("Title must be 6–160 characters."); return }
    if (d.length < 20 || d.length > 5000) { setError("Describe the issue in 20–5000 characters."); return }
    if (!modules.length) { setError("Select at least one affected module."); return }
    setBusy(true)
    try {
      await rpc("support.liveRequest.create", {
        title: t, description: d, category, modules, priority,
        contextNote: contextNote.trim() || undefined,
        attachments: attachments.map((a) => ({ fileName: a.fileName, dataUrl: a.dataUrl })),
      })
      toast("Live Support Access request submitted for review", "ok")
      onSubmitted()
    } catch (e: any) {
      const msg = e?.message || String(e)
      setError(msg)
      // one-open-request rule — the server 409s; reload so the open request
      // card replaces this form
      if (e?.code === 409) { toast(msg, "err"); onSubmitted() }
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor="lr-title" className="text-xs font-medium">Title <span className="text-rose-500">*</span></Label>
          <Input id="lr-title" value={title} maxLength={160} placeholder="e.g. “Payroll approval buttons unresponsive since morning”"
            onChange={(e) => setTitle(e.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs font-medium">Category</Label>
          <CategorySelect value={category} onChange={setCategory} categories={categories} />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs font-medium">Priority</Label>
          <PrioritySelect value={priority} onChange={(v) => setPriority(v as Priority)} />
        </div>
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor="lr-desc" className="text-xs font-medium">What is going wrong? <span className="text-rose-500">*</span></Label>
          <Textarea id="lr-desc" value={description} rows={4} maxLength={5000}
            placeholder="Describe the issue in detail — what you did, what happened, who is affected…"
            onChange={(e) => setDescription(e.target.value)} />
          <p className="text-[11px] text-slate-400">{description.trim().length}/5000 characters (minimum 20)</p>
        </div>
        <div className="space-y-1.5 sm:col-span-2">
          <Label className="text-xs font-medium">Affected modules <span className="text-rose-500">*</span></Label>
          <div role="group" aria-label="Affected modules" className="grid gap-1.5 sm:grid-cols-2 lg:grid-cols-3">
            {sortedModules.map((m) => {
              const checked = modules.includes(m.key)
              return (
                <label key={m.key}
                  className={`flex cursor-pointer items-center gap-2 rounded-lg border px-2.5 py-2 transition-colors ${
                    checked
                      ? "border-amber-300 bg-amber-50/60 dark:border-amber-800 dark:bg-amber-950/30"
                      : "border-slate-200 hover:border-slate-300 dark:border-slate-800 dark:hover:border-slate-700"
                  } ${m.available ? "" : "opacity-60"}`}>
                  <Checkbox checked={checked} onCheckedChange={() => toggleModule(m.key)} aria-label={m.label} />
                  <span className="min-w-0">
                    <span className="block truncate text-[13px] font-medium">{m.label}</span>
                    {!m.available && <span className="block text-[10px] text-slate-400">not in your plan — still selectable for troubleshooting</span>}
                  </span>
                </label>
              )
            })}
          </div>
          <p className="text-[11px] text-slate-400">{modules.length} selected (1–20). Locked modules may be requested for read-only troubleshooting — the owner decides at approval.</p>
        </div>
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor="lr-context" className="text-xs font-medium">Context note (optional)</Label>
          <Textarea id="lr-context" value={contextNote} rows={2} maxLength={3000}
            placeholder="Anything the reviewing owner should know — deadlines, affected payroll cycle, best contact window…"
            onChange={(e) => setContextNote(e.target.value)} />
        </div>
        <div className="space-y-1.5 sm:col-span-2">
          <Label className="text-xs font-medium">Diagnostic attachments</Label>
          <AttachmentPicker id="lr-attachments" value={attachments} onChange={setAttachments} />
          <p className="text-[11px] text-slate-400">Screenshots and PDFs help the reviewer. They are retained on the review record when the request is linked to a support ticket.</p>
        </div>
      </div>
      <FieldError message={error} />
      <div className="flex items-center justify-end gap-2">
        <Button disabled={busy} onClick={() => void submit()}>{busy ? "Submitting…" : "Submit for Review"}</Button>
      </div>
    </div>
  )
}

"use client"
// ============ /owner/communication — R11 SaaS Owner Communication console ============
// Marketing / promotional / newsletter EMAIL + SMS campaigns to tenant
// administrators, with reusable templates, audience targeting + live preview,
// send-now or scheduled delivery, per-recipient delivery logs and consent
// (marketingOptOut tenants are visible and always SKIPPED).
//
// Tabs: Campaigns (list + compose + delivery log) · Templates.
// Backend: owner.communication.* (communication-routes.ts) + jobs.ts
// dispatches SCHEDULED campaigns on every scheduler tick.
import { useCallback, useEffect, useState } from "react"
import {
  BadgeCheck, CalendarClock, CheckCircle2, ChevronRight, Copy, Loader2, Mail,
  MessageSquare, Pencil, Plus, RefreshCw, Search, Send, Trash2, Users, XCircle,
} from "lucide-react"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Switch } from "@/components/ui/switch"
import { cn } from "@/lib/utils"
import { ownerRpc, useOwnerApi } from "@/saas/owner/client"
import { ErrorBanner, PageHeader, TableShell, Td, fmtDateTime, Loading } from "@/saas/owner/ui"

type Campaign = {
  id: string
  name: string
  kind: string
  channel: string
  subject: string | null
  body: string
  audienceType: string
  audienceIds: string
  status: string
  scheduledFor: string | null
  sentAt: string | null
  totalRecipients: number
  sentCount: number
  failedCount: number
  skippedCount: number
  templateId: string | null
  createdByName: string | null
  createdAt: string
  updatedAt: string
}

type Template = {
  id: string
  name: string
  kind: string
  channel: string
  subject: string | null
  body: string
  active: boolean
  createdAt: string
  updatedAt: string
}

type Recipient = {
  id: string
  vendorName: string | null
  contactEmail: string | null
  contactPhone: string | null
  status: string
  attempts: number
  lastError: string | null
  sentAt: string | null
}

type TenantOption = { id: string; name: string; code: string; planName: string | null; subscriptionStatus: string; marketingOptOut: boolean }

type Preview = {
  total: number
  reachable: number
  optedOut: number
  noContact: number
  sampleTenants: { name: string; email: string | null; planName: string | null; optOut: boolean }[]
  sample: { to: string; message: string } | null
}

const CAMPAIGN_KINDS = ["MARKETING", "PROMOTIONAL", "CAMPAIGN", "OFFER", "NEWSLETTER"] as const
const AUDIENCE_LABELS: Record<string, string> = {
  ALL: "All tenants",
  ACTIVE: "Active subscriptions",
  TRIAL: "Trial tenants",
  EXPIRED: "Expired subscriptions",
  PLAN: "Specific plans…",
  CUSTOM: "Hand-picked tenants…",
}
const statusTone: Record<string, string> = {
  DRAFT: "border-slate-400/30 bg-slate-500/10 text-slate-300",
  SCHEDULED: "border-amber-400/30 bg-amber-500/10 text-amber-300",
  SENDING: "border-blue-400/30 bg-blue-500/10 text-blue-300",
  SENT: "border-emerald-400/30 bg-emerald-500/10 text-emerald-300",
  PARTIAL: "border-orange-400/30 bg-orange-500/10 text-orange-300",
  FAILED: "border-red-400/30 bg-red-500/10 text-red-300",
}

const inputCls = "h-10 border-white/10 light:border-slate-300 bg-white/5 light:bg-white light:text-slate-900"

export default function CommunicationPage() {
  const [tab, setTab] = useState<"campaigns" | "templates">("campaigns")

  // ---- campaigns list state ----
  const [search, setSearch] = useState("")
  const [statusFilter, setStatusFilter] = useState("ALL")
  const [channelFilter, setChannelFilter] = useState("ALL")
  const [page, setPage] = useState(1)
  const { data, loading, error, reload } = useOwnerApi<{ campaigns: Campaign[]; total: number; pageSize: number }>(
    "owner.communication.campaigns.list",
    { search: search || undefined, status: statusFilter, channel: channelFilter, page, pageSize: 25 },
    [search, statusFilter, channelFilter, page]
  )
  const { data: plansData } = useOwnerApi<{ plans: { id: string; name: string }[] }>("owner.plans.forApproval", {})

  const [compose, setCompose] = useState<any | null>(null) // {} = new, row = edit
  const [logFor, setLogFor] = useState<Campaign | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const showToast = (t: string) => { setToast(t); setTimeout(() => setToast(null), 5000) }
  const run = async (label: string, fn: () => Promise<any>, after?: string) => {
    setBusy(label); setActionError(null)
    try {
      await fn()
      if (after) showToast(after)
      await reload()
      return true
    } catch (e: any) {
      setActionError(e?.message || "Action failed.")
      return false
    } finally { setBusy(null) }
  }

  // ---- templates state ----
  const { data: templatesData, loading: templatesLoading, error: templatesError, reload: reloadTemplates } =
    useOwnerApi<{ templates: Template[] }>("owner.communication.templates.list", {})
  const [tplEditing, setTplEditing] = useState<any | null>(null)
  const [tplDeleting, setTplDeleting] = useState<Template | null>(null)
  // U1-003/U1-004 — guard destructive one-click actions with confirmation state
  const [campDeleting, setCampDeleting] = useState<Campaign | null>(null)
  const [campSending, setCampSending] = useState<Campaign | null>(null)

  return (
    <div className="space-y-5">
      <PageHeader
        title="Communication"
        sub="Marketing emails & SMS to tenant administrators — campaigns, templates, delivery logs. Tenants that opted out are always skipped."
      />

      {toast && (
        <div className="flex items-center gap-2 rounded-xl border border-emerald-400/30 bg-emerald-500/10 p-3 text-sm text-emerald-300 light:text-emerald-700">
          <CheckCircle2 className="h-4 w-4" /> {toast}
        </div>
      )}
      {actionError && <ErrorBanner message={actionError} />}

      {/* tabs */}
      <div className="flex gap-1 rounded-lg border border-white/10 light:border-slate-200 p-1 w-fit">
        {(["campaigns", "templates"] as const).map((t) => (
          <button key={t} onClick={() => setTab(t)}
            className={cn("rounded-md px-4 py-1.5 text-xs font-semibold", tab === t ? "bg-white/10 light:bg-slate-200 text-white light:text-slate-900" : "text-slate-400 light:text-slate-600")}>
            {t === "campaigns" ? "Campaigns" : "Templates"}
          </button>
        ))}
      </div>

      {tab === "campaigns" ? (
        <>
          {/* filters + compose */}
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
              <Input value={search} onChange={(e) => { setSearch(e.target.value); setPage(1) }} placeholder="Search campaigns…"
                className={cn(inputCls, "w-64 pl-9")} />
            </div>
            <Select value={statusFilter} onValueChange={(v) => { setStatusFilter(v); setPage(1) }}>
              <SelectTrigger className={cn(inputCls, "w-40")}><SelectValue /></SelectTrigger>
              <SelectContent>
                {["ALL", "DRAFT", "SCHEDULED", "SENT", "PARTIAL", "FAILED"].map((s) => (
                  <SelectItem key={s} value={s}>{s === "ALL" ? "All statuses" : s}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={channelFilter} onValueChange={(v) => { setChannelFilter(v); setPage(1) }}>
              <SelectTrigger className={cn(inputCls, "w-32")}><SelectValue /></SelectTrigger>
              <SelectContent>
                {["ALL", "EMAIL", "SMS"].map((c) => <SelectItem key={c} value={c}>{c === "ALL" ? "Both" : c}</SelectItem>)}
              </SelectContent>
            </Select>
            <Button className="ml-auto bg-gradient-to-r from-indigo-600 to-blue-600 text-white hover:from-indigo-500 hover:to-blue-500"
              onClick={() => setCompose({})}>
              <Plus className="h-4 w-4" /> New campaign
            </Button>
          </div>

          {error ? <ErrorBanner message={error} /> : loading ? (
            <Loading label="Loading campaigns…" />
          ) : (
            <TableShell headers={["Campaign", "Channel", "Audience", "Delivery", "Status", "Created", ""]} empty={data?.campaigns.length === 0}>
              {data?.campaigns.map((c) => (
                <tr key={c.id}>
                  <Td>
                    <span className="font-medium text-white light:text-slate-900">{c.name}</span>
                    <span className="block text-xs text-slate-500">{c.kind.toLowerCase()}{c.subject ? ` · ${c.subject.slice(0, 48)}${c.subject.length > 48 ? "…" : ""}` : ""}</span>
                  </Td>
                  <Td className="text-xs">
                    {c.channel === "EMAIL" ? <span className="inline-flex items-center gap-1 text-blue-300"><Mail className="h-3 w-3" /> Email</span> : <span className="inline-flex items-center gap-1 text-teal-300"><MessageSquare className="h-3 w-3" /> SMS</span>}
                  </Td>
                  <Td className="text-xs">{AUDIENCE_LABELS[c.audienceType] || c.audienceType}</Td>
                  <Td className="text-xs tabular-nums">
                    {["SENT", "PARTIAL", "FAILED"].includes(c.status) ? (
                      <span>
                        <span className="text-emerald-300">{c.sentCount}</span> sent
                        {c.failedCount > 0 && <span className="text-red-300"> · {c.failedCount} failed</span>}
                        {c.skippedCount > 0 && <span className="text-slate-500"> · {c.skippedCount} skipped</span>}
                      </span>
                    ) : "—"}
                  </Td>
                  <Td>
                    <span className={cn("inline-flex rounded-full border px-2 py-0.5 text-[10px] font-bold tracking-wide", statusTone[c.status] || "")}>{c.status}</span>
                    {c.status === "SCHEDULED" && c.scheduledFor && (
                      <span className="block text-[10px] text-amber-300/80 mt-0.5">{fmtDateTime(c.scheduledFor)}</span>
                    )}
                  </Td>
                  <Td className="text-xs text-slate-500">{fmtDateTime(c.createdAt)}</Td>
                  <Td>
                    <div className="flex justify-end gap-1">
                      {["SENT", "PARTIAL", "FAILED"].includes(c.status) && (
                        <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" title="Delivery log" onClick={() => setLogFor(c)}>
                          <ChevronRight className="h-3.5 w-3.5" />
                        </Button>
                      )}
                      {c.status === "DRAFT" && (
                        <>
                          <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" title="Edit draft" onClick={() => setCompose(c)}><Pencil className="h-3.5 w-3.5" /></Button>
                          {/* U1-004 — Send now opens a confirmation dialog instead of firing on one click */}
                          <Button variant="ghost" size="sm" className="h-7 px-2 text-xs text-emerald-400" title="Send now" disabled={!!busy}
                            onClick={() => setCampSending(c)}>
                            {busy === `send:${c.id}` ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
                          </Button>
                        </>
                      )}
                      {c.status === "SCHEDULED" && (
                        <Button variant="ghost" size="sm" className="h-7 px-2 text-xs text-amber-400" title="Cancel schedule" disabled={!!busy}
                          onClick={() => run(`cancel:${c.id}`, () => ownerRpc("owner.communication.campaigns.cancel", { id: c.id }), `Schedule cancelled — "${c.name}" is back to draft.`)}>
                          <XCircle className="h-3.5 w-3.5" />
                        </Button>
                      )}
                      <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" title="Duplicate as new draft" disabled={!!busy}
                        onClick={() => run(`dup:${c.id}`, () => ownerRpc("owner.communication.campaigns.duplicate", { id: c.id }), `Duplicated "${c.name}" as a new draft.`)}>
                        <Copy className="h-3.5 w-3.5" />
                      </Button>
                      {c.status !== "SENDING" && (
                        // U1-003 — Delete opens a confirmation dialog instead of firing immediately
                        <Button variant="ghost" size="sm" className="h-7 px-2 text-xs text-red-400" title="Delete campaign" disabled={!!busy}
                          onClick={() => setCampDeleting(c)}>
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      )}
                    </div>
                  </Td>
                </tr>
              ))}
            </TableShell>
          )}

          {/* pagination */}
          {data && data.total > data.pageSize && (
            <div className="flex items-center justify-center gap-3">
              <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)} className="border-white/10 light:border-slate-200 bg-white/5 light:bg-slate-100">Previous</Button>
              <span className="text-xs text-slate-500">page {page} / {Math.ceil(data.total / data.pageSize)}</span>
              <Button variant="outline" size="sm" disabled={page >= Math.ceil(data.total / data.pageSize)} onClick={() => setPage((p) => p + 1)} className="border-white/10 light:border-slate-200 bg-white/5 light:bg-slate-100">Next</Button>
            </div>
          )}

          <ComposeDialog
            open={!!compose}
            initial={compose}
            plans={plansData?.plans || []}
            onClose={() => setCompose(null)}
            onSaved={reload}
            onToast={showToast}
          />
          <DeliveryLogDialog campaign={logFor} onClose={() => setLogFor(null)} />
        </>
      ) : (
        <>
          <div className="flex items-center gap-2">
            <Button size="sm" className="bg-gradient-to-r from-indigo-600 to-blue-600 text-white hover:from-indigo-500 hover:to-blue-500"
              onClick={() => setTplEditing({})}>
              <Plus className="h-4 w-4" /> New template
            </Button>
            <Button size="sm" variant="outline" className="border-white/10 light:border-slate-200 bg-white/5 light:bg-slate-100" onClick={() => reloadTemplates()}>
              <RefreshCw className="h-3.5 w-3.5" />
            </Button>
          </div>
          {templatesError ? <ErrorBanner message={templatesError} /> : templatesLoading ? (
            <Loading label="Loading templates…" />
          ) : (
            <TableShell headers={["Template", "Channel", "Kind", "Subject", "Used", "Status", ""]} empty={templatesData?.templates.length === 0}>
              {templatesData?.templates.map((t) => (
                <tr key={t.id}>
                  <Td><span className="font-medium text-white light:text-slate-900">{t.name}</span></Td>
                  <Td className="text-xs">
                    {t.channel === "EMAIL" ? <span className="inline-flex items-center gap-1 text-blue-300"><Mail className="h-3 w-3" /> Email</span> : <span className="inline-flex items-center gap-1 text-teal-300"><MessageSquare className="h-3 w-3" /> SMS</span>}
                  </Td>
                  <Td className="text-xs">{t.kind.toLowerCase()}</Td>
                  <Td className="text-xs text-slate-500 max-w-[220px] truncate">{t.subject || "—"}</Td>
                  <Td className="text-xs text-slate-500">{fmtDateTime(t.updatedAt)}</Td>
                  <Td><span className={cn("inline-flex rounded-full border px-2 py-0.5 text-[10px] font-bold tracking-wide", t.active ? "border-emerald-400/30 bg-emerald-500/10 text-emerald-300" : "border-slate-400/30 bg-slate-500/10 text-slate-400")}>{t.active ? "active" : "archived"}</span></Td>
                  <Td>
                    <div className="flex justify-end gap-1">
                      <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" title="Edit template" onClick={() => setTplEditing(t)}><Pencil className="h-3.5 w-3.5" /></Button>
                      <Button variant="ghost" size="sm" className="h-7 px-2 text-xs text-red-400" title="Delete template" onClick={() => setTplDeleting(t)}><Trash2 className="h-3.5 w-3.5" /></Button>
                    </div>
                  </Td>
                </tr>
              ))}
            </TableShell>
          )}

          <TemplateDialog
            open={!!tplEditing}
            initial={tplEditing}
            onClose={() => setTplEditing(null)}
            onSaved={reloadTemplates}
            onToast={showToast}
          />

          <Dialog open={!!tplDeleting} onOpenChange={(v) => { if (!v) setTplDeleting(null) }}>
            <DialogContent className="max-w-md border-white/10 light:border-slate-200 bg-slate-950 light:bg-slate-50">
              <DialogHeader><DialogTitle className="text-white light:text-slate-900">Delete template “{tplDeleting?.name}”?</DialogTitle></DialogHeader>
              <p className="text-sm text-slate-400 light:text-slate-600">
                Campaigns already cloned from it keep working (provenance is stored). Only future cloning stops.
              </p>
              <div className="mt-4 flex justify-end gap-2">
                <Button variant="outline" onClick={() => setTplDeleting(null)} className="border-white/10 light:border-slate-200 bg-white/5 light:bg-slate-100 text-white light:text-slate-900">Cancel</Button>
                <Button className="bg-red-600 text-white hover:bg-red-500"
                  onClick={async () => {
                    try {
                      await ownerRpc("owner.communication.templates.delete", { id: tplDeleting?.id || "" })
                      setTplDeleting(null); showToast("Template deleted."); await reloadTemplates()
                    } catch (e: any) { setActionError(e?.message || "Delete failed.") }
                  }}>
                  Delete template
                </Button>
              </div>
            </DialogContent>
          </Dialog>

          {/* U1-003 — Campaign delete confirmation dialog */}
          <Dialog open={!!campDeleting} onOpenChange={(v) => { if (!v) setCampDeleting(null) }}>
            <DialogContent className="max-w-md border-white/10 light:border-slate-200 bg-slate-950 light:bg-slate-50">
<<<<<<< HEAD
              <DialogHeader><DialogTitle className="text-white light:text-slate-900">Delete campaign &quot;{campDeleting?.name}&quot;?</DialogTitle></DialogHeader>
=======
              <DialogHeader><DialogTitle className="text-white light:text-slate-900">Delete campaign "{campDeleting?.name}"?</DialogTitle></DialogHeader>
>>>>>>> origin/main
              <p className="text-sm text-slate-400 light:text-slate-600">
                This permanently removes the campaign and its full delivery log. This action cannot be undone.
              </p>
              <div className="mt-4 flex justify-end gap-2">
                <Button variant="outline" onClick={() => setCampDeleting(null)} className="border-white/10 light:border-slate-200 bg-white/5 light:bg-slate-100 text-white light:text-slate-900">Cancel</Button>
                <Button className="bg-red-600 text-white hover:bg-red-500"
                  onClick={async () => {
                    const id = campDeleting?.id || ""
                    const name = campDeleting?.name || ""
                    setCampDeleting(null)
                    try {
                      await run(`del:${id}`, () => ownerRpc("owner.communication.campaigns.delete", { id }), `Deleted "${name}" and its delivery log.`)
                    } catch (e: any) { setActionError(e?.message || "Delete failed.") }
                  }}>
                  Delete campaign
                </Button>
              </div>
            </DialogContent>
          </Dialog>

          {/* U1-004 — Send now confirmation dialog */}
          <Dialog open={!!campSending} onOpenChange={(v) => { if (!v) setCampSending(null) }}>
            <DialogContent className="max-w-md border-white/10 light:border-slate-200 bg-slate-950 light:bg-slate-50">
<<<<<<< HEAD
              <DialogHeader><DialogTitle className="text-white light:text-slate-900">Send &quot;{campSending?.name}&quot; now?</DialogTitle></DialogHeader>
=======
              <DialogHeader><DialogTitle className="text-white light:text-slate-900">Send "{campSending?.name}" now?</DialogTitle></DialogHeader>
>>>>>>> origin/main
              <p className="text-sm text-slate-400 light:text-slate-600">
                This will immediately dispatch the campaign to all targeted tenants. This action cannot be undone.
              </p>
              <div className="mt-4 flex justify-end gap-2">
                <Button variant="outline" onClick={() => setCampSending(null)} className="border-white/10 light:border-slate-200 bg-white/5 light:bg-slate-100 text-white light:text-slate-900">Cancel</Button>
                <Button className="bg-emerald-600 text-white hover:bg-emerald-500"
                  onClick={async () => {
                    const id = campSending?.id || ""
                    const name = campSending?.name || ""
                    setCampSending(null)
                    try {
                      await run(`send:${id}`, () => ownerRpc("owner.communication.campaigns.send", { id, mode: "NOW" }), `Campaign "${name}" delivered.`)
                    } catch (e: any) { setActionError(e?.message || "Send failed.") }
                  }}>
                  <Send className="h-3.5 w-3.5 mr-1.5" /> Send now
                </Button>
              </div>
            </DialogContent>
          </Dialog>
        </>
      )}
    </div>
  )
}

// ================= compose / edit campaign =================
// (continued in the same file below — DeliveryLogDialog + TemplateDialog)

function ComposeDialog({
  open, initial, plans, onClose, onSaved, onToast,
}: {
  open: boolean
  initial: any | null
  plans: { id: string; name: string }[]
  onClose: () => void
  onSaved: () => void
  onToast: (t: string) => void
}) {
  const editing = !!initial?.id
  const c = (initial || {}) as Partial<Campaign>
  const [name, setName] = useState("")
  const [kind, setKind] = useState<string>("MARKETING")
  const [channel, setChannel] = useState<"EMAIL" | "SMS">("EMAIL")
  const [subject, setSubject] = useState("")
  const [body, setBody] = useState("")
  const [audienceType, setAudienceType] = useState<string>("ALL")
  const [selectedPlans, setSelectedPlans] = useState<string[]>([])
  const [tenantSearch, setTenantSearch] = useState("")
  const [tenantPicker, setTenantPicker] = useState(false)
  const [tenants, setTenants] = useState<TenantOption[]>([])
  const [selectedTenants, setSelectedTenants] = useState<string[]>([])
  const [preview, setPreview] = useState<Preview | null>(null)
  const [previewing, setPreviewing] = useState(false)
  const [scheduleMode, setScheduleMode] = useState<"NOW" | "SCHEDULE">("NOW")
  const [scheduledFor, setScheduledFor] = useState("")
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)

  const { data: templatesData } = useOwnerApi<{ templates: Template[] }>(open ? "owner.communication.templates.list" : null, {})

  useEffect(() => {
    if (open) {
      setName(initial?.name || "")
      setKind(initial?.kind || "MARKETING")
      setChannel((initial?.channel as "EMAIL" | "SMS") || "EMAIL")
      setSubject(initial?.subject || "")
      setBody(initial?.body || "")
      setAudienceType(initial?.audienceType || "ALL")
      setSelectedPlans(JSON.parse(initial?.audienceIds || "[]"))
      setSelectedTenants(JSON.parse(initial?.audienceIds || "[]"))
      setPreview(null); setErr(null); setScheduleMode("NOW"); setScheduledFor("")
    }
  }, [open, initial])

  const loadTenants = useCallback(async (q: string) => {
    try {
      const res = await ownerRpc<{ tenants: TenantOption[] }>("owner.communication.tenants", { search: q || undefined, limit: 100 })
      setTenants(res.tenants || [])
    } catch { /* picker is best-effort */ }
  }, [])

  useEffect(() => { if (tenantPicker) loadTenants(tenantSearch) }, [tenantPicker, tenantSearch, loadTenants])

  const audienceIds = audienceType === "PLAN" ? selectedPlans : audienceType === "CUSTOM" ? selectedTenants : []

  const runPreview = async () => {
    setPreviewing(true); setErr(null)
    try {
      const res = await ownerRpc<Preview>("owner.communication.campaigns.preview", {
        audienceType, audienceIds, templateBody: body || undefined, subject: subject || undefined,
      })
      setPreview(res)
    } catch (e: any) { setErr(e?.message || "Preview failed") } finally { setPreviewing(false) }
  }

  const save = async (mode: "DRAFT" | "SEND"): Promise<boolean> => {
    setErr(null)
    if (!name.trim()) { setErr("Campaign name is required"); return false }
    if (!body.trim()) { setErr("Message body is required"); return false }
    if (channel === "EMAIL" && !subject.trim()) { setErr("Email campaigns need a subject line"); return false }
    if (mode === "SEND" && scheduleMode === "SCHEDULE" && !scheduledFor) { setErr("Pick a schedule time"); return false }
    setBusy(mode)
    try {
      const saved = await ownerRpc<{ id: string }>("owner.communication.campaigns.save", {
        ...(editing ? { id: c.id } : {}),
        name: name.trim(), kind, channel, subject: subject.trim() || undefined, body: body.trim(),
        audienceType, audienceIds,
      })
      if (mode === "SEND") {
        await ownerRpc("owner.communication.campaigns.send", {
          id: saved.id,
          mode: scheduleMode,
          scheduledFor: scheduleMode === "SCHEDULE" ? new Date(scheduledFor).toISOString() : undefined,
        })
        onToast(scheduleMode === "SCHEDULE"
          ? `Campaign scheduled for ${new Date(scheduledFor).toLocaleString()} — the scheduler delivers it automatically.`
          : "Campaign delivered — see the delivery log for per-tenant results.")
      } else {
        onToast("Draft saved.")
      }
      onSaved()
      return true
    } catch (e: any) {
      setErr(e?.message || "Save failed")
      return false
    } finally { setBusy(null) }
  }

  const toggleIn = (list: string[], id: string) => list.includes(id) ? list.filter((x) => x !== id) : [...list, id]

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v && !busy) onClose() }}>
      <DialogContent className="max-w-3xl w-[95vw] max-h-[92vh] overflow-y-auto border-white/10 light:border-slate-200 bg-slate-950 light:bg-slate-50">
        <DialogHeader>
          <DialogTitle className="text-white light:text-slate-900">{editing ? `Edit campaign — ${c.name}` : "New campaign"}</DialogTitle>
          <DialogDescription>
            Marketing/promotional message to tenant administrators. Placeholders: {"{{tenantName}} {{planName}} {{endDate}} {{platformName}}"} — unknown tokens stay visible.
          </DialogDescription>
        </DialogHeader>

        {err && <ErrorBanner message={err} />}

        <div className="space-y-4">
          {/* templates quick-clone */}
          {templatesData?.templates && templatesData.templates.length > 0 && !editing && (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs text-slate-500">Start from a template:</span>
              {templatesData.templates.filter((t) => t.active).slice(0, 4).map((t) => (
                <button key={t.id} type="button"
                  onClick={() => { setName(t.name.replace(/ template/i, "")); setKind(t.kind); setChannel(t.channel as "EMAIL" | "SMS"); setSubject(t.subject || ""); setBody(t.body) }}
                  className="rounded-full border border-indigo-400/30 bg-indigo-500/10 px-2.5 py-0.5 text-[11px] font-medium text-indigo-200 light:text-indigo-700 hover:bg-indigo-500/20">
                  {t.name}
                </button>
              ))}
            </div>
          )}

          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <Label className="text-xs text-slate-400 light:text-slate-600">Campaign name *</Label>
              <Input value={name} onChange={(e) => setName(e.target.value)} className={cn(inputCls, "mt-1.5")} placeholder="e.g. Diwali promo — 20% off upgrades" />
            </div>
            <div>
              <Label className="text-xs text-slate-400 light:text-slate-600">Kind</Label>
              <Select value={kind} onValueChange={setKind}>
                <SelectTrigger className={cn(inputCls, "mt-1.5")}><SelectValue /></SelectTrigger>
                <SelectContent>
                  {CAMPAIGN_KINDS.map((k) => <SelectItem key={k} value={k}>{k.toLowerCase()}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <Label className="text-xs text-slate-400 light:text-slate-600">Channel</Label>
              <div className="mt-1.5 flex rounded-lg border border-white/10 light:border-slate-200 p-1">
                {(["EMAIL", "SMS"] as const).map((ch) => (
                  <button key={ch} type="button" onClick={() => setChannel(ch)}
                    className={cn("flex-1 rounded-md px-3 py-1.5 text-xs font-semibold", channel === ch ? "bg-white/10 light:bg-slate-200 text-white light:text-slate-900" : "text-slate-400 light:text-slate-600")}>
                    {ch === "EMAIL" ? "Email" : "SMS"}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <Label className="text-xs text-slate-400 light:text-slate-600">Audience</Label>
              <Select value={audienceType} onValueChange={(v) => { setAudienceType(v); setPreview(null) }}>
                <SelectTrigger className={cn(inputCls, "mt-1.5")}><SelectValue /></SelectTrigger>
                <SelectContent>
                  {Object.entries(AUDIENCE_LABELS).map(([k, v]) => <SelectItem key={k} value={k}>{v}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </div>

          {audienceType === "PLAN" && (
            <div>
              <Label className="text-xs text-slate-400 light:text-slate-600">Plans in scope ({selectedPlans.length} selected)</Label>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {plans.map((p) => (
                  <button key={p.id} type="button" onClick={() => { setSelectedPlans(toggleIn(selectedPlans, p.id)); setPreview(null) }}
                    className={cn("rounded-full border px-2.5 py-0.5 text-[11px] font-medium",
                      selectedPlans.includes(p.id) ? "border-indigo-400 bg-indigo-500/20 text-indigo-200 light:text-indigo-700" : "border-slate-500/30 text-slate-400")}>
                    {p.name}
                  </button>
                ))}
              </div>
            </div>
          )}

          {audienceType === "CUSTOM" && (
            <div className="rounded-xl border border-white/10 light:border-slate-200 p-3">
              <div className="flex items-center gap-2">
                <Input value={tenantSearch} onChange={(e) => setTenantSearch(e.target.value)} placeholder="Search tenants…"
                  className={cn(inputCls, "flex-1")} />
                <Button variant="outline" size="sm" className="border-white/10 light:border-slate-200 bg-white/5 light:bg-slate-100 text-white light:text-slate-900"
                  onClick={() => setTenantPicker(!tenantPicker)}>
                  <Users className="h-3.5 w-3.5" /> {tenantPicker ? "Hide list" : "Browse"}
                </Button>
              </div>
              {tenantPicker && (
                <div className="mt-2 max-h-44 overflow-y-auto rounded-lg border border-white/10 light:border-slate-200 divide-y divide-white/5 light:divide-slate-100">
                  {tenants.map((t) => (
                    <label key={t.id} className="flex items-center gap-2.5 px-2.5 py-2 text-xs cursor-pointer hover:bg-white/[0.03] light:hover:bg-slate-100/60">
                      <input type="checkbox" checked={selectedTenants.includes(t.id)}
                        onChange={() => { setSelectedTenants(toggleIn(selectedTenants, t.id)); setPreview(null) }}
                        className="accent-indigo-500" />
                      <span className="font-medium text-white light:text-slate-900">{t.name}</span>
                      <span className="text-slate-500">{t.planName || "legacy"}</span>
                      {t.marketingOptOut && <span className="ml-auto rounded-full border border-amber-400/30 bg-amber-500/10 px-2 py-0.5 text-[9px] font-bold text-amber-300">OPTED OUT</span>}
                    </label>
                  ))}
                  {tenants.length === 0 && <p className="px-2.5 py-3 text-xs text-slate-500">No tenants match.</p>}
                </div>
              )}
              <p className="mt-1.5 text-[11px] text-slate-500">{selectedTenants.length} tenant(s) selected</p>
            </div>
          )}

          {channel === "EMAIL" && (
            <div>
              <Label className="text-xs text-slate-400 light:text-slate-600">Subject line *</Label>
              <Input value={subject} onChange={(e) => setSubject(e.target.value)} className={cn(inputCls, "mt-1.5")}
                placeholder="e.g. {{tenantName}}, your Finix HR renewal offer" />
            </div>
          )}

          <div>
            <Label className="text-xs text-slate-400 light:text-slate-600">
              Message body * {channel === "SMS" && <span className="text-amber-400">· {body.length}/480 chars</span>}
            </Label>
            <Textarea value={body} onChange={(e) => setBody(e.target.value)} rows={channel === "SMS" ? 4 : 8}
              className="mt-1.5 bg-white/5 light:bg-slate-100 border-white/10 light:border-slate-200 text-slate-100 light:text-slate-900 font-mono text-xs"
              placeholder={"Dear {{tenantName}} team,\n\n…\n\n— {{platformName}}"} />
          </div>

          {/* audience preview */}
          <div className="rounded-xl border border-white/10 light:border-slate-200 bg-white/[0.03] light:bg-slate-100/60 p-3.5">
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" className="border-white/10 light:border-slate-200 bg-white/5 light:bg-slate-100 text-white light:text-slate-900"
                disabled={previewing || !body.trim()} onClick={runPreview}>
                {previewing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Users className="h-3.5 w-3.5" />} Preview audience
              </Button>
              {preview && (
                <span className="text-xs text-slate-400">
                  <span className="text-emerald-300 font-semibold">{preview.reachable}</span> reachable
                  · <span className="text-amber-300">{preview.optedOut}</span> opted out
                  {preview.noContact > 0 && <> · <span className="text-slate-500">{preview.noContact}</span> no contact</>}
                  {" "}of {preview.total}
                </span>
              )}
            </div>
            {preview?.sampleTenants && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {preview.sampleTenants.map((t, i) => (
                  <span key={i} className={cn("rounded-full border px-2 py-0.5 text-[10px]",
                    t.optOut ? "border-amber-400/30 bg-amber-500/10 text-amber-300" : "border-emerald-400/30 bg-emerald-500/10 text-emerald-300")}>
                    {t.name}{t.optOut ? " (opt-out)" : ""}
                  </span>
                ))}
              </div>
            )}
            {preview?.sample && (
              <div className="mt-2.5 rounded-lg border border-white/10 light:border-slate-200 bg-slate-900/60 light:bg-white p-3">
                <p className="text-[10px] font-bold uppercase tracking-widest text-slate-500">Rendered sample → {preview.sample.to || "(no email on record)"}</p>
                <pre className="mt-1.5 whitespace-pre-wrap break-words font-mono text-[11px] text-slate-300 light:text-slate-700">{preview.sample.message}</pre>
              </div>
            )}
          </div>

          {/* schedule controls */}
          <div className="rounded-xl border border-white/10 light:border-slate-200 p-3.5">
            <Label className="text-xs text-slate-400 light:text-slate-600">Delivery</Label>
            <div className="mt-1.5 flex flex-wrap items-center gap-3">
              <div className="flex rounded-lg border border-white/10 light:border-slate-200 p-1">
                {(["NOW", "SCHEDULE"] as const).map((m) => (
                  <button key={m} type="button" onClick={() => setScheduleMode(m)}
                    className={cn("rounded-md px-3 py-1.5 text-xs font-semibold", scheduleMode === m ? "bg-white/10 light:bg-slate-200 text-white light:text-slate-900" : "text-slate-400 light:text-slate-600")}>
                    {m === "NOW" ? "Send now" : "Schedule"}
                  </button>
                ))}
              </div>
              {scheduleMode === "SCHEDULE" && (
                <Input type="datetime-local" value={scheduledFor} onChange={(e) => setScheduledFor(e.target.value)}
                  className={cn(inputCls, "w-56")} />
              )}
            </div>
            <p className="mt-1.5 text-[11px] text-slate-500 flex items-start gap-1.5">
              <CalendarClock className="h-3.5 w-3.5 mt-0.5 shrink-0" />
              Scheduled campaigns are delivered automatically by the platform scheduler (every minute); cancelling before the time returns them to draft.
            </p>
          </div>
        </div>

        <DialogFooter className="mt-2 gap-2">
          <Button variant="outline" onClick={onClose} disabled={!!busy} className="border-white/10 light:border-slate-200 bg-white/5 light:bg-slate-100 text-white light:text-slate-900">Close</Button>
          <Button variant="outline" disabled={!!busy} onClick={() => save("DRAFT").then((ok) => ok && onClose())}
            className="border-white/10 light:border-slate-200 bg-white/5 light:bg-slate-100 text-white light:text-slate-900">
            {busy === "DRAFT" ? <Loader2 className="h-4 w-4 animate-spin" /> : <BadgeCheck className="h-4 w-4" />} Save draft
          </Button>
          <Button disabled={!!busy || !["DRAFT", "SCHEDULED"].includes(c.status || "DRAFT")}
            onClick={() => save("SEND").then((ok) => ok && onClose())}
            className="bg-gradient-to-r from-indigo-600 to-blue-600 text-white hover:from-indigo-500 hover:to-blue-500">
            {busy === "SEND" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            {scheduleMode === "SCHEDULE" ? "Schedule campaign" : "Send now"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ================= delivery log =================

function DeliveryLogDialog({ campaign, onClose }: { campaign: Campaign | null; onClose: () => void }) {
  const [page, setPage] = useState(1)
  const { data, loading, error } = useOwnerApi<{ campaign: Campaign; recipients: Recipient[]; recipientTotal: number }>(
    campaign ? "owner.communication.campaigns.get" : null,
    { id: campaign?.id, page, pageSize: 50 },
    [campaign?.id, page]
  )
  // page reset when switching campaigns — React's adjust-state-during-render
  // pattern (never an effect-body setState cascade)
  const [lastCampaignId, setLastCampaignId] = useState<string | undefined>(campaign?.id)
  if (campaign?.id !== lastCampaignId) {
    setLastCampaignId(campaign?.id)
    setPage(1)
  }

  const recTone: Record<string, string> = {
    SENT: "text-emerald-300",
    FAILED: "text-red-300",
    SKIPPED: "text-slate-400",
    PENDING: "text-blue-300",
  }

  return (
    <Dialog open={!!campaign} onOpenChange={(v) => { if (!v) onClose() }}>
      <DialogContent className="max-w-3xl w-[95vw] max-h-[90vh] overflow-y-auto border-white/10 light:border-slate-200 bg-slate-950 light:bg-slate-50">
        {campaign && (
          <>
            <DialogHeader>
              <DialogTitle className="text-white light:text-slate-900">Delivery log — {campaign.name}</DialogTitle>
              <DialogDescription>
                {campaign.channel} · {AUDIENCE_LABELS[campaign.audienceType] || campaign.audienceType} · sent {fmtDateTime(campaign.sentAt)}
              </DialogDescription>
            </DialogHeader>
            {campaign.subject && <p className="rounded-lg border border-white/10 light:border-slate-200 bg-white/[0.03] light:bg-slate-100/60 p-3 text-xs text-slate-300 light:text-slate-700"><b>Subject:</b> {campaign.subject}</p>}
            {error ? <ErrorBanner message={error} /> : loading ? (
              <Loading label="Loading recipients…" />
            ) : (
              <>
                <TableShell headers={["Tenant", "Contact", "Status", "Attempts", "Detail", "Sent"]} empty={data?.recipients.length === 0}>
                  {data?.recipients.map((r) => (
                    <tr key={r.id}>
                      <Td><span className="text-sm text-white light:text-slate-900">{r.vendorName || "—"}</span></Td>
                      <Td className="text-xs text-slate-500">{data?.campaign.channel === "SMS" ? (r.contactPhone || "—") : (r.contactEmail || "—")}</Td>
                      <Td><span className={cn("text-xs font-bold", recTone[r.status] || "")}>{r.status}</span></Td>
                      <Td className="text-xs tabular-nums">{r.attempts}</Td>
                      <Td className="text-xs text-slate-500 max-w-[260px] truncate"><span title={r.lastError || undefined}>{r.lastError || "—"}</span></Td>
                      <Td className="text-xs text-slate-500">{r.sentAt ? fmtDateTime(r.sentAt) : "—"}</Td>
                    </tr>
                  ))}
                </TableShell>
                {data && data.recipientTotal > 50 && (
                  <div className="mt-3 flex items-center justify-center gap-3">
                    <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)} className="border-white/10 light:border-slate-200 bg-white/5 light:bg-slate-100">Previous</Button>
                    <span className="text-xs text-slate-500">page {page} / {Math.ceil(data.recipientTotal / 50)}</span>
                    <Button variant="outline" size="sm" disabled={page >= Math.ceil(data.recipientTotal / 50)} onClick={() => setPage((p) => p + 1)} className="border-white/10 light:border-slate-200 bg-white/5 light:bg-slate-100">Next</Button>
                  </div>
                )}
              </>
            )}
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}

// ================= template editor =================

function TemplateDialog({
  open, initial, onClose, onSaved, onToast,
}: {
  open: boolean
  initial: any | null
  onClose: () => void
  onSaved: () => void
  onToast: (t: string) => void
}) {
  const editing = !!initial?.id
  const t0 = (initial || {}) as Partial<Template>
  const [name, setName] = useState("")
  const [kind, setKind] = useState<string>("MARKETING")
  const [channel, setChannel] = useState<"EMAIL" | "SMS">("EMAIL")
  const [subject, setSubject] = useState("")
  const [body, setBody] = useState("")
  const [active, setActive] = useState(true)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    if (open) {
      setName(initial?.name || "")
      setKind(initial?.kind || "MARKETING")
      setChannel((initial?.channel as "EMAIL" | "SMS") || "EMAIL")
      setSubject(initial?.subject || "")
      setBody(initial?.body || "")
      setActive(initial?.active !== false)
      setErr(null)
    }
  }, [open, initial])

  const save = async () => {
    setErr(null)
    if (!name.trim()) { setErr("Template name is required"); return }
    if (!body.trim()) { setErr("Template body is required"); return }
    if (channel === "EMAIL" && !subject.trim()) { setErr("Email templates need a subject line"); return }
    setBusy(true)
    try {
      await ownerRpc("owner.communication.templates.save", {
        ...(editing ? { id: t0.id } : {}),
        name: name.trim(), kind, channel, subject: subject.trim() || undefined, body: body.trim(), active,
      })
      onToast("Template saved."); onSaved(); onClose()
    } catch (e: any) {
      setErr(e?.message || "Save failed")
    } finally { setBusy(false) }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v && !busy) onClose() }}>
      <DialogContent className="max-w-xl w-[95vw] max-h-[90vh] overflow-y-auto border-white/10 light:border-slate-200 bg-slate-950 light:bg-slate-50">
        <DialogHeader>
          <DialogTitle className="text-white light:text-slate-900">{editing ? `Edit template — ${t0.name}` : "New template"}</DialogTitle>
          <DialogDescription>Reusable message skeleton for future campaigns. Placeholders render per tenant at send time.</DialogDescription>
        </DialogHeader>
        {err && <ErrorBanner message={err} />}
        <div className="space-y-4">
          <div>
            <Label className="text-xs text-slate-400 light:text-slate-600">Template name *</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} className={cn(inputCls, "mt-1.5")} placeholder="e.g. Renewal nudge (email)" />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <Label className="text-xs text-slate-400 light:text-slate-600">Kind</Label>
              <Select value={kind} onValueChange={setKind}>
                <SelectTrigger className={cn(inputCls, "mt-1.5")}><SelectValue /></SelectTrigger>
                <SelectContent>
                  {CAMPAIGN_KINDS.map((k) => <SelectItem key={k} value={k}>{k.toLowerCase()}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-xs text-slate-400 light:text-slate-600">Channel</Label>
              <div className="mt-1.5 flex rounded-lg border border-white/10 light:border-slate-200 p-1">
                {(["EMAIL", "SMS"] as const).map((ch) => (
                  <button key={ch} type="button" onClick={() => setChannel(ch)}
                    className={cn("flex-1 rounded-md px-3 py-1.5 text-xs font-semibold", channel === ch ? "bg-white/10 light:bg-slate-200 text-white light:text-slate-900" : "text-slate-400 light:text-slate-600")}>
                    {ch === "EMAIL" ? "Email" : "SMS"}
                  </button>
                ))}
              </div>
            </div>
          </div>
          {channel === "EMAIL" && (
            <div>
              <Label className="text-xs text-slate-400 light:text-slate-600">Subject *</Label>
              <Input value={subject} onChange={(e) => setSubject(e.target.value)} className={cn(inputCls, "mt-1.5")} placeholder="e.g. {{tenantName}}, a special offer from {{platformName}}" />
            </div>
          )}
          <div>
            <Label className="text-xs text-slate-400 light:text-slate-600">
              Body * {channel === "SMS" && <span className="text-amber-400">· {body.length}/480 chars</span>}
            </Label>
            <Textarea value={body} onChange={(e) => setBody(e.target.value)} rows={channel === "SMS" ? 4 : 8}
              className="mt-1.5 bg-white/5 light:bg-slate-100 border-white/10 light:border-slate-200 text-slate-100 light:text-slate-900 font-mono text-xs" />
          </div>
          <div className="flex items-center gap-2">
            <Switch checked={active} onCheckedChange={setActive} />
            <Label className="text-xs">{active ? "Active (clonable in the composer)" : "Archived"}</Label>
          </div>
        </div>
        <DialogFooter className="mt-2">
          <Button variant="outline" onClick={onClose} disabled={busy} className="border-white/10 light:border-slate-200 bg-white/5 light:bg-slate-100 text-white light:text-slate-900">Cancel</Button>
          <Button onClick={save} disabled={busy} className="bg-gradient-to-r from-indigo-600 to-blue-600 text-white hover:from-indigo-500 hover:to-blue-500">
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <BadgeCheck className="h-4 w-4" />} Save template
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

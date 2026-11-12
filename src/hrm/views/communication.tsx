"use client"
// ============ Communication Center — Email & SMS blasts (spec §12) ============
// Compose targeted or company-wide email/SMS messages. Delivery runs through the
// gateways configured in HR Settings (SMTP/Gmail for email, any HTTP SMS API);
// every send is logged per-recipient for auditing.
import { useEffect, useState } from "react"
import {
  MailPlus, Send, Search, Users, Building2, Network, IdCard, Globe, Mail, MessageSquare,
  MailCheck, MailWarning, RotateCw, Eye, CheckCircle2, XCircle, MinusCircle,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Checkbox } from "@/components/ui/checkbox"
import { Switch } from "@/components/ui/switch"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { useHrm } from "../store"
import { useApi, rpc, useLookup, runJob } from "../api"
import { PageHeader, SectionCard, StatusBadge, fmtDateTime } from "../shared/ui-kit"
import { DataTable, type Column } from "../shared/data-table"

const AUDIENCE_TYPES = [
  { value: "ALL", label: "All Employees", icon: Globe },
  { value: "BRANCH", label: "Specific Branches", icon: Building2 },
  { value: "DEPARTMENT", label: "Specific Departments", icon: Network },
  { value: "DESIGNATION", label: "Specific Designations", icon: IdCard },
  { value: "SPECIFIC", label: "Specific Employees", icon: Users },
]

const CHANNELS = [
  { value: "EMAIL", label: "Email only", icon: Mail },
  { value: "SMS", label: "SMS only", icon: MessageSquare },
  { value: "BOTH", label: "Email + SMS", icon: MailPlus },
]

export default function CommunicationView() {
  const { can } = useHrm()
  const canSend = can("communication", "create")
  const { data, loading, error, reload } = useApi<any[]>("communications.list")
  const { data: gw, reload: reloadGw } = useApi<any>("communications.status")
  const [open, setOpen] = useState(false)
  const [detailId, setDetailId] = useState<string | null>(null)

  const emailReady = !!gw?.email?.configured
  const smsReady = !!gw?.sms?.configured

  const columns: Column<any>[] = [
    {
      key: "createdAt", label: "Sent", render: (r) => (
        <div>
          <p className="text-xs font-medium text-slate-700 dark:text-slate-200">{fmtDateTime(r.createdAt)}</p>
          <p className="text-[10px] text-slate-500 dark:text-slate-400">{r.sentByName || "—"}</p>
        </div>
      ),
    },
    {
      key: "channel", label: "Channel", render: (r) => (
        <div className="flex gap-1">
          {(r.channel === "EMAIL" || r.channel === "BOTH") && <Badge className="bg-sky-100 text-sky-700 text-[10px]"><Mail className="h-3 w-3 mr-0.5" />Email</Badge>}
          {(r.channel === "SMS" || r.channel === "BOTH") && <Badge className="bg-violet-100 text-violet-700 text-[10px]"><MessageSquare className="h-3 w-3 mr-0.5" />SMS</Badge>}
        </div>
      ),
    },
    {
      key: "message", label: "Subject / Message", render: (r) => (
        <div className="max-w-md">
          <p className="text-xs font-semibold text-slate-800 dark:text-slate-100 truncate">{r.subject || "—"}</p>
          <p className="text-[11px] text-slate-500 dark:text-slate-400 truncate">{r.message}</p>
        </div>
      ),
    },
    { key: "audienceLabel", label: "Audience", render: (r) => <span className="text-[11px] text-slate-500 dark:text-slate-400">{r.audienceLabel}</span> },
    {
      key: "counts", label: "Delivery", render: (r) => (
        <div className="flex items-center gap-2 text-[11px] tabular-nums">
          <span className="text-emerald-600 font-medium" title="delivered">{r.deliveredCount}✓</span>
          {r.failedCount > 0 && <span className="text-rose-600 font-medium" title="failed">{r.failedCount}✗</span>}
          {r.skippedCount > 0 && <span className="text-slate-400" title="skipped (no address / gateway off)">{r.skippedCount}–</span>}
          <span className="text-slate-400">/ {r.recipientCount}</span>
        </div>
      ),
    },
    { key: "status", label: "Status", render: (r) => <StatusBadge status={r.status} /> },
    {
      key: "actions", label: "", align: "right", render: (r) => (
        <Button size="icon" variant="ghost" className="h-7 w-7" title="Delivery detail" onClick={() => setDetailId(r.id)}>
          <Eye className="h-3.5 w-3.5" />
        </Button>
      ),
    },
  ]

  return (
    <div className="space-y-4">
      <PageHeader
        title="Communication Center"
        subtitle="Send email & SMS messages to all or selected employees — logged per recipient"
        actions={canSend && (
          <Button size="sm" className="h-8 text-xs " onClick={() => setOpen(true)}>
            <Send className="h-3.5 w-3.5 mr-1" /> New Message
          </Button>
        )}
      />

      <div className="grid sm:grid-cols-2 gap-4">
        <SectionCard title="Email Gateway" actions={
          <Button size="icon" variant="ghost" className="h-6 w-6" title="Recheck" onClick={() => reloadGw()}><RotateCw className="h-3 w-3" /></Button>
        }>
          <div className="flex items-center gap-3">
            {emailReady
              ? <><MailCheck className="h-8 w-8 text-emerald-500" /><div><p className="text-sm font-semibold text-emerald-700">Configured &amp; enabled</p><p className="text-[11px] text-slate-500">SMTP settings found — email sends go out for real.</p></div></>
              : <><MailWarning className="h-8 w-8 text-amber-500" /><div><p className="text-sm font-semibold text-amber-700">Not configured yet</p><p className="text-[11px] text-slate-500">Set up Gmail/SMTP in HR Settings → Email Gateway to send emails.</p></div></>}
          </div>
        </SectionCard>
        <SectionCard title="SMS Gateway" actions={
          <Button size="icon" variant="ghost" className="h-6 w-6" title="Recheck" onClick={() => reloadGw()}><RotateCw className="h-3 w-3" /></Button>
        }>
          <div className="flex items-center gap-3">
            {smsReady
              ? <><MessageSquare className="h-8 w-8 text-emerald-500" /><div><p className="text-sm font-semibold text-emerald-700">Configured &amp; enabled</p><p className="text-[11px] text-slate-500">SMS API URL found — text sends go out for real.</p></div></>
              : <><MessageSquare className="h-8 w-8 text-amber-500" /><div><p className="text-sm font-semibold text-amber-700">Not configured yet</p><p className="text-[11px] text-slate-500">Set up your SMS provider in HR Settings → SMS Gateway to send texts.</p></div></>}
          </div>
        </SectionCard>
      </div>

      <DataTable columns={columns} rows={data || undefined} loading={loading} error={error} pageSize={15}
        searchPlaceholder="Search messages…" emptyTitle="No messages sent yet"
        emptyHint={canSend ? "Use “New Message” to email or text all or selected employees." : "Messages sent by HR will appear here."}
        csvName="communications" />

      <ComposeDialog open={open} onOpenChange={(v) => { setOpen(v); if (!v) reload() }} emailReady={emailReady} smsReady={smsReady} />
      <DeliveryDetailDialog logId={detailId} onOpenChange={(v) => { if (!v) setDetailId(null) }} />
    </div>
  )
}

// ---------- compose ----------
function ComposeDialog({ open, onOpenChange, emailReady, smsReady }: {
  open: boolean; onOpenChange: (v: boolean) => void; emailReady: boolean; smsReady: boolean
}) {
  const toast = useHrm((s) => s.toast)
  const { data: branches } = useApi<any[]>(open ? "branches.list" : null, {})
  const { data: departments } = useApi<any[]>(open ? "departments.list" : null, {})
  const { data: designations } = useApi<any[]>(open ? "designations.list" : null, {})

  const [values, setValues] = useState<Record<string, any>>({})
  const { data: employees } = useLookup<any[]>("employees.list", {}, open && ["BRANCH", "DEPARTMENT", "DESIGNATION", "SPECIFIC"].includes(values?.audienceType))
  const [ids, setIds] = useState<string[]>([])
  const [idQuery, setIdQuery] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (open) {
      setValues({ channel: "EMAIL", audienceType: "ALL", subject: "", message: "", inApp: true })
      setIds([]); setIdQuery(""); setError(null)
    }
  }, [open])

  const set = (n: string, v: any) => setValues((s) => ({ ...s, [n]: v }))
  const audienceType = values.audienceType || "ALL"
  const channel = values.channel || "EMAIL"

  const options: { id: string; label: string; sub?: string }[] =
    audienceType === "BRANCH" ? (branches || []).map((b: any) => ({ id: b.id, label: b.name, sub: b.code })) :
    audienceType === "DEPARTMENT" ? (departments || []).map((d: any) => ({ id: d.id, label: d.name, sub: d.code })) :
    audienceType === "DESIGNATION" ? (designations || []).map((d: any) => ({ id: d.id, label: d.name, sub: d.grade })) :
    audienceType === "SPECIFIC" ? (employees || []).map((e: any) => ({ id: e.id, label: e.fullName, sub: e.code })) : []

  const filteredOptions = options.filter((o) =>
    !idQuery || o.label.toLowerCase().includes(idQuery.toLowerCase()) || (o.sub || "").toLowerCase().includes(idQuery.toLowerCase())
  )
  const toggleId = (id: string) => setIds((s) => s.includes(id) ? s.filter((x) => x !== id) : [...s, id])

  const submit = async () => {
    const message = (values.message || "").trim()
    if (!message) { setError("Message is required"); return }
    if ((channel === "EMAIL" || channel === "BOTH") && !(values.subject || "").trim()) { setError("Subject is required for email"); return }
    if (audienceType !== "ALL" && ids.length === 0) { setError("Select at least one audience target"); return }
    setBusy(true); setError(null)
    try {
      // M-04/M-05 — delivery runs as a background job; runJob polls jobs.get
      // until the fan-out completes and surfaces the delivery counts.
      const r = await runJob<any>("communications.send", {
        channel, subject: values.subject, message,
        audienceType, audienceIds: audienceType === "ALL" ? [] : ids, inApp: values.inApp !== false,
      })
      toast(`Sent to ${r.recipientCount} employees — ${r.delivered} delivered${r.failed ? `, ${r.failed} failed` : ""}${r.skipped ? `, ${r.skipped} skipped` : ""}`)
      onOpenChange(false)
    } catch (e: any) { setError(e.message) } finally { setBusy(false) }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-base">New Message</DialogTitle>
          <p className="text-xs text-slate-500">
            Email and SMS delivery use the gateways configured in HR Settings. Variables: {"{{name}}"} and {"{{company}}"}.
          </p>
        </DialogHeader>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 py-2">
          <div className="space-y-1.5">
            <Label className="text-xs font-medium">Channel</Label>
            <Select value={channel} onValueChange={(v) => set("channel", v)}>
              <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
              <SelectContent>
                {CHANNELS.map((c) => {
                  const gwMissing = ((c.value === "EMAIL" || c.value === "BOTH") && !emailReady) || ((c.value === "SMS" || c.value === "BOTH") && !smsReady)
                  return (
                    <SelectItem key={c.value} value={c.value}>
                      {c.label}{gwMissing ? " · gateway not set up" : ""}
                    </SelectItem>
                  )
                })}
              </SelectContent>
            </Select>
            {((channel === "EMAIL" || channel === "BOTH") && !emailReady) && (
              <p className="text-[11px] text-amber-600">Email gateway is not configured — the send will be rejected. Configure it in HR Settings → Email Gateway.</p>
            )}
            {((channel === "SMS" || channel === "BOTH") && !smsReady) && (
              <p className="text-[11px] text-amber-600">SMS gateway is not configured — the send will be rejected. Configure it in HR Settings → SMS Gateway.</p>
            )}
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs font-medium">Audience</Label>
            <Select value={audienceType} onValueChange={(v) => { set("audienceType", v); setIds([]) }}>
              <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
              <SelectContent>{AUDIENCE_TYPES.map((a) => <SelectItem key={a.value} value={a.value}>{a.label}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          {(channel === "EMAIL" || channel === "BOTH") && (
            <div className="sm:col-span-2 space-y-1.5">
              <Label className="text-xs font-medium">Subject <span className="text-rose-500">*</span></Label>
              <Input value={values.subject || ""} onChange={(e) => set("subject", e.target.value)} className="h-9" placeholder="e.g. Office closed on Eid day" />
            </div>
          )}
          <div className="sm:col-span-2 space-y-1.5">
            <Label className="text-xs font-medium">Message <span className="text-rose-500">*</span></Label>
            <Textarea rows={5} value={values.message || ""} onChange={(e) => set("message", e.target.value)}
              placeholder={"Dear {{name}},\n\n…"} />
            <p className="text-[11px] text-slate-500 dark:text-slate-400">{(values.message || "").length}/5000 characters · {"{{name}}"} → employee name · {"{{company}}"} → company name</p>
          </div>
          {audienceType !== "ALL" && (
            <div className="sm:col-span-2 space-y-1.5">
              <Label className="text-xs font-medium">
                Target {AUDIENCE_TYPES.find((a) => a.value === audienceType)?.label.replace("Specific ", "").toLowerCase()}
                {" "}({ids.length} selected) <span className="text-rose-500">*</span>
              </Label>
              {options.length > 6 && (
                <div className="relative">
                  <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-slate-400" />
                  <Input value={idQuery} onChange={(e) => setIdQuery(e.target.value)} placeholder="Filter…" className="pl-8 h-9 text-xs" />
                </div>
              )}
              <div className="border rounded-md p-2 max-h-48 overflow-y-auto space-y-1">
                {filteredOptions.map((o) => (
                  <label key={o.id} className="flex items-center gap-2 text-xs text-slate-700 dark:text-slate-300 rounded px-1.5 py-1 hover:bg-slate-50 dark:hover:bg-slate-800">
                    <Checkbox checked={ids.includes(o.id)} onCheckedChange={() => toggleId(o.id)} />
                    <span className="truncate">{o.label}</span>
                    {o.sub && <span className="ml-auto text-[10px] text-slate-500 dark:text-slate-400 shrink-0">{o.sub}</span>}
                  </label>
                ))}
                {filteredOptions.length === 0 && <p className="text-[11px] text-slate-500 dark:text-slate-400 py-2 text-center">No options{options.length === 0 ? " — loading…" : " match your filter"}.</p>}
              </div>
            </div>
          )}
          <div className="sm:col-span-2 flex items-center gap-2">
            <Switch id="inApp" checked={values.inApp !== false} onCheckedChange={(c) => set("inApp", c)} />
            <Label htmlFor="inApp" className="text-xs font-medium">Also deliver in-app (Notification Center)</Label>
          </div>
        </div>
        {error && <p className="text-sm text-rose-600 bg-rose-50 rounded-md px-3 py-2">{error}</p>}
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
          <Button onClick={submit} disabled={busy}>
            <Send className="h-3.5 w-3.5 mr-1" /> {busy ? "Sending…" : "Send"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ---------- delivery detail ----------
function DeliveryDetailDialog({ logId, onOpenChange }: { logId: string | null; onOpenChange: (v: boolean) => void }) {
  const [data, setData] = useState<any>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!logId) return
    let dead = false
    rpc("communications.recipients", { id: logId })
      .then((r) => { if (!dead) setData(r) })
      .catch((e) => { if (!dead) setError(e.message) })
    return () => { dead = true }
  }, [logId])

  const log = data?.log
  const recipients: any[] = data?.recipients || []
  const stale = !!logId && (!data || data?.log?.id !== logId)

  return (
    <Dialog open={!!logId} onOpenChange={(o) => !o && onOpenChange(false)}>
      <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-base">Delivery Detail</DialogTitle>
          {log && (
            <p className="text-xs text-slate-500">
              {log.subject} · {log.audienceLabel} · {fmtDateTime(log.createdAt)} · {log.recipientCount} recipients
            </p>
          )}
        </DialogHeader>
        {error && <p className="text-sm text-rose-600 bg-rose-50 rounded-md px-3 py-2">{error}</p>}
        {stale && !error && <p className="text-sm text-slate-400 py-6 text-center">Loading recipients…</p>}
        {data && !stale && (
          <>
            <div className="grid grid-cols-3 gap-2 text-center">
              <div className="rounded-lg border bg-emerald-50 dark:bg-emerald-950/40 p-2">
                <p className="text-lg font-bold text-emerald-600 tabular-nums">{log.deliveredCount}</p>
                <p className="text-[10px] text-emerald-700 flex items-center justify-center gap-1"><CheckCircle2 className="h-3 w-3" />Delivered</p>
              </div>
              <div className="rounded-lg border bg-rose-50 dark:bg-rose-950/40 p-2">
                <p className="text-lg font-bold text-rose-600 tabular-nums">{log.failedCount}</p>
                <p className="text-[10px] text-rose-700 flex items-center justify-center gap-1"><XCircle className="h-3 w-3" />Failed</p>
              </div>
              <div className="rounded-lg border bg-slate-50 dark:bg-slate-800/60 p-2">
                <p className="text-lg font-bold text-slate-500 tabular-nums">{log.skippedCount}</p>
                <p className="text-[10px] text-slate-500 flex items-center justify-center gap-1"><MinusCircle className="h-3 w-3" />Skipped</p>
              </div>
            </div>
            {log.message && (
              <div className="rounded-lg border bg-slate-50 dark:bg-slate-800/40 p-3">
                <p className="text-xs text-slate-600 dark:text-slate-300 whitespace-pre-wrap leading-relaxed">{log.message}</p>
              </div>
            )}
            <div className="border rounded-lg overflow-hidden">
              <table className="w-full text-xs">
                <thead>
                  <tr className="bg-slate-50 dark:bg-slate-800 text-slate-500">
                    <th className="text-left px-3 py-2 font-medium">Employee</th>
                    <th className="text-left px-3 py-2 font-medium">Email</th>
                    <th className="text-left px-3 py-2 font-medium">SMS</th>
                  </tr>
                </thead>
                <tbody>
                  {recipients.map((r) => (
                    <tr key={r.id} className="border-t dark:border-slate-800">
                      <td className="px-3 py-2">
                        <p className="font-medium text-slate-700 dark:text-slate-200">{r.employeeName}</p>
                        {r.detail && <p className="text-[10px] text-slate-500 dark:text-slate-400 truncate max-w-[220px]" title={r.detail}>{r.detail}</p>}
                      </td>
                      <td className="px-3 py-2"><StatusBadge status={r.emailStatus || "NA"} /></td>
                      <td className="px-3 py-2"><StatusBadge status={r.smsStatus || "NA"} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}

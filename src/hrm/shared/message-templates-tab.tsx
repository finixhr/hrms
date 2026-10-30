"use client"
// ============ SMS / Email system-template tabs (HR Settings → Templates) ============
// 2026-10 restructure — the fixed catalog of event-triggered SMS/Email
// templates. System-defined: tenants EDIT the wording but can never create
// or delete templates (the list is wired into server-side events).
import { useEffect, useState } from "react"
import {
  AtSign, Lock, Pencil, RotateCcw, Smartphone, Sparkles, Info,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { useHrm } from "../store"
import { useApi, rpc } from "../api"
import { SectionCard, EmptyState } from "./ui-kit"
import { cn } from "@/lib/utils"

export type SystemTemplate = {
  key: string
  label: string
  description: string
  variables: string[]
  emailSubject: string
  emailBody: string
  smsBody: string
  effectiveEmailSubject?: string
  effectiveEmailBody?: string
  effectiveSmsBody?: string
  customized?: boolean
}

// ---------- shared plumbing ----------

function useTemplates() {
  const { data, loading, error, reload } = useApi<{ templates: SystemTemplate[] }>("messageTemplates.list", {})
  return { templates: data?.templates || [], loading, error, reload }
}

function SystemBadge({ customized }: { customized?: boolean }) {
  return customized
    ? <Badge className="bg-amber-100 text-amber-700 text-[10px]">Customized</Badge>
    : <Badge className="bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300 text-[10px]">System default</Badge>
}

function TemplateCard({ t, channel, canEdit, onEdit }: {
  t: SystemTemplate
  channel: "email" | "sms"
  canEdit: boolean
  onEdit: (t: SystemTemplate) => void
}) {
  const body = channel === "email"
    ? t.effectiveEmailBody ?? t.emailBody
    : t.effectiveSmsBody ?? t.smsBody
  return (
    <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-3.5 space-y-2">
      <div className="flex items-start gap-2.5">
        <div className={cn("h-8 w-8 rounded-lg flex items-center justify-center shrink-0",
          channel === "email" ? "bg-cyan-50 dark:bg-cyan-950" : "bg-emerald-50 dark:bg-emerald-950")}>
          {channel === "email"
            ? <AtSign className="h-4 w-4 text-cyan-600 dark:text-cyan-400" />
            : <Smartphone className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">{t.label}</p>
            <SystemBadge customized={t.customized} />
          </div>
          <p className="text-[11px] text-slate-500 dark:text-slate-400">{t.description}</p>
        </div>
        {canEdit && (
          <div className="flex gap-1 shrink-0">
            <Button size="icon" variant="ghost" className="h-7 w-7" title="Edit wording" onClick={() => onEdit(t)}>
              <Pencil className="h-3.5 w-3.5" />
            </Button>
          </div>
        )}
      </div>
      <div className="rounded-lg bg-slate-50 dark:bg-slate-950/60 border border-slate-100 dark:border-slate-800 p-2.5">
        {channel === "email" && (
          <p className="text-[11px] font-semibold text-slate-600 dark:text-slate-300 mb-1 truncate">
            Subject: {t.effectiveEmailSubject ?? t.emailSubject}
          </p>
        )}
        <p className="text-[11px] text-slate-600 dark:text-slate-400 whitespace-pre-wrap line-clamp-4 font-mono leading-relaxed">{body}</p>
      </div>
    </div>
  )
}

function TemplateEditDialog({ template, open, onOpenChange, onDone }: {
  template: SystemTemplate | null
  open: boolean
  onOpenChange: (v: boolean) => void
  onDone: () => void
}) {
  const toast = useHrm((s) => s.toast)
  const [emailSubject, setEmailSubject] = useState("")
  const [emailBody, setEmailBody] = useState("")
  const [smsBody, setSmsBody] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (open && template) {
      setEmailSubject(template.effectiveEmailSubject ?? template.emailSubject)
      setEmailBody(template.effectiveEmailBody ?? template.emailBody)
      setSmsBody(template.effectiveSmsBody ?? template.smsBody)
      setError(null)
    }
  }, [open, template])

  if (!template) return null

  const insertVar = (v: string, which: "subject" | "email" | "sms") => {
    if (which === "subject") setEmailSubject((s) => s + `{{${v}}}`)
    else if (which === "email") setEmailBody((s) => s + `{{${v}}}`)
    else setSmsBody((s) => s + `{{${v}}}`)
  }

  const save = async (reset: boolean) => {
    setBusy(true)
    setError(null)
    try {
      await rpc("messageTemplates.save", {
        key: template.key,
        ...(reset ? {} : { emailSubject, emailBody, smsBody }),
      })
      toast(reset ? "Template reset to the system default" : "Template saved")
      onOpenChange(false)
      onDone()
    } catch (e: any) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  const varChips = (which: "subject" | "email" | "sms") => (
    <div className="rounded-lg border border-dashed border-slate-300 dark:border-slate-700 p-2">
      <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400 mb-1.5">Available variables — click to insert</p>
      <div className="flex flex-wrap gap-1.5">
        {template.variables.map((v) => (
          <button key={v} type="button" onClick={() => insertVar(v, which)}
            className="rounded-md bg-slate-100 dark:bg-slate-800 px-1.5 py-0.5 font-mono text-[10px] text-slate-600 dark:text-slate-300 hover:bg-emerald-100 hover:text-emerald-700 dark:hover:bg-emerald-950 dark:hover:text-emerald-300 transition-colors">
            {`{{${v}}}`}
          </button>
        ))}
      </div>
    </div>
  )

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!busy) onOpenChange(v) }}>
      <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-base flex items-center gap-2">
            {template.label}
            <Badge variant="outline" className="text-[10px]"><Lock className="h-3 w-3 mr-0.5" />System template</Badge>
          </DialogTitle>
          <p className="text-xs text-slate-500">
            {template.description} The event itself is fixed — you are editing the message wording only.
          </p>
        </DialogHeader>

        <div className="space-y-3 py-1">
          <div className="space-y-1.5">
            <Label className="text-xs font-medium flex items-center gap-1.5">
              <AtSign className="h-3.5 w-3.5 text-cyan-600" /> Email subject
            </Label>
            <Input value={emailSubject} onChange={(e) => setEmailSubject(e.target.value)} className="h-9 font-mono text-xs" />
            {varChips("subject")}
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs font-medium flex items-center gap-1.5">
              <AtSign className="h-3.5 w-3.5 text-cyan-600" /> Email body
            </Label>
            <Textarea value={emailBody} onChange={(e) => setEmailBody(e.target.value)} rows={8}
              className="font-mono text-xs leading-relaxed" />
            {varChips("email")}
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs font-medium flex items-center gap-1.5">
              <Smartphone className="h-3.5 w-3.5 text-emerald-600" /> SMS body <span className="text-slate-400 font-normal">(max ~300 chars)</span>
            </Label>
            <Textarea value={smsBody} onChange={(e) => setSmsBody(e.target.value)} rows={3} maxLength={300}
              className="font-mono text-xs leading-relaxed" />
            <div className="flex items-center justify-between">
              <p className="text-[10px] text-slate-400">{smsBody.length} / 300</p>
              {varChips("sms")}
            </div>
          </div>
          <div className="rounded-lg bg-slate-50 dark:bg-slate-950/60 border border-slate-200 dark:border-slate-800 p-2.5 flex gap-2">
            <Info className="h-4 w-4 text-slate-400 shrink-0 mt-0.5" />
            <p className="text-[11px] text-slate-500 dark:text-slate-400">
              Unknown variables render as empty text. Channels (email / SMS / in-app) for this event are configured in
              the <b>Wishes &amp; Notifications</b> tab; gateway credentials in the <b>Email Gateway</b> / <b>SMS Gateway</b> tabs.
            </p>
          </div>
        </div>

        {error && <p className="text-sm text-rose-600 bg-rose-50 dark:bg-rose-950 rounded-md px-3 py-2">{error}</p>}
        <DialogFooter className="gap-2 sm:justify-between">
          <Button variant="ghost" size="sm" onClick={() => save(true)} disabled={busy} className="text-slate-500">
            <RotateCcw className="h-3.5 w-3.5 mr-1" /> Reset to system default
          </Button>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
            <Button onClick={() => save(false)} disabled={busy}>{busy ? "Saving…" : "Save Template"}</Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ---------- the two public tabs ----------

export function SmsTemplatesTab({ canEdit }: { canEdit: boolean }) {
  const { templates, loading, error, reload } = useTemplates()
  const [edit, setEdit] = useState<SystemTemplate | null>(null)
  const [open, setOpen] = useState(false)

  return (
    <div className="space-y-3">
      <SectionCard title="SMS Templates (system-defined)">
        <div className="flex flex-col sm:flex-row sm:items-center gap-3">
          <div className="h-11 w-11 rounded-xl bg-emerald-50 dark:bg-emerald-950 flex items-center justify-center shrink-0">
            <Smartphone className="h-5 w-5 text-emerald-600" />
          </div>
          <p className="text-xs text-slate-600 dark:text-slate-300 flex-1">
            Every event-triggered SMS the platform sends, with its default wording. The <b>list is fixed</b> — you can
            <b> edit</b> any template&apos;s wording, but templates cannot be created or deleted (each one is wired to a live
            server-side event). Saving an empty template restores the system default.
          </p>
        </div>
      </SectionCard>
      {loading ? (
        <div className="grid gap-3 md:grid-cols-2">{Array.from({ length: 4 }).map((_, i) => <div key={i} className="h-32 rounded-xl bg-muted/60 animate-pulse" />)}</div>
      ) : error ? (
        <EmptyState title="Could not load templates" hint={error} icon={Smartphone} />
      ) : templates.length === 0 ? (
        <EmptyState title="No SMS templates" hint="System templates appear here after the next sign-in." icon={Smartphone} />
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {templates.map((t) => (
            <TemplateCard key={t.key} t={t} channel="sms" canEdit={canEdit}
              onEdit={(tpl) => { setEdit(tpl); setOpen(true) }} />
          ))}
        </div>
      )}
      <TemplateEditDialog template={edit} open={open} onOpenChange={setOpen} onDone={reload} />
    </div>
  )
}

export function EmailTemplatesTab({ canEdit }: { canEdit: boolean }) {
  const { templates, loading, error, reload } = useTemplates()
  const [edit, setEdit] = useState<SystemTemplate | null>(null)
  const [open, setOpen] = useState(false)

  return (
    <div className="space-y-3">
      <SectionCard title="Email Templates (system-defined)">
        <div className="flex flex-col sm:flex-row sm:items-center gap-3">
          <div className="h-11 w-11 rounded-xl bg-cyan-50 dark:bg-cyan-950 flex items-center justify-center shrink-0">
            <AtSign className="h-5 w-5 text-cyan-600" />
          </div>
          <p className="text-xs text-slate-600 dark:text-slate-300 flex-1">
            Every event-triggered email the platform sends, with subject and body defaults. The <b>list is fixed</b> — you can
            <b> edit</b> any template&apos;s wording, but templates cannot be created or deleted. Saving an empty template
            restores the system default. <Sparkles className="inline h-3 w-3 text-amber-500" /> Birthday &amp; anniversary
            wishes share their wording with the <b>Wishes &amp; Notifications</b> tab.
          </p>
        </div>
      </SectionCard>
      {loading ? (
        <div className="grid gap-3 md:grid-cols-2">{Array.from({ length: 4 }).map((_, i) => <div key={i} className="h-32 rounded-xl bg-muted/60 animate-pulse" />)}</div>
      ) : error ? (
        <EmptyState title="Could not load templates" hint={error} icon={AtSign} />
      ) : templates.length === 0 ? (
        <EmptyState title="No email templates" hint="System templates appear here after the next sign-in." icon={AtSign} />
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {templates.map((t) => (
            <TemplateCard key={t.key} t={t} channel="email" canEdit={canEdit}
              onEdit={(tpl) => { setEdit(tpl); setOpen(true) }} />
          ))}
        </div>
      )}
      <TemplateEditDialog template={edit} open={open} onOpenChange={setOpen} onDone={reload} />
    </div>
  )
}

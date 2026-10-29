"use client"
// ============ FormDialog — schema-driven create/edit dialogs ============
import { useEffect, useRef, useState } from "react"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { RichTextEditor } from "./rich-text-editor"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { Checkbox } from "@/components/ui/checkbox"
import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar"
import { Upload, UserRound } from "lucide-react"
import { useHrm } from "../store"
import { cn } from "@/lib/utils"
import { processEmployeePhoto } from "./photo"
import { FieldError } from "./ui-kit"

export type FieldDef = {
  name: string
  label: string
  type?: "text" | "number" | "date" | "time" | "select" | "textarea" | "switch" | "email" | "password" | "multiselect" | "photo" | "richtext"
  options?: { value: string; label: string }[]
  required?: boolean
  placeholder?: string
  min?: number
  max?: number
  step?: number
  defaultValue?: any
  rows?: number
  span?: 1 | 2
  help?: string
  /** 2026-10 round — render the input disabled/read-only (e.g. the locked,
   *  auto-generated Code field on Branch/Department/Designation create).
   *  The value is still submitted; users simply cannot edit it. */
  disabled?: boolean
  /** 2026-10 round — conditional visibility (e.g. bank fields only when
   *  the payout method is BANK). Hidden fields are stripped from the submit
   *  payload and skipped by required-validation. */
  showIf?: (values: Record<string, any>) => boolean
}

// Sentinel for "no value" select options (Radix SelectItem rejects value="").
const NONE = "__none__"

export function FormDialog({
  open, onOpenChange, title, description, fields, initial, submitLabel = "Save", onSubmit, wide, banner,
}: {
  open: boolean; onOpenChange: (v: boolean) => void
  title: string; description?: string
  fields: FieldDef[]
  initial?: Record<string, any>
  submitLabel?: string
  onSubmit: (values: Record<string, any>) => Promise<void> | void
  wide?: boolean
  /** WP-C — optional node rendered above the fields (create-time capacity
   *  warnings, e.g. <CapacityWarning limitKey="EMPLOYEES" />). */
  banner?: React.ReactNode
}) {
  const [values, setValues] = useState<Record<string, any>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const toast = useHrm((s) => s.toast)

  // ⚠ Critical: initialize values ONLY when the dialog transitions closed→open.
  // Re-initializing on `fields`/`initial` identity changes would wipe user input
  // mid-entry whenever the parent re-renders (polls, toasts, async lookups) —
  // parents legitimately recreate `fields` arrays inline every render.
  // Latest fields/initial are read through refs at open time.
  const wasOpen = useRef(false)
  const dirtyRef = useRef(false) // L-23 — unsaved-changes guard
  const fieldsRef = useRef(fields)
  const initialRef = useRef(initial)

  // L-18 — refs are synced in an EFFECT, not mutated during render (the
  // codebase's own convention; data-table does the same). Declared BEFORE the
  // open-transition effect so a fresh `fields`/`initial` is visible when the
  // dialog opens in the same commit.
  useEffect(() => {
    fieldsRef.current = fields
    initialRef.current = initial
  })

  useEffect(() => {
    if (open && !wasOpen.current) {
      const v: Record<string, any> = {}
      for (const f of fieldsRef.current) {
        v[f.name] = initialRef.current?.[f.name] ?? f.defaultValue ?? (f.type === "switch" ? false : f.type === "multiselect" ? [] : "")
      }
      setValues(v)
      setError(null)
    }
    wasOpen.current = open
    if (open) dirtyRef.current = false // L-23 — fresh open starts clean
  }, [open])

  const submit = async () => {
    for (const f of fields) {
      // showIf-hidden fields are neither required nor submitted (§46)
      if (f.showIf && !f.showIf(values)) continue
      if (f.required && (values[f.name] === "" || values[f.name] == null)) {
        setError(`${f.label} is required`)
        return
      }
    }
    setBusy(true)
    setError(null)
    try {
      // strip values of hidden conditional fields before submitting
      const payload: Record<string, any> = { ...values }
      for (const f of fields) {
        if (f.showIf && !f.showIf(values)) delete payload[f.name]
      }
      await onSubmit(payload)
      dirtyRef.current = false // L-23 — saved: close without the discard prompt
      onOpenChange(false)
      toast("Saved successfully")
    } catch (e: any) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  const set = (name: string, val: any) => {
    setValues((v) => ({ ...v, [name]: val }))
    dirtyRef.current = true // L-23 — any edit marks the dialog dirty
  }

  // L-23 — closing a DIRTY dialog (Esc / backdrop / X) asks before discarding
  // a partially filled form; a successful submit or a clean state closes free.
  const requestClose = (o: boolean) => {
    if (!o && busy) return
    if (!o && dirtyRef.current && typeof window !== "undefined" && !window.confirm("Discard unsaved changes?")) return
    if (!o) dirtyRef.current = false
    onOpenChange(o)
  }

  return (
    <Dialog open={open} onOpenChange={requestClose}>
      <DialogContent className={cn("sm:max-w-lg max-h-[90vh] overflow-y-auto", wide && "sm:max-w-3xl")}>
        <DialogHeader>
          <DialogTitle className="text-base">{title}</DialogTitle>
          {description && <p className="text-xs text-slate-500">{description}</p>}
          {banner}
        </DialogHeader>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-3 gap-y-2.5 py-1">
          {fields.filter((f) => !f.showIf || f.showIf(values)).map((f) => (
            <div key={f.name} className={cn("space-y-1", f.span === 2 && "sm:col-span-2")}>
              {f.type !== "switch" && (
                <Label htmlFor={f.name} className="text-xs font-medium text-slate-600 dark:text-slate-300">
                  {f.label}{f.required && <span className="text-rose-500 ml-0.5">*</span>}
                </Label>
              )}
              {(!f.type || f.type === "text" || f.type === "email" || f.type === "password") && (
                <Input id={f.name} type={f.type || "text"} value={values[f.name] ?? ""} placeholder={f.placeholder}
                  disabled={f.disabled} readOnly={f.disabled}
                  onChange={(e) => set(f.name, e.target.value)}
                  className={f.disabled ? "font-mono bg-slate-50 dark:bg-slate-900 text-slate-500 dark:text-slate-400" : undefined} />
              )}
              {f.type === "number" && (
                <Input id={f.name} type="number" value={values[f.name] ?? ""} placeholder={f.placeholder}
                  min={f.min} max={f.max} step={f.step || "any"} disabled={f.disabled} readOnly={f.disabled}
                  onChange={(e) => set(f.name, e.target.value === "" ? "" : Number(e.target.value))} />
              )}
              {f.type === "date" && (
                <Input id={f.name} type="date" value={values[f.name] ?? ""} onChange={(e) => set(f.name, e.target.value)} />
              )}
              {f.type === "time" && (
                <Input id={f.name} type="time" value={values[f.name] ?? ""} onChange={(e) => set(f.name, e.target.value)} />
              )}
              {f.type === "select" && (
                <Select value={values[f.name] ?? ""} onValueChange={(v) => set(f.name, v === NONE ? "" : v)}>
                  <SelectTrigger><SelectValue placeholder={f.placeholder || "Select…"} /></SelectTrigger>
                  <SelectContent>
                    {(f.options || []).map((o) => (
                      // Radix forbids SelectItem value="" — transparently map empty
                      // options ("— None —", "— All —") to a sentinel and back.
                      <SelectItem key={o.value || NONE} value={o.value || NONE}>{o.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
              {f.type === "multiselect" && (
                <div className="border rounded-md p-2 max-h-40 overflow-y-auto space-y-1.5">
                  {(f.options || []).map((o) => (
                    <label key={o.value} className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-300">
                      <Checkbox checked={(values[f.name] || []).includes(o.value)}
                        onCheckedChange={(c) => {
                          const cur = values[f.name] || []
                          set(f.name, c ? [...cur, o.value] : cur.filter((x: string) => x !== o.value))
                        }} />
                      {o.label}
                    </label>
                  ))}
                </div>
              )}
              {f.type === "richtext" && (
                <RichTextEditor
                  value={values[f.name] ?? ""}
                  onChange={(html) => set(f.name, html)}
                  placeholder={f.placeholder}
                  minHeight={f.rows ? f.rows * 24 : 180}
                />
              )}
              {f.type === "textarea" && (
                <Textarea id={f.name} value={values[f.name] ?? ""} placeholder={f.placeholder} rows={f.rows || 3}
                  onChange={(e) => set(f.name, e.target.value)} />
              )}
              {f.type === "photo" && (
                <div className="flex items-center gap-4">
                  <Avatar className="h-16 w-16 border-2 border-slate-200 dark:border-slate-700 shrink-0">
                    {values[f.name] ? <AvatarImage src={values[f.name]} alt={f.label} /> : (
                      <AvatarFallback className="bg-slate-100 dark:bg-slate-800 text-slate-400">
                        <UserRound className="h-6 w-6" />
                      </AvatarFallback>
                    )}
                  </Avatar>
                  <div className="space-y-1.5 min-w-0">
                    <div className="flex items-center gap-2">
                      {/* Label-wrapped hidden input — native file dialog on click */}
                      <label className="inline-flex items-center h-8 rounded-md border bg-background px-3 text-xs font-medium cursor-pointer hover:bg-accent hover:text-accent-foreground transition-colors">
                        <Upload className="h-3.5 w-3.5 mr-1.5" />
                        {values[f.name] ? "Change Photo" : "Choose Photo"}
                        <input
                          type="file"
                          accept="image/png,image/jpeg,image/webp"
                          className="hidden"
                          onChange={async (ev) => {
                            const file = ev.target.files?.[0]
                            ev.target.value = "" // allow re-picking the same file
                            if (!file) return
                            try {
                              // one smart-cropped square → full photo + list
                              // thumbnail; the thumb rides along as the
                              // companion "photoThumb" value in the submit
                              // payload (employeesSave accepts it)
                              const { photoUrl, photoThumb } = await processEmployeePhoto(file)
                              set(f.name, photoUrl)
                              set("photoThumb", photoThumb)
                            } catch (e: any) {
                              setError(e?.message || "Could not process the selected photo")
                            }
                          }}
                        />
                      </label>
                      {values[f.name] && (
                        <Button type="button" variant="ghost" size="sm" className="text-xs text-rose-600 hover:text-rose-700 hover:bg-rose-500/10"
                          onClick={() => { set(f.name, ""); set("photoThumb", "") }}>
                          Remove
                        </Button>
                      )}
                    </div>
                    <p className="text-[11px] text-slate-500 dark:text-slate-400">PNG / JPEG / WebP — auto-cropped to fit the photo circle</p>
                  </div>
                </div>
              )}
              {f.type === "switch" && (
                <div className="flex items-center gap-2 pt-1">
                  <Switch id={f.name} checked={!!values[f.name]} onCheckedChange={(c) => set(f.name, c)} />
                  <Label htmlFor={f.name} className="text-xs font-medium text-slate-600 dark:text-slate-300">{f.label}</Label>
                </div>
              )}
              {f.help && <p className="text-[11px] text-slate-500 dark:text-slate-400">{f.help}</p>}
            </div>
          ))}
        </div>
        {/* M-9 — announced to screen readers (role=alert) */}
        <FieldError message={error} />
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => requestClose(false)} disabled={busy}>Cancel</Button>
          <Button onClick={submit} disabled={busy}>
            {busy ? "Saving…" : submitLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ---------- Confirm dialog ----------
export function ConfirmDialog({
  open, onOpenChange, title, message, confirmLabel = "Confirm", danger, onConfirm, requireReason,
}: {
  open: boolean; onOpenChange: (v: boolean) => void; title: string; message: string
  confirmLabel?: string; danger?: boolean; onConfirm: (reason?: string) => Promise<void> | void; requireReason?: boolean
}) {
  const [busy, setBusy] = useState(false)
  const [reason, setReason] = useState("")
  const [error, setError] = useState<string | null>(null)
  const toast = useHrm((s) => s.toast)

  useEffect(() => { if (open) { setReason(""); setError(null) } }, [open])

  const go = async () => {
    if (requireReason && !reason.trim()) { setError("A reason is required for this sensitive action"); return }
    setBusy(true)
    try {
      await onConfirm(reason || undefined)
      onOpenChange(false)
      toast("Done")
    } catch (e: any) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !busy && onOpenChange(v)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader><DialogTitle className="text-base">{title}</DialogTitle></DialogHeader>
        <p className="text-sm text-slate-600 dark:text-slate-300">{message}</p>
        {requireReason && (
          <div className="space-y-1.5">
            <Label className="text-xs font-medium">Reason (audited) <span className="text-rose-500">*</span></Label>
            <Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} placeholder="Why are you performing this action?" />
          </div>
        )}
        {/* M-9 — announced to screen readers (role=alert) */}
        <FieldError message={error} />
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
          <Button onClick={go} disabled={busy} variant={danger ? "destructive" : "default"}>
            {busy ? "Working…" : confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

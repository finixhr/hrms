"use client"
// ============ Website Studio shared primitives ============
// Small, mobile-friendly building blocks reused by every studio tab. Follows
// the owner console's dark-first + light: pairing and the local Card/F/Toggle
// language of the settings page — kept local so tabs stay self-contained.
import { useRef, useState } from "react"
import type { ReactNode } from "react"
import { Loader2, Save, Upload, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { ownerRpc } from "@/saas/owner/client"
import { cn } from "@/lib/utils"

export const inputCls = "h-10 border-white/10 light:border-slate-200 bg-white/5 light:bg-slate-100 light:border-slate-300 light:bg-white light:text-slate-900"

export function WCard({ title, desc, children, onSave, busy, actions }: {
  title: string
  desc?: string
  children: ReactNode
  onSave?: () => void
  busy?: boolean
  actions?: ReactNode
}) {
  return (
    <section className="rounded-2xl border border-white/10 light:border-slate-200 bg-white/[0.03] light:bg-white p-5 light:shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-bold text-white light:text-slate-900">{title}</p>
          {desc && <p className="mt-0.5 text-[11px] leading-relaxed text-slate-500">{desc}</p>}
        </div>
        <div className="flex items-center gap-2">
          {actions}
          {onSave && (
            <Button size="sm" onClick={onSave} disabled={busy} className="bg-white/10 light:bg-slate-900 text-white light:text-white hover:bg-white/20 light:hover:bg-slate-800">
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <><Save className="h-3.5 w-3.5" /> Save</>}
            </Button>
          )}
        </div>
      </div>
      <div className="mt-4 space-y-3">{children}</div>
    </section>
  )
}

export function WField({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div>
      <Label className="text-xs text-slate-400 light:text-slate-600">{label}</Label>
      <div className="mt-1.5">{children}</div>
      {hint && <p className="mt-1 text-[11px] leading-relaxed text-slate-500">{hint}</p>}
    </div>
  )
}

export function WToggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-center justify-between rounded-lg border border-white/10 light:border-slate-200 bg-white/[0.02] light:bg-slate-50 p-3">
      <span className="pr-3 text-xs text-slate-300 light:text-slate-700">{label}</span>
      <Switch checked={checked} onCheckedChange={onChange} />
    </label>
  )
}

export function SuccessNote({ msg }: { msg: string | null }) {
  if (!msg) return null
  return <p className="rounded-xl border border-emerald-400/30 bg-emerald-500/10 p-3 text-sm text-emerald-300 light:text-emerald-700 light:border-emerald-300 light:bg-emerald-50 light:text-emerald-700">{msg}</p>
}

export function ErrorNote({ msg }: { msg: string | null }) {
  if (!msg) return null
  return <p className="rounded-xl border border-red-400/30 bg-red-500/10 p-3 text-sm text-red-300 light:text-red-600 light:border-red-300 light:bg-red-50 light:text-red-700">{msg}</p>
}

// ---------------- image upload (media library backed) ----------------

export function ImagePicker({ label, value, onPick, hint, accept = "image/png,image/jpeg,image/webp,image/svg+xml,image/x-icon" }: {
  label: string
  value: string // "media:<id>" | data URL | path
  onPick: (v: string, previewUrl: string) => void
  hint?: string
  accept?: string
}) {
  const fileRef = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [preview, setPreview] = useState<string | null>(null)

  const previewSrc = preview ?? (value && value !== "/logo.svg" ? (value.startsWith("media:") ? null : value) : null)

  const upload = async (file: File) => {
    setErr(null); setBusy(true)
    try {
      const dataUrl = await readAsDataUrl(file)
      const res = await ownerRpc<{ media: { id: string; preview: string } }>("owner.cms.media.upload", {
        name: file.name.replace(/\.[a-z0-9]+$/i, "").slice(0, 80) || "image",
        dataUrl,
      })
      onPick(`media:${res.media.id}`, res.media.preview)
      setPreview(res.media.preview)
    } catch (e: any) {
      setErr(e?.message || "Upload failed")
    } finally {
      setBusy(false)
    }
  }

  return (
    <div>
      <Label className="text-xs text-slate-400 light:text-slate-600">{label}</Label>
      <div className="mt-1.5 flex items-center gap-3">
        <span className="flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-xl border border-white/10 bg-white/[0.03] light:border-slate-200 light:bg-slate-50">
          {previewSrc ? (
            <img src={previewSrc} alt="preview" className="h-full w-full object-contain p-1.5" />
          ) : (
            <Upload className="h-4 w-4 text-slate-500" />
          )}
        </span>
        <div className="flex flex-col gap-1.5">
          <input
            ref={fileRef}
            type="file"
            accept={accept}
            className="hidden"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) upload(f); e.target.value = "" }}
          />
          <Button size="sm" variant="outline" className="h-8 text-xs" disabled={busy} onClick={() => fileRef.current?.click()}>
            {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Upload className="mr-1.5 h-3 w-3" />} Upload
          </Button>
          {value && value !== "/logo.svg" && (
            <button type="button" className="text-left text-[11px] text-slate-500 hover:text-red-400 light:hover:text-red-600" onClick={() => onPick("", "")}>
              <X className="mr-0.5 inline h-3 w-3" /> Remove
            </button>
          )}
        </div>
      </div>
      {hint && <p className="mt-1 text-[11px] text-slate-500">{hint}</p>}
      {err && <p className="mt-1 text-[11px] text-red-400 light:text-red-600">{err}</p>}
    </div>
  )
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(new Error("Could not read the file"))
    reader.readAsDataURL(file)
  })
}

// ---------------- studio sub-tab bar (scrolls on mobile) ----------------
export function StudioTabs<T extends string>({ tabs, active, onChange }: {
  tabs: { key: T; label: string; icon?: any }[]
  active: T
  onChange: (t: T) => void
}) {
  return (
    <div className="-mx-1 overflow-x-auto scroll-thin px-1 pb-1" role="tablist" aria-label="Website Studio sections">
      <div className="flex min-w-max gap-1.5">
        {tabs.map((t) => (
          <button
            key={t.key}
            role="tab"
            aria-selected={active === t.key}
            type="button"
            onClick={() => onChange(t.key)}
            className={cn(
              "flex items-center gap-1.5 whitespace-nowrap rounded-lg px-3 py-2 text-[12px] font-semibold transition-colors",
              active === t.key
                ? "bg-gradient-to-r from-blue-600 to-violet-600 text-white shadow-lg shadow-indigo-950/40"
                : "border border-white/10 light:border-slate-200 text-slate-400 light:text-slate-600 hover:bg-white/5 light:hover:bg-slate-100 hover:text-white light:hover:text-slate-900"
            )}
          >
            {t.icon && <t.icon className="h-3.5 w-3.5" />} {t.label}
          </button>
        ))}
      </div>
    </div>
  )
}

// ---------------- textarea helper ----------------
export function WTextArea({ label, value, onChange, rows = 3, placeholder, maxLength }: {
  label: string; value: string; onChange: (v: string) => void; rows?: number; placeholder?: string; maxLength?: number
}) {
  return (
    <WField label={label}>
      <textarea
        value={value}
        rows={rows}
        maxLength={maxLength}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-lg border border-white/10 light:border-slate-200 bg-white/5 light:bg-white p-2.5 text-sm text-white light:text-slate-900 placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/40"
      />
    </WField>
  )
}

export { Input }

"use client"
// ============ Owner console auth UI kit (login / forgot / reset) ============
// Shared visual shell so all three pre-auth pages render identically in BOTH
// themes. The pre-paint script defaults /owner to dark; every class here
// carries an explicit light: counterpart. Input text colors are EXPLICIT
// (text-white light:text-slate-900) — the historical bug was inheriting the
// light-theme foreground (near-black) on the dark card, making typed values
// unreadable.
import { useState } from "react"
import type { ReactNode } from "react"
import { Eye, EyeOff, Loader2, Sparkles } from "lucide-react"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Button } from "@/components/ui/button"
import { OwnerThemeToggle } from "./theme"

/** Full-screen backdrop + centered card. */
export function OwnerAuthShell({ children, footer }: { children: ReactNode; footer?: ReactNode }) {
  return (
    <div className="relative flex min-h-dvh items-center justify-center bg-slate-950 px-4 light:bg-slate-100">
      <div aria-hidden className="pointer-events-none absolute inset-0">
        <div className="absolute left-1/2 top-[-160px] h-[420px] w-[720px] -translate-x-1/2 rounded-full bg-indigo-600/20 blur-[130px] light:bg-indigo-300/40" />
        <div
          className="absolute inset-0 opacity-[0.3] light:opacity-[0.6]"
          style={{
            backgroundImage:
              "linear-gradient(to right, rgba(148,163,184,0.06) 1px, transparent 1px), linear-gradient(to bottom, rgba(148,163,184,0.06) 1px, transparent 1px)",
            backgroundSize: "44px 44px",
          }}
        />
      </div>
      <div className="absolute right-4 top-4 z-10">
        <OwnerThemeToggle />
      </div>
      <div className="relative w-full max-w-md">
        <div className="rounded-2xl border border-white/10 bg-white/[0.04] p-8 backdrop-blur-xl light:border-slate-200 light:bg-white light:shadow-xl light:shadow-slate-300/30">
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-blue-500 via-indigo-500 to-violet-500 shadow-lg shadow-indigo-950/60 light:shadow-indigo-300/50">
              <Sparkles className="h-5 w-5 text-white" />
            </span>
            <div>
              <p className="text-lg font-bold text-white light:text-slate-900">Finix HR</p>
              <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-indigo-300/80 light:text-indigo-600">SaaS Owner Console</p>
            </div>
          </div>
          {children}
        </div>
        {footer}
      </div>
    </div>
  )
}

export function OwnerAuthHeading({ title, sub }: { title: string; sub?: string }) {
  return (
    <div className="mt-7">
      <h1 className="text-[15px] font-bold text-white light:text-slate-900">{title}</h1>
      {sub && <p className="mt-1 text-xs text-slate-400 light:text-slate-600">{sub}</p>}
    </div>
  )
}

export function OwnerAlert({ kind, children }: { kind: "error" | "info"; children: ReactNode }) {
  return (
    <div
      role="alert"
      className={
        kind === "error"
          ? "rounded-lg border border-red-400/30 bg-red-500/10 p-3 text-sm text-red-300 light:border-red-300 light:bg-red-50 light:text-red-700"
          : "rounded-lg border border-emerald-400/30 bg-emerald-500/10 p-3 text-sm text-emerald-300 light:border-emerald-300 light:bg-emerald-50 light:text-emerald-700"
      }
    >
      {children}
    </div>
  )
}

const inputCls =
  "h-10 bg-white/5 border-white/10 text-white placeholder:text-slate-500 light:bg-white light:border-slate-300 light:text-slate-900 light:placeholder:text-slate-400"

/** Password input with the show/hide eye toggle. */
export function OwnerPasswordField({
  id, label, value, onChange, placeholder, autoComplete = "current-password", autoFocus, required = true,
}: {
  id: string
  label: string
  value: string
  onChange: (v: string) => void
  placeholder?: string
  autoComplete?: string
  autoFocus?: boolean
  required?: boolean
}) {
  const [show, setShow] = useState(false)
  return (
    <div>
      <Label htmlFor={id} className="text-xs text-slate-400 light:text-slate-600">{label}</Label>
      <div className="relative mt-1.5">
        <Input
          id={id}
          type={show ? "text" : "password"}
          value={value}
          required={required}
          autoFocus={autoFocus}
          autoComplete={autoComplete}
          placeholder={placeholder || "••••••••"}
          onChange={(e) => onChange(e.target.value)}
          className={`${inputCls} pr-11`}
        />
        <button
          type="button"
          onClick={() => setShow((v) => !v)}
          aria-label={show ? "Hide password" : "Show password"}
          title={show ? "Hide password" : "Show password"}
          className="absolute inset-y-0 right-0 flex w-10 items-center justify-center text-slate-500 transition-colors hover:text-slate-200 light:hover:text-slate-700"
        >
          {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
        </button>
      </div>
    </div>
  )
}

/** Plain (email/code) input with the same explicit contrast contract. */
export function OwnerField(props: {
  id: string
  label: string
  type?: string
  value: string
  onChange: (v: string) => void
  placeholder?: string
  autoComplete?: string
  autoFocus?: boolean
  mono?: boolean
}) {
  return (
    <div>
      <Label htmlFor={props.id} className="text-xs text-slate-400 light:text-slate-600">{props.label}</Label>
      <Input
        id={props.id}
        type={props.type || "text"}
        value={props.value}
        autoFocus={props.autoFocus}
        autoComplete={props.autoComplete}
        placeholder={props.placeholder}
        onChange={(e) => props.onChange(e.target.value)}
        className={`mt-1.5 ${inputCls} ${props.mono ? "text-center text-lg tracking-[0.35em] font-mono tabular-nums" : ""}`}
      />
    </div>
  )
}

export function OwnerSubmit({ busy, children, disabled, onClick }: { busy: boolean; children: ReactNode; disabled?: boolean; onClick?: () => void }) {
  return (
    <Button
      type={onClick ? "button" : "submit"}
      onClick={onClick}
      disabled={busy || disabled}
      className="h-11 w-full bg-gradient-to-r from-blue-600 to-violet-600 font-semibold text-white hover:from-blue-500 hover:to-violet-500 light:from-blue-600 light:to-violet-600"
    >
      {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : children}
    </Button>
  )
}

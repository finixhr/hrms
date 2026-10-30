"use client"
// ============ Account security self-service (HRM-006 / HRM-007) ============
// Three dialogs surfaced from the app-shell account menu:
//  • SecurityMfaDialog     — TOTP enrolment wizard (scan → confirm → recovery codes)
//                           or status + disable for already-enrolled users.
//  • SecurityPasskeysDialog— WebAuthn passkey manager (biometric / Face ID via
//                           platform authenticators): list, add, remove.
//  • ChangePasswordDialog  — self-service password change with live policy hints.
import { useEffect, useState } from "react"
import {
  AlertTriangle, Check, CloudCheck, Copy, Fingerprint, KeyRound, Loader2,
  Plus, ShieldCheck, Smartphone, Trash2,
} from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { useHrm } from "./store"
import { rpc } from "./api"
import { fmtDateTime } from "./shared/ui-kit"
import { cn } from "@/lib/utils"
import { browserSupportsWebAuthn, startRegistration } from "@simplewebauthn/browser"

export type PasswordPolicy = {
  minLength?: number
  requireUpper?: boolean
  requireLower?: boolean
  requireDigit?: boolean
  requireSymbol?: boolean
  expiryDays?: number
  historyCount?: number
  lockoutThreshold?: number
  lockoutMinutes?: number
}

/** Server route returns { policy: {...} } (see routes/auth.ts) — accept both
 *  that wrapper and a flat object defensively. */
export async function fetchPasswordPolicy(): Promise<PasswordPolicy | null> {
  try {
    const d = await rpc<any>("auth.password.policy", {})
    const p = d?.policy || d
    return p && typeof p === "object" ? p : null
  } catch {
    return null
  }
}

/** Human-readable one-line hints for the vendor password policy. */
export function policyHints(p?: PasswordPolicy | null): string[] {
  if (!p) return ["Meets your vendor's password policy"]
  const out: string[] = []
  out.push(`At least ${p.minLength || 8} characters`)
  const req: string[] = []
  if (p.requireUpper) req.push("an uppercase letter")
  if (p.requireLower) req.push("a lowercase letter")
  if (p.requireDigit) req.push("a digit")
  if (p.requireSymbol) req.push("a symbol")
  out.push(req.length ? `Contains ${req.join(", ")}` : "Any characters allowed")
  if (p.historyCount) out.push(`Cannot reuse your last ${p.historyCount} passwords`)
  if (p.expiryDays) out.push(`Expires every ${p.expiryDays} days`)
  return out
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

function CopyButton({ text, label }: { text: string; label?: string }) {
  const [done, setDone] = useState(false)
  return (
    <Button
      type="button" size="sm" variant="outline" className="h-7 text-xs gap-1"
      onClick={async () => {
        if (await copyText(text)) {
          setDone(true)
          setTimeout(() => setDone(false), 1600)
        }
      }}
    >
      {done ? <Check className="h-3 w-3 text-emerald-600" /> : <Copy className="h-3 w-3" />}
      {done ? "Copied" : label || "Copy"}
    </Button>
  )
}

// ============================================================
// Security & MFA dialog
// ============================================================
export function SecurityMfaDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const toast = useHrm((s) => s.toast)
  const [loading, setLoading] = useState(true)
  const [enrolled, setEnrolled] = useState(false)
  const [roleRequires, setRoleRequires] = useState(false)
  const [recoveryLeft, setRecoveryLeft] = useState(0)
  // enrolment wizard state
  const [step, setStep] = useState<1 | 2 | 3>(1)
  const [secret, setSecret] = useState("")
  const [otpauthUrl, setOtpauthUrl] = useState("")
  const [qrDataUrl, setQrDataUrl] = useState("")
  const [qrFailed, setQrFailed] = useState(false)
  const [code, setCode] = useState("")
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([])
  const [savedAck, setSavedAck] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refreshStatus = async () => {
    setLoading(true)
    try {
      const s = await rpc<any>("auth.mfa.status", {})
      setEnrolled(!!s.enrolled)
      setRoleRequires(!!s.roleRequires)
      setRecoveryLeft(Number(s.recoveryCodesLeft || 0))
      if (!s.enrolled) await startEnrolment()
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  const startEnrolment = async () => {
    setError(null)
    setStep(1)
    setCode("")
    setSavedAck(false)
    setQrFailed(false)
    try {
      const d = await rpc<any>("auth.mfa.start", {})
      setSecret(d.secret || "")
      setOtpauthUrl(d.uri || d.otpauthUrl || "")
      setQrDataUrl(d.qrDataUrl || "")
    } catch (e: any) {
      setError(e.message)
    }
  }

  useEffect(() => {
    if (open) {
      setError(null)
      setCode("")
      setStep(1)          // recovery codes are one-shot — never re-show step 3
      setRecoveryCodes([])
      void refreshStatus()
    }
  }, [open]) // refreshStatus is re-created per render by design (reads latest state)

  const confirmCode = async () => {
    if (!code) { setError("Enter the 6-digit code from your authenticator app"); return }
    setBusy(true)
    setError(null)
    try {
      const d = await rpc<any>("auth.mfa.enable", { code })
      setRecoveryCodes(d.recoveryCodes || [])
      setEnrolled(true)
      setStep(3)
    } catch (e: any) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  const [password, setPassword] = useState("") // L-1 — password required to disable MFA

  const disableMfa = async () => {
    // L-1 — BOTH factors: password + current TOTP code (server enforces the same)
    if (!password) { setError("Enter your account password to disable MFA"); return }
    if (!code) { setError("Enter your current verification code to disable MFA"); return }
    setBusy(true)
    setError(null)
    try {
      await rpc("auth.mfa.disable", { code, password })
      toast("Multi-factor authentication disabled")
      setEnrolled(false)
      setCode("")
      setPassword("")
      await refreshStatus()
    } catch (e: any) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  const groupedSecret = (secret || "").replace(/(.{4})/g, "$1 ").trim()

  return (
    <Dialog open={open} onOpenChange={(v) => !busy && onOpenChange(v)}>
      <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-base flex items-center gap-2">
            <ShieldCheck className="h-4.5 w-4.5 text-emerald-600" /> Security &amp; MFA
          </DialogTitle>
          <DialogDescription className="text-xs">
            Time-based one-time passwords (TOTP) from Google Authenticator, Microsoft Authenticator or any compatible app.
          </DialogDescription>
        </DialogHeader>

        {loading && (
          <div className="flex items-center justify-center gap-2 py-10 text-sm text-slate-500">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading security status…
          </div>
        )}

        {!loading && error && !enrolled && step === 1 && !secret && (
          <p className="text-sm text-rose-600 bg-rose-50 dark:bg-rose-950 rounded-md px-3 py-2">{error}</p>
        )}

        {/* ---------- enrolled: status + disable ---------- */}
        {!loading && enrolled && step !== 3 && (
          <div className="space-y-4">
            <div className="rounded-xl border border-emerald-200 dark:border-emerald-900 bg-emerald-50 dark:bg-emerald-950 p-4">
              <div className="flex items-center gap-3">
                <div className="h-10 w-10 rounded-lg bg-gradient-to-br from-emerald-500 to-teal-600 text-white flex items-center justify-center shrink-0">
                  <Smartphone className="h-5 w-5" />
                </div>
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-emerald-800 dark:text-emerald-300">Multi-factor authentication is enabled</p>
                  <p className="text-xs text-emerald-700/80 dark:text-emerald-400/80 mt-0.5">
                    A verification code is required at every sign-in.
                  </p>
                </div>
                {roleRequires && <Badge className="ml-auto bg-amber-100 text-amber-700 text-[10px] shrink-0">Required for your role</Badge>}
              </div>
              <div className="mt-3 flex items-center gap-2 text-xs text-emerald-800 dark:text-emerald-300">
                <span>Recovery codes remaining: <strong className="tabular-nums">{recoveryLeft}</strong></span>
                {recoveryLeft === 0 && <Badge variant="outline" className="text-[10px] border-rose-300 text-rose-600">none left — re-enrol to regenerate</Badge>}
              </div>
            </div>

            <div className="rounded-xl border border-rose-200 dark:border-rose-900 p-4 space-y-3">
              <div className="flex items-center gap-2">
                <AlertTriangle className="h-4 w-4 text-rose-600 shrink-0" />
                <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">Disable MFA</p>
              </div>
              <p className="text-xs text-slate-500">Removing the second factor makes your account password-only. Confirm with your account password AND a current verification code.</p>
              <div className="space-y-1.5">
                <Label htmlFor="mfa-disable-password" className="text-xs font-medium">Account password</Label>
                <Input
                  id="mfa-disable-password" type="password" autoComplete="current-password"
                  value={password} onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••" className="h-9"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="mfa-disable-code" className="text-xs font-medium">Current verification code</Label>
                <Input
                  id="mfa-disable-code" inputMode="numeric" maxLength={8} autoComplete="one-time-code"
                  value={code} onChange={(e) => setCode(e.target.value.replace(/[^\dA-Za-z]/g, ""))}
                  placeholder="123456" className="h-9 tracking-[0.3em] font-mono"
                />
              </div>
              {error && <p className="text-xs text-rose-600 bg-rose-50 dark:bg-rose-950 rounded-md px-3 py-2">{error}</p>}
              <Button variant="destructive" size="sm" className="h-9 text-xs" disabled={busy} onClick={disableMfa}>
                {busy && <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />} Disable MFA
              </Button>
            </div>
          </div>
        )}

        {/* ---------- step 1: scan / copy secret ---------- */}
        {!loading && !enrolled && step === 1 && (
          <div className="space-y-4">
            {secret ? (
              <>
                <div className="flex flex-col sm:flex-row gap-4 items-center">
                  {qrDataUrl && !qrFailed ? (
                    <div className="rounded-xl border border-slate-200 dark:border-slate-700 bg-white p-2 shrink-0">
                      {/* server-rendered data-URL QR (no external service) */}
                      <img
                        src={qrDataUrl} alt="TOTP enrolment QR code" width={180} height={180}
                        className="rounded-lg"
                        onError={() => setQrFailed(true)}
                      />
                    </div>
                  ) : (
                    <div className="rounded-xl border border-slate-200 dark:border-slate-700 p-3 text-xs text-slate-500 text-center max-w-[180px]">
                      QR image unavailable — enter the setup key manually below.
                    </div>
                  )}
                  <ol className="text-xs text-slate-600 dark:text-slate-300 space-y-1.5 list-decimal list-inside">
                    <li>Open your authenticator app</li>
                    <li>Scan the QR code (or add the key manually)</li>
                    <li>Enter the 6-digit code it shows to finish</li>
                  </ol>
                </div>
                <div className="space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <Label className="text-xs font-medium">Setup key (manual entry)</Label>
                    <CopyButton text={secret} label="Copy key" />
                  </div>
                  <p className="rounded-lg bg-slate-100 dark:bg-slate-800 px-3 py-2 font-mono text-[13px] tracking-wider text-slate-800 dark:text-slate-200 break-all select-all">{groupedSecret}</p>
                </div>
                {otpauthUrl && (
                  <details className="text-xs">
                    <summary className="cursor-pointer text-slate-500 hover:text-slate-700 dark:hover:text-slate-300">otpauth:// URI (copyable)</summary>
                    <div className="mt-1.5 flex items-start gap-2">
                      <p className="flex-1 rounded-lg bg-slate-100 dark:bg-slate-800 px-2.5 py-1.5 font-mono text-[10px] break-all text-slate-500 max-h-16 overflow-y-auto">{otpauthUrl}</p>
                      <CopyButton text={otpauthUrl} />
                    </div>
                  </details>
                )}
                {error && <p className="text-xs text-rose-600 bg-rose-50 dark:bg-rose-950 rounded-md px-3 py-2">{error}</p>}
                <Button className="w-full h-10 " onClick={() => setStep(2)}>
                  I&apos;ve added it — continue
                </Button>
              </>
            ) : (
              !error && <div className="flex items-center justify-center gap-2 py-8 text-sm text-slate-500"><Loader2 className="h-4 w-4 animate-spin" /> Preparing enrolment…</div>
            )}
          </div>
        )}

        {/* ---------- step 2: confirm code ---------- */}
        {!loading && !enrolled && step === 2 && (
          <div className="space-y-4">
            <p className="text-sm text-slate-600 dark:text-slate-300">Enter the 6-digit code your authenticator app is showing right now to confirm enrolment.</p>
            <Input
              autoFocus inputMode="numeric" maxLength={6} autoComplete="one-time-code"
              value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
              onKeyDown={(e) => { if (e.key === "Enter") confirmCode() }}
              placeholder="••••••" className="h-12 text-center text-xl tracking-[0.5em] font-mono tabular-nums"
            />
            {error && <p className="text-xs text-rose-600 bg-rose-50 dark:bg-rose-950 rounded-md px-3 py-2">{error}</p>}
            <div className="flex gap-2">
              <Button variant="outline" className="flex-1" onClick={() => { setStep(1); setError(null); setCode("") }} disabled={busy}>Back</Button>
              <Button className="flex-1 " onClick={confirmCode} disabled={busy || code.length < 6}>
                {busy && <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />} Verify &amp; enable
              </Button>
            </div>
          </div>
        )}

        {/* ---------- step 3: recovery codes ---------- */}
        {!loading && step === 3 && (
          <div className="space-y-4">
            <div className="rounded-xl border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950 p-3 flex gap-2.5">
              <AlertTriangle className="h-4.5 w-4.5 text-amber-600 shrink-0 mt-0.5" />
              <p className="text-xs text-amber-800 dark:text-amber-300 leading-relaxed">
                <strong>Save these recovery codes now.</strong> They are shown only once — each code can be used
                a single time to sign in if you lose your authenticator device. Store them somewhere safe (password manager or printed).
              </p>
            </div>
            <div className="flex items-center justify-between">
              <Label className="text-xs font-medium">Recovery codes</Label>
              <CopyButton text={recoveryCodes.join("\n")} label="Copy all" />
            </div>
            <div className="grid grid-cols-2 gap-1.5">
              {recoveryCodes.map((c) => (
                <p key={c} className="rounded-lg bg-slate-100 dark:bg-slate-800 px-3 py-1.5 font-mono text-xs text-slate-800 dark:text-slate-200 text-center select-all">{c}</p>
              ))}
            </div>
            <label className="flex items-start gap-2 text-xs text-slate-600 dark:text-slate-300 cursor-pointer">
              <Checkbox checked={savedAck} onCheckedChange={(v) => setSavedAck(!!v)} className="mt-0.5" />
              I have saved these codes in a safe place
            </label>
            <Button className="w-full h-10 " disabled={!savedAck} onClick={() => onOpenChange(false)}>
              <Check className="h-4 w-4 mr-1.5" /> Done
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

// ============================================================
// Passkeys / Biometric MFA dialog (WebAuthn platform authenticators)
// ============================================================
// The browser never exposes biometric material to this app: the authenticator
// (Face ID / Touch ID / Windows Hello / Android biometric) verifies the user
// on-device and hands back a signed assertion. This dialog only ever ships
// the ceremony options + assertion JSON to auth.passkey.* and lists the
// resulting public-key registrations.
export type PasskeyItem = {
  id: string
  deviceName: string
  backupEligible: boolean
  backupState: boolean
  lastUsedAt: string | null
  createdAt: string
}

export function SecurityPasskeysDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const toast = useHrm((s) => s.toast)
  const [items, setItems] = useState<PasskeyItem[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [label, setLabel] = useState("") // optional device label (default "Passkey")
  const [error, setError] = useState<string | null>(null)
  const [removeTarget, setRemoveTarget] = useState<PasskeyItem | null>(null)
  const [removePw, setRemovePw] = useState("")
  // WebAuthn needs a secure context (https or localhost) — PublicKeyCredential
  // is undefined otherwise; show a hint instead of a dead button.
  const supported = browserSupportsWebAuthn()

  const refresh = async () => {
    setLoading(true)
    try {
      const d = await rpc<{ items: PasskeyItem[] }>("auth.passkey.list", {})
      setItems(d?.items || [])
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (open) {
      setError(null)
      setLabel("")
      setRemoveTarget(null)
      setRemovePw("")
      void refresh()
    }
  }, [open]) // refresh is re-created per render by design (reads latest state)

  // ---- add: register.start → browser ceremony → register.finish ----
  const addPasskey = async () => {
    if (!supported) {
      setError("This browser cannot use passkeys (WebAuthn is unavailable — passkeys need HTTPS and an up-to-date browser).")
      return
    }
    setBusy(true)
    setError(null)
    try {
      const d = await rpc<any>("auth.passkey.register.start", {})
      // the OS/browser takes over: Face ID / Touch ID / Windows Hello prompt
      const attestation = await startRegistration({ optionsJSON: d.options })
      const fin = await rpc<{ items: PasskeyItem[] }>("auth.passkey.register.finish", {
        name: label.trim() || undefined,
        attestation,
      })
      setItems(fin?.items || [])
      setLabel("")
      toast("Passkey added — you can now use it to sign in")
    } catch (e: any) {
      // NotAllowedError etc. surface with readable messages from the browser
      setError(e?.message || "Passkey registration failed")
    } finally {
      setBusy(false)
    }
  }

  // ---- remove: password confirmation required server-side (L-1) ----
  const removePasskey = async () => {
    if (!removeTarget) return
    if (!removePw) { setError("Enter your account password to remove this passkey"); return }
    setBusy(true)
    setError(null)
    try {
      const fin = await rpc<{ items: PasskeyItem[] }>("auth.passkey.remove", { id: removeTarget.id, password: removePw })
      setItems(fin?.items || [])
      setRemoveTarget(null)
      setRemovePw("")
      toast("Passkey removed")
    } catch (e: any) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !busy && onOpenChange(v)}>
      <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-base flex items-center gap-2">
            <Fingerprint className="h-4.5 w-4.5 text-emerald-600" /> Passkeys &amp; Biometric Sign-in
          </DialogTitle>
          <DialogDescription className="text-xs">
            Sign in with Face ID, Touch ID, Windows Hello or your phone&apos;s biometric unlock — no code typing.
            Your biometrics never leave your device.
          </DialogDescription>
        </DialogHeader>

        {!supported && (
          <p className="text-xs text-amber-700 bg-amber-50 dark:bg-amber-950 rounded-md px-3 py-2">
            This browser (or the non-HTTPS connection) does not support passkeys. Use a modern browser over HTTPS, then add your passkey.
          </p>
        )}

        {loading ? (
          <div className="flex items-center justify-center gap-2 py-10 text-sm text-slate-500">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading passkeys…
          </div>
        ) : (
          <div className="space-y-4">
            {/* ---------- registered passkeys ---------- */}
            {items.length === 0 ? (
              <div className="rounded-xl border border-slate-200 dark:border-slate-700 p-4 text-center">
                <Fingerprint className="h-6 w-6 text-slate-400 mx-auto mb-2" />
                <p className="text-sm font-medium text-slate-700 dark:text-slate-200">No passkeys yet</p>
                <p className="text-xs text-slate-500 mt-1">Add one below and use it as your sign-in second factor.</p>
              </div>
            ) : (
              <ul className="space-y-2">
                {items.map((k) => (
                  <li key={k.id} className="rounded-xl border border-slate-200 dark:border-slate-700 p-3 flex items-center gap-3">
                    <div className="h-9 w-9 rounded-lg bg-gradient-to-br from-emerald-500 to-teal-600 text-white flex items-center justify-center shrink-0">
                      {k.backupEligible ? <CloudCheck className="h-4.5 w-4.5" /> : <Smartphone className="h-4.5 w-4.5" />}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-slate-800 dark:text-slate-100 truncate">{k.deviceName}</p>
                      <p className="text-[11px] text-slate-500 mt-0.5">
                        {k.backupEligible ? (k.backupState ? "Synced passkey — works across your devices" : "Synced-capable passkey") : "Device-bound passkey"}
                        {" · "}added {fmtDateTime(k.createdAt)}
                        {k.lastUsedAt ? ` · last used ${fmtDateTime(k.lastUsedAt)}` : " · never used"}
                      </p>
                    </div>
                    <Button variant="outline" size="sm" className="h-8 text-xs gap-1 shrink-0" disabled={busy}
                      onClick={() => { setRemoveTarget(k); setRemovePw(""); setError(null) }}>
                      <Trash2 className="h-3.5 w-3.5" /> Remove
                    </Button>
                  </li>
                ))}
              </ul>
            )}

            {/* ---------- remove confirmation (password re-auth) ---------- */}
            {removeTarget && (
              <div className="rounded-xl border border-rose-200 dark:border-rose-900 p-4 space-y-3">
                <div className="flex items-center gap-2">
                  <AlertTriangle className="h-4 w-4 text-rose-600 shrink-0" />
                  <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">Remove “{removeTarget.deviceName}”?</p>
                </div>
                <p className="text-xs text-slate-500">Confirm with your account password — removing your last passkey returns this account to password + TOTP sign-in.</p>
                <div className="space-y-1.5">
                  <Label htmlFor="passkey-remove-pw" className="text-xs font-medium">Account password</Label>
                  <Input
                    id="passkey-remove-pw" type="password" autoComplete="current-password" autoFocus
                    value={removePw} onChange={(e) => setRemovePw(e.target.value)}
                    placeholder="••••••••" className="h-9"
                    onKeyDown={(e) => { if (e.key === "Enter") removePasskey() }}
                  />
                </div>
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" className="h-9 text-xs" disabled={busy} onClick={() => { setRemoveTarget(null); setRemovePw(""); setError(null) }}>
                    Cancel
                  </Button>
                  <Button variant="destructive" size="sm" className="h-9 text-xs" disabled={busy || !removePw} onClick={removePasskey}>
                    {busy && <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />} Remove passkey
                  </Button>
                </div>
              </div>
            )}

            {/* ---------- add ---------- */}
            {!removeTarget && (
              <div className="rounded-xl border border-emerald-200 dark:border-emerald-900 bg-emerald-50/60 dark:bg-emerald-950/40 p-4 space-y-3">
                <div className="flex items-center gap-2">
                  <Plus className="h-4 w-4 text-emerald-600 shrink-0" />
                  <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">Add a passkey</p>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="passkey-label" className="text-xs font-medium">Device label (optional)</Label>
                  <Input
                    id="passkey-label" value={label} maxLength={60}
                    onChange={(e) => setLabel(e.target.value)}
                    placeholder="e.g. iPhone — Face ID" className="h-9"
                  />
                </div>
                <Button size="sm" className="h-9 text-xs" disabled={busy || !supported} onClick={addPasskey}>
                  {busy ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <Fingerprint className="h-3.5 w-3.5 mr-1.5" />}
                  {busy ? "Waiting for your device…" : "Add passkey"}
                </Button>
                <p className="text-[11px] text-emerald-800/80 dark:text-emerald-400/80">
                  You&apos;ll be asked to authenticate with your device&apos;s biometric or PIN. The ceremony is bound to this site and single-use.
                </p>
              </div>
            )}

            {error && <p className="text-xs text-rose-600 bg-rose-50 dark:bg-rose-950 rounded-md px-3 py-2">{error}</p>}
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

// ============================================================
// Change password dialog (self-service)
// ============================================================
export function ChangePasswordDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const { toast: _toast, logout } = useHrm()
  const [policy, setPolicy] = useState<PasswordPolicy | null>(null)
  const [current, setCurrent] = useState("")
  const [next, setNext] = useState("")
  const [confirm, setConfirm] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)

  useEffect(() => {
    if (open) {
      setCurrent(""); setNext(""); setConfirm(""); setError(null); setDone(false)
      fetchPasswordPolicy().then(setPolicy)
    }
  }, [open])

  const meetsClientRules = (pw: string) =>
    !!pw && pw.length >= (policy?.minLength || 8) &&
    (!policy?.requireUpper || /[A-Z]/.test(pw)) &&
    (!policy?.requireLower || /[a-z]/.test(pw)) &&
    (!policy?.requireDigit || /\d/.test(pw)) &&
    (!policy?.requireSymbol || /[^A-Za-z0-9]/.test(pw))

  const submit = async () => {
    if (!current) { setError("Enter your current password"); return }
    if (!meetsClientRules(next)) { setError("The new password does not meet the policy requirements"); return }
    if (next !== confirm) { setError("New password and confirmation do not match"); return }
    if (next === current) { setError("The new password must be different from the current one"); return }
    setBusy(true)
    setError(null)
    try {
      await rpc("auth.password.change", { currentPassword: current, newPassword: next })
      setDone(true)
    } catch (e: any) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  const hints = policyHints(policy)

  return (
    <Dialog open={open} onOpenChange={(v) => !busy && onOpenChange(v)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-base flex items-center gap-2">
            <KeyRound className="h-4.5 w-4.5 text-emerald-600" /> Change Password
          </DialogTitle>
          <DialogDescription className="text-xs">
            Changing your password signs you out of every device — you&apos;ll sign in again with the new password.
          </DialogDescription>
        </DialogHeader>

        {done ? (
          <div className="space-y-4 py-2">
            <div className="rounded-xl border border-emerald-200 dark:border-emerald-900 bg-emerald-50 dark:bg-emerald-950 p-4 text-center">
              <Check className="h-8 w-8 text-emerald-600 mx-auto mb-2" />
              <p className="text-sm font-semibold text-emerald-800 dark:text-emerald-300">Password changed successfully</p>
              <p className="text-xs text-emerald-700/80 dark:text-emerald-400/80 mt-1">All your sessions were signed out for security.</p>
            </div>
            <Button className="w-full h-10 " onClick={() => { onOpenChange(false); logout() }}>
              Sign in again
            </Button>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="cur-pw" className="text-xs font-medium">Current password <span className="text-rose-500">*</span></Label>
              <Input id="cur-pw" type="password" autoComplete="current-password" value={current}
                onChange={(e) => setCurrent(e.target.value)} className="h-9" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="new-pw" className="text-xs font-medium">New password <span className="text-rose-500">*</span></Label>
              <Input id="new-pw" type="password" autoComplete="new-password" value={next}
                onChange={(e) => setNext(e.target.value)} className="h-9" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="confirm-pw" className="text-xs font-medium">Confirm new password <span className="text-rose-500">*</span></Label>
              <Input id="confirm-pw" type="password" autoComplete="new-password" value={confirm}
                onChange={(e) => setConfirm(e.target.value)} className="h-9"
                onKeyDown={(e) => { if (e.key === "Enter") submit() }} />
            </div>
            <ul className="rounded-lg bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 px-3 py-2 space-y-1">
              {hints.map((h) => (
                <li key={h} className="text-[11px] text-slate-500 flex items-center gap-1.5">
                  <span className={cn("h-1.5 w-1.5 rounded-full shrink-0", "bg-emerald-500")} /> {h}
                </li>
              ))}
            </ul>
            {error && <p className="text-sm text-rose-600 bg-rose-50 dark:bg-rose-950 rounded-md px-3 py-2">{error}</p>}
            <DialogFooter className="gap-2">
              <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
              <Button onClick={submit} disabled={busy}>
                {busy && <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />} Update password
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

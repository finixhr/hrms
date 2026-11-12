"use client"
// ============ My Account — passkeys card (code-split from settings/page.tsx) ============
// PRF-13 (P2 wave, 2026-11-09) — @simplewebauthn/browser left the settings
// page's first-load JS: the whole WebAuthn bundle (~30 KB) is only downloaded
// when the Account tab actually renders this card (next/dynamic, ssr off).
// WebAuthn passkey manager (Face ID / Touch ID / Windows Hello): mirrors the
// tenant-side SecurityPasskeysDialog against owner.passkey.*. Enrollment and
// management ONLY — owner sign-in stays password + TOTP (no
// owner.passkey.login.* by design). Biometrics never leave the device: the
// authenticator only asserts a signed user-verified flag.
import { useState } from "react"
import {
  AlertTriangle, Fingerprint, Loader2, Plus, Trash2,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { useOwnerApi, ownerRpc } from "@/saas/owner/client"
import { ErrorBanner } from "@/saas/owner/ui"
import { browserSupportsWebAuthn, startRegistration } from "@simplewebauthn/browser"

type OwnerPasskeyItem = {
  id: string
  deviceName: string
  backupEligible: boolean
  backupState: boolean
  lastUsedAt: string | null
  createdAt: string
}

const inputCls = "h-10 border-white/10 light:border-slate-200 bg-white/5 light:bg-slate-100 light:border-slate-300 light:bg-white light:text-slate-900"

export function MyAccountPasskeysCard() {
  const { data, loading, error, reload: reloadPasskeys } = useOwnerApi<{ items: OwnerPasskeyItem[] }>("owner.passkey.list", {})
  const [label, setLabel] = useState("")
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [removeTarget, setRemoveTarget] = useState<OwnerPasskeyItem | null>(null)
  const [removePw, setRemovePw] = useState("")
  // WebAuthn needs a secure context — hide the button (not the explanation)
  const supported = browserSupportsWebAuthn()

  if (loading) return <Card title="My Account — Passkeys"><p className="text-xs text-slate-500">Loading…</p></Card>
  if (error) return <Card title="My Account — Passkeys"><ErrorBanner message={error} /></Card>

  const items = data?.items || []

  const add = async () => {
    setErr(null); setBusy(true)
    try {
      const start = await ownerRpc<{ options: any }>("owner.passkey.register.start", {})
      // the OS/browser takes over: biometric or PIN prompt
      const attestation = await startRegistration({ optionsJSON: start.options })
      await ownerRpc("owner.passkey.register.finish", { name: label.trim() || undefined, attestation })
      setLabel(""); reloadPasskeys()
    } catch (e: any) { setErr(e?.message || "Passkey registration failed") } finally { setBusy(false) }
  }

  const remove = async () => {
    if (!removeTarget) return
    setErr(null); setBusy(true)
    try {
      await ownerRpc("owner.passkey.remove", { id: removeTarget.id, password: removePw })
      setRemoveTarget(null); setRemovePw(""); reloadPasskeys()
    } catch (e: any) { setErr(e?.message || "Could not remove the passkey") } finally { setBusy(false) }
  }

  return (
    <Card title="My Account — Passkeys (Biometric)">
      {err && <p className="rounded-lg border border-red-400/30 bg-red-500/10 p-2.5 text-xs text-red-300 light:text-red-600 light:border-red-300 light:bg-red-50 light:text-red-700">{err}</p>}
      {!supported && (
        <p className="rounded-lg border border-amber-400/30 bg-amber-500/10 p-2.5 text-[11px] leading-relaxed text-amber-200 light:text-amber-700 light:border-amber-300 light:bg-amber-50 light:text-amber-800">
          This browser (or the non-HTTPS connection) does not support passkeys — WebAuthn requires a modern browser over HTTPS.
        </p>
      )}
      {items.length === 0 ? (
        <p className="rounded-lg border border-white/10 light:border-slate-200 bg-white/[0.02] light:bg-slate-50 p-2.5 text-xs leading-relaxed text-slate-400 light:text-slate-600">
          No passkeys registered. A passkey lets a supported device prove it is you with Face&nbsp;ID / Touch&nbsp;ID / Windows&nbsp;Hello —
          an additional enrolled factor for this console account (sign-in stays password + authenticator code for now).
        </p>
      ) : (
        <ul className="space-y-2">
          {items.map((k) => (
            <li key={k.id} className="flex items-center gap-3 rounded-lg border border-white/10 light:border-slate-200 bg-white/[0.02] light:bg-slate-50 p-3">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-emerald-500 to-teal-600 text-white">
                <Fingerprint className="h-4.5 w-4.5" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs font-semibold text-slate-100 light:text-slate-800">{k.deviceName}</p>
                <p className="mt-0.5 text-[11px] text-slate-500">
                  {k.backupEligible ? (k.backupState ? "Synced passkey" : "Synced-capable") : "Device-bound"}
                  {" · "}added {new Date(k.createdAt).toLocaleDateString()}
                  {k.lastUsedAt ? ` · last used ${new Date(k.lastUsedAt).toLocaleDateString()}` : " · never used"}
                </p>
              </div>
              <Button size="sm" variant="outline" className="text-xs" disabled={busy || !!removeTarget}
                onClick={() => { setRemoveTarget(k); setRemovePw(""); setErr(null) }}>
                <Trash2 className="mr-1.5 h-3.5 w-3.5" /> Remove
              </Button>
            </li>
          ))}
        </ul>
      )}
      {removeTarget && (
        <div className="space-y-2 rounded-lg border border-red-400/30 bg-red-500/5 light:border-red-300 light:bg-red-50 p-3">
          <p className="flex items-center gap-1.5 text-xs font-semibold text-red-300 light:text-red-700">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0" /> Remove “{removeTarget.deviceName}”?
          </p>
          <F label="Account password (required)">
            <Input type="password" value={removePw} onChange={(e) => setRemovePw(e.target.value)} className={inputCls} autoComplete="current-password" />
          </F>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" className="text-xs" disabled={busy} onClick={() => { setRemoveTarget(null); setRemovePw(""); setErr(null) }}>Cancel</Button>
            <Button size="sm" className="bg-red-600 text-xs hover:bg-red-700" disabled={busy || !removePw} onClick={remove}>
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="mr-1.5 h-3.5 w-3.5" />} Remove passkey
            </Button>
          </div>
        </div>
      )}
      <F label="Device label (optional)">
        <Input value={label} maxLength={60} onChange={(e) => setLabel(e.target.value)} className={inputCls} placeholder="e.g. MacBook — Touch ID" disabled={busy} />
      </F>
      <Button size="sm" className="bg-emerald-600 text-xs hover:bg-emerald-700" disabled={busy || !supported} onClick={add}>
        {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="mr-1.5 h-3.5 w-3.5" />}
        {busy ? "Waiting for your device…" : "Add passkey"}
      </Button>
      <p className="text-[11px] leading-relaxed text-slate-500">
        Your biometrics never leave your device — the console only stores each passkey’s public key and a signature counter.
      </p>
    </Card>
  )
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-white/10 light:border-slate-200 bg-white/[0.03] light:bg-slate-100/60 p-5">
      <div className="flex items-center justify-between">
        <p className="text-sm font-bold text-white light:text-slate-900">{title}</p>
      </div>
      <div className="mt-4 space-y-3">{children}</div>
    </section>
  )
}
function F({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <Label className="text-xs text-slate-400 light:text-slate-600">{label}</Label>
      <div className="mt-1.5">{children}</div>
    </div>
  )
}

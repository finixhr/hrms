// ============ /owner/login — dedicated owner-plane sign-in ============
// Separate cookie, separate session table, separate lockout policy. A tenant
// user's credentials can never authenticate here (different plane entirely).
//
// Steps:
//   credentials → (mfaRequired) → TOTP / recovery code → console
//   credentials → (mfaEnrollmentRequired, platform policy) → scan QR →
//                 confirm code → save recovery codes → console
// 2026-10-04: dual-theme (owner_theme, dark default), password eye toggle,
// forgot-password link, and explicit input contrast (the dark-input bug fix).
"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import Link from "next/link"
import { Lock, ShieldCheck, Smartphone, ShieldAlert, Copy, ArrowLeft, AlertTriangle } from "lucide-react"
import { Button } from "@/components/ui/button"
import { ownerRpc } from "@/saas/owner/client"
import { OwnerAuthShell, OwnerAuthHeading, OwnerAlert, OwnerPasswordField, OwnerField, OwnerSubmit } from "@/saas/owner/auth-ui"
import { OwnerThemeSync } from "@/saas/owner/theme"

type Step = "credentials" | "mfa" | "enroll"

export default function OwnerLoginPage() {
  const router = useRouter()
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // ---- second-factor state ----
  const [step, setStep] = useState<Step>("credentials")
  const [challenge, setChallenge] = useState<{ token: string; who: string } | null>(null)
  const [code, setCode] = useState("")
  const [recoveryMode, setRecoveryMode] = useState(false)

  // ---- enrollment state ----
  const [qr, setQr] = useState("")
  const [secret, setSecret] = useState("")
  const [codes, setCodes] = useState<string[]>([])
  const [saved, setSaved] = useState(false)

  const enter = () => router.replace("/owner")

  // ---- step 1: password ----
  const submitCredentials = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    setBusy(true)
    try {
      const d = await ownerRpc<any>("owner.auth.login", { email, password })
      if (d.mfaRequired) {
        setChallenge({ token: d.mfaToken, who: email })
        setCode("")
        setRecoveryMode(false)
        setStep("mfa")
      } else if (d.mfaEnrollmentRequired) {
        setChallenge({ token: d.enrollToken, who: d.owner?.email || email })
        setCode("")
        setQr("")
        setSecret("")
        setCodes([])
        setSaved(false)
        setStep("enroll")
        void startEnroll(d.enrollToken)
      } else {
        enter()
      }
    } catch (err: any) {
      setError(err?.message || "Sign-in failed.")
    } finally {
      setBusy(false)
    }
  }

  // ---- step 2a: TOTP / recovery code ----
  const submitMfa = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!challenge) return
    setError(null)
    setBusy(true)
    try {
      await ownerRpc("owner.auth.login.mfa", {
        mfaToken: challenge.token,
        code,
        ...(recoveryMode ? { useRecovery: true } : {}),
      })
      enter()
    } catch (err: any) {
      setError(err?.message || "Verification failed.")
    } finally {
      setBusy(false)
    }
  }

  // ---- step 2b: forced first-login enrollment ----
  const startEnroll = async (token: string) => {
    try {
      const d = await ownerRpc<{ secret: string; qrDataUrl: string }>("owner.auth.mfa.enroll.start", { enrollToken: token })
      setQr(d.qrDataUrl)
      setSecret(d.secret)
    } catch (err: any) {
      setError(err?.message || "Could not start MFA enrollment.")
    }
  }

  const confirmEnroll = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!challenge) return
    setError(null)
    setBusy(true)
    try {
      const d = await ownerRpc<{ recoveryCodes: string[] }>("owner.auth.mfa.enroll.complete", {
        enrollToken: challenge.token,
        code,
      })
      setCodes(d.recoveryCodes || [])
    } catch (err: any) {
      setError(err?.message || "Enrollment failed.")
    } finally {
      setBusy(false)
    }
  }

  const backToCredentials = () => {
    setStep("credentials")
    setChallenge(null)
    setCode("")
    setError(null)
    setPassword("")
  }

  return (
    <>
      <OwnerThemeSync />
      <OwnerAuthShell
        footer={
          <p className="mt-4 text-center text-xs text-slate-500 light:text-slate-500">
            <Link href="/" className="hover:text-slate-300 light:hover:text-slate-700">← Back to the public website</Link>
          </p>
        }
      >
        {/* ============ STEP 1 — credentials ============ */}
        {step === "credentials" && (
          <>
            <OwnerAuthHeading title="Sign in to the console" sub="Platform owner credentials — tenant accounts never work here." />
            <form onSubmit={submitCredentials} className="mt-6 space-y-4">
              {error && <OwnerAlert kind="error">{error}</OwnerAlert>}
              <OwnerField id="oemail" label="Email" type="email" value={email} autoComplete="email"
                placeholder="owner@finixhr.local" onChange={setEmail} />
              <OwnerPasswordField id="opass" label="Password" value={password} onChange={setPassword} />
              <OwnerSubmit busy={busy}>Sign in <Lock className="ml-1 inline h-3.5 w-3.5" /></OwnerSubmit>
              <Link href="/owner/forgot-password"
                className="block text-center text-xs text-slate-500 transition-colors hover:text-slate-300 light:text-slate-500 light:hover:text-slate-800">
                Forgot password?
              </Link>
            </form>
            <p className="mt-6 flex items-start gap-2 text-[11px] leading-relaxed text-slate-500 light:text-slate-500">
              <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-400 light:text-emerald-600" />
              This console uses a separate session store, cookie and permission set from the HRM application.
            </p>
          </>
        )}

        {/* ============ STEP 2 — MFA verification ============ */}
        {step === "mfa" && (
          <>
            <div className="mt-7 flex items-center gap-3">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-blue-500 to-violet-500">
                <Smartphone className="h-5 w-5 text-white" />
              </span>
              <div className="min-w-0">
                <h1 className="text-[15px] font-bold text-white light:text-slate-900">Two-factor verification</h1>
                <p className="truncate text-xs text-slate-400 light:text-slate-600">{challenge?.who}</p>
              </div>
            </div>
            <p className="mt-4 text-xs leading-relaxed text-slate-400 light:text-slate-600">
              {recoveryMode
                ? "Enter one of your saved recovery codes — each works exactly once."
                : "Enter the 6-digit code from your authenticator app. Codes refresh every 30 seconds."}
            </p>
            <form onSubmit={submitMfa} className="mt-5 space-y-4">
              {error && <OwnerAlert kind="error">{error}</OwnerAlert>}
              <OwnerField
                id="mfa-code" label={recoveryMode ? "Recovery code" : "Verification code"}
                value={code} onChange={(v) => setCode(recoveryMode ? v.toLowerCase() : v.replace(/\D/g, "").slice(0, 6))}
                placeholder={recoveryMode ? "xxxx-xxxx-xxxx" : "••••••"} autoFocus mono
                autoComplete="one-time-code"
              />
              <OwnerSubmit busy={busy} disabled={code.length < 6}>Verify &amp; sign in</OwnerSubmit>
            </form>
            <div className="mt-4 space-y-2">
              <button type="button" onClick={() => { setRecoveryMode((v) => !v); setCode(""); setError(null) }}
                className="text-xs font-medium text-indigo-300 hover:underline light:text-indigo-600">
                {recoveryMode ? "Use a verification code instead" : "Lost your device? Use a recovery code"}
              </button>
              <div className="border-t border-white/10 pt-3 light:border-slate-200">
                <Button type="button" variant="ghost" size="sm" onClick={backToCredentials}
                  className="h-8 text-xs text-slate-500">
                  <ArrowLeft className="mr-1.5 h-3.5 w-3.5" /> Back to sign in
                </Button>
              </div>
            </div>
          </>
        )}

        {/* ============ STEP 2 — forced MFA enrollment ============ */}
        {step === "enroll" && (
          <>
            <div className="mt-7 flex items-center gap-3">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-blue-500 to-violet-500">
                <ShieldAlert className="h-5 w-5 text-white" />
              </span>
              <div className="min-w-0">
                <h1 className="text-[15px] font-bold text-white light:text-slate-900">Set up two-factor authentication</h1>
                <p className="truncate text-xs text-slate-400 light:text-slate-600">{challenge?.who} · required by platform policy</p>
              </div>
            </div>

            {codes.length > 0 ? (
              /* — recovery codes sub-step — */
              <>
                <div className="mt-5 flex gap-2 rounded-lg border border-amber-400/30 bg-amber-500/10 p-3 light:border-amber-300 light:bg-amber-50">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-400 light:text-amber-600" />
                  <p className="text-xs leading-relaxed text-amber-200 light:text-amber-800">
                    Save these recovery codes now — each works exactly once if you lose your device. They will never be shown again.
                  </p>
                </div>
                <ul className="mt-4 grid grid-cols-2 gap-1.5">
                  {codes.map((c) => (
                    <li key={c} className="select-all rounded border border-white/10 bg-white/5 px-2 py-1.5 text-center font-mono text-xs text-slate-200 light:border-slate-200 light:bg-slate-50 light:text-slate-800">{c}</li>
                  ))}
                </ul>
                <Button variant="outline" size="sm"
                  onClick={() => navigator.clipboard?.writeText(codes.join("\n")).catch(() => {})}
                  className="mt-3 h-8 w-full text-xs">
                  <Copy className="mr-1.5 h-3.5 w-3.5" /> Copy all codes
                </Button>
                <label className="mt-3 flex cursor-pointer items-center gap-2 text-xs text-slate-400 light:text-slate-600">
                  <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} className="h-3.5 w-3.5 accent-indigo-600" />
                  I have saved these codes somewhere safe
                </label>
                <div className="mt-4">
                  <OwnerSubmit busy={false} disabled={!saved} onClick={enter}>Continue to the console</OwnerSubmit>
                </div>
              </>
            ) : (
              /* — QR + code confirmation sub-step — */
              <>
                <p className="mt-4 text-xs leading-relaxed text-slate-400 light:text-slate-600">
                  Platform policy requires multi-factor authentication for owner accounts. Scan this QR code with Google
                  Authenticator, Microsoft Authenticator or any compatible app, then enter the 6-digit code it shows.
                </p>
                {qr ? (
                  <div className="mt-4 flex justify-center">
                    <img src={qr} alt="TOTP enrollment QR code" width={180} height={180}
                      className="rounded-lg border border-white/10 bg-white p-1 light:border-slate-200" />
                  </div>
                ) : (
                  <p className="mt-6 text-center text-xs text-slate-500">Preparing your authenticator code…</p>
                )}
                {secret && (
                  <p className="mt-3 break-all text-[11px] text-slate-500 light:text-slate-500">
                    Can&apos;t scan? Enter this key manually: <span className="select-all font-mono text-slate-300 light:text-slate-700">{secret}</span>
                  </p>
                )}
                <form onSubmit={confirmEnroll} className="mt-4 space-y-4">
                  {error && <OwnerAlert kind="error">{error}</OwnerAlert>}
                  <OwnerField id="enroll-code" label="6-digit verification code" value={code}
                    onChange={(v) => setCode(v.replace(/\D/g, "").slice(0, 6))} placeholder="••••••" autoFocus mono
                    autoComplete="one-time-code" />
                  <OwnerSubmit busy={busy} disabled={code.length < 6}>Enable &amp; sign in</OwnerSubmit>
                </form>
                <div className="mt-4 border-t border-white/10 pt-3 light:border-slate-200">
                  <Button type="button" variant="ghost" size="sm" onClick={backToCredentials}
                    className="h-8 text-xs text-slate-500">
                    <ArrowLeft className="mr-1.5 h-3.5 w-3.5" /> Back to sign in
                  </Button>
                </div>
              </>
            )}
          </>
        )}
      </OwnerAuthShell>
    </>
  )
}

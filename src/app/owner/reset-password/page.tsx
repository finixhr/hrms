// ============ /owner/reset-password — complete the emailed reset ============
// Reads ?token= from the URL (wrapped in Suspense — useSearchParams requires
// a boundary in App Router). On success every existing session for the
// account is burned server-side; the user signs in with the new password.
"use client"

import { Suspense, useState } from "react"
import Link from "next/link"
import { useSearchParams } from "next/navigation"
import { CheckCircle2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { ownerRpc } from "@/saas/owner/client"
import { OwnerAuthShell, OwnerAuthHeading, OwnerAlert, OwnerPasswordField, OwnerSubmit } from "@/saas/owner/auth-ui"
import { OwnerThemeSync } from "@/saas/owner/theme"

function ResetForm() {
  const params = useSearchParams()
  const token = params.get("token") || ""
  const [password, setPassword] = useState("")
  const [confirm, setConfirm] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    if (password !== confirm) {
      setError("The two passwords do not match.")
      return
    }
    setBusy(true)
    try {
      await ownerRpc("owner.auth.password.reset", { token, newPassword: password })
      setDone(true)
    } catch (err: any) {
      setError(err?.message || "Reset failed.")
    } finally {
      setBusy(false)
    }
  }

  if (!token) {
    return (
      <>
        <OwnerAuthHeading title="Invalid reset link" sub="This page needs a valid reset token from your email." />
        <div className="mt-6">
          <OwnerAlert kind="error">
            The reset link is incomplete or malformed. Request a fresh link from the forgot-password page.
          </OwnerAlert>
        </div>
        <Button variant="outline" className="mt-4 h-10 w-full text-xs" asChild>
          <Link href="/owner/forgot-password">Request a new reset link</Link>
        </Button>
      </>
    )
  }

  if (done) {
    return (
      <>
        <OwnerAuthHeading title="Password updated" />
        <div className="mt-6 flex gap-2 rounded-lg border border-emerald-400/30 bg-emerald-500/10 p-3 light:border-emerald-300 light:bg-emerald-50">
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400 light:text-emerald-600" />
          <p className="text-xs leading-relaxed text-emerald-200 light:text-emerald-700">
            Your password has been changed and every active console session for this account was signed out. Sign in
            with your new password to continue.
          </p>
        </div>
        <Button className="mt-4 h-11 w-full bg-gradient-to-r from-blue-600 to-violet-600 font-semibold text-white hover:from-blue-500 hover:to-violet-500" asChild>
          <Link href="/owner/login">Go to sign-in</Link>
        </Button>
      </>
    )
  }

  return (
    <>
      <OwnerAuthHeading
        title="Choose a new password"
        sub="Minimum 12 characters. Completing the reset signs out all active sessions."
      />
      <form onSubmit={submit} className="mt-6 space-y-4">
        {error && <OwnerAlert kind="error">{error}</OwnerAlert>}
        <OwnerPasswordField id="np" label="New password" value={password} onChange={setPassword}
          autoComplete="new-password" autoFocus />
        <OwnerPasswordField id="np2" label="Confirm new password" value={confirm} onChange={setConfirm}
          autoComplete="new-password" />
        <OwnerSubmit busy={busy} disabled={password.length < 12 || confirm.length < 12}>Set new password</OwnerSubmit>
      </form>
    </>
  )
}

export default function OwnerResetPasswordPage() {
  return (
    <>
      <OwnerThemeSync />
      <OwnerAuthShell
        footer={
          <p className="mt-4 text-center text-xs text-slate-500">
            <Link href="/owner/login" className="hover:text-slate-300 light:hover:text-slate-700">← Back to owner sign-in</Link>
          </p>
        }
      >
        <Suspense fallback={<p className="mt-6 text-center text-xs text-slate-500">Loading…</p>}>
          <ResetForm />
        </Suspense>
      </OwnerAuthShell>
    </>
  )
}

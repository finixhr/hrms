// ============ /owner/forgot-password — self-service reset request ============
// No session, no user enumeration: the API response is identical whether or
// not the email belongs to an owner account. With the platform email gateway
// configured the reset link is mailed; in dev without a gateway the link is
// echoed to the server console.
"use client"

import { useState } from "react"
import Link from "next/link"
import { MailCheck, ArrowLeft } from "lucide-react"
import { Button } from "@/components/ui/button"
import { ownerRpc } from "@/saas/owner/client"
import { OwnerAuthShell, OwnerAuthHeading, OwnerAlert, OwnerField, OwnerSubmit } from "@/saas/owner/auth-ui"
import { OwnerThemeSync } from "@/saas/owner/theme"

export default function OwnerForgotPasswordPage() {
  const [email, setEmail] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sent, setSent] = useState(false)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    setBusy(true)
    try {
      await ownerRpc("owner.auth.password.forgot", { email })
      setSent(true)
    } catch (err: any) {
      setError(err?.message || "Could not request a reset.")
    } finally {
      setBusy(false)
    }
  }

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
        <OwnerAuthHeading
          title="Reset your password"
          sub="Enter your owner account email — we'll send a single-use reset link (valid 60 minutes)."
        />
        {sent ? (
          <div className="mt-6 space-y-4">
            <div className="flex gap-2 rounded-lg border border-emerald-400/30 bg-emerald-500/10 p-3 light:border-emerald-300 light:bg-emerald-50">
              <MailCheck className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400 light:text-emerald-600" />
              <p className="text-xs leading-relaxed text-emerald-200 light:text-emerald-700">
                If that email belongs to an active owner account, a reset link is on its way. Didn&apos;t get it? Check
                spam, or ask a super admin to confirm the platform email gateway is configured (Settings → Platform
                Gateway). In a development environment without a gateway the link is printed on the server console.
              </p>
            </div>
            <Button variant="outline" className="h-10 w-full text-xs" onClick={() => setSent(false)}>
              Use a different email
            </Button>
          </div>
        ) : (
          <form onSubmit={submit} className="mt-6 space-y-4">
            {error && <OwnerAlert kind="error">{error}</OwnerAlert>}
            <OwnerField id="femail" label="Owner account email" type="email" value={email}
              onChange={setEmail} placeholder="owner@finixhr.local" autoFocus autoComplete="email" />
            <OwnerSubmit busy={busy}>Send reset link</OwnerSubmit>
            <Button type="button" variant="ghost" size="sm" className="h-8 w-full text-xs text-slate-500" asChild>
              <Link href="/owner/login"><ArrowLeft className="mr-1.5 h-3.5 w-3.5" /> Back to sign in</Link>
            </Button>
          </form>
        )}
        <p className="mt-6 flex items-start gap-2 text-[11px] leading-relaxed text-slate-500 light:text-slate-500">
          For security, reset links expire after 60 minutes and can be used once. Completing a reset signs out every
          active console session for the account.
        </p>
      </OwnerAuthShell>
    </>
  )
}

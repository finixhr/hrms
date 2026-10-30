"use client"
// ============ Login view — credentials → MFA enrollment / MFA / expired-password steps ============
// Handles all four auth.login outcomes (HRM-006/007 + H-1):
//   1. token                   → straight into the app (store.adoptSession)
//   2. mfaEnrollmentRequired   → H-1 first-login wizard: scan QR, confirm code
//                                (auth.mfa.enroll.start / .enable — capability-gated),
//                                save recovery codes, then the session is adopted
//   3. mfaRequired             → second card step: 6-digit TOTP (or recovery code)
//                                → auth.mfa.verify promotes to a full session
//                                → OR “Sign in with a passkey”: auth.passkey.login.
//                                start/finish verifies the WebAuthn assertion and
//                                mints the same full session (a passkey IS a second
//                                factor — biometric/user-verified possession)
//   4. passwordExpired         → second card step: set a new password via
//                                auth.password.change (pwToken flow), then sign in again.
import { useEffect, useState } from "react"
import {
  Store, Loader2, ShieldCheck, Users, Wallet, Clock, Smartphone, KeyRound,
  ArrowLeft, CheckCircle2, AlertTriangle, Mail, ShieldAlert, Copy, Eye, EyeOff, Globe, Fingerprint,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { useHrm } from "../store"
import { rpc } from "../api"
import { useI18n, setLang } from "../i18n"
import { FieldError } from "../shared/ui-kit"
import { fetchPasswordPolicy, policyHints, type PasswordPolicy } from "../security"
import { startAuthentication } from "@simplewebauthn/browser"


type Step = "credentials" | "enroll" | "mfa" | "expired" | "forgot"

export function LoginView() {
  const adoptSession = useHrm((s) => s.adoptSession)
  // Wave 4 (SG-D) — Bangla/English labels for the sign-in surface, driven by
  // the SAME preference store the app shell uses (localStorage "hrm_lang").
  const { lang, t } = useI18n()
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  // ---- MFA step state ----
  const [step, setStep] = useState<Step>("credentials")
  const [pending, setPending] = useState<{ token: string; user: { email?: string; name?: string }; mustChangePassword?: boolean } | null>(null)
  const [code, setCode] = useState("")
  const [recoveryMode, setRecoveryMode] = useState(false)
  const [forgotPhase, setForgotPhase] = useState<"request" | "reset">("request")
  const [resetCode, setResetCode] = useState("")

  // ---- expired-password step state ----
  const [newPassword, setNewPassword] = useState("")
  const [confirmPassword, setConfirmPassword] = useState("")
  const [policy, setPolicy] = useState<PasswordPolicy | null>(null)

  // ---- H-1 first-login MFA enrollment state ----
  const [enrollQr, setEnrollQr] = useState("")
  const [enrollSecret, setEnrollSecret] = useState("")
  const [enrollCodes, setEnrollCodes] = useState<string[]>([])
  const [enrollSaved, setEnrollSaved] = useState(false)
  const [enrollSession, setEnrollSession] = useState<{ token: string; user: any; vendor?: any; settings?: any } | null>(null)

  useEffect(() => {
    if ((step === "expired" || step === "forgot") && !policy) void fetchPasswordPolicy().then(setPolicy)
  }, [step, policy])

  const doLogin = async (e?: React.FormEvent, em?: string, pw?: string) => {
    e?.preventDefault()
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const d = await rpc<any>("auth.login", { email: em || email, password: pw || password })
      if (d?.mfaEnrollmentRequired && d.enrollToken) {
        // H-1 — the role requires MFA and this account never enrolled: no
        // session was issued. Swap to the first-login enrollment wizard.
        setPending({ token: d.enrollToken, user: d.user || {} })
        setCode("")
        setEnrollQr("")
        setEnrollSecret("")
        setEnrollCodes([])
        setEnrollSaved(false)
        setEnrollSession(null)
        setStep("enroll")
        void startEnrollment(d.enrollToken)
      } else if (d?.mfaRequired && d.mfaToken) {
        // second factor needed — swap this card to the TOTP step
        setPending({ token: d.mfaToken, user: d.user || {} })
        setCode("")
        setRecoveryMode(false)
        setStep("mfa")
      } else if (d?.passwordExpired && d.pwToken) {
        // forced password change before a session is issued (expiry OR a
        // temporary first-login password from auto-provisioned accounts)
        setPending({ token: d.pwToken, user: d.user || {}, mustChangePassword: !!d.mustChangePassword })
        setNewPassword("")
        setConfirmPassword("")
        setStep("expired")
      } else if (d?.token && d.user) {
        adoptSession(d)
        // HRM-006 — the role requires MFA but this account has not enrolled yet
        if (d.mfaEnrollSuggested) {
          setNotice("Your role now requires multi-factor authentication. After signing in, open the account menu (top right) and complete MFA enrolment under Security & MFA.")
        }
      } else {
        throw new Error("Unexpected sign-in response — please try again")
      }
    } catch (err: any) {
      setError(err.message || "Login failed")
    } finally {
      setBusy(false)
    }
  }

  // ---- H-1 first-login MFA enrollment: fetch provisioning (QR + secret)
  // with the PREAUTH enrollToken capability; then confirm a code; then show
  // the one-time recovery codes before entering the app.
  const startEnrollment = async (token: string) => {
    setError(null)
    try {
      const d = await rpc<any>("auth.mfa.enroll.start", { enrollToken: token })
      setEnrollQr(d.qrDataUrl || "")
      setEnrollSecret(d.secret || "")
    } catch (err: any) {
      setError(err.message || "Could not start MFA enrollment")
    }
  }

  const confirmEnrollment = async () => {
    if (!pending) return
    if (code.length < 6) { setError("Enter the 6-digit code from your authenticator app"); return }
    setBusy(true)
    setError(null)
    try {
      const d = await rpc<any>("auth.mfa.enroll.enable", { enrollToken: pending.token, code })
      if (d?.token && d.user) {
        // hold the full session payload (user+vendor+settings) until the
        // recovery codes are acknowledged — they are shown exactly once
        setEnrollCodes(d.recoveryCodes || [])
        setEnrollSession(d)
      } else {
        throw new Error("Enrollment could not be completed — please try again")
      }
    } catch (err: any) {
      setError(err.message || "Enrollment failed")
    } finally {
      setBusy(false)
    }
  }

  const finishEnrollment = () => {
    if (!enrollSession) return
    adoptSession(enrollSession)
  }

  // ---- MFA verify: promotes the short-lived pre-auth token to a full session
  // and stores it through the exact same path as a normal login (adoptSession).
  const verifyMfa = async () => {
    if (!pending || code.length < 6) { setError("Enter the 6-digit code from your authenticator app"); return }
    setBusy(true)
    setError(null)
    try {
      const d = await rpc<any>("auth.mfa.verify", {
        mfaToken: pending.token,
        code,
        ...(recoveryMode ? { useRecovery: true } : {}),
      })
      if (d?.token && d.user) adoptSession(d)
      else throw new Error("Verification could not be completed — please try again")
    } catch (err: any) {
      setError(err.message || "Verification failed")
    } finally {
      setBusy(false)
    }
  }

  // ---- Passkey sign-in: an ALTERNATIVE second step for accounts that have a
  // WebAuthn credential enrolled. login.start (public, email-bound) returns the
  // allow-list for THIS account; the browser runs the ceremony (Face ID /
  // Touch ID / Windows Hello); login.finish verifies the assertion server-side
  // and returns the SAME session payload auth.mfa.verify does → adoptSession.
  const passkeyLogin = async () => {
    if (!email) { setError("Enter your account email first"); return }
    setBusy(true)
    setError(null)
    try {
      const start = await rpc<any>("auth.passkey.login.start", { email })
      const options = start?.options
      if (!options || !Array.isArray(options.allowCredentials) || options.allowCredentials.length === 0) {
        throw new Error("No passkey is registered for this account. Sign in with your code, then add one from the account menu → Passkeys & Biometrics.")
      }
      const assertion = await startAuthentication({ optionsJSON: options })
      const d = await rpc<any>("auth.passkey.login.finish", { email, assertion })
      if (d?.token && d.user) adoptSession(d)
      else throw new Error("Passkey verification could not be completed — please try again")
    } catch (err: any) {
      setError(err?.message || "Passkey sign-in failed")
    } finally {
      setBusy(false)
    }
  }

  const changeExpiredPassword = async () => {
    if (!pending) return
    const pw = newPassword
    if (!pw || pw.length < (policy?.minLength || 8)) { setError(`New password must be at least ${policy?.minLength || 8} characters`); return }
    if (pw !== confirmPassword) { setError("New password and confirmation do not match"); return }
    setBusy(true)
    setError(null)
    try {
      await rpc("auth.password.change", { pwToken: pending.token, newPassword: pw })
      // no auto-login afterwards — the user re-enters the new credentials
      setStep("credentials")
      setPassword("")
      setPending(null)
      setNotice("Password updated — sign in with your new password.")
    } catch (err: any) {
      setError(err.message || "Password change failed")
    } finally {
      setBusy(false)
    }
  }

  // ---- Forgot password: request an emailed reset code, then set a new password
  const requestResetCode = async () => {
    if (!email) { setError("Enter your account email first"); return }
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const d = await rpc<any>("auth.forgotPassword", { email })
      setNotice(d?.hint || `If ${email} is registered, a reset code has been sent.`)
      setForgotPhase("reset")
      setResetCode("")
      setNewPassword("")
      setConfirmPassword("")
    } catch (err: any) {
      setError(err.message || "Could not request a reset code")
    } finally {
      setBusy(false)
    }
  }

  const performReset = async () => {
    if (!resetCode || resetCode.length < 6) { setError("Enter the reset code from the email"); return }
    if (!newPassword || newPassword.length < (policy?.minLength || 8)) { setError(`New password must be at least ${policy?.minLength || 8} characters`); return }
    if (newPassword !== confirmPassword) { setError("New password and confirmation do not match"); return }
    setBusy(true)
    setError(null)
    try {
      await rpc("auth.resetPassword", { email, code: resetCode, newPassword })
      setStep("credentials")
      setPassword("")
      setResetCode("")
      setForgotPhase("request")
      setNotice("Password updated — sign in with your new password.")
    } catch (err: any) {
      setError(err.message || "Reset failed")
    } finally {
      setBusy(false)
    }
  }

  const hints = policyHints(policy)

  return (
    <div className="min-h-screen bg-slate-950 flex items-center justify-center p-4 relative overflow-hidden">
      {/* ambient brand glow */}
      <div aria-hidden className="absolute inset-0 pointer-events-none"
        style={{ background: "radial-gradient(52rem 32rem at 18% 12%, rgba(5,150,105,0.16), transparent 60%), radial-gradient(40rem 30rem at 85% 90%, rgba(13,148,136,0.12), transparent 60%)" }} />
      <div className="w-full max-w-4xl grid lg:grid-cols-2 gap-8 items-center relative">
        {/* brand panel */}
        <div className="hidden lg:flex flex-col gap-6 text-white p-6">
          <div className="flex items-center gap-3">
            <div className="h-11 w-11 rounded-xl flex items-center justify-center shadow-lg"
              style={{ background: "linear-gradient(135deg, var(--hrm-accent, #34d399), var(--hrm-primary, #059669))" }}>
              <Store className="h-5 w-5 text-white" />
            </div>
            <div>
              <p className="text-xl font-bold leading-tight tracking-tight">Finix HR</p>
              <p className="text-[13px] text-emerald-300">HRM — Workforce Platform</p>
            </div>
          </div>
          <p className="text-slate-400 text-sm leading-relaxed max-w-md">
            One connected system: Employee Master → Organization → Shift → Attendance → Leave →
            Payroll → AIT → Loans → Performance → Exit → Accounting.
          </p>
          <div className="grid grid-cols-2 gap-3 max-w-md">
            {[
              [ShieldCheck, "Multi-tenant security", "Action-level permissions enforced server-side"],
              [Users, "Employee 360°", "One master record, immutable history"],
              [Wallet, "Payroll engine", "Runs, structures, payslips, accounting"],
              [Clock, "Attendance engine", "Biometric, ADMS push & geo-fence sources"],
            ].map(([Icon, t, d], i) => {
              const I = Icon as any
              return (
                <div key={i} className="rounded-xl bg-white/5 border border-white/10 p-3 backdrop-blur">
                  <I className="h-4 w-4 text-emerald-400 mb-1.5" />
                  <p className="text-xs font-semibold">{t as string}</p>
                  <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5 leading-snug">{d as string}</p>
                </div>
              )
            })}
          </div>
        </div>

        {/* login form card */}
        <div className="bg-white dark:bg-card rounded-2xl border border-slate-200/70 dark:border-white/10 hrm-shadow-lg p-6 sm:p-8 w-full max-w-md mx-auto">
          {/* Wave 4 (SG-D) — locale toggle (🌐 EN|বাং) wired to the shared i18n store */}
          <div className="flex justify-end mb-4">
            <button type="button"
              onClick={() => setLang(lang === "bn" ? "en" : "bn")}
              aria-label={lang === "bn" ? "Switch language to English" : "ভাষা বাংলায় পরিবর্তন করুন"}
              title="Language / ভাষা"
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 dark:border-slate-700 px-2.5 py-1 text-[11px] font-medium text-slate-500 dark:text-slate-400 hover:border-emerald-400 hover:text-emerald-700 dark:hover:border-emerald-600 dark:hover:text-emerald-300 transition-colors">
              <Globe className="h-3.5 w-3.5" aria-hidden />
              <span className={lang === "en" ? "font-semibold text-emerald-700 dark:text-emerald-400" : ""}>EN</span>
              <span aria-hidden className="text-slate-300 dark:text-slate-600">|</span>
              <span className={lang === "bn" ? "font-semibold text-emerald-700 dark:text-emerald-400" : ""}>বাং</span>
            </button>
          </div>
          <div className="lg:hidden flex items-center gap-2.5 mb-6">
            <div className="h-10 w-10 rounded-xl flex items-center justify-center shadow-md"
              style={{ background: "linear-gradient(135deg, var(--hrm-accent, #34d399), var(--hrm-primary, #059669))" }}>
              <Store className="h-5 w-5 text-white" />
            </div>
            <div>
              <p className="font-bold leading-tight">Finix HR</p>
              <p className="text-xs text-primary">HRM Workspace</p>
            </div>
          </div>

          {/* =============== STEP 1 — credentials =============== */}
          {step === "credentials" && (
            <>
              <h1 className="text-lg font-bold text-slate-900 dark:text-white">{t("Sign in to your workspace")}</h1>
              <p className="text-xs text-slate-500 mt-1 mb-5">{t("Use your vendor account credentials")}</p>

              {notice && (
                <p className="text-sm text-emerald-700 bg-emerald-50 dark:bg-emerald-950 rounded-md px-3 py-2 mb-4 flex items-center gap-2">
                  <CheckCircle2 className="h-4 w-4 shrink-0" /> {t(notice)}
                </p>
              )}

              <form onSubmit={doLogin} className="space-y-4">
                <div className="space-y-1.5">
                  <Label htmlFor="email" className="text-xs">{t("Email")}</Label>
                  <Input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" required className="h-10" />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="password" className="text-xs">{t("Password")}</Label>
                  <PasswordInput id="password" value={password} onChange={setPassword} placeholder="••••••••" autoComplete="current-password" />
                </div>
                {/* M-9 — announced to screen readers (role=alert) */}
              {error && <FieldError message={t(error)} />}
                <Button type="submit" disabled={busy} className="w-full h-10 font-semibold">
                  {busy && <Loader2 className="h-4 w-4 mr-2 animate-spin" />} {t("Sign in")}
                </Button>
                <button type="button" disabled={busy}
                  onClick={() => { setStep("forgot"); setForgotPhase("request"); setError(null); setNotice(null); setResetCode("") }}
                  className="w-full text-xs text-slate-500 hover:text-primary dark:text-slate-400 dark:hover:text-primary transition-colors">
                  {t("Forgot password?")}
                </button>
              </form>
              {/* SaaS layer — prospective customers land on the public website's
                  registration flow; existing users sign in here. */}
              <div className="mt-4 pt-4 border-t text-center">
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  New organization?{" "}
                  <a href="/register" className="font-semibold text-primary hover:underline underline-offset-4">
                    Register your organization
                  </a>
                </p>
                <p className="mt-1 text-[11px] text-slate-400">
                  Your application is reviewed by the platform team before your HR workspace is activated.
                </p>
              </div>
            </>
          )}

          {/* =============== STEP — forgot password =============== */}
          {step === "forgot" && (
            <>
              <h1 className="text-lg font-bold text-slate-900 dark:text-white">{t("Reset your password")}</h1>
              <p className="text-xs text-slate-500 mt-1 mb-5">
                {forgotPhase === "request"
                  ? "Enter your account email — we will send a one-time reset code."
                  : `Enter the code sent to ${email} and choose a new password.`}
              </p>

              {notice && (
                <p className="text-sm text-emerald-700 bg-emerald-50 dark:bg-emerald-950 rounded-md px-3 py-2 mb-4 flex items-start gap-2">
                  <Mail className="h-4 w-4 shrink-0 mt-0.5" /> {t(notice)}
                </p>
              )}

              <div className="space-y-4">
                {forgotPhase === "request" ? (
                  <div className="space-y-1.5">
                    <Label htmlFor="forgot-email" className="text-xs">{t("Account email")}</Label>
                    <Input id="forgot-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" className="h-10" />
                  </div>
                ) : (
                  <>
                    <div className="space-y-1.5">
                      <Label htmlFor="reset-code" className="text-xs">{t("Reset code")}</Label>
                      <Input id="reset-code" value={resetCode} onChange={(e) => setResetCode(e.target.value.toUpperCase())} placeholder="8-character code" className="h-10 font-mono tracking-widest" />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="new-password" className="text-xs">{t("New password")}</Label>
                      <PasswordInput id="new-password" value={newPassword} onChange={setNewPassword} placeholder="••••••••" autoComplete="new-password" />
                      {hints && <p className="text-[11px] text-slate-500 leading-snug">{hints}</p>}
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="confirm-password" className="text-xs">{t("Confirm new password")}</Label>
                      <PasswordInput id="confirm-password" value={confirmPassword} onChange={setConfirmPassword} placeholder="••••••••" autoComplete="new-password" />
                    </div>
                  </>
                )}
                {/* M-9 — announced to screen readers (role=alert) */}
              {error && <FieldError message={t(error)} />}
                <Button onClick={forgotPhase === "request" ? requestResetCode : performReset} disabled={busy}
                  className="w-full h-10 font-semibold">
                  {busy && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                  {forgotPhase === "request" ? t("Send reset code") : t("Set new password")}
                </Button>
                <div className="flex items-center justify-between gap-2">
                  <button type="button" onClick={() => { setStep("credentials"); setError(null); setNotice(null) }}
                    className="text-xs text-slate-500 hover:text-emerald-600 dark:text-slate-400 dark:hover:text-emerald-400">
                    ← {t("Back to sign in")}
                  </button>
                  {forgotPhase === "reset" && (
                    <button type="button" disabled={busy} onClick={() => { setForgotPhase("request"); setError(null) }}
                      className="text-xs text-slate-500 hover:text-emerald-600 dark:text-slate-400 dark:hover:text-emerald-400">
                      Resend / change email
                    </button>
                  )}
                </div>
              </div>
            </>
          )}

          {/* =============== STEP — H-1 first-login MFA enrollment =============== */}
          {step === "enroll" && (
            <>
              <div className="flex items-center gap-3 mb-4">
                <div className="h-11 w-11 rounded-xl bg-gradient-to-br from-emerald-500 to-teal-600 text-white flex items-center justify-center shrink-0 shadow-md">
                  <ShieldAlert className="h-5.5 w-5.5" />
                </div>
                <div className="min-w-0">
                  <h1 className="text-lg font-bold text-slate-900 dark:text-white leading-tight">Set up two-factor authentication</h1>
                  <p className="text-xs text-slate-500 truncate">
                    {pending?.user?.name ? `${pending.user.name} · ` : ""}{pending?.user?.email || email} · required by your role
                  </p>
                </div>
              </div>

              {enrollCodes.length > 0 ? (
                /* ---- sub-step: one-time recovery codes ---- */
                <>
                  <div className="rounded-lg bg-amber-50 dark:bg-amber-950 border border-amber-200 dark:border-amber-900 px-3 py-2 mb-4 flex gap-2">
                    <AlertTriangle className="h-4 w-4 text-amber-600 shrink-0 mt-0.5" />
                    <p className="text-xs text-amber-800 dark:text-amber-300 leading-relaxed">
                      Save these recovery codes now — each works exactly once if you lose your device. They will never be shown again.
                    </p>
                  </div>
                  <ul className="grid grid-cols-2 gap-1.5 mb-4">
                    {enrollCodes.map((c) => (
                      <li key={c} className="font-mono text-xs bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded px-2 py-1.5 text-center select-all">{c}</li>
                    ))}
                  </ul>
                  <Button onClick={() => navigator.clipboard?.writeText(enrollCodes.join("\n")).catch(() => {})} variant="outline" size="sm" className="w-full h-8 mb-3 text-xs">
                    <Copy className="h-3.5 w-3.5 mr-1.5" /> Copy all codes
                  </Button>
                  <Button onClick={finishEnrollment} disabled={!enrollSaved} className="w-full h-10 font-semibold">
                    I&apos;ve saved my codes — continue
                  </Button>
                  <label className="flex items-center gap-2 mt-3 text-xs text-slate-600 dark:text-slate-300 cursor-pointer">
                    <input type="checkbox" checked={enrollSaved} onChange={(e) => setEnrollSaved(e.target.checked)} className="h-3.5 w-3.5 accent-emerald-600" />
                    I have saved these codes somewhere safe
                  </label>
                </>
              ) : (
                /* ---- sub-step: QR + code confirmation ---- */
                <>
                  <p className="text-sm text-slate-600 dark:text-slate-300 mb-4">
                    Your role requires multi-factor authentication. Scan this QR code with Google Authenticator, Microsoft
                    Authenticator or any compatible app, then enter the 6-digit code it shows.
                  </p>
                  {enrollQr ? (
                    <div className="flex justify-center mb-3">
                      <img src={enrollQr} alt="TOTP enrollment QR code" width={180} height={180} className="rounded-lg border border-slate-200 dark:border-slate-800" />
                    </div>
                  ) : (
                    <div className="flex items-center justify-center gap-2 py-8 text-sm text-slate-500">
                      <Loader2 className="h-4 w-4 animate-spin" /> Preparing your authenticator code…
                    </div>
                  )}
                  {enrollSecret && (
                    <p className="text-[11px] text-slate-500 mb-4 break-all">
                      Can&apos;t scan? Enter this key manually: <span className="font-mono select-all">{enrollSecret}</span>
                    </p>
                  )}
                  <form onSubmit={(e) => { e.preventDefault(); confirmEnrollment() }} className="space-y-4">
                    <div className="space-y-1.5">
                      <Label htmlFor="enroll-code" className="text-xs sr-only">6-digit verification code</Label>
                      <Input
                        id="enroll-code" autoFocus inputMode="numeric" maxLength={6} autoComplete="one-time-code"
                        value={code}
                        onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
                        placeholder="••••••"
                        className="h-12 text-center text-xl tracking-[0.4em] font-mono tabular-nums"
                      />
                    </div>
                    {error && <FieldError message={error} />}
                    <Button type="submit" disabled={busy || code.length < 6} className="w-full h-10 font-semibold">
                      {busy && <Loader2 className="h-4 w-4 mr-2 animate-spin" />} Enable &amp; sign in
                    </Button>
                  </form>
                  <div className="mt-4 pt-2 border-t border-slate-100 dark:border-slate-800">
                    <Button type="button" variant="ghost" size="sm" disabled={busy}
                      onClick={() => { setStep("credentials"); setCode(""); setError(null); setPassword("") }}
                      className="text-xs text-slate-500 h-8">
                      <ArrowLeft className="h-3.5 w-3.5 mr-1.5" /> Back to sign in
                    </Button>
                  </div>
                </>
              )}
            </>
          )}

          {/* =============== STEP 2 — MFA verification =============== */}
          {step === "mfa" && (
            <>
              <div className="flex items-center gap-3 mb-4">
                <div className="h-11 w-11 rounded-xl bg-gradient-to-br from-emerald-500 to-teal-600 text-white flex items-center justify-center shrink-0 shadow-md">
                  <Smartphone className="h-5.5 w-5.5" />
                </div>
                <div className="min-w-0">
                  <h1 className="text-lg font-bold text-slate-900 dark:text-white leading-tight">Two-factor verification</h1>
                  <p className="text-xs text-slate-500 truncate">
                    {pending?.user?.name ? `${pending.user.name} · ` : ""}{pending?.user?.email || email}
                  </p>
                </div>
              </div>

              <p className="text-sm text-slate-600 dark:text-slate-300 mb-4">
                {recoveryMode
                  ? "Enter one of your saved recovery codes to sign in. Each code works exactly once."
                  : "Enter the 6-digit code from your authenticator app. Codes refresh automatically every 30 seconds."}
              </p>

              <form onSubmit={(e) => { e.preventDefault(); verifyMfa() }} className="space-y-4">
                <div className="space-y-1.5">
                  <Label htmlFor="mfa-code" className="text-xs sr-only">
                    {recoveryMode ? "Recovery code" : "6-digit verification code"}
                  </Label>
                  <Input
                    id="mfa-code" autoFocus inputMode={recoveryMode ? "text" : "numeric"}
                    maxLength={recoveryMode ? 20 : 6} autoComplete="one-time-code"
                    value={code}
                    onChange={(e) => setCode(recoveryMode
                      ? e.target.value.replace(/[^A-Za-z0-9-]/g, "").toLowerCase()
                      : e.target.value.replace(/\D/g, ""))}
                    placeholder={recoveryMode ? "xxxx-xxxx-xxxx" : "••••••"}
                    className="h-12 text-center text-xl tracking-[0.4em] font-mono tabular-nums"
                  />
                </div>
                {/* M-9 — announced to screen readers (role=alert) */}
              {error && <FieldError message={error} />}
                <Button type="submit" disabled={busy || code.length < 6} className="w-full h-10 font-semibold">
                  {busy && <Loader2 className="h-4 w-4 mr-2 animate-spin" />} Verify &amp; sign in
                </Button>
              </form>

              <div className="mt-4 space-y-2">
                <button type="button" onClick={() => { setRecoveryMode((v) => !v); setCode(""); setError(null) }}
                  className="text-xs text-emerald-700 dark:text-emerald-400 hover:underline font-medium">
                  {recoveryMode ? "Use a verification code instead" : "Lost your device? Use a recovery code"}
                </button>
                {/* passkey alternative for the second step — only useful when the
                    account has one enrolled; the handler explains when it doesn’t */}
                <Button type="button" variant="outline" size="sm" disabled={busy}
                  onClick={passkeyLogin}
                  className="w-full h-9 text-xs gap-1.5">
                  {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Fingerprint className="h-4 w-4" />}
                  Sign in with a passkey
                </Button>
                <div className="pt-2 border-t border-slate-100 dark:border-slate-800">
                  <Button type="button" variant="ghost" size="sm" disabled={busy}
                    onClick={() => { setStep("credentials"); setCode(""); setRecoveryMode(false); setError(null); setPassword("") }}
                    className="text-xs text-slate-500 h-8">
                    <ArrowLeft className="h-3.5 w-3.5 mr-1.5" /> Back to sign in
                  </Button>
                </div>
              </div>
            </>
          )}

          {/* =============== STEP 3 — expired / first-login password =============== */}
          {step === "expired" && (
            <>
              <div className="flex items-center gap-3 mb-4">
                <div className="h-11 w-11 rounded-xl bg-gradient-to-br from-amber-500 to-rose-600 text-white flex items-center justify-center shrink-0 shadow-md">
                  <KeyRound className="h-5.5 w-5.5" />
                </div>
                <div className="min-w-0">
                  <h1 className="text-lg font-bold text-slate-900 dark:text-white leading-tight">
                    {pending?.mustChangePassword ? "Welcome — set your new password" : "Your password has expired"}
                  </h1>
                  <p className="text-xs text-slate-500 truncate">
                    {pending?.user?.email || email} · set a new password to continue
                  </p>
                </div>
              </div>

              <div className="rounded-lg bg-amber-50 dark:bg-amber-950 border border-amber-200 dark:border-amber-900 px-3 py-2 mb-4 flex gap-2">
                <AlertTriangle className="h-4 w-4 text-amber-600 shrink-0 mt-0.5" />
                <p className="text-xs text-amber-800 dark:text-amber-300 leading-relaxed">
                  {pending?.mustChangePassword
                    ? "Your account was created with a temporary password. For security you must choose your own password before continuing — you cannot use the portal until it is changed."
                    : "Your vendor's password policy requires a new password. You'll sign in with the new password afterwards — for security there is no automatic sign-in."}
                </p>
              </div>

              <form onSubmit={(e) => { e.preventDefault(); changeExpiredPassword() }} className="space-y-4">
                <div className="space-y-1.5">
                  <Label htmlFor="new-pw" className="text-xs">New password <span className="text-rose-500">*</span></Label>
                  <PasswordInput id="new-pw" autoComplete="new-password" autoFocus value={newPassword}
                    onChange={setNewPassword} placeholder="••••••••" />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="confirm-pw" className="text-xs">Confirm new password <span className="text-rose-500">*</span></Label>
                  <PasswordInput id="confirm-pw" autoComplete="new-password" value={confirmPassword}
                    onChange={setConfirmPassword} placeholder="••••••••" />
                </div>
                <ul className="rounded-lg bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 px-3 py-2 space-y-1">
                  {hints.map((h) => (
                    <li key={h} className="text-[11px] text-slate-500 flex items-center gap-1.5">
                      <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 shrink-0" /> {h}
                    </li>
                  ))}
                </ul>
                {/* M-9 — announced to screen readers (role=alert) */}
              {error && <FieldError message={error} />}
                <Button type="submit" disabled={busy || !newPassword || !confirmPassword} className="w-full h-10 font-semibold">
                  {busy && <Loader2 className="h-4 w-4 mr-2 animate-spin" />} Update password
                </Button>
              </form>

              <div className="mt-4 pt-2 border-t border-slate-100 dark:border-slate-800">
                <Button type="button" variant="ghost" size="sm" disabled={busy}
                  onClick={() => { setStep("credentials"); setError(null); setNotice(null) }}
                  className="text-xs text-slate-500 h-8">
                  <ArrowLeft className="h-3.5 w-3.5 mr-1.5" /> Back to sign in
                </Button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

// ================= Password input with show/hide eye toggle =================
// Used by every password field on the sign-in card (credentials, forgot-reset,
// expired-password). The eye sits inside the field on the right; state is
// local per field so only the field you are looking at reveals.
function PasswordInput({
  id, value, onChange, placeholder, autoComplete, autoFocus,
}: {
  id: string
  value: string
  onChange: (v: string) => void
  placeholder?: string
  autoComplete?: string
  autoFocus?: boolean
}) {
  const [show, setShow] = useState(false)
  return (
    <div className="relative">
      <Input
        id={id}
        type={show ? "text" : "password"}
        value={value}
        required
        autoFocus={autoFocus}
        autoComplete={autoComplete}
        placeholder={placeholder || "••••••••"}
        onChange={(e) => onChange(e.target.value)}
        className="h-10 pr-10"
      />
      <button
        type="button"
        onClick={() => setShow((v) => !v)}
        aria-label={show ? "Hide password" : "Show password"}
        title={show ? "Hide password" : "Show password"}
        className="absolute inset-y-0 right-0 flex w-10 items-center justify-center text-slate-400 transition-colors hover:text-slate-700 dark:hover:text-slate-200"
      >
        {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
      </button>
    </div>
  )
}

"use client"
// ============ /register — prospective customer application form ============
// Submits to POST /api/saas (public.register). All validation mirrors the
// server's zod schema; the server is the authority — this is UX only.
//
// Validation UX (2026-10 round):
//   - field-level inline errors below each invalid input (red, role="alert")
//   - smooth auto-scroll to the FIRST invalid field (centered in the viewport
//     so the sticky site header never covers it) + automatic focus/select
//   - every invalid input carries aria-invalid + aria-describedby → its
//     error message id; the message itself is not color-only
//   - multiple simultaneous errors all render; only the first scrolls/focuses
//   - password + confirm password have independent eye visibility toggles
//   - the server additionally returns a fieldErrors map (mirroring its zod
//     issues) which is applied the same way after a rejected submission
import Link from "next/link"
<<<<<<< HEAD
import { cloneElement, useId, useMemo, useRef, useState, useCallback, type ReactElement, type FormEvent, type ComponentProps } from "react"
=======
import { cloneElement, useId, useMemo, useRef, useState, type ReactElement, type FormEvent, type ComponentProps } from "react"
>>>>>>> origin/main
import { useSearchParams } from "next/navigation"
import {
  ArrowRight, Building2, CheckCircle2, ChevronRight, Eye, EyeOff, Loader2, Lock, ShieldCheck, UserRound,
} from "lucide-react"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Checkbox } from "@/components/ui/checkbox"
import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { cn } from "@/lib/utils"
import type { PublicPlan } from "./pricing-cards"
// 2026-10 module-consistency round — the module wish-list is now the SAME
// REGISTRATION_MODULES constant the server validates against (single source
// of truth in src/hrm-server/saas/constants.ts). The old hand-duplicated
// 12-item client copy had already drifted (missing AIT, tasks, approvals,
// communication, HR letters, exit, calendar, reports…).
import { REGISTRATION_MODULES as MODULE_OPTIONS } from "@/hrm-server/saas/constants"

const ORG_TYPES = [
  { value: "PRIVATE_LTD", label: "Private Limited" },
  { value: "PLC", label: "Public Limited" },
  { value: "GOV", label: "Government" },
  { value: "NGO", label: "NGO / Non-profit" },
  { value: "PARTNERSHIP", label: "Partnership" },
  { value: "PROPRIETORSHIP", label: "Proprietorship" },
  { value: "OTHER", label: "Other" },
]

type FormState = {
  organizationName: string
  organizationType: string
  industry: string
  website: string
  address: string
  city: string
  country: string
  contactNumber: string
  officialEmail: string
  adminName: string
  adminDesignation: string
  adminEmail: string
  adminPhone: string
  password: string
  confirmPassword: string
  employeeCount: string
  branchCount: string
  deviceCount: string
  requiredModules: string[]
  planId: string
  billingCycle: "MONTHLY" | "YEARLY"
  agreedToTerms: boolean
}

const INITIAL: FormState = {
  organizationName: "", organizationType: "PRIVATE_LTD", industry: "", website: "",
  address: "", city: "", country: "Bangladesh", contactNumber: "", officialEmail: "",
  adminName: "", adminDesignation: "", adminEmail: "", adminPhone: "",
  password: "", confirmPassword: "",
  employeeCount: "50", branchCount: "1", deviceCount: "0",
  requiredModules: ["EMPLOYEES", "ATTENDANCE", "LEAVE", "ESS"] as string[],
  planId: "", billingCycle: "MONTHLY", agreedToTerms: false,
}

type FieldKey = keyof FormState
type FieldErrors = Partial<Record<FieldKey, string>>

// DOM order of the validatable fields — drives "scroll to the FIRST invalid".
const FIELD_ORDER: FieldKey[] = [
  "organizationName", "website", "contactNumber", "officialEmail",
  "adminName", "adminEmail", "adminPhone", "password", "confirmPassword",
  "employeeCount", "branchCount", "deviceCount", "agreedToTerms",
]

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const PHONE_RE = /^[+\d\s()-]*$/
const URL_RE = /^https?:\/\/.+/i

/** Client-side mirror of the server's zod schema — UX only, the server remains
 *  the authority. Returns one message per invalid field. */
function validateForm(f: FormState): FieldErrors {
  const e: FieldErrors = {}
  if (!f.organizationName.trim()) e.organizationName = "This field is required."
  else if (f.organizationName.trim().length < 2) e.organizationName = "Organization name is too short (min 2 characters)."
  else if (f.organizationName.trim().length > 120) e.organizationName = "Organization name is too long (max 120 characters)."

  if (f.website.trim() && !URL_RE.test(f.website.trim())) e.website = "Website must be a http(s) URL."

  if (f.contactNumber.trim() && !PHONE_RE.test(f.contactNumber.trim())) e.contactNumber = "Invalid phone number."

  if (!f.officialEmail.trim()) e.officialEmail = "This field is required."
  else if (!EMAIL_RE.test(f.officialEmail.trim())) e.officialEmail = "Enter a valid email address."
  else if (f.officialEmail.trim().length > 160) e.officialEmail = "Email is too long (max 160 characters)."

  if (!f.adminName.trim()) e.adminName = "This field is required."
  else if (f.adminName.trim().length < 2) e.adminName = "Name is too short (min 2 characters)."
  else if (f.adminName.trim().length > 120) e.adminName = "Name is too long (max 120 characters)."

  if (!f.adminEmail.trim()) e.adminEmail = "This field is required."
  else if (!EMAIL_RE.test(f.adminEmail.trim())) e.adminEmail = "Enter a valid email address."
  else if (f.adminEmail.trim().length > 160) e.adminEmail = "Email is too long (max 160 characters)."

  if (f.adminPhone.trim() && !PHONE_RE.test(f.adminPhone.trim())) e.adminPhone = "Invalid phone number."

  if (!f.password) e.password = "This field is required."
  else if (f.password.length < 10) e.password = "Password must be at least 10 characters."
  else if (f.password.length > 128) e.password = "Password is too long (max 128 characters)."
  else if (!/[A-Z]/.test(f.password) || !/[a-z]/.test(f.password) || !/\d/.test(f.password) || !/[^A-Za-z0-9]/.test(f.password)) {
    e.password = "Password needs upper & lower case letters, a digit and a symbol."
  }

  if (!f.confirmPassword) e.confirmPassword = "This field is required."
  else if (f.password && f.confirmPassword !== f.password) e.confirmPassword = "Passwords do not match."

  const emp = Number(f.employeeCount)
  if (f.employeeCount.trim() === "" || !Number.isFinite(emp) || emp < 0 || emp > 500000) {
    e.employeeCount = "Enter a number between 0 and 500000."
  }
  const br = Number(f.branchCount)
  if (f.branchCount.trim() === "" || !Number.isFinite(br) || br < 1 || br > 5000) {
    e.branchCount = "Enter a number between 1 and 5000."
  }
  const dev = Number(f.deviceCount)
  if (f.deviceCount.trim() === "" || !Number.isFinite(dev) || dev < 0 || dev > 5000) {
    e.deviceCount = "Enter a number between 0 and 5000."
  }

  if (!f.agreedToTerms) e.agreedToTerms = "You must accept the Terms of Service to continue."
  return e
}

export function RegisterForm({ plans, registrationEnabled, messageOnSubmit }: {
  plans: PublicPlan[]
  registrationEnabled: boolean
  messageOnSubmit: string
}) {
  const sp = useSearchParams()
  const [f, setF] = useState<FormState>({
    ...INITIAL,
    planId: sp.get("plan") || "",
    billingCycle: sp.get("cycle") === "YEARLY" ? "YEARLY" : "MONTHLY",
  })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({})
  const [done, setDone] = useState<{
    applicationNumber: string
    planName: string | null
    confirmationEmail: "SENT" | "SKIPPED" | "FAILED"
  } | null>(null)

  // live refs to every validatable input so we can scroll/focus after the
  // failed-submit re-render without waiting an effect tick
  const inputRefs = useRef<Partial<Record<FieldKey, HTMLElement | null>>>({})
<<<<<<< HEAD
  // useCallback keeps the factory stable across renders — every `ref={…}`
  // below receives a fresh-but-equivalent callback, which the React Compiler
  // can prove is a ref callback (not a render-time ref access)
  const setInputRef = useCallback(
    (key: FieldKey) => (el: HTMLElement | null) => {
      inputRefs.current[key] = el
    },
    [],
  )
=======
  const setInputRef = (key: FieldKey) => (el: any) => { inputRefs.current[key] = el }
>>>>>>> origin/main

  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => {
    setF((s) => ({ ...s, [k]: v }))
    // clear the field's error as soon as the user edits it again
    if (fieldErrors[k]) setFieldErrors((fe) => ({ ...fe, [k]: undefined }))
  }
  const toggleModule = (key: string) =>
    setF((s) => ({
      ...s,
      requiredModules: s.requiredModules.includes(key)
        ? s.requiredModules.filter((m) => m !== key)
        : [...s.requiredModules, key],
    }))

  const selectedPlan = useMemo(() => plans.find((p) => p.id === f.planId) || null, [plans, f.planId])

  /** Scroll the first invalid field into view (comfortably centered — never
   *  hidden under the sticky site header), then focus it and select its text
   *  so the user can correct it immediately. Returns the key or null. */
  const focusFirstInvalid = (errs: FieldErrors): FieldKey | null => {
    const first = FIELD_ORDER.find((k) => !!errs[k])
    if (!first) return null
    const el = inputRefs.current[first]
    if (el) {
      try { el.scrollIntoView({ behavior: "smooth", block: "center" }) } catch { /* older browsers */ }
      // preventScroll: scrollIntoView already positioned the field; a second
      // browser-driven scroll would fight the smooth animation
      window.setTimeout(() => {
        try { el.focus({ preventScroll: true }) } catch { /* not focusable */ }
        // highlight existing (wrong) text for quick correction — only for
        // single-line text-ish inputs; passwords/checkboxes/numbers keep caret
        const tag = (el as HTMLElement).tagName
        if (tag === "INPUT" && typeof (el as HTMLInputElement).select === "function") {
          const type = (el as HTMLInputElement).type
          if (["text", "email", "url", "tel"].includes(type) && (el as HTMLInputElement).value) {
            ;(el as HTMLInputElement).select()
          }
        }
      }, 350) // let the smooth scroll get underway before focusing
    }
    return first
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setError(null)
    // client-side pass first — mirrors the server zod schema exactly
    const errs = validateForm(f)
    if (Object.keys(errs).some((k) => errs[k as FieldKey])) {
      setFieldErrors(errs)
      const count = Object.values(errs).filter(Boolean).length
      setError(
        count === 1
          ? "One field needs your attention before submitting."
          : `${count} fields need your attention before submitting.`
      )
      focusFirstInvalid(errs)
      return
    }
    setFieldErrors({})
    setBusy(true)
    try {
      const res = await fetch("/api/saas", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "public.register",
          payload: {
            organizationName: f.organizationName,
            organizationType: f.organizationType,
            industry: f.industry || undefined,
            website: f.website || undefined,
            address: f.address || undefined,
            city: f.city || undefined,
            country: f.country,
            contactNumber: f.contactNumber || undefined,
            officialEmail: f.officialEmail,
            adminName: f.adminName,
            adminDesignation: f.adminDesignation || undefined,
            adminEmail: f.adminEmail,
            adminPhone: f.adminPhone || undefined,
            password: f.password,
            confirmPassword: f.confirmPassword,
            employeeCount: Number(f.employeeCount) || 0,
            branchCount: Math.max(1, Number(f.branchCount) || 1),
            deviceCount: Number(f.deviceCount) || 0,
            requiredModules: f.requiredModules,
            planId: f.planId || undefined,
            billingCycle: f.billingCycle,
            agreedToTerms: true,
            companyWebsiteField: "",
          },
        }),
      })
      const data = await res.json()
      if (!res.ok || !data.ok) {
        // server-side validation errors map onto the same inline UI
        const serverFieldErrors = (data.fieldErrors || {}) as FieldErrors
        if (Object.keys(serverFieldErrors).length > 0) {
          setFieldErrors(serverFieldErrors)
          focusFirstInvalid(serverFieldErrors)
        }
        throw new Error(data.error || "Registration failed. Please try again.")
      }
      setDone({
        applicationNumber: data.applicationNumber,
        planName: data.planName || selectedPlan?.name || null,
        confirmationEmail: data.confirmationEmail || "SKIPPED",
      })
      window.scrollTo({ top: 0, behavior: "smooth" })
    } catch (err: any) {
      setError(err?.message || "Registration failed. Please try again.")
    } finally {
      setBusy(false)
    }
  }

  // ---- success state ----
  if (done) {
    return (
      <div className="mx-auto max-w-2xl">
        <div className="rounded-2xl border border-emerald-400/30 bg-gradient-to-b from-emerald-500/10 to-transparent p-8 text-center">
          <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-emerald-500/15 ring-1 ring-emerald-400/40">
            <CheckCircle2 className="h-7 w-7 text-emerald-400" />
          </span>
          <h2 className="mt-5 text-2xl font-bold text-white light:text-slate-900">Registration submitted successfully</h2>
          <div className="mx-auto mt-6 max-w-md rounded-xl border border-white/10 bg-white/[0.03] p-4 light:border-slate-200 light:bg-white light:shadow-sm">
            <p className="text-xs uppercase tracking-widest text-slate-500">Your Application ID</p>
            <p className="mt-1 font-mono text-2xl font-bold tracking-wider text-emerald-300 light:text-emerald-700">{done.applicationNumber}</p>
          </div>
          <p className="mx-auto mt-6 max-w-lg text-sm leading-relaxed text-slate-400 light:text-slate-600">
            {messageOnSubmit} Your application is currently <span className="font-semibold text-white light:text-slate-900">pending review</span>.
            {done.planName && (<> You requested the <span className="font-semibold text-white light:text-slate-900">{done.planName}</span> plan.</>)}
          </p>
          {/* confirmation email status — honest reporting, never a hard failure */}
          <p className="mx-auto mt-3 max-w-lg text-xs leading-relaxed">
            {done.confirmationEmail === "SENT" ? (
              <span className="flex items-center justify-center gap-1.5 text-emerald-400 light:text-emerald-600">
                <CheckCircle2 className="h-3.5 w-3.5" aria-hidden /> A confirmation email with your Application ID and tracking
                link has been sent to <span className="font-semibold">{f.adminEmail}</span>.
              </span>
            ) : (
              <span className="flex items-center justify-center gap-1.5 text-amber-400 light:text-amber-600">
                <span aria-hidden>✉</span> Your application was received. A confirmation email could not be delivered
                {done.confirmationEmail === "SKIPPED" ? " (email gateway not configured)" : " (delivery failed)"} — please
                save your Application ID now; you can track your status anytime from this page.
              </span>
            )}
          </p>
          <div className="mt-6 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <Link href={`/registration-status?id=${done.applicationNumber}`} className="inline-flex h-11 items-center gap-2 rounded-xl bg-gradient-to-r from-blue-600 to-violet-600 px-6 text-sm font-semibold text-white">
              Track application status <ArrowRight className="h-4 w-4" />
            </Link>
            <Link href="/" className="inline-flex h-11 items-center rounded-xl border border-white/15 px-6 text-sm font-semibold text-white hover:bg-white/5 light:border-slate-300 light:text-slate-800 light:hover:bg-slate-100">
              Back to home
            </Link>
          </div>
          <p className="mt-6 text-xs text-slate-500">
            Keep your Application ID safe — together with your administrator email it&apos;s all you need to check the status.
          </p>
        </div>
      </div>
    )
  }

  // ---- closed state ----
  if (!registrationEnabled) {
    return (
      <div className="mx-auto max-w-xl rounded-2xl border border-white/10 bg-white/[0.03] p-8 text-center light:border-slate-200 light:bg-white light:shadow-sm">
        <h2 className="text-xl font-bold text-white light:text-slate-900">Registrations are currently closed</h2>
        <p className="mt-3 text-sm text-slate-400 light:text-slate-600">
          The platform operator has paused new applications. Please contact support to be notified when they re-open.
        </p>
      </div>
    )
  }

  const planMissing = plans.length > 0 && !f.planId

  return (
    <form onSubmit={submit} noValidate className="mx-auto max-w-3xl space-y-6">
      {error && (
        <div role="alert" className="rounded-xl border border-red-400/30 bg-red-500/10 p-4 text-sm text-red-300 light:border-red-400/40 light:bg-red-50 light:text-red-600">
          {error}
        </div>
      )}

      {/* ---- organization ---- */}
      <SectionCard step="1" icon={Building2} title="Organization information">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Company / organization name" required span error={fieldErrors.organizationName}>
            <TextInput
              ref={setInputRef("organizationName")}
              required value={f.organizationName} onChange={(e) => set("organizationName", e.target.value)}
              placeholder="ACME Apparel Ltd." invalid={!!fieldErrors.organizationName}
            />
          </Field>
          <Field label="Organization type">
            <Select value={f.organizationType} onValueChange={(v) => set("organizationType", v)}>
              <SelectTrigger className="h-10 bg-white/5 border-white/10 light:bg-white light:border-slate-300"><SelectValue /></SelectTrigger>
              <SelectContent>{ORG_TYPES.map((t) => <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>)}</SelectContent>
            </Select>
          </Field>
          <Field label="Industry">
            <TextInput value={f.industry} onChange={(e) => set("industry", e.target.value)} placeholder="Ready-made garments" />
          </Field>
          <Field label="Website" error={fieldErrors.website}>
            <TextInput
              ref={setInputRef("website")}
              type="url" value={f.website} onChange={(e) => set("website", e.target.value)}
              placeholder="https://example.com" invalid={!!fieldErrors.website}
            />
          </Field>
          <Field label="Address" span>
            <TextInput value={f.address} onChange={(e) => set("address", e.target.value)} placeholder="House 12, Road 5, Banani" />
          </Field>
          <Field label="City">
            <TextInput value={f.city} onChange={(e) => set("city", e.target.value)} placeholder="Dhaka" />
          </Field>
          <Field label="Country">
            <TextInput value={f.country} onChange={(e) => set("country", e.target.value)} />
          </Field>
          <Field label="Contact number" error={fieldErrors.contactNumber}>
            <TextInput
              ref={setInputRef("contactNumber")}
              value={f.contactNumber} onChange={(e) => set("contactNumber", e.target.value)}
              placeholder="+880 1XXX-XXXXXX" invalid={!!fieldErrors.contactNumber}
            />
          </Field>
          <Field label="Official email" required error={fieldErrors.officialEmail}>
            <TextInput
              ref={setInputRef("officialEmail")}
              required type="email" value={f.officialEmail} onChange={(e) => set("officialEmail", e.target.value)}
              placeholder="info@acme.com" invalid={!!fieldErrors.officialEmail}
            />
          </Field>
        </div>
      </SectionCard>

      {/* ---- administrator ---- */}
      <SectionCard step="2" icon={UserRound} title="Primary administrator">
        <p className="text-[13px] text-slate-400 light:text-slate-600">
          This person becomes the <span className="font-semibold text-white light:text-slate-900">Vendor Owner</span> of your workspace —
          they can invite the rest of the team after activation.
        </p>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <Field label="Full name" required error={fieldErrors.adminName}>
            <TextInput
              ref={setInputRef("adminName")}
              required value={f.adminName} onChange={(e) => set("adminName", e.target.value)}
              placeholder="Nusrat Akter" invalid={!!fieldErrors.adminName}
            />
          </Field>
          <Field label="Designation">
            <TextInput value={f.adminDesignation} onChange={(e) => set("adminDesignation", e.target.value)} placeholder="Head of HR" />
          </Field>
          <Field label="Email (this is the sign-in email)" required error={fieldErrors.adminEmail}>
            <TextInput
              ref={setInputRef("adminEmail")}
              required type="email" value={f.adminEmail} onChange={(e) => set("adminEmail", e.target.value)}
              placeholder="admin@acme.com" invalid={!!fieldErrors.adminEmail}
            />
          </Field>
          <Field label="Phone" error={fieldErrors.adminPhone}>
            <TextInput
              ref={setInputRef("adminPhone")}
              value={f.adminPhone} onChange={(e) => set("adminPhone", e.target.value)}
              placeholder="+880 1XXX-XXXXXX" invalid={!!fieldErrors.adminPhone}
            />
          </Field>
          <Field label="Password" required hint="Min 10 chars with upper, lower, digit and symbol." error={fieldErrors.password}>
            <PasswordInput
              ref={setInputRef("password")}
              required minLength={10} value={f.password} onChange={(e) => set("password", e.target.value)}
              invalid={!!fieldErrors.password}
            />
          </Field>
          <Field label="Confirm password" required error={fieldErrors.confirmPassword}>
            <PasswordInput
              ref={setInputRef("confirmPassword")}
              required minLength={10} value={f.confirmPassword} onChange={(e) => set("confirmPassword", e.target.value)}
              invalid={!!fieldErrors.confirmPassword}
            />
          </Field>
        </div>
        <p className="mt-4 flex items-start gap-2 rounded-lg border border-white/10 bg-white/[0.03] p-3 text-[12px] leading-relaxed text-slate-400 light:border-slate-200 light:bg-slate-50 light:text-slate-600">
          <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-400 light:text-emerald-600" />
          This password becomes your workspace sign-in when the application is approved. It is stored only as a
          scrypt hash — it can never be read back by anyone, including the platform team.
        </p>
      </SectionCard>

      {/* ---- scale ---- */}
      <SectionCard step="3" icon={ShieldCheck} title="Organization size & requirements">
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Approx. employees" required error={fieldErrors.employeeCount}>
            <TextInput
              ref={setInputRef("employeeCount")}
              required type="number" min={0} max={500000} value={f.employeeCount}
              onChange={(e) => set("employeeCount", e.target.value)} invalid={!!fieldErrors.employeeCount}
            />
          </Field>
          <Field label="Branches" required error={fieldErrors.branchCount}>
            <TextInput
              ref={setInputRef("branchCount")}
              required type="number" min={1} max={5000} value={f.branchCount}
              onChange={(e) => set("branchCount", e.target.value)} invalid={!!fieldErrors.branchCount}
            />
          </Field>
          <Field label="Attendance devices (ZKTeco)" required error={fieldErrors.deviceCount}>
            <TextInput
              ref={setInputRef("deviceCount")}
              required type="number" min={0} max={5000} value={f.deviceCount}
              onChange={(e) => set("deviceCount", e.target.value)} invalid={!!fieldErrors.deviceCount}
            />
          </Field>
        </div>
        <p className="mt-5 text-xs font-bold uppercase tracking-widest text-slate-500">Modules you&apos;re interested in</p>
        <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {MODULE_OPTIONS.map((m) => {
            const on = f.requiredModules.includes(m.key)
            return (
              <label key={m.key} className={cn(
                "flex cursor-pointer items-center gap-2.5 rounded-lg border p-3 text-[13px] transition-colors",
                on ? "border-emerald-400/40 bg-emerald-500/10 text-white light:border-emerald-500/60 light:bg-emerald-50 light:text-emerald-900" : "border-white/10 bg-white/[0.03] text-slate-400 hover:border-white/20 light:border-slate-200 light:bg-white light:text-slate-600 light:hover:border-slate-300"
              )}>
                <Checkbox checked={on} onCheckedChange={() => toggleModule(m.key)} className="data-[state=checked]:bg-emerald-500" />
                {m.label}
              </label>
            )
          })}
        </div>
        <p className="mt-3 text-xs text-slate-500">
          This is a wish list for the review team — the plan you choose below determines what is actually enabled.
        </p>
      </SectionCard>

      {/* ---- plan ---- */}
      <SectionCard step="4" icon={ChevronRight} title="Subscription preference">
        {plans.length === 0 ? (
          <p className="text-sm text-slate-400 light:text-slate-600">
            No plans are published yet — leave this to the review team; they will propose one during review.
          </p>
        ) : (
          <>
            <div className="grid gap-2 sm:grid-cols-2">
              {plans.map((p) => {
                const on = f.planId === p.id
                return (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => set("planId", p.id)}
                    className={cn(
                      "rounded-xl border p-4 text-left transition-colors",
                      on ? "border-indigo-400/60 bg-indigo-600/15 light:border-indigo-500 light:bg-indigo-50" : "border-white/10 bg-white/[0.03] hover:border-white/20 light:border-slate-200 light:bg-white light:hover:border-slate-300"
                    )}
                  >
                    <p className="text-sm font-bold text-white light:text-slate-900">
                      {p.name}
                      {p.badge && <span className="ml-2 rounded-full bg-gradient-to-r from-blue-600 to-violet-600 px-2 py-0.5 text-[9px] font-bold uppercase tracking-widest text-white">{p.badge}</span>}
                    </p>
                    <p className="mt-1 text-xs text-slate-400 light:text-slate-600">
                      {f.billingCycle === "YEARLY" ? "৳" : "৳"}{(f.billingCycle === "YEARLY" ? p.yearlyPrice : p.monthlyPrice).toLocaleString()}
                      {f.billingCycle === "YEARLY" ? "/yr" : "/mo"} · up to {p.limits.employeeLimit ? `${p.limits.employeeLimit.toLocaleString()} employees` : "unlimited employees"}
                    </p>
                  </button>
                )
              })}
            </div>
            <div className="mt-4 flex items-center gap-4">
              <span className="text-xs font-bold uppercase tracking-widest text-slate-500">Billing cycle</span>
              <div className="flex rounded-lg border border-white/10 p-1 light:border-slate-300">
                {(["MONTHLY", "YEARLY"] as const).map((c) => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => set("billingCycle", c)}
                    className={cn(
                      "rounded-md px-3 py-1 text-xs font-semibold transition-colors",
                      f.billingCycle === c ? "bg-white/10 text-white light:bg-slate-900" : "text-slate-400 hover:text-white light:text-slate-500 light:hover:text-slate-800"
                    )}
                  >
                    {c === "MONTHLY" ? "Monthly" : "Yearly"}
                  </button>
                ))}
              </div>
            </div>
          </>
        )}
      </SectionCard>

      {/* ---- terms + submit ---- */}
      <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-6 light:border-slate-200 light:bg-white light:shadow-sm">
        <label
          htmlFor="agree-terms"
          className="flex cursor-pointer items-start gap-3 text-[13px] leading-relaxed text-slate-300 light:text-slate-700"
        >
          <Checkbox
            id="agree-terms"
            ref={setInputRef("agreedToTerms")}
            required checked={f.agreedToTerms} onCheckedChange={(v) => set("agreedToTerms", v === true)}
            aria-invalid={!!fieldErrors.agreedToTerms}
            aria-describedby={fieldErrors.agreedToTerms ? "agree-terms-error" : undefined}
            className="mt-0.5 data-[state=checked]:bg-emerald-500"
          />
          <span>
            I confirm I am authorized to register this organization, and I agree to the{" "}
            <Link href="/legal/terms" className="text-indigo-300 hover:text-indigo-200 light:text-indigo-600 light:hover:text-indigo-500 underline-offset-4 hover:underline">Terms of Service</Link> and{" "}
            <Link href="/legal/privacy" className="text-indigo-300 hover:text-indigo-200 light:text-indigo-600 light:hover:text-indigo-500 underline-offset-4 hover:underline">Privacy Policy</Link>.
          </span>
        </label>
        {fieldErrors.agreedToTerms && (
          <p id="agree-terms-error" role="alert" className="mt-2 flex items-center gap-1.5 text-xs font-medium text-red-400 light:text-red-600">
            <span aria-hidden>⚠</span> {fieldErrors.agreedToTerms}
          </p>
        )}
        <Button
          type="submit"
          disabled={busy || !f.agreedToTerms || planMissing}
          className="mt-5 h-12 w-full bg-gradient-to-r from-blue-600 to-violet-600 text-[15px] font-semibold text-white shadow-xl shadow-indigo-950/50 hover:from-blue-500 hover:to-violet-500"
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <>Submit application <ArrowRight className="h-4 w-4" /></>}
        </Button>
        {planMissing && <p className="mt-2 text-center text-xs text-amber-400">Choose a plan to continue (or contact support if none fits).</p>}
        <p className="mt-4 text-center text-xs leading-relaxed text-slate-500">
          No payment information is collected here. A platform administrator reviews every application; you&apos;ll
          receive an Application ID immediately and can track the status anytime.
        </p>
      </div>
    </form>
  )
}

// ---- inputs (keep the exact existing visual language, add a11y hooks) ----

const INPUT_CLS = "h-10 bg-white/5 border-white/10 light:bg-white light:border-slate-300"

type TextInputProps = ComponentProps<"input"> & { invalid?: boolean }

/** Standard text input — Field injects id/aria-invalid/aria-describedby. */
const TextInput = ({ invalid, className, ...props }: TextInputProps) => (
  <Input
    {...props}
    className={cn(INPUT_CLS, invalid && "border-red-400/70 focus-visible:ring-red-400/40 light:border-red-400", className)}
  />
)

type PasswordInputProps = ComponentProps<"input"> & { invalid?: boolean }

/** Password input with an independent, keyboard-accessible eye toggle.
 *  Toggling visibility never clears or mutates the entered value. */
const PasswordInput = ({ invalid, value, ...props }: PasswordInputProps) => {
  const [visible, setVisible] = useState(false)
  return (
    <div className="relative">
      <Input
        {...props}
        value={value}
        type={visible ? "text" : "password"}
        className={cn(INPUT_CLS, "pr-11", invalid && "border-red-400/70 focus-visible:ring-red-400/40 light:border-red-400")}
      />
      <button
        type="button"
        onClick={() => setVisible((v) => !v)}
        aria-label={visible ? "Hide password" : "Show password"}
        aria-pressed={visible}
        title={visible ? "Hide password" : "Show password"}
        className="absolute inset-y-0 right-0 flex w-11 items-center justify-center rounded-r-md text-slate-400 transition-colors hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/60 light:text-slate-500 light:hover:text-slate-800"
      >
        {visible ? <EyeOff className="h-4 w-4" aria-hidden /> : <Eye className="h-4 w-4" aria-hidden />}
      </button>
    </div>
  )
}

function SectionCard({ step, icon: Icon, title, children }: { step: string; icon: any; title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-white/10 bg-white/[0.03] p-6 light:border-slate-200 light:bg-white light:shadow-sm">
      <div className="flex items-center gap-3">
        <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-blue-600 to-violet-600 text-xs font-bold text-white">
          {step}
        </span>
        <h2 className="text-lg font-bold text-white light:text-slate-900">{title}</h2>
        <Icon aria-hidden className="ml-auto h-4 w-4 text-slate-600" />
      </div>
      <div className="mt-5">{children}</div>
    </section>
  )
}

function Field({ label, required, hint, span, error, children }: {
  label: string; required?: boolean; hint?: string; span?: boolean; error?: string; children: ReactElement
}) {
  const fieldId = useId()
  const errId = `${fieldId}-err`
  // Inject a11y wiring into the single control child: stable id (label
  // association), aria-invalid and aria-describedby → the inline message.
  const control = cloneElement(children, {
    id: fieldId,
    ...(error ? { "aria-invalid": true, "aria-describedby": errId } : {}),
  } as any)
  return (
    // scroll-mt-28 keeps a scroll-targeted field clear of the sticky site header
    <div className={cn("scroll-mt-28", span && "sm:col-span-2")}>
      <Label htmlFor={fieldId} className="text-xs text-slate-400 light:text-slate-600">
        {label}{required && <span className="ml-0.5 text-rose-400">*</span>}
      </Label>
      <div className="mt-1.5">{control}</div>
      {hint && <p className="mt-1 text-[11px] text-slate-500">{hint}</p>}
      {error && (
        <p id={errId} role="alert" className="mt-1.5 flex items-center gap-1.5 text-xs font-medium text-red-400 light:text-red-600">
          {/* not color-only: warning glyph + role=alert + text */}
          <span aria-hidden>⚠</span> {error}
        </p>
      )}
    </div>
  )
}

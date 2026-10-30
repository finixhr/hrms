"use client"
// ============ /careers — openings board + online application form (client) ============
// The board renders the SERVER-filtered list of published openings (OPEN +
// isPublic + not past deadline — see page.tsx). Each card expands to the full
// description/requirements and the apply form.
//
// The apply form submits to POST /api/hrm { action: "recruitment.apply" } —
// the module's ONE public route (no session; the opening row decides the
// tenant). Client-side checks mirror the server's zod schema + CV validation
// (PDF/DOC/DOCX, 2 MB cap) purely for UX; the server is the authority.
//
// CSRF note: anonymous visitors have no session cookie, so the dispatcher's
// ambient-cookie CSRF layer does not apply. A visitor who happens to hold a
// live tenant session cookie (an HR user browsing the public site) WOULD trip
// it — so the form bootstraps the token the same way the SPA does after a
// reload: the CSRF-exempt auth.me introspection returns the session's token,
// which is then echoed in X-CSRF-Token.
import { useRef, useState } from "react"
import {
  Banknote, Briefcase, Building2, CalendarClock, CheckCircle2, ChevronDown, ChevronUp,
  FileUp, Loader2, MapPin, Send, Users,
} from "lucide-react"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { renderRichText } from "@/hrm/shared/rich-text-editor"

export type PublicOpening = {
  id: string
  title: string
  companyName: string
  branchName: string | null
  departmentName: string | null
  employmentType: string
  openings: number
  salaryRange: string | null
  deadline: string | null
  description: string | null
  requirements: string | null
}

// mirrors the server cap (routes/recruitment.ts MAX_CV_BYTES / uploads.ts)
const CV_MAX_BYTES = 2 * 1024 * 1024
const CV_EXTS = [".pdf", ".doc", ".docx"]

const EMPLOYMENT_TYPE_LABEL: Record<string, string> = {
  FULL_TIME: "Full Time",
  PART_TIME: "Part Time",
  CONTRACT: "Contract",
  INTERN: "Intern",
}

// deterministic formatting (identical on server and client render)
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
function fmtDeadline(iso: string | null): string | null {
  if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null
  const [y, m, d] = iso.split("-").map(Number)
  if (!y || !m || !d) return null
  return `${d} ${MONTHS[m - 1]} ${y}`
}

/** Read a File as pure base64 (no data-URL prefix). */
function readFileBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error("The CV file could not be read — please re-select it"))
    reader.onload = () => {
      const result = String(reader.result || "")
      resolve(result.replace(/^data:[^;]+;base64,/, ""))
    }
    reader.readAsDataURL(file)
  })
}

export function CareersBoard({ openings }: { openings: PublicOpening[] }) {
  const [expandedId, setExpandedId] = useState<string | null>(null)

  if (openings.length === 0) {
    return (
      <div className="mx-auto max-w-xl rounded-2xl border border-white/10 bg-white/[0.03] p-10 text-center light:border-slate-200 light:bg-white light:shadow-sm">
        <Briefcase className="mx-auto h-10 w-10 text-slate-500" aria-hidden />
        <h2 className="mt-4 text-lg font-bold text-white light:text-slate-900">No open positions right now</h2>
        <p className="mt-2 text-sm leading-relaxed text-slate-400 light:text-slate-600">
          Organizations publish new roles here as they open them — check back soon. Applications are only accepted for
          the live listings above, so there is nothing to submit at the moment.
        </p>
      </div>
    )
  }

  return (
    <div className="grid gap-4 md:grid-cols-2">
      {openings.map((o) => {
        const expanded = expandedId === o.id
        const deadline = fmtDeadline(o.deadline)
        return (
          <article
            key={o.id}
            className={`rounded-2xl border bg-white/[0.03] p-6 transition-all light:border-slate-200 light:bg-white light:shadow-sm ${expanded ? "border-indigo-400/40 md:col-span-2 light:border-indigo-500/50" : "border-white/10 hover:border-indigo-400/30 hover:bg-white/[0.05] light:hover:border-indigo-500/40"}`}
          >
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <h2 className="text-[17px] font-bold text-white light:text-slate-900">{o.title}</h2>
                <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-slate-400 light:text-slate-600">
                  <span className="inline-flex items-center gap-1"><Building2 className="h-3.5 w-3.5" aria-hidden /> {o.companyName}</span>
                  {o.branchName && <span className="inline-flex items-center gap-1"><MapPin className="h-3.5 w-3.5" aria-hidden /> {o.branchName}</span>}
                  {o.departmentName && <span>{o.departmentName}</span>}
                </p>
              </div>
              <span className="shrink-0 rounded-full border border-indigo-400/30 bg-indigo-400/10 px-3 py-1 text-[11px] font-bold uppercase tracking-wider text-indigo-300 light:border-indigo-500/30 light:bg-indigo-500/10 light:text-indigo-700">
                {EMPLOYMENT_TYPE_LABEL[o.employmentType] || o.employmentType}
              </span>
            </div>

            <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-2 text-[13px] text-slate-400 light:text-slate-600">
              {o.openings > 1 && (
                <span className="inline-flex items-center gap-1.5"><Users className="h-3.5 w-3.5" aria-hidden /> {o.openings} positions</span>
              )}
              {o.salaryRange && (
                <span className="inline-flex items-center gap-1.5"><Banknote className="h-3.5 w-3.5" aria-hidden /> {o.salaryRange}</span>
              )}
              {deadline && (
                <span className="inline-flex items-center gap-1.5"><CalendarClock className="h-3.5 w-3.5" aria-hidden /> Apply by {deadline}</span>
              )}
            </div>

            {o.description && !expanded && (
              <p className="mt-4 line-clamp-2 text-[13px] leading-relaxed text-slate-400 light:text-slate-600">{String(o.description).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim()}</p>
            )}

            <button
              type="button"
              onClick={() => setExpandedId(expanded ? null : o.id)}
              aria-expanded={expanded}
              className="mt-5 inline-flex h-10 items-center gap-2 rounded-xl bg-gradient-to-r from-blue-600 to-violet-600 px-5 text-sm font-semibold text-white shadow-lg shadow-indigo-950/40 hover:from-blue-500 hover:to-violet-500"
            >
              {expanded ? <>Hide details <ChevronUp className="h-4 w-4" /></> : <>View details &amp; apply <ChevronDown className="h-4 w-4" /></>}
            </button>

            {expanded && (
              <div className="mt-6 grid gap-6 border-t border-white/10 pt-6 light:border-slate-200 lg:grid-cols-5">
                <div className="space-y-5 lg:col-span-2">
                  {o.description && (
                    <div>
                      <p className="text-[11px] font-bold uppercase tracking-widest text-slate-500">Role description</p>
                      <div
                        className="mt-2 text-[13px] leading-relaxed text-slate-300 light:text-slate-600 careers-rich"
                        dangerouslySetInnerHTML={{ __html: renderRichText(o.description) }}
                      />
                    </div>
                  )}
                  {o.requirements && (
                    <div>
                      <p className="text-[11px] font-bold uppercase tracking-widest text-slate-500">Requirements</p>
                      <div
                        className="mt-2 text-[13px] leading-relaxed text-slate-300 light:text-slate-600 careers-rich"
                        dangerouslySetInnerHTML={{ __html: renderRichText(o.requirements) }}
                      />
                    </div>
                  )}
                  {!o.description && !o.requirements && (
                    <p className="text-[13px] text-slate-400 light:text-slate-600">No further details were provided — apply below and the hiring team will share more.</p>
                  )}
                </div>
                <div className="lg:col-span-3">
                  <ApplyForm opening={o} />
                </div>
              </div>
            )}
          </article>
        )
      })}
    </div>
  )
}

// ============================ APPLY FORM ============================

type FormState = {
  name: string
  email: string
  phone: string
  expectedSalary: string
  coverNote: string
}

export function ApplyForm({ opening }: { opening: PublicOpening }) {
  const [f, setF] = useState<FormState>({ name: "", email: "", phone: "", expectedSalary: "", coverNote: "" })
  const [cv, setCv] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [reference, setReference] = useState<string | null>(null)
  const cvInputRef = useRef<HTMLInputElement>(null)
  const honeypotRef = useRef<HTMLInputElement>(null)

  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setF((s) => ({ ...s, [k]: v }))

  const onPickCv = (file: File | null) => {
    setError(null)
    if (!file) { setCv(null); return }
    const name = file.name.toLowerCase()
    if (!CV_EXTS.some((ext) => name.endsWith(ext))) {
      setError("The CV must be a PDF, DOC or DOCX file")
      if (cvInputRef.current) cvInputRef.current.value = ""
      return
    }
    if (file.size > CV_MAX_BYTES) {
      setError(`The CV is too large — ${Math.round(file.size / 1024)} KB, the limit is ${Math.round(CV_MAX_BYTES / 1024)} KB`)
      if (cvInputRef.current) cvInputRef.current.value = ""
      return
    }
    setCv(file)
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    if (f.name.trim().length < 2) { setError("Please enter your full name"); return }
    if (f.email.trim() !== "" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.email.trim())) { setError("Please enter a valid email address"); return }
    if (f.coverNote.length > 2000) { setError("The cover note must stay under 2000 characters"); return }
    setBusy(true)
    try {
      let cvBase64: string | undefined
      if (cv) cvBase64 = await readFileBase64(cv)
      // CSRF bootstrap for visitors who happen to hold a live session cookie:
      // auth.me is the dispatcher's CSRF-exempt introspection and returns the
      // token the apply call must then echo (see the SPA's api.ts saveCsrfToken)
      let csrfToken: string | null = null
      try {
        const me = await fetch("/api/hrm", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "auth.me" }),
        })
        const meJson = await me.json()
        if (meJson?.ok && typeof meJson?.data?.csrfToken === "string") csrfToken = meJson.data.csrfToken
      } catch { /* anonymous — no session, no CSRF requirement */ }
      const res = await fetch("/api/hrm", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(csrfToken ? { "X-CSRF-Token": csrfToken } : {}),
        },
        body: JSON.stringify({
          action: "recruitment.apply",
          payload: {
            openingId: opening.id,
            name: f.name.trim(),
            email: f.email.trim() || undefined,
            phone: f.phone.trim() || undefined,
            expectedSalary: f.expectedSalary.trim() === "" ? undefined : Number(f.expectedSalary.trim()),
            coverNote: f.coverNote.trim() || undefined,
            ...(cv ? { cvFileName: cv.name, cvBase64 } : {}),
            // honeypot — humans never see or fill this field
            honeypot: honeypotRef.current?.value || "",
          },
        }),
      })
      const data = await res.json()
      if (!res.ok || !data.ok) throw new Error(data.error || "Your application could not be submitted — please try again.")
      setReference(String(data.reference || "APP"))
    } catch (err: any) {
      setError(err?.message || "Your application could not be submitted — please try again.")
    } finally {
      setBusy(false)
    }
  }

  if (reference) {
    return (
      <div className="rounded-2xl border border-emerald-400/30 bg-gradient-to-b from-emerald-500/10 to-transparent p-8 text-center light:border-emerald-500/50 light:shadow-sm">
        <CheckCircle2 className="mx-auto h-12 w-12 text-emerald-400 light:text-emerald-600" aria-hidden />
        <h3 className="mt-4 text-lg font-bold text-white light:text-slate-900">Application received</h3>
        <p className="mt-2 text-sm leading-relaxed text-slate-400 light:text-slate-600">
          Your application for <strong className="text-white light:text-slate-900">{opening.title}</strong> at{" "}
          <strong className="text-white light:text-slate-900">{opening.companyName}</strong> is with the hiring team.
          Reference <span className="font-mono font-semibold text-emerald-300 light:text-emerald-700">{reference}</span> — keep it for your records.
        </p>
      </div>
    )
  }

  const inputCls = "mt-1.5 h-10 bg-white/5 border-white/10 light:bg-white light:border-slate-300"

  return (
    <form onSubmit={submit} className="rounded-2xl border border-white/10 bg-white/[0.03] p-6 light:border-slate-200 light:bg-white light:shadow-sm" aria-label={`Apply for ${opening.title}`}>
      <p className="text-[11px] font-bold uppercase tracking-widest text-slate-500">Apply for this position</p>
      {error && (
        <p role="alert" className="mt-3 rounded-lg border border-red-400/30 bg-red-500/10 p-3 text-sm text-red-300 light:border-red-400/40 light:bg-red-50 light:text-red-600">
          {error}
        </p>
      )}

      {/* honeypot — invisible to humans, irresistible to bots. Any value means
          "bot": the server silently pretends success and stores nothing. */}
      <input
        ref={honeypotRef}
        type="text"
        name="websiteUrl"
        tabIndex={-1}
        autoComplete="off"
        aria-hidden="true"
        className="pointer-events-none absolute -left-[9999px] h-px w-px opacity-0"
      />

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <div>
          <Label htmlFor={`apply-name-${opening.id}`} className="text-xs text-slate-400 light:text-slate-600">
            Full name <span className="text-rose-400 light:text-rose-600">*</span>
          </Label>
          <Input id={`apply-name-${opening.id}`} required minLength={2} maxLength={100} value={f.name}
            onChange={(e) => set("name", e.target.value)} className={inputCls} autoComplete="name" />
        </div>
        <div>
          <Label htmlFor={`apply-email-${opening.id}`} className="text-xs text-slate-400 light:text-slate-600">Email</Label>
          <Input id={`apply-email-${opening.id}`} type="email" maxLength={160} value={f.email}
            onChange={(e) => set("email", e.target.value)} className={inputCls} autoComplete="email"
            placeholder="you@email.com" />
        </div>
        <div>
          <Label htmlFor={`apply-phone-${opening.id}`} className="text-xs text-slate-400 light:text-slate-600">Phone</Label>
          <Input id={`apply-phone-${opening.id}`} type="tel" maxLength={24} value={f.phone}
            onChange={(e) => set("phone", e.target.value)} className={inputCls} autoComplete="tel"
            placeholder="01XXXXXXXXX" />
        </div>
        <div>
          <Label htmlFor={`apply-salary-${opening.id}`} className="text-xs text-slate-400 light:text-slate-600">Expected salary (৳)</Label>
          <Input id={`apply-salary-${opening.id}`} type="number" min={0} value={f.expectedSalary}
            onChange={(e) => set("expectedSalary", e.target.value)} className={inputCls}
            placeholder="Optional" />
        </div>
      </div>

      <div className="mt-4">
        <Label htmlFor={`apply-note-${opening.id}`} className="text-xs text-slate-400 light:text-slate-600">Cover note</Label>
        <Textarea id={`apply-note-${opening.id}`} rows={4} maxLength={2000} value={f.coverNote}
          onChange={(e) => set("coverNote", e.target.value)}
          className="mt-1.5 bg-white/5 border-white/10 light:bg-white light:border-slate-300"
          placeholder="Why you, why this role — keep it brief (max 2000 characters)" />
      </div>

      <div className="mt-4">
        <Label className="text-xs text-slate-400 light:text-slate-600">Curriculum Vitae</Label>
        <div className="mt-1.5 flex flex-wrap items-center gap-3">
          <label className="inline-flex h-10 cursor-pointer items-center gap-2 rounded-xl border border-white/15 px-4 text-sm font-medium text-slate-200 transition-colors hover:bg-white/5 light:border-slate-300 light:text-slate-800 light:hover:bg-slate-100">
            <FileUp className="h-4 w-4" aria-hidden />
            {cv ? "Change CV" : "Attach CV"}
            <input
              ref={cvInputRef}
              type="file"
              accept=".pdf,.doc,.docx,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
              className="hidden"
              onChange={(e) => {
                onPickCv(e.target.files?.[0] || null)
                e.target.value = "" // allow re-picking the same file after an error
              }}
            />
          </label>
          {cv && <span className="max-w-[240px] truncate text-xs text-emerald-300 light:text-emerald-700" title={cv.name}>{cv.name} · {Math.round(cv.size / 1024)} KB</span>}
        </div>
        <p className="mt-1.5 text-[11px] text-slate-500">PDF, DOC or DOCX — maximum 2 MB. Optional but strongly recommended.</p>
      </div>

      <Button type="submit" disabled={busy} className="mt-5 h-11 w-full bg-gradient-to-r from-blue-600 to-violet-600 font-semibold text-white hover:from-blue-500 hover:to-violet-500">
        {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-label="Submitting" /> : <>Submit application <Send className="h-4 w-4" /></>}
      </Button>
      <p className="mt-3 text-center text-xs text-slate-500">
        Your details are shared only with the hiring team at {opening.companyName} — the organization that published this opening.
      </p>
    </form>
  )
}

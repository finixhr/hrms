"use client"
// ============ /registration-status — application tracker (public) ============
import { useEffect, useState } from "react"
import { useSearchParams } from "next/navigation"
import Link from "next/link"
import { CalendarClock, ChevronRight, Loader2 } from "lucide-react"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

type StatusResult = {
  applicationNumber: string
  organizationName: string
  status: string
  submittedAt: string
  reviewedAt: string | null
  planName: string | null
  billingCycle: string
  requestedEmployees: number
  requestedBranches: number
  requestedDevices: number
  reviewNote: string | null
  nextStep: string
}

const STATUS_TONE: Record<string, string> = {
  PENDING: "border-amber-400/40 bg-amber-500/10 text-amber-300 light:border-amber-500/50 light:bg-amber-50 light:text-amber-700",
  UNDER_REVIEW: "border-blue-400/40 bg-blue-500/10 text-blue-300 light:border-blue-500/50 light:bg-blue-50 light:text-blue-700",
  APPROVED: "border-emerald-400/40 bg-emerald-500/10 text-emerald-300 light:border-emerald-500/50 light:bg-emerald-50 light:text-emerald-700",
  REJECTED: "border-red-400/40 bg-red-500/10 text-red-300 light:border-red-500/50 light:bg-red-50 light:text-red-700",
  SUSPENDED: "border-red-400/40 bg-red-500/10 text-red-300 light:border-red-500/50 light:bg-red-50 light:text-red-700",
  CANCELLED: "border-slate-400/40 bg-slate-500/10 text-slate-300 light:border-slate-400 light:bg-slate-100 light:text-slate-700",
}

export function StatusForm() {
  const sp = useSearchParams()
  const [applicationNumber, setApplicationNumber] = useState(sp.get("id") || "")
  const [email, setEmail] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<StatusResult | null>(null)

  const lookup = async (e?: React.FormEvent) => {
    e?.preventDefault()
    setError(null)
    setResult(null)
    if (!applicationNumber || !email) return
    setBusy(true)
    try {
      const res = await fetch("/api/saas", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "public.registrationStatus",
          payload: { applicationNumber: applicationNumber.trim().toUpperCase(), email: email.trim() },
        }),
      })
      const data = await res.json()
      if (!res.ok || !data.ok) throw new Error(data.error || "Lookup failed.")
      setResult(data as StatusResult)
    } catch (err: any) {
      setError(err?.message || "Lookup failed. Please try again.")
    } finally {
      setBusy(false)
    }
  }

  // auto-lookup when arriving from the register success page with ?id=
  useEffect(() => {
    const id = sp.get("id")
    if (id && !result && !busy && !error) {
      // wait for email input — never auto-submit with an empty email
    }
  }, [sp, result, busy, error])

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <form onSubmit={lookup} className="rounded-2xl border border-white/10 bg-white/[0.03] p-6 light:border-slate-200 light:bg-white light:shadow-sm">
        <div className="grid gap-4">
          <div>
            <Label htmlFor="appid" className="text-xs text-slate-400 light:text-slate-600">Application ID <span className="text-rose-400 light:text-rose-600">*</span></Label>
            <Input
              id="appid"
              required
              value={applicationNumber}
              onChange={(e) => setApplicationNumber(e.target.value)}
              placeholder="HRM-2026-000123"
              className="mt-1.5 h-10 bg-white/5 border-white/10 font-mono light:bg-white light:border-slate-300"
            />
          </div>
          <div>
            <Label htmlFor="appemail" className="text-xs text-slate-400 light:text-slate-600">Administrator or official email <span className="text-rose-400 light:text-rose-600">*</span></Label>
            <Input
              id="appemail"
              required
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="admin@acme.com"
              className="mt-1.5 h-10 bg-white/5 border-white/10 light:bg-white light:border-slate-300"
            />
          </div>
        </div>
        <Button type="submit" disabled={busy} className="mt-5 h-11 w-full bg-gradient-to-r from-blue-600 to-violet-600 font-semibold text-white hover:from-blue-500 hover:to-violet-500">
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <>Check status <ChevronRight className="h-4 w-4" /></>}
        </Button>
        {error && <p role="alert" className="mt-3 text-sm text-red-300 light:text-red-600">{error}</p>}
      </form>

      {result && (
        <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-6 light:border-slate-200 light:bg-white light:shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="font-mono text-sm font-bold text-white light:text-slate-900">{result.applicationNumber}</p>
              <p className="mt-0.5 text-[13px] text-slate-400 light:text-slate-600">{result.organizationName}</p>
            </div>
            <span className={cn("rounded-full border px-3 py-1 text-[11px] font-bold uppercase tracking-widest", STATUS_TONE[result.status] || STATUS_TONE.PENDING)}>
              {result.status.replace("_", " ")}
            </span>
          </div>

          <dl className="mt-6 grid gap-3 sm:grid-cols-2">
            <Row k="Submitted" v={new Date(result.submittedAt).toLocaleDateString()} />
            <Row k="Reviewed" v={result.reviewedAt ? new Date(result.reviewedAt).toLocaleDateString() : "—"} />
            <Row k="Requested plan" v={result.planName ? `${result.planName} (${result.billingCycle.toLowerCase()})` : "—"} />
            <Row k="Requested capacity" v={`${result.requestedEmployees} employees · ${result.requestedBranches} branches · ${result.requestedDevices} devices`} />
          </dl>

          {result.reviewNote && (
            <p className="mt-4 rounded-lg border border-white/10 bg-white/[0.03] p-3 text-[13px] leading-relaxed text-slate-300 light:border-slate-200 light:bg-slate-50 light:text-slate-700">
              <span className="font-semibold text-white light:text-slate-900">Note from the review team: </span>
              {result.reviewNote}
            </p>
          )}

          <p className="mt-5 flex items-start gap-2.5 rounded-lg border border-indigo-400/25 bg-indigo-500/10 p-4 text-[13px] leading-relaxed text-indigo-200 light:border-indigo-500/30 light:bg-indigo-50 light:text-indigo-800">
            <CalendarClock className="mt-0.5 h-4 w-4 shrink-0" />
            {result.nextStep}
          </p>

          {result.status === "APPROVED" && (
            <Link href="/login" className="mt-4 inline-flex h-10 items-center gap-2 rounded-xl bg-gradient-to-r from-blue-600 to-violet-600 px-5 text-sm font-semibold text-white">
              Go to sign in <ChevronRight className="h-4 w-4" />
            </Link>
          )}
        </div>
      )}

      <p className="text-center text-xs text-slate-500">
        Lost your Application ID? Contact the platform support team with your organization name and administrator email.
      </p>
    </div>
  )
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="rounded-lg border border-white/10 bg-white/[0.02] p-3 light:border-slate-200 light:bg-slate-50">
      <dt className="text-[10px] font-bold uppercase tracking-widest text-slate-500">{k}</dt>
      <dd className="mt-1 text-[13px] font-medium text-slate-200 light:text-slate-800">{v}</dd>
    </div>
  )
}

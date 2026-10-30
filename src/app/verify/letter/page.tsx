"use client"
// LTR-02 (R7) — public letter verification page. No account required: a
// third party (typically a bank) enters the code printed on an issued HR
// letter and gets the letter's verifiable facts.
import { useState } from "react"

type Result = {
  valid: boolean
  error?: string
  company?: string
  letterNumber?: string
  employeeName?: string
  employeeCode?: string | null
  type?: string
  issuedAt?: string
}

export default function LetterVerifyPage() {
  const [code, setCode] = useState("")
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<Result | null>(null)

  async function verify(e?: React.FormEvent) {
    e?.preventDefault()
    if (busy) return
    setBusy(true)
    setResult(null)
    try {
      const res = await fetch(`/api/verify/letter?code=${encodeURIComponent(code.trim())}`)
      const json = await res.json()
      setResult(json)
    } catch {
      setResult({ valid: false, error: "Network error — please try again" })
    } finally {
      setBusy(false)
    }
  }

  const fmt = (iso?: string) => (iso ? new Date(iso).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }) : "—")
  const pretty = (t?: string) => (t ? t.replace(/_/g, " ").toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()) : "—")

  return (
    <main className="min-h-screen bg-gradient-to-br from-slate-50 via-emerald-50/40 to-teal-50/50 dark:from-slate-950 dark:via-slate-900 dark:to-emerald-950/40 flex items-center justify-center p-4">
      <div className="w-full max-w-lg">
        {/* Card */}
        <div className="rounded-2xl border border-slate-200/80 dark:border-slate-800 bg-white/90 dark:bg-slate-900/90 shadow-xl shadow-emerald-900/5 backdrop-blur overflow-hidden">
          <div className="h-1.5 bg-gradient-to-r from-emerald-500 via-teal-500 to-emerald-600" />
          <div className="p-8">
            <div className="flex items-center gap-3 mb-6">
              <div className="h-11 w-11 rounded-xl bg-gradient-to-br from-emerald-500 to-teal-600 text-white flex items-center justify-center shadow-md shadow-emerald-600/30">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-5 w-5"><path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m5.6-1.6A9 9 0 105.6 5.6" /></svg>
              </div>
              <div>
                <h1 className="text-lg font-bold text-slate-900 dark:text-white tracking-tight">Letter Verification</h1>
                <p className="text-xs text-slate-500 dark:text-slate-400">Confirm the authenticity of an issued HR letter</p>
              </div>
            </div>

            <form onSubmit={verify} className="flex gap-2">
              <input
                value={code}
                onChange={(e) => setCode(e.target.value.toUpperCase())}
                placeholder="A1B2-C3D4-E5F6"
                aria-label="Verification code"
                className="flex-1 h-11 rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-4 text-sm font-mono tracking-widest text-slate-900 dark:text-white placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-emerald-500/60 focus:border-emerald-500"
              />
              <button
                type="submit"
                disabled={busy || !code.trim()}
                className="h-11 px-6 rounded-xl bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-700 hover:to-teal-700 text-white text-sm font-semibold shadow-sm shadow-emerald-600/20 disabled:opacity-50 disabled:cursor-not-allowed transition-all"
              >
                {busy ? "Checking…" : "Verify"}
              </button>
            </form>

            {result && (
              <div className="mt-6">
                {result.valid ? (
                  <div className="rounded-xl border border-emerald-200 dark:border-emerald-900/60 bg-gradient-to-br from-emerald-50 to-teal-50/60 dark:from-emerald-950/60 dark:to-teal-950/40 p-5" role="status">
                    <div className="flex items-center gap-2 mb-4">
                      <span className="h-6 w-6 rounded-full bg-emerald-500 text-white flex items-center justify-center">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" className="h-3.5 w-3.5"><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" /></svg>
                      </span>
                      <span className="font-bold text-emerald-800 dark:text-emerald-300 text-sm">This letter is genuine — it was issued by {result.company}</span>
                    </div>
                    <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
                      <div><dt className="text-[11px] uppercase tracking-wide text-slate-500 dark:text-slate-400">Letter No.</dt><dd className="font-semibold text-slate-900 dark:text-white font-mono">{result.letterNumber}</dd></div>
                      <div><dt className="text-[11px] uppercase tracking-wide text-slate-500 dark:text-slate-400">Issued</dt><dd className="font-semibold text-slate-900 dark:text-white">{fmt(result.issuedAt)}</dd></div>
                      <div><dt className="text-[11px] uppercase tracking-wide text-slate-500 dark:text-slate-400">Employee</dt><dd className="font-semibold text-slate-900 dark:text-white">{result.employeeName}</dd></div>
                      <div><dt className="text-[11px] uppercase tracking-wide text-slate-500 dark:text-slate-400">Letter type</dt><dd className="font-semibold text-slate-900 dark:text-white">{pretty(result.type)}</dd></div>
                    </dl>
                  </div>
                ) : (
                  <div className="rounded-xl border border-rose-200 dark:border-rose-900/60 bg-rose-50 dark:bg-rose-950/40 p-5" role="alert">
                    <div className="flex items-center gap-2">
                      <span className="h-6 w-6 rounded-full bg-rose-500 text-white flex items-center justify-center">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" className="h-3.5 w-3.5"><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
                      </span>
                      <span className="font-bold text-rose-800 dark:text-rose-300 text-sm">Not verified</span>
                    </div>
                    <p className="mt-2 text-sm text-rose-700 dark:text-rose-300/90">{result.error}</p>
                    <p className="mt-2 text-xs text-rose-600/80 dark:text-rose-400/80">If you believe this is an error, contact the issuing company&apos;s HR department directly.</p>
                  </div>
                )}
              </div>
            )}

            <p className="mt-6 text-[11px] leading-relaxed text-slate-400 dark:text-slate-500">
              The verification code is printed at the bottom of every letter issued through this HR portal.
              Verification confirms the letter was genuinely issued — no other information is shared.
            </p>
          </div>
        </div>
      </div>
    </main>
  )
}

"use client"
// ============ /contact — sales/support inquiry form (client) ============
import { useState } from "react"
import { CheckCircle2, ChevronRight, Loader2 } from "lucide-react"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { cn } from "@/lib/utils"

const SIZES = ["1-10", "11-50", "51-200", "201-500", "500+"]
const MODULES = [
  "Employee Management", "Attendance", "Payroll", "Leave", "Live Tracking", "Geo-Fencing",
  "ZKTeco Devices", "Inventory", "Procurement", "Performance", "Camera Integration", "Self-Service",
]

export function ContactForm() {
  const [f, setF] = useState({
    name: "", email: "", phone: "", company: "", inquiryType: "SALES",
    organizationSize: "", message: "", modulesRequested: [] as string[],
  })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [ref, setRef] = useState<string | null>(null)

  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((s) => ({ ...s, [k]: v }))
  const toggleMod = (m: string) =>
    setF((s) => ({
      ...s,
      modulesRequested: s.modulesRequested.includes(m)
        ? s.modulesRequested.filter((x) => x !== m)
        : [...s.modulesRequested, m],
    }))

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    setBusy(true)
    try {
      const res = await fetch("/api/saas", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "public.contact",
          payload: {
            name: f.name, email: f.email, phone: f.phone || undefined, company: f.company || undefined,
            inquiryType: f.inquiryType, organizationSize: f.organizationSize || undefined,
            modulesRequested: f.modulesRequested, message: f.message,
            companyWebsiteField: "",
          },
        }),
      })
      const data = await res.json()
      if (!res.ok || !data.ok) throw new Error(data.error || "Could not send the inquiry.")
      setRef(data.reference)
    } catch (err: any) {
      setError(err?.message || "Could not send the inquiry. Please try again.")
    } finally {
      setBusy(false)
    }
  }

  if (ref) {
    return (
      <div className="mx-auto max-w-xl rounded-2xl border border-emerald-400/30 bg-gradient-to-b from-emerald-500/10 to-transparent p-8 text-center light:border-emerald-500/50 light:shadow-sm">
        <CheckCircle2 className="mx-auto h-12 w-12 text-emerald-400 light:text-emerald-600" />
        <h2 className="mt-4 text-xl font-bold text-white light:text-slate-900">Message received</h2>
        <p className="mt-2 text-sm text-slate-400 light:text-slate-600">
          Reference <span className="font-mono font-semibold text-emerald-300 light:text-emerald-700">{ref}</span>. The platform team will
          reply to {f.email} — inquiries are stored securely and tracked in the owner console.
        </p>
      </div>
    )
  }

  return (
    <form onSubmit={submit} className="mx-auto max-w-2xl rounded-2xl border border-white/10 bg-white/[0.03] p-6 light:border-slate-200 light:bg-white light:shadow-sm">
      {error && <p role="alert" className="mb-4 rounded-lg border border-red-400/30 bg-red-500/10 p-3 text-sm text-red-300 light:border-red-400/40 light:bg-red-50 light:text-red-600">{error}</p>}
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <Label className="text-xs text-slate-400 light:text-slate-600">Your name <span className="text-rose-400 light:text-rose-600">*</span></Label>
          <Input required value={f.name} onChange={(e) => set("name", e.target.value)} className="mt-1.5 h-10 bg-white/5 border-white/10 light:bg-white light:border-slate-300" />
        </div>
        <div>
          <Label className="text-xs text-slate-400 light:text-slate-600">Email <span className="text-rose-400 light:text-rose-600">*</span></Label>
          <Input required type="email" value={f.email} onChange={(e) => set("email", e.target.value)} className="mt-1.5 h-10 bg-white/5 border-white/10 light:bg-white light:border-slate-300" />
        </div>
        <div>
          <Label className="text-xs text-slate-400 light:text-slate-600">Phone</Label>
          <Input value={f.phone} onChange={(e) => set("phone", e.target.value)} className="mt-1.5 h-10 bg-white/5 border-white/10 light:bg-white light:border-slate-300" />
        </div>
        <div>
          <Label className="text-xs text-slate-400 light:text-slate-600">Company</Label>
          <Input value={f.company} onChange={(e) => set("company", e.target.value)} className="mt-1.5 h-10 bg-white/5 border-white/10 light:bg-white light:border-slate-300" />
        </div>
        <div>
          <Label className="text-xs text-slate-400 light:text-slate-600">Inquiry type</Label>
          <Select value={f.inquiryType} onValueChange={(v) => set("inquiryType", v)}>
            <SelectTrigger className="mt-1.5 h-10 bg-white/5 border-white/10 light:bg-white light:border-slate-300"><SelectValue /></SelectTrigger>
            <SelectContent>
              {["SALES", "SUPPORT", "PARTNERSHIP", "OTHER"].map((t) => (
                <SelectItem key={t} value={t}>{t.charAt(0) + t.slice(1).toLowerCase()}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label className="text-xs text-slate-400 light:text-slate-600">Organization size</Label>
          <Select value={f.organizationSize} onValueChange={(v) => set("organizationSize", v)}>
            <SelectTrigger className="mt-1.5 h-10 bg-white/5 border-white/10 light:bg-white light:border-slate-300"><SelectValue placeholder="Select…" /></SelectTrigger>
            <SelectContent>
              {SIZES.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
      </div>

      <p className="mt-5 text-xs font-bold uppercase tracking-widest text-slate-500">Modules you&apos;re interested in</p>
      <div className="mt-3 flex flex-wrap gap-2">
        {MODULES.map((m) => {
          const on = f.modulesRequested.includes(m)
          return (
            <button key={m} type="button" onClick={() => toggleMod(m)}
              className={cn(
                "rounded-full border px-3 py-1.5 text-xs font-medium transition-colors",
                on ? "border-emerald-400/50 bg-emerald-500/15 text-emerald-200 light:border-emerald-500 light:bg-emerald-50 light:text-emerald-700" : "border-white/10 text-slate-400 hover:border-white/25 light:border-slate-300 light:text-slate-600 light:hover:border-slate-400"
              )}>
              {m}
            </button>
          )
        })}
      </div>

      <div className="mt-5">
        <Label className="text-xs text-slate-400 light:text-slate-600">Message <span className="text-rose-400 light:text-rose-600">*</span></Label>
        <Textarea required minLength={10} value={f.message} onChange={(e) => set("message", e.target.value)} rows={5}
          placeholder="What are you trying to solve? Timeline? Headcount?"
          className="mt-1.5 bg-white/5 border-white/10 light:bg-white light:border-slate-300" />
      </div>

      <Button type="submit" disabled={busy} className="mt-5 h-11 w-full bg-gradient-to-r from-blue-600 to-violet-600 font-semibold text-white hover:from-blue-500 hover:to-violet-500">
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <>Send inquiry <ChevronRight className="h-4 w-4" /></>}
      </Button>
      <p className="mt-3 text-center text-xs text-slate-500">
        Inquiries are stored in the platform database for the team to answer — no mailing list, no sharing.
      </p>
    </form>
  )
}

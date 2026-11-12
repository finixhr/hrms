"use client"
// ============ KPI Performance System — shared frontend helpers (2026-11) ============
import { useEffect, useState } from "react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { CheckCircle2, XCircle, MessageSquarePlus, Download } from "lucide-react"
import { StatusBadge } from "../../shared/ui-kit"
import { rpc } from "../../api"
import { useHrm } from "../../store"

// ---------------------------------------------------------------------------
// Vocabulary (mirrors src/hrm-server/kpi/constants.ts)
// ---------------------------------------------------------------------------

export const KPI_UNITS = [
  { value: "PERCENT", label: "Percentage (%)", suffix: "%" },
  { value: "NUMBER", label: "Number (count)", suffix: "" },
  { value: "CURRENCY", label: "Currency (৳)", suffix: "৳" },
  { value: "SCORE", label: "Score (0–100)", suffix: "" },
  { value: "HOURS", label: "Hours", suffix: "h" },
  { value: "DAYS", label: "Days", suffix: "d" },
  { value: "BOOLEAN", label: "Boolean (0/1)", suffix: "" },
  { value: "CUSTOM", label: "Custom unit", suffix: "" },
] as const

export const KPI_DIRECTIONS = [
  { value: "HIGHER_IS_BETTER", label: "Higher is better", hint: "Achievement % = actual ÷ target × 100" },
  { value: "LOWER_IS_BETTER", label: "Lower is better", hint: "Achievement % = target ÷ actual × 100" },
  { value: "EXACT_TARGET", label: "Exact target", hint: "Within tolerance of the exact target scores 100" },
] as const

export type KpiUnit = (typeof KPI_UNITS)[number]["value"]
export type KpiDirection = (typeof KPI_DIRECTIONS)[number]["value"]

export const unitLabel = (u: string, label?: string | null) =>
  u === "PERCENT" ? "%" : u === "CUSTOM" ? label || "" : u === "HOURS" ? "hours" : u === "DAYS" ? "days" : u === "CURRENCY" ? "৳" : u === "BOOLEAN" ? "0/1" : ""

export const directionShort = (d: string) =>
  d === "LOWER_IS_BETTER" ? "↓ lower" : d === "EXACT_TARGET" ? "= exact" : "↑ higher"

export const UNIT_OPTIONS = KPI_UNITS.map((u) => ({ value: u.value, label: u.label }))
export const DIRECTION_OPTIONS = KPI_DIRECTIONS.map((d) => ({ value: d.value, label: d.label }))

export function fmtStatus(s: string) {
  return (s || "").replace(/_/g, " ").toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase())
}

export function fmtPeriod(periodLabel: string, periodStart?: string | null, periodEnd?: string | null) {
  const label = String(periodLabel || "").trim()
  const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"]
  let m: RegExpMatchArray | null
  if ((m = label.match(/^(\d{4})-(\d{2})$/))) {
    const mo = Number(m[2])
    if (mo >= 1 && mo <= 12) return `${MONTHS[mo - 1]} ${m[1]}`
  }
  if ((m = label.match(/^(\d{4})-Q([1-4])$/))) return `Q${m[2]} ${m[1]}`
  if (/^\d{4}$/.test(label)) return label
  if (periodStart && periodEnd) return `${periodStart} → ${periodEnd}`
  return label || "—"
}

/** Rating badge — tone follows the band position (top band emerald → bottom rose). */
export function RatingBadge({ rating }: { rating: { label: string; rank: number; stars: number } | null | undefined }) {
  if (!rating) return <span className="text-xs text-slate-400">—</span>
  const tones = ["bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300", "bg-teal-100 text-teal-700 dark:bg-teal-950 dark:text-teal-300", "bg-sky-100 text-sky-700 dark:bg-sky-950 dark:text-sky-300", "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300", "bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300"]
  const tone = tones[Math.min(rating.rank - 1, tones.length - 1)]
  return <Badge className={`${tone} text-[10px] font-semibold whitespace-nowrap`}>{rating.label}</Badge>
}

export function ScoreBadge({ score }: { score: number | null | undefined }) {
  if (score == null) return <span className="text-xs text-slate-400">—</span>
  const tone = score >= 90 ? "text-emerald-600" : score >= 75 ? "text-teal-600" : score >= 60 ? "text-amber-600" : "text-rose-600"
  return <span className={`text-sm font-bold tabular-nums ${tone}`}>{Math.round(score * 10) / 10}</span>
}

export function SourceBadge({ source }: { source: string }) {
  return source === "BUILTIN"
    ? <Badge className="bg-violet-100 text-violet-700 dark:bg-violet-950 dark:text-violet-300 text-[9px] font-semibold">Built-in</Badge>
    : <Badge variant="outline" className="text-[9px] font-semibold">Custom</Badge>
}

// ---------------------------------------------------------------------------
// Period label helpers (mirrors scoring.ts resolvePeriodRange)
// ---------------------------------------------------------------------------

const daysInMonth = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate()

export function periodRange(periodLabel: string, periodStart?: string | null, periodEnd?: string | null): { start: string; end: string } | null {
  const label = String(periodLabel || "").trim()
  let m: RegExpMatchArray | null
  if ((m = label.match(/^(\d{4})-(\d{2})$/))) {
    const y = Number(m[1]); const mo = Number(m[2])
    if (mo >= 1 && mo <= 12) return { start: `${m[1]}-${m[2]}-01`, end: `${m[1]}-${m[2]}-${daysInMonth(y, mo)}` }
  }
  if ((m = label.match(/^(\d{4})-Q([1-4])$/))) {
    const q = Number(m[2])
    return { start: `${m[1]}-${String((q - 1) * 3 + 1).padStart(2, "0")}-01`, end: `${m[1]}-${String(q * 3).padStart(2, "0")}-${daysInMonth(Number(m[1]), q * 3)}` }
  }
  if (/^\d{4}$/.test(label)) return { start: `${label}-01-01`, end: `${label}-12-31` }
  if (periodStart && periodEnd) return { start: periodStart, end: periodEnd }
  return null
}

/** Period picker: granularity + month/quarter/year selection → periodLabel. */
export function PeriodPicker({ value, onChange, id }: { value: string; onChange: (v: string) => void; id?: string }) {
  const now = new Date()
  const [gran, setGran] = useState<"MONTHLY" | "QUARTERLY" | "YEARLY">(() =>
    /-Q[1-4]$/.test(value) ? "QUARTERLY" : /^\d{4}$/.test(value) ? "YEARLY" : "MONTHLY")
  const [year, setYear] = useState(() => (value.match(/^(\d{4})/)?.[1] ? Number(value.slice(0, 4)) : now.getFullYear()))
  const [month, setMonth] = useState(() => (value.match(/^\d{4}-(\d{2})$/)?.[1] ? Number(value.slice(5, 7)) : now.getMonth() + 1))
  const [quarter, setQuarter] = useState(() => (value.match(/-Q([1-4])$/)?.[1] ? Number(value.slice(-1)) : Math.floor(now.getMonth() / 3) + 1))
  useEffect(() => {
    const label = gran === "MONTHLY" ? `${year}-${String(month).padStart(2, "0")}`
      : gran === "QUARTERLY" ? `${year}-Q${quarter}`
      : String(year)
    if (label !== value) onChange(label)
     
  }, [gran, year, month, quarter])
  return (
    <div className="flex items-center gap-1.5" id={id}>
      <Select value={gran} onValueChange={(v: any) => setGran(v)}>
        <SelectTrigger className="h-8 w-[110px] text-xs"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="MONTHLY">Monthly</SelectItem>
          <SelectItem value="QUARTERLY">Quarterly</SelectItem>
          <SelectItem value="YEARLY">Yearly</SelectItem>
        </SelectContent>
      </Select>
      <Select value={String(year)} onValueChange={(v) => setYear(Number(v))}>
        <SelectTrigger className="h-8 w-[84px] text-xs"><SelectValue /></SelectTrigger>
        <SelectContent>
          {Array.from({ length: 5 }, (_, i) => now.getFullYear() + 1 - i).map((y) => (
            <SelectItem key={y} value={String(y)}>{y}</SelectItem>
          ))}
        </SelectContent>
      </Select>
      {gran === "MONTHLY" && (
        <Select value={String(month)} onValueChange={(v) => setMonth(Number(v))}>
          <SelectTrigger className="h-8 w-[130px] text-xs"><SelectValue /></SelectTrigger>
          <SelectContent>
            {["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"].map((mn, i) => (
              <SelectItem key={mn} value={String(i + 1)}>{mn}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
      {gran === "QUARTERLY" && (
        <Select value={String(quarter)} onValueChange={(v) => setQuarter(Number(v))}>
          <SelectTrigger className="h-8 w-[96px] text-xs"><SelectValue /></SelectTrigger>
          <SelectContent>
            {[1, 2, 3, 4].map((q) => <SelectItem key={q} value={String(q)}>Q{q}</SelectItem>)}
          </SelectContent>
        </Select>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// File download / upload helpers (RPC base64 pattern — payroll export style)
// ---------------------------------------------------------------------------

export function downloadBase64File(res: { base64?: string; csv?: string; filename?: string; contentType?: string; format?: string }) {
  const a = document.createElement("a")
  if (res.format === "csv" && res.csv != null) {
    a.href = URL.createObjectURL(new Blob(["\ufeff" + res.csv], { type: "text/csv;charset=utf-8" }))
  } else if (res.base64) {
    const bin = atob(res.base64)
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    a.href = URL.createObjectURL(new Blob([bytes], { type: res.contentType || "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }))
  } else return
  a.download = res.filename || "download"
  a.click()
  URL.revokeObjectURL(a.href)
}

export function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const dataUrl = String(reader.result || "")
      const b64 = dataUrl.includes(",") ? dataUrl.split(",")[1] : dataUrl
      resolve(b64)
    }
    reader.onerror = () => reject(new Error("Could not read the file"))
    reader.readAsDataURL(file)
  })
}

/** Downloadable CSV from preview rows (error report). */
export function downloadErrorReport(rows: { rowNo: number; status: string; employeeCode?: string; error?: string }[]) {
  const esc = (v: unknown) => { const s = String(v ?? ""); return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s }
  const lines = ["Row,Status,Employee ID,Error"]
  for (const r of rows) lines.push([r.rowNo, r.status, r.employeeCode || "", r.error || ""].map((c) => `"${esc(c).replace(/"/g, '""')}"`).join(","))
  const a = document.createElement("a")
  a.href = URL.createObjectURL(new Blob(["\ufeff" + lines.join("\n")], { type: "text/csv;charset=utf-8" }))
  a.download = "kpi-import-errors.csv"
  a.click()
  URL.revokeObjectURL(a.href)
}

export const SUMMARY_TONE = (status: string) => {
  switch (status) {
    case "READY": return "text-emerald-600"
    case "ERROR": return "text-rose-600"
    default: return "text-amber-600"
  }
}

// ---------------------------------------------------------------------------
// Approval action bar (Approve / Reject / Request changes — comment-gated)
// ---------------------------------------------------------------------------

export function ApprovalActions({ onDecide, busy, size = "sm" }: {
  onDecide: (decision: "APPROVE" | "REJECT" | "REQUEST_CHANGES", comment?: string) => Promise<void>
  busy?: boolean
  size?: "sm" | "default"
}) {
  const [commentOpen, setCommentOpen] = useState<null | "REJECT" | "REQUEST_CHANGES">(null)
  const [comment, setComment] = useState("")
  const [busyInner, setBusyInner] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const cls = size === "sm" ? "h-8 text-xs" : ""

  const run = async (decision: "APPROVE" | "REJECT" | "REQUEST_CHANGES", c?: string) => {
    setBusyInner(true)
    setError(null)
    try {
      await onDecide(decision, c)
      setCommentOpen(null)
      setComment("")
    } catch (e: any) {
      setError(e.message)
    } finally {
      setBusyInner(false)
    }
  }

  return (
    <>
      <div className="flex flex-wrap items-center gap-1.5">
        <Button size={size === "sm" ? "sm" : "default"} className={cls} disabled={busy || busyInner}
          onClick={() => run("APPROVE")}>
          <CheckCircle2 className="h-3.5 w-3.5 mr-1" /> Approve
        </Button>
        <Button size={size === "sm" ? "sm" : "default"} variant="outline" className={cls} disabled={busy || busyInner}
          onClick={() => { setError(null); setCommentOpen("REQUEST_CHANGES") }}>
          <MessageSquarePlus className="h-3.5 w-3.5 mr-1" /> Request Changes
        </Button>
        <Button size={size === "sm" ? "sm" : "default"} variant="destructive" className={cls} disabled={busy || busyInner}
          onClick={() => { setError(null); setCommentOpen("REJECT") }}>
          <XCircle className="h-3.5 w-3.5 mr-1" /> Reject
        </Button>
        {error && <span className="text-xs text-rose-600">{error}</span>}
      </div>
      <Dialog open={!!commentOpen} onOpenChange={(v) => { if (!v) setCommentOpen(null) }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-base">{commentOpen === "REJECT" ? "Reject — reason required" : "Request changes — comment required"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-2">
            <Label className="text-xs">{commentOpen === "REJECT" ? "Rejection reason" : "What needs to change?"}</Label>
            <Textarea rows={3} value={comment} onChange={(e) => setComment(e.target.value)} placeholder={commentOpen === "REJECT" ? "e.g. Targets do not match the agreed quarterly plan" : "e.g. Raise the attendance target to 95% for field staff"} />
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setCommentOpen(null)} disabled={busyInner}>Cancel</Button>
            <Button variant={commentOpen === "REJECT" ? "destructive" : "default"} disabled={busyInner || !comment.trim()}
              onClick={() => commentOpen && run(commentOpen, comment.trim())}>
              {busyInner ? "Submitting…" : commentOpen === "REJECT" ? "Reject" : "Send"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

// ---------------------------------------------------------------------------
// ExportButton — kpi.*.export route caller
// ---------------------------------------------------------------------------

export function KpiExportButton({ action, filters, label = "Export" }: {
  action: string
  filters: Record<string, unknown>
  label?: string
}) {
  const toast = useHrm((s) => s.toast)
  const [busy, setBusy] = useState<"xlsx" | "csv" | null>(null)
  const run = async (format: "xlsx" | "csv") => {
    setBusy(format)
    try {
      const res = await rpc<any>(action, { ...filters, format })
      downloadBase64File(res)
    } catch (e: any) {
      toast(e.message, "err")
    } finally {
      setBusy(null)
    }
  }
  return (
    <div className="flex items-center gap-1">
      <Button size="sm" variant="outline" className="h-8 text-xs" disabled={!!busy} onClick={() => run("xlsx")}>
        <Download className="h-3.5 w-3.5 mr-1" /> {busy === "xlsx" ? "Exporting…" : `${label} Excel`}
      </Button>
      <Button size="sm" variant="outline" className="h-8 text-xs" disabled={!!busy} onClick={() => run("csv")}>
        CSV
      </Button>
    </div>
  )
}

export { StatusBadge }

"use client"
// ============ AI Assist (Wave 4, 2026-10-08) ============
// Four surfaces on one page:
//   1. Ask a Report Question — natural-language box with example chips +
//      recent-question history; deterministic catalogue match first, LLM
//      fuzzy routing only when nothing matched and a provider is configured.
//      Results render as the report's own { columns, rows } table.
//   2. Anomaly Scan — pure-statistics attendance anomaly detection
//      (buddy-punching, impossible travel, odd hours, weekend review) over
//      a 30/60/90-day window. Advisory only.
//   3. Resume Screening — deterministic keyword score (always) + optional
//      LLM verdict card (score / strengths / concerns / summary).
//   4. LLM Provider — per-vendor OpenAI-compatible endpoint configuration;
//      the API key is write-only (encrypted at rest server-side) and only an
//      apiKeySet boolean ever comes back.
// House rules: every data load goes through useApi (no fetch-in-effect);
// every action is a click handler (no setState-in-effect); result panels
// remount keyed on their result identity.
import { useState } from "react"
import {
  Cpu, ShieldAlert, Sparkles, Send, FileSearch, KeyRound, Trash2, History, Loader2,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Switch } from "@/components/ui/switch"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { useHrm } from "../store"
import { useApi, rpc } from "../api"
import { PageHeader, SectionCard, StatCard, fmtDateTime, titleCase, FieldError, LoadingRows } from "../shared/ui-kit"
import { DataTable, type Column } from "../shared/data-table"

// ---------- types (mirror the ai.ts route contracts) ----------
type NlResult = {
  matched: boolean
  reportKey?: string
  title?: string
  filters?: Record<string, unknown>
  columns?: string[]
  rows?: unknown[][]
  rowCount?: number
  answer?: string
  llmUsed?: boolean
}

type Finding = {
  type: "BUDDY_PUNCH" | "IMPOSSIBLE_TRAVEL" | "ODD_HOURS" | "WEEKEND_REVIEW"
  employees: string[]
  occurrences: number
  firstSeen: string
  lastSeen: string
  maxKm?: number
  detail: string
}

type AnomalyResult = {
  generatedAt: string
  windowDays: number
  scanned: number
  findings: Finding[]
  counts: Record<string, number>
  advisory?: string
}

type ScreenResult = {
  applicantName: string
  openingTitle: string
  deterministicScore: number
  matched: string[]
  missing: string[]
  requiredKeywords: string[]
  llm?: { score: number; strengths: string[]; concerns: string[]; summary: string }
  llmUsed: boolean
  llmError?: string
}

type AiSettings = {
  provider: string
  baseUrl: string
  model: string
  enabled: boolean
  apiKeySet: boolean
}

type AppOption = {
  id: string
  name: string
  status: string
  openingTitle: string
  expectedSalary: number | null
  createdAt: string
}

const EXAMPLE_QUESTIONS = [
  "headcount by department",
  "attendance summary last month",
  "who has a birthday this month",
  "late arrivals last month",
  "salary bands across the company",
  "recruitment funnel",
  "joiners vs exits this year",
  "new joiners last 3 months",
]

const ANOMALY_META: Record<string, { label: string; cls: string }> = {
  BUDDY_PUNCH: { label: "Buddy Punch", cls: "bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300" },
  IMPOSSIBLE_TRAVEL: { label: "Impossible Travel", cls: "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300" },
  ODD_HOURS: { label: "Odd Hours", cls: "bg-violet-100 text-violet-700 dark:bg-violet-950 dark:text-violet-300" },
  WEEKEND_REVIEW: { label: "Weekend Review", cls: "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300" },
}

function AnomalyBadge({ type }: { type: string }) {
  const m = ANOMALY_META[type] || ANOMALY_META.WEEKEND_REVIEW
  return (
    <Badge variant="secondary" className={`font-medium whitespace-nowrap gap-1.5 ${m.cls}`}>
      <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-current opacity-80 shrink-0" />
      {m.label}
    </Badge>
  )
}

function scoreTone(score: number): string {
  if (score >= 70) return "text-emerald-600 dark:text-emerald-400"
  if (score >= 40) return "text-amber-600 dark:text-amber-400"
  return "text-rose-600 dark:text-rose-400"
}

function KeywordChip({ word, kind }: { word: string; kind: "matched" | "missing" }) {
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium border ${kind === "matched"
      ? "bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950 dark:text-emerald-300 dark:border-emerald-800"
      : "bg-slate-50 text-slate-500 border-slate-200 dark:bg-slate-900 dark:text-slate-400 dark:border-slate-700"}`}>
      {word}
    </span>
  )
}

function NoPermission({ what }: { what: string }) {
  return (
    <div className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
      {what} requires the <code className="text-xs font-mono">ai.generate</code> permission (tenant administrators).
    </div>
  )
}

// =====================================================================
// Section 1 — natural-language report queries
// =====================================================================
function AskSection({ canGen, llmConfigured }: { canGen: boolean; llmConfigured: boolean }) {
  const { toast } = useHrm()
  const [question, setQuestion] = useState("")
  const [asking, setAsking] = useState(false)
  const [result, setResult] = useState<NlResult | null>(null)
  const [askError, setAskError] = useState<string | null>(null)
  const [history, setHistory] = useState<string[]>([])

  const ask = async (text?: string) => {
    const q = (text ?? question).trim()
    if (q.length < 3 || asking || !canGen) return
    setAsking(true)
    setResult(null)
    setAskError(null)
    try {
      const res = await rpc<NlResult>("ai.reportAsk", { question: q })
      setResult(res)
      setHistory((h) => [q, ...h.filter((x) => x !== q)].slice(0, 5))
      if (res.matched) toast(`Matched report: ${res.title || res.reportKey}`)
    } catch (e: any) {
      setAskError(e?.message || "The query failed")
    } finally {
      setAsking(false)
    }
  }

  // dynamic table for the matched report envelope { columns, rows }
  const reportColumns: Column<Record<string, any>>[] = (result?.columns || []).map((label, i) => ({
    key: `c${i}`,
    label: String(label ?? "—"),
  }))
  const reportRows: Record<string, any>[] = (result?.rows || []).map((r, ri) => {
    const o: Record<string, any> = { id: `r${ri}` }
    ;(result?.columns || []).forEach((_, i) => {
      o[`c${i}`] = Array.isArray(r) && r[i] != null ? String(r[i]) : "—"
    })
    return o
  })
  const filterSummary = result?.filters && Object.keys(result.filters).length
    ? Object.entries(result.filters).map(([k, v]) => `${k}: ${String(v)}`).join(" · ")
    : null

  return (
    <SectionCard title="Ask a Report Question">
      <div className="space-y-3">
        {canGen ? (
          <>
            <div className="space-y-1.5">
              <Label htmlFor="ai-question" className="text-xs font-medium text-slate-600 dark:text-slate-300">
                Ask in plain English — e.g. &quot;headcount by department last month&quot;
              </Label>
              <Textarea
                id="ai-question"
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                onKeyDown={(e) => {
                  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") ask()
                }}
                rows={2}
                maxLength={300}
                placeholder="Type a question about your workforce, attendance, payroll or recruitment…"
                aria-describedby="ai-question-hint"
              />
              <p id="ai-question-hint" className="text-[11px] text-slate-500 dark:text-slate-400">
                Deterministic phrase matching runs first (works without an LLM){llmConfigured ? " — unmatched questions fall back to the configured LLM provider" : " — configure an LLM provider below for fuzzy matching"} · Ctrl+Enter to ask · 20 queries/hour
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button onClick={() => ask()} disabled={asking || question.trim().length < 3} className="gap-1.5">
                {asking ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Send className="h-4 w-4" aria-hidden />}
                {asking ? "Asking…" : "Ask"}
              </Button>
              {EXAMPLE_QUESTIONS.slice(0, 5).map((ex) => (
                <button
                  key={ex}
                  type="button"
                  onClick={() => { setQuestion(ex); ask(ex) }}
                  disabled={asking}
                  className="h-7 rounded-full px-3 text-xs font-medium border bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-300 border-slate-200 dark:border-slate-700 hover:border-emerald-400 transition-colors disabled:opacity-50"
                >
                  {ex}
                </button>
              ))}
            </div>
            {history.length > 0 && (
              <div className="flex flex-wrap items-center gap-2">
                <span className="inline-flex items-center gap-1 text-[11px] font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">
                  <History className="h-3.5 w-3.5" aria-hidden /> Recent
                </span>
                {history.map((h) => (
                  <button
                    key={h}
                    type="button"
                    onClick={() => { setQuestion(h); ask(h) }}
                    disabled={asking}
                    className="h-7 rounded-full px-3 text-xs border border-dashed border-slate-300 dark:border-slate-600 text-slate-500 dark:text-slate-400 hover:border-emerald-400 hover:text-emerald-600 transition-colors disabled:opacity-50"
                  >
                    {h}
                  </button>
                ))}
              </div>
            )}
            <FieldError message={askError} />
            {result?.matched && (
              <div className="space-y-3" key={`${result.reportKey}-${JSON.stringify(result.filters ?? {})}`}>
                <div className="flex flex-wrap items-center gap-2">
                  <Badge className="bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300 font-medium gap-1.5 whitespace-nowrap">
                    <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-current opacity-80" />
                    Matched report: {result.title || result.reportKey}
                  </Badge>
                  <Badge variant="outline" className="whitespace-nowrap">
                    {result.llmUsed ? "routed by LLM" : "deterministic match"}
                  </Badge>
                  {filterSummary && <span className="text-[11px] text-slate-500 dark:text-slate-400">{filterSummary}</span>}
                </div>
                <DataTable
                  columns={reportColumns}
                  rows={reportRows}
                  pageSize={15}
                  dense
                  csvName={`ai-report-${result.reportKey || "result"}`}
                  emptyTitle="The matched report returned no rows for these filters"
                />
                {(result.rowCount ?? 0) > reportRows.length && (
                  <p className="text-[11px] text-slate-500 dark:text-slate-400">
                    Showing the first {reportRows.length} of {result.rowCount} rows — narrow the question (e.g. add a month) for the rest.
                  </p>
                )}
              </div>
            )}
            {result && !result.matched && (
              <div className="rounded-xl border bg-muted/30 p-4" role="article" aria-label="Assistant answer">
                <p className="text-sm leading-relaxed">{result.answer || "The assistant returned an empty answer — try rephrasing the question."}</p>
                <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-2">
                  Answered by the LLM provider — no report was run.
                </p>
              </div>
            )}
          </>
        ) : (
          <NoPermission what="Natural-language report queries" />
        )}
      </div>
    </SectionCard>
  )
}

// =====================================================================
// Section 2 — attendance anomaly scan (pure statistics, no LLM)
// =====================================================================
function AnomalySection() {
  const [windowDays, setWindowDays] = useState("30")
  const [scanning, setScanning] = useState(false)
  const [scan, setScan] = useState<AnomalyResult | null>(null)
  const [scanError, setScanError] = useState<string | null>(null)

  const scanNow = async () => {
    if (scanning) return
    setScanning(true)
    setScan(null)
    setScanError(null)
    try {
      const res = await rpc<AnomalyResult>("ai.anomalies", { days: Number(windowDays) })
      setScan(res)
    } catch (e: any) {
      setScanError(e?.message || "The scan failed")
    } finally {
      setScanning(false)
    }
  }

  const findingRows = (scan?.findings || []).map((f, i) => ({
    id: `f${i}`,
    type: f.type,
    who: f.employees.join(" · "),
    occurrences: f.occurrences,
    window: `${f.firstSeen} → ${f.lastSeen}`,
    detail: f.detail,
  }))
  const findingColumns: Column<Record<string, any>>[] = [
    { key: "type", label: "Type", render: (r) => <AnomalyBadge type={r.type} /> },
    { key: "who", label: "Who", render: (r) => <span className="font-medium">{r.who}</span> },
    { key: "occurrences", label: "Occurrences", align: "right", sortValue: (r) => Number(r.occurrences) },
    { key: "window", label: "Window", render: (r) => <span className="tabular-nums text-xs">{r.window}</span> },
    { key: "detail", label: "Detail" },
  ]

  return (
    <SectionCard
      title="Anomaly Scan"
      actions={
        <div className="flex items-center gap-2">
          <Select value={windowDays} onValueChange={setWindowDays}>
            <SelectTrigger className="h-8 w-[130px]" aria-label="Scan window">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="30">Last 30 days</SelectItem>
              <SelectItem value="60">Last 60 days</SelectItem>
              <SelectItem value="90">Last 90 days</SelectItem>
            </SelectContent>
          </Select>
          <Button size="sm" onClick={scanNow} disabled={scanning} className="gap-1.5 h-8">
            {scanning ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <ShieldAlert className="h-3.5 w-3.5" aria-hidden />}
            {scanning ? "Scanning…" : "Scan"}
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        <p className="text-xs text-slate-500 dark:text-slate-400">
          Pure statistics — no LLM involved. Detects same-device buddy punching (≤ 90 s apart, ≥ 3 days), impossible travel
          (&gt; 5 km within 15 minutes), repeated odd-hours check-ins (00:00–04:00) and weekend check-ins without matched
          approved overtime. Findings are advisory only — nothing is changed.
        </p>
        <FieldError message={scanError} />
        {scan && (
          <div className="space-y-3" key={`${scan.generatedAt}-${scan.windowDays}`}>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs text-slate-500 dark:text-slate-400">
                {scan.scanned.toLocaleString()} records scanned · {fmtDateTime(scan.generatedAt)}
              </span>
              {Object.entries(scan.counts).map(([type, n]) => (
                <span key={type} className="inline-flex items-center gap-1.5">
                  <AnomalyBadge type={type} />
                  <span className="text-xs font-semibold tabular-nums">{n}</span>
                </span>
              ))}
            </div>
            <DataTable
              columns={findingColumns}
              rows={findingRows}
              pageSize={15}
              dense
              searchable={false}
              csvName={`ai-anomalies-${scan.windowDays}d`}
              emptyTitle={`No anomalies detected in the last ${scan.windowDays} days`}
              emptyHint="The deterministic engine found no buddy-punching, travel, odd-hours or weekend patterns above their thresholds."
            />
            {scan.findings.length >= 50 && (
              <p className="text-[11px] text-slate-500 dark:text-slate-400">
                Showing the 50 most severe findings — narrow the window or export the CSV for the full picture.
              </p>
            )}
          </div>
        )}
        {!scan && !scanning && !scanError && (
          <div className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
            Press Scan to analyze the last {windowDays} days of attendance.
          </div>
        )}
      </div>
    </SectionCard>
  )
}

// =====================================================================
// Section 3 — resume screening
// =====================================================================
function ResumeSection({ canGen }: { canGen: boolean }) {
  const { toast } = useHrm()
  const appsApi = useApi<{ applications: AppOption[] }>(canGen ? "ai.applications.list" : null, {})
  const apps = appsApi.data?.applications || []
  const [appId, setAppId] = useState("")
  const [screening, setScreening] = useState(false)
  const [screen, setScreen] = useState<ScreenResult | null>(null)
  const [screenError, setScreenError] = useState<string | null>(null)

  const screenNow = async () => {
    if (!appId || screening) return
    setScreening(true)
    setScreen(null)
    setScreenError(null)
    try {
      const res = await rpc<ScreenResult>("ai.resumeScreen", { applicationId: appId })
      setScreen(res)
      toast(`Screened ${res.applicantName} — keyword score ${res.deterministicScore}/100`)
    } catch (e: any) {
      setScreenError(e?.message || "The screening failed")
    } finally {
      setScreening(false)
    }
  }

  return (
    <SectionCard title="Resume Screening">
      <div className="space-y-3">
        {canGen ? (
          <>
            <div className="flex flex-col sm:flex-row sm:items-end gap-2">
              <div className="space-y-1.5 flex-1">
                <Label className="text-xs font-medium text-slate-600 dark:text-slate-300">
                  Application (NEW · SHORTLISTED · INTERVIEW)
                </Label>
                {appsApi.loading ? (
                  <LoadingRows rows={2} />
                ) : appsApi.error ? (
                  <FieldError message={appsApi.error} />
                ) : apps.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No active-pipeline applications to screen.</p>
                ) : (
                  <Select value={appId} onValueChange={setAppId}>
                    <SelectTrigger aria-label="Select an application to screen">
                      <SelectValue placeholder="Select an application…" />
                    </SelectTrigger>
                    <SelectContent>
                      {apps.map((a) => (
                        <SelectItem key={a.id} value={a.id}>
                          {a.name} — {a.openingTitle} ({titleCase(a.status)})
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </div>
              <Button onClick={screenNow} disabled={!appId || screening} className="gap-1.5">
                {screening ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <FileSearch className="h-4 w-4" aria-hidden />}
                {screening ? "Screening…" : "Screen"}
              </Button>
            </div>
            <p className="text-[11px] text-slate-500 dark:text-slate-400">
              The keyword score ALWAYS runs (opening title + description tokens vs the cover note — title matches carry
              double weight). The LLM verdict card appears when a provider is configured. 30 screenings/hour.
            </p>
            <FieldError message={screenError} />
            {screen && (
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4" key={`${screen.applicantName}-${screen.deterministicScore}`}>
                <div className="rounded-xl border bg-card p-4 space-y-3">
                  <p className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
                    Keyword score (deterministic)
                  </p>
                  <div className="flex items-baseline gap-2">
                    <span className={`text-4xl font-bold tabular-nums ${scoreTone(screen.deterministicScore)}`}>
                      {screen.deterministicScore}
                    </span>
                    <span className="text-sm text-slate-500 dark:text-slate-400">/ 100</span>
                  </div>
                  <p className="text-sm font-medium">
                    {screen.applicantName} <span className="text-slate-500 dark:text-slate-400">· {screen.openingTitle}</span>
                  </p>
                  {screen.requiredKeywords.length === 0 ? (
                    <p className="text-xs text-muted-foreground">
                      The opening has no extractable keywords (empty description) — the keyword score cannot differentiate.
                    </p>
                  ) : (
                    <div className="space-y-2">
                      <div className="flex flex-wrap gap-1.5" aria-label="Matched keywords">
                        {(screen.matched || []).map((k) => <KeywordChip key={k} word={k} kind="matched" />)}
                        {screen.matched.length === 0 && <span className="text-xs text-muted-foreground">no keyword matches</span>}
                      </div>
                      <div className="flex flex-wrap gap-1.5" aria-label="Missing keywords">
                        {(screen.missing || []).map((k) => <KeywordChip key={k} word={k} kind="missing" />)}
                      </div>
                    </div>
                  )}
                </div>
                <div className="rounded-xl border bg-card p-4 space-y-3">
                  <p className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">LLM verdict</p>
                  {screen.llm ? (
                    <>
                      <div className="flex items-baseline gap-2">
                        <span className={`text-4xl font-bold tabular-nums ${scoreTone(screen.llm.score)}`}>{screen.llm.score}</span>
                        <span className="text-sm text-slate-500 dark:text-slate-400">/ 100</span>
                      </div>
                      {screen.llm.summary && <p className="text-sm leading-relaxed">{screen.llm.summary}</p>}
                      {screen.llm.strengths.length > 0 && (
                        <div>
                          <p className="text-[11px] font-semibold uppercase tracking-wide text-emerald-600 dark:text-emerald-400">Strengths</p>
                          <ul className="mt-1 space-y-1 text-sm list-disc list-inside">
                            {screen.llm.strengths.map((s, i) => <li key={i}>{s}</li>)}
                          </ul>
                        </div>
                      )}
                      {screen.llm.concerns.length > 0 && (
                        <div>
                          <p className="text-[11px] font-semibold uppercase tracking-wide text-amber-600 dark:text-amber-400">Concerns</p>
                          <ul className="mt-1 space-y-1 text-sm list-disc list-inside">
                            {screen.llm.concerns.map((c, i) => <li key={i}>{c}</li>)}
                          </ul>
                        </div>
                      )}
                    </>
                  ) : screen.llmError ? (
                    <p className="text-sm text-amber-600 dark:text-amber-400">{screen.llmError}</p>
                  ) : (
                    <p className="text-sm text-muted-foreground">
                      No LLM verdict — the deterministic keyword score on the left is the complete result. Configure an LLM
                      provider below to add the verdict card.
                    </p>
                  )}
                </div>
              </div>
            )}
          </>
        ) : (
          <NoPermission what="Resume screening" />
        )}
      </div>
    </SectionCard>
  )
}

// =====================================================================
// Section 4 — LLM provider configuration (admin-only, ai.generate)
// =====================================================================
// Remounted by its parent whenever fresh saved settings arrive, so the form
// state initializes from the latest server values without any
// setState-in-effect.
function ProviderForm({ initial, onSaved, canEdit }: { initial: AiSettings; onSaved: () => void; canEdit: boolean }) {
  const { toast } = useHrm()
  const [baseUrl, setBaseUrl] = useState(initial.baseUrl)
  const [model, setModel] = useState(initial.model)
  const [apiKey, setApiKey] = useState("")
  const [enabled, setEnabled] = useState(initial.enabled)
  const [busy, setBusy] = useState(false)
  const [clearing, setClearing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const save = async () => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await rpc<AiSettings>("ai.settings.save", {
        baseUrl,
        model,
        enabled,
        // "" or missing keeps the stored key; a typed value replaces it
        ...(apiKey.trim() !== "" ? { apiKey: apiKey.trim() } : {}),
      })
      setApiKey("")
      toast("LLM provider settings saved")
      onSaved()
    } catch (e: any) {
      setError(e?.message || "Save failed")
    } finally {
      setBusy(false)
    }
  }

  const clearKey = async () => {
    if (clearing || busy) return
    setClearing(true)
    setError(null)
    try {
      await rpc<AiSettings>("ai.settings.save", { apiKey: "__clear__" })
      toast("Stored API key removed")
      onSaved()
    } catch (e: any) {
      setError(e?.message || "Could not remove the key")
    } finally {
      setClearing(false)
    }
  }

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-3 gap-y-2.5">
        <div className="space-y-1.5">
          <Label htmlFor="ai-baseurl" className="text-xs font-medium text-slate-600 dark:text-slate-300">Base URL (https)</Label>
          <Input
            id="ai-baseurl"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="https://api.openai.com/v1"
            inputMode="url"
            disabled={!canEdit}
          />
          <p className="text-[11px] text-slate-500 dark:text-slate-400">
            OpenAI-compatible endpoint — &lt;baseUrl&gt;/chat/completions. Private/internal hosts are rejected.
          </p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="ai-model" className="text-xs font-medium text-slate-600 dark:text-slate-300">Model</Label>
          <Input
            id="ai-model"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder="gpt-4o-mini"
            maxLength={60}
            disabled={!canEdit}
          />
          <p className="text-[11px] text-slate-500 dark:text-slate-400">
            Calls use temperature 0.1, max_tokens 700 and a 20 s timeout.
          </p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="ai-apikey" className="text-xs font-medium text-slate-600 dark:text-slate-300 inline-flex items-center gap-1">
            <KeyRound className="h-3.5 w-3.5" aria-hidden /> API key {initial.apiKeySet && <Badge variant="outline" className="text-[10px]">stored</Badge>}
          </Label>
          <Input
            id="ai-apikey"
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={initial.apiKeySet ? "Leave blank to keep the stored key" : "sk-… (optional for keyless endpoints)"}
            autoComplete="new-password"
            disabled={!canEdit}
          />
          <p className="text-[11px] text-slate-500 dark:text-slate-400">
            Write-only: stored AES-256-GCM encrypted, never returned to the browser.
          </p>
        </div>
        <div className="space-y-1.5">
          <div className="flex items-center gap-2 pt-1">
            <Switch id="ai-enabled" checked={enabled} onCheckedChange={setEnabled} disabled={!canEdit} />
            <Label htmlFor="ai-enabled" className="text-xs font-medium text-slate-600 dark:text-slate-300">
              Enable LLM features (fuzzy NL matching, screening verdicts)
            </Label>
          </div>
          <p className="text-[11px] text-slate-500 dark:text-slate-400">
            Provider: {initial.provider || "openai-compatible"}.
          </p>
        </div>
      </div>
      <FieldError message={error} />
      {/* AI-002 — only settings.edit holders (tenant admins) can change the
          outbound LLM endpoint; ai.generate users read the configuration. */}
      {!canEdit && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 dark:border-amber-900 dark:bg-amber-950/40 px-3 py-2 text-[11px] text-amber-700 dark:text-amber-300">
          Read-only view — changing the LLM provider, endpoint or API key requires HR Settings permission (settings.edit).
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={save} disabled={!canEdit || busy || clearing} className="gap-1.5">
          {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Cpu className="h-4 w-4" aria-hidden />}
          {busy ? "Saving…" : "Save Provider"}
        </Button>
        {initial.apiKeySet && (
          <Button variant="outline" onClick={clearKey} disabled={!canEdit || busy || clearing} className="gap-1.5 text-rose-600 hover:text-rose-700 hover:bg-rose-500/10">
            {clearing ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Trash2 className="h-4 w-4" aria-hidden />}
            {clearing ? "Removing…" : "Remove Stored Key"}
          </Button>
        )}
      </div>
      <div className="rounded-lg border bg-muted/30 p-3 text-[11px] leading-relaxed text-slate-600 dark:text-slate-400">
        Deterministic engines (anomaly scan, resume keyword scoring) work without an LLM — they never call this provider.
        Natural-language <strong>fuzzy matching</strong> (questions the phrase catalogue cannot match) and the resume
        <strong> LLM verdict</strong> need the provider configured and enabled.
      </div>
    </div>
  )
}

function ProviderSection({ onSaved, canEdit }: { onSaved: () => void; canEdit: boolean }) {
  const settingsApi = useApi<AiSettings>("ai.settings.get", {})
  // refresh BOTH the form's settings and the page-level status cards on save
  const saved = () => {
    settingsApi.reload()
    onSaved()
  }
  return (
    <SectionCard title="LLM Provider">
      {settingsApi.loading ? (
        <LoadingRows rows={4} />
      ) : settingsApi.error ? (
        <FieldError message={settingsApi.error} />
      ) : settingsApi.data ? (
        <ProviderForm
          key={`${settingsApi.data.baseUrl}|${settingsApi.data.model}|${settingsApi.data.enabled}|${settingsApi.data.apiKeySet}|${canEdit}`}
          initial={settingsApi.data}
          onSaved={saved}
          canEdit={canEdit}
        />
      ) : null}
    </SectionCard>
  )
}

// =====================================================================
// Page
// =====================================================================
export default function AiAssistView() {
  const { can } = useHrm()
  const canView = can("ai", "view")
  const canGen = can("ai", "generate")
  const statusApi = useApi<any>(canView ? "ai.status" : null, {})
  const status = statusApi.data

  // hooks before the permission gate (rules of hooks)
  if (!canView) return null

  const reloadStatus = () => statusApi.reload()

  return (
    <div className="space-y-6">
      <PageHeader
        title="AI Assist"
        subtitle="Natural-language report queries, attendance anomaly detection and resume screening — deterministic engines that work without an LLM, plus an optional provider for fuzzy matching"
      />

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <StatCard
          label="LLM Provider"
          value={statusApi.loading ? "…" : status?.llmConfigured ? "Configured" : "Not configured"}
          sub={status?.llmConfigured ? `${status.provider || "openai-compatible"} · ${status.model || "model set"}` : "deterministic engines only"}
          icon={Cpu}
          tone={status?.llmConfigured ? "emerald" : "slate"}
        />
        <StatCard
          label="Deterministic Engines"
          value="Always on"
          sub="anomaly scan + resume keyword scoring — no LLM needed"
          icon={ShieldAlert}
          tone="teal"
        />
        <StatCard
          label="NL Query Limit"
          value="20 / hour"
          sub="per user · resume screening 30 / hour"
          icon={Sparkles}
          tone="sky"
        />
      </div>

      <AskSection canGen={canGen} llmConfigured={!!status?.llmConfigured} />
      <AnomalySection />
      <ResumeSection canGen={canGen} />
      {canView ? <ProviderSection onSaved={reloadStatus} canEdit={can("settings", "edit")} /> : (
        <SectionCard title="LLM Provider">
          <NoPermission what="LLM provider configuration" />
        </SectionCard>
      )}
    </div>
  )
}

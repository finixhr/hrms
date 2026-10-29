// ============ AI Assist routes (Wave 4, 2026-10-08) ============
// Four surfaces, three of them with deterministic cores so the module works
// with ZERO external dependencies:
//
//   1. ai.reportAsk    — natural-language report queries. Step 1 is a local
//                        keyword parser over a FIXED catalogue of report keys
//                        (the exact registry from routes/reports.ts); a match
//                        renders through the reports registry — the same
//                        code path the RPC dispatcher and the report scheduler
//                        use. Only when NOTHING matches deterministically and
//                        an LLM provider is configured does ONE chat completion
//                        route the question (strict-JSON, zod-validated).
//   2. ai.anomalies    — attendance anomaly detection (PURE statistics, no
//                        LLM ever): buddy-punching, impossible travel, odd
//                        hours, weekend review. Advisory only — no records
//                        are changed.
//   3. ai.resumeScreen — resume screening. The keyword score is deterministic
//                        and ALWAYS runs; the LLM layer adds a
//                        score/strengths/concerns verdict when configured and
//                        degrades cleanly when it fails.
//   4. ai.settings.*   — per-vendor OpenAI-compatible provider configuration
//                        (HrSettings group "ai"); the API key is stored
//                        AES-256-GCM encrypted (crypto-field, context
//                        "ai::v1") and is NEVER returned to the client — only
//                        an apiKeySet boolean.
//
// House rules honored: H-10 vendor scoping on EVERY query; every generation
// action audited (AI_NL_QUERY / AI_ANOMALY_SCAN / AI_RESUME_SCREEN /
// AI_SETTINGS_SAVE) with the prompt/question truncated to 200 chars;
// rate limits 20/h (NL queries) and 30/h (resume screens) per user; LLM calls
// are plain fetch with a 20s timeout, max_tokens 700, temperature 0.1, and
// NEVER crash the route (failures surface as a Deny with a helpful message —
// except the anomaly engine and the deterministic resume score, which always
// work).
import { z } from "zod"
import { route } from "./registry"
import { Deny } from "../rbac"
import { audit } from "../audit"
import { db } from "@/lib/db"
import { getSettings, saveSettingsGroup } from "../settings"
import { encryptField, decryptField, fieldKeyConfigured } from "../crypto-field"
import { rateLimit, validateOutboundUrl } from "../security"
import { renderReportAsCaller } from "./reports"
import { addDays, today } from "../utils"

// =====================================================================
// LLM provider configuration (HrSettings group "ai")
// =====================================================================
// The group is not part of the typed HrSettings tree yet (it predates the AI
// work package), so — like the foundation stub — it is read through a
// Record<string, any> cast. Values are stored per-key by saveSettingsGroup()
// and cached by settings.ts's 15s write-through cache.
//
// apiKey storage: "enc::<iv.tag.enc>" under HRM_MFA_KEY, context "ai::v1"
// (same AES-256-GCM scheme as comms/device secrets, separate derivation). A
// plaintext legacy value is tolerated on read but never written by this
// module. The key NEVER crosses the API boundary — responses expose only
// `apiKeySet: boolean`.

const AI_SETTINGS_GROUP = "ai"
const AI_ENC_PREFIX = "enc::"
const AI_CONTEXT = "ai::v1"
const DEFAULT_PROVIDER = "openai-compatible"

type AiConfig = {
  provider: string
  baseUrl: string
  model: string
  apiKey: string // decrypted, server-side only
  enabled: boolean
}
type AiRuntimeConfig = AiConfig & { apiKeySet: boolean; ready: boolean }

function unwrapApiKey(raw: unknown): string {
  if (typeof raw !== "string" || raw === "") return ""
  if (raw.startsWith(AI_ENC_PREFIX)) {
    try {
      return decryptField(raw.slice(AI_ENC_PREFIX.length), AI_CONTEXT)
    } catch {
      // wrong/rotated HRM_MFA_KEY — treat as unset so LLM calls skip cleanly
      // instead of sending a ciphertext as a Bearer token
      return ""
    }
  }
  return raw // legacy plaintext row — readable, but never written here
}

async function getAiConfig(vendorId: string): Promise<AiRuntimeConfig> {
  const settings = await getSettings(vendorId)
  const g = (settings as Record<string, any>)[AI_SETTINGS_GROUP] || {}
  const cfg: AiConfig = {
    provider: typeof g.provider === "string" && g.provider.trim() ? g.provider.trim() : DEFAULT_PROVIDER,
    baseUrl: typeof g.baseUrl === "string" ? g.baseUrl.trim() : "",
    model: typeof g.model === "string" ? g.model.trim() : "",
    apiKey: unwrapApiKey(g.apiKey),
    enabled: g.enabled === true,
  }
  // "ready" = the module may actually place a completion call. The API key is
  // deliberately NOT required: several OpenAI-compatible endpoints (Ollama,
  // LM Studio, LAN gateways) authenticate by network position, not by key.
  return { ...cfg, apiKeySet: !!cfg.apiKey, ready: cfg.enabled && !!cfg.baseUrl && !!cfg.model }
}

/** One chat completion against the vendor's OpenAI-compatible endpoint.
 *  20s timeout (AbortSignal.timeout), max_tokens ~700, temperature 0.1.
 *  NEVER throws a raw network error — failures become readable Errors that
 *  callers turn into Denys (or degrade, for the resume LLM layer). */
async function chatCompletion(
  cfg: { baseUrl: string; model: string; apiKey: string },
  messages: { role: "system" | "user"; content: string }[],
): Promise<string> {
  const base = cfg.baseUrl.trim().replace(/\/+$/, "")
  const url = /\/chat\/completions$/.test(base) ? base : `${base}/chat/completions`
  let res: Response
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}),
      },
      body: JSON.stringify({ model: cfg.model, messages, temperature: 0.1, max_tokens: 700 }),
      signal: AbortSignal.timeout(20_000),
    })
  } catch (e: any) {
    if (e?.name === "TimeoutError" || e?.name === "AbortError") {
      throw new Error("the request timed out after 20 seconds")
    }
    throw new Error(`network error (${e?.message || "unknown cause"})`)
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} from the provider`)
  let json: unknown
  try {
    json = await res.json()
  } catch {
    throw new Error("the provider returned a non-JSON body")
  }
  const content = (json as any)?.choices?.[0]?.message?.content
  if (typeof content !== "string" || !content.trim()) {
    throw new Error("the provider returned an empty completion")
  }
  return content
}

/** Extract the first JSON object from a completion (tolerates ```json fences
 *  and surrounding prose). Throws a readable Error when nothing parses. */
function extractJsonObject(content: string): Record<string, unknown> {
  const stripped = content.replace(/```(?:json)?/gi, "").trim()
  const start = stripped.indexOf("{")
  const end = stripped.lastIndexOf("}")
  if (start === -1 || end <= start) throw new Error("no JSON object found in the completion")
  let parsed: unknown
  try {
    parsed = JSON.parse(stripped.slice(start, end + 1))
  } catch {
    throw new Error("malformed JSON in the completion")
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("the completion was JSON but not an object")
  }
  return parsed as Record<string, unknown>
}

// =====================================================================
// FEATURE 1 — natural-language report queries
// =====================================================================
// Fixed catalogue of report keys. Every key is registered by reportRoute() in
// routes/reports.ts and therefore renderable through the registry.
// `filters` lists the filter keys that report's handler actually consumes —
// used both by the deterministic date-hint extraction and to whitelist
// LLM-suggested filters.

type CatalogueEntry = {
  key: string
  title: string
  description: string
  keywords: string[]
  filters: string[]
  /** RPT-10 — the status values THIS report understands (LLM-suggested
   *  statuses are validated against this list; absent = the filter is not
   *  offered). */
  statuses?: string[]
}

const REPORT_CATALOGUE: CatalogueEntry[] = [
  // (order matters for ties: specific entries sit before their generic twins)
  { key: "attendanceLate", title: "Late Arrivals", description: "Late arrival instances with minutes lost, for a month.", keywords: ["late", "late arrival", "late arrivals", "late coming", "latecomers", "tardiness", "punctuality"], filters: ["month", "year"] },
  { key: "attendance", title: "Attendance", description: "Daily attendance records with check-in/out times, working minutes and overtime, for a month.", keywords: ["attendance", "present", "absent", "absence", "check in", "checkin", "punch", "clock in"], filters: ["month", "year", "status"], statuses: ["PRESENT", "ABSENT", "LATE", "EARLY_LEAVE", "HALF_DAY", "LEAVE", "LEAVE_UNPAID", "HOLIDAY", "WEEKLY_OFF", "WFH", "BUSINESS_TRIP"] },
  { key: "employeesNewJoiners", title: "New Joiners", description: "Employees who joined within a date range.", keywords: ["new joiners", "new employees", "recently joined", "recent hires", "joined"], filters: ["from", "to"] },
  { key: "employeesExits", title: "Exits", description: "Resigned, terminated or retired employees within a date range.", keywords: ["resignations", "resigned employees", "terminated employees", "retired employees", "employee exits", "who left", "who resigned"], filters: ["from", "to"] },
  { key: "headcountMovement", title: "Headcount Movement", description: "Joiners vs exits per month for a year — turnover and net change.", keywords: ["joiners", "exits", "turnover", "attrition", "movement", "net change"], filters: ["year"] },
  { key: "headcount", title: "Headcount", description: "Employee headcount grouped by branch, department, status or employment type.", keywords: ["headcount", "how many employees", "employee count", "staff count", "total employees", "workforce", "manpower"], filters: ["dimension"] },
  { key: "demographics", title: "Demographics", description: "Workforce split by gender, blood group, marital status or religion.", keywords: ["demographics", "gender", "male", "female", "blood group", "marital status", "religion"], filters: ["dimension"] },
  { key: "salaryBands", title: "Salary Bands", description: "Current basic-salary distribution across bands (under ৳20k, ৳20k–50k, ৳50k–100k, …).", keywords: ["salary band", "salary bands", "pay range", "salary range", "pay band", "salary distribution", "pay distribution"], filters: [] },
  { key: "leave", title: "Leave Register", description: "Leave requests with type, days, substitute and status.", keywords: ["leave", "leave requests", "time off", "casual leave", "sick leave", "annual leave"], filters: ["status", "year"], statuses: ["PENDING", "APPROVED", "REJECTED", "CANCELLED"] },
  { key: "payroll", title: "Payroll Register", description: "Payroll entries for a month: gross, OT, bonus, deductions, AIT and net.", keywords: ["payroll", "salary cost", "payroll register", "net pay", "salary sheet", "wages", "payroll summary"], filters: ["month", "year"] },
  { key: "birthdays", title: "Birthdays & Anniversaries", description: "Birthdays and work anniversaries in a selected month.", keywords: ["birthday", "birthdays", "anniversary", "anniversaries", "birth date"], filters: ["month", "year"] },
  { key: "probationExpiry", title: "Probation & Contract Expiry", description: "Probation confirmations and contract end dates within a horizon of days.", keywords: ["probation", "confirmation", "confirmations", "probation expiry", "contract expiry", "contract end"], filters: ["withinDays"] },
  { key: "recruitmentFunnel", title: "Recruitment Funnel", description: "Openings and the application pipeline by stage.", keywords: ["recruitment", "funnel", "candidates", "applications", "hiring pipeline", "applicant pipeline", "shortlisted"], filters: [] },
  // ---- RPT-10 — the remainder of the registered catalog (every reportRoute
  // key now has an NL entry; before, 13 of ~33 registered reports were
  // reachable through natural language) ----
  { key: "attendanceAbsence", title: "Absence Register", description: "Absent days per employee for a month.", keywords: ["absenteeism", "absent days", "absence register", "who was absent"], filters: ["month", "year"] },
  { key: "attendanceOvertime", title: "Overtime Register", description: "Overtime minutes and approval state per employee for a month.", keywords: ["overtime", "ot hours", "extra hours", "ot register"], filters: ["month", "year", "status"], statuses: ["APPROVED", "PENDING"] },
  { key: "attendanceWorkingHours", title: "Working Hours", description: "Working hours per employee for a month.", keywords: ["working hours", "hours worked", "work hours"], filters: ["month", "year"] },
  { key: "leaveBalances", title: "Leave Balances", description: "Remaining versus entitled leave per employee and type for a year.", keywords: ["leave balance", "remaining leave", "leave entitlement", "unused leave"], filters: ["year"] },
  { key: "leaveUtilization", title: "Leave Utilization", description: "Used versus entitled leave by type for a year.", keywords: ["leave utilization", "leave usage", "leave consumption"], filters: ["year"] },
  { key: "leaveDepartment", title: "Department Leave", description: "Leave consumption by department for a year.", keywords: ["department leave", "leave by department"], filters: ["year"] },
  { key: "payrollBranch", title: "Branch Payroll", description: "Net payroll by branch for a month.", keywords: ["payroll by branch", "branch salary cost", "branch payroll"], filters: ["month", "year"] },
  { key: "payrollDepartment", title: "Department Payroll", description: "Net payroll by department for a month.", keywords: ["payroll by department", "department salary cost", "department payroll"], filters: ["month", "year"] },
  { key: "payrollDeductions", title: "Payroll Deductions", description: "Absence, late, loan, advance and AIT deductions per employee for a month.", keywords: ["deductions", "payroll deductions", "salary deductions", "ait deducted"], filters: ["month", "year"] },
  { key: "gratuity", title: "Gratuity Provision", description: "Bangladesh Labour Act gratuity projection for 5-year-plus employees.", keywords: ["gratuity", "gratuity provision", "bla gratuity", "severance provision"], filters: [] },
  { key: "festivalBonus", title: "Festival Bonus Preview", description: "Festival bonus preview on basic or gross for the active headcount.", keywords: ["festival bonus", "eid bonus", "bonus preview", "festival advance"], filters: [] },
  { key: "loans", title: "Loans", description: "Loans with principal, installments, paid and outstanding.", keywords: ["loans", "employee loans", "loan register", "loan outstanding"], filters: ["status"], statuses: ["PENDING", "APPROVED", "ACTIVE", "CLOSED", "REJECTED"] },
  { key: "advances", title: "Advances", description: "Salary advances with recovery progress and outstanding.", keywords: ["advances", "salary advance", "advance recovery", "advance register"], filters: ["status"], statuses: ["PENDING", "APPROVED", "RECOVERING", "REJECTED"] },
  { key: "expenses", title: "Expenses", description: "Expense claims with approval and reimbursement status.", keywords: ["expenses", "expense claims", "expense register"], filters: ["status"], statuses: ["PENDING", "APPROVED", "REIMBURSED", "REJECTED"] },
  { key: "reimbursements", title: "Reimbursements", description: "Reimbursed claims with dates and totals.", keywords: ["reimbursements", "reimbursed claims", "expense payouts"], filters: [] },
  { key: "performance", title: "Performance Reviews", description: "Performance reviews with overall ratings.", keywords: ["performance reviews", "review ratings", "appraisals"], filters: [] },
  { key: "performanceKpi", title: "KPI Achievement", description: "KPI achievement percentage per employee.", keywords: ["kpi", "kpi achievement", "kpi scores"], filters: [] },
  { key: "performanceTrend", title: "Performance Trend", description: "Average rating per review cycle.", keywords: ["performance trend", "rating trend", "review cycle average"], filters: [] },
  { key: "employeesBiodata", title: "Employee Biodata", description: "Full employee biodata (PII report).", keywords: ["biodata", "employee profiles", "full employee data"], filters: ["status"], statuses: ["ACTIVE", "PROBATION", "ON_LEAVE", "RESIGNED", "TERMINATED", "RETIRED", "INACTIVE"] },
  { key: "employeesDirectory", title: "Employee Directory", description: "Employee directory with contacts and org anchors.", keywords: ["directory", "employee list", "contact list"], filters: ["status", "branchId", "departmentId"] },
  { key: "employeesLifecycle", title: "Employment Lifecycle", description: "Joining, probation, confirmation and exit timeline per employee.", keywords: ["lifecycle", "employment history", "joining dates"], filters: [] },
  { key: "assetAssignments", title: "Asset Assignments", description: "Employee asset assignment register with issue/return status.", keywords: ["assets", "asset assignments", "issued assets", "laptop assignments"], filters: [] },
  { key: "fieldforceVisits", title: "Field Force Visits", description: "Field-force visit completion and duration per employee for a month.", keywords: ["field force", "visits", "field visits", "visit completion"], filters: ["month", "year"] },
  // ---- RPT-23 new reports + the remaining factory-registered keys ----
  { key: "employees", title: "Employee Register", description: "Directory with branch, department, designation and status.", keywords: ["employee register", "employee directory", "staff list", "all employees"], filters: ["status", "branchId", "departmentId"], statuses: ["ACTIVE", "PROBATION", "ON_LEAVE", "RESIGNED", "TERMINATED", "RETIRED", "INACTIVE"] },
  { key: "attendanceBranch", title: "Attendance by Branch", description: "Attendance summary grouped by branch for a month.", keywords: ["attendance by branch", "branch attendance"], filters: ["month", "year"] },
  { key: "attendanceDepartment", title: "Attendance by Department", description: "Attendance summary grouped by department for a month.", keywords: ["attendance by department", "department attendance"], filters: ["month", "year"] },
  { key: "attritionRate", title: "Attrition Rate", description: "Annualized attrition rate per month.", keywords: ["attrition rate", "attrition", "churn rate", "staff turnover rate"], filters: ["year"] },
  { key: "ageBands", title: "Age Bands", description: "Workforce age distribution across standard bands.", keywords: ["age bands", "age distribution", "age groups", "how old"], filters: [] },
  { key: "tenureBands", title: "Tenure Bands", description: "Service-length distribution across standard bands.", keywords: ["tenure bands", "tenure distribution", "years of service", "seniority distribution"], filters: [] },
  { key: "diversityOverTime", title: "Diversity Over Time", description: "Gender mix by joining cohort year.", keywords: ["diversity", "gender mix", "diversity over time", "hiring diversity"], filters: [] },
  { key: "absenteeismTrend", title: "Absenteeism Trend", description: "Absent employee-days and absenteeism rate per month.", keywords: ["absenteeism trend", "absenteeism rate", "absence trend"], filters: ["year"] },
  { key: "otCost", title: "OT Cost", description: "Estimated overtime cost per employee for a month, in taka.", keywords: ["ot cost", "overtime cost", "overtime expense", "ot taka"], filters: ["month", "year"] },
  { key: "holidayCalendar", title: "Holiday Calendar", description: "The year's holidays with type and branch scope.", keywords: ["holiday calendar", "holidays", "public holidays", "company holidays"], filters: ["year"] },
  { key: "payslipDistribution", title: "Payslip Distribution Audit", description: "Consolidated run audit: totals, payout-method splits and payslip-number integrity.", keywords: ["payslip distribution", "payslip audit", "salary disbursement audit", "payout summary"], filters: ["month", "year"] },
]

// ---- deterministic keyword matching ------------------------------------
// Word-boundary matching that also works for Bangla tokens (\b does not) —
// a hit requires a non-letter (or string edge) on BOTH sides of the keyword.
const KW_BOUNDARY = "a-z0-9\\u0980-\\u09ff"
const kwReCache = new Map<string, RegExp>()
function kwRe(kw: string): RegExp {
  let re = kwReCache.get(kw)
  if (!re) {
    const esc = kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    re = new RegExp(`(^|[^${KW_BOUNDARY}])${esc}(?=$|[^${KW_BOUNDARY}])`, "i")
    kwReCache.set(kw, re)
  }
  return re
}
function hasKeyword(question: string, kw: string): boolean {
  return kwRe(kw).test(question)
}

// ---- date-range / dimension hint extraction ----------------------------
type DateHints = { month?: number; year?: number; from?: string; to?: string; withinDays?: number }

const MONTH_WORDS: [RegExp, number][] = [
  [/\bjan(?:uary)?\b/, 1], [/\bfeb(?:ruary)?\b/, 2], [/\bmar(?:ch)?\b/, 3], [/\bapr(?:il)?\b/, 4],
  [/\bmay\b/, 5], [/\bjun(?:e)?\b/, 6], [/\bjul(?:y)?\b/, 7], [/\baug(?:ust)?\b/, 8],
  [/\bsep(?:t(?:ember)?)?\b/, 9], [/\boct(?:ober)?\b/, 10], [/\bnov(?:ember)?\b/, 11], [/\bdec(?:ember)?\b/, 12],
]

function extractDateHints(qRaw: string): DateHints {
  const q = qRaw.toLowerCase()
  const now = new Date()
  const y = now.getUTCFullYear()
  const m = now.getUTCMonth() + 1
  const out: DateHints = {}

  // explicit ISO ranges / "since <date>" dominate everything else
  const range = q.match(/\b(\d{4}-\d{2}-\d{2})\s*(?:to|until|till|through|–|—|-)\s*(\d{4}-\d{2}-\d{2})\b/)
  if (range) {
    out.from = range[1]
    out.to = range[2]
    return out
  }
  const since = q.match(/\b(?:since|after|from)\s+(\d{4}-\d{2}-\d{2})\b/)
  if (since) {
    out.from = since[1]
    out.to = today()
    return out
  }
  // "last/past N months" → a from/to window (capped at 12 so the report
  // engine's 366-day range guard can never trip)
  const nMonths = q.match(/\b(?:last|past)\s+(\d{1,2})\s+months?\b/)
  if (nMonths) {
    const n = Math.min(Math.max(Number(nMonths[1]) || 1, 1), 12)
    out.from = new Date(Date.UTC(y, m - n, 1)).toISOString().slice(0, 10)
    out.to = today()
    return out
  }
  const nDays = q.match(/\b(?:last|past)\s+(\d{1,3})\s+days?\b/)
  if (nDays) {
    const n = Math.min(Math.max(Number(nDays[1]) || 1, 1), 366)
    out.from = addDays(today(), -(n - 1))
    out.to = today()
    out.withinDays = n // probations/contracts naturally read as "next N days" horizons
    return out
  }
  const nextDays = q.match(/\bnext\s+(\d{1,3})\s+days?\b/)
  if (nextDays) {
    out.withinDays = Math.min(Math.max(Number(nextDays[1]) || 1, 1), 366)
  }

  // single-month resolution
  if (/\blast\s+month\b|\bprevious\s+month\b/.test(q)) {
    out.month = m === 1 ? 12 : m - 1
    out.year = m === 1 ? y - 1 : y
  } else if (/\bthis\s+month\b|\bcurrent\s+month\b/.test(q)) {
    out.month = m
    out.year = y
  } else {
    for (const [re, num] of MONTH_WORDS) {
      if (re.test(q)) {
        out.month = num
        break
      }
    }
  }
  // year resolution (runs after the month block so "March last year" wins)
  if (/\blast\s+year\b|\bprevious\s+year\b/.test(q)) out.year = y - 1
  else if (/\bthis\s+year\b|\bcurrent\s+year\b/.test(q)) out.year = y
  else {
    const yr = q.match(/\b(20\d{2})\b/)
    if (yr) out.year = Number(yr[1])
  }
  return out
}

function dimensionOf(q: string): string | null {
  // NOTE on the plurals: "branch(?:es)?" / "status(?:es)?" — "branches?" would
  // match "branche"+optional "s", NOT "branch" (a typo class caught by the
  // smoke run: "by branch" silently failed to set the dimension).
  if (/\b(?:by|per)\s+departments?\b|\bdepartment[- ]?wise\b/.test(q)) return "department"
  if (/\b(?:by|per)\s+branch(?:es)?\b|\bbranch[- ]?wise\b/.test(q)) return "branch"
  if (/\b(?:by|per)\s+status(?:es)?\b|\bstatus[- ]?wise\b/.test(q)) return "status"
  if (/\b(?:by|per)\s+employment\s+types?\b|\bemployment[- ]?type[- ]?wise\b|\bby\s+type\b/.test(q)) return "employmentType"
  return null
}
function demoDimensionOf(q: string): string | null {
  if (/\bgender\b|\bmale\b|\bfemale\b/.test(q)) return "gender"
  if (/blood\s*group/.test(q)) return "bloodGroup"
  if (/marital/.test(q)) return "maritalStatus"
  if (/religion/.test(q)) return "religion"
  return null
}
function statusOf(reportKey: string, q: string): string | null {
  if (reportKey === "leave") {
    if (/\bpending\b/.test(q)) return "PENDING"
    if (/\bapproved\b/.test(q)) return "APPROVED"
    if (/\brejected\b|\bdeclined\b/.test(q)) return "REJECTED"
    if (/\bcancelled\b|\bcanceled\b/.test(q)) return "CANCELLED"
    return null
  }
  if (reportKey === "attendance") {
    if (/\babsent\b|\babsence\b|\bno show\b/.test(q)) return "ABSENT"
    if (/\bwfh\b|\bwork from home\b|\bremote work\b/.test(q)) return "WFH"
    if (/\bpresent\b/.test(q)) return "PRESENT"
    if (/\bhalf\s*day\b/.test(q)) return "HALF_DAY"
    return null
  }
  return null
}

/** Keep only the filter keys the target report actually supports, filled
 *  from the extracted hints. */
function buildFilters(entry: CatalogueEntry, hints: DateHints, qRaw: string): Record<string, string | number> {
  const q = qRaw.toLowerCase()
  const allows = new Set(entry.filters)
  const filters: Record<string, string | number> = {}
  if (allows.has("month") && hints.month) filters.month = hints.month
  if (allows.has("year") && hints.year) filters.year = hints.year
  if (allows.has("from") && hints.from) filters.from = hints.from
  if (allows.has("to") && hints.to) filters.to = hints.to
  if (allows.has("withinDays") && hints.withinDays) filters.withinDays = hints.withinDays
  if (allows.has("dimension")) {
    const dim = entry.key === "demographics" ? demoDimensionOf(q) : dimensionOf(q)
    if (dim) filters.dimension = dim
  }
  if (allows.has("status")) {
    const s = statusOf(entry.key, q)
    if (s) filters.status = s
  }
  return filters
}

/** Deterministic intent match: highest keyword-hit count wins; catalogue
 *  order breaks ties (specific entries first). */
function matchReport(question: string): { entry: CatalogueEntry; filters: Record<string, string | number> } | null {
  const q = question.toLowerCase()
  let best: CatalogueEntry | null = null
  let bestScore = 0
  for (const e of REPORT_CATALOGUE) {
    let score = 0
    for (const kw of e.keywords) {
      if (hasKeyword(q, kw)) score++
    }
    if (score > bestScore) {
      bestScore = score
      best = e
    }
  }
  if (!best) return null
  return { entry: best, filters: buildFilters(best, extractDateHints(question), question) }
}

// ---- LLM fuzzy routing (only when nothing matched deterministically) ----

function routerSystemPrompt(): string {
  const catalogue = REPORT_CATALOGUE.map((e) => ({ key: e.key, title: e.title, description: e.description, filters: e.filters }))
  return [
    "You are the report router of a multi-tenant HR system. Map the user's question to exactly ONE report, or answer directly when no report fits.",
    "Available reports (JSON):",
    JSON.stringify(catalogue),
    "Filter conventions: dimension is one of branch|department|status|employmentType (headcount) or gender|bloodGroup|maritalStatus|religion (demographics); month is 1-12; year is e.g. 2026; withinDays is 1-366; from and to are YYYY-MM-DD; status is an attendance status (PRESENT, ABSENT, LATE, WFH, HALF_DAY) or a leave status (PENDING, APPROVED, REJECTED, CANCELLED). Only include filter keys the report lists, and only when the question implies them.",
    "Respond with STRICT JSON only — no markdown, no prose outside JSON — in exactly one of these shapes:",
    '{"reportKey":"<a key from the list>","filters":{}}',
    '{"reportKey":null,"answer":"<a helpful answer of at most 80 words, or an apology when you cannot answer>"}',
  ].join("\n")
}

const VALID_DIMENSIONS = new Set(["branch", "department", "status", "employmentType", "gender", "bloodGroup", "maritalStatus", "religion"])

/** Whitelist + clamp LLM-suggested filters down to what the target report
 *  supports. Anything unusual is dropped, never forwarded. */
/** RPT-10 — registry-coverage check: every registered reportRoute key must
 *  have a natural-language catalogue entry. Returns the missing keys (empty
 *  = full coverage). Unit-tested; CI keeps the catalogue honest as reports
 *  are added. */
export async function aiStatusCatalogueCheck(): Promise<string[]> {
  const { registeredReportKeys } = await import("./reports")
  const known = new Set(REPORT_CATALOGUE.map((e) => e.key))
  return registeredReportKeys().filter((k) => !known.has(k))
}

function whitelistFilters(entry: CatalogueEntry, raw: unknown): Record<string, string | number> {
  const out: Record<string, string | number> = {}
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out
  const allows = new Set(entry.filters)
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!allows.has(k)) continue
    if (typeof v === "number" && Number.isFinite(v)) {
      if (k === "month") {
        const mo = Math.round(v)
        if (mo >= 1 && mo <= 12) out.month = mo
      } else if (k === "year") {
        const yr = Math.round(v)
        if (yr >= 2000 && yr <= 2100) out.year = yr
      } else if (k === "withinDays") {
        const d = Math.round(v)
        if (d >= 1 && d <= 366) out.withinDays = d
      } else {
        out[k] = v
      }
    } else if (typeof v === "string" && v.trim() !== "" && v.length <= 120) {
      const s = v.trim()
      if (k === "dimension") {
        if (VALID_DIMENSIONS.has(s)) out.dimension = s
      } else if (k === "status") {
        // RPT-10 — validate against the report's OWN status vocabulary (the
        // old path upper-cased whatever the LLM said and passed it through;
        // an invented status silently returned an unfiltered report)
        const up = s.toUpperCase().replace(/\s+/g, "_")
        if (entry.statuses?.includes(up)) out.status = up
      } else {
        out[k] = s
      }
    }
  }
  return out
}

async function llmPickReport(
  cfg: AiConfig,
  question: string,
): Promise<{ reportKey?: string | null; filters?: Record<string, unknown>; answer?: string }> {
  const content = await chatCompletion(cfg, [
    { role: "system", content: routerSystemPrompt() },
    { role: "user", content: `Question: ${question}` },
  ])
  const parsed = extractJsonObject(content)
  const shape = z
    .object({
      reportKey: z.string().nullable().optional(),
      filters: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
      answer: z.string().optional(),
    })
    .safeParse(parsed)
  if (!shape.success) throw new Error("the model did not return the expected JSON shape")
  return shape.data
}

function sanitizeAnswer(raw: unknown): string {
  return String(raw ?? "")
    .replace(/[\x00-\x1f\x7f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500)
}

// ---- routes --------------------------------------------------------------

route("ai.status", {
  perm: ["ai", "view"],
  schema: z.object({}).strict(),
  handler: async (ctx) => {
    const cfg = await getAiConfig(ctx.vendorId)
    return {
      features: ["nlReports", "anomalies", "resumeScreen"],
      llmConfigured: cfg.ready,
      llmEnabled: cfg.enabled,
      apiKeySet: cfg.apiKeySet,
      provider: cfg.provider,
      model: cfg.model || null,
      anomalyEngine: "deterministic", // always available, no LLM needed
    }
  },
})

route("ai.reportAsk", {
  perm: ["ai", "generate"],
  schema: z.object({ question: z.string().trim().min(3).max(300) }).strict(),
  handler: async (ctx, p) => {
    // Rate limit: 20 NL queries per hour per user
    if (await rateLimit(`ai:ask:${ctx.vendorId}:${ctx.userId}`, 20, 3600_000)) {
      throw new Deny("AI query limit reached — 20 natural-language report queries per hour. Please try again later.", 429)
    }
    // AI-001 (Wave R3-3) — the report RENDER must honor the caller's own
    // permissions and scope, not a synthetic HR_ADMIN ctx. ai.generate alone
    // no longer grants reports.* data: without reports.view the ask is
    // refused; with it, renderReportAsCaller applies the caller's
    // employeeScopeFilter (branch/department managers see only their rows).
    if (!ctx.permissions.has("reports.view") && !ctx.permissions.has("*")) {
      throw new Deny("AI report queries require Reports access (reports.view). Ask your administrator for the permission.", 403)
    }
    const question = p.question
    const qForLog = question.slice(0, 200)

    // Step 1+2 — deterministic intent match → render through the SAME engine
    // the Reports view uses, AS THE CALLER (scoped).
    const det = matchReport(question)
    if (det) {
      const out = await renderReportAsCaller(ctx, det.entry.key, det.filters)
      if (!out) throw new Deny(`The matched report "${det.entry.key}" is not registered`, 400)
      await audit(ctx, "AI_NL_QUERY", "Report", det.entry.key,
        `NL query matched report "${det.entry.key}" deterministically (${out.rows.length} rows) — "${qForLog}"`)
      return {
        matched: true,
        reportKey: det.entry.key,
        title: out.title,
        filters: det.filters,
        columns: out.columns,
        rows: out.rows.slice(0, 100),
        rowCount: out.rows.length,
        llmUsed: false,
      }
    }

    // Step 3 — no deterministic match → ONE LLM routing call (when configured)
    const cfg = await getAiConfig(ctx.vendorId)
    if (!cfg.ready) {
      await audit(ctx, "AI_NL_QUERY", "Report", null,
        `NL query matched no report and no LLM provider is configured — "${qForLog}"`)
      throw new Deny(
        'No report matched your question — try phrasing like "headcount by department last month". ' +
        "Configure an LLM provider below for fuzzy matching.",
        400,
      )
    }
    let decision: { reportKey?: string | null; filters?: Record<string, unknown>; answer?: string }
    try {
      decision = await llmPickReport(cfg, question)
    } catch (e: any) {
      await audit(ctx, "AI_NL_QUERY", "Report", null,
        `NL query LLM routing failed (${e?.message || "unknown cause"}) — "${qForLog}"`)
      throw new Deny(
        `LLM provider unreachable/misconfigured — ${e?.message || "the completion call failed"}. ` +
        'Deterministic phrasings (e.g. "headcount by department") still work without the LLM.',
        502,
      )
    }
    if (decision.reportKey) {
      const entry = REPORT_CATALOGUE.find((e) => e.key === decision.reportKey)
      if (!entry) {
        await audit(ctx, "AI_NL_QUERY", "Report", null,
          `NL query LLM returned unknown report key "${decision.reportKey}" — "${qForLog}"`)
        throw new Deny(`The LLM picked an unknown report ("${decision.reportKey}") — try rephrasing the question.`, 502)
      }
      const filters = whitelistFilters(entry, decision.filters)
      // AI-001 — LLM-routed branch renders as the caller too
      const out = await renderReportAsCaller(ctx, entry.key, filters)
      if (!out) throw new Deny(`The report "${entry.key}" is not registered`, 400)
      await audit(ctx, "AI_NL_QUERY", "Report", entry.key,
        `NL query matched report "${entry.key}" via LLM (${out.rows.length} rows) — "${qForLog}"`)
      return {
        matched: true,
        reportKey: entry.key,
        title: out.title,
        filters,
        columns: out.columns,
        rows: out.rows.slice(0, 100),
        rowCount: out.rows.length,
        llmUsed: true,
      }
    }
    // the model answered conversationally instead of routing
    const answer = sanitizeAnswer(decision.answer)
    await audit(ctx, "AI_NL_QUERY", "Report", null,
      `NL query answered by LLM without a report — "${qForLog}"`)
    return { matched: false, answer, llmUsed: true }
  },
})

// =====================================================================
// FEATURE 2 — attendance anomaly detection (pure statistics, NO LLM)
// =====================================================================

type FindingType = "BUDDY_PUNCH" | "IMPOSSIBLE_TRAVEL" | "ODD_HOURS" | "WEEKEND_REVIEW"
type Finding = {
  type: FindingType
  employees: string[]
  occurrences: number
  firstSeen: string
  lastSeen: string
  maxKm?: number
  detail: string
}

const WD = ["SUNDAY", "MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY"]
// deviceInfo fallbacks that mark a METHOD, not a physical device — using them
// as a device fingerprint would flag every pair of employees that punch via
// the same method within 90 seconds (false positives).
const GENERIC_DEVICE_INFO = new Set(["", "GEOFENCE", "SELFIE", "GEOFENCE_SELFIE", "WEB", "MANUAL", "IMPORT", "BIOMETRIC"])
const FINDING_SEVERITY: Record<FindingType, number> = { BUDDY_PUNCH: 0, IMPOSSIBLE_TRAVEL: 1, ODD_HOURS: 2, WEEKEND_REVIEW: 3 }

function minutesOfDay(t?: string | null): number | null {
  if (!t) return null
  const parts = t.split(":")
  const h = Number(parts[0])
  const m = Number(parts[1])
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null
  return h * 60 + m
}

function haversineKm(a: { latitude: number; longitude: number }, b: { latitude: number; longitude: number }): number {
  const R = 6371 // km
  const dLat = ((b.latitude - a.latitude) * Math.PI) / 180
  const dLng = ((b.longitude - a.longitude) * Math.PI) / 180
  const la = (a.latitude * Math.PI) / 180
  const lb = (b.latitude * Math.PI) / 180
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(la) * Math.cos(lb) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(x)))
}

/** Device fingerprint for buddy-punch detection: a REAL deviceInfo string
 *  (biometric terminal "Name (SN)", client-supplied model), else the source
 *  IP. Generic method markers are skipped. */
function deviceFingerprint(r: { deviceInfo: string | null; ip: string | null }): string | null {
  const di = (r.deviceInfo || "").trim()
  if (di && !GENERIC_DEVICE_INFO.has(di.toUpperCase())) return `device:${di}`
  const ip = (r.ip || "").trim()
  if (ip) return `ip:${ip}`
  return null
}

route("ai.anomalies", {
  perm: ["ai", "view"],
  schema: z.object({ days: z.number().int().min(7).max(90).default(30) }).strict(),
  handler: async (ctx, p) => {
    // the dispatcher's M-01 schema guarantees `days`; the ?? keeps direct
    // handler calls (scripts/tests) on the documented default too
    const days = typeof p.days === "number" ? p.days : 30
    const since = addDays(today(), -days)
    const [records, employees, settings] = await Promise.all([
      // most recent first + hard cap: a 90-day window on a 500-employee tenant
      // stays far below this, and the scan is bounded no matter what
      db.attendance.findMany({
        where: { vendorId: ctx.vendorId, date: { gte: since } },
        orderBy: [{ date: "desc" }, { checkIn: "asc" }],
        take: 10_000,
      }),
      db.employee.findMany({ where: { vendorId: ctx.vendorId }, select: { id: true, fullName: true, code: true } }),
      getSettings(ctx.vendorId),
    ])
    const nameOf = (id: string) => employees.find((e) => e.id === id)?.fullName || "Unknown employee"
    const weeklyOff = new Set<string>((settings as any)?.general?.weeklyHoliday || ["FRIDAY"])

    const findings: Finding[] = []

    // ---- 1) Buddy punching: two different employees, same device
    //      fingerprint, check-ins ≤ ~90s apart, on ≥ 3 distinct days.
    //      (checkIn has HH:MM resolution — a ≤1-minute difference is the
    //      closest representable proxy for ≤90 seconds.)
    type Punch = { employeeId: string; minutes: number }
    const byDeviceDay = new Map<string, Map<string, Punch[]>>() // deviceKey → date → punches
    for (const r of records) {
      const minutes = minutesOfDay(r.checkIn)
      if (minutes == null) continue
      const deviceKey = deviceFingerprint(r)
      if (!deviceKey) continue
      const byDay = byDeviceDay.get(deviceKey) || new Map<string, Punch[]>()
      const list = byDay.get(r.date) || []
      list.push({ employeeId: r.employeeId, minutes })
      byDay.set(r.date, list)
      byDeviceDay.set(deviceKey, byDay)
    }
    type PairAgg = { a: string; b: string; deviceKey: string; occurrences: number; days: Set<string>; firstSeen: string; lastSeen: string }
    const pairs = new Map<string, PairAgg>()
    for (const [deviceKey, byDay] of byDeviceDay) {
      for (const [date, list] of byDay) {
        const sorted = [...list].sort((x, y) => x.minutes - y.minutes)
        for (let i = 0; i < sorted.length; i++) {
          for (let j = i + 1; j < sorted.length; j++) {
            if (sorted[j].minutes - sorted[i].minutes > 1) break // >~90s apart
            if (sorted[j].employeeId === sorted[i].employeeId) continue
            const [a, b] = [sorted[i].employeeId, sorted[j].employeeId].sort()
            const key = `${a}~${b}~${deviceKey}`
            let agg = pairs.get(key)
            if (!agg) {
              agg = { a, b, deviceKey, occurrences: 0, days: new Set<string>(), firstSeen: date, lastSeen: date }
              pairs.set(key, agg)
            }
            agg.occurrences++
            agg.days.add(date)
            if (date < agg.firstSeen) agg.firstSeen = date
            if (date > agg.lastSeen) agg.lastSeen = date
          }
        }
      }
    }
    for (const agg of pairs.values()) {
      if (agg.days.size < 3) continue
      findings.push({
        type: "BUDDY_PUNCH",
        employees: [nameOf(agg.a), nameOf(agg.b)],
        occurrences: agg.occurrences,
        firstSeen: agg.firstSeen,
        lastSeen: agg.lastSeen,
        detail: `${agg.occurrences} same-device check-ins within ~90 seconds across ${agg.days.size} distinct days (fingerprint "${agg.deviceKey}") — review for buddy punching`,
      })
    }

    // ---- 2) Impossible travel: same employee, consecutive geo-fenced
    //      check-ins > 5 km apart within < 15 minutes. Attendance is unique
    //      per (employee, date), so "consecutive" spans the overnight
    //      boundary too — a 23:58 punch followed by a 00:03 punch five
    //      minutes later and 90 km away is exactly the pattern worth
    //      flagging. Gaps are measured on a day-indexed minute timeline
    //      (dayIndex*1440 + minute-of-day).
    const geoByEmp = new Map<string, { idx: number; date: string; latitude: number; longitude: number }[]>()
    for (const r of records) {
      const minutes = minutesOfDay(r.checkIn)
      if (minutes == null || r.latitude == null || r.longitude == null) continue
      const dayIdx = Math.floor(Date.parse(`${r.date}T00:00:00Z`) / 86_400_000)
      const list = geoByEmp.get(r.employeeId) || []
      list.push({ idx: dayIdx * 1440 + minutes, date: r.date, latitude: r.latitude, longitude: r.longitude })
      geoByEmp.set(r.employeeId, list)
    }
    for (const [employeeId, unsorted] of geoByEmp) {
      const list = unsorted.sort((x, y) => x.idx - y.idx)
      let occurrences = 0
      let maxKm = 0
      let firstSeen = ""
      let lastSeen = ""
      for (let i = 1; i < list.length; i++) {
        const a = list[i - 1]
        const b = list[i]
        const gap = b.idx - a.idx
        if (gap <= 0 || gap >= 15) continue
        const km = haversineKm(a, b)
        if (km > 5) {
          occurrences++
          maxKm = Math.max(maxKm, km)
          if (!firstSeen || b.date < firstSeen) firstSeen = b.date
          if (b.date > lastSeen) lastSeen = b.date
        }
      }
      if (occurrences > 0) {
        findings.push({
          type: "IMPOSSIBLE_TRAVEL",
          employees: [nameOf(employeeId)],
          occurrences,
          firstSeen: firstSeen || list[0].date,
          lastSeen: lastSeen || firstSeen || list[0].date,
          maxKm: Math.round(maxKm * 10) / 10,
          detail: `${occurrences} consecutive geo-fenced check-in${occurrences === 1 ? "" : "s"} more than 5 km apart within 15 minutes (max ${Math.round(maxKm * 10) / 10} km)`,
        })
      }
    }

    // ---- 3) Odd hours: ≥ 5 check-ins between 00:00 and 04:00 (wall clock).
    const oddByEmp = new Map<string, { count: number; first: string; last: string }>()
    for (const r of records) {
      const minutes = minutesOfDay(r.checkIn)
      if (minutes == null || minutes >= 240) continue
      const cur = oddByEmp.get(r.employeeId) || { count: 0, first: r.date, last: r.date }
      cur.count++
      if (r.date < cur.first) cur.first = r.date
      if (r.date > cur.last) cur.last = r.date
      oddByEmp.set(r.employeeId, cur)
    }
    for (const [employeeId, v] of oddByEmp) {
      if (v.count < 5) continue
      findings.push({
        type: "ODD_HOURS",
        employees: [nameOf(employeeId)],
        occurrences: v.count,
        firstSeen: v.first,
        lastSeen: v.last,
        detail: `${v.count} check-ins between 00:00 and 04:00 in the window`,
      })
    }

    // ---- 4) Weekend review: ≥ 4 check-ins on weekly off-days without a
    //      matched approved-overtime record (otApproved on the row). The
    //      label says "review" — approved weekend shifts are complex to join,
    //      so this is deliberately advisory.
    const weekendByEmp = new Map<string, { count: number; first: string; last: string }>()
    for (const r of records) {
      if (!r.checkIn) continue
      if (r.otApproved === true) continue // matched approved overtime
      const wd = WD[new Date(`${r.date}T00:00:00Z`).getUTCDay()]
      if (!weeklyOff.has(wd)) continue
      const cur = weekendByEmp.get(r.employeeId) || { count: 0, first: r.date, last: r.date }
      cur.count++
      if (r.date < cur.first) cur.first = r.date
      if (r.date > cur.last) cur.last = r.date
      weekendByEmp.set(r.employeeId, cur)
    }
    const offLabel = [...weeklyOff].map((d) => d.toLowerCase()).join("/") || "weekly off"
    for (const [employeeId, v] of weekendByEmp) {
      if (v.count < 4) continue
      findings.push({
        type: "WEEKEND_REVIEW",
        employees: [nameOf(employeeId)],
        occurrences: v.count,
        firstSeen: v.first,
        lastSeen: v.last,
        detail: `${v.count} check-ins on weekly off-day (${offLabel}) without matched approved overtime — review`,
      })
    }

    // severity order + cap
    findings.sort((a, b) => FINDING_SEVERITY[a.type] - FINDING_SEVERITY[b.type] || b.occurrences - a.occurrences)
    const capped = findings.slice(0, 50)
    const counts: Record<FindingType, number> = { BUDDY_PUNCH: 0, IMPOSSIBLE_TRAVEL: 0, ODD_HOURS: 0, WEEKEND_REVIEW: 0 }
    for (const f of capped) counts[f.type]++

    await audit(ctx, "AI_ANOMALY_SCAN", "Attendance", null,
      `Anomaly scan over the last ${days} days (${records.length} records) — ${capped.length} finding(s): ` +
      `buddy-punch ${counts.BUDDY_PUNCH}, impossible-travel ${counts.IMPOSSIBLE_TRAVEL}, odd-hours ${counts.ODD_HOURS}, weekend-review ${counts.WEEKEND_REVIEW}`)
    return {
      generatedAt: new Date().toISOString(),
      windowDays: days,
      scanned: records.length,
      findings: capped,
      counts,
      advisory: "Findings are advisory only — no attendance records were changed.",
    }
  },
})

// =====================================================================
// FEATURE 3 — resume screening
// =====================================================================

// Candidate applications the screener can pick from (active pipeline only).
route("ai.applications.list", {
  perm: ["ai", "generate"],
  schema: z.object({}).strict(),
  handler: async (ctx) => {
    const apps = await db.jobApplication.findMany({
      where: { vendorId: ctx.vendorId, status: { in: ["NEW", "SHORTLISTED", "INTERVIEW"] } },
      orderBy: { createdAt: "desc" },
      take: 100,
      select: { id: true, name: true, status: true, openingId: true, expectedSalary: true, createdAt: true },
    })
    const openings = await db.jobOpening.findMany({
      where: { vendorId: ctx.vendorId },
      select: { id: true, title: true },
    })
    const titleOf = new Map(openings.map((o) => [o.id, o.title]))
    return {
      applications: apps.map((a) => ({
        id: a.id,
        name: a.name,
        status: a.status,
        openingTitle: titleOf.get(a.openingId) || "—",
        expectedSalary: a.expectedSalary,
        createdAt: a.createdAt.toISOString(),
      })),
    }
  },
})

// ~44 English stopwords; Bangla needs none here (Bangla function words are
// rarely ≥3-char Latin-safe tokens after the split below — and leaving them
// in only makes matching slightly noisier, never wrong).
const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "but", "for", "with", "without", "from", "to", "of", "in", "on", "at", "by",
  "as", "is", "are", "was", "were", "be", "been", "this", "that", "these", "those", "it", "its",
  "will", "shall", "can", "could", "should", "would", "must", "have", "has", "had",
  "not", "you", "your", "our", "their", "who", "what", "which", "how", "all", "any", "each", "such", "than", "then",
])

/** English/Bangla-aware tokenizer: lowercase, split on everything that is
 *  neither Latin alnum nor Bangla, keep tokens ≥ 3 chars, drop stopwords. */
function tokenize(text: string): string[] {
  return String(text || "")
    .toLowerCase()
    .split(/[^a-z0-9\u0980-\u09ff]+/)
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t))
}

type OpeningLike = { title: string; description?: string | null; requirements?: string | null }

/** Deterministic keyword score — ALWAYS runs, no LLM involved.
 *  Required-skill keywords = top 15 tokens of (title + description +
 *  requirements) by frequency; a keyword that also appears in the TITLE
 *  carries double weight (title keyword match ×2). */
function screenDeterministic(opening: OpeningLike, candidateText: string) {
  const titleTokens = new Set(tokenize(opening.title))
  const bodyTokens = [
    ...tokenize(opening.title),
    ...tokenize(opening.description || ""),
    ...tokenize(opening.requirements || ""),
  ]
  const freq = new Map<string, number>()
  for (const t of bodyTokens) freq.set(t, (freq.get(t) || 0) + 1)
  const ranked = [...freq.entries()].sort((a, b) =>
    b[1] - a[1] ||
    Number(titleTokens.has(b[0])) - Number(titleTokens.has(a[0])) ||
    a[0].localeCompare(b[0]),
  )
  const requiredKeywords = ranked.slice(0, 15).map(([t]) => t)
  const candidateTokens = new Set(tokenize(candidateText))
  const matched: string[] = []
  const missing: string[] = []
  let got = 0
  let total = 0
  for (const t of requiredKeywords) {
    const weight = titleTokens.has(t) ? 2 : 1
    total += weight
    if (candidateTokens.has(t)) {
      matched.push(t)
      got += weight
    } else {
      missing.push(t)
    }
  }
  return {
    requiredKeywords,
    matched,
    missing,
    deterministicScore: total ? Math.round((got / total) * 100) : 0,
  }
}

function normalizeStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  return v
    .filter((x): x is string => typeof x === "string" && x.trim() !== "")
    .map((x) => x.trim().slice(0, 200))
    .slice(0, 8)
}

/** Optional LLM layer: opening + cover note → zod-validated
 *  { score, strengths, concerns, summary }. */
async function llmScreenResume(cfg: AiConfig, opening: OpeningLike, candidateText: string) {
  const system = [
    "You are an HR resume-screening assistant for a multi-tenant HR system.",
    "Compare the candidate's cover note against the job opening and respond with STRICT JSON only — no markdown, no prose outside JSON — in this exact shape:",
    '{"score": <integer 0-100>, "strengths": ["at most 5 short strings"], "concerns": ["at most 5 short strings"], "summary": "one or two sentences"}',
    "Base the score purely on the evidence in the cover note relative to the opening. Be conservative: an empty, short or generic cover note scores low.",
  ].join("\n")
  const user = [
    `JOB OPENING: ${opening.title}`,
    opening.description ? `Description: ${opening.description.slice(0, 3000)}` : "",
    opening.requirements ? `Requirements: ${opening.requirements.slice(0, 2000)}` : "",
    `CANDIDATE COVER NOTE: ${candidateText.slice(0, 3000)}`,
  ]
    .filter(Boolean)
    .join("\n")
  const content = await chatCompletion(cfg, [
    { role: "system", content: system },
    { role: "user", content: user },
  ])
  const parsed = extractJsonObject(content)
  // pre-normalize the loose arrays (clamped lengths/values) so zod validates
  // the FINAL shape rather than rejecting a 6th strength outright
  const candidate = {
    score: typeof parsed.score === "number" && Number.isFinite(parsed.score) ? Math.round(parsed.score) : -1,
    strengths: normalizeStringArray(parsed.strengths),
    concerns: normalizeStringArray(parsed.concerns),
    summary: typeof parsed.summary === "string" ? parsed.summary.trim().slice(0, 600) : "",
  }
  const shape = z
    .object({
      score: z.number().int().min(0).max(100),
      strengths: z.array(z.string().max(200)).max(8),
      concerns: z.array(z.string().max(200)).max(8),
      summary: z.string().max(600),
    })
    .safeParse(candidate)
  if (!shape.success) throw new Error("the model did not return a usable screening result")
  return shape.data
}

route("ai.resumeScreen", {
  perm: ["ai", "generate"],
  schema: z.object({ applicationId: z.string().trim().min(1).max(64) }).strict(),
  handler: async (ctx, p) => {
    // Rate limit: 30 screenings per hour per user
    if (await rateLimit(`ai:screen:${ctx.vendorId}:${ctx.userId}`, 30, 3600_000)) {
      throw new Deny("Resume screening limit reached — 30 screenings per hour. Please try again later.", 429)
    }
    // vendor-scoped application + its opening (H-10 on both reads)
    const app = await db.jobApplication.findFirst({ where: { id: p.applicationId, vendorId: ctx.vendorId } })
    if (!app) throw new Deny("Job application not found", 404)
    const opening = await db.jobOpening.findFirst({ where: { id: app.openingId, vendorId: ctx.vendorId } })
    if (!opening) throw new Deny("The opening for this application no longer exists", 404)

    // cvFileId is a file reference — there is no CV text column to score, so
    // the deterministic layer uses the cover note (+ operator notes).
    const candidateText = [app.coverNote, app.notes].filter(Boolean).join("\n")
    const det = screenDeterministic(opening, candidateText)

    // Optional LLM layer — degrades cleanly: the deterministic score ALWAYS
    // comes back, an LLM failure is surfaced as llmError instead of failing
    // the route.
    let llm: { score: number; strengths: string[]; concerns: string[]; summary: string } | undefined
    let llmError: string | undefined
    const cfg = await getAiConfig(ctx.vendorId)
    if (cfg.ready && candidateText.trim() !== "") {
      try {
        llm = await llmScreenResume(cfg, opening, candidateText)
      } catch (e: any) {
        llmError = `LLM layer unavailable: ${e?.message || "the provider call failed"} — the deterministic score below is unaffected`
      }
    }

    await audit(ctx, "AI_RESUME_SCREEN", "JobApplication", app.id,
      `Screened "${app.name}" for opening "${opening.title}" — deterministic ${det.deterministicScore}/100` +
      `${llm ? `, LLM ${llm.score}/100` : ""} (prompt: screen candidate for "${opening.title.slice(0, 80)}"; ` +
      `cover note: "${candidateText.slice(0, 120)}")`)

    return {
      applicantName: app.name,
      openingTitle: opening.title,
      deterministicScore: det.deterministicScore,
      matched: det.matched,
      missing: det.missing,
      requiredKeywords: det.requiredKeywords,
      llm,
      llmUsed: !!llm,
      llmError,
    }
  },
})

// =====================================================================
// FEATURE 4 — LLM provider settings (HrSettings group "ai")
// =====================================================================
// The API key is write-only: get/save return apiKeySet (boolean) and NEVER
// the key itself. "__clear__" removes the stored key; "" keeps the existing
// one; any other non-empty string is stored encrypted (fail-closed without
// HRM_MFA_KEY, mirroring the comms-secrets policy in settings.ts).

route("ai.settings.get", {
  // AI-002 (Wave R3-3) — reading the provider config is an ai.view action,
  // aligned with every other read surface of the module.
  perm: ["ai", "view"],
  schema: z.object({}).strict(),
  handler: async (ctx) => {
    const cfg = await getAiConfig(ctx.vendorId)
    return {
      provider: cfg.provider,
      baseUrl: cfg.baseUrl,
      model: cfg.model,
      enabled: cfg.enabled,
      apiKeySet: cfg.apiKeySet,
    }
  },
})

route("ai.settings.save", {
  // AI-002 (Wave R3-3) — saving the provider endpoint/key is an ADMIN action.
  // It was gated only by ai.generate, so any AI-enabled user could repoint the
  // LLM base URL to an arbitrary https host — and resume screening then POSTed
  // candidate PII (cover notes, operator notes) there with the stored API key
  // as Bearer. settings.edit = tenant administrators (role templates grant it
  // to HR_ADMIN/VENDOR_OWNER only); ai.generate holders keep asking/screening.
  perm: ["settings", "edit"],
  schema: z
    .object({
      provider: z.string().trim().min(2).max(40).optional(),
      baseUrl: z.string().trim().max(200).optional(),
      model: z.string().trim().min(1).max(60).optional(),
      apiKey: z.string().max(400).optional(),
      enabled: z.boolean().optional(),
    })
    .strict(),
  handler: async (ctx, p) => {
    // H-10 (SSRF) — https only, public hosts only, no credentials, checked at
    // SAVE time so bad config never reaches the fetch path.
    if (typeof p.baseUrl === "string" && p.baseUrl.trim() !== "") {
      const check = validateOutboundUrl(p.baseUrl)
      if (!check.ok) throw new Deny(`LLM base URL rejected: ${check.reason}`, 400)
    }
    const patch: Record<string, unknown> = {}
    if (p.provider !== undefined) patch.provider = p.provider
    if (p.baseUrl !== undefined) patch.baseUrl = p.baseUrl.trim().replace(/\/+$/, "")
    if (p.model !== undefined) patch.model = p.model
    if (p.enabled !== undefined) patch.enabled = p.enabled

    let keyAction = "unchanged"
    if (p.apiKey !== undefined) {
      if (p.apiKey === "__clear__") {
        patch.apiKey = null
        keyAction = "removed"
      } else if (p.apiKey === "") {
        keyAction = "kept (empty submission)"
      } else {
        if (!fieldKeyConfigured()) {
          throw new Deny(
            "Cannot store the LLM API key: the server encryption key (HRM_MFA_KEY) is not configured — ask an administrator to set it",
            500,
          )
        }
        patch.apiKey = AI_ENC_PREFIX + encryptField(p.apiKey, AI_CONTEXT)
        keyAction = "stored (encrypted)"
      }
    }

    await saveSettingsGroup(ctx.vendorId, AI_SETTINGS_GROUP, patch)
    await audit(ctx, "AI_SETTINGS_SAVE", "HrSetting", `${ctx.vendorId}:${AI_SETTINGS_GROUP}`,
      `Updated AI/LLM provider settings — provider=${p.provider !== undefined ? p.provider : "(unchanged)"}, ` +
      `baseUrl=${p.baseUrl !== undefined ? p.baseUrl : "(unchanged)"}, model=${p.model !== undefined ? p.model : "(unchanged)"}, ` +
      `enabled=${p.enabled !== undefined ? p.enabled : "(unchanged)"}, apiKey ${keyAction}`)

    const cfg = await getAiConfig(ctx.vendorId)
    return {
      provider: cfg.provider,
      baseUrl: cfg.baseUrl,
      model: cfg.model,
      enabled: cfg.enabled,
      apiKeySet: cfg.apiKeySet,
    }
  },
})

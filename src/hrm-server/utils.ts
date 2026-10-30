// ============ HRM server utilities ============
import { db } from "@/lib/db"

// Form payloads (FormDialog) submit "" for untouched fields, but Prisma
// rejects empty strings for Int/Float/DateTime/relational columns.
// Convention: "" (or whitespace-only string) = not provided → drop the key.
export function cleanForm<T extends Record<string, any>>(p: T): T {
  const out: any = {}
  for (const [k, v] of Object.entries(p || {})) {
    if (typeof v === "string" && v.trim() === "") continue
    out[k] = v
  }
  return out as T
}

export function j<T>(s: string | null | undefined, fallback: T): T {
  if (!s) return fallback
  try {
    return JSON.parse(s) as T
  } catch {
    return fallback
  }
}

export function money(n: number | null | undefined): string {
  const v = Number(n || 0)
  return "৳" + v.toLocaleString("en-IN", { maximumFractionDigits: 2 })
}

export function fmtDate(iso?: string | null): string {
  if (!iso) return "—"
  const d = new Date(iso + (iso.length === 10 ? "T00:00:00" : ""))
  if (isNaN(d.getTime())) return iso
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })
}

export function fmtDateTime(d?: Date | null): string {
  if (!d) return "—"
  return new Date(d).toLocaleString("en-GB", {
    day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit",
  })
}

export const MONTHS = ["January", "February", "March", "April", "May", "June", "July",
  "August", "September", "October", "November", "December"]

export function monthName(m: number) { return MONTHS[m - 1] || "?" }

// ============ M-8/M-18 — one deployment wall clock for business dates ============
// today()/hhmm() stamp BUSINESS wall-clock values (attendance dates, punch
// times, backdated-leave gates, expense dates, payroll cutoffs). They used to
// read the SERVER-LOCAL clock, so on a UTC host every Asia/Dhaka business rule
// drifted by 6 hours: geofence check-ins between 00:00–06:00 Dhaka landed on
// the previous calendar date, and daily records split at 06:00 instead of
// midnight. The deployment offset comes from ADMS_TIMEZONE_OFFSET_HOURS — the
// SAME env the device plane already uses (gateway.ts/adapter.ts) — defaulting
// to +6 (Asia/Dhaka). Wall parts are derived with UTC getters on a shifted
// instant, so the result is identical regardless of the host's local zone
// (no double-shift on a Dhaka-local server).
export function tzOffsetHours(): number {
  const v = Number(process.env.ADMS_TIMEZONE_OFFSET_HOURS)
  return Number.isFinite(v) && v >= -12 && v <= 14 ? v : 6
}

/** Wall-clock parts of "now" (or a given instant) in the deployment zone. */
export function zonedParts(d: Date = new Date(), offsetHours = tzOffsetHours()) {
  const shifted = new Date(d.getTime() + offsetHours * 3600_000)
  return {
    y: shifted.getUTCFullYear(),
    m: shifted.getUTCMonth() + 1,
    d: shifted.getUTCDate(),
    hh: String(shifted.getUTCHours()).padStart(2, "0"),
    mm: String(shifted.getUTCMinutes()).padStart(2, "0"),
  }
}

/** True instant of a deployment-zone WALL-CLOCK string ("YYYY-MM-DDTHH:mm[:ss]"). */
export function fromZonedWall(wall: string, offsetHours = tzOffsetHours()): Date {
  const t = Date.parse(`${wall.length === 16 ? wall + ":00" : wall}Z`)
  return new Date(t - offsetHours * 3600_000)
}

export function today(): string {
  const p = zonedParts()
  return `${p.y}-${String(p.m).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`
}

export function isoDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
}

export function addDays(iso: string, days: number): string {
  const d = new Date(iso + "T00:00:00")
  d.setDate(d.getDate() + days)
  return isoDate(d)
}

/** MON-11 (Phase 4) — add CALENDAR months to an ISO date with end-of-month
 *  clamping: Jan 31 + 1 = Feb 28/29, Mar 31 + 1 = Apr 30. This is the EMI
 *  scheduling primitive — the legacy addDays(start, i × 30) drifted ~5 days
 *  per real year, eventually landing February EMIs in March where payroll's
 *  month-prefix budgeting (dueDate.slice(0, 7)) never picked them up (the
 *  daily job then marked them OVERDUE while money was available). */
export function addMonthsIso(iso: string, months: number): string {
  const [y, m, d] = iso.split("-").map(Number)
  if (!y || !m || !d || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso
  const total = (y * 12 + (m - 1)) + months
  const ny = Math.floor(total / 12)
  const nm = total % 12 + 1
  const lastDay = new Date(Date.UTC(ny, nm, 0)).getUTCDate() // day 0 of next month
  const nd = Math.min(d, lastDay)
  return `${ny}-${String(nm).padStart(2, "0")}-${String(nd).padStart(2, "0")}`
}

export function daysBetween(a: string, b: string): number {
  const d1 = new Date(a + "T00:00:00").getTime()
  const d2 = new Date(b + "T00:00:00").getTime()
  return Math.round((d2 - d1) / 86400000)
}

/** EMP-08 (R7) — probation end date in CALENDAR months (the audit caught the
 *  old `joining + months × 30` math drifting up to ~2 weeks: a 3-month
 *  probation starting Nov 30 ended "Mar 1" as 90×24h days, not 3 calendar
 *  months). End-of-month clamping follows addMonthsIso (Jan 31 + 1 → Feb 28).
 *  Null when the employee has no probation (no joining date / zero months /
 *  already confirmed — pass confirmationDate to short-circuit). */
export function probationEndDate(joiningDate: string | null | undefined, probationMonths: number | null | undefined, confirmationDate?: string | null): string | null {
  if (!joiningDate) return null
  const months = Math.max(0, Number(probationMonths) || 0)
  if (months <= 0) return null
  if (confirmationDate) return null // confirmed — no pending probation end
  return addMonthsIso(joiningDate, months)
}

/** Leave days between two dates (inclusive). `weeklyOff` skips the named
 *  weekdays; `holidays` (L-9) additionally skips vendor/company holiday DATES
 *  when the vendor opts out of counting holidays as leave consumption. */
export function leaveDaysBetween(from: string, to: string, weeklyOff: string[] = [], holidays: string[] = []): number {
  let count = 0
  const wd = ["SUNDAY", "MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY"]
  const skip = new Set(holidays)
  let cur = from
  let guard = 0
  while (cur <= to && guard < 500) {
    const d = new Date(cur + "T00:00:00").getDay()
    if (!weeklyOff.includes(wd[d]) && !skip.has(cur)) count++
    cur = addDays(cur, 1)
    guard++
  }
  return count
}

export function weekdaysInMonth(year: number, month: number, weeklyOff: string[] = []): number {
  const days = new Date(year, month, 0).getDate()
  const wd = ["SUNDAY", "MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY"]
  let count = 0
  for (let i = 1; i <= days; i++) {
    const d = new Date(year, month - 1, i).getDay()
    if (!weeklyOff.includes(wd[d])) count++
  }
  return count
}

/** 2026-10-13 — canonical weekly-off resolution (ONE rule in every engine).
 *
 * Precedence — the most specific assignment wins:
 *   1. Employee profile  (Employee Directory → Edit Profile → Weekly Off Day(s))
 *   2. Shift             (Attendance & Shifts → Shifts & Roster → Weekly Off Day(s))
 *   3. Global policy     (HR Settings → Workspace → General → General Policy → Weekly Holiday)
 *
 * Before this helper the engines disagreed: the payroll engine resolved
 * shift > employee > settings, while leave, reports, the daily jobs sweep and
 * exit settlement resolved employee > settings and IGNORED the shift — the
 * same employee could get different off days in different modules. Every
 * consumer now calls this helper, so the answer to "which way overrides
 * which" is the same everywhere: employee beats shift beats global policy.
 *
 * Inputs are the raw stored values (Employee.weeklyOff / Shift.weeklyOff are
 * comma- or space-joined weekday names; the settings field is a string[]).
 * Empty/absent values fall through to the next level; [] means "no weekly off
 * configured anywhere" (every day is a working day). */
export function resolveWeeklyOffDays(
  empWeeklyOff: string | null | undefined,
  shiftWeeklyOff: string | null | undefined,
  settingsWeeklyHoliday: readonly string[] | null | undefined,
): string[] {
  const parse = (v: string | null | undefined): string[] =>
    (v || "").split(/[,\s]+/).map((s) => s.trim().toUpperCase()).filter(Boolean)
  const fromEmp = parse(empWeeklyOff)
  if (fromEmp.length) return fromEmp
  const fromShift = parse(shiftWeeklyOff)
  if (fromShift.length) return fromShift
  return (settingsWeeklyHoliday ?? []).map((s) => String(s).trim().toUpperCase()).filter(Boolean)
}

export function minutesToHHMM(m: number): string {
  if (!m) return "0h"
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

/** M-8/M-18 — with no argument, the CURRENT deployment-zone wall time (the
 *  server-local default made UTC-host punch times read 6h early). An explicit
 *  Date argument keeps its existing (local-getter) semantics for callers
 *  passing pre-computed instants. */
export function hhmm(d?: Date): string {
  if (!d) {
    const p = zonedParts()
    return `${p.hh}:${p.mm}`
  }
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`
}

export function timeToMinutes(t?: string | null): number {
  if (!t) return 0
  const [h, m] = t.split(":").map(Number)
  return h * 60 + (m || 0)
}

export function csv(rows: (string | number | null | undefined)[][]): string {
  return rows
    .map((r) => r.map((c) => {
      let s = c == null ? "" : String(c)
      // M-8 — spreadsheet formula injection: prefix cells that start with an
      // formula operator so Excel/Sheets renders them as text, never executes them.
      if (/^[=+\-@\t\r]/.test(s)) s = "'" + s
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
    }).join(","))
    .join("\n")
}

export function paginate<T>(arr: T[], page = 1, size = 50) {
  const start = (page - 1) * size
  return { items: arr.slice(start, start + size), total: arr.length, page, size }
}

/** M-22 — race-safe sequential code generation.
 *  The old count+1 approach duplicated codes whenever two creates raced.
 *  This uses the SequenceCounter table with a single-statement atomic upsert
 *  (the update branch increments, the create branch seeds at 1) — no
 *  caught-P2025 `prisma:error` noise on a key's first-ever use, and no retry
 *  loop that can burn attempts. */
export async function nextSeq(vendorId: string, prefix: string, _model: string, _field = "code"): Promise<string> {
  const key = `${vendorId}:${prefix}`
  const counter = await db.sequenceCounter.upsert({
    where: { key },
    update: { value: { increment: 1 } },
    create: { key, value: 1 },
    select: { value: true },
  })
  return `${prefix}${String(counter.value).padStart(4, "0")}`
}

/** M-22 — race-safe formatted sequence (e.g. letter numbers L-2026-0042). */
export async function nextFormattedSeq(vendorId: string, scope: string, format: (n: number) => string): Promise<string> {
  const key = `${vendorId}:${scope}`
  const counter = await db.sequenceCounter.upsert({
    where: { key },
    update: { value: { increment: 1 } },
    create: { key, value: 1 },
    select: { value: true },
  })
  return format(counter.value)
}

export function titleCase(s?: string | null): string {
  if (!s) return "—"
  return s.replace(/_/g, " ").toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase())
}

export function pct(n: number, d: number): number {
  if (!d) return 0
  return Math.round((n / d) * 1000) / 10
}

// ---------- M-14 — duplicate-submission guard ----------
/** True when an identical record was created by the same actor very recently
 *  (default 90 seconds) — the classic double-click / double-submit window.
 *  Matches on the caller's natural key fields per action. */
// ============ M-11 — employee reference select for list joins ============
// The audit found list endpoints fetching FULL employee rows (including the
// base64 photoUrl/photoThumb columns, up to 2 MB each) just to render a name.
// List joins use this select instead: identity + org placement only, no
// photos, no addresses, no documents. (The directory grid that legitimately
// shows thumbnails keeps its own dedicated fetch with pagination.)
export const EMPLOYEE_REF_SELECT = {
  id: true, code: true, fullName: true,
  branchId: true, departmentId: true, designationId: true, shiftId: true,
  status: true, employmentType: true, mobile: true, officialEmail: true,
} as const

export function withinDuplicateWindow(createdAt: Date | string | null | undefined, windowMs = 90_000): boolean {
  if (!createdAt) return false
  return Date.now() - new Date(createdAt).getTime() < windowMs
}

// ============ HIGH-5 (this audit) — standardized daily rate helper ============
// The audit found THREE different "daily rate" conventions across modules:
//   - payroll.ts:249    used structure.gross / monthWorkingDays
//   - leave.ts:534      used structure.gross / 26 (hardcoded)
//   - exit.ts:189,259   used structure.gross / 30
// This caused inconsistency: an employee with gross ৳30,000 and a 26-working-day
// month was deducted ৳1,153.85/day in payroll but paid ৳1,000/day in final
// settlement. The unified helper uses `gross / workingDaysInMonth` with a
// vendor-configurable working-days-in-month default (26 — BD standard).
//
// `workingDaysInMonth` may be supplied by the caller (payroll knows it
// precisely for the actual run month). Default 26 for leave encashment and
// final settlement where the caller does not have a precise calendar.

export const DEFAULT_WORKING_DAYS_PER_MONTH = 26

/** HIGH-5 — unified daily rate = gross / workingDaysInMonth.
 *  Returns 0 if gross ≤ 0 or workingDays ≤ 0 (avoids NaN/Infinity).
 *  `workingDaysInMonth` defaults to 26 (BD standard) if not supplied. */
export function dailyRate(gross: number, workingDaysInMonth: number = DEFAULT_WORKING_DAYS_PER_MONTH): number {
  if (!Number.isFinite(gross) || gross <= 0) return 0
  if (!Number.isFinite(workingDaysInMonth) || workingDaysInMonth <= 0) return 0
  return gross / workingDaysInMonth
}

/** Round to the nearest paisa — useful for callers that round dailyRate
 *  computations to avoid floating-point drift (mirrors H-09 zero-tolerance). */
export function roundPaisa(n: number): number {
  if (!Number.isFinite(n)) return 0
  return Math.round(n * 100) / 100
}


/** ATT-008 — per-date shift resolution (the ONE rule every engine uses).
 *  Rotating employees carry dated shift assignments; three engines used to
 *  answer "which shift did this employee work on date X" three different ways
 *  (attendance: per-date; payroll: the period-end assignment; OT register:
 *  the employee's default shift) — three answers for the same day, so the OT
 *  tier a day was paid at could differ from the tier its estimate showed.
 *  All assignments must be pre-sorted by fromDate DESC (latest-starting
 *  wins), exactly like the SQL fetches order them. */
export function resolveShiftAssignmentForDate(
  assignments: { shiftId: string; fromDate: string; toDate: string | null }[] | undefined,
  defaultShiftId: string | null | undefined,
  date: string,
): string | null {
  if (assignments && assignments.length) {
    for (const a of assignments) {
      if (a.fromDate <= date && (a.toDate == null || a.toDate >= date)) return a.shiftId
    }
  }
  return defaultShiftId ?? null
}

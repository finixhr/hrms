// ============ Dynamic attendance/tracking policy engine (2026-10 round §6–§7) ============
// ONE reusable policy system instead of per-feature hard-coded settings.
//
// Scope priority (deterministic, §6):
//   EMPLOYEE (4) > DEPARTMENT (3) > BRANCH (2) > ALL_EMPLOYEES (1)
// Inside one scope level, `priority` breaks ties (higher wins). The effective
// policy is ALWAYS resolved server-side from the authenticated employee's own
// org anchors — the client never supplies policyId/branchId/departmentId.
//
// Schedule (§7): every policy carries an optional date range, daily time
// window and weekday set evaluated against the SERVER clock in the policy's
// timezone (default Asia/Dhaka). The employee device clock is never
// authoritative.
import { db } from "@/lib/db"
import { j } from "./utils"

export const POLICY_TYPES = ["TRACKING", "MANDATORY_GPS", "MULTIPLE_CHECKIN", "ATTENDANCE_METHOD", "ATTENDANCE_RULES"] as const
export type PolicyType = (typeof POLICY_TYPES)[number]

export type PolicyRecord = {
  id: string
  vendorId: string
  name: string
  policyType: string
  priority: number
  startDate: string | null
  endDate: string | null
  startTime: string | null
  endTime: string | null
  daysOfWeek: string
  timezone: string
  active: boolean
  configJson: string
}

const SCOPE_RANK: Record<string, number> = { EMPLOYEE: 4, DEPARTMENT: 3, BRANCH: 2, ALL_EMPLOYEES: 1 }

/** Server-clock schedule evaluation. `now` is injectable for tests. */
export function policyInSchedule(p: PolicyRecord, at: Date = new Date()): boolean {
  if (!p.active) return false
  // Date range (calendar dates, evaluated in the policy timezone)
  const tz = p.timezone || "Asia/Dhaka"
  const local = zonedParts(at, tz)
  const iso = `${local.y}-${local.m}-${local.d}`
  if (p.startDate && iso < p.startDate) return false
  if (p.endDate && iso > p.endDate) return false
  // Weekday set
  const days = (p.daysOfWeek || "").split(",").map((x) => x.trim().toUpperCase()).filter(Boolean)
  if (days.length && !days.includes(local.weekday)) return false
  // Daily time window (minutes since local midnight; null window = all day)
  if (p.startTime && p.endTime) {
    const s = hhmmToMin(p.startTime)
    const e = hhmmToMin(p.endTime)
    if (s != null && e != null) {
      const nowMin = local.h * 60 + local.min
      // Window may cross midnight (e.g. 22:00–06:00)
      const inside = s <= e ? nowMin >= s && nowMin <= e : nowMin >= s || nowMin <= e
      if (!inside) return false
    }
  }
  return true
}

function hhmmToMin(t: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(t.trim())
  return m ? Number(m[1]) * 60 + Number(m[2]) : null
}

/** Local calendar parts in a named timezone (Intl-based; works in Bun/Node). */
export function zonedParts(at: Date, tz: string): { y: string; m: string; d: string; weekday: string; h: number; min: number } {
  try {
    const fmt = new Intl.DateTimeFormat("en-GB", {
      timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
      weekday: "long", hour: "2-digit", minute: "2-digit", hour12: false,
    })
    const parts: Record<string, string> = {}
    for (const p of fmt.formatToParts(at)) parts[p.type] = p.value
    return {
      y: parts.year, m: parts.month, d: parts.day,
      weekday: (parts.weekday || "").toUpperCase(),
      h: Number(parts.hour === "24" ? "0" : parts.hour),
      min: Number(parts.minute || "0"),
    }
  } catch {
    // Unknown timezone identifier — fall back to UTC parts
    return {
      y: String(at.getUTCFullYear()), m: String(at.getUTCMonth() + 1).padStart(2, "0"), d: String(at.getUTCDate()).padStart(2, "0"),
      weekday: ["SUNDAY", "MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY"][at.getUTCDay()],
      h: at.getUTCHours(), min: at.getUTCMinutes(),
    }
  }
}

export type EffectivePolicyInfo = {
  policy: PolicyRecord
  config: Record<string, unknown>
  /** Where the resolution came from — surfaced in the UI (§6): Employee /
   *  Department / Branch / Global. */
  source: "Employee" | "Department" | "Branch" | "Global"
  scopeType: string
}

/**
 * Resolve the effective policy of one type for an employee: the highest-ranked
 * assignment scope wins; `priority` breaks ties inside a scope level; only
 * policies whose schedule currently applies are eligible. When several
 * same-scope policies are simultaneously in schedule, the highest priority
 * one is THE effective policy (§6: deterministic).
 */
export async function resolveEffectivePolicy(
  vendorId: string,
  employee: { id: string; branchId?: string | null; departmentId?: string | null },
  policyType: PolicyType,
  at: Date = new Date()
): Promise<EffectivePolicyInfo | null> {
  const assignments = await db.attendancePolicyAssignment.findMany({
    where: {
      vendorId,
      OR: [
        { scopeType: "ALL_EMPLOYEES" },
        { scopeType: "EMPLOYEE", scopeId: employee.id },
        ...(employee.branchId ? [{ scopeType: "BRANCH", scopeId: employee.branchId }] : []),
        ...(employee.departmentId ? [{ scopeType: "DEPARTMENT", scopeId: employee.departmentId }] : []),
      ],
    },
    include: { policy: true },
  })
  const candidates = assignments
    .filter((a) => a.policy.active && a.policy.policyType === policyType && policyInSchedule(a.policy as PolicyRecord, at))
    .map((a) => ({
      a,
      rank: SCOPE_RANK[a.scopeType] ?? 0,
      prio: a.policy.priority ?? 0,
    }))
  if (!candidates.length) return null
  candidates.sort((x, y) => y.rank - x.rank || y.prio - x.prio)
  const winner = candidates[0].a
  const sourceMap: Record<string, EffectivePolicyInfo["source"]> = {
    EMPLOYEE: "Employee", DEPARTMENT: "Department", BRANCH: "Branch", ALL_EMPLOYEES: "Global",
  }
  return {
    policy: winner.policy as PolicyRecord,
    config: j(winner.policy.configJson, {}),
    source: sourceMap[winner.scopeType] ?? "Global",
    scopeType: winner.scopeType,
  }
}

/** Effective policies of a type for MANY employees in one pass (live map). */
export async function resolveEffectivePoliciesForEmployees(
  vendorId: string,
  employees: { id: string; branchId?: string | null; departmentId?: string | null }[],
  policyType: PolicyType,
  at: Date = new Date()
): Promise<Map<string, EffectivePolicyInfo>> {
  const out = new Map<string, EffectivePolicyInfo>()
  const assignments = await db.attendancePolicyAssignment.findMany({
    where: { vendorId, policy: { policyType, active: true } },
    include: { policy: true },
  })
  const byScope = new Map<string, typeof assignments>()
  for (const a of assignments) {
    const key = a.scopeType === "ALL_EMPLOYEES" ? "ALL" : `${a.scopeType}:${a.scopeId}`
    const bucket = byScope.get(key)
    if (bucket) bucket.push(a)
    else byScope.set(key, [a])
  }
  for (const emp of employees) {
    const keys = [`ALL`, `BRANCH:${emp.branchId ?? ""}`, `DEPARTMENT:${emp.departmentId ?? ""}`, `EMPLOYEE:${emp.id}`]
    let best: { a: (typeof assignments)[number]; rank: number } | null = null
    for (let i = 0; i < keys.length; i++) {
      const rank = i + 1 // ALL=1 BRANCH=2 DEPARTMENT=3 EMPLOYEE=4
      for (const a of byScope.get(keys[i]) ?? []) {
        if (!policyInSchedule(a.policy as PolicyRecord, at)) continue
        if (!best || rank > best.rank || (rank === best.rank && (a.policy.priority ?? 0) > (best.a.policy.priority ?? 0))) {
          best = { a, rank }
        }
      }
    }
    if (best) {
      const sourceMap: Record<string, EffectivePolicyInfo["source"]> = {
        EMPLOYEE: "Employee", DEPARTMENT: "Department", BRANCH: "Branch", ALL_EMPLOYEES: "Global",
      }
      out.set(emp.id, {
        policy: best.a.policy as PolicyRecord,
        config: j(best.a.policy.configJson, {}),
        source: sourceMap[best.a.scopeType] ?? "Global",
        scopeType: best.a.scopeType,
      })
    }
  }
  return out
}

// ---------- typed policy configs (validated at save + consumed at run) ----------

export type TrackingConfig = {
  updateIntervalSec: number // location ping frequency (§11)
  maxAccuracyM: number // accepted GPS accuracy for fence validation (§23)
  lowBatteryThreshold: number // % — LOW_BATTERY state + alert (§14)
  criticalBatteryThreshold: number // % — critical alert + event (§14)
  offlineAfterMinutes: number // no-update period → OFFLINE (§15)
  suspiciousAction: "ALLOW" | "WARN" | "REVIEW" | "REJECT" // §25
}

export type MandatoryGpsConfig = { graceMinutes: number }

export type MultipleCheckinConfig = {
  minIntervalMinutes: number // duplicate/too-soon prevention (§31)
  maxPerDay: number // daily cap
  methods: string[] // allowed methods for periodic checks (§30)
}

export type AttendanceMethodConfig = {
  methods: string[] // allowed check-in methods: GEOFENCE | SELFIE | GEOFENCE_SELFIE | DEVICE_PUNCH
  selfieRequired: boolean
  requireGeofence: boolean
  /** G2 — device binding enforcement at punch time:
   *  OFF — deviceId recorded only (historical behaviour)
   *  ADVISORY — unenrolled/foreign device still punches but the event is
   *             flagged DEVICE_MISMATCH for review
   *  STRICT — only an ACTIVE enrolled device may punch (403 otherwise) */
  deviceBinding: "OFF" | "ADVISORY" | "STRICT"
}

export const DEFAULT_TRACKING_CONFIG: TrackingConfig = {
  updateIntervalSec: 60, maxAccuracyM: 150, lowBatteryThreshold: 20, criticalBatteryThreshold: 10,
  offlineAfterMinutes: 15, suspiciousAction: "REVIEW",
}
export const DEFAULT_MANDATORY_GPS_CONFIG: MandatoryGpsConfig = { graceMinutes: 5 }
export const DEFAULT_MULTIPLE_CHECKIN_CONFIG: MultipleCheckinConfig = { minIntervalMinutes: 60, maxPerDay: 10, methods: ["GEOFENCE", "SELFIE", "GEOFENCE_SELFIE", "DEVICE_PUNCH"] }
export const DEFAULT_ATTENDANCE_METHOD_CONFIG: AttendanceMethodConfig = { methods: ["GEOFENCE", "DEVICE_PUNCH"], selfieRequired: false, requireGeofence: false, deviceBinding: "OFF" }

// ---------- ATT-017 (R7) — day-level attendance rules as an assignable policy ----------
// Late / early-leave / half-day / daily-OT knobs previously lived ONLY in
// tenant-wide Settings — the audit's finding: "late/early-leave/OT rules not
// configurable per employee or group". The ATTENDANCE_RULES policy type
// carries those knobs per group (ALL_EMPLOYEES / BRANCH / DEPARTMENT /
// EMPLOYEE via the standard assignment precedence) and the punch engines
// merge it over the settings defaults (a null field inherits the setting).
export type AttendanceRulesConfig = {
  /** Grace minutes before LATE (null = inherit settings.latePolicy.graceMinutes) */
  graceMinutes: number | null
  /** Early-leave threshold minutes (null = inherit settings.earlyLeavePolicy.thresholdMinutes) */
  earlyLeaveThresholdMinutes: number | null
  /** Hours below which a checked-out day flips to HALF_DAY (null = inherit settings.attendance.halfDayHours) */
  halfDayHours: number | null
  /** Daily overtime cap in hours, 0 = statutory uncapped is NOT allowed —
   *  the engine default applies; null = inherit settings.shift.maxOtHoursPerDay */
  maxOtHoursPerDay: number | null
}
export const DEFAULT_ATTENDANCE_RULES_CONFIG: AttendanceRulesConfig = {
  graceMinutes: null, earlyLeaveThresholdMinutes: null, halfDayHours: null, maxOtHoursPerDay: null,
}

export function trackingConfig(cfg: Record<string, unknown> | null | undefined): TrackingConfig {
  return { ...DEFAULT_TRACKING_CONFIG, ...(cfg ?? {}) } as TrackingConfig
}
export function mandatoryGpsConfig(cfg: Record<string, unknown> | null | undefined): MandatoryGpsConfig {
  return { ...DEFAULT_MANDATORY_GPS_CONFIG, ...(cfg ?? {}) } as MandatoryGpsConfig
}
export function multipleCheckinConfig(cfg: Record<string, unknown> | null | undefined): MultipleCheckinConfig {
  return { ...DEFAULT_MULTIPLE_CHECKIN_CONFIG, ...(cfg ?? {}) } as MultipleCheckinConfig
}
export function attendanceMethodConfig(cfg: Record<string, unknown> | null | undefined): AttendanceMethodConfig {
  return { ...DEFAULT_ATTENDANCE_METHOD_CONFIG, ...(cfg ?? {}) } as AttendanceMethodConfig
}
export function attendanceRulesConfig(cfg: Record<string, unknown> | null | undefined): AttendanceRulesConfig {
  return { ...DEFAULT_ATTENDANCE_RULES_CONFIG, ...(cfg ?? {}) } as AttendanceRulesConfig
}

/** ATT-017 — resolve ONE employee's effective day-rules policy config (or
 *  null when no active ATTENDANCE_RULES policy matches them). Callers merge
 *  the non-null fields over the settings-derived bundle. */
export async function attendanceRulesForEmployee(
  vendorId: string,
  employee: { id: string; branchId?: string | null; departmentId?: string | null },
): Promise<AttendanceRulesConfig | null> {
  const policy = await resolveEffectivePolicy(vendorId, employee as any, "ATTENDANCE_RULES")
  if (!policy) return null
  return attendanceRulesConfig(policy.config ?? {})
}

/** ATT-017 — the full day-rules bundle for one employee: the tenant-wide
 *  settings overlaid with their effective ATTENDANCE_RULES policy (a policy
 *  field set to null/absent inherits the setting). One shared shape for every
 *  punch engine call site — the bundle computeAttendance expects. */
export async function dayRulesBundle(
  vendorId: string,
  employee: { id: string; branchId?: string | null; departmentId?: string | null },
  settings: { latePolicy?: { graceMinutes?: number } | null; earlyLeavePolicy?: { thresholdMinutes?: number } | null; attendance?: { halfDayHours?: number } | null; shift?: { maxOtHoursPerDay?: number } | null },
): Promise<{ graceMinutes?: number; earlyLeaveThresholdMinutes?: number; halfDayHours: number; maxOtMinutesPerDay: number; rulesPolicy?: boolean; halfDayHoursPolicy?: number }> {
  const rules = await attendanceRulesForEmployee(vendorId, employee).catch(() => null)
  const maxOtHours = rules?.maxOtHoursPerDay != null ? rules.maxOtHoursPerDay : Number((settings as any).shift?.maxOtHoursPerDay) || 0
  return {
    graceMinutes: rules?.graceMinutes ?? settings.latePolicy?.graceMinutes,
    earlyLeaveThresholdMinutes: rules?.earlyLeaveThresholdMinutes ?? settings.earlyLeavePolicy?.thresholdMinutes,
    halfDayHours: rules?.halfDayHours ?? settings.attendance?.halfDayHours ?? 4,
    maxOtMinutesPerDay: maxOtHours * 60,
    // ATT-017 — markers the engine uses to let policy fields override the shift
    rulesPolicy: !!rules && Object.values(rules ?? {}).some((x) => x != null),
    halfDayHoursPolicy: rules?.halfDayHours ?? undefined,
  }
}

// ============ System built-in KPI indicator registry (2026-11 redesign) ============
// Built-in indicators retrieve REAL data from existing Finix HR modules —
// never hardcoded or fabricated values. Every computation respects the
// selected reporting period (start/end ISO dates) and the tenant/company +
// employee boundaries passed by the caller (the routes always pass employees
// already scope-checked via assertEmployeeVisible).
//
// Registry contract:
//   - key is stable and versioned with the app (stored on KpiIndicator.builtinKey)
//   - compute() returns null when the source data is unavailable/empty — the
//     scoring engine treats null as "missing data" (excluded from the weighted
//     average), NEVER as zero
//   - PERCENT indicators return 0–100 already
import { db } from "@/lib/db"
import type { KpiDirection, KpiUnit } from "./constants"

export type BuiltinComputeCtx = {
  vendorId: string
  employeeId: string
  start: string // ISO date (inclusive)
  end: string // ISO date (inclusive)
}

export type BuiltinIndicatorDef = {
  key: string
  label: string
  description: string
  unit: KpiUnit
  direction: KpiDirection
  defaultTarget: number
  compute: (ctx: BuiltinComputeCtx) => Promise<number | null>
}

// Attendance statuses that count as "present-ish" for compliance — mirrors the
// payroll-day math (payroll.ts) and the canonical attendance-rate helper in
// routes/reports.ts (RATE_NOT_COUNTED = ABSENT, LEAVE, LEAVE_UNPAID, HOLIDAY,
// WEEKLY_OFF — everything else counted).
const PRESENTISH = ["PRESENT", "LATE", "EARLY_LEAVE", "HALF_DAY", "WFH", "BUSINESS_TRIP"]
const NOT_EXPECTED = ["HOLIDAY", "WEEKLY_OFF"]

const pct = (n: number, d: number): number | null => (d <= 0 ? null : Math.round((n / d) * 1000) / 10)

const endOfDay = (end: string) => new Date(`${end}T23:59:59.999Z`)

export const BUILTIN_INDICATORS: BuiltinIndicatorDef[] = [
  {
    key: "attendance.compliance",
    label: "Attendance Compliance %",
    description: "Present-ish days ÷ expected working days in the period (holidays and weekly-offs excluded from the denominator). Source: Attendance.",
    unit: "PERCENT",
    direction: "HIGHER_IS_BETTER",
    defaultTarget: 95,
    compute: async ({ vendorId, employeeId, start, end }) => {
      const rows = await db.attendance.groupBy({
        by: ["status"],
        where: { vendorId, employeeId, date: { gte: start, lte: end } },
        _count: { _all: true },
      })
      const byStatus = new Map(rows.map((r) => [r.status, r._count._all]))
      const expected = rows
        .filter((r) => !NOT_EXPECTED.includes(r.status))
        .reduce((s, r) => s + r._count._all, 0)
      const presentish = PRESENTISH.reduce((s, st) => s + (byStatus.get(st) || 0), 0)
      return pct(presentish, expected)
    },
  },
  {
    key: "attendance.onTime",
    label: "On-time Attendance %",
    description: "Non-late present days ÷ all present-ish days in the period. Source: Attendance (LATE status).",
    unit: "PERCENT",
    direction: "HIGHER_IS_BETTER",
    defaultTarget: 90,
    compute: async ({ vendorId, employeeId, start, end }) => {
      const rows = await db.attendance.groupBy({
        by: ["status"],
        where: { vendorId, employeeId, date: { gte: start, lte: end } },
        _count: { _all: true },
      })
      const byStatus = new Map(rows.map((r) => [r.status, r._count._all]))
      const presentish = PRESENTISH.reduce((s, st) => s + (byStatus.get(st) || 0), 0)
      const late = byStatus.get("LATE") || 0
      return pct(presentish - late, presentish)
    },
  },
  {
    key: "attendance.lateCount",
    label: "Late Attendance Count",
    description: "Number of LATE attendance days in the period. Lower is better. Source: Attendance.",
    unit: "NUMBER",
    direction: "LOWER_IS_BETTER",
    defaultTarget: 2,
    compute: async ({ vendorId, employeeId, start, end }) => {
      const c = await db.attendance.count({
        where: { vendorId, employeeId, status: "LATE", date: { gte: start, lte: end } },
      })
      return c
    },
  },
  {
    key: "leave.utilization",
    label: "Leave Utilization %",
    description: "Leave days used ÷ entitled days for the leave year of the period end. Exact-target scoring — utilizing entitlement without exceeding it. Source: Leave Management (LeaveBalance).",
    unit: "PERCENT",
    direction: "EXACT_TARGET",
    defaultTarget: 90,
    compute: async ({ vendorId, employeeId, end }) => {
      const year = Number(end.slice(0, 4))
      if (!Number.isFinite(year)) return null
      const balances = await db.leaveBalance.findMany({
        where: { vendorId, employeeId, year },
        select: { entitled: true, used: true },
      })
      if (!balances.length) return null
      const entitled = balances.reduce((s, b) => s + (Number(b.entitled) || 0), 0)
      const used = balances.reduce((s, b) => s + (Number(b.used) || 0), 0)
      return pct(used, entitled)
    },
  },
  {
    key: "fieldforce.compliance",
    label: "Field Force Tracking Compliance %",
    description: "Visits with a valid GPS check-in ÷ all non-cancelled visits in the period. Returns no value when the employee had no visits. Source: Field Force Tracking (Visit).",
    unit: "PERCENT",
    direction: "HIGHER_IS_BETTER",
    defaultTarget: 95,
    compute: async ({ vendorId, employeeId, start, end }) => {
      const rows = await db.visit.findMany({
        where: {
          vendorId,
          employeeId,
          checkInAt: { gte: new Date(`${start}T00:00:00.000Z`), lte: endOfDay(end) },
          status: { not: "CANCELLED" },
        },
        select: { checkInLat: true },
      })
      if (!rows.length) return null
      const withGps = rows.filter((v) => v.checkInLat != null).length
      return pct(withGps, rows.length)
    },
  },
]

const BY_KEY = new Map(BUILTIN_INDICATORS.map((d) => [d.key, d]))

export function getBuiltinIndicator(key: string): BuiltinIndicatorDef | undefined {
  return BY_KEY.get(key)
}

/** Registry view for the frontend (no compute functions). */
export function builtinIndicatorCatalog() {
  return BUILTIN_INDICATORS.map(({ key, label, description, unit, direction, defaultTarget }) => ({
    key, label, description, unit, direction, defaultTarget,
  }))
}

/** Compute a built-in indicator value for one employee + period window.
 * Unknown keys / source-data gaps → null (missing data — never fabricated). */
export async function computeBuiltinIndicator(
  key: string,
  ctx: BuiltinComputeCtx,
): Promise<number | null> {
  const def = BY_KEY.get(key)
  if (!def) return null
  try {
    return await def.compute(ctx)
  } catch {
    // a source-module outage must never break achievement entry — the value
    // degrades to "missing" and the admin can enter it manually
    return null
  }
}

/** Batch variant: computes one indicator for many employees efficiently
 * (used by the bulk achievement Excel pre-fill). Returns employeeId → value. */
export async function computeBuiltinForEmployees(
  key: string,
  vendorId: string,
  employeeIds: string[],
  start: string,
  end: string,
): Promise<Map<string, number | null>> {
  const out = new Map<string, number | null>()
  if (!employeeIds.length) return out
  const def = BY_KEY.get(key)
  if (!def) return out
  try {
    if (key === "attendance.compliance" || key === "attendance.onTime" || key === "attendance.lateCount") {
      const rows = await db.attendance.groupBy({
        by: ["employeeId", "status"],
        where: { vendorId, employeeId: { in: employeeIds }, date: { gte: start, lte: end } },
        _count: { _all: true },
      })
      const per = new Map<string, Map<string, number>>()
      for (const r of rows) {
        if (!per.has(r.employeeId)) per.set(r.employeeId, new Map())
        const byStatus = per.get(r.employeeId)
        if (byStatus) byStatus.set(r.status, r._count._all)
      }
      for (const eid of employeeIds) {
        const byStatus = per.get(eid)
        if (!byStatus || !byStatus.size) { out.set(eid, null); continue }
        if (key === "attendance.lateCount") {
          out.set(eid, byStatus.get("LATE") || 0)
          continue
        }
        const expected = [...byStatus.entries()]
          .filter(([st]) => !NOT_EXPECTED.includes(st))
          .reduce((s, [, c]) => s + c, 0)
        const presentish = PRESENTISH.reduce((s, st) => s + (byStatus.get(st) || 0), 0)
        out.set(eid, key === "attendance.onTime" ? pct(presentish - (byStatus.get("LATE") || 0), presentish) : pct(presentish, expected))
      }
      return out
    }
    if (key === "leave.utilization") {
      const year = Number(end.slice(0, 4))
      const balances = await db.leaveBalance.findMany({
        where: { vendorId, employeeId: { in: employeeIds }, year },
        select: { employeeId: true, entitled: true, used: true },
      })
      const per = new Map<string, { entitled: number; used: number }>()
      for (const b of balances) {
        const acc = per.get(b.employeeId) || { entitled: 0, used: 0 }
        acc.entitled += Number(b.entitled) || 0
        acc.used += Number(b.used) || 0
        per.set(b.employeeId, acc)
      }
      for (const eid of employeeIds) {
        const b = per.get(eid)
        out.set(eid, b ? pct(b.used, b.entitled) : null)
      }
      return out
    }
    if (key === "fieldforce.compliance") {
      const rows = await db.visit.findMany({
        where: {
          vendorId, employeeId: { in: employeeIds },
          checkInAt: { gte: new Date(`${start}T00:00:00.000Z`), lte: endOfDay(end) },
          status: { not: "CANCELLED" },
        },
        select: { employeeId: true, checkInLat: true },
      })
      const per = new Map<string, { total: number; gps: number }>()
      for (const v of rows) {
        const acc = per.get(v.employeeId) || { total: 0, gps: 0 }
        acc.total++
        if (v.checkInLat != null) acc.gps++
        per.set(v.employeeId, acc)
      }
      for (const eid of employeeIds) {
        const acc = per.get(eid)
        out.set(eid, acc ? pct(acc.gps, acc.total) : null)
      }
      return out
    }
  } catch {
    // fall through to per-employee compute below
  }
  // generic fallback: per-employee sequential compute
  for (const eid of employeeIds) {
    out.set(eid, await computeBuiltinIndicator(key, { vendorId, employeeId: eid, start, end }))
  }
  return out
}

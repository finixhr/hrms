// ============ Geo utilities: distance, fence evaluation, accuracy rules ============
// 2026-10 round §19–§23, §33 — server-side geo-fence math. The server is the
// ONLY source of truth for distance/inside-fence decisions: client-supplied
// "insideGeoFence" / "distance" values are never trusted (§22).
import { db } from "@/lib/db"

/** Great-circle distance in meters (haversine). */
export function haversineM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000
  const dLat = ((lat2 - lat1) * Math.PI) / 180
  const dLon = ((lon2 - lon1) * Math.PI) / 180
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(a))
}

export type FenceLike = {
  id: string
  name: string
  type: string
  latitude: number
  longitude: number
  radiusM: number
  startTime?: string | null
  endTime?: string | null
  active: boolean
  geometryJson?: string
}

export type FenceEvaluation = {
  ok: boolean
  fence: FenceLike | null
  distanceM: number | null
  /** Why the evaluation failed — user-actionable message fragments (§87). */
  reason?: string
}

/** Local minutes-since-midnight in the fence timezone (default Asia/Dhaka —
 * §80: the whole feature set runs on Asia/Dhaka; NEVER the server's local
 * zone, which may be UTC in containerized deployments). */
function localMinutes(at: Date, tz = "Asia/Dhaka"): number {
  try {
    const fmt = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false })
    const parts: Record<string, string> = {}
    for (const p of fmt.formatToParts(at)) parts[p.type] = p.value
    const h = Number(parts.hour === "24" ? "0" : parts.hour)
    return h * 60 + Number(parts.minute || "0")
  } catch {
    return at.getUTCHours() * 60 + at.getUTCMinutes()
  }
}

/**
 * Evaluate a location against one fence circle with ACCURACY-AWARE logic (§23):
 * a fix whose accuracy radius is much larger than the fence is REVIEW/REJECT
 * material even when the raw point sits inside the fence — "mathematically
 * inside" is not "verifiably inside" when the error circle dwarfs the fence.
 *
 * Verdicts:
 *   ok=true                — verifiably inside (point inside AND accuracy sane)
 *   ok=false reason=...    — outside / fence closed / accuracy too low
 *   ok=false reason=REVIEW — inside the circle but accuracy makes it unverifiable;
 *                            callers surface this as REVIEW_REQUIRED instead of
 *                            silently accepting or hard-rejecting.
 */
export function evaluateFence(
  fence: FenceLike,
  latitude: number,
  longitude: number,
  accuracyM: number | null | undefined,
  opts: { maxAccuracyM?: number; now?: Date; tz?: string } = {}
): FenceEvaluation {
  if (!fence.active) return { ok: false, fence, distanceM: null, reason: "Geo-fence is disabled" }
  const now = opts.now || new Date()
  const dayMin = localMinutes(now, opts.tz)
  if (fence.startTime && fence.endTime) {
    const [s, e] = [fence.startTime, fence.endTime]
    const [sm, em] = [toMin(s), toMin(e)]
    if (sm != null && em != null) {
      // ATT-005 — wrap-around windows (21:00–07:00) are VALID crossing
      // midnight; the old plain range check rejected every minute of the day
      // (a night fence could never admit a punch). sm <= em is a same-day
      // window; sm > em wraps.
      const inWindow = sm <= em
        ? dayMin >= sm && dayMin <= em
        : dayMin >= sm || dayMin <= em
      if (!inWindow) {
        return { ok: false, fence, distanceM: null, reason: `Outside geo-fence hours (${s}–${e})` }
      }
    }
  }
  const distance = haversineM(latitude, longitude, fence.latitude, fence.longitude)
  const acc = accuracyM != null && Number.isFinite(accuracyM) ? accuracyM : null
  const maxAcc = opts.maxAccuracyM ?? 150
  if (distance > fence.radiusM) {
    return {
      ok: false,
      fence,
      distanceM: Math.round(distance),
      reason: `You are ${Math.round(distance)}m from ${fence.name} (allowed ${Math.round(fence.radiusM)}m)`,
    }
  }
  // Inside the circle — now verify the fix is trustworthy (§23).
  if (acc != null && acc > maxAcc) {
    return {
      ok: false,
      fence,
      distanceM: Math.round(distance),
      reason: `REVIEW:Location accuracy is too low (±${Math.round(acc)}m, max allowed ±${maxAcc}m)`,
    }
  }
  if (acc != null && acc > fence.radiusM) {
    return {
      ok: false,
      fence,
      distanceM: Math.round(distance),
      reason: `REVIEW:Location accuracy (±${Math.round(acc)}m) exceeds the ${fence.name} radius (${Math.round(fence.radiusM)}m) — position cannot be verified`,
    }
  }
  return { ok: true, fence, distanceM: Math.round(distance) }
}

/** Best fence verdict across a fence set: the closest passing fence wins;
 *  REVIEW verdicts only apply when no fence fully passes. */
export function evaluateFences(
  fences: FenceLike[],
  latitude: number,
  longitude: number,
  accuracyM: number | null | undefined,
  opts: { maxAccuracyM?: number; now?: Date; tz?: string } = {}
): FenceEvaluation {
  let best: FenceEvaluation | null = null
  let review: FenceEvaluation | null = null
  const hardFailures: FenceEvaluation[] = []
  for (const f of fences) {
    const v = evaluateFence(f, latitude, longitude, accuracyM, opts)
    if (v.ok) {
      if (!best || (v.distanceM ?? Infinity) < (best.distanceM ?? Infinity)) best = v
    } else if (v.reason?.startsWith("REVIEW:") && !review) {
      review = v
    } else {
      hardFailures.push(v)
    }
  }
  if (best) return best
  if (review) return review
  if (!fences.length) return { ok: false, fence: null, distanceM: null, reason: "No geo-fence assigned" }
  // R10 (2026-10-12) — ROOT CAUSE of the misleading "No active geo-fence
  // covers this location" report: failures WITHOUT a distance (fence closed
  // for the hours, fence disabled) were DISCARDED by the closest-distance
  // selection below, so an employee standing dead-center inside a fence whose
  // hours were closed got a generic "no fence covers this location" message
  // instead of the actionable "Outside geo-fence hours (…)" one. Selection
  // order now: ① the closest distance-carrying failure (most actionable for
  // "you are 300m away"), ② any non-distance failure (hours/disabled) BEFORE
  // the generic fallback, ③ the generic fallback only when nothing else
  // exists (all fences evaluated without producing any reason).
  const withDist = hardFailures
    .filter((v) => v.distanceM != null)
    .sort((a, b) => (a.distanceM ?? 0) - (b.distanceM ?? 0))
  const withoutDist = hardFailures.find((v) => v.distanceM == null && v.reason)
  return withDist[0] ?? withoutDist ?? { ok: false, fence: null, distanceM: null, reason: "No active geo-fence covers this location" }
}

function toMin(t: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(t?.trim() || "")
  return m ? Number(m[1]) * 60 + Number(m[2]) : null
}

/** R10 — policy schedule window check for effectiveFencesFor (date range,
 *  days-of-week, daily window; blank = unconstrained). Mirrors
 *  attendance-policy.ts policyInSchedule semantics without importing the
 *  module (geo.ts stays dependency-free). */
function policyWindowOpen(
  p: { startDate: string | null; endDate: string | null; daysOfWeek: string | null; policyStartTime: string | null; policyEndTime: string | null },
  now: Date,
): boolean {
  const iso = now.toISOString().slice(0, 10)
  if (p.startDate && iso < p.startDate) return false
  if (p.endDate && iso > p.endDate) return false
  if (p.daysOfWeek) {
    // comma list, e.g. "SUNDAY,MONDAY,TUESDAY" (schema default: workweek)
    const days = p.daysOfWeek.split(",").map((d) => d.trim().toUpperCase()).filter(Boolean)
    if (days.length) {
      const name = ["SUNDAY", "MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY"][now.getUTCDay()]
      if (!days.includes(name)) return false
    }
  }
  if (p.policyStartTime && p.policyEndTime) {
    const s = toMin(p.policyStartTime)
    const e = toMin(p.policyEndTime)
    if (s != null && e != null) {
      const dayMin = localMinutes(now)
      // ATT-005 — wrap-around schedule windows (sm > em) cross midnight
      const inWindow = s <= e ? dayMin >= s && dayMin <= e : dayMin >= s || dayMin <= e
      if (!inWindow) return false
    }
  }
  return true
}

/**
 * Resolve the fences currently in effect for an employee (§21): fences linked
 * to any ACTIVE policy that applies to the employee (via the policy engine's
 * scope resolution). Legacy fallback: when the employee has NO policy-linked
 * fence, the branch fence is used (backward compatibility with pre-migration
 * configuration, §69).
 */
export async function effectiveFencesFor(
  vendorId: string,
  employee: { id: string; branchId?: string | null; departmentId?: string | null }
): Promise<FenceLike[]> {
  // Policy-linked fences — only from policies that are active right now.
  // R10 (2026-10-12) — the SQL also carries the policy SCHEDULE columns so the
  // schedule check below can drop fences from policies whose date range /
  // day-of-week / daily window already elapsed (resolveEffectivePolicy applies
  // the same filter — effectiveFencesFor previously looked at p.active only,
  // so an expired-but-active policy kept supplying fences: employees were
  // told "no fence covers this location" for a policy that no longer runs).
  const rows = await db.$queryRaw<{ id: string; name: string; type: string; latitude: number; longitude: number; radiusM: number; startTime: string | null; endTime: string | null; active: boolean; startDate: string | null; endDate: string | null; daysOfWeek: string | null; policyStartTime: string | null; policyEndTime: string | null }[]>`
    SELECT DISTINCT g."id", g."name", g."type", g."latitude", g."longitude", g."radiusM", g."startTime", g."endTime", g."active",
           p."startDate", p."endDate", p."daysOfWeek", p."startTime" AS "policyStartTime", p."endTime" AS "policyEndTime"
    FROM "GeoFence" g
    JOIN "AttendancePolicyGeoFence" pg ON pg."geoFenceId" = g."id"
    JOIN "AttendancePolicy" p ON p."id" = pg."policyId"
    JOIN "AttendancePolicyAssignment" a ON a."policyId" = p."id"
    WHERE g."vendorId" = ${vendorId}
      AND g."active" = true
      AND p."active" = true
      AND p."policyType" IN ('ATTENDANCE_METHOD', 'TRACKING', 'MULTIPLE_CHECKIN')
      AND (
        a."scopeType" = 'ALL_EMPLOYEES'
        OR (a."scopeType" = 'EMPLOYEE' AND a."scopeId" = ${employee.id})
        OR (a."scopeType" = 'BRANCH' AND a."scopeId" = ${employee.branchId ?? ""})
        OR (a."scopeType" = 'DEPARTMENT' AND a."scopeId" = ${employee.departmentId ?? ""})
      )`
  const now = new Date()
  const inSchedule = rows.filter((r) => policyWindowOpen(r, now))
  const fences = inSchedule.map((r) => ({ ...r, active: true })) as FenceLike[]
  if (fences.length) return fences
  // Legacy branch-fence fallback (§69)
  if (!employee.branchId) return []
  const branch = await db.branch.findFirst({ where: { id: employee.branchId, vendorId } })
  if (!branch || !branch.geofenceActive || branch.latitude == null || branch.longitude == null || !branch.geofenceRadius) {
    return []
  }
  // Prefer the migrated GeoFence row for this branch (single source of truth)
  const migrated = await db.geoFence.findFirst({ where: { vendorId, branchId: branch.id, active: true } })
  if (migrated) return [migrated]
  return [
    {
      id: `branch:${branch.id}`,
      name: `${branch.name} — branch fence`,
      type: "CIRCLE",
      latitude: branch.latitude,
      longitude: branch.longitude,
      radiusM: branch.geofenceRadius,
      startTime: branch.geofenceStartTime,
      endTime: branch.geofenceEndTime,
      active: true,
    },
  ]
}

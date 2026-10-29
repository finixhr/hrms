// ============ Live Tracking + Geo-Fence + Policies + Secure Attendance routes ============
// 2026-10 round §8–§40, §58–§77. All actions ride the existing /api/hrm RPC
// dispatcher (registry pattern: perm + zod schema BEFORE the handler) and the
// same Bearer/cookie authentication as everything else — mobile clients use
// the identical contract with Bearer tokens.
//
// Server-side trust model (§86): employee identity always derives from the
// authenticated session; policyId/geoFence/distance/validity are NEVER taken
// from the payload.
import { db } from "@/lib/db"
import { route } from "./registry"
import { Deny, employeeScopeFilter, assertEmployeeVisible } from "../rbac"
import { audit, auditStrict, notify } from "../audit"
import { getSettings } from "../settings"
import { S } from "../validation"
import { validateSelfieDataUrl } from "../uploads"
import { csv, today } from "../utils"
import * as XLSX from "xlsx"
import { requireCapacity, requireSelfieStorage, requireFeature } from "../saas/entitlements"
import {
  resolveEffectivePolicy, resolveEffectivePoliciesForEmployees, policyInSchedule,
  trackingConfig, mandatoryGpsConfig, multipleCheckinConfig, attendanceMethodConfig,
  type PolicyRecord,
} from "../attendance-policy"
import { effectiveFencesFor, evaluateFences } from "../geo"
import { analyzeLocationIntegrity, integrityToEventStatus } from "../location-integrity"
import { ingestLocation, recordTrackingEvent, upsertTrackingState } from "../tracking"
import { rateLimitDistributed, RATE_LIMITS } from "../rate-limit"
import { z } from "zod"

// ---------------------------------------------------------------- helpers

/** Employee identity for SELF-scoped mobile actions (§13): derived from the
 *  session, never the payload. Staff (non-EMPLOYEE role) may act for another
 *  employee only with attendance.edit + scope visibility (audit logged). */
async function resolveSelfActor(ctx: any, p: any, action: string): Promise<string> {
  if (ctx.role === "EMPLOYEE") {
    if (p.employeeId && p.employeeId !== ctx.employeeId) throw new Deny("You can only perform this action for yourself")
    if (!ctx.employeeId) throw new Deny("No employee profile linked to your account")
    return ctx.employeeId
  }
  const employeeId = p.employeeId || ctx.employeeId
  if (!employeeId) throw new Deny("No employee profile linked to your account")
  if (employeeId !== ctx.employeeId) {
    if (!ctx.permissions.has("attendance.edit")) throw new Deny("Acting for another employee requires the attendance.edit permission")
    const target = await assertEmployeeVisible(ctx, employeeId)
    await audit(ctx, action, "AttendanceEvent", null,
      `${action} performed on behalf of ${target.fullName} (${target.code}) by ${ctx.userName} [${ctx.role}]`)
  }
  return employeeId
}

async function guardRate(userId: string, bucket: keyof typeof RATE_LIMITS, action: string) {
  const preset = RATE_LIMITS[bucket]
  // SCL-21 (Phase 3 WS-B) — Redis bucket first when configured (cluster-wide)
  const r = await rateLimitDistributed(`${bucket}:${userId}`, preset.limit, preset.windowMs)
  if (!r.ok) throw new Deny(`Too many ${action} requests — retry in ${r.retryAfterSec}s`, 429)
}

// ================================================================ TRACKING

/** Live map feed (§8–§9, §37): current states ONLY (never history), enriched
 *  with employee org info + attendance + effective-policy source. KPI counts
 *  computed server-side from the full scoped set (§79). */
route("tracking.live", {
  perm: ["tracking", "view"],
  schema: z.object({
    branchId: z.string().nullish(),
    departmentId: z.string().nullish(),
    employeeId: z.string().nullish(),
    trackingStatus: z.string().nullish(),
    geoFenceId: z.string().nullish(),
  }).strict(),
  handler: async (ctx, p) => {
    const settings = await getSettings(ctx.vendorId)
    if (!(settings as any).tracking?.enabled) {
      return { enabled: false, employees: [], kpis: null, intervalSec: 60 }
    }
    const where: any = employeeScopeFilter(ctx)
    where.status = { in: ["ACTIVE", "PROBATION", "ON_LEAVE", "SUSPENDED"] }
    if (p.branchId) where.branchId = p.branchId
    if (p.departmentId) where.departmentId = p.departmentId
    if (p.employeeId) where.id = p.employeeId
    const employees = await db.employee.findMany({ where, select: { id: true, code: true, fullName: true, photoThumb: true, photoUrl: true, branchId: true, departmentId: true, designationId: true } })
    const states = await db.employeeTrackingState.findMany({ where: { vendorId: ctx.vendorId, employeeId: { in: employees.map((e) => e.id) } } })
    const stateByEmp = new Map(states.map((s) => [s.employeeId, s]))
    const designations = await db.designation.findMany({ where: { vendorId: ctx.vendorId }, select: { id: true, name: true } })
    const desigById = new Map(designations.map((d) => [d.id, d.name]))
    const branches = await db.branch.findMany({ where: { vendorId: ctx.vendorId }, select: { id: true, name: true } })
    const branchById = new Map(branches.map((b) => [b.id, b.name]))
    const depts = await db.department.findMany({ where: { vendorId: ctx.vendorId }, select: { id: true, name: true } })
    const deptById = new Map(depts.map((d) => [d.id, d.name]))
    const fences = await db.geoFence.findMany({ where: { vendorId: ctx.vendorId }, select: { id: true, name: true } })
    const fenceById = new Map(fences.map((f) => [f.id, f.name]))
    const dateStr = today()
    const attendance = await db.attendance.findMany({ where: { vendorId: ctx.vendorId, date: dateStr }, select: { employeeId: true, checkIn: true, checkOut: true, status: true } })
    const attByEmp = new Map(attendance.map((a) => [a.employeeId, a]))
    // effective tracking policies in one pass (§6)
    const policies = await resolveEffectivePoliciesForEmployees(ctx.vendorId, employees, "TRACKING")

    let list = employees.map((e) => {
      const st = stateByEmp.get(e.id)
      const att = attByEmp.get(e.id)
      const policy = policies.get(e.id)
      return {
        employeeId: e.id,
        code: e.code,
        fullName: e.fullName,
        photo: e.photoThumb || e.photoUrl || null,
        designation: e.designationId ? (desigById.get(e.designationId) ?? "—") : "—",
        department: e.departmentId ? (deptById.get(e.departmentId) ?? "—") : "—",
        branch: e.branchId ? (branchById.get(e.branchId) ?? "—") : "—",
        trackingEnabled: st?.trackingEnabled ?? false,
        trackingStatus: st?.trackingEnabled ? (st?.trackingStatus ?? "OFFLINE") : "NOT_TRACKING",
        lastSeenAt: st?.lastSeenAt ?? null,
        latitude: st?.latitude ?? null,
        longitude: st?.longitude ?? null,
        accuracyM: st?.accuracyM ?? null,
        batteryPercentage: st?.batteryPercentage ?? null,
        isCharging: st?.isCharging ?? null,
        gpsStatus: st?.gpsStatus ?? null,
        networkStatus: st?.networkStatus ?? null,
        geoFenceName: st?.geoFenceId ? (fenceById.get(st.geoFenceId) ?? null) : null,
        insideGeoFence: st?.insideGeoFence ?? null,
        attendanceStatus: att?.status ?? null,
        checkedIn: att?.checkIn ?? null,
        checkedOut: att?.checkOut ?? null,
        policySource: policy?.source ?? null, // §6 — "Source: Employee/Department/Branch/Global"
        intervalSec: Number(policy?.config?.updateIntervalSec ?? (settings as any).tracking?.updateIntervalSec ?? 60),
      }
    })
    if (p.trackingStatus) list = list.filter((x) => x.trackingStatus === p.trackingStatus)
    if (p.geoFenceId) list = list.filter((x) => stateByEmp.get(x.employeeId)?.geoFenceId === p.geoFenceId)

    // KPI cards (§37) — from the FULL scoped set, not the visible page
    const kpis = {
      totalAssigned: list.length,
      tracking: list.filter((x) => x.trackingStatus === "TRACKING").length,
      online: list.filter((x) => x.trackingEnabled && x.lastSeenAt && Date.now() - x.lastSeenAt.getTime() < 15 * 60_000).length,
      gpsDisabled: list.filter((x) => x.trackingStatus === "GPS_DISABLED").length,
      // L-11 — only statuses the engine assigns; the dead
      // POWER_OFF_UNCONFIRMED / NETWORK_LOST values no longer inflate the KPI
      offline: list.filter((x) => ["OFFLINE", "OFFLINE_AFTER_LOW_BATTERY"].includes(x.trackingStatus)).length,
      lowBattery: list.filter((x) => x.trackingStatus === "LOW_BATTERY").length,
      outsideGeofence: list.filter((x) => x.trackingStatus === "OUTSIDE_GEOFENCE").length,
      suspicious: list.filter((x) => x.trackingStatus === "SUSPICIOUS").length,
    }
    return { enabled: true, employees: list, kpis, intervalSec: Number((settings as any).tracking?.updateIntervalSec ?? 60) }
  },
})

/** Paginated tracking history for ONE employee/date range (§35–§36, §38). */
route("tracking.history", {
  perm: ["tracking", "view"],
  schema: z.object({
    employeeId: z.string().min(1),
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    page: z.number().int().min(1).nullish(),
    size: z.number().int().min(1).max(2000).nullish(),
  }).strict(),
  handler: async (ctx, p) => {
    await assertEmployeeVisible(ctx, p.employeeId)
    const from = new Date(`${p.from}T00:00:00`)
    const to = new Date(`${p.to}T23:59:59.999`)
    const size = Math.min(p.size ?? 500, 2000)
    const page = p.page ?? 1
    const [points, totalPoints, events] = await Promise.all([
      db.trackingPoint.findMany({
        where: { vendorId: ctx.vendorId, employeeId: p.employeeId, timestamp: { gte: from, lte: to } },
        orderBy: { timestamp: "asc" },
        skip: (page - 1) * size,
        take: size,
      }),
      db.trackingPoint.count({ where: { vendorId: ctx.vendorId, employeeId: p.employeeId, timestamp: { gte: from, lte: to } } }),
      db.attendanceEvent.findMany({
        where: { vendorId: ctx.vendorId, employeeId: p.employeeId, occurredAt: { gte: from, lte: to } },
        orderBy: { occurredAt: "asc" },
      }),
    ])
    return { points, totalPoints, page, size, events }
  },
})

/** Admin: start tracking an employee (tracking.manage, §57 audit). */
route("tracking.start", {
  perm: ["tracking", "manage"],
  schema: S.byId,
  handler: async (ctx, p) => {
    const emp = await assertEmployeeVisible(ctx, p.id)
    // SaaS plan capacity — concurrently-tracked-employee seats (LEGACY passes)
    await requireCapacity(ctx.vendorId, "TRACKING_EMPLOYEES", 1)
    await upsertTrackingState(ctx.vendorId, p.id, { trackingEnabled: true, trackingStatus: "OFFLINE", sessionStartedAt: new Date() })
    await audit(ctx, "tracking.start", "EmployeeTrackingState", p.id, `Live tracking started for ${emp.fullName} (${emp.code})`)
    await notify(ctx.vendorId, { employeeId: p.id }, "Live Tracking Enabled", "Your location is now being tracked during working hours.", "SYSTEM", "attendance")
    return { ok: true }
  },
})

/** Admin: stop tracking (audit + state preserved as evidence). */
route("tracking.stop", {
  perm: ["tracking", "manage"],
  schema: S.byId,
  handler: async (ctx, p) => {
    const emp = await assertEmployeeVisible(ctx, p.id)
    await upsertTrackingState(ctx.vendorId, p.id, { trackingEnabled: false, trackingStatus: "OFFLINE" })
    await audit(ctx, "tracking.stop", "EmployeeTrackingState", p.id, `Live tracking stopped for ${emp.fullName} (${emp.code})`, { reason: p.reason })
    return { ok: true }
  },
})

/** Mobile ingestion endpoint (§64): append-only point + state upsert +
 *  battery/GPS/fence security events. Lightweight by design — no report or
 *  payroll logic here. Rate-limited (§66), idempotent on clientEventId (§65). */
  // INTENTIONALLY_SELF_SCOPED (M-02): employee identity derives from the session
  // (resolveSelfActor) — the payload can never target another employee.
route("tracking.location", {
  schema: S.trackingLocation,
  handler: async (ctx, p) => {
    const employeeId = await resolveSelfActor(ctx, p, "tracking.location")
    await guardRate(ctx.userId, "location", "location update")
    const result = await ingestLocation(ctx.vendorId, employeeId, p as any)
    if (!result.ok) throw new Deny(result.message || "Location update rejected", 400)
    return {
      ok: true,
      duplicate: result.duplicate,
      trackingStatus: result.trackingStatus,
      intervalSec: result.intervalSec,
      integrity: result.integrity ? { status: result.integrity.status, decision: result.integrity.decision } : null,
    }
  },
})

/** Mobile status poll (§12): what the client must do RIGHT NOW — effective
 *  tracking policy (interval), mandatory-GPS window, allowed attendance
 *  methods. Everything resolved server-side from the session identity. */
  // INTENTIONALLY_SELF_SCOPED (M-02): self status contract for the caller's own
  // employee record (resolveSelfActor enforces own-record-only).
route("tracking.status", {
  handler: async (ctx, p) => {
    const employeeId = await resolveSelfActor(ctx, p, "tracking.status")
    const emp = await db.employee.findFirst({ where: { id: employeeId, vendorId: ctx.vendorId } })
    if (!emp) throw new Deny("Employee not found", 404)
    const settings = await getSettings(ctx.vendorId)
    const trackingEnabled = (settings as any).tracking?.enabled !== false
    const trackingPolicy = await resolveEffectivePolicy(ctx.vendorId, emp, "TRACKING")
    const mandatoryGps = await resolveEffectivePolicy(ctx.vendorId, emp, "MANDATORY_GPS")
    const methodPolicy = await resolveEffectivePolicy(ctx.vendorId, emp, "ATTENDANCE_METHOD")
    const state = await db.employeeTrackingState.findUnique({ where: { employeeId } })
    const tCfg = trackingConfig(trackingPolicy?.config)
    return {
      trackingEnabled: trackingEnabled && (state?.trackingEnabled ?? true),
      intervalSec: Number(trackingPolicy?.config?.updateIntervalSec ?? (settings as any).tracking?.updateIntervalSec ?? 60),
      policySource: trackingPolicy?.source ?? "Global",
      mandatoryGps: mandatoryGps
        ? { active: true, graceMinutes: mandatoryGpsConfig(mandatoryGps.config).graceMinutes, source: mandatoryGps.source }
        : { active: false },
      attendanceMethods: methodPolicy
        ? attendanceMethodConfig(methodPolicy.config)
        // Selfie Attendance G1 — no ATTENDANCE_METHOD policy configured → the
        // same permissive legacy default enforceMethodPolicy applies to geo
        // punches (attendance.ts:482): GEOFENCE + SELFIE + GEOFENCE_SELFIE are
        // all available, nothing required. A vendor who wants to forbid selfie
        // punches creates a method policy without SELFIE — then the ESS hides
        // the selfie buttons (tracking.status drives their visibility) and the
        // punch routes 403 with an actionable message.
        : { methods: ["GEOFENCE", "SELFIE", "GEOFENCE_SELFIE", "DEVICE_PUNCH"], selfieRequired: false, requireGeofence: false },
      batteryThresholds: { low: tCfg.lowBatteryThreshold, critical: tCfg.criticalBatteryThreshold },
      serverTime: new Date().toISOString(),
    }
  },
})

// ================================================================ GEO-FENCE

route("geofences.list", {
  perm: ["geofence", "view"],
  handler: async (ctx) => {
    const fences = await db.geoFence.findMany({ where: { vendorId: ctx.vendorId }, orderBy: { name: "asc" } })
    const branches = await db.branch.findMany({ where: { vendorId: ctx.vendorId }, select: { id: true, name: true, latitude: true, longitude: true, geofenceRadius: true, geofenceActive: true } })
    return { fences, branchDefaults: branches }
  },
})

route("geofences.save", {
  perm: ["geofence", "edit"],
  schema: S.geofenceSave,
  handler: async (ctx, p) => {
    if (p.id) {
      const existing = await db.geoFence.findFirst({ where: { id: p.id, vendorId: ctx.vendorId } })
      if (!existing) throw new Deny("Geo-fence not found", 404)
      const updated = await db.geoFence.update({
        where: { id: p.id },
        data: {
          name: p.name, branchId: p.branchId ?? null, type: p.type || "CIRCLE",
          latitude: p.latitude, longitude: p.longitude, radiusM: p.radiusM,
          geometryJson: p.geometryJson || "{}",
          startTime: p.startTime ?? null, endTime: p.endTime ?? null,
          active: p.active ?? true,
        },
      })
      await audit(ctx, "geofences.update", "GeoFence", updated.id,
        `${p.active === false ? "Disabled" : "Updated"} geo-fence ${updated.name} (${updated.latitude.toFixed(5)}, ${updated.longitude.toFixed(5)}, r=${Math.round(updated.radiusM)}m)`,
        { oldValue: { name: existing.name, latitude: existing.latitude, longitude: existing.longitude, radiusM: existing.radiusM, active: existing.active }, newValue: { name: updated.name, latitude: updated.latitude, longitude: updated.longitude, radiusM: updated.radiusM, active: updated.active } })
      return updated
    }
    const created = await db.geoFence.create({
      data: {
        vendorId: ctx.vendorId, name: p.name, branchId: p.branchId ?? null, type: p.type || "CIRCLE",
        latitude: p.latitude, longitude: p.longitude, radiusM: p.radiusM,
        geometryJson: p.geometryJson || "{}",
        startTime: p.startTime ?? null, endTime: p.endTime ?? null,
        active: p.active ?? true,
      },
    })
    await audit(ctx, "geofences.create", "GeoFence", created.id,
      `Created geo-fence ${created.name} (${created.latitude.toFixed(5)}, ${created.longitude.toFixed(5)}, r=${Math.round(created.radiusM)}m)`)
    return created
  },
})

route("geofences.setEnabled", {
  perm: ["geofence", "edit"],
  schema: z.object({ id: z.string().min(1), active: z.boolean() }).strict(),
  handler: async (ctx, p) => {
    const existing = await db.geoFence.findFirst({ where: { id: p.id, vendorId: ctx.vendorId } })
    if (!existing) throw new Deny("Geo-fence not found", 404)
    await db.geoFence.update({ where: { id: p.id }, data: { active: p.active } })
    await audit(ctx, p.active ? "geofences.enable" : "geofences.disable", "GeoFence", p.id, `${p.active ? "Enabled" : "Disabled"} geo-fence ${existing.name}`)
    return { ok: true }
  },
})

route("geofences.delete", {
  perm: ["geofence", "delete"],
  schema: S.confirmDelete,
  handler: async (ctx, p) => {
    const existing = await db.geoFence.findFirst({ where: { id: p.id, vendorId: ctx.vendorId } })
    if (!existing) throw new Deny("Geo-fence not found", 404)
    await db.geoFence.delete({ where: { id: p.id } })
    await audit(ctx, "geofences.delete", "GeoFence", p.id, `Deleted geo-fence ${existing.name}`)
    return { deleted: true }
  },
})

// ================================================================ POLICIES

route("attendance.policy.list", {
  perm: ["attendance", "view"],
  handler: async (ctx) => {
    const policies = await db.attendancePolicy.findMany({
      where: { vendorId: ctx.vendorId },
      include: { assignments: true, fences: true },
      orderBy: [{ policyType: "asc" }, { priority: "desc" }, { name: "asc" }],
    })
    return policies
  },
})

/** Typed config validation per policyType (§6: reusable engine, not per-feature settings). */
const POLICY_CONFIG_SCHEMAS: Record<string, z.ZodTypeAny> = {
  TRACKING: z.object({
    updateIntervalSec: z.number().int().min(15).max(3600),
    maxAccuracyM: z.number().min(10).max(5000),
    lowBatteryThreshold: z.number().int().min(1).max(99),
    criticalBatteryThreshold: z.number().int().min(1).max(99),
    offlineAfterMinutes: z.number().int().min(1).max(720),
    suspiciousAction: z.enum(["ALLOW", "WARN", "REVIEW", "REJECT"]),
  }).partial(),
  MANDATORY_GPS: z.object({ graceMinutes: z.number().int().min(0).max(120) }).partial(),
  MULTIPLE_CHECKIN: z.object({
    minIntervalMinutes: z.number().int().min(1).max(480),
    maxPerDay: z.number().int().min(1).max(50),
    methods: z.array(z.enum(["GEOFENCE", "SELFIE", "GEOFENCE_SELFIE", "DEVICE_PUNCH"])),
  }).partial(),
  ATTENDANCE_METHOD: z.object({
    methods: z.array(z.enum(["GEOFENCE", "SELFIE", "GEOFENCE_SELFIE", "DEVICE_PUNCH"])),
    selfieRequired: z.boolean(),
    requireGeofence: z.boolean(),
    // G2 — device binding enforcement (see EmployeeDevice in schema.prisma)
    deviceBinding: z.enum(["OFF", "ADVISORY", "STRICT"]),
  }).partial(),
  // ATT-017 (R7) — day-level rules; every field optional, null = inherit the
  // tenant-wide setting (the merge happens in the punch engines).
  ATTENDANCE_RULES: z.object({
    graceMinutes: z.number().int().min(0).max(120).nullish(),
    earlyLeaveThresholdMinutes: z.number().int().min(0).max(120).nullish(),
    halfDayHours: z.number().min(0.5).max(12).nullish(),
    maxOtHoursPerDay: z.number().min(0).max(8).nullish(),
  }).partial(),
}

route("attendance.policy.save", {
  perm: ["attendance", "edit"],
  schema: S.policySave,
  handler: async (ctx, p) => {
    // validate the typed config for this policy type (reject unknown shapes)
    const configSchema = POLICY_CONFIG_SCHEMAS[p.policyType]
    let config: Record<string, unknown> = {}
    if (p.config && Object.keys(p.config).length) {
      const parsed = configSchema.safeParse(p.config)
      if (!parsed.success) throw new Deny(`Invalid ${p.policyType} policy configuration: ${parsed.error.issues[0]?.message ?? "unknown field"}`, 400)
      config = parsed.data as Record<string, unknown>
    }
    const days = (p.daysOfWeek ?? ["SUNDAY", "MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY"]).filter(Boolean)
    const data = {
      vendorId: ctx.vendorId, name: p.name, policyType: p.policyType,
      priority: p.priority ?? 0,
      startDate: p.startDate ?? null, endDate: p.endDate ?? null,
      startTime: p.startTime ?? null, endTime: p.endTime ?? null,
      daysOfWeek: days.join(","),
      timezone: p.timezone || "Asia/Dhaka",
      active: p.active ?? true,
      configJson: JSON.stringify(config),
    }
    let policyId = p.id ?? null
    if (p.id) {
      const existing = await db.attendancePolicy.findFirst({ where: { id: p.id, vendorId: ctx.vendorId } })
      if (!existing) throw new Deny("Policy not found", 404)
      await db.attendancePolicy.update({ where: { id: p.id }, data })
    } else {
      const created = await db.attendancePolicy.create({ data })
      policyId = created.id
    }
    // assignments replace atomically (§57: audit policy assignment changes)
    if (p.assignments) {
      await db.attendancePolicyAssignment.deleteMany({ where: { vendorId: ctx.vendorId, policyId } })
      for (const a of p.assignments) {
        if (a.scopeType === "ALL_EMPLOYEES") {
          if (policyId) await db.attendancePolicyAssignment.create({ data: { vendorId: ctx.vendorId, policyId, scopeType: "ALL_EMPLOYEES", scopeId: null, createdBy: ctx.userId } })
        } else {
          if (!a.scopeId) throw new Deny(`${a.scopeType} assignment requires a target`, 400)
          if (policyId) await db.attendancePolicyAssignment.create({ data: { vendorId: ctx.vendorId, policyId, scopeType: a.scopeType, scopeId: a.scopeId, createdBy: ctx.userId } })
        }
      }
    }
    // geo-fence links replace atomically
    if (p.geoFenceIds) {
      const valid = await db.geoFence.findMany({ where: { vendorId: ctx.vendorId, id: { in: p.geoFenceIds } }, select: { id: true } })
      await db.attendancePolicyGeoFence.deleteMany({ where: { vendorId: ctx.vendorId, policyId } })
      for (const f of valid) {
        if (policyId) await db.attendancePolicyGeoFence.create({ data: { vendorId: ctx.vendorId, policyId, geoFenceId: f.id } })
      }
    }
    await audit(ctx, p.id ? "attendancePolicy.update" : "attendancePolicy.create", "AttendancePolicy", policyId,
      `${p.id ? "Updated" : "Created"} ${p.policyType} policy "${p.name}" (${days.join(",")}${p.startTime && p.endTime ? ` ${p.startTime}-${p.endTime}` : ""})`,
      { newValue: { config, assignments: p.assignments?.length ?? 0, geoFences: p.geoFenceIds?.length ?? 0 } })
    return { id: policyId }
  },
})

route("attendance.policy.delete", {
  perm: ["attendance", "delete"],
  schema: S.confirmDelete,
  handler: async (ctx, p) => {
    const existing = await db.attendancePolicy.findFirst({ where: { id: p.id, vendorId: ctx.vendorId } })
    if (!existing) throw new Deny("Policy not found", 404)
    await db.attendancePolicy.delete({ where: { id: p.id } }) // assignments+fences cascade
    await audit(ctx, "attendancePolicy.delete", "AttendancePolicy", p.id, `Deleted ${existing.policyType} policy "${existing.name}"`)
    return { deleted: true }
  },
})

/** Effective-policy resolution for the UI (§6: "Source: Employee/…"). */
route("attendance.policy.effective", {
  perm: ["attendance", "view"],
  schema: z.object({ employeeId: z.string().min(1), policyType: z.enum(["TRACKING", "MANDATORY_GPS", "MULTIPLE_CHECKIN", "ATTENDANCE_METHOD", "ATTENDANCE_RULES"]).nullish() }).strict(),
  handler: async (ctx, p) => {
    const emp = await assertEmployeeVisible(ctx, p.employeeId)
    const types: ("TRACKING" | "MANDATORY_GPS" | "MULTIPLE_CHECKIN" | "ATTENDANCE_METHOD" | "ATTENDANCE_RULES")[] =
      p.policyType ? [p.policyType] : ["TRACKING", "MANDATORY_GPS", "MULTIPLE_CHECKIN", "ATTENDANCE_METHOD", "ATTENDANCE_RULES"]
    const out: Record<string, unknown> = {}
    for (const t of types) {
      const info = await resolveEffectivePolicy(ctx.vendorId, emp, t)
      out[t] = info ? { id: info.policy.id, name: info.policy.name, source: info.source, config: info.config, inSchedule: policyInSchedule(info.policy as PolicyRecord) } : null
    }
    return out
  },
})

// ================================================================ EVENTS + HISTORY

/** Attendance event history (§35) with the full filter set. Scope-aware:
 *  managers see their own branch/department only (§59). */
route("attendance.events.list", {
  perm: ["attendance", "view"],
  schema: z.object({
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
    to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
    employeeId: z.string().nullish(),
    branchId: z.string().nullish(),
    departmentId: z.string().nullish(),
    eventType: z.string().nullish(),
    attendanceMethod: z.string().nullish(),
    status: z.string().nullish(),
    locationIntegrityStatus: z.string().nullish(),
    gpsStatus: z.string().nullish(),
    geoFenceId: z.string().nullish(),
    reviewStatus: z.string().nullish(),
    page: z.number().int().min(1).nullish(),
    size: z.number().int().min(1).max(200).nullish(),
  }).strict(),
  handler: async (ctx, p) => {
    const where: any = { vendorId: ctx.vendorId }
    if (p.employeeId) {
      await assertEmployeeVisible(ctx, p.employeeId)
      where.employeeId = p.employeeId
    } else {
      const scope = employeeScopeFilter(ctx)
      if (scope.branchId || scope.departmentId) {
        const emps = await db.employee.findMany({ where: scope, select: { id: true } })
        where.employeeId = { in: emps.map((e) => e.id) }
      }
    }
    if (p.branchId || p.departmentId) {
      const emps = await db.employee.findMany({
        where: { vendorId: ctx.vendorId, ...(p.branchId ? { branchId: p.branchId } : {}), ...(p.departmentId ? { departmentId: p.departmentId } : {}) },
        select: { id: true },
      })
      const ids = new Set(emps.map((e) => e.id))
      where.employeeId = where.employeeId
        ? (typeof where.employeeId === "string" ? (ids.has(where.employeeId) ? where.employeeId : "__none__") : { in: where.employeeId.in.filter((x: string) => ids.has(x)) })
        : { in: [...ids] }
    }
    if (p.from) where.occurredAt = { ...(where.occurredAt ?? {}), gte: new Date(`${p.from}T00:00:00`) }
    if (p.to) where.occurredAt = { ...(where.occurredAt ?? {}), lte: new Date(`${p.to}T23:59:59.999`) }
    if (p.eventType) where.eventType = p.eventType
    if (p.attendanceMethod) where.attendanceMethod = p.attendanceMethod
    if (p.status) where.status = p.status
    if (p.locationIntegrityStatus) where.locationIntegrityStatus = p.locationIntegrityStatus
    if (p.gpsStatus) where.gpsStatus = p.gpsStatus
    if (p.geoFenceId) where.geoFenceId = p.geoFenceId
    if (p.reviewStatus) where.reviewStatus = p.reviewStatus
    const size = Math.min(p.size ?? 100, 200)
    const page = p.page ?? 1
    const [events, total] = await Promise.all([
      db.attendanceEvent.findMany({ where, orderBy: { occurredAt: "desc" }, skip: (page - 1) * size, take: size }),
      db.attendanceEvent.count({ where }),
    ])
    // enrich with employee names (list payload — no selfie bytes, §26)
    const empIds = [...new Set(events.map((e) => e.employeeId))]
    const emps = empIds.length ? await db.employee.findMany({ where: { vendorId: ctx.vendorId, id: { in: empIds } }, select: { id: true, code: true, fullName: true } }) : []
    const empById = new Map(emps.map((e) => [e.id, e]))
    return {
      total, page, size,
      events: events.map((e) => ({ ...e, employeeCode: empById.get(e.employeeId)?.code ?? "?", employeeName: empById.get(e.employeeId)?.fullName ?? "?" })),
    }
  },
})

// ================= Live attendance feed (2026-10 round) =================
// Lightweight polling endpoint for (a) the Daily Attendance tab's
// non-intrusive toast when a punch is recorded and (b) the dashboard's
// "Attendance Live Feed" widget. Returns the newest RECORDED attendance
// events (any punch-like method: device, biometric, mobile, admin) with
// employee name/code, a short HH:MM time and a stable cursor (id).
// `after` (an id previously seen) limits the response to strictly newer
// events; without it the first N of today are returned (initial load).
route("attendance.liveFeed", {
  perm: ["attendance", "view"],
  schema: z.object({
    after: z.string().nullish(),
    limit: z.number().int().min(1).max(30).nullish(),
  }).strict(),
  handler: async (ctx, p) => {
    const scope = employeeScopeFilter(ctx)
    const empWhere: any = { vendorId: ctx.vendorId, ...(scope.branchId ? { branchId: scope.branchId } : {}), ...(scope.departmentId ? { departmentId: scope.departmentId } : {}) }
    const emps = await db.employee.findMany({ where: empWhere, select: { id: true, code: true, fullName: true } })
    if (!emps.length) return { events: [], serverTime: new Date().toISOString() }
    const empById = new Map(emps.map((e) => [e.id, e]))

    const startOfDay = new Date()
    startOfDay.setHours(0, 0, 0, 0)
    const where: any = {
      vendorId: ctx.vendorId,
      employeeId: { in: emps.map((e) => e.id) },
      occurredAt: { gte: startOfDay },
      // punch-shaped events only (no GPS/security signals)
      eventType: { in: ["CHECK_IN", "CHECK_OUT", "DEVICE_PUNCH"] },
      attendanceMethod: { in: ["BIOMETRIC", "DEVICE_PUNCH", "GEOFENCE", "SELFIE", "GEOFENCE_SELFIE", "MOBILE", "ADMIN", "WEB"] },
    }
    let events: any[]
    if (p.after) {
      const anchor = await db.attendanceEvent.findFirst({ where: { vendorId: ctx.vendorId, id: p.after }, select: { occurredAt: true } })
      if (!anchor) {
        // unknown cursor (older than retention / another tenant) — full reload
        events = await db.attendanceEvent.findMany({ where, orderBy: [{ occurredAt: "desc" }, { id: "desc" }], take: Math.min(p.limit ?? 15, 30) })
      } else {
        events = await db.attendanceEvent.findMany({
          where: { ...where, occurredAt: { gt: anchor.occurredAt } },
          orderBy: [{ occurredAt: "asc" }, { id: "asc" }],
          take: Math.min(p.limit ?? 15, 30),
        }).then((rows) => rows.reverse()) // newest last → caller toasts in order
      }
    } else {
      events = await db.attendanceEvent.findMany({ where, orderBy: [{ occurredAt: "desc" }, { id: "desc" }], take: Math.min(p.limit ?? 15, 30) })
    }
    return {
      serverTime: new Date().toISOString(),
      events: events.map((e) => ({
        id: e.id,
        employeeId: e.employeeId,
        name: empById.get(e.employeeId)?.fullName ?? "—",
        code: empById.get(e.employeeId)?.code ?? "?",
        // HH:MM in the server's local frame (matches the Daily grid)
        time: new Date(e.occurredAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false }),
        type: e.eventType === "CHECK_OUT" ? "CHECK_OUT" : "CHECK_IN",
        method: e.attendanceMethod,
      })),
    }
  },
})

// ================= Real-time punch alerts (2026-10-07) =================
// App-wide toast feed: when an employee punches on a device, or checks in /
// out via geo-fence or selfie, every signed-in user who holds the configured
// permission (HR Settings → Communications → Wishes & Notifications → Punch
// Alerts) sees a short toast — scoped to the employees they may see (branch /
// department managers only hear about their own people).
//
// Cursor = the event's RECORDING time (createdAt), not the punch time: a
// device that uploads a punch late must still alert, and a historical
// backfill (punches days old) must NOT spray toasts — events whose punch time
// is older than PUNCH_ALERT_MAX_AGE are never alerted.
const PUNCH_ALERT_MAX_AGE_MS = 30 * 60_000
const DEFAULT_PUNCH_ALERTS = { enabled: true, devicePunch: true, geofencePunch: true, selfiePunch: true, checkOut: true, permission: "attendance.view", pollSeconds: 15 }
const PUNCH_METHOD_GROUPS: Record<"devicePunch" | "geofencePunch" | "selfiePunch", string[]> = {
  devicePunch: ["DEVICE_PUNCH", "BIOMETRIC"],
  geofencePunch: ["GEOFENCE"],
  selfiePunch: ["SELFIE", "GEOFENCE_SELFIE"],
}

// INTENTIONALLY_PUBLIC (M-02): polling feed for the wallboard/TV display — the handler answers { enabled: false } unless alerts are on AND the caller holds the configured permission.
route("attendance.punchAlerts", {
  // any signed-in user may ASK; the handler answers { enabled: false } unless
  // alerts are on for the tenant AND the caller holds the configured permission
  public: true,
  schema: z.object({
    after: z.string().max(40).nullish(), // ISO createdAt cursor from the previous response
  }).strict(),
  handler: async (ctx, p) => {
    if (!ctx) throw new Deny("Authentication required", 401)
    const settings = await getSettings(ctx.vendorId)
    const cfg = { ...(DEFAULT_PUNCH_ALERTS), ...((settings as any).punchAlerts || {}) }
    const pollSeconds = Math.min(120, Math.max(10, Number(cfg.pollSeconds) || 15))
    const [mod, act] = String(cfg.permission || "attendance.view").split(".")
    const allowed = cfg.enabled !== false && !!mod && !!act && ctx.permissions.has(`${mod}.${act}`)
    const now = new Date()
    if (!allowed) return { enabled: false, pollSeconds, cursor: now.toISOString(), events: [] }

    const methods = (Object.keys(PUNCH_METHOD_GROUPS) as (keyof typeof PUNCH_METHOD_GROUPS)[])
      .filter((k) => cfg[k] !== false)
      .flatMap((k) => PUNCH_METHOD_GROUPS[k])
    // first call (no cursor): just hand out the cursor — history is never toasted
    const after = p.after ? new Date(p.after) : null
    if (!after || !Number.isFinite(after.getTime()) || !methods.length) {
      return { enabled: true, pollSeconds, cursor: now.toISOString(), events: [] }
    }
    // never look back more than the max age, even with a stale cursor
    const since = new Date(Math.max(after.getTime(), now.getTime() - PUNCH_ALERT_MAX_AGE_MS))

    const where: any = {
      vendorId: ctx.vendorId,
      createdAt: { gt: since },
      occurredAt: { gte: new Date(now.getTime() - PUNCH_ALERT_MAX_AGE_MS) },
      eventType: { in: cfg.checkOut === false ? ["CHECK_IN", "DEVICE_PUNCH"] : ["CHECK_IN", "CHECK_OUT", "DEVICE_PUNCH"] },
      attendanceMethod: { in: methods },
      status: { not: "REJECTED" },
    }
    const scope = employeeScopeFilter(ctx)
    if (scope.branchId || scope.departmentId) {
      const emps = await db.employee.findMany({ where: scope, select: { id: true } })
      where.employeeId = { in: emps.map((e) => e.id) }
    }
    const rows = await db.attendanceEvent.findMany({
      where, orderBy: [{ createdAt: "asc" }, { id: "asc" }], take: 50,
      select: { id: true, employeeId: true, eventType: true, attendanceMethod: true, occurredAt: true, createdAt: true },
    })
    const cursor = rows.length ? rows[rows.length - 1].createdAt.toISOString() : since.toISOString()
    if (!rows.length) return { enabled: true, pollSeconds, cursor, events: [] }
    const emps = await db.employee.findMany({
      where: { vendorId: ctx.vendorId, id: { in: [...new Set(rows.map((r) => r.employeeId))] } },
      select: { id: true, code: true, fullName: true },
    })
    const byId = new Map(emps.map((e) => [e.id, e]))
    return {
      enabled: true,
      pollSeconds,
      cursor,
      events: rows.map((r) => ({
        id: r.id,
        name: byId.get(r.employeeId)?.fullName ?? "Employee",
        code: byId.get(r.employeeId)?.code ?? "",
        type: r.eventType === "CHECK_OUT" ? "CHECK_OUT" : r.eventType === "DEVICE_PUNCH" ? "PUNCH" : "CHECK_IN",
        source: PUNCH_METHOD_GROUPS.devicePunch.includes(r.attendanceMethod) ? "DEVICE"
          : PUNCH_METHOD_GROUPS.selfiePunch.includes(r.attendanceMethod) ? "SELFIE" : "GEOFENCE",
        occurredAt: r.occurredAt.toISOString(),
      })),
    }
  },
})

// G4 — exportable attendance-event reports: same filter set as events.list
// (no paging — hard row cap), CSV via the shared csv() helper (M-8 formula
// injection guard included). attendance.export permission (the events family
// is view/list → view, review → verify, export → export — the original
// attendance.download verb is granted to NO role template, which made this
// route 403 for every admin; payroll.export.salary uses payroll.export the
// same way) + audit row.
route("attendance.events.export", {
  perm: ["attendance", "export"],
  schema: S.eventsExport,
  handler: async (ctx, p) => {
    const where: any = { vendorId: ctx.vendorId }
    if (p.employeeId) {
      await assertEmployeeVisible(ctx, p.employeeId)
      where.employeeId = p.employeeId
    } else {
      const scope = employeeScopeFilter(ctx)
      if (scope.branchId || scope.departmentId) {
        const emps = await db.employee.findMany({ where: scope, select: { id: true } })
        where.employeeId = { in: emps.map((e) => e.id) }
      }
    }
    if (p.branchId || p.departmentId) {
      const emps = await db.employee.findMany({
        where: { vendorId: ctx.vendorId, ...(p.branchId ? { branchId: p.branchId } : {}), ...(p.departmentId ? { departmentId: p.departmentId } : {}) },
        select: { id: true },
      })
      const ids = new Set(emps.map((e) => e.id))
      where.employeeId = where.employeeId
        ? (typeof where.employeeId === "string" ? (ids.has(where.employeeId) ? where.employeeId : "__none__") : { in: where.employeeId.in.filter((x: string) => ids.has(x)) })
        : { in: [...ids] }
    }
    if (p.from) where.occurredAt = { ...(where.occurredAt ?? {}), gte: new Date(`${p.from}T00:00:00`) }
    if (p.to) where.occurredAt = { ...(where.occurredAt ?? {}), lte: new Date(`${p.to}T23:59:59.999`) }
    if (p.eventType) where.eventType = p.eventType
    if (p.attendanceMethod) where.attendanceMethod = p.attendanceMethod
    if (p.status) where.status = p.status
    if (p.locationIntegrityStatus) where.locationIntegrityStatus = p.locationIntegrityStatus
    if (p.gpsStatus) where.gpsStatus = p.gpsStatus
    if (p.geoFenceId) where.geoFenceId = p.geoFenceId
    if (p.reviewStatus) where.reviewStatus = p.reviewStatus

    const EXPORT_ROW_CAP = 10_000
    const events = await db.attendanceEvent.findMany({ where, orderBy: { occurredAt: "desc" }, take: EXPORT_ROW_CAP + 1 })
    const truncated = events.length > EXPORT_ROW_CAP
    const rows = events.slice(0, EXPORT_ROW_CAP)
    const empIds = [...new Set(rows.map((e) => e.employeeId))]
    const emps = empIds.length ? await db.employee.findMany({ where: { vendorId: ctx.vendorId, id: { in: empIds } }, select: { id: true, code: true, fullName: true } }) : []
    const empById = new Map(emps.map((e) => [e.id, e]))
    const header = ["Date/Time", "Employee Code", "Employee", "Event", "Method", "Status", "Review", "Integrity", "GPS", "Device", "Geo-Fence", "Distance (m)", "Reason"]
    const csvRows: (string | number | null | undefined)[][] = [
      header,
      ...rows.map((e) => [
        e.occurredAt?.toISOString?.() ?? String(e.occurredAt ?? ""),
        empById.get(e.employeeId)?.code ?? "?",
        empById.get(e.employeeId)?.fullName ?? "?",
        e.eventType,
        e.attendanceMethod ?? null,
        e.status,
        e.reviewStatus ?? null,
        e.locationIntegrityStatus ?? null,
        e.gpsStatus ?? null,
        e.deviceId ?? null,
        e.geoFenceId ?? null,
        e.distanceFromGeoFenceM ?? null,
        e.reason ?? null,
      ]),
    ]
    const format = p.format === "xlsx" ? "xlsx" : "csv"
    await audit(ctx, "attendance.events.export", "AttendanceEvent", null,
      `Exported ${rows.length} attendance event rows as ${format.toUpperCase()}${truncated ? " (TRUNCATED at cap)" : ""}`)
    const exportedAt = new Date().toISOString()
    if (format === "xlsx") {
      // G4 — same SheetJS build as payroll.export.salary (salary-export.ts):
      // title row + header + data + cap note; sensible column widths.
      const aoa: (string | number | null | undefined)[][] = [
        [`Attendance Events Export — ${rows.length} row(s)${truncated ? " — TRUNCATED at 10,000 cap" : ""} — generated ${exportedAt}`],
        header,
        ...csvRows.slice(1),
      ]
      const ws = XLSX.utils.aoa_to_sheet(aoa)
      ws["!cols"] = header.map((h) => ({ wch: Math.max(12, Math.min(34, h.length + 8)) }))
      const wb = XLSX.utils.book_new()
      XLSX.utils.book_append_sheet(wb, ws, "Attendance Events")
      const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer
      return {
        filename: `attendance-events-${today()}.xlsx`,
        base64: buf.toString("base64"),
        rowCount: rows.length, truncated, exportedAt,
      }
    }
    return { csv: csv(csvRows), rowCount: rows.length, truncated, exportedAt }
  },
})

route("attendance.events.get", {
  perm: ["attendance", "view"],
  schema: S.byId,
  handler: async (ctx, p) => {
    const ev = await db.attendanceEvent.findFirst({ where: { id: p.id, vendorId: ctx.vendorId } })
    if (!ev) throw new Deny("Event not found", 404)
    await assertEmployeeVisible(ctx, ev.employeeId)
    const emp = await db.employee.findUnique({ where: { id: ev.employeeId }, select: { id: true, code: true, fullName: true } })
    // review queue statistics for the security tab
    const pending = await db.attendanceEvent.count({ where: { vendorId: ctx.vendorId, reviewStatus: "PENDING" } })
    return { ...ev, employeeCode: emp?.code, employeeName: emp?.fullName, pendingReviews: pending }
  },
})

/** Admin review decision on a suspicious/review event (§25, §57). */
route("attendance.events.review", {
  perm: ["attendance", "verify"],
  schema: z.object({
    id: z.string().min(1),
    decision: z.enum(["APPROVE", "REJECT"]),
    reason: z.string().max(1000).nullish(),
  }).strict(),
  handler: async (ctx, p) => {
    const ev = await db.attendanceEvent.findFirst({ where: { id: p.id, vendorId: ctx.vendorId } })
    if (!ev) throw new Deny("Event not found", 404)
    await assertEmployeeVisible(ctx, ev.employeeId)
    if (ev.reviewStatus === "APPROVED" || ev.reviewStatus === "REJECTED") throw new Deny("Event already reviewed")
    const updated = await db.attendanceEvent.update({
      where: { id: ev.id },
      data: {
        reviewStatus: p.decision === "APPROVE" ? "APPROVED" : "REJECTED",
        reviewedBy: ctx.userId,
        reviewedAt: new Date(),
        status: p.decision === "APPROVE" ? "ACCEPTED" : "REJECTED",
        reason: p.reason ?? ev.reason,
      },
    })
    const emp = await db.employee.findUnique({ where: { id: ev.employeeId }, select: { fullName: true } })
    await audit(ctx, "attendanceEvents.review", "AttendanceEvent", ev.id,
      `${p.decision === "APPROVE" ? "Approved" : "Rejected"} ${ev.eventType} event for ${emp?.fullName ?? ev.employeeId} (integrity: ${ev.locationIntegrityStatus ?? "n/a"})`,
      { oldValue: { reviewStatus: ev.reviewStatus, status: ev.status }, newValue: { reviewStatus: updated.reviewStatus, status: updated.status }, reason: p.reason })
    if (p.decision === "REJECT") {
      await notify(ctx.vendorId, { employeeId: ev.employeeId }, "Attendance Event Rejected",
        `Your ${ev.eventType.replace(/_/g, " ").toLowerCase()} was rejected after review.`, "ATTENDANCE_SECURITY", "attendance")
    }
    return updated
  },
})

// ================================================================ SELFIE PROOF

/** Store a selfie proof bound to an attendance event (§26–§27). The bytes are
 *  private: no /public, never in list payloads; hash + retention recorded.
 *  A selfie is EVIDENCE, never identity verification (§27). */
async function storeSelfieProof(
  vendorId: string,
  employeeId: string,
  attendanceEventId: string | null,
  p: { selfieDataUrl?: string | null; selfieMimeType?: string | null; latitude?: number | null; longitude?: number | null; accuracyM?: number | null; deviceId?: string | null },
  retentionDays: number
): Promise<{ id: string; fileHash: string } | null> {
  if (!p.selfieDataUrl) return null
  // L-29 — byte-level selfie validation (the data-URL prefix proved nothing);
  // the SNIFFED mime is stored, never the declared one.
  const check = validateSelfieDataUrl(String(p.selfieDataUrl))
  if (!check.ok) throw new Deny(check.reason, 400)
  const m = /^data:([^;]+);base64,([\s\S]+)$/.exec(String(p.selfieDataUrl))
  if (!m) throw new Deny("Selfie must be a base64 data URL", 400)
  const mime = check.mime
  const bytes = Buffer.from(m[2], "base64")
  const { createHash } = await import("node:crypto")
  const fileHash = createHash("sha256").update(bytes).digest("hex")
  const proof = await db.attendanceProof.create({
    data: {
      vendorId, employeeId, attendanceEventId,
      proofType: "SELFIE",
      storageKey: `proof/${vendorId}/${employeeId}/${Date.now()}`,
      mimeType: mime,
      fileHash,
      byteSize: bytes.byteLength,
      data: m[2],
      capturedAt: new Date(),
      latitude: p.latitude ?? null, longitude: p.longitude ?? null, accuracyM: p.accuracyM ?? null,
      deviceId: p.deviceId ?? null,
      verificationStatus: "EVIDENCE",
      retentionUntil: retentionDays > 0 ? new Date(Date.now() + retentionDays * 86_400_000) : null,
    },
  })
  return { id: proof.id, fileHash }
}

/** G1 — parse the stored capture-provenance JSON defensively (a malformed or
 *  legacy row must never break the audited view path). */
function safeQuality(json: string | null): Record<string, unknown> | null {
  if (!json) return null
  try { const v = JSON.parse(json); return v && typeof v === "object" ? v : null } catch { return null }
}

/** Protected selfie view (§26): permission-gated + STRICT audit (the audit row
 *  is part of the security posture — best-effort is not acceptable for PII). */
route("attendance.selfie.view", {
  perm: ["attendance", "download"],
  schema: S.byId,
  handler: async (ctx, p) => {
    const proof = await db.attendanceProof.findFirst({ where: { id: p.id, vendorId: ctx.vendorId } })
    if (!proof) throw new Deny("Selfie proof not found", 404)
    await assertEmployeeVisible(ctx, proof.employeeId)
    const emp = await db.employee.findUnique({ where: { id: proof.employeeId }, select: { code: true, fullName: true } })
    await auditStrict(ctx, "attendance.selfie.view", "AttendanceProof", proof.id,
      `Viewed selfie proof of ${emp?.fullName ?? proof.employeeId} (${emp?.code ?? "?"}) — event ${proof.attendanceEventId ?? "unlinked"}`)
    return { dataUrl: `data:${proof.mimeType};base64,${proof.data}`, mimeType: proof.mimeType, fileHash: proof.fileHash, capturedAt: proof.capturedAt, byteSize: proof.byteSize, quality: safeQuality(proof.qualityJson) }
  },
})

// ================================================================ MULTIPLE CHECK-IN

/** Periodic check validation + submission (§29–§32).
 *  validate=true → dry-run "can I check in now?" (mobile UX).
 *  Otherwise the periodic check is recorded: policy interval/limit/schedule
 *  enforced server-side, duplicate prevention via clientEventId idempotency. */
  // INTENTIONALLY_SELF_SCOPED (M-02): the employee checks in THEMSELF — identity
  // from the session (resolveSelfActor); policy/limits enforced server-side.
route("attendance.periodicCheck", {
  schema: S.attendanceAction,
  handler: async (ctx, p) => {
    const employeeId = await resolveSelfActor(ctx, p, "attendance.periodicCheck")
    // SUB-107 (R3-5) — periodic check-in is a TRACKING-policy feature (the
    // MULTIPLE_CHECKIN policy family + tracking intervals). The action lives
    // under the "attendance" prefix which maps to no plan feature, so a plan
    // without TRACKING still exposed it. Gate in-handler, mirroring
    // requireFieldForceFeature (fieldforce.ts).
    await requireFeature(ctx.vendorId, "TRACKING")
    await guardRate(ctx.userId, "attendanceEvent", "attendance check")
    const emp = await db.employee.findFirst({ where: { id: employeeId, vendorId: ctx.vendorId } })
    if (!emp) throw new Deny("Employee not found", 404)
    const policy = await resolveEffectivePolicy(ctx.vendorId, emp, "MULTIPLE_CHECKIN")
    if (!policy || !policyInSchedule(policy.policy as PolicyRecord)) {
      throw new Deny("No multiple check-in policy applies to you right now", 400)
    }
    const cfg = multipleCheckinConfig(policy.config)
    const now = new Date()
    const dayStart = new Date(`${today()}T00:00:00`)

    // Idempotency (§31/§65): retried request must not double-count
    if (p.clientEventId) {
      const dupe = await db.attendanceEvent.findFirst({ where: { vendorId: ctx.vendorId, employeeId, clientEventId: p.clientEventId } })
      if (dupe) return { ok: true, duplicate: true, eventId: dupe.id, nextCheckAt: new Date(dupe.occurredAt.getTime() + cfg.minIntervalMinutes * 60_000).toISOString() }
    }

    // Daily cap
    const todayCount = await db.attendanceEvent.count({
      where: { vendorId: ctx.vendorId, employeeId, eventType: { in: ["PERIODIC_CHECK_IN", "PERIODIC_VERIFICATION"] }, occurredAt: { gte: dayStart } },
    })
    if (todayCount >= cfg.maxPerDay) throw new Deny(`Daily periodic check-in limit reached (${cfg.maxPerDay})`, 429)

    // Minimum interval (§31: "This check-in is too soon")
    const last = await db.attendanceEvent.findFirst({
      where: { vendorId: ctx.vendorId, employeeId, eventType: { in: ["CHECK_IN", "PERIODIC_CHECK_IN", "PERIODIC_VERIFICATION"] }, occurredAt: { gte: dayStart } },
      orderBy: { occurredAt: "desc" },
    })
    if (last) {
      const elapsedMin = (now.getTime() - last.occurredAt.getTime()) / 60_000
      if (elapsedMin < cfg.minIntervalMinutes) {
        throw new Deny(`This check-in is too soon — next check-in allowed in ${Math.ceil(cfg.minIntervalMinutes - elapsedMin)} minute(s)`, 429)
      }
    }

    // Method enforcement (§30) — the policy decides what's allowed
    const requestedMethod = p.selfieDataUrl ? (p.latitude != null ? "GEOFENCE_SELFIE" : "SELFIE") : "GEOFENCE"
    const allowedMethods = cfg.methods ?? ["GEOFENCE", "SELFIE", "GEOFENCE_SELFIE", "DEVICE_PUNCH"]
    if (!allowedMethods.includes(requestedMethod)) {
      throw new Deny(`This periodic check method (${requestedMethod.replace(/_/g, " ").toLowerCase()}) is not allowed by your policy`, 400)
    }

    // Location + fence + integrity pipeline (same rules as check-in, §22–§25)
    let fenceEval = null
    let integrity = null
    if (p.latitude != null && p.longitude != null) {
      const trackingPolicy = await resolveEffectivePolicy(ctx.vendorId, emp, "TRACKING")
      const tCfg = trackingConfig(trackingPolicy?.config)
      const fences = await effectiveFencesFor(ctx.vendorId, emp)
      fenceEval = fences.length ? evaluateFences(fences, p.latitude, p.longitude, p.accuracyM, { maxAccuracyM: tCfg.maxAccuracyM, now }) : null
      const prev = await db.trackingPoint.findFirst({ where: { vendorId: ctx.vendorId, employeeId }, orderBy: { timestamp: "desc" } })
      integrity = analyzeLocationIntegrity(
        { latitude: p.latitude, longitude: p.longitude, accuracyM: p.accuracyM, clientTimestamp: p.clientTimestamp, isMockLocation: p.isMockLocation, deviceId: p.deviceId },
        prev ? { latitude: prev.latitude, longitude: prev.longitude, at: prev.timestamp } : null,
        now, { maxAccuracyM: tCfg.maxAccuracyM, suspiciousAction: tCfg.suspiciousAction }
      )
      if (integrity.decision === "REJECT") {
        throw new Deny("Location integrity could not be verified — this check-in was rejected", 400)
      }
    }

    // Selfie proof when the method requires it
    const settings = await getSettings(ctx.vendorId)
    const retentionDays = Number((settings as any).tracking?.retentionDays ?? 90)
    let proofId: string | null = null
    if (p.selfieDataUrl) {
      // SUB-106 — meter the incoming selfie bytes against the STORAGE quota
      // before the proof (and the event below it) are written.
      await requireSelfieStorage(ctx.vendorId, p.selfieDataUrl)
      const stored = await storeSelfieProof(ctx.vendorId, employeeId, null, p as any, retentionDays)
      proofId = stored?.id ?? null
    } else if (requestedMethod === "SELFIE" || requestedMethod === "GEOFENCE_SELFIE") {
      throw new Deny("This attendance requires a selfie", 400)
    }

    const status = integrity ? integrityToEventStatus(integrity) : "ACCEPTED"
    const event = await recordTrackingEvent(ctx.vendorId, employeeId, "PERIODIC_CHECK_IN", "MOBILE", now, {
      attendanceMethod: requestedMethod,
      latitude: p.latitude ?? null, longitude: p.longitude ?? null, accuracyM: p.accuracyM ?? null,
      batteryPercentage: p.batteryPercentage ?? null, isCharging: p.isCharging ?? null,
      gpsStatus: p.gpsStatus ?? null, networkStatus: p.networkStatus ?? null,
      deviceId: p.deviceId ?? null, mobileSessionId: p.mobileSessionId ?? null,
      geoFenceId: fenceEval?.fence?.id ?? null, distanceFromGeoFenceM: fenceEval?.distanceM ?? null,
      locationIntegrityStatus: integrity?.status ?? null,
      policyId: policy.policy.id,
      clientEventId: p.clientEventId ?? null,
      clientTimestamp: p.clientTimestamp ?? null,
      selfieProofId: proofId,
      status,
      reviewStatus: status === "REVIEW_REQUIRED" || status === "SUSPICIOUS" ? "PENDING" : "NONE",
      flags: { signals: integrity?.signals ?? [], decision: integrity?.decision ?? "ALLOW", periodicIntervalMin: cfg.minIntervalMinutes, checkNumber: todayCount + 1 },
    })
    if (!event) return { ok: true, duplicate: true, eventId: null, nextCheckAt: new Date(now.getTime() + cfg.minIntervalMinutes * 60_000).toISOString() }
    if (proofId) await db.attendanceProof.update({ where: { id: proofId }, data: { attendanceEventId: event.id } })

    // refresh tracking state with the periodic fix (§9)
    if (p.latitude != null) {
      await upsertTrackingState(ctx.vendorId, employeeId, {
        trackingStatus: "TRACKING", lastSeenAt: now, latitude: p.latitude, longitude: p.longitude,
        accuracyM: p.accuracyM ?? null, batteryPercentage: p.batteryPercentage ?? null,
        isCharging: p.isCharging ?? null, gpsStatus: p.gpsStatus ?? "OK", networkStatus: p.networkStatus ?? "ONLINE",
        geoFenceId: fenceEval?.fence?.id ?? null, insideGeoFence: fenceEval ? fenceEval.ok : null,
        lastEventId: event.id, lastPolicyId: policy.policy.id,
      })
    }
    if (status === "REVIEW_REQUIRED") {
      await notify(ctx.vendorId, { role: "HR_ADMIN" }, "Attendance Needs Review",
        `A periodic check-in from ${emp.fullName} requires review (${integrity?.status ?? "suspicious location"}).`, "ATTENDANCE_SECURITY", "attendance")
    }
    await audit(ctx, "attendance.periodicCheck", "AttendanceEvent", event.id,
      `Periodic check #${todayCount + 1} by ${emp.fullName} (${emp.code}) — ${requestedMethod}, ${fenceEval?.ok ? `inside ${fenceEval.fence?.name}` : fenceEval ? "outside fence" : "no fence"}`, { reason: integrity?.notes })
    return {
      ok: true,
      duplicate: false,
      eventId: event.id,
      status,
      nextCheckAt: new Date(now.getTime() + cfg.minIntervalMinutes * 60_000).toISOString(),
      remainingToday: Math.max(0, cfg.maxPerDay - (todayCount + 1)),
    }
  },
})

/** Dry-run validation for the mobile client (§31 UX): why can't I check in? */
  // INTENTIONALLY_SELF_SCOPED (M-02): read-only "can I check in now" for the
  // caller's own record (resolveSelfActor enforces own-record-only).
route("attendance.multipleCheckin.validate", {
  handler: async (ctx, p) => {
    const employeeId = await resolveSelfActor(ctx, p, "attendance.multipleCheckin.validate")
    const emp = await db.employee.findFirst({ where: { id: employeeId, vendorId: ctx.vendorId } })
    if (!emp) throw new Deny("Employee not found", 404)
    const policy = await resolveEffectivePolicy(ctx.vendorId, emp, "MULTIPLE_CHECKIN")
    if (!policy) return { allowed: false, reason: "No multiple check-in policy applies to you" }
    const cfg = multipleCheckinConfig(policy.config)
    const now = new Date()
    const dayStart = new Date(`${today()}T00:00:00`)
    const inSchedule = policyInSchedule(policy.policy as PolicyRecord, now)
    const todayCount = await db.attendanceEvent.count({
      where: { vendorId: ctx.vendorId, employeeId, eventType: { in: ["PERIODIC_CHECK_IN", "PERIODIC_VERIFICATION"] }, occurredAt: { gte: dayStart } },
    })
    const last = await db.attendanceEvent.findFirst({
      where: { vendorId: ctx.vendorId, employeeId, eventType: { in: ["CHECK_IN", "PERIODIC_CHECK_IN", "PERIODIC_VERIFICATION"] }, occurredAt: { gte: dayStart } },
      orderBy: { occurredAt: "desc" },
    })
    let nextAt: string | null = null
    let reason: string | null = null
    if (!inSchedule) reason = "Outside the multiple check-in schedule"
    else if (todayCount >= cfg.maxPerDay) reason = `Daily limit reached (${cfg.maxPerDay})`
    else if (last) {
      const elapsedMin = (now.getTime() - last.occurredAt.getTime()) / 60_000
      if (elapsedMin < cfg.minIntervalMinutes) {
        reason = `Next check-in in ${Math.ceil(cfg.minIntervalMinutes - elapsedMin)} minute(s)`
        nextAt = new Date(last.occurredAt.getTime() + cfg.minIntervalMinutes * 60_000).toISOString()
      }
    }
    return {
      allowed: !reason,
      reason,
      nextCheckAt: nextAt,
      policySource: policy.source,
      intervalMinutes: cfg.minIntervalMinutes,
      remainingToday: Math.max(0, cfg.maxPerDay - todayCount),
      allowedMethods: cfg.methods,
    }
  },
})

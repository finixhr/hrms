// ============ Live tracking engine (2026-10 round §8–§17, §64) ============
// Mobile ingestion pipeline:
//   authenticate (route layer) → resolve employee from session (never payload)
//   → validate payload + timestamp → evaluate effective policy
//   → integrity checks → append TrackingPoint → upsert EmployeeTrackingState
//   → battery/GPS/fence security events + notifications when needed
//
// Performance (§38): the live dashboard reads EmployeeTrackingState ONLY —
// never the history table. History endpoints are paginated + date-scoped.
// The ingestion path avoids expensive joins (single indexed reads).
import { db } from "@/lib/db"
import { notify } from "./audit"
import { getSettings } from "./settings"
import { resolveEffectivePolicy, trackingConfig } from "./attendance-policy"
import { effectiveFencesFor, evaluateFences } from "./geo"
import { analyzeLocationIntegrity, type IntegrityVerdict } from "./location-integrity"

export type LocationPing = {
  latitude: number
  longitude: number
  accuracyM?: number | null
  altitude?: number | null
  speed?: number | null
  heading?: number | null
  batteryPercentage?: number | null
  isCharging?: boolean | null
  gpsStatus?: string | null // OK | DISABLED
  networkStatus?: string | null
  clientTimestamp?: string | null
  clientEventId?: string | null
  isMockLocation?: boolean | null
  deviceId?: string | null
  trackingSessionId?: string | null
}

export type IngestResult = {
  ok: boolean
  duplicate: boolean
  trackingStatus: string
  intervalSec: number
  integrity: IntegrityVerdict | null
  events: string[] // recorded AttendanceEvent types
  message?: string
}

/** M-17 — per-(employee, event) alarm debounce. A field employee outside a
 *  geo-fence for a whole workday used to emit ~480 GEOFENCE_VIOLATION events
 *  (one per ping) plus a notification row per HR admin per ping. Repeat alarm
 *  events (fence violation, critical battery, security flag, GPS-disabled)
 *  now collapse into the first occurrence per 15-minute window: the live
 *  status is still recomputed on every ping, but no new event/notification is
 *  written until the window lapses. */
const ALARM_DEBOUNCE_MS = 15 * 60_000

async function alarmRecentlyEmitted(vendorId: string, employeeId: string, eventType: string): Promise<boolean> {
  const last = await db.attendanceEvent.findFirst({
    where: { vendorId, employeeId, eventType },
    orderBy: { occurredAt: "desc" },
    select: { occurredAt: true },
  })
  return !!last && Date.now() - new Date(last.occurredAt).getTime() < ALARM_DEBOUNCE_MS
}

/**
 * Ingest one location ping from the mobile client. Idempotent on
 * (vendor, clientEventId): a retried upload NEVER creates a duplicate
 * TrackingPoint (§65) — the previous result is echoed.
 */
export async function ingestLocation(vendorId: string, employeeId: string, ping: LocationPing): Promise<IngestResult> {
  const emp = await db.employee.findFirst({ where: { id: employeeId, vendorId }, select: { id: true, branchId: true, departmentId: true, fullName: true } })
  if (!emp) return { ok: false, duplicate: false, trackingStatus: "OFFLINE", intervalSec: 60, integrity: null, events: [], message: "Employee not found" }

  // Idempotency — echo the previous outcome for retried uploads (§65)
  if (ping.clientEventId) {
    const dupe = await db.trackingPoint.findFirst({ where: { vendorId, employeeId, clientEventId: ping.clientEventId } })
    if (dupe) {
      const state = await db.employeeTrackingState.findUnique({ where: { employeeId } })
      return { ok: true, duplicate: true, trackingStatus: state?.trackingStatus ?? "TRACKING", intervalSec: 60, integrity: null, events: [], message: "duplicate" }
    }
  }

  const now = new Date()
  const policy = await resolveEffectivePolicy(vendorId, emp, "TRACKING", now)
  const cfg = trackingConfig(policy?.config)
  const s = await getSettings(vendorId)
  const trackingDefaults = (s as any).tracking ?? {}
  const intervalSec = Number(policy?.config?.updateIntervalSec ?? trackingDefaults.updateIntervalSec ?? 60)

  // M-16 — consent gate (mirrors the tracking.status contract): the vendor-wide
  // toggle (Settings → Tracking) AND the per-employee admin toggle
  // (tracking.start/stop) must both permit tracking. A still-running mobile
  // client after tracking.stop — or after a global disable — is refused: no
  // telemetry stored, no events fired, no notifications fanned out. The old
  // ingest kept appending points and GEOFENCE_VIOLATION events regardless of
  // consent (absent state row = not opted out, exactly as tracking.status
  // resolves it).
  const consentState = await db.employeeTrackingState.findUnique({ where: { employeeId } })
  const vendorTrackingOn = trackingDefaults.enabled !== false
  const employeeTrackingOn = consentState?.trackingEnabled ?? true
  if (!vendorTrackingOn || !employeeTrackingOn) {
    return {
      ok: false, duplicate: false, trackingStatus: "NOT_TRACKING", intervalSec: 0, integrity: null, events: [],
      message: "Tracking is disabled for this account — location updates are not accepted",
    }
  }

  // Previous fix for movement-integrity analysis (most recent point)
  const prevPoint = await db.trackingPoint.findFirst({
    where: { vendorId, employeeId },
    orderBy: { timestamp: "desc" },
  })

  // GPS disabled report (§16) — client detected the OS location service went
  // off and reports it with the last known fix. We record the event, keep the
  // last known location visible and notify.
  if (ping.gpsStatus === "DISABLED") {
    let ev = null
    if (!(await alarmRecentlyEmitted(vendorId, employeeId, "GPS_DISABLED"))) {
      ev = await recordTrackingEvent(vendorId, employeeId, "GPS_DISABLED", "MOBILE", now, {
        latitude: ping.latitude, longitude: ping.longitude, accuracyM: ping.accuracyM,
        batteryPercentage: ping.batteryPercentage, isCharging: ping.isCharging,
        gpsStatus: "DISABLED", networkStatus: ping.networkStatus, deviceId: ping.deviceId,
        policyId: policy?.policy.id, clientEventId: ping.clientEventId ? `gps:${ping.clientEventId}` : null,
        reason: "Client reported location services disabled during active tracking",
      })
      await notifyTrackingEvent(vendorId, emp.fullName, "gps_disabled",
        "GPS Disabled", `${emp.fullName}'s location services were disabled during tracking hours.`)
    }
    await upsertTrackingState(vendorId, employeeId, {
      deviceId: ping.deviceId, trackingStatus: "GPS_DISABLED", lastSeenAt: now,
      gpsStatus: "DISABLED", networkStatus: ping.networkStatus,
      batteryPercentage: ping.batteryPercentage, isCharging: ping.isCharging,
      lastPolicyId: policy?.policy.id ?? null, lastEventId: ev?.id ?? null,
    })
    return { ok: true, duplicate: false, trackingStatus: "GPS_DISABLED", intervalSec, integrity: null, events: ["GPS_DISABLED"] }
  }

  // Location integrity analysis (§24) — movement vs previous fix
  const state = await db.employeeTrackingState.findUnique({ where: { employeeId } })
  const verdict = analyzeLocationIntegrity(
    {
      latitude: ping.latitude, longitude: ping.longitude, accuracyM: ping.accuracyM,
      speed: ping.speed, clientTimestamp: ping.clientTimestamp,
      isMockLocation: ping.isMockLocation, deviceId: ping.deviceId,
      boundDeviceId: state?.deviceId ?? null,
    },
    prevPoint ? { latitude: prevPoint.latitude, longitude: prevPoint.longitude, at: prevPoint.timestamp, accuracyM: prevPoint.accuracyM } : null,
    now, { maxAccuracyM: cfg.maxAccuracyM, suspiciousAction: cfg.suspiciousAction }
  )

  // Append-only history point (§10)
  const point = await db.trackingPoint.create({
    data: {
      vendorId, employeeId, deviceId: ping.deviceId ?? null, timestamp: now,
      clientTimestamp: ping.clientTimestamp ?? null,
      latitude: ping.latitude, longitude: ping.longitude,
      accuracyM: ping.accuracyM ?? null, altitude: ping.altitude ?? null,
      speed: ping.speed ?? null, heading: ping.heading ?? null,
      batteryPercentage: ping.batteryPercentage ?? null, isCharging: ping.isCharging ?? null,
      gpsStatus: ping.gpsStatus ?? "OK", networkStatus: ping.networkStatus ?? "ONLINE",
      trackingSessionId: ping.trackingSessionId ?? null,
      locationIntegrityStatus: verdict.status,
      clientEventId: ping.clientEventId ?? null,
    },
  })

  // Geo-fence proximity (server-computed, §22)
  const fences = await effectiveFencesFor(vendorId, emp)
  const fenceEval = fences.length
    ? evaluateFences(fences, ping.latitude, ping.longitude, ping.accuracyM, { maxAccuracyM: cfg.maxAccuracyM, now })
    : null

  // Evidence-based tracking status (§15): never invent "phone powered off" —
  // derive from what the data actually supports.
  let status = "TRACKING"
  const events: string[] = []
  const battery = ping.batteryPercentage ?? null
  if (verdict.status !== "VERIFIED" && verdict.decision === "REVIEW" && (verdict.status === "MOCK_LOCATION" || verdict.status === "IMPOSSIBLE_MOVEMENT" || verdict.status === "DEVICE_MISMATCH")) {
    status = "SUSPICIOUS"
    events.push("SECURITY_FLAG")
    const securityDebounced = await alarmRecentlyEmitted(vendorId, employeeId, "SECURITY_FLAG")
    if (!securityDebounced) await recordTrackingEvent(vendorId, employeeId, "SECURITY_FLAG", "MOBILE", now, {
      latitude: ping.latitude, longitude: ping.longitude, accuracyM: ping.accuracyM,
      batteryPercentage: battery, isCharging: ping.isCharging, gpsStatus: ping.gpsStatus,
      networkStatus: ping.networkStatus, deviceId: ping.deviceId, policyId: policy?.policy.id,
      locationIntegrityStatus: verdict.status, reason: `Location integrity: ${verdict.notes}`,
      flags: { signals: verdict.signals, decision: verdict.decision },
      clientEventId: ping.clientEventId ? `sec:${ping.clientEventId}` : null,
    })
    if (!securityDebounced) await notifyTrackingEvent(vendorId, emp.fullName, "location_spoof_suspected",
      "Suspicious Location", `A location update from ${emp.fullName} was flagged: ${verdict.status.replace(/_/g, " ").toLowerCase()}.`)
  } else if (fenceEval && !fenceEval.ok && !fenceEval.reason?.startsWith("REVIEW:")) {
    status = "OUTSIDE_GEOFENCE"
    events.push("GEOFENCE_VIOLATION")
    const fenceDebounced = await alarmRecentlyEmitted(vendorId, employeeId, "GEOFENCE_VIOLATION")
    if (!fenceDebounced) await recordTrackingEvent(vendorId, employeeId, "GEOFENCE_VIOLATION", "MOBILE", now, {
      latitude: ping.latitude, longitude: ping.longitude, accuracyM: ping.accuracyM,
      batteryPercentage: battery, isCharging: ping.isCharging, gpsStatus: ping.gpsStatus,
      networkStatus: ping.networkStatus, deviceId: ping.deviceId, policyId: policy?.policy.id,
      geoFenceId: fenceEval.fence?.id ?? null, distanceFromGeoFenceM: fenceEval.distanceM ?? null,
      reason: `Outside ${fenceEval.fence?.name ?? "assigned fence"}`,
      clientEventId: ping.clientEventId ? `fence:${ping.clientEventId}` : null,
    })
    if (!fenceDebounced) await notifyTrackingEvent(vendorId, emp.fullName, "geofence_violation",
      "Outside Geo-Fence", `${emp.fullName} is outside the assigned geo-fence (${fenceEval.distanceM ?? "?"}m away).`)
  } else if (battery != null && battery <= cfg.criticalBatteryThreshold) {
    status = "LOW_BATTERY"
    events.push("LOW_BATTERY")
    const batteryDebounced = await alarmRecentlyEmitted(vendorId, employeeId, "LOW_BATTERY")
    if (!batteryDebounced) await recordTrackingEvent(vendorId, employeeId, "LOW_BATTERY", "MOBILE", now, {
      latitude: ping.latitude, longitude: ping.longitude, accuracyM: ping.accuracyM,
      batteryPercentage: battery, isCharging: ping.isCharging, gpsStatus: ping.gpsStatus,
      networkStatus: ping.networkStatus, deviceId: ping.deviceId, policyId: policy?.policy.id,
      reason: `Critical battery ${battery}%`,
      clientEventId: ping.clientEventId ? `bat:${ping.clientEventId}` : null,
    })
    if (!batteryDebounced) await notifyTrackingEvent(vendorId, emp.fullName, "low_battery",
      "Critical Battery", `${emp.fullName}'s device battery is at ${battery}%.`)
  } else if (battery != null && battery <= cfg.lowBatteryThreshold) {
    status = "LOW_BATTERY"
  } else if (ping.accuracyM != null && ping.accuracyM > cfg.maxAccuracyM) {
    status = "LOW_ACCURACY"
  } else if (fenceEval && fenceEval.ok) {
    status = "TRACKING"
  }

  await upsertTrackingState(vendorId, employeeId, {
    deviceId: ping.deviceId, trackingStatus: status, lastSeenAt: now,
    latitude: ping.latitude, longitude: ping.longitude, accuracyM: ping.accuracyM ?? null,
    batteryPercentage: battery, isCharging: ping.isCharging ?? null,
    gpsStatus: ping.gpsStatus ?? "OK", networkStatus: ping.networkStatus ?? "ONLINE",
    geoFenceId: fenceEval?.fence?.id ?? null, insideGeoFence: fenceEval ? fenceEval.ok : null,
    lastEventId: point.id, lastPolicyId: policy?.policy.id ?? null,
  })

  return { ok: true, duplicate: false, trackingStatus: status, intervalSec, integrity: verdict, events }
}

/** Append an AttendanceEvent row (immutable, §4). Returns null on idempotent skip. */
export async function recordTrackingEvent(
  vendorId: string,
  employeeId: string,
  eventType: string,
  source: string,
  occurredAt: Date,
  extra: {
    latitude?: number | null; longitude?: number | null; accuracyM?: number | null
    batteryPercentage?: number | null; isCharging?: boolean | null
    gpsStatus?: string | null; networkStatus?: string | null; deviceId?: string | null
    mobileSessionId?: string | null; geoFenceId?: string | null
    distanceFromGeoFenceM?: number | null; locationIntegrityStatus?: string | null
    policyId?: string | null; clientEventId?: string | null; reason?: string | null
    status?: string; reviewStatus?: string; flags?: Record<string, unknown>
    attendanceMethod?: string; clientTimestamp?: string | null
    selfieProofId?: string | null; attendanceId?: string | null; rawEventId?: string | null
  } = {}
) {
  try {
    return await db.attendanceEvent.create({
      data: {
        vendorId, employeeId, eventType,
        attendanceMethod: extra.attendanceMethod ?? "MOBILE",
        source, occurredAt,
        latitude: extra.latitude ?? null, longitude: extra.longitude ?? null,
        accuracyM: extra.accuracyM ?? null,
        batteryPercentage: extra.batteryPercentage ?? null, isCharging: extra.isCharging ?? null,
        gpsStatus: extra.gpsStatus ?? null, networkStatus: extra.networkStatus ?? null,
        deviceId: extra.deviceId ?? null, mobileSessionId: extra.mobileSessionId ?? null,
        geoFenceId: extra.geoFenceId ?? null, distanceFromGeoFenceM: extra.distanceFromGeoFenceM ?? null,
        locationIntegrityStatus: extra.locationIntegrityStatus ?? null,
        policyId: extra.policyId ?? null, clientEventId: extra.clientEventId ?? null,
        reason: extra.reason ?? null,
        status: extra.status ?? "ACCEPTED",
        reviewStatus: extra.reviewStatus ?? (extra.status === "REVIEW_REQUIRED" || extra.status === "SUSPICIOUS" ? "PENDING" : "NONE"),
        flagsJson: JSON.stringify(extra.flags ?? {}),
        clientTimestamp: extra.clientTimestamp ?? null,
        selfieProofId: extra.selfieProofId ?? null,
        attendanceId: extra.attendanceId ?? null,
        rawEventId: extra.rawEventId ?? null,
      },
    })
  } catch (e: any) {
    // unique(vendorId, clientEventId) violation = idempotent retry → skip
    if (String(e?.code) === "P2002") return null
    throw e
  }
}

/** Upsert the per-employee current-state row (§9). */
export async function upsertTrackingState(
  vendorId: string,
  employeeId: string,
  patch: {
    deviceId?: string | null; trackingStatus: string; lastSeenAt?: Date | null
    latitude?: number | null; longitude?: number | null; accuracyM?: number | null
    batteryPercentage?: number | null; isCharging?: boolean | null
    gpsStatus?: string | null; networkStatus?: string | null
    geoFenceId?: string | null; insideGeoFence?: boolean | null
    lastEventId?: string | null; lastPolicyId?: string | null
    trackingEnabled?: boolean; sessionStartedAt?: Date | null
  }
) {
  const existing = await db.employeeTrackingState.findUnique({ where: { employeeId } })
  if (existing) {
    return db.employeeTrackingState.update({ where: { employeeId }, data: patch as any })
  }
  return db.employeeTrackingState.create({
    data: {
      vendorId, employeeId,
      trackingEnabled: patch.trackingEnabled ?? true,
      sessionStartedAt: patch.sessionStartedAt ?? new Date(),
      ...patch,
    } as any,
  })
}

/** Notification matrix aware tracking notification (§16–§17). */
export async function notifyTrackingEvent(vendorId: string, _employeeName: string, _eventKey: string, title: string, message: string) {
  // In-app notification to HR admins (existing Notification system — §56: no
  // second framework). Email/SMS fan-out respects notificationMatrix via the
  // existing delivery layer when those channels are enabled for the event.
  try {
    await notify(vendorId, { role: "HR_ADMIN" }, title, message, "ATTENDANCE_SECURITY", "attendance")
  } catch { /* notification must never break ingestion (§64) */ }
}

/**
 * Offline-state reconciliation (§15): called from the jobs scheduler — flips
 * stale tracking states to evidence-based offline statuses. A state that went
 * silent AFTER reporting low battery becomes OFFLINE_AFTER_LOW_BATTERY (the
 * honest label — we never claim deliberate power-off; L-11 removed the
 * POWER_OFF_UNCONFIRMED / NETWORK_LOST states the engine never assigned).
 */
export async function reconcileOfflineStates(): Promise<{ checked: number; flipped: number }> {
  const vendors = await db.vendor.findMany({ where: { active: true }, select: { id: true } })
  let checked = 0
  let flipped = 0
  for (const v of vendors) {
    const s = await getSettings(v.id)
    const defaults = (s as any).tracking ?? {}
    const defaultOfflineMin = Number(defaults.offlineAfterMinutes ?? 15)
    // L-11 — only statuses the engine can actually ASSIGN are excluded; a
    // legacy row still holding a removed status value is re-reconciled (and
    // healed to OFFLINE / OFFLINE_AFTER_LOW_BATTERY) instead of being skipped.
    const states = await db.employeeTrackingState.findMany({
      where: { vendorId: v.id, trackingEnabled: true, trackingStatus: { notIn: ["OFFLINE", "OFFLINE_AFTER_LOW_BATTERY"] } },
    })
    for (const st of states) {
      checked++
      if (!st.lastSeenAt) continue
      // employee's own tracking policy may define a longer offline window
      const emp = await db.employee.findUnique({ where: { id: st.employeeId }, select: { id: true, branchId: true, departmentId: true } })
      if (!emp) continue
      const policy = await resolveEffectivePolicy(v.id, emp, "TRACKING")
      const cfg = trackingConfig(policy?.config)
      const offlineMin = Number(policy?.config?.offlineAfterMinutes ?? defaultOfflineMin)
      const silentMs = Date.now() - st.lastSeenAt.getTime()
      if (silentMs > offlineMin * 60_000) {
        const afterLowBattery = (st.batteryPercentage ?? 100) <= cfg.criticalBatteryThreshold
        const next = afterLowBattery ? "OFFLINE_AFTER_LOW_BATTERY" : "OFFLINE"
        await db.employeeTrackingState.update({ where: { employeeId: st.employeeId }, data: { trackingStatus: next } })
        flipped++
      }
    }
  }
  return { checked, flipped }
}

/**
 * Retention sweeper (§61): deletes raw TrackingPoint telemetry older than the
 * vendor's retention window. NEVER touches Attendance summaries, AttendanceEvent
 * (attendance evidence), audit logs or payroll history — those have separate,
 * longer-term retention semantics.
 */
export async function sweepTrackingRetention(): Promise<{ deleted: number }> {
  const vendors = await db.vendor.findMany({ where: { active: true }, select: { id: true } })
  let deleted = 0
  for (const v of vendors) {
    const s = await getSettings(v.id)
    const days = Number((s as any).tracking?.retentionDays ?? 90)
    if (!days || days <= 0) continue // 0 = keep forever
    const cutoff = new Date(Date.now() - days * 86_400_000)
    const r = await db.trackingPoint.deleteMany({ where: { vendorId: v.id, timestamp: { lt: cutoff } } })
    deleted += r.count
  }
  return { deleted }
}

/** Selfie-proof retention sweep — expired evidence rows are removed. */
export async function sweepProofRetention(): Promise<{ deleted: number }> {
  const r = await db.attendanceProof.deleteMany({ where: { retentionUntil: { lt: new Date() } } })
  return { deleted: r.count }
}

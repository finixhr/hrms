// ============ Location integrity / anti-spoofing engine (2026-10 round §24–§25) ============
// Multi-signal location fraud detection. The mobile client REPORTS signals
// (mock-location flag, provider, timestamps) but the server NEVER blindly
// trusts them — every signal is either independently verifiable server-side
// (speed, jumps, staleness, repetition, accuracy) or treated as a hint that
// only DOWNGRADES confidence.
//
// Output: locationIntegrityStatus + recommended decision per policy
// (ALLOW / WARN / REVIEW / REJECT — §25). "REVIEW" parks the attendance as
// review-required instead of auto-rejecting; an admin inspects the event.
import type { TrackingConfig } from "./attendance-policy"

export type IntegrityStatus =
  | "VERIFIED"
  | "SUSPICIOUS"
  | "MOCK_LOCATION"
  | "IMPOSSIBLE_MOVEMENT"
  | "STALE_LOCATION"
  | "LOW_ACCURACY"
  | "TIMESTAMP_ANOMALY"
  | "DEVICE_MISMATCH"

export type IntegrityInput = {
  latitude: number
  longitude: number
  accuracyM?: number | null
  speed?: number | null
  /** device-reported clock at capture (ISO string or epoch ms) — forensic only */
  clientTimestamp?: string | null
  /** client-declared mock-location / developer-mode flags (hints, not proof) */
  isMockLocation?: boolean | null
  provider?: string | null
  deviceId?: string | null
  /** the device id bound to this employee's active tracking session (server state) */
  boundDeviceId?: string | null
}

export type PreviousFix = {
  latitude: number
  longitude: number
  at: Date
  accuracyM?: number | null
} | null

export type IntegrityVerdict = {
  status: IntegrityStatus
  /** signals that fired — recorded in flagsJson for the review UI */
  signals: string[]
  /** recommended handling for the configured policy action (§25) */
  decision: "ALLOW" | "WARN" | "REVIEW" | "REJECT"
  notes: string
}

/** Hard ceiling for plausible human movement (m/s) — Usain Bolt ≈ 10.4; add
 *  headroom for GPS jitter, but 35 m/s (126 km/h sustained between fixes) is
 *  only explainable by motorway travel — anything above is implausible for a
 *  workplace check-in cadence. */
const IMPLAUSIBLE_SPEED_MS = 35
/** A fix older than this is stale evidence (§24 "stale locations"). */
const STALE_AFTER_MS = 10 * 60_000
/** Client clock skew beyond this (vs server receive time) is an anomaly signal. */
const CLOCK_SKEW_MS = 5 * 60_000
/** Identical coordinates (to 1e-6 deg ≈ 11cm) repeated across separate pings. */
const IDENTICAL_EPSILON = 1e-6

export function analyzeLocationIntegrity(
  input: IntegrityInput,
  previous: PreviousFix,
  serverNow: Date,
  cfg: Pick<TrackingConfig, "maxAccuracyM" | "suspiciousAction"> = { maxAccuracyM: 150, suspiciousAction: "REVIEW" }
): IntegrityVerdict {
  const signals: string[] = []
  let status: IntegrityStatus = "VERIFIED"
  let hard = false // hard evidence of fraud/impossibility
  const now = serverNow.getTime()

  // --- 1. client-declared mock location (downgrade-only hint; spoofers lie) ---
  if (input.isMockLocation === true) {
    signals.push("client_reported_mock_location")
    status = "MOCK_LOCATION"
    hard = true
  }

  // --- 2. impossible movement: distance/Δt vs plausible speed ---
  if (previous) {
    const dtMs = now - previous.at.getTime()
    if (dtMs > 0) {
      const d = haversineM(input.latitude, input.longitude, previous.latitude, previous.longitude)
      const v = d / (dtMs / 1000)
      if (v > IMPLAUSIBLE_SPEED_MS && d > 100) {
        signals.push(`impossible_movement:${Math.round(v)}m/s_over_${Math.round(d)}m`)
        if (status === "VERIFIED") status = "IMPOSSIBLE_MOVEMENT"
        hard = true
      } else if (v > 13 && d > 500) {
        // sustained >47 km/h between fixes — possible (vehicle) but noteworthy
        signals.push(`high_speed:${Math.round(v)}m/s`)
        if (status === "VERIFIED") status = "SUSPICIOUS"
      }
      // repeated identical coordinates across separate pings (jitter-free GPS
      // is not a thing — a frozen fix screams replayed/spoofed telemetry)
      if (
        Math.abs(input.latitude - previous.latitude) < IDENTICAL_EPSILON &&
        Math.abs(input.longitude - previous.longitude) < IDENTICAL_EPSILON &&
        dtMs > 60_000
      ) {
        signals.push("repeated_identical_location")
        if (status === "VERIFIED") status = "SUSPICIOUS"
      }
    }
  }

  // --- 3. client-reported speed sanity (if provided) ---
  if (input.speed != null && Number.isFinite(input.speed) && input.speed > IMPLAUSIBLE_SPEED_MS) {
    signals.push(`client_speed_implausible:${Math.round(input.speed)}m/s`)
    if (status === "VERIFIED") status = "SUSPICIOUS"
  }

  // --- 4. timestamp anomalies (§80: client clock manipulation detection) ---
  const ct = parseClientTime(input.clientTimestamp)
  if (ct != null) {
    const skew = now - ct
    // STALE check first — a genuinely old captured fix is the more specific
    // diagnosis than generic clock skew (§24 "stale locations"); skew without
    // staleness stays TIMESTAMP_ANOMALY (clock wrong, capture fresh).
    if (now - ct > STALE_AFTER_MS) {
      signals.push(`stale_location:${Math.round((now - ct) / 60000)}min_old`)
      if (status === "VERIFIED") status = "STALE_LOCATION"
    } else if (skew > CLOCK_SKEW_MS) {
      signals.push(`client_clock_behind_by_${Math.round(skew / 1000)}s`)
      if (status === "VERIFIED") status = "TIMESTAMP_ANOMALY"
    } else if (skew < -CLOCK_SKEW_MS) {
      signals.push(`client_clock_ahead_by_${Math.round(-skew / 1000)}s`)
      if (status === "VERIFIED") status = "TIMESTAMP_ANOMALY"
    }
  }

  // --- 5. abnormal accuracy ---
  if (input.accuracyM != null && Number.isFinite(input.accuracyM)) {
    if (input.accuracyM > cfg.maxAccuracyM) {
      signals.push(`accuracy_exceeds_policy:${Math.round(input.accuracyM)}m>${cfg.maxAccuracyM}m`)
      if (status === "VERIFIED") status = "LOW_ACCURACY"
    } else if (input.accuracyM < 1) {
      // sub-meter "accuracy" is itself suspicious — real GPS is never that good
      signals.push(`suspiciously_perfect_accuracy:${input.accuracyM}m`)
      if (status === "VERIFIED") status = "SUSPICIOUS"
    }
  }

  // --- 6. device/session mismatch (§24) ---
  if (input.boundDeviceId && input.deviceId && input.boundDeviceId !== input.deviceId) {
    signals.push("device_mismatch_vs_bound_session")
    if (status === "VERIFIED") status = "DEVICE_MISMATCH"
    hard = true
  }

  // --- decision per §25 ---
  let decision: IntegrityVerdict["decision"]
  if (status === "VERIFIED") decision = "ALLOW"
  else if (hard) decision = cfg.suspiciousAction === "REJECT" ? "REJECT" : "REVIEW"
  else decision = cfg.suspiciousAction === "ALLOW" || cfg.suspiciousAction === "WARN" ? "WARN" : "REVIEW"
  if (status === "MOCK_LOCATION" && cfg.suspiciousAction === "REJECT") decision = "REJECT"
  if (status === "IMPOSSIBLE_MOVEMENT" && cfg.suspiciousAction === "REJECT") decision = "REJECT"

  return { status, signals, decision, notes: signals.join("; ") }
}

function parseClientTime(t?: string | null): number | null {
  if (!t) return null
  if (/^\d{10,14}$/.test(t)) {
    const n = Number(t)
    return Number(t) > 1e12 ? n : n * 1000
  }
  const d = new Date(t).getTime()
  return Number.isFinite(d) ? d : null
}

function haversineM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000
  const dLat = ((lat2 - lat1) * Math.PI) / 180
  const dLon = ((lon2 - lon1) * Math.PI) / 180
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(a))
}

/** Map integrity verdict → AttendanceEvent.status (§4 verification states).
 *  Honest labeling per §27: "VERIFIED" is reserved for real verification —
 *  a passing location fix is ACCEPTED, not VERIFIED identity. */
export function integrityToEventStatus(v: IntegrityVerdict): string {
  if (v.decision === "REJECT") return "REJECTED"
  if (v.decision === "REVIEW") return "REVIEW_REQUIRED"
  if (v.decision === "WARN") return "SUSPICIOUS"
  return "ACCEPTED"
}

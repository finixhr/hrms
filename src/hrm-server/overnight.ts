// ============ Overnight (cross-midnight) shift computation — ATT-005 ============
// Extracted from zkteco/processor.ts so that EVERY punch path — device push
// (rebuildDaily), manual mark, portal self check-out, geo-fence and selfie
// check-in/out — scores the same worked minutes for a shift that ends after
// midnight. Previously ONLY the device path applied this math: every other
// path called computeAttendance, whose workingMinutes = max(0, out − in −
// break) clamps to ZERO for an overnight span (22:00 in → 06:00 out), so
// night-shift employees punch a full shift and get 0 working minutes (and
// payroll pays 0) unless the punch happened to come from a biometric device.
//
// routes/attendance.ts's computeAttendance() now branches on isOvernight()
// (when BOTH in/out punches exist) and delegates here — one engine, no forks.
import { timeToMinutes } from "./utils"

/** The shift fields the overnight engine consumes (a full Shift row is
 *  structurally compatible — extra fields are simply ignored). */
export type OvernightShift = {
  startTime: string
  endTime: string
  graceMinutes: number
  breakMinutes: number
  minWorkingHours: number
  otThresholdMinutes: number
}

/** A shift is overnight when its end time is at or before its start time
 *  (22:00 → 06:00). NULL/missing shift → false (day-shift semantics). */
export function isOvernight(shift: { startTime: string; endTime: string } | null | undefined): boolean {
  if (!shift) return false
  return timeToMinutes(shift.endTime) <= timeToMinutes(shift.startTime)
}

/** Vendor policy knobs — the SAME knobs the day branch of computeAttendance
 *  applies (grace, early-leave threshold, statutory daily OT cap). Optional:
 *  device-path callers that resolve policy into the shift row keep working. */
export type OvernightPolicy = {
  graceMinutes?: number
  earlyLeaveThresholdMinutes?: number
  maxOtMinutesPerDay?: number
}

/** Overnight-aware calculation (device spec §14): the check-out belongs to the
 *  NEXT calendar day, so both out and end are normalized onto an absolute
 *  minute axis (+1440 when they fall on the "next-day" side of the shift).
 *  Verbatim extraction of the engine the ZKTeco device path has always used.
 *
 *  ATT-003 — the overnight branch used to bypass the vendor late/early-leave
 *  policies (shift-only grace, a hardcoded 15-min early-leave threshold) and
 *  the statutory 2h/day OT cap the day branch enforces; night-shift employees
 *  were held to different rules than day-shift employees for the same
 *  settings. The optional policy parameter applies the identical precedence
 *  the day branch uses: shift value ?? vendor policy ?? engine default. */
export function calcOvernight(shift: OvernightShift, checkIn: string, checkOut: string, policy: OvernightPolicy = {}) {
  const start = timeToMinutes(shift.startTime)
  const end = timeToMinutes(shift.endTime) // early morning, next day
  // ATT-003 — same precedence as the day branch: shift ?? policy ?? default
  const grace = shift.graceMinutes ?? policy.graceMinutes ?? 10
  const earlyLeaveThreshold = policy.earlyLeaveThresholdMinutes ?? 15
  const inMin = timeToMinutes(checkIn)
  const outMin = timeToMinutes(checkOut) // next-day side
  const outAbs = outMin < inMin ? outMin + 1440 : outMin
  const endAbs = end < start ? end + 1440 : end
  const lateMinutes = Math.max(0, inMin - start - grace)
  const workingMinutes = Math.max(0, outAbs - inMin - (shift.breakMinutes || 0))
  const earlyLeaveMinutes = outAbs < endAbs - earlyLeaveThreshold ? endAbs - outAbs : 0
  let overtimeMinutes = outAbs >= endAbs + (shift.otThresholdMinutes ?? 30) ? outAbs - endAbs : 0
  // ATT-003 — statutory daily OT ceiling (2h/day default where configured),
  // identical to the day branch's ATT-306 cap
  const dailyCap = Math.max(0, Number(policy.maxOtMinutesPerDay) || 0)
  if (dailyCap > 0 && overtimeMinutes > dailyCap) overtimeMinutes = dailyCap
  const halfDayMin = (shift.minWorkingHours ? shift.minWorkingHours / 2 : 4) * 60
  let status = "PRESENT"
  if (lateMinutes > 0) status = "LATE"
  if (earlyLeaveMinutes > 0 && status !== "LATE") status = "EARLY_LEAVE"
  if (workingMinutes < halfDayMin) status = "HALF_DAY"
  return { lateMinutes, earlyLeaveMinutes, workingMinutes, overtimeMinutes, status }
}

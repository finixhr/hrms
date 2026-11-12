// ============ Attendance row provenance (GAP-103 / GAP-209) ============
// §39 — a human decision wins over device punches. Which rows count as a human
// decision is answered HERE, for every machine write path (device rebuild,
// /api/v1 punches), so the paths cannot drift apart.
//
// Machine writes that must NOT be protected:
//   · the daily absent sweep (GAP-103). It used to write source "MANUAL", so a
//     device that delivered day-D punches after midnight (offline overnight,
//     outage, history backfill) had them quarantined as SKIPPED_MANUAL and the
//     employee stayed wrongly ABSENT — payroll underpaid. New sweep rows carry
//     source "SYSTEM"; rows written before the fix keep "MANUAL" and are
//     recognized by the sweep's own remark.
//
// Human writes that MUST be protected even though source stays "BIOMETRIC"
// (biometric provenance is deliberately preserved on these days — GAP-209):
//   · an approved correction;
//   · a manual re-mark of a biometric day.
// Without this a later rebuild (reprocess, late punch, history sync) silently
// overwrote the human decision with raw-device values.

export const ATTENDANCE_SOURCE_SYSTEM = "SYSTEM"
export const SWEEP_ABSENT_REMARK = "Auto-marked absent by the daily sweep — no attendance record (ATT-303)"
export const CORRECTION_REMARK_PREFIX = "Approved correction:"
export const BIOMETRIC_PRESERVED_REMARK_SUFFIX = "(biometric record preserved)"

type AttendanceRowLike = { source?: string | null; status?: string | null; remarks?: string | null }

/** A row the absent sweep materialized — replaced freely by device truth. */
export function isSweepAbsentRow(row: AttendanceRowLike): boolean {
  if (row.status !== "ABSENT") return false
  if (row.source === ATTENDANCE_SOURCE_SYSTEM) return true
  return row.source === "MANUAL" && (row.remarks || "").startsWith("Auto-marked absent by the daily sweep")
}

/** §39 — true when a human decided this day and machine writes must not replace it. */
export function isHumanProtectedRow(row: AttendanceRowLike): boolean {
  if (isSweepAbsentRow(row)) return false
  if (row.source === "MANUAL") return true
  const remarks = row.remarks || ""
  return remarks.startsWith(CORRECTION_REMARK_PREFIX) || remarks.endsWith(BIOMETRIC_PRESERVED_REMARK_SUFFIX)
}

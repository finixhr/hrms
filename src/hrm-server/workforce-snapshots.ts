// ============ Phase 3 — monthly workforce snapshots (FIN-077 structural fix) ============
// Reconstructed history was the root cause behind FIN-077: live tables only
// ever answer "now", so every historical workforce KPI (attrition, turnover,
// headcount trend) was re-derived from current rows and silently drifted with
// every edit. The WorkforceSnapshot series gives the analytics stack an
// append-only monthly baseline instead:
//
//   · the daily platform pass (jobs.ts platformDailyJobs) keeps the CURRENT
//     month fresh in ONE set-based upsert across all vendors — the last write
//     of a month is that month's frozen end-of-month record (the exact
//     UsageSnapshot discipline);
//   · the twelve-month backfill (analytics.snapshots.backfill) reconstructs
//     the earlier months from joining dates + recorded exit dates, with the
//     HONEST CAVEAT the roadmap demanded: rows deleted before the backfill
//     are invisible to it, so the earliest months carry the same caveats
//     until live snapshots accumulate.
//
// Reconstruction semantics (per month M, asOf = min(monthEnd, today)):
//   headcountTotal@M  = Employee rows with joiningDate ≤ asOf and no recorded
//                       exit ≤ asOf (a NULL joiningDate counts only in the
//                       live month — it cannot be placed in history);
//   headcountActive@M = the same rows whose CURRENT status is working-state,
//                       plus rows already exited SINCE asOf (they were still
//                       working at M's end);
//   newJoiners@M      = joiningDate within the calendar month (counted over
//                       the full month even for same-month join-and-exit);
//   exits@M           = earliest recorded exit date per employee —
//                       non-cancelled Resignation LWD ∪ EmployeeHistory EXIT
//                       events — falling within the month;
//   avgTenureMonths@M = mean days-since-joining ÷ 30 over the working set.
import { db } from "@/lib/db"

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"]

export function monthStartOf(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, "0")}-01`
}

export function monthEndOf(year: number, month: number): string {
  return new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10)
}

/**
 * Upsert the snapshot rows for ONE calendar month, set-based across vendors
 * (or restricted to one vendor when `vendorId` is given). Idempotent:
 * re-running a closed month rewrites identical values; the live month keeps
 * refreshing until it closes.
 */
export async function captureWorkforceSnapshotMonth(opts: {
  year: number
  month: number
  asOf: string
  today?: string
  vendorId?: string
}): Promise<number> {
  const { year, month, asOf } = opts
  if (!year || !month || month < 1 || month > 12) return 0
  const monthStart = monthStartOf(year, month)
  const monthEnd = monthEndOf(year, month)
  const todayStr = opts.today ?? new Date().toISOString().slice(0, 10)
  const vendorFilter = opts.vendorId ?? null
  await db.$executeRaw`
    INSERT INTO "WorkforceSnapshot"
      ("id", "vendorId", "periodYear", "periodMonth",
       "headcountTotal", "headcountActive", "newJoiners", "exits", "avgTenureMonths",
       "capturedAt", "updatedAt")
    SELECT
      md5(random()::text || clock_timestamp()::text || v."id"),
      v."id", ${year}, ${month},
      COALESCE(hc.total, 0),
      COALESCE(hc.active, 0),
      COALESCE(nj.cnt, 0),
      COALESCE(ex.cnt, 0),
      COALESCE(tn.tenure, 0),
      (now() AT TIME ZONE 'UTC'), (now() AT TIME ZONE 'UTC')
    FROM "Vendor" v
    LEFT JOIN (
      -- headcount + active headcount AT asOf (joined by then, not exited by then).
      -- The exit map is the EARLIEST recorded exit per employee (non-cancelled
      -- Resignation LWD UNION EmployeeHistory EXIT events — an exit writes
      -- both; the earliest date wins, so the union is idempotent).
      SELECT e."vendorId", COUNT(*) AS total,
             COUNT(*) FILTER (
               WHERE e."status" IN ('ACTIVE', 'PROBATION', 'ON_LEAVE')
                  OR (exm."exitDate" IS NOT NULL AND exm."exitDate" > ${asOf})
             ) AS active
      FROM "Employee" e
      LEFT JOIN (
        SELECT "employeeId", MIN(d) AS "exitDate" FROM (
          SELECT "employeeId", COALESCE("actualLwd", "proposedLwd") AS d
          FROM "Resignation"
          WHERE "status" NOT IN ('WITHDRAWN', 'REJECTED', 'CANCELLED')
            AND COALESCE("actualLwd", "proposedLwd") IS NOT NULL
          UNION ALL
          SELECT "employeeId", "effectiveDate" AS d
          FROM "EmployeeHistory"
          WHERE "eventType" = 'EXIT' AND "effectiveDate" IS NOT NULL
          UNION ALL
          -- a company transfer ends this row, but it is not attrition: the exits
          -- count below deliberately leaves it out
          SELECT "id" AS "employeeId", "transferredOutDate" AS d
          FROM "Employee"
          WHERE "transferredOutDate" IS NOT NULL
        ) u
        GROUP BY "employeeId"
      ) exm ON exm."employeeId" = e."id"
      WHERE (e."joiningDate" IS NULL AND ${asOf} >= ${todayStr})
         OR (e."joiningDate" IS NOT NULL AND e."joiningDate" <= ${asOf}
             AND (exm."exitDate" IS NULL OR exm."exitDate" > ${asOf}))
      GROUP BY e."vendorId"
    ) hc ON hc."vendorId" = v."id"
    LEFT JOIN (
      -- joiners within the calendar month (full-month bound: joiningDate can
      -- never be in the future, so the live month is bounded by today anyway)
      SELECT "vendorId", COUNT(*) AS cnt FROM "Employee"
      WHERE "joiningDate" >= ${monthStart} AND "joiningDate" <= ${monthEnd}
      GROUP BY "vendorId"
    ) nj ON nj."vendorId" = v."id"
    LEFT JOIN (
      -- exits within the calendar month (earliest recorded exit per employee;
      -- vendorId comes from the source rows so deleted employees still count)
      SELECT g."vendorId", COUNT(*) AS cnt FROM (
        SELECT x."vendorId", x."employeeId", MIN(x.d) AS d FROM (
          SELECT r."vendorId", r."employeeId", COALESCE(r."actualLwd", r."proposedLwd") AS d
          FROM "Resignation" r
          WHERE r."status" NOT IN ('WITHDRAWN', 'REJECTED', 'CANCELLED')
            AND COALESCE(r."actualLwd", r."proposedLwd") IS NOT NULL
          UNION ALL
          SELECT h."vendorId", h."employeeId", h."effectiveDate" AS d
          FROM "EmployeeHistory" h
          WHERE h."eventType" = 'EXIT' AND h."effectiveDate" IS NOT NULL
        ) x
        GROUP BY x."vendorId", x."employeeId"
      ) g
      WHERE g.d >= ${monthStart} AND g.d <= ${monthEnd}
      GROUP BY g."vendorId"
    ) ex ON ex."vendorId" = v."id"
    LEFT JOIN (
      -- mean tenure (months) over the currently-working set, joined by asOf
      SELECT e."vendorId", ROUND(AVG((${asOf}::date - e."joiningDate"::date)) / 30.0, 1) AS tenure
      FROM "Employee" e
      WHERE e."status" IN ('ACTIVE', 'PROBATION', 'ON_LEAVE')
        AND e."joiningDate" IS NOT NULL AND e."joiningDate" <= ${asOf}
      GROUP BY e."vendorId"
    ) tn ON tn."vendorId" = v."id"
    WHERE (${vendorFilter}::text IS NULL OR v."id" = ${vendorFilter}::text)
    ON CONFLICT ("vendorId", "periodYear", "periodMonth") DO UPDATE SET
      "headcountTotal" = EXCLUDED."headcountTotal",
      "headcountActive" = EXCLUDED."headcountActive",
      "newJoiners" = EXCLUDED."newJoiners",
      "exits" = EXCLUDED."exits",
      "avgTenureMonths" = EXCLUDED."avgTenureMonths",
      "updatedAt" = (now() AT TIME ZONE 'UTC')`
  return db.workforceSnapshot.count({ where: { periodYear: year, periodMonth: month, ...(opts.vendorId ? { vendorId: opts.vendorId } : {}) } })
}

/** The daily platform pass: refresh the CURRENT month for every vendor (one
 *  set-based statement; closed months are never touched again). */
export async function captureWorkforceSnapshots(date: string): Promise<number> {
  const year = Number(date.slice(0, 4))
  const month = Number(date.slice(5, 7))
  if (!year || !month) return 0
  return captureWorkforceSnapshotMonth({ year, month, asOf: date, today: date })
}

/** Twelve-month backfill (or `months` back, 1..24): reconstructs the closed
 *  months before the current one, per vendor. Returns the months written. */
export async function backfillWorkforceSnapshots(vendorId: string, months = 12, today?: string): Promise<{ wrote: number; from: string; to: string }> {
  const bounded = Math.max(1, Math.min(24, Math.round(months)))
  const todayStr = today ?? new Date().toISOString().slice(0, 10)
  const curYear = Number(todayStr.slice(0, 4))
  const curMonth = Number(todayStr.slice(5, 7))
  let wrote = 0
  let first = ""
  let last = ""
  for (let back = bounded; back >= 1; back--) {
    // walk back `back` months from the CURRENT month (exclusive — the live
    // month belongs to the daily pass, not the backfill)
    let year = curYear
    let month = curMonth - back
    while (month <= 0) { month += 12; year -= 1 }
    const monthEnd = monthEndOf(year, month)
    await captureWorkforceSnapshotMonth({ year, month, asOf: monthEnd, today: todayStr, vendorId })
    wrote++
    const key = `${year}-${String(month).padStart(2, "0")}`
    if (!first || key < first) first = key
    if (!last || key > last) last = key
  }
  return { wrote, from: first, to: last }
}

/** The snapshot series for a vendor (oldest → newest), for the workforce
 *  dashboard and the trend KPIs. Pure read. */
export async function workforceSnapshotSeries(vendorId: string, months = 13): Promise<{
  periodYear: number
  periodMonth: number
  label: string
  headcountTotal: number
  headcountActive: number
  newJoiners: number
  exits: number
  avgTenureMonths: number
}[]> {
  const rows = await db.workforceSnapshot.findMany({
    where: { vendorId },
    orderBy: [{ periodYear: "asc" }, { periodMonth: "asc" }],
    take: Math.max(1, Math.min(60, months)),
  })
  return rows.map((r) => ({
    periodYear: r.periodYear,
    periodMonth: r.periodMonth,
    label: `${MONTHS[r.periodMonth - 1]} ${r.periodYear}`,
    headcountTotal: r.headcountTotal,
    headcountActive: r.headcountActive,
    newJoiners: r.newJoiners,
    exits: r.exits,
    avgTenureMonths: r.avgTenureMonths,
  }))
}

export { MONTHS as SNAPSHOT_MONTHS }

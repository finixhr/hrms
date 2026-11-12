// ============ FIN-028 (Phase 3) — period-close × posting mutual exclusion =====
// The audit: "Accounting period close (periods.close) has no cross-module
// lock against concurrent business writes" — period close runs in one
// transaction while payroll runs / expense postings / procurement + asset
// hooks / manual vouchers run in separate transactions with no mutual
// exclusion: an in-flight posting that passed its period checks can COMMIT
// AFTER the close flips the period to CLOSED (the write lands in a closed
// period), and the closer can never see the in-flight write at all.
//
// The fix is a TRANSACTION-SCOPED POSTGRES ADVISORY LOCK shared by both
// sides, keyed per (vendor, date):
//
//   · every posting (postJournal — all auto journals — and every manual
//     voucher write) takes pg_advisory_xact_lock("fin28:post:<vendor>:<date>")
//     INSIDE its transaction, then re-checks the closed-period state INSIDE
//     the lock. The lock lives until the transaction commits/rolls back, so
//     the posting and the close are strictly ordered: whichever gets the key
//     first finishes first; the loser waits, re-reads, and only proceeds if
//     the period is still OPEN;
//   · periods.close/reopen takes the SAME key for EVERY date in the period's
//     range (ascending order — every locker uses the same global order, so
//     overlapping periods can never deadlock), re-reads the period status
//     inside the locks, and flips it. A close therefore waits for every
//     in-flight posting whose date it covers, and every posting that starts
//     after the close is refused on the re-check (the FIN-028 exit criterion:
//     no writes into closed periods under concurrent stress).
//
// Scope note (supersedes the Wave-4 "auto journals skip this gate" comment):
// closed means closed — a system posting dated into a CLOSED period is now
// refused with the same reopen-or-redate instruction as a manual voucher.
// Writers dated into OTHER periods proceed concurrently (per-date keys), so
// the lock never becomes a tenant-wide chokepoint.
import { db } from "@/lib/db"
import { Deny } from "./rbac"

/** The advisory key for one (vendor, date) posting lane. */
export function postingLockKey(vendorId: string, date: string): string {
  return `fin28:post:${vendorId}:${date}`
}

type Client = typeof db | any

/** Take the xact-scoped advisory lock for one posting lane. Blocks while
 *  another transaction holds the same (vendor, date) key — by construction
 *  only the close/reopen range-holder or a prior posting of the same date. */
export async function acquirePostingLock(client: Client, vendorId: string, date: string): Promise<void> {
  // ::text — pg_advisory_xact_lock returns void, which Prisma cannot
  // deserialize; casting the (empty) void to text gives the driver a normal
  // text column (verified against PostgreSQL 17: returns '' and the lock is
  // held for the rest of the transaction).
  await client.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${postingLockKey(vendorId, date)}))::text`
}

/** The closed-period assertion, parameterized on the transaction client so
 *  it runs INSIDE the lock (FIN-028). Same shape as the Wave-4 helper in
 *  routes/accounting.ts: any CLOSED period covering the date for this
 *  company (or a legacy NULL-company period) refuses the write. */
export async function assertPeriodOpenOn(client: Client, vendorId: string, date: string, companyId?: string | null): Promise<void> {
  const closed = await client.accountingPeriod.findFirst({
    where: { vendorId, status: "CLOSED", startDate: { lte: date }, endDate: { gte: date }, ...(companyId ? { OR: [{ companyId }, { companyId: null }] } : {}) },
    select: { name: true },
  })
  if (closed) {
    throw new Deny(`Date ${date} falls in closed period ${closed.name} (FIN-028). Reopen the period or use a different date.`, 409)
  }
}

/** Run a posting under the FIN-028 guard:
 *   1. acquire the (vendor, date) advisory lock — inside the caller's
 *      transaction when `tx` is given (the lock then holds until the CALLER
 *      commits — the whole payroll/procurement/asset business write is
 *      covered), otherwise inside a dedicated db.$transaction;
 *   2. re-check the closed-period state INSIDE the lock;
 *   3. run fn under that client.
 *  checkOpen=false is available for call sites that deliberately write into
 *  closed periods (none today — the reversal path passes its own date). */
export async function withPostingGuard<T>(
  vendorId: string,
  date: string,
  opts: { checkOpen?: boolean; companyId?: string | null; tx?: Client },
  fn: (client: Client) => Promise<T>,
): Promise<T> {
  const run = async (client: Client): Promise<T> => {
    await acquirePostingLock(client, vendorId, date)
    if (opts.checkOpen !== false) await assertPeriodOpenOn(client, vendorId, date, opts.companyId ?? null)
    return fn(client)
  }
  if (opts.tx) return run(opts.tx)
  return db.$transaction((t) => run(t)) as Promise<T>
}

/** Take the advisory locks for EVERY date in [startDate, endDate], ascending
 *  (the global order that makes overlapping closes deadlock-free). Used by
 *  periods.close and periods.reopen inside their transaction, BEFORE the
 *  status re-read + flip — the close therefore waits out every in-flight
 *  posting covered by its range. */
export async function acquireRangeLocks(client: Client, vendorId: string, startDate: string, endDate: string): Promise<void> {
  const dates: string[] = []
  const start = new Date(`${startDate}T00:00:00Z`)
  const end = new Date(`${endDate}T00:00:00Z`)
  for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    dates.push(d.toISOString().slice(0, 10))
  }
  for (const date of dates) {
    await acquirePostingLock(client, vendorId, date)
  }
}

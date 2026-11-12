// ============ Platform sequence numbers (application IDs, invoice numbers) ============
// Reuses the existing SequenceCounter table with a reserved "__SAAS__" scope —
// no new table needed, and the row is invisible to tenant code (tenants always
// key counters as "<vendorId>:<thing>"; "__SAAS__" can never collide because
// it is not a cuid vendor id).
import { db } from "@/lib/db"

const PLATFORM_SCOPE = "__SAAS__"

/** Atomically increments and returns the next value for a platform counter.
 *  upsert on the primary key: first call inserts value 1, later calls
 *  increment; the unique key makes concurrent calls serialize on the row. */
export async function nextPlatformSequence(key: string): Promise<number> {
  const rowKey = `${PLATFORM_SCOPE}:${key}`
  const row = await db.sequenceCounter.upsert({
    where: { key: rowKey },
    create: { key: rowKey, value: 1 },
    update: { value: { increment: 1 } },
  })
  return row.value
}

/** HRM-2026-000123 — the application number every applicant receives. */
export async function nextApplicationNumber(): Promise<string> {
  const year = new Date().getFullYear()
  const n = await nextPlatformSequence(`registration:${year}`)
  return `HRM-${year}-${String(n).padStart(6, "0")}`
}

/** INV-2026-000123 */
export async function nextInvoiceNumber(): Promise<string> {
  const year = new Date().getFullYear()
  const n = await nextPlatformSequence(`invoice:${year}`)
  return `INV-${year}-${String(n).padStart(6, "0")}`
}

/** TKT-2026-000123 — Support Center ticket number (2026-10-25). */
export async function nextTicketNumber(): Promise<string> {
  const year = new Date().getFullYear()
  const n = await nextPlatformSequence(`ticket:${year}`)
  return `TKT-${year}-${String(n).padStart(6, "0")}`
}

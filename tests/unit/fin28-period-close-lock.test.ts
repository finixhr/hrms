/// <reference types="bun-types" />
// ============ FIN-028 (Phase 3) — period close × posting mutual exclusion ====
// The audit: periods.close had no cross-module lock against concurrent
// business writes — an in-flight posting could commit after the close (the
// write lands in a CLOSED period) and the closer never saw it. These tests
// drive the real primitives (pg advisory xact locks on real PostgreSQL via
// the isolated test database):
//
//   T1  an in-flight posting HOLDS the (vendor, date) lane: a concurrent
//       close of a covering range BLOCKS (waits the posting out) — then
//       completes after the posting commits;
//   T2  a posting that starts AFTER the close is refused on the in-lock
//       re-check (409, "falls in closed period");
//   T3  concurrent stress — 10 postings racing 1 close on the same date:
//       every journal row that committed has createdAt ≤ closedAt (nothing
//       lands in the closed period); every refusal is the 409 Deny.
import "./_testdb"
import { describe, test, expect, beforeAll } from "bun:test"
import { db } from "@/lib/db"
import { mkVendor } from "./_fixtures"
import {
  withPostingGuard,
  acquirePostingLock,
  acquireRangeLocks,
} from "@/hrm-server/period-close-lock"
import { postJournal } from "@/hrm-server/accounting"

const D = "2026-11-05" // the contested date
let vendor: any, companyId: string

beforeAll(async () => {
  vendor = await mkVendor("FIN-028 Vendor", { company: false })
  const c = await db.company.create({ data: { vendorId: vendor.id, code: "F28", name: "Fin28 Co", isDefault: true, active: true } })
  companyId = c.id
})

async function mkPeriod(name: string, startDate: string, endDate: string) {
  return await db.accountingPeriod.create({
    data: { vendorId: vendor.id, companyId, name, startDate, endDate, status: "OPEN" },
  })
}

/** The route's close body, built from the same primitives the route uses. */
async function closePeriod(periodId: string) {
  return await db.$transaction(async (tx) => {
    const period = await tx.accountingPeriod.findUniqueOrThrow({ where: { id: periodId } })
    await acquireRangeLocks(tx, vendor.id, period.startDate, period.endDate)
    const fresh = await tx.accountingPeriod.findUniqueOrThrow({ where: { id: periodId } })
    if (fresh.status !== "OPEN") throw new Error("closed concurrently")
    return await tx.accountingPeriod.update({
      where: { id: periodId },
      data: { status: "CLOSED", closedAt: new Date() },
    })
  })
}

const lines = [
  { account: "1010", accountName: "Cash", debit: 100 },
  { account: "4010", accountName: "Revenue", credit: 100 },
]

describe("FIN-028 period close × posting mutual exclusion", () => {
  test("T1: an in-flight posting blocks the close, then the close completes", async () => {
    const period = await mkPeriod("F28-T1", D, D)
    let releasePosting!: () => void
    const gate = new Promise<void>((res) => { releasePosting = res })

    // the posting: acquires the lane, creates the journal, then holds the tx
    // open (uncommitted) until the test releases it
    const posting = db.$transaction(async (tx) => {
      await acquirePostingLock(tx, vendor.id, D)
      await tx.accountJournal.create({
        data: {
          vendorId: vendor.id, companyId, refType: "TEST_POST", refId: null, idempotencyKey: null,
          date: D, memo: "T1 in-flight posting", linesJson: "[]", amount: 100, source: "HRM",
        },
      })
      await gate // hold the transaction open — the close must now wait
      return "committed"
    })

    // the close: must BLOCK on the advisory lock while the posting holds it
    let settled = false
    const closing = closePeriod(period.id).then((r) => { settled = true; return r })
    await new Promise((r) => setTimeout(r, 400))
    expect(settled).toBe(false) // still waiting on the posting lane — mutual exclusion holds
    expect(await db.accountJournal.count({ where: { vendorId: vendor.id, date: D, refType: "TEST_POST" } })).toBe(0) // nothing committed yet

    releasePosting()
    expect(await posting).toBe("committed")
    const closed = await closing
    expect(closed.status).toBe("CLOSED")
    // the posting landed while the period was still OPEN (createdAt ≤ closedAt)
    const row = await db.accountJournal.findFirstOrThrow({ where: { vendorId: vendor.id, date: D, refType: "TEST_POST" } })
    expect(row.createdAt.getTime()).toBeLessThanOrEqual(closed.closedAt!.getTime())
    // and the close was real: T2's guard must now refuse the same date
  }, 20_000)

  test("T2: a posting that starts after the close is refused (409)", async () => {
    await expect(
      withPostingGuard(vendor.id, D, { companyId }, async () => { throw new Error("must not run") }),
    ).rejects.toThrow(/falls in closed period/)
    // …and so does the production funnel (postJournal, closed means closed):
    await expect(
      postJournal({ vendorId: vendor.id, userId: null, userName: "t", activeCompanyId: companyId }, "TEST_POST", null, D, "T2 memo", lines, 100, { companyId }),
    ).rejects.toThrow(/falls in closed period/)
  }, 20_000)

  test("T3: concurrent stress — 10 postings racing 1 close: nothing lands in the closed period", async () => {
    const D3 = "2026-12-01"
    const period = await mkPeriod("F28-T3", D3, D3)
    const results = await Promise.allSettled([
      closePeriod(period.id),
      ...Array.from({ length: 10 }, (_, i) =>
        postJournal(
          { vendorId: vendor.id, userId: null, userName: "stress", activeCompanyId: companyId },
          "STRESS_POST", null, D3, `stress posting ${i}`, lines, 100, { companyId },
        ),
      ),
    ])
    const closed = await db.accountingPeriod.findUniqueOrThrow({ where: { id: period.id } })
    expect(closed.status).toBe("CLOSED")
    // invariant 1 — every committed journal row for D3 predates the close:
    const rows = await db.accountJournal.findMany({ where: { vendorId: vendor.id, date: D3, refType: "STRESS_POST" } })
    for (const r of rows) {
      expect(r.createdAt.getTime()).toBeLessThanOrEqual(closed.closedAt!.getTime())
    }
    // invariant 2 — every rejected attempt is the closed-period refusal:
    for (const res of results.slice(1)) {
      if (res.status === "rejected") {
        expect(String(res.reason)).toMatch(/falls in closed period/)
      } else {
        expect(res.status).toBe("fulfilled")
      }
    }
    // invariant 3 — no row for D3 was created after the close committed:
    const late = rows.filter((r) => r.createdAt.getTime() > closed.closedAt!.getTime())
    expect(late).toHaveLength(0)
    // and the funnel's idempotent re-read never double-posted:
    expect(rows.length).toBeLessThanOrEqual(10)
  }, 60_000)

  test("T4: postings to OTHER dates are not blocked by an unrelated close", async () => {
    const DX = "2027-01-15" // outside any closed period
    const id = await postJournal(
      { vendorId: vendor.id, userId: null, userName: "t4", activeCompanyId: companyId },
      "TEST_POST", null, DX, "T4 memo", lines, 100, { companyId },
    )
    expect(id).toBeTruthy()
  }, 20_000)
})

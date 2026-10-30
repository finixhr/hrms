/// <reference types="bun-types" />
// ============ Phase 3 WS-B — distributed coordination (SCL-21) ================
// The lock API is exercised against the ALWAYS-AVAILABLE Postgres backend
// (CoordinationLock rows): acquire/exclude/release, expiry takeover, the
// single-flight wrapper, once-per-period claims, and the CLUSTER-WIDE tick
// lock that makes a load-balanced pair of instances run exactly one tick.
// Redis paths share the same API and are covered by the same semantics with
// the Postgres backend standing in (no Redis in the test environment — the
// graceful-degradation contract itself is what keeps tests honest).
import "./_testdb"
import { describe, test, expect } from "bun:test"
import { db } from "@/lib/db"
import { uniq } from "./_fixtures"
import {
  tryAcquireLock, releaseLock, withDistributedLock, claimPeriodAction,
} from "@/hrm-server/coordination"

describe("SCL-21 — distributed locks (Postgres backend)", () => {
  test("exclusive acquire → second holder refused → release → re-acquire", async () => {
    const key = `p3-test:lock:${uniq()}`
    const h1 = await tryAcquireLock(key, 60_000)
    expect(h1).not.toBeNull()
    const h2 = await tryAcquireLock(key, 60_000)
    expect(h2).toBeNull() // held elsewhere
    await releaseLock(h1)
    const h3 = await tryAcquireLock(key, 60_000)
    expect(h3).not.toBeNull() // freed
    await releaseLock(h3)
  })

  test("an expired holder is taken over (crash recovery is TTL-bounded)", async () => {
    const key = `p3-test:expiry:${uniq()}`
    const h1 = await tryAcquireLock(key, 150) // sub-second TTL (floor is 100ms)
    expect(h1).not.toBeNull()
    await new Promise((r) => setTimeout(r, 250))
    const h2 = await tryAcquireLock(key, 60_000)
    expect(h2).not.toBeNull() // the stale claim expired
    await releaseLock(h2)
  })

  test("release by a NON-holder is a no-op (the live holder keeps the lock)", async () => {
    const key = `p3-test:stranger:${uniq()}`
    const h1 = await tryAcquireLock(key, 60_000)
    expect(h1).not.toBeNull()
    await releaseLock({ key, holder: "someone-else", backend: "postgres" })
    const h2 = await tryAcquireLock(key, 60_000)
    expect(h2).toBeNull() // still held by h1
    await releaseLock(h1)
  })

  test("withDistributedLock runs the body once and reports contention as null", async () => {
    const key = `p3-test:wrap:${uniq()}`
    const out1 = await withDistributedLock(key, 60_000, async () => "first")
    expect(out1).toBe("first")
    // simulate another instance holding it
    const held = await tryAcquireLock(key, 60_000)
    expect(held).not.toBeNull()
    const out2 = await withDistributedLock(key, 60_000, async () => "second")
    expect(out2).toBeNull() // not acquired → caller treats as someone else's job
    await releaseLock(held)
    // and the lock is FREE again after the wrapper (it released in finally)
    const out3 = await withDistributedLock(key, 60_000, async () => "third")
    expect(out3).toBe("third")
  })

  test("the body throwing still releases the lock (no stranded claims)", async () => {
    const key = `p3-test:throw:${uniq()}`
    await expect(
      withDistributedLock(key, 60_000, async () => { throw new Error("boom") }),
    ).rejects.toThrow("boom")
    const again = await tryAcquireLock(key, 60_000)
    expect(again).not.toBeNull()
    await releaseLock(again)
  })
})

describe("SCL-21 — once-per-period claims", () => {
  test("the first claimant wins; a second instance the same period loses; the next period is fresh", async () => {
    const name = `p3-test:period:${uniq()}`
    const period1End = Date.now() + 3600_000
    expect(await claimPeriodAction(name, period1End)).toBe(true)
    expect(await claimPeriodAction(name, period1End)).toBe(false) // the double-submit guard
    expect(await claimPeriodAction(name, period1End)).toBe(false)
    // a NEW PERIOD (the next Dhaka day rides IN the name, like the production
    // backup-scheduled:<date> key) is a fresh claim
    expect(await claimPeriodAction(`${name}:next-day`, Date.now() + 7200_000)).toBe(true)
  })
})

describe("SCL-21 — the scheduler tick lock deduplicates cluster-wide", () => {
  test("runTick refuses to run while another instance holds scheduler:tick", async () => { // eslint-disable-line -- long: the free-lock leg runs a REAL tick over the shared fixture DB

    // disable the in-app backup schedule for this tick (the tick now drives
    // maybeRunScheduledBackup; the test DB has no pg_dump and no gateway)
    const { saveBackupSettings } = await import("@/hrm-server/saas/backup")
    await saveBackupSettings({ enabled: false })

    const { runTick } = await import("@/hrm-server/jobs")
    const held = await tryAcquireLock("scheduler:tick", 30_000)
    expect(held).not.toBeNull()

    const out: any = await runTick()
    expect(out.skipped).toBe(true)
    expect(String(out.reason)).toContain("tick lock") // ← the multi-instance fix

    await releaseLock(held)
    // with the lock free, the tick RUNS (and releases it in its finally)
    const ran: any = await runTick()
    expect(ran.skipped).toBeUndefined()
    expect(ran.date).toBeTruthy()
    // …and the lock is free afterwards for the "next instance"
    const reHeld = await tryAcquireLock("scheduler:tick", 5_000)
    expect(reHeld).not.toBeNull()
    await releaseLock(reHeld)
  }, 120_000)

  test("CoordinationLock rows exist for issued locks and expire cleanly", async () => {
    const key = `p3-test:rows:${uniq()}`
    const h = await tryAcquireLock(key, 60_000)
    expect(h).not.toBeNull()
    const row = await db.coordinationLock.findUnique({ where: { key: "lock:" + key } })
    expect(row?.holder).toBe(h!.holder)
    expect(row!.expiresAt.getTime()).toBeGreaterThan(Date.now())
    await releaseLock(h)
    const freed = await db.coordinationLock.findUnique({ where: { key: "lock:" + key } })
    expect(freed!.expiresAt.getTime()).toBeLessThanOrEqual(0) // released = epoch
  })
})

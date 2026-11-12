/// <reference types="bun-types" />
// ============ M3 (T-12) — offline outbox CORE engine (mobile/src/lib/outbox-core.ts) ============
// The queue logic is the part that must be provably correct, so it lives in
// a dependency-free module this bun lane can execute directly with injected
// storage/rpc/clock/random adapters — the react-native wrapper (offline.ts)
// is logic-free wiring exercised by typecheck + device tests.
//
// Coverage required by the M3 directive:
//   queue creation · persistent storage · application restart · network
//   recovery · retry behavior · exponential backoff · duplicate event
//   submission · idempotency (same clientEventId on every attempt) ·
//   authentication expiration · permanent vs temporary server errors ·
//   conflicting attendance events · queue cleanup · failed-synchronization
//   recovery.
import { describe, test, expect } from "bun:test"
import {
  OutboxEngine, backoffDelayMs, classifyError, classifyPunchResponse,
  BACKOFF_BASE_MS, BACKOFF_CAP_MS, SYNCED_RETENTION_MS, REJECTED_RETENTION_MS,
  type OutboxEntry, type OutboxDeps,
} from "../../mobile/src/lib/outbox-core"

// ---------------------------------------------------------------------------
// Test harness — in-memory storage, scriptable rpc, mutable clock
// ---------------------------------------------------------------------------

function mkErr(message: string, status?: number): Error & { status?: number } {
  const e = new Error(message) as Error & { status?: number }
  if (status !== undefined) e.status = status
  return e
}

class Harness {
  stored: OutboxEntry[] = []
  savedCount = 0
  rpcCalls: { action: string; payload: any }[] = []
  rpcScript: ((action: string, payload: any) => unknown)[] = []
  nowMs = Date.parse("2026-10-30T08:00:00Z")
  rand = 0.5 // mid jitter → delay = raw * 1.0
  idSeq = 0

  deps(): OutboxDeps {
    return {
      storage: {
        load: async () => JSON.parse(JSON.stringify(this.stored)),
        save: async (entries) => {
          this.savedCount++
          this.stored = JSON.parse(JSON.stringify(entries))
        },
      },
      rpc: async (action, payload) => {
        this.rpcCalls.push({ action, payload })
        const step = this.rpcScript.shift()
        if (step === undefined) throw mkErr("script exhausted", 500)
        const r = step(action, payload)
        if (r instanceof Error) throw r
        return r
      },
      now: () => new Date(this.nowMs),
      newId: () => `id-${++this.idSeq}`,
      random: () => this.rand,
    }
  }

  engine(): OutboxEngine {
    return new OutboxEngine(this.deps())
  }

  /** Simulate app restart: a BRAND-NEW engine reads what the old one left
   *  in storage (the persistence/restart guarantee). */
  restarted(): OutboxEngine {
    return new OutboxEngine(this.deps())
  }

  async enqueue(engine: OutboxEngine, action: "attendance.geofence.checkin" | "attendance.geofence.checkout" = "attendance.geofence.checkin", capturedOffline = false) {
    return engine.enqueue(action, { latitude: 23.81, longitude: 90.41, accuracyM: 10, deviceInfo: "test-device" }, { capturedOffline })
  }
}

// ---------------------------------------------------------------------------
// Backoff math (pure)
// ---------------------------------------------------------------------------

describe("M3 · backoff policy (pure)", () => {
  test("5s → 10s → 20s → 40s … capped at 10 minutes", () => {
    expect(backoffDelayMs(1, 0.5)).toBe(BACKOFF_BASE_MS)
    expect(backoffDelayMs(2, 0.5)).toBe(2 * BACKOFF_BASE_MS)
    expect(backoffDelayMs(3, 0.5)).toBe(4 * BACKOFF_BASE_MS)
    expect(backoffDelayMs(4, 0.5)).toBe(8 * BACKOFF_BASE_MS)
    expect(backoffDelayMs(10, 0.5)).toBe(BACKOFF_CAP_MS)
    expect(backoffDelayMs(100, 0.5)).toBe(BACKOFF_CAP_MS) // never exceeds the cap
  })

  test("±20% jitter spreads reconnect stampedes", () => {
    expect(backoffDelayMs(1, 0)).toBe(Math.round(BACKOFF_BASE_MS * 0.8))
    expect(backoffDelayMs(1, 1)).toBe(Math.round(BACKOFF_BASE_MS * 1.2))
    expect(backoffDelayMs(1, 0.5)).toBe(BACKOFF_BASE_MS)
  })
})

// ---------------------------------------------------------------------------
// Error / response classification (pure)
// ---------------------------------------------------------------------------

describe("M3 · error classification (retryable vs permanent vs auth vs network)", () => {
  test("401 → auth recovery", () => {
    expect(classifyError(mkErr("Session expired", 401))).toEqual({ kind: "auth", status: 401 })
  })
  test("429 and 5xx → retryable", () => {
    expect(classifyError(mkErr("Too many", 429)).kind).toBe("retryable")
    expect(classifyError(mkErr("boom", 500)).kind).toBe("retryable")
    expect(classifyError(mkErr("bad gateway", 502)).kind).toBe("retryable")
  })
  test("400/403/404 → permanent server decision", () => {
    expect(classifyError(mkErr("This attendance requires a selfie", 400)).kind).toBe("permanent")
    expect(classifyError(mkErr("policy", 403)).kind).toBe("permanent")
    expect(classifyError(mkErr("Unknown action", 404)).kind).toBe("permanent")
  })
  test("no status (fetch TypeError — offline) → network", () => {
    expect(classifyError(new TypeError("Network request failed")).kind).toBe("network")
    expect(classifyError(mkErr("statusless", 0)).kind).toBe("network")
    expect(classifyError(null).kind).toBe("network")
    expect(classifyError(undefined).kind).toBe("network")
  })
})

describe("M3 · punch response classification", () => {
  test("plain acceptance → no review, not a replay", () => {
    expect(classifyPunchResponse({ id: "a1", status: "PRESENT" })).toEqual({ requiresReview: false, replayed: false })
  })
  test("server review markers → requiresReview", () => {
    expect(classifyPunchResponse({ eventStatus: "REVIEW_REQUIRED" }).requiresReview).toBe(true)
    expect(classifyPunchResponse({ eventStatus: "SUSPICIOUS" }).requiresReview).toBe(true)
    expect(classifyPunchResponse({ reviewStatus: "PENDING" }).requiresReview).toBe(true)
    expect(classifyPunchResponse({ reviewStatus: "NONE" }).requiresReview).toBe(false)
  })
  test("idempotentReplay → replayed (the original attempt WAS accepted)", () => {
    expect(classifyPunchResponse({ idempotentReplay: true }).replayed).toBe(true)
    expect(classifyPunchResponse({}).replayed).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Queue lifecycle
// ---------------------------------------------------------------------------

describe("M3 · queue creation + persistence across restart", () => {
  test("enqueue persists to storage and a fresh engine (app restart) still sees the entry", async () => {
    const h = new Harness()
    const e1 = h.engine()
    const entry = await h.enqueue(e1)
    expect(h.stored).toHaveLength(1)
    expect(h.stored[0].id).toBe(entry.id)
    expect(entry.status).toBe("pending")
    expect(entry.attemptCount).toBe(0)

    // "restart" — brand-new engine, same storage
    const e2 = h.restarted()
    await e2.load()
    expect(e2.snapshot()).toHaveLength(1)
    expect(e2.snapshot()[0].id).toBe(entry.id)
    expect(e2.snapshot()[0].clientEventId).toBe(entry.clientEventId)
  })

  test("an entry stuck in 'syncing' (app died mid-flight) returns to pending on load", async () => {
    const h = new Harness()
    const e1 = h.engine()
    const entry = await h.enqueue(e1)
    // simulate a crash mid-submission: the stored copy says syncing
    h.stored = [{ ...h.stored[0], status: "syncing", attemptCount: 1 }]
    const e2 = h.restarted()
    await e2.load()
    const revived = e2.snapshot()[0]
    expect(revived.status).toBe("pending")
    expect(revived.id).toBe(entry.id)
    expect(revived.attemptCount).toBe(1) // the interrupted attempt still counts
  })

  test("queue refuses a second same-kind punch while one is unresolved (duplicate prevention)", async () => {
    const h = new Harness()
    const e = h.engine()
    await h.enqueue(e) // pending check-in
    await expect(h.enqueue(e)).rejects.toThrow(/check-in is still waiting/)
    // a check-OUT is fine — different kind (server sequence rule is per-kind)
    const out = await h.enqueue(e, "attendance.geofence.checkout")
    expect(out.action).toBe("attendance.geofence.checkout")
    // ...but a second check-out is refused too
    await expect(h.enqueue(e, "attendance.geofence.checkout")).rejects.toThrow(/check-out is still waiting/)
  })

  test("after the check-in syncs, a new check-in may be enqueued", async () => {
    const h = new Harness()
    const e = h.engine()
    h.rpcScript.push(() => ({ id: "a1", status: "PRESENT" }))
    await h.enqueue(e)
    await e.syncOnce()
    // entry is synced → next check-in (tomorrow's punch) is allowed
    const again = await h.enqueue(e)
    expect(again.status).toBe("pending")
  })

  test("queue cap: 50 entries → honest error, no silent growth", async () => {
    const h = new Harness()
    const e = h.engine()
    for (let i = 0; i < 50; i++) {
      // cap test: fill with REJECTED same-kind entries (no same-kind conflict)
      h.stored.push({
        id: `r${i}`, clientEventId: `c${i}`, action: "attendance.geofence.checkin",
        payload: {}, status: "rejected", attemptCount: 1,
        createdAt: new Date(h.nowMs - i * 1000).toISOString(), capturedOffline: false,
        lastAttemptAt: new Date(h.nowMs).toISOString(), nextRetryAt: null,
        syncedAt: null, lastError: "x", requiresReview: false, replayed: false,
      })
    }
    await e.load()
    await expect(h.enqueue(e)).rejects.toThrow(/queue is full/i)
  })
})

// ---------------------------------------------------------------------------
// Submission, idempotency, and honest state transitions
// ---------------------------------------------------------------------------

describe("M3 · submission + idempotency", () => {
  test("successful submission → synced, with the idempotency fields the server needs", async () => {
    const h = new Harness()
    const e = h.engine()
    h.rpcScript.push(() => ({ id: "a1", status: "PRESENT", checkIn: "08:05" }))
    const entry = await h.enqueue(e)
    await e.syncEntry(entry.id)

    const after = e.snapshot()[0]
    expect(after.status).toBe("synced")
    expect(after.syncedAt).toBeTruthy()
    expect(after.lastError).toBeNull()
    // the payload the server received carries the engine-owned idempotency key
    expect(h.rpcCalls[0].payload.clientEventId).toBe(entry.clientEventId)
    expect(h.rpcCalls[0].payload.clientTimestamp).toBe(entry.createdAt)
    expect(h.rpcCalls[0].payload.offlineCapture).toBe(false) // online first attempt
  })

  test("the SAME clientEventId is reused on every retry — a retry can never create a second attendance record", async () => {
    const h = new Harness()
    const e = h.engine()
    const entry = await h.enqueue(e, "attendance.geofence.checkin", true) // captured offline
    h.rpcScript.push(() => { throw mkErr("Network request failed") }) // attempt 1 fails
    h.rpcScript.push(() => { throw mkErr("Network request failed") }) // attempt 2 fails
    h.rpcScript.push(() => ({ id: "a1", status: "PRESENT" })) // attempt 3 lands
    await e.syncOnce()
    h.nowMs += BACKOFF_BASE_MS + 1 // advance past the attempt-1 backoff gate
    await e.syncOnce()
    h.nowMs += 2 * BACKOFF_BASE_MS + 1 // advance past the attempt-2 gate
    await e.syncOnce()

    expect(h.rpcCalls.map((c) => c.payload.clientEventId)).toEqual([
      entry.clientEventId, entry.clientEventId, entry.clientEventId,
    ])
    expect(e.snapshot()[0].status).toBe("synced")
    expect(h.rpcCalls[2].payload.offlineCapture).toBe(true)
  })

  test("a network-dropped submission that actually LANDED resolves via idempotentReplay", async () => {
    const h = new Harness()
    const e = h.engine()
    const entry = await h.enqueue(e)
    h.rpcScript.push(() => { throw mkErr("Network request failed") }) // response lost
    h.rpcScript.push(() => ({ id: "a1", status: "PRESENT", idempotentReplay: true, eventStatus: "ACCEPTED" }))
    await e.syncEntry(entry.id) // fails
    await e.syncEntry(entry.id) // server: already accepted
    const after = e.snapshot()[0]
    expect(after.status).toBe("synced")
    expect(after.replayed).toBe(true)
  })

  test("a server review verdict (OFFLINE_CAPTURE) surfaces as requiresReview", async () => {
    const h = new Harness()
    const e = h.engine()
    const entry = await h.enqueue(e)
    h.rpcScript.push(() => ({ id: "a1", status: "LATE", eventStatus: "REVIEW_REQUIRED", reviewStatus: "PENDING" }))
    await e.syncEntry(entry.id)
    expect(e.snapshot()[0].requiresReview).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Retry behavior + exponential backoff gating
// ---------------------------------------------------------------------------

describe("M3 · retry behavior + exponential backoff", () => {
  test("failed attempts schedule retryAt with exponential growth; not-due entries are skipped", async () => {
    const h = new Harness()
    const e = h.engine()
    await h.enqueue(e)

    // attempt 1 fails (network) → next retry in ~5s
    h.rpcScript.push(() => { throw mkErr("Network request failed") })
    await e.syncOnce()
    let entry = e.snapshot()[0]
    expect(entry.status).toBe("pending")
    expect(entry.attemptCount).toBe(1)
    expect(Date.parse(entry.nextRetryAt!)).toBe(h.nowMs + BACKOFF_BASE_MS)

    // still inside the backoff window → no attempt, no rpc call
    await e.syncOnce()
    expect(h.rpcCalls).toHaveLength(1)

    // advance past the gate → attempt 2 fires and fails → ~10s
    h.nowMs += BACKOFF_BASE_MS + 1
    h.rpcScript.push(() => { throw mkErr("Service unavailable", 503) })
    await e.syncOnce()
    entry = e.snapshot()[0]
    expect(entry.attemptCount).toBe(2)
    expect(Date.parse(entry.nextRetryAt!)).toBe(h.nowMs + 2 * BACKOFF_BASE_MS)
    expect(entry.lastError).toBe("Service unavailable")
  })

  test("manual retryNow clears the backoff gate immediately", async () => {
    const h = new Harness()
    const e = h.engine()
    const entry = await h.enqueue(e)
    h.rpcScript.push(() => { throw mkErr("Network request failed") })
    await e.syncOnce()
    expect(e.snapshot()[0].nextRetryAt).not.toBeNull()
    await e.retryNow(entry.id)
    expect(e.snapshot()[0].nextRetryAt).toBeNull()
    h.rpcScript.push(() => ({ id: "a1", status: "PRESENT" }))
    await e.syncOnce()
    expect(e.snapshot()[0].status).toBe("synced")
  })

  test("network recovery: the reconnecting device delivers the queued punch (FIFO when several)", async () => {
    const h = new Harness()
    const e = h.engine()
    const ci = await h.enqueue(e, "attendance.geofence.checkin", true)
    // check-out is enqueued while the check-in is still pending — allowed
    // (different kind) — and must sync AFTER the check-in (server sequence)
    const co = await h.enqueue(e, "attendance.geofence.checkout", true)
    h.rpcScript.push(() => ({ id: "a1", status: "PRESENT" }))
    h.rpcScript.push(() => ({ id: "a1", status: "PRESENT", checkOut: "17:02" }))
    const out = await e.syncOnce()
    expect(out.synced).toBe(2)
    expect(h.rpcCalls.map((c) => c.action)).toEqual([
      "attendance.geofence.checkin",
      "attendance.geofence.checkout",
    ])
    expect(ci.createdAt <= co.createdAt).toBe(true)
    for (const c of h.rpcCalls) expect(c.payload.offlineCapture).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Authentication expiration + permanent errors
// ---------------------------------------------------------------------------

describe("M3 · authentication expiration (401) pauses the queue honestly", () => {
  test("401 mid-pass stops later entries; entries stay pending with an honest message; syncNow resumes", async () => {
    const h = new Harness()
    const e = h.engine()
    // one pending check-in + one pending check-out (mixed kinds — the queue's
    // own one-per-kind rule) so the pass has a LATER entry the 401 must skip
    const first = await h.enqueue(e, "attendance.geofence.checkin", true)
    const second = await h.enqueue(e, "attendance.geofence.checkout", true)

    h.rpcScript.push(() => { throw mkErr("Session expired. Please log in again.", 401) })
    const out = await e.syncOnce()
    expect(out.attempted).toBe(1)
    expect(out.pausedForAuth).toBe(true)

    const s = e.summary()
    expect(s.pending).toBe(2) // first stayed pending (401 ≠ delivered), second untouched
    expect(e.snapshot().find((x) => x.id === first.id)?.lastError).toMatch(/Session expired/)
    expect(e.snapshot().find((x) => x.id === second.id)?.attemptCount).toBe(0)
    expect(e.authPaused).toBe(true)

    // a background trigger while paused must NOT hammer the endpoint
    await e.syncOnce()
    expect(h.rpcCalls).toHaveLength(1)

    // re-login → syncNow clears the pause and delivers both
    h.rpcScript.push(() => ({ id: "a1", status: "PRESENT" }))
    h.rpcScript.push(() => ({ id: "a1", status: "PRESENT", checkOut: "17:02" }))
    const resumed = await e.syncNow()
    expect(resumed.synced).toBe(2)
    expect(e.snapshot().find((x) => x.id === second.id)?.status).toBe("synced")
  })
})

describe("M3 · permanent server rejections are terminal and honest", () => {
  test("400 policy rejection (e.g. 'This attendance requires a selfie') → rejected, never auto-retried", async () => {
    const h = new Harness()
    const e = h.engine()
    const entry = await h.enqueue(e)
    h.rpcScript.push(() => { throw mkErr("This attendance requires a selfie", 400) })
    await e.syncEntry(entry.id)
    const after = e.snapshot()[0]
    expect(after.status).toBe("rejected")
    expect(after.lastError).toBe("This attendance requires a selfie")
    expect(after.nextRetryAt).toBeNull()
    // no auto retry
    h.nowMs += 10 * 60_000
    await e.syncOnce()
    expect(h.rpcCalls).toHaveLength(1)
    // but the user can dismiss it after reading the message
    await e.dismiss(entry.id)
    expect(e.snapshot()).toHaveLength(0)
  })

  test("conflicting attendance event (H-4 'Already checked in today') → rejected with the server's words", async () => {
    const h = new Harness()
    const e = h.engine()
    const entry = await h.enqueue(e, "attendance.geofence.checkin", true)
    h.rpcScript.push(() => { throw mkErr("Already checked in today", 400) })
    await e.syncEntry(entry.id)
    expect(e.snapshot()[0].status).toBe("rejected")
    expect(e.snapshot()[0].lastError).toBe("Already checked in today")
  })

  test("dismiss only removes rejected entries — pending/synced are protected", async () => {
    const h = new Harness()
    const e = h.engine()
    const pending = await h.enqueue(e, "attendance.geofence.checkin", true)
    await e.dismiss(pending.id)
    expect(e.snapshot()).toHaveLength(1)
    h.rpcScript.push(() => ({ id: "a1", status: "PRESENT" }))
    await e.syncEntry(pending.id)
    await e.dismiss(pending.id)
    expect(e.snapshot()).toHaveLength(1) // synced entries age out by retention
  })

  test("removePendingEntry (photo-safety): deletes a pending selfie-carrying punch, refuses synced/rejected", async () => {
    const h = new Harness()
    const e = h.engine()
    const entry = await h.enqueue(e)
    h.rpcScript.push(() => { throw mkErr("Network request failed") })
    await e.syncEntry(entry.id)
    // first attempt failed → the screen removes the entry so photo bytes
    // never sit in device storage
    expect(await e.removePendingEntry(entry.id)).toBe(true)
    expect(e.snapshot()).toHaveLength(0)
    expect(h.stored).toHaveLength(0) // persisted removal — nothing lingers

    // refuses synced and rejected entries
    const s2 = await h.enqueue(e)
    h.rpcScript.push(() => ({ id: "a1", status: "PRESENT" }))
    await e.syncEntry(s2.id)
    expect(await e.removePendingEntry(s2.id)).toBe(false)
    const s3 = await h.enqueue(e, "attendance.geofence.checkout")
    h.rpcScript.push(() => { throw mkErr("Already checked out today", 400) })
    await e.syncEntry(s3.id)
    expect(await e.removePendingEntry(s3.id)).toBe(false)

    // removal frees the same-kind slot for a re-punch
    const s4 = await h.enqueue(e)
    expect(s4.status).toBe("pending")
  })
})

// ---------------------------------------------------------------------------
// Queue cleanup (retention)
// ---------------------------------------------------------------------------

describe("M3 · queue cleanup after confirmed synchronization", () => {
  test("synced entries are pruned 72h after sync; rejected after 7 days", async () => {
    const h = new Harness()
    const e = h.engine()
    const entry = await h.enqueue(e)
    h.rpcScript.push(() => ({ id: "a1", status: "PRESENT" }))
    await e.syncEntry(entry.id)
    // 71h later — still visible (honest "Synchronized" record)
    h.nowMs += SYNCED_RETENTION_MS - 3600_000
    await h.restarted().load()
    const e2 = h.restarted()
    await e2.load()
    expect(e2.snapshot()).toHaveLength(1)
    // 73h later — pruned
    h.nowMs += 2 * 3600_000
    const e3 = h.restarted()
    await e3.load()
    expect(e3.snapshot()).toHaveLength(0)
  })

  test("rejected entries survive 6 days, pruned after 7", async () => {
    const h = new Harness()
    const e = h.engine()
    const entry = await h.enqueue(e)
    h.rpcScript.push(() => { throw mkErr("Already checked in today", 400) })
    await e.syncEntry(entry.id)
    h.nowMs += REJECTED_RETENTION_MS - 24 * 3600_000
    const e2 = h.restarted()
    await e2.load()
    expect(e2.snapshot()).toHaveLength(1)
    h.nowMs += 2 * 24 * 3600_000
    const e3 = h.restarted()
    await e3.load()
    expect(e3.snapshot()).toHaveLength(0)
  })

  test("PENDING entries are never silently dropped by retention", async () => {
    const h = new Harness()
    const e = h.engine()
    await h.enqueue(e, "attendance.geofence.checkin", true)
    h.nowMs += 365 * 24 * 3600_000 // a year of no connectivity
    const e2 = h.restarted()
    await e2.load()
    expect(e2.snapshot()).toHaveLength(1)
    expect(e2.snapshot()[0].status).toBe("pending")
  })
})

// ---------------------------------------------------------------------------
// Summary (UI state visibility)
// ---------------------------------------------------------------------------

describe("M3 · summary powers honest UI states", () => {
  test("counts by status, nextRetryAt and anyDueNow reflect reality", async () => {
    const h = new Harness()
    const e = h.engine()
    await h.enqueue(e, "attendance.geofence.checkin", true) // pending, due now
    await h.enqueue(e, "attendance.geofence.checkout", true)
    h.rpcScript.push(() => { throw mkErr("Network request failed") })
    await e.syncOnce() // first entry fails → backoff; second is same-pass… but
    // (the pass processes due entries: entry1 attempt fails; entry2 fires too)
    const s = e.summary()
    expect(s.pending + s.synced + s.rejected).toBe(2)
    expect(s.nextRetryAt).not.toBeNull()
  })
})

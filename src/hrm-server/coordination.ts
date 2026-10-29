// ============ SCL-21 (Phase 3 WS-B) — distributed coordination primitives =======
// ONE home for cross-instance coordination: distributed locks and distributed
// rate buckets. Two instances behind one LB must not double-run the scheduler
// tick, double-submit the nightly backup, or double-count rate limits.
//
// BACKENDS (in preference order):
//   1. Redis   — when REDIS_URL is set (and reachable). Locks: SET NX PX +
//      compare-and-del release. Rate: INCR + EXPIRE fixed window. Redis is
//      INTENTIONALLY confined to these narrow uses (locks + buckets + cache
//      sharing per the approved constraint set) — the BgJob queue semantics
//      (priority lanes, dead-letter, recovery) stay in Postgres untouched.
//   2. Postgres — ALWAYS available fallback via the CoordinationLock table
//      (conditional-update claims, atomic in the database). This makes a
//      multi-instance deployment safe with ZERO new infrastructure.
//
// DEGRADATION: every Redis call is wrapped — on connection failure the module
// logs once, marks the backend dead for 60 s, and serves the request from the
// fallback (or reports "unavailable" for rate buckets, where the caller keeps
// its existing per-process limiter). A Redis outage therefore never fails
// user-facing requests.
//
// Bun note: the Redis client is Bun's built-in (Bun.redis binds to REDIS_URL).
// Under Node runtimes Bun is undefined and the Postgres backend is used —
// same API, zero code changes at call sites.
import crypto from "crypto"
import { db } from "@/lib/db"

const REDIS_URL = process.env.REDIS_URL || ""
const LOCK_PREFIX = "lock:"
const RATE_PREFIX = "rl:"

/** Redis backend liveness (module-level; reset by _resetRedisForTests). */
let redisDeadUntil = 0

type RedisLike = {
  send: (command: string, ...args: (string | number)[]) => Promise<unknown>
  eval?: (script: string, numkeys: number | string, ...args: (string | number)[]) => Promise<unknown>
}

/** Lazily resolved Redis client (Bun built-in). Null under Node / no REDIS_URL. */
function redisClient(): RedisLike | null {
  if (!REDIS_URL) return null
  if (Date.now() < redisDeadUntil) return null
  const anyGlobal = globalThis as unknown as { Bun?: { redis?: RedisLike } }
  const client = anyGlobal.Bun?.redis
  if (!client) return null
  return client
}

function markRedisDead(): void {
  redisDeadUntil = Date.now() + 60_000
  console.error("[coordination] Redis unreachable — falling back to the Postgres/in-process backend for 60 s")
}

/** Test hook — clear the degraded flag (and allow re-resolution). */
export function _resetRedisForTests(): void {
  redisDeadUntil = 0
}

/** Unique per-process holder id (stable across calls, unique per boot). */
const INSTANCE_ID = `${process.pid}-${crypto.randomBytes(6).toString("hex")}`

function newHolder(scope: string): string {
  return `${INSTANCE_ID}:${scope}:${crypto.randomBytes(8).toString("hex")}`
}

// ============================== distributed locks ==============================

export type LockHandle = { key: string; holder: string; backend: "redis" | "postgres" }

/**
 * Try to acquire a distributed lock for `ttlMs`. Returns null when another
 * holder owns a live lock. The TTL bounds any crash: a holder that dies
 * without releasing simply expires. Idempotent re-acquisition by the SAME
 * holder refreshes the TTL (Postgres backend; Redis NX would refuse, so the
 * Postgres path is used for self-refresh semantics — callers today never
 * re-acquire with the same holder string).
 */
export async function tryAcquireLock(key: string, ttlMs: number, holder = newHolder(key)): Promise<LockHandle | null> {
  const ttl = Math.max(100, Math.floor(ttlMs))
  const redis = redisClient()
  if (redis) {
    try {
      const ok = await redis.send("SET", `${LOCK_PREFIX}${key}`, holder, "NX", "PX", ttl)
      if (ok === "OK") return { key, holder, backend: "redis" }
      return null
    } catch {
      markRedisDead()
      // fall through to Postgres
    }
  }
  // ---- Postgres backend: insert-or-takeover-when-expired (atomic) ----
  // (2026-10-22 post-delivery hotfix #2) One INSERT … ON CONFLICT DO UPDATE …
  // WHERE … RETURNING statement replaces the previous create()→P2002-catch→
  // conditional-updateMany sequence. Reason: releaseLock() deliberately
  // leaves the row behind (released = epoch backdate), so every
  // re-acquisition — each scheduler tick after the first, every period
  // claim after a restart — collided on the PK, and the Prisma ENGINE
  // logs a unique-constraint error before user code can catch it (the
  // `prisma:error Invalid … coordinationLock.create()` dump that swamped
  // dev/ops consoles on every tick). This form expresses the whole claim
  // atomically inside the database and raises NO error in ANY outcome:
  //   - row absent          → INSERT wins               → we hold the lock
  //   - expired / released  → DO UPDATE passes WHERE    → takeover (TTL-bounded
  //                           crash recovery; the released row reads as 1970)
  //   - same holder         → DO UPDATE passes WHERE    → TTL refresh (re-claim)
  //   - live foreign holder → WHERE fails → RETURNING 0 → null (someone else's)
  // Expiry is compared against a JS Date PARAMETER, not the DB's now(): the
  // column is naive timestamp(3) and Prisma serializes Date params as UTC
  // wall-clock — identical to the old `lt: new Date()` comparison and immune
  // to the database session timezone (a non-UTC Postgres would otherwise
  // judge every lock by local wall-clock and break mutual exclusion).
  const now = new Date()
  const expiresAt = new Date(now.getTime() + ttl)
  const rows = await db.$queryRaw<Array<{ key: string }>>`
    INSERT INTO "CoordinationLock" ("key", "holder", "expiresAt", "updatedAt")
    VALUES (${LOCK_PREFIX + key}, ${holder}, ${expiresAt}, ${now})
    ON CONFLICT ("key") DO UPDATE
      SET "holder" = ${holder}, "expiresAt" = ${expiresAt}, "updatedAt" = ${now}
      WHERE "CoordinationLock"."expiresAt" < ${now} OR "CoordinationLock"."holder" = ${holder}
    RETURNING "key"`
  return rows.length > 0 ? { key, holder, backend: "postgres" } : null
}

/** Release a held lock (no-op when it already expired or someone else owns it). */
export async function releaseLock(handle: LockHandle | null): Promise<void> {
  if (!handle) return
  if (handle.backend === "redis") {
    const redis = redisClient()
    if (redis) {
      try {
        // compare-and-del: only delete when WE still hold it (Lua for atomicity)
        await redis.eval?.(
          "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end",
          1, `${LOCK_PREFIX}${handle.key}`, handle.holder,
        )
        return
      } catch {
        markRedisDead()
        return // the TTL reaps it
      }
    }
    return
  }
  await db.coordinationLock
    .updateMany({ where: { key: LOCK_PREFIX + handle.key, holder: handle.holder }, data: { expiresAt: new Date(0) } })
    .catch(() => {})
}

/**
 * Run `fn` under a distributed lock. Returns null (lock not acquired) when
 * another holder is running — callers treat that as "someone else's job".
 * The lock is released in a finally; a crash is bounded by the TTL.
 */
export async function withDistributedLock<T>(
  key: string,
  ttlMs: number,
  fn: () => Promise<T>,
): Promise<T | null> {
  const handle = await tryAcquireLock(key, ttlMs)
  if (!handle) return null
  try {
    return await fn()
  } finally {
    await releaseLock(handle)
  }
}

// ============================== distributed rate buckets ==============================

export type DistributedRateResult = { ok: boolean; retryAfterSec: number; remaining: number } | null

/**
 * Distributed fixed-window rate bucket. Returns null when NO distributed
 * backend is available (no Redis) — the caller then keeps its existing
 * per-process limiter (documented single-instance behavior). Only Redis is
 * used for buckets: a Postgres fallback already exists in the shape of the
 * DB-backed Throttle limiter (security.ts rateLimit), and duplicating it here
 * would add a second table for the same job.
 */
export async function distributedRateHit(key: string, limit: number, windowMs: number): Promise<DistributedRateResult> {
  const redis = redisClient()
  if (!redis) return null
  const bucket = Math.floor(Date.now() / windowMs)
  const k = `${RATE_PREFIX}${key}:${bucket}`
  try {
    const count = Number(await redis.send("INCR", k))
    if (count === 1) await redis.send("EXPIRE", k, Math.ceil(windowMs / 1000))
    const ok = count <= limit
    const retryAfterSec = ok ? 0 : Math.max(1, Math.ceil(((bucket + 1) * windowMs - Date.now()) / 1000))
    return { ok, retryAfterSec, remaining: Math.max(0, limit - count) }
  } catch {
    markRedisDead()
    return null
  }
}

// ============================== daily one-shot claims ==============================

/**
 * Claim a named once-per-period action (e.g. the nightly scheduled backup) so
 * N instances behind one LB submit it exactly once. TTL-based: `periodEndMs`
 * is the epoch millis at which the claim expires (e.g. next local midnight).
 */
export async function claimPeriodAction(name: string, periodEndMs: number): Promise<boolean> {
  const ttl = Math.max(1_000, periodEndMs - Date.now())
  const handle = await tryAcquireLock(`period:${name}`, ttl)
  // Period claims are intentionally NOT released: the TTL IS the claim.
  // (Releasing would let a second instance claim the same period action.)
  return handle !== null
}

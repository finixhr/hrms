// ============ Wave 11 §2 — shared application cache (Redis L2, optional) =======
// Cross-instance read cache for HOT, RE-DERIVABLE data (master prompt §2:
// "frequently accessed tenant and subscription metadata; module entitlements
// and permission lookups"). The design contract from the prompt:
//
//   - PostgreSQL stays the AUTHORITATIVE source for financial and
//     subscription state. The cache only ever serves values that the code
//     could recompute from Postgres — never an independent decision.
//   - NEVER stale-grant: every key carries a short TTL (callers pass one;
//     entitlements reuse their existing 10 s window) AND every mutation path
//     that changes entitlement-relevant state calls cacheDel() (which is a
//     cluster-wide Redis DEL — invalidation is immediate on every instance
//     whenever Redis is up). When Redis is DOWN the system degrades to the
//     pre-existing per-process memo + a DB read: same behavior as today's
//     single-instance deployments, never a hard failure.
//   - Versioned keys ("hrm:c1:…") — bump the prefix constant to orphan every
//     cached value at once after a payload-format change.
//
// BACKEND: Bun's built-in Redis client (Bun.redis binds to REDIS_URL), the
// same zero-dependency pattern as coordination.ts. Under the Node runtime
// (tests, `next start` without Bun) Bun is undefined and every call
// transparently no-ops to "miss" — call sites were written against a
// miss-first contract, so nothing changes for them.
//
// DEGRADATION: on the first connection error the backend is marked dead for
// 60 s (one console line, no per-request spam). Reads then miss (the caller
// recomputes from Postgres — correct, just slower); writes are skipped. A
// background probe is unnecessary: the 60 s tombstone expires and the next
// write attempt reconnects.
//
// WHAT NOT TO PUT HERE: sessions (already DB-backed rows), payment state,
// anything that must not be served 10 s stale. This module is for hot
// read-heavy re-derivable payloads only.

const KEY_PREFIX = "hrm:c1:"
/** Read REDIS_URL per call (NOT at module load): the module graph may be
 * imported long before the environment is finalized (a test file's env
 * bootstrap, a supervisor that sets env after preloading modules), and a
 * hard-captured "" would permanently pin the cache to the per-process
 * fallback even after REDIS_URL appears. */
function redisUrl(): string {
  return process.env.REDIS_URL || ""
}

/** Cache liveness tombstone — mirrors coordination.ts (module-level, reset by
 * _resetCacheForTests so unit tests can exercise both backends). */
let redisDeadUntil = 0

type RedisLike = { send: (command: string, ...args: (string | number)[]) => Promise<unknown> }

function redisClient(): RedisLike | null {
  if (!redisUrl()) return null
  if (Date.now() < redisDeadUntil) return null
  const anyGlobal = globalThis as unknown as { Bun?: { redis?: RedisLike } }
  const client = anyGlobal.Bun?.redis
  if (!client) return null
  return client
}

function markRedisDead(): void {
  if (Date.now() >= redisDeadUntil) {
    // only log on the TRANSITION into the dead window (one line per outage,
    // not one per failed call)
    console.error("[cache] Redis unreachable — serving from Postgres/per-process memo for 60 s")
  }
  redisDeadUntil = Date.now() + 60_000
}

/** Test hook — clear the degraded tombstone. */
export function _resetCacheForTests(): void {
  redisDeadUntil = 0
}

/** Which backend the cache is currently wired to (for /api/metrics). */
export function cacheBackend(): "redis" | "none" {
  return redisClient() ? "redis" : "none"
}

// ---------------------------------------------------------------------------
// stats — exported for /api/metrics (§13: "Cache hit rate, misses, evictions,
// and availability"). Eviction is a Redis-server concern (maxmemory policy);
// `errors` covers unreachable/unexpected backend responses.
// ---------------------------------------------------------------------------
const stats = { hits: 0, misses: 0, sets: 0, deletes: 0, errors: 0 }

export function cacheStats(): typeof stats {
  return { ...stats }
}

/** Test hook. */
export function _resetCacheStatsForTests(): void {
  stats.hits = 0; stats.misses = 0; stats.sets = 0; stats.deletes = 0; stats.errors = 0
}

// ---------------------------------------------------------------------------
// core API — JSON values only (callers here cache structured payloads).
// ---------------------------------------------------------------------------

/** Read a cached JSON value. Returns null on miss / no backend / any error —
 * the caller MUST treat null as "recompute from Postgres". */
export async function cacheGetJson<T>(key: string): Promise<T | null> {
  const redis = redisClient()
  if (!redis) { stats.misses++; return null }
  try {
    const raw = await redis.send("GET", KEY_PREFIX + key)
    if (raw == null) { stats.misses++; return null }
    stats.hits++
    try {
      return JSON.parse(String(raw)) as T
    } catch {
      // corrupt entry — treat as a miss (the caller recomputes and the
      // next cacheSetJson overwrites it); do not count as a backend error
      stats.hits--; stats.misses++
      return null
    }
  } catch {
    stats.misses++
    stats.errors++
    markRedisDead()
    return null
  }
}

/** Store a JSON value with a TTL in SECONDS. TTLs are mandatory (no
 * unbounded retention): a forgotten invalidation can only serve stale data
 * for the TTL window, which callers size to their staleness budget. */
export async function cacheSetJson(key: string, value: unknown, ttlSec: number): Promise<void> {
  const redis = redisClient()
  if (!redis) return
  try {
    const ttl = Math.max(1, Math.min(86_400, Math.floor(ttlSec)))
    await redis.send("SET", KEY_PREFIX + key, JSON.stringify(value), "EX", ttl)
    stats.sets++
  } catch {
    stats.errors++
    markRedisDead()
  }
}

/** Delete a key (or several, variadic). This is the INVALIDATION primitive:
 * a Redis DEL is visible to EVERY app instance immediately, so callers use
 * it wherever entitlement-relevant state changes (payment settled, plan
 * changed, suspension lifted, override saved …). */
export async function cacheDel(...keys: string[]): Promise<void> {
  if (!keys.length) return
  const redis = redisClient()
  if (!redis) return
  try {
    await redis.send("DEL", ...keys.map((k) => KEY_PREFIX + k))
    stats.deletes++
  } catch {
    stats.errors++
    markRedisDead()
  }
}

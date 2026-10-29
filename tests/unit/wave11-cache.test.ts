/// <reference types="bun-types" />
// ============ Wave 11 (2026-10-26) — shared cache (cache.ts) unit tests ========
// Exercises the Redis L2 against an in-memory fake Bun.redis — the same
// pattern the module uses in production (Bun's built-in client, REDIS_URL).
// Covers: miss-first contract, JSON round-trip, TTL clamping, cluster-wide
// DEL invalidation, corrupt-entry handling, and the 60 s dead-marking
// degradation behavior (the "safe fallback when Redis is unavailable" rule).
//
// Import order matters: _wave11-cache-env.ts sets REDIS_URL + installs the
// fake Bun.redis BEFORE cache.ts's module body reads them (static imports
// execute in statement order).
import "./_wave11-cache-env"
import { describe, test, expect, beforeEach } from "bun:test"
import {
  cacheGetJson,
  cacheSetJson,
  cacheDel,
  cacheBackend,
  cacheStats,
  _resetCacheForTests,
  _resetCacheStatsForTests,
} from "@/hrm-server/cache"
import { __fakeRedisStore, __setFakeRedisThrowing } from "./_wave11-cache-env"

describe("Wave 11 — cache.ts (shared L2)", () => {
  beforeEach(() => {
    __fakeRedisStore().clear()
    __setFakeRedisThrowing(false)
    _resetCacheForTests()
    _resetCacheStatsForTests()
  })

  test("backend reports redis when REDIS_URL + Bun.redis are available", () => {
    expect(cacheBackend()).toBe("redis")
  })

  test("miss-first contract: unknown key returns null and counts a miss", async () => {
    const hit = await cacheGetJson("nope:key")
    expect(hit).toBeNull()
    expect(cacheStats().misses).toBe(1)
    expect(cacheStats().hits).toBe(0)
  })

  test("set + get JSON round-trip (nested payload survives)", async () => {
    const value = { mode: "SUBSCRIBED", status: "ACTIVE", nested: { a: 1, b: [true, null] } }
    await cacheSetJson("ent:v1", value, 10)
    const back = await cacheGetJson<typeof value>("ent:v1")
    expect(back).toEqual(value)
    expect(cacheStats().hits).toBe(1)
    expect(cacheStats().misses).toBe(0)
  })

  test("TTL is clamped to 1..86400 seconds on write", async () => {
    await cacheSetJson("k1", { a: 1 }, 0) // too small → 1
    await cacheSetJson("k2", { a: 1 }, 9_999_999) // too large → 86400
    const store = __fakeRedisStore()
    expect(store.get("hrm:c1:k1")?.ttl).toBe(1)
    expect(store.get("hrm:c1:k2")?.ttl).toBe(86400)
  })

  test("keys are namespaced under the versioned prefix", async () => {
    await cacheSetJson("ent:v1", {}, 10)
    expect(__fakeRedisStore().has("hrm:c1:ent:v1")).toBe(true)
  })

  test("cacheDel is the cluster-wide invalidation primitive", async () => {
    await cacheSetJson("ent:v1", { x: 1 }, 10)
    expect(await cacheGetJson("ent:v1")).not.toBeNull()
    await cacheDel("ent:v1")
    expect(await cacheGetJson("ent:v1")).toBeNull()
    expect(cacheStats().deletes).toBe(1)
  })

  test("cacheDel with multiple keys removes all of them", async () => {
    await cacheSetJson("a", { 1: true }, 10)
    await cacheSetJson("b", { 1: true }, 10)
    await cacheDel("a", "b")
    expect(await cacheGetJson("a")).toBeNull()
    expect(await cacheGetJson("b")).toBeNull()
  })

  test("corrupt stored JSON degrades to a miss (never throws)", async () => {
    __fakeRedisStore().set("hrm:c1:bad", { value: "{not-json", ttl: 10 })
    const hit = await cacheGetJson("bad")
    expect(hit).toBeNull()
    expect(cacheStats().misses).toBe(1)
  })

  test("backend failure: marks dead, serves misses without throwing, recovers", async () => {
    __setFakeRedisThrowing(true)
    const first = await cacheGetJson("k") // errors + marks dead
    expect(first).toBeNull()
    const statsAfterFailure = cacheStats()
    expect(statsAfterFailure.errors).toBeGreaterThanOrEqual(1)
    // inside the 60 s dead window: fast miss, no further backend errors
    const second = await cacheGetJson("k")
    expect(second).toBeNull()
    expect(cacheStats().errors).toBe(statsAfterFailure.errors)
    expect(cacheBackend()).toBe("none")
    // writes during the dead window are silently skipped
    await cacheSetJson("k", { a: 1 }, 10)
    expect(__fakeRedisStore().has("hrm:c1:k")).toBe(false)
    // recovery hook (production: the 60 s tombstone simply expires)
    __setFakeRedisThrowing(false)
    _resetCacheForTests()
    expect(cacheBackend()).toBe("redis")
    await cacheSetJson("k", { a: 1 }, 10)
    const got = await cacheGetJson<{ a: number }>("k")
    expect(got).toEqual({ a: 1 })
  })
})

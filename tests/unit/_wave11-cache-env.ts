/// <reference types="bun-types" />
// ============ Wave 11 — fake Bun.redis environment for cache.ts tests ========
// MUST be imported BEFORE "@/hrm-server/cache": cache.ts reads REDIS_URL at
// module-load time and lazily resolves Bun.redis per call. This module sets
// both up with an in-memory Map backend (GET / SET EX / DEL semantics), so
// the cache tests exercise the real code path — including the versioned key
// prefix and the dead-marking degradation — without a live Redis.
process.env.REDIS_URL = "redis://fake-test:6379/0"

type Entry = { value: string; ttl: number | null }
const store = new Map<string, Entry>()
let throwing = false

const fakeBun = {
  redis: {
    send: async (command: string, ...args: (string | number)[]) => {
      if (throwing) throw new Error("fake redis: connection refused")
      const cmd = String(command).toUpperCase()
      if (cmd === "GET") {
        const e = store.get(String(args[0]))
        return e ? e.value : null
      }
      if (cmd === "SET") {
        // SET key value EX ttl
        const key = String(args[0])
        const value = String(args[1])
        let ttl: number | null = null
        for (let i = 2; i < args.length - 1; i++) {
          if (String(args[i]).toUpperCase() === "EX") ttl = Number(args[i + 1])
        }
        store.set(key, { value, ttl })
        return "OK"
      }
      if (cmd === "DEL") {
        // send(command, ...keys) — args here are ALL keys (command already stripped)
        let removed = 0
        for (let i = 0; i < args.length; i++) {
          if (store.delete(String(args[i]))) removed++
        }
        return removed
      }
      throw new Error(`fake redis: unsupported command ${cmd}`)
    },
  },
}
// The Bun runtime exposes Bun.redis as { writable: true } — patch THAT
// property (replacing globalThis.Bun itself throws: it is readonly).
const g = globalThis as unknown as { Bun: { redis: unknown } }
g.Bun.redis = fakeBun.redis

/** Test hooks — expose the fake store + the failure switch. */
export function __fakeRedisStore(): Map<string, Entry> {
  return store
}
export function __setFakeRedisThrowing(on: boolean): void {
  throwing = on
}

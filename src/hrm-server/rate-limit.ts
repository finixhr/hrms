// ============ Targeted in-memory rate limiting (2026-10 round §66) ============
// The project deliberately does NOT rate-limit every authenticated action —
// but live tracking generates high-frequency traffic, so the mobile-ingestion
// endpoints (tracking.location, attendance events, selfie upload) get a
// lightweight sliding-window limiter keyed per user. Limits are sized for
// legitimate tracking frequency (a 15s-interval field client still fits).
//
// SCL-21 (Phase 3 WS-B) — when REDIS_URL is configured the FIRST leg of every
// hit consults a REDIS fixed-window bucket (shared across ALL app instances);
// the in-memory sliding window below remains the fallback for single-instance
// deployments and for Redis outages (coordination.ts degrades gracefully).
// Multi-instance deployments therefore count hits cluster-wide instead of
// doubling every limit per replica.

import { distributedRateHit } from "./coordination"

type Window = { hits: number[] }
const buckets = new Map<string, Window>()
let lastSweep = Date.now()

export type RateLimitResult = { ok: boolean; retryAfterSec: number; remaining: number }

/** Sliding-window limiter. `key` should be `${action}:${userId}`. */
export function rateLimit(key: string, limit: number, windowMs: number): RateLimitResult {
  const now = Date.now()
  // periodic sweep so abandoned users don't pin memory forever
  if (now - lastSweep > 5 * 60_000) {
    for (const [k, w] of buckets) {
      if (!w.hits.length || now - w.hits[w.hits.length - 1] > windowMs) buckets.delete(k)
    }
    lastSweep = now
  }
  let w = buckets.get(key)
  if (!w) {
    w = { hits: [] }
    buckets.set(key, w)
  }
  w.hits = w.hits.filter((t) => now - t < windowMs)
  if (w.hits.length >= limit) {
    const oldest = w.hits[0]
    return { ok: false, retryAfterSec: Math.max(1, Math.ceil((windowMs - (now - oldest)) / 1000)), remaining: 0 }
  }
  w.hits.push(now)
  return { ok: true, retryAfterSec: 0, remaining: limit - w.hits.length }
}

/** Async twin of rateLimit() — SCL-21: prefers the cluster-wide Redis bucket
 *  when one is available; identical semantics otherwise. Hot paths call this;
 *  the sync form stays for callers that cannot await (and for tests). */
export async function rateLimitDistributed(key: string, limit: number, windowMs: number): Promise<RateLimitResult> {
  const shared = await distributedRateHit(key, limit, windowMs)
  if (shared) return shared
  return rateLimit(key, limit, windowMs)
}

/** Limiter presets for the tracking round (sized per §66). */
export const RATE_LIMITS = {
  /** location pings: 15s interval ≈ 240/10min; allow burst headroom */
  location: { limit: 240, windowMs: 10 * 60_000 },
  /** mobile attendance events (check-in/out, periodic): human cadence */
  attendanceEvent: { limit: 40, windowMs: 10 * 60_000 },
  /** selfie uploads: one per attendance action + retries */
  selfie: { limit: 12, windowMs: 10 * 60_000 },
} as const

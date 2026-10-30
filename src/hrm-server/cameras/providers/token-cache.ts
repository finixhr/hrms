// ============ OAuth token cache for tenant-credential brand providers ============
// Phase 5b deliverable (item 2a of the Phase 4 answer): EZVIZ and Imou use
// OAuth client-credentials flow to obtain short-lived access tokens (~2h).
// Calling /oauth/token on every status check or launch would burn through
// the brand's per-tenant rate limits fast. Cache the token in-memory keyed
// by (vendorId, brand) for the token's TTL.
//
// STORAGE: in-memory Map. Multi-instance deployments need Redis — same
// caveat as the Throttle model in security.ts (single-instance only by
// default; multi-instance needs an external store so token state is shared
// across workers). A future Phase could add a DB-backed cache keyed by
// (vendorId, brand) in the CameraCredential row, but in-memory is correct
// for v1 single-instance deployments.
//
// TTL: from the provider's OAuth response (typically `expiresIn: 7200`
// seconds = 2 hours). Tokens are proactively refreshed 60s before expiry
// to avoid race conditions where a token expires mid-flight.
//
// SECURITY: the cached token is PLAINTEXT (the brand cloud needs plaintext
// to authorize API calls). It lives only in process memory; never persisted
// to disk, never logged, never returned to the UI. A process restart loses
// the cache — the next call re-fetches from /oauth/token (a one-time
// ~200ms cost).
//
// See src/hrm/CONVENTIONS.md and src/hrm/API.md for broader app conventions.

/** Refresh tokens 60s before their stated expiry — avoids the race where
 *  a token expires mid-flight between the cache check and the API call. */
const EXPIRY_SAFETY_MARGIN_MS = 60_000

type CachedToken = {
  token: string
  /** Absolute expiry time (Date.now() + (expiresIn * 1000) - SAFETY_MARGIN).
   *  A token is considered expired when Date.now() >= expiresAt. */
  expiresAt: number  // epoch ms
}

/** In-memory cache. Key = `${vendorId}:${brand}`. */
const cache = new Map<string, CachedToken>()

function cacheKey(vendorId: string, brand: string): string {
  return `${vendorId}:${brand}`
}

/** Get a cached token if it's still valid (with the safety margin applied).
 *  Returns null if no token is cached OR the cached token has expired
 *  (in which case the entry is also evicted). */
export function getCachedToken(vendorId: string, brand: string): string | null {
  const key = cacheKey(vendorId, brand)
  const cached = cache.get(key)
  if (!cached) return null
  if (Date.now() >= cached.expiresAt) {
    cache.delete(key)  // expired — evict
    return null
  }
  return cached.token
}

/** Cache a freshly-fetched token. expiresIn is in SECONDS (per OAuth
 *  convention; the brand's /oauth/token response typically includes
 *  `expiresIn: 7200`). The safety margin is subtracted automatically. */
export function setCachedToken(vendorId: string, brand: string, token: string, expiresInSeconds: number): void {
  if (expiresInSeconds <= 0) return  // defensive — bad provider response
  const expiresAt = Date.now() + (expiresInSeconds * 1000) - EXPIRY_SAFETY_MARGIN_MS
  cache.set(cacheKey(vendorId, brand), { token, expiresAt })
}

/** Evict a cached token. Called when a brand API returns 401 (token
 *  invalid/expired early) so the next call re-fetches from /oauth/token.
 *  Also called on credential rotation or deletion. */
export function clearCachedToken(vendorId: string, brand: string): void {
  cache.delete(cacheKey(vendorId, brand))
}

/** Test-only: clear the entire cache. Used between test cases to isolate
 *  cache-hit vs cache-miss behavior. Not exported through the index.ts
 *  barrel — only used in tests/unit/camera-providers-ezviz.test.ts. */
export function __clearAllForTests(): void {
  cache.clear()
}

/** Test-only: inspect the cache size. Used to assert cache-hit behavior
 *  (e.g. "after the 2nd call, cache size is still 1"). */
export function __cacheSizeForTests(): number {
  return cache.size
}

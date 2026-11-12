// ============ C-3 — device comm-key hashing/verification ============
// ZKTeco devices authenticate with a shared "comm key" set at enrollment.
// The server stores a scrypt-salted hash (v2) plus the plaintext (for
// one-time display at enrollment; stripped from every API response) and a
// legacy sha256-hex form for databases predating v2 (read-only support).
//
// SCL-2 (Phase 1, this audit) — the OLD verifyCommKey ran scryptSync on the
// request thread for EVERY device HTTP request (handshake + every ATTLOG
// push): ~50ms of blocked event loop per request, and with a fleet polling
// /iclock/* the Node process serializes all tenants behind one blocked loop.
// Verification is now:
//   1. ASYNC — promisified crypto.scrypt, awaited by resolveDevice;
//   2. CACHED — a positive verify result is memoized for 5 minutes keyed by
//      (stored hash, salt, sha256(presented key)). scrypt is expensive by
//      design; a device that pushes every second re-verifies its unchanged
//      key zero times inside the window. Only SUCCESS is cached (a failure
//      costs the caller nothing to retry and must never pin a wrong result).
import crypto from "crypto"

/** Hash a comm key for storage: scrypt(password, salt) hex + the salt.
 *  Enrollment-time only (admin action), not a request hot path. The SYNC form
 *  stays for tools/tests; request paths use the async twin below (SCL-2). */
export function hashCommKey(key: string): { hash: string; salt: string } {
  const salt = crypto.randomBytes(16).toString("hex")
  const hash = crypto.scryptSync(String(key), salt, 32).toString("hex")
  return { hash, salt }
}

/** SCL-2 companion — async enrollment hash for request paths
 *  (devices.setCommKey). Same output format as hashCommKey. */
export async function hashCommKeyAsync(key: string): Promise<{ hash: string; salt: string }> {
  const salt = crypto.randomBytes(16).toString("hex")
  const hash = (await scryptAsync(String(key), salt, 32)).toString("hex")
  return { hash, salt }
}

const scryptAsync = (key: string, salt: string, keylen: number) =>
  new Promise<Buffer>((resolve, reject) =>
    crypto.scrypt(key, salt, keylen, (err, derived) => (err ? reject(err) : resolve(derived)))
  )

// ---------- SCL-2: 5-minute positive-verify cache ----------
const VERIFY_TTL_MS = 5 * 60_000
const VERIFY_CACHE_MAX = 2_000 // bounded: one entry per (device, presented key) pair in flight
type CacheEntry = { at: number }
const verifyCache = new Map<string, CacheEntry>()

function cacheKey(presented: string, hash: string, salt: string | null | undefined): string {
  // sha256 of the presented key keeps the map free of raw secret material;
  // the stored hash+salt are already server-side values.
  const pk = crypto.createHash("sha256").update(String(presented)).digest("hex").slice(0, 24)
  return `${String(hash).slice(0, 16)}|${salt ? String(salt).slice(0, 16) : "-"}|${pk}`
}

function cacheGet(key: string): boolean {
  const hit = verifyCache.get(key)
  if (!hit) return false
  if (Date.now() - hit.at > VERIFY_TTL_MS) {
    verifyCache.delete(key)
    return false
  }
  return true
}

function cachePut(key: string): void {
  verifyCache.set(key, { at: Date.now() })
  if (verifyCache.size > VERIFY_CACHE_MAX) {
    // evict the oldest third (never a wholesale clear — a burst of distinct
    // devices must not wipe a fleet's worth of valid entries)
    const drop = Math.floor(verifyCache.size / 3)
    let i = 0
    for (const k of verifyCache.keys()) {
      if (i++ >= drop) break
      verifyCache.delete(k)
    }
  }
}

/** Test/ops hook — wipe the verify cache (also keeps the cache testable). */
export function clearCommKeyVerifyCache(): void {
  verifyCache.clear()
}

/** SCL-2 — async, cache-assisted verification. Legacy unsalted sha256-hex
 *  values (32 bytes) still verify. Mirrors the old boolean contract exactly. */
export async function verifyCommKeyAsync(
  presented: string | null | undefined,
  hash: string | null | undefined,
  salt: string | null | undefined,
): Promise<boolean> {
  if (!presented || !hash) return false
  const key = cacheKey(presented, hash, salt)
  if (cacheGet(key)) return true
  const a = Buffer.from(hash, "hex")
  if (!a.length) return false
  if (salt) {
    // v2: scrypt(presented, salt) — ASYNC (SCL-2), never on the request thread
    const b = await scryptAsync(String(presented), salt, a.length)
    const ok = a.length === b.length && crypto.timingSafeEqual(a, b)
    if (ok) cachePut(key)
    return ok
  }
  // legacy: sha256(presented) — cheap hash, stays synchronous
  const b = crypto.createHash("sha256").update(String(presented)).digest()
  const ok = a.length === b.length && crypto.timingSafeEqual(a, b)
  if (ok) cachePut(key)
  return ok
}

/** Timing-safe comparison of a presented key against the stored hash/salt.
 *  SCL-2 — retained for NON-request paths only (scripts/tools, tests). The
 *  device HTTP path uses verifyCommKeyAsync above. */
export function verifyCommKey(presented: string | null | undefined, hash: string | null | undefined, salt: string | null | undefined): boolean {
  if (!presented || !hash) return false
  const a = Buffer.from(hash, "hex")
  // v2: scrypt(presented, salt)
  if (salt) {
    const b = crypto.scryptSync(String(presented), salt, a.length)
    return a.length === b.length && crypto.timingSafeEqual(a, b)
  }
  // legacy: sha256(presented) — compare against the stored hex
  const b = crypto.createHash("sha256").update(String(presented)).digest()
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

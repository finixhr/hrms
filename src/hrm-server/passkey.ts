// ============ WebAuthn/Passkey shared plumbing (both auth planes) ============
// Server-side helpers for the passkey (platform-authenticator / biometric)
// MFA factor. Used by the tenant plane (routes/passkeys.ts — auth.passkey.*)
// and the owner plane (saas/passkey-owner-routes.ts — owner.passkey.*).
//
// Design notes:
//  - The WebAuthn protocol NEVER exposes raw biometric data to the RP: the
//    authenticator keeps the biometric template on-device and only asserts a
//    signed "user verified" flag. Nothing here (nor anywhere else) stores or
//    processes biometric material — by construction.
//  - Challenges are server-generated (SimpleWebAuthn), stored in
//    WebAuthnChallenge with a 120s TTL and SINGLE-USE semantics: a row is
//    claimed (consumedAt set) the moment it is used for one verification
//    attempt, success or failure. Consumed/expired rows are pruned
//    opportunistically (10-minute retention for forensics, then deletion).
//  - Relying Party identity: rpID defaults to the request hostname (port
//    stripped) and expectedOrigin to the request origin, both overridable via
//    HRM_WEBAUTHN_RPID / HRM_WEBAUTHN_ORIGINS (comma list) so multi-origin
//    deployments (proxy + apex + subdomain) can share one registration.
//    Kept dependency-light on purpose: db + SimpleWebAuthn only.
import { db } from "@/lib/db"

/** Auth plane a passkey belongs to — the two planes never share credentials. */
export type PasskeyPlane = "TENANT" | "OWNER"

/** Challenge lifetime: generous for a biometric prompt, short enough to kill replay. */
export const PASSKEY_CHALLENGE_TTL_MS = 120_000
/** How long consumed/expired challenge rows linger for forensics before pruning. */
export const PASSKEY_CHALLENGE_RETENTION_MS = 10 * 60_000

/** Minimal request shape both dispatchers' handlers receive (NextRequest-compatible). */
type ReqLike = { headers?: { get?: (name: string) => string | null }; url?: string } | undefined | null

/** Request protocol: first X-Forwarded-Proto value (TLS-terminating proxy),
 *  else the URL's own scheme, else assume https (mirrors the dispatcher's
 *  isHttpsReq default so LAN/plain-HTTP deployments derive matching origins). */
function requestProto(req: ReqLike): string {
  const xf = String(req?.headers?.get?.("x-forwarded-proto") || "").split(",")[0].trim().toLowerCase()
  if (xf) return xf
  try {
    const u = new URL(String(req?.url || ""))
    if (u.protocol === "http:" || u.protocol === "https:") return u.protocol.replace(":", "")
  } catch { /* fall through */ }
  return "https"
}

/**
 * Resolve the WebAuthn Relying Party for a request:
 *   rpID            — env HRM_WEBAUTHN_RPID, else the request host with any
 *                    port stripped (rpID must be a registrable domain, never
 *                    host:port).
 *   expectedOrigins — env HRM_WEBAUTHN_ORIGINS (comma list, e.g.
 *                    "https://hrm.example.com,https://www.hrm.example.com"),
 *                    else the single request origin (scheme://host, port
 *                    included — origins compare with the port).
 */
export function rpFromRequest(req: ReqLike): { rpID: string; expectedOrigins: string[] } {
  const envRpID = (process.env.HRM_WEBAUTHN_RPID || "").trim()
  const envOrigins = (process.env.HRM_WEBAUTHN_ORIGINS || "")
    .split(",").map((s) => s.trim()).filter(Boolean)
  // Host header first (includes any non-default port), X-Forwarded-Host as the
  // proxy fallback; take the FIRST value of a comma list.
  const host = String(req?.headers?.get?.("host") || "").split(",")[0].trim()
  const rpID = envRpID || host.replace(/:\d+$/, "")
  let expectedOrigins = envOrigins
  if (!expectedOrigins.length && host) {
    expectedOrigins = [`${requestProto(req)}://${host}`]
  }
  return { rpID, expectedOrigins }
}

/** Opportunistic sweep: consumed rows older than the retention window and
 *  long-expired rows. Fire-and-forget — never on the critical path. */
export async function pruneChallenges(): Promise<number> {
  const cutoff = new Date(Date.now() - PASSKEY_CHALLENGE_RETENTION_MS)
  const res = await db.webAuthnChallenge.deleteMany({
    where: { OR: [{ consumedAt: { lt: cutoff } }, { expiresAt: { lt: new Date(Date.now() - PASSKEY_CHALLENGE_RETENTION_MS) } }] },
  })
  return res.count
}

/**
 * Store a freshly generated challenge (from generate{Registration,Authentication}
 * Options). Older unconsumed challenges of the same plane+user+type are NOT
 * deleted — getLiveChallenge() only ever reads the newest row, so a stale
 * start simply orphans the old row for the pruner.
 */
export async function storeChallenge(
  plane: PasskeyPlane,
  userId: string,
  challenge: string,
  type: "REGISTRATION" | "AUTHENTICATION",
): Promise<void> {
  await db.webAuthnChallenge.create({
    data: { plane, userId, challenge, type, expiresAt: new Date(Date.now() + PASSKEY_CHALLENGE_TTL_MS) },
  })
  // opportunistic housekeeping — a failure here never blocks the ceremony
  void pruneChallenges().catch(() => {})
}

/** The newest LIVE (unconsumed, unexpired) challenge row for plane+user+type. */
export async function getLiveChallenge(
  plane: PasskeyPlane,
  userId: string,
  type: "REGISTRATION" | "AUTHENTICATION",
): Promise<{ id: string; challenge: string } | null> {
  const row = await db.webAuthnChallenge.findFirst({
    where: { plane, userId, type, consumedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: "desc" },
    select: { id: true, challenge: true },
  })
  return row || null
}

/**
 * Burn a challenge: conditional update — only the first claimant wins, so two
 * concurrent finishes racing on the same row cannot both verify (replay-safe).
 * The caller burns the row BEFORE attempting verification: a failed attempt
 * consumes the challenge too (brute-forcing one challenge = one guess).
 */
export async function consumeChallengeById(id: string): Promise<boolean> {
  const res = await db.webAuthnChallenge.updateMany({
    where: { id, consumedAt: null },
    data: { consumedAt: new Date() },
  })
  return res.count > 0
}

/** Parse the stored JSON transports array (null/legacy → undefined). */
export function parseTransports(raw: string | null | undefined): string[] | undefined {
  if (!raw) return undefined
  try {
    const arr = JSON.parse(raw)
    return Array.isArray(arr) && arr.length ? arr.map(String) : undefined
  } catch {
    return undefined
  }
}

/** Client-safe projection of a credential row (never leaks the public key /
 *  credential id bytes — the id is an opaque row id the UI echoes back). */
export function serializePasskey(c: {
  id: string
  deviceName: string
  backupEligible: boolean
  backupState: boolean
  lastUsedAt: Date | null
  createdAt: Date
}) {
  return {
    id: c.id,
    deviceName: c.deviceName,
    backupEligible: c.backupEligible,
    backupState: c.backupState,
    lastUsedAt: c.lastUsedAt?.toISOString() || null,
    createdAt: c.createdAt.toISOString(),
  }
}

// ============ POST /api/v1/auth/token — OAuth2-shaped token endpoint ==========
// MOB-1 (Phase 3 WS-D). Two grants:
//   password       { grant_type: "password", email, password, scopes? }
//   refresh_token  { grant_type: "refresh_token", refresh_token }
// See _tokens.ts for the full design notes (session machinery, rotation
// families, reuse detection, scope catalog).
import { NextRequest } from "next/server"
import { z } from "zod"
import { db } from "@/lib/db"
import { login } from "@/hrm-server/auth"
import { audit } from "@/hrm-server/audit"
import { recordLoginAudit } from "@/hrm-server/login-audit"
import { rateLimit, resolveClientIp } from "@/hrm-server/security"
import { apiOk, apiErr, readJsonBody, zodFail } from "../../_auth"
import { normalizeScopes, issueFirstPair, rotateRefreshToken, mayMintTokensFor } from "../../_tokens"

export const dynamic = "force-dynamic"

const bodySchema = z.object({
  grant_type: z.enum(["password", "refresh_token"]),
  email: z.string().trim().max(200).optional(),
  password: z.string().max(200).optional(),
  refresh_token: z.string().max(200).optional(),
  scopes: z.array(z.string().max(40)).max(10).optional(),
}).strict()

export async function POST(req: NextRequest) {
  // the token endpoint is anonymous by design — the grant IS the authentication.
  // API-01 (R5): the IP resolves through the trust-gated resolver (never raw
  // X-Forwarded-For), the password grant is throttled per-IP, and every
  // outcome leaves a login-audit row (plane TENANT) like the web surface.
  const ip = resolveClientIp(req) || null
  const userAgent = req.headers.get("user-agent") || null

  const body = await readJsonBody(req)
  if (!body.ok) return body.res
  const parsed = bodySchema.safeParse(body.body)
  if (!parsed.success) return zodFail(parsed.error.issues)
  const p = parsed.data

  if (p.grant_type === "refresh_token") {
    if (!p.refresh_token) return apiErr(400, "VALIDATION", "grant_type=refresh_token requires a refresh_token field")
    const out = await rotateRefreshToken(p.refresh_token)
    if (!out.ok) return apiErr(out.status, "INVALID_GRANT", out.reason)
    return apiOk({
      access_token: out.pair.accessToken,
      token_type: "Bearer",
      expires_in: out.pair.expiresIn,
      refresh_token: out.pair.refreshToken,
      scope: out.pair.scopes.join(" "),
    })
  }

  // ---- password grant ----
  if (!p.email || !p.password) {
    return apiErr(400, "VALIDATION", "grant_type=password requires email and password fields")
  }

  /** API-01 — identity enrichment for failure rows (server-side only; the
   *  response stays generic — no account oracle). Mirrors the web route. */
  async function failureIdentity(email: unknown): Promise<{ userId?: string; userName?: string; vendorId?: string; vendorName?: string | null; role?: string }> {
    try {
      const emailNorm = String(email || "").toLowerCase().trim()
      if (!emailNorm) return {}
      const matches = await db.user.findMany({ where: { email: emailNorm, status: "ACTIVE" }, select: { id: true, name: true, vendorId: true, role: true } })
      if (matches.length !== 1) return {}
      const vendor = await db.vendor.findUnique({ where: { id: matches[0].vendorId }, select: { name: true } })
      return { userId: matches[0].id, userName: matches[0].name, vendorId: matches[0].vendorId, vendorName: vendor?.name ?? null, role: matches[0].role }
    } catch {
      return {}
    }
  }
  const scopes = normalizeScopes(p.scopes)
  if (!scopes.ok) return apiErr(400, "VALIDATION", scopes.reason)

  let loginResult: Awaited<ReturnType<typeof login>>
  try {
    loginResult = await login(p.email, p.password, ip || undefined, userAgent || "finix-api-v1")
  } catch (e: any) {
    // login() throws 401-style errors (bad credentials / lockout / ambiguity).
    // API-01 — the credential-guessing throttle counts FAILED grants only
    // (10 / 5 min per resolved IP — the same budget as the web second-factor
    // surface). Successful grants are legitimate traffic and never consume
    // the bucket; login()'s internal per-email throttle still applies.
    const overLimit = await rateLimit(`pwgrant:ip:${ip || "unknown"}`, 10, 5 * 60_000)
    const reason: "RATE_LIMITED" | "INACTIVE_VENDOR" | "INVALID_CREDENTIALS" =
      overLimit ? "RATE_LIMITED"
      : String(e?.code) === "429" || /Too many attempts/i.test(String(e?.message || "")) ? "RATE_LIMITED"
      : String(e?.code) === "403" ? "INACTIVE_VENDOR"
      : "INVALID_CREDENTIALS"
    await recordLoginAudit({ plane: "TENANT", email: p.email, success: false, failureReason: reason, ip, userAgent, ...await failureIdentity(p.email) }).catch(() => {})
    if (overLimit) return apiErr(429, "RATE_LIMITED", "Too many failed token requests from this address — try again in a few minutes")
    return apiErr(401, "INVALID_GRANT", "Invalid email or password")
  }
  // Any PREAUTH outcome (MFA challenge, MFA enrollment, password expiry,
  // forced rotation) refuses the grant — headless clients on those accounts
  // must use tenant API keys; interactive users finish the flow in the web app.
  if (!loginResult.token) {
    const reason = (loginResult as any).mfaRequired ? "This account requires multi-factor authentication — complete the web login, then use a tenant API key or an already-issued refresh token."
      : (loginResult as any).mfaEnrollmentRequired ? "This account must enroll multi-factor authentication first (web login)."
      : ((loginResult as any).passwordExpired || (loginResult as any).mustChangePassword) ? "This account must change its password first (web login)."
      : "Login could not complete for this account."
    // API-01 — the credential VERIFIED (a real login event); the grant was
    // refused on policy. Audit it as a successful login with the real UA/IP.
    await recordLoginAudit({
      plane: "TENANT", email: p.email, success: true, mfaUsed: false,
      userId: loginResult.user.id, userName: loginResult.user.name,
      vendorId: loginResult.user.vendorId, vendorName: loginResult.vendor?.name || null,
      role: loginResult.user.role, ip, userAgent,
    }).catch(() => {})
    return apiErr(403, "GRANT_REFUSED", reason)
  }
  const user = loginResult.user
  // API-01 — the grant succeeded: a login-audit row like the web surface writes
  await recordLoginAudit({
    plane: "TENANT", email: p.email, success: true, mfaUsed: false,
    userId: user.id, userName: user.name,
    vendorId: user.vendorId, vendorName: loginResult.vendor?.name || null,
    role: user.role, ip, userAgent,
  }).catch(() => {})
  if (!(await mayMintTokensFor(user.vendorId, user))) {
    return apiErr(403, "SCOPE_MISSING",
      "Your role does not include integrations.view — user tokens are restricted to roles that can administer API credentials. Contact your workspace administrator.")
  }

  const pair = await issueFirstPair({
    userId: user.id, vendorId: user.vendorId, sessionId: loginResult.id, scopes: scopes.scopes, // SEC-02 (R5) — the ROW id, not the credential
  })
  await audit(
    { userId: user.id, userName: user.name, vendorId: user.vendorId, ip: ip ?? undefined },
    "API_V1_TOKEN_ISSUED",
    "User",
    user.id,
    `API v1 user token issued (${scopes.scopes.join(" ") || "read"} — session ${pair.sessionId.slice(0, 8)}…)`,
  ).catch(() => {})
  return apiOk({
    access_token: pair.accessToken,
    token_type: "Bearer",
    expires_in: pair.expiresIn,
    refresh_token: pair.refreshToken,
    scope: pair.scopes.join(" "),
  })
}

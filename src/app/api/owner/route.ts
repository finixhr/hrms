// ============ SaaS Owner API dispatcher — POST /api/owner ============
// A completely separate plane from /api/hrm:
//   - own session cookie (`saas_owner_session`) and SaaSOwnerSession rows
//   - own CSRF token echo (X-CSRF-Token)
//   - own permission vocabulary (owner.*)
//   - own audit log (SaaSAuditLog)
//
// A tenant session token can NEVER authenticate here, and an owner token can
// never authenticate on /api/hrm — the lookups hit different tables.
//
// CSRF model (mirrors /api/hrm C-4):
//   1. content-type must be application/json
//   2. cookie-authenticated calls must echo the session's CSRF token
//      (Bearer fallback is exempt — custom header needs a CORS preflight)
import { NextRequest, NextResponse } from "next/server"
import {
  getOwnerFromToken, ownerLogin, ownerLogout, ownerCookieStr, ownerClearCookieStr,
  OWNER_COOKIE, type OwnerCtx,
  ownerVerifyMfa, ownerStartMfaEnroll, ownerCompleteMfaEnroll,
  ownerRequestPasswordReset, ownerResetPassword,
} from "@/hrm-server/saas/owner-auth"
import { ownerRoutes } from "@/hrm-server/saas/owner-routes"
// owner.cms.* route registrations (side-effect import — must load AFTER
// owner-routes so the ownerRoutes table exists when they self-register)
import "@/hrm-server/saas/cms-routes"
// R11 — owner.communication.* route registrations (same side-effect pattern)
import "@/hrm-server/saas/communication-routes"
// owner.health.* route registrations (WP-N — same side-effect pattern)
import "@/hrm-server/saas/health"
// owner.subscriptions.sweepNow + owner.payments.* route registrations
// (WP-J lifecycle sweep + WP-I gateway settings — same side-effect pattern)
import "@/hrm-server/saas/lifecycle-sweep"
// owner.backup.* route registrations (WP-R — same side-effect pattern)
import "@/hrm-server/saas/backup"
// Phase 5 P0 (Scope 5) — owner.fleet.* fleet-health console actions
import "@/hrm-server/saas/fleet"
// Phase 5 P1 — lifecycle console + quota utilization console route
// registrations (side-effect imports, same pattern as fleet above).
import "@/hrm-server/saas/lifecycle-console"
import "@/hrm-server/saas/quotas"
// Phase 5 P2 — revenue & collections console route registrations
// (owner.billing.* — same side-effect pattern).
import "@/hrm-server/saas/billing-console"
// Phase 5 P3 — growth & engagement console route registrations
// (owner.growth.* — same side-effect pattern).
import "@/hrm-server/saas/growth-console"
// Phase 5 P4 — security & trust console route registrations
// (owner.security.* + owner.audit.overview — same side-effect pattern).
import "@/hrm-server/saas/security-console"
// Phase 5 P5 — tenants & subscriptions console route registrations
// (owner.customers.overview, owner.subscriptions.overview + the rewritten
// owner.renewals.list — same side-effect pattern).
import "@/hrm-server/saas/customers-console"
// Wave 10 (2026-10-24) — Time-Limited Support Access console routes
// (owner.supportAccess.* — start/end/history/policy — same side-effect pattern).
import "@/hrm-server/saas/support-access-routes"
import "@/hrm-server/saas/support-center-routes"
// Wave 10 (2026-10-24) — cloud object storage console routes
// (owner.storage.get/save/test — same side-effect pattern).
import "@/hrm-server/saas/storage"
// Part J §15 — platform-wide storage monitoring console
// (owner.storage.overview — totals/tiers/trend + the paged per-tenant grid;
// same side-effect pattern; storage.ts above owns the provider config actions).
import "@/hrm-server/saas/storage-console"
// Wave 10 (2026-10-24) — OTP console surface (owner.sms.otpStats/testOtp —
// rides the health.view/manage permissions like the other gateway tests).
import "@/hrm-server/saas/otp"
// WebAuthn/passkey MFA — owner.passkey.* (My Account self-service enrollment
// + management; no owner passkey LOGIN — owner sign-in stays password+TOTP).
import "@/hrm-server/saas/passkey-owner-routes"
import { isOriginAllowed, safeEqual, resolveClientIp, requestPublicOrigin } from "@/hrm-server/security"
import { getSaasSettings } from "@/hrm-server/saas/settings"
import { sendOwnerResetEmail } from "@/hrm-server/saas/notify"

export const dynamic = "force-dynamic"

const BODY_CAP_BYTES = 5 * 1024 * 1024

function isHttpsReq(req: NextRequest): boolean {
  const xf = (req.headers.get("x-forwarded-proto") || "").split(",")[0].trim().toLowerCase()
  if (xf) return xf === "https"
  try {
    return new URL(req.url).protocol === "https:"
  } catch {
    return true
  }
}

function tokenFrom(req: NextRequest): string | null {
  const bearer = req.headers.get("authorization")
  if (bearer && bearer.toLowerCase().startsWith("bearer ")) {
    return bearer.slice(7).trim() || null
  }
  const cookie = req.headers.get("cookie") || ""
  for (const part of cookie.split(";")) {
    const [k, ...rest] = part.trim().split("=")
    if (k === OWNER_COOKIE) return rest.join("=") || null
  }
  return null
}

export async function POST(req: NextRequest) {
  try {
    const contentType = (req.headers.get("content-type") || "").split(";")[0].trim().toLowerCase()
    if (contentType !== "application/json") {
      return NextResponse.json({ ok: false, error: "Unsupported content type", code: 415 }, { status: 415 })
    }
    const contentLength = Number(req.headers.get("content-length") || 0)
    if (contentLength > BODY_CAP_BYTES) {
      return NextResponse.json({ ok: false, error: "Payload too large", code: 413 }, { status: 413 })
    }
    // origin allowlist — same policy object as the tenant dispatcher
    const origin = req.headers.get("origin")
    if (origin && !isOriginAllowed(origin, req.headers.get("host"))) {
      return NextResponse.json({ ok: false, error: "Origin not allowed", code: 403 }, { status: 403 })
    }

    let body: { action?: string; payload?: unknown }
    try {
      body = await req.json()
    } catch {
      return NextResponse.json({ ok: false, error: "Malformed JSON body", code: 400 }, { status: 400 })
    }
    const action = typeof body?.action === "string" ? body.action : ""
    if (!action.startsWith("owner.")) {
      return NextResponse.json({ ok: false, error: "Unknown action", code: 404 }, { status: 404 })
    }
    const payload = (body as any).payload ?? {}
    // SEC-5 (Phase 1) — trust-gated client IP (shared H-7 resolver): the old
    // unconditional x-forwarded-for read let any caller forge the IP recorded
    // in login-audit rows (and would have fed fake IPs into the spray-throttle
    // keys). Behind no trusted proxy the IP is null and the throttle binds to
    // the email — the resolver's whole contract.
    const ip = resolveClientIp(req)
    const userAgent = req.headers.get("user-agent") || undefined
    const isHttps = isHttpsReq(req)

    // ---- auth.* (session establishment/teardown — no CSRF requirement yet) ----
    if (action === "owner.auth.login") {
      const { email, password } = (payload || {}) as { email?: string; password?: string }
      // R16 — owner-plane login audit (success + failure, IP + UA + labels)
      const { recordLoginAudit } = await import("@/hrm-server/login-audit")
      let sess: any
      try {
        sess = await ownerLogin(String(email || ""), String(password || ""), ip, userAgent)
      } catch (e: any) {
        const reason = String(e?.code) === "429" ? "RATE_LIMITED" as const : String(e?.code) === "403" ? "INACTIVE_VENDOR" as const : "INVALID_CREDENTIALS" as const
        await recordLoginAudit({ plane: "OWNER", email: String(email || ""), success: false, failureReason: reason, ip, userAgent })
        throw e
      }
      const owner = (sess as any).owner
      // R11 — keep system roles current with the permission vocabulary
      // (one cheap query per login; version-gated, idempotent)
      try { const { ensureSystemOwnerRolesSeeded } = await import("@/hrm-server/saas/owner-roles"); await ensureSystemOwnerRolesSeeded() } catch { /* non-fatal */ }
      await recordLoginAudit({
        plane: "OWNER", email: String(email || ""), success: !!(sess as any).token,
        failureReason: (sess as any).token ? undefined : "MFA_FAILED",
        userId: owner?.id, userName: owner?.name, role: owner?.roleKey,
        mfaUsed: (sess as any).mfaRequired || !!(sess as any).mfaEnrollmentRequired,
        ip, userAgent,
      })
      // MFA challenge: no session cookie yet — the client swaps to step 2
      if ((sess as any).mfaRequired) {
        return NextResponse.json({ ok: true, mfaRequired: true, mfaToken: (sess as any).mfaToken })
      }
      if ((sess as any).mfaEnrollmentRequired) {
        return NextResponse.json({
          ok: true, mfaEnrollmentRequired: true, enrollToken: (sess as any).enrollToken, owner: (sess as any).owner,
        })
      }
      const res = NextResponse.json({
        ok: true,
        token: sess.token,
        csrfToken: sess.csrfToken,
        owner: (sess as any).owner,
      })
      res.headers.append("Set-Cookie", ownerCookieStr(sess.token as string, (sess as any).expiresAt, isHttps))
      return res
    }

    // ---- MFA step 2: verify TOTP / recovery code against the pending challenge ----
    if (action === "owner.auth.login.mfa") {
      const { mfaToken, code, useRecovery } = (payload || {}) as { mfaToken?: string; code?: string; useRecovery?: boolean }
      const sess = await ownerVerifyMfa(String(mfaToken || ""), String(code || ""), { useRecovery: !!useRecovery, ip, userAgent })
      const res = NextResponse.json({ ok: true, token: sess.token, csrfToken: sess.csrfToken, owner: sess.owner })
      res.headers.append("Set-Cookie", ownerCookieStr(sess.token, (sess as any).expiresAt, isHttps))
      return res
    }

    // ---- forced first-login MFA enrollment (platform policy requires MFA) ----
    if (action === "owner.auth.mfa.enroll.start") {
      const { enrollToken } = (payload || {}) as { enrollToken?: string }
      const s = await getSaasSettings()
      const out = await ownerStartMfaEnroll(String(enrollToken || ""), s.general.platformName)
      return NextResponse.json({ ok: true, ...out })
    }
    if (action === "owner.auth.mfa.enroll.complete") {
      const { enrollToken, code } = (payload || {}) as { enrollToken?: string; code?: string }
      const sess = await ownerCompleteMfaEnroll(String(enrollToken || ""), String(code || ""), { ip, userAgent })
      const res = NextResponse.json({
        ok: true, token: sess.token, csrfToken: sess.csrfToken, owner: sess.owner,
        recoveryCodes: (sess as any).recoveryCodes,
      })
      res.headers.append("Set-Cookie", ownerCookieStr(sess.token, (sess as any).expiresAt, isHttps))
      return res
    }

    // ---- self-service password recovery (public, no session, no enumeration) ----
    if (action === "owner.auth.password.forgot") {
      const { email } = (payload || {}) as { email?: string }
      // 2026-10-26: sanitized origin (0.0.0.0 bind host → localhost; no https
      // fabrication on direct HTTP) — reset emails previously carried dead
      // links when the owner console was browsed at the wildcard bind address.
      const origin = requestPublicOrigin(req) || req.nextUrl?.origin || new URL(req.url).origin
      await ownerRequestPasswordReset(String(email || ""), {
        ip,
        sendEmail: async (to, token) => { await sendOwnerResetEmail(to, token, origin) },
      })
      return NextResponse.json({
        ok: true,
        message: "If that email belongs to an active owner account, a reset link has been sent (valid 60 minutes).",
      })
    }
    if (action === "owner.auth.password.reset") {
      const { token, newPassword } = (payload || {}) as { token?: string; newPassword?: string }
      await ownerResetPassword(String(token || ""), String(newPassword || ""), ip)
      return NextResponse.json({ ok: true, message: "Password updated — sign in with your new password." })
    }

    // ---- session resolution for everything else ----
    const token = tokenFrom(req)
    const ctx: OwnerCtx | null = token ? await getOwnerFromToken(token) : null

    if (action === "owner.auth.me") {
      if (!ctx) return NextResponse.json({ ok: false, error: "Not authenticated", code: 401 }, { status: 401 })
      const settings = await getSaasSettings()
      return NextResponse.json({
        ok: true,
        owner: { id: ctx.ownerId, name: ctx.name, email: ctx.email, roleKey: ctx.roleKey, permissions: [...ctx.permissions] },
        branding: {
          platformName: settings.general.platformName || "Finix HR",
          logoUrl: settings.general.logoUrl || "",
          appLogoUrl: settings.general.appLogoUrl || "",
          faviconUrl: settings.general.faviconUrl || "",
        },
        csrfToken: ctx.csrfToken,
      })
    }
    if (action === "owner.auth.logout") {
      if (token) await ownerLogout(token)
      const res = NextResponse.json({ ok: true })
      res.headers.append("Set-Cookie", ownerClearCookieStr())
      return res
    }

    if (!ctx) return NextResponse.json({ ok: false, error: "Not authenticated", code: 401 }, { status: 401 })

    // ---- CSRF echo for cookie-authenticated calls (Bearer exempt by construction) ----
    const bearer = req.headers.get("authorization")
    if (!bearer) {
      const echoed = req.headers.get("x-csrf-token") || ""
      if (!ctx.csrfToken || !echoed || !safeEqual(ctx.csrfToken, echoed)) {
        return NextResponse.json({ ok: false, error: "Invalid CSRF token", code: 403 }, { status: 403 })
      }
    }

    const def = ownerRoutes[action]
    if (!def) return NextResponse.json({ ok: false, error: "Unknown action", code: 404 }, { status: 404 })

    // permission gate
    if (def.perm && !ctx.permissions.has(def.perm)) {
      return NextResponse.json({ ok: false, error: `Permission denied: ${def.perm} is not granted to your role`, code: 403 }, { status: 403 })
    }

    // schema validation (zod, whitelist behavior)
    let typedPayload = payload
    if (def.schema) {
      const parsed = def.schema.safeParse(payload)
      if (!parsed.success) {
        const first = parsed.error.issues[0]
        const where = first?.path?.length ? ` (${first.path.join(".")})` : ""
        return NextResponse.json({ ok: false, error: `${first?.message || "Invalid input"}${where}`, code: 400 }, { status: 400 })
      }
      typedPayload = parsed.data
    }

    const out = await def.handler(ctx, typedPayload, req)
    return NextResponse.json({ ok: true, ...(out as any) })
  } catch (e: any) {
    if (typeof e?.message === "string" && Number.isFinite(e?.code) && e.code >= 400 && e.code < 500) {
      return NextResponse.json({ ok: false, error: e.message, code: e.code }, { status: e.code })
    }
    console.error("[api/owner] unexpected:", e)
    return NextResponse.json({ ok: false, error: "Unexpected server error. The issue was logged.", code: 500 }, { status: 500 })
  }
}

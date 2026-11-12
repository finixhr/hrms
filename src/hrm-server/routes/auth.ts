// ============ Auth routes ============
import crypto from "node:crypto"
import { db } from "@/lib/db"
import { route } from "./registry"
import { login, getCtxFromToken, changePassword, createSession, verifyPasswordAsync, findSessionByToken } from "../auth"
import { ROLE_LABELS, ROLE_TEMPLATES } from "../types"
import { getSettings } from "../settings"
import { callerFieldAccess } from "../field-permissions"
import { rateLimit, resolveClientIp, identityThrottleKey, safeEqual } from "../security"
import { audit } from "../audit"
import {
  generateTotpSecret, verifyTotpWithCounter, totpUri, encryptSecret, decryptSecret, needsReencrypt, mfaKeyConfigured,
  generateRecoveryCodes, hashCode, matchRecoveryCode,
} from "../totp"
import QRCode from "qrcode"

async function roleLabelFor(vendorId: string, role: string) {
  if (ROLE_LABELS[role]) return ROLE_LABELS[role]
  const custom = await db.role.findFirst({ where: { vendorId, key: role } })
  return custom?.name || role
}

/** AUDIT H-3 (2026-11-07) — display name of the tenant for security
 *  notification emails ("X — MFA enabled on your account"). Never throws;
 *  falls back to the product name. */
async function vendorNameFor(vendorId: string): Promise<string> {
  const v = await db.vendor.findUnique({ where: { id: vendorId }, select: { name: true } }).catch(() => null)
  return v?.name || "Finix HR"
}

/** M-2 — CSPRNG password-reset code: 8 chars from the 32-char
 * no-ambiguous alphabet. crypto.randomBytes(1) % 32 is unbiased
 * (256 % 32 === 0), so no rejection sampling is needed. Replaces
 * Math.random() (non-CSPRNG — the generator state is recoverable, and the
 * 8×log2(32)=40-bit code space was guessable from observed outputs). */
export function generateResetCode(): string {
  const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
  return Array.from(crypto.randomBytes(8), (b) => ALPHABET[b % ALPHABET.length]).join("")
}

/** AUDIT H-3 (2026-11-07) — CSPRNG 6-digit email OTP for first-login MFA
 * enrollment. Same discipline as generateResetCode; a digit is taken from a
 * full byte only when b < 250 (rejection sampling — 256 % 10 !== 0, so the
 * high values would bias the distribution toward digits 0-5). */
export function generateEnrollOtp(): string {
  const digits: number[] = []
  while (digits.length < 6) {
    for (const b of crypto.randomBytes(8)) {
      if (b < 250 && digits.length < 6) digits.push(b % 10)
    }
  }
  return digits.join("")
}

/** AUDIT H-3 (2026-11-07) — best-effort security notification email to the
 * account address (MFA enrolled/disabled, password changed/reset). Never
 * throws: a delivery failure must not fail the security operation itself;
 * the miss lands in the audit trail instead. */
async function notifyAccountEmail(
  vendorId: string,
  to: string,
  subject: string,
  body: string,
  auditCtx: { userId: string; userName: string; action: string; detail: string },
): Promise<void> {
  const { sendEmail } = await import("../gateway")
  const delivery = await sendEmail(vendorId, to, subject, body).catch(() => null)
  if (delivery?.status !== "SENT") {
    await audit(
      { userId: auditCtx.userId, userName: auditCtx.userName, vendorId },
      auditCtx.action, "User", auditCtx.userId,
      `${auditCtx.detail} (notification email not delivered: ${delivery?.detail || "gateway error"})`,
    ).catch(() => {})
  }
}

/** Session payload for a signed-in user. Exported since the passkey rail
 *  (routes/passkeys.ts) reuses it for auth.passkey.login.finish — the passkey
 *  promote path must return the EXACT same shape auth.mfa.verify does. */
export async function userPayload(user: any, vendor: any, permissions: string[], company?: {
  activeCompanyId?: string | null
  companies?: { companyId: string; code: string; name: string; role: string; isDefault: boolean }[]
  allCompaniesMode?: boolean
}) {
  // MULTI-COMPANY — settings resolve with the ACTIVE company's overrides
  // (CompanySetting layer) so the shell immediately reflects the switched
  // context (weekly holidays, payroll dates, OT rules…).
  const settings = await getSettings(vendor.id, { companyId: company?.activeCompanyId || undefined })
  const roleRow = await db.role.findFirst({ where: { vendorId: user.vendorId, key: user.role } })
  // R2 — linked employee's photo rides along with the session so the app
  // shell can render the tagged employee's picture as the user's avatar.
  // Prefers the small 96×96 thumbnail (photoThumb) when present.
  let employeePhotoUrl: string | null = null
  if (user.employeeId) {
    const linked = await db.employee.findUnique({
      where: { id: user.employeeId },
      select: { photoThumb: true, photoUrl: true },
    }).catch(() => null)
    employeePhotoUrl = linked?.photoThumb || linked?.photoUrl || null
  }
  // SaaS layer — subscription/entitlement snapshot for this tenant, resolved
  // server-side (never client-supplied). LEGACY tenants (no subscription row)
  // report mode LEGACY; the SPA uses this to hide gated modules and to badge
  // the subscription widget.
  let subscription: any = null
  try {
    const { resolveEntitlements, usageSnapshot } = await import("@/hrm-server/saas/entitlements")
    const ent = await resolveEntitlements(vendor.id)
    const usage = await usageSnapshot(vendor.id)
    subscription = {
      mode: ent.mode,
      status: ent.status,
      planName: ent.planName,
      billingCycle: ent.billingCycle,
      endDate: ent.endDate,
      daysRemaining: ent.daysRemaining,
      readonly: ent.readonly,
      features: ent.mode === "SUBSCRIBED" ? ent.features : null,
      limits: ent.mode === "SUBSCRIBED" ? ent.limits : null,
      // 2026-10 module-consistency round — expose per-tenant module overrides
      // (moduleKey → forced on/off) so the SPA can hide/show core modules the
      // owner toggled, mirroring the server-side featureBlocked() precedence.
      overrides: ent.overrides || {},
      usage,
    }
  } catch {
    subscription = null // SaaS layer unavailable — the tenant keeps working
  }
  return {
    token: null,
    user: {
      id: user.id, name: user.name, email: user.email, role: user.role,
      roleLabel: await roleLabelFor(vendor.id, user.role), employeeId: user.employeeId,
      branchId: user.branchId, departmentId: user.departmentId,
      employeePhotoUrl,
      permissions,
      // FLD-103 (Wave R3-5) — effective field-group access for the caller's
      // role (field layer; module-perm gating happens per-surface at read
      // time) so the SPA can disable form sections / render masks without
      // per-field logic of its own.
      fieldAccess: callerFieldAccess(settings, user.role),
      mfaEnrolled: !!user.mfaEnrolled,
      mfaRequired: roleRow?.mfaRequired === true,
    },
    vendor: { id: vendor.id, name: vendor.name, code: vendor.code, logoUrl: vendor.logoUrl },
    settings,
    subscription,
    // MULTI-COMPANY (2026-11-03) — the session's server-validated company
    // context + the caller's accessible companies (powers the switcher).
    // Settings are resolved for the ACTIVE company (getSettings with the
    // company id applies CompanySetting overrides).
    company: company ? {
      activeCompanyId: company.activeCompanyId ?? null,
      companies: company.companies || [],
      // All Companies REPORTING context (Part D) — the SPA badges the shell
      // and the switcher shows the mode as selected; the permission itself
      // is re-validated server-side on every request.
      allCompaniesMode: company.allCompaniesMode === true,
    } : undefined,
  }
}

  // INTENTIONALLY_PUBLIC (M-02): credential exchange: the password IS the authentication
route("auth.login", {
  public: true,
  handler: async (_ctx: any, p: any, req?: any) => {
    const { email, password, workspace } = p || {}
    // H-7 — spoof-proof IP resolution (XFF honored only behind a trusted proxy)
    const ip = resolveClientIp(req) || undefined
    const userAgent = req?.headers?.get?.("user-agent") || undefined
    // R16 — login audit: every SUCCESS and FAILURE leaves a row (identity,
    // IP, UA, derived browser/OS). Failures keep the same 401 surface — the
    // audit write is fire-and-forget and can never break the login path.
    const { recordLoginAudit } = await import("../login-audit")
    let out: any
    try {
      // AUDIT M-8 (2026-11-07) — `workspace` (vendor code) disambiguates an
      // email registered in several vendors once the password has proven.
      out = await login(email, password, ip, userAgent, typeof workspace === "string" ? workspace : undefined)
    } catch (e: any) {
      const reason =
        String(e?.code) === "429" ? "RATE_LIMITED" as const
        : String(e?.message || "").includes("Too many attempts") ? "RATE_LIMITED" as const
        : String(e?.code) === "403" ? "INACTIVE_VENDOR" as const
        : "INVALID_CREDENTIALS" as const
      // R16 — enrich the failure row with the account's identity when the
      // address resolves to exactly one ACTIVE user (server-side only; the
      // CLIENT response stays the same generic 401 — no account oracle).
      let failedIdentity: { userId?: string; userName?: string; vendorId?: string; vendorName?: string; role?: string } = {}
      try {
        const emailNorm = String(email || "").toLowerCase().trim()
        if (emailNorm) {
          const matches = await db.user.findMany({ where: { email: emailNorm, status: "ACTIVE" }, select: { id: true, name: true, vendorId: true, role: true } })
          if (matches.length === 1) {
            const m = matches[0]
            const v = await db.vendor.findUnique({ where: { id: m.vendorId }, select: { id: true, name: true } })
            failedIdentity = { userId: m.id, userName: m.name, vendorId: v?.id, vendorName: v?.name, role: m.role }
          }
        }
      } catch { /* identity enrichment is best-effort */ }
      await recordLoginAudit({
        plane: "TENANT", email: String(email || ""), success: false, failureReason: reason,
        ...failedIdentity,
        ip, userAgent,
      })
      throw e
    }
    // resolvable identity (never an account-existence oracle to the CLIENT —
    // the audit row is server-side only)
    const u = out?.user
    const v = out?.vendor
    // AUDIT M-8 (2026-11-07) — ambiguous email, password PROVEN: the client is
    // asked to pick the workspace. This is an intermediate step (no session,
    // no audit row — the completed login is audited when it finishes), and
    // the workspace list is only ever disclosed after password verification.
    if (out?.ambiguous) {
      return { workspaceRequired: true, workspaces: out.workspaces, user: { email: String(email || "").toLowerCase().trim() } }
    }
    if (out.mfaEnrollmentRequired || out.mfaRequired) {
      // password verified; the session completes at the second factor
      await recordLoginAudit({
        plane: "TENANT", email: String(email || ""), success: false, failureReason: "MFA_FAILED",
        userId: u?.id, userName: u?.name, vendorId: v?.id, vendorName: v?.name, role: u?.role,
        mfaUsed: true, ip, userAgent,
      })
    } else {
      await recordLoginAudit({
        plane: "TENANT", email: String(email || ""), success: true,
        userId: u?.id, userName: u?.name, vendorId: v?.id, vendorName: v?.name, role: u?.role,
        ip, userAgent,
      })
    }
    if (out.mfaEnrollmentRequired) {
      // H-1 — role requires MFA but the user never enrolled: no full session.
      // The client swaps to the first-login enrollment wizard (QR + code) and
      // completes it via auth.mfa.enroll.start / .enable, which promote to a
      // FULL session only after a valid TOTP code is proven.
      return { mfaEnrollmentRequired: true, enrollToken: out.enrollToken, user: { email: out.user.email, name: out.user.name } }
    }
    if (out.mfaRequired) {
      // second factor needed — the client swaps to the TOTP step
      return { mfaRequired: true, mfaToken: out.mfaToken, user: { email: out.user.email, name: out.user.name } }
    }
    if (out.passwordExpired) {
      return { passwordExpired: true, mustChangePassword: !!(out as any).mustChangePassword, pwToken: out.pwToken, user: { email: out.user.email, name: out.user.name } }
    }
    const ctx = await getCtxFromToken(out.token)
    const payload = await userPayload(out.user, out.vendor, ctx ? Array.from(ctx.permissions) : [], ctx ? { activeCompanyId: ctx.activeCompanyId, companies: ctx.companyAccess, allCompaniesMode: ctx.allCompaniesMode } : undefined)
    // HRM-006 — role requires MFA but the user has not enrolled yet: nudge once
    const mfaEnrollSuggested = !!(out as any).mfaEnrollSuggested
    // C-4 — hand the SPA its CSRF token with the session it just received
    if (out.mfaToken && !out.token) (payload as any).csrfToken = (await findSessionByToken(out.mfaToken))?.csrfToken || null
    else (payload as any).csrfToken = ctx?.csrfToken || null
    // M-4 — auth lifecycle audit: sign-ins leave a trail (was: zero rows for login)
    await audit({ userId: out.user.id, userName: out.user.name, vendorId: out.vendor.id, ip }, "auth.login", "User", out.user.id, "Signed in (password verified)")
    return { ...payload, token: out.token, ...(mfaEnrollSuggested ? { mfaEnrollSuggested } : {}) }
  },
} as any)

// ---------- HRM-006 — MFA second-factor verification (login step) ----------
  // INTENTIONALLY_PUBLIC (M-02): completes login with the second factor — unauthenticated by design
route("auth.mfa.verify", {
  public: true,
  handler: async (_ctx, p, req?: any) => {
    const { mfaToken, code, useRecovery } = p || {}
    // R16 — login audit context (IP + UA at the second factor)
    const ip = resolveClientIp(req) || undefined
    const userAgent = req?.headers?.get?.("user-agent") || undefined
    const { recordLoginAudit } = await import("../login-audit")
    if (!mfaToken || !code) throw Object.assign(new Error("MFA token and code are required"), { code: 400 })
    // M-16 — throttle the second-factor guess surface per challenge token
    if (await rateLimit(`mfa:${String(mfaToken).slice(0, 16)}`, 10, 5 * 60_000)) {
      await recordLoginAudit({ plane: "TENANT", email: "", success: false, failureReason: "RATE_LIMITED", mfaUsed: true, ip, userAgent })
      throw Object.assign(new Error("Too many verification attempts — sign in again"), { code: 429 })
    }
    const session = await findSessionByToken(mfaToken)
    // AUDIT H-2 (2026-11-07) — the challenge must be an MFA_CHALLENGE row
    // minted by login() for exactly this purpose. The old check was a
    // lifetime HEURISTIC ("anything younger than 6 minutes passes"), so a
    // PWCHANGE or MFA_ENROLL capability could have been replayed here as a
    // second-factor proof.
    if (!session || session.kind !== "MFA_CHALLENGE" || session.expiresAt < new Date()) {
      throw Object.assign(new Error("MFA challenge expired — sign in again"), { code: 401 })
    }
    const user = session.user
    if (user.status !== "ACTIVE") throw Object.assign(new Error("Account disabled"), { code: 403 })

    const mfa = await db.userMfaSecret.findUnique({ where: { userId: user.id } })
    if (!mfa) throw Object.assign(new Error("MFA is not enrolled for this account"), { code: 400 })

    let ok = false
    let consumedRecoveryHash: string | null = null
    if (useRecovery) {
      const target = hashCode(String(code))
      if (matchRecoveryCode(String(code), mfa.recoveryCodesHash)) {
        ok = true
        consumedRecoveryHash = target
      }
    } else {
      // M-16 — replay protection: a counter at-or-before the last accepted one is rejected
      const res = verifyTotpWithCounter(decryptSecret(mfa.secretEnc), String(code))
      ok = res.ok && res.counter > (mfa.lastUsedCounter ?? 0)
      if (ok) {
        await db.userMfaSecret.update({ where: { id: mfa.id }, data: { lastUsedCounter: res.counter } })
      }
    }
    if (!ok) {
      // R16 — failed second factor
      const vendorRow = await db.vendor.findUnique({ where: { id: user.vendorId }, select: { id: true, name: true } }).catch(() => null)
      await recordLoginAudit({
        plane: "TENANT", email: user.email, success: false, failureReason: "MFA_FAILED",
        userId: user.id, userName: user.name, vendorId: vendorRow?.id, vendorName: vendorRow?.name, role: user.role,
        mfaUsed: true, ip, userAgent,
      })
      throw Object.assign(new Error("Invalid verification code"), { code: 401 })
    }

    // H-8 — transparent migration: re-encrypt legacy-key secrets under the env key
    if (needsReencrypt(mfa.secretEnc)) {
      try {
        await db.userMfaSecret.update({ where: { id: mfa.id }, data: { secretEnc: encryptSecret(decryptSecret(mfa.secretEnc)) } })
      } catch { /* migration is best-effort — verification already succeeded */ }
    }

    if (consumedRecoveryHash) {
      // AUDIT L-6 (2026-11-07) — single-use burn is now a CONDITIONAL claim
      // (compare-and-set on the exact stored JSON). The old read-modify-write
      // let two concurrent verifications with the same recovery code BOTH
      // succeed (both read the full list, both wrote it back minus one code).
      // updateMany matches only while the row still holds the snapshot we
      // verified against; a concurrent consumer wins and this attempt fails
      // closed with the same invalid-code error as a wrong code.
      const rest = (JSON.parse(mfa.recoveryCodesHash || "[]") as string[]).filter((h) => h !== consumedRecoveryHash)
      const claim = await db.userMfaSecret.updateMany({
        where: { id: mfa.id, recoveryCodesHash: mfa.recoveryCodesHash },
        data: { recoveryCodesHash: JSON.stringify(rest) },
      })
      if (claim.count === 0) {
        throw Object.assign(new Error("Invalid verification code"), { code: 401 })
      }
    }

    const vendor = await db.vendor.findUnique({ where: { id: user.vendorId } })
    if (!vendor || !vendor.active) throw Object.assign(new Error("Vendor inactive"), { code: 403 })

    // promote: drop the 5-minute pre-auth session, mint a full one
    await db.session.delete({ where: { id: session.id } }).catch(() => {})
    const { token } = await createSession(user)
    const ctx = await getCtxFromToken(token)
    const payload = await userPayload(user, vendor, ctx ? Array.from(ctx.permissions) : [], ctx ? { activeCompanyId: ctx.activeCompanyId, companies: ctx.companyAccess, allCompaniesMode: ctx.allCompaniesMode } : undefined)
    // M-4 — auth lifecycle audit: MFA-completed sign-ins leave a trail
    await audit({ userId: user.id, userName: user.name, vendorId: user.vendorId }, "auth.login", "User", user.id, "Signed in (MFA second factor verified)")
    // R16 — successful MFA login
    await recordLoginAudit({
      plane: "TENANT", email: user.email, success: true,
      userId: user.id, userName: user.name, vendorId: vendor.id, vendorName: vendor.name, role: user.role,
      mfaUsed: true, ip, userAgent,
    })
    return { ...payload, token, csrfToken: ctx?.csrfToken || null }
  },
})

// ---------- H-1 — first-login MFA enrollment (role requires MFA, user unenrolled) ----------
// Capability-gated EXACTLY like auth.mfa.verify: knowledge of the 256-bit
// PREAUTH enrollToken (issued only after the password verified) IS the
// authentication. These routes exist so the enrollment gate can never lock
// anyone out: a valid password always suffices to self-enroll.
  // INTENTIONALLY_PUBLIC (M-02): pre-auth flow — the enrollToken capability (proof of password) is the auth
route("auth.mfa.enroll.start", {
  public: true,
  handler: async (_ctx, p) => {
    const enrollToken = String(p?.enrollToken || "")
    if (!enrollToken) throw Object.assign(new Error("Enrollment token is required"), { code: 400 })
    if (await rateLimit(`mfa-enroll:${enrollToken.slice(0, 16)}`, 10, 15 * 60_000)) {
      throw Object.assign(new Error("Too many attempts — sign in again"), { code: 429 })
    }
    const session = await findSessionByToken(enrollToken)
    // AUDIT H-2 (2026-11-07) — exact purpose assertion: only an MFA_ENROLL
    // row (minted by login() when the role requires MFA and the account is
    // unenrolled) opens the enrollment window. A PWCHANGE or MFA_CHALLENGE
    // capability must never start an enrollment.
    if (!session || session.kind !== "MFA_ENROLL" || session.expiresAt < new Date()) {
      throw Object.assign(new Error("Enrollment window expired — sign in again"), { code: 401 })
    }
    const user = session.user
    if (user.status !== "ACTIVE") throw Object.assign(new Error("Account disabled"), { code: 403 })
    // FIRST-LOGIN ONLY: an already-enrolled account must not be re-enrolled
    // with a password alone — that would let a stolen password replace the
    // victim's second factor (factor-replacement attack).
    if (user.mfaEnrolled) {
      throw Object.assign(new Error("MFA is already enabled for this account — sign in and manage it under Security & MFA"), { code: 400 })
    }
    // H-8 — fail closed: no new secrets may be stored without the deployment key
    if (!mfaKeyConfigured()) {
      throw Object.assign(new Error("MFA cannot be enrolled because the server encryption key (HRM_MFA_KEY) is not configured — ask your administrator to set it"), { code: 500 })
    }
    const secret = generateTotpSecret()
    const vendor = await db.vendor.findUnique({ where: { id: user.vendorId } })
    const uri = totpUri(secret, user.email, vendor?.name || "Finix HR")
    const qrDataUrl = await QRCode.toDataURL(uri, { width: 220, margin: 1 })
    // persist the candidate secret (inert until verified + enabled)
    const existing = await db.userMfaSecret.findUnique({ where: { userId: user.id } })
    if (existing) {
      await db.userMfaSecret.update({ where: { id: existing.id }, data: { secretEnc: encryptSecret(secret), recoveryCodesHash: "[]", enrolledAt: new Date() } })
    } else {
      await db.userMfaSecret.create({ data: { vendorId: user.vendorId, userId: user.id, secretEnc: encryptSecret(secret), recoveryCodesHash: "[]" } })
    }
    // ---- AUDIT H-3 (2026-11-07) — out-of-band proof for first enrollment ----
    // Knowledge of the password alone (the enrollToken proves exactly that)
    // must no longer be enough to bind an authenticator on an MFA-required
    // role: accounts are created with temporary/emailed passwords, and
    // "whoever enrolls first wins" handed the account to anyone who learned
    // one. When the tenant email gateway is configured, a one-time 6-digit
    // code is emailed to the account address and MUST be echoed in
    // auth.mfa.enroll.enable. When the gateway is NOT configured the flow
    // stays password-only (the documented never-lockout property — such
    // tenants also cannot have emailed the temporary password).
    let otpRequired = false
    const { emailConfigured } = await import("../gateway")
    const gatewayUp = await emailConfigured(user.vendorId).catch(() => false)
    if (gatewayUp) {
      const otp = generateEnrollOtp()
      const otpHash = crypto.createHash("sha256").update(otp).digest("hex")
      const mfaRow = await db.userMfaSecret.findUnique({ where: { userId: user.id } })
      if (mfaRow) {
        await db.userMfaSecret.update({
          where: { id: mfaRow.id },
          data: { enrollOtpHash: otpHash, enrollOtpExpiresAt: new Date(Date.now() + 15 * 60_000) },
        })
      }
      const { sendEmail } = await import("../gateway")
      const company = vendor?.name || "Finix HR"
      const delivery = await sendEmail(
        user.vendorId, user.email,
        `${company} — confirm MFA enrollment`,
        [
          `Hello ${user.name},`,
          ``,
          `A first-time multi-factor (MFA) enrollment was started for your ${company} account (${user.email}).`,
          `Your one-time confirmation code is: ${otp}`,
          ``,
          `Enter this code together with the 6-digit code from your authenticator app to finish enabling MFA.`,
          `The code is valid for 15 minutes and can be used only once.`,
          ``,
          `If you did NOT start this enrollment, someone else may know your password — change it immediately (Sign in → Forgot password).`,
        ].join("\n"),
      )
      if (delivery.status !== "SENT") {
        // fail closed while email is configured: an enrollment the account
        // owner cannot confirm must not silently drop its out-of-band proof
        await audit({ userId: user.id, userName: user.name, vendorId: user.vendorId }, "auth.mfa.enroll.start", "User", user.id,
          `Enrollment OTP email failed to send (${delivery.detail}) — enrollment blocked until the gateway delivers`)
        throw Object.assign(new Error("The confirmation-code email could not be sent — check with your administrator, then sign in again to retry"), { code: 502 })
      }
      otpRequired = true
    }
    return { secret, qrDataUrl, uri, ...(otpRequired ? { otpRequired: true, otpHint: `We sent a 6-digit confirmation code to ${user.email}. Enter it below together with the code from your authenticator app.` } : {}) }
  },
})

  // INTENTIONALLY_PUBLIC (M-02): completes first-login enrollment — the enrollToken capability + a valid TOTP code are the auth
route("auth.mfa.enroll.enable", {
  public: true,
  handler: async (_ctx, p) => {
    const { enrollToken, code, otp } = p || {}
    if (!enrollToken || !code) throw Object.assign(new Error("Enrollment token and code are required"), { code: 400 })
    if (await rateLimit(`mfa-enroll:${String(enrollToken).slice(0, 16)}`, 10, 15 * 60_000)) {
      throw Object.assign(new Error("Too many attempts — sign in again"), { code: 429 })
    }
    const session = await findSessionByToken(enrollToken)
    // AUDIT H-2 (2026-11-07) — exact purpose assertion (see enroll.start).
    if (!session || session.kind !== "MFA_ENROLL" || session.expiresAt < new Date()) {
      throw Object.assign(new Error("Enrollment window expired — sign in again"), { code: 401 })
    }
    const user = session.user
    if (user.status !== "ACTIVE") throw Object.assign(new Error("Account disabled"), { code: 403 })
    if (user.mfaEnrolled) {
      throw Object.assign(new Error("MFA is already enabled for this account"), { code: 400 })
    }
    const mfa = await db.userMfaSecret.findUnique({ where: { userId: user.id } })
    if (!mfa) throw Object.assign(new Error("Start MFA enrolment first"), { code: 400 })
    // ---- AUDIT H-3 (2026-11-07) — consume the emailed enrollment OTP ----
    // When enroll.start stored one (email gateway configured), the echoed
    // `otp` must match its sha-256 digest, be unexpired, and is burned by a
    // CONDITIONAL claim (compare-and-set — a concurrent replay of the same
    // code fails closed exactly like the L-6 recovery-code burn). Without a
    // stored OTP (gateway unconfigured at start time) the flow proceeds —
    // the never-lockout compatibility rule.
    if (mfa.enrollOtpHash) {
      if (!otp || typeof otp !== "string") {
        throw Object.assign(new Error("Enter the 6-digit confirmation code we emailed to your account address"), { code: 400 })
      }
      if (!mfa.enrollOtpExpiresAt || mfa.enrollOtpExpiresAt < new Date()) {
        throw Object.assign(new Error("Your emailed confirmation code has expired — sign in again to restart enrollment"), { code: 401 })
      }
      const supplied = crypto.createHash("sha256").update(String(otp).trim()).digest("hex")
      if (!safeEqual(mfa.enrollOtpHash, supplied)) {
        throw Object.assign(new Error("The emailed confirmation code is incorrect — check your inbox and try again"), { code: 401 })
      }
      const claim = await db.userMfaSecret.updateMany({
        where: { id: mfa.id, enrollOtpHash: mfa.enrollOtpHash },
        data: { enrollOtpHash: null, enrollOtpExpiresAt: null },
      })
      if (claim.count === 0) {
        throw Object.assign(new Error("This confirmation code was already used — sign in again to restart enrollment"), { code: 401 })
      }
    }
    const res = verifyTotpWithCounter(decryptSecret(mfa.secretEnc), String(code))
    if (!res.ok || res.counter <= (mfa.lastUsedCounter ?? 0)) {
      throw Object.assign(new Error("That code did not match — check your authenticator app and try again"), { code: 400 })
    }
    await db.userMfaSecret.update({ where: { id: mfa.id }, data: { lastUsedCounter: res.counter } })
    const codes = generateRecoveryCodes()
    await db.userMfaSecret.update({
      where: { id: mfa.id },
      data: { recoveryCodesHash: JSON.stringify(codes.map((c) => hashCode(c))), enrolledAt: new Date() },
    })
    await db.user.update({ where: { id: user.id }, data: { mfaEnrolled: true } })
    await audit({ userId: user.id, userName: user.name, vendorId: user.vendorId }, "auth.mfa.enroll", "User", user.id,
      "First-login MFA enrollment completed (role requires MFA)")
    // AUDIT H-3 — alert the account owner (best-effort): if this was NOT the
    // owner, they learn their password is compromised while they can still
    // recover through Forgot password + this mailbox.
    void notifyAccountEmail(user.vendorId, user.email, `${vendorNameFor(user.vendorId)} — MFA enabled on your account`,
      `Multi-factor authentication (TOTP) was just enabled on your account (${user.email}) during first-login enrollment.\n\nIf this was you, no action is needed. If you did NOT expect this, someone else may know your password — reset it immediately from the sign-in page (Forgot password).`,
      { userId: user.id, userName: user.name, action: "auth.mfa.enroll", detail: "MFA enrollment completed" })

    // promote: drop the enrollment challenge, mint a FULL session — the
    // second factor now exists and was just proven (mirrors auth.mfa.verify)
    await db.session.delete({ where: { id: session.id } }).catch(() => {})
    const { token } = await createSession(user)
    const ctx = await getCtxFromToken(token)
    const vendor = await db.vendor.findUnique({ where: { id: user.vendorId } })
    if (!vendor) throw Object.assign(new Error("Vendor inactive"), { code: 403 })
    const payload = await userPayload(user, vendor, ctx ? Array.from(ctx.permissions) : [], ctx ? { activeCompanyId: ctx.activeCompanyId, companies: ctx.companyAccess, allCompaniesMode: ctx.allCompaniesMode } : undefined)
    return { ...payload, token, recoveryCodes: codes, csrfToken: ctx?.csrfToken || null } // recovery codes shown exactly once
  },
})

// ---------- HRM-007 — password change (self, or forced after expiry) ----------
// ---------- Forgot password / self-service reset (login screen) ----------
// Flow: auth.forgotPassword(email) → 8-character code emailed (60-minute
// validity) → auth.resetPassword(email, code, newPassword) → all sessions
// revoked. Responses never reveal whether the account exists (no enumeration);
// the code is stored as a sha-256 digest so a DB leak cannot mint codes.
  // INTENTIONALLY_PUBLIC (M-02): pre-auth flow: sends a reset token to the account email
route("auth.forgotPassword", {
  public: true,
  handler: async (_ctx: any, p: any, req?: any) => {
    const email = String(p?.email || "").trim().toLowerCase()
    // H-7 — spoof-proof IP resolution; throttle keys on email alone when unknown
    const ip = resolveClientIp(req)
    if (!email) throw Object.assign(new Error("Enter your account email"), { code: 400 })
    // brute-force guard: 5 requests per 15 minutes per IP (email-bound when
    // the IP is unknown — a rotating spoofed XFF cannot mint fresh buckets)
    if (await rateLimit(identityThrottleKey("forgot", email, ip), 5, 15 * 60 * 1000)) {
      throw Object.assign(new Error("Too many reset requests — try again in 15 minutes"), { code: 429 })
    }

    // L-2 — the response must not depend on whether the email exists.
    // Probe the (global) gateway configuration once, up front; known and
    // unknown emails then get byte-identical response shapes.
    const { emailConfigured } = await import("../gateway")
    const gatewayConfigured = await emailConfigured("gateway-probe").catch(() => false)
    const resetSentResponse = (em: string) => ({
      ok: true as const, delivery: "email",
      hint: `If ${em} is registered, a reset code has been sent. It is valid for 60 minutes.`,
    })
    const resetUnconfiguredResponse = () => ({
      ok: true as const, delivery: "email_unconfigured",
      hint: "The email gateway is not configured on this server — ask an HR administrator to set a new password for you from Settings → Users & Security (or configure email in Settings → Email & SMS).",
    })

    // look in every vendor — the login screen is vendor-agnostic.
    // AUDIT M-8 (2026-11-07) — the SAME code is stamped on EVERY active
    // account carrying this email (they share one inbox). The old
    // `findFirst` reset an ARBITRARY account: a user whose email exists in
    // two tenants could neither log in (ambiguity refusal) nor reliably
    // reset (the wrong account got the code) — a functional lockout. All
    // matching accounts are listed by workspace name in the email, and
    // auth.resetPassword rotates every account the code unlocks; login then
    // disambiguates by workspace after the password is proven.
    const users = await db.user.findMany({ where: { email, status: "ACTIVE" } })
    if (users.length) {
      const code = generateResetCode()
      const tokenHash = crypto.createHash("sha256").update(code).digest("hex")
      await db.user.updateMany({
        where: { id: { in: users.map((x) => x.id) } },
        data: { passwordResetToken: tokenHash, passwordResetExpiresAt: new Date(Date.now() + 60 * 60 * 1000), passwordResetRequestedAt: new Date() },
      })
      const user = users[0]
      const vendorRows = await db.vendor.findMany({ where: { id: { in: users.map((x) => x.vendorId) } }, select: { id: true, name: true } })
      const workspaceNames = vendorRows.map((vr) => vr.name).filter(Boolean)
      const settings = await getSettings(user.vendorId)
      const g: any = settings.general || {}
      const company = g.companyName || vendorRows.find((vr) => vr.id === user.vendorId)?.name || "HRM"
      const { sendEmail } = await import("../gateway")
      // HR Settings → Communication → Automation (password_reset event): the
      // admin may disable self-service reset emails — the honest fallback
      // directs the user to an administrator-assisted reset.
      const { eventChannels } = await import("../delivery")
      const resetCh = eventChannels(settings, "password_reset", { email: true })
      if (!resetCh.email) {
        await audit({ userId: user.id, userName: user.name, vendorId: user.vendorId, ip: ip ?? undefined }, "auth.forgotPassword", "User", user.id,
          "Password reset code NOT emailed — password_reset emails are disabled in Communication settings")
        return {
          ok: true as const, delivery: "email_disabled",
          hint: "Self-service password reset emails are turned off for your organization. Ask an HR administrator to reset your password (Employee Directory → ⋮ → Reset Login Password).",
        }
      }
      // 2026-10 restructure — render from the password_reset system template
      // when the tenant edited one; the built-in fallback keeps the historical
      // wording (which itself documents the 60-minute validity).
      const { effectiveMessageTemplate, renderMessageTemplate } = await import("../message-templates")
      const tpl = effectiveMessageTemplate((settings as any).messageTemplates, "password_reset")
      const rvars = { name: user.name, company, code, minutes: 60 }
      const hasEdit = !!((settings as any).messageTemplates?.password_reset?.emailBody || "").trim()
      const subject = renderMessageTemplate(tpl?.emailSubject || "", rvars) || `${company} — password reset code`
      const body = hasEdit
        ? renderMessageTemplate(tpl?.emailBody || "", rvars)
        : [
            `Hello ${user.name},`,
            ``,
            `A password reset was requested for your ${company} HR account (${email}).`,
            ...(workspaceNames.length > 1
              ? [`This email address is registered on ${workspaceNames.length} workspaces (${workspaceNames.join(", ")}) — the code below resets the password for ALL of them; after resetting, sign in and pick the workspace you need.`]
              : []),
            `Your one-time reset code is: ${code}`,
            ``,
            `The code is valid for 60 minutes. If you did not request this, you can ignore this email — your password stays unchanged.`,
          ].join("\n")
      const delivery = await sendEmail(user.vendorId, email, subject, body)
      const sent = delivery.status === "SENT"
      await audit({ userId: user.id, userName: user.name, vendorId: user.vendorId, ip: ip ?? undefined }, "auth.forgotPassword", "User", user.id,
        `Password reset code ${sent ? "emailed" : "requested but email gateway is not configured (" + delivery.detail + ")"}${users.length > 1 ? ` — code stamped on all ${users.length} accounts sharing this email` : ""}`)
      // L-2 — the unconfigured-gateway branch previously appeared ONLY for
      // registered addresses — a free account-existence oracle. The gateway
      // state is global, so it is now reported uniformly for any email.
      return sent ? resetSentResponse(email) : resetUnconfiguredResponse()
    }
    // unknown email — identical response shape (L-2)
    return gatewayConfigured ? resetSentResponse(email) : resetUnconfiguredResponse()
  },
} as any)

  // INTENTIONALLY_PUBLIC (M-02): consumes the single-use reset token (capability IS the auth)
route("auth.resetPassword", {
  public: true,
  handler: async (_ctx: any, p: any, req?: any) => {
    const email = String(p?.email || "").trim().toLowerCase()
    const code = String(p?.code || "").trim().toUpperCase()
    const newPassword = String(p?.newPassword || "")
    // H-7 — spoof-proof IP resolution; throttle keys on email alone when unknown
    const ip = resolveClientIp(req)
    if (!email || !code) throw Object.assign(new Error("Email and reset code are required"), { code: 400 })
    if (!newPassword) throw Object.assign(new Error("Enter a new password"), { code: 400 })
    // code brute-force guard: 10 attempts per 15 minutes per IP (email-bound
    // when the IP is unknown — rotating XFF cannot bypass the code guess limit)
    if (await rateLimit(identityThrottleKey("reset", email, ip), 10, 15 * 60 * 1000)) {
      throw Object.assign(new Error("Too many attempts — try again in 15 minutes"), { code: 429 })
    }

    const tokenHash = crypto.createHash("sha256").update(code).digest("hex")
    const users = await db.user.findMany({ where: { email, status: "ACTIVE" } })
    // M-2 — timing-safe digest comparison (sha256 hex is always 64 chars);
    // the previous === compare leaked match position timing on the shared
    // email across vendors
    // AUDIT M-8 (2026-11-07) — EVERY account carrying the matching code is
    // rotated (the code was stamped on all of them in auth.forgotPassword):
    // a shared email across vendors is no longer a functional lockout. Each
    // rotation revokes that account's sessions; the notification email goes
    // to the shared address once.
    const matched = users.filter((x) => !!x.passwordResetToken && x.passwordResetToken.length === 64 && safeEqual(x.passwordResetToken, tokenHash))
    const user = matched[0]
    if (!user) throw Object.assign(new Error("Invalid reset code"), { code: 400 })
    if (!user.passwordResetExpiresAt || user.passwordResetExpiresAt < new Date()) {
      throw Object.assign(new Error("This reset code has expired — request a new one"), { code: 400 })
    }

    for (const u of matched) {
      if (!u.passwordResetExpiresAt || u.passwordResetExpiresAt < new Date()) continue
      await changePassword(u.id, newPassword)
      // burn the code and revoke every session (credentials changed)
      await db.user.update({
        where: { id: u.id },
        data: { passwordResetToken: null, passwordResetExpiresAt: null, passwordResetRequestedAt: null },
      })
      await db.session.deleteMany({ where: { userId: u.id } })
      await audit({ userId: u.id, userName: u.name, vendorId: u.vendorId, ip: ip ?? undefined }, "auth.resetPassword", "User", u.id,
        `Password reset via emailed code — all sessions revoked${matched.length > 1 ? ` (email shared across ${matched.length} workspaces — every matching account was rotated)` : ""}`)
    }
    // AUDIT H-3 — alert the account owner (best-effort) so a fraudulent
    // reset (someone else reading the mailbox) surfaces immediately.
    void notifyAccountEmail(user.vendorId, user.email, `${await vendorNameFor(user.vendorId)} — your password was reset`,
      `The password of your account (${user.email}) was just reset with an emailed code, and every active session was signed out.${matched.length > 1 ? `\n\nThis email address is registered on ${matched.length} workspaces — the password was reset for ALL of them; sign in and pick the workspace you need.` : ""}\n\nIf this was you, no action is needed. If you did NOT request this reset, contact your administrator immediately.`,
      { userId: user.id, userName: user.name, action: "auth.resetPassword", detail: "Password reset via emailed code — owner notified" })
    return { reset: true }
  },
} as any)

  // INTENTIONALLY_PUBLIC (M-02): authenticated by the old password in the payload itself
route("auth.password.change", {
  public: true, // authorized by session OR pre-auth pwToken below
  handler: async (ctx, p) => {
    const { currentPassword, newPassword, pwToken } = p || {}
    let userId = ctx?.userId || null

    if (!userId && pwToken) {
      // forced-change flow after password expiry (R2a-003 / D1-003)
      // AUDIT H-2 (2026-11-07) — ONLY a PWCHANGE session may serve as a
      // pwToken. The old rule excluded just FULL, so the 5-minute MFA
      // challenge token and the 15-minute enrollment token (both PREAUTH)
      // worked as password-change capabilities: a password-only attacker on
      // an MFA-enrolled account could rotate the password and revoke every
      // session of the real user. Challenge kinds are now disjoint
      // (PWCHANGE / MFA_CHALLENGE / MFA_ENROLL — see auth.ts), and only the
      // one minted by the expiry / mustChangePassword branches is accepted.
      const session = await findSessionByToken(pwToken)
      if (!session || session.expiresAt < new Date()) throw Object.assign(new Error("Reset window expired — sign in again"), { code: 401 })
      if (session.kind !== "PWCHANGE") throw Object.assign(new Error("Invalid password-reset token"), { code: 401 })
      userId = session.userId
      await db.session.delete({ where: { id: session.id } }).catch(() => {})
    }
    if (!userId) throw Object.assign(new Error("Authentication required"), { code: 401 })

    const user = await db.user.findUnique({ where: { id: userId } })
    if (!user) throw Object.assign(new Error("User not found"), { code: 404 })

    if (!pwToken) {
      // self-service flow — current password must match
      if (!currentPassword || !(await verifyPasswordAsync(currentPassword, user.passwordHash))) {
        throw Object.assign(new Error("Current password is incorrect"), { code: 401 })
      }
    }
    await changePassword(userId, newPassword)
    // credentials changed — revoke every session so users re-authenticate everywhere
    await db.session.deleteMany({ where: { userId } })
    // M-4 — auth lifecycle audit: password changes leave a trail
    await audit({ userId, userName: user.name, vendorId: user.vendorId }, "auth.password.change", "User", userId, `Password changed (${pwToken ? "forced-expiry flow" : "self-service"}) — all sessions revoked`)
    // AUDIT H-3 — alert the account owner (best-effort): the owner learns a
    // rotation happened even when the attacker rotated it through the forced
    // window, and can recover via Forgot password.
    void notifyAccountEmail(user.vendorId, user.email, `${await vendorNameFor(user.vendorId)} — your password was changed`,
      `The password of your account (${user.email}) was just changed (${pwToken ? "forced first-login/expiry rotation" : "self-service change"}), and every active session was signed out.\n\nIf this was you, no action is needed. If you did NOT change it, reset it immediately from the sign-in page (Forgot password) and contact your administrator.`,
      { userId, userName: user.name, action: "auth.password.change", detail: "Password changed — owner notified" })
    return { changed: true }
  },
})

  // INTENTIONALLY_PUBLIC (M-02): public password-strength rules shown on the login screen
route("auth.password.policy", {
  public: true,
  handler: async (ctx) => {
    // GAP-309 — the tenant's policy only for a caller who already belongs to it.
    // Looking it up from a typed email answered "is this address registered?" for
    // anyone whose tenant policy differs from the default (the web client never
    // sent an email anyway). Everyone else gets the generic hints.
    if (ctx?.vendorId) {
      const s = await getSettings(ctx.vendorId)
      return { policy: s.passwordPolicy }
    }
    return { policy: { minLength: 8, requireUpper: true, requireLower: true, requireDigit: true, requireSymbol: false, expiryDays: 0, historyCount: 0, lockoutThreshold: 5, lockoutMinutes: 15 } }
  },
})

// ---------- HRM-006 — MFA enrolment (authenticated self-service) ----------
  // INTENTIONALLY_SELF_SCOPED (M-02): identity-bound: returns the caller's own MFA enrollment state
route("auth.mfa.status", {
  handler: async (ctx) => {
    const mfa = await db.userMfaSecret.findUnique({ where: { userId: ctx.userId } })
    const roleRow = await db.role.findFirst({ where: { vendorId: ctx.vendorId, key: ctx.role } })
    const recoveryLeft = mfa ? (JSON.parse(mfa.recoveryCodesHash || "[]") as string[]).length : 0
    return { enrolled: !!mfa && !!(await db.user.findUnique({ where: { id: ctx.userId } }))?.mfaEnrolled, roleRequires: roleRow?.mfaRequired === true, recoveryCodesLeft: recoveryLeft }
  },
})

  // INTENTIONALLY_SELF_SCOPED (M-02): identity-bound: begins the caller's own TOTP enrollment (requires session)
route("auth.mfa.start", {
  handler: async (ctx) => {
    const user = await db.user.findUnique({ where: { id: ctx.userId } })
    if (!user) throw Object.assign(new Error("User not found"), { code: 404 })
    if (user.mfaEnrolled) throw Object.assign(new Error("MFA is already enabled — disable it first to re-enrol"), { code: 400 })
    // H-8 — fail closed: no new secrets may be stored without the deployment key
    if (!mfaKeyConfigured()) {
      throw Object.assign(new Error("MFA cannot be enrolled because the server encryption key (HRM_MFA_KEY) is not configured — ask your administrator to set it"), { code: 500 })
    }
    const secret = generateTotpSecret()
    const vendor = await db.vendor.findUnique({ where: { id: ctx.vendorId } })
    const uri = totpUri(secret, user.email, vendor?.name || "Finix HR")
    const qrDataUrl = await QRCode.toDataURL(uri, { width: 220, margin: 1 })
    // persist the candidate secret (inert until verified + enabled)
    const existing = await db.userMfaSecret.findUnique({ where: { userId: ctx.userId } })
    if (existing) {
      await db.userMfaSecret.update({ where: { id: existing.id }, data: { secretEnc: encryptSecret(secret), recoveryCodesHash: "[]", enrolledAt: new Date() } })
    } else {
      await db.userMfaSecret.create({ data: { vendorId: ctx.vendorId, userId: ctx.userId, secretEnc: encryptSecret(secret), recoveryCodesHash: "[]" } })
    }
    return { secret, qrDataUrl, uri }
  },
})

  // INTENTIONALLY_SELF_SCOPED (M-02): identity-bound: completes the caller's own enrollment (needs the totp code)
route("auth.mfa.enable", {
  handler: async (ctx, p) => {
    const user = await db.user.findUnique({ where: { id: ctx.userId } })
    if (!user) throw Object.assign(new Error("User not found"), { code: 404 })
    const mfa = await db.userMfaSecret.findUnique({ where: { userId: ctx.userId } })
    if (!mfa) throw Object.assign(new Error("Start MFA enrolment first"), { code: 400 })
    const res = verifyTotpWithCounter(decryptSecret(mfa.secretEnc), String(p?.code || ""))
    if (!res.ok || res.counter <= (mfa.lastUsedCounter ?? 0)) {
      throw Object.assign(new Error("That code did not match — check your authenticator app and try again"), { code: 400 })
    }
    await db.userMfaSecret.update({ where: { id: mfa.id }, data: { lastUsedCounter: res.counter } })
    const codes = generateRecoveryCodes()
    await db.userMfaSecret.update({
      where: { id: mfa.id },
      data: { recoveryCodesHash: JSON.stringify(codes.map((c) => hashCode(c))), enrolledAt: new Date() },
    })
    await db.user.update({ where: { id: ctx.userId }, data: { mfaEnrolled: true } })
    // M-4 — auth lifecycle audit: MFA enable leaves a trail
    await audit({ userId: ctx.userId, userName: user.name, vendorId: ctx.vendorId }, "auth.mfa.enable", "User", ctx.userId, "MFA (TOTP) enabled — recovery codes issued")
    // AUDIT H-3 — alert the account owner (best-effort).
    void notifyAccountEmail(ctx.vendorId, user.email, `${await vendorNameFor(ctx.vendorId)} — MFA enabled on your account`,
      `Multi-factor authentication (TOTP) was just enabled on your account (${user.email}), and one-time recovery codes were issued.\n\nIf this was you, no action is needed. If you did NOT expect this, someone else may have access to your account — change your password and contact your administrator.`,
      { userId: ctx.userId, userName: user.name, action: "auth.mfa.enable", detail: "MFA enabled — owner notified" })
    return { enabled: true, recoveryCodes: codes } // shown exactly once
  },
})

  // INTENTIONALLY_SELF_SCOPED (M-02): identity-bound: removes the caller's own MFA (needs password + code)
route("auth.mfa.disable", {
  handler: async (ctx, p) => {
    const user = await db.user.findUnique({ where: { id: ctx.userId } })
    if (!user?.mfaEnrolled) throw Object.assign(new Error("MFA is not enabled"), { code: 400 })
    // L-1 — BOTH factors are required to strip the factor: the route comment
    // always claimed "password + code" but only the TOTP code was checked —
    // a hijacked session could remove the victim's second factor with a
    // shoulder-surfed code alone.
    if (!p?.password || typeof p.password !== "string" || !(await verifyPasswordAsync(p.password, user.passwordHash))) {
      throw Object.assign(new Error("Password is required to disable MFA"), { code: 401 })
    }
    const mfa = await db.userMfaSecret.findUnique({ where: { userId: ctx.userId } })
    const res = mfa ? verifyTotpWithCounter(decryptSecret(mfa.secretEnc), String(p?.code || "")) : { ok: false, counter: 0 }
    if (!mfa || !res.ok) {
      throw Object.assign(new Error("Verification code required to disable MFA"), { code: 400 })
    }
    // AUDIT L-8-parity (2026-11-07) — reject REPLAYED TOTP codes on disable
    // exactly like every other verification path (res.counter must exceed the
    // last accepted counter; a code that already authenticated anything is
    // refused). The owner plane gained the same check in this remediation.
    if (res.counter <= (mfa.lastUsedCounter ?? 0)) {
      throw Object.assign(new Error("That code was already used — wait for your authenticator to refresh and try again"), { code: 400 })
    }
    await db.userMfaSecret.update({ where: { id: mfa.id }, data: { lastUsedCounter: res.counter } })
    await db.userMfaSecret.deleteMany({ where: { userId: ctx.userId } })
    await db.user.update({ where: { id: ctx.userId }, data: { mfaEnrolled: false } })
    // M-4 — auth lifecycle audit: MFA disable leaves a trail (the audit's
    // headline example — stripping the second factor was invisible before)
    await audit({ userId: ctx.userId, userName: user.name, vendorId: ctx.vendorId }, "auth.mfa.disable", "User", ctx.userId, "MFA (TOTP) disabled (password + code verified)")
    // AUDIT H-3 — alert the account owner (best-effort): stripping the second
    // factor is exactly the event a victim must hear about.
    void notifyAccountEmail(ctx.vendorId, user.email, `${await vendorNameFor(ctx.vendorId)} — MFA DISABLED on your account`,
      `Multi-factor authentication was just DISABLED on your account (${user.email}) after verifying your password and a code.\n\nIf this was you, no action is needed. If you did NOT do this, change your password immediately and contact your administrator.`,
      { userId: ctx.userId, userName: user.name, action: "auth.mfa.disable", detail: "MFA disabled — owner notified" })
    return { enabled: false }
  },
})

  // INTENTIONALLY_PUBLIC (M-02): session teardown — safe for any caller, own token only
route("auth.logout", {
  public: true,
  handler: async (_ctx, _p) => {
    return { loggedOut: true }
  },
})

  // INTENTIONALLY_SELF_SCOPED (M-02): read-only identity introspection used to bootstrap the CSRF token after reload (H-08)
route("auth.me", {
  handler: async (ctx) => {
    const user = await db.user.findUnique({ where: { id: ctx.userId } })
    const vendor = await db.vendor.findUnique({ where: { id: ctx.vendorId } })
    const payload = await userPayload(
      user || { id: ctx.userId, vendorId: ctx.vendorId, ...ctx as any },
      vendor || { id: ctx.vendorId, name: "", code: "", logoUrl: null },
      Array.from(ctx.permissions),
      { activeCompanyId: ctx.activeCompanyId, companies: ctx.companyAccess, allCompaniesMode: ctx.allCompaniesMode },
    )
    const roleRow = await db.role.findFirst({ where: { vendorId: ctx.vendorId, key: ctx.role } })
    // R2 — keep the linked employee's photo on the rebuilt payload
    let mePhoto: string | null = null
    if (ctx.employeeId) {
      const linked = await db.employee.findUnique({
        where: { id: ctx.employeeId },
        select: { photoThumb: true, photoUrl: true },
      }).catch(() => null)
      mePhoto = linked?.photoThumb || linked?.photoUrl || null
    }
    payload.user = {
      id: ctx.userId, name: ctx.userName, email: user?.email, role: ctx.role,
      roleLabel: await roleLabelFor(ctx.vendorId, ctx.role), employeeId: ctx.employeeId,
      branchId: ctx.branchId, departmentId: ctx.departmentId,
      employeePhotoUrl: mePhoto,
      permissions: Array.from(ctx.permissions),
      fieldAccess: callerFieldAccess(await getSettings(ctx.vendorId), ctx.role),
      mfaEnrolled: !!user?.mfaEnrolled, mfaRequired: roleRow?.mfaRequired === true,
    }
    ;(payload as any).csrfToken = ctx.csrfToken || null
    // Wave 10 (2026-10-24) — support-session banner: while a time-limited
    // support session is active, auth.me rides the session facts along so the
    // SPA renders the persistent SUPPORT ACCESS banner (countdown is UX; the
    // server-side expiry in resolveSupportCtx is the real boundary).
    if (ctx.supportSession) {
      ;(payload as any).supportSession = ctx.supportSession
    }
    return payload
  },
})

// ---- Wave 10 (2026-10-24) — Support-session exit (the ONLY auth-surface
// action a support context may reach — see SUPPORT_ALWAYS_ACTIONS). Ends the
// session row (audited SUPPORT_ACCESS_ENDED) and clears the support cookie.
// In-handler defense in depth: a NON-support context calling this is a 403 —
// it would otherwise be a self-DoS vector for real tenant sessions.
  // INTENTIONALLY_SELF_SCOPED (M-02): identity-bound: ends ONLY the calling
  // support context's own session (ctx.supportSession guard → 403 otherwise);
  // no module permission applies to a support banner's exit affordance.
route("auth.supportExit", {
  handler: async (ctx) => {
    if (!ctx.supportSession) {
      throw Object.assign(new Error("No support session is active on this client."), { code: 403 })
    }
    const { exitSupportSession } = await import("../saas/support-access")
    const res = await exitSupportSession(ctx, "operator exit (banner)")
    const out = NextResponseLikeSupportExit(res.ended)
    return out
  },
})

/** Marker payload for auth.supportExit — the dispatcher's Set-Cookie hook
 *  below reads `supportExited` and clears the support cookie; carrying the
 *  marker through the handler keeps the cookie logic in ONE place (the
 *  dispatcher), matching how auth.login/auth.logout manage theirs. */
function NextResponseLikeSupportExit(ended: boolean) {
  return { supportExited: ended }
}

route("roles.templates", {
  perm: ["settings", "view"],
  handler: async (ctx) => {
    // Static system templates, overlaid with vendor-specific DB overrides.
    const custom = await db.role.findMany({ where: { vendorId: ctx.vendorId } })
    return Object.entries(ROLE_TEMPLATES).map(([key, perms]) => {
      const dbRole = custom.find((r) => r.key === key)
      return {
        key, label: dbRole?.name || ROLE_LABELS[key],
        permissions: dbRole ? JSON.parse(dbRole.permissions || "[]") : perms,
        isSystem: true, overridden: !!dbRole, mfaRequired: dbRole?.mfaRequired === true,
      }
    })
  },
})

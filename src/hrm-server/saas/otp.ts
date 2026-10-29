// ============ Wave 10 (2026-10-24) — OTP verification service ============
// Master prompt §6: SMS OTP for high-security flows. Backed by the
// SaasOtpCode table (migration 9_wave9zp) + the journaled SMS pipeline
// (src/hrm-server/sms — SSLWireless / generic HTTP adapters).
//
// SECURITY MODEL (§6.4 discipline):
//   - The 6-digit code is CSPRNG-generated and stored ONLY as
//     sha256(code + per-issue salt) — the plaintext never touches the DB,
//     logs, or the SMS journal (journal rows for OTP purposes carry the body
//     LENGTH only).
//   - Single use: consumption is a conditional update (consumedAt null → now)
//     so two concurrent verifications can never both succeed.
//   - Attempt-capped: 5 wrong entries burn the issue (constant-time compare
//     per attempt; the counter is enforced before the consume).
//   - Expiry: 5 minutes, enforced server-side at verify time.
//   - Issue rate limits: 3 codes / 10 min per identifier, 20 / 10 min per IP
//     for platform-plane sends; a still-live previous issue for the same
//     (identifier, purpose) is VOIDED so only the newest code verifies.
//   - OTP SMS messages are NEVER retried by the SMS pipeline (duplicate sends
//     cost real money and can race the verify endpoint).
import crypto from "crypto"
import { z } from "zod"
import { db } from "@/lib/db"
import { rateLimit } from "../security"
import { sendSmsJournaled, resolveSmsProvider } from "../sms"
import type { SmsSendConfig } from "../sms/types"
import type { SmsJournalPurpose } from "../sms/journal"
import { ownerAction } from "./owner-routes"
import { saasAudit } from "./audit"
import { getPlatformGateway } from "./notify"

const CODE_TTL_MS = 5 * 60_000
const CODE_DIGITS = 6
const MAX_ATTEMPTS = 5
const ISSUE_RATE_LIMIT = 3
const ISSUE_RATE_WINDOW_MS = 10 * 60_000

/** Purposes the platform recognizes (scoped, never free text). */
export const OTP_PURPOSES = [
  "LOGIN_2FA", // tenant login second factor (phone-of-record)
  "PHONE_VERIFY", // verify possession of a phone number
  "SUPPORT_ENTER", // confirm a support-access authorization out-of-band
  "OWNER_LOGIN_2FA", // owner console second factor
] as const
export type OtpPurpose = (typeof OTP_PURPOSES)[number]

function hashCode(code: string, salt: string): string {
  return crypto.createHash("sha256").update(`${salt}:${code}`).digest("hex")
}

/** CSPRNG 6-digit code with rejection sampling (uniform over the 10^6 space:
 *  draws are accepted below the largest multiple of the modulus that fits a
 *  u32, then reduced — ~99.98% acceptance). PURE (unit-tested). */
export function generateOtpCode(digits = CODE_DIGITS): string {
  const max = 10 ** digits
  const limit = Math.floor((2 ** 32) / max) * max
  let v = 0
  do {
    v = crypto.randomBytes(4).readUInt32BE(0)
  } while (v >= limit)
  return String(v % max).padStart(digits, "0")
}

/** The platform-plane SMS pipeline config (owner-configured gateway —
 *  SSLWireless creds or the generic URL template). */
async function platformSmsConfig(): Promise<SmsSendConfig> {
  const gw = await getPlatformGateway()
  return {
    provider: gw.sms.provider,
    apiKey: gw.sms.apiKey,
    senderId: gw.sms.senderId,
    apiUrl: gw.sms.apiUrl,
    method: gw.sms.method,
  }
}

export type IssueOtpResult =
  | { ok: true; expiresAt: Date; channel: "SMS" }
  | { ok: false; error: string; code: number }

/** Issue + send one OTP over the journaled SMS pipeline. `identifier` is a
 *  normalized BD phone (+880…). When NO gateway is configured the OTP is
 *  refused up-front — silently "issuing" a code nobody can receive is worse
 *  than a clean 400. */
export async function issueOtp(input: {
  identifier: string
  purpose: OtpPurpose
  vendorId?: string | null
  plane?: "TENANT" | "PLATFORM"
  ip?: string | null
  templateKey?: string | null
}): Promise<IssueOtpResult> {
  const identifier = String(input.identifier || "").trim()
  if (!/^\+8801[3-9]\d{8}$/.test(identifier)) {
    return { ok: false, error: "A valid Bangladeshi mobile number is required.", code: 400 }
  }
  // rate limits: per identifier (3/10min) + per IP when known (20/10min)
  if (await rateLimit(`otp:issue:id:${identifier}`, ISSUE_RATE_LIMIT, ISSUE_RATE_WINDOW_MS)) {
    return { ok: false, error: "Too many codes requested — wait a few minutes and try again.", code: 429 }
  }
  if (input.ip && (await rateLimit(`otp:issue:ip:${input.ip}`, 20, ISSUE_RATE_WINDOW_MS))) {
    return { ok: false, error: "Too many codes requested from this network — wait a few minutes.", code: 429 }
  }

  const cfg = await platformSmsConfig()
  if (!resolveSmsProvider(cfg)) {
    return { ok: false, error: "No SMS gateway is configured on this platform — OTP delivery is unavailable.", code: 400 }
  }

  const code = generateOtpCode()
  const salt = crypto.randomBytes(16).toString("hex")
  const now = new Date()
  const expiresAt = new Date(now.getTime() + CODE_TTL_MS)

  // Void any still-live previous issue for the same (identifier, purpose) —
  // only the NEWEST code may verify (prevents parallel-code confusion).
  await db.saasOtpCode.updateMany({
    where: { identifier, purpose: input.purpose, consumedAt: null, expiresAt: { gt: now } },
    data: { consumedAt: now },
  }).catch(() => {})

  await db.saasOtpCode.create({
    data: {
      identifier,
      channel: "SMS",
      purpose: input.purpose,
      codeHash: hashCode(code, salt),
      salt,
      expiresAt,
      attempts: 0,
      maxAttempts: MAX_ATTEMPTS,
      vendorId: input.vendorId || null,
      ip: input.ip ? String(input.ip).slice(0, 60) : null,
    },
  })

  const templateKey = input.templateKey || `otp.${input.purpose.toLowerCase()}`
  const body = `Your Finix HR verification code is ${code}. It expires in 5 minutes. Never share this code.`
  const journalPurpose: SmsJournalPurpose = input.purpose === "LOGIN_2FA" || input.purpose === "OWNER_LOGIN_2FA" ? "OTP_LOGIN" : "OTP_VERIFY"
  const result = await sendSmsJournaled({
    plane: input.plane || (input.vendorId ? "TENANT" : "PLATFORM"),
    vendorId: input.vendorId || null,
    toPhone: identifier,
    message: body,
    purpose: journalPurpose,
    templateKey,
    cfg,
  })

  if (result.status !== "SENT") {
    return { ok: false, error: result.detail || "The SMS gateway could not deliver the code — try again shortly.", code: 502 }
  }
  return { ok: true, expiresAt, channel: "SMS" }
}

export type VerifyOtpResult =
  | { ok: true }
  | { ok: false; error: string; code: number; reason: "NOT_FOUND" | "EXPIRED" | "CONSUMED" | "TOO_MANY_ATTEMPTS" | "MISMATCH" }

/** Verify (and single-use consume) one OTP. Constant-time comparison; the
 *  attempt counter increments on every miss, consumption is the conditional
 *  update that makes the code single-use even under concurrent verifies. */
export async function verifyOtp(input: {
  identifier: string
  purpose: OtpPurpose
  code: string
  vendorId?: string | null
}): Promise<VerifyOtpResult> {
  const identifier = String(input.identifier || "").trim()
  const code = String(input.code || "").replace(/\D/g, "")
  if (!identifier || code.length !== CODE_DIGITS) {
    return { ok: false, error: "Enter the 6-digit code.", code: 400, reason: "MISMATCH" }
  }
  const row = await db.saasOtpCode.findFirst({
    where: { identifier, purpose: input.purpose },
    orderBy: { createdAt: "desc" },
  })
  if (!row) {
    return { ok: false, error: "No verification code was issued for this number. Request a new one.", code: 400, reason: "NOT_FOUND" }
  }
  const now = new Date()
  if (row.consumedAt) {
    return { ok: false, error: "This code was already used. Request a new one.", code: 400, reason: "CONSUMED" }
  }
  if (row.expiresAt < now) {
    return { ok: false, error: "This code has expired. Request a new one.", code: 400, reason: "EXPIRED" }
  }
  if (row.attempts >= row.maxAttempts) {
    return { ok: false, error: "Too many incorrect attempts. Request a new code.", code: 429, reason: "TOO_MANY_ATTEMPTS" }
  }
  const expected = Buffer.from(row.codeHash, "hex")
  const presented = Buffer.from(hashCode(code, row.salt), "hex")
  if (expected.length !== presented.length || !crypto.timingSafeEqual(expected, presented)) {
    await db.saasOtpCode.update({ where: { id: row.id }, data: { attempts: { increment: 1 } } })
    const left = Math.max(0, row.maxAttempts - row.attempts - 1)
    return {
      ok: false,
      error: left > 0 ? `Incorrect code — ${left} attempt${left === 1 ? "" : "s"} left.` : "Too many incorrect attempts. Request a new code.",
      code: 400,
      reason: "MISMATCH",
    }
  }
  // consume — conditional so a concurrent verify of the same issue loses
  const consumed = await db.saasOtpCode.updateMany({
    where: { id: row.id, consumedAt: null },
    data: { consumedAt: now },
  })
  if (consumed.count === 0) {
    return { ok: false, error: "This code was already used. Request a new one.", code: 400, reason: "CONSUMED" }
  }
  return { ok: true }
}

/** Housekeeping: drop rows older than 24h regardless of state (daily sweep —
 *  the expiresAt index keeps the scan bounded; nothing alive is ever swept). */
export async function sweepStaleOtpRows(): Promise<number> {
  const cutoff = new Date(Date.now() - 24 * 3600_000)
  const res = await db.saasOtpCode.deleteMany({ where: { expiresAt: { lt: cutoff } } })
  return res.count
}

// ---------------- owner console surface (Integrations → SMS) ----------------

ownerAction("owner.sms.otpStats", {
  perm: "health.view",
  handler: async () => {
    const since24 = new Date(Date.now() - 86400000)
    const [issued, verified, active] = await Promise.all([
      db.saasOtpCode.count({ where: { createdAt: { gte: since24 } } }),
      db.saasOtpCode.count({ where: { consumedAt: { not: null, gte: since24 } } }),
      db.saasOtpCode.count({ where: { consumedAt: null, expiresAt: { gt: new Date() } } }),
    ])
    return {
      issuedLast24h: issued,
      verifiedLast24h: verified,
      activeUnconsumed: active,
      ttlMinutes: CODE_TTL_MS / 60000,
      maxAttempts: MAX_ATTEMPTS,
    }
  },
})

ownerAction("owner.sms.testOtp", {
  perm: "health.manage",
  schema: z.object({
    toPhone: z.string().trim().min(10).max(20),
  }).strict(),
  handler: async (ctx, p) => {
    const normalized = p.toPhone.startsWith("+880") ? p.toPhone : `+880${p.toPhone.replace(/^0+/, "")}`
    const res = await issueOtp({
      identifier: normalized,
      purpose: "PHONE_VERIFY",
      plane: "PLATFORM",
      ip: ctx.ip || null,
      templateKey: "otp.test",
    })
    if (!res.ok) {
      await saasAudit(ctx, "SMS_OTP_TEST_FAILED", "SaasOtpCode", null, `OTP test send to ${p.toPhone} failed: ${res.error.slice(0, 160)}`, {})
      throw Object.assign(new Error(res.error), { code: res.code })
    }
    await saasAudit(ctx, "SMS_OTP_TEST_SENT", "SaasOtpCode", null, `Test OTP sent to ${p.toPhone} (expires ${res.expiresAt.toISOString()})`, {})
    return { sent: true, expiresAt: res.expiresAt.toISOString(), channel: res.channel }
  },
})

/** SMS delivery-journal drill-down for the console (masked: OTP rows never
 *  stored a body; previews are pre-truncated; no credentials anywhere). */
ownerAction("owner.sms.journal", {
  perm: "health.view",
  schema: z.object({
    take: z.number().int().min(1).max(100).default(25),
  }).strict(),
  handler: async (_ctx, p) => {
    const { smsJournalStats, smsJournalRecent } = await import("../sms/journal")
    const [stats, recent] = await Promise.all([
      smsJournalStats(),
      smsJournalRecent(p.take),
    ])
    return { stats, recent }
  },
})

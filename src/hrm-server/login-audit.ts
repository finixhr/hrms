// ============ R16 (2026-10-12) — LoginAuditLog writer + UA parser ============
// Records successful AND failed login attempts on both planes
// (/api/hrm auth.login + auth.mfa.verify, /api/owner owner.auth.login) with
// identity (where resolvable), IP, User-Agent and derived browser/OS/device
// labels. Privacy: the ATTEMPTED email is stored (correlating brute force
// against known accounts requires it) but rows are retention-swept
// (settings-driven, default 180 days) and the report surface is gated by
// audit.view.
import { db } from "@/lib/db"

/** Minimal, dependency-free User-Agent → {browser, os, deviceType} parser.
 *  Covers the browsers/OSes that matter for a BD-market HRM deployment;
 *  unknown agents fall back to derived families instead of nulls where
 *  possible (bot detection via the Bot keyword convention). */
export function parseUserAgent(ua: string | null | undefined): { browser: string | null; os: string | null; deviceType: string | null } {
  const s = String(ua || "").trim()
  if (!s) return { browser: null, os: null, deviceType: null }

  // device type first (tablet UA strings often contain "Mobile" too)
  const isTablet = /iPad|Tablet|PlayBook|Silk/i.test(s) || (/Android/i.test(s) && !/Mobile/i.test(s))
  const isMobile = !isTablet && /Mobi|iPhone|Android.*Mobile|Windows Phone|IEMobile/i.test(s)
  const isBot = /bot|crawl|spider|slurp|bingpreview|facebookexternalhit|HeadlessChrome|python-requests|curl\/|node-fetch|axios/i.test(s)
  const deviceType = isBot ? "bot" : isTablet ? "tablet" : isMobile ? "mobile" : "desktop"

  // browser (order matters — Edge/Opera/Chrome all contain "Chrome")
  let browser: string | null = null
  const m = (re: RegExp) => re.exec(s)
  let match = m(/Edg(?:e|A|iOS)?\/([\d.]+)/)
  if (match) browser = `Edge ${match[1].split(".")[0]}`
  if (!browser && (match = m(/OPR\/([\d.]+)/))) browser = `Opera ${match[1].split(".")[0]}`
  if (!browser && (match = m(/SamsungBrowser\/([\d.]+)/))) browser = `Samsung Internet ${match[1].split(".")[0]}`
  if (!browser && (match = m(/YaBrowser\/([\d.]+)/))) browser = `Yandex ${match[1].split(".")[0]}`
  if (!browser && (match = m(/Firefox\/([\d.]+)/))) browser = `Firefox ${match[1].split(".")[0]}`
  if (!browser && (match = m(/Chrome\/([\d.]+)/))) browser = `Chrome ${match[1].split(".")[0]}`
  if (!browser && (match = m(/Version\/([\d.]+).*Safari/))) browser = `Safari ${match[1].split(".")[0]}`
  if (!browser && /Safari/.test(s)) browser = "Safari"
  if (!browser && (match = m(/MSIE ([\d.]+)/))) browser = `Internet Explorer ${match[1]}`
  if (!browser && /Trident/.test(s)) browser = "Internet Explorer"
  if (!browser && (match = m(/PostmanRuntime\/([\d.]+)/))) browser = `Postman ${match[1].split(".")[0]}`

  // OS
  let os: string | null = null
  if (/Windows NT 10/.test(s)) os = "Windows 10/11"
  else if (/Windows NT 6\.3/.test(s)) os = "Windows 8.1"
  else if (/Windows NT 6\.1/.test(s)) os = "Windows 7"
  else if (/Windows/.test(s)) os = "Windows"
  else if (/iPhone|iPad|iPod/.test(s)) {
    const v = m(/OS (\d+[_\d]*)/)
    os = `iOS ${v ? v[1].replace(/_/g, ".") : ""}`.trim()
  } else if (/Mac OS X/.test(s)) {
    const v = m(/Mac OS X (\d+[._\d]*)/)
    os = `macOS ${v ? v[1].replace(/_/g, ".") : ""}`.trim()
  } else if (/Android ([\d.]+)/.test(s)) os = `Android ${(m(/Android ([\d.]+)/) as RegExpExecArray)[1]}`
  else if (/Android/.test(s)) os = "Android"
  else if (/CrOS/.test(s)) os = "ChromeOS"
  else if (/Ubuntu/.test(s)) os = "Ubuntu"
  else if (/Linux/.test(s)) os = "Linux"

  return { browser, os, deviceType }
}

export type LoginAuditReason =
  | "INVALID_CREDENTIALS"
  | "LOCKED_OUT"
  | "MFA_FAILED"
  | "INACTIVE_VENDOR"
  | "RATE_LIMITED"
  | "AMBIGUOUS_EMAIL"
  | "ERROR"

/** Fire-and-forget audit writer — login NEVER fails because the audit row
 *  could not be written (the attempt itself is already sensitive; swallowing
 *  the secondary write is the safe order). */
export async function recordLoginAudit(entry: {
  plane?: "TENANT" | "OWNER"
  email: string
  success: boolean
  failureReason?: LoginAuditReason
  userId?: string | null
  userName?: string | null
  vendorId?: string | null
  vendorName?: string | null
  role?: string | null
  mfaUsed?: boolean
  ip?: string | null
  userAgent?: string | null
}): Promise<void> {
  try {
    const { browser, os, deviceType } = parseUserAgent(entry.userAgent)
    await db.loginAuditLog.create({
      data: {
        plane: entry.plane || "TENANT",
        email: String(entry.email || "").toLowerCase().trim().slice(0, 320),
        success: entry.success,
        failureReason: entry.failureReason || null,
        userId: entry.userId || null,
        userName: entry.userName || null,
        vendorId: entry.vendorId || null,
        vendorName: entry.vendorName || null,
        role: entry.role || null,
        mfaUsed: !!entry.mfaUsed,
        ip: entry.ip ? String(entry.ip).slice(0, 64) : null,
        userAgent: entry.userAgent ? String(entry.userAgent).slice(0, 512) : null,
        browser, os, deviceType,
      },
    })
  } catch {
    // never break the login path on audit-write failure
  }
}

/** Retention sweep for ONE tenant's rows (jobs.ts calls this per vendor with
 *  that vendor's loginAudit.retentionDays). Returns rows purged; 0 when
 *  retention is disabled (retentionDays = 0). */
export async function sweepLoginAuditRetentionFor(vendorId: string, retentionDays: number): Promise<number> {
  const days = Math.max(0, Math.floor(Number(retentionDays) || 0))
  if (days === 0) return 0
  const cutoff = new Date(Date.now() - days * 86400000)
  const res = await db.loginAuditLog.deleteMany({ where: { vendorId, createdAt: { lt: cutoff } } })
  return res.count
}

/** Global retention sweep (retentionDays, default 180). Returns the number of
 *  rows purged; 0 when retention is disabled (retentionDays = 0). */
export async function sweepLoginAuditRetention(retentionDays: number): Promise<number> {
  const days = Math.max(0, Math.floor(Number(retentionDays) || 0))
  if (days === 0) return 0
  const cutoff = new Date(Date.now() - days * 86400000)
  const res = await db.loginAuditLog.deleteMany({ where: { createdAt: { lt: cutoff } } })
  return res.count
}

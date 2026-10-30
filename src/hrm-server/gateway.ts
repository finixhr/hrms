// ============ Email & SMS gateway service (spec §4.1 gateway settings) ============
// Email: any SMTP provider (Gmail preset: smtp.gmail.com:587, app password).
// SMS: provider-agnostic HTTP gateway — the admin supplies an API URL that may
// contain {phone} {message} {sender} {apiKey} placeholders, with GET or POST.
// When a gateway is not configured/enabled, sends are SKIPPED (never throw) so
// workflows keep running and delivery is recorded transparently in the log.
//
// H-10 REMEDIATION: the SMS URL is validated at settings-save time AND again at
// send time (https only, public hosts only — RFC1918/link-local/metadata ranges
// and localhost are refused). The SMTP From display name is sanitized against
// CRLF/quote injection.
import { getSettings } from "./settings"
import { sanitizeDisplayName } from "./security"

export type DeliveryResult = { status: "SENT" | "FAILED" | "SKIPPED"; detail?: string }

/** Wave 4 (2026-10-08) — OPTIONAL email attachment (scheduled report delivery).
 *  `content` is a raw Buffer; nodemailer accepts it directly in sendMail.
 *  Only ever passed through when a caller opts in, so every existing
 *  3-argument call site keeps byte-for-byte identical behavior. */
export type EmailAttachment = { filename: string; content: Buffer; contentType?: string }

/** Attachment send options — deliberately narrow: filename is sanitized to a
 *  basename (no path traversal, no control chars) before it reaches SMTP. */
export type SendEmailOptions = { attachments?: EmailAttachment[] }

const trim = (s: unknown) => (typeof s === "string" ? s.trim() : "")

export async function emailConfigured(vendorId: string) {
  const s = await getSettings(vendorId, { maskSecrets: false })
  const e = s.email
  return !!(e.enabled && trim(e.host) && trim(e.username) && trim(e.password))
}

export async function smsConfigured(vendorId: string) {
  const s = await getSettings(vendorId, { maskSecrets: false })
  const m = s.sms
  // Wave 10 — an explicit SSLWireless configuration is complete without a
  // URL template (the adapter owns the base URL).
  return !!(m.enabled && (trim(m.apiUrl) || tenantSslwirelessComplete(m)))
}

export async function sendEmail(
  vendorId: string,
  to: string,
  subject: string,
  body: string,
  opts?: SendEmailOptions,
): Promise<DeliveryResult> {
  const toClean = trim(to)
  if (!toClean || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(toClean)) {
    return { status: "SKIPPED", detail: toClean ? `invalid address: ${toClean}` : "no email address on file" }
  }
  const s = await getSettings(vendorId, { maskSecrets: false })
  const e = s.email
  if (!e.enabled || !trim(e.host) || !trim(e.username) || !trim(e.password)) {
    // Point the admin at the exact gap instead of a generic "not configured"
    const missing: string[] = []
    if (!e.enabled) missing.push("sending is disabled (enable it in Settings → Email Gateway)")
    if (!trim(e.host)) missing.push("SMTP host")
    if (!trim(e.username)) missing.push("username")
    if (!trim(e.password)) missing.push("password")
    return { status: "SKIPPED", detail: `email gateway not configured — ${missing.join(", ")}` }
  }
  try {
    // nodemailer is optional at build time; resolved at first use.
    const mod = (await import("nodemailer")) as any
    const transporter = mod.default?.createTransport?.({
      host: trim(e.host),
      port: Number(e.port) || 587,
      secure: !!e.secure || Number(e.port) === 465,
      auth: { user: trim(e.username), pass: e.password },
    }) ?? mod.createTransport?.({
      host: trim(e.host),
      port: Number(e.port) || 587,
      secure: !!e.secure || Number(e.port) === 465,
      auth: { user: trim(e.username), pass: e.password },
    })
    if (!transporter) return { status: "FAILED", detail: "nodemailer unavailable" }
    const from = trim(e.fromAddress) || trim(e.username)
    // H-10 — display name sanitized: no control chars, quotes or angle brackets
    const fromName = sanitizeDisplayName(e.fromName)
    // Wave 4 — OPTIONAL attachments (scheduled reports). Only spread in when
    // provided AND non-empty so the default payload shape is unchanged.
    const attachments = (opts?.attachments || [])
      .filter((a) => a && typeof a.filename === "string" && Buffer.isBuffer(a.content))
      .map((a) => ({
        filename: a.filename.replace(/[\\/]/g, "_").replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 120) || "attachment",
        content: a.content,
        ...(a.contentType ? { contentType: a.contentType } : {}),
      }))
    await transporter.sendMail({
      from: fromName ? `"${fromName}" <${from}>` : from,
      to: toClean,
      subject,
      text: body,
      html: `<div style="font-family:Segoe UI,Arial,sans-serif;font-size:14px;line-height:1.6;color:#0f172a;max-width:640px">${body
        .split(/\n{2,}/)
        .map((p) => `<p style="margin:0 0 12px">${p.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/\n/g, "<br/>")}</p>`)
        .join("")}</div>`,
      ...(attachments.length ? { attachments } : {}),
    })
    return { status: "SENT" }
  } catch (err: any) {
    return { status: "FAILED", detail: String(err?.message || err).slice(0, 300) }
  }
}

/** Wave 10 (2026-10-24) — map the tenant settings' free-text provider label
 *  onto a registered adapter id. The settings field predates the adapter
 *  registry and carries labels like "SSL Wireless"; anything unrecognized
 *  falls through to the generic HTTP template adapter (the historic
 *  behavior). PURE (unit-tested). */
export function tenantSmsProviderId(label: string): string {
  const v = String(label || "").trim().toLowerCase().replace(/[\s_-]+/g, "")
  if (v === "sslwireless" || v === "ssl" || v === "sslwirelessv3") return "sslwireless"
  return "generichttp"
}

/** True when the tenant's settings name the SSLWireless adapter with complete
 *  credentials (api token + sid) — an explicit structured adapter needs NO
 *  URL template (its base URL defaults to smsplus.sslwireless.com). */
function tenantSslwirelessComplete(m: { provider: string; apiKey: string; senderId: string }): boolean {
  return tenantSmsProviderId(m.provider) === "sslwireless" && !!(trim(m.apiKey) && trim(m.senderId))
}

export async function sendSms(
  vendorId: string,
  phone: string,
  message: string,
  purpose: "NOTICE" | "WISHES" | "CAMPAIGN" | "SYSTEM" = "NOTICE",
): Promise<DeliveryResult> {
  let phoneClean = trim(phone).replace(/[^\d+]/g, "")
  if (!phoneClean) return { status: "SKIPPED", detail: "no phone number on file" }
  // BD numbers are often stored as 01XXXXXXXXX; normalise local to +880 form.
  if (/^01\d{9}$/.test(phoneClean)) phoneClean = `+880${phoneClean.slice(1)}`
  const s = await getSettings(vendorId, { maskSecrets: false })
  const m = s.sms
  if (!m.enabled || (!trim(m.apiUrl) && !tenantSslwirelessComplete(m))) {
    return { status: "SKIPPED", detail: "SMS gateway not configured" }
  }
  // Wave 10 — the tenant plane funnels through the SAME journaled pipeline as
  // the platform plane: normalize → journal → adapter (SSLWireless v3 when the
  // settings name it, the generic URL template otherwise) → bounded non-OTP
  // retry → journal outcome. Every tenant SMS is now reconcilable.
  const { sendSmsJournaled } = await import("./sms")
  return sendSmsJournaled({
    plane: "TENANT",
    vendorId,
    toPhone: phoneClean,
    message,
    purpose,
    cfg: {
      provider: tenantSmsProviderId(m.provider),
      apiKey: trim(m.apiKey),
      senderId: trim(m.senderId),
      // For SSLWireless the apiUrl field is repurposed as an OPTIONAL base
      // URL override (see sslwireless.ts); empty → the documented default.
      apiUrl: tenantSmsProviderId(m.provider) === "sslwireless" && !trim(m.apiUrl) ? "" : trim(m.apiUrl),
      method: m.method || "POST",
    },
  })
}


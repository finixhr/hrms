// ============ Platform-plane outbound notifications (email/SMS gateway) ============
// 2026-10-04 — closes the "owner notifications not wired to a gateway" gap.
//
// The platform layer keeps its OWN gateway configuration (SaaSSetting group
// "gateway") — it deliberately does NOT reuse a tenant's HrSetting gateway:
// tenant SMTP credentials are tenant-scoped assets and must never send
// platform business mail. Mechanics mirror the tenant gateway stack
// (src/hrm-server/gateway.ts): SMTP via nodemailer for email, a
// provider-agnostic templated HTTP gateway for SMS, the same H-10 SSRF
// guards (https-only, public hosts only, CRLF-safe display names), and the
// same SENT/FAILED/SKIPPED contract — a missing gateway SKIPS transparently
// instead of throwing, so console workflows never break.
//
// Every send attempt (including SKIPPED) lands in SaaSAuditLog with a
// NOTIFICATION_* action — that is the owner-console-visible notification
// feed (owner.notifications.list).
import { db } from "@/lib/db"
import { validateOutboundUrl, sanitizeDisplayName } from "../security"
import { saasAudit } from "./audit"
import { getSaasSettings } from "./settings"
import { encryptField, decryptField } from "../crypto-field" // S2b-002: encrypt secrets at rest

/** S2b-002: Encrypt a gateway secret before storing in SaaSSetting.
 *  Context "comms::v1" matches the existing re-encrypt-fields.ts key. */
function encGw(plaintext: string): string {
  if (!plaintext) return ""
  try { return "enc::" + encryptField(plaintext, "comms::v1") } catch { return "" }
}
/** Decrypt a stored gateway secret; returns plaintext or empty string on failure. */
function decGw(stored: string): string {
  if (!stored) return ""
  if (!stored.startsWith("enc::")) return stored // legacy plaintext — pass through until re-encrypted
  try { return decryptField(stored.slice(5), "comms::v1") } catch { return "" }
}

const trim = (s: unknown) => (typeof s === "string" ? s.trim() : "")

/** S2b-006: Escape a string for safe injection into HTML email bodies. */
function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;")
}

export type PlatformGateway = {
  email: {
    enabled: boolean
    host: string
    port: number
    secure: boolean
    username: string
    password: string // secret — never returned masked reads
    fromAddress: string
    fromName: string
  }
  sms: {
    enabled: boolean
    apiUrl: string
    method: "GET" | "POST"
    senderId: string
    apiKey: string // secret — never returned masked reads
    /** Wave 10 (2026-10-24) — explicit adapter selection: "sslwireless" |
     *  "generichttp" | "none" (the historic default: the generic URL
     *  template). When an explicit adapter is set with complete credentials
     *  it wins over the template — see sms/index.ts resolveSmsProvider. */
    provider: string
  }
}

const DEFAULT_GATEWAY: PlatformGateway = {
  email: { enabled: false, host: "", port: 587, secure: false, username: "", password: "", fromAddress: "", fromName: "Finix HR Platform" },
  sms: { enabled: false, apiUrl: "", method: "POST", senderId: "", apiKey: "", provider: "none" },
}

let gwCache: { at: number; value: PlatformGateway } | null = null
const GW_TTL_MS = 10_000

export function invalidatePlatformGateway() {
  gwCache = null
}

/** Load the platform gateway config from SaaSSetting rows (group "gateway"). */
export async function getPlatformGateway(): Promise<PlatformGateway> {
  if (gwCache && Date.now() - gwCache.at < GW_TTL_MS) return gwCache.value
  const rows = await db.saasSetting.findMany({ where: { group: "gateway" } })
  const map = new Map(rows.map((r) => [r.key, r.value]))
  const read = (k: string) => { try { return JSON.parse(map.get(k) ?? "null") } catch { return map.get(k) ?? null } }
  const gw: PlatformGateway = {
    email: {
      enabled: read("emailEnabled") === true,
      host: String(read("emailHost") || ""),
      port: Number(read("emailPort")) || 587,
      secure: read("emailSecure") === true,
      username: String(read("emailUsername") || ""),
      password: decGw(String(read("emailPassword") || "")), // S2b-002: decrypt at read
      fromAddress: String(read("emailFromAddress") || ""),
      fromName: String(read("emailFromName") || DEFAULT_GATEWAY.email.fromName),
    },
    sms: {
      enabled: read("smsEnabled") === true,
      apiUrl: String(read("smsApiUrl") || ""),
      method: read("smsMethod") === "GET" ? "GET" : "POST",
      senderId: String(read("smsSenderId") || ""),
      apiKey: decGw(String(read("smsApiKey") || "")), // S2b-002: decrypt at read
      provider: String(read("smsProvider") || "none"),
    },
  }
  gwCache = { at: Date.now(), value: gw }
  return gw
}

export function platformEmailConfigured(gw?: PlatformGateway) {
  const g = gw || DEFAULT_GATEWAY
  return !!(g.email.enabled && trim(g.email.host) && trim(g.email.username) && g.email.password)
}
export function platformSmsConfigured(gw?: PlatformGateway) {
  const g = gw || DEFAULT_GATEWAY
  return !!(g.sms.enabled && trim(g.sms.apiUrl))
}

/** Masked projection for the owner UI — secrets become presence booleans. */
export function maskPlatformGateway(gw: PlatformGateway) {
  return {
    email: {
      ...gw.email,
      password: "",
      hasPassword: !!gw.email.password,
    },
    sms: {
      ...gw.sms,
      apiKey: "",
      hasApiKey: !!gw.sms.apiKey,
    },
  }
}

/** Validated whitelist write path for gateway settings (owner.gateway.save). */
export async function savePlatformGateway(input: Record<string, unknown>) {
  const cur = await getPlatformGateway()
  const next: PlatformGateway = {
    email: {
      enabled: input.emailEnabled === true || (input.emailEnabled === undefined && cur.email.enabled),
      host: String(input.emailHost ?? cur.email.host).trim().slice(0, 200),
      port: Number.isFinite(Number(input.emailPort)) && Number(input.emailPort) > 0 ? Number(input.emailPort) : cur.email.port,
      secure: input.emailSecure === undefined ? cur.email.secure : input.emailSecure === true,
      username: String(input.emailUsername ?? cur.email.username).trim().slice(0, 200),
      // empty string = keep the existing secret (the masked UI round-trips blanks)
      password: String(input.emailPassword ?? "") ? String(input.emailPassword).slice(0, 200) : cur.email.password,
      fromAddress: String(input.emailFromAddress ?? cur.email.fromAddress).trim().slice(0, 200),
      fromName: String(input.emailFromName ?? cur.email.fromName).trim().slice(0, 120),
    },
    sms: {
      enabled: input.smsEnabled === true || (input.smsEnabled === undefined && cur.sms.enabled),
      apiUrl: String(input.smsApiUrl ?? cur.sms.apiUrl).trim().slice(0, 500),
      method: input.smsMethod === "GET" ? "GET" : input.smsMethod === "POST" ? "POST" : cur.sms.method,
      senderId: String(input.smsSenderId ?? cur.sms.senderId).trim().slice(0, 40),
      apiKey: String(input.smsApiKey ?? "") ? String(input.smsApiKey).slice(0, 300) : cur.sms.apiKey,
      provider: ["sslwireless", "generichttp", "none"].includes(String(input.smsProvider || ""))
        ? String(input.smsProvider)
        : cur.sms.provider,
    },
  }
  // H-10 — validate the SMS URL at SAVE time (https only, no private hosts,
  // placeholders are substituted syntactically first, same as send time)
  if (platformSmsConfigured(next)) {
    const probe = next.sms.apiUrl
      .replace(/\{phone\}/g, "8801700000000").replace(/\{message\}/g, "x")
      .replace(/\{sender\}/g, "x").replace(/\{apiKey\}/g, "x")
    const check = validateOutboundUrl(probe)
    if (!check.ok) throw Object.assign(new Error(`SMS gateway URL rejected: ${check.reason}`), { code: 400 })
  }
  const rows: { group: string; key: string; value: string }[] = [
    { group: "gateway", key: "emailEnabled", value: JSON.stringify(next.email.enabled) },
    { group: "gateway", key: "emailHost", value: JSON.stringify(next.email.host) },
    { group: "gateway", key: "emailPort", value: JSON.stringify(next.email.port) },
    { group: "gateway", key: "emailSecure", value: JSON.stringify(next.email.secure) },
    { group: "gateway", key: "emailUsername", value: JSON.stringify(next.email.username) },
    { group: "gateway", key: "emailPassword", value: JSON.stringify(encGw(next.email.password)) }, // S2b-002: encrypted
    { group: "gateway", key: "emailFromAddress", value: JSON.stringify(next.email.fromAddress) },
    { group: "gateway", key: "emailFromName", value: JSON.stringify(next.email.fromName) },
    { group: "gateway", key: "smsEnabled", value: JSON.stringify(next.sms.enabled) },
    { group: "gateway", key: "smsApiUrl", value: JSON.stringify(next.sms.apiUrl) },
    { group: "gateway", key: "smsMethod", value: JSON.stringify(next.sms.method) },
    { group: "gateway", key: "smsSenderId", value: JSON.stringify(next.sms.senderId) },
    { group: "gateway", key: "smsApiKey", value: JSON.stringify(encGw(next.sms.apiKey)) }, // S2b-002: encrypted
    { group: "gateway", key: "smsProvider", value: JSON.stringify(next.sms.provider) },
  ]
  for (const r of rows) {
    await db.saasSetting.upsert({
      where: { group_key: { group: r.group, key: r.key } },
      create: { group: r.group, key: r.key, value: r.value },
      update: { value: r.value },
    })
  }
  invalidatePlatformGateway()
  return maskPlatformGateway(await getPlatformGateway())
}

// ---------------- send primitives (mirror the tenant gateway contract) ----------------

export async function sendPlatformEmail(
  to: string,
  subject: string,
  body: string,
  opts?: {
    html?: string
    attachments?: { filename: string; content: Buffer | Uint8Array | string; contentType?: string }[]
  }
): Promise<{ status: "SENT" | "FAILED" | "SKIPPED"; detail?: string }> {
  const toClean = trim(to)
  if (!toClean || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(toClean)) {
    return { status: "SKIPPED", detail: toClean ? `invalid address: ${toClean}` : "no email address on file" }
  }
  const gw = await getPlatformGateway()
  const e = gw.email
  if (!platformEmailConfigured(gw)) {
    return { status: "SKIPPED", detail: "platform email gateway not configured (Settings → Platform Gateway)" }
  }
  try {
    const mod = (await import("nodemailer")) as any
    const transporter = mod.default?.createTransport?.({
      host: e.host.trim(), port: Number(e.port) || 587,
      secure: !!e.secure || Number(e.port) === 465,
      auth: { user: e.username.trim(), pass: e.password },
    })
    if (!transporter) return { status: "FAILED", detail: "nodemailer unavailable" }
    const from = e.fromAddress.trim() || e.username.trim()
    const fromName = sanitizeDisplayName(e.fromName)
    await transporter.sendMail({
      from: fromName ? `"${fromName}" <${from}>` : from,
      to: toClean, subject, text: body,
      html: opts?.html || `<div style="font-family:Segoe UI,Arial,sans-serif;font-size:14px;line-height:1.6;color:#0f172a;max-width:640px">${body
        .split(/\n{2,}/)
        .map((p) => `<p style="margin:0 0 12px">${p.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/\n/g, "<br/>")}</p>`)
        .join("")}</div>`,
      attachments: opts?.attachments,
    })
    return { status: "SENT" }
  } catch (err: any) {
    return { status: "FAILED", detail: String(err?.message || err).slice(0, 300) }
  }
}

export async function sendPlatformSms(phone: string, message: string, purpose: "SYSTEM" | "NOTICE" | "OTP_LOGIN" | "OTP_VERIFY" = "SYSTEM"): Promise<{ status: "SENT" | "FAILED" | "SKIPPED"; detail?: string }> {
  let phoneClean = trim(phone).replace(/[^\d+]/g, "")
  if (!phoneClean) return { status: "SKIPPED", detail: "no phone number on file" }
  if (/^01\d{9}$/.test(phoneClean)) phoneClean = `+880${phoneClean.slice(1)}`
  const gw = await getPlatformGateway()
  if (!platformSmsConfigured(gw)) return { status: "SKIPPED", detail: "platform SMS gateway not configured" }
  // Wave 10 (2026-10-24) — the platform plane funnels through the journaled
  // pipeline: resolveSmsProvider picks the explicit adapter (SSLWireless v3
  // when configured) with the generic URL template as the historic fallback;
  // every submission + outcome lands in SaasSmsMessage for reconciliation.
  const { sendSmsJournaled } = await import("../sms")
  return sendSmsJournaled({
    plane: "PLATFORM",
    toPhone: phoneClean,
    message,
    purpose,
    cfg: {
      provider: gw.sms.provider,
      apiKey: gw.sms.apiKey,
      senderId: gw.sms.senderId,
      apiUrl: gw.sms.apiUrl,
      method: gw.sms.method,
    },
  })
}

// ---------------- console-visible notification feed ----------------

/** Log a platform notification attempt into SaaSAuditLog — this IS the
 *  owner-console feed (action NOTIFICATION_SENT/SKIPPED/FAILED). */
export async function logPlatformNotification(
  channel: "EMAIL" | "SMS" | "WEBHOOK",
  subject: string,
  recipients: string[],
  result: { status: string; detail?: string }
) {
  await saasAudit(
    { name: "Platform" },
    `NOTIFICATION_${result.status}`,
    "PlatformNotification",
    null,
    `[${channel}] ${subject} → ${recipients.length} recipient(s): ${result.status}${result.detail ? ` (${result.detail})` : ""}`,
    { metadata: { channel, subject: subject.slice(0, 200), recipients: recipients.slice(0, 10), status: result.status, detail: result.detail?.slice(0, 200) } }
  ).catch(() => {})
}

// ---- Phase 5 P0 (Scope 5) — alert routing webhook --------------------------------
// Outbound webhook for platform incidents, riding the SAME SSRF-guarded
// signed-POST machinery as tenant webhooks (src/hrm-server/webhooks.ts
// postSigned): send-time DNS resolution (rebinding blocked), redirects
// refused, HMAC-SHA256 signature when a secret is configured, hard timeout.
// Delivery attempts land in the notification feed like every other channel.

export type AlertWebhookResult = { status: "SENT" | "FAILED" | "SKIPPED"; detail?: string }

/** POST one alert event to the configured webhook (SaaSSetting group
 *  "alerts"). SKIPPED when no URL is configured — never throws, so alert
 *  call sites (backup failure, test send) stay non-blocking-safe. */
export async function sendPlatformAlertWebhook(event: string, subject: string, detail: string): Promise<AlertWebhookResult> {
  const settings = await getSaasSettings()
  const url = trim(settings.alerts?.webhookUrl)
  if (!url) return { status: "SKIPPED", detail: "No alert webhook configured (Settings → Platform Settings → Alert Routing)" }
  const secret = trim(settings.alerts?.webhookSecret) || null
  const body = JSON.stringify({
    source: "finix-hr-platform",
    event,
    subject,
    detail,
    sentAt: new Date().toISOString(),
  })
  // dynamic import — webhooks.ts sits on the tenant-plane module graph; a
  // static import here would pull the whole webhook queue into the platform
  // plane's eager graph (no cycle today, but the dynamic form keeps the
  // plane boundary explicit and lazy).
  const { postSigned } = await import("../webhooks")
  const deliveryId = `alert-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  const res = await postSigned(url, secret, event, deliveryId, body)
  const out: AlertWebhookResult = res.ok
    ? { status: "SENT", detail: `HTTP ${res.status}` }
    : { status: "FAILED", detail: res.error || `HTTP ${res.status ?? "network-error"}` }
  await logPlatformNotification("WEBHOOK", subject, [urlHost(url)], out)
  return out
}

/** Host (or host:port) of an alert webhook URL, for the notification feed —
 *  never the full URL with any credentials/query. */
function urlHost(raw: string): string {
  try {
    const u = new URL(raw)
    return `${u.hostname}${u.port ? `:${u.port}` : ""}`
  } catch {
    return "invalid-url"
  }
}

/** Fan an email out to every ACTIVE owner user (optionally only those with a
 *  permission, e.g. "registrations.view" for new-application alerts, or a
 *  fixed set of user ids — support-ticket assignment notifications).
 *  Console-logged per recipient; returns a summary. */
export async function notifyOwnerUsers(
  subject: string,
  body: string,
  opts: { perm?: string; entityId?: string | null; userIds?: string[] } = {}
) {
  const owners = await db.saasOwnerUser.findMany({
    where: { status: "ACTIVE", ...(opts.userIds?.length ? { id: { in: opts.userIds } } : {}) },
    select: { email: true, permissions: true, roleKey: true },
  })
  const { resolveOwnerUserPermissions } = await import("./owner-roles")
  // resolve effective permissions per owner (explicit grants → DB role →
  // static template) before filtering — plain .filter can't await
  const withPerms = await Promise.all(
    owners.map(async (o) => ({ email: o.email, perms: await resolveOwnerUserPermissions(o) }))
  )
  const targets = withPerms.filter((o) => !opts.perm || o.perms.includes(opts.perm))
  let sent = 0, skipped = 0, failed = 0
  for (const t of targets) {
    const res = await sendPlatformEmail(t.email, subject, body)
    if (res.status === "SENT") sent++
    else if (res.status === "SKIPPED") skipped++
    else failed++
    await logPlatformNotification("EMAIL", subject, [t.email], res)
  }
  return { sent, skipped, failed, recipients: targets.map((t) => t.email) }
}

/** Email an external party (applicant / tenant admin / inquirer). */
export async function notifyExternalEmail(
  to: string,
  subject: string,
  body: string,
  _entityId?: string | null,
  opts?: {
    html?: string
    attachments?: { filename: string; content: Buffer | Uint8Array | string; contentType?: string }[]
  }
) {
  const res = await sendPlatformEmail(to, subject, body, opts)
  await logPlatformNotification("EMAIL", subject, [to], res)
  return res
}

// ---------------- password-reset email helper ----------------

/** Build the reset link and send it. In dev with NO gateway configured the
 *  link is echoed to the server console so local testing stays possible —
 *  production always requires the gateway (no secret ever hits the console). */
export async function sendOwnerResetEmail(to: string, token: string, origin: string) {
  const link = `${origin}/owner/reset-password?token=${token}`
  const body =
    `A password reset was requested for the Finix HR Owner Console account ${to}.\n\n` +
    `Open the link below to choose a new password (valid for 60 minutes, single use):\n${link}\n\n` +
    `If you did not request this, ignore this email — your password stays unchanged.\n\n` +
    `— Finix HR Platform`
  const res = await sendPlatformEmail(to, "Owner Console — password reset", body)
  if (res.status === "SKIPPED" && process.env.NODE_ENV !== "production") {
    console.log(`\n[owner-password-reset] dev fallback (no platform email gateway configured)\n  to:   ${to}\n  link: ${link}\n`)
  }
  await logPlatformNotification("EMAIL", "Owner password reset link", [to], res)
  return res
}

// ---------------- registration + billing notification templates ----------------

/** Applicant-facing "application received" confirmation email — sent right
 *  after a successful public.register. Best-effort by contract: a gateway
 *  failure (or unconfigured gateway) SKIPS/FAILS transparently and is logged
 *  to the owner console feed via notifyExternalEmail → logPlatformNotification;
 *  it must NEVER fail the application creation itself. */
export async function notifyApplicantReceived(app: {
  adminEmail: string; adminName: string; organizationName: string; applicationNumber: string
  planName: string | null; origin: string
}) {
  const s = await getSaasSettings()
  if (s.communication.notifyApplicantOnSubmit === false) {
    return { status: "SKIPPED", detail: "applicant confirmation emails disabled in platform settings" }
  }
  const base = String(s.general.websiteUrl || app.origin || "").replace(/\/+$/, "")
  const trackLink = `${base}/registration-status?id=${app.applicationNumber}`
  const body =
    `Dear ${app.adminName},\n\n` +
    `Thank you for submitting your registration application to Finix HR.\n\n` +
    `We confirm that your application for ${app.organizationName} has been received successfully and is now pending review by our team.` +
    (app.planName ? `\nRequested plan: ${app.planName}.` : "") +
    `\n\nApplication Tracking No: ${app.applicationNumber}\n\n` +
    `Track your application: ${trackLink}\n\n` +
    `How to track your application:\n` +
    `1. Open the tracking link above (or go to ${base}/registration-status).\n` +
    `2. Enter your Application Tracking No and your administrator email (${app.adminEmail}).\n` +
    `3. View the current status, review notes and next steps at any time.\n\n` +
    `Keep this email for your records — the Application Tracking Number together with your administrator email is all you need to check your status anytime.\n\n` +
    `— Finix HR Platform`
  const res = await notifyExternalEmail(
    app.adminEmail,
    `Thank you for your application — ${app.applicationNumber} (Finix HR)`,
    body,
    app.applicationNumber
  )
  return res
}

export async function notifyRegistrationSubmitted(app: {
  applicationNumber: string; organizationName: string; adminEmail: string; adminName: string
  employeeCount: number; branchCount: number; planName: string | null; billingCycle: string
}) {
  const s = await getSaasSettings()
  if (!s.communication.notifyOnRegistration) return { sent: 0, skipped: 0, failed: 0, recipients: [] }
  return notifyOwnerUsers(
    `New registration application ${app.applicationNumber}`,
    `${app.organizationName} applied for the platform.\n\n` +
      `Application: ${app.applicationNumber}\nAdmin: ${app.adminName} <${app.adminEmail}>\n` +
      `Scale: ${app.employeeCount} employees · ${app.branchCount} branches\n` +
      `Plan preference: ${app.planName || "none chosen"} (${app.billingCycle.toLowerCase()})\n\n` +
      `Review it under Registrations in the owner console.`,
    { perm: "registrations.view" }
  )
}

export async function notifyInquiryReceived(inq: { name: string; email: string; inquiryType: string; company: string | null; message: string }) {
  const s = await getSaasSettings()
  if (!s.communication.notifyOnRegistration) return { sent: 0, skipped: 0, failed: 0, recipients: [] }
  return notifyOwnerUsers(
    `New ${inq.inquiryType.toLowerCase()} inquiry from ${inq.name}`,
    `${inq.name} <${inq.email}>${inq.company ? ` (${inq.company})` : ""} sent an inquiry.\n\n"${inq.message.slice(0, 500)}"\n\nRespond under Inquiries in the owner console.`,
    { perm: "inquiries.view" }
  )
}

export async function notifyApplicantApproved(app: {
  adminEmail: string; adminName: string; organizationName: string; applicationNumber: string
  planName: string | null; billingCycle: string | null; trialDays: number | null
}) {
  const s = await getSaasSettings()
  if (!s.communication.notifyOnApproval) return { status: "SKIPPED", detail: "approval emails disabled" }
  const body =
    `Good news — your application ${app.applicationNumber} for ${app.organizationName} has been approved.\n\n` +
    (app.planName ? `Plan: ${app.planName}${app.trialDays ? ` (trial, ${app.trialDays} days)` : ` (${(app.billingCycle || "monthly").toLowerCase()} billing)`}\n` : "") +
    `Sign in with your administrator email (${app.adminEmail}) and the password you chose during registration:\n` +
    `${s.general.websiteUrl || ""}/app\n\nWelcome aboard!\n— Finix HR Platform`
  return notifyExternalEmail(app.adminEmail, `Application ${app.applicationNumber} approved — welcome to Finix HR`, body, app.applicationNumber)
}

/** R12 (2026-10-12) — Accept-application email WITH the first invoice.
 *  Distinct from notifyApplicantApproved (plain welcome): Accept provisions
 *  the tenant AND issues the first subscription invoice, and this email
 *  carries the full payment request — invoice number, plan, billing period,
 *  amount, due date and remittance instructions. Plain text on purpose: the
 *  platform gateway wraps paragraphs into styled HTML (WinAnsi-safe — see
 *  R4: no unicode arrows/dashes in outbound mail). */
export async function notifyApplicantAcceptedWithInvoice(x: {
  adminEmail: string; adminName: string; organizationName: string; applicationNumber: string
  planName: string | null; billingCycle: "MONTHLY" | "YEARLY" | null
  periodStart: Date; periodEnd: Date; amount: number; currency: string
  invoiceNumber: string; dueAt: Date | null; trialDays: number | null
  supportEmail: string | null; supportPhone: string | null
}) {
  const money = `${x.currency === "BDT" ? "BDT " : `${x.currency} `}${x.amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  const ymd = (d: Date) => d.toISOString().slice(0, 10)
  const lines: string[] = [
    `Dear ${x.adminName || "Administrator"},`,
    ``,
    `Your application ${x.applicationNumber} for ${x.organizationName} has been ACCEPTED. Your Finix HR workspace is provisioned and ready.`,
    ``,
    `INVOICE ${x.invoiceNumber}`,
    `----------------------------------------`,
    `Plan:                ${x.planName || "(plan on record)"}`,
    `Billing cycle:       ${(x.billingCycle || "MONTHLY").toLowerCase()}`,
    `Billing period:      ${ymd(x.periodStart)} to ${ymd(x.periodEnd)}`,
    `Amount due:          ${money}`,
    x.dueAt ? `Payment due by:      ${ymd(x.dueAt)}` : `Payment due:          on receipt`,
    x.trialDays ? `Trial:               first ${x.trialDays} day(s) on us` : ``,
    ``,
    `PAYMENT INSTRUCTIONS`,
    `----------------------------------------`,
    `Bank: Finix HR Operations Account, Dhaka`,
    `Reference:            your invoice number ${x.invoiceNumber}`,
    `After payment the platform team marks the invoice PAID (Invoices & Payments) and your billing history updates automatically.`,
    ``,
    `NEXT STEPS`,
    `----------------------------------------`,
    `Sign in with your administrator email (${x.adminEmail}) and the password you chose during registration.`,
    x.trialDays ? `Your ${x.trialDays}-day trial is active now; settle the invoice to continue uninterrupted after it ends.` : `Settle the invoice to keep the workspace fully operational past the due date.`,
  ]
  if (x.supportEmail || x.supportPhone) {
    lines.push(``, `Questions about this invoice?`, x.supportEmail ? `Email: ${x.supportEmail}` : ``, x.supportPhone ? `Phone: ${x.supportPhone}` : ``)
  }
  lines.push(``, `Welcome aboard!`, `— Finix HR Platform`)
  const body = lines.join("\n")
  const res = await sendPlatformEmail(x.adminEmail, `Application ${x.applicationNumber} ACCEPTED — invoice ${x.invoiceNumber} (${money})`, body)
  await logPlatformNotification("EMAIL", `Acceptance invoice ${x.invoiceNumber} for ${x.organizationName}`, [x.adminEmail], res)
  return res
}

export async function notifyApplicantRejected(app: {
  adminEmail: string; organizationName: string; applicationNumber: string; reason: string
}) {
  const s = await getSaasSettings()
  if (!s.communication.notifyOnApproval) return { status: "SKIPPED", detail: "approval emails disabled" }
  const body =
    `Thank you for your interest in Finix HR.\n\n` +
    `After review, your application ${app.applicationNumber} for ${app.organizationName} could not be approved at this time.\n\n` +
    `Reason: ${app.reason}\n\n` +
    `You are welcome to re-register with corrected or additional information.\n— Finix HR Platform`
  return notifyExternalEmail(app.adminEmail, `Application ${app.applicationNumber} — update`, body, app.applicationNumber)
}

export async function notifySubscriptionExpiry(sub: {
  vendorId: string; vendorName: string; planName: string; daysRemaining: number; endDate: Date
  adminEmail: string | null
}) {
  const body =
    `Subscription reminder: ${sub.vendorName} (${sub.planName}) expires in ${sub.daysRemaining} day(s) — ${sub.endDate.toISOString().slice(0, 10)}.\n\n` +
    `Renew or extend the subscription from the owner console (Renewals).`
  const owners = await notifyOwnerUsers(`Renewal due: ${sub.vendorName} in ${sub.daysRemaining}d`, body, { perm: "subscriptions.view" })
  let tenantNotify: { status: string; detail?: string } | null = null
  if (sub.adminEmail) {
    tenantNotify = await notifyExternalEmail(
      sub.adminEmail,
      `Your Finix HR subscription expires in ${sub.daysRemaining} day(s)`,
      `Your workspace subscription (${sub.planName}) is due for renewal on ${sub.endDate.toISOString().slice(0, 10)}.\n\n` +
        `Contact the platform team to renew and keep the workspace fully operational — after expiry the workspace becomes read-only (your data is never deleted).\n\n— Finix HR Platform`,
      sub.vendorId
    )
  }
  return { ...owners, tenant: tenantNotify }
}

// ================= WP-H/I/J — billing notification templates (append-only) =================
// Two platform templates added by the billing work packages:
//   - subscription_renewal_reminder: sent by the lifecycle sweep at
//     30/15/7/3/1 days before endDate (deduped per vendor+endDate+daysLeft),
//     with a Pay Now deep link into the tenant Billing portal.
//   - invoice_paid: sent when a gateway payment settles an invoice, with the
//     receipt link (the receipt PDF is downloaded from the Billing portal —
//     the platform email contract is plain-text bodies, no attachments).

/** Build the tenant Billing deep link (Pay Now). Uses the platform's
 *  configured website URL — the tenant app and the public site are the same
 *  deployment (/app). Returns null when no base URL is configured (the email
 *  then falls back to plain instructions). */
function billingDeepLink(s: { general: { websiteUrl: string } }, params: Record<string, string>): string | null {
  const base = String(s.general.websiteUrl || "").replace(/\/+$/, "")
  if (!base) return null
  const qs = new URLSearchParams(params).toString()
  return `${base}/app?view=billing${qs ? `&${qs}` : ""}`
}

/** Renewal reminder — {tenant, plan, endDate, daysLeft} + Pay Now deep link
 *  to the tenant Billing view with the open invoice attached. Owner users
 *  (subscriptions.view) get the platform-side notice. */
export async function notifySubscriptionRenewalReminder(sub: {
  vendorId: string; vendorName: string; planName: string; endDate: Date; daysLeft: number
  adminEmail: string | null; openInvoiceId: string | null
}) {
  const s = await getSaasSettings()
  const payLink = billingDeepLink(s, sub.openInvoiceId ? { invoiceId: sub.openInvoiceId } : {})
  const tenantBody =
    `Your Finix HR subscription renewal is due in ${sub.daysLeft} day(s).\n\n` +
    `Workspace: ${sub.vendorName}\nPlan: ${sub.planName}\nRenews / ends: ${sub.endDate.toISOString().slice(0, 10)}\n\n` +
    (payLink
      ? `Pay now and keep the workspace fully operational:\n${payLink}\n\n` +
        `You can also review invoices and payment history any time under Billing in your workspace.`
      : `Sign in to your workspace and open Billing to review the open invoice and pay it, or contact the platform team to renew.`) +
    `\n\nAfter the renewal date (plus any grace period) the workspace becomes read-only — your data is never deleted.\n\n— Finix HR Platform`
  const owners = await notifyOwnerUsers(
    `Renewal reminder: ${sub.vendorName} in ${sub.daysLeft}d`,
    `Subscription reminder: ${sub.vendorName} (${sub.planName}) expires in ${sub.daysLeft} day(s) — ${sub.endDate.toISOString().slice(0, 10)}.\n\n` +
      `The tenant has been sent a self-service renewal reminder (Billing portal).`,
    { perm: "subscriptions.view" }
  )
  let tenantNotify: { status: string; detail?: string } | null = null
  if (sub.adminEmail) {
    tenantNotify = await notifyExternalEmail(
      sub.adminEmail,
      `Your Finix HR subscription renews in ${sub.daysLeft} day(s)`,
      tenantBody,
      sub.vendorId
    )
  }
  return { ...owners, tenant: tenantNotify }
}

/** Invoice-paid receipt notice — sent when a gateway payment settles an
 *  invoice. The receipt itself is generated in the tenant Billing portal
 *  (Download Receipt); this email carries the deep link + the payment facts.
 *  Owner users (billing.view) get the platform-side copy. */
export async function notifyInvoicePaid(x: {
  vendorId: string; vendorName: string | null
  adminEmail: string | null; adminName: string | null
  invoiceNumber: string; amount: number; currency: string
  planName: string | null
  periodStart: Date; periodEnd: Date
  method: string; provider: string; providerTxnId: string | null
  paidAt: Date; extended: boolean
}) {
  const s = await getSaasSettings()
  // 2026-10-25 (master prompt Part H §13.3) — configurable thank-you/receipt
  // delivery. Both flags default ON; the owner can silence either email
  // without touching the payment/journal pipeline (the financial record and
  // the downloadable PDF receipt are unaffected).
  if (s.subscription.receiptEmailEnabled === false && s.subscription.thankYouEmailEnabled === false) {
    return { skipped: true, tenant: null } as any
  }
  // receipt deep link anchored on the invoice NUMBER (human-meaningful in an
  // email, and what the Billing view's deep-link param expects)
  const receiptLink = billingDeepLink(s, { invoiceId: x.invoiceNumber })
  const vendorName = x.vendorName || (await (async () => {
    const { db } = await import("@/lib/db")
    const v = await db.vendor.findUnique({ where: { id: x.vendorId }, select: { name: true } })
    return v?.name || "tenant"
  })())
  const money = `${x.currency === "BDT" ? "৳" : x.currency + " "}${x.amount.toLocaleString("en-IN")}`
  const body =
    `Payment received — thank you.\n\n` +
    `Invoice: ${x.invoiceNumber}\nAmount: ${money}\nPlan: ${x.planName || "—"}\n` +
    `Billing period: ${x.periodStart.toISOString().slice(0, 10)} → ${x.periodEnd.toISOString().slice(0, 10)}\n` +
    `Paid via: ${x.provider} (${x.method})${x.providerTxnId ? `\nTransaction: ${x.providerTxnId}` : ""}\n` +
    `Paid at: ${x.paidAt.toISOString().slice(0, 19).replace("T", " ")} UTC\n\n` +
    (x.extended ? `Your subscription has been renewed and extended by one billing cycle.\n` : "") +
    (receiptLink
      ? `Download the official receipt (PDF) from your workspace:\n${receiptLink}\n`
      : `Sign in to your workspace → Billing to download the official receipt (PDF).\n`) +
    `\n— Finix HR Platform`
  const owners = await notifyOwnerUsers(
    `Payment received: ${x.invoiceNumber} (${money})`,
    `Invoice ${x.invoiceNumber} for ${vendorName} was paid via ${x.provider}${x.providerTxnId ? ` (txn ${x.providerTxnId})` : ""} — ${money}${x.extended ? "; subscription extended one cycle" : ""}.`,
    { perm: "billing.view" }
  )
  let tenantNotify: { status: string; detail?: string } | null = null
  if (x.adminEmail) {
    tenantNotify = await notifyExternalEmail(x.adminEmail, `Payment received — ${x.invoiceNumber} (Finix HR)`, body, x.invoiceNumber)
  }
  return { ...owners, tenant: tenantNotify }
}

// ================= R15 (2026-10-12) — expiry notice engine =================
// One helper drives PRE-expiry reminders AND post-expiry rejoin/renewal
// nudges, on EMAIL always and SMS when subscription.expirySmsEnabled. Every
// ATTEMPT is journaled as a SaasExpiryNotice row (unique per vendor+kind+
// refDate+offset+channel = duplicate prevention); FAILED rows are retried by
// the next lifecycle sweep run (attempts < 3). Credentials never leave the
// gateway modules — only status/detail strings are stored.
export async function notifyExpiryNotice(x: {
  vendorId: string
  vendorName: string
  planName: string
  endDate: Date
  /** days before (positive) / after (negative convention used for refDate math;
   *  the notice's daysOffset value) */
  daysOffset: number
  kind: "PRE_EXPIRY" | "POST_EXPIRY" | "REJOIN_OFFER"
  adminEmail: string | null
  adminPhone: string | null
  smsEnabled: boolean
}): Promise<{ email: { status: string; detail?: string }; sms: { status: string; detail?: string } | null }> {
  const s = await getSaasSettings()
  const refDate = x.endDate.toISOString().slice(0, 10)
  const channels: ("EMAIL" | "SMS")[] = x.smsEnabled && x.adminPhone ? ["EMAIL", "SMS"] : ["EMAIL"]

  // ---------- bodies ----------
  const post = x.daysOffset < 0
  const rejoinLine = s.subscription.rejoinOfferEnabled
    ? `\nRejoining is easy: reply to this email or sign in and renew — your data, employees and payroll history are intact, and returning customers keep their original plan price.`
    : ""
  const emailSubject = post
    ? `Your Finix HR workspace expired ${Math.abs(x.daysOffset)} day(s) ago — reactivate any time`
    : `Your Finix HR subscription expires in ${x.daysOffset} day(s)`
  const emailBody = post
    ? `Your Finix HR subscription has expired.\n\n` +
      `Workspace: ${x.vendorName}\nPlan: ${x.planName}\nExpired on: ${refDate}\n\n` +
      `The workspace is read-only right now — your data is safe and will never be deleted.\n\n` +
      `To restore full access: sign in to your workspace and renew from the Billing page, or contact the platform team.${rejoinLine}\n\n— Finix HR Platform`
    : `Your Finix HR subscription (${x.planName}) expires on ${refDate} — ${x.daysOffset} day(s) from now.\n\n` +
      `Workspace: ${x.vendorName}\n\n` +
      `Renew before the date (plus any grace period) to keep the workspace fully operational. Sign in → Billing to review invoices and pay, or contact the platform team.\n\n` +
      `After expiry the workspace becomes read-only — your data is never deleted.\n\n— Finix HR Platform`
  const smsBody = post
    ? `Finix HR: subscription expired ${Math.abs(x.daysOffset)}d ago. Data safe, workspace read-only. Sign in to Billing to reactivate.`
    : `Finix HR: subscription expires in ${x.daysOffset}d (${refDate}). Renew from Billing to avoid read-only mode.`

  // ---------- per-channel attempt + journal ----------
  const attemptChannel = async (channel: "EMAIL" | "SMS") => {
    // dedupe / retry lookup
    const existing = await db.saasExpiryNotice.findUnique({
      where: { vendorId_kind_refDate_daysOffset_channel: { vendorId: x.vendorId, kind: x.kind, refDate, daysOffset: x.daysOffset, channel } },
    })
    if (existing && (existing.status === "SENT" || existing.attempts >= 3)) return { status: existing.status, detail: existing.detail || undefined }

    const res = channel === "EMAIL"
      ? (x.adminEmail
          ? await notifyExternalEmail(x.adminEmail, emailSubject, emailBody, x.vendorId)
          : { status: "SKIPPED", detail: "no admin email on file" })
      : await sendPlatformSms(x.adminPhone || "", smsBody)

    const status = res.status
    const detail = res.detail
    if (existing) {
      await db.saasExpiryNotice.update({
        where: { id: existing.id },
        data: { status, detail, attempts: { increment: 1 }, sentAt: new Date() },
      })
    } else {
      await db.saasExpiryNotice.create({
        data: { vendorId: x.vendorId, kind: x.kind, refDate, daysOffset: x.daysOffset, channel, status, detail, attempts: 1, sentAt: new Date() },
      }).catch(async (e: any) => {
        // unique race (concurrent sweep) — record as an increment instead
        if (String(e?.code) === "P2002") {
          await db.saasExpiryNotice.updateMany({
            where: { vendorId: x.vendorId, kind: x.kind, refDate, daysOffset: x.daysOffset, channel },
            data: { status, detail, attempts: { increment: 1 }, sentAt: new Date() },
          })
        }
      })
    }
    return { status, detail }
  }

  const email = await attemptChannel("EMAIL")
  const sms = channels.includes("SMS") ? await attemptChannel("SMS") : null
  return { email, sms }
}

// ================= Invoice Generated Automated Email (With 2-Page PDF Attachment) =================
/**
 * Automated email sent when an invoice is issued (registration accepted,
 * term renewal, manual creation, plan upgrade).
 * Uses dynamic VAT % from SaaS Owner Settings (SaaSSetting group "billing"),
 * embeds standard Bangladesh VAT inclusive calculations, attaches the
 * official 2-page Finix HR invoice PDF, and links to client billing portal.
 */
export async function notifyInvoiceIssued(invoiceId: string) {
  try {
    const inv = await db.saasInvoice.findUnique({
      where: { id: invoiceId },
      include: {
        subscription: true,
        payments: { where: { status: "PAID" }, orderBy: { paidAt: "desc" } },
      },
    })
    if (!inv) return { status: "SKIPPED", detail: `invoice ${invoiceId} not found` }

    const vendor = await db.vendor.findUnique({
      where: { id: inv.vendorId },
      select: { id: true, name: true, legalName: true, address: true, phone: true, email: true },
    })
    if (!vendor) return { status: "SKIPPED", detail: `vendor ${inv.vendorId} not found` }

    // Resolve recipient admin email
    let adminEmail = vendor.email
    let adminName = vendor.legalName || vendor.name
    if (!adminEmail) {
      const adminUser = await db.user.findFirst({
        where: { vendorId: vendor.id, role: { in: ["HR_ADMIN", "VENDOR_OWNER"] } },
        orderBy: { createdAt: "asc" },
      })
      if (adminUser) {
        adminEmail = adminUser.email
        adminName = adminUser.name || adminName
      }
    }

    if (!adminEmail && inv.registrationId) {
      const reg = await db.saasRegistration.findUnique({
        where: { id: inv.registrationId },
        select: { adminEmail: true, adminName: true, organizationName: true, address: true, contactNumber: true },
      })
      if (reg) {
        adminEmail = reg.adminEmail
        adminName = reg.organizationName || reg.adminName || adminName
      }
    }

    if (!adminEmail) {
      return { status: "SKIPPED", detail: "no admin email found for vendor" }
    }

    const settings = await getSaasSettings()
    const billing = settings.billing
    const vatRate = Number(inv.vatRatePercent ?? billing.vatRatePercent ?? 5.0)
    const total = Number(inv.amount) || 0
    const net = Number(inv.netAmount) > 0 ? Number(inv.netAmount) : (vatRate > 0 ? Math.round((total / (1 + vatRate / 100)) * 100) / 100 : total)
    const vat = Number(inv.vatAmount) > 0 ? Number(inv.vatAmount) : Math.round((total - net) * 100) / 100
    const isPaid = inv.status === "PAID"
    const paid = isPaid ? total : 0
    const due = total - paid

    const fmtLongDate = (d: Date | null) => {
      if (!d) return "-"
      const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"]
      return `${String(d.getDate()).padStart(2, "0")} ${months[d.getMonth()]} ${d.getFullYear()}`
    }

    const issuedDateStr = fmtLongDate(inv.issuedAt)
    const dueDateStr = fmtLongDate(inv.dueAt || inv.periodEnd)

    const base = String(settings.general.websiteUrl || "").replace(/\/+$/, "")
    const payUrl = `${base}/app?view=billing&invoiceId=${encodeURIComponent(inv.number)}`
    const portalUrl = `${base}/app?view=billing`

    // Generate the 2-page PDF invoice
    const { renderInvoicePdf } = await import("./payments/invoice-pdf")
    const gen = settings.general
    const pdfBytes = await renderInvoicePdf({
      platformName: gen.platformName || "Finix HR",
      tagline: gen.tagline || "Standalone HRM & Workforce Platform",
      websiteUrl: gen.websiteUrl || (billing.companyWebsite ? (billing.companyWebsite.startsWith("http") ? billing.companyWebsite : `https://${billing.companyWebsite}`) : "https://hrm.finixmart.com.bd"),
      supportEmail: gen.supportEmail || billing.companyEmail || "support@finixhr.com",
      logoUrl: gen.logoUrl || "",
      invoiceNumber: inv.number,
      issuedAt: inv.issuedAt,
      dueAt: inv.dueAt,
      status: inv.status,
      companyLegalName: billing.companyLegalName || "Finix HR Ltd.",
      companyBin: billing.companyBin || "009377515-0111",
      companyAddress: gen.address || billing.companyAddress || "House 11, Road 6, Sector 16/A, Uttara, Dhaka - 1230",
      companyPhone: gen.supportPhone || billing.companyPhone || "+8809643666888",
      companyEmail: gen.supportEmail || billing.companyEmail || "service@finixhr.com",
      companyWebsite: billing.companyWebsite || "finixhr.com",
      customerName: vendor.legalName || vendor.name,
      customerAddress: vendor.address,
      customerPhone: vendor.phone,
      customerEmail: vendor.email || adminEmail,
      planName: inv.subscription?.planName || "Cloud HR",
      billingCycle: inv.subscription?.billingCycle || "MONTHLY",
      periodStart: inv.periodStart,
      periodEnd: inv.periodEnd,
      amount: total,
      currency: inv.currency,
      vatRatePercent: vatRate,
      transactions: inv.payments.map((p) => ({
        date: p.paidAt,
        gateway: p.provider || p.method || "GATEWAY",
        transactionId: p.providerTxnId || p.transactionId || "-",
        amount: Number(p.amount) || total,
      })),
      primaryBank: {
        bankName: String(billing.primaryBankName || "The City Bank Ltd."),
        accountNo: String(billing.primaryAccountNo || "1233394761001"),
        payeeName: String(billing.primaryAccountName || billing.companyLegalName || "Finix HR Ltd."),
        branch: String(billing.primaryBranch || "Shyamoli"),
        routing: String(billing.primaryRouting || "225264300"),
      },
      secondaryBank: {
        bankName: String(billing.secondaryBankName || "BRAC Bank PLC"),
        accountNo: String(billing.secondaryAccountNo || "2081769340001"),
        payeeName: String(billing.secondaryAccountName || billing.companyLegalName || "Finix HR Ltd."),
        branch: String(billing.secondaryBranch || "Satmasjid Road Branch"),
        routing: String(billing.secondaryRouting || "060276074"),
      },
      bkash: {
        merchantNumber: String(billing.bkashMerchantNumber || "01943223366"),
      },
    })

    const subject = `Invoice Generated #${inv.number}`

    const plainText = [
      `Dear ${adminName},`,
      ``,
      `A new invoice has been generated on ${issuedDateStr}. The summary is below.`,
      ``,
      `Invoice #${inv.number} [${isPaid ? "PAID" : "DUE"}]`,
      `Due Amount:        ${due.toFixed(2)} BDT`,
      `VAT (${vatRate}% inclusive): ${vat.toFixed(2)} BDT`,
      `Paid Amount:       ${paid.toFixed(2)} BDT`,
      `Total:             ${total.toFixed(2)} BDT`,
      `Due Date:          ${dueDateStr}`,
      ``,
      !isPaid ? `Pay Now: ${payUrl}\n` : ``,
      `You can also log in to your client area to view and pay the invoice at ${portalUrl}.`,
      ``,
      `The Mushak 6.3 VAT form (চালানপত্র) for this invoice is available for download on the invoice details page.`,
      ``,
      `Sincerely,`,
      `The Finix HR Team`,
    ].filter(Boolean).join("\n")

    const htmlBody = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: #1e293b; background-color: #f8fafc; margin: 0; padding: 24px 12px; }
    .wrapper { max-width: 580px; margin: 0 auto; background: #ffffff; border-radius: 8px; border: 1px solid #e2e8f0; padding: 28px 24px; box-shadow: 0 1px 3px rgba(0,0,0,0.05); }
    .logo-block { text-align: center; margin-bottom: 24px; }
    .logo-title { font-size: 26px; font-weight: 800; color: #162055; letter-spacing: -0.5px; }
    .logo-desc { font-size: 11px; font-weight: 600; color: #2563eb; text-transform: uppercase; letter-spacing: 1.2px; margin-top: 2px; }
    .salutation { font-size: 15px; margin-bottom: 14px; color: #0f172a; line-height: 1.5; }
    .intro { font-size: 14px; margin-bottom: 22px; color: #334155; line-height: 1.5; }
    .invoice-card { border: 1px solid #e2e8f0; border-radius: 8px; overflow: hidden; margin-bottom: 24px; background: #ffffff; }
    .card-header-bar { background-color: #162055; padding: 12px 18px; }
    .table-data { width: 100%; border-collapse: collapse; }
    .table-data td { padding: 12px 18px; border-bottom: 1px solid #f1f5f9; font-size: 13.5px; }
    .table-data tr:last-child td { border-bottom: none; }
    .td-name { color: #64748b; font-weight: 500; }
    .td-val { text-align: right; color: #0f172a; font-weight: 600; }
    .td-val-bold { text-align: right; color: #0f172a; font-weight: 800; font-size: 14px; }
    .btn-wrap { text-align: center; margin: 26px 0; }
    .btn-action { background-color: #162055; color: #ffffff !important; padding: 12px 36px; border-radius: 6px; font-size: 14px; font-weight: 700; text-decoration: none; display: inline-block; }
    .subtext { font-size: 13.5px; color: #334155; line-height: 1.6; margin-bottom: 14px; }
    .subtext a { color: #2563eb; text-decoration: underline; }
    .signoff { font-size: 14px; color: #0f172a; margin-top: 24px; line-height: 1.5; }
  </style>
</head>
<body>
  <div class="wrapper">
    <div class="logo-block">
      <div class="logo-title">FINIX HR</div>
      <div class="logo-desc">Workforce &amp; Payroll Solutions</div>
    </div>

    <p class="salutation">Dear <b>${escHtml(adminName)}</b>,</p>
    <p class="intro">A new invoice has been generated on ${issuedDateStr}. The summary is below.</p>

    <div class="invoice-card">
      <div class="card-header-bar">
        <table style="width: 100%;">
          <tr>
            <td style="color: #ffffff; font-size: 15px; font-weight: 700;">Invoice #${inv.number}</td>
            <td style="text-align: right;">
              <span style="background-color: ${isPaid ? "#16a34a" : "#ea9708"}; color: #ffffff; font-size: 11px; font-weight: 700; padding: 3px 12px; border-radius: 12px; text-transform: uppercase; letter-spacing: 0.5px; display: inline-block;">
                ${isPaid ? "PAID" : "DUE"}
              </span>
            </td>
          </tr>
        </table>
      </div>
      <table class="table-data">
        <tr>
          <td class="td-name">Due Amount</td>
          <td class="td-val-bold">${due.toFixed(2)} BDT</td>
        </tr>
        <tr>
          <td class="td-name">VAT (${vatRate}% inclusive)</td>
          <td class="td-val">${vat.toFixed(2)} BDT</td>
        </tr>
        <tr>
          <td class="td-name">Paid Amount</td>
          <td class="td-val">${paid.toFixed(2)} BDT</td>
        </tr>
        <tr>
          <td class="td-name">Total</td>
          <td class="td-val-bold">${total.toFixed(2)} BDT</td>
        </tr>
        <tr>
          <td class="td-name">Due Date</td>
          <td class="td-val">${dueDateStr}</td>
        </tr>
      </table>
    </div>

    ${!isPaid ? `
    <div class="btn-wrap">
      <a href="${payUrl}" class="btn-action">Pay Now</a>
    </div>` : ""}

    <p class="subtext">
      You can also log in to your client area to view and pay the invoice at <a href="${portalUrl}">${portalUrl}</a>.
    </p>

    <p class="subtext">
      The Mushak 6.3 VAT form (চালানপত্র) for this invoice is available for download on the invoice details page.
    </p>

    <div class="signoff">
      Sincerely,<br />
      <b>The Finix HR Team</b>
    </div>
  </div>
</body>
</html>`

    return await notifyExternalEmail(adminEmail, subject, plainText, inv.id, {
      html: htmlBody,
      attachments: [
        {
          filename: `Invoice-${inv.number}.pdf`,
          content: Buffer.from(pdfBytes),
          contentType: "application/pdf",
        },
      ],
    })
  } catch (err: any) {
    console.error("notifyInvoiceIssued error:", err)
    return { status: "FAILED", detail: String(err?.message || err).slice(0, 300) }
  }
}


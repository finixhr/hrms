// ============ Event-driven delivery channels (spec §12.2, §12.3, §9.7, §13.5) ============
// In-app notifications stay the always-on channel; Email / SMS fire only when the
// vendor enables them per event (Settings → Notifications / Wishes). Every send is
// best-effort: failures never break the workflow, results land in CommunicationLog.
import { db } from "@/lib/db"
import { getSettings } from "./settings"
import { sendEmail, sendSms } from "./gateway"
import { notify, NotifyTarget } from "./audit"
import { buildPayslipHtml } from "./payslip"
import {
  effectiveMessageTemplate, renderMessageTemplate, SYSTEM_TEMPLATE_BY_KEY,
} from "./message-templates"

async function employeeContact(vendorId: string, employeeId: string) {
  const emp = await db.employee.findFirst({ where: { id: employeeId, vendorId }, select: { fullName: true, officialEmail: true, personalEmail: true, mobile: true } })
  return emp || null
}

// HRM-021 — event keys of the notification preferences matrix (Settings → Notifications)
// 2026-10 round — extended with the employee-lifecycle automation events:
// account creation, credential delivery, password reset, decisions on
// leave/loan/advance/expense, promotion/transfer/salary revision and
// employee status (suspend/activate/terminate). Every key here has at least
// one wired call site that consults eventChannels() — no dead switches.
export const NOTIFY_EVENTS = [
  "leave_request", "leave_decision", "payslip_generated", "salary_credited", "attendance_alert", "document_expiry",
  "resignation_submitted", "loan_request", "loan_decision", "advance_request", "advance_decision",
  "expense_request", "expense_decision", "performance_review",
  "employee_account_created", "employee_credentials", "password_reset",
  "promotion", "transfer", "shift_change", "salary_revision", "employee_status",
] as const

/** HRM-021 — resolve the enabled channels for an event from the vendor's matrix.
 *  Falls back to the legacy flat toggles when no matrix row exists. */
export function eventChannels(settings: any, eventKey: string, legacy: { email?: boolean; sms?: boolean } = {}): { email: boolean; sms: boolean; inApp: boolean } {
  const row = settings?.notificationMatrix?.[eventKey]
  if (row && typeof row === "object") {
    return { email: !!row.email, sms: !!row.sms, inApp: row.inApp !== false }
  }
  return { email: !!legacy.email, sms: !!legacy.sms, inApp: true }
}

/** Record a delivery attempt in the Communication log (audit-visible). */
async function logDelivery(vendorId: string, channel: string, employeeId: string, subject: string, status: string, detail?: string) {
  try {
    const emp = await db.employee.findFirst({ where: { id: employeeId }, select: { fullName: true, officialEmail: true, personalEmail: true, mobile: true } })
    const log = await db.communicationLog.create({
      data: {
        vendorId, channel, subject: subject.slice(0, 200), message: subject.slice(0, 500),
        audienceType: "EVENT", audienceLabel: "Automated event notification",
        recipientCount: 1,
        deliveredCount: status === "SENT" ? 1 : 0,
        failedCount: status === "FAILED" ? 1 : 0,
        skippedCount: status === "SKIPPED" ? 1 : 0,
        status: summaryStatus(status),
      },
    })
    await db.communicationRecipient.create({
      data: {
        vendorId: log.vendorId, // DB-02 (R5)
        logId: log.id, employeeId,
        employeeName: emp?.fullName || null,
        email: emp?.officialEmail || emp?.personalEmail || null,
        phone: emp?.mobile || null,
        emailStatus: channel === "EMAIL" ? status : "NA",
        smsStatus: channel === "SMS" ? status : "NA",
        detail: detail || null,
      },
    })
  } catch { /* logging must never break delivery */ }
}
function summaryStatus(s: string) {
  return s === "SENT" ? "SENT" : s === "FAILED" ? "FAILED" : "SKIPPED"
}

/**
 * In-app notification + optional email/SMS to the same employee target.
 * HRM-021 — when `eventKey` is provided the per-event × per-channel matrix in
 * Settings decides the channels; the legacy `channels` object is only a fallback
 * for events without a matrix row. In-app is always delivered.
 *
 * 2026-10 restructure — Email/SMS BODIES now render from the system message
 * templates (HR Settings → Templates → SMS / Email Templates). Precedence:
 *   1. tenant-edited template for this event (settings.messageTemplates)
 *   2. system default template — but ONLY when the call site supplied `vars`
 *      (the defaults reproduce the historical inline strings 1:1; a call site
 *      without vars keeps its own inline title/message so nothing regresses)
 *   3. the call site's inline title/message (legacy behavior)
 * Common variables ({{name}}, {{company}}, {{date}}) are resolved here; the
 * call site supplies event-specific ones via `vars`.
 */
export async function notifyChannels(
  vendorId: string,
  target: NotifyTarget,
  title: string,
  message: string,
  type: string,
  link?: string,
  channels: { email?: boolean; sms?: boolean } = {},
  eventKey?: string,
  vars: Record<string, string | number | null | undefined> = {},
) {
  const settings = await getSettings(vendorId)
  const use = eventKey ? eventChannels(settings, eventKey, channels) : { email: !!channels.email, sms: !!channels.sms, inApp: true }
  if (use.inApp) await notify(vendorId, target, title, message, type, link)
  const employeeId = "employeeId" in target ? target.employeeId : null
  if (!employeeId) return
  const emp = await employeeContact(vendorId, employeeId)
  if (!emp) return

  // ---- template resolution (see header comment for precedence) ----
  const overrides = (settings as any).messageTemplates || {}
  const ov = overrides[eventKey || ""]
  const hasOverride = !!ov && (
    String(ov.emailSubject || "").trim() !== "" ||
    String(ov.emailBody || "").trim() !== "" ||
    String(ov.smsBody || "").trim() !== ""
  )
  const hasVars = Object.keys(vars).length > 0
  const tpl = eventKey && SYSTEM_TEMPLATE_BY_KEY[eventKey]
    ? effectiveMessageTemplate(overrides, eventKey)
    : null
  const useTemplate = !!(tpl && (hasOverride || hasVars))
  const mergedVars: Record<string, string | number | null | undefined> = {
    name: emp.fullName,
    company: settings.general.companyName,
    date: new Date().toISOString().slice(0, 10),
    ...vars,
  }
  const emailSubject = useTemplate && tpl ? renderMessageTemplate(tpl.emailSubject, mergedVars) || title : title
  const emailBody = useTemplate && tpl ? renderMessageTemplate(tpl.emailBody, mergedVars) || message : message
  const smsText = useTemplate && tpl
    ? renderMessageTemplate(tpl.smsBody, mergedVars) || `${title}: ${message}`.slice(0, 300)
    : `${title}: ${message}`.slice(0, 300)

  if (use.email) {
    const to = emp.officialEmail || emp.personalEmail || ""
    const res = await sendEmail(vendorId, to, emailSubject, emailBody)
    await logDelivery(vendorId, "EMAIL", employeeId, emailSubject, res.status, res.detail)
  }
  if (use.sms) {
    const res = await sendSms(vendorId, emp.mobile || "", smsText.slice(0, 300))
    await logDelivery(vendorId, "SMS", employeeId, title, res.status, res.detail)
  }
}

/** Payslip email (spec §9.7 outputs: Preview, PDF, Print, Download, Email, Portal). */
export async function emailPayslip(vendorId: string, entryId: string, opts: { force?: boolean } = {}): Promise<{ status: string; detail?: string }> {
  const settings = await getSettings(vendorId)
  // HRM-021 — payslip_generated matrix row decides the email channel
  const ch = eventChannels(settings, "payslip_generated", { email: settings.notification.payslipEmail })
  if (!opts.force && !ch.email) return { status: "SKIPPED", detail: "payslip email disabled in settings" }
  const html = await buildPayslipHtml(vendorId, entryId)
  if (!html) return { status: "FAILED", detail: "payslip not found" }
  const entry = await db.payrollEntry.findUnique({ where: { id: entryId }, include: { run: true } })
  const emp = await db.employee.findUnique({ where: { id: entry?.employeeId || "" } })
  const to = emp?.officialEmail || emp?.personalEmail
  if (!to) return { status: "SKIPPED", detail: "no email on file" }
  // 2026-10 restructure — subject/text render from the payslip_generated
  // system template (tenant-editable in HR Settings → Templates); the default
  // reproduces the historical strings exactly.
  const { effectiveMessageTemplate, renderMessageTemplate } = await import("./message-templates")
  const period = entry?.run ? `${monthName(entry.run.periodMonth)} ${entry.run.periodYear}` : ""
  const tpl = effectiveMessageTemplate((settings as any).messageTemplates, "payslip_generated")
  const tvars = {
    name: emp?.fullName || "", company: settings.general.companyName,
    payslipNumber: entry?.payslipNumber || "", period, netPay: (entry?.net || 0).toFixed(0),
  }
  const subject = renderMessageTemplate(tpl?.emailSubject || "", tvars) || `Payslip ${entry?.payslipNumber} — ${settings.general.companyName}`
  // plain-text companion so the slip content survives clients without HTML
  const text = renderMessageTemplate(tpl?.emailBody || "", tvars) ||
    `Dear ${emp?.fullName},\n\nYour salary slip ${entry?.payslipNumber} is attached below and also available in your employee portal.\nNet pay: ৳${(entry?.net || 0).toLocaleString("en-IN")}\n\n${settings.general.companyName}`
  const res = await sendEmail(vendorId, to, subject, text)
  await logDelivery(vendorId, "EMAIL", entry?.employeeId || "", subject, res.status, res.detail)
  if (entry) {
    await db.payrollEntry.update({ where: { id: entry.id }, data: { emailStatus: res.status === "SENT" ? "SENT" : res.status } }).catch(() => null)
  }
  return res
}

/** Month name helper (1-based) for the payslip period label. */
function monthName(m: number): string {
  return ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"][Math.max(1, Math.min(12, m || 1)) - 1]
}

/** Letter email delivery (spec §13.5 Email output) — sends the full print-ready
 *  HTML document directly so the employee can print from their inbox. */
export async function emailLetter(vendorId: string, _letterId: string, html: string, subject: string, employeeId: string): Promise<{ status: string; detail?: string }> {
  const emp = await db.employee.findUnique({ where: { id: employeeId } })
  const to = emp?.officialEmail || emp?.personalEmail
  if (!to) return { status: "SKIPPED", detail: "no email on file" }
  const s = await getSettings(vendorId, { maskSecrets: false })
  const e = s.email
  if (!e.enabled || !e.host?.trim() || !e.username?.trim() || !e.password) {
    await logDelivery(vendorId, "EMAIL", employeeId, subject, "SKIPPED", "email gateway not configured")
    return { status: "SKIPPED", detail: "email gateway not configured" }
  }
  try {
    const mod = (await import("nodemailer")) as any
    const transporter = mod.default?.createTransport?.({
      host: e.host.trim(), port: Number(e.port) || 587, secure: !!e.secure || Number(e.port) === 465,
      auth: { user: e.username.trim(), pass: e.password },
    })
    const from = e.fromAddress?.trim() || e.username.trim()
    await transporter.sendMail({
      from: e.fromName?.trim() ? `"${e.fromName.trim()}" <${from}>` : from, to, subject,
      text: "Your official HR letter is attached in HTML format.",
      html,
    })
    await logDelivery(vendorId, "EMAIL", employeeId, subject, "SENT")
    return { status: "SENT" }
  } catch (err: any) {
    const detail = String(err?.message || err).slice(0, 300)
    await logDelivery(vendorId, "EMAIL", employeeId, subject, "FAILED", detail)
    return { status: "FAILED", detail }
  }
}

/** Birthday / joining-anniversary wish fan-out honoring the vendor's channel
 *  toggles and editable templates (spec §12.2). */
export async function deliverWishes(vendorId: string, date: string) {
  const settings = await getSettings(vendorId)
  if (!settings.wishes.birthdayEnabled && !settings.wishes.anniversaryEnabled) return { sent: 0 }
  const mmdd = date.slice(5)
  const year = Number(date.slice(0, 4))
  const emps = await db.employee.findMany({ where: { vendorId, status: { in: ["ACTIVE", "PROBATION"] } } })
  let sent = 0
  for (const e of emps) {
    const displayName = e.preferredName || e.fullName
    if (settings.wishes.birthdayEnabled && e.dob && e.dob.slice(5) === mmdd) {
      const message = settings.wishes.birthdayTemplate
        .replace(/{{name}}/g, displayName).replace(/{{company}}/g, settings.general.companyName)
      await deliverWish(vendorId, e, "Happy Birthday!", message, "WISH", settings)
      sent++
    }
    if (settings.wishes.anniversaryEnabled && e.joiningDate && e.joiningDate.slice(5) === mmdd && e.joiningDate.slice(0, 4) !== String(year)) {
      const years = year - Number(e.joiningDate.slice(0, 4))
      const ordinal = years % 10 === 1 && years % 100 !== 11 ? "st" : years % 10 === 2 && years % 100 !== 12 ? "nd" : years % 10 === 3 && years % 100 !== 13 ? "rd" : "th"
      const message = settings.wishes.anniversaryTemplate
        .replace(/{{name}}/g, displayName).replace(/{{years}}/g, String(years))
        .replace(/{{ordinal}}/g, ordinal).replace(/{{company}}/g, settings.general.companyName)
      await deliverWish(vendorId, e, `Happy ${years}${ordinal} Work Anniversary!`, message, "WISH", settings)
      sent++
    }
  }
  return { sent }
}

async function deliverWish(vendorId: string, emp: any, title: string, message: string, type: string, settings: any) {
  if (settings.wishes.inAppEnabled !== false) {
    await notify(vendorId, { employeeId: emp.id }, title, message, type, "ess")
  }
  if (settings.wishes.emailEnabled) {
    const to = emp.officialEmail || emp.personalEmail
    const res = await sendEmail(vendorId, to, title, message)
    await logDelivery(vendorId, "EMAIL", emp.id, title, res.status, res.detail)
  }
  if (settings.wishes.smsEnabled) {
    // Wave 10 — journaled pipeline purpose tagging (birthday/anniversary wishes)
    const res = await sendSms(vendorId, emp.mobile || "", message, "WISHES")
    await logDelivery(vendorId, "SMS", emp.id, title, res.status, res.detail)
  }
}

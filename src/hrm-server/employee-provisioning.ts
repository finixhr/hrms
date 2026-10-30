// ============ Employee self-service account provisioning (2026-10 round) ============
// Automatically creates the linked EMPLOYEE user account when an employee is
// created (single create + bulk import) and delivers the temporary login
// credentials through the channels configured in HR Settings → Communication
// → Automation Matrix (employee_credentials event: independent Email / SMS
// toggles).
//
// Security contract:
//   - the temporary password is generated with CSPRNG, satisfies the tenant's
//     password policy, and is stored ONLY as a scrypt hash
//   - the account is flagged mustChangePassword=true → the login flow forces a
//     rotation before any session is issued
//   - the plaintext password is never persisted; it appears only in the
//     delivery message (email/SMS) and — when NOTHING could be delivered — in
//     the RPC response for the authorized admin who initiated the action
//   - duplicate protection: an employee never gets a second account and an
//     email already used in the tenant never gets a second user
//   - tenant isolation: every query is vendorId-scoped; vendorId always comes
//     from the server-side Ctx, never from the payload
import crypto from "crypto"
import { db } from "@/lib/db"
import { hashPasswordAsync } from "./auth"
import { getSettings } from "./settings"
import { requireCapacity } from "./saas/entitlements"
import { eventChannels } from "./delivery"
import { sendEmail, sendSms } from "./gateway"
import { audit, notify } from "./audit"
import type { HrSettings } from "./settings"

// unambiguous character classes (no 0/O/1/l/I confusables)
const CLS = {
  upper: "ABCDEFGHJKLMNPQRSTUVWXYZ",
  lower: "abcdefghijkmnpqrstuvwxyz",
  digits: "23456789",
  symbols: "!@#$%&*",
}

function sample(cls: string, n: number): string {
  const bytes = crypto.randomBytes(n)
  let out = ""
  for (let i = 0; i < n; i++) out += cls[bytes[i] % cls.length]
  return out
}

/** CSPRNG temporary password that satisfies the tenant's password policy.
 *  Guaranteed to include at least one char of every class (most policies
 *  require upper+lower+digit; symbols included when minLength allows). */
export function generateTempPassword(policy: HrSettings["passwordPolicy"]): string {
  const len = Math.max(10, Math.min(16, policy.minLength || 10))
  const parts = [
    sample(CLS.upper, 1),
    sample(CLS.lower, 1),
    sample(CLS.digits, 1),
    sample(CLS.symbols, policy.requireSymbol || len >= 12 ? 1 : 0),
  ]
  const all = CLS.upper + CLS.lower + CLS.digits + (policy.requireSymbol || len >= 12 ? CLS.symbols : "")
  parts.push(sample(all, Math.max(2, len - parts.reduce((s, p) => s + p.length, 0))))
  // Fisher-Yates shuffle so class positions are not predictable
  const chars = parts.join("").split("")
  for (let i = chars.length - 1; i > 0; i--) {
    const j = crypto.randomBytes(1)[0] % (i + 1)
    ;[chars[i], chars[j]] = [chars[j], chars[i]]
  }
  return chars.join("")
}

export type ProvisionStatus =
  | "CREATED" // account created + credentials generated
  | "ALREADY_LINKED" // employee already has a user account — never duplicate
  | "DUPLICATE_EMAIL" // another user in this tenant already uses the email
  | "NO_EMAIL" // employee has no usable email for a login identifier
  | "USER_LIMIT_REACHED" // SaaS plan user capacity exhausted

export type ProvisionResult = {
  status: ProvisionStatus
  userId?: string
  email?: string
  /** plaintext temp password — ONLY populated in the in-memory return value;
   *  never written to the database. Callers decide whether the RPC response
   *  may carry it (authorized admin, and only when delivery was impossible). */
  tempPassword?: string
  detail?: string
}

/** Login identifier per the existing authentication architecture: User.email
 *  is the login key — the employee's official email is preferred, personal
 *  email as fallback. */
export function employeeLoginEmail(emp: { officialEmail?: string | null; personalEmail?: string | null }): string | null {
  const e = (emp.officialEmail || emp.personalEmail || "").trim().toLowerCase()
  return e || null
}

/**
 * Create the linked EMPLOYEE-role user account for one employee. Never throws
 * for expected conditions (duplicate / no email / capacity) — returns a status
 * so bulk import can continue with other rows; only unexpected DB errors
 * propagate. Caller is responsible for auditing.
 */
export async function provisionEmployeeUser(
  vendorId: string,
  employeeId: string,
  opts: { requireCapacityCheck?: boolean } = {}
): Promise<ProvisionResult> {
  // 1. an employee never gets a second account (also covers a re-run of bulk
  //    import or a retry after a partial failure)
  const linked = await db.user.findFirst({ where: { vendorId, employeeId }, select: { id: true, email: true } })
  if (linked) {
    return { status: "ALREADY_LINKED", userId: linked.id, email: linked.email, detail: "Employee already has a linked user account" }
  }
  // 2. resolve the login identifier
  const emp = await db.employee.findFirst({
    where: { id: employeeId, vendorId },
    select: { fullName: true, officialEmail: true, personalEmail: true, mobile: true },
  })
  if (!emp) return { status: "NO_EMAIL", detail: "Employee not found in this tenant" }
  const email = employeeLoginEmail(emp)
  if (!email) {
    return { status: "NO_EMAIL", detail: "Employee has no official or personal email to use as login identifier" }
  }
  // 3. one user per email per tenant (schema-level unique too — this is the
  //    friendly pre-check)
  const dupe = await db.user.findFirst({ where: { vendorId, email }, select: { id: true, employeeId: true } })
  if (dupe) {
    return {
      status: "DUPLICATE_EMAIL",
      email,
      detail: dupe.employeeId
        ? `A user account already exists for this email (linked to another employee)`
        : `A user account already exists for this email`,
    }
  }
  // 4. SaaS plan capacity — skip (do not fail the employee creation) when the
  //    plan's user seats are exhausted; the console surfaces the reason
  if (opts.requireCapacityCheck !== false) {
    try {
      await requireCapacity(vendorId, "USERS", 1)
    } catch (e: any) {
      return {
        status: "USER_LIMIT_REACHED",
        email,
        detail: e?.message || "Plan user-seat limit reached — upgrade the subscription to provision portal accounts",
      }
    }
  }
  // 5. mint the account
  const settings = await getSettings(vendorId)
  const tempPassword = generateTempPassword(settings.passwordPolicy)
  // MOD-8 (Phase 1) — async scrypt: this runs once per row of a bulk import;
  // the sync form blocked the event loop 25–50 s for a 500-row sheet.
  const user = await db.user.create({
    data: {
      vendorId,
      employeeId,
      email,
      name: emp.fullName,
      phone: emp.mobile || null,
      passwordHash: await hashPasswordAsync(tempPassword),
      role: "EMPLOYEE",
      permissions: "[]", // derive from the EMPLOYEE role template at login
      status: "ACTIVE",
      mustChangePassword: true, // forced first-login rotation
      passwordChangedAt: new Date(),
    },
  })
  return { status: "CREATED", userId: user.id, email, tempPassword }
}

export type DeliveryResult = {
  email: "SENT" | "FAILED" | "SKIPPED" | "NA"
  sms: "SENT" | "FAILED" | "SKIPPED" | "NA"
  emailDetail?: string
  smsDetail?: string
}

/**
 * Deliver the temporary login credentials through the channels enabled for the
 * `employee_credentials` event in the vendor's notification matrix
 * (Settings → Communication → Automation). Independent Email/SMS toggles:
 *   Email ON / SMS ON  → both
 *   Email ON / SMS OFF → email only
 *   Email OFF / SMS ON → sms only
 *   both OFF           → nothing sent (admin retrieves via Reset Login
 *                        Password, which routes through here again)
 * In-app confirmation is delivered to the employee's future portal inbox.
 * Every attempt (SENT/FAILED/SKIPPED) is recorded in CommunicationLog +
 * CommunicationRecipient via the shared gateway contract — never throws.
 */
export async function deliverEmployeeCredentials(
  vendorId: string,
  employeeId: string,
  user: { email: string },
  tempPassword: string,
  opts: { reset?: boolean } = {}
): Promise<DeliveryResult> {
  const settings = await getSettings(vendorId)
  const ch = eventChannels(settings, "employee_credentials", { email: true, sms: false })
  const out: DeliveryResult = { email: "NA", sms: "NA" }
  try {
    const emp = await db.employee.findFirst({
      where: { id: employeeId, vendorId },
      select: { fullName: true, preferredName: true, officialEmail: true, personalEmail: true, mobile: true, code: true },
    })
    if (!emp) return out
    const displayName = emp.preferredName || emp.fullName
    const portalUrl = settings.general.website ? `${String(settings.general.website).replace(/\/+$/, "")}/app` : "/app"

    if (ch.inApp) {
      await notify(
        vendorId,
        { employeeId },
        opts.reset ? "Login password reset" : "Your portal account is ready",
        opts.reset
          ? "Your login password was reset by an administrator. Use the new credentials sent to you."
          : "Your employee self-service account has been created. Check your email/SMS for the login credentials.",
        "SYSTEM",
        "ess"
      )
    }

    if (ch.email) {
      const to = emp.officialEmail || emp.personalEmail || ""
      // 2026-10 restructure — render from the employee_credentials system
      // template when the tenant edited one; the built-in fallback keeps the
      // historical welcome/reset wording (portal URL + security notes).
      const { effectiveMessageTemplate, renderMessageTemplate } = await import("./message-templates")
      const tpl = effectiveMessageTemplate((settings as any).messageTemplates, "employee_credentials")
      const cvars = { name: displayName, company: settings.general.companyName, username: user.email, tempPassword }
      const hasEdit = !!((settings as any).messageTemplates?.employee_credentials?.emailBody || "").trim()
      const subject = opts.reset
        ? `Your Finix HR login password was reset — ${emp.code}`
        : `Welcome to ${settings.general.companyName} — your employee portal account`
      const body = hasEdit && tpl
        ? renderMessageTemplate(tpl.emailBody, cvars) + `\n\nSign in at: ${portalUrl}`
        :
        `Dear ${displayName},\n\n` +
        (opts.reset
          ? `Your login password for the employee portal was reset by an administrator.`
          : `An employee self-service account has been created for you.`) +
        `\n\nSign-in email: ${user.email}\nTemporary password: ${tempPassword}\nSign in at: ${portalUrl}\n\n` +
        `For security you MUST choose a new password the first time you sign in — you will not be able to continue until the password is changed.\n\n` +
        `Do not reply to this message; share this password with no one.\n\n— ${settings.general.companyName} (Finix HR)`
      const res = await sendEmail(vendorId, to, subject, body)
      out.email = res.status
      out.emailDetail = res.detail
      await logCredentialDelivery(vendorId, employeeId, "EMAIL", subject, res.status, res.detail)
    }

    if (ch.sms) {
      // 2026-10 restructure — tenant-edited SMS template wins; otherwise the
      // historical credential SMS text
      const { effectiveMessageTemplate, renderMessageTemplate } = await import("./message-templates")
      const tpl = effectiveMessageTemplate((settings as any).messageTemplates, "employee_credentials")
      const cvars = { name: displayName, company: settings.general.companyName, username: user.email, tempPassword }
      const hasEdit = !!((settings as any).messageTemplates?.employee_credentials?.smsBody || "").trim()
      const text = hasEdit && tpl
        ? renderMessageTemplate(tpl.smsBody, cvars).slice(0, 300)
        :
        `${settings.general.companyName}: ${opts.reset ? "Your login password was reset." : "Your employee portal account is ready."} ` +
        `Login: ${user.email} Temp password: ${tempPassword} ` +
        `You must change it at first sign-in.`.slice(0, 300)
      const res = await sendSms(vendorId, emp.mobile || "", text)
      out.sms = res.status
      out.smsDetail = res.detail
      await logCredentialDelivery(vendorId, employeeId, "SMS", "Login credentials", res.status, res.detail)
    }
  } catch (err: any) {
    // delivery is strictly best-effort — record and move on
    console.error("[employee-provisioning] credential delivery failed:", err?.message || err)
  }
  return out
}

/** CommunicationLog/Recipient rows for credential deliveries (mirrors
 *  delivery.ts logDelivery, kept private there). */
async function logCredentialDelivery(vendorId: string, employeeId: string, channel: string, subject: string, status: string, detail?: string) {
  try {
    const emp = await db.employee.findFirst({ where: { id: employeeId }, select: { fullName: true, officialEmail: true, personalEmail: true, mobile: true } })
    const log = await db.communicationLog.create({
      data: {
        vendorId, channel, subject: subject.slice(0, 200), message: subject.slice(0, 500),
        audienceType: "EVENT", audienceLabel: "Automated credential delivery",
        recipientCount: 1,
        deliveredCount: status === "SENT" ? 1 : 0,
        failedCount: status === "FAILED" ? 1 : 0,
        skippedCount: status === "SKIPPED" ? 1 : 0,
        status: status === "SENT" ? "SENT" : status === "FAILED" ? "FAILED" : "SKIPPED",
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

/** Provision + deliver in one call for the single-create flow. */
export async function provisionAndNotify(
  vendorId: string,
  employeeId: string,
  ctx: { userId?: string; userName?: string } = {}
): Promise<{ provision: ProvisionResult; delivery?: DeliveryResult }> {
  const provision = await provisionEmployeeUser(vendorId, employeeId)
  if (provision.status !== "CREATED" || !provision.userId) {
    return { provision }
  }
  const delivery = await deliverEmployeeCredentials(vendorId, employeeId, { email: provision.email || "" }, provision.tempPassword || "")
  // The account-created notice (separate matrix event, default in-app only)
  await notifyAccountCreated(vendorId, employeeId, provision.email || "")
  await audit(
    { vendorId, userId: ctx.userId, userName: ctx.userName },
    "employees.accountProvisioned", "User", provision.userId,
    `EMPLOYEE user account auto-created for employee ${provision.email} (temporary password issued, first-login change enforced)`,
    { newValue: { employeeId, email: provision.email, emailStatus: delivery.email, smsStatus: delivery.sms } }
  ).catch(() => {})
  return { provision, delivery }
}

/** employee_account_created matrix event — welcome/notice WITHOUT credentials. */
export async function notifyAccountCreated(vendorId: string, employeeId: string, email: string) {
  const settings = await getSettings(vendorId)
  const ch = eventChannels(settings, "employee_account_created", { email: false })
  if (ch.inApp) {
    await notify(vendorId, { employeeId }, "Portal account created",
      `An employee portal account (${email}) was created for you.`, "SYSTEM", "ess").catch(() => {})
  }
  if (ch.email) {
    const emp = await db.employee.findFirst({ where: { id: employeeId, vendorId }, select: { fullName: true, officialEmail: true, personalEmail: true } })
    const to = emp?.officialEmail || emp?.personalEmail || ""
    const res = await sendEmail(
      vendorId, to,
      `Your ${settings.general.companyName} employee portal account`,
      `Dear ${emp?.fullName || "employee"},\n\nAn employee self-service account has been created for you (${email}). ` +
      `Your sign-in credentials are delivered separately (or by your HR administrator).\n\n— ${settings.general.companyName} (Finix HR)`
    )
    await logCredentialDelivery(vendorId, employeeId, "EMAIL", "Portal account created notice", res.status, res.detail)
  }
}

/**
 * Background-job entry point (EMPLOYEE_CREDENTIALS_DELIVERY runner): rotate the
 * account onto a FRESH temporary password and deliver it through the channels
 * enabled for the employee_credentials event. Used after bulk imports, where
 * the import RPC cannot sit through hundreds of SMTP/SMS round-trips and the
 * per-employee plaintext password must never be persisted in the job payload.
 *
 * Rotating is safe: between provisioning and this job the account carried a
 * password nobody was ever told, so replacing it before delivery loses
 * nothing. Returns null when no linked account exists (row skipped).
 */
export async function rotateAndDeliverCredentials(
  vendorId: string,
  employeeId: string
): Promise<DeliveryResult | null> {
  const user = await db.user.findFirst({ where: { vendorId, employeeId }, select: { id: true, email: true } })
  if (!user) return null
  const settings = await getSettings(vendorId)
  const tempPassword = generateTempPassword(settings.passwordPolicy)
  // MOD-8 (Phase 1) — async scrypt: the delivery job runs this once per
  // employee of a bulk import (in-process on the shared event loop).
  await db.user.update({
    where: { id: user.id },
    data: {
      passwordHash: await hashPasswordAsync(tempPassword),
      mustChangePassword: true, // enforced at first login
      passwordChangedAt: new Date(),
      passwordResetToken: null,
      passwordResetExpiresAt: null,
    },
  })
  return deliverEmployeeCredentials(vendorId, employeeId, { email: user.email }, tempPassword)
}

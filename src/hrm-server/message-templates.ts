// ============ System SMS / Email message templates (2026-10 restructure) ============
// Single catalog of the SYSTEM-DEFINED templates for every event-triggered
// SMS/Email the platform sends. Rules (product decision, HR Settings →
// Templates):
//   - the LIST of templates is fixed: tenants can EDIT the wording of any
//     template but can never create or delete one (the events are wired into
//     server code — a tenant-invented key would be a dead template)
//   - a tenant edit is stored in the `messageTemplates` settings group and
//     OVERRIDES the system default; deleting the override (reset) restores
//     the default
//   - rendering is plain {{variable}} substitution; unknown variables are
//     stripped, missing templates fall back to the caller's inline strings
//     (legacy call sites keep working unchanged).
// The in-app channel is NOT templated here: in-app notifications keep the
// concise titles/messages built at each call site (they carry deep links and
// are already localized per event).

export type MessageTemplateDef = {
  /** Event key — matches the notification-matrix rows (delivery.ts NOTIFY_EVENTS). */
  key: string
  /** Human label shown in HR Settings → Templates. */
  label: string
  /** What triggers it (shown under the label). */
  description: string
  /** Variables the call site provides (documented for the editor chips). */
  variables: string[]
  /** Default email subject ({{variables}} allowed). */
  emailSubject: string
  /** Default email body. */
  emailBody: string
  /** Default SMS body (kept under ~300 chars). */
  smsBody: string
}

/** Shared variable sets (kept flat for the click-to-insert chips). */
const COMMON = ["name", "company", "date"]

export const SYSTEM_MESSAGE_TEMPLATES: MessageTemplateDef[] = [
  {
    key: "leave_request", label: "Leave Requested", description: "Employee submits a leave application (goes to the approver).",
    variables: [...COMMON, "employee", "leaveType", "fromDate", "toDate", "days"],
    emailSubject: "Leave request from {{employee}}",
    emailBody: "Hello,\n\n{{employee}} applied for {{leaveType}} leave from {{fromDate}} to {{toDate}} ({{days}} day(s)).\nPlease review and take action in the portal.\n\n— {{company}}",
    smsBody: "{{company}}: {{employee}} requested {{leaveType}} leave ({{fromDate}} to {{toDate}}). Please review.",
  },
  {
    key: "leave_decision", label: "Leave Decision", description: "Leave application approved or rejected.",
    variables: [...COMMON, "leaveType", "fromDate", "toDate", "days", "decision"],
    emailSubject: "Your leave request — {{decision}}",
    emailBody: "Hello {{name}},\n\nYour {{leaveType}} leave ({{fromDate}} → {{toDate}}, {{days}} day(s)) has been {{decision}}.\n\n— {{company}}",
    smsBody: "{{company}}: your {{leaveType}} leave was {{decision}}.",
  },
  {
    key: "payslip_generated", label: "Payslip Generated", description: "Payslip becomes available after a payroll run.",
    variables: [...COMMON, "payslipNumber", "period", "netPay"],
    emailSubject: "Payslip {{payslipNumber}} — {{company}}",
    emailBody: "Dear {{name}},\n\nYour salary slip {{payslipNumber}} for {{period}} is attached and also available in your employee portal.\nNet pay: ৳{{netPay}}\n\n— {{company}}",
    smsBody: "{{company}}: payslip {{payslipNumber}} ({{period}}) is in your portal. Net ৳{{netPay}}.",
  },
  {
    key: "salary_credited", label: "Salary Credited", description: "Payroll run marked as paid.",
    variables: [...COMMON, "period", "netPay", "payslipNumber"],
    emailSubject: "Salary processed — {{period}}",
    emailBody: "Dear {{name}},\n\nYour salary for {{period}} has been processed. Net pay: ৳{{netPay}}. Payslip {{payslipNumber}} is available in your portal.\n\n— {{company}}",
    smsBody: "{{company}}: salary for {{period}} processed. Net ৳{{netPay}}. Payslip {{payslipNumber}} in portal.",
  },
  {
    key: "attendance_alert", label: "Attendance Alert (HR)", description: "Daily digest of missing attendance / late arrivals sent to HR.",
    variables: [...COMMON, "missing", "late", "summary"],
    emailSubject: "Attendance alert — {{date}}",
    emailBody: "Hello,\n\nAttendance summary for {{date}}:\n{{summary}}\nEmployees without attendance: {{missing}}\nLate arrivals: {{late}}\n\n— {{company}}",
    smsBody: "{{company}}: {{missing}} employee(s) missing attendance, {{late}} late ({{date}}).",
  },
  {
    key: "document_expiry", label: "Document Expiry", description: "Employee document (NID/passport/contract…) approaching expiry.",
    variables: [...COMMON, "employee", "docType", "docTitle", "expiryDate"],
    emailSubject: "{{docType}} expiring on {{expiryDate}}",
    emailBody: "Hello,\n\n{{employee}}'s {{docType}} ({{docTitle}}) expires on {{expiryDate}}.\nPlease arrange renewal.\n\n— {{company}}",
    smsBody: "{{company}}: {{employee}}'s {{docType}} expires {{expiryDate}}.",
  },
  {
    key: "resignation_submitted", label: "Resignation Submitted", description: "Employee submits a resignation (goes to HR/approvers).",
    variables: [...COMMON, "employee", "proposedLwd", "reason"],
    emailSubject: "Resignation submitted — {{employee}}",
    emailBody: "Hello,\n\n{{employee}} submitted a resignation. Proposed last working day: {{proposedLwd}}.\nPlease review in the Exit module.\n\n— {{company}}",
    smsBody: "{{company}}: {{employee}} resigned. Proposed LWD {{proposedLwd}}.",
  },
  {
    key: "loan_request", label: "Loan Requested", description: "Employee applies for a loan.",
    variables: [...COMMON, "amount", "installments", "guarantor"],
    emailSubject: "Loan request submitted",
    emailBody: "Hello {{name}},\n\nYour loan request of ৳{{amount}} was submitted. It will go for approval once {{guarantor}} (guarantor) consents.\n\n— {{company}}",
    smsBody: "{{company}}: loan request ৳{{amount}} submitted.",
  },
  {
    key: "loan_decision", label: "Loan Decision", description: "Loan approved or rejected.",
    variables: [...COMMON, "amount", "installments", "installmentAmount", "decision"],
    emailSubject: "Loan {{decision}}",
    emailBody: "Hello {{name}},\n\nYour loan of ৳{{amount}} is {{decision}}. {{installments}} installments of ~৳{{installmentAmount}} will be deducted from payroll.\n\n— {{company}}",
    smsBody: "{{company}}: your ৳{{amount}} loan was {{decision}}.",
  },
  {
    key: "advance_request", label: "Advance Requested", description: "Employee requests a salary advance.",
    variables: [...COMMON, "amount", "installments"],
    emailSubject: "Advance request submitted",
    emailBody: "Hello {{name}},\n\nYour salary advance request of ৳{{amount}} is submitted for approval.\n\n— {{company}}",
    smsBody: "{{company}}: advance request ৳{{amount}} submitted.",
  },
  {
    key: "advance_decision", label: "Advance Decision", description: "Salary advance approved or rejected.",
    variables: [...COMMON, "amount", "installments", "decision"],
    emailSubject: "Advance {{decision}}",
    emailBody: "Hello {{name}},\n\nYour salary advance of ৳{{amount}} is {{decision}}. It will be recovered in {{installments}} installment(s).\n\n— {{company}}",
    smsBody: "{{company}}: your ৳{{amount}} advance was {{decision}}.",
  },
  {
    key: "expense_request", label: "Expense Claimed", description: "Employee submits an expense claim.",
    variables: [...COMMON, "title", "amount"],
    emailSubject: "Expense claim submitted",
    emailBody: "Hello {{name}},\n\nYour expense claim \"{{title}}\" (৳{{amount}}) was submitted for approval.\n\n— {{company}}",
    smsBody: "{{company}}: expense \"{{title}}\" ৳{{amount}} submitted.",
  },
  {
    key: "expense_decision", label: "Expense Decision", description: "Expense claim approved or rejected.",
    variables: [...COMMON, "title", "amount", "decision"],
    emailSubject: "Expense {{decision}}",
    emailBody: "Hello {{name}},\n\nYour expense \"{{title}}\" of ৳{{amount}} is {{decision}}.\n\n— {{company}}",
    smsBody: "{{company}}: expense \"{{title}}\" was {{decision}}.",
  },
  {
    key: "performance_review", label: "Performance Review", description: "Review cycle or review assignment notification.",
    variables: [...COMMON, "reviewName", "endDate"],
    emailSubject: "Performance review — {{reviewName}}",
    emailBody: "Hello {{name}},\n\nA performance review ({{reviewName}}) is due. The cycle ends on {{endDate}}.\nPlease complete your part in the portal.\n\n— {{company}}",
    smsBody: "{{company}}: performance review {{reviewName}} ends {{endDate}}.",
  },
  {
    key: "employee_account_created", label: "Account Created", description: "Employee's login account is provisioned.",
    variables: [...COMMON, "username"],
    emailSubject: "Your {{company}} account is ready",
    emailBody: "Hello {{name}},\n\nYour {{company}} account has been created. Username: {{username}}.\nYou will receive your password separately.\n\n— {{company}}",
    smsBody: "{{company}}: account created for {{name}} ({{username}}).",
  },
  {
    key: "employee_credentials", label: "Credentials Delivery", description: "Temporary password delivery for a new or reset account.",
    variables: [...COMMON, "username", "tempPassword"],
    emailSubject: "Your {{company}} sign-in credentials",
    emailBody: "Hello {{name}},\n\nSign in with:\nUsername: {{username}}\nTemporary password: {{tempPassword}}\nYou will be asked to change it on first sign-in.\n\n— {{company}}",
    smsBody: "{{company}}: username {{username}}, temp password {{tempPassword}} — change it after sign-in.",
  },
  {
    key: "password_reset", label: "Password Reset", description: "Self-service password reset code/link.",
    variables: [...COMMON, "code", "minutes"],
    emailSubject: "Reset your {{company}} password",
    emailBody: "Hello {{name}},\n\nYour password reset code is {{code}}. It is valid for {{minutes}} minutes.\nIf you did not request this, ignore this message.\n\n— {{company}}",
    smsBody: "{{company}}: reset code {{code}} (valid {{minutes}} min).",
  },
  {
    key: "promotion", label: "Promotion", description: "Employee is promoted.",
    variables: [...COMMON, "designation", "effectiveDate"],
    emailSubject: "Congratulations on your Promotion!",
    emailBody: "Hello {{name}},\n\nYou have been promoted to {{designation}} effective {{effectiveDate}}. Congratulations!\n\n— {{company}}",
    smsBody: "{{company}}: promoted to {{designation}} ({{effectiveDate}}). Congratulations!",
  },
  {
    key: "transfer", label: "Transfer", description: "Employee is transferred.",
    variables: [...COMMON, "branch", "department", "effectiveDate"],
    emailSubject: "Transfer Notification",
    emailBody: "Hello {{name}},\n\nYour transfer is effective from {{effectiveDate}}. New posting: {{branch}}{{department}}.\n\n— {{company}}",
    smsBody: "{{company}}: transfer effective {{effectiveDate}}.",
  },
  {
    key: "shift_change", label: "Shift Change", description: "Employee's shift is changed.",
    variables: [...COMMON, "shiftName", "effectiveDate"],
    emailSubject: "Your shift has changed",
    emailBody: "Hello {{name}},\n\nYour shift is now {{shiftName}} effective {{effectiveDate}}.\n\n— {{company}}",
    smsBody: "{{company}}: new shift {{shiftName}} from {{effectiveDate}}.",
  },
  {
    key: "salary_revision", label: "Salary Revision", description: "Salary structure revised (increment).",
    variables: [...COMMON, "newSalary", "effectiveDate"],
    emailSubject: "Salary Revision Approved",
    emailBody: "Hello {{name}},\n\nYour salary has been revised to ৳{{newSalary}} effective {{effectiveDate}}.\n\n— {{company}}",
    smsBody: "{{company}}: salary revised to ৳{{newSalary}} ({{effectiveDate}}).",
  },
  {
    key: "employee_status", label: "Status Change", description: "Employee suspended / activated / terminated.",
    variables: [...COMMON, "status", "note"],
    emailSubject: "Employment status update",
    emailBody: "Hello {{name}},\n\nYour employment status is now: {{status}}.{{note}}\n\n— {{company}}",
    smsBody: "{{company}}: your employment status is now {{status}}.",
  },
  {
    key: "birthday_wish", label: "Birthday Wish", description: "Automated birthday greeting (managed with Wishes settings).",
    variables: ["name", "company"],
    emailSubject: "Happy Birthday!",
    emailBody: "Happy Birthday, {{name}}! Wishing you a wonderful day from the {{company}} family.",
    smsBody: "Happy Birthday, {{name}}! — {{company}}",
  },
  {
    key: "anniversary_wish", label: "Work Anniversary Wish", description: "Automated work-anniversary greeting (managed with Wishes settings).",
    variables: ["name", "company", "years", "ordinal"],
    emailSubject: "Happy {{years}}{{ordinal}} Work Anniversary!",
    emailBody: "Happy {{years}}{{ordinal}} Work Anniversary, {{name}}! Thank you for your dedicated service at {{company}}.",
    smsBody: "Happy {{years}}{{ordinal}} anniversary, {{name}}! — {{company}}",
  },
  {
    // Wave 2 WP-P — public careers page submissions fan out to the tenant's
    // HR users (recruitment.apply → notifyHrOfApplication in routes/recruitment.ts)
    key: "job_application_received", label: "Job Application Received", description: "A candidate applies to a published job opening from the public careers page (goes to HR).",
    variables: ["company", "date", "applicant", "jobTitle", "email", "phone", "source"],
    emailSubject: "New application — {{jobTitle}}",
    emailBody: "Hello,\n\n{{applicant}} applied for {{jobTitle}} via the {{source}} on {{date}}.\nContact: {{email}} · {{phone}}\nReview the application in the Recruitment pipeline.\n\n— {{company}}",
    smsBody: "{{company}}: {{applicant}} applied for {{jobTitle}} — review it in Recruitment.",
  },
]

export const SYSTEM_TEMPLATE_BY_KEY: Record<string, MessageTemplateDef> = Object.fromEntries(
  SYSTEM_MESSAGE_TEMPLATES.map((t) => [t.key, t]),
)

/** Keys the tenant may store overrides for (fixed list — no create/delete). */
export const MESSAGE_TEMPLATE_KEYS = SYSTEM_MESSAGE_TEMPLATES.map((t) => t.key)

/** Tenant-editable shape stored in the `messageTemplates` settings group.
 *  A missing/empty value = "use the system default". */
export type MessageTemplateOverride = {
  emailSubject?: string
  emailBody?: string
  smsBody?: string
}

/** Render a template string: replaces {{var}} with the provided value and
 *  strips unknown variables (a template edited with a variable this event
 *  does not provide must never leak "{{...}}" to an employee). */
export function renderMessageTemplate(tpl: string, vars: Record<string, string | number | null | undefined>): string {
  if (!tpl) return ""
  return tpl
    .replace(/\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g, (_m, name) => {
      const v = vars[name]
      return v == null ? "" : String(v)
    })
    .replace(/[ \t]+\n/g, "\n")
}

/** Effective template for an event = tenant override ?? system default. */
export function effectiveMessageTemplate(
  overrides: Record<string, MessageTemplateOverride> | null | undefined,
  key: string,
): MessageTemplateDef | (MessageTemplateDef & MessageTemplateOverride) {
  const base = SYSTEM_TEMPLATE_BY_KEY[key]
  if (!base) return base
  const ov = overrides?.[key]
  if (!ov) return base
  return {
    ...base,
    emailSubject: ov.emailSubject?.trim() ? ov.emailSubject : base.emailSubject,
    emailBody: ov.emailBody?.trim() ? ov.emailBody : base.emailBody,
    smsBody: ov.smsBody?.trim() ? ov.smsBody : base.smsBody,
  }
}

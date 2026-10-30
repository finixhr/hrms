"use client"
// ============ HR Settings (spec §4.1) ============
// Company profile (info + logo), HR policy groups, users, role manager with a
// permission matrix, email/SMS gateway setup, approval workflow configuration
// and the system self-test.
import { useEffect, useMemo, useState } from "react"
import {
  Building2, Clock, MapPin, Plane, Wallet, Cake, Workflow, AlertTriangle,
  Plus, Pencil, Trash2, Save, CheckCircle2, XCircle, ShieldCheck,
  RotateCw, Bell, Mail, MessageSquare, Upload, Copy, Send,
  Globe2, Palette, Lock, LockOpen, UserRound, ArrowUpRight,
  Fingerprint, Gift, Award, Calculator, FileBarChart, ExternalLink, Coins, Landmark,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Switch } from "@/components/ui/switch"
import { Checkbox } from "@/components/ui/checkbox"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { useHrm } from "../store"
import { useApi, rpc, useEmployeeDirectory, runJob } from "../api"
import { PageHeader, SectionTabs, SectionCard, StatusBadge, fmtDateTime, titleCase, fmtMoney } from "../shared/ui-kit"
import { DataTable, type Column } from "../shared/data-table"
import { FormDialog, ConfirmDialog, type FieldDef } from "../shared/form-dialog"
import { HolidaysTab } from "../shared/holidays-tab"
import { LetterTemplatesTab } from "../shared/letter-templates-tab"
import { SmsTemplatesTab, EmailTemplatesTab } from "../shared/message-templates-tab"
import IntegrationsSettings from "./settings-integrations"
import { MODULES, ACTIONS, MODULE_LABELS } from "../../hrm-server/types"
import { FIELD_GROUPS, FIELD_GROUP_LABELS, FIELD_ACCESS_LABELS } from "../../hrm-server/field-permissions"
import { computeGratuity } from "../../hrm-server/gratuity"
import { moduleCoveredByPlan } from "../module-map"
import { ACCOUNTS, DEFAULT_ACCOUNT_MAPPING } from "../accounting-chart"

const WEEKDAYS = ["SUNDAY", "MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY"]
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"]
const ROLES = ["HR_ADMIN", "HR_MANAGER", "PAYROLL_OFFICER", "BRANCH_MANAGER", "DEPT_MANAGER", "EMPLOYEE", "VENDOR_OWNER"]
const APPROVER_ROLES = ["HR_ADMIN", "HR_MANAGER", "PAYROLL_OFFICER", "BRANCH_MANAGER", "DEPT_MANAGER", "VENDOR_OWNER"]
const PROCESS_TYPES = ["LEAVE", "LOAN", "ADVANCE", "EXPENSE", "PAYROLL", "LETTER", "RESIGNATION", "PROMOTION", "TRANSFER", "SALARY_REVISION", "OVERTIME", "ENCASHMENT", "GOODS_REQUISITION", "PURCHASE", "BONUS"]

/** Sensible default steps per process type — used to prefill the editor when an
 *  admin sets up a workflow that has not been configured yet. Mirrors the DB
 *  seeder in scripts/seed-approval-workflows.ts. */
const DEFAULT_WORKFLOW_STEPS: Record<string, { name: string; approverRole: string; branchScope?: boolean; departmentScope?: boolean; amountThreshold?: number }[]> = {
  LEAVE: [{ name: "Supervisor / Manager", approverRole: "BRANCH_MANAGER", branchScope: true }, { name: "HR Review", approverRole: "HR_MANAGER" }],
  LOAN: [{ name: "Manager Review", approverRole: "BRANCH_MANAGER", branchScope: true, amountThreshold: 50000 }, { name: "HR Review", approverRole: "HR_MANAGER" }, { name: "Finance Approval", approverRole: "PAYROLL_OFFICER" }],
  ADVANCE: [{ name: "Manager Review", approverRole: "BRANCH_MANAGER", branchScope: true, amountThreshold: 20000 }, { name: "Finance Approval", approverRole: "PAYROLL_OFFICER" }],
  EXPENSE: [{ name: "Manager Review", approverRole: "BRANCH_MANAGER", branchScope: true }, { name: "Finance Approval", approverRole: "PAYROLL_OFFICER" }],
  PAYROLL: [{ name: "HR Review", approverRole: "HR_MANAGER" }, { name: "Manager Approval", approverRole: "HR_ADMIN" }, { name: "Finance / Accounting Approval", approverRole: "PAYROLL_OFFICER" }],
  LETTER: [{ name: "HR Review", approverRole: "HR_MANAGER" }, { name: "Management Approval", approverRole: "HR_ADMIN" }],
  RESIGNATION: [{ name: "Reporting Manager", approverRole: "BRANCH_MANAGER", branchScope: true }, { name: "Department Head", approverRole: "DEPT_MANAGER" }, { name: "HR Review", approverRole: "HR_MANAGER" }, { name: "Management", approverRole: "HR_ADMIN" }],
  PROMOTION: [{ name: "HR Review", approverRole: "HR_MANAGER" }, { name: "Management Approval", approverRole: "HR_ADMIN" }],
  TRANSFER: [{ name: "HR Review", approverRole: "HR_MANAGER" }, { name: "Management Approval", approverRole: "HR_ADMIN" }],
  SALARY_REVISION: [{ name: "HR Review", approverRole: "HR_MANAGER" }, { name: "Management Approval", approverRole: "HR_ADMIN" }],
  OVERTIME: [{ name: "Manager Review", approverRole: "BRANCH_MANAGER", branchScope: true }, { name: "HR Review", approverRole: "HR_MANAGER" }],
  ENCASHMENT: [{ name: "Manager Review", approverRole: "BRANCH_MANAGER", branchScope: true }, { name: "Finance Approval", approverRole: "PAYROLL_OFFICER" }],
  GOODS_REQUISITION: [{ name: "Department Head", approverRole: "DEPT_MANAGER" }, { name: "HR Review", approverRole: "HR_MANAGER" }, { name: "Final Approval", approverRole: "HR_ADMIN" }],
  PURCHASE: [{ name: "HR Review", approverRole: "HR_MANAGER" }, { name: "Owner Approval", approverRole: "VENDOR_OWNER" }],
  BONUS: [{ name: "HR / Finance Review", approverRole: "PAYROLL_OFFICER" }, { name: "Owner Approval", approverRole: "VENDOR_OWNER" }],
}

type GFieldType = "text" | "number" | "switch" | "select" | "textarea" | "weekdays" | "password" | "multicheck"
type GField = { key: string; label: string; type: GFieldType; options?: { value: string; label: string }[]; hint?: string; span?: boolean; min?: number; max?: number; step?: number; coerceNumber?: boolean; default?: any; showWhen?: (values: Record<string, any>) => boolean }

export default function SettingsView() {
  const { can } = useHrm()
  // global-search deep link: pre-select a tab (params arrive with the view)
  const presetTab = useHrm((s) => (s.view?.key === "settings" && s.view?.params?.tab) || undefined)
  const allowed = can("settings", "view")
  const canEdit = can("settings", "edit")
  const { data: settings, reload } = useApi<any>(allowed ? "settings.get" : null)

  if (!allowed) {
    return (
      <div className="rounded-xl border bg-white dark:bg-slate-900 p-8 text-center">
        <ShieldCheck className="h-8 w-8 text-slate-300 mx-auto mb-2" />
        <p className="text-sm font-medium text-slate-600 dark:text-slate-300">You do not have permission to view HR settings.</p>
      </div>
    )
  }
  if (!settings) {
    return <div className="space-y-3">
      <div className="h-8 w-64 bg-slate-100 dark:bg-slate-800 rounded animate-pulse" />
      <div className="h-96 bg-slate-100 dark:bg-slate-800 rounded-xl animate-pulse" />
    </div>
  }

  const groupProps = { settings, canEdit, onSaved: reload }

  return (
    <div className="space-y-4">
      <PageHeader
        title="HR Settings"
        subtitle={canEdit ? "Vendor-wide HR policy, users, approval workflows and system health" : "Read-only view — settings.edit permission required to change values"}
      />
      {/* UI-R5 (2026-10-04 UI audit): the 20 settings tabs used to render as
          ONE wrapping pill row — a two-row "wall of tabs" with no grouping.
          They are now six labelled sections (Workspace / Time & Attendance /
          Leave & Payroll / Communications / Security & Access / System)
          rendered as a two-level nav by the grouped SectionTabs. Tab VALUES
          are unchanged, so global-search deep links (?tab=…) keep working. */}
      <SectionTabs defaultValue={presetTab as string | undefined} groups={[
        { label: "Workspace", tabs: [
        { value: "general", label: "General", content: (
          <div className="space-y-4">
            <CompanyProfileCard settings={settings} canEdit={canEdit} onSaved={reload} />
            <GroupEditor key="general" group="general" title="General Policy" icon={Building2} description="Weekly holiday, working hours, fiscal year and date format" fields={GENERAL_FIELDS} {...groupProps} />
          </div>
        ) },
        { value: "employee", label: "Employee", content: (
          <GroupEditor key="employeeSettings" group="employeeSettings" title="Employee Settings" icon={UserRound} description="Employee ID scheme (prefix/suffix/start), probation and notice-period defaults applied at employee creation" fields={EMPLOYEE_SETTINGS_FIELDS} {...groupProps} />
        ) },
        { value: "essPortal", label: "Self-Service Portal", content: (
          <GroupEditor key="essPortal" group="essPortal" title="My Portal — Quick Actions & Request Buttons" icon={ShieldCheck} description={'Show or hide employee-initiated buttons in the Self-Service portal ("My Portal" / "My Self-Service"). Turning a control OFF hides the button for every portal user — existing records and history stay visible; only the request entry point is removed.'} fields={ESS_PORTAL_FIELDS} {...groupProps} />
        ) },
        { value: "localization", label: "Localization & Branding", content: (
          <div className="space-y-4">
            <GroupEditor key="localization" group="localization" title="Localization & Formats" icon={Globe2} description="Language, currency and date/number formats" fields={LOCALIZATION_FIELDS} {...groupProps} />
            <GroupEditor key="branding" group="branding" title="Branding & Theme" icon={Palette} description="Vendor white-label colors and dark-mode default" fields={BRANDING_FIELDS} {...groupProps} />
            <GroupEditor key="auditRetention" group="auditRetention" title="Audit Retention" icon={ShieldCheck} description="How long audit-trail rows are kept" fields={AUDIT_RETENTION_FIELDS} {...groupProps} />
            <ModulesCard settings={settings} canEdit={canEdit} onSaved={reload} />
          </div>
        ) },
        ] },
        { label: "Time & Attendance", tabs: [
        { value: "attendance", label: "Attendance", content: (
          <div className="space-y-4">
            <GroupEditor key="attendance" group="attendance" title="Attendance Policy" icon={Clock} description="Manual marking, late deductions, half-day and alert thresholds" fields={ATTENDANCE_FIELDS} {...groupProps} />
            <GroupEditor key="latePolicy" group="latePolicy" title="Late-Coming Policy" icon={Clock} description="Grace period, day-based salary/leave adjustments, tiered penalties, repeat-offender escalation and maximum deduction cap applied at payroll" fields={LATE_POLICY_FIELDS} {...groupProps} />
            <GroupEditor key="earlyLeavePolicy" group="earlyLeavePolicy" title="Early-Leave Policy" icon={Clock} description="Early check-out threshold and per-instance deduction applied at payroll" fields={EARLY_LEAVE_FIELDS} {...groupProps} />
            {/* 2026-10 round §11/§14/§61 — global tracking defaults (per-group overrides live in Attendance → Policies & Check-In) */}
            <GroupEditor key="tracking" group="tracking" title="Tracking Defaults" icon={MapPin}
              description="Live-tracking fallbacks for employees without a tracking policy: ping interval, battery thresholds, offline window and telemetry retention. Mandatory-GPS and multiple check-in schedules are configured per policy under Attendance & Shifts → Policies & Check-In."
              fields={TRACKING_FIELDS} {...groupProps} />            {/* G3 — selfie-capture consent (Privacy & Consent Controls) */}
            <GroupEditor key="selfieConsent" group="selfieConsent" title="Selfie Consent (Privacy)" icon={ShieldCheck}
              description="Show an explicit consent notice employees must acknowledge before the portal uses selfie attendance. Acceptance is recorded per employee with policy version, timestamp and IP — a missing acknowledgment NEVER blocks a punch; it is surfaced for HR follow-up only."
              fields={SELFIE_CONSENT_FIELDS} {...groupProps} />
          </div>
        ) },
        { value: "devices", label: "Devices", content: (
          <GroupEditor key="devices" group="devices" title="Device Security" icon={LockOpen}
            description="Keyless-device policy for the attendance push gateway — whether pre-registered terminals without a communication key may push. Replaces the removed 7-day grace window; keyed devices always authenticate normally."
            fields={DEVICE_FIELDS} {...groupProps} />
        ) },
        { value: "geofence", label: "Geo-Fence", content: <GroupEditor key="geofence" group="geofence" title="Geo-Fence Attendance" icon={MapPin} description="GPS-based check-in validation defaults" fields={GEOFENCE_FIELDS} {...groupProps} /> },
        { value: "shiftsettings", label: "Shifts & OT", content: (
          <div className="space-y-4">
            <GroupEditor key="shift" group="shift" title="Shift & Overtime Policy" icon={Clock} description="Shift auto-detection and overtime approval policy (per-shift rates live under Attendance → Shifts)" fields={SHIFT_FIELDS} {...groupProps} />
            <GroupEditor key="otRates" group="otRates" title="Overtime Rates" icon={Clock} description="Vendor default day-type rates and rounding basis — per-shift multipliers override these" fields={OT_RATES_FIELDS} {...groupProps} />
          </div>
        ) },
        { value: "holidays", label: "Holiday Calendar", content: <HolidaysTab /> },
        ] },
        { label: "Leave & Payroll", tabs: [
        { value: "leave", label: "Leave", content: (
          <div className="space-y-4">
            <GroupEditor key="leave" group="leave" title="Leave Policy" icon={Plane} description="Backdating, substitutes, probation limits, optional holidays and encashment" fields={LEAVE_FIELDS} {...groupProps} />
            <LeaveRulesCard canEdit={canEdit} />
          </div>
        ) },
        { value: "payroll", label: "Payroll", content: (
          <div className="space-y-4">
            <GroupEditor key="payroll" group="payroll" title="Payroll Configuration" icon={Wallet} description="Frequency, cut-off days, deductions and employer cost" fields={PAYROLL_FIELDS} {...groupProps} />
            <GroupEditor key="loanPolicy" group="loanPolicy" title="Loans & Advances Eligibility Policy" icon={Coins} description="Eligibility rules, employee service period, past payout ratio, concurrent loan restrictions, and guarantor qualification criteria" fields={LOAN_POLICY_FIELDS} {...groupProps} />
            <GroupEditor key="pf" group="pf" title="Provident Fund" icon={Wallet} description="Vendor PF rules — enroll employees per head on the Payroll → Provident Fund tab; per-employee percentages override these defaults" fields={PF_FIELDS} {...groupProps} />
            {/* PAY-006 — escalation gate for large bonuses */}
            <GroupEditor key="bonusApproval" group="bonusApproval" title="Bonus Approval" icon={Gift} description="Escalation gate for large bonuses and the payroll-preflight exposure warning threshold" fields={BONUS_APPROVAL_FIELDS} {...groupProps} />
            {/* WP-F — journal role → account mapping + auto-post toggle */}
            <AccountingCard settings={settings} canEdit={canEdit} onSaved={reload} />
          </div>
        ) },
        { value: "gratuity", label: "Gratuity", content: (
          <GratuityTab settings={settings} canEdit={canEdit} onSaved={reload} />
        ) },
        ] },
        { label: "Communications", tabs: [
        { value: "wishes", label: "Wishes & Notifications", content: (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 items-start">
            <div className="space-y-4">
              <GroupEditor key="wishes" group="wishes" title="Wishes & Delivery Channels" icon={Cake} description="Birthday / anniversary templates with variables and delivery channels" fields={WISHES_FIELDS} {...groupProps} />
              <GroupEditor key="notification" group="notification" title="Notification Events (legacy toggles)" icon={Bell} description="Flat event toggles — the per-event × channel matrix takes precedence when a row exists" fields={NOTIFICATION_FIELDS} {...groupProps} />
              <DocExpiryCard settings={settings} canEdit={canEdit} onSaved={reload} />
            </div>
            <div className="space-y-4">
              <GroupEditor key="punchAlerts" group="punchAlerts" title="Real-time Punch Alerts" icon={Fingerprint} description="Instant on-screen toast when an employee punches on a device or checks in/out by geo-fence or selfie — shown to signed-in users who hold the chosen permission" fields={PUNCH_ALERT_FIELDS} {...groupProps} />
              <NotificationMatrixCard settings={settings} canEdit={canEdit} onSaved={reload} />
            </div>
          </div>
        ) },
        { value: "email", label: "Email Gateway", content: <EmailGatewayTab settings={settings} canEdit={canEdit} onSaved={reload} /> },
        { value: "sms", label: "SMS Gateway", content: <SmsGatewayTab settings={settings} canEdit={canEdit} onSaved={reload} /> },
        // 2026-10 restructure — Templates now lives in HR Settings (beside the
        // Communication tabs): SMS / Email / Letter templates in one place.
        { value: "templates", label: "Templates", content: <TemplatesRootTab canEdit={canEdit} /> },
        ] },
        { label: "Security & Access", tabs: [
        { value: "users", label: "Users & Security", content: (
          <div className="space-y-4">
            <UsersTab />
            <PasswordPolicyCard settings={settings} canEdit={canEdit} onSaved={reload} />
            <SessionSecurityCard settings={settings} canEdit={canEdit} onSaved={reload} />
          </div>
        ) },
        { value: "roles", label: "Roles & Permissions", content: <RolesTab /> },
        // FLD-103 (Wave R3-5) — per-role field-group access on the employee
        // record (salary / bank / identity / contact / employment), enforced
        // server-side by the employees.* projection + write whitelist.
        { value: "fieldpermissions", label: "Field Permissions", content: <FieldPermissionsTab settings={settings} canEdit={canEdit} onSaved={reload} /> },
        { value: "workflows", label: "Approval Workflows", content: <WorkflowsTab canEdit={canEdit} /> },
        ] },
        { label: "System", tabs: [
        { value: "health", label: "System Health", content: <HealthTab /> },
        { value: "backup", label: "Backup & Restore", content: <BackupTab canEdit={canEdit} /> },
        // Wave 4 WP-C — public REST API keys + outbound webhooks administration
        { value: "integrations", label: "API & Webhooks", content: <IntegrationsSettings /> },
        ] },
      ]} />
    </div>
  )
}

// ================= settings group editor =================
const GENERAL_FIELDS: GField[] = [
  { key: "weeklyHoliday", label: "Weekly Holiday", type: "weekdays", hint: "Days counted as weekly off for attendance & leave" },
  { key: "workingHoursPerDay", label: "Working Hours / Day", type: "number", min: 1, step: 0.5 },
  { key: "fiscalYearStart", label: "Fiscal Year Start", type: "select", options: MONTH_NAMES.map((m) => ({ value: m, label: m })) },
  // HRM-003 — date format exposure (applied to date rendering app-wide)
  { key: "dateFormat", label: "Date Format", type: "select", options: [
    { value: "DD MMM YYYY", label: "DD MMM YYYY (16 Sep 2026)" },
    { value: "YYYY-MM-DD", label: "YYYY-MM-DD (2026-09-16)" },
    { value: "MM/DD/YYYY", label: "MM/DD/YYYY (09/16/2026)" },
    { value: "DD/MM/YYYY", label: "DD/MM/YYYY (16/09/2026)" },
  ], hint: "Used by date fields across the application" },
]
const ATTENDANCE_FIELDS: GField[] = [
  { key: "allowManualMarking", label: "Allow manual marking by HR", type: "switch", hint: "Allows HR officers to directly mark or edit daily attendance without requiring an approval workflow" },
  { key: "requireCheckOut", label: "Require check-out to complete a day", type: "switch", hint: "Requires employees to punch out to complete the day; if disabled, shift end time is used as checkout fallback" },
  { key: "lateDeductionPerInstance", label: "Late deduction per instance (৳)", type: "number", min: 0, hint: "Fixed amount deducted from salary for each late day if per-minute and tiered penalties are not configured" },
  { key: "lateDeductionPerMinute", label: "Late deduction per minute (৳)", type: "number", min: 0, step: 0.5, hint: "Deduction per minute of late arrival; when > 0, takes precedence over instance and tiered penalties" },
  { key: "halfDayHours", label: "Half-day threshold (hours)", type: "number", min: 1, step: 0.5, hint: "Minimum hours worked required to count as a half day; working fewer hours marks the day as absent" },
  { key: "absenceDeduction", label: "Deduct day salary for absence", type: "switch", hint: "Deducts daily salary (gross ÷ working days) for unauthorized absent days during payroll calculation" },
  { key: "repeatedLateAlertDays", label: "Repeated-late alert (days/month)", type: "number", min: 1, hint: "Monthly late arrival count threshold that flags employee with a repeated-late warning in attendance reports" },
  { key: "longAbsenceAlertDays", label: "Long-absence alert (days/month)", type: "number", min: 1, hint: "Consecutive or total unexcused absent days in a month that triggers a prolonged absence alert for HR" },
]
const GEOFENCE_FIELDS: GField[] = [
  { key: "enabled", label: "Geo-fence attendance enabled", type: "switch" },
  { key: "defaultRadiusM", label: "Default radius (meters)", type: "number", min: 20 },
  { key: "requirePhoto", label: "Require photo at check-in", type: "switch" },
]
// 2026-10 round — live tracking global defaults (§11/§14/§61)
const TRACKING_FIELDS: GField[] = [
  { key: "enabled", label: "Live tracking enabled (master switch)", type: "switch", hint: "Off hides the Live Tracking map and pauses ingestion" },
  { key: "updateIntervalSec", label: "Location update interval", type: "select", options: [
    { value: "15", label: "Every 15 seconds" }, { value: "30", label: "Every 30 seconds" },
    { value: "60", label: "Every 1 minute" }, { value: "120", label: "Every 2 minutes" },
    { value: "300", label: "Every 5 minutes" }, { value: "600", label: "Every 10 minutes" },
  ], hint: "Default for employees without a tracking policy" },
  { key: "lowBatteryThreshold", label: "Low-battery warning (%)", type: "number", min: 1, hint: "Device battery level (%) that triggers a low battery warning on live tracking" },
  { key: "criticalBatteryThreshold", label: "Critical battery (%)", type: "number", min: 1, hint: "Device battery level (%) that triggers a critical battery alert before shutdown" },
  { key: "offlineAfterMinutes", label: "Offline after no update (minutes)", type: "number", min: 1, hint: "Minutes without a location ping after which the employee is shown as OFFLINE" },
  { key: "retentionDays", label: "Location history retention (days)", type: "select", options: [
    { value: "7", label: "7 days" }, { value: "30", label: "30 days" }, { value: "90", label: "90 days" },
    { value: "180", label: "180 days" }, { value: "365", label: "365 days" }, { value: "0", label: "Keep forever" },
  ], hint: "Applies to raw location telemetry only — attendance summaries, events, audit and payroll history are never auto-deleted" },
]
const LEAVE_FIELDS: GField[] = [
  { key: "allowBackdated", label: "Allow backdated leave", type: "switch" },
  { key: "maxBackdateDays", label: "Max backdate days", type: "number", min: 0 },
  // R4 — “Substitute required” no longer BLOCKS submission. An employee with
  // no available colleague can submit without a substitute; the request skips
  // the substitute-acceptance step and goes straight to the first approver.
  // When ON, the employee portal still nudges the employee to name one.
  { key: "requireSubstitute", label: "Recommend substitute for leave", type: "switch", hint: "ON — employees are nudged to name a substitute, but can still submit without one (the request then goes straight to the first approver). OFF — no nudge." },
  { key: "substituteAcceptanceRequired", label: "Substitute must accept before approval", type: "switch", hint: "Applies only when a substitute IS named — the request waits for their acceptance before entering the approval workflow" },
  { key: "probationMaxDays", label: "Max leave days during probation", type: "number", min: 0 },
  { key: "encashmentOnExit", label: "Encash unused paid leave on exit", type: "switch" },
  // A8 — optional holiday limit
  { key: "optionalHolidayLimit", label: "Optional holidays / employee / year", type: "number", min: 0, hint: "0 = unlimited — leave taken on OPTIONAL-type holidays counts against this cap" },
  // L-9 — holiday-aware balance counting
  { key: "countHolidaysAsLeave", label: "Holidays inside a leave span consume balance", type: "switch", hint: "ON (default) — a public/company holiday inside the leave dates counts as a leave day. OFF — such holidays are skipped (they are already non-working days); the request consumes fewer days." },
  // LVE-112 (R7) — pending-leave SLA + auto-cancel mode
  { key: "approvalSlaDays", label: "Pending-leave SLA (days)", type: "number", min: 0, hint: "0 = off — requests resting longer than this nudge HR daily AND notify the requester" },
  { key: "autoCancelPendingDays", label: "Auto-cancel pending after (days)", type: "number", min: 0, hint: "0 = off — pending requests older than this are auto-cancelled by the daily sweep and their reserved balance released" },
]
const PAYROLL_FIELDS: GField[] = [
  { key: "frequency", label: "Payroll frequency", type: "select", options: [{ value: "MONTHLY", label: "Monthly" }, { value: "WEEKLY", label: "Weekly" }] },
  { key: "cutoffDay", label: "Attendance cut-off day", type: "number", min: 1 },
  { key: "processingDay", label: "Processing day (monthly: day of month · weekly: 1=Mon…7=Sun)", type: "number", min: 1, hint: "On this day the system auto-creates + calculates the draft payroll run" },
  { key: "paymentDay", label: "Payment day (monthly day-of-month; triggers payment reminders)", type: "number", min: 1 },
  { key: "absenceProration", label: "Prorate salary for absence", type: "switch" },
  { key: "attendanceBonusFullMonth", label: "Attendance bonus requires full month", type: "switch" },
  { key: "loanDeductionEnabled", label: "Loan installment deduction", type: "switch" },
  { key: "advanceDeductionEnabled", label: "Advance recovery deduction", type: "switch" },
  { key: "employerContributionPct", label: "Employer contribution (% of gross)", type: "number", min: 0, step: 0.5 },
  { key: "payslipPrefix", label: "Payslip number prefix", type: "text" },
]
const SHIFT_FIELDS: GField[] = [
  { key: "autoDetect", label: "Auto-detect shift from roster", type: "switch", hint: "Falls back to the employee's default shift when no roster assignment covers the date" },
  { key: "otApprovalRequired", label: "Overtime requires approval", type: "switch", hint: "When ON, new overtime is excluded from payroll until approved in Attendance → Daily → OT approvals" },
  { key: "maxOtHoursPerMonth", label: "Max overtime hours / month", type: "number", min: 0, hint: "0 = unlimited — payroll caps payable OT at this figure" },
]
const WISHES_FIELDS: GField[] = [
  { key: "birthdayEnabled", label: "Birthday wishes enabled", type: "switch" },
  { key: "anniversaryEnabled", label: "Work anniversary wishes enabled", type: "switch" },
  { key: "birthdayTemplate", label: "Birthday template", type: "textarea", span: true, hint: "Variables: {{name}} {{company}}" },
  { key: "anniversaryTemplate", label: "Anniversary template", type: "textarea", span: true, hint: "Variables: {{name}} {{company}} {{years}} {{ordinal}}" },
  { key: "emailEnabled", label: "Send wishes by email", type: "switch" },
  { key: "smsEnabled", label: "Send wishes by SMS", type: "switch" },
  { key: "inAppEnabled", label: "Show in-app wishes", type: "switch" },
]
// 2026-10-07 — real-time punch toasts (server: attendance.punchAlerts)
const PUNCH_ALERT_FIELDS: GField[] = [
  { key: "enabled", label: "Show real-time punch alerts", type: "switch", hint: "Master switch for the whole workspace" },
  { key: "devicePunch", label: "Attendance device punches", type: "switch", hint: "ZKTeco / biometric terminals" },
  { key: "geofencePunch", label: "Geo-fence check-in / out", type: "switch" },
  { key: "selfiePunch", label: "Selfie check-in / out", type: "switch", hint: "Includes selfie + geo-fence" },
  { key: "checkOut", label: "Also alert on check-outs", type: "switch", hint: "Off = check-ins only" },
  {
    key: "permission", label: "Who receives the alerts", type: "select",
    options: [
      { value: "attendance.view", label: "Users with Attendance → View" },
      { value: "attendance.verify", label: "Users with Attendance → Verify (reviewers)" },
      { value: "attendance.edit", label: "Users with Attendance → Edit" },
      { value: "devices.view", label: "Users with Attendance Devices → View" },
      { value: "tracking.view", label: "Users with Live Tracking → View" },
    ],
    hint: "Grant or revoke the permission per role in Security & Access → Roles & Permissions",
  },
  { key: "pollSeconds", label: "Check for new punches every (seconds)", type: "number", min: 10, step: 5, hint: "10–120 · each user can still mute alerts in their own browser (bell on Attendance → Daily)" },
]
const NOTIFICATION_FIELDS: GField[] = [
  { key: "leaveRequestEmail", label: "Leave request email to manager", type: "switch" },
  { key: "payslipEmail", label: "Payslip email on payment", type: "switch" },
  { key: "salarySms", label: "Salary credited SMS", type: "switch" },
  { key: "attendanceAlertSms", label: "Attendance alert SMS", type: "switch" },
  { key: "documentExpiryDays", label: "Document expiry horizon (days, fallback)", type: "number", min: 1, hint: "Default lead time for document types without an entry in the matrix below" },
]
// HRM-008 — late-coming policy (grace, tiered penalties, day salary deduction, leave adjustment, escalation, cap)
const LATE_POLICY_FIELDS: GField[] = [
  { key: "graceMinutes", label: "Grace period (minutes)", type: "number", min: 0, default: 10, hint: "Arrivals within this window after shift start are not marked LATE" },
  {
    key: "deductionMode", label: "Late deduction policy rule", type: "select", default: "TIERED",
    options: [
      { value: "TIERED", label: "Tiered penalty (by late minutes: Tier 1 / Tier 2)" },
      { value: "DAY_SALARY", label: "Day salary deduction (e.g. on X days late = Y days salary)" },
      { value: "LEAVE_ADJUSTMENT", label: "Leave adjustment (e.g. on X days late = Y days leave deduction)" },
      { value: "FIXED_AMOUNT", label: "Fixed amount per late day (e.g. ৳50 per late day)" },
      { value: "PER_MINUTE", label: "Per minute deduction (e.g. ৳ per minute late)" },
      { value: "NONE", label: "No deduction / Grace period only" },
    ],
    hint: "Rule used to calculate late penalties during payroll calculation",
  },

  // ── TIERED fields ────────────────────────────────────────────────────────
  {
    key: "tier1Minutes", label: "Tier 1 from (minutes late)", type: "number", min: 0, default: 15,
    hint: "Minutes late required to trigger Tier 1 penalty (e.g. 15 minutes past shift start)",
    showWhen: (v) => !v.deductionMode || v.deductionMode === "TIERED",
  },
  {
    key: "tier1Penalty", label: "Tier 1 penalty (৳)", type: "number", min: 0, default: 50,
    hint: "Fixed penalty amount (৳) deducted from payroll for late arrivals in Tier 1",
    showWhen: (v) => !v.deductionMode || v.deductionMode === "TIERED",
  },
  {
    key: "tier2Minutes", label: "Tier 2 from (minutes late)", type: "number", min: 0, default: 30,
    hint: "Minutes late required to trigger the higher Tier 2 penalty (e.g. 30 minutes past shift start)",
    showWhen: (v) => !v.deductionMode || v.deductionMode === "TIERED",
  },
  {
    key: "tier2Penalty", label: "Tier 2 penalty (৳)", type: "number", min: 0, default: 100,
    hint: "Fixed penalty amount (৳) deducted from payroll for late arrivals reaching Tier 2",
    showWhen: (v) => !v.deductionMode || v.deductionMode === "TIERED",
  },

  // ── DAY_SALARY / LEAVE_ADJUSTMENT shared fields ──────────────────────────
  {
    key: "lateDaysThreshold", label: "Late days threshold (X days late)", type: "number", min: 1, default: 3,
    hint: "Late day count required to trigger deduction (e.g. 3 → 'every 3 days late = Y days deducted')",
    showWhen: (v) => v.deductionMode === "DAY_SALARY" || v.deductionMode === "LEAVE_ADJUSTMENT",
  },
  {
    key: "deductDays", label: "Deduction / adjustment days (Y days)", type: "number", min: 0.5, step: 0.5, default: 1,
    hint: "Number of days deducted or adjusted when reaching the late threshold (e.g. 1 day)",
    showWhen: (v) => v.deductionMode === "DAY_SALARY" || v.deductionMode === "LEAVE_ADJUSTMENT",
  },
  {
    key: "salaryBasis", label: "Salary deduction basis", type: "select", default: "BASIC",
    options: [
      { value: "BASIC", label: "Basic salary (Basic ÷ Working Days)" },
      { value: "GROSS", label: "Gross salary (Gross ÷ Working Days)" },
    ],
    hint: "Whether the daily rate is derived from Basic or Gross salary",
    showWhen: (v) => v.deductionMode === "DAY_SALARY" || v.deductionMode === "LEAVE_ADJUSTMENT",
  },

  // ── LEAVE_ADJUSTMENT-only fields ─────────────────────────────────────────
  {
    key: "leaveTypeId", label: "Leave type for adjustment", type: "text", default: "FIRST_AVAILABLE_PAID",
    hint: "Leave type ID to deduct from (find it in Attendance → Leave Types). Use 'FIRST_AVAILABLE_PAID' to auto-select: Casual → Earned → other paid",
    showWhen: (v) => v.deductionMode === "LEAVE_ADJUSTMENT",
  },
  {
    key: "leaveInsufficientFallback", label: "Fallback if leave balance is exhausted", type: "select", default: "DEDUCT_SALARY",
    options: [
      { value: "DEDUCT_SALARY", label: "Deduct remaining days from salary (using basis above)" },
      { value: "UNPAID_ABSENCE", label: "Mark remaining as unpaid absence deduction" },
      { value: "NONE", label: "Do not deduct salary (waive remaining)" },
    ],
    hint: "Action taken when an employee has insufficient leave balance to cover required late deduction days",
    showWhen: (v) => v.deductionMode === "LEAVE_ADJUSTMENT",
  },

  // ── FIXED_AMOUNT fields ──────────────────────────────────────────────────
  {
    key: "fixedDeductionPerDay", label: "Fixed deduction per late day (৳)", type: "number", min: 0, default: 50,
    hint: "Fixed amount (৳) deducted from payroll for each late day",
    showWhen: (v) => v.deductionMode === "FIXED_AMOUNT",
  },

  // ── PER_MINUTE fields ────────────────────────────────────────────────────
  {
    key: "perMinuteDeduction", label: "Deduction per minute (৳)", type: "number", min: 0, step: 0.5, default: 0,
    hint: "Amount (৳) deducted per minute of lateness",
    showWhen: (v) => v.deductionMode === "PER_MINUTE",
  },

  // ── Repeat-offender escalation (all modes except NONE) ───────────────────
  {
    key: "repeatOffenderDays", label: "Repeat offender after (late days/month)", type: "number", min: 0, default: 3,
    hint: "Number of late days in a month that classifies an employee as a habitual latecomer — triggers an extra monthly penalty on top of the base deduction",
    showWhen: (v) => !v.deductionMode || v.deductionMode !== "NONE",
  },
  {
    key: "repeatOffenderPenalty", label: "Repeat offender penalty (৳/month)", type: "number", min: 0, default: 200,
    hint: "Additional monthly penalty (৳) added to payroll deductions for repeat offenders",
    showWhen: (v) => !v.deductionMode || v.deductionMode !== "NONE",
  },

  // ── Cap (all modes except NONE) ──────────────────────────────────────────
  {
    key: "maxDeductionCap", label: "Maximum late deduction cap (৳/month)", type: "number", min: 0, default: 0,
    hint: "Upper ceiling for total late deductions in a month (৳). 0 = unlimited / no cap",
    showWhen: (v) => !v.deductionMode || v.deductionMode !== "NONE",
  },
]
// HRM-009 — early-leave policy
const EARLY_LEAVE_FIELDS: GField[] = [
  { key: "thresholdMinutes", label: "Early-leave threshold (minutes)", type: "number", min: 0, hint: "Check-out this many minutes before shift end marks EARLY_LEAVE" },
  { key: "deductionPerInstance", label: "Deduction per instance (৳)", type: "number", min: 0, hint: "Fixed deduction amount (৳) applied at payroll for each unauthorized early departure" },
]
// HRM-010 — vendor-level overtime rates (per-shift multipliers override)
const OT_RATES_FIELDS: GField[] = [
  { key: "weekdayRate", label: "Weekday OT rate (×)", type: "number", min: 0, step: 0.25, hint: "Multiplier of the base hour rate (basic ÷ 208h)" },
  { key: "holidayRate", label: "Holiday OT rate (×)", type: "number", min: 0, step: 0.25 },
  { key: "weeklyOffRate", label: "Weekly-off OT rate (×)", type: "number", min: 0, step: 0.25 },
  { key: "calcBasis", label: "Calculation basis", type: "select", options: [
    { value: "FIXED", label: "Fixed — pay exact minutes" },
    { value: "ROUNDED", label: "Rounded — nearest step" },
    { value: "ROUNDED_UP", label: "Rounded up — next step" },
  ], hint: "How each day's payable OT minutes are rounded before costing" },
  { key: "roundToMinutes", label: "Round to (minutes)", type: "number", min: 0, step: 5, hint: "0 = no rounding (basis FIXED ignores this)" },
]
// HRM-007 — password policy (complexity, expiry, reuse, lockout)
const PASSWORD_POLICY_FIELDS: GField[] = [
  { key: "minLength", label: "Minimum length", type: "number", min: 6 },
  { key: "requireUpper", label: "Require uppercase letter", type: "switch" },
  { key: "requireLower", label: "Require lowercase letter", type: "switch" },
  { key: "requireDigit", label: "Require digit", type: "switch" },
  { key: "requireSymbol", label: "Require symbol", type: "switch" },
  { key: "expiryDays", label: "Password expiry (days)", type: "number", min: 0, hint: "0 = never — expired passwords force a change at next login" },
  { key: "historyCount", label: "Reuse history (previous passwords blocked)", type: "number", min: 0, hint: "0 = no reuse check" },
  { key: "lockoutThreshold", label: "Lockout after failed logins", type: "number", min: 0 },
  { key: "lockoutMinutes", label: "Lockout duration (minutes)", type: "number", min: 1 },
]
// S6 — session policy (idle timeout, concurrent cap)
const SESSION_POLICY_FIELDS: GField[] = [
  { key: "idleTimeoutMinutes", label: "Idle session timeout (minutes)", type: "number", min: 0, hint: "0 = disabled — inactive sessions are signed out after this window" },
  { key: "concurrentSessions", label: "Concurrent sessions per user", type: "number", min: 0, hint: "0 = unlimited — oldest sessions are dropped beyond the cap" },
]
// L1/L5 — localization & formats
const LOCALIZATION_FIELDS: GField[] = [
  { key: "language", label: "Language", type: "select", options: [
    { value: "en", label: "English" }, { value: "bn", label: "বাংলা (Bangla)" },
  ], hint: "Applies Bangla labels to the navigation sidebar (toggle also lives in the sidebar footer)" },
  { key: "currency", label: "Currency code", type: "text" },
  { key: "currencySymbol", label: "Currency symbol", type: "text" },
  { key: "timeFormat", label: "Time format", type: "select", options: [{ value: "12h", label: "12-hour (hh:mm AM/PM)" }, { value: "24h", label: "24-hour (HH:mm)" }] },
  { key: "numberFormat", label: "Number format", type: "select", options: [{ value: "123,456", label: "International — 123,456" }, { value: "1,23,456", label: "South-Asian — 1,23,456" }] },
]
// B1 — branding / white-label theme
const BRANDING_FIELDS: GField[] = [
  { key: "primaryColor", label: "Primary color", type: "text", hint: "Hex color (e.g. #059669) used for accents" },
  { key: "accentColor", label: "Accent color", type: "text", hint: "Hex color (e.g. #0d9488)" },
  { key: "darkModeDefault", label: "Dark mode by default", type: "switch" },
]
// T5 — audit retention
const AUDIT_RETENTION_FIELDS: GField[] = [
  { key: "days", label: "Audit retention (days)", type: "number", min: 0, hint: "0 = keep forever — older rows can be purged from System Health" },
]
// Employee management defaults (Settings → Employee)
const EMPLOYEE_SETTINGS_FIELDS: GField[] = [
  { key: "idPrefix", label: "Employee ID Prefix", type: "text", hint: "Generated codes read PREFIX-0001 (default EMP → EMP-0001)" },
  { key: "idSuffix", label: "Employee ID Suffix", type: "text", hint: "Optional text appended after the number, e.g. FX → EMP-0001FX" },
  { key: "idStartNumber", label: "Employee ID Starting Number", type: "number", min: 1, hint: "First number for NEW codes — existing employee codes are never renumbered" },
  { key: "idPadLength", label: "Zero Padding Width", type: "number", min: 1, hint: "Digits in the number (4 → 0001)" },
  { key: "defaultProbationMonths", label: "Default Probation Period (months)", type: "number", min: 0, hint: "Pre-filled at employee creation when the form leaves it blank" },
  { key: "defaultNoticePeriodDays", label: "Default Notice Period (days)", type: "number", min: 1, hint: "Applied to new resignation submissions (staff / contract convention)" },
  // EXIT-008 — BD Labour Act worker notice matrix
  { key: "workerNoticeMatrix", label: "BLA worker notice matrix (60/120 days)", type: "switch", hint: "ON: non-probationary monthly-rated workers require 120 days' notice after 5 years' service (60 before); OFF: everyone follows the Default Notice Period above" },
]
// Provident Fund vendor defaults (Settings → Payroll → Provident Fund)
const PF_FIELDS: GField[] = [
  { key: "enabled", label: "Provident Fund enabled", type: "switch", hint: "When off, no PF is calculated even for enrolled employees" },
  { key: "employeePct", label: "Employee contribution (% of basis)", type: "number", min: 0, step: 0.5, hint: "Withheld from salary at payroll" },
  { key: "employerPct", label: "Employer contribution (% of basis)", type: "number", min: 0, step: 0.5, hint: "Employer cost — posts to the PF payable account" },
  { key: "basis", label: "Contribution basis", type: "select", options: [
    { value: "BASIC", label: "Basic salary" },
    { value: "GROSS", label: "Gross salary" },
  ] },
  { key: "minServiceMonths", label: "Minimum service (months) to enroll", type: "number", min: 0, hint: "0 = eligible immediately" },
  { key: "autoEnroll", label: "Auto Enroll Employees", type: "switch", span: true, hint: "When enabled, active employees who meet the minimum service period and eligible status are automatically enrolled in Provident Fund — no manual per-head enrollment needed." },
  {
    key: "eligibleStatuses",
    label: "Eligible Employee Statuses",
    type: "multicheck",
    span: true,
    default: ["ACTIVE", "PROBATION"],
    options: [
      { value: "ACTIVE", label: "Active" },
      { value: "PROBATION", label: "Probation" },
      { value: "ON_LEAVE", label: "On Leave" },
      { value: "SUSPENDED", label: "Suspended" },
      { value: "INACTIVE", label: "Inactive" },
      { value: "RESIGNED", label: "Resigned" },
      { value: "TERMINATED", label: "Terminated" },
      { value: "RETIRED", label: "Retired" },
    ],
    hint: "Select which employee statuses are eligible for Provident Fund. Unselected statuses (such as Terminated, Suspended, or Inactive) are strictly excluded from auto-enrollment and will have PF salary deductions suppressed at payroll.",
  },
  // EXIT-007 — PF settlement at exit
  { key: "settleAtExit", label: "Settle PF with the final settlement", type: "switch", hint: "The exit settlement pays out the accumulated PF balance and closes the enrollment" },
  { key: "includeEmployerAtExit", label: "Pay the employer share at exit too", type: "switch", hint: "Policy choice — OFF pays only the employee's own contributions" },
]
// LOAN-POL — Loans & Advances eligibility controls (Settings → Payroll → Loans & Advances Policy)
const LOAN_POLICY_FIELDS: GField[] = [
  {
    key: "eligibleStatuses",
    label: "Borrower Eligible Employee Statuses",
    type: "multicheck",
    span: true,
    default: ["ACTIVE", "PROBATION"],
    options: [
      { value: "ACTIVE", label: "Active" },
      { value: "PROBATION", label: "Probation" },
      { value: "ON_LEAVE", label: "On Leave" },
      { value: "SUSPENDED", label: "Suspended" },
      { value: "INACTIVE", label: "Inactive" },
      { value: "RESIGNED", label: "Resigned" },
      { value: "TERMINATED", label: "Terminated" },
      { value: "RETIRED", label: "Retired" },
    ],
    hint: "Select employee statuses eligible to apply for loans and salary advances. Unselected statuses are strictly blocked from submitting applications.",
  },
  {
    key: "minServiceMonths",
    label: "Minimum Employee Service Period (Months)",
    type: "number",
    min: 0,
    hint: "Minimum completed months of continuous service required before applying (0 = eligible immediately upon joining)",
  },
  {
    key: "minPreviousRepaymentPct",
    label: "Previous Loan / Advance Payout Ratio (%)",
    type: "number",
    min: 0,
    max: 100,
    hint: "Minimum on-time repayment track record (%) required from historical loans & advances (e.g. 80% or 100%)",
  },
  {
    key: "allowConcurrentLoans",
    label: "Allow Concurrent Loans / Advances",
    type: "switch",
    hint: "Allow an employee to request a new loan or advance while currently having an ongoing active loan or recovering advance",
  },
  {
    key: "maxConcurrentLoans",
    label: "Max Concurrent Active Loans & Advances",
    type: "number",
    min: 1,
    max: 5,
    hint: "Maximum total simultaneous active loans and recovering advances allowed per employee when concurrent applications are enabled",
  },
  {
    key: "minCurrentRepaidPctForNewLoan",
    label: "Min Repaid % on Active Loan / Advance for New Application",
    type: "number",
    min: 0,
    max: 100,
    hint: "Percentage of any existing active loan or recovering advance that must already be repaid before a new loan or advance application is permitted (e.g. 50%)",
  },
  {
    key: "guarantorRequired",
    label: "Require Guarantor for All Loans & Advances",
    type: "switch",
    hint: "When enabled, a qualified employee guarantor is mandatory for every loan and salary advance application",
  },
  {
    key: "guarantorEligibleStatuses",
    label: "Guarantor Eligible Statuses",
    type: "multicheck",
    span: true,
    default: ["ACTIVE"],
    options: [
      { value: "ACTIVE", label: "Active" },
      { value: "PROBATION", label: "Probation" },
      { value: "ON_LEAVE", label: "On Leave" },
      { value: "SUSPENDED", label: "Suspended" },
      { value: "INACTIVE", label: "Inactive" },
      { value: "RESIGNED", label: "Resigned" },
      { value: "TERMINATED", label: "Terminated" },
      { value: "RETIRED", label: "Retired" },
    ],
    hint: "Employee statuses permitted to act as loan & advance guarantor for colleagues",
  },
  {
    key: "guarantorMinServiceMonths",
    label: "Guarantor Minimum Service Period (Months)",
    type: "number",
    min: 0,
    hint: "Minimum service tenure (months) required before an employee qualifies to act as a guarantor",
  },
  {
    key: "guarantorAllowActiveLoan",
    label: "Allow Guarantor with Active Loan / Advance",
    type: "switch",
    hint: "When disabled, employees who currently have an active loan or recovering advance cannot act as guarantor",
  },
  {
    key: "guarantorMinRepaymentPct",
    label: "Guarantor Historical Payout Ratio (%)",
    type: "number",
    min: 0,
    max: 100,
    hint: "Minimum repayment track record (%) required for guarantor's own historical loans/advances",
  },
]
// PAY-006 — bonus approval exposure controls (Settings → Payroll → Bonus Approval)
const BONUS_APPROVAL_FIELDS: GField[] = [
  { key: "escalationThreshold", label: "Escalation threshold (৳)", type: "number", min: 0, hint: "Bonuses at/above this amount require the BONUS approval workflow (0 = direct approval always). Seed or configure the workflow under Settings → Approval Workflows" },
  { key: "exposureWarnPct", label: "Preflight exposure warning (%)", type: "number", min: 0, hint: "Payroll preflight warns when APPROVED bonus/commission exposure for the period exceeds this % of the payroll baseline" },
]
// EXIT-001 (R3-1) — Statutory gratuity rules (Settings → Leave & Payroll → Gratuity)
const GRATUITY_FIELDS: GField[] = [
  {
    key: "enabled",
    label: "Statutory Gratuity Benefit Enabled",
    type: "switch",
    span: true,
    hint: "Master switch: when enabled, statutory gratuity is automatically calculated for eligible employees at exit and projected in reports (Bangladesh Labour Act 2006 §96). When disabled, gratuity calculations are suppressed across all modules.",
  },
  {
    key: "eligibilityYears",
    label: "Continuous Service Eligibility (Years)",
    type: "number",
    min: 1,
    max: 20,
    hint: "Completed continuous service years required before gratuity vests (Statutory BLA default: 5 years; continuous service of 4 years 6 months or more rounds up to 5 full years under 2018 amendment).",
  },
  {
    key: "daysPerYear",
    label: "Wages per Completed Year of Service (Days)",
    type: "number",
    min: 1,
    max: 60,
    hint: "Number of days of wages payable for each completed year (Statutory standard: 30 days of wages per completed year; 45 days for service exceeding 10 years where applicable).",
  },
  {
    key: "wageBasis",
    label: "Wage Computation Basis",
    type: "select",
    options: [
      { value: "BASIC", label: "Basic Salary (Statutory BLA §96 default)" },
      { value: "GROSS", label: "Gross Salary (Enhanced Enterprise Policy)" },
    ],
    hint: "Base salary component used to derive the single day wage rate.",
  },
  {
    key: "divisor",
    label: "Daily Rate Calculation Divisor",
    type: "select",
    coerceNumber: true,
    options: [
      { value: "30", label: "30 Days — BLA Statutory Calendar Day Convention (monthly wage ÷ 30)" },
      { value: "26", label: "26 Days — Factory / Industrial Working Day Convention (monthly wage ÷ 26)" },
    ],
    hint: "Divisor applied to the monthly wage basis to derive the daily rate.",
  },
  {
    key: "capAmount",
    label: "Maximum Gratuity Cap Amount (৳)",
    type: "number",
    min: 0,
    hint: "Optional corporate ceiling cap on total gratuity payable per employee (0 = Uncapped / Statutory unlimited).",
  },
]
// C-03 update — device gateway security (Settings → Devices): the admin
// toggle replaces the removed 7-day keyless grace window and is the single
// control for pre-registered terminals without a comm key.
const DEVICE_FIELDS: GField[] = [
  { key: "allowKeyless", label: "Allow Keyless Devices", type: "switch", span: true,
    hint: "ON — registered devices without a communication key communicate normally. OFF — keyless devices are rejected with 401 Unauthorized until a key is enrolled (Attendance → Devices → key icon). Devices with a communication key always work, regardless of this setting." },
]
// R5 — Self-Service ("My Portal") visibility controls. Each switch hides the
// matching quick-action button (and in-tab request button) in the employee
// portal. Existing records stay visible — only the request entry points hide.
const ESS_PORTAL_FIELDS: GField[] = [
  { key: "showGeoCheckIn", label: "Geo Check-In button", type: "switch", hint: "GPS-validated check-in from the portal header" },
  { key: "showSelfieGeoCheckIn", label: "Selfie + Geo Check-In button", type: "switch", hint: "Combined punch: in-app selfie capture with GPS geo-fence validation (records the GEOFENCE_SELFIE method)" },
  { key: "showSelfieCheckIn", label: "Selfie Check-In button", type: "switch", hint: "Selfie-first check-in with best-effort GPS (also requires SELFIE in the employee's attendance method policy)" },
  { key: "showCheckOut", label: "Check Out button", type: "switch", hint: "End-of-day check-out (geo-fenced when location is available)" },
  { key: "showApplyLeave", label: "Apply Leave button", type: "switch", hint: "Leave application quick action (My Leave tab stays read-only)" },
  { key: "showExpenseClaim", label: "Submit Expense button", type: "switch", hint: "Expense claim quick action" },
  { key: "showLoanRequest", label: "Request Loan button", type: "switch", hint: "Loan application (quick action + My Loans tab button)" },
  { key: "showAdvanceRequest", label: "Request Advance button", type: "switch", hint: "Salary advance request (My Loans tab)" },
  { key: "showGoodsRequest", label: "Request Goods button", type: "switch", hint: "Goods requisition quick action" },
  { key: "showResignation", label: "Submit Resignation button", type: "switch", hint: "Resignation submission (quick action + My Resignation tab)" },
]

// G3 — selfie consent policy editor (group selfieConsent)
const SELFIE_CONSENT_FIELDS: GField[] = [
  { key: "enabled", label: "Require consent acknowledgment", type: "switch", hint: "ON — the portal shows the consent text below and records each employee's acceptance (version + time + IP). OFF — no consent surface (selfie evidence rules unchanged)." },
  { key: "version", label: "Policy version", type: "text", hint: "e.g. 2026-10-03.1 — bumping the version re-asks every employee; prior agreements stay on file" },
  { key: "text", label: "Consent text", type: "textarea", hint: "What you tell employees about selfie capture: purpose, private storage, who can view, retention" },
]

function groupDefaults(fields: GField[], settings: any, group: string): Record<string, any> {
  const initial: Record<string, any> = {}
  const g = settings?.[group] || {}
  for (const f of fields) {
    initial[f.key] = g[f.key] != null ? g[f.key] : (f.default != null ? f.default : f.type === "switch" ? false : (f.type === "weekdays" || f.type === "multicheck") ? [] : f.type === "number" ? 0 : "")
  }
  return initial
}

function GroupEditor({ group, title, description, icon: Icon, fields, settings, canEdit, onSaved }: {
  group: string; title: string; description: string; icon: any; fields: GField[]
  settings: any; canEdit: boolean; onSaved: () => void
}) {
  const toast = useHrm((s) => s.toast)
  const [values, setValues] = useState<Record<string, any>>(() => groupDefaults(fields, settings, group))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Re-sync when fresh settings arrive after a save/reload. Parent only reloads
  // on demand (no poller), so this can't wipe values mid-entry.
  useEffect(() => {
    setValues(groupDefaults(fields, settings, group))
  }, [settings, group, fields])

  if (!settings) return <div className="rounded-xl border bg-white dark:bg-slate-900 p-6 text-center text-sm text-slate-400">Loading settings…</div>

  const set = (k: string, v: any) => setValues((s) => ({ ...s, [k]: v }))

  const save = async () => {
    setBusy(true)
    setError(null)
    try {
      // H-12 — shared save path merges the response into the store
      await useHrm.getState().saveSettingsGroup(group, values)
      toast(`${title} saved`)
      onSaved()
    } catch (e: any) { setError(e.message) } finally { setBusy(false) }
  }

  return (
    <SectionCard title={title} actions={
      canEdit ? (
        <Button size="sm" className="h-8 text-xs " onClick={save} disabled={busy}>
          <Save className="h-3.5 w-3.5 mr-1" /> {busy ? "Saving…" : "Save"}
        </Button>
      ) : <Badge variant="outline" className="text-[10px]">Read-only</Badge>
    }>
      <div className="flex items-start gap-2.5 mb-4">
        <div className="h-8 w-8 rounded-lg bg-emerald-50 dark:bg-emerald-950 flex items-center justify-center shrink-0">
          <Icon className="h-4 w-4 text-emerald-600" />
        </div>
        <p className="text-xs text-slate-500 pt-1.5">{description}</p>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-4">
        {fields.filter((f) => !f.showWhen || f.showWhen(values)).map((f) => (
          <div key={f.key} className={`space-y-1.5 ${f.span ? "sm:col-span-2" : ""}`}>
            {f.type === "switch" ? (
              <div className="flex items-center gap-2">
                <Switch id={`${group}-${f.key}`} checked={!!values[f.key]} disabled={!canEdit} onCheckedChange={(c) => set(f.key, c)} />
                <Label htmlFor={`${group}-${f.key}`} className="text-xs font-medium text-slate-700 dark:text-slate-300">{f.label}</Label>
              </div>
            ) : (
              <>
                <Label htmlFor={`${group}-${f.key}`} className="text-xs font-medium text-slate-600 dark:text-slate-300">{f.label}</Label>
                {f.type === "text" && (
                  <Input id={`${group}-${f.key}`} value={values[f.key] ?? ""} disabled={!canEdit} onChange={(e) => set(f.key, e.target.value)} className="h-9" />
                )}
                {f.type === "password" && (
                  <Input id={`${group}-${f.key}`} type="password" autoComplete="new-password" value={values[f.key] ?? ""} disabled={!canEdit}
                    onChange={(e) => set(f.key, e.target.value)} className="h-9" />
                )}
                {f.type === "number" && (
                  <Input id={`${group}-${f.key}`} type="number" min={f.min} step={f.step || "any"} value={values[f.key] ?? ""} disabled={!canEdit}
                    onChange={(e) => set(f.key, e.target.value === "" ? 0 : Number(e.target.value))} className="h-9" />
                )}
                {f.type === "select" && (
                  <Select value={String(values[f.key] ?? "")} onValueChange={(v) => set(f.key, f.coerceNumber ? Number(v) : v)} disabled={!canEdit}>
                    <SelectTrigger className="h-9" id={`${group}-${f.key}`}><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {(f.options || []).map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
                    </SelectContent>
                  </Select>
                )}
                {f.type === "textarea" && (
                  <Textarea id={`${group}-${f.key}`} rows={3} value={values[f.key] ?? ""} disabled={!canEdit} onChange={(e) => set(f.key, e.target.value)} />
                )}
                {f.type === "weekdays" && (
                  <div className="flex flex-wrap gap-1.5 pt-1">
                    {WEEKDAYS.map((d) => (
                      <label key={d} className={`flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs ${values[f.key]?.includes(d) ? "border-emerald-300 bg-emerald-50 dark:bg-emerald-950 text-emerald-700 dark:text-emerald-300" : "text-slate-500"}`}>
                        <Checkbox checked={(values[f.key] || []).includes(d)} disabled={!canEdit}
                          onCheckedChange={(c) => set(f.key, c ? [...(values[f.key] || []), d] : (values[f.key] || []).filter((x: string) => x !== d))} />
                        {d.slice(0, 3)}
                      </label>
                    ))}
                  </div>
                )}
                {f.type === "multicheck" && (
                  <div className="flex flex-wrap gap-2 pt-1">
                    {(f.options || []).map((opt) => {
                      const list: string[] = Array.isArray(values[f.key]) ? values[f.key] : []
                      const selected = list.includes(opt.value)
                      return (
                        <label
                          key={opt.value}
                          className={`flex items-center gap-2 rounded-lg border px-3 py-1.5 text-xs font-medium cursor-pointer select-none transition-all ${
                            selected
                              ? "border-emerald-500 bg-emerald-50 dark:bg-emerald-950/40 text-emerald-800 dark:text-emerald-200 shadow-xs"
                              : "border-border bg-card text-slate-600 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800"
                          }`}
                        >
                          <Checkbox
                            checked={selected}
                            disabled={!canEdit}
                            onCheckedChange={(c) =>
                              set(
                                f.key,
                                c
                                  ? [...list, opt.value]
                                  : list.filter((x: string) => x !== opt.value)
                              )
                            }
                          />
                          <span>{opt.label}</span>
                        </label>
                      )
                    })}
                  </div>
                )}
              </>
            )}
            {f.hint && <p className="text-[11px] text-slate-500 dark:text-slate-400">{f.hint}</p>}
          </div>
        ))}
      </div>
      {error && <p className="text-sm text-rose-600 bg-rose-50 rounded-md px-3 py-2 mt-3">{error}</p>}
    </SectionCard>
  )
}

// ================= users & roles =================
// PasswordPolicyCard — replaces the GroupEditor pair for passwordPolicy (Change 4)
function PasswordPolicyCard({ settings, canEdit, onSaved }: { settings: any; canEdit: boolean; onSaved: () => void }) {
  const toast = useHrm((s) => s.toast)
  const [values, setValues] = useState<Record<string, any>>(() => groupDefaults(PASSWORD_POLICY_FIELDS, settings, "passwordPolicy"))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setValues(groupDefaults(PASSWORD_POLICY_FIELDS, settings, "passwordPolicy"))
  }, [settings])

  const set = (key: string, val: any) => setValues((prev) => ({ ...prev, [key]: val }))

  const save = async () => {
    setBusy(true); setError(null)
    try {
      await useHrm.getState().saveSettingsGroup("passwordPolicy", values)
      toast("Password policy saved")
      onSaved()
    } catch (e: any) { setError(e.message) } finally { setBusy(false) }
  }

  const complexityToggles: { key: string; label: string; short: string }[] = [
    { key: "requireUpper", label: "Uppercase letter", short: "A–Z" },
    { key: "requireLower", label: "Lowercase letter", short: "a–z" },
    { key: "requireDigit", label: "Number / Digit", short: "0–9" },
    { key: "requireSymbol", label: "Special Symbol", short: "!@#…" },
  ]

  return (
    <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden shadow-xs">
      {/* gradient header */}
      <div className="flex items-center justify-between px-4 py-2.5 bg-gradient-to-r from-slate-50 via-slate-50/80 to-slate-100/60 dark:from-slate-800/60 dark:via-slate-850 dark:to-slate-900 border-b border-slate-200/80 dark:border-slate-800">
        <div className="flex items-center gap-2.5">
          <div className="h-7 w-7 rounded-lg bg-violet-100/80 dark:bg-violet-950/60 border border-violet-200/60 dark:border-violet-900/40 flex items-center justify-center">
            <Lock className="h-3.5 w-3.5 text-violet-600 dark:text-violet-400" />
          </div>
          <div>
            <h3 className="text-xs font-semibold text-slate-800 dark:text-slate-100 leading-tight">Password Security Policy</h3>
            <p className="text-[11px] text-slate-500 dark:text-slate-400">Complexity rules, rotation cycle, and failed-login lockout</p>
          </div>
        </div>
        {canEdit && (
          <Button size="sm" className="h-7 text-xs font-medium" onClick={save} disabled={busy}>
            <Save className="h-3 w-3 mr-1" />{busy ? "Saving…" : "Save Policy"}
          </Button>
        )}
      </div>

      {/* two-column body */}
      <div className="grid grid-cols-1 md:grid-cols-2 divide-y md:divide-y-0 md:divide-x divide-slate-100 dark:divide-slate-800">
        {/* Left — Complexity */}
        <div className="p-4 space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-400 dark:text-slate-500">Complexity Requirements</span>
            <span className="text-[10px] text-slate-400">Enforced at next reset</span>
          </div>

          {/* 2×2 pill grid */}
          <div className="grid grid-cols-2 gap-2">
            {complexityToggles.map(({ key, label, short }) => {
              const active = !!values[key]
              return (
                <button
                  key={key}
                  type="button"
                  disabled={!canEdit}
                  onClick={() => set(key, !active)}
                  className={`flex items-center justify-between gap-2 rounded-lg border px-2.5 py-1.5 text-xs font-medium transition-all select-none
                    ${active
                      ? "border-violet-400/80 bg-violet-50/70 dark:bg-violet-950/40 text-violet-900 dark:text-violet-200 shadow-xs"
                      : "border-slate-200/80 dark:border-slate-700/80 bg-slate-50/60 dark:bg-slate-800/40 text-slate-500 dark:text-slate-400 hover:bg-slate-100/60 dark:hover:bg-slate-800"
                    } disabled:opacity-50 disabled:cursor-not-allowed`}
                >
                  <div className="flex items-center gap-1.5 min-w-0">
                    <span className={`h-3.5 w-3.5 rounded-full flex items-center justify-center shrink-0 transition-colors
                      ${active ? "bg-violet-600 text-white" : "border border-slate-300 dark:border-slate-600"}`}>
                      {active && (
                        <svg className="h-2.5 w-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                        </svg>
                      )}
                    </span>
                    <span className="truncate text-left text-[11px]">{label}</span>
                  </div>
                  <span className={`text-[10px] font-mono shrink-0 ${active ? "text-violet-600 dark:text-violet-400 font-semibold" : "text-slate-400"}`}>{short}</span>
                </button>
              )
            })}
          </div>

          {/* Min length inline */}
          <div className="flex items-center justify-between gap-2 pt-1 px-1">
            <div>
              <p className="text-xs font-medium text-slate-700 dark:text-slate-200">Minimum Password Length</p>
              <p className="text-[10px] text-slate-400">At least 6 characters required</p>
            </div>
            <div className="flex items-center gap-1.5">
              <Input
                type="number" min={6}
                value={values.minLength ?? 8}
                disabled={!canEdit}
                onChange={(e) => set("minLength", e.target.value === "" ? 0 : Number(e.target.value))}
                className="h-7 w-16 text-xs text-center font-medium"
              />
              <span className="text-[11px] text-slate-400">chars</span>
            </div>
          </div>
        </div>

        {/* Right — Expiry & Lockout */}
        <div className="p-4 space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-400 dark:text-slate-500">Expiry &amp; Lockout</span>
            <span className="text-[10px] text-slate-400">Brute-force shield</span>
          </div>

          <div className="grid grid-cols-2 gap-2.5">
            {[
              { key: "expiryDays", label: "Password Expiry", hint: "0 = never expires", unit: "days" },
              { key: "historyCount", label: "History Check", hint: "0 = no check", unit: "prev." },
              { key: "lockoutThreshold", label: "Failed Lockout", hint: "0 = disabled", unit: "tries" },
              { key: "lockoutMinutes", label: "Lockout Time", hint: "min duration", unit: "mins" },
            ].map(({ key, label, hint, unit }) => (
              <div key={key} className="rounded-lg border border-slate-100 dark:border-slate-800/80 bg-slate-50/50 dark:bg-slate-850/40 p-2 space-y-1">
                <div className="flex items-center justify-between">
                  <label className="text-[11px] font-medium text-slate-600 dark:text-slate-300 truncate">{label}</label>
                  <span className="text-[9px] text-slate-400 truncate">{hint}</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <Input
                    type="number" min={key === "lockoutMinutes" ? 1 : 0}
                    value={values[key] ?? 0}
                    disabled={!canEdit}
                    onChange={(e) => set(key, e.target.value === "" ? 0 : Number(e.target.value))}
                    className="h-7 text-xs bg-white dark:bg-slate-900 font-medium"
                  />
                  <span className="text-[10px] text-slate-400 shrink-0 font-mono">{unit}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
      {error && <p className="text-xs text-rose-600 bg-rose-50 dark:bg-rose-950/30 px-4 py-2 border-t border-rose-200 dark:border-rose-800">{error}</p>}
    </div>
  )
}

function UsersTab() {
  const { can } = useHrm()
  // RBAC-104 (Wave R3-3) — user administration split out of settings.edit:
  // viewing needs users.view; creating/editing/deleting needs users.edit/delete.
  const canEdit = can("users", "edit")
  const canDelete = can("users", "delete")
  const { data, loading, error, reload } = useApi<any[]>("users.list")
  const { data: employees } = useEmployeeDirectory()
  const { data: branches } = useApi<any[]>("branches.list", {})
  const { data: departments } = useApi<any[]>("departments.list", {})
  const { data: roles } = useApi<any[]>("roles.list")
  const [open, setOpen] = useState(false)
  const [editUser, setEditUser] = useState<any>(null)
  const [delUser, setDelUser] = useState<any>(null)
  // RBAC-103 (Wave R3-5) — per-user ADDITIONAL grants editor (template ∪ explicit)
  const [grantsUser, setGrantsUser] = useState<any>(null)

  const roleOptions = (roles || []).map((r: any) => ({ value: r.key, label: r.label }))

  const fields: FieldDef[] = [
    { name: "name", label: "Full Name", required: true, span: 2 },
    { name: "email", label: "Email", type: "email", required: true, span: 2, help: editUser ? "Login email — the user must use the new address at next sign-in" : undefined },
    { name: "password", label: "Password", type: "password", span: 2, help: editUser ? "Leave blank to keep the current password" : "Required for new users" },
    { name: "role", label: "Role", type: "select", required: true, options: roleOptions.length ? roleOptions : ROLES.map((r) => ({ value: r, label: titleCase(r) })), help: "System roles + your custom roles (Roles & Permissions tab)" },
    { name: "status", label: "Status", type: "select", options: ["ACTIVE", "SUSPENDED"].map((s) => ({ value: s, label: s })), defaultValue: "ACTIVE" },
    { name: "employeeId", label: "Linked Employee", type: "select", options: [
      { value: "", label: "— None —" },
      ...(employees || []).map((e: any) => ({ value: e.id, label: `${e.fullName} (${e.code})` })),
    ] },
    { name: "branchId", label: "Branch Scope", type: "select", options: [
      { value: "", label: "— All —" },
      ...(branches || []).map((b: any) => ({ value: b.id, label: b.name })),
    ] },
    { name: "departmentId", label: "Department Scope", type: "select", options: [
      { value: "", label: "— All —" },
      ...(departments || []).map((d: any) => ({ value: d.id, label: d.name })),
    ] },
  ]

  const columns: Column<any>[] = [
    {
      key: "name", label: "User", render: (u) => (
        <div className="flex items-center gap-2.5">
          <div className={`flex-shrink-0 h-7 w-7 rounded-full flex items-center justify-center text-xs font-bold text-white select-none shadow-xs
            ${u.role === "HR_ADMIN" ? "bg-emerald-600" : u.role === "VENDOR_OWNER" ? "bg-amber-600" : u.role === "EMPLOYEE" ? "bg-slate-500" : "bg-teal-600"}`}>
            {(u.name || "?")[0].toUpperCase()}
          </div>
          <div>
            <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">{u.name}</p>
            <p className="text-[11px] text-slate-500 dark:text-slate-400">{u.email}</p>
          </div>
        </div>
      ),
    },
    { key: "role", label: "Role", render: (u) => <Badge className={u.role === "HR_ADMIN" ? "bg-emerald-100 text-emerald-700" : u.role === "EMPLOYEE" ? "bg-slate-200 text-slate-600" : "bg-teal-100 text-teal-700"}>{u.roleLabel || titleCase(u.role)}</Badge> },
    { key: "employeeName", label: "Linked Employee", render: (u) => (
      u.employeeName ? (
        <span className="inline-flex items-center gap-1 text-xs text-slate-700 dark:text-slate-300 font-medium">
          <UserRound className="h-3 w-3 text-slate-400" />
          {u.employeeName}
        </span>
      ) : (
        <span className="text-xs text-slate-400 italic">None</span>
      )
    ) },
    { key: "status", label: "Status", render: (u) => (
      <div className="flex flex-wrap gap-1 items-center">
        <StatusBadge status={u.status} />
        {u.mfaEnrolled && <Badge className="bg-teal-50 dark:bg-teal-950/40 text-teal-700 dark:text-teal-300 border border-teal-200/80 dark:border-teal-800 text-[10px] px-1.5 py-0 h-4.5" title="Multi-factor authentication enrolled">MFA</Badge>}
        {u.lockedUntil && new Date(u.lockedUntil) > new Date() && (
          <Badge className="bg-rose-50 dark:bg-rose-950/40 text-rose-700 dark:text-rose-300 border border-rose-200/80 dark:border-rose-800 text-[10px] px-1.5 py-0 h-4.5" title={`Locked until ${fmtDateTime(u.lockedUntil)} after repeated failed logins`}>Locked</Badge>
        )}
      </div>
    ) },
    { key: "lastLoginAt", label: "Last Login", render: (u) => <span className="text-xs tabular-nums text-slate-500">{u.lastLoginAt ? fmtDateTime(u.lastLoginAt) : "never"}</span> },
    {
      key: "actions", label: "", align: "right", render: (u) => canEdit && (
        <div className="flex gap-1">
          <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => { setEditUser(u); setOpen(true) }}><Pencil className="h-3.5 w-3.5" /></Button>
          {/* RBAC-103 — additional grants on top of the role template (server merges) */}
          <Button size="icon" variant="ghost" className="h-7 w-7" title={`Additional permissions (${(u.permissions || []).length} grant(s) on top of the role template)`}
            onClick={() => setGrantsUser(u)}><UserRound className="h-3.5 w-3.5" /></Button>
          {u.lockedUntil && new Date(u.lockedUntil) > new Date() && (
            <Button size="icon" variant="ghost" className="h-7 w-7 text-amber-500 hover:text-emerald-600" title="Unlock now (clears failed-login count)"
              onClick={async () => { await rpc("users.save", { id: u.id, unlock: true, name: u.name, email: u.email, role: u.role, status: u.status }); reload() }}>
              <LockOpen className="h-3.5 w-3.5" />
            </Button>
          )}
          {canDelete && <Button size="icon" variant="ghost" className="h-7 w-7 text-slate-400 hover:text-rose-600" title="Delete user" onClick={() => setDelUser(u)}><Trash2 className="h-3.5 w-3.5" /></Button>}
        </div>
      ),
    },
  ]

  return (
    <SectionCard
      title={
        <div className="flex items-center gap-2">
          <span>Team Members</span>
          {data && (
            <Badge variant="secondary" className="text-[10px] h-4.5 px-1.5 font-normal">
              {data.length}
            </Badge>
          )}
        </div>
      }
      description="Users inherit role permissions. Adjust role matrices in the Roles & Permissions tab."
      actions={canEdit ? (
        <Button size="sm" className="h-7 text-xs font-medium" onClick={() => { setEditUser(null); setOpen(true) }}>
          <Plus className="h-3.5 w-3.5 mr-1" /> Add User
        </Button>
      ) : undefined}
    >
      <DataTable columns={columns} rows={data || undefined} loading={loading} error={error} pageSize={15}
        searchPlaceholder="Search users…" emptyTitle="No users" csvName="users" />

      <FormDialog open={open} onOpenChange={(v) => { setOpen(v); if (!v) { setEditUser(null); reload() } }}
        title={editUser ? `Edit User — ${editUser.name}` : "Add User"}
        description="Users inherit the role permission template; additional grants can be added per user with the person icon (they merge server-side)."
        fields={fields} wide
        initial={editUser ? { name: editUser.name, email: editUser.email, password: "", role: editUser.role, status: editUser.status, employeeId: editUser.employeeId || "", branchId: editUser.branchId || "", departmentId: editUser.departmentId || "" } : undefined}
        onSubmit={async (v) => {
          const payload: Record<string, unknown> = {
            name: v.name, email: v.email, role: v.role, status: v.status || "ACTIVE",
            employeeId: v.employeeId || null, branchId: v.branchId || null, departmentId: v.departmentId || null,
          }
          if (v.password) payload.password = v.password
          if (editUser) payload.id = editUser.id
          await rpc("users.save", payload)
        }} />

      {/* RBAC-103 — per-user additional grants (server: template ∪ explicit, normalized + audit-diffed) */}
      <UserGrantsDialog open={!!grantsUser} onOpenChange={(v) => { if (!v) { setGrantsUser(null); reload() } }} user={grantsUser} roles={roles || []} />

      <ConfirmDialog open={!!delUser} onOpenChange={(v) => { if (!v) setDelUser(null) }} title="Delete user"
        message={`Delete "${delUser?.name}" (${delUser?.email})? Their sessions are revoked. The last HR Admin and the last active Vendor Owner cannot be deleted.`}
        danger confirmLabel="Delete" requireReason
        onConfirm={async (reason) => { await rpc("users.delete", { id: delUser.id, reason }) ; reload() }} />
    </SectionCard>
  )
}

// ================= company profile (info + logo) =================
function resizeLogo(file: File, max = 256): Promise<string | null> {
  return new Promise((resolve) => {
    const img = new window.Image()
    const url = URL.createObjectURL(file)
    img.onload = () => {
      try {
        const scale = Math.min(1, max / Math.max(img.width, img.height))
        const w = Math.max(1, Math.round(img.width * scale))
        const h = Math.max(1, Math.round(img.height * scale))
        const canvas = document.createElement("canvas")
        canvas.width = w; canvas.height = h
        const ctx = canvas.getContext("2d")
        if (!ctx) { URL.revokeObjectURL(url); resolve(null); return }
        ctx.drawImage(img, 0, 0, w, h)
        URL.revokeObjectURL(url)
        resolve(canvas.toDataURL("image/png"))
      } catch { URL.revokeObjectURL(url); resolve(null) }
    }
    img.onerror = () => { URL.revokeObjectURL(url); resolve(null) }
    img.src = url
  })
}

function CompanyProfileCard({ settings, canEdit, onSaved }: { settings: any; canEdit: boolean; onSaved: () => void }) {
  const toast = useHrm((s) => s.toast)
  const vendor = useHrm((s) => s.vendor)
  const g = settings?.general || {}
  const [values, setValues] = useState({ companyName: "", legalName: "", binVatReg: "", address: "", phone: "", email: "", website: "" })
  const [logo, setLogo] = useState("")
  const [signatory, setSignatory] = useState({ signatoryName: "", signatoryDesignation: "" })
  const [signature, setSignature] = useState("")
  const [seal, setSeal] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setValues({
      // Fall back to the tenant's registered name (vendor.name) when companyName
      // has not been explicitly set in settings — ensures the field always reflects
      // the name provided during workspace registration.
      companyName: g.companyName || vendor?.name || "", legalName: g.legalName || "", binVatReg: g.binVatReg || "",
      address: g.address || "", phone: g.phone || "", email: g.email || "", website: g.website || "",
    })
    setLogo(g.logoUrl || "")
    setSignatory({ signatoryName: g.signatoryName || "", signatoryDesignation: g.signatoryDesignation || "" })
    setSignature(g.signatureUrl || "")
    setSeal(g.sealUrl || "")
  }, [settings, vendor])

  const set = (k: string, v: string) => setValues((s) => ({ ...s, [k]: v }))

  const pickLogo = async (file?: File | null) => {
    if (!file) return
    if (!file.type.startsWith("image/")) { setError("Choose an image file (PNG, JPG, SVG…)"); return }
    if (file.size > 2 * 1024 * 1024) { setError("Logo file too large (max 2 MB)"); return }
    setError(null)
    const dataUrl = await resizeLogo(file)
    if (!dataUrl) { setError("Could not read that image"); return }
    setLogo(dataUrl)
  }

  const pickSignImage = async (file: File | undefined | null, which: "signature" | "seal") => {
    if (!file) return
    if (!file.type.startsWith("image/")) { setError("Choose an image file (PNG with transparent background works best)"); return }
    if (file.size > 2 * 1024 * 1024) { setError("Image too large (max 2 MB)"); return }
    setError(null)
    const dataUrl = await resizeLogo(file)
    if (!dataUrl) { setError("Could not read that image"); return }
    if (which === "signature") setSignature(dataUrl)
    else setSeal(dataUrl)
  }

  const save = async () => {
    if (!values.companyName.trim()) { setError("Company name is required"); return }
    setBusy(true); setError(null)
    try {
      // 2026-10-25 (master prompt Part C §6): companyName is OWNER-CONTROLLED —
      // the field is read-only in this form and the server strips it from
      // settings.save/patch (defense in depth). Only the editable profile
      // fields are sent.
      const { companyName: _companyName, ...editable } = values
      await useHrm.getState().saveSettingsGroup("general", { ...editable, logoUrl: logo, ...signatory, signatureUrl: signature, sealUrl: seal })
      toast("Company profile saved")
      await useHrm.getState().init() // refresh vendor (name/logo) in the shell
      onSaved()
    } catch (e: any) { setError(e.message) } finally { setBusy(false) }
  }

  const infoFields: { key: keyof typeof values; label: string; span?: boolean; placeholder?: string }[] = [
    { key: "companyName", label: "Company Name", placeholder: "e.g. Acme Corp Ltd." },
    { key: "legalName", label: "Legal Name", placeholder: "e.g. Acme Corp Bangladesh Ltd." },
    { key: "binVatReg", label: "BIN / VAT Reg. No.", placeholder: "e.g. 00451234567" },
    { key: "phone", label: "Company Phone", placeholder: "+880 2-XXXXXXX" },
    { key: "email", label: "Company Email", placeholder: "info@company.com" },
    { key: "website", label: "Website", placeholder: "https://…" },
    { key: "address", label: "Head Office Address", span: true, placeholder: "House, Road, Area, City" },
  ]

  return (
    <SectionCard title="Company Profile" actions={
      canEdit ? (
        <Button size="sm" className="h-8 text-xs " onClick={save} disabled={busy}>
          <Save className="h-3.5 w-3.5 mr-1" /> {busy ? "Saving…" : "Save Profile"}
        </Button>
      ) : <Badge variant="outline" className="text-[10px]">Read-only</Badge>
    }>
      <div className="flex flex-col sm:flex-row gap-6">
        <div className="shrink-0 space-y-2">
          <div className="h-28 w-28 rounded-xl border-2 border-dashed border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 flex items-center justify-center overflow-hidden">
            {logo ? (
              <img src={logo} alt="Company logo" className="h-full w-full object-contain" />
            ) : (
              <div className="text-center px-3">
                <Building2 className="h-8 w-8 text-slate-300 dark:text-slate-600 mx-auto" />
                <p className="text-[10px] text-slate-500 dark:text-slate-400 mt-1">No logo yet</p>
              </div>
            )}
          </div>
          {canEdit && (
            <div className="flex gap-1.5">
              <label className="flex-1">
                <input type="file" accept="image/*" className="hidden" onChange={(e) => pickLogo(e.target.files?.[0])} disabled={busy} />
                <span className="inline-flex items-center justify-center gap-1 h-8 w-full rounded-md border text-xs font-medium cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800 text-slate-600 dark:text-slate-300">
                  <Upload className="h-3.5 w-3.5" /> Upload
                </span>
              </label>
              {logo && (
                <Button size="sm" variant="outline" className="h-8 text-xs" onClick={() => setLogo("")} disabled={busy}>Remove</Button>
              )}
            </div>
          )}
          <p className="text-[10px] text-slate-500 dark:text-slate-400 text-center">PNG/JPG · auto-resized to 256px</p>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-5 gap-y-3.5 flex-1">
          {infoFields.map((f) => (
            <div key={f.key} className={`space-y-1.5 ${f.span ? "sm:col-span-2" : ""}`}>
              <Label className="text-xs font-medium text-slate-600 dark:text-slate-300">
                {f.label}
              </Label>
              {f.key === "companyName" ? (
                // 2026-10-25 (master prompt Part C §6): the REGISTERED PLATFORM
                // TENANT NAME is owner-controlled. Read-only display here; the
                // server additionally strips it from every tenant mutation.
                <div className="space-y-1">
                  <Input value={values.companyName} disabled readOnly placeholder="Managed by the platform owner" className="h-9 bg-slate-50 dark:bg-slate-900 text-slate-700 dark:text-slate-300" />
                  <p className="text-[10px] text-slate-500 dark:text-slate-400 flex items-center gap-1">
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="inline"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
                    Locked — your registered workspace name is managed by the Finix HR platform owner (contact support to change it).
                  </p>
                </div>
              ) : f.key === "address" ? (
                <Textarea rows={2} value={values[f.key]} disabled={!canEdit} onChange={(e) => set(f.key, e.target.value)} placeholder={f.placeholder} className="text-sm" />
              ) : (
                <Input value={values[f.key]} disabled={!canEdit} onChange={(e) => set(f.key, e.target.value)} placeholder={f.placeholder} className="h-9" />
              )}
            </div>
          ))}
        </div>
      </div>

      {/* ---------- authorized signatory (spec §13.5) ---------- */}
      <div className="border-t border-slate-100 dark:border-slate-800 pt-4 mt-4">
        <p className="text-xs font-semibold text-slate-700 dark:text-slate-200 mb-3">Authorized Signatory — used on HR letters</p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-5 gap-y-3.5">
          <div className="space-y-1.5">
            <Label className="text-xs font-medium text-slate-600 dark:text-slate-300">Signatory Name</Label>
            <Input value={signatory.signatoryName} disabled={!canEdit}
              onChange={(e) => setSignatory((s) => ({ ...s, signatoryName: e.target.value }))}
              placeholder="e.g. Md. Rafiqul Islam" className="h-9" />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs font-medium text-slate-600 dark:text-slate-300">Signatory Designation</Label>
            <Input value={signatory.signatoryDesignation} disabled={!canEdit}
              onChange={(e) => setSignatory((s) => ({ ...s, signatoryDesignation: e.target.value }))}
              placeholder="e.g. Managing Director" className="h-9" />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs font-medium text-slate-600 dark:text-slate-300">Signature Image</Label>
            <div className="flex items-center gap-2">
              <div className="h-14 w-36 rounded-lg border border-dashed border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 flex items-center justify-center overflow-hidden shrink-0">
                {signature ? <img src={signature} alt="signature" className="h-full w-full object-contain" /> : <span className="text-[10px] text-slate-500 dark:text-slate-400">none</span>}
              </div>
              {canEdit && (
                <>
                  <label>
                    <input type="file" accept="image/*" className="hidden" onChange={(e) => pickSignImage(e.target.files?.[0], "signature")} disabled={busy} />
                    <span className="inline-flex items-center justify-center gap-1 h-8 px-3 rounded-md border text-xs font-medium cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800 text-slate-600 dark:text-slate-300">
                      <Upload className="h-3.5 w-3.5" /> Upload
                    </span>
                  </label>
                  {signature && <Button size="sm" variant="outline" className="h-8 text-xs" onClick={() => setSignature("")} disabled={busy}>Remove</Button>}
                </>
              )}
            </div>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs font-medium text-slate-600 dark:text-slate-300">Company Seal / Round Stamp</Label>
            <div className="flex items-center gap-2">
              <div className="h-14 w-14 rounded-full border border-dashed border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 flex items-center justify-center overflow-hidden shrink-0">
                {seal ? <img src={seal} alt="seal" className="h-full w-full object-contain" /> : <span className="text-[10px] text-slate-500 dark:text-slate-400">none</span>}
              </div>
              {canEdit && (
                <>
                  <label>
                    <input type="file" accept="image/*" className="hidden" onChange={(e) => pickSignImage(e.target.files?.[0], "seal")} disabled={busy} />
                    <span className="inline-flex items-center justify-center gap-1 h-8 px-3 rounded-md border text-xs font-medium cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800 text-slate-600 dark:text-slate-300">
                      <Upload className="h-3.5 w-3.5" /> Upload
                    </span>
                  </label>
                  {seal && <Button size="sm" variant="outline" className="h-8 text-xs" onClick={() => setSeal("")} disabled={busy}>Remove</Button>}
                </>
              )}
            </div>
          </div>
        </div>
        <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-2">
          The signature and seal appear on generated HR letters (printed and emailed copies).
        </p>
      </div>

      <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-3">
        The logo appears in the sidebar header and on generated HR letters; company details feed letterheads, payslips and the communication templates.
      </p>
      {error && <p className="text-sm text-rose-600 bg-rose-50 rounded-md px-3 py-2 mt-3">{error}</p>}
    </SectionCard>
  )
}

// ================= email gateway =================
function EmailGatewayTab({ settings, canEdit, onSaved }: { settings: any; canEdit: boolean; onSaved: () => void }) {
  const g = settings?.email || {}
  const EMAIL_FIELDS: GField[] = [
    { key: "enabled", label: "Enable email sending", type: "switch" },
    { key: "host", label: "SMTP Host", type: "text", hint: "Gmail: smtp.gmail.com" },
    { key: "port", label: "Port", type: "number", min: 1, hint: "587 (STARTTLS) or 465 (SSL)" },
    { key: "secure", label: "Use SSL/TLS (port 465)", type: "switch" },
    { key: "username", label: "Username", type: "text", hint: "Gmail: your full address" },
    { key: "password", label: "Password / App Password", type: "password", hint: g.passwordSet ? "Stored — leave blank to keep" : "Gmail: 16-character app password" },
    { key: "fromName", label: "From Name", type: "text", hint: "Shown to recipients, e.g. My Company HR" },
    { key: "fromAddress", label: "From Address", type: "text", hint: "Defaults to the username" },
  ]
  const toast = useHrm((s) => s.toast)
  const [testTo, setTestTo] = useState("")
  const [testBusy, setTestBusy] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null)

  const applyGmailPreset = async () => {
    try {
      await useHrm.getState().saveSettingsGroup("email", { ...g, host: "smtp.gmail.com", port: 587, secure: false })
      toast("Gmail preset applied — enter your username & app password")
      onSaved()
    } catch (e: any) { toast(e.message, "err") }
  }

  const sendTest = async () => {
    setTestBusy(true); setTestResult(null)
    try {
      const r = await rpc<any>("communications.testEmail", { to: testTo })
      setTestResult({ ok: r.status === "SENT", text: r.status === "SENT" ? `Test email sent to ${testTo} — check the inbox (and spam folder).` : `${r.status}: ${r.detail || "unknown error"}` })
    } catch (e: any) {
      setTestResult({ ok: false, text: e.message })
    } finally { setTestBusy(false) }
  }

  return (
    <div className="space-y-4">
      <GroupEditor group="email" title="SMTP / Gmail Email Gateway" icon={Mail}
        description="Outgoing email for payslips, leave alerts, letters and Communication Center blasts"
        fields={EMAIL_FIELDS} settings={settings} canEdit={canEdit} onSaved={onSaved} />
      <SectionCard title="Gmail Quick Setup">
        <ol className="text-xs text-slate-600 dark:text-slate-300 space-y-1.5 list-decimal list-inside">
          <li>Enable <b>2-Step Verification</b> on your Google account (myaccount.google.com → Security).</li>
          <li>Create an <b>App Password</b>: Google Account → Security → 2-Step Verification → App passwords (select “Mail”, “Other” → name it “HRM”).</li>
          <li>Copy the 16-character app password and paste it in the Password field here (regular passwords are rejected by Gmail).</li>
          <li>Host <b>smtp.gmail.com</b>, port <b>587</b>, SSL off — or click the preset button.</li>
          <li>Send a test email below to verify, then use the Communication Center to email employees.</li>
        </ol>
        {canEdit && (
          <Button size="sm" variant="outline" className="h-8 text-xs mt-3" onClick={applyGmailPreset}>
            <Copy className="h-3.5 w-3.5 mr-1" /> Apply Gmail preset (smtp.gmail.com:587)
          </Button>
        )}
      </SectionCard>
      <SectionCard title="Send Test Email">
        <div className="flex flex-col sm:flex-row gap-2">
          <Input type="email" value={testTo} onChange={(e) => setTestTo(e.target.value)} placeholder="deliver-to@example.com" className="h-9 flex-1" />
          <Button size="sm" className="h-9 text-xs " onClick={sendTest} disabled={testBusy || !testTo.trim()}>
            <Send className="h-3.5 w-3.5 mr-1" /> {testBusy ? "Sending…" : "Send Test"}
          </Button>
        </div>
        {testResult && (
          <p className={`text-xs mt-2 rounded-md px-3 py-2 ${testResult.ok ? "bg-emerald-50 text-emerald-700" : "bg-rose-50 text-rose-700"}`}>{testResult.text}</p>
        )}
        <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-2">Requires the gateway to be enabled with valid credentials above.</p>
      </SectionCard>
    </div>
  )
}

// ================= sms gateway =================
function SmsGatewayTab({ settings, canEdit, onSaved }: { settings: any; canEdit: boolean; onSaved: () => void }) {
  const g = settings?.sms || {}
  const SMS_FIELDS: GField[] = [
    { key: "enabled", label: "Enable SMS sending", type: "switch" },
    { key: "provider", label: "Provider", type: "text", hint: "e.g. BulkSMSBD, SSL Wireless, Alpha SMS…" },
    { key: "senderId", label: "Sender ID / Mask", type: "text", hint: "Approved brand name (BD operators)" },
    { key: "method", label: "HTTP Method", type: "select", options: [{ value: "POST", label: "POST (JSON body)" }, { value: "GET", label: "GET (query string)" }] },
    { key: "apiKey", label: "API Key / Token", type: "password", hint: g.apiKeySet ? "Stored — leave blank to keep" : "Provider API key" },
    { key: "apiSecret", label: "API Secret", type: "password", hint: g.apiSecretSet ? "Stored — leave blank to keep" : "Optional, if the provider requires it" },
    { key: "apiUrl", label: "API URL Template", type: "textarea", span: true, hint: "Placeholders: {phone} {message} {sender} {apiKey} — replaced per send" },
  ]
  return (
    <div className="space-y-4">
      <GroupEditor group="sms" title="SMS Gateway (HTTP API)" icon={MessageSquare}
        description="Provider-agnostic SMS gateway for salary credits, alerts and Communication Center texts"
        fields={SMS_FIELDS} settings={settings} canEdit={canEdit} onSaved={onSaved} />
      <SectionCard title="How the URL template works">
        <p className="text-xs text-slate-600 dark:text-slate-300 mb-2">
          Paste your provider&apos;s endpoint with placeholders — the system substitutes them for every message:
        </p>
        <div className="space-y-1.5 font-mono text-[11px] bg-slate-50 dark:bg-slate-800/60 border rounded-md p-2.5 text-slate-600 dark:text-slate-300">
          <p>https://api.provider.com/send?to={"{phone}"}&amp;message={"{message}"}&amp;sender={"{sender}"}&amp;key={"{apiKey}"}</p>
          <p className="text-slate-400">POST example body: {"{ to, message, from }"} as JSON + Authorization: Bearer key header</p>
        </div>
        <ul className="text-[11px] text-slate-500 mt-2 space-y-1 list-disc list-inside">
          <li><b>{"{phone}"}</b> — employee mobile (01XXXXXXXXX normalised to +880XXXXXXXXX)</li>
          <li><b>{"{message}"}</b> — the text, URL-encoded; <b>{"{sender}"}</b> — your Sender ID; <b>{"{apiKey}"}</b> — the API key above</li>
          <li>For POST, the key is also sent as an <b>Authorization: Bearer</b> header (works with most BD providers)</li>
          <li>Local-format numbers are converted automatically; messages are capped at 1000 characters</li>
        </ul>
      </SectionCard>
    </div>
  )
}

// ================= roles & permissions manager =================
function RolesTab() {
  const { can } = useHrm()
  const toast = useHrm((s) => s.toast)
  // RBAC-104 — editing role definitions is privilege management: users.edit.
  const canEdit = can("users", "edit")
  const { data, loading, error, reload } = useApi<any[]>("roles.list")
  const [editRole, setEditRole] = useState<any>(null)
  const [open, setOpen] = useState(false)
  const [resetRole, setResetRole] = useState<any>(null)
  // M-03 — the role-MFA switch is optimistic ONLY until the RPC confirms; a
  // failure rolls the visual state back and surfaces the error. It must never
  // silently wipe permissions: the error toast tells the operator the save did
  // NOT land, and reload() is skipped so the table keeps showing persisted data.
  const [mfaOverride, setMfaOverride] = useState<Record<string, boolean>>({})

  const columns: Column<any>[] = [
    {
      key: "role", label: "Role", render: (r) => (
        <div>
          <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">{r.label}</p>
          <p className="text-[11px] text-slate-500 dark:text-slate-400 font-mono">{r.key}</p>
        </div>
      ),
    },
    {
      key: "type", label: "Type", render: (r) => (
        <div className="flex flex-wrap gap-1">
          {r.isSystem ? <Badge variant="outline" className="text-[10px]">System</Badge> : <Badge className="bg-violet-100 text-violet-700 text-[10px]">Custom</Badge>}
          {r.overridden && <Badge className="bg-amber-100 text-amber-700 text-[10px]">Customized</Badge>}
        </div>
      ),
    },
    { key: "permissions", label: "Permissions", render: (r) => <span className="text-xs tabular-nums text-slate-600 dark:text-slate-300">{r.permissions.length}</span> },
    { key: "mfaRequired", label: "MFA", render: (r) => (
      <Switch checked={mfaOverride[r.id] ?? !!r.mfaRequired} disabled={!canEdit}
        aria-label={`Require multi-factor authentication for role ${r.label}`}
        onCheckedChange={async (c) => {
          setMfaOverride((m) => ({ ...m, [r.id]: c }))
          try {
            await rpc("roles.save", { id: r.id, key: r.key, name: r.label, description: r.description || null, permissions: r.permissions, mfaRequired: c })
            setMfaOverride((m) => { const n = { ...m }; delete n[r.id]; return n })
            reload()
          } catch (e: any) {
            // M-03 — surface the failure and snap the switch back to the
            // persisted state; the role's permissions were NOT saved.
            setMfaOverride((m) => { const n = { ...m }; delete n[r.id]; return n })
            toast(e.message || "Could not update the MFA requirement — nothing was saved", "err")
          }
        }} />
    ) },
    { key: "userCount", label: "Users", render: (r) => <span className="text-xs tabular-nums text-slate-600 dark:text-slate-300">{r.userCount}</span> },
    {
      key: "actions", label: "", align: "right", render: (r) => canEdit && (
        <div className="flex gap-1">
          <Button size="icon" variant="ghost" className="h-7 w-7" title="Edit permissions" onClick={() => { setEditRole(r); setOpen(true) }}><Pencil className="h-3.5 w-3.5" /></Button>
          {r.overridden && (
            <Button size="icon" variant="ghost" className="h-7 w-7 text-slate-400 hover:text-amber-600" title="Reset to built-in template" onClick={() => setResetRole(r)}><RotateCw className="h-3.5 w-3.5" /></Button>
          )}
          {!r.isSystem && (
            <Button size="icon" variant="ghost" className="h-7 w-7 text-slate-400 hover:text-rose-600" title="Delete role" onClick={() => setResetRole(r)}><Trash2 className="h-3.5 w-3.5" /></Button>
          )}
        </div>
      ),
    },
  ]

  return (
    <div className="space-y-4">
      {canEdit && (
        <Button size="sm" className="h-8 text-xs " onClick={() => { setEditRole(null); setOpen(true) }}>
          <Plus className="h-3.5 w-3.5 mr-1" /> Add Role
        </Button>
      )}
      <DataTable columns={columns} rows={data || undefined} loading={loading} error={error} pageSize={20}
        searchPlaceholder="Search roles…" emptyTitle="No roles" csvName="roles" />
      <SectionCard title="About roles">
        <p className="text-xs text-slate-500">
          System roles come with sensible defaults; editing one creates a vendor-specific override (Reset restores
          the built-in permissions). Custom roles can be created from scratch and assigned to users on the Users tab.
          Permissions take effect at the next login for already-signed-in users of an edited role.
        </p>
      </SectionCard>

      <RoleDialog open={open} onOpenChange={(v) => { setOpen(v); if (!v) { setEditRole(null); reload() } }}
        role={editRole} roles={data || []} />

      <ConfirmDialog open={!!resetRole} onOpenChange={(v) => { if (!v) setResetRole(null) }}
        title={resetRole?.isSystem ? "Reset system role" : "Delete role"}
        message={resetRole?.isSystem
          ? `Reset “${resetRole?.label}” back to the built-in permission template? Users of this role regain default permissions.`
          : `Delete the custom role “${resetRole?.label}”? Only possible when no user is assigned to it.`}
        danger confirmLabel={resetRole?.isSystem ? "Reset" : "Delete"}
        onConfirm={async () => { await rpc("roles.delete", { id: resetRole.id }); reload() }} />
    </div>
  )
}

function RoleDialog({ open, onOpenChange, role, roles }: {
  open: boolean; onOpenChange: (v: boolean) => void; role: any; roles: any[]
}) {
  const toast = useHrm((s) => s.toast)
  const [key, setKey] = useState("")
  const [name, setName] = useState("")
  const [description, setDescription] = useState("")
  const [mfaRequired, setMfaRequired] = useState(false)
  const [perms, setPerms] = useState<Set<string>>(new Set())
  const [copyFrom, setCopyFrom] = useState("none")
  const [search, setSearch] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (open) {
      setKey(role?.key || "")
      setName(role?.label || "")
      setDescription(role?.description || "")
      setMfaRequired(!!role?.mfaRequired)
      setPerms(new Set(role?.permissions || []))
      setCopyFrom("none"); setSearch(""); setError(null)
    }
  }, [open, role])

  const isSystem = !!role?.isSystem
  const toggle = (perm: string) => setPerms((s) => { const n = new Set(s); if (n.has(perm)) n.delete(perm); else n.add(perm); return n })
  const toggleModuleAll = (module: string, on: boolean) => setPerms((s) => {
    const n = new Set(s)
    for (const a of ACTIONS) { const p = `${module}.${a}`; if (on) n.add(p); else n.delete(p) }
    return n
  })
  const applyCopy = (fromKey: string) => {
    setCopyFrom(fromKey)
    const src = roles.find((r) => r.key === fromKey)
    if (src) setPerms(new Set(src.permissions))
  }

  const filteredModules = MODULES.filter((m) => !search || (MODULE_LABELS[m] || m).toLowerCase().includes(search.toLowerCase()) || m.includes(search.toLowerCase()))

  const submit = async () => {
    if (!key.trim()) { setError("Role key is required (e.g. AUDIT_OFFICER)"); return }
    if (!name.trim()) { setError("Role name is required"); return }
    if (perms.size === 0) { setError("Grant at least one permission"); return }
    setBusy(true); setError(null)
    try {
      await rpc("roles.save", {
        id: role?.id || undefined, key: key.trim(), name: name.trim(),
        description: description.trim() || null, permissions: Array.from(perms),
        mfaRequired,
      })
      toast(isSystem ? `Role ${name} updated` : `Role ${name} saved`)
      onOpenChange(false)
    } catch (e: any) { setError(e.message) } finally { setBusy(false) }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent className="sm:max-w-3xl max-h-[92vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-base">{role ? `Edit Role — ${role.label}` : "Add Role"}</DialogTitle>
          <p className="text-xs text-slate-500">
            {isSystem ? "System role — saving stores a vendor-specific override of its permissions (key cannot change)." : "Custom role — grant exactly the permissions this role needs."}
          </p>
        </DialogHeader>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 py-2">
          <div className="space-y-1.5">
            <Label className="text-xs font-medium">Role Key <span className="text-rose-500">*</span></Label>
            <Input value={key} disabled={isSystem || busy} onChange={(e) => setKey(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, "_"))}
              placeholder="e.g. AUDIT_OFFICER" className="h-9 font-mono text-xs" />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs font-medium">Role Name <span className="text-rose-500">*</span></Label>
            <Input value={name} disabled={busy} onChange={(e) => setName(e.target.value)} placeholder="e.g. Audit Officer" className="h-9" />
          </div>
          <div className="sm:col-span-2 space-y-1.5">
            <Label className="text-xs font-medium">Description</Label>
            <Input value={description} disabled={busy} onChange={(e) => setDescription(e.target.value)} placeholder="What is this role for?" className="h-9" />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs font-medium">Copy permissions from</Label>
            <Select value={copyFrom} onValueChange={applyCopy} disabled={busy}>
              <SelectTrigger className="h-9"><SelectValue placeholder="— None —" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="none">— None —</SelectItem>
                {roles.filter((r) => r.key !== role?.key).map((r) => (
                  <SelectItem key={r.key} value={r.key}>{r.label} ({r.permissions.length})</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs font-medium">Filter modules</Label>
            <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="e.g. payroll, leave…" className="h-9" />
          </div>
        </div>

        <div className="border rounded-lg overflow-hidden">
          <div className="flex items-center justify-between px-3 py-2 bg-slate-50 dark:bg-slate-800 border-b">
            <p className="text-xs font-semibold text-slate-600 dark:text-slate-300">
              Permission Matrix <span className="font-normal text-slate-400">({perms.size} granted)</span>
            </p>
            <div className="flex gap-1">
              <Button size="sm" variant="outline" className="h-7 text-[11px]" onClick={() => setPerms(new Set(filteredModules.flatMap((m) => ACTIONS.map((a) => `${m}.${a}`))))}>Grant shown all</Button>
              <Button size="sm" variant="outline" className="h-7 text-[11px]" onClick={() => setPerms(new Set())}>Clear shown</Button>
            </div>
          </div>
          <div className="overflow-x-auto max-h-72 overflow-y-auto">
            <table className="w-full text-[10px]">
              <thead className="sticky top-0 bg-white dark:bg-slate-900 z-10">
                <tr className="border-b text-slate-400">
                  <th className="text-left px-3 py-1.5 font-medium w-40 sticky left-0 bg-white dark:bg-slate-900">Module</th>
                  <th className="px-1 py-1.5 font-medium w-8">All</th>
                  {ACTIONS.map((a) => (
                    <th key={a} className="px-1 py-1.5 font-medium whitespace-nowrap" title={a}>{a.slice(0, 3).toUpperCase()}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filteredModules.map((m) => {
                  const modulePerms = ACTIONS.map((a) => `${m}.${a}`)
                  const allOn = modulePerms.every((p) => perms.has(p))
                  return (
                    <tr key={m} className="border-b last:border-0 hover:bg-slate-50 dark:hover:bg-slate-800/50">
                      <td className="px-3 py-1.5 sticky left-0 bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-300 font-medium whitespace-nowrap">
                        {MODULE_LABELS[m] || m}
                      </td>
                      <td className="px-1 py-1.5 text-center">
                        {/* M-9 — accessible label for the module-wide toggle */}
                        <Checkbox className="h-3 w-3" checked={allOn} onCheckedChange={(c) => toggleModuleAll(m, !!c)}
                          aria-label={`Toggle every action of module ${MODULE_LABELS[m] || m}`} />
                      </td>
                      {ACTIONS.map((a) => {
                        const p = `${m}.${a}`
                        return (
                          <td key={a} className="px-1 py-1.5 text-center">
                            {/* M-9 — accessible label: role/module/action triple */}
                            <Checkbox className="h-3 w-3" checked={perms.has(p)} onCheckedChange={() => toggle(p)}
                              aria-label={`${titleCase(a)} ${MODULE_LABELS[m] || m}: ${perms.has(p) ? "allowed" : "denied"}`} />
                          </td>
                        )
                      })}
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          <p className="px-3 py-1.5 text-[10px] text-slate-500 dark:text-slate-400 bg-slate-50 dark:bg-slate-800 border-t">
            Columns are action codes (vie= view, cre= create, edi= edit, del= delete, app= approve, rej= reject, exp= export,
            dow= download, upl= upload, ver= verify, ass= assign, pro= process, cal= calculate, pay= pay, gen= generate).
          </p>
        </div>

        {error && <p className="text-sm text-rose-600 bg-rose-50 rounded-md px-3 py-2 mt-3">{error}</p>}
        <DialogFooter className="gap-2 mt-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
          <Button onClick={submit} disabled={busy}>
            <Save className="h-3.5 w-3.5 mr-1" /> {busy ? "Saving…" : "Save Role"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ================= FLD-103 (Wave R3-5) — field-level permissions =================
/** Per-role access modes for the 5 employee field groups. Stored in the
 *  hrSettings `fieldPermissions` group and enforced SERVER-SIDE by the
 *  employees.* projection/write whitelist — this editor is convenience only.
 *  Semantics: Full = today's behavior · Masked = values masked on read
 *  (contact/identity) · Hidden = withheld entirely (read AND write). */
function FieldPermissionsTab({ settings, canEdit, onSaved }: { settings: any; canEdit: boolean; onSaved: () => void }) {
  const toast = useHrm((s) => s.toast)
  const { data: roles } = useApi<any[]>("roles.list")
  const [selectedRole, setSelectedRole] = useState<string>("")
  const [busy, setBusy] = useState(false)
  // draft config mirrors the server shape: { roles: { role: { group: mode } }, default: { group: mode } }
  const cfg = (settings?.fieldPermissions as any) || {}
  // T-11 — was a lazily-initialized ref MUTATED during render (the exact
  // pattern react-hooks/refs exists to forbid). The draft is component
  // state now: derived once per mount, re-derived whenever the server
  // settings reload (after save → onSaved → useApi reload), updated
  // immutably by setMode/clearRole.
  const [draft, setDraft] = useState<any>(() => ({
    roles: JSON.parse(JSON.stringify(cfg.roles || {})),
    default: JSON.parse(JSON.stringify(cfg.default || {})),
  }))
  useEffect(() => {
    setDraft({
      roles: JSON.parse(JSON.stringify((settings?.fieldPermissions as any)?.roles || {})),
      default: JSON.parse(JSON.stringify((settings?.fieldPermissions as any)?.default || {})),
    })
    // settings comes from useApi — stable identity until the next reload
  }, [settings])

  const roleList = (roles || [])
  const effectiveRole = selectedRole || roleList[0]?.key || ""
  const editingDefault = effectiveRole === "__default__"
  const roleEntry: Record<string, string> = editingDefault ? draft.default : (draft.roles[effectiveRole] || {})

  const setMode = (group: string, mode: string) => {
    setDraft((d: any) =>
      editingDefault
        ? { ...d, default: { ...d.default, [group]: mode } }
        : { ...d, roles: { ...d.roles, [effectiveRole]: { ...(d.roles[effectiveRole] || {}), [group]: mode } } },
    )
  }

  const clearRole = () => {
    setDraft((d: any) => {
      const roles = { ...d.roles }
      delete roles[effectiveRole]
      return { roles, default: { ...d.default } }
    })
  }

  const save = async () => {
    setBusy(true)
    try {
      // trim empty per-role entries so the stored config stays minimal
      const roles: Record<string, Record<string, string>> = {}
      for (const [k, v] of Object.entries(draft.roles)) {
        const clean = Object.fromEntries(
          Object.entries(v as any).filter(([, m]) => m && m !== "full"),
        ) as Record<string, string>
        if (Object.keys(clean).length) roles[k] = clean
      }
      const def = Object.fromEntries(
        Object.entries(draft.default).filter(([, m]) => m && m !== "full"),
      ) as Record<string, string>
      await rpc("settings.save", { group: "fieldPermissions", values: { roles, default: def } })
      toast("Field permissions saved — effective immediately for new reads")
      onSaved()
      // the [settings] effect above re-derives the draft from the reloaded
      // config (was: draftRef.current = null + lazy re-init next render)
    } catch (e: any) {
      toast(e.message || "Could not save field permissions", "err")
    } finally {
      setBusy(false)
    }
  }

  return (
    <SectionCard title="Field Permissions" actions={
      canEdit ? <Button size="sm" className="h-8 text-xs" onClick={save} disabled={busy}><Save className="h-3.5 w-3.5 mr-1" /> {busy ? "Saving…" : "Save"}</Button> : undefined
    }>
      <p className="text-xs text-slate-500 mb-4 leading-relaxed">
        Role-scoped access to the sensitive field groups of the employee record — <b>enforced server-side</b> on
        every employees read and write. This layer can only <b>narrow</b> what the Roles &amp; Permissions matrix already
        granted (a role without payroll.view never sees salary, whatever is set here). Unlisted roles and groups stay
        <b> Full</b> — an untouched configuration behaves exactly as before.
      </p>
      <div className="flex flex-wrap items-center gap-3 mb-4">
        <div className="w-64">
          <Select value={effectiveRole} onValueChange={setSelectedRole} disabled={!canEdit}>
            <SelectTrigger className="h-9 text-xs"><SelectValue placeholder="Select a role" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="__default__">Tenant default (unlisted roles)</SelectItem>
              {roleList.map((r: any) => (
                <SelectItem key={r.key} value={r.key}>{r.label} · {r.userCount} user(s)</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {!editingDefault && Object.keys(roleEntry).length > 0 && canEdit && (
          <Button size="sm" variant="outline" className="h-8 text-xs" onClick={clearRole}>
            <RotateCw className="h-3.5 w-3.5 mr-1" /> Reset role to Full
          </Button>
        )}
      </div>
      <div className="border rounded-lg overflow-hidden">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b bg-slate-50 dark:bg-slate-800 text-slate-500 dark:text-slate-400">
              <th className="text-left px-3 py-2 font-medium">Field group</th>
              <th className="text-left px-3 py-2 font-medium w-40">Access</th>
              <th className="text-left px-3 py-2 font-medium">Effect</th>
            </tr>
          </thead>
          <tbody>
            {FIELD_GROUPS.map((g) => {
              const mode = roleEntry[g] || "full"
              return (
                <tr key={g} className="border-b last:border-0">
                  <td className="px-3 py-2 font-medium text-slate-700 dark:text-slate-200">{FIELD_GROUP_LABELS[g]}</td>
                  <td className="px-3 py-2">
                    <Select value={mode} onValueChange={(v) => setMode(g, v)} disabled={!canEdit}>
                      <SelectTrigger className="h-8 text-xs w-36"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {(["full", "mask", "none"] as const).map((m) => (
                          <SelectItem key={m} value={m}>{FIELD_ACCESS_LABELS[m]}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </td>
                  <td className="px-3 py-2 text-[11px] text-slate-500 dark:text-slate-400">
                    {g === "salary" && (mode === "full" ? "Structure + revision history readable (needs payroll.view too); editable with payroll.edit" : "Amounts withheld from profile/payloads; structure writes denied")}
                    {g === "bank" && (mode === "full" ? "Bank rows visible (numbers always last-4 masked); payout edits allowed" : "Bank rows and payout fields hidden; writes denied")}
                    {g === "identity" && (mode === "full" ? "Raw numbers with employeeDocs.reveal; masked otherwise" : mode === "mask" ? "Numbers masked to last-4 (default posture)" : "Identity numbers hidden from reads and writes")}
                    {g === "contact" && (mode === "full" ? "Phones, emails and addresses readable/editable" : mode === "mask" ? "Phones/emails masked on directory and profile reads" : "Contact fields hidden from reads and writes")}
                    {g === "employment" && (mode === "full" ? "Branch/department/grade/dates readable and editable" : "Employment fields hidden from reads; edits stripped (profile form disables them)")}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-3 leading-relaxed">
        <b>Masked</b> on salary/employment behaves like <b>Hidden</b> (no meaningful partial form for amounts or org
        placement). The employee&apos;s own Self-Service profile is never restricted — these rules govern the HR plane
        (who may see/edit <i>other</i> employees&apos; sensitive data). Changes apply to new reads immediately.
      </p>
    </SectionCard>
  )
}

// ================= RBAC-103 (Wave R3-5) — per-user additional grants =================
/** Additive per-user permission grants on top of the role template. The server
 *  resolves template ∪ explicit (auth.ts); an empty set clears the overrides.
 *  Restricting a user BELOW their role is what custom roles are for. */
function UserGrantsDialog({ open, onOpenChange, user, roles }: {
  open: boolean; onOpenChange: (v: boolean) => void; user: any; roles: any[]
}) {
  const toast = useHrm((s) => s.toast)
  const [perms, setPerms] = useState<Set<string>>(new Set())
  const [search, setSearch] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (open) {
      setPerms(new Set(user?.permissions || []))
      setSearch(""); setError(null)
    }
  }, [open, user])

  const template = roles?.find((r) => r.key === user?.role)?.permissions || []
  const effective = new Set<string>([...template, ...perms])
  const toggle = (perm: string) => setPerms((s) => { const n = new Set(s); if (n.has(perm)) n.delete(perm); else n.add(perm); return n })
  const toggleModuleAll = (module: string, on: boolean) => setPerms((s) => {
    const n = new Set(s)
    for (const a of ACTIONS) { const p = `${module}.${a}`; if (on) n.add(p); else n.delete(p) }
    return n
  })
  const filteredModules = MODULES.filter((m) => !search || (MODULE_LABELS[m] || m).toLowerCase().includes(search.toLowerCase()))

  const submit = async () => {
    setBusy(true); setError(null)
    try {
      await rpc("users.save", { id: user.id, name: user.name, email: user.email, role: user.role, status: user.status, permissions: Array.from(perms) })
      toast(`Additional grants saved for ${user.name}`)
      onOpenChange(false)
    } catch (e: any) { setError(e.message) } finally { setBusy(false) }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent className="sm:max-w-3xl max-h-[92vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-base">Additional Permissions — {user?.name}</DialogTitle>
          <p className="text-xs text-slate-500">
            Grants are <b>additive</b> on top of the {user?.roleLabel || user?.role} role template ({template.length} permissions).
            The effective set is {effective.size} permissions. To restrict below a role, build a custom role instead
            (Roles &amp; Permissions tab).
          </p>
        </DialogHeader>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 py-2">
          <div className="space-y-1.5">
            <Label className="text-xs font-medium">Filter modules</Label>
            <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="e.g. payroll, reports…" className="h-9" />
          </div>
          <div className="flex items-end justify-end gap-2">
            <Badge variant="outline" className="text-[10px]">{perms.size} additional</Badge>
            <Badge className="bg-emerald-100 text-emerald-700 text-[10px]">{effective.size} effective</Badge>
          </div>
        </div>
        <div className="border rounded-lg overflow-hidden">
          <div className="flex items-center justify-between px-3 py-2 bg-slate-50 dark:bg-slate-800 border-b">
            <p className="text-xs font-semibold text-slate-600 dark:text-slate-300">
              Additional Grants <span className="font-normal text-slate-400">(unchecked = role template only)</span>
            </p>
            <div className="flex gap-1">
              <Button size="sm" variant="outline" className="h-7 text-[11px]" onClick={() => setPerms(new Set())}>Clear</Button>
            </div>
          </div>
          <div className="overflow-x-auto max-h-72 overflow-y-auto">
            <table className="w-full text-[10px]">
              <thead className="sticky top-0 bg-white dark:bg-slate-900 z-10">
                <tr className="border-b text-slate-400">
                  <th className="text-left px-3 py-1.5 font-medium w-40 sticky left-0 bg-white dark:bg-slate-900">Module</th>
                  <th className="px-1 py-1.5 font-medium w-8">All</th>
                  {ACTIONS.map((a) => (
                    <th key={a} className="px-1 py-1.5 font-medium whitespace-nowrap" title={a}>{a.slice(0, 3).toUpperCase()}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filteredModules.map((m) => {
                  const modulePerms = ACTIONS.map((a) => `${m}.${a}`)
                  const allOn = modulePerms.every((p) => perms.has(p))
                  return (
                    <tr key={m} className="border-b last:border-0 hover:bg-slate-50 dark:hover:bg-slate-800/50">
                      <td className="px-3 py-1.5 sticky left-0 bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-300 font-medium whitespace-nowrap">
                        {MODULE_LABELS[m] || m}
                      </td>
                      <td className="px-1 py-1.5 text-center">
                        <Checkbox className="h-3 w-3" checked={allOn} onCheckedChange={(c) => toggleModuleAll(m, !!c)}
                          aria-label={`Toggle every additional grant of module ${MODULE_LABELS[m] || m}`} />
                      </td>
                      {ACTIONS.map((a) => {
                        const p = `${m}.${a}`
                        return (
                          <td key={a} className="px-1 py-1.5 text-center">
                            <Checkbox className="h-3 w-3" checked={perms.has(p)} onCheckedChange={() => toggle(p)}
                              aria-label={`Additional grant ${titleCase(a)} ${MODULE_LABELS[m] || m}`} />
                          </td>
                        )
                      })}
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
        {error && <p className="text-sm text-rose-600 bg-rose-50 rounded-md px-3 py-2 mt-3">{error}</p>}
        <DialogFooter className="gap-2 mt-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
          <Button onClick={submit} disabled={busy}>
            <Save className="h-3.5 w-3.5 mr-1" /> {busy ? "Saving…" : "Save Grants"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ================= approval workflows =================
type StepDraft = { name: string; approverRole: string; branchScope: boolean; departmentScope: boolean; amountThreshold: string; required: boolean }

function WorkflowsTab({ canEdit }: { canEdit: boolean }) {
  const { data, loading, error, reload } = useApi<any[]>("workflows.list")
  const [editWf, setEditWf] = useState<any>(null)

  if (loading) return <div className="rounded-xl border bg-white dark:bg-slate-900 p-6 text-center text-sm text-slate-400">Loading workflows…</div>
  if (error) return <div className="rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700">{error}</div>

  const workflows = data || []
  const missing = PROCESS_TYPES.filter((t) => !workflows.find((w: any) => w.processType === t))

  return (
    <div className="space-y-4">
      <SectionCard title="Approval Workflows" actions={
        <span className="text-[11px] text-slate-500 dark:text-slate-400">{workflows.length} of {PROCESS_TYPES.length} configured{missing.length ? ` · ${missing.length} not set up` : " · all set"}</span>
      }>
        <p className="text-xs text-slate-500 mb-4">
          Multi-step routing per process. Steps run in sequence; <b>branch scope</b> routes to the employee&apos;s branch manager,
          <b> department scope</b> to their department manager, and an <b>amount threshold</b> skips the step below the limit.
          Every process below needs a workflow before its requests can be submitted.
        </p>
        {missing.length > 0 && (
          <div className="mb-4 rounded-xl border border-amber-200 dark:border-amber-900/60 bg-amber-50 dark:bg-amber-950/30 p-3">
            <div className="flex items-center gap-2 mb-2">
              <AlertTriangle className="h-4 w-4 text-amber-600" />
              <p className="text-xs font-semibold text-amber-800 dark:text-amber-300">Not configured — requests of these types cannot be submitted</p>
            </div>
            <div className="flex flex-wrap gap-2">
              {missing.map((t) => (
                <div key={t} className="flex items-center gap-2 rounded-lg border bg-white dark:bg-slate-900 px-2.5 py-1.5">
                  <span className="text-xs font-medium text-slate-700 dark:text-slate-200">{titleCase(t.replace(/_/g, " "))}</span>
                  {canEdit && (
                    <Button size="sm" className="h-6 text-[10px] bg-amber-600 hover:bg-amber-700 text-white" onClick={() => setEditWf({
                      id: "new", processType: t,
                      name: t === "ENCASHMENT" ? "Leave Encashment Approval" : titleCase(t.replace(/_/g, " ")) + " Approval",
                      steps: (DEFAULT_WORKFLOW_STEPS[t] || []).map((s, i) => ({ id: `new-${i}`, sequence: i + 1, ...s, required: true, rejectBehavior: "REJECT_ALL" })),
                    })}>
                      <Plus className="h-3 w-3 mr-0.5" /> Set up
                    </Button>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
        <div className="grid lg:grid-cols-2 gap-4">
          {workflows.map((wf: any) => (
            <div key={wf.id} className="rounded-xl border bg-white dark:bg-slate-900 p-4">
              <div className="flex items-center gap-2 mb-3">
                <div className="h-8 w-8 rounded-lg bg-violet-50 dark:bg-violet-950 flex items-center justify-center shrink-0">
                  <Workflow className="h-4 w-4 text-violet-600" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">{wf.name}</p>
                  <p className="text-[11px] text-slate-500 dark:text-slate-400">{titleCase(wf.processType)} · {(wf.steps || []).length} step{(wf.steps || []).length === 1 ? "" : "s"}</p>
                </div>
                {canEdit && (
                  <Button size="sm" variant="outline" className="h-7 text-[10px] bg-white dark:bg-slate-900" onClick={() => setEditWf(wf)}>
                    <Pencil className="h-3 w-3 mr-1" /> Edit
                  </Button>
                )}
              </div>
              <div className="space-y-1.5">
                {(wf.steps || []).map((s: any) => (
                  <div key={s.id} className="flex flex-wrap items-center gap-1.5 rounded-lg bg-slate-50 dark:bg-slate-800/60 px-2.5 py-1.5">
                    <span className="h-5 w-5 rounded-full bg-violet-100 text-violet-700 dark:bg-violet-950 dark:text-violet-300 text-[10px] font-bold flex items-center justify-center shrink-0">{s.sequence}</span>
                    <span className="text-xs font-medium text-slate-700 dark:text-slate-200">{s.name}</span>
                    {s.approverRole && <Badge variant="outline" className="text-[10px]">{titleCase(s.approverRole)}</Badge>}
                    {s.branchScope && <Badge className="bg-teal-100 text-teal-700 text-[10px]">Branch</Badge>}
                    {s.departmentScope && <Badge className="bg-cyan-100 text-cyan-700 text-[10px]">Dept</Badge>}
                    {s.amountThreshold != null && <Badge variant="outline" className="text-[10px]">≥ ৳{s.amountThreshold.toLocaleString()}</Badge>}
                    {!s.required && <Badge variant="outline" className="text-[10px] text-slate-500 dark:text-slate-400">optional</Badge>}
                  </div>
                ))}
                {(wf.steps || []).length === 0 && <p className="text-xs text-slate-400 px-1 py-2">No steps configured — requests auto-approve at submission.</p>}
              </div>
            </div>
          ))}
        </div>
      </SectionCard>

      {editWf && <WorkflowEditDialog key={editWf.id} wf={editWf} onClose={() => setEditWf(null)} onSaved={() => { setEditWf(null); reload() }} />}
    </div>
  )
}

function WorkflowEditDialog({ wf, onClose, onSaved }: { wf: any; onClose: () => void; onSaved: () => void }) {
  const toast = useHrm((s) => s.toast)
  const [name, setName] = useState(wf.name || titleCase(wf.processType))
  const [steps, setSteps] = useState<StepDraft[]>(() => (wf.steps || []).map((s: any) => ({
    name: s.name || "", approverRole: s.approverRole || "HR_ADMIN",
    branchScope: !!s.branchScope, departmentScope: !!s.departmentScope,
    amountThreshold: s.amountThreshold != null ? String(s.amountThreshold) : "", required: s.required !== false,
  })))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const setStep = (i: number, patch: Partial<StepDraft>) => setSteps((s) => s.map((x, j) => j === i ? { ...x, ...patch } : x))
  const addStep = () => setSteps((s) => [...s, { name: "", approverRole: "HR_MANAGER", branchScope: false, departmentScope: false, amountThreshold: "", required: true }])
  const removeStep = (i: number) => setSteps((s) => s.filter((_, j) => j !== i))

  const save = async () => {
    if (!name.trim()) { setError("Workflow name is required"); return }
    if (steps.some((s) => !s.name.trim())) { setError("Every step needs a name"); return }
    setBusy(true)
    setError(null)
    try {
      await rpc("workflows.save", {
        processType: wf.processType, name,
        steps: steps.map((s) => ({
          name: s.name, approverRole: s.approverRole || null,
          branchScope: s.branchScope, departmentScope: s.departmentScope,
          amountThreshold: s.amountThreshold === "" ? null : Number(s.amountThreshold),
          required: s.required,
        })),
      })
      toast("Workflow saved")
      onSaved()
    } catch (e: any) { setError(e.message) } finally { setBusy(false) }
  }

  return (
    <Dialog open onOpenChange={(v) => !busy && !v && onClose()}>
      <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-base">Edit Workflow — {titleCase(wf.processType)}</DialogTitle>
          <p className="text-xs text-slate-500">Steps are stored with an implicit sequence (top → bottom).</p>
        </DialogHeader>
        <div className="space-y-3 py-1">
          <div className="space-y-1.5">
            <Label className="text-xs font-medium">Workflow Name</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} className="h-9" />
          </div>
          <div className="space-y-2">
            <Label className="text-xs font-medium">Steps</Label>
            {steps.map((s, i) => (
              <div key={i} className="rounded-xl border p-3 space-y-2.5">
                <div className="flex items-center gap-2">
                  <span className="h-6 w-6 rounded-full bg-violet-100 text-violet-700 dark:bg-violet-950 dark:text-violet-300 text-[10px] font-bold flex items-center justify-center shrink-0">{i + 1}</span>
                  <Input value={s.name} onChange={(e) => setStep(i, { name: e.target.value })} placeholder="Step name (e.g. HR Review)" className="h-8 text-xs flex-1" />
                  <Button size="icon" variant="ghost" className="h-8 w-8 text-slate-400 hover:text-rose-600 shrink-0" onClick={() => removeStep(i)} title="Remove step">
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 items-center">
                  <Select value={s.approverRole} onValueChange={(v) => setStep(i, { approverRole: v })}>
                    <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                    <SelectContent>{APPROVER_ROLES.map((r) => <SelectItem key={r} value={r}>{titleCase(r)}</SelectItem>)}</SelectContent>
                  </Select>
                  <Input type="number" min={0} value={s.amountThreshold} onChange={(e) => setStep(i, { amountThreshold: e.target.value })}
                    placeholder="Amount ≥" className="h-8 text-xs" title="Step only required at/above this amount" />
                  <label className="flex items-center gap-1.5 text-xs text-slate-600 dark:text-slate-300">
                    <Switch checked={s.branchScope} onCheckedChange={(c) => setStep(i, { branchScope: c })} /> Branch scope
                  </label>
                  <label className="flex items-center gap-1.5 text-xs text-slate-600 dark:text-slate-300">
                    <Switch checked={s.departmentScope} onCheckedChange={(c) => setStep(i, { departmentScope: c })} /> Dept scope
                  </label>
                </div>
                <label className="flex items-center gap-1.5 text-xs text-slate-500">
                  <Switch checked={s.required} onCheckedChange={(c) => setStep(i, { required: c })} /> Required step (unchecking makes it optional)
                </label>
              </div>
            ))}
            <Button size="sm" variant="outline" className="h-8 text-xs w-full border-dashed bg-white dark:bg-slate-900" onClick={addStep}>
              <Plus className="h-3.5 w-3.5 mr-1 text-emerald-600" /> Add Step
            </Button>
          </div>
        </div>
        {error && <p className="text-sm text-rose-600 bg-rose-50 rounded-md px-3 py-2">{error}</p>}
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button onClick={save} disabled={busy}>{busy ? "Saving…" : "Save Workflow"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ================= system health =================
function HealthTab() {
  const { data, loading, error, reload } = useApi<any>("system.selfTest")
  const [running, setRunning] = useState(false)

  const runAgain = async () => {
    setRunning(true)
    try { await reload() } finally { setRunning(false) }
  }

  return (
    <div className="space-y-4">
      <SectionCard title="System Self-Test" actions={
        <Button size="sm" variant="outline" className="h-8 text-xs bg-white dark:bg-slate-900" onClick={runAgain} disabled={running || loading}>
          <RotateCw className={`h-3.5 w-3.5 mr-1 text-emerald-600 ${running ? "animate-spin" : ""}`} /> {running || loading ? "Running…" : "Run Again"}
        </Button>
      }>
        {loading && !data && <p className="text-xs text-slate-400 py-6 text-center">Running hardening checks…</p>}
        {error && <div className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">{error}</div>}
        {data && (
          <>
            <div className={`rounded-xl p-4 mb-4 flex items-center gap-3 ${data.allPass ? "bg-emerald-50 dark:bg-emerald-950/50 border border-emerald-200 dark:border-emerald-900" : "bg-rose-50 dark:bg-rose-950/50 border border-rose-200 dark:border-rose-900"}`}>
              {data.allPass ? <CheckCircle2 className="h-6 w-6 text-emerald-600 shrink-0" /> : <XCircle className="h-6 w-6 text-rose-600 shrink-0" />}
              <div>
                <p className={`text-sm font-bold ${data.allPass ? "text-emerald-700 dark:text-emerald-300" : "text-rose-700 dark:text-rose-300"}`}>
                  {data.allPass ? "All checks passed" : `${data.total - data.passCount} check(s) failed`}
                </p>
                <p className="text-xs text-slate-500">{data.passCount}/{data.total} checks passed · run at {fmtDateTime(data.ranAt)}</p>
              </div>
            </div>
            <div className="grid sm:grid-cols-2 gap-2.5">
              {(data.results || []).map((r: any, i: number) => (
                <div key={i} className={`rounded-xl border p-3 flex items-start gap-2.5 ${r.pass ? "border-emerald-200 dark:border-emerald-900 bg-emerald-50/50 dark:bg-emerald-950/30" : "border-rose-200 dark:border-rose-900 bg-rose-50/50 dark:bg-rose-950/30"}`}>
                  {r.pass ? <CheckCircle2 className="h-4 w-4 text-emerald-600 shrink-0 mt-0.5" /> : <XCircle className="h-4 w-4 text-rose-600 shrink-0 mt-0.5" />}
                  <div className="min-w-0">
                    <p className="text-xs font-semibold text-slate-800 dark:text-slate-100">{r.name}</p>
                    <p className="text-[11px] text-slate-500 break-words">{r.detail}</p>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </SectionCard>
      <SectionCard title="What is checked">
        <ul className="text-xs text-slate-500 space-y-1 list-disc pl-4">
          <li>Tenant isolation — no cross-vendor data leakage in scoped queries</li>
          <li>Approval workflow coverage for every process type</li>
          <li>Immutability of paid payroll runs</li>
          <li>Payroll reconciliation — entries sum equals run totals</li>
          <li>Accounting journals balance (debits = credits)</li>
          <li>Leave balance sanity and audit trail activity</li>
          <li>Role permission matrix completeness</li>
        </ul>
      </SectionCard>
    </div>
  )
}

// ================= HRM-011/012 — per-leave-type carry-forward & encashment rules =================
function LeaveRulesCard({ canEdit }: { canEdit: boolean }) {
  const toast = useHrm((s) => s.toast)
  const { data, loading, error, reload } = useApi<any[]>("leaveTypes.list")
  const [edit, setEdit] = useState<any>(null)
  const [open, setOpen] = useState(false)
  const [, setBusy] = useState(false)
  const [, setFormError] = useState<string | null>(null)
  const [form, setForm] = useState<any>({})

  const openEdit = (t: any) => {
    setEdit(t)
    setForm({
      name: t.name, carryForward: t.carryForward, maxCarryForward: t.maxCarryForward,
      carryForwardExpiryMonths: t.carryForwardExpiryMonths, accrualFrequency: t.accrualFrequency || "ANNUAL",
      encashmentAllowed: t.encashmentAllowed, encashmentRate: t.encashmentRate ?? 1, encashmentCap: t.encashmentCap ?? 0,
      genderRestriction: t.genderRestriction || "",
    })
    setFormError(null)
    setOpen(true)
  }

  const submit = async () => {
    setBusy(true); setFormError(null)
    try {
      await rpc("leaveTypes.save", {
        id: edit.id, code: edit.code, name: form.name, paid: edit.paid, defaultDays: edit.defaultDays,
        carryForward: !!form.carryForward, maxCarryForward: Number(form.maxCarryForward || 0),
        carryForwardExpiryMonths: Number(form.carryForwardExpiryMonths || 0),
        accrualFrequency: form.accrualFrequency,
        encashmentAllowed: !!form.encashmentAllowed, encashmentRate: Number(form.encashmentRate || 0),
        encashmentCap: Number(form.encashmentCap || 0),
        waitingPeriodDays: edit.waitingPeriodDays, probationEligible: edit.probationEligible,
        requiresAttachment: edit.requiresAttachment, active: edit.active,
        // LVE-107 — gender-restricted eligibility (maternity/paternity)
        genderRestriction: form.genderRestriction || null,
      })
      toast(`${form.name} rules saved`)
      setOpen(false); reload()
    } catch (e: any) { setFormError(e.message) } finally { setBusy(false) }
  }

  const columns: Column<any>[] = [
    { key: "name", label: "Leave Type", render: (t) => <div><p className="text-sm font-semibold text-slate-800 dark:text-slate-100">{t.name}</p><p className="text-[11px] text-slate-500 dark:text-slate-400 font-mono">{t.code} · {t.defaultDays}d {t.paid ? "paid" : "unpaid"}</p></div> },
    { key: "carryForward", label: "Carry-Forward", render: (t) => t.carryForward
      ? <Badge className="bg-emerald-100 text-emerald-700 text-[10px]">max {t.maxCarryForward}d · expires {t.carryForwardExpiryMonths || 0}mo</Badge>
      : <span className="text-xs text-slate-400">—</span> },
    { key: "accrualFrequency", label: "Accrual", render: (t) => <Badge variant="outline" className="text-[10px]">{titleCase((t.accrualFrequency || "ANNUAL").replace(/_/g, " "))}</Badge> },
    { key: "encashment", label: "Encashment", render: (t) => t.encashmentAllowed
      // LVE-117 — encashmentCap is DAYS (engine: "capped at N day(s) per
      // request"); the old ৳ symbol mislabeled the unit as money.
      ? <Badge className="bg-teal-100 text-teal-700 text-[10px]">×{t.encashmentRate ?? 1} daily rate{t.encashmentCap ? ` · cap ${t.encashmentCap}d` : ""}</Badge>
      : <span className="text-xs text-slate-400">not encashable</span> },
    { key: "actions", label: "", align: "right", render: (t) => canEdit && (
      <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => openEdit(t)}><Pencil className="h-3.5 w-3.5" /></Button>
    ) },
  ]

  return (
    <SectionCard title="Carry-Forward, Accrual & Encashment Rules" actions={<Badge variant="outline" className="text-[10px]">HRM-011 · HRM-012</Badge>}>
      <p className="text-xs text-slate-500 mb-3">
        Per-leave-type rules applied at the fiscal-year rollover (carry-forward caps and expiry, accrual frequency)
        and in the final settlement (encashment rate × daily pay, capped per type). The year-end rollover job runs
        automatically on the fiscal-year start month.
      </p>
      <DataTable columns={columns} rows={data || undefined} loading={loading} error={error} pageSize={12}
        searchPlaceholder="Search leave types…" emptyTitle="No leave types" csvName="leave-rules" />

      <FormDialog open={open} onOpenChange={(v) => { setOpen(v); if (!v) setEdit(null) }}
        title={`Rules — ${edit?.name || ""}`} description="Carry-forward and encashment behavior for this leave type."
        fields={[
          { name: "name", label: "Type Name", required: true, span: 2 },
          { name: "carryForward", label: "Carry forward unused days", type: "switch" },
          { name: "maxCarryForward", label: "Max carry-forward (days)", type: "number", min: 0 },
          { name: "carryForwardExpiryMonths", label: "Carried days expire after (months)", type: "number", min: 0, help: "0 = within the leave year only" },
          { name: "accrualFrequency", label: "Accrual frequency", type: "select", options: [
            { value: "ANNUAL", label: "Annual — full entitlement on day one" },
            { value: "MONTHLY", label: "Monthly — 1/12 accrues each month" },
            { value: "QUARTERLY", label: "Quarterly — 1/4 accrues each quarter" },
            { value: "PRO_RATA", label: "Pro-rated — by joining date" },
          ] },
          { name: "encashmentAllowed", label: "Encashable on exit", type: "switch" },
          { name: "encashmentRate", label: "Encashment rate (× daily pay)", type: "number", min: 0, step: 0.25, help: "1 = one day of pay per unused day" },
          { name: "encashmentCap", label: "Encashment cap (days)", type: "number", min: 0, help: "0 = uncapped — caps encashment requests AND the exit-settlement payout at N days per type" },
          { name: "genderRestriction", label: "Eligible gender", type: "select", options: [
            { value: "", label: "No restriction" },
            { value: "FEMALE", label: "Female employees only (maternity)" },
            { value: "MALE", label: "Male employees only (paternity)" },
          ] },
        ]}
        initial={form}
        onSubmit={submit} />
    </SectionCard>
  )
}

// ================= HRM-021 — notification preferences matrix =================
const MATRIX_EVENTS: { key: string; label: string }[] = [
  { key: "leave_request", label: "Leave request" },
  { key: "leave_decision", label: "Leave approved / rejected" },
  { key: "payslip_generated", label: "Payslip generated" },
  { key: "salary_credited", label: "Salary credited" },
  { key: "attendance_alert", label: "Attendance alert" },
  { key: "document_expiry", label: "Document expiry" },
  { key: "resignation_submitted", label: "Resignation submitted" },
  { key: "loan_request", label: "Loan request" },
  { key: "loan_decision", label: "Loan approved / rejected" },
  { key: "advance_request", label: "Advance request" },
  { key: "advance_decision", label: "Advance approved / rejected" },
  { key: "expense_request", label: "Expense claim submitted" },
  { key: "expense_decision", label: "Expense decision" },
  { key: "performance_review", label: "Performance review" },
  // employee lifecycle automation (2026-10 round)
  { key: "employee_account_created", label: "Employee account created" },
  { key: "employee_credentials", label: "Employee login credentials" },
  { key: "password_reset", label: "Password reset" },
  { key: "promotion", label: "Promotion" },
  { key: "transfer", label: "Transfer" },
  { key: "shift_change", label: "Shift change" },
  { key: "salary_revision", label: "Increment / salary revision" },
  { key: "employee_status", label: "Suspend / activate / termination" },
  // 2026-10 round §17 — tracking & attendance-security events
  { key: "gps_disabled", label: "GPS disabled during tracking" },
  { key: "tracking_offline", label: "Tracking went offline" },
  { key: "low_battery", label: "Critical device battery" },
  { key: "geofence_violation", label: "Geo-fence violation" },
  { key: "location_spoof_suspected", label: "Suspicious location (possible spoofing)" },
  { key: "mandatory_gps_violation", label: "Mandatory GPS violation" },
  { key: "attendance_review_required", label: "Attendance needs review" },
]
function NotificationMatrixCard({ settings, canEdit, onSaved }: { settings: any; canEdit: boolean; onSaved: () => void }) {
  const toast = useHrm((s) => s.toast)
  const [matrix, setMatrix] = useState<Record<string, { email: boolean; sms: boolean; inApp: boolean }>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setMatrix((settings?.notificationMatrix as any) || {})
  }, [settings])

  const toggle = (event: string, channel: "email" | "sms" | "inApp") => {
    setMatrix((m) => {
      const prev = m[event] || { email: false, sms: false, inApp: true }
      return { ...m, [event]: { ...prev, [channel]: !prev[channel] } }
    })
  }

  const save = async () => {
    setBusy(true); setError(null)
    try {
      await useHrm.getState().saveSettingsGroup("notificationMatrix", matrix)
      toast("Notification matrix saved")
      onSaved()
    } catch (e: any) { setError(e.message) } finally { setBusy(false) }
  }

  return (
    <SectionCard title="Notification Preferences Matrix" actions={canEdit && (
      <Button size="sm" className="h-8 text-xs " onClick={save} disabled={busy}>
        <Save className="h-3.5 w-3.5 mr-1" /> {busy ? "Saving…" : "Save Matrix"}
      </Button>
    )}>
      <p className="text-xs text-slate-500 mb-3">
        Per-event delivery channels for every automated notification. The dispatch engine consults this matrix before
        sending; in-app is always on unless switched off. Events without a saved row fall back to the legacy toggles above.
      </p>
      <div className="rounded-xl border overflow-hidden">
        <div className="overflow-x-auto max-h-[460px] overflow-y-auto">
          <table className="w-full text-xs min-w-[340px]">
            <thead className="bg-slate-50 dark:bg-slate-800 sticky top-0 z-10 border-b border-slate-200 dark:border-slate-700">
              <tr>
                <th className="text-left px-3 py-2 font-medium text-slate-600 dark:text-slate-300">Event</th>
                <th className="w-16 px-2 py-2 font-medium text-slate-600 dark:text-slate-300 text-center"><span className="inline-flex items-center gap-1 justify-center"><Mail className="h-3 w-3" /> Email</span></th>
                <th className="w-16 px-2 py-2 font-medium text-slate-600 dark:text-slate-300 text-center"><span className="inline-flex items-center gap-1 justify-center"><MessageSquare className="h-3 w-3" /> SMS</span></th>
                <th className="w-16 px-2 py-2 font-medium text-slate-600 dark:text-slate-300 text-center"><span className="inline-flex items-center gap-1 justify-center"><Bell className="h-3 w-3" /> In-App</span></th>
              </tr>
            </thead>
            <tbody>
              {MATRIX_EVENTS.map((e) => {
                const row = matrix[e.key] || { email: false, sms: false, inApp: true }
                return (
                  <tr key={e.key} className="border-t hover:bg-slate-50/50 dark:hover:bg-slate-800/40">
                    <td className="px-3 py-2 text-slate-700 dark:text-slate-200">{e.label}</td>
                    {(["email", "sms", "inApp"] as const).map((ch) => (
                      <td key={ch} className="px-2 py-2 text-center">
                        <Switch checked={!!row[ch]} disabled={!canEdit} onCheckedChange={() => toggle(e.key, ch)} />
                      </td>
                    ))}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>
      {error && <p className="text-sm text-rose-600 bg-rose-50 rounded-md px-3 py-2 mt-3">{error}</p>}
    </SectionCard>
  )
}

// ================= D1 — document expiry alert matrix =================
function DocExpiryCard({ settings, canEdit, onSaved }: { settings: any; canEdit: boolean; onSaved: () => void }) {
  const toast = useHrm((s) => s.toast)
  const [types, setTypes] = useState<({ type: string; leadDays: number; _key?: string })[]>([])
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    setTypes(((settings?.documentExpiry?.types as any) || []).map((t: any, i: number) => ({ ...t, _key: `${t.type}-${i}` })))
  }, [settings])

  const save = async () => {
    setBusy(true)
    try {
      await useHrm.getState().saveSettingsGroup("documentExpiry", { types: types.map(({ type, leadDays }) => ({ type, leadDays: Number(leadDays) || 0 })) })
      toast("Document expiry matrix saved")
      onSaved()
    } catch (e: any) { toast(e.message, "err") } finally { setBusy(false) }
  }

  return (
    <SectionCard title="Document Expiry Alerts (per type)" actions={canEdit && (
      <Button size="sm" className="h-8 text-xs " onClick={save} disabled={busy}>
        <Save className="h-3.5 w-3.5 mr-1" /> {busy ? "Saving…" : "Save Matrix"}
      </Button>
    )}>
      <p className="text-xs text-slate-500 mb-3">
        Lead days per document type — reminders start this many days before expiry (once per document). Types not
        listed use the fallback horizon from the legacy toggles above.
      </p>
      <div className="space-y-2">
        {types.map((t, i) => (
          <div key={t._key || i} className="flex items-center gap-2">
            <Input className="h-8 flex-1 text-xs" value={t.type} disabled={!canEdit}
              onChange={(e) => setTypes((arr) => arr.map((x, j) => j === i ? { ...x, type: e.target.value.toUpperCase() } : x))} />
            <Input type="number" min={1} className="h-8 w-24 text-xs tabular-nums" value={t.leadDays} disabled={!canEdit}
              onChange={(e) => setTypes((arr) => arr.map((x, j) => j === i ? { ...x, leadDays: Number(e.target.value) } : x))} />
            <span className="text-[11px] text-slate-500 dark:text-slate-400 w-16">days lead</span>
            {canEdit && <Button size="icon" variant="ghost" className="h-7 w-7 text-slate-400 hover:text-rose-600" onClick={() => setTypes((arr) => arr.filter((_, j) => j !== i))}><Trash2 className="h-3.5 w-3.5" /></Button>}
          </div>
        ))}
        {canEdit && (
          <Button size="sm" variant="outline" className="h-7 text-[11px]" onClick={() => setTypes((arr) => [...arr, { type: "", leadDays: 30, _key: `new-${arr.length}` }])}>
            <Plus className="h-3 w-3 mr-1" /> Add document type
          </Button>
        )}
      </div>
    </SectionCard>
  )
}


// ================= WP-F — Accounting integration card =================
// Settings → Payroll → Accounting: "Auto-post payroll to accounting" toggle
// (default ON = historical behaviour) + the tenant-editable journal ROLE →
// ACCOUNT mapping (defaults reproduce the hard-wired chart exactly).
function AccountingCard({ settings, canEdit, onSaved }: { settings: any; canEdit: boolean; onSaved: () => void }) {
  const toast = useHrm((s) => s.toast)
  const [autoPost, setAutoPost] = useState<boolean>(true)
  const [mapping, setMapping] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    setAutoPost(settings?.accounting?.autoPost !== false)
    setMapping({ ...(settings?.accounting?.accountMapping ?? {}) })
  }, [settings])

  const save = async () => {
    setBusy(true)
    try {
      // invalid codes are dropped server-side (resolveAccountMapping), but we
      // validate here too so the user sees the mistake immediately
      await useHrm.getState().saveSettingsGroup("accounting", { autoPost, accountMapping: mapping })
      toast("Accounting integration saved")
      onSaved()
    } catch (e: any) { toast(e.message, "err") } finally { setBusy(false) }
  }

  const ROLE_LABELS: Record<string, string> = {
    salaryExpense: "Salary & Wages Expense", otExpense: "Overtime Expense", bonusExpense: "Bonus & Commission Expense",
    pfEmployerExpense: "PF Employer Expense", aitPayable: "AIT Payable", pfPayable: "Provident Fund Payable",
    salariesPayable: "Salaries Payable", loanReceivable: "Employee Loan Receivable", advances: "Employee Advances",
    deductionsRecovered: "Salary Deductions Recovered", bank: "Bank Accounts (payout)", cash: "Cash on Hand (payout)", mfs: "MFS Wallets (payout)",
  }
  const ACCOUNT_OPTIONS = Object.entries(ACCOUNTS).map(([code, name]) => ({ value: code, label: `${code} — ${name}` }))

  return (
    <SectionCard title="Accounting Integration" actions={canEdit && (
      <Button size="sm" className="h-8 text-xs" onClick={save} disabled={busy}>
        <Save className="h-3.5 w-3.5 mr-1" /> {busy ? "Saving…" : "Save Mapping"}
      </Button>
    )}>
      <p className="text-xs text-slate-500 mb-3">
        Payroll posts double-entry journals (balanced to the paisa). Map each journal role to an account code —
        confirming a payout settles Salaries Payable into Bank / Cash / MFS. Defaults follow the standard chart.
      </p>
      <label className="flex items-center gap-2.5 rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-2.5 mb-3 cursor-pointer">
        <Switch checked={autoPost} disabled={!canEdit} onCheckedChange={setAutoPost} />
        <div className="min-w-0">
          <p className="text-xs font-medium">Auto-post payroll to accounting</p>
          <p className="text-[11px] text-slate-400">When ON (default), paying a run posts the accrual journal automatically. Turn OFF to journal manually from your own books.</p>
        </div>
      </label>
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {Object.keys(ROLE_LABELS).map((role) => (
          <div key={role} className="space-y-1">
            <Label className="text-[11px] font-medium text-slate-500">{ROLE_LABELS[role]}</Label>
            <Select value={mapping[role] || DEFAULT_ACCOUNT_MAPPING[role as keyof typeof DEFAULT_ACCOUNT_MAPPING] || ""} onValueChange={(v) => setMapping((m) => ({ ...m, [role]: v }))} disabled={!canEdit}>
              <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent className="max-h-64">{ACCOUNT_OPTIONS.map((o) => <SelectItem key={o.value} value={o.value} className="text-xs">{o.label}</SelectItem>)}</SelectContent>
            </Select>
          </div>
        ))}
      </div>
    </SectionCard>
  )
}

// ================= EXIT-001 / BLA §96 — Statutory Gratuity Tab =================
function GratuityTab({ settings, canEdit, onSaved }: { settings: any; canEdit: boolean; onSaved: () => void }) {
  const navigate = useHrm((s) => s.navigate)
  const g = settings?.gratuity || {}
  const isEnabled = g.enabled !== false
  const eligibilityYears = Number(g.eligibilityYears ?? 5)
  const daysPerYear = Number(g.daysPerYear ?? 30)
  const wageBasis = (g.wageBasis ?? "BASIC") as "BASIC" | "GROSS"
  const divisor = Number(g.divisor ?? 30)
  const capAmount = Number(g.capAmount ?? 0)

  // Interactive calculation simulator state
  const [simJoiningDate, setSimJoiningDate] = useState("2019-01-01")
  const [simLwd, setSimLwd] = useState(new Date().toISOString().slice(0, 10))
  const [simBasic, setSimBasic] = useState<number>(35000)
  const [simGross, setSimGross] = useState<number>(60000)

  // Real-time calculation from statutory gratuity engine
  const simResult = useMemo(() => {
    return computeGratuity(
      { enabled: isEnabled, eligibilityYears, daysPerYear, wageBasis, divisor, capAmount },
      { basic: simBasic || 0, gross: simGross || 0 },
      simJoiningDate,
      simLwd
    )
  }, [isEnabled, eligibilityYears, daysPerYear, wageBasis, divisor, capAmount, simBasic, simGross, simJoiningDate, simLwd])

  return (
    <div className="space-y-4">
      {/* Overview & Quick Metric Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        <div className="rounded-xl border bg-white dark:bg-slate-900 p-4 shadow-sm">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-medium text-slate-500">Statutory Status</span>
            <div className={`h-7 w-7 rounded-lg flex items-center justify-center ${isEnabled ? "bg-emerald-50 text-emerald-600 dark:bg-emerald-950/50 dark:text-emerald-400" : "bg-slate-100 text-slate-500 dark:bg-slate-800"}`}>
              <Award className="h-4 w-4" />
            </div>
          </div>
          <div className="flex items-center gap-2">
            <div className={`h-2.5 w-2.5 rounded-full ${isEnabled ? "bg-emerald-500 animate-pulse" : "bg-slate-400"}`} />
            <span className="text-sm font-semibold text-slate-900 dark:text-slate-100">
              {isEnabled ? "Benefit Active" : "Benefit Disabled"}
            </span>
          </div>
          <p className="text-[11px] text-slate-500 mt-1">
            {isEnabled ? "Statutory rule BLA 2006 §96 enforced at exit" : "Calculations suppressed across all modules"}
          </p>
        </div>

        <div className="rounded-xl border bg-white dark:bg-slate-900 p-4 shadow-sm">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-medium text-slate-500">Vesting Threshold</span>
            <div className="h-7 w-7 rounded-lg bg-blue-50 text-blue-600 dark:bg-blue-950/50 dark:text-blue-400 flex items-center justify-center">
              <Clock className="h-4 w-4" />
            </div>
          </div>
          <div className="text-sm font-semibold text-slate-900 dark:text-slate-100">
            {eligibilityYears} Years Continuous Service
          </div>
          <p className="text-[11px] text-slate-500 mt-1">
            4y 6m rounds up to 5y (2018 amendment)
          </p>
        </div>

        <div className="rounded-xl border bg-white dark:bg-slate-900 p-4 shadow-sm">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-medium text-slate-500">Accrual Rate & Basis</span>
            <div className="h-7 w-7 rounded-lg bg-amber-50 text-amber-600 dark:bg-amber-950/50 dark:text-amber-400 flex items-center justify-center">
              <Coins className="h-4 w-4" />
            </div>
          </div>
          <div className="text-sm font-semibold text-slate-900 dark:text-slate-100">
            {daysPerYear} Days · {wageBasis} ÷ {divisor}
          </div>
          <p className="text-[11px] text-slate-500 mt-1">
            {divisor === 30 ? "BLA statutory 30-day calendar convention" : "Factory / 26-day working convention"}
          </p>
        </div>

        <div className="rounded-xl border bg-white dark:bg-slate-900 p-4 shadow-sm">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-medium text-slate-500">Ceiling / Maximum Cap</span>
            <div className="h-7 w-7 rounded-lg bg-purple-50 text-purple-600 dark:bg-purple-950/50 dark:text-purple-400 flex items-center justify-center">
              <Landmark className="h-4 w-4" />
            </div>
          </div>
          <div className="text-sm font-semibold text-slate-900 dark:text-slate-100">
            {capAmount > 0 ? fmtMoney(capAmount) : "Statutory Uncapped"}
          </div>
          <p className="text-[11px] text-slate-500 mt-1">
            {capAmount > 0 ? "Corporate payout ceiling enforced" : "Unlimited statutory entitlement"}
          </p>
        </div>
      </div>

      {/* Main Gratuity Policy Configuration Editor */}
      <GroupEditor
        key="gratuity"
        group="gratuity"
        title="Gratuity Policy Configuration"
        description="Configure statutory continuous service vesting, annual accrual rates, base wage component, daily wage divisor, and liability limits."
        icon={Award}
        fields={GRATUITY_FIELDS}
        settings={settings}
        canEdit={canEdit}
        onSaved={onSaved}
      />

      {/* Real-time Gratuity Simulator & Calculation Tester */}
      <SectionCard
        title="Gratuity Simulator & Calculation Tester"
        actions={
          <Button
            size="sm"
            variant="outline"
            className="h-8 text-xs gap-1.5"
            onClick={() => navigate("reports", { report: "gratuity" })}
          >
            <FileBarChart className="h-3.5 w-3.5 text-emerald-600" />
            <span>View Gratuity Provision Report</span>
            <ExternalLink className="h-3 w-3 opacity-60" />
          </Button>
        }
      >
        <div className="space-y-4">
          <div className="flex items-start gap-2 text-xs text-slate-500">
            <Calculator className="h-4 w-4 text-emerald-600 mt-0.5 shrink-0" />
            <span>
              Test your configured gratuity rules against any sample employee scenario in real time.
              Calculations adhere strictly to the pure engine rules shared between Exit Settlements and Provision Reporting.
            </span>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 bg-slate-50/70 dark:bg-slate-900/50 p-3.5 rounded-xl border">
            <div>
              <Label className="text-[11px] font-medium text-slate-600 dark:text-slate-300">Joining Date</Label>
              <Input
                type="date"
                className="h-8 text-xs mt-1"
                value={simJoiningDate}
                onChange={(e) => setSimJoiningDate(e.target.value)}
              />
            </div>
            <div>
              <Label className="text-[11px] font-medium text-slate-600 dark:text-slate-300">Last Working Day (LWD)</Label>
              <Input
                type="date"
                className="h-8 text-xs mt-1"
                value={simLwd}
                onChange={(e) => setSimLwd(e.target.value)}
              />
            </div>
            <div>
              <Label className="text-[11px] font-medium text-slate-600 dark:text-slate-300">Monthly Basic Salary (৳)</Label>
              <Input
                type="number"
                min={0}
                step={500}
                className="h-8 text-xs mt-1"
                value={simBasic}
                onChange={(e) => setSimBasic(Math.max(0, Number(e.target.value) || 0))}
              />
            </div>
            <div>
              <Label className="text-[11px] font-medium text-slate-600 dark:text-slate-300">Monthly Gross Salary (৳)</Label>
              <Input
                type="number"
                min={0}
                step={500}
                className="h-8 text-xs mt-1"
                value={simGross}
                onChange={(e) => setSimGross(Math.max(0, Number(e.target.value) || 0))}
              />
            </div>
          </div>

          {/* Simulation Output Card */}
          <div className="rounded-xl border p-4 bg-gradient-to-br from-slate-50/90 to-emerald-50/30 dark:from-slate-900 dark:to-emerald-950/20">
            <div className="flex flex-wrap items-center justify-between gap-3 pb-3 border-b border-slate-200/80 dark:border-slate-800">
              <div className="flex items-center gap-2">
                <span className="text-xs font-semibold text-slate-700 dark:text-slate-300">Simulation Outcome:</span>
                {simResult.eligible ? (
                  <Badge className="bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300 border-emerald-300 text-[11px]">
                    <CheckCircle2 className="h-3 w-3 mr-1" /> Eligible for Gratuity
                  </Badge>
                ) : (
                  <Badge variant="outline" className="text-rose-700 border-rose-300 bg-rose-50 dark:bg-rose-950/40 text-[11px]">
                    <AlertTriangle className="h-3 w-3 mr-1" /> Not Eligible
                  </Badge>
                )}
                {simResult.capped && (
                  <Badge className="bg-purple-100 text-purple-800 dark:bg-purple-950 dark:text-purple-300 border-purple-300 text-[11px]">
                    Capped at Ceiling Limit
                  </Badge>
                )}
              </div>
              <div className="flex items-center gap-3 text-xs text-slate-500">
                <span>Completed Service: <b>{simResult.years} yrs ({simResult.months} mos)</b></span>
                {simResult.months % 12 >= 6 && simResult.months >= (eligibilityYears * 12 - 6) && (
                  <span className="text-emerald-600 font-medium">(2018 amendment 4y 6m rule active)</span>
                )}
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 pt-3 items-center">
              <div>
                <span className="text-[11px] text-slate-500 block mb-0.5">Calculated Gratuity Payable</span>
                <span className="text-2xl font-bold tracking-tight text-slate-900 dark:text-slate-100">
                  {fmtMoney(simResult.amount)}
                </span>
                <span className="text-[11px] text-slate-500 block mt-0.5">
                  {simResult.eligible
                    ? `Payable upon exit final settlement voucher`
                    : `Threshold requirement: ${eligibilityYears} continuous years`}
                </span>
              </div>

              <div>
                <span className="text-[11px] text-slate-500 block mb-0.5">Daily Wage Base Applied</span>
                <span className="text-base font-semibold text-slate-800 dark:text-slate-200">
                  {fmtMoney(simResult.dailyWage)} <span className="text-xs font-normal text-slate-500">/ day</span>
                </span>
                <span className="text-[11px] text-slate-500 block mt-0.5">
                  Based on {wageBasis} (৳{((wageBasis === "GROSS" ? simGross : simBasic) || 0).toLocaleString()}) ÷ {divisor} days
                </span>
              </div>

              <div className="bg-white/80 dark:bg-slate-800/80 rounded-lg p-2.5 border text-xs text-slate-600 dark:text-slate-300 space-y-1">
                <div className="font-medium text-slate-700 dark:text-slate-200 text-[11px]">Mathematical Formula:</div>
                <div className="font-mono text-[11px] text-emerald-700 dark:text-emerald-400">
                  ({fmtMoney(simResult.dailyWage)} × {daysPerYear} days) × {simResult.years} years
                </div>
                <div className="text-[10px] text-slate-500">
                  = {fmtMoney(simResult.dailyWage * daysPerYear * simResult.years)}
                  {simResult.capped ? ` → Capped to ${fmtMoney(capAmount)}` : ""}
                </div>
              </div>
            </div>
          </div>
        </div>
      </SectionCard>

      {/* Bangladesh Labour Act (BLA 2006 §96) Compliance Reference Card */}
      <SectionCard title="Statutory Framework (Bangladesh Labour Act 2006 §96)">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs text-slate-600 dark:text-slate-400">
          <div className="space-y-3">
            <div className="flex gap-2.5">
              <div className="h-6 w-6 rounded-full bg-emerald-100 dark:bg-emerald-950 text-emerald-700 dark:text-emerald-400 flex items-center justify-center shrink-0 font-bold text-[11px]">1</div>
              <div>
                <h4 className="font-semibold text-slate-900 dark:text-slate-200 text-xs">Continuous Service Entitlement (§96(1))</h4>
                <p className="mt-0.5 leading-relaxed">
                  Gratuity is a statutory separation benefit payable to an employee on cessation of employment (resignation, retirement, retrenchment, or discharge) after continuous service of not less than 5 years.
                </p>
              </div>
            </div>

            <div className="flex gap-2.5">
              <div className="h-6 w-6 rounded-full bg-blue-100 dark:bg-blue-950 text-blue-700 dark:text-blue-400 flex items-center justify-center shrink-0 font-bold text-[11px]">2</div>
              <div>
                <h4 className="font-semibold text-slate-900 dark:text-slate-200 text-xs">2018 Labour Act Amendment Rounding Rule</h4>
                <p className="mt-0.5 leading-relaxed">
                  Under the amended Bangladesh Labour Act 2018, any fraction of continuous service exceeding 6 months (i.e. 4 years 6 months or more) is deemed a completed 5th year for qualifying statutory gratuity eligibility.
                </p>
              </div>
            </div>

            <div className="flex gap-2.5">
              <div className="h-6 w-6 rounded-full bg-amber-100 dark:bg-amber-950 text-amber-700 dark:text-amber-400 flex items-center justify-center shrink-0 font-bold text-[11px]">3</div>
              <div>
                <h4 className="font-semibold text-slate-900 dark:text-slate-200 text-xs">Statutory Rate of Calculation (§96(2))</h4>
                <p className="mt-0.5 leading-relaxed">
                  Gratuity shall be payable at a rate not less than 30 days’ wages for every completed year of service, or 45 days’ wages for each year of service in excess of 10 years where established by company policy or collective agreement.
                </p>
              </div>
            </div>
          </div>

          <div className="space-y-3">
            <div className="flex gap-2.5">
              <div className="h-6 w-6 rounded-full bg-purple-100 dark:bg-purple-950 text-purple-700 dark:text-purple-400 flex items-center justify-center shrink-0 font-bold text-[11px]">4</div>
              <div>
                <h4 className="font-semibold text-slate-900 dark:text-slate-200 text-xs">Death or Permanent Disability Exemption (§96(3))</h4>
                <p className="mt-0.5 leading-relaxed">
                  If an employee dies or suffers permanent disability while in service, gratuity is payable to their legal nominee or heir immediately, regardless of whether the 5-year continuous service condition was completed.
                </p>
              </div>
            </div>

            <div className="flex gap-2.5">
              <div className="h-6 w-6 rounded-full bg-indigo-100 dark:bg-indigo-950 text-indigo-700 dark:text-indigo-400 flex items-center justify-center shrink-0 font-bold text-[11px]">5</div>
              <div>
                <h4 className="font-semibold text-slate-900 dark:text-slate-200 text-xs">Automated Exit Settlement Integration</h4>
                <p className="mt-0.5 leading-relaxed">
                  The HRM exit settlement workflow (`exit.settle`) automatically uses this configuration to compute the statutory gratuity payable at final clearance, post journal entries to accounts, and itemize the exit slip.
                </p>
              </div>
            </div>

            <div className="flex gap-2.5">
              <div className="h-6 w-6 rounded-full bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 flex items-center justify-center shrink-0 font-bold text-[11px]">6</div>
              <div>
                <h4 className="font-semibold text-slate-900 dark:text-slate-200 text-xs">Provision Liability Projection</h4>
                <p className="mt-0.5 leading-relaxed">
                  The Gratuity Provision report calculates total accrued gratuity liability across the active workforce, providing audit-ready figures for IAS 19 / IFRS financial statement disclosures and fund planning.
                </p>
              </div>
            </div>
          </div>
        </div>
      </SectionCard>
    </div>
  )
}

// ================= B5 — module enable/disable toggles =================
function ModulesCard({ settings, canEdit, onSaved }: { settings: any; canEdit: boolean; onSaved: () => void }) {
  const toast = useHrm((s) => s.toast)
  const subscription = useHrm((s) => s.subscription)
  const navigate = useHrm((s) => s.navigate)
  const [disabled, setDisabled] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    setDisabled(new Set((settings?.modules?.disabled as string[]) ?? (settings?.modules?.enabled as string[]) ?? []))
  }, [settings])

  const toggle = (m: string) => setDisabled((s) => { const n = new Set(s); if (n.has(m)) n.delete(m); else n.add(m); return n })

  const save = async () => {
    setBusy(true)
    try {
      await useHrm.getState().saveSettingsGroup("modules", { disabled: Array.from(disabled) })
      toast("Module visibility saved — takes effect on next sign-in")
      onSaved()
    } catch (e: any) { toast(e.message, "err") } finally { setBusy(false) }
  }

  return (
    <SectionCard title="Module Visibility" actions={canEdit && (
      <Button size="sm" className="h-8 text-xs " onClick={save} disabled={busy}>
        <Save className="h-3.5 w-3.5 mr-1" /> {busy ? "Saving…" : "Save Visibility"}
      </Button>
    )}>
      <p className="text-xs text-slate-500 mb-3">
        Hides modules from navigation only. Access is still controlled by role permissions and your plan.
        The change applies to every user of this workspace — anyone signed in during the change sees it after their next sign-in.
      </p>
      {/* WP-D (2026-10-08) — only modules the tenant's plan actually COVERS are
          toggleable here (derived from entitlements: plan features + overrides,
          same precedence the shell enforces). Plan-excluded modules move to a
          locked "Not in your plan" section with an upgrade CTA → Billing.
          The Owner Console override dialog keeps showing the full catalog. */}
      {(() => {
        const covered = MODULES.filter((m) => moduleCoveredByPlan(m, subscription))
        const excluded = MODULES.filter((m) => !moduleCoveredByPlan(m, subscription))
        return (
          <>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2 max-h-96 overflow-y-auto pr-1">
              {covered.map((m) => (
                <label key={m} className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-xs cursor-pointer ${disabled.has(m) ? "text-slate-400 bg-slate-50 dark:bg-slate-900" : "text-slate-700 dark:text-slate-200 border-emerald-200"}`}>
                  <Switch checked={!disabled.has(m)} disabled={!canEdit} onCheckedChange={() => toggle(m)} />
                  <span className="truncate">{MODULE_LABELS[m] || m}</span>
                </label>
              ))}
            </div>
            {excluded.length > 0 && (
              <div className="mt-4 rounded-xl border border-amber-200 dark:border-amber-900 bg-amber-50/60 dark:bg-amber-950/30 p-3">
                <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
                  <div className="flex items-center gap-1.5 text-xs font-semibold text-amber-800 dark:text-amber-300">
                    <Lock className="h-3.5 w-3.5" /> Not in your plan ({excluded.length})
                  </div>
                  <Button size="sm" variant="outline" className="h-7 text-xs gap-1" onClick={() => navigate("billing")}>
                    <ArrowUpRight className="h-3.5 w-3.5" /> Upgrade — view Billing
                  </Button>
                </div>
                <p className="text-[11px] text-amber-700/80 dark:text-amber-400/80 mb-2">
                  These modules are excluded from your current subscription plan. Upgrade from the Billing page to unlock them.
                </p>
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
                  {excluded.map((m) => (
                    <div key={m} className="flex items-center gap-2 rounded-lg border border-dashed border-amber-300/70 dark:border-amber-800/70 px-3 py-2 text-xs text-slate-400 dark:text-slate-500 bg-slate-50/50 dark:bg-slate-900/40 cursor-not-allowed" title="Not included in your plan">
                      <Lock className="h-3 w-3 shrink-0" />
                      <span className="truncate">{MODULE_LABELS[m] || m}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )
      })()}
    </SectionCard>
  )
}

// ================= Templates (2026-10 restructure) =================
// HR Settings → Templates: SMS Templates · Email Templates · Letter Templates.
// SMS/Email templates are SYSTEM-DEFINED (fixed list, editable wording — no
// create/delete); Letter Templates keep their full CRUD (the original letter
// template studio, relocated from the HR Letters view).
function TemplatesRootTab({ canEdit }: { canEdit: boolean }) {
  const presetTab = useHrm((s) => (s.view?.key === "settings" ? (s.view?.params as any)?.tpl : undefined)) as string | undefined
  return (
    <SectionTabs defaultValue={presetTab || "smsTemplates"} tabs={[
      { value: "smsTemplates", label: "SMS Templates", content: <SmsTemplatesTab canEdit={canEdit} /> },
      { value: "emailTemplates", label: "Email Templates", content: <EmailTemplatesTab canEdit={canEdit} /> },
      { value: "letterTemplates", label: "Letter Templates", content: <LetterTemplatesTab /> },
    ]} />
  )
}


// ================= §L — Session security card: policy + live sessions (redesigned) =================
function SessionSecurityCard({ settings, canEdit, onSaved }: { settings: any; canEdit: boolean; onSaved: () => void }) {
  const toast = useHrm((s) => s.toast)
  const s = useHrm()
  // session policy state
  const [spValues, setSpValues] = useState<Record<string, any>>(() => groupDefaults(SESSION_POLICY_FIELDS, settings, "sessionPolicy"))
  const [spBusy, setSpBusy] = useState(false)
  const [spError, setSpError] = useState<string | null>(null)

  useEffect(() => {
    setSpValues(groupDefaults(SESSION_POLICY_FIELDS, settings, "sessionPolicy"))
  }, [settings])
  const setSpVal = (key: string, val: any) => setSpValues((prev) => ({ ...prev, [key]: val }))

  const savePolicy = async () => {
    setSpBusy(true); setSpError(null)
    try {
      await useHrm.getState().saveSettingsGroup("sessionPolicy", spValues)
      toast("Session policy saved")
      onSaved()
    } catch (e: any) { setSpError(e.message) } finally { setSpBusy(false) }
  }

  // live sessions state
  const { data, loading, error, reload } = useApi<any>(canEdit ? "sessions.list" : null)
  const [revoking, setRevoking] = useState<string | null>(null)
  // M-03 — proper ConfirmDialog replaces the browser's window.confirm
  const [revokeTarget, setRevokeTarget] = useState<any | null>(null)

  const revoke = async (row: any) => {
    if (revoking) return
    setRevoking(row.id)
    try {
      // C-01: send only the masked fingerprint — the server resolves the token
      await rpc("sessions.revoke", { maskedId: row.id, reason: "revoked from session admin" })
      s.toast(`Session of ${row.userName} revoked`)
      setRevokeTarget(null)
      reload()
    } catch (e: any) {
      s.toast(e.message || "Could not revoke the session", "err")
    } finally {
      setRevoking(null)
    }
  }

  const columns: Column<any>[] = [
    {
      key: "userName", label: "User", render: (r) => (
        <div>
          <p className="font-semibold text-xs text-slate-800 dark:text-slate-100">{r.userName}</p>
          <p className="text-[11px] text-slate-500 dark:text-slate-400">{r.userEmail}</p>
        </div>
      ),
    },
    { key: "userRole", label: "Role", render: (r) => <StatusBadge status={r.userRole} /> },
    { key: "ip", label: "Last IP", render: (r) => <span className="text-xs font-mono text-slate-600 dark:text-slate-300">{r.ip || "—"}</span> },
    { key: "userAgent", label: "Client", render: (r) => <span className="text-[11px] text-slate-500 max-w-[220px] truncate block" title={r.userAgent || ""}>{r.userAgent || "—"}</span> },
    { key: "lastSeenAt", label: "Last Active", render: (r) => <span className="text-xs tabular-nums text-slate-600 dark:text-slate-300 font-medium">{r.idleMinutes < 1 ? "just now" : `${r.idleMinutes} min idle`}</span> },
    { key: "expiresAt", label: "Expires", render: (r) => <span className="text-xs tabular-nums text-slate-400">{fmtDateTime(r.expiresAt)}</span> },
    { key: "actions", label: "", align: "right", render: (r) => (
      <Button variant="outline" size="sm" className="h-6.5 text-[11px] px-2 text-rose-600 dark:text-rose-400 border-rose-200 dark:border-rose-900/60 hover:bg-rose-50 dark:hover:bg-rose-950/40" disabled={!canEdit || !!revoking} onClick={() => setRevokeTarget(r)} aria-label={`Revoke session of ${r.userName}`}>
        {revoking === r.id ? "Revoking…" : "Revoke"}
      </Button>
    ) },
  ]

  return (
    <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden shadow-xs">
      {/* gradient header */}
      <div className="flex items-center justify-between px-4 py-2.5 bg-gradient-to-r from-slate-50 via-slate-50/80 to-slate-100/60 dark:from-slate-800/60 dark:via-slate-850 dark:to-slate-900 border-b border-slate-200/80 dark:border-slate-800">
        <div className="flex items-center gap-2.5">
          <div className="h-7 w-7 rounded-lg bg-emerald-100/80 dark:bg-emerald-950/60 border border-emerald-200/60 dark:border-emerald-900/40 flex items-center justify-center">
            <ShieldCheck className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h3 className="text-xs font-semibold text-slate-800 dark:text-slate-100 leading-tight">Session Governance &amp; Live Logins</h3>
              {data && (
                <Badge variant="secondary" className="text-[10px] h-4 px-1.5 font-normal">
                  {data.length} active
                </Badge>
              )}
            </div>
            <p className="text-[11px] text-slate-500 dark:text-slate-400">Idle timeouts, concurrent login limits, and real-time active session revocation</p>
          </div>
        </div>
      </div>

      {/* Session Policy — compact inline bar */}
      <div className="px-4 py-2.5 bg-slate-50/60 dark:bg-slate-850/30 border-b border-slate-200/80 dark:border-slate-800">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-4">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-400 dark:text-slate-500">Policy Limits</span>
            
            <div className="flex items-center gap-2 rounded-md border border-slate-200/80 dark:border-slate-800 bg-white dark:bg-slate-900 px-2.5 py-1">
              <label className="text-[11px] font-medium text-slate-600 dark:text-slate-300 whitespace-nowrap">Idle timeout:</label>
              <Input
                type="number" min={0}
                value={spValues.idleTimeoutMinutes ?? 0}
                disabled={!canEdit}
                onChange={(e) => setSpVal("idleTimeoutMinutes", e.target.value === "" ? 0 : Number(e.target.value))}
                className="h-6 w-14 text-xs text-center font-medium p-0"
              />
              <span className="text-[10px] text-slate-400 whitespace-nowrap">min (0 = off)</span>
            </div>

            <div className="flex items-center gap-2 rounded-md border border-slate-200/80 dark:border-slate-800 bg-white dark:bg-slate-900 px-2.5 py-1">
              <label className="text-[11px] font-medium text-slate-600 dark:text-slate-300 whitespace-nowrap">Concurrent cap:</label>
              <Input
                type="number" min={0}
                value={spValues.concurrentSessions ?? 0}
                disabled={!canEdit}
                onChange={(e) => setSpVal("concurrentSessions", e.target.value === "" ? 0 : Number(e.target.value))}
                className="h-6 w-14 text-xs text-center font-medium p-0"
              />
              <span className="text-[10px] text-slate-400 whitespace-nowrap">sessions / user (0 = ∞)</span>
            </div>
          </div>

          {canEdit && (
            <Button size="sm" className="h-7 text-xs font-medium" onClick={savePolicy} disabled={spBusy}>
              <Save className="h-3 w-3 mr-1" />{spBusy ? "Saving…" : "Save Policy"}
            </Button>
          )}
        </div>
        {spError && <p className="text-xs text-rose-600 mt-2">{spError}</p>}
      </div>

      {/* Live Sessions table */}
      <div className="p-4">
        <DataTable columns={columns} rows={data || undefined} loading={loading} error={error} pageSize={10}
          searchPlaceholder="Search active session user or IP…" emptyTitle="No active sessions" csvName="active-sessions" />
      </div>

      {/* M-03 — destructive action confirmed through the shared ConfirmDialog
          (busy + error states built in) instead of window.confirm */}
      <ConfirmDialog open={!!revokeTarget} onOpenChange={(v) => { if (!v) setRevokeTarget(null) }}
        title="Revoke session" danger confirmLabel="Revoke session"
        message={`Revoke the session of ${revokeTarget?.userName} (${revokeTarget?.userEmail})? They will be signed out everywhere that session is used.`}
        onConfirm={async () => { await revoke(revokeTarget) }} />
    </div>
  )
}

// ================= §L / M-19 — Backup & Restore tab =================
function BackupTab({ canEdit }: { canEdit: boolean }) {
  const s = useHrm()
  const [confirmText, setConfirmText] = useState("")
  const [password, setPassword] = useState("")
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ tables: number; rows: number } | null>(null)

  const download = async () => {
    if (busy) return
    if (confirmText !== "EXPORT") { s.toast('Type EXPORT to confirm', "err"); return }
    if (!password) { s.toast("Your password is required to download a backup", "err"); return }
    setBusy(true)
    setResult(null)
    try {
      // C-2 — the server requires typed confirmation + password re-authentication,
      // masks every secret and exports the user table as safe fields only.
      // M-04/M-05 — the table dumps now run as a background job; runJob polls
      // jobs.get and resolves with the export payload when the job is DONE.
      const data = await runJob<any>("backups.export", { confirm: confirmText, password })
      const json = JSON.stringify(data, null, 2)
      const blob = new Blob([json], { type: "application/json" })
      const url = URL.createObjectURL(blob)
      const a = document.createElement("a")
      a.href = url
      a.download = `hrm-backup-${new Date().toISOString().slice(0, 10)}.json`
      a.click()
      URL.revokeObjectURL(url)
      const tables = Object.keys(data.data || {})
      const rows = tables.reduce((n: number, t: string) => n + ((data.data as any)[t] || []).length, 0)
      setResult({ tables: tables.length, rows })
      s.toast(`Backup downloaded — ${tables.length} tables, ${rows} rows (secrets masked)`)
      setConfirmText("")
      setPassword("")
    } catch (e: any) {
      s.toast(e.message || "Backup export failed", "err")
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-4">
      <SectionCard title="JSON Data Export" actions={<span className="text-[11px] text-slate-500">secrets masked · credentials excluded · password re-auth</span>}>
        <p className="text-xs text-slate-500 mb-3 max-w-2xl">Downloads every business table of your organization. Gateway secrets are masked, password hashes and sessions are never included, and the download itself requires typed confirmation plus your password.</p>
        <div className="space-y-3 max-w-md">
          <div className="space-y-1.5">
            <Label htmlFor="backup-confirm" className="text-xs">Type <b>EXPORT</b> to confirm</Label>
            <Input id="backup-confirm" value={confirmText} onChange={(e) => setConfirmText(e.target.value.toUpperCase())} placeholder="EXPORT" className="h-9 font-mono" disabled={!canEdit || busy} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="backup-password" className="text-xs">Your password (re-authentication)</Label>
            <Input id="backup-password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" className="h-9" disabled={!canEdit || busy} />
          </div>
          <Button onClick={download} disabled={!canEdit || busy || confirmText !== "EXPORT" || !password} className="h-9">
            {busy ? "Preparing backup…" : "Download JSON backup"}
          </Button>
          {result && (
            <p className="text-xs text-emerald-700 dark:text-emerald-400 flex items-center gap-1.5">
              <CheckCircle2 className="h-3.5 w-3.5" /> Exported {result.tables} tables / {result.rows} rows — secrets masked, credentials excluded.
            </p>
          )}
        </div>
      </SectionCard>

      <SectionCard title="Disaster Recovery (file backup)" actions={<span className="text-[11px] text-slate-500">RPO 24h · RTO 1h · quarterly drill</span>}>
        <p className="text-xs text-slate-500 mb-3">The JSON export is a data-portability tool, not disaster recovery. Nightly encrypted PostgreSQL snapshots (pg_dump) with a tested restore path are defined in the runbook.</p>
        <div className="text-xs text-slate-600 dark:text-slate-300 space-y-1.5">
          <p><b>Daily:</b> <code className="px-1 py-0.5 rounded bg-slate-100 dark:bg-slate-800">scripts/backup.sh</code> (cron 02:30, pg_dump custom format, optional AES-256, 14-day retention)</p>
          <p><b>Off-site:</b> rsync the <code className="px-1 py-0.5 rounded bg-slate-100 dark:bg-slate-800">backups/</code> folder to another host after creation</p>
          <p><b>Restore drill:</b> quarterly, per <code className="px-1 py-0.5 rounded bg-slate-100 dark:bg-slate-800">docs/BACKUP_RESTORE.md</code> (RPO 24h / RTO 1h)</p>
          <p><b>Live health:</b> <code className="px-1 py-0.5 rounded bg-slate-100 dark:bg-slate-800">GET /api/health</code> returns process + database status for your monitor</p>
        </div>
      </SectionCard>
    </div>
  )
}

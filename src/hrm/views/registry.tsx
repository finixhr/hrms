"use client"
// ============ View registry — lazy loads module views ============
// CHUNK-ERROR FIX (2026-10-12): every lazy view now loads through
// withChunkRetry() — a failed chunk fetch (stale manifest after a dev
// recompile / server restart / production deploy, or a cloud-sync client
// touching files) gets one silent retry, then a guarded one-shot page
// reload instead of the hard Runtime ChunkLoadError that used to unmount
// the whole workspace until a manual refresh.
import dynamic from "next/dynamic"
import { LoadingRows } from "../shared/ui-kit"
import { withChunkRetry } from "../chunk-recovery"

const loading = () => <LoadingRows rows={6} />

function lazyView(load: () => Promise<{ default: React.ComponentType }>) {
  return dynamic(() => withChunkRetry(load), { loading })
}

export const VIEWS: Record<string, React.ComponentType> = {
  dashboard: lazyView(() => import("./dashboard")),
  employees: lazyView(() => import("./employees")),
  organization: lazyView(() => import("./organization")),
  attendance: lazyView(() => import("./attendance")),
  // 2026-10-14 — the former "Attendance & Shifts" screen split into four
  // top-level menus; the tab components still live in attendance.tsx, so the
  // named exports load through the same chunk.
  shifts: lazyView(() => import("./attendance").then((m) => ({ default: m.ShiftsView }))),
  fieldsecurity: lazyView(() => import("./attendance").then((m) => ({ default: m.FieldSecurityView }))),
  devices: lazyView(() => import("./attendance").then((m) => ({ default: m.DevicesView }))),
  leave: lazyView(() => import("./leave")),
  payroll: lazyView(() => import("./payroll")),
  bonuses: lazyView(() => import("./bonuses")),
  deductions: lazyView(() => import("./payroll").then((m) => ({ default: m.DeductionsView }))),
  pf: lazyView(() => import("./payroll").then((m) => ({ default: m.PfView }))),
  loans: lazyView(() => import("./loans")),
  expenses: lazyView(() => import("./expenses")),
  performance: lazyView(() => import("./performance")),
  tasks: lazyView(() => import("./tasks")),
  approvals: lazyView(() => import("./approvals")),
  notifications: lazyView(() => import("./notifications")),
  announcements: lazyView(() => import("./announcements")),
  communication: lazyView(() => import("./communication")),
  documents: lazyView(() => import("./documents")),
  exit: lazyView(() => import("./exit")),
  ess: lazyView(() => import("./ess")),
  reports: lazyView(() => import("./reports")),
  analytics: lazyView(() => import("./analytics")),
  audit: lazyView(() => import("./audit")),
  settings: lazyView(() => import("./settings")),
  calendar: lazyView(() => import("./calendar")),
  overtime: lazyView(() => import("./overtime")),
  reimbursements: lazyView(() => import("./reimbursements")),
  orgchart: lazyView(() => import("./org-chart")),
  lifecycle: lazyView(() => import("./lifecycle")),
  ait: lazyView(() => import("./ait")),
  procurement: lazyView(() => import("./procurement")),
  inventory: lazyView(() => import("./inventory")),
  cameras: lazyView(() => import("./cameras")),
  subscription: lazyView(() => import("./subscription")),
  jobs: lazyView(() => import("./job-center")),
  // Wave 2 (2026-10-08): WP-K assets · WP-M fieldforce · WP-P recruitment
  assets: lazyView(() => import("./assets")),
  fieldforce: lazyView(() => import("./fieldforce")),
  recruitment: lazyView(() => import("./recruitment")),
  // Wave 2 WP-E — Accounting (vouchers, chart, trial balance, ledger, P&L)
  accounting: lazyView(() => import("./accounting")),
  // Accounting sidebar items — each maps to a named export in accounting.tsx
  "acc-coa":       lazyView(() => import("./accounting").then((m) => ({ default: m.AccCoaView }))),
  "acc-vouchers":  lazyView(() => import("./accounting").then((m) => ({ default: m.AccVouchersView }))),
  "acc-approvals": lazyView(() => import("./accounting").then((m) => ({ default: m.AccApprovalsView }))),
  "acc-statements":lazyView(() => import("./accounting").then((m) => ({ default: m.AccStatementsView }))),
  "acc-controls":  lazyView(() => import("./accounting").then((m) => ({ default: m.AccControlsView }))),
  // Wave 2 WP-H — tenant self-service billing portal
  billing: lazyView(() => import("./billing")),
  // 2026-10-25 — Support Center (master prompt Part A): tickets/chat + Live
  // Support Access requests. The view is ALSO reachable by PENDING_PAYMENT
  // (locked) tenants — the dispatcher allowlists the support.* prefix.
  support: lazyView(() => import("./support")),
  // Wave 4 (2026-10-08) — AI assist (NL report queries, anomalies, resume screening)
  aiassist: lazyView(() => import("./ai-assist")),
}

// ============ Failed-payment dunning engine (Wave 4 SG-C, 2026-10-08) ============
// Platform-plane job: reminds tenants with OVERDUE PENDING invoices via the
// platform email gateway (notify.ts machinery — sendPlatformEmail carries the
// H-10 outbound guards and the SENT/FAILED/SKIPPED contract; an unconfigured
// gateway SKIPS transparently instead of throwing).
//
// CADENCE: at most ONE automatic reminder per invoice every 7 days, tracked in
// SaaSSetting group "dunning" key `inv:<invoiceId>` as { lastSent, sent }.
// The daily pass reads every dunning-group counter in ONE query and consults
// the map; each actual send writes its counter back incrementally (upsert).
// INVOICE HISTORY IS NEVER MUTATED — no notes, no status changes; the reminder
// count lives in SaaSSetting only. Every send attempt (SENT/FAILED/SKIPPED)
// lands in SaaSAuditLog as DUNNING_REMINDER (entity SaasInvoice).
//
// RECIPIENTS: the tenant's admin users (db.user where vendorId = invoice's
// vendorId and role in [HR_ADMIN, VENDOR_OWNER] and status ACTIVE — the exact
// recipient resolution the lifecycle-sweep renewal reminders use, plaintext
// emails; there is no at-rest encryption on User.email).
//
// ENTRY POINTS:
//   - maybeRunDunning(date) — global daily pass, self-guarded by SaaSSetting
//     group "dunning" key "lastRun" === date. jobs.ts calls this on EVERY
//     scheduler tick BEFORE its own platformDaily date guard, so THIS guard is
//     what keeps the pass once-per-day.
//   - sendReminderNow(invoiceId, actorName) — manual owner-console send
//     (owner.dunning.remind). The 7-day cadence is BYPASSED by design (the
//     owner explicitly clicked "Send reminder"), but the send is still audited
//     and still increments the per-invoice counter.
import { db } from "@/lib/db"
import { saasAudit } from "./audit"
import { sendPlatformEmail } from "./notify"
import { getSaasSettings } from "./settings"

const DAY_MS = 86_400_000
/** One automatic reminder per invoice per 7 days. Exported since Phase 5 P2 —
 *  the collections console (billing-console.ts) surfaces the cadence to the
 *  owner UI; exporting keeps the console from drifting from the engine. */
export const CADENCE_DAYS = 7
/** Oldest-first cap for one automatic dunning pass. */
const PASS_CAP = 100
/** Admin roles that receive tenant-side dunning reminders. */
const REMINDER_ROLES = ["HR_ADMIN", "VENDOR_OWNER"]
/** Tenant admins are few; cap the recipient fan-out defensively. */
const RECIPIENT_CAP = 10

export type DunningSendResult = {
  invoiceId: string
  invoiceNumber: string
  status: "SENT" | "FAILED" | "SKIPPED"
  recipients: string[]
  sent: number
  skipped: number
  failed: number
  daysOverdue: number
  /** Total reminders on record for this invoice AFTER the send. */
  remindersSent: number
  detail?: string
}

export type DunningPassResult = {
  ranAt: string
  alreadyRanToday: boolean
  checked: number
  reminded: number
  errors: number
}

/** The invoice facts the reminder builder needs (subset select). */
type DunningInvoice = {
  id: string
  vendorId: string
  number: string
  amount: unknown // Prisma Decimal → Number() at use
  currency: string
  dueAt: Date | null
}

type ReminderState = { lastSent: string; sent: number }

/** Read every per-invoice reminder counter in ONE query (group "dunning",
 *  keys `inv:<id>`) — the daily pass consults this map for cadence checks
 *  instead of re-querying per invoice. */
async function readReminderStates(): Promise<Map<string, ReminderState>> {
  const rows = await db.saasSetting.findMany({ where: { group: "dunning", key: { startsWith: "inv:" } } })
  const map = new Map<string, ReminderState>()
  for (const r of rows) {
    try {
      const v = JSON.parse(r.value) as { lastSent?: unknown; sent?: unknown }
      if (v && typeof v === "object" && typeof v.lastSent === "string") {
        map.set(r.key, { lastSent: v.lastSent, sent: Number(v.sent) || 0 })
      }
    } catch { /* corrupt row — treated as absent */ }
  }
  return map
}

async function writeReminderState(invoiceId: string, state: ReminderState) {
  await db.saasSetting.upsert({
    where: { group_key: { group: "dunning", key: `inv:${invoiceId}` } },
    create: { group: "dunning", key: `inv:${invoiceId}`, value: JSON.stringify(state) },
    update: { value: JSON.stringify(state) },
  })
}

/** Bump (or seed) the per-invoice counter and return the new total. */
async function bumpReminderCounter(invoiceId: string): Promise<number> {
  let prevSent = 0
  try {
    const row = await db.saasSetting.findUnique({ where: { group_key: { group: "dunning", key: `inv:${invoiceId}` } } })
    if (row) prevSent = Number((JSON.parse(row.value) as { sent?: unknown })?.sent) || 0
  } catch { /* absent/corrupt — start at 0 */ }
  const remindersSent = prevSent + 1
  await writeReminderState(invoiceId, { lastSent: new Date().toISOString(), sent: remindersSent })
  return remindersSent
}

/**
 * Send ONE reminder for an invoice: email every ACTIVE tenant admin through
 * the platform gateway, audit the attempt as DUNNING_REMINDER, bump the
 * per-invoice counter. Never mutates the invoice row itself.
 * Shared by the automatic daily pass (actorName "Platform") and the manual
 * owner-console action (actorName = the clicking owner's name).
 */
async function deliverReminder(invoice: DunningInvoice, vendorName: string, actorName: string): Promise<DunningSendResult> {
  const now = Date.now()
  const daysOverdue = invoice.dueAt ? Math.max(0, Math.floor((now - invoice.dueAt.getTime()) / DAY_MS)) : 0
  const amount = Number(invoice.amount) || 0
  const money = `${invoice.currency === "BDT" ? "৳" : `${invoice.currency} `}${amount.toLocaleString("en-IN")}`

  // payment instruction — the same Billing deep-link shape the renewal
  // reminders use (websiteUrl + /app?view=billing&invoiceId=<number>)
  const s = await getSaasSettings()
  const base = String(s.general.websiteUrl || "").replace(/\/+$/, "")
  const payLine = base
    ? `Pay now from your workspace Billing page:\n${base}/app?view=billing&invoiceId=${encodeURIComponent(invoice.number)}`
    : `Sign in to your workspace, open Billing and settle invoice ${invoice.number}, or arrange payment with the platform team.`

  const subject = `Overdue invoice ${invoice.number} — Finix HR`
  const body =
    `Your invoice ${invoice.number} is overdue.\n\n` +
    `Workspace: ${vendorName}\nAmount due: ${money}\n` +
    `Due date: ${invoice.dueAt ? invoice.dueAt.toISOString().slice(0, 10) : "—"} — ${daysOverdue} day(s) overdue\n\n` +
    `${payLine}\n\n` +
    `While an invoice stays overdue the workspace risks becoming read-only once any grace period ends (your data is never deleted).\n\n` +
    `Already paid? If your payment has not been recorded yet, reply with the transaction reference so we can reconcile it.\n\n` +
    `— Finix HR Platform`

  const adminRows = await db.user.findMany({
    where: { vendorId: invoice.vendorId, role: { in: REMINDER_ROLES }, status: "ACTIVE" },
    select: { email: true },
    take: RECIPIENT_CAP,
  })
  const recipients = [
    ...new Set(adminRows.map((a) => a.email.trim().toLowerCase()).filter((e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e))),
  ]

  let sent = 0
  let skipped = 0
  let failed = 0
  const details: string[] = []
  if (recipients.length === 0) {
    skipped = 1
    details.push("no active HR_ADMIN/VENDOR_OWNER with a valid email on file")
  } else {
    for (const to of recipients) {
      const res = await sendPlatformEmail(to, subject, body)
      if (res.status === "SENT") sent++
      else if (res.status === "SKIPPED") skipped++
      else failed++
      if (res.detail) details.push(`${to}: ${res.detail.slice(0, 120)}`)
    }
  }
  const status: DunningSendResult["status"] = sent > 0 ? "SENT" : failed > 0 ? "FAILED" : "SKIPPED"
  // S1-012 — only bump the cadence counter when at least one email was actually
  // delivered; FAILED/SKIPPED attempts should not push the next reminder 7 days
  // out (the invoice holder never received anything).
  const remindersSent = status === "SENT" ? await bumpReminderCounter(invoice.id) : 0

  await saasAudit(
    { name: actorName },
    "DUNNING_REMINDER",
    "SaasInvoice",
    invoice.id,
    `Overdue reminder for invoice ${invoice.number} (${vendorName}) — ${money}, ${daysOverdue}d overdue → ${recipients.length} recipient(s): ${status}${details.length ? ` (${details.join("; ").slice(0, 200)})` : ""}`,
    {
      vendorId: invoice.vendorId,
      metadata: {
        invoiceNumber: invoice.number, daysOverdue, status,
        recipients: recipients.slice(0, 10), sent, skipped, failed, reminderNumber: remindersSent,
      },
    },
  )

  return {
    invoiceId: invoice.id,
    invoiceNumber: invoice.number,
    status,
    recipients,
    sent,
    skipped,
    failed,
    daysOverdue,
    remindersSent,
    detail: details.join("; ") || undefined,
  }
}

/**
 * One global dunning pass for the given calendar date (YYYY-MM-DD).
 * Self-guarded: SaaSSetting group "dunning" key "lastRun" === date → skip.
 * Finds PENDING invoices with dueAt < now (cap 100, oldest first) and sends a
 * reminder for each — unless that invoice was reminded within the last 7 days.
 */
export async function maybeRunDunning(date: string): Promise<DunningPassResult> {
  const ranAt = new Date().toISOString()
  const guard = await db.saasSetting.findUnique({ where: { group_key: { group: "dunning", key: "lastRun" } } })
  let alreadyRanToday = false
  try { alreadyRanToday = !!guard && JSON.parse(guard.value) === date } catch { alreadyRanToday = false }
  if (alreadyRanToday) return { ranAt, alreadyRanToday: true, checked: 0, reminded: 0, errors: 0 }

  const now = new Date()
  const overdue = await db.saasInvoice.findMany({
    where: { status: "PENDING", dueAt: { lt: now } },
    orderBy: { dueAt: "asc" }, // oldest first — chase the worst debts first
    take: PASS_CAP,
    select: { id: true, vendorId: true, number: true, amount: true, currency: true, dueAt: true },
  })

  const states = await readReminderStates()
  const vendorIds = [...new Set(overdue.map((i) => i.vendorId))]
  const vendors = vendorIds.length
    ? await db.vendor.findMany({ where: { id: { in: vendorIds } }, select: { id: true, name: true } })
    : []
  const nameOf = new Map(vendors.map((v) => [v.id, v.name]))

  let reminded = 0
  let errors = 0
  for (const inv of overdue) {
    const st = states.get(`inv:${inv.id}`)
    const lastSentAt = st ? Date.parse(st.lastSent) : NaN
    // cadence: ≤1 automatic reminder per invoice per 7 days
    if (st && Number.isFinite(lastSentAt) && Date.now() - lastSentAt < CADENCE_DAYS * DAY_MS) continue
    try {
      await deliverReminder(inv, nameOf.get(inv.vendorId) || inv.vendorId, "Platform")
      reminded++
    } catch (e) {
      errors++
      console.error(`[dunning] reminder failed for invoice ${inv.number}`, e)
    }
  }

  // mark the day as run — even when nothing was overdue, the pass happened
  // (a mid-pass crash leaves lastRun unset so the next tick retries safely)
  await db.saasSetting.upsert({
    where: { group_key: { group: "dunning", key: "lastRun" } },
    create: { group: "dunning", key: "lastRun", value: JSON.stringify(date) },
    update: { value: JSON.stringify(date) },
  })
  return { ranAt, alreadyRanToday: false, checked: overdue.length, reminded, errors }
}

/**
 * Manual owner-console send (owner.dunning.remind). The 7-day cadence is
 * bypassed by design — the owner chose to remind NOW — but the send is still
 * audited and still increments the per-invoice counter. Any PENDING invoice
 * can be reminded (even before its due date — owner judgment overrides the
 * queue's overdue filter); non-PENDING invoices are refused.
 */
export async function sendReminderNow(invoiceId: string, actorName: string): Promise<DunningSendResult> {
  const invoice = await db.saasInvoice.findUnique({
    where: { id: invoiceId },
    select: { id: true, vendorId: true, number: true, amount: true, currency: true, dueAt: true, status: true },
  })
  if (!invoice) throw Object.assign(new Error("Invoice not found"), { code: 404 })
  if (invoice.status !== "PENDING") {
    throw Object.assign(new Error(`Invoice is ${invoice.status} — only PENDING invoices can be reminded`), { code: 400 })
  }
  const vendor = await db.vendor.findUnique({ where: { id: invoice.vendorId }, select: { name: true } })
  const { status: _status, ...facts } = invoice
  return deliverReminder(facts, vendor?.name || invoice.vendorId, actorName)
}

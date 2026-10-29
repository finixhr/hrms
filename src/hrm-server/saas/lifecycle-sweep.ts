// ============ WP-J — automated subscription lifecycle sweep ============
// Called daily by jobs.ts platformDailyJobs (date-guarded there — one run per
// calendar day) and on demand by the owner console action
// owner.subscriptions.sweepNow (registered at the bottom of this file).
//
// TRANSITIONS (every one writes a SaasSubscriptionEvent + SaasAuditLog row and
// invalidates the entitlements memo; conditional updateMany keeps concurrent
// runs race-safe — a second sweep sees the new status and no-ops):
//
//   1. Scheduled downgrades whose cycle end arrived are applied (see
//      payments/billing-ops.ts for the storage design + semantics).
//   2. Paid-term catch-up: when the term ended but a PAID invoice already
//      covers the next term (bank transfer the owner marked paid, or any
//      invoice paid outside the gateway settle flow), the paid term is
//      applied — endDate := invoice.periodEnd, status ACTIVE. This keeps the
//      offline payment channel on par with the gateway settle flow.
//   3. ACTIVE + endDate passed UNPAID → PAST_DUE (event "PAST_DUE" — a new
//      event type value; the SaasSubscriptionEvent.type column is a free
//      string, and no existing type describes a past-due transition).
//      Grace tracking: SaasSubscription HAS a gracePeriodDays column, and the
//      sweep mirrors owner.subscriptions.grace — when the platform setting
//      subscription.gracePeriodDays > 0, endDate is extended by that many
//      days, gracePeriodDays records the window and the status becomes
//      GRACE_PERIOD ("GRACE_APPLIED" event, grace end = the new endDate).
//   4. PAST_DUE / GRACE_PERIOD + (grace) end reached → EXPIRED. Read-only
//      lockout via the entitlement engine — tenant data is NEVER deleted.
//   5. TRIAL + trial end reached → ACTIVE only when a paid plan is attached
//      (plan.isTrialPlan === false): a new paid term starts (cycleEndDate) and
//      the term invoice is generated. Otherwise → EXPIRED.
//
// RENEWAL REMINDERS: tenant admins (VENDOR_OWNER) get a reminder email at
// 30/15/7/3/1 days before endDate — {tenant, plan, endDate, daysLeft} plus a
// Pay Now deep link into the tenant Billing view with the open invoice
// attached. Deduped per (vendorId, endDate, daysLeft) in SaasSetting group
// "jobs" with the SAME key pattern the platformDailyJobs expiry notices use
// (`renewal-reminder:<vendorId>:<endDate>:<daysLeft>`), so a notice fires
// exactly once per end date per lead time.
//
// "RENEWAL_DUE" is NOT a stored status — it is derived at display time
// (ACTIVE with endDate ≤ 30 days away); adding a stored status would break
// the frozen OPERATING_STATUSES / READONLY_STATUSES contracts.
import { db } from "@/lib/db"
import { getSaasSettings } from "./settings"
import { saasAudit } from "./audit"
import { invalidateEntitlements } from "./entitlements"
import { cycleEndDate } from "./provision"
import { notifySubscriptionRenewalReminder, notifyExpiryNotice } from "./notify"
import { applyPendingDowngrade, createTermInvoice, systemActor } from "./payments/billing-ops"

/** R15 (2026-10-12) — default lead times (days before endDate) for the
 *  tenant-facing renewal reminders. The ACTIVE set is configurable
 *  (Settings → Subscription → renewalReminderDays); this constant is the
 *  fallback for unconfigured deployments. */
const DEFAULT_RENEWAL_REMINDER_DAYS = [30, 15, 7, 3, 1]

const OPERATING = ["TRIAL", "ACTIVE", "PAST_DUE", "GRACE_PERIOD"] as const

export type SweepResult = {
  ranAt: string
  checked: number
  downgradesApplied: number
  paidTermApplied: number
  pastDue: number
  graceApplied: number
  expired: number
  trialConverted: number
  remindersSent: number
  expiryNoticesSent: number
  expiryRetries: number
  errors: string[]
}

async function writeEvent(sub: { id: string; vendorId: string }, type: string, from: unknown, to: unknown, note: string | null, actorName: string) {
  await db.saasSubscriptionEvent.create({
    data: {
      subscriptionId: sub.id,
      vendorId: sub.vendorId,
      type,
      fromSnapshot: JSON.stringify(from),
      toSnapshot: JSON.stringify(to),
      note,
      actorId: null,
      actorName,
    },
  })
}

/** The daily lifecycle sweep. Idempotent: every transition is a conditional
 *  update guarded on the current status, so overlapping runs (daily job +
 *  manual sweepNow) never double-apply. */
export async function subscriptionLifecycleSweep(): Promise<SweepResult> {
  const actor = systemActor("Platform lifecycle sweep")
  const result: SweepResult = {
    ranAt: new Date().toISOString(),
    checked: 0, downgradesApplied: 0, paidTermApplied: 0, pastDue: 0, graceApplied: 0,
    expired: 0, trialConverted: 0, remindersSent: 0, expiryNoticesSent: 0, expiryRetries: 0, errors: [],
  }
  const settings = await getSaasSettings()
  const graceDays = Math.max(0, Math.min(90, Number(settings.subscription.gracePeriodDays) || 0))
  // R15 — configurable notice schedules + SMS toggle
  const reminderDays = (settings.subscription.renewalReminderDays || DEFAULT_RENEWAL_REMINDER_DAYS)
    .map((d) => Math.floor(Number(d))).filter((d) => Number.isFinite(d) && d >= 0)
  const postExpiryDays = (settings.subscription.postExpiryNoticeDays || [1, 7])
    .map((d) => Math.floor(Number(d))).filter((d) => Number.isFinite(d) && d >= 0)
  const expirySmsEnabled = settings.subscription.expirySmsEnabled === true
  // 2026-10-25 (master prompt Part H §13.1) — automatic renewal INVOICE
  // generation lead time (days before endDate; default 14). Idempotent:
  // initiateRenewalInvoice re-uses the open PENDING invoice for the term.
  const invoiceLeadDays = Math.max(0, Math.min(90, Math.floor(Number(settings.subscription.invoiceLeadDays ?? 14))))
  const now = Date.now()

  // ---- 1. scheduled downgrades at their recorded cycle end ----------------
  const scheduleRows = await db.saasSetting.findMany({ where: { group: "billing", key: { startsWith: "pendingPlan:" } } })
  for (const row of scheduleRows) {
    const vendorId = row.key.slice("pendingPlan:".length)
    try {
      if (await applyPendingDowngrade(vendorId, actor)) result.downgradesApplied++
    } catch (e) {
      result.errors.push(`downgrade:${vendorId}:${e instanceof Error ? e.message : String(e)}`)
    }
  }

  // ---- 2/3. term-end transitions -------------------------------------------
  // SCL-13 (Phase 3 WS-A) — WINDOWED queries. The pre-Phase-3 sweep loaded
  // EVERY TRIAL/ACTIVE/PAST_DUE/GRACE/EXPIRED subscription (100K+ rows at the
  // tenant goal) plus per-sub invoice/dedupe lookups (N+1) on every daily
  // run. Only subscriptions whose endDate is inside the relevant windows can
  // possibly transition or notify:
  //   * operating subs with endDate <= now + reminder horizon → term-end
  //     transitions + renewal reminders (a sub ending further out can neither
  //     transition nor match a reminder lead time);
  //   * EXPIRED subs with endDate within the post-expiry horizon → rejoin/
  //     renewal nudges (older expiries already got their notices — matching
  //     is journaled per endDate+daysOffset and never re-fires).
  // `checked` therefore counts subs INSIDE the window (the only rows examined)
  // rather than the whole table — same SweepResult shape, tighter semantics.
  const reminderHorizonDays = Math.max(2, ...(reminderDays.length ? reminderDays : [0])) + 2
  const postExpiryHorizonDays = Math.max(2, ...(postExpiryDays.length ? postExpiryDays : [0])) + 2
  const horizonMs = reminderHorizonDays * 86400000
  const postHorizonMs = postExpiryHorizonDays * 86400000
  const subsRaw = await db.saasSubscription.findMany({
    where: {
      OR: [
        { status: { in: [...OPERATING] }, endDate: { lte: new Date(now + horizonMs) } },
        { status: "EXPIRED", endDate: { gte: new Date(now - postHorizonMs), lte: new Date(now + horizonMs) } },
      ],
    },
    include: { vendor: { select: { id: true, name: true } }, plan: { select: { id: true, isTrialPlan: true, billingMode: true } } },
  })
  // 2026-10-25 — endDate became nullable (non-expiring ONE_TIME entitlements,
  // master prompt §12.1C). The windowed queries above can never match a null
  // endDate, but the type stays Date|null — narrow once here so the whole
  // loop keeps its original non-null math. (Non-expiring subs can never
  // transition, remind or invoice — excluding them is semantically correct.)
  const subs = subsRaw.filter((s): s is typeof s & { endDate: Date } => s.endDate != null)
  // SCL-13 — batch the covering-invoice lookups (was one findFirst per ended
  // subscription): PAID invoices for the ended set in ONE query, grouped by
  // subscriptionId in JS (the per-sub pick — latest periodEnd > sub.endDate —
  // preserves the exact original semantics).
  const endedSubs = subs.filter((s) => s.endDate.getTime() <= now)
  const coveringBySub = new Map<string, { number: string; periodEnd: Date; paidAt: Date | null }>()
  if (endedSubs.length) {
    const invRows = await db.saasInvoice.findMany({
      where: { subscriptionId: { in: endedSubs.map((s) => s.id) }, status: "PAID" },
      select: { subscriptionId: true, number: true, periodEnd: true, paidAt: true },
      orderBy: { periodEnd: "desc" },
    })
    for (const r of invRows) {
      if (!r.subscriptionId) continue
      const sid: string = r.subscriptionId
      const sub = endedSubs.find((s) => s.id === sid)
      if (!sub) continue
      if (r.periodEnd.getTime() <= sub.endDate.getTime()) continue // not covering
      if (!coveringBySub.has(sid)) coveringBySub.set(sid, r) // latest first
    }
  }
  const adminRows = subs.length
    ? await db.user.findMany({
        where: { vendorId: { in: subs.map((s) => s.vendorId) }, role: "VENDOR_OWNER", status: "ACTIVE" },
        select: { vendorId: true, email: true, phone: true },
      })
    : []
  const adminOf = new Map<string, string>()
  const adminPhoneOf = new Map<string, string>()
  for (const a of adminRows) {
    if (!adminOf.has(a.vendorId)) adminOf.set(a.vendorId, a.email)
    if (!adminPhoneOf.has(a.vendorId) && a.phone) adminPhoneOf.set(a.vendorId, a.phone)
  }

  // SCL-13 — batched dedupe state (was one SaasSetting.findUnique + one
  // SaasExpiryNotice.findFirst PER SUB): three IN queries up front cover every
  // reminder/post-expiry check in the loop below.
  const noticeKey = (vid: string, refDate: string, offset: number) => `${vid}|${refDate}|${offset}`
  const reminderKeysOf = (s: { vendorId: string; status: string; endDate: Date }) => {
    if (!OPERATING.includes(s.status as (typeof OPERATING)[number])) return []
    const daysLeft = Math.ceil((s.endDate.getTime() - now) / 86400000)
    return reminderDays.includes(daysLeft)
      ? [`renewal-reminder:${s.vendorId}:${s.endDate.toISOString().slice(0, 10)}:${daysLeft}`]
      : []
  }
  const allReminderKeys = [...new Set(subs.flatMap(reminderKeysOf))]
  const [reminderSettingRows, preExpiryRows, postExpiryRows] = await Promise.all([
    allReminderKeys.length
      ? db.saasSetting.findMany({ where: { group: "jobs", key: { in: allReminderKeys } } })
      : Promise.resolve([] as { key: string }[]),
    subs.length
      ? db.saasExpiryNotice.findMany({
          where: { vendorId: { in: subs.map((s) => s.vendorId) }, kind: "PRE_EXPIRY" },
          select: { vendorId: true, refDate: true, daysOffset: true, status: true, attempts: true },
        })
      : Promise.resolve([] as { vendorId: string; refDate: string; daysOffset: number; status: string; attempts: number }[]),
    subs.length
      ? db.saasExpiryNotice.findMany({
          where: { vendorId: { in: subs.map((s) => s.vendorId) }, kind: "POST_EXPIRY" },
          select: { vendorId: true, refDate: true, daysOffset: true, status: true, attempts: true },
        })
      : Promise.resolve([] as { vendorId: string; refDate: string; daysOffset: number; status: string; attempts: number }[]),
  ])
  const reminderSettingSeen = new Set(reminderSettingRows.map((r) => r.key))
  const preExpiryBy = new Map(preExpiryRows.map((n) => [noticeKey(n.vendorId, n.refDate, n.daysOffset), n]))
  const postExpiryBy = new Map(postExpiryRows.map((n) => [noticeKey(n.vendorId, n.refDate, n.daysOffset), n]))

  for (const sub of subs) {
    result.checked++
    try {
      let current = sub

      // ---- 2026-10-25 (master prompt Part H §13.1) — AUTOMATIC RENEWAL
      // INVOICE generation. For RECURRING subscriptions inside the lead
      // window (invoiceLeadDays before endDate), issue the next term's
      // PENDING invoice so the tenant can Pay Now early. Idempotent:
      // initiateRenewalInvoice re-uses the open PENDING invoice for the
      // term; ONE_TIME subscriptions never generate renewal invoices; the
      // subscription itself is NEVER extended here (payment-only rule).
      if (
        sub.status === "ACTIVE" &&
        (sub as any).billingMode !== "ONE_TIME" &&
        sub.endDate &&
        Math.ceil((sub.endDate.getTime() - now) / 86400000) <= invoiceLeadDays
      ) {
        try {
          const { initiateRenewalInvoice } = await import("./payments/billing-ops")
          await initiateRenewalInvoice(sub.vendorId, actor, {
            note: `Automatic renewal invoice (generated ${Math.ceil((sub.endDate.getTime() - now) / 86400000)} days before term end by the billing scheduler)`,
          })
        } catch (e: any) {
          // never block the sweep on invoice generation (SUSPENDED/CANCELLED
          // subs and other soft failures are expected and logged)
          result.errors.push(`auto-invoice:${sub.vendorId}:${String(e?.message || e).slice(0, 120)}`)
        }
      }
      const ended = sub.endDate.getTime() <= now

      // ---- 2. paid-term catch-up (a PAID invoice already covers the next term)
      // SCL-13 — the covering invoice comes from the batch query above.
      if (ended) {
        const covering = coveringBySub.get(sub.id) || null
        if (covering) {
          const from = { status: sub.status, endDate: sub.endDate.toISOString() }
          const newEnd = covering.periodEnd
          const claimed = await db.saasSubscription.updateMany({
            where: { id: sub.id, endDate: sub.endDate },
            data: { status: "ACTIVE", endDate: newEnd },
          })
          if (claimed.count > 0) {
            await writeEvent(sub, "EXTENDED", from, { status: "ACTIVE", endDate: newEnd.toISOString() },
              `Paid term applied from invoice ${covering.number} (paid ${covering.paidAt?.toISOString().slice(0, 10) ?? "—"})`,
              actor?.name || "Platform lifecycle sweep")
            invalidateEntitlements(sub.vendorId)
            await saasAudit(actor, "SUBSCRIPTION_EXTENDED", "SaaSSubscription", sub.id,
              `Paid invoice term applied: end → ${newEnd.toISOString().slice(0, 10)} (invoice ${covering.number})`,
              { vendorId: sub.vendorId, metadata: { from, to: newEnd.toISOString(), invoice: covering.number } })
            result.paidTermApplied++
            const refreshed = await db.saasSubscription.findUnique({ where: { id: sub.id } })
            if (refreshed) current = { ...current, ...refreshed, plan: current.plan, vendor: current.vendor } as typeof current
            continue // this term is settled — reminders use the new endDate next run
          }
        }
      }

      // ---- 3. unpaid term-end transitions -----------------------------------
      if (ended && current.status === "ACTIVE") {
        const from = { status: "ACTIVE", endDate: sub.endDate.toISOString() }
        const claimed = await db.saasSubscription.updateMany({
          where: { id: sub.id, status: "ACTIVE" },
          data: { status: "PAST_DUE" },
        })
        if (claimed.count > 0) {
          await writeEvent(sub, "PAST_DUE", from, { status: "PAST_DUE", endDate: sub.endDate.toISOString() },
            "Term ended without a recorded payment — flagged past due", actor?.name || "Platform lifecycle sweep")
          await saasAudit(actor, "SUBSCRIPTION_PAST_DUE", "SaaSSubscription", sub.id,
            `Term ended unpaid: ${sub.vendor?.name || sub.vendorId} (${sub.planName}) — status ACTIVE → PAST_DUE`,
            { vendorId: sub.vendorId, metadata: { from } })
          invalidateEntitlements(sub.vendorId)
          result.pastDue++
          current = { ...current, status: "PAST_DUE" }

          // grace window (mirrors owner.subscriptions.grace: endDate += days)
          if (graceDays > 0) {
            const graceEnd = new Date(sub.endDate.getTime() + graceDays * 86400000)
            const graceClaim = await db.saasSubscription.updateMany({
              where: { id: sub.id, status: "PAST_DUE" },
              data: { status: "GRACE_PERIOD", endDate: graceEnd, gracePeriodDays: graceDays },
            })
            if (graceClaim.count > 0) {
              await writeEvent(sub, "GRACE_APPLIED",
                { status: "PAST_DUE" },
                { status: "GRACE_PERIOD", endDate: graceEnd.toISOString(), gracePeriodDays: graceDays },
                `Automatic grace window of ${graceDays} day(s) — the workspace stays fully operational until ${graceEnd.toISOString().slice(0, 10)}`,
                actor?.name || "Platform lifecycle sweep")
              await saasAudit(actor, "SUBSCRIPTION_GRACE_APPLIED", "SaaSSubscription", sub.id,
                `Grace period applied: ${graceDays} days (end → ${graceEnd.toISOString().slice(0, 10)})`,
                { vendorId: sub.vendorId, metadata: { from: "PAST_DUE", to: "GRACE_PERIOD", days: graceDays } })
              invalidateEntitlements(sub.vendorId)
              result.graceApplied++
              current = { ...current, status: "GRACE_PERIOD", endDate: graceEnd, gracePeriodDays: graceDays }
            }
          }
        }
      } else if (ended && (current.status === "PAST_DUE" || current.status === "GRACE_PERIOD")) {
        // no grace was configured (PAST_DUE), or the grace end has been reached
        const from = { status: current.status, endDate: current.endDate.toISOString() }
        const claimed = await db.saasSubscription.updateMany({
          where: { id: sub.id, status: current.status },
          data: { status: "EXPIRED" },
        })
        if (claimed.count > 0) {
          await writeEvent(sub, "EXPIRED", from, { status: "EXPIRED" },
            current.status === "GRACE_PERIOD"
              ? "Grace period ended without payment — workspace is now read-only (data preserved)"
              : "Term ended unpaid with no grace window — workspace is now read-only (data preserved)",
            actor?.name || "Platform lifecycle sweep")
          await saasAudit(actor, "SUBSCRIPTION_EXPIRED", "SaaSSubscription", sub.id,
            `Subscription expired: ${sub.vendor?.name || sub.vendorId} (${sub.planName}) — workspace read-only, data preserved`,
            { vendorId: sub.vendorId, metadata: { from } })
          invalidateEntitlements(sub.vendorId)
          result.expired++
          current = { ...current, status: "EXPIRED" }
        }
      } else if (ended && current.status === "TRIAL") {
        // trial end → ACTIVE only if a paid plan is attached, else EXPIRED
        const paidPlanAttached = current.plan ? current.plan.isTrialPlan === false : false
        if (paidPlanAttached) {
          const from = { status: "TRIAL", endDate: sub.endDate.toISOString() }
          const newStart = new Date()
          const newEnd = cycleEndDate(newStart, sub.billingCycle)
          const claimed = await db.saasSubscription.updateMany({
            where: { id: sub.id, status: "TRIAL" },
            data: { status: "ACTIVE", startDate: newStart, endDate: newEnd },
          })
          if (claimed.count > 0) {
            await writeEvent(sub, "EXTENDED", from,
              { status: "ACTIVE", startDate: newStart.toISOString(), endDate: newEnd.toISOString() },
              "Trial ended with a paid plan attached — converted to a paid subscription term",
              actor?.name || "Platform lifecycle sweep")
            await createTermInvoice({
              vendorId: sub.vendorId,
              subscriptionId: sub.id,
              amount: Number(sub.priceAtCreation),
              currency: sub.currencySnapshot,
              periodStart: newStart,
              periodEnd: newEnd,
              dueAt: new Date(newStart.getTime() + 7 * 86400000),
              notes: `Trial conversion — ${sub.planName} (${sub.billingCycle.toLowerCase()})`,
              actor,
            })
            invalidateEntitlements(sub.vendorId)
            await saasAudit(actor, "SUBSCRIPTION_TRIAL_CONVERTED", "SaaSSubscription", sub.id,
              `Trial ended with a paid plan attached: converted to ACTIVE, term through ${newEnd.toISOString().slice(0, 10)}, invoice issued`,
              { vendorId: sub.vendorId, metadata: { from, to: { status: "ACTIVE", endDate: newEnd.toISOString() } } })
            result.trialConverted++
            current = { ...current, status: "ACTIVE", endDate: newEnd, startDate: newStart }
          }
        } else {
          const from = { status: "TRIAL", endDate: sub.endDate.toISOString() }
          const claimed = await db.saasSubscription.updateMany({
            where: { id: sub.id, status: "TRIAL" },
            data: { status: "EXPIRED" },
          })
          if (claimed.count > 0) {
            await writeEvent(sub, "EXPIRED", from, { status: "EXPIRED" },
              "Trial ended without a paid plan attached — workspace is read-only (data preserved)",
              actor?.name || "Platform lifecycle sweep")
            await saasAudit(actor, "SUBSCRIPTION_EXPIRED", "SaaSSubscription", sub.id,
              `Trial expired: ${sub.vendor?.name || sub.vendorId} — workspace read-only, data preserved`,
              { vendorId: sub.vendorId, metadata: { from } })
            invalidateEntitlements(sub.vendorId)
            result.expired++
            current = { ...current, status: "EXPIRED" }
          }
        }
      }

      // ---- 4. renewal reminders (configurable days before endDate) ----------
      // R15 (2026-10-12) — the lead-time set comes from the platform settings
      // (subscription.renewalReminderDays; fallback [30,15,7,3,1]). Every
      // email/SMS attempt is journaled in SaasExpiryNotice (dedupe + retry);
      // the SaasSetting marker below stays as the backward-compatible
      // guard for deployments upgraded mid-flight.
      // SCL-13 — dedupe reads come from the batched maps above the loop.
      if (OPERATING.includes(current.status as (typeof OPERATING)[number])) {
        const daysLeft = Math.ceil((current.endDate.getTime() - now) / 86400000)
        if (reminderDays.includes(daysLeft)) {
          const key = `renewal-reminder:${sub.vendorId}:${current.endDate.toISOString().slice(0, 10)}:${daysLeft}`
          const refDate = current.endDate.toISOString().slice(0, 10)
          // the notice journal is the real dedupe (channel-aware, retriable)
          const journaled = preExpiryBy.get(noticeKey(sub.vendorId, refDate, daysLeft)) || null
          const seenSetting = reminderSettingSeen.has(key)
          const alreadySent = journaled?.status === "SENT"
          const exhausted = (journaled?.attempts ?? 0) >= 3
          if (!seenSetting && !alreadySent && !exhausted) {
            const openInvoice = await db.saasInvoice.findFirst({
              where: { vendorId: sub.vendorId, status: "PENDING" },
              orderBy: { createdAt: "desc" },
              select: { id: true, number: true },
            })
            const adminPhone = adminPhoneOf.get(sub.vendorId) || null
            const notif = await notifyExpiryNotice({
              vendorId: sub.vendorId,
              vendorName: sub.vendor?.name || sub.vendorId,
              planName: current.planName,
              endDate: current.endDate,
              daysOffset: daysLeft,
              kind: "PRE_EXPIRY",
              adminEmail: adminOf.get(sub.vendorId) || null,
              adminPhone,
              smsEnabled: expirySmsEnabled,
            })
            if (notif.email.status === "SENT" || notif.sms?.status === "SENT") {
              result.expiryNoticesSent++
              // rich email (Pay Now deep link) rides on the legacy reminder
              await notifySubscriptionRenewalReminder({
                vendorId: sub.vendorId,
                vendorName: sub.vendor?.name || sub.vendorId,
                planName: current.planName,
                endDate: current.endDate,
                daysLeft,
                adminEmail: null, // the plain reminder email already went out above
                openInvoiceId: openInvoice?.number || null,
              })
            } else if (journaled) result.expiryRetries++
            await db.saasSetting.upsert({
              where: { group_key: { group: "jobs", key } },
              create: { group: "jobs", key, value: JSON.stringify(result.ranAt.slice(0, 10)) },
              update: { value: JSON.stringify(result.ranAt.slice(0, 10)) },
            })
            result.remindersSent++
          }
        }
      }

      // ---- 4b. POST-expiry notices (rejoin / renewal nudges) ----------------
      // R15 — configurable days AFTER expiry (subscription.postExpiryNoticeDays,
      // default [1, 7]); kind POST_EXPIRY. Retries failed attempts (max 3).
      // SCL-13 — journaled dedupe read comes from the batched map.
      if (current.status === "EXPIRED") {
        const daysSince = Math.floor((now - current.endDate.getTime()) / 86400000)
        if (postExpiryDays.includes(daysSince)) {
          const journaled = postExpiryBy.get(noticeKey(sub.vendorId, current.endDate.toISOString().slice(0, 10), -daysSince)) || null
          const alreadySent = journaled?.status === "SENT"
          const exhausted = (journaled?.attempts ?? 0) >= 3
          if (!alreadySent && !exhausted) {
            const notif = await notifyExpiryNotice({
              vendorId: sub.vendorId,
              vendorName: sub.vendor?.name || sub.vendorId,
              planName: current.planName,
              endDate: current.endDate,
              daysOffset: -daysSince,
              kind: "POST_EXPIRY",
              adminEmail: adminOf.get(sub.vendorId) || null,
              adminPhone: adminPhoneOf.get(sub.vendorId) || null,
              smsEnabled: expirySmsEnabled,
            })
            if (notif.email.status === "SENT" || notif.sms?.status === "SENT") result.expiryNoticesSent++
            else if (journaled) result.expiryRetries++
          }
        }
      }
    } catch (e) {
      result.errors.push(`${sub.vendorId}:${e instanceof Error ? e.message : String(e)}`)
    }
  }
  return result
}

// ---------------------------------------------------------------------------
// Owner console manual trigger. This module self-registers via ownerAction()
// (same pattern as cms-routes.ts / health.ts) and is side-effect-imported by
// the /api/owner dispatcher (src/app/api/owner/route.ts) — see the import
// line added there by WP-J.
//
// The import below pulls in the WP-I payment-gateway settings actions
// (owner.payments.get / owner.payments.save, registered in
// saas/payments/credentials.ts) through the SAME dispatcher import line —
// registration-only, nothing in the sweep itself uses them.
// ---------------------------------------------------------------------------
import { z } from "zod"
import { ownerAction } from "./owner-routes"
import { rateLimit } from "../security"
import "./payments/credentials"

ownerAction("owner.subscriptions.sweepNow", {
  perm: "subscriptions.manage",
  schema: z.object({ note: z.string().max(500).optional() }),
  handler: async (ctx, p) => {
    // manual triggers are throttled (the daily job needs no throttle): 3 per
    // 5 minutes per owner via the shared Throttle-table rate limiter
    if (await rateLimit(`sweep-now:${ctx.ownerId}`, 3, 5 * 60_000)) {
      throw Object.assign(new Error("Too many manual sweeps — wait a few minutes and try again."), { code: 429 })
    }
    const result = await subscriptionLifecycleSweep()
    await saasAudit(ctx, "SUBSCRIPTION_SWEEP_RUN", "SaaSSubscription", null,
      `Manual lifecycle sweep${p.note ? ` — ${p.note}` : ""}: ${result.checked} subscription(s) checked · ` +
        `${result.pastDue} past due · ${result.graceApplied} grace applied · ${result.expired} expired · ` +
        `${result.trialConverted} trial(s) converted · ${result.downgradesApplied} scheduled downgrade(s) applied · ` +
        `${result.paidTermApplied} paid term(s) applied · ${result.remindersSent} reminder(s) sent` +
        (result.errors.length ? ` · ${result.errors.length} error(s)` : ""),
      { metadata: result })
    return { result }
  },
})

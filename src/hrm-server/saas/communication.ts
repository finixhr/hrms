// ============ R11 (2026-10-12) — SaaS Owner Communication campaign engine ============
// Marketing / promotional / newsletter campaigns from the OWNER plane to
// tenant administrators (the billing contact of every vendor is the
// VENDOR_OWNER user; vendors can opt out via Vendor.marketingOptOut —
// transactional notices are never affected, only campaigns).
//
// Owns: audience resolution, placeholder substitution, one-shot and
// scheduled delivery, retry-safe journaling in SaasCampaignRecipient.
// Routes live in communication-routes.ts; jobs.ts calls dispatchDueCampaigns()
// on every scheduler tick.
import { db } from "@/lib/db"
import { sendPlatformEmail, sendPlatformSms } from "./notify"
import { getSaasSettings } from "./settings"
import { j } from "../utils"
// OPS-5 (Phase 3 WS-E) — per-campaign distributed claim (prevents a manual
// send and a tick resume from running the same campaign concurrently)
import { tryAcquireLock, releaseLock } from "../coordination"

/** OPS-5 (Phase 3 WS-E) — recipients processed per deliverCampaign PASS. A
 *  pass may not exceed this (the tick must stay bounded); remaining PENDING
 *  recipients resume on the NEXT pass (tick-driven or manual). Small
 *  campaigns (the overwhelmingly common case) complete in a single pass. */
const RECIPIENTS_PER_PASS = Math.max(10, Math.floor(Number(process.env.HRM_CAMPAIGN_BATCH) || 200))
/** Chunk size for the set-based recipient journal (createMany). */
const JOURNAL_CHUNK = 500
/** An address with this many recorded bounces is suppressed from campaigns. */
const BOUNCE_SUPPRESS_AFTER = 3

type CampaignRow = {
  id: string
  name: string
  kind: string
  channel: string
  subject: string | null
  body: string
  audienceType: string
  audienceIds: string
  status: string
}

export type AudienceMember = {
  vendorId: string
  vendorName: string
  email: string | null
  phone: string | null
  planName: string | null
  endDate: Date | null
  optOut: boolean
}

const OPERATING = ["TRIAL", "ACTIVE", "PAST_DUE", "GRACE_PERIOD"]

/** Resolve the campaign audience. The recipient of a tenant-level campaign is
 *  the tenant's ACTIVE VENDOR_OWNER (the administrator who signed the
 *  registration — the same contact lifecycle-sweep uses for billing mail).
 *  Opt-out is resolved here so both preview and send agree on the numbers. */
export async function resolveCampaignAudience(c: Pick<CampaignRow, "audienceType" | "audienceIds">): Promise<AudienceMember[]> {
  const ids = j<string[]>(c.audienceIds, [])
  let vendorWhere: any
  switch (c.audienceType) {
    case "ACTIVE":
    case "TRIAL":
    case "EXPIRED": {
      const subs = await db.saasSubscription.findMany({
        where: c.audienceType === "ACTIVE"
          ? { status: { in: OPERATING } }
          : { status: c.audienceType },
        select: { vendorId: true },
      })
      vendorWhere = { id: { in: subs.map((s) => s.vendorId) } }
      break
    }
    case "PLAN": {
      const subs = await db.saasSubscription.findMany({
        where: { planId: { in: ids } },
        select: { vendorId: true },
      })
      vendorWhere = { id: { in: subs.map((s) => s.vendorId) } }
      break
    }
    case "CUSTOM":
      vendorWhere = { id: { in: ids } }
      break
    default: // ALL
      vendorWhere = {}
  }

  const vendors = await db.vendor.findMany({
    where: vendorWhere,
    select: { id: true, name: true, email: true, phone: true, marketingOptOut: true, active: true },
    orderBy: { name: "asc" },
  })

  // subscription context for placeholders ({{planName}} / {{endDate}})
  const subRows = vendors.length
    ? await db.saasSubscription.findMany({
        where: { vendorId: { in: vendors.map((v) => v.id) } },
        select: { vendorId: true, planName: true, endDate: true },
        orderBy: { endDate: "desc" },
      })
    : []
  const subOf = new Map<string, { planName: string; endDate: Date | null }>()
  for (const s of subRows) if (!subOf.has(s.vendorId)) subOf.set(s.vendorId, s)

  // administrator contact per vendor (first ACTIVE VENDOR_OWNER)
  const adminRows = vendors.length
    ? await db.user.findMany({
        where: { vendorId: { in: vendors.map((v) => v.id) }, role: "VENDOR_OWNER", status: "ACTIVE" },
        select: { vendorId: true, email: true, phone: true },
        orderBy: { createdAt: "asc" },
      })
    : []
  const adminOf = new Map<string, { email: string; phone: string | null }>()
  for (const a of adminRows) if (!adminOf.has(a.vendorId)) adminOf.set(a.vendorId, a)

  return vendors.map((v) => {
    const admin = adminOf.get(v.id)
    const sub = subOf.get(v.id)
    return {
      vendorId: v.id,
      vendorName: v.name,
      email: admin?.email || v.email || null,
      phone: admin?.phone || v.phone || null,
      planName: sub?.planName || null,
      endDate: sub?.endDate || null,
      optOut: v.marketingOptOut === true,
    }
  })
}

/** Placeholder substitution. Known keys render; unknown {{tokens}} stay
 *  verbatim (never blanked — a typo must be visible in the preview, not
 *  silently swallowed). */
export function renderCampaignMessage(
  template: string,
  vars: { tenantName: string; planName: string; endDate: string; platformName: string; offerCode: string }
): string {
  return String(template).replace(/\{\{\s*(\w+)\s*\}\}/g, (whole, key: string) => {
    switch (key) {
      case "tenantName": return vars.tenantName
      case "planName": return vars.planName
      case "endDate": return vars.endDate
      case "platformName": return vars.platformName
      case "offerCode": return vars.offerCode
      default: return whole
    }
  })
}

/** Deliver a campaign — chunked, resumable, bounce-aware (OPS-5, Phase 3
 *  WS-E).
 *
 *  BEFORE Phase 3: one unbounded loop awaited a gateway send PER RECIPIENT
 *  inside the scheduler tick (100K sequential sends for an ALL campaign), a
 *  crash mid-run stranded every remaining recipient forever (SENDING refused
 *  re-entry), and hard-bouncing addresses were re-mailed by every campaign.
 *
 *  NOW:
 *   * RESUME — SENDING campaigns re-enter freely; only recipients still
 *     PENDING are processed (each send is a status-guarded updateMany, so a
 *     concurrent duplicate pass can never double-send a settled recipient).
 *   * BOUNDED — at most RECIPIENTS_PER_PASS recipients per pass; the tick's
 *     resume loop (dispatchDueCampaigns) picks up the remainder next minute.
 *     The event loop is yielded between chunks.
 *   * BOUNCE LIST — failed sends upsert a CampaignBounce row; addresses at
 *     BOUNCE_SUPPRESS_AFTER+ bounces are journaled SKIPPED instead of mailed.
 *   * SINGLE-FLIGHT — a per-campaign distributed lock prevents a manual send
 *     and a tick resume from overlapping (belt-and-braces on top of the
 *     status-guarded recipient updates).
 *  Returns the pass tally plus how many recipients remain PENDING. */
export async function deliverCampaign(
  campaignId: string,
  actor: { id: string; name: string }
): Promise<{ total: number; sent: number; failed: number; skipped: number; remaining: number }> {
  const c = await db.saasCampaign.findUnique({ where: { id: campaignId } })
  if (!c) throw Object.assign(new Error("Campaign not found"), { code: 404 })
  if (["SENT", "PARTIAL", "FAILED"].includes(c.status)) {
    throw Object.assign(new Error(`Campaign already ran (${c.status.toLowerCase()}) — duplicate it to re-send.`), { code: 400 })
  }
  // OPS-5 — single-flight claim (10 min TTL bounds a crashed holder)
  const lock = await tryAcquireLock(`campaign:${campaignId}`, 10 * 60_000)
  if (!lock) {
    throw Object.assign(new Error("This campaign is already being delivered (another send is in progress) — recipients journal the progress; retry once it finishes."), { code: 409 })
  }
  try {
    const settings = await getSaasSettings()
    const platformName = settings.general.platformName || "Finix HR"

    // ---- journal every intended recipient FIRST (the delivery log) —
    // set-based createMany chunks with skipDuplicates (semantically identical
    // to the old per-member upsert whose update arm was a no-op) ----
    const audience = await resolveCampaignAudience(c)
    for (let i = 0; i < audience.length; i += JOURNAL_CHUNK) {
      const chunk = audience.slice(i, i + JOURNAL_CHUNK)
      await db.saasCampaignRecipient.createMany({
        data: chunk.map((m) => ({
          campaignId: c.id, vendorId: m.vendorId, vendorName: m.vendorName,
          contactEmail: m.email, contactPhone: m.phone, status: "PENDING",
        })),
        skipDuplicates: true, // settled rows from an earlier pass are never overwritten
      }).catch(() => {/* unique conflict on a concurrent journal — fine */})
    }
    await db.saasCampaign.update({
      where: { id: c.id },
      data: { status: "SENDING", totalRecipients: audience.length },
    })

    // ---- process PENDING recipients in bounded chunks ----
    let sent = 0, failed = 0, skipped = 0
    let processed = 0
    outer: while (processed < RECIPIENTS_PER_PASS) {
      const pending = await db.saasCampaignRecipient.findMany({
        where: { campaignId: c.id, status: "PENDING" },
        orderBy: { createdAt: "asc" },
        take: Math.min(50, RECIPIENTS_PER_PASS - processed),
      })
      if (!pending.length) break

      // bounce-list lookup for this chunk (one query)
      const channel = c.channel === "SMS" ? "SMS" : "EMAIL"
      const addresses = [...new Set(pending.map((r) => (channel === "SMS" ? r.contactPhone : r.contactEmail)).filter((v): v is string => !!v))]
      const bounceRows = addresses.length
        ? await db.campaignBounce.findMany({ where: { channel, address: { in: addresses }, bounceCount: { gte: BOUNCE_SUPPRESS_AFTER } } })
        : []
      const suppressed = new Set(bounceRows.map((b) => b.address))

      for (const r of pending) {
        const contact = channel === "SMS" ? r.contactPhone : r.contactEmail
        const suppressedByBounce = contact ? suppressed.has(contact) : false
        const skipReason = suppressedByBounce
          ? `bounce list: ${channel === "SMS" ? "phone" : "email"} has ${BOUNCE_SUPPRESS_AFTER}+ recorded bounces`
          : !contact
            ? `no ${channel === "SMS" ? "phone" : "email"} on the administrator record`
            : null
        // opt-out check needs the live vendor row (marketingOptOut may have
        // flipped since the audience was journaled)
        if (!skipReason) {
          const vendor = await db.vendor.findUnique({ where: { id: r.vendorId }, select: { marketingOptOut: true } })
          if (vendor?.marketingOptOut === true) {
            skipped++
            await db.saasCampaignRecipient.updateMany({
              where: { campaignId: c.id, vendorId: r.vendorId, status: "PENDING" },
              data: { status: "SKIPPED", lastError: "tenant opted out of platform marketing" },
            })
            processed++
            continue
          }
        }
        if (skipReason) {
          skipped++
          await db.saasCampaignRecipient.updateMany({
            where: { campaignId: c.id, vendorId: r.vendorId, status: "PENDING" },
            data: { status: "SKIPPED", lastError: skipReason },
          })
          processed++
          continue
        }

        const member = audience.find((m) => m.vendorId === r.vendorId)
        const message = renderCampaignMessage(c.body, {
          tenantName: r.vendorName || member?.vendorName || "your workspace",
          planName: member?.planName || "your current plan",
          endDate: member?.endDate ? member.endDate.toISOString().slice(0, 10) : "your renewal date",
          platformName,
          offerCode: (j<any>(c.audienceIds, []).offerCode) || "", // CUSTOM audience rows may carry one
        })
        const subject = c.subject
          ? renderCampaignMessage(c.subject, {
            tenantName: r.vendorName || member?.vendorName || "", planName: member?.planName || "your plan", endDate: member?.endDate ? member.endDate.toISOString().slice(0, 10) : "", platformName, offerCode: "",
          })
          : null

        const res = channel === "SMS"
          ? await sendPlatformSms(String(contact), message)
          : await sendPlatformEmail(String(contact), subject || `${platformName} — ${c.name}`, message)

        if (res.status === "SENT") {
          sent++
          await db.saasCampaignRecipient.updateMany({
            where: { campaignId: c.id, vendorId: r.vendorId, status: "PENDING" },
            data: { status: "SENT", sentAt: new Date(), attempts: { increment: 1 }, lastError: null },
          })
        } else if (res.status === "SKIPPED") {
          skipped++
          await db.saasCampaignRecipient.updateMany({
            where: { campaignId: c.id, vendorId: r.vendorId, status: "PENDING" },
            data: { status: "SKIPPED", lastError: res.detail || "gateway not configured", attempts: { increment: 1 } },
          })
        } else {
          failed++
          await db.saasCampaignRecipient.updateMany({
            where: { campaignId: c.id, vendorId: r.vendorId, status: "PENDING" },
            data: { status: "FAILED", lastError: (res.detail || "gateway error").slice(0, 300), attempts: { increment: 1 } },
          })
          // OPS-5 — record the bounce (suppression kicks in at BOUNCE_SUPPRESS_AFTER)
          await db.campaignBounce.upsert({
            where: { channel_address: { channel, address: String(contact) } },
            create: { channel, address: String(contact), reason: (res.detail || "gateway error").slice(0, 300) },
            update: { bounceCount: { increment: 1 }, reason: (res.detail || "gateway error").slice(0, 300), lastBounceAt: new Date() },
          }).catch(() => {})
        }
        processed++
        if (processed >= RECIPIENTS_PER_PASS) break outer
      }
      // yield the event loop between chunks — the tick stays responsive
      await new Promise((resolve) => setImmediate(resolve))
    }

    // ---- completion check: table-wide counts decide the final status ----
    const remaining = await db.saasCampaignRecipient.count({ where: { campaignId: c.id, status: "PENDING" } })
    const grouped = await db.saasCampaignRecipient.groupBy({ by: ["status"], where: { campaignId: c.id }, _count: true })
    const countOf = (s: string) => Number(grouped.find((g) => g.status === s)?._count || 0)
    const totalSettled = countOf("SENT") + countOf("FAILED") + countOf("SKIPPED")

    if (remaining > 0) {
      // bounded pass — counters reflect progress so far; the campaign stays
      // SENDING and the next pass (tick or manual) resumes the PENDING tail
      await db.saasCampaign.update({
        where: { id: c.id },
        data: { status: "SENDING", sentCount: countOf("SENT"), failedCount: countOf("FAILED"), skippedCount: countOf("SKIPPED") },
      })
      return { total: totalSettled + remaining, sent, failed, skipped, remaining }
    }

    // final status: SENT only when everyone who could be reached was reached
    // with no failures and no skips; anything less is PARTIAL (all-skipped —
    // e.g. gateway unset — surfaces as PARTIAL with skippedCount, never a
    // misleading "SENT" with zero sends); FAILED when nothing went out due to
    // gateway errors. Counters are TABLE-WIDE so a resumed campaign reports
    // its true totals.
    const finalStatus = countOf("FAILED") > 0 && countOf("SENT") === 0 ? "FAILED" : countOf("SENT") > 0 && countOf("FAILED") === 0 && countOf("SKIPPED") === 0 ? "SENT" : "PARTIAL"
    await db.saasCampaign.update({
      where: { id: c.id },
      data: { status: finalStatus, sentAt: new Date(), sentCount: countOf("SENT"), failedCount: countOf("FAILED"), skippedCount: countOf("SKIPPED") },
    })

    const { saasAudit } = await import("./audit")
    await saasAudit({ id: actor.id, name: actor.name }, "CAMPAIGN_SENT", "SaasCampaign", c.id,
      `Campaign "${c.name}" (${c.channel}) finished: ${countOf("SENT")} sent, ${countOf("FAILED")} failed, ${countOf("SKIPPED")} skipped of ${totalSettled} recipient(s)`,
      { metadata: { channel: c.channel, total: totalSettled, sent: countOf("SENT"), failed: countOf("FAILED"), skipped: countOf("SKIPPED"), status: finalStatus } })

    return { total: totalSettled, sent, failed, skipped, remaining: 0 }
  } finally {
    await releaseLock(lock)
  }
}

/** Scheduler entry point (jobs.ts tick): claim + deliver every SCHEDULED
 *  campaign whose time has come, and RESUME SENDING campaigns that still
 *  have PENDING recipients (a crash mid-run, or a pass that hit its
 *  RECIPIENTS_PER_PASS budget — OPS-5 Phase 3 WS-E). Claiming is a guarded
 *  updateMany — two concurrent ticks can never both send the same campaign. */
export async function dispatchDueCampaigns(actor?: { id: string; name: string }): Promise<number> {
  const due = await db.saasCampaign.findMany({
    where: { status: "SCHEDULED", scheduledFor: { lte: new Date() } },
    select: { id: true },
    take: 10,
  })
  let dispatched = 0
  for (const c of due) {
    // claim: only the tick that flips SCHEDULED→SENDING delivers it
    const claimed = await db.saasCampaign.updateMany({
      where: { id: c.id, status: "SCHEDULED" },
      data: { status: "SENDING" },
    })
    if (claimed.count === 0) continue
    try {
      // deliverCampaign re-reads the row; the claim above makes its own
      // SENDING guard a no-op. A failure is journaled, never re-claimed.
      await deliverCampaign(c.id, actor || { id: "scheduler", name: "Platform scheduler" })
      dispatched++
    } catch (e: any) {
      // a SENDING campaign with PENDING recipients is NOT failed — the resume
      // pass below retries it next tick. Only settle FAILED when nothing went
      // out and no recipients remain pending (checked fresh below).
      const stillPending = await db.saasCampaignRecipient.count({ where: { campaignId: c.id, status: "PENDING" } }).catch(() => 0)
      if (stillPending === 0) {
        await db.saasCampaign.update({
          where: { id: c.id },
          data: { status: "FAILED", sentAt: new Date() },
        }).catch(() => {})
      }
      const { saasAudit } = await import("./audit")
      await saasAudit({ id: actor?.id || "scheduler", name: actor?.name || "Platform scheduler" },
        "CAMPAIGN_DISPATCH_ERROR", "SaasCampaign", c.id,
        `Campaign dispatch error: ${String(e?.message || e).slice(0, 300)}`,
        { metadata: { campaignId: c.id, pendingRecipients: stillPending } }).catch(() => {})
    }
  }
  // ---- OPS-5 (Phase 3 WS-E) — resume pass: SENDING campaigns with PENDING
  // recipients continue where the previous pass stopped (crash recovery +
  // budget continuation). deliverCampaign's per-campaign lock makes a
  // concurrent manual send a clean no-op instead of a double send.
  const resumable = await db.saasCampaign.findMany({
    where: { status: "SENDING" },
    select: { id: true },
    take: 5,
  })
  for (const c of resumable) {
    const pending = await db.saasCampaignRecipient.count({ where: { campaignId: c.id, status: "PENDING" } })
    if (pending === 0) continue
    try {
      await deliverCampaign(c.id, actor || { id: "scheduler", name: "Platform scheduler" })
      dispatched++
    } catch (e: any) {
      // lock contention (a manual send is running) or a transient error — the
      // next tick retries; never audited as CAMPAIGN_FAILED here
      console.error(`[campaigns] resume pass failed for ${c.id}:`, e?.message || e)
    }
  }
  return dispatched
}

// ============ SMS delivery journal (Wave 10 / Phase 6) ============
// Every outbound submission is journaled (SaasSmsMessage) for reconciliation,
// cost accounting and abuse forensics. DISCIPLINE (master prompt §6.4):
//   - OTP purposes store the body LENGTH only — bodyPreview stays null and
//     the code itself never touches this table or any log line;
//   - non-OTP previews truncate to 120 chars;
//   - statusDetail is a bounded error summary — never credentials, never the
//     api_token, never the raw provider body.
// Journal writes are fire-and-forget-safe: a journaling failure never fails
// the send path (the delivery log in CommunicationLog remains the
// tenant-visible record).
import { db } from "@/lib/db"

export type SmsJournalPurpose =
  | "OTP_LOGIN" | "OTP_VERIFY" | "TEST"
  | "WISHES" | "NOTICE" | "CAMPAIGN" | "SYSTEM"

const OTP_PURPOSES = new Set(["OTP_LOGIN", "OTP_VERIFY"])
const PREVIEW_MAX = 120
const DETAIL_MAX = 300

export type JournalSmsInput = {
  plane: "TENANT" | "PLATFORM"
  vendorId?: string | null
  toPhone: string // normalized +880…
  purpose: SmsJournalPurpose
  templateKey?: string | null
  body: string
  provider: string
}

export async function journalSmsStart(input: JournalSmsInput): Promise<string | null> {
  try {
    const row = await db.saasSmsMessage.create({
      data: {
        plane: input.plane,
        vendorId: input.vendorId || null,
        toPhone: input.toPhone.slice(0, 20),
        purpose: input.purpose,
        templateKey: input.templateKey ? input.templateKey.slice(0, 60) : null,
        bodyLength: input.body.length,
        bodyPreview: OTP_PURPOSES.has(input.purpose) ? null : input.body.slice(0, PREVIEW_MAX),
        provider: input.provider,
        status: "PENDING",
        attempts: 0,
      },
      select: { id: true },
    })
    return row.id
  } catch (e) {
    console.error("[sms-journal] start write failed:", e instanceof Error ? e.message : e)
    return null
  }
}

export async function journalSmsOutcome(
  journalId: string | null,
  outcome: { status: "SENT" | "FAILED" | "SKIPPED"; detail?: string; providerMessageId?: string | null },
): Promise<void> {
  if (!journalId) return
  try {
    await db.saasSmsMessage.update({
      where: { id: journalId },
      data: {
        status: outcome.status,
        statusDetail: outcome.detail ? outcome.detail.slice(0, DETAIL_MAX) : null,
        providerMessageId: outcome.providerMessageId ? String(outcome.providerMessageId).slice(0, 120) : null,
        attempts: { increment: 1 },
        lastAttemptAt: new Date(),
        deliveredAt: outcome.status === "SENT" ? new Date() : null,
      },
    })
  } catch (e) {
    console.error("[sms-journal] outcome write failed:", e instanceof Error ? e.message : e)
  }
}

/** Aggregates for the Owner Console integration panel (last 24h). */
export async function smsJournalStats(): Promise<{
  last24h: { sent: number; failed: number; skipped: number }
  last7d: { sent: number; failed: number }
  activeProviders: string[]
}> {
  const since24 = new Date(Date.now() - 86400000)
  const since7 = new Date(Date.now() - 7 * 86400000)
  const [rows24, sent7, failed7, providers] = await Promise.all([
    db.saasSmsMessage.groupBy({ by: ["status"], where: { createdAt: { gte: since24 } }, _count: { _all: true } }),
    db.saasSmsMessage.count({ where: { status: "SENT", createdAt: { gte: since7 } } }),
    db.saasSmsMessage.count({ where: { status: "FAILED", createdAt: { gte: since7 } } }),
    db.saasSmsMessage.groupBy({ by: ["provider"], where: { createdAt: { gte: since7 }, status: "SENT" }, _count: { _all: true } }),
  ])
  const count = (s: string) => Number(rows24.find((r) => r.status === s)?._count?._all || 0)
  return {
    last24h: { sent: count("SENT"), failed: count("FAILED"), skipped: count("SKIPPED") },
    last7d: { sent: sent7, failed: failed7 },
    activeProviders: providers.map((p) => p.provider),
  }
}

/** Recent rows for the console drill-down (masked: no bodies for OTP rows —
 *  they were never stored; previews are already truncated). */
export async function smsJournalRecent(take = 50) {
  return db.saasSmsMessage.findMany({
    orderBy: { createdAt: "desc" },
    take: Math.min(100, Math.max(1, take)),
    select: {
      id: true, plane: true, vendorId: true, toPhone: true, purpose: true,
      provider: true, providerMessageId: true, status: true, statusDetail: true,
      bodyLength: true, bodyPreview: true, createdAt: true, deliveredAt: true,
    },
  })
}

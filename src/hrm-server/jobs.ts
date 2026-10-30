// ============ Background jobs (spec §9.3 Payroll Automation, §12.2 Wishes, §12.3 Notifications) ============
// One lightweight scheduler, started from instrumentation.ts. Every job is
// idempotent (date-guarded) and multi-vendor aware. Failures are logged and
// retried on the next tick — no job can block another.
import { db } from "@/lib/db"
import { observeTick } from "./metrics"
import { getSettings, saveSettingsGroup } from "./settings"
import { deliverWishes, eventChannels } from "./delivery"
import { notify, audit } from "./audit"
import { Deny } from "./rbac"
import { today, addDays, monthName, resolveWeeklyOffDays } from "./utils"
import { maybeRunScheduledReports } from "./scheduled-reports"
import { flushWebhookDeliveries } from "./webhooks"
// SCL-21 (Phase 3 WS-B) — cluster-wide tick lock (Redis/Postgres backends)
import { tryAcquireLock, releaseLock } from "./coordination"
// HIGH-4 — graceful shutdown integration. Lazy-load lifecycle module inside
// drainJobs/runTick to avoid a circular import at module-load time. The lazy
// loader is safe to call repeatedly; the dynamic import is cached after first call.
let _isShuttingDown: () => boolean = () => false
let _recoverStaleBgJobs: () => Promise<number> = async () => 0
let _lifecycleLoaded = false
async function loadLifecycle(): Promise<void> {
  if (_lifecycleLoaded) return
  _lifecycleLoaded = true
  try {
    const m = await import("./lifecycle")
    _isShuttingDown = m.isShuttingDown
    _recoverStaleBgJobs = m.recoverStaleBgJobs
  } catch { /* lifecycle module not yet available during early boot */ }
}


/** M-38 — background-job email/SMS attempts are NEVER silently swallowed.
 *  Every attempt (SENT / FAILED / SKIPPED) lands in the CommunicationLog the
 *  same way employee-facing sends do (delivery.ts logDelivery) — scheduled
 *  attendance alerts, late reports and doc-expiry reminders used to vanish
 *  behind .catch(() => null) with no row anywhere. */
export async function sendLogged(
  vendorId: string,
  channel: "EMAIL" | "SMS",
  subject: string,
  send: () => Promise<{ status: string; detail?: string }>,
): Promise<{ status: string; detail?: string }> {
  let status = "FAILED"
  let detail: string | undefined
  try {
    const r = await send()
    status = r?.status || "FAILED"
    detail = r?.detail
  } catch (e: any) {
    detail = String(e?.message || e).slice(0, 200)
  }
  try {
    await db.communicationLog.create({
      data: {
        vendorId, channel, subject: subject.slice(0, 200), message: subject.slice(0, 500),
        audienceType: "EVENT", audienceLabel: "Automated job notification",
        recipientCount: 1,
        deliveredCount: status === "SENT" ? 1 : 0,
        failedCount: status === "FAILED" ? 1 : 0,
        skippedCount: status === "SKIPPED" ? 1 : 0,
        status: status === "SENT" ? "SENT" : status === "FAILED" ? "FAILED" : "SKIPPED",
      },
    })
  } catch { /* logging must never break the job */ }
  return { status, detail }
}

// M-33 — the documented HRM_JOBS_TICK_MS override is now actually READ (was
// documented but hardcoded). Clamped to 15s–5min so a typo cannot busy-loop.
const TICK_MS = Math.min(300_000, Math.max(15_000, Number(process.env.HRM_JOBS_TICK_MS) || 60_000))
let ticking = false // M-21 — a tick never overlaps the previous one

// ============ SCL-1 (Phase 2 WS1) — due-vendor discovery by query ============
// The old tick loaded EVERY active vendor and ran the per-vendor pass for
// each one — O(N tenants) queries per minute, impossible at 100K tenants.
// The tick now asks the DATABASE which vendors are actually DUE for work,
// in bounded batches behind a round-robin cursor (no head-of-fleet
// starvation), and stops at a wall-clock budget so a tick can never exceed
// the TICK_MS cadence. Due-ness is the OR of:
//   1. daily pass due   — HrSetting jobs.lastDailyDate != today (the daily
//      date-guard itself, hoisted into the discovery query);
//   2. camera sweep due — jobs.lastCameraSweep older than 10 minutes AND the
//      vendor actually has enabled cameras (camera-less tenants never
//      pollute the due set);
//   3. scheduled reports — vendor has at least one active scheduled
//      ReportTemplate (per-template time guards stay inside
//      maybeRunScheduledReports, so visits are cheap when nothing is due);
//   4. payroll reminders — vendor has an APPROVED (unpaid) run, so a run
//      approved mid-day on payment day still gets its same-day reminder.
// Everything else in the per-vendor pass is internally date/time-guarded, so
// a vendor visited for reason 2/3/4 costs only guard reads for the rest.
const VENDOR_BATCH = Math.min(10_000, Math.max(1, Number(process.env.HRM_JOBS_VENDOR_BATCH) || 1_000))
const TICK_BUDGET_MS = Math.min(55_000, Math.max(5_000, Number(process.env.HRM_JOBS_TICK_BUDGET_MS) || Math.min(25_000, TICK_MS - 5_000)))
const CAMERA_SWEEP_MINUTES = 10
// Round-robin cursor lives on globalThis (mirrors JOBS_TIMER_KEY): `next dev`
// reloads modules on edit and a module-level cursor would restart each batch
// from the head of the id space, starving the tail indefinitely.
const JOBS_CURSOR_KEY = Symbol.for("finix.hrm.jobsDueCursor")

/** SCL-1 — one bounded discovery query for vendors due for per-vendor work.
 *  Pure function of (date, cursor, limit): never mutates the cursor — the
 *  tick loop advances it past each PROCESSED vendor so a budget-aborted tick
 *  resumes exactly where it stopped (no skipped-then-wait-for-wraparound).
 *  Exported for unit tests. */
export async function findDueVendors(date: string, limit = VENDOR_BATCH): Promise<string[]> {
  const todayJson = JSON.stringify(date) // HrSetting values are JSON-encoded
  const rows = await db.$queryRaw<Array<{ id: string }>>`
    SELECT v."id" FROM "Vendor" v
    LEFT JOIN "HrSetting" d
      ON d."vendorId" = v."id" AND d."group" = 'jobs' AND d."key" = 'lastDailyDate'
    LEFT JOIN "HrSetting" c
      ON c."vendorId" = v."id" AND c."group" = 'jobs' AND c."key" = 'lastCameraSweep'
    WHERE v."active" = true
      AND v."id" > ${cursorValue()}
      AND (
        d."value" IS NULL OR d."value" <> ${todayJson}
        OR (
          EXISTS (SELECT 1 FROM "Camera" ca WHERE ca."vendorId" = v."id" AND ca."enabled" = true)
          AND (
            c."value" IS NULL
            OR COALESCE(
                 CASE WHEN c."value" ~ '^"\\d{4}-\\d{2}-\\d{2}T'
                   THEN (c."value"::jsonb #>> '{}')::timestamptz
                   ELSE NULL END,
                 '-infinity'::timestamptz
               ) < now() - (${CAMERA_SWEEP_MINUTES} * interval '1 minute')
          )
        )
        OR EXISTS (SELECT 1 FROM "ReportTemplate" rt
                   WHERE rt."vendorId" = v."id" AND rt."active" = true AND rt."schedule" <> 'OFF')
        OR EXISTS (SELECT 1 FROM "PayrollRun" pr
                   WHERE pr."vendorId" = v."id" AND pr."status" = 'APPROVED')
      )
    ORDER BY v."id" ASC
    LIMIT ${limit}`
  return rows.map((r) => r.id)
}

function cursorValue(): string {
  const g = globalThis as unknown as Record<symbol, string | undefined>
  return g[JOBS_CURSOR_KEY] || ""
}
/** Set the round-robin cursor past a processed vendor (see findDueVendors). */
function setDueCursor(vendorId: string): void {
  const g = globalThis as unknown as Record<symbol, string | undefined>
  g[JOBS_CURSOR_KEY] = vendorId
}

/** Test hook — reset the round-robin cursor. */
export function _resetDueCursorForTests(): void {
  const g = globalThis as unknown as Record<symbol, string | undefined>
  g[JOBS_CURSOR_KEY] = ""
}

// 2026-10-07 — the "started" guard lives on globalThis: `next dev` re-runs
// instrumentation with fresh module instances on every server-file edit, and
// the old module-level flag let each reload start ANOTHER scheduler (duplicate
// ticks → duplicate wishes/alerts). A reload now replaces the timer instead.
const JOBS_TIMER_KEY = Symbol.for("finix.hrm.jobsTimer")

export function startJobs() {
  const g = globalThis as unknown as Record<symbol, ReturnType<typeof setInterval> | undefined>
  const previous = g[JOBS_TIMER_KEY]
  if (previous) clearInterval(previous)
  console.log("[jobs] scheduler started (payroll automation, wishes, attendance alerts, document expiry)")
  const timer = setInterval(() => { runTick().catch((e) => console.error("[jobs] tick failed", e)) }, TICK_MS)
  g[JOBS_TIMER_KEY] = timer
  // do not hold the process open just for the scheduler
  if (typeof timer === "object" && "unref" in timer) (timer as any).unref()
  // first tick shortly after boot (give the DB/client a moment)
  setTimeout(() => { runTick().catch((e) => console.error("[jobs] first tick failed", e)) }, 5_000)
}

/** One scheduler pass over every active vendor (also the manual admin trigger). */
export async function runTick() {
  // M-21 — module-level in-flight guard: a slow pass (slow vendor, big sweep)
  // must not stack on the next 60s interval.
  if (ticking) return { vendors: 0, date: today(), skipped: true }
  ticking = true
  // Phase 1 WS Metrics — tick duration + vendor count for the /api/metrics
  // gauges (hrm_jobs_tick_*). Exit-criteria dashboards read these.
  const t0 = Date.now()
  let tickVendors = 0
  // SCL-21 (Phase 3 WS-B) — CLUSTER-WIDE tick lock. The in-process `ticking`
  // flag above only guards THIS process; behind a load balancer every
  // instance used to run the full per-vendor pass (duplicate O(N) scans ×N,
  // duplicate flushes, double daily-job attempts). The distributed lock
  // (Redis when configured, CoordinationLock rows otherwise) makes exactly
  // ONE instance tick at a time — per-vendor work, the daily platform pass,
  // webhook flushes and campaign dispatch are all single-flight. The TTL
  // bounds a crashed holder; a skipped tick is a no-op (the next interval
  // re-runs everything that is still due).
  const tickLock = await tryAcquireLock("scheduler:tick", TICK_MS + 60_000)
  if (!tickLock) {
    ticking = false // another instance owns this tick — do not strand the local guard
    return { vendors: 0, date: today(), skipped: true, reason: "tick lock held by another instance" }
  }
  try {
    // HIGH-4 — recover stale RUNNING BgJob rows from a previous crash before
    // doing anything else. Mirrors ZKTeco recoverStaleClaims. Idempotent + cheap.
    try { await loadLifecycle(); await _recoverStaleBgJobs() } catch (e) { console.error("[jobs] recoverStaleBgJobs failed", e) }
    // SCL-1 — vendors DUE for per-vendor work, in one bounded batched query
    // behind the round-robin cursor (was: the entire active-vendor table on
    // every tick). Login-audit retention moved into dailyJobs (date-guarded
    // there, once per vendor per day — a retention purge has no reason to
    // run every minute).
    const date = today()
    const due = await findDueVendors(date)
    const budgetDeadline = t0 + TICK_BUDGET_MS
    for (const v of due) {
      // Time budget: a tick processing a huge daily backlog stops here and
      // the remainder stays due for the next tick, resuming exactly at this
      // vendor (cursor advances only past PROCESSED vendors). Guarantees
      // tick < TICK_MS at any tenant count with zero skipped vendors.
      if (Date.now() > budgetDeadline) { console.log(`[jobs] tick budget hit after ${tickVendors} vendor(s); ${due.length - tickVendors} remain due`); break }
      try { await dailyJobs(v, date) } catch (e) { console.error(`[jobs] daily jobs failed for vendor ${v}`, e) }
      try { await payrollAutomation(v, date) } catch (e) { console.error(`[jobs] payroll automation failed for vendor ${v}`, e) }
      // Wave 4 WP-A (2026-10-08) — scheduled report email delivery. Date-guarded
      // per template inside maybeRunScheduledReports; every send lands in
      // ReportDeliveryLog with the gateway SENT/FAILED/SKIPPED contract.
      try { await maybeRunScheduledReports(v, date) } catch (e) { console.error(`[jobs] scheduled reports failed for vendor ${v}`, e) }
      // WP-B (CCTV review §3.4) — scheduled camera status refresh: a staggered
      // sweep covering every tenant's enabled cameras, guarded to at most one
      // per vendor per 10 minutes. Runs as a BgJob (WP-A) so the brand-API
      // latency never blocks the scheduler tick.
      try { await scheduleCameraStatusSweep(v) } catch (e) { console.error(`[jobs] camera sweep scheduling failed for vendor ${v}`, e) }
      tickVendors++
      setDueCursor(v)
    }
    // A short page means the due set past the cursor is exhausted — wrap to
    // the head so newly-due vendors (and the next camera-sweep window) are
    // found on the next tick.
    if (due.length < VENDOR_BATCH && tickVendors === due.length) setDueCursor("")
    // 2026-10 round §15/§61 — tracking maintenance on every tick (cheap,
    // idempotent): evidence-based OFFLINE state reconciliation + telemetry
    // retention sweeps (TrackingPoint + expired selfie proofs). Never touches
    // attendance summaries, events, audit or payroll history.
    try {
      const { reconcileOfflineStates, sweepTrackingRetention, sweepProofRetention } = await import("./tracking")
      await reconcileOfflineStates()
      await sweepTrackingRetention()
      await sweepProofRetention()
    } catch (e) { console.error("[jobs] tracking maintenance failed", e) }
    // M-04/M-05 — drain the background job queue on every tick as a backstop
    // (submitJob also kicks an immediate drain for low-latency small jobs)
    try { await drainJobs() } catch (e) { console.error("[jobs] queue drain failed", e) }
    // Wave 4 WP-C (2026-10-08) — outbound webhook deliveries with backoff.
    try { await flushWebhookDeliveries() } catch (e) { console.error("[jobs] webhook flush failed", e) }
    // Wave 11 §4 (2026-10-26) — transactional outbox relay. Order matters:
    //   1. recoverStaleOutbox — reset PROCESSING rows whose claiming relay
    //      died mid-handler (crash recovery, mirrors recoverStaleBgJobs);
    //   2. reconcileSettlements — re-apply subscription terms/upgrades whose
    //      payment committed but whose application was lost to a crash
    //      (idempotent: anchors on the invoice's own period — never doubles);
    //   3. flushOutbox — deliver due events (receipt emails, invoice.paid
    //      webhooks) with exponential backoff + FAILED dead-letter.
    // The settle route also fires an opportunistic flushOutbox() right after
    // commit; this tick pass is the durable backstop for crashed relays.
    try {
      const outbox = await import("./outbox")
      await outbox.recoverStaleOutbox()
      const rec = await outbox.reconcileSettlements()
      if (rec.terms + rec.upgrades > 0) {
        console.log(`[jobs] settlement reconciliation re-applied ${rec.terms} term(s), ${rec.upgrades} upgrade(s) lost to a crash`)
      }
      const { reconcilePendingPayments } = await import("./saas/payments/settle")
      const pendingRec = await reconcilePendingPayments().catch(() => ({ checked: 0, settled: 0 }))
      if (pendingRec.settled > 0) {
        console.log(`[jobs] pending payment reconciliation settled ${pendingRec.settled} payment(s)`)
      }
      const flushed = await outbox.flushOutbox()
      if (flushed.failed > 0) {
        console.warn(`[jobs] outbox relay: ${flushed.done} delivered, ${flushed.retried} retried, ${flushed.failed} DEAD-LETTERED (see OutboxEvent.status=FAILED)`)
      }
    } catch (e) { console.error("[jobs] outbox relay failed", e) }
    // 2026-10-04 — platform-plane daily job (SaaS layer): subscription expiry
    // reminders via the platform gateway. Date-guarded globally (SaaSSetting),
    // each notice deduped per vendor+endDate+days so it fires exactly once.
    // R16 — owner-plane login-audit retention (global rows: fixed 180-day
    // default — owner-console login history is platform metadata)
    try {
      const purged = await db.loginAuditLog.deleteMany({ where: { plane: "OWNER", createdAt: { lt: new Date(Date.now() - 180 * 86400000) } } })
      if (purged.count > 0) console.log(`[jobs] login-audit retention purged ${purged.count} owner-plane row(s)`)
    } catch (e) { console.error("[jobs] owner login-audit retention failed", e) }
    try { await platformDailyJobs(date) } catch (e) { console.error("[jobs] platform daily jobs failed", e) }
    // R11 (2026-10-12) — scheduled campaign dispatch: every tick claims
    // SCHEDULED campaigns whose time has come (guarded updateMany — never a
    // double-send) and delivers them with full per-recipient journaling.
    try {
      const { dispatchDueCampaigns } = await import("./saas/communication")
      const dispatched = await dispatchDueCampaigns()
      if (dispatched > 0) console.log(`[jobs] dispatched ${dispatched} scheduled campaign(s)`)
    } catch (e) { console.error("[jobs] campaign dispatch failed", e) }
    // SCL-21/OPS-9 (Phase 3 WS-B/WS-C) — the nightly in-app backup used to
    // fire ONLY on owner-console traffic (a zero-traffic day skipped it
    // silently). The tick now drives it: maybeRunScheduledBackup is
    // internally guarded (enabled · past scheduleTime · none ran today · none
    // in flight · 60 s throttle · cluster-wide per-day claim) and costs two
    // indexed counts per minute after the schedule time.
    try {
      const { maybeRunScheduledBackup } = await import("./saas/backup")
      const out = await maybeRunScheduledBackup()
      if (out.submitted) console.log(`[jobs] ${out.reason}`)
    } catch (e) { console.error("[jobs] scheduled backup check failed", e) }
    return { vendors: tickVendors, due: due.length, date }
  } finally {
    await releaseLock(tickLock)
    ticking = false
    try { observeTick(Date.now() - t0, tickVendors) } catch { /* never break the tick */ }
  }
}

/** WP-B (CCTV review §3.4) — schedule the camera status sweep for one vendor:
 *  at most one sweep per vendor per 10 minutes; the actual provider calls run
 *  inside a BgJob (CAMERA_STATUS_SWEEP) so a slow brand API never stalls the
 *  scheduler tick. Zero-camera tenants cost one cheap guard read. */
async function scheduleCameraStatusSweep(vendorId: string) {
  const last = await jobState(vendorId, "lastCameraSweep")
  if (last && Date.now() - Date.parse(last) < 10 * 60_000) return
  const count = await db.camera.count({ where: { vendorId, enabled: true } })
  if (!count) return
  await setJobState(vendorId, "lastCameraSweep", new Date().toISOString())
  await submitJob(
    { userId: null, userName: "Scheduler (camera sweep)", vendorId },
    "CAMERA_STATUS_SWEEP",
    {},
    { total: Math.min(count, 25), priority: 7, maxAttempts: 2 },
  )
}

/** Platform-plane daily job — runs at most once per date, globally.
 *  Sends the configured subscription-expiry reminders (communication.notifyOnExpiryDays)
 *  through the platform email gateway, notifying owner users + tenant admins. */

/** SEC-16 (Phase 4 WS-D) — SaaSAuditLog retention sweep. Platform audit rows
 *  (owner actions + a NOTIFICATION_* row for every email ever sent) used to
 *  accumulate forever. Default retention: 730 days (2 years). An EXPLICIT
 *  HRM_SAAS_AUDIT_RETENTION_DAYS=0 disables the sweep — parsed without the
 *  falsy `|| default` trap that would treat "0" as unset and re-enable it.
 *  The per-tenant AuditLog keeps its own 5-year policy (auditRetention.purge);
 *  owner-session purge was SCL-19 (Phase 2). Idempotent; returns rows purged. */
export async function sweepSaasAuditRetention(): Promise<number> {
  const raw = process.env.HRM_SAAS_AUDIT_RETENTION_DAYS
  const days = raw != null && String(raw).trim() !== "" ? Number(raw) : 730
  if (!Number.isFinite(days) || days <= 0) return 0 // disabled (explicit 0 / negative)
  const cutoff = new Date(Date.now() - days * 86400000)
  const out = await db.saasAuditLog.deleteMany({ where: { createdAt: { lt: cutoff } } })
  return out.count
}

/** Phase 4 WS-D — per-tenant usage metering for billing: ONE set-based
 *  INSERT … ON CONFLICT refreshes the CURRENT month's UsageSnapshot for every
 *  vendor at once (fleet-size independent — no per-vendor loop, the exact
 *  anti-pattern the Phase 3 owner-console rewrites removed). The last daily
 *  write of a month is that month's frozen end-of-month record; billing
 *  reconciliation reads the series (owner.usage.history) instead of
 *  re-deriving usage from live tables, which only ever answer "now". */
export async function captureUsageSnapshots(date: string): Promise<number> {
  const periodYear = Number(date.slice(0, 4))
  const periodMonth = Number(date.slice(5, 7))
  if (!periodYear || !periodMonth) return 0
  await db.$executeRaw`
    INSERT INTO "UsageSnapshot"
      ("id", "vendorId", "periodYear", "periodMonth",
       "employeesTotal", "employeesPayroll", "portalUsers", "devicesEnrolled", "storageBytes",
       "capturedAt", "updatedAt")
    SELECT
      md5(random()::text || clock_timestamp()::text || v."id"),
      v."id", ${periodYear}, ${periodMonth},
      COALESCE(et.cnt, 0),
      COALESCE(ep.cnt, 0),
      COALESCE(u.cnt, 0),
      COALESCE(d.cnt, 0),
      COALESCE(r."storageBytes", 0),
      now(), now()
    FROM "Vendor" v
    LEFT JOIN (
      SELECT "vendorId", COUNT(*) AS cnt FROM "Employee" GROUP BY "vendorId"
    ) et ON et."vendorId" = v."id"
    LEFT JOIN (
      SELECT "vendorId", COUNT(*) AS cnt FROM "Employee"
      WHERE status IN ('ACTIVE', 'PROBATION', 'ON_LEAVE', 'SUSPENDED')
      GROUP BY "vendorId"
    ) ep ON ep."vendorId" = v."id"
    LEFT JOIN (
      SELECT "vendorId", COUNT(*) AS cnt FROM "User" WHERE status = 'ACTIVE' GROUP BY "vendorId"
    ) u ON u."vendorId" = v."id"
    LEFT JOIN (
      SELECT "vendorId", COUNT(*) AS cnt FROM "AttendanceDevice" WHERE enabled = true GROUP BY "vendorId"
    ) d ON d."vendorId" = v."id"
    LEFT JOIN "UsageRollup" r ON r."vendorId" = v."id"
    ON CONFLICT ("vendorId", "periodYear", "periodMonth") DO UPDATE SET
      "employeesTotal" = EXCLUDED."employeesTotal",
      "employeesPayroll" = EXCLUDED."employeesPayroll",
      "portalUsers" = EXCLUDED."portalUsers",
      "devicesEnrolled" = EXCLUDED."devicesEnrolled",
      "storageBytes" = EXCLUDED."storageBytes",
      "updatedAt" = now()`
  const count = await db.usageSnapshot.count({ where: { periodYear, periodMonth } })
  return count
}

async function platformDailyJobs(date: string) {
  const { getSaasSettings } = await import("./saas/settings")
  const { db: saasDb } = await import("@/lib/db")
  const { notifySubscriptionExpiry } = await import("./saas/notify")
  // Wave 4 (2026-10-08) — failed-payment dunning pass, same daily guard as
  // the expiry reminders above. Never blocks this job's other steps.
  try { const { maybeRunDunning } = await import("./saas/dunning"); await maybeRunDunning(date) } catch (e) { console.error("[jobs] dunning pass failed", e) }
  const lastRow = await saasDb.saasSetting.findFirst({ where: { group: "jobs", key: "platformDaily" } })
  const last = lastRow ? JSON.parse(lastRow.value) : null
  if (last === date) return
  // ---- Phase 4 WS-D — platform hygiene, once per date ------------------
  // SEC-16 — SaaSAuditLog retention (owner actions + a NOTIFICATION_* row per
  // email ever sent used to accumulate forever, with recipient emails riding
  // in the metadata). The per-tenant AuditLog keeps its own 5-year policy;
  // owner-session purge was SCL-19 (Phase 2).
  try {
    const purged = await sweepSaasAuditRetention()
    if (purged > 0) console.log(`[jobs] saas-audit retention purged ${purged} row(s)`)
  } catch (e) { console.error("[jobs] saas-audit retention failed", e) }
  // ---- Wave 10 (2026-10-24) — Time-Limited Support Access hygiene ----------
  // Transition every stale ACTIVE support session to EXPIRED (audited) so the
  // Owner Console board never shows zombie sessions if an operator just closed
  // the tab (resolveSupportCtx already expires lazily on next use; this is the
  // backstop for sessions never touched again).
  try {
    const { sweepExpiredSupportSessions } = await import("./saas/support-access")
    const swept = await sweepExpiredSupportSessions(100)
    if (swept > 0) console.log(`[jobs] support-access sweep expired ${swept} session(s)`)
  } catch (e) { console.error("[jobs] support-access sweep failed", e) }
  // ---- Wave 10 — OTP housekeeping: consumed/expired verifier rows older than
  // 24h are deleted (the plaintext never existed; this is pure hygiene).
  try {
    const { sweepStaleOtpRows } = await import("./saas/otp")
    const purgedOtp = await sweepStaleOtpRows()
    if (purgedOtp > 0) console.log(`[jobs] otp sweep purged ${purgedOtp} stale row(s)`)
  } catch (e) { console.error("[jobs] otp sweep failed", e) }
  // Per-tenant usage metering for billing — the monthly UsageSnapshot series.
  try { await captureUsageSnapshots(date) } catch (e) { console.error("[jobs] usage snapshot capture failed", e) }
  // ---- Phase 5 P1 — quota threshold alerts --------------------------------
  // One set-based pass: every subscribed tenant at/above the configured
  // utilization threshold fires ONE digest (owner email + the platform alert
  // webhook). Deduped per (vendor, quota, calendar month) in group "jobs" —
  // the renewal-reminder pattern. Best-effort; never blocks the other steps.
  try {
    const { checkQuotaThresholds } = await import("./saas/quotas")
    const quotaResult = await checkQuotaThresholds(date)
    if (quotaResult.freshCrossings > 0) {
      console.log(`[jobs] quota threshold pass: ${quotaResult.freshCrossings} crossing(s) at >= ${quotaResult.thresholdPercent}% (webhook ${quotaResult.webhook?.status || "n/a"})`)
    }
  } catch (e) { console.error("[jobs] quota threshold pass failed", e) }
  const settings = await getSaasSettings()
  const reminderDays = (settings.communication.notifyOnExpiryDays || []).filter((d) => Number.isFinite(d) && d >= 0)
  const subs = await saasDb.saasSubscription.findMany({
    where: { status: { in: ["TRIAL", "ACTIVE", "PAST_DUE", "GRACE_PERIOD"] } },
    include: { vendor: { select: { id: true, name: true } } },
  })
  const admins = await saasDb.user.findMany({
    where: { vendorId: { in: subs.map((s: any) => s.vendorId) }, role: "VENDOR_OWNER", status: "ACTIVE" },
    select: { vendorId: true, email: true },
  })
  const adminOf = new Map<string, string>()
  for (const a of admins) if (!adminOf.has(a.vendorId)) adminOf.set(a.vendorId, a.email)
  const now = Date.now()
  for (const sub of subs as any[]) {
    const daysRemaining = Math.ceil((sub.endDate.getTime() - now) / 86400000)
    if (!reminderDays.includes(daysRemaining)) continue
    // dedupe key: vendor + endDate + daysRemaining (a notice fires once ever;
    // re-noticing only happens for a genuinely different end date)
    const key = `expiry-notice:${sub.vendorId}:${sub.endDate.toISOString().slice(0, 10)}:${daysRemaining}`
    const seen = await saasDb.saasSetting.findFirst({ where: { group: "jobs", key } })
    if (seen) continue
    await notifySubscriptionExpiry({
      vendorId: sub.vendorId, vendorName: sub.vendor.name, planName: sub.planName,
      daysRemaining, endDate: sub.endDate, adminEmail: adminOf.get(sub.vendorId) || null,
    })
    await saasDb.saasSetting.upsert({
      where: { group_key: { group: "jobs", key } },
      create: { group: "jobs", key, value: JSON.stringify(date) },
      update: { value: JSON.stringify(date) },
    })
  }
  // MOD-5 / SCL-6 prerequisite (Phase 2 WS6) — nightly storage-rollup
  // reconciliation: ONE set-based statement recomputes every vendor's true
  // inline byte total and corrects the rollup rows (self-healing for any
  // missed or double-counted incremental bump; upload authorization reads
  // the rollup instead of scanning stored bytes).
  try {
    const { reconcileStorageRollups } = await import("./saas/entitlements")
    const corrected = await reconcileStorageRollups()
    if (corrected > 0) console.log(`[jobs] storage rollup reconciled (${corrected} vendor row(s) corrected)`)
  } catch (e) { console.error("[jobs] storage rollup reconciliation failed", e) }

  // SCL-19 (Phase 2 WS5) — expired-session purge. Session rows were NEVER
  // deleted (only overwritten logins cascade-delete them): expired FULL and
  // PREAUTH sessions accumulated forever, one fleet-wide deleteMany per day
  // now trims them (needs the expiresAt indexes from migration 9_wave9zg;
  // the per-user cascade still applies for deleted users at any time).
  try {
    const now = new Date()
    const purgedSessions = await saasDb.session.deleteMany({ where: { expiresAt: { lt: now } } })
    const purgedOwner = await saasDb.saasOwnerSession.deleteMany({ where: { expiresAt: { lt: now } } })
    if (purgedSessions.count > 0 || purgedOwner.count > 0) {
      console.log(`[jobs] session purge removed ${purgedSessions.count} expired session(s) + ${purgedOwner.count} owner session(s)`)
    }
  } catch (e) { console.error("[jobs] session purge failed", e) }

  // Wave 2 WP-J (2026-10-08) — automated subscription lifecycle sweep:
  // ACTIVE+endDate passing → PAST_DUE; gracePeriod end → EXPIRED; trial end →
  // ACTIVE (paid plan attached) or EXPIRED. Every transition writes a
  // SaasSubscriptionEvent + SaasAuditLog + invalidates entitlements. The
  // renewal reminder emails (30/15/7/3/1 days) are sent by the same sweep.
  try {
    const { subscriptionLifecycleSweep } = await import("./saas/lifecycle-sweep")
    await subscriptionLifecycleSweep()
  } catch (e) { console.error("[jobs] subscription lifecycle sweep failed", e) }

  // OPS-5 (Phase 3 WS-E) — webhook backlog age ceiling: PENDING deliveries
  // older than HRM_WEBHOOK_BACKLOG_DAYS (default 7) are dead-lettered once a
  // day so an unreachable endpoint cannot pin an unbounded queue.
  try {
    const { deadLetterStaleDeliveries } = await import("./webhooks")
    const deadLettered = await deadLetterStaleDeliveries()
    if (deadLettered > 0) console.log(`[jobs] webhook backlog sweep dead-lettered ${deadLettered} stale delivery row(s)`)
  } catch (e) { console.error("[jobs] webhook dead-letter sweep failed", e) }

  await saasDb.saasSetting.upsert({
    where: { group_key: { group: "jobs", key: "platformDaily" } },
    create: { group: "jobs", key: "platformDaily", value: JSON.stringify(date) },
    update: { value: JSON.stringify(date) },
  })
}

/** HIGH-4 — exposed for graceful shutdown. If a drain is in flight, await it;
 *  otherwise return immediately. The lifecycle.ts gracefulShutdown() uses this
 *  to wait for in-flight BgJob runners to finish before process exit. */
export async function awaitDrain(): Promise<void> {
  if (currentDrain) await currentDrain
}

async function jobState(vendorId: string, key: string): Promise<string | null> {
  const row = await db.hrSetting.findFirst({ where: { vendorId, group: "jobs", key } })
  return row ? JSON.parse(row.value) : null
}
async function setJobState(vendorId: string, key: string, value: string) {
  await saveSettingsGroup(vendorId, "jobs", { [key]: value })
}

/** Date-guarded daily jobs — each runs at most once per vendor per date. */
async function dailyJobs(vendorId: string, date: string) {
  const settings = await getSettings(vendorId)
  const last = await jobState(vendorId, "lastDailyDate")
  if (last === date) return

  // R16 (2026-10-12) — login-audit retention, folded into the daily pass
  // (SCL-1: it used to run for EVERY vendor on EVERY tick; a retention purge
  // is a natural once-a-day job — 180-day default window, idempotent).
  try {
    const { sweepLoginAuditRetentionFor } = await import("./login-audit")
    const purged = await sweepLoginAuditRetentionFor(vendorId, settings.loginAudit?.retentionDays ?? 180)
    if (purged > 0) console.log(`[jobs] login-audit retention purged ${purged} row(s) for vendor ${vendorId}`)
  } catch (e) { console.error(`[jobs] login-audit retention failed for vendor ${vendorId}`, e) }

  // 1) Birthday & joining-anniversary wishes (spec §12.2)
  await deliverWishes(vendorId, date)

  // 1b) M-13 — audit-log retention purge: entries older than 5 years are
  // deleted once per day (Bangladesh labour-law record horizon; the policy
  // is surfaced in the Audit view's retention card).
  await auditRetention(vendorId)

  // 2) Attendance alert for yesterday (spec §12.3) — extracted (ATT-006)
  // into the exported sweepAttendanceAlerts below (unit-testable).
  await sweepAttendanceAlerts(vendorId, date, settings)

  // 2c-bis) LOA-001 (R3-4) — see loanOverdueSweep (exported below).
  await loanOverdueSweep(vendorId, date)

  // 2c-ter) WF-001 (R3-4) — see approvalReminderSweep (exported below).
  await approvalReminderSweep(vendorId, date, settings)

  // 2c-ter-bis) LVE-112 (R7) — leave SLA nudges + auto-cancel mode (exported below).
  await leaveSlaSweep(vendorId, date, settings).catch(() => {})

  // 2c-ter-tris) EMP-08 (R7) — probation end-of-period reminders (exported below).
  await probationSweep(vendorId, date).catch(() => {})

  // 2c-quater) COM-04 (R6) + DB-06 (R6) — retention sweeps (exported above).
  await notificationRetentionSweep(vendorId, date, settings).catch(() => {})
  await apiRefreshTokenPurge(vendorId).catch(() => {})

  // 2b) HRM-008 — weekly late-comers report (Mondays: previous week's LATE days emailed to HR_MANAGER)
  {
    const wd = ["SUNDAY", "MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY"]
    const dow = wd[new Date(`${date}T00:00:00Z`).getUTCDay()]
    if (dow === "MONDAY") {
      const guard = await jobState(vendorId, "lastLateReport")
      const weekTag = addDays(date, -1).slice(0, 10)
      if (guard !== weekTag) {
        const from = addDays(date, -7), to = addDays(date, -1)
        const lates = await db.attendance.findMany({
          where: { vendorId, date: { gte: from, lte: to }, status: "LATE" },
          orderBy: { date: "asc" },
        })
        if (lates.length) {
          const counts = new Map<string, number>()
          const emps = await db.employee.findMany({ where: { vendorId }, select: { id: true, fullName: true } })
          const nameById = new Map(emps.map((e) => [e.id, e.fullName]))
          for (const l of lates) counts.set(l.employeeId, (counts.get(l.employeeId) || 0) + 1)
          const lines = [...counts.entries()]
            .map(([id, n]) => `${nameById.get(id) || id}: ${n} late day(s)`)
            .sort((a, b) => Number(b.split(": ")[1]) - Number(a.split(": ")[1]))
            .slice(0, 15)
          const summary = `Late-comers report ${from} → ${to}: ${lates.length} late day(s) across ${counts.size} employee(s).\n${lines.join("\n")}`
          await notify(vendorId, { role: "HR_MANAGER" }, "Weekly Late-Comers Report", summary, "ATTENDANCE", "attendance")
          await notify(vendorId, { role: "HR_ADMIN" }, "Weekly Late-Comers Report", summary, "ATTENDANCE", "attendance")
          const { sendEmail } = await import("./gateway")
          const hrs = await db.user.findMany({ where: { vendorId, role: { in: ["HR_ADMIN", "HR_MANAGER"] }, status: "ACTIVE" } })
          for (const u of hrs) {
            if (u.email) { const em = u.email; await sendLogged(vendorId, "EMAIL", "Weekly Late-Comers Report", () => sendEmail(vendorId, em, "Weekly Late-Comers Report", summary)) }
          }
        }
        await setJobState(vendorId, "lastLateReport", weekTag)
      }
    }
  }

  // 3) Document expiry reminders (spec §16.5 / §12.3) — once per document.
  // D1 — per-document-type lead days from Settings → Notifications matrix
  // (falls back to the global documentExpiryDays for unmapped types).
  const expiryMatrix: { type: string; leadDays: number }[] = settings.documentExpiry?.types?.length
    ? settings.documentExpiry.types
    : [{ type: "*", leadDays: settings.notification.documentExpiryDays }]
  const maxLead = Math.max(...expiryMatrix.map((t) => t.leadDays || 0), 0)
  const horizon = addDays(date, maxLead)
  const expiring = await db.employeeDocument.findMany({
    where: { vendorId, expiryDate: { not: null, gte: date, lte: horizon } },
  })
  // SCL-14 — the expiring-window dedupe + contact lookups used to be 2–3
  // queries PER DOCUMENT (whole-roster name load, notification.findFirst,
  // employee.findFirst for contacts). All batched into 3 queries total for
  // the window, regardless of how many documents are expiring.
  const empIds = [...new Set(expiring.map((d) => d.employeeId))]
  const empRows = empIds.length
    ? await db.employee.findMany({ where: { vendorId, id: { in: empIds } }, select: { id: true, fullName: true } })
    : []
  const nameById = new Map(empRows.map((e) => [e.id, e.fullName]))
  const expiringLinks = expiring.map((d) => `doc:${d.id}`)
  const alreadyRows = expiringLinks.length
    ? await db.notification.findMany({ where: { vendorId, type: "DOC_EXPIRY", link: { in: expiringLinks } }, select: { link: true } })
    : []
  const alreadyLinks = new Set(alreadyRows.map((r) => r.link))
  // D1/HRM-021 — per-matrix channels are identical for every document here
  // (same event key), so hoist the resolution + the one batched contact read.
  const ch = eventChannels(settings, "document_expiry", {})
  const contactIds = (ch.email || ch.sms) && empIds.length ? empIds : []
  const contactRows = contactIds.length
    ? await db.employee.findMany({ where: { vendorId, id: { in: contactIds } }, select: { id: true, officialEmail: true, personalEmail: true, mobile: true } })
    : []
  const contactById = new Map(contactRows.map((e) => [e.id, e]))
  for (const d of expiring) {
    const leadDays = expiryMatrix.find((t) => t.type === d.docType || t.type === "*")?.leadDays ?? settings.notification.documentExpiryDays
    if (leadDays <= 0) continue
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- audited TODO(H-20 paydown): convert to an explicit null check
    if (d.expiryDate! > addDays(date, leadDays)) continue // outside this type's window
    const linkKey = `doc:${d.id}`
    if (alreadyLinks.has(linkKey)) continue
    const name = nameById.get(d.employeeId) || "Employee"
    await notify(vendorId, { role: "HR_ADMIN" }, "Document Expiry Reminder",
      `${name}'s ${d.docType} "${d.title}" expires on ${d.expiryDate}.`, "DOC_EXPIRY", linkKey)
    await notify(vendorId, { employeeId: d.employeeId }, "Your Document Expires Soon",
      `Your ${d.docType} "${d.title}" expires on ${d.expiryDate}. Please arrange renewal.`, "DOC_EXPIRY", "ess")
    // D1/HRM-021 — optional email/SMS to the employee per the matrix
    if (ch.email || ch.sms) {
      const { sendEmail, sendSms } = await import("./gateway")
      // 2026-10 restructure — render from the document_expiry system template
      const { effectiveMessageTemplate, renderMessageTemplate } = await import("./message-templates")
      const tpl = effectiveMessageTemplate((settings as any).messageTemplates, "document_expiry")
      const dvars = { company: settings.general.companyName, date, employee: name, docType: d.docType, docTitle: d.title, expiryDate: d.expiryDate || "" }
      const subject = renderMessageTemplate(tpl?.emailSubject || "", dvars) || "Document Expiry Reminder"
      const text = renderMessageTemplate(tpl?.smsBody || tpl?.emailBody || "", dvars) || `Your ${d.docType} "${d.title}" expires on ${d.expiryDate}.`
      const emp = contactById.get(d.employeeId)
      if (emp) {
        if (ch.email && (emp.officialEmail || emp.personalEmail)) { const em = (emp.officialEmail || emp.personalEmail) as string; await sendLogged(vendorId, "EMAIL", "Document Expiry Reminder", () => sendEmail(vendorId, em, subject, text)) }
        if (ch.sms && emp.mobile) { const ph = emp.mobile; await sendLogged(vendorId, "SMS", "Document Expiry Reminder", () => sendSms(vendorId, ph, text.slice(0, 300))) }
      }
    }
  }

  // 4) HRM-011 — year-end leave carry-forward rollover (fiscal-year boundary)
  await leaveRollover(vendorId, date, settings)

  // 5) HRM-018 — access/status closure on exit day: disable user account, revoke
  // device enrollment, complete the resignation, notify HR + owner.
  await exitClosures(vendorId, date)

  // 5b) Wave 2 WP-K — asset warranty-expiring reminders (document-expiry job
  // pattern: lead window + one notification per asset, deduped by link key).
  await assetWarrantyReminders(vendorId, date)

  // 5c) Wave 2 WP-M — field-force missed sweep: plan items whose planned
  // window passed without a check-in become MISSED Visit rows (idempotent).
  await fieldforceMissedSweep(vendorId, date)

  await setJobState(vendorId, "lastDailyDate", date)
}

/** ATT-303 (R3-4) — materialize the ABSENT rows every report reads. A no-show
 *  day previously produced NO Attendance row, so the absent report, the monthly
 *  register, the long-absence alert and analytics (all of which count stored
 *  ABSENT rows) reported ≈0 absentees while payroll re-derived absence
 *  independently — two sources of truth. The sweep writes yesterday's missing
 *  days for ACTIVE/PROBATION employees, respecting weekly-offs, holidays
 *  (caller gates on the holiday check), joining date and any existing row
 *  (incl. LEAVE / LEAVE_UNPAID / synthetic punches). A unique-key race with a
 *  concurrent punch lets the punch win. Exported for unit tests. */
/** ATT-006 — the yesterday attendance alert, extracted for testability.
 *  A branch-specific holiday suppresses the alert ONLY for that branch's
 *  employees (the old any-holiday guard silenced the whole tenant). */
export async function sweepAttendanceAlerts(vendorId: string, date: string, settings: any) {
    const yesterday = addDays(date, -1)
    // SCL-14 — slim projections + Set lookup: the alert used to load FULL
    // employee rows (every column, photos included) and FULL attendance
    // rows for the whole tenant-day, then did recs.find() per employee
    // (O(N×M)). At 10K employees that was megabytes per vendor per day.
    const emps = await db.employee.findMany({
      where: { vendorId, status: { in: ["ACTIVE", "PROBATION"] } },
      select: { id: true, fullName: true, joiningDate: true, weeklyOff: true, shiftId: true, branchId: true },
    })
    const recs = await db.attendance.findMany({
      where: { vendorId, date: yesterday },
      select: { employeeId: true, status: true },
    })
    const recByEmp = new Map(recs.map((r) => [r.employeeId, r]))
    const holidays = await db.holiday.findMany({ where: { vendorId, date: yesterday } })
    // ATT-006 — a holiday only suppresses the alert for the branches it
    // covers: branch-specific holidays (branchId set) must NOT silence the
    // alert for every other branch (branchId null = tenant-wide).
    const holidayApplies = (e: { branchId: string | null }) =>
      holidays.some((h) => !h.branchId || h.branchId === e.branchId)
    // ATT-006 — the sweep ALWAYS evaluates per employee now: a tenant-wide
    // holiday skips everyone via holidayApplies, while a branch-specific
    // holiday skips only that branch (the old `if (!holidays.length)` outer
    // guard let ONE branch's holiday silence the whole tenant's alert).
    {
      const wd = ["SUNDAY", "MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY"]
      const dow = wd[new Date(`${yesterday}T00:00:00Z`).getUTCDay()]
      // 2026-10-13 — canonical weekly-off precedence (employee > shift > global
      // policy): one batched shift lookup instead of the old employee-only rule
      const shiftRows = await db.shift.findMany({ where: { vendorId }, select: { id: true, weeklyOff: true } })
      const shiftOffById = new Map(shiftRows.map((s) => [s.id, s.weeklyOff]))
      const missing: string[] = []
      const late: string[] = []
      for (const e of emps) {
        const weeklyOff = resolveWeeklyOffDays(e.weeklyOff, e.shiftId ? shiftOffById.get(e.shiftId) : null, settings.general.weeklyHoliday)
        if (weeklyOff.includes(dow)) continue
        if (holidayApplies(e)) continue // ATT-006 — only the covered branches skip
        const rec = recByEmp.get(e.id)
        if (!rec || rec.status === "ABSENT") missing.push(e.fullName)
        else if (rec.status === "LATE") late.push(e.fullName)
      }
      if (missing.length || late.length) {
        const parts: string[] = []
        if (missing.length) parts.push(`${missing.length} employee(s) with missing attendance: ${missing.slice(0, 5).join(", ")}${missing.length > 5 ? "…" : ""}`)
        if (late.length) parts.push(`${late.length} late arrival(s): ${late.slice(0, 5).join(", ")}${late.length > 5 ? "…" : ""}`)
        // HRM-021 — attendance_alert matrix row decides the email/SMS channels
        const ch = eventChannels(settings, "attendance_alert", { email: true, sms: settings.notification.attendanceAlertSms })
        if (ch.inApp) {
          await notify(vendorId, { role: "HR_ADMIN" }, "Attendance Alert",
            `Yesterday (${yesterday}): ${parts.join(" · ")}.`, "ATTENDANCE", "attendance")
        }
        if (ch.email || ch.sms) {
          const { sendEmail, sendSms } = await import("./gateway")
          // 2026-10 restructure — render from the attendance_alert system
          // template (tenant-editable in HR Settings → Templates)
          const { effectiveMessageTemplate, renderMessageTemplate } = await import("./message-templates")
          const tpl = effectiveMessageTemplate((settings as any).messageTemplates, "attendance_alert")
          const avars = { company: settings.general.companyName, date: yesterday, missing: missing.length, late: late.length, summary: parts.join(" · ") }
          const subject = renderMessageTemplate(tpl?.emailSubject || "", avars) || "Attendance Alert"
          const text = renderMessageTemplate(tpl?.smsBody || tpl?.emailBody || "", avars) || `HRM Attendance Alert ${yesterday}: ${parts.join(" · ")}`.slice(0, 300)
          const hrUsers = await db.user.findMany({ where: { vendorId, role: { in: ["HR_ADMIN", "HR_MANAGER"] }, status: "ACTIVE" } })
          for (const u of hrUsers) {
            if (ch.email && u.email) { const em = u.email; await sendLogged(vendorId, "EMAIL", "Attendance Alert", () => sendEmail(vendorId, em, subject, text)) }
            if (ch.sms && u.phone) { const ph = u.phone; await sendLogged(vendorId, "SMS", "Attendance Alert", () => sendSms(vendorId, ph, text.slice(0, 300))) }
          }
        }
      }

      // ATT-303 (R3-4) — materialize the ABSENT rows every report reads
      // (see materializeAbsentDay — exported + unit-testable below).
      await materializeAbsentDay(vendorId, yesterday, settings, { emps, recs: recs.map((r) => ({ employeeId: r.employeeId })), shiftOffById, dow })
    }
}


export async function materializeAbsentDay(
  vendorId: string,
  yesterday: string,
  settings: any,
  preloaded?: {
    emps?: { id: string; fullName?: string; joiningDate?: string | null; weeklyOff?: string | null; shiftId?: string | null }[]
    recs?: { employeeId: string }[]
    shiftOffById?: Map<string, string | null>
    dow?: string
  },
): Promise<number> {
  // SCL-14 — slim projections on the default path too (full employee rows
  // with photos used to be loaded just to read four columns).
  const emps = preloaded?.emps
    ?? await db.employee.findMany({
      where: { vendorId, status: { in: ["ACTIVE", "PROBATION"] } },
      select: { id: true, joiningDate: true, weeklyOff: true, shiftId: true },
    })
  const recs = preloaded?.recs ?? await db.attendance.findMany({ where: { vendorId, date: yesterday }, select: { employeeId: true } })
  const shiftOffById = preloaded?.shiftOffById
    ?? new Map((await db.shift.findMany({ where: { vendorId }, select: { id: true, weeklyOff: true } })).map((s) => [s.id, s.weeklyOff]))
  const dow = preloaded?.dow
    ?? ["SUNDAY", "MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY"][new Date(`${yesterday}T00:00:00Z`).getUTCDay()]
  const recEmpIds = new Set(recs.map((r) => r.employeeId))
  // SCL-14 — one createMany (skipDuplicates swallows the unique-key race with
  // a concurrent punch exactly like the old per-row .catch) instead of one
  // INSERT per employee.
  const absent: { vendorId: string; employeeId: string; date: string; status: string; source: string; remarks: string }[] = []
  for (const e of emps) {
    const weeklyOff = resolveWeeklyOffDays(e.weeklyOff, e.shiftId ? shiftOffById.get(e.shiftId) : null, settings.general.weeklyHoliday)
    if (weeklyOff.includes(dow)) continue
    if (recEmpIds.has(e.id)) continue
    if (e.joiningDate && e.joiningDate > yesterday) continue
    absent.push({
      vendorId, employeeId: e.id, date: yesterday, status: "ABSENT", source: "MANUAL",
      remarks: "Auto-marked absent by the daily sweep — no attendance record (ATT-303)",
    })
  }
  let materialized = 0
  if (absent.length) {
    // Chunked (Prisma's own batch limit is 32,762 params — chunk keeps the
    // parameter count flat for arbitrarily large workforces) — same counting
    // semantics as before (attempted creates, races lose silently).
    for (let i = 0; i < absent.length; i += 1000) {
      const chunk = absent.slice(i, i + 1000)
      await db.attendance.createMany({ data: chunk, skipDuplicates: true }).catch(() => { /* unique-key race with a concurrent punch — the punch wins */ })
      materialized += chunk.length
    }
  }
  if (materialized > 0) {
    await notify(vendorId, { role: "HR_ADMIN" }, "Attendance Auto-Marked Absent",
      `${materialized} employee(s) had no attendance record for ${yesterday} and were auto-marked ABSENT (device punches and approved leave are unaffected).`, "ATTENDANCE", "attendance")
  }
  return materialized
}

/** COM-04 (R6) — notification retention sweep: rows older than
 *  settings.notifications.retentionDays (0 = keep forever) are purged once a
 *  day, per vendor. The table previously grew without bound; the unread badge
 *  separately stops at the capped list's size (communication.ts). */
export async function notificationRetentionSweep(vendorId: string, date: string, settings: any): Promise<number> {
  const days = Math.max(0, Number(settings?.notifications?.retentionDays ?? 90))
  if (days <= 0) return 0
  const cutoff = new Date(new Date(`${date}T00:00:00Z`).getTime() - days * 86_400_000)
  const purged = await db.notification.deleteMany({ where: { vendorId, createdAt: { lt: cutoff } } }).catch(() => null)
  const count = purged ? purged.count : 0
  if (count > 0) console.log(`[jobs] notification retention purged ${count} row(s) for vendor ${vendorId}`)
  return count
}

/** DB-06 (R6) — refresh-token retention sweep: expired and rotated-away
 *  tokens older than 30 days are purged (was: never — the table grew
 *  forever; the expiresAt index ships with migration 9_wave9zn). */
export async function apiRefreshTokenPurge(vendorId: string): Promise<number> {
  const now = new Date()
  const revokedCutoff = new Date(now.getTime() - 30 * 86_400_000)
  const purged = await db.apiRefreshToken.deleteMany({
    where: { vendorId, OR: [{ expiresAt: { lt: now } }, { revokedAt: { lt: revokedCutoff } }] },
  }).catch(() => null)
  const count = purged ? purged.count : 0
  if (count > 0) console.log(`[jobs] api refresh-token retention purged ${count} row(s) for vendor ${vendorId}`)
  return count
}

/** LVE-112 (R7) — leave approval SLA + auto-cancel mode.
 *  1) SLA (settings.leave.approvalSlaDays, 0 = off): pending leave requests
 *     older than the SLA get a daily nudge to HR (digest) and the requester.
 *  2) Auto-cancel (settings.leave.autoCancelPendingDays, 0 = off): pending
 *     leave requests older than the window are CANCELLED by the system —
 *     the reserved balance is released with the same guarded decrement the
 *     manual cancel path uses, and the still-PENDING approval request is
 *     cancelled so it stops appearing in queues. Exported for unit tests. */
export async function leaveSlaSweep(vendorId: string, _date: string, settings: any): Promise<{ nudged: number; cancelled: number }> {
  const slaDays = Math.max(0, Number(settings?.leave?.approvalSlaDays) || 0)
  const cancelDays = Math.max(0, Number(settings?.leave?.autoCancelPendingDays) || 0)
  if (slaDays <= 0 && cancelDays <= 0) return { nudged: 0, cancelled: 0 }

  const pending = await db.leaveRequest.findMany({
    where: { vendorId, status: "PENDING", approvalRequestId: { not: null } },
    orderBy: { createdAt: "asc" },
    select: { id: true, employeeId: true, leaveTypeId: true, fromDate: true, toDate: true, days: true, createdAt: true, approvalRequestId: true },
    take: 300,
  }).catch(() => [])
  if (!pending.length) return { nudged: 0, cancelled: 0 }

  const ageOf = (r: { createdAt: Date }) => Math.floor((Date.now() - new Date(r.createdAt).getTime()) / 86_400_000)
  const { leaveYearOf } = await import("./leave-math")
  const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"]
  const fy = Math.max(0, months.indexOf(settings?.general?.fiscalYearStart || "July"))

  // 1) SLA nudges — daily digest to HR + the requester
  let nudged = 0
  if (slaDays > 0) {
    const stale = pending.filter((r) => ageOf(r) >= slaDays)
    if (stale.length) {
      const empIds = [...new Set(stale.map((r) => r.employeeId))]
      const emps = await db.employee.findMany({ where: { vendorId, id: { in: empIds } }, select: { id: true, fullName: true } })
      const nameOf = new Map(emps.map((e) => [e.id, e.fullName]))
      await notify(vendorId, { role: "HR_ADMIN" }, "Leave Requests Past SLA",
        `${stale.length} leave request(s) have been pending for more than ${slaDays} day(s) (oldest ${ageOf(stale[0])} day(s)). Approve or reject them from the Leave view.`, "LEAVE", "approvals")
      for (const r of stale.slice(0, 50)) {
        await notify(vendorId, { employeeId: r.employeeId }, "Leave Request Still Pending",
          `Your leave request (${r.fromDate} → ${r.toDate}) has been pending for ${ageOf(r)} day(s). We are following up with your approver.`, "LEAVE", "ess")
      }
      nudged = stale.length
      void nameOf
    }
  }

  // 2) Auto-cancel — system action with the manual path's guarded restores
  let cancelled = 0
  if (cancelDays > 0) {
    const overdue = pending.filter((r) => ageOf(r) >= cancelDays)
    for (const r of overdue) {
      // conditional claim — an approver deciding at the same instant wins
      const claimed = await db.leaveRequest.updateMany({
        where: { id: r.id, status: "PENDING" },
        data: { status: "CANCELLED", actedBy: "system:sla-sweep", actedAt: new Date() },
      }).catch(() => ({ count: 0 }))
      if (claimed.count !== 1) continue
      const year = leaveYearOf(r.fromDate, fy)
      const bal = await db.leaveBalance.findFirst({ where: { employeeId: r.employeeId, leaveTypeId: r.leaveTypeId, year } }).catch(() => null)
      if (bal) {
        const back = await db.leaveBalance.updateMany({
          where: { id: bal.id, pending: { gte: r.days } },
          data: { pending: { decrement: r.days } },
        }).catch(() => ({ count: 0 }))
        if (back.count !== 1) {
          await db.leaveBalance.update({ where: { id: bal.id }, data: { pending: 0 } }).catch(() => {})
        }
      }
      if (r.approvalRequestId) {
        await db.approvalRequest.updateMany({ where: { id: r.approvalRequestId, status: "PENDING" }, data: { status: "CANCELLED" } }).catch(() => {})
      }
      await notify(vendorId, { employeeId: r.employeeId }, "Leave Request Auto-Cancelled",
        `Your leave request (${r.fromDate} → ${r.toDate}) was cancelled automatically after resting pending for more than ${cancelDays} day(s). The reserved balance has been released — re-apply if still needed.`, "LEAVE", "ess")
      cancelled++
    }
    if (cancelled > 0) {
      await notify(vendorId, { role: "HR_ADMIN" }, "Leave Requests Auto-Cancelled",
        `${cancelled} pending leave request(s) resting beyond ${cancelDays} day(s) were auto-cancelled (reserved balance released).`, "LEAVE", "leave")
    }
  }
  return { nudged, cancelled }
}

/** EMP-08 (R7) — probation end-of-period reminders. Employees still on
 *  PROBATION whose calendar-month probation end is exactly 7 days away (heads
 *  up) or today (due) notify HR once — the exact-day match makes a dedup key
 *  unnecessary (the condition is true on a single date per employee). No
 *  automatic status flip: confirmation stays a human decision
 *  (employees.probation CONFIRM/EXTEND). Exported for unit tests. */
export async function probationSweep(vendorId: string, date: string): Promise<number> {
  const { probationEndDate } = await import("./utils")
  const { daysBetween } = await import("./utils")
  const onProbation = await db.employee.findMany({
    where: { vendorId, status: "PROBATION", joiningDate: { not: null } },
    select: { id: true, fullName: true, code: true, joiningDate: true, probationMonths: true, confirmationDate: true },
    take: 500,
  }).catch(() => [])
  let notified = 0
  for (const e of onProbation) {
    const end = probationEndDate(e.joiningDate, e.probationMonths, e.confirmationDate)
    if (!end) continue
    const days = daysBetween(date, end)
    if (days === 7) {
      await notify(vendorId, { role: "HR_ADMIN" }, "Probation Ends in 7 Days",
        `${e.fullName}${e.code ? ` (${e.code})` : ""} completes their ${e.probationMonths}-month probation on ${end}. Confirm or extend from the employee profile → Lifecycle.`, "SYSTEM", "employees")
      notified++
    } else if (days === 0) {
      await notify(vendorId, { role: "HR_ADMIN" }, "Probation Ends Today",
        `${e.fullName}${e.code ? ` (${e.code})` : ""} reaches their probation end date today (${end}). Confirm or extend from the employee profile → Lifecycle.`, "SYSTEM", "employees")
      notified++
    }
  }
  return notified
}

/** LOA-001 (R3-4) — loan-overdue sweep: past-due unpaid PENDING installments
 *  are marked OVERDUE and HR gets one digest per run. The status was read in
 *  five places but nothing ever wrote it; nextDue and the aging signal now
 *  match reality. (PARTIAL rows keep their stronger signal; the arrears
 *  budgeting in calculateRun picks both up.) Exported for unit tests. */
export async function loanOverdueSweep(vendorId: string, date: string): Promise<number> {
  const activeLoans = await db.loan.findMany({ where: { vendorId, status: "ACTIVE" }, select: { id: true, employeeId: true } }).catch(() => [] as { id: string; employeeId: string }[])
  const overdue = activeLoans.length
    ? await db.loanInstallment.findMany({
        where: { loanId: { in: activeLoans.map((l) => l.id) }, status: "PENDING", dueDate: { lt: date } },
        orderBy: { dueDate: "asc" },
        take: 500,
      }).catch(() => [])
    : []
  if (!overdue.length) return 0
  let marked = 0
  for (const i of overdue) {
    const r = await db.loanInstallment.updateMany({
      where: { id: i.id, status: "PENDING", paidAmount: { lt: i.amount } },
      data: { status: "OVERDUE" },
    }).catch(() => ({ count: 0 }))
    marked += r.count
  }
  if (marked > 0) {
    const borrowers = new Set(activeLoans.filter((l) => overdue.some((i) => i.loanId === l.id)).map((l) => l.employeeId))
    await notify(vendorId, { role: "HR_ADMIN" }, "Loan Installments Overdue",
      `${marked} loan installment(s) across ${borrowers.size} borrower(s) are past due and were marked OVERDUE — the next payroll run budgets them as arrears (Settings → Payroll → loan arrears max).`, "LOAN", "loans")
  }
  return marked
}

/** WF-001 (R3-4) — pending-approval reminder sweep: requests resting longer
 *  than settings.approvals.reminderDays (0 = off) nudge the HR admins once
 *  per day; resting twice as long escalates to the tenant owner as well.
 *  Marketing promised "auto-escalation via substitutes" — this is the engine
 *  catching up with a daily digest (per-request spam would be worse than the
 *  stall it fixes). Exported for unit tests. */
export async function approvalReminderSweep(vendorId: string, date: string, settings: any): Promise<number> {
  const reminderDays = Math.max(0, Number((settings as any).approvals?.reminderDays) || 0)
  if (reminderDays <= 0) return 0
  const cutoff = addDays(date, -reminderDays)
  const resting = await db.approvalRequest.findMany({
    where: { vendorId, status: "PENDING", createdAt: { lt: new Date(`${cutoff}T00:00:00Z`) } },
    orderBy: { createdAt: "asc" },
    select: { id: true, processType: true, entityRef: true, createdAt: true, currentStep: true },
    take: 200,
  }).catch(() => [])
  if (!resting.length) return 0
  const escalatedAt = addDays(date, -(reminderDays * 2))
  const escCount = resting.filter((r) => new Date(r.createdAt) < new Date(`${escalatedAt}T00:00:00Z`)).length
  const oldest = resting[0]
  const ageDays = Math.max(1, Math.round((Date.now() - new Date(oldest.createdAt).getTime()) / 86_400_000))
  const sample = resting.slice(0, 5).map((r) => `${r.processType}: ${r.entityRef || r.id.slice(0, 8)}`).join("; ")
  await notify(vendorId, { role: "HR_ADMIN" }, "Approvals Resting — Reminder",
    `${resting.length} approval request(s) have been pending for more than ${reminderDays} day(s) (oldest ${ageDays} day(s)): ${sample}${resting.length > 5 ? ` (+${resting.length - 5} more)` : ""}. Approve or reject them from the Approvals view.`, "APPROVAL", "approvals")
  if (escCount > 0) {
    await notify(vendorId, { role: "VENDOR_OWNER" }, "Approvals Stalled — Escalation",
      `${escCount} approval request(s) have been pending for more than ${reminderDays * 2} day(s) — HR has been reminded daily. Owner-level attention may be needed (delegation or substitute setup).`, "APPROVAL", "approvals")
  }
  return resting.length
}

/** WP-K — notify HR once per asset approaching warranty expiry (30-day lead,
 *  deduped by the notification link key, exactly like document expiry). */
async function assetWarrantyReminders(vendorId: string, date: string) {
  const horizon = addDays(date, 30)
  const assets = await db.asset.findMany({
    where: { vendorId, warrantyExpiry: { not: null, gte: date, lte: horizon }, status: { notIn: ["RETIRED", "LOST"] } },
    select: { id: true, code: true, name: true, warrantyExpiry: true },
  }).catch(() => [])
  if (!assets.length) return
  // SCL-14 — batched dedupe check (was: notification.findFirst per asset).
  const links = assets.map((a) => `asset-warranty:${a.id}`)
  const alreadyRows = await db.notification.findMany({ where: { vendorId, type: "DOC_EXPIRY", link: { in: links } }, select: { link: true } }).catch(() => [] as { link: string }[])
  const alreadyLinks = new Set(alreadyRows.map((r) => r.link))
  for (const a of assets) {
    const linkKey = `asset-warranty:${a.id}`
    if (alreadyLinks.has(linkKey)) continue
    await notify(vendorId, { role: "HR_ADMIN" }, "Asset Warranty Expiring",
      `Asset ${a.code} — ${a.name} warranty expires on ${a.warrantyExpiry}. Arrange renewal, extension or replacement.`, "DOC_EXPIRY", linkKey)
  }
}

/** WP-M — mark past-window plan items without a check-in as MISSED Visit rows.
 *  Idempotent: an existing Visit for the plan item (any status) means the
 *  item was handled; only untouched items materialize a MISSED row.
 *  SCL-14 — the sweep used to iterate EVERY plan the tenant ever created,
 *  every day, with a findFirst per item: O(all history) per vendor per day,
 *  growing forever. Now a 30-day lookback (the sweep has run daily in
 *  production, so everything older is already swept; 30 days also covers a
 *  month of scheduler downtime) with THREE set-based queries + one
 *  createMany regardless of tenant size. */
async function fieldforceMissedSweep(vendorId: string, date: string) {
  const lookback = addDays(date, -30)
  // plans in the lookback window strictly before today
  const plans = await db.visitPlan.findMany({
    where: { vendorId, date: { gte: lookback, lt: date } },
    select: { id: true, employeeId: true, date: true },
  }).catch(() => [])
  if (!plans.length) return
  const planById = new Map(plans.map((p) => [p.id, p]))
  const items = await db.visitPlanItem.findMany({
    where: { vendorId, planId: { in: [...planById.keys()] } },
    select: { id: true, planId: true, locationId: true, plannedFrom: true, plannedTo: true },
  }).catch(() => [])
  if (!items.length) return
  const covered = await db.visit.findMany({
    where: { vendorId, planItemId: { in: items.map((i) => i.id) } },
    select: { planItemId: true },
  }).catch(() => [] as { planItemId: string }[])
  const coveredIds = new Set(covered.map((v) => v.planItemId))
  const missed = items
    .filter((i) => !coveredIds.has(i.id))
    .flatMap((i) => {
      const plan = planById.get(i.planId)
      if (!plan) return [] // orphaned item (plan removed) — nothing to attribute
      return [{
        vendorId, planItemId: i.id, employeeId: plan.employeeId, locationId: i.locationId,
        status: "MISSED",
        remarks: `Planned window ${i.plannedFrom || ""}${i.plannedTo ? "–" + i.plannedTo : ""} on ${plan.date} passed without a check-in (auto-marked by the daily sweep)`,
      }]
    })
  if (missed.length) {
    for (let i = 0; i < missed.length; i += 1000) {
      await db.visit.createMany({ data: missed.slice(i, i + 1000) }).catch(() => {})
    }
  }
}

/** HRM-018 — runs once per vendor per day for resignations whose LWD has
 *  arrived. Disables the linked user (revoking live sessions), deactivates all
 *  biometric device mappings, marks the resignation COMPLETED and closes out. */
async function exitClosures(vendorId: string, date: string) {
  // any notice-period resignation whose LWD has arrived closes (SCHEDULED rows
  // from the acceptance hook + pre-existing records alike)
  const due = await db.resignation.findMany({
    where: { vendorId, status: "NOTICE_PERIOD", closureStatus: { not: "DONE" }, actualLwd: { not: null, lte: date } },
  })
  for (const res of due) {
    const emp = await db.employee.findUnique({ where: { id: res.employeeId } })
    if (!emp) continue
    const done: string[] = []
    // 1) disable linked user account + revoke sessions
    const users = await db.user.findMany({ where: { vendorId, employeeId: res.employeeId, status: "ACTIVE" } })
    for (const u of users) {
      await db.user.update({ where: { id: u.id }, data: { status: "INACTIVE" } })
      await db.session.deleteMany({ where: { userId: u.id } })
      done.push(`user ${u.email} disabled`)
    }
    // 2) revoke biometric device enrollment
    const { deactivateMappingsForEmployee } = await import("./zkteco/processor")
    const before = await db.attendanceDeviceUser.count({ where: { vendorId, employeeId: res.employeeId, enrollmentStatus: "ACTIVE" } })
    await deactivateMappingsForEmployee(vendorId, res.employeeId)
    if (before > 0) done.push(`${before} device mapping(s) revoked`)
    // 3) employee status → the Employee.status vocabulary (EXIT-004: the
    // sweep used to write the internal exit-type nouns RESIGNATION/
    // TERMINATION/RETIREMENT onto employee.status, which no filter, badge,
    // report or re-entry guard recognizes)
    const { resolveExitType, exitStatusForEmployee } = await import("./routes/exit")
    const targetStatus = exitStatusForEmployee(resolveExitType(res, emp.status))
    await db.employee.update({ where: { id: res.employeeId }, data: { status: targetStatus } }).catch(() => null)
    await db.employeeHistory.create({
      data: { vendorId, employeeId: res.employeeId, eventType: "EXIT",
        title: `Exit completed (${targetStatus}) — access closure applied`,
        description: `${emp.fullName} exited on LWD ${res.actualLwd}. ${done.join("; ") || "no access items found"}`,
        effectiveDate: res.actualLwd || date },
    }).catch(() => null)
    // 4) close the resignation record
    await db.resignation.update({ where: { id: res.id }, data: { status: "COMPLETED", closureStatus: "DONE", closureDoneAt: new Date() } })
    // 5) audit + notify HR_ADMIN and VENDOR_OWNER
    await notify(vendorId, { role: "HR_ADMIN" }, "Exit Closure Applied",
      `${emp.fullName} (${emp.code}) exited on ${res.actualLwd}. ${done.join("; ") || "No active access items were found."} Clearance status is available in Exit Management.`, "EXIT", "exit")
    await notify(vendorId, { role: "VENDOR_OWNER" }, "Employee Exit Completed",
      `${emp.fullName} (${emp.code}) has completed their exit on ${res.actualLwd}.`, "EXIT", "exit")
    try {
      await db.auditLog.create({
        data: { vendorId, userId: null, userName: "Exit Closure Job", action: "exit.closureApplied",
          entity: "Resignation", entityId: res.id,
          summary: `Access/status closure applied for LWD ${res.actualLwd}: ${done.join("; ") || "no access items"}`,
          newValue: JSON.stringify({ actions: done }) },
      })
    } catch { /* audit must never break closure */ }
  }
}

/** HRM-011 — apply carry-forward rules at the fiscal-year boundary: for every
 *  LeaveType with carryForward=true, carry min(balance, maxCarryForward) days
 *  into the new leave year as an "opening" adjustment; anything beyond the cap
 *  lapses. Accrual-frequency top-ups (MONTHLY/QUARTERLY) are applied here too.
 *
 *  M-3 REMEDIATION: accrual now (a) runs every accrual period boundary — not
 *  only at fiscal-year start — incrementing entitled by perPeriod with a cap,
 *  and (b) a carry-forward unique-constraint conflict UPDATES the existing
 *  row's carriedForward instead of silently swallowing the create. */
async function leaveRollover(vendorId: string, date: string, settings: any) {
  const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"]
  const fyStartMonth = Math.max(0, months.indexOf(settings.general.fiscalYearStart || "July"))
  const curMonth = Number(date.slice(5, 7)) - 1
  const isFirstDayOfMonth = date.slice(8, 10) === "01"
  const year = Number(date.slice(0, 4))
  const types = await db.leaveType.findMany({ where: { vendorId, active: true } })

  // ---- M-3: periodic accrual (every month/quarter, capped, date-guarded) ----
  if (isFirstDayOfMonth) {
    const quarterStart = curMonth % 3 === 0 // Jan/Apr/Jul/Oct for QUARTERLY types
    for (const t of types) {
      const freq = t.accrualFrequency || "ANNUAL"
      // LVE-106 — PRO_RATA accrues monthly like MONTHLY, but the cap is the
      // joining-date-prorated target (a November joiner earns 2/12 of the
      // quota by December — the old code never accrued PRO_RATA at all, so
      // types configured "Pro-rated" silently behaved as ANNUAL).
      if (freq !== "MONTHLY" && freq !== "PRO_RATA" && !(freq === "QUARTERLY" && quarterStart)) continue
      const perPeriod = freq === "MONTHLY" || freq === "PRO_RATA" ? t.defaultDays / 12 : t.defaultDays / 4
      if (!(perPeriod > 0)) continue
      const guardKey = `accrual:${t.id}`
      const periodTag = freq === "MONTHLY" || freq === "PRO_RATA" ? `${year}-${String(curMonth + 1).padStart(2, "0")}` : `${year}-Q${Math.floor(curMonth / 3) + 1}`
      const guard = await jobState(vendorId, `${guardKey}:${periodTag}`)
      if (guard === "1") continue
      // LVE-104 — accrual targets the CURRENT leave year's rows (keyed by the
      // fiscal-year start), not the calendar year of the tick: a January tick
      // tops up the leave year that started the previous July.
      const { leaveYearOf: accrualLeaveYearOf } = await import("./leave-math")
      const tickLeaveYear = accrualLeaveYearOf(date, fyStartMonth)
      const balances = await db.leaveBalance.findMany({ where: { vendorId, leaveTypeId: t.id, year: tickLeaveYear } })
      // PRO_RATA caps need each employee's joining date
      const employeesForAccrual = freq === "PRO_RATA"
        ? new Map((await db.employee.findMany({ where: { vendorId }, select: { id: true, joiningDate: true } })).map((e) => [e.id, e.joiningDate]))
        : new Map<string, string | null>()
      const { proRatedEntitlement } = await import("./leave-math")
      for (const b of balances) {
        // incrementally accrue, capped at the annual entitlement + carried forward
        let cap = t.defaultDays + (b.carriedForward || 0)
        if (freq === "PRO_RATA") {
          cap = proRatedEntitlement(t.defaultDays, employeesForAccrual.get(b.employeeId), tickLeaveYear, fyStartMonth, date) + (b.carriedForward || 0)
        }
        if (b.entitled < cap) {
          await db.leaveBalance.update({
            where: { id: b.id },
            data: { entitled: Math.min(cap, Math.round((b.entitled + perPeriod) * 100) / 100) },
          }).catch(() => null)
        }
      }
      await setJobState(vendorId, `${guardKey}:${periodTag}`, "1")
    }
  }

  // ---- fiscal-year boundary: carry-forward ----
  if (!isFirstDayOfMonth || curMonth !== fyStartMonth) return
  const guard = await jobState(vendorId, "lastLeaveRollover")
  if (guard === String(year)) return
  const balances = await db.leaveBalance.findMany({ where: { vendorId, year: year - 1 } })
  for (const t of types) {
    if (!t.carryForward) continue
    const affected = balances.filter((b) => b.leaveTypeId === t.id)
    for (const b of affected) {
      // LVE-002 (R3-4) — the carryable remainder is the canonical spendable
      // (entitled + carriedForward − used − pending): an in-flight PENDING
      // reservation is no longer carried into the new year as if it were
      // unused balance (the decision on it will debit the old year either way).
      const remaining = (b.entitled + b.carriedForward) - b.used - (b.pending || 0)
      if (remaining <= 0) continue
      const carry = Math.min(remaining, t.maxCarryForward || 0)
      if (carry > 0) {
        // M-3 — on a unique(employee, type, year) conflict, UPDATE the existing
        // row's carriedForward instead of silently dropping the carry
        const existingNew = await db.leaveBalance.findFirst({ where: { vendorId, employeeId: b.employeeId, leaveTypeId: t.id, year } })
        if (existingNew) {
          await db.leaveBalance.update({ where: { id: existingNew.id }, data: { carriedForward: carry } }).catch(() => null)
        } else {
          // LVE-106 — PRO_RATA types open the new leave year at the
          // joining-date-prorated quota (mid-year joiners never open with the
          // full annual quota)
          const { proRatedEntitlement: rolloverProRated } = await import("./leave-math")
          const empJoin = await db.employee.findUnique({ where: { id: b.employeeId }, select: { joiningDate: true } })
          const openingEntitled = t.accrualFrequency === "PRO_RATA" && empJoin?.joiningDate
            ? rolloverProRated(t.defaultDays, empJoin.joiningDate, year, fyStartMonth, date)
            : t.defaultDays
          await db.leaveBalance.create({
            data: { vendorId, employeeId: b.employeeId, leaveTypeId: t.id, year, entitled: openingEntitled, carriedForward: carry, used: 0 },
          }).catch(async (e: any) => {
            if (String(e?.code) === "P2002") {
              const retry = await db.leaveBalance.findFirst({ where: { vendorId, employeeId: b.employeeId, leaveTypeId: t.id, year } })
              if (retry) await db.leaveBalance.update({ where: { id: retry.id }, data: { carriedForward: carry } }).catch(() => null)
            }
          })
        }
      }
    }
  }
  await notify(vendorId, { role: "HR_ADMIN" }, "Leave Year Rollover Applied",
    `Fiscal year ${year} leave balances initialized: carry-forward caps, accrual frequencies and expiry rules from Settings → Leave were applied.`,
    "SYSTEM", "leave")
  await setJobState(vendorId, "lastLeaveRollover", String(year))
}

/** ISO week helpers — Monday-start weeks, Jan 4 always in week 1. */
function isoWeekOf(dateStr: string): { year: number; week: number } {
  const d = new Date(`${dateStr}T00:00:00Z`)
  const target = new Date(d.getTime())
  const dayNr = (d.getUTCDay() + 6) % 7
  target.setUTCDate(target.getUTCDate() - dayNr + 3)
  const firstThursday = new Date(Date.UTC(target.getUTCFullYear(), 0, 4))
  const fdayNr = (firstThursday.getUTCDay() + 6) % 7
  firstThursday.setUTCDate(firstThursday.getUTCDate() - fdayNr + 3)
  const week = 1 + Math.round((target.getTime() - firstThursday.getTime()) / (7 * 24 * 3600 * 1000))
  return { year: target.getUTCFullYear(), week }
}
function isoWeekRange(year: number, week: number): { start: string; end: string } {
  const jan4 = new Date(Date.UTC(year, 0, 4))
  const dayNr = (jan4.getUTCDay() + 6) % 7
  const week1Monday = new Date(jan4)
  week1Monday.setUTCDate(jan4.getUTCDate() - dayNr)
  const monday = new Date(week1Monday.getTime() + (week - 1) * 7 * 24 * 3600 * 1000)
  const sunday = new Date(monday.getTime() + 6 * 24 * 3600 * 1000)
  const iso = (d: Date) => d.toISOString().slice(0, 10)
  return { start: iso(monday), end: iso(sunday) }
}

/**
 * Payroll Automation (spec §9.3): system generates payroll runs automatically
 * based on vendor configuration.
 *  - MONTHLY: on the configured processing day → create + auto-calculate a DRAFT
 *    run for that month (cutoff honored). On the payment day → remind HR about
 *    approved-but-unpaid runs.
 *  - WEEKLY: on the configured weekday (processingDay 1=Mon…7=Sun) → create +
 *    auto-calculate a draft run for the week that just ended.
 * Approvals/payment stay manual — automation never pays anyone.
 */
async function payrollAutomation(vendorId: string, date: string) {
  const settings = await getSettings(vendorId)
  const day = Number(date.slice(8, 10))
  const _wd = ["SUNDAY", "MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY"]
  const dowIdx = new Date(`${date}T00:00:00Z`).getUTCDay()

  if (settings.payroll.frequency === "WEEKLY") {
    const trigger = Math.min(7, Math.max(1, Number(settings.payroll.processingDay) || 1)) // 1=Mon..7=Sun
    if (((dowIdx + 6) % 7) + 1 !== trigger) return
    // run covers the week that ENDED yesterday (Monday..Sunday)
    const endOfLastWeek = addDays(date, -1) // Sunday
    const sundayIso = isoWeekOf(endOfLastWeek)
    const { start, end } = isoWeekRange(sundayIso.year, sundayIso.week)
    const monthOfEnd = Number(end.slice(5, 7)), yearOfEnd = Number(end.slice(0, 4))
    const guard = await jobState(vendorId, "lastWeeklyRun")
    if (guard === `${sundayIso.year}-W${sundayIso.week}`) return
    const exists = await db.payrollRun.findFirst({
      where: { vendorId, periodYear: yearOfEnd, periodMonth: monthOfEnd, periodWeek: sundayIso.week, runType: "REGULAR" },
    })
    if (!exists) {
      const run = await db.payrollRun.create({
        data: {
          vendorId, periodMonth: monthOfEnd, periodYear: yearOfEnd, periodWeek: sundayIso.week,
          frequency: "WEEKLY", runType: "REGULAR", cutoffDate: end, status: "DRAFT",
          createdBy: null, processedDate: null,
        },
      })
      await autoCalculate(vendorId, run.id)
      await notify(vendorId, { role: "HR_ADMIN" }, "Weekly Payroll Run Auto-Created",
        `Weekly payroll draft for ${start} → ${end} (week ${sundayIso.week}) was created and calculated automatically. Review and submit it for approval.`,
        "PAYROLL", "payroll")
    }
    await setJobState(vendorId, "lastWeeklyRun", `${sundayIso.year}-W${sundayIso.week}`)
    return
  }

  // MONTHLY — R5-006: clamp processingDay and paymentDay to ≤28 so Feb always fires
  if (day === Math.min(settings.payroll.processingDay, 28)) {
    const month = Number(date.slice(5, 7)), year = Number(date.slice(0, 4))
    const guard = await jobState(vendorId, "lastMonthlyRun")
    if (guard === `${year}-${month}`) return
    const exists = await db.payrollRun.findFirst({ where: { vendorId, periodYear: year, periodMonth: month, periodWeek: 0, runType: "REGULAR" } })
    if (!exists) {
      const cutoff = `${year}-${String(month).padStart(2, "0")}-${String(Math.min(settings.payroll.cutoffDay, 28)).padStart(2, "0")}`
      const run = await db.payrollRun.create({
        data: { vendorId, periodMonth: month, periodYear: year, periodWeek: 0, frequency: "MONTHLY", runType: "REGULAR", cutoffDate: cutoff, status: "DRAFT", createdBy: null },
      })
      await autoCalculate(vendorId, run.id)
      await notify(vendorId, { role: "HR_ADMIN" }, "Payroll Run Auto-Created",
        `Payroll draft for ${monthName(month)} ${year} was created and calculated automatically (cutoff ${cutoff}). Review and submit it for approval.`,
        "PAYROLL", "payroll")
    }
    await setJobState(vendorId, "lastMonthlyRun", `${year}-${month}`)
  }

  if (day === Math.min(settings.payroll.paymentDay, 28)) { // R5-006: clamp to ≤28
    const unpaid = await db.payrollRun.findMany({ where: { vendorId, status: "APPROVED" } })
    for (const run of unpaid) {
      const guard = await jobState(vendorId, "lastPaymentReminder")
      if (guard === `${date}:${run.id}`) continue
      await notify(vendorId, { role: "PAYROLL_OFFICER" }, "Salary Payment Due",
        `Payroll ${monthName(run.periodMonth)} ${run.periodYear} (৳${Math.round(run.totalNet).toLocaleString("en-IN")}) is approved and due for payment today (payment day ${settings.payroll.paymentDay}).`,
        "PAYROLL", "payroll")
      await setJobState(vendorId, "lastPaymentReminder", `${date}:${run.id}`)
    }
  }
}

async function autoCalculate(vendorId: string, runId: string) {
  try {
    const { calculateRun } = await import("./payroll")
    const sysCtx = { vendorId, userId: null, userName: "Payroll Automation", ip: null, role: "HR_ADMIN", permissions: new Set<string>() }
    await calculateRun(sysCtx as any, runId)
  } catch (e) {
    console.error("[jobs] auto-calculate failed for run", runId, e)
    // run remains DRAFT — HR can calculate manually
  }
}


// ---------- M-13: audit-log retention (5-year policy) ----------
const AUDIT_RETENTION_DAYS = 5 * 365
export async function auditRetention(vendorId: string): Promise<number> {
  const cutoff = new Date(Date.now() - AUDIT_RETENTION_DAYS * 86_400_000)
  const res = await db.auditLog.deleteMany({
    where: { vendorId, createdAt: { lt: cutoff } },
  })
  return res.count
}

// ============ M-04/M-05 — background job queue ============
// Heavy fan-out operations (communications.send up to 1,000 recipients,
// payslips.emailAll, backups.export) enqueue here and return a job ID
// immediately; clients poll the jobs.get action for progress + result.
// Single-instance SQLite: claim via conditional updateMany (PENDING → RUNNING)
// is atomic; multi-instance deployments need a Redis-backed queue instead.

export type JobCtx = { userId: string | null; userName: string | null; vendorId: string }

/** WP-A — submission options for the production-grade queue. */
export type SubmitJobOptions = {
  /** lower runs first (0 = highest, 9 = lowest); default 5. */
  priority?: number
  /** earliest execution time; null/undefined = immediately eligible. */
  scheduledFor?: Date | null
  /** total attempt budget (including the first); default 3, min 1. */
  maxAttempts?: number
  /** explicit work-unit count for progress display. */
  total?: number
}

export async function submitJob(
  ctx: JobCtx,
  type: string,
  payload: Record<string, unknown>,
  totalOrOpts: number | SubmitJobOptions = 0,
): Promise<string> {
  const opts: SubmitJobOptions = typeof totalOrOpts === "number" ? { total: totalOrOpts } : totalOrOpts
  const job = await db.bgJob.create({
    data: {
      vendorId: ctx.vendorId, type, payloadJson: JSON.stringify(payload),
      total: opts.total ?? 0,
      priority: Math.min(9, Math.max(0, Number.isFinite(opts.priority) ? (opts.priority as number) : 5)),
      scheduledFor: opts.scheduledFor ?? null,
      maxAttempts: Math.max(1, Math.min(10, opts.maxAttempts ?? 3)),
      createdBy: ctx.userId, createdByName: ctx.userName,
    },
  })
  // small jobs should finish immediately — kick a drain instead of waiting
  // for the next 60s tick (scheduled jobs are filtered out until due)
  drainJobs().catch((e) => console.error("[jobs] drain kick failed", e))
  return job.id
}

type ProgressFn = (done: number) => Promise<void>

// ================= WP-A — async conversions of long-running operations =================
// Heavy full-vendor operations enqueue here and run in the worker lane with
// progress reporting, retry/backoff, cooperative cancellation and a run log.
// The RPC routes keep their synchronous default (no client change required)
// and submit a job when the caller opts in (async: true) or the audience is
// large. Handlers must be idempotent: payroll calculate wipes+rewrites inside
// a transaction keyed by runId (re-safe); payRun claims APPROVED→PROCESSING
// conditionally and the journal is idempotency-keyed PAYROLL:{runId}.

const JOB_RUNNERS: Record<string, (job: any, payload: any, ctx: JobCtx, progress: ProgressFn) => Promise<unknown>> = {

  // ---- payroll.calculate — full-vendor calculation (WP-A async path) ----
  PAYROLL_CALCULATE: async (_job, payload, ctx, progress) => {
    const { calculateRun } = await import("./payroll")
    await progress(0)
    const res = await calculateRun(ctx as any, payload.runId as string, async (done, total) => {
      await progress(done)
      void total
    }, { excludeEmployeeIds: (payload.excludeEmployeeIds as string[]) || [] })
    await audit(ctx as any, "payroll.calculate", "PayrollRun", payload.runId as string,
      `Async calculation finished: ${res.count} employees, net ৳${Math.round(res.totalNet).toLocaleString("en-IN")} (job-executed)`)
    return res
  },

  // ---- payroll.pay — full-vendor disbursement (WP-A async path) ----
  // payRun is idempotent: conditional APPROVED→PROCESSING claim + journal
  // idempotency key PAYROLL:{runId} — a retry after a crash can never
  // double-post money.
  PAYROLL_PAY: async (_job, payload, ctx, progress) => {
    const { payRun } = await import("./payroll")
    await progress(0)
    const res = await payRun(ctx as any, payload.runId as string, async (done, total) => {
      await progress(done)
      void total
    })
    return res
  },

  // ---- announcement delivery fan-out (WP-A) ----
  // Created by announcements.create when the resolved audience is large
  // (> ANNOUNCE_ASYNC_THRESHOLD); small audiences stay synchronous.
  ANNOUNCEMENT_DELIVERY: async (_job, payload, ctx, progress) => {
    const targets = (payload.targetIds as string[]) || []
    const title = String(payload.title || "HR Announcement")
    const body = String(payload.body || "").slice(0, 200)
    let done = 0
    for (const t of targets) {
      await notify(ctx.vendorId, { employeeId: t }, "HR Announcement: " + title, body, "ANNOUNCEMENT", "ess")
      done++
      if (done % 20 === 0) await progress(done)
    }
    return { notified: done, total: targets.length }
  },

  // ---- salary export (large XLSX, WP-A) ----
  // Returns the rendered document as base64 inside resultJson. Kept for
  // exports that would exceed the 30s client abort; the sync route remains
  // the default for interactive use.
  SALARY_EXPORT: async (_job, payload, ctx) => {
    const { buildSalaryExport, renderCsv, renderXlsx } = await import("./salary-export")
    const type = (payload.type || "ALL") as any
    const data = await buildSalaryExport(ctx.vendorId, payload.runId as string, type, {
      branchId: (payload.branchId as string) ?? null, departmentId: (payload.departmentId as string) ?? null, employeeId: (payload.employeeId as string) ?? null,
    })
    await audit(ctx as any, `payroll.export.${String(type).toLowerCase()}`, "PayrollRun", payload.runId as string,
      `Async salary export (${payload.format || "xlsx"}, ${data.totals.employees} employees, net ৳${Math.round(data.totals.net).toLocaleString("en-IN")}) — run ${data.runLabel}`)
    if (payload.format === "csv") {
      return { format: "csv", filename: `salary-${String(type).toLowerCase()}-${data.runLabel}.csv`, csv: renderCsv(type, data), totals: data.totals, skipped: data.skipped }
    }
    const buf = renderXlsx(type, data, data.runLabel)
    return { format: "xlsx", filename: `salary-${String(type).toLowerCase()}-${data.runLabel}.xlsx`, base64: buf.toString("base64"), totals: data.totals, skipped: data.skipped }
  },

  // ---- attendance processing sweep (WP-A) ----
  // Operator-triggerable single pass of the raw-event sweeper: reprocesses
  // RECEIVED/OUT_OF_WINDOW-requeued events into attendance days. The
  // autonomous sweeper loop keeps running on its own schedule; this is the
  // "run it now" button in the Job Center.
  ATTENDANCE_SWEEP: async (_job, _payload, ctx) => {
    const { sweepOnce } = await import("./zkteco/gateway")
    const res = await sweepOnce(ctx.vendorId)
    return res
  },

  // ---- device sync (WP-A) ----
  // Queues a CHECK command on every enabled ADMS device of the vendor (the
  // devices answer on their next poll; ingested batches flow through the
  // sweeper). One job per vendor — replaces N manual row actions.
  DEVICE_SYNC: async (_job, _payload, ctx, progress) => {
    const devices = await db.attendanceDevice.findMany({ where: { vendorId: ctx.vendorId, enabled: true }, select: { id: true, name: true } })
    const { isAllowedCommand } = await import("./zkteco/adapter")
    let queued = 0
    let i = 0
    for (const d of devices) {
      const command = "CHECK"
      if (!isAllowedCommand(command)) continue
      await db.deviceCommand.create({ data: { vendorId: ctx.vendorId, deviceId: d.id, command, createdBy: ctx.userId } })
        .then(() => { queued++ })
        .catch(() => {})
      i++
      if (i % 5 === 0) await progress(i)
    }
    await audit(ctx as any, "devices.syncAll", "AttendanceDevice", null, `Sync requested for ${queued}/${devices.length} enabled device(s) (job-executed)`)
    return { queued, total: devices.length }
  },
  // ---- backups (WP-R) — pg_dump | gzip + sha256 + retention + drill ----
  BACKUP_PG_DUMP: async (_job, _payload, _ctx, progress) => {
    const { runBackup } = await import("./saas/backup")
    return runBackup(_job, progress)
  },
  RESTORE_DRILL: async (_job, _payload, _ctx, progress) => {
    const { runRestoreDrill } = await import("./saas/backup")
    return runRestoreDrill(_job, progress)
  },

  // ---- CMS media backfill (WP-Q) — sha256/dimensions for existing media ----
  MEDIA_BACKFILL: async (_job, _payload, _ctx, progress) => {
    const { backfillMedia } = await import("./saas/media-backfill")
    return backfillMedia(progress)
  },

  // ---- camera status polling (WP-B, CCTV review §3.4) ----
  // Scheduled from runTick (scheduleCameraStatusSweep) — ≤1 sweep / vendor /
  // 10 min. Stale-first ordering, per-tenant cap, 500ms stagger between brand
  // API calls, credential failures → UNKNOWN + lastError (NEVER OFFLINE,
  // per the module's own rule). Provider fetches carry a 10s AbortSignal.
  CAMERA_STATUS_SWEEP: async (_job, _payload, ctx, progress) => {
    const { listCameras, updateCameraStatus, isTenantCredentialBrand, getCredential } = await import("./cameras/repository")
    const { getProvider } = await import("./cameras/providers/registry")
    // sweep ctx: role HR_ADMIN keeps cameraScopeFilter vendor-wide (no branch filter)
    const sweepCtx = { userId: "system", userName: "Camera Status Sweep", vendorId: ctx.vendorId, role: "HR_ADMIN", permissions: new Set<string>() } as any
    const cams = await listCameras(sweepCtx, { limit: 25 }) // enabled only
    // stale first: cameras never checked get priority (sort in JS — lastStatusCheckAt may be null)
    cams.sort((a: any, b: any) => (a.lastStatusCheckAt?.getTime() ?? 0) - (b.lastStatusCheckAt?.getTime() ?? 0))
    let checked = 0, failed = 0, skippedNoCreds = 0
    for (const cam of cams) {
      const provider = getProvider(cam.brand)
      let tenantCreds = null
      if (isTenantCredentialBrand(cam.brand)) {
        const cred = await getCredential(sweepCtx, cam.brand).catch(() => null)
        if (!cred) {
          // no credential row — mark the "we tried" marker + UNKNOWN (never OFFLINE)
          await updateCameraStatus(sweepCtx, cam.id, "UNKNOWN", { lastError: `No ${cam.brand} cloud credentials configured` }).catch(() => null)
          skippedNoCreds++
          checked++
          continue
        }
        tenantCreds = (cred as any).creds
      }
      try {
        const st = await provider.getDeviceStatus(cam, tenantCreds)
        await updateCameraStatus(sweepCtx, cam.id, st.status, {
          lastSeenAt: st.lastSeenAt ?? undefined,
          lastError: st.error ?? null,
        })
        if (st.status === "UNKNOWN") failed++
      } catch (e: any) {
        failed++
        await updateCameraStatus(sweepCtx, cam.id, "UNKNOWN", { lastError: String(e?.message || e).slice(0, 300) }).catch(() => null)
      }
      checked++
      await progress(checked)
      // stagger: 500ms between cameras so the brand API is not hammered
      await new Promise((r) => setTimeout(r, 500))
    }
    return { checked, failed, skippedNoCreds, total: cams.length }
  },

  // ---- communications.send delivery fan-out ----
  COMMUNICATION_SEND: async (_job, payload, ctx, progress) => {
    const { sendEmail, sendSms } = await import("./gateway")
    const channel = String(payload.channel || "BOTH")
    const targets: any[] = await db.employee.findMany({
      where: { vendorId: ctx.vendorId, id: { in: payload.targetIds as string[] } },
      select: { id: true, fullName: true, preferredName: true, officialEmail: true, personalEmail: true, mobile: true, altMobile: true },
    })
    const settings = await getSettings(ctx.vendorId, { maskSecrets: false })
    const company = settings.general.companyName
    const message = String(payload.message || "")
    const subject = String(payload.subject || "Message from your HR team")
    const render = (text: string, name: string) => text.replace(/{{name}}/g, name).replace(/{{company}}/g, company)
    let delivered = 0, failed = 0, skipped = 0, done = 0
    for (const e of targets) {
      const name = e.preferredName || e.fullName
      const body = render(message, name)
      let emailStatus: string | null = null, smsStatus: string | null = null, detail: string | null = null
      if (channel === "EMAIL" || channel === "BOTH") {
        const to = e.officialEmail || e.personalEmail || ""
        const r = await sendEmail(ctx.vendorId, to, render(subject, name), body)
        emailStatus = r.status
        if (r.status === "SENT") delivered++
        else if (r.status === "FAILED") failed++
        else skipped++
        if (r.status !== "SENT") detail = r.detail || null
      }
      if (channel === "SMS" || channel === "BOTH") {
        const to = e.mobile || e.altMobile || ""
        const r = await sendSms(ctx.vendorId, to, body)
        smsStatus = r.status
        if (r.status === "SENT") delivered++
        else if (r.status === "FAILED") failed++
        else skipped++
        if (r.status !== "SENT") detail = detail || r.detail || null
      }
      await db.communicationRecipient.create({
        data: {
          vendorId: ctx.vendorId, // DB-02 (R5)
          logId: payload.logId as string, employeeId: e.id, employeeName: e.fullName,
          email: e.officialEmail || e.personalEmail || null, phone: e.mobile || e.altMobile || null,
          emailStatus, smsStatus, detail: detail ? String(detail).slice(0, 500) : null,
        },
      })
      done++
      if (done % 10 === 0) await progress(done)
    }
    const status = failed > 0 ? (delivered > 0 ? "PARTIAL" : "FAILED") : delivered > 0 ? "SENT" : "SKIPPED"
    await db.communicationLog.update({
      where: { id: payload.logId as string },
      data: { deliveredCount: delivered, failedCount: failed, skippedCount: skipped, status },
    })
    // Optional in-app copy so employees also see the message in their portal
    if (payload.inApp !== false) {
      for (const e of targets.slice(0, 200)) {
        await notify(ctx.vendorId, { employeeId: e.id }, subject, message.slice(0, 200), "SYSTEM", "notifications")
      }
      await db.communicationLog.update({ where: { id: payload.logId as string }, data: { inAppNotified: true } })
    }
    await audit(ctx as any, "communications.send", "CommunicationLog", payload.logId as string,
      `${channel} to ${targets.length} employees (${payload.audienceLabel || "audience"}) — ${delivered} delivered, ${failed} failed, ${skipped} skipped`)
    return { delivered, failed, skipped, status, recipientCount: targets.length }
  },

  // ---- payslips.emailAll fan-out ----
  PAYSLIP_EMAIL_ALL: async (_job, payload, ctx, progress) => {
    const { emailPayslip } = await import("./delivery")
    const entries = await db.payrollEntry.findMany({ where: { runId: payload.runId as string, payslipNumber: { not: null } } })
    let sent = 0, failed = 0, skipped = 0
    for (const [i, e] of entries.entries()) {
      const res = await emailPayslip(ctx.vendorId, e.id, { force: true })
      if (res.status === "SENT") sent++
      else if (res.status === "FAILED") failed++
      else skipped++
      if ((i + 1) % 5 === 0) await progress(i + 1)
    }
    await audit(ctx as any, "payslips.emailAll", "PayrollRun", payload.runId as string,
      `Bulk payslip email: ${sent} sent, ${failed} failed, ${skipped} skipped`)
    return { total: entries.length, sent, failed, skipped }
  },

  // ---- employee credential delivery fan-out (bulk import §12) ----
  // Per employee: rotate the freshly provisioned account onto a new temporary
  // password (in-memory only — plaintext never persists in the job payload)
  // and deliver it through the employee_credentials channels configured in
  // Settings → Communication → Automation. Per-employee outcomes land in
  // CommunicationLog; a failure on one employee never stops the queue.
  EMPLOYEE_CREDENTIALS_DELIVERY: async (_job, payload, ctx, progress) => {
    const { rotateAndDeliverCredentials } = await import("./employee-provisioning")
    const ids = (payload.employeeIds as string[]) || []
    let delivered = 0, failed = 0, skipped = 0, noAccount = 0
    for (const [i, employeeId] of ids.entries()) {
      try {
        const res = await rotateAndDeliverCredentials(ctx.vendorId, employeeId)
        if (!res) { noAccount++; skipped++; }
        else if (res.email === "SENT" || res.sms === "SENT") delivered++
        else if (res.email === "FAILED" || res.sms === "FAILED") failed++
        else skipped++
      } catch (err: any) {
        failed++
        console.error("[jobs] credential delivery failed for employee", employeeId, err?.message || err)
      }
      if ((i + 1) % 5 === 0) await progress(i + 1)
    }
    await audit(ctx as any, "employees.credentialsDelivered", "BgJob", _job?.id || null,
      `Credential delivery (${payload.source || "manual"}): ${delivered} delivered, ${failed} failed, ${skipped} skipped (${noAccount} without account)`)
    return { total: ids.length, delivered, failed, skipped, noAccount }
  },

  // ---- backups.export payload build (gates already passed synchronously) ----
  BACKUP_EXPORT: async (_job, _payload, ctx) => {
    // DB-01 (Critical, customer-reported) — the export inventory and scoping
    // now live in backup-export.ts: DMMF-generated model list (schema
    // additions surface automatically), child tables exported through their
    // parent's vendor-scoped ID set (never an unscoped cross-tenant query),
    // a real delegate presence check, and LOUD failure for anything that
    // resolves to neither an export strategy nor an explicit documented
    // exclusion. A silent skip is structurally impossible now.
    const { buildTenantBackupExport } = await import("./backup-export")
    const { data, excluded, expectedTableCount } = await buildTenantBackupExport(ctx.vendorId)
    // C-2 — the user table is exported as explicit safe fields ONLY
    data.user = await db.user.findMany({
      where: { vendorId: ctx.vendorId },
      select: { id: true, email: true, name: true, role: true, status: true, mfaEnrolled: true, employeeId: true, branchId: true, departmentId: true, createdAt: true, lastLoginAt: true },
    })
    const vendor = await db.vendor.findUnique({ where: { id: ctx.vendorId } })
    const settings = await getSettings(ctx.vendorId, { maskSecrets: true })
    return {
      exportedAt: new Date().toISOString(), vendor: { id: ctx.vendorId, name: vendor?.name },
      settings, // masked
      data,
      tableCount: Object.keys(data).length,
      expectedTableCount,
      // DB-01 transparency: nothing is silently missing — the models that are
      // deliberately NOT in the export ride along with their reason.
      missingModels: [] as string[],
      excludedModels: excluded,
    }
  },
}

let currentDrain: Promise<number> | null = null

// ================= WP-A — production-grade queue engine =================
// Upgrades over the Wave-1 queue:
//   priority-aware ordering · exponential backoff with jitter · automatic
//   retry up to maxAttempts then DEAD (dead-letter) · cooperative
//   cancellation (CANCELLED checked between chunks via the progress
//   callback) · per-type concurrency limit · append-only run log.

/** Cooperative cancellation signal — thrown by the progress callback when
 *  an admin has cancelled the job mid-run; the drain lane finalizes the
 *  row as CANCELLED instead of DONE/FAILED. Handlers that ignore progress()
 *  still finish; their final write is conditional on status=RUNNING. */
export class JobCancelledError extends Error {
  constructor() { super("Job cancelled by operator"); this.name = "JobCancelledError" }
}

/** Per-type in-process concurrency caps. Types not listed use the default.
 *  Heavy exclusive jobs (payroll money paths, backups) serialize; fan-out
 *  jobs (email/SMS) get a wider lane. */
const JOB_TYPE_CONCURRENCY: Record<string, number> = {
  PAYROLL_CALCULATE: 1,
  PAYROLL_PAY: 1,
  BACKUP_EXPORT: 1,
  BACKUP_PG_DUMP: 1,
  RESTORE_DRILL: 1,
  SALARY_EXPORT: 2,
  ATTENDANCE_SWEEP: 1,
  DEVICE_SYNC: 2,
  DEVICE_HISTORICAL_PULL: 1,
  MEDIA_BACKFILL: 1,
}
const DEFAULT_TYPE_CONCURRENCY = 2

/** Exponential backoff with jitter: 2^attempts × 30s, capped at 15 min,
 *  ±20% jitter so concurrent failures don't retry in lockstep. */
export function backoffMs(attempts: number): number {
  const base = Math.min(15 * 60_000, Math.pow(2, Math.max(0, attempts)) * 30_000)
  const jitter = base * (0.8 + Math.random() * 0.4) // ±20%
  return Math.round(Math.min(15 * 60_000, jitter))
}

/** Append an attempt record to the job's run log (best-effort, capped at
 *  the last 25 attempts so the column cannot grow unbounded). */
async function appendRunLog(
  client: typeof db,
  jobId: string,
  entry: { startedAt: string; finishedAt: string; error?: string; durationMs: number },
): Promise<void> {
  try {
    const row = await client.bgJob.findUnique({ where: { id: jobId }, select: { runLogJson: true } })
    const log = row?.runLogJson ? (JSON.parse(row.runLogJson) as any[]) : []
    log.push({ ...entry, error: entry.error ? String(entry.error).slice(0, 500) : undefined })
    await client.bgJob.update({
      where: { id: jobId },
      data: { runLogJson: JSON.stringify(log.slice(-25)) },
    })
  } catch { /* observability must never break the lane */ }
}

/** In-flight type counters for the per-type concurrency limit. */
const inFlightTypes = new Map<string, number>()
function typeLaneFree(type: string): boolean {
  const cap = JOB_TYPE_CONCURRENCY[type] ?? DEFAULT_TYPE_CONCURRENCY
  return (inFlightTypes.get(type) || 0) < cap
}
function typeLaneEnter(type: string) { inFlightTypes.set(type, (inFlightTypes.get(type) || 0) + 1) }
function typeLaneExit(type: string) {
  const n = (inFlightTypes.get(type) || 1) - 1
  if (n <= 0) inFlightTypes.delete(type)
  else inFlightTypes.set(type, n)
}

/** Claim + run every eligible job (also invoked from the scheduler tick).
 *  Concurrent calls JOIN the in-flight pass instead of returning early —
 *  a caller that kicks + awaits still observes the full completion.
 *  WP-A: claims respect priority, scheduledFor, per-type concurrency; failed
 *  attempts requeue with backoff until maxAttempts, then DEAD. */
export function drainJobs(): Promise<number> {
  // HIGH-4 — refuse to claim new jobs once SIGTERM/SIGINT has been received.
  // In-flight runners complete naturally; no new claims are made.
  if (_isShuttingDown()) return Promise.resolve(0)
  if (currentDrain) return currentDrain
  // Best-effort: trigger the lazy load so the next tick has the shutdown flag.
  void loadLifecycle()
  currentDrain = (async () => {
    let ran = 0
    try {
      for (;;) {
        // WP-A — priority-aware claim: eligible PENDING jobs (due now),
        // highest priority first, then oldest. Types at their concurrency
        // cap are skipped WITHOUT claiming (a later pass picks them up).
        const pending = await db.bgJob.findMany({
          where: {
            status: "PENDING",
            OR: [{ scheduledFor: null }, { scheduledFor: { lte: new Date() } }],
          },
          orderBy: [{ priority: "asc" }, { createdAt: "asc" }],
          take: 20,
        })
        const job = pending.find((j) => typeLaneFree(j.type))
        if (!job) break // nothing eligible / all lanes busy — next tick retries
        // claim atomically: conditional update, first-wins
        const claim = await db.bgJob.updateMany({
          where: { id: job.id, status: "PENDING" },
          data: { status: "RUNNING", startedAt: new Date() },
        })
        if (claim.count === 0) continue // another lane claimed it
        ran++
        typeLaneEnter(job.type)
        const attemptStartedAt = new Date()
        const progress: ProgressFn = async (done: number) => {
          // WP-A — cooperative cancellation: the canonical between-chunks
          // checkpoint. Every well-behaved runner reports progress every few
          // items; a cancelled job aborts at the next checkpoint.
          const row = await db.bgJob.findUnique({ where: { id: job.id }, select: { status: true, cancelledAt: true } })
          if (row && (row.status === "CANCELLED" || row.cancelledAt)) throw new JobCancelledError()
          await db.bgJob.update({ where: { id: job.id }, data: { progress: done } }).catch(() => {})
        }
        try {
          const runner = JOB_RUNNERS[job.type]
          if (!runner) {
            // An unknown type is a permanent failure — no point retrying.
            throw new Deny(`No runner registered for job type ${job.type}`, 500)
          }
          const result = await runner(job, JSON.parse(job.payloadJson || "{}"), { userId: job.createdBy, userName: job.createdByName, vendorId: job.vendorId }, progress)
          // WP-A — conditional completion: if an admin cancelled while the
          // runner was finishing, the CANCELLED status wins.
          const done = await db.bgJob.updateMany({
            where: { id: job.id, status: "RUNNING" },
            data: { status: "DONE", progress: job.total, resultJson: JSON.stringify(result ?? {}), finishedAt: new Date(), error: null },
          })
          if (done.count === 0) {
            await appendRunLog(db, job.id, { startedAt: attemptStartedAt.toISOString(), finishedAt: new Date().toISOString(), error: "superseded by cancellation", durationMs: Date.now() - attemptStartedAt.getTime() })
          } else {
            await appendRunLog(db, job.id, { startedAt: attemptStartedAt.toISOString(), finishedAt: new Date().toISOString(), durationMs: Date.now() - attemptStartedAt.getTime() })
          }
        } catch (e: any) {
          if (e instanceof JobCancelledError) {
            await db.bgJob.updateMany({
              where: { id: job.id, status: "RUNNING" },
              data: { status: "CANCELLED", cancelledAt: new Date(), finishedAt: new Date(), error: "Cancelled by operator mid-run" },
            }).catch(() => {})
            await appendRunLog(db, job.id, { startedAt: attemptStartedAt.toISOString(), finishedAt: new Date().toISOString(), error: "cancelled mid-run", durationMs: Date.now() - attemptStartedAt.getTime() })
          } else {
            console.error(`[jobs] job ${job.type} (${job.id}) attempt ${job.attempts + 1} failed`, e)
            const attempts = job.attempts + 1
            const dead = attempts >= Math.max(1, job.maxAttempts)
            const retryAt = new Date(Date.now() + backoffMs(attempts))
            await db.bgJob.updateMany({
              where: { id: job.id, status: "RUNNING" },
              data: dead
                ? { status: "DEAD", attempts, lastErrorAt: new Date(), finishedAt: new Date(), error: String(e?.message || e).slice(0, 1000) }
                : { status: "PENDING", attempts, lastErrorAt: new Date(), error: String(e?.message || e).slice(0, 1000), scheduledFor: retryAt, startedAt: null },
            }).catch(() => {})
            await appendRunLog(db, job.id, {
              startedAt: attemptStartedAt.toISOString(), finishedAt: new Date().toISOString(),
              error: String(e?.message || e).slice(0, 500), durationMs: Date.now() - attemptStartedAt.getTime(),
            })
          }
        } finally {
          typeLaneExit(job.type)
        }
      }
      return ran
    } finally {
      currentDrain = null
    }
  })()
  return currentDrain
}

// ============ System Health checks — owner.health.* (Wave 2 WP-N) ============
// Owner-plane "System Health" console: one snapshot RPC (owner.health.snapshot,
// perm health.view) running 12 REAL server-side checks + three manual actions
// (owner.health.testEmail / testSms / clearCache, perm health.manage).
//
// Design rules (from the WP-N brief):
//   - every value is computed from live runtime/DB state — NO fabricated data;
//     checks that cannot be assessed yet report "unknown" with an honest note
//     (Backup → WP-R pending, SSL → future nightly job, no outbound calls here)
//   - NO secrets ever leave this module: booleans, counts, timestamps and
//     latencies only (gateway hosts/credentials stay in the masked Settings UI)
//   - each check is independently cached for 60s (module-level Map keyed by
//     check id, stale-while-revalidate + in-flight dedup so parallel snapshot
//     requests never stampede the database)
//   - snapshot queries are count/groupBy/max aggregates only — never row scans
//     of line-level tables; the whole snapshot fans out via Promise.allSettled
//     so one broken check can never blank the console
//   - manual actions are saasAudit-logged and rate-limited 1/60s per action
//     (module timestamps on globalThis so `next dev` reloads don't reset them)
//
// Registration mirrors cms-routes.ts: this module self-registers via
// ownerAction() and is side-effect-imported by the /api/owner dispatcher
// AFTER owner-routes (see src/app/api/owner/route.ts).
import { z } from "zod"
import path from "node:path"
import { readdir, statfs } from "node:fs/promises"
import { db } from "@/lib/db"
import { ownerAction } from "./owner-routes"
import { saasAudit } from "./audit"
import {
  getPlatformGateway, platformEmailConfigured, platformSmsConfigured,
  sendPlatformEmail, sendPlatformSms, logPlatformNotification,
} from "./notify"
import { getSaasSettings } from "./settings"
// WP-R — the backup engine (SaasBackupRun history + the cron-free nightly
// schedule). No cycle: backup.ts imports owner-routes/jobs/notify, never health.
import { maybeRunScheduledBackup, getBackupSettings } from "./backup"
import { j } from "../utils"
import pkg from "../../../package.json"

// ------------------------------ types ------------------------------

export type HealthCheckStatus = "ok" | "degraded" | "down" | "unknown"

export type HealthCheck = {
  id: string
  label: string
  status: HealthCheckStatus
  detail: string
  lastCheckedAt: string // ISO timestamp of the LAST REAL evaluation (not cache read)
  meta: Record<string, unknown> // drill-down table — booleans/counts/timestamps only
}

type CheckBody = Omit<HealthCheck, "id" | "label" | "lastCheckedAt">

// ------------------------------ 60s per-check cache ------------------------------

const CHECK_TTL_MS = 60_000
const checkCache = new Map<string, { at: number; value: HealthCheck }>()
const checkInflight = new Map<string, Promise<HealthCheck>>()

async function evaluateCheck(id: string, label: string, fn: () => Promise<CheckBody>): Promise<HealthCheck> {
  const lastCheckedAt = new Date().toISOString()
  let body: CheckBody
  try {
    body = await fn()
  } catch (e: unknown) {
    // a check that itself throws (e.g. DB unreachable mid-check) is honestly
    // "unknown", never silently ok — the dedicated Database check carries the
    // down/degraded signal for shared-infrastructure failures.
    body = {
      status: "unknown",
      detail: `Check could not be evaluated: ${String((e as Error)?.message || e).slice(0, 180)}`,
      meta: {},
    }
  }
  const value: HealthCheck = { id, label, ...body, lastCheckedAt }
  checkCache.set(id, { at: Date.now(), value })
  return value
}

/** Cached check runner: fresh value within TTL, stale-while-revalidate after,
 *  in-flight dedup so parallel snapshot calls share one evaluation. */
async function runCheck(id: string, label: string, fn: () => Promise<CheckBody>): Promise<HealthCheck> {
  const hit = checkCache.get(id)
  if (hit && Date.now() - hit.at < CHECK_TTL_MS) return hit.value
  if (hit) {
    // stale-while-revalidate: serve the cached value, refresh in the background
    if (!checkInflight.has(id)) {
      const p = evaluateCheck(id, label, fn).finally(() => checkInflight.delete(id))
      checkInflight.set(id, p)
    }
    return hit.value
  }
  const existing = checkInflight.get(id)
  if (existing) return existing
  const p = evaluateCheck(id, label, fn).finally(() => checkInflight.delete(id))
  checkInflight.set(id, p)
  return p
}

// ------------------------------ small helpers ------------------------------

function humanDuration(sec: number): string {
  const d = Math.floor(sec / 86400)
  const h = Math.floor((sec % 86400) / 3600)
  const m = Math.floor((sec % 3600) / 60)
  if (d > 0) return `${d}d ${h}h ${m}m`
  if (h > 0) return `${h}h ${m}m`
  return `${m}m ${Math.floor(sec % 60)}s`
}

function ageMin(from: Date | null | undefined): number | null {
  if (!from) return null
  return Math.max(0, Math.round((Date.now() - from.getTime()) / 60000))
}

function isoOrNull(d: Date | null | undefined): string | null {
  return d ? d.toISOString() : null
}

// ============================== THE 12 CHECKS ==============================

const CHECKS: { id: string; label: string; fn: () => Promise<CheckBody> }[] = [
  // ---- 1. Application ---------------------------------------------------------
  {
    id: "application",
    label: "Application",
    fn: async () => {
      const version = (pkg as { version?: string }).version || "unknown"
      const env = process.env.NODE_ENV === "production" ? "production" : "development"
      const uptimeSec = Math.floor(process.uptime())
      const jobsSchedulerOn = (process.env.HRM_JOBS_ENABLED ?? "true") !== "false"
      const admsSweeperOn = (process.env.ZKTECO_ADMS_ENABLED ?? "true") !== "false"
      return {
        status: "ok", // the process answering this request IS the liveness proof
        detail: `v${version} · up ${humanDuration(uptimeSec)} · ${env}`,
        meta: {
          version,
          uptimeSeconds: uptimeSec,
          uptimeHuman: humanDuration(uptimeSec),
          environment: env,
          nodeVersion: process.version,
          jobsSchedulerEnabled: jobsSchedulerOn,
          admsSweeperEnabled: admsSweeperOn,
        },
      }
    },
  },

  // ---- 2. Database -------------------------------------------------------------
  {
    id: "database",
    label: "Database",
    fn: async () => {
      const t0 = Date.now()
      await db.$queryRaw`SELECT 1`
      const latencyMs = Date.now() - t0
      const vendorCount = await db.vendor.count()
      // migration state: nothing in the database records the applied-migration
      // count (hand-written additive SQL, applied out-of-band) — the honest
      // signal is the migration-folder count on disk, readably only when the
      // prisma/ directory ships with the runtime.
      let migrationFolders: number | null = null
      try {
        const entries = await readdir(path.join(process.cwd(), "prisma", "migrations"), { withFileTypes: true })
        migrationFolders = entries.filter((e) => e.isDirectory()).length
      } catch {
        migrationFolders = null // standalone builds may not ship prisma/
      }
      const status: HealthCheckStatus = latencyMs > 1500 ? "degraded" : "ok"
      return {
        status,
        detail: `SELECT 1 in ${latencyMs} ms · ${vendorCount} tenant row${vendorCount === 1 ? "" : "s"}`,
        meta: {
          latencyMs,
          vendorCount,
          migrationFolders,
          migrationStateNote:
            migrationFolders == null
              ? "prisma/migrations not readable from this runtime — applied count unknown"
              : "no applied-migration ledger exists in the database; the on-disk migration folder count is reported as-is",
        },
      }
    },
  },

  // ---- 3. Background Jobs (WP-A queue) ----------------------------------------
  {
    id: "jobs",
    label: "Background Jobs",
    fn: async () => {
      const [byStatus, stuckRunning, lastDone] = await Promise.all([
        db.bgJob.groupBy({ by: ["status"], _count: { _all: true } }),
        db.bgJob.aggregate({ where: { status: "RUNNING" }, _max: { startedAt: true } }),
        db.bgJob.aggregate({ where: { status: "DONE" }, _max: { finishedAt: true } }),
      ])
      const counts: Record<string, number> = { PENDING: 0, RUNNING: 0, DONE: 0, FAILED: 0, CANCELLED: 0, DEAD: 0 }
      for (const g of byStatus) counts[g.status] = g._count._all
      const oldestRunningAgeMin = ageMin(stuckRunning._max.startedAt)
      const lastFinishedAt = isoOrNull(lastDone._max.finishedAt)
      // dead-lettered rows need a human; a RUNNING claim older than 15 min means
      // the recoverStale sweep (5 min) is not ticking — both degrade the queue.
      const degraded =
        counts.DEAD > 0 ||
        (oldestRunningAgeMin != null && oldestRunningAgeMin > 15)
      return {
        status: degraded ? "degraded" : "ok",
        detail: degraded
          ? `${counts.DEAD} dead-lettered · oldest RUNNING ${oldestRunningAgeMin ?? "?"} min old`
          : `${counts.PENDING} pending · ${counts.RUNNING} running · ${counts.FAILED} failed · ${counts.DEAD} dead`,
        meta: {
          pending: counts.PENDING,
          running: counts.RUNNING,
          done: counts.DONE,
          failed: counts.FAILED,
          cancelled: counts.CANCELLED,
          dead: counts.DEAD,
          oldestRunningAgeMin,
          lastFinishedAt,
        },
      }
    },
  },

  // ---- 4. Email Gateway (platform plane) --------------------------------------
  {
    id: "email",
    label: "Email Gateway",
    fn: async () => {
      const gw = await getPlatformGateway()
      const configured = platformEmailConfigured(gw)
      // the platform notification feed: every send attempt lands in SaaSAuditLog
      // as NOTIFICATION_SENT/FAILED with a "[EMAIL]"/"[SMS]" summary prefix
      // (notify.ts logPlatformNotification) — latest row per channel + outcome.
      const [lastSent, lastFailed] = configured
        ? await Promise.all([
            db.saasAuditLog.findFirst({
              where: { action: "NOTIFICATION_SENT", summary: { startsWith: "[EMAIL]" } },
              orderBy: { createdAt: "desc" }, select: { createdAt: true },
            }),
            db.saasAuditLog.findFirst({
              where: { action: "NOTIFICATION_FAILED", summary: { startsWith: "[EMAIL]" } },
              orderBy: { createdAt: "desc" }, select: { createdAt: true },
            }),
          ])
        : [null, null]
      const lastSentAt = isoOrNull(lastSent?.createdAt)
      const lastFailedAt = isoOrNull(lastFailed?.createdAt)
      const failing = !!(lastFailedAt && (!lastSentAt || lastFailedAt > lastSentAt))
      const status: HealthCheckStatus = !configured ? "unknown" : failing ? "degraded" : "ok"
      return {
        status,
        detail: !configured
          ? "Not configured — platform emails (password resets, application confirmations) are skipped"
          : failing
            ? `Configured · last send attempt FAILED ${new Date(lastFailedAt as string).toISOString().slice(0, 16).replace("T", " ")}`
            : `Configured · last sent ${lastSentAt ? new Date(lastSentAt).toISOString().slice(0, 16).replace("T", " ") : "never"}`,
        meta: {
          configured,
          enabled: gw.email.enabled,
          hostSet: !!gw.email.host.trim(),
          credentialsPresent: !!gw.email.password && !!gw.email.username.trim(), // booleans only — never the values
          lastSentAt,
          lastFailedAt,
          source: "SaaSAuditLog NOTIFICATION_* rows (platform notification feed)",
        },
      }
    },
  },

  // ---- 5. SMS Gateway (platform config + tenant send log aggregate) -----------
  {
    id: "sms",
    label: "SMS Gateway",
    fn: async () => {
      const gw = await getPlatformGateway()
      const platformConfigured = platformSmsConfigured(gw)
      // tenant-plane aggregate: every blast/job SMS send lands in CommunicationLog
      // (channel SMS/BOTH) — latest SENT/PARTIAL and FAILED rows across ALL
      // vendors, clearly labeled aggregate (per-vendor detail lives in each
      // tenant's Communication Center).
      const [lastOk, lastFail, platformLastSent] = await Promise.all([
        db.communicationLog.findFirst({
          where: { channel: { in: ["SMS", "BOTH"] }, status: { in: ["SENT", "PARTIAL"] } },
          orderBy: { createdAt: "desc" }, select: { createdAt: true },
        }),
        db.communicationLog.findFirst({
          where: { channel: { in: ["SMS", "BOTH"] }, status: "FAILED" },
          orderBy: { createdAt: "desc" }, select: { createdAt: true },
        }),
        platformConfigured
          ? db.saasAuditLog.findFirst({
              where: { action: "NOTIFICATION_SENT", summary: { startsWith: "[SMS]" } },
              orderBy: { createdAt: "desc" }, select: { createdAt: true },
            })
          : Promise.resolve(null),
      ])
      const tenantLastSentAt = isoOrNull(lastOk?.createdAt)
      const tenantLastFailedAt = isoOrNull(lastFail?.createdAt)
      const platformLastSentAt = isoOrNull(platformLastSent?.createdAt)
      const failing = !!(tenantLastFailedAt && (!tenantLastSentAt || tenantLastFailedAt > tenantLastSentAt))
      const status: HealthCheckStatus = failing ? "degraded" : platformConfigured ? "ok" : "unknown"
      return {
        status,
        detail: failing
          ? `Tenant SMS aggregate: last send FAILED ${new Date(tenantLastFailedAt as string).toISOString().slice(0, 16).replace("T", " ")}`
          : platformConfigured
            ? `Platform gateway configured · tenant aggregate last sent ${tenantLastSentAt ? new Date(tenantLastSentAt).toISOString().slice(0, 16).replace("T", " ") : "never"}`
            : `Platform SMS not configured · tenant aggregate last sent ${tenantLastSentAt ? new Date(tenantLastSentAt).toISOString().slice(0, 16).replace("T", " ") : "never"}`,
        meta: {
          platformConfigured,
          platformEnabled: gw.sms.enabled,
          platformUrlSet: !!gw.sms.apiUrl.trim(),
          platformApiKeyPresent: !!gw.sms.apiKey, // boolean only — never the value
          platformLastSentAt,
          tenantAggregateLastSentAt: tenantLastSentAt,
          tenantAggregateLastFailedAt: tenantLastFailedAt,
          aggregateNote: "tenant CommunicationLog rows across ALL vendors (channel SMS/BOTH) — per-vendor detail stays in each workspace",
        },
      }
    },
  },

  // ---- 6. ZKTeco Gateway (/iclock ADMS plane) ---------------------------------
  {
    id: "zkteco",
    label: "ZKTeco Gateway",
    fn: async () => {
      const enabled = (process.env.ZKTECO_ADMS_ENABLED ?? "true") !== "false"
      const offlineThresholdMs =
        Math.max(30, Number(process.env.ATTENDANCE_DEVICE_OFFLINE_THRESHOLD_SECONDS || 300)) * 1000
      const [byStatus, enabledDevices, onlineDevices, lastEvent, lastSeen] = await Promise.all([
        db.attendanceDevice.groupBy({ by: ["status"], _count: { _all: true } }),
        db.attendanceDevice.count({ where: { enabled: true } }),
        db.attendanceDevice.count({
          where: { enabled: true, lastSeenAt: { gte: new Date(Date.now() - offlineThresholdMs) } },
        }),
        db.deviceCommLog.aggregate({ _max: { createdAt: true } }),
        db.attendanceDevice.aggregate({ where: { enabled: true }, _max: { lastSeenAt: true } }),
      ])
      const statusCounts: Record<string, number> = {}
      for (const g of byStatus) statusCounts[g.status] = g._count._all
      const lastIclockEventAt = isoOrNull(lastEvent._max.createdAt)
      const lastDeviceSeenAt = isoOrNull(lastSeen._max.lastSeenAt)
      const ratio = enabledDevices > 0 ? onlineDevices / enabledDevices : null
      let status: HealthCheckStatus
      let detail: string
      if (!enabled) {
        status = "unknown"
        detail = "ADMS gateway disabled via ZKTECO_ADMS_ENABLED — devices cannot push"
      } else if (enabledDevices === 0) {
        status = "ok"
        detail = "Gateway active · no attendance devices registered"
      } else if (onlineDevices === 0) {
        status = "degraded"
        detail = `All ${enabledDevices} enabled device${enabledDevices === 1 ? "" : "s"} offline (no push within threshold)`
      } else if (ratio != null && ratio < 0.5) {
        status = "degraded"
        detail = `${onlineDevices}/${enabledDevices} devices online (${Math.round(ratio * 100)}%)`
      } else {
        status = "ok"
        detail = `${onlineDevices}/${enabledDevices} devices online · last /iclock event ${lastIclockEventAt ? `${ageMin(lastEvent._max.createdAt)} min ago` : "never"}`
      }
      return {
        status,
        detail,
        meta: {
          enabled,
          enabledDevices,
          onlineDevices,
          onlineRatio: ratio == null ? null : Math.round(ratio * 100),
          offlineThresholdSeconds: offlineThresholdMs / 1000,
          storedStatusCounts: statusCounts, // stored column; live online = derived from lastSeenAt
          lastIclockEventAt,
          lastDeviceSeenAt,
        },
      }
    },
  },

  // ---- 7. Camera Services (provider reachability via WP-B sweep freshness) ---
  {
    id: "cameras",
    label: "Camera Services",
    fn: async () => {
      // NO outbound HTTP from the snapshot: the WP-B status sweep already polls
      // the brand clouds (≤1/vendor/10 min) — this check reports ITS freshness.
      const [byStatus, enabledCameras, total, lastCheck] = await Promise.all([
        db.camera.groupBy({ by: ["status"], _count: { _all: true } }),
        db.camera.count({ where: { enabled: true } }),
        db.camera.count(),
        db.camera.aggregate({ _max: { lastStatusCheckAt: true } }),
      ])
      const statusCounts: Record<string, number> = { ONLINE: 0, OFFLINE: 0, UNKNOWN: 0 }
      for (const g of byStatus) statusCounts[g.status] = g._count._all
      const lastStatusCheckAt = isoOrNull(lastCheck._max.lastStatusCheckAt)
      const sweepAgeMin = ageMin(lastCheck._max.lastStatusCheckAt)
      let status: HealthCheckStatus
      let detail: string
      if (total === 0) {
        status = "ok"
        detail = "No cameras registered"
      } else if (enabledCameras > 0 && sweepAgeMin != null && sweepAgeMin > 120) {
        status = "degraded"
        detail = `Status sweep stale — last provider check ${sweepAgeMin} min ago (expected ≤ 10 min per vendor)`
      } else if (enabledCameras > 0 && statusCounts.ONLINE === 0 && statusCounts.OFFLINE > 0) {
        status = "degraded"
        detail = `${statusCounts.OFFLINE} camera${statusCounts.OFFLINE === 1 ? "" : "s"} OFFLINE · 0 online`
      } else {
        status = "ok"
        detail = `${statusCounts.ONLINE} online · ${statusCounts.OFFLINE} offline · ${statusCounts.UNKNOWN} unknown of ${total}`
      }
      return {
        status,
        detail,
        meta: {
          totalCameras: total,
          enabledCameras,
          online: statusCounts.ONLINE,
          offline: statusCounts.OFFLINE,
          unknown: statusCounts.UNKNOWN,
          lastStatusCheckAt,
          sweepAgeMin,
          note: "provider reachability proxied by the WP-B camera status sweep — this snapshot makes no outbound calls",
        },
      }
    },
  },

  // ---- 8. Backup (WP-R — real SaasBackupRun history) -------------------------
  {
    id: "backup",
    label: "Backups",
    fn: async () => {
      // WP-R piggyback point: the cron-free nightly backup schedule is checked
      // lazily on console traffic — snapshot calls included (best-effort; a
      // schedule failure never blanks this check).
      await maybeRunScheduledBackup().catch(() => null)
      const [lastBackup, lastDrill] = await Promise.all([
        db.saasBackupRun.findFirst({ where: { type: "BACKUP" }, orderBy: { startedAt: "desc" } }),
        db.saasBackupRun.findFirst({ where: { type: "DRILL" }, orderBy: { startedAt: "desc" } }),
      ])
      const drillPass = lastDrill?.reportJson
        ? (j<{ pass?: boolean }>(lastDrill.reportJson, {}).pass ?? null)
        : null
      const lastBackupAt = isoOrNull(lastBackup?.startedAt)
      const lastDrillAt = isoOrNull(lastDrill?.startedAt)
      // No backup run has ever happened → the honest not-configured branch
      // (mirrors the pre-WP-R card; the deploy/backup.timer path cannot be
      // queried from inside the app).
      if (!lastBackup) {
        return {
          status: "unknown",
          detail: "Not configured — no backup has ever run from the platform (Backup & Recovery → Run Backup Now)",
          meta: {
            configured: false,
            lastBackupAt: null,
            lastBackupStatus: null,
            sizeBytes: null,
            lastDrillAt,
            lastDrillPass: drillPass,
            note: "no SaasBackupRun rows of type BACKUP exist; the offsite scripts/backup.sh + deploy/backup.timer path (if installed) records nothing the console can read",
          },
        }
      }
      // Freshness rule: nightly-enabled + last successful backup older than
      // 26 h (schedule 01:05 + a tolerance hour) → degraded "nightly overdue".
      // A FAILED latest backup or a FAILED latest drill are faults (a failed
      // drill is a P1 per docs/postgresql-backup-restore.md §5).
      const s = await getBackupSettings()
      const lastOkAt = lastBackup.status === "DONE" ? lastBackup.startedAt : null
      const ageH = lastOkAt ? (Date.now() - lastOkAt.getTime()) / 3_600_000 : null
      const nightlyOverdue = s.enabled && (lastOkAt == null || (ageH != null && ageH > 26))
      const drillFailed = !!lastDrill && lastDrill.status === "FAILED"
      const status: HealthCheckStatus =
        lastBackup.status === "FAILED" ? "degraded"
        : nightlyOverdue ? "degraded"
        : drillFailed ? "degraded"
        : "ok"
      const detailParts: string[] = []
      if (lastBackup.status === "FAILED") {
        detailParts.push(`last backup FAILED ${(lastBackup.finishedAt ?? lastBackup.startedAt).toISOString().slice(0, 16).replace("T", " ")}`)
      } else if (lastBackup.status === "RUNNING") {
        detailParts.push("backup currently running")
      } else if (nightlyOverdue) {
        detailParts.push(`nightly backup overdue — last success ${ageH != null ? `${Math.floor(ageH)} h ago` : "never"} (schedule ${s.scheduleTime} Asia/Dhaka)`)
      } else {
        detailParts.push(`last backup ${ageH != null ? `${Math.floor(ageH)} h ago` : "unknown age"} · ${lastBackup.status}`)
      }
      if (lastDrill) {
        detailParts.push(drillFailed
          ? `last drill FAILED ${new Date(lastDrill.startedAt).toISOString().slice(0, 16).replace("T", " ")}`
          : `last drill ${drillPass == null ? lastDrill.status : drillPass ? "passed" : "FAILED"} ${new Date(lastDrill.startedAt).toISOString().slice(0, 16).replace("T", " ")}`)
      } else {
        detailParts.push("no restore drill yet")
      }
      return {
        status,
        detail: detailParts.join(" · "),
        meta: {
          configured: true,
          lastBackupAt,
          lastBackupStatus: lastBackup.status,
          sizeBytes: lastBackup.sizeBytes,
          lastDrillAt,
          lastDrillPass: drillPass,
          nightlySchedule: s.enabled ? `${s.scheduleTime} Asia/Dhaka (piggyback on console traffic)` : "disabled",
          retention: s.retention,
          lastBackupChecksumPrefix: lastBackup.checksum ? lastBackup.checksum.slice(0, 16) : null,
          timerNote: "deploy/backup.timer + scripts/backup.sh remain the production-grade encrypted offsite path outside the app",
        },
      }
    },
  },

  // ---- 9. Storage (upload volume across ALL tenants) --------------------------
  {
    id: "storage",
    label: "Upload Storage",
    fn: async () => {
      // Same four inline-payload consumers entitlements.storageUsedBytes sums
      // per vendor — here as ONE raw UNION across all vendors (the dashboard's
      // per-vendor loop collapsed into a single query).
      const rows = await db.$queryRaw<Array<{ total: bigint }>>`
        SELECT COALESCE(SUM(LENGTH("photoUrl") + LENGTH("photoThumb")), 0) AS total FROM "Employee"
        UNION ALL
        SELECT COALESCE(SUM(LENGTH("fileData")), 0) FROM "EmployeeDocument"
        UNION ALL
        SELECT COALESCE(SUM(LENGTH("attachmentData")), 0) FROM "LeaveRequest"
        UNION ALL
        SELECT COALESCE(SUM(LENGTH("data")), 0) FROM "AttendanceProof"
      `
      const perConsumer = rows.map((r) => Number(r.total || 0))
      const usedBytes = perConsumer.reduce((a, b) => a + b, 0)
      const subs = await db.saasSubscription.findMany({
        where: { status: { in: ["TRIAL", "ACTIVE", "PAST_DUE", "GRACE_PERIOD"] } },
        select: { plan: { select: { storageGb: true } } },
      })
      const quotaGb = subs.reduce((a, s) => a + (s.plan?.storageGb || 0), 0)
      const quotaBytes = quotaGb * 1024 ** 3
      const usedPct = quotaBytes > 0 ? (usedBytes / quotaBytes) * 100 : null
      const status: HealthCheckStatus = usedPct != null && usedPct >= 90 ? "degraded" : "ok"
      return {
        status,
        detail:
          usedPct != null
            ? `${(usedBytes / 1024 ** 3).toFixed(2)} GB used of ${quotaGb} GB plan quota (${usedPct.toFixed(1)}%)`
            : `${(usedBytes / 1024 ** 3).toFixed(2)} GB used · no operating plan quota to compare against`,
        meta: {
          usedBytes,
          usedGb: Number((usedBytes / 1024 ** 3).toFixed(3)),
          quotaGb,
          usedPct: usedPct == null ? null : Number(usedPct.toFixed(1)),
          employeePhotosBytes: perConsumer[0] ?? 0,
          employeeDocumentsBytes: perConsumer[1] ?? 0,
          leaveAttachmentsBytes: perConsumer[2] ?? 0,
          selfieProofsBytes: perConsumer[3] ?? 0,
          trendNote: "no time-series of storage volume is recorded — a usage trend cannot be computed honestly",
        },
      }
    },
  },

  // ---- 10. Disk (app volume) ---------------------------------------------------
  {
    id: "disk",
    label: "Disk",
    fn: async () => {
      try {
        const st = await statfs("/") // Node 18+ — app volume the server runs on
        const totalBytes = st.bsize * st.blocks
        const freeBytes = st.bsize * st.bfree
        const availBytes = st.bsize * st.bavail
        const usedPct = st.blocks > 0 ? ((st.blocks - st.bfree) / st.blocks) * 100 : null
        const status: HealthCheckStatus =
          usedPct == null ? "unknown" : usedPct >= 97 ? "down" : usedPct >= 90 ? "degraded" : "ok"
        return {
          status,
          detail:
            usedPct == null
              ? "Filesystem stats unavailable"
              : `${usedPct.toFixed(1)}% used · ${(freeBytes / 1024 ** 3).toFixed(1)} GB free of ${(totalBytes / 1024 ** 3).toFixed(1)} GB`,
          meta: {
            mount: "/",
            totalBytes,
            freeBytes,
            availableBytes: availBytes,
            usedPct: usedPct == null ? null : Number(usedPct.toFixed(1)),
          },
        }
      } catch {
        return {
          status: "unknown",
          detail: "statfs unavailable on this runtime — disk usage cannot be measured",
          meta: { mount: "/", supported: false },
        }
      }
    },
  },

  // ---- 11. SSL Certificate (honest placeholder — future nightly job) ----------
  {
    id: "ssl",
    label: "SSL Certificate",
    fn: async () => {
      const s = await getSaasSettings()
      const raw = (s.general.websiteUrl || "").trim()
      let domain: string | null = null
      if (raw) {
        try {
          domain = new URL(raw.includes("://") ? raw : `https://${raw}`).hostname || null
        } catch {
          domain = null
        }
      }
      // Deliberately NO outbound TLS call from the snapshot: cert expiry will be
      // probed by a nightly maintenance job (not yet shipped) — this card states
      // the configured domain and reports daysLeft as an honest null meanwhile.
      if (!domain) {
        return {
          status: "unknown",
          detail: "No site domain configured (Platform Settings → General → Website URL)",
          meta: { configured: false, daysLeft: null },
        }
      }
      return {
        status: "unknown",
        detail: `${domain} — expiry checked by the nightly job (not yet shipped), no live probe from this snapshot`,
        meta: {
          configured: domain,
          daysLeft: null,
          note: "certificate expiry will be reported by a nightly maintenance job; this snapshot makes no outbound calls",
        },
      }
    },
  },

  // ---- 12. Failed Logins -------------------------------------------------------
  {
    id: "logins",
    label: "Failed Logins",
    fn: async () => {
      // The schema records failed attempts only as ROLLING per-user counters
      // (User.failedLoginCount / lockedUntil, mirrored on SaasOwnerUser) — no
      // timestamped attempt rows exist, so a true 24h window count cannot be
      // computed. The honest proxy: accounts currently locked + accounts
      // carrying a nonzero failure counter right now.
      const now = new Date()
      const [tenantLocked, tenantFlagged, ownerLocked, ownerFlagged] = await Promise.all([
        db.user.count({ where: { lockedUntil: { gt: now } } }),
        db.user.count({ where: { failedLoginCount: { gt: 0 } } }),
        db.saasOwnerUser.count({ where: { lockedUntil: { gt: now } } }),
        db.saasOwnerUser.count({ where: { failedLoginCount: { gt: 0 } } }),
      ])
      const locked = tenantLocked + ownerLocked
      return {
        status: locked > 0 ? "degraded" : "ok",
        detail:
          locked > 0
            ? `${locked} account${locked === 1 ? "" : "s"} currently locked out (${tenantLocked} tenant · ${ownerLocked} owner)`
            : `No locked accounts · ${tenantFlagged + ownerFlagged} user${tenantFlagged + ownerFlagged === 1 ? "" : "s"} carrying failed-attempt counters`,
        meta: {
          tenantUsersLocked: tenantLocked,
          tenantUsersWithFailures: tenantFlagged,
          ownerUsersLocked: ownerLocked,
          ownerUsersWithFailures: ownerFlagged,
          rollingCounterOnly: true,
          note: "failed attempts are stored as rolling per-user counters only — a 24h window count is not derivable from the schema",
        },
      }
    },
  },
]

// ============================== SNAPSHOT RPC ==============================

const STATUS_RANK: Record<HealthCheckStatus, number> = { down: 3, degraded: 2, unknown: 1, ok: 0 }

ownerAction("owner.health.snapshot", {
  perm: "health.view",
  handler: async () => {
    // parallel-safe: allSettled so one rejected promise can never blank the
    // console (runCheck additionally catches per-check internally).
    const settled = await Promise.allSettled(CHECKS.map((c) => runCheck(c.id, c.label, c.fn)))
    const checks = settled.map((r, i) =>
      r.status === "fulfilled"
        ? r.value
        : {
            id: CHECKS[i].id,
            label: CHECKS[i].label,
            status: "unknown" as HealthCheckStatus,
            detail: "Check did not return a result",
            lastCheckedAt: new Date().toISOString(),
            meta: {},
          }
    )
    const counts = { ok: 0, degraded: 0, down: 0, unknown: 0 }
    for (const c of checks) counts[c.status]++
    // Overall = worst FAULT present. "unknown" checks (Backup not configured,
    // SSL placeholder, unconfigured gateways) carry no fault signal on purpose —
    // they are surfaced in the counts and on their cards, but never drag a
    // healthy platform down to "degraded". Documented in overallNote.
    let overall: "ok" | "degraded" | "down" = "ok"
    for (const c of checks) {
      if ((c.status === "down" || c.status === "degraded") && STATUS_RANK[c.status] > STATUS_RANK[overall]) {
        overall = c.status
      }
    }
    return {
      overall,
      overallNote:
        "Overall = worst fault across checks (down > degraded). 'Unknown' checks (not-configured or placeholder data) are informational and do not lower the overall status.",
      counts,
      generatedAt: new Date().toISOString(),
      cacheTtlSec: CHECK_TTL_MS / 1000,
      checks,
    }
  },
})

// ============================== MANUAL ACTIONS ==============================
// All three: perm health.manage, saasAudit-logged, rate-limited 1/60s per action
// via module timestamps stored on globalThis (survives `next dev` reloads, which
// re-instantiate this module and would otherwise reset a plain module variable).

const RATE_KEY = Symbol.for("finix.hrm.healthActionAt")

function rateGuard(action: string): void {
  const g = globalThis as unknown as { [k: symbol]: Map<string, number> | undefined }
  const m = (g[RATE_KEY] ||= new Map<string, number>())
  const last = m.get(action) || 0
  const elapsed = Date.now() - last
  if (elapsed < 60_000) {
    const waitSec = Math.ceil((60_000 - elapsed) / 1000)
    throw Object.assign(
      new Error(`Rate limited — health test actions run at most once per 60 seconds. Try again in ${waitSec}s.`),
      { code: 429 }
    )
  }
  m.set(action, Date.now())
}

ownerAction("owner.health.testEmail", {
  perm: "health.manage",
  schema: z.object({ to: z.string().trim().email().max(160) }),
  handler: async (ctx, p) => {
    rateGuard("testEmail")
    const res = await sendPlatformEmail(
      p.to,
      "Finix HR — system health test",
      "This is a test email sent from the owner console System Health page.\n\nIf you can read this, the platform email gateway is working end-to-end.\n\n— Finix HR Platform"
    )
    await logPlatformNotification("EMAIL", "System health test", [p.to], res)
    await saasAudit(ctx, "HEALTH_TEST_EMAIL", "PlatformHealth", null,
      `System health test email to ${p.to}: ${res.status}`,
      { metadata: { to: p.to, status: res.status, detail: res.detail } })
    // send result only — { status, detail } — no gateway secrets
    return { result: res }
  },
})

ownerAction("owner.health.testSms", {
  perm: "health.manage",
  schema: z.object({ to: z.string().trim().min(6).max(24).regex(/^\+?[0-9][0-9\s()-]{5,22}$/) }),
  handler: async (ctx, p) => {
    rateGuard("testSms")
    const gw = await getPlatformGateway()
    if (!platformSmsConfigured(gw)) {
      // Best-effort + honest: the platform plane's own SMS gateway (notify.ts
      // sendPlatformSms) is unconfigured — nothing to test through. Tenant
      // workspaces each own their SMS settings, so the actionable path is a
      // test from a tenant's Communication Center.
      await saasAudit(ctx, "HEALTH_TEST_SMS", "PlatformHealth", null,
        `System health test SMS to ${p.to}: SKIPPED (platform SMS gateway not configured)`,
        { metadata: { to: p.to, status: "SKIPPED" } })
      return {
        result: { status: "SKIPPED" as const },
        ok: false,
        note: "The platform SMS gateway is not configured (Settings → Platform Gateway). Each tenant workspace owns its own SMS settings — run a test send from a tenant's Communication Center instead.",
      }
    }
    const res = await sendPlatformSms(p.to, "Finix HR system health test: if you can read this, the platform SMS gateway works.")
    await logPlatformNotification("SMS", "System health test", [p.to], res)
    await saasAudit(ctx, "HEALTH_TEST_SMS", "PlatformHealth", null,
      `System health test SMS to ${p.to}: ${res.status}`,
      { metadata: { to: p.to, status: res.status, detail: res.detail } })
    return { result: res }
  },
})

ownerAction("owner.health.clearCache", {
  perm: "health.manage",
  handler: async (ctx) => {
    const cleared = checkCache.size
    checkCache.clear()
    await saasAudit(ctx, "HEALTH_CACHE_CLEARED", "PlatformHealth", null,
      `System health check cache cleared (${cleared} cached check${cleared === 1 ? "" : "s"} — next snapshot recomputes live)`,
      { metadata: { cleared } })
    return { cleared, cacheTtlSec: CHECK_TTL_MS / 1000 }
  },
})

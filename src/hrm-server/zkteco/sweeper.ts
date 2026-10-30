// ============ Background sweeper (spec §17, §43) ============
// Started once per server process via src/instrumentation.ts (Node runtime).
// Responsibilities:
//   • process RECEIVED events (fast-path leftovers — e.g. process restart mid-batch)
//   • retry FAILED events with exponential backoff → dead-letter past the limit
//   • trim the operational comm log (raw attendance events are NEVER deleted — §42)
// Restart safety: the queue IS the database — a gateway restart simply resumes.

import { db } from "@/lib/db"
import { sweepOnce, autoCheckOnce, GATEWAY_ENV } from "./gateway"

const globalAny = globalThis as unknown as { __zkSweeperTimer?: NodeJS.Timeout; __zkSweeperStarted?: boolean }

const SWEEP_LOCK_KEY = "zkteco:sweepLock"
/** M-19 — the TTL is now purely a LIVENESS window (the holder renews every
 *  tick, i.e. every ADMS_SWEEP_INTERVAL_MS ≈ 15s). The old code never renewed:
 *  once claimed, the row went stale after 2 minutes and the NEXT claimer
 *  (possibly the same process) only re-claimed at the TTL boundary — so the
 *  effective sweep cadence was the TTL (2 min), not the configured 15s, and
 *  the "interval 15000ms" log line was a lie. 90s = 6 missed ticks before
 *  failover — a crashed holder releases the lock quickly. */
const SWEEP_LOCK_TTL_MS = 90_000
const LOCK_VENDOR = "__system__" // sentinel vendor for deployment-wide lock rows

/** M-19 — per-process owner id: the lock row records WHO holds it, so the
 *  holder can RENEW unconditionally instead of waiting to go stale. */
// 2026-10-07 — the owner id is per PROCESS (kept on globalThis), not per
// module instance: a dev reload re-evaluates this module, and a fresh owner
// id would have to wait out the TTL of its own predecessor's lock.
const globalSweeper = globalThis as unknown as { __zkSweepOwner?: string }
const SWEEP_OWNER = (globalSweeper.__zkSweepOwner ||= `swp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`)

type LockRow = { owner: string | null; at: number }
function parseLockRow(value: string): LockRow {
  try {
    const parsed = JSON.parse(value)
    if (parsed && typeof parsed === "object" && "at" in parsed) {
      return { owner: typeof parsed.owner === "string" ? parsed.owner : null, at: new Date(parsed.at).getTime() || 0 }
    }
    // legacy format (plain ISO timestamp, owner unknown) — claimable when stale
    return { owner: null, at: new Date(parsed).getTime() || 0 }
  } catch {
    return { owner: null, at: 0 }
  }
}

/** M-06/M-19 — DB-based sweep lock: multiple processes (or a stray duplicate
 *  container) can share one database; the lock row is claimed conditionally
 *  (stale → now) so exactly one sweeper instance runs per deployment.
 *  The holder RENEWS each tick (owner match ⇒ unconditional renewal), so the
 *  sweep cadence equals the configured interval and a crashed claimer
 *  self-heals after the liveness TTL. */
export async function claimSweepLock(): Promise<boolean> {
  const now = Date.now()
  const next = JSON.stringify({ owner: SWEEP_OWNER, at: new Date(now).toISOString() })
  const row = await db.hrSetting.findFirst({ where: { vendorId: LOCK_VENDOR, group: "sweeper", key: SWEEP_LOCK_KEY } })
  if (!row) {
    try {
      await db.hrSetting.create({
        data: { vendorId: LOCK_VENDOR, group: "sweeper", key: SWEEP_LOCK_KEY, value: next },
      })
      return true
    } catch { /* unique race — another process seeded it first */ }
    return false
  }
  const { owner, at } = parseLockRow(row.value)
  // M-19 — holder renews (keeps the cadence at the configured interval)
  if (owner === SWEEP_OWNER) {
    const res = await db.hrSetting.updateMany({ where: { id: row.id, value: row.value }, data: { value: next } })
    return res.count > 0
  }
  // absent owner (legacy row) or a dead holder past the liveness window
  if (owner == null || now - at > SWEEP_LOCK_TTL_MS) {
    const res = await db.hrSetting.updateMany({ where: { id: row.id, value: row.value }, data: { value: next } })
    return res.count > 0
  }
  return false
}

/** SCL-4 — one bounded, fair trim pass over the comm log (extracted from
 *  the tick for unit tests): skip-scan up to 100 vendors past the round-robin
 *  cursor, per vendor one indexed probe for the 20001st-newest row + one
 *  deleteMany. Retention semantics unchanged (newest 20k rows per vendor). */
export async function trimCommLogOnce(): Promise<number> {
  let purged = 0
  const TRIM_VENDORS_PER_PASS = 100
  const gTrim = globalThis as unknown as { __zkCommLogTrimCursor?: string }
  const cursor = gTrim.__zkCommLogTrimCursor || ""
  const vendorRows = await db.$queryRaw<Array<{ vendorId: string }>>`
    WITH RECURSIVE t AS (
      (SELECT "vendorId" FROM "DeviceCommLog"
       WHERE "vendorId" > ${cursor}
       ORDER BY "vendorId" LIMIT 1)
      UNION ALL
      SELECT (
        SELECT c."vendorId" FROM "DeviceCommLog" c
        WHERE c."vendorId" > t."vendorId"
        ORDER BY c."vendorId" LIMIT 1
      ) FROM t WHERE t."vendorId" IS NOT NULL
    )
    SELECT "vendorId" FROM t WHERE "vendorId" IS NOT NULL LIMIT ${TRIM_VENDORS_PER_PASS + 1}`
  const trimVendors = vendorRows.map((r) => r.vendorId)
  gTrim.__zkCommLogTrimCursor = trimVendors.length > TRIM_VENDORS_PER_PASS
    ? trimVendors[TRIM_VENDORS_PER_PASS - 1]
    : "" // exhausted — wrap so the next pass restarts from the head
  for (const v of trimVendors.slice(0, TRIM_VENDORS_PER_PASS)) {
    // one indexed probe: the row at position 20001 in the deterministic
    // (createdAt DESC, id DESC) total order — id breaks createdAt ties (a
    // bulk createMany lands thousands of rows on one timestamp), so the
    // keep-set is EXACTLY the newest 20000 and the delete predicate
    // (createdAt < T) OR (createdAt = T AND id <= anchorId) is tie-safe.
    const overflowAnchor = await db.deviceCommLog.findMany({
      where: { vendorId: v },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: 20000, take: 1,
      select: { createdAt: true, id: true },
    }).catch(() => [] as { createdAt: Date; id: string }[])
    if (!overflowAnchor.length) continue
    const anchor = overflowAnchor[0]
    const res = await db.deviceCommLog.deleteMany({
      where: {
        vendorId: v,
        OR: [
          { createdAt: { lt: anchor.createdAt } },
          { createdAt: anchor.createdAt, id: { lte: anchor.id } },
        ],
      },
    }).catch(() => ({ count: 0 }) as { count: number })
    purged += res.count
  }
  return purged
}

export function startSweeper() {
  // 2026-10-07 — a dev reload (fresh module instance) REPLACES the running
  // timer instead of returning early: the old guard kept the FIRST loaded
  // copy of the gateway/processor code sweeping until a full restart, so
  // pipeline fixes never reached queued events. Still exactly one timer.
  if (globalAny.__zkSweeperTimer) clearInterval(globalAny.__zkSweeperTimer)
  globalAny.__zkSweeperStarted = true
  const intervalMs = Number(process.env.ADMS_SWEEP_INTERVAL_MS || 15000)
  const tick = async () => {
    try {
      // M-06 — only the lock holder sweeps; the tick stays cheap for others
      if (await claimSweepLock()) {
        await sweepOnce()
      }
    } catch (e) {
      console.error("[zkteco] sweep error", e)
    }
    try {
      // automatic attendance pull — queue CHECK for every connected device on
      // the ADMS_AUTO_CHECK_SECONDS cadence (no-op when disabled/interval young)
      await autoCheckOnce()
    } catch (e) {
      console.error("[zkteco] auto-check error", e)
    }
    try {
      // M-06 + SCL-4 (Phase 2 WS2) — trim the comm log PER VENDOR (newest 20k
      // rows each), not globally: one noisy tenant can no longer evict another
      // tenant's operational history (raw attendance events are NEVER deleted
      // — §42).
      // SCL-4 — the old trim ran a FULL-TABLE groupBy(vendorId) + per-vendor
      // overflow scan EVERY 15s TICK. Now: hourly cadence (configurable) and
      // the bounded fair trimCommLogOnce() pass (skip-scan + indexed probes,
      // never a full-table aggregate).
      const trimIntervalMs = Math.max(60_000, Number(process.env.ADMS_COMMLOG_TRIM_INTERVAL_MS) || 3_600_000)
      const gTrim = globalThis as unknown as { __zkCommLogTrimAt?: number }
      if (Date.now() - (gTrim.__zkCommLogTrimAt || 0) >= trimIntervalMs) {
        gTrim.__zkCommLogTrimAt = Date.now()
        const purged = await trimCommLogOnce()
        if (purged > 0) console.log(`[zkteco] comm-log trim purged ${purged} row(s) (per-vendor 20k retention)`)
      }
    } catch { /* non-fatal */ }
    try {
      // the auto-CHECK loop creates a steady stream of deviceCommand rows — trim
      // finished commands older than 7 days so the queue history stays bounded
      await db.deviceCommand.deleteMany({
        where: { status: { in: ["DONE", "FAILED"] }, createdAt: { lt: new Date(Date.now() - 7 * 86400000) } },
      })
    } catch { /* non-fatal */ }
    try {
      // M-06 — sweep expired throttle buckets (fixed-window rows)
      const { purgeThrottleRows } = await import("../security")
      await purgeThrottleRows()
    } catch { /* non-fatal */ }
    try {
      // MED-18 (this audit) — sweep expired punch photos older than
      // ADMS_PHOTO_RETENTION_DAYS (default 30). Photos are biometric PII
      // (face snapshots) and must not accumulate indefinitely.
      const retentionDays = Number(process.env.ADMS_PHOTO_RETENTION_DAYS || 30)
      if (retentionDays > 0) {
        const pathMod = await import("node:path")
        const photoRoot = pathMod.join(process.cwd(), "storage", "punch-photos")
        const cutoff = Date.now() - retentionDays * 86400000
        try {
          const fs = await import("node:fs/promises")
          if (await fs.stat(photoRoot).then(() => true).catch(() => false)) {
            for (const dir of await fs.readdir(photoRoot)) {
              const deviceDir = pathMod.join(photoRoot, dir)
              for (const file of await fs.readdir(deviceDir).catch(() => [])) {
                const fp = pathMod.join(deviceDir, file)
                const st = await fs.stat(fp).catch(() => null)
                if (st && st.mtimeMs < cutoff) {
                  await fs.unlink(fp).catch(() => {})
                }
              }
            }
          }
        } catch { /* non-fatal — sweep failure does not block the tick */ }
      }
    } catch { /* non-fatal */ }
  }
  globalAny.__zkSweeperTimer = setInterval(tick, intervalMs)
  globalAny.__zkSweeperTimer.unref?.() // never block process exit
  console.log(`[zkteco] sweeper started (interval ${intervalMs}ms, auto-check ${GATEWAY_ENV.autoCheckSec()}s)`)
  setTimeout(tick, 3000).unref?.() // early first pass
}

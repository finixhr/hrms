// ============ Metrics foundation (Phase 1, OPS-4 + roadmap WS "Metrics") ============
// Route timing, scheduler-tick duration and queue gauges, exposed through the
// internal-token-gated /api/metrics endpoint in Prometheus text format.
//
// Design constraints (from the audit):
//   - The OLD /api/metrics ran ~10 unbounded COUNT(*) queries PER SCRAPE —
//     at 100K tenants it was the most expensive endpoint on the platform
//     (OPS-4). Every DB-derived number here is now served from a TTL cache
//     (30 s): a scrape is a few in-memory reads, and the DB pays one COUNT
//     round per 30 s regardless of scrape frequency.
//   - RPC timing buckets by MODULE FAMILY (the first segment of the action —
//     employees, attendance, payroll, auth…), NOT per action: per-action
//     labels would make cardinality unbounded (~700 actions × replicas).
//     Each family keeps a ring of the last 256 observations; percentiles are
//     computed on read (≤60 families × 256 samples = trivial).
//   - Everything is in-process memory (single-instance Phase 1 scope); the
//     Phase 3 multi-instance work moves the tick/queue gauges to shared
//     state. The /api/metrics AUTH model (fail-closed without
//     HRM_INTERNAL_TOKEN) is unchanged.
import { db } from "@/lib/db"
// Wave 11 §13 (2026-10-26) — cache + outbox gauges for the observability
// contract ("cache hit rate, misses… availability" / "queue depth, job
// latency, retry counts, and failures"). cache.ts is dependency-free, so
// this import cannot cycle.
import { cacheStats, cacheBackend } from "./cache"

// ---------- RPC route timing ----------
type FamilyStat = {
  samples: number[] // ring of the last N durations (ms)
  count: number // total observations since process start
  errors: number
  lastMs: number
}
const RPC_RING = 256
const rpcFamilies = new Map<string, FamilyStat>()

// R6-001 — cap the number of tracked families to prevent unbounded map growth
// from attacker-controlled or malformed action strings reaching observeRpc.
const MAX_RPC_FAMILIES = 128

function familyStat(family: string): FamilyStat {
  let st = rpcFamilies.get(family)
  if (!st) {
    // Drop the observation silently when the cap is hit; this prevents a
    // cardinality explosion from crafted action names.
    if (rpcFamilies.size >= MAX_RPC_FAMILIES) return { samples: [], count: 0, errors: 0, lastMs: 0 }
    st = { samples: [], count: 0, errors: 0, lastMs: 0 }
    rpcFamilies.set(family, st)
  }
  return st
}

/** Bucket an action into its module family (bounded cardinality). */
export function rpcFamily(action: string): string {
  const a = String(action || "").trim()
  if (!a || !a.includes(".")) return "_dispatch" // rejected before the action parsed
  return a.split(".")[0]
}

/** Record one RPC observation (duration in ms, success flag). */
export function observeRpc(action: string, ms: number, ok: boolean): void {
  const st = familyStat(rpcFamily(action))
  st.count++
  if (!ok) st.errors++
  st.lastMs = Math.round(ms)
  st.samples.push(Math.round(ms))
  if (st.samples.length > RPC_RING) st.samples.splice(0, st.samples.length - RPC_RING)
}

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[idx]
}

// ---------- scheduler tick timing ----------
type TickStat = {
  durations: number[] // ring of the last 64 tick durations (ms)
  lastVendors: number
  lastAt: number
  total: number
}
const TICK_RING = 64
const tickStat: TickStat = { durations: [], lastVendors: 0, lastAt: 0, total: 0 }

/** Record one completed scheduler pass. */
export function observeTick(durationMs: number, vendors: number): void {
  tickStat.durations.push(Math.round(durationMs))
  if (tickStat.durations.length > TICK_RING) tickStat.durations.splice(0, tickStat.durations.length - TICK_RING)
  tickStat.lastVendors = vendors
  tickStat.lastAt = Date.now()
  tickStat.total++
}

// ---------- TTL-cached DB counts (OPS-4) ----------
const COUNT_TTL_MS = 30_000
const countCache = new Map<string, { at: number; value: number }>()

/** COUNT-style gauge served from a 30 s cache; failures return -1 (cached). */
export async function cachedCount(key: string, fn: () => Promise<number>): Promise<number> {
  const hit = countCache.get(key)
  if (hit && Date.now() - hit.at < COUNT_TTL_MS) return hit.value
  const value = await fn().catch(() => -1)
  countCache.set(key, { at: Date.now(), value })
  return value
}

/** Test hook — wipe caches. */
export function resetMetricsForTest(): void {
  rpcFamilies.clear()
  tickStat.durations = []
  tickStat.lastVendors = 0
  tickStat.lastAt = 0
  tickStat.total = 0
  countCache.clear()
}

// ---------- owner-console snapshot (Phase 5 P0 — Performance panel) ----------

export type RpcFamilySnapshot = {
  family: string
  count: number
  errors: number
  errorRate: number
  lastMs: number
  p50Ms: number
  p95Ms: number
  /** Wave 11 §13 — p99 was missing from the original contract ("latency
   * percentiles, including p50, p95, and p99"). Same ring, same math. */
  p99Ms: number
  /** The raw ring (≤256 most recent observations, oldest first) — the UI
   * renders it as a sparkline. NEVER grows unbounded. */
  samples: number[]
}

export type MetricsSnapshot = {
  generatedAt: string
  uptimeSeconds: number
  families: RpcFamilySnapshot[]
  tick: { total: number; lastMs: number; p95Ms: number; p99Ms: number; lastVendors: number; lastAt: number | null }
}

/** Read-only view of the in-memory rings for the owner Performance panel
 *  (owner.metrics.snapshot). No DB reads at all — the Prometheus endpoint
 *  keeps its TTL-cached DB gauges; this snapshot stays free of query cost. */
export function snapshotForOwner(): MetricsSnapshot {
  const families: RpcFamilySnapshot[] = [...rpcFamilies.entries()]
    .map(([family, st]) => {
      const sorted = [...st.samples].sort((a, b) => a - b)
      return {
        family,
        count: st.count,
        errors: st.errors,
        errorRate: st.count ? st.errors / st.count : 0,
        lastMs: st.lastMs,
        p50Ms: percentile(sorted, 50),
        p95Ms: percentile(sorted, 95),
        p99Ms: percentile(sorted, 99),
        samples: [...st.samples],
      }
    })
    .sort((a, b) => b.p95Ms - a.p95Ms) // slowest families first — the panel's point
  const tickSorted = [...tickStat.durations].sort((a, b) => a - b)
  return {
    generatedAt: new Date().toISOString(),
    uptimeSeconds: Math.round(process.uptime()),
    families,
    tick: {
      total: tickStat.total,
      lastMs: tickStat.durations.length ? tickStat.durations[tickStat.durations.length - 1] : 0,
      p95Ms: percentile(tickSorted, 95),
      p99Ms: percentile(tickSorted, 99),
      lastVendors: tickStat.lastVendors,
      lastAt: tickStat.lastAt || null,
    },
  }
}

// ---------- Prometheus text rendering ----------
function esc(v: string): string {
  return v.replace(/"/g, '\\"')
}

function gauge(name: string, value: number, labels: Record<string, string> = {}, help = ""): string {
  const lbl = Object.entries(labels).map(([k, v2]) => `${k}="${esc(v2)}"`).join(",")
  const lines: string[] = []
  if (help) lines.push(`# HELP ${name} ${help}`)
  lines.push(`# TYPE ${name} gauge`)
  lines.push(lbl ? `${name}{${lbl}} ${value}` : `${name} ${value}`)
  return lines.join("\n")
}

/** Assemble the full exposition text (async: DB-derived numbers via cache). */
export async function renderPrometheus(): Promise<string> {
  const out: string[] = []
  out.push(gauge("hrm_uptime_seconds", Math.round(process.uptime()), {}, "Process uptime in seconds"))

  // ---- RPC route timing (p50/p95 per module family) ----
  const families = [...rpcFamilies.entries()].sort(([a], [b]) => a.localeCompare(b))
  for (const [family, st] of families) {
    const sorted = [...st.samples].sort((a, b) => a - b)
    const lbl = { family }
    out.push(gauge("hrm_rpc_requests_total", st.count, lbl, "RPC requests observed for this module family"))
    out.push(gauge("hrm_rpc_errors_total", st.errors, lbl, "RPC error responses for this module family"))
    out.push(gauge("hrm_rpc_duration_ms_last", st.lastMs, lbl, "Most recent RPC duration (ms)"))
    out.push(gauge("hrm_rpc_duration_ms_p50", percentile(sorted, 50), lbl, "RPC duration p50 over the in-memory ring (ms)"))
    out.push(gauge("hrm_rpc_duration_ms_p95", percentile(sorted, 95), lbl, "RPC duration p95 over the in-memory ring (ms)"))
    out.push(gauge("hrm_rpc_duration_ms_p99", percentile(sorted, 99), lbl, "RPC duration p99 over the in-memory ring (ms) — Wave 11 §13"))
  }

  // ---- scheduler tick ----
  const tickSorted = [...tickStat.durations].sort((a, b) => a - b)
  out.push(gauge("hrm_jobs_tick_total", tickStat.total, {}, "Scheduler passes completed since process start"))
  out.push(gauge("hrm_jobs_tick_duration_ms_last", tickSorted.length ? tickStat.durations[tickStat.durations.length - 1] : 0, {}, "Most recent scheduler tick duration (ms)"))
  out.push(gauge("hrm_jobs_tick_duration_ms_p95", percentile(tickSorted, 95), {}, "Scheduler tick duration p95 over the in-memory ring (ms)"))
  out.push(gauge("hrm_jobs_tick_duration_ms_p99", percentile(tickSorted, 99), {}, "Scheduler tick duration p99 over the in-memory ring (ms) — Wave 11 §13"))
  out.push(gauge("hrm_jobs_tick_vendors_last", tickStat.lastVendors, {}, "Vendors covered by the most recent tick"))
  if (tickStat.lastAt) out.push(gauge("hrm_jobs_tick_last_at_seconds", Math.round(tickStat.lastAt / 1000), {}, "Unix time of the most recent tick"))

  // ---- queue + platform gauges (OPS-4: TTL-cached, one COUNT per 30 s) ----
  const pendingJobs = await cachedCount("bgjob:pending", () => db.bgJob.count({ where: { status: "PENDING" } }))
  out.push(gauge("hrm_bgjob_pending", pendingJobs, {}, "Pending background jobs (30s cached)"))
  const runningJobs = await cachedCount("bgjob:running", () => db.bgJob.count({ where: { status: "RUNNING" } }))
  out.push(gauge("hrm_bgjob_running", runningJobs, {}, "Running background jobs (30s cached)"))
  const failedJobs = await cachedCount("bgjob:failed", () => db.bgJob.count({ where: { status: "FAILED" } }))
  out.push(gauge("hrm_bgjob_failed", failedJobs, {}, "Failed background jobs (terminal; 30s cached)"))

  const rawReceived = await cachedCount("raw:received", () => db.attendanceRawEvent.count({ where: { processingStatus: "RECEIVED" } }))
  out.push(gauge("hrm_zkteco_raw_received", rawReceived, {}, "Raw events awaiting processing (30s cached)"))
  const rawDead = await cachedCount("raw:dead_letter", () => db.attendanceRawEvent.count({ where: { processingStatus: "DEAD_LETTER" } }))
  out.push(gauge("hrm_zkteco_raw_dead_letter", rawDead, {}, "Dead-lettered raw events (terminal; 30s cached)"))
  const rawOow = await cachedCount("raw:out_of_window", () => db.attendanceRawEvent.count({ where: { processingStatus: "OUT_OF_WINDOW" } }))
  out.push(gauge("hrm_zkteco_raw_out_of_window", rawOow, {}, "Quarantined out-of-window raw events awaiting historical sync (30s cached)"))

  const onlineDevices = await cachedCount("devices:online", () => db.attendanceDevice.count({ where: { status: "ONLINE", enabled: true } }))
  out.push(gauge("hrm_devices_online", onlineDevices, {}, "Online attendance devices (30s cached)"))
  const employees = await cachedCount("employees:total", () => db.employee.count())
  out.push(gauge("hrm_employees_total", employees, {}, "Total employee rows (30s cached)"))
  const users = await cachedCount("users:total", () => db.user.count())
  out.push(gauge("hrm_users_total", users, {}, "Total user rows (30s cached)"))
  const cameras = await cachedCount("cameras:enabled", () => db.camera.count({ where: { enabled: true } }))
  out.push(gauge("hrm_cameras_total", cameras, {}, "Enabled cameras (30s cached)"))

  // ---- Wave 11 §13 — transactional outbox gauges (30s cached COUNTs) ----
  const outboxPending = await cachedCount("outbox:pending", () => db.outboxEvent.count({ where: { status: "PENDING" } }))
  out.push(gauge("hrm_outbox_pending", outboxPending, {}, "Transactional-outbox events awaiting delivery (30s cached)"))
  const outboxProcessing = await cachedCount("outbox:processing", () => db.outboxEvent.count({ where: { status: "PROCESSING" } }))
  out.push(gauge("hrm_outbox_processing", outboxProcessing, {}, "Transactional-outbox events claimed by a relay right now (30s cached)"))
  const outboxFailed = await cachedCount("outbox:failed", () => db.outboxEvent.count({ where: { status: "FAILED" } }))
  out.push(gauge("hrm_outbox_failed", outboxFailed, {}, "Dead-lettered outbox events needing ops follow-up (terminal; 30s cached)"))

  // ---- Wave 11 §13 — shared-cache gauges (in-process counters) ----
  const cs = cacheStats()
  out.push(gauge("hrm_cache_backend", cacheBackend() === "redis" ? 1 : 0, {}, "Shared L2 cache backend: 1 = Redis reachable, 0 = per-process fallback"))
  out.push(gauge("hrm_cache_hits_total", cs.hits, {}, "L2 cache read hits since process start"))
  out.push(gauge("hrm_cache_misses_total", cs.misses, {}, "L2 cache read misses since process start (each implies a DB re-derive)"))
  out.push(gauge("hrm_cache_sets_total", cs.sets, {}, "L2 cache writes since process start"))
  out.push(gauge("hrm_cache_deletes_total", cs.deletes, {}, "L2 cache invalidations (cluster-wide DELs) since process start"))
  out.push(gauge("hrm_cache_errors_total", cs.errors, {}, "L2 cache backend errors since process start"))

  return out.join("\n") + "\n"
}

// ============ Server lifecycle — graceful shutdown + BgJob recovery ============
// HIGH-4 (this audit) — the previous codebase had NO SIGTERM/SIGINT handler
// anywhere in the repo. In-flight BgJob runners were killed mid-execution on
// every deploy/restart, leaving RUNNING rows stuck forever (no
// recoverStaleClaims equivalent for BgJob existed).
//
// This module registers process-level signal handlers and exposes:
//   - registerShutdownHandlers()   — wires SIGTERM/SIGINT to gracefulShutdown()
//   - gracefulShutdown()           — awaits currentDrain, flips shuttingDown flag
//   - recoverStaleBgJobs()         — resets RUNNING rows older than 5 min to PENDING
//                                    (mirrors ZKTeco's recoverStaleClaims pattern)
//   - isShuttingDown()             — for drainJobs to refuse new claims during shutdown
//
// The handlers are idempotent — safe to call from every boot path.

import { db } from "@/lib/db"

let shuttingDown = false
const STALE_BG_JOB_MS = 5 * 60_000 // 5 min — same as ZKTeco recoverStaleClaims

/** True once SIGTERM/SIGINT has been received. drainJobs checks this to refuse
 *  new claims during the shutdown drain window. */
export function isShuttingDown(): boolean {
  return shuttingDown
}

/** HIGH-4 — reset BgJob rows stuck in RUNNING after a crash back to PENDING.
 *  Mirrors the ZKTeco recoverStaleClaims pattern. Idempotent + safe to call
 *  from any caller. Returns the count of recovered rows. */
export async function recoverStaleBgJobs(): Promise<number> {
  const staleBefore = new Date(Date.now() - STALE_BG_JOB_MS)
  try {
    const res = await db.bgJob.updateMany({
      where: { status: "RUNNING", startedAt: { lt: staleBefore } },
      data: { status: "PENDING", startedAt: null, error: "RECOVERED: stale RUNNING claim reset to PENDING by recoverStaleBgJobs" },
    })
    if (res.count > 0) {
      console.log(`[lifecycle] recovered ${res.count} stale BgJob row(s) from RUNNING to PENDING`)
    }
    return res.count
  } catch (e: any) {
    console.error("[lifecycle] recoverStaleBgJobs failed:", e?.message || e)
    return 0
  }
}

/** HIGH-4 — graceful shutdown: flip shuttingDown flag, await current drain,
 *  give in-flight requests up to 30s to complete. */
export async function gracefulShutdown(signal: string): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  console.log(`[lifecycle] ${signal} received — draining in-flight work (max 30s)`)
  try {
    // Try to import the jobs module dynamically so we don't create a circular
    // dependency at module load time. The import is best-effort: if the jobs
    // module isn't loaded yet (e.g. ZKTECO_ADMS_ENABLED=false), skip silently.
    const jobsMod = await import("./jobs").catch(() => null)
    if (jobsMod && typeof jobsMod.awaitDrain === "function") {
      await Promise.race([
        jobsMod.awaitDrain(),
        new Promise((resolve) => setTimeout(resolve, 30_000)),
      ])
    }
  } catch (e: any) {
    console.error("[lifecycle] drain error during shutdown:", e?.message || e)
  }
  console.log("[lifecycle] drain complete — exiting")
  // Give the process one last tick to flush stdout/stderr, then exit.
  setTimeout(() => process.exit(0), 250).unref()
}

// ---------- process-wide listener registry (2026-10-07) ----------
// Root cause of the dev-server "MaxListenersExceededWarning": `next dev`
// re-runs instrumentation.register() whenever a server module it imports is
// edited, with FRESH module instances — so the old module-level
// `shutdownRegistered` flag was reset on every reload and each reload stacked
// another SIGTERM / SIGINT / uncaughtException / unhandledRejection (and
// SIGUSR2) listener on the one long-lived `process`. After ~10 reloads Node
// warned. The registry lives on globalThis (shared by every module instance
// of the process): re-registering REPLACES this app's previous listener for
// that event — exactly one listener per event, always running the latest code.
type ProcessHandlerRegistry = Map<string, (...args: any[]) => void>
const REGISTRY_KEY = Symbol.for("finix.hrm.processHandlers")

export function setProcessHandler(event: string, handler: (...args: any[]) => void): void {
  const g = globalThis as unknown as Record<symbol, ProcessHandlerRegistry | undefined>
  const registry = (g[REGISTRY_KEY] ||= new Map())
  const p = process as unknown as {
    on: (e: string, fn: (...args: any[]) => void) => void
    off: (e: string, fn: (...args: any[]) => void) => void
  }
  const previous = registry.get(event)
  if (previous) p.off(event, previous)
  registry.set(event, handler)
  p.on(event, handler)
}

/** HIGH-4 — register SIGTERM/SIGINT handlers. Idempotent per process (safe to
 *  call on every dev reload — handlers are replaced, never stacked). */
export function registerShutdownHandlers(): void {
  // Only register in the Node runtime (not Edge).
  if (process.env.NEXT_RUNTIME !== "nodejs") return
  setProcessHandler("SIGTERM", () => void gracefulShutdown("SIGTERM"))
  setProcessHandler("SIGINT", () => void gracefulShutdown("SIGINT"))
  // Also register a process-level uncaughtException handler so a thrown error
  // in the jobs tick doesn't leave the process in a half-dead state.
  setProcessHandler("uncaughtException", (err: any) => {
    console.error("[lifecycle] uncaughtException:", err?.message || err)
    if (process.env.NODE_ENV === "production") void gracefulShutdown("uncaughtException")
  })
  setProcessHandler("unhandledRejection", (reason: any) => {
    console.error("[lifecycle] unhandledRejection:", reason)
  })
  console.log("[lifecycle] SIGTERM/SIGINT handlers registered")
}

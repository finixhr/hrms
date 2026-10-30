// ============ Chunk-load self-healing (2026-10-12) ============
// The tenant portal SPA lazy-loads 42 module views through next/dynamic. A
// lazy chunk request can fail TRANSIENTLY when:
//   · the dev server recompiled (Turbopack invalidates chunk names) while the
//     tab held a stale manifest — e.g. HMR was blocked, the server restarted,
//     or a cloud-sync client (Google Drive/OneDrive/Dropbox) touched files;
//   · a production deploy swapped the build while a tab was open;
//   · a flaky network dropped the chunk request.
// Previously ANY of these surfaced as a hard Runtime ChunkLoadError that
// unmounted the whole workspace until the user manually refreshed.
//
// This module gives the app three layers of recovery:
//   1. withChunkRetry() — silently re-attempts the dynamic import once
//      (a re-invoked import() refetches the chunk; transient 404s clear).
//   2. healStaleChunk() — a GUARDED one-shot window.location.reload() (at
//      most once per RELOAD_WINDOW_MS) that picks up the fresh manifest,
//      exactly like the manual refresh users had to do — but automatic and
//      loop-safe.
//   3. isChunkLoadError() — pattern matcher shared by the retry wrapper, the
//      view error boundary and the global error listeners.
"use client"

/** Message fragments that identify a failed chunk/module-script load across
 * bundlers (Turbopack/webpack) and browsers (Chrome/Firefox/Safari/Edge). */
const CHUNK_ERR_PATTERNS = [
  "failed to load chunk", // Next 16 Turbopack / webpack core message
  "loading chunk", // webpack "Loading chunk 12 failed…"
  "chunkloaderror", // error.name.toLowerCase() collapsed into message
  "failed to fetch dynamically imported module", // native ESM import()
  "importing a module script failed", // Firefox variant
  "error loading dynamically imported module", // Safari/older Chromium
]

export function isChunkLoadError(err: unknown): boolean {
  if (err == null) return false
  const msg = (
    err instanceof Error
      ? `${err.name} ${err.message}`
      : typeof err === "string"
        ? err
        : String((err as { message?: unknown }).message ?? err)
  ).toLowerCase()
  return CHUNK_ERR_PATTERNS.some((p) => msg.includes(p))
}

const RELOAD_KEY = "hrm_chunk_reload_at"
const RELOAD_WINDOW_MS = 15_000

/** One guarded reload per window — never a reload loop. Returns true when a
 * reload was triggered (the caller should stop trying afterwards). */
export function healStaleChunk(): boolean {
  if (typeof window === "undefined") return false
  let last = 0
  try {
    last = Number(window.sessionStorage.getItem(RELOAD_KEY) || 0) || 0
  } catch {
    return false // storage unavailable (private mode) — never auto-reload blindly
  }
  if (Date.now() - last < RELOAD_WINDOW_MS) return false // just reloaded — don't loop
  try {
    window.sessionStorage.setItem(RELOAD_KEY, String(Date.now()))
  } catch {
    /* ignore — the reload below still proceeds */
  }
  window.location.reload()
  return true
}

/** Wrap a next/dynamic loader with one silent retry + guarded reload.
 * Non-chunk errors (real code bugs) pass straight through untouched — this
 * never masks genuine defects, only transient transport failures. */
export function withChunkRetry<T>(load: () => Promise<T>): Promise<T> {
  return load().catch((err: unknown) => {
    if (!isChunkLoadError(err)) throw err
    // transient chunk failure — one retry after a short beat (dev server may
    // still be writing the replacement chunk)
    return new Promise<T>((resolve, reject) => {
      setTimeout(() => load().then(resolve, reject), 300)
    })
  }).catch((err: unknown) => {
    // retry failed (or first failure was non-chunk) — reload heals a stale
    // manifest; if a reload happened recently the boundary takes over
    if (isChunkLoadError(err) && typeof window !== "undefined") healStaleChunk()
    throw err
  })
}

"use client"
// ============ RPC API client ============
import { useCallback, useEffect, useRef, useState } from "react"

// H-08 — legacy localStorage keys. Kept ONLY as identifiers for one-time
// cleanup of values written by pre-remediation builds; nothing is ever
// written to them anymore. The httpOnly SameSite=None; Secure; Partitioned
// cookie is the SOLE persistent auth transport.
export const TOKEN_KEY = "hrm_token"
export const CSRF_KEY = "hrm_csrf"

// H-08 — memory-only auth state.
//  - memoryBearer: short-lived (5-minute) fallback for embedded contexts where
//    the browser rejects cookies. Never persisted; cleared on logout and
//    whenever the server answers 401. Refreshed silently on tab focus via
//    auth.me (cookie path) in store.ts.
//  - memoryCsrf: the C-4 CSRF token echo for cookie-authenticated calls.
//    Bootstrapped from the CSRF-exempt auth.me response after each hard
//    reload, and refreshed whenever the server attaches a new token.
let memoryBearer: { token: string; expiresAt: number } | null = null
let memoryCsrf: string | null = null

export function setMemoryBearer(token: string | null, ttlMs = 5 * 60_000) {
  memoryBearer = token ? { token, expiresAt: Date.now() + ttlMs } : null
}

export function saveCsrfToken(token?: string | null) {
  memoryCsrf = token || null
  // H-08 — scrub any copy a pre-remediation build left in localStorage
  if (typeof window !== "undefined" && token) {
    try { window.localStorage.removeItem(CSRF_KEY) } catch { /* private mode */ }
  }
}

/** H-08 — one-time cleanup of values written by pre-remediation builds. */
export function purgeLegacyWebStorage() {
  if (typeof window === "undefined") return
  try {
    window.localStorage.removeItem(TOKEN_KEY)
    window.localStorage.removeItem(CSRF_KEY)
  } catch { /* private mode */ }
}

/** Error type carrying a machine-readable timeout marker so UIs can offer a
 *  retry affordance (M-04) instead of a dead error banner. */
export class RpcError extends Error {
  code?: number
  timedOut?: boolean
  constructor(message: string, opts?: { code?: number; timedOut?: boolean }) {
    super(message)
    this.name = "RpcError"
    this.code = opts?.code
    this.timedOut = opts?.timedOut
  }
}

export async function rpc<T = any>(action: string, payload?: Record<string, unknown>, opts?: { signal?: AbortSignal }): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json" }
  // H-08 — Bearer fallback is MEMORY-ONLY and expires after 5 minutes; it is
  // never read from (or written to) localStorage. The httpOnly cookie remains
  // the primary mechanism server-side.
  if (typeof window !== "undefined") {
    const bearer = memoryBearer && memoryBearer.expiresAt > Date.now() ? memoryBearer.token : null
    if (bearer) headers.Authorization = `Bearer ${bearer}`
    // C-4 — CSRF token echo (cookie-authenticated calls are rejected without it)
    if (memoryCsrf) headers["X-CSRF-Token"] = memoryCsrf
  }
  // M-04 — every call is bounded: 30s server-side timeout, combined with any
  // caller-provided abort signal (useApi cancels stale requests with it).
  const timeoutMs = 30_000
  let signal: AbortSignal | undefined
  if (typeof AbortSignal !== "undefined") {
    const timeoutSignal = AbortSignal.timeout(timeoutMs)
    signal = opts?.signal ? (AbortSignal as any).any?.([opts.signal, timeoutSignal]) ?? timeoutSignal : timeoutSignal
  }
  let res: Response
  try {
    res = await fetch("/api/hrm", {
      method: "POST",
      headers,
      body: JSON.stringify({ action, payload: payload || {} }),
      signal,
    })
  } catch (e: any) {
    if (e?.name === "TimeoutError" || e?.name === "AbortError") {
      // opts.signal aborts are caller-initiated (stale query) — not user-facing
      const callerAborted = opts?.signal?.aborted
      throw new RpcError(
        callerAborted ? "Request superseded" : `No response within ${timeoutMs / 1000}s — the request timed out`,
        { timedOut: !callerAborted },
      )
    }
    throw e
  }
  let json: any
  try {
    json = await res.json()
  } catch {
    throw new RpcError(`Server error (${res.status})`, { code: res.status })
  }
  if (!json.ok) {
    if (json.code === 401 && typeof window !== "undefined" && action !== "auth.login") {
      // session lost/expired → drop any memory token, scrub legacy storage,
      // and send the app back to login
      setMemoryBearer(null)
      memoryCsrf = null
      purgeLegacyWebStorage()
      window.dispatchEvent(new CustomEvent("hrm:unauthorized"))
    }
    const err = new RpcError(json.error || "Request failed", { code: json.code })
    throw err
  }
  // adopt any refreshed CSRF token the server attaches to session-bearing responses
  if (json.data && typeof json.data === "object" && typeof (json.data as any).csrfToken === "string") {
    saveCsrfToken((json.data as any).csrfToken)
  }
  return json.data as T
}

export function useApi<T = any>(action: string | null, payload?: Record<string, unknown>) {
  const [data, setData] = useState<T | null>(null)
  const [loading, setLoading] = useState(!!action)
  const [error, setError] = useState<string | null>(null)
  const [timedOut, setTimedOut] = useState(false)
  const key = JSON.stringify(payload || {})
  // M-04 — race guard lifted from global-search's seq-ref pattern: a stale
  // response can never clobber a newer one, and the previous request is
  // aborted the moment the query changes or the component unmounts.
  const seq = useRef(0)
  const abortRef = useRef<AbortController | null>(null)

  const load = useCallback(async () => {
    if (!action) return
    const mySeq = ++seq.current
    abortRef.current?.abort()
    const ac = new AbortController()
    abortRef.current = ac
    setLoading(true)
    setError(null)
    setTimedOut(false)
    try {
      const d = await rpc<T>(action, payload, { signal: ac.signal })
      if (seq.current !== mySeq) return // a newer request already answered
      setData(d)
    } catch (e: any) {
      if (seq.current !== mySeq) return
      // M-04 — timed-out calls keep a retry affordance in the error banner
      setError(e?.timedOut ? `${e.message} — tap Retry to try again` : e.message)
      setTimedOut(!!e?.timedOut)
    } finally {
      if (seq.current === mySeq) setLoading(false)
    }
  }, [action, key])

  useEffect(() => {
    load()
    return () => {
      seq.current++ // invalidate any in-flight response for this mount
      abortRef.current?.abort()
    }
  }, [load])

  return { data, loading, error, timedOut, reload: load, setData }
}

// ============ M-04/M-05 — shared lookup cache ============
// One fetch per dataset per TTL window across the WHOLE app: payroll's six
// employee pickers and attendance's five no longer each pull the full
// directory. Module-level (not per-mount) with in-flight dedup, so tab
// switches and remounts reuse the same promise. Views that need fresh data
// still call useApi directly.
type LookupEntry = { at: number; data: any; inflight: Promise<any> | null }
const lookupCache = new Map<string, LookupEntry>()
export const LOOKUP_TTL_MS = 5 * 60_000

export function invalidateLookup(action: string) {
  lookupCache.delete(action)
}

/** Cached lookup for small, rarely-changing datasets (employee directory,
 *  branches, departments, designations). Returns the cached value instantly
 *  while a background refresh may be in flight. `refresh` busts the cache and
 *  refetches (shared by every consumer of the same dataset). */
export function useLookup<T = any>(action: string, payload: Record<string, unknown> = {}, enabled = true): { data: T | null; loading: boolean; error: string | null; refresh: () => void } {
  const cacheKey = `${action}:${JSON.stringify(payload)}`
  const entry = lookupCache.get(cacheKey)
  const [state, setState] = useState<{ data: T | null; loading: boolean; error: string | null }>(
    () => (entry && Date.now() - entry.at < LOOKUP_TTL_MS
      ? { data: entry.data as T, loading: false, error: null }
      : { data: null, loading: enabled, error: null }),
  )
  // L-16 — the bump counter is now a REAL effect dependency: refresh()
  // invalidates the cache and the counter forces the effect to re-fetch
  // (previously the counter was bumped but never read — refresh was a no-op).
  const [refreshTick, bump] = useState(0)

  useEffect(() => {
    if (!enabled) return
    const existing = lookupCache.get(cacheKey)
    if (existing && Date.now() - existing.at < LOOKUP_TTL_MS) {
      // cached hit — deferred (microtask) so no cascading render is triggered
      // synchronously from within the effect body
      queueMicrotask(() => setState({ data: existing.data as T, loading: false, error: null }))
      return
    }
    let cancelled = false
    const inflight = existing?.inflight || rpc<T>(action, payload).then(
      (d) => {
        lookupCache.set(cacheKey, { at: Date.now(), data: d, inflight: null })
        return d
      },
      (e) => {
        if (lookupCache.get(cacheKey)?.inflight) lookupCache.set(cacheKey, { at: 0, data: null, inflight: null })
        throw e
      },
    )
    if (!existing?.inflight) lookupCache.set(cacheKey, { at: 0, data: null, inflight })
    queueMicrotask(() => setState((s) => ({ ...s, loading: true })))
    inflight.then(
      (d) => { if (!cancelled) setState({ data: d, loading: false, error: null }) },
      (e: any) => { if (!cancelled) setState((s) => ({ ...s, loading: false, error: e.message })) },
    )
    return () => { cancelled = true }
  }, [cacheKey, enabled, refreshTick])

  const refresh = useCallback(() => {
    invalidateLookup(cacheKey)
    bump((n) => n + 1) // re-run the effect on the fresh cache
  }, [cacheKey])

  return { ...state, refresh }
}

/** The employee directory used by every picker (M-05: was fetched 6× in
 *  payroll and 5× in attendance — now one cached fetch).
 *
 * M-27 — the old single `take: 500` call SILENTLY hid employees 501+ from
 * every picker (substitutes, salary exports, user links).
 * FE-1 (Phase 2 WS4) — the hook used to page through the WHOLE directory
 * (up to 50 sequential employees.list calls) carrying contact/employment
 * columns + base64 photo thumbs per row — tens of MB at 10K employees.
 * It now fetches ONE employees.refList page: {id, code, fullName} only,
 * photos never leave the server, 60 s module cache preserved so 29 picker
 * mounts still cost one request. Callers that need richer rows use their
 * own scoped list/search RPCs (they always did). */
const DIRECTORY_CACHE_TTL_MS = 60_000
let directoryCache: { at: number; data: any[] } | null = null

export function invalidateEmployeeDirectory() {
  directoryCache = null
}

export function useEmployeeDirectory(): { data: any[] | null; loading: boolean; error: string | null } {
  const [state, setState] = useState<{ data: any[] | null; loading: boolean; error: string | null }>({
    data: directoryCache?.data ?? null,
    loading: !directoryCache,
    error: null,
  })
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const cached = directoryCache
      if (cached && Date.now() - cached.at < DIRECTORY_CACHE_TTL_MS) {
        if (!cancelled) setState({ data: cached.data, loading: false, error: null })
        return
      }
      try {
        // FE-1 — one lightweight refList call (id/code/fullName only)
        const res = await rpc<any>("employees.refList", { take: 10000 })
        const refs = res?.refs ?? []
        directoryCache = { at: Date.now(), data: refs }
        if (!cancelled) setState({ data: refs, loading: false, error: null })
      } catch (e: any) {
        if (!cancelled) setState({ data: null, loading: false, error: e?.message || String(e) })
      }
    })()
    return () => { cancelled = true }
  }, [])
  return state
}

// ============ M-04/M-05 — background-job helper ============
// Heavy RPCs (communications.send, payslips.emailAll, backups.export) return
// { jobId } immediately; runJob polls jobs.get until a terminal state and
// resolves with the job result (or rejects with the job's error).
export async function runJob<T = any>(
  action: string,
  payload: Record<string, unknown>,
  opts?: { onProgress?: (progress: number, total: number) => void; pollMs?: number; maxWaitMs?: number },
): Promise<T> {
  const submit: { jobId: string } = await rpc(action, payload)
  const jobId = submit?.jobId
  if (!jobId) return submit as unknown as T // route answered synchronously
  const pollMs = opts?.pollMs ?? 1500
  const maxWaitMs = opts?.maxWaitMs ?? 10 * 60_000
  const deadline = Date.now() + maxWaitMs
  for (;;) {
    const job = await rpc<any>("jobs.get", { id: jobId })
    if (job.status === "DONE") return job.result as T
    if (job.status === "FAILED") throw new RpcError(job.error || "Background job failed")
    opts?.onProgress?.(job.progress || 0, job.total || 0)
    if (Date.now() > deadline) throw new RpcError(`Background job ${jobId} did not finish within ${maxWaitMs / 1000}s`)
    await new Promise((r) => setTimeout(r, pollMs))
  }
}

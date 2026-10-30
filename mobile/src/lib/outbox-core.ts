// ============ Offline outbox — pure queue engine (M3 / T-12) ============
//
// WHY THIS MODULE HAS NO REACT-NATIVE IMPORTS:
//   the queue logic (persistence shape, retry/backoff classification,
//   duplicate prevention, FIFO replay order, retention) is the part that
//   MUST be provably correct, so it lives in a dependency-free module that
//   the repo's bun test lane can execute directly with injected storage /
//   rpc / clock adapters (tests/unit/m3-outbox-core.test.ts). The thin
//   react-native wrapper (offline.ts) wires AsyncStorage + NetInfo +
//   AppState to this engine and contains no logic of its own.
//
// DESIGN CONTRACT (see docs/engineering/OFFLINE_OUTBOX.md):
//   · every entry carries a clientEventId the SERVER dedups on
//     (unique(vendorId, clientEventId) with the "ci:"/"co:" punch-route
//     prefixes) — a retry can never create a second attendance record;
//   · offline punches are captured with punch-time GPS + clientTimestamp
//     (never fabricated, never re-sampled at sync time) and replayed with
//     offlineCapture: true so the server can flag materially delayed
//     deliveries for HR review;
//   · the server is the ONLY authority: an entry is "synced" only after a
//     2xx response; a locally-recorded punch is never displayed as
//     officially successful before that;
//   · errors are classified honestly:
//       401            → authentication recovery (sync pauses; entries stay
//                        pending; resumes after the user re-logs in)
//       network error  → retryable (exponential backoff + jitter)
//       429 / 5xx      → retryable (exponential backoff + jitter)
//       other 4xx      → permanent server rejection (business rule spoke;
//                        the entry keeps the server's message for the user)
//   · one pending check-in and one pending check-out at a time — the local
//     mirror of the server's H-4 first-in/last-out sequence rule; the
//     server remains authoritative either way.
//
// SECURITY: outbox records contain attendance business data only (action,
// punch-time coordinates, timestamps, device info). No passwords, tokens or
// biometric data ever enter the queue — the auth token is read live from
// the secure store by the rpc adapter at submission time, and selfie photos
// are deliberately NOT outbox-eligible (they are sensitive personal data
// with no offline storage story; selfie punches are online-only).

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Attendance actions the outbox is allowed to carry. Deliberately a closed
 *  union — NOT every mobile action is offline-eligible, and adding one is a
 *  reviewed decision (each needs a server-side idempotency contract). */
export type OutboxAction =
  | "attendance.geofence.checkin"
  | "attendance.geofence.checkout"

export const OUTBOX_ACTIONS: readonly OutboxAction[] = [
  "attendance.geofence.checkin",
  "attendance.geofence.checkout",
] as const

/** Lifecycle of one outbox entry.
 *   pending  — recorded on device, waiting for its next sync attempt
 *   syncing  — submission in flight (reset to pending on load if the app
 *              died mid-flight; the server replay makes redelivery safe)
 *   synced   — the server accepted the event (or confirmed a prior accept
 *              via idempotentReplay)
 *   rejected — the server permanently refused (4xx business decision); the
 *              entry keeps the server's message and never auto-retries */
export type OutboxStatus = "pending" | "syncing" | "synced" | "rejected"

export interface OutboxEntry {
  id: string
  /** Server idempotency key — generated once at capture, reused verbatim on
   *  every attempt (the punch routes store it prefixed: "ci:"/"co:"). */
  clientEventId: string
  action: OutboxAction
  /** Punch payload captured at punch time (GPS, accuracy, device info). The
   *  engine injects clientEventId/clientTimestamp/offlineCapture at
   *  submission time; payload contents are never mutated afterwards. */
  payload: Record<string, unknown>
  status: OutboxStatus
  attemptCount: number
  /** ISO — device clock at punch capture (preserved verbatim forever). */
  createdAt: string
  /** True when the punch was recorded while the device was offline. */
  capturedOffline: boolean
  lastAttemptAt: string | null
  /** ISO — earliest next submission attempt (backoff gate; null = due). */
  nextRetryAt: string | null
  syncedAt: string | null
  lastError: string | null
  /** Server flagged the accepted event for HR review (OFFLINE_CAPTURE /
   *  integrity signals) — the punch is recorded but needs review. */
  requiresReview: boolean
  /** Server answered a retry with idempotentReplay (the original attempt
   *  was already accepted — e.g. response lost in transit). */
  replayed: boolean
}

export interface OutboxSummary {
  pending: number
  syncing: number
  synced: number
  rejected: number
  requiresReview: number
  nextRetryAt: string | null
  anyDueNow: boolean
}

export interface SyncOutcome {
  attempted: number
  synced: number
  rejected: number
  failed: number
  /** True when a 401 stopped the pass — nothing was harmed; the entries stay
   *  pending and sync resumes after re-authentication. */
  pausedForAuth: boolean
}

// ---------------------------------------------------------------------------
// Tunables (constants — one place to reason about the retry policy)
// ---------------------------------------------------------------------------

/** Exponential backoff: 5s, 10s, 20s, 40s, 80s … capped at 10 minutes. The
 *  first attempt happens immediately (enqueue triggers a sync pass). */
export const BACKOFF_BASE_MS = 5_000
export const BACKOFF_CAP_MS = 10 * 60_000
/** ±20% jitter so a cohort of offline devices reconnecting together does
 *  not stampede the server in lockstep. */
export const BACKOFF_JITTER = 0.2
/** Hard cap on queue length. Attendance punches are 2–4/day per employee;
 *  50 unreachable entries means something is deeply wrong — refuse loudly
 *  instead of silently growing unbounded device storage. */
export const MAX_ENTRIES = 50
/** Synced entries stay visible for 72h (honest "Synchronized" record),
 *  rejected entries for 7 days (the user's evidence of the server's
 *  decision), then pruned on load. */
export const SYNCED_RETENTION_MS = 72 * 3600_000
export const REJECTED_RETENTION_MS = 7 * 24 * 3600_000

/** Backoff delay after the n-th FAILED attempt (n ≥ 1), with jitter
 *  factor in [1-BACKOFF_JITTER, 1+BACKOFF_JITTER]. Pure — unit-tested. */
export function backoffDelayMs(failedAttempts: number, jitter: number): number {
  const n = Math.max(1, failedAttempts)
  const raw = Math.min(BACKOFF_BASE_MS * 2 ** (n - 1), BACKOFF_CAP_MS)
  const j = 1 + BACKOFF_JITTER * (2 * jitter - 1)
  return Math.round(raw * j)
}

// ---------------------------------------------------------------------------
// Error classification (the rpc adapter must throw Error-like objects
// carrying `status`; network failures throw without one)
// ---------------------------------------------------------------------------

export type ErrorClass =
  | { kind: "auth"; status: 401 }
  | { kind: "retryable"; status: number }
  | { kind: "permanent"; status: number }
  | { kind: "network" }

export function classifyError(err: unknown): ErrorClass {
  const status = (err as { status?: unknown } | null | undefined)?.status
  if (typeof status !== "number" || !Number.isFinite(status) || status <= 0) {
    // fetch() rejects with a TypeError before any HTTP response exists —
    // offline, DNS failure, connection reset. There is also the ApiError
    // convention of status 0 for "network" — treat both as retryable.
    return { kind: "network" }
  }
  if (status === 401) return { kind: "auth", status: 401 }
  if (status === 429 || status >= 500) return { kind: "retryable", status }
  return { kind: "permanent", status }
}

// ---------------------------------------------------------------------------
// Response classification — what did the server tell us about the punch?
// ---------------------------------------------------------------------------

export interface PunchResponseVerdict {
  requiresReview: boolean
  replayed: boolean
}

/** A 2xx punch response is "synced"; the server may additionally mark the
 *  event for HR review (status REVIEW_REQUIRED/SUSPICIOUS or
 *  reviewStatus PENDING) and/or answer a retry with idempotentReplay. */
export function classifyPunchResponse(data: unknown): PunchResponseVerdict {
  const d = (data ?? {}) as {
    idempotentReplay?: unknown
    eventStatus?: unknown
    reviewStatus?: unknown
  }
  return {
    requiresReview:
      d.eventStatus === "REVIEW_REQUIRED" ||
      d.eventStatus === "SUSPICIOUS" ||
      d.reviewStatus === "PENDING",
    replayed: d.idempotentReplay === true,
  }
}

// ---------------------------------------------------------------------------
// Dependencies (injected by offline.ts / tests)
// ---------------------------------------------------------------------------

export interface OutboxDeps {
  storage: {
    load(): Promise<OutboxEntry[]>
    save(entries: OutboxEntry[]): Promise<void>
  }
  /** Must behave like the app's rpc(): resolve with the server `data` on
   *  2xx; throw an Error carrying `status` (HTTP code) otherwise; throw
   *  without a status on network failure; a 401 must ALSO have cleared the
   *  stale token the way rpc() does. */
  rpc: (action: string, payload: unknown) => Promise<unknown>
  now(): Date
  newId(): string
  /** Uniform random in [0,1) for jitter — injectable for determinism. */
  random(): number
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

function actionKind(action: OutboxAction): "checkin" | "checkout" {
  return action === "attendance.geofence.checkin" ? "checkin" : "checkout"
}

export class OutboxEngine {
  private entries: OutboxEntry[] = []
  private syncInFlight = false
  private listeners = new Set<() => void>()
  /** Set when a sync pass stopped on 401 — cleared by the next explicit
   *  syncNow() (the app calls it after a successful re-login). */
  public authPaused = false

  constructor(private deps: OutboxDeps) {}

  // -- reactivity -----------------------------------------------------------

  onChange(cb: () => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  private emit() {
    for (const cb of this.listeners) cb()
  }

  // -- persistence ----------------------------------------------------------

  /** Load from storage and normalize: an entry stuck in "syncing" (app died
   *  mid-flight) returns to "pending" — the server replay contract makes
   *  redelivery safe; the interrupted attempt still counts for backoff.
   *  Prunes expired synced/rejected entries. */
  async load(): Promise<void> {
    let loaded: OutboxEntry[] = []
    try {
      loaded = await this.deps.storage.load()
    } catch {
      loaded = [] // unreadable queue = empty queue; never crash the app boot
    }
    const now = this.deps.now().getTime()
    this.entries = loaded
      .map((e) => (e.status === "syncing" ? { ...e, status: "pending" as const } : e))
      .filter((e) => {
        if (e.status === "synced") {
          const at = e.syncedAt ? Date.parse(e.syncedAt) : NaN
          return !Number.isFinite(at) || now - at < SYNCED_RETENTION_MS
        }
        if (e.status === "rejected") {
          const at = e.lastAttemptAt ? Date.parse(e.lastAttemptAt) : NaN
          return !Number.isFinite(at) || now - at < REJECTED_RETENTION_MS
        }
        return true // pending entries are never silently dropped
      })
    await this.persist()
    this.emit()
  }

  private async persist(): Promise<void> {
    try {
      await this.deps.storage.save(this.entries)
    } catch {
      // persistence failure must not break the in-flight operation; the
      // next successful save re-syncs device storage with memory
    }
  }

  // -- queue inspection -----------------------------------------------------

  snapshot(): readonly OutboxEntry[] {
    return this.entries
  }

  summary(): OutboxSummary {
    const now = this.deps.now().getTime()
    let nextRetryAt: string | null = null
    let anyDueNow = false
    for (const e of this.entries) {
      if (e.status !== "pending") continue
      if (!e.nextRetryAt) {
        anyDueNow = true
        continue
      }
      if (Date.parse(e.nextRetryAt) <= now) anyDueNow = true
      if (nextRetryAt === null || e.nextRetryAt < nextRetryAt) nextRetryAt = e.nextRetryAt
    }
    return {
      pending: this.entries.filter((e) => e.status === "pending").length,
      syncing: this.entries.filter((e) => e.status === "syncing").length,
      synced: this.entries.filter((e) => e.status === "synced").length,
      rejected: this.entries.filter((e) => e.status === "rejected").length,
      requiresReview: this.entries.filter((e) => e.requiresReview).length,
      nextRetryAt,
      anyDueNow,
    }
  }

  // -- enqueue --------------------------------------------------------------

  /** Record a punch captured NOW. The payload must NOT contain
   *  clientEventId/clientTimestamp — the engine owns those fields so every
   *  outbox event is guaranteed idempotent on the server. Rejects a second
   *  same-kind punch while one is still unresolved (local mirror of the
   *  server's check-in/check-out sequence rule). */
  async enqueue(
    action: OutboxAction,
    payload: Record<string, unknown>,
    opts: { capturedOffline: boolean },
  ): Promise<OutboxEntry> {
    const kind = actionKind(action)
    const conflicting = this.entries.some(
      (e) => e.status !== "synced" && e.status !== "rejected" && actionKind(e.action) === kind,
    )
    if (conflicting) {
      throw new Error(
        kind === "checkin"
          ? "A check-in is still waiting to sync — wait for it to be confirmed before punching again."
          : "A check-out is still waiting to sync — wait for it to be confirmed before punching again.",
      )
    }
    if (this.entries.length >= MAX_ENTRIES) {
      throw new Error("Offline queue is full (50 entries). Synchronize or clear old records, then try again.")
    }
    const now = this.deps.now()
    const entry: OutboxEntry = {
      id: this.deps.newId(),
      clientEventId: this.deps.newId(),
      action,
      payload: { ...payload },
      status: "pending",
      attemptCount: 0,
      createdAt: now.toISOString(),
      capturedOffline: opts.capturedOffline,
      lastAttemptAt: null,
      nextRetryAt: null,
      syncedAt: null,
      lastError: null,
      requiresReview: false,
      replayed: false,
    }
    this.entries.push(entry)
    await this.persist()
    this.emit()
    return entry
  }

  // -- sync -----------------------------------------------------------------

  /** Submit ONE entry now, bypassing the backoff gate (used right after
   *  enqueue and by manual retry). Returns the entry's final state after
   *  the attempt. */
  async syncEntry(id: string): Promise<OutboxEntry | null> {
    const entry = this.entries.find((e) => e.id === id)
    if (!entry || entry.status === "synced" || entry.status === "rejected") return entry ?? null
    await this.attempt(entry)
    await this.persist()
    this.emit()
    return this.entries.find((e) => e.id === id) ?? null
  }

  /** One pass over every due pending entry (FIFO by capture time). Stops on
   *  401 (auth recovery) leaving the rest untouched. Safe to call
   *  concurrently — a second call while one pass runs is a no-op. While
   *  authPaused, background calls no-op: only syncNow() (an explicit
   *  post-re-login trigger) resumes the queue. */
  async syncOnce(): Promise<SyncOutcome> {
    if (this.syncInFlight || this.authPaused) {
      return { attempted: 0, synced: 0, rejected: 0, failed: 0, pausedForAuth: this.authPaused }
    }
    this.syncInFlight = true
    const out: SyncOutcome = { attempted: 0, synced: 0, rejected: 0, failed: 0, pausedForAuth: false }
    try {
      const now = this.deps.now().getTime()
      const due = this.entries
        .filter((e) => e.status === "pending" && (!e.nextRetryAt || Date.parse(e.nextRetryAt) <= now))
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      for (const entry of due) {
        await this.attempt(entry)
        out.attempted++
        if (entry.status === "synced") out.synced++
        else if (entry.status === "rejected") out.rejected++
        else out.failed++
        if (this.authPaused) {
          out.pausedForAuth = true
          break // 401 — every later attempt would fail identically
        }
      }
      await this.persist()
      this.emit()
      return out
    } finally {
      this.syncInFlight = false
    }
  }

  /** Clear the auth-pause and run a pass (called after a successful
   *  re-login — rpc() has a fresh token by then). */
  async syncNow(): Promise<SyncOutcome> {
    this.authPaused = false
    return this.syncOnce()
  }

  /** Manual retry of a FAILED pending entry: clears the backoff gate so the
   *  next pass (or an immediate syncEntry) picks it up. */
  async retryNow(id: string): Promise<void> {
    const entry = this.entries.find((e) => e.id === id)
    if (!entry || entry.status !== "pending") return
    entry.nextRetryAt = null
    await this.persist()
    this.emit()
  }

  /** Remove a rejected entry from the queue (dismiss the server's decision
   *  after the user has read it). Pending/synced entries cannot be removed
   *  this way — pending ones must reach the server or fail honestly, synced
   *  ones age out by retention. */
  async dismiss(id: string): Promise<void> {
    const entry = this.entries.find((e) => e.id === id)
    if (!entry || entry.status !== "rejected") return
    this.entries = this.entries.filter((e) => e.id !== id)
    await this.persist()
    this.emit()
  }

  /** Delete a PENDING entry outright. The ONE sanctioned use: a punch whose
   *  payload carries a selfie photo (policy-required) failed its first
   *  submission attempt — the entry MUST NOT linger in device storage with
   *  photo bytes inside (offline photos are out of scope by design). The
   *  caller then tells the user honestly that the punch was not recorded and
   *  must be repeated with connectivity. Refuses synced/rejected entries
   *  (their lifecycle is retention/dismiss). */
  async removePendingEntry(id: string): Promise<boolean> {
    const entry = this.entries.find((e) => e.id === id)
    if (!entry || entry.status !== "pending") return false
    this.entries = this.entries.filter((e) => e.id !== id)
    await this.persist()
    this.emit()
    return true
  }

  // -- single-entry attempt ---------------------------------------------------

  private async attempt(entry: OutboxEntry): Promise<void> {
    const now = this.deps.now()
    entry.status = "syncing"
    entry.attemptCount += 1
    entry.lastAttemptAt = now.toISOString()
    entry.lastError = null
    this.emit()

    // submission payload = punch-time capture + engine-owned idempotency
    // fields. offlineCapture is true when the punch was recorded offline OR
    // this is a delayed retry of an online capture (network dropped mid-
    // submission) — both are device-captured-then-delayed deliveries, and
    // the server applies the same delayed-capture review rule to both.
    const offlineCapture = entry.capturedOffline || entry.attemptCount > 1
    const payload = {
      ...entry.payload,
      clientEventId: entry.clientEventId,
      clientTimestamp: entry.createdAt,
      offlineCapture,
    }

    try {
      const data = await this.deps.rpc(entry.action, payload)
      const verdict = classifyPunchResponse(data)
      entry.status = "synced"
      entry.syncedAt = this.deps.now().toISOString()
      entry.nextRetryAt = null
      entry.lastError = null
      entry.requiresReview = verdict.requiresReview
      entry.replayed = verdict.replayed
    } catch (err) {
      const cls = classifyError(err)
      const message = err instanceof Error ? err.message : "Synchronization failed"
      if (cls.kind === "auth") {
        // Session expired mid-sync: nothing is lost, nothing is faked. The
        // token was cleared by the rpc layer; entries stay pending and the
        // app retries after the user logs in again.
        this.authPaused = true
        entry.status = "pending"
        entry.lastError = "Session expired — your punch is saved and will sync after you sign in again."
        entry.nextRetryAt = null // immediate eligibility after re-login
      } else if (cls.kind === "network" || cls.kind === "retryable") {
        entry.status = "pending"
        entry.lastError = cls.kind === "network" ? "No connection — will retry automatically." : message
        const delay = backoffDelayMs(entry.attemptCount, this.deps.random())
        entry.nextRetryAt = new Date(this.deps.now().getTime() + delay).toISOString()
      } else {
        // Permanent server rejection — the attendance business rule spoke
        // (policy violation, sequence violation, geofence denial …). The
        // entry records the server's message verbatim for the user.
        entry.status = "rejected"
        entry.lastError = message
        entry.nextRetryAt = null
      }
    }
  }
}

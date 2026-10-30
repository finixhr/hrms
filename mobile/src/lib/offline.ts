// ============ Offline outbox — react-native wiring (M3 / T-12) ============
//
// Thin adapter around the pure engine (outbox-core.ts): AsyncStorage
// persistence, NetInfo connectivity, AppState foreground triggers and a
// zustand mirror for reactive UI. ALL queue logic lives in the engine —
// this file only wires platform capabilities and must stay logic-free.
//
// Lifecycle guarantees (directive M3-A):
//   · app restart / device restart  — entries live in AsyncStorage and are
//     reloaded + normalized (stuck "syncing" → pending) on module init;
//   · temporary network loss        — attempts fail → backoff; NetInfo
//     reconnect event schedules a pass;
//   · app backgrounding             — AppState "active" on return triggers
//     a pass; entries themselves are untouched by backgrounding;
//   · failed synchronization        — backoff + manual retry in the UI;
//   · authentication expiry         — 401 pauses the queue (nothing lost,
//     nothing faked); a successful auth.me session restore calls
//     syncNow() to resume.

import AsyncStorage from "@react-native-async-storage/async-storage"
import NetInfo, { type NetInfoState } from "@react-native-community/netinfo"
import { AppState, type AppStateStatus } from "react-native"
import { create } from "zustand"
import { rpc, ApiError } from "./api"
import {
  OutboxEngine, type OutboxEntry, type OutboxSummary, type SyncOutcome,
  type OutboxAction, OUTBOX_ACTIONS,
} from "./outbox-core"

export type { OutboxEntry, OutboxAction, OutboxSummary, SyncOutcome }
export { OUTBOX_ACTIONS }

const STORAGE_KEY = "finixhr_outbox_v1"

// ---------------------------------------------------------------------------
// Storage adapter — AsyncStorage (already the app's persistence layer for
// non-secret data; the auth token stays in expo-secure-store and never
// enters the outbox). Survives app restarts and device reboots.
// ---------------------------------------------------------------------------

const storage = {
  async load(): Promise<OutboxEntry[]> {
    const raw = await AsyncStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    // Defensive: keep only well-formed entries — a corrupted write must
    // never crash the boot path
    return parsed.filter(
      (e): e is OutboxEntry =>
        e && typeof e === "object" && typeof e.id === "string" && typeof e.clientEventId === "string" &&
        typeof e.action === "string" && (OUTBOX_ACTIONS as readonly string[]).includes(e.action),
    )
  },
  async save(entries: OutboxEntry[]): Promise<void> {
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(entries))
  },
}

// ---------------------------------------------------------------------------
// RPC adapter — the shared client. Bearer token is read LIVE from the
// secure store on every attempt (no token is ever persisted in the queue),
// and rpc()'s 401 handling (clear stale token) is exactly the auth-recovery
// behavior the engine expects.
// ---------------------------------------------------------------------------

async function rpcAdapter(action: string, payload: unknown): Promise<unknown> {
  try {
    return await rpc<unknown>(action, payload)
  } catch (err) {
    // Surface the HTTP status on ApiError (engine classifies via .status);
    // non-ApiError throwables (fetch TypeError — offline/DNS/reset) stay
    // status-less so the engine treats them as network failures.
    if (err instanceof ApiError) {
      const withStatus = new Error(err.message) as Error & { status: number }
      withStatus.status = err.status
      throw withStatus
    }
    throw err
  }
}

// ---------------------------------------------------------------------------
// Engine singleton + zustand mirror for reactive screens
// ---------------------------------------------------------------------------

interface OutboxStoreState {
  entries: OutboxEntry[]
  summary: OutboxSummary
  syncing: boolean
  authPaused: boolean
  online: boolean | null
}

interface OutboxStoreActions {
  refresh: () => void
  setSyncing: (v: boolean) => void
  setOnline: (v: boolean | null) => void
}

export const useOutboxStore = create<OutboxStoreState & OutboxStoreActions>()((set) => ({
  entries: [],
  summary: { pending: 0, syncing: 0, synced: 0, rejected: 0, requiresReview: 0, nextRetryAt: null, anyDueNow: false },
  syncing: false,
  authPaused: false,
  online: null,
  refresh: () => {
    const engine = getEngine()
    set({
      entries: [...engine.snapshot()],
      summary: engine.summary(),
      authPaused: engine.authPaused,
    })
  },
  setSyncing: (v) => set({ syncing: v }),
  setOnline: (v) => set({ online: v }),
}))

let engine: OutboxEngine | null = null

export function getEngine(): OutboxEngine {
  if (engine) return engine
  engine = new OutboxEngine({
    storage,
    rpc: rpcAdapter,
    now: () => new Date(),
    newId: () => {
      // RFC4122-ish v4 — same generator the attendance screen used inline;
      // centralised here so every outbox event shares one format
      return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0
        const v = c === "x" ? r : (r & 0x3) | 0x8
        return v.toString(16)
      })
    },
    random: () => Math.random(),
  })
  return engine
}

// ---------------------------------------------------------------------------
// Sync scheduling
// ---------------------------------------------------------------------------

let syncTimer: ReturnType<typeof setTimeout> | null = null
let reconnectDebounce: ReturnType<typeof setTimeout> | null = null
let initialized = false

function scheduleSync(delayMs: number): void {
  if (syncTimer) clearTimeout(syncTimer)
  syncTimer = setTimeout(async () => {
    syncTimer = null
    await runSync()
  }, delayMs)
}

/** Run one engine pass (guarded so overlapping triggers coalesce). */
async function runSync(): Promise<SyncOutcome> {
  const e = getEngine()
  const store = useOutboxStore.getState()
  if (!store.online && store.online !== null) {
    // NetInfo says offline — nothing to do; the reconnect listener reschedules
    return { attempted: 0, synced: 0, rejected: 0, failed: 0, pausedForAuth: false }
  }
  store.setSyncing(true)
  try {
    const outcome = await e.syncOnce()
    return outcome
  } finally {
    useOutboxStore.getState().setSyncing(false)
    useOutboxStore.getState().refresh()
  }
}

/** Initialize the outbox (idempotent — called from the root layout on app
 *  start, after auth session restore). Loads persisted entries, wires the
 *  connectivity + app-state listeners and runs a first pass. */
export async function initOutbox(): Promise<void> {
  if (initialized) return
  initialized = true
  const e = getEngine()

  e.onChange(() => useOutboxStore.getState().refresh())
  await e.load()
  useOutboxStore.getState().refresh()

  // Connectivity: NetInfo both seeds the online/offline state and triggers
  // a (debounced) pass on regained connectivity.
  NetInfo.addEventListener((state: NetInfoState) => {
    const online = state.isConnected === true && state.isInternetReachable !== false
    useOutboxStore.getState().setOnline(online)
    if (online) {
      if (reconnectDebounce) clearTimeout(reconnectDebounce)
      // 3s debounce: airplane-mode toggles and captive-portal flaps must not
      // stampede the queue with half-open sockets
      reconnectDebounce = setTimeout(() => {
        reconnectDebounce = null
        scheduleSync(0)
      }, 3_000)
    }
  })

  // Foreground return: the queue may have become due while backgrounded
  // (backoff gates expired); also covers cold starts after device reboot.
  AppState.addEventListener("change", (status: AppStateStatus) => {
    if (status === "active") scheduleSync(250)
  })

  scheduleSync(500)
}

// ---------------------------------------------------------------------------
// Screen-facing helpers
// ---------------------------------------------------------------------------

/** Record a punch now and immediately attempt its first submission.
 *  Returns the entry's state AFTER that first attempt:
 *    synced   → server confirmed (check .requiresReview / .replayed)
 *    pending  → no confirmation yet (offline or failed first attempt);
 *               the entry stays queued and will sync automatically
 *    rejected → the server permanently refused (message in lastError)
 *  The screen must NOT report success for anything but "synced". */
export async function submitPunch(
  action: OutboxAction,
  payload: Record<string, unknown>,
  opts: { capturedOffline: boolean },
): Promise<OutboxEntry | null> {
  const e = getEngine()
  const entry = await e.enqueue(action, payload, opts)
  useOutboxStore.getState().refresh()
  let after: OutboxEntry | null = entry
  if (!opts.capturedOffline) {
    // online capture: attempt the first submission immediately so the user
    // gets same-tick confirmation (or the honest failure state)
    after = await e.syncEntry(entry.id)
  }
  // offline capture: no doomed first fetch — the entry waits for
  // connectivity; when the app is actually online this scheduleSync(250)
  // delivers it right away
  useOutboxStore.getState().refresh()
  scheduleSync(250)
  return after
}

/** Manual "Sync now" control (settings/attendance UI). */
export async function syncNow(): Promise<SyncOutcome> {
  return getEngine().syncNow()
}

/** Retry a failed pending entry immediately (clears its backoff gate). */
export async function retryEntry(id: string): Promise<void> {
  await getEngine().retryNow(id)
  scheduleSync(0)
}

/** Dismiss a rejected entry after the user has read the server's message. */
export async function dismissEntry(id: string): Promise<void> {
  await getEngine().dismiss(id)
  useOutboxStore.getState().refresh()
}

/** Delete a pending entry (photo-safety path: a selfie-attached punch that
 *  failed its first attempt must never sit in device storage with photo
 *  bytes). Returns whether the entry was actually removed. */
export async function removePendingEntry(id: string): Promise<boolean> {
  const removed = await getEngine().removePendingEntry(id)
  if (removed) useOutboxStore.getState().refresh()
  return removed
}

/** Resume after re-login: the root layout calls this once auth.me confirms
 *  a live session (rpc() has a fresh token by then). */
export async function resumeAfterLogin(): Promise<void> {
  scheduleSync(0)
}

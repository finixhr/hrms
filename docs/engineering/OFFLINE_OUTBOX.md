# Offline Outbox — Architecture Record (M3 / T-12)

Status: **implemented and under test** (2026-10-30). This document records the
behavior that actually ships in this tree — the engine
(`mobile/src/lib/outbox-core.ts`), its react-native wiring
(`mobile/src/lib/offline.ts`), the server replay contract
(`src/hrm-server/routes/attendance.ts`, commit `dcbea29`), and the test suites
that pin each guarantee. Anything not listed here is NOT implemented.

Scope decision (directive M3-A): the outbox carries **attendance punches only**
— `attendance.geofence.checkin` and `attendance.geofence.checkout`. Making
another action offline-eligible is a reviewed decision, because each one needs
its own server-side idempotency contract. **Selfie punches are online-only by
design** (see §7).

---

## 1. Data model (device)

One queue, persisted in AsyncStorage under `finixhr_outbox_v1` as a JSON array
(AsyncStorage already backs the app's non-secret persistence; the auth token
stays in expo-secure-store and never enters the queue).

```
OutboxEntry {
  id              string   // local row id (uuid-v4-ish)
  clientEventId   string   // SERVER idempotency key — generated once at capture,
                           // reused verbatim on every attempt
  action          "attendance.geofence.checkin" | "attendance.geofence.checkout"
  payload         object   // punch-time capture: latitude, longitude, accuracyM,
                           // deviceInfo, gpsStatus, networkStatus, (selfie fields
                           // only on the photo-safety path, §7)
  status          "pending" | "syncing" | "synced" | "rejected"
  attemptCount    number
  createdAt       ISO      // device clock at punch capture — preserved verbatim
  capturedOffline boolean
  lastAttemptAt   ISO | null
  nextRetryAt     ISO | null   // backoff gate; null = due immediately
  syncedAt        ISO | null
  lastError       string | null
  requiresReview  boolean  // server flagged the ACCEPTED event for HR review
  replayed        boolean  // server answered a retry with idempotentReplay
}
```

Constants (one place to reason about policy): queue cap **50 entries** (a full
queue refuses new punches loudly — attendance is 2–4 punches/day, 50 means
something is deeply wrong); retention **72 h** for synced entries and **7 days**
for rejected ones (pruned on load); **pending entries are never silently
dropped**, not after a year of no connectivity.

On load, an entry stuck in `syncing` (app died mid-flight) returns to `pending`
with its attempt count preserved — redelivery is safe because of §3. An
unreadable queue is treated as empty (never crashes app boot).

## 2. Client/server contract

Submission payload = the punch-time capture plus three engine-owned fields
injected at send time:

| Field | Meaning | Server use |
|---|---|---|
| `clientEventId` | the idempotency key | punch routes store it prefixed (`ci:` / `co:` / `si:`) on `AttendanceEvent`; `unique(vendorId, clientEventId)` |
| `clientTimestamp` | device clock at capture (`createdAt`) | preserved on the event row as reviewer evidence |
| `offlineCapture` | `capturedOffline \|\| attemptCount > 1` | delayed-delivery classification (§4) |

The client NEVER re-samples GPS or rewrites timestamps at sync time — an
offline punch replays exactly what was captured at punch time.

## 3. Idempotency — a retry can never double-punch

Server side (`findPunchReplay`, commit `dcbea29`): before any policy work, each
punch route looks up the tenant-scoped key
`{vendorId, "ci:"|"co:"|"si:" + clientEventId}` on `AttendanceEvent`. If the
event was already accepted, the route returns the **recorded outcome** —
`idempotentReplay: true`, the recorded `eventStatus` / `reviewStatus` /
`recordedAt`, and the original punch time — with **zero side effects re-run**.
Verified by test (tests/unit/m3-offline-outbox-server.test.ts):

- exactly ONE attendance row, ONE event, ONE selfie proof, ONE punch
  notification per logical punch, no matter how many retries (the pre-M3
  handler re-stored selfie bytes and re-notified on every retry);
- the replay check runs **after identity, before** the GEOFENCE feature gate,
  the selfie rate limiter, storage quota, method policy, geofence validation
  and the H-4 sequence guard — a retry can never be answered 429 by a throttle
  its own first attempt consumed, nor a bogus `Already checked in today` for a
  punch that actually landed;
- genuinely different events keep the old semantics: a second check-in with a
  DIFFERENT `clientEventId` still gets the H-4 denial;
- the lookup is vendor-scoped: the same `clientEventId` from another tenant is
  a new event, never a replay.

Client side: the engine keeps one `clientEventId` per entry forever
(`m3-outbox-core.test.ts`: "the SAME clientEventId is reused on every retry"),
and a network-dropped submission that actually landed resolves via
`idempotentReplay` → the entry is marked synced with `replayed: true`.

## 4. Delayed-delivery classification (offline capture)

A punch recorded offline is a REAL punch — GPS and `clientTimestamp` were taken
at punch time and replayed verbatim; nothing is fabricated. The attendance
row's punch time remains the SERVER receipt time (the pre-existing
authoritative-time rule is unchanged). The delay classification
(`offlineCaptureVerdict`):

| Condition | Outcome |
|---|---|
| `offlineCapture` false | normal online punch (a stale `clientTimestamp` here is a clock-skew question for location-integrity, NOT an offline flag) |
| delay ≤ 120 s | accepted like an online punch; reason notes "submitted within 120s" |
| delay > 120 s | event flagged `OFFLINE_CAPTURE` → status `REVIEW_REQUIRED`, reviewStatus `PENDING`, HR notified, `clientTimestamp` preserved as evidence; attendance row stays intact |
| offline, no `clientTimestamp` | conservatively reviewed (cannot verify the delay) |

A reviewer — not a silent rule — decides whether an on-time offline punch keeps
its LATE status.

## 5. Retry policy and error classification

Backoff after the n-th failed attempt: `min(5 s · 2^(n−1), 10 min)` with ±20 %
jitter (spreads reconnect stampedes). First attempt is immediate.

| Failure | Class | Queue behavior |
|---|---|---|
| 401 | auth | pass pauses (`authPaused`); entry stays pending with "will sync after you sign in again"; background triggers no-op; the explicit post-re-login `syncNow()` resumes. Nothing lost, nothing faked. |
| network error (no HTTP status) | retryable | pending + backoff, "No connection — will retry automatically." |
| 429, 5xx | retryable | pending + backoff, server message kept |
| other 4xx | permanent | `rejected`, server message kept verbatim, never auto-retried; user can Dismiss after reading it |

Sync triggers: enqueue (immediate first attempt when captured online), NetInfo
reconnect (3 s debounce against captive-portal flaps), AppState → active
(250 ms), app boot (500 ms after session restore), successful re-login
(`resumeAfterLogin`). One pass runs at a time (concurrent calls coalesce);
within a pass entries go FIFO by capture time, gated by `nextRetryAt`. Manual
controls: Retry now (clears one entry's backoff gate), Sync now, Dismiss
(rejected only).

Local mirror of the server's sequence rule: one unresolved check-in and one
unresolved check-out at a time — a second same-kind punch is refused locally
with an actionable message; the server's H-4 rule stays authoritative either
way.

## 6. State visibility (honest UI)

A punch is **successful only after the server confirms it** (status `synced`).
The attendance screen's today card is driven by SERVER data; a queued punch
shows "pending sync" next to the empty server field, and the Sync Queue card
shows each entry with its real state:

| UI state | Meaning |
|---|---|
| Online / Offline / Syncing chip (header) | connectivity + pass in flight |
| Pending sync | recorded on device, waiting for its window |
| Synchronizing… | submission in flight |
| Synchronized | server accepted (2xx) |
| Accepted — under review | server accepted AND flagged (`requiresReview`) |
| Failed — will retry | attempt failed, backoff armed (manual Retry now offered) |
| Not sent — server rejected | permanent 4xx; server's message shown; Dismiss offered |

While offline with pending punches, an explainer states plainly that recorded
punches are not official attendance until the server confirms them.

## 7. Selfie photos and the outbox (deliberate scope)

Selfie punches (`attendance.selfie.checkin`, and the policy-required selfie
attached to a geo punch) are **online-only**:

- photos are sensitive personal data; the app deliberately has no offline
  photo story (no local photo storage, no on-device encryption key
  management). An hours-late selfie also has weak evidentiary value;
- the selfie upload retry (network drop mid-upload) keeps the confirmed shot
  in MEMORY ONLY, reusing the same `clientEventId` — the server replay
  contract (§3) makes the retry safe (no double punch, photo stored once);
- **photo-safety path**: if a geo punch carrying a policy-required selfie
  fails its first submission attempt, the pending entry is deleted outright
  (`removePendingEntry`) so photo bytes never sit in device storage, and the
  user is told honestly that the punch was NOT recorded and must be repeated
  with connectivity.

Server-side selfie security (pre-existing, exercised by this work's tests):
authenticated session required; tenant-scoped rows; byte-sniffed mime
validation (JPEG/PNG/WebP only, ≤ 2 MB — the data-URL prefix proves nothing);
storage-quota metering before any DB write; sha-256 file hash; private DB
storage with retention (`tracking.retentionDays`, default 90 days) — never a
public URL. The selfie is proof of presence, NOT identity verification: no
face detection, no liveness, no biometric claims (quality metadata is honest
evidence for human reviewers only).

## 8. Security properties

- No passwords, tokens or biometric data ever enter the queue — the bearer
  token is read live from the secure store by the rpc adapter at submission
  time.
- Punch-time payloads contain attendance business data only (coordinates,
  accuracy, device info string, GPS status).
- All submissions ride the authenticated `rpc()` channel (HTTPS to the
  configured server origin), 401 handled per §5.
- No business rule is bypassed client-side: geofence validation, method
  policy, H-4 sequence, duplicate prevention, selfie requirements all remain
  server-authoritative; a local refusal is only an early, honest no.

## 9. Test coverage

| Suite | What it pins |
|---|---|
| `tests/unit/m3-outbox-core.test.ts` (30 tests) | backoff math + jitter; error/response classification; persistence across "restart"; stuck-syncing recovery; one-per-kind refusal; queue cap; idempotency field injection; same clientEventId across retries; idempotentReplay resolution; review verdict surfacing; backoff gating + manual retry; FIFO network recovery; 401 pause/resume (incl. no-op while paused); permanent rejection terminality + dismiss protection; photo-safety removal; retention pruning (72 h / 7 d / pending never dropped); summary truthfulness |
| `tests/unit/m3-offline-outbox-server.test.ts` (12 tests) | replay idempotency for ci/co/si (exactly-one row/event/proof/notification); review verdict survives replay; replay bypasses consumed selfie throttle; H-4 denial for distinct ids; tenant-scoped replay; offlineCapture matrix (fresh/stale/no-timestamp/checkout/online) |
| `tests/unit/mobile-contract.test.ts` (+3 tests) | the outbox's closed action union only carries registered, idempotent punch routes; punch schemas accept `offlineCapture` + `clientTimestamp`; `attendance.selfie.checkin` requires the photo and accepts the mobile capture payload |

Full suite: **1728 pass / 0 fail** (includes the 1683-test M2 baseline; the two
documented MFA back-compat tolerances were repaired in the M2 cycle).

## 10. Known limitations (honest list)

1. **The react-native wiring layer** (`offline.ts`: NetInfo/AppState/zustand)
   is exercised by TypeScript + device testing only — the bun lane cannot
   load react-native modules. All queue LOGIC lives in the dependency-free
   engine, which is fully unit-tested.
2. Background/terminated-app sync depends on the OS: while the app is
   backgrounded, no timers run; delivery resumes on foreground return or
   reconnect (Android background restrictions apply). No headless background
   task is implemented.
3. `attendance.selfCheckout` (the no-GPS fallback) has no `clientEventId` in
   its server schema, so it is online-only and says so.
4. The server's punch-time remains receipt time — an offline punch's official
   time is when it REACHED the server; the reviewer can correct via the
   preserved `clientTimestamp` (by design, per §4).
5. Conflict resolution is reviewer-mediated, not merge-automated: a delayed
   offline punch that conflicts with a later online punch surfaces as
   REVIEW_REQUIRED with evidence, and HR decides. No automatic conflict
   resolution is claimed.

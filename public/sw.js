/* ============ Finix HR ESS service worker (Wave 4 — PWA offline queue) ============
 *
 * Registered ONLY from the employee self-service view (src/hrm/views/ess.tsx)
 * — never app-wide, so the vendor/owner consoles stay untouched. Vanilla JS,
 * no build tooling. Bump CACHE below to bust every cache this worker owns.
 *
 * SECURITY RULES (enforced below):
 *   · /api/hrm responses are NEVER cached. Offline punch RPCs are CAPTURED
 *     into IndexedDB and replayed later; every other /api/hrm POST goes
 *     straight to the network.
 *   · Authenticated HTML pages are NEVER cached — app-shell navigations are
 *     network-first and only fall back to the static /offline shell.
 *   · Cache-first is limited to explicit static assets (logo, manifest,
 *     icons) plus hashed /_next/static/ build output.
 *
 * QUEUE PROTOCOL (page ⇄ worker, via postMessage):
 *   page → SW : { type: "query-queue" }        → ask for the pending count
 *   page → SW : { type: "flush-offline" }      → drain the queue now
 *   SW  → page : { type: "queue-count", count }
 *   SW  → page : { type: "sync-done", flushed, remaining }     (after each drain)
 *   SW  → page : { type: "sync-rejected", action, code }       (row dropped: 401/403/4xx)
 *
 * Synthetic offline answer for a queued punch: HTTP 202
 *   { ok: true, queued: true, queuedAt, data: { queued: true, queuedAt } }
 * (the `data` passthrough exists so the shared rpc() client wrapper in
 *  src/hrm/api.ts resolves the marker instead of undefined).
 */
"use strict"

const CACHE = "finix-ess-v3" // bump to bust every cache owned by this worker (v3: push handlers, P6 WS-C)

// Punch RPCs that may be captured while offline and replayed later.
// Everything else (leave applications, expenses, reads…) needs the network —
// attendance data is sensitive, so only these three actions are ever stored
// on-device, and stored requests are replayed once then deleted.
const QUEUEABLE_ACTIONS = [
  "attendance.geofence.checkin",
  "attendance.geofence.checkout",
  "attendance.selfie.checkin",
]

// Explicit static assets served cache-first (never anything under /api/).
const STATIC_ASSETS = ["/logo.svg", "/manifest.webmanifest", "/icon-192.png", "/icon-512.png"]

const OFFLINE_URL = "/offline"

// Tiny self-contained offline app shell for failed navigations. No Next
// route exists for this — the string IS the page.
const OFFLINE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Finix HR — Offline</title>
<style>
  :root { color-scheme: light dark; }
  body {
    margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
    font-family: system-ui, -apple-system, "Segoe UI", Roboto, "Noto Sans Bengali", sans-serif;
    background: #f8fafc; color: #0f172a; padding: 24px; text-align: center;
  }
  @media (prefers-color-scheme: dark) { body { background: #020617; color: #e2e8f0; } }
  .card {
    max-width: 26rem; border: 1px solid #e2e8f0; border-radius: 16px; padding: 32px 28px;
    background: #ffffff;
  }
  @media (prefers-color-scheme: dark) { .card { background: #0f172a; border-color: #1e293b; } }
  .mark {
    width: 44px; height: 44px; margin: 0 auto 16px; border-radius: 12px;
    background: linear-gradient(135deg, #34d399, #059669);
    display: flex; align-items: center; justify-content: center; font-size: 20px;
  }
  h1 { font-size: 18px; margin: 0 0 6px; }
  p { font-size: 13px; line-height: 1.6; margin: 0 0 20px; opacity: 0.75; }
  button {
    appearance: none; border: 0; border-radius: 10px; padding: 10px 20px; font-size: 14px;
    font-weight: 600; color: #ffffff; background: #059669; cursor: pointer;
  }
  button:focus-visible { outline: 2px solid #34d399; outline-offset: 2px; }
  .bn { display: block; margin-top: 8px; font-size: 12px; opacity: 0.7; }
</style>
</head>
<body>
  <main class="card">
    <div class="mark" aria-hidden="true">&#127939;</div>
    <h1>You are offline</h1>
    <p>Check-ins you record right now are saved on this device and will sync automatically once the connection returns.
      <span class="bn" lang="bn">আপনি এখন অফলাইনে আছেন — চেক-ইন ডিভাইসে সংরক্ষিত থাকবে এবং সংযোগ ফিরলেই সিঙ্ক হয়ে যাবে।</span>
    </p>
    <button onclick="location.reload()">Try again</button>
  </main>
</body>
</html>`

// ---------- IndexedDB: offline request queue (store "offlineQueue") ----------

const DB_NAME = "finix-ess"
const DB_VERSION = 1
const STORE = "offlineQueue"

/** Cached connection promise — opened once, reused for every operation. */
let dbPromise = null
function db() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION)
      req.onupgradeneeded = () => {
        // create the object store if missing (keyPath auto → autoIncrement)
        if (!req.result.objectStoreNames.contains(STORE)) {
          req.result.createObjectStore(STORE, { autoIncrement: true })
        }
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
  }
  return dbPromise
}

function withStore(mode, run) {
  return db().then(
    (d) =>
      new Promise((resolve, reject) => {
        const tx = d.transaction(STORE, mode)
        const req = run(tx.objectStore(STORE))
        tx.oncomplete = () => resolve(req && req.result)
        tx.onerror = () => reject(tx.error)
        tx.onabort = () => reject(tx.error)
      }),
  )
}

function queueAdd(row) {
  return withStore("readwrite", (s) => s.add(row))
}

function queueDelete(key) {
  return withStore("readwrite", (s) => s.delete(key))
}

function queueCount() {
  return withStore("readonly", (s) => s.count()).then((n) => (typeof n === "number" ? n : 0))
}

/** All rows in insertion order: [{ key, row }] (autoincrement keys sort
 *  ascending in an openCursor walk — the queue drains FIFO). */
function queueAll() {
  return db().then(
    (d) =>
      new Promise((resolve, reject) => {
        const out = []
        const tx = d.transaction(STORE, "readonly")
        const req = tx.objectStore(STORE).openCursor()
        req.onsuccess = () => {
          const cur = req.result
          if (!cur) return
          out.push({ key: cur.key, row: cur.value })
          cur.continue()
        }
        tx.oncomplete = () => resolve(out)
        tx.onerror = () => reject(tx.error)
        tx.onabort = () => reject(tx.error)
      }),
  )
}

// ---------- helpers ----------

async function broadcast(msg) {
  const clients = await self.clients.matchAll({ includeUncontrolled: true, type: "window" })
  for (const c of clients) {
    try {
      c.postMessage(msg)
    } catch (_e) {
      /* client went away mid-broadcast — the rest still get the message */
    }
  }
}

/** JSON response in the /api/hrm envelope shape ({ ok:false } makes the
 *  shared rpc() client throw with this exact message). */
function jsonRpcError(message, code) {
  return new Response(JSON.stringify({ ok: false, error: message, code: code || 503 }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  })
}

/** Cache-first for explicit static assets + hashed build output. */
async function cacheFirst(request) {
  const cache = await caches.open(CACHE)
  const hit = await cache.match(request)
  if (hit) return hit
  try {
    const res = await fetch(request)
    // only same-origin basic responses with a 2xx status enter the cache
    if (res && res.ok && res.type === "basic") await cache.put(request, res.clone())
    return res
  } catch (_e) {
    // offline + not previously cached → try the path without its query
    const fallback = await cache.match(request, { ignoreSearch: true })
    if (fallback) return fallback
    return new Response("Offline", { status: 503, headers: { "Content-Type": "text/plain" } })
  }
}

/** Network-first for app-shell navigations. Successful (authenticated) HTML
 *  is passed straight through and NEVER cached; on network failure the
 *  static /offline shell answers. */
async function networkFirstNavigation(request) {
  try {
    return await fetch(request)
  } catch (_e) {
    const cache = await caches.open(CACHE)
    const offline = await cache.match(OFFLINE_URL, { ignoreSearch: true })
    if (offline) return offline
    return new Response("Offline", { status: 503, headers: { "Content-Type": "text/plain" } })
  }
}

/** POST /api/hrm while offline: capture queueable punch RPCs, answer the
 *  rest with a clear offline error so the UI can surface it. */
async function handleOfflineRpc(request) {
  let bodyText = ""
  try {
    bodyText = await request.text()
  } catch (_e) {
    return jsonRpcError("You are offline and the request could not be read", 503)
  }
  let action = null
  try {
    const parsed = JSON.parse(bodyText)
    action = parsed && typeof parsed.action === "string" ? parsed.action : null
  } catch (_e) {
    action = null
  }
  if (!action || QUEUEABLE_ACTIONS.indexOf(action) === -1) {
    // sensitive/non-punch RPC — never stored, never cached
    return jsonRpcError("You are offline — this action needs a connection", 503)
  }
  // capture exactly the headers the replay needs (content-type + CSRF echo +
  // bearer fallback when present — the httpOnly session cookie rides along
  // automatically on the replay fetch)
  const headers = { "Content-Type": request.headers.get("Content-Type") || "application/json" }
  const csrf = request.headers.get("X-CSRF-Token")
  if (csrf) headers["X-CSRF-Token"] = csrf
  const auth = request.headers.get("Authorization")
  if (auth) headers["Authorization"] = auth

  const queuedAt = new Date().toISOString()
  try {
    await queueAdd({ url: request.url, action: action, headers: headers, bodyText: bodyText, queuedAt: queuedAt })
  } catch (_e) {
    // storage failed — surface an error so the UI does NOT believe it saved
    return jsonRpcError("Could not save this check-in on your device", 503)
  }
  try {
    await broadcast({ type: "queue-count", count: await queueCount() })
  } catch (_e) {
    /* badge refresh is best-effort */
  }
  // 202 Accepted — the punch is stored locally and will replay on sync.
  return new Response(
    JSON.stringify({ ok: true, queued: true, queuedAt: queuedAt, data: { queued: true, queuedAt: queuedAt } }),
    { status: 202, headers: { "Content-Type": "application/json" } },
  )
}

// ---------- queue drain (sync) ----------

let draining = false

/** Drain the queue IN ORDER. Row outcomes:
 *    2xx            → delete + flushed++
 *    401 / 403      → delete + sync-rejected (auth gone — retrying can't help)
 *    other 4xx      → delete + sync-rejected (poison-pill protection: a
 *                     malformed/stale request must not retry forever; the
 *                     app-level { ok:false } envelope inside a 200 is checked
 *                     too — business refusals are surfaced, not swallowed)
 *    408/429/5xx    → keep for the next flush (transient)
 *    network error  → keep for the next flush
 */
async function flushQueue() {
  if (draining) return
  draining = true
  try {
    const rows = await queueAll()
    let flushed = 0
    for (const item of rows) {
      const key = item.key
      const row = item.row
      try {
        const res = await fetch(row.url, { method: "POST", headers: row.headers, body: row.bodyText })
        if (res.ok) {
          // the API answers business refusals as 2xx-with-{ok:false} in some
          // paths — read the envelope so a rejection is never swallowed
          let envelope = null
          try {
            envelope = await res.json()
          } catch (_e) {
            envelope = null
          }
          if (envelope && envelope.ok === false) {
            await queueDelete(key)
            await broadcast({ type: "sync-rejected", action: row.action, code: envelope.code || res.status })
          } else {
            await queueDelete(key)
            flushed++
          }
        } else if (res.status === 401 || res.status === 403) {
          await queueDelete(key)
          await broadcast({ type: "sync-rejected", action: row.action, code: res.status })
        } else if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) {
          await queueDelete(key)
          await broadcast({ type: "sync-rejected", action: row.action, code: res.status })
        }
        // 408/429/5xx → keep the row for the next flush
      } catch (_e) {
        // network dropped mid-drain — keep the row for the next flush
      }
    }
    await broadcast({ type: "sync-done", flushed: flushed, remaining: await queueCount() })
  } finally {
    draining = false
  }
}

// ---------- lifecycle ----------

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      // precache the offline shell (the inline HTML above, nothing else)
      const cache = await caches.open(CACHE)
      await cache.put(
        OFFLINE_URL,
        new Response(OFFLINE_HTML, {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        }),
      )
      await self.skipWaiting()
    })(),
  )
})

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      // clean caches not matching the current CACHE version
      const keys = await caches.keys()
      await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
      // take over open ESS tabs immediately so controller?.postMessage
      // (queue-count bootstrap) works on the very first visit
      await self.clients.claim()
    })(),
  )
})

// ---------- fetch strategy ----------

self.addEventListener("fetch", (event) => {
  const request = event.request
  if (request.method !== "GET" && request.method !== "POST") return
  let url
  try {
    url = new URL(request.url)
  } catch (_e) {
    return
  }
  if (url.origin !== self.location.origin) return // cross-origin: never intercepted

  // POST /api/hrm — never cached. Offline + queueable punch → capture.
  if (request.method === "POST" && url.pathname === "/api/hrm") {
    if (self.navigator.onLine === false) {
      event.respondWith(handleOfflineRpc(request))
    }
    // online → plain network pass-through (no respondWith, no caching)
    return
  }
  if (request.method !== "GET") return

  // (a) cache-first: explicit static assets + the offline shell ONLY.
  // /_next/static/ is NEVER cached by SW — browser native cache & Next.js handle it
  if (
    url.pathname === OFFLINE_URL ||
    STATIC_ASSETS.indexOf(url.pathname) !== -1
  ) {
    event.respondWith(cacheFirst(request))
    return
  }

  // (d) app-shell navigations → network-first with the offline shell as the
  // fallback. Successful (authenticated) HTML is never cached.
  if (request.mode === "navigate") {
    event.respondWith(networkFirstNavigation(request))
    return
  }

  // everything else (including /api/* GETs) → straight to the network,
  // untouched and uncached
})

// ---------- sync triggers ----------

// Background Sync API (Chrome/Edge) — the browser replays the tag once
// connectivity returns; guarded so non-supporting browsers ignore it.
self.addEventListener("sync", (event) => {
  if (event.tag === "finix-offline-sync") event.waitUntil(flushQueue())
})

// Fallback for browsers without Background Sync: the worker itself notices
// connectivity returning.
self.addEventListener("online", () => {
  flushQueue()
})

// Page-driven triggers: manual "Sync now" button + queue-count queries.
self.addEventListener("message", (event) => {
  const msg = event.data || {}
  if (msg.type === "flush-offline") {
    event.waitUntil(flushQueue())
  } else if (msg.type === "query-queue") {
    event.waitUntil(
      queueCount().then((count) => {
        if (event.source) event.source.postMessage({ type: "queue-count", count: count })
      }),
    )
  }
})

// ---------- Web Push (Phase 5 P6 WS-C) — punches & approvals on device ----------

// The app posts the payload as JSON: { title, body, url?, tag? }. The tag
// deduplicates same-topic notifications (one approval queue ping, not a
// stack), and url deep-links notificationclick into the right SPA view.
self.addEventListener("push", (event) => {
  let payload = {}
  try { payload = event.data ? event.data.json() : {} } catch (_e) { payload = {} }
  const title = payload.title || "Finix HR"
  const options = {
    body: payload.body || "",
    tag: payload.tag || "finix-hr",
    icon: "/icon-192.png",
    badge: "/icon-192.png",
    data: { url: payload.url || "/app" },
    // keep the device quiet-friendly: no persistent sound, standard vibrate
    vibrate: [80, 40, 80],
  }
  event.waitUntil(self.registration.showNotification(title, options))
})

self.addEventListener("notificationclick", (event) => {
  event.notification.close()
  const target = (event.notification.data && event.notification.data.url) || "/app"
  event.waitUntil(
    (async () => {
      const clientList = await self.clients.matchAll({ type: "window", includeUncontrolled: true })
      // focus an already-open app window and deep-link it; only open a new
      // one when none exists
      for (const client of clientList) {
        if ("focus" in client) {
          await client.focus()
          if ("navigate" in client) { try { await client.navigate(target) } catch (_e) { /* same-doc nav */ } }
          else if (client.postMessage) client.postMessage({ type: "navigate", url: target })
          return
        }
      }
      await self.clients.openWindow(target)
    })(),
  )
})

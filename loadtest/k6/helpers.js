// ============ k6 shared helpers — Finix HR load tests (Wave 11 §15) =============
// Common plumbing for every scenario: RPC envelope, Bearer auth, thresholds.
//
// The tenant API is POST /api/hrm with { action, payload } (application/json).
// auth.login returns { token } (plus a cookie + csrfToken for browser use) —
// scenarios ride the Bearer fallback (Authorization: Bearer <token>), which
// the dispatcher accepts by construction and which is CSRF-exempt, so no
// cookie bookkeeping is needed under load.
//
// Configure with env vars (see loadtest/README.md):
//   BASE_URL, TENANT_EMAIL, TENANT_PASSWORD, VUS, DURATION
import http from "k6/http"
import { check, sleep } from "k6"
import { Counter } from "k6/metrics"

export const BASE_URL = __ENV.BASE_URL || "http://localhost:3000"
export const ORIGIN = __ENV.ORIGIN || BASE_URL // Origin must match the deployment allowlist

const rpcFail = new Counter("rpc_failures")

/** One RPC call. Returns the parsed response body. */
export function rpc(action, payload = {}, token = null) {
  const headers = {
    "Content-Type": "application/json",
    Origin: ORIGIN,
  }
  if (token) headers.Authorization = `Bearer ${token}`
  const res = http.post(
    `${BASE_URL}/api/hrm`,
    JSON.stringify({ action, payload }),
    { headers, tags: { action } },
  )
  const ok = res.status === 200
  if (!ok) rpcFail.add(1, { action })
  check(res, {
    [`${action}: 200`]: (r) => r.status === 200,
  })
  let body = {}
  try {
    body = res.json()
  } catch {
    body = {}
  }
  return { res, body, ok }
}

/** Login once (per VU/iteration as the scenario chooses). Returns the Bearer
 * token or null. auth.login is public + throttled — a load-test login storm
 * is a REAL throttle test, which is why the auth-journey scenario exists. */
export function login(email, password) {
  const { body } = rpc("auth.login", { email, password })
  const token = body && body.token ? body.token : null
  if (!token) {
    check(null, { "auth.login returned a token": () => false })
  }
  return token
}

/** Default SLO thresholds (§15 acceptance criteria — tune per environment in
 * loadtest/README.md; these are the documented starting gates). */
export const SLO_THRESHOLDS = {
  http_req_failed: ["rate<0.01"], // <1% failed requests
  http_req_duration: ["p(95)<800", "p(99)<2000"], // p95 < 800ms, p99 < 2s
  rpc_failures: ["count<50"],
}

/** Human-scale think time between RPC steps (fast enough to keep a scenario
 * meaningful, slow enough to look like a real user clicking through pages). */
export function think(seconds = 3) {
  sleep(seconds)
}

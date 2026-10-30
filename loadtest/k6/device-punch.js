// ============ Scenario 5 — device-plane punch ingestion (ZKTeco ADMS) ===========
// The HIGHEST-VOLUME platform surface: biometric terminals pushing ATTLOG
// records. This drives the DEV simulator route (POST /api/dev/zkteco/
// simulate-event), which replays the EXACT wire format through the production
// /iclock/cdata gateway — raw-event insert → idempotency window → sweeper —
// so the numbers measure the real ingestion path, not a mock.
//
// Requirements on the server (dev/staging only — the simulator hard-refuses
// in production):
//   ZKTECO_SIMULATOR_ENABLED=true
//   TENANT_EMAIL must be a user holding devices.process (e.g. HR admin)
//
//   k6 run -e BASE_URL=https://hrm-staging.example.com \
//         -e TENANT_EMAIL=hradmin@tenant.local -e TENANT_PASSWORD='...' \
//         -e DEVICE_SN=AC0123456789 -e DEVICE_KEY='<comm key>' \
//         -e RPS=200 -e DURATION=5m loadtest/k6/device-punch.js
import http from "k6/http"
import { check, sleep } from "k6"
import { Counter } from "k6/metrics"
import { BASE_URL, ORIGIN, login } from "./helpers.js"

const punchFail = new Counter("punch_failures")

export const options = {
  scenarios: {
    device_punches: {
      executor: "constant-arrival-rate",
      rate: Number(__ENV.RPS || 100),
      timeUnit: "1s",
      duration: __ENV.DURATION || "5m",
      preAllocatedVUs: 200,
      maxVUs: 1000,
      gracefulRampDown: "20s",
    },
  },
  thresholds: {
    http_req_failed: ["rate<0.02"], // ingestion may shed load at 429 before the app suffers
    http_req_duration: ["p(95)<300", "p(99)<800"], // fast-ack contract: accept then process
    punch_failures: ["count<100"],
  },
}

const SN = __ENV.DEVICE_SN || "AC0000000000"
const DEVICE_KEY = __ENV.DEVICE_KEY || ""
// a stable employee pin pool enrolled on that device (adapt to your seed):
const PINS = (__ENV.EMPLOYEE_PINS || "1001,1002,1003,1004,1005,1006,1007,1008").split(",")

export default function () {
  // lazy per-VU login: the simulator route authenticates like any RPC and
  // requires devices.process
  if (!globalThis.__token) {
    globalThis.__token = login(__ENV.TENANT_EMAIL || "owner@demo.local", __ENV.TENANT_PASSWORD || "Pass@123")
  }
  const token = globalThis.__token
  if (!token) return

  const pin = PINS[Math.floor(Math.random() * PINS.length)]
  // ATTLOG punch (default branch): { sn, pin, verifyMode: 3 (face), status: 0 }
  const res = http.post(
    `${BASE_URL}/api/dev/zkteco/simulate-event`,
    JSON.stringify({ sn: SN, key: DEVICE_KEY, pin, count: 1, verifyMode: 3, status: 0 }),
    {
      headers: {
        "Content-Type": "application/json",
        Origin: ORIGIN,
        Authorization: `Bearer ${token}`,
      },
      tags: { action: "device.punch" },
    },
  )
  // the simulator itself answers 200 with { ok, httpStatus } — the INGESTION
  // result is upstream.status inside the JSON; treat ok:false as a failure.
  let body = {}
  try { body = res.json() } catch { /* non-JSON = failure */ }
  const ok = res.status === 200 && body.ok === true
  if (!ok) punchFail.add(1)
  check(res, { "punch accepted by /iclock/cdata": () => ok })
  sleep(0.05)
}

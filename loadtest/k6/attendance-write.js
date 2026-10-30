// ============ Scenario 4 — ESS attendance write path (geo punches) ==============
// The tenant-plane write workload: self-service geo check-ins/out with
// idempotency pressure (the platform must tolerate the same punch retried —
// duplicate suppression is part of the acceptance criteria, see §5 of the
// master prompt). Each VU logs in once and punches at a randomized cadence
// with jittered coordinates.
//
// Requires: a tenant whose plan includes GEOFENCE, an employee profile linked
// to the login, and at least one geofence matching WORKPLACE_LAT/LNG.
//   k6 run -e BASE_URL=https://hrm.example.com \
//         -e TENANT_EMAIL=ess.user@tenant.local -e TENANT_PASSWORD='...' \
//         -e WORKPLACE_LAT=23.7806 -e WORKPLACE_LNG=90.4074 \
//         -e VUS=30 -e DURATION=5m loadtest/k6/attendance-write.js
import { group } from "k6"
import { rpc, login, think } from "./helpers.js"

export const options = {
  scenarios: {
    ess_punches: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: [
        { duration: "30s", target: Number(__ENV.VUS || 20) },
        { duration: __ENV.DURATION || "5m", target: Number(__ENV.VUS || 20) },
        { duration: "30s", target: 0 },
      ],
      gracefulRampDown: "20s",
    },
  },
  // write path is allowed a slightly looser p95, but failures must stay <1%
  thresholds: {
    http_req_failed: ["rate<0.01"],
    http_req_duration: ["p(95)<1200", "p(99)<2500"],
    rpc_failures: ["count<50"],
  },
}

const LAT = Number(__ENV.WORKPLACE_LAT || 23.7806)
const LNG = Number(__ENV.WORKPLACE_LNG || 90.4074)

function jitter(v) {
  return v + (Math.random() - 0.5) * 0.0004 // ~±22m — inside the fence radius
}

export default function () {
  const token = login(__ENV.TENANT_EMAIL || "owner@demo.local", __ENV.TENANT_PASSWORD || "Pass@123")
  if (!token) return

  // one VU ≈ one field employee: punch loop with realistic spacing
  for (let i = 0; i < 3; i++) {
    const action = i % 2 === 0 ? "attendance.geofence.checkin" : "attendance.geofence.checkout"
    group(action, () => {
      rpc(action, { latitude: jitter(LAT), longitude: jitter(LNG) }, token)
    })
    think(Number(__ENV.PUNCH_GAP_SECONDS || 20))
  }
}

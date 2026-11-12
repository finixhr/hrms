// ============ Scenario 6 — payroll preflight (the money-path read) ==========
// OPS-4 (2026-11-09 P1 wave) — the k6 kit covered auth / tenant reads / ESS
// writes / device ingest, but none of the MONEY paths. Payroll Preflight
// (WP-G) is the heaviest per-request read on the payroll plane: it
// classifies EVERY employee of the active company (salary structures, payout
// methods, NID documents) for a period BEFORE a run is generated — the call
// the payroll team makes right before creating this month's run. It must
// stay fast and error-free even when several admins preflight concurrently.
//
// READ-ONLY by construction: payroll.preflight only PREVIEWS classifications
// (perm payroll.view; src/hrm-server/routes/payroll.ts) — it never creates,
// calculates, submits or pays a run.
//
// Requirements on the server / seed:
//   TENANT_EMAIL must be a payroll-entitled admin (HR_ADMIN or VENDOR_OWNER)
//   that does NOT require MFA — the second factor cannot be automated here
//   (auth.login would answer mfaRequired with no token).
//   Default VUS=10 is deliberate: the dispatcher throttles auth.login at
//   10/min per identity+IP (M-16/H-7) and each VU logs in ONCE — the 30 s
//   ramp stays inside the bucket. Scale VUS beyond 10 only with a POOL of
//   admin users (TENANT_EMAIL then varies per VU) or a raised throttle, and
//   keep the tenant's concurrent-session policy unlimited (a low cap evicts
//   the VU sessions mid-run → 401s).
//
// Run:
//   k6 run -e BASE_URL=https://hrm-staging.example.com \
//         -e TENANT_EMAIL=hradmin@tenant.local -e TENANT_PASSWORD='...' \
//         -e VUS=10 -e DURATION=3m loadtest/k6/payroll-preflight.js
import { group } from "k6"
import { rpc, login, think } from "./helpers.js"

export const options = {
  scenarios: {
    payroll_preflight: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: [
        { duration: "30s", target: Number(__ENV.VUS || 10) },
        { duration: __ENV.DURATION || "3m", target: Number(__ENV.VUS || 10) },
        { duration: "30s", target: 0 },
      ],
      gracefulRampDown: "20s",
    },
  },
  // whole-company classification read → the WRITE-path latency budget
  // (p95 < 1.2 s / p99 < 2.5 s, same shape as attendance-write.js); failures
  // must stay < 1% — rpc() additionally asserts every response is a clean
  // 200 (no 5xx, no 4xx) and counts misses into rpc_failures.
  thresholds: {
    http_req_failed: ["rate<0.01"],
    http_req_duration: ["p(95)<1200", "p(99)<2500"],
    rpc_failures: ["count<50"],
  },
}

export default function () {
  const token = login(__ENV.TENANT_EMAIL || "owner@demo.local", __ENV.TENANT_PASSWORD || "Pass@123")
  if (!token) return

  const now = new Date()
  // the CURRENT period — what an admin about to generate this month's run
  // would preflight. Schema is strict: periodMonth 1-12 / periodYear 2000-2100
  // as NUMBERS (validation.ts payrollPreflight).
  const periodMonth = now.getMonth() + 1
  const periodYear = now.getFullYear()

  // one VU ≈ one payroll admin: preflight → review → repeat. Generous
  // spacing — preflight is the expensive payroll read; 10 VUs with the
  // default 10 s gap ≈ 1 preflight/s, the realistic concurrency right
  // before a pay cycle opens.
  while (true) {
    group("payroll.preflight", () => {
      rpc("payroll.preflight", { periodMonth, periodYear }, token)
    })
    think(Number(__ENV.PREFLIGHT_GAP_SECONDS || 10))
  }
}

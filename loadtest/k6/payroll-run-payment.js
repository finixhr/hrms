// ============ Scenario 7 — payroll runs & entries (money-path READS) ========
// OPS-4 (2026-11-09 P1 wave) — second money-path check: the payroll run
// monitor. While a pay cycle is live, an HR admin polls the runs list and
// pages through the entries of the newest run — the exact screens the
// Payroll module opens, on the module that moves money.
//
// LISTING ONLY — this scenario MUST NOT create, calculate, submit or pay a
// real run. It calls the two READ actions exclusively (perm payroll.view):
//   payroll.runs.list — the runs table the Payroll screen opens (no params;
//     ordered periodYear/periodMonth desc, so runs[0] is the newest run)
//   payroll.entries   — ONE PAGE of that run's entries ({ runId, page,
//     pageSize }). NB: there is no "payroll.entries.list" action — the real
//     route name is "payroll.entries" (src/hrm-server/routes/payroll.ts).
//
// Requirements on the server / seed:
//   TENANT_EMAIL must be a payroll-entitled admin (HR_ADMIN or VENDOR_OWNER)
//   without MFA (see payroll-preflight.js for the VUS/throttle/session-cap
//   notes — they apply here too); the tenant needs at least ONE payroll run
//   seeded for the entries page to exercise.
//
// Run:
//   k6 run -e BASE_URL=https://hrm-staging.example.com \
//         -e TENANT_EMAIL=hradmin@tenant.local -e TENANT_PASSWORD='...' \
//         -e VUS=10 -e DURATION=3m loadtest/k6/payroll-run-payment.js
import { group } from "k6"
import { rpc, login, think, SLO_THRESHOLDS } from "./helpers.js"

export const options = {
  scenarios: {
    payroll_run_reads: {
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
  // plain list reads → the standard SLO gates (p95 < 800 ms, p99 < 2 s,
  // < 1% failures); rpc() asserts a clean 200 on every call.
  thresholds: SLO_THRESHOLDS,
}

export default function () {
  const token = login(__ENV.TENANT_EMAIL || "owner@demo.local", __ENV.TENANT_PASSWORD || "Pass@123")
  if (!token) return

  // one VU ≈ one payroll admin watching the run monitor
  while (true) {
    // runs list — the dispatcher wraps handler returns in { ok, data }, so
    // the bare array rides at body.data
    let newestRunId = null
    group("payroll.runs.list", () => {
      const { body } = rpc("payroll.runs.list", {}, token)
      const runs = body && Array.isArray(body.data) ? body.data : []
      if (runs.length && runs[0] && runs[0].id) newestRunId = runs[0].id
    })
    think()

    // page through the newest run's entries when the tenant has any run
    if (newestRunId) {
      group("payroll.entries", () => {
        rpc("payroll.entries", { runId: newestRunId, page: 1, pageSize: 25 }, token)
      })
      think(5)
    }
  }
}

// ============ Scenario 8 — leave approval inbox (manager money-path) ========
// OPS-4 (2026-11-09 P1 wave) — third money-path check: the leave approval
// loop. An HR admin / manager working the approval inbox lists pending
// requests and cross-checks the requester's leave balance before deciding —
// the two reads every approval decision is built on (paid leave is money:
// encashment and proration both settle against these balances).
//
// READ-ONLY by design: the approve / reject mutations are NOT exercised — a
// load test must never mutate approval state. This scenario calls (perm
// leave.view; src/hrm-server/routes/leave.ts):
//   leaveRequests.list — the approval inbox ({ page, pageSize })
//   leaveBalances.list — the year's balance sheet ({ year, page, pageSize })
//
// Requirements on the server / seed:
//   TENANT_EMAIL with leave.view (HR_ADMIN or VENDOR_OWNER), no MFA on the
//   account (see payroll-preflight.js for the VUS/throttle/session-cap
//   notes — they apply here too).
//
// Run:
//   k6 run -e BASE_URL=https://hrm-staging.example.com \
//         -e TENANT_EMAIL=hradmin@tenant.local -e TENANT_PASSWORD='...' \
//         -e VUS=10 -e DURATION=3m loadtest/k6/leave-approval.js
import { group } from "k6"
import { rpc, login, think, SLO_THRESHOLDS } from "./helpers.js"

export const options = {
  scenarios: {
    leave_approval: {
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
  // plain paged list reads → the standard SLO gates (p95 < 800 ms, p99 < 2 s,
  // < 1% failures); rpc() asserts a clean 200 on every call.
  thresholds: SLO_THRESHOLDS,
}

export default function () {
  const token = login(__ENV.TENANT_EMAIL || "owner@demo.local", __ENV.TENANT_PASSWORD || "Pass@123")
  if (!token) return

  const now = new Date()
  const year = now.getFullYear()

  // one VU ≈ one manager: inbox → balance check → repeat
  while (true) {
    group("leaveRequests.list", () => {
      rpc("leaveRequests.list", { page: 1, pageSize: 25 }, token)
    })
    think()
    group("leaveBalances.list", () => {
      rpc("leaveBalances.list", { year, page: 1, pageSize: 25 }, token)
    })
    think()
  }
}

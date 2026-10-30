// ============ Scenario 2 — tenant read journeys (dashboard / lists) ==============
// The read-heavy day-to-day workload: each VU logs in ONCE, then loops
// through the screens a tenant user actually opens — attendance today +
// summary, the paged employee list, billing overview/invoices, support
// tickets. This is the journey mix the capacity model in docs/SCALING.md §1
// assumes for "active user" traffic (see loadtest/README.md for the weights).
//
// Run:
//   k6 run -e BASE_URL=https://hrm.example.com \
//         -e TENANT_EMAIL=hradmin@tenant.local -e TENANT_PASSWORD='...' \
//         -e VUS=100 -e DURATION=10m loadtest/k6/tenant-read-journey.js
import { group } from "k6"
import { rpc, login, think, SLO_THRESHOLDS } from "./helpers.js"

export const options = {
  scenarios: {
    tenant_reads: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: [
        { duration: "1m", target: Number(__ENV.VUS || 50) },
        { duration: __ENV.DURATION || "5m", target: Number(__ENV.VUS || 50) },
        { duration: "30s", target: 0 },
      ],
      gracefulRampDown: "20s",
    },
  },
  thresholds: SLO_THRESHOLDS,
}

export default function () {
  const token = login(__ENV.TENANT_EMAIL || "owner@demo.local", __ENV.TENANT_PASSWORD || "Pass@123")
  if (!token) return

  const now = new Date()
  while (true) {
    // Dashboard-ish reads (attendance module landing)
    group("attendance.today", () => rpc("attendance.today", {}, token))
    think()
    group("attendance.summary", () => rpc("attendance.summary", { month: now.getMonth() + 1, year: now.getFullYear() }, token))
    think()

    // Employee directory — server-side pagination contract (take/skip, hard cap)
    group("employees.list", () => rpc("employees.list", { take: 25, skip: 0 }, token))
    think()

    // Billing & subscription (unified page reads)
    group("billing.overview", () => rpc("billing.overview", {}, token))
    think()

    // Support center ticket list
    group("support.tickets", () => rpc("support.tickets", { page: 1, pageSize: 25 }, token))
    think(5)
  }
}

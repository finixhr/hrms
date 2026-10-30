// ============ Scenario 3 — employee search (trigram + pagination path) ===========
// Employee search is the highest-frequency tenant query family (the capacity
// model in docs/SCALING.md §1 sizes it at ~2 lookups per active user per
// hour). It rides the pg_trigram indexes — watch p95 here when the employee
// table grows past ~100k rows per tenant.
//
// SEARCH_TERMS is a comma-separated pool of realistic names/codes, e.g.:
//   -e SEARCH_TERMS="rahim,karim,ahmed"
import { group } from "k6"
import { rpc, login, think, SLO_THRESHOLDS } from "./helpers.js"

export const options = {
  scenarios: {
    employee_search: {
      executor: "constant-arrival-rate", // closed-model reads: steady RPS regardless of latency
      rate: Number(__ENV.RPS || 50),
      timeUnit: "1s",
      duration: __ENV.DURATION || "5m",
      preAllocatedVUs: Math.max(50, Number(__ENV.VUS || 100)),
      maxVUs: Math.max(100, Number(__ENV.MAX_VUS || 400)),
      gracefulRampDown: "20s",
    },
  },
  thresholds: SLO_THRESHOLDS,
}

const TERMS = (__ENV.SEARCH_TERMS || "rahim,karim,ahmed,tanvir").split(",")

export default function () {
  // per-iteration state is shared by design: the pool logs in lazily below.
  if (!globalThis.__token) {
    globalThis.__token = login(__ENV.TENANT_EMAIL || "owner@demo.local", __ENV.TENANT_PASSWORD || "Pass@123")
  }
  const token = globalThis.__token
  if (!token) return

  const term = TERMS[Math.floor(Math.random() * TERMS.length)]
  group(`employees.list?q=${term}`, () => {
    rpc("employees.list", { q: term, take: 25, skip: 0 }, token)
  })
  think(0.5)
}

// ============ Scenario 1 — authentication journey (login + auth.me) =============
// Exercises the hottest public surface: credential verification, session
// creation, throttle buckets, login audit writes, and the session read path.
// This journey is deliberately login-heavy: every iteration performs a FULL
// login, which is the real stress on the throttle limiter (5 attempts / 15 min
// per identity+IP — so point this at a POOL of seeded demo users, or expect
// 429s, which is itself a valid throttle verification).
//
// Run:
//   k6 run -e BASE_URL=https://hrm.example.com \
//         -e TENANT_EMAIL=demo@tenant.local -e TENANT_PASSWORD='...' \
//         -e VUS=50 -e DURATION=5m loadtest/k6/auth-journey.js
import { group } from "k6"
import { rpc, login, think, SLO_THRESHOLDS } from "./helpers.js"

export const options = {
  scenarios: {
    auth_journey: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: [
        { duration: "30s", target: Number(__ENV.VUS || 20) },
        { duration: __ENV.DURATION || "3m", target: Number(__ENV.VUS || 20) },
        { duration: "30s", target: 0 },
      ],
      gracefulRampDown: "20s",
    },
  },
  thresholds: SLO_THRESHOLDS,
}

export default function () {
  const email = __ENV.TENANT_EMAIL || "owner@demo.local"
  const password = __ENV.TENANT_PASSWORD || "Pass@123"

  group("login", () => {
    const token = login(email, password)
    if (token) {
      think(2)
      group("auth.me", () => {
        rpc("auth.me", {}, token)
      })
      think(2)
    }
  })
}

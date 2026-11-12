// ============ TST-1 (P2 wave, 2026-11-09) — Playwright UI smoke lane ============
// The audit: "Zero UI component tests across both panels… every frontend
// regression in this report's UI findings class ships silently."
//
// This config drives the login-to-punch smoke (tests/e2e-ui/smoke.spec.ts)
// against the SAME server scripts/e2e.sh boots (scratch DB + bootstrap
// tenant). The browser lane is Chromium-only and headless by default.
//
//   E2E_BASE_URL=http://127.0.0.1:3111 bunx playwright test
//
// Never boots its own server: scripts/e2e.sh owns the app lifecycle
// (dev or PRODUCTION standalone build per E2E_BUILD) and invokes this lane.
import { defineConfig } from "@playwright/test"

export default defineConfig({
  testDir: "./tests/e2e-ui",
  timeout: 45_000,
  expect: { timeout: 10_000 },
  fullyParallel: false, // one tenant, one punch per day — strictly sequential
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: process.env.E2E_BASE_URL || "http://127.0.0.1:3111",
    headless: true,
    // the ESS punch surface needs geolocation: the context position matches
    // the bootstrap branch fence (E2E HQ, Dhaka center, 300 m radius)
    geolocation: { latitude: 23.7808, longitude: 90.4142, accuracy: 20 },
    permissions: ["geolocation"],
    locale: "en-US",
    timezoneId: "Asia/Dhaka",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  projects: [
    { name: "chromium", use: { browserName: "chromium" } },
  ],
})

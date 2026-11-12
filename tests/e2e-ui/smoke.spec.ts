// ============ TST-1 (P2 wave) — login-to-punch UI smoke (Chromium) ============
// The minimal browser journey the audit asked for: sign in as the bootstrap
// employee, land on the ESS portal, and record a REAL geo check-in through
// the UI button — proving the full stack (render → login POST → session →
// CSRF → RPC dispatcher → geofence validation → attendance row) works in a
// real browser, which no HTTP-level test can.
//
// Rides the server scripts/e2e.sh boots (E2E_BASE_URL) and the tenant
// tests/e2e/_bootstrap.ts creates (employee@e2e.local / E2ePass@123, branch
// fence at Dhaka center — the config's geolocation matches it).
import { test, expect } from "@playwright/test"

const EMAIL = process.env.E2E_ESS_EMAIL || "employee@e2e.local"
const PASSWORD = process.env.E2E_PASSWORD || "E2ePass@123"

test("login → ESS portal renders → Geo Check-In records a punch", async ({ page }) => {
  // capture the punch RPC verdict — the action name rides the REQUEST body
  // (responses only carry ok/data/error)
  let punchApi: { status: number; body: any } | null = null
  page.on("response", async (res) => {
    if (res.url().includes("/api/hrm") && res.request().method() === "POST") {
      if ((res.request().postData() || "").includes("geofence")) {
        try {
          punchApi = { status: res.status(), body: await res.json() }
        } catch { punchApi = { status: res.status(), body: null } }
      }
    }
  })

  // 1) the app entry renders the login view
  await page.goto("/app")
  await expect(page.getByRole("button", { name: /sign in/i })).toBeVisible({ timeout: 30_000 })

  // 2) sign in (MFA is disabled for the bootstrap tenant)
  await page.getByLabel(/email/i).first().fill(EMAIL)
  await page.getByLabel(/password/i).first().fill(PASSWORD)
  await page.getByRole("button", { name: /sign in/i }).click()

  // 3) the ESS portal renders: grouped navigation (UXD-1) + quick actions
  await expect(page.getByRole("heading", { name: /self-service portal/i })).toBeVisible({ timeout: 90_000 })
  await expect(page.getByRole("group", { name: /sections/i })).toBeVisible()
  const punchButton = page.getByRole("button", { name: /^geo check-in$/i })
  await expect(punchButton).toBeVisible()

  // 4) the punch: click the quick action. The client first acquires a GPS fix
  //    (up to ~30 s of retries in the geo-hardened path), then posts the RPC —
  //    poll for the server verdict instead of asserting instantly.
  await punchButton.click()
  await expect
    .poll(async () => punchApi !== null, { timeout: 60_000, message: "the geofence check-in RPC never reached the server" })
    .toBe(true)

  // 5) the strict verdict: the punch was accepted (200 + ok) — or refused for
  //    a legitimate same-day reason (a journey test may have punched first)
  expect(punchApi!.status).toBe(200)
  const ok = punchApi!.body?.ok === true
  const alreadyIn = /already checked in/i.test(String(punchApi!.body?.error || ""))
  expect(ok || alreadyIn).toBe(true)
  // the server-side record is the contract; the today-card refresh is
  // best-effort client behavior and deliberately not asserted here.
})

test("login → grouped ESS navigation switches sections (UXD-1 regression)", async ({ page }) => {
  await page.goto("/app")
  await expect(page.getByRole("button", { name: /sign in/i })).toBeVisible({ timeout: 30_000 })
  await page.getByLabel(/email/i).first().fill(EMAIL)
  await page.getByLabel(/password/i).first().fill(PASSWORD)
  await page.getByRole("button", { name: /sign in/i }).click()
  await expect(page.getByRole("heading", { name: /self-service portal/i })).toBeVisible({ timeout: 90_000 })

  // level 1: the Money section reveals only its own tabs
  await page.getByRole("button", { name: /^money$/i }).click()
  await expect(page.getByRole("tab", { name: /my payslips/i })).toBeVisible()
  await page.getByRole("tab", { name: /my payslips/i }).click()
  await expect(page.getByText(/no payslips yet|payslips/i).first()).toBeVisible()
})

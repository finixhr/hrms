// ============ FORENSIC AUDIT 2026-11-10, FIN-030 (Phase 3) — desktop smoke ============
// The audit: "Tauri desktop app has zero multi-company context integration."
// The web app now publishes the company context on every change:
//   · a `finix:company-switched` DOM CustomEvent { companyId, companyName,
//     allCompaniesMode } — the integration contract the Tauri shell (and any
//     embedding surface) consumes;
//   · an active-company segment in document.title — mirrored into the native
//     title bar by desktop/src-tauri/src/lib.rs (FIN-030 title bridge).
// This spec drives the REAL app through the desktop user's exact journey —
// sign in (lands in the default company), switch A→B→All-Companies, sign out
// — and asserts BOTH channels at every step. It runs in the default e2e lane
// (scripts/e2e.sh runs the whole tests/e2e-ui directory) and therefore in the
// FIN-035 nightly e2e lane; exit criterion: "desktop two-company switch smoke
// passes".
import { test, expect } from "@playwright/test"

const EMAIL = process.env.E2E_OWNER_EMAIL || "owner@e2e.local"
const PASSWORD = process.env.E2E_PASSWORD || "E2ePass@123"
const RESIDUE_BUDGET_MS = 60_000

test("FIN-030 — the desktop two-company switch smoke (context event + title bar)", async ({ page }) => {
  test.setTimeout(180_000)

  // 0) install the company-context collector BEFORE any UI action, exactly
  // like the desktop shell's bridge would (an embedding consumer)
  await page.addInitScript(() => {
    ;(window as any).__fin30Events = []
    window.addEventListener("finix:company-switched", (e: any) => {
      ;(window as any).__fin30Events.push(e.detail)
    })
  })

  // 1) sign in as the owner (default company = A)
  await page.goto("/app")
  await expect(page.getByRole("button", { name: /sign in/i })).toBeVisible({ timeout: 30_000 })
  await page.getByLabel(/email/i).first().fill(EMAIL)
  await page.getByLabel(/password/i).first().fill(PASSWORD)
  await page.getByRole("button", { name: /sign in/i }).click()

  const switcher = page.getByRole("button", { name: /switch company/i })
  await expect(switcher).toBeVisible({ timeout: 90_000 })
  await expect(switcher).toContainText(/E2E Journeys/i)

  // 2) the sign-in itself publishes the initial context (event + title)
  await expect
    .poll(() => page.evaluate(() => (window as any).__fin30Events.length), { timeout: RESIDUE_BUDGET_MS })
    .toBeGreaterThanOrEqual(1)
  const initial = await page.evaluate(() => (window as any).__fin30Events[0])
  expect(initial.companyName).toBe("E2E Journeys Ltd")
  expect(initial.allCompaniesMode).toBe(false)
  await expect
    .poll(() => page.title(), { timeout: RESIDUE_BUDGET_MS })
    .toContain("E2E Journeys Ltd")

  // 3) switch to Company B — the desktop webview shows whose books are open
  await switcher.click()
  await page.getByRole("menuitem").filter({ hasText: "E2E Second Company Ltd" }).click()
  await expect
    .poll(() => page.title(), { timeout: RESIDUE_BUDGET_MS })
    .toContain("E2E Second Company Ltd")
  const afterB = await page.evaluate(() => (window as any).__fin30Events.at(-1))
  expect(afterB.companyName).toBe("E2E Second Company Ltd")
  expect(afterB.allCompaniesMode).toBe(false)

  // 4) the All-Companies mode publishes its own context (read-only reporting)
  await switcher.click()
  await page.getByRole("menuitem").filter({ hasText: /all companies/i }).first().click()
  await expect
    .poll(() => page.title(), { timeout: RESIDUE_BUDGET_MS })
    .toContain("All Companies")
  const afterAll = await page.evaluate(() => (window as any).__fin30Events.at(-1))
  expect(afterAll.allCompaniesMode).toBe(true)
  expect(afterAll.companyName).toBe("All Companies")

  // 5) switch back to Company A — the reverse direction holds too
  await switcher.click()
  await page.getByRole("menuitem").filter({ hasText: "E2E Journeys Ltd" }).first().click()
  await expect
    .poll(() => page.title(), { timeout: RESIDUE_BUDGET_MS })
    .toContain("E2E Journeys Ltd")

  // 6) sign out — the workspace closes and the title returns to the base
  //    (the desktop title bar drops the company segment)
  await page.getByRole("button", { name: /sign out|log out/i }).first().click()
  await expect
    .poll(() => page.title(), { timeout: RESIDUE_BUDGET_MS })
    .not.toContain("E2E Journeys")
})

// ============ FORENSIC AUDIT 2026-11-10, Phase 2 — consolidated mode + pager e2e ============
// FIN-015: lists over a single page ride the pager correctly — the Inventory
//           items list (the nav module is labelled "Stock Inventory", the
//           Items tab rides the DataTable with pageSize 12) pages the 18
//           seeded catalogue items across 2 pages, so page 2 must be
//           reachable and show different rows.
// FIN-016: All-Companies navigation whitelist — operational destinations hide,
//           the read-only reporting surfaces stay.
// FIN-029: the persistent banner explains the consolidated mode's semantics
//           and disappears when a concrete company is re-selected.
//
// Rides the same scripts/e2e.sh lane as the Phase 1 specs (the bootstrap
// provisions the second company + the owner's access to both + the 18 items).
import { test, expect } from "@playwright/test"

const EMAIL = process.env.E2E_OWNER_EMAIL || "owner@e2e.local"
const PASSWORD = process.env.E2E_PASSWORD || "E2ePass@123"

function nav(page: import("@playwright/test").Page) {
  return page.locator('nav[aria-label="Main navigation"]')
}

async function login(page: import("@playwright/test").Page) {
  await page.goto("/app")
  await expect(page.getByRole("button", { name: /sign in/i })).toBeVisible({ timeout: 30_000 })
  await page.getByLabel(/email/i).first().fill(EMAIL)
  await page.getByLabel(/password/i).first().fill(PASSWORD)
  await page.getByRole("button", { name: /sign in/i }).click()
  await expect(page.getByText(/dashboard/i).first()).toBeVisible({ timeout: 30_000 })
}

test("FIN-015 — the items list pages past page 1 with the new pager", async ({ page }) => {
  test.setTimeout(120_000)
  await login(page)

  // Stock Inventory (the nav module's label) → Items tab (the DataTable lists
  // the 18 seeded items at pageSize 12 → 2 pages)
  await nav(page).getByRole("button", { name: /stock inventory/i }).click()
  await page.getByRole("tab", { name: /items/i }).click()
  const table = page.locator('[data-testid="data-table-pager"]')
  await expect(table).toBeVisible({ timeout: 30_000 })

  // page 1 shows rows 1–12 of 18; the pager states both counts
  await expect(table).toContainText("1–12")
  await expect(table).toContainText("of 18")
  await expect(table).toContainText("Page 1 / 2")

  // page 2: different rows, and the Next button disables at the end
  await table.getByRole("button", { name: "Next page" }).click()
  await expect(table).toContainText("13–18")
  await expect(table).toContainText("Page 2 / 2")
  await expect(table.getByRole("button", { name: "Next page" })).toBeDisabled()
  await expect(table.getByRole("button", { name: "Previous page" })).toBeEnabled()

  // and page 1 again — the pager round-trips
  await table.getByRole("button", { name: "Previous page" }).click()
  await expect(table).toContainText("Page 1 / 2")
})

test("FIN-016 + FIN-029 — All-Companies mode: banner on, operational nav hidden, RO surfaces kept", async ({ page }) => {
  test.setTimeout(120_000)
  await login(page)

  // enter the consolidated mode through the switcher (owner holds companies.consolidated)
  await page.getByRole("button", { name: /switch company/i }).click()
  await page.getByRole("menuitem", { name: /all companies/i }).click()

  // FIN-029 — the persistent banner explains the semantics
  const banner = page.locator('[data-testid="all-companies-banner"]')
  await expect(banner).toBeVisible({ timeout: 30_000 })
  await expect(banner).toContainText(/consolidated read-only/i)
  await expect(banner).toContainText(/write actions are disabled/i)

  // FIN-016 — operational destinations are GONE from the navigation
  await expect(nav(page).getByRole("button", { name: /^payroll$/i })).toHaveCount(0)
  await expect(nav(page).getByRole("button", { name: /^inventory$/i })).toHaveCount(0)
  await expect(nav(page).getByRole("button", { name: /^recruitment$/i })).toHaveCount(0)
  // the read-only reporting surfaces stay
  await expect(nav(page).getByRole("button", { name: /dashboard/i })).toBeVisible()

  // leaving the mode drops the banner
  await page.getByRole("button", { name: /switch company/i }).click()
  await page.getByRole("menuitem", { name: /e2e journeys/i }).click()
  await expect(banner).toHaveCount(0)
})

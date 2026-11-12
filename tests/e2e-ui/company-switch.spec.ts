// ============ FORENSIC AUDIT 2026-11-10, FIN-004 (Phase 1) — company-switch e2e ============
// The audit's Critical finding: switching from Company A to Company B kept
// Company A's data on screen because the view remount key ignored the company
// and switchCompany deliberately restores the previous view. This spec drives
// the REAL UI through the exact journey: land in Company A with its employee
// visible, switch to Company B, and assert — within 60 s — that Company A's
// data is GONE and Company B's is on screen; then switch back and assert the
// reverse. Rides the same server/tenant scripts/e2e.sh boots (the bootstrap
// creates the SECOND company; the owner holds access to both).
//
//   E2E_BASE_URL=http://127.0.0.1:3111 bunx playwright test company-switch
import { test, expect } from "@playwright/test"

const EMAIL = process.env.E2E_OWNER_EMAIL || "owner@e2e.local"
const PASSWORD = process.env.E2E_PASSWORD || "E2ePass@123"

// FIN-004's exit criterion: "no old-company data residue within 60 s of the
// switch (e2e assertion)". Everything below is bounded by this budget.
const RESIDUE_BUDGET_MS = 60_000

test("FIN-004 — switching company remounts the active view (A→B→A, no stale data)", async ({ page }) => {
  test.setTimeout(180_000)

  // 1) sign in as the owner (access to BOTH companies; default = Company A)
  await page.goto("/app")
  await expect(page.getByRole("button", { name: /sign in/i })).toBeVisible({ timeout: 30_000 })
  await page.getByLabel(/email/i).first().fill(EMAIL)
  await page.getByLabel(/password/i).first().fill(PASSWORD)
  await page.getByRole("button", { name: /sign in/i }).click()

  const switcher = page.getByRole("button", { name: /switch company/i })
  await expect(switcher).toBeVisible({ timeout: 90_000 })
  await expect(switcher).toContainText(/E2E Journeys/i) // the default company is active

  // 2) open the Employee Directory — Company A's roster renders
  await page.getByRole("button", { name: /employee directory/i }).click()
  await expect(page.getByText("Journey Employee")).toBeVisible({ timeout: RESIDUE_BUDGET_MS })

  // 3) switch to Company B from the SAME view (the exact FIN-004 scenario:
  //    switchCompany keeps the user on the current view — the remount key
  //    must rebuild it under the new company)
  await switcher.click()
  await page.getByRole("menuitem").filter({ hasText: "E2E Second Company Ltd" }).click()

  // 4) FIN-004 assertion, part 1 — within the 60 s budget, Company A's
  //    employee is GONE from the remounted view…
  await expect(page.getByText("Journey Employee")).toBeHidden({ timeout: RESIDUE_BUDGET_MS })
  //    …and Company B's employee is visible (positive proof the view reloaded
  //    under the NEW company, not merely went blank)
  await expect(page.getByText("E2E SecondCo Employee")).toBeVisible({ timeout: RESIDUE_BUDGET_MS })
  await expect(switcher).toContainText(/E2E Second Company/i)

  // 5) switch back to Company A — the reverse direction must hold too
  await switcher.click()
  await page.getByRole("menuitem").filter({ hasText: "E2E Journeys Ltd" }).first().click()
  await expect(page.getByText("E2E SecondCo Employee")).toBeHidden({ timeout: RESIDUE_BUDGET_MS })
  await expect(page.getByText("Journey Employee")).toBeVisible({ timeout: RESIDUE_BUDGET_MS })
  await expect(switcher).toContainText(/E2E Journeys/i)
})

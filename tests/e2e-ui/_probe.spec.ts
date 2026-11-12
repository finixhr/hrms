import { test, expect } from "@playwright/test"
const EMAIL = process.env.E2E_OWNER_EMAIL || "owner@e2e.local"
const PASSWORD = process.env.E2E_PASSWORD || "E2ePass@123"
test("probe — All Companies switch diagnostics", async ({ page }) => {
  page.on("console", (m) => { if (m.type() === "error") console.log("[console.error]", m.text().slice(0, 200)) })
  page.on("response", async (r) => {
    if (r.url().includes("/api/hrm") && r.status() >= 400) {
      console.log("[rpc]", r.status(), (await r.text()).slice(0, 300))
    }
  })
  await page.goto("/app")
  await expect(page.getByRole("button", { name: /sign in/i })).toBeVisible({ timeout: 30_000 })
  await page.getByLabel(/email/i).first().fill(EMAIL)
  await page.getByLabel(/password/i).first().fill(PASSWORD)
  await page.getByRole("button", { name: /sign in/i }).click()
  await expect(page.getByText(/dashboard/i).first()).toBeVisible({ timeout: 30_000 })
  const switcher = page.getByRole("button", { name: /switch company/i })
  await expect(switcher).toBeVisible({ timeout: 30_000 })
  console.log("[probe] switcher text BEFORE:", (await switcher.textContent())?.slice(0, 80))
  await switcher.click()
  const allItem = page.getByRole("menuitem", { name: /all companies/i })
  const n = await allItem.count()
  console.log("[probe] 'All Companies' menuitem count:", n)
  if (n === 0) {
    console.log("[probe] menu text:", (await page.getByRole("menu").textContent())?.slice(0, 400))
  } else {
    await allItem.first().click()
    await page.waitForTimeout(4000)
    console.log("[probe] switcher text AFTER:", (await switcher.textContent())?.slice(0, 80))
    const toast = await page.textContent("body").catch(() => "")
    const m = toast?.match(/(Could not switch company[^"<]*|All Companies view[^"<]*)/)
    console.log("[probe] toast:", m ? m[1] : "(none captured)")
    console.log("[probe] banner count:", await page.locator('[data-testid="all-companies-banner"]').count())
  }
})

// Verify onboarding.status on a FRESHLY provisioned tenant (clean workspace)
// and on the fully-seeded demo tenant — mirrors what the dashboard widget calls.
import "../tests/preload"
import { db } from "../src/lib/db"
import { getRoute } from "../src/hrm-server/routes/router"
import { hashPassword } from "../src/hrm-server/auth"
import type { Ctx } from "../src/hrm-server/types"

const call = async (action: string, ctx: Ctx, payload: any = {}) => {
  const def = getRoute(action)
  if (!def) throw new Error(`Route ${action} not found`)
  return def.handler(ctx, payload)
}

const mkCtx = (userId: string, vendorId: string, role: Ctx["role"]): Ctx => ({
  userId, vendorId, role, permissions: new Set(["dashboard.view", "settings.view"]),
  csrfToken: "x", userName: "OB Admin",
})

// ---- 1. fresh tenant: vendor + one admin, nothing else ----
const vendor = await db.vendor.create({ data: { code: `OB${Date.now().toString(36).slice(-5)}`.toUpperCase(), name: "Onboarding Test Co", active: true } as any })
const admin = await db.user.create({
  data: {
    vendorId: vendor.id, email: `ob-admin-${Date.now()}@test.local`, passwordHash: hashPassword("Xx-Onboarding-2026!"),
    name: "OB Admin", role: "VENDOR_OWNER", permissions: "[]", status: "ACTIVE",
  } as any,
})
const fresh = await call("onboarding.status", mkCtx(admin.id, vendor.id, "VENDOR_OWNER"))
console.log("FRESH tenant:", JSON.stringify({
  completed: (fresh as any).completed, total: (fresh as any).total,
  done: (fresh as any).steps.filter((s: any) => s.done).map((s: any) => s.key),
}, null, 0))

// ---- 2. dismiss flow ----
const dismissed = await call("onboarding.dismiss", mkCtx(admin.id, vendor.id, "VENDOR_OWNER"))
console.log("dismiss →", JSON.stringify(dismissed))
const afterDismiss = await call("onboarding.status", mkCtx(admin.id, vendor.id, "VENDOR_OWNER"))
console.log("after dismiss, dismissedAt =", (afterDismiss as any).dismissedAt ? "SET (widget hidden)" : "MISSING")

// ---- 3. seeded demo tenant (finixhr) should be complete ----
const demoVendor = await db.vendor.findFirst({ where: { code: "FINIX" } })
if (demoVendor) {
  const demoAdmin = await db.user.findFirst({ where: { vendorId: demoVendor.id, role: "VENDOR_OWNER" } })
  if (demoAdmin) {
    const demo = await call("onboarding.status", mkCtx(demoAdmin.id, demoVendor.id, "VENDOR_OWNER"))
    console.log("DEMO tenant:", JSON.stringify({ completed: (demo as any).completed, total: (demo as any).total }))
  }
}
await db.$disconnect()

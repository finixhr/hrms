/// <reference types="bun-types" />
// ============ W1 boot-critical smoke ============
// Exit 0 = the process can safely serve: env keys OK, env values OK, the
// route registry loads (R-01 loud shadows + collision guard), and the R-26
// multi-company schema assertion passes against the DATABASE_URL the caller
// exported (the unit DB, a replay DB, or any target the procedure names).
import { register, assertMultiCompanySchema } from "@/instrumentation"

// R-01 registry smoke: the module graph loads, the 4 audited SEC-06 shadows
// warn loudly, and a fresh collision throws.
const { routes, route } = await import("@/hrm-server/routes/router").then(() => import("@/hrm-server/routes/registry"))
console.log("ROUTES_LOADED:", Object.keys(routes).length)
let threw = false
try {
  route("auth.login", { handler: async () => ({ ok: true }) } as any)
} catch {
  threw = true
}
console.log("NEW_COLLISION_THROWS:", threw)
if (!threw) {
  console.error("R-01 guard did NOT throw on a fresh collision")
  process.exit(1)
}

// R-26 schema assertion against the caller's DATABASE_URL (read-only).
try {
  await assertMultiCompanySchema()
  console.log("R26_SCHEMA_ASSERTION: OK (all five M1 columns present)")
} catch (e) {
  console.error(e instanceof Error ? e.message : e)
  process.exit(1)
}

// register() runs the full boot path (env keys, env values) WITHOUT starting
// the background workers (ZKTECO_ADMS_ENABLED / HRM_JOBS_ENABLED bypasses are
// honored by the caller's env).
process.env.ZKTECO_ADMS_ENABLED = process.env.ZKTECO_ADMS_ENABLED ?? "false"
process.env.HRM_JOBS_ENABLED = process.env.HRM_JOBS_ENABLED ?? "false"
await register()
console.log("REGISTER_SMOKE_OK")

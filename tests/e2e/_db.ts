// ============ E2E scratch-database helper (TEST-01 R7) =======================
// Creates / drops the throwaway database the E2E lane boots the app against.
// Same pattern as scripts/migrate-fresh-smoke.ts (admin client on the
// 'postgres' database); refuses anything that looks like production.
import { PrismaClient } from "@prisma/client"

const BASE_URL = process.env.DATABASE_URL || process.env.TEST_DATABASE_URL || ""
if (/production/i.test(BASE_URL)) {
  console.error("[e2e-db] REFUSING: URL looks like production")
  process.exit(1)
}
if (!BASE_URL) {
  console.error("[e2e-db] REFUSING: no DATABASE_URL")
  process.exit(1)
}
const SCRATCH = process.env.E2E_DB || "hrm_e2e"
const scratchUrl = BASE_URL.replace(/\/[^/?]+(\?|$)/, `/${SCRATCH}$1`)
if (scratchUrl === BASE_URL) {
  console.error("[e2e-db] REFUSING: could not rewrite database name in URL")
  process.exit(1)
}

const admin = new PrismaClient({ datasources: { db: { url: BASE_URL.replace(/\/[^/?]+(\?|$)/, "/postgres$1") } } })

const cmd = process.argv[2] || "create"
async function main() {
  if (cmd === "drop") {
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${SCRATCH}" WITH (FORCE)`)
    console.log(`[e2e-db] dropped ${SCRATCH}`)
  } else if (cmd === "print-url") {
    console.log(scratchUrl)
  } else {
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${SCRATCH}" WITH (FORCE)`)
    await admin.$executeRawUnsafe(`CREATE DATABASE "${SCRATCH}"`)
    console.log(`[e2e-db] fresh ${SCRATCH} ready`)
  }
}
main().catch((e) => { console.error(e); process.exit(1) }).finally(() => admin.$disconnect())

// H-01/H-02 — destructive-script safety guard for one-off TypeScript scripts.
// Every script that mutates the database MUST call this FIRST:
//   requireConfirmation("task16-cleanup")
// Rules:
//   1. Never runs with NODE_ENV=production (refuse, exit 1).
//   2. A DATABASE_URL containing "test" is allowed (unit/e2e scratch DBs).
//   3. Anything else requires an explicit --confirm flag (or
//      HRM_E2E_CONFIRM=I-AM-ON-TEST) so destructive runs are always deliberate.
export function requireConfirmation(scriptName: string): void {
  if (process.env.NODE_ENV === "production") {
    console.error(`ERROR: ${scriptName} refuses to run with NODE_ENV=production.`)
    console.error("       This script destroys data. Run it only against a test database.")
    process.exit(1)
  }
  const url = process.env.DATABASE_URL || ""
  const onTestDb = url.includes("test")
  const confirmed = process.argv.includes("--confirm") || process.env.HRM_E2E_CONFIRM === "I-AM-ON-TEST"
  if (!onTestDb && !confirmed) {
    console.error(`ERROR: ${scriptName} mutates the database and DATABASE_URL does not look like a test database.`)
    console.error(`       DATABASE_URL=${url || "(unset)"}`)
    console.error("       Re-run with --confirm (or HRM_E2E_CONFIRM=I-AM-ON-TEST) after verifying the target.")
    process.exit(1)
  }
}

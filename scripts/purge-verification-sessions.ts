// purge-verification-sessions.ts — hygiene before shipping the seed DB.
// Removes every Session row (verification logins from curl/browser runs).
// Login users, employees and all business data are untouched.
// H-01/H-02 — guarded: refuses production + non-test DBs without --confirm.
import { PrismaClient } from "@prisma/client"
import { requireConfirmation } from "./lib/guard"
requireConfirmation("purge-verification-sessions")

const db = new PrismaClient()

async function main() {
  const before = await db.session.count()
  await db.session.deleteMany({})
  // forgot-password rate-limit scratch state is keyed by IP hash in memory, not DB — nothing else to clean.
  const after = await db.session.count()
  console.log(`sessions purged: ${before} -> ${after}`)
}

main().finally(() => db.$disconnect())

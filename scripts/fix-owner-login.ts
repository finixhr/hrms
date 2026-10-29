// ============ fix-owner-login.ts — repair the SaaS owner console login ============
//
// USE WHEN: /owner/login says "Invalid email or password" for the credentials
// in your .env (HRM_SAAS_OWNER_EMAIL / HRM_SAAS_OWNER_PASSWORD).
//
// WHY THIS EXISTS: `bun run seed:saas` only CREATES the owner account when it
// does not exist yet ("already exists — reused"). It never re-reads the
// password. So if your DB was seeded with a different password, the account
// got locked after repeated failed attempts, or the seed never ran, the seed
// alone can never make the .env credentials work.
//
// WHAT THIS DOES (idempotent — safe to run any number of times):
//   1. Reads HRM_SAAS_OWNER_EMAIL / _NAME / _PASSWORD from .env
//      (dev defaults: owner@finixhr.local / Platform Owner / SaasOwner@2026)
//   2. Owner row missing  → creates it (SUPER_ADMIN, ACTIVE)
//   3. Owner row existing → RESETS it to the .env password, sets status
//      ACTIVE, clears failedLoginCount / lockedUntil, drops old sessions
//   4. Live-verifies the fix by running the real ownerLogin() and prints
//      the exact credentials to use at /owner/login
//
// RUN (project root):
//   bun run scripts/fix-owner-login.ts
//   # or with an explicit DB:
//   DATABASE_URL="postgresql://..." bun run scripts/fix-owner-login.ts
import { db } from "../src/lib/db"
import { hashOwnerPassword, ownerLogin } from "../src/hrm-server/saas/owner-auth"
import { saasAudit } from "../src/hrm-server/saas/audit"

const PLACEHOLDER_PATTERNS = /^(Pass@123|Owner@123|CHANGE_ME|<|12345678|password)/i

async function main() {
  const email = (process.env.HRM_SAAS_OWNER_EMAIL || "owner@finixhr.local").toLowerCase().trim()
  const name = process.env.HRM_SAAS_OWNER_NAME || "Platform Owner"
  const password =
    process.env.HRM_SAAS_OWNER_PASSWORD || (process.env.NODE_ENV === "production" ? "" : "SaasOwner@2026")

  console.log("── fix-owner-login ────────────────────────────")
  console.log(`  database : ${process.env.DATABASE_URL?.replace(/:[^:@/]*@/, ":***@") || "(default)"} `)
  console.log(`  email    : ${email}`)

  if (!password) {
    console.error("✖ HRM_SAAS_OWNER_PASSWORD is not set. Add it to .env and re-run.")
    process.exit(1)
  }
  if (PLACEHOLDER_PATTERNS.test(password)) {
    console.error("✖ HRM_SAAS_OWNER_PASSWORD is a known placeholder — set a real password in .env and re-run.")
    process.exit(1)
  }
  if (password.length < 12) {
    console.error(`✖ HRM_SAAS_OWNER_PASSWORD must be at least 12 characters (got ${password.length}).`)
    process.exit(1)
  }

  try {
    const existing = await db.saasOwnerUser.findUnique({ where: { email } })

    if (!existing) {
      await db.saasOwnerUser.create({
        data: {
          email, name,
          passwordHash: hashOwnerPassword(password),
          roleKey: "SUPER_ADMIN",
          permissions: JSON.stringify([]), // empty = full SUPER_ADMIN template
          status: "ACTIVE",
        },
      })
      await saasAudit({ name: "fix-owner-login" }, "OWNER_USER_CREATED", "SaaSOwnerUser", null,
        `Owner super-admin ${email} created by fix-owner-login script`, {})
      console.log("  action   : CREATED owner super-admin (it did not exist)")
    } else {
      const sessions = await db.saasOwnerSession.count({ where: { ownerId: existing.id } })
      await db.saasOwnerUser.update({
        where: { id: existing.id },
        data: {
          name, // keep .env display name in sync
          passwordHash: hashOwnerPassword(password),
          status: "ACTIVE",
          failedLoginCount: 0,
          lockedUntil: null,
        },
      })
      if (sessions > 0) {
        await db.saasOwnerSession.deleteMany({ where: { ownerId: existing.id } })
      }
      await saasAudit({ name: "fix-owner-login" }, "OWNER_USER_RESET", "SaaSOwnerUser", existing.id,
        `Owner ${email} password reset + lockout cleared by fix-owner-login script`, {})
      console.log(`  action   : RESET existing owner (password, status→ACTIVE, lockout cleared, ${sessions} old session(s) dropped)`)
    }

    // ---- live verification with the real login path ----
    const sess = await ownerLogin(email, password, "127.0.0.1", "fix-owner-login")
    await db.saasOwnerSession.delete({ where: { id: sess.token } }).catch(() => {})
    console.log("")
    console.log("✔ FIXED AND VERIFIED — the real ownerLogin() now accepts these credentials.")
    console.log("  Open the owner console and sign in with:")
    console.log(`    URL      : /owner/login`)
    console.log(`    Email    : ${email}`)
    console.log(`    Password : (the HRM_SAAS_OWNER_PASSWORD value from your .env)`)
    console.log("────────────────────────────────────────────────")
  } catch (e: any) {
    if (String(e?.message || "").includes("does not exist") || e?.code === "P2021") {
      console.error("✖ The SaaS tables are missing from this database.")
      console.error("  Apply migrations first:  bunx prisma migrate deploy")
      console.error("  Then re-run:             bun run scripts/fix-owner-login.ts")
      process.exit(1)
    }
    console.error("✖ Unexpected error:", e?.message || e)
    process.exit(1)
  } finally {
    await db.$disconnect()
  }
}

main()

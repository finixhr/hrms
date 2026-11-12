// Reset smoke-test residue so saas-smoke.py can run cleanly:
//   · Rongin Traders owner → password Pass@123, no MFA, no expiry residue
//   · remove the smoke SALES_MANAGER owner user
// Run with DATABASE_URL pointed at the target DB.
//
// SEC-6 (P0 audit wave, 2026-11-09) — this script STRIPS a real tenant owner's
// MFA rows and resets their password to the publicly documented Pass@123.
// Run against production (no NODE_ENV check, no confirmation anywhere), it
// was an instant account-takeover primitive sitting next to the seed scripts.
// It now carries the SAME requireConfirmation() gate reset-test-users.ts uses:
//   · refuses NODE_ENV=production outright;
//   · a DATABASE_URL containing "test" is allowed (unit/e2e scratch DBs);
//   · anything else requires --confirm (or HRM_E2E_CONFIRM=I-AM-ON-TEST).
import { db } from "../src/lib/db"
import { hashPassword } from "../src/hrm-server/auth"
import { requireConfirmation } from "./lib/guard"

requireConfirmation("reset-smoke-residue")

// 1. Rongin owner reset
const rongin = await db.vendor.findUnique({ where: { code: "RONGIN" } })
if (rongin) {
  const owner = await db.user.findFirst({ where: { vendorId: rongin.id, role: "VENDOR_OWNER" } })
  if (owner) {
    await db.userMfaSecret.deleteMany({ where: { userId: owner.id } })
    await db.session.deleteMany({ where: { userId: owner.id } })
    await db.user.update({
      where: { id: owner.id },
      data: {
        passwordHash: hashPassword("Pass@123"),
        mfaEnrolled: false,
        passwordChangedAt: new Date(),
        failedLoginCount: 0,
        lockedUntil: null,
        passwordResetToken: null,
        passwordResetExpiresAt: null,
      },
    })
    console.log(`Rongin owner reset: ${owner.email}`)
  }
} else {
  console.log("RONGIN vendor not found (skipped)")
}

// 2. smoke SALES_MANAGER owner user
const deleted = await db.saasOwnerUser.deleteMany({ where: { email: "sales@finixhr.local" } })
console.log(`smoke sales owner removed: ${deleted.count}`)
// also drop its sessions (cascade should handle, but be explicit)
await db.saasOwnerSession.deleteMany({ where: { owner: { email: "sales@finixhr.local" } } }).catch(() => {})

// 3. any leftover smoke-tenant admins (safety net)
await db.saasOwnerUser.deleteMany({ where: { email: { contains: "smoketest" } } })

await db.$disconnect()

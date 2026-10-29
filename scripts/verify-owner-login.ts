// ============ verify-owner-login.ts — prove the .env owner credentials work ====
// Calls the exact same ownerLogin() the /api/owner route uses. Run:
//   DATABASE_URL="postgresql://hrm_user:HRM%402026%23Local@127.0.0.1:5432/hrm" \
//     bun run scripts/verify-owner-login.ts
import { ownerLogin } from "../src/hrm-server/saas/owner-auth"
import { db } from "../src/lib/db"

const email = process.env.HRM_SAAS_OWNER_EMAIL || "owner@finixhr.local"
const password = process.env.HRM_SAAS_OWNER_PASSWORD || "SaasOwner@2026"

async function main() {
  console.log(`Verifying owner login for: ${email}`)
  try {
    const res: any = await ownerLogin(email, password, "127.0.0.1", "verify-script")
    if (res.mfaRequired) {
      console.log("✔ PASSWORD OK — account has MFA enabled (login now requires a TOTP code)")
      process.exit(0)
    }
    if (res.mfaEnrollmentRequired) {
      console.log("✔ PASSWORD OK — platform requires MFA and this account must enroll first")
      process.exit(0)
    }
    console.log("✔ LOGIN OK")
    console.log(`  owner : ${res.owner.name} <${res.owner.email}>`)
    console.log(`  role  : ${res.owner.roleKey}`)
    console.log(`  perms : ${res.owner.permissions.length} grants`)
    console.log(`  token : ${res.token.slice(0, 8)}… (session created)`)
    // clean up the probe session
    await db.saasOwnerSession.delete({ where: { id: res.token } }).catch(() => {})
    console.log("  (probe session removed)")
  } catch (e: any) {
    console.error(`✖ LOGIN FAILED: ${e.message} (code ${e.code ?? "?"})`)
    process.exit(1)
  } finally {
    await db.$disconnect()
  }
}
main()

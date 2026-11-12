// ============ Migration — add camera.* permissions to existing User.permissions ============
// Fixes the "Permission denied: camera.launch is not granted to your role" error
// that occurs when a user has explicit permissions (set via Settings → Users)
// that were saved BEFORE the Camera Manager module was added.
//
// The auth.ts permission resolution (line 179-180) uses explicit grants
// (User.permissions) to REPLACE the role template — so if camera.* isn't in
// the explicit grants, it won't be resolved even though ROLE_TEMPLATES has it.
//
// This script adds camera.* grants ADDITIVELY to every User row (never removes
// existing grants). Idempotent — running twice is a no-op.
//
// Run: bun run scripts/migrate-user-perms-cameras.ts
import { PrismaClient } from "@prisma/client"
const db = new PrismaClient()

const CAMERA_PERMS: Record<string, string[]> = {
  HR_ADMIN: ["camera.view", "camera.create", "camera.edit", "camera.delete", "camera.launch", "camera.manage"],
  VENDOR_OWNER: ["camera.view", "camera.create", "camera.edit", "camera.delete", "camera.launch", "camera.manage"],
  HR_MANAGER: ["camera.view", "camera.create", "camera.edit", "camera.launch"],
  BRANCH_MANAGER: ["camera.view", "camera.launch"],
  PAYROLL_OFFICER: [],
  DEPT_MANAGER: [],
  EMPLOYEE: [],
}

async function main() {
  const users = await db.user.findMany()
  console.log(`Found ${users.length} users`)

  for (const u of users) {
    // Skip users with empty permissions ([] = derive from role template at
    // login — ROLE_TEMPLATES already includes camera.*, so they're fine)
    const explicit = JSON.parse(u.permissions || "[]") as string[]
    if (!explicit.length) {
      console.log(`• ${u.email} (${u.role}): no explicit perms — derives from template (camera.* included) ✓`)
      continue
    }

    // User has explicit perms — add camera.* if missing
    const add = CAMERA_PERMS[u.role] || []
    if (!add.length) {
      console.log(`• ${u.email} (${u.role}): no camera grants by design`)
      continue
    }

    const perms = new Set(explicit)
    const before = perms.size
    for (const p of add) perms.add(p)
    const after = [...perms]

    if (after.length === before) {
      console.log(`• ${u.email} (${u.role}): already has ${add.length} camera grants`)
      continue
    }

    await db.user.update({
      where: { id: u.id },
      data: { permissions: JSON.stringify(after) },
    })
    console.log(`+ ${u.email} (${u.role}): added ${after.length - before} camera permission(s) → ${after.length} total`)
  }

  console.log("\ncamera user permission migration complete")
  console.log("Users with explicit permissions now have camera.* grants.")
  console.log("Users with [] permissions derive from ROLE_TEMPLATES (already includes camera.*).")
  console.log("\nAffected users must LOG OUT and LOG BACK IN for the new permissions to take effect.")
}

main().catch((e) => { console.error(e); process.exit(1) }).finally(() => db.$disconnect())

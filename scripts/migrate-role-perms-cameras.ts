// ============ Migration — add camera.* permissions to DB Role rows ============
// Phase 3 deliverable (Camera Manager §C7 + confirmed §11 table). Sibling
// script to scripts/migrate-role-perms.ts (which added procurement/inventory
// grants). Same pattern: ADDITIVE only — never removes custom admin edits,
// idempotent (running twice is a no-op), skips cleanly when no DB Role rows
// exist (the static ROLE_TEMPLATES in src/hrm-server/types.ts already carry
// camera.* for new tenants).
//
// Run: bun run scripts/migrate-role-perms-cameras.ts
//
// Permission map (confirmed by the user — Camera Manager Phase 2 §2):
//   HR_ADMIN         → camera.view, camera.create, camera.edit, camera.delete, camera.launch, camera.manage
//   VENDOR_OWNER     → (same as HR_ADMIN — both inherit TENANT_ADMIN_PERMS)
//   HR_MANAGER       → camera.view, camera.create, camera.edit, camera.launch  (no delete, no manage)
//   BRANCH_MANAGER   → camera.view, camera.launch  (branch-scoped via cameraScopeFilter at runtime)
//   PAYROLL_OFFICER  → (no camera grants — physical security isn't a payroll concern)
//   DEPT_MANAGER     → (no camera grants — they have zero devices.* in the existing template too)
//   EMPLOYEE         → (no camera grants — self-service only)
//
// Verb split note (Camera Manager §11): permission "camera.edit" maps to audit
// action "camera.update" (mirrors devices.ts:178 — the existing convention is
// permission .edit → audit .update). Other verbs match 1:1.
import { PrismaClient } from "@prisma/client"
const db = new PrismaClient()

// module → actions granted per role (mirrors ROLE_TEMPLATES in src/hrm-server/types.ts)
const ADDITIONS: Record<string, string[]> = {
  HR_ADMIN: ["camera.view", "camera.create", "camera.edit", "camera.delete", "camera.launch", "camera.manage"],
  VENDOR_OWNER: ["camera.view", "camera.create", "camera.edit", "camera.delete", "camera.launch", "camera.manage"],
  HR_MANAGER: ["camera.view", "camera.create", "camera.edit", "camera.launch"],
  BRANCH_MANAGER: ["camera.view", "camera.launch"],
  PAYROLL_OFFICER: [],
  DEPT_MANAGER: [],
  EMPLOYEE: [],
}

async function main() {
  const roles = await db.role.findMany()
  if (!roles.length) {
    console.log("no DB Role rows — static ROLE_TEMPLATES apply (nothing to do)")
    return
  }
  for (const r of roles) {
    const add = ADDITIONS[r.key] || []
    if (!add.length) { console.log(`• ${r.key}: nothing to add (no camera grants by design)`); continue }
    const perms = new Set(JSON.parse(r.permissions || "[]") as string[])
    const before = perms.size
    for (const p of add) perms.add(p)
    const after = [...perms]
    if (after.length === before) { console.log(`• ${r.key}: already has ${add.length} camera grants`); continue }
    await db.role.update({ where: { id: r.id }, data: { permissions: JSON.stringify(after) } })
    console.log(`+ ${r.key}: added ${after.length - before} permission(s) → ${after.length} total`)
  }
  console.log("camera role permission migration complete")
}

main().catch((e) => { console.error(e); process.exit(1) }).finally(() => db.$disconnect())

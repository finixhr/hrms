// ============ Migration — add procurement/inventory permissions to DB Role rows ============
// Vendor-scoped Role rows override the static ROLE_TEMPLATES at login time.
// Existing databases have Role rows snapshotted before the procurement and
// inventory modules existed — this adds the missing grants ADDITIVELY
// (custom admin edits are preserved; nothing is removed).
// Run: bun run scripts/migrate-role-perms.ts
import { PrismaClient } from "@prisma/client"
const db = new PrismaClient()

// module → actions granted per role (mirrors src/hrm-server/types.ts ROLE_TEMPLATES)
const ADDITIONS: Record<string, string[]> = {
  HR_ADMIN: [
    "procurement.view", "procurement.create", "procurement.edit", "procurement.approve",
    "inventory.view", "inventory.create", "inventory.edit", "inventory.approve",
  ],
  HR_MANAGER: ["procurement.view", "procurement.approve", "inventory.view"],
  DEPT_MANAGER: ["procurement.view", "procurement.approve"],
  BRANCH_MANAGER: ["procurement.view", "procurement.approve"],
  PAYROLL_OFFICER: [],
  EMPLOYEE: ["procurement.create"],
  VENDOR_OWNER: ["procurement.view", "procurement.approve", "inventory.view"],
}

async function main() {
  const roles = await db.role.findMany()
  if (!roles.length) {
    console.log("no DB Role rows — static ROLE_TEMPLATES apply (nothing to do)")
    return
  }
  for (const r of roles) {
    const add = ADDITIONS[r.key] || []
    if (!add.length) { console.log(`• ${r.key}: nothing to add`); continue }
    const perms = new Set(JSON.parse(r.permissions || "[]") as string[])
    const before = perms.size
    for (const p of add) perms.add(p)
    const after = [...perms]
    if (after.length === before) { console.log(`• ${r.key}: already has ${add.length} procurement/inventory grants`); continue }
    await db.role.update({ where: { id: r.id }, data: { permissions: JSON.stringify(after) } })
    console.log(`+ ${r.key}: added ${after.length - before} permission(s) → ${after.length} total`)
  }
  console.log("role permission migration complete")
}

main().catch((e) => { console.error(e); process.exit(1) }).finally(() => db.$disconnect())

// ============ Owner-console role resolution (Roles & Permissions) ============
// Shared by owner-auth (session/login), notify (permission-targeted fan-out)
// and the roles console routes. Kept in its own module to avoid a circular
// import between owner-auth.ts and notify.ts.
//
// Resolution order for a SaasOwnerUser's effective permissions:
//   1. explicit per-user grants (SaasOwnerUser.permissions JSON, non-empty)
//   2. the role's SaasOwnerRole row — when active, its permission list; when
//      INACTIVE, an EMPTY list (deny all for template-derived users; explicit
//      per-user grants still apply)
//   3. the static built-in template (OWNER_ROLE_TEMPLATES) — this covers
//      deployments that never seed role rows
import { db } from "@/lib/db"
import { OWNER_ROLE_LABELS, OWNER_ROLE_TEMPLATES, type OwnerRoleKey } from "./constants"

export function parseOwnerPermissions(json: string | null | undefined): string[] {
  try {
    const list = JSON.parse(json || "[]")
    return Array.isArray(list) ? list.map(String).filter(Boolean) : []
  } catch {
    return []
  }
}

/** Effective permission list for one owner user (explicit grants override the
 *  role; deactivated custom role = empty set unless the user has explicit
 *  grants). Pure read — no audit side effects. */
export async function resolveOwnerUserPermissions(owner: {
  roleKey: string
  permissions: string
}): Promise<string[]> {
  const explicit = parseOwnerPermissions(owner.permissions)
  if (explicit.length > 0) return explicit
  return resolveOwnerRolePermissions(owner.roleKey)
}

/** Permission list granted by a role KEY: DB row (custom or seeded system
 *  role, honoring its active flag) with fallback to the static template. */
export async function resolveOwnerRolePermissions(roleKey: string): Promise<string[]> {
  const row = await db.saasOwnerRole.findUnique({ where: { key: roleKey } })
  if (row) {
    if (!row.active) return []
    return parseOwnerPermissions(row.permissions)
  }
  return OWNER_ROLE_TEMPLATES[roleKey as OwnerRoleKey] || []
}

/** Every defined role key the owner console accepts (DB rows + built-in
 *  template keys) — used by users.save to validate roleKey assignments. */
export async function allOwnerRoleKeys(): Promise<string[]> {
  const rows = await db.saasOwnerRole.findMany({ select: { key: true } })
  const dbKeys = rows.map((r) => r.key)
  return Array.from(new Set([...dbKeys, ...Object.keys(OWNER_ROLE_TEMPLATES)]))
}

/** Seed the 5 built-in template roles as isSystem rows on first access, so the
 *  Roles & Permissions console can display and edit them. Idempotent; never
 *  overwrites existing rows (including ones edited by the console). Also safe
 *  on fresh databases where no roles exist yet.
 *
 * R11 (2026-10-12) — NEW-permission backfill: when the permission vocabulary
 * grows (e.g. communication.view/manage), deployments with already-seeded
 * role rows would never see the new keys (the createMany above only fills
 * MISSING roles). A version-gated merge appends the template set to existing
 * system roles ONCE per version marker (SaasSetting `roles.permsVersion`):
 * extra manual grants are preserved, and any later deliberate REMOVAL by the
 * Roles console stays respected because the marker never re-runs. */
const ROLE_PERMS_VERSION = "2026-10-26-support-view" // 2026-10-26 — support.view backfill (Support Center tabs 1-2 fix)
export async function ensureSystemOwnerRolesSeeded(): Promise<void> {
  const existing = await db.saasOwnerRole.findMany({ where: { isSystem: true }, select: { id: true, key: true, permissions: true } })
  const have = new Set(existing.map((r) => r.key))
  const missing = (Object.keys(OWNER_ROLE_TEMPLATES) as OwnerRoleKey[]).filter((k) => !have.has(k))
  if (missing.length > 0) {
    await db.saasOwnerRole.createMany({
      data: missing.map((key) => ({
        key,
        name: OWNER_ROLE_LABELS[key] || key,
        description: `Built-in platform role (editable, not deletable).`,
        permissions: JSON.stringify(OWNER_ROLE_TEMPLATES[key]),
        isSystem: true,
        active: true,
      })),
      skipDuplicates: true,
    }).catch(() => {})
    return // fresh rows already carry the full template — no backfill needed
  }

  // version-gated one-time backfill for deployments upgraded mid-flight
  const marker = await db.saasSetting.findUnique({ where: { group_key: { group: "platform", key: "roles.permsVersion" } } })
  if (marker?.value === JSON.stringify(ROLE_PERMS_VERSION)) return
  for (const row of existing) {
    const template = (OWNER_ROLE_TEMPLATES as Record<string, string[]>)[row.key]
    if (!template) continue
    const stored = parseOwnerPermissions(row.permissions)
    const notGranted = template.filter((p) => !stored.includes(p))
    if (notGranted.length === 0) continue
    const merged = Array.from(new Set([...stored, ...notGranted]))
    await db.saasOwnerRole.update({ where: { id: row.id }, data: { permissions: JSON.stringify(merged) } }).catch(() => {})
  }
  // 2026-10-26 — explicit per-user grants REPLACE the role set (see
  // resolveOwnerUserPermissions), so the role-row merge above cannot reach
  // owner users carrying explicit grant lists saved before the Support
  // Center shipped. Additive pass mirroring the tenant plane's
  // migrate-user-perms-cameras.ts precedent: only users already holding some
  // support.* grant (support-desk staff) receive the new support.view key —
  // users with unrelated minimal grant lists are left untouched.
  const owners = await db.saasOwnerUser.findMany({ select: { id: true, email: true, permissions: true } })
  for (const u of owners) {
    const explicit = parseOwnerPermissions(u.permissions)
    if (!explicit.length || explicit.includes("support.view")) continue
    if (!explicit.some((p) => p.startsWith("support."))) continue
    await db.saasOwnerUser.update({
      where: { id: u.id },
      data: { permissions: JSON.stringify([...explicit, "support.view"]) },
    }).catch(() => {})
  }
  await db.saasSetting.upsert({
    where: { group_key: { group: "platform", key: "roles.permsVersion" } },
    create: { group: "platform", key: "roles.permsVersion", value: JSON.stringify(ROLE_PERMS_VERSION) },
    update: { value: JSON.stringify(ROLE_PERMS_VERSION) },
  }).catch(() => {})
}

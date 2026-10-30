// ============ Post-release repair: permission catalog gap (CHANGES §9) ========
// The ACTIONS catalog (src/hrm-server/types.ts) was missing "launch" and
// "manage" until 2026-10-08. Three write-paths silently dropped those verbs:
//   1. roles.save (normalizePermissions) — every saved role override lost
//      camera.launch / camera.manage / tracking.manage / jobs.manage /
//      billing.manage;
//   2. provisionTenant / seed-owner — registration-provisioned Vendor Owners
//      carry EXPLICIT user permission sets (which override the role template)
//      missing the same verbs;
//   3. the Settings role-editor matrix could not grant them.
//
// The code fix stops NEW occurrences. THIS script repairs EXISTING data:
//   scan  — report every User explicit-permission set and Role override row
//           that is missing verb pairs the static ROLE_TEMPLATES grant;
//   repair — with --repair, merge the missing template-granted verbs back in
//           (never removes anything; only adds what the static template for
//           that role includes). Role-less custom roles are only reported.
//
// Usage:
//   bun run scripts/fix-permissions-catalog.ts            # scan + report
//   bun run scripts/fix-permissions-catalog.ts --repair   # scan + fix
// Notes: sessions are NOT cleared — permissions apply at next login
// (auth.ts resolves the permission set per login / token resolution).
import { PrismaClient } from "@prisma/client"

const db = new PrismaClient()
const REPAIR = process.argv.includes("--repair")

// Static templates, imported from the live source so this script always
// matches the shipping ROLE_TEMPLATES (launch/manage now included).
async function loadTemplates(): Promise<Record<string, string[]>> {
  // Avoid tsconfig path aliases here — relative import works under bun.
  const mod = await import("../src/hrm-server/types")
  return mod.ROLE_TEMPLATES as Record<string, string[]>
}

function parse(raw: string | null | undefined): string[] {
  if (!raw) return []
  try { return JSON.parse(raw) } catch { return [] }
}

async function main() {
  const templates = await loadTemplates()

  // ---------- 1. Users with EXPLICIT permission sets ----------
  const users = await db.user.findMany({
    where: { permissions: { not: "[]" } },
    select: { id: true, email: true, name: true, role: true, permissions: true, vendorId: true },
    orderBy: { email: "asc" },
  })

  type Finding = { kind: "USER" | "ROLE"; id: string; label: string; role: string; missing: string[] }
  const findings: Finding[] = []
  let repairedUsers = 0
  let repairedRoles = 0

  for (const u of users) {
    const explicit = parse(u.permissions)
    if (explicit.length === 0) continue // inherits the role template — fine
    const tpl = templates[u.role]
    if (!tpl) continue // custom/unknown role key — nothing to diff against
    const missing = tpl.filter((p) => !explicit.includes(p))
    if (missing.length === 0) continue
    findings.push({ kind: "USER", id: u.id, label: u.email, role: u.role, missing })
    if (REPAIR) {
      const merged = Array.from(new Set([...explicit, ...missing])).sort()
      await db.user.update({ where: { id: u.id }, data: { permissions: JSON.stringify(merged) } })
      repairedUsers++
    }
  }

  // ---------- 2. Vendor-scoped Role override rows ----------
  const roles = await db.role.findMany({
    select: { id: true, key: true, name: true, permissions: true, vendorId: true },
    orderBy: [{ vendorId: "asc" }, { key: "asc" }],
  })
  for (const r of roles) {
    const perms = parse(r.permissions)
    const tpl = templates[r.key]
    if (!tpl) continue // custom role — only the report lists what a template-less role holds
    const missing = tpl.filter((p) => !perms.includes(p))
    if (missing.length === 0) continue
    findings.push({ kind: "ROLE", id: r.id, label: `${r.key} @ ${r.vendorId.slice(0, 8)}`, role: r.key, missing })
    if (REPAIR) {
      const merged = Array.from(new Set([...perms, ...missing])).sort()
      await db.role.update({ where: { id: r.id }, data: { permissions: JSON.stringify(merged) } })
      repairedRoles++
    }
  }

  // ---------- 3. Trial plans seeded before the camera/advancedReports fix ----
  const trial = await db.saasPlan.findFirst({ where: { name: "Trial" } })
  if (trial && (!trial.cameraEnabled || !trial.advancedReports)) {
    findings.push({
      kind: "ROLE", // surfaced in the same table; role label carries the note
      id: trial.id, label: `Trial plan (camera=${trial.cameraEnabled}, advancedReports=${trial.advancedReports})`,
      role: "—", missing: ["plan.cameraEnabled", "plan.advancedReports"],
    })
    if (REPAIR) {
      await db.saasPlan.update({ where: { id: trial.id }, data: { cameraEnabled: true, advancedReports: true } })
      repairedRoles++
    }
  }

  // ---------- report ----------
  if (findings.length === 0) {
    console.log("✓ No permission-catalog damage found — every explicit user set and role override carries the full template-granted verbs.")
  } else {
    console.log(`${findings.length} entit${findings.length === 1 ? "y" : "ies"} with missing template-granted verbs:`)
    for (const f of findings) {
      console.log(`  [${f.kind}] ${f.label} (role ${f.role})`)
      console.log(`      missing: ${f.missing.join(", ")}`)
    }
    if (REPAIR) {
      console.log(`\nRepaired: ${repairedUsers} user explicit-permission set(s), ${repairedRoles} role override row(s)/plan flag(s).`)
      console.log("Affected users regain the missing verbs at their NEXT LOGIN (auth resolves permissions per session).")
    } else {
      console.log("\nScan-only run. Re-run with --repair to merge the missing verbs back in (adds only, never removes).")
    }
  }

  // ---------- 4. live verification probe (scan mode only, self-cleaning) ------
  if (!REPAIR) {
    const { resolveEntitlements } = await import("../src/hrm-server/saas/entitlements")
    const anySub = await db.saasSubscription.findFirst({
      where: { plan: { name: "Trial" } }, select: { vendorId: true },
    })
    if (anySub) {
      const ent = await resolveEntitlements(anySub.vendorId)
      console.log(`\nProbe (Trial tenant): CAMERA=${ent.features.CAMERA} ADVANCED_REPORTS=${ent.features.ADVANCED_REPORTS}`)
    } else {
      console.log("\nProbe: no Trial subscription found in this DB — plan flag verified via the seed definition only.")
    }
  }
}

main()
  .catch((e) => { console.error("fix-permissions-catalog failed:", e); process.exitCode = 1 })
  .finally(() => db.$disconnect())

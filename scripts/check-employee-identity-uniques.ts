// ============ M-6 — pre-deploy duplicate check for the identity uniques ============
// Migration 3_audit_remediation_20261002 creates unique indexes on
// (vendorId, officialEmail) and (vendorId, mobile). If existing data contains
// duplicates the migration FAILS on deploy — deliberately, so the constraint
// is never silently skipped. This script reports the colliding rows so an
// operator can fix them BEFORE deploying.
//
// Read-only. No modes, no writes, safe on production.
//   bun run scripts/check-employee-identity-uniques.ts
import { PrismaClient } from "@prisma/client"

const db = new PrismaClient()

async function dupes(field: "officialEmail" | "mobile") {
  const rows = await db.employee.findMany({
    where: { [field]: { not: null } },
    select: { id: true, vendorId: true, code: true, fullName: true, createdAt: true, [field]: true },
    orderBy: { vendorId: "asc" },
  })
  const counts = new Map<string, typeof rows>()
  for (const r of rows as any[]) {
    const v = String(r[field]).trim().toLowerCase()
    if (!v) continue
    const key = `${r.vendorId}|${v}`
    counts.set(key, [...(counts.get(key) || []), r])
  }
  return [...counts.entries()].filter(([, list]) => (list as any).length > 1)
}

// Audit follow-up 2026-10-03: the unique indexes treat '' as a REAL value —
// two employees of one vendor with mobile = '' (or " ") COLLIDE under
// "Employee_vendorId_mobile_key" even though they look "empty". Legacy
// SQLite data migrated verbatim is full of these. NULL is exempt; '' is not.
async function emptyStrings(field: "officialEmail" | "mobile") {
  const rows = await db.employee.findMany({
    where: { [field]: { not: null } },
    select: { id: true, vendorId: true, code: true, fullName: true, [field]: true },
    orderBy: { vendorId: "asc" },
  })
  const counts = new Map<string, typeof rows>()
  for (const r of rows as any[]) {
    if (String(r[field]).trim() !== "") continue // real values handled above
    const key = `${r.vendorId}|(empty string)`
    counts.set(key, [...(counts.get(key) || []), r])
  }
  return [...counts.entries()].filter(([, list]) => (list as any).length > 1)
}

async function main() {
  console.log("=== M-6 identity-unique pre-deploy check ===")
  console.log("(migration 3 creates unique (vendorId, officialEmail) and (vendorId, mobile))\n")
  let bad = 0
  for (const field of ["officialEmail", "mobile"] as const) {
    const d = await dupes(field)
    if (!d.length) {
      console.log(`${field}: no duplicates — unique index will apply cleanly.`)
    } else {
      bad += d.length
      console.log(`${field}: ${d.length} colliding value(s):`)
      for (const [key, list] of d) {
        console.log(`  ${key}`)
        for (const r of list as any[]) console.log(`    ${r.code} ${r.fullName} (id ${r.id})`)
      }
    }
    const e = await emptyStrings(field)
    if (e.length) {
      bad += e.length
      console.log(`${field}: ${e.length} vendor group(s) with MULTIPLE empty-string values (they collide too — NULL is exempt, '' is not):`)
      for (const [key, list] of e) {
        console.log(`  ${key}`)
        for (const r of list as any[]) console.log(`    ${r.code} ${r.fullName} (id ${r.id})`)
      }
    }
  }
  console.log("")
  if (bad === 0) {
    console.log("CLEAN — safe to deploy migration 3.")
  } else {
    console.log(`${bad} collision group(s) found — resolve them, then re-run.`)
    console.log("The migration deliberately fails while duplicates exist.")
    console.log("scripts/fix-identity-uniques.ts can clear them for you (dry-run by default).")
    process.exitCode = 1
  }
}

main()
  .catch((e) => { console.error("FAILED:", e); process.exitCode = 1 })
  .finally(() => db.$disconnect())

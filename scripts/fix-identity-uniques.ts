// ============ M-6 companion — resolve employee identity collisions ============
// Companion to scripts/check-employee-identity-uniques.ts and migration
// 3_audit_remediation_20261002. When the pre-deploy check reports collisions
// this script clears them MINIMALLY and auditably:
//
//   1. Empty/whitespace-only values are normalized to NULL everywhere
//      (NULL is exempt from the unique indexes; '' is not).
//   2. For each remaining duplicate (vendorId, officialEmail|mobile) group
//      the EARLIEST employee (createdAt, then id) KEEPS the value; every
//      later one has the field set to NULL. No rows are deleted. Every
//      change writes an EmployeeHistory row (eventType IDENTITY_DEDUP) so
//      the edit is traceable and an operator can restore a value in the UI.
//
// Safety: dry-run by default. --apply performs the writes. Refuses URLs
// that look like production unless --allow-production is also given.
//
//   bun run scripts/fix-identity-uniques.ts              # dry-run report
//   bun run scripts/fix-identity-uniques.ts --apply      # fix (dev/test)
import { PrismaClient } from "@prisma/client"

const db = new PrismaClient()
const APPLY = process.argv.includes("--apply")
const ALLOW_PROD = process.argv.includes("--allow-production")

const URL = process.env.DATABASE_URL || ""
if (/production/i.test(URL) && !(ALLOW_PROD && APPLY)) {
  console.error("REFUSING to run against a production-looking DATABASE_URL (pass --apply --allow-production after a backup)")
  process.exit(1)
}

type Field = "officialEmail" | "mobile"
const FIELDS: Field[] = ["officialEmail", "mobile"]

interface Plan {
  employeeId: string
  vendorId: string
  code: string
  fullName: string
  field: Field
  from: string
  keep: string // code of the employee that keeps the value ('' for empty-string normalization)
}

async function plan(): Promise<Plan[]> {
  const out: Plan[] = []
  for (const field of FIELDS) {
    const rows = await db.employee.findMany({
      where: { [field]: { not: null } },
      select: { id: true, vendorId: true, code: true, fullName: true, createdAt: true, [field]: true },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    })
    // 1. normalize empty/whitespace strings → NULL
    for (const r of rows as any[]) {
      if (String(r[field]).trim() === "") out.push({ employeeId: r.id, vendorId: r.vendorId, code: r.code, fullName: r.fullName, field, from: JSON.stringify(r[field]), keep: "" })
    }
    // 2. real-value collisions: earliest row keeps, later rows → NULL
    const groups = new Map<string, any[]>()
    for (const r of rows as any[]) {
      const v = String(r[field]).trim().toLowerCase()
      if (!v) continue
      const key = `${r.vendorId}|${v}`
      groups.set(key, [...(groups.get(key) || []), r])
    }
    for (const [, list] of groups) {
      if (list.length < 2) continue
      const keeper = list[0] // createdAt asc, id asc — earliest employee
      for (const r of list.slice(1)) {
        out.push({ employeeId: r.id, vendorId: r.vendorId, code: r.code, fullName: r.fullName, field, from: JSON.stringify(r[field]), keep: keeper.code })
      }
    }
  }
  return out
}

async function main() {
  console.log(`=== fix-identity-uniques (${APPLY ? "APPLY" : "DRY-RUN"}) ===\n`)
  const p = await plan()
  if (!p.length) {
    console.log("Nothing to fix — no identity collisions. Migration 3 can deploy.")
    return
  }
  for (const x of p) {
    const why = x.keep ? `duplicate of ${x.keep}` : "empty string collides under the unique index"
    console.log(`  ${x.code} ${x.fullName}: ${x.field} ${x.from} → NULL  (${why})`)
  }
  console.log(`\n${p.length} change(s) planned.`)
  if (!APPLY) {
    console.log("Dry-run only — re-run with --apply to write these changes.")
    return
  }
  const n = await db.$transaction(async (tx) => {
    for (const x of p) {
      await tx.employee.update({ where: { id: x.employeeId }, data: { [x.field]: null } as any })
      await tx.employeeHistory.create({
        data: {
          vendorId: x.vendorId,
          employeeId: x.employeeId,
          eventType: "IDENTITY_DEDUP",
          title: `${x.field} cleared for the identity unique index`,
          description: x.keep
            ? `${x.field} ${x.from} was a duplicate of employee ${x.keep}; cleared so migration 3_audit_remediation_20261002 can create the unique index. Restore a correct value in the employee editor if this row is the rightful owner.`
            : `${x.field} ${x.from} was an empty string; normalized to NULL so migration 3_audit_remediation_20261002 can create the unique index.`,
          dataJson: JSON.stringify({ field: x.field, from: x.from, keptBy: x.keep || null, reason: "M-6 identity uniques" }),
        },
      })
    }
    return p.length
  })
  console.log(`${n} change(s) applied + ${n} EmployeeHistory audit row(s) written.`)
  console.log("Re-run scripts/check-employee-identity-uniques.ts — expect CLEAN — then deploy migration 3.")
}

main()
  .catch((e) => { console.error("FAILED:", e); process.exitCode = 1 })
  .finally(() => db.$disconnect())

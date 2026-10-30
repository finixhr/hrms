// ============ Phase 4 WS-E — scale-fixture seeder (nightly perf lane) ============
// Generates the synthetic scale fixtures the audit's §11 exit criteria name:
//   --employees 5000    a 5,000-employee tenant (the employees.list /
//                       attendance-summary hot paths at the documented
//                       design load)
//   --vendors  100000   the 100,000-vendor fleet (owner-console + platform
//                       pass shapes at the 100K-tenant target)
//
// Everything is written with chunked createMany (no per-row round-trips) and
// SCALE-prefixed codes/names so a run is selectively removable:
//   employees: code LIKE 'SCALE-E%', vendors: code LIKE 'SCALE-V%'
//
// Usage:
//   bun run scripts/seed-scale.ts --employees 5000 --vendors 100000
//   HRM_PERF_PROFILE=nightly bun test tests/unit/phase4-perf-budget.test.ts
import { PrismaClient } from "@prisma/client"

const db = new PrismaClient()

function parseArgs(): { employees: number; vendors: number } {
  const args = process.argv.slice(2)
  const get = (name: string, fallback: number) => {
    const i = args.indexOf(`--${name}`)
    if (i >= 0 && args[i + 1]) return Math.max(0, Math.floor(Number(args[i + 1]) || 0))
    return fallback
  }
  return { employees: get("employees", 5000), vendors: get("vendors", 100000) }
}

const CHUNK = 1000

async function seedBigTenant(employees: number): Promise<string> {
  const suffix = Date.now().toString(36)
  const vendor = await db.vendor.create({
    data: { code: `SCALE-T-${suffix}`, name: `SCALE Fleet Tenant (${employees} employees)` },
  })
  console.log(`[seed-scale] big tenant ${vendor.code} (${vendor.id})`)
  let made = 0
  while (made < employees) {
    const n = Math.min(CHUNK, employees - made)
    await db.employee.createMany({
      data: Array.from({ length: n }, (_, i) => {
        const k = made + i
        return {
          vendorId: vendor.id,
          code: `SCALE-E${String(k).padStart(6, "0")}-${suffix}`,
          fullName: `Scale Employee ${k}`,
          status: k % 50 === 0 ? "PROBATION" : "ACTIVE",
          joiningDate: "2025-01-01",
        }
      }),
    })
    made += n
    process.stdout.write(`\r[seed-scale]   ${made}/${employees} employees`)
  }
  console.log("")
  return vendor.id
}

async function seedFleet(vendors: number): Promise<void> {
  const suffix = Date.now().toString(36)
  let made = 0
  while (made < vendors) {
    const n = Math.min(CHUNK, vendors - made)
    await db.vendor.createMany({
      data: Array.from({ length: n }, (_, i) => {
        const k = made + i
        return {
          code: `SCALE-V${String(k).padStart(6, "0")}-${suffix}`,
          name: `Scale Vendor ${k}`,
          active: k % 7 !== 0, // a realistic mostly-active mix
        }
      }),
    })
    made += n
    if (made % 10000 === 0 || made === vendors) process.stdout.write(`\r[seed-scale]   ${made}/${vendors} vendors`)
  }
  console.log("")
}

async function main() {
  const { employees, vendors } = parseArgs()
  console.log(`[seed-scale] seeding: ${employees} employees in one tenant, ${vendors} fleet vendors`)
  const t0 = Date.now()
  if (employees > 0) await seedBigTenant(employees)
  if (vendors > 0) await seedFleet(vendors)
  console.log(`[seed-scale] DONE in ${((Date.now() - t0) / 1000).toFixed(1)}s — SCALE-prefixed rows are selectively removable (code LIKE 'SCALE-%')`)
}

main()
  .catch((e) => { console.error("[seed-scale] FAILED:", e); process.exitCode = 1 })
  .finally(() => db.$disconnect())

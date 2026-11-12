// ============ H-9 repair — staging validation scenario (companion script) ============
// Seeds a disposable database with the corruption classes the old leave-balance
// discipline produced, so a human can validate
// scripts/repair-h9-leave-balances.ts on staging BEFORE touching production:
//
//   DATABASE_URL=postgres://…/hrm_staging bun run scripts/repair-h9-leave-balances-scenario.ts --seed
//   bun run scripts/repair-h9-leave-balances.ts                # dry-run: expect 3 rows
//   bun run scripts/repair-h9-leave-balances.ts --apply        # clamp
//   bun run scripts/repair-h9-leave-balances.ts --apply        # re-run: expect "ledger is consistent"
//   DATABASE_URL=… bun run scripts/repair-h9-leave-balances-scenario.ts --verify
//
// Expected verify output (recorded during remediation on 2026-10-02):
//   over-reserved: pending 6 → 4 | negative used: used -2 → 0 | negative pending: pending -1 → 0
//
// REFUSES production-looking URLs outright (this seeds corruption on purpose).
import { PrismaClient } from "@prisma/client"
const db = new PrismaClient()
const SEED = process.argv.includes("--seed")
const VERIFY = process.argv.includes("--verify")
const VENDOR_NAME = "H9 Repair Staging"

function gate() {
  const url = process.env.DATABASE_URL || ""
  if (!url || /prod/i.test(url)) {
    console.error("ERROR: this scenario script must run against a disposable staging/test database only.")
    process.exit(1)
  }
}

async function seed() {
  const vendor = await db.vendor.create({ data: { name: VENDOR_NAME, code: `V-${Date.now()}` } })
  const emp = await db.employee.create({
    data: { vendorId: vendor.id, fullName: "H9 Repair Emp", code: `E-${Date.now()}`, joiningDate: "2024-01-01", employmentType: "PERMANENT", status: "ACTIVE" },
  })
  const year = new Date().getFullYear() + 1
  const mk = (name: string, entitled: number, used: number, pending: number) =>
    db.leaveType.create({ data: { vendorId: vendor.id, code: `H9R-${name}-${Date.now()}`, name, defaultDays: entitled } })
      .then((t) => db.leaveBalance.create({ data: { vendorId: vendor.id, employeeId: emp.id, leaveTypeId: t.id, year, entitled, used, pending } }))
  // class 1: over-reserved (10 entitled, 4 used, 8 pending → 12 reserved/consumed > 10)
  await mk("Over", 10, 4, 8)
  // class 2: negative used (lost-update artifact)
  await mk("NegUsed", 10, -2, 0)
  // class 3: negative pending (double decrement artifact)
  await mk("NegPend", 10, 3, -1)
  console.log(`SEEDED 3 corrupted balance rows under vendor "${VENDOR_NAME}" (year ${year}): over-reserved, negative used, negative pending`)
}

async function verify() {
  const vendor = await db.vendor.findFirst({ where: { name: VENDOR_NAME }, orderBy: { createdAt: "desc" } })
  if (!vendor) throw new Error("staging vendor not found — run --seed first")
  // no Prisma relation between LeaveBalance and LeaveType — join manually
  const bals = await db.leaveBalance.findMany({ where: { vendorId: vendor.id } })
  const types = await db.leaveType.findMany({ where: { vendorId: vendor.id } })
  const typeName = new Map(types.map((t) => [t.id, t.name]))
  const find = (n: string) => bals.find((b) => (typeName.get(b.leaveTypeId) || "").startsWith(n))
  const over = find("Over"), negUsed = find("NegUsed"), negPend = find("NegPend")
  const ok = (cond: boolean) => (cond ? "✅" : "❌")
  console.log(`over-reserved:   pending 8 → ${over?.pending} ${ok(over?.pending === 6)} | entitled ${over?.entitled} used ${over?.used}`)
  console.log(`negative used:   used -2 → ${negUsed?.used} ${ok(negUsed?.used === 0)}`)
  console.log(`negative pending: pending -1 → ${negPend?.pending} ${ok(negPend?.pending === 0)}`)
  console.log(`non-negative everywhere: ${ok(bals.every((b) => b.pending >= 0 && b.used >= 0))}`)
}

gate()
if (SEED) seed().catch(fail)
else if (VERIFY) verify().catch(fail)
else {
  console.error("Usage: --seed | --verify")
  process.exit(1)
}
function fail(e: unknown) { console.error(e); process.exit(1) }

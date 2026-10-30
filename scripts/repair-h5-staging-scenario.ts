// ============ H-5 repair — staging validation scenario (companion script) ============
// Seeds a disposable database with the EXACT corruption the old payroll loan
// loop produced, so a human can validate scripts/repair-h5-loan-overrecovery.ts
// on staging BEFORE touching production:
//
//   DATABASE_URL=postgres://…/hrm_staging bun run scripts/repair-h5-staging-scenario.ts --seed
//   bun run scripts/repair-h5-loan-overrecovery.ts                # dry-run: expect 1 row, over 1000.00
//   bun run scripts/repair-h5-loan-overrecovery.ts --apply        # repair
//   bun run scripts/repair-h5-loan-overrecovery.ts --apply        # re-run: expect "No over-recovered entries"
//   DATABASE_URL=… bun run scripts/repair-h5-staging-scenario.ts --verify
//
// Expected verify output (recorded during remediation on 2026-10-02):
//   entry.loanDeduction = 1000 / credited after repair = 1000 EXACT
//   loan A: paid=1000 outstanding=4000 ACTIVE | loan B: paid=0 outstanding=4000 ACTIVE
//   history rows: 1 (LOAN_ADJUSTMENT)
//
// REFUSES production-looking URLs outright (this seeds corruption on purpose).
import { PrismaClient } from "@prisma/client"
const db = new PrismaClient()
const SEED = process.argv.includes("--seed")
const VERIFY = process.argv.includes("--verify")

function gate() {
  const url = process.env.DATABASE_URL || ""
  if (!url || /prod/i.test(url)) {
    console.error("ERROR: this scenario script must run against a disposable staging/test database only.")
    process.exit(1)
  }
}

async function seed() {
  const vendor = await db.vendor.create({ data: { name: "H5 Repair Staging", code: `V-${Date.now()}` } })
  const emp = await db.employee.create({
    data: { vendorId: vendor.id, fullName: "Repair Staging Emp", code: `E-${Date.now()}`, joiningDate: "2024-01-01", employmentType: "PERMANENT", status: "ACTIVE" },
  })
  const run = await db.payrollRun.create({
    data: { vendorId: vendor.id, periodMonth: 9, periodYear: 2026, status: "PAID", paymentDate: new Date().toISOString().slice(0, 10), totalGross: 9000, totalNet: 7000, employeeCount: 1 },
  })
  const entry = await db.payrollEntry.create({
    data: { vendorId: vendor.id, runId: run.id, employeeId: emp.id, status: "INCLUDED", gross: 9000, net: 7000, loanDeduction: 1000, breakdownJson: "{}" },
  })
  // OLD-ENGINE corruption: both loans credited the FULL deduction (1000 + 1000 > 1000)
  const loanA = await db.loan.create({ data: { vendorId: vendor.id, employeeId: emp.id, principal: 5000, outstanding: 4000, paidAmount: 1000, status: "ACTIVE", startDate: "2026-09-01" } })
  const loanB = await db.loan.create({ data: { vendorId: vendor.id, employeeId: emp.id, principal: 4000, outstanding: 3000, paidAmount: 1000, status: "ACTIVE", startDate: "2026-09-01" } })
  await db.loanInstallment.create({ data: { vendorId: loanA.vendorId, loanId: loanA.id, no: 1, dueDate: "2026-09-15", amount: 3000, paidAmount: 1000, status: "PARTIAL", payrollEntryId: entry.id, paidAt: new Date() } })
  await db.loanInstallment.create({ data: { vendorId: loanB.vendorId, loanId: loanB.id, no: 1, dueDate: "2026-09-15", amount: 2000, paidAmount: 1000, status: "PARTIAL", payrollEntryId: entry.id, paidAt: new Date() } })
  console.log(`SEEDED over-recovery under vendor "${vendor.name}": entry ${entry.id} | deduction 1000 | credited 2000 (A=1000, B=1000)`)
}

async function verify() {
  const vendor = await db.vendor.findFirst({ where: { name: "H5 Repair Staging" }, orderBy: { createdAt: "desc" } })
  if (!vendor) throw new Error("staging vendor not found — run --seed first")
  const entry = await db.payrollEntry.findFirst({ where: { vendorId: vendor.id }, orderBy: { id: "desc" } })
  if (!entry) throw new Error("staging entry not found — run --seed first")
  const insts = await db.loanInstallment.findMany({ where: { payrollEntryId: entry.id } })
  const loans = await db.loan.findMany({ where: { vendorId: vendor.id } })
  const hist = await db.employeeHistory.findMany({ where: { vendorId: vendor.id, eventType: "LOAN_ADJUSTMENT" } })
  const credited = insts.reduce((s, i) => s + i.paidAmount, 0)
  console.log("entry.loanDeduction =", entry.loanDeduction)
  console.log("credited after repair =", credited, Math.abs(credited - entry.loanDeduction) < 0.01 ? "✅ EXACT" : "❌ MISMATCH")
  for (const i of insts.sort((a, b) => a.loanId.localeCompare(b.loanId))) {
    console.log(`  installment ${i.id.slice(-6)}: paid=${i.paidAmount} status=${i.status} linked=${!!i.payrollEntryId}`)
  }
  for (const l of loans.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())) {
    console.log(`  loan ${l.id.slice(-6)}: paid=${l.paidAmount} outstanding=${l.outstanding} status=${l.status} (principal ${l.principal})`)
  }
  console.log("history rows:", hist.length, hist.length === 1 ? "✅" : "(expected 1 after one repair)")
}

gate()
if (SEED) seed().catch(fail)
else if (VERIFY) verify().catch(fail)
else {
  console.error("Usage: --seed | --verify")
  process.exit(1)
}
function fail(e: unknown) { console.error(e); process.exit(1) }

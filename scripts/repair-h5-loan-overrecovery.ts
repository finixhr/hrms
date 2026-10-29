// ============ H-5 data repair — loan-ledger over-recovery reconciliation ============
// Audit H-5: the payroll loan-recovery loop let EVERY active loan recover up to
// the full payslip deduction (no cross-loan budget), so historical PAID runs can
// have credited Loan/LoanInstallment ledgers with MORE than the employee's
// payslip actually deducted. The engine is fixed; this script reconciles the
// ALREADY-CORRUPTED history.
//
// MODES
//   (default)           DRY-RUN — report only, changes nothing
//   --apply             apply the computed repairs
//   --apply --allow-production   required (in addition to --apply) when
//                         DATABASE_URL does not contain "test"
//
// WHAT IT DOES (per over-recovered payroll entry, in engine order):
//   1. re-allocate the entry's loanDeduction across its linked installments
//      (loan.createdAt asc, installment no asc — the same order the FIXED
//      engine uses)
//   2. reduce each over-credited installment to its fair share
//   3. decrement the loan ledgers by the same delta, recompute outstanding,
//      reopen loans that wrongly CLOSED (status CLOSED → ACTIVE)
//   4. append an EmployeeHistory row documenting the adjustment
//
// SAFETY
//   - idempotent: re-running matches paidAmount to the allocation → zero deltas
//   - installments whose paidAt does not fall within the run's payment week are
//     NOT auto-repaired (mixed credits from multiple runs are ambiguous) —
//     they are reported as MANUAL-REVIEW instead
//   - no rows are deleted; every change is an update + a history row
//
// A HUMAN runs this against production after validating on staging:
//   bun run scripts/repair-h5-loan-overrecovery.ts                  # dry-run report
//   bun run scripts/repair-h5-loan-overrecovery.ts --apply          # staging
//   bun run scripts/repair-h5-loan-overrecovery.ts --apply --allow-production
import { PrismaClient } from "@prisma/client"

const db = new PrismaClient()
const APPLY = process.argv.includes("--apply")
const ALLOW_PROD = process.argv.includes("--allow-production")
const TOLERANCE = 0.01 // float money comparison

function gate() {
  const url = process.env.DATABASE_URL || ""
  const looksProd = !/test|staging/i.test(url)
  if (APPLY && looksProd && !ALLOW_PROD) {
    console.error("ERROR: --apply against a non-test/staging DATABASE_URL requires --allow-production.")
    console.error(`       DATABASE_URL=${url ? url.replace(/:[^:@/]+@/, ":***@") : "(unset)"}`)
    console.error("       Run the DRY-RUN first, review the report, and take a fresh backup.")
    process.exit(1)
  }
  if (!url) {
    console.error("ERROR: DATABASE_URL is not set.")
    process.exit(1)
  }
}

type Row = {
  entryId: string; employee: string; run: string; deduction: number
  credited: number; delta: number; installments: number; repaired: number; manualReview: number
}

async function main() {
  gate()
  console.log(`=== H-5 loan-ledger over-recovery repair — ${APPLY ? "APPLY" : "DRY-RUN"} ===`)
  console.log(`(engine fixed in payRun — this reconciles historical over-recovery only)\n`)

  // PAID entries with a loan deduction, joined to their PAID run
  const entries = await db.payrollEntry.findMany({
    where: { loanDeduction: { gt: 0 }, status: "INCLUDED", run: { status: "PAID" } },
    orderBy: { id: "asc" },
    include: { run: true },
  })

  const rows: Row[] = []
  let totalDelta = 0
  let repairedEntries = 0
  let manualReviewTotal = 0

  for (const e of entries) {
    // engine order: loan.createdAt asc, then installment no asc (no Prisma
    // relation between Loan and LoanInstallment — the join is manual)
    const rawInsts = await db.loanInstallment.findMany({ where: { payrollEntryId: e.id } })
    if (!rawInsts.length) continue
    const loansById = new Map(
      (await db.loan.findMany({ where: { id: { in: [...new Set(rawInsts.map((i) => i.loanId))] } } }))
        .map((l) => [l.id, l]),
    )
    const linked = [...rawInsts].sort((a, b) => {
      const la = loansById.get(a.loanId)?.createdAt?.getTime() ?? 0
      const lb = loansById.get(b.loanId)?.createdAt?.getTime() ?? 0
      return la !== lb ? la - lb : a.no - b.no
    })
    const credited = linked.reduce((s, i) => s + i.paidAmount, 0)
    const delta = credited - e.loanDeduction
    if (delta <= TOLERANCE) continue // not over-recovered

    const payDate = e.run.paymentDate ? e.run.paymentDate.slice(0, 10) : null
    const row: Row = {
      entryId: e.id, employee: e.employeeId,
      run: `${e.run.periodYear}-${String(e.run.periodMonth).padStart(2, "0")}${e.run.periodWeek ? ` w${e.run.periodWeek}` : ""}`,
      deduction: e.loanDeduction, credited, delta,
      installments: linked.length, repaired: 0, manualReview: 0,
    }

    // re-allocate the deduction budget in engine order
    let budget = e.loanDeduction
    const plan: { inst: (typeof linked)[number]; allocated: number; skip: boolean }[] = []
    for (const inst of linked) {
      const eligible = Math.max(0, Math.min(inst.amount, budget))
      budget -= eligible
      const mixedCredit =
        !payDate ||
        !inst.paidAt ||
        inst.paidAt.toISOString().slice(0, 10) < payDate ||
        inst.paidAt.getTime() - new Date(payDate).getTime() > 7 * 86_400_000
      plan.push({ inst, allocated: eligible, skip: mixedCredit && inst.paidAmount > eligible + TOLERANCE })
    }

    if (APPLY) {
      const loanDeltas = new Map<string, number>()
      for (const p of plan) {
        if (p.skip) { row.manualReview++; continue }
        const over = p.inst.paidAmount - p.allocated
        if (over <= TOLERANCE) continue // already fair (idempotent re-run)
        const newPaid = p.allocated
        await db.loanInstallment.update({
          where: { id: p.inst.id },
          data: {
            paidAmount: newPaid,
            status: newPaid >= p.inst.amount - TOLERANCE ? "PAID" : newPaid > TOLERANCE ? "PARTIAL" : (p.inst.dueDate < new Date().toISOString().slice(0, 10) ? "OVERDUE" : "PENDING"),
            ...(newPaid <= TOLERANCE ? { payrollEntryId: null, paidAt: null } : {}),
          },
        })
        loanDeltas.set(p.inst.loanId, (loanDeltas.get(p.inst.loanId) || 0) + over)
        row.repaired++
      }
      for (const [loanId, d] of loanDeltas) {
        const loan = await db.loan.findUnique({ where: { id: loanId } })
        if (!loan) continue
        const newPaid = Math.max(0, loan.paidAmount - d)
        const newOut = Math.max(0, loan.principal - newPaid)
        const reopened = loan.status === "CLOSED" && newOut > TOLERANCE
        await db.loan.update({
          where: { id: loanId },
          data: { paidAmount: newPaid, outstanding: newOut, status: newOut <= TOLERANCE ? "CLOSED" : "ACTIVE" },
        })
        await db.employeeHistory.create({
          data: {
            vendorId: loan.vendorId, employeeId: loan.employeeId,
            eventType: "LOAN_ADJUSTMENT",
            title: "Loan ledger corrected (H-5 over-recovery repair)",
            description: `Payroll entry ${e.id.slice(-8)} deducted ৳${e.loanDeduction.toFixed(2)} but the ledger credited ৳${credited.toFixed(2)}. Ledger reduced by ৳${d.toFixed(2)}; outstanding is now ৳${newOut.toFixed(2)}${reopened ? " (loan REOPENED — it was wrongly closed)" : ""}.`,
            dataJson: JSON.stringify({ repair: "H-5", entryId: e.id, loanId, delta: d, reopened }),
          },
        })
      }
      if (row.repaired > 0) repairedEntries++
    }
    manualReviewTotal += row.manualReview
    totalDelta += row.delta
    rows.push(row)
  }

  // ---- report ----
  if (!rows.length) {
    console.log("No over-recovered payroll entries found — ledgers are consistent.")
  } else {
    console.log(`${"employee".padEnd(12)} ${"run".padEnd(10)} ${"deduction".padStart(10)} ${"credited".padStart(10)} ${"over".padStart(9)} ${"insts".padStart(5)} ${APPLY ? "repaired".padStart(8) : "".padStart(8)} manual`)
    for (const r of rows) {
      console.log(
        `${r.employee.slice(0, 12).padEnd(12)} ${r.run.padEnd(10)} ${r.deduction.toFixed(2).padStart(10)} ${r.credited.toFixed(2).padStart(10)} ${r.delta.toFixed(2).padStart(9)} ${String(r.installments).padStart(5)} ${APPLY ? String(r.repaired).padStart(8) : ""}${r.manualReview ? `  ${r.manualReview} MANUAL-REVIEW` : ""}`,
      )
    }
    console.log(`\nOver-recovered entries: ${rows.length} | total excess credited: ৳${totalDelta.toFixed(2)}`)
    if (manualReviewTotal) console.log(`MANUAL-REVIEW installments (mixed credits — NOT auto-repaired): ${manualReviewTotal}`)
    if (APPLY) console.log(`Repaired entries: ${repairedEntries} (each writes an EmployeeHistory LOAN_ADJUSTMENT row)`)
    else console.log("\nDRY-RUN — nothing was changed. Re-run with --apply to repair (take a backup first).")
  }
}

main()
  .catch((e) => { console.error("FAILED:", e); process.exitCode = 1 })
  .finally(() => db.$disconnect())

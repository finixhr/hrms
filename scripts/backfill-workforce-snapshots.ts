// Phase 3 (FIN-077 structural fix) — one-time twelve-month backfill of the
// WorkforceSnapshot series, CLI twin of analytics.snapshots.backfill.
//
//   bun run scripts/backfill-workforce-snapshots.ts [vendorId] [months]
//
// Reconstructs each closed month before the current one from joining dates +
// recorded exit dates (earliest non-cancelled Resignation LWD ∪ EmployeeHistory
// EXIT events). HONEST CAVEAT: employees deleted before the backfill are
// invisible to the reconstruction — the earliest months carry the same caveats
// until live snapshots accumulate (the daily platform pass freezes each month
// as it closes). Idempotent: re-running rewrites identical values.
import { PrismaClient } from "@prisma/client"

const db = new PrismaClient()

async function main() {
  const vendorIdArg = process.argv[2]
  const monthsArg = Number(process.argv[3] || 12)
  const vendors = vendorIdArg
    ? await db.vendor.findMany({ where: { id: vendorIdArg } })
    : await db.vendor.findMany({ select: { id: true, name: true } })
  if (!vendors.length) {
    console.log(vendorIdArg ? `No vendor with id "${vendorIdArg}".` : "No vendors found.")
    return
  }
  const { backfillWorkforceSnapshots, workforceSnapshotSeries } = await import("../src/hrm-server/workforce-snapshots")
  for (const v of vendors) {
    const out = await backfillWorkforceSnapshots(v.id, monthsArg)
    const series = await workforceSnapshotSeries(v.id, monthsArg + 1)
    console.log(`▸ ${v.name || v.id}: ${out.wrote} month(s) reconstructed (${out.from} → ${out.to})`)
    for (const s of series) {
      console.log(`    ${s.label}: ${s.headcountTotal} total · ${s.headcountActive} active · ${s.newJoiners} joiner(s) · ${s.exits} exit(s) · ${s.avgTenureMonths}mo avg tenure`)
    }
  }
  console.log("\nCaveat: months before the backfill are RECONSTRUCTED (joining dates + recorded exit dates) — employees deleted before the backfill are invisible to it. Live captures start accumulating today.")
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1 })
  .finally(() => db.$disconnect())

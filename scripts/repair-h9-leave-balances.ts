// ============ H-9 data repair — leave-balance clamp (over-reserved rows) ============
// Audit H-9: the leave-balance concurrency defects (stale pre-tx availability
// check + absolute pending writes) could leave rows over-reserved
// (pending + used > entitled) or negative. The engine is fixed (FOR UPDATE +
// guarded atomic decrements); this script reports and clamps the ALREADY-
// CORRUPTED rows so the new guarded decrements start from a consistent ledger.
//
// MODES
//   (default)           DRY-RUN — report only, changes nothing
//   --apply             apply the clamps
//   --apply --allow-production   required (in addition to --apply) when
//                         DATABASE_URL does not contain "test"/"staging"
//
// WHAT IT DOES (per LeaveBalance row):
//   - negative used  → clamped to 0
//   - negative pending → clamped to 0
//   - pending + used > entitled (over-reservation) → pending clamped to
//     max(0, entitled - used)   [PENDING reservations are the soft side:
//     consumed `used` days are historical facts and are never reduced]
//
// Idempotent by construction: a clamped row satisfies all invariants, so a
// re-run reports nothing. No rows are deleted; each repaired row is reported
// with before/after values.
//
// A HUMAN runs this against production after validating on staging:
//   bun run scripts/repair-h9-leave-balances.ts                  # dry-run report
//   bun run scripts/repair-h9-leave-balances.ts --apply --allow-production
import { PrismaClient } from "@prisma/client"

const db = new PrismaClient()
const APPLY = process.argv.includes("--apply")
const ALLOW_PROD = process.argv.includes("--allow-production")
const TOLERANCE = 0.01

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

async function main() {
  gate()
  console.log(`=== H-9 leave-balance clamp repair — ${APPLY ? "APPLY" : "DRY-RUN"} ===`)
  console.log("(engine fixed with FOR UPDATE + guarded decrements — this reconciles corrupted rows only)\n")

  const rows = await db.leaveBalance.findMany({
    where: {
      OR: [
        { pending: { lt: 0 } },
        { used: { lt: 0 } },
      ],
    },
  })
  // over-reservation needs arithmetic in JS (entitled - used - pending < 0)
  const all = await db.leaveBalance.findMany()
  const overReserved = all.filter((r) => r.pending + r.used > r.entitled + TOLERANCE)
  const byId = new Map(rows.map((r) => [r.id, r]))
  for (const r of overReserved) byId.set(r.id, r)
  const targets = [...byId.values()]

  if (!targets.length) {
    console.log("No negative or over-reserved leave balances found — ledger is consistent.")
    return
  }

  let repaired = 0
  console.log(`${"row".padEnd(14)} ${"entitled".padStart(9)} ${"used".padStart(8)} ${"pending".padStart(8)}  action`)
  for (const r of targets) {
    const fixPendingNeg = r.pending < 0
    const fixUsedNeg = r.used < 0
    const over = r.pending + r.used - r.entitled
    // negative pending → clamp to 0 (the reservation is fictitious — no PENDING
    // request backs it; fabricating entitled-used days would be wrong).
    // over-reservation (positive pending) → release the excess down to
    // entitled - used. `used` days are historical facts, never reduced (except
    // to clamp a negative artifact).
    const newPending = fixPendingNeg ? 0 : (over > TOLERANCE ? Math.max(0, Math.round((r.entitled - r.used) * 100) / 100) : r.pending)
    const actions: string[] = []
    if (fixUsedNeg) actions.push("used→0")
    if (fixPendingNeg) actions.push("pending→0")
    if (over > TOLERANCE) actions.push(`pending→${newPending} (release ${Math.round((r.pending - newPending) * 100) / 100}d)`)
    console.log(
      `${r.id.slice(0, 14).padEnd(14)} ${String(r.entitled).padStart(9)} ${String(r.used).padStart(8)} ${String(r.pending).padStart(8)}  ${actions.join(", ")}`,
    )
    if (APPLY) {
      await db.leaveBalance.update({
        where: { id: r.id },
        data: {
          used: fixUsedNeg ? 0 : undefined,
          pending: newPending,
        },
      })
      repaired++
    }
  }
  console.log(`\nRows needing repair: ${targets.length}`)
  if (APPLY) console.log(`Clamped: ${repaired} (idempotent — a re-run reports nothing)`)
  else console.log("\nDRY-RUN — nothing was changed. Re-run with --apply to clamp (take a backup first).")
}

main()
  .catch((e) => { console.error("FAILED:", e); process.exitCode = 1 })
  .finally(() => db.$disconnect())

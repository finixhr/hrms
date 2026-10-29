// resolve shift for a date (roster overrides default) — seed-safe import chain
import { db } from "@/lib/db"

export async function resolveShiftForSeed(vendorId: string, employeeId: string, defaultShiftId: string | null, date: string) {
  const assignment = await db.shiftAssignment.findFirst({
    where: { vendorId, employeeId, fromDate: { lte: date }, OR: [{ toDate: null }, { toDate: { gte: date } }] },
    orderBy: { fromDate: "desc" },
  })
  const shiftId = assignment?.shiftId || defaultShiftId
  if (!shiftId) return null
  return db.shift.findFirst({ where: { id: shiftId } })
}
